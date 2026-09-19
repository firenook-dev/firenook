#![forbid(unsafe_code)]

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::net::{SocketAddr, ToSocketAddrs};
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;

#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::process::Command as ProcessCommand;

use clap::{Args, Parser, Subcommand, ValueEnum};
use fireside_core_store::{
    DEFAULT_REDB_CACHE_SIZE_BYTES, DEFAULT_WRITE_BEHIND_INTERVAL, DatabaseName, DiskDurability,
    DiskOptions, DocumentKey, Precondition, Store, StoreOptions, Write,
};
use fireside_export_format::ExportReader;
use fireside_functions_bridge::{DeliveryPolicy, DeliveryRuntime, TriggerRegistry};
use fireside_grpc_front::FirestoreService;
use fireside_query_engine::{DatabaseEdition as QueryDatabaseEdition, IndexCatalog, QueryPolicy};
use fireside_rest_front::{
    AllocatorMemoryReporter, AllocatorMemoryUsage, router_with_shared_service as rest_router,
};
use fireside_rules_runtime::RulesRuntime;
use fireside_suite_runtime::{
    ServiceSelection, StorageBucketConfig, StorageRulesConfig, SuiteConfig, SuitePorts,
    run as run_suite,
};
use fireside_webchannel_front::{FirestoreBackend, router as webchannel_router};
use serde::Deserialize;

// Snapshot and protobuf churn repeatedly frees similarly sized allocations.
// Mimalloc returns empty pages instead of leaving them resident in glibc arenas.
#[global_allocator]
static GLOBAL_ALLOCATOR: mimalloc::MiMalloc = mimalloc::MiMalloc;

#[derive(Debug)]
struct MimallocMemoryReporter {
    runtime_worker_threads: usize,
    runtime_config: MimallocRuntimeConfig,
}

impl AllocatorMemoryReporter for MimallocMemoryReporter {
    fn memory_usage(&self) -> AllocatorMemoryUsage {
        let (statistics, error) = match mimalloc::MiMalloc::stats_json() {
            Ok(statistics) => match statistics.to_str() {
                Ok(statistics) => match serde_json::from_str(statistics) {
                    Ok(statistics) => (statistics, None),
                    Err(error) => (serde_json::Value::Null, Some(error.to_string())),
                },
                Err(error) => (serde_json::Value::Null, Some(error.to_string())),
            },
            Err(error) => (serde_json::Value::Null, Some(error.to_owned())),
        };
        AllocatorMemoryUsage {
            name: "mimalloc".to_owned(),
            version: mimalloc::MiMalloc.version(),
            runtime_worker_threads: self.runtime_worker_threads,
            purge_delay_milliseconds: self.runtime_config.purge_delay_milliseconds,
            purge_decommits: self.runtime_config.purge_decommits,
            statistics,
            error,
        }
    }
}

const INDEX_CONFIG_PATH: &str = "firestore.indexes.json";
const IMPORT_BATCH_SIZE: usize = 500;
const DEFAULT_MAX_WORKER_THREADS: usize = 4;
const MIMALLOC_PURGE_DELAY_ENV: &str = "MIMALLOC_PURGE_DELAY";
const MIMALLOC_PURGE_DECOMMITS_ENV: &str = "MIMALLOC_PURGE_DECOMMITS";
// Short full-dataset counterbalanced reads: avoid repeatedly purging pages
// during response encoding while still returning idle pages promptly.
const DEFAULT_MIMALLOC_PURGE_DELAY_MILLISECONDS: i64 = 100;
const DEFAULT_MIMALLOC_PURGE_DECOMMITS: bool = true;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct MimallocRuntimeConfig {
    purge_delay_milliseconds: i64,
    purge_decommits: bool,
}

#[derive(Debug, Eq, PartialEq)]
enum AllocatorBootstrapPlan {
    Ready(MimallocRuntimeConfig),
    Reexec {
        purge_delay_milliseconds: i64,
        purge_decommits: bool,
    },
}

#[derive(Debug, Parser)]
#[command(
    name = "fireside",
    version,
    about = "A clean-room local emulator suite grounded in production behavior"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, PartialEq, Eq, Subcommand)]
enum Command {
    /// Start the Firestore-compatible service.
    Firestore(FirestoreArgs),
    /// Start the Auth-compatible service on its own.
    Auth(AuthArgs),
    /// Start the Pub/Sub-compatible service on its own (gRPC and HTTP/JSON
    /// on one port).
    Pubsub(PubsubArgs),
    /// Capture redacted browser-SDK traffic through a streaming reverse proxy.
    CaptureProxy(CaptureProxyArgs),
    /// Start the complete Firebase-compatible emulator suite.
    Suite(Box<SuiteArgs>),
    /// Inspect or vendor the project's Firebase Extensions without starting
    /// the suite.
    Extensions(ExtensionsArgs),
}

#[derive(Debug, PartialEq, Eq, Args)]
struct PubsubArgs {
    #[arg(long, default_value = "127.0.0.1")]
    host: String,
    #[arg(long, default_value_t = 8085)]
    port: u16,
    /// The project the service reports itself under.
    #[arg(
        long = "project-id",
        alias = "project_id",
        default_value = "demo-fireside"
    )]
    project_id: String,
}

#[derive(Debug, PartialEq, Eq, Args)]
struct AuthArgs {
    #[arg(long, default_value = "127.0.0.1")]
    host: String,
    #[arg(long, default_value_t = 9099)]
    port: u16,
    /// The project requests without a target project address.
    #[arg(
        long = "project-id",
        alias = "project_id",
        default_value = "demo-fireside"
    )]
    project_id: String,
    /// Persist accounts, codes and configuration in this JSON file.
    #[arg(long = "state-file")]
    state_file: Option<PathBuf>,
    /// A Functions host origin (`http://host:port`) that receives the
    /// `trigger_multicast` lifecycle events; without it no events are sent.
    #[arg(long = "functions-origin")]
    functions_origin: Option<String>,
}

#[derive(Debug, PartialEq, Eq, Args)]
struct ExtensionsArgs {
    #[command(subcommand)]
    action: ExtensionsAction,
}

#[derive(Debug, PartialEq, Eq, Subcommand)]
enum ExtensionsAction {
    /// Report each instance's source state (local, vendored, cached, or
    /// needing the registry) as JSON. Nothing is downloaded.
    Status(ExtensionsProjectArgs),
    /// Copy every registry extension into `<project>/extensions/.sources`
    /// with its registry metadata, so later starts need no network or token.
    Vendor(ExtensionsVendorArgs),
}

#[derive(Debug, PartialEq, Eq, Args)]
struct ExtensionsProjectArgs {
    /// The `firebase.json` to read.
    #[arg(long, default_value = "firebase.json")]
    config: PathBuf,
    /// The project id the instances are configured for.
    #[arg(long = "project-id")]
    project_id: String,
    /// The Node binary whose sibling `npm` builds downloaded sources.
    #[arg(long, default_value = "node")]
    node: PathBuf,
}

#[derive(Debug, PartialEq, Eq, Args)]
struct ExtensionsVendorArgs {
    #[command(flatten)]
    project: ExtensionsProjectArgs,
    /// Vendor only these instance ids (default: every registry instance).
    #[arg(long = "instance")]
    instances: Vec<String>,
}

/// When acknowledged writes reach stable storage in disk mode.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, ValueEnum)]
enum Durability {
    /// Acknowledge after the journal write; sync every second and on
    /// shutdown. Survives the process; power loss can lose the last second.
    #[default]
    WriteBehind,
    /// Sync every commit before acknowledging it.
    PerCommit,
}

impl Durability {
    const fn disk(self) -> DiskDurability {
        match self {
            Self::WriteBehind => DiskDurability::WriteBehind {
                interval: DEFAULT_WRITE_BEHIND_INTERVAL,
            },
            Self::PerCommit => DiskDurability::PerCommit,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, ValueEnum)]
enum DatabaseEdition {
    #[default]
    Standard,
    Enterprise,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, ValueEnum)]
enum CaptureTransport {
    Http1,
    Http2,
    #[default]
    WebChannel,
    WebSocket,
}

impl From<CaptureTransport> for fireside_capture_proxy::Transport {
    fn from(transport: CaptureTransport) -> Self {
        match transport {
            CaptureTransport::Http1 => Self::Http1,
            CaptureTransport::Http2 => Self::Http2,
            CaptureTransport::WebChannel => Self::WebChannel,
            CaptureTransport::WebSocket => Self::WebSocket,
        }
    }
}

