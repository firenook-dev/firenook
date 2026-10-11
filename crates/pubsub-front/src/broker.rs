//! The Pub/Sub broker: topics, subscriptions with a per-subscription backlog
//! (leases, ack deadlines, redelivery, dead-lettering, ordering keys,
//! filters, retention, seek and snapshots), push delivery and Avro schemas,
//! with the official emulator's validation order, error strings and
//! defaults as the recorded corpus shows them.
//!
//! Every change of a tracked message goes through one transition that keeps
//! the subscription's counts and indexes (available in delivery order,
//! leases and pushes by due time, acknowledged ids, ack ids, leased ordering
//! keys) in step, so a pull, an ack and a tick cost what they touch, not the
//! size of the backlog. An acknowledged message is dropped as soon as nothing
//! can bring it back (retention, a snapshot, or another subscription of the
//! topic still holding it), and every topic keeps a bounded history ring of
//! what was published to it, with what each subscription did with each
//! message once it let go of it.

use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use apache_avro::Schema as AvroSchema;
use pbjson_types::{Duration as ProtoDuration, Timestamp};
use sha2::{Digest as _, Sha256};
use tokio::sync::watch;
use tonic::Code;

use crate::avro;
use crate::error::PubsubError;
use crate::filter::Filter;
use crate::google::pubsub::v1::{
    DeadLetterPolicy, Encoding, ExpirationPolicy, PubsubMessage, PushConfig, ReceivedMessage,
    RetryPolicy, Schema, SchemaSettings, SchemaView, Snapshot, Subscription, Topic,
};
use crate::names;

pub const DELETED_TOPIC: &str = "_deleted-topic_";
pub const DELETED_SCHEMA: &str = "_deleted-schema_";
const DEFAULT_ACK_DEADLINE: i32 = 10;
const DEFAULT_RETENTION_SECONDS: i64 = 604_800;
const MIN_RETENTION_SECONDS: i64 = 600;
const MAX_RETENTION_SECONDS: i64 = 604_800;
const SNAPSHOT_TTL: Duration = Duration::from_hours(168);
/// A pull without `returnImmediately` waits this long for a message.
pub const LONG_POLL: Duration = Duration::from_secs(89);
/// A failed push is retried at this interval.
pub const PUSH_RETRY: Duration = Duration::from_secs(1);
/// A push handed to the push loop is not due again until it finishes (the
/// loop's HTTP client gives up after 30 s); a finished push sets its own
/// next attempt.
const PUSH_IN_FLIGHT: Duration = Duration::from_secs(90);
/// How often the tick prunes retention windows and retained acknowledgements.
const SLOW_TICK: Duration = Duration::from_secs(1);
/// What one recorded history outcome costs in a ring's byte count.
const OUTCOME_BYTES: u64 = 8;
/// Ordering keys remembered per topic (the newest).
const SEEN_ORDERING_KEYS: usize = 50;
/// Attribute names remembered per topic (the first).
const SEEN_ATTRIBUTE_KEYS: usize = 100;

/// One published message, shared by every subscription that received it.
#[derive(Debug)]
pub struct StoredMessage {
    pub id: u64,
    pub message: PubsubMessage,
    pub published: Instant,
    pub published_at: SystemTime,
    /// Data, attribute names and values, and the ordering key, in bytes.
    pub size: u32,
}

/// The bytes a message costs: data, attributes and ordering key.
#[must_use]
pub fn message_size(message: &PubsubMessage) -> u32 {
    let attributes: usize = message
        .attributes
        .iter()
        .map(|(key, value)| key.len() + value.len())
        .sum();
    u32::try_from(message.data.len() + attributes + message.ordering_key.len()).unwrap_or(u32::MAX)
}

/// What a subscription did with a message when it let go of it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// Acknowledged, and nothing could bring it back.
    Acked,
    /// Forwarded to the dead-letter topic.
    DeadLettered,
    /// Taken by the functions consumer of an `emulator-sub-*` subscription.
    Drained,
}

/// One message in a topic's history ring, with the outcomes of the
/// subscriptions that let go of it (keyed by their slot).
#[derive(Debug)]
pub struct HistoryEntry {
    pub message: Arc<StoredMessage>,
    outcomes: Mutex<Vec<(u32, Outcome)>>,
}

impl HistoryEntry {
    fn new(message: Arc<StoredMessage>) -> Self {
        Self {
            message,
            outcomes: Mutex::new(Vec::new()),
        }
    }

    /// The outcomes recorded so far, as `(subscription slot, outcome)`.
    #[must_use]
    pub fn outcomes(&self) -> Vec<(u32, Outcome)> {
        lock(&self.outcomes).clone()
    }

    /// What the entry costs in its ring's byte count.
    fn bytes(&self) -> u64 {
        let outcomes = u64::try_from(lock(&self.outcomes).len()).unwrap_or(u64::MAX);
        u64::from(self.message.size).saturating_add(outcomes.saturating_mul(OUTCOME_BYTES))
    }
}

/// The bounds of the history rings and of retained acknowledgements.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct HistoryLimits {
    /// Messages a topic without retention keeps.
    pub(crate) messages: usize,
    /// Bytes a topic without retention keeps.
    pub(crate) bytes: u64,
    /// Messages a topic with retention keeps inside its window.
    pub(crate) retention_messages: usize,
    /// Bytes a topic with retention keeps inside its window.
    pub(crate) retention_bytes: u64,
    /// Bytes every ring together keeps.
    pub(crate) total_bytes: u64,
    /// The global cap never takes a topic below this many messages.
    pub(crate) floor: usize,
    /// Retained acknowledged messages a subscription keeps.
    pub(crate) retained_acked: usize,
}

impl Default for HistoryLimits {
    fn default() -> Self {
        Self {
            messages: 5_000,
            bytes: 16 << 20,
            retention_messages: 100_000,
            retention_bytes: 256 << 20,
            total_bytes: 512 << 20,
            floor: 100,
            retained_acked: 100_000,
        }
    }
}

/// What a topic's history ring holds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistoryWindow {
    pub messages: u32,
    pub bytes: u64,
    pub oldest_id: Option<u64>,
    pub capacity_messages: u32,
    pub capacity_bytes: u64,
    /// Messages dropped from the ring since start (subscriptions may still hold them).
    pub dropped: u64,
}

/// Ordering keys and attribute names seen on a topic as messages arrived.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeenKeys {
    /// The newest 50 ordering keys, newest first.
    pub ordering_keys: Vec<String>,
    /// The first 100 attribute names, sorted.
    pub attribute_keys: Vec<String>,
}

/// A subscription's figures, kept as messages move.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubscriptionCounts {
    /// Deliverable now.
    pub available: u64,
    /// Leased to a subscriber and not yet acknowledged.
    pub outstanding: u64,
    /// Owned by the push loop.
    pub pushing: u64,
    /// Acknowledged and kept (retention, a snapshot, or another subscription
    /// still holding the message).
    pub retained_acked: u64,
    /// Bytes of the unacknowledged messages.
    pub backlog_bytes: u64,
    /// When the oldest unacknowledged message was published.
    pub oldest_unacked_at: Option<SystemTime>,
    /// Unacknowledged messages delivered more than once.
    pub redelivered: u64,
    /// Acknowledgements since the subscription was created.
    pub acked_total: u64,
    /// Messages forwarded to the dead-letter topic since it was created.
    pub dead_lettered_total: u64,
    /// Ordering keys held back by an outstanding message.
    pub blocked_keys: u32,
}

/// What became of one message at one subscription.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MessageMark {
    Available,
    Outstanding,
    Pushing,
    /// Acknowledged: still kept, or let go (the outcome on the history entry).
    Acked,
    DeadLettered,
    /// Taken by the functions consumer of an `emulator-sub-*` subscription.
    Drained,
    /// The subscription's filter did not pass it.
    Filtered,
    /// The subscription was created after the message.
    NotTracked,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum MessageState {
    /// Deliverable by pull or push.
    Available,
    /// Delivered and waiting for an acknowledgement.
    Leased { ack: u64, deadline: Instant },
    /// Owned by the push loop.
    Pushing { next_attempt: Instant },
    /// Acknowledged and kept: retained, or something can still revive it.
    Acked,
}

#[derive(Debug)]
struct Tracked {
    message: Arc<StoredMessage>,
    state: MessageState,
    /// Deliveries so far.
    attempts: u32,
    /// Delivery order: the message id at first, a fresh number after a nack
    /// or an expired lease (a redelivery queues behind later messages).
    sequence: u64,
}

impl Tracked {
    fn unacked(&self) -> bool {
        self.state != MessageState::Acked
    }
}

#[derive(Debug)]
struct TopicEntry {
    topic: Topic,
    generation: u64,
    /// The newest published messages, oldest first (ids ascend).
    history: VecDeque<Arc<HistoryEntry>>,
    history_bytes: u64,
    history_dropped: u64,
    /// The newest distinct ordering keys, newest last.
    ordering_keys: VecDeque<String>,
    /// The first distinct attribute names.
    attribute_keys: BTreeSet<String>,
    /// The Avro revision bound at creation or the last `schema_settings` update.
    schema: Option<BoundSchema>,
}

#[derive(Debug, Clone)]
struct BoundSchema {
    revision_id: String,
    parsed: Arc<AvroSchema>,
    encoding: Encoding,
    deleted: bool,
}

/// The figures one subscription keeps as its messages move.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
struct Counts {
    available: u64,
    leased: u64,
    pushing: u64,
    acked: u64,
    unacked_bytes: u64,
    redelivered: u64,
}

/// A subscription's counts and indexes; [`Index::add`] and [`Index::remove`]
/// are the only writers, called around every change of a tracked message.
#[derive(Debug, Default, PartialEq, Eq)]
struct Index {
    counts: Counts,
    /// Unacknowledged ids (the first is the oldest).
    unacked: BTreeSet<u64>,
    /// Available messages in delivery order, `(sequence, id)`.
    available: BTreeSet<(u64, u64)>,
    /// Leased messages by lease expiry.
    leases: BTreeSet<(Instant, u64)>,
    /// Pushing messages by next attempt.
    push_due: BTreeSet<(Instant, u64)>,
    /// Acknowledged ids still kept.
    acked: BTreeSet<u64>,
    /// Ack id to message id, for leased messages.
    acks: HashMap<u64, u64>,
    /// Ordering key to the leased messages holding it.
    leased_keys: HashMap<String, BTreeSet<u64>>,
}

impl Index {
    fn add(&mut self, id: u64, tracked: &Tracked) {
        match &tracked.state {
            MessageState::Available => {
                self.counts.available += 1;
                self.available.insert((tracked.sequence, id));
            }
            MessageState::Leased { ack, deadline } => {
                self.counts.leased += 1;
                self.leases.insert((*deadline, id));
                self.acks.insert(*ack, id);
                let key = &tracked.message.message.ordering_key;
                if !key.is_empty() {
                    self.leased_keys.entry(key.clone()).or_default().insert(id);
                }
            }
            MessageState::Pushing { next_attempt } => {
                self.counts.pushing += 1;
                self.push_due.insert((*next_attempt, id));
            }
            MessageState::Acked => {
                self.counts.acked += 1;
                self.acked.insert(id);
            }
        }
        if tracked.unacked() {
            self.unacked.insert(id);
            self.counts.unacked_bytes += u64::from(tracked.message.size);
            if tracked.attempts > 1 {
                self.counts.redelivered += 1;
            }
        }
    }

    fn remove(&mut self, id: u64, tracked: &Tracked) {
        match &tracked.state {
            MessageState::Available => {
                self.counts.available -= 1;
                self.available.remove(&(tracked.sequence, id));
            }
            MessageState::Leased { ack, deadline } => {
                self.counts.leased -= 1;
                self.leases.remove(&(*deadline, id));
                self.acks.remove(ack);
                let key = &tracked.message.message.ordering_key;
                if !key.is_empty()
                    && let Some(leased) = self.leased_keys.get_mut(key)
                {
                    leased.remove(&id);
                    if leased.is_empty() {
                        self.leased_keys.remove(key);
                    }
                }
            }
            MessageState::Pushing { next_attempt } => {
                self.counts.pushing -= 1;
                self.push_due.remove(&(*next_attempt, id));
            }
            MessageState::Acked => {
                self.counts.acked -= 1;
                self.acked.remove(&id);
            }
        }
        if tracked.unacked() {
            self.unacked.remove(&id);
            self.counts.unacked_bytes -= u64::from(tracked.message.size);
            if tracked.attempts > 1 {
                self.counts.redelivered -= 1;
            }
        }
    }
}

#[derive(Debug)]
struct SubscriptionEntry {
    subscription: Subscription,
    /// The generation of the topic the subscription was created on; a
    /// deleted (or re-created) topic never matches it again.
    topic_generation: u64,
    /// The topic name as created, kept for snapshots after the topic is gone.
    original_topic: String,
    topic_deleted: bool,
    filter: Option<Filter>,
    messages: BTreeMap<u64, Tracked>,
    index: Index,
    acked_total: u64,
    dead_lettered_total: u64,
    created_at: SystemTime,
    /// A small id naming the subscription in history outcomes.
    slot: u32,
}

/// Whether a change moved a message out of or into the backlog.
#[derive(Debug, Clone, Copy)]
struct Moved {
    was_unacked: bool,
    is_unacked: bool,
}

impl SubscriptionEntry {
    fn is_push(&self) -> bool {
        self.subscription
            .push_config
            .as_ref()
            .is_some_and(|config| !config.push_endpoint.is_empty())
    }

    fn insert(&mut self, tracked: Tracked) {
        let id = tracked.message.id;
        self.index.add(id, &tracked);
        if let Some(previous) = self.messages.insert(id, tracked) {
            self.index.remove(id, &previous);
        }
    }

