//! Owned Cloud Functions runtime for the fireside emulator suite.
//!
//! Fireside binds the Functions port, discovers endpoints through the
//! firebase-functions SDK's control API, runs one Node worker per codebase
//! (user codebases and Extension instances), routes HTTP and callable
//! requests, converts bridge deliveries into worker invocations, fans Auth
//! and Storage events out to their subscribers, delivers Eventarc channel
//! events, watches sources and reloads. The HTTP contract is the one recorded
//! from firebase-tools 15.22.0 in `conformance/fixtures/functions-runtime-v1`.
#![allow(clippy::too_many_lines)]

use std::collections::BTreeMap;
use std::fmt::{self, Display};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use fireside_functions_bridge::{FunctionsInventory, TriggerRegistry};
use serde::Serialize;
use serde_json::{Map, Value, json};
use tokio::sync::{RwLock, watch};

pub mod discovery;
pub mod dotenv;
pub mod log;
pub mod manifest;
pub mod registry;
mod server;
mod watcher;
pub mod worker;

pub use log::{LogEvent, LogSink};
pub use manifest::Definition;
pub use registry::BlockingConfig;

/// The embedded worker script.
pub const WORKER_SOURCE: &str = include_str!("../../../support/functions-worker.mjs");
/// Compatibility label reported in readiness receipts.
pub const ORACLE_COMPATIBILITY: &str = "firebase-tools-15.22.0";
const WORKER_READY_TIMEOUT: Duration = Duration::from_secs(30);

/// A runtime failure with a message suitable for the suite log.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeError(pub String);

impl Display for RuntimeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for RuntimeError {}

/// Addresses of the suite's other services, as handlers must see them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmulatorHosts {
    pub firestore: String,
    pub auth: String,
    pub storage: String,
    pub pubsub: String,
    pub hub: String,
    pub eventarc: String,
    pub tasks: String,
}

/// `--inspect-functions` settings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InspectConfig {
    /// A fixed port for the single Node codebase, or `None` to assign 9229+.
    pub port: Option<u16>,
}

/// A user codebase from `firebase.json` `functions`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodebaseConfig {
    pub id: String,
    pub source_dir: PathBuf,
    pub runtime: Option<String>,
    pub ignore: Vec<String>,
    pub config_dir: Option<PathBuf>,
}

/// An Extension instance prepared by the extensions loader: its functions
/// directory, resolved environment and predefined trigger definitions.
#[derive(Debug, Clone)]
pub struct ExtensionBackend {
    pub instance_id: String,
    pub functions_dir: PathBuf,
    /// Non-secret parameters and auto-parameters.
    pub env: BTreeMap<String, String>,
    /// Secret parameters as `{key, secret, projectId, version}` entries.
    pub secret_env: Vec<Value>,
    /// Secret values from `<instance>.secret.local`.
    pub secret_values: BTreeMap<String, String>,
    pub definitions: Vec<Definition>,
    pub extension_spec: Option<Value>,
    pub extension: Option<Value>,
    pub extension_version: Option<Value>,
    pub runtime: String,
}

/// Everything the runtime needs to start.
#[derive(Debug, Clone)]
pub struct RuntimeConfig {
    pub project_id: String,
    pub project_alias: Option<String>,
    pub host: String,
    pub functions_port: u16,
    pub project_dir: PathBuf,
    pub node: PathBuf,
    pub state_dir: PathBuf,
    pub default_bucket: String,
    pub hosts: EmulatorHosts,
    pub codebases: Vec<CodebaseConfig>,
    pub extensions: Vec<ExtensionBackend>,
    pub inspect: Option<InspectConfig>,
}

impl RuntimeConfig {
    /// Origin of the Functions port as handlers and the Auth front see it.
    #[must_use]
    pub fn origin(&self) -> String {
        format!("http://{}:{}", self.host, self.functions_port)
    }
}

