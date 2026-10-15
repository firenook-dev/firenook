//! Read models of the broker for the console: the topics index, topic and
//! subscription details, history pages and message details, backlog pages,
//! snapshots and schemas, and the console delta the live topics are built
//! on. Plain structs without serde; the console maps them to its own types.
//!
//! Every read holds the broker lock for one bounded walk or a pointer copy.
//! A filtered history page copies the ring's entry pointers under the lock
//! and matches outside it, remembering what it matched per (topic, query) so
//! the next page and the next refresh continue instead of scanning again.

use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

use super::{
    BacklogKey, Broker, ConsumerCounts, Fanout, HistoryEntry, HistoryWindow, MessageMark,
    MessageState, PUSH_RETRY, ResourceKind, SecondWindow, SeenKeys, State, StoredMessage,
    SubscriptionCounts, SubscriptionEntry, TopicEntry, Tracked, duration_seconds, lock, wall_clock,
};
use crate::filter::Filter;
use crate::google::pubsub::v1::Encoding;
use crate::names;

/// Messages a data-reading history search examines per request.
const SCAN_ITEMS: usize = 20_000;
/// Bytes of message data a history search examines per request.
const SCAN_BYTES: usize = 64 << 20;
/// How much of a message's data a word search reads.
const TEXT_PREFIX: usize = 64 << 10;
/// Remembered history searches.
const CACHED_SEARCHES: usize = 8;
/// Subscriptions named per history row; the rest are counted.
const ROW_MARKS: usize = 8;
/// How many characters a payload preview shows.
const PREVIEW_CHARS: usize = 256;
/// How many bytes of binary data a preview shows (as base64).
const PREVIEW_BYTES: usize = 192;
/// Compact JSON previews are made for data up to this size.
const PREVIEW_JSON_LIMIT: usize = 64 << 10;

// ---------------------------------------------------------------- views

/// A topic's figures, as the topics tree and the counters topic show them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TopicCounters {
    pub name: String,
    /// Messages published since the emulator started.
    pub published: u64,
    pub last_published_at: Option<SystemTime>,
    pub latest_id: Option<u64>,
    /// The subscription with the largest backlog.
    pub most_behind: Option<MostBehind>,
}

/// The most-behind subscription of a topic.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MostBehind {
    pub subscription: String,
    pub backlog: u64,
}

/// A subscription's figures, with who consumes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubscriptionCountersView {
    pub name: String,
    pub counts: SubscriptionCounts,
    pub consumers: ConsumerCounts,
    pub last_pull_at: Option<SystemTime>,
}

/// A subscription as the tree and the subscriptions table show it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubscriptionSummary {
    pub name: String,
    pub project: String,
    pub id: String,
    /// The topic's full name; `None` once the topic was deleted.
    pub topic: Option<String>,
    pub push: bool,
    pub ordering: bool,
    pub exactly_once: bool,
    pub dead_letter_topic: Option<String>,
    pub filter: Option<String>,
    pub counters: SubscriptionCountersView,
}

/// A topic as the tree, the landing grid and search show it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TopicSummary {
    pub name: String,
    pub project: String,
    pub id: String,
    /// The bound schema's full name, or `_deleted-schema_`.
    pub schema: Option<String>,
    pub counters: TopicCounters,
    pub subscriptions: Vec<SubscriptionSummary>,
}

/// Topics and subscriptions under another project.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectCount {
    pub project: String,
    pub topics: u32,
    pub subscriptions: u32,
}

/// Every topic of a project, compact.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TopicIndex {
    pub project: String,
    pub topics: Vec<TopicSummary>,
    pub other_projects: Vec<ProjectCount>,
    /// Subscriptions of the project whose topic was deleted.
    pub detached: Vec<SubscriptionSummary>,
    /// The console revision the index was read at.
    pub revision: u64,
}

/// A topic's schema binding.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TopicSchema {
    /// The schema's full name, or `_deleted-schema_`.
    pub schema: String,
    pub deleted: bool,
    /// `JSON` or `BINARY`.
    pub encoding: &'static str,
    pub first_revision_id: Option<String>,
    pub last_revision_id: Option<String>,
    /// The revision publishes are checked against.
    pub bound_revision_id: String,
}

/// A topic's details.
#[derive(Debug, Clone, PartialEq)]
pub struct TopicView {
    pub summary: TopicSummary,
    pub labels: BTreeMap<String, String>,
    pub retention_seconds: Option<i64>,
    pub schema: Option<TopicSchema>,
    /// Stored, never used by the emulator.
    pub kms_key_name: Option<String>,
    pub created_at: SystemTime,
    pub history: HistoryWindow,
    pub throughput: SecondWindow,
    pub subscriptions: Vec<SubscriptionView>,
    /// Subscriptions that dead-letter into this topic.
    pub dead_letter_for: Vec<String>,
    pub keys: SeenKeys,
}

/// A subscription's full configuration.
#[derive(Debug, Clone, PartialEq)]
pub struct SubscriptionView {
    pub summary: SubscriptionSummary,
    pub push_endpoint: Option<String>,
    /// Stored; the emulator does not send them.
    pub push_attributes: BTreeMap<String, String>,
    pub ack_deadline_seconds: i32,
    pub retain_acked: bool,
    pub retention_seconds: i64,
    /// Stored; the emulator never expires a subscription.
    pub expiration_ttl_seconds: Option<i64>,
    /// The dead-letter topic and its maximum delivery attempts.
    pub dead_letter: Option<(String, i32)>,
    /// The retry policy's minimum and maximum backoff, seconds (stored, not applied).
    pub retry: Option<(f64, f64)>,
    pub labels: BTreeMap<String, String>,
    pub detached: bool,
    pub created_at: SystemTime,
    /// The dead-letter topic's kept messages that came from this subscription.
    pub dead_lettered_in_history: u32,
}

/// A schema as the schemas list shows it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SchemaSummary {
    pub name: String,
    pub project: String,
    pub id: String,
    /// `AVRO`, the only type the emulator runs.
    pub kind: &'static str,
    pub revisions: u32,
    pub latest_revision_id: String,
    pub latest_created_at: SystemTime,
    /// Topics bound to it.
    pub used_by: Vec<String>,
}

/// One revision of a schema.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SchemaRevisionView {
    pub id: String,
    pub created_at: SystemTime,
    pub definition: String,
}

/// A topic bound to a schema.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SchemaUse {
    pub topic: String,
    pub encoding: &'static str,
    pub first_revision_id: Option<String>,
    pub last_revision_id: Option<String>,
    pub bound_revision_id: String,
}

/// A schema with every revision, oldest first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SchemaDetail {
    pub name: String,
    pub project: String,
    pub id: String,
    pub kind: &'static str,
    pub revisions: Vec<SchemaRevisionView>,
    pub used_by: Vec<SchemaUse>,
}

/// How a payload preview is written.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PayloadEncoding {
    Json,
    Text,
    Binary,
}

/// The start of a message's data, for lists.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PayloadPreview {
    pub encoding: PayloadEncoding,
    /// The first 256 characters (compact JSON or text), or for binary the
    /// base64 of the first 192 bytes.
    pub text: String,
    pub truncated: bool,
}

/// One message of a topic's history, with what became of it.
#[derive(Debug, Clone)]
pub struct HistoryRow {
    pub message: Arc<StoredMessage>,
    pub preview: PayloadPreview,
    /// Up to eight subscriptions of the topic and the message's mark at each.
    pub marks: Vec<(String, MessageMark)>,
    /// Subscriptions not named in `marks`.
    pub more_marks: u32,
    pub fanout: Option<Fanout>,
}

/// A page of a topic's history, newest first.
#[derive(Debug, Clone)]
pub struct HistoryPage {
    pub rows: Vec<HistoryRow>,
    /// The id to pass as `cursor` for the next (older) page.
    pub next_cursor: Option<u64>,
    /// The id to pass as `before` for the page above (newer).
    pub prev_cursor: Option<u64>,
    /// Matching messages in the ring, and whether the count is exact (a text
    /// search stopped by its budget gives a floor).
    pub total: u64,
    pub exact: bool,
    /// Messages examined so far, when the count is a floor.
    pub scanned: Option<u64>,
}

/// One message at one subscription, for the message inspector.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MessageAtSubscription {
    pub subscription: String,
    pub mark: MessageMark,
    pub attempts: u32,
    pub push_attempts: u32,
    pub lease_expires_at: Option<SystemTime>,
    pub next_push_at: Option<SystemTime>,
    /// A push request for it is in flight.
    pub push_in_flight: bool,
    /// The subscription's filter, when it is what kept the message out.
    pub filtered_by: Option<String>,
}