#[derive(Debug, Args, PartialEq, Eq)]
struct FirestoreArgs {
    #[arg(long, default_value = "127.0.0.1")]
    host: String,
    #[arg(long, default_value_t = 8080)]
    port: u16,
    #[arg(long)]
    rules: Option<PathBuf>,
    /// Enable bounded local Requests and expression coverage recording.
    /// Diagnostic values can include document data and decoded auth claims.
    #[arg(long)]
    diagnostics: bool,
    #[arg(long = "functions_emulator", alias = "functions-emulator")]
    functions_emulator: Option<String>,
    #[arg(long = "seed_from_export", alias = "seed-from-export")]
    seed_from_export: Option<PathBuf>,
    #[arg(long = "project_id", alias = "project-id")]
    project_id: Option<String>,
    #[arg(long = "single_project_mode", alias = "single-project-mode")]
    single_project_mode: Option<bool>,
    #[arg(long = "websocket_port", alias = "websocket-port")]
    websocket_port: Option<u16>,
    #[arg(
        long = "database-edition",
        alias = "database_edition",
        value_enum,
        default_value_t
    )]
    database_edition: DatabaseEdition,
    #[arg(long)]
    strict_indexes: bool,
    /// Persist Firestore state in this directory instead of keeping it in memory.
    #[arg(long = "data-dir")]
    data_dir: Option<PathBuf>,
    /// Disable the default-on write-ahead journal in disk mode.
    #[arg(long = "no-wal", requires = "data_dir")]
    no_wal: bool,
    /// Override redb's combined read/write cache budget in disk mode, in bytes.
    #[arg(long = "redb-cache-size", requires = "data_dir")]
    redb_cache_size: Option<usize>,
    /// When acknowledged writes reach stable storage in disk mode.
    #[arg(long, value_enum, default_value_t, requires = "data_dir")]
    durability: Durability,
    /// Tokio worker threads. Defaults to at most four to bound per-worker allocator pages.
    #[arg(long = "worker-threads", default_value_t = default_worker_threads())]
    worker_threads: usize,
}

#[derive(Debug, Args, PartialEq, Eq)]
struct CaptureProxyArgs {
    #[arg(long, default_value = "127.0.0.1")]
    host: String,
    #[arg(long, default_value_t = 9091)]
    port: u16,
    /// HTTP or HTTPS base URL of the Java or cloud oracle.
    #[arg(long)]
    upstream: String,
    #[arg(long)]
    hypothesis: String,
    #[arg(long)]
    target: String,
    #[arg(long = "target-version")]
    target_version: String,
    #[arg(long)]
    sdk: String,
    /// RFC 3339 timestamp supplied by the deterministic capture harness.
    #[arg(long = "recorded-at")]
    recorded_at: String,
    /// Wire transport represented by the captured fixture.
    #[arg(long, value_enum, default_value_t)]
    transport: CaptureTransport,
}

#[derive(Debug, Args, PartialEq, Eq)]
// One clap switch per independent launch flag.
#[allow(clippy::struct_excessive_bools)]
struct SuiteArgs {
    /// Disable Requests/coverage recording; the debug endpoint reports unavailable.
    #[arg(long)]
    no_diagnostics: bool,
    /// Listen address of every listener; `0.0.0.0` and `::` are accepted
    /// (clients are told the loopback address).
    #[arg(long, default_value = "127.0.0.1")]
    host: String,
    /// The data services to start (comma-separated: firestore, auth,
    /// storage, functions, pubsub; `extensions` means functions). Default:
    /// every service. Eventarc and Tasks follow Functions; the hub always runs.
    #[arg(long)]
    only: Option<String>,
    /// Do not start the Emulator UI (nor the logging emulator), as
    /// `emulators.ui.enabled: false` does officially.
    #[arg(long = "no-ui")]
    no_ui: bool,
    /// `emulators.singleProjectMode`: warn about requests naming another
    /// project (default true).
    #[arg(long = "single-project-mode", value_name = "BOOL")]
    single_project_mode: Option<bool>,
    /// Append every suite log record to this file (`--debug`).
    #[arg(long = "debug-log")]
    debug_log: Option<PathBuf>,
    /// Firebase project root used as the Functions host working directory.
    #[arg(long = "project-dir", default_value = ".")]
    project_dir: PathBuf,
    /// Firebase configuration, relative to --project-dir unless absolute.
    #[arg(long, default_value = "firebase.json")]
    config: PathBuf,
    /// Firebase aliases/targets file, relative to --project-dir unless absolute.
    #[arg(long = "firebase-rc", default_value = ".firebaserc")]
    firebase_rc: PathBuf,
    /// Explicit target=bucket mapping; repeat for multi-bucket local projects.
    #[arg(long = "storage-bucket")]
    storage_buckets: Vec<String>,
    #[arg(long = "project-id")]
    project_id: String,
    /// Accepted for compatibility with earlier launchers; the owned Functions
    /// runtime no longer loads firebase-tools.
    #[arg(long = "firebase-tools-root", hide = true)]
    firebase_tools_root: Option<PathBuf>,
    #[arg(long)]
    node: PathBuf,
    /// Start the Node Functions workers with `--inspect`; an explicit port
    /// applies to the single codebase, otherwise ports are assigned from 9229.
    #[arg(long = "inspect-functions", num_args = 0..=1, default_missing_value = "auto", value_name = "PORT")]
    inspect_functions: Option<String>,
    /// Never contact the Extensions registry: every extension ref must be
    /// vendored in the project (`fireside ext:vendor`) or present in the
    /// shared cache with its registry sidecar.
    #[arg(long)]
    offline: bool,
    #[arg(long = "ui-archive")]
    ui_archive: PathBuf,
    #[arg(long = "state-dir")]
    state_dir: PathBuf,
    /// Reuse a validated native disk state, importing the seed only on first boot.
    /// Requires --import; keep exports separate from the seed and state directory.
    #[arg(long = "resume-state", conflicts_with = "firestore_memory")]
    resume_state: bool,
    #[arg(long)]
    import: Option<PathBuf>,
    #[arg(long = "export-on-exit")]
    export_on_exit: Option<PathBuf>,
    #[arg(long = "minimum-functions", default_value_t = 1)]
    minimum_functions: usize,
    #[arg(long = "firestore-memory")]
    firestore_memory: bool,
    /// When acknowledged Firestore and Storage writes reach stable storage.
    #[arg(long, value_enum, default_value_t, conflicts_with = "firestore_memory")]
    durability: Durability,
    #[arg(long = "worker-threads", default_value_t = default_worker_threads())]
    worker_threads: usize,
    #[arg(long = "firestore-port")]
    firestore_port: Option<u16>,
    #[arg(long = "auth-port")]
    auth_port: Option<u16>,
    #[arg(long = "storage-port")]
    storage_port: Option<u16>,
    #[arg(long = "functions-port")]
    functions_port: Option<u16>,
    #[arg(long = "pubsub-port")]
    pubsub_port: Option<u16>,
    #[arg(long = "hub-port")]
    hub_port: Option<u16>,
    #[arg(long = "ui-port")]
    ui_port: Option<u16>,
    #[arg(long = "firestore-websocket-port")]
    firestore_websocket_port: Option<u16>,
    #[arg(long = "logging-port")]
    logging_port: Option<u16>,
    #[arg(long = "eventarc-port")]
    eventarc_port: Option<u16>,
    #[arg(long = "tasks-port")]
    tasks_port: Option<u16>,
}

fn main() -> ExitCode {
    let allocator_config = match ensure_allocator_environment() {
        Ok(config) => config,
        Err(error) => {
            eprintln!("allocator configuration failed: {error}");
            return ExitCode::FAILURE;
        }
    };
    let cli = Cli::parse_from(normalize_arguments(std::env::args_os()));
    match cli.command {
        Command::Firestore(arguments) => run_firestore_runtime(&arguments, allocator_config),
        Command::Auth(arguments) => run_auth_runtime(&arguments),
        Command::Pubsub(arguments) => run_pubsub_runtime(&arguments),
        Command::CaptureProxy(arguments) => run_capture_proxy_runtime(&arguments),
        Command::Suite(arguments) => run_suite_runtime(&arguments),
        Command::Extensions(arguments) => run_extensions_command(&arguments),
    }
}

fn extensions_inputs(
    arguments: &ExtensionsProjectArgs,
    offline: bool,
) -> Result<fireside_suite_runtime::ExtensionsInputs, String> {
    let firebase_json = absolute_path(&arguments.config)?;
    let project_dir = firebase_json
        .parent()
        .ok_or_else(|| "firebase.json has no parent directory".to_owned())?
        .to_owned();
    let node = if arguments.node.components().count() > 1 {
        absolute_path(&arguments.node)?
    } else {
        which_binary(&arguments.node).unwrap_or_else(|| arguments.node.clone())
    };
    Ok(fireside_suite_runtime::ExtensionsInputs {
        project_id: arguments.project_id.clone(),
        project_dir,
        firebase_json,
        default_bucket: format!("{}.appspot.com", arguments.project_id),
        node,
        offline,
        ui_origin: None,
    })
}

/// Resolves a bare command name through `PATH`.
fn which_binary(name: &std::path::Path) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|directory| directory.join(name))
        .find(|candidate| candidate.is_file())
}

