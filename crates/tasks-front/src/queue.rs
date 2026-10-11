//! One queue's state machine: the pending FIFO with its name bookkeeping,
//! the token bucket, the dispatch slots and the retry ladder, reproduced
//! from the official `TaskQueue`/`Queue` pair, plus what only the console
//! reaches: each slot's attempt log, tasks held until their schedule time,
//! pause, run now, stop retrying and purge.

use std::collections::{BTreeMap, HashSet, VecDeque};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use indexmap::IndexMap;

use crate::config::{QUEUE_CAPACITY, QueueConfig};
use crate::json::{OrderedJson, js_max, js_min, js_number};

/// Who enqueued a task.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskOrigin {
    /// A client of the Tasks port (the Admin SDK, a function, a script).
    Wire,
    /// The console.
    Console,
}

impl TaskOrigin {
    /// `wire` or `console`.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Wire => "wire",
            Self::Console => "console",
        }
    }
}

/// The parts of an enqueued task the dispatcher uses.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskRecord {
    /// The console's id for the task: a runtime-wide sequence from 1,
    /// assigned at enqueue (0 until then).
    pub id: u64,
    /// `task.name` (a leading slash when the emulator generated it).
    pub name: String,
    /// `task.httpRequest.url` after the empty-string default; `None` is a
    /// non-string value (`undefined`, `null`, …) whose fetch throws.
    pub url: Option<String>,
    /// `task.httpRequest.headers` in order, values coerced with `${value}`.
    pub headers: Vec<(String, String)>,
    /// `JSON.stringify(task.httpRequest.body)`.
    pub body: String,
    /// `${task.scheduleTime}` when it is truthy.
    pub schedule_time: Option<String>,
    /// The dispatch deadline, `parseInt(dispatchDeadline.slice(0, -1))`
    /// seconds (60 without one); Node's `setTimeout` floor of one
    /// millisecond for unusable values.
    pub deadline: Duration,
    /// When it was enqueued.
    pub enqueued_at: SystemTime,
    pub origin: TaskOrigin,
    /// `schedule_time` as an instant: RFC 3339, or epoch milliseconds;
    /// `None` when it does not parse (the task is never held then).
    pub scheduled: Option<SystemTime>,
}

impl TaskRecord {
    /// `X-CloudTasks-TaskName`: `task.name.split("/").pop()`.
    #[must_use]
    pub fn short_name(&self) -> &str {
        self.name.rsplit('/').next().unwrap_or_default()
    }

    /// Auto-named by the emulator: the name starts with a slash, so the
    /// wire's delete can never name it.
    #[must_use]
    pub fn generated(&self) -> bool {
        self.name.starts_with('/')
    }

    /// The bytes it holds, for the history's budget.
    #[must_use]
    pub fn bytes(&self) -> usize {
        self.name.len()
            + self.body.len()
            + self.url.as_ref().map_or(0, String::len)
            + self.schedule_time.as_ref().map_or(0, String::len)
            + self
                .headers
                .iter()
                .map(|(name, value)| name.len() + value.len())
                .sum::<usize>()
    }
}

/// A `scheduleTime` as an instant: RFC 3339 (what the Admin SDK sends), or
/// a number of epoch milliseconds.
#[must_use]
pub fn parse_schedule_time(text: &str) -> Option<SystemTime> {
    let text = text.trim();
    if let Ok(millis) = text.parse::<u64>() {
        return UNIX_EPOCH.checked_add(Duration::from_millis(millis));
    }
    crate::rfc3339::parse(text)
}

/// One attempt of a task: what was sent and what came back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttemptRecord {
    /// The queue's key.
    pub queue_key: String,
    pub task_id: u64,
    pub task_name: String,
    /// From 1.
    pub attempt: u32,
    pub started_at: SystemTime,
    pub duration: Duration,
    /// The handler's HTTP status, when it answered.
    pub status: Option<u16>,
    /// Why no answer came, in `node-fetch`'s words.
    pub error: Option<String>,
    /// The first 1 KiB of the response body, attached once read.
    pub response: Option<String>,
    /// Whether it raised the execution count (any non-2xx, non-5xx answer).
    pub counted_execution: bool,
    /// The `X-CloudTasks-TaskRetryCount` it was sent with.
    pub retry_count: u32,
}

impl AttemptRecord {
    fn bytes(&self) -> usize {
        // The record's own fields beside its texts.
        96 + self.task_name.len()
            + self.error.as_ref().map_or(0, String::len)
            + self.response.as_ref().map_or(0, String::len)
    }
}

/// The attempts kept for one task: attempt 1 (never evicted, the telling
/// failure is often the first), the nine latest, and how many in between
/// were not kept.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AttemptLog {
    pub first: Option<AttemptRecord>,
    /// Oldest first.
    pub latest: VecDeque<AttemptRecord>,
    pub omitted: u32,
}

