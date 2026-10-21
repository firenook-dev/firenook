//! Lifecycle coordinator for the complete Firenook emulator suite.
//!
//! The coordinator owns every data and control listener, including the
//! Functions port: user and Extension JavaScript runs in Node workers
//! supervised by the owned Functions runtime.

#![forbid(unsafe_code)]

use std::collections::{BTreeMap, BTreeSet};
use std::fmt::{self, Display, Formatter};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::response::Redirect;
use axum::routing::get;
use axum::serve::{ListenerExt as _, TapIo};
use firenook_auth_front::AuthRuntime;
use firenook_console_front::{
    AllowedHosts, CONSOLE_PATH, ChangeFeed, ComputeParts, ConsoleFeatures, ConsoleServices,
    DatabaseCatalog, FirestoreConsole, ForeignProjects, JobRegistry, Late, QueryExplainer,
    RulesEditor, RulesEvaluator, SchemaIndex, Shutdown, console_router,
};
use firenook_core_store::{
    DatabaseName, DiskDurability, DiskOptions, DocumentKey, Precondition, Store, StoreOptions,
    Write, document_key_logical_bytes, fields_logical_bytes,
};
use firenook_export_format::{ExportReader, ExportedDocument, write_export};
use firenook_functions_bridge::{
    DeliveryHealth, DeliveryPolicy, DeliveryRuntime, FunctionsInventory, TriggerRegistry,
};
pub use firenook_functions_runtime::InspectConfig;
use firenook_functions_runtime::{
    CodebaseConfig, EmulatorHosts, FunctionsRuntime, LogEvent, LogSink,
    RuntimeConfig as FunctionsRuntimeConfig, codebases_from_config,
};
use firenook_grpc_front::FirestoreService;
use firenook_pubsub_front::{SchedulerRuntime, router_with_printer as pubsub_router};
use firenook_query_engine::{DatabaseEdition, IndexCatalog, QueryPolicy};
use firenook_rest_front::router_with_shared_service as rest_router;
use firenook_rules_engine::{DocumentAccess as _, DocumentAccessError, Resource};
use firenook_rules_runtime::request_history::RequestHistory;
use firenook_rules_runtime::{RulesRuntime, SnapshotAccess};
use firenook_storage_front::{
    BucketRules, FirestoreDocuments, NativeRulesConfig, RulesFile, RulesSource, StorageConfig,
    StorageDurability, StorageRuntime,
};
use firenook_suite_front::{
    BackgroundRequest, EngineRelease, ExportCommand, HubConfig, HubRuntime, LoggingRuntime,
    ServiceInfo, SuiteDirectory, requests_router, requests_router_with_log, ui_router,
};
use firenook_tasks_front::TasksRuntime;
use firenook_webchannel_front::{FirestoreBackend, router as webchannel_router};
use futures_util::StreamExt as _;
use serde::{Deserialize, Serialize};
use serde_json::json;
use time::OffsetDateTime;
use tokio::net::TcpListener;
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;
use tonic::transport::server::TcpIncoming;

const EXPORT_VERSION: &str = "15.22.0";
const IMPORT_BATCH_SIZE: usize = 500;
const IMPORT_BATCH_LOGICAL_BYTES: u64 = 8 * 1024 * 1024;

mod console_wiring;
mod control;
mod functions_readiness;
mod launch;
mod native_state;
mod project_scope;
mod rules_watch;
mod shutdown_io;
pub mod terminal;
pub use control::{listen_for_shutdown, wait_for_shutdown};
pub use launch::{LaunchContext, LaunchReason};
pub use native_state::{AdoptedSeed, CompactedState, adopt_seed, compact_state, inspect_state};

use console_wiring::{FunctionsConsoleOptions, HookContext};

#[cfg(test)]
mod close_tests;
#[cfg(test)]
mod console_rules_tests;
#[cfg(test)]
mod diagnostics_tests;
#[cfg(test)]
mod no_delay_tests;
#[cfg(test)]
mod transport_tests;

/// Fixed suite listener ports.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SuitePorts {
    pub firestore: u16,
    pub auth: u16,
    pub storage: u16,
    pub functions: u16,
    pub pubsub: u16,
    pub hub: u16,
    pub ui: u16,
    pub firestore_websocket: u16,
    pub logging: u16,
    pub eventarc: u16,
    pub tasks: u16,
}

/// Which data services the suite starts (`--only`); the hub always runs,
/// Eventarc and Tasks follow Functions, the Firestore requests WebSocket
/// follows Firestore, the UI and logging listeners follow `ui_enabled`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
// One switch per service, each mapped from one `--only` name.
#[allow(clippy::struct_excessive_bools)]
pub struct ServiceSelection {
    pub firestore: bool,
    pub auth: bool,
    pub storage: bool,
    pub functions: bool,
    pub pubsub: bool,
}

impl ServiceSelection {
    /// The services a Functions trigger can need, as the runtime reads them.
    #[must_use]
    pub const fn running(self) -> firenook_functions_runtime::RunningServices {
        firenook_functions_runtime::RunningServices {
            firestore: self.firestore,
            auth: self.auth,
            storage: self.storage,
            pubsub: self.pubsub,
        }
    }

    /// Every service.
    pub const ALL: Self = Self {
        firestore: true,
        auth: true,
        storage: true,
        functions: true,
        pubsub: true,
    };

    /// Parses the official `--only` names; `extensions` means Functions and
    /// the auxiliary names (`eventarc`, `tasks`, `hub`, `ui`, `logging`) are
    /// accepted and follow their parent.
    pub fn parse(only: &str) -> Result<Self, String> {
        let mut selection = Self {
            firestore: false,
            auth: false,
            storage: false,
            functions: false,
            pubsub: false,
        };
        for name in only
            .split(',')
            .map(str::trim)
            .filter(|name| !name.is_empty())
        {
            match name {
                "firestore" => selection.firestore = true,
                "auth" => selection.auth = true,
                "storage" => selection.storage = true,
                "functions" | "extensions" => selection.functions = true,
                "pubsub" => selection.pubsub = true,
                "eventarc" | "tasks" | "hub" | "ui" | "logging" => {}
                "database" | "hosting" | "dataconnect" | "apphosting" => {
                    return Err(format!(
                        "the {name} emulator is not implemented by firenook (see the roadmap)"
                    ));
                }
                other => {
                    return Err(format!(
                        "unknown emulator {other}; valid names are auth,functions,firestore,pubsub,storage,eventarc,tasks,extensions,ui,logging,hub"
                    ));
                }
            }
        }
        if selection.names().is_empty() {
            return Err("No emulators to start; --only names none of firestore,auth,storage,functions,pubsub".to_owned());
        }
        Ok(selection)
    }

    /// The selected service names in the official listing order.
    #[must_use]
    pub fn names(&self) -> Vec<&'static str> {
        let mut names = Vec::new();
        if self.auth {
            names.push("auth");
        }
        if self.functions {
            names.push("functions");
        }
        if self.firestore {
            names.push("firestore");
        }
        if self.pubsub {
            names.push("pubsub");
        }
        if self.storage {
            names.push("storage");
        }
        names
    }

    /// The official service names that are not selected (for the
    /// "will affect production" warning on real project ids).
    #[must_use]
    pub fn missing(&self) -> Vec<&'static str> {
        let mut names = Vec::new();
        if !self.auth {
            names.push("auth");
        }
        if !self.firestore {
            names.push("firestore");
        }
        if !self.pubsub {
            names.push("pubsub");
        }
        if !self.storage {
            names.push("storage");
        }
        names
    }
}

/// One Storage bucket and its source rules file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StorageBucketConfig {
    pub bucket: String,
    pub rules: PathBuf,
}

/// The Storage rules shape of `firebase.json`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StorageRulesConfig {
    /// `storage: { rules }`: one file governs every bucket.
    Single(PathBuf),
    /// `storage: [{ target, rules }]`: one file per targeted bucket.
    PerBucket(Vec<StorageBucketConfig>),
    /// No `storage` section: the official emulator's default open rules
    /// (`templates/emulators/default_storage.rules`) govern every bucket of a
    /// demo project.
    OpenDefault,
}

/// The official `templates/emulators/default_storage.rules`.
pub const DEFAULT_OPEN_STORAGE_RULES: &str = "rules_version = '2';\nservice firebase.storage {\n  match /b/{bucket}/o {\n    match /{allPaths=**} {\n      allow read, write;\n    }\n  }\n}\n";

/// The `(default)` Firestore database id.
pub const DEFAULT_FIRESTORE_DATABASE: &str = "(default)";

/// One Firestore database's `firebase.json` entry: `firestore: { rules,
/// indexes }` describes `(default)`; `firestore: [{ database, rules, indexes
/// }, …]` describes one database per entry (an entry without `database` is
/// `(default)`). Production Firestore deploys rules per database, and so does
/// the suite; the official emulator refuses more than one database.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FirestoreDatabaseConfig {
    pub database_id: String,
    pub rules: Option<PathBuf>,
    pub indexes: Option<PathBuf>,
}

impl FirestoreDatabaseConfig {
    /// The entry for `(default)`.
    #[must_use]
    pub fn default_database(rules: Option<PathBuf>, indexes: Option<PathBuf>) -> Self {
        Self {
            database_id: DEFAULT_FIRESTORE_DATABASE.to_owned(),
            rules,
            indexes,
        }
    }
}

/// Complete suite startup settings resolved by the CLI.
#[derive(Debug, Clone)]
// Independent launch switches, each mapped from one CLI flag.
#[allow(clippy::struct_excessive_bools)]
pub struct SuiteConfig {
    /// Listen address of every listener (`--host`); `0.0.0.0`/`::` are
    /// accepted and `connect_host` names the loopback address clients use.
    pub host: String,
    /// `--allowed-hosts`: host names the console answers for besides the
    /// loopback names and `host`, for a deployment reached by another name.
    /// Bound to a wildcard with none given, the console answers any host.
    pub allowed_hosts: Vec<String>,
    pub project_id: String,
    /// `--project-alias`: the `.firebaserc` alias the project was selected
    /// by, whose `.env.<alias>` file each Functions codebase reads.
    pub project_alias: Option<String>,
    /// `--only` selection; `ServiceSelection::ALL` by default.
    pub services: ServiceSelection,
    /// `emulators.ui.enabled` / `--no-ui`: without the UI the logging
    /// listener is not started either, as officially.
    pub ui_enabled: bool,
    /// `emulators.singleProjectMode` (default true): warn about requests that
    /// name another project.
    pub single_project_mode: bool,
    /// `--debug-log`: append every suite log record to this file.
    pub debug_log: Option<PathBuf>,
    pub project_dir: PathBuf,
    pub firebase_json: PathBuf,
    pub node: PathBuf,
    /// `--inspect-functions`: debug ports for the Node workers.
    pub inspect_functions: Option<InspectConfig>,
    /// `--offline`: never contact the Extensions registry; refs must be
    /// vendored in the project or present in the shared cache with their
    /// registry sidecar.
    pub offline: bool,
    pub state_dir: PathBuf,
    pub resume_state: bool,
    pub firestore_in_memory: bool,
    /// When Firestore commits and Storage writes reach stable storage.
    pub durability: DiskDurability,
    /// Bounded local Requests and coverage; may retain decoded document/auth values.
    pub diagnostics: bool,
    /// The `firestore` section of `firebase.json`, one entry per database.
    /// Empty when the section is absent: every database is then served
    /// without rules (open, with the startup warning).
    pub firestore_databases: Vec<FirestoreDatabaseConfig>,
    pub storage_rules: StorageRulesConfig,
    pub default_bucket: String,
    pub import: Option<PathBuf>,
    pub export_on_exit: Option<PathBuf>,
    pub ports: SuitePorts,
    pub minimum_functions: usize,
    /// `--launch-context`: what the npm CLI knew when it started the engine
    /// (why each service is not started, the `firebase.json` entries it
    /// skipped, the command as typed), so the console can say why a section
    /// is absent and how to turn it on. `None` for an engine run directly.
    pub launch: Option<LaunchContext>,
}

impl SuiteConfig {
    /// The address clients connect to: the listen host unless that is a
    /// wildcard (`0.0.0.0` → `127.0.0.1`, `::` → `::1`), as the official
    /// CLI's `connectableHostname`.
    #[must_use]
    pub fn connect_host(&self) -> String {
        connectable_hostname(&self.host)
    }

    /// `host:port` (bracketed for IPv6) on the connect host.
    #[must_use]
    pub fn endpoint(&self, port: u16) -> String {
        endpoint(&self.connect_host(), port)
    }

    /// `http://host:port` on the connect host.
    #[must_use]
    pub fn origin(&self, port: u16) -> String {
        format!("http://{}", self.endpoint(port))
    }

    /// Whether the project id is a demo project (`demo-*`).
    #[must_use]
    pub fn is_demo_project(&self) -> bool {
        self.project_id.starts_with("demo-")
    }
}

/// `connectableHostname`: the address a client can reach a wildcard bind on.
#[must_use]
pub fn connectable_hostname(host: &str) -> String {
    match host.trim_start_matches('[').trim_end_matches(']') {
        "0.0.0.0" => "127.0.0.1".to_owned(),
        "::" => "::1".to_owned(),
        other => other.to_owned(),
    }
}

/// `host:port`, bracketing IPv6 literals.
#[must_use]
pub fn endpoint(host: &str, port: u16) -> String {
    if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

/// Final runtime counters emitted after clean shutdown.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SuiteOutcome {
    /// Stopped while it was still starting: nothing was served, and the data
    /// was closed as it was opened.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub before_ready: bool,
    pub functions: usize,
    pub schedules: usize,
    pub task_queues: usize,
    pub firestore_documents: u64,
    pub auth_users: usize,
    pub storage_objects: usize,
    pub storage_bytes: u64,
    pub delivery: DeliveryOutcome,
}

