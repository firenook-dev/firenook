//! The live channel: one server-sent event stream per browser that carries
//! every topic a console page subscribes to.
//!
//! The console is served over plain HTTP/1.1, where a browser allows six
//! connections to one address, shared by every tab and every request; a
//! stream holds one for as long as it is open. So the console holds one
//! stream (`GET /live`, opened by one tab for the whole browser) and pages
//! add and remove subscriptions on it by POST. Each subscription resumes
//! from the last cursor it received, the engine coalesces per subscriber,
//! the outgoing queue is bounded by events and bytes, and the stream says
//! `stopping` before it ends when the suite stops.
//!
//! Wire protocol (`GET /console/api/v1/live`, `text/event-stream`):
//!
//! - `hello`: [`LiveHello`], first and once per connection;
//! - `ev`: `{"sub","name","cursor","data"}`, one event of one subscription
//!   (`id:` is the connection's sequence);
//! - `reset`: [`LiveReset`], the subscriber missed events and reloads what
//!   it shows;
//! - `end`: [`LiveEnd`], the engine closed one subscription;
//! - `stopping`: `{}`, the engine is stopping; the stream ends after it.

pub(crate) mod badges;
pub(crate) mod replay;
pub(crate) mod shell;

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use axum::Json;
use axum::Router;
use axum::extract::{Path, Query, State};
use axum::response::sse::Event;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use futures_util::stream::{self, BoxStream, StreamExt as _};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, mpsc};
use tokio_stream::StreamMap;
use tokio_stream::wrappers::ReceiverStream;
use ts_rs::TS;

use crate::api_error::{ApiError, ApiErrorDetail};
use crate::instance::{Instance, random_id};
use crate::json::ConsoleJson;
use crate::sse::{KEEPALIVE, Shutdown, sse_response};

/// Live connections one engine accepts; the next is refused with 429.
pub(crate) const MAX_CONNECTIONS: u32 = 64;
/// Subscriptions one connection holds: one connection serves every tab of a
/// browser.
pub(crate) const MAX_SUBSCRIPTIONS: u32 = 128;
/// Events queued for one connection before a subscription is told it lagged.
const QUEUE_EVENTS: usize = 256;
/// Bytes of event data queued for one connection, the same way.
const QUEUE_BYTES: usize = 8 * 1024 * 1024;
/// Room beside the data events for `reset`, `end` and `stopping`, which are
/// small and must not be refused for want of space.
const CONTROL_ROOM: usize = 128;
/// The longest subscription id.
const MAX_ID_CHARS: usize = 32;

/// The first event on a live connection.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "live/")]
pub struct LiveHello {
    /// The engine's instance id; a different one than last time means the
    /// engine restarted.
    pub instance: String,
    /// This connection's id, for `POST /live/{connection}/subscriptions`.
    pub connection: String,
    /// How often the engine writes a keep-alive comment when idle, ms.
    #[ts(type = "number")]
    pub heartbeat_ms: u64,
    pub limits: LiveLimits,
    /// A hash of the console application the engine serves; a different one
    /// than the page's own means the engine was updated, not restarted.
    pub console_build: String,
    /// The engine source revision, when the distribution recorded one.
    pub engine_revision: Option<String>,
}

/// What one connection may hold.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "live/")]
pub struct LiveLimits {
    /// Subscriptions per connection (128: one connection serves every tab
    /// of a browser).
    pub subscriptions: u32,
}

/// `GET /live?probe=1`: whether a new live connection would be accepted.
#[derive(Clone, Copy, Debug, Serialize, TS)]
#[ts(export_to = "live/")]
pub struct LiveProbe {
    /// Live connections open now.
    pub connections: u32,
    /// The most the engine accepts.
    pub limit: u32,
}

/// Subscriptions to add and remove on one connection.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "live/")]
pub struct LiveSubscriptionsRequest {
    #[serde(default)]
    pub add: Vec<LiveSubscribe>,
    /// Ids of subscriptions to end.
    #[serde(default)]
    pub remove: Vec<String>,
}

/// One subscription to open.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "live/")]
pub struct LiveSubscribe {
    /// Chosen by the console, unique on the connection, 1 to 32 characters.
    pub id: String,
    /// The topic, for example `firestore.changes`.
    pub topic: String,
    /// The topic's parameters; each topic documents its own.
    #[serde(default)]
    #[ts(type = "Record<string, unknown>")]
    pub params: serde_json::Value,
    /// The last cursor this subscriber received, to resume from it.
    #[serde(default)]
    #[ts(optional)]
    pub after: Option<String>,
}