/// Attempts kept besides the first.
const LATEST_ATTEMPTS: usize = 9;

impl AttemptLog {
    pub(crate) fn push_record(&mut self, record: AttemptRecord) {
        if self.first.is_none() {
            self.first = Some(record);
            return;
        }
        self.latest.push_back(record);
        if self.latest.len() > LATEST_ATTEMPTS {
            self.latest.pop_front();
            self.omitted += 1;
        }
    }

    /// Attaches a response snippet to attempt `attempt`, returning it.
    pub(crate) fn attach_response(
        &mut self,
        attempt: u32,
        response: String,
    ) -> Option<AttemptRecord> {
        let record = self
            .first
            .iter_mut()
            .chain(self.latest.iter_mut())
            .find(|record| record.attempt == attempt)?;
        record.response = Some(response);
        Some(record.clone())
    }

    /// The kept attempts, oldest first.
    pub fn records(&self) -> impl Iterator<Item = &AttemptRecord> {
        self.first.iter().chain(self.latest.iter())
    }

    /// The newest attempt.
    #[must_use]
    pub fn last(&self) -> Option<&AttemptRecord> {
        self.latest.back().or(self.first.as_ref())
    }

    /// Attempts made, kept or not.
    #[must_use]
    pub fn count(&self) -> u32 {
        u32::from(self.first.is_some())
            + u32::try_from(self.latest.len()).unwrap_or(u32::MAX)
            + self.omitted
    }

    fn bytes(&self) -> usize {
        self.records().map(AttemptRecord::bytes).sum()
    }
}

/// What became of a task that left the queue for good.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskOutcome {
    Succeeded,
    /// It ran out of retries.
    Failed,
    /// The console stopped its retries.
    Cancelled,
    /// Deleted while pending, over the wire or from the console.
    Deleted,
    /// Removed by a purge.
    Purged,
    /// Dropped when its queue re-registered with new options.
    Replaced,
}

impl TaskOutcome {
    /// `succeeded`, `failed`, `cancelled`, `deleted`, `purged` or `replaced`.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
            Self::Deleted => "deleted",
            Self::Purged => "purged",
            Self::Replaced => "replaced",
        }
    }
}

/// A task that left the queue for good, on its way into the history.
#[derive(Debug, Clone)]
pub struct Finished {
    pub task: Arc<TaskRecord>,
    pub outcome: TaskOutcome,
    pub at: SystemTime,
    pub attempts: AttemptLog,
    pub execution_count: u32,
    pub previous_response: Option<u16>,
    /// The slot occupancy it left, so a request still in flight finishes
    /// into its history entry.
    pub dispatch_id: Option<u64>,
}

impl Finished {
    fn pending(task: Arc<TaskRecord>, outcome: TaskOutcome) -> Self {
        Self {
            task,
            outcome,
            at: SystemTime::now(),
            attempts: AttemptLog::default(),
            execution_count: 0,
            previous_response: None,
            dispatch_id: None,
        }
    }

    fn slotted(dispatch: Dispatch, outcome: TaskOutcome) -> Self {
        Self {
            task: dispatch.task,
            outcome,
            at: SystemTime::now(),
            attempts: dispatch.attempts,
            execution_count: dispatch.execution_count,
            previous_response: dispatch.previous_response,
            dispatch_id: Some(dispatch.id),
        }
    }

    /// The bytes it holds, for the history's budget.
    #[must_use]
    pub fn bytes(&self) -> usize {
        128 + self.task.bytes() + self.attempts.bytes()
    }
}

/// The console's controls a queue applies (they live beside the queue, so a
/// re-registration keeps them).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Controls {
    /// Nothing leaves the pending queue; running tasks finish.
    pub paused: bool,
    /// A task whose schedule time is in the future waits in `held`.
    pub hold_scheduled: bool,
}

/// Why the console's Run now could not run a task.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunNowError {
    /// No task of the queue has this id.
    NotFound,
    /// Every dispatch slot is busy.
    Busy,
    /// Its request is in flight.
    Running,
}

/// What the console's Run now did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunNow {
    /// A pending or held task took a free slot; it is sent on the next tick.
    Started,
    /// A task waiting out its backoff is sent on the next tick.
    BackoffSkipped,
    /// The task already holds a slot and is sent on the next tick.
    AlreadyStarting,
}

/// What the console's Stop retrying did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Stopped {
    /// It was waiting in its slot: the slot is free, the task finished as
    /// cancelled.
    Cancelled,
    /// Its request is in flight: a failure finishes it as cancelled instead
    /// of retrying (a success still succeeds).
    AfterRunning,
}

