//! What the monitor records, in the shapes the console reads.
//!
//! These are the hot-path types: defined where they are produced, so the
//! runtime never builds a console type on the dispatch path. Every exported
//! type derives `ts_rs::TS` into `generated/compute/` (the console-front
//! compute module writes the files) and serializes in camelCase. `u64`
//! fields are TypeScript numbers, arbitrary JSON is `unknown`, and every
//! timestamp is an RFC 3339 string in UTC with millisecond precision
//! ([`format_timestamp`]). None of them holds a console link: the console
//! wraps them where it needs one.

use std::collections::BTreeMap;
use std::time::SystemTime;

use serde::Serialize;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use ts_rs::TS;

/// Formats an instant the way every monitor timestamp is written:
/// RFC 3339 in UTC with exactly three fractional digits, as JavaScript's
/// `Date.prototype.toISOString` writes it (`2026-10-12T14:02:11.093Z`).
#[must_use]
pub fn format_timestamp(at: SystemTime) -> String {
    let datetime = OffsetDateTime::from(at);
    let millis = datetime.millisecond();
    let whole = datetime.replace_nanosecond(0).unwrap_or(datetime);
    let base = whole.format(&Rfc3339).unwrap_or_default();
    format!("{}.{millis:03}Z", base.trim_end_matches('Z'))
}

/// Whether the Functions runtime has finished starting. (Absent is the
/// foundation's section status, not a monitor state.)
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub enum FunctionsPhase {
    /// Discovering codebases and warming their workers.
    #[default]
    Starting,
    /// Every codebase was loaded once (successfully or not) and the warm-ups ran.
    Running,
}

/// Whether a codebase is the project's own code or an Extension instance.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub enum FunctionCodebaseKind {
    User,
    Extension,
}

/// Where a codebase's last load stands.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub enum FunctionLoadState {
    Loading,
    Ready,
    Failed,
}

/// A codebase's Node worker. `stopped` is the normal state between a reload
/// and the next call ("Starts on the next call").
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub enum FunctionWorkerState {
    Starting,
    Running,
    Exited,
    Stopped,
    Failed,
}

/// One codebase or extension instance as the runtime serves it.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub struct FunctionCodebase {
    /// The codebase id from firebase.json, or the extension instance id.
    pub id: String,
    pub kind: FunctionCodebaseKind,
    /// The source directory, relative to the project directory when inside it.
    pub directory: String,
    /// The Node runtime the codebase declares, for example nodejs22.
    pub runtime: Option<String>,
    pub state: FunctionLoadState,
    /// A reload failed and the functions shown are from the previous load.
    pub serving_previous: bool,
    pub error: Option<FunctionLoadError>,
    /// Completed loads since start; 1 after the first.
    pub loads: u32,
    pub loaded_at: Option<String>,
    pub load_ms: Option<f64>,
    pub loading_since: Option<String>,
    pub function_count: u32,
    /// Endpoints the manifest declares that the emulator dropped at load.
    pub not_loaded: Vec<FunctionNotLoaded>,
    /// The dotenv files the last load read, in precedence order.
    pub env_files: Vec<String>,
    pub last_change: Option<FunctionRegistryDiff>,
    /// The running code may not be the code on disk.
    pub stale: Option<FunctionStale>,
    pub worker: FunctionWorker,
}

/// Why a load failed: the first line, and the rest (the SDK's own output).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub struct FunctionLoadError {
    pub message: String,
    /// The rest of the output, with the project directory written as `.`.
    pub detail: Option<String>,
    pub at: String,
}

/// What a reload changed, by function id. Empty lists for a reload that
/// changed nothing.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub struct FunctionRegistryDiff {
    pub added: Vec<String>,
    pub removed: Vec<String>,
    pub changed: Vec<String>,
}

/// An endpoint the manifest declares that the emulator does not serve.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub struct FunctionNotLoaded {
    pub id: String,
    pub event_type: String,
    /// In words, for example "google.firebase.foo.v1.bar is not emulated".
    pub reason: String,
}

