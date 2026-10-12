//! The Eventarc console API, mounted at `/console/api/v1/eventarc`: the
//! channels with who publishes and who listens (`GET /eventarc/channels`),
//! every kept event with what each subscription did with it, replays, and
//! publishing a custom event (`POST /eventarc/channel/publish`, the channel
//! in the body because its name holds `/`).
//!
//! Firebase Alerts are not delivered by this engine yet, so there is no
//! `/eventarc/alert/send` and the snapshot says `alertsDelivered: false`.

use std::collections::BTreeMap;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use firenook_functions_runtime::console::{ChannelView, RuntimeStatus};
use firenook_functions_runtime::monitor::{
    EventarcEventDetail, EventarcEventQuery, EventarcEventSummary, EventarcOrigin, FunctionsPhase,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use ts_rs::TS;

use super::extensions::ExtensionDeclaredEvent;
use super::filters::event_filter;
use super::functions::{BODY_LIMIT, FunctionStatus, NoBody};
use super::{ComputeState, console_error, grouped, random_uuid};
use crate::api_error::ApiError;
use crate::entity::EntityRef;
use crate::json::{BodyLimit, ConsoleJson};
use crate::paging::{Page, PageBuilder, Total, decode_cursor};

/// Events one page holds by default, and at most.
const DEFAULT_PAGE: usize = 200;
const MAX_PAGE: usize = 500;
/// `CloudEvent` attributes a publisher cannot set as extensions.
const RESERVED_ATTRIBUTES: [&str; 8] = [
    "id",
    "source",
    "specversion",
    "type",
    "time",
    "subject",
    "datacontenttype",
    "data",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub(crate) enum EventarcSubscriptionOrigin {
    /// A function definition listens on the channel.
    Definition,
    /// Registered through the Eventarc emulator's own route by a tool.
    Registered,
}

/// One trigger listening on a channel.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub(crate) struct EventarcSubscription {
    pub(crate) trigger_key: String,
    pub(crate) function_id: Option<String>,
    /// The function in Functions.
    pub(crate) function: Option<EntityRef>,
    pub(crate) event_type: String,
    pub(crate) filters: BTreeMap<String, String>,
    pub(crate) origin: EventarcSubscriptionOrigin,
    pub(crate) status: FunctionStatus,
}

/// An Extensions instance that publishes on a channel.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub(crate) struct EventarcPublisher {
    pub(crate) instance_id: String,
    /// The instance in Extensions.
    pub(crate) instance: EntityRef,
    /// The `CloudEvent` source the instance publishes with.
    pub(crate) source: String,
    pub(crate) allowed: Vec<String>,
    pub(crate) declared: Vec<ExtensionDeclaredEvent>,
}

/// A channel: who publishes on it and who listens.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub(crate) struct EventarcChannel {
    /// Full resource name, or `google` for the native channel.
    pub(crate) name: String,
    pub(crate) location: Option<String>,
    pub(crate) id: String,
    pub(crate) publishers: Vec<EventarcPublisher>,
    pub(crate) subscriptions: Vec<EventarcSubscription>,
    /// Events kept from this channel.
    pub(crate) events: u32,
    pub(crate) last_event_at: Option<String>,
}

/// Every channel, and where `eventarc.events` resumes.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub(crate) struct EventarcSnapshot {
    pub(crate) phase: FunctionsPhase,
    pub(crate) channels: Vec<EventarcChannel>,
    pub(crate) native: EventarcChannel,
    /// Firebase Alerts functions receive alerts in this engine. The Alerts
    /// page exists only in builds where this is true.
    pub(crate) alerts_delivered: bool,
    pub(crate) live_cursor: String,
}

/// A page of events, newest first, and where the live topic resumes for it
/// (first page only).
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub(crate) struct EventarcEventsResult {
    pub(crate) page: Page<EventarcEventSummary>,
    pub(crate) live_cursor: Option<String>,
}