/// Parses `firebase.json` `functions` (object or array) into codebases.
#[must_use]
pub fn codebases_from_config(config: &Value, project_dir: &Path) -> Vec<CodebaseConfig> {
    let entries: Vec<&Value> = match config.get("functions") {
        Some(Value::Array(entries)) => entries.iter().collect(),
        Some(entry @ Value::Object(_)) => vec![entry],
        _ => Vec::new(),
    };
    entries
        .into_iter()
        .enumerate()
        .map(|(index, entry)| {
            let source = entry
                .get("source")
                .and_then(Value::as_str)
                .unwrap_or("functions");
            CodebaseConfig {
                id: entry
                    .get("codebase")
                    .and_then(Value::as_str)
                    .map_or_else(|| format!("default-{index}"), str::to_owned),
                source_dir: project_dir.join(source),
                runtime: entry
                    .get("runtime")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                ignore: entry
                    .get("ignore")
                    .and_then(Value::as_array)
                    .map(|values| {
                        values
                            .iter()
                            .filter_map(Value::as_str)
                            .map(str::to_owned)
                            .collect()
                    })
                    .unwrap_or_default(),
                config_dir: entry
                    .get("configDir")
                    .and_then(Value::as_str)
                    .map(|dir| project_dir.join(dir)),
            }
        })
        .collect()
}

/// What discovery produced for one backend.
#[derive(Debug, Clone, Default)]
struct Loaded {
    definitions: Vec<Definition>,
    user_env: BTreeMap<String, String>,
    secrets: BTreeMap<String, String>,
    error: Option<String>,
}

/// A backend the runtime serves: a user codebase or an Extension instance.
struct Backend {
    id: String,
    directory: PathBuf,
    config_dir: PathBuf,
    ignore: Vec<String>,
    extension: Option<ExtensionBackend>,
    loaded: RwLock<Loaded>,
    slot: worker::WorkerSlot,
    inspect_port: Option<u16>,
}

impl Backend {
    fn label(&self) -> String {
        self.extension.as_ref().map_or_else(
            || "functions".to_owned(),
            |extension| format!("extensions[{}]", extension.instance_id),
        )
    }
}

struct RuntimeState {
    config: RuntimeConfig,
    backends: Vec<Arc<Backend>>,
    registry: RwLock<registry::Registry>,
    triggers: TriggerRegistry,
    log: LogSink,
    client: reqwest::Client,
    updates: watch::Sender<u64>,
    debug_mode: bool,
}

/// Readiness receipt printed by the suite (compatible with the previous
/// host's `FIRESIDE_FUNCTIONS_HOST_READY` line).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadyReceipt {
    pub runtime: &'static str,
    pub oracle_compatibility: &'static str,
    pub backend_count: usize,
    pub custom_function_count: usize,
    pub ignored_count: usize,
    pub inventory_count: usize,
    pub inventory_sha256: String,
    pub functions_port: u16,
}

/// The running runtime.
pub struct FunctionsRuntime {
    state: Arc<RuntimeState>,
    watchers: Vec<watcher::SourceWatcher>,
}

