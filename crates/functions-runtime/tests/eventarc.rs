//! Eventarc recording end to end: every event on every channel is kept with
//! what each subscription did with it, over a real Node worker.

mod support;

use axum::body::Body;
use axum::http::Request;
use firenook_functions_runtime::LogDelivery;
use firenook_functions_runtime::monitor::{
    EventarcEventQuery, EventarcFilterMismatch, EventarcOrigin, InvocationCause, InvocationOutcome,
};
use serde_json::{Value, json};
use support::{Harness, PROJECT, eventually};
use tower::ServiceExt as _;

const INDEX: &str = r#"
exports.onGreeted = (event) => { console.log("greeted", event.data && event.data.name); };
exports.onVip = (event) => { console.log("vip", event.data && event.data.name); };
"#;

const MANIFEST: &str = "specVersion: v1alpha1
endpoints:
  onGreeted:
    entryPoint: onGreeted
    platform: gcfv2
    eventTrigger:
      eventType: test.greeter.v1.greeted
      channel: firebase
      eventFilters: {}
  onVip:
    entryPoint: onVip
    platform: gcfv2
    eventTrigger:
      eventType: test.greeter.v1.greeted
      channel: firebase
      eventFilters:
        tier: vip
";

const CHANNEL: &str = "projects/demo-dispatch/locations/us-central1/channels/firebase";

async fn harness() -> Option<Harness> {
    match Harness::start(INDEX, MANIFEST, LogDelivery::Attributed).await {
        Ok(harness) => Some(harness),
        Err(reason) => {
            eprintln!("skipped: {reason}");
            None
        }
    }
}

async fn publish(harness: &Harness, path: &str, events: &Value) -> u16 {
    let response = harness
        .runtime
        .eventarc_router()
        .oneshot(
            Request::post(path)
                .header("content-type", "application/json")
                .body(Body::from(json!({ "events": events }).to_string()))
                .expect("a request"),
        )
        .await
        .expect("the router answers");
    response.status().as_u16()
}

fn proto_event(id: &str, tier: &str) -> Value {
    json!({
        "id": id,
        "source": format!("projects/{PROJECT}/instances/greeter"),
        "specVersion": "1.0",
        "type": "test.greeter.v1.greeted",
        "attributes": {
            "datacontenttype": {"ceString": "application/json"},
            "time": {"ceTimestamp": "2026-10-12T00:00:00Z"},
            "subject": {"ceString": "ada"},
            "tier": {"ceString": tier}
        },
        "textData": "{\"name\":\"ada\"}"
    })
}

fn all() -> EventarcEventQuery<'static> {
    EventarcEventQuery {
        channel: None,
        filter: None,
        limit: 50,
    }
}

#[tokio::test]
async fn channel_events_record_who_got_them_and_who_filtered_them_out() {
    let Some(harness) = harness().await else {
        return;
    };
    let path = format!("/{CHANNEL}:publishEvents");
    assert_eq!(
        publish(&harness, &path, &json!([proto_event("g-1", "gold")])).await,
        200
    );
    let page = harness.monitor.events(&all(), None);
    assert_eq!(page.total, 1);
    let id = page.items[0].id.clone();
    eventually("the delivery", || {
        harness
            .monitor
            .event(&id)
            .is_some_and(|event| event.summary.delivered == 1)
    })
    .await;
    let event = harness.monitor.event(&id).expect("kept");
    assert_eq!(event.summary.channel, CHANNEL);
    assert_eq!(event.summary.event_id.as_deref(), Some("g-1"));
    assert_eq!(event.summary.publisher.as_deref(), Some("greeter"));
    assert_eq!(event.summary.origin, EventarcOrigin::App);
    assert_eq!((event.summary.matched, event.summary.filtered), (1, 1));
    assert_eq!(event.data, json!({"name": "ada"}));
    assert_eq!(
        event.attributes.get("tier").map(String::as_str),
        Some("gold")
    );
    let delivered = event
        .deliveries
        .iter()
        .find(|delivery| delivery.matched)
        .expect("one delivery");
    assert_eq!(
        delivered.function_id.as_deref(),
        Some("us-central1-onGreeted")
    );
    assert_eq!(delivered.outcome, Some(InvocationOutcome::Succeeded));
    let invocation_id = delivered.invocation_id.clone().expect("linked");
    let filtered = event
        .deliveries
        .iter()
        .find(|delivery| !delivery.matched)
        .expect("one filtered");
    assert_eq!(filtered.function_id.as_deref(), Some("us-central1-onVip"));
    assert_eq!(
        filtered.mismatches,
        [EventarcFilterMismatch {
            attribute: "tier".to_owned(),
            expected: "vip".to_owned(),
            actual: Some("gold".to_owned()),
        }]
    );
    // The invocation names the event it delivered, finished at its head
    // although nobody read the acknowledgement.
    let invocation = harness.monitor.invocation(&invocation_id).expect("kept");
    assert_eq!(
        invocation.summary.outcome,
        Some(InvocationOutcome::Succeeded)
    );
    assert!(invocation.summary.duration_ms.is_some());
    assert!(!invocation.response.expect("a response").client_gone);
    assert!(matches!(&invocation.summary.cause,
        InvocationCause::Eventarc { event: Some(event), channel, .. }
            if *event == id && channel == CHANNEL));
    assert_eq!(
        invocation.summary.summary,
        "test.greeter.v1.greeted from greeter"
    );
    harness.stop().await;
}