/// The dispatch deadline for a `task.dispatchDeadline` value.
#[must_use]
pub fn dispatch_deadline(value: Option<&OrderedJson>) -> Duration {
    /// Node clamps `setTimeout` delays outside `1..=2^31-1` to one millisecond.
    const MAX_TIMEOUT_MS: i64 = 2_147_483_647;
    let Some(value) = value.filter(|value| value.truthy()) else {
        return Duration::from_secs(60);
    };
    let Some(text) = value.as_str() else {
        // `dispatchDeadline.substring` throws before the response is awaited.
        return Duration::from_millis(1);
    };
    let mut chars = text.chars();
    chars.next_back();
    match crate::json::parse_int(chars.as_str()) {
        Some(seconds) if seconds > 0 && seconds.saturating_mul(1000) <= MAX_TIMEOUT_MS =>
        {
            #[allow(clippy::cast_sign_loss)]
            Duration::from_secs(seconds as u64)
        }
        _ => Duration::from_millis(1),
    }
}

/// `TaskStatus`, plus the console's cancellation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    NotStarted,
    Running,
    Retry,
    Failed,
    Finished,
    /// A stopped task's attempt failed: the slot frees without a retry.
    Cancelled,
}

/// A task occupying a dispatch slot with its `metadata`.
#[derive(Debug, Clone)]
pub struct Dispatch {
    /// Identifies this occupancy so a late response cannot touch a slot
    /// that was freed or refilled since.
    pub id: u64,
    pub task: Arc<TaskRecord>,
    pub status: Status,
    /// `currentAttempt`, 1 on the first run.
    pub attempt: u32,
    /// `currentBackoff` in seconds.
    pub backoff_seconds: f64,
    /// `startTime`.
    pub started: Instant,
    /// `lastRunTime`.
    pub last_run: Option<Instant>,
    /// `previousResponse`.
    pub previous_response: Option<u16>,
    /// `executionCount`.
    pub execution_count: u32,
    /// The attempts made in this slot.
    pub attempts: AttemptLog,
    /// The console asked to stop after the attempt in flight.
    pub stop_requested: bool,
    /// The console's Run now: skip what is left of the backoff.
    pub run_now: bool,
}

impl Dispatch {
    /// Waiting out its backoff before the next attempt.
    #[must_use]
    pub fn in_backoff(&self) -> bool {
        self.status == Status::Retry
            || (self.status == Status::NotStarted && self.last_run.is_some())
    }

    /// When the next attempt is due, while it waits out its backoff.
    #[must_use]
    pub fn next_attempt_in(&self, now: Instant) -> Option<Duration> {
        if self.status != Status::NotStarted || self.run_now {
            return None;
        }
        let last = self.last_run?;
        let due = last + Duration::try_from_secs_f64(self.backoff_seconds).ok()?;
        Some(due.saturating_duration_since(now))
    }
}

/// One HTTP request the engine wants sent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunRequest {
    pub queue_key: String,
    pub dispatch_id: u64,
    pub task_id: u64,
    pub task_name: String,
    /// The attempt this is, from 1.
    pub attempt: u32,
    pub url: Option<String>,
    /// Header lines in order: the emulator's, the caller's, then
    /// `X-CloudTasks-TaskPreviousResponse`.
    pub headers: Vec<(String, String)>,
    pub body: String,
    pub deadline: Duration,
}

/// What a sent request came back with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// A response with this status.
    Status(u16),
    /// The request threw (connection failure, invalid URL, abort).
    Failed,
}

/// `getStatistics()`.
#[derive(Debug, Clone, PartialEq)]
pub struct Statistics {
    pub number_of_tasks: i64,
    pub tasks_added: f64,
    pub completed_last_min: usize,
    pub failed_tasks: f64,
    pub running_tasks: usize,
    pub max_rate: OrderedJson,
    pub max_concurrent: OrderedJson,
}

impl Statistics {
    /// The JSON object in the official key order.
    #[must_use]
    pub fn to_json(&self) -> OrderedJson {
        let mut object = IndexMap::new();
        object.insert(
            "numberOfTasks".to_owned(),
            OrderedJson::Number(self.number_of_tasks.into()),
        );
        object.insert("tasksAdded".to_owned(), js_number(self.tasks_added));
        object.insert(
            "completedLastMin".to_owned(),
            OrderedJson::Number(self.completed_last_min.into()),
        );
        object.insert("failedTasks".to_owned(), js_number(self.failed_tasks));
        object.insert(
            "runningTasks".to_owned(),
            OrderedJson::Number(self.running_tasks.into()),
        );
        object.insert("maxRate".to_owned(), self.max_rate.clone());
        object.insert("maxConcurrent".to_owned(), self.max_concurrent.clone());
        OrderedJson::Object(object)
    }
}

/// Why `enqueue` rejected a task (the 409 path).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Conflict;

/// Why `remove` rejected a name (the 404 path).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NotFound;

