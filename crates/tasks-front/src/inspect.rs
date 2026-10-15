//! Read models for the console: plain structs built under one short lock
//! (the console maps them to its own types): the queue list and each
//! queue's figures, a page of the live task list, a task's detail with its
//! retry plan, a page of the history, the batch reads behind live patches,
//! the console delta, and the task id behind a name Cloud Tasks sent.

use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

use crate::config::QueueConfig;
use crate::json::{OrderedJson, js_number_text};
use crate::queue::{
    AttemptRecord, Dispatch, RowKey, Status, TaskChange, TaskOrigin, TaskOutcome, TaskQueue,
    TaskRecord, now_millis, preview_headers, retry_plan,
};
use crate::runtime::{
    FinishedTask, HISTORY_CAPACITY, QueueConsole, QueueFunction, QueueOrigin, QueueParts, Refused,
    RejectedQueue, Replaced, StampedWindow, State, TasksRuntime,
};

/// Characters of a body a preview keeps.
const PREVIEW_CHARS: usize = 256;
/// Rows a page holds at most.
const MAX_PAGE: usize = 500;
/// New finished ids a delta lists at most.
const MAX_IDS: usize = 100;
/// The summary's "failed in 5 min", in seconds.
const FIVE_MINUTES: u64 = 300;

/// What the console's summary and badge count, from figures each queue
/// keeps anyway.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TasksTotals {
    pub queues: u32,
    /// Pending and held tasks across queues.
    pub pending: u64,
    /// Tasks that ran out of retries in the last five minutes.
    pub failed_recently: u64,
    /// Tasks that ran out of retries since start (a clear keeps the count).
    pub failed_total: u64,
}

/// Every queue of a project, with what the queues panel shows beside them.
#[derive(Debug, Clone)]
pub struct QueueList {
    pub queues: Vec<QueueView>,
    /// Every project holding a registered queue.
    pub projects: Vec<String>,
    /// `taskQueueTrigger`s the emulator refused.
    pub rejected: Vec<RejectedQueue>,
    /// Requests the Tasks port refused, oldest first.
    pub refused: Vec<RefusedView>,
    /// Refused requests evicted since start.
    pub refused_dropped: u64,
    pub revision: u64,
}

/// A refused request, with where a queue of that id is registered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefusedView {
    pub refused: Refused,
    /// "processOrder is registered in us-central1", when it is elsewhere.
    pub suggestion: Option<String>,
}

/// One queue as the console shows it.
#[derive(Debug, Clone)]
pub struct QueueView {
    pub key: String,
    pub parts: QueueParts,
    pub origin: QueueOrigin,
    pub function: Option<QueueFunction>,
    pub default_uri: Option<String>,
    pub registered_at: SystemTime,
    pub registrations: u32,
    pub last_replaced: Option<Replaced>,
    pub config: ConfigView,
    pub paused: bool,
    pub hold_scheduled: bool,
    pub counters: QueueCounters,
    pub history_capacity: u32,
    pub history_dropped: u64,
}

/// The configuration in force, each value with where it came from.
#[derive(Debug, Clone, PartialEq)]
pub struct ConfigView {
    pub max_attempts: f64,
    pub max_retry_seconds: Option<f64>,
    pub min_backoff_seconds: f64,
    pub max_backoff_seconds: f64,
    pub max_doublings: f64,
    pub max_concurrent_dispatches: u32,
    pub max_dispatches_per_second: f64,
    /// Every key of the stored document, in its order.
    pub values: Vec<ConfigValue>,
    /// The `taskQueueConfig` document as stored.
    pub document: String,
    /// The attempts a task that fails every time runs, from the first: the
    /// dispatcher's own backoff and stop rule (`retry_plan`), with requests
    /// that take no time.
    pub ladder: Vec<LadderStep>,
}

/// One rung of a queue's retry ladder.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LadderStep {
    pub attempt: u32,
    /// The backoff before it (0 for the first attempt).
    pub backoff_seconds: f64,
    /// When it runs at the earliest, after the first attempt.
    pub after_seconds: f64,
    /// The dispatcher gives up after this one.
    pub last: bool,
}

/// A queue's history by outcome, kept in step with the history itself.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct OutcomeCounts {
    pub succeeded: u32,
    pub failed: u32,
    pub cancelled: u32,
    pub deleted: u32,
    pub purged: u32,
    pub replaced: u32,
}

impl OutcomeCounts {
    fn slot(&mut self, outcome: TaskOutcome) -> &mut u32 {
        match outcome {
            TaskOutcome::Succeeded => &mut self.succeeded,
            TaskOutcome::Failed => &mut self.failed,
            TaskOutcome::Cancelled => &mut self.cancelled,
            TaskOutcome::Deleted => &mut self.deleted,
            TaskOutcome::Purged => &mut self.purged,
            TaskOutcome::Replaced => &mut self.replaced,
        }
    }

    /// A finished task of `outcome` joined the history.
    pub(crate) fn add(&mut self, outcome: TaskOutcome) {
        let slot = self.slot(outcome);
        *slot = slot.saturating_add(1);
    }

    /// A finished task of `outcome` left the history.
    pub(crate) fn remove(&mut self, outcome: TaskOutcome) {
        let slot = self.slot(outcome);
        *slot = slot.saturating_sub(1);
    }

    /// Every outcome together: the history's length.
    #[must_use]
    pub fn total(&self) -> u32 {
        [
            self.succeeded,
            self.failed,
            self.cancelled,
            self.deleted,
            self.purged,
            self.replaced,
        ]
        .into_iter()
        .fold(0, u32::saturating_add)
    }
}

/// One value of the stored configuration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigValue {
    /// Dotted key, `retryConfig.maxAttempts`.
    pub key: String,
    /// As stored, JSON text.
    pub value: String,
    /// The registration body set it (else the emulator default).
    pub provided: bool,
    /// Stored but never used by the emulator.
    pub unused: bool,
}

