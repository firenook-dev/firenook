//! Pub/Sub's live topics: `pubsub.counters`, `pubsub.topic`, `pubsub.push`,
//! `pubsub.deliveries` and `pubsub.schedules`.
//!
//! Counters are state: a frame carries the topics and subscriptions stamped
//! after the subscriber's revision (its cursor), at most every 250 ms, and
//! `reset` past 200 changed entities. Invalidation topics carry keys
//! (message ids, backlog row keys, event ids), coalesced per 100 ms with
//! `reset` past 1,000 keys. The push feed is the console's ring, fed inline
//! by the runtime's push sink, served by the foundation's `replay_topic`.
//! Schedule frames follow the scheduler and, while Functions run, each
//! run's outcome in compute's record.
//! Every stream first waits for the late runtime, and ends when the suite
//! stops before it arrives.

use std::collections::{BTreeMap, HashSet, VecDeque};
use std::sync::Arc;
use std::time::Duration;

use firenook_functions_runtime::Monitor;
use firenook_functions_runtime::monitor::{InvocationCause, InvocationQuery};
use firenook_pubsub_front::broker::inspect::{ConsoleCursor, DeltaScope, MessageQuery};
use firenook_pubsub_front::broker::{BacklogReader, ResourceKind, SecondWindow};
use firenook_pubsub_front::{PubsubRuntime, PushStreakRecord};
use firenook_suite_front::replay::random_epoch;
use firenook_suite_front::{Entry, ReplayRing, RingBudget, RingLimits};
use futures_util::StreamExt as _;
use futures_util::stream;
use serde::Deserialize;
use tokio::sync::{broadcast, watch};
use tokio::time::Instant;

use super::convert;
use super::types::{
    PubsubCountersFrame, PubsubDeliveriesChanged, PubsubPublished, PubsubPushStreak,
    PubsubRejectedChanged, PubsubResourcesChanged, PubsubScheduleState, PubsubSchedulesFrame,
    PubsubStale, PubsubSubscriptionCounters, PubsubThroughput, PubsubTopicCounters,
};
use crate::api_error::ApiError;
use crate::late::Late;
use crate::live::replay::{ReplayOptions, replay_topic};
use crate::live::{LiveTopic, ResetReason, TopicEvent, TopicStream, topic_params};
use crate::messaging::PubsubConsole;
use crate::messaging::shared::{KeyWindow, MAX_KEYS, second_window};
use crate::section::SectionContext;
use crate::sse::Shutdown;

/// The shortest gap between two counters frames to one subscriber.
const COUNTERS_EVERY: Duration = Duration::from_millis(250);
/// After a `reset` for too many changes, the next frame waits this long.
const RESET_PAUSE: Duration = Duration::from_secs(1);
/// Changed topics and subscriptions one frame lists before it resets.
const MAX_CHANGED: usize = 200;
/// How long an invalidation topic collects keys before it sends them.
const KEY_WINDOW: Duration = Duration::from_millis(100);
/// Topics whose throughput one counters subscription follows.
const MAX_THROUGHPUT: usize = 24;
/// Topics and subscriptions the state a subscriber without a cursor opens
/// with may hold; a project with more opens with `reset` (it reloads).
const OPEN_MAX: usize = 1_000;
/// The push ring: 20,000 streaks, 16 MiB.
const PUSH_RING: RingLimits = RingLimits {
    entries: 20_000,
    bytes: 16 * 1024 * 1024,
    floor: 256,
};
/// Ids a `published` event names at most.
const MAX_IDS: usize = 100;

// ------------------------------------------------------------ the push feed

/// What a push ring entry is filtered by.
#[derive(Clone, Debug)]
pub(crate) struct PushMeta {
    subscription: Arc<str>,
    message_id: u64,
    streak: Arc<str>,
}

/// The console's push streaks, fed inline by the runtime's push sink.
#[derive(Clone, Debug)]
pub(crate) struct PushFeed {
    ring: ReplayRing<PushMeta>,
}

impl PushFeed {
    pub(crate) fn new() -> Self {
        Self {
            ring: ReplayRing::new(
                "pubsub.push",
                PUSH_RING,
                random_epoch(),
                &RingBudget::shared(),
            ),
        }
    }

