//! Cloud Tasks' live topics: `tasks.counters` (each queue's figures,
//! compared by the Tasks revision) and `tasks.queue` (the row keys and task
//! ids to read again, and the finished tasks of one queue). A queue's
//! attempts as they happen are compute's: each is an invocation.

use std::collections::VecDeque;
use std::sync::Arc;
use std::time::Duration;

use firenook_tasks_front::TaskChange;
use firenook_tasks_front::inspect::{TasksCursor, TasksScope};
use futures_util::StreamExt as _;
use futures_util::stream;
use serde::Deserialize;
use tokio::sync::watch;
use tokio::time::Instant;

use super::convert;
use super::types::{TasksCountersFrame, TasksFinishedBatch, TasksQueuesChanged, TasksStale};
use crate::api_error::ApiError;
use crate::late::Late;
use crate::live::{LiveTopic, ResetReason, TopicEvent, TopicStream, topic_params};
use crate::messaging::TasksConsole;
use crate::messaging::shared::KeyWindow;
use crate::section::SectionContext;
use crate::sse::Shutdown;

/// The shortest gap between two counters frames to one subscriber.
const COUNTERS_EVERY: Duration = Duration::from_millis(250);
/// After a `reset` for too many changes, the next frame waits this long.
const RESET_PAUSE: Duration = Duration::from_secs(1);
/// Changed queues one frame lists before it resets.
const MAX_CHANGED: usize = 200;
/// Queues the state a subscriber without a cursor opens with may hold; a
/// project with more opens with `reset` (it reloads).
const OPEN_MAX: usize = 1_000;
/// How long `tasks.queue` collects keys before it sends them.
const KEY_WINDOW: Duration = Duration::from_millis(100);
/// Finished ids a `finished` event names at most.
const MAX_IDS: usize = 100;

/// Cloud Tasks' live topics.
pub(crate) fn topics(
    late: &Late<TasksConsole>,
    context: &SectionContext,
) -> Vec<Arc<dyn LiveTopic>> {
    let shared = Shared {
        late: late.clone(),
        project: context.project.to_string(),
        shutdown: context.shutdown.clone(),
    };
    vec![
        Arc::new(CountersTopic(shared.clone())),
        Arc::new(QueueTopic(shared)),
    ]
}

#[derive(Clone)]
struct Shared {
    late: Late<TasksConsole>,
    project: String,
    shutdown: Shutdown,
}

/// A topic that needs the late runtime: built at once when the runtime is
/// there (so the subscriber's position is where it subscribed), else once
/// it arrives; the suite stopping first ends the subscription.
fn after_start(
    shared: &Shared,
    body: impl FnOnce(TasksConsole) -> TopicStream + Send + 'static,
) -> TopicStream {
    if let Ok(console) = shared.late.get() {
        return body(console);
    }
    let late = shared.late.clone();
    let shutdown = shared.shutdown.clone();
    let mut body = Some(body);
    stream::once(async move { late.wait(shutdown).await })
        .flat_map(move |console| match (console, body.take()) {
            (Some(console), Some(body)) => body(console),
            _ => stream::once(async {
                TopicEvent::End(Some(
                    ApiError::unavailable("The engine stopped before Cloud Tasks started.")
                        .detail()
                        .clone(),
                ))
            })
            .boxed(),
        })
        .boxed()
}

// ------------------------------------------------------------ tasks.counters

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CountersParams {
    #[serde(default)]
    project: Option<String>,
}

struct CountersTopic(Shared);

impl LiveTopic for CountersTopic {
    fn name(&self) -> &'static str {
        "tasks.counters"
    }

    fn open(
        &self,
        params: &serde_json::Value,
        after: Option<&str>,
    ) -> Result<TopicStream, ApiError> {
        let params: CountersParams = topic_params(params)?;
        let project = params
            .project
            .filter(|project| !project.is_empty())
            .unwrap_or_else(|| self.0.project.clone());
        let after = after.and_then(|after| after.parse::<u64>().ok());
        Ok(after_start(&self.0, move |console| {
            Counters::open(console, project, after)
        }))
    }
}

