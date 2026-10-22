//! The observe stream's part of the console: Logs and the Overview, built
//! from the running suite, and the producers of the notable lines the
//! console log keeps that no service crate writes itself — Firestore rules
//! denials, rules taking effect, background triggers switching, the
//! official Firestore clear, and every Functions log event.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::extract::Request;
use axum::http::Method;
use axum::middleware::{self, Next};
use axum::response::Response;
use firenook_console_front::{ObserveConsole, Shutdown};
use firenook_core_store::Store;
use firenook_functions_bridge::{FunctionsInventory, TriggerRegistry};
use firenook_functions_runtime::LogEvent;
use firenook_functions_runtime::monitor::structured;
use firenook_rules_runtime::{
    Denial, DenialOrigin, RequestOperation, RulesEvent, RulesOrigin, RulesRuntime,
};
use firenook_suite_front::{
    Audience, DEMO_TOKEN_PATH, EntityRef, LogInput, LogLevel, LoggingRuntime, OverviewConnection,
    OverviewEngineConfig, OverviewEngineDetails, OverviewEnvSource, OverviewEnvVariable,
    OverviewNotice, OverviewNoticeLevel, SnapshotPort, kinds,
};
use serde_json::{Value, json};
use time::format_description::well_known::Rfc3339;
use tokio::sync::broadcast;
use tokio::sync::broadcast::error::RecvError;
use tokio::time::Instant;

use super::{FunctionsConsoleOptions, HookContext};
use crate::{ServiceSelection, SuiteConfig};

/// Denials logged one by one per second, per origin; the rest are counted
/// and summed up once a second.
const DENIALS_PER_SECOND: u32 = 50;
/// How often the denials held back are summed up.
const SUMMARY_EVERY: Duration = Duration::from_secs(1);

/// Logs' and the Overview's console: the suite's log, with the console log
/// `prepare_logging` installed in it, and how the engine was started.
pub(crate) fn observe_console(context: &HookContext<'_>) -> ObserveConsole {
    let demo_credentials = std::env::var_os("GOOGLE_APPLICATION_CREDENTIALS")
        .map(std::path::PathBuf::from)
        .and_then(|path| demo_credentials(&path));
    let console = ObserveConsole::over(context.logging).with_overview(
        engine_details(context.config, demo_credentials),
        notices(context.config),
    );
    match snapshot_port(context) {
        Some(port) => console.with_snapshots(port),
        None => console,
    }
}

/// What the snapshot download needs from the suite: the exporter, a
/// staging folder beside the state directory (or under the project's
/// `.firenook` folder when that one overlaps the state or the seed), the
/// free space there and the size an export writes. `None` without the
/// suite's exporter.
pub(crate) fn snapshot_port(context: &HookContext<'_>) -> Option<SnapshotPort> {
    let exporter = context.exporter?.clone();
    let config = context.config.clone();
    let services = config.services;
    let targets: Vec<String> = [
        ("firestore", services.firestore),
        ("auth", services.auth),
        ("storage", services.storage),
    ]
    .into_iter()
    .filter(|(_, runs)| *runs)
    .map(|(name, _)| name.to_owned())
    .collect();
    let store = context.store.cloned();
    let project = config.project_id.clone();
    Some(SnapshotPort {
        exporter,
        staging: Arc::new(move || snapshot_staging(&config)),
        free_space: Arc::new(free_space),
        size: Arc::new(move |targets: &std::collections::BTreeSet<String>| {
            // Firestore's logical bytes: the bulk of nearly every export.
            store
                .as_ref()
                .filter(|_| targets.contains("firestore"))
                .map_or(0, |store| {
                    store.snapshot().logical_memory_usage().logical_bytes
                })
        }),
        targets,
        project,
    })
}

/// A fresh staging folder for a snapshot: beside the state directory, or
/// under `<project dir>/.firenook/snapshots`. While the engine resumes its
/// state from an import seed, each is checked never to nest in or hold the
/// state directory or the seed, as every export is then.
pub(crate) fn snapshot_staging(config: &SuiteConfig) -> Result<std::path::PathBuf, String> {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_nanos());
    let name = format!(".firenook-snapshot-{}-{nanos}", std::process::id());
    let candidates = [
        config.state_dir.parent().map(|parent| parent.join(&name)),
        Some(
            config
                .project_dir
                .join(".firenook")
                .join("snapshots")
                .join(&name),
        ),
    ];
    let mut refusal = String::from("no folder to stage it in");
    for candidate in candidates.into_iter().flatten() {
        if candidate.starts_with(&config.state_dir) {
            continue;
        }
        if !config.resume_state {
            return Ok(candidate);
        }
        match crate::native_state::validate_export_destination(config, &candidate) {
            Ok(()) => return Ok(candidate),
            Err(error) => refusal = error.to_string(),
        }
    }
    Err(refusal)
}

