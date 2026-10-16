//! The Tasks runtime: the registered queues behind one mutex, the ticker
//! that refills tokens and drives every active queue's state machine, the
//! `reqwest` sender that plays `runTask`'s `fetch`, and what the console
//! keeps beside each queue (its parts, controls, registrations and the
//! history of finished tasks), so a re-registration that replaces the queue
//! keeps them.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime};

use axum::http::header::{ACCEPT, USER_AGENT};
use axum::http::{HeaderMap, HeaderName, HeaderValue};
use firenook_functions_bridge::FunctionsInventory;
use firenook_suite_front::window::{SecondCounts, TenSecondCounts};
use indexmap::IndexMap;

use crate::config::{QUEUE_CAPACITY, QueueConfig};
use crate::functions::discover;
use crate::inspect::OutcomeCounts;
use crate::json::OrderedJson;
use crate::queue::{
    AttemptRecord, Conflict, Controls, Finished, NotFound, Outcome, RunNow, RunNowError,
    RunRequest, Stopped, TaskChange, TaskOrigin, TaskOutcome, TaskQueue, TaskRecord, now_millis,
};

/// A line the Tasks emulator logs, with the queue and task it is about, so a
/// log view can link back to them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TasksLogLine {
    /// `INFO`, `WARN`, `ERROR` or `DEBUG`.
    pub level: &'static str,
    /// `tasks`, or `tasks.failed` for a task that ran out of retries.
    pub kind: &'static str,
    /// The line without a label.
    pub text: String,
    /// The queue's parts, as registered or as the request named them.
    pub queue: Option<QueueParts>,
    /// The task's console id and full name.
    pub task: Option<(u64, String)>,
}

/// The kind of most of the emulator's lines.
pub const LOG_TASKS: &str = "tasks";
/// The kind of the line a task that ran out of retries logs.
pub const LOG_FAILED: &str = "tasks.failed";

impl TasksLogLine {
    pub(crate) fn new(
        level: &'static str,
        text: impl Into<String>,
        queue: Option<QueueParts>,
    ) -> Self {
        Self {
            level,
            kind: LOG_TASKS,
            text: text.into(),
            queue,
            task: None,
        }
    }

    pub(crate) fn task(mut self, id: u64, name: &str) -> Self {
        self.task = Some((id, name.to_owned()));
        self
    }
}

/// Receives the emulator's log lines inline; it must not block. A closure
/// of `(level, text)` (the suite's console printer) converts into one.
#[derive(Clone)]
pub struct LogSink(Arc<dyn Fn(TasksLogLine) + Send + Sync>);

impl LogSink {
    /// A sink of whole lines, refs included.
    pub fn new(sink: impl Fn(TasksLogLine) + Send + Sync + 'static) -> Self {
        Self(Arc::new(sink))
    }

    fn emit(&self, line: TasksLogLine) {
        (self.0)(line);
    }
}

impl std::fmt::Debug for LogSink {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("LogSink")
    }
}

impl<F> From<Arc<F>> for LogSink
where
    F: Fn(&str, &str) + Send + Sync + 'static,
{
    /// `level` is `INFO`, `WARN`, `ERROR` or `DEBUG`, `text` the line
    /// without a label; the refs are dropped.
    fn from(sink: Arc<F>) -> Self {
        Self::new(move |line| sink(line.level, &line.text))
    }
}

/// The dispatch resolution; the official loop runs on a zero timeout while
/// any queue is active and sleeps a second when none is.
/// The official controller re-arms `listen()` immediately while any queue is
/// active and only every second while every queue is idle, so a task
/// enqueued on an idle emulator waits up to a second (the corpus records
/// that pause). These are the two cadences.
const ACTIVE_TICK: Duration = Duration::from_millis(5);
const IDLE_TICK: Duration = Duration::from_millis(1000);

/// `node-fetch`'s default headers on a request without them.
const NODE_FETCH_USER_AGENT: &str = "node-fetch/1.0 (+https://github.com/bitinn/node-fetch)";

/// The bytes of a response body kept for an attempt's snippet.
const SNIPPET_BYTES: usize = 1_024;
/// How long a response body is read for its snippet, at most.
const SNIPPET_WAIT: Duration = Duration::from_millis(500);
/// Finished tasks a queue's history keeps.
pub const HISTORY_CAPACITY: usize = 1_000;
/// The bytes a queue's history keeps: a thousand ordinary tasks fit with
/// room, a run of large bodies is cut to its newest.
pub const HISTORY_BYTES: usize = 4 * 1024 * 1024;
/// The bytes every queue's history keeps together, taken first from the
/// queue holding the most.
pub const ALL_HISTORY_BYTES: usize = 32 * 1024 * 1024;
/// Changed rows a queue remembers for live views.
const CHANGE_RING: usize = 1_000;
/// Refused requests kept.
const REFUSED_CAPACITY: usize = 200;

pub use firenook_suite_front::window::StampedWindow;

/// A queue's stamped windows.
#[derive(Debug, Clone, Default)]
pub(crate) struct QueueWindows {
    /// Attempts sent, per second over a minute.
    pub dispatched: SecondCounts,
    /// Tasks that ran out of retries, per ten seconds over five minutes.
    pub failed: TenSecondCounts,
}

/// A request the Tasks port refused, coalesced by operation, queue, status
/// and error.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refused {
    pub first_at: SystemTime,
    pub last_at: SystemTime,
    pub count: u32,
    /// `enqueue` or `delete`.
    pub operation: &'static str,
    /// The queue the request named.
    pub queue: QueueParts,
    /// The status the client received.
    pub status: u16,
    /// What the client was told, without the page around it.
    pub error: String,
}

/// A queue's project, location and id as it registered: the engine's key
/// `queue:{project}-{location}-{queue}` cannot be split back into them.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct QueueParts {
    pub project: String,
    pub location: String,
    pub queue: String,
}

/// What registered a queue.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QueueOrigin {
    /// An `onTaskDispatched` export.
    Function,
    /// A client's `POST /projects/…/queues/{queue}`.
    Client,
}

/// The function a queue dispatches to, when it registered from one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueueFunction {
    pub function_id: String,
    pub name: String,
    pub region: String,
}