fn run_extensions_command(arguments: &ExtensionsArgs) -> ExitCode {
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("runtime failed to start: {error}");
            return ExitCode::FAILURE;
        }
    };
    match &arguments.action {
        ExtensionsAction::Status(project) => {
            let inputs = match extensions_inputs(project, true) {
                Ok(inputs) => inputs,
                Err(error) => {
                    eprintln!("extensions status failed: {error}");
                    return ExitCode::FAILURE;
                }
            };
            let config = match fireside_suite_runtime::extensions_config_from(&inputs) {
                Ok(config) => config,
                Err(error) => {
                    eprintln!("extensions status failed: {error}");
                    return ExitCode::FAILURE;
                }
            };
            let report = fireside_extensions::status(&config);
            match serde_json::to_string_pretty(&report) {
                Ok(text) => {
                    println!("{text}");
                    ExitCode::SUCCESS
                }
                Err(error) => {
                    eprintln!("extensions status failed to encode: {error}");
                    ExitCode::FAILURE
                }
            }
        }
        ExtensionsAction::Vendor(vendor) => {
            let inputs = match extensions_inputs(&vendor.project, false) {
                Ok(inputs) => inputs,
                Err(error) => {
                    eprintln!("extensions vendor failed: {error}");
                    return ExitCode::FAILURE;
                }
            };
            let config = match fireside_suite_runtime::extensions_config_from(&inputs) {
                Ok(config) => config,
                Err(error) => {
                    eprintln!("extensions vendor failed: {error}");
                    return ExitCode::FAILURE;
                }
            };
            let log = fireside_functions_runtime::LogSink::stderr();
            let mut failed = false;
            for (instance_id, written) in &config.extensions {
                if !vendor.instances.is_empty() && !vendor.instances.contains(instance_id) {
                    continue;
                }
                if fireside_extensions::refs::is_local_path(written) {
                    eprintln!(
                        "fireside extensions: {instance_id} is a local extension ({written}); nothing to vendor"
                    );
                    continue;
                }
                match runtime.block_on(fireside_extensions::vendor(
                    &config,
                    instance_id,
                    written,
                    &log,
                )) {
                    Ok(target) => {
                        println!("{instance_id}: vendored {written} at {}", target.display());
                    }
                    Err(error) => {
                        failed = true;
                        eprintln!(
                            "fireside extensions: {instance_id} ({written}) could not be vendored: {error}"
                        );
                    }
                }
            }
            if failed {
                ExitCode::FAILURE
            } else {
                ExitCode::SUCCESS
            }
        }
    }
}

#[derive(Debug, Default, Deserialize)]
struct FirebaseProjectConfig {
    #[serde(default)]
    emulators: FirebaseEmulators,
    #[serde(default)]
    firestore: Option<FirebaseFirestoreSection>,
    #[serde(default)]
    storage: Option<FirebaseStorageSection>,
}

/// `firestore` is one database's settings or a list of named databases.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum FirebaseFirestoreSection {
    Single(FirebaseFirestoreConfig),
    Databases(Vec<FirebaseFirestoreConfig>),
}

impl FirebaseFirestoreSection {
    /// The entry for `(default)` (an entry without `database` counts), and
    /// the other named databases.
    fn split(
        &self,
    ) -> (
        Option<&FirebaseFirestoreConfig>,
        Vec<&FirebaseFirestoreConfig>,
    ) {
        match self {
            Self::Single(config) => (Some(config), Vec::new()),
            Self::Databases(configs) => {
                let default = configs.iter().find(|config| {
                    config
                        .database
                        .as_deref()
                        .is_none_or(|database| database == "(default)")
                });
                let others = configs
                    .iter()
                    .filter(|config| {
                        config
                            .database
                            .as_deref()
                            .is_some_and(|database| database != "(default)")
                    })
                    .collect();
                (default, others)
            }
        }
    }
}

/// `storage` is either one rules file for every bucket or a list of targets.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum FirebaseStorageSection {
    Single(FirebaseStorageRules),
    Targets(Vec<FirebaseStorageConfig>),
}

#[derive(Debug, Deserialize)]
struct FirebaseStorageRules {
    rules: PathBuf,
}

#[derive(Debug, Default, Deserialize)]
struct FirebaseEmulators {
    firestore: Option<FirebaseFirestoreEndpoint>,
    auth: Option<FirebaseEmulatorEndpoint>,
    storage: Option<FirebaseEmulatorEndpoint>,
    functions: Option<FirebaseEmulatorEndpoint>,
    pubsub: Option<FirebaseEmulatorEndpoint>,
    hub: Option<FirebaseEmulatorEndpoint>,
    ui: Option<FirebaseUiEndpoint>,
    logging: Option<FirebaseEmulatorEndpoint>,
    eventarc: Option<FirebaseEmulatorEndpoint>,
    tasks: Option<FirebaseEmulatorEndpoint>,
    #[serde(rename = "singleProjectMode")]
    single_project_mode: Option<bool>,
}

#[derive(Debug, Default, Deserialize)]
struct FirebaseEmulatorEndpoint {
    port: Option<u16>,
}

#[derive(Debug, Default, Deserialize)]
struct FirebaseFirestoreEndpoint {
    port: Option<u16>,
    #[serde(rename = "websocketPort")]
    websocket_port: Option<u16>,
}

#[derive(Debug, Default, Deserialize)]
struct FirebaseUiEndpoint {
    port: Option<u16>,
    enabled: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct FirebaseFirestoreConfig {
    database: Option<String>,
    rules: Option<PathBuf>,
    indexes: Option<PathBuf>,
}

#[derive(Debug, Deserialize)]
struct FirebaseStorageConfig {
    target: String,
    rules: PathBuf,
}

#[derive(Debug, Default, Deserialize)]
struct FirebaseRc {
    /// Absent in most projects; only Storage targets are consulted.
    #[serde(default)]
    targets: BTreeMap<String, FirebaseProjectTargets>,
}

#[derive(Debug, Default, Deserialize)]
struct FirebaseProjectTargets {
    #[serde(default)]
    storage: BTreeMap<String, Vec<String>>,
}

fn run_suite_runtime(arguments: &SuiteArgs) -> ExitCode {
    if arguments.worker_threads == 0 {
        eprintln!("--worker-threads must be at least 1");
        return ExitCode::FAILURE;
    }
    let config = match resolve_suite_config(arguments) {
        Ok(config) => config,
        Err(error) => {
            eprintln!("suite configuration is invalid: {error}");
            return ExitCode::FAILURE;
        }
    };
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .worker_threads(arguments.worker_threads)
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("suite runtime failed to start: {error}");
            return ExitCode::FAILURE;
        }
    };
    match runtime.block_on(run_suite(config)) {
        Ok(outcome) => match serde_json::to_string(&outcome) {
            Ok(outcome) => {
                eprintln!("fireside suite stopped cleanly: {outcome}");
                ExitCode::SUCCESS
            }
            Err(error) => {
                eprintln!("suite outcome failed to encode: {error}");
                ExitCode::FAILURE
            }
        },
        Err(error) => {
            eprintln!("suite failed: {error}");
            ExitCode::FAILURE
        }
    }
}

fn resolve_suite_config(arguments: &SuiteArgs) -> Result<SuiteConfig, String> {
    let project_dir = absolute_path(&arguments.project_dir)?;
    let firebase_json = project_path(&project_dir, &arguments.config);
    let firebase_rc = project_path(&project_dir, &arguments.firebase_rc);
    let raw_config = read_json::<FirebaseProjectConfig>(&firebase_json)?;
    // Most projects have no `.firebaserc`; only Storage targets are read
    // from it.
    let targets = if firebase_rc.is_file() {
        read_json::<FirebaseRc>(&firebase_rc)?
    } else {
        FirebaseRc::default()
    };
    let storage_overrides = parse_storage_overrides(&arguments.storage_buckets)?;
    let config_dir = firebase_json
        .parent()
        .ok_or_else(|| "firebase.json has no parent directory".to_owned())?
        .to_owned();
    let services = match arguments.only.as_deref() {
        Some(only) => ServiceSelection::parse(only)?,
        None => ServiceSelection::ALL,
    };
    let (storage_rules, default_bucket) = resolve_storage_rules(
        &config_dir,
        raw_config.storage.as_ref(),
        &targets,
        &arguments.project_id,
        &storage_overrides,
        services.storage,
    )?;
    let firestore = default_firestore_config(raw_config.firestore.as_ref());
    let ports = resolve_suite_ports(arguments, &raw_config.emulators);
    let ui_enabled = !arguments.no_ui
        && raw_config
            .emulators
            .ui
            .as_ref()
            .and_then(|ui| ui.enabled)
            .unwrap_or(true);
    Ok(SuiteConfig {
        host: arguments.host.clone(),
        project_id: arguments.project_id.clone(),
        services,
        ui_enabled,
        single_project_mode: arguments
            .single_project_mode
            .or(raw_config.emulators.single_project_mode)
            .unwrap_or(true),
        debug_log: arguments
            .debug_log
            .as_deref()
            .map(absolute_path)
            .transpose()?,
        project_dir,
        firebase_json,
        inspect_functions: match arguments.inspect_functions.as_deref() {
            None => None,
            Some("auto" | "true") => Some(fireside_suite_runtime::InspectConfig { port: None }),
            Some(port) => Some(fireside_suite_runtime::InspectConfig {
                port: Some(port.parse().map_err(|_| {
                    format!("--inspect-functions expects a TCP port, found {port}")
                })?),
            }),
        },
        offline: arguments.offline
            || std::env::var("FIRESIDE_OFFLINE")
                .is_ok_and(|value| matches!(value.as_str(), "1" | "true")),
        node: absolute_path(&arguments.node)?,
        ui_archive: absolute_path(&arguments.ui_archive)?,
        state_dir: absolute_path(&arguments.state_dir)?,
        resume_state: arguments.resume_state,
        firestore_in_memory: arguments.firestore_memory,
        durability: arguments.durability.disk(),
        diagnostics: !arguments.no_diagnostics,
        firestore_rules: firestore
            .and_then(|config| config.rules.as_ref())
            .map(|path| project_path(&config_dir, path)),
        firestore_indexes: firestore
            .and_then(|config| config.indexes.as_ref())
            .map(|path| project_path(&config_dir, path)),
        storage_rules,
        default_bucket,
        import: arguments.import.as_deref().map(absolute_path).transpose()?,
        export_on_exit: arguments
            .export_on_exit
            .as_deref()
            .map(absolute_path)
            .transpose()?,
        ports,
        minimum_functions: arguments.minimum_functions,
    })
}

