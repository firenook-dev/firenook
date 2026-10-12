//! The Pub/Sub runtime: the broker plus function delivery (every discovered
//! function topic keeps the official `emulator-sub-<topic>` subscription and
//! publishes, dead-letter forwards included, reach the Functions host through
//! the delivery queue), the lease/push timer and the `onSchedule` scheduler.

use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime};

use firenook_functions_bridge::{
    DispatchQueue, DroppedService, FunctionsInventory, TriggerRegistry,
};
use time::OffsetDateTime;

use crate::broker::{Broker, FanoutSkip, FanoutTarget, Published, PushJob, ResetCount};
use crate::error::PubsubError;
use crate::functions::{
    FunctionTarget, ScheduleDefinition, Target, build_dispatch, build_dispatch_with, discover,
    event_id, topic_resource,
};
use crate::google::iam::v1::iam_policy_server::IamPolicyServer;
use crate::google::pubsub::v1::publisher_server::PublisherServer;
use crate::google::pubsub::v1::schema_service_server::SchemaServiceServer;
use crate::google::pubsub::v1::subscriber_server::SubscriberServer;
use crate::google::pubsub::v1::{PubsubMessage, Subscription};
use crate::schedule_control::{
    RunOutcome, RunScheduleError, RunTrigger, ScheduleRun, ScheduleView,
};
use crate::scheduler::{
    ScheduleBook, ScheduleChanges, ScheduleDetail, ScheduleError, SchedulerRuntime,
};

/// The lease and push timer resolution.
const TICK: Duration = Duration::from_millis(50);
/// How long a push response body is read for its snippet, at most.
const SNIPPET_WAIT: Duration = Duration::from_millis(500);
/// The bytes of a push response body kept for its snippet.
const SNIPPET_BYTES: usize = 1_024;
/// A growing push streak reaches the sink at most this often.
const STREAK_EMIT: Duration = Duration::from_secs(10);
/// A streak with no attempt for this long is forgotten.
const STREAK_IDLE: Duration = Duration::from_secs(60);
/// Refused requests kept.
const REJECTED_CAPACITY: usize = 200;
/// Messages the console publishes per broker batch.
const CONSOLE_BATCH: usize = 1_000;

struct Inner {
    project: String,
    broker: Broker,
    queue: DispatchQueue,
    background: TriggerRegistry,
    targets: Mutex<BTreeMap<String, Vec<Target>>>,
    /// Every schedule's state, keyed by function id.
    schedules: Mutex<ScheduleBook>,
    /// Bumped whenever a schedule's state changes.
    schedule_revision: tokio::sync::watch::Sender<u64>,
    http: reqwest::Client,
    ticker: Mutex<Option<tokio::task::JoinHandle<()>>>,
    /// Set by [`PubsubRuntime::shutdown`]: the timer never starts again.
    stopped: AtomicBool,
    managed: Mutex<ManagedSubscriptions>,
    push_sink: Mutex<Option<PushSink>>,
    log_sink: Mutex<Option<LogSink>>,
    streaks: Mutex<PushStreaks>,
    rejected: Mutex<RejectedRing>,
    /// Numbers console redeliveries, so each gets a fresh event id.
    redeliveries: AtomicU64,
}

/// One streak of push attempts: consecutive attempts of one message with
/// the same outcome (status or error). The push sink receives it when it
/// starts, then at most every 10 s while it grows, and once more with its
/// final count when another outcome ends it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PushStreakRecord {
    /// Stable for the streak; a new outcome starts a new one.
    pub streak: String,
    pub subscription: String,
    pub message_id: u64,
    pub first_attempt: u32,
    pub last_attempt: u32,
    pub count: u32,
    pub first_at: SystemTime,
    pub last_at: SystemTime,
    /// The endpoint's HTTP status, when it answered.
    pub status: Option<u16>,
    /// Why no answer came (refused, timed out), when none did.
    pub error: Option<String>,
    /// How long the latest attempt took.
    pub latency: Duration,
    /// The first 1 KiB of the latest response body.
    pub response: Option<String>,
}

/// Receives push streaks inline, from the push loop; it must not block.
pub type PushSink = Arc<dyn Fn(PushStreakRecord) + Send + Sync>;

/// A line the runtime logs, with the resources it is about, so a log view
/// can link back to them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PubsubLogLine {
    /// `INFO`, `WARN` or `ERROR`.
    pub level: &'static str,
    /// `pubsub.schedule` or `pubsub.push`.
    pub kind: &'static str,
    /// The line without a label.
    pub text: String,
    /// The topic's full name.
    pub topic: Option<String>,
    /// The subscription's full name.
    pub subscription: Option<String>,
    /// The scheduled function's id, on a schedule's line.
    pub function_id: Option<String>,
}

/// The kind of a schedule's line.
pub const LOG_SCHEDULE: &str = "pubsub.schedule";
/// The kind of a push subscription's line.
pub const LOG_PUSH: &str = "pubsub.push";

/// Receives the runtime's log lines inline; it must not block.
pub type LogSink = Arc<dyn Fn(PubsubLogLine) + Send + Sync>;

/// What [`PubsubRuntime::reset`] removed.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PubsubResetCount {
    /// Topics, subscriptions, snapshots and schemas, and the messages the
    /// broker held. The functions' own topics and subscriptions come back at
    /// once, empty.
    pub broker: ResetCount,
    /// Refused requests forgotten.
    pub rejections: u32,
    /// Schedule runs forgotten (pause flags stay).
    pub schedule_runs: u64,
}