/// Who registered a queue, and as what.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueueSource {
    pub parts: QueueParts,
    pub origin: QueueOrigin,
    pub function: Option<QueueFunction>,
}

/// The last re-registration that replaced a queue.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Replaced {
    pub at: SystemTime,
    /// Pending, held and slotted tasks it dropped into the history.
    pub dropped: u32,
}

/// One finished task in a queue's history.
#[derive(Debug, Clone)]
pub struct FinishedTask {
    /// Runtime-wide, from 1; the history's order and cursor.
    pub sequence: u64,
    pub finished: Finished,
    bytes: usize,
}

/// What the console keeps beside a queue; a re-registration keeps it.
#[derive(Debug)]
pub(crate) struct QueueConsole {
    pub source: QueueSource,
    pub controls: Controls,
    pub registered_at: SystemTime,
    /// Registrations under this key since start (1 after the first).
    pub registrations: u32,
    pub last_replaced: Option<Replaced>,
    /// Oldest first.
    pub history: VecDeque<FinishedTask>,
    pub history_bytes: usize,
    /// Finished tasks evicted from the history since start.
    pub dropped: u64,
    /// The history by outcome, kept in step with it.
    pub outcomes: OutcomeCounts,
    /// The revision at which the queue's figures last changed.
    pub stamp: u64,
    /// The newest changed rows, with their sequence numbers.
    pub changes: VecDeque<(u64, TaskChange)>,
    pub change_sequence: u64,
    pub windows: QueueWindows,
}

impl QueueConsole {
    fn new(source: QueueSource, now: SystemTime) -> Self {
        Self {
            source,
            controls: Controls::default(),
            registered_at: now,
            registrations: 1,
            last_replaced: None,
            history: VecDeque::new(),
            history_bytes: 0,
            dropped: 0,
            outcomes: OutcomeCounts::default(),
            stamp: 0,
            changes: VecDeque::new(),
            change_sequence: 0,
            windows: QueueWindows::default(),
        }
    }

    /// Forgets the changed rows so every live view starts over.
    fn reset_changes(&mut self) {
        self.changes.clear();
        self.change_sequence += CHANGE_RING as u64 + 1;
    }
}

/// A `taskQueueTrigger` the emulator refused to register.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RejectedQueue {
    pub function_id: String,
    pub name: String,
    pub region: String,
    /// The validator's words (`Error adding Task Queue function: …`).
    pub reason: String,
    pub at: SystemTime,
}

/// Every registered queue, in registration order (`Object.entries` order
/// of the official controller's `queues`), and the console's state beside
/// them.
pub(crate) struct State {
    pub queues: IndexMap<String, TaskQueue>,
    pub console: HashMap<String, QueueConsole>,
    /// Refused registrations by queue key; a later registration clears one.
    pub rejected: IndexMap<String, RejectedQueue>,
    pub next_dispatch: u64,
    pub next_task: u64,
    pub next_finished: u64,
    /// Bytes every history holds together.
    pub history_bytes: usize,
    /// Bumped by every change a console view shows.
    pub revision: u64,
    /// The revision at which a queue registered, changed its controls, or
    /// the refused registrations or requests changed.
    pub queues_revision: u64,
    /// Refused requests, oldest first.
    pub refused: VecDeque<Refused>,
    /// Refused requests evicted since start.
    pub refused_dropped: u64,
    /// Log lines waiting for the lock to be released.
    pub lines: Vec<TasksLogLine>,
    /// Tasks that ran out of retries since start; a clear keeps the count
    /// (the console's counter badge).
    pub failed_total: u64,
}

struct Inner {
    project: String,
    state: Mutex<State>,
    http: reqwest::Client,
    /// Replaced once the console builds its sink (`set_log_sink`).
    log: Mutex<LogSink>,
    ticker: Mutex<Option<tokio::task::JoinHandle<()>>>,
    /// Wakes the ticker early after a console control that frees work.
    wake: tokio::sync::Notify,
    /// The console revision, announced when it moved.
    revision: tokio::sync::watch::Sender<u64>,
}

/// What [`TasksRuntime::reset`] removed.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TasksResetCount {
    /// Pending, held and slotted tasks.
    pub tasks: u64,
    /// Finished tasks in the histories.
    pub history: u64,
    /// Task names that were reserved and can be used again.
    pub names: u64,
    /// Refused requests forgotten.
    pub refused: u32,
}

/// Shared Tasks state; cheap to clone.
#[derive(Clone)]
pub struct TasksRuntime {
    inner: Arc<Inner>,
}

/// Why an enqueue was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EnqueueError {
    /// No queue has this key (a 404 on the wire).
    UnknownQueue,
    /// The name was enqueued before in this run (a 409 on the wire).
    NameReserved,
    /// The queue holds as many pending tasks as it can (a 409 on the wire).
    QueueFull { capacity: i64 },
    /// The request the Admin SDK would send is over the Tasks port's limit.
    TooLarge { size: usize, limit: usize },
    /// The console's task is not one an SDK could send, with the reason.
    Invalid(String),
    /// Enqueue again: no task of the queue has this id.
    UnknownTask,
}

impl std::fmt::Display for EnqueueError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnknownQueue => formatter.write_str("No queue is registered under this key."),
            Self::NameReserved => {
                formatter.write_str("A task with this name was enqueued before in this run.")
            }
            Self::QueueFull { capacity } => write!(
                formatter,
                "The queue holds {capacity} pending tasks, the emulator's capacity."
            ),
            Self::TooLarge { size, limit } => write!(
                formatter,
                "The Tasks port accepts requests up to {} KiB, as express.json does; this one would be {} KiB.",
                limit / 1024,
                size.div_ceil(1024)
            ),
            Self::Invalid(reason) => formatter.write_str(reason),
            Self::UnknownTask => formatter.write_str("No task of this queue has this id."),
        }
    }
}

impl std::error::Error for EnqueueError {}

/// Why a delete was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoveError {
    /// No queue has this key (a 404).
    UnknownQueue,
    /// The name is not in the queue's node map (a 404).
    NotFound,
}

