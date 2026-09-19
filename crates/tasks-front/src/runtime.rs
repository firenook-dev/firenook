//! The Tasks runtime: the registered queues behind one mutex, the ticker
//! that refills tokens and drives every active queue's state machine, and
//! the `reqwest` sender that plays `runTask`'s `fetch`.

use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use axum::http::header::{ACCEPT, USER_AGENT};
use axum::http::{HeaderMap, HeaderName, HeaderValue};
use fireside_functions_bridge::FunctionsInventory;
use indexmap::IndexMap;

use crate::config::QueueConfig;
use crate::functions::discover;
use crate::json::OrderedJson;
use crate::queue::{Conflict, NotFound, Outcome, RunRequest, TaskQueue, TaskRecord, now_millis};

/// Receives the emulator's log lines: `level` is `INFO`, `WARN`, `ERROR` or
/// `DEBUG`, `text` the line without a label.
pub type LogSink = Arc<dyn Fn(&str, &str) + Send + Sync>;

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

/// Every registered queue, in registration order (`Object.entries` order
/// of the official controller's `queues`).
pub(crate) struct State {
    pub queues: IndexMap<String, TaskQueue>,
    pub next_dispatch: u64,
}

struct Inner {
    project: String,
    state: Mutex<State>,
    http: reqwest::Client,
    log: LogSink,
    ticker: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

/// Shared Tasks state; cheap to clone.
#[derive(Clone)]
pub struct TasksRuntime {
    inner: Arc<Inner>,
}

/// Why an enqueue was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnqueueError {
    /// No queue has this key (a 404).
    UnknownQueue,
    /// The name was used before, or the queue is full (a 409).
    Conflict,
}

/// Why a delete was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoveError {
    /// No queue has this key (a 404).
    UnknownQueue,
    /// The name is not in the queue's node map (a 404).
    NotFound,
}

pub(crate) fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
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
        log: LogSink,
    ) -> Self {
        let http = reqwest::Client::builder().build().unwrap_or_default();
        let runtime = Self {
            inner: Arc::new(Inner {
                project: project.to_owned(),
                state: Mutex::new(State {
                    queues: IndexMap::new(),
                    next_dispatch: 0,
                }),
                http,
                log,
                ticker: Mutex::new(None),
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
    /// emulator never deletes a queue.
    pub fn refresh_inventory(&self, inventory: &FunctionsInventory, functions_origin: &str) {
        for queue in discover(&self.inner.project, inventory, functions_origin) {
            let config = match queue.config() {
                Ok(config) => config,
                Err(reason) => {
                    self.log(
                        "WARN",
                        &format!("Error adding Task Queue function: {reason}"),
                    );
                    continue;
                }
            };
            let unchanged = lock(&self.inner.state)
                .queues
                .get(&queue.key)
                .is_some_and(|existing| existing.config.document() == config.document());
            if unchanged {
                continue;
            }
            self.register_queue(&queue.key, config);
        }
    }

    /// `createQueue`: registers `config` under `key`, replacing any queue
    /// already there (its pending tasks, names and statistics are lost, as
    /// they are officially).
    pub fn register_queue(&self, key: &str, config: QueueConfig) {
        self.log("INFO", &format!("Created queue with key: {key}"));
        self.log(
            "DEBUG",
            &format!(
                "Created task queue {key} with configuration: {}",
                config.document().stringify()
            ),
        );
        let queue = TaskQueue::new(key.to_owned(), config, Instant::now());
        lock(&self.inner.state).queues.insert(key.to_owned(), queue);
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

    /// `TaskQueueController.enqueue`, after `start()` when the controller
    /// was not running.
    pub fn enqueue(&self, key: &str, task: TaskRecord) -> Result<(), EnqueueError> {
        self.start_ticker();
        let mut state = lock(&self.inner.state);
        let queue = state
            .queues
            .get_mut(key)
            .ok_or(EnqueueError::UnknownQueue)?;
        queue
            .enqueue(task, Instant::now())
            .map_err(|Conflict| EnqueueError::Conflict)
    }

    /// `TaskQueueController.delete`.
    pub fn remove(&self, key: &str, name: &str) -> Result<(), RemoveError> {
        let mut state = lock(&self.inner.state);
        let queue = state.queues.get_mut(key).ok_or(RemoveError::UnknownQueue)?;
        queue.remove(name).map_err(|NotFound| RemoveError::NotFound)
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

    /// Runs one tick synchronously: token refill, dispatch and processing
    /// of every active queue; the requests it produces are sent.
    /// Returns whether any queue was active when the tick started (the
    /// official `listen()` decides its next delay from that).
    pub(crate) fn tick(&self) -> bool {
        let (runs, active) = {
            let mut state = lock(&self.inner.state);
            let now = Instant::now();
            let now_ms = now_millis();
            let State {
                queues,
                next_dispatch,
            } = &mut *state;
            let mut runs = Vec::new();
            let mut active = false;
            for queue in queues.values_mut() {
                queue.refill_tokens(now);
                if queue.is_active() {
                    active = true;
                    queue.dispatch_tasks(now, next_dispatch);
                    runs.extend(queue.process(now, now_ms));
                }
            }
            (runs, active)
        };
        for run in runs {
            let runtime = self.clone();
            if tokio::runtime::Handle::try_current().is_ok() {
                tokio::spawn(async move { runtime.run(run).await });
            }
        }
        active
    }

    #[cfg(test)]
    pub(crate) fn with_state<R>(&self, apply: impl FnOnce(&mut State) -> R) -> R {
        apply(&mut lock(&self.inner.state))
    }

    pub(crate) fn log(&self, level: &str, text: &str) {
        (self.inner.log)(level, text);
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
                tokio::time::sleep(delay).await;
                delay = if runtime.tick() {
                    ACTIVE_TICK
                } else {
                    IDLE_TICK
                };
            }
        }));
    }

    /// `runTask`'s request and its outcome written back into the slot.
    async fn run(&self, request: RunRequest) {
        let outcome = self.send(&request).await;
        let now = Instant::now();
        let mut state = lock(&self.inner.state);
        if let Some(queue) = state.queues.get_mut(&request.queue_key) {
            queue.complete(request.dispatch_id, outcome, now);
        }
    }

    async fn send(&self, request: &RunRequest) -> Outcome {
        let Some(url) = &request.url else {
            self.log("WARN", "TypeError: Only absolute URLs are supported");
            return Outcome::Failed;
        };
        let mut headers = HeaderMap::new();
        for (name, value) in &request.headers {
            let (Ok(name), Ok(value)) = (
                HeaderName::from_bytes(name.as_bytes()),
                HeaderValue::from_str(value),
            ) else {
                self.log(
                    "WARN",
                    &format!("TypeError: {name} is not a legal HTTP header name or value"),
                );
                return Outcome::Failed;
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
            Ok(response) => Outcome::Status(response.status().as_u16()),
            Err(error) => {
                self.log("WARN", &describe_error(&error, url));
                Outcome::Failed
            }
        }
    }
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