/// What one push attempt got. Success is any 2xx, as the push loop decides.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PushOutcome {
    pub(crate) status: Option<u16>,
    pub(crate) error: Option<String>,
    pub(crate) latency: Duration,
}

impl PushOutcome {
    fn delivered(&self) -> bool {
        self.status
            .is_some_and(|status| (200..300).contains(&status))
    }
}

#[derive(Debug)]
struct Streak {
    record: PushStreakRecord,
    emitted_at: Instant,
    emitted_count: u32,
    seen_at: Instant,
}

/// The current streak of each message being pushed.
#[derive(Debug, Default)]
pub(crate) struct PushStreaks {
    current: HashMap<(String, u64), Streak>,
    next: u64,
}

impl PushStreaks {
    /// Records one attempt and returns what the sink receives for it.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn record(
        &mut self,
        subscription: &str,
        message_id: u64,
        attempt: u32,
        outcome: &PushOutcome,
        response: Option<String>,
        now: Instant,
        at: SystemTime,
    ) -> Vec<PushStreakRecord> {
        let key = (subscription.to_owned(), message_id);
        let mut records = Vec::new();
        let same = self.current.get(&key).is_some_and(|streak| {
            streak.record.status == outcome.status && streak.record.error == outcome.error
        });
        if same {
            if let Some(streak) = self.current.get_mut(&key) {
                let record = &mut streak.record;
                record.last_attempt = attempt;
                record.count += 1;
                record.last_at = at;
                record.latency = outcome.latency;
                record.response = response;
                streak.seen_at = now;
                if now.saturating_duration_since(streak.emitted_at) >= STREAK_EMIT {
                    streak.emitted_at = now;
                    streak.emitted_count = record.count;
                    records.push(record.clone());
                }
            }
        } else {
            if let Some(ended) = self.current.remove(&key)
                && ended.record.count > ended.emitted_count
            {
                records.push(ended.record);
            }
            self.next += 1;
            let record = PushStreakRecord {
                streak: self.next.to_string(),
                subscription: subscription.to_owned(),
                message_id,
                first_attempt: attempt,
                last_attempt: attempt,
                count: 1,
                first_at: at,
                last_at: at,
                status: outcome.status,
                error: outcome.error.clone(),
                latency: outcome.latency,
                response,
            };
            records.push(record.clone());
            self.current.insert(
                key.clone(),
                Streak {
                    record,
                    emitted_at: now,
                    emitted_count: 1,
                    seen_at: now,
                },
            );
        }
        // A delivered push ends the message's pushes.
        if outcome.delivered() {
            self.current.remove(&key);
        }
        records
    }

    /// The current streak of a message, if it has one.
    #[cfg(test)]
    pub(crate) fn current(&self, subscription: &str, message_id: u64) -> Option<PushStreakRecord> {
        self.current
            .get(&(subscription.to_owned(), message_id))
            .map(|streak| streak.record.clone())
    }

    /// Forgets streaks whose message is no longer being pushed.
    fn prune(&mut self, now: Instant) {
        self.current
            .retain(|_, streak| now.saturating_duration_since(streak.seen_at) < STREAK_IDLE);
    }
}

/// A request the wire refused, coalesced by operation, resource and error.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rejection {
    pub first_at: SystemTime,
    pub last_at: SystemTime,
    pub count: u32,
    /// `publish`, `pull`, `streaming-pull` or `create-subscription`.
    pub operation: &'static str,
    /// The full name the app used.
    pub resource: String,
    /// The engine's answer, verbatim.
    pub error: String,
    /// Its code name (`NOT_FOUND`).
    pub code: &'static str,
    /// The nearest existing id in the same project, when one is close.
    pub suggestion: Option<String>,
    /// A project where this id exists, when the app used another.
    pub elsewhere: Option<String>,
}

/// Every refusal kept, oldest first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RejectedList {
    pub entries: Vec<Rejection>,
    /// Refusals evicted from the ring since start.
    pub dropped: u64,
    /// Bumped by every new or repeated refusal.
    pub revision: u64,
}

#[derive(Debug, Default)]
struct RejectedRing {
    entries: VecDeque<Rejection>,
    dropped: u64,
    revision: u64,
    /// Refusals since start, repeats included; a clear keeps the count.
    total: u64,
}

/// A message as the console publishes it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct OutgoingMessage {
    pub data: Vec<u8>,
    pub attributes: BTreeMap<String, String>,
    pub ordering_key: String,
}

/// What a console publish did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PublishOutcome {
    pub ids: Vec<String>,
    /// Subscriptions of the topic (the functions consumer's left out).
    pub subscriptions: u32,
    /// Functions listening on the topic.
    pub functions: u32,
    /// Function targets skipped because background triggers are paused
    /// (the events were dropped, not queued).
    pub functions_skipped: u32,
}

/// What a publish handed to the topic's functions.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct FanoutSummary {
    pub functions: u32,
    pub skipped: u32,
}

/// Why a console redelivery or dispatch preview could not be made.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RedeliverError {
    /// The topic's history ring no longer keeps the message.
    MessageNotKept,
    /// The function does not listen on the topic.
    NotATarget,
    /// Background triggers are paused, so nothing is dispatched.
    BackgroundPaused,
    /// The Functions delivery queue has stopped.
    Stopped,
}

impl std::fmt::Display for RedeliverError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::MessageNotKept => "The engine no longer keeps this message.",
            Self::NotATarget => "That function does not listen on this topic.",
            Self::BackgroundPaused => {
                "Background triggers are paused, so the message was not dispatched."
            }
            Self::Stopped => "The Functions delivery queue has stopped.",
        })
    }
}

impl std::error::Error for RedeliverError {}