/// Why a console control could not act.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ControlError {
    UnknownQueue,
    /// No task of the queue has this id.
    UnknownTask,
    /// Run now: every dispatch slot is busy.
    Busy,
    /// Run now: its request is in flight.
    Running,
    /// Stop retrying: the task holds no slot.
    NotInSlot,
}

impl std::fmt::Display for ControlError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::UnknownQueue => "No queue is registered under this key.",
            Self::UnknownTask => "No task of this queue has this id.",
            Self::Busy => "Every dispatch slot of the queue is busy.",
            Self::Running => "The task's request is in flight.",
            Self::NotInSlot => "The task is not in a dispatch slot, so it has no retries to stop.",
        })
    }
}

impl std::error::Error for ControlError {}

/// A task the console enqueued.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnqueuedTask {
    /// The queue's key.
    pub key: String,
    /// The console's id for the task.
    pub id: u64,
    /// Its full name (a leading slash when the emulator generated it).
    pub name: String,
}

/// A task as the console enqueues it: what `firebase-admin`'s
/// `TaskQueue.enqueue` sends for the same options.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ConsoleTask {
    /// JSON text sent as `{"data": …}`, as `taskQueue().enqueue(data)` does.
    pub data: Option<String>,
    /// Or JSON text sent as the body as it is.
    pub raw_body: Option<String>,
    /// The task id (short); `None` lets the emulator generate a name.
    pub id: Option<String>,
    /// Caller headers, after `Content-Type: application/json`.
    pub headers: Vec<(String, String)>,
    /// Sets `scheduleTime` to now plus this many seconds when above zero.
    pub schedule_delay_seconds: Option<f64>,
    /// `dispatchDeadline`, 15 to 1,800 seconds.
    pub dispatch_deadline_seconds: Option<u32>,
    /// The URL to dispatch to; `None` uses the queue's `defaultUri`.
    pub url: Option<String>,
}

pub(crate) fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl State {
    /// Moves finished tasks into their queue's history, trimming it to its
    /// count and bytes and every history to the total.
    pub(crate) fn record_finished(&mut self, key: &str, finished: Vec<Finished>) {
        if finished.is_empty() {
            return;
        }
        let Some(console) = self.console.get_mut(key) else {
            return;
        };
        for finished in finished {
            self.next_finished += 1;
            if finished.outcome == TaskOutcome::Failed {
                console.windows.failed.record(finished.at, 1);
                self.failed_total = self.failed_total.saturating_add(1);
                let last = finished.attempts.last();
                let reason = match (
                    last.and_then(|attempt| attempt.status),
                    last.and_then(|attempt| attempt.error.as_deref()),
                ) {
                    (Some(status), _) => format!("its last attempt answered {status}"),
                    (None, Some(error)) => format!("its last attempt failed: {error}"),
                    (None, None) => "it never got an answer".to_owned(),
                };
                let attempts = finished.attempts.count();
                self.lines.push(TasksLogLine {
                    level: "WARN",
                    kind: LOG_FAILED,
                    text: format!(
                        "Task {} in {} ran out of retries after {attempts} {}; {reason}",
                        finished.task.short_name(),
                        console.source.parts.queue,
                        if attempts == 1 { "attempt" } else { "attempts" }
                    ),
                    queue: Some(console.source.parts.clone()),
                    task: Some((finished.task.id, finished.task.name.clone())),
                });
            }
            let bytes = finished.bytes();
            console.outcomes.add(finished.outcome);
            console.history.push_back(FinishedTask {
                sequence: self.next_finished,
                finished,
                bytes,
            });
            console.history_bytes += bytes;
            self.history_bytes += bytes;
            while console.history.len() > HISTORY_CAPACITY || console.history_bytes > HISTORY_BYTES
            {
                let Some(oldest) = console.history.pop_front() else {
                    break;
                };
                console.outcomes.remove(oldest.finished.outcome);
                console.history_bytes -= oldest.bytes;
                self.history_bytes -= oldest.bytes;
                console.dropped += 1;
            }
        }
        while self.history_bytes > ALL_HISTORY_BYTES {
            let Some(largest) = self
                .console
                .values_mut()
                .max_by_key(|console| console.history_bytes)
            else {
                break;
            };
            let Some(oldest) = largest.history.pop_front() else {
                break;
            };
            largest.outcomes.remove(oldest.finished.outcome);
            largest.history_bytes -= oldest.bytes;
            largest.dropped += 1;
            self.history_bytes -= oldest.bytes;
        }
    }

    /// Writes an attempt whose task left its slot (stopped, replaced) into
    /// the task's history entry; `false` when no entry has it.
    fn attach_to_history(&mut self, key: &str, dispatch_id: u64, record: AttemptRecord) -> bool {
        let Some(entry) = self.history_entry(key, dispatch_id) else {
            return false;
        };
        entry.finished.attempts.push_record(record);
        true
    }

    fn history_entry(&mut self, key: &str, dispatch_id: u64) -> Option<&mut FinishedTask> {
        self.console
            .get_mut(key)?
            .history
            .iter_mut()
            .rev()
            .find(|entry| entry.finished.dispatch_id == Some(dispatch_id))
    }

    /// Moves every queue's changed rows into its ring, stamping the queues
    /// that changed with a new revision.
    pub(crate) fn collect_changes(&mut self) {
        let Self {
            queues,
            console,
            revision,
            ..
        } = self;
        for (key, queue) in queues.iter_mut() {
            let changes = queue.take_changes();
            if changes.is_empty() {
                continue;
            }
            let Some(console) = console.get_mut(key) else {
                continue;
            };
            *revision += 1;
            console.stamp = *revision;
            for change in changes {
                console.change_sequence += 1;
                console.changes.push_back((console.change_sequence, change));
            }
            while console.changes.len() > CHANGE_RING {
                console.changes.pop_front();
            }
        }
    }

    /// A queue's figures changed outside its rows.
    fn stamp(&mut self, key: &str) {
        self.revision += 1;
        if let Some(console) = self.console.get_mut(key) {
            console.stamp = self.revision;
        }
    }

    /// The queue list changed (a registration, a control, a refusal).
    fn queues_changed(&mut self) {
        self.revision += 1;
        self.queues_revision = self.revision;
    }

    /// Records a request the Tasks port refused, coalesced with an equal one.
    pub(crate) fn record_refused(
        &mut self,
        operation: &'static str,
        queue: QueueParts,
        status: u16,
        error: String,
    ) {
        let now = SystemTime::now();
        let existing = self.refused.iter().position(|entry| {
            entry.operation == operation
                && entry.queue == queue
                && entry.status == status
                && entry.error == error
        });
        let entry = match existing.and_then(|position| self.refused.remove(position)) {
            Some(mut entry) => {
                entry.count = entry.count.saturating_add(1);
                entry.last_at = now;
                entry
            }
            None => Refused {
                first_at: now,
                last_at: now,
                count: 1,
                operation,
                queue,
                status,
                error,
            },
        };
        self.refused.push_back(entry);
        if self.refused.len() > REFUSED_CAPACITY {
            self.refused.pop_front();
            self.refused_dropped += 1;
        }
        self.queues_changed();
    }

    fn controls(&self, key: &str) -> Controls {
        self.console
            .get(key)
            .map(|console| console.controls)
            .unwrap_or_default()
    }
}