/// Bytes free on the volume holding `path` (its nearest existing folder).
#[cfg(unix)]
pub(crate) fn free_space(path: &std::path::Path) -> Option<u64> {
    let existing = path.ancestors().find(|ancestor| ancestor.exists())?;
    let stats = rustix::fs::statvfs(existing).ok()?;
    Some(stats.f_bavail.saturating_mul(stats.f_frsize))
}

/// Other platforms report the export's own I/O error instead.
#[cfg(not(unix))]
pub(crate) fn free_space(_path: &std::path::Path) -> Option<u64> {
    None
}

/// The engine's configuration and what an app needs to reach it.
/// `credentials` is the demo credentials file `emulators:exec` hands its
/// command, when the engine was given one (its path and content).
pub(crate) fn engine_details(
    config: &SuiteConfig,
    credentials: Option<(String, String)>,
) -> OverviewEngineDetails {
    let shown = |path: &std::path::Path| path.display().to_string();
    OverviewEngineDetails {
        config: Some(OverviewEngineConfig {
            host: config.host.clone(),
            connect_host: config.connect_host(),
            project_dir: shown(&config.project_dir),
            firebase_json: shown(&config.firebase_json),
            diagnostics: config.diagnostics,
            debug_log: config.debug_log.as_deref().map(shown),
            single_project_mode: config.single_project_mode,
            offline: config.offline,
            demo_project: config.is_demo_project(),
            node: shown(&config.node),
            default_bucket: config.default_bucket.clone(),
            selected: if config.services == ServiceSelection::ALL {
                Vec::new()
            } else {
                config
                    .services
                    .names()
                    .into_iter()
                    .map(str::to_owned)
                    .collect()
            },
        }),
        connection: OverviewConnection {
            env: connection_env(config, credentials),
        },
    }
}

/// The environment variables the SDKs read, for the running services:
/// those `firenook emulators:exec` sets for its command (the npm CLI's
/// `execEnvironment`), which are the official `emulators:exec`'s set, and
/// the demo credentials Firenook adds. Functions workers get them too.
pub(crate) fn connection_env(
    config: &SuiteConfig,
    credentials: Option<(String, String)>,
) -> Vec<OverviewEnvVariable> {
    let services = &config.services;
    let address = |port: u16| config.endpoint(port);
    let variable =
        |name: &str, value: String, service: &str, set_by: OverviewEnvSource| OverviewEnvVariable {
            name: name.to_owned(),
            value,
            service: service.to_owned(),
            set_by,
            note: None,
        };
    let exec = OverviewEnvSource::Exec;
    let project = &config.project_id;
    let mut env = vec![
        variable("GCLOUD_PROJECT", project.clone(), "project", exec),
        variable("GOOGLE_CLOUD_PROJECT", project.clone(), "project", exec),
        // The official runScript's, in its key order, unless the
        // environment has one: the bucket named after the project, not the
        // engine's default bucket.
        OverviewEnvVariable {
            note: Some("unless your environment sets it".to_owned()),
            ..variable(
                "FIREBASE_CONFIG",
                format!(
                    "{{\"projectId\":{},\"storageBucket\":{},\"databaseURL\":{}}}",
                    Value::String(project.clone()),
                    Value::String(format!("{project}.appspot.com")),
                    Value::String(format!("https://{project}.firebaseio.com")),
                ),
                "project",
                exec,
            )
        },
    ];
    if services.firestore {
        for name in [
            "FIRESTORE_EMULATOR_HOST",
            "FIREBASE_FIRESTORE_EMULATOR_ADDRESS",
        ] {
            env.push(variable(
                name,
                address(config.ports.firestore),
                "firestore",
                exec,
            ));
        }
    }
    if services.auth {
        env.push(variable(
            "FIREBASE_AUTH_EMULATOR_HOST",
            address(config.ports.auth),
            "auth",
            exec,
        ));
    }
    if services.storage {
        env.push(variable(
            "FIREBASE_STORAGE_EMULATOR_HOST",
            address(config.ports.storage),
            "storage",
            exec,
        ));
        env.push(variable(
            "STORAGE_EMULATOR_HOST",
            config.origin(config.ports.storage),
            "storage",
            exec,
        ));
    }
    env.push(variable(
        "FIREBASE_EMULATOR_HUB",
        address(config.ports.hub),
        "hub",
        exec,
    ));
    if services.pubsub {
        env.push(variable(
            "PUBSUB_EMULATOR_HOST",
            address(config.ports.pubsub),
            "pubsub",
            exec,
        ));
    }
    if services.functions {
        env.push(variable(
            "CLOUD_TASKS_EMULATOR_HOST",
            address(config.ports.tasks),
            "tasks",
            exec,
        ));
        env.push(variable(
            "CLOUD_EVENTARC_EMULATOR_HOST",
            config.origin(config.ports.eventarc),
            "eventarc",
            exec,
        ));
    }
    if let Some((path, content)) = credentials {
        env.push(OverviewEnvVariable {
            note: Some(content),
            ..variable("GOOGLE_APPLICATION_CREDENTIALS", path, "project", exec)
        });
    }
    env
}

