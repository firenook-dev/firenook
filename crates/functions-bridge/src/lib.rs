//! Firebase Functions event bridge for the firenook emulator suite.
//!
//! Registration and event envelopes are derived from permanent captures of
//! the official emulator. Firenook owns trigger matching and delivery while a
//! Node Functions host executes the user's JavaScript handlers.

#![forbid(unsafe_code)]

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::fmt::{self, Display, Formatter};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use firenook_core_store::{
    Change, CommitObservation, CommitObserver, CommitOrigin, Document, DocumentKey,
};
use firenook_grpc_front::google::firestore::v1 as firestore_proto;
use prost::Message as _;
use serde_json::{Value as JsonValue, json};
use sha2::{Digest as _, Sha256};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

const FIRESTORE_SERVICE: &str = "firestore.googleapis.com";
const V1_CREATE: &str = "providers/cloud.firestore/eventTypes/document.create";
const V1_UPDATE: &str = "providers/cloud.firestore/eventTypes/document.update";
const V1_DELETE: &str = "providers/cloud.firestore/eventTypes/document.delete";
const V1_WRITE: &str = "providers/cloud.firestore/eventTypes/document.write";
const V2_CREATED: &str = "google.cloud.firestore.document.v1.created";
const V2_UPDATED: &str = "google.cloud.firestore.document.v1.updated";
const V2_DELETED: &str = "google.cloud.firestore.document.v1.deleted";
const V2_WRITTEN: &str = "google.cloud.firestore.document.v1.written";
const AUTH_CONTEXT_SUFFIX: &str = ".withAuthContext";
/// Response header the owned runtime sets to `handled` once a worker answered.
pub const DELIVERY_HEADER: &str = "x-firenook-delivery";
/// `DELIVERY_HEADER` value meaning the handler executed (no retry).
pub const DELIVERY_HANDLED: &str = "handled";
/// The emulated Firestore database location every v2 event carries.
const EMULATED_LOCATION: &str = "us-central1";
const FIRESTORE_EVENT_DATA_SCHEMA: &str = "https://github.com/googleapis/google-cloudevents/blob/main/proto/google/events/cloud/firestore/v1/data.proto";

/// The headers a background event's sender adds to its dispatch so the
/// Functions runtime can say what caused an invocation without parsing the
/// event body. Every `x-firenook-*` header is a control header: the runtime
/// strips the whole family before the worker or user code sees the request.
///
/// Values are written with [`encode`](cause::encode): visible ASCII stays as
/// it is and every other byte (`%`, spaces, line breaks, non-ASCII) is
/// percent-encoded, so a document path or an object name of any shape is a
/// valid header value; [`decode`](cause::decode) reads it back.
pub mod cause {
    /// Every cause header starts with this.
    pub const PREFIX: &str = "x-firenook-cause-";
    /// A Firestore document path, relative to its database's documents.
    pub const DOCUMENT: &str = "x-firenook-cause-document";
    /// A Firestore database id, such as `(default)`.
    pub const DATABASE: &str = "x-firenook-cause-database";
    /// A Firestore change: `created`, `updated` or `deleted`.
    pub const CHANGE: &str = "x-firenook-cause-change";
    /// A Pub/Sub topic's full resource name, `projects/<p>/topics/<t>`.
    pub const TOPIC: &str = "x-firenook-cause-topic";
    /// A Pub/Sub message id.
    pub const MESSAGE: &str = "x-firenook-cause-message";
    /// An Auth user's uid.
    pub const UID: &str = "x-firenook-cause-uid";
    /// An Auth user's email, when the user has one.
    pub const EMAIL: &str = "x-firenook-cause-email";
    /// An Auth user's tenant, for a tenant's user.
    pub const TENANT: &str = "x-firenook-cause-tenant";
    /// A Storage bucket.
    pub const BUCKET: &str = "x-firenook-cause-bucket";
    /// A Storage object name.
    pub const OBJECT: &str = "x-firenook-cause-object";
    /// The Auth emulator's id for a blocking call.
    pub const AUTH_CALL: &str = "x-firenook-cause-auth-call";
    /// The event's own id: the `CloudEvent` `id` or the legacy envelope's
    /// `eventId`, which other records join an invocation by.
    pub const EVENT_ID: &str = "x-firenook-event-id";

    /// `value` as a header value: visible ASCII but `%` unchanged, every
    /// other byte as `%XX`.
    #[must_use]
    pub fn encode(value: &str) -> String {
        const HEX: &[u8; 16] = b"0123456789ABCDEF";
        let mut encoded = String::with_capacity(value.len());
        for &byte in value.as_bytes() {
            if (0x21..=0x7e).contains(&byte) && byte != b'%' {
                encoded.push(char::from(byte));
            } else {
                encoded.push('%');
                encoded.push(char::from(HEX[usize::from(byte >> 4)]));
                encoded.push(char::from(HEX[usize::from(byte & 0x0f)]));
            }
        }
        encoded
    }

    /// A header value written by [`encode`], read back. A `%` not followed
    /// by two hex digits is kept as it is; bytes that are not UTF-8 become
    /// the replacement character.
    #[must_use]
    pub fn decode(value: &str) -> String {
        fn hex(byte: u8) -> Option<u8> {
            char::from(byte)
                .to_digit(16)
                .and_then(|digit| u8::try_from(digit).ok())
        }
        let bytes = value.as_bytes();
        let mut decoded = Vec::with_capacity(bytes.len());
        let mut index = 0;
        while index < bytes.len() {
            if bytes[index] == b'%'
                && let (Some(high), Some(low)) = (
                    bytes.get(index + 1).copied().and_then(hex),
                    bytes.get(index + 2).copied().and_then(hex),
                )
            {
                decoded.push(high << 4 | low);
                index += 3;
            } else {
                decoded.push(bytes[index]);
                index += 1;
            }
        }
        String::from_utf8_lossy(&decoded).into_owned()
    }
}

/// Shared trigger inventory populated by the Functions workload host.
#[derive(Clone)]
pub struct TriggerRegistry {
    inner: Arc<Mutex<RegistryState>>,
    /// Background delivery as last set, for whoever watches it (the
    /// console shows a pause the moment a test harness makes it).
    background: Arc<tokio::sync::watch::Sender<bool>>,
    /// Events that reached no function while delivery was paused.
    dropped: Arc<DroppedCounters>,
}

impl Default for TriggerRegistry {
    fn default() -> Self {
        Self {
            inner: Arc::default(),
            background: Arc::new(tokio::sync::watch::Sender::new(true)),
            dropped: Arc::default(),
        }
    }
}

/// A source of background events that can be dropped while delivery is
/// paused.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum DroppedService {
    /// A Firestore change some trigger would have matched.
    Firestore,
    /// An Auth lifecycle event.
    Auth,
    /// A Storage object event.
    Storage,
    /// A Pub/Sub message for a topic with function targets.
    Pubsub,
    /// A scheduled function's tick.
    Schedule,
}

impl DroppedService {
    /// Every service, in the order counts are reported.
    pub const ALL: [Self; 5] = [
        Self::Firestore,
        Self::Auth,
        Self::Storage,
        Self::Pubsub,
        Self::Schedule,
    ];

    /// `firestore`, `auth`, `storage`, `pubsub`, `schedule`.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Firestore => "firestore",
            Self::Auth => "auth",
            Self::Storage => "storage",
            Self::Pubsub => "pubsub",
            Self::Schedule => "schedule",
        }
    }

    const fn index(self) -> usize {
        match self {
            Self::Firestore => 0,
            Self::Auth => 1,
            Self::Storage => 2,
            Self::Pubsub => 3,
            Self::Schedule => 4,
        }
    }
}

/// Events that reached no function since delivery was paused.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DroppedEvents {
    /// When delivery was paused; `None` while it is enabled.
    pub since: Option<OffsetDateTime>,
    /// Each service that dropped something, with how many, in
    /// [`DroppedService::ALL`] order.
    pub counts: Vec<(DroppedService, u64)>,
}

/// Per-service counters, one atomic add per dropped event.
struct DroppedCounters {
    counts: [AtomicU64; 5],
    since: Mutex<Option<OffsetDateTime>>,
    /// Ticks on every count and every reset.
    changes: tokio::sync::watch::Sender<u64>,
}

impl Default for DroppedCounters {
    fn default() -> Self {
        Self {
            counts: Default::default(),
            since: Mutex::new(None),
            changes: tokio::sync::watch::Sender::new(0),
        }
    }
}

impl DroppedCounters {
    fn reset(&self, since: Option<OffsetDateTime>) {
        for count in &self.counts {
            count.store(0, Ordering::Release);
        }
        *lock(&self.since) = since;
        self.changes
            .send_modify(|ticks| *ticks = ticks.wrapping_add(1));
    }
}

struct RegistryState {
    v1: BTreeMap<(String, String), Trigger>,
    v2: BTreeMap<(String, String), Trigger>,
    background_enabled: bool,
}

impl Default for RegistryState {
    fn default() -> Self {
        Self {
            v1: BTreeMap::new(),
            v2: BTreeMap::new(),
            background_enabled: true,
        }
    }
}

/// Parsed Firestore trigger registration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Trigger {
    /// Firebase project owning this registration.
    pub project: String,
    /// Functions emulator trigger key, including region when provided.
    pub key: String,
    /// Trigger generation and event envelope.
    pub generation: TriggerGeneration,
    /// Registered Firestore event type.
    pub event_type: String,
    /// Database filter, normally `(default)`.
    pub database: String,
    /// Relative document path pattern.
    pub document_pattern: String,
}

/// Firebase trigger generation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TriggerGeneration {
    /// Legacy background event JSON envelope.
    V1,
    /// `CloudEvents` binary-mode protobuf envelope.
    V2,
}

/// One backend returned by the pinned Functions emulator `/backends` API.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FunctionBackend {
    /// Functions codebase identifier when supplied by discovery.
    #[serde(default)]
    pub codebase: Option<String>,
    /// Functions discovered from this source directory.
    #[serde(default)]
    pub function_triggers: Vec<FunctionDefinition>,
}

/// Function definition used by suite routing and scheduler discovery.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FunctionDefinition {
    /// Region-qualified Functions emulator id.
    #[serde(default)]
    pub id: String,
    /// Exported function name.
    pub name: String,
    /// Deployment region.
    #[serde(default)]
    pub region: String,
    /// Deployment regions used by pinned gcfv1 Extension definitions.
    #[serde(default)]
    pub regions: Vec<String>,
    /// v1 or v2 platform label.
    pub platform: String,
    /// Background event metadata.
    #[serde(default)]
    pub event_trigger: Option<FunctionEventTrigger>,
    /// Schedule metadata for `onSchedule` handlers.
    #[serde(default)]
    pub schedule: Option<FunctionSchedule>,
    /// Presence identifies HTTP and callable handlers.
    #[serde(default)]
    pub https_trigger: Option<JsonValue>,
    /// `onTaskDispatched` queue settings (`retryConfig`, `rateLimits`), the
    /// document the Functions emulator registers with the Tasks emulator.
    #[serde(default)]
    pub task_queue_trigger: Option<JsonValue>,
}

/// Discovered background event filter.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FunctionEventTrigger {
    /// Event type, including the Functions emulator's `pubsub` schedule marker.
    pub event_type: String,
    /// Fully qualified topic or provider resource.
    #[serde(default)]
    pub resource: String,
    /// Eventarc equality filters.
    #[serde(default)]
    pub event_filters: BTreeMap<String, String>,
}

/// Discovered Cloud Scheduler expression.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FunctionSchedule {
    /// Firebase schedule expression.
    pub schedule: String,
    /// Optional IANA time zone.
    #[serde(default)]
    pub time_zone: Option<String>,
}

/// Complete Functions discovery response.
#[derive(Debug, Clone)]
pub struct FunctionsInventory {
    /// Discovered codebase backends.
    pub backends: Vec<FunctionBackend>,
    /// Trigger-key generation of the event definitions (`<id>-<generation>`).
    pub generation: u32,
}

impl FunctionsInventory {
    /// Builds the inventory from an in-process `/backends` document.
    pub fn from_backends_json(json: &JsonValue, generation: u32) -> Result<Self, BridgeError> {
        #[derive(serde::Deserialize)]
        struct Response {
            #[serde(default)]
            backends: Vec<FunctionBackend>,
        }
        let mut response: Response = serde_json::from_value(json.clone()).map_err(|error| {
            BridgeError(format!("invalid Functions inventory document: {error}"))
        })?;
        normalize_inventory(&mut response.backends)?;
        Ok(Self {
            backends: response.backends,
            generation,
        })
    }

    /// Fetches the pinned workload host's `/backends` inventory.
    pub async fn discover(endpoint: &str) -> Result<Self, BridgeError> {
        #[derive(serde::Deserialize)]
        struct Response {
            #[serde(default)]
            backends: Vec<FunctionBackend>,
        }

        let endpoint = reqwest::Url::parse(endpoint)
            .map_err(|error| BridgeError(format!("invalid Functions endpoint: {error}")))?;
        let url = endpoint
            .join("backends")
            .map_err(|error| BridgeError(format!("invalid Functions discovery URL: {error}")))?;
        let response = reqwest::Client::new()
            .get(url)
            .send()
            .await
            .map_err(|error| BridgeError(format!("Functions discovery failed: {error}")))?;
        if !response.status().is_success() {
            return Err(BridgeError(format!(
                "Functions discovery returned {}",
                response.status()
            )));
        }
        let body = response
            .bytes()
            .await
            .map_err(|error| BridgeError(format!("Functions discovery body failed: {error}")))?;
        let mut response = serde_json::from_slice::<Response>(&body)
            .map_err(|error| BridgeError(format!("invalid Functions discovery body: {error}")))?;
        normalize_inventory(&mut response.backends)?;
        Ok(Self {
            backends: response.backends,
            generation: 0,
        })
    }