impl TasksRuntime {
    /// Builds the runtime for `project`, registering one queue per function
    /// of `inventory` with a `taskQueueTrigger` (`defaultUri` is
    /// `{functions_origin}/{project}/{region}/{name}`). Call from inside a
    /// Tokio runtime so the ticker starts.
    #[must_use]
    pub fn new(
        project: &str,
        inventory: &FunctionsInventory,
        functions_origin: &str,
        log: impl Into<LogSink>,
    ) -> Self {
        let log = log.into();
        let http = reqwest::Client::builder().build().unwrap_or_default();
        let runtime = Self {
            inner: Arc::new(Inner {
                project: project.to_owned(),
                state: Mutex::new(State {
                    queues: IndexMap::new(),
                    console: HashMap::new(),
                    rejected: IndexMap::new(),
                    next_dispatch: 0,
                    next_task: 0,
                    next_finished: 0,
                    history_bytes: 0,
                    revision: 0,
                    queues_revision: 0,
                    refused: VecDeque::new(),
                    refused_dropped: 0,
                    lines: Vec::new(),
                    failed_total: 0,
                }),
                http,
                log: Mutex::new(log),
                ticker: Mutex::new(None),
                wake: tokio::sync::Notify::new(),
                revision: tokio::sync::watch::channel(0).0,
            }),
        };
        runtime.refresh_inventory(inventory, functions_origin);
        runtime.start_ticker();
        runtime
    }

    /// The project the runtime was built for.
    #[must_use]
    pub fn project(&self) -> &str {
        &self.inner.project
    }

    /// Registers every queue `inventory` declares. A key whose registration
    /// body is unchanged keeps its queue (the official Functions emulator
    /// re-registers only new or changed entry points, so pending tasks
    /// survive a reload); a new or changed one is registered as a `POST`
    /// would register it, replacing an existing queue of that key. Queues
    /// registered by callers or by earlier inventories stay: the official
    /// emulator never deletes a queue. A refused registration is kept with
    /// its reason until the key registers.
    pub fn refresh_inventory(&self, inventory: &FunctionsInventory, functions_origin: &str) {
        let discovered = discover(&self.inner.project, inventory, functions_origin);
        {
            // A refusal of a function no longer exported is forgotten.
            let mut state = lock(&self.inner.state);
            let before = state.rejected.len();
            state
                .rejected
                .retain(|key, _| discovered.iter().any(|queue| &queue.key == key));
            if state.rejected.len() != before {
                state.queues_changed();
            }
            self.finish(state);
        }
        for queue in discovered {
            let parts = QueueParts {
                project: queue.project.clone(),
                location: queue.region.clone(),
                queue: queue.name.clone(),
            };
            let config = match queue.config() {
                Ok(config) => config,
                Err(reason) => {
                    self.log(TasksLogLine::new(
                        "WARN",
                        format!("Error adding Task Queue function: {reason}"),
                        Some(parts),
                    ));
                    let mut state = lock(&self.inner.state);
                    let known = state
                        .rejected
                        .get(&queue.key)
                        .is_some_and(|rejected| rejected.reason == reason);
                    if !known {
                        state.rejected.insert(
                            queue.key.clone(),
                            RejectedQueue {
                                function_id: queue.function_id.clone(),
                                name: queue.name.clone(),
                                region: queue.region.clone(),
                                reason,
                                at: SystemTime::now(),
                            },
                        );
                        state.queues_changed();
                    }
                    self.finish(state);
                    continue;
                }
            };
            let unchanged = {
                let mut state = lock(&self.inner.state);
                if state.rejected.shift_remove(&queue.key).is_some() {
                    state.queues_changed();
                }
                let unchanged = state
                    .queues
                    .get(&queue.key)
                    .is_some_and(|existing| existing.config.document() == config.document());
                self.finish(state);
                unchanged
            };
            if unchanged {
                continue;
            }
            self.register_queue(
                &queue.key,
                config,
                QueueSource {
                    parts,
                    origin: QueueOrigin::Function,
                    function: Some(QueueFunction {
                        function_id: queue.function_id.clone(),
                        name: queue.name.clone(),
                        region: queue.region.clone(),
                    }),
                },
            );
        }
    }

    /// `createQueue`: registers `config` under `key`, replacing any queue
    /// already there; its pending, held and slotted tasks go to the history
    /// as replaced (they are lost officially too), while the console's
    /// pause, hold and history stay with the key.
    pub fn register_queue(&self, key: &str, config: QueueConfig, source: QueueSource) {
        self.log(TasksLogLine::new(
            "INFO",
            format!("Created queue with key: {key}"),
            Some(source.parts.clone()),
        ));
        self.log(TasksLogLine::new(
            "DEBUG",
            format!(
                "Created task queue {key} with configuration: {}",
                config.document().stringify()
            ),
            Some(source.parts.clone()),
        ));
        let queue = TaskQueue::new(key.to_owned(), config, Instant::now());
        let mut state = lock(&self.inner.state);
        let replaced = state
            .queues
            .insert(key.to_owned(), queue)
            .map(|mut old| old.drain_replaced());
        state.rejected.shift_remove(key);
        let now = SystemTime::now();
        match state.console.get_mut(key) {
            Some(console) => {
                console.source = source;
                console.registered_at = now;
                console.registrations += 1;
                console.last_replaced = Some(Replaced {
                    at: now,
                    dropped: replaced
                        .as_ref()
                        .map_or(0, |tasks| u32::try_from(tasks.len()).unwrap_or(u32::MAX)),
                });
                console.reset_changes();
            }
            None => {
                state
                    .console
                    .insert(key.to_owned(), QueueConsole::new(source, now));
            }
        }
        if let Some(replaced) = replaced {
            state.record_finished(key, replaced);
        }
        state.stamp(key);
        state.queues_changed();
        self.finish(state);
    }