/// The demo credentials file at `path` (its path and compact content),
/// when it is the stub `emulators:exec` writes: the emulators' own token,
/// and a hub's [`DEMO_TOKEN_PATH`] to refresh it from. Any other file is a
/// developer's real credentials and is never shown.
pub(crate) fn demo_credentials(path: &std::path::Path) -> Option<(String, String)> {
    let text = std::fs::read_to_string(path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    let demo = value["type"] == "authorized_user"
        && value["client_id"] == "demo"
        && value["client_secret"] == "demo"
        && value["refresh_token"] == "demo"
        && value["token"] == "owner"
        && value["expiry"].is_string()
        && value["token_uri"]
            .as_str()
            .is_some_and(|url| url.starts_with("http://") && url.ends_with(DEMO_TOKEN_PATH))
        && value.as_object().is_some_and(|fields| fields.len() == 7);
    demo.then(|| (path.display().to_string(), value.to_string()))
}

/// The configuration notices the Overview keeps showing: the facts the
/// startup banner warns about once.
pub(crate) fn notices(config: &SuiteConfig) -> Vec<OverviewNotice> {
    let notice = |level, code: &str, message: String| OverviewNotice {
        level,
        code: code.to_owned(),
        message,
    };
    let mut notices = Vec::new();
    if !config.is_demo_project() {
        notices.push(notice(
            OverviewNoticeLevel::Warn,
            "nonDemoProject",
            format!(
                "Project ID \"{}\" is not a demo project. The emulators never contact Firebase, but code that builds its own clients with real credentials can still reach the real project; a project ID starting with demo- rules that out.",
                config.project_id
            ),
        ));
        let missing = config.services.missing();
        if config.services.functions && !missing.is_empty() {
            notices.push(notice(
                OverviewNoticeLevel::Warn,
                "missingEmulators",
                format!(
                    "Functions run without these emulators, so calls your functions make to them reach production: {}.",
                    missing.join(", ")
                ),
            ));
        }
    }
    if !crate::is_loopback(&config.host) {
        notices.push(notice(
            OverviewNoticeLevel::Warn,
            "publicHost",
            format!(
                "The emulators listen on {} and have no authentication: every service, its data and Functions execution are reachable from any device that can reach this machine.",
                config.host
            ),
        ));
    }
    if !config.diagnostics {
        notices.push(notice(
            OverviewNoticeLevel::Info,
            "diagnosticsOff",
            "Diagnostics are off (--no-diagnostics), so the rules pages show no requests and no coverage.".to_owned(),
        ));
    }
    notices
}

/// The suite's services are prepared; the console is not built yet. From
/// here every Firestore rules denial, every ruleset taking effect and every
/// background triggers switch becomes a line in the console log, until the
/// suite stops.
pub(crate) fn prepared(context: &HookContext<'_>) {
    let Some(shutdown) = context.shutdown else {
        return;
    };
    if let Some(rules) = context.firestore_rules {
        spawn_denial_log(
            rules.subscribe_denials(),
            RulesFiles::new(context.config, rules),
            context.logging,
            shutdown,
        );
        spawn_rules_applied_log(rules, context.logging, shutdown);
    }
    spawn_background_log(context.triggers, context.logging, shutdown);
}

/// The Functions runtime is about to start. Its log events reach the
/// console through compute's one Functions sink
/// (`console_wiring::compute::functions_log`), which emits each through
/// [`functions_input`]; nothing to add here.
pub(crate) fn functions_options(
    _context: &HookContext<'_>,
    _options: &mut FunctionsConsoleOptions,
) {
}

/// Every service has started.
pub(crate) fn ready(_context: &HookContext<'_>) {}

/// The suite is stopping (see `before_finish` in `mod.rs` for the order).
#[allow(
    clippy::unused_async,
    reason = "the stream awaits its own stop work here"
)]
pub(crate) async fn before_finish(_context: &HookContext<'_>) {}

/// Functions reloaded and routing was refreshed for the inventory.
pub(crate) fn inventory_refreshed(_context: &HookContext<'_>, _inventory: &FunctionsInventory) {}

/// One Functions log event as the console log takes it, and as the
/// official feed has always recorded it.
///
/// The console gets the line's real level, its message without the label,
/// the function, invocation and codebase the runtime attributed it to, its
/// kind, and links to what it is about. A `firebase-functions/logger` entry
/// (compute's one parser) reads as its severity, its message and the rest of
/// its fields as the payload; a lifecycle line's facts (`event.detail`) are
/// its payload.
///
/// The official record, the debug-log line and the terminal stay what they
/// were: `<label>: <line>` once per printed line, at the level of the stream
/// the line was written to (`INFO` for stdout, `WARN` for stderr) or the
/// runtime's own, filed under `functions`, plus the function's name and the
/// payload the official emulator's records carry. A line with no
/// counterpart in the official emulator's output (`detail.consoleOnly`) is
/// the console's alone.
pub(crate) fn functions_input(event: &LogEvent) -> LogInput {
    let label = event.label.as_str();
    let service = if label == "eventarc" {
        "eventarc"
    } else {
        "functions"
    };
    let extension = label
        .strip_prefix("extensions[")
        .and_then(|rest| rest.strip_suffix(']'))
        .filter(|id| !id.is_empty())
        .map(str::to_owned);
    let structured = event
        .message
        .starts_with('{')
        .then(|| structured::parse(&event.message))
        .flatten();
    let (level, message, payload) = match structured {
        Some(line) => (
            LogLevel::parse(&line.severity),
            line.message,
            (!line.fields.is_empty()).then_some(Value::Object(line.fields)),
        ),
        None => (
            LogLevel::parse(&event.level),
            event.message.clone(),
            lifecycle_payload(event.detail.as_ref()),
        ),
    };
    // Only kinds the console declares; the worker's own (`function.error`,
    // `worker.uncaught`) are error lines, problems by their level.
    let kind = event.kind.and_then(kinds::info).map(|info| info.kind);
    let floor = kind_level(kind);
    let mut refs = Vec::new();
    if let Some(function) = &event.function {
        refs.push(EntityRef::function(function));
    }
    if let Some(execution) = &event.execution {
        refs.push(EntityRef::invocation(execution));
    }
    if let Some(id) = &extension {
        refs.push(EntityRef::extension_instance(id));
    }
    if let Some(cause) = event.detail.as_ref().and_then(|detail| detail.get("cause")) {
        refs.extend(cause_refs(cause, event.function.as_deref()));
    }
    // A worker's line as its output was read, one per line; the runtime's
    // own text one per line too, as the official emulator prints it.
    let printed: Vec<&str> = if event.stream.is_some() || event.is_console_only() {
        event.terminal_lines()
    } else {
        event.message.lines().collect()
    };
    let legacy_text = printed
        .iter()
        .map(|line| format!("{label}: {line}"))
        .collect::<Vec<_>>()
        .join("\n");
    LogInput {
        level: if floor > level { floor } else { level },
        service: service.to_owned(),
        source: (label != service).then(|| label.to_owned()),
        function: event.function.clone(),
        extension,
        codebase: event.codebase.clone(),
        execution: event.execution.clone(),
        kind,
        message,
        payload,
        refs,
        audience: if event.is_console_only() {
            Audience::Console
        } else {
            Audience::Everyone
        },
        legacy_text: Some(if legacy_text.is_empty() {
            format!("{label}: ")
        } else {
            legacy_text
        }),
        legacy_level: Some(legacy_level(event.terminal_level())),
        legacy_emulator: Some("functions"),
    }
}

/// A lifecycle line's facts as its payload, without the engine's own
/// `consoleOnly` flag; nothing when it has none.
fn lifecycle_payload(detail: Option<&Value>) -> Option<Value> {
    let Value::Object(fields) = detail? else {
        return None;
    };
    let fields: serde_json::Map<String, Value> = fields
        .iter()
        .filter(|(key, _)| key.as_str() != "consoleOnly")
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    (!fields.is_empty()).then_some(Value::Object(fields))
}

/// The least level a lifecycle kind is shown at: a failure is at least a
/// warning, a function that could not run an error.
fn kind_level(kind: Option<&str>) -> LogLevel {
    match kind {
        Some(kinds::FUNCTION_FAILED | kinds::FUNCTION_UNKNOWN) => LogLevel::Warn,
        Some(
            kinds::FUNCTION_TIMEOUT
            | kinds::FUNCTION_CRASHED
            | kinds::WORKER_FAILED
            | kinds::EVENTARC_FAILED,
        ) => LogLevel::Error,
        _ => LogLevel::Debug,
    }
}

/// Links to what caused an invocation (compute's `InvocationCause`, as the
/// start line's `detail.cause` carries it): the document, object, user,
/// message, schedule, event or Auth call.
fn cause_refs(cause: &Value, function: Option<&str>) -> Vec<EntityRef> {
    let text = |key: &str| cause.get(key).and_then(Value::as_str);
    let user = || text("uid").map(|uid| EntityRef::auth_user(text("tenant"), uid));
    let mut refs = Vec::new();
    match text("type").unwrap_or_default() {
        "firestore" => {
            if let (Some(database), Some(document)) = (text("database"), text("document")) {
                refs.push(EntityRef::firestore_document(database, document));
            }
        }
        "storage" => {
            if let (Some(bucket), Some(object)) = (text("bucket"), text("object")) {
                refs.push(EntityRef::storage_object(bucket, object));
            }
        }
        "auth" | "callable" => refs.extend(user()),
        "pubsub" => {
            if let Some(topic) = text("topic") {
                if let Some(id) = text("messageId") {
                    refs.push(EntityRef::pubsub_message(topic, id));
                }
                refs.push(EntityRef::pubsub_topic(topic));
            }
        }
        "schedule" => refs.extend(function.map(EntityRef::pubsub_schedule)),
        "eventarc" => {
            refs.extend(text("event").map(EntityRef::eventarc_event));
            refs.extend(text("channel").map(EntityRef::eventarc_channel));
        }
        "blocking" => {
            refs.extend(text("authCall").map(EntityRef::auth_call));
            refs.extend(user());
        }
        _ => {}
    }
    refs
}

/// A startup "<service> configured at <address>" line: engine bookkeeping
/// (`engine.configured`), which the console's feed leaves out unless asked.
pub(crate) fn configured_input(message: String) -> LogInput {
    LogInput {
        level: LogLevel::Info,
        service: "hub".to_owned(),
        kind: Some(kinds::ENGINE_CONFIGURED),
        message,
        legacy_level: Some("INFO"),
        ..LogInput::default()
    }
}

/// A startup banner line; a warning in it is an `engine.notice`.
pub(crate) fn banner_input(level: &'static str, message: String) -> LogInput {
    let level_read = LogLevel::parse(level);
    LogInput {
        level: level_read,
        service: "hub".to_owned(),
        kind: (level_read >= LogLevel::Warn).then_some(kinds::ENGINE_NOTICE),
        message,
        legacy_level: Some(level),
        ..LogInput::default()
    }
}

/// A rules file watcher line about `service`'s rules: a reload
/// (`rules.reloaded`) or a file that could not be read or did not compile
/// (`rules.fileError` for Firestore, `storage.rules` for Storage).
pub(crate) fn rules_file_input(service: &'static str, problem: bool, message: String) -> LogInput {
    let kind = match (service, problem) {
        ("storage", true) => Some(kinds::STORAGE_RULES),
        ("storage", false) => None,
        (_, true) => Some(kinds::RULES_FILE_ERROR),
        (_, false) => Some(kinds::RULES_RELOADED),
    };
    LogInput {
        level: if problem {
            LogLevel::Warn
        } else {
            LogLevel::Info
        },
        service: service.to_owned(),
        kind,
        message,
        legacy_level: Some(if problem { "WARN" } else { "INFO" }),
        ..LogInput::default()
    }
}

/// The level an event carried, as the official feed has always written it.
fn legacy_level(level: &str) -> &'static str {
    match level {
        "DEBUG" => "DEBUG",
        "INFO" => "INFO",
        "WARN" => "WARN",
        "ERROR" => "ERROR",
        other => LogLevel::parse(other).legacy(),
    }
}

/// `get`, `list`, `create`, `update`, `delete`.
const fn operation_name(operation: RequestOperation) -> &'static str {
    match operation {
        RequestOperation::Get => "get",
        RequestOperation::List => "list",
        RequestOperation::Create => "create",
        RequestOperation::Update => "update",
        RequestOperation::Delete => "delete",
    }
}

