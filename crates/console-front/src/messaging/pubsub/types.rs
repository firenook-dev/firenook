//! The Pub/Sub console API's types, generated into
//! `console/src/api/generated/messaging/`. Times are RFC 3339 with
//! milliseconds; message ids travel as decimal strings; a field that points
//! into another section is an [`EntityRef`] built with its constructors.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::entity::EntityRef;
use crate::jobs::BulkTarget;
use crate::messaging::shared::MessagingSecondWindow;
use crate::paging::Page;

// ------------------------------------------------------------ topics

/// `GET /pubsub/topics`: every topic of the project, compact, answered whole
/// (one page holding every topic, `total` exact).
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubTopicIndex {
    #[serde(flatten)]
    #[ts(flatten)]
    pub page: Page<PubsubTopicSummary>,
    pub project: String,
    /// Projects other than this one that hold topics or subscriptions.
    pub other_projects: Vec<PubsubProjectCount>,
    /// Subscriptions whose topic was deleted (`_deleted-topic_`).
    pub detached: Vec<PubsubSubscriptionSummary>,
    /// The console revision the index was read at; `pubsub.counters`
    /// resumes from it.
    #[ts(type = "number")]
    pub revision: u64,
}

/// Topics and subscriptions under another project.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubProjectCount {
    pub project: String,
    pub topics: u32,
    pub subscriptions: u32,
}

/// Whether a topic is an app's or a schedule's.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export_to = "messaging/")]
pub(crate) enum PubsubTopicKind {
    /// A topic an app or the console created.
    User,
    /// `firebase-schedule-<function>`, created for an `onSchedule` export.
    Schedule,
}

/// A topic as the tree, the grid and search show it.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubTopicSummary {
    /// Full name, `projects/p/topics/t`.
    pub name: String,
    pub project: String,
    pub id: String,
    pub kind: PubsubTopicKind,
    /// The scheduled function's id, for a schedule topic.
    pub schedule_function: Option<String>,
    /// The bound schema's full name, or `_deleted-schema_`.
    pub schema: Option<String>,
    pub counters: PubsubTopicCounters,
    pub subscriptions: Vec<PubsubSubscriptionSummary>,
    /// Functions that receive every message published here.
    pub functions: Vec<PubsubFunctionTarget>,
}

/// A topic's figures.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubTopicCounters {
    pub name: String,
    /// Messages published since the emulator started.
    #[ts(type = "number")]
    pub published: u64,
    pub last_published_at: Option<String>,
    pub latest_message_id: Option<String>,
    /// The subscription with the largest backlog, the figure the tree shows.
    pub most_behind: Option<PubsubMostBehind>,
}

/// The most-behind subscription of a topic.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubMostBehind {
    pub subscription: String,
    #[ts(type = "number")]
    pub backlog: u64,
}

/// A topic's publishes per second over the last minute (sent only for the
/// topics on screen).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubThroughput {
    pub topic: String,
    pub window: MessagingSecondWindow,
}

/// What the console's history ring holds for one topic.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubHistoryWindow {
    pub messages: u32,
    #[ts(type = "number")]
    pub bytes: u64,
    pub oldest_id: Option<String>,
    pub capacity_messages: u32,
    #[ts(type = "number")]
    pub capacity_bytes: u64,
    /// Messages dropped from the ring since start (they may still be in
    /// subscriptions).
    #[ts(type = "number")]
    pub dropped: u64,
}

/// How a function receives a topic's messages.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export_to = "messaging/")]
pub(crate) enum PubsubTargetKind {
    /// A `CloudEvent` (`onMessagePublished`).
    Cloudevent,
    /// The first-generation event envelope (`pubsub.topic().onPublish`).
    Legacy,
    /// An `onSchedule` function's tick.
    Schedule,
}

/// A function listening on a topic.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubFunctionTarget {
    /// Region-qualified id, `us-central1-onOrderPlaced`.
    pub function_id: String,
    pub name: String,
    pub region: String,
    pub kind: PubsubTargetKind,
    /// `functions.function`, for the chip's link into Functions.
    pub entity: EntityRef,
}