    /// Whether a queue is registered under `key`.
    #[must_use]
    pub fn has_queue(&self, key: &str) -> bool {
        lock(&self.inner.state).queues.contains_key(key)
    }

    /// The registered queue's `taskQueueConfig` document.
    #[must_use]
    pub fn queue_config(&self, key: &str) -> Option<OrderedJson> {
        lock(&self.inner.state)
            .queues
            .get(key)
            .map(|queue| queue.config.document().clone())
    }

    /// The registered queue's `defaultUri` (`None` when registered without
    /// the key, `Some(Null)` when registered with `null`).
    #[must_use]
    pub fn default_uri(&self, key: &str) -> Option<Option<OrderedJson>> {
        lock(&self.inner.state)
            .queues
            .get(key)
            .map(|queue| queue.config.default_uri.clone())
    }

    /// The parts a queue registered with.
    #[must_use]
    pub fn queue_parts(&self, key: &str) -> Option<QueueParts> {
        lock(&self.inner.state)
            .console
            .get(key)
            .map(|console| console.source.parts.clone())
    }

    /// `TaskQueueController.enqueue`, after `start()` when the controller
    /// was not running. Returns the task's console id.
    pub fn enqueue(&self, key: &str, mut task: TaskRecord) -> Result<u64, EnqueueError> {
        self.start_ticker();
        let mut state = lock(&self.inner.state);
        let controls = state.controls(key);
        let id = state.next_task + 1;
        let queue = state
            .queues
            .get_mut(key)
            .ok_or(EnqueueError::UnknownQueue)?;
        if queue.name_reserved(&task.name) {
            return Err(EnqueueError::NameReserved);
        }
        if queue.full() {
            return Err(EnqueueError::QueueFull {
                capacity: QUEUE_CAPACITY,
            });
        }
        task.id = id;
        task.enqueued_at = SystemTime::now();
        queue
            .enqueue(task, Instant::now(), controls)
            .map_err(|Conflict| EnqueueError::NameReserved)?;
        state.next_task = id;
        self.finish(state);
        Ok(id)
    }

    /// The console's enqueue, the one path the console and the Functions
    /// section use: the task `firebase-admin`'s `TaskQueue.enqueue` would
    /// send for these options, through the wire's own preparation, held to
    /// the wire's 100 KiB request limit.
    pub fn enqueue_console(
        &self,
        key: &str,
        task: ConsoleTask,
    ) -> Result<EnqueuedTask, EnqueueError> {
        let (parts, default_uri) = {
            let state = lock(&self.inner.state);
            let parts = state
                .console
                .get(key)
                .map(|console| console.source.parts.clone());
            let default_uri = state
                .queues
                .get(key)
                .map(|queue| queue.config.default_uri.clone());
            match (parts, default_uri) {
                (Some(parts), Some(default_uri)) => (parts, default_uri),
                _ => return Err(EnqueueError::UnknownQueue),
            }
        };
        let mut object = crate::http::console_task(&parts, task)?;
        let size = crate::http::request_size(&object);
        if size > crate::http::JSON_LIMIT {
            return Err(EnqueueError::TooLarge {
                size,
                limit: crate::http::JSON_LIMIT,
            });
        }
        let mut record = crate::http::build_task(
            &mut object,
            crate::http::generated_name(&parts),
            default_uri.as_ref(),
        )
        .map_err(|error| EnqueueError::Invalid(error.0))?;
        record.origin = TaskOrigin::Console;
        let name = record.name.clone();
        let id = self.enqueue(key, record)?;
        self.log(
            TasksLogLine::new(
                "DEBUG",
                format!("Enqueueing task {name} onto {key}"),
                Some(parts),
            )
            .task(id, &name),
        );
        Ok(EnqueuedTask {
            key: key.to_owned(),
            id,
            name,
        })
    }

    /// Enqueues task `id` (pending, in a slot or finished) again from the
    /// console: the same URL, headers, body and deadline under a new
    /// generated name.
    pub fn enqueue_again(&self, key: &str, id: u64) -> Result<EnqueuedTask, EnqueueError> {
        let (parts, original) = {
            let state = lock(&self.inner.state);
            let queue = state.queues.get(key).ok_or(EnqueueError::UnknownQueue)?;
            let console = state.console.get(key).ok_or(EnqueueError::UnknownQueue)?;
            let original = queue
                .task(id)
                .or_else(|| {
                    console
                        .history
                        .iter()
                        .rev()
                        .find(|entry| entry.finished.task.id == id)
                        .map(|entry| Arc::clone(&entry.finished.task))
                })
                .ok_or(EnqueueError::UnknownTask)?;
            (console.source.parts.clone(), original)
        };
        let record = TaskRecord {
            id: 0,
            name: crate::http::generated_name(&parts),
            url: original.url.clone(),
            headers: original.headers.clone(),
            body: original.body.clone(),
            schedule_time: None,
            deadline: original.deadline,
            enqueued_at: SystemTime::now(),
            origin: TaskOrigin::Console,
            scheduled: None,
        };
        let name = record.name.clone();
        let id = self.enqueue(key, record)?;
        Ok(EnqueuedTask {
            key: key.to_owned(),
            id,
            name,
        })
    }