/// What became of each subscription asked for.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "live/")]
pub struct LiveSubscriptionsResponse {
    pub accepted: Vec<String>,
    pub refused: Vec<LiveRefusal>,
}

/// A subscription the engine would not open, and why.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "live/")]
pub struct LiveRefusal {
    pub id: String,
    pub error: ApiErrorDetail,
}

/// Why a subscriber must reload what it shows.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export_to = "live/")]
pub enum ResetReason {
    /// It fell behind the topic's buffer.
    Lagged,
    /// Its cursor is older than what the topic keeps, or from another engine
    /// start, or the topic cannot replay.
    Gap,
    /// The topic's source was rebuilt (for example Functions reloaded).
    Rebuilt,
}

/// `event: reset`.
#[derive(Clone, Debug, Serialize, TS)]
#[ts(export_to = "live/")]
pub struct LiveReset {
    pub sub: String,
    pub reason: ResetReason,
    /// Entries lost between the subscriber's cursor and the start of what
    /// the topic keeps; `null` when the cursor is from another engine run
    /// or the topic cannot count.
    #[ts(type = "number | null")]
    pub missed: Option<u64>,
}

/// `event: end`: the engine closed one subscription. No `error` means the
/// topic finished (an invocation ended); an `error` means its source went
/// away and the console says so.
#[derive(Clone, Debug, Serialize, TS)]
#[ts(export_to = "live/")]
pub struct LiveEnd {
    pub sub: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<ApiErrorDetail>,
}

/// A stream of events a console page can subscribe to.
pub(crate) trait LiveTopic: Send + Sync + 'static {
    /// `<section>.<noun>`.
    fn name(&self) -> &'static str;
    /// Opens one subscription. Validates `params` (an object) and answers
    /// `ApiError::invalid` for a bad one; `after` is the subscriber's last
    /// cursor. Must not block: slow setup goes inside the returned stream.
    fn open(
        &self,
        params: &serde_json::Value,
        after: Option<&str>,
    ) -> Result<TopicStream, ApiError>;
}

/// What a topic answers one subscriber with.
pub(crate) type TopicStream = BoxStream<'static, TopicEvent>;

/// One thing a topic says to one subscriber.
#[derive(Clone, Debug)]
pub(crate) enum TopicEvent {
    /// A named event; `cursor` when the topic can resume from it; `data` is
    /// JSON serialized once and shared.
    Event {
        name: &'static str,
        cursor: Option<Arc<str>>,
        data: Arc<str>,
    },
    /// The subscriber missed events; `missed` as in `LiveReset`.
    Reset {
        reason: ResetReason,
        missed: Option<u64>,
    },
    /// The subscription is over: `None` finished, `Some` the source went away.
    #[allow(
        dead_code,
        reason = "said by topics whose subscription finishes or loses its source: an invocation, a late section the suite stopped before it started"
    )]
    End(Option<ApiErrorDetail>),
}

impl TopicEvent {
    /// Serializes `data` once; use for one-subscriber events.
    pub(crate) fn json(name: &'static str, cursor: Option<String>, data: &impl Serialize) -> Self {
        Self::Event {
            name,
            cursor: cursor.map(Arc::from),
            // The console's own types always serialize.
            data: Arc::from(serde_json::to_string(data).unwrap_or_else(|_| "null".to_owned())),
        }
    }
}

/// A topic's parameters, typed. Topics declare their params struct with
/// `#[serde(deny_unknown_fields, rename_all = "camelCase")]`, so a misspelt
/// parameter is refused in the POST answer instead of being ignored.
pub(crate) fn topic_params<T: DeserializeOwned>(value: &serde_json::Value) -> Result<T, ApiError> {
    let value = match value {
        serde_json::Value::Null => serde_json::Value::Object(serde_json::Map::new()),
        serde_json::Value::Object(_) => value.clone(),
        _ => return Err(ApiError::invalid("Topic parameters are a JSON object.")),
    };
    serde_json::from_value(value).map_err(|error| {
        ApiError::invalid(format!("These topic parameters are not valid: {error}."))
    })
}

/// What every `hello` says besides the connection.
#[derive(Clone, Debug)]
pub(crate) struct HelloFacts {
    pub(crate) instance: Instance,
    pub(crate) console_build: String,
    pub(crate) engine_revision: Option<String>,
}