/// One event and, per delivery (in the order of `detail.deliveries`), its
/// function and invocation in Functions.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub(crate) struct EventarcEventView {
    pub(crate) detail: EventarcEventDetail,
    pub(crate) deliveries: Vec<EventarcDeliveryRefs>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub(crate) struct EventarcDeliveryRefs {
    pub(crate) function: Option<EntityRef>,
    pub(crate) invocation: Option<EntityRef>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub(crate) enum EventarcDataEncoding {
    Json,
    Text,
}

/// A custom event to publish.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "compute/")]
pub(crate) struct EventarcPublishRequest {
    pub(crate) channel: String,
    #[serde(rename = "type")]
    pub(crate) event_type: String,
    pub(crate) source: String,
    #[serde(default)]
    pub(crate) subject: Option<String>,
    /// Generated (UUID) when absent.
    #[serde(default)]
    pub(crate) id: Option<String>,
    /// Now when absent.
    #[serde(default)]
    pub(crate) time: Option<String>,
    pub(crate) encoding: EventarcDataEncoding,
    /// JSON text or plain text.
    #[serde(default)]
    pub(crate) data: String,
    #[serde(default)]
    pub(crate) attributes: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "compute/")]
pub(crate) struct EventarcReplayRequest {
    #[serde(default)]
    pub(crate) keep_id: bool,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "compute/")]
pub(crate) struct EventarcPublishResult {
    pub(crate) event: EventarcEventSummary,
}

/// Every `/eventarc` route.
pub(crate) fn router(state: ComputeState) -> Router {
    let limit = Extension(BodyLimit(BODY_LIMIT));
    Router::new()
        .route("/eventarc/channels", get(snapshot))
        .route(
            "/eventarc/events",
            get(events).delete(clear_events).layer(limit),
        )
        .route("/eventarc/events/{id}", get(event))
        .route("/eventarc/events/{id}/replay", post(replay).layer(limit))
        .route("/eventarc/channel/publish", post(publish).layer(limit))
        .with_state(state)
}

/// Events kept per channel: how many, and the newest one's time.
fn channel_counts(state: &ComputeState) -> (BTreeMap<String, (u32, String)>, String) {
    let monitor = state.monitor();
    monitor.snapshot(|view| {
        let page = view.events(
            &EventarcEventQuery {
                channel: None,
                filter: None,
                limit: monitor.limits().events,
            },
            None,
        );
        let mut counts: BTreeMap<String, (u32, String)> = BTreeMap::new();
        // Newest first: the first seen per channel is its newest.
        for summary in page.items {
            let entry = counts
                .entry(summary.channel.clone())
                .or_insert_with(|| (0, summary.received_at.clone()));
            entry.0 = entry.0.saturating_add(1);
        }
        (counts, state.live.eventarc.position().to_string())
    })
}

async fn snapshot(State(state): State<ComputeState>) -> Json<EventarcSnapshot> {
    let phase = state.monitor().phase();
    let (counts, live_cursor) = channel_counts(&state);
    let mut views: Vec<ChannelView> = Vec::new();
    let mut declared: BTreeMap<String, Vec<ExtensionDeclaredEvent>> = BTreeMap::new();
    if let Ok(control) = state.control() {
        views = control.runtime.eventarc().await.channels;
        if let Some(extensions) = &control.extensions {
            for (id, instance) in extensions.instances().await {
                let Some(loaded) = &instance.loaded else {
                    continue;
                };
                let allowed: Vec<&str> = loaded
                    .backend
                    .env
                    .get("ALLOWED_EVENT_TYPES")
                    .map(|types| types.split(',').map(str::trim).collect())
                    .unwrap_or_default();
                let events = loaded
                    .spec
                    .get("events")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|event| {
                        let event_type = event.get("type")?.as_str()?.to_owned();
                        Some(ExtensionDeclaredEvent {
                            allowed: allowed.contains(&event_type.as_str()),
                            description: event
                                .get("description")
                                .and_then(Value::as_str)
                                .map(str::to_owned),
                            event_type,
                        })
                    })
                    .collect();
                declared.insert(id, events);
            }
        }
    }
    let mut channels: BTreeMap<String, EventarcChannel> = views
        .into_iter()
        .map(|view| (view.name.clone(), channel_of(view, &declared)))
        .collect();
    // Channels that received events nobody configured.
    for name in counts.keys() {
        channels.entry(name.clone()).or_insert_with(|| {
            channel_of(
                ChannelView {
                    name: name.clone(),
                    publishers: Vec::new(),
                    subscriptions: Vec::new(),
                },
                &declared,
            )
        });
    }
    for channel in channels.values_mut() {
        if let Some((events, last)) = counts.get(&channel.name) {
            channel.events = *events;
            channel.last_event_at = Some(last.clone());
        }
    }
    let native = channels.remove("google").unwrap_or_else(|| {
        channel_of(
            ChannelView {
                name: "google".to_owned(),
                publishers: Vec::new(),
                subscriptions: Vec::new(),
            },
            &declared,
        )
    });
    Json(EventarcSnapshot {
        phase,
        channels: channels.into_values().collect(),
        native,
        alerts_delivered: false,
        live_cursor,
    })
}