    /// `TaskQueueController.delete`.
    pub fn remove(&self, key: &str, name: &str) -> Result<(), RemoveError> {
        let mut state = lock(&self.inner.state);
        let queue = state.queues.get_mut(key).ok_or(RemoveError::UnknownQueue)?;
        let finished = queue
            .remove(name)
            .map_err(|NotFound| RemoveError::NotFound)?;
        state.record_finished(key, finished.into_iter().collect());
        self.finish(state);
        Ok(())
    }

    // ------------------------------------------------------ console controls

    /// Pauses or resumes a queue: paused, nothing leaves the pending queue
    /// and no token is taken; running tasks finish.
    pub fn set_paused(&self, key: &str, paused: bool) -> Result<(), ControlError> {
        self.control(key, |controls| controls.paused = paused)?;
        if !paused {
            self.inner.wake.notify_one();
        }
        Ok(())
    }

    /// Holds tasks scheduled for later until their time (on), or lets them
    /// run as soon as a slot is free, the emulator's own behaviour (off).
    pub fn set_hold_scheduled(&self, key: &str, enabled: bool) -> Result<(), ControlError> {
        self.control(key, |controls| controls.hold_scheduled = enabled)?;
        let mut state = lock(&self.inner.state);
        if let Some(queue) = state.queues.get_mut(key) {
            queue.set_hold(enabled, SystemTime::now());
        }
        self.finish(state);
        self.inner.wake.notify_one();
        Ok(())
    }

    fn control(&self, key: &str, change: impl FnOnce(&mut Controls)) -> Result<(), ControlError> {
        let mut state = lock(&self.inner.state);
        let console = state
            .console
            .get_mut(key)
            .ok_or(ControlError::UnknownQueue)?;
        change(&mut console.controls);
        state.stamp(key);
        state.queues_changed();
        self.finish(state);
        Ok(())
    }

    /// Runs task `id` now: a pending or held task takes a free slot past the
    /// token bucket and a pause; a task in backoff runs on the next tick.
    pub fn run_now(&self, key: &str, id: u64) -> Result<RunNow, ControlError> {
        let mut state = lock(&self.inner.state);
        let State {
            queues,
            next_dispatch,
            ..
        } = &mut *state;
        let queue = queues.get_mut(key).ok_or(ControlError::UnknownQueue)?;
        let ran =
            queue
                .run_now(id, Instant::now(), next_dispatch)
                .map_err(|error| match error {
                    RunNowError::NotFound => ControlError::UnknownTask,
                    RunNowError::Busy => ControlError::Busy,
                    RunNowError::Running => ControlError::Running,
                })?;
        self.finish(state);
        self.inner.wake.notify_one();
        Ok(ran)
    }

    /// Stops a slotted task's retries: waiting, it finishes as cancelled
    /// now; in flight, a failure cancels it instead of retrying.
    pub fn stop_retrying(&self, key: &str, id: u64) -> Result<Stopped, ControlError> {
        let mut state = lock(&self.inner.state);
        let queue = state
            .queues
            .get_mut(key)
            .ok_or(ControlError::UnknownQueue)?;
        let (stopped, finished) = match queue.stop_retrying(id) {
            Some(stopped) => stopped,
            None if queue.task(id).is_some() => return Err(ControlError::NotInSlot),
            None => return Err(ControlError::UnknownTask),
        };
        state.record_finished(key, finished.into_iter().collect());
        self.finish(state);
        Ok(stopped)
    }

    /// Deletes any task by id, an auto-named one included: `Queue.remove`
    /// for its name, as the wire's delete does, and its retries stopped
    /// when it holds a slot.
    pub fn remove_by_id(&self, key: &str, id: u64) -> Result<(), ControlError> {
        let mut state = lock(&self.inner.state);
        let queue = state
            .queues
            .get_mut(key)
            .ok_or(ControlError::UnknownQueue)?;
        let finished = queue
            .remove_by_id(id)
            .map_err(|NotFound| ControlError::UnknownTask)?;
        state.record_finished(key, finished);
        self.finish(state);
        Ok(())
    }

    /// Removes every pending and held task (and with `stop_retrying` stops
    /// every slotted one); returns how many it removed and stopped.
    pub fn purge(&self, key: &str, stop_retrying: bool) -> Result<(u32, u32), ControlError> {
        let mut state = lock(&self.inner.state);
        let queue = state
            .queues
            .get_mut(key)
            .ok_or(ControlError::UnknownQueue)?;
        let (finished, stopped) = queue.purge(stop_retrying);
        let removed = finished
            .iter()
            .filter(|task| task.outcome == TaskOutcome::Purged)
            .count();
        state.record_finished(key, finished);
        self.finish(state);
        Ok((u32::try_from(removed).unwrap_or(u32::MAX), stopped))
    }

    /// `getStatistics`: every queue's statistics in registration order.
    #[must_use]
    pub fn statistics(&self) -> OrderedJson {
        let now = Instant::now();
        let mut state = lock(&self.inner.state);
        OrderedJson::Object(
            state
                .queues
                .iter_mut()
                .map(|(key, queue)| (key.clone(), queue.statistics(now).to_json()))
                .collect(),
        )
    }

    /// Registered queue keys in registration order.
    #[must_use]
    pub fn queue_keys(&self) -> Vec<String> {
        lock(&self.inner.state).queues.keys().cloned().collect()
    }

    /// The HTTP application for the Tasks port.
    pub fn application(&self) -> axum::Router {
        crate::http::router(self.clone())
    }

    /// Stops the ticker (idempotent); in-flight requests still write back.
    pub async fn shutdown(&self) {
        let handle = lock(&self.inner.ticker).take();
        if let Some(handle) = handle {
            handle.abort();
            let _ = handle.await;
        }
    }