enum Command {
    Add {
        id: String,
        topic: Arc<dyn LiveTopic>,
        params: serde_json::Value,
        after: Option<String>,
        stream: TopicStream,
    },
    Remove {
        id: String,
    },
}

#[derive(Clone)]
struct ConnectionHandle {
    commands: mpsc::Sender<Command>,
    /// The subscription ids in use, so a POST is validated before it is
    /// handed to the connection.
    ids: Arc<Mutex<HashSet<String>>>,
}

struct HubInner {
    topics: BTreeMap<&'static str, Arc<dyn LiveTopic>>,
    /// Sections that are not part of this suite, by topic prefix, with the
    /// service that turns them on.
    absent: BTreeMap<&'static str, &'static str>,
    connections: Mutex<HashMap<String, ConnectionHandle>>,
    slots: Arc<Semaphore>,
    facts: HelloFacts,
    shutdown: Shutdown,
}

/// The live channel's routes and the connections they hold.
#[derive(Clone)]
pub(crate) struct LiveHub {
    inner: Arc<HubInner>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl LiveHub {
    /// A hub serving `topics`. `absent` names the topic prefixes of sections
    /// this suite does not run, with the service that turns each on.
    pub(crate) fn new(
        topics: Vec<Arc<dyn LiveTopic>>,
        absent: BTreeMap<&'static str, &'static str>,
        facts: HelloFacts,
        shutdown: Shutdown,
    ) -> Self {
        Self {
            inner: Arc::new(HubInner {
                topics: topics
                    .into_iter()
                    .map(|topic| (topic.name(), topic))
                    .collect(),
                absent,
                connections: Mutex::new(HashMap::new()),
                slots: Arc::new(Semaphore::new(MAX_CONNECTIONS as usize)),
                facts,
                shutdown,
            }),
        }
    }

    /// `GET /live`, `GET /live?probe=1` and `POST /live/{connection}/subscriptions`.
    pub(crate) fn router(self) -> Router {
        Router::new()
            .route("/live", get(open_live))
            .route("/live/{connection}/subscriptions", post(subscriptions))
            .with_state(self)
    }

    fn open_connections(&self) -> u32 {
        let available = u32::try_from(self.inner.slots.available_permits()).unwrap_or(0);
        MAX_CONNECTIONS.saturating_sub(available)
    }

    #[cfg(test)]
    pub(crate) fn registered_connections(&self) -> usize {
        lock(&self.inner.connections).len()
    }
}

#[derive(Debug, Default, Deserialize)]
struct LiveQuery {
    probe: Option<String>,
}

/// `GET /live`: opens this browser's live stream, or with `?probe=1` says
/// whether one would be accepted without taking a slot.
async fn open_live(State(hub): State<LiveHub>, Query(query): Query<LiveQuery>) -> Response {
    if query
        .probe
        .as_deref()
        .is_some_and(|probe| matches!(probe, "1" | "true"))
    {
        return Json(LiveProbe {
            connections: hub.open_connections(),
            limit: MAX_CONNECTIONS,
        })
        .into_response();
    }
    if hub.inner.shutdown.is_stopping() {
        return ApiError::unavailable("The engine is stopping.").into_response();
    }
    let Ok(slot) = hub.inner.slots.clone().try_acquire_owned() else {
        return ApiError::exhausted(format!(
            "This engine already serves {MAX_CONNECTIONS} live console connections."
        ))
        .with_fix("Close the console in browsers or profiles you are not using; each holds one.")
        .into_response();
    };
    let connection = random_id('c');
    let (commands, receiver) = mpsc::channel(64);
    lock(&hub.inner.connections).insert(
        connection.clone(),
        ConnectionHandle {
            commands,
            ids: Arc::default(),
        },
    );
    let (out, events) = mpsc::channel(QUEUE_EVENTS + CONTROL_ROOM);
    let hello = LiveHello {
        instance: hub.inner.facts.instance.id.clone(),
        connection: connection.clone(),
        heartbeat_ms: u64::try_from(KEEPALIVE.as_millis()).unwrap_or(u64::MAX),
        limits: LiveLimits {
            subscriptions: MAX_SUBSCRIPTIONS,
        },
        console_build: hub.inner.facts.console_build.clone(),
        engine_revision: hub.inner.facts.engine_revision.clone(),
    };
    // A fresh channel always has room for its first event.
    let _ = out.try_send(Outgoing::control(
        crate::sse::json_event("hello", &hello).retry(Duration::from_secs(1)),
    ));
    let shutdown = hub.inner.shutdown.clone();
    tokio::spawn(Connection::new(hub, connection, out).run(receiver, slot));
    sse_response(
        ReceiverStream::new(events).map(|outgoing: Outgoing| outgoing.event),
        shutdown,
    )
    .into_response()
}

/// `POST /live/{connection}/subscriptions`: adds and removes subscriptions.
/// Each add is opened here, so a bad one is refused in this answer rather
/// than on the stream.
async fn subscriptions(
    State(hub): State<LiveHub>,
    Path(connection): Path<String>,
    ConsoleJson(request): ConsoleJson<LiveSubscriptionsRequest>,
) -> Result<Json<LiveSubscriptionsResponse>, ApiError> {
    let gone = || {
        ApiError::not_found(format!("No live connection named {connection}."))
            .with_fix("Subscribe again after the next hello on the live stream.")
    };
    let handle = lock(&hub.inner.connections)
        .get(&connection)
        .cloned()
        .ok_or_else(gone)?;
    // Validate the whole request and reserve its ids under one lock, so two
    // requests cannot both take an id.
    {
        let mut ids = lock(&handle.ids);
        for id in &request.remove {
            ids.remove(id);
        }
        let mut asked = HashSet::new();
        for add in &request.add {
            let length = add.id.chars().count();
            if length == 0 || length > MAX_ID_CHARS {
                return Err(ApiError::invalid(format!(
                    "A subscription id has 1 to {MAX_ID_CHARS} characters; `{}` has {length}.",
                    add.id
                )));
            }
            if ids.contains(&add.id) || !asked.insert(add.id.as_str()) {
                return Err(ApiError::invalid(format!(
                    "Subscription {} already exists on this connection.",
                    add.id
                ))
                .with_fix("Give every subscription its own id; ids are never reused."));
            }
        }
        if ids.len() + request.add.len() > MAX_SUBSCRIPTIONS as usize {
            return Err(ApiError::invalid(format!(
                "A live connection holds at most {MAX_SUBSCRIPTIONS} subscriptions."
            ))
            .with_fix("Remove subscriptions the console no longer shows before adding more."));
        }
        ids.extend(request.add.iter().map(|add| add.id.clone()));
    }
    for id in request.remove {
        handle
            .commands
            .send(Command::Remove { id })
            .await
            .map_err(|_| gone())?;
    }
    let mut response = LiveSubscriptionsResponse {
        accepted: Vec::new(),
        refused: Vec::new(),
    };
    for add in request.add {
        let opened = match hub.inner.topics.get(add.topic.as_str()) {
            Some(topic) => topic
                .open(&add.params, add.after.as_deref())
                .map(|stream| (Arc::clone(topic), stream)),
            None => Err(unknown_topic(&hub, &add.topic)),
        };
        match opened {
            Ok((topic, stream)) => {
                handle
                    .commands
                    .send(Command::Add {
                        id: add.id.clone(),
                        topic,
                        params: add.params,
                        after: add.after,
                        stream,
                    })
                    .await
                    .map_err(|_| gone())?;
                response.accepted.push(add.id);
            }
            Err(error) => {
                lock(&handle.ids).remove(&add.id);
                response.refused.push(LiveRefusal {
                    id: add.id,
                    error: error.detail().clone(),
                });
            }
        }
    }
    Ok(Json(response))
}

fn unknown_topic(hub: &LiveHub, topic: &str) -> ApiError {
    let error = ApiError::invalid(format!("No live topic named `{topic}`."));
    let prefix = topic.split('.').next().unwrap_or_default();
    match hub.inner.absent.get(prefix) {
        Some(service) => error.with_fix(format!("Start the engine with {service}.")),
        None => error,
    }
}

/// One queued event, holding its share of the connection's queue until the
/// response body takes it.
struct Outgoing {
    event: Event,
    _permits: Option<(OwnedSemaphorePermit, OwnedSemaphorePermit)>,
}

impl Outgoing {
    const fn control(event: Event) -> Self {
        Self {
            event,
            _permits: None,
        }
    }
}

struct Subscription {
    topic: Arc<dyn LiveTopic>,
    params: serde_json::Value,
    /// The last cursor delivered to the browser.
    cursor: Option<Arc<str>>,
}

/// One live connection's task: it owns every subscription's stream and
/// writes their events into the connection's bounded queue.
struct Connection {
    hub: LiveHub,
    id: String,
    out: mpsc::Sender<Outgoing>,
    queued_events: Arc<Semaphore>,
    queued_bytes: Arc<Semaphore>,
    streams: StreamMap<String, BoxStream<'static, Option<TopicEvent>>>,
    subscriptions: HashMap<String, Subscription>,
    /// Subscriptions that overflowed the queue, re-opened from their last
    /// cursor once it has room again.
    lagged: Vec<String>,
    sequence: u64,
}

impl Connection {
    fn new(hub: LiveHub, id: String, out: mpsc::Sender<Outgoing>) -> Self {
        Self {
            hub,
            id,
            out,
            queued_events: Arc::new(Semaphore::new(QUEUE_EVENTS)),
            queued_bytes: Arc::new(Semaphore::new(QUEUE_BYTES)),
            streams: StreamMap::new(),
            subscriptions: HashMap::new(),
            lagged: Vec::new(),
            sequence: 0,
        }
    }