/// The `(default)` database's rules/indexes entry; other named databases are
/// announced.
fn default_firestore_config(
    section: Option<&FirebaseFirestoreSection>,
) -> Option<&FirebaseFirestoreConfig> {
    let (firestore, other_databases) =
        section.map_or((None, Vec::new()), FirebaseFirestoreSection::split);
    if !other_databases.is_empty() {
        // The official emulator answers `Cloud Firestore Emulator does not
        // support multiple databases yet.` and loads no rules at all;
        // Fireside serves every database and applies the `(default)` entry's
        // rules and indexes to it until per-database rules land.
        eprintln!(
            "fireside firestore: firebase.json configures {} additional Firestore database(s) ({}); the (default) entry's rules and indexes govern every database",
            other_databases.len(),
            other_databases
                .iter()
                .filter_map(|config| config.database.as_deref())
                .collect::<Vec<_>>()
                .join(", ")
        );
    }
    firestore
}

fn resolve_storage_rules(
    config_dir: &std::path::Path,
    storage: Option<&FirebaseStorageSection>,
    firebase_rc: &FirebaseRc,
    project: &str,
    overrides: &BTreeMap<String, String>,
    storage_selected: bool,
) -> Result<(StorageRulesConfig, String), String> {
    let storage = match storage {
        // The official emulator governs every bucket with the one file and
        // names the default bucket after the project.
        Some(FirebaseStorageSection::Single(single)) => {
            return Ok((
                StorageRulesConfig::Single(project_path(config_dir, &single.rules)),
                format!("{project}.appspot.com"),
            ));
        }
        Some(FirebaseStorageSection::Targets(targets)) => targets.as_slice(),
        // No `storage` section: a demo project gets the official default
        // (open) rules; a real project must configure rules, as officially.
        None if !storage_selected || project.starts_with("demo-") => {
            return Ok((
                StorageRulesConfig::OpenDefault,
                format!("{project}.appspot.com"),
            ));
        }
        None => {
            return Err(
                "Cannot start the Storage emulator without rules file specified in firebase.json: run 'fireside init' and set up your Storage configuration, or use a demo-* project ID for the default open rules".to_owned(),
            );
        }
    };
    let project_targets = firebase_rc.targets.get(project);
    let mut buckets = Vec::with_capacity(storage.len());
    for entry in storage {
        let bucket = overrides.get(&entry.target).or_else(|| {
            project_targets
                .and_then(|targets| targets.storage.get(&entry.target))
                .and_then(|buckets| buckets.first())
        });
        let bucket = bucket.ok_or_else(|| {
            format!(
                "storage target {} has no bucket for {project}; pass --storage-bucket {}=<bucket>",
                entry.target, entry.target
            )
        })?;
        buckets.push(StorageBucketConfig {
            bucket: bucket.clone(),
            rules: project_path(config_dir, &entry.rules),
        });
    }
    let default_bucket = storage
        .iter()
        .position(|entry| entry.target == "default")
        .and_then(|index| buckets.get(index))
        .or_else(|| buckets.first())
        .map(|bucket| bucket.bucket.clone())
        .ok_or_else(|| "firebase.json configures no Storage buckets".to_owned())?;
    Ok((StorageRulesConfig::PerBucket(buckets), default_bucket))
}

fn parse_storage_overrides(values: &[String]) -> Result<BTreeMap<String, String>, String> {
    let mut overrides = BTreeMap::new();
    for value in values {
        let (target, bucket) = value
            .split_once('=')
            .filter(|(target, bucket)| !target.is_empty() && !bucket.is_empty())
            .ok_or_else(|| format!("invalid --storage-bucket {value}; expected target=bucket"))?;
        if overrides
            .insert(target.to_owned(), bucket.to_owned())
            .is_some()
        {
            return Err(format!("duplicate --storage-bucket target {target}"));
        }
    }
    Ok(overrides)
}

fn resolve_suite_ports(arguments: &SuiteArgs, config: &FirebaseEmulators) -> SuitePorts {
    let port = |argument: Option<u16>, configured: Option<u16>, fallback| {
        argument.or(configured).unwrap_or(fallback)
    };
    let endpoint = |endpoint: &Option<FirebaseEmulatorEndpoint>| {
        endpoint.as_ref().and_then(|endpoint| endpoint.port)
    };
    SuitePorts {
        firestore: port(
            arguments.firestore_port,
            config.firestore.as_ref().and_then(|endpoint| endpoint.port),
            8080,
        ),
        auth: port(arguments.auth_port, endpoint(&config.auth), 9099),
        storage: port(arguments.storage_port, endpoint(&config.storage), 9199),
        functions: port(arguments.functions_port, endpoint(&config.functions), 5001),
        pubsub: port(arguments.pubsub_port, endpoint(&config.pubsub), 8085),
        hub: port(arguments.hub_port, endpoint(&config.hub), 4400),
        ui: port(
            arguments.ui_port,
            config.ui.as_ref().and_then(|ui| ui.port),
            4000,
        ),
        firestore_websocket: port(
            arguments.firestore_websocket_port,
            config
                .firestore
                .as_ref()
                .and_then(|endpoint| endpoint.websocket_port),
            9150,
        ),
        logging: port(arguments.logging_port, endpoint(&config.logging), 4500),
        eventarc: port(arguments.eventarc_port, endpoint(&config.eventarc), 9299),
        tasks: port(arguments.tasks_port, endpoint(&config.tasks), 9499),
    }
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &std::path::Path) -> Result<T, String> {
    let bytes =
        std::fs::read(path).map_err(|error| format!("cannot read {}: {error}", path.display()))?;
    serde_json::from_slice(&bytes).map_err(|error| format!("invalid {}: {error}", path.display()))
}

fn absolute_path(path: &std::path::Path) -> Result<PathBuf, String> {
    if path.is_absolute() {
        return Ok(path.to_owned());
    }
    std::env::current_dir()
        .map(|directory| directory.join(path))
        .map_err(|error| format!("cannot resolve {}: {error}", path.display()))
}

fn project_path(root: &std::path::Path, path: &std::path::Path) -> PathBuf {
    if path.is_absolute() {
        path.to_owned()
    } else {
        root.join(path)
    }
}

fn run_capture_proxy_runtime(arguments: &CaptureProxyArgs) -> ExitCode {
    let listen_address = match resolve_address(&arguments.host, arguments.port) {
        Ok(address) => address,
        Err(error) => {
            eprintln!("capture proxy address is invalid: {error}");
            return ExitCode::FAILURE;
        }
    };
    let upstream = match arguments.upstream.parse() {
        Ok(upstream) => upstream,
        Err(error) => {
            eprintln!("capture proxy upstream is invalid: {error}");
            return ExitCode::FAILURE;
        }
    };
    let config = fireside_capture_proxy::CaptureProxyConfig {
        listen_address,
        upstream,
        metadata: fireside_capture_proxy::FixtureMetadata {
            hypothesis: arguments.hypothesis.clone(),
            target: arguments.target.clone(),
            target_version: arguments.target_version.clone(),
            sdk: arguments.sdk.clone(),
            recorded_at: arguments.recorded_at.clone(),
            transport: arguments.transport.into(),
        },
    };
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("capture proxy runtime failed to start: {error}");
            return ExitCode::FAILURE;
        }
    };
    eprintln!(
        "capture proxy listening on {listen_address}; fixture endpoint {}",
        fireside_capture_proxy::CAPTURE_FIXTURE_PATH
    );
    match runtime.block_on(fireside_capture_proxy::serve(config)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("capture proxy failed: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run_auth_runtime(arguments: &AuthArgs) -> ExitCode {
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("Auth runtime failed to start: {error}");
            return ExitCode::FAILURE;
        }
    };
    runtime.block_on(run_auth(arguments))
}

async fn run_auth(arguments: &AuthArgs) -> ExitCode {
    let address = match resolve_address(&arguments.host, arguments.port) {
        Ok(address) => address,
        Err(error) => {
            eprintln!("invalid Auth listen address: {error}");
            return ExitCode::FAILURE;
        }
    };
    let registry = fireside_functions_bridge::TriggerRegistry::default();
    registry.set_background_enabled(arguments.functions_origin.is_some());
    let delivery = match arguments.functions_origin.as_deref() {
        Some(origin) => match fireside_functions_bridge::DeliveryRuntime::start(
            registry.clone(),
            origin,
            fireside_functions_bridge::DeliveryPolicy::default(),
        ) {
            Ok(delivery) => Some(delivery),
            Err(error) => {
                eprintln!("Auth lifecycle delivery failed to start: {error}");
                return ExitCode::FAILURE;
            }
        },
        None => None,
    };
    let queue = if let Some(delivery) = &delivery {
        delivery.queue()
    } else {
        let (observer, _receiver) =
            fireside_functions_bridge::TriggerObserver::channel(registry.clone());
        observer.queue()
    };
    let auth = match fireside_auth_front::AuthRuntime::new(
        &arguments.project_id,
        queue,
        registry,
        arguments.state_file.clone(),
    ) {
        Ok(auth) => auth,
        Err(error) => {
            eprintln!("Auth runtime failed to start: {error}");
            return ExitCode::FAILURE;
        }
    };
    auth.set_origin(&format!("http://{}:{}", arguments.host, arguments.port));
    auth.set_log_sink(std::sync::Arc::new(|kind: &str, text: &str| {
        println!("{kind}: {text}");
    }));
    let listener = match tokio::net::TcpListener::bind(address).await {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("Auth listener failed to bind {address}: {error}");
            return ExitCode::FAILURE;
        }
    };
    println!(
        "Auth emulator ready at http://{}:{} (project {})",
        arguments.host, arguments.port, arguments.project_id
    );
    let served = axum::serve(listener, auth.application())
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await;
    if let Some(delivery) = delivery {
        let _ = delivery.shutdown().await;
    }
    match served {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("Auth listener failed: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run_pubsub_runtime(arguments: &PubsubArgs) -> ExitCode {
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("Pub/Sub runtime failed to start: {error}");
            return ExitCode::FAILURE;
        }
    };
    runtime.block_on(run_pubsub(arguments))
}