/// One registered queue.
#[derive(Debug)]
pub struct TaskQueue {
    pub key: String,
    pub config: QueueConfig,
    /// Pending tasks in task-id order (enqueue order; a held task rejoins at
    /// its place).
    pending: VecDeque<Arc<TaskRecord>>,
    /// Tasks waiting for their schedule time while the console holds them,
    /// by due time; counted as pending by the official count.
    held: BTreeMap<(SystemTime, u64), Arc<TaskRecord>>,
    /// The official `Queue.count`: incremented on enqueue, decremented on
    /// dequeue *and* on remove, so removing a dispatched task takes it
    /// negative.
    count: i64,
    /// The official `nodeMap` keys: enqueued and not removed, whether or not
    /// the task has left the pending queue.
    known_names: HashSet<String>,
    /// The official `queuedIds`: every name ever enqueued (never cleared).
    queued_ids: HashSet<String>,
    slots: Vec<Option<Dispatch>>,
    /// The official `openDispatches` stack of free slot indexes.
    open: Vec<usize>,
    tokens: f64,
    max_tokens: f64,
    last_token_update: Instant,
    /// Wall-clock time of `last_token_update`, for the console's refill.
    refilled_at: SystemTime,
    added: VecDeque<Instant>,
    completed: VecDeque<Instant>,
    failed: VecDeque<Instant>,
    /// When the statistics windows were last trimmed.
    trimmed: Instant,
}

impl TaskQueue {
    #[must_use]
    pub fn new(key: String, config: QueueConfig, now: Instant) -> Self {
        let slots = config.slots;
        Self {
            key,
            max_tokens: js_max(config.max_dispatches_per_second, 1.1),
            config,
            pending: VecDeque::new(),
            held: BTreeMap::new(),
            count: 0,
            known_names: HashSet::new(),
            queued_ids: HashSet::new(),
            slots: (0..slots).map(|_| None).collect(),
            open: (0..slots).collect(),
            tokens: 0.0,
            last_token_update: now,
            refilled_at: SystemTime::now(),
            added: VecDeque::new(),
            completed: VecDeque::new(),
            failed: VecDeque::new(),
            trimmed: now,
        }
    }

    /// `TaskQueue.enqueue` + `Queue.enqueue`; the name is reserved or the
    /// queue full (the one 409 the wire answers for both).
    pub fn enqueue(
        &mut self,
        task: TaskRecord,
        now: Instant,
        controls: Controls,
    ) -> Result<(), Conflict> {
        if self.name_reserved(&task.name) || self.full() {
            return Err(Conflict);
        }
        self.known_names.insert(task.name.clone());
        self.queued_ids.insert(task.name.clone());
        let task = Arc::new(task);
        match task.scheduled {
            Some(due) if controls.hold_scheduled && due > SystemTime::now() => {
                self.held.insert((due, task.id), task);
            }
            _ => self.pending.push_back(task),
        }
        self.count += 1;
        self.added.push_back(now);
        Ok(())
    }

    /// The name was enqueued before in this run (names are kept for the
    /// life of the process, as officially).
    #[must_use]
    pub fn name_reserved(&self, name: &str) -> bool {
        self.queued_ids.contains(name) || self.known_names.contains(name)
    }

    /// The pending count reached the emulator's capacity.
    #[must_use]
    pub fn full(&self) -> bool {
        self.count >= QUEUE_CAPACITY
    }

    /// `Queue.remove`: any name still in the node map, pending or not. A
    /// pending (or held) task leaves for the history as deleted; one that
    /// already took a slot keeps running, as officially.
    pub fn remove(&mut self, name: &str) -> Result<Option<Finished>, NotFound> {
        if !self.known_names.remove(name) {
            return Err(NotFound);
        }
        self.count -= 1;
        Ok(self
            .take_waiting(|task| task.name == name)
            .map(|task| Finished::pending(task, TaskOutcome::Deleted)))
    }

    /// Takes the first pending or held task `matches` picks.
    fn take_waiting(&mut self, matches: impl Fn(&TaskRecord) -> bool) -> Option<Arc<TaskRecord>> {
        if let Some(position) = self.pending.iter().position(|task| matches(task)) {
            return self.pending.remove(position);
        }
        let key = *self.held.iter().find(|(_, task)| matches(task))?.0;
        self.held.remove(&key)
    }

    /// `isActive`, with the console's controls: a paused queue is idle
    /// unless a slot is busy, and held tasks wait without keeping it active.
    #[must_use]
    pub fn is_active(&self, controls: Controls) -> bool {
        (!controls.paused && !self.pending.is_empty()) || self.slots.iter().any(Option::is_some)
    }

    /// When the first held task comes due.
    #[must_use]
    pub fn next_held_due(&self) -> Option<SystemTime> {
        self.held.keys().next().map(|(due, _)| *due)
    }

    /// Moves held tasks whose time came into the pending queue, each at its
    /// place by task id.
    pub fn release_due(&mut self, now: SystemTime) {
        while let Some(entry) = self.held.first_entry() {
            if entry.key().0 > now {
                break;
            }
            let task = entry.remove();
            self.insert_pending(task);
        }
    }

