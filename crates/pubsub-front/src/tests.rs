//! Crate-level checks; the behavioural gate is the corpus replay
//! (`conformance/src/pubsub/replay-firenook.ts`). These keep the function
//! delivery and schedule contracts the suite relies on.

use axum::body::Body;
use axum::http::{Request, Response, StatusCode};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use firenook_functions_bridge::{
    DispatchRequest, FunctionBackend, TriggerObserver, TriggerRegistry,
};
use serde::Deserialize;
use serde_json::{Value as JsonValue, json};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use tower::ServiceExt as _;

use super::*;
use crate::functions::PUBSUB_EVENT_TYPE;
use crate::scheduler::{Cadence, CronSpec};

const FUNCTIONS_ORACLE: &str = include_str!(
    "../../../conformance/fixtures/firebase-suite-v1/functions-callable-http-and-error-contract/fixture.json"
);
const PUBSUB_ORACLE: &str = include_str!(
    "../../../conformance/fixtures/firebase-suite-v1/pubsub-schedule-and-function-dispatch/fixture.json"
);
const PROJECT: &str = "demo-fireside-phase4-suite-oracle";

fn inventory() -> firenook_functions_bridge::FunctionsInventory {
    #[derive(Deserialize)]
    struct Response {
        backends: Vec<FunctionBackend>,
    }
    let oracle: JsonValue = serde_json::from_str(FUNCTIONS_ORACLE).expect("functions oracle");
    let response =
        serde_json::from_value::<Response>(oracle["observations"][0]["response"].clone())
            .expect("backends response");
    firenook_functions_bridge::FunctionsInventory {
        generation: 0,
        backends: response.backends,
    }
}

async fn json_response(response: Response<Body>) -> JsonValue {
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("response body");
    serde_json::from_slice(&bytes).expect("response JSON")
}

fn runtime_and_deliveries() -> (
    PubsubRuntime,
    tokio::sync::mpsc::UnboundedReceiver<DispatchRequest>,
    TriggerRegistry,
) {
    let background = TriggerRegistry::default();
    let (observer, deliveries) = TriggerObserver::channel(background.clone());
    let runtime = router(PROJECT, &inventory(), observer.queue(), background.clone());
    (runtime, deliveries, background)
}

fn publish_request(topic: &str, body: &JsonValue) -> Request<Body> {
    Request::post(format!("/v1/projects/{PROJECT}/topics/{topic}:publish"))
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .expect("publish request")
}

#[tokio::test]
async fn topic_inventory_and_publish_replay_the_frozen_contract() {
    let (runtime, mut deliveries, background) = runtime_and_deliveries();
    let application = runtime.application();
    let oracle: JsonValue = serde_json::from_str(PUBSUB_ORACLE).expect("Pub/Sub oracle");

    let response = application
        .clone()
        .oneshot(
            Request::get(format!("/v1/projects/{PROJECT}/topics"))
                .body(Body::empty())
                .expect("list request"),
        )
        .await
        .expect("list response");
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        json_response(response).await,
        oracle["observations"][0]["response"]
    );

    let response = application
        .clone()
        .oneshot(publish_request(
            "phase4-topic",
            &json!({ "messages": [{ "data": BASE64.encode("topic 火🔥"), "attributes": {"oracle": "phase4"} }] }),
        ))
        .await
        .expect("publish response");
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(json_response(response).await, json!({"messageIds": ["1"]}));
    let dispatch = deliveries.recv().await.expect("topic dispatch");
    let event: JsonValue = serde_json::from_slice(&dispatch.body).expect("CloudEvent");
    assert_eq!(
        dispatch.path,
        format!("/functions/projects/{PROJECT}/triggers/us-central1-topicEcho-0")
    );
    assert_eq!(event["type"], PUBSUB_EVENT_TYPE);
    assert_eq!(
        event["data"]["message"]["data"],
        BASE64.encode("topic 火🔥")
    );
    assert_eq!(
        event["data"]["message"]["attributes"],
        json!({"oracle": "phase4"})
    );
    assert_eq!(
        event["data"]["subscription"],
        format!("projects/{PROJECT}/subscriptions/emulator-sub-phase4-topic")
    );

    let response = application
        .clone()
        .oneshot(publish_request(
            "firebase-schedule-scheduledTick",
            &json!({ "messages": [{ "data": BASE64.encode("{}") }] }),
        ))
        .await
        .expect("schedule publish response");
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(json_response(response).await, json!({"messageIds": ["2"]}));
    let dispatch = deliveries.recv().await.expect("schedule dispatch");
    let event: JsonValue = serde_json::from_slice(&dispatch.body).expect("CloudEvent");
    assert_eq!(
        dispatch.path,
        format!("/functions/projects/{PROJECT}/triggers/us-central1-scheduledTick-0")
    );
    assert_eq!(event["data"], json!({}));

    background.set_background_enabled(false);
    let response = application
        .oneshot(publish_request(
            "phase4-topic",
            &json!({ "messages": [{ "data": BASE64.encode("disabled") }] }),
        ))
        .await
        .expect("disabled response");
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(json_response(response).await, json!({"messageIds": ["3"]}));
    assert!(deliveries.try_recv().is_err());
}

