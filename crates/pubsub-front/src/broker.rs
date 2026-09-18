//! The Pub/Sub broker: topics, subscriptions with a per-subscription backlog
//! (leases, ack deadlines, redelivery, dead-lettering, ordering keys,
//! filters, retention, seek and snapshots), push delivery and Avro schemas,
//! with the official emulator's validation order, error strings and
//! defaults as the recorded corpus shows them.

use std::collections::{BTreeMap, BTreeSet};
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

/// One published message, shared by every subscription that received it.
#[derive(Debug)]
pub struct StoredMessage {
    pub id: u64,
    pub message: PubsubMessage,
    pub published: Instant,
    pub published_at: SystemTime,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum MessageState {
    /// Deliverable by pull or push.
    Available,
    /// Delivered and waiting for an acknowledgement.
    Leased { ack: u64, deadline: Instant },
    /// Owned by the push loop.
    Pushing { next_attempt: Instant },
    /// Acknowledged and retained (`retainAckedMessages`).
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

#[derive(Debug)]
struct TopicEntry {
    topic: Topic,
    generation: u64,
    messages: Vec<Arc<StoredMessage>>,
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

#[derive(Debug, Default)]
struct State {
    topics: BTreeMap<String, TopicEntry>,
    subscriptions: BTreeMap<String, SubscriptionEntry>,
    snapshots: BTreeMap<String, SnapshotEntry>,
    schemas: BTreeMap<String, SchemaEntry>,
    next_message_id: u64,
    next_ack: u64,
    next_generation: u64,
    revision_counter: u64,
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
    /// Pushes currently in flight, keyed by subscription and message id.
    in_flight: Mutex<BTreeSet<(String, u64)>>,
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

impl Broker {
    #[must_use]
    pub fn new() -> Self {
        let (changed, _) = watch::channel(0);
        Self {
            inner: Arc::new(Inner {
                state: Mutex::new(State {
                    next_message_id: 1,
                    next_ack: 1,
                    next_generation: 1,
                    ..State::default()
                }),
                changed,
                in_flight: Mutex::new(BTreeSet::new()),
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
                messages: Vec::new(),
                schema,
            },
        );
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
        let entry = state
            .topics
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
        Ok(entry.topic.clone())
    }

    pub fn delete_topic(&self, name: &str) -> Result<(), PubsubError> {
        names::parse("topics", name)?;
        let mut state = lock(&self.inner.state);
        let Some(entry) = state.topics.remove(name) else {
            return Err(PubsubError::not_found("Topic not found"));
        };
        for subscription in state.subscriptions.values_mut() {
            if subscription.topic_generation == entry.generation {
                subscription.topic_deleted = true;
                DELETED_TOPIC.clone_into(&mut subscription.subscription.topic);
            }
        }
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
            let record = Arc::new(StoredMessage {
                id,
                message,
                published: instant,
                published_at: now,
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
        let mut entry = SubscriptionEntry {
            subscription: subscription.clone(),
            topic_generation: generation,
            original_topic: subscription.topic.clone(),
            topic_deleted: false,
            filter,
            messages: BTreeMap::new(),
        };
        // A topic with its own retention seeds the new subscription with the
        // messages it still holds.
        if let Some(topic) = state.topics.get(&subscription.topic)
            && let Some(retention) =
                duration_seconds(topic.topic.message_retention_duration.as_ref())
        {
            let window = Duration::from_secs(u64::try_from(retention).unwrap_or(0));
            let now = Instant::now();
            for message in &topic.messages {
                if now.duration_since(message.published) <= window {
                    entry.track(Arc::clone(message));
                }
            }
        }
        let push = !entry
            .subscription
            .push_config
            .as_ref()
            .is_none_or(|config| config.push_endpoint.is_empty());
        if push {
            entry.start_pushing();
        }
        state.subscriptions.insert(subscription.name.clone(), entry);
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
        let entry = state
            .subscriptions
            .get_mut(&validated.name)
            .ok_or_else(|| PubsubError::not_found("Subscription not found."))?;
        let was_push = entry.is_push();
        entry.subscription = validated.clone();
        let is_push = entry.is_push();
        if is_push && !was_push {
            entry.start_pushing();
        } else if was_push && !is_push {
            entry.stop_pushing();
        }
        drop(state);
        self.notify();
        Ok(validated)
    }

    pub fn delete_subscription(&self, name: &str) -> Result<(), PubsubError> {
        names::parse("subscriptions", name)?;
        let mut state = lock(&self.inner.state);
        if state.subscriptions.remove(name).is_none() {
            return Err(PubsubError::not_found("Subscription does not exist"));
        }
        drop(state);
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
        let entry = state
            .subscriptions
            .get_mut(name)
            .ok_or_else(|| PubsubError::not_found("Subscription does not exist"))?;
        let config = config.unwrap_or_default();
        validate_push_config(&config)?;
        let was_push = entry.is_push();
        entry.subscription.push_config = Some(config);
        let is_push = entry.is_push();
        if is_push && !was_push {
            entry.start_pushing();
        } else if was_push && !is_push {
            entry.stop_pushing();
        }
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
            .get_mut(name)
            .ok_or_else(|| PubsubError::not_found("Subscription does not exist"))?;
        if entry.subscription.detached {
            return Err(PubsubError::failed_precondition(
                "Subscription is detached.",
            ));
        }
        let (received, used) = entry.take(max_messages, next_ack, Instant::now());
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
        let entry = state
            .subscriptions
            .get_mut(name)
            .ok_or_else(|| PubsubError::not_found("Subscription does not exist"))?;
        let exactly_once = entry.subscription.enable_exactly_once_delivery;
        let mut forwarded = Vec::new();
        let mut any_stale = false;
        for ack in parsed {
            match entry.find_lease(ack) {
                Some(id) => entry.acknowledge(id, &mut forwarded),
                None => any_stale = true,
            }
        }
        if exactly_once && any_stale {
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
        let forwarded = {
            let entry = state
                .subscriptions
                .get_mut(name)
                .ok_or_else(|| PubsubError::not_found("Subscription does not exist"))?;
            let mut forwarded = Vec::new();
            for ack in parsed {
                if let Some(id) = entry.find_lease(ack) {
                    entry.modify_deadline(id, seconds, Instant::now(), &mut forwarded);
                }
            }
            forwarded
        };
        state.forward_dead_letters(forwarded);
        drop(state);
        self.notify();
        Ok(())
    }

    /// Expires leases and returns the pushes that are due; run on a timer.
    #[must_use]
    pub fn tick(&self) -> Vec<PushJob> {
        let now = Instant::now();
        let mut state = lock(&self.inner.state);
        let mut forwarded = Vec::new();
        let mut jobs = Vec::new();
        let mut changed = false;
        let in_flight = lock(&self.inner.in_flight).clone();
        for (name, entry) in &mut state.subscriptions {
            changed |= entry.expire(now, &mut forwarded);
            if entry.is_push() {
                let endpoint = entry
                    .subscription
                    .push_config
                    .as_ref()
                    .map(|config| config.push_endpoint.clone())
                    .unwrap_or_default();
                // Push config attributes are stored, not sent as headers.
                let headers = BTreeMap::new();
                for tracked in entry.messages.values() {
                    if let MessageState::Pushing { next_attempt } = tracked.state
                        && next_attempt <= now
                        && !in_flight.contains(&(name.clone(), tracked.message.id))
                    {
                        jobs.push(PushJob {
                            subscription: name.clone(),
                            message_id: tracked.message.id,
                            endpoint: endpoint.clone(),
                            headers: headers.clone(),
                            body: push_envelope(name, &tracked.message),
                        });
                    }
                }
            }
        }
        if !forwarded.is_empty() {
            changed = true;
            state.forward_dead_letters(forwarded);
        }
        {
            let mut flights = lock(&self.inner.in_flight);
            for job in &jobs {
                flights.insert((job.subscription.clone(), job.message_id));
            }
        }
        drop(state);
        if changed {
            self.notify();
        }
        jobs
    }

    /// Records the outcome of a push attempt.
    pub fn push_finished(&self, job: &PushJob, delivered: bool) {
        lock(&self.inner.in_flight).remove(&(job.subscription.clone(), job.message_id));
        let mut state = lock(&self.inner.state);
        let mut forwarded = Vec::new();
        if let Some(entry) = state.subscriptions.get_mut(&job.subscription)
            && let Some(tracked) = entry.messages.get_mut(&job.message_id)
            && matches!(tracked.state, MessageState::Pushing { .. })
        {
            if delivered {
                entry.acknowledge(job.message_id, &mut forwarded);
            } else {
                tracked.state = MessageState::Pushing {
                    next_attempt: Instant::now() + PUSH_RETRY,
                };
            }
        }
        state.forward_dead_letters(forwarded);
        drop(state);
        self.notify();
    }

    // ------------------------------------------------------------ seek and snapshots

    pub fn seek_to_time(&self, name: &str, time: &Timestamp) -> Result<(), PubsubError> {
        names::parse("subscriptions", name)?;
        let mut state = lock(&self.inner.state);
        let entry = state
            .subscriptions
            .get_mut(name)
            .ok_or_else(|| PubsubError::not_found("Subscription does not exist"))?;
        let target = UNIX_EPOCH
            + Duration::from_secs(u64::try_from(time.seconds).unwrap_or(0))
            + Duration::from_nanos(u64::try_from(time.nanos).unwrap_or(0));
        // Acknowledged messages come back only with `retainAckedMessages`;
        // everything published before the target counts as acknowledged.
        let retain = entry.subscription.retain_acked_messages;
        for tracked in entry.messages.values_mut() {
            if tracked.message.published_at >= target {
                if tracked.state == MessageState::Acked && !retain {
                    continue;
                }
                tracked.state = MessageState::Available;
                tracked.attempts = 0;
            } else {
                tracked.state = MessageState::Acked;
            }
        }
        if entry.is_push() {
            entry.start_pushing();
        }
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
            .get_mut(name)
            .ok_or_else(|| PubsubError::not_found("Subscription does not exist"))?;
        if entry.topic_deleted || entry.topic_generation != snapshot_generation {
            let subscription_topic = entry.subscription.topic.clone();
            return Err(PubsubError::failed_precondition(format!(
                "The subscription's topic {subscription_topic} is different from that of the snapshot {snapshot_topic}; they must match in order for Seek work. Note that if a topic is deleted and then re-created with the same name, it is considered a distinct topic for these purposes."
            )));
        }
        // The snapshot decides the acknowledgement state of the messages the
        // subscription itself tracks; it does not add messages it never had.
        for tracked in entry.messages.values_mut() {
            let wanted =
                unacked.contains(&tracked.message.id) || tracked.message.published > created;
            tracked.state = if wanted {
                MessageState::Available
            } else {
                MessageState::Acked
            };
            if wanted {
                tracked.attempts = 0;
            }
        }
        if entry.is_push() {
            entry.start_pushing();
        }
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
        let unacked = entry
            .messages
            .iter()
            .filter(|(_, tracked)| tracked.state != MessageState::Acked)
            .map(|(id, _)| *id)
            .collect();
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
        if state.snapshots.remove(name).is_none() {
            return Err(PubsubError::not_found("Snapshot does not exist"));
        }
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
        if let Some(entry) = state.subscriptions.get_mut(name) {
            entry.messages.clear();
        }
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
        let Some(entry) = self.topics.get_mut(topic) else {
            return;
        };
        entry.messages.extend(messages.iter().cloned());
        let generation = entry.generation;
        for subscription in self.subscriptions.values_mut() {
            if subscription.topic_deleted || subscription.topic_generation != generation {
                continue;
            }
            for message in messages {
                subscription.track(Arc::clone(message));
            }
        }
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
            let stored = Arc::new(StoredMessage {
                id,
                message: copy,
                published: Instant::now(),
                published_at: now,
            });
            self.deliver(&policy.dead_letter_topic, &[stored]);
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

// ---------------------------------------------------------------- subscriptions

impl SubscriptionEntry {
    fn is_push(&self) -> bool {
        self.subscription
            .push_config
            .as_ref()
            .is_some_and(|config| !config.push_endpoint.is_empty())
    }

    fn track(&mut self, message: Arc<StoredMessage>) {
        if let Some(filter) = &self.filter
            && !filter.matches(&message.message.attributes)
        {
            return;
        }
        let state = if self.is_push() {
            MessageState::Pushing {
                next_attempt: Instant::now(),
            }
        } else {
            MessageState::Available
        };
        self.messages.insert(
            message.id,
            Tracked {
                sequence: message.id,
                message,
                state,
                attempts: 0,
            },
        );
    }

    fn start_pushing(&mut self) {
        for tracked in self.messages.values_mut() {
            if tracked.state == MessageState::Available {
                tracked.state = MessageState::Pushing {
                    next_attempt: Instant::now(),
                };
            }
        }
    }

    fn stop_pushing(&mut self) {
        for tracked in self.messages.values_mut() {
            if matches!(tracked.state, MessageState::Pushing { .. }) {
                tracked.state = MessageState::Available;
            }
        }
    }

    /// Delivers available messages: unordered ones in publish order, ordered
    /// ones only while no earlier message of the same key is outstanding.
    fn take(
        &mut self,
        max_messages: i32,
        first_ack: u64,
        now: Instant,
    ) -> (Vec<ReceivedMessage>, u64) {
        let limit = usize::try_from(max_messages).unwrap_or(0);
        let ordered = self.subscription.enable_message_ordering;
        let blocked: BTreeSet<String> = if ordered {
            self.messages
                .values()
                .filter(|tracked| matches!(tracked.state, MessageState::Leased { .. }))
                .map(|tracked| tracked.message.message.ordering_key.clone())
                .filter(|key| !key.is_empty())
                .collect()
        } else {
            BTreeSet::new()
        };
        let deadline = now
            + Duration::from_secs(
                u64::try_from(self.subscription.ack_deadline_seconds).unwrap_or(10),
            );
        let dead_letter = self.subscription.dead_letter_policy.is_some();
        let mut candidates: Vec<(u64, u64)> = self
            .messages
            .iter()
            .filter(|(_, tracked)| tracked.state == MessageState::Available)
            .map(|(id, tracked)| (tracked.sequence, *id))
            .collect();
        candidates.sort_unstable();
        let mut received = Vec::new();
        let mut used = 0;
        for (_, id) in candidates {
            if received.len() >= limit {
                break;
            }
            let Some(tracked) = self.messages.get_mut(&id) else {
                continue;
            };
            let key = &tracked.message.message.ordering_key;
            if ordered && !key.is_empty() && blocked.contains(key) {
                continue;
            }
            let ack = first_ack + used;
            used += 1;
            tracked.attempts += 1;
            tracked.state = MessageState::Leased { ack, deadline };
            received.push(ReceivedMessage {
                ack_id: format!("{}:{ack}", self.subscription.name),
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

    fn find_lease(&self, ack: u64) -> Option<u64> {
        self.messages
            .iter()
            .find(|(_, tracked)| matches!(tracked.state, MessageState::Leased { ack: leased, .. } if leased == ack))
            .map(|(id, _)| *id)
    }

    fn acknowledge(&mut self, id: u64, _forwarded: &mut Vec<(String, Arc<StoredMessage>, u32)>) {
        if let Some(tracked) = self.messages.get_mut(&id) {
            tracked.state = MessageState::Acked;
        }
    }

    /// A nack (`0`) makes the message available again (queued behind later
    /// messages) or dead-letters it; any other value extends the lease.
    fn modify_deadline(
        &mut self,
        id: u64,
        seconds: i32,
        now: Instant,
        forwarded: &mut Vec<(String, Arc<StoredMessage>, u32)>,
    ) {
        let max_attempts = self
            .subscription
            .dead_letter_policy
            .as_ref()
            .map(|policy| policy.max_delivery_attempts);
        let push = self.is_push();
        let Some(tracked) = self.messages.get_mut(&id) else {
            return;
        };
        let MessageState::Leased { ack, .. } = tracked.state else {
            return;
        };
        if seconds == 0 {
            if let Some(max) = max_attempts
                && i32::try_from(tracked.attempts).unwrap_or(i32::MAX) >= max
            {
                forwarded.push((
                    self.subscription.name.clone(),
                    Arc::clone(&tracked.message),
                    tracked.attempts,
                ));
                self.messages.remove(&id);
                return;
            }
            tracked.sequence = next_sequence();
            tracked.state = if push {
                MessageState::Pushing { next_attempt: now }
            } else {
                MessageState::Available
            };
        } else {
            tracked.state = MessageState::Leased {
                ack,
                deadline: now + Duration::from_secs(u64::try_from(seconds).unwrap_or(0)),
            };
        }
    }

    /// Returns expired leases to the backlog; reports whether anything changed.
    fn expire(
        &mut self,
        now: Instant,
        forwarded: &mut Vec<(String, Arc<StoredMessage>, u32)>,
    ) -> bool {
        let expired: Vec<u64> = self
            .messages
            .iter()
            .filter(|(_, tracked)| matches!(tracked.state, MessageState::Leased { deadline, .. } if deadline <= now))
            .map(|(id, _)| *id)
            .collect();
        for id in &expired {
            self.modify_deadline(*id, 0, now, forwarded);
        }
        !expired.is_empty()
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
        assert!(
            broker
                .pull("projects/p/subscriptions/sub-a", 10)
                .unwrap()
                .is_empty()
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