    /// All discovered function definitions in stable backend order.
    pub fn functions(&self) -> impl Iterator<Item = &FunctionDefinition> {
        self.backends
            .iter()
            .flat_map(|backend| backend.function_triggers.iter())
    }
}

fn normalize_inventory(backends: &mut [FunctionBackend]) -> Result<(), BridgeError> {
    for backend in backends {
        for function in &mut backend.function_triggers {
            if function.region.is_empty() {
                function.region = function.regions.first().cloned().ok_or_else(|| {
                    BridgeError(format!(
                        "Function {} has neither region nor regions",
                        function.name
                    ))
                })?;
            }
            if function.id.is_empty() {
                function.id = format!("{}-{}", function.region, function.name);
            }
        }
    }
    Ok(())
}

/// Invalid Functions trigger registration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegistrationError(String);

impl Display for RegistrationError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for RegistrationError {}

impl TriggerRegistry {
    /// Registers or replaces a v1 Firestore background trigger.
    pub fn register_v1(
        &self,
        project: &str,
        key: &str,
        body: &JsonValue,
    ) -> Result<(), RegistrationError> {
        let event = body
            .get("eventTrigger")
            .and_then(JsonValue::as_object)
            .ok_or_else(|| invalid("eventTrigger object is required"))?;
        let event_type = required_string(event.get("eventType"), "eventTrigger.eventType")?;
        let service = required_string(event.get("service"), "eventTrigger.service")?;
        if service != FIRESTORE_SERVICE {
            return Err(invalid(
                "only Firestore trigger registrations are supported",
            ));
        }
        let resource = required_string(event.get("resource"), "eventTrigger.resource")?;
        let (resource_project, database, document_pattern) = parse_v1_resource(resource)?;
        if resource_project != project {
            return Err(invalid(
                "trigger resource project does not match request project",
            ));
        }
        validate_event_type(TriggerGeneration::V1, event_type)?;
        let trigger = Trigger {
            project: project.to_owned(),
            key: key.to_owned(),
            generation: TriggerGeneration::V1,
            event_type: event_type.to_owned(),
            database,
            document_pattern,
        };
        lock(&self.inner)
            .v1
            .insert((project.to_owned(), key.to_owned()), trigger);
        Ok(())
    }

    /// Removes a v1 trigger. Deleting an unknown key is idempotent.
    pub fn remove_v1(&self, project: &str, key: &str) {
        lock(&self.inner)
            .v1
            .remove(&(project.to_owned(), key.to_owned()));
    }

    /// Removes a v2 trigger. Deleting an unknown key is idempotent.
    pub fn remove_v2(&self, project: &str, key: &str) {
        lock(&self.inner)
            .v2
            .remove(&(project.to_owned(), key.to_owned()));
    }

    /// Registers or replaces a v2 Eventarc Firestore trigger.
    pub fn register_v2(
        &self,
        project: &str,
        key: &str,
        body: &JsonValue,
    ) -> Result<(), RegistrationError> {
        let event_type = required_string(body.get("eventType"), "eventType")?;
        validate_event_type(TriggerGeneration::V2, event_type)?;
        let database = required_string(body.get("database"), "database")?;
        let document = body
            .get("document")
            .and_then(JsonValue::as_object)
            .ok_or_else(|| invalid("document object is required"))?;
        let document_pattern = required_string(document.get("value"), "document.value")?;
        // EXACT filters (a document path without wildcards) match the same
        // way as a pattern without captures.
        if !matches!(
            document.get("matchType").and_then(JsonValue::as_str),
            Some("PATH_PATTERN" | "EXACT")
        ) {
            return Err(invalid("document.matchType must be PATH_PATTERN or EXACT"));
        }
        validate_document_pattern(document_pattern)?;
        let trigger = Trigger {
            project: project.to_owned(),
            key: key.to_owned(),
            generation: TriggerGeneration::V2,
            event_type: event_type.to_owned(),
            database: database.to_owned(),
            document_pattern: document_pattern.to_owned(),
        };
        lock(&self.inner)
            .v2
            .insert((project.to_owned(), key.to_owned()), trigger);
        Ok(())
    }

    /// Enables or disables background event delivery without deleting
    /// inventory. Pausing starts the dropped counts from zero with the
    /// pause time; resuming clears them. Watchers of
    /// [`TriggerRegistry::background_watch`] see the change.
    pub fn set_background_enabled(&self, enabled: bool) {
        let changed = {
            let mut state = lock(&self.inner);
            let changed = state.background_enabled != enabled;
            state.background_enabled = enabled;
            changed
        };
        if changed {
            self.dropped.reset((!enabled).then(OffsetDateTime::now_utc));
        }
        self.background.send_if_modified(|current| {
            let changed = *current != enabled;
            *current = enabled;
            changed
        });
    }

    /// Background delivery as it is now, then every change, from the hub's
    /// switches and the console's alike.
    #[must_use]
    pub fn background_watch(&self) -> tokio::sync::watch::Receiver<bool> {
        self.background.subscribe()
    }

    /// Counts one event of `service` that reached no function because
    /// background delivery is paused. One atomic add; never blocks on I/O.
    /// Every source calls it where it returns early while paused.
    pub fn note_dropped(&self, service: DroppedService) {
        self.note_dropped_many(service, 1);
    }

    /// Counts `count` events of `service` at once (a Pub/Sub publish of
    /// several messages); nothing for zero.
    pub fn note_dropped_many(&self, service: DroppedService, count: u64) {
        if count == 0 {
            return;
        }
        self.dropped.counts[service.index()].fetch_add(count, Ordering::AcqRel);
        self.dropped
            .changes
            .send_modify(|ticks| *ticks = ticks.wrapping_add(1));
    }

    /// The events dropped since delivery was paused.
    #[must_use]
    pub fn dropped(&self) -> DroppedEvents {
        let since = *lock(&self.dropped.since);
        DroppedEvents {
            since,
            counts: DroppedService::ALL
                .into_iter()
                .map(|service| {
                    (
                        service,
                        self.dropped.counts[service.index()].load(Ordering::Acquire),
                    )
                })
                .filter(|(_, count)| *count > 0)
                .collect(),
        }
    }

    /// Ticks whenever [`TriggerRegistry::dropped`] may have changed.
    #[must_use]
    pub fn dropped_changes(&self) -> tokio::sync::watch::Receiver<u64> {
        self.dropped.changes.subscribe()
    }

    /// Whether background delivery is currently enabled by the Emulator Hub.
    #[must_use]
    pub fn background_enabled(&self) -> bool {
        lock(&self.inner).background_enabled
    }

    /// Returns registrations matching one effective document transition.
    /// While background delivery is paused it returns none, and counts the
    /// change as dropped when some trigger would have matched it.
    #[must_use]
    pub fn matching(&self, change: &Change) -> Vec<Trigger> {
        let state = lock(&self.inner);
        if !state.background_enabled {
            let would_match = state
                .v1
                .values()
                .chain(state.v2.values())
                .any(|trigger| trigger.matches(change));
            drop(state);
            if would_match {
                self.note_dropped(DroppedService::Firestore);
            }
            return Vec::new();
        }
        state
            .v1
            .values()
            .chain(state.v2.values())
            .filter(|trigger| trigger.matches(change))
            .cloned()
            .collect()
    }

    /// Returns all registrations in deterministic generation/key order.
    #[must_use]
    pub fn all(&self) -> Vec<Trigger> {
        let state = lock(&self.inner);
        state
            .v1
            .values()
            .chain(state.v2.values())
            .cloned()
            .collect()
    }
}

impl Trigger {
    /// The Functions emulator's trigger key, region included when given.
    #[must_use]
    pub fn key(&self) -> &str {
        &self.key
    }

    /// The registered Firestore event type, such as
    /// `google.cloud.firestore.document.v1.written`.
    #[must_use]
    pub fn event_type(&self) -> &str {
        &self.event_type
    }

    fn matches(&self, change: &Change) -> bool {
        change.key.database().project_id() == self.project
            && change.key.database().database_id() == self.database
            && event_matches(&self.event_type, change)
            && path_matches(&self.document_pattern, change.key.path())
    }
}

/// The shape of a document change, without its documents.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ChangeShape {
    /// The document did not exist before.
    Created,
    /// The document existed before and after.
    Updated,
    /// The document no longer exists.
    Deleted,
}

impl ChangeShape {
    /// The shape of an effective change; `None` when nothing existed before
    /// or after.
    #[must_use]
    pub fn of(change: &Change) -> Option<Self> {
        match (change.before.is_some(), change.after.is_some()) {
            (false, true) => Some(Self::Created),
            (true, true) => Some(Self::Updated),
            (true, false) => Some(Self::Deleted),
            (false, false) => None,
        }
    }

    /// `created`, `updated` or `deleted`.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Created => "created",
            Self::Updated => "updated",
            Self::Deleted => "deleted",
        }
    }
}

/// Whether a trigger fires for a change, and why not when it does not.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MatchExplanation {
    /// The trigger fires for the change.
    pub fires: bool,
    /// Why, the first condition that failed in the order the bridge checks
    /// them: database, event, path.
    pub reason: MatchReason,
}

/// Why a trigger fires for a change or not.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MatchReason {
    /// Every condition holds.
    Fires,
    /// The trigger listens on another database, the one named.
    OtherDatabase(String),
    /// The trigger listens for another event, the event type named, which
    /// this shape of change does not raise.
    OtherEvent(String),
    /// The change's path is outside the trigger's document pattern, the one
    /// named.
    PathDoesNotMatch(String),
}

/// Whether `trigger` fires for a change of `shape` at `path` (relative to the
/// database's documents) in `database`, and why not. The same conditions the
/// bridge applies to a commit, without the documents.
#[must_use]
pub fn explain_match(
    trigger: &Trigger,
    database: &str,
    path: &str,
    shape: ChangeShape,
) -> MatchExplanation {
    let reason = if trigger.database != database {
        MatchReason::OtherDatabase(trigger.database.clone())
    } else if !shape_matches(&trigger.event_type, shape) {
        MatchReason::OtherEvent(trigger.event_type.clone())
    } else if !path_matches(&trigger.document_pattern, path) {
        MatchReason::PathDoesNotMatch(trigger.document_pattern.clone())
    } else {
        MatchReason::Fires
    };
    MatchExplanation {
        fires: reason == MatchReason::Fires,
        reason,
    }
}

/// HTTP request delivered to the Node Functions workload host.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DispatchRequest {
    /// Functions host path.
    pub path: String,
    /// Ordered HTTP headers.
    pub headers: BTreeMap<String, String>,
    /// Exact request body.
    pub body: Vec<u8>,
    /// Stable event id shared across retries.
    pub event_id: String,
}

/// Constructs an oracle-compatible Functions dispatch request.
pub fn build_dispatch(
    trigger: &Trigger,
    observation: &CommitObservation,
    change_index: usize,
) -> Result<DispatchRequest, RegistrationError> {
    let change = observation
        .changes
        .get(change_index)
        .ok_or_else(|| invalid("change index is outside the commit observation"))?;
    if !trigger.matches(change) {
        return Err(invalid("trigger does not match the selected change"));
    }
    let event_id = stable_event_id(trigger, observation, change_index, change);
    let path = format!(
        "/functions/projects/{}/triggers/{}",
        trigger.project, trigger.key
    );
    match trigger.generation {
        TriggerGeneration::V1 => build_v1_dispatch(trigger, change, path, event_id),
        TriggerGeneration::V2 => build_v2_dispatch(trigger, change, path, event_id),
    }
}

fn build_v1_dispatch(
    trigger: &Trigger,
    change: &Change,
    path: String,
    event_id: String,
) -> Result<DispatchRequest, RegistrationError> {
    let value = optional_document_json(&change.key, change.after.as_deref())?;
    let old_value = optional_document_json(&change.key, change.before.as_deref())?;
    let mut data = serde_json::Map::new();
    if let Some(value) = value {
        data.insert("value".to_owned(), value);
    }
    if let Some(old_value) = old_value {
        data.insert("oldValue".to_owned(), old_value);
    }
    data.insert("updateMask".to_owned(), json!({}));
    let timestamp = format_timestamp(event_timestamp(change))?;
    let mut headers = BTreeMap::from([("content-type".to_owned(), "application/json".to_owned())]);
    insert_cause_headers(&mut headers, trigger, change, &event_id);
    let body = json!({
        "data": data,
        "context": {
            "eventId": event_id,
            "timestamp": timestamp,
            "eventType": trigger.event_type,
            "resource": {
                "name": change.key.to_string(),
                "service": FIRESTORE_SERVICE
            }
        }
    });
    let body = serde_json::to_vec(&body)
        .map_err(|error| invalid(format!("failed to encode v1 dispatch: {error}")))?;
    Ok(DispatchRequest {
        path,
        headers,
        body,
        event_id,
    })
}