async fn run_pubsub(arguments: &PubsubArgs) -> ExitCode {
    let address = match resolve_address(&arguments.host, arguments.port) {
        Ok(address) => address,
        Err(error) => {
            eprintln!("invalid Pub/Sub listen address: {error}");
            return ExitCode::FAILURE;
        }
    };
    let registry = fireside_functions_bridge::TriggerRegistry::default();
    let (observer, _receiver) =
        fireside_functions_bridge::TriggerObserver::channel(registry.clone());
    let inventory = fireside_functions_bridge::FunctionsInventory {
        generation: 0,
        backends: Vec::new(),
    };
    let pubsub = fireside_pubsub_front::PubsubRuntime::new(
        &arguments.project_id,
        &inventory,
        observer.queue(),
        registry,
    );
    let listener = match tokio::net::TcpListener::bind(address).await {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("Pub/Sub listener failed to bind {address}: {error}");
            return ExitCode::FAILURE;
        }
    };
    println!(
        "Pub/Sub emulator ready at {}:{} (project {})",
        arguments.host, arguments.port, arguments.project_id
    );
    let incoming = tonic::transport::server::TcpIncoming::from(listener).with_nodelay(Some(true));
    let served = tonic::transport::Server::builder()
        .accept_http1(true)
        .add_routes(pubsub.routes())
        .serve_with_incoming_shutdown(incoming, async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await;
    match served {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("Pub/Sub listener failed: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run_firestore_runtime(
    arguments: &FirestoreArgs,
    allocator_config: MimallocRuntimeConfig,
) -> ExitCode {
    if arguments.worker_threads == 0 {
        eprintln!("--worker-threads must be at least 1");
        return ExitCode::FAILURE;
    }
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .worker_threads(arguments.worker_threads)
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("Firestore runtime failed to start: {error}");
            return ExitCode::FAILURE;
        }
    };
    runtime.block_on(run_firestore(arguments, allocator_config))
}

fn allocator_bootstrap_plan(
    purge_delay: Option<&std::ffi::OsStr>,
    purge_decommits: Option<&std::ffi::OsStr>,
) -> Result<AllocatorBootstrapPlan, String> {
    let parse_delay = |value: &std::ffi::OsStr| {
        value
            .to_str()
            .ok_or_else(|| format!("{MIMALLOC_PURGE_DELAY_ENV} must be valid UTF-8"))?
            .parse::<i64>()
            .map_err(|_| format!("{MIMALLOC_PURGE_DELAY_ENV} must be an integer"))
    };
    let parse_decommits = |value: &std::ffi::OsStr| match value.to_str() {
        Some("0") => Ok(false),
        Some("1") => Ok(true),
        _ => Err(format!("{MIMALLOC_PURGE_DECOMMITS_ENV} must be 0 or 1")),
    };

    let delay = purge_delay
        .map(parse_delay)
        .transpose()?
        .unwrap_or(DEFAULT_MIMALLOC_PURGE_DELAY_MILLISECONDS);
    let decommits = purge_decommits
        .map(parse_decommits)
        .transpose()?
        .unwrap_or(DEFAULT_MIMALLOC_PURGE_DECOMMITS);
    let config = MimallocRuntimeConfig {
        purge_delay_milliseconds: delay,
        purge_decommits: decommits,
    };
    if purge_delay.is_some() && purge_decommits.is_some() {
        Ok(AllocatorBootstrapPlan::Ready(config))
    } else {
        Ok(AllocatorBootstrapPlan::Reexec {
            purge_delay_milliseconds: delay,
            purge_decommits: decommits,
        })
    }
}

fn ensure_allocator_environment() -> Result<MimallocRuntimeConfig, String> {
    match allocator_bootstrap_plan(
        std::env::var_os(MIMALLOC_PURGE_DELAY_ENV).as_deref(),
        std::env::var_os(MIMALLOC_PURGE_DECOMMITS_ENV).as_deref(),
    )? {
        AllocatorBootstrapPlan::Ready(config) => Ok(config),
        AllocatorBootstrapPlan::Reexec {
            purge_delay_milliseconds,
            purge_decommits,
        } => reexec_with_allocator_environment(purge_delay_milliseconds, purge_decommits),
    }
}

#[cfg(unix)]
fn reexec_with_allocator_environment(
    purge_delay_milliseconds: i64,
    purge_decommits: bool,
) -> Result<MimallocRuntimeConfig, String> {
    let executable = std::env::current_exe()
        .map_err(|error| format!("cannot resolve current executable: {error}"))?;
    let error = ProcessCommand::new(executable)
        .args(std::env::args_os().skip(1))
        .env(
            MIMALLOC_PURGE_DELAY_ENV,
            purge_delay_milliseconds.to_string(),
        )
        .env(
            MIMALLOC_PURGE_DECOMMITS_ENV,
            if purge_decommits { "1" } else { "0" },
        )
        .exec();
    Err(format!(
        "cannot restart with allocator defaults before allocator initialization: {error}"
    ))
}

#[cfg(not(unix))]
fn reexec_with_allocator_environment(
    purge_delay_milliseconds: i64,
    purge_decommits: bool,
) -> Result<MimallocRuntimeConfig, String> {
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let status = ProcessCommand::new(executable)
        .args(std::env::args_os().skip(1))
        .env(
            MIMALLOC_PURGE_DELAY_ENV,
            purge_delay_milliseconds.to_string(),
        )
        .env(
            MIMALLOC_PURGE_DECOMMITS_ENV,
            if purge_decommits { "1" } else { "0" },
        )
        .status()
        .map_err(|error| format!("cannot start with allocator defaults: {error}"))?;
    std::process::exit(status.code().unwrap_or(1));
}

fn default_worker_threads() -> usize {
    std::thread::available_parallelism()
        .map_or(1, std::num::NonZeroUsize::get)
        .min(DEFAULT_MAX_WORKER_THREADS)
}

async fn run_firestore(
    arguments: &FirestoreArgs,
    allocator_config: MimallocRuntimeConfig,
) -> ExitCode {
    let address = match resolve_address(&arguments.host, arguments.port) {
        Ok(address) => address,
        Err(error) => {
            eprintln!("invalid Firestore listen address: {error}");
            return ExitCode::FAILURE;
        }
    };

    let store = match open_seeded_store(arguments) {
        Ok(store) => store,
        Err(error) => {
            eprintln!("{error}");
            return ExitCode::FAILURE;
        }
    };
    let edition = match arguments.database_edition {
        DatabaseEdition::Standard => QueryDatabaseEdition::Standard,
        DatabaseEdition::Enterprise => QueryDatabaseEdition::Enterprise,
    };
    let query_policy = match build_query_policy(edition, arguments.strict_indexes) {
        Ok(query_policy) => query_policy,
        Err(error) => {
            eprintln!("invalid strict-index configuration: {error}");
            return ExitCode::FAILURE;
        }
    };
    let rules = match load_rules(
        arguments.rules.as_deref(),
        arguments.diagnostics || arguments.websocket_port.is_some(),
    ) {
        Ok(rules) => rules,
        Err(error) => {
            eprintln!("{error}");
            return ExitCode::FAILURE;
        }
    };
    let (diagnostics_shutdown, _) = tokio::sync::watch::channel(false);
    let requests_server =
        match start_requests_listener(arguments, &rules, diagnostics_shutdown.subscribe()).await {
            Ok(server) => server,
            Err(error) => {
                eprintln!("Requests listener failed: {error}");
                return ExitCode::FAILURE;
            }
        };
    let triggers = TriggerRegistry::default();
    let delivery = match start_functions_delivery(arguments, &store, &triggers) {
        Ok(delivery) => delivery,
        Err(error) => {
            eprintln!("Functions background delivery failed to start: {error}");
            return ExitCode::FAILURE;
        }
    };
    let service = FirestoreService::new_with_query_policy_and_rules(
        store.clone(),
        query_policy.clone(),
        rules.clone(),
    );
    let http_routes = firestore_http_router(
        store.clone(),
        query_policy,
        Some(Arc::new(MimallocMemoryReporter {
            runtime_worker_threads: arguments.worker_threads,
            runtime_config: allocator_config,
        })),
        service.clone(),
        rules,
        triggers,
    );
    let routes = tonic::service::Routes::from(http_routes).add_service(service.into_server());
    report_firestore_configuration(arguments, address, allocator_config);
    let server = tonic::transport::Server::builder()
        .accept_http1(true)
        .add_routes(routes);
    let result = if std::env::var_os("FIRESIDE_CONTROL_STDIN").as_deref()
        == Some(std::ffi::OsStr::new("1"))
    {
        server
            .serve_with_shutdown(address, async {
                if let Err(error) = fireside_suite_runtime::wait_for_shutdown().await {
                    eprintln!("Firestore shutdown control: {error}");
                }
            })
            .await
    } else {
        server.serve(address).await
    };

    let _ = diagnostics_shutdown.send(true);
    if let Some(server) = requests_server {
        let _ = server.await;
    }
    stop_functions_delivery(delivery).await;
    firestore_exit_code(result, &store)
}