/// One message with everything the broker knows of it.
#[derive(Debug, Clone)]
pub struct MessageView {
    pub topic: String,
    pub message: Arc<StoredMessage>,
    /// Whether the topic's history ring still keeps it.
    pub in_history: bool,
    pub subscriptions: Vec<MessageAtSubscription>,
    pub fanout: Option<Fanout>,
}

/// A backlog row's state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BacklogState {
    Available,
    Outstanding,
    Pushing,
    Acked,
}

/// Where a backlog page starts: the row's key and, for an available row,
/// its place in the delivery order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BacklogCursor {
    pub key: BacklogKey,
    pub place: u64,
}

/// One message of a subscription's backlog, without leasing it.
#[derive(Debug, Clone)]
pub struct BacklogRow {
    pub key: BacklogKey,
    pub message: Arc<StoredMessage>,
    pub state: BacklogState,
    /// For an available message: its place in the delivery order, 1 = the
    /// next pull's first.
    pub place: Option<u64>,
    pub attempts: u32,
    pub push_attempts: u32,
    pub lease_expires_at: Option<SystemTime>,
    pub next_push_at: Option<SystemTime>,
    pub push_in_flight: bool,
    /// The outstanding message this one waits for (same ordering key).
    pub blocked_by: Option<u64>,
}

/// A page of a subscription's backlog in delivery order.
#[derive(Debug, Clone)]
pub struct BacklogPage {
    pub rows: Vec<BacklogRow>,
    pub next_cursor: Option<BacklogCursor>,
    pub prev_cursor: Option<BacklogCursor>,
    /// Rows in the chosen state (or every row), exact.
    pub total: u64,
}

// ---------------------------------------------------------------- queries

/// How a term compares.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Comparison {
    Eq,
    Gt,
    Ge,
    Lt,
    Le,
}

impl Comparison {
    fn holds(self, ordering: Ordering) -> bool {
        match self {
            Self::Eq => ordering == Ordering::Equal,
            Self::Gt => ordering == Ordering::Greater,
            Self::Ge => ordering != Ordering::Less,
            Self::Lt => ordering == Ordering::Less,
            Self::Le => ordering != Ordering::Greater,
        }
    }
}

/// A flag of `has:` and `is:`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MessageFlag {
    /// An ordering key.
    Key,
    /// The `googclient_schema*` attributes of a schema-checked publish.
    Schema,
    /// Any attribute.
    Attributes,
    /// Forwarded by a dead-letter policy.
    DeadLettered,
    /// Data that is not UTF-8.
    Binary,
    /// Data that parses as JSON.
    Json,
}

/// One condition on a message, as the console's filter field names it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MessageTerm {
    Id(Comparison, u64),
    /// The ordering key, exactly or (with `prefix`) by its start.
    Key {
        value: String,
        prefix: bool,
    },
    /// An attribute, case-sensitive: equal (or starting with, with `prefix`),
    /// or ordered numerically when both sides are numbers, else as strings.
    Attribute {
        key: String,
        comparison: Comparison,
        value: String,
        prefix: bool,
    },
    Flag(MessageFlag),
    /// Case-insensitive, in the first 64 KiB of the data's text.
    Word(String),
}

/// Terms of which one must hold, or (negated) none may.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MessageClause {
    pub any: Vec<MessageTerm>,
    pub negated: bool,
}

/// A history filter: every clause holds, and the Pub/Sub filter expression
/// over attributes passes.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MessageQuery {
    pub clauses: Vec<MessageClause>,
    pub expr: Option<Filter>,
}

impl MessageQuery {
    /// Whether nothing filters.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.clauses.is_empty() && self.expr.is_none()
    }

    /// Whether matching reads message data (and so works within a budget).
    fn reads_data(&self) -> bool {
        self.clauses
            .iter()
            .flat_map(|clause| &clause.any)
            .any(|term| {
                matches!(
                    term,
                    MessageTerm::Word(_)
                        | MessageTerm::Flag(MessageFlag::Binary | MessageFlag::Json)
                )
            })
    }

    fn cache_key(&self) -> String {
        format!("{:?}|{:?}", self.clauses, self.expr)
    }

    /// Whether `message` matches; `bytes` counts the data examined.
    fn matches(&self, message: &StoredMessage, bytes: &mut usize) -> bool {
        if let Some(expr) = &self.expr
            && !expr.matches(&message.message.attributes)
        {
            return false;
        }
        let mut lowered = TextCache::default();
        self.clauses.iter().all(|clause| {
            let any = clause
                .any
                .iter()
                .any(|term| term_matches(term, message, bytes, &mut lowered));
            any != clause.negated
        })
    }
}

fn term_matches(
    term: &MessageTerm,
    message: &StoredMessage,
    bytes: &mut usize,
    lowered: &mut TextCache,
) -> bool {
    let attributes = &message.message.attributes;
    match term {
        MessageTerm::Id(comparison, id) => comparison.holds(message.id.cmp(id)),
        MessageTerm::Key { value, prefix } => {
            let key = &message.message.ordering_key;
            if *prefix {
                key.starts_with(value.as_str())
            } else {
                key == value
            }
        }
        MessageTerm::Attribute {
            key,
            comparison,
            value,
            prefix,
        } => attributes.get(key).is_some_and(|found| {
            if *comparison == Comparison::Eq {
                if *prefix {
                    found.starts_with(value.as_str())
                } else {
                    found == value
                }
            } else {
                let ordering = match (found.parse::<f64>(), value.parse::<f64>()) {
                    (Ok(left), Ok(right)) => left.partial_cmp(&right).unwrap_or(Ordering::Equal),
                    _ => found.as_str().cmp(value.as_str()),
                };
                comparison.holds(ordering)
            }
        }),
        MessageTerm::Flag(MessageFlag::Key) => !message.message.ordering_key.is_empty(),
        MessageTerm::Flag(MessageFlag::Schema) => attributes.contains_key("googclient_schemaname"),
        MessageTerm::Flag(MessageFlag::Attributes) => !attributes.is_empty(),
        MessageTerm::Flag(MessageFlag::DeadLettered) => {
            attributes.contains_key("CloudPubSubDeadLetterSourceSubscription")
        }
        MessageTerm::Flag(MessageFlag::Binary) => {
            *bytes += message.message.data.len();
            std::str::from_utf8(&message.message.data).is_err()
        }
        MessageTerm::Flag(MessageFlag::Json) => {
            *bytes += message.message.data.len();
            serde_json::from_slice::<serde::de::IgnoredAny>(&message.message.data).is_ok()
        }
        MessageTerm::Word(word) => {
            if !lowered.read {
                let data = &message.message.data;
                *bytes += data.len().min(TEXT_PREFIX);
                lowered.text = data_text(data).map(str::to_lowercase);
                lowered.read = true;
            }
            lowered
                .text
                .as_deref()
                .is_some_and(|text| text.contains(&word.to_lowercase()))
        }
    }
}

/// A message's lowercased text, read once for all the words of a query.
#[derive(Default)]
struct TextCache {
    read: bool,
    text: Option<String>,
}

/// The data's text: its first 64 KiB when they are UTF-8 (a character cut
/// at the boundary is left out), `None` for binary data.
fn data_text(data: &[u8]) -> Option<&str> {
    let head = &data[..data.len().min(TEXT_PREFIX)];
    match std::str::from_utf8(head) {
        Ok(text) => Some(text),
        Err(error) if error.error_len().is_none() => {
            std::str::from_utf8(&head[..error.valid_up_to()]).ok()
        }
        Err(_) => None,
    }
}

/// The start of a message's data: compact JSON, text, or base64 of binary.
#[must_use]
pub fn payload_preview(data: &[u8]) -> PayloadPreview {
    if data.len() <= PREVIEW_JSON_LIMIT
        && let Ok(value) = serde_json::from_slice::<serde_json::Value>(data)
    {
        let compact = value.to_string();
        let (text, truncated) = first_chars(&compact);
        return PayloadPreview {
            encoding: PayloadEncoding::Json,
            text,
            truncated,
        };
    }
    if let Some(text) = data_text(data)
        && (data.len() <= TEXT_PREFIX || std::str::from_utf8(data).is_ok())
    {
        let (preview, cut) = first_chars(text);
        return PayloadPreview {
            encoding: PayloadEncoding::Text,
            text: preview,
            truncated: cut || data.len() > text.len(),
        };
    }
    PayloadPreview {
        encoding: PayloadEncoding::Binary,
        text: base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            &data[..data.len().min(PREVIEW_BYTES)],
        ),
        truncated: data.len() > PREVIEW_BYTES,
    }
}

