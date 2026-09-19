//! Lifecycle coordinator for the complete Firenook emulator suite.
//!
//! The coordinator owns every data and control listener, including the
//! Functions port: user and Extension JavaScript runs in Node workers
//! supervised by the owned Functions runtime.

#![forbid(unsafe_code)]

use std::collections::BTreeSet;
use std::fmt::{self, Display, Formatter};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::Router;
use axum::serve::{ListenerExt as _, TapIo};
use firenook_auth_front::AuthRuntime;
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
use firenook_pubsub_front::{SchedulerRuntime, router as pubsub_router};
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
    BackgroundRequest, ExportCommand, HubConfig, HubRuntime, LoggingRuntime, ServiceInfo,
    SuiteDirectory, UiConfig, requests_router, ui_router,
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

mod control;
mod functions_readiness;
mod native_state;
mod project_scope;
mod shutdown_io;
pub use control::wait_for_shutdown;

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
    pub project_id: String,
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
    pub ui_archive: PathBuf,
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
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
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
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
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
    request_history: Option<RequestHistory>,
    logging: LoggingRuntime,
    hub: HubRuntime,
    ui: Option<Router>,
    export_receiver: mpsc::Receiver<ExportCommand>,
    background_receiver: mpsc::UnboundedReceiver<BackgroundRequest>,
}

struct ShutdownSuite {
    config: SuiteConfig,
    store: Store,
    delivery: DeliveryRuntime,
    auth: Option<Arc<AuthRuntime>>,
    storage: Option<Arc<StorageRuntime>>,
    hub: HubRuntime,
    exporter: JoinHandle<()>,
    functions: Option<FunctionsRuntime>,
    scheduler: Option<SchedulerRuntime>,
    tasks: Option<TasksRuntime>,
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
            "Functions runtime discovered {function_count} functions; at least {} required",
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
    println!("FIRENOOK_FUNCTIONS_HOST_READY {receipt_line}");
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
    let config = without_absent_functions(config)?;
    validate_config(&config)?;
    // Keep the OS lock alive through every service's shutdown. It is released
    // automatically on process death, without deleting/replacing the lock inode.
    let (_native_state, prepared) = prepare_native_suite(&config).await?;
    let PreparedSuite {
        store,
        triggers,
        delivery,
        auth,
        storage,
        firestore,
        request_history,
        logging,
        hub,
        ui,
        export_receiver,
        background_receiver,
    } = prepared;
    let mut listeners = bind_listeners(&config).await?;
    let (shutdown, _) = watch::channel(false);
    let (server_failure, mut failed_server) = mpsc::unbounded_channel();
    let mut servers = spawn_static_servers(
        &config,
        &mut listeners,
        StaticApplications {
            firestore,
            request_history,
            auth: auth.as_ref().map(|auth| auth.application()),
            storage: storage.as_ref().map(|storage| storage.application()),
            hub: hub.application(),
            ui,
            logging: logging.application_with_shutdown(shutdown.subscribe()),
        },
        &logging,
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
        let runtime = start_functions_runtime(&config, triggers.clone(), &logging).await?;
        spawn_functions_servers(
            &runtime,
            &mut listeners,
            &shutdown,
            &server_failure,
            &mut servers,
        )?;
        (inventory, function_count) =
            verify_functions_readiness(&config, &runtime, &logging).await?;
        if let Some(auth) = &auth {
            auth.set_blocking_functions(Arc::new(BlockingBridge(runtime.blocking_handle())));
        }
        functions = Some(runtime);
        // The Cloud Tasks emulator registers a queue per onTaskDispatched
        // export, as the official Functions emulator does at startup.
        let tasks_logging = logging.clone();
        let tasks_runtime = TasksRuntime::new(
            &config.project_id,
            &inventory,
            &config.origin(config.ports.functions),
            Arc::new(move |level: &str, text: &str| {
                if level == "WARN" || level == "ERROR" {
                    eprintln!("firenook tasks: {text}");
                } else if level != "DEBUG" {
                    println!("firenook tasks: {text}");
                }
                tasks_logging.record(level, Some("tasks"), text.to_owned());
            }),
        );
        servers.push(spawn_axum(
            "tasks",
            listeners.take("tasks")?,
            tasks_runtime.application(),
            shutdown.subscribe(),
            server_failure.clone(),
        ));
        tasks = Some(tasks_runtime);
    }
    let mut pubsub = None;
    let mut scheduler = None;
    let mut schedule_count = 0;
    if config.services.pubsub {
        let runtime = pubsub_router(&config.project_id, &inventory, delivery.queue(), triggers);
        schedule_count = runtime.schedules().len();
        scheduler = Some(
            runtime
                .start_scheduler()
                .map_err(|error| failure(format!("scheduler failed to start: {error}")))?,
        );
        // gRPC (the client libraries with `PUBSUB_EMULATOR_HOST`) and HTTP/JSON
        // share the Pub/Sub port, as on the official emulator.
        servers.push(spawn_firestore(
            "pubsub",
            listeners.take("pubsub")?,
            runtime.routes(),
            shutdown.subscribe(),
            server_failure.clone(),
        ));
        pubsub = Some(runtime);
    }
    drop(server_failure);