    /// Installs the push sink: each streak record is serialized once, inline,
    /// into the ring (one short lock, never an await).
    pub(crate) fn install(&self, runtime: &PubsubRuntime) {
        let ring = self.ring.clone();
        runtime.set_push_sink(Arc::new(move |record: PushStreakRecord| {
            let streak = convert::push_streak(&record);
            ring.push_with(|_| {
                let json = serde_json::to_string(&streak).unwrap_or_else(|_| "null".to_owned());
                (
                    PushMeta {
                        subscription: Arc::from(record.subscription.as_str()),
                        message_id: record.message_id,
                        streak: Arc::from(record.streak.as_str()),
                    },
                    Arc::from(json),
                )
            });
        }));
    }

    /// The newest copy of each streak of message `id`, newest first.
    pub(crate) fn streaks_of(&self, id: u64, limit: usize) -> Vec<PubsubPushStreak> {
        let mut seen = HashSet::new();
        self.ring
            .snapshot()
            .iter()
            .rev()
            .filter(|entry| entry.meta.message_id == id)
            .filter(|entry| seen.insert(Arc::clone(&entry.meta.streak)))
            .take(limit)
            .filter_map(|entry| serde_json::from_str(&entry.json).ok())
            .collect()
    }
}

// ------------------------------------------------------------ registration

/// Pub/Sub's live topics.
pub(crate) fn topics(
    late: &Late<PubsubConsole>,
    context: &SectionContext,
) -> Vec<Arc<dyn LiveTopic>> {
    let shared = Shared {
        late: late.clone(),
        project: context.project.to_string(),
        shutdown: context.shutdown.clone(),
    };
    vec![
        Arc::new(CountersTopic(shared.clone())),
        Arc::new(TopicTopic(shared.clone())),
        Arc::new(PushTopic(shared.clone())),
        Arc::new(DeliveriesTopic(shared.clone())),
        Arc::new(SchedulesTopic(shared)),
    ]
}

#[derive(Clone)]
struct Shared {
    late: Late<PubsubConsole>,
    project: String,
    shutdown: Shutdown,
}

impl Shared {
    fn project(&self, asked: Option<String>) -> String {
        asked
            .filter(|project| !project.is_empty())
            .unwrap_or_else(|| self.project.clone())
    }
}

/// A topic that needs the late runtime: built at once when the runtime is
/// there (so the subscriber's position is where it subscribed), else once
/// it arrives; the suite stopping first ends the subscription.
fn after_start(
    shared: &Shared,
    body: impl FnOnce(PubsubConsole) -> TopicStream + Send + 'static,
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
                    ApiError::unavailable("The engine stopped before Pub/Sub started.")
                        .detail()
                        .clone(),
                ))
            })
            .boxed(),
        })
        .boxed()
}

/// A revision cursor: `after` as a number.
fn revision_cursor(after: Option<&str>) -> Option<u64> {
    after.and_then(|after| after.parse().ok())
}

// ------------------------------------------------------------ pubsub.counters

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CountersParams {
    #[serde(default)]
    project: Option<String>,
    /// Full names of the topics on screen, whose throughput the frames carry.
    #[serde(default)]
    throughput: Vec<String>,
}

struct CountersTopic(Shared);

impl LiveTopic for CountersTopic {
    fn name(&self) -> &'static str {
        "pubsub.counters"
    }

    fn open(
        &self,
        params: &serde_json::Value,
        after: Option<&str>,
    ) -> Result<TopicStream, ApiError> {
        let params: CountersParams = topic_params(params)?;
        if params.throughput.len() > MAX_THROUGHPUT {
            return Err(ApiError::invalid(format!(
                "A counters subscription follows the throughput of at most {MAX_THROUGHPUT} topics; this one names {}.",
                params.throughput.len()
            )));
        }
        let project = self.0.project(params.project);
        let after = revision_cursor(after);
        Ok(after_start(&self.0, move |console| {
            Counters::open(console, project, params.throughput, after)
        }))
    }
}

/// One counters subscriber.
///
/// A subscriber without a cursor opens with the state: every topic's and
/// subscription's counters of the project and the throughput it follows,
/// in one frame whose revision is its cursor (a state topic's snapshot on
/// open, which the channel shares with a browser's other tabs). One with a
/// cursor resumes: nothing when it is the current revision, else `reset`.
struct Counters {
    console: PubsubConsole,
    scope: DeltaScope,
    cursor: ConsoleCursor,
    watch: watch::Receiver<u64>,
    rejected: u64,
    throughput: BTreeMap<String, SecondWindow>,
    last: Option<Instant>,
    pause_until: Option<Instant>,
    /// The opening state is still to send (read on the first poll, not in
    /// the subscribing request).
    opening: bool,
    outbox: VecDeque<TopicEvent>,
}