/// Serializable Functions-delivery health.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryOutcome {
    pub admitted: u64,
    pub deduplicated: u64,
    pub delivered: u64,
    pub assumed_delivered_after_response_loss: u64,
    pub retries: u64,
    pub failed: u64,
    pub latency: DeliveryLatencyOutcome,
}

/// Bounded successful Functions-delivery latency summary.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryLatencyOutcome {
    pub samples: usize,
    pub p50_micros: u64,
    pub p95_micros: u64,
    pub p99_micros: u64,
}

impl From<DeliveryHealth> for DeliveryOutcome {
    fn from(value: DeliveryHealth) -> Self {
        let mut latencies = value
            .delivery_latencies_micros
            .iter()
            .copied()
            .collect::<Vec<_>>();
        latencies.sort_unstable();
        Self {
            admitted: value.admitted,
            deduplicated: value.deduplicated,
            delivered: value.delivered,
            assumed_delivered_after_response_loss: value.assumed_delivered_after_response_loss,
            retries: value.retries,
            failed: value.failed,
            latency: DeliveryLatencyOutcome {
                samples: latencies.len(),
                p50_micros: percentile(&latencies, 50),
                p95_micros: percentile(&latencies, 95),
                p99_micros: percentile(&latencies, 99),
            },
        }
    }
}

fn percentile(sorted: &[u64], percentile: usize) -> u64 {
    if sorted.is_empty() {
        return 0;
    }
    let rank = sorted
        .len()
        .saturating_mul(percentile)
        .div_ceil(100)
        .saturating_sub(1)
        .min(sorted.len().saturating_sub(1));
    sorted[rank]
}

/// Suite startup, runtime, or shutdown failure.
#[derive(Debug)]
pub struct SuiteRuntimeError(String);

impl Display for SuiteRuntimeError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for SuiteRuntimeError {}

struct PreparedSuite {
    store: Store,
    triggers: TriggerRegistry,
    delivery: DeliveryRuntime,
    auth: Option<Arc<AuthRuntime>>,
    storage: Option<Arc<StorageRuntime>>,
    firestore: Option<tonic::service::Routes>,
    /// The console's own Firestore surface, sharing the service above.
    console_firestore: Option<ConsoleFirestoreParts>,
    request_history: Option<RequestHistory>,
    logging: LoggingRuntime,
    hub: HubRuntime,
    directory: SuiteDirectory,
    ui: Option<Router>,
    export_receiver: mpsc::Receiver<ExportCommand>,
    background_receiver: mpsc::UnboundedReceiver<BackgroundRequest>,
    /// The hub's export and background channels, for the console's suite
    /// controls, which do exactly what the hub's routes do.
    export_sender: mpsc::Sender<ExportCommand>,
    background_sender: mpsc::UnboundedSender<BackgroundRequest>,
    /// Project ids requests named that are not the configured one, recorded
    /// by every front an app talks to.
    foreign: ForeignProjects,
}

/// The console's Firestore pieces before the Requests feed exists (it needs
/// the shutdown signal, which `run` creates).
struct ConsoleFirestoreParts {
    rest: Router,
    changes: ChangeFeed,
    schema: SchemaIndex,
    databases: DatabaseCatalog,
    explain: QueryExplainer,
    rules: RulesEditor,
    rules_evaluator: RulesEvaluator,
    /// The runtime every Firestore front evaluates against, which the rules
    /// file watcher installs into once `run` has the shutdown signal.
    rules_runtime: RulesRuntime,
}

/// What `prepare_firestore` builds when Firestore is selected.
struct FirestoreParts {
    routes: tonic::service::Routes,
    console: ConsoleFirestoreParts,
    request_history: Option<RequestHistory>,
}

struct ShutdownSuite {
    config: SuiteConfig,
    store: Store,
    /// The console's map of the collections, saved with the data on the way
    /// out.
    schema: Option<SchemaIndex>,
    delivery: DeliveryRuntime,
    auth: Option<Arc<AuthRuntime>>,
    storage: Option<Arc<StorageRuntime>>,
    hub: HubRuntime,
    exporter: JoinHandle<()>,
    functions: Option<FunctionsRuntime>,
    scheduler: Option<SchedulerRuntime>,
    tasks: Option<TasksRuntime>,
    /// What the console's `before_finish` hooks read.
    logging: LoggingRuntime,
    triggers: TriggerRegistry,
    foreign: ForeignProjects,
    compute: Option<ComputeParts>,
    jobs: JobRegistry,
    pubsub: Option<firenook_pubsub_front::PubsubRuntime>,
    servers: Vec<JoinHandle<()>>,
    shutdown: watch::Sender<bool>,
    function_count: usize,
    schedule_count: usize,
}

/// Checks the discovered inventory against the configured minimum and the
/// readiness receipt, then prints the receipt line the harnesses wait for.
async fn verify_functions_readiness(
    config: &SuiteConfig,
    functions: &FunctionsRuntime,
    logging: &LoggingRuntime,
) -> Result<(FunctionsInventory, usize), SuiteRuntimeError> {
    let inventory = functions
        .inventory()
        .await
        .map_err(|error| failure(format!("Functions inventory failed: {error}")))?;
    let receipt = functions
        .receipt()
        .await
        .map_err(|error| failure(format!("Functions readiness failed: {error}")))?;
    let function_count = inventory.functions().count();
    if function_count < config.minimum_functions {
        return Err(failure(format!(
            "Functions runtime discovered {function_count} {}; at least {} required",
            terminal::plural(function_count, "function", "functions"),
            config.minimum_functions
        )));
    }
    if receipt.inventory_sha256 != functions_readiness::fingerprint(&inventory).map_err(failure)? {
        return Err(failure(
            "Functions inventory does not match the readiness receipt",
        ));
    }
    let receipt_line =
        serde_json::to_string(&receipt).map_err(|error| failure(error.to_string()))?;
    if !terminal::enabled() {
        println!("FIRENOOK_FUNCTIONS_HOST_READY {receipt_line}");
    }
    logging.record(
        "INFO",
        Some("functions"),
        format!("FIRENOOK_FUNCTIONS_HOST_READY {receipt_line}"),
    );
    Ok((inventory, function_count))
}

/// Serves the Functions and Eventarc ports from the owned runtime's routers.
fn spawn_functions_servers(
    functions: &FunctionsRuntime,
    listeners: &mut ListenerSet,
    shutdown: &watch::Sender<bool>,
    server_failure: &mpsc::UnboundedSender<String>,
    servers: &mut Vec<JoinHandle<()>>,
) -> Result<(), SuiteRuntimeError> {
    for (name, router) in [
        ("functions", functions.router()),
        ("eventarc", functions.eventarc_router()),
    ] {
        servers.push(spawn_axum(
            name,
            listeners.take(name)?,
            router,
            shutdown.subscribe(),
            server_failure.clone(),
        ));
    }
    Ok(())
}

/// Runs the complete suite until SIGINT/SIGTERM or a child/listener failure.
// Each optional service adds a guarded block; splitting them would hide the
// startup order this function documents.
#[allow(clippy::too_many_lines)]
pub async fn run(config: SuiteConfig) -> Result<SuiteOutcome, SuiteRuntimeError> {
    // The selection before a project without any Functions turns them off,
    // so the console can say why its Functions section is absent.
    let functions_requested = config.services.functions;
    let config = without_absent_functions(config)?;
    validate_config(&config)?;
    // From here a stop is a request: the start-up work that can end early
    // does, and the data is closed as it was opened.
    control::listen_for_shutdown()?;
    // Keep the OS lock alive through every service's shutdown. It is released
    // automatically on process death, without deleting/replacing the lock inode.
    let (native_state, prepared) = match prepare_native_suite(&config).await {
        Ok(prepared) => prepared,
        Err(error) if stopped(&error) => return Ok(stopped_before_ready(None).await),
        Err(error) => return Err(error),
    };
    if control::stop_requested() {
        let outcome = stopped_before_ready(Some(prepared)).await;
        drop(native_state);
        return Ok(outcome);
    }
    let PreparedSuite {
        store,
        triggers,
        delivery,
        auth,
        storage,
        firestore,
        console_firestore,
        request_history,
        logging,
        hub,
        directory,
        ui,
        export_receiver,
        background_receiver,
        export_sender,
        background_sender,
        foreign,
    } = prepared;
    let (shutdown, _) = watch::channel(false);
    let hook_shutdown = Shutdown::new(shutdown.subscribe());
    let firestore_rules = console_firestore
        .as_ref()
        .map(|parts| parts.rules_runtime.clone());
    let schema = console_firestore.as_ref().map(|parts| parts.schema.clone());
    // What every console lifecycle hook can read; the later services are
    // filled in at each call.
    let hooks = HookContext {
        auth: auth.as_ref(),
        storage: storage.as_ref(),
        store: Some(&store),
        firestore_rules: firestore_rules.as_ref(),
        shutdown: Some(&hook_shutdown),
        exporter: Some(&export_sender),
        ..HookContext::new(&config, &logging, &foreign, &triggers)
    };
    console_wiring::prepared(&hooks);
    let mut listeners = bind_listeners(&config).await?;
    // Each configured rules file reloads on change, as the official CLI's
    // watcher does, until the suite stops; whichever services run.
    let rules_targets =
        rules_watch::rules_watch_targets(&config, console_firestore.as_ref(), storage.as_deref())?;
    if !rules_targets.is_empty() {
        rules_watch::spawn(rules_targets, &logging, shutdown.subscribe());
    }
    let (server_failure, mut failed_server) = mpsc::unbounded_channel();
    // One Requests feed serves both the Firestore websocket port and the
    // console; a second instance would run a second history maintainer.
    // Its loss reports reach the console's log too.
    let requests = firestore
        .is_some()
        .then(|| requests_router_with_log(request_history, shutdown.subscribe(), &logging));
    let allowed_hosts = AllowedHosts::new(&config.host, &config.allowed_hosts);
    if ui.is_some() && allowed_hosts.accepts_any() {
        let message = format!(
            "the console answers requests for any host name because every listener is bound to {}; pass --allowed-hosts with the names it is reached by to refuse the others",
            config.host
        );
        terminal::print(
            "WARN",
            "firenook",
            &message,
            &format!("firenook: {message}"),
        );
    }
    // The sections whose services start after the console: compute's parts
    // exist before Functions start, and each late runtime has one `Late`,
    // which the console shares between the sections that use it.
    let compute_parts = config
        .services
        .functions
        .then(|| console_wiring::compute::parts(&config));
    let tasks_late = config
        .services
        .functions
        .then(|| Late::pending("Cloud Tasks"));
    let pubsub_late = config.services.pubsub.then(|| Late::pending("Pub/Sub"));
    // The console's bulk work; the suite stops it first when it stops.
    let console_jobs = JobRegistry::new();
    let hooks = HookContext {
        compute: compute_parts.as_ref(),
        ..hooks
    };
    let ui = ui.map(|official| {
        official.nest(
            CONSOLE_PATH,
            console_router(ConsoleServices {
                directory,
                release: EngineRelease::from_environment(),
                shutdown: Shutdown::new(shutdown.subscribe()),
                features: ConsoleFeatures {
                    diagnostics: config.diagnostics,
                },
                firestore: console_firestore.map(|parts| FirestoreConsole {
                    rest: parts.rest,
                    changes: parts.changes,
                    schema: parts.schema,
                    databases: parts.databases,
                    explain: parts.explain,
                    rules: parts.rules,
                    rules_evaluator: parts.rules_evaluator,
                    requests: requests.clone(),
                }),
                auth: auth
                    .as_ref()
                    .map(|auth| console_wiring::auth::auth_console(auth, &config, &logging)),
                storage: storage.as_ref().map(|storage| {
                    console_wiring::storage::storage_console(
                        storage,
                        &config,
                        &logging,
                        compute_parts.as_ref(),
                    )
                }),
                compute: compute_parts.clone(),
                pubsub: pubsub_late.clone(),
                tasks: tasks_late.clone(),
                observe: console_wiring::observe::observe_console(&hooks),
                absent: console_wiring::absent_reasons(
                    &config,
                    config.launch.as_ref(),
                    functions_requested,
                ),
                unsupported: console_wiring::unsupported(config.launch.as_ref()),
                suite: console_wiring::suite::suite_controls(
                    &config,
                    &triggers,
                    Some(background_sender.clone()),
                    export_sender.clone(),
                    native_state.reusing(),
                ),
                foreign: foreign.clone(),
                allowed_hosts,
                jobs: console_jobs.clone(),
            }),
        )
    });
    let mut servers = spawn_static_servers(
        &config,
        &mut listeners,
        StaticApplications {
            firestore,
            requests,
            auth: auth.as_ref().map(|auth| auth.application()),
            storage: storage.as_ref().map(|storage| storage.application()),
            hub: hub.application(),
            ui,
            logging: logging.application_with_shutdown(shutdown.subscribe()),
        },
        &logging,
        &foreign,
        &shutdown,
        &server_failure,
    )?;

    let exporter = spawn_exporter(
        export_receiver,
        config.clone(),
        store.clone(),
        auth.clone(),
        storage.clone(),
    );
    let mut functions = None;
    let mut tasks: Option<TasksRuntime> = None;
    let mut function_count = 0;
    let mut inventory = FunctionsInventory {
        generation: 0,
        backends: Vec::new(),
    };
    if config.services.functions {
        let functions_step = terminal::Step::begin("functions", "loading");
        let mut console = FunctionsConsoleOptions::default();
        console_wiring::functions_options(&hooks, &mut console);
        let runtime = start_functions_runtime(&config, triggers.clone(), &logging, console).await?;
        spawn_functions_servers(
            &runtime,
            &mut listeners,
            &shutdown,
            &server_failure,
            &mut servers,
        )?;
        (inventory, function_count) =
            verify_functions_readiness(&config, &runtime, &logging).await?;
        functions_step.done(&terminal::functions_figures(&runtime, function_count), None);
        if let Some(auth) = &auth {
            auth.set_blocking_functions(Arc::new(BlockingBridge(runtime.blocking_handle())));
        }
        functions = Some(runtime);
        console_wiring::compute::ready(&HookContext {
            functions: functions.as_ref(),
            inventory: Some(&inventory),
            ..hooks
        });
        // The Cloud Tasks emulator registers a queue per onTaskDispatched
        // export, as the official Functions emulator does at startup.
        let tasks_logging = logging.clone();
        let tasks_runtime = TasksRuntime::new(
            &config.project_id,
            &inventory,
            &config.origin(config.ports.functions),
            Arc::new(move |level: &str, text: &str| {
                console_wiring::messaging::print_tasks_line(level, text);
                tasks_logging.record(level, Some("tasks"), text.to_owned());
            }),
        );
        servers.push(spawn_axum(
            "tasks",
            listeners.take("tasks")?,
            project_scope::apply(
                tasks_runtime.application(),
                &config,
                &logging,
                &foreign,
                "tasks",
            ),
            shutdown.subscribe(),
            server_failure.clone(),
        ));
        if let Some(late) = &tasks_late {
            console_wiring::messaging::tasks_ready(
                late,
                &tasks_runtime,
                compute_parts.as_ref(),
                &config,
                &logging,
            );
        }
        tasks = Some(tasks_runtime);
    }
    let mut pubsub = None;
    let mut scheduler = None;
    let mut schedule_count = 0;
    if config.services.pubsub {
        let pubsub_step = terminal::Step::begin("pubsub", "scheduling");
        let runtime = pubsub_router(
            &config.project_id,
            &inventory,
            delivery.queue(),
            triggers.clone(),
            Arc::new(console_wiring::messaging::print_schedule_line),
        );
        schedule_count = runtime.schedules().len();
        scheduler = Some(
            runtime
                .start_scheduler()
                .map_err(|error| failure(format!("scheduler failed to start: {error}")))?,
        );
        pubsub_step.done(
            &[terminal::counted(
                u64::try_from(schedule_count).unwrap_or(u64::MAX),
                "schedule",
                "schedules",
            )],
            None,
        );
        // gRPC (the client libraries with `PUBSUB_EMULATOR_HOST`) and HTTP/JSON
        // share the Pub/Sub port, as on the official emulator.
        servers.push(spawn_firestore(
            "pubsub",
            listeners.take("pubsub")?,
            project_scope::apply_routes(runtime.routes(), &config, &logging, &foreign, "pubsub"),
            shutdown.subscribe(),
            server_failure.clone(),
        ));
        if let Some(late) = &pubsub_late {
            console_wiring::messaging::pubsub_ready(
                late,
                &runtime,
                compute_parts.as_ref(),
                &config,
                &logging,
            );
        }
        pubsub = Some(runtime);
    }
    drop(server_failure);
    console_wiring::ready(&HookContext {
        functions: functions.as_ref(),
        inventory: Some(&inventory),
        pubsub: pubsub.as_ref(),
        tasks: tasks.as_ref(),
        ..hooks
    });

    // A stop asked for while Functions loaded ends the start here: the
    // select below sees it at once, and the shutdown is the usual one.
    if !control::stop_requested() {
        announce_ready(&config, &logging, function_count);
    }

    let failure_reason = tokio::select! {
        signal = wait_for_shutdown() => signal.err().map(|error| error.to_string()),
        failed = failed_server.recv() => {
            Some(failed.unwrap_or_else(|| "service monitor closed".to_owned()))
        }
        error = follow_functions_inventory(
            functions.as_ref(), background_receiver, hooks,
            pubsub.as_mut(), scheduler.as_mut(), tasks.as_ref(),
        ) => Some(error),
    };

    finish_suite(
        ShutdownSuite {
            config,
            store,
            schema,
            delivery,
            auth,
            storage,
            hub,
            exporter,
            functions,
            scheduler,
            tasks,
            logging,
            triggers,
            foreign,
            compute: compute_parts,
            jobs: console_jobs,
            pubsub,
            servers,
            shutdown,
            function_count,
            schedule_count,
        },
        failure_reason,
    )
    .await
}