/// What caused a Firestore dispatch, for the Functions runtime's record:
/// the document, its database, the change and the event id.
fn insert_cause_headers(
    headers: &mut BTreeMap<String, String>,
    trigger: &Trigger,
    change: &Change,
    event_id: &str,
) {
    headers.insert(cause::DOCUMENT.to_owned(), cause::encode(change.key.path()));
    headers.insert(cause::DATABASE.to_owned(), cause::encode(&trigger.database));
    if let Some(shape) = ChangeShape::of(change) {
        headers.insert(cause::CHANGE.to_owned(), shape.as_str().to_owned());
    }
    headers.insert(cause::EVENT_ID.to_owned(), cause::encode(event_id));
}

fn build_v2_dispatch(
    trigger: &Trigger,
    change: &Change,
    path: String,
    event_id: String,
) -> Result<DispatchRequest, RegistrationError> {
    let value = optional_proto_document(&change.key, change.after.as_deref())?;
    let old_value = optional_proto_document(&change.key, change.before.as_deref())?;
    let protobuf = DocumentEventData {
        value,
        old_value,
        update_mask: Some(firestore_proto::DocumentMask::default()),
    }
    .encode_to_vec();
    // The official Java emulator sends Base64 text here despite declaring an
    // application/protobuf body. firebase-tools depends on that wire quirk.
    let body = BASE64.encode(protobuf).into_bytes();
    let timestamp = format_seconds_timestamp(event_timestamp(change))?;
    let source = format!(
        "//firestore.googleapis.com/projects/projects/{}/databases/{}",
        trigger.project, trigger.database
    );
    let document = change.key.path().to_owned();
    let mut headers = BTreeMap::from([
        ("ce-specversion".to_owned(), "1.0".to_owned()),
        ("ce-type".to_owned(), trigger.event_type.clone()),
        ("ce-source".to_owned(), source),
        ("ce-id".to_owned(), event_id.clone()),
        ("ce-subject".to_owned(), format!("documents/{document}")),
        ("ce-time".to_owned(), timestamp),
        (
            "ce-datacontenttype".to_owned(),
            "application/protobuf".to_owned(),
        ),
        (
            "ce-dataschema".to_owned(),
            FIRESTORE_EVENT_DATA_SCHEMA.to_owned(),
        ),
        ("ce-location".to_owned(), EMULATED_LOCATION.to_owned()),
        ("ce-project".to_owned(), trigger.project.clone()),
        ("ce-database".to_owned(), trigger.database.clone()),
        ("ce-namespace".to_owned(), "(default)".to_owned()),
        ("ce-document".to_owned(), document),
        ("content-type".to_owned(), "application/protobuf".to_owned()),
    ]);
    if trigger.event_type.ends_with(AUTH_CONTEXT_SUFFIX) {
        // The official Firestore emulator reports every writer with these
        // fixed values (recorded in functions-runtime-v1).
        headers.insert("ce-authtype".to_owned(), "unknown".to_owned());
        headers.insert("ce-authid".to_owned(), "fake-auth-id@gmail.com".to_owned());
    }
    insert_cause_headers(&mut headers, trigger, change, &event_id);
    Ok(DispatchRequest {
        path,
        headers,
        body,
        event_id,
    })
}

#[derive(Clone, PartialEq, prost::Message)]
struct DocumentEventData {
    #[prost(message, optional, tag = "1")]
    value: Option<firestore_proto::Document>,
    #[prost(message, optional, tag = "2")]
    old_value: Option<firestore_proto::Document>,
    #[prost(message, optional, tag = "3")]
    update_mask: Option<firestore_proto::DocumentMask>,
}

/// A second-generation Firestore event body read back into REST documents:
/// `{"value": document or null, "oldValue": document or null}`, each
/// document exactly as a first-generation event carries it.
///
/// The body is what the bridge sends, Base64 text of a `DocumentEventData`
/// message (the official emulator's wire quirk); a raw protobuf body is read
/// too, as the Functions runtime accepts both.
pub fn decode_document_event(body: &[u8]) -> Result<JsonValue, BridgeError> {
    let bytes = BASE64.decode(body).unwrap_or_else(|_| body.to_vec());
    let event = DocumentEventData::decode(bytes.as_slice()).map_err(|error| {
        BridgeError(format!(
            "the body is not a Firestore document event: {error}"
        ))
    })?;
    Ok(json!({
        "value": rest_document(event.value)?,
        "oldValue": rest_document(event.old_value)?,
    }))
}

/// One event document as REST JSON, after reading it the way a write is
/// read (its name and every value checked).
fn rest_document(document: Option<firestore_proto::Document>) -> Result<JsonValue, BridgeError> {
    let Some(document) = document else {
        return Ok(JsonValue::Null);
    };
    let (key, _) = firenook_grpc_front::decode_document(document.clone()).map_err(|status| {
        BridgeError(format!(
            "the event holds a document Firestore cannot read: {}",
            status.message()
        ))
    })?;
    let mut json = serde_json::to_value(firestore_proto::Document {
        name: key.to_string(),
        ..document
    })
    .map_err(|error| BridgeError(format!("failed to encode document JSON: {error}")))?;
    utc_timestamps_as_z(&mut json);
    Ok(json)
}

fn optional_proto_document(
    key: &DocumentKey,
    document: Option<&Document>,
) -> Result<Option<firestore_proto::Document>, RegistrationError> {
    document
        .map(|document| {
            firenook_grpc_front::encode_document(key, document)
                .map_err(|error| invalid(format!("failed to encode Firestore document: {error}")))
        })
        .transpose()
}

fn optional_document_json(
    key: &DocumentKey,
    document: Option<&Document>,
) -> Result<Option<JsonValue>, RegistrationError> {
    optional_proto_document(key, document)?
        .map(|document| {
            let mut json = serde_json::to_value(document)
                .map_err(|error| invalid(format!("failed to encode document JSON: {error}")))?;
            utc_timestamps_as_z(&mut json);
            Ok(json)
        })
        .transpose()
}

/// pbjson writes timestamps with a `+00:00` offset; the official emulator
/// and the firebase-functions v1 decoder expect the `Z` form (its nanosecond
/// parsing reads the characters after the seconds up to a trailing `Z`).
fn utc_timestamps_as_z(value: &mut JsonValue) {
    match value {
        JsonValue::String(text) => {
            if let Some(prefix) = text.strip_suffix("+00:00")
                && prefix.len() >= 19
                && prefix.as_bytes()[10] == b'T'
                && prefix.as_bytes()[4] == b'-'
            {
                *text = format!("{prefix}Z");
            }
        }
        JsonValue::Array(items) => items.iter_mut().for_each(utc_timestamps_as_z),
        JsonValue::Object(map) => map.values_mut().for_each(utc_timestamps_as_z),
        _ => {}
    }
}

fn event_timestamp(change: &Change) -> firenook_core_store::Timestamp {
    change.after.as_deref().map_or_else(
        || {
            change
                .before
                .as_deref()
                .expect("effective change")
                .update_time()
        },
        Document::update_time,
    )
}

fn format_timestamp(
    timestamp: firenook_core_store::Timestamp,
) -> Result<String, RegistrationError> {
    OffsetDateTime::from_unix_timestamp(timestamp.seconds())
        .and_then(|value| value.replace_nanosecond(timestamp.nanos()))
        .map_err(|error| invalid(format!("invalid event timestamp: {error}")))?
        .format(&Rfc3339)
        .map_err(|error| invalid(format!("failed to format event timestamp: {error}")))
}

fn format_seconds_timestamp(
    timestamp: firenook_core_store::Timestamp,
) -> Result<String, RegistrationError> {
    OffsetDateTime::from_unix_timestamp(timestamp.seconds())
        .map_err(|error| invalid(format!("invalid event timestamp: {error}")))?
        .format(&Rfc3339)
        .map_err(|error| invalid(format!("failed to format event timestamp: {error}")))
}

fn stable_event_id(
    trigger: &Trigger,
    observation: &CommitObservation,
    change_index: usize,
    change: &Change,
) -> String {
    let mut digest = Sha256::new();
    digest.update(trigger.project.as_bytes());
    digest.update([0]);
    digest.update(trigger.key.as_bytes());
    digest.update([0]);
    digest.update(observation.result.revision.get().to_be_bytes());
    digest.update(change_index.to_be_bytes());
    digest.update(change.key.to_string().as_bytes());
    let bytes = digest.finalize();
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0],
        bytes[1],
        bytes[2],
        bytes[3],
        bytes[4],
        bytes[5],
        bytes[6],
        bytes[7],
        bytes[8],
        bytes[9],
        bytes[10],
        bytes[11],
        bytes[12],
        bytes[13],
        bytes[14],
        bytes[15]
    )
}

fn parse_v1_resource(resource: &str) -> Result<(String, String, String), RegistrationError> {
    let marker = "/documents/";
    let (database_resource, pattern) = resource
        .split_once(marker)
        .ok_or_else(|| invalid("eventTrigger.resource must contain /documents/"))?;
    let segments = database_resource.split('/').collect::<Vec<_>>();
    if segments.len() != 4 || segments[0] != "projects" || segments[2] != "databases" {
        return Err(invalid(
            "eventTrigger.resource has an invalid database name",
        ));
    }
    validate_document_pattern(pattern)?;
    Ok((
        segments[1].to_owned(),
        segments[3].to_owned(),
        pattern.to_owned(),
    ))
}

fn validate_document_pattern(pattern: &str) -> Result<(), RegistrationError> {
    if pattern.is_empty() || pattern.starts_with('/') || pattern.ends_with('/') {
        return Err(invalid(
            "document pattern must be a non-empty relative path",
        ));
    }
    let mut segments = 0_usize;
    for segment in pattern.split('/') {
        if segment.is_empty() || segment.starts_with('{') != segment.ends_with('}') {
            return Err(invalid("document pattern contains an invalid segment"));
        }
        segments += 1;
    }
    if !segments.is_multiple_of(2) {
        return Err(invalid("document pattern must identify documents"));
    }
    Ok(())
}

fn validate_event_type(
    generation: TriggerGeneration,
    event_type: &str,
) -> Result<(), RegistrationError> {
    let supported = match generation {
        TriggerGeneration::V1 => [V1_CREATE, V1_UPDATE, V1_DELETE, V1_WRITE].contains(&event_type),
        TriggerGeneration::V2 => {
            let base = event_type
                .strip_suffix(AUTH_CONTEXT_SUFFIX)
                .unwrap_or(event_type);
            [V2_CREATED, V2_UPDATED, V2_DELETED, V2_WRITTEN].contains(&base)
        }
    };
    if supported {
        Ok(())
    } else {
        Err(invalid(format!(
            "unsupported Firestore event type: {event_type}"
        )))
    }
}

fn event_matches(event_type: &str, change: &Change) -> bool {
    ChangeShape::of(change).is_some_and(|shape| shape_matches(event_type, shape))
}

/// Whether a change of `shape` raises `event_type`.
fn shape_matches(event_type: &str, shape: ChangeShape) -> bool {
    let event_type = event_type
        .strip_suffix(AUTH_CONTEXT_SUFFIX)
        .unwrap_or(event_type);
    match shape {
        ChangeShape::Created => {
            matches!(event_type, V1_CREATE | V1_WRITE | V2_CREATED | V2_WRITTEN)
        }
        ChangeShape::Updated => {
            matches!(event_type, V1_UPDATE | V1_WRITE | V2_UPDATED | V2_WRITTEN)
        }
        ChangeShape::Deleted => {
            matches!(event_type, V1_DELETE | V1_WRITE | V2_DELETED | V2_WRITTEN)
        }
    }
}

fn path_matches(pattern: &str, path: &str) -> bool {
    let pattern = pattern.split('/').collect::<Vec<_>>();
    let path = path.split('/').collect::<Vec<_>>();
    match_segments(&pattern, &path)
}

fn match_segments(pattern: &[&str], path: &[&str]) -> bool {
    let Some((head, tail)) = pattern.split_first() else {
        return path.is_empty();
    };
    if is_recursive_wildcard(head) {
        return (1..=path.len()).any(|consumed| match_segments(tail, &path[consumed..]));
    }
    let Some((value, remaining)) = path.split_first() else {
        return false;
    };
    (is_single_wildcard(head) || head == value) && match_segments(tail, remaining)
}

fn is_single_wildcard(segment: &str) -> bool {
    segment.starts_with('{')
        && segment.ends_with('}')
        && !segment.ends_with("=**}")
        && !segment.contains('/')
}

fn is_recursive_wildcard(segment: &str) -> bool {
    segment.starts_with('{') && segment.ends_with("=**}")
}

fn required_string<'a>(
    value: Option<&'a JsonValue>,
    field: &str,
) -> Result<&'a str, RegistrationError> {
    value
        .and_then(JsonValue::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid(format!("{field} must be a non-empty string")))
}