/// Why the running code may not be the code on disk.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(
    tag = "reason",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export_to = "compute/")]
pub enum FunctionStale {
    /// TypeScript sources newer than the compiled entry after a load.
    SourcesNewer { changed_at: String },
    /// An env or .secret.local file changed after the last load.
    EnvChanged { file: String, changed_at: String },
}

/// The codebase's Node worker.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub struct FunctionWorker {
    pub state: FunctionWorkerState,
    pub pid: Option<u32>,
    pub node: Option<String>,
    pub started_at: Option<String>,
    pub start_ms: Option<f64>,
    pub restarts: u32,
    /// For example "exited with code 1 at 14:02:11".
    pub last_exit: Option<String>,
    pub exited_at: Option<String>,
    /// The inspector port when the suite runs with --inspect-functions.
    pub inspect_port: Option<u16>,
    pub in_flight: u32,
}

/// How a function is triggered, in the official functions shell's
/// vocabulary plus alerts.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub enum FunctionKind {
    Http,
    Callable,
    Firestore,
    Storage,
    Auth,
    Pubsub,
    Schedule,
    Eventarc,
    Tasks,
    Blocking,
    Alerts,
    Database,
    Other,
}

impl FunctionKind {
    /// Every kind, in declaration order: the finished store keeps one queue
    /// per kind, and the invocation filter's `kind` field offers these.
    pub const ALL: [Self; 13] = [
        Self::Http,
        Self::Callable,
        Self::Firestore,
        Self::Storage,
        Self::Auth,
        Self::Pubsub,
        Self::Schedule,
        Self::Eventarc,
        Self::Tasks,
        Self::Blocking,
        Self::Alerts,
        Self::Database,
        Self::Other,
    ];
}

/// Who caused an invocation.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub enum InvocationOrigin {
    /// Sent from the console (a request carrying `x-firenook-console`).
    Console,
    /// The console replayed a recorded invocation.
    Replay,
    /// An emulator service delivered it: a trigger, a task, a blocking call.
    #[default]
    Emulator,
    /// An app or a tool called the function's address.
    Client,
}

/// How an invocation ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub enum InvocationOutcome {
    /// Answered with a 2xx.
    Succeeded,
    /// A blocking function let the Auth operation through.
    Allowed,
    /// A blocking function refused the Auth operation, as it is meant to.
    Blocked,
    /// The handler threw, or answered with a 5xx.
    Failed,
    /// Answered with a 4xx.
    ClientError,
    /// A callable answered with an error status.
    CallableError,
    /// The function ran past its timeout.
    TimedOut,
    /// The worker went away while the invocation ran.
    Crashed,
    /// The worker could not be started.
    NotStarted,
    /// The function's triggers are disabled; nothing ran.
    Paused,
    /// The function no longer exists in the loaded code; nothing ran.
    Removed,
}

/// The three answers every filter and count uses; `running` while there is
/// no outcome.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub enum InvocationOutcomeClass {
    Succeeded,
    Failed,
    Skipped,
    Running,
}

impl InvocationOutcome {
    /// `Succeeded`, `Allowed`, `Blocked` → `Succeeded` (the function did its
    /// job); `Failed`, `ClientError`, `CallableError`, `TimedOut`, `Crashed`,
    /// `NotStarted` → `Failed`; `Paused`, `Removed` → `Skipped`.
    #[must_use]
    pub const fn class(self) -> InvocationOutcomeClass {
        match self {
            Self::Succeeded | Self::Allowed | Self::Blocked => InvocationOutcomeClass::Succeeded,
            Self::Failed
            | Self::ClientError
            | Self::CallableError
            | Self::TimedOut
            | Self::Crashed
            | Self::NotStarted => InvocationOutcomeClass::Failed,
            Self::Paused | Self::Removed => InvocationOutcomeClass::Skipped,
        }
    }
}

/// Which address an invocation went to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub enum InvocationTarget {
    /// The function's own address (HTTP, callable and blocking functions).
    Url,
    /// The runtime's trigger route (background functions).
    Trigger,
}