impl Counters {
    fn open(
        console: PubsubConsole,
        project: String,
        throughput: Vec<String>,
        after: Option<u64>,
    ) -> TopicStream {
        let broker = console.runtime.broker();
        let mut watch = broker.console_watch();
        watch.mark_unchanged();
        let scope = DeltaScope {
            project,
            counters: true,
            throughput,
            max_changed: MAX_CHANGED,
            ..DeltaScope::default()
        };
        // Where the subscriber stands: equal to now resumes with nothing,
        // anything else is a gap it reloads from.
        let mut probe = ConsoleCursor::at(u64::MAX);
        let now = broker
            .console_delta(&mut probe, &DeltaScope::default())
            .revision;
        let mut outbox = VecDeque::new();
        if after.is_some_and(|after| after != now) {
            outbox.push_back(TopicEvent::Reset {
                reason: ResetReason::Gap,
                missed: None,
            });
        }
        let rejected = console.runtime.rejected_revision();
        let state = Self {
            cursor: ConsoleCursor::at(now),
            scope,
            watch,
            rejected,
            throughput: BTreeMap::new(),
            last: None,
            pause_until: None,
            opening: after.is_none(),
            outbox,
            console,
        };
        stream::unfold(state, |mut state| async move {
            state.next().await.map(|event| (event, state))
        })
        .boxed()
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
            self.frame();
        }
    }

    /// The state a subscriber without a cursor opens with: the project's
    /// index read once, then whatever changed between that read and the
    /// cursor's (a second short read), so the frame is the state at its
    /// revision and the next frame carries only what changed after it.
    fn open_frame(&mut self) {
        let broker = self.console.runtime.broker();
        let index = broker.topics_index(&self.scope.project);
        let mut topics: BTreeMap<String, PubsubTopicCounters> = index
            .topics
            .iter()
            .map(|topic| (topic.name.clone(), convert::topic_counters(&topic.counters)))
            .collect();
        let mut subscriptions: BTreeMap<String, PubsubSubscriptionCounters> = index
            .topics
            .iter()
            .flat_map(|topic| &topic.subscriptions)
            .chain(&index.detached)
            .map(|subscription| {
                (
                    subscription.name.clone(),
                    convert::subscription_counters(&subscription.counters),
                )
            })
            .collect();
        self.cursor = ConsoleCursor::at(index.revision);
        let delta = broker.console_delta(&mut self.cursor, &self.scope);
        self.last = Some(Instant::now());
        if delta.overflow || topics.len() + subscriptions.len() > OPEN_MAX {
            self.outbox.push_back(TopicEvent::Reset {
                reason: ResetReason::Lagged,
                missed: None,
            });
            return;
        }
        for topic in &delta.topics {
            topics.insert(topic.name.clone(), convert::topic_counters(topic));
        }
        for subscription in &delta.subscriptions {
            subscriptions.insert(
                subscription.name.clone(),
                convert::subscription_counters(subscription),
            );
        }
        let throughput = delta
            .throughput
            .iter()
            .map(|(topic, window)| PubsubThroughput {
                topic: topic.clone(),
                window: second_window(window),
            })
            .collect();
        self.throughput = delta.throughput.into_iter().collect();
        let frame = PubsubCountersFrame {
            revision: delta.revision,
            topics: topics.into_values().collect(),
            subscriptions: subscriptions.into_values().collect(),
            throughput,
        };
        self.outbox.push_back(TopicEvent::json(
            "counters",
            Some(delta.revision.to_string()),
            &frame,
        ));
    }

    /// Reads one delta under the broker's lock and turns it into events.
    fn frame(&mut self) {
        let delta = self
            .console
            .runtime
            .broker()
            .console_delta(&mut self.cursor, &self.scope);
        let now = Instant::now();
        self.last = Some(now);
        self.pause_until = None;
        if !delta.resources.is_empty() {
            self.outbox.push_back(TopicEvent::json(
                "resources",
                None,
                &PubsubResourcesChanged {
                    kinds: delta
                        .resources
                        .iter()
                        .map(|kind: &ResourceKind| kind.as_str().to_owned())
                        .collect(),
                },
            ));
        }
        let rejected = self.console.runtime.rejected_revision();
        if rejected != self.rejected {
            self.rejected = rejected;
            self.outbox.push_back(TopicEvent::json(
                "rejected",
                None,
                &PubsubRejectedChanged { revision: rejected },
            ));
        }
        if delta.overflow {
            self.pause_until = Some(now + RESET_PAUSE);
            self.outbox.push_back(TopicEvent::Reset {
                reason: ResetReason::Lagged,
                missed: None,
            });
            return;
        }
        let throughput: Vec<PubsubThroughput> = delta
            .throughput
            .iter()
            .filter(|(topic, window)| self.throughput.get(topic) != Some(window))
            .map(|(topic, window)| PubsubThroughput {
                topic: topic.clone(),
                window: second_window(window),
            })
            .collect();
        for (topic, window) in delta.throughput {
            self.throughput.insert(topic, window);
        }
        if delta.topics.is_empty() && delta.subscriptions.is_empty() && throughput.is_empty() {
            return;
        }
        let frame = PubsubCountersFrame {
            revision: delta.revision,
            topics: delta.topics.iter().map(convert::topic_counters).collect(),
            subscriptions: delta
                .subscriptions
                .iter()
                .map(convert::subscription_counters)
                .collect(),
            throughput,
        };
        self.outbox.push_back(TopicEvent::json(
            "counters",
            Some(delta.revision.to_string()),
            &frame,
        ));
    }
}