    announce_ready(&logging, function_count);

    let failure_reason = tokio::select! {
        signal = wait_for_shutdown() => signal.err().map(|error| error.to_string()),
        failed = failed_server.recv() => {
            Some(failed.unwrap_or_else(|| "service monitor closed".to_owned()))
        }
        error = follow_functions_inventory(
            functions.as_ref(), background_receiver, &config,
            pubsub.as_mut(), scheduler.as_mut(), tasks.as_ref(), &logging,
        ) => Some(error),
    };

    finish_suite(
        ShutdownSuite {
            config,
            store,
            delivery,
            auth,
            storage,
            hub,
            exporter,
            functions,
            scheduler,
            tasks,
            servers,
            shutdown,
            function_count,
            schedule_count,
        },
        failure_reason,
    )
    .await
}

fn announce_ready(logging: &LoggingRuntime, function_count: usize) {
    logging.record(
        "INFO",
        Some("hub"),
        format!("All emulators ready; {function_count} functions discovered"),
    );
    println!("All emulators ready");
}

async fn follow_functions_inventory(
    functions: Option<&FunctionsRuntime>,
    mut background: mpsc::UnboundedReceiver<BackgroundRequest>,
    config: &SuiteConfig,
    mut pubsub: Option<&mut firenook_pubsub_front::PubsubRuntime>,
    mut scheduler: Option<&mut SchedulerRuntime>,
    tasks: Option<&TasksRuntime>,
    logging: &LoggingRuntime,
) -> String {
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
        let count = inventory.functions().count();
        logging.record(
            "INFO",
            Some("functions"),
            format!("Functions routing refreshed; {count} registered functions"),
        );
        // Announce completion on stdout so a supervisor or harness can wait
        // for native delivery readiness after a reload.
        println!("firenook functions routing refreshed: {count} registered functions");
    }
}

