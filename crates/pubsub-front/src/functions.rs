//! Function delivery: the Functions host receives a `CloudEvent` (or the
//! first-generation legacy envelope) for every message published to a
//! topic a discovered function listens on, through the delivery queue.

use std::collections::BTreeMap;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use firenook_functions_bridge::{DispatchRequest, FunctionDefinition, FunctionsInventory};
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

/// One discovered schedule and its synthetic Pub/Sub topic.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScheduleDefinition {
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
    let (project, topic) = parse_topic_resource(topic_name).unwrap_or_default();
    let (function, generation) = match target {
        Target::Schedule(function, generation)
        | Target::Pubsub(function, generation)
        | Target::Legacy(function, generation) => (function, *generation),
    };
    let message_id = &message.message.message_id;
    let event_id = stable_event_id(&project, &topic, &function.id, message_id);
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
            headers: BTreeMap::from([("content-type".to_owned(), "application/json".to_owned())]),
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
        headers: BTreeMap::from([(
            "content-type".to_owned(),
            "application/cloudevents+json; charset=UTF-8".to_owned(),
        )]),
        body,
        event_id,
    }
}

fn stable_event_id(project: &str, topic: &str, function: &str, message_id: &str) -> String {
    let mut digest = Sha256::new();
    for value in [project, topic, function, message_id] {
        digest.update(value.as_bytes());
        digest.update([0]);
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
