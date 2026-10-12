//! The Functions console API, mounted at `/console/api/v1/functions`.
//!
//! The function list is `GET /functions` and one function `GET
//! /functions/{id}`; ids always start with a region, so the static
//! segments (`invocations`, `codebases`, `triggers`, `match`, `native`)
//! never collide with one. Calls the console makes answer as NDJSON
//! [`InvocationFrame`]s; everything else is JSON, every mutation takes a
//! JSON body, and errors are the foundation's [`ApiError`].
//!
//! Console-only types live here (everything that carries an [`EntityRef`],
//! which only the console builds); the runtime's own types come from
//! `firenook_functions_runtime::monitor` and are exported beside them.

use std::collections::{BTreeMap, HashSet};
use std::time::SystemTime;

use axum::body::{Body, Bytes};
use axum::extract::{Path, Query, State};
use axum::http::{HeaderValue, Method, Request, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use firenook_functions_runtime::Monitor;
use firenook_functions_runtime::console::{
    AuthEvent, ConsoleHandle, DispatchFrame, DispatchInput, DispatchStream, DispatchTarget,
    EnvChange, EnvFile, EnvSource, EnvironmentView, FirestoreChange, FunctionView, MatchInput,
    ParamView, RuntimeStatus, StorageEvent, TriggersQuery,
};
use firenook_functions_runtime::monitor::{
    FunctionBodyEncoding, FunctionCodebase, FunctionHeader, FunctionKind, FunctionLogLine,
    FunctionStats, FunctionsPhase, InvocationCause, InvocationDetail, InvocationOrigin,
    InvocationQuery, InvocationSummary, InvocationTarget, format_timestamp,
};
use firenook_pubsub_front::{RunScheduleError, ScheduleControl as _};
use firenook_tasks_front::{ConsoleTask, EnqueueError};
use futures_util::stream::{self, Stream, StreamExt as _};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tower::ServiceExt as _;
use ts_rs::TS;

use super::extensions::TASK_QUEUE_NOTE;
use super::filters::invocation_filter;
use super::live::codebase_entry;
use super::topics::not_kept;
use super::{ComputeControl, ComputeState, ComputeSuite, console_error, random_uuid};
use crate::api_error::ApiError;
use crate::entity::EntityRef;
use crate::http::{attachment, ndjson_response};
use crate::json::{BodyLimit, ConsoleJson};
use crate::paging::{Page, PageBuilder, Total, decode_cursor};

/// The body limit of the routes that carry a call: the worker's own.
const CALL_LIMIT: usize = 32 * 1024 * 1024;
/// The body limit of every other compute mutation.
pub(crate) const BODY_LIMIT: usize = 1024 * 1024;
/// Response bytes an invoke stream forwards before it says `truncated`.
const FORWARD_LIMIT: u64 = 4 * 1024 * 1024;
/// Invocations one page holds by default, and at most.
const DEFAULT_PAGE: usize = 200;
const MAX_PAGE: usize = 500;

// ── Types ────────────────────────────────────────────────────────────────

/// Everything the Functions section draws on arrival.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub(crate) struct FunctionsSnapshot {
    pub(crate) phase: FunctionsPhase,
    pub(crate) project_id: String,
    /// The Functions service as the suite advertises it, for example
    /// `http://127.0.0.1:5001`. Null when the suite did not say.
    pub(crate) address: Option<String>,
    /// The suite runs with --inspect-functions (timeouts are off).
    pub(crate) debugging: bool,
    pub(crate) codebases: Vec<FunctionCodebaseEntry>,
    /// Empty while Functions start.
    pub(crate) functions: Vec<FunctionSummary>,
    /// Subscribe to `functions.events` with this as `after`: read with the
    /// state, under one lock.
    pub(crate) live_cursor: String,
}

/// A codebase as the runtime reports it, and the Extensions instance it is
/// (extension codebases only).
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub(crate) struct FunctionCodebaseEntry {
    pub(crate) codebase: FunctionCodebase,
    pub(crate) instance: Option<EntityRef>,
}

/// Whether a function receives anything, and if not, which of the ways.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub(crate) enum FunctionStatus {
    Receiving,
    /// The emulator does not deliver its events.
    Ignored,
    /// The service its events come from is not running in this suite.
    NoService,
    /// Background triggers are paused.
    Paused,
    /// A reload removed it.
    Removed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export_to = "compute/")]
pub(crate) enum FunctionPlatform {
    Gcfv1,
    Gcfv2,
}

/// One function in the list.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub(crate) struct FunctionSummary {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) entry_point: String,
    pub(crate) region: String,
    pub(crate) platform: FunctionPlatform,
    pub(crate) codebase: String,
    pub(crate) extension_instance: Option<String>,
    /// The instance in Extensions, for an extension's function.
    pub(crate) extension: Option<EntityRef>,
    pub(crate) kind: FunctionKind,
    pub(crate) trigger: FunctionTrigger,
    pub(crate) status: FunctionStatus,
    /// Why it receives nothing, in words, for every status but receiving.
    pub(crate) status_reason: Option<String>,
    /// The hub service its events come from (firestore, storage, auth,
    /// pubsub), when any.
    pub(crate) service: Option<String>,
    /// The function's own address as apps reach it, for http, callable and
    /// blocking kinds only.
    pub(crate) url: Option<String>,
    pub(crate) timeout_seconds: u32,
    pub(crate) secrets: Vec<FunctionSecret>,
    pub(crate) stats: FunctionStats,
}

/// A trigger, flattened for reading. Only the fields its kind uses are set.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub(crate) struct FunctionTrigger {
    pub(crate) event_type: Option<String>,
    pub(crate) resource: Option<String>,
    pub(crate) database: Option<String>,
    /// The document pattern, relative (`orders/{orderId}`).
    pub(crate) document: Option<String>,
    /// `exact` or `pattern`.
    pub(crate) match_type: Option<String>,
    pub(crate) bucket: Option<String>,
    /// A Pub/Sub topic's full resource name.
    pub(crate) topic: Option<String>,
    pub(crate) channel: Option<String>,
    pub(crate) filters: BTreeMap<String, String>,
    pub(crate) path_patterns: BTreeMap<String, String>,
    pub(crate) schedule: Option<String>,
    pub(crate) time_zone: Option<String>,
    /// `beforeCreate` or `beforeSignIn`.
    pub(crate) blocking_event: Option<String>,
    pub(crate) invoker: Vec<String>,
    pub(crate) retry: Option<bool>,
}

/// A secret a function declares, and whether a value exists for it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub(crate) struct FunctionSecret {
    pub(crate) key: String,
    pub(crate) secret: String,
    pub(crate) provided: bool,
}

/// Everything about one function.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub(crate) struct FunctionDetail {
    pub(crate) summary: FunctionSummary,
    pub(crate) keys: Vec<FunctionTriggerKey>,
    pub(crate) environment: FunctionEnvironment,
    pub(crate) params: Vec<FunctionParam>,
    pub(crate) declared: Vec<FunctionDeclaredOption>,
    pub(crate) schedule: Option<FunctionSchedule>,
    pub(crate) task_queue: Option<FunctionTaskQueue>,
    pub(crate) blocking: Option<FunctionBlocking>,
    /// The definition exactly as `/backends` serves it.
    #[ts(type = "unknown")]
    pub(crate) definition: Value,
}

/// One registration of a function (a reload or a background toggle adds a
/// generation).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub(crate) struct FunctionTriggerKey {
    pub(crate) key: String,
    pub(crate) generation: Option<u32>,
    pub(crate) enabled: bool,
    pub(crate) stale: bool,
}

/// Where a variable comes from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub(crate) enum FunctionEnvSource {
    DotEnv,
    SecretLocal,
    Emulator,
    ExtensionParam,
}

/// The file a variable can be written to (never a path).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub(crate) enum FunctionEnvFile {
    Env,
    EnvProject,
    EnvAlias,
    EnvLocal,
    SecretLocal,
}

/// One variable the codebase's worker sees.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub(crate) struct FunctionEnvVariable {
    pub(crate) key: String,
    /// Null for a secret: reveal it through the secrets route.
    pub(crate) value: Option<String>,
    pub(crate) secret: bool,
    pub(crate) source: FunctionEnvSource,
    /// The file it came from, for dotenv and secret variables.
    pub(crate) file: Option<FunctionEnvFile>,
    pub(crate) file_name: Option<String>,
}

/// A codebase's environment as its worker sees it.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub(crate) struct FunctionEnvironment {
    pub(crate) files: Vec<String>,
    pub(crate) variables: Vec<FunctionEnvVariable>,
    /// Variables the worker inherits from the engine's own environment;
    /// their values are never sent.
    pub(crate) inherited: u32,
    /// The codebase's files can be edited here (a user codebase; extensions
    /// edit in Extensions).
    pub(crate) editable: bool,
}

/// A param the manifest declares (defineString, defineInt, defineSecret …).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub(crate) struct FunctionParam {
    pub(crate) name: String,
    #[serde(rename = "type")]
    pub(crate) param_type: String,
    pub(crate) label: Option<String>,
    pub(crate) default: Option<String>,
    pub(crate) description: Option<String>,
    /// Null for a secret param.
    pub(crate) value: Option<String>,
    pub(crate) secret: bool,
    pub(crate) file: Option<String>,
    /// No value in any env file: the official emulator would prompt and
    /// write .env.local.
    pub(crate) unresolved: bool,
}