fn announce_ready(config: &SuiteConfig, logging: &LoggingRuntime, function_count: usize) {
    logging.record(
        "INFO",
        Some("hub"),
        format!(
            "All emulators ready; {function_count} {} discovered",
            terminal::plural(function_count, "function", "functions")
        ),
    );
    if terminal::enabled() {
        let console = config
            .ui_enabled
            .then(|| format!("{}{CONSOLE_PATH}", config.origin(config.ports.ui)));
        terminal::ready(console.as_deref(), &listener_plan(config), function_count);
    } else {
        println!("All emulators ready");
    }
}

/// Follows Functions reloads (refreshing Pub/Sub schedules, Cloud Tasks
/// queues and the console's `inventory_refreshed` hooks) and the hub's
/// background-trigger switches, until something fails. `hooks` carries the
/// configuration and the log.
async fn follow_functions_inventory(
    functions: Option<&FunctionsRuntime>,
    mut background: mpsc::UnboundedReceiver<BackgroundRequest>,
    hooks: HookContext<'_>,
    mut pubsub: Option<&mut firenook_pubsub_front::PubsubRuntime>,
    mut scheduler: Option<&mut SchedulerRuntime>,
    tasks: Option<&TasksRuntime>,
) -> String {
    let config = hooks.config;
    let logging = hooks.logging;
    let project = config.project_id.as_str();
    let Some(functions) = functions else {
        // Without Functions the hub's background-trigger switches are
        // acknowledged (the registry flag already changed) and nothing else
        // ever changes.
        while let Some(request) = background.recv().await {
            let _ = request.done.send(());
        }
        return "hub control channel closed".to_owned();
    };
    let mut updates = functions.updates();
    loop {
        tokio::select! {
            changed = updates.changed() => {
                if changed.is_err() {
                    return "Functions inventory stream closed".to_owned();
                }
            }
            request = background.recv() => {
                if let Some(request) = request {
                    functions.set_background_enabled(request.enabled).await;
                    let _ = request.done.send(());
                }
                continue;
            }
        }
        let inventory = match functions.inventory().await {
            Ok(inventory) => inventory,
            Err(error) => {
                return format!("Functions reload inventory verification failed: {error}");
            }
        };
        if let (Some(pubsub), Some(scheduler)) = (pubsub.as_deref_mut(), scheduler.as_deref_mut())
            && let Err(error) = pubsub
                .refresh_inventory(project, &inventory, scheduler)
                .await
        {
            return format!("Functions reload schedule rejected: {error}");
        }
        if let Some(tasks) = tasks {
            tasks.refresh_inventory(&inventory, &config.origin(config.ports.functions));
        }
        console_wiring::inventory_refreshed(
            &HookContext {
                functions: Some(functions),
                inventory: Some(&inventory),
                pubsub: pubsub.as_deref(),
                tasks,
                ..hooks
            },
            &inventory,
        );
        let count = inventory.functions().count();
        logging.record(
            "INFO",
            Some("functions"),
            format!(
                "Functions routing refreshed; {count} registered {}",
                terminal::plural(count, "function", "functions")
            ),
        );
        // Announce completion on stdout so a supervisor or harness can wait
        // for native delivery readiness after a reload. The line is their
        // contract (DESIGN.md), so its words stay as they are for any count.
        if !terminal::enabled() {
            println!("firenook functions routing refreshed: {count} registered functions");
        }
    }
}

async fn prepare_native_suite(
    config: &SuiteConfig,
) -> Result<(native_state::NativeState, PreparedSuite), SuiteRuntimeError> {
    // Picking saved data up checks the seed it came from, file by file.
    let checking = config
        .resume_state
        .then(|| terminal::Step::begin("data", "checking"));
    let mut guard = match native_state::NativeState::acquire(config) {
        Ok(guard) => guard,
        Err(error) => {
            if let Some(step) = checking {
                step.failed(if error.to_string().contains("suite state is locked") {
                    "in use by another Firenook"
                } else {
                    "refused"
                });
            }
            return Err(error);
        }
    };
    let mut startup = config.clone();
    if guard.reusing() {
        startup.import = None;
        if !terminal::enabled() {
            if config.import.is_some() {
                eprintln!("firenook resuming validated native state (seed import skipped)");
            } else {
                eprintln!("firenook resuming validated native state (kept without a seed)");
            }
        }
    }
    terminal::emit(&terminal::opening(config, guard.reusing()));
    if let Some(step) = checking {
        step.done(&[], None);
    }
    let prepared = prepare_suite(&startup, guard.reusing()).await?;
    if config.resume_state {
        if let Some(auth) = &prepared.auth {
            auth.checkpoint_native_state()
                .map_err(|error| failure(format!("Auth state checkpoint failed: {error}")))?;
        }
        if let Some(storage) = &prepared.storage {
            storage
                .checkpoint_native_state()
                .map_err(|error| failure(format!("Storage state checkpoint failed: {error}")))?;
        }
        guard.complete()?;
    }
    Ok((guard, prepared))
}

/// The UI port's application: `/api/config`, and the console under
/// [`CONSOLE_PATH`], which shares the port so that its assets and API are
/// same-origin with the page that loads them; `run` mounts the console once
/// every service it shows exists. The console's canonical address has no
/// trailing slash, and the slashed form is not claimed by `nest`, so it is
/// sent there. Every other address is one the Google Emulator UI answered
/// at this port's root until 0.2.0-next.3, and leads to the console's page
/// for the same thing.
fn ui_application(directory: SuiteDirectory) -> Router {
    ui_router(directory)
        .route(
            concat!("/console", "/"),
            get(|uri: axum::http::Uri| async move { console_slash_redirect(&uri) }),
        )
        .fallback(legacy_ui_redirect)
}

/// A request for one of the Google Emulator UI's addresses: a page is sent
/// to the console's, anything else (a write, an asset's method) is not here.
async fn legacy_ui_redirect(
    method: axum::http::Method,
    uri: axum::http::Uri,
) -> axum::response::Response {
    use axum::response::IntoResponse as _;
    if method == axum::http::Method::GET || method == axum::http::Method::HEAD {
        Redirect::temporary(&legacy_location(&uri)).into_response()
    } else {
        axum::http::StatusCode::NOT_FOUND.into_response()
    }
}

/// Where an address of the Google Emulator UI now leads: the console's page
/// for the same thing, so a bookmark or a link a tool prints still lands.
/// A log query keeps its `?q=`, whose official keys the console reads.
fn legacy_location(uri: &axum::http::Uri) -> String {
    let mut segments = uri.path().split('/').filter(|segment| !segment.is_empty());
    let page = match segments.next() {
        Some("firestore") if segments.any(|segment| segment == "requests") => "/firestore/rules",
        Some("firestore") => "/firestore",
        Some("auth") => "/auth",
        Some("storage") => "/storage",
        Some("extensions") => "/extensions",
        Some("functions") => "/functions",
        Some("logs") => {
            return match uri.query() {
                Some(query) if !query.is_empty() => format!("{CONSOLE_PATH}/logs?{query}"),
                _ => format!("{CONSOLE_PATH}/logs"),
            };
        }
        _ => "",
    };
    format!("{CONSOLE_PATH}{page}")
}

/// `/console/` sent to the console's canonical address with its query kept:
/// the router writes the Overview's links that way (`/console/?connect=env`,
/// `/console/?dialog=snapshot`), so a reload or a pasted link opens the same
/// view instead of a bare page.
fn console_slash_redirect(uri: &axum::http::Uri) -> Redirect {
    match uri.query() {
        Some(query) if !query.is_empty() => Redirect::permanent(&format!("{CONSOLE_PATH}?{query}")),
        _ => Redirect::permanent(CONSOLE_PATH),
    }
}

/// The suite's services, before any listens. `reusing` says whether the
/// data is saved state being picked up.
async fn prepare_suite(
    config: &SuiteConfig,
    reusing: bool,
) -> Result<PreparedSuite, SuiteRuntimeError> {
    tokio::fs::create_dir_all(&config.state_dir)
        .await
        .map_err(|error| failure(format!("failed to create suite state: {error}")))?;
    let logging = prepare_logging(config)?;
    let verb = data_verb(config, reusing);
    let [firestore_step, auth_step, storage_step] = begin_data_steps(config, verb);
    let store = open_store(config, verb)?;
    let triggers = TriggerRegistry::default();
    let functions_endpoint = format!("{}/", config.origin(config.ports.functions));
    let delivery = DeliveryRuntime::start(
        triggers.clone(),
        &functions_endpoint,
        DeliveryPolicy::default(),
    )
    .map_err(|error| failure(format!("Functions delivery failed: {error}")))?;
    store.add_commit_observer(delivery.observer());

    let auth = if config.services.auth {
        Some(Arc::new(
            AuthRuntime::new(
                &config.project_id,
                delivery.queue(),
                triggers.clone(),
                Some(config.state_dir.join("auth-state.json")),
            )
            .map_err(|error| failure(format!("Auth failed to start: {error}")))?,
        ))
    } else {
        None
    };
    let storage = if config.services.storage {
        Some(Arc::new(
            start_storage(config, &delivery, &triggers, &store, &logging).await?,
        ))
    } else {
        None
    };
    let imported = import_suite(
        config,
        &store,
        auth.as_deref(),
        storage.as_deref(),
        firestore_step.as_ref(),
    )
    .await?;
    finish_data_steps(
        [firestore_step, auth_step, storage_step],
        &imported,
        &store,
        auth.as_deref(),
        storage.as_deref(),
    );

    let foreign = ForeignProjects::default();
    let (firestore_routes, console_firestore, request_history) =
        match prepare_firestore(config, &store, &triggers, &logging, &foreign)? {
            Some(parts) => (
                Some(parts.routes),
                Some(parts.console),
                parts.request_history,
            ),
            None => (None, None, None),
        };

    if let Some(auth) = &auth {
        forward_auth_log(auth, &logging);
    }
    let directory = suite_directory(config)?;
    let (export_sender, export_receiver) = mpsc::channel(4);
    let (background_sender, background_receiver) = mpsc::unbounded_channel();
    let hub = HubRuntime::start(HubConfig {
        directory: directory.clone(),
        locator_file: locator_path(config),
        pid: std::process::id(),
        exporter: export_sender.clone(),
        triggers: triggers.clone(),
        background: Some(background_sender.clone()),
    })
    .map_err(|error| failure(format!("Hub failed to start: {error}")))?;
    let ui = config.ui_enabled.then(|| ui_application(directory.clone()));
    Ok(PreparedSuite {
        store,
        triggers,
        delivery,
        auth,
        storage,
        firestore: firestore_routes,
        console_firestore,
        request_history,
        logging,
        hub,
        directory,
        ui,
        export_receiver,
        background_receiver,
        export_sender,
        background_sender,
        foreign,
    })
}