/// Whether a subscription belongs to the functions consumer.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export_to = "messaging/")]
pub(crate) enum PubsubManaged {
    /// An ordinary subscription.
    No,
    /// `emulator-sub-<topic>` while the topic has function targets: drained
    /// at publish.
    Functions,
    /// `emulator-sub-<topic>` whose topic lost its targets: nothing drains it.
    Orphaned,
}

/// A subscription as the tree and the tables show it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubSubscriptionSummary {
    pub name: String,
    pub project: String,
    pub id: String,
    /// The topic's full name; `null` once the topic was deleted.
    pub topic: Option<String>,
    /// `pull` or `push`.
    pub delivery: String,
    pub managed: PubsubManaged,
    pub ordering: bool,
    pub exactly_once: bool,
    pub dead_letter_topic: Option<String>,
    pub filter: Option<String>,
    pub counters: PubsubSubscriptionCounters,
}

/// A subscription's figures.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubSubscriptionCounters {
    pub name: String,
    /// Not yet acknowledged: available, outstanding and pushing.
    #[ts(type = "number")]
    pub backlog: u64,
    #[ts(type = "number")]
    pub available: u64,
    /// Leased to a subscriber and not yet acknowledged.
    #[ts(type = "number")]
    pub outstanding: u64,
    #[ts(type = "number")]
    pub pushing: u64,
    /// Acknowledged and kept (retainAckedMessages, a snapshot, or another
    /// subscription still holding the message).
    #[ts(type = "number")]
    pub retained_acked: u64,
    /// Bytes of data and attributes in the backlog.
    #[ts(type = "number")]
    pub backlog_bytes: u64,
    pub oldest_unacked_at: Option<String>,
    /// Backlog messages delivered more than once.
    #[ts(type = "number")]
    pub redelivered: u64,
    #[ts(type = "number")]
    pub acked_total: u64,
    #[ts(type = "number")]
    pub dead_lettered_total: u64,
    /// Ordering keys currently waiting on an outstanding message.
    pub blocked_keys: u32,
    pub consumers: PubsubConsumers,
}

/// Who is consuming a subscription.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubConsumers {
    /// Streaming pulls open on this subscription.
    pub streaming: u32,
    /// Long-poll pulls waiting for a message.
    pub waiting_pulls: u32,
    pub last_pull_at: Option<String>,
}

/// `GET /pubsub/topic`.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubTopicDetail {
    pub summary: PubsubTopicSummary,
    pub labels: BTreeMap<String, String>,
    /// The topic's own message retention, seconds; `null` = none.
    #[ts(type = "number | null")]
    pub retention_seconds: Option<i64>,
    pub schema: Option<PubsubTopicSchema>,
    /// Stored `kmsKeyName`, never used by the emulator.
    pub kms_key_name: Option<String>,
    pub created_at: String,
    pub history: PubsubHistoryWindow,
    pub throughput: MessagingSecondWindow,
    pub subscriptions: Vec<PubsubSubscription>,
    /// Subscriptions that dead-letter into this topic.
    pub dead_letter_for: Vec<String>,
    /// Ordering keys seen on this topic, kept as messages arrive (newest 50).
    pub ordering_keys: Vec<String>,
    /// Attribute keys seen on this topic, kept as messages arrive (first 100).
    pub attribute_keys: Vec<String>,
}

/// A topic's schema binding.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubTopicSchema {
    /// The schema's full name, or `_deleted-schema_`.
    pub schema: String,
    pub deleted: bool,
    /// `JSON` or `BINARY`.
    pub encoding: String,
    pub first_revision_id: Option<String>,
    pub last_revision_id: Option<String>,
    /// The revision publishes are checked against.
    pub bound_revision_id: String,
}

/// A subscription's full configuration (settings tab, subscriptions table).
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubSubscription {
    pub summary: PubsubSubscriptionSummary,
    pub push_endpoint: Option<String>,
    /// Stored push attributes (the emulator does not send them).
    pub push_attributes: BTreeMap<String, String>,
    pub ack_deadline_seconds: i32,
    pub retain_acked: bool,
    #[ts(type = "number")]
    pub retention_seconds: i64,
    /// Stored expiration TTL; the emulator never expires a subscription.
    #[ts(type = "number | null")]
    pub expiration_ttl_seconds: Option<i64>,
    pub dead_letter: Option<PubsubDeadLetter>,
    pub retry: Option<PubsubRetry>,
    pub labels: BTreeMap<String, String>,
    pub detached: bool,
    pub created_at: String,
}