    fn remove(&mut self, id: u64) -> Option<Tracked> {
        let tracked = self.messages.remove(&id)?;
        self.index.remove(id, &tracked);
        Some(tracked)
    }

    /// The one place a tracked message changes: counts and indexes follow.
    fn update(&mut self, id: u64, change: impl FnOnce(&mut Tracked)) -> Option<Moved> {
        let tracked = self.messages.get_mut(&id)?;
        let was_unacked = tracked.unacked();
        self.index.remove(id, tracked);
        change(tracked);
        self.index.add(id, tracked);
        Some(Moved {
            was_unacked,
            is_unacked: tracked.unacked(),
        })
    }

    fn counts(&self) -> SubscriptionCounts {
        let counts = self.index.counts;
        SubscriptionCounts {
            available: counts.available,
            outstanding: counts.leased,
            pushing: counts.pushing,
            retained_acked: counts.acked,
            backlog_bytes: counts.unacked_bytes,
            oldest_unacked_at: self
                .index
                .unacked
                .first()
                .and_then(|id| self.messages.get(id))
                .map(|tracked| tracked.message.published_at),
            redelivered: counts.redelivered,
            acked_total: self.acked_total,
            dead_lettered_total: self.dead_lettered_total,
            blocked_keys: if self.subscription.enable_message_ordering {
                u32::try_from(self.index.leased_keys.len()).unwrap_or(u32::MAX)
            } else {
                0
            },
        }
    }
}

#[derive(Debug)]
struct SnapshotEntry {
    snapshot: Snapshot,
    topic_generation: u64,
    unacked: BTreeSet<u64>,
    created: Instant,
}

#[derive(Debug, Clone)]
struct Revision {
    id: String,
    definition: String,
    created_at: SystemTime,
    parsed: Arc<AvroSchema>,
}

#[derive(Debug)]
struct SchemaEntry {
    name: String,
    revisions: Vec<Revision>,
}

/// Who holds a message of a topic generation shared by two or more
/// subscriptions: how many hold it unacknowledged, and which (by slot) keep
/// an acknowledged copy only because a snapshot taken from one of those could
/// revive it.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
struct Holders {
    unacked: u32,
    kept_for_peers: Vec<u32>,
}

/// One topic generation: its subscriptions, its snapshots, and (while it has
/// two or more subscriptions) who holds each of its messages.
#[derive(Debug, Default)]
struct Generation {
    members: BTreeSet<String>,
    snapshots: u32,
    holders: HashMap<u64, Holders>,
}

impl Generation {
    fn shared(&self) -> bool {
        self.members.len() >= 2
    }
}

#[derive(Debug)]
struct State {
    topics: BTreeMap<String, TopicEntry>,
    subscriptions: BTreeMap<String, SubscriptionEntry>,
    snapshots: BTreeMap<String, SnapshotEntry>,
    schemas: BTreeMap<String, SchemaEntry>,
    generations: HashMap<u64, Generation>,
    /// Subscription names by slot.
    slots: HashMap<u32, String>,
    next_slot: u32,
    next_message_id: u64,
    next_ack: u64,
    next_generation: u64,
    revision_counter: u64,
    /// Bytes held by every history ring together.
    history_bytes: u64,
    limits: HistoryLimits,
    /// When the tick next prunes retention windows and retained acknowledgements.
    next_slow_tick: Instant,
}

/// A push the loop must attempt.
#[derive(Debug, Clone)]
pub struct PushJob {
    pub subscription: String,
    pub message_id: u64,
    pub endpoint: String,
    pub headers: BTreeMap<String, String>,
    pub body: String,
}

/// What a publish delivered to function triggers.
#[derive(Debug, Clone)]
pub struct Published {
    pub topic: String,
    pub messages: Vec<Arc<StoredMessage>>,
}

struct Inner {
    state: Mutex<State>,
    /// Bumped on every change a waiter could care about.
    changed: watch::Sender<u64>,
    /// Pushes currently in flight, by subscription.
    in_flight: Mutex<HashMap<String, BTreeSet<u64>>>,
}

/// The shared broker.
#[derive(Clone)]
pub struct Broker {
    inner: Arc<Inner>,
}