#[tokio::test]
async fn function_topics_keep_the_official_emulator_subscription() {
    let (runtime, _deliveries, _background) = runtime_and_deliveries();
    let response = runtime
        .application()
        .oneshot(
            Request::get(format!("/v1/projects/{PROJECT}/subscriptions"))
                .body(Body::empty())
                .expect("list request"),
        )
        .await
        .expect("list response");
    let listed = json_response(response).await;
    let names: Vec<&str> = listed["subscriptions"]
        .as_array()
        .expect("subscriptions")
        .iter()
        .filter_map(|subscription| subscription["name"].as_str())
        .collect();
    assert_eq!(
        names,
        vec![
            format!(
                "projects/{PROJECT}/subscriptions/emulator-sub-firebase-schedule-scheduledTick"
            ),
            format!("projects/{PROJECT}/subscriptions/emulator-sub-phase4-topic"),
        ]
    );
    // The functions consumer drains it, so a user pull sees nothing.
    let _ = runtime
        .application()
        .oneshot(publish_request(
            "phase4-topic",
            &json!({ "messages": [{ "data": "e30=" }] }),
        ))
        .await
        .expect("publish");
    let response = runtime
        .application()
        .oneshot(
            Request::post(format!(
                "/v1/projects/{PROJECT}/subscriptions/emulator-sub-phase4-topic:pull"
            ))
            .header("content-type", "application/json")
            .body(Body::from(r#"{"maxMessages":10,"returnImmediately":true}"#))
            .expect("pull request"),
        )
        .await
        .expect("pull response");
    assert_eq!(json_response(response).await, json!({}));
}

#[tokio::test]
async fn refreshed_function_targets_preserve_topics_ids_and_queued_work() {
    let background = TriggerRegistry::default();
    let (observer, mut deliveries) = TriggerObserver::channel(background.clone());
    let mut current = inventory();
    let mut runtime = router(PROJECT, &current, observer.queue(), background);
    let mut scheduler = runtime.start_scheduler().unwrap();
    let request =
        |topic: &str| publish_request(topic, &json!({ "messages": [{ "data": "e30=" }] }));
    let response = runtime
        .application()
        .oneshot(request("phase4-topic"))
        .await
        .unwrap();
    assert_eq!(json_response(response).await["messageIds"], json!(["1"]));

    let original = current
        .functions()
        .find(|function| function.name == "topicEcho")
        .unwrap()
        .clone();
    let mut added = original;
    added.id = "us-central1-added".to_owned();
    added.name = "added".to_owned();
    added.event_trigger.as_mut().unwrap().resource =
        format!("projects/{PROJECT}/topics/added-topic");
    current.backends[0].function_triggers.push(added);
    runtime
        .refresh_inventory(PROJECT, &current, &mut scheduler)
        .await
        .unwrap();
    // Repeated inventory notifications must not duplicate dispatch targets.
    runtime
        .refresh_inventory(PROJECT, &current, &mut scheduler)
        .await
        .unwrap();
    let response = runtime
        .application()
        .oneshot(request("added-topic"))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(json_response(response).await["messageIds"], json!(["2"]));
    assert!(
        deliveries
            .recv()
            .await
            .unwrap()
            .path
            .ends_with("/us-central1-topicEcho-0")
    );
    assert!(
        deliveries
            .recv()
            .await
            .unwrap()
            .path
            .ends_with("/us-central1-added-0")
    );
    assert!(deliveries.try_recv().is_err());

    let empty = firenook_functions_bridge::FunctionsInventory {
        generation: 0,
        backends: Vec::new(),
    };
    runtime
        .refresh_inventory(PROJECT, &empty, &mut scheduler)
        .await
        .unwrap();
    assert!(runtime.schedules().is_empty());
    let response = runtime
        .application()
        .oneshot(request("added-topic"))
        .await
        .unwrap();
    assert_eq!(json_response(response).await["messageIds"], json!(["3"]));
    assert!(deliveries.try_recv().is_err());
    scheduler.shutdown().await;
}

#[tokio::test]
async fn unsupported_reloaded_schedule_keeps_its_topic_without_automatic_ticks() {
    let background = TriggerRegistry::default();
    let (observer, _) = TriggerObserver::channel(background.clone());
    let mut runtime = router(PROJECT, &inventory(), observer.queue(), background);
    let mut scheduler = runtime.start_scheduler().unwrap();
    let mut invalid = inventory();
    for function in &mut invalid.backends[0].function_triggers {
        if let Some(schedule) = &mut function.schedule {
            schedule.schedule = "not a schedule".to_owned();
        }
    }
    // An expression Firenook cannot evaluate does not reject the reload (the
    // official emulator never runs schedules on a clock); the topic and its
    // manual trigger route survive, only the ticks are skipped.
    runtime
        .refresh_inventory(PROJECT, &invalid, &mut scheduler)
        .await
        .unwrap();
    assert_eq!(runtime.schedules().len(), 1);
    assert_eq!(runtime.schedules()[0].expression, "not a schedule");
    scheduler.shutdown().await;
}

#[test]
fn supported_schedule_expressions_have_deterministic_cadence() {
    let definition = |expression: &str, time_zone: Option<&str>| ScheduleDefinition {
        project: "demo".to_owned(),
        topic: "firebase-schedule-test".to_owned(),
        expression: expression.to_owned(),
        time_zone: time_zone.map(str::to_owned),
    };
    assert!(matches!(
        Cadence::parse(&definition("every 5 minutes", None)).expect("interval"),
        Cadence::Interval(duration) if duration == std::time::Duration::from_secs(300)
    ));
    assert!(matches!(
        Cadence::parse(&definition("every day 00:00", Some("UTC"))).expect("midnight"),
        Cadence::DailyUtc(time) if time == time::Time::MIDNIGHT
    ));
    assert!(matches!(
        Cadence::parse(&definition("every day 03:00", Some("UTC"))).expect("03:00"),
        Cadence::DailyUtc(time) if time.hour() == 3 && time.minute() == 0
    ));
    assert!(Cadence::parse(&definition("every day 03:00", Some("Asia/Kuala_Lumpur"))).is_err());
}

#[test]
fn cron_expressions_evaluate_in_utc() {
    let spec = CronSpec::parse("0 3 * * *").unwrap();
    let now = OffsetDateTime::parse("2026-01-01T02:59:30Z", &Rfc3339).unwrap();
    let next = spec.next_after(now).unwrap();
    assert_eq!(next.format(&Rfc3339).unwrap(), "2026-01-01T03:00:00Z");
    let later = OffsetDateTime::parse("2026-01-01T03:00:00Z", &Rfc3339).unwrap();
    assert_eq!(
        spec.next_after(later).unwrap().format(&Rfc3339).unwrap(),
        "2026-01-02T03:00:00Z"
    );
    let weekly = CronSpec::parse("*/15 9-17 * * 1-5").unwrap();
    let saturday = OffsetDateTime::parse("2026-01-03T10:00:00Z", &Rfc3339).unwrap();
    assert_eq!(
        weekly
            .next_after(saturday)
            .unwrap()
            .format(&Rfc3339)
            .unwrap(),
        "2026-01-05T09:00:00Z"
    );
    assert!(CronSpec::parse("every 5 minutes").is_none());
    assert!(CronSpec::parse("61 * * * *").is_none());
    let cadence = Cadence::parse(&ScheduleDefinition {
        project: "p".to_owned(),
        topic: "t".to_owned(),
        expression: "0 3 * * *".to_owned(),
        time_zone: Some("Europe/Berlin".to_owned()),
    })
    .unwrap();
    assert!(matches!(cadence, Cadence::Cron(_)));
}

#[test]
fn durations_deserialize_from_proto3_json() {
    let request: google::pubsub::v1::UpdateTopicRequest = serde_json::from_str(
        r#"{"topic":{"name":"projects/p/topics/t","messageRetentionDuration":"1200s"},"updateMask":{"paths":["message_retention_duration"]}}"#,
    )
    .unwrap();
    assert_eq!(
        request.update_mask.unwrap().paths,
        vec!["message_retention_duration"]
    );
    assert_eq!(
        request
            .topic
            .unwrap()
            .message_retention_duration
            .unwrap()
            .seconds,
        1200
    );
}

#[test]
fn frozen_fixture_covers_every_rpc_over_both_transports() {
    let fixture: JsonValue = serde_json::from_str(include_str!(
        "../../../conformance/fixtures/pubsub-v1/emulator-programs.json"
    ))
    .expect("fixture");
    assert_eq!(fixture["targetVersion"], "0.8.33");
    assert_eq!(fixture["coverage"]["grpcMissing"], json!([]));
    assert_eq!(
        fixture["coverage"]["httpMissing"],
        json!(["Subscriber.StreamingPull"])
    );
}