/// A queue's live figures.
#[derive(Debug, Clone, PartialEq)]
pub struct QueueCounters {
    pub key: String,
    pub pending: u32,
    /// Waiting for their schedule time while held.
    pub held: u32,
    /// In a slot, first attempt not yet sent.
    pub dispatching: u32,
    /// Request in flight.
    pub running: u32,
    /// In a slot, waiting for the next attempt.
    pub backoff: u32,
    pub slots: u32,
    pub slots_in_use: u32,
    /// The bucket at `refilled_at`; a view applies the refill rule.
    pub tokens: f64,
    pub max_tokens: f64,
    pub refilled_at: SystemTime,
    pub max_dispatches_per_second: f64,
    pub dispatched: StampedWindow,
    pub succeeded: StampedWindow,
    pub failed: StampedWindow,
    pub added: StampedWindow,
    pub oldest_pending_at: Option<SystemTime>,
    /// Finished tasks the history holds.
    pub history: u32,
    /// The same, by outcome.
    pub outcomes: OutcomeCounts,
}

/// Where a task is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskState {
    Pending,
    /// Waiting for its schedule time (hold on).
    Held,
    /// In a slot, first attempt not yet sent.
    Dispatching,
    Running,
    /// In a slot, waiting for the next attempt.
    Backoff,
    /// Left the queue; only a task's detail is ever in this state, never a
    /// list row.
    Finished,
}

impl TaskState {
    /// `pending`, `held`, `dispatching`, `running`, `backoff` or `finished`.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Held => "held",
            Self::Dispatching => "dispatching",
            Self::Running => "running",
            Self::Backoff => "backoff",
            Self::Finished => "finished",
        }
    }
}

/// A body as a list shows it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BodyPreview {
    pub json: bool,
    /// The first 256 characters of the `data` member when the body is
    /// `{"data": …}`, else of the body.
    pub text: String,
    pub truncated: bool,
    pub data_member: bool,
    pub size: u64,
}

/// One row of the live task list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskRow {
    pub key: RowKey,
    pub id: u64,
    pub name: String,
    pub short_name: String,
    pub generated: bool,
    pub state: TaskState,
    /// One-based place in the pending queue.
    pub position: Option<u32>,
    pub enqueued_at: SystemTime,
    pub origin: TaskOrigin,
    pub schedule_time: Option<String>,
    pub due_at: Option<SystemTime>,
    /// The attempt in flight, or the last one made (0 before the first).
    pub attempt: u32,
    /// How many times the emulator runs a failing task (`maxAttempts` + 1);
    /// `None` when `maxRetrySeconds` bounds it by time instead.
    pub max_runs: Option<u32>,
    pub execution_count: u32,
    pub previous_response: Option<u16>,
    pub last_error: Option<String>,
    pub last_attempt_at: Option<SystemTime>,
    pub next_attempt_at: Option<SystemTime>,
    pub deadline: Duration,
    pub url: Option<String>,
    pub body: BodyPreview,
    pub stop_requested: bool,
}

/// One attempt the dispatcher would still make if every attempt failed.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PlannedAttempt {
    pub attempt: u32,
    pub earliest_at: SystemTime,
    pub backoff_seconds: f64,
    pub last: bool,
}

/// How a task finished.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FinishedView {
    pub outcome: TaskOutcome,
    pub at: SystemTime,
    /// From enqueue to finish.
    pub took: Duration,
    /// Its place in the history.
    pub sequence: u64,
}

/// A task, pending, in a slot or finished, with its request and attempts.
#[derive(Debug, Clone)]
pub struct TaskDetail {
    pub row: TaskRow,
    /// Caller headers.
    pub headers: Vec<(String, String)>,
    /// What the next (or last) attempt sends, `X-CloudTasks-*` included.
    pub dispatch_headers: Vec<(String, String)>,
    pub body: String,
    /// The `data` member as JSON text, when the body is the Admin SDK's.
    pub data: Option<String>,
    /// Attempt 1 and the nine latest, oldest first.
    pub attempts: Vec<AttemptRecord>,
    pub omitted_attempts: u32,
    pub retry_plan: Vec<PlannedAttempt>,
    /// When the emulator gives up, in a sentence with the reason.
    pub stops: String,
    pub finished: Option<FinishedView>,
}

/// One row of the history.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistoryRow {
    /// The finished sequence, the row's key and cursor.
    pub sequence: u64,
    pub id: u64,
    pub name: String,
    pub short_name: String,
    pub outcome: TaskOutcome,
    pub origin: TaskOrigin,
    pub enqueued_at: SystemTime,
    pub finished_at: SystemTime,
    pub attempts: u32,
    pub last_status: Option<u16>,
    pub last_error: Option<String>,
    pub took: Duration,
    pub body: BodyPreview,
}

/// A page of a list, in its one order.
#[derive(Debug, Clone)]
pub struct ListPage<T, K> {
    pub rows: Vec<T>,
    /// The key to continue after the last row, when more follow.
    pub next: Option<K>,
    /// The key to continue before the first row, when rows precede it.
    pub previous: Option<K>,
    /// Rows matching, exactly.
    pub total: usize,
}

/// A term of the task filter (the console turns its validated query into
/// these).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TaskTerm {
    /// `name:` exact, or a prefix with `*`, on the full or the short name.
    Name { value: String, prefix: bool },
    /// `is:generated`.
    Generated,
    /// `is:console`.
    Console,
    /// A free word, case-insensitive, in the body preview.
    Word(String),
}

/// Terms of which any matches (repeated values of one key), negated or not.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskClause {
    pub any: Vec<TaskTerm>,
    pub negated: bool,
}

/// A task filter: every clause holds.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TaskQuery {
    pub clauses: Vec<TaskClause>,
}

impl TaskQuery {
    fn matches(&self, task: &TaskRecord, preview: &BodyPreview, origin: TaskOrigin) -> bool {
        self.matches_parts(&task.name, task.short_name(), preview, origin)
    }

