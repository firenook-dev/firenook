//! The Storage events an object produces: the v1 (legacy) and v2
//! (`CloudEvent`) bodies the dispatcher queues for the Functions emulator,
//! built in one place so a console can show exactly what a trigger receives
//! and send it again.

use std::collections::BTreeMap;

use firenook_functions_bridge::{DispatchRequest, cause};
use serde_json::{Value as JsonValue, json};
use sha2::{Digest as _, Sha256};

use crate::{
    StorageEvent, StorageState, StoredObject, decimal_id, event_metadata, now_rfc3339, stable_id,
    uuid_shaped,
};

/// The legacy and `CloudEvent` type of each Storage event.
pub(crate) const fn types(event: StorageEvent) -> (&'static str, &'static str) {
    match event {
        StorageEvent::Finalize => (
            "google.storage.object.finalize",
            "google.cloud.storage.object.v1.finalized",
        ),
        StorageEvent::Metadata => (
            "google.storage.object.metadataUpdate",
            "google.cloud.storage.object.v1.metadataUpdated",
        ),
        StorageEvent::Delete => (
            "google.storage.object.delete",
            "google.cloud.storage.object.v1.deleted",
        ),
    }
}

/// One Storage event's two bodies and their ids.
pub(crate) struct EventBodies {
    /// The legacy body (`eventId`, `eventType`, `resource`, `data`).
    pub(crate) v1: JsonValue,
    /// The `CloudEvent` body (`specversion`, `id`, `type`, `source`, `data`).
    pub(crate) v2: JsonValue,
    legacy: &'static str,
    legacy_id: String,
    cloud_id: String,
    nonce: Option<String>,
}

/// The bodies of `event` for `object` as it is now. Their ids are stable
/// per generation and metageneration, as the dispatcher has always made
/// them; a `nonce` is mixed into every id, so the same event can be sent
/// again and is not dropped as a repeat.
pub(crate) fn bodies(
    state: &StorageState,
    event: StorageEvent,
    object: &StoredObject,
    nonce: Option<&str>,
) -> EventBodies {
    let (legacy, cloud) = types(event);
    let generation = object.generation.to_string();
    let metageneration = object.metageneration.to_string();
    let id = |kind: &str| {
        let mut parts = vec![
            state.config.project.as_str(),
            &object.bucket,
            &object.name,
            kind,
            &generation,
            &metageneration,
        ];
        if let Some(nonce) = nonce {
            parts.push(nonce);
        }
        stable_id(&parts)
    };
    let legacy_id = decimal_id(&id(legacy));
    let cloud_id = uuid_shaped(&Sha256::digest(id(cloud).as_bytes()));
    let data = event_metadata(state, object);
    let timestamp = now_rfc3339();
    let v1 = json!({
        "eventId": legacy_id,
        "timestamp": timestamp,
        "eventType": legacy,
        "resource": {
            "service": "storage.googleapis.com",
            "name": format!("projects/_/buckets/{}/objects/{}", object.bucket, object.name),
            "type": "storage#object"
        },
        "data": data
    });
    let v2 = json!({
        "specversion": "1.0",
        "id": cloud_id,
        "type": cloud,
        "source": format!(
            "//storage.googleapis.com/projects/_/buckets/{}/objects/{}",
            object.bucket, object.name
        ),
        "time": timestamp,
        "data": data
    });
    EventBodies {
        v1,
        v2,
        legacy,
        legacy_id,
        cloud_id,
        nonce: nonce.map(str::to_owned),
    }
}

impl EventBodies {
    /// The two delivery requests (v1, then v2) the trigger multicast takes.
    pub(crate) fn requests(
        &self,
        state: &StorageState,
        object: &StoredObject,
    ) -> [DispatchRequest; 2] {
        let request = |generation: &str, body: &JsonValue, content_type: &str, body_id: &str| {
            let generation_text = object.generation.to_string();
            let metageneration = object.metageneration.to_string();
            let mut parts = vec![
                state.config.project.as_str(),
                &object.bucket,
                &object.name,
                self.legacy,
                generation,
                &generation_text,
                &metageneration,
            ];
            if let Some(nonce) = &self.nonce {
                parts.push(nonce);
            }
            DispatchRequest {
                path: format!(
                    "/functions/projects/{}/trigger_multicast",
                    state.config.project
                ),
                // What caused it, for the Functions runtime's record of each
                // invocation the multicast starts.
                headers: BTreeMap::from([
                    ("content-type".to_owned(), content_type.to_owned()),
                    (cause::BUCKET.to_owned(), cause::encode(&object.bucket)),
                    (cause::OBJECT.to_owned(), cause::encode(&object.name)),
                    (cause::EVENT_ID.to_owned(), cause::encode(body_id)),
                ]),
                body: serde_json::to_vec(body).expect("JSON serialization cannot fail"),
                event_id: stable_id(&parts),
            }
        };
        [
            request("v1", &self.v1, "application/json", &self.legacy_id),
            request(
                "v2",
                &self.v2,
                "application/cloudevents+json; charset=UTF-8",
                &self.cloud_id,
            ),
        ]
    }
}