/// A dead-letter policy.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubDeadLetter {
    pub topic: String,
    pub max_delivery_attempts: i32,
}

/// A retry policy (stored; the emulator redelivers at once).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubRetry {
    pub minimum_backoff_seconds: f64,
    pub maximum_backoff_seconds: f64,
}

/// `GET /pubsub/subscription`.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubSubscriptionDetail {
    pub subscription: PubsubSubscription,
    /// The dead-letter topic's kept messages that came from this subscription.
    pub dead_lettered_in_history: u32,
}

// ------------------------------------------------------------ messages

/// How a payload preview is written.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export_to = "messaging/")]
pub(crate) enum PubsubPayloadEncoding {
    Json,
    Text,
    Binary,
}

/// The start of a message's data, for lists.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubPayloadPreview {
    pub encoding: PubsubPayloadEncoding,
    /// The first 256 characters (compact JSON or text), or for binary the
    /// base64 of the first 192 bytes.
    pub text: String,
    pub truncated: bool,
}

/// What became of a message at one subscription.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export_to = "messaging/")]
pub(crate) enum PubsubMessageState {
    Available,
    Outstanding,
    Pushing,
    /// Acknowledged: kept (retained) or let go (recorded on the history entry).
    Acked,
    DeadLettered,
    /// Taken by the functions consumer of an `emulator-sub-*` subscription.
    Drained,
    /// The subscription's filter did not pass it.
    Filtered,
    /// The subscription was created after this message (and saw no retained
    /// copy).
    NotTracked,
}

/// A message's state at one subscription.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubMessageAt {
    pub subscription: String,
    pub state: PubsubMessageState,
}

/// What became of a message at one function.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export_to = "messaging/")]
pub(crate) enum PubsubFunctionMark {
    /// Handed to the delivery queue; no invocation has begun.
    Queued,
    Running,
    Delivered,
    Failed,
    /// Not sent: background triggers were off.
    Skipped,
    /// Compute's record no longer holds the invocation.
    NotKept,
}

/// A message's mark at one function.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubFunctionMarkAt {
    pub function_id: String,
    pub mark: PubsubFunctionMark,
}

/// Where a message went, for a table row.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubDeliverySummary {
    /// Up to eight subscriptions; `more` counts the rest.
    pub subscriptions: Vec<PubsubMessageAt>,
    pub more: u32,
    pub functions: Vec<PubsubFunctionMarkAt>,
}

/// One message of a topic's history.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubMessageRow {
    pub id: String,
    pub publish_time: String,
    /// Data plus attributes plus ordering key, bytes.
    #[ts(type = "number")]
    pub size: u64,
    pub data: PubsubPayloadPreview,
    pub attributes: BTreeMap<String, String>,
    pub ordering_key: Option<String>,
    pub deliveries: PubsubDeliverySummary,
}

/// One message at one subscription, for the inspector.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubMessageAtSubscription {
    pub subscription: String,
    pub state: PubsubMessageState,
    pub attempts: u32,
    pub lease_expires_at: Option<String>,
    pub next_push_at: Option<String>,
    /// The subscription's filter, when it is what kept the message out.
    pub filtered_by: Option<String>,
}

/// One function delivery of one message (Deliveries tab, message inspector,
/// schedule runs).
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubDeliveryRow {
    pub message_id: String,
    pub published_at: String,
    pub function_id: String,
    pub function_name: String,
    /// `functions.function`.
    pub function_ref: EntityRef,
    /// The `CloudEvent` `id` (or the legacy `context.eventId`); the row key.
    pub event_id: String,
    pub mark: PubsubFunctionMark,
    /// Compute's invocation (`functions.invocation`), while its record holds
    /// it.
    pub invocation: Option<EntityRef>,
    pub started_at: Option<String>,
    pub duration_ms: Option<f64>,
    /// The Functions host's HTTP status.
    pub status: Option<u16>,
    /// The handler's error, first line.
    pub error: Option<String>,
    /// Why nothing was sent.
    pub skipped_reason: Option<String>,
    /// While queued: deliveries waiting for a dispatch slot.
    pub queue_depth: Option<u32>,
    /// A console redelivery, not the publish's own.
    pub redelivery: bool,
}