/// Auth's operational lines (OOB links, verification codes, server errors)
/// reach the console and the Emulator UI log like the official CLI's
/// `i  auth: ...` output.
fn forward_auth_log(auth: &AuthRuntime, logging: &LoggingRuntime) {
    let auth_logging = logging.clone();
    auth.set_log_sink(Arc::new(move |kind: &str, text: &str| {
        let level = match kind {
            "BULLET" | "SUCCESS" => "INFO",
            other => other,
        };
        terminal::print(level, "auth", text, &format!("firenook auth: {text}"));
        auth_logging.record(level, Some("auth"), text.to_owned());
    }));
}

/// The log runtime with the `--debug-log` sink and the startup lines.
fn prepare_logging(config: &SuiteConfig) -> Result<LoggingRuntime, SuiteRuntimeError> {
    let logging = LoggingRuntime::new();
    // The console keeps every line as a structured entry, from the startup
    // lines on; without the console (`--no-ui`) nothing is kept for it.
    if config.ui_enabled {
        firenook_console_front::ObserveConsole::install_log(&logging);
    }
    if let Some(path) = &config.debug_log {
        logging.set_file_sink(path).map_err(|error| {
            failure(format!(
                "cannot open the debug log {}: {error}",
                path.display()
            ))
        })?;
    }
    for message in startup_log_messages(config) {
        logging.emit(console_wiring::observe::configured_input(message));
    }
    for (level, message) in startup_banner(config) {
        terminal::print(level, "firenook", &message, &format!("firenook: {message}"));
        logging.emit(console_wiring::observe::banner_input(level, message));
    }
    Ok(logging)
}

/// The Firestore port's gRPC, REST and `WebChannel` routes, when selected,
/// with the console's own REST instance and change feed on the same service.
fn prepare_firestore(
    config: &SuiteConfig,
    store: &Store,
    triggers: &TriggerRegistry,
    logging: &LoggingRuntime,
    foreign: &ForeignProjects,
) -> Result<Option<FirestoreParts>, SuiteRuntimeError> {
    if !config.services.firestore {
        return Ok(None);
    }
    let query_policy = query_policy(config)?;
    let firestore_rules = firestore_rules(config)?;
    let request_history = firestore_rules.request_history();
    // The console's editor replaces a database's ruleset in the same
    // runtime every front evaluates against, so a change takes effect on
    // the next request rather than on the next start.
    let rules_for_console = firestore_rules.clone();
    let service = FirestoreService::new_with_query_policy_and_rules(
        store.clone(),
        query_policy.clone(),
        firestore_rules.clone(),
    );
    let firestore_http = rest_router(
        store.clone(),
        query_policy.clone(),
        None,
        firestore_rules.clone(),
        triggers.clone(),
        service.clone(),
    )
    .merge(webchannel_router(FirestoreBackend::new(service.clone())));
    // The official clear route is logged for the console.
    let firestore_http =
        console_wiring::observe::firestore_cleared_layer(firestore_http, logging, store);
    let schema = SchemaIndex::attach(store, &config.project_id);
    let console = ConsoleFirestoreParts {
        // Its evaluations, reads and writes, report the console as their
        // origin, so a "View as" denial is told apart from one an app caused.
        rest: {
            let console_rules =
                firestore_rules.with_origin(firenook_rules_runtime::DenialOrigin::Console);
            rest_router(
                store.clone(),
                query_policy,
                None,
                console_rules.clone(),
                triggers.clone(),
                service.with_rules(console_rules),
            )
        },
        changes: ChangeFeed::attach(store),
        schema: schema.clone(),
        databases: DatabaseCatalog::new(
            store,
            &config.project_id,
            config
                .firestore_databases
                .iter()
                .map(|database| database.database_id.clone()),
        ),
        explain: QueryExplainer::new(
            store,
            &config.project_id,
            DatabaseEdition::Standard,
            index_catalogs(config)?,
        ),
        rules: RulesEditor::new(
            &rules_for_console,
            &config.project_id,
            config
                .firestore_databases
                .iter()
                .filter_map(|database| {
                    database
                        .rules
                        .as_ref()
                        .map(|path| (database.database_id.clone(), path.clone()))
                })
                .collect(),
        )
        // A checked draft is mapped against the tree the console shows.
        .with_schema(&schema),
        // Dry runs and explanations read the same runtime and store, and
        // never record or commit anything.
        rules_evaluator: RulesEvaluator::new(&rules_for_console, store, &config.project_id),
        rules_runtime: rules_for_console,
    };
    // REST, WebChannel and gRPC each name the project their own way; one
    // scope covers the three.
    let routes = tonic::service::Routes::from(firestore_http).add_service(service.into_server());
    Ok(Some(FirestoreParts {
        routes: project_scope::apply_routes(routes, config, logging, foreign, "firestore"),
        console,
        request_history,
    }))
}

impl ShutdownSuite {
    /// What the console's `before_finish` hooks read.
    fn hooks(&self) -> HookContext<'_> {
        HookContext {
            compute: self.compute.as_ref(),
            jobs: Some(&self.jobs),
            auth: self.auth.as_ref(),
            storage: self.storage.as_ref(),
            functions: self.functions.as_ref(),
            pubsub: self.pubsub.as_ref(),
            tasks: self.tasks.as_ref(),
            ..HookContext::new(&self.config, &self.logging, &self.foreign, &self.triggers)
        }
    }
}

impl PreparedSuite {
    /// The data services and trigger delivery; every other part, with the
    /// handles to the data it holds, is dropped here.
    fn into_data(
        self,
    ) -> (
        Store,
        Option<Arc<AuthRuntime>>,
        Option<Arc<StorageRuntime>>,
        DeliveryRuntime,
    ) {
        (self.store, self.auth, self.storage, self.delivery)
    }
}

/// How long a stop waits for the data's other handles, held by work that
/// is ending its own stop, to be dropped.
const CLOSE_WAIT: Duration = Duration::from_secs(5);

/// Closes Firestore's store on the blocking pool; see [`Store::close`].
async fn close_store(store: Store) -> Result<(), String> {
    match tokio::task::spawn_blocking(move || store.close(CLOSE_WAIT)).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(error)) => Err(format!("Firestore did not close: {error}")),
        Err(error) => Err(format!("Firestore close task failed: {error}")),
    }
}

/// Stops Storage and closes its metadata; see [`StorageRuntime::close`].
async fn close_storage(storage: Arc<StorageRuntime>) -> Result<(), String> {
    match Arc::try_unwrap(storage) {
        Ok(storage) => storage
            .close()
            .await
            .map_err(|error| format!("Storage shutdown failed: {error}")),
        Err(_) => Err("Storage runtime still has active owners".to_owned()),
    }
}

/// Why a start-up step ended early when a stop was asked for.
const STOPPED: &str = "stopped while starting";

fn stopped_while_starting() -> SuiteRuntimeError {
    failure(STOPPED)
}

/// Whether `error` is a start-up step that ended early for a stop: the
/// store's open, the seed check or an import.
fn stopped(error: &SuiteRuntimeError) -> bool {
    control::stop_requested() && error.0.contains(STOPPED)
}

/// A stop asked for before the emulators were ready: what was opened is
/// closed cleanly, and nothing is exported, since nothing was served.
async fn stopped_before_ready(prepared: Option<PreparedSuite>) -> SuiteOutcome {
    terminal::stopping(None);
    let mut outcome = SuiteOutcome {
        before_ready: true,
        functions: 0,
        schedules: 0,
        task_queues: 0,
        firestore_documents: 0,
        auth_users: 0,
        storage_objects: 0,
        storage_bytes: 0,
        delivery: DeliveryOutcome::default(),
    };
    if let Some(prepared) = prepared {
        let (store, auth, storage, delivery) = prepared.into_data();
        outcome.firestore_documents = store.document_total();
        outcome.auth_users = auth.as_ref().map_or(0, |auth| auth.user_count());
        if let Some(storage) = &storage {
            outcome.storage_objects = storage.object_count();
            outcome.storage_bytes = storage.object_bytes();
        }
        outcome.delivery = delivery.shutdown().await.into();
        drop(auth);
        if let Some(storage) = storage
            && let Err(error) = close_storage(storage).await
        {
            terminal::print("ERROR", "firenook", &error, &format!("firenook: {error}"));
        }
        if let Err(error) = close_store(store).await {
            terminal::print("ERROR", "firenook", &error, &format!("firenook: {error}"));
        }
    }
    outcome
}

async fn finish_suite(
    mut suite: ShutdownSuite,
    failure_reason: Option<String>,
) -> Result<SuiteOutcome, SuiteRuntimeError> {
    terminal::stopping(suite.config.export_on_exit.as_deref());
    let mut failures: Vec<String> = failure_reason.iter().cloned().collect();
    if failure_reason.is_none()
        && let Some(destination) = &suite.config.export_on_exit
        && let Err(error) = export_suite(
            destination,
            &BTreeSet::new(),
            &suite.config,
            &suite.store,
            suite.auth.as_deref(),
            suite.storage.as_deref(),
        )
        .await
    {
        let recovery = if suite.config.firestore_in_memory {
            "in-memory Firestore state is not recoverable after exit"
        } else {
            "correct the export destination and reopen the retained disk state before retrying export"
        };
        failures.push(format!(
            "{error}; working files retained at {}; {recovery}",
            suite.config.state_dir.display()
        ));
    }
    if let Some(scheduler) = suite.scheduler.take() {
        scheduler.shutdown().await;
    }
    let task_queues = match &suite.tasks {
        Some(tasks) => {
            let count = tasks.queue_keys().len();
            tasks.shutdown().await;
            count
        }
        None => 0,
    };
    // Each console stream's last work, in the fixed order, while every
    // service it may need is still up.
    console_wiring::before_finish(&suite.hooks()).await;
    // Drain background delivery while both the Node workers and the Rust data
    // services they call remain available. The scheduler is stopped first, and
    // a coordinated suite shutdown has no external clients admitting new work.
    let delivery = suite.delivery.shutdown().await.into();
    if let Some(functions) = suite.functions {
        // The same line the former Node host printed: harnesses read it as the
        // proof that Functions got an orderly stop even when export failed.
        if !terminal::enabled() {
            println!("firenook functions host: stopping after the suite shutdown request");
        }
        functions.shutdown().await;
    }
    let _ = suite.shutdown.send(true);
    for server in suite.servers {
        let _ = server.await;
    }
    if let Err(error) = suite.hub.remove_locator() {
        failures.push(format!("failed to remove Hub locator: {error}"));
    }
    drop(suite.hub);
    suite.exporter.abort();
    let _ = suite.exporter.await;
    // Nothing writes any more: the console's map of the collections goes
    // with the data, so the next start shows it without reading every key.
    // Its handle to the store goes with it, before the store closes.
    if let Some(schema) = suite.schema.take() {
        let _ = tokio::task::spawn_blocking(move || schema.save()).await;
    }
    let auth_users = suite.auth.as_ref().map_or(0, |auth| auth.user_count());
    let firestore_documents = suite.store.snapshot().logical_memory_usage().entries;
    let storage_objects = suite
        .storage
        .as_ref()
        .map_or(0, |storage| storage.object_count());
    let storage_bytes = suite
        .storage
        .as_ref()
        .map_or(0, |storage| storage.object_bytes());
    // The parts that may still hold a handle to the data go first, so the
    // data can close below.
    drop(suite.compute);
    drop(suite.pubsub);
    drop(suite.jobs);
    drop(suite.triggers);
    drop(suite.logging);
    drop(suite.auth);
    // Every acknowledged commit is durable before this process reports a
    // clean shutdown, and the files are closed: the working state resumes
    // with neither a journal replay nor a repair. Storage first: its rules
    // hold a handle to Firestore.
    if let Some(storage) = suite.storage
        && let Err(error) = close_storage(storage).await
    {
        failures.push(error);
    }
    if let Err(error) = close_store(suite.store).await {
        failures.push(error);
    }
    if !failures.is_empty() {
        return Err(failure(failures.join("; ")));
    }
    Ok(SuiteOutcome {
        before_ready: false,
        functions: suite.function_count,
        schedules: suite.schedule_count,
        task_queues,
        firestore_documents,
        auth_users,
        storage_objects,
        storage_bytes,
        delivery,
    })
}

/// A selection that names Functions while `firebase.json` configures no
/// `functions` codebase and no `extensions` instance runs without the
/// Functions emulator (the official suite also has nothing to serve then),
/// announced once.
fn without_absent_functions(mut config: SuiteConfig) -> Result<SuiteConfig, SuiteRuntimeError> {
    if !config.services.functions {
        return Ok(config);
    }
    let firebase_json: serde_json::Value = serde_json::from_slice(
        &std::fs::read(&config.firebase_json)
            .map_err(|error| failure(format!("failed to read firebase.json: {error}")))?,
    )
    .map_err(|error| failure(format!("invalid firebase.json: {error}")))?;
    let codebases = codebases_from_config(&firebase_json, &config.project_dir);
    let extensions = firebase_json
        .get("extensions")
        .and_then(serde_json::Value::as_object)
        .is_some_and(|instances| !instances.is_empty());
    if codebases.is_empty() && !extensions {
        let message = "firebase.json configures no Functions codebase and no Extensions; the Functions emulator (with Eventarc and Tasks) is not started";
        terminal::print("INFO", "firenook", message, &format!("firenook: {message}"));
        config.services.functions = false;
        config.minimum_functions = 0;
    }
    Ok(config)
}

