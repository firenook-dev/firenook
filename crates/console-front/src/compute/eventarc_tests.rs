#![allow(clippy::too_many_lines)] // Scenarios read best whole.

use std::collections::BTreeMap;

use axum::http::{Method, StatusCode};
use serde_json::{Value, json};

use super::super::tests::{CHANNEL, Setup, Suite, eventually};
use super::*;

fn request(channel: &str) -> EventarcPublishRequest {
    EventarcPublishRequest {
        channel: channel.to_owned(),
        event_type: "test.greeter.v1.greeted".to_owned(),
        source: "projects/demo-compute/instances/greeter".to_owned(),
        subject: Some("ada".to_owned()),
        id: Some("e-1".to_owned()),
        time: Some("2026-10-12T00:00:00Z".to_owned()),
        encoding: EventarcDataEncoding::Json,
        data: "{\"name\":\"ada\"}".to_owned(),
        attributes: BTreeMap::from([("tier".to_owned(), "vip".to_owned())]),
    }
}

#[test]
fn a_published_event_has_the_admin_sdks_shape_on_a_channel_and_a_cloudevents_natively() {
    let event = build_event(&request(CHANNEL)).expect("an event");
    assert_eq!(
        event,
        json!({
            "id": "e-1",
            "source": "projects/demo-compute/instances/greeter",
            "specVersion": "1.0",
            "type": "test.greeter.v1.greeted",
            "attributes": {
                "datacontenttype": {"ceString": "application/json"},
                "time": {"ceTimestamp": "2026-10-12T00:00:00Z"},
                "subject": {"ceString": "ada"},
                "tier": {"ceString": "vip"},
            },
            "textData": "{\"name\":\"ada\"}",
        })
    );
    let native = build_event(&request("google")).expect("an event");
    assert_eq!(native["specversion"], "1.0");
    assert_eq!(native["data"], json!({"name": "ada"}));
    assert_eq!(native["tier"], "vip");
    assert_eq!(native["subject"], "ada");
    let text = build_event(&EventarcPublishRequest {
        encoding: EventarcDataEncoding::Text,
        data: "plain words".to_owned(),
        id: None,
        time: None,
        ..request(CHANNEL)
    })
    .expect("an event");
    assert_eq!(text["textData"], "plain words");
    assert_eq!(
        text["attributes"]["datacontenttype"]["ceString"],
        "text/plain"
    );
    assert_eq!(
        text["id"].as_str().map(str::len),
        Some(36),
        "a generated id"
    );
    let refused = |change: fn(&mut EventarcPublishRequest)| {
        let mut bad = request(CHANNEL);
        change(&mut bad);
        build_event(&bad)
            .expect_err("refused")
            .detail()
            .message
            .clone()
    };
    assert_eq!(
        refused(|bad| bad.event_type = String::new()),
        "The event needs a type."
    );
    assert_eq!(
        refused(|bad| bad.source = " ".to_owned()),
        "The event needs a source."
    );
    assert!(refused(|bad| bad.channel = "firebase".to_owned()).contains("projects/<project>"));
    assert!(
        refused(|bad| {
            bad.attributes.insert("Tier".to_owned(), "x".to_owned());
        })
        .contains("lowercase letters or digits")
    );
    assert!(
        refused(|bad| {
            bad.attributes.insert("subject".to_owned(), "x".to_owned());
        })
        .contains("its own field")
    );
    assert!(refused(|bad| bad.data = "{".to_owned()).contains("not JSON"));
}

#[tokio::test]
async fn channels_say_who_publishes_and_who_listens() {
    let suite = Suite::running(Setup {
        greeter: true,
        ..Setup::default()
    })
    .await;
    let (status, snapshot) = suite.get("/eventarc/channels").await;
    assert_eq!(status, StatusCode::OK, "{snapshot}");
    assert_eq!(snapshot["alertsDelivered"], false);
    assert!(snapshot["liveCursor"].is_string());
    assert_eq!(snapshot["native"]["name"], "google");
    assert_eq!(snapshot["native"]["id"], "google");
    let channel = snapshot["channels"]
        .as_array()
        .and_then(|channels| channels.iter().find(|channel| channel["name"] == CHANNEL))
        .expect("the firebase channel");
    assert_eq!(channel["location"], "us-central1");
    assert_eq!(channel["id"], "firebase");
    let subscription = &channel["subscriptions"][0];
    assert_eq!(subscription["functionId"], "us-central1-onGreeted");
    assert_eq!(subscription["function"]["kind"], "functions.function");
    assert_eq!(subscription["eventType"], "test.greeter.v1.greeted");
    assert_eq!(subscription["filters"]["tier"], "vip");
    assert_eq!(subscription["origin"], "definition");
    assert_eq!(subscription["status"], "receiving");
    let publisher = &channel["publishers"][0];
    assert_eq!(publisher["instanceId"], "greeter");
    assert_eq!(
        publisher["instance"],
        json!({"kind": "extensions.instance", "key": "greeter"})
    );
    assert_eq!(publisher["allowed"], json!(["test.greeter.v1.greeted"]));
    assert_eq!(publisher["declared"][0]["type"], "test.greeter.v1.greeted");
    assert_eq!(channel["events"], 0);
    suite.stop().await;
}