impl FunctionsRuntime {
    /// Discovers every backend, registers triggers, starts workers and the
    /// source watchers.
    pub async fn start(
        config: RuntimeConfig,
        triggers: TriggerRegistry,
        log: LogSink,
    ) -> Result<Self, RuntimeError> {
        let script = worker::materialize_script(&config.state_dir, WORKER_SOURCE)?;
        let debug_mode = config.inspect.is_some();
        let mut backends = Vec::new();
        let mut next_inspect_port = config
            .inspect
            .as_ref()
            .map(|inspect| inspect.port.unwrap_or(9229));
        let mut order: Vec<(usize, bool)> = Vec::new();
        // Extension backends first, then user codebases, as the official
        // emulator registers them.
        for extension in &config.extensions {
            let inspect_port = next_inspect_port.inspect(|&port| {
                next_inspect_port = Some(port + 1);
            });
            let spec = worker::WorkerSpec {
                codebase: extension.instance_id.clone(),
                node: config.node.clone(),
                script: script.clone(),
                source_dir: extension.functions_dir.clone(),
                environment: BTreeMap::new(),
                inspect: inspect_port.map(|port| (config.host.clone(), port)),
                label: format!("extensions[{}]", extension.instance_id),
            };
            backends.push(Arc::new(Backend {
                id: extension.instance_id.clone(),
                directory: extension.functions_dir.clone(),
                config_dir: extension.functions_dir.clone(),
                ignore: Vec::new(),
                extension: Some(extension.clone()),
                loaded: RwLock::new(Loaded::default()),
                slot: worker::WorkerSlot::new(spec, log.clone()),
                inspect_port,
            }));
            order.push((backends.len() - 1, true));
        }
        for codebase in &config.codebases {
            let inspect_port = next_inspect_port.inspect(|&port| {
                next_inspect_port = Some(port + 1);
            });
            let spec = worker::WorkerSpec {
                codebase: codebase.id.clone(),
                node: config.node.clone(),
                script: script.clone(),
                source_dir: codebase.source_dir.clone(),
                environment: BTreeMap::new(),
                inspect: inspect_port.map(|port| (config.host.clone(), port)),
                label: "functions".to_owned(),
            };
            backends.push(Arc::new(Backend {
                id: codebase.id.clone(),
                directory: codebase.source_dir.clone(),
                config_dir: codebase
                    .config_dir
                    .clone()
                    .unwrap_or_else(|| codebase.source_dir.clone()),
                ignore: codebase.ignore.clone(),
                extension: None,
                loaded: RwLock::new(Loaded::default()),
                slot: worker::WorkerSlot::new(spec, log.clone()),
                inspect_port,
            }));
            order.push((backends.len() - 1, false));
        }
        if backends.is_empty() {
            return Err(RuntimeError(
                "firebase.json contains no Functions or Extensions backends".to_owned(),
            ));
        }
        // Redirects are the handler's responses, never followed here.
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|error| RuntimeError(format!("failed to build the worker client: {error}")))?;
        let (updates, _) = watch::channel(0);
        let state = Arc::new(RuntimeState {
            registry: RwLock::new(registry::Registry::new(&config.project_id)),
            config,
            backends,
            triggers,
            log,
            client,
            updates,
            debug_mode,
        });
        for backend in &state.backends {
            if let Some(port) = backend.inspect_port {
                state.log.info(format!(
                    "Using debug port {port} for functions codebase {}.{}",
                    backend.id,
                    if port == 9229 {
                        ""
                    } else {
                        " You may need to add manually add this port to your inspector."
                    }
                ));
            }
            state.log.info(format!(
                "Watching \"{}\" for Cloud Functions...",
                backend.directory.display()
            ));
            state.load_backend(backend, true).await;
        }
        // Start every worker now so the first invocation does not pay the
        // module load; failures are logged and retried on demand.
        let warms: Vec<_> = state
            .backends
            .iter()
            .map(|backend| {
                let backend = Arc::clone(backend);
                let state = Arc::clone(&state);
                tokio::spawn(async move {
                    let loaded = backend.loaded.read().await;
                    if loaded.error.is_some() && loaded.definitions.is_empty() {
                        return;
                    }
                    drop(loaded);
                    if let Err(error) = backend.slot.warm(WORKER_READY_TIMEOUT).await {
                        state.log.record(LogEvent::new(
                            "ERROR",
                            &backend.label(),
                            format!(
                                "Failed to start functions in {}: {error}",
                                backend.directory.display()
                            ),
                        ));
                    }
                })
            })
            .collect();
        for warm in warms {
            let _ = warm.await;
        }
        let mut watchers = Vec::new();
        for backend in &state.backends {
            if backend.extension.is_some() {
                continue;
            }
            let state_for_reload = Arc::clone(&state);
            let backend_id = backend.id.clone();
            match watcher::SourceWatcher::start(&backend.directory, &backend.ignore, move || {
                let state = Arc::clone(&state_for_reload);
                let backend_id = backend_id.clone();
                tokio::spawn(async move {
                    state.reload_backend(&backend_id).await;
                });
            }) {
                Ok(watcher) => watchers.push(watcher),
                Err(error) => state.log.warn(format!(
                    "source watching disabled for {}: {error}",
                    backend.directory.display()
                )),
            }
        }
        Ok(Self { state, watchers })
    }

    /// The Functions port router.
    pub fn router(&self) -> axum::Router {
        server::router(Arc::clone(&self.state))
    }

    /// The Eventarc emulator router (registration and channel publishing).
    pub fn eventarc_router(&self) -> axum::Router {
        server::eventarc_router(Arc::clone(&self.state))
    }

    /// Notified with an increasing counter after every registration change.
    #[must_use]
    pub fn updates(&self) -> watch::Receiver<u64> {
        self.state.updates.subscribe()
    }

    /// The current `/backends` inventory as the bridge and Pub/Sub router consume it.
    pub async fn inventory(&self) -> Result<FunctionsInventory, RuntimeError> {
        self.state.inventory().await
    }

    /// The readiness receipt for the current inventory.
    pub async fn receipt(&self) -> Result<ReadyReceipt, RuntimeError> {
        self.state.receipt().await
    }

    /// Current blocking-function configuration for the Auth front.
    pub async fn blocking(&self) -> BlockingConfig {
        self.state.registry.read().await.blocking().clone()
    }

    /// A handle the Auth front can query for blocking functions at sign-in time.
    #[must_use]
    pub fn blocking_handle(&self) -> BlockingHandle {
        BlockingHandle {
            state: Arc::clone(&self.state),
        }
    }

    /// The hub's `disableBackgroundTriggers` / `enableBackgroundTriggers`.
    pub async fn set_background_enabled(&self, enabled: bool) {
        self.state.set_background_enabled(enabled).await;
    }

    /// Stops the watchers and every worker.
    pub async fn shutdown(self) {
        for watcher in self.watchers {
            watcher.stop();
        }
        for backend in &self.state.backends {
            backend.slot.stop().await;
        }
    }
}