async fn prepare_native_suite(
    config: &SuiteConfig,
) -> Result<(native_state::NativeState, PreparedSuite), SuiteRuntimeError> {
    let mut guard = native_state::NativeState::acquire(config)?;
    let mut startup = config.clone();
    if guard.reusing() {
        startup.import = None;
        eprintln!("firenook resuming validated native state (seed import skipped)");
    }
    let prepared = prepare_suite(&startup).await?;
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

async fn prepare_suite(config: &SuiteConfig) -> Result<PreparedSuite, SuiteRuntimeError> {
    tokio::fs::create_dir_all(&config.state_dir)
        .await
        .map_err(|error| failure(format!("failed to create suite state: {error}")))?;
    let logging = prepare_logging(config)?;
    let ui_client = if config.ui_enabled {
        Some(prepare_ui(config).await?)
    } else {
        None
    };
    let store = open_store(config)?;
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
            start_storage(config, &delivery, &triggers, &store).await?,
        ))
    } else {
        None
    };
    import_suite(config, &store, auth.as_deref(), storage.as_deref()).await?;

    let (firestore_routes, request_history) =
        prepare_firestore(config, &store, &triggers, &logging)?;

    // Auth's operational lines (OOB links, verification codes, server
    // errors) reach the console and the Emulator UI log like the official
    // CLI's `i  auth: ...` output.
    if let Some(auth) = &auth {
        let auth_logging = logging.clone();
        auth.set_log_sink(Arc::new(move |kind: &str, text: &str| {
            let level = match kind {
                "BULLET" | "SUCCESS" => "INFO",
                other => other,
            };
            if level == "WARN" || level == "ERROR" {
                eprintln!("firenook auth: {text}");
            } else {
                println!("firenook auth: {text}");
            }
            auth_logging.record(level, Some("auth"), text.to_owned());
        }));
    }
    let directory = suite_directory(config)?;
    let (export_sender, export_receiver) = mpsc::channel(4);
    let (background_sender, background_receiver) = mpsc::unbounded_channel();
    let hub = HubRuntime::start(HubConfig {
        directory: directory.clone(),
        locator_file: locator_path(config),
        pid: std::process::id(),
        exporter: export_sender,
        triggers: triggers.clone(),
        background: Some(background_sender),
    })
    .map_err(|error| failure(format!("Hub failed to start: {error}")))?;
    let ui = match ui_client {
        Some(client_directory) => Some(
            ui_router(UiConfig {
                directory,
                archive: config.ui_archive.clone(),
                client_directory,
            })
            .await
            .map_err(|error| failure(format!("UI failed to start: {error}")))?,
        ),
        None => None,
    };
    Ok(PreparedSuite {
        store,
        triggers,
        delivery,
        auth,
        storage,
        firestore: firestore_routes,
        request_history,
        logging,
        hub,
        ui,
        export_receiver,
        background_receiver,
    })
}

/// The log runtime with the `--debug-log` sink and the startup lines.
fn prepare_logging(config: &SuiteConfig) -> Result<LoggingRuntime, SuiteRuntimeError> {
    let logging = LoggingRuntime::new();
    if let Some(path) = &config.debug_log {
        logging.set_file_sink(path).map_err(|error| {
            failure(format!(
                "cannot open the debug log {}: {error}",
                path.display()
            ))
        })?;
    }
    for message in startup_log_messages(config) {
        logging.record("INFO", Some("hub"), message);
    }
    for (level, message) in startup_banner(config) {
        if level == "WARN" {
            eprintln!("firenook: {message}");
        } else {
            println!("firenook: {message}");
        }
        logging.record(level, Some("hub"), message);
    }
    Ok(logging)
}

/// The Firestore port's gRPC, REST and `WebChannel` routes, when selected.
fn prepare_firestore(
    config: &SuiteConfig,
    store: &Store,
    triggers: &TriggerRegistry,
    logging: &LoggingRuntime,
) -> Result<(Option<tonic::service::Routes>, Option<RequestHistory>), SuiteRuntimeError> {
    if !config.services.firestore {
        return Ok((None, None));
    }
    let query_policy = query_policy(config)?;
    let firestore_rules = firestore_rules(config)?;
    let request_history = firestore_rules.request_history();
    let service = FirestoreService::new_with_query_policy_and_rules(
        store.clone(),
        query_policy.clone(),
        firestore_rules.clone(),
    );
    let firestore_http = rest_router(
        store.clone(),
        query_policy,
        None,
        firestore_rules,
        triggers.clone(),
        service.clone(),
    )
    .merge(webchannel_router(FirestoreBackend::new(service.clone())));
    let firestore_http = project_scope::apply(firestore_http, config, logging);
    Ok((
        Some(tonic::service::Routes::from(firestore_http).add_service(service.into_server())),
        request_history,
    ))
}

