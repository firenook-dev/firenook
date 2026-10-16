//! Function delivery: the Functions host receives a `CloudEvent` (or the
//! first-generation legacy envelope) for every message published to a
//! topic a discovered function listens on, through the delivery queue.

use std::collections::BTreeMap;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use firenook_functions_bridge::{DispatchRequest, FunctionDefinition, FunctionsInventory, cause};
use serde_json::json;
use sha2::{Digest as _, Sha256};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use crate::broker::StoredMessage;

pub const PUBSUB_EVENT_TYPE: &str = "google.cloud.pubsub.topic.v1.messagePublished";
pub const LEGACY_PUBSUB_EVENT_TYPE: &str = "google.pubsub.topic.publish";

/// A function listening on a topic.
#[derive(Debug, Clone)]
pub enum Target {
    Schedule(FunctionDefinition, u32),
    Pubsub(FunctionDefinition, u32),
    /// First-generation `pubsub.topic().onPublish` (legacy event envelope).
    Legacy(FunctionDefinition, u32),
}

/// How a function receives a topic's messages.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TargetKind {
    /// A `CloudEvent` (`onMessagePublished`).
    CloudEvent,
    /// The first-generation event envelope (`pubsub.topic().onPublish`).
    Legacy,
    /// An `onSchedule` function's tick.
    Schedule,
}

/// A function listening on a topic, as the console names it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FunctionTarget {
    /// The region-qualified Functions id, `us-central1-onOrderPlaced`.
    pub function_id: String,
    pub name: String,
    pub region: String,
    pub kind: TargetKind,
}

impl Target {
    /// The function behind the target.
    #[must_use]
    pub fn function(&self) -> &FunctionDefinition {
        match self {
            Self::Schedule(function, _) | Self::Pubsub(function, _) | Self::Legacy(function, _) => {
                function
            }
        }
    }

    #[must_use]
    pub fn kind(&self) -> TargetKind {
        match self {
            Self::Schedule(..) => TargetKind::Schedule,
            Self::Pubsub(..) => TargetKind::CloudEvent,
            Self::Legacy(..) => TargetKind::Legacy,
        }
    }

    /// The target as the console names it.
    #[must_use]
    pub fn describe(&self) -> FunctionTarget {
        let function = self.function();
        FunctionTarget {
            function_id: function.id.clone(),
            name: function.name.clone(),
            region: region_of(function),
            kind: self.kind(),
        }
    }
}

/// A function's region (the first of a first-generation Extension's regions).
fn region_of(function: &FunctionDefinition) -> String {
    if function.region.is_empty() {
        function.regions.first().cloned().unwrap_or_default()
    } else {
        function.region.clone()
    }
}

/// One discovered schedule and its synthetic Pub/Sub topic.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScheduleDefinition {
    /// The scheduled function's region-qualified id, the scheduler's key.
    pub function_id: String,
    /// The exported function name.
    pub function_name: String,
    /// The function's region.
    pub region: String,
    /// Firebase project.
    pub project: String,
    /// Synthetic `firebase-schedule-*` topic.
    pub topic: String,
    /// Firebase schedule expression.
    pub expression: String,
    /// Optional IANA time zone.
    pub time_zone: Option<String>,
}

/// Function targets by full topic name, and the schedules, from an inventory.
#[must_use]
pub fn discover(
    project: &str,
    inventory: &FunctionsInventory,
) -> (BTreeMap<String, Vec<Target>>, Vec<ScheduleDefinition>) {
    let mut targets: BTreeMap<String, Vec<Target>> = BTreeMap::new();
    let mut schedules = Vec::new();
    for function in inventory.functions() {
        if let Some(schedule) = &function.schedule {
            let topic = format!("firebase-schedule-{}", function.name);
            targets
                .entry(topic_resource(project, &topic))
                .or_default()
                .push(Target::Schedule(function.clone(), inventory.generation));
            schedules.push(ScheduleDefinition {
                function_id: function.id.clone(),
                function_name: function.name.clone(),
                region: region_of(function),
                project: project.to_owned(),
                topic,
                expression: schedule.schedule.clone(),
                time_zone: schedule.time_zone.clone(),
            });
        } else if let Some(trigger) = &function.event_trigger
            && trigger.event_type == PUBSUB_EVENT_TYPE
            && parse_topic_resource(&trigger.resource).is_some()
        {
            targets
                .entry(trigger.resource.clone())
                .or_default()
                .push(Target::Pubsub(function.clone(), inventory.generation));
        } else if let Some(trigger) = &function.event_trigger
            && trigger.event_type == LEGACY_PUBSUB_EVENT_TYPE
            && function.schedule.is_none()
            && parse_topic_resource(&trigger.resource).is_some()
        {
            targets
                .entry(trigger.resource.clone())
                .or_default()
                .push(Target::Legacy(function.clone(), inventory.generation));
        }
    }
    (targets, schedules)
}