/// Lets the Auth front read the blocking-function configuration lazily.
#[derive(Clone)]
pub struct BlockingHandle {
    state: Arc<RuntimeState>,
}

impl BlockingHandle {
    pub async fn config(&self) -> BlockingConfig {
        self.state.registry.read().await.blocking().clone()
    }
}

impl std::fmt::Debug for BlockingHandle {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("BlockingHandle")
    }
}

impl RuntimeState {
    fn functions_origin(&self) -> String {
        self.config.origin()
    }

    fn system_envs(&self) -> BTreeMap<String, String> {
        BTreeMap::from([
            ("GCLOUD_PROJECT".to_owned(), self.config.project_id.clone()),
            ("K_REVISION".to_owned(), "1".to_owned()),
            ("PORT".to_owned(), "80".to_owned()),
            (
                "GOOGLE_CLOUD_QUOTA_PROJECT".to_owned(),
                self.config.project_id.clone(),
            ),
        ])
    }

    fn emulator_envs(&self) -> BTreeMap<String, String> {
        let hosts = &self.config.hosts;
        let mut envs = BTreeMap::from([
            ("FUNCTIONS_EMULATOR".to_owned(), "true".to_owned()),
            ("TZ".to_owned(), "UTC".to_owned()),
            ("FIREBASE_DEBUG_MODE".to_owned(), "true".to_owned()),
            (
                "FIREBASE_DEBUG_FEATURES".to_owned(),
                "{\"skipTokenVerification\":true,\"enableCors\":true}".to_owned(),
            ),
            (
                "FIRESTORE_EMULATOR_HOST".to_owned(),
                hosts.firestore.clone(),
            ),
            (
                "FIREBASE_FIRESTORE_EMULATOR_ADDRESS".to_owned(),
                hosts.firestore.clone(),
            ),
            ("FIREBASE_AUTH_EMULATOR_HOST".to_owned(), hosts.auth.clone()),
            (
                "FIREBASE_STORAGE_EMULATOR_HOST".to_owned(),
                hosts.storage.clone(),
            ),
            (
                "STORAGE_EMULATOR_HOST".to_owned(),
                format!("http://{}", hosts.storage),
            ),
            ("PUBSUB_EMULATOR_HOST".to_owned(), hosts.pubsub.clone()),
            ("FIREBASE_EMULATOR_HUB".to_owned(), hosts.hub.clone()),
            (
                "CLOUD_EVENTARC_EMULATOR_HOST".to_owned(),
                format!("http://{}", hosts.eventarc),
            ),
            ("CLOUD_TASKS_EMULATOR_HOST".to_owned(), hosts.tasks.clone()),
        ]);
        if self.debug_mode {
            envs.insert("FUNCTION_DEBUG_MODE".to_owned(), "true".to_owned());
        }
        envs
    }

    /// `getFirebaseConfig`, with the official key order (handlers compare the
    /// string).
    fn firebase_config(&self) -> String {
        format!(
            "{{\"storageBucket\":{},\"databaseURL\":{},\"projectId\":{}}}",
            Value::String(self.config.default_bucket.clone()),
            Value::String(format!("https://{}.firebaseio.com", self.config.project_id)),
            Value::String(self.config.project_id.clone()),
        )
    }