/// An option the manifest declares that the emulator does not apply.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub(crate) struct FunctionDeclaredOption {
    pub(crate) name: String,
    #[ts(type = "unknown")]
    pub(crate) value: Value,
    pub(crate) note: String,
}

/// A schedule's facts.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub(crate) struct FunctionSchedule {
    pub(crate) expression: String,
    pub(crate) time_zone: Option<String>,
    /// The synthetic topic's full name, `projects/<p>/topics/firebase-schedule-<name>`.
    pub(crate) topic: String,
    /// The zone the scheduler evaluates the expression in, as it reports
    /// it; null until the scheduler says.
    pub(crate) evaluated_in: Option<String>,
    /// Runs on the clock; false when Pub/Sub is not running.
    pub(crate) automatic: bool,
    pub(crate) manual_reason: Option<String>,
    /// Paused from the Pub/Sub section's Schedules page.
    pub(crate) paused: bool,
    pub(crate) next_run: Option<String>,
    /// When the function last ran, as the engine recorded it.
    pub(crate) last_run: Option<String>,
    /// Pub/Sub is running in this suite (Run now publishes; else it
    /// dispatches directly).
    pub(crate) pubsub: bool,
    /// The schedule in Pub/Sub › Schedules, when Pub/Sub runs.
    pub(crate) schedule_ref: Option<EntityRef>,
    #[ts(type = "unknown")]
    pub(crate) retry: Option<Value>,
}

/// A task queue function's queue.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub(crate) struct FunctionTaskQueue {
    /// `queue:<project>-<region>-<name>`.
    pub(crate) queue: String,
    /// The queue in Cloud Tasks, when Cloud Tasks runs.
    pub(crate) queue_ref: Option<EntityRef>,
    #[ts(type = "unknown")]
    pub(crate) retry_config: Value,
    #[ts(type = "unknown")]
    pub(crate) rate_limits: Value,
    /// Why the Cloud Tasks emulator refused the queue, when it did.
    pub(crate) refused: Option<String>,
    /// The queue holds scheduled tasks until their time; only then does a
    /// run-after delay a task.
    pub(crate) hold_scheduled: bool,
}

/// How an Auth blocking function is wired.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub(crate) struct FunctionBlocking {
    /// `beforeCreate` or `beforeSignIn`.
    pub(crate) event: String,
    /// This function is the one the Auth emulator calls for that event.
    pub(crate) wired: bool,
    /// The sign-in tokens the Auth emulator forwards to it.
    pub(crate) forwards: FunctionBlockingForwards,
}

/// The sign-in tokens a blocking function asks the Auth emulator for.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub(crate) struct FunctionBlockingForwards {
    pub(crate) id_token: bool,
    pub(crate) access_token: bool,
    pub(crate) refresh_token: bool,
}

/// A header the console sends.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "compute/")]
pub(crate) struct FunctionHeaderInput {
    pub(crate) name: String,
    pub(crate) value: String,
}

/// A call the console makes.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "compute/")]
pub(crate) struct FunctionInvokeRequest {
    pub(crate) target: InvocationTarget,
    /// GET, POST …; ignored for `trigger` (always POST).
    #[serde(default = "post_method")]
    pub(crate) method: String,
    /// After the function's address: `/users/42?active=true`. Ignored for
    /// `trigger`.
    #[serde(default)]
    pub(crate) path: String,
    #[serde(default)]
    pub(crate) headers: Vec<FunctionHeaderInput>,
    #[serde(default)]
    pub(crate) body: String,
    #[serde(default = "empty_encoding")]
    pub(crate) encoding: FunctionBodyEncoding,
}

fn post_method() -> String {
    "POST".to_owned()
}

const fn empty_encoding() -> FunctionBodyEncoding {
    FunctionBodyEncoding::Empty
}

/// One line of an invoke response stream.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(
    tag = "frame",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export_to = "compute/")]
pub(crate) enum InvocationFrame {
    Started {
        invocation: InvocationSummary,
    },
    Head {
        status: u16,
        headers: Vec<FunctionHeader>,
    },
    Chunk {
        text: String,
        encoding: FunctionBodyEncoding,
    },
    /// The answer passed the 4 MiB the console forwards; `total` is its
    /// size. The invocation keeps its first 256 KiB.
    Truncated {
        #[ts(type = "number")]
        total: u64,
    },
    Finished {
        invocation: InvocationSummary,
    },
    Failed {
        message: String,
    },
}

/// A test event: the exact envelope to post to the function's trigger.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "compute/")]
pub(crate) struct FunctionTestEventRequest {
    #[ts(type = "unknown")]
    pub(crate) body: Value,
    #[serde(default)]
    pub(crate) headers: Vec<FunctionHeaderInput>,
}

/// A message to publish to a Pub/Sub function's topic.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "compute/")]
pub(crate) struct FunctionPublishRequest {
    #[serde(default)]
    pub(crate) data: String,
    #[serde(default = "empty_encoding")]
    pub(crate) encoding: FunctionBodyEncoding,
    #[serde(default)]
    pub(crate) attributes: BTreeMap<String, String>,
    #[serde(default)]
    pub(crate) ordering_key: Option<String>,
}

/// A task for a task queue function.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "compute/")]
pub(crate) struct FunctionEnqueueRequest {
    #[ts(type = "unknown")]
    pub(crate) payload: Value,
    /// Accepted only when the queue holds scheduled tasks.
    #[serde(default)]
    pub(crate) run_after_seconds: Option<u32>,
}

/// Which broker took a console request.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub(crate) enum FunctionBrokerTransport {
    Pubsub,
    Tasks,
    Direct,
}

/// What a broker accepted; the invocation arrives on the live topic.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub(crate) struct FunctionBrokerResult {
    pub(crate) transport: FunctionBrokerTransport,
    pub(crate) topic: Option<String>,
    pub(crate) message_id: Option<String>,
    pub(crate) queue: Option<String>,
    pub(crate) task: Option<String>,
    /// The message (`pubsub.message`) or the queue (`tasks.queue`) in its
    /// own section.
    pub(crate) target: Option<EntityRef>,
    /// Set for `direct` (the fallback when Pub/Sub does not run).
    pub(crate) invocation: Option<InvocationSummary>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub(crate) enum FunctionFirestoreChange {
    Created,
    Updated,
    Deleted,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub(crate) enum FunctionStorageEvent {
    Finalized,
    Deleted,
    MetadataUpdated,
    Archived,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub(crate) enum FunctionAuthEvent {
    Create,
    Delete,
    BeforeCreate,
    BeforeSignIn,
}

/// "Which functions fire here, and why not?" (`POST /functions/match`).
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(
    tag = "service",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export_to = "compute/")]
pub(crate) enum FunctionMatchRequest {
    Firestore {
        database: String,
        path: String,
        changes: Vec<FunctionFirestoreChange>,
    },
    Storage {
        bucket: String,
        events: Vec<FunctionStorageEvent>,
    },
    Auth {
        #[serde(default)]
        tenant: Option<String>,
        events: Vec<FunctionAuthEvent>,
    },
    Pubsub {
        topic: String,
    },
    Eventarc {
        channel: String,
        event_type: String,
        #[serde(default)]
        attributes: BTreeMap<String, String>,
    },
    Tasks {
        queue: String,
    },
}

/// Whether one function fires, and why.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub(crate) struct FunctionMatch {
    pub(crate) function_id: String,
    pub(crate) function: EntityRef,
    /// The change or event kind this row is about, for multi-kind requests.
    pub(crate) change: Option<String>,
    pub(crate) fires: bool,
    /// In words: "matches orders/{orderId}", "listens on (default), not
    /// other", "background triggers are paused".
    pub(crate) reason: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub(crate) struct FunctionMatchResult {
    pub(crate) matches: Vec<FunctionMatch>,
    pub(crate) background_enabled: bool,
}

/// A function that fires for a resource.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub(crate) struct FunctionListener {
    pub(crate) function_id: String,
    pub(crate) codebase: String,
    pub(crate) event_type: String,
    pub(crate) kind: FunctionKind,
    pub(crate) function: EntityRef,
}

/// "Which functions fire here?" (`GET /functions/triggers`): only the ones
/// that do.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub(crate) struct FunctionTriggersResult {
    pub(crate) functions: Vec<FunctionListener>,
    pub(crate) background_enabled: bool,
}

/// A page of invocations, newest first, and where the live topic resumes
/// for it (first page only).
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub(crate) struct InvocationsResult {
    pub(crate) page: Page<InvocationSummary>,
    pub(crate) live_cursor: Option<String>,
}

/// One invocation and what it points at in other sections: the function,
/// its cause (document, object, user, message, topic, schedule, queue,
/// event, Auth call) and the invocation it replays.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub(crate) struct InvocationView {
    pub(crate) detail: InvocationDetail,
    pub(crate) refs: Vec<EntityRef>,
}

/// A codebase's load log as the Monitor keeps it, and where
/// `functions.codebase-log` resumes.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub(crate) struct FunctionLoadLog {
    pub(crate) lines: Vec<FunctionLogLine>,
    pub(crate) live_cursor: String,
}

/// One dotenv change.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "compute/")]
pub(crate) struct FunctionEnvChange {
    pub(crate) file: FunctionEnvFile,
    pub(crate) key: String,
    /// Null removes the key from the file.
    #[serde(default)]
    pub(crate) value: Option<String>,
}

