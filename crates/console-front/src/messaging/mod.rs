//! Pub/Sub and Cloud Tasks in the console (the messaging stream's module).
//! Owns `/api/v1/pubsub/...` and `/api/v1/tasks/...`, the `pubsub.*` and
//! `tasks.*` live topics, ⌘K's topics, messages, queues and tasks, the
//! sections' badges, summaries and clears.
//!
//! Both start after the console is serving (Cloud Tasks with Functions,
//! Pub/Sub after them), so each arrives through a [`Late`]. These are the
//! only `Late`s for the two runtimes: compute's section holds clones of
//! them, and reaches Pub/Sub and Tasks through [`PubsubConsole`] and
//! [`TasksConsole`]: publish, the scheduler, enqueue and the task id behind
//! a name.

mod pubsub;
mod shared;
mod tasks;

use std::sync::{Arc, OnceLock};
use std::time::Duration;

use axum::Router;
use firenook_functions_runtime::Monitor;
use firenook_pubsub_front::{
    OutgoingMessage, PublishOutcome, PubsubError, PubsubRuntime, ScheduleControl,
};
use firenook_tasks_front::{ConsoleTask, EnqueueError, EnqueuedTask, TasksRuntime};
use futures_util::StreamExt as _;
use futures_util::future::BoxFuture;
use futures_util::stream::BoxStream;
use tokio::sync::watch;
use tokio::time::Instant;

use crate::api_error::ApiError;
use crate::jobs::{JobHandle, JobRegistry, JobState};
use crate::late::{Late, late_native};
use crate::live::LiveTopic;
use crate::live::badges::{BadgeHandle, BadgeKind, BadgeNoun, BadgeTone};
use crate::search::SearchSource;
use crate::section::{
    ClearOptions, ClearReport, Section, SectionContext, SectionStatus, SectionSummary,
    SummaryFigure, SummaryUnit,
};
use crate::sse::Shutdown;

use shared::{count_text, counted};

/// Where Pub/Sub's HTTP/JSON application is mounted, as the browser sees it.
pub(crate) const PUBSUB_PREFIX: &str = "/console/api/v1/pubsub/native";
/// Where Cloud Tasks' HTTP application is mounted.
pub(crate) const TASKS_PREFIX: &str = "/console/api/v1/tasks/native";

/// What Pub/Sub says while Functions are discovered.
const PUBSUB_STARTING: &str = "Waiting for Functions discovery. Pub/Sub starts once the functions that listen on topics are known.";
/// What Cloud Tasks says while Functions are discovered.
const TASKS_STARTING: &str =
    "Waiting for Functions discovery. Queues register from onTaskDispatched exports.";
/// A section's status ticks at most this often while its counts change.
const STATUS_EVERY: Duration = Duration::from_millis(500);
/// A badge is re-read at most this often while its counts change.
const BADGE_EVERY: Duration = Duration::from_millis(250);

/// Pub/Sub's part of the console, handed over when the runtime exists.
/// Building it installs the push sink that feeds the console's push ring.
#[derive(Clone)]
pub struct PubsubConsole {
    /// Pub/Sub's HTTP/JSON application, mounted at `/pubsub/native`.
    pub native: Router,
    /// The broker, the scheduler state, the fanout and the console API of
    /// the runtime.
    pub runtime: PubsubRuntime,
    /// Compute's record of Functions invocations, when Functions runs: the
    /// source of function deliveries.
    pub monitor: Option<Monitor>,
    feed: pubsub::topics::PushFeed,
}

impl PubsubConsole {
    /// The console's part of a running Pub/Sub emulator. Installs the push
    /// sink: every push streak the runtime reports is kept in the console's
    /// ring (20,000 streaks, 16 MiB) for the Push tab.
    #[must_use]
    pub fn new(native: Router, runtime: PubsubRuntime, monitor: Option<Monitor>) -> Self {
        let feed = pubsub::topics::PushFeed::new();
        feed.install(&runtime);
        Self {
            native,
            runtime,
            monitor,
            feed,
        }
    }