/// What caused an invocation, classified once from the definition, the
/// headers and (blocking or header-less senders only) the body. `event_id`
/// is the `CloudEvent` id or the legacy `context.eventId`: the key messaging
/// joins its fanout by.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export_to = "compute/")]
pub enum InvocationCause {
    Http {
        method: String,
        path: String,
    },
    /// `tenant` from the bearer's firebase.tenant claim.
    Callable {
        uid: Option<String>,
        tenant: Option<String>,
        app_check: bool,
        streaming: bool,
    },
    Firestore {
        event_type: String,
        database: String,
        /// The document path, relative to the database's documents.
        document: String,
        event_id: Option<String>,
    },
    Storage {
        event_type: String,
        bucket: String,
        object: String,
        event_id: Option<String>,
    },
    Auth {
        event_type: String,
        uid: Option<String>,
        email: Option<String>,
        tenant: Option<String>,
        event_id: Option<String>,
    },
    /// `topic` is the full resource name, projects/<p>/topics/<t>.
    Pubsub {
        topic: String,
        message_id: Option<String>,
        event_id: Option<String>,
    },
    /// A schedule tick; `topic` is its synthetic topic's full resource name.
    Schedule {
        topic: String,
        event_id: Option<String>,
    },
    /// `event` is the monitor's id of the Eventarc event this delivered.
    Eventarc {
        channel: String,
        event_type: String,
        source: Option<String>,
        subject: Option<String>,
        event_id: Option<String>,
        event: Option<String>,
    },
    /// `task` is the task name as Cloud Tasks sent it; `queue` the engine's
    /// queue key.
    Task {
        queue: String,
        task: String,
        retry_count: u32,
        execution_count: u32,
    },
    /// `auth_call` is the Auth emulator's call id, from
    /// x-firenook-cause-auth-call.
    Blocking {
        event_type: String,
        uid: Option<String>,
        email: Option<String>,
        tenant: Option<String>,
        auth_call: Option<String>,
    },
    Alert {
        alert_type: String,
        app_id: Option<String>,
    },
    /// Nothing in the request said what caused it.
    Unknown,
}

/// One invocation in a list.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub struct InvocationSummary {
    /// `<nonce>-<seq>`, for example a3f9c1-1284.
    pub id: String,
    #[ts(type = "number")]
    pub seq: u64,
    pub function_id: String,
    pub codebase: String,
    pub kind: FunctionKind,
    pub origin: InvocationOrigin,
    pub cause: InvocationCause,
    /// One line in plain words: `orders/o_123 created`, `POST /fail`.
    pub summary: String,
    pub started_at: String,
    /// Null while running.
    pub duration_ms: Option<f64>,
    /// Null while running.
    pub outcome: Option<InvocationOutcome>,
    pub outcome_class: InvocationOutcomeClass,
    /// The HTTP status the worker answered with, when it answered.
    pub status: Option<u16>,
    /// A callable's error status word, for example `INVALID_ARGUMENT`.
    pub callable_status: Option<String>,
    /// The worker had to be started for this invocation.
    pub cold: bool,
    pub attempt: u32,
    /// The event this invocation delivered, when it delivered one (the
    /// `by_event_id` key).
    pub event_id: Option<String>,
    /// The invocation this one replays.
    pub replay_of: Option<String>,
    pub log_count: u32,
    /// The first line of the error, when it failed.
    pub error: Option<String>,
}

/// How a recorded body's `text` is written.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub enum FunctionBodyEncoding {
    Empty,
    Text,
    Base64,
}

/// A body as recorded: the first 256 KB of it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub struct FunctionBody {
    /// The whole body's size in bytes, as it arrived.
    #[ts(type = "number")]
    pub size: u64,
    pub truncated: bool,
    pub encoding: FunctionBodyEncoding,
    pub text: String,
}

/// A header as the console shows it. Sensitive values (authorization,
/// cookie, proxy-authorization, x-firebase-appcheck, x-api-key) are never
/// sent in a list or a detail: `value` is null and the reveal route reads it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub struct FunctionHeader {
    pub name: String,
    pub value: Option<String>,
    pub sensitive: bool,
}