/// One `tasks.counters` subscriber. Without a cursor it opens with the
/// state, every queue's counters of the project in one frame whose revision
/// is its cursor; with one it resumes (nothing when current, else `reset`).
struct Counters {
    console: TasksConsole,
    scope: TasksScope,
    cursor: TasksCursor,
    watch: watch::Receiver<u64>,
    last: Option<Instant>,
    pause_until: Option<Instant>,
    /// The opening state is still to send (read on the first poll).
    opening: bool,
    outbox: VecDeque<TopicEvent>,
}

impl Counters {
    fn open(console: TasksConsole, project: String, after: Option<u64>) -> TopicStream {
        let mut watch = console.runtime.watch();
        watch.mark_unchanged();
        let mut probe = TasksCursor::at(u64::MAX);
        let now = console
            .runtime
            .console_delta(&mut probe, &TasksScope::default())
            .revision;
        let mut outbox = VecDeque::new();
        if after.is_some_and(|after| after != now) {
            outbox.push_back(TopicEvent::Reset {
                reason: ResetReason::Gap,
                missed: None,
            });
        }
        let state = Self {
            console,
            scope: TasksScope {
                project: Some(project),
                counters: true,
                queue: None,
                max_changed: MAX_CHANGED,
            },
            cursor: TasksCursor::at(now),
            watch,
            last: None,
            pause_until: None,
            opening: after.is_none(),
            outbox,
        };
        stream::unfold(state, |mut state| async move {
            state.next().await.map(|event| (event, state))
        })
        .boxed()
    }

    /// The state a subscriber without a cursor opens with: the project's
    /// queues read once, then whatever changed between that read and the
    /// cursor's, so the frame is the state at its revision.
    fn open_frame(&mut self) {
        let project = self.scope.project.clone();
        let list = self.console.runtime.queues_view(project.as_deref());
        let mut queues: std::collections::BTreeMap<String, _> = list
            .queues
            .iter()
            .map(|queue| (queue.key.clone(), convert::counters(&queue.counters)))
            .collect();
        self.cursor = TasksCursor::at(list.revision);
        let delta = self
            .console
            .runtime
            .console_delta(&mut self.cursor, &self.scope);
        self.last = Some(Instant::now());
        if delta.overflow || queues.len() > OPEN_MAX {
            self.outbox.push_back(TopicEvent::Reset {
                reason: ResetReason::Lagged,
                missed: None,
            });
            return;
        }
        for queue in &delta.queues {
            queues.insert(queue.key.clone(), convert::counters(queue));
        }
        let frame = TasksCountersFrame {
            revision: delta.revision,
            queues: queues.into_values().collect(),
        };
        self.outbox.push_back(TopicEvent::json(
            "counters",
            Some(delta.revision.to_string()),
            &frame,
        ));
    }

    async fn next(&mut self) -> Option<TopicEvent> {
        loop {
            if std::mem::take(&mut self.opening) {
                self.open_frame();
            }
            if let Some(event) = self.outbox.pop_front() {
                return Some(event);
            }
            self.watch.changed().await.ok()?;
            let due = [
                self.last.map(|last| last + COUNTERS_EVERY),
                self.pause_until,
            ]
            .into_iter()
            .flatten()
            .max();
            if let Some(due) = due {
                tokio::time::sleep_until(due).await;
            }
            self.watch.mark_unchanged();
            let delta = self
                .console
                .runtime
                .console_delta(&mut self.cursor, &self.scope);
            let now = Instant::now();
            self.last = Some(now);
            self.pause_until = None;
            if delta.queues_changed {
                self.outbox.push_back(TopicEvent::json(
                    "queues",
                    None,
                    &TasksQueuesChanged {
                        revision: delta.revision,
                    },
                ));
            }
            if delta.overflow {
                self.pause_until = Some(now + RESET_PAUSE);
                self.outbox.push_back(TopicEvent::Reset {
                    reason: ResetReason::Lagged,
                    missed: None,
                });
                continue;
            }
            if delta.queues.is_empty() {
                continue;
            }
            self.outbox.push_back(TopicEvent::json(
                "counters",
                Some(delta.revision.to_string()),
                &TasksCountersFrame {
                    revision: delta.revision,
                    queues: delta.queues.iter().map(convert::counters).collect(),
                },
            ));
        }
    }
}

// ------------------------------------------------------------ tasks.queue

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct QueueParams {
    #[serde(default)]
    #[allow(dead_code, reason = "a queue key names its project already")]
    project: Option<String>,
    queue: String,
}

struct QueueTopic(Shared);