/// One refused request as a console line: `rules.denied` (a warning, a
/// problem) for an app's request, `rules.denied.console` (info, never a
/// problem) for one the console made while viewing as someone.
/// Which configured rules file a denial's lines refer to: the database's
/// own `firebase.json` entry, or the entry that governs the databases it
/// does not list, while the rules in force came from that file (at start-up
/// or reloaded from it) rather than the console's editor or the reload
/// route.
#[derive(Clone, Default)]
pub(crate) struct RulesFiles {
    rules: Option<RulesRuntime>,
    project: String,
    /// Each listed database with rules, and its file as the log names it.
    files: Vec<(String, String)>,
    /// The file governing the databases `firebase.json` does not list.
    unlisted: Option<String>,
}

impl RulesFiles {
    pub(crate) fn new(config: &SuiteConfig, rules: &RulesRuntime) -> Self {
        let project_dir = std::fs::canonicalize(&config.project_dir)
            .unwrap_or_else(|_| config.project_dir.clone());
        let shown = |path: &std::path::Path| {
            let path = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_owned());
            path.strip_prefix(&project_dir)
                .unwrap_or(&path)
                .display()
                .to_string()
        };
        Self {
            rules: Some(rules.clone()),
            project: config.project_id.clone(),
            files: config
                .firestore_databases
                .iter()
                .filter_map(|entry| Some((entry.database_id.clone(), shown(entry.rules.as_ref()?))))
                .collect(),
            unlisted: crate::stand_in(&config.firestore_databases)
                .and_then(|entry| entry.rules.as_deref())
                .map(shown),
        }
    }

    /// The file whose lines `database`'s rules are, when they came from it.
    fn file(&self, database: &firenook_core_store::DatabaseName) -> Option<&str> {
        let version = self.rules.as_ref()?.current_version(database)?;
        if database.project_id() != self.project
            || !matches!(version.origin, RulesOrigin::Startup | RulesOrigin::File)
        {
            return None;
        }
        self.files
            .iter()
            .find(|(id, _)| id == database.database_id())
            .map(|(_, file)| file.as_str())
            .or(self.unlisted.as_deref())
    }
}