    /// Runs one tick synchronously: held tasks that came due join the
    /// pending queue, then token refill, dispatch and processing of every
    /// active queue; the requests it produces are sent. Returns how long
    /// the ticker sleeps next: the active cadence while any queue was active
    /// when the tick started (the official `listen()` decides from that),
    /// else the idle one, or less when a held task comes due sooner. A
    /// paused queue with no busy slot, and one whose tasks are all held, are
    /// idle.
    pub(crate) fn tick(&self) -> Duration {
        let (runs, active, next_due) = {
            let mut state = lock(&self.inner.state);
            let now = Instant::now();
            let wall = SystemTime::now();
            let now_ms = now_millis();
            let State {
                queues,
                console,
                next_dispatch,
                ..
            } = &mut *state;
            let mut runs = Vec::new();
            let mut finished = Vec::new();
            let mut active = false;
            let mut next_due: Option<SystemTime> = None;
            for (key, queue) in queues.iter_mut() {
                let controls = console
                    .get(key)
                    .map(|console| console.controls)
                    .unwrap_or_default();
                queue.release_due(wall);
                queue.trim_windows(now);
                queue.refill_tokens(now);
                if queue.is_active(controls) {
                    active = true;
                    queue.dispatch_tasks(now, next_dispatch, controls);
                    let mut done = Vec::new();
                    let started = queue.process(now, now_ms, &mut done);
                    if !started.is_empty()
                        && let Some(console) = console.get_mut(key)
                    {
                        console
                            .windows
                            .dispatched
                            .record(wall, u32::try_from(started.len()).unwrap_or(u32::MAX));
                    }
                    runs.extend(started);
                    if !done.is_empty() {
                        finished.push((key.clone(), done));
                    }
                }
                if let Some(due) = queue.next_held_due() {
                    next_due = Some(next_due.map_or(due, |next| next.min(due)));
                }
            }
            for (key, done) in finished {
                state.record_finished(&key, done);
            }
            self.finish(state);
            (runs, active, next_due)
        };
        for run in runs {
            let runtime = self.clone();
            if tokio::runtime::Handle::try_current().is_ok() {
                tokio::spawn(async move { runtime.run(run).await });
            }
        }
        if active {
            return ACTIVE_TICK;
        }
        next_due.map_or(IDLE_TICK, |due| {
            due.duration_since(SystemTime::now())
                .unwrap_or_default()
                .clamp(Duration::from_millis(1), IDLE_TICK)
        })
    }

    #[cfg(test)]
    pub(crate) fn with_state<R>(&self, apply: impl FnOnce(&mut State) -> R) -> R {
        apply(&mut lock(&self.inner.state))
    }

    /// Logs a line through the sink, now (never while the state is locked).
    pub(crate) fn log(&self, line: TasksLogLine) {
        let sink = lock(&self.inner.log).clone();
        sink.emit(line);
    }

    /// Replaces the log sink: every line from now on goes to `sink` (the
    /// suite hands the console's sink over once the runtime is built, so
    /// the lines keep their queue and task refs).
    pub fn set_log_sink(&self, sink: impl Into<LogSink>) {
        *lock(&self.inner.log) = sink.into();
    }

    /// A line naming its queue, for the HTTP handlers.
    pub(crate) fn log_for(&self, level: &'static str, text: impl Into<String>, queue: QueueParts) {
        self.log(TasksLogLine::new(level, text, Some(queue)));
    }

    /// Releases the state: moves the queues' changed rows into their rings,
    /// announces a new revision, and emits the lines logged under the lock.
    pub(crate) fn finish(&self, mut state: MutexGuard<'_, State>) {
        state.collect_changes();
        let revision = state.revision;
        let lines = std::mem::take(&mut state.lines);
        drop(state);
        self.inner.revision.send_if_modified(|announced| {
            let moved = *announced != revision;
            *announced = revision;
            moved
        });
        for line in lines {
            self.log(line);
        }
    }