/// The request a function receives for a message, rebuilt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DispatchPreview {
    pub content_type: String,
    pub body: Vec<u8>,
}

/// The functions consumer's `emulator-sub-<topic>` subscriptions: the ones
/// whose topic has function targets now, and every one ever installed.
#[derive(Default)]
struct ManagedSubscriptions {
    current: BTreeSet<String>,
    installed: BTreeSet<String>,
}

/// Whether a subscription belongs to the functions consumer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Managed {
    /// An ordinary subscription.
    No,
    /// `emulator-sub-<topic>` while its topic has function targets: drained
    /// at every publish, as the functions consumer takes everything.
    Functions,
    /// `emulator-sub-<topic>` whose topic lost its function targets: nothing
    /// drains it any more, so it keeps every later message, as the official
    /// emulator's does once its consumer stops.
    Orphaned,
}

/// Shared Pub/Sub state; cheap to clone.
#[derive(Clone)]
pub struct PubsubRuntime {
    inner: Arc<Inner>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl PubsubRuntime {
    /// Builds the runtime for `project` with the function targets of
    /// `inventory`; call from inside a Tokio runtime so the timer starts.
    #[must_use]
    pub fn new(
        project: &str,
        inventory: &FunctionsInventory,
        queue: DispatchQueue,
        background: TriggerRegistry,
    ) -> Self {
        let (targets, schedules) = discover(project, inventory);
        let mut book = ScheduleBook::default();
        let problems = book.reconcile(schedules);
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(30))
            .build()
            .unwrap_or_default();
        let runtime = Self {
            inner: Arc::new(Inner {
                project: project.to_owned(),
                broker: Broker::new(),
                queue,
                background,
                targets: Mutex::new(BTreeMap::new()),
                schedules: Mutex::new(book),
                schedule_revision: tokio::sync::watch::channel(0).0,
                http,
                ticker: Mutex::new(None),
                stopped: AtomicBool::new(false),
                managed: Mutex::new(ManagedSubscriptions::default()),
                push_sink: Mutex::new(None),
                log_sink: Mutex::new(None),
                streaks: Mutex::new(PushStreaks::default()),
                rejected: Mutex::new(RejectedRing::default()),
                redeliveries: AtomicU64::new(0),
            }),
        };
        runtime.install_targets(targets);
        runtime.report_schedule_problems(problems);
        runtime.start_ticker();
        runtime
    }

    /// The broker behind the transports.
    #[must_use]
    pub fn broker(&self) -> &Broker {
        &self.inner.broker
    }

    /// The project requests without a project address.
    #[must_use]
    pub fn project(&self) -> &str {
        &self.inner.project
    }

    /// Discovered schedule inventory.
    #[must_use]
    pub fn schedules(&self) -> Vec<ScheduleDefinition> {
        lock(&self.inner.schedules)
            .entries
            .values()
            .map(|entry| entry.definition.clone())
            .collect()
    }

    /// The HTTP/JSON application for the Pub/Sub port.
    pub fn application(&self) -> axum::Router {
        crate::http::router(self.clone())
    }

    /// The gRPC services mounted beside the HTTP/JSON application on one port.
    #[must_use]
    pub fn routes(&self) -> tonic::service::Routes {
        // The official emulator accepts messages well past gRPC's 4 MB default.
        const MAX_MESSAGE: usize = 64 * 1024 * 1024;
        tonic::service::Routes::from(self.application())
            .add_service(
                PublisherServer::new(self.clone())
                    .max_decoding_message_size(MAX_MESSAGE)
                    .max_encoding_message_size(MAX_MESSAGE),
            )
            .add_service(
                SubscriberServer::new(self.clone())
                    .max_decoding_message_size(MAX_MESSAGE)
                    .max_encoding_message_size(MAX_MESSAGE),
            )
            .add_service(SchemaServiceServer::new(self.clone()))
            .add_service(IamPolicyServer::new(self.clone()))
    }

    /// Starts wall-clock schedule delivery. Manual topic publishing remains
    /// available to deterministic test harnesses.
    pub fn start_scheduler(&self) -> Result<SchedulerRuntime, ScheduleError> {
        self.start_ticker();
        let automatic = lock(&self.inner.schedules).automatic();
        Ok(SchedulerRuntime::start(self, automatic))
    }

    /// Reconciles function targets after completed source registration.
    /// Explicit topics, subscriptions, message ids and queued deliveries
    /// survive; so does every schedule's state, and an unchanged schedule
    /// keeps its next tick.
    pub async fn refresh_inventory(
        &mut self,
        project: &str,
        inventory: &FunctionsInventory,
        scheduler: &mut SchedulerRuntime,
    ) -> Result<(), ScheduleError> {
        let (targets, discovered) = discover(project, inventory);
        scheduler.stop().await;
        self.install_targets(targets);
        let problems = lock(&self.inner.schedules).reconcile(discovered);
        self.schedules_changed();
        self.report_schedule_problems(problems);
        *scheduler = self.start_scheduler()?;
        Ok(())
    }

    /// Says why schedules cannot run on a clock, once per new problem.
    fn report_schedule_problems(&self, problems: Vec<(String, String)>) {
        for (function_id, problem) in problems {
            self.log(self.schedule_problem_line(function_id, &problem));
        }
    }

    fn schedule_problem_line(&self, function_id: String, problem: &str) -> PubsubLogLine {
        let topic = lock(&self.inner.schedules)
            .entries
            .get(&function_id)
            .map(|entry| topic_resource(&entry.definition.project, &entry.definition.topic));
        // The official emulator never runs schedules on a clock; an
        // expression Firenook cannot evaluate keeps Run now and the manual
        // trigger route and loses only the automatic ticks.
        PubsubLogLine {
            level: "WARN",
            kind: LOG_SCHEDULE,
            text: format!(
                "schedule of {function_id} not run automatically ({problem}); run it from the console or through the Functions trigger route"
            ),
            topic,
            subscription: None,
            function_id: Some(function_id),
        }
    }