fn first_chars(text: &str) -> (String, bool) {
    match text.char_indices().nth(PREVIEW_CHARS) {
        Some((end, _)) => (text[..end].to_owned(), true),
        None => (text.to_owned(), false),
    }
}

// ---------------------------------------------------------------- history search cache

/// What one (topic, query) search examined: every ring id in
/// `bottom..=top`, and the ids that matched.
#[derive(Debug)]
struct Search {
    topic: String,
    generation: u64,
    key: String,
    matched: BTreeSet<u64>,
    bottom: u64,
    top: u64,
}

/// The newest searches, most recent first.
#[derive(Debug, Default)]
pub(super) struct SearchCache {
    searches: Vec<Search>,
}

impl SearchCache {
    fn take(&mut self, topic: &str, generation: u64, key: &str) -> Option<Search> {
        let position = self.searches.iter().position(|search| {
            search.generation == generation && search.topic == topic && search.key == key
        })?;
        Some(self.searches.remove(position))
    }

    fn put(&mut self, search: Search) {
        self.searches.insert(0, search);
        self.searches.truncate(CACHED_SEARCHES);
    }
}

/// The budget of one request's examination.
struct Budget {
    limited: bool,
    items: usize,
    bytes: usize,
}

impl Budget {
    fn spent(&self) -> bool {
        self.limited && (self.items >= SCAN_ITEMS || self.bytes >= SCAN_BYTES)
    }
}

impl Search {
    fn fresh(topic: &str, generation: u64, key: String, below: u64) -> Self {
        Self {
            topic: topic.to_owned(),
            generation,
            key,
            matched: BTreeSet::new(),
            bottom: below,
            top: below.saturating_sub(1),
        }
    }

    /// Examines ring entries above `top` (new publishes).
    fn catch_up(&mut self, ring: &[Arc<HistoryEntry>], query: &MessageQuery, budget: &mut Budget) {
        let start = ring.partition_point(|entry| entry.message.id <= self.top);
        for entry in &ring[start..] {
            visit!(scanned);
            budget.items += 1;
            if query.matches(&entry.message, &mut budget.bytes) {
                self.matched.insert(entry.message.id);
            }
            self.top = entry.message.id;
        }
    }

    /// Examines ring entries below `bottom`, newest first, until `wanted`
    /// matches lie below `below` or the budget is spent.
    fn extend_down(
        &mut self,
        ring: &[Arc<HistoryEntry>],
        query: &MessageQuery,
        below: u64,
        wanted: usize,
        budget: &mut Budget,
    ) {
        let end = ring.partition_point(|entry| entry.message.id < self.bottom);
        for entry in ring[..end].iter().rev() {
            if self.matched.range(..below).count() >= wanted || budget.spent() {
                return;
            }
            visit!(scanned);
            budget.items += 1;
            if query.matches(&entry.message, &mut budget.bytes) {
                self.matched.insert(entry.message.id);
            }
            self.bottom = entry.message.id;
        }
    }

    fn complete(&self, ring: &[Arc<HistoryEntry>]) -> bool {
        ring.first()
            .is_none_or(|oldest| self.bottom <= oldest.message.id)
    }
}

// ---------------------------------------------------------------- reads

impl Broker {
    /// Every topic of `project` with its subscriptions and figures, the
    /// projects other topics live under, and the project's subscriptions
    /// whose topic was deleted. One walk of the topics and subscriptions.
    #[must_use]
    pub fn topics_index(&self, project: &str) -> TopicIndex {
        let state = lock(&self.inner.state);
        let consumers = lock(&self.inner.consumers);
        let prefix = format!("projects/{project}/topics/");
        let mut other: BTreeMap<String, (u32, u32)> = BTreeMap::new();
        let mut topics = Vec::new();
        for (name, entry) in &state.topics {
            if name.starts_with(&prefix) {
                topics.push(topic_summary(&state, &consumers, name, entry));
            } else if let Ok(parsed) = names::parse("topics", name) {
                other.entry(parsed.project).or_default().0 += 1;
            }
        }
        let subscription_prefix = format!("projects/{project}/subscriptions/");
        let mut detached = Vec::new();
        for (name, entry) in &state.subscriptions {
            if name.starts_with(&subscription_prefix) {
                if entry.topic_deleted {
                    detached.push(subscription_summary(&consumers, name, entry));
                }
            } else if let Ok(parsed) = names::parse("subscriptions", name) {
                other.entry(parsed.project).or_default().1 += 1;
            }
        }
        TopicIndex {
            project: project.to_owned(),
            topics,
            other_projects: other
                .into_iter()
                .map(|(project, (topics, subscriptions))| ProjectCount {
                    project,
                    topics,
                    subscriptions,
                })
                .collect(),
            detached,
            revision: state.revision,
        }
    }

    /// A topic's details.
    #[must_use]
    pub fn topic_view(&self, name: &str) -> Option<TopicView> {
        let (view, dead_letter_sources) = {
            let state = lock(&self.inner.state);
            let consumers = lock(&self.inner.consumers);
            let entry = state.topics.get(name)?;
            let summary = topic_summary(&state, &consumers, name, entry);
            let members = live_members(&state, entry);
            let subscriptions: Vec<SubscriptionView> = members
                .iter()
                .map(|(member, subscription)| subscription_view(&consumers, member, subscription))
                .collect();
            let dead_letter_for = state
                .subscriptions
                .iter()
                .filter(|(_, subscription)| {
                    subscription
                        .subscription
                        .dead_letter_policy
                        .as_ref()
                        .is_some_and(|policy| policy.dead_letter_topic == name)
                })
                .map(|(member, _)| member.clone())
                .collect();
            let (capacity_messages, capacity_bytes) = entry.capacity(&state.limits);
            let schema = entry.topic.schema_settings.as_ref().map(|settings| {
                let bound = entry.schema.as_ref();
                TopicSchema {
                    schema: settings.schema.clone(),
                    deleted: bound.is_some_and(|bound| bound.deleted),
                    encoding: encoding_name(bound.map_or(Encoding::Json, |bound| bound.encoding)),
                    first_revision_id: non_empty(&settings.first_revision_id),
                    last_revision_id: non_empty(&settings.last_revision_id),
                    bound_revision_id: bound
                        .map(|bound| bound.revision_id.clone())
                        .unwrap_or_default(),
                }
            });
            let view = TopicView {
                summary,
                labels: entry.topic.labels.clone().into_iter().collect(),
                retention_seconds: duration_seconds(
                    entry.topic.message_retention_duration.as_ref(),
                ),
                schema,
                kms_key_name: non_empty(&entry.topic.kms_key_name),
                created_at: entry.created_at,
                history: HistoryWindow {
                    messages: u32::try_from(entry.history.len()).unwrap_or(u32::MAX),
                    bytes: entry.history_bytes,
                    oldest_id: entry.history.front().map(|history| history.message.id),
                    capacity_messages: u32::try_from(capacity_messages).unwrap_or(u32::MAX),
                    capacity_bytes,
                    dropped: entry.history_dropped,
                },
                throughput: entry.throughput.window(),
                subscriptions,
                dead_letter_for,
                keys: SeenKeys {
                    ordering_keys: entry.ordering_keys.iter().rev().cloned().collect(),
                    attribute_keys: entry.attribute_keys.iter().cloned().collect(),
                },
            };
            let sources: Vec<String> = view
                .subscriptions
                .iter()
                .filter(|subscription| subscription.dead_letter.is_some())
                .map(|subscription| subscription.summary.name.clone())
                .collect();
            (view, sources)
        };
        let mut view = view;
        for subscription in &mut view.subscriptions {
            if dead_letter_sources.contains(&subscription.summary.name)
                && let Some((topic, _)) = &subscription.dead_letter
            {
                subscription.dead_lettered_in_history =
                    self.dead_lettered_in_history(topic, &subscription.summary.name);
            }
        }
        Some(view)
    }

    /// A subscription's details.
    #[must_use]
    pub fn subscription_view(&self, name: &str) -> Option<SubscriptionView> {
        let mut view = {
            let state = lock(&self.inner.state);
            let consumers = lock(&self.inner.consumers);
            let entry = state.subscriptions.get(name)?;
            subscription_view(&consumers, name, entry)
        };
        if let Some((topic, _)) = &view.dead_letter {
            view.dead_lettered_in_history = self.dead_lettered_in_history(topic, name);
        }
        Some(view)
    }