// ------------------------------------------------------------ pubsub.topic

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct TopicParams {
    #[serde(default)]
    project: Option<String>,
    topic: String,
    #[serde(default)]
    subscription: Option<String>,
}

struct TopicTopic(Shared);

impl LiveTopic for TopicTopic {
    fn name(&self) -> &'static str {
        "pubsub.topic"
    }

    fn open(
        &self,
        params: &serde_json::Value,
        after: Option<&str>,
    ) -> Result<TopicStream, ApiError> {
        let params: TopicParams = topic_params(params)?;
        let _ = self.0.project(params.project);
        // An invalidation topic cannot resume: a resubscribe reloads.
        let resumed = after.is_some();
        Ok(after_start(&self.0, move |console| {
            TopicWatcher::open(console, params.topic, params.subscription, resumed)
        }))
    }
}

/// One `pubsub.topic` subscriber.
struct TopicWatcher {
    console: PubsubConsole,
    scope: DeltaScope,
    cursor: ConsoleCursor,
    watch: watch::Receiver<u64>,
    /// Keeps the scoped subscription's moved rows remembered.
    _reader: Option<BacklogReader>,
    touched: Option<broadcast::Receiver<Arc<str>>>,
    keys: KeyWindow,
    /// Invocations touched in the window, resolved once at its end.
    invocations: HashSet<Arc<str>>,
    published: Option<PubsubPublished>,
    due: Option<Instant>,
    outbox: VecDeque<TopicEvent>,
}