impl LiveTopic for QueueTopic {
    fn name(&self) -> &'static str {
        "tasks.queue"
    }

    fn open(
        &self,
        params: &serde_json::Value,
        after: Option<&str>,
    ) -> Result<TopicStream, ApiError> {
        let params: QueueParams = topic_params(params)?;
        let resumed = after.is_some();
        Ok(after_start(&self.0, move |console| {
            QueueWatcher::open(console, params.queue, resumed)
        }))
    }
}

struct QueueWatcher {
    console: TasksConsole,
    scope: TasksScope,
    cursor: TasksCursor,
    watch: watch::Receiver<u64>,
    keys: KeyWindow,
    finished: Option<TasksFinishedBatch>,
    due: Option<Instant>,
    outbox: VecDeque<TopicEvent>,
}

impl QueueWatcher {
    fn open(console: TasksConsole, queue: String, resumed: bool) -> TopicStream {
        let mut watch = console.runtime.watch();
        watch.mark_unchanged();
        let scope = TasksScope {
            project: None,
            counters: false,
            queue: Some(queue),
            max_changed: 0,
        };
        let mut cursor = TasksCursor::default();
        // The first delta only sets where the queue's changes stand.
        let _ = console.runtime.console_delta(&mut cursor, &scope);
        let mut outbox = VecDeque::new();
        if resumed {
            outbox.push_back(TopicEvent::Reset {
                reason: ResetReason::Gap,
                missed: None,
            });
        }
        let state = Self {
            console,
            scope,
            cursor,
            watch,
            keys: KeyWindow::default(),
            finished: None,
            due: None,
            outbox,
        };
        stream::unfold(state, |mut state| async move {
            state.next().await.map(|event| (event, state))
        })
        .boxed()
    }

    async fn next(&mut self) -> Option<TopicEvent> {
        loop {
            if let Some(event) = self.outbox.pop_front() {
                return Some(event);
            }
            let due = self.due;
            tokio::select! {
                changed = self.watch.changed() => {
                    changed.ok()?;
                    self.watch.mark_unchanged();
                    self.collect();
                }
                () = async {
                    match due {
                        Some(due) => tokio::time::sleep_until(due).await,
                        None => std::future::pending().await,
                    }
                } => self.flush(),
            }
        }
    }

    fn collect(&mut self) {
        let delta = self
            .console
            .runtime
            .console_delta(&mut self.cursor, &self.scope);
        if delta.changes_reset {
            self.keys.overflow();
        }
        for change in delta.changes {
            match change {
                TaskChange::Row(key) => {
                    self.keys.add(format!("row:{key}"));
                    self.keys.add(format!("task:{}", key.id));
                }
                TaskChange::Detail(id) => self.keys.add(format!("task:{id}")),
            }
        }
        if let Some(finished) = delta.finished {
            let mut ids: Vec<String> = finished.ids.iter().map(ToString::to_string).collect();
            let batch = match self.finished.take() {
                Some(previous) => {
                    ids.extend(previous.ids);
                    let overflow = previous.overflow || finished.overflow || ids.len() > MAX_IDS;
                    ids.truncate(MAX_IDS);
                    TasksFinishedBatch {
                        latest_id: finished.latest.to_string(),
                        added: previous
                            .added
                            .saturating_add(u32::try_from(finished.added).unwrap_or(u32::MAX)),
                        ids,
                        overflow,
                    }
                }
                None => TasksFinishedBatch {
                    latest_id: finished.latest.to_string(),
                    added: u32::try_from(finished.added).unwrap_or(u32::MAX),
                    ids,
                    overflow: finished.overflow,
                },
            };
            self.finished = Some(batch);
        }
        if self.finished.is_some() || !self.keys.is_empty() {
            self.due.get_or_insert_with(|| Instant::now() + KEY_WINDOW);
        }
    }

    fn flush(&mut self) {
        self.due = None;
        if let Some(finished) = self.finished.take() {
            self.outbox
                .push_back(TopicEvent::json("finished", None, &finished));
        }
        match self.keys.take() {
            Ok(keys) if keys.is_empty() => {}
            Ok(keys) => {
                self.outbox
                    .push_back(TopicEvent::json("stale", None, &TasksStale { keys }));
            }
            Err(()) => self.outbox.push_back(TopicEvent::Reset {
                reason: ResetReason::Lagged,
                missed: None,
            }),
        }
    }
}