/// `GET /pubsub/deliveries`: a page plus the counts over the records kept.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubDeliveryPage {
    #[serde(flatten)]
    #[ts(flatten)]
    pub page: Page<PubsubDeliveryRow>,
    pub counts: PubsubDeliveryCounts,
}

/// Deliveries per mark, over the records kept.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubDeliveryCounts {
    /// Every record, those whose invocation is no longer kept included
    /// (their outcome is unknown, so no other count has them).
    pub all: u32,
    pub queued: u32,
    pub running: u32,
    pub delivered: u32,
    pub failed: u32,
    pub skipped: u32,
}

/// `GET /pubsub/dispatch`: the request a function received, or would have.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubDispatchBody {
    pub content_type: String,
    /// The first 256 KiB.
    pub body: String,
    pub truncated: bool,
    /// Rebuilt from the message and the target because compute's record is
    /// gone.
    pub rebuilt: bool,
}

/// `POST /pubsub/message/redeliver`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubRedelivery {
    pub event_id: String,
}

/// `POST /pubsub/message/redeliver` body.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubRedeliverBody {
    pub topic: String,
    pub message_id: String,
    pub function_id: String,
}

/// One streak of push attempts: consecutive attempts of one message with the
/// same outcome, updated in place while it grows (`pubsub.push` items).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubPushStreak {
    /// Stable for the streak; a new outcome starts a new one.
    pub streak: String,
    pub subscription: String,
    pub message_id: String,
    pub first_attempt: u32,
    pub last_attempt: u32,
    pub count: u32,
    pub first_at: String,
    pub last_at: String,
    pub status: Option<u16>,
    pub error: Option<String>,
    pub latency_ms: f64,
    /// The first 1 KiB of the latest response body.
    pub response: Option<String>,
}

/// `GET /pubsub/message`.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubMessageDetail {
    pub topic: String,
    pub id: String,
    pub publish_time: String,
    #[ts(type = "number")]
    pub size: u64,
    pub data_base64: String,
    /// The data as text, when it is valid UTF-8.
    pub data_text: Option<String>,
    /// Whether `dataText` parses as JSON.
    pub data_json: bool,
    pub attributes: BTreeMap<String, String>,
    pub ordering_key: Option<String>,
    /// From the `googclient_schema*` attributes.
    pub schema: Option<PubsubMessageSchema>,
    /// From the `CloudPubSubDeadLetter*` attributes.
    pub dead_letter_source: Option<PubsubDeadLetterSource>,
    pub subscriptions: Vec<PubsubMessageAtSubscription>,
    pub functions: Vec<PubsubDeliveryRow>,
    /// Streaks of push attempts of this message, newest first (at most 20).
    pub push: Vec<PubsubPushStreak>,
    /// Whether the message is still in the console's history ring.
    pub in_history: bool,
}

/// The schema a message was checked against.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubMessageSchema {
    pub schema: String,
    pub revision_id: String,
    pub encoding: String,
}

/// Where a dead-lettered message came from.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubDeadLetterSource {
    pub subscription: String,
    pub project: String,
    pub delivery_count: u32,
    pub original_publish_time: String,
}

/// A backlog row's state.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export_to = "messaging/")]
pub(crate) enum PubsubBacklogState {
    Available,
    Outstanding,
    Pushing,
    Acked,
}

/// One message of a subscription's backlog, without leasing it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubBacklogRow {
    /// The row key: the delivery-order position `phase.order.id`, so a moved
    /// message is a new key.
    pub key: String,
    pub id: String,
    pub state: PubsubBacklogState,
    /// For an available message: its place in the delivery order, 1 = the
    /// next pull's first.
    #[ts(type = "number | null")]
    pub place: Option<u64>,
    pub attempts: u32,
    pub lease_expires_at: Option<String>,
    pub next_push_at: Option<String>,
    pub publish_time: String,
    #[ts(type = "number")]
    pub size: u64,
    pub data: PubsubPayloadPreview,
    pub attributes: BTreeMap<String, String>,
    pub ordering_key: Option<String>,
    /// The outstanding message this one waits for (same ordering key).
    pub blocked_by: Option<String>,
}

// ------------------------------------------------------------ publishing