    async fn run(mut self, mut commands: mpsc::Receiver<Command>, slot: OwnedSemaphorePermit) {
        let stopped = self.hub.inner.shutdown.clone().stopped();
        tokio::pin!(stopped);
        loop {
            if !self.lagged.is_empty() && self.has_room() {
                self.reopen_lagged().await;
            }
            tokio::select! {
                biased;
                () = &mut stopped => {
                    // The browser hears why the stream ends, unless it is
                    // gone or not reading; the response ends either way.
                    let stopping = Event::default().event("stopping").data("{}");
                    let _ = tokio::time::timeout(
                        Duration::from_secs(1),
                        self.out.send(Outgoing::control(stopping)),
                    )
                    .await;
                    break;
                }
                () = self.out.closed() => break,
                command = commands.recv() => match command {
                    Some(Command::Add { id, topic, params, after, stream }) => {
                        self.streams.insert(id.clone(), finishing(stream));
                        self.subscriptions.insert(id, Subscription {
                            topic,
                            params,
                            cursor: after.map(Arc::from),
                        });
                    }
                    Some(Command::Remove { id }) => self.forget(&id),
                    None => break,
                },
                Some((id, event)) = self.streams.next(), if !self.streams.is_empty() => {
                    if !self.deliver(id, event).await {
                        break;
                    }
                }
                () = tokio::time::sleep(Duration::from_millis(50)), if !self.lagged.is_empty() => {}
            }
        }
        lock(&self.hub.inner.connections).remove(&self.id);
        drop(slot);
    }