    /// Hands every log line to `sink` from now on (the console's logs),
    /// starting with the schedules that cannot run on a clock, which were
    /// found before any sink could be set. Called inline, never awaited.
    pub fn set_log_sink(&self, sink: LogSink) {
        let problems = lock(&self.inner.schedules).problems();
        for (function_id, problem) in problems {
            sink(self.schedule_problem_line(function_id, &problem));
        }
        *lock(&self.inner.log_sink) = Some(sink);
    }

    /// Logs a line: to the sink when one is set; without one, a schedule's
    /// line goes to stderr (as it always did) and a push line nowhere.
    fn log(&self, line: PubsubLogLine) {
        let sink = lock(&self.inner.log_sink).clone();
        match sink {
            Some(sink) => sink(line),
            None if line.kind == LOG_SCHEDULE => eprintln!("firenook pubsub: {}", line.text),
            None => {}
        }
    }

    fn logging(&self) -> bool {
        lock(&self.inner.log_sink).is_some()
    }

    /// Removes every topic, subscription, snapshot and schema, the history
    /// rings, the refused requests, the push streaks and every schedule's
    /// runs (the console's clear; pause flags and the clocks' next ticks
    /// stay), then re-creates the functions' topics and their
    /// `emulator-sub-*` subscriptions at once. Message ids keep counting.
    #[must_use = "the count is what the clear reports"]
    pub fn reset(&self) -> PubsubResetCount {
        let broker = self.inner.broker.reset();
        let rejections = {
            let mut ring = lock(&self.inner.rejected);
            let removed = u32::try_from(ring.entries.len()).unwrap_or(u32::MAX);
            ring.entries.clear();
            ring.dropped = 0;
            ring.revision += 1;
            removed
        };
        lock(&self.inner.streaks).current.clear();
        let schedule_runs = {
            let mut book = lock(&self.inner.schedules);
            let runs = book.entries.values().map(|entry| entry.runs).sum();
            book.forget_runs();
            runs
        };
        self.schedules_changed();
        let targets = lock(&self.inner.targets).clone();
        self.install_targets(targets);
        {
            // The orphaned subscriptions are gone with the rest.
            let mut guard = lock(&self.inner.managed);
            let managed = &mut *guard;
            managed.installed.clone_from(&managed.current);
        }
        self.inner.broker.console_changed();
        PubsubResetCount {
            broker,
            rejections,
            schedule_runs,
        }
    }

    /// Whether `subscription` belongs to the functions consumer: it does
    /// while its topic has function targets, not because of its name.
    #[must_use]
    pub fn managed(&self, subscription: &str) -> Managed {
        let managed = lock(&self.inner.managed);
        if managed.current.contains(subscription) {
            Managed::Functions
        } else if managed.installed.contains(subscription) {
            Managed::Orphaned
        } else {
            Managed::No
        }
    }

    fn install_targets(&self, targets: BTreeMap<String, Vec<Target>>) {
        let mut current = BTreeSet::new();
        for topic in targets.keys() {
            self.inner.broker.ensure_topic(topic);
            if let Some((project, short)) = crate::functions::parse_topic_resource(topic) {
                let name = format!("projects/{project}/subscriptions/emulator-sub-{short}");
                let _ = self.inner.broker.create_subscription(Subscription {
                    name: name.clone(),
                    topic: topic.clone(),
                    ..Subscription::default()
                });
                current.insert(name);
            }
        }
        *lock(&self.inner.targets) = targets;
        // A subscription whose topic lost its targets stays where it is
        // (deleting it would be visible on the wire); it is orphaned.
        let mut managed = lock(&self.inner.managed);
        managed.installed.extend(current.iter().cloned());
        managed.current = current;
    }

    fn start_ticker(&self) {
        if self.inner.stopped.load(Ordering::Acquire) {
            return;
        }
        let mut slot = lock(&self.inner.ticker);
        if slot.as_ref().is_some_and(|task| !task.is_finished()) {
            return;
        }
        let Ok(handle) = tokio::runtime::Handle::try_current() else {
            return;
        };
        self.inner.broker.set_outbox_open(true);
        let runtime = self.clone();
        *slot = Some(handle.spawn(async move {
            // The push requests belong to the timer: stopping it aborts them.
            let mut pushes = tokio::task::JoinSet::new();
            let mut pruned = Instant::now();
            loop {
                tokio::time::sleep(TICK).await;
                while pushes.try_join_next().is_some() {}
                if pruned.elapsed() >= Duration::from_secs(1) {
                    pruned = Instant::now();
                    lock(&runtime.inner.streaks).prune(pruned);
                }
                for job in runtime.inner.broker.tick() {
                    let runtime = runtime.clone();
                    pushes.spawn(async move { runtime.push(job).await });
                }
                runtime.deliver_dead_letters();
            }
        }));
    }

    /// Hands the dead-letter forwards since the last tick to the functions
    /// listening on their dead-letter topics.
    fn deliver_dead_letters(&self) {
        for published in self.inner.broker.take_outbox() {
            self.deliver_to_functions(&published);
        }
    }