fn validate_config(config: &SuiteConfig) -> Result<(), SuiteRuntimeError> {
    if config.project_id.is_empty()
        || config
            .project_id
            .chars()
            .any(|character| character.is_whitespace() || character == '/')
    {
        return Err(failure(
            "suite requires a project ID without whitespace or slashes",
        ));
    }
    if config.host.is_empty() || config.host.chars().any(char::is_whitespace) {
        return Err(failure("suite requires a listen host"));
    }
    if config.resume_state
        && !(config.services.firestore && config.services.auth && config.services.storage)
    {
        return Err(failure(
            "--resume-state requires the firestore, auth and storage services (the native state receipt covers all three)",
        ));
    }
    let mut ports = BTreeSet::new();
    for (name, port) in listener_plan(config) {
        if port == 0 || !ports.insert(port) {
            return Err(failure(format!(
                "suite ports must be non-zero and unique ({name} at {port} collides)"
            )));
        }
    }
    let mut required = vec![
        ("project directory", &config.project_dir),
        ("firebase.json", &config.firebase_json),
    ];
    if config.services.functions {
        required.push(("Node", &config.node));
    }
    for (name, path) in required {
        if !path.exists() {
            return Err(failure(format!(
                "{name} does not exist: {}",
                path.display()
            )));
        }
    }
    Ok(())
}

/// The startup lines the official CLI prints for the project kind and the
/// selection, recorded to the log as well.
fn startup_banner(config: &SuiteConfig) -> Vec<(&'static str, String)> {
    let mut lines = vec![(
        "INFO",
        format!("Starting emulators: {}", config.services.names().join(", ")),
    )];
    if config.is_demo_project() {
        lines.push((
            "INFO",
            format!(
                "Detected demo project ID \"{}\", emulated services will use a demo configuration and attempts to access non-emulated services for this project will fail.",
                config.project_id
            ),
        ));
    } else {
        lines.push((
            "WARN",
            format!(
                "Project ID \"{}\" is not a demo project. Functions workers are started with every emulator host set and without Google credentials, and this suite never contacts Firebase itself; user code that constructs its own clients with explicit credentials can still reach the real project.",
                config.project_id
            ),
        ));
        let missing = config.services.missing();
        if config.services.functions && !missing.is_empty() {
            lines.push((
                "WARN",
                format!(
                    "The following emulators are not running, calls to these services from the Functions emulator will affect production: {}",
                    missing.join(", ")
                ),
            ));
        }
    }
    if !is_loopback(&config.host) {
        lines.push((
            "WARN",
            format!(
                "Listening on {}: the emulators have no authentication, so every service, its data and arbitrary Functions execution are reachable from any device that can reach this host.",
                config.host
            ),
        ));
    }
    if !config.ui_enabled {
        lines.push((
            "INFO",
            "Emulator UI disabled (emulators.ui.enabled is false); the logging emulator is not started either.".to_owned(),
        ));
    }
    lines
}

fn is_loopback(host: &str) -> bool {
    matches!(
        host.trim_start_matches('[').trim_end_matches(']'),
        "localhost" | "127.0.0.1" | "::1"
    )
}

const fn storage_durability(durability: DiskDurability) -> StorageDurability {
    match durability {
        DiskDurability::PerCommit => StorageDurability::PerCommit,
        DiskDurability::WriteBehind { interval } => StorageDurability::WriteBehind { interval },
    }
}

fn open_store(config: &SuiteConfig, verb: &str) -> Result<Store, SuiteRuntimeError> {
    // Without the Firestore service the store only backs Storage rules'
    // `firestore.get()` and never persists anything.
    if config.firestore_in_memory || !config.services.firestore {
        return Ok(Store::new(StoreOptions::default()));
    }
    let opening = Arc::new(OpeningWatch::default());
    let watch: Arc<dyn firenook_core_store::OpenWatch> = Arc::clone(&opening) as _;
    let opened = Store::open_disk_watched(
        config.state_dir.join("firestore"),
        DiskOptions {
            store: StoreOptions::default(),
            journal: true,
            cache_size_bytes: firenook_core_store::DEFAULT_REDB_CACHE_SIZE_BYTES,
            durability: config.durability,
            field_indexes: firenook_core_store::field_indexes_from_env(),
        },
        Some(&watch),
    );
    opening.finished(verb, opened.is_ok());
    opened.map_err(|error| match error {
        firenook_core_store::DiskError::Stopped => stopped_while_starting(),
        error => failure(format!("Firestore state failed to open: {error}")),
    })
}

/// Tells the terminal (or the plain log) about a repair after an unclean
/// stop, which reads the whole store once, and stops the open when a stop
/// is asked for.
#[derive(Default)]
struct OpeningWatch {
    /// When the repair began, the store's size, and how far the plain log
    /// last said it had got.
    repair: std::sync::Mutex<Option<(std::time::Instant, u64, f64)>>,
}

impl firenook_core_store::OpenWatch for OpeningWatch {
    fn repairing(&self, fraction: f64, bytes: u64) -> bool {
        if terminal::enabled() {
            self.repair
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .get_or_insert((std::time::Instant::now(), bytes, 0.0));
            terminal::repairing(fraction, bytes);
        } else {
            let mut repair = self
                .repair
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            match repair.as_mut() {
                None => {
                    *repair = Some((std::time::Instant::now(), bytes, fraction));
                    eprintln!(
                        "firenook: Firestore was not closed cleanly last time; repairing it reads the whole {} once. Stopping now only postpones the repair.",
                        terminal::size(bytes)
                    );
                }
                // The plain log says how far it has got as it goes, so a
                // long repair is not mistaken for a hang.
                Some((began, _, said)) if fraction >= *said + 0.1 => {
                    *said = fraction;
                    eprintln!(
                        "firenook: repairing Firestore: {:.0}% after {:.0} s",
                        fraction * 100.0,
                        began.elapsed().as_secs_f64()
                    );
                }
                Some(_) => {}
            }
        }
        !control::stop_requested()
    }

    fn stopped(&self) -> bool {
        control::stop_requested()
    }
}

impl OpeningWatch {
    fn finished(&self, verb: &str, opened: bool) {
        let Some((began, bytes, _)) = *self
            .repair
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
        else {
            return;
        };
        if !opened {
            return;
        }
        terminal::repaired(verb);
        if !terminal::enabled() {
            eprintln!(
                "firenook: Firestore repaired in {:.1} s ({})",
                began.elapsed().as_secs_f64(),
                terminal::size(bytes)
            );
        }
    }
}

/// Every configured index file, parsed once and kept per database id.
///
/// The suite enforces none of them, as the official local emulator does not,
/// but the console's explain endpoint reads them to tell a developer whether
/// the composite index their query needs is one the project already declares.
/// A database with no index file gets no entry, which is the same answer as
/// an empty catalog: nothing is declared.
fn index_catalogs(
    config: &SuiteConfig,
) -> Result<BTreeMap<String, Arc<IndexCatalog>>, SuiteRuntimeError> {
    let mut catalogs = BTreeMap::new();
    for database in &config.firestore_databases {
        let Some(path) = &database.indexes else {
            continue;
        };
        let source = std::fs::read_to_string(path).map_err(|error| {
            failure(format!(
                "failed to read Firestore indexes for database \"{}\": {error}",
                database.database_id
            ))
        })?;
        let catalog = IndexCatalog::from_json(&source).map_err(|error| {
            failure(format!(
                "database \"{}\": invalid Firestore indexes: {error}",
                database.database_id
            ))
        })?;
        catalogs.insert(database.database_id.clone(), Arc::new(catalog));
    }
    Ok(catalogs)
}

/// Validates every configured index file; the suite enforces none of them,
/// as the official local emulator does not.
fn query_policy(config: &SuiteConfig) -> Result<QueryPolicy, SuiteRuntimeError> {
    index_catalogs(config)?;
    suite_query_policy(None)
}

fn suite_query_policy(indexes: Option<&str>) -> Result<QueryPolicy, SuiteRuntimeError> {
    if let Some(source) = indexes {
        IndexCatalog::from_json(source)
            .map_err(|error| failure(format!("invalid Firestore indexes: {error}")))?;
    }
    // The official local emulator loads the configured index file but does not
    // enforce production index availability. Strict enforcement remains an
    // explicit standalone `--strict-indexes` mode.
    Ok(QueryPolicy::new(DatabaseEdition::Standard))
}

/// Installs each configured database's rules under its own database id, so
/// `projects/{p}/databases/{id}` evaluates its own ruleset; the project-wide
/// hot-reload route then governs only databases without an entry.
fn firestore_rules(config: &SuiteConfig) -> Result<RulesRuntime, SuiteRuntimeError> {
    let runtime = if config.diagnostics {
        if !terminal::enabled() {
            eprintln!(
                "firenook local diagnostics enabled: bounded request/coverage values may include document data and decoded auth claims; do not publish consumer reports"
            );
        }
        RulesRuntime::with_request_history(RequestHistory::default())
    } else {
        RulesRuntime::default()
    };
    install_firestore_rules(&runtime, &config.project_id, &config.firestore_databases)?;
    Ok(runtime)
}

fn install_firestore_rules(
    runtime: &RulesRuntime,
    project: &str,
    databases: &[FirestoreDatabaseConfig],
) -> Result<(), SuiteRuntimeError> {
    let mut seen = BTreeSet::new();
    for entry in databases {
        if !seen.insert(entry.database_id.as_str()) {
            return Err(failure(format!(
                "firebase.json configures Firestore database \"{}\" more than once",
                entry.database_id
            )));
        }
        let database = DatabaseName::new(project, entry.database_id.as_str()).map_err(|error| {
            failure(format!(
                "firebase.json names an invalid Firestore database: {error}"
            ))
        })?;
        let Some(path) = &entry.rules else {
            continue;
        };
        let source = std::fs::read_to_string(path).map_err(|error| {
            failure(format!(
                "failed to read Firestore rules for database \"{}\" from {}: {error}",
                entry.database_id,
                path.display()
            ))
        })?;
        runtime
            .install_database(&database, &source)
            .map_err(|error| {
                failure(format!(
                    "invalid Firestore rules for database \"{}\" in {}: {error}",
                    entry.database_id,
                    path.display()
                ))
            })?;
        if !terminal::enabled() {
            println!(
                "firenook firestore: database \"{}\" rules {}",
                entry.database_id,
                path.display()
            );
        }
    }
    Ok(())
}

/// Latest committed Cloud Firestore state for `firestore.get` /
/// `firestore.exists` in Storage rules: every lookup reads a fresh snapshot,
/// as the official emulator queries its Firestore emulator per call.
struct StoreDocuments {
    store: Store,
    project: String,
}

impl FirestoreDocuments for StoreDocuments {
    fn document(&self, path: &str) -> Result<Option<Resource>, DocumentAccessError> {
        SnapshotAccess::current(self.store.snapshot(), self.project.clone()).get(path)
    }
}

fn read_rules(path: &Path) -> Result<String, SuiteRuntimeError> {
    std::fs::read_to_string(path).map_err(|error| {
        failure(format!(
            "failed to read Storage rules {}: {error}",
            path.display()
        ))
    })
}

async fn start_storage(
    config: &SuiteConfig,
    delivery: &DeliveryRuntime,
    triggers: &TriggerRegistry,
    store: &Store,
    logging: &LoggingRuntime,
) -> Result<StorageRuntime, SuiteRuntimeError> {
    let source = match &config.storage_rules {
        StorageRulesConfig::Single(path) => RulesSource::Single(RulesFile {
            name: path.display().to_string(),
            content: read_rules(path)?,
        }),
        StorageRulesConfig::OpenDefault => {
            let message = format!(
                "no storage rules configured for demo project \"{}\", using a default (open) rules configuration.",
                config.project_id
            );
            terminal::print(
                "WARN",
                "storage",
                &message,
                &format!("firenook storage: {message}"),
            );
            RulesSource::Single(RulesFile {
                name: "emulators/default_storage.rules".to_owned(),
                content: DEFAULT_OPEN_STORAGE_RULES.to_owned(),
            })
        }
        StorageRulesConfig::PerBucket(buckets) => RulesSource::PerBucket(
            buckets
                .iter()
                .map(|bucket| {
                    Ok(BucketRules {
                        bucket: bucket.bucket.clone(),
                        name: bucket.rules.display().to_string(),
                        content: read_rules(&bucket.rules)?,
                    })
                })
                .collect::<Result<Vec<_>, SuiteRuntimeError>>()?,
        ),
    };
    // What `firebase.json` says beyond the sources: the files a console
    // saves to, the bucket `getStorage()` uses, whether Functions run (no
    // Storage event is queued without them, as the official emulator sends
    // none) and whether rules decisions are recorded.
    let rules_files = match &config.storage_rules {
        StorageRulesConfig::Single(path) => {
            firenook_storage_front::RulesFiles::Single(path.clone())
        }
        StorageRulesConfig::OpenDefault => firenook_storage_front::RulesFiles::None,
        StorageRulesConfig::PerBucket(buckets) => firenook_storage_front::RulesFiles::PerBucket(
            buckets
                .iter()
                .map(|bucket| (bucket.bucket.clone(), bucket.rules.clone()))
                .collect(),
        ),
    };
    let options = firenook_storage_front::StorageOptions {
        functions: config.services.functions,
        default_bucket: Some(config.default_bucket.clone()),
        rules_files: Some(rules_files),
        diagnostics: config.diagnostics,
        // From the opening on, so the staged uploads it removes are said
        // as every later line is.
        log: Some(console_wiring::storage::log_sink(logging)),
    };
    StorageRuntime::start_with(
        StorageConfig {
            project: config.project_id.clone(),
            origin: config.origin(config.ports.storage),
            data_dir: config.state_dir.join("storage"),
            durability: storage_durability(config.durability),
            rules: Some(NativeRulesConfig {
                source,
                documents: Arc::new(StoreDocuments {
                    store: store.clone(),
                    project: config.project_id.clone(),
                }),
            }),
        },
        options,
        delivery.queue(),
        triggers.clone(),
    )
    .await
    .map_err(|error| failure(format!("Storage failed to start: {error}")))
}

