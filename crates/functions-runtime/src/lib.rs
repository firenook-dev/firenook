//! Owned Cloud Functions runtime for the firenook emulator suite.
//!
//! Firenook binds the Functions port, discovers endpoints through the
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
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime};

use firenook_functions_bridge::{FunctionsInventory, TriggerRegistry};
use serde::Serialize;
use serde_json::{Map, Value, json};
use tokio::sync::{RwLock, watch};
use tokio_util::sync::CancellationToken;

pub mod console;
pub mod discovery;
pub mod dotenv;
pub mod env_files;
pub mod log;
pub mod manifest;
pub mod monitor;
pub mod node;
pub mod params;
pub mod registry;
mod server;
pub mod watcher;
pub mod worker;

pub use console::{ConsoleError, ConsoleHandle};
pub use log::{LogEvent, LogSink, LogStream};
pub use manifest::{DeclaredParam, Definition, NotLoaded};
pub use monitor::{LiveSink, Monitor, MonitorLimits};
pub use registry::{BlockingConfig, RunningServices};

/// What the suite's log sink receives from the runtime.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogDelivery {
    /// Every event as the monitor saw it: the true level, the `stream` a
    /// worker line would have gone to, console-only end lines. The sink
    /// prints through [`LogEvent::terminal_level`] and
    /// [`LogEvent::terminal_lines`].
    Attributed,
    /// The events the runtime handed the suite before attribution
    /// ([`LogEvent::compatible_events`]): a sink written for those keeps
    /// printing and recording exactly what it did.
    Compatible,
}

/// How the runtime runs beside the console.
#[derive(Debug, Clone)]
pub struct RuntimeOptions {
    /// The record the runtime feeds; the console reads the same one.
    pub monitor: Monitor,
    pub log_delivery: LogDelivery,
}

impl Default for RuntimeOptions {
    fn default() -> Self {
        Self {
            monitor: Monitor::new(MonitorLimits::default()),
            log_delivery: LogDelivery::Compatible,
        }
    }
}

/// The gcloud configuration directory every worker sees.
fn demo_gcloud_dir(state_dir: &Path) -> PathBuf {
    state_dir.join("gcloud")
}

/// The synthetic credential every worker holds.
fn demo_credentials_file(state_dir: &Path) -> PathBuf {
    demo_gcloud_dir(state_dir).join("application_default_credentials.json")
}

/// Writes the synthetic `application_default_credentials.json` (no real
/// client id, secret or refresh token) that keeps the Admin SDK off the
/// metadata server.
fn materialize_demo_credentials(state_dir: &Path) -> Result<(), RuntimeError> {
    let directory = demo_gcloud_dir(state_dir);
    let path = demo_credentials_file(state_dir);
    if path.is_file() {
        return Ok(());
    }
    std::fs::create_dir_all(&directory).map_err(|error| {
        RuntimeError(format!(
            "failed to create the worker gcloud directory: {error}"
        ))
    })?;
    std::fs::write(
        &path,
        "{\"type\":\"authorized_user\",\"client_id\":\"demo\",\"client_secret\":\"demo\",\"refresh_token\":\"demo\"}\n",
    )
    .map_err(|error| {
        RuntimeError(format!(
            "failed to write the synthetic credential {}: {error}",
            path.display()
        ))
    })
}

/// The embedded worker script.
pub const WORKER_SOURCE: &str = include_str!("../../../support/functions-worker.mjs");
/// The CLI's `emulators:exec` preload, which the worker loads from beside
/// itself: it answers the synthetic credential's refresh at both of Google's
/// token endpoints in the worker's process. One source for the npm package
/// and the engine.
pub const TOKEN_ANSWERER_SOURCE: &str = include_str!("../../../packages/cli/src/exec-token.cjs");
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
    /// The `.firebaserc` alias the project was selected by (`--project
    /// staging`), whose `.env.<alias>` file a codebase reads.
    pub project_alias: Option<String>,
    /// The services running beside the runtime: a trigger on another is
    /// ignored, with a warning that names it.
    pub services: RunningServices,
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
    /// The dotenv files read, in precedence order.
    env_files: Vec<String>,
    /// Key → the dotenv file that set it.
    env_sources: BTreeMap<String, String>,
    /// File → hash of its bytes at load (`.secret.local` included), to tell
    /// a later change from a touch.
    env_hashes: BTreeMap<String, [u8; 32]>,
    /// The manifest's declared params.
    params: Vec<DeclaredParam>,
    /// The params no env file sets that took their default.
    param_defaults: BTreeMap<String, String>,
    /// What the worker's environment holds for params beyond the env files
    /// ([`params::ResolvedParams::environment`]).
    param_env: BTreeMap<String, String>,
    /// Per function id, the options it declares that the emulator does not
    /// apply.
    declared: BTreeMap<String, Map<String, Value>>,
    /// Endpoints the manifest declares that the emulator dropped.
    dropped_endpoints: Vec<NotLoaded>,
}