/// One message's data as the console sends it.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) enum PubsubData {
    /// UTF-8 text.
    Text(String),
    /// JSON text; checked, then sent as its UTF-8 bytes.
    Json(String),
    /// Bytes, base64.
    Base64(String),
    /// JSON sent as Avro binary for the topic's bound schema.
    AvroJson(String),
}

/// A message as the console writes it.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubOutgoingMessage {
    pub data: PubsubData,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub attributes: BTreeMap<String, String>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub ordering_key: Option<String>,
}

/// `POST /pubsub/topic/publish`: one request, at once.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubPublishBody {
    pub topic: String,
    /// 1 to 1,000 (more, a repeat or an interval is a `pubsub.publish` job).
    pub messages: Vec<PubsubOutgoingMessage>,
    /// Expand `{{i}}`, `{{uuid}}`, `{{now}}`, `{{ts}}` in data and attribute
    /// values.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub template: bool,
    /// Answer `PubsubPreview` (message 1 as it would be sent) and publish
    /// nothing.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub dry_run: bool,
}

/// What a publish did.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubPublishResult {
    pub message_ids: Vec<String>,
    pub subscriptions: u32,
    pub functions: u32,
    /// Function targets skipped because background triggers are paused (the
    /// events were dropped, not queued): a fact of this publish.
    pub functions_skipped: u32,
}

/// `dryRun: true` on `POST /pubsub/topic/publish`: message 1 as the publish
/// would send it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubPreview {
    pub data_text: Option<String>,
    pub data_base64: Option<String>,
    pub attributes: BTreeMap<String, String>,
    pub ordering_key: Option<String>,
    /// "Message 1 is not valid JSON after expansion: …".
    pub problem: Option<String>,
}

/// `POST /pubsub/messages:publish`: publish many, again, or on an interval,
/// as a foundation `Job` (kind `pubsub.publish`); progress is the `Job` on
/// the `jobs` topic.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubPublishJobBody {
    pub topic: String,
    /// Messages in the topic's history to publish again: `Keys` (message
    /// ids) or `Query { q, scope }` with scope `{"topic":…,"expr":…}`.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub target: Option<BulkTarget>,
    /// Or new messages: the composer's draft, or a file's lines (at most 64
    /// MiB in all).
    #[serde(default)]
    #[ts(optional = nullable)]
    pub messages: Vec<PubsubOutgoingMessage>,
    /// Publish each message this many times (1 to 1,000), refused past 64
    /// MiB in all.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub repeat: Option<u32>,
    /// 0 (at once, in batches of 1,000), 100, 1,000 or 5,000 ms between
    /// messages.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub interval_ms: u32,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub template: bool,
}

/// A request the wire refused, coalesced by operation, resource and error.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubRejected {
    pub first_at: String,
    pub last_at: String,
    pub count: u32,
    /// `publish`, `pull`, `streaming-pull`, `create-subscription`.
    pub operation: String,
    /// The full name the app used.
    pub resource: String,
    /// The engine's answer, verbatim, and its code name.
    pub error: String,
    pub code: String,
    /// The nearest existing id in the same project, when one is close.
    pub suggestion: Option<String>,
    /// A project where this id exists, when the app used another.
    pub elsewhere: Option<String>,
}

/// `GET /pubsub/rejected`: one page holding every kept refusal.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubRejectedList {
    #[serde(flatten)]
    #[ts(flatten)]
    pub page: Page<PubsubRejected>,
    /// Refusals evicted from the 200-entry ring since start.
    #[ts(type = "number")]
    pub dropped: u64,
    /// Bumped by every refusal; `pubsub.counters`' `rejected` event carries
    /// it.
    #[ts(type = "number")]
    pub revision: u64,
}

// ------------------------------------------------------------ resources

/// A topic's schema binding, as a create or an update sends it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubSchemaBinding {
    pub schema: String,
    /// `JSON` or `BINARY`.
    pub encoding: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub first_revision_id: Option<String>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub last_revision_id: Option<String>,
}

/// `POST /pubsub/topics`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubCreateTopicBody {
    pub name: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub labels: BTreeMap<String, String>,
    #[serde(default)]
    #[ts(optional = nullable, type = "number | null")]
    pub retention_seconds: Option<i64>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub schema: Option<PubsubSchemaBinding>,
    /// Also create `<id>-sub` (a pull subscription with the defaults).
    #[serde(default)]
    #[ts(optional = nullable)]
    pub default_subscription: bool,
}