    /// The one console publish path: the gRPC publish path in broker
    /// batches of 1,000. Compute's "Publish" calls this through the shared
    /// `Late`.
    pub fn publish_from_console(
        &self,
        topic: &str,
        messages: Vec<OutgoingMessage>,
    ) -> Result<PublishOutcome, PubsubError> {
        self.runtime.publish_from_console(topic, messages)
    }

    /// The scheduler as another section may use it, keyed by function id:
    /// compute's schedule card and Run now.
    #[must_use]
    pub fn schedules(&self) -> Arc<dyn ScheduleControl> {
        Arc::new(self.runtime.clone())
    }
}

/// Cloud Tasks' part of the console. Building it installs the attempt sink
/// that feeds the console's attempts ring.
#[derive(Clone)]
pub struct TasksConsole {
    /// The Tasks application, mounted at `/tasks/native`.
    pub native: Router,
    pub runtime: TasksRuntime,
    /// Matches attempts to the invocations they caused.
    pub monitor: Option<Monitor>,
    feed: tasks::topics::AttemptFeed,
}

impl TasksConsole {
    /// The console's part of a running Cloud Tasks emulator. Installs the
    /// attempt sink: every attempt is kept in the console's ring (10,000
    /// attempts, 8 MiB) for the Attempts view.
    #[must_use]
    pub fn new(native: Router, runtime: TasksRuntime, monitor: Option<Monitor>) -> Self {
        let feed = tasks::topics::AttemptFeed::new();
        feed.install(&runtime, monitor.clone());
        Self {
            native,
            runtime,
            monitor,
            feed,
        }
    }

    /// The one console enqueue path, held to the wire's 100 KiB; compute's
    /// "Enqueue" calls it.
    pub fn enqueue_console(
        &self,
        queue_key: &str,
        task: ConsoleTask,
    ) -> Result<EnqueuedTask, EnqueueError> {
        self.runtime.enqueue_console(queue_key, task)
    }

    /// A task name as Cloud Tasks sent it (short or full) to the console's
    /// decimal task id.
    #[must_use]
    pub fn task_id(&self, queue_key: &str, name: &str) -> Option<String> {
        self.runtime.task_id(queue_key, name)
    }
}

/// The Pub/Sub section.
pub(crate) struct PubsubSection {
    late: Late<PubsubConsole>,
    /// The console's jobs, kept when the router is built so a clear can
    /// cancel this section's running jobs first.
    jobs: OnceLock<JobRegistry>,
}

impl PubsubSection {
    pub(crate) fn new(late: Late<PubsubConsole>) -> Self {
        Self {
            late,
            jobs: OnceLock::new(),
        }
    }
}

/// The Cloud Tasks section.
pub(crate) struct TasksSection {
    late: Late<TasksConsole>,
    jobs: OnceLock<JobRegistry>,
}

impl TasksSection {
    pub(crate) fn new(late: Late<TasksConsole>) -> Self {
        Self {
            late,
            jobs: OnceLock::new(),
        }
    }
}

impl Section for PubsubSection {
    fn statuses(&self) -> Vec<SectionStatus> {
        vec![if self.late.is_ready() {
            SectionStatus::ready("pubsub")
        } else {
            SectionStatus::starting("pubsub", PUBSUB_STARTING)
        }]
    }