/// Where in the rules a denial was decided, as ` at firestore.rules:4`:
/// each allow that refused it, by file and line when the file is known, by
/// line otherwise; `: no allow statement matches` when none applied.
fn refused_at(denial: &Denial, file: Option<&str>) -> String {
    let mut lines: Vec<usize> = Vec::new();
    for refusal in &denial.refused_by {
        if !lines.contains(&refusal.line) {
            lines.push(refusal.line);
        }
    }
    if lines.is_empty() {
        return if denial.error.is_some() {
            String::new()
        } else {
            ": no allow statement matches".to_owned()
        };
    }
    let places = lines
        .iter()
        .map(|line| file.map_or_else(|| format!("line {line}"), |file| format!("{file}:{line}")))
        .collect::<Vec<_>>();
    format!(" at {}", places.join(", "))
}

pub(crate) fn denial_input(denial: &Denial, file: Option<&str>) -> LogInput {
    let operation = operation_name(denial.operation);
    let path = denial.relative_path();
    let database = denial.database.database_id();
    let who = denial
        .uid
        .as_deref()
        .map_or_else(|| "an unauthenticated client".to_owned(), str::to_owned);
    let at = refused_at(denial, file);
    let reason = denial
        .error
        .as_deref()
        .map(|error| format!(": {error}"))
        .unwrap_or_default();
    let (kind, level, message) = match denial.origin {
        DenialOrigin::App => (
            kinds::RULES_DENIED,
            LogLevel::Warn,
            format!("Rules denied {operation} on {path} for {who}{at}{reason}"),
        ),
        DenialOrigin::Console => (
            kinds::RULES_DENIED_CONSOLE,
            LogLevel::Info,
            format!(
                "Rules denied {operation} on {path} from the console (viewing as {who}){at}{reason}"
            ),
        ),
    };
    let mut refs = vec![if denial.operation == RequestOperation::List {
        EntityRef::firestore_collection(database, path)
    } else {
        EntityRef::firestore_document(database, path)
    }];
    if let Some(request) = &denial.request_id {
        refs.push(EntityRef::firestore_decision(database, request));
    }
    LogInput {
        level,
        service: "firestore".to_owned(),
        kind: Some(kind),
        message,
        payload: Some(json!({
            "method": operation,
            "path": path,
            "database": database,
            "uid": denial.uid,
            "requestId": denial.request_id.as_deref(),
            "origin": denial.origin.as_str(),
            "lines": denial.refused_by.iter().map(|refusal| refusal.line).collect::<Vec<_>>(),
            "rulesFile": file,
        })),
        refs,
        audience: Audience::Console,
        ..LogInput::default()
    }
}