impl Default for Broker {
    fn default() -> Self {
        Self::new()
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Redelivery order numbers, above every message id.
fn next_sequence() -> u64 {
    static SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1 << 40);
    SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

fn timestamp(time: SystemTime) -> Timestamp {
    let since = time.duration_since(UNIX_EPOCH).unwrap_or_default();
    Timestamp {
        seconds: i64::try_from(since.as_secs()).unwrap_or(i64::MAX),
        nanos: i32::try_from(since.subsec_nanos()).unwrap_or(0),
    }
}

fn duration_seconds(duration: Option<&ProtoDuration>) -> Option<i64> {
    duration.map(|value| value.seconds)
}

fn proto_seconds(seconds: i64) -> ProtoDuration {
    ProtoDuration { seconds, nanos: 0 }
}

/// RFC 3339 with milliseconds (`2026-09-18T14:44:35.258Z`), as the
/// emulator stamps push envelopes and dead-letter attributes.
#[must_use]
pub fn rfc3339_millis(time: SystemTime) -> String {
    let since = time.duration_since(UNIX_EPOCH).unwrap_or_default();
    let datetime =
        time::OffsetDateTime::from_unix_timestamp(i64::try_from(since.as_secs()).unwrap_or(0))
            .unwrap_or(time::OffsetDateTime::UNIX_EPOCH);
    let base = datetime
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default();
    format!(
        "{}.{:03}Z",
        base.trim_end_matches('Z'),
        since.subsec_millis()
    )
}

/// Visit counters that prove the cost model in tests.
#[cfg(test)]
pub(crate) mod visits {
    use std::cell::Cell;

    #[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
    pub(crate) struct Visits {
        /// Leases and pushes the tick looked at.
        pub(crate) tick: u64,
        /// Available entries a pull looked at.
        pub(crate) take: u64,
        /// Ack-id lookups.
        pub(crate) ack_lookups: u64,
        /// Walks over a subscription's whole message map.
        pub(crate) map_walks: u64,
        /// Acknowledged copies kept because another subscription holds the message.
        pub(crate) kept_for_peers: u64,
        /// Acknowledged copies kept by a snapshot.
        pub(crate) kept_for_snapshots: u64,
        /// Peers' copies reconsidered after the last holder let go.
        pub(crate) released: u64,
        /// Retained acknowledgements pruned by age or cap.
        pub(crate) pruned: u64,
    }

    thread_local! {
        static VISITS: Cell<Visits> = Cell::new(Visits::default());
    }

    /// The counters since the last call, reset.
    pub(crate) fn take() -> Visits {
        VISITS.replace(Visits::default())
    }

    pub(crate) fn bump(change: impl FnOnce(&mut Visits)) {
        let mut visits = VISITS.get();
        change(&mut visits);
        VISITS.set(visits);
    }
}

macro_rules! visit {
    ($field:ident) => {
        #[cfg(test)]
        crate::broker::visits::bump(|visits| visits.$field += 1);
    };
}

impl Broker {
    #[must_use]
    pub fn new() -> Self {
        Self::with_limits(HistoryLimits::default())
    }

    pub(crate) fn with_limits(limits: HistoryLimits) -> Self {
        let (changed, _) = watch::channel(0);
        Self {
            inner: Arc::new(Inner {
                state: Mutex::new(State {
                    topics: BTreeMap::new(),
                    subscriptions: BTreeMap::new(),
                    snapshots: BTreeMap::new(),
                    schemas: BTreeMap::new(),
                    generations: HashMap::new(),
                    slots: HashMap::new(),
                    next_slot: 1,
                    next_message_id: 1,
                    next_ack: 1,
                    next_generation: 1,
                    revision_counter: 0,
                    history_bytes: 0,
                    limits,
                    next_slow_tick: Instant::now() + SLOW_TICK,
                }),
                changed,
                in_flight: Mutex::new(HashMap::new()),
            }),
        }
    }

    /// A receiver that wakes when the backlog of any subscription changes.
    #[must_use]
    pub fn watch(&self) -> watch::Receiver<u64> {
        self.inner.changed.subscribe()
    }

    fn notify(&self) {
        self.inner.changed.send_modify(|version| *version += 1);
    }

    // ------------------------------------------------------------ topics

    pub fn create_topic(&self, request: Topic) -> Result<Topic, PubsubError> {
        names::parse("topics", &request.name)?;
        let mut state = lock(&self.inner.state);
        if state.topics.contains_key(&request.name) {
            return Err(PubsubError::already_exists("Topic already exists"));
        }
        if let Some(seconds) = duration_seconds(request.message_retention_duration.as_ref())
            && !(MIN_RETENTION_SECONDS..=MAX_RETENTION_SECONDS).contains(&seconds)
        {
            return Err(PubsubError::invalid_argument(
                "message_retention_duration out of bounds",
            ));
        }
        let mut topic = Topic {
            name: request.name.clone(),
            labels: request.labels,
            message_storage_policy: request.message_storage_policy,
            kms_key_name: request.kms_key_name,
            schema_settings: None,
            message_retention_duration: request.message_retention_duration,
            ..Topic::default()
        };
        let schema = match request.schema_settings {
            Some(settings) => {
                let (settings, bound) = state.bind_schema(settings)?;
                topic.schema_settings = Some(settings);
                Some(bound)
            }
            None => None,
        };
        let generation = state.next_generation;
        state.next_generation += 1;
        state.topics.insert(
            request.name,
            TopicEntry {
                topic: topic.clone(),
                generation,
                history: VecDeque::new(),
                history_bytes: 0,
                history_dropped: 0,
                ordering_keys: VecDeque::new(),
                attribute_keys: BTreeSet::new(),
                schema,
            },
        );
        state.generations.insert(generation, Generation::default());
        Ok(topic)
    }

    pub fn get_topic(&self, name: &str) -> Result<Topic, PubsubError> {
        names::parse("topics", name)?;
        let state = lock(&self.inner.state);
        state
            .topics
            .get(name)
            .map(|entry| entry.topic.clone())
            .ok_or_else(|| PubsubError::not_found("Topic not found"))
    }

    pub fn list_topics(
        &self,
        project: &str,
        page_size: i32,
        page_token: &str,
    ) -> Result<(Vec<Topic>, String), PubsubError> {
        let project = names::parse_project("topics", project)
            .map_err(|_| PubsubError::application_error())?;
        let prefix = format!("projects/{project}/topics/");
        let state = lock(&self.inner.state);
        let names: Vec<&String> = state
            .topics
            .keys()
            .filter(|name| name.starts_with(&prefix))
            .collect();
        let (page, next) = paginate(&names, page_size, page_token);
        Ok((
            page.iter()
                .filter_map(|name| state.topics.get(*name).map(|entry| entry.topic.clone()))
                .collect(),
            next,
        ))
    }

    pub fn update_topic(
        &self,
        topic: Option<Topic>,
        paths: &[String],
    ) -> Result<Topic, PubsubError> {
        if paths.is_empty() {
            return Err(PubsubError::invalid_argument(
                "The update_mask in the UpdateTopicRequest must be set, and must contain a non-empty paths list.",
            ));
        }
        for path in paths {
            if path != "schema_settings" && path != "message_retention_duration" {
                return Err(PubsubError::invalid_argument(format!(
                    "Invalid update_mask provided in the UpdateTopicRequest: {path} is not a known Topic field. Note that field paths must be of the form 'schema_settings' rather than 'schemaSetings'."
                )));
            }
        }
        let update = topic.unwrap_or_default();
        names::parse("topics", &update.name)?;
        let mut state = lock(&self.inner.state);
        if !state.topics.contains_key(&update.name) {
            return Err(PubsubError::not_found("Topic not found."));
        }
        let mut bound: Option<Option<BoundSchema>> = None;
        let mut settings: Option<Option<SchemaSettings>> = None;
        for path in paths {
            if path == "schema_settings" {
                let requested = update.schema_settings.clone().unwrap_or_default();
                if requested.schema.is_empty() {
                    return Err(PubsubError::invalid_argument("No schema name provided"));
                }
                let (resolved, schema) = state.bind_schema(requested)?;
                settings = Some(Some(resolved));
                bound = Some(Some(schema));
            } else if let Some(seconds) =
                duration_seconds(update.message_retention_duration.as_ref())
                && !(MIN_RETENTION_SECONDS..=MAX_RETENTION_SECONDS).contains(&seconds)
            {
                return Err(PubsubError::invalid_argument(
                    "message_retention_duration out of bounds",
                ));
            }
        }
        let limits = state.limits;
        let State {
            topics,
            history_bytes,
            ..
        } = &mut *state;
        let entry = topics
            .get_mut(&update.name)
            .ok_or_else(|| PubsubError::not_found("Topic not found."))?;
        for path in paths {
            if path == "message_retention_duration" {
                entry.topic.message_retention_duration = update.message_retention_duration;
            }
        }
        if let Some(settings) = settings {
            entry.topic.schema_settings = settings;
        }
        if let Some(bound) = bound {
            entry.schema = bound;
        }
        // A topic that lost its retention keeps only what a topic without
        // one keeps.
        entry.trim(history_bytes, &limits);
        Ok(entry.topic.clone())
    }

    pub fn delete_topic(&self, name: &str) -> Result<(), PubsubError> {
        names::parse("topics", name)?;
        let mut state = lock(&self.inner.state);
        let Some(entry) = state.topics.remove(name) else {
            return Err(PubsubError::not_found("Topic not found"));
        };
        state.history_bytes -= entry.history_bytes;
        for subscription in state.subscriptions.values_mut() {
            if subscription.topic_generation == entry.generation {
                subscription.topic_deleted = true;
                DELETED_TOPIC.clone_into(&mut subscription.subscription.topic);
            }
        }
        state.forget_generation_if_unused(entry.generation);
        Ok(())
    }

    pub fn list_topic_subscriptions(
        &self,
        topic: &str,
        page_size: i32,
        page_token: &str,
    ) -> Result<(Vec<String>, String), PubsubError> {
        names::parse("topics", topic)?;
        let state = lock(&self.inner.state);
        let generation = state.topics.get(topic).map(|entry| entry.generation);
        // Detached subscriptions are not listed under their topic.
        let names: Vec<&String> = state
            .subscriptions
            .iter()
            .filter(|(_, entry)| {
                !entry.topic_deleted
                    && !entry.subscription.detached
                    && Some(entry.topic_generation) == generation
            })
            .map(|(name, _)| name)
            .collect();
        let (page, next) = paginate(&names, page_size, page_token);
        Ok((page.iter().map(|name| (*name).clone()).collect(), next))
    }

    pub fn list_topic_snapshots(
        &self,
        topic: &str,
        page_size: i32,
        page_token: &str,
    ) -> Result<(Vec<String>, String), PubsubError> {
        names::parse("topics", topic)?;
        let state = lock(&self.inner.state);
        let generation = state.topics.get(topic).map(|entry| entry.generation);
        let names: Vec<&String> = state
            .snapshots
            .iter()
            .filter(|(_, entry)| generation == Some(entry.topic_generation))
            .map(|(name, _)| name)
            .collect();
        let (page, next) = paginate(&names, page_size, page_token);
        Ok((page.iter().map(|name| (*name).clone()).collect(), next))
    }

    // ------------------------------------------------------------ publish

    /// Publishes `messages` and returns their ids plus the stored messages for
    /// function delivery.
    pub fn publish(
        &self,
        topic: &str,
        messages: Vec<PubsubMessage>,
    ) -> Result<(Vec<String>, Published), PubsubError> {
        names::parse("topics", topic)?;
        let mut state = lock(&self.inner.state);
        if !state.topics.contains_key(topic) {
            return Err(PubsubError::not_found("Topic not found"));
        }
        if messages.is_empty() {
            return Err(PubsubError::invalid_argument("No messages to publish"));
        }
        if messages
            .iter()
            .any(|message| message.data.is_empty() && message.attributes.is_empty())
        {
            return Err(PubsubError::invalid_argument("Some messages are empty"));
        }
        let schema = state
            .topics
            .get(topic)
            .and_then(|entry| entry.schema.clone());
        let mut prepared = Vec::with_capacity(messages.len());
        for mut message in messages {
            if let Some(bound) = &schema {
                if bound.deleted {
                    return Err(PubsubError::not_found(
                        "Schema associated with topic deleted.",
                    ));
                }
                let checked = match bound.encoding {
                    Encoding::Binary => avro::validate_binary(&bound.parsed, &message.data),
                    _ => avro::validate_json(&bound.parsed, &message.data),
                };
                checked.map_err(|_| PubsubError::invalid_argument("Could not parse message"))?;
                let schema_name = state
                    .topics
                    .get(topic)
                    .and_then(|entry| entry.topic.schema_settings.as_ref())
                    .map(|settings| settings.schema.clone())
                    .unwrap_or_default();
                message.attributes.insert(
                    "googclient_schemaencoding".to_owned(),
                    match bound.encoding {
                        Encoding::Binary => "BINARY".to_owned(),
                        _ => "JSON".to_owned(),
                    },
                );
                message
                    .attributes
                    .insert("googclient_schemaname".to_owned(), schema_name);
                message.attributes.insert(
                    "googclient_schemarevisionid".to_owned(),
                    bound.revision_id.clone(),
                );
            }
            prepared.push(message);
        }
        let now = SystemTime::now();
        let instant = Instant::now();
        let mut ids = Vec::with_capacity(prepared.len());
        let mut stored = Vec::with_capacity(prepared.len());
        for mut message in prepared {
            let id = state.next_message_id;
            state.next_message_id += 1;
            message.message_id = id.to_string();
            message.publish_time = Some(timestamp(now));
            let size = message_size(&message);
            let record = Arc::new(StoredMessage {
                id,
                message,
                published: instant,
                published_at: now,
                size,
            });
            ids.push(id.to_string());
            stored.push(record);
        }
        state.deliver(topic, &stored);
        drop(state);
        self.notify();
        Ok((
            ids,
            Published {
                topic: topic.to_owned(),
                messages: stored,
            },
        ))
    }

    // ------------------------------------------------------------ subscriptions

    pub fn create_subscription(&self, request: Subscription) -> Result<Subscription, PubsubError> {
        names::parse("subscriptions", &request.name)?;
        names::parse("topics", &request.topic)?;
        let mut state = lock(&self.inner.state);
        let Some(generation) = state
            .topics
            .get(&request.topic)
            .map(|entry| entry.generation)
        else {
            return Err(PubsubError::not_found("Subscription topic does not exist"));
        };
        if state.subscriptions.contains_key(&request.name) {
            return Err(PubsubError::already_exists("Subscription already exists"));
        }
        let subscription = state.validated_subscription(request)?;
        let filter = match subscription.filter.as_str() {
            "" => None,
            text => Some(Filter::parse(text)?),
        };
        let now = Instant::now();
        state.add_subscription(&subscription, generation, filter);
        // A topic with its own retention seeds the new subscription with the
        // messages its history ring still holds inside the window.
        let seeds: Vec<Arc<StoredMessage>> = state
            .topics
            .get(&subscription.topic)
            .and_then(|topic| {
                duration_seconds(topic.topic.message_retention_duration.as_ref()).map(|retention| {
                    let window = Duration::from_secs(u64::try_from(retention).unwrap_or(0));
                    topic
                        .history
                        .iter()
                        .filter(|entry| now.duration_since(entry.message.published) <= window)
                        .map(|entry| Arc::clone(&entry.message))
                        .collect()
                })
            })
            .unwrap_or_default();
        if !seeds.is_empty() {
            state.with_subscription(&subscription.name, |ctx| {
                for message in seeds {
                    ctx.track(message, now);
                }
            });
        }
        drop(state);
        self.notify();
        Ok(subscription)
    }

    pub fn get_subscription(&self, name: &str) -> Result<Subscription, PubsubError> {
        names::parse("subscriptions", name)?;
        let state = lock(&self.inner.state);
        state
            .subscriptions
            .get(name)
            .map(|entry| entry.subscription.clone())
            .ok_or_else(|| PubsubError::not_found("Subscription does not exist"))
    }

    pub fn list_subscriptions(
        &self,
        project: &str,
        page_size: i32,
        page_token: &str,
    ) -> Result<(Vec<Subscription>, String), PubsubError> {
        let project = names::parse_project("subscriptions", project)
            .map_err(|_| PubsubError::application_error())?;
        let prefix = format!("projects/{project}/subscriptions/");
        let state = lock(&self.inner.state);
        let names: Vec<&String> = state
            .subscriptions
            .keys()
            .filter(|name| name.starts_with(&prefix))
            .collect();
        let (page, next) = paginate(&names, page_size, page_token);
        Ok((
            page.iter()
                .filter_map(|name| {
                    state
                        .subscriptions
                        .get(*name)
                        .map(|entry| entry.subscription.clone())
                })
                .collect(),
            next,
        ))
    }

    pub fn update_subscription(
        &self,
        subscription: Option<Subscription>,
        paths: &[String],
    ) -> Result<Subscription, PubsubError> {
        if paths.is_empty() {
            return Err(PubsubError::invalid_argument(
                "The update_mask in the UpdateSubscriptionRequest must be set, and must contain a non-empty paths list.",
            ));
        }
        for path in paths {
            match path.as_str() {
                "ack_deadline_seconds"
                | "push_config"
                | "retain_acked_messages"
                | "message_retention_duration"
                | "dead_letter_policy"
                | "retry_policy"
                | "enable_exactly_once_delivery" => {}
                "topic" | "enable_message_ordering" | "detached" => {
                    return Err(PubsubError::invalid_argument(format!(
                        "Invalid update_mask provided in the UpdateSubscriptionRequest: the {path} field in the Subscription is not mutable."
                    )));
                }
                "filter" | "expiration_policy" => {
                    return Err(PubsubError::invalid_argument(format!(
                        "Updating the {path} field is currently unsupported in the Pub/Sub Emulator."
                    )));
                }
                _ => {
                    return Err(PubsubError::invalid_argument(format!(
                        "Invalid update_mask provided in the UpdateSubscriptionRequest: {path} is not a known Subscription field. Note that field paths must be of the form 'push_config' rather than 'pushConfig'."
                    )));
                }
            }
        }
        let update = subscription.unwrap_or_default();
        names::parse("subscriptions", &update.name)?;
        let mut state = lock(&self.inner.state);
        if !state.subscriptions.contains_key(&update.name) {
            return Err(PubsubError::not_found("Subscription not found."));
        }
        let mut current = state
            .subscriptions
            .get(&update.name)
            .map(|entry| entry.subscription.clone())
            .ok_or_else(|| PubsubError::not_found("Subscription not found."))?;
        for path in paths {
            match path.as_str() {
                "ack_deadline_seconds" => {
                    current.ack_deadline_seconds = update.ack_deadline_seconds;
                }
                "push_config" => current.push_config.clone_from(&update.push_config),
                "retain_acked_messages" => {
                    current.retain_acked_messages = update.retain_acked_messages;
                }
                "message_retention_duration" => {
                    current.message_retention_duration = update.message_retention_duration;
                }
                "dead_letter_policy" => {
                    current
                        .dead_letter_policy
                        .clone_from(&update.dead_letter_policy);
                }
                "retry_policy" => current.retry_policy = update.retry_policy,
                "enable_exactly_once_delivery" => {
                    current.enable_exactly_once_delivery = update.enable_exactly_once_delivery;
                }
                _ => {}
            }
        }
        let validated = state.validated_subscription(current)?;
        let now = Instant::now();
        state.with_subscription(&validated.name, |ctx| {
            let was_push = ctx.entry.is_push();
            let was_retaining = ctx.entry.subscription.retain_acked_messages;
            ctx.entry.subscription = validated.clone();
            ctx.switch_delivery(was_push, now);
            if was_retaining && !validated.retain_acked_messages {
                // Retention was what kept these; whatever nothing else keeps goes.
                let acked: Vec<u64> = ctx.entry.index.acked.iter().copied().collect();
                for id in acked {
                    ctx.reconsider(id);
                }
            }
        });
        drop(state);
        self.notify();
        Ok(validated)
    }

    pub fn delete_subscription(&self, name: &str) -> Result<(), PubsubError> {
        names::parse("subscriptions", name)?;
        let mut state = lock(&self.inner.state);
        if !state.remove_subscription(name) {
            return Err(PubsubError::not_found("Subscription does not exist"));
        }
        drop(state);
        lock(&self.inner.in_flight).remove(name);
        self.notify();
        Ok(())
    }

    pub fn modify_push_config(
        &self,
        name: &str,
        config: Option<PushConfig>,
    ) -> Result<(), PubsubError> {
        names::parse("subscriptions", name)?;
        let mut state = lock(&self.inner.state);
        if !state.subscriptions.contains_key(name) {
            return Err(PubsubError::not_found("Subscription does not exist"));
        }
        let config = config.unwrap_or_default();
        validate_push_config(&config)?;
        let now = Instant::now();
        state.with_subscription(name, |ctx| {
            let was_push = ctx.entry.is_push();
            ctx.entry.subscription.push_config = Some(config);
            ctx.switch_delivery(was_push, now);
        });
        drop(state);
        self.notify();
        Ok(())
    }

    // ------------------------------------------------------------ pull and ack

    /// Takes up to `max_messages` deliverable messages, or `None` when the
    /// subscription has nothing to deliver right now.
    pub fn pull(&self, name: &str, max_messages: i32) -> Result<Vec<ReceivedMessage>, PubsubError> {
        names::parse("subscriptions", name)?;
        let mut state = lock(&self.inner.state);
        let next_ack = state.next_ack;
        let entry = state
            .subscriptions
            .get(name)
            .ok_or_else(|| PubsubError::not_found("Subscription does not exist"))?;
        if entry.subscription.detached {
            return Err(PubsubError::failed_precondition(
                "Subscription is detached.",
            ));
        }
        let now = Instant::now();
        let (received, used) = state
            .with_subscription(name, |ctx| ctx.take(max_messages, next_ack, now))
            .unwrap_or_default();
        state.next_ack += used;
        if received.is_empty() {
            return Ok(received);
        }
        drop(state);
        self.notify();
        Ok(received)
    }

    /// Whether `name` exists (for long polls that wait before failing).
    pub fn subscription_check(&self, name: &str) -> Result<(), PubsubError> {
        names::parse("subscriptions", name)?;
        let state = lock(&self.inner.state);
        let entry = state
            .subscriptions
            .get(name)
            .ok_or_else(|| PubsubError::not_found("Subscription does not exist"))?;
        if entry.subscription.detached {
            return Err(PubsubError::failed_precondition(
                "Subscription is detached.",
            ));
        }
        Ok(())
    }

    pub fn acknowledge(&self, name: &str, ack_ids: &[String]) -> Result<(), PubsubError> {
        names::parse("subscriptions", name)?;
        let mut state = lock(&self.inner.state);
        if !state.subscriptions.contains_key(name) {
            return Err(PubsubError::not_found("Subscription does not exist"));
        }
        if ack_ids.is_empty() {
            return Err(PubsubError::invalid_argument("No ack ids specified."));
        }
        let parsed = parse_ack_ids(name, ack_ids)?;
        let refused = state
            .with_subscription(name, |ctx| {
                let exactly_once = ctx.entry.subscription.enable_exactly_once_delivery;
                let mut any_stale = false;
                for ack in parsed {
                    match ctx.find_lease(ack) {
                        Some(id) => ctx.acknowledge(id),
                        None => any_stale = true,
                    }
                }
                exactly_once && any_stale
            })
            .unwrap_or_default();
        if refused {
            return Err(PubsubError::invalid_argument(""));
        }
        drop(state);
        self.notify();
        Ok(())
    }

    pub fn modify_ack_deadline(
        &self,
        name: &str,
        ack_ids: &[String],
        seconds: i32,
    ) -> Result<(), PubsubError> {
        names::parse("subscriptions", name)?;
        let mut state = lock(&self.inner.state);
        if !state.subscriptions.contains_key(name) {
            return Err(PubsubError::not_found("Subscription does not exist"));
        }
        if ack_ids.is_empty() {
            return Err(PubsubError::invalid_argument("No ack ids specified"));
        }
        if seconds < 0 {
            return Err(PubsubError::invalid_argument(
                "Ack deadline cannot be negative",
            ));
        }
        let parsed = parse_ack_ids(name, ack_ids)?;
        let now = Instant::now();
        state.with_subscription(name, |ctx| {
            for ack in parsed {
                if let Some(id) = ctx.find_lease(ack) {
                    ctx.modify_deadline(id, seconds, now);
                }
            }
        });
        drop(state);
        self.notify();
        Ok(())
    }

    /// Expires leases and returns the pushes that are due; run on a timer.
    #[must_use]
    pub fn tick(&self) -> Vec<PushJob> {
        self.tick_at(Instant::now())
    }

    /// [`Broker::tick`] at `now`: visits only the leases and pushes that are
    /// due, and once a second prunes retention windows and retained
    /// acknowledgements.
    pub(crate) fn tick_at(&self, now: Instant) -> Vec<PushJob> {
        let mut state = lock(&self.inner.state);
        let due_until = (now, u64::MAX);
        let due: Vec<String> = state
            .subscriptions
            .iter()
            .filter(|(_, entry)| {
                entry
                    .index
                    .leases
                    .first()
                    .is_some_and(|first| *first <= due_until)
                    || (entry.is_push()
                        && entry
                            .index
                            .push_due
                            .first()
                            .is_some_and(|first| *first <= due_until))
            })
            .map(|(name, _)| name.clone())
            .collect();
        let mut jobs = Vec::new();
        let mut changed = false;
        {
            let mut flights = lock(&self.inner.in_flight);
            for name in &due {
                state.with_subscription(name, |ctx| {
                    let expired: Vec<u64> = ctx
                        .entry
                        .index
                        .leases
                        .range(..=due_until)
                        .map(|(_, id)| *id)
                        .collect();
                    for id in expired {
                        visit!(tick);
                        ctx.modify_deadline(id, 0, now);
                        changed = true;
                    }
                    if !ctx.entry.is_push() {
                        return;
                    }
                    let endpoint = ctx
                        .entry
                        .subscription
                        .push_config
                        .as_ref()
                        .map(|config| config.push_endpoint.clone())
                        .unwrap_or_default();
                    let pushes: Vec<u64> = ctx
                        .entry
                        .index
                        .push_due
                        .range(..=due_until)
                        .map(|(_, id)| *id)
                        .collect();
                    let flying = flights.entry(name.clone()).or_default();
                    for id in pushes {
                        visit!(tick);
                        if flying.contains(&id) {
                            continue;
                        }
                        let Some(tracked) = ctx.entry.messages.get(&id) else {
                            continue;
                        };
                        jobs.push(PushJob {
                            subscription: name.clone(),
                            message_id: id,
                            endpoint: endpoint.clone(),
                            // Push config attributes are stored, not sent as headers.
                            headers: BTreeMap::new(),
                            body: push_envelope(name, &tracked.message),
                        });
                        flying.insert(id);
                        ctx.set_next_push(id, now + PUSH_IN_FLIGHT);
                    }
                    if flying.is_empty() {
                        flights.remove(name);
                    }
                });
            }
        }
        if now >= state.next_slow_tick {
            state.next_slow_tick = now + SLOW_TICK;
            state.prune(now);
        }
        drop(state);
        if changed {
            self.notify();
        }
        jobs
    }

    /// Records the outcome of a push attempt.
    pub fn push_finished(&self, job: &PushJob, delivered: bool) {
        {
            let mut flights = lock(&self.inner.in_flight);
            if let Some(flying) = flights.get_mut(&job.subscription) {
                flying.remove(&job.message_id);
                if flying.is_empty() {
                    flights.remove(&job.subscription);
                }
            }
        }
        let mut state = lock(&self.inner.state);
        let now = Instant::now();
        state.with_subscription(&job.subscription, |ctx| {
            let pushing = ctx
                .entry
                .messages
                .get(&job.message_id)
                .is_some_and(|tracked| matches!(tracked.state, MessageState::Pushing { .. }));
            if !pushing {
                return;
            }
            if delivered {
                ctx.acknowledge(job.message_id);
            } else {
                ctx.set_next_push(job.message_id, now + PUSH_RETRY);
            }
        });
        drop(state);
        self.notify();
    }

    // ------------------------------------------------------------ seek and snapshots

    pub fn seek_to_time(&self, name: &str, time: &Timestamp) -> Result<(), PubsubError> {
        names::parse("subscriptions", name)?;
        let mut state = lock(&self.inner.state);
        if !state.subscriptions.contains_key(name) {
            return Err(PubsubError::not_found("Subscription does not exist"));
        }
        let target = UNIX_EPOCH
            + Duration::from_secs(u64::try_from(time.seconds).unwrap_or(0))
            + Duration::from_nanos(u64::try_from(time.nanos).unwrap_or(0));
        let now = Instant::now();
        state.with_subscription(name, |ctx| {
            visit!(map_walks);
            // Acknowledged messages come back only with `retainAckedMessages`;
            // everything published before the target counts as acknowledged.
            let retain = ctx.entry.subscription.retain_acked_messages;
            let plan: Vec<(u64, bool, bool)> = ctx
                .entry
                .messages
                .values()
                .map(|tracked| {
                    (
                        tracked.message.id,
                        tracked.message.published_at >= target,
                        tracked.unacked(),
                    )
                })
                .collect();
            for (id, after, unacked) in plan {
                if after {
                    if !unacked && !retain {
                        continue;
                    }
                    ctx.revive(id, now);
                } else {
                    ctx.acknowledge(id);
                }
            }
        });
        drop(state);
        self.notify();
        Ok(())
    }

    pub fn seek_to_snapshot(&self, name: &str, snapshot: &str) -> Result<(), PubsubError> {
        names::parse("subscriptions", name)?;
        let mut state = lock(&self.inner.state);
        if !state.subscriptions.contains_key(name) {
            return Err(PubsubError::not_found("Subscription does not exist"));
        }
        names::parse("snapshots", snapshot)?;
        let Some(snap) = state.snapshots.get(snapshot) else {
            return Err(PubsubError::not_found("Snapshot does not exist"));
        };
        let unacked = snap.unacked.clone();
        let created = snap.created;
        let snapshot_generation = snap.topic_generation;
        let snapshot_topic = snap.snapshot.topic.clone();
        let entry = state
            .subscriptions
            .get(name)
            .ok_or_else(|| PubsubError::not_found("Subscription does not exist"))?;
        if entry.topic_deleted || entry.topic_generation != snapshot_generation {
            let subscription_topic = entry.subscription.topic.clone();
            return Err(PubsubError::failed_precondition(format!(
                "The subscription's topic {subscription_topic} is different from that of the snapshot {snapshot_topic}; they must match in order for Seek work. Note that if a topic is deleted and then re-created with the same name, it is considered a distinct topic for these purposes."
            )));
        }
        let now = Instant::now();
        // The snapshot decides the acknowledgement state of the messages the
        // subscription itself tracks; it does not add messages it never had.
        state.with_subscription(name, |ctx| {
            visit!(map_walks);
            let plan: Vec<(u64, bool)> = ctx
                .entry
                .messages
                .values()
                .map(|tracked| {
                    (
                        tracked.message.id,
                        unacked.contains(&tracked.message.id)
                            || tracked.message.published > created,
                    )
                })
                .collect();
            for (id, wanted) in plan {
                if wanted {
                    ctx.revive(id, now);
                } else {
                    ctx.acknowledge(id);
                }
            }
        });
        drop(state);
        self.notify();
        Ok(())
    }

    pub fn create_snapshot(
        &self,
        name: &str,
        subscription: &str,
        labels: BTreeMap<String, String>,
    ) -> Result<Snapshot, PubsubError> {
        names::parse("snapshots", name)?;
        let mut state = lock(&self.inner.state);
        let Some(entry) = state.subscriptions.get(subscription) else {
            return Err(PubsubError::not_found("Subscription does not exist"));
        };
        if state.snapshots.contains_key(name) {
            return Err(PubsubError::already_exists("Snapshot already exists"));
        }
        let generation = entry.topic_generation;
        let unacked = entry.index.unacked.clone();
        let now = SystemTime::now();
        // Labels are accepted and dropped, as the official emulator does.
        drop(labels);
        let snapshot = Snapshot {
            name: name.to_owned(),
            topic: entry.original_topic.clone(),
            expire_time: Some(timestamp(now + SNAPSHOT_TTL)),
            labels: BTreeMap::new(),
        };
        state.snapshots.insert(
            name.to_owned(),
            SnapshotEntry {
                snapshot: snapshot.clone(),
                topic_generation: generation,
                unacked,
                created: Instant::now(),
            },
        );
        if let Some(generation) = state.generations.get_mut(&generation) {
            generation.snapshots += 1;
        }
        Ok(snapshot)
    }

    pub fn get_snapshot(&self, name: &str) -> Result<Snapshot, PubsubError> {
        names::parse("snapshots", name)?;
        let state = lock(&self.inner.state);
        state
            .snapshots
            .get(name)
            .map(|entry| entry.snapshot.clone())
            .ok_or_else(|| PubsubError::not_found("Snapshot does not exist"))
    }

    pub fn list_snapshots(
        &self,
        project: &str,
        page_size: i32,
        page_token: &str,
    ) -> Result<(Vec<Snapshot>, String), PubsubError> {
        let project = names::parse_project("snapshots", project)
            .map_err(|_| PubsubError::application_error())?;
        let prefix = format!("projects/{project}/snapshots/");
        let state = lock(&self.inner.state);
        let names: Vec<&String> = state
            .snapshots
            .keys()
            .filter(|name| name.starts_with(&prefix))
            .collect();
        let (page, next) = paginate(&names, page_size, page_token);
        Ok((
            page.iter()
                .filter_map(|name| {
                    state
                        .snapshots
                        .get(*name)
                        .map(|entry| entry.snapshot.clone())
                })
                .collect(),
            next,
        ))
    }

    pub fn delete_snapshot(&self, name: &str) -> Result<(), PubsubError> {
        names::parse("snapshots", name)?;
        let mut state = lock(&self.inner.state);
        let Some(snapshot) = state.snapshots.remove(name) else {
            return Err(PubsubError::not_found("Snapshot does not exist"));
        };
        state.snapshot_removed(snapshot.topic_generation);
        Ok(())
    }

    // ------------------------------------------------------------ schemas

    pub fn create_schema(
        &self,
        parent: &str,
        schema_id: &str,
        schema: Option<Schema>,
    ) -> Result<Schema, PubsubError> {
        let name = format!("{parent}/schemas/{schema_id}");
        names::parse("schemas", &name)?;
        let schema = schema.unwrap_or_default();
        let parsed = parse_schema(&schema)?;
        let mut state = lock(&self.inner.state);
        if state.schemas.contains_key(&name) {
            return Err(PubsubError::already_exists("Schema already exists"));
        }
        let revision = state.new_revision(&schema.definition, parsed);
        let output = revision_view(&name, &revision, SchemaView::Full);
        state.schemas.insert(
            name.clone(),
            SchemaEntry {
                name,
                revisions: vec![revision],
            },
        );
        Ok(output)
    }

    pub fn get_schema(&self, name: &str, view: SchemaView) -> Result<Schema, PubsubError> {
        let (base, revision) = names::split_revision(name);
        names::parse("schemas", base)?;
        let state = lock(&self.inner.state);
        let entry = state
            .schemas
            .get(base)
            .ok_or_else(|| PubsubError::not_found("Schema not found"))?;
        let found = match revision {
            Some(id) => entry
                .revisions
                .iter()
                .find(|candidate| candidate.id == id)
                .ok_or_else(|| PubsubError::not_found("Schema revision not found"))?,
            None => entry
                .revisions
                .last()
                .ok_or_else(|| PubsubError::not_found("Schema not found"))?,
        };
        Ok(revision_view(&entry.name, found, view))
    }

    pub fn list_schemas(
        &self,
        parent: &str,
        view: SchemaView,
        page_size: i32,
        page_token: &str,
    ) -> Result<(Vec<Schema>, String), PubsubError> {
        let project = names::parse_project("schemas", parent)
            .map_err(|_| PubsubError::application_error())?;
        let prefix = format!("projects/{project}/schemas/");
        let state = lock(&self.inner.state);
        let names: Vec<&String> = state
            .schemas
            .keys()
            .filter(|name| name.starts_with(&prefix))
            .collect();
        let (page, next) = paginate(&names, page_size, page_token);
        Ok((
            page.iter()
                .filter_map(|name| state.schemas.get(*name))
                .filter_map(|entry| {
                    entry
                        .revisions
                        .last()
                        .map(|latest| revision_view(&entry.name, latest, view))
                })
                .collect(),
            next,
        ))
    }

    pub fn list_schema_revisions(
        &self,
        name: &str,
        view: SchemaView,
        page_size: i32,
        page_token: &str,
    ) -> Result<(Vec<Schema>, String), PubsubError> {
        let (base, _) = names::split_revision(name);
        names::parse("schemas", base)?;
        let state = lock(&self.inner.state);
        let entry = state
            .schemas
            .get(base)
            .ok_or_else(|| PubsubError::not_found("Schema not found"))?;
        let all: Vec<&Revision> = entry.revisions.iter().collect();
        let start = if page_token.is_empty() {
            0
        } else {
            all.iter()
                .position(|revision| rfc3339_nanos(revision.created_at) == page_token)
                .unwrap_or(0)
        };
        let size = if page_size > 0 {
            usize::try_from(page_size).unwrap_or(usize::MAX)
        } else {
            usize::MAX
        };
        let end = start.saturating_add(size).min(all.len());
        let next = if end < all.len() {
            rfc3339_nanos(all[end].created_at)
        } else {
            String::new()
        };
        Ok((
            all[start..end]
                .iter()
                .map(|revision| revision_view(&entry.name, revision, view))
                .collect(),
            next,
        ))
    }

    pub fn commit_schema(&self, name: &str, schema: Option<Schema>) -> Result<Schema, PubsubError> {
        let (base, _) = names::split_revision(name);
        names::parse("schemas", base)?;
        let schema = schema.unwrap_or_default();
        let parsed = parse_schema(&schema)?;
        let mut state = lock(&self.inner.state);
        if !state.schemas.contains_key(base) {
            return Err(PubsubError::not_found("Schema not found"));
        }
        let revision = state.new_revision(&schema.definition, parsed);
        let entry = state
            .schemas
            .get_mut(base)
            .ok_or_else(|| PubsubError::not_found("Schema not found"))?;
        entry.revisions.push(revision.clone());
        Ok(revision_view(&entry.name, &revision, SchemaView::Full))
    }

    pub fn rollback_schema(&self, name: &str, revision_id: &str) -> Result<Schema, PubsubError> {
        let (base, _) = names::split_revision(name);
        names::parse("schemas", base)?;
        let mut state = lock(&self.inner.state);
        let Some(entry) = state.schemas.get(base) else {
            return Err(PubsubError::not_found("Schema not found"));
        };
        let Some(source) = entry
            .revisions
            .iter()
            .find(|revision| revision.id == revision_id)
            .cloned()
        else {
            return Err(PubsubError::not_found("Revision not found"));
        };
        let revision = state.new_revision(&source.definition, Arc::clone(&source.parsed));
        let entry = state
            .schemas
            .get_mut(base)
            .ok_or_else(|| PubsubError::not_found("Schema not found"))?;
        entry.revisions.push(revision.clone());
        Ok(revision_view(&entry.name, &revision, SchemaView::Full))
    }

    pub fn delete_schema_revision(&self, name: &str) -> Result<Schema, PubsubError> {
        let (base, revision) = names::split_revision(name);
        names::parse("schemas", base)?;
        let mut state = lock(&self.inner.state);
        let entry = state
            .schemas
            .get_mut(base)
            .ok_or_else(|| PubsubError::not_found("Schema not found"))?;
        let Some(index) = revision.and_then(|id| {
            entry
                .revisions
                .iter()
                .position(|candidate| candidate.id == id)
        }) else {
            return Err(PubsubError::not_found("Schema revision not found"));
        };
        if entry.revisions.len() == 1 {
            return Err(PubsubError::invalid_argument(
                "Cannot delete last revision. Please use DeleteSchema.",
            ));
        }
        let removed = entry.revisions.remove(index);
        Ok(revision_view(&entry.name, &removed, SchemaView::Full))
    }

    pub fn delete_schema(&self, name: &str) -> Result<(), PubsubError> {
        let (base, _) = names::split_revision(name);
        names::parse("schemas", base)?;
        let mut state = lock(&self.inner.state);
        if state.schemas.remove(base).is_none() {
            return Err(PubsubError::not_found("Schema not found"));
        }
        for topic in state.topics.values_mut() {
            if let Some(settings) = topic.topic.schema_settings.as_mut()
                && settings.schema == base
            {
                DELETED_SCHEMA.clone_into(&mut settings.schema);
                if let Some(bound) = topic.schema.as_mut() {
                    bound.deleted = true;
                }
            }
        }
        Ok(())
    }

    pub fn validate_schema(&self, schema: Option<Schema>) -> Result<(), PubsubError> {
        parse_schema(&schema.unwrap_or_default()).map(|_| ())
    }

    pub fn validate_message(
        &self,
        name: Option<&str>,
        schema: Option<Schema>,
        message: &[u8],
        encoding: Encoding,
    ) -> Result<(), PubsubError> {
        let parsed = match (name, schema) {
            (Some(name), _) if !name.is_empty() => {
                let (base, revision) = names::split_revision(name);
                names::parse("schemas", base)?;
                let state = lock(&self.inner.state);
                let entry = state
                    .schemas
                    .get(base)
                    .ok_or_else(|| PubsubError::not_found("Schema not found"))?;
                let found = match revision {
                    Some(id) => entry
                        .revisions
                        .iter()
                        .find(|candidate| candidate.id == id)
                        .ok_or_else(|| PubsubError::not_found("Schema revision not found"))?,
                    None => entry
                        .revisions
                        .last()
                        .ok_or_else(|| PubsubError::not_found("Schema not found"))?,
                };
                Arc::clone(&found.parsed)
            }
            (_, schema) => parse_schema(&schema.unwrap_or_default())?,
        };
        match encoding {
            Encoding::Json => avro::validate_json(&parsed, message),
            Encoding::Binary => avro::validate_binary(&parsed, message),
            Encoding::Unspecified => Err(PubsubError::invalid_argument("No encoding provided.")),
        }
    }

    /// Pulls and acknowledges everything on `name` (the functions consumer).
    pub fn drain(&self, name: &str) {
        let mut state = lock(&self.inner.state);
        state.with_subscription(name, |ctx| {
            visit!(map_walks);
            let ids: Vec<u64> = ctx.entry.messages.keys().copied().collect();
            for id in ids {
                ctx.remove(id, Outcome::Drained);
            }
        });
    }

    /// Creates the topic when it does not exist yet (function targets).
    pub fn ensure_topic(&self, name: &str) {
        let _ = self.create_topic(Topic {
            name: name.to_owned(),
            ..Topic::default()
        });
    }
}

// ---------------------------------------------------------------- state helpers

impl State {
    fn deliver(&mut self, topic: &str, messages: &[Arc<StoredMessage>]) {
        let limits = self.limits;
        let Self {
            topics,
            generations,
            history_bytes,
            ..
        } = self;
        let Some(entry) = topics.get_mut(topic) else {
            return;
        };
        entry.append(messages, history_bytes, &limits);
        let members: Vec<String> = generations
            .get(&entry.generation)
            .map(|generation| generation.members.iter().cloned().collect())
            .unwrap_or_default();
        let now = Instant::now();
        for name in &members {
            self.with_subscription(name, |ctx| {
                if ctx.entry.topic_deleted {
                    return;
                }
                for message in messages {
                    ctx.track(Arc::clone(message), now);
                }
            });
        }
        self.enforce_history_cap();
    }

    fn forward_dead_letters(&mut self, forwarded: Vec<(String, Arc<StoredMessage>, u32)>) {
        for (subscription, message, attempts) in forwarded {
            let Some(policy) = self
                .subscriptions
                .get(&subscription)
                .and_then(|entry| entry.subscription.dead_letter_policy.clone())
            else {
                continue;
            };
            if !self.topics.contains_key(&policy.dead_letter_topic) {
                continue;
            }
            let parsed = names::parse("subscriptions", &subscription).ok();
            let mut copy = message.message.clone();
            copy.attributes.insert(
                "CloudPubSubDeadLetterSourceDeliveryCount".to_owned(),
                attempts.to_string(),
            );
            copy.attributes.insert(
                "CloudPubSubDeadLetterSourceSubscription".to_owned(),
                parsed
                    .as_ref()
                    .map(|name| name.id.clone())
                    .unwrap_or_default(),
            );
            copy.attributes.insert(
                "CloudPubSubDeadLetterSourceSubscriptionProject".to_owned(),
                parsed
                    .as_ref()
                    .map(|name| name.project.clone())
                    .unwrap_or_default(),
            );
            copy.attributes.insert(
                "CloudPubSubDeadLetterSourceTopicPublishTime".to_owned(),
                rfc3339_millis(message.published_at),
            );
            let id = self.next_message_id;
            self.next_message_id += 1;
            copy.message_id = id.to_string();
            let now = SystemTime::now();
            copy.publish_time = Some(timestamp(now));
            let size = message_size(&copy);
            let stored = Arc::new(StoredMessage {
                id,
                message: copy,
                published: Instant::now(),
                published_at: now,
                size,
            });
            self.deliver(&policy.dead_letter_topic, &[stored]);
        }
    }

    /// Stores a new subscription on `generation` and gives it a slot; from
    /// the second subscription of a generation on, who holds what is counted.
    fn add_subscription(
        &mut self,
        subscription: &Subscription,
        generation: u64,
        filter: Option<Filter>,
    ) {
        let mut slot = self.next_slot;
        while slot == 0 || self.slots.contains_key(&slot) {
            slot = slot.wrapping_add(1);
        }
        self.next_slot = slot.wrapping_add(1);
        let name = subscription.name.clone();
        self.subscriptions.insert(
            name.clone(),
            SubscriptionEntry {
                subscription: subscription.clone(),
                topic_generation: generation,
                original_topic: subscription.topic.clone(),
                topic_deleted: false,
                filter,
                messages: BTreeMap::new(),
                index: Index::default(),
                acked_total: 0,
                dead_lettered_total: 0,
                created_at: SystemTime::now(),
                slot,
            },
        );
        self.slots.insert(slot, name.clone());
        let Self {
            generations,
            subscriptions,
            ..
        } = self;
        let generation = generations.entry(generation).or_default();
        if generation.members.len() == 1
            && let Some(existing) = generation
                .members
                .first()
                .and_then(|member| subscriptions.get(member))
        {
            for id in &existing.index.unacked {
                generation.holders.entry(*id).or_default().unacked += 1;
            }
        }
        generation.members.insert(name);
    }

    /// Removes a subscription, letting go of everything it held.
    fn remove_subscription(&mut self, name: &str) -> bool {
        if self.with_subscription(name, leave).is_none() {
            return false;
        }
        let Some(entry) = self.subscriptions.remove(name) else {
            return false;
        };
        self.slots.remove(&entry.slot);
        if let Some(generation) = self.generations.get_mut(&entry.topic_generation) {
            generation.members.remove(name);
            if !generation.shared() {
                generation.holders.clear();
            }
        }
        self.forget_generation_if_unused(entry.topic_generation);
        true
    }

    /// A deleted snapshot no longer keeps what it listed or predates.
    fn snapshot_removed(&mut self, generation: u64) {
        let members: Vec<String> = match self.generations.get_mut(&generation) {
            Some(entry) => {
                entry.snapshots = entry.snapshots.saturating_sub(1);
                entry.members.iter().cloned().collect()
            }
            None => return,
        };
        for name in &members {
            self.with_subscription(name, |ctx| {
                let acked: Vec<u64> = ctx.entry.index.acked.iter().copied().collect();
                for id in acked {
                    ctx.reconsider(id);
                }
            });
        }
        self.forget_generation_if_unused(generation);
    }

    fn forget_generation_if_unused(&mut self, generation: u64) {
        let unused = self
            .generations
            .get(&generation)
            .is_some_and(|entry| entry.members.is_empty() && entry.snapshots == 0);
        if unused
            && !self
                .topics
                .values()
                .any(|topic| topic.generation == generation)
        {
            self.generations.remove(&generation);
        }
    }

    /// Runs `work` on one subscription's transitions, then applies what they
    /// caused elsewhere: history outcomes, peers' acknowledged copies nothing
    /// keeps any more, and dead letters.
    fn with_subscription<R>(
        &mut self,
        name: &str,
        work: impl FnOnce(&mut Ctx<'_>) -> R,
    ) -> Option<R> {
        let (result, applied) = {
            let Self {
                subscriptions,
                generations,
                snapshots,
                ..
            } = self;
            let entry = subscriptions.get_mut(name)?;
            let generation = entry.topic_generation;
            let slot = entry.slot;
            let mut ctx = Ctx {
                name,
                entry,
                generation: generations.get_mut(&generation),
                snapshots,
                effects: Effects::default(),
            };
            let result = work(&mut ctx);
            let effects = ctx.effects;
            let topic = (!effects.outcomes.is_empty() && !ctx.entry.topic_deleted)
                .then(|| ctx.entry.subscription.topic.clone());
            (
                result,
                Applied {
                    effects,
                    generation,
                    slot,
                    topic,
                },
            )
        };
        self.apply(applied);
        Some(result)
    }

    /// What a subscription's transitions caused elsewhere: history outcomes,
    /// peers' acknowledged copies nothing keeps any more, and dead letters.
    fn apply(&mut self, applied: Applied) {
        let Applied {
            effects,
            generation,
            slot,
            topic,
        } = applied;
        if let Some(topic) = topic {
            self.write_outcomes(&topic, generation, slot, &effects.outcomes);
        }
        for (id, slots) in effects.released {
            for slot in slots {
                if let Some(peer) = self.slots.get(&slot).cloned() {
                    self.reconsider_copy(&peer, id);
                }
            }
        }
        if !effects.forwarded.is_empty() {
            self.forward_dead_letters(effects.forwarded);
        }
    }

    fn reconsider_copy(&mut self, name: &str, id: u64) {
        visit!(released);
        self.with_subscription(name, |ctx| ctx.reconsider(id));
    }

    fn write_outcomes(
        &mut self,
        topic: &str,
        generation: u64,
        slot: u32,
        outcomes: &[(u64, Outcome)],
    ) {
        let Self {
            topics,
            history_bytes,
            ..
        } = self;
        let Some(entry) = topics.get_mut(topic) else {
            return;
        };
        if entry.generation != generation {
            return;
        }
        for (id, outcome) in outcomes {
            if let Ok(position) = entry
                .history
                .binary_search_by_key(id, |history| history.message.id)
            {
                lock(&entry.history[position].outcomes).push((slot, *outcome));
                entry.history_bytes += OUTCOME_BYTES;
                *history_bytes += OUTCOME_BYTES;
            }
        }
    }

    /// Keeps every ring together under the global cap: first from topics
    /// without retention (the one holding the most bytes, never below the
    /// floor), then from topics with retention.
    fn enforce_history_cap(&mut self) {
        let limits = self.limits;
        for with_retention in [false, true] {
            while self.history_bytes > limits.total_bytes {
                let mut largest: Option<(&String, u64)> = None;
                let mut runner_up = 0;
                for (name, topic) in &self.topics {
                    if topic.has_retention() != with_retention
                        || topic.history.len() <= limits.floor
                    {
                        continue;
                    }
                    match largest {
                        Some((_, bytes)) if topic.history_bytes <= bytes => {
                            runner_up = runner_up.max(topic.history_bytes);
                        }
                        _ => {
                            if let Some((_, bytes)) = largest {
                                runner_up = runner_up.max(bytes);
                            }
                            largest = Some((name, topic.history_bytes));
                        }
                    }
                }
                let Some((name, _)) = largest else {
                    break;
                };
                let name = name.clone();
                let Self {
                    topics,
                    history_bytes,
                    ..
                } = self;
                let Some(topic) = topics.get_mut(&name) else {
                    break;
                };
                while *history_bytes > limits.total_bytes && topic.history.len() > limits.floor {
                    topic.pop_oldest(history_bytes);
                    if topic.history_bytes < runner_up {
                        break;
                    }
                }
            }
        }
    }

    /// The once-a-second pass: retention topics keep only their window, and
    /// retained acknowledgements expire with their subscription's retention
    /// (and past the cap, oldest first).
    fn prune(&mut self, now: Instant) {
        let Self {
            topics,
            history_bytes,
            ..
        } = self;
        for topic in topics.values_mut() {
            if let Some(window) = topic.retention() {
                while topic.history.front().is_some_and(|entry| {
                    now.saturating_duration_since(entry.message.published) > window
                }) {
                    topic.pop_oldest(history_bytes);
                }
            }
        }
        let cap = self.limits.retained_acked;
        let retaining: Vec<String> = self
            .subscriptions
            .iter()
            .filter(|(_, entry)| {
                entry.subscription.retain_acked_messages && entry.index.counts.acked > 0
            })
            .map(|(name, _)| name.clone())
            .collect();
        for name in &retaining {
            self.with_subscription(name, |ctx| ctx.prune_retained(now, cap));
        }
    }

    fn bind_schema(
        &self,
        settings: SchemaSettings,
    ) -> Result<(SchemaSettings, BoundSchema), PubsubError> {
        let Some(entry) = names::parse("schemas", &settings.schema)
            .ok()
            .and_then(|_| self.schemas.get(&settings.schema))
        else {
            return Err(PubsubError::not_found("Schema could not be found"));
        };
        let encoding = match Encoding::try_from(settings.encoding) {
            Ok(Encoding::Json) => Encoding::Json,
            Ok(Encoding::Binary) => Encoding::Binary,
            _ => {
                return Err(PubsubError::invalid_argument(
                    "Invalid schema encoding provided",
                ));
            }
        };
        if !settings.first_revision_id.is_empty()
            && !entry
                .revisions
                .iter()
                .any(|revision| revision.id == settings.first_revision_id)
        {
            return Err(PubsubError::not_found("First revision could not be found"));
        }
        let revision = if settings.last_revision_id.is_empty() {
            entry
                .revisions
                .last()
                .ok_or_else(|| PubsubError::not_found("Schema could not be found"))?
        } else {
            entry
                .revisions
                .iter()
                .find(|revision| revision.id == settings.last_revision_id)
                .ok_or_else(|| PubsubError::not_found("Last revision could not be found"))?
        };
        Ok((
            settings,
            BoundSchema {
                revision_id: revision.id.clone(),
                parsed: Arc::clone(&revision.parsed),
                encoding,
                deleted: false,
            },
        ))
    }

    fn new_revision(&mut self, definition: &str, parsed: Arc<AvroSchema>) -> Revision {
        self.revision_counter += 1;
        let mut digest = Sha256::new();
        digest.update(definition.as_bytes());
        digest.update(self.revision_counter.to_le_bytes());
        digest.update(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
                .to_le_bytes(),
        );
        let bytes = digest.finalize();
        Revision {
            id: format!(
                "{:02x}{:02x}{:02x}{:02x}",
                bytes[0], bytes[1], bytes[2], bytes[3]
            ),
            definition: definition.to_owned(),
            created_at: SystemTime::now(),
            parsed,
        }
    }

    /// Applies defaults and bounds to a subscription about to be stored.
    fn validated_subscription(
        &self,
        mut subscription: Subscription,
    ) -> Result<Subscription, PubsubError> {
        if subscription.ack_deadline_seconds == 0 {
            subscription.ack_deadline_seconds = DEFAULT_ACK_DEADLINE;
        }
        if !(0..=600).contains(&subscription.ack_deadline_seconds) {
            return Err(PubsubError::invalid_argument(
                "ack_deadline_secs out of bounds",
            ));
        }
        match duration_seconds(subscription.message_retention_duration.as_ref()) {
            None => {
                subscription.message_retention_duration =
                    Some(proto_seconds(DEFAULT_RETENTION_SECONDS));
            }
            Some(seconds)
                if !(MIN_RETENTION_SECONDS..=MAX_RETENTION_SECONDS).contains(&seconds) =>
            {
                return Err(PubsubError::invalid_argument(
                    "message_retention_duration out of bounds",
                ));
            }
            Some(_) => {}
        }
        if let Some(policy) = subscription.dead_letter_policy.as_mut() {
            if names::parse("topics", &policy.dead_letter_topic).is_err()
                || !self.topics.contains_key(&policy.dead_letter_topic)
            {
                return Err(PubsubError::not_found("Dead letter topic not found"));
            }
            if policy.max_delivery_attempts == 0 {
                policy.max_delivery_attempts = 5;
            }
            if policy.max_delivery_attempts < 5 {
                return Err(PubsubError::out_of_range(format!(
                    "The value for max_delivery_attempts is too small. You passed {} in the request, but the minimum value is 5.",
                    policy.max_delivery_attempts
                )));
            }
            if policy.max_delivery_attempts > 100 {
                return Err(PubsubError::out_of_range(format!(
                    "The value for max_delivery_attempts is too large. You passed {} in the request, but the maximum value is 100.",
                    policy.max_delivery_attempts
                )));
            }
        }
        if let Some(policy) = subscription.retry_policy.as_mut() {
            if policy.minimum_backoff.is_none() {
                policy.minimum_backoff = Some(proto_seconds(10));
            }
            if policy.maximum_backoff.is_none() {
                policy.maximum_backoff = Some(proto_seconds(600));
            }
            let minimum = policy.minimum_backoff.unwrap_or_default();
            let maximum = policy.maximum_backoff.unwrap_or_default();
            if (maximum.seconds, maximum.nanos) < (minimum.seconds, minimum.nanos) {
                return Err(PubsubError::invalid_argument(format!(
                    "The value for maximum_backoff is too small. You passed {} in the request, but the minimum value is {}.",
                    duration_text(&maximum),
                    duration_text(&minimum)
                )));
            }
        }
        let config = subscription.push_config.take().unwrap_or_default();
        validate_push_config(&config)?;
        subscription.push_config = Some(config);
        // Fields the emulator never reports.
        subscription.bigquery_config = None;
        subscription.cloud_storage_config = None;
        subscription.bigtable_config = None;
        Ok(subscription)
    }
}

fn duration_text(duration: &ProtoDuration) -> String {
    if duration.nanos == 0 {
        format!("{}s", duration.seconds)
    } else {
        format!("{}.{:09}s", duration.seconds, duration.nanos)
    }
    .replace(".000000000s", "s")
}

fn validate_push_config(config: &PushConfig) -> Result<(), PubsubError> {
    if config.push_endpoint.is_empty() {
        return Ok(());
    }
    let allowed =
        config.push_endpoint.starts_with("http://") || config.push_endpoint.starts_with("https://");
    if !allowed || url::Url::parse(&config.push_endpoint).is_err() {
        return Err(PubsubError::invalid_argument("Unsupported push_endpoint"));
    }
    Ok(())
}

fn parse_schema(schema: &Schema) -> Result<Arc<AvroSchema>, PubsubError> {
    match crate::google::pubsub::v1::schema::Type::try_from(schema.r#type) {
        Ok(crate::google::pubsub::v1::schema::Type::Avro) => {}
        Ok(crate::google::pubsub::v1::schema::Type::ProtocolBuffer) => {
            return Err(PubsubError::unimplemented(
                "Protocol buffer support not implemented in emulator",
            ));
        }
        _ => return Err(PubsubError::invalid_argument("Invalid schema type")),
    }
    Ok(Arc::new(avro::parse_definition(&schema.definition)?))
}

fn revision_view(name: &str, revision: &Revision, view: SchemaView) -> Schema {
    Schema {
        name: name.to_owned(),
        r#type: crate::google::pubsub::v1::schema::Type::Avro as i32,
        definition: if view == SchemaView::Basic {
            String::new()
        } else {
            revision.definition.clone()
        },
        revision_id: revision.id.clone(),
        revision_create_time: Some(timestamp(revision.created_at)),
        configuration: None,
    }
}

fn rfc3339_nanos(time: SystemTime) -> String {
    let since = time.duration_since(UNIX_EPOCH).unwrap_or_default();
    let datetime =
        time::OffsetDateTime::from_unix_timestamp(i64::try_from(since.as_secs()).unwrap_or(0))
            .unwrap_or(time::OffsetDateTime::UNIX_EPOCH);
    let base = datetime
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default();
    format!(
        "{}.{:09}Z",
        base.trim_end_matches('Z'),
        since.subsec_nanos()
    )
}

/// Pages a sorted name list by `page_size` from `page_token` (the first
/// name of the page, or the start when unknown), returning the next token.
fn paginate<'a>(
    names: &[&'a String],
    page_size: i32,
    page_token: &str,
) -> (Vec<&'a String>, String) {
    let start = if page_token.is_empty() {
        0
    } else {
        names
            .iter()
            .position(|name| name.as_str() == page_token)
            .unwrap_or(0)
    };
    let size = if page_size > 0 {
        usize::try_from(page_size).unwrap_or(usize::MAX)
    } else {
        usize::MAX
    };
    let end = start.saturating_add(size).min(names.len());
    let next = if end < names.len() {
        names[end].clone()
    } else {
        String::new()
    };
    (names[start..end].to_vec(), next)
}

fn parse_ack_ids(subscription: &str, ack_ids: &[String]) -> Result<Vec<u64>, PubsubError> {
    let mut parsed = Vec::with_capacity(ack_ids.len());
    for ack_id in ack_ids {
        let Some((owner, sequence)) = ack_id.rsplit_once(':') else {
            return Err(PubsubError::invalid_argument(format!(
                "Invalid ack id (ack_id={ack_id})"
            )));
        };
        let Ok(sequence) = sequence.parse::<u64>() else {
            return Err(PubsubError::invalid_argument(format!(
                "Invalid ack id (ack_id={ack_id})"
            )));
        };
        if owner != subscription {
            return Err(PubsubError::invalid_argument(format!(
                "Subscription {subscription} received an invalid ack ID {ack_id}, meant for subscription: {owner}"
            )));
        }
        parsed.push(sequence);
    }
    Ok(parsed)
}

/// The push envelope as the official emulator serializes it.
#[must_use]
pub fn push_envelope(subscription: &str, message: &StoredMessage) -> String {
    let time = message
        .message
        .publish_time
        .as_ref()
        .map(|stamp| {
            rfc3339_millis(
                UNIX_EPOCH
                    + Duration::from_secs(u64::try_from(stamp.seconds).unwrap_or(0))
                    + Duration::from_nanos(u64::try_from(stamp.nanos).unwrap_or(0)),
            )
        })
        .unwrap_or_default();
    let data = base64::Engine::encode(
        &base64::engine::general_purpose::STANDARD,
        &message.message.data,
    );
    let attributes =
        serde_json::to_string(&message.message.attributes).unwrap_or_else(|_| "{}".to_owned());
    format!(
        "{{\"subscription\":{},\"message\":{{\"publishTime\":{},\"data\":{},\"publish_time\":{},\"messageId\":{},\"attributes\":{},\"message_id\":{}}}}}",
        json_string(subscription),
        json_string(&time),
        json_string(&data),
        json_string(&time),
        json_string(&message.message.message_id),
        attributes.replace('/', "\\/"),
        json_string(&message.message.message_id),
    )
}

fn json_string(text: &str) -> String {
    serde_json::to_string(text)
        .unwrap_or_default()
        .replace('/', "\\/")
}

// ---------------------------------------------------------------- history

impl TopicEntry {
    fn retention(&self) -> Option<Duration> {
        duration_seconds(self.topic.message_retention_duration.as_ref())
            .map(|seconds| Duration::from_secs(u64::try_from(seconds).unwrap_or(0)))
    }

    fn has_retention(&self) -> bool {
        self.topic.message_retention_duration.is_some()
    }

    /// The messages and bytes this topic's ring keeps.
    fn capacity(&self, limits: &HistoryLimits) -> (usize, u64) {
        if self.has_retention() {
            (limits.retention_messages, limits.retention_bytes)
        } else {
            (limits.messages, limits.bytes)
        }
    }

    fn append(&mut self, messages: &[Arc<StoredMessage>], total: &mut u64, limits: &HistoryLimits) {
        for message in messages {
            self.remember_keys(&message.message);
            let bytes = u64::from(message.size);
            self.history_bytes += bytes;
            *total += bytes;
            self.history
                .push_back(Arc::new(HistoryEntry::new(Arc::clone(message))));
        }
        self.trim(total, limits);
    }

    /// Drops the oldest entries past the topic's caps; the newest message
    /// stays whatever its size.
    fn trim(&mut self, total: &mut u64, limits: &HistoryLimits) {
        let (messages, bytes) = self.capacity(limits);
        while self.history.len() > messages
            || (self.history_bytes > bytes && self.history.len() > 1)
        {
            self.pop_oldest(total);
        }
    }

    fn pop_oldest(&mut self, total: &mut u64) {
        if let Some(entry) = self.history.pop_front() {
            let bytes = entry.bytes();
            self.history_bytes = self.history_bytes.saturating_sub(bytes);
            *total = total.saturating_sub(bytes);
            self.history_dropped += 1;
        }
    }

    fn remember_keys(&mut self, message: &PubsubMessage) {
        let key = &message.ordering_key;
        if !key.is_empty() && self.ordering_keys.back() != Some(key) {
            if let Some(position) = self.ordering_keys.iter().position(|seen| seen == key) {
                self.ordering_keys.remove(position);
            }
            self.ordering_keys.push_back(key.clone());
            if self.ordering_keys.len() > SEEN_ORDERING_KEYS {
                self.ordering_keys.pop_front();
            }
        }
        for name in message.attributes.keys() {
            if self.attribute_keys.len() >= SEEN_ATTRIBUTE_KEYS {
                break;
            }
            if !self.attribute_keys.contains(name) {
                self.attribute_keys.insert(name.clone());
            }
        }
    }
}

impl Broker {
    /// What `topic`'s history ring holds and can hold.
    #[must_use]
    pub fn history_window(&self, topic: &str) -> Option<HistoryWindow> {
        let state = lock(&self.inner.state);
        let entry = state.topics.get(topic)?;
        let (messages, bytes) = entry.capacity(&state.limits);
        Some(HistoryWindow {
            messages: u32::try_from(entry.history.len()).unwrap_or(u32::MAX),
            bytes: entry.history_bytes,
            oldest_id: entry.history.front().map(|history| history.message.id),
            capacity_messages: u32::try_from(messages).unwrap_or(u32::MAX),
            capacity_bytes: bytes,
            dropped: entry.history_dropped,
        })
    }

    /// The ordering keys and attribute names seen on `topic`.
    #[must_use]
    pub fn seen_keys(&self, topic: &str) -> Option<SeenKeys> {
        let state = lock(&self.inner.state);
        let entry = state.topics.get(topic)?;
        Some(SeenKeys {
            ordering_keys: entry.ordering_keys.iter().rev().cloned().collect(),
            attribute_keys: entry.attribute_keys.iter().cloned().collect(),
        })
    }

    /// A subscription's figures, from the counts every transition keeps.
    #[must_use]
    pub fn subscription_counts(&self, name: &str) -> Option<SubscriptionCounts> {
        let state = lock(&self.inner.state);
        state.subscriptions.get(name).map(SubscriptionEntry::counts)
    }

    /// What became of message `id` of `topic` at each of the topic's
    /// subscriptions, by name, while the topic's history ring holds it.
    #[must_use]
    pub fn message_marks(&self, topic: &str, id: u64) -> Option<Vec<(String, MessageMark)>> {
        let state = lock(&self.inner.state);
        let entry = state.topics.get(topic)?;
        let position = entry
            .history
            .binary_search_by_key(&id, |history| history.message.id)
            .ok()?;
        let history = &entry.history[position];
        let outcomes = history.outcomes();
        let generation = state.generations.get(&entry.generation)?;
        Some(
            generation
                .members
                .iter()
                .filter_map(|name| {
                    let subscription = state.subscriptions.get(name)?;
                    Some((name.clone(), subscription.mark(&history.message, &outcomes)))
                })
                .collect(),
        )
    }
}

impl SubscriptionEntry {
    /// This subscription's mark for a message of its topic: its own tracking
    /// while it holds the message, then the outcome it recorded, then why it
    /// never had it.
    fn mark(&self, message: &StoredMessage, outcomes: &[(u32, Outcome)]) -> MessageMark {
        if let Some(tracked) = self.messages.get(&message.id) {
            return match tracked.state {
                MessageState::Available => MessageMark::Available,
                MessageState::Leased { .. } => MessageMark::Outstanding,
                MessageState::Pushing { .. } => MessageMark::Pushing,
                MessageState::Acked => MessageMark::Acked,
            };
        }
        if let Some((_, outcome)) = outcomes.iter().rev().find(|(slot, _)| *slot == self.slot) {
            return match outcome {
                Outcome::Acked => MessageMark::Acked,
                Outcome::DeadLettered => MessageMark::DeadLettered,
                Outcome::Drained => MessageMark::Drained,
            };
        }
        if self.created_at > message.published_at {
            return MessageMark::NotTracked;
        }
        if self
            .filter
            .as_ref()
            .is_some_and(|filter| !filter.matches(&message.message.attributes))
        {
            return MessageMark::Filtered;
        }
        MessageMark::NotTracked
    }
}

// ---------------------------------------------------------------- transitions

/// What one subscription's transitions caused elsewhere, applied by
/// [`State::with_subscription`] once the subscription is let go of.
#[derive(Default)]
struct Effects {
    /// Messages whose last unacknowledged holder let go, with the slots of
    /// the subscriptions that kept an acknowledged copy only for it.
    released: Vec<(u64, Vec<u32>)>,
    /// History outcomes of this subscription.
    outcomes: Vec<(u64, Outcome)>,
    /// Dead-lettered messages to forward: (source subscription, message, attempts).
    forwarded: Vec<(String, Arc<StoredMessage>, u32)>,
}

/// [`Effects`] with what they need to be applied.
struct Applied {
    effects: Effects,
    generation: u64,
    slot: u32,
    topic: Option<String>,
}

/// One subscription's transitions, with the generation's holder counts and
/// the snapshots that decide what an acknowledgement may drop.
struct Ctx<'a> {
    name: &'a str,
    entry: &'a mut SubscriptionEntry,
    generation: Option<&'a mut Generation>,
    snapshots: &'a BTreeMap<String, SnapshotEntry>,
    effects: Effects,
}

impl Ctx<'_> {
    /// Starts tracking a published message, unless the filter refuses it.
    fn track(&mut self, message: Arc<StoredMessage>, now: Instant) {
        if let Some(filter) = &self.entry.filter
            && !filter.matches(&message.message.attributes)
        {
            return;
        }
        let id = message.id;
        if self.entry.messages.contains_key(&id) {
            return;
        }
        let state = if self.entry.is_push() {
            MessageState::Pushing { next_attempt: now }
        } else {
            MessageState::Available
        };
        self.entry.insert(Tracked {
            sequence: id,
            message,
            state,
            attempts: 0,
        });
        self.hold(id);
    }

    fn find_lease(&self, ack: u64) -> Option<u64> {
        visit!(ack_lookups);
        self.entry.index.acks.get(&ack).copied()
    }

    /// Delivers available messages in delivery order: unordered ones as they
    /// come, ordered ones only while no earlier message of the same key is
    /// outstanding.
    fn take(
        &mut self,
        max_messages: i32,
        first_ack: u64,
        now: Instant,
    ) -> (Vec<ReceivedMessage>, u64) {
        let limit = usize::try_from(max_messages).unwrap_or(0);
        let ordered = self.entry.subscription.enable_message_ordering;
        let mut chosen = Vec::new();
        for &(_, id) in &self.entry.index.available {
            if chosen.len() >= limit {
                break;
            }
            visit!(take);
            if ordered
                && let Some(tracked) = self.entry.messages.get(&id)
                && !tracked.message.message.ordering_key.is_empty()
                && self
                    .entry
                    .index
                    .leased_keys
                    .contains_key(&tracked.message.message.ordering_key)
            {
                continue;
            }
            chosen.push(id);
        }
        let deadline = now
            + Duration::from_secs(
                u64::try_from(self.entry.subscription.ack_deadline_seconds).unwrap_or(10),
            );
        let dead_letter = self.entry.subscription.dead_letter_policy.is_some();
        let mut received = Vec::with_capacity(chosen.len());
        let mut used = 0;
        for id in chosen {
            let ack = first_ack + used;
            used += 1;
            self.entry.update(id, |tracked| {
                tracked.attempts += 1;
                tracked.state = MessageState::Leased { ack, deadline };
            });
            let Some(tracked) = self.entry.messages.get(&id) else {
                continue;
            };
            received.push(ReceivedMessage {
                ack_id: format!("{}:{ack}", self.entry.subscription.name),
                message: Some(tracked.message.message.clone()),
                delivery_attempt: if dead_letter {
                    i32::try_from(tracked.attempts).unwrap_or(i32::MAX)
                } else {
                    0
                },
            });
        }
        (received, used)
    }

    /// Acknowledges a message; the copy stays only while something can
    /// bring it back: retention, a snapshot, or another subscription of the
    /// topic still holding it.
    fn acknowledge(&mut self, id: u64) {
        let Some(moved) = self
            .entry
            .update(id, |tracked| tracked.state = MessageState::Acked)
        else {
            return;
        };
        if !moved.was_unacked {
            return;
        }
        self.entry.acked_total += 1;
        let peers = self.let_go(id);
        if peers {
            visit!(kept_for_peers);
            self.keep_for_peers(id);
        } else if !self.keeps_itself(id) {
            self.entry.remove(id);
            self.effects.outcomes.push((id, Outcome::Acked));
        }
    }

    /// A nack (`0`) makes the message available again (queued behind later
    /// messages) or dead-letters it; any other value extends the lease.
    fn modify_deadline(&mut self, id: u64, seconds: i32, now: Instant) {
        let Some(tracked) = self.entry.messages.get(&id) else {
            return;
        };
        let MessageState::Leased { ack, .. } = tracked.state else {
            return;
        };
        if seconds != 0 {
            let deadline = now + Duration::from_secs(u64::try_from(seconds).unwrap_or(0));
            self.entry.update(id, |tracked| {
                tracked.state = MessageState::Leased { ack, deadline };
            });
            return;
        }
        let max_attempts = self
            .entry
            .subscription
            .dead_letter_policy
            .as_ref()
            .map(|policy| policy.max_delivery_attempts);
        if let Some(max) = max_attempts
            && i32::try_from(tracked.attempts).unwrap_or(i32::MAX) >= max
        {
            self.effects.forwarded.push((
                self.name.to_owned(),
                Arc::clone(&tracked.message),
                tracked.attempts,
            ));
            self.entry.dead_lettered_total += 1;
            self.remove(id, Outcome::DeadLettered);
            return;
        }
        let push = self.entry.is_push();
        self.entry.update(id, |tracked| {
            tracked.sequence = next_sequence();
            tracked.state = if push {
                MessageState::Pushing { next_attempt: now }
            } else {
                MessageState::Available
            };
        });
    }

    /// Makes a message deliverable again from its first attempt (seek).
    fn revive(&mut self, id: u64, now: Instant) {
        let push = self.entry.is_push();
        let Some(moved) = self.entry.update(id, |tracked| {
            tracked.state = if push {
                MessageState::Pushing { next_attempt: now }
            } else {
                MessageState::Available
            };
            tracked.attempts = 0;
        }) else {
            return;
        };
        if !moved.was_unacked && moved.is_unacked {
            self.hold(id);
        }
    }

    fn set_next_push(&mut self, id: u64, at: Instant) {
        self.entry.update(id, |tracked| {
            if let MessageState::Pushing { .. } = tracked.state {
                tracked.state = MessageState::Pushing { next_attempt: at };
            }
        });
    }

    /// After a push configuration change: a new endpoint takes the available
    /// messages, a removed one gives the pushing ones back to pulls.
    fn switch_delivery(&mut self, was_push: bool, now: Instant) {
        let is_push = self.entry.is_push();
        if is_push && !was_push {
            let ids: Vec<u64> = self
                .entry
                .index
                .available
                .iter()
                .map(|(_, id)| *id)
                .collect();
            for id in ids {
                self.entry.update(id, |tracked| {
                    tracked.state = MessageState::Pushing { next_attempt: now };
                });
            }
        } else if was_push && !is_push {
            let ids: Vec<u64> = self
                .entry
                .index
                .push_due
                .iter()
                .map(|(_, id)| *id)
                .collect();
            for id in ids {
                self.entry
                    .update(id, |tracked| tracked.state = MessageState::Available);
            }
        }
    }

    /// Removes a message the subscription lets go of, recording why.
    fn remove(&mut self, id: u64, outcome: Outcome) {
        let Some(tracked) = self.entry.remove(id) else {
            return;
        };
        if tracked.unacked() {
            self.let_go(id);
            self.effects.outcomes.push((id, outcome));
        } else {
            self.forget_peer_copy(id);
            self.effects.outcomes.push((id, Outcome::Acked));
        }
    }

    /// An acknowledged copy whose reason to stay may have gone: kept while
    /// another subscription holds the message, retention or a snapshot keeps
    /// it; dropped otherwise.
    fn reconsider(&mut self, id: u64) {
        if self.entry.messages.get(&id).is_none_or(Tracked::unacked) {
            return;
        }
        if self.peers_hold(id) {
            self.keep_for_peers(id);
        } else if !self.keeps_itself(id) {
            self.drop_acked(id);
        }
    }

    fn drop_acked(&mut self, id: u64) {
        if self.entry.remove(id).is_some() {
            self.forget_peer_copy(id);
            self.effects.outcomes.push((id, Outcome::Acked));
        }
    }

    /// Drops retained acknowledgements older than the subscription's
    /// retention, then the oldest past `cap`.
    fn prune_retained(&mut self, now: Instant, cap: usize) {
        let retention =
            duration_seconds(self.entry.subscription.message_retention_duration.as_ref())
                .map_or(Duration::from_hours(168), |seconds| {
                    Duration::from_secs(u64::try_from(seconds).unwrap_or(0))
                });
        let mut expired = Vec::new();
        for id in &self.entry.index.acked {
            let Some(tracked) = self.entry.messages.get(id) else {
                continue;
            };
            if now.saturating_duration_since(tracked.message.published) <= retention {
                break;
            }
            expired.push(*id);
        }
        let over = self
            .entry
            .index
            .acked
            .len()
            .saturating_sub(expired.len())
            .saturating_sub(cap);
        let skip = expired.len();
        expired.extend(self.entry.index.acked.iter().skip(skip).take(over).copied());
        for id in expired {
            visit!(pruned);
            self.drop_acked(id);
        }
    }

    /// Lets go of everything before the subscription is deleted.
    fn leave(&mut self) {
        visit!(map_walks);
        let unacked: Vec<u64> = self.entry.index.unacked.iter().copied().collect();
        for id in unacked {
            self.let_go(id);
        }
        let acked: Vec<u64> = self.entry.index.acked.iter().copied().collect();
        for id in acked {
            self.forget_peer_copy(id);
        }
    }

    // ---- holders (E-PS-02)

    fn hold(&mut self, id: u64) {
        let slot = self.entry.slot;
        if let Some(generation) = self
            .generation
            .as_deref_mut()
            .filter(|entry| entry.shared())
        {
            let holders = generation.holders.entry(id).or_default();
            holders.unacked += 1;
            holders.kept_for_peers.retain(|kept| *kept != slot);
        }
    }

    /// One unacknowledged holder fewer; returns whether another subscription
    /// still holds the message unacknowledged.
    fn let_go(&mut self, id: u64) -> bool {
        let Some(generation) = self
            .generation
            .as_deref_mut()
            .filter(|entry| entry.shared())
        else {
            return false;
        };
        let Some(holders) = generation.holders.get_mut(&id) else {
            return false;
        };
        holders.unacked = holders.unacked.saturating_sub(1);
        if holders.unacked > 0 {
            return true;
        }
        if let Some(holders) = generation.holders.remove(&id)
            && !holders.kept_for_peers.is_empty()
        {
            self.effects.released.push((id, holders.kept_for_peers));
        }
        false
    }

    fn peers_hold(&self, id: u64) -> bool {
        self.generation
            .as_deref()
            .filter(|entry| entry.shared())
            .and_then(|entry| entry.holders.get(&id))
            .is_some_and(|holders| holders.unacked > 0)
    }

    fn keep_for_peers(&mut self, id: u64) {
        let slot = self.entry.slot;
        if let Some(holders) = self
            .generation
            .as_deref_mut()
            .and_then(|entry| entry.holders.get_mut(&id))
            && !holders.kept_for_peers.contains(&slot)
        {
            holders.kept_for_peers.push(slot);
        }
    }

    fn forget_peer_copy(&mut self, id: u64) {
        let slot = self.entry.slot;
        if let Some(holders) = self
            .generation
            .as_deref_mut()
            .and_then(|entry| entry.holders.get_mut(&id))
        {
            holders.kept_for_peers.retain(|kept| *kept != slot);
        }
    }

    fn keeps_itself(&self, id: u64) -> bool {
        self.entry.subscription.retain_acked_messages || self.snapshot_keeps(id)
    }

    /// Whether a snapshot of the generation would revive the message: it
    /// lists it, or it was taken before it was published.
    fn snapshot_keeps(&self, id: u64) -> bool {
        if self
            .generation
            .as_deref()
            .is_none_or(|entry| entry.snapshots == 0)
        {
            return false;
        }
        let Some(tracked) = self.entry.messages.get(&id) else {
            return false;
        };
        let generation = self.entry.topic_generation;
        let kept = self.snapshots.values().any(|snapshot| {
            snapshot.topic_generation == generation
                && (snapshot.unacked.contains(&id) || tracked.message.published > snapshot.created)
        });
        if kept {
            visit!(kept_for_snapshots);
        }
        kept
    }
}

/// [`Ctx::leave`], as a function every context lifetime fits.
fn leave(ctx: &mut Ctx<'_>) {
    ctx.leave();
}

#[cfg(test)]
impl Broker {
    /// Asserts that every count, index, holder counter and ring byte count
    /// equals what a full scan finds, and that every acknowledged copy has a
    /// reason to be kept.
    pub(crate) fn check_invariants(&self) {
        lock(&self.inner.state).check_invariants();
    }