    /// Stops the lease and push timer for good (the push requests it started
    /// with it), after handing pending dead-letter forwards to functions.
    /// The broker keeps answering; leases no longer expire and pushes stop.
    pub async fn shutdown(&self) {
        self.inner.stopped.store(true, Ordering::Release);
        let task = lock(&self.inner.ticker).take();
        if let Some(task) = task {
            task.abort();
            let _ = task.await;
        }
        self.deliver_dead_letters();
        self.inner.broker.set_outbox_open(false);
    }

    /// Whether the lease and push timer is running.
    #[cfg(test)]
    pub(crate) fn ticker_running(&self) -> bool {
        lock(&self.inner.ticker)
            .as_ref()
            .is_some_and(|task| !task.is_finished())
    }

    async fn push(&self, job: PushJob) {
        let mut request = self
            .inner
            .http
            .post(&job.endpoint)
            .header("content-type", "application/json");
        for (name, value) in &job.headers {
            request = request.header(name, value);
        }
        let started = Instant::now();
        let at = SystemTime::now();
        let (outcome, response) = match request.body(job.body.clone()).send().await {
            Ok(response) => (
                PushOutcome {
                    status: Some(response.status().as_u16()),
                    error: None,
                    latency: started.elapsed(),
                },
                Some(response),
            ),
            Err(error) => (
                PushOutcome {
                    status: None,
                    error: Some(describe_push_error(&error)),
                    latency: started.elapsed(),
                },
                None,
            ),
        };
        // The outcome decides at once; the snippet is read afterwards, so
        // acknowledgement and retry timing are what they always were.
        self.inner.broker.push_finished(&job, outcome.delivered());
        let sink = lock(&self.inner.push_sink).clone();
        if sink.is_none() && !self.logging() {
            return;
        }
        let snippet = match response {
            Some(response) => read_snippet(response).await,
            None => None,
        };
        let records = lock(&self.inner.streaks).record(
            &job.subscription,
            job.message_id,
            job.attempt,
            &outcome,
            snippet,
            Instant::now(),
            at,
        );
        // A failure that starts a streak is logged once; the streak grows
        // silently while the emulator keeps retrying.
        if !outcome.delivered() && records.iter().any(|record| record.count == 1) {
            self.log(push_failure_line(&job, &outcome));
        }
        if let Some(sink) = sink
            && !records.is_empty()
        {
            for record in records {
                sink(record);
            }
            self.inner.broker.console_changed();
        }
    }

    /// Hands every push streak to `sink` from now on (the console's ring);
    /// called inline by the push loop, never awaited. Without a sink no
    /// streak is kept.
    pub fn set_push_sink(&self, sink: PushSink) {
        *lock(&self.inner.push_sink) = Some(sink);
    }

    /// Hands a publish to the functions listening on its topic; the official
    /// `emulator-sub-<topic>` subscription is drained as their consumer
    /// would. The fanout (each target's event id, or that background
    /// triggers were paused) is recorded on the messages' history entries.
    pub fn deliver_to_functions(&self, published: &Published) {
        self.fan_out(published);
    }

    /// [`PubsubRuntime::deliver_to_functions`], saying what it handed over.
    fn fan_out(&self, published: &Published) -> FanoutSummary {
        let targets = lock(&self.inner.targets)
            .get(&published.topic)
            .cloned()
            .unwrap_or_default();
        if targets.is_empty() {
            return FanoutSummary::default();
        }
        if let Some((project, short)) = crate::functions::parse_topic_resource(&published.topic) {
            self.inner.broker.drain(&format!(
                "projects/{project}/subscriptions/emulator-sub-{short}"
            ));
        }
        let functions = u32::try_from(targets.len()).unwrap_or(u32::MAX);
        let mut fanouts = Vec::with_capacity(published.messages.len());
        let skipped = if self.inner.background.background_enabled() {
            for message in &published.messages {
                let mut fanout = Vec::with_capacity(targets.len());
                for target in &targets {
                    let dispatch = build_dispatch(&published.topic, target, message);
                    fanout.push(FanoutTarget {
                        function_id: target.function().id.clone(),
                        event_id: dispatch.event_id.clone(),
                        redelivery: false,
                    });
                    let _ = self.inner.queue.enqueue(dispatch);
                }
                fanouts.push((message.id, fanout));
            }
            None
        } else {
            // Background triggers are paused: the events are dropped, not
            // queued; the fanout says so, and the suite counts them.
            self.inner.background.note_dropped_many(
                DroppedService::Pubsub,
                u64::try_from(published.messages.len()).unwrap_or(u64::MAX),
            );
            for message in &published.messages {
                let fanout = targets
                    .iter()
                    .map(|target| FanoutTarget {
                        function_id: target.function().id.clone(),
                        event_id: event_id(
                            &published.topic,
                            target,
                            &message.message.message_id,
                            0,
                        ),
                        redelivery: false,
                    })
                    .collect();
                fanouts.push((message.id, fanout));
            }
            Some(FanoutSkip::BackgroundOff)
        };
        self.inner
            .broker
            .record_fanout(&published.topic, SystemTime::now(), skipped, fanouts);
        FanoutSummary {
            functions,
            skipped: if skipped.is_some() { functions } else { 0 },
        }
    }