#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "compute/")]
pub(crate) struct FunctionEnvEditRequest {
    pub(crate) changes: Vec<FunctionEnvChange>,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub(crate) struct FunctionEnvEditResult {
    /// The files written, by name.
    pub(crate) written: Vec<String>,
    pub(crate) codebase: FunctionCodebase,
}

/// A secret's value, read at request time.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub(crate) struct FunctionRevealedValue {
    pub(crate) value: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub(crate) struct FunctionRestartResult {
    /// Calls in flight when the worker stopped; they finish `crashed`.
    pub(crate) dropped: u32,
}

/// `{}`: the body of a mutation that needs no input.
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct NoBody {}

// ── Routes ───────────────────────────────────────────────────────────────

/// Every `/functions` route.
pub(crate) fn router(state: ComputeState) -> Router {
    let call = Extension(BodyLimit(CALL_LIMIT));
    let limit = Extension(BodyLimit(BODY_LIMIT));
    Router::new()
        .route("/functions", get(snapshot))
        .route("/functions/triggers", get(triggers))
        .route("/functions/match", post(match_triggers).layer(limit))
        .route(
            "/functions/invocations",
            get(invocations).delete(clear_invocations).layer(limit),
        )
        .route("/functions/invocations/{invocation}", get(invocation))
        .route(
            "/functions/invocations/{invocation}/headers/{name}",
            get(reveal_header),
        )
        .route(
            "/functions/invocations/{invocation}/body/{part}",
            get(recorded_body),
        )
        .route(
            "/functions/invocations/{invocation}/replay",
            post(replay).layer(limit),
        )
        .route("/functions/codebases/{codebase}/log", get(load_log))
        .route(
            "/functions/codebases/{codebase}/secrets/{key}",
            get(reveal_secret),
        )
        .route(
            "/functions/codebases/{codebase}/edit-env",
            post(edit_env).layer(limit),
        )
        .route(
            "/functions/codebases/{codebase}/reload",
            post(reload).layer(limit),
        )
        .route(
            "/functions/codebases/{codebase}/restart",
            post(restart).layer(limit),
        )
        .route("/functions/{id}", get(detail))
        .route("/functions/{id}/invoke", post(invoke).layer(call))
        .route("/functions/{id}/send-event", post(send_event).layer(call))
        .route("/functions/{id}/publish", post(publish).layer(limit))
        .route("/functions/{id}/enqueue", post(enqueue).layer(limit))
        .route("/functions/{id}/run", post(run).layer(limit))
        .with_state(state)
}

async fn snapshot(State(state): State<ComputeState>) -> Json<FunctionsSnapshot> {
    let monitor = state.monitor();
    // The cursor first: anything that changes after it arrives on the
    // topic, so state read after it converges (stats are absolute,
    // definitions are refetched on an inventory change).
    let (phase, codebases, live_cursor) = monitor.snapshot(|view| {
        (
            view.phase(),
            view.codebases(),
            state.live.functions.position().to_string(),
        )
    });
    let control = state.control().ok();
    let (views, debugging) = match &control {
        Some(control) => (
            control.runtime.functions().await,
            control.runtime.debugging(),
        ),
        None => (Vec::new(), false),
    };
    let figures: Vec<FunctionStats> = monitor.snapshot(|view| {
        views
            .iter()
            .map(|function| view.stats(&function.id))
            .collect()
    });
    let suite = state.parts.suite();
    let queues = extension_task_queues(control.as_ref()).await;
    let functions = views
        .iter()
        .zip(figures)
        .map(|(view, figures)| {
            let mut summary = summary_of(view, figures, suite, &state.project);
            extension_task_queue(&mut summary, view, &queues);
            summary
        })
        .collect();
    Json(FunctionsSnapshot {
        phase,
        project_id: state.project.to_string(),
        address: suite.address.clone(),
        debugging,
        codebases: codebases.into_iter().map(codebase_entry).collect(),
        functions,
        live_cursor,
    })
}

async fn detail(
    State(state): State<ComputeState>,
    Path(id): Path<String>,
) -> Result<Json<FunctionDetail>, ApiError> {
    let runtime = state.runtime()?;
    let view = function_view(&runtime, &id).await?;
    let counters = state.monitor().stats(&id);
    let environment = runtime
        .environment(&view.codebase)
        .await
        .map(environment_of)
        .unwrap_or_default();
    let suite = state.parts.suite();
    let mut summary = summary_of(&view, counters.clone(), suite, &state.project);
    let queues = extension_task_queues(state.control().ok().as_ref()).await;
    extension_task_queue(&mut summary, &view, &queues);
    let schedule =
        (view.kind == FunctionKind::Schedule).then(|| schedule_of(&view, &counters, &state));
    let task_queue = (view.kind == FunctionKind::Tasks).then(|| task_queue_of(&view, &state));
    Ok(Json(FunctionDetail {
        keys: view
            .keys
            .iter()
            .map(|key| FunctionTriggerKey {
                key: key.key.clone(),
                generation: key.generation,
                enabled: key.enabled,
                stale: key.stale,
            })
            .collect(),
        environment,
        params: view.params.iter().map(param_of).collect(),
        declared: view
            .declared
            .iter()
            .map(|(name, value)| FunctionDeclaredOption {
                name: name.clone(),
                value: value.clone(),
                note: declared_note(name).to_owned(),
            })
            .collect(),
        schedule,
        task_queue,
        blocking: view.blocking.as_ref().map(|blocking| FunctionBlocking {
            event: blocking.event.clone(),
            wired: blocking.wired,
            forwards: FunctionBlockingForwards {
                id_token: blocking.forward.id_token,
                access_token: blocking.forward.access_token,
                refresh_token: blocking.forward.refresh_token,
            },
        }),
        definition: view.definition.clone(),
        summary,
    }))
}

async fn invoke(
    State(state): State<ComputeState>,
    Path(id): Path<String>,
    ConsoleJson(request): ConsoleJson<FunctionInvokeRequest>,
) -> Result<Response, ApiError> {
    let runtime = state.runtime()?;
    let body = decode_body(&request.body, request.encoding)?;
    let target = match request.target {
        InvocationTarget::Url => DispatchTarget::Url {
            method: request.method,
            path_and_query: request.path,
        },
        InvocationTarget::Trigger => DispatchTarget::Trigger,
    };
    let stream = runtime
        .dispatch(
            &id,
            DispatchInput {
                target,
                headers: headers_of(request.headers),
                body,
                origin: InvocationOrigin::Console,
                replay_of: None,
            },
        )
        .await
        .map_err(console_error)?;
    Ok(frames_response(&state, stream))
}

async fn send_event(
    State(state): State<ComputeState>,
    Path(id): Path<String>,
    ConsoleJson(request): ConsoleJson<FunctionTestEventRequest>,
) -> Result<Response, ApiError> {
    let runtime = state.runtime()?;
    let view = function_view(&runtime, &id).await?;
    if !is_background(view.kind) {
        return Err(ApiError::invalid(format!(
            "{} is a{} function; call it with Invoke instead of sending it an event.",
            view.name,
            match view.kind {
                FunctionKind::Callable => " callable",
                FunctionKind::Tasks => " task queue",
                FunctionKind::Blocking => " blocking",
                _ => "n HTTP",
            }
        )));
    }
    let mut headers = headers_of(request.headers);
    if !headers
        .iter()
        .any(|(name, _)| name.eq_ignore_ascii_case("content-type"))
    {
        headers.push(("content-type".to_owned(), "application/json".to_owned()));
    }
    let body = serde_json::to_vec(&request.body)
        .map_err(|error| ApiError::invalid(format!("The event is not JSON: {error}.")))?;
    let stream = runtime
        .dispatch(
            &id,
            DispatchInput {
                target: DispatchTarget::Trigger,
                headers,
                body: Bytes::from(body),
                origin: InvocationOrigin::Console,
                replay_of: None,
            },
        )
        .await
        .map_err(console_error)?;
    Ok(frames_response(&state, stream))
}

async fn publish(
    State(state): State<ComputeState>,
    Path(id): Path<String>,
    ConsoleJson(request): ConsoleJson<FunctionPublishRequest>,
) -> Result<Json<FunctionBrokerResult>, ApiError> {
    let runtime = state.runtime()?;
    let view = function_view(&runtime, &id).await?;
    if view.kind != FunctionKind::Pubsub {
        return Err(ApiError::invalid(format!(
            "{} does not listen to a Pub/Sub topic.",
            view.name
        )));
    }
    let topic = trigger_of(&view.definition, &state.project)
        .topic
        .ok_or_else(|| ApiError::invalid(format!("{} names no topic.", view.name)))?;
    let data = decode_body(&request.data, request.encoding)?;
    if data.is_empty() && request.attributes.is_empty() {
        return Err(ApiError::invalid(
            "A Pub/Sub message needs data or at least one attribute.",
        ));
    }
    if !runtime.background_enabled() {
        return Err(paused(
            "Background triggers are paused, so Pub/Sub would accept this message and deliver it to no function.",
        ));
    }
    let mut message = json!({ "data": BASE64.encode(&data) });
    if !request.attributes.is_empty() {
        message["attributes"] = json!(request.attributes);
    }
    if let Some(key) = request.ordering_key.filter(|key| !key.is_empty()) {
        message["orderingKey"] = Value::String(key);
    }
    let message_id = publish_to(&state, &topic, message).await?;
    Ok(Json(FunctionBrokerResult {
        transport: FunctionBrokerTransport::Pubsub,
        target: Some(EntityRef::pubsub_message(&topic, &message_id)),
        topic: Some(topic),
        message_id: Some(message_id),
        queue: None,
        task: None,
        invocation: None,
    }))
}

async fn enqueue(
    State(state): State<ComputeState>,
    Path(id): Path<String>,
    ConsoleJson(request): ConsoleJson<FunctionEnqueueRequest>,
) -> Result<Json<FunctionBrokerResult>, ApiError> {
    let runtime = state.runtime()?;
    let view = function_view(&runtime, &id).await?;
    if view.kind != FunctionKind::Tasks {
        return Err(ApiError::invalid(format!(
            "{} is not a task queue function.",
            view.name
        )));
    }
    let Some(tasks) = &state.tasks else {
        return Err(ApiError::unavailable(
            "Cloud Tasks is not running in this suite.",
        ));
    };
    let tasks = tasks.get()?;
    let queue = queue_key(&state.project, &view.region, &view.name);
    let holds = tasks
        .runtime
        .queue_view(&queue)
        .is_some_and(|held| held.hold_scheduled);
    if request.run_after_seconds.is_some() && !holds {
        return Err(ApiError::invalid(
            "This queue runs a task at once whatever its schedule time, as the official emulator does, so a delay would do nothing.",
        ));
    }
    let data = serde_json::to_string(&request.payload)
        .map_err(|error| ApiError::invalid(format!("The payload is not JSON: {error}.")))?;
    // The task the Admin SDK's `TaskQueue.enqueue(payload)` sends, through
    // the console's one enqueue path (the wire's own preparation and limit).
    let task = ConsoleTask {
        data: Some(data),
        schedule_delay_seconds: request
            .run_after_seconds
            .filter(|seconds| *seconds > 0)
            .map(f64::from),
        ..ConsoleTask::default()
    };
    let enqueued = tasks
        .enqueue_console(&queue, task)
        .map_err(|error| enqueue_refused(&error, &view.name))?;
    Ok(Json(FunctionBrokerResult {
        transport: FunctionBrokerTransport::Tasks,
        topic: None,
        message_id: None,
        target: Some(EntityRef::tasks_task(
            &state.project,
            &view.region,
            &view.name,
            &enqueued.id.to_string(),
        )),
        queue: Some(queue),
        task: Some(enqueued.name),
        invocation: None,
    }))
}

/// Cloud Tasks' refusal of a console task, with what to do about it.
fn enqueue_refused(error: &EnqueueError, queue: &str) -> ApiError {
    match error {
        EnqueueError::UnknownQueue => ApiError::not_found(format!(
            "Cloud Tasks has no queue {queue} registered."
        ))
        .with_fix("The queue registers when its codebase loads; reload it, or look in Cloud Tasks for why it was refused."),
        EnqueueError::NameReserved => ApiError::conflict(
            "A task with this name was enqueued before in this run.",
        )
        .with_fix("The emulator keeps every task name until it stops; enqueue without a name."),
        EnqueueError::QueueFull { .. } => ApiError::conflict(format!(
            "{queue} holds as many pending tasks as the emulator keeps."
        ))
        .with_fix("Purge the queue in Cloud Tasks or let it drain."),
        EnqueueError::TooLarge { .. } => ApiError::too_large(error.to_string())
            .with_fix("Send less data: the Admin SDK would be refused the same task."),
        EnqueueError::Invalid(reason) => ApiError::invalid(reason.clone()),
        EnqueueError::UnknownTask => ApiError::not_found(error.to_string()),
    }
}

async fn run(
    State(state): State<ComputeState>,
    Path(id): Path<String>,
    ConsoleJson(NoBody {}): ConsoleJson<NoBody>,
) -> Result<Json<FunctionBrokerResult>, ApiError> {
    let runtime = state.runtime()?;
    let view = function_view(&runtime, &id).await?;
    if view.kind != FunctionKind::Schedule {
        return Err(ApiError::invalid(format!(
            "{} is not a scheduled function.",
            view.name
        )));
    }
    if !runtime.background_enabled() {
        return Err(paused(
            "Background triggers are paused, so the tick was not published.",
        ));
    }
    if let Some(pubsub) = &state.pubsub {
        // The clock's own tick through the scheduler: the same message to
        // the same topic, delivered to every function listening on it, and
        // recorded as a run in Pub/Sub › Schedules.
        let pubsub = pubsub.get()?;
        let topic = schedule_topic(&state.project, &view.name);
        let message_id = match pubsub.runtime.run(&id) {
            Ok(outcome) => outcome.message_id,
            Err(RunScheduleError::BackgroundPaused) => {
                return Err(paused(
                    "Background triggers are paused, so the tick was not published.",
                ));
            }
            Err(RunScheduleError::Publish(message)) => {
                return Err(ApiError::unavailable(format!(
                    "Pub/Sub refused the tick: {message}"
                )));
            }
            // A schedule the scheduler does not hold yet (its inventory is
            // refreshed after a load): the clock's message, published directly.
            Err(RunScheduleError::NotScheduled) => {
                publish_to(&state, &topic, json!({ "data": BASE64.encode(b"{}") })).await?
            }
        };
        return Ok(Json(FunctionBrokerResult {
            transport: FunctionBrokerTransport::Pubsub,
            target: Some(EntityRef::pubsub_message(&topic, &message_id)),
            topic: Some(topic),
            message_id: Some(message_id),
            queue: None,
            task: None,
            invocation: None,
        }));
    }
    // No Pub/Sub, no scheduler: the official functions shell's schedule
    // envelope, straight to the trigger route.
    let (body, headers) = schedule_envelope(&view, &state.project);
    let stream = runtime
        .dispatch(
            &id,
            DispatchInput {
                target: DispatchTarget::Trigger,
                headers,
                body: Bytes::from(serde_json::to_vec(&body).unwrap_or_default()),
                origin: InvocationOrigin::Console,
                replay_of: None,
            },
        )
        .await
        .map_err(console_error)?;
    Ok(Json(FunctionBrokerResult {
        transport: FunctionBrokerTransport::Direct,
        topic: None,
        message_id: None,
        queue: None,
        task: None,
        target: None,
        invocation: Some(stream.invocation),
    }))
}

#[derive(Debug, Deserialize)]
struct TriggersParams {
    service: String,
    #[serde(default)]
    resource: String,
    #[serde(default)]
    event: Option<String>,
}

async fn triggers(
    State(state): State<ComputeState>,
    Query(params): Query<TriggersParams>,
) -> Result<Json<FunctionTriggersResult>, ApiError> {
    let query = TriggersQuery::parse(&params.service, &params.resource, params.event.as_deref())
        .map_err(ApiError::invalid)?;
    let runtime = state.runtime()?;
    let functions = runtime
        .triggers(&query)
        .await
        .into_iter()
        .map(|listener| FunctionListener {
            function: EntityRef::function(&listener.function_id),
            function_id: listener.function_id,
            codebase: listener.codebase,
            event_type: listener.event_type,
            kind: listener.kind,
        })
        .collect();
    Ok(Json(FunctionTriggersResult {
        functions,
        background_enabled: runtime.background_enabled(),
    }))
}

async fn match_triggers(
    State(state): State<ComputeState>,
    ConsoleJson(request): ConsoleJson<FunctionMatchRequest>,
) -> Result<Json<FunctionMatchResult>, ApiError> {
    let runtime = state.runtime()?;
    let input = match_input(request)?;
    let matches = runtime
        .match_triggers(&input)
        .await
        .into_iter()
        .map(|view| FunctionMatch {
            function: EntityRef::function(&view.function_id),
            function_id: view.function_id,
            change: view.change,
            fires: view.fires,
            reason: view.reason,
        })
        .collect();
    Ok(Json(FunctionMatchResult {
        matches,
        background_enabled: runtime.background_enabled(),
    }))
}

#[derive(Debug, Default, Deserialize)]
struct InvocationsParams {
    #[serde(default)]
    q: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
    #[serde(default)]
    cursor: Option<String>,
}

/// Where a page of invocations continues: older than `before`, in the run
/// whose ids carry `nonce`.
#[derive(Debug, Serialize, Deserialize)]
struct InvocationCursor {
    nonce: String,
    before: u64,
}

async fn invocations(
    State(state): State<ComputeState>,
    Query(params): Query<InvocationsParams>,
) -> Result<Json<InvocationsResult>, ApiError> {
    let filter = invocation_filter(params.q.as_deref().unwrap_or_default())?;
    let monitor = state.monitor();
    let before = match params.cursor.as_deref() {
        Some(cursor) => {
            let cursor: InvocationCursor = decode_cursor(cursor)?;
            if cursor.nonce != monitor.nonce() {
                return Err(ApiError::invalid(
                    "This cursor is from an earlier start of the engine.",
                )
                .with_fix("Load the list again from its first page."));
            }
            Some(cursor.before)
        }
        None => None,
    };
    let limit = params.limit.unwrap_or(DEFAULT_PAGE).clamp(1, MAX_PAGE);
    let query = InvocationQuery {
        filter: filter
            .as_deref()
            .map(|filter| filter as &(dyn Fn(&InvocationSummary) -> bool + Sync)),
        limit,
    };
    let first = before.is_none();
    let (found, live_cursor) = monitor.snapshot(|view| {
        (
            view.invocations(&query, before),
            first.then(|| state.live.functions.position().to_string()),
        )
    });
    let nonce = monitor.nonce().to_owned();
    let mut builder = PageBuilder::new(limit);
    let offered = found.items.len();
    let mut added = 0;
    for summary in found.items {
        let key = InvocationCursor {
            nonce: nonce.clone(),
            before: summary.seq,
        };
        if !builder.push(summary, key) {
            break;
        }
        added += 1;
    }
    let more = found.next.is_some() || added < offered;
    Ok(Json(InvocationsResult {
        page: builder.finish(
            more,
            false,
            Some(Total {
                count: found.total,
                exact: true,
            }),
            None,
        ),
        live_cursor,
    }))
}

async fn clear_invocations(
    State(state): State<ComputeState>,
    ConsoleJson(NoBody {}): ConsoleJson<NoBody>,
) -> StatusCode {
    state.monitor().clear_invocations();
    StatusCode::NO_CONTENT
}

async fn invocation(
    State(state): State<ComputeState>,
    Path(id): Path<String>,
) -> Result<Json<InvocationView>, ApiError> {
    let monitor = state.monitor();
    let detail = monitor
        .invocation(&id)
        .ok_or_else(|| not_kept(monitor, &id))?;
    Ok(Json(invocation_view(&state, detail).await))
}

async fn reveal_header(
    State(state): State<ComputeState>,
    Path((id, name)): Path<(String, String)>,
) -> Result<Json<FunctionRevealedValue>, ApiError> {
    let monitor = state.monitor();
    if !kept(monitor, &id) {
        return Err(not_kept(monitor, &id));
    }
    monitor
        .header(&id, &name)
        .map(|value| Json(FunctionRevealedValue { value }))
        .ok_or_else(|| ApiError::not_found(format!("The request had no {name} header.")))
}

async fn recorded_body(
    State(state): State<ComputeState>,
    Path((id, part)): Path<(String, String)>,
) -> Result<Response, ApiError> {
    let monitor = state.monitor();
    if !kept(monitor, &id) {
        return Err(not_kept(monitor, &id));
    }
    let body = match part.as_str() {
        "request" => monitor.request_body(&id),
        "response" => monitor.response_body(&id),
        other => {
            return Err(ApiError::not_found(format!(
                "An invocation has a request and a response body, not \"{other}\"."
            )));
        }
    }
    .ok_or_else(|| ApiError::not_found(format!("This invocation kept no {part} body.")))?;
    let content_type = body
        .content_type
        .clone()
        .unwrap_or_else(|| "application/octet-stream".to_owned());
    let extension = if content_type.contains("json") {
        "json"
    } else if content_type.starts_with("text/") {
        "txt"
    } else {
        "bin"
    };
    let mut response = (
        attachment(&format!("invocation-{id}-{part}.{extension}")),
        body.bytes,
    )
        .into_response();
    if let Ok(value) = HeaderValue::from_str(&content_type) {
        response.headers_mut().insert(header::CONTENT_TYPE, value);
    }
    Ok(response)
}

async fn replay(
    State(state): State<ComputeState>,
    Path(id): Path<String>,
    ConsoleJson(NoBody {}): ConsoleJson<NoBody>,
) -> Result<Response, ApiError> {
    let runtime = state.runtime()?;
    let monitor = state.monitor();
    if !kept(monitor, &id) {
        return Err(not_kept(monitor, &id));
    }
    let stream = runtime.replay(&id).await.map_err(console_error)?;
    Ok(frames_response(&state, stream))
}

async fn load_log(
    State(state): State<ComputeState>,
    Path(codebase): Path<String>,
) -> Result<Json<FunctionLoadLog>, ApiError> {
    let (lines, live_cursor) = state.monitor().snapshot(|view| {
        (
            view.load_log(&codebase, None),
            state.live.functions.position().to_string(),
        )
    });
    let lines = lines.ok_or_else(|| no_codebase(&codebase))?;
    Ok(Json(FunctionLoadLog { lines, live_cursor }))
}

async fn reveal_secret(
    State(state): State<ComputeState>,
    Path((codebase, key)): Path<(String, String)>,
) -> Result<Json<FunctionRevealedValue>, ApiError> {
    let runtime = state.runtime()?;
    if state.monitor().codebase(&codebase).is_none() {
        return Err(no_codebase(&codebase));
    }
    runtime
        .secret(&codebase, &key)
        .await
        .map(|value| Json(FunctionRevealedValue { value }))
        .ok_or_else(|| ApiError::not_found(format!("{codebase} has no secret {key}.")))
}

async fn edit_env(
    State(state): State<ComputeState>,
    Path(codebase): Path<String>,
    ConsoleJson(request): ConsoleJson<FunctionEnvEditRequest>,
) -> Result<Json<FunctionEnvEditResult>, ApiError> {
    let runtime = state.runtime()?;
    let changes = request
        .changes
        .into_iter()
        .map(|change| EnvChange {
            file: match change.file {
                FunctionEnvFile::Env => EnvFile::Env,
                FunctionEnvFile::EnvProject => EnvFile::EnvProject,
                FunctionEnvFile::EnvAlias => EnvFile::EnvAlias,
                FunctionEnvFile::EnvLocal => EnvFile::EnvLocal,
                FunctionEnvFile::SecretLocal => EnvFile::SecretLocal,
            },
            key: change.key,
            value: change.value,
        })
        .collect();
    let written = runtime
        .edit_env(&codebase, changes)
        .await
        .map_err(console_error)?;
    let codebase = state
        .monitor()
        .codebase(&codebase)
        .ok_or_else(|| no_codebase(&codebase))?;
    Ok(Json(FunctionEnvEditResult { written, codebase }))
}

async fn reload(
    State(state): State<ComputeState>,
    Path(codebase): Path<String>,
    ConsoleJson(NoBody {}): ConsoleJson<NoBody>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let runtime = state.runtime()?;
    let entry = state
        .monitor()
        .codebase(&codebase)
        .ok_or_else(|| no_codebase(&codebase))?;
    if entry.kind == firenook_functions_runtime::monitor::FunctionCodebaseKind::Extension {
        return Err(ApiError::conflict(format!(
            "{codebase} is an extension instance; reload it in Extensions."
        )));
    }
    // The reload runs on its own; its progress and outcome arrive on
    // `functions.events` like any save's.
    tokio::spawn(async move {
        let _ = runtime.reload(&codebase).await;
    });
    Ok((StatusCode::ACCEPTED, Json(json!({}))))
}

async fn restart(
    State(state): State<ComputeState>,
    Path(codebase): Path<String>,
    ConsoleJson(NoBody {}): ConsoleJson<NoBody>,
) -> Result<Json<FunctionRestartResult>, ApiError> {
    let runtime = state.runtime()?;
    if state.monitor().codebase(&codebase).is_none() {
        return Err(no_codebase(&codebase));
    }
    let dropped = runtime
        .restart_worker(&codebase)
        .await
        .map_err(console_error)?;
    Ok(Json(FunctionRestartResult { dropped }))
}

// ── Helpers ──────────────────────────────────────────────────────────────

/// Whether the monitor still keeps invocation `id`, without copying its
/// record.
pub(crate) fn kept(monitor: &Monitor, id: &str) -> bool {
    monitor
        .seq_of(id)
        .and_then(|seq| monitor.summary(seq))
        .is_some()
}

fn no_codebase(codebase: &str) -> ApiError {
    ApiError::not_found(format!("There is no codebase {codebase}."))
}

fn paused(message: &str) -> ApiError {
    ApiError::conflict(message).with_fix("Resume background triggers.")
}

async fn function_view(runtime: &ConsoleHandle, id: &str) -> Result<FunctionView, ApiError> {
    runtime
        .function(id)
        .await
        .ok_or_else(|| ApiError::not_found(format!("There is no function {id}.")))
}

fn headers_of(headers: Vec<FunctionHeaderInput>) -> Vec<(String, String)> {
    headers
        .into_iter()
        .filter(|header| !header.name.trim().is_empty())
        .map(|header| (header.name.trim().to_owned(), header.value))
        .collect()
}

fn decode_body(text: &str, encoding: FunctionBodyEncoding) -> Result<Bytes, ApiError> {
    match encoding {
        FunctionBodyEncoding::Empty => Ok(Bytes::new()),
        FunctionBodyEncoding::Text => Ok(Bytes::copy_from_slice(text.as_bytes())),
        FunctionBodyEncoding::Base64 => BASE64
            .decode(text.trim())
            .map(Bytes::from)
            .map_err(|_| ApiError::invalid("The body is not valid Base64.")),
    }
}

/// Whether a kind receives events (a test event can be sent to it).
const fn is_background(kind: FunctionKind) -> bool {
    !matches!(
        kind,
        FunctionKind::Http | FunctionKind::Callable | FunctionKind::Tasks | FunctionKind::Blocking
    )
}

/// `queue:<project>-<region>-<name>`, the Cloud Tasks emulator's key.
fn queue_key(project: &str, region: &str, name: &str) -> String {
    format!("queue:{project}-{region}-{name}")
}

/// A schedule's synthetic topic, as the scheduler publishes to it.
fn schedule_topic(project: &str, name: &str) -> String {
    format!("projects/{project}/topics/firebase-schedule-{name}")
}

/// The official functions shell's schedule envelope (`scheduleEnvelope` in
/// the CLI's `functions:invoke`): a legacy event on the schedule's topic
/// for a first-generation function, a `CloudEvent` with Cloud Scheduler's
/// headers for a second-generation one.
fn schedule_envelope(view: &FunctionView, project: &str) -> (Value, Vec<(String, String)>) {
    let now = time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default();
    let event_type = view
        .definition
        .get("eventTrigger")
        .and_then(|event| event.get("eventType"))
        .and_then(Value::as_str)
        .unwrap_or("pubsub")
        .to_owned();
    let id = random_uuid();
    let headers = vec![("content-type".to_owned(), "application/json".to_owned())];
    if view.platform != "gcfv2" {
        return (
            json!({
                "eventId": id,
                "timestamp": now,
                "eventType": event_type,
                "resource": schedule_topic(project, &view.name),
                "auth": { "admin": false },
                "data": {},
            }),
            headers,
        );
    }
    let mut headers = headers;
    headers.push((
        "x-cloudscheduler-jobname".to_owned(),
        format!("firebase-schedule-{}-{}", view.name, view.region),
    ));
    headers.push(("x-cloudscheduler-scheduletime".to_owned(), now.clone()));
    (
        json!({
            "specversion": "1.0",
            "datacontenttype": "application/json",
            "id": id,
            "type": event_type,
            "time": now,
            "source": "",
            "data": {},
        }),
        headers,
    )
}

/// Publishes one message on `topic` through the running Pub/Sub emulator's
/// own HTTP/JSON surface (so its fanout records it like an app's publish);
/// answers the message id.
async fn publish_to(state: &ComputeState, topic: &str, message: Value) -> Result<String, ApiError> {
    let Some(pubsub) = &state.pubsub else {
        return Err(
            ApiError::unavailable("Pub/Sub is not running in this suite.")
                .with_fix("Use Send to this function only, or start the suite with Pub/Sub."),
        );
    };
    let pubsub = pubsub.get()?;
    let (status, answer) = call_native(
        &pubsub.native,
        Method::POST,
        &format!("/v1/{topic}:publish"),
        &json!({ "messages": [message] }),
    )
    .await?;
    if status != StatusCode::OK {
        let message = native_message(&answer);
        return Err(match status {
            StatusCode::NOT_FOUND => {
                ApiError::not_found(format!("Pub/Sub has no topic {topic}: {message}"))
            }
            StatusCode::BAD_REQUEST => ApiError::invalid(message),
            _ => ApiError::unavailable(format!("Pub/Sub refused the message: {message}")),
        });
    }
    serde_json::from_slice::<Value>(&answer)
        .ok()
        .and_then(|value| value["messageIds"][0].as_str().map(str::to_owned))
        .ok_or_else(|| ApiError::internal("Pub/Sub accepted the message but named no message id."))
}

/// One JSON request to a service's own application; its status and body.
async fn call_native(
    native: &Router,
    method: Method,
    path: &str,
    body: &Value,
) -> Result<(StatusCode, Bytes), ApiError> {
    let request = Request::builder()
        .method(method)
        .uri(path)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_string()))
        .map_err(|error| ApiError::internal(error.to_string()))?;
    let response = match native.clone().oneshot(request).await {
        Ok(response) => response,
        Err(never) => match never {},
    };
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 4 * 1024 * 1024)
        .await
        .map_err(|error| ApiError::unavailable(error.to_string()))?;
    Ok((status, bytes))
}