async fn finish_suite(
    mut suite: ShutdownSuite,
    failure_reason: Option<String>,
) -> Result<SuiteOutcome, SuiteRuntimeError> {
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
    // Drain background delivery while both the Node workers and the Rust data
    // services they call remain available. The scheduler is stopped first, and
    // a coordinated suite shutdown has no external clients admitting new work.
    let delivery = suite.delivery.shutdown().await.into();
    if let Some(functions) = suite.functions {
        // The same line the former Node host printed: harnesses read it as the
        // proof that Functions got an orderly stop even when export failed.
        println!("firenook functions host: stopping after the suite shutdown request");
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
    // Every acknowledged commit is durable before this process reports a
    // clean shutdown; the working state is resumed without a journal replay.
    if let Err(error) = suite.store.flush() {
        failures.push(format!("Firestore flush failed: {error}"));
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
    if let Some(storage) = suite.storage {
        match Arc::try_unwrap(storage) {
            Ok(storage) => {
                if let Err(error) = storage.shutdown().await {
                    failures.push(format!("Storage shutdown failed: {error}"));
                }
            }
            Err(_) => failures.push("Storage runtime still has active owners".to_owned()),
        }
    }
    if !failures.is_empty() {
        return Err(failure(failures.join("; ")));
    }
    Ok(SuiteOutcome {
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
        eprintln!(
            "firenook: firebase.json configures no Functions codebase and no Extensions; the Functions emulator (with Eventarc and Tasks) is not started"
        );
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
    if config.ui_enabled {
        required.push(("UI archive", &config.ui_archive));
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

fn open_store(config: &SuiteConfig) -> Result<Store, SuiteRuntimeError> {
    // Without the Firestore service the store only backs Storage rules'
    // `firestore.get()` and never persists anything.
    if config.firestore_in_memory || !config.services.firestore {
        return Ok(Store::new(StoreOptions::default()));
    }
    Store::open_disk(
        config.state_dir.join("firestore"),
        DiskOptions {
            store: StoreOptions::default(),
            journal: true,
            cache_size_bytes: firenook_core_store::DEFAULT_REDB_CACHE_SIZE_BYTES,
            durability: config.durability,
        },
    )
    .map_err(|error| failure(format!("Firestore state failed to open: {error}")))
}

/// Validates every configured index file; the suite enforces none of them,
/// as the official local emulator does not.
fn query_policy(config: &SuiteConfig) -> Result<QueryPolicy, SuiteRuntimeError> {
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
        suite_query_policy(Some(&source)).map_err(|error| {
            failure(format!(
                "database \"{}\": {}",
                database.database_id, error.0
            ))
        })?;
    }
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
        eprintln!(
            "firenook local diagnostics enabled: bounded request/coverage values may include document data and decoded auth claims; do not publish consumer reports"
        );
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
        println!(
            "firenook firestore: database \"{}\" rules {}",
            entry.database_id,
            path.display()
        );
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
) -> Result<StorageRuntime, SuiteRuntimeError> {
    let source = match &config.storage_rules {
        StorageRulesConfig::Single(path) => RulesSource::Single(RulesFile {
            name: path.display().to_string(),
            content: read_rules(path)?,
        }),
        StorageRulesConfig::OpenDefault => {
            eprintln!(
                "firenook storage: no storage rules configured for demo project \"{}\", using a default (open) rules configuration.",
                config.project_id
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
    StorageRuntime::start(
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

async fn prepare_ui(config: &SuiteConfig) -> Result<PathBuf, SuiteRuntimeError> {
    let root = config.state_dir.join("ui-v1.15.0");
    let client = root.join("client");
    if client.join("index.html").is_file() {
        return Ok(client);
    }
    let archive = config.ui_archive.clone();
    let root_for_extract = root.clone();
    tokio::task::spawn_blocking(move || extract_zip(&archive, &root_for_extract))
        .await
        .map_err(|error| failure(format!("UI extraction task failed: {error}")))??;
    Ok(client)
}

fn extract_zip(archive: &Path, destination: &Path) -> Result<(), SuiteRuntimeError> {
    std::fs::create_dir_all(destination)
        .map_err(|error| failure(format!("failed to create UI directory: {error}")))?;
    let file = std::fs::File::open(archive)
        .map_err(|error| failure(format!("failed to open UI archive: {error}")))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|error| failure(format!("invalid UI archive: {error}")))?;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| failure(format!("invalid UI entry: {error}")))?;
        let relative = entry
            .enclosed_name()
            .ok_or_else(|| failure("UI archive entry escapes destination"))?;
        let output = destination.join(relative);
        if entry.is_dir() {
            std::fs::create_dir_all(&output)
                .map_err(|error| failure(format!("failed to create UI directory: {error}")))?;
        } else {
            if let Some(parent) = output.parent() {
                std::fs::create_dir_all(parent).map_err(|error| {
                    failure(format!("failed to create UI asset directory: {error}"))
                })?;
            }
            let mut file = std::fs::File::create(&output)
                .map_err(|error| failure(format!("failed to create UI asset: {error}")))?;
            std::io::copy(&mut entry, &mut file)
                .map_err(|error| failure(format!("failed to extract UI asset: {error}")))?;
        }
    }
    Ok(())
}

struct ListenerSet(std::collections::BTreeMap<&'static str, TcpListener>);

struct StaticApplications {
    firestore: Option<tonic::service::Routes>,
    request_history: Option<RequestHistory>,
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
            requests_router(applications.request_history, shutdown.subscribe()),
            shutdown.subscribe(),
            failed.clone(),
        ));
    }
    if let Some(auth) = applications.auth {
        servers.push(spawn_axum(
            "auth",
            listeners.take("auth")?,
            project_scope::apply(auth, config, logging),
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
            eprintln!("firenook: TCP_NODELAY unavailable on an accepted connection: {error}");
        }
    })
}

fn spawn_axum(
    name: &'static str,
    listener: TcpListener,
    application: Router,
    mut shutdown: watch::Receiver<bool>,
    failed: mpsc::UnboundedSender<String>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let result = axum::serve(no_delay(listener), application)
            .with_graceful_shutdown(async move {
                while !*shutdown.borrow() && shutdown.changed().await.is_ok() {}
            })
            .await;
        if let Err(error) = result {
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

async fn start_functions_runtime(
    config: &SuiteConfig,
    triggers: TriggerRegistry,
    logging: &LoggingRuntime,
) -> Result<FunctionsRuntime, SuiteRuntimeError> {
    let firebase_json: serde_json::Value = serde_json::from_slice(
        &tokio::fs::read(&config.firebase_json)
            .await
            .map_err(|error| failure(format!("failed to read firebase.json: {error}")))?,
    )
    .map_err(|error| failure(format!("invalid firebase.json: {error}")))?;
    let codebases: Vec<CodebaseConfig> = codebases_from_config(&firebase_json, &config.project_dir);
    let sink_logging = logging.clone();
    let sink = LogSink::new(move |event: LogEvent| {
        let label = event.label.clone();
        let line = format!("{label}: {}", event.message);
        match event.level.as_str() {
            "ERROR" | "WARN" => eprintln!("firenook {line}"),
            "DEBUG" => {}
            _ => println!("firenook {line}"),
        }
        sink_logging.record(&event.level, Some("functions"), line);
    });
    let extensions = load_extensions(config, &sink).await?;
    let host = |port: u16| config.endpoint(port);
    let runtime_config = FunctionsRuntimeConfig {
        project_id: config.project_id.clone(),
        project_alias: None,
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
        extensions,
        inspect: config.inspect_functions.clone(),
    };
    FunctionsRuntime::start(runtime_config, triggers, sink)
        .await
        .map_err(|error| failure(format!("Functions runtime failed to start: {error}")))
}

/// The `extensions` instances of `firebase.json` as Functions backends.
async fn load_extensions(
    config: &SuiteConfig,
    sink: &LogSink,
) -> Result<Vec<firenook_functions_runtime::ExtensionBackend>, SuiteRuntimeError> {
    let extensions_config = extensions_config(config)?;
    if extensions_config.extensions.is_empty() {
        return Ok(Vec::new());
    }
    let loaded = firenook_extensions::load(&extensions_config, sink)
        .await
        .map_err(|error| failure(format!("Extensions failed to load: {error}")))?;
    for extension in &loaded {
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
    Ok(loaded
        .into_iter()
        .map(|extension| extension.backend)
        .collect())
}

/// The loader configuration for this suite: `firebase.json` `extensions`
/// in file order, `.firebaserc` aliases, the project's npm and the
/// registry credential the Firebase CLI would use.
pub fn extensions_config(
    config: &SuiteConfig,
) -> Result<firenook_extensions::ExtensionsConfig, SuiteRuntimeError> {
    // The official emulator rewrites POSTINSTALL console links to the UI only
    // when the UI is enabled in firebase.json (`unknown` otherwise).
    let ui_enabled = std::fs::read_to_string(&config.firebase_json)
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|json| json.get("emulators")?.get("ui")?.get("enabled")?.as_bool())
        .unwrap_or(true);
    extensions_config_from(&ExtensionsInputs {
        project_id: config.project_id.clone(),
        project_dir: config.project_dir.clone(),
        firebase_json: config.firebase_json.clone(),
        default_bucket: config.default_bucket.clone(),
        node: config.node.clone(),
        offline: config.offline,
        ui_origin: (ui_enabled && config.ui_enabled)
            .then(|| format!("{}/", config.origin(config.ports.ui))),
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

async fn shutdown_signal() -> Result<(), SuiteRuntimeError> {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .map_err(|error| failure(format!("failed to install SIGTERM handler: {error}")))?;
        tokio::select! {
            result = tokio::signal::ctrl_c() => result.map_err(|error| failure(format!("failed to wait for Ctrl-C: {error}"))),
            _ = terminate.recv() => Ok(()),
        }
    }
    #[cfg(not(unix))]
    {
        tokio::signal::ctrl_c()
            .await
            .map_err(|error| failure(format!("failed to wait for Ctrl-C: {error}")))
    }
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

async fn import_suite(
    config: &SuiteConfig,
    store: &Store,
    auth: Option<&AuthRuntime>,
    storage: Option<&StorageRuntime>,
) -> Result<(), SuiteRuntimeError> {
    let Some(root) = &config.import else {
        return Ok(());
    };
    let metadata = read_export_metadata(root)?;
    // A component recorded in the export but not selected is skipped, as the
    // official importer skips emulators that are not running.
    if let Some(firestore) = metadata.firestore {
        if config.services.firestore {
            let path = root.join(firestore.metadata_file);
            let count = seed_store(store, &path, &config.project_id)?;
            eprintln!("firenook imported {count} Firestore documents");
        } else {
            eprintln!("firenook: firestore export not imported (service not started)");
        }
    }
    if let Some(auth_metadata) = metadata.auth {
        if let Some(auth) = auth {
            let count = auth
                .import_directory(&root.join(auth_metadata.path))
                .map_err(|error| failure(format!("Auth import failed: {error}")))?;
            eprintln!("firenook imported {count} Auth users");
        } else {
            eprintln!("firenook: auth export not imported (service not started)");
        }
    }
    if let Some(storage_metadata) = metadata.storage {
        if let Some(storage) = storage {
            let count = storage
                .import(&root.join(storage_metadata.path))
                .await
                .map_err(|error| failure(format!("Storage import failed: {error}")))?;
            eprintln!("firenook imported {count} Storage objects");
        } else {
            eprintln!("firenook: storage export not imported (service not started)");
        }
    }
    Ok(())
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

fn seed_store(store: &Store, path: &Path, project: &str) -> Result<u64, SuiteRuntimeError> {
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
        let count = seed_store(&restored, written.overall_metadata_path(), project)
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