/// `PATCH /pubsub/topic`: `mask` names what changes (`retention`, `schema`).
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubUpdateTopicBody {
    pub name: String,
    pub mask: Vec<String>,
    #[serde(default)]
    #[ts(optional = nullable, type = "number | null")]
    pub retention_seconds: Option<i64>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub schema: Option<PubsubSchemaBinding>,
}

/// `DELETE /pubsub/topic`.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubDeleteTopicBody {
    pub name: String,
    /// `keep` leaves them detached (`_deleted-topic_`); `delete` removes them.
    pub subscriptions: PubsubDeleteSubscriptions,
}

/// What deleting a topic does to its subscriptions.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export_to = "messaging/")]
pub(crate) enum PubsubDeleteSubscriptions {
    Keep,
    Delete,
}

/// `POST /pubsub/subscriptions`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubCreateSubscriptionBody {
    pub name: String,
    pub topic: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub ack_deadline_seconds: Option<i32>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub push_endpoint: Option<String>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub push_attributes: BTreeMap<String, String>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub filter: Option<String>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub ordering: bool,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub exactly_once: bool,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub retain_acked: bool,
    #[serde(default)]
    #[ts(optional = nullable, type = "number | null")]
    pub retention_seconds: Option<i64>,
    #[serde(default)]
    #[ts(optional = nullable, type = "number | null")]
    pub expiration_ttl_seconds: Option<i64>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub dead_letter: Option<PubsubDeadLetter>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub retry: Option<PubsubRetry>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub labels: BTreeMap<String, String>,
}

/// `PATCH /pubsub/subscription`: `mask` names any of `ackDeadline`, `push`,
/// `retainAcked`, `retention`, `deadLetter`, `retry`, `exactlyOnce` (the
/// engine refuses changes to the topic, the filter, ordering, the
/// expiration and labels).
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubUpdateSubscriptionBody {
    pub name: String,
    pub mask: Vec<String>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub ack_deadline_seconds: Option<i32>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub push_endpoint: Option<String>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub push_attributes: BTreeMap<String, String>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub retain_acked: bool,
    #[serde(default)]
    #[ts(optional = nullable, type = "number | null")]
    pub retention_seconds: Option<i64>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub dead_letter: Option<PubsubDeadLetter>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub retry: Option<PubsubRetry>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub exactly_once: bool,
}

/// `DELETE /pubsub/subscription`, `DELETE /pubsub/snapshot`, `DELETE
/// /pubsub/schema`: a resource by its full name.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubNameBody {
    pub name: String,
}

/// `POST /pubsub/subscription/push-config`.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubPushConfigBody {
    pub subscription: String,
    /// `null` switches to pull.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub endpoint: Option<String>,
}

/// `POST /pubsub/message/ack` and `/message/release`: one message at one
/// subscription.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubMessageActionBody {
    pub subscription: String,
    pub message_id: String,
}

/// What `POST /pubsub/subscription/purge` left in the subscription.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubPurged {
    #[ts(type = "number")]
    pub available: u64,
    /// Acknowledged messages it keeps (`retainAckedMessages`).
    #[ts(type = "number")]
    pub acked: u64,
}

/// `POST /pubsub/backlog:ack` and `/backlog:release`.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubBacklogJobBody {
    pub subscription: String,
    pub target: BulkTarget,
}

// ------------------------------------------------------------ schemas

/// A schema as the list shows it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubSchemaSummary {
    pub name: String,
    pub project: String,
    pub id: String,
    /// `AVRO` (the only type the emulator runs).
    pub kind: String,
    pub revisions: u32,
    pub latest_revision_id: String,
    pub latest_created_at: String,
    pub used_by: Vec<String>,
}

/// One revision of a schema.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubSchemaRevision {
    pub id: String,
    pub created_at: String,
    pub definition: String,
}

/// A topic bound to a schema.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubSchemaUse {
    pub topic: String,
    pub encoding: String,
    pub first_revision_id: Option<String>,
    pub last_revision_id: Option<String>,
    pub bound_revision_id: String,
}