/// The message of a service's error answer: `{"error":{"message"}}`,
/// `{"error":"…"}` or its text.
fn native_message(body: &[u8]) -> String {
    let text = String::from_utf8_lossy(body).trim().to_owned();
    serde_json::from_str::<Value>(&text)
        .ok()
        .and_then(|value| match &value["error"] {
            Value::String(message) => Some(message.clone()),
            Value::Object(error) => error
                .get("message")
                .and_then(Value::as_str)
                .map(str::to_owned),
            _ => None,
        })
        .unwrap_or(text)
}

fn match_input(request: FunctionMatchRequest) -> Result<MatchInput, ApiError> {
    Ok(match request {
        FunctionMatchRequest::Firestore {
            database,
            path,
            changes,
        } => MatchInput::Firestore {
            database,
            path,
            changes: changes
                .into_iter()
                .map(|change| match change {
                    FunctionFirestoreChange::Created => FirestoreChange::Created,
                    FunctionFirestoreChange::Updated => FirestoreChange::Updated,
                    FunctionFirestoreChange::Deleted => FirestoreChange::Deleted,
                })
                .collect(),
        },
        FunctionMatchRequest::Storage { bucket, events } => MatchInput::Storage {
            bucket,
            events: events
                .into_iter()
                .map(|event| match event {
                    FunctionStorageEvent::Finalized => StorageEvent::Finalized,
                    FunctionStorageEvent::Deleted => StorageEvent::Deleted,
                    FunctionStorageEvent::MetadataUpdated => StorageEvent::MetadataUpdated,
                    FunctionStorageEvent::Archived => StorageEvent::Archived,
                })
                .collect(),
        },
        FunctionMatchRequest::Auth { tenant, events } => MatchInput::Auth {
            tenant: tenant.filter(|tenant| !tenant.is_empty()),
            events: events
                .into_iter()
                .map(|event| match event {
                    FunctionAuthEvent::Create => AuthEvent::Create,
                    FunctionAuthEvent::Delete => AuthEvent::Delete,
                    FunctionAuthEvent::BeforeCreate => AuthEvent::BeforeCreate,
                    FunctionAuthEvent::BeforeSignIn => AuthEvent::BeforeSignIn,
                })
                .collect(),
        },
        FunctionMatchRequest::Pubsub { topic } => {
            if !topic.starts_with("projects/") || !topic.contains("/topics/") {
                return Err(ApiError::invalid(
                    "The topic is a full name, projects/<project>/topics/<topic>.",
                ));
            }
            MatchInput::Pubsub { topic }
        }
        FunctionMatchRequest::Eventarc {
            channel,
            event_type,
            attributes,
        } => MatchInput::Eventarc {
            channel,
            event_type,
            attributes,
        },
        FunctionMatchRequest::Tasks { queue } => MatchInput::Tasks { queue },
    })
}