    /// The dead-letter topic's kept messages that came from `subscription`,
    /// counted outside the lock over a copy of the ring's pointers.
    fn dead_lettered_in_history(&self, topic: &str, subscription: &str) -> u32 {
        let Ok(parsed) = names::parse("subscriptions", subscription) else {
            return 0;
        };
        let ring = {
            let state = lock(&self.inner.state);
            match state.topics.get(topic) {
                Some(entry) => entry.history.iter().cloned().collect::<Vec<_>>(),
                None => return 0,
            }
        };
        let count = ring
            .iter()
            .filter(|entry| {
                let attributes = &entry.message.message.attributes;
                attributes.get("CloudPubSubDeadLetterSourceSubscription") == Some(&parsed.id)
                    && attributes.get("CloudPubSubDeadLetterSourceSubscriptionProject")
                        == Some(&parsed.project)
            })
            .count();
        u32::try_from(count).unwrap_or(u32::MAX)
    }

    /// A page of `topic`'s history, newest first: ids below `cursor`, or the
    /// page above `before`. Without a filter it is a slice of the ring; with
    /// one, matching runs outside the lock over a copy of the ring's
    /// pointers, and a search that reads data examines at most 20,000
    /// messages or 64 MiB per request, the next page continuing it.
    #[must_use]
    pub fn history_page(
        &self,
        topic: &str,
        query: &MessageQuery,
        cursor: Option<u64>,
        before: Option<u64>,
        limit: usize,
    ) -> Option<HistoryPage> {
        let limit = limit.max(1);
        let (ring, generation) = {
            visit!(locks);
            let state = lock(&self.inner.state);
            let entry = state.topics.get(topic)?;
            (
                entry.history.iter().cloned().collect::<Vec<_>>(),
                entry.generation,
            )
        };
        let page = if query.is_empty() {
            unfiltered_page(&ring, cursor, before, limit)
        } else {
            self.filtered_page(topic, generation, &ring, query, cursor, before, limit)
        };
        let rows = self.rows(topic, page.ids);
        Some(HistoryPage {
            rows,
            next_cursor: page.next,
            prev_cursor: page.prev,
            total: page.total,
            exact: page.exact,
            scanned: page.scanned,
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn filtered_page(
        &self,
        topic: &str,
        generation: u64,
        ring: &[Arc<HistoryEntry>],
        query: &MessageQuery,
        cursor: Option<u64>,
        before: Option<u64>,
        limit: usize,
    ) -> PageIds {
        let key = query.cache_key();
        let newest = ring.last().map_or(0, |entry| entry.message.id);
        let mut budget = Budget {
            limited: query.reads_data(),
            items: 0,
            bytes: 0,
        };
        let cached = lock(&self.inner.searches).take(topic, generation, &key);
        let below = cursor.unwrap_or(newest + 1);
        let mut search = cached.unwrap_or_else(|| Search::fresh(topic, generation, key, below));
        // New publishes are matched as they come instead of scanning again.
        // A gap past the budget is left for later when a deeper page is
        // asked, and starts the search over from the top for the head page.
        let gap = ring.len() - ring.partition_point(|entry| entry.message.id <= search.top);
        if budget.limited && gap > SCAN_ITEMS {
            if cursor.is_none() {
                search = Search::fresh(topic, generation, search.key, below);
            }
        } else {
            search.catch_up(ring, query, &mut budget);
        }
        if let Some(oldest) = ring.first() {
            let oldest = oldest.message.id;
            search.matched = search.matched.split_off(&oldest);
        }
        let ids: Vec<u64> = if let Some(before) = before {
            let mut above: Vec<u64> = search
                .matched
                .range(before + 1..)
                .take(limit)
                .copied()
                .collect();
            above.reverse();
            above
        } else {
            search.extend_down(ring, query, below, limit + 1, &mut budget);
            search
                .matched
                .range(..below)
                .rev()
                .take(limit)
                .copied()
                .collect()
        };
        let complete = search.complete(ring) && search.top >= newest;
        // Fewer rows than asked with the scan unfinished: the next page
        // continues the scan from where it stopped.
        let next = match ids.last() {
            Some(last) if ids.len() == limit || before.is_some() => {
                (search.matched.range(..*last).next().is_some() || !search.complete(ring))
                    .then_some(*last)
            }
            _ if !search.complete(ring) => Some(search.bottom),
            _ => None,
        };
        let more_above = ids
            .first()
            .is_some_and(|first| search.matched.range(first + 1..).next().is_some());
        let total = u64::try_from(search.matched.len()).unwrap_or(u64::MAX);
        let examined = ring.partition_point(|entry| entry.message.id <= search.top)
            - ring.partition_point(|entry| entry.message.id < search.bottom);
        let page = PageIds {
            next,
            prev: if more_above {
                ids.first().copied()
            } else {
                None
            },
            total,
            exact: complete,
            scanned: (!complete).then(|| u64::try_from(examined).unwrap_or(u64::MAX)),
            ids,
        };
        lock(&self.inner.searches).put(search);
        page
    }

    /// The history rows of `ids` (newest first), marks computed under one
    /// short lock.
    fn rows(&self, topic: &str, ids: Vec<u64>) -> Vec<HistoryRow> {
        visit!(locks);
        let state = lock(&self.inner.state);
        let Some(entry) = state.topics.get(topic) else {
            return Vec::new();
        };
        let members = live_members(&state, entry);
        ids.into_iter()
            .filter_map(|id| {
                let position = entry
                    .history
                    .binary_search_by_key(&id, |history| history.message.id)
                    .ok()?;
                let history = &entry.history[position];
                let outcomes = history.outcomes();
                let marks: Vec<(String, MessageMark)> = members
                    .iter()
                    .take(ROW_MARKS)
                    .map(|(name, subscription)| {
                        (
                            (*name).clone(),
                            subscription.mark(&history.message, &outcomes),
                        )
                    })
                    .collect();
                Some(HistoryRow {
                    preview: payload_preview(&history.message.message.data),
                    more_marks: u32::try_from(members.len().saturating_sub(ROW_MARKS))
                        .unwrap_or(u32::MAX),
                    marks,
                    fanout: history.fanout(),
                    message: Arc::clone(&history.message),
                })
            })
            .collect()
    }

    /// The history rows behind a batch read: each id while the ring keeps it
    /// and it still matches `query`.
    #[must_use]
    pub fn history_rows(
        &self,
        topic: &str,
        ids: &[u64],
        query: &MessageQuery,
    ) -> Vec<Option<HistoryRow>> {
        let mut rows: BTreeMap<u64, HistoryRow> = self
            .rows(topic, ids.to_vec())
            .into_iter()
            .map(|row| (row.message.id, row))
            .collect();
        let mut bytes = 0;
        ids.iter()
            .map(|id| {
                rows.remove(id)
                    .filter(|row| query.matches(&row.message, &mut bytes))
            })
            .collect()
    }

    /// One message: from the topic's history ring, or else from a
    /// subscription of the topic still tracking it.
    #[must_use]
    pub fn message_view(&self, topic: &str, id: u64) -> Option<MessageView> {
        let state = lock(&self.inner.state);
        let entry = state.topics.get(topic)?;
        let members = live_members(&state, entry);
        let in_ring = entry
            .history
            .binary_search_by_key(&id, |history| history.message.id)
            .ok()
            .map(|position| &entry.history[position]);
        let (message, outcomes, fanout) = if let Some(history) = in_ring {
            (
                Arc::clone(&history.message),
                history.outcomes(),
                history.fanout(),
            )
        } else {
            let message = members.iter().find_map(|(_, subscription)| {
                subscription
                    .messages
                    .get(&id)
                    .map(|tracked| Arc::clone(&tracked.message))
            })?;
            (message, Vec::new(), None)
        };
        let now = Instant::now();
        let subscriptions = members
            .iter()
            .map(|(name, subscription)| {
                let mark = subscription.mark(&message, &outcomes);
                let tracked = subscription.messages.get(&id);
                let (lease_expires_at, next_push_at, push_in_flight) =
                    tracked.map_or((None, None, false), |tracked| times(tracked, now));
                MessageAtSubscription {
                    subscription: (*name).clone(),
                    mark,
                    attempts: tracked.map_or(0, |tracked| tracked.attempts),
                    push_attempts: tracked.map_or(0, |tracked| tracked.push_attempts),
                    lease_expires_at,
                    next_push_at,
                    push_in_flight,
                    filtered_by: (mark == MessageMark::Filtered)
                        .then(|| subscription.subscription.filter.clone()),
                }
            })
            .collect();
        Some(MessageView {
            topic: topic.to_owned(),
            in_history: in_ring.is_some(),
            message,
            subscriptions,
            fanout,
        })
    }

    /// A page of `subscription`'s backlog in delivery order, without leasing
    /// anything: rows after `cursor`, or the page before `before`, in
    /// `state` (or every state).
    #[must_use]
    pub fn backlog_page(
        &self,
        subscription: &str,
        state: Option<BacklogState>,
        cursor: Option<BacklogCursor>,
        before: Option<BacklogCursor>,
        limit: usize,
    ) -> Option<BacklogPage> {
        let limit = limit.max(1);
        let guard = lock(&self.inner.state);
        let entry = guard.subscriptions.get(subscription)?;
        let counts = entry.index.counts;
        let total = match state {
            Some(BacklogState::Available) => counts.available,
            Some(BacklogState::Outstanding) => counts.leased,
            Some(BacklogState::Pushing) => counts.pushing,
            Some(BacklogState::Acked) => counts.acked,
            None => counts.available + counts.leased + counts.pushing + counts.acked,
        };
        let now = Instant::now();
        let (keys, first_place, more_before, more_after) = if let Some(before) = before {
            let mut keys = backlog_keys_before(entry, state, before.key, limit + 1);
            let more_before = keys.len() > limit;
            keys.truncate(limit);
            keys.reverse();
            let available =
                u64::try_from(keys.iter().filter(|key| key.phase == 1).count()).unwrap_or(u64::MAX);
            let first_place = if before.key.phase == 1 {
                before.place.saturating_sub(available + 1)
            } else {
                // Rows before a retained one: the available ones end the backlog.
                entry.index.counts.available.saturating_sub(available)
            };
            (keys, first_place, more_before, true)
        } else {
            let mut keys =
                backlog_keys_after(entry, state, cursor.map(|cursor| cursor.key), limit + 1);
            let more_after = keys.len() > limit;
            keys.truncate(limit);
            let first_place = cursor.map_or(0, |cursor| {
                if cursor.key.phase == 1 {
                    cursor.place
                } else {
                    0
                }
            });
            (keys, first_place, cursor.is_some(), more_after)
        };
        let mut place = first_place;
        let rows: Vec<BacklogRow> = keys
            .iter()
            .filter_map(|key| {
                let tracked = entry.messages.get(&key.id)?;
                let row_place = (key.phase == 1).then(|| {
                    place += 1;
                    place
                });
                Some(backlog_row(entry, *key, tracked, row_place, now))
            })
            .collect();
        let cursor_of = |row: &BacklogRow| BacklogCursor {
            key: row.key,
            place: row.place.unwrap_or(0),
        };
        Some(BacklogPage {
            next_cursor: if more_after {
                rows.last().map(cursor_of)
            } else {
                None
            },
            prev_cursor: if more_before {
                rows.first().map(cursor_of)
            } else {
                None
            },
            rows,
            total,
        })
    }

    /// The backlog rows behind a batch read: each key's row while the
    /// message still sits at that position (a moved one comes back absent;
    /// its new key names it).
    #[must_use]
    pub fn backlog_rows(&self, subscription: &str, keys: &[BacklogKey]) -> Vec<Option<BacklogRow>> {
        let state = lock(&self.inner.state);
        let Some(entry) = state.subscriptions.get(subscription) else {
            return keys.iter().map(|_| None).collect();
        };
        let now = Instant::now();
        keys.iter()
            .map(|key| {
                let tracked = entry.messages.get(&key.id)?;
                (BacklogKey::of(key.id, tracked) == *key)
                    .then(|| backlog_row(entry, *key, tracked, None, now))
            })
            .collect()
    }

    /// The schemas of `project`.
    #[must_use]
    pub fn schemas_view(&self, project: &str) -> Vec<SchemaSummary> {
        let state = lock(&self.inner.state);
        let prefix = format!("projects/{project}/schemas/");
        state
            .schemas
            .iter()
            .filter(|(name, _)| name.starts_with(&prefix))
            .filter_map(|(name, schema)| {
                let latest = schema.revisions.last()?;
                let (project, id) = split_name("schemas", name);
                Some(SchemaSummary {
                    name: name.clone(),
                    project,
                    id,
                    kind: "AVRO",
                    revisions: u32::try_from(schema.revisions.len()).unwrap_or(u32::MAX),
                    latest_revision_id: latest.id.clone(),
                    latest_created_at: latest.created_at,
                    used_by: schema_uses(&state, name)
                        .into_iter()
                        .map(|used| used.topic)
                        .collect(),
                })
            })
            .collect()
    }

    /// A schema with every revision, oldest first, and the topics bound to it.
    #[must_use]
    pub fn schema_detail(&self, name: &str) -> Option<SchemaDetail> {
        let state = lock(&self.inner.state);
        let schema = state.schemas.get(name)?;
        let (project, id) = split_name("schemas", name);
        Some(SchemaDetail {
            name: name.to_owned(),
            project,
            id,
            kind: "AVRO",
            revisions: schema
                .revisions
                .iter()
                .map(|revision| SchemaRevisionView {
                    id: revision.id.clone(),
                    created_at: revision.created_at,
                    definition: revision.definition.clone(),
                })
                .collect(),
            used_by: schema_uses(&state, name),
        })
    }

    /// The bound Avro revision a topic checks publishes against, with its
    /// encoding: `None` without a binding (or once the schema was deleted).
    #[must_use]
    pub fn topic_schema(&self, topic: &str) -> Option<(Arc<apache_avro::Schema>, Encoding)> {
        let state = lock(&self.inner.state);
        let bound = state.topics.get(topic)?.schema.as_ref()?;
        (!bound.deleted).then(|| (Arc::clone(&bound.parsed), bound.encoding))
    }

    /// A schema's revision (`name` or `name@revision`, the latest when no
    /// revision is named), parsed.
    #[must_use]
    pub fn schema_revision(&self, name: &str) -> Option<Arc<apache_avro::Schema>> {
        let (base, revision) = names::split_revision(name);
        let state = lock(&self.inner.state);
        let schema = state.schemas.get(base)?;
        let found = match revision {
            Some(id) => schema
                .revisions
                .iter()
                .find(|candidate| candidate.id == id)?,
            None => schema.revisions.last()?,
        };
        Some(Arc::clone(&found.parsed))
    }

    /// The newest `limit` messages of `topic`'s ring, newest first, copied
    /// under the lock for matching outside it.
    #[must_use]
    pub fn newest_messages(&self, topic: &str, limit: usize) -> Vec<Arc<StoredMessage>> {
        let state = lock(&self.inner.state);
        state.topics.get(topic).map_or_else(Vec::new, |entry| {
            entry
                .history
                .iter()
                .rev()
                .take(limit)
                .map(|history| Arc::clone(&history.message))
                .collect()
        })
    }

    /// The live subscriptions of `topic`'s current generation, by name.
    #[must_use]
    pub fn topic_subscriptions(&self, topic: &str) -> Vec<String> {
        let state = lock(&self.inner.state);
        state.topics.get(topic).map_or_else(Vec::new, |entry| {
            live_members(&state, entry)
                .into_iter()
                .map(|(name, _)| name.clone())
                .collect()
        })
    }

    /// `(project, id)` of every topic (`collection` "topics") or
    /// subscription ("subscriptions").
    #[must_use]
    pub fn resource_ids(&self, collection: &str) -> Vec<(String, String)> {
        let state = lock(&self.inner.state);
        let names: Vec<&String> = if collection == "subscriptions" {
            state.subscriptions.keys().collect()
        } else {
            state.topics.keys().collect()
        };
        names
            .into_iter()
            .filter_map(|name| names::parse(collection, name).ok())
            .map(|parsed| (parsed.project, parsed.id))
            .collect()
    }

    /// Every message of `topic`'s history ring that reached the functions
    /// step, with its fanout, newest first: the deliveries view's records
    /// (bounded by the ring), copied under one lock.
    #[must_use]
    pub fn fanouts(&self, topic: &str) -> Option<Vec<(Arc<StoredMessage>, Fanout)>> {
        let state = lock(&self.inner.state);
        let entry = state.topics.get(topic)?;
        Some(
            entry
                .history
                .iter()
                .rev()
                .filter_map(|history| {
                    history
                        .fanout()
                        .map(|fanout| (Arc::clone(&history.message), fanout))
                })
                .collect(),
        )
    }

    /// The topics (full names) whose history ring keeps message `id`, at
    /// most `limit`: a binary search in each ring.
    #[must_use]
    pub fn topics_with_message(&self, id: u64, limit: usize) -> Vec<String> {
        let state = lock(&self.inner.state);
        state
            .topics
            .iter()
            .filter(|(_, entry)| {
                entry
                    .history
                    .binary_search_by_key(&id, |history| history.message.id)
                    .is_ok()
            })
            .map(|(name, _)| name.clone())
            .take(limit)
            .collect()
    }

    /// One message of `topic`'s history ring, while it keeps it.
    #[must_use]
    pub fn history_message(&self, topic: &str, id: u64) -> Option<Arc<StoredMessage>> {
        let state = lock(&self.inner.state);
        let entry = state.topics.get(topic)?;
        let position = entry
            .history
            .binary_search_by_key(&id, |history| history.message.id)
            .ok()?;
        Some(Arc::clone(&entry.history[position].message))
    }
}

// ---------------------------------------------------------------- the console delta

/// What one console view follows.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DeltaScope {
    /// The project whose topics and subscriptions count.
    pub project: String,
    /// Report changed topic and subscription figures and resource kinds.
    pub counters: bool,
    /// Report the resource kinds that changed, without the figures (a
    /// topic view that lists its snapshots).
    pub resources: bool,
    /// Topics (full names) whose throughput windows to include.
    pub throughput: Vec<String>,
    /// The topic whose new message ids to report.
    pub topic: Option<String>,
    /// The subscription whose moved backlog rows to report; a console view
    /// holds a [`super::BacklogReader`] for it.
    pub subscription: Option<String>,
    /// Report the topic's new fanout records.
    pub deliveries: bool,
    /// Past this many changed topics and subscriptions, report `overflow`
    /// instead of listing them.
    pub max_changed: usize,
}

/// Where a console view's last delta left it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ConsoleCursor {
    /// The console revision reported last.
    pub revision: u64,
    topic: Option<(u64, u64)>,
    backlog: Option<u64>,
    fanouts: Option<u64>,
}

impl ConsoleCursor {
    /// A cursor at `revision` (the revision of an index the view already holds).
    #[must_use]
    pub fn at(revision: u64) -> Self {
        Self {
            revision,
            ..Self::default()
        }
    }
}

/// New messages of the scoped topic.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublishedIds {
    pub latest_id: u64,
    /// Messages published since the last delta.
    pub added: u64,
    /// Their ids, newest first, at most 100.
    pub ids: Vec<u64>,
    /// More than 100 arrived.
    pub overflow: bool,
}