    /// Message ids a subscription tracks, by state name, for tests.
    pub(crate) fn tracked_ids(&self, name: &str) -> BTreeMap<u64, &'static str> {
        let state = lock(&self.inner.state);
        state
            .subscriptions
            .get(name)
            .map(|entry| {
                entry
                    .messages
                    .iter()
                    .map(|(id, tracked)| {
                        let state = match tracked.state {
                            MessageState::Available => "available",
                            MessageState::Leased { .. } => "leased",
                            MessageState::Pushing { .. } => "pushing",
                            MessageState::Acked => "acked",
                        };
                        (*id, state)
                    })
                    .collect()
            })
            .unwrap_or_default()
    }
}

#[cfg(test)]
impl State {
    #[allow(clippy::too_many_lines)]
    fn check_invariants(&self) {
        assert_eq!(self.slots.len(), self.subscriptions.len(), "slots");
        for (name, entry) in &self.subscriptions {
            assert_eq!(self.slots.get(&entry.slot), Some(name), "slot of {name}");
            let mut rebuilt = Index::default();
            for (id, tracked) in &entry.messages {
                assert_eq!(*id, tracked.message.id, "key of {name}");
                rebuilt.add(*id, tracked);
            }
            assert_eq!(entry.index, rebuilt, "indexes of {name}");
            let count = |wanted: fn(&Tracked) -> bool| {
                u64::try_from(
                    entry
                        .messages
                        .values()
                        .filter(|tracked| wanted(tracked))
                        .count(),
                )
                .unwrap_or(u64::MAX)
            };
            let counts = entry.index.counts;
            assert_eq!(
                counts.available,
                count(|tracked| tracked.state == MessageState::Available),
                "available of {name}"
            );
            assert_eq!(
                counts.leased,
                count(|tracked| matches!(tracked.state, MessageState::Leased { .. })),
                "leased of {name}"
            );
            assert_eq!(
                counts.pushing,
                count(|tracked| matches!(tracked.state, MessageState::Pushing { .. })),
                "pushing of {name}"
            );
            assert_eq!(
                counts.acked,
                count(|tracked| tracked.state == MessageState::Acked),
                "acked of {name}"
            );
            assert_eq!(
                counts.redelivered,
                count(|tracked| tracked.unacked() && tracked.attempts > 1),
                "redelivered of {name}"
            );
            let bytes: u64 = entry
                .messages
                .values()
                .filter(|tracked| tracked.unacked())
                .map(|tracked| u64::from(tracked.message.size))
                .sum();
            assert_eq!(counts.unacked_bytes, bytes, "bytes of {name}");
            if let Some(filter) = &entry.filter {
                assert!(
                    entry
                        .messages
                        .values()
                        .all(|tracked| filter.matches(&tracked.message.message.attributes)),
                    "{name} tracks a message its filter refuses"
                );
            }
            let generation = self
                .generations
                .get(&entry.topic_generation)
                .expect("generation of a subscription");
            assert!(generation.members.contains(name), "membership of {name}");
            for id in &entry.index.acked {
                let tracked = &entry.messages[id];
                let retained = entry.subscription.retain_acked_messages;
                let snapshot = self.snapshots.values().any(|snapshot| {
                    snapshot.topic_generation == entry.topic_generation
                        && (snapshot.unacked.contains(id)
                            || tracked.message.published > snapshot.created)
                });
                let peers = generation.shared()
                    && generation.holders.get(id).is_some_and(|holders| {
                        holders.unacked > 0 && holders.kept_for_peers.contains(&entry.slot)
                    });
                assert!(
                    retained || snapshot || peers,
                    "{name} keeps acknowledged message {id} for no reason"
                );
            }
        }
        for (key, generation) in &self.generations {
            for member in &generation.members {
                assert!(
                    self.subscriptions
                        .get(member)
                        .is_some_and(|entry| entry.topic_generation == *key),
                    "member {member} of generation {key}"
                );
            }
            assert_eq!(
                usize::try_from(generation.snapshots).unwrap_or(usize::MAX),
                self.snapshots
                    .values()
                    .filter(|snapshot| snapshot.topic_generation == *key)
                    .count(),
                "snapshots of generation {key}"
            );
            if !generation.shared() {
                assert!(generation.holders.is_empty(), "holders of generation {key}");
                continue;
            }
            let mut expected: HashMap<u64, u32> = HashMap::new();
            for member in &generation.members {
                for id in &self.subscriptions[member].index.unacked {
                    *expected.entry(*id).or_default() += 1;
                }
            }
            assert_eq!(
                generation.holders.len(),
                expected.len(),
                "held messages of generation {key}"
            );
            for (id, holders) in &generation.holders {
                assert_eq!(
                    Some(&holders.unacked),
                    expected.get(id),
                    "holders of {id} in generation {key}"
                );
                let distinct: BTreeSet<&u32> = holders.kept_for_peers.iter().collect();
                assert_eq!(distinct.len(), holders.kept_for_peers.len(), "kept twice");
                for slot in &holders.kept_for_peers {
                    let name = &self.slots[slot];
                    assert!(generation.members.contains(name), "kept by a stranger");
                    assert!(
                        self.subscriptions[name]
                            .messages
                            .get(id)
                            .is_some_and(|tracked| !tracked.unacked()),
                        "{name} is listed as keeping {id} acknowledged"
                    );
                }
            }
        }
        let mut total = 0;
        for (name, topic) in &self.topics {
            let bytes: u64 = topic.history.iter().map(|entry| entry.bytes()).sum();
            assert_eq!(topic.history_bytes, bytes, "ring bytes of {name}");
            assert!(
                topic
                    .history
                    .iter()
                    .zip(topic.history.iter().skip(1))
                    .all(|(older, newer)| older.message.id < newer.message.id),
                "ring order of {name}"
            );
            assert!(
                topic.history.len() <= topic.capacity(&self.limits).0,
                "ring length of {name}"
            );
            total += bytes;
        }
        assert_eq!(self.history_bytes, total, "ring bytes");
    }
}