/// Every acknowledged commit is durable before a clean exit is reported.
fn firestore_exit_code(result: Result<(), tonic::transport::Error>, store: &Store) -> ExitCode {
    if let Err(error) = store.flush() {
        eprintln!("Firestore flush failed: {error}");
        return ExitCode::FAILURE;
    }
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("Firestore server failed: {error}");
            ExitCode::FAILURE
        }
    }
}

fn open_seeded_store(arguments: &FirestoreArgs) -> Result<Store, String> {
    let store = open_store(arguments)
        .map_err(|error| format!("Firestore storage failed to open: {error}"))?;
    if let Some(path) = &arguments.seed_from_export {
        let count = seed_store_from_export(&store, path, arguments.project_id.as_deref())
            .map_err(|error| format!("Firestore import failed: {error}"))?;
        eprintln!(
            "fireside imported {count} documents from {}",
            path.display()
        );
    }
    Ok(store)
}

async fn start_requests_listener(
    arguments: &FirestoreArgs,
    rules: &RulesRuntime,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
) -> Result<Option<tokio::task::JoinHandle<()>>, String> {
    let Some(port) = arguments.websocket_port else {
        return Ok(None);
    };
    let address = resolve_address(&arguments.host, port)?;
    let listener = tokio::net::TcpListener::bind(address)
        .await
        .map_err(|error| error.to_string())?;
    let application =
        fireside_suite_front::requests_router(rules.request_history(), shutdown.clone());
    Ok(Some(tokio::spawn(async move {
        if let Err(error) = axum::serve(fireside_suite_runtime::no_delay(listener), application)
            .with_graceful_shutdown(async move {
                let _ = shutdown.wait_for(|stopping| *stopping).await;
            })
            .await
        {
            eprintln!("Requests listener failed: {error}");
        }
    })))
}

fn report_firestore_configuration(
    arguments: &FirestoreArgs,
    address: SocketAddr,
    allocator_config: MimallocRuntimeConfig,
) {
    if let Some(data_dir) = &arguments.data_dir {
        let journal = if arguments.no_wal {
            "write-ahead journal disabled"
        } else {
            "write-ahead journal enabled"
        };
        let durability = match arguments.durability {
            Durability::WriteBehind => "write-behind durability",
            Durability::PerCommit => "per-commit durability",
        };
        eprintln!(
            "fireside Firestore persistence: {} ({journal}, {durability}, redb cache {} bytes)",
            data_dir.display(),
            arguments
                .redb_cache_size
                .unwrap_or(DEFAULT_REDB_CACHE_SIZE_BYTES),
        );
    }
    eprintln!(
        "fireside Firestore listening on {address} with {} runtime worker thread(s); mimalloc purge delay {} ms, decommit {}",
        arguments.worker_threads,
        allocator_config.purge_delay_milliseconds,
        allocator_config.purge_decommits,
    );
}

async fn stop_functions_delivery(delivery: Option<DeliveryRuntime>) {
    if let Some(delivery) = delivery {
        let health = delivery.shutdown().await;
        eprintln!(
            "fireside Functions delivery stopped: {} delivered, {} response-loss assumed delivered, {} duplicates suppressed, {} failed",
            health.delivered,
            health.assumed_delivered_after_response_loss,
            health.deduplicated,
            health.failed,
        );
    }
}

fn firestore_http_router(
    store: Store,
    query_policy: QueryPolicy,
    allocator_memory_reporter: Option<Arc<dyn AllocatorMemoryReporter>>,
    service: FirestoreService,
    rules: RulesRuntime,
    triggers: TriggerRegistry,
) -> axum::Router {
    rest_router(
        store,
        query_policy,
        allocator_memory_reporter,
        rules,
        triggers,
        service.clone(),
    )
    .merge(webchannel_router(FirestoreBackend::new(service)))
}

fn normalize_functions_endpoint(endpoint: &str) -> String {
    if endpoint.starts_with("http://") || endpoint.starts_with("https://") {
        endpoint.trim_end_matches('/').to_owned() + "/"
    } else {
        format!("http://{}/", endpoint.trim_end_matches('/'))
    }
}

fn start_functions_delivery(
    arguments: &FirestoreArgs,
    store: &Store,
    triggers: &TriggerRegistry,
) -> Result<Option<DeliveryRuntime>, String> {
    let Some(endpoint) = arguments.functions_emulator.as_deref() else {
        return Ok(None);
    };
    let endpoint = normalize_functions_endpoint(endpoint);
    let runtime = DeliveryRuntime::start(triggers.clone(), &endpoint, DeliveryPolicy::default())
        .map_err(|error| error.to_string())?;
    store.add_commit_observer(runtime.observer());
    eprintln!("fireside Functions background delivery: {endpoint}");
    Ok(Some(runtime))
}

fn open_store(arguments: &FirestoreArgs) -> Result<Store, String> {
    match &arguments.data_dir {
        Some(directory) => Store::open_disk(
            directory,
            DiskOptions {
                store: StoreOptions::default(),
                journal: !arguments.no_wal,
                cache_size_bytes: arguments
                    .redb_cache_size
                    .unwrap_or(DEFAULT_REDB_CACHE_SIZE_BYTES),
                durability: arguments.durability.disk(),
            },
        )
        .map_err(|error| error.to_string()),
        None if arguments.no_wal
            || arguments.redb_cache_size.is_some()
            || arguments.durability != Durability::default() =>
        {
            Err("disk-only options require --data-dir <path>".to_owned())
        }
        None => Ok(Store::new(StoreOptions::default())),
    }
}

fn load_rules(path: Option<&std::path::Path>, diagnostics: bool) -> Result<RulesRuntime, String> {
    let rules = if diagnostics {
        eprintln!(
            "fireside local diagnostics enabled: bounded request/coverage values may contain document data and decoded auth claims; do not publish consumer reports"
        );
        RulesRuntime::with_request_history(
            fireside_rules_runtime::request_history::RequestHistory::default(),
        )
    } else {
        RulesRuntime::default()
    };
    let Some(path) = path else {
        eprintln!("WARNING: fireside Security Rules are not configured; client access is open");
        return Ok(rules);
    };
    let source = std::fs::read_to_string(path).map_err(|error| {
        format!(
            "Firestore rules failed to load from {}: {error}",
            path.display()
        )
    })?;
    rules.install_default(&source).map_err(|error| {
        format!(
            "Firestore rules failed to compile from {}: {error}",
            path.display()
        )
    })?;
    eprintln!("fireside Security Rules loaded from {}", path.display());
    Ok(rules)
}

fn seed_store_from_export(
    store: &Store,
    overall_metadata: &std::path::Path,
    target_project: Option<&str>,
) -> Result<u64, String> {
    let reader = ExportReader::open(overall_metadata)
        .map_err(|error| error.to_string())?
        .into_background();
    let mut bulk = store
        .begin_bulk_commit()
        .map_err(|error| error.to_string())?;
    let mut writes = Vec::with_capacity(IMPORT_BATCH_SIZE);
    let mut count = 0_u64;
    for document in reader {
        let document = document.map_err(|error| error.to_string())?;
        let (source_key, fields) = document.into_parts();
        let key = if let Some(project_id) = target_project {
            let database = DatabaseName::new(project_id, source_key.database().database_id())
                .map_err(|error| error.to_string())?;
            DocumentKey::new(database, source_key.path()).map_err(|error| error.to_string())?
        } else {
            source_key
        };
        writes.push(Write::Set {
            key,
            fields,
            transforms: Vec::new(),
            precondition: Precondition::None,
        });
        count = count
            .checked_add(1)
            .ok_or_else(|| "import entity count overflows u64".to_owned())?;
        if writes.len() == IMPORT_BATCH_SIZE {
            bulk.commit(&writes).map_err(|error| error.to_string())?;
            writes.clear();
        }
    }
    if !writes.is_empty() {
        bulk.commit(&writes).map_err(|error| error.to_string())?;
    }
    bulk.finish().map_err(|error| error.to_string())?;
    Ok(count)
}

fn build_query_policy(
    edition: QueryDatabaseEdition,
    strict_indexes: bool,
) -> Result<QueryPolicy, String> {
    if !strict_indexes {
        return Ok(QueryPolicy::new(edition));
    }
    let json = std::fs::read_to_string(INDEX_CONFIG_PATH)
        .map_err(|error| format!("cannot read {INDEX_CONFIG_PATH}: {error}"))?;
    let catalog = IndexCatalog::from_json(&json).map_err(|error| error.to_string())?;
    Ok(QueryPolicy::strict(edition, catalog))
}