/// A dispatch as NDJSON frames: `started`, `head`, `chunk`s (the first
/// 4 MiB), `truncated` when there was more, `finished`; `failed` when the
/// call ended without an answer. The dispatch keeps running and recording
/// when the browser stops reading.
fn frames_response(state: &ComputeState, stream: DispatchStream) -> Response {
    ndjson_response(
        invocation_frames(stream, state.monitor().clone()),
        state.shutdown.clone(),
    )
}

/// The frames of one dispatch.
pub(crate) fn invocation_frames(
    stream: DispatchStream,
    monitor: Monitor,
) -> impl Stream<Item = InvocationFrame> + Send + 'static {
    let started = InvocationFrame::Started {
        invocation: stream.invocation.clone(),
    };
    let reader = FrameReader {
        id: stream.invocation.id.clone(),
        frames: stream.frames,
        monitor,
        forwarded: 0,
        total: 0,
        carry: Vec::new(),
        pending: std::collections::VecDeque::new(),
        done: false,
    };
    stream::once(async move { started }).chain(stream::unfold(reader, |mut reader| async move {
        reader.next().await.map(|frame| (frame, reader))
    }))
}

struct FrameReader {
    id: String,
    frames: tokio::sync::mpsc::Receiver<DispatchFrame>,
    monitor: Monitor,
    forwarded: u64,
    total: u64,
    /// The start of a UTF-8 character the previous chunk cut in two.
    carry: Vec<u8>,
    pending: std::collections::VecDeque<InvocationFrame>,
    done: bool,
}