fn invalid(message: impl Into<String>) -> RegistrationError {
    RegistrationError(message.into())
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Store observer that turns matching commits into Functions dispatch requests.
///
/// Network delivery is added by the runtime owner; this observer deliberately
/// exposes a callback so unit and chaos tests can validate queue semantics.
pub struct TriggerObserver {
    registry: TriggerRegistry,
    sender: tokio::sync::mpsc::UnboundedSender<DispatchRequest>,
    depth: Arc<QueueDepth>,
}

/// How many dispatches wait for the delivery runtime to take them.
#[derive(Default)]
struct QueueDepth {
    queued: AtomicUsize,
    /// Woken whenever the depth falls.
    fell: tokio::sync::Notify,
}

impl QueueDepth {
    /// Sends `request`, counting it while it waits.
    fn send(
        &self,
        sender: &tokio::sync::mpsc::UnboundedSender<DispatchRequest>,
        request: DispatchRequest,
    ) -> Result<(), BridgeError> {
        // Counted before it can be taken, so the count never goes below
        // what is queued.
        self.queued.fetch_add(1, Ordering::AcqRel);
        sender.send(request).map_err(|_| {
            self.taken();
            BridgeError("Functions delivery runtime is stopped".to_owned())
        })
    }

    /// One dispatch was taken (admitted or deduplicated) or never queued.
    fn taken(&self) {
        let _ = self
            .queued
            .try_update(Ordering::AcqRel, Ordering::Acquire, |queued| {
                Some(queued.saturating_sub(1))
            });
        self.fell.notify_waiters();
    }
}

/// Cloneable producer for non-Firestore background events.
#[derive(Clone)]
pub struct DispatchQueue {
    sender: tokio::sync::mpsc::UnboundedSender<DispatchRequest>,
    depth: Arc<QueueDepth>,
}

impl DispatchQueue {
    /// Enqueues one event before the Firestore/Pub/Sub shared dedupe boundary.
    pub fn enqueue(&self, request: DispatchRequest) -> Result<(), BridgeError> {
        self.depth.send(&self.sender, request)
    }

    /// Dispatches queued and not yet taken by the delivery runtime (every
    /// producer of this queue's runtime counted, Firestore's observer
    /// included). A receiver taken straight from [`TriggerObserver::channel`]
    /// takes without counting down; the delivery runtime counts.
    #[must_use]
    pub fn depth(&self) -> usize {
        self.depth.queued.load(Ordering::Acquire)
    }

    /// Resolves once fewer than `n` dispatches are queued, or when the
    /// delivery runtime has stopped (nothing will take them any more). A
    /// bulk producer awaits it between batches so it never floods the
    /// queue.
    pub async fn wait_below(&self, n: usize) {
        loop {
            let fell = self.depth.fell.notified();
            tokio::pin!(fell);
            fell.as_mut().enable();
            if self.depth() < n {
                return;
            }
            tokio::select! {
                () = &mut fell => {}
                () = self.sender.closed() => return,
            }
        }
    }
}

impl TriggerObserver {
    /// Creates an observer and its lossless in-process delivery receiver.
    #[must_use]
    pub fn channel(
        registry: TriggerRegistry,
    ) -> (
        Arc<Self>,
        tokio::sync::mpsc::UnboundedReceiver<DispatchRequest>,
    ) {
        let (sender, receiver) = tokio::sync::mpsc::unbounded_channel();
        (
            Arc::new(Self {
                registry,
                sender,
                depth: Arc::default(),
            }),
            receiver,
        )
    }

    /// Queue producer sharing this observer's dedupe and delivery worker.
    #[must_use]
    pub fn queue(&self) -> DispatchQueue {
        DispatchQueue {
            sender: self.sender.clone(),
            depth: Arc::clone(&self.depth),
        }
    }
}

impl CommitObserver for TriggerObserver {
    /// Queues every trigger a client commit's changes match. Housekeeping
    /// commits (`Store::commit_maintenance`, such as the console's reset)
    /// fire no trigger: they are neither delivered nor counted as dropped
    /// while background triggers are paused.
    fn committed(&self, observation: &CommitObservation) {
        if observation.origin == CommitOrigin::Maintenance {
            return;
        }
        for (change_index, change) in observation.changes.iter().enumerate() {
            for trigger in self.registry.matching(change) {
                if let Ok(request) = build_dispatch(&trigger, observation, change_index) {
                    let _ = self.depth.send(&self.sender, request);
                }
            }
        }
    }
}

/// Bounded delivery and retry settings for the local Node workload host.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DeliveryPolicy {
    /// Maximum concurrently executing background handlers.
    pub max_concurrent: usize,
    /// Maximum attempts for definite pre-handler failures and retryable HTTP responses.
    pub max_attempts: usize,
    /// Initial exponential retry delay.
    pub initial_retry_delay: Duration,
    /// Maximum exponential retry delay.
    pub maximum_retry_delay: Duration,
    /// TCP connection timeout.
    pub connect_timeout: Duration,
    /// End-to-end request timeout. A timeout after connection is treated as
    /// ambiguous delivery and is not retried, preventing duplicate effects.
    pub request_timeout: Duration,
    /// Completed or in-flight event ids retained for duplicate suppression.
    pub dedupe_capacity: usize,
}

impl Default for DeliveryPolicy {
    fn default() -> Self {
        Self {
            max_concurrent: 32,
            max_attempts: 5,
            initial_retry_delay: Duration::from_millis(25),
            maximum_retry_delay: Duration::from_secs(1),
            connect_timeout: Duration::from_secs(2),
            request_timeout: Duration::from_secs(120),
            dedupe_capacity: 100_000,
        }
    }
}

/// Point-in-time Functions delivery telemetry.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct DeliveryHealth {
    /// Unique requests admitted by the coordinator.
    pub admitted: u64,
    /// Duplicate stable event ids suppressed before invocation.
    pub deduplicated: u64,
    /// Requests acknowledged with a successful HTTP response.
    pub delivered: u64,
    /// Requests considered delivered after the host accepted the connection
    /// but its response was lost or timed out.
    pub assumed_delivered_after_response_loss: u64,
    /// Additional attempts after the first request.
    pub retries: u64,
    /// Permanently failed deliveries.
    pub failed: u64,
    /// Most recent permanent failure.
    pub last_error: Option<String>,
    /// Most recent successful end-to-end delivery latencies in microseconds.
    /// The runtime retains a bounded window so a long-lived emulator cannot
    /// grow telemetry memory without limit.
    pub delivery_latencies_micros: VecDeque<u64>,
}

/// Failure to configure the Functions delivery runtime.
#[derive(Debug)]
pub struct BridgeError(String);

impl Display for BridgeError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for BridgeError {}

/// Active background-delivery runtime and its store observer.
pub struct DeliveryRuntime {
    observer: Arc<TriggerObserver>,
    health: Arc<Mutex<DeliveryHealth>>,
    shutdown: tokio::sync::watch::Sender<bool>,
    coordinator: tokio::task::JoinHandle<()>,
}

impl DeliveryRuntime {
    /// Starts delivery to a Firebase Functions workload-host origin.
    pub fn start(
        registry: TriggerRegistry,
        endpoint: &str,
        policy: DeliveryPolicy,
    ) -> Result<Self, BridgeError> {
        validate_policy(policy)?;
        let endpoint = reqwest::Url::parse(endpoint)
            .map_err(|error| BridgeError(format!("invalid Functions endpoint: {error}")))?;
        if endpoint.cannot_be_a_base() {
            return Err(BridgeError(
                "Functions endpoint must be an HTTP origin".to_owned(),
            ));
        }
        let client = reqwest::Client::builder()
            .connect_timeout(policy.connect_timeout)
            .timeout(policy.request_timeout)
            .build()
            .map_err(|error| BridgeError(format!("failed to build HTTP client: {error}")))?;
        let (observer, receiver) = TriggerObserver::channel(registry);
        let health = Arc::new(Mutex::new(DeliveryHealth::default()));
        let (shutdown, shutdown_receiver) = tokio::sync::watch::channel(false);
        let coordinator = tokio::spawn(delivery_coordinator(
            receiver,
            Arc::clone(&observer.depth),
            shutdown_receiver,
            endpoint,
            client,
            policy,
            health.clone(),
        ));
        Ok(Self {
            observer,
            health,
            shutdown,
            coordinator,
        })
    }

    /// Observer to register with the shared Firestore store.
    #[must_use]
    pub fn observer(&self) -> Arc<dyn CommitObserver> {
        self.observer.clone()
    }

    /// Queue producer for Auth, Pub/Sub, Storage, and scheduler events.
    #[must_use]
    pub fn queue(&self) -> DispatchQueue {
        self.observer.queue()
    }

    /// Captures delivery counters without blocking the worker.
    #[must_use]
    pub fn health(&self) -> DeliveryHealth {
        lock(&self.health).clone()
    }

    /// Stops admission and drains every already queued delivery.
    pub async fn shutdown(self) -> DeliveryHealth {
        let _ = self.shutdown.send(true);
        let _ = self.coordinator.await;
        lock(&self.health).clone()
    }
}

fn validate_policy(policy: DeliveryPolicy) -> Result<(), BridgeError> {
    if policy.max_concurrent == 0
        || policy.max_attempts == 0
        || policy.dedupe_capacity == 0
        || policy.initial_retry_delay > policy.maximum_retry_delay
    {
        return Err(BridgeError("invalid Functions delivery policy".to_owned()));
    }
    Ok(())
}