/// How many denials of one origin may be logged now: a bucket of
/// [`DENIALS_PER_SECOND`] tokens, refilled continuously, and how many were
/// held back since the last summary.
struct Bucket {
    tokens: f64,
    filled: Instant,
    held: u64,
}

impl Bucket {
    fn new(now: Instant) -> Self {
        Self {
            tokens: f64::from(DENIALS_PER_SECOND),
            filled: now,
            held: 0,
        }
    }

    /// Takes a token; false (and one more held back) when there is none.
    fn take(&mut self, now: Instant) -> bool {
        let rate = f64::from(DENIALS_PER_SECOND);
        let elapsed = now.saturating_duration_since(self.filled).as_secs_f64();
        self.tokens = (self.tokens + elapsed * rate).min(rate);
        self.filled = now;
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            true
        } else {
            self.held += 1;
            false
        }
    }
}

/// The line for the denials of `origin` held back in the last second.
fn held_back_input(origin: DenialOrigin, held: u64) -> LogInput {
    let (kind, level) = match origin {
        DenialOrigin::App => (kinds::RULES_DENIED, LogLevel::Warn),
        DenialOrigin::Console => (kinds::RULES_DENIED_CONSOLE, LogLevel::Info),
    };
    let message = if held == 1 {
        "1 more denial in the last second was not logged one by one".to_owned()
    } else {
        format!("{held} more denials in the last second were not logged one by one")
    };
    LogInput {
        level,
        service: "firestore".to_owned(),
        kind: Some(kind),
        message,
        payload: Some(json!({ "held": held, "origin": origin.as_str() })),
        audience: Audience::Console,
        ..LogInput::default()
    }
}