    fn matches_parts(
        &self,
        name: &str,
        short: &str,
        preview: &BodyPreview,
        origin: TaskOrigin,
    ) -> bool {
        self.clauses.iter().all(|clause| {
            let any = clause.any.iter().any(|term| match term {
                TaskTerm::Name { value, prefix } => {
                    if *prefix {
                        name.starts_with(value.as_str()) || short.starts_with(value.as_str())
                    } else {
                        name == value || short == value
                    }
                }
                TaskTerm::Generated => name.starts_with('/'),
                TaskTerm::Console => origin == TaskOrigin::Console,
                TaskTerm::Word(word) => preview.text.to_lowercase().contains(&word.to_lowercase()),
            });
            any != clause.negated
        })
    }

    /// Whether a live row still matches (a batch read drops one that no
    /// longer does).
    #[must_use]
    pub fn matches_row(&self, row: &TaskRow) -> bool {
        self.matches_parts(&row.name, &row.short_name, &row.body, row.origin)
    }

    /// Whether a history row matches.
    #[must_use]
    pub fn matches_history(&self, row: &HistoryRow) -> bool {
        self.matches_parts(&row.name, &row.short_name, &row.body, row.origin)
    }

    fn is_empty(&self) -> bool {
        self.clauses.is_empty()
    }
}

/// Where a console view's last delta left it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TasksCursor {
    /// The revision reported last.
    pub revision: u64,
    /// The scoped queue's change sequence and newest finished sequence.
    queue: Option<(u64, u64)>,
}

impl TasksCursor {
    /// A cursor at `revision` (the revision of a list the view holds).
    #[must_use]
    pub fn at(revision: u64) -> Self {
        Self {
            revision,
            queue: None,
        }
    }
}

/// What a console view wants to hear about.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TasksScope {
    /// Only queues of this project count; every project when `None`.
    pub project: Option<String>,
    /// Report changed queue figures and whether the queue list changed.
    pub counters: bool,
    /// The queue (key) whose changed rows and finished tasks to report.
    pub queue: Option<String>,
    /// Past this many changed queues, report `overflow` instead.
    pub max_changed: usize,
}

/// New finished tasks of the scoped queue.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FinishedIds {
    /// The newest finished sequence.
    pub latest: u64,
    /// Finished since the last delta (evicted ones included).
    pub added: u64,
    /// Their sequences, newest first, at most 100.
    pub ids: Vec<u64>,
    pub overflow: bool,
}

/// What changed since a cursor.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TasksDelta {
    pub revision: u64,
    pub queues: Vec<QueueCounters>,
    pub overflow: bool,
    /// A queue registered or re-registered, a control changed, or the
    /// refused registrations or requests changed.
    pub queues_changed: bool,
    /// The scoped queue's changed rows and details, deduplicated.
    pub changes: Vec<TaskChange>,
    /// The changes since the cursor were not all kept: start over.
    pub changes_reset: bool,
    pub finished: Option<FinishedIds>,
}

impl TasksDelta {
    /// Whether nothing changed.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.queues.is_empty()
            && !self.overflow
            && !self.queues_changed
            && self.changes.is_empty()
            && !self.changes_reset
            && self.finished.is_none()
    }
}

/// A wall-clock instant for a monotonic one.
fn wall(at: Instant, now: Instant, wall_now: SystemTime) -> SystemTime {
    if at <= now {
        wall_now
            .checked_sub(now.duration_since(at))
            .unwrap_or(wall_now)
    } else {
        wall_now + at.duration_since(now)
    }
}

/// A body's preview: the `data` member of the Admin SDK's `{"data": …}`
/// shape, else the body, compact, first 256 characters.
#[must_use]
pub fn body_preview(body: &str) -> BodyPreview {
    let size = u64::try_from(body.len()).unwrap_or(u64::MAX);
    let parsed = OrderedJson::parse(body).ok();
    let (text, json, data_member) = match &parsed {
        Some(OrderedJson::Object(map)) if map.len() == 1 && map.contains_key("data") => {
            (map["data"].stringify(), true, true)
        }
        Some(value) => (value.stringify(), true, false),
        None => (body.to_owned(), false, false),
    };
    let truncated = text.chars().count() > PREVIEW_CHARS;
    BodyPreview {
        json,
        text: if truncated {
            text.chars().take(PREVIEW_CHARS).collect()
        } else {
            text
        },
        truncated,
        data_member,
        size,
    }
}

/// The `data` member as JSON text, when the body is `{"data": …}`.
fn data_member(body: &str) -> Option<String> {
    match OrderedJson::parse(body).ok()? {
        OrderedJson::Object(map) if map.len() == 1 => map.get("data").map(OrderedJson::stringify),
        _ => None,
    }
}

/// How many times the emulator runs a failing task: `maxAttempts` + 1 (the
/// limit is checked before the attempt counts); `None` when
/// `maxRetrySeconds` keeps it going by time.
fn max_runs(config: &QueueConfig) -> Option<u32> {
    if config
        .max_retry_seconds
        .is_some_and(|seconds| seconds != 0.0)
    {
        return None;
    }
    let attempts = config.max_attempts.floor();
    if !(0.0..f64::from(u32::MAX)).contains(&attempts) {
        return None;
    }
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    Some(attempts as u32 + 1)
}

/// When the emulator gives up, in a sentence.
fn stops(config: &QueueConfig) -> String {
    let attempts = js_number_text(config.max_attempts);
    match (config.max_retry_seconds, max_runs(config)) {
        (Some(seconds), _) if seconds != 0.0 => format!(
            "Keeps retrying past maxAttempts {attempts} until {} s have passed since the first attempt (maxRetrySeconds), as the official emulator does.",
            js_number_text(seconds)
        ),
        (_, Some(runs)) => format!(
            "Gives up after attempt {runs} (maxAttempts {attempts} + 1, as the official emulator runs it)."
        ),
        _ => format!("Gives up once an attempt passes maxAttempts {attempts}."),
    }
}