/// The request an invocation received.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub struct FunctionRequest {
    pub target: InvocationTarget,
    pub method: String,
    /// After the function's address for URL invocations; the trigger
    /// route's query otherwise.
    pub path: String,
    pub headers: Vec<FunctionHeader>,
    pub content_type: Option<String>,
    pub body: FunctionBody,
}

/// What the worker answered.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub struct FunctionResponse {
    pub status: u16,
    pub headers: Vec<FunctionHeader>,
    pub content_type: Option<String>,
    pub body: FunctionBody,
    pub chunks: u32,
    pub streaming: bool,
    /// The caller started reading the body and stopped before its end.
    pub client_gone: bool,
}

/// Where an invocation's time went.
#[derive(Clone, Debug, Default, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub struct InvocationTimings {
    /// Starting the worker, when this invocation had to.
    pub worker_start_ms: Option<f64>,
    pub first_byte_ms: Option<f64>,
    pub total_ms: Option<f64>,
}

/// The level a function printed a line at.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub enum FunctionLogLevel {
    Debug,
    Info,
    Warn,
    Error,
}

/// One line a function printed.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub struct FunctionLogLine {
    pub index: u32,
    pub at: String,
    /// Milliseconds since the invocation started; 0 for load-log lines.
    pub offset_ms: f64,
    /// The true level (console.debug is Debug, console.error is Error).
    pub level: FunctionLogLevel,
    pub message: String,
    /// The engine's name for what the line is, for example function.error.
    pub kind: Option<String>,
    /// The other fields of a structured firebase-functions logger entry,
    /// read by the engine's structured-line parser.
    #[ts(type = "unknown")]
    pub fields: Option<serde_json::Value>,
    /// Printed after the invocation had returned.
    pub after_finish: bool,
}

/// Response bytes as they streamed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub struct FunctionResponseChunk {
    pub text: String,
    pub encoding: FunctionBodyEncoding,
}

/// Everything kept about one invocation.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub struct InvocationDetail {
    pub summary: InvocationSummary,
    pub request: FunctionRequest,
    pub response: Option<FunctionResponse>,
    /// The event decoded for reading: a `CloudEvent`'s attributes and data, a
    /// first-generation envelope, or a second-generation Firestore event's
    /// protobuf as REST documents. Null for HTTP.
    #[ts(type = "unknown")]
    pub event: Option<serde_json::Value>,
    pub logs: Vec<FunctionLogLine>,
    pub logs_dropped: u32,
    pub timings: InvocationTimings,
    pub replayable: bool,
    /// Why it cannot be replayed, in words, when it cannot.
    pub not_replayable: Option<String>,
    /// Where the invocation topic resumes from: `<lines>.<bytes>`.
    pub live_cursor: String,
}

/// Counters since start and percentiles over the last 256 durations.
#[derive(Clone, Debug, Default, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub struct FunctionStats {
    #[ts(type = "number")]
    pub runs: u64,
    /// Invocations whose class is failed.
    #[ts(type = "number")]
    pub failures: u64,
    pub in_flight: u32,
    pub last: Option<InvocationSummary>,
    pub p50_ms: Option<f64>,
    pub p95_ms: Option<f64>,
}

// ── Eventarc ────────────────────────────────────────────────────────────

/// Who published an Eventarc event.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub enum EventarcOrigin {
    Console,
    Replay,
    /// An app, an extension or a tool published it on a channel.
    App,
}

/// One subscription filter an event did not satisfy.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub struct EventarcFilterMismatch {
    pub attribute: String,
    pub expected: String,
    /// The event's value, or null when it has no such attribute.
    pub actual: Option<String>,
}

/// One subscription considered for an event.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub struct EventarcDelivery {
    pub trigger_key: String,
    pub function_id: Option<String>,
    pub matched: bool,
    pub mismatches: Vec<EventarcFilterMismatch>,
    pub invocation_id: Option<String>,
    pub outcome: Option<InvocationOutcome>,
    pub duration_ms: Option<f64>,
}

