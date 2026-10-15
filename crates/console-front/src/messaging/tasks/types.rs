//! The Cloud Tasks console API's types, generated into
//! `console/src/api/generated/messaging/`. A queue travels by its engine
//! key (`queue:{project}-{location}-{queue}`), a task by the console's
//! decimal id; times are RFC 3339 with milliseconds.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::entity::EntityRef;
use crate::jobs::BulkTarget;
use crate::messaging::shared::{MessagingSecondWindow, MessagingTenSecondWindow};
use crate::paging::Page;

/// `GET /tasks/queues`: one page holding the project's queues, with extras.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct TasksQueueList {
    #[serde(flatten)]
    #[ts(flatten)]
    pub page: Page<TasksQueue>,
    pub project: String,
    /// Every project holding a registered queue, for the panel's project
    /// switch.
    pub projects: Vec<String>,
    /// `taskQueueTrigger`s the emulator refused, with its reason.
    pub rejected_registrations: Vec<TasksRejectedQueue>,
    /// Requests the Tasks port refused, coalesced.
    pub refused: Vec<TasksRefused>,
    /// The Tasks revision the list was read at; `tasks.counters` resumes
    /// from it.
    #[ts(type = "number")]
    pub revision: u64,
}

/// A queue registration the emulator refused.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct TasksRejectedQueue {
    pub function_id: String,
    pub name: String,
    pub region: String,
    pub reason: String,
    pub at: String,
}

/// A request the Tasks port refused, coalesced by operation, queue and
/// error.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct TasksRefused {
    pub first_at: String,
    pub last_at: String,
    pub count: u32,
    /// `enqueue` or `delete`.
    pub operation: String,
    pub project: String,
    pub location: String,
    pub queue: String,
    /// The status and body the client received, verbatim.
    pub status: u16,
    pub error: String,
    /// "processOrder is registered in us-central1", when it is elsewhere.
    pub suggestion: Option<String>,
}

/// Who registered a queue.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export_to = "messaging/")]
pub(crate) enum TasksQueueOrigin {
    /// Registered from an `onTaskDispatched` export.
    Function,
    /// Registered by a client's `POST /projects/…/queues/{q}`.
    Client,
}

/// The function a queue dispatches to.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct TasksQueueFunction {
    pub function_id: String,
    pub name: String,
    pub region: String,
    /// `functions.function`.
    pub function_ref: EntityRef,
    /// `functions.invocations` of this function: every attempt of the
    /// queue's tasks is one of them.
    pub invocations_ref: EntityRef,
}

/// The last time a re-registration replaced the queue.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct TasksReplaced {
    pub at: String,
    pub dropped: u32,
}

/// One queue.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct TasksQueue {
    /// `queue:{project}-{location}-{queue}`, the emulator's key; the
    /// console's address.
    pub key: String,
    /// The parts, as registered.
    pub project: String,
    pub location: String,
    pub id: String,
    pub origin: TasksQueueOrigin,
    pub function: Option<TasksQueueFunction>,
    pub default_uri: Option<String>,
    pub registered_at: String,
    /// Registrations under this key since start (1 after the first).
    pub registrations: u32,
    pub last_replaced: Option<TasksReplaced>,
    pub config: TasksQueueConfig,
    pub paused: bool,
    pub hold_scheduled: bool,
    pub counters: TasksQueueCounters,
    /// History ring state.
    pub history_capacity: u32,
    #[ts(type = "number")]
    pub history_dropped: u64,
}

/// One value of a queue's stored configuration.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct TasksConfigValue {
    /// Dotted key, `retryConfig.maxAttempts`.
    pub key: String,
    /// As stored (JSON text: `3`, `null`, `0.1`).
    pub value: String,
    /// Whether the registration body set it (else the emulator default).
    pub provided: bool,
    /// Stored but never used by the emulator (`timeoutSeconds`, `retry`).
    pub unused: bool,
}

/// The configuration in force.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct TasksQueueConfig {
    pub max_attempts: f64,
    pub max_retry_seconds: Option<f64>,
    pub min_backoff_seconds: f64,
    pub max_backoff_seconds: f64,
    pub max_doublings: f64,
    pub max_concurrent_dispatches: u32,
    pub max_dispatches_per_second: f64,
    /// Every key of the stored `taskQueueConfig`, in its order.
    pub values: Vec<TasksConfigValue>,
    /// The `taskQueueConfig` document as the emulator stores it.
    pub document: String,
    /// What a task that fails every time runs, from its first attempt: the
    /// dispatcher's own backoff and stop rule, with requests that take no
    /// time.
    pub ladder: Vec<TasksLadderStep>,
}