fn channel_of(
    view: ChannelView,
    declared: &BTreeMap<String, Vec<ExtensionDeclaredEvent>>,
) -> EventarcChannel {
    let (location, id) = match view.name.split('/').collect::<Vec<_>>().as_slice() {
        ["projects", _, "locations", location, "channels", id] => {
            (Some((*location).to_owned()), (*id).to_owned())
        }
        _ => (None, view.name.clone()),
    };
    EventarcChannel {
        location,
        id,
        publishers: view
            .publishers
            .into_iter()
            .map(|publisher| EventarcPublisher {
                instance: EntityRef::extension_instance(&publisher.instance_id),
                declared: declared
                    .get(&publisher.instance_id)
                    .cloned()
                    .unwrap_or_default(),
                instance_id: publisher.instance_id,
                source: publisher.source,
                allowed: publisher.allowed,
            })
            .collect(),
        subscriptions: view
            .subscriptions
            .into_iter()
            .map(|subscription| EventarcSubscription {
                function: subscription.function_id.as_deref().map(EntityRef::function),
                function_id: subscription.function_id,
                trigger_key: subscription.trigger_key,
                event_type: subscription.event_type,
                filters: subscription.filters,
                origin: if subscription.registered {
                    EventarcSubscriptionOrigin::Registered
                } else {
                    EventarcSubscriptionOrigin::Definition
                },
                status: match subscription.status {
                    None | Some(RuntimeStatus::Receiving) => FunctionStatus::Receiving,
                    Some(RuntimeStatus::Ignored(_)) => FunctionStatus::Ignored,
                    Some(RuntimeStatus::Paused) => FunctionStatus::Paused,
                    Some(RuntimeStatus::Removed) => FunctionStatus::Removed,
                },
            })
            .collect(),
        events: 0,
        last_event_at: None,
        name: view.name,
    }
}

#[derive(Debug, Default, Deserialize)]
struct EventsParams {
    #[serde(default)]
    channel: Option<String>,
    #[serde(default)]
    q: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
    #[serde(default)]
    cursor: Option<String>,
}

/// Where a page of events continues.
#[derive(Debug, Serialize, Deserialize)]
struct EventCursor {
    nonce: String,
    before: u64,
}