/// New fanout records of the scoped topic.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FanoutChanges {
    pub added: u32,
    /// Event ids of the new or changed records, at most 100.
    pub event_ids: Vec<String>,
    /// The messages those records belong to (their function marks moved).
    pub message_ids: Vec<u64>,
    pub overflow: bool,
}

/// What changed since a console cursor.
#[derive(Debug, Clone, PartialEq)]
pub struct ConsoleDelta {
    pub revision: u64,
    pub topics: Vec<TopicCounters>,
    pub subscriptions: Vec<SubscriptionCountersView>,
    /// More topics and subscriptions changed than `max_changed`.
    pub overflow: bool,
    pub resources: Vec<ResourceKind>,
    pub throughput: Vec<(String, SecondWindow)>,
    pub published: Option<PublishedIds>,
    /// Old and new keys of the scoped subscription's moved rows.
    pub backlog: Vec<BacklogKey>,
    /// The scoped subscription's moved rows were not all remembered.
    pub backlog_reset: bool,
    pub deliveries: Option<FanoutChanges>,
}

impl ConsoleDelta {
    /// Whether nothing changed.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.topics.is_empty()
            && self.subscriptions.is_empty()
            && !self.overflow
            && self.resources.is_empty()
            && self.published.is_none()
            && self.backlog.is_empty()
            && !self.backlog_reset
            && self.deliveries.is_none()
    }
}