#[tokio::test]
async fn publishing_records_the_event_with_what_each_subscription_did() {
    let suite = Suite::running(Setup::default()).await;
    let body = |tier: &str| {
        json!({
            "channel": CHANNEL,
            "type": "test.greeter.v1.greeted",
            "source": "projects/demo-compute/instances/greeter",
            "encoding": "json",
            "data": "{\"name\":\"ada\"}",
            "attributes": {"tier": tier},
        })
    };
    let (status, delivered) = suite.post("/eventarc/channel/publish", body("vip")).await;
    assert_eq!(status, StatusCode::OK, "{delivered}");
    let event = &delivered["event"];
    assert_eq!(event["channel"], CHANNEL);
    assert_eq!(event["eventType"], "test.greeter.v1.greeted");
    assert_eq!(event["publisher"], "greeter");
    assert_eq!(event["origin"], "console");
    assert_eq!(event["matched"], 1);
    let id = event["id"].as_str().expect("an id").to_owned();
    let (status, filtered) = suite.post("/eventarc/channel/publish", body("basic")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(filtered["event"]["filtered"], 1);
    assert_eq!(filtered["event"]["matched"], 0);
    // Deliveries run beside the publish; wait for the invocation to begin.
    eventually("the delivery's invocation", async || {
        suite.get(&format!("/eventarc/events/{id}")).await.1["detail"]["deliveries"][0]
            ["invocationId"]
            .is_string()
    })
    .await;
    let (status, view) = suite.get(&format!("/eventarc/events/{id}")).await;
    assert_eq!(status, StatusCode::OK, "{view}");
    assert_eq!(view["detail"]["data"], json!({"name": "ada"}));
    let delivery = &view["detail"]["deliveries"][0];
    assert_eq!(delivery["functionId"], "us-central1-onGreeted");
    assert_eq!(delivery["matched"], true);
    let invocation = delivery["invocationId"].as_str().expect("an invocation");
    assert_eq!(
        view["deliveries"][0],
        json!({
            "function": {"kind": "functions.function", "key": "us-central1-onGreeted"},
            "invocation": {"kind": "functions.invocation", "key": invocation},
        })
    );
    let (_, filtered_view) = suite
        .get(&format!(
            "/eventarc/events/{}",
            filtered["event"]["id"].as_str().expect("an id")
        ))
        .await;
    assert_eq!(
        filtered_view["detail"]["deliveries"][0]["mismatches"][0],
        json!({"attribute": "tier", "expected": "vip", "actual": "basic"})
    );
    assert_eq!(filtered_view["deliveries"][0]["invocation"], Value::Null);

    let (status, page) = suite.get("/eventarc/events?q=type:test.greeter.*").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(page["page"]["total"]["count"], 2);
    assert!(page["liveCursor"].is_string());
    let (_, delivered_only) = suite.get("/eventarc/events?q=delivery:filtered").await;
    assert_eq!(delivered_only["page"]["total"]["count"], 1);
    let (_, by_channel) = suite.get("/eventarc/events?channel=google").await;
    assert_eq!(by_channel["page"]["total"]["count"], 0);
    let (status, _) = suite.get("/eventarc/events?q=kind:x").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let (_, snapshot) = suite.get("/eventarc/channels").await;
    let channel = snapshot["channels"]
        .as_array()
        .and_then(|channels| channels.iter().find(|channel| channel["name"] == CHANNEL))
        .expect("the channel");
    assert_eq!(channel["events"], 2);
    assert!(channel["lastEventAt"].is_string());

    let original_event_id = view["detail"]["summary"]["eventId"].clone();
    let (status, fresh) = suite
        .post(&format!("/eventarc/events/{id}/replay"), json!({}))
        .await;
    assert_eq!(status, StatusCode::OK, "{fresh}");
    assert_ne!(fresh["event"]["eventId"], original_event_id);
    assert_eq!(fresh["event"]["origin"], "replay");
    let (_, kept) = suite
        .post(
            &format!("/eventarc/events/{id}/replay"),
            json!({"keepId": true}),
        )
        .await;
    assert_eq!(kept["event"]["eventId"], original_event_id);
    let (_, replayed) = suite
        .get(&format!(
            "/eventarc/events/{}",
            kept["event"]["id"].as_str().expect("an id")
        ))
        .await;
    assert_eq!(replayed["detail"]["replayOf"], id);

    let (status, missing) = suite.get("/eventarc/events/zzzzzz-1").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(
        missing["error"]["message"],
        "The engine no longer keeps this event; it keeps the newest 1,000."
    );
    let (status, _) = suite
        .post("/eventarc/events/zzzzzz-1/replay", json!({}))
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    // No route empties the record: it keeps the newest 1,000 events.
    let (status, _) = suite
        .send(Method::DELETE, "/eventarc/events", Some(json!({})))
        .await;
    assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
    // Firebase Alerts are not delivered by this engine yet: no route.
    let (status, _) = suite
        .post(
            "/eventarc/alert/send",
            json!({"alertType": "crashlytics.newFatalIssue", "payload": {}}),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    suite.stop().await;
}

const EVENT_CASES: &str = include_str!("../../../../console/src/eventarc/event-filter-cases.json");

/// The console's event filter declares the engine's fields, and both sides
/// give every golden case the same answer, error spans included.
#[test]
fn the_event_filter_is_one_language_in_the_console_and_the_engine() {
    let cases: Value = serde_json::from_str(EVENT_CASES).expect("cases");
    let declared = cases["fields"].as_array().expect("fields");
    let infos = super::super::filters::EVENT_FIELDS.infos();
    assert_eq!(
        declared
            .iter()
            .filter_map(|field| field["key"].as_str())
            .collect::<Vec<_>>(),
        infos
            .iter()
            .map(|info| info.key.as_str())
            .collect::<Vec<_>>()
    );
    for (field, info) in declared.iter().zip(&infos) {
        assert_eq!(field["kind"], info.kind.as_str(), "{}", info.key);
        assert_eq!(field["help"], info.help.as_str(), "{}", info.key);
        let values: Vec<&str> = field["values"]
            .as_array()
            .map(|values| values.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        assert_eq!(values, info.values, "{}", info.key);
    }
    assert!(crate::filter::golden::run(EVENT_CASES) >= 30);
}