/// The values of the stored configuration document, with their sources.
fn config_view(config: &QueueConfig) -> ConfigView {
    let mut values = Vec::new();
    if let OrderedJson::Object(document) = config.document() {
        for (key, value) in document {
            match value {
                OrderedJson::Object(section) if key == "retryConfig" || key == "rateLimits" => {
                    for (inner, value) in section {
                        let dotted = format!("{key}.{inner}");
                        values.push(ConfigValue {
                            provided: config.provided.contains(&dotted),
                            key: dotted,
                            value: value.stringify(),
                            unused: false,
                        });
                    }
                }
                _ => values.push(ConfigValue {
                    provided: config.provided.contains(key),
                    key: key.clone(),
                    value: value.stringify(),
                    unused: key == "timeoutSeconds" || key == "retry",
                }),
            }
        }
    }
    ConfigView {
        max_attempts: config.max_attempts,
        max_retry_seconds: config.max_retry_seconds,
        min_backoff_seconds: config.min_backoff_seconds,
        max_backoff_seconds: config.max_backoff_seconds,
        max_doublings: config.max_doublings,
        max_concurrent_dispatches: u32::try_from(config.slots).unwrap_or(u32::MAX),
        max_dispatches_per_second: config.max_dispatches_per_second,
        values,
        document: config.document().stringify(),
        ladder: retry_plan(config, 1, Duration::ZERO, Duration::ZERO)
            .into_iter()
            .map(|step| LadderStep {
                attempt: step.attempt,
                backoff_seconds: step.backoff_seconds,
                after_seconds: step.after.as_secs_f64(),
                last: step.last,
            })
            .collect(),
    }
}