impl TopicWatcher {
    fn open(
        console: PubsubConsole,
        topic: String,
        subscription: Option<String>,
        resumed: bool,
    ) -> TopicStream {
        let broker = console.runtime.broker();
        let reader = subscription
            .as_deref()
            .and_then(|subscription| broker.backlog_reader(subscription));
        let mut watch = broker.console_watch();
        watch.mark_unchanged();
        let scope = DeltaScope {
            project: String::new(),
            resources: true,
            topic: Some(topic),
            subscription,
            deliveries: true,
            ..DeltaScope::default()
        };
        // The first delta only sets where the topic, the backlog and the
        // fanouts stand.
        let mut cursor = ConsoleCursor::default();
        let _ = broker.console_delta(&mut cursor, &scope);
        let mut outbox = VecDeque::new();
        if resumed {
            outbox.push_back(TopicEvent::Reset {
                reason: ResetReason::Gap,
                missed: None,
            });
        }
        let touched = console.monitor.as_ref().map(Monitor::touched);
        let state = Self {
            console,
            scope,
            cursor,
            watch,
            _reader: reader,
            touched,
            keys: KeyWindow::default(),
            invocations: HashSet::new(),
            published: None,
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
                touched = recv_touched(self.touched.as_mut()) => match touched {
                    Ok(id) => {
                        if self.invocations.len() < MAX_KEYS {
                            self.invocations.insert(id);
                        } else {
                            self.keys.overflow();
                        }
                        self.due.get_or_insert_with(|| Instant::now() + KEY_WINDOW);
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        self.keys.overflow();
                        self.due.get_or_insert_with(|| Instant::now() + KEY_WINDOW);
                    }
                    Err(broadcast::error::RecvError::Closed) => self.touched = None,
                },
                () = sleep_until(due) => self.flush(),
            }
        }
    }

    /// Reads one delta and adds what changed to the window.
    fn collect(&mut self) {
        let delta = self
            .console
            .runtime
            .broker()
            .console_delta(&mut self.cursor, &self.scope);
        if let Some(published) = delta.published {
            let merged = match self.published.take() {
                Some(previous) => {
                    let mut ids: Vec<String> =
                        published.ids.iter().map(ToString::to_string).collect();
                    ids.extend(previous.ids);
                    let overflow = previous.overflow || published.overflow || ids.len() > MAX_IDS;
                    ids.truncate(MAX_IDS);
                    PubsubPublished {
                        latest_id: published.latest_id.to_string(),
                        added: previous.added + published.added,
                        ids,
                        overflow,
                    }
                }
                None => PubsubPublished {
                    latest_id: published.latest_id.to_string(),
                    added: published.added,
                    ids: published.ids.iter().map(ToString::to_string).collect(),
                    overflow: published.overflow,
                },
            };
            self.published = Some(merged);
        }
        if delta.backlog_reset {
            self.keys.overflow();
        }
        for key in &delta.backlog {
            self.keys.add(format!("backlog:{key}"));
            self.keys.add(format!("message:{}", key.id));
        }
        if let Some(fanouts) = delta.deliveries {
            if fanouts.overflow {
                self.keys.overflow();
            }
            for id in fanouts.message_ids {
                self.keys.add(format!("message:{id}"));
            }
        }
        if self.published.is_some() || !self.keys.is_empty() {
            self.due.get_or_insert_with(|| Instant::now() + KEY_WINDOW);
        }
    }

    /// The window ended: resolves the touched invocations and sends.
    fn flush(&mut self) {
        self.due = None;
        let topic = self.scope.topic.clone().unwrap_or_default();
        if let Some(monitor) = &self.console.monitor
            && !self.invocations.is_empty()
        {
            for cause in invocation_causes(monitor, &self.invocations) {
                if let InvocationCause::Pubsub {
                    topic: cause_topic,
                    message_id: Some(id),
                    ..
                } = cause
                    && cause_topic == topic
                {
                    self.keys.add(format!("message:{id}"));
                }
            }
        }
        self.invocations.clear();
        if let Some(published) = self.published.take() {
            self.outbox
                .push_back(TopicEvent::json("published", None, &published));
        }
        match self.keys.take() {
            Ok(keys) if keys.is_empty() => {}
            Ok(keys) => {
                self.outbox
                    .push_back(TopicEvent::json("stale", None, &PubsubStale { keys }));
            }
            Err(()) => self.outbox.push_back(TopicEvent::Reset {
                reason: ResetReason::Lagged,
                missed: None,
            }),
        }
    }
}

async fn recv_touched(
    touched: Option<&mut broadcast::Receiver<Arc<str>>>,
) -> Result<Arc<str>, broadcast::error::RecvError> {
    match touched {
        Some(touched) => touched.recv().await,
        None => std::future::pending().await,
    }
}

async fn sleep_until(due: Option<Instant>) {
    match due {
        Some(due) => tokio::time::sleep_until(due).await,
        None => std::future::pending().await,
    }
}

/// The causes of the invocations `ids`, read under compute's lock once.
fn invocation_causes(monitor: &Monitor, ids: &HashSet<Arc<str>>) -> Vec<InvocationCause> {
    let filter = |summary: &firenook_functions_runtime::monitor::InvocationSummary| {
        ids.contains(summary.id.as_str())
    };
    monitor
        .invocations(
            &InvocationQuery {
                filter: Some(&filter),
                limit: ids.len(),
            },
            None,
        )
        .items
        .into_iter()
        .map(|summary| summary.cause)
        .collect()
}