    fn status_changes(&self) -> Option<BoxStream<'static, ()>> {
        Some(status_ticks(&self.late, |console| {
            console.runtime.broker().console_watch()
        }))
    }

    fn router(&self, context: &SectionContext) -> Router {
        let _ = self.jobs.set(context.jobs.clone());
        spawn_pubsub_badges(self.late.clone(), context);
        let api = pubsub::PubsubApi {
            late: self.late.clone(),
            jobs: context.jobs.clone(),
            project: context.project.clone(),
            shutdown: context.shutdown.clone(),
        };
        pubsub::router(api).nest_service(
            "/pubsub/native",
            late_native(self.late.clone(), PUBSUB_PREFIX, |console| {
                console.native.clone()
            }),
        )
    }

    fn topics(&self, context: &SectionContext) -> Vec<Arc<dyn LiveTopic>> {
        pubsub::topics::topics(&self.late, context)
    }

    fn search(&self, _context: &SectionContext) -> Option<Arc<dyn SearchSource>> {
        Some(Arc::new(pubsub::search::PubsubSearch::new(
            self.late.clone(),
        )))
    }

    fn summary(&self, id: &str) -> Option<SectionSummary> {
        if id != "pubsub" {
            return None;
        }
        let console = self.late.get().ok()?;
        let totals = console.runtime.broker().totals();
        let topics = u64::from(totals.topics);
        let subscriptions = u64::from(totals.subscriptions);
        Some(SectionSummary {
            headline: format!(
                "{} · {} · largest backlog {}",
                counted(topics, "topic", "topics"),
                counted(subscriptions, "subscription", "subscriptions"),
                count_text(totals.largest_backlog)
            ),
            figures: vec![
                figure("Topics", topics),
                figure("Subscriptions", subscriptions),
                figure("Largest backlog", totals.largest_backlog),
            ],
        })
    }

    fn clear(
        &self,
        id: &str,
        job: JobHandle,
        _options: ClearOptions,
    ) -> Option<BoxFuture<'static, Result<ClearReport, ApiError>>> {
        if id != "pubsub" {
            return None;
        }
        let console = self.late.get().ok()?;
        let jobs = self.jobs.get().cloned();
        Some(Box::pin(async move {
            cancel_section_jobs(jobs.as_ref(), "pubsub");
            let count = console.runtime.reset();
            let broker = count.broker;
            let removed = u64::from(broker.topics)
                + u64::from(broker.subscriptions)
                + u64::from(broker.snapshots)
                + u64::from(broker.schemas)
                + broker.messages;
            job.progress(removed);
            Ok(ClearReport {
                section: "pubsub".to_owned(),
                removed,
            })
        }))
    }
}

impl Section for TasksSection {
    fn statuses(&self) -> Vec<SectionStatus> {
        vec![if self.late.is_ready() {
            SectionStatus::ready("tasks")
        } else {
            SectionStatus::starting("tasks", TASKS_STARTING)
        }]
    }

    fn status_changes(&self) -> Option<BoxStream<'static, ()>> {
        Some(status_ticks(&self.late, |console| console.runtime.watch()))
    }

    fn router(&self, context: &SectionContext) -> Router {
        let _ = self.jobs.set(context.jobs.clone());
        spawn_tasks_badge(self.late.clone(), context);
        let api = tasks::TasksApi {
            late: self.late.clone(),
            jobs: context.jobs.clone(),
            project: context.project.clone(),
        };
        tasks::router(api).nest_service(
            "/tasks/native",
            late_native(self.late.clone(), TASKS_PREFIX, |console| {
                console.native.clone()
            }),
        )
    }

    fn topics(&self, context: &SectionContext) -> Vec<Arc<dyn LiveTopic>> {
        tasks::topics::topics(&self.late, context)
    }

    fn search(&self, _context: &SectionContext) -> Option<Arc<dyn SearchSource>> {
        Some(Arc::new(tasks::search::TasksSearch::new(self.late.clone())))
    }

    fn summary(&self, id: &str) -> Option<SectionSummary> {
        if id != "tasks" {
            return None;
        }
        let console = self.late.get().ok()?;
        let totals = console.runtime.totals();
        let queues = u64::from(totals.queues);
        Some(SectionSummary {
            headline: format!(
                "{} · {} pending · {} failed in 5 min",
                counted(queues, "queue", "queues"),
                count_text(totals.pending),
                count_text(totals.failed_recently)
            ),
            figures: vec![
                figure("Queues", queues),
                figure("Pending", totals.pending),
                figure("Failed in 5 min", totals.failed_recently),
            ],
        })
    }

    fn clear(
        &self,
        id: &str,
        job: JobHandle,
        _options: ClearOptions,
    ) -> Option<BoxFuture<'static, Result<ClearReport, ApiError>>> {
        if id != "tasks" {
            return None;
        }
        let console = self.late.get().ok()?;
        let jobs = self.jobs.get().cloned();
        Some(Box::pin(async move {
            cancel_section_jobs(jobs.as_ref(), "tasks");
            let count = console.runtime.reset();
            let removed = count.tasks + count.history;
            job.progress(removed);
            Ok(ClearReport {
                section: "tasks".to_owned(),
                removed,
            })
        }))
    }
}