    /// Environment for the discovery process (`spawnFunctionsProcess`).
    fn discovery_environment(&self, backend: &Backend) -> BTreeMap<String, String> {
        let mut env = self.system_envs();
        env.extend(self.emulator_envs());
        env.insert("FIREBASE_CONFIG".to_owned(), self.firebase_config());
        if let Some(extension) = &backend.extension {
            env.extend(extension.env.clone());
        }
        if let Ok(config) = std::fs::read_to_string(backend.directory.join(".runtimeconfig.json"))
            && let Ok(value) = serde_json::from_str::<Value>(&config)
            && value.as_object().is_some_and(|map| !map.is_empty())
        {
            env.insert("CLOUD_RUNTIME_CONFIG".to_owned(), value.to_string());
        }
        env
    }

    /// Environment for the worker (`getRuntimeEnvs` + secrets + inherited process env).
    fn worker_environment(&self, backend: &Backend, loaded: &Loaded) -> BTreeMap<String, String> {
        let mut env: BTreeMap<String, String> = std::env::vars()
            .filter(|(key, _)| key != "GOOGLE_APPLICATION_CREDENTIALS")
            .collect();
        env.insert("node".to_owned(), self.config.node.display().to_string());
        env.insert("METADATA_SERVER_DETECTION".to_owned(), "none".to_owned());
        env.extend(loaded.user_env.clone());
        env.extend(self.system_envs());
        env.extend(self.emulator_envs());
        env.insert("FIREBASE_CONFIG".to_owned(), self.firebase_config());
        if let Some(extension) = &backend.extension {
            env.extend(extension.env.clone());
            env.extend(extension.secret_values.clone());
        }
        env.extend(loaded.secrets.clone());
        env.insert("PORT".to_owned(), "0".to_owned());
        env.remove("FUNCTION_TARGET");
        env.remove("FUNCTION_SIGNATURE_TYPE");
        env.remove("K_SERVICE");
        env
    }

    /// Discovers one backend and registers its definitions.
    async fn load_backend(&self, backend: &Arc<Backend>, initial: bool) {
        let loaded = self.discover(backend).await;
        let definitions = loaded.definitions.clone();
        {
            let mut current = backend.loaded.write().await;
            if loaded.error.is_some() && !initial {
                // A failed reload keeps the previous registrations (the
                // official emulator logs and returns); only the error is new.
                current.error.clone_from(&loaded.error);
                return;
            }
            *current = loaded.clone();
        }
        if let Some(error) = &loaded.error {
            self.log.record(LogEvent::new(
                "ERROR",
                &backend.label(),
                format!("Failed to load function definition from source: FirebaseError: {error}"),
            ));
        }
        if !definitions.is_empty() {
            let names: Vec<&str> = definitions.iter().map(Definition::entry_point).collect();
            self.log.record(LogEvent::new(
                "INFO",
                &backend.label(),
                format!(
                    "Loaded functions definitions from source: {}.",
                    names.join(", ")
                ),
            ));
        }
        let origin = self.functions_origin();
        let extension_instance = backend
            .extension
            .as_ref()
            .map(|extension| extension.instance_id.clone());
        {
            let mut registry = self.registry.write().await;
            registry.remove_codebase(&backend.id, &self.config.project_id, &self.triggers);
            registry.register(
                &backend.id,
                extension_instance.as_deref(),
                &definitions,
                &self.config.project_id,
                &origin,
                &self.triggers,
                &self.log,
            );
        }
        let environment = self.worker_environment(backend, &loaded);
        backend
            .slot
            .replace(worker::WorkerSpec {
                codebase: backend.id.clone(),
                node: self.config.node.clone(),
                script: worker::materialize_script(&self.config.state_dir, WORKER_SOURCE)
                    .unwrap_or_else(|_| self.config.state_dir.join("functions-worker.mjs")),
                source_dir: backend.directory.clone(),
                environment,
                inspect: backend
                    .inspect_port
                    .map(|port| (self.config.host.clone(), port)),
                label: backend.label(),
            })
            .await;
    }