/// Logs every Firestore rules denial from `denials` until the suite stops:
/// at most [`DENIALS_PER_SECOND`] lines a second per origin, then one line
/// a second summing up the rest, and one line when the log fell behind the
/// tap and denials were lost.
pub(crate) fn spawn_denial_log(
    mut denials: broadcast::Receiver<Arc<Denial>>,
    files: RulesFiles,
    logging: &LoggingRuntime,
    shutdown: &Shutdown,
) {
    let logging = logging.clone();
    let stopped = shutdown.clone().stopped();
    tokio::spawn(async move {
        tokio::pin!(stopped);
        let mut buckets: HashMap<DenialOrigin, Bucket> = HashMap::new();
        let mut summary = tokio::time::interval_at(Instant::now() + SUMMARY_EVERY, SUMMARY_EVERY);
        summary.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                biased;
                () = &mut stopped => break,
                received = denials.recv() => match received {
                    Ok(denial) => {
                        let now = Instant::now();
                        let bucket = buckets
                            .entry(denial.origin)
                            .or_insert_with(|| Bucket::new(now));
                        if bucket.take(now) {
                            logging.emit(denial_input(&denial, files.file(&denial.database)));
                        }
                    }
                    Err(RecvError::Lagged(missed)) => logging.emit(LogInput {
                        level: LogLevel::Warn,
                        service: "firestore".to_owned(),
                        message: format!(
                            "{missed} Firestore rules {} not logged: the console's log fell behind the rules engine",
                            if missed == 1 { "denial was" } else { "denials were" }
                        ),
                        payload: Some(json!({ "missed": missed })),
                        audience: Audience::Console,
                        ..LogInput::default()
                    }),
                    Err(RecvError::Closed) => break,
                },
                _ = summary.tick() => {
                    for (origin, bucket) in &mut buckets {
                        if bucket.held > 0 {
                            logging.emit(held_back_input(*origin, bucket.held));
                            bucket.held = 0;
                        }
                    }
                }
            }
        }
    });
}

/// The line for a ruleset that took effect, when the console log shows one:
/// from the console's editor, or from the emulator's reload route (rules
/// unit testing). Startup rules are not news, and a file reload is the
/// rules watcher's own line (`rules.reloaded`, naming the database).
pub(crate) fn rules_applied_input(origin: RulesOrigin) -> Option<LogInput> {
    let (message, source) = match origin {
        RulesOrigin::Startup | RulesOrigin::File => return None,
        RulesOrigin::Console => ("Firestore rules applied from the console", "console"),
        RulesOrigin::Reload => (
            "Firestore rules applied through the emulator's reload route (rules unit testing)",
            "api",
        ),
    };
    Some(LogInput {
        level: LogLevel::Info,
        service: "firestore".to_owned(),
        kind: Some(kinds::RULES_APPLIED),
        message: message.to_owned(),
        payload: Some(json!({ "origin": source })),
        audience: Audience::Console,
        ..LogInput::default()
    })
}