    fn insert_pending(&mut self, task: Arc<TaskRecord>) {
        let position = self.pending.partition_point(|pending| pending.id < task.id);
        self.pending.insert(position, task);
    }

    /// Turns holding on or off: on, pending tasks scheduled for later wait;
    /// off, every held task rejoins the pending queue (the official
    /// behaviour).
    pub fn set_hold(&mut self, hold: bool, now: SystemTime) {
        if hold {
            let mut kept = VecDeque::with_capacity(self.pending.len());
            for task in std::mem::take(&mut self.pending) {
                match task.scheduled {
                    Some(due) if due > now => {
                        self.held.insert((due, task.id), task);
                    }
                    _ => kept.push_back(task),
                }
            }
            self.pending = kept;
        } else {
            for task in std::mem::take(&mut self.held).into_values() {
                self.insert_pending(task);
            }
        }
    }

    /// `refillTokens`, run once a second by the official interval.
    pub fn refill_tokens(&mut self, now: Instant) {
        let elapsed = now.saturating_duration_since(self.last_token_update);
        if elapsed < Duration::from_secs(1) {
            return;
        }
        let added = elapsed.as_secs_f64() * self.config.max_dispatches_per_second;
        self.tokens = js_min(self.tokens + added, self.max_tokens);
        self.last_token_update = now;
        self.refilled_at = SystemTime::now();
    }

    /// Trims the statistics windows once a second, as `getStatistics` would,
    /// so they stay five minutes long with nobody asking `/queueStats`.
    pub fn trim_windows(&mut self, now: Instant) {
        if now.saturating_duration_since(self.trimmed) < Duration::from_secs(1) {
            return;
        }
        self.trimmed = now;
        self.trim(now);
    }

    fn trim(&mut self, now: Instant) {
        let five_minutes = Duration::from_mins(5);
        let one_minute = Duration::from_secs(60);
        let expire = |window: &mut VecDeque<Instant>, span: Duration| {
            while window
                .front()
                .is_some_and(|at| now.saturating_duration_since(*at) >= span)
            {
                window.pop_front();
            }
        };
        expire(&mut self.added, five_minutes);
        expire(&mut self.failed, five_minutes);
        expire(&mut self.completed, one_minute);
    }

    /// `dispatchTasks`: pending tasks move into free slots while tokens
    /// last; a paused queue moves none and takes no tokens.
    pub fn dispatch_tasks(&mut self, now: Instant, next_id: &mut u64, controls: Controls) {
        if controls.paused {
            return;
        }
        while !self.pending.is_empty() && !self.open.is_empty() && self.tokens >= 1.0 {
            let Some(slot) = self.open.pop() else {
                break;
            };
            let Some(task) = self.pending.pop_front() else {
                break;
            };
            self.count -= 1;
            *next_id += 1;
            self.slots[slot] = Some(Dispatch::new(*next_id, task, now));
            self.tokens -= 1.0;
        }
    }

    /// `processDispatch`: frees finished and failed slots (handing them to
    /// `finished` for the history), starts runs whose backoff elapsed, and
    /// advances retries.
    pub fn process(
        &mut self,
        now: Instant,
        now_ms: u64,
        finished: &mut Vec<Finished>,
    ) -> Vec<RunRequest> {
        let mut runs = Vec::new();
        for index in 0..self.slots.len() {
            let Some(dispatch) = self.slots[index].as_mut() else {
                continue;
            };
            match dispatch.status {
                Status::Failed | Status::Finished | Status::Cancelled => {
                    let status = dispatch.status;
                    let Some(dispatch) = self.slots[index].take() else {
                        continue;
                    };
                    self.open.push(index);
                    let outcome = match status {
                        Status::Failed => {
                            self.completed.push_back(now);
                            self.failed.push_back(now);
                            TaskOutcome::Failed
                        }
                        Status::Finished => {
                            self.completed.push_back(now);
                            TaskOutcome::Succeeded
                        }
                        _ => TaskOutcome::Cancelled,
                    };
                    finished.push(Finished::slotted(dispatch, outcome));
                }
                Status::NotStarted => {
                    if !dispatch.run_now
                        && dispatch.last_run.is_some_and(|last| {
                            now.saturating_duration_since(last).as_secs_f64()
                                < dispatch.backoff_seconds
                        })
                    {
                        continue;
                    }
                    dispatch.run_now = false;
                    dispatch.status = Status::Running;
                    runs.push(build_request(&self.key, dispatch, now_ms));
                }
                Status::Retry => {
                    let config = &self.config;
                    if should_stop_retrying(dispatch, config, now) {
                        dispatch.status = Status::Failed;
                    } else {
                        update_metadata(dispatch, config);
                        dispatch.status = Status::NotStarted;
                    }
                }
                Status::Running => {}
            }
        }
        runs
    }