/// One Eventarc event in a list.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub struct EventarcEventSummary {
    /// `<nonce>-<seq>`.
    pub id: String,
    #[ts(type = "number")]
    pub seq: u64,
    /// The `CloudEvent`'s own id.
    pub event_id: Option<String>,
    pub received_at: String,
    /// The full channel resource name, or `google` for the native channel.
    pub channel: String,
    pub event_type: String,
    pub source: Option<String>,
    pub subject: Option<String>,
    /// The extension instance that published it, from a
    /// `projects/<p>/instances/<id>` source.
    pub publisher: Option<String>,
    pub origin: EventarcOrigin,
    pub matched: u32,
    pub delivered: u32,
    pub failed: u32,
    pub pending: u32,
    pub filtered: u32,
    /// Nothing on this channel listens for this type.
    pub unheard: bool,
    /// Why the event could not be read (a missing required attribute).
    pub error: Option<String>,
}

/// Everything kept about one Eventarc event.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub struct EventarcEventDetail {
    pub summary: EventarcEventSummary,
    pub attributes: BTreeMap<String, String>,
    pub datacontenttype: Option<String>,
    pub time: Option<String>,
    #[ts(type = "unknown")]
    pub data: serde_json::Value,
    #[ts(type = "number")]
    pub data_size: u64,
    pub data_truncated: bool,
    /// The event as it arrived (proto JSON on a channel, structured on the
    /// native channel).
    #[ts(type = "unknown")]
    pub raw: serde_json::Value,
    pub deliveries: Vec<EventarcDelivery>,
    pub replay_of: Option<String>,
}

// ── Live (internal to the engine; the console sees its own shaped batches) ──