impl Broker {
    /// What changed since `cursor` for a console view following `scope`,
    /// read under the lock in one walk of the topics' and subscriptions'
    /// stamps; the cursor moves to now.
    pub fn console_delta(&self, cursor: &mut ConsoleCursor, scope: &DeltaScope) -> ConsoleDelta {
        let state = lock(&self.inner.state);
        let consumers = lock(&self.inner.consumers);
        let since = cursor.revision;
        let mut delta = ConsoleDelta {
            revision: state.revision,
            topics: Vec::new(),
            subscriptions: Vec::new(),
            overflow: false,
            resources: Vec::new(),
            throughput: Vec::new(),
            published: None,
            backlog: Vec::new(),
            backlog_reset: false,
            deliveries: None,
        };
        if scope.counters && since != state.revision {
            counters_since(&state, &consumers, scope, since, &mut delta);
        } else if scope.resources && since != state.revision {
            delta.resources = resources_since(&state, since);
        }
        for topic in &scope.throughput {
            if let Some(entry) = state.topics.get(topic) {
                delta
                    .throughput
                    .push((topic.clone(), entry.throughput.window()));
            }
        }
        if let Some(topic) = scope
            .topic
            .as_ref()
            .and_then(|topic| state.topics.get(topic))
        {
            let latest = topic.latest_id.unwrap_or(0);
            match cursor.topic {
                // Message ids only grow, so a topic deleted and created again
                // (or cleared) since the cursor still shows its new messages.
                Some((published, last)) if latest > last => {
                    let start = topic
                        .history
                        .partition_point(|entry| entry.message.id <= last);
                    let new: Vec<u64> = topic
                        .history
                        .range(start..)
                        .rev()
                        .map(|entry| entry.message.id)
                        .collect();
                    delta.published = Some(PublishedIds {
                        latest_id: latest,
                        added: if topic.published_total >= published {
                            topic.published_total - published
                        } else {
                            topic.published_total
                        },
                        overflow: new.len() > 100,
                        ids: new.into_iter().take(100).collect(),
                    });
                }
                _ => {}
            }
            cursor.topic = Some((topic.published_total, latest));
            if scope.deliveries {
                if let Some(seen) = cursor.fanouts {
                    // A topic created again counts its fanouts from zero.
                    let seen = if topic.fanouts < seen { 0 } else { seen };
                    if topic.fanouts > seen {
                        delta.deliveries = Some(fanouts_since(topic, seen));
                    }
                }
                cursor.fanouts = Some(topic.fanouts);
            }
        }
        if let Some(entry) = scope
            .subscription
            .as_ref()
            .and_then(|subscription| state.subscriptions.get(subscription))
        {
            if let Some(seen) = cursor.backlog
                && entry.change_sequence < seen
            {
                // The subscription was created again since the cursor.
                delta.backlog_reset = true;
            } else if let Some(seen) = cursor.backlog
                && entry.change_sequence > seen
            {
                let oldest = entry
                    .changes
                    .front()
                    .map_or(u64::MAX, |(sequence, _)| *sequence);
                if oldest > seen + 1 {
                    delta.backlog_reset = true;
                } else {
                    let keys: BTreeSet<BacklogKey> = entry
                        .changes
                        .iter()
                        .filter(|(sequence, _)| *sequence > seen)
                        .map(|(_, key)| *key)
                        .collect();
                    delta.backlog = keys.into_iter().collect();
                }
            }
            cursor.backlog = Some(entry.change_sequence);
        }
        cursor.revision = state.revision;
        delta
    }
}

fn counters_since(
    state: &State,
    consumers: &std::collections::HashMap<String, ConsumerCounts>,
    scope: &DeltaScope,
    since: u64,
    delta: &mut ConsoleDelta,
) {
    delta.resources = resources_since(state, since);
    let topic_prefix = format!("projects/{}/topics/", scope.project);
    let subscription_prefix = format!("projects/{}/subscriptions/", scope.project);
    // A topic's most-behind figure moves with its subscriptions.
    let mut changed_generations = BTreeSet::new();
    let mut subscriptions = Vec::new();
    for (name, entry) in &state.subscriptions {
        if entry.stamp <= since {
            continue;
        }
        changed_generations.insert(entry.topic_generation);
        if name.starts_with(&subscription_prefix) {
            subscriptions.push((name, entry));
        }
    }
    let topics: Vec<(&String, &TopicEntry)> = state
        .topics
        .iter()
        .filter(|(name, entry)| {
            name.starts_with(&topic_prefix)
                && (entry.stamp > since || changed_generations.contains(&entry.generation))
        })
        .collect();
    if scope.max_changed > 0 && topics.len() + subscriptions.len() > scope.max_changed {
        delta.overflow = true;
        return;
    }
    delta.topics = topics
        .into_iter()
        .map(|(name, entry)| topic_counters(state, name, entry))
        .collect();
    delta.subscriptions = subscriptions
        .into_iter()
        .map(|(name, entry)| subscription_counters(consumers, name, entry))
        .collect();
}