    /// The console's one publish path: the gRPC publish path, in broker
    /// batches of 1,000, each handed to the topic's functions. A refusal is
    /// the broker's own answer and is not recorded as an app's refusal.
    pub fn publish_from_console(
        &self,
        topic: &str,
        messages: Vec<OutgoingMessage>,
    ) -> Result<PublishOutcome, PubsubError> {
        let mut outcome = PublishOutcome::default();
        let mut pending = messages.into_iter().peekable();
        if pending.peek().is_none() {
            return Err(PubsubError::invalid_argument("No messages to publish"));
        }
        while pending.peek().is_some() {
            let batch: Vec<crate::google::pubsub::v1::PubsubMessage> = pending
                .by_ref()
                .take(CONSOLE_BATCH)
                .map(|message| crate::google::pubsub::v1::PubsubMessage {
                    data: message.data,
                    attributes: message.attributes,
                    ordering_key: message.ordering_key,
                    ..crate::google::pubsub::v1::PubsubMessage::default()
                })
                .collect();
            let (ids, published) = self.inner.broker.publish(topic, batch)?;
            let fanout = self.fan_out(&published);
            outcome.ids.extend(ids);
            outcome.functions = fanout.functions;
            outcome.functions_skipped = fanout.skipped;
        }
        outcome.subscriptions = u32::try_from(
            self.inner
                .broker
                .topic_subscriptions(topic)
                .iter()
                .filter(|name| self.managed(name) != Managed::Functions)
                .count(),
        )
        .unwrap_or(u32::MAX);
        Ok(outcome)
    }

    /// Function deliveries waiting for a dispatch slot: what "queued · 214
    /// waiting for a slot" counts. Nothing here watches the background
    /// switch; a publish reads the flag as it fans out.
    #[must_use]
    pub fn delivery_queue_depth(&self) -> usize {
        self.inner.queue.depth()
    }

    /// The functions listening on `topic` (the targets
    /// [`PubsubRuntime::deliver_to_functions`] uses).
    #[must_use]
    pub fn function_targets(&self, topic: &str) -> Vec<FunctionTarget> {
        lock(&self.inner.targets)
            .get(topic)
            .map(|targets| targets.iter().map(Target::describe).collect())
            .unwrap_or_default()
    }

    /// Every topic with function targets, and its targets.
    #[must_use]
    pub fn all_function_targets(&self) -> BTreeMap<String, Vec<FunctionTarget>> {
        lock(&self.inner.targets)
            .iter()
            .map(|(topic, targets)| {
                (
                    topic.clone(),
                    targets.iter().map(Target::describe).collect(),
                )
            })
            .collect()
    }

    fn target(&self, topic: &str, function_id: &str) -> Option<Target> {
        lock(&self.inner.targets)
            .get(topic)?
            .iter()
            .find(|target| target.function().id == function_id)
            .cloned()
    }

    /// Dispatches message `message_id` of `topic` to one function again, with
    /// a fresh event id (the delivery runtime suppresses a repeated one),
    /// without publishing it to every subscription and function; the
    /// redelivery is appended to the message's fanout. Returns its event id.
    pub fn redeliver(
        &self,
        topic: &str,
        message_id: u64,
        function_id: &str,
    ) -> Result<String, RedeliverError> {
        let message = self
            .inner
            .broker
            .history_message(topic, message_id)
            .ok_or(RedeliverError::MessageNotKept)?;
        let target = self
            .target(topic, function_id)
            .ok_or(RedeliverError::NotATarget)?;
        if !self.inner.background.background_enabled() {
            return Err(RedeliverError::BackgroundPaused);
        }
        let redelivery = self.inner.redeliveries.fetch_add(1, Ordering::Relaxed) + 1;
        let dispatch = build_dispatch_with(topic, &target, &message, redelivery);
        let event = dispatch.event_id.clone();
        self.inner
            .queue
            .enqueue(dispatch)
            .map_err(|_| RedeliverError::Stopped)?;
        self.inner.broker.add_fanout_target(
            topic,
            message_id,
            FanoutTarget {
                function_id: function_id.to_owned(),
                event_id: event.clone(),
                redelivery: true,
            },
        );
        Ok(event)
    }

    /// The request `function_id` receives for message `message_id` of
    /// `topic`, rebuilt now (its time is the current time).
    pub fn dispatch_preview(
        &self,
        topic: &str,
        message_id: u64,
        function_id: &str,
    ) -> Result<DispatchPreview, RedeliverError> {
        let message = self
            .inner
            .broker
            .history_message(topic, message_id)
            .ok_or(RedeliverError::MessageNotKept)?;
        let target = self
            .target(topic, function_id)
            .ok_or(RedeliverError::NotATarget)?;
        let dispatch = build_dispatch(topic, &target, &message);
        Ok(DispatchPreview {
            content_type: dispatch
                .headers
                .get("content-type")
                .cloned()
                .unwrap_or_default(),
            body: dispatch.body,
        })
    }

    /// Records a wire request's refusal (a missing resource, a schema's
    /// refusal) and hands the result back unchanged.
    pub(crate) fn refusal<T>(
        &self,
        operation: &'static str,
        resource: &str,
        result: Result<T, PubsubError>,
    ) -> Result<T, PubsubError> {
        if let Err(error) = &result
            && (error.code == tonic::Code::NotFound || error.message == "Could not parse message")
        {
            self.record_refusal(operation, resource, error);
        }
        result
    }

    fn record_refusal(&self, operation: &'static str, resource: &str, error: &PubsubError) {
        let now = SystemTime::now();
        {
            let mut ring = lock(&self.inner.rejected);
            ring.revision += 1;
            ring.total += 1;
            let existing = ring.entries.iter().position(|entry| {
                entry.operation == operation
                    && entry.resource == resource
                    && entry.error == error.message
            });
            let entry = match existing.and_then(|position| ring.entries.remove(position)) {
                Some(mut entry) => {
                    entry.count = entry.count.saturating_add(1);
                    entry.last_at = now;
                    entry
                }
                None => Rejection {
                    first_at: now,
                    last_at: now,
                    count: 1,
                    operation,
                    resource: resource.to_owned(),
                    error: error.message.clone(),
                    code: error.status_name(),
                    suggestion: None,
                    elsewhere: None,
                },
            };
            ring.entries.push_back(entry);
            if ring.entries.len() > REJECTED_CAPACITY {
                ring.entries.pop_front();
                ring.dropped += 1;
            }
        }
        self.inner.broker.console_changed();
    }