impl FrameReader {
    async fn next(&mut self) -> Option<InvocationFrame> {
        loop {
            if let Some(frame) = self.pending.pop_front() {
                return Some(frame);
            }
            if self.done {
                return None;
            }
            match self.frames.recv().await {
                Some(DispatchFrame::Head { status, headers }) => {
                    return Some(InvocationFrame::Head { status, headers });
                }
                Some(DispatchFrame::Chunk(bytes)) => self.chunk(&bytes),
                Some(DispatchFrame::Finished(summary)) => self.finish(Some(*summary)),
                None => {
                    // The answer ended without its summary (the stream was
                    // cut): the record still says how it ended.
                    let summary = self
                        .monitor
                        .seq_of(&self.id)
                        .and_then(|seq| self.monitor.summary(seq))
                        .filter(|summary| summary.duration_ms.is_some());
                    self.finish(summary);
                }
            }
        }
    }

    fn chunk(&mut self, bytes: &[u8]) {
        self.total += bytes.len() as u64;
        if self.forwarded >= FORWARD_LIMIT {
            return;
        }
        let room = usize::try_from(FORWARD_LIMIT - self.forwarded).unwrap_or(usize::MAX);
        let taken = &bytes[..bytes.len().min(room)];
        self.forwarded += taken.len() as u64;
        if let Some((text, encoding)) = text_of(&mut self.carry, taken) {
            self.pending
                .push_back(InvocationFrame::Chunk { text, encoding });
        }
    }

    fn finish(&mut self, summary: Option<InvocationSummary>) {
        if !self.carry.is_empty() {
            let rest = std::mem::take(&mut self.carry);
            self.pending.push_back(InvocationFrame::Chunk {
                text: BASE64.encode(rest),
                encoding: FunctionBodyEncoding::Base64,
            });
        }
        if self.total > self.forwarded {
            self.pending
                .push_back(InvocationFrame::Truncated { total: self.total });
        }
        self.pending.push_back(match summary {
            Some(invocation) => InvocationFrame::Finished { invocation },
            None => InvocationFrame::Failed {
                message: "The call ended before the function answered.".to_owned(),
            },
        });
        self.done = true;
    }
}