fn figure(label: &str, value: u64) -> SummaryFigure {
    SummaryFigure {
        label: label.to_owned(),
        value: Some(value),
        unit: SummaryUnit::Count,
    }
}

/// Asks every running job of `section` to stop (a clear goes first).
fn cancel_section_jobs(jobs: Option<&JobRegistry>, section: &str) {
    let Some(jobs) = jobs else {
        return;
    };
    for job in jobs.list(Some(section)) {
        if job.state == JobState::Running {
            let _ = jobs.cancel(&job.id);
        }
    }
}

/// Ticks when the late runtime is handed over, and then whenever its
/// console watch moves, at most every 500 ms.
fn status_ticks<T: Clone + Send + Sync + 'static>(
    late: &Late<T>,
    watch_of: fn(&T) -> watch::Receiver<u64>,
) -> BoxStream<'static, ()> {
    let mut changes = late.changes();
    let console = changes.borrow_and_update().as_ref().map(watch_of);
    futures_util::stream::unfold(
        (changes, console, None::<Instant>),
        move |(mut changes, mut console, last)| async move {
            loop {
                let Some(watch) = console.as_mut() else {
                    if changes.changed().await.is_err() {
                        return None;
                    }
                    console = changes.borrow_and_update().as_ref().map(watch_of);
                    return Some(((), (changes, console, Some(Instant::now()))));
                };
                tokio::select! {
                    moved = watch.changed() => {
                        if moved.is_err() {
                            console = None;
                            continue;
                        }
                    }
                    replaced = changes.changed() => {
                        if replaced.is_err() {
                            return None;
                        }
                        console = changes.borrow_and_update().as_ref().map(watch_of);
                    }
                }
                if let Some(last) = last {
                    tokio::time::sleep_until(last + STATUS_EVERY).await;
                }
                if let Some(watch) = console.as_mut() {
                    watch.mark_unchanged();
                }
                return Some(((), (changes, console, Some(Instant::now()))));
            }
        },
    )
    .boxed()
}

/// Keeps `pubsub.dead-lettered` and `pubsub.rejected` at the runtime's
/// running totals, from when the runtime arrives until the suite stops.
fn spawn_pubsub_badges(late: Late<PubsubConsole>, context: &SectionContext) {
    let dead = context.badges.handle(
        "pubsub.dead-lettered",
        BadgeKind::Counter,
        BadgeNoun::new("message dead-lettered", "messages dead-lettered"),
    );
    let rejected = context.badges.handle(
        "pubsub.rejected",
        BadgeKind::Counter,
        BadgeNoun::new("refused publish", "refused publishes"),
    );
    let shutdown = context.shutdown.clone();
    spawn_badge_loop(
        late,
        shutdown,
        |console| console.runtime.broker().console_watch(),
        move |console: &PubsubConsole| {
            publish_counter(
                &dead,
                console.runtime.broker().dead_lettered_total(),
                BadgeTone::Attention,
            );
            publish_counter(
                &rejected,
                console.runtime.refusals_total(),
                BadgeTone::Attention,
            );
        },
    );
}