#[allow(
    clippy::too_many_arguments,
    reason = "the delivery loop's inputs, each used on its own path"
)]
async fn delivery_coordinator(
    mut receiver: tokio::sync::mpsc::UnboundedReceiver<DispatchRequest>,
    depth: Arc<QueueDepth>,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
    endpoint: reqwest::Url,
    client: reqwest::Client,
    policy: DeliveryPolicy,
    health: Arc<Mutex<DeliveryHealth>>,
) {
    let mut seen = BTreeSet::new();
    let mut seen_order = VecDeque::new();
    let mut deliveries = tokio::task::JoinSet::new();
    let mut stopping = false;

    loop {
        if stopping {
            receiver.close();
            while let Ok(request) = receiver.try_recv() {
                depth.taken();
                admit_delivery(
                    request,
                    &mut seen,
                    &mut seen_order,
                    &mut deliveries,
                    &endpoint,
                    &client,
                    policy,
                    &health,
                );
            }
            if deliveries.is_empty() {
                break;
            }
        }

        tokio::select! {
            request = receiver.recv(), if !stopping && deliveries.len() < policy.max_concurrent => {
                match request {
                    Some(request) => {
                        depth.taken();
                        admit_delivery(
                            request,
                            &mut seen,
                            &mut seen_order,
                            &mut deliveries,
                            &endpoint,
                            &client,
                            policy,
                            &health,
                        );
                    }
                    None => stopping = true,
                }
            }
            outcome = deliveries.join_next(), if !deliveries.is_empty() => {
                if let Some(outcome) = outcome {
                    record_outcome(outcome, &health);
                }
            }
            changed = shutdown.changed(), if !stopping => {
                stopping = changed.is_err() || *shutdown.borrow();
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn admit_delivery(
    request: DispatchRequest,
    seen: &mut BTreeSet<String>,
    seen_order: &mut VecDeque<String>,
    deliveries: &mut tokio::task::JoinSet<DeliveryOutcome>,
    endpoint: &reqwest::Url,
    client: &reqwest::Client,
    policy: DeliveryPolicy,
    health: &Arc<Mutex<DeliveryHealth>>,
) {
    if seen.contains(&request.event_id) {
        let mut health = lock(health);
        health.deduplicated = health.deduplicated.saturating_add(1);
        return;
    }
    while seen.len() >= policy.dedupe_capacity {
        if let Some(expired) = seen_order.pop_front() {
            seen.remove(&expired);
        }
    }
    seen.insert(request.event_id.clone());
    seen_order.push_back(request.event_id.clone());
    {
        let mut health = lock(health);
        health.admitted = health.admitted.saturating_add(1);
    }
    let endpoint = endpoint.clone();
    let client = client.clone();
    deliveries.spawn(async move { deliver(&client, &endpoint, &request, policy).await });
}

#[derive(Debug)]
enum DeliveryOutcome {
    Delivered { retries: u64, latency_micros: u64 },
    AssumedDelivered { retries: u64, reason: String },
    Failed { retries: u64, error: String },
}

async fn deliver(
    client: &reqwest::Client,
    endpoint: &reqwest::Url,
    request: &DispatchRequest,
    policy: DeliveryPolicy,
) -> DeliveryOutcome {
    let started = Instant::now();
    let url = match endpoint.join(request.path.trim_start_matches('/')) {
        Ok(url) => url,
        Err(error) => {
            return DeliveryOutcome::Failed {
                retries: 0,
                error: format!("invalid dispatch path: {error}"),
            };
        }
    };
    let mut delay = policy.initial_retry_delay;
    for attempt in 1..=policy.max_attempts {
        let mut builder = client.post(url.clone()).body(request.body.clone());
        for (name, value) in &request.headers {
            builder = builder.header(name, value);
        }
        match builder.send().await {
            Ok(response) if response.status().is_success() => {
                return DeliveryOutcome::Delivered {
                    retries: usize_to_u64(attempt.saturating_sub(1)),
                    latency_micros: duration_micros(started.elapsed()),
                };
            }
            // A handler that ran and failed is final, as on the official
            // emulator; only a runtime that could not reach a worker retries.
            Ok(response)
                if (response.status().is_server_error()
                    || response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS)
                    && response
                        .headers()
                        .get(DELIVERY_HEADER)
                        .and_then(|value| value.to_str().ok())
                        != Some(DELIVERY_HANDLED) =>
            {
                if attempt == policy.max_attempts {
                    return DeliveryOutcome::Failed {
                        retries: usize_to_u64(attempt.saturating_sub(1)),
                        error: format!("Functions host returned {}", response.status()),
                    };
                }
            }
            Ok(response) => {
                return DeliveryOutcome::Failed {
                    retries: usize_to_u64(attempt.saturating_sub(1)),
                    error: format!("Functions host returned {}", response.status()),
                };
            }
            Err(error) if error.is_connect() => {
                if attempt == policy.max_attempts {
                    return DeliveryOutcome::Failed {
                        retries: usize_to_u64(attempt.saturating_sub(1)),
                        error: format!("Functions host connection failed: {error}"),
                    };
                }
            }
            Err(error) => {
                return DeliveryOutcome::AssumedDelivered {
                    retries: usize_to_u64(attempt.saturating_sub(1)),
                    reason: format!("Functions host response was lost: {error}"),
                };
            }
        }
        tokio::time::sleep(delay).await;
        delay = delay.saturating_mul(2).min(policy.maximum_retry_delay);
    }
    DeliveryOutcome::Failed {
        retries: usize_to_u64(policy.max_attempts.saturating_sub(1)),
        error: "Functions delivery exhausted without an outcome".to_owned(),
    }
}

fn record_outcome(
    outcome: Result<DeliveryOutcome, tokio::task::JoinError>,
    health: &Mutex<DeliveryHealth>,
) {
    let mut health = lock(health);
    match outcome {
        Ok(DeliveryOutcome::Delivered {
            retries,
            latency_micros,
        }) => {
            health.delivered = health.delivered.saturating_add(1);
            health.retries = health.retries.saturating_add(retries);
            if health.delivery_latencies_micros.len() >= 4_096 {
                health.delivery_latencies_micros.pop_front();
            }
            health.delivery_latencies_micros.push_back(latency_micros);
        }
        Ok(DeliveryOutcome::AssumedDelivered { retries, reason }) => {
            health.assumed_delivered_after_response_loss = health
                .assumed_delivered_after_response_loss
                .saturating_add(1);
            health.retries = health.retries.saturating_add(retries);
            health.last_error = Some(reason);
        }
        Ok(DeliveryOutcome::Failed { retries, error }) => {
            health.failed = health.failed.saturating_add(1);
            health.retries = health.retries.saturating_add(retries);
            health.last_error = Some(error);
        }
        Err(error) => {
            health.failed = health.failed.saturating_add(1);
            health.last_error = Some(format!("Functions delivery task failed: {error}"));
        }
    }
}

fn usize_to_u64(value: usize) -> u64 {
    u64::try_from(value).unwrap_or(u64::MAX)
}

fn duration_micros(value: Duration) -> u64 {
    u64::try_from(value.as_micros()).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use axum::Router;
    use axum::body::Bytes;
    use axum::extract::State;
    use axum::http::{HeaderMap, StatusCode};
    use axum::routing::post;
    use firenook_core_store::{DatabaseName, Fields, Precondition, Store, Value, Write};

    use super::*;

    const ORACLE: &str = include_str!(
        "../../../conformance/fixtures/firebase-suite-v1/firestore-trigger-registration-and-v1-v2-dispatch/fixture.json"
    );
    const FUNCTIONS_ORACLE: &str = include_str!(
        "../../../conformance/fixtures/firebase-suite-v1/functions-callable-http-and-error-contract/fixture.json"
    );

    fn registration_bodies() -> (JsonValue, JsonValue) {
        let oracle: JsonValue = serde_json::from_str(ORACLE).expect("oracle fixture");
        let registrations = oracle["registrations"].as_array().expect("registrations");
        (
            registrations[0]["request"].clone(),
            registrations[1]["request"].clone(),
        )
    }

    fn oracle_store() -> (Store, DocumentKey, CommitObservation) {
        #[derive(Default)]
        struct Recorder(Mutex<Vec<CommitObservation>>);

        impl CommitObserver for Recorder {
            fn committed(&self, observation: &CommitObservation) {
                lock(&self.0).push(observation.clone());
            }
        }

        let store = Store::default();
        let recorder = Arc::new(Recorder::default());
        store.add_commit_observer(recorder.clone());
        let database = DatabaseName::new("demo-fireside-phase4-trigger-oracle", "(default)")
            .expect("database");
        let key = DocumentKey::new(database, "phase4Triggers/oracle").expect("key");
        store
            .commit(&[Write::Create {
                key: key.clone(),
                fields: Fields::from([
                    ("ascii".to_owned(), Value::String("oracle".into())),
                    ("unicode".to_owned(), Value::String("火🔥".into())),
                    ("ordinal".to_owned(), Value::Integer(1)),
                ]),
            }])
            .expect("oracle create");
        let observation = lock(&recorder.0).pop().expect("observation");
        (store, key, observation)
    }

    #[test]
    fn registrations_match_the_frozen_official_oracle() {
        let (v1, v2) = registration_bodies();
        let registry = TriggerRegistry::default();
        registry
            .register_v1(
                "demo-fireside-phase4-trigger-oracle",
                "us-central1-v1Created",
                &v1,
            )
            .expect("v1 registration");
        registry
            .register_v2(
                "demo-fireside-phase4-trigger-oracle",
                "us-central1-v2Created",
                &v2,
            )
            .expect("v2 registration");

        assert_eq!(registry.all().len(), 2);
        assert_eq!(registry.all()[0].generation, TriggerGeneration::V1);
        assert_eq!(registry.all()[1].generation, TriggerGeneration::V2);
        assert_eq!(registry.all()[1].database, "(default)");
        assert_eq!(
            registry.all()[1].document_pattern,
            "phase4Triggers/{documentId}"
        );
    }

    #[test]
    fn functions_inventory_parses_the_frozen_backends_contract() {
        #[derive(serde::Deserialize)]
        struct Response {
            backends: Vec<FunctionBackend>,
        }
        let oracle: JsonValue = serde_json::from_str(FUNCTIONS_ORACLE).expect("functions oracle");
        let response =
            serde_json::from_value::<Response>(oracle["observations"][0]["response"].clone())
                .expect("backends response");
        let inventory = FunctionsInventory {
            generation: 0,
            backends: response.backends,
        };
        let functions = inventory.functions().collect::<Vec<_>>();

        assert_eq!(functions.len(), 4);
        assert_eq!(functions[0].id, "us-central1-httpEcho");
        assert!(functions[0].https_trigger.is_some());
        assert_eq!(
            functions[2].schedule.as_ref().expect("schedule").schedule,
            "every 5 minutes"
        );
        assert_eq!(
            functions[3]
                .event_trigger
                .as_ref()
                .expect("topic trigger")
                .event_filters["topic"],
            "projects/demo-fireside-phase4-suite-oracle/topics/phase4-topic"
        );
    }

    #[test]
    fn functions_inventory_keeps_the_task_queue_trigger_document() {
        let inventory = FunctionsInventory::from_backends_json(
            &json!({
                "backends": [{
                    "functionTriggers": [
                        {
                            "entryPoint": "taskRetry",
                            "platform": "gcfv2",
                            "region": "us-central1",
                            "name": "taskRetry",
                            "id": "us-central1-taskRetry",
                            "httpsTrigger": {},
                            "taskQueueTrigger": {
                                "retryConfig": {
                                    "maxAttempts": 3,
                                    "maxRetrySeconds": null,
                                    "maxBackoffSeconds": 1,
                                    "maxDoublings": 2,
                                    "minBackoffSeconds": 0.2
                                },
                                "rateLimits": {
                                    "maxConcurrentDispatches": null,
                                    "maxDispatchesPerSecond": null
                                }
                            }
                        },
                        {
                            "entryPoint": "httpEcho",
                            "platform": "gcfv2",
                            "region": "us-central1",
                            "name": "httpEcho",
                            "httpsTrigger": {}
                        }
                    ]
                }]
            }),
            0,
        )
        .expect("inventory with a task queue");
        let functions = inventory.functions().collect::<Vec<_>>();

        assert_eq!(functions.len(), 2);
        let trigger = functions[0]
            .task_queue_trigger
            .as_ref()
            .expect("taskQueueTrigger kept");
        assert_eq!(trigger["retryConfig"]["maxAttempts"], json!(3));
        assert_eq!(trigger["retryConfig"]["minBackoffSeconds"], json!(0.2));
        assert_eq!(
            trigger["rateLimits"]["maxConcurrentDispatches"],
            JsonValue::Null
        );
        assert!(functions[0].https_trigger.is_some());
        assert!(functions[1].task_queue_trigger.is_none());
    }

    #[test]
    fn mixed_inventory_normalizes_the_frozen_extension_shape() {
        #[derive(serde::Deserialize)]
        struct Response {
            backends: Vec<FunctionBackend>,
        }
        let response = json!({
            "backends": [{
                "functionTriggers": [{
                    "name": "ext-synthetic-createNestedRecord",
                    "entryPoint": "createNestedRecord",
                    "platform": "gcfv1",
                    "regions": ["us-central1"],
                    "eventTrigger": {
                        "eventType": "providers/cloud.firestore/eventTypes/document.create",
                        "resource": "projects/demo-synthetic-app/databases/(default)/documents/permissions/{uid}/tasks/{id}"
                    }
                }]
            }]
        });
        let mut response = serde_json::from_value::<Response>(response).expect("mixed inventory");
        normalize_inventory(&mut response.backends).expect("normalization");
        let function = &response.backends[0].function_triggers[0];

        assert_eq!(function.region, "us-central1");
        assert_eq!(function.id, "us-central1-ext-synthetic-createNestedRecord");
    }

    #[test]
    fn phase4_extension_trigger_fanout_is_local_and_exact() {
        #[derive(Default)]
        struct Recorder(Mutex<Vec<CommitObservation>>);

        impl CommitObserver for Recorder {
            fn committed(&self, observation: &CommitObservation) {
                lock(&self.0).push(observation.clone());
            }
        }

        let project = "demo-synthetic-app";
        let registry = TriggerRegistry::default();
        registry
            .register_v2(
                project,
                "us-central1-onWriteNestedRecord",
                &json!({
                    "eventType": V2_WRITTEN,
                    "database": "(default)",
                    "document": {
                        "matchType": "PATH_PATTERN",
                        "value": "permissions/{permissionId}/tasks/{taskId}"
                    }
                }),
            )
            .expect("synthetic nested trigger");
        for (key, event_type, pattern) in [
            (
                "us-central1-ext-synthetic-createNestedRecord",
                V1_CREATE,
                "permissions/{uid}/tasks/{id}",
            ),
            (
                "us-central1-ext-synthetic-indexRecords",
                V1_WRITE,
                "records/{recordId}/searchIndex/{documentID}",
            ),
            (
                "us-central1-ext-synthetic-indexMedia",
                V1_WRITE,
                "media/{documentID}",
            ),
        ] {
            registry
                .register_v1(
                    project,
                    key,
                    &json!({
                        "eventTrigger": {
                            "eventType": event_type,
                            "resource": format!(
                                "projects/{project}/databases/(default)/documents/{pattern}"
                            ),
                            "service": FIRESTORE_SERVICE
                        }
                    }),
                )
                .expect("extension trigger");
        }

        let store = Store::default();
        let recorder = Arc::new(Recorder::default());
        store.add_commit_observer(recorder.clone());
        let database = DatabaseName::new(project, "(default)").expect("database");
        for path in [
            "permissions/permission/tasks/session",
            "records/record/searchIndex/document",
            "media/image",
        ] {
            store
                .commit(&[Write::Create {
                    key: DocumentKey::new(database.clone(), path).expect("document key"),
                    fields: Fields::new(),
                }])
                .expect("synthetic write");
        }
        let observations = lock(&recorder.0).clone();
        let checkout = registry.matching(&observations[0].changes[0]);
        let presentation = registry.matching(&observations[1].changes[0]);
        let user_image = registry.matching(&observations[2].changes[0]);

        assert_eq!(checkout.len(), 2);
        assert!(
            checkout
                .iter()
                .any(|trigger| trigger.generation == TriggerGeneration::V1)
        );
        assert!(
            checkout
                .iter()
                .any(|trigger| trigger.generation == TriggerGeneration::V2)
        );
        assert_eq!(presentation.len(), 1);
        assert_eq!(user_image.len(), 1);
        assert_ne!(presentation[0].key, user_image[0].key);
    }

    #[test]
    fn v1_dispatch_replays_the_frozen_json_contract() {
        let (v1, _) = registration_bodies();
        let registry = TriggerRegistry::default();
        registry
            .register_v1(
                "demo-fireside-phase4-trigger-oracle",
                "us-central1-v1Created",
                &v1,
            )
            .expect("v1 registration");
        let (_, _, observation) = oracle_store();
        let dispatch = build_dispatch(&registry.all()[0], &observation, 0).expect("dispatch");
        let body: JsonValue = serde_json::from_slice(&dispatch.body).expect("dispatch JSON");
        let oracle: JsonValue = serde_json::from_str(ORACLE).expect("oracle fixture");
        let expected = &oracle["dispatches"][0];

        assert_eq!(dispatch.path, expected["path"]);
        assert_eq!(dispatch.headers["content-type"], "application/json");
        assert_eq!(
            body["data"]["value"]["name"],
            expected["body"]["data"]["value"]["name"]
        );
        assert_eq!(
            body["data"]["value"]["fields"],
            expected["body"]["data"]["value"]["fields"]
        );
        assert_eq!(body["data"]["updateMask"], json!({}));
        assert_eq!(
            body["context"]["eventType"],
            expected["body"]["context"]["eventType"]
        );
        assert_eq!(
            body["context"]["resource"],
            expected["body"]["context"]["resource"]
        );
        assert_eq!(body["context"]["eventId"], dispatch.event_id);
    }

    #[test]
    fn v2_dispatch_replays_the_frozen_binary_cloudevent_contract() {
        let (_, v2) = registration_bodies();
        let registry = TriggerRegistry::default();
        registry
            .register_v2(
                "demo-fireside-phase4-trigger-oracle",
                "us-central1-v2Created",
                &v2,
            )
            .expect("v2 registration");
        let (_, _, observation) = oracle_store();
        let dispatch = build_dispatch(&registry.all()[0], &observation, 0).expect("dispatch");
        let oracle: JsonValue = serde_json::from_str(ORACLE).expect("oracle fixture");
        let expected = &oracle["dispatches"][1];
        let expected_bytes = BASE64
            .decode(expected["body"].as_str().expect("base64 body"))
            .expect("captured protobuf");
        let encoded = String::from_utf8(dispatch.body.clone()).expect("base64 text body");
        let actual_bytes = BASE64.decode(&encoded).expect("actual base64 protobuf");
        let actual = DocumentEventData::decode(actual_bytes.as_slice()).expect("actual protobuf");
        let captured =
            DocumentEventData::decode(expected_bytes.as_slice()).expect("captured protobuf");

        assert_eq!(dispatch.path, expected["path"]);
        assert_eq!(dispatch.headers["ce-specversion"], "1.0");
        assert_eq!(dispatch.headers["ce-type"], expected["headers"]["ce-type"]);
        assert_eq!(
            dispatch.headers["ce-source"],
            expected["headers"]["ce-source"]
        );
        assert_eq!(
            dispatch.headers["ce-subject"],
            expected["headers"]["ce-subject"]
        );
        assert_eq!(dispatch.headers["ce-id"], dispatch.event_id);
        assert_eq!(
            dispatch.headers["ce-dataschema"],
            expected["headers"]["ce-dataschema"]
        );
        assert_eq!(
            dispatch.headers["ce-location"],
            expected["headers"]["ce-location"]
        );
        assert_eq!(
            dispatch.headers["ce-project"],
            expected["headers"]["ce-project"]
        );
        assert_eq!(
            dispatch.headers["ce-database"],
            expected["headers"]["ce-database"]
        );
        assert_eq!(
            dispatch.headers["ce-namespace"],
            expected["headers"]["ce-namespace"]
        );
        assert_eq!(
            dispatch.headers["ce-document"],
            expected["headers"]["ce-document"]
        );
        assert!(!dispatch.headers["ce-time"].contains('.'));
        assert_eq!(
            actual.value.as_ref().expect("actual value").name,
            captured.value.as_ref().expect("captured value").name
        );
        assert_eq!(
            actual.value.as_ref().expect("actual value").fields,
            captured.value.as_ref().expect("captured value").fields
        );
        assert!(actual.old_value.is_none());
        assert_eq!(
            actual.update_mask,
            Some(firestore_proto::DocumentMask::default())
        );
    }

    #[test]
    fn writes_match_create_update_delete_and_recursive_patterns_exactly() {
        assert!(path_matches("users/{userId}", "users/alice"));
        assert!(!path_matches("users/{userId}", "users/alice/items/one"));
        assert!(path_matches(
            "permissions/{permissionId}/memberships/{membershipId}",
            "permissions/team/memberships/stripe"
        ));
        assert!(path_matches("roots/{document=**}", "roots/a/children/b"));
        assert!(!path_matches("roots/{document=**}", "roots"));

        let (store, key, create) = oracle_store();
        let database = key.database().clone();
        let update = {
            #[derive(Default)]
            struct Recorder(Mutex<Vec<CommitObservation>>);
            impl CommitObserver for Recorder {
                fn committed(&self, observation: &CommitObservation) {
                    lock(&self.0).push(observation.clone());
                }
            }
            let recorder = Arc::new(Recorder::default());
            store.add_commit_observer(recorder.clone());
            store
                .commit(&[Write::Set {
                    key: key.clone(),
                    fields: BTreeMap::from([("ordinal".to_owned(), Value::Integer(2))]),
                    transforms: Vec::new(),
                    precondition: Precondition::None,
                }])
                .expect("update");
            lock(&recorder.0).pop().expect("update observation")
        };
        let delete = {
            #[derive(Default)]
            struct Recorder(Mutex<Vec<CommitObservation>>);
            impl CommitObserver for Recorder {
                fn committed(&self, observation: &CommitObservation) {
                    lock(&self.0).push(observation.clone());
                }
            }
            let recorder = Arc::new(Recorder::default());
            store.add_commit_observer(recorder.clone());
            store
                .commit(&[Write::Delete {
                    key,
                    precondition: Precondition::None,
                }])
                .expect("delete");
            lock(&recorder.0).pop().expect("delete observation")
        };
        let trigger = |event_type: &str| Trigger {
            project: database.project_id().to_owned(),
            key: "test".to_owned(),
            generation: TriggerGeneration::V2,
            event_type: event_type.to_owned(),
            database: database.database_id().to_owned(),
            document_pattern: "phase4Triggers/{id}".to_owned(),
        };
        assert!(trigger(V2_CREATED).matches(&create.changes[0]));
        assert!(!trigger(V2_CREATED).matches(&update.changes[0]));
        assert!(trigger(V2_UPDATED).matches(&update.changes[0]));
        assert!(trigger(V2_DELETED).matches(&delete.changes[0]));
        assert!(trigger(V2_WRITTEN).matches(&create.changes[0]));
        assert!(trigger(V2_WRITTEN).matches(&update.changes[0]));
        assert!(trigger(V2_WRITTEN).matches(&delete.changes[0]));
    }

    #[tokio::test]
    async fn observer_queues_each_matching_trigger_and_honors_hub_control() {
        let (v1, v2) = registration_bodies();
        let registry = TriggerRegistry::default();
        registry
            .register_v1(
                "demo-fireside-phase4-trigger-oracle",
                "us-central1-v1Created",
                &v1,
            )
            .expect("v1 registration");
        registry
            .register_v2(
                "demo-fireside-phase4-trigger-oracle",
                "us-central1-v2Created",
                &v2,
            )
            .expect("v2 registration");
        let (observer, mut receiver) = TriggerObserver::channel(registry.clone());
        let store = Store::default();
        store.add_commit_observer(observer);
        let database = DatabaseName::new("demo-fireside-phase4-trigger-oracle", "(default)")
            .expect("database");
        store
            .commit(&[Write::Create {
                key: DocumentKey::new(database.clone(), "phase4Triggers/one").expect("key"),
                fields: Fields::new(),
            }])
            .expect("create");
        let first = receiver.recv().await.expect("first dispatch");
        let second = receiver.recv().await.expect("second dispatch");
        assert_ne!(first.path, second.path);
        assert!(receiver.try_recv().is_err());

        registry.set_background_enabled(false);
        store
            .commit(&[Write::Create {
                key: DocumentKey::new(database, "phase4Triggers/two").expect("key"),
                fields: Fields::new(),
            }])
            .expect("disabled create");
        assert!(receiver.try_recv().is_err());
    }

    #[tokio::test]
    async fn housekeeping_commits_fire_no_trigger_and_count_no_drop() {
        let (v1, v2) = registration_bodies();
        let registry = TriggerRegistry::default();
        registry
            .register_v1(
                "demo-fireside-phase4-trigger-oracle",
                "us-central1-v1Created",
                &v1,
            )
            .expect("v1 registration");
        registry
            .register_v2(
                "demo-fireside-phase4-trigger-oracle",
                "us-central1-v2Created",
                &v2,
            )
            .expect("v2 registration");
        let (observer, mut receiver) = TriggerObserver::channel(registry.clone());
        let store = Store::default();
        store.add_commit_observer(observer);
        let database = DatabaseName::new("demo-fireside-phase4-trigger-oracle", "(default)")
            .expect("database");
        let create = |path: &str| Write::Create {
            key: DocumentKey::new(database.clone(), path).expect("key"),
            fields: Fields::new(),
        };
        store
            .commit_maintenance(&[create("phase4Triggers/housekeeping")])
            .expect("maintenance create");
        assert!(receiver.try_recv().is_err());

        // The same change from a client still dispatches to both triggers.
        store
            .commit(&[create("phase4Triggers/client")])
            .expect("client create");
        receiver.recv().await.expect("first dispatch");
        receiver.recv().await.expect("second dispatch");
        assert!(receiver.try_recv().is_err());

        // Paused delivery counts what a client commit would have fired, and
        // nothing for a housekeeping one.
        registry.set_background_enabled(false);
        store
            .commit_maintenance(&[create("phase4Triggers/paused-housekeeping")])
            .expect("paused maintenance create");
        assert_eq!(
            registry
                .dropped()
                .counts
                .iter()
                .map(|(_, count)| count)
                .sum::<u64>(),
            0
        );
        store
            .commit(&[create("phase4Triggers/paused-client")])
            .expect("paused client create");
        assert!(
            registry
                .dropped()
                .counts
                .iter()
                .map(|(_, count)| count)
                .sum::<u64>()
                > 0
        );
        assert!(receiver.try_recv().is_err());
    }

    #[derive(Clone)]
    struct RetryServerState {
        attempts: Arc<AtomicUsize>,
        event_ids: Arc<Mutex<Vec<String>>>,
    }

    async fn retry_handler(
        State(state): State<RetryServerState>,
        headers: HeaderMap,
        _body: Bytes,
    ) -> StatusCode {
        state.event_ids.lock().expect("event ids").push(
            headers
                .get("ce-id")
                .expect("ce-id")
                .to_str()
                .expect("ce-id text")
                .to_owned(),
        );
        if state.attempts.fetch_add(1, Ordering::SeqCst) == 0 {
            StatusCode::SERVICE_UNAVAILABLE
        } else {
            StatusCode::OK
        }
    }

    #[tokio::test]
    async fn delivery_retries_with_one_stable_id_and_suppresses_duplicate_events() {
        let state = RetryServerState {
            attempts: Arc::new(AtomicUsize::new(0)),
            event_ids: Arc::new(Mutex::new(Vec::new())),
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("listener");
        let address = listener.local_addr().expect("address");
        let server = tokio::spawn(
            axum::serve(
                listener,
                Router::new()
                    .route("/{*path}", post(retry_handler))
                    .with_state(state.clone()),
            )
            .into_future(),
        );
        let (_, v2) = registration_bodies();
        let registry = TriggerRegistry::default();
        registry
            .register_v2(
                "demo-fireside-phase4-trigger-oracle",
                "us-central1-v2Created",
                &v2,
            )
            .expect("v2 registration");
        let runtime = DeliveryRuntime::start(
            registry,
            &format!("http://{address}/"),
            DeliveryPolicy {
                initial_retry_delay: Duration::from_millis(1),
                maximum_retry_delay: Duration::from_millis(2),
                ..DeliveryPolicy::default()
            },
        )
        .expect("runtime");
        let (_, _, observation) = oracle_store();
        runtime.observer.committed(&observation);
        runtime.observer.committed(&observation);
        let health = runtime.shutdown().await;
        server.abort();

        assert_eq!(health.admitted, 1);
        assert_eq!(health.deduplicated, 1);
        assert_eq!(health.delivered, 1);
        assert_eq!(health.retries, 1);
        assert_eq!(health.failed, 0);
        assert_eq!(state.attempts.load(Ordering::SeqCst), 2);
        let event_ids = state.event_ids.lock().expect("event ids");
        assert_eq!(event_ids.len(), 2);
        assert_eq!(event_ids[0], event_ids[1]);
    }

    async fn slow_handler(State(calls): State<Arc<AtomicUsize>>) -> StatusCode {
        calls.fetch_add(1, Ordering::SeqCst);
        tokio::time::sleep(Duration::from_secs(2)).await;
        StatusCode::OK
    }

    #[tokio::test]
    async fn response_loss_is_not_retried_and_cannot_duplicate_handler_effects() {
        let calls = Arc::new(AtomicUsize::new(0));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("listener");
        let address = listener.local_addr().expect("address");
        let server = tokio::spawn(
            axum::serve(
                listener,
                Router::new()
                    .route("/{*path}", post(slow_handler))
                    .with_state(calls.clone()),
            )
            .into_future(),
        );
        let (_, v2) = registration_bodies();
        let registry = TriggerRegistry::default();
        registry
            .register_v2(
                "demo-fireside-phase4-trigger-oracle",
                "us-central1-v2Created",
                &v2,
            )
            .expect("v2 registration");
        let runtime = DeliveryRuntime::start(
            registry,
            &format!("http://{address}/"),
            DeliveryPolicy {
                request_timeout: Duration::from_millis(100),
                initial_retry_delay: Duration::from_millis(1),
                maximum_retry_delay: Duration::from_millis(2),
                ..DeliveryPolicy::default()
            },
        )
        .expect("runtime");
        let (_, _, observation) = oracle_store();
        runtime.observer.committed(&observation);
        let health = runtime.shutdown().await;
        server.abort();

        assert_eq!(health.assumed_delivered_after_response_loss, 1);
        assert_eq!(health.retries, 0);
        assert_eq!(health.failed, 0);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn phase4_fifty_response_losses_have_zero_duplicate_effects() {
        let calls = Arc::new(AtomicUsize::new(0));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("listener");
        let address = listener.local_addr().expect("address");
        let server = tokio::spawn(
            axum::serve(
                listener,
                Router::new()
                    .route("/{*path}", post(slow_handler))
                    .with_state(calls.clone()),
            )
            .into_future(),
        );
        let runtime = DeliveryRuntime::start(
            TriggerRegistry::default(),
            &format!("http://{address}/"),
            DeliveryPolicy {
                max_concurrent: 64,
                // This is intentionally much longer than the CI scheduler's
                // connection-admission jitter while remaining shorter than
                // `slow_handler`. The fixture is proving response loss after
                // handler entry, not pre-handler connection starvation.
                request_timeout: Duration::from_secs(1),
                initial_retry_delay: Duration::from_millis(1),
                maximum_retry_delay: Duration::from_millis(2),
                ..DeliveryPolicy::default()
            },
        )
        .expect("runtime");
        for index in 0..50 {
            runtime
                .queue()
                .enqueue(chaos_dispatch(
                    &format!("phase4-dropped-response-{index}"),
                    "auth-create",
                ))
                .expect("enqueue");
        }
        let health = runtime.shutdown().await;
        server.abort();

        assert_eq!(health.admitted, 50);
        assert_eq!(health.assumed_delivered_after_response_loss, 50);
        assert_eq!(health.delivered, 0);
        assert_eq!(health.retries, 0);
        assert_eq!(health.failed, 0);
        assert_eq!(calls.load(Ordering::SeqCst), 50);
    }

    #[derive(Clone, Default)]
    struct Phase4RetryState {
        attempts: Arc<Mutex<BTreeMap<String, usize>>>,
        effects: Arc<AtomicUsize>,
    }

    async fn phase4_retry_handler(
        State(state): State<Phase4RetryState>,
        headers: HeaderMap,
    ) -> StatusCode {
        let event_id = headers
            .get("ce-id")
            .expect("ce-id")
            .to_str()
            .expect("ce-id text")
            .to_owned();
        let attempt = {
            let mut attempts = state.attempts.lock().expect("attempts");
            let attempt = attempts.entry(event_id).or_default();
            *attempt += 1;
            *attempt
        };
        if attempt == 1 {
            StatusCode::SERVICE_UNAVAILABLE
        } else {
            state.effects.fetch_add(1, Ordering::SeqCst);
            StatusCode::OK
        }
    }

    #[tokio::test]
    async fn phase4_fifty_duplicate_auth_retries_are_exactly_once() {
        let state = Phase4RetryState::default();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("listener");
        let address = listener.local_addr().expect("address");
        let server = tokio::spawn(
            axum::serve(
                listener,
                Router::new()
                    .route("/{*path}", post(phase4_retry_handler))
                    .with_state(state.clone()),
            )
            .into_future(),
        );
        let runtime = DeliveryRuntime::start(
            TriggerRegistry::default(),
            &format!("http://{address}/"),
            DeliveryPolicy {
                max_concurrent: 64,
                initial_retry_delay: Duration::from_millis(1),
                maximum_retry_delay: Duration::from_millis(2),
                ..DeliveryPolicy::default()
            },
        )
        .expect("runtime");
        for index in 0..50 {
            let request = chaos_dispatch(&format!("phase4-auth-retry-{index}"), "auth-create");
            runtime.queue().enqueue(request.clone()).expect("enqueue");
            runtime.queue().enqueue(request).expect("duplicate enqueue");
        }
        let health = runtime.shutdown().await;
        server.abort();

        assert_eq!(health.admitted, 50);
        assert_eq!(health.deduplicated, 50);
        assert_eq!(health.delivered, 50);
        assert_eq!(health.retries, 50);
        assert_eq!(health.failed, 0);
        assert_eq!(state.effects.load(Ordering::SeqCst), 50);
        assert!(
            state
                .attempts
                .lock()
                .expect("attempts")
                .values()
                .all(|attempts| *attempts == 2)
        );
    }

    async fn phase4_count_handler(State(calls): State<Arc<AtomicUsize>>) -> StatusCode {
        calls.fetch_add(1, Ordering::SeqCst);
        StatusCode::OK
    }

    fn phase4_register_six_patterns(registry: &TriggerRegistry, project: &str) {
        let patterns = [
            "users/{userId}",
            "permissions/{permissionId}",
            "permissions/{parentId}/invitations/{invitationId}",
            "permissions/{permissionId}/tasks/{taskId}",
            "permissions/{permissionId}/memberships/{membershipId}",
            "attachments/{attachmentId}",
        ];
        let mut state = lock(&registry.inner);
        for (index, pattern) in patterns.iter().enumerate() {
            let event_type = if *pattern == "attachments/{attachmentId}" {
                V2_DELETED
            } else {
                V2_WRITTEN
            };
            let key = format!("us-central1-phase4-pattern-{index}");
            state.v2.insert(
                (project.to_owned(), key.clone()),
                Trigger {
                    project: project.to_owned(),
                    key,
                    generation: TriggerGeneration::V2,
                    event_type: event_type.to_owned(),
                    database: "(default)".to_owned(),
                    document_pattern: (*pattern).to_owned(),
                },
            );
        }
    }

    #[tokio::test]
    async fn phase4_six_trigger_patterns_deliver_one_hundred_concurrent_writes_each() {
        let calls = Arc::new(AtomicUsize::new(0));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("listener");
        let address = listener.local_addr().expect("address");
        let server = tokio::spawn(
            axum::serve(
                listener,
                Router::new()
                    .route("/{*path}", post(phase4_count_handler))
                    .with_state(calls.clone()),
            )
            .into_future(),
        );
        let project = "demo-firenook-phase4-chaos";
        let database = DatabaseName::new(project, "(default)").expect("database");
        let registry = TriggerRegistry::default();
        phase4_register_six_patterns(&registry, project);
        let store = Store::default();
        for index in 0..100 {
            store
                .commit(&[Write::Create {
                    key: DocumentKey::new(database.clone(), format!("attachments/{index}"))
                        .expect("seed key"),
                    fields: Fields::new(),
                }])
                .expect("seed deleted documents");
        }
        let runtime = DeliveryRuntime::start(
            registry,
            &format!("http://{address}/"),
            DeliveryPolicy {
                max_concurrent: 64,
                ..DeliveryPolicy::default()
            },
        )
        .expect("runtime");
        store.add_commit_observer(runtime.observer());

        let mut writes = tokio::task::JoinSet::new();
        for index in 0..100 {
            for path in [
                format!("users/{index}"),
                format!("permissions/permission-{index}"),
                format!("permissions/permission-{index}/invitations/invite-{index}"),
                format!("permissions/permission-{index}/tasks/checkout-{index}"),
                format!("permissions/permission-{index}/memberships/subscription-{index}"),
            ] {
                let store = store.clone();
                let database = database.clone();
                writes.spawn_blocking(move || {
                    store.commit(&[Write::Create {
                        key: DocumentKey::new(database, path).expect("document key"),
                        fields: Fields::new(),
                    }])
                });
            }
            let store = store.clone();
            let database = database.clone();
            writes.spawn_blocking(move || {
                store.commit(&[Write::Delete {
                    key: DocumentKey::new(database, format!("attachments/{index}"))
                        .expect("delete key"),
                    precondition: Precondition::None,
                }])
            });
        }
        while let Some(write) = writes.join_next().await {
            write.expect("write task").expect("write commit");
        }
        let health = runtime.shutdown().await;
        server.abort();

        assert_eq!(health.admitted, 600);
        assert_eq!(health.delivered, 600);
        assert_eq!(health.deduplicated, 0);
        assert_eq!(health.failed, 0);
        assert_eq!(calls.load(Ordering::SeqCst), 600);
    }

    fn chaos_dispatch(event_id: &str, trigger: &str) -> DispatchRequest {
        DispatchRequest {
            path: format!("/functions/projects/demo-firenook-phase4-chaos/triggers/{trigger}"),
            headers: BTreeMap::from([
                ("ce-id".to_owned(), event_id.to_owned()),
                ("content-type".to_owned(), "application/json".to_owned()),
            ]),
            body: b"{}".to_vec(),
            event_id: event_id.to_owned(),
        }
    }

    #[tokio::test]
    async fn the_background_watch_sees_every_switch() {
        let registry = TriggerRegistry::default();
        let mut watch = registry.background_watch();
        assert!(*watch.borrow_and_update());
        registry.set_background_enabled(false);
        assert!(watch.has_changed().expect("open"));
        assert!(!*watch.borrow_and_update());
        // The same value again is not a change.
        registry.set_background_enabled(false);
        assert!(!watch.has_changed().expect("open"));
        registry.set_background_enabled(true);
        assert!(*watch.borrow_and_update());
        assert!(registry.background_enabled());
    }

    #[test]
    fn dropped_events_count_per_service_from_the_pause_and_clear_on_resume() {
        let registry = TriggerRegistry::default();
        let mut changes = registry.dropped_changes();
        assert_eq!(registry.dropped(), DroppedEvents::default());
        registry.set_background_enabled(false);
        let paused = registry.dropped();
        assert!(paused.since.is_some());
        assert_eq!(paused.counts, Vec::new());
        changes.mark_unchanged();
        for _ in 0..3 {
            registry.note_dropped(DroppedService::Storage);
        }
        registry.note_dropped(DroppedService::Firestore);
        assert!(changes.has_changed().expect("open"));
        let dropped = registry.dropped();
        assert_eq!(dropped.since, paused.since);
        assert_eq!(
            dropped.counts,
            [(DroppedService::Firestore, 1), (DroppedService::Storage, 3)]
        );
        registry.set_background_enabled(true);
        assert_eq!(registry.dropped(), DroppedEvents::default());
        registry.set_background_enabled(false);
        assert_eq!(
            registry.dropped().counts,
            Vec::new(),
            "a new pause counts from zero"
        );
        assert_eq!(DroppedService::Pubsub.as_str(), "pubsub");
        assert_eq!(DroppedService::Schedule.as_str(), "schedule");
    }

    #[tokio::test]
    async fn the_depth_counts_queued_dispatches_and_wait_below_ends_with_the_runtime() {
        let (observer, receiver) = TriggerObserver::channel(TriggerRegistry::default());
        let queue = observer.queue();
        for index in 0..3 {
            queue
                .enqueue(chaos_dispatch(&format!("e{index}"), "t"))
                .expect("queued");
        }
        assert_eq!(queue.depth(), 3);
        assert_eq!(
            observer.queue().depth(),
            3,
            "every producer shares the count"
        );
        // Below already: resolves at once.
        tokio::time::timeout(Duration::from_secs(1), queue.wait_below(4))
            .await
            .expect("already below");
        let waiting = tokio::spawn({
            let queue = queue.clone();
            async move { queue.wait_below(1).await }
        });
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(!waiting.is_finished(), "nothing took the dispatches");
        drop(receiver);
        tokio::time::timeout(Duration::from_secs(5), waiting)
            .await
            .expect("the stopped runtime ends the wait")
            .expect("joined");
        // A send to a stopped runtime fails and is not counted.
        assert!(queue.enqueue(chaos_dispatch("late", "t")).is_err());
        assert_eq!(queue.depth(), 3);
    }

    #[tokio::test]
    async fn the_delivery_runtime_counts_the_depth_down_as_it_admits() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bound");
        let address = listener.local_addr().expect("address");
        let host = Router::new().fallback(post(|| async {
            tokio::time::sleep(Duration::from_millis(20)).await;
            ([(DELIVERY_HEADER, DELIVERY_HANDLED)], "ok")
        }));
        let server = tokio::spawn(async move {
            let _ = axum::serve(listener, host).await;
        });
        let runtime = DeliveryRuntime::start(
            TriggerRegistry::default(),
            &format!("http://{address}"),
            DeliveryPolicy {
                max_concurrent: 1,
                ..DeliveryPolicy::default()
            },
        )
        .expect("started");
        let queue = runtime.queue();
        for index in 0..8 {
            queue
                .enqueue(chaos_dispatch(&format!("d{index}"), "t"))
                .expect("queued");
        }
        assert!(queue.depth() >= 6, "{} queued", queue.depth());
        tokio::time::timeout(Duration::from_secs(10), queue.wait_below(3))
            .await
            .expect("the runtime took enough");
        assert!(queue.depth() < 3);
        let health = runtime.shutdown().await;
        assert_eq!(health.admitted, 8);
        assert_eq!(queue.depth(), 0);
        server.abort();
    }

    /// Every commit of a store, as the bridge's observer sees it.
    #[derive(Default)]
    struct Commits(Mutex<Vec<CommitObservation>>);

    impl CommitObserver for Commits {
        fn committed(&self, observation: &CommitObservation) {
            lock(&self.0).push(observation.clone());
        }
    }

    /// A document created, updated and deleted, each commit observed.
    fn create_update_delete(
        path: &str,
    ) -> (
        DatabaseName,
        CommitObservation,
        CommitObservation,
        CommitObservation,
    ) {
        let store = Store::default();
        let commits = Arc::new(Commits::default());
        store.add_commit_observer(commits.clone());
        let database = DatabaseName::new("demo-explain", "(default)").expect("database");
        let key = DocumentKey::new(database.clone(), path).expect("key");
        store
            .commit(&[Write::Create {
                key: key.clone(),
                fields: Fields::from([("name".to_owned(), Value::String("Ada".into()))]),
            }])
            .expect("create");
        store
            .commit(&[Write::Set {
                key: key.clone(),
                fields: BTreeMap::from([("name".to_owned(), Value::String("Grace".into()))]),
                transforms: Vec::new(),
                precondition: Precondition::None,
            }])
            .expect("update");
        store
            .commit(&[Write::Delete {
                key,
                precondition: Precondition::None,
            }])
            .expect("delete");
        let mut observed = std::mem::take(&mut *lock(&commits.0)).into_iter();
        (
            database,
            observed.next().expect("created"),
            observed.next().expect("updated"),
            observed.next().expect("deleted"),
        )
    }

    fn trigger(
        generation: TriggerGeneration,
        event_type: &str,
        database: &str,
        pattern: &str,
    ) -> Trigger {
        Trigger {
            project: "demo-explain".to_owned(),
            key: format!("us-central1-{}", pattern.replace('/', "_")),
            generation,
            event_type: event_type.to_owned(),
            database: database.to_owned(),
            document_pattern: pattern.to_owned(),
        }
    }

    #[test]
    fn explain_match_says_whether_a_trigger_fires_and_why_not() {
        use ChangeShape::{Created, Deleted, Updated};
        use TriggerGeneration::{V1, V2};
        let fires = MatchExplanation {
            fires: true,
            reason: MatchReason::Fires,
        };
        let check = |trigger: &Trigger, database: &str, path: &str, shape, reason| {
            let explanation = explain_match(trigger, database, path, shape);
            assert_eq!(explanation.reason, reason, "{trigger:?} {path} {shape:?}");
            assert_eq!(explanation.fires, reason == MatchReason::Fires);
        };
        // Each shape against each event type of both generations.
        for (event_type, generation, shapes) in [
            (V1_CREATE, V1, [true, false, false]),
            (V1_UPDATE, V1, [false, true, false]),
            (V1_DELETE, V1, [false, false, true]),
            (V1_WRITE, V1, [true, true, true]),
            (V2_CREATED, V2, [true, false, false]),
            (V2_UPDATED, V2, [false, true, false]),
            (V2_DELETED, V2, [false, false, true]),
            (V2_WRITTEN, V2, [true, true, true]),
        ] {
            let listener = trigger(generation, event_type, "(default)", "users/{uid}");
            for (shape, raised) in [Created, Updated, Deleted].into_iter().zip(shapes) {
                let reason = if raised {
                    MatchReason::Fires
                } else {
                    MatchReason::OtherEvent(event_type.to_owned())
                };
                check(&listener, "(default)", "users/ada", shape, reason);
            }
        }
        let with_auth = trigger(
            V2,
            &format!("{V2_CREATED}{AUTH_CONTEXT_SUFFIX}"),
            "(default)",
            "users/{uid}",
        );
        assert_eq!(
            explain_match(&with_auth, "(default)", "users/ada", Created),
            fires
        );
        // Single wildcard, recursive wildcard and an exact path.
        let single = trigger(V2, V2_WRITTEN, "(default)", "users/{uid}");
        check(
            &single,
            "(default)",
            "users/ada/orders/o_1",
            Updated,
            MatchReason::PathDoesNotMatch("users/{uid}".to_owned()),
        );
        let recursive = trigger(V1, V1_WRITE, "(default)", "roots/{rest=**}");
        check(
            &recursive,
            "(default)",
            "roots/a/children/b",
            Updated,
            MatchReason::Fires,
        );
        check(
            &recursive,
            "(default)",
            "other/a",
            Updated,
            MatchReason::PathDoesNotMatch("roots/{rest=**}".to_owned()),
        );
        let exact = trigger(V2, V2_DELETED, "(default)", "config/app");
        check(
            &exact,
            "(default)",
            "config/app",
            Deleted,
            MatchReason::Fires,
        );
        check(
            &exact,
            "(default)",
            "config/web",
            Deleted,
            MatchReason::PathDoesNotMatch("config/app".to_owned()),
        );
        // Another database is named first, whatever else differs.
        let analytics = trigger(V2, V2_CREATED, "analytics", "events/{id}");
        check(
            &analytics,
            "(default)",
            "users/ada",
            Deleted,
            MatchReason::OtherDatabase("analytics".to_owned()),
        );
        check(
            &analytics,
            "analytics",
            "events/e_1",
            Created,
            MatchReason::Fires,
        );
    }

    #[test]
    fn explain_match_agrees_with_the_bridge_on_real_commits() {
        let (database, created, updated, deleted) = create_update_delete("users/ada");
        let listeners = [
            trigger(TriggerGeneration::V1, V1_CREATE, "(default)", "users/{uid}"),
            trigger(
                TriggerGeneration::V2,
                V2_UPDATED,
                "(default)",
                "users/{uid}",
            ),
            trigger(
                TriggerGeneration::V2,
                V2_WRITTEN,
                "(default)",
                "users/{uid}",
            ),
            trigger(TriggerGeneration::V1, V1_DELETE, "(default)", "teams/{id}"),
            trigger(
                TriggerGeneration::V2,
                V2_WRITTEN,
                "analytics",
                "users/{uid}",
            ),
        ];
        for observation in [&created, &updated, &deleted] {
            let change = &observation.changes[0];
            let shape = ChangeShape::of(change).expect("effective change");
            for listener in &listeners {
                assert_eq!(
                    explain_match(listener, database.database_id(), change.key.path(), shape).fires,
                    listener.matches(change),
                    "{listener:?} {shape:?}"
                );
            }
        }
        assert_eq!(
            ChangeShape::of(&created.changes[0]),
            Some(ChangeShape::Created)
        );
        assert_eq!(ChangeShape::Updated.as_str(), "updated");
        let listener = &listeners[1];
        assert_eq!(listener.key(), listener.key);
        assert_eq!(listener.event_type(), V2_UPDATED);
    }

    #[test]
    fn a_second_generation_body_reads_back_as_the_first_generation_documents() {
        let (_, created, updated, deleted) = create_update_delete("users/ada lovelace 火");
        let v1 = trigger(TriggerGeneration::V1, V1_WRITE, "(default)", "users/{uid}");
        let v2 = trigger(
            TriggerGeneration::V2,
            V2_WRITTEN,
            "(default)",
            "users/{uid}",
        );
        for observation in [&created, &updated, &deleted] {
            let change = &observation.changes[0];
            let expected = json!({
                "value": optional_document_json(&change.key, change.after.as_deref())
                    .expect("value")
                    .unwrap_or(JsonValue::Null),
                "oldValue": optional_document_json(&change.key, change.before.as_deref())
                    .expect("old value")
                    .unwrap_or(JsonValue::Null),
            });
            let dispatch = build_dispatch(&v2, observation, 0).expect("v2 dispatch");
            let decoded = decode_document_event(&dispatch.body).expect("decoded");
            assert_eq!(decoded, expected);
            // The same documents a first-generation event carries.
            let legacy = build_dispatch(&v1, observation, 0).expect("v1 dispatch");
            let legacy: JsonValue = serde_json::from_slice(&legacy.body).expect("v1 JSON");
            for field in ["value", "oldValue"] {
                assert_eq!(
                    legacy["data"].get(field).unwrap_or(&JsonValue::Null),
                    &decoded[field],
                    "{field}"
                );
            }
            // A raw protobuf body (no Base64) reads the same.
            let raw = BASE64
                .decode(&dispatch.body)
                .expect("the bridge sends Base64");
            assert_eq!(decode_document_event(&raw).expect("raw"), expected);
        }
        let created_value =
            decode_document_event(&build_dispatch(&v2, &created, 0).expect("dispatch").body)
                .expect("decoded");
        assert_eq!(created_value["oldValue"], JsonValue::Null);
        assert_eq!(
            created_value["value"]["fields"]["name"],
            json!({ "stringValue": "Ada" })
        );
        assert!(
            created_value["value"]["updateTime"]
                .as_str()
                .is_some_and(|time| time.ends_with('Z')),
            "{created_value}"
        );
        let error = decode_document_event(b"\xff\xfe not an event").expect_err("garbage");
        assert!(
            error
                .to_string()
                .starts_with("the body is not a Firestore document event"),
            "{error}"
        );
    }

    #[test]
    fn both_dispatch_builders_name_the_cause_in_headers() {
        let (_, created, updated, deleted) = create_update_delete("users/ada lovelace 火");
        for generation in [TriggerGeneration::V1, TriggerGeneration::V2] {
            let event_type = match generation {
                TriggerGeneration::V1 => V1_WRITE,
                TriggerGeneration::V2 => V2_WRITTEN,
            };
            let listener = trigger(generation, event_type, "(default)", "users/{uid}");
            for (observation, change) in [
                (&created, "created"),
                (&updated, "updated"),
                (&deleted, "deleted"),
            ] {
                let dispatch = build_dispatch(&listener, observation, 0).expect("dispatch");
                let headers = &dispatch.headers;
                assert_eq!(
                    headers[cause::DOCUMENT],
                    "users/ada%20lovelace%20%E7%81%AB",
                    "{generation:?}"
                );
                assert_eq!(
                    cause::decode(&headers[cause::DOCUMENT]),
                    "users/ada lovelace 火"
                );
                assert_eq!(headers[cause::DATABASE], "(default)");
                assert_eq!(headers[cause::CHANGE], change);
                assert_eq!(headers[cause::EVENT_ID], dispatch.event_id);
                assert!(
                    headers
                        .iter()
                        .all(
                            |(name, value)| reqwest::header::HeaderValue::from_str(value).is_ok()
                                && reqwest::header::HeaderName::from_bytes(name.as_bytes()).is_ok()
                        ),
                    "{headers:?}"
                );
            }
        }
    }

    #[test]
    fn cause_values_survive_any_text_and_plain_ones_stay_readable() {
        for text in [
            "users/ada",
            "projects/p/topics/orders.v1",
            "ada@example.test",
            "(default)",
            "a b%c\nd\r\te",
            "火🔥 ünïcode",
            "100% done",
            "",
        ] {
            let encoded = cause::encode(text);
            assert!(
                encoded.bytes().all(|byte| (0x21..=0x7e).contains(&byte)),
                "{encoded}"
            );
            assert_eq!(cause::decode(&encoded), text);
        }
        assert_eq!(cause::encode("users/ada"), "users/ada");
        assert_eq!(cause::encode("100% done"), "100%25%20done");
        // A stray % that is not an escape is kept.
        assert_eq!(cause::decode("50%-off%zz%4"), "50%-off%zz%4");
        assert!(cause::DOCUMENT.starts_with(cause::PREFIX));
        assert!(cause::AUTH_CALL.starts_with(cause::PREFIX));
    }

    #[tokio::test]
    async fn a_paused_change_counts_once_when_some_trigger_would_have_fired() {
        let registry = TriggerRegistry::default();
        let (observer, mut receiver) = TriggerObserver::channel(registry.clone());
        let (v1, v2) = registration_bodies();
        let project = "demo-fireside-phase4-trigger-oracle";
        registry
            .register_v1(project, "us-central1-v1Created", &v1)
            .expect("v1 registration");
        registry
            .register_v2(project, "us-central1-v2Created", &v2)
            .expect("v2 registration");
        let store = Store::default();
        store.add_commit_observer(observer);
        let database = DatabaseName::new(project, "(default)").expect("database");
        registry.set_background_enabled(false);
        // Two triggers would fire for this change: one dropped change.
        store
            .commit(&[Write::Create {
                key: DocumentKey::new(database.clone(), "phase4Triggers/paused").expect("key"),
                fields: Fields::new(),
            }])
            .expect("paused create");
        // No trigger listens here: nothing was dropped.
        store
            .commit(&[Write::Create {
                key: DocumentKey::new(database, "elsewhere/doc").expect("key"),
                fields: Fields::new(),
            }])
            .expect("unwatched create");
        assert!(
            receiver.try_recv().is_err(),
            "nothing is delivered while paused"
        );
        let dropped = registry.dropped();
        assert!(dropped.since.is_some());
        assert_eq!(dropped.counts, [(DroppedService::Firestore, 1)]);
        registry.note_dropped_many(DroppedService::Pubsub, 3);
        registry.note_dropped_many(DroppedService::Pubsub, 0);
        assert_eq!(
            registry.dropped().counts,
            [(DroppedService::Firestore, 1), (DroppedService::Pubsub, 3)]
        );
        registry.set_background_enabled(true);
        assert_eq!(registry.dropped(), DroppedEvents::default());
    }
}