    /// Writes one topic event; answers `false` when the browser is gone.
    async fn deliver(&mut self, id: String, event: Option<TopicEvent>) -> bool {
        match event {
            Some(TopicEvent::Event { name, cursor, data }) => {
                let envelope = envelope(&id, name, cursor.as_deref(), &data);
                let Some(permits) = self.reserve(envelope.len()) else {
                    // The browser is not keeping up: this subscription's
                    // pending events go, it is told to reload, and it
                    // resumes from its last cursor once the queue drains.
                    self.streams.remove(&id);
                    self.lagged.push(id.clone());
                    return send_control(&self.out, reset_event(&id, ResetReason::Lagged, None))
                        .await;
                };
                self.sequence += 1;
                let event = Event::default()
                    .event("ev")
                    .id(self.sequence.to_string())
                    .data(envelope);
                let queued = self.out.try_send(Outgoing {
                    event,
                    _permits: Some(permits),
                });
                match queued {
                    Ok(()) => {
                        if let (Some(cursor), Some(subscription)) =
                            (cursor, self.subscriptions.get_mut(&id))
                        {
                            subscription.cursor = Some(cursor);
                        }
                        true
                    }
                    Err(mpsc::error::TrySendError::Closed(_)) => false,
                    Err(mpsc::error::TrySendError::Full(_)) => {
                        self.streams.remove(&id);
                        self.lagged.push(id.clone());
                        send_control(&self.out, reset_event(&id, ResetReason::Lagged, None)).await
                    }
                }
            }
            Some(TopicEvent::Reset { reason, missed }) => {
                send_control(&self.out, reset_event(&id, reason, missed)).await
            }
            Some(TopicEvent::End(error)) => {
                self.forget(&id);
                send_control(&self.out, end_event(&id, error)).await
            }
            // A topic stream that ran out without saying so is finished.
            None => {
                self.forget(&id);
                send_control(&self.out, end_event(&id, None)).await
            }
        }
    }