/// The kinds of resource stamped after `since`.
fn resources_since(state: &State, since: u64) -> Vec<ResourceKind> {
    let resources = state.resources;
    [
        (ResourceKind::Topics, resources.topics),
        (ResourceKind::Subscriptions, resources.subscriptions),
        (ResourceKind::Schemas, resources.schemas),
    ]
    .into_iter()
    .filter(|(_, stamp)| *stamp > since)
    .map(|(kind, _)| kind)
    .collect()
}

fn fanouts_since(topic: &TopicEntry, seen: u64) -> FanoutChanges {
    let added = topic.fanouts - seen;
    let oldest = topic
        .recent_fanouts
        .front()
        .map_or(u64::MAX, |(sequence, _)| *sequence);
    let mut event_ids = Vec::new();
    let mut message_ids = Vec::new();
    let mut overflow = oldest > seen + 1;
    for (_, id) in topic
        .recent_fanouts
        .iter()
        .rev()
        .take_while(|(sequence, _)| *sequence > seen)
    {
        let Ok(position) = topic
            .history
            .binary_search_by_key(id, |history| history.message.id)
        else {
            continue;
        };
        if message_ids.len() < 100 && !message_ids.contains(id) {
            message_ids.push(*id);
        }
        if let Some(fanout) = topic.history[position].fanout() {
            for target in fanout.targets {
                if event_ids.len() >= 100 {
                    overflow = true;
                    break;
                }
                if !event_ids.contains(&target.event_id) {
                    event_ids.push(target.event_id);
                }
            }
        }
    }
    FanoutChanges {
        added: u32::try_from(added).unwrap_or(u32::MAX),
        event_ids,
        message_ids,
        overflow,
    }
}

// ---------------------------------------------------------------- helpers

struct PageIds {
    ids: Vec<u64>,
    next: Option<u64>,
    prev: Option<u64>,
    total: u64,
    exact: bool,
    scanned: Option<u64>,
}

fn unfiltered_page(
    ring: &[Arc<HistoryEntry>],
    cursor: Option<u64>,
    before: Option<u64>,
    limit: usize,
) -> PageIds {
    let total = u64::try_from(ring.len()).unwrap_or(u64::MAX);
    let (start, end) = if let Some(before) = before {
        let start = ring.partition_point(|entry| entry.message.id <= before);
        (start, (start + limit).min(ring.len()))
    } else {
        let end = cursor.map_or(ring.len(), |cursor| {
            ring.partition_point(|entry| entry.message.id < cursor)
        });
        (end.saturating_sub(limit), end)
    };
    let ids: Vec<u64> = ring[start..end]
        .iter()
        .rev()
        .map(|entry| entry.message.id)
        .collect();
    PageIds {
        next: (start > 0).then(|| ids.last().copied()).flatten(),
        prev: (end < ring.len()).then(|| ids.first().copied()).flatten(),
        ids,
        total,
        exact: true,
        scanned: None,
    }
}