/// Every listener the selection needs, in the official listing order.
fn listener_plan(config: &SuiteConfig) -> Vec<(&'static str, u16)> {
    let services = config.services;
    let mut plan = vec![("hub", config.ports.hub)];
    if config.ui_enabled {
        plan.push(("ui", config.ports.ui));
        plan.push(("logging", config.ports.logging));
    }
    if services.firestore {
        plan.push(("firestore", config.ports.firestore));
        plan.push(("firestore.websocket", config.ports.firestore_websocket));
    }
    if services.auth {
        plan.push(("auth", config.ports.auth));
    }
    if services.storage {
        plan.push(("storage", config.ports.storage));
    }
    if services.functions {
        plan.push(("functions", config.ports.functions));
        plan.push(("eventarc", config.ports.eventarc));
        plan.push(("tasks", config.ports.tasks));
    }
    if services.pubsub {
        plan.push(("pubsub", config.ports.pubsub));
    }
    plan
}

fn suite_directory(config: &SuiteConfig) -> Result<SuiteDirectory, SuiteRuntimeError> {
    let host = config.connect_host();
    let services = listener_plan(config).into_iter().map(|(name, port)| {
        // The recorded official listing carries no `listen` array for the
        // Eventarc and Tasks entries.
        let mut service = if matches!(name, "eventarc" | "tasks") {
            ServiceInfo::dependency(name, &host, port)
        } else {
            ServiceInfo::listening(name, &host, port)
        };
        if name == "pubsub" {
            service.pid = Some(std::process::id());
        }
        service
    });
    SuiteDirectory::new(&config.project_id, services)
        .map_err(|error| failure(format!("invalid suite directory: {error}")))
}

fn locator_path(config: &SuiteConfig) -> PathBuf {
    std::env::temp_dir().join(format!("hub-{}.json", config.project_id))
}

fn startup_log_messages(config: &SuiteConfig) -> Vec<String> {
    listener_plan(config)
        .into_iter()
        .filter(|(name, _)| {
            !matches!(
                *name,
                "logging" | "eventarc" | "tasks" | "firestore.websocket"
            )
        })
        .map(|(name, port)| format!("{name} configured at {}", config.endpoint(port)))
        .collect()
}

struct ListenerSet(std::collections::BTreeMap<&'static str, TcpListener>);

struct StaticApplications {
    firestore: Option<tonic::service::Routes>,
    requests: Option<Router>,
    auth: Option<Router>,
    storage: Option<Router>,
    hub: Router,
    ui: Option<Router>,
    logging: Router,
}

impl ListenerSet {
    fn take(&mut self, name: &'static str) -> Result<TcpListener, SuiteRuntimeError> {
        self.0
            .remove(name)
            .ok_or_else(|| failure(format!("missing bound {name} listener")))
    }
}

async fn bind_listeners(config: &SuiteConfig) -> Result<ListenerSet, SuiteRuntimeError> {
    let mut listeners = std::collections::BTreeMap::new();
    for (name, port) in listener_plan(config) {
        let address = endpoint(&config.host, port);
        let listener = TcpListener::bind(&address)
            .await
            .map_err(|error| failure(format!("cannot bind {name} at {address}: {error}")))?;
        listeners.insert(name, listener);
    }
    Ok(ListenerSet(listeners))
}

fn spawn_static_servers(
    config: &SuiteConfig,
    listeners: &mut ListenerSet,
    applications: StaticApplications,
    logging: &LoggingRuntime,
    foreign: &ForeignProjects,
    shutdown: &watch::Sender<bool>,
    failed: &mpsc::UnboundedSender<String>,
) -> Result<Vec<JoinHandle<()>>, SuiteRuntimeError> {
    let mut servers = vec![spawn_axum(
        "hub",
        listeners.take("hub")?,
        applications.hub,
        shutdown.subscribe(),
        failed.clone(),
    )];
    if let Some(firestore) = applications.firestore {
        servers.push(spawn_firestore(
            "firestore",
            listeners.take("firestore")?,
            firestore,
            shutdown.subscribe(),
            failed.clone(),
        ));
        servers.push(spawn_axum(
            "firestore.websocket",
            listeners.take("firestore.websocket")?,
            applications
                .requests
                .unwrap_or_else(|| requests_router(None, shutdown.subscribe())),
            shutdown.subscribe(),
            failed.clone(),
        ));
    }
    if let Some(auth) = applications.auth {
        servers.push(spawn_axum(
            "auth",
            listeners.take("auth")?,
            project_scope::apply(auth, config, logging, foreign, "auth"),
            shutdown.subscribe(),
            failed.clone(),
        ));
    }
    if let Some(storage) = applications.storage {
        servers.push(spawn_axum(
            "storage",
            listeners.take("storage")?,
            storage,
            shutdown.subscribe(),
            failed.clone(),
        ));
    }
    if let Some(ui) = applications.ui {
        servers.push(spawn_axum(
            "ui",
            listeners.take("ui")?,
            ui,
            shutdown.subscribe(),
            failed.clone(),
        ));
        servers.push(spawn_axum(
            "logging",
            listeners.take("logging")?,
            applications.logging,
            shutdown.subscribe(),
            failed.clone(),
        ));
    }
    Ok(servers)
}

/// Disables Nagle's algorithm on every accepted HTTP connection.
///
/// Responses that reach the socket in several writes, such as a streamed
/// Storage download, otherwise stall for the peer's delayed-ACK timer (40 ms
/// on Linux) once a reused connection has left the kernel's initial quick-ACK
/// phase. The gRPC front already disables it through tonic's default.
pub fn no_delay(listener: TcpListener) -> TapIo<TcpListener, fn(&mut tokio::net::TcpStream)> {
    listener.tap_io(|stream| {
        if let Err(error) = stream.set_nodelay(true) {
            let message = format!("TCP_NODELAY unavailable on an accepted connection: {error}");
            terminal::print(
                "WARN",
                "firenook",
                &message,
                &format!("firenook: {message}"),
            );
        }
    })
}

/// How long a listener's graceful drain may wait for the connections that
/// were open when the suite stopped.
///
/// Every stream the console and the UI hold open ends itself on the stop
/// signal, so this budget is only ever spent on a response still being
/// written, or on a client that stopped partway through a request. Without it
/// one such connection holds the drain open for the life of the process: the
/// suite prints that it is stopping and then never exits, so the ports stay
/// taken and nothing can restart on them.
///
/// The Firestore port needs no budget of its own: `WebChannel` and gRPC hold a
/// response open by design, so [`spawn_firestore`] closes those connections
/// as soon as the suite stops rather than waiting on them.
const DRAIN_GRACE: Duration = Duration::from_secs(3);

/// Serves `application` on `listener` until `shutdown` turns true, closing
/// whatever is still connected [`DRAIN_GRACE`] later.
pub async fn serve_until_shutdown(
    name: &str,
    listener: TcpListener,
    application: Router,
    mut shutdown: watch::Receiver<bool>,
) -> std::io::Result<()> {
    let (closing, close_when_overdue) = watch::channel(false);
    let mut stopping = shutdown.clone();
    let label = name.to_owned();
    let overdue = tokio::spawn(async move {
        while !*stopping.borrow() && stopping.changed().await.is_ok() {}
        tokio::time::sleep(DRAIN_GRACE).await;
        let message = format!(
            "the {label} listener still had a connection open {}s after the stop request; closing it",
            DRAIN_GRACE.as_secs()
        );
        terminal::print(
            "WARN",
            "firenook",
            &message,
            &format!("firenook: {message}"),
        );
        let _ = closing.send(true);
    });
    let result = axum::serve(
        shutdown_io::ClosingListener::new(no_delay(listener), close_when_overdue),
        application,
    )
    .with_graceful_shutdown(async move {
        while !*shutdown.borrow() && shutdown.changed().await.is_ok() {}
    })
    .await;
    overdue.abort();
    result
}

fn spawn_axum(
    name: &'static str,
    listener: TcpListener,
    application: Router,
    shutdown: watch::Receiver<bool>,
    failed: mpsc::UnboundedSender<String>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        if let Err(error) = serve_until_shutdown(name, listener, application, shutdown).await {
            let _ = failed.send(format!("{name} listener failed: {error}"));
        }
    })
}

fn firestore_incoming(listener: TcpListener) -> TcpIncoming {
    // Tonic's builder TCP settings do not apply to a custom incoming stream.
    // Match the standalone Firestore server's accepted-socket NODELAY default.
    TcpIncoming::from(listener).with_nodelay(Some(true))
}

fn spawn_firestore(
    name: &'static str,
    listener: TcpListener,
    routes: tonic::service::Routes,
    mut shutdown: watch::Receiver<bool>,
    failed: mpsc::UnboundedSender<String>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let connections_shutdown = shutdown.clone();
        let incoming = firestore_incoming(listener).map(move |socket| {
            socket.map(|socket| shutdown_io::ShutdownIo::new(socket, connections_shutdown.clone()))
        });
        let result = tonic::transport::Server::builder()
            .accept_http1(true)
            .add_routes(routes)
            .serve_with_incoming_shutdown(incoming, async move {
                while !*shutdown.borrow() && shutdown.changed().await.is_ok() {}
            })
            .await;
        if let Err(error) = result {
            let _ = failed.send(format!("{name} listener failed: {error}"));
        }
    })
}

/// Adapts the runtime's blocking-function configuration for the Auth front.
struct BlockingBridge(firenook_functions_runtime::BlockingHandle);