    async fn discover(&self, backend: &Backend) -> Loaded {
        if let Some(extension) = &backend.extension {
            return Loaded {
                definitions: extension
                    .definitions
                    .iter()
                    .flat_map(|definition| definition.by_region(&extension.secret_env))
                    .collect(),
                user_env: BTreeMap::new(),
                secrets: BTreeMap::new(),
                error: None,
            };
        }
        let (user_env, env_files) = match dotenv::load_user_envs(
            &backend.config_dir,
            &self.config.project_id,
            self.config.project_alias.as_deref(),
            true,
        ) {
            Ok(loaded) => loaded,
            Err(error) => {
                return Loaded {
                    error: Some(error.0),
                    ..Loaded::default()
                };
            }
        };
        if !env_files.is_empty() {
            self.log.info(format!(
                "Loaded environment variables from {}.",
                env_files.join(", ")
            ));
        }
        let secrets = match dotenv::load_local_secrets(&backend.directory.join(".secret.local")) {
            Ok(secrets) => secrets,
            Err(error) => {
                self.log
                    .record(LogEvent::new("ERROR", "functions", error.0));
                BTreeMap::new()
            }
        };
        let manifest = match discovery::static_manifest(&backend.directory) {
            Ok(Some(manifest)) => Ok(manifest),
            Ok(None) => {
                let Some(sdk_root) =
                    discovery::find_sdk_root(&backend.directory, &self.config.project_dir)
                else {
                    return Loaded {
                        user_env,
                        secrets,
                        error: Some(format!(
                            "Failed to find location of Firebase Functions SDK for {}. Install firebase-functions in the codebase.",
                            backend.directory.display()
                        )),
                        ..Loaded::default()
                    };
                };
                let environment = self.discovery_environment(backend);
                discovery::discover_from_sdk(
                    &self.config.node,
                    &sdk_root,
                    &backend.directory,
                    &environment,
                )
                .await
            }
            Err(error) => Err(error),
        };
        match manifest {
            Ok(manifest) => match manifest::definitions_from_manifest(
                &manifest,
                &self.config.project_id,
                &self.config.default_bucket,
                &backend.id,
                &user_env,
            ) {
                Ok(definitions) => Loaded {
                    definitions,
                    user_env,
                    secrets,
                    error: None,
                },
                Err(error) => Loaded {
                    user_env,
                    secrets,
                    error: Some(format!("Failed to parse build specification: {error}")),
                    ..Loaded::default()
                },
            },
            Err(error) => Loaded {
                user_env,
                secrets,
                error: Some(error.0),
                ..Loaded::default()
            },
        }
    }

    async fn reload_backend(&self, backend_id: &str) {
        let Some(backend) = self
            .backends
            .iter()
            .find(|backend| backend.id == backend_id)
        else {
            return;
        };
        self.log.record(LogEvent::new(
            "DEBUG",
            "functions",
            format!(
                "File change detected in {}, reloading triggers",
                backend.directory.display()
            ),
        ));
        self.load_backend(backend, false).await;
        self.updates.send_modify(|counter| *counter += 1);
    }

    async fn set_background_enabled(&self, enabled: bool) {
        if enabled {
            let pending = self.registry.write().await.begin_reload();
            let origin = self.functions_origin();
            let mut grouped: BTreeMap<String, (Option<String>, Vec<Definition>)> = BTreeMap::new();
            for (codebase, instance, definition) in pending {
                grouped
                    .entry(codebase)
                    .or_insert_with(|| (instance, Vec::new()))
                    .1
                    .push(definition);
            }
            let mut registry = self.registry.write().await;
            for (codebase, (instance, definitions)) in grouped {
                registry.register(
                    &codebase,
                    instance.as_deref(),
                    &definitions,
                    &self.config.project_id,
                    &origin,
                    &self.triggers,
                    &self.log,
                );
            }
            drop(registry);
            self.triggers.set_background_enabled(true);
        } else {
            self.registry.write().await.disable_background(&self.log);
            self.triggers.set_background_enabled(false);
        }
        self.updates.send_modify(|counter| *counter += 1);
    }