/// The event ids of the invocations `ids` whose cause names `topic`.
fn touched_events(monitor: &Monitor, ids: &HashSet<Arc<str>>, topic: &str) -> Vec<String> {
    let filter = |summary: &firenook_functions_runtime::monitor::InvocationSummary| {
        ids.contains(summary.id.as_str())
    };
    monitor
        .invocations(
            &InvocationQuery {
                filter: Some(&filter),
                limit: ids.len(),
            },
            None,
        )
        .items
        .into_iter()
        .filter(|summary| match &summary.cause {
            InvocationCause::Pubsub { topic: cause, .. }
            | InvocationCause::Schedule { topic: cause, .. } => cause == topic,
            _ => false,
        })
        .filter_map(|summary| summary.event_id)
        .collect()
}

// ------------------------------------------------------------ pubsub.push

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct PushParams {
    #[serde(default)]
    project: Option<String>,
    subscription: String,
}

struct PushTopic(Shared);

impl LiveTopic for PushTopic {
    fn name(&self) -> &'static str {
        "pubsub.push"
    }

    fn open(
        &self,
        params: &serde_json::Value,
        after: Option<&str>,
    ) -> Result<TopicStream, ApiError> {
        let params: PushParams = topic_params(params)?;
        let _ = self.0.project(params.project);
        let after = after.map(str::to_owned);
        let subscription: Arc<str> = Arc::from(params.subscription);
        Ok(after_start(&self.0, move |console| {
            let options = ReplayOptions {
                filter: Some(Arc::new(move |meta: &PushMeta| {
                    meta.subscription == subscription
                })),
                shape: Some(Box::new(|entries| Some(newest_streaks(entries)))),
                ..ReplayOptions::default()
            };
            replay_topic(&console.feed.ring, after.as_deref(), "attempts", options)
        }))
    }
}

/// One window's streaks, keeping only the newest copy of each.
fn newest_streaks(entries: &[Entry<PushMeta>]) -> Arc<str> {
    let mut newest: BTreeMap<&str, usize> = BTreeMap::new();
    for (index, entry) in entries.iter().enumerate() {
        newest.insert(&entry.meta.streak, index);
    }
    let mut kept: Vec<usize> = newest.into_values().collect();
    kept.sort_unstable();
    let items: Vec<&str> = kept.iter().map(|index| &*entries[*index].json).collect();
    Arc::from(format!("{{\"items\":[{}]}}", items.join(",")))
}

// ------------------------------------------------------------ pubsub.deliveries

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct DeliveriesParams {
    #[serde(default)]
    project: Option<String>,
    topic: String,
}

struct DeliveriesTopic(Shared);

impl LiveTopic for DeliveriesTopic {
    fn name(&self) -> &'static str {
        "pubsub.deliveries"
    }

    fn open(
        &self,
        params: &serde_json::Value,
        after: Option<&str>,
    ) -> Result<TopicStream, ApiError> {
        let params: DeliveriesParams = topic_params(params)?;
        let _ = self.0.project(params.project);
        let resumed = after.is_some();
        Ok(after_start(&self.0, move |console| {
            DeliveriesWatcher::open(console, params.topic, resumed)
        }))
    }
}

/// One `pubsub.deliveries` subscriber.
struct DeliveriesWatcher {
    console: PubsubConsole,
    scope: DeltaScope,
    cursor: ConsoleCursor,
    watch: watch::Receiver<u64>,
    touched: Option<broadcast::Receiver<Arc<str>>>,
    keys: KeyWindow,
    invocations: HashSet<Arc<str>>,
    added: u32,
    overflow: bool,
    due: Option<Instant>,
    outbox: VecDeque<TopicEvent>,
}