/// `bytes` (after what `carry` held) as text when it is UTF-8, keeping a
/// character cut at the end for the next chunk; Base64 otherwise.
fn text_of(carry: &mut Vec<u8>, bytes: &[u8]) -> Option<(String, FunctionBodyEncoding)> {
    let mut buffer = std::mem::take(carry);
    buffer.extend_from_slice(bytes);
    if buffer.is_empty() {
        return None;
    }
    match std::str::from_utf8(&buffer) {
        Ok(text) => Some((text.to_owned(), FunctionBodyEncoding::Text)),
        Err(error) if error.error_len().is_none() => {
            let valid = error.valid_up_to();
            *carry = buffer[valid..].to_vec();
            (valid > 0).then(|| {
                (
                    String::from_utf8_lossy(&buffer[..valid]).into_owned(),
                    FunctionBodyEncoding::Text,
                )
            })
        }
        Err(_) => Some((BASE64.encode(&buffer), FunctionBodyEncoding::Base64)),
    }
}

// ── Mapping ──────────────────────────────────────────────────────────────

/// The list row of one function.
pub(crate) fn summary_of(
    view: &FunctionView,
    counters: FunctionStats,
    suite: &ComputeSuite,
    project: &str,
) -> FunctionSummary {
    let service = hub_service(view);
    let (status, status_reason) = status_of(view, service, suite);
    FunctionSummary {
        id: view.id.clone(),
        name: view.name.clone(),
        entry_point: view.entry_point.clone(),
        region: view.region.clone(),
        platform: if view.platform == "gcfv2" {
            FunctionPlatform::Gcfv2
        } else {
            FunctionPlatform::Gcfv1
        },
        codebase: view.codebase.clone(),
        extension_instance: view.extension_instance.clone(),
        extension: view
            .extension_instance
            .as_deref()
            .map(EntityRef::extension_instance),
        kind: view.kind,
        trigger: trigger_of(&view.definition, project),
        status,
        status_reason,
        service: service.map(str::to_owned),
        url: view.path.as_ref().map(|path| match &suite.address {
            Some(address) => format!("{}{path}", address.trim_end_matches('/')),
            None => path.clone(),
        }),
        timeout_seconds: u32::try_from(view.timeout_seconds).unwrap_or(u32::MAX),
        secrets: view
            .secrets
            .iter()
            .map(|secret| FunctionSecret {
                key: secret.key.clone(),
                secret: secret.secret.clone(),
                provided: secret.provided,
            })
            .collect(),
        stats: counters,
    }
}

/// The extensions' task-queue functions, as `(instance, resource)`: the
/// emulator copies no trigger for them (the recorded official behaviour), so
/// the runtime sees a function with none; the instance's spec still says
/// what each one is.
async fn extension_task_queues(control: Option<&ComputeControl>) -> HashSet<(String, String)> {
    let mut queues = HashSet::new();
    let Some(extensions) = control.and_then(|control| control.extensions.as_ref()) else {
        return queues;
    };
    for (id, instance) in extensions.instances().await {
        let Some(loaded) = &instance.loaded else {
            continue;
        };
        let resources = loaded.spec.get("resources").and_then(Value::as_array);
        for resource in resources.into_iter().flatten() {
            if resource.pointer("/properties/taskQueueTrigger").is_none() {
                continue;
            }
            if let Some(name) = resource.get("name").and_then(Value::as_str) {
                queues.insert((id.clone(), name.to_owned()));
            }
        }
    }
    queues
}

/// An extension's task-queue function as the Functions pages say it: a task
/// queue, and why nothing reaches it (the runtime's own reason names an
/// "unknown emulator").
fn extension_task_queue(
    summary: &mut FunctionSummary,
    view: &FunctionView,
    queues: &HashSet<(String, String)>,
) {
    let Some(instance) = &view.extension_instance else {
        return;
    };
    if !queues.contains(&(instance.clone(), view.entry_point.clone())) {
        return;
    }
    summary.kind = FunctionKind::Tasks;
    if summary.status != FunctionStatus::Receiving {
        summary.status_reason = Some(TASK_QUEUE_NOTE.to_owned());
    }
}

/// The hub service a function's events come from.
fn hub_service(view: &FunctionView) -> Option<&'static str> {
    match view.kind {
        FunctionKind::Schedule => return Some("pubsub"),
        FunctionKind::Blocking => return Some("auth"),
        _ => {}
    }
    match view.service.as_str() {
        "firestore.googleapis.com" => Some("firestore"),
        "storage.googleapis.com" => Some("storage"),
        "firebaseauth.googleapis.com" => Some("auth"),
        "pubsub.googleapis.com" => Some("pubsub"),
        _ => None,
    }
}

fn service_label(service: &str) -> &'static str {
    match service {
        "firestore" => "Firestore",
        "storage" => "Storage",
        "auth" => "Authentication",
        _ => "Pub/Sub",
    }
}

/// The function's status and, unless it receives, why not.
fn status_of(
    view: &FunctionView,
    service: Option<&str>,
    suite: &ComputeSuite,
) -> (FunctionStatus, Option<String>) {
    match &view.status {
        RuntimeStatus::Ignored(reason) => (
            FunctionStatus::Ignored,
            Some(if view.kind == FunctionKind::Alerts {
                "Firebase Alerts are not delivered by this engine yet.".to_owned()
            } else {
                reason.clone()
            }),
        ),
        RuntimeStatus::Paused => (
            FunctionStatus::Paused,
            Some("Background triggers are paused, so this function receives no events.".to_owned()),
        ),
        RuntimeStatus::Removed => (
            FunctionStatus::Removed,
            Some("A reload removed this function: the code no longer exports it.".to_owned()),
        ),
        RuntimeStatus::Receiving => match service.filter(|service| !suite.runs(service)) {
            Some(service) => (
                FunctionStatus::NoService,
                Some(match view.kind {
                    FunctionKind::Schedule => {
                        "Pub/Sub is not running in this suite, so this schedule does not run on its own; Run now still calls it.".to_owned()
                    }
                    FunctionKind::Blocking => {
                        "Authentication is not running in this suite, so nothing calls this blocking function.".to_owned()
                    }
                    _ => format!("{} is not running in this suite.", service_label(service)),
                }),
            ),
            None => (FunctionStatus::Receiving, None),
        },
    }
}