/// One rung of a queue's retry ladder.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct TasksLadderStep {
    pub attempt: u32,
    /// The backoff before it (0 for the first attempt).
    pub backoff_seconds: f64,
    /// When it runs at the earliest, counted from the first attempt.
    pub after_seconds: f64,
    /// The emulator gives up after this one.
    pub last: bool,
}

/// A queue's history by outcome, for the History tab's switch.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct TasksOutcomeCounts {
    pub succeeded: u32,
    pub failed: u32,
    pub cancelled: u32,
    pub deleted: u32,
    pub purged: u32,
    pub replaced: u32,
}

/// A queue's live figures.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct TasksQueueCounters {
    pub key: String,
    pub pending: u32,
    /// Pending tasks waiting for their schedule time (hold on).
    pub held: u32,
    /// In a slot, first attempt not yet sent.
    pub dispatching: u32,
    /// Request in flight.
    pub running: u32,
    /// In a slot, waiting for the next attempt.
    pub backoff: u32,
    pub slots: u32,
    pub slots_in_use: u32,
    /// The bucket at `refilledAt`; the console applies the refill rule.
    pub tokens: f64,
    pub max_tokens: f64,
    pub refilled_at: String,
    pub max_dispatches_per_second: f64,
    /// Stamped windows the console ages.
    pub dispatched: MessagingSecondWindow,
    pub succeeded: MessagingSecondWindow,
    pub failed: MessagingTenSecondWindow,
    pub added: MessagingTenSecondWindow,
    pub oldest_pending_at: Option<String>,
    pub history: u32,
    /// The history by outcome (they add up to `history`).
    pub outcomes: TasksOutcomeCounts,
}

/// Where a task is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export_to = "messaging/")]
pub(crate) enum TasksTaskState {
    Pending,
    /// Waiting for its schedule time (the queue holds scheduled tasks).
    Held,
    /// In a slot, first attempt not yet sent.
    Dispatching,
    /// Request in flight.
    Running,
    /// In a slot, waiting for the next attempt.
    Backoff,
    /// Left the queue: only a finished task's detail is in this state, never
    /// a list row.
    Finished,
}

/// A task body, as a list shows it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct TasksBodyPreview {
    pub json: bool,
    /// The first 256 characters of the `data` member when the body is
    /// `{"data": …}`, else of the body.
    pub text: String,
    pub truncated: bool,
    pub data_member: bool,
    #[ts(type = "number")]
    pub size: u64,
}

/// One row of a queue's live task list.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct TasksTaskRow {
    /// The row key `phase.id`, so a task that takes a slot is a new key.
    pub key: String,
    /// The console's id for the task, a decimal string as it travels in URLs.
    pub id: String,
    pub name: String,
    pub short_name: String,
    /// Auto-named by the emulator (a leading slash; the wire API cannot
    /// delete it).
    pub generated: bool,
    pub state: TasksTaskState,
    /// One-based place in the pending queue.
    pub position: Option<u32>,
    pub enqueued_at: String,
    /// `wire` or `console`.
    pub origin: String,
    /// `scheduleTime` as the client sent it.
    pub schedule_time: Option<String>,
    /// Its parsed instant, when it parses.
    pub due_at: Option<String>,
    pub attempt: u32,
    pub max_runs: Option<u32>,
    pub execution_count: u32,
    pub previous_response: Option<u16>,
    pub last_error: Option<String>,
    pub last_attempt_at: Option<String>,
    pub next_attempt_at: Option<String>,
    pub deadline_seconds: f64,
    pub url: Option<String>,
    pub body: TasksBodyPreview,
    /// Asked to stop after the attempt in flight.
    pub stop_requested: bool,
}

/// A request header.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "messaging/")]
pub(crate) struct TasksHeader {
    pub name: String,
    pub value: String,
}

/// One attempt of a task.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct TasksAttempt {
    pub attempt: u32,
    pub started_at: String,
    pub duration_ms: f64,
    pub status: Option<u16>,
    pub error: Option<String>,
    /// The first 1 KiB of the response body.
    pub response: Option<String>,
    /// Whether it raised the execution count (any non-5xx failure does).
    pub counted_execution: bool,
    /// The `X-CloudTasks-TaskRetryCount` it was sent with (matches compute's
    /// `cause.task.retryCount`).
    pub retry_count: u32,
    /// The invocation it caused (`functions.invocation`), while compute's
    /// record keeps it.
    pub invocation: Option<EntityRef>,
}