/// `GET /pubsub/schema`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubSchemaDetail {
    pub name: String,
    pub project: String,
    pub id: String,
    pub kind: String,
    /// Oldest first, as the engine lists them.
    pub revisions: Vec<PubsubSchemaRevision>,
    pub used_by: Vec<PubsubSchemaUse>,
}

/// `POST /pubsub/schemas`.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubCreateSchemaBody {
    pub name: String,
    /// `AVRO`.
    pub kind: String,
    pub definition: String,
}

/// `POST /pubsub/schema/commit`.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubCommitSchemaBody {
    pub name: String,
    pub definition: String,
}

/// `POST /pubsub/schema/check`.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubSchemaCheckBody {
    /// `AVRO`.
    pub kind: String,
    pub definition: String,
}

/// Whether a schema definition would be accepted, and why not.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubSchemaCheck {
    pub ok: bool,
    /// What a create would answer (`Could not parse schema definition`).
    pub engine_message: Option<String>,
    /// The Avro parser's own reason.
    pub reason: Option<String>,
    /// One-based, when the reason has a position (JSON syntax errors).
    pub line: Option<u32>,
    pub column: Option<u32>,
}

/// `POST /pubsub/schema/validate-message`.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubMessageCheckBody {
    /// A schema name, optionally `name@revision` (the composer names the
    /// topic's bound revision).
    pub schema: String,
    /// `JSON` or `BINARY`.
    pub encoding: String,
    pub data: PubsubData,
}

/// Where a message stops matching a schema.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubSchemaProblem {
    /// A JSON path into the message, `$.items[2].price`.
    pub path: String,
    pub expected: String,
    pub found: String,
}

/// Whether a message matches a schema.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubMessageCheck {
    pub ok: bool,
    /// What a publish would answer (`Could not parse message`), when it fails.
    pub engine_message: Option<String>,
    pub problem: Option<PubsubSchemaProblem>,
}

/// `POST /pubsub/schema/example`: a topic (its bound revision), or a
/// definition not yet saved.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubSchemaExampleBody {
    #[serde(default)]
    #[ts(optional = nullable)]
    pub topic: Option<String>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub definition: Option<String>,
}

/// An example message for a schema.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubSchemaExample {
    pub json: Option<String>,
    pub problem: Option<String>,
}

/// `POST /pubsub/filter/check`.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubFilterCheckBody {
    pub filter: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub topic: Option<String>,
}

/// Whether a subscription filter parses, and what it would pass.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubFilterCheck {
    pub ok: bool,
    pub message: Option<String>,
    /// UTF-16 offset of the problem in the filter text.
    pub position: Option<u32>,
    /// What creating the subscription would answer.
    pub engine_message: Option<String>,
    /// Messages of the topic's history checked (at most 5,000) and passed.
    pub checked: u32,
    pub matched: u32,
    pub sample_ids: Vec<String>,
}

// ------------------------------------------------------------ schedules

/// One run of a schedule.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubScheduleRun {
    pub at: String,
    /// `clock` or `console`.
    pub trigger: String,
    pub message_id: Option<String>,
    /// Why nothing was published (background triggers off, the broker
    /// refused).
    pub skipped: Option<String>,
    /// The tick's delivery to the function, while compute's record holds it.
    pub delivery: Option<PubsubDeliveryRow>,
}

/// One scheduled function.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubSchedule {
    pub function_id: String,
    /// `functions.function`, for the link back to Functions.
    pub function_ref: EntityRef,
    pub function_name: String,
    pub region: String,
    pub topic: String,
    /// Other functions (other regions, one name) publishing to the same topic.
    pub shares_topic_with: Vec<String>,
    pub expression: String,
    pub time_zone: Option<String>,
    /// The zone the engine evaluates the expression in.
    pub evaluated_in: String,
    /// Whether the clock runs it (an expression the engine cannot evaluate
    /// runs only from the console).
    pub automatic: bool,
    pub problem: Option<String>,
    pub paused: bool,
    pub next_run_at: Option<String>,
    /// The next five runs.
    pub upcoming: Vec<String>,
    #[ts(type = "number")]
    pub runs: u64,
    /// The first run since start, kept for good.
    pub first_run: Option<PubsubScheduleRun>,
    /// The nineteen latest, newest first.
    pub last_runs: Vec<PubsubScheduleRun>,
    /// Runs between the first and the kept latest.
    #[ts(type = "number")]
    pub omitted_runs: u64,
}