/// The dispatch for one message and one target.
#[must_use]
pub fn build_dispatch(
    topic_name: &str,
    target: &Target,
    message: &StoredMessage,
) -> DispatchRequest {
    build_dispatch_with(topic_name, target, message, 0)
}

/// The event id of the dispatch of one message to one target: stable for
/// the publish's own delivery (`redelivery` 0), fresh for each console
/// redelivery, since the delivery runtime suppresses a repeated id.
#[must_use]
pub fn event_id(topic_name: &str, target: &Target, message_id: &str, redelivery: u64) -> String {
    let (project, topic) = parse_topic_resource(topic_name).unwrap_or_default();
    stable_event_id(
        &project,
        &topic,
        &target.function().id,
        message_id,
        redelivery,
    )
}

/// [`build_dispatch`] for a console redelivery numbered `redelivery` (0 is
/// the publish's own delivery).
#[must_use]
pub fn build_dispatch_with(
    topic_name: &str,
    target: &Target,
    message: &StoredMessage,
    redelivery: u64,
) -> DispatchRequest {
    let (project, topic) = parse_topic_resource(topic_name).unwrap_or_default();
    let (function, generation) = match target {
        Target::Schedule(function, generation)
        | Target::Pubsub(function, generation)
        | Target::Legacy(function, generation) => (function, *generation),
    };
    let message_id = &message.message.message_id;
    let event_id = stable_event_id(&project, &topic, &function.id, message_id, redelivery);
    let time = OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_default();
    let data = BASE64.encode(&message.message.data);
    if let Target::Legacy(..) = target {
        // `createLegacyEventRequestBody`: the message bytes serialize as a
        // Node Buffer.
        let body = serde_json::to_vec(&json!({
            "context": {
                "eventId": event_id,
                "resource": {
                    "service": "pubsub.googleapis.com",
                    "name": topic_name,
                },
                "eventType": LEGACY_PUBSUB_EVENT_TYPE,
                "timestamp": time,
            },
            "data": {
                "data": { "type": "Buffer", "data": message.message.data },
                "attributes": message.message.attributes,
            },
        }))
        .unwrap_or_default();
        return DispatchRequest {
            path: format!(
                "/functions/projects/{project}/triggers/{}-{generation}",
                function.id
            ),
            headers: with_cause("application/json", topic_name, message_id, &event_id),
            body,
            event_id,
        };
    }
    let payload = match target {
        Target::Schedule(..) | Target::Legacy(..) => json!({}),
        Target::Pubsub(..) => json!({
            "message": {
                "messageId": message_id,
                "publishTime": time,
                "attributes": message.message.attributes,
                "orderingKey": message.message.ordering_key,
                "data": data,
                "message_id": message_id,
                "publish_time": time,
            },
            "subscription": format!("projects/{project}/subscriptions/emulator-sub-{topic}"),
        }),
    };
    let body = serde_json::to_vec(&json!({
        "specversion": "1.0",
        "id": event_id,
        "source": format!("//pubsub.googleapis.com/{topic_name}"),
        "type": PUBSUB_EVENT_TYPE,
        "time": time,
        "data": payload,
    }))
    .unwrap_or_default();
    DispatchRequest {
        path: format!(
            "/functions/projects/{project}/triggers/{}-{generation}",
            function.id
        ),
        headers: with_cause(
            "application/cloudevents+json; charset=UTF-8",
            topic_name,
            message_id,
            &event_id,
        ),
        body,
        event_id,
    }
}

/// A dispatch's headers: its content type and what caused it (the topic's
/// full name, the message id and the event id the body carries), which the
/// Functions runtime records instead of parsing the body.
fn with_cause(
    content_type: &str,
    topic_name: &str,
    message_id: &str,
    event_id: &str,
) -> BTreeMap<String, String> {
    BTreeMap::from([
        ("content-type".to_owned(), content_type.to_owned()),
        (cause::TOPIC.to_owned(), cause::encode(topic_name)),
        (cause::MESSAGE.to_owned(), cause::encode(message_id)),
        (cause::EVENT_ID.to_owned(), cause::encode(event_id)),
    ])
}

fn stable_event_id(
    project: &str,
    topic: &str,
    function: &str,
    message_id: &str,
    redelivery: u64,
) -> String {
    let mut digest = Sha256::new();
    for value in [project, topic, function, message_id] {
        digest.update(value.as_bytes());
        digest.update([0]);
    }
    if redelivery > 0 {
        digest.update(b"redelivery");
        digest.update(redelivery.to_le_bytes());
    }
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

#[must_use]
pub fn topic_resource(project: &str, topic: &str) -> String {
    format!("projects/{project}/topics/{topic}")
}

/// `(project, topic)` from `projects/{project}/topics/{topic}`.
#[must_use]
pub fn parse_topic_resource(resource: &str) -> Option<(String, String)> {
    let segments = resource.split('/').collect::<Vec<_>>();
    (segments.len() == 4 && segments[0] == "projects" && segments[2] == "topics")
        .then(|| (segments[1].to_owned(), segments[3].to_owned()))
}