    /// The state, locked, for the read models.
    pub(crate) fn lock_state(&self) -> MutexGuard<'_, State> {
        lock(&self.inner.state)
    }

    /// Records a request the Tasks port refused.
    pub(crate) fn refused(
        &self,
        operation: &'static str,
        queue: QueueParts,
        status: u16,
        error: String,
    ) {
        let mut state = lock(&self.inner.state);
        state.record_refused(operation, queue, status, error);
        self.finish(state);
    }

    /// A receiver of the console revision, bumped by every change a console
    /// view shows (rows, figures, registrations, controls, refusals).
    #[must_use]
    pub fn watch(&self) -> tokio::sync::watch::Receiver<u64> {
        self.inner.revision.subscribe()
    }

    /// Clears every queue's pending, held and slotted tasks, the histories,
    /// the reserved names, the statistics and the refused requests (the
    /// console's clear); queues, their configuration, pause and hold stay.
    /// Requests in flight finish, and their results are dropped.
    #[must_use = "the count is what the clear reports"]
    pub fn reset(&self) -> TasksResetCount {
        let mut state = lock(&self.inner.state);
        let mut count = TasksResetCount::default();
        let State {
            queues, console, ..
        } = &mut *state;
        for (key, queue) in queues.iter_mut() {
            count.names += u64::try_from(queue.reserved_names()).unwrap_or(u64::MAX);
            count.tasks += u64::try_from(queue.clear()).unwrap_or(u64::MAX);
            if let Some(console) = console.get_mut(key) {
                count.history += u64::try_from(console.history.len()).unwrap_or(u64::MAX);
                console.history.clear();
                console.outcomes = OutcomeCounts::default();
                console.history_bytes = 0;
                console.dropped = 0;
                console.windows = QueueWindows::default();
                console.reset_changes();
            }
        }
        state.history_bytes = 0;
        count.refused = u32::try_from(state.refused.len()).unwrap_or(u32::MAX);
        state.refused.clear();
        state.refused_dropped = 0;
        let keys: Vec<String> = state.queues.keys().cloned().collect();
        for key in keys {
            state.stamp(&key);
        }
        state.queues_changed();
        self.finish(state);
        count
    }

    fn start_ticker(&self) {
        let mut slot = lock(&self.inner.ticker);
        if slot.as_ref().is_some_and(|task| !task.is_finished()) {
            return;
        }
        let Ok(handle) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let runtime = self.clone();
        *slot = Some(handle.spawn(async move {
            let mut delay = IDLE_TICK;
            loop {
                tokio::select! {
                    () = tokio::time::sleep(delay) => {}
                    () = runtime.inner.wake.notified() => {}
                }
                delay = runtime.tick();
            }
        }));
    }

    /// `runTask`'s request, its outcome written back into the slot (or into
    /// the task's history entry when it left the slot meanwhile), then the
    /// first 1 KiB of the response attached.
    async fn run(&self, request: RunRequest) {
        let started_at = SystemTime::now();
        let started = Instant::now();
        let (outcome, error, response) = self.send(&request).await;
        let status = match outcome {
            Outcome::Status(status) => Some(status),
            Outcome::Failed => None,
        };
        let record = AttemptRecord {
            queue_key: request.queue_key.clone(),
            task_id: request.task_id,
            task_name: request.task_name.clone(),
            attempt: request.attempt,
            started_at,
            duration: started.elapsed(),
            status,
            error,
            response: None,
            counted_execution: status.is_some_and(|status| {
                !(200..=299).contains(&status) && !(500..=599).contains(&status)
            }),
            retry_count: request.attempt.saturating_sub(1),
        };
        let now = Instant::now();
        {
            let mut state = lock(&self.inner.state);
            let completed = state
                .queues
                .get_mut(&request.queue_key)
                .is_some_and(|queue| {
                    queue.complete(request.dispatch_id, outcome, record.clone(), now)
                });
            if !completed
                && state.attach_to_history(&request.queue_key, request.dispatch_id, record)
            {
                state.stamp(&request.queue_key);
            }
            self.finish(state);
        }
        let snippet = match response {
            Some(response) => read_snippet(response).await,
            None => None,
        };
        if let Some(text) = snippet {
            self.attach_response(&request, text);
        }
    }

    /// Attaches a response snippet to the attempt, in its slot or in its
    /// task's history entry.
    fn attach_response(&self, request: &RunRequest, text: String) {
        let mut state = lock(&self.inner.state);
        let text = match state.queues.get_mut(&request.queue_key) {
            Some(queue) => {
                match queue.attach_response(request.dispatch_id, request.attempt, text) {
                    Ok(()) => {
                        self.finish(state);
                        return;
                    }
                    Err(text) => text,
                }
            }
            None => text,
        };
        let Some(entry) = state.history_entry(&request.queue_key, request.dispatch_id) else {
            return;
        };
        let task = entry.finished.task.id;
        entry
            .finished
            .attempts
            .attach_response(request.attempt, text);
        // A finished task's detail changed: its history entry has the
        // snippet now.
        if let Some(console) = state.console.get_mut(&request.queue_key) {
            console.change_sequence += 1;
            console
                .changes
                .push_back((console.change_sequence, TaskChange::Detail(task)));
            while console.changes.len() > CHANGE_RING {
                console.changes.pop_front();
            }
        }
        state.stamp(&request.queue_key);
        self.finish(state);
    }

    /// Logs a dispatch failure with its queue and task.
    fn log_dispatch(&self, request: &RunRequest, error: &str) {
        let parts = self.queue_parts(&request.queue_key);
        self.log(TasksLogLine::new("WARN", error, parts).task(request.task_id, &request.task_name));
    }

    async fn send(
        &self,
        request: &RunRequest,
    ) -> (Outcome, Option<String>, Option<reqwest::Response>) {
        let Some(url) = &request.url else {
            let error = "TypeError: Only absolute URLs are supported".to_owned();
            self.log_dispatch(request, &error);
            return (Outcome::Failed, Some(error), None);
        };
        let mut headers = HeaderMap::new();
        for (name, value) in &request.headers {
            let (Ok(name), Ok(value)) = (
                HeaderName::from_bytes(name.as_bytes()),
                HeaderValue::from_str(value),
            ) else {
                let error = format!("TypeError: {name} is not a legal HTTP header name or value");
                self.log_dispatch(request, &error);
                return (Outcome::Failed, Some(error), None);
            };
            headers.append(name, value);
        }
        if !headers.contains_key(ACCEPT) {
            headers.insert(ACCEPT, HeaderValue::from_static("*/*"));
        }
        if !headers.contains_key(USER_AGENT) {
            headers.insert(USER_AGENT, HeaderValue::from_static(NODE_FETCH_USER_AGENT));
        }
        let sent = self
            .inner
            .http
            .post(url)
            .timeout(request.deadline)
            .headers(headers)
            .body(request.body.clone())
            .send()
            .await;
        match sent {
            Ok(response) => (
                Outcome::Status(response.status().as_u16()),
                None,
                Some(response),
            ),
            Err(error) => {
                let error = describe_error(&error, url);
                self.log_dispatch(request, &error);
                (Outcome::Failed, Some(error), None)
            }
        }
    }
}

/// The first 1 KiB of a response body, read for at most 500 ms.
async fn read_snippet(mut response: reqwest::Response) -> Option<String> {
    let mut body = Vec::new();
    let read = async {
        while body.len() < SNIPPET_BYTES {
            match response.chunk().await {
                Ok(Some(chunk)) => body.extend_from_slice(&chunk),
                Ok(None) | Err(_) => break,
            }
        }
    };
    let _ = tokio::time::timeout(SNIPPET_WAIT, read).await;
    if body.is_empty() {
        return None;
    }
    body.truncate(SNIPPET_BYTES);
    Some(String::from_utf8_lossy(&body).into_owned())
}

/// The `${e}` of the error `fetch` throws, in `node-fetch`'s wording.
fn describe_error(error: &reqwest::Error, url: &str) -> String {
    if error.is_timeout() {
        return "AbortError: The user aborted a request.".to_owned();
    }
    if error.is_builder() {
        return "TypeError: Only absolute URLs are supported".to_owned();
    }
    let mut reason = String::new();
    let mut source: Option<&(dyn std::error::Error + 'static)> = Some(error);
    while let Some(current) = source {
        if let Some(io) = current.downcast_ref::<std::io::Error>()
            && io.kind() == std::io::ErrorKind::ConnectionRefused
        {
            let authority = reqwest::Url::parse(url)
                .ok()
                .and_then(|parsed| {
                    Some(format!(
                        "{}:{}",
                        parsed.host_str()?,
                        parsed.port_or_known_default()?
                    ))
                })
                .unwrap_or_default();
            reason = format!("connect ECONNREFUSED {authority}");
            break;
        }
        reason = current.to_string();
        source = current.source();
    }
    format!("FetchError: request to {url} failed, reason: {reason}")
}