impl firenook_auth_front::BlockingResolver for BlockingBridge {
    fn resolve(
        &self,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = firenook_auth_front::BlockingFunctions> + Send + '_>,
    > {
        Box::pin(async move {
            let config = self.0.config().await;
            firenook_auth_front::BlockingFunctions {
                before_create: config.before_create,
                before_sign_in: config.before_sign_in,
                forward_access_token: config.forward_access_token,
                forward_id_token: config.forward_id_token,
                forward_refresh_token: config.forward_refresh_token,
            }
        })
    }
}

/// Starts the owned Functions runtime with what the console's
/// `functions_options` hooks put in `console`: it records into compute's
/// Monitor, and the Extensions instances it loads are handed to compute's
/// `ready` hook through the same parts. Terminal output and the official
/// records stay what they were before lines were attributed
/// (`console_wiring::compute::functions_log`).
async fn start_functions_runtime(
    config: &SuiteConfig,
    triggers: TriggerRegistry,
    logging: &LoggingRuntime,
    console: FunctionsConsoleOptions,
) -> Result<FunctionsRuntime, SuiteRuntimeError> {
    let FunctionsConsoleOptions { compute } = console;
    let firebase_json: serde_json::Value = serde_json::from_slice(
        &tokio::fs::read(&config.firebase_json)
            .await
            .map_err(|error| failure(format!("failed to read firebase.json: {error}")))?,
    )
    .map_err(|error| failure(format!("invalid firebase.json: {error}")))?;
    let codebases: Vec<CodebaseConfig> = codebases_from_config(&firebase_json, &config.project_dir);
    let sink = console_wiring::compute::functions_log(logging);
    let extensions = load_extensions(config, &sink).await?;
    let backends = extensions
        .as_ref()
        .map(|outcome| {
            outcome
                .loaded
                .iter()
                .map(|extension| extension.backend.clone())
                .collect()
        })
        .unwrap_or_default();
    if let (Some(parts), Some(outcome)) = (&compute, extensions) {
        parts.hand_over_extensions(outcome);
    }
    let host = |port: u16| config.endpoint(port);
    let runtime_config = FunctionsRuntimeConfig {
        project_id: config.project_id.clone(),
        project_alias: config.project_alias.clone(),
        services: config.services.running(),
        host: config.host.clone(),
        functions_port: config.ports.functions,
        project_dir: config.project_dir.clone(),
        node: config.node.clone(),
        state_dir: config.state_dir.clone(),
        default_bucket: config.default_bucket.clone(),
        hosts: EmulatorHosts {
            firestore: host(config.ports.firestore),
            auth: host(config.ports.auth),
            storage: host(config.ports.storage),
            pubsub: host(config.ports.pubsub),
            hub: host(config.ports.hub),
            eventarc: host(config.ports.eventarc),
            tasks: host(config.ports.tasks),
        },
        codebases,
        extensions: backends,
        inspect: config.inspect_functions.clone(),
    };
    // A suite without a console records just the same.
    let monitor = compute.as_ref().map_or_else(
        || {
            firenook_functions_runtime::Monitor::new(
                firenook_functions_runtime::MonitorLimits::default(),
            )
        },
        |parts| parts.monitor().clone(),
    );
    if terminal::enabled() {
        let _ = monitor.set_tap(Arc::new(terminal::FunctionsTap));
    }
    FunctionsRuntime::start_with(
        runtime_config,
        triggers,
        sink,
        firenook_functions_runtime::RuntimeOptions {
            monitor,
            log_delivery: firenook_functions_runtime::LogDelivery::Attributed,
        },
    )
    .await
    .map_err(|error| failure(format!("Functions runtime failed to start: {error}")))
}

/// The `extensions` instances of `firebase.json` loaded into Functions
/// backends, with the instances left out for triggers the suite does not
/// emulate; `None` when firebase.json configures none.
async fn load_extensions(
    config: &SuiteConfig,
    sink: &LogSink,
) -> Result<Option<firenook_extensions::LoadOutcome>, SuiteRuntimeError> {
    let extensions_config = extensions_config(config)?;
    if extensions_config.extensions.is_empty() {
        return Ok(None);
    }
    let outcome = firenook_extensions::load_outcome(&extensions_config, sink)
        .await
        .map_err(|error| failure(format!("Extensions failed to load: {error}")))?;
    for extension in &outcome.loaded {
        let origin = match extension.origin {
            firenook_extensions::SourceOrigin::Local => "local".to_owned(),
            firenook_extensions::SourceOrigin::Vendored => "vendored".to_owned(),
            firenook_extensions::SourceOrigin::Cache => "shared cache".to_owned(),
            firenook_extensions::SourceOrigin::Downloaded => "downloaded".to_owned(),
        };
        sink.record(LogEvent::new(
            "INFO",
            "extensions",
            format!(
                "{}: {} source at {}",
                extension.backend.instance_id,
                origin,
                extension.source_dir.display()
            ),
        ));
    }
    Ok(Some(outcome))
}

/// The loader configuration for this suite: `firebase.json` `extensions`
/// in file order, `.firebaserc` aliases, the project's npm and the
/// registry credential the Firebase CLI would use.
pub fn extensions_config(
    config: &SuiteConfig,
) -> Result<firenook_extensions::ExtensionsConfig, SuiteRuntimeError> {
    // The official emulator rewrites POSTINSTALL console links to the UI
    // when the UI runs (`unknown` otherwise): firebase.json's
    // `emulators.ui.enabled`, unless `--ui` started it anyway.
    extensions_config_from(&ExtensionsInputs {
        project_id: config.project_id.clone(),
        project_dir: config.project_dir.clone(),
        firebase_json: config.firebase_json.clone(),
        default_bucket: config.default_bucket.clone(),
        node: config.node.clone(),
        offline: config.offline,
        ui_origin: config
            .ui_enabled
            .then(|| format!("{}/", config.origin(config.ports.ui))),
        services: config.services.running(),
    })
}

/// What the extensions loader needs from a project, without a running suite
/// (`firenook extensions vendor|status`).
#[derive(Debug, Clone)]
pub struct ExtensionsInputs {
    pub project_id: String,
    pub project_dir: PathBuf,
    pub firebase_json: PathBuf,
    pub default_bucket: String,
    pub node: PathBuf,
    pub offline: bool,
    pub ui_origin: Option<String>,
    /// The services the suite starts (`--only`); every one for a command
    /// that starts none.
    pub services: firenook_functions_runtime::RunningServices,
}

/// Builds the loader configuration from project inputs.
pub fn extensions_config_from(
    config: &ExtensionsInputs,
) -> Result<firenook_extensions::ExtensionsConfig, SuiteRuntimeError> {
    let text = std::fs::read_to_string(&config.firebase_json)
        .map_err(|error| failure(format!("failed to read firebase.json: {error}")))?;
    // YAML parsing keeps the object order the official planner iterates in.
    let ordered: serde_norway::Value = serde_norway::from_str(&text)
        .map_err(|error| failure(format!("invalid firebase.json: {error}")))?;
    let extensions: Vec<(String, String)> = ordered
        .get("extensions")
        .and_then(serde_norway::Value::as_mapping)
        .map(|entries| {
            entries
                .iter()
                .filter_map(|(id, value)| {
                    Some((id.as_str()?.to_owned(), value.as_str()?.to_owned()))
                })
                .collect()
        })
        .unwrap_or_default();
    let npm = config
        .node
        .parent()
        .map(|directory| directory.join("npm"))
        .filter(|candidate| candidate.is_file())
        .unwrap_or_else(|| PathBuf::from("npm"));
    Ok(firenook_extensions::ExtensionsConfig {
        project_id: config.project_id.clone(),
        project_dir: config.project_dir.clone(),
        extensions,
        aliases: project_aliases(&config.project_dir, &config.project_id),
        database_url: format!("https://{}.firebaseio.com", config.project_id),
        storage_bucket: config.default_bucket.clone(),
        npm,
        cache_dir: firenook_extensions::source::cache_directory(),
        endpoints: firenook_extensions::registry::Endpoints::from_env(),
        credential: if config.offline {
            None
        } else {
            firenook_extensions::registry::discover_credential()
        },
        offline: config.offline,
        ui_origin: config.ui_origin.clone(),
        services: config.services,
    })
}

/// `.firebaserc` aliases that point at the project id.
fn project_aliases(project_dir: &Path, project_id: &str) -> Vec<String> {
    let Ok(text) = std::fs::read_to_string(project_dir.join(".firebaserc")) else {
        return Vec::new();
    };
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&text) else {
        return Vec::new();
    };
    parsed
        .get("projects")
        .and_then(serde_json::Value::as_object)
        .map(|projects| {
            projects
                .iter()
                .filter(|(_, value)| value.as_str() == Some(project_id))
                .map(|(alias, _)| alias.clone())
                .collect()
        })
        .unwrap_or_default()
}

fn spawn_exporter(
    mut receiver: mpsc::Receiver<ExportCommand>,
    config: SuiteConfig,
    store: Store,
    auth: Option<Arc<AuthRuntime>>,
    storage: Option<Arc<StorageRuntime>>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        while let Some(command) = receiver.recv().await {
            let result = export_suite(
                &command.destination,
                &command.targets,
                &config,
                &store,
                auth.as_deref(),
                storage.as_deref(),
            )
            .await
            .map_err(|error| error.to_string());
            let _ = command.completion.send(result);
        }
    })
}

/// What the data services do as they open: import a seed, pick up saved
/// state, or start empty (the first start of data kept without a seed
/// among them).
fn data_verb(config: &SuiteConfig, reusing: bool) -> &'static str {
    if config.import.is_some() {
        "importing"
    } else if reusing {
        "resuming"
    } else {
        "starting"
    }
}

/// Opens the terminal's start-up rows for the selected data services.
fn begin_data_steps(config: &SuiteConfig, verb: &'static str) -> [Option<terminal::Step>; 3] {
    let services = config.services;
    [
        ("firestore", services.firestore),
        ("auth", services.auth),
        ("storage", services.storage),
    ]
    .map(|(id, selected)| selected.then(|| terminal::Step::begin(id, verb)))
}

/// Closes the terminal's Firestore, Auth and Storage rows with what each
/// holds now, or what the import brought in.
fn finish_data_steps(
    [firestore_step, auth_step, storage_step]: [Option<terminal::Step>; 3],
    imported: &Imported,
    store: &Store,
    auth: Option<&AuthRuntime>,
    storage: Option<&StorageRuntime>,
) {
    let held = |count: usize| u64::try_from(count).unwrap_or(u64::MAX);
    // What the service holds, or what the import brought in: one noun each
    // for one and for many.
    let figure = |imported: Option<u64>,
                  held: u64,
                  [one, many, one_brought, many_brought]: [&'static str; 4]| {
        imported.map_or_else(
            || terminal::counted(held, one, many),
            |count| terminal::counted(count, one_brought, many_brought),
        )
    };
    if let Some(step) = firestore_step {
        let nouns = [
            "document",
            "documents",
            "document imported",
            "documents imported",
        ];
        step.done(
            &[figure(imported.firestore, store.document_total(), nouns)],
            None,
        );
    }
    if let (Some(step), Some(auth)) = (auth_step, auth) {
        let nouns = ["user", "users", "user imported", "users imported"];
        step.done(
            &[figure(imported.auth, held(auth.user_count()), nouns)],
            None,
        );
    }
    if let (Some(step), Some(storage)) = (storage_step, storage) {
        let nouns = ["object", "objects", "object imported", "objects imported"];
        step.done(
            &[figure(
                imported.storage,
                held(storage.object_count()),
                nouns,
            )],
            None,
        );
    }
}

/// What an import brought in, per service; `None` for one it did not.
#[derive(Default)]
struct Imported {
    firestore: Option<u64>,
    auth: Option<u64>,
    storage: Option<u64>,
}

async fn import_suite(
    config: &SuiteConfig,
    store: &Store,
    auth: Option<&AuthRuntime>,
    storage: Option<&StorageRuntime>,
    firestore_step: Option<&terminal::Step>,
) -> Result<Imported, SuiteRuntimeError> {
    let mut imported = Imported::default();
    let Some(root) = &config.import else {
        return Ok(imported);
    };
    let metadata = read_export_metadata(root)?;
    // A component recorded in the export but not selected is skipped, as the
    // official importer skips emulators that are not running.
    if let Some(firestore) = metadata.firestore {
        if config.services.firestore {
            let path = root.join(firestore.metadata_file);
            let count = seed_store(
                store,
                &path,
                &config.project_id,
                firestore_step,
                !config.resume_state,
            )?;
            imported.firestore = Some(count);
            if !terminal::enabled() {
                let documents = terminal::plural(count, "document", "documents");
                eprintln!("firenook imported {count} Firestore {documents}");
            }
        } else if !terminal::enabled() {
            eprintln!("firenook: firestore export not imported (service not started)");
        }
    }
    if let Some(auth_metadata) = metadata.auth {
        if let Some(auth) = auth {
            let count = auth
                .import_directory(&root.join(auth_metadata.path))
                .map_err(|error| failure(format!("Auth import failed: {error}")))?;
            imported.auth = Some(u64::try_from(count).unwrap_or(u64::MAX));
            if !terminal::enabled() {
                let users = terminal::plural(count, "user", "users");
                eprintln!("firenook imported {count} Auth {users}");
            }
        } else if !terminal::enabled() {
            eprintln!("firenook: auth export not imported (service not started)");
        }
    }
    if let Some(storage_metadata) = metadata.storage {
        if let Some(storage) = storage {
            let count = storage
                .import(&root.join(storage_metadata.path))
                .await
                .map_err(|error| failure(format!("Storage import failed: {error}")))?;
            imported.storage = Some(u64::try_from(count).unwrap_or(u64::MAX));
            if !terminal::enabled() {
                let objects = terminal::plural(count, "object", "objects");
                eprintln!("firenook imported {count} Storage {objects}");
            }
        } else if !terminal::enabled() {
            eprintln!("firenook: storage export not imported (service not started)");
        }
    }
    Ok(imported)
}

#[derive(Deserialize)]
struct ExportMetadata {
    #[serde(default)]
    firestore: Option<FirestoreMetadata>,
    #[serde(default)]
    auth: Option<ComponentMetadata>,
    #[serde(default)]
    storage: Option<ComponentMetadata>,
}

#[derive(Deserialize)]
struct FirestoreMetadata {
    metadata_file: PathBuf,
}

#[derive(Deserialize)]
struct ComponentMetadata {
    path: PathBuf,
}

fn read_export_metadata(root: &Path) -> Result<ExportMetadata, SuiteRuntimeError> {
    let path = root.join("firebase-export-metadata.json");
    let bytes = std::fs::read(&path)
        .map_err(|error| failure(format!("failed to read {}: {error}", path.display())))?;
    serde_json::from_slice(&bytes)
        .map_err(|error| failure(format!("invalid suite export metadata: {error}")))
}

fn seed_store(
    store: &Store,
    path: &Path,
    project: &str,
    progress: Option<&terminal::Step>,
    stoppable: bool,
) -> Result<u64, SuiteRuntimeError> {
    let reader = ExportReader::open(path)
        .map_err(|error| failure(format!("Firestore import failed: {error}")))?
        .into_background();
    let mut bulk = store
        .begin_bulk_commit()
        .map_err(|error| failure(format!("Firestore import failed: {error}")))?;
    let mut writes = Vec::with_capacity(IMPORT_BATCH_SIZE);
    let mut batch_logical_bytes = 0_u64;
    let mut count = 0_u64;
    for document in reader {
        let document =
            document.map_err(|error| failure(format!("Firestore import failed: {error}")))?;
        let (source_key, fields) = document.into_parts();
        let database = DatabaseName::new(project, source_key.database().database_id())
            .map_err(|error| failure(error.to_string()))?;
        let key = DocumentKey::new(database, source_key.path())
            .map_err(|error| failure(error.to_string()))?;
        let write_logical_bytes =
            document_key_logical_bytes(&key).saturating_add(fields_logical_bytes(&fields));
        if !writes.is_empty()
            && (writes.len() == IMPORT_BATCH_SIZE
                || batch_logical_bytes.saturating_add(write_logical_bytes)
                    > IMPORT_BATCH_LOGICAL_BYTES)
        {
            bulk.commit(&writes)
                .map_err(|error| failure(error.to_string()))?;
            writes.clear();
            batch_logical_bytes = 0;
            if let Some(step) = progress {
                step.progress(count, None, None);
            }
            // Dropping the bulk commit aborts its one transaction.
            if stoppable && control::stop_requested() {
                return Err(stopped_while_starting());
            }
        }
        writes.push(Write::Set {
            key,
            fields,
            transforms: Vec::new(),
            precondition: Precondition::None,
        });
        batch_logical_bytes = batch_logical_bytes.saturating_add(write_logical_bytes);
        count = count.saturating_add(1);
    }
    if !writes.is_empty() {
        bulk.commit(&writes)
            .map_err(|error| failure(error.to_string()))?;
    }
    bulk.finish()
        .map_err(|error| failure(format!("Firestore import failed: {error}")))?;
    Ok(count)
}