    /// Wire requests refused since start, repeats included (a clear keeps
    /// the count): the console's counter badge. O(1).
    #[must_use]
    pub fn refusals_total(&self) -> u64 {
        lock(&self.inner.rejected).total
    }

    /// The refusals' revision, bumped by every new or repeated refusal and
    /// by a clear (what a console view compares). O(1).
    #[must_use]
    pub fn rejected_revision(&self) -> u64 {
        lock(&self.inner.rejected).revision
    }

    /// The refused wire requests kept, oldest first, each with the nearest
    /// existing id in its project and a project where its id exists.
    #[must_use]
    pub fn rejected(&self) -> RejectedList {
        let (mut entries, dropped, revision) = {
            let ring = lock(&self.inner.rejected);
            (
                ring.entries.iter().cloned().collect::<Vec<_>>(),
                ring.dropped,
                ring.revision,
            )
        };
        let topics = self.inner.broker.resource_ids("topics");
        let subscriptions = self.inner.broker.resource_ids("subscriptions");
        for entry in &mut entries {
            let (collection, existing) = if entry.resource.contains("/subscriptions/") {
                ("subscriptions", &subscriptions)
            } else {
                ("topics", &topics)
            };
            let Ok(parsed) = crate::names::parse(collection, &entry.resource) else {
                continue;
            };
            entry.suggestion = nearest_id(&parsed.project, &parsed.id, existing);
            entry.elsewhere = existing
                .iter()
                .find(|(project, id)| *id == parsed.id && *project != parsed.project)
                .map(|(project, _)| project.clone());
        }
        RejectedList {
            entries,
            dropped,
            revision,
        }
    }

    // ---------------------------------------------------------- schedules

    /// Announces the book's revision on the schedule watch when it moved.
    fn schedules_changed(&self) {
        let revision = lock(&self.inner.schedules).revision;
        self.inner.schedule_revision.send_if_modified(|announced| {
            let moved = *announced != revision;
            *announced = revision;
            moved
        });
    }

    /// Publishes one tick to the schedule's topic, as the clock does, and
    /// hands it to the topic's functions.
    fn publish_tick(&self, schedule: &ScheduleDefinition) -> Result<String, PubsubError> {
        let topic = topic_resource(&schedule.project, &schedule.topic);
        let (ids, published) = self.inner.broker.publish(
            &topic,
            vec![PubsubMessage {
                data: b"{}".to_vec(),
                ..PubsubMessage::default()
            }],
        )?;
        self.deliver_to_functions(&published);
        Ok(ids.into_iter().next().unwrap_or_default())
    }

    /// The next tick of an automatic schedule (written for the views before
    /// the clock sleeps); `None` once it left the inventory.
    pub(crate) fn schedule_due(&self, function_id: &str) -> Option<OffsetDateTime> {
        let due = lock(&self.inner.schedules).due(function_id, OffsetDateTime::now_utc());
        self.schedules_changed();
        due
    }

    /// The clock reached `due`: the tick is published unless the schedule
    /// is paused (then only its next tick moves on) and recorded as a
    /// `clock` run, or as a skipped one while background triggers are
    /// paused or the broker refuses it.
    pub(crate) fn clock_tick(&self, function_id: &str, due: OffsetDateTime) {
        let now = OffsetDateTime::now_utc();
        let definition = lock(&self.inner.schedules).advance(function_id, due, now);
        if let Some(definition) = definition {
            let run = if self.inner.background.background_enabled() {
                match self.publish_tick(&definition) {
                    Ok(message_id) => ScheduleRun {
                        at: now,
                        trigger: RunTrigger::Clock,
                        message_id: Some(message_id),
                        skipped: None,
                    },
                    Err(error) => {
                        let skipped = RunScheduleError::Publish(error.message).to_string();
                        self.log(PubsubLogLine {
                            level: "WARN",
                            kind: LOG_SCHEDULE,
                            text: format!("scheduled tick of {function_id}: {skipped}"),
                            topic: Some(topic_resource(&definition.project, &definition.topic)),
                            subscription: None,
                            function_id: Some(function_id.to_owned()),
                        });
                        ScheduleRun {
                            at: now,
                            trigger: RunTrigger::Clock,
                            message_id: None,
                            skipped: Some(skipped),
                        }
                    }
                }
            } else {
                self.inner.background.note_dropped(DroppedService::Schedule);
                ScheduleRun {
                    at: now,
                    trigger: RunTrigger::Clock,
                    message_id: None,
                    skipped: Some(RunScheduleError::BackgroundPaused.to_string()),
                }
            };
            lock(&self.inner.schedules).record(function_id, run);
        }
        self.schedules_changed();
    }

    /// Publishes one tick of the function's schedule now, the same publish
    /// the clock makes (it works while the schedule is paused), and records
    /// a `console` run.
    pub fn run_schedule(&self, function_id: &str) -> Result<RunOutcome, RunScheduleError> {
        let definition = lock(&self.inner.schedules)
            .entries
            .get(function_id)
            .map(|entry| entry.definition.clone())
            .ok_or(RunScheduleError::NotScheduled)?;
        if !self.inner.background.background_enabled() {
            return Err(RunScheduleError::BackgroundPaused);
        }
        let message_id = self
            .publish_tick(&definition)
            .map_err(|error| RunScheduleError::Publish(error.message))?;
        lock(&self.inner.schedules).record(
            function_id,
            ScheduleRun {
                at: OffsetDateTime::now_utc(),
                trigger: RunTrigger::Console,
                message_id: Some(message_id.clone()),
                skipped: None,
            },
        );
        self.schedules_changed();
        Ok(RunOutcome { message_id })
    }