fn resolve_address(host: &str, port: u16) -> Result<SocketAddr, String> {
    (host, port)
        .to_socket_addrs()
        .map_err(|error| error.to_string())?
        .next()
        .ok_or_else(|| format!("{host}:{port} resolved to no addresses"))
}

fn normalize_arguments(arguments: impl IntoIterator<Item = OsString>) -> Vec<OsString> {
    let mut arguments = arguments.into_iter();
    let executable = arguments
        .next()
        .unwrap_or_else(|| OsString::from("fireside"));
    let remaining = arguments.collect::<Vec<_>>();
    let has_explicit_subcommand = remaining.first().is_some_and(|argument| {
        matches!(
            argument.to_str(),
            Some(
                "firestore"
                    | "auth"
                    | "pubsub"
                    | "capture-proxy"
                    | "suite"
                    | "extensions"
                    | "help"
                    | "--help"
                    | "-h"
                    | "--version"
                    | "-V"
            )
        )
    });

    let mut normalized = Vec::with_capacity(remaining.len() + 2);
    normalized.push(executable);
    if !has_explicit_subcommand {
        normalized.push(OsString::from("firestore"));
    }
    normalized.extend(remaining);
    normalized
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode, header::CONTENT_TYPE};
    use fireside_core_store::Value;
    use std::fs;
    use std::path::Path;
    use std::sync::atomic::{AtomicU64, Ordering};
    use tower::ServiceExt as _;

    static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn standalone_diagnostics_are_explicit_and_disabled_reports_are_not_empty_successes() {
        let cli = Cli::try_parse_from(["fireside", "firestore"]).unwrap();
        let Command::Firestore(arguments) = cli.command else {
            panic!("Firestore command");
        };
        assert!(!arguments.diagnostics);
        assert_eq!(
            load_rules(None, false).unwrap().coverage_json("demo-test"),
            Err(fireside_rules_runtime::coverage::CoverageError::Disabled)
        );
        let cli = Cli::try_parse_from(["fireside", "firestore", "--diagnostics"]).unwrap();
        let Command::Firestore(arguments) = cli.command else {
            panic!("Firestore command");
        };
        assert!(arguments.diagnostics);
        assert_eq!(
            load_rules(None, true).unwrap().coverage_json("demo-test"),
            Err(fireside_rules_runtime::coverage::CoverageError::NoRules)
        );
    }

    #[tokio::test]
    async fn one_http_router_serves_rest_and_webchannel() {
        let store = Store::default();
        let query_policy = QueryPolicy::default();
        let rules = RulesRuntime::default();
        let service = FirestoreService::new_with_query_policy_and_rules(
            store.clone(),
            query_policy.clone(),
            rules.clone(),
        );
        let application = firestore_http_router(
            store,
            query_policy,
            None,
            service,
            rules,
            TriggerRegistry::default(),
        );

        let rest = application
            .clone()
            .oneshot(
                Request::get("/emulator/v1/debug/memory")
                    .body(Body::empty())
                    .expect("REST request should build"),
            )
            .await
            .expect("REST route should answer");
        assert_eq!(rest.status(), StatusCode::OK);

        let handshake_body = "headers=Authorization%3ABearer+owner%0D%0A&count=1&ofs=0&req0___data__=%7B%22database%22%3A%22projects%2Fdemo%2Fdatabases%2F(default)%22%7D";
        let webchannel = application
            .oneshot(
                Request::post("/google.firestore.v1.Firestore/Listen/channel?VER=8&RID=123&CVER=22&X-HTTP-Session-Id=gsessionid&database=projects%2Fdemo%2Fdatabases%2F(default)")
                    .header(CONTENT_TYPE, "application/x-www-form-urlencoded")
                    .body(Body::from(handshake_body))
                    .expect("WebChannel request should build"),
            )
            .await
            .expect("WebChannel route should answer");
        assert_eq!(webchannel.status(), StatusCode::OK);
        assert_eq!(
            webchannel
                .headers()
                .get("x-client-wire-protocol")
                .and_then(|value| value.to_str().ok()),
            None
        );
        assert!(webchannel.headers().contains_key("x-http-session-id"));
    }

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir()
                .join(format!("fireside-cli-{}-{sequence}", std::process::id()));
            fs::create_dir_all(&path).expect("test directory should be created");
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn parses_firestore_command() {
        let cli = Cli::try_parse_from(["fireside", "firestore", "--port", "9090"])
            .expect("command should parse");
        let Command::Firestore(arguments) = cli.command else {
            panic!("expected Firestore command");
        };
        assert_eq!(arguments.port, 9090);
    }

    #[test]
    fn functions_endpoint_accepts_firebase_tools_host_port_and_http_origins() {
        assert_eq!(
            normalize_functions_endpoint("127.0.0.1:21003"),
            "http://127.0.0.1:21003/"
        );
        assert_eq!(
            normalize_functions_endpoint("http://localhost:21003/"),
            "http://localhost:21003/"
        );
    }

    #[test]
    fn parses_capture_proxy_command() {
        let cli = Cli::try_parse_from([
            "fireside",
            "capture-proxy",
            "--upstream",
            "http://127.0.0.1:8081",
            "--hypothesis",
            "handshake",
            "--target",
            "java",
            "--target-version",
            "1.22.0",
            "--sdk",
            "firebase@12.18.0",
            "--recorded-at",
            "2026-08-31T00:00:00Z",
        ])
        .expect("command should parse");
        let Command::CaptureProxy(arguments) = cli.command else {
            panic!("expected capture proxy command");
        };
        assert_eq!(arguments.port, 9091);
        assert_eq!(arguments.target, "java");
        assert_eq!(arguments.transport, CaptureTransport::WebChannel);
    }

    #[test]
    fn parses_complete_suite_command_and_storage_targets() {
        let options = [
            "fireside",
            "suite",
            "--project-id",
            "demo-synthetic-app",
            "--firebase-tools-root",
            "node_modules/firebase-tools",
            "--node",
            "node",
            "--ui-archive",
            "ui.zip",
            "--state-dir",
            "state",
            "--storage-bucket",
            "default=demo-synthetic-app.appspot.com",
            "--storage-bucket",
            "assets=synthetic-objects.example.test",
        ];
        let cli = Cli::try_parse_from(options).expect("suite command should parse");
        let Command::Suite(arguments) = cli.command else {
            panic!("expected suite command");
        };
        assert_eq!(arguments.project_id, "demo-synthetic-app");
        assert!(!arguments.no_diagnostics);
        assert_eq!(
            parse_storage_overrides(&arguments.storage_buckets).expect("targets")["assets"],
            "synthetic-objects.example.test"
        );
        let Command::Suite(disabled) =
            Cli::try_parse_from(options.into_iter().chain(["--no-diagnostics"]))
                .expect("suite diagnostics opt-out")
                .command
        else {
            panic!("expected suite command");
        };
        assert!(disabled.no_diagnostics);
    }

    #[test]
    fn duplicate_suite_storage_targets_are_rejected() {
        let values = vec!["default=a".to_owned(), "default=b".to_owned()];
        assert!(parse_storage_overrides(&values).is_err());
    }

    #[test]
    fn allocator_reporter_returns_versioned_native_statistics() {
        let usage = MimallocMemoryReporter {
            runtime_worker_threads: 3,
            runtime_config: MimallocRuntimeConfig {
                purge_delay_milliseconds: 0,
                purge_decommits: true,
            },
        }
        .memory_usage();
        assert_eq!(usage.name, "mimalloc");
        assert!(usage.version > 0);
        assert_eq!(usage.runtime_worker_threads, 3);
        assert_eq!(usage.purge_delay_milliseconds, 0);
        assert!(usage.purge_decommits);
        assert!(usage.error.is_none());
        assert!(usage.statistics.get("stat_version").is_some());
        assert!(usage.statistics.get("process").is_some());
        assert!(usage.statistics.get("committed").is_some());
        assert!(usage.statistics.get("reserved").is_some());
    }

    #[test]
    fn allocator_defaults_require_reexec_before_initialization() {
        assert_eq!(
            allocator_bootstrap_plan(None, None).expect("defaults should be valid"),
            AllocatorBootstrapPlan::Reexec {
                purge_delay_milliseconds: 100,
                purge_decommits: true,
            }
        );
    }

    #[test]
    fn allocator_explicit_environment_is_reported_without_reexec() {
        assert_eq!(
            allocator_bootstrap_plan(
                Some(std::ffi::OsStr::new("250")),
                Some(std::ffi::OsStr::new("0")),
            )
            .expect("explicit values should be valid"),
            AllocatorBootstrapPlan::Ready(MimallocRuntimeConfig {
                purge_delay_milliseconds: 250,
                purge_decommits: false,
            })
        );
    }

    #[test]
    fn allocator_environment_rejects_ambiguous_values() {
        let error = allocator_bootstrap_plan(
            Some(std::ffi::OsStr::new("immediate")),
            Some(std::ffi::OsStr::new("true")),
        )
        .expect_err("invalid allocator settings must fail startup");
        assert!(error.contains(MIMALLOC_PURGE_DELAY_ENV));
    }

    #[test]
    fn jar_flags_are_normalized_to_the_firestore_command() {
        let arguments = normalize_arguments([
            OsString::from("fireside"),
            OsString::from("--port"),
            OsString::from("9091"),
            OsString::from("--project_id"),
            OsString::from("demo-project"),
            OsString::from("--single_project_mode"),
            OsString::from("true"),
            OsString::from("--database-edition"),
            OsString::from("standard"),
        ]);
        let cli = Cli::try_parse_from(arguments).expect("jar flags should parse");
        let Command::Firestore(arguments) = cli.command else {
            panic!("expected Firestore command");
        };
        assert_eq!(arguments.port, 9091);
        assert_eq!(arguments.project_id.as_deref(), Some("demo-project"));
        assert_eq!(arguments.single_project_mode, Some(true));
        assert_eq!(arguments.database_edition, DatabaseEdition::Standard);
    }

    #[test]
    fn enterprise_database_edition_is_preserved() {
        let arguments = normalize_arguments([
            OsString::from("fireside"),
            OsString::from("--database-edition"),
            OsString::from("enterprise"),
        ]);
        let cli = Cli::try_parse_from(arguments).expect("enterprise edition should parse");
        let Command::Firestore(arguments) = cli.command else {
            panic!("expected Firestore command");
        };
        assert_eq!(arguments.database_edition, DatabaseEdition::Enterprise);
    }

    #[test]
    fn strict_index_mode_is_preserved() {
        let arguments = normalize_arguments([
            OsString::from("fireside"),
            OsString::from("--strict-indexes"),
        ]);
        let cli = Cli::try_parse_from(arguments).expect("strict indexes should parse");
        let Command::Firestore(arguments) = cli.command else {
            panic!("expected Firestore command");
        };
        assert!(arguments.strict_indexes);
    }

    #[test]
    fn data_directory_enables_disk_mode_with_wal_by_default() {
        let arguments = normalize_arguments([
            OsString::from("fireside"),
            OsString::from("--data-dir"),
            OsString::from("state"),
        ]);
        let cli = Cli::try_parse_from(arguments).expect("disk mode should parse");
        let Command::Firestore(arguments) = cli.command else {
            panic!("expected Firestore command");
        };
        assert_eq!(arguments.data_dir, Some(PathBuf::from("state")));
        assert!(!arguments.no_wal);
        assert_eq!(arguments.redb_cache_size, None);
    }

    #[test]
    fn redb_cache_budget_is_an_explicit_disk_mode_override() {
        let arguments = normalize_arguments([
            OsString::from("fireside"),
            OsString::from("--data-dir"),
            OsString::from("state"),
            OsString::from("--redb-cache-size"),
            OsString::from("67108864"),
        ]);
        let cli = Cli::try_parse_from(arguments).expect("cache override should parse");
        let Command::Firestore(arguments) = cli.command else {
            panic!("expected Firestore command");
        };
        assert_eq!(arguments.redb_cache_size, Some(67_108_864));
    }

    #[test]
    fn redb_cache_budget_requires_disk_mode() {
        let arguments = normalize_arguments([
            OsString::from("fireside"),
            OsString::from("--redb-cache-size"),
            OsString::from("67108864"),
        ]);
        let error = Cli::try_parse_from(arguments).expect_err("memory mode has no redb cache");
        assert_eq!(
            error.kind(),
            clap::error::ErrorKind::MissingRequiredArgument
        );
    }

    #[test]
    fn no_wal_is_an_explicit_disk_mode_opt_out() {
        let arguments = normalize_arguments([
            OsString::from("fireside"),
            OsString::from("--data-dir"),
            OsString::from("state"),
            OsString::from("--no-wal"),
        ]);
        let cli = Cli::try_parse_from(arguments).expect("WAL opt-out should parse");
        let Command::Firestore(arguments) = cli.command else {
            panic!("expected Firestore command");
        };
        assert!(arguments.no_wal);
    }

    #[test]
    fn no_wal_requires_disk_mode() {
        let arguments =
            normalize_arguments([OsString::from("fireside"), OsString::from("--no-wal")]);
        let error = Cli::try_parse_from(arguments).expect_err("memory mode has no WAL");
        assert_eq!(
            error.kind(),
            clap::error::ErrorKind::MissingRequiredArgument
        );
    }

    #[test]
    fn runtime_worker_threads_are_bounded_and_overridable() {
        assert!((1..=DEFAULT_MAX_WORKER_THREADS).contains(&default_worker_threads()));
        let cli = Cli::try_parse_from(["fireside", "firestore", "--worker-threads", "2"])
            .expect("worker override should parse");
        let Command::Firestore(arguments) = cli.command else {
            panic!("expected Firestore command");
        };
        assert_eq!(arguments.worker_threads, 2);
    }

    #[test]
    fn zero_runtime_workers_fail_before_runtime_start() {
        let cli = Cli::try_parse_from(["fireside", "firestore", "--worker-threads", "0"])
            .expect("numeric worker override should parse");
        let Command::Firestore(arguments) = cli.command else {
            panic!("expected Firestore command");
        };
        assert_eq!(
            run_firestore_runtime(
                &arguments,
                MimallocRuntimeConfig {
                    purge_delay_milliseconds: 0,
                    purge_decommits: true,
                },
            ),
            ExitCode::FAILURE
        );
    }

    #[test]
    fn disk_mode_store_survives_reopen_and_creates_default_wal() {
        let directory = TestDirectory::new();
        let cli = Cli::try_parse_from([
            OsString::from("fireside"),
            OsString::from("firestore"),
            OsString::from("--data-dir"),
            directory.path().as_os_str().to_owned(),
        ])
        .expect("disk mode should parse");
        let Command::Firestore(arguments) = cli.command else {
            panic!("expected Firestore command");
        };
        let database = DatabaseName::new("fireside-test", "(default)").unwrap();
        let key = DocumentKey::new(database, "items/persisted").unwrap();
        {
            let store = open_store(&arguments).expect("disk store should open");
            store
                .commit(&[Write::Set {
                    key: key.clone(),
                    fields: std::collections::BTreeMap::from([(
                        "value".to_owned(),
                        Value::Integer(42),
                    )]),
                    transforms: Vec::new(),
                    precondition: Precondition::None,
                }])
                .expect("write should commit");
        }

        let reopened = open_store(&arguments).expect("disk store should reopen");
        assert!(reopened.snapshot().get(&key).is_some());
        assert!(directory.path().join("fireside.redb").is_file());
        assert!(directory.path().join("fireside.wal").is_file());
    }

    #[test]
    fn no_wal_omits_the_journal_file() {
        let directory = TestDirectory::new();
        let cli = Cli::try_parse_from([
            OsString::from("fireside"),
            OsString::from("firestore"),
            OsString::from("--data-dir"),
            directory.path().as_os_str().to_owned(),
            OsString::from("--no-wal"),
        ])
        .expect("WAL opt-out should parse");
        let Command::Firestore(arguments) = cli.command else {
            panic!("expected Firestore command");
        };
        drop(open_store(&arguments).expect("disk store should open"));

        assert!(directory.path().join("fireside.redb").is_file());
        assert!(!directory.path().join("fireside.wal").exists());
    }

    #[test]
    fn single_file_storage_rules_govern_the_project_default_bucket() {
        let config: FirebaseProjectConfig =
            serde_json::from_str(r#"{ "storage": { "rules": "storage.rules" } }"#)
                .expect("single-file storage config");
        let firebase_rc: FirebaseRc =
            serde_json::from_str(r#"{ "projects": { "default": "demo-single" } }"#)
                .expect(".firebaserc without targets parses");
        let (rules, default_bucket) = resolve_storage_rules(
            std::path::Path::new("/project"),
            config.storage.as_ref(),
            &firebase_rc,
            "demo-single",
            &BTreeMap::new(),
            true,
        )
        .expect("single file resolves without targets");
        assert_eq!(
            rules,
            StorageRulesConfig::Single(PathBuf::from("/project/storage.rules"))
        );
        assert_eq!(default_bucket, "demo-single.appspot.com");
        let targets: FirebaseProjectConfig =
            serde_json::from_str(r#"{ "storage": [{ "target": "default", "rules": "a.rules" }] }"#)
                .expect("targets storage config");
        assert!(matches!(
            targets.storage,
            Some(FirebaseStorageSection::Targets(ref entries)) if entries.len() == 1
        ));
    }

    #[test]
    fn listen_address_accepts_hostnames() {
        let address = resolve_address("localhost", 8080).expect("localhost should resolve");
        assert_eq!(address.port(), 8080);
    }

    #[test]
    fn startup_import_remaps_document_project_but_preserves_reference_values() {
        const FIXTURE: &str = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../conformance/fixtures/official-export-v1.22.0/firestore_export/",
            "firestore_export.overall_export_metadata"
        );
        let store = Store::default();
        let count = seed_store_from_export(
            &store,
            std::path::Path::new(FIXTURE),
            Some("demo-fireside-import-remap"),
        )
        .expect("official artifact should import");
        assert_eq!(count, 4);
        let database = DatabaseName::new("demo-fireside-import-remap", "(default)").unwrap();
        let key = DocumentKey::new(database, "fireside_export_fixture/values").unwrap();
        let document = store
            .snapshot()
            .get(&key)
            .expect("document should be remapped");
        let Value::Reference(reference) = &document.fields()["reference"] else {
            panic!("reference should preserve its value type");
        };
        assert_eq!(
            reference.as_ref(),
            "projects/demo-fireside-export-oracle/databases/(default)/documents/\
             fireside_export_fixture/reference-target"
        );
    }
}
