//! One queue's state machine: the pending FIFO with its name bookkeeping,
//! the token bucket, the dispatch slots and the retry ladder, reproduced
//! from the official `TaskQueue`/`Queue` pair.

use std::collections::{HashSet, VecDeque};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use indexmap::IndexMap;

use crate::config::{QUEUE_CAPACITY, QueueConfig};
use crate::json::{OrderedJson, js_max, js_min, js_number};

/// The parts of an enqueued task the dispatcher uses.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskRecord {
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
}

impl TaskRecord {
    /// `X-CloudTasks-TaskName`: `task.name.split("/").pop()`.
    #[must_use]
    pub fn short_name(&self) -> &str {
        self.name.rsplit('/').next().unwrap_or_default()
    }
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

/// `TaskStatus`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    NotStarted,
    Running,
    Retry,
    Failed,
    Finished,
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
}

/// One HTTP request the engine wants sent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunRequest {
    pub queue_key: String,
    pub dispatch_id: u64,
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
    pending: VecDeque<Arc<TaskRecord>>,
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
    added: Vec<Instant>,
    completed: Vec<Instant>,
    failed: Vec<Instant>,
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
            count: 0,
            known_names: HashSet::new(),
            queued_ids: HashSet::new(),
            slots: (0..slots).map(|_| None).collect(),
            open: (0..slots).collect(),
            tokens: 0.0,
            last_token_update: now,
            added: Vec::new(),
            completed: Vec::new(),
            failed: Vec::new(),
        }
    }

    /// `TaskQueue.enqueue` + `Queue.enqueue`.
    pub fn enqueue(&mut self, task: TaskRecord, now: Instant) -> Result<(), Conflict> {
        if self.queued_ids.contains(&task.name)
            || self.count >= QUEUE_CAPACITY
            || self.known_names.contains(&task.name)
        {
            return Err(Conflict);
        }
        self.known_names.insert(task.name.clone());
        self.queued_ids.insert(task.name.clone());
        self.pending.push_back(Arc::new(task));
        self.count += 1;
        self.added.push(now);
        Ok(())
    }

    /// `Queue.remove`: any name still in the node map, pending or not.
    pub fn remove(&mut self, name: &str) -> Result<(), NotFound> {
        if !self.known_names.remove(name) {
            return Err(NotFound);
        }
        self.pending.retain(|task| task.name != name);
        self.count -= 1;
        Ok(())
    }

    /// `isActive`.
    #[must_use]
    pub fn is_active(&self) -> bool {
        !self.pending.is_empty() || self.slots.iter().any(Option::is_some)
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
    }

    /// `dispatchTasks`: pending tasks move into free slots while tokens last.
    pub fn dispatch_tasks(&mut self, now: Instant, next_id: &mut u64) {
        while !self.pending.is_empty() && !self.open.is_empty() && self.tokens >= 1.0 {
            let Some(slot) = self.open.pop() else {
                break;
            };
            let Some(task) = self.pending.pop_front() else {
                break;
            };
            self.count -= 1;
            *next_id += 1;
            self.slots[slot] = Some(Dispatch {
                id: *next_id,
                task,
                status: Status::NotStarted,
                attempt: 1,
                backoff_seconds: 0.0,
                started: now,
                last_run: None,
                previous_response: None,
                execution_count: 0,
            });
            self.tokens -= 1.0;
        }
    }

    /// `processDispatch`: frees finished and failed slots, starts runs whose
    /// backoff elapsed, and advances retries.
    pub fn process(&mut self, now: Instant, now_ms: u64) -> Vec<RunRequest> {
        let mut runs = Vec::new();
        for index in 0..self.slots.len() {
            let Some(dispatch) = self.slots[index].as_mut() else {
                continue;
            };
            match dispatch.status {
                Status::Failed => {
                    self.slots[index] = None;
                    self.open.push(index);
                    self.completed.push(now);
                    self.failed.push(now);
                }
                Status::Finished => {
                    self.slots[index] = None;
                    self.open.push(index);
                    self.completed.push(now);
                }
                Status::NotStarted => {
                    if dispatch.last_run.is_some_and(|last| {
                        now.saturating_duration_since(last).as_secs_f64() < dispatch.backoff_seconds
                    }) {
                        continue;
                    }
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

    /// Writes a request's outcome back into the slot that still holds the
    /// dispatch; a slot freed or refilled since ignores it.
    pub fn complete(&mut self, dispatch_id: u64, outcome: Outcome, now: Instant) {
        let Some(dispatch) = self
            .slots
            .iter_mut()
            .flatten()
            .find(|dispatch| dispatch.id == dispatch_id && dispatch.status == Status::Running)
        else {
            return;
        };
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
    }

    /// `getStatistics`, pruning the time windows as the official does.
    pub fn statistics(&mut self, now: Instant) -> Statistics {
        let five_minutes = Duration::from_mins(5);
        let one_minute = Duration::from_secs(60);
        self.added
            .retain(|at| now.saturating_duration_since(*at) < five_minutes);
        self.failed
            .retain(|at| now.saturating_duration_since(*at) < five_minutes);
        self.completed
            .retain(|at| now.saturating_duration_since(*at) < one_minute);
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