#[tokio::test]
async fn unreadable_unheard_and_untyped_events_leave_a_trace() {
    let Some(harness) = harness().await else {
        return;
    };
    let path = format!("/{CHANNEL}:publishEvents");
    let mut broken = proto_event("g-2", "gold");
    broken.as_object_mut().expect("an object").remove("id");
    assert_eq!(publish(&harness, &path, &json!([broken])).await, 200);
    let mut unheard = proto_event("g-3", "gold");
    unheard["type"] = json!("test.nobody.listens");
    assert_eq!(publish(&harness, &path, &json!([unheard])).await, 200);
    // A batch whose second event has no type answers 400 after the first.
    let untyped = json!([proto_event("g-4", "vip"), {"id": "g-5"}]);
    assert_eq!(publish(&harness, &path, &untyped).await, 400);
    let page = harness.monitor.events(&all(), None);
    assert_eq!(page.total, 4);
    let by_event = |event_id: &str| {
        page.items
            .iter()
            .find(|item| item.event_id.as_deref() == Some(event_id))
            .cloned()
            .expect("recorded")
    };
    let broken = page
        .items
        .iter()
        .find(|item| item.error.as_deref() == Some("CloudEvent 'id' is required."))
        .expect("the conversion failure");
    assert_eq!((broken.matched, broken.filtered), (0, 0));
    assert!(!broken.unheard);
    assert!(by_event("g-3").unheard);
    assert_eq!(by_event("g-4").matched, 2);
    assert_eq!(
        by_event("g-5").error.as_deref(),
        Some("CloudEvent 'type' is required.")
    );
    harness.stop().await;
}

#[tokio::test]
async fn the_native_channel_is_recorded_as_google() {
    let Some(harness) = harness().await else {
        return;
    };
    let key = format!("us-central1-onGreeted-0-{CHANNEL}");
    let registered = harness
        .runtime
        .eventarc_router()
        .oneshot(
            Request::post(format!("/emulator/v1/projects/{PROJECT}/triggers/{key}"))
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"eventTrigger": {"eventType": "google.test.native"}}).to_string(),
                ))
                .expect("a request"),
        )
        .await
        .expect("the router answers");
    assert_eq!(registered.status(), 200);
    let native = json!([{"type": "google.test.native", "id": "n-1", "source": "//test",
        "specversion": "1.0", "data": {"name": "grace"}}]);
    assert_eq!(
        publish(&harness, "/google/publishEvents", &native).await,
        200
    );
    let google = EventarcEventQuery {
        channel: Some("google"),
        filter: None,
        limit: 10,
    };
    let page = harness.monitor.events(&google, None);
    assert_eq!(page.total, 1);
    let id = page.items[0].id.clone();
    eventually("the delivery", || {
        harness
            .monitor
            .event(&id)
            .is_some_and(|event| event.summary.delivered == 1)
    })
    .await;
    let event = harness.monitor.event(&id).expect("kept");
    assert_eq!(event.deliveries[0].trigger_key, key);
    assert_eq!(event.data, json!({"name": "grace"}));
    harness.stop().await;
}