    /// Writes a request's outcome (and its attempt record) back into the
    /// slot that still holds the dispatch; a slot freed or refilled since
    /// ignores it and `false` comes back, so the caller can write the
    /// attempt into the task's history entry instead.
    pub fn complete(
        &mut self,
        dispatch_id: u64,
        outcome: Outcome,
        attempt: AttemptRecord,
        now: Instant,
    ) -> bool {
        let Some(dispatch) = self
            .slots
            .iter_mut()
            .flatten()
            .find(|dispatch| dispatch.id == dispatch_id && dispatch.status == Status::Running)
        else {
            return false;
        };
        dispatch.attempts.push_record(attempt);
        match outcome {
            Outcome::Status(status) if (200..=299).contains(&status) => {
                dispatch.status = Status::Finished;
            }
            Outcome::Status(status) => {
                if !(500..=599).contains(&status) {
                    dispatch.execution_count += 1;
                }
                dispatch.previous_response = Some(status);
                dispatch.status = Status::Retry;
                dispatch.last_run = Some(now);
            }
            Outcome::Failed => {
                dispatch.status = Status::Retry;
                dispatch.last_run = Some(now);
            }
        }
        if dispatch.stop_requested && dispatch.status == Status::Retry {
            dispatch.status = Status::Cancelled;
        }
        true
    }

    /// Attaches a response snippet to attempt `attempt` of the dispatch
    /// still in a slot.
    pub fn attach_response(
        &mut self,
        dispatch_id: u64,
        attempt: u32,
        response: String,
    ) -> Result<AttemptRecord, String> {
        match self
            .slots
            .iter_mut()
            .flatten()
            .find(|dispatch| dispatch.id == dispatch_id)
        {
            Some(dispatch) => dispatch
                .attempts
                .attach_response(attempt, response.clone())
                .ok_or(response),
            None => Err(response),
        }
    }

    // ------------------------------------------------------ console controls

    /// The console's Run now: a pending or held task takes a free slot past
    /// the token bucket and a pause; a task in backoff runs on the next tick.
    pub fn run_now(
        &mut self,
        id: u64,
        now: Instant,
        next_id: &mut u64,
    ) -> Result<RunNow, RunNowError> {
        if let Some(dispatch) = self
            .slots
            .iter_mut()
            .flatten()
            .find(|dispatch| dispatch.task.id == id)
        {
            return match dispatch.status {
                Status::Running => Err(RunNowError::Running),
                Status::NotStarted if dispatch.last_run.is_none() => Ok(RunNow::AlreadyStarting),
                Status::NotStarted | Status::Retry => {
                    dispatch.run_now = true;
                    Ok(RunNow::BackoffSkipped)
                }
                Status::Failed | Status::Finished | Status::Cancelled => {
                    Ok(RunNow::AlreadyStarting)
                }
            };
        }
        if !self.waiting(id) {
            return Err(RunNowError::NotFound);
        }
        let Some(slot) = self.open.pop() else {
            return Err(RunNowError::Busy);
        };
        let Some(task) = self.take_waiting(|task| task.id == id) else {
            self.open.push(slot);
            return Err(RunNowError::NotFound);
        };
        self.count -= 1;
        *next_id += 1;
        self.slots[slot] = Some(Dispatch::new(*next_id, task, now));
        Ok(RunNow::Started)
    }

    /// Task `id`, pending, held or in a slot.
    #[must_use]
    pub fn task(&self, id: u64) -> Option<Arc<TaskRecord>> {
        self.pending
            .iter()
            .chain(self.held.values())
            .chain(self.slots.iter().flatten().map(|dispatch| &dispatch.task))
            .find(|task| task.id == id)
            .cloned()
    }

    /// Whether task `id` is pending or held.
    fn waiting(&self, id: u64) -> bool {
        self.pending.iter().any(|task| task.id == id)
            || self.held.values().any(|task| task.id == id)
    }

    /// The console's Stop retrying for a task in a slot: waiting, its slot
    /// frees now (cancelled); in flight, a failure cancels instead of
    /// retrying. `None` when no slot holds the task.
    pub fn stop_retrying(&mut self, id: u64) -> Option<(Stopped, Option<Finished>)> {
        let index = self
            .slots
            .iter()
            .position(|slot| slot.as_ref().is_some_and(|dispatch| dispatch.task.id == id))?;
        let dispatch = self.slots[index].as_mut()?;
        match dispatch.status {
            Status::Running => {
                dispatch.stop_requested = true;
                Some((Stopped::AfterRunning, None))
            }
            Status::Failed | Status::Finished | Status::Cancelled => None,
            Status::NotStarted | Status::Retry => {
                let dispatch = self.slots[index].take()?;
                self.open.push(index);
                Some((
                    Stopped::Cancelled,
                    Some(Finished::slotted(dispatch, TaskOutcome::Cancelled)),
                ))
            }
        }
    }