/// Keeps `tasks.failed` at the runtime's running total.
fn spawn_tasks_badge(late: Late<TasksConsole>, context: &SectionContext) {
    let failed = context.badges.handle(
        "tasks.failed",
        BadgeKind::Counter,
        BadgeNoun::new("task ran out of retries", "tasks ran out of retries"),
    );
    spawn_badge_loop(
        late,
        context.shutdown.clone(),
        |console| console.runtime.watch(),
        move |console: &TasksConsole| {
            publish_counter(&failed, console.runtime.failed_total(), BadgeTone::Danger);
        },
    );
}

/// A counter's number, neutral at zero.
fn publish_counter(badge: &BadgeHandle, count: u64, tone: BadgeTone) {
    badge.set(count, if count == 0 { BadgeTone::Neutral } else { tone });
}

/// Waits for the late runtime, then re-reads the badges whenever its watch
/// moves (at most every 250 ms), until the suite stops.
fn spawn_badge_loop<T: Clone + Send + Sync + 'static>(
    late: Late<T>,
    shutdown: Shutdown,
    watch_of: fn(&T) -> watch::Receiver<u64>,
    publish: impl Fn(&T) + Send + 'static,
) {
    tokio::spawn(async move {
        let Some(mut console) = late.wait(shutdown.clone()).await else {
            return;
        };
        let mut changes = late.changes();
        let stopped = shutdown.stopped();
        tokio::pin!(stopped);
        loop {
            let mut watch = watch_of(&console);
            watch.mark_unchanged();
            publish(&console);
            let replaced = loop {
                tokio::select! {
                    biased;
                    () = &mut stopped => return,
                    moved = watch.changed() => {
                        if moved.is_err() {
                            break false;
                        }
                    }
                    replaced = changes.changed() => {
                        if replaced.is_err() {
                            return;
                        }
                        break true;
                    }
                }
                tokio::select! {
                    biased;
                    () = &mut stopped => return,
                    () = tokio::time::sleep(BADGE_EVERY) => {}
                }
                watch.mark_unchanged();
                publish(&console);
            };
            if replaced && let Some(next) = changes.borrow_and_update().clone() {
                console = next;
            } else if !replaced {
                return;
            }
        }
    });
}

/// The messaging stream's TypeScript bindings, into `generated/messaging/`.
#[cfg(test)]
pub(crate) fn export_bindings(config: &ts_rs::Config) {
    pubsub::export_bindings(config);
    tasks::export_bindings(config);
}

/// A Pub/Sub console over a fresh runtime with no functions, its native
/// application `native`, for the crate's tests (call inside a Tokio
/// runtime: the runtime starts its timer).
#[cfg(test)]
pub(crate) fn test_pubsub_console(native: Router) -> PubsubConsole {
    let background = firenook_functions_bridge::TriggerRegistry::default();
    let (observer, _deliveries) =
        firenook_functions_bridge::TriggerObserver::channel(background.clone());
    let runtime = firenook_pubsub_front::router(
        "demo-console",
        &firenook_functions_bridge::FunctionsInventory {
            generation: 0,
            backends: Vec::new(),
        },
        observer.queue(),
        background,
    );
    PubsubConsole::new(native, runtime, None)
}

/// A Cloud Tasks console over a fresh runtime with no queues, the same way.
#[cfg(test)]
pub(crate) fn test_tasks_console(native: Router) -> TasksConsole {
    let runtime = TasksRuntime::new(
        "demo-console",
        &firenook_functions_bridge::FunctionsInventory {
            generation: 0,
            backends: Vec::new(),
        },
        "http://127.0.0.1:5001",
        firenook_tasks_front::LogSink::new(|_| {}),
    );
    TasksConsole::new(native, runtime, None)
}

#[cfg(test)]
mod tests;