fn string_at(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

fn string_map(value: Option<&Value>) -> BTreeMap<String, String> {
    value
        .and_then(Value::as_object)
        .map(|map| {
            map.iter()
                .filter_map(|(key, value)| {
                    let value = match value {
                        Value::String(text) => text.clone(),
                        Value::Null => return None,
                        other => other.to_string(),
                    };
                    Some((key.clone(), value))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// A definition's trigger, flattened for reading.
pub(crate) fn trigger_of(definition: &Value, project: &str) -> FunctionTrigger {
    let mut trigger = FunctionTrigger::default();
    if let Some(event) = definition.get("eventTrigger") {
        trigger.event_type = string_at(event, "eventType");
        trigger.resource = string_at(event, "resource");
        trigger.channel = string_at(event, "channel");
        trigger.retry = event.get("retry").and_then(Value::as_bool);
        trigger.filters = string_map(event.get("eventFilters"));
        trigger.path_patterns = string_map(event.get("eventFilterPathPatterns"));
        let event_type = trigger.event_type.clone().unwrap_or_default();
        let resource = trigger.resource.clone().unwrap_or_default();
        if event_type.contains("firestore") {
            let (database, document) = match resource.split_once("/documents/") {
                Some((prefix, document)) => (
                    prefix.rsplit('/').next().map(str::to_owned),
                    Some(document.to_owned()),
                ),
                None => (None, None),
            };
            trigger.database = trigger
                .filters
                .get("database")
                .cloned()
                .or(database)
                .or_else(|| Some("(default)".to_owned()));
            let pattern = trigger.path_patterns.get("document").cloned();
            trigger.match_type = Some(
                if pattern.is_some()
                    || document
                        .as_deref()
                        .is_some_and(|document| document.contains('{'))
                {
                    "pattern"
                } else {
                    "exact"
                }
                .to_owned(),
            );
            trigger.document = pattern
                .or_else(|| trigger.filters.get("document").cloned())
                .or(document);
        }
        if event_type.contains("storage") {
            trigger.bucket = trigger.filters.get("bucket").cloned().or_else(|| {
                resource
                    .strip_prefix("projects/_/buckets/")
                    .map(|rest| rest.split('/').next().unwrap_or(rest).to_owned())
            });
        }
        if event_type.contains("pubsub") {
            let topic = trigger
                .filters
                .get("topic")
                .cloned()
                .or_else(|| resource.contains("/topics/").then(|| resource.clone()));
            trigger.topic = topic.map(|topic| {
                if topic.starts_with("projects/") {
                    topic
                } else {
                    format!("projects/{project}/topics/{topic}")
                }
            });
        }
    }
    let schedule = definition
        .get("schedule")
        .or_else(|| definition.get("scheduleTrigger"));
    if let Some(schedule) = schedule {
        trigger.schedule = string_at(schedule, "schedule");
        trigger.time_zone = string_at(schedule, "timeZone");
    }
    if let Some(blocking) = definition.get("blockingTrigger") {
        trigger.event_type = string_at(blocking, "eventType");
        trigger.blocking_event = trigger
            .event_type
            .as_deref()
            .and_then(|event_type| event_type.rsplit('.').next())
            .map(str::to_owned);
    }
    if let Some(https) = definition.get("httpsTrigger") {
        trigger.invoker = https
            .get("invoker")
            .and_then(Value::as_array)
            .map(|invokers| {
                invokers
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default();
    }
    trigger
}

fn environment_of(view: EnvironmentView) -> FunctionEnvironment {
    FunctionEnvironment {
        files: view.files,
        variables: view
            .variables
            .into_iter()
            .map(|variable| FunctionEnvVariable {
                key: variable.key,
                value: variable.value,
                secret: variable.secret,
                source: match variable.source {
                    EnvSource::DotEnv => FunctionEnvSource::DotEnv,
                    EnvSource::SecretLocal => FunctionEnvSource::SecretLocal,
                    EnvSource::Emulator => FunctionEnvSource::Emulator,
                    EnvSource::ExtensionParam => FunctionEnvSource::ExtensionParam,
                },
                file: variable.file.map(|file| match file {
                    EnvFile::Env => FunctionEnvFile::Env,
                    EnvFile::EnvProject => FunctionEnvFile::EnvProject,
                    EnvFile::EnvAlias => FunctionEnvFile::EnvAlias,
                    EnvFile::EnvLocal => FunctionEnvFile::EnvLocal,
                    EnvFile::SecretLocal => FunctionEnvFile::SecretLocal,
                }),
                file_name: variable.file_name,
            })
            .collect(),
        inherited: view.inherited,
        editable: view.editable,
    }
}

fn param_of(param: &ParamView) -> FunctionParam {
    FunctionParam {
        name: param.name.clone(),
        param_type: param.param_type.clone(),
        label: param.label.clone(),
        default: param.default.as_ref().map(|value| match value {
            Value::String(text) => text.clone(),
            other => other.to_string(),
        }),
        description: param.description.clone(),
        value: param.value.clone(),
        secret: param.secret,
        file: param.file.clone(),
        unresolved: param.unresolved,
    }
}

/// What the emulator does instead of a declared option.
fn declared_note(name: &str) -> &'static str {
    match name {
        "availableMemoryMb" => "Not limited here: one Node worker serves the whole codebase.",
        "minInstances" | "maxInstances" => {
            "Not applied here: one Node worker serves the whole codebase."
        }
        "concurrency" => "Not applied here: calls run concurrently in the codebase's worker.",
        "cpu" => "Not applied here: the worker uses this machine's CPUs.",
        "serviceAccount" | "serviceAccountEmail" => {
            "Not applied here: functions run with the emulator's demo credentials."
        }
        "vpc" => "Not applied here: the worker uses this machine's network.",
        "ingressSettings" => "Not applied here: every local request reaches the function.",
        _ => "Declared, not applied by the emulator.",
    }
}

fn schedule_of(
    view: &FunctionView,
    counters: &FunctionStats,
    state: &ComputeState,
) -> FunctionSchedule {
    let schedule = view
        .definition
        .get("schedule")
        .or_else(|| view.definition.get("scheduleTrigger"));
    let retry = schedule.and_then(|schedule| schedule.get("retryConfig").cloned());
    let recorded = counters.last.as_ref().map(|last| last.started_at.clone());
    // The scheduler's own view when Pub/Sub runs: the zone it evaluates the
    // expression in, whether the clock runs it, its pause, its next tick.
    let scheduler = state
        .pubsub
        .as_ref()
        .and_then(|pubsub| pubsub.get().ok())
        .and_then(|pubsub| pubsub.runtime.schedule(&view.id));
    if let Some(scheduled) = scheduler {
        return FunctionSchedule {
            expression: scheduled.expression,
            time_zone: scheduled.time_zone,
            topic: scheduled.topic,
            evaluated_in: Some(scheduled.evaluated_in),
            automatic: scheduled.automatic,
            manual_reason: scheduled.problem,
            paused: scheduled.paused,
            next_run: scheduled
                .next_run_at
                .map(|at| format_timestamp(SystemTime::from(at))),
            last_run: scheduled
                .last_run
                .map(|run| format_timestamp(SystemTime::from(run.at)))
                .or(recorded),
            pubsub: true,
            schedule_ref: Some(EntityRef::pubsub_schedule(&view.id)),
            retry,
        };
    }
    let pubsub = state.pubsub.is_some();
    FunctionSchedule {
        expression: schedule
            .and_then(|schedule| string_at(schedule, "schedule"))
            .unwrap_or_default(),
        time_zone: schedule.and_then(|schedule| string_at(schedule, "timeZone")),
        topic: schedule_topic(&state.project, &view.name),
        evaluated_in: None,
        automatic: false,
        manual_reason: Some(if pubsub {
            "Pub/Sub is still starting.".to_owned()
        } else {
            "Pub/Sub is not running in this suite.".to_owned()
        }),
        paused: false,
        next_run: None,
        last_run: recorded,
        pubsub,
        schedule_ref: pubsub.then(|| EntityRef::pubsub_schedule(&view.id)),
        retry,
    }
}

fn task_queue_of(view: &FunctionView, state: &ComputeState) -> FunctionTaskQueue {
    let trigger = view
        .definition
        .get("taskQueueTrigger")
        .cloned()
        .unwrap_or(Value::Null);
    let queue = queue_key(&state.project, &view.region, &view.name);
    // What the Cloud Tasks emulator holds of it: whether it refused the
    // queue (and why), and whether it holds scheduled tasks until they are due.
    let tasks = state.tasks.as_ref().and_then(|tasks| tasks.get().ok());
    let refused = tasks.as_ref().and_then(|tasks| {
        tasks
            .runtime
            .queues_view(Some(&state.project))
            .rejected
            .into_iter()
            .find(|rejected| rejected.function_id == view.id)
            .map(|rejected| rejected.reason)
    });
    let hold_scheduled = tasks.as_ref().is_some_and(|tasks| {
        tasks
            .runtime
            .queue_view(&queue)
            .is_some_and(|held| held.hold_scheduled)
    });
    FunctionTaskQueue {
        queue,
        queue_ref: state
            .tasks
            .is_some()
            .then(|| EntityRef::tasks_queue(&state.project, &view.region, &view.name)),
        retry_config: trigger.get("retryConfig").cloned().unwrap_or(Value::Null),
        rate_limits: trigger.get("rateLimits").cloned().unwrap_or(Value::Null),
        refused,
        hold_scheduled,
    }
}

/// An invocation with the refs of what it points at.
pub(crate) async fn invocation_view(
    state: &ComputeState,
    detail: InvocationDetail,
) -> InvocationView {
    let summary = &detail.summary;
    let mut refs = vec![EntityRef::function(&summary.function_id)];
    match &summary.cause {
        InvocationCause::Http { .. } | InvocationCause::Unknown | InvocationCause::Alert { .. } => {
        }
        InvocationCause::Callable { uid, tenant, .. }
        | InvocationCause::Auth { uid, tenant, .. } => {
            if let Some(uid) = uid {
                refs.push(EntityRef::auth_user(tenant.as_deref(), uid));
            }
        }
        InvocationCause::Firestore {
            database, document, ..
        } => refs.push(EntityRef::firestore_document(database, document)),
        InvocationCause::Storage { bucket, object, .. } => {
            refs.push(EntityRef::storage_object(bucket, object));
        }
        InvocationCause::Pubsub {
            topic, message_id, ..
        } => {
            if let Some(id) = message_id {
                refs.push(EntityRef::pubsub_message(topic, id));
            }
            refs.push(EntityRef::pubsub_topic(topic));
        }
        InvocationCause::Schedule { .. } => {
            refs.push(EntityRef::pubsub_schedule(&summary.function_id));
        }
        InvocationCause::Eventarc { channel, event, .. } => {
            if let Some(event) = event {
                refs.push(EntityRef::eventarc_event(event));
            }
            refs.push(EntityRef::eventarc_channel(channel));
        }
        InvocationCause::Task { queue, task, .. } => {
            let function = match state.runtime() {
                Ok(runtime) => runtime.function(&summary.function_id).await,
                Err(_) => None,
            };
            if let Some(function) = function {
                // The attempt's task, by the console's id for it, while
                // Cloud Tasks still knows the name; the queue always.
                let id = state
                    .tasks
                    .as_ref()
                    .and_then(|tasks| tasks.get().ok())
                    .and_then(|tasks| tasks.task_id(queue, task));
                if let Some(id) = id {
                    refs.push(EntityRef::tasks_task(
                        &state.project,
                        &function.region,
                        &function.name,
                        &id,
                    ));
                }
                refs.push(EntityRef::tasks_queue(
                    &state.project,
                    &function.region,
                    &function.name,
                ));
            }
        }
        InvocationCause::Blocking {
            uid,
            tenant,
            auth_call,
            ..
        } => {
            if let Some(call) = auth_call {
                refs.push(EntityRef::auth_call(call));
            }
            if let Some(uid) = uid {
                refs.push(EntityRef::auth_user(tenant.as_deref(), uid));
            }
        }
    }
    if let Some(replayed) = &summary.replay_of {
        refs.push(EntityRef::invocation(replayed));
    }
    InvocationView { detail, refs }
}

#[cfg(test)]
#[path = "functions_tests.rs"]
mod tests;