impl DeliveriesWatcher {
    fn open(console: PubsubConsole, topic: String, resumed: bool) -> TopicStream {
        let Some(monitor) = console.monitor.clone() else {
            return stream::once(async {
                TopicEvent::End(Some(super::errors::functions_absent().detail().clone()))
            })
            .boxed();
        };
        let broker = console.runtime.broker();
        let mut watch = broker.console_watch();
        watch.mark_unchanged();
        let scope = DeltaScope {
            topic: Some(topic),
            deliveries: true,
            ..DeltaScope::default()
        };
        let mut cursor = ConsoleCursor::default();
        let _ = broker.console_delta(&mut cursor, &scope);
        let mut outbox = VecDeque::new();
        if resumed {
            outbox.push_back(TopicEvent::Reset {
                reason: ResetReason::Gap,
                missed: None,
            });
        }
        let state = Self {
            touched: Some(monitor.touched()),
            console,
            scope,
            cursor,
            watch,
            keys: KeyWindow::default(),
            invocations: HashSet::new(),
            added: 0,
            overflow: false,
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
                    let delta = self
                        .console
                        .runtime
                        .broker()
                        .console_delta(&mut self.cursor, &self.scope);
                    if let Some(fanouts) = delta.deliveries {
                        self.added = self.added.saturating_add(fanouts.added);
                        self.overflow |= fanouts.overflow;
                        for event in fanouts.event_ids {
                            self.keys.add(event);
                        }
                        self.due.get_or_insert_with(|| Instant::now() + KEY_WINDOW);
                    }
                }
                touched = recv_touched(self.touched.as_mut()) => match touched {
                    Ok(id) => {
                        if self.invocations.len() < MAX_KEYS {
                            self.invocations.insert(id);
                        } else {
                            self.overflow = true;
                        }
                        self.due.get_or_insert_with(|| Instant::now() + KEY_WINDOW);
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        self.overflow = true;
                        self.due.get_or_insert_with(|| Instant::now() + KEY_WINDOW);
                    }
                    Err(broadcast::error::RecvError::Closed) => self.touched = None,
                },
                () = sleep_until(due) => self.flush(),
            }
        }
    }

    fn flush(&mut self) {
        self.due = None;
        let topic = self.scope.topic.clone().unwrap_or_default();
        if let Some(monitor) = &self.console.monitor
            && !self.invocations.is_empty()
        {
            for event in touched_events(monitor, &self.invocations, &topic) {
                self.keys.add(event);
            }
        }
        self.invocations.clear();
        let keys = if let Ok(mut keys) = self.keys.take() {
            if keys.len() > MAX_IDS {
                keys.truncate(MAX_IDS);
                self.overflow = true;
            }
            keys
        } else {
            self.overflow = true;
            Vec::new()
        };
        if keys.is_empty() && self.added == 0 && !self.overflow {
            return;
        }
        let event = PubsubDeliveriesChanged {
            keys,
            added: std::mem::take(&mut self.added),
            overflow: std::mem::take(&mut self.overflow),
        };
        self.outbox
            .push_back(TopicEvent::json("changed", None, &event));
    }
}

// ------------------------------------------------------------ pubsub.schedules

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct SchedulesParams {
    #[serde(default)]
    project: Option<String>,
}

struct SchedulesTopic(Shared);

impl LiveTopic for SchedulesTopic {
    fn name(&self) -> &'static str {
        "pubsub.schedules"
    }

    fn open(
        &self,
        params: &serde_json::Value,
        after: Option<&str>,
    ) -> Result<TopicStream, ApiError> {
        let params: SchedulesParams = topic_params(params)?;
        let _ = self.0.project(params.project);
        let after = revision_cursor(after);
        Ok(after_start(&self.0, move |console| {
            Schedules::open(console, after)
        }))
    }
}

/// One `pubsub.schedules` subscriber.
///
/// A frame follows each change of the scheduler (its revision is the
/// cursor) and, while Functions run, each change of a run's outcome in
/// compute's record: the invocations touched in a 100 ms window are
/// resolved once, and the schedules whose topic they name are sent again
/// with the same revision. The scheduler's revision does not cover those
/// outcomes, so a subscriber resuming while Functions run always gets
/// `reset` and reloads.
struct Schedules {
    console: PubsubConsole,
    revision: u64,
    watch: watch::Receiver<u64>,
    touched: Option<broadcast::Receiver<Arc<str>>>,
    invocations: HashSet<Arc<str>>,
    /// More invocations were touched than one window resolves: every
    /// schedule is sent again.
    overflow: bool,
    due: Option<Instant>,
    outbox: VecDeque<TopicEvent>,
}