async fn events(
    State(state): State<ComputeState>,
    Query(params): Query<EventsParams>,
) -> Result<Json<EventarcEventsResult>, ApiError> {
    let filter = event_filter(params.q.as_deref().unwrap_or_default())?;
    let monitor = state.monitor();
    let before = match params.cursor.as_deref() {
        Some(cursor) => {
            let cursor: EventCursor = decode_cursor(cursor)?;
            if cursor.nonce != monitor.nonce() {
                return Err(ApiError::invalid(
                    "This cursor is from an earlier start of the engine.",
                )
                .with_fix("Load the list again from its first page."));
            }
            Some(cursor.before)
        }
        None => None,
    };
    let limit = params.limit.unwrap_or(DEFAULT_PAGE).clamp(1, MAX_PAGE);
    let channel = params.channel.filter(|channel| !channel.is_empty());
    let query = EventarcEventQuery {
        channel: channel.as_deref(),
        filter: filter
            .as_deref()
            .map(|filter| filter as &(dyn Fn(&EventarcEventSummary) -> bool + Sync)),
        limit,
    };
    let first = before.is_none();
    let (found, live_cursor) = monitor.snapshot(|view| {
        (
            view.events(&query, before),
            first.then(|| state.live.eventarc.position().to_string()),
        )
    });
    let nonce = monitor.nonce().to_owned();
    let mut builder = PageBuilder::new(limit);
    let offered = found.items.len();
    let mut added = 0;
    for summary in found.items {
        let key = EventCursor {
            nonce: nonce.clone(),
            before: summary.seq,
        };
        if !builder.push(summary, key) {
            break;
        }
        added += 1;
    }
    let more = found.next.is_some() || added < offered;
    Ok(Json(EventarcEventsResult {
        page: builder.finish(
            more,
            false,
            Some(Total {
                count: found.total,
                exact: true,
            }),
            None,
        ),
        live_cursor,
    }))
}

async fn clear_events(
    State(state): State<ComputeState>,
    ConsoleJson(NoBody {}): ConsoleJson<NoBody>,
) -> StatusCode {
    state.monitor().clear_events();
    StatusCode::NO_CONTENT
}

fn event_not_kept(state: &ComputeState) -> ApiError {
    ApiError::not_found(format!(
        "The engine no longer keeps this event; it keeps the newest {}.",
        grouped(state.monitor().limits().events as u64)
    ))
}

async fn event(
    State(state): State<ComputeState>,
    Path(id): Path<String>,
) -> Result<Json<EventarcEventView>, ApiError> {
    let detail = state
        .monitor()
        .event(&id)
        .ok_or_else(|| event_not_kept(&state))?;
    Ok(Json(event_view(detail)))
}

/// An event with the refs of each delivery's function and invocation.
pub(crate) fn event_view(detail: EventarcEventDetail) -> EventarcEventView {
    let deliveries = detail
        .deliveries
        .iter()
        .map(|delivery| EventarcDeliveryRefs {
            function: delivery.function_id.as_deref().map(EntityRef::function),
            invocation: delivery.invocation_id.as_deref().map(EntityRef::invocation),
        })
        .collect();
    EventarcEventView { detail, deliveries }
}

async fn replay(
    State(state): State<ComputeState>,
    Path(id): Path<String>,
    ConsoleJson(request): ConsoleJson<EventarcReplayRequest>,
) -> Result<Json<EventarcPublishResult>, ApiError> {
    let runtime = state.runtime()?;
    if state.monitor().event(&id).is_none() {
        return Err(event_not_kept(&state));
    }
    let replayed = runtime
        .replay_event(&id, request.keep_id)
        .await
        .map_err(console_error)?;
    published(&state, &replayed)
}

fn published(state: &ComputeState, id: &str) -> Result<Json<EventarcPublishResult>, ApiError> {
    state
        .monitor()
        .event(id)
        .map(|detail| {
            Json(EventarcPublishResult {
                event: detail.summary,
            })
        })
        .ok_or_else(|| ApiError::internal("The event was published but is not kept."))
}

async fn publish(
    State(state): State<ComputeState>,
    ConsoleJson(request): ConsoleJson<EventarcPublishRequest>,
) -> Result<Json<EventarcPublishResult>, ApiError> {
    let runtime = state.runtime()?;
    let event = build_event(&request)?;
    let ids = runtime
        .publish(&request.channel, vec![event], EventarcOrigin::Console)
        .await
        .map_err(console_error)?;
    let id = ids
        .into_iter()
        .next()
        .ok_or_else(|| ApiError::internal("The event was not recorded."))?;
    published(&state, &id)
}