/// One attempt the emulator would still make if every attempt failed.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct TasksPlannedAttempt {
    pub attempt: u32,
    pub earliest_at: String,
    pub backoff_seconds: f64,
    pub last: bool,
}

/// How a task left its queue.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export_to = "messaging/")]
pub(crate) enum TasksOutcome {
    Succeeded,
    Failed,
    Cancelled,
    Deleted,
    Purged,
    /// Dropped when the queue re-registered with new options.
    Replaced,
}

/// When and how a task finished.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct TasksFinished {
    pub outcome: TasksOutcome,
    pub at: String,
    pub took_ms: f64,
}

/// `GET /tasks/task`: a task, pending, in a slot or finished.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct TasksTaskDetail {
    pub task: TasksTaskRow,
    pub headers: Vec<TasksHeader>,
    /// What the next (or last) attempt sends, `X-CloudTasks-*` included.
    pub dispatch_headers: Vec<TasksHeader>,
    pub body: String,
    /// The `data` member as JSON text, when the body is the Admin SDK's
    /// shape.
    pub data: Option<String>,
    /// Attempt 1 and the nine latest.
    pub attempts: Vec<TasksAttempt>,
    /// Attempts in between that were not kept.
    pub omitted_attempts: u32,
    pub retry_plan: Vec<TasksPlannedAttempt>,
    /// When the emulator gives up, in a sentence with the reason.
    pub stops: String,
    pub finished: Option<TasksFinished>,
}

/// One finished task of a queue's history.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct TasksHistoryRow {
    /// The finished sequence: the row key and the cursor.
    pub id: String,
    /// The task's console id.
    pub task_id: String,
    pub name: String,
    pub short_name: String,
    pub outcome: TasksOutcome,
    pub enqueued_at: String,
    pub finished_at: String,
    pub attempts: u32,
    pub last_status: Option<u16>,
    pub last_error: Option<String>,
    pub took_ms: f64,
    pub body: TasksBodyPreview,
}

/// `POST /tasks/tasks`: the one console enqueue path, held to the wire's
/// 100 KiB as the Admin SDK would send it.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "messaging/")]
pub(crate) struct TasksEnqueueBody {
    /// The queue key.
    pub queue: String,
    /// JSON text sent as `{"data": …}`, as `taskQueue().enqueue(data)` does.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub data: Option<String>,
    /// Or JSON text sent as the body as it is.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub raw_body: Option<String>,
    /// The task id (short); absent lets the emulator generate one.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub name: Option<String>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub headers: Vec<TasksHeader>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub schedule_delay_seconds: Option<f64>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub dispatch_deadline_seconds: Option<u32>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub url: Option<String>,
}

/// A queue by its key.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "messaging/")]
pub(crate) struct TasksQueueRef {
    pub queue: String,
}

/// A task by its queue key and console id.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "messaging/")]
pub(crate) struct TasksTaskRef {
    pub queue: String,
    pub id: String,
}

/// `POST /tasks/queue/purge`.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "messaging/")]
pub(crate) struct TasksPurgeBody {
    pub queue: String,
    /// Also stop retrying the tasks in a slot.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub stop_retrying: bool,
}

/// `POST /tasks/queue/hold`.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "messaging/")]
pub(crate) struct TasksHoldBody {
    pub queue: String,
    pub enabled: bool,
}

/// `POST /tasks/tasks:run` and `/tasks:delete`.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "messaging/")]
pub(crate) struct TasksBulkBody {
    pub queue: String,
    pub target: BulkTarget,
}

/// What a purge removed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct TasksPurgeResult {
    pub removed: u32,
    pub stopped: u32,
}

/// What Run now did.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct TasksRunResult {
    pub started: bool,
    pub message: String,
}

// ------------------------------------------------------------ live events

/// `tasks.counters` `counters`: the queues stamped after the subscriber's
/// revision.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct TasksCountersFrame {
    #[ts(type = "number")]
    pub revision: u64,
    pub queues: Vec<TasksQueueCounters>,
}

/// `tasks.counters` `queues`: the queue list changed (registered,
/// re-registered, paused, held, refused).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct TasksQueuesChanged {
    #[ts(type = "number")]
    pub revision: u64,
}

/// `tasks.queue` `stale`: keys of rows to read again.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct TasksStale {
    /// `row:<row key>` (old and new keys of a task that changed phase) or
    /// `task:<id>` (that task's detail changed).
    pub keys: Vec<String>,
}

/// `tasks.queue` `finished`: new history rows.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct TasksFinishedBatch {
    pub latest_id: String,
    pub added: u32,
    pub ids: Vec<String>,
    pub overflow: bool,
}