    /// The console's delete by id: `Queue.remove` for its name (the official
    /// bookkeeping), and Stop retrying when it holds a slot.
    pub fn remove_by_id(&mut self, id: u64) -> Result<Vec<Finished>, NotFound> {
        let name = self
            .pending
            .iter()
            .chain(self.held.values())
            .map(Arc::as_ref)
            .chain(
                self.slots
                    .iter()
                    .flatten()
                    .map(|dispatch| dispatch.task.as_ref()),
            )
            .find(|task| task.id == id)
            .map(|task| task.name.clone())
            .ok_or(NotFound)?;
        let mut finished = Vec::new();
        if self.known_names.contains(&name) {
            finished.extend(self.remove(&name)?);
        }
        if let Some((_, Some(cancelled))) = self.stop_retrying(id) {
            finished.push(cancelled);
        }
        Ok(finished)
    }

    /// The console's purge: every pending and held task through `remove`'s
    /// bookkeeping (so the count and reserved names stay official), and
    /// with `stop_retrying` every slotted task stopped too. Returns the
    /// purged tasks, and the stopped ones with how many there were.
    pub fn purge(&mut self, stop_retrying: bool) -> (Vec<Finished>, u32) {
        let mut finished = Vec::new();
        let waiting: Vec<Arc<TaskRecord>> = std::mem::take(&mut self.pending)
            .into_iter()
            .chain(std::mem::take(&mut self.held).into_values())
            .collect();
        for task in waiting {
            if self.known_names.remove(&task.name) {
                self.count -= 1;
            }
            finished.push(Finished::pending(task, TaskOutcome::Purged));
        }
        let mut stopped = 0_u32;
        if stop_retrying {
            let ids: Vec<u64> = self
                .slots
                .iter()
                .flatten()
                .map(|dispatch| dispatch.task.id)
                .collect();
            for id in ids {
                if let Some((_, cancelled)) = self.stop_retrying(id) {
                    stopped += 1;
                    finished.extend(cancelled);
                }
            }
        }
        (finished, stopped)
    }

    /// Every pending, held and slotted task, leaving for the history as
    /// replaced (a re-registration replaces the queue).
    pub fn drain_replaced(&mut self) -> Vec<Finished> {
        let mut finished: Vec<Finished> = std::mem::take(&mut self.pending)
            .into_iter()
            .chain(std::mem::take(&mut self.held).into_values())
            .map(|task| Finished::pending(task, TaskOutcome::Replaced))
            .collect();
        for slot in &mut self.slots {
            if let Some(dispatch) = slot.take() {
                finished.push(Finished::slotted(dispatch, TaskOutcome::Replaced));
            }
        }
        finished
    }

    /// Drops every pending, held and slotted task and every reserved name,
    /// and empties the statistics (the console's clear); requests in
    /// flight finish into nothing. Returns how many tasks it dropped.
    pub fn clear(&mut self) -> usize {
        let dropped = self.pending.len()
            + self.held.len()
            + self.slots.iter().filter(|slot| slot.is_some()).count();
        self.pending.clear();
        self.held.clear();
        self.slots.fill(None);
        self.open = (0..self.slots.len()).collect();
        self.count = 0;
        self.known_names.clear();
        self.queued_ids.clear();
        self.added.clear();
        self.completed.clear();
        self.failed.clear();
        dropped
    }

    /// `getStatistics`, pruning the time windows as the official does.
    pub fn statistics(&mut self, now: Instant) -> Statistics {
        self.trim(now);
        #[allow(clippy::cast_precision_loss)]
        Statistics {
            number_of_tasks: self.count,
            tasks_added: self.added.len() as f64 / 5.0,
            completed_last_min: self.completed.len(),
            failed_tasks: self.failed.len() as f64 / 5.0,
            running_tasks: self.slots.len(),
            max_rate: self.config.max_rate(),
            max_concurrent: self.config.max_concurrent(),
        }
    }

    /// The pending task names, for tests and diagnostics.
    #[must_use]
    pub fn pending_names(&self) -> Vec<String> {
        self.pending.iter().map(|task| task.name.clone()).collect()
    }

    /// The pending tasks, in task-id order.
    pub fn pending(&self) -> impl ExactSizeIterator<Item = &Arc<TaskRecord>> {
        self.pending.iter()
    }

    /// The held tasks, by due time.
    pub fn held(&self) -> impl ExactSizeIterator<Item = &Arc<TaskRecord>> {
        self.held.values()
    }

    /// The statistics windows' lengths: added and failed in five minutes,
    /// completed in one.
    #[must_use]
    pub fn window_lengths(&self) -> (usize, usize, usize) {
        (self.added.len(), self.completed.len(), self.failed.len())
    }