/// Logs each ruleset that takes effect in `rules` until the suite stops.
fn spawn_rules_applied_log(rules: &RulesRuntime, logging: &LoggingRuntime, shutdown: &Shutdown) {
    let mut events = rules.subscribe();
    let logging = logging.clone();
    let stopped = shutdown.clone().stopped();
    tokio::spawn(async move {
        tokio::pin!(stopped);
        loop {
            tokio::select! {
                biased;
                () = &mut stopped => break,
                event = events.recv() => match event {
                    Ok(RulesEvent::Installed { origin }) => {
                        if let Some(input) = rules_applied_input(origin) {
                            logging.emit(input);
                        }
                    }
                    Ok(RulesEvent::FileChecked { .. }) | Err(RecvError::Lagged(_)) => {}
                    Err(RecvError::Closed) => break,
                },
            }
        }
    });
}

/// The marker for background triggers switching, from the hub's switch or
/// the console's.
pub(crate) fn background_input(enabled: bool, since: Option<&str>) -> LogInput {
    LogInput {
        level: if enabled {
            LogLevel::Info
        } else {
            LogLevel::Warn
        },
        service: "hub".to_owned(),
        kind: Some(kinds::HUB_BACKGROUND_TRIGGERS),
        message: if enabled {
            "Background triggers resumed".to_owned()
        } else {
            "Background triggers paused: events are dropped, not queued, until they are resumed"
                .to_owned()
        },
        payload: Some(json!({ "enabled": enabled, "since": since })),
        audience: Audience::Console,
        ..LogInput::default()
    }
}

/// Logs one marker per background triggers switch until the suite stops.
fn spawn_background_log(triggers: &TriggerRegistry, logging: &LoggingRuntime, shutdown: &Shutdown) {
    let mut switches = triggers.background_watch();
    // Read now, so a switch made before the task first runs is still news.
    let mut enabled = *switches.borrow_and_update();
    let triggers = triggers.clone();
    let logging = logging.clone();
    let stopped = shutdown.clone().stopped();
    tokio::spawn(async move {
        tokio::pin!(stopped);
        loop {
            tokio::select! {
                biased;
                () = &mut stopped => break,
                changed = switches.changed() => {
                    if changed.is_err() {
                        break;
                    }
                    let now = *switches.borrow_and_update();
                    if now == enabled {
                        continue;
                    }
                    enabled = now;
                    let since = (!now)
                        .then(|| triggers.dropped().since)
                        .flatten()
                        .and_then(|since| since.format(&Rfc3339).ok());
                    logging.emit(background_input(now, since.as_deref()));
                }
            }
        }
    });
}

/// The official clear route: `DELETE
/// /emulator/v1/projects/{project}/databases/{database}/documents`; the
/// database it names.
fn cleared_database(method: &Method, path: &str) -> Option<String> {
    if method != Method::DELETE {
        return None;
    }
    let rest = path.strip_prefix("/emulator/v1/projects/")?;
    let (_project, rest) = rest.split_once("/databases/")?;
    let database = rest.strip_suffix("/documents")?;
    (!database.is_empty() && !database.contains('/')).then(|| database.to_owned())
}

/// The marker for a database the official clear route emptied.
pub(crate) fn cleared_input(database: &str, documents: u64) -> LogInput {
    let removed = match documents {
        1 => "1 document".to_owned(),
        count => format!("{count} documents"),
    };
    LogInput {
        level: LogLevel::Info,
        service: "firestore".to_owned(),
        kind: Some(kinds::FIRESTORE_CLEARED),
        message: format!(
            "Firestore database {database} cleared through the emulator's clear route: {removed} removed"
        ),
        payload: Some(json!({ "database": database, "documents": documents })),
        audience: Audience::Console,
        ..LogInput::default()
    }
}

/// `router` (the Firestore HTTP routes), with the official clear route
/// logged: after a successful `DELETE …/databases/{database}/documents`, a
/// `firestore.cleared` marker with the documents the store lost meanwhile.
pub(crate) fn firestore_cleared_layer(
    router: Router,
    logging: &LoggingRuntime,
    store: &Store,
) -> Router {
    let logging = logging.clone();
    let store = store.clone();
    router.layer(middleware::from_fn(move |request: Request, next: Next| {
        let logging = logging.clone();
        let store = store.clone();
        async move {
            let Some(database) = cleared_database(request.method(), request.uri().path()) else {
                return next.run(request).await;
            };
            let before = store.snapshot().logical_memory_usage().entries;
            let response: Response = next.run(request).await;
            if response.status().is_success() {
                let after = store.snapshot().logical_memory_usage().entries;
                logging.emit(cleared_input(&database, before.saturating_sub(after)));
            }
            response
        }
    }))
}

#[cfg(test)]
#[path = "observe_tests.rs"]
mod tests;