    /// `getBackendInfo`.
    async fn backends_json(&self) -> Value {
        let registry = self.registry.read().await;
        let mut backends = Vec::new();
        for backend in &self.backends {
            let loaded = backend.loaded.read().await;
            let mut entry = Map::new();
            entry.insert(
                "directory".to_owned(),
                Value::String(backend.directory.display().to_string()),
            );
            if let Some(extension) = &backend.extension {
                let mut env: Map<String, Value> = extension
                    .env
                    .iter()
                    .map(|(key, value)| (key.clone(), Value::String(value.clone())))
                    .collect();
                for secret in &extension.secret_env {
                    if let (Some(key), Some(project), Some(name)) = (
                        secret.get("key").and_then(Value::as_str),
                        secret.get("projectId").and_then(Value::as_str),
                        secret.get("secret").and_then(Value::as_str),
                    ) {
                        let version = secret
                            .get("version")
                            .and_then(Value::as_str)
                            .unwrap_or("latest");
                        env.insert(
                            key.to_owned(),
                            Value::String(format!(
                                "projects/{project}/secrets/{name}/versions/{version}"
                            )),
                        );
                    }
                }
                entry.insert("env".to_owned(), Value::Object(env));
                entry.insert(
                    "extensionInstanceId".to_owned(),
                    Value::String(extension.instance_id.clone()),
                );
                if let Some(value) = &extension.extension {
                    entry.insert("extension".to_owned(), value.clone());
                }
                if let Some(value) = &extension.extension_version {
                    entry.insert("extensionVersion".to_owned(), value.clone());
                }
                if let Some(value) = &extension.extension_spec {
                    entry.insert("extensionSpec".to_owned(), value.clone());
                }
                entry.insert(
                    "functionTriggers".to_owned(),
                    Value::Array(
                        extension
                            .definitions
                            .iter()
                            .map(|definition| Value::Object(definition.json().clone()))
                            .collect(),
                    ),
                );
            } else {
                entry.insert("env".to_owned(), Value::Object(Map::new()));
                let triggers: Vec<Value> = registry
                    .records()
                    .iter()
                    .filter(|record| {
                        record.extension_instance.is_none() && record.codebase == backend.id
                    })
                    .map(|record| Value::Object(record.definition.json().clone()))
                    .collect();
                entry.insert("functionTriggers".to_owned(), Value::Array(triggers));
            }
            let _ = &loaded;
            backends.push(Value::Object(entry));
        }
        json!({ "backends": backends })
    }

    async fn inventory(&self) -> Result<FunctionsInventory, RuntimeError> {
        let json = self.backends_json().await;
        let generation = self.registry.read().await.generation();
        FunctionsInventory::from_backends_json(&json, generation)
            .map_err(|error| RuntimeError(error.to_string()))
    }

    async fn receipt(&self) -> Result<ReadyReceipt, RuntimeError> {
        let registry = self.registry.read().await;
        let records = registry.records();
        let custom_function_count = records
            .iter()
            .filter(|record| record.extension_instance.is_none())
            .count();
        let ignored_count = records
            .iter()
            .filter(|record| record.ignored.is_some())
            .count();
        let mut rows: Vec<String> = records
            .iter()
            .map(|record| {
                let definition = &record.definition;
                let identity = [
                    definition.id(),
                    definition.name().to_owned(),
                    definition.region().to_owned(),
                    definition.platform().to_owned(),
                ];
                if identity.iter().any(String::is_empty) {
                    return Err(RuntimeError(
                        "Functions inventory contains an incomplete identity".to_owned(),
                    ));
                }
                serde_json::to_string(&identity).map_err(|error| RuntimeError(error.to_string()))
            })
            .collect::<Result<_, _>>()?;
        rows.sort();
        let bytes = serde_json::to_vec(&rows).map_err(|error| RuntimeError(error.to_string()))?;
        let inventory_sha256 = hex_digest(&bytes);
        Ok(ReadyReceipt {
            runtime: "fireside",
            oracle_compatibility: ORACLE_COMPATIBILITY,
            backend_count: self.backends.len(),
            custom_function_count,
            ignored_count,
            inventory_count: records.len(),
            inventory_sha256,
            functions_port: self.config.functions_port,
        })
    }
}

/// Lowercase hex SHA-256 of `bytes`.
fn hex_digest(bytes: &[u8]) -> String {
    use sha2::Digest as _;
    use std::fmt::Write as _;
    sha2::Sha256::digest(bytes)
        .iter()
        .fold(String::with_capacity(64), |mut text, byte| {
            let _ = write!(text, "{byte:02x}");
            text
        })
}