/// A change the monitor hands its live sink. Not exported to TypeScript:
/// the sink serializes the payload into a ring entry and the console's
/// topics shape the entries into their batches. An `Event` is pushed again
/// whenever one of the event's deliveries changes, so the newest summary is
/// always the last one pushed.
#[derive(Clone, Debug, PartialEq)]
pub enum MonitorEvent {
    /// A codebase's load state, worker, stale flags or counters, whole.
    Codebase(FunctionCodebase),
    /// A completed load (every one, even when the diff is empty).
    Inventory {
        codebase: String,
        diff: FunctionRegistryDiff,
        loads: u32,
    },
    /// An invocation began; `stats` are the function's absolute figures after it.
    InvocationStarted {
        summary: InvocationSummary,
        stats: FunctionStats,
    },
    /// An invocation finished; `stats` are the function's absolute figures after it.
    InvocationFinished {
        summary: InvocationSummary,
        stats: FunctionStats,
    },
    /// A line for a codebase's load log (no invocation owns it).
    LoadLine {
        codebase: String,
        line: FunctionLogLine,
    },
    /// An Eventarc event arrived, or one of its deliveries changed.
    Event(EventarcEventSummary),
    /// An extension instance was reloaded, reconfigured or vendored.
    Extension { instance_id: String },
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, UNIX_EPOCH};

    use serde_json::json;

    use super::*;

    fn config() -> ts_rs::Config {
        ts_rs::Config::new()
    }

    #[test]
    fn outcomes_fall_into_their_classes() {
        use InvocationOutcome as O;
        use InvocationOutcomeClass as C;
        let expected = [
            (O::Succeeded, C::Succeeded),
            (O::Allowed, C::Succeeded),
            (O::Blocked, C::Succeeded),
            (O::Failed, C::Failed),
            (O::ClientError, C::Failed),
            (O::CallableError, C::Failed),
            (O::TimedOut, C::Failed),
            (O::Crashed, C::Failed),
            (O::NotStarted, C::Failed),
            (O::Paused, C::Skipped),
            (O::Removed, C::Skipped),
        ];
        for (outcome, class) in expected {
            assert_eq!(outcome.class(), class, "{outcome:?}");
        }
    }

    #[test]
    fn causes_carry_a_type_tag_and_camel_case_fields() {
        let blocking = InvocationCause::Blocking {
            event_type: "providers/cloud.auth/eventTypes/user.beforeCreate".to_owned(),
            uid: Some("u_1".to_owned()),
            email: Some("ada@blocked.test".to_owned()),
            tenant: None,
            auth_call: Some("c_42".to_owned()),
        };
        assert_eq!(
            serde_json::to_value(&blocking).expect("json"),
            json!({
                "type": "blocking",
                "eventType": "providers/cloud.auth/eventTypes/user.beforeCreate",
                "uid": "u_1",
                "email": "ada@blocked.test",
                "tenant": null,
                "authCall": "c_42",
            })
        );
        let pubsub = InvocationCause::Pubsub {
            topic: "projects/demo/topics/emails".to_owned(),
            message_id: Some("18".to_owned()),
            event_id: Some("18".to_owned()),
        };
        assert_eq!(
            serde_json::to_value(&pubsub).expect("json"),
            json!({
                "type": "pubsub",
                "topic": "projects/demo/topics/emails",
                "messageId": "18",
                "eventId": "18",
            })
        );
        let schedule = InvocationCause::Schedule {
            topic: "projects/demo/topics/firebase-schedule-nightly".to_owned(),
            event_id: None,
        };
        assert_eq!(
            serde_json::to_value(&schedule).expect("json")["eventId"],
            serde_json::Value::Null
        );
        let task = InvocationCause::Task {
            queue: "queue:demo-us-central1-resize".to_owned(),
            task: "7891".to_owned(),
            retry_count: 1,
            execution_count: 2,
        };
        let task = serde_json::to_value(&task).expect("json");
        assert_eq!(task["type"], "task");
        assert_eq!(task["retryCount"], 1);
        assert_eq!(task["executionCount"], 2);
        assert_eq!(
            serde_json::to_value(InvocationCause::Unknown).expect("json"),
            json!({ "type": "unknown" })
        );
    }

    #[test]
    fn stale_flags_carry_a_reason_tag() {
        let stale = FunctionStale::EnvChanged {
            file: ".env.local".to_owned(),
            changed_at: "2026-10-12T14:02:11.093Z".to_owned(),
        };
        assert_eq!(
            serde_json::to_value(&stale).expect("json"),
            json!({
                "reason": "envChanged",
                "file": ".env.local",
                "changedAt": "2026-10-12T14:02:11.093Z",
            })
        );
    }

    #[test]
    fn enum_words_are_camel_case() {
        assert_eq!(
            serde_json::to_value(InvocationOutcome::CallableError).expect("json"),
            "callableError"
        );
        assert_eq!(
            serde_json::to_value(InvocationOutcome::NotStarted).expect("json"),
            "notStarted"
        );
        assert_eq!(
            serde_json::to_value(FunctionBodyEncoding::Base64).expect("json"),
            "base64"
        );
        assert_eq!(
            serde_json::to_value(InvocationOrigin::default()).expect("json"),
            "emulator"
        );
        assert_eq!(
            serde_json::to_value(FunctionsPhase::default()).expect("json"),
            "starting"
        );
    }

    #[test]
    fn every_kind_is_listed_once() {
        let names: std::collections::BTreeSet<String> = FunctionKind::ALL
            .iter()
            .map(|kind| {
                serde_json::to_value(kind)
                    .expect("json")
                    .as_str()
                    .expect("a word")
                    .to_owned()
            })
            .collect();
        assert_eq!(names.len(), FunctionKind::ALL.len());
        assert!(names.contains("pubsub"), "{names:?}");
        assert!(names.contains("blocking"), "{names:?}");
    }

    #[test]
    fn timestamps_are_utc_with_three_fractional_digits() {
        assert_eq!(
            format_timestamp(UNIX_EPOCH + Duration::from_millis(1_234_567)),
            "1970-01-01T00:20:34.567Z"
        );
        assert_eq!(
            format_timestamp(UNIX_EPOCH + Duration::from_secs(1_791_814_931)),
            "2026-10-12T14:22:11.000Z"
        );
        assert_eq!(
            format_timestamp(UNIX_EPOCH + Duration::from_nanos(5_999_999)),
            "1970-01-01T00:00:00.005Z"
        );
    }

    #[test]
    fn summaries_serialize_in_camel_case_with_numbers_for_sequences() {
        let summary = InvocationSummary {
            id: "a3f9c1-1284".to_owned(),
            seq: 1284,
            function_id: "us-central1-onEmail".to_owned(),
            codebase: "default".to_owned(),
            kind: FunctionKind::Pubsub,
            origin: InvocationOrigin::Emulator,
            cause: InvocationCause::Pubsub {
                topic: "projects/demo/topics/emails".to_owned(),
                message_id: Some("18".to_owned()),
                event_id: Some("18".to_owned()),
            },
            summary: "message 18 on emails".to_owned(),
            started_at: "2026-10-12T14:02:11.093Z".to_owned(),
            duration_ms: Some(12.5),
            outcome: Some(InvocationOutcome::Succeeded),
            outcome_class: InvocationOutcomeClass::Succeeded,
            status: Some(204),
            callable_status: None,
            cold: false,
            attempt: 1,
            event_id: Some("18".to_owned()),
            replay_of: None,
            log_count: 0,
            error: None,
        };
        let value = serde_json::to_value(&summary).expect("json");
        assert_eq!(value["seq"], 1284);
        assert_eq!(value["functionId"], "us-central1-onEmail");
        assert_eq!(value["outcomeClass"], "succeeded");
        assert_eq!(value["eventId"], "18");
        assert_eq!(value["cause"]["type"], "pubsub");
    }

    #[test]
    fn typescript_declarations_follow_the_contract() {
        let cfg = config();
        let cause = InvocationCause::decl(&cfg);
        assert!(cause.contains("\"type\": \"blocking\""), "{cause}");
        assert!(cause.contains("authCall: string | null"), "{cause}");
        assert!(cause.contains("eventId: string | null"), "{cause}");
        assert!(cause.contains("appCheck: boolean"), "{cause}");
        let summary = InvocationSummary::decl(&cfg);
        assert!(summary.contains("seq: number"), "{summary}");
        assert!(summary.contains("cause: InvocationCause"), "{summary}");
        assert!(
            summary.contains("outcome: InvocationOutcome | null"),
            "{summary}"
        );
        let stats = FunctionStats::decl(&cfg);
        assert!(stats.contains("runs: number"), "{stats}");
        let detail = InvocationDetail::decl(&cfg);
        assert!(detail.contains("event: unknown"), "{detail}");
        let stale = FunctionStale::decl(&cfg);
        assert!(stale.contains("\"reason\": \"sourcesNewer\""), "{stale}");
        assert!(stale.contains("changedAt: string"), "{stale}");
        assert_eq!(
            InvocationSummary::output_path().expect("exportable"),
            std::path::Path::new("compute/InvocationSummary.ts")
        );
        assert_eq!(
            EventarcEventDetail::output_path().expect("exportable"),
            std::path::Path::new("compute/EventarcEventDetail.ts")
        );
    }

    #[test]
    fn doc_comments_never_close_the_generated_comment() {
        let cfg = config();
        let declarations = [
            FunctionCodebase::decl(&cfg),
            FunctionStale::decl(&cfg),
            FunctionWorker::decl(&cfg),
            InvocationCause::decl(&cfg),
            InvocationSummary::decl(&cfg),
            InvocationDetail::decl(&cfg),
            FunctionHeader::decl(&cfg),
            FunctionRequest::decl(&cfg),
            FunctionLogLine::decl(&cfg),
            FunctionStats::decl(&cfg),
            EventarcEventSummary::decl(&cfg),
            EventarcEventDetail::decl(&cfg),
        ];
        for declaration in declarations {
            let opened = declaration.matches("/**").count();
            let closed = declaration.matches("*/").count();
            assert_eq!(opened, closed, "{declaration}");
        }
    }
}