    fn forget(&mut self, id: &str) {
        self.streams.remove(id);
        self.subscriptions.remove(id);
        self.lagged.retain(|lagged| lagged != id);
        if let Some(handle) = lock(&self.hub.inner.connections).get(&self.id) {
            lock(&handle.ids).remove(id);
        }
    }

    fn reserve(&self, bytes: usize) -> Option<(OwnedSemaphorePermit, OwnedSemaphorePermit)> {
        let count = self.queued_events.clone().try_acquire_owned().ok()?;
        let bytes = u32::try_from(bytes.clamp(1, QUEUE_BYTES)).unwrap_or(u32::MAX);
        let size = self
            .queued_bytes
            .clone()
            .try_acquire_many_owned(bytes)
            .ok()?;
        Some((count, size))
    }

    fn has_room(&self) -> bool {
        self.queued_events.available_permits() >= QUEUE_EVENTS / 2
            && self.queued_bytes.available_permits() >= QUEUE_BYTES / 2
    }

    async fn reopen_lagged(&mut self) {
        for id in std::mem::take(&mut self.lagged) {
            let Some(subscription) = self.subscriptions.get(&id) else {
                continue;
            };
            match subscription
                .topic
                .open(&subscription.params, subscription.cursor.as_deref())
            {
                Ok(stream) => {
                    self.streams.insert(id, finishing(stream));
                }
                Err(error) => {
                    self.forget(&id);
                    let _ =
                        send_control(&self.out, end_event(&id, Some(error.detail().clone()))).await;
                }
            }
        }
    }
}

/// Queues `reset`, `end` or `stopping`, waiting for room if it must;
/// answers `false` when the browser is gone.
async fn send_control(out: &mpsc::Sender<Outgoing>, event: Event) -> bool {
    out.send(Outgoing::control(event)).await.is_ok()
}

/// A topic stream whose end is marked, so the connection can tell the
/// browser a subscription finished.
fn finishing(stream: TopicStream) -> BoxStream<'static, Option<TopicEvent>> {
    stream.map(Some).chain(stream::once(async { None })).boxed()
}

/// `{"sub":…,"name":…,"cursor":…,"data":…}`, written by hand so a payload
/// serialized once is shared by every subscriber.
fn envelope(sub: &str, name: &str, cursor: Option<&str>, data: &str) -> String {
    let quote = |text: &str| serde_json::to_string(text).unwrap_or_else(|_| "\"\"".to_owned());
    let mut envelope = String::with_capacity(data.len() + sub.len() + name.len() + 64);
    envelope.push_str("{\"sub\":");
    envelope.push_str(&quote(sub));
    envelope.push_str(",\"name\":");
    envelope.push_str(&quote(name));
    envelope.push_str(",\"cursor\":");
    match cursor {
        Some(cursor) => envelope.push_str(&quote(cursor)),
        None => envelope.push_str("null"),
    }
    envelope.push_str(",\"data\":");
    envelope.push_str(data);
    envelope.push('}');
    envelope
}

fn reset_event(sub: &str, reason: ResetReason, missed: Option<u64>) -> Event {
    crate::sse::json_event(
        "reset",
        &LiveReset {
            sub: sub.to_owned(),
            reason,
            missed,
        },
    )
}

fn end_event(sub: &str, error: Option<ApiErrorDetail>) -> Event {
    crate::sse::json_event(
        "end",
        &LiveEnd {
            sub: sub.to_owned(),
            error,
        },
    )
}

/// Every wire type, into `generated/live/`.
#[cfg(test)]
pub(crate) fn export_bindings(config: &ts_rs::Config) {
    LiveHello::export_all(config).expect("TypeScript bindings written");
    LiveProbe::export_all(config).expect("TypeScript bindings written");
    LiveSubscriptionsRequest::export_all(config).expect("TypeScript bindings written");
    LiveSubscriptionsResponse::export_all(config).expect("TypeScript bindings written");
    LiveReset::export_all(config).expect("TypeScript bindings written");
    LiveEnd::export_all(config).expect("TypeScript bindings written");
    badges::BadgeSet::export_all(config).expect("TypeScript bindings written");
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