/// `POST /pubsub/schedule/run`, `/pause`, `/resume`: the function id the
/// scheduler is keyed by.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubScheduleBody {
    pub function_id: String,
}

// ------------------------------------------------------------ setup

/// `GET /pubsub/setup` and `POST /pubsub/setup/import`: resources, never
/// messages. Version 2 carries every schema revision in order.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubSetup {
    /// `2`.
    pub version: u32,
    pub project: String,
    pub schemas: Vec<PubsubSetupSchema>,
    /// Topic bindings name exported revision ids; the import rewrites them.
    pub topics: Vec<PubsubCreateTopicBody>,
    pub subscriptions: Vec<PubsubCreateSubscriptionBody>,
}

/// A schema with every revision.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubSetupSchema {
    pub name: String,
    pub kind: String,
    /// Oldest first.
    pub revisions: Vec<PubsubSetupRevision>,
}

/// One schema revision of a setup.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubSetupRevision {
    pub id: String,
    pub definition: String,
}

/// A resource an import left alone, and why.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubSetupSkip {
    pub name: String,
    pub reason: String,
}

/// An exported revision id and the one the import created for it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubRevisionMapping {
    pub schema: String,
    pub exported: String,
    pub created: String,
}

/// What an import did.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubSetupResult {
    pub created: Vec<String>,
    pub skipped: Vec<PubsubSetupSkip>,
    pub revisions: Vec<PubsubRevisionMapping>,
}

// ------------------------------------------------------------ live events

/// `pubsub.counters` `counters`: the entities stamped after the
/// subscriber's revision.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubCountersFrame {
    #[ts(type = "number")]
    pub revision: u64,
    pub topics: Vec<PubsubTopicCounters>,
    pub subscriptions: Vec<PubsubSubscriptionCounters>,
    /// Only for the topics the subscription named in `throughput`.
    pub throughput: Vec<PubsubThroughput>,
}

/// `pubsub.counters` `resources`: which kinds of resource changed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubResourcesChanged {
    /// Any of `topics`, `subscriptions`, `snapshots`, `schemas`.
    pub kinds: Vec<String>,
}

/// `pubsub.counters` `rejected`: the refusals changed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubRejectedChanged {
    #[ts(type = "number")]
    pub revision: u64,
}

/// `pubsub.topic` `published`: new messages of the topic.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubPublished {
    pub latest_id: String,
    #[ts(type = "number")]
    pub added: u64,
    /// This topic's new ids, at most 100.
    pub ids: Vec<String>,
    /// More than 100 arrived in this window.
    pub overflow: bool,
}

/// `pubsub.topic` `stale`: keys of rows to read again.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubStale {
    /// `backlog:<row key>` (old and new keys of a moved row), `snapshots`,
    /// or `message:<id>`.
    pub keys: Vec<String>,
}

/// `pubsub.deliveries` `changed`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubDeliveriesChanged {
    /// Event ids of deliveries whose outcome changed (at most 100).
    pub keys: Vec<String>,
    /// New fanout records since the last event.
    pub added: u32,
    pub overflow: bool,
}

/// One schedule's state, as `pubsub.schedules` patches it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubScheduleState {
    pub function_id: String,
    pub paused: bool,
    pub automatic: bool,
    pub next_run_at: Option<String>,
    #[ts(type = "number")]
    pub runs: u64,
    pub last_run_at: Option<String>,
    pub last_outcome: Option<PubsubFunctionMark>,
}

/// `pubsub.schedules` `schedules`: the schedules that changed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubSchedulesFrame {
    #[ts(type = "number")]
    pub revision: u64,
    pub schedules: Vec<PubsubScheduleState>,
}

/// `pubsub.push` `attempts`: the newest copy of each streak in the window
/// (the shape the topic writes from the ring's serialized streaks).
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[allow(dead_code, reason = "the topic joins the ring's JSON into this shape")]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "messaging/")]
pub(crate) struct PubsubPushAttempts {
    pub items: Vec<PubsubPushStreak>,
}