/// A backend the runtime serves: a user codebase or an Extension instance.
struct Backend {
    id: String,
    /// The instance id of an Extension backend (fixed for its label).
    instance: Option<String>,
    /// What an Extension reconfigure or vendor swaps: its backend and the
    /// directories (vendoring moves them). Held for a clone, never across
    /// an await.
    source: std::sync::RwLock<BackendSource>,
    ignore: Vec<String>,
    loaded: RwLock<Loaded>,
    slot: worker::WorkerSlot,
    inspect_port: Option<u16>,
    /// A stale-sources re-check is waiting.
    recheck_pending: Arc<AtomicBool>,
    /// One console change (env edit, extension swap) at a time.
    edit: tokio::sync::Mutex<()>,
    /// The env files the console just wrote, by name, with the hash they
    /// now hold (`None`: removed), so the env watcher ignores them.
    self_writes: std::sync::Mutex<BTreeMap<String, Option<[u8; 32]>>>,
    /// Requests on their way to the worker at once ([`WORKER_IN_FLIGHT`]).
    in_flight: Arc<tokio::sync::Semaphore>,
    /// The Node warning the last load logged, so a reload that changes
    /// nothing does not repeat it ([`RuntimeState::check_node`]).
    node_warning: std::sync::Mutex<Option<String>>,
}

/// The most requests the runtime sends one worker at the same time; more
/// wait their turn. A burst (a seeder uploading a thousand objects, each
/// firing a finalize trigger) otherwise opened a connection per event at
/// once, past what the worker's listen queue takes (macOS holds 128), and
/// the refused ones were recorded as crashed invocations. Kept well above
/// any real app's concurrency, so a function calling another on the same
/// worker never waits on itself.
pub(crate) const WORKER_IN_FLIGHT: usize = 100;

/// A backend's swappable part.
#[derive(Debug, Clone)]
struct BackendSource {
    extension: Option<ExtensionBackend>,
    directory: PathBuf,
    config_dir: PathBuf,
}

impl Backend {
    fn label(&self) -> String {
        self.instance.as_ref().map_or_else(
            || "functions".to_owned(),
            |instance| format!("extensions[{instance}]"),
        )
    }

    fn is_extension(&self) -> bool {
        self.instance.is_some()
    }

    fn read_source(&self) -> std::sync::RwLockReadGuard<'_, BackendSource> {
        self.source
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn directory(&self) -> PathBuf {
        self.read_source().directory.clone()
    }

    fn config_dir(&self) -> PathBuf {
        self.read_source().config_dir.clone()
    }

    fn extension(&self) -> Option<ExtensionBackend> {
        self.read_source().extension.clone()
    }

    fn replace_source(&self, source: BackendSource) {
        *self
            .source
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = source;
    }

    /// Remembers files the console wrote (by file name, with the hash they
    /// now hold), so the env watcher does not report them.
    fn note_self_writes(&self, files: impl IntoIterator<Item = (PathBuf, Option<[u8; 32]>)>) {
        let mut writes = self
            .self_writes
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        for (path, hash) in files {
            if let Some(name) = path.file_name() {
                writes.insert(name.to_string_lossy().into_owned(), hash);
            }
        }
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
    monitor: Monitor,
    /// Cancelled when the runtime shuts down; ends its background tasks.
    stopping: CancellationToken,
    /// The version of the Node the workers run on, asked once
    /// ([`RuntimeState::node_version`]).
    node_version: tokio::sync::OnceCell<Option<node::NodeVersion>>,
}

/// Readiness receipt printed by the suite (compatible with the previous
/// host's `FIRENOOK_FUNCTIONS_HOST_READY` line).
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
    /// source watchers, recording into a monitor of its own and handing the
    /// sink the events it always received.
    pub async fn start(
        config: RuntimeConfig,
        triggers: TriggerRegistry,
        log: LogSink,
    ) -> Result<Self, RuntimeError> {
        Self::start_with(config, triggers, log, RuntimeOptions::default()).await
    }