    /// Pauses or resumes one function's schedule clock.
    pub fn set_schedule_paused(
        &self,
        function_id: &str,
        paused: bool,
    ) -> Result<(), RunScheduleError> {
        let found = lock(&self.inner.schedules).set_paused(function_id, paused);
        self.schedules_changed();
        if found {
            Ok(())
        } else {
            Err(RunScheduleError::NotScheduled)
        }
    }

    /// Every schedule, by function id.
    #[must_use]
    pub fn schedules_view(&self) -> Vec<ScheduleView> {
        let book = lock(&self.inner.schedules);
        book.entries.keys().filter_map(|id| book.view(id)).collect()
    }

    /// One function's schedule.
    #[must_use]
    pub fn schedule_view(&self, function_id: &str) -> Option<ScheduleView> {
        lock(&self.inner.schedules).view(function_id)
    }

    /// One schedule with its upcoming ticks and its kept runs.
    #[must_use]
    pub fn schedule_detail(&self, function_id: &str) -> Option<ScheduleDetail> {
        lock(&self.inner.schedules).detail(function_id)
    }

    /// Every schedule with its upcoming ticks and its kept runs, by function id.
    #[must_use]
    pub fn schedule_details(&self) -> Vec<ScheduleDetail> {
        let book = lock(&self.inner.schedules);
        book.entries
            .keys()
            .filter_map(|id| book.detail(id))
            .collect()
    }

    /// The schedules stamped after `revision` (a live view's cursor).
    #[must_use]
    pub fn schedule_changes(&self, revision: u64) -> ScheduleChanges {
        lock(&self.inner.schedules).changes_since(revision)
    }

    /// A receiver of the scheduler's revision, bumped whenever a schedule's
    /// state changes (its next tick, a run, a pause, the inventory).
    #[must_use]
    pub fn schedule_watch(&self) -> tokio::sync::watch::Receiver<u64> {
        self.inner.schedule_revision.subscribe()
    }
}

/// The nearest existing id in `project` to `id`: case-insensitive optimal
/// string alignment distance up to 2 (the closest, then the first by name);
/// none when `id` itself exists.
fn nearest_id(project: &str, id: &str, existing: &[(String, String)]) -> Option<String> {
    let wanted = id.to_lowercase();
    let mut best: Option<(usize, &str)> = None;
    for (candidate_project, candidate) in existing {
        if candidate_project != project {
            continue;
        }
        if candidate == id {
            return None;
        }
        let distance = osa_distance(&wanted, &candidate.to_lowercase());
        if distance <= 2 && best.is_none_or(|(found, _)| distance < found) {
            best = Some((distance, candidate));
        }
    }
    best.map(|(_, candidate)| candidate.to_owned())
}

/// Damerau-Levenshtein distance in its optimal string alignment form.
fn osa_distance(left: &str, right: &str) -> usize {
    let left: Vec<char> = left.chars().collect();
    let right: Vec<char> = right.chars().collect();
    let width = right.len() + 1;
    let mut table = vec![0_usize; (left.len() + 1) * width];
    for (row, cell) in table.iter_mut().step_by(width).enumerate() {
        *cell = row;
    }
    for (column, cell) in table.iter_mut().take(width).enumerate() {
        *cell = column;
    }
    for row in 1..=left.len() {
        for column in 1..=right.len() {
            let cost = usize::from(left[row - 1] != right[column - 1]);
            let mut value = (table[(row - 1) * width + column] + 1)
                .min(table[row * width + column - 1] + 1)
                .min(table[(row - 1) * width + column - 1] + cost);
            if row > 1
                && column > 1
                && left[row - 1] == right[column - 2]
                && left[row - 2] == right[column - 1]
            {
                value = value.min(table[(row - 2) * width + column - 2] + 1);
            }
            table[row * width + column] = value;
        }
    }
    table[left.len() * width + right.len()]
}

/// The line a push failure that starts a streak logs.
fn push_failure_line(job: &PushJob, outcome: &PushOutcome) -> PubsubLogLine {
    let failure = match (outcome.status, &outcome.error) {
        (Some(status), _) => format!("answered {status}"),
        (None, Some(error)) => format!("failed: {error}"),
        (None, None) => "failed".to_owned(),
    };
    PubsubLogLine {
        level: "WARN",
        kind: LOG_PUSH,
        text: format!(
            "push of message {} to {} {failure}; the emulator retries every second until the endpoint answers 2xx",
            job.message_id, job.endpoint
        ),
        topic: (job.topic != crate::broker::DELETED_TOPIC).then(|| job.topic.clone()),
        subscription: Some(job.subscription.clone()),
        function_id: None,
    }
}

/// A push error the way the push feed shows it.
fn describe_push_error(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        return "timed out".to_owned();
    }
    let mut source: Option<&(dyn std::error::Error + 'static)> = Some(error);
    while let Some(current) = source {
        if let Some(io) = current.downcast_ref::<std::io::Error>() {
            return match io.kind() {
                std::io::ErrorKind::ConnectionRefused => "connect ECONNREFUSED".to_owned(),
                std::io::ErrorKind::ConnectionReset => "ECONNRESET".to_owned(),
                std::io::ErrorKind::TimedOut => "timed out".to_owned(),
                _ => io.to_string(),
            };
        }
        source = current.source();
    }
    error.to_string()
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