#[allow(dead_code)]
fn unused_types(_: &DeadLetterPolicy, _: &RetryPolicy, _: &ExpirationPolicy, _: Code) {}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(text: &str) -> PubsubMessage {
        PubsubMessage {
            data: text.as_bytes().to_vec(),
            ..PubsubMessage::default()
        }
    }

    #[test]
    fn publish_pull_ack_and_nack_follow_the_recording() {
        let broker = Broker::new();
        broker
            .create_topic(Topic {
                name: "projects/p/topics/orders".to_owned(),
                ..Topic::default()
            })
            .unwrap();
        let created = broker
            .create_subscription(Subscription {
                name: "projects/p/subscriptions/sub-a".to_owned(),
                topic: "projects/p/topics/orders".to_owned(),
                ..Subscription::default()
            })
            .unwrap();
        assert_eq!(created.ack_deadline_seconds, 10);
        assert_eq!(created.message_retention_duration.unwrap().seconds, 604_800);
        assert!(broker.publish("projects/p/topics/orders", vec![]).is_err());
        let (ids, _) = broker
            .publish(
                "projects/p/topics/orders",
                vec![message("one"), message("two"), message("three")],
            )
            .unwrap();
        assert_eq!(ids, vec!["1", "2", "3"]);
        let two = broker.pull("projects/p/subscriptions/sub-a", 2).unwrap();
        assert_eq!(two.len(), 2);
        assert_eq!(two[0].ack_id, "projects/p/subscriptions/sub-a:1");
        let rest = broker.pull("projects/p/subscriptions/sub-a", 10).unwrap();
        assert_eq!(rest.len(), 1);
        assert_eq!(
            broker
                .pull("projects/p/subscriptions/sub-a", 10)
                .unwrap()
                .len(),
            0
        );
        broker
            .acknowledge("projects/p/subscriptions/sub-a", &[two[0].ack_id.clone()])
            .unwrap();
        assert_eq!(
            broker
                .acknowledge("projects/p/subscriptions/sub-a", &["garbage".to_owned()])
                .unwrap_err()
                .message,
            "Invalid ack id (ack_id=garbage)"
        );
        broker
            .modify_ack_deadline(
                "projects/p/subscriptions/sub-a",
                &[rest[0].ack_id.clone()],
                0,
            )
            .unwrap();
        let redelivered = broker.pull("projects/p/subscriptions/sub-a", 10).unwrap();
        assert_eq!(redelivered.len(), 1);
        assert_eq!(redelivered[0].message.as_ref().unwrap().data, b"three");
    }
}