fn count(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

/// The state of a task in a slot.
fn slot_state(dispatch: &Dispatch) -> TaskState {
    match dispatch.status {
        Status::Running => TaskState::Running,
        Status::NotStarted if dispatch.last_run.is_none() => TaskState::Dispatching,
        // A slot about to free on the next tick still shows its last attempt.
        Status::NotStarted
        | Status::Retry
        | Status::Failed
        | Status::Finished
        | Status::Cancelled => TaskState::Backoff,
    }
}

fn counters(key: &str, queue: &TaskQueue, console: Option<&QueueConsole>) -> QueueCounters {
    let (mut dispatching, mut running, mut backoff) = (0, 0, 0);
    for dispatch in queue.slotted() {
        match slot_state(dispatch) {
            TaskState::Dispatching => dispatching += 1,
            TaskState::Running => running += 1,
            _ => backoff += 1,
        }
    }
    let (slots, in_use) = queue.slot_usage();
    let (tokens, max_tokens, refilled_at) = queue.bucket();
    let oldest_pending_at = queue
        .pending()
        .next()
        .map(|task| task.enqueued_at)
        .into_iter()
        .chain(queue.held().map(|task| task.enqueued_at))
        .min();
    let window = |pick: fn(&QueueConsole) -> StampedWindow| {
        console.map_or(
            StampedWindow {
                ends_at: SystemTime::UNIX_EPOCH,
                width_seconds: 1,
                buckets: Vec::new(),
            },
            pick,
        )
    };
    QueueCounters {
        key: key.to_owned(),
        pending: count(queue.pending().len()),
        held: count(queue.held().len()),
        dispatching,
        running,
        backoff,
        slots: count(slots),
        slots_in_use: count(in_use),
        tokens,
        max_tokens,
        refilled_at,
        max_dispatches_per_second: queue.config.max_dispatches_per_second,
        dispatched: window(|console| console.windows.dispatched.window()),
        succeeded: window(|console| console.windows.succeeded.window()),
        failed: window(|console| console.windows.failed.window()),
        added: window(|console| console.windows.added.window()),
        oldest_pending_at,
        history: console.map_or(0, |console| count(console.history.len())),
        outcomes: console.map_or_else(OutcomeCounts::default, |console| console.outcomes),
    }
}

/// The row of a pending or held task.
fn waiting_row(
    queue: &TaskQueue,
    task: &TaskRecord,
    position: Option<usize>,
    due: Option<SystemTime>,
) -> TaskRow {
    TaskRow {
        key: RowKey::waiting(task.id),
        id: task.id,
        name: task.name.clone(),
        short_name: task.short_name().to_owned(),
        generated: task.generated(),
        state: if due.is_some() {
            TaskState::Held
        } else {
            TaskState::Pending
        },
        position: position.map(|position| count(position + 1)),
        enqueued_at: task.enqueued_at,
        origin: task.origin,
        schedule_time: task.schedule_time.clone(),
        due_at: task.scheduled,
        attempt: 0,
        max_runs: max_runs(&queue.config),
        execution_count: 0,
        previous_response: None,
        last_error: None,
        last_attempt_at: None,
        next_attempt_at: due,
        deadline: task.deadline,
        url: task.url.clone(),
        body: body_preview(&task.body),
        stop_requested: false,
    }
}

/// The row of a task in a slot.
fn slot_row(queue: &TaskQueue, dispatch: &Dispatch, now: Instant, wall_now: SystemTime) -> TaskRow {
    let task = &dispatch.task;
    let state = slot_state(dispatch);
    let attempt = match dispatch.status {
        Status::NotStarted if dispatch.last_run.is_some() => dispatch.attempt.saturating_sub(1),
        Status::NotStarted => 0,
        _ => dispatch.attempt,
    };
    let last = dispatch.attempts.last();
    TaskRow {
        key: RowKey::slotted(task.id),
        id: task.id,
        name: task.name.clone(),
        short_name: task.short_name().to_owned(),
        generated: task.generated(),
        state,
        position: None,
        enqueued_at: task.enqueued_at,
        origin: task.origin,
        schedule_time: task.schedule_time.clone(),
        due_at: task.scheduled,
        attempt,
        max_runs: max_runs(&queue.config),
        execution_count: dispatch.execution_count,
        previous_response: dispatch.previous_response,
        last_error: last.and_then(|attempt| attempt.error.clone()),
        last_attempt_at: last.map(|attempt| attempt.started_at),
        next_attempt_at: dispatch
            .next_attempt_in(now)
            .map(|wait| wall(now + wait, now, wall_now)),
        deadline: task.deadline,
        url: task.url.clone(),
        body: body_preview(&task.body),
        stop_requested: dispatch.stop_requested,
    }
}

/// The row a finished task last had, for its detail.
fn finished_row(queue: Option<&TaskQueue>, entry: &FinishedTask) -> TaskRow {
    let finished = &entry.finished;
    let task = &finished.task;
    let last = finished.attempts.last();
    TaskRow {
        key: RowKey::slotted(task.id),
        id: task.id,
        name: task.name.clone(),
        short_name: task.short_name().to_owned(),
        generated: task.generated(),
        state: TaskState::Finished,
        position: None,
        enqueued_at: task.enqueued_at,
        origin: task.origin,
        schedule_time: task.schedule_time.clone(),
        due_at: task.scheduled,
        attempt: finished.attempts.count(),
        max_runs: queue.and_then(|queue| max_runs(&queue.config)),
        execution_count: finished.execution_count,
        previous_response: finished.previous_response,
        last_error: last.and_then(|attempt| attempt.error.clone()),
        last_attempt_at: last.map(|attempt| attempt.started_at),
        next_attempt_at: None,
        deadline: task.deadline,
        url: task.url.clone(),
        body: body_preview(&task.body),
        stop_requested: false,
    }
}

fn history_row(entry: &FinishedTask) -> HistoryRow {
    let finished = &entry.finished;
    let task = &finished.task;
    let last = finished.attempts.last();
    HistoryRow {
        sequence: entry.sequence,
        id: task.id,
        name: task.name.clone(),
        short_name: task.short_name().to_owned(),
        outcome: finished.outcome,
        origin: task.origin,
        enqueued_at: task.enqueued_at,
        finished_at: finished.at,
        attempts: finished.attempts.count(),
        last_status: last.and_then(|attempt| attempt.status),
        last_error: last.and_then(|attempt| attempt.error.clone()),
        took: finished
            .at
            .duration_since(task.enqueued_at)
            .unwrap_or_default(),
        body: body_preview(&task.body),
    }
}

/// The moment a read model is built, on both clocks.
#[derive(Debug, Clone, Copy)]
struct Clock {
    now: Instant,
    wall: SystemTime,
    millis: u64,
}

impl Clock {
    fn now() -> Self {
        Self {
            now: Instant::now(),
            wall: SystemTime::now(),
            millis: now_millis(),
        }
    }

    /// The plan from `attempt` on, `wait` from now, with `elapsed` spent
    /// since the first attempt; `skip_first` leaves out the attempt in flight.
    fn plan(
        self,
        config: &QueueConfig,
        attempt: u32,
        wait: Duration,
        elapsed: Duration,
        skip_first: bool,
    ) -> Vec<PlannedAttempt> {
        retry_plan(config, attempt, wait, elapsed)
            .into_iter()
            .skip(usize::from(skip_first))
            .map(|planned| PlannedAttempt {
                attempt: planned.attempt,
                earliest_at: self.wall + planned.after,
                backoff_seconds: planned.backoff_seconds,
                last: planned.last,
            })
            .collect()
    }
}

/// The detail of a task in a slot.
fn slot_detail(key: &str, queue: &TaskQueue, dispatch: &Dispatch, clock: Clock) -> TaskDetail {
    let row = slot_row(queue, dispatch, clock.now, clock.wall);
    let elapsed = clock.now.saturating_duration_since(dispatch.started);
    let retry_plan = match row.state {
        TaskState::Backoff if dispatch.status == Status::NotStarted => clock.plan(
            &queue.config,
            dispatch.attempt,
            dispatch.next_attempt_in(clock.now).unwrap_or_default(),
            elapsed,
            false,
        ),
        TaskState::Dispatching => clock.plan(&queue.config, 1, Duration::ZERO, elapsed, false),
        _ => clock.plan(
            &queue.config,
            dispatch.attempt,
            Duration::ZERO,
            elapsed,
            true,
        ),
    };
    let task = &dispatch.task;
    TaskDetail {
        headers: task.headers.clone(),
        dispatch_headers: preview_headers(
            key,
            task,
            dispatch.attempt,
            dispatch.execution_count,
            dispatch.previous_response,
            clock.millis,
        ),
        body: task.body.clone(),
        data: data_member(&task.body),
        attempts: dispatch.attempts.records().cloned().collect(),
        omitted_attempts: dispatch.attempts.omitted,
        retry_plan,
        stops: stops(&queue.config),
        finished: None,
        row,
    }
}

/// The detail of a pending or held task.
fn waiting_detail(key: &str, queue: &TaskQueue, id: u64, clock: Clock) -> Option<TaskDetail> {
    let (row, task) = match queue.pending_position(id) {
        Some(position) => queue
            .task(id)
            .map(|task| (waiting_row(queue, &task, Some(position), None), task))?,
        None => queue
            .held_task(id)
            .map(|(due, task)| (waiting_row(queue, task, None, Some(due)), Arc::clone(task)))?,
    };
    let wait = row
        .next_attempt_at
        .and_then(|due| due.duration_since(clock.wall).ok())
        .unwrap_or_default();
    Some(TaskDetail {
        headers: task.headers.clone(),
        dispatch_headers: preview_headers(key, &task, 1, 0, None, clock.millis),
        body: task.body.clone(),
        data: data_member(&task.body),
        attempts: Vec::new(),
        omitted_attempts: 0,
        retry_plan: clock.plan(&queue.config, 1, wait, Duration::ZERO, false),
        stops: stops(&queue.config),
        finished: None,
        row,
    })
}

/// The detail of a finished task, from its history entry.
fn finished_detail(
    key: &str,
    queue: Option<&TaskQueue>,
    entry: &FinishedTask,
    clock: Clock,
) -> TaskDetail {
    let finished = &entry.finished;
    let last = finished.attempts.last();
    TaskDetail {
        row: finished_row(queue, entry),
        headers: finished.task.headers.clone(),
        dispatch_headers: preview_headers(
            key,
            &finished.task,
            last.map_or(1, |attempt| attempt.attempt),
            finished.execution_count,
            finished.previous_response,
            clock.millis,
        ),
        body: finished.task.body.clone(),
        data: data_member(&finished.task.body),
        attempts: finished.attempts.records().cloned().collect(),
        omitted_attempts: finished.attempts.omitted,
        retry_plan: Vec::new(),
        stops: queue.map(|queue| stops(&queue.config)).unwrap_or_default(),
        finished: Some(FinishedView {
            outcome: finished.outcome,
            at: finished.at,
            took: finished
                .at
                .duration_since(finished.task.enqueued_at)
                .unwrap_or_default(),
            sequence: entry.sequence,
        }),
    }
}

/// One live task of a queue, before its row is built.
#[derive(Clone, Copy)]
enum Entry<'a> {
    Slot(&'a Dispatch),
    Pending(&'a Arc<TaskRecord>, usize),
    Held(&'a Arc<TaskRecord>, Option<SystemTime>),
}

impl<'a> Entry<'a> {
    fn key(self) -> RowKey {
        match self {
            Self::Slot(dispatch) => RowKey::slotted(dispatch.task.id),
            Self::Pending(task, _) | Self::Held(task, _) => RowKey::waiting(task.id),
        }
    }

    fn task(self) -> &'a TaskRecord {
        match self {
            Self::Slot(dispatch) => &dispatch.task,
            Self::Pending(task, _) | Self::Held(task, _) => task,
        }
    }

    fn state(self) -> TaskState {
        match self {
            Self::Slot(dispatch) => slot_state(dispatch),
            Self::Pending(..) => TaskState::Pending,
            Self::Held(..) => TaskState::Held,
        }
    }

    fn row(self, queue: &TaskQueue, now: Instant, wall_now: SystemTime) -> TaskRow {
        match self {
            Self::Slot(dispatch) => slot_row(queue, dispatch, now, wall_now),
            Self::Pending(task, position) => waiting_row(queue, task, Some(position), None),
            Self::Held(task, due) => waiting_row(queue, task, None, due),
        }
    }
}

/// A queue's live tasks in list order: slotted by task id, then pending
/// and held by task id. Pointers only; rows are built for a page alone.
fn ordered(queue: &TaskQueue) -> Vec<Entry<'_>> {
    let mut slotted: Vec<Entry<'_>> = queue.slotted().map(Entry::Slot).collect();
    slotted.sort_by_key(|entry| entry.key());
    let mut held: Vec<Entry<'_>> = queue
        .held()
        .map(|task| Entry::Held(task, task.scheduled))
        .collect();
    held.sort_by_key(|entry| entry.key());
    // Pending is in task-id order already; merge the held tasks in.
    let mut waiting = Vec::with_capacity(queue.pending().len() + held.len());
    let mut held = held.into_iter().peekable();
    for (position, task) in queue.pending().enumerate() {
        while held.peek().is_some_and(|entry| entry.key().id < task.id) {
            waiting.extend(held.next());
        }
        waiting.push(Entry::Pending(task, position));
    }
    waiting.extend(held);
    slotted.extend(waiting);
    slotted
}

impl State {
    fn queue_view(&self, key: &str) -> Option<QueueView> {
        let console = self.console.get(key)?;
        let queue = self.queues.get(key)?;
        Some(QueueView {
            key: key.to_owned(),
            parts: console.source.parts.clone(),
            origin: console.source.origin,
            function: console.source.function.clone(),
            default_uri: queue
                .config
                .default_uri
                .as_ref()
                .and_then(|uri| uri.as_str().map(str::to_owned)),
            registered_at: console.registered_at,
            registrations: console.registrations,
            last_replaced: console.last_replaced,
            config: config_view(&queue.config),
            paused: console.controls.paused,
            hold_scheduled: console.controls.hold_scheduled,
            counters: counters(key, queue, Some(console)),
            history_capacity: count(HISTORY_CAPACITY),
            history_dropped: console.dropped,
        })
    }

    fn suggestion(&self, refused: &Refused) -> Option<String> {
        let mut elsewhere: Vec<&QueueParts> = self
            .console
            .values()
            .map(|console| &console.source.parts)
            .filter(|parts| parts.queue == refused.queue.queue && **parts != refused.queue)
            .collect();
        elsewhere.sort_by(|left, right| {
            (
                left.project != refused.queue.project,
                &left.project,
                &left.location,
            )
                .cmp(&(
                    right.project != refused.queue.project,
                    &right.project,
                    &right.location,
                ))
        });
        let parts = elsewhere.first()?;
        Some(if parts.project == refused.queue.project {
            format!("{} is registered in {}", parts.queue, parts.location)
        } else {
            format!(
                "{} is registered in project {}, {}",
                parts.queue, parts.project, parts.location
            )
        })
    }
}

impl TasksRuntime {
    /// Queues, pending tasks and failures, from each queue's counts and
    /// failure window: one walk of the queues, no task visited.
    #[must_use]
    pub fn totals(&self) -> TasksTotals {
        let state = self.lock_state();
        let now = SystemTime::now();
        let mut totals = TasksTotals {
            queues: u32::try_from(state.queues.len()).unwrap_or(u32::MAX),
            failed_total: state.failed_total,
            ..TasksTotals::default()
        };
        for (key, queue) in &state.queues {
            totals.pending +=
                u64::try_from(queue.pending().len() + queue.held().len()).unwrap_or(u64::MAX);
            if let Some(console) = state.console.get(key) {
                let window = console.windows.failed.window();
                let age = now
                    .duration_since(window.ends_at)
                    .unwrap_or_default()
                    .as_secs();
                let width = u64::from(window.width_seconds.max(1));
                totals.failed_recently += window
                    .buckets
                    .iter()
                    .filter(|(before, _)| u64::from(*before) * width + age < FIVE_MINUTES)
                    .map(|(_, count)| u64::from(*count))
                    .sum::<u64>();
            }
        }
        totals
    }

    /// Tasks that ran out of retries since start. O(1).
    #[must_use]
    pub fn failed_total(&self) -> u64 {
        self.lock_state().failed_total
    }

    /// Every queue of `project` (every project when `None`), in
    /// registration order, with the refused registrations and requests.
    #[must_use]
    pub fn queues_view(&self, project: Option<&str>) -> QueueList {
        let state = self.lock_state();
        let keys: Vec<String> = state
            .queues
            .keys()
            .filter(|key| {
                project.is_none_or(|project| {
                    state
                        .console
                        .get(*key)
                        .is_some_and(|console| console.source.parts.project == project)
                })
            })
            .cloned()
            .collect();
        let queues = keys
            .iter()
            .filter_map(|key| state.queue_view(key))
            .collect();
        let mut projects: Vec<String> = state
            .console
            .values()
            .map(|console| console.source.parts.project.clone())
            .collect();
        projects.sort();
        projects.dedup();
        let refused = state
            .refused
            .iter()
            .filter(|refused| project.is_none_or(|project| refused.queue.project == project))
            .map(|refused| RefusedView {
                suggestion: state.suggestion(refused),
                refused: refused.clone(),
            })
            .collect();
        QueueList {
            queues,
            projects,
            rejected: state.rejected.values().cloned().collect(),
            refused,
            refused_dropped: state.refused_dropped,
            revision: state.revision,
        }
    }

    /// One queue with its figures.
    #[must_use]
    pub fn queue_view(&self, key: &str) -> Option<QueueView> {
        self.lock_state().queue_view(key)
    }

    /// A page of the live task list: slotted tasks first, then pending and
    /// held ones, each in task-id order, filtered by state and query;
    /// `after` continues past a row, `before` pages back towards the top.
    #[must_use]
    pub fn tasks_page(
        &self,
        key: &str,
        state: Option<TaskState>,
        query: &TaskQuery,
        after: Option<RowKey>,
        before: Option<RowKey>,
        limit: usize,
    ) -> Option<ListPage<TaskRow, RowKey>> {
        let limit = limit.clamp(1, MAX_PAGE);
        let now = Instant::now();
        let wall_now = SystemTime::now();
        let guard = self.lock_state();
        let queue = guard.queues.get(key)?;
        let entries: Vec<Entry<'_>> = ordered(queue)
            .into_iter()
            .filter(|entry| state.is_none_or(|state| entry.state() == state))
            .filter(|entry| {
                query.is_empty() || {
                    let task = entry.task();
                    query.matches(task, &body_preview(&task.body), task.origin)
                }
            })
            .collect();
        let total = entries.len();
        let (start, end) = match (after, before) {
            (_, Some(before)) => {
                let end = entries.partition_point(|entry| entry.key() < before);
                (end.saturating_sub(limit), end)
            }
            (Some(after), None) => {
                let start = entries.partition_point(|entry| entry.key() <= after);
                (start, (start + limit).min(total))
            }
            (None, None) => (0, limit.min(total)),
        };
        let rows: Vec<TaskRow> = entries[start..end]
            .iter()
            .map(|entry| entry.row(queue, now, wall_now))
            .collect();
        Some(ListPage {
            next: (end < total && end > start).then(|| entries[end - 1].key()),
            previous: (start > 0 && end > start).then(|| entries[start].key()),
            rows,
            total,
        })
    }

    /// Each key's row while the task is still in that phase; `None` once it
    /// finished or changed phase (its new key arrives in the same event).
    #[must_use]
    pub fn task_rows(&self, key: &str, keys: &[RowKey]) -> Vec<(RowKey, Option<TaskRow>)> {
        let now = Instant::now();
        let wall_now = SystemTime::now();
        let guard = self.lock_state();
        let Some(queue) = guard.queues.get(key) else {
            return keys.iter().map(|key| (*key, None)).collect();
        };
        keys.iter()
            .map(|row_key| {
                let row = match row_key.phase {
                    0 => queue
                        .dispatch_of(row_key.id)
                        .map(|dispatch| slot_row(queue, dispatch, now, wall_now)),
                    _ => match queue.pending_position(row_key.id) {
                        Some(position) => queue
                            .task(row_key.id)
                            .map(|task| waiting_row(queue, &task, Some(position), None)),
                        None => queue
                            .held_task(row_key.id)
                            .map(|(due, task)| waiting_row(queue, task, None, Some(due))),
                    },
                };
                (*row_key, row)
            })
            .collect()
    }

    /// Task `id` of the queue, pending, in a slot or finished, with its
    /// request, attempts and retry plan.
    #[must_use]
    pub fn task_view(&self, key: &str, id: u64) -> Option<TaskDetail> {
        let clock = Clock::now();
        let guard = self.lock_state();
        let queue = guard.queues.get(key);
        if let Some(queue) = queue {
            if let Some(dispatch) = queue.dispatch_of(id) {
                return Some(slot_detail(key, queue, dispatch, clock));
            }
            if let Some(detail) = waiting_detail(key, queue, id, clock) {
                return Some(detail);
            }
        }
        let console = guard.console.get(key)?;
        let entry = console
            .history
            .iter()
            .rev()
            .find(|entry| entry.finished.task.id == id)?;
        Some(finished_detail(key, queue, entry, clock))
    }

    /// A page of the queue's history, newest first, filtered by outcome and
    /// query; `after` continues past a finished sequence (older rows),
    /// `before` pages back towards the newest.
    #[must_use]
    pub fn history_page(
        &self,
        key: &str,
        outcome: Option<TaskOutcome>,
        query: &TaskQuery,
        after: Option<u64>,
        before: Option<u64>,
        limit: usize,
    ) -> Option<ListPage<HistoryRow, u64>> {
        let limit = limit.clamp(1, MAX_PAGE);
        let guard = self.lock_state();
        let console = guard.console.get(key)?;
        let entries: Vec<&FinishedTask> = console
            .history
            .iter()
            .rev()
            .filter(|entry| outcome.is_none_or(|outcome| entry.finished.outcome == outcome))
            .filter(|entry| {
                query.is_empty() || {
                    let task = &entry.finished.task;
                    query.matches(task, &body_preview(&task.body), task.origin)
                }
            })
            .collect();
        let total = entries.len();
        let (start, end) = match (after, before) {
            (_, Some(before)) => {
                let end = entries.partition_point(|entry| entry.sequence > before);
                (end.saturating_sub(limit), end)
            }
            (Some(after), None) => {
                let start = entries.partition_point(|entry| entry.sequence >= after);
                (start, (start + limit).min(total))
            }
            (None, None) => (0, limit.min(total)),
        };
        Some(ListPage {
            rows: entries[start..end]
                .iter()
                .map(|entry| history_row(entry))
                .collect(),
            next: (end < total && end > start).then(|| entries[end - 1].sequence),
            previous: (start > 0 && end > start).then(|| entries[start].sequence),
            total,
        })
    }

    /// Each finished sequence's history row while the history keeps it (a
    /// late response snippet attached after the row was listed).
    #[must_use]
    pub fn history_rows(&self, key: &str, sequences: &[u64]) -> Vec<(u64, Option<HistoryRow>)> {
        let guard = self.lock_state();
        let console = guard.console.get(key);
        sequences
            .iter()
            .map(|sequence| {
                let row = console.and_then(|console| {
                    let position = console
                        .history
                        .binary_search_by_key(sequence, |entry| entry.sequence)
                        .ok()?;
                    Some(history_row(&console.history[position]))
                });
                (*sequence, row)
            })
            .collect()
    }

    /// A task name as Cloud Tasks sent it (`X-CloudTasks-TaskName`, the
    /// short name, or the full name) to the console's id for the task: the
    /// newest task of the queue with that name, live or finished.
    #[must_use]
    pub fn task_id(&self, key: &str, name: &str) -> Option<String> {
        let guard = self.lock_state();
        let matches = |task: &TaskRecord| task.name == name || task.short_name() == name;
        let live = guard.queues.get(key).and_then(|queue| {
            queue
                .slotted()
                .map(|dispatch| &dispatch.task)
                .chain(queue.pending())
                .chain(queue.held())
                .filter(|task| matches(task))
                .map(|task| task.id)
                .max()
        });
        let finished = guard.console.get(key).and_then(|console| {
            console
                .history
                .iter()
                .rev()
                .find(|entry| matches(&entry.finished.task))
                .map(|entry| entry.finished.task.id)
        });
        live.max(finished).map(|id| id.to_string())
    }

    /// Tasks across queues whose full or short name is `name`, newest first
    /// per queue (the console's search).
    #[must_use]
    pub fn find_tasks(&self, name: &str, limit: usize) -> Vec<(String, u64, String)> {
        let guard = self.lock_state();
        let mut found = Vec::new();
        for (key, queue) in &guard.queues {
            let live = queue
                .slotted()
                .map(|dispatch| &dispatch.task)
                .chain(queue.pending())
                .chain(queue.held());
            let finished = guard
                .console
                .get(key)
                .into_iter()
                .flat_map(|console| console.history.iter().rev())
                .map(|entry| &entry.finished.task);
            for task in live.chain(finished) {
                if task.name == name || task.short_name() == name {
                    found.push((key.clone(), task.id, task.name.clone()));
                    if found.len() >= limit {
                        return found;
                    }
                }
            }
        }
        found
    }

    /// What changed since `cursor`: the figures of queues stamped after it,
    /// whether the queue list changed, the scoped queue's changed rows
    /// (`changes_reset` when the cursor is older than the ring) and its new
    /// finished tasks. The scoped parts start reporting from the second
    /// call.
    pub fn console_delta(&self, cursor: &mut TasksCursor, scope: &TasksScope) -> TasksDelta {
        let mut guard = self.lock_state();
        let state = &mut *guard;
        let mut delta = TasksDelta {
            revision: state.revision,
            ..TasksDelta::default()
        };
        if scope.counters {
            delta.queues_changed = state.queues_revision > cursor.revision;
            let changed: Vec<&String> = state
                .queues
                .keys()
                .filter(|key| {
                    state.console.get(*key).is_some_and(|console| {
                        console.stamp > cursor.revision
                            && scope
                                .project
                                .as_ref()
                                .is_none_or(|project| console.source.parts.project == *project)
                    })
                })
                .collect();
            if changed.len() > scope.max_changed {
                delta.overflow = true;
            } else {
                delta.queues = changed
                    .into_iter()
                    .filter_map(|key| {
                        let queue = state.queues.get(key)?;
                        Some(counters(key, queue, state.console.get(key)))
                    })
                    .collect();
            }
        }
        if let Some(console) = scope.queue.as_ref().and_then(|key| state.console.get(key)) {
            let latest = console.history.back().map_or(0, |entry| entry.sequence);
            if let Some((seen_changes, seen_finished)) = cursor.queue {
                let oldest = console
                    .changes
                    .front()
                    .map_or(console.change_sequence + 1, |(sequence, _)| *sequence);
                if console.change_sequence > seen_changes {
                    if oldest > seen_changes + 1 {
                        delta.changes_reset = true;
                    } else {
                        let mut changes: Vec<TaskChange> = console
                            .changes
                            .iter()
                            .filter(|(sequence, _)| *sequence > seen_changes)
                            .map(|(_, change)| *change)
                            .collect();
                        changes.sort_unstable();
                        changes.dedup();
                        delta.changes = changes;
                    }
                }
                if latest > seen_finished {
                    let ids: Vec<u64> = console
                        .history
                        .iter()
                        .rev()
                        .take_while(|entry| entry.sequence > seen_finished)
                        .map(|entry| entry.sequence)
                        .collect();
                    delta.finished = Some(FinishedIds {
                        latest,
                        added: latest - seen_finished,
                        overflow: ids.len() > MAX_IDS,
                        ids: ids.into_iter().take(MAX_IDS).collect(),
                    });
                }
            }
            cursor.queue = Some((console.change_sequence, latest));
        }
        cursor.revision = state.revision;
        delta
    }
}