/// The subscriptions of a topic's current generation that still follow it.
fn live_members<'a>(
    state: &'a State,
    entry: &TopicEntry,
) -> Vec<(&'a String, &'a SubscriptionEntry)> {
    state
        .generations
        .get(&entry.generation)
        .map(|generation| {
            generation
                .members
                .iter()
                .filter_map(|name| {
                    let (name, subscription) = state.subscriptions.get_key_value(name)?;
                    (!subscription.topic_deleted).then_some((name, subscription))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn backlog_of(entry: &SubscriptionEntry) -> u64 {
    let counts = entry.index.counts;
    counts.available + counts.leased + counts.pushing
}

fn topic_counters(state: &State, name: &str, entry: &TopicEntry) -> TopicCounters {
    let most_behind = live_members(state, entry)
        .into_iter()
        .max_by(|(left_name, left), (right_name, right)| {
            backlog_of(left)
                .cmp(&backlog_of(right))
                .then_with(|| right_name.cmp(left_name))
        })
        .map(|(subscription, found)| MostBehind {
            subscription: subscription.clone(),
            backlog: backlog_of(found),
        });
    TopicCounters {
        name: name.to_owned(),
        published: entry.published_total,
        last_published_at: entry.last_published_at,
        latest_id: entry.latest_id,
        most_behind,
    }
}

fn subscription_counters(
    consumers: &std::collections::HashMap<String, ConsumerCounts>,
    name: &str,
    entry: &SubscriptionEntry,
) -> SubscriptionCountersView {
    SubscriptionCountersView {
        name: name.to_owned(),
        counts: entry.counts(),
        consumers: consumers.get(name).copied().unwrap_or_default(),
        last_pull_at: entry.last_pull,
    }
}

fn topic_summary(
    state: &State,
    consumers: &std::collections::HashMap<String, ConsumerCounts>,
    name: &str,
    entry: &TopicEntry,
) -> TopicSummary {
    let (project, id) = split_name("topics", name);
    TopicSummary {
        name: name.to_owned(),
        project,
        id,
        schema: entry
            .topic
            .schema_settings
            .as_ref()
            .map(|settings| settings.schema.clone()),
        counters: topic_counters(state, name, entry),
        subscriptions: live_members(state, entry)
            .into_iter()
            .map(|(member, subscription)| subscription_summary(consumers, member, subscription))
            .collect(),
    }
}

fn subscription_summary(
    consumers: &std::collections::HashMap<String, ConsumerCounts>,
    name: &str,
    entry: &SubscriptionEntry,
) -> SubscriptionSummary {
    let (project, id) = split_name("subscriptions", name);
    let subscription = &entry.subscription;
    SubscriptionSummary {
        name: name.to_owned(),
        project,
        id,
        topic: (!entry.topic_deleted).then(|| subscription.topic.clone()),
        push: entry.is_push(),
        ordering: subscription.enable_message_ordering,
        exactly_once: subscription.enable_exactly_once_delivery,
        dead_letter_topic: subscription
            .dead_letter_policy
            .as_ref()
            .map(|policy| policy.dead_letter_topic.clone()),
        filter: non_empty(&subscription.filter),
        counters: subscription_counters(consumers, name, entry),
    }
}

fn subscription_view(
    consumers: &std::collections::HashMap<String, ConsumerCounts>,
    name: &str,
    entry: &SubscriptionEntry,
) -> SubscriptionView {
    let subscription = &entry.subscription;
    let push = subscription.push_config.as_ref();
    SubscriptionView {
        summary: subscription_summary(consumers, name, entry),
        push_endpoint: push.and_then(|config| non_empty(&config.push_endpoint)),
        push_attributes: push
            .map(|config| config.attributes.clone().into_iter().collect())
            .unwrap_or_default(),
        ack_deadline_seconds: subscription.ack_deadline_seconds,
        retain_acked: subscription.retain_acked_messages,
        retention_seconds: duration_seconds(subscription.message_retention_duration.as_ref())
            .unwrap_or(604_800),
        expiration_ttl_seconds: subscription
            .expiration_policy
            .as_ref()
            .and_then(|policy| duration_seconds(policy.ttl.as_ref())),
        dead_letter: subscription.dead_letter_policy.as_ref().map(|policy| {
            (
                policy.dead_letter_topic.clone(),
                policy.max_delivery_attempts,
            )
        }),
        retry: subscription.retry_policy.as_ref().map(|policy| {
            let seconds = |duration: Option<&pbjson_types::Duration>| {
                duration.map_or(0.0, |duration| {
                    Duration::new(
                        u64::try_from(duration.seconds).unwrap_or(0),
                        u32::try_from(duration.nanos).unwrap_or(0),
                    )
                    .as_secs_f64()
                })
            };
            (
                seconds(policy.minimum_backoff.as_ref()),
                seconds(policy.maximum_backoff.as_ref()),
            )
        }),
        labels: subscription.labels.clone().into_iter().collect(),
        detached: entry.topic_deleted || subscription.detached,
        created_at: entry.created_at,
        dead_lettered_in_history: 0,
    }
}

fn schema_uses(state: &State, schema: &str) -> Vec<SchemaUse> {
    state
        .topics
        .iter()
        .filter_map(|(topic, entry)| {
            let settings = entry.topic.schema_settings.as_ref()?;
            (settings.schema == schema).then(|| SchemaUse {
                topic: topic.clone(),
                encoding: encoding_name(
                    entry
                        .schema
                        .as_ref()
                        .map_or(Encoding::Json, |bound| bound.encoding),
                ),
                first_revision_id: non_empty(&settings.first_revision_id),
                last_revision_id: non_empty(&settings.last_revision_id),
                bound_revision_id: entry
                    .schema
                    .as_ref()
                    .map(|bound| bound.revision_id.clone())
                    .unwrap_or_default(),
            })
        })
        .collect()
}

fn encoding_name(encoding: Encoding) -> &'static str {
    match encoding {
        Encoding::Binary => "BINARY",
        _ => "JSON",
    }
}

fn non_empty(text: &str) -> Option<String> {
    (!text.is_empty()).then(|| text.to_owned())
}

/// `(project, id)` of a resource name, empty parts when it does not parse.
fn split_name(collection: &str, name: &str) -> (String, String) {
    names::parse(collection, name).map_or_else(
        |_| {
            (
                String::new(),
                name.rsplit('/').next().unwrap_or(name).to_owned(),
            )
        },
        |parsed| (parsed.project, parsed.id),
    )
}

/// A tracked message's lease expiry and next push, on the wall clock.
fn times(tracked: &Tracked, now: Instant) -> (Option<SystemTime>, Option<SystemTime>, bool) {
    match tracked.state {
        MessageState::Leased { deadline, .. } => (Some(wall_clock(deadline)), None, false),
        MessageState::Pushing { next_attempt } => {
            // A push in flight is held far ahead until it finishes; a failed
            // one is due again within the retry interval.
            if next_attempt > now + PUSH_RETRY * 2 {
                (None, None, true)
            } else {
                (None, Some(wall_clock(next_attempt)), false)
            }
        }
        MessageState::Available | MessageState::Acked => (None, None, false),
    }
}

fn backlog_row(
    entry: &SubscriptionEntry,
    key: BacklogKey,
    tracked: &Tracked,
    place: Option<u64>,
    now: Instant,
) -> BacklogRow {
    let state = match tracked.state {
        MessageState::Available => BacklogState::Available,
        MessageState::Leased { .. } => BacklogState::Outstanding,
        MessageState::Pushing { .. } => BacklogState::Pushing,
        MessageState::Acked => BacklogState::Acked,
    };
    let (lease_expires_at, next_push_at, push_in_flight) = times(tracked, now);
    let ordering_key = &tracked.message.message.ordering_key;
    let blocked_by = (state == BacklogState::Available
        && entry.subscription.enable_message_ordering
        && !ordering_key.is_empty())
    .then(|| {
        entry
            .index
            .leased_keys
            .get(ordering_key)
            .and_then(|leased| leased.first().copied())
    })
    .flatten();
    BacklogRow {
        key,
        message: Arc::clone(&tracked.message),
        state,
        place,
        attempts: tracked.attempts,
        push_attempts: tracked.push_attempts,
        lease_expires_at,
        next_push_at,
        push_in_flight,
        blocked_by,
    }
}

/// The phases a state filter covers.
fn phases(state: Option<BacklogState>) -> (bool, bool, bool, bool) {
    match state {
        None => (true, true, true, true),
        Some(BacklogState::Outstanding) => (true, false, false, false),
        Some(BacklogState::Pushing) => (false, true, false, false),
        Some(BacklogState::Available) => (false, false, true, false),
        Some(BacklogState::Acked) => (false, false, false, true),
    }
}

/// Up to `limit` keys after `after` (exclusive) in delivery order.
fn backlog_keys_after(
    entry: &SubscriptionEntry,
    state: Option<BacklogState>,
    after: Option<BacklogKey>,
    limit: usize,
) -> Vec<BacklogKey> {
    let (leased, pushing, available, acked) = phases(state);
    let mut keys = Vec::with_capacity(limit.min(1_024));
    let index = &entry.index;
    let start = after.unwrap_or(BacklogKey {
        phase: 0,
        order: 0,
        id: 0,
    });
    let include_start = after.is_none();
    let past = |phase: u8, order: u64, id: u64| {
        let key = BacklogKey { phase, order, id };
        if include_start {
            key >= start
        } else {
            key > start
        }
    };
    if start.phase == 0 {
        let lower = (start.order, start.id);
        let mut first = index.leases.range(lower..).filter(|_| leased).peekable();
        let mut second = index.push_due.range(lower..).filter(|_| pushing).peekable();
        while keys.len() < limit {
            let next = match (first.peek(), second.peek()) {
                (Some(left), Some(right)) => {
                    if left <= right {
                        first.next()
                    } else {
                        second.next()
                    }
                }
                (Some(_), None) => first.next(),
                (None, Some(_)) => second.next(),
                (None, None) => break,
            };
            let Some((order, id)) = next.copied() else {
                break;
            };
            if past(0, order, id) {
                keys.push(BacklogKey {
                    phase: 0,
                    order,
                    id,
                });
            }
        }
    }
    if available && start.phase <= 1 && keys.len() < limit {
        let lower = if start.phase == 1 {
            (start.order, start.id)
        } else {
            (0, 0)
        };
        for (order, id) in index.available.range(lower..) {
            if keys.len() >= limit {
                break;
            }
            if past(1, *order, *id) {
                keys.push(BacklogKey {
                    phase: 1,
                    order: *order,
                    id: *id,
                });
            }
        }
    }
    if acked && keys.len() < limit {
        let lower = if start.phase == 2 { start.id } else { 0 };
        for id in index.acked.range(lower..) {
            if keys.len() >= limit {
                break;
            }
            if past(2, *id, *id) {
                keys.push(BacklogKey {
                    phase: 2,
                    order: *id,
                    id: *id,
                });
            }
        }
    }
    keys
}

/// Up to `limit` keys before `before` (exclusive), nearest first.
fn backlog_keys_before(
    entry: &SubscriptionEntry,
    state: Option<BacklogState>,
    before: BacklogKey,
    limit: usize,
) -> Vec<BacklogKey> {
    let (leased, pushing, available, acked) = phases(state);
    let index = &entry.index;
    let mut keys = Vec::with_capacity(limit.min(1_024));
    if acked && before.phase == 2 {
        for id in index.acked.range(..before.id).rev() {
            if keys.len() >= limit {
                return keys;
            }
            keys.push(BacklogKey {
                phase: 2,
                order: *id,
                id: *id,
            });
        }
    }
    if available && before.phase >= 1 {
        let range: Box<dyn DoubleEndedIterator<Item = &(u64, u64)>> = if before.phase == 1 {
            Box::new(index.available.range(..(before.order, before.id)))
        } else {
            Box::new(index.available.iter())
        };
        for (order, id) in range.rev() {
            if keys.len() >= limit {
                return keys;
            }
            keys.push(BacklogKey {
                phase: 1,
                order: *order,
                id: *id,
            });
        }
    }
    let range = |set: &'_ BTreeSet<(u64, u64)>, wanted: bool| -> Vec<(u64, u64)> {
        if !wanted {
            return Vec::new();
        }
        let iter: Box<dyn DoubleEndedIterator<Item = &(u64, u64)>> = if before.phase == 0 {
            Box::new(set.range(..(before.order, before.id)))
        } else {
            Box::new(set.iter())
        };
        iter.rev().take(limit).copied().collect()
    };
    let lease_pairs = range(&index.leases, leased);
    let push_pairs = range(&index.push_due, pushing);
    let mut first = lease_pairs.iter().peekable();
    let mut second = push_pairs.iter().peekable();
    while keys.len() < limit {
        let next = match (first.peek(), second.peek()) {
            (Some(left), Some(right)) => {
                if left >= right {
                    first.next()
                } else {
                    second.next()
                }
            }
            (Some(_), None) => first.next(),
            (None, Some(_)) => second.next(),
            (None, None) => break,
        };
        let Some((order, id)) = next.copied() else {
            break;
        };
        keys.push(BacklogKey {
            phase: 0,
            order,
            id,
        });
    }
    keys
}