    /// [`FunctionsRuntime::start`] feeding the given monitor, with the given
    /// log delivery.
    pub async fn start_with(
        config: RuntimeConfig,
        triggers: TriggerRegistry,
        log: LogSink,
        options: RuntimeOptions,
    ) -> Result<Self, RuntimeError> {
        let monitor = options.monitor;
        let log = {
            let monitor = monitor.clone();
            let suite = log;
            let delivery = options.log_delivery;
            // Every event reaches the monitor first (which names the
            // function a worker line came from), then the suite's sink.
            LogSink::new(move |mut event: LogEvent| {
                let function = monitor.log(&event);
                if event.function.is_none() {
                    event.function = function;
                }
                match delivery {
                    LogDelivery::Attributed => suite.record(event),
                    LogDelivery::Compatible => {
                        for compatible in event.compatible_events() {
                            suite.record(compatible);
                        }
                    }
                }
            })
        };
        let script = worker::materialize_script(&config.state_dir, WORKER_SOURCE)?;
        materialize_demo_credentials(&config.state_dir)?;
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
                instance: Some(extension.instance_id.clone()),
                source: std::sync::RwLock::new(BackendSource {
                    extension: Some(extension.clone()),
                    directory: extension.functions_dir.clone(),
                    config_dir: extension.functions_dir.clone(),
                }),
                ignore: Vec::new(),
                loaded: RwLock::new(Loaded::default()),
                slot: worker::WorkerSlot::new(
                    spec,
                    log.clone(),
                    monitor.clone(),
                    extension.instance_id.clone(),
                ),
                inspect_port,
                recheck_pending: Arc::new(AtomicBool::new(false)),
                edit: tokio::sync::Mutex::new(()),
                self_writes: std::sync::Mutex::new(BTreeMap::new()),
                in_flight: Arc::new(tokio::sync::Semaphore::new(WORKER_IN_FLIGHT)),
                node_warning: std::sync::Mutex::new(None),
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
                instance: None,
                source: std::sync::RwLock::new(BackendSource {
                    extension: None,
                    directory: codebase.source_dir.clone(),
                    config_dir: codebase
                        .config_dir
                        .clone()
                        .unwrap_or_else(|| codebase.source_dir.clone()),
                }),
                ignore: codebase.ignore.clone(),
                loaded: RwLock::new(Loaded::default()),
                slot: worker::WorkerSlot::new(
                    spec,
                    log.clone(),
                    monitor.clone(),
                    codebase.id.clone(),
                ),
                inspect_port,
                recheck_pending: Arc::new(AtomicBool::new(false)),
                edit: tokio::sync::Mutex::new(()),
                self_writes: std::sync::Mutex::new(BTreeMap::new()),
                in_flight: Arc::new(tokio::sync::Semaphore::new(WORKER_IN_FLIGHT)),
                node_warning: std::sync::Mutex::new(None),
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
            registry: RwLock::new(registry::Registry::with_services(
                &config.project_id,
                config.services,
            )),
            config,
            backends,
            triggers,
            log,
            client,
            updates,
            debug_mode,
            monitor,
            stopping: CancellationToken::new(),
            node_version: tokio::sync::OnceCell::new(),
        });
        // The Node's version is asked while the codebases load, so the
        // check after each load does not wait for it.
        if state.backends.iter().any(|backend| !backend.is_extension()) {
            let state = Arc::clone(&state);
            tokio::spawn(async move {
                state.node_version().await;
            });
        }
        for backend in &state.backends {
            state
                .monitor
                .codebase_registered(monitor::CodebaseRegistration {
                    id: backend.id.clone(),
                    kind: if backend.is_extension() {
                        monitor::FunctionCodebaseKind::Extension
                    } else {
                        monitor::FunctionCodebaseKind::User
                    },
                    directory: state.relative(&backend.directory()),
                    runtime: backend.extension().map_or_else(
                        || {
                            state
                                .config
                                .codebases
                                .iter()
                                .find(|codebase| codebase.id == backend.id)
                                .and_then(|codebase| codebase.runtime.clone())
                        },
                        |extension| Some(extension.runtime),
                    ),
                    inspect_port: backend.inspect_port,
                });
        }
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
                backend.directory().display()
            ));
            let _ = state.load_backend(backend, true).await;
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
                        state.log.record(
                            LogEvent::new(
                                "ERROR",
                                &backend.label(),
                                format!(
                                    "Failed to start functions in {}: {error}",
                                    backend.directory().display()
                                ),
                            )
                            .with_codebase(backend.id.clone())
                            .with_kind("worker.failed"),
                        );
                    }
                })
            })
            .collect();
        for warm in warms {
            let _ = warm.await;
        }
        state.monitor.set_phase(monitor::FunctionsPhase::Running);
        let mut watchers = Vec::new();
        for backend in &state.backends {
            if backend.is_extension() {
                continue;
            }
            let directory = backend.directory();
            let state_for_reload = Arc::clone(&state);
            let backend_id = backend.id.clone();
            match watcher::SourceWatcher::start(
                &directory,
                watcher::WatchMode::Recursive,
                watcher::source_filter(&directory, &backend.ignore),
                move |_| {
                    let state = Arc::clone(&state_for_reload);
                    let backend_id = backend_id.clone();
                    tokio::spawn(async move {
                        state.reload_backend(&backend_id).await;
                    });
                },
            ) {
                Ok(watcher) => watchers.push(watcher),
                Err(error) => state.log.warn(format!(
                    "source watching disabled for {}: {error}",
                    directory.display()
                )),
            }
            watchers.extend(state.watch_env_files(backend));
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

    /// The record this runtime feeds.
    #[must_use]
    pub fn monitor(&self) -> &Monitor {
        &self.state.monitor
    }

    /// Stops the watchers and every worker.
    pub async fn shutdown(self) {
        self.state.stopping.cancel();
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

    fn backend(&self, id: &str) -> Option<Arc<Backend>> {
        self.backends
            .iter()
            .find(|backend| backend.id == id)
            .cloned()
    }

    /// The dotenv files of a codebase's chain, and `.secret.local`.
    fn env_chain(&self) -> Vec<String> {
        let mut names = vec![
            ".env".to_owned(),
            format!(".env.{}", self.config.project_id),
            ".env.local".to_owned(),
            ".secret.local".to_owned(),
        ];
        if let Some(alias) = &self.config.project_alias {
            names.push(format!(".env.{alias}"));
        }
        names
    }

    /// Watches a user codebase's env files (its config directory, and its
    /// source directory for `.secret.local`): a real change flags the
    /// codebase `envChanged`; it never reloads (the official CLI does not).
    fn watch_env_files(self: &Arc<Self>, backend: &Arc<Backend>) -> Vec<watcher::SourceWatcher> {
        let config_dir = backend.config_dir();
        let directory = backend.directory();
        let mut places: Vec<(PathBuf, Vec<String>)> = Vec::new();
        let chain = self.env_chain();
        if config_dir == directory {
            places.push((config_dir, chain));
        } else {
            places.push((
                config_dir,
                chain
                    .iter()
                    .filter(|name| name.as_str() != ".secret.local")
                    .cloned()
                    .collect(),
            ));
            places.push((directory, vec![".secret.local".to_owned()]));
        }
        let mut watchers = Vec::new();
        for (place, names) in places {
            let state = Arc::clone(self);
            let owner = Arc::clone(backend);
            let started = watcher::SourceWatcher::start(
                &place,
                watcher::WatchMode::NonRecursive,
                move |path| {
                    path.file_name().is_some_and(|name| {
                        names.iter().any(|candidate| name == candidate.as_str())
                    })
                },
                move |paths| {
                    let state = Arc::clone(&state);
                    let backend = Arc::clone(&owner);
                    tokio::spawn(async move {
                        state.env_changed(&backend, paths).await;
                    });
                },
            );
            match started {
                Ok(watcher) => watchers.push(watcher),
                Err(error) => self.log.warn(format!(
                    "env file watching disabled for {}: {error}",
                    place.display()
                )),
            }
        }
        watchers
    }

    /// Flags a codebase whose env files changed since its last load (a touch
    /// with the same bytes, or the console's own write, is not a change).
    async fn env_changed(&self, backend: &Backend, paths: Vec<PathBuf>) {
        let loaded = backend.loaded.read().await;
        for path in paths {
            let Some(name) = path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
            else {
                continue;
            };
            let current = tokio::fs::read(&path)
                .await
                .ok()
                .map(|bytes| dotenv::content_hash(&bytes));
            if current == loaded.env_hashes.get(&name).copied() {
                continue;
            }
            let own = backend
                .self_writes
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .get(&name)
                .copied();
            if own == Some(current) {
                continue;
            }
            self.monitor.codebase_stale(
                &backend.id,
                Some(monitor::FunctionStale::EnvChanged {
                    file: name,
                    changed_at: monitor::format_timestamp(SystemTime::now()),
                }),
            );
        }
    }

    /// A path as the console shows it: relative to the project when inside it.
    fn relative(&self, path: &Path) -> String {
        path.strip_prefix(&self.config.project_dir).map_or_else(
            |_| path.display().to_string(),
            |relative| {
                let text = relative.display().to_string();
                if text.is_empty() {
                    ".".to_owned()
                } else {
                    text
                }
            },
        )
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

    /// Environment for the discovery process (`spawnFunctionsProcess`): the
    /// codebase's env file values under the emulator's own variables, as
    /// `discoverBuild(runtimeConfig, {...userEnvs, ...environment})` passes
    /// them. A param's default is not among them (it resolves after
    /// discovery), nor is a secret.
    fn discovery_environment(
        &self,
        backend: &Backend,
        user_env: &BTreeMap<String, String>,
    ) -> BTreeMap<String, String> {
        let mut env = user_env.clone();
        env.extend(self.system_envs());
        env.extend(self.emulator_envs());
        env.insert("FIREBASE_CONFIG".to_owned(), self.firebase_config());
        if let Some(extension) = &backend.read_source().extension {
            env.extend(extension.env.clone());
        }
        if let Ok(config) = std::fs::read_to_string(backend.directory().join(".runtimeconfig.json"))
            && let Ok(value) = serde_json::from_str::<Value>(&config)
            && value.as_object().is_some_and(|map| !map.is_empty())
        {
            env.insert("CLOUD_RUNTIME_CONFIG".to_owned(), value.to_string());
        }
        env
    }

    /// Environment for the worker (`getRuntimeEnvs` + secrets + inherited process env).
    fn worker_environment(&self, backend: &Backend, loaded: &Loaded) -> BTreeMap<String, String> {
        // Credentials the suite itself may hold (the Extensions registry
        // login) never reach user code, matching the official emulator's
        // isolation of the developer's ADC from the Functions process.
        let mut env: BTreeMap<String, String> = std::env::vars()
            .filter(|(key, _)| {
                !matches!(
                    key.as_str(),
                    "GOOGLE_APPLICATION_CREDENTIALS"
                        | "FIREBASE_TOKEN"
                        | "CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE"
                )
            })
            .collect();
        env.insert("node".to_owned(), self.config.node.display().to_string());
        env.insert("METADATA_SERVER_DETECTION".to_owned(), "none".to_owned());
        // The worker holds a synthetic authorized-user credential, as its
        // GOOGLE_APPLICATION_CREDENTIALS and in the gcloud configuration
        // directory it sees: the Admin SDK and the Google auth library then
        // hold a refresh-token credential, whose refresh the worker answers
        // in its process, instead of falling back to the Compute Engine
        // metadata server (169.254.169.254), which the task-queue client
        // probes for a service-account email and which hangs for a minute
        // off Google Cloud. The variable is what firebase-admin 12 and
        // earlier read first: they never read CLOUDSDK_CONFIG, and without
        // it they would find the developer's own gcloud login in
        // $HOME/.config/gcloud (%APPDATA%\gcloud on Windows). A codebase's
        // own .env may still set it.
        env.insert(
            "CLOUDSDK_CONFIG".to_owned(),
            demo_gcloud_dir(&self.config.state_dir)
                .display()
                .to_string(),
        );
        env.insert(
            "GOOGLE_APPLICATION_CREDENTIALS".to_owned(),
            demo_credentials_file(&self.config.state_dir)
                .display()
                .to_string(),
        );
        env.extend(loaded.user_env.clone());
        env.extend(loaded.param_env.clone());
        env.extend(self.system_envs());
        env.extend(self.emulator_envs());
        env.insert("FIREBASE_CONFIG".to_owned(), self.firebase_config());
        if let Some(extension) = &backend.read_source().extension {
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

    /// Discovers one backend and registers its definitions. Returns the load
    /// error when the load failed (a failed reload keeps the previous
    /// registrations).
    async fn load_backend(&self, backend: &Arc<Backend>, initial: bool) -> Result<(), String> {
        self.monitor.codebase_loading(&backend.id);
        let began = Instant::now();
        let loaded = self.discover(backend).await;
        if !backend.is_extension() {
            self.check_node(backend).await;
        }
        let definitions = loaded.definitions.clone();
        let previous = {
            let mut current = backend.loaded.write().await;
            if let Some(error) = &loaded.error
                && !initial
            {
                // A failed reload keeps the previous registrations (the
                // official emulator logs and returns); only the error is new.
                current.error.clone_from(&loaded.error);
                let function_count = count_u32(current.definitions.len());
                drop(current);
                self.monitor.codebase_loaded(
                    &backend.id,
                    monitor::LoadReport {
                        function_count,
                        error: Some(monitor::load_error(
                            error,
                            &self.config.project_dir,
                            SystemTime::now(),
                        )),
                        kept_previous: true,
                        elapsed: began.elapsed(),
                        ..monitor::LoadReport::default()
                    },
                );
                return Err(error.clone());
            }
            std::mem::replace(&mut *current, loaded.clone()).definitions
        };
        if let Some(error) = &loaded.error {
            self.log.record(
                LogEvent::new(
                    "ERROR",
                    &backend.label(),
                    format!(
                        "Failed to load function definition from source: FirebaseError: {error}"
                    ),
                )
                .with_codebase(backend.id.clone()),
            );
        }
        if !definitions.is_empty() {
            let names: Vec<&str> = definitions.iter().map(Definition::entry_point).collect();
            self.log.record(
                LogEvent::new(
                    "INFO",
                    &backend.label(),
                    format!(
                        "Loaded functions definitions from source: {}.",
                        names.join(", ")
                    ),
                )
                .with_codebase(backend.id.clone()),
            );
        }
        let origin = self.functions_origin();
        let extension_instance = backend.instance.clone();
        {
            let mut registry = self.registry.write().await;
            let keep: Vec<String> = definitions
                .iter()
                .map(|definition| registry.key_for(definition))
                .collect();
            registry.remove_codebase_except(
                &backend.id,
                &keep,
                &self.config.project_id,
                &self.triggers,
            );
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
                source_dir: backend.directory(),
                environment,
                inspect: backend
                    .inspect_port
                    .map(|port| (self.config.host.clone(), port)),
                label: backend.label(),
            })
            .await;
        self.monitor.codebase_loaded(
            &backend.id,
            monitor::LoadReport {
                function_count: count_u32(definitions.len()),
                env_files: loaded.env_files.clone(),
                not_loaded: loaded
                    .dropped_endpoints
                    .iter()
                    .map(|entry| monitor::FunctionNotLoaded {
                        id: entry.id.clone(),
                        event_type: entry.event_type.clone(),
                        reason: entry.reason.clone(),
                    })
                    .collect(),
                error: loaded.error.as_deref().map(|error| {
                    monitor::load_error(error, &self.config.project_dir, SystemTime::now())
                }),
                kept_previous: false,
                diff: registry_diff(&previous, &definitions),
                elapsed: began.elapsed(),
            },
        );
        if let Some(error) = loaded.error {
            return Err(error);
        }
        backend
            .self_writes
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clear();
        self.check_sources(backend);
        Ok(())
    }

    /// The TypeScript stale check: when the sources under `src/` are newer
    /// than the compiled entry after a load, one re-check 3 s later (so the
    /// `tsc --watch` that follows a save clears it first) flags the codebase.
    fn check_sources(&self, backend: &Backend) {
        let directory = backend.directory();
        if backend.is_extension() || !directory.join("tsconfig.json").is_file() {
            return;
        }
        if backend.recheck_pending.swap(true, Ordering::SeqCst) {
            return;
        }
        let monitor = self.monitor.clone();
        let codebase = backend.id.clone();
        let stopping = self.stopping.clone();
        let pending = Arc::clone(&backend.recheck_pending);
        tokio::spawn(async move {
            let check = || {
                let directory = directory.clone();
                tokio::task::spawn_blocking(move || sources_newer(&directory))
            };
            if check().await.ok().flatten().is_some() {
                let waited = tokio::select! {
                    () = tokio::time::sleep(STALE_RECHECK) => true,
                    () = stopping.cancelled() => false,
                };
                if waited && let Some(changed) = check().await.ok().flatten() {
                    monitor.codebase_stale(
                        &codebase,
                        Some(monitor::FunctionStale::SourcesNewer {
                            changed_at: monitor::format_timestamp(changed),
                        }),
                    );
                }
            }
            pending.store(false, Ordering::SeqCst);
        });
    }

    /// The version of the Node the workers run on (`node --version`, once).
    async fn node_version(&self) -> Option<node::NodeVersion> {
        *self
            .node_version
            .get_or_init(|| node::probe(&self.config.node))
            .await
    }

    /// Warns, as the official emulator does, when the functions of a user
    /// codebase run on a Node it does not ask for (firebase.json's
    /// `runtime`, else package.json's `engines.node`). Said on the load that
    /// finds the difference, and again only when the warning changes.
    async fn check_node(&self, backend: &Backend) {
        let directory = backend.directory();
        let runtime = self
            .config
            .codebases
            .iter()
            .find(|codebase| codebase.id == backend.id)
            .and_then(|codebase| codebase.runtime.as_deref());
        let warning = match node::NodeRequest::of(runtime, &directory) {
            Some(request) => self
                .node_version()
                .await
                .and_then(|version| request.mismatch(version, &self.relative(&directory))),
            None => None,
        };
        let mut said = backend
            .node_warning
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(text) = warning.as_ref().filter(|text| said.as_ref() != Some(*text)) {
            self.log.record(
                LogEvent::new("WARN", &backend.label(), text.clone())
                    .with_codebase(backend.id.clone()),
            );
        }
        *said = warning;
    }

    async fn discover(&self, backend: &Backend) -> Loaded {
        if let Some(extension) = backend.extension() {
            return Loaded {
                definitions: extension
                    .definitions
                    .iter()
                    .flat_map(|definition| definition.by_region(&extension.secret_env))
                    .collect(),
                ..Loaded::default()
            };
        }
        let directory = backend.directory();
        let env = match dotenv::load_user_envs_with_sources(
            &backend.config_dir(),
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
        if !env.files.is_empty() {
            self.log.record(
                LogEvent::new(
                    "INFO",
                    "functions",
                    format!(
                        "Loaded environment variables from {}.",
                        env.files.join(", ")
                    ),
                )
                .with_codebase(backend.id.clone()),
            );
        }
        let user_env = env.envs;
        let mut env_hashes = env.hashes;
        let secret_path = directory.join(".secret.local");
        if let Ok(bytes) = std::fs::read(&secret_path) {
            env_hashes.insert(".secret.local".to_owned(), dotenv::content_hash(&bytes));
        }
        let secrets = match dotenv::load_local_secrets(&secret_path) {
            Ok(secrets) => secrets,
            Err(error) => {
                self.log.record(
                    LogEvent::new("ERROR", "functions", error.0).with_codebase(backend.id.clone()),
                );
                BTreeMap::new()
            }
        };
        let base = Loaded {
            env_files: env.files,
            env_sources: env.sources,
            env_hashes,
            ..Loaded::default()
        };
        let manifest = match discovery::static_manifest(&directory) {
            Ok(Some(manifest)) => Ok(manifest),
            Ok(None) => {
                let Some(sdk_root) = discovery::find_sdk_root(&directory, &self.config.project_dir)
                else {
                    return Loaded {
                        user_env,
                        secrets,
                        error: Some(format!(
                            "Failed to find location of Firebase Functions SDK for {}. Install firebase-functions in the codebase.",
                            directory.display()
                        )),
                        ..base
                    };
                };
                let environment = self.discovery_environment(backend, &user_env);
                discovery::discover_from_sdk(&self.config.node, &sdk_root, &directory, &environment)
                    .await
            }
            Err(error) => Err(error),
        };
        let manifest = match manifest {
            Ok(manifest) => manifest,
            Err(error) => {
                return Loaded {
                    user_env,
                    secrets,
                    error: Some(error.0),
                    ..base
                };
            }
        };
        // The params resolve before the options that reference them, as
        // the official `resolveBackend` does; a param no one can answer
        // stops the load with the official question.
        let declared = manifest::declared_params(&manifest);
        let resolved = match params::resolve(
            &declared,
            &user_env,
            &manifest::builtin_params(&self.config.project_id, &self.config.default_bucket),
        ) {
            Ok(resolved) => resolved,
            Err(error) => {
                // The official question names the prompt Firenook never
                // shows; say where the answer goes instead.
                let error = if error.0.starts_with("Question ") {
                    format!(
                        "{error}. Firenook never prompts: set the value in .env, .env.{} or .env.local, or give the param a default.",
                        self.config.project_id
                    )
                } else {
                    error.0
                };
                return Loaded {
                    user_env,
                    secrets,
                    error: Some(error),
                    params: declared,
                    ..base
                };
            }
        };
        let defaulted: Vec<&str> = declared
            .iter()
            .filter(|param| resolved.defaults.contains_key(&param.name))
            .map(|param| param.name.as_str())
            .collect();
        if !defaulted.is_empty() {
            self.log.record(
                LogEvent::new(
                    "INFO",
                    "functions",
                    format!(
                        "Params no env file sets take their default: {}.",
                        defaulted.join(", ")
                    ),
                )
                .with_codebase(backend.id.clone()),
            );
        }
        match manifest::convert_manifest(
            &manifest,
            &self.config.project_id,
            &self.config.default_bucket,
            &backend.id,
            &resolved.values,
        ) {
            Ok(conversion) => Loaded {
                definitions: conversion.definitions,
                user_env,
                secrets,
                error: None,
                params: conversion.params,
                param_defaults: resolved.defaults,
                param_env: resolved.environment,
                declared: conversion.declared,
                dropped_endpoints: conversion.not_loaded,
                ..base
            },
            Err(error) => Loaded {
                user_env,
                secrets,
                error: Some(format!("Failed to parse build specification: {error}")),
                params: declared,
                ..base
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
                backend.directory().display()
            ),
        ));
        let _ = self.load_backend(backend, false).await;
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
                Value::String(backend.directory().display().to_string()),
            );
            if let Some(extension) = backend.extension() {
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
            runtime: "firenook",
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

/// How long the stale-sources check waits before it looks again.
const STALE_RECHECK: Duration = Duration::from_secs(3);
/// The most entries the stale-sources walk visits.
const STALE_WALK_LIMIT: usize = 5_000;

fn count_u32(count: usize) -> u32 {
    u32::try_from(count).unwrap_or(u32::MAX)
}

/// What a reload changed, by function id: added, removed, and changed by
/// definition JSON.
fn registry_diff(previous: &[Definition], current: &[Definition]) -> monitor::FunctionRegistryDiff {
    let before: BTreeMap<String, &Definition> = previous
        .iter()
        .map(|definition| (definition.id(), definition))
        .collect();
    let after: BTreeMap<String, &Definition> = current
        .iter()
        .map(|definition| (definition.id(), definition))
        .collect();
    monitor::FunctionRegistryDiff {
        added: after
            .keys()
            .filter(|id| !before.contains_key(*id))
            .cloned()
            .collect(),
        removed: before
            .keys()
            .filter(|id| !after.contains_key(*id))
            .cloned()
            .collect(),
        changed: after
            .iter()
            .filter(|(id, definition)| {
                before
                    .get(*id)
                    .is_some_and(|old| old.json() != definition.json())
            })
            .map(|(id, _)| id.clone())
            .collect(),
    }
}

/// When the newest file under `src/` is newer than the compiled entry
/// (`package.json` `main`, else `index.js`), its modification time. A
/// bounded walk that skips `node_modules` and dotfiles.
fn sources_newer(directory: &Path) -> Option<SystemTime> {
    let main = std::fs::read(directory.join("package.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|package| {
            package
                .get("main")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_else(|| "index.js".to_owned());
    let entry = std::fs::metadata(directory.join(main))
        .and_then(|metadata| metadata.modified())
        .ok()?;
    let mut newest: Option<SystemTime> = None;
    let mut pending = vec![directory.join("src")];
    let mut visited = 0;
    while let Some(next) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&next) else {
            continue;
        };
        for item in entries.flatten() {
            visited += 1;
            if visited > STALE_WALK_LIMIT {
                break;
            }
            let name = item.file_name();
            let name = name.to_string_lossy();
            if name.starts_with('.') || name == "node_modules" {
                continue;
            }
            let Ok(metadata) = item.metadata() else {
                continue;
            };
            if metadata.is_dir() {
                pending.push(item.path());
            } else if let Ok(modified) = metadata.modified() {
                newest = Some(newest.map_or(modified, |current| current.max(modified)));
            }
        }
        if visited > STALE_WALK_LIMIT {
            break;
        }
    }
    newest.filter(|newest| *newest > entry)
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