async fn export_suite(
    destination: &Path,
    targets: &BTreeSet<String>,
    config: &SuiteConfig,
    store: &Store,
    auth: Option<&AuthRuntime>,
    storage: Option<&StorageRuntime>,
) -> Result<(), SuiteRuntimeError> {
    let destination = absolute_destination(destination)?;
    if config.resume_state {
        native_state::validate_export_destination(config, &destination)?;
    }
    let parent = destination
        .parent()
        .ok_or_else(|| failure("export destination has no parent"))?;
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|error| failure(format!("failed to create export parent: {error}")))?;
    let sequence = OffsetDateTime::now_utc().unix_timestamp_nanos();
    let staging = parent.join(format!(
        ".firenook-export-{}-{sequence}",
        std::process::id()
    ));
    let backup = parent.join(format!(
        ".firenook-export-backup-{}-{sequence}",
        std::process::id()
    ));
    tokio::fs::create_dir(&staging)
        .await
        .map_err(|error| failure(format!("failed to create export staging: {error}")))?;
    let wants = |name: &str| targets.is_empty() || targets.contains(name);
    let mut metadata = serde_json::Map::new();
    metadata.insert("version".to_owned(), json!(EXPORT_VERSION));
    if wants("firestore") && config.services.firestore {
        // A whole-database export runs for minutes on a large store; it
        // belongs on the blocking pool, not on the workers serving every
        // other emulator meanwhile.
        let written = {
            let store = store.clone();
            let project = config.project_id.clone();
            let staging = staging.clone();
            tokio::task::spawn_blocking(move || export_firestore(&store, &project, &staging))
                .await
                .map_err(|error| failure(format!("Firestore export task failed: {error}")))??
        };
        let metadata_file = relative_export_path(&staging, written.overall_metadata_path())?;
        metadata.insert(
            "firestore".to_owned(),
            json!({
                "version": "firenook-0.0.1",
                "path": "firestore_export",
                "metadata_file": metadata_file,
            }),
        );
    }
    if wants("auth")
        && let Some(auth) = auth
    {
        auth.export_directory(&staging.join("auth_export"))
            .map_err(|error| failure(format!("Auth export failed: {error}")))?;
        metadata.insert(
            "auth".to_owned(),
            json!({ "version": EXPORT_VERSION, "path": "auth_export" }),
        );
    }
    if wants("storage")
        && let Some(storage) = storage
    {
        storage
            .export(&staging.join("storage_export"))
            .await
            .map_err(|error| failure(format!("Storage export failed: {error}")))?;
        metadata.insert(
            "storage".to_owned(),
            json!({ "version": EXPORT_VERSION, "path": "storage_export" }),
        );
    }
    write_json(&staging.join("firebase-export-metadata.json"), &metadata)?;
    if destination.exists() {
        tokio::fs::rename(&destination, &backup)
            .await
            .map_err(|error| failure(format!("failed to stage existing export: {error}")))?;
    }
    if let Err(error) = tokio::fs::rename(&staging, &destination).await {
        if backup.exists() {
            let _ = tokio::fs::rename(&backup, &destination).await;
        }
        return Err(failure(format!("failed to publish suite export: {error}")));
    }
    if backup.exists() {
        tokio::fs::remove_dir_all(&backup)
            .await
            .map_err(|error| failure(format!("failed to remove replaced export: {error}")))?;
    }
    Ok(())
}

/// Writes every database of the project into the one `firestore_export`
/// directory. The entity format carries each document's database id
/// (`(default)` as absent, as the official export does), so an import
/// restores every database, not only `(default)`.
fn export_firestore(
    store: &Store,
    project: &str,
    staging: &Path,
) -> Result<firenook_export_format::WrittenExport, SuiteRuntimeError> {
    let snapshot = store.snapshot();
    let documents = snapshot
        .databases(project)
        .into_iter()
        .flat_map(|database| snapshot.iter_documents(&database))
        .map(|(key, document)| ExportedDocument::new(key, document.fields().clone()));
    write_export(staging.join("firestore_export"), documents)
        .map_err(|error| failure(format!("Firestore export failed: {error}")))
}

fn absolute_destination(path: &Path) -> Result<PathBuf, SuiteRuntimeError> {
    if path.as_os_str().is_empty() || path.file_name().is_none() {
        return Err(failure("export destination must name a directory"));
    }
    if path.is_absolute() {
        Ok(path.to_owned())
    } else {
        std::env::current_dir()
            .map(|cwd| cwd.join(path))
            .map_err(|error| failure(format!("failed to resolve export destination: {error}")))
    }
}

fn relative_export_path(staging: &Path, path: &Path) -> Result<PathBuf, SuiteRuntimeError> {
    let canonical_staging = std::fs::canonicalize(staging)
        .map_err(|error| failure(format!("failed to resolve export staging: {error}")))?;
    let canonical_path = std::fs::canonicalize(path)
        .map_err(|error| failure(format!("failed to resolve exported metadata: {error}")))?;
    canonical_path
        .strip_prefix(&canonical_staging)
        .map(Path::to_owned)
        .map_err(|error| failure(format!("invalid Firestore export path: {error}")))
}

fn write_json(path: &Path, value: &impl Serialize) -> Result<(), SuiteRuntimeError> {
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| failure(format!("failed to encode export metadata: {error}")))?;
    std::fs::write(path, bytes)
        .map_err(|error| failure(format!("failed to write export metadata: {error}")))
}

fn failure(message: impl Into<String>) -> SuiteRuntimeError {
    SuiteRuntimeError(message.into())
}

#[cfg(test)]
mod tests {
    use firenook_query_engine::{FieldFilter, FieldOperator, FieldPath, Filter, Query, QueryScope};

    use super::*;

    #[test]
    fn the_slashed_console_address_keeps_its_query() {
        use axum::response::IntoResponse as _;
        let location = |uri: &str| {
            let response = console_slash_redirect(&uri.parse().expect("uri")).into_response();
            assert_eq!(
                response.status(),
                axum::http::StatusCode::PERMANENT_REDIRECT
            );
            response.headers()[axum::http::header::LOCATION]
                .to_str()
                .expect("location")
                .to_owned()
        };
        assert_eq!(location("/console/"), CONSOLE_PATH);
        assert_eq!(location("/console/?"), CONSOLE_PATH);
        assert_eq!(
            location("/console/?connect=env&dialog=snapshot"),
            format!("{CONSOLE_PATH}?connect=env&dialog=snapshot")
        );
    }

    #[test]
    fn the_google_ui_addresses_lead_to_the_console() {
        let location = |uri: &str| legacy_location(&uri.parse().expect("uri"));
        assert_eq!(location("/"), CONSOLE_PATH);
        assert_eq!(
            location("/firestore/default/data/users/u1"),
            format!("{CONSOLE_PATH}/firestore")
        );
        assert_eq!(
            location("/firestore/default/requests"),
            format!("{CONSOLE_PATH}/firestore/rules")
        );
        assert_eq!(location("/auth"), format!("{CONSOLE_PATH}/auth"));
        assert_eq!(
            location("/storage/demo.appspot.com/files"),
            format!("{CONSOLE_PATH}/storage")
        );
        assert_eq!(
            location("/extensions/greeter"),
            format!("{CONSOLE_PATH}/extensions")
        );
        assert_eq!(location("/logs"), format!("{CONSOLE_PATH}/logs"));
        assert_eq!(
            location("/logs?q=metadata.emulator.name%3D%22functions%22"),
            format!("{CONSOLE_PATH}/logs?q=metadata.emulator.name%3D%22functions%22")
        );
        assert_eq!(location("/database/demo/data"), CONSOLE_PATH);
    }

    #[test]
    fn suite_indexes_are_validated_but_queries_remain_emulator_permissive() {
        let policy = suite_query_policy(Some(r#"{"indexes":[],"fieldOverrides":[]}"#))
            .expect("valid index configuration");
        let query = Query::new(QueryScope::collection("permissions").expect("collection")).filter(
            Filter::And(vec![
                Filter::Field(FieldFilter {
                    path: FieldPath::parse_wire("subscriptionQuota.active").expect("field"),
                    operator: FieldOperator::Equal,
                    value: firenook_core_store::Value::Boolean(true),
                }),
                Filter::Field(FieldFilter {
                    path: FieldPath::parse_wire("subscriptionQuota.periodEndDate").expect("field"),
                    operator: FieldOperator::LessThanOrEqual,
                    value: firenook_core_store::Value::Null,
                }),
            ]),
        );

        policy
            .validate(&query)
            .expect("the official suite does not enforce production indexes");
        assert!(suite_query_policy(Some("not-json")).is_err());
    }

    #[test]
    fn export_writes_every_database_of_the_project_and_import_restores_them() {
        let unique = format!(
            "firenook-suite-export-databases-{}-{}",
            std::process::id(),
            OffsetDateTime::now_utc().unix_timestamp_nanos()
        );
        let staging = std::env::temp_dir().join(unique);
        std::fs::create_dir_all(&staging).expect("staging should exist");
        let project = "demo-export-databases";
        let default = DatabaseName::new(project, "(default)").expect("database");
        let other = DatabaseName::new(project, "other").expect("database");
        let foreign = DatabaseName::new("demo-elsewhere", "other").expect("database");
        let store = Store::default();
        let fields = |value: i64| {
            firenook_core_store::Fields::from([(
                "value".to_owned(),
                firenook_core_store::Value::Integer(value),
            )])
        };
        store
            .commit(&[
                Write::Create {
                    key: DocumentKey::new(default.clone(), "items/one").expect("key"),
                    fields: fields(1),
                },
                Write::Create {
                    key: DocumentKey::new(other.clone(), "items/one").expect("key"),
                    fields: fields(2),
                },
                Write::Create {
                    key: DocumentKey::new(other.clone(), "nested/doc/items/two").expect("key"),
                    fields: fields(3),
                },
                Write::Create {
                    key: DocumentKey::new(foreign, "items/one").expect("key"),
                    fields: fields(4),
                },
            ])
            .expect("seed");

        let written = export_firestore(&store, project, &staging).expect("export");
        assert_eq!(written.entity_count(), 3);
        let mut exported = ExportReader::open(written.overall_metadata_path())
            .expect("export should open")
            .map(|document| document.expect("entity").into_parts())
            .collect::<Vec<_>>();
        exported.sort_by(|(left, _), (right, _)| left.cmp(right));
        assert_eq!(
            exported,
            vec![
                (
                    DocumentKey::new(default.clone(), "items/one").expect("key"),
                    fields(1)
                ),
                (
                    DocumentKey::new(other.clone(), "items/one").expect("key"),
                    fields(2)
                ),
                (
                    DocumentKey::new(other.clone(), "nested/doc/items/two").expect("key"),
                    fields(3)
                ),
            ]
        );

        let restored = Store::default();
        let count = seed_store(
            &restored,
            written.overall_metadata_path(),
            project,
            None,
            false,
        )
        .expect("import should restore every database");
        assert_eq!(count, 3);
        let snapshot = restored.snapshot();
        assert_eq!(
            snapshot.databases(project),
            vec![default.clone(), other.clone()]
        );
        assert_eq!(
            snapshot
                .get(&DocumentKey::new(other, "nested/doc/items/two").expect("key"))
                .expect("restored document")
                .fields(),
            &fields(3)
        );
        assert_eq!(snapshot.documents(&default).len(), 1);
        std::fs::remove_dir_all(&staging).expect("test directory should clean up");
    }

    #[test]
    fn firestore_rules_are_installed_per_configured_database() {
        let unique = format!(
            "firenook-suite-rules-databases-{}-{}",
            std::process::id(),
            OffsetDateTime::now_utc().unix_timestamp_nanos()
        );
        let root = std::env::temp_dir().join(unique);
        std::fs::create_dir_all(&root).expect("root should exist");
        let allow = root.join("allow.rules");
        let deny = root.join("deny.rules");
        std::fs::write(&allow, "rules_version = '2'; service cloud.firestore { match /databases/{db}/documents/{doc=**} { allow read, write: if true; } }").expect("rules");
        std::fs::write(&deny, "rules_version = '2'; service cloud.firestore { match /databases/{db}/documents/{doc=**} { allow read, write: if false; } }").expect("rules");
        let project = "demo-rules-databases";
        let entry = |id: &str, rules: &Path| FirestoreDatabaseConfig {
            database_id: id.to_owned(),
            rules: Some(rules.to_owned()),
            indexes: None,
        };

        let runtime = RulesRuntime::default();
        install_firestore_rules(
            &runtime,
            project,
            &[entry("(default)", &deny), entry("other", &allow)],
        )
        .expect("two databases");
        let access = SnapshotAccess::current(Store::default().snapshot(), project);
        for (id, allowed) in [("(default)", false), ("other", true), ("third", true)] {
            let database = DatabaseName::new(project, id).expect("database");
            let request = firenook_rules_engine::EvaluationRequest::new(
                firenook_rules_runtime::RequestOperation::Get,
                format!("/databases/{id}/documents/items/one"),
                firenook_rules_engine::Timestamp::new(0, 0),
            );
            assert_eq!(
                runtime
                    .evaluate(
                        &database,
                        &firenook_rules_runtime::Authorization::Client(None),
                        &request,
                        &access,
                    )
                    .allowed,
                allowed,
                "{id}"
            );
        }

        // Only named databases is a valid configuration; a repeated one is not.
        install_firestore_rules(&RulesRuntime::default(), project, &[entry("other", &allow)])
            .expect("named databases only");
        let repeated = install_firestore_rules(
            &RulesRuntime::default(),
            project,
            &[entry("other", &allow), entry("other", &deny)],
        )
        .expect_err("repeated database");
        assert!(
            repeated.to_string().contains("\"other\" more than once"),
            "{repeated}"
        );
        let missing = install_firestore_rules(
            &RulesRuntime::default(),
            project,
            &[entry("other", &root.join("missing.rules"))],
        )
        .expect_err("missing rules file");
        assert!(missing.to_string().contains("\"other\""), "{missing}");
        std::fs::remove_dir_all(&root).expect("test directory should clean up");
    }

    #[cfg(unix)]
    #[test]
    fn export_metadata_paths_tolerate_a_symlinked_staging_parent() {
        use std::os::unix::fs::symlink;

        let unique = format!(
            "firenook-suite-export-path-{}-{}",
            std::process::id(),
            OffsetDateTime::now_utc().unix_timestamp_nanos()
        );
        let root = std::env::temp_dir().join(unique);
        let actual = root.join("actual");
        let alias = root.join("alias");
        let export = actual.join("firestore_export");
        std::fs::create_dir_all(&export).expect("actual staging should exist");
        symlink(&actual, &alias).expect("staging alias should exist");
        let metadata = export.join("firestore_export.overall_export_metadata");
        std::fs::write(&metadata, []).expect("metadata should exist");

        let relative = relative_export_path(&alias, &metadata)
            .expect("canonical staging should accept the physical export path");
        assert_eq!(
            relative,
            PathBuf::from("firestore_export/firestore_export.overall_export_metadata")
        );

        std::fs::remove_dir_all(&root).expect("test directory should clean up");
    }
}