    /// The dispatch slot count and how many are busy.
    #[must_use]
    pub fn slot_usage(&self) -> (usize, usize) {
        (
            self.slots.len(),
            self.slots.iter().filter(|slot| slot.is_some()).count(),
        )
    }

    /// The bucket at its last refill, the bucket's size and when it was
    /// refilled (wall clock).
    #[must_use]
    pub fn bucket(&self) -> (f64, f64, SystemTime) {
        (self.tokens, self.max_tokens, self.refilled_at)
    }

    /// The dispatches occupying slots, for tests and diagnostics.
    #[must_use]
    pub fn dispatches(&self) -> Vec<Dispatch> {
        self.slots.iter().flatten().cloned().collect()
    }

    /// The signed pending count.
    #[must_use]
    pub fn count(&self) -> i64 {
        self.count
    }

    /// Overrides the token bucket (tests).
    pub fn set_tokens(&mut self, tokens: f64) {
        self.tokens = tokens;
    }

    /// The token bucket.
    #[must_use]
    pub fn tokens(&self) -> f64 {
        self.tokens
    }
}

/// `shouldStopRetrying`: past `maxAttempts`, unless `maxRetrySeconds` still
/// has time on the clock.
fn should_stop_retrying(dispatch: &Dispatch, config: &QueueConfig, now: Instant) -> bool {
    if f64::from(dispatch.attempt) > config.max_attempts {
        let Some(seconds) = config.max_retry_seconds else {
            return true;
        };
        if seconds == 0.0 {
            return true;
        }
        let elapsed_ms = now
            .saturating_duration_since(dispatch.started)
            .as_secs_f64()
            * 1000.0;
        return elapsed_ms > seconds * 1000.0;
    }
    false
}

/// `updateMetadata`: exponential backoff with `maxDoublings`, then the next
/// attempt number.
fn update_metadata(dispatch: &mut Dispatch, config: &QueueConfig) {
    let attempt = f64::from(dispatch.attempt);
    let multiplier = 2f64.powf(js_min(attempt - 1.0, config.max_doublings))
        + js_max(0.0, attempt - config.max_doublings - 1.0) * 2f64.powf(config.max_doublings);
    dispatch.backoff_seconds = js_min(
        config.max_backoff_seconds,
        multiplier * config.min_backoff_seconds,
    );
    dispatch.attempt += 1;
}

impl Dispatch {
    fn new(id: u64, task: Arc<TaskRecord>, now: Instant) -> Self {
        Self {
            id,
            task,
            status: Status::NotStarted,
            attempt: 1,
            backoff_seconds: 0.0,
            started: now,
            last_run: None,
            previous_response: None,
            execution_count: 0,
            attempts: AttemptLog::default(),
            stop_requested: false,
            run_now: false,
        }
    }
}

/// The request `runTask` sends for a dispatch.
fn build_request(queue_key: &str, dispatch: &Dispatch, now_ms: u64) -> RunRequest {
    let task = &dispatch.task;
    let mut headers: Vec<(String, String)> = vec![
        ("Content-Type".to_owned(), "application/json".to_owned()),
        ("X-CloudTasks-QueueName".to_owned(), queue_key.to_owned()),
        (
            "X-CloudTasks-TaskName".to_owned(),
            task.short_name().to_owned(),
        ),
        (
            "X-CloudTasks-TaskRetryCount".to_owned(),
            (dispatch.attempt - 1).to_string(),
        ),
        (
            "X-CloudTasks-TaskExecutionCount".to_owned(),
            dispatch.execution_count.to_string(),
        ),
        (
            "X-CloudTasks-TaskETA".to_owned(),
            task.schedule_time
                .clone()
                .unwrap_or_else(|| now_ms.to_string()),
        ),
    ];
    for (name, value) in &task.headers {
        spread(&mut headers, name, value);
    }
    if let Some(previous) = dispatch.previous_response.filter(|status| *status != 0) {
        spread(
            &mut headers,
            "X-CloudTasks-TaskPreviousResponse",
            &previous.to_string(),
        );
    }
    RunRequest {
        queue_key: queue_key.to_owned(),
        dispatch_id: dispatch.id,
        task_id: task.id,
        task_name: task.name.clone(),
        attempt: dispatch.attempt,
        url: task.url.clone(),
        headers,
        body: task.body.clone(),
        deadline: task.deadline,
    }
}

/// Object-spread assignment: an existing key (exact case) keeps its position
/// with the new value, a new key is appended.
fn spread(headers: &mut Vec<(String, String)>, name: &str, value: &str) {
    if let Some(entry) = headers.iter_mut().find(|(key, _)| key == name) {
        value.clone_into(&mut entry.1);
    } else {
        headers.push((name.to_owned(), value.to_owned()));
    }
}

/// `Date.now()`.
#[must_use]
pub fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis())
        .map(|millis| u64::try_from(millis).unwrap_or(u64::MAX))
        .unwrap_or_default()
}