impl Schedules {
    fn open(console: PubsubConsole, after: Option<u64>) -> TopicStream {
        let mut watch = console.runtime.schedule_watch();
        watch.mark_unchanged();
        let now = console.runtime.schedule_changes(u64::MAX).revision;
        let touched = console.monitor.as_ref().map(Monitor::touched);
        let mut outbox = VecDeque::new();
        if after.is_some_and(|after| after != now || touched.is_some()) {
            outbox.push_back(TopicEvent::Reset {
                reason: ResetReason::Gap,
                missed: None,
            });
        }
        let mut state = Self {
            console,
            revision: now,
            watch,
            touched,
            invocations: HashSet::new(),
            overflow: false,
            due: None,
            outbox,
        };
        // Without a cursor the subscriber opens with every schedule's state
        // (a handful: one per scheduled function).
        if after.is_none() {
            let views = state.console.runtime.schedules_view();
            if !views.is_empty() {
                state.send(&views);
            }
        }
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
                    self.scheduler_changed();
                }
                touched = recv_touched(self.touched.as_mut()) => match touched {
                    Ok(id) => {
                        if self.invocations.len() < MAX_KEYS {
                            self.invocations.insert(id);
                        } else {
                            self.overflow = true;
                        }
                        self.due.get_or_insert_with(|| Instant::now() + KEY_WINDOW);
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        self.overflow = true;
                        self.due.get_or_insert_with(|| Instant::now() + KEY_WINDOW);
                    }
                    Err(broadcast::error::RecvError::Closed) => self.touched = None,
                },
                () = sleep_until(due) => self.outcomes_changed(),
            }
        }
    }

    fn scheduler_changed(&mut self) {
        let changes = self.console.runtime.schedule_changes(self.revision);
        self.revision = changes.revision;
        if changes.removed {
            self.outbox.push_back(TopicEvent::Reset {
                reason: ResetReason::Gap,
                missed: None,
            });
            return;
        }
        if !changes.changed.is_empty() {
            self.send(&changes.changed);
        }
    }

    /// The window ended: the schedules whose runs' invocations were
    /// touched, sent again.
    fn outcomes_changed(&mut self) {
        self.due = None;
        let ids = std::mem::take(&mut self.invocations);
        let Some(monitor) = &self.console.monitor else {
            return;
        };
        let views = self.console.runtime.schedules_view();
        let views: Vec<_> = if std::mem::take(&mut self.overflow) {
            views
        } else {
            let topics: HashSet<String> = invocation_causes(monitor, &ids)
                .into_iter()
                .filter_map(|cause| match cause {
                    InvocationCause::Schedule { topic, .. }
                    | InvocationCause::Pubsub { topic, .. } => Some(topic),
                    _ => None,
                })
                .collect();
            views
                .into_iter()
                .filter(|view| topics.contains(&view.topic))
                .collect()
        };
        if !views.is_empty() {
            self.send(&views);
        }
    }

    fn send(&mut self, views: &[firenook_pubsub_front::ScheduleView]) {
        let states = schedule_states(&self.console, views);
        self.outbox.push_back(TopicEvent::json(
            "schedules",
            Some(self.revision.to_string()),
            &PubsubSchedulesFrame {
                revision: self.revision,
                schedules: states,
            },
        ));
    }
}

/// The changed schedules' states, each last run's delivery joined.
fn schedule_states(
    console: &PubsubConsole,
    views: &[firenook_pubsub_front::ScheduleView],
) -> Vec<PubsubScheduleState> {
    let targets = super::targets(console);
    let broker = console.runtime.broker();
    let mut last_rows = Vec::new();
    for view in views {
        let row = view
            .last_run
            .as_ref()
            .and_then(|run| run.message_id.as_deref()?.parse::<u64>().ok())
            .and_then(|id| {
                broker
                    .history_rows(&view.topic, &[id], &MessageQuery::default())
                    .pop()
                    .flatten()
            });
        last_rows.push(row);
    }
    let join = super::convert::Join::read(
        console.monitor.as_ref(),
        console.runtime.delivery_queue_depth(),
        &targets,
        last_rows
            .iter()
            .flatten()
            .flat_map(|row| convert::event_ids(row.fanout.as_ref())),
    );
    views
        .iter()
        .zip(last_rows)
        .map(|(view, row)| {
            let last_outcome = row.and_then(|row| {
                let fanout = row.fanout.as_ref()?;
                let target = fanout
                    .targets
                    .iter()
                    .rev()
                    .find(|target| target.function_id == view.function_id)?;
                join.functions
                    .then(|| join.mark(&view.topic, fanout, target))
            });
            PubsubScheduleState {
                function_id: view.function_id.clone(),
                paused: view.paused,
                automatic: view.automatic,
                next_run_at: view.next_run_at.map(convert::odt),
                runs: view.runs,
                last_run_at: view.last_run.as_ref().map(|run| convert::odt(run.at)),
                last_outcome,
            }
        })
        .collect()
}