/// The event as the Admin SDK sends it to a channel (proto JSON with the
/// data as `textData`), or as a structured `CloudEvent` on the native
/// channel, so it takes the same conversion an app's event takes.
pub(crate) fn build_event(request: &EventarcPublishRequest) -> Result<Value, ApiError> {
    check_publish(request)?;
    let channel = request.channel.trim();
    let (content_type, data) = match request.encoding {
        EventarcDataEncoding::Json => {
            let parsed: Value = if request.data.trim().is_empty() {
                json!({})
            } else {
                serde_json::from_str(&request.data)
                    .map_err(|error| ApiError::invalid(format!("The data is not JSON: {error}.")))?
            };
            ("application/json", parsed)
        }
        EventarcDataEncoding::Text => ("text/plain", Value::String(request.data.clone())),
    };
    let id = request
        .id
        .clone()
        .filter(|id| !id.trim().is_empty())
        .unwrap_or_else(random_uuid);
    let time = request
        .time
        .clone()
        .filter(|time| !time.trim().is_empty())
        .unwrap_or_else(|| {
            time::OffsetDateTime::now_utc()
                .format(&time::format_description::well_known::Rfc3339)
                .unwrap_or_default()
        });
    let subject = request
        .subject
        .clone()
        .filter(|subject| !subject.is_empty());
    if channel == "google" {
        let mut event = json!({
            "specversion": "1.0",
            "id": id,
            "source": request.source,
            "type": request.event_type,
            "time": time,
            "datacontenttype": content_type,
            "data": data,
        });
        if let Some(subject) = subject {
            event["subject"] = Value::String(subject);
        }
        for (name, value) in &request.attributes {
            event[name] = Value::String(value.clone());
        }
        return Ok(event);
    }
    let mut attributes = serde_json::Map::new();
    attributes.insert(
        "datacontenttype".to_owned(),
        json!({ "ceString": content_type }),
    );
    attributes.insert("time".to_owned(), json!({ "ceTimestamp": time }));
    if let Some(subject) = subject {
        attributes.insert("subject".to_owned(), json!({ "ceString": subject }));
    }
    for (name, value) in &request.attributes {
        attributes.insert(name.clone(), json!({ "ceString": value }));
    }
    let text_data = match &data {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    };
    Ok(json!({
        "id": id,
        "source": request.source,
        "specVersion": "1.0",
        "type": request.event_type,
        "attributes": attributes,
        "textData": text_data,
    }))
}

/// What a publish request must hold: a channel name, a type, a source,
/// and extension attribute names Eventarc accepts.
fn check_publish(request: &EventarcPublishRequest) -> Result<(), ApiError> {
    let channel = request.channel.trim();
    if channel.is_empty() {
        return Err(ApiError::invalid("Name the channel to publish on."));
    }
    if channel != "google" && !is_channel_name(channel) {
        return Err(ApiError::invalid(
            "The channel is projects/<project>/locations/<location>/channels/<id>, or google for the native channel.",
        ));
    }
    if request.event_type.trim().is_empty() {
        return Err(ApiError::invalid("The event needs a type."));
    }
    if request.source.trim().is_empty() {
        return Err(ApiError::invalid("The event needs a source."));
    }
    for name in request.attributes.keys() {
        let valid = !name.is_empty()
            && name.len() <= 20
            && name
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit());
        if !valid {
            return Err(ApiError::invalid(format!(
                "The attribute name \"{name}\" must be 1 to 20 lowercase letters or digits."
            )));
        }
        if RESERVED_ATTRIBUTES.contains(&name.as_str()) {
            return Err(ApiError::invalid(format!(
                "\"{name}\" is a CloudEvent attribute of its own; set it with its own field."
            )));
        }
    }
    Ok(())
}

fn is_channel_name(name: &str) -> bool {
    matches!(
        name.split('/').collect::<Vec<_>>().as_slice(),
        ["projects", project, "locations", location, "channels", id]
            if !project.is_empty() && !location.is_empty() && !id.is_empty()
    )
}

#[cfg(test)]
#[path = "eventarc_tests.rs"]
mod tests;
