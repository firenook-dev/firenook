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
use crate::scheduler::{Cadence, CronSpec, Zone};

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
    assert_eq!(runtime.schedules().len(), 0);
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
    let parse = |expression: &str, time_zone: Option<&str>| {
        Cadence::parse_expression(expression, time_zone)
    };
    assert_eq!(
        parse("every 5 minutes", None),
        Ok(Cadence::Interval(std::time::Duration::from_mins(5)))
    );
    assert_eq!(
        parse("every 30 mins", Some("Mars/Olympus_Mons")),
        Ok(Cadence::Interval(std::time::Duration::from_mins(30))),
        "an interval does not depend on its zone"
    );
    assert_eq!(
        parse("every day 00:00", Some("UTC")),
        Ok(Cadence::Weekly {
            weekdays: 0x7f,
            time: time::Time::MIDNIGHT,
            zone: Zone::Utc
        })
    );
    assert!(matches!(
        parse("every day 03:00", Some("Etc/UTC")),
        Ok(Cadence::Weekly { time, zone: Zone::Utc, .. }) if time.hour() == 3 && time.minute() == 0
    ));
    assert_eq!(
        parse("every day 03:00", Some("Mars/Olympus_Mons")),
        Err(ScheduleError(
            "time zone Mars/Olympus_Mons is not in this engine's time-zone database".to_owned()
        ))
    );
    assert!(parse("every day 24:00", None).is_err());
    assert!(parse("every 0 minutes", None).is_err());
}

#[test]
fn cron_expressions_evaluate_in_their_zone() {
    let at = |text: &str| OffsetDateTime::parse(text, &Rfc3339).unwrap();
    let next = |spec: CronSpec, zone: Zone, now: &str| {
        spec.next_after(at(now), zone)
            .unwrap()
            .format(&Rfc3339)
            .unwrap()
    };
    let spec = CronSpec::parse("0 3 * * *").unwrap();
    assert_eq!(
        next(spec, Zone::Utc, "2026-01-01T02:59:30Z"),
        "2026-01-01T03:00:00Z"
    );
    assert_eq!(
        next(spec, Zone::Utc, "2026-01-01T03:00:00Z"),
        "2026-01-02T03:00:00Z"
    );
    let weekly = CronSpec::parse("*/15 9-17 * * 1-5").unwrap();
    assert_eq!(
        next(weekly, Zone::Utc, "2026-01-03T10:00:00Z"),
        "2026-01-05T09:00:00Z"
    );
    // Names, and 7 for Sunday.
    let named = CronSpec::parse("0 9 * JAN mon-FRI").unwrap();
    assert_eq!(
        next(named, Zone::Utc, "2026-01-03T10:00:00Z"),
        "2026-01-05T09:00:00Z"
    );
    let sunday = CronSpec::parse("0 0 * * 7").unwrap();
    assert_eq!(
        next(sunday, Zone::Utc, "2026-01-01T00:00:00Z"),
        "2026-01-04T00:00:00Z"
    );
    // Both day fields restricted: either matches, as cron has it (the 13th,
    // or a Friday).
    let either = CronSpec::parse("0 0 13 * 5").unwrap();
    assert_eq!(
        next(either, Zone::Utc, "2026-04-11T00:00:00Z"),
        "2026-04-13T00:00:00Z",
        "Monday the 13th"
    );
    assert_eq!(
        next(either, Zone::Utc, "2026-04-13T00:00:00Z"),
        "2026-04-17T00:00:00Z",
        "Friday the 17th"
    );
    assert!(CronSpec::parse("every 5 minutes").is_none());
    assert!(CronSpec::parse("61 * * * *").is_none());
    assert!(CronSpec::parse("0 0 * * 8").is_none());
    // A zone with one offset: Etc/GMT-1 is an hour east of UTC.
    let monday = CronSpec::parse("0 9 * * 1").unwrap();
    let east = Zone::resolve(Some("Etc/GMT-1")).unwrap();
    assert_eq!(
        next(monday, east, "2026-01-01T00:00:00Z"),
        "2026-01-05T08:00:00Z"
    );
    assert!(matches!(
        Cadence::parse_expression("0 9 * * 1", Some("Etc/GMT-1")),
        Ok(Cadence::Cron { zone, .. }) if zone == east
    ));
}

#[test]
fn cron_and_daily_run_in_their_zone() {
    let at = |text: &str| OffsetDateTime::parse(text, &Rfc3339).unwrap();
    let ticks = |expression: &str, zone: Option<&str>, from: &str, count: usize| {
        let cadence = Cadence::parse_expression(expression, zone).expect(expression);
        let mut now = at(from);
        let mut out = Vec::new();
        for _ in 0..count {
            now = cadence.next_after(now).expect("a next tick");
            out.push(now.format(&Rfc3339).unwrap());
        }
        out
    };
    // Etc/GMT+5 is five hours west: a daily 02:30 there is 07:30Z.
    assert_eq!(
        ticks(
            "every day 02:30",
            Some("Etc/GMT+5"),
            "2026-03-08T00:00:00Z",
            2
        ),
        ["2026-03-08T07:30:00Z", "2026-03-09T07:30:00Z"]
    );
    // App Engine forms.
    assert_eq!(
        ticks("every monday 09:00", None, "2026-01-01T00:00:00Z", 2),
        ["2026-01-05T09:00:00Z", "2026-01-12T09:00:00Z"]
    );
    assert_eq!(
        ticks("every mon,wed,fri 09:00", None, "2026-01-05T09:00:00Z", 3),
        [
            "2026-01-07T09:00:00Z",
            "2026-01-09T09:00:00Z",
            "2026-01-12T09:00:00Z"
        ]
    );
    assert_eq!(
        ticks(
            "every 2 hours from 10:00 to 14:00",
            None,
            "2026-01-01T11:00:00Z",
            4
        ),
        [
            "2026-01-01T12:00:00Z",
            "2026-01-01T14:00:00Z",
            "2026-01-02T10:00:00Z",
            "2026-01-02T12:00:00Z"
        ]
    );
    // A window past midnight.
    assert_eq!(
        ticks(
            "every 3 hours from 22:00 to 04:00",
            None,
            "2026-01-01T21:00:00Z",
            4
        ),
        [
            "2026-01-01T22:00:00Z",
            "2026-01-02T01:00:00Z",
            "2026-01-02T04:00:00Z",
            "2026-01-02T22:00:00Z"
        ]
    );
    assert_eq!(
        ticks(
            "every 15 mins synchronized",
            None,
            "2026-01-01T10:07:00Z",
            2
        ),
        ["2026-01-01T10:15:00Z", "2026-01-01T10:30:00Z"]
    );
    // An ordinal form is not automatic, with the reason.
    assert_eq!(
        Cadence::parse_expression("1st monday of month 09:00", None),
        Err(ScheduleError(
            "unsupported Firebase schedule expression: 1st monday of month 09:00".to_owned()
        ))
    );
    // The scheduler's view states the zone it evaluates in.
    let view = |zone: Option<&str>| {
        let mut book = crate::scheduler::ScheduleBook::default();
        book.reconcile(vec![ScheduleDefinition {
            function_id: "us-central1-tick".to_owned(),
            function_name: "tick".to_owned(),
            region: "us-central1".to_owned(),
            project: "p".to_owned(),
            topic: "firebase-schedule-tick".to_owned(),
            expression: "every day 02:30".to_owned(),
            time_zone: zone.map(str::to_owned),
        }]);
        book.view("us-central1-tick").expect("view")
    };
    assert_eq!(view(None).evaluated_in, "UTC");
    assert_eq!(view(Some("Etc/GMT+5")).evaluated_in, "Etc/GMT+5");
    assert!(view(Some("Etc/GMT+5")).automatic);
    let unknown = view(Some("Mars/Olympus_Mons"));
    assert!(!unknown.automatic);
    assert_eq!(
        unknown.problem.as_deref(),
        Some("time zone Mars/Olympus_Mons is not in this engine's time-zone database")
    );
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

#[tokio::test]
async fn dead_lettered_messages_reach_functions() {
    let background = TriggerRegistry::default();
    let (observer, mut deliveries) = TriggerObserver::channel(background.clone());
    let dead = format!("projects/{PROJECT}/topics/orders-dead");
    let orders = format!("projects/{PROJECT}/topics/orders");
    let worker = format!("projects/{PROJECT}/subscriptions/orders-worker");
    let mut functions = inventory();
    for function in &mut functions.backends[0].function_triggers {
        if function.name == "topicEcho" {
            function
                .event_trigger
                .as_mut()
                .expect("event trigger")
                .resource
                .clone_from(&dead);
        }
    }
    let runtime = router(PROJECT, &functions, observer.queue(), background);
    let broker = runtime.broker();
    broker
        .create_topic(google::pubsub::v1::Topic {
            name: orders.clone(),
            ..Default::default()
        })
        .expect("topic");
    broker
        .create_subscription(google::pubsub::v1::Subscription {
            name: worker.clone(),
            topic: orders.clone(),
            dead_letter_policy: Some(google::pubsub::v1::DeadLetterPolicy {
                dead_letter_topic: dead.clone(),
                max_delivery_attempts: 5,
            }),
            ..Default::default()
        })
        .expect("subscription");
    broker
        .publish(
            &orders,
            vec![google::pubsub::v1::PubsubMessage {
                data: b"{\"order\":1}".to_vec(),
                ..Default::default()
            }],
        )
        .expect("publish");
    for _ in 0..5 {
        let received = broker.pull(&worker, 1).expect("pull");
        let ack_ids: Vec<String> = received.into_iter().map(|message| message.ack_id).collect();
        broker
            .modify_ack_deadline(&worker, &ack_ids, 0)
            .expect("nack");
    }
    let dispatch = tokio::time::timeout(std::time::Duration::from_secs(5), deliveries.recv())
        .await
        .expect("a dispatch within the timeout")
        .expect("dispatch");
    assert_eq!(
        dispatch.path,
        format!("/functions/projects/{PROJECT}/triggers/us-central1-topicEcho-0")
    );
    let event: JsonValue = serde_json::from_slice(&dispatch.body).expect("CloudEvent");
    assert_eq!(event["source"], format!("//pubsub.googleapis.com/{dead}"));
    assert_eq!(
        event["data"]["message"]["attributes"]["CloudPubSubDeadLetterSourceSubscription"],
        "orders-worker"
    );
    assert_eq!(
        event["data"]["message"]["data"],
        BASE64.encode("{\"order\":1}")
    );
    // The functions consumer drained its subscription on the dead-letter topic.
    let functions_subscription =
        format!("projects/{PROJECT}/subscriptions/emulator-sub-orders-dead");
    let counts = broker
        .subscription_counts(&functions_subscription)
        .expect("counts");
    assert_eq!(counts.available + counts.outstanding + counts.pushing, 0);
    assert_eq!(
        broker
            .subscription_counts(&worker)
            .expect("counts")
            .dead_lettered_total,
        1
    );
    runtime.shutdown().await;
}

#[tokio::test]
async fn the_ticker_stops_on_shutdown() {
    let (runtime, _deliveries, _background) = runtime_and_deliveries();
    assert!(runtime.ticker_running());
    runtime.shutdown().await;
    assert!(!runtime.ticker_running());
    // A codebase reload restarts the scheduler, never the stopped timer.
    let scheduler = runtime.start_scheduler().expect("scheduler");
    assert!(!runtime.ticker_running());
    scheduler.shutdown().await;
}

#[tokio::test]
async fn an_emulator_subscription_whose_function_left_is_orphaned() {
    let background = TriggerRegistry::default();
    let (observer, mut deliveries) = TriggerObserver::channel(background.clone());
    let current = inventory();
    let mut runtime = router(PROJECT, &current, observer.queue(), background);
    let mut scheduler = runtime.start_scheduler().expect("scheduler");
    let functions_subscription =
        format!("projects/{PROJECT}/subscriptions/emulator-sub-phase4-topic");
    assert_eq!(runtime.managed(&functions_subscription), Managed::Functions);
    assert_eq!(
        runtime.managed(&format!("projects/{PROJECT}/subscriptions/other")),
        Managed::No
    );
    let backlog = |runtime: &PubsubRuntime| {
        runtime
            .broker()
            .subscription_counts(&functions_subscription)
            .expect("the subscription is never deleted")
            .available
    };

    let empty = firenook_functions_bridge::FunctionsInventory {
        generation: 0,
        backends: Vec::new(),
    };
    runtime
        .refresh_inventory(PROJECT, &empty, &mut scheduler)
        .await
        .expect("refresh");
    assert_eq!(runtime.managed(&functions_subscription), Managed::Orphaned);
    let response = runtime
        .application()
        .oneshot(publish_request(
            "phase4-topic",
            &json!({ "messages": [{ "data": "e30=" }] }),
        ))
        .await
        .expect("publish");
    assert_eq!(response.status(), StatusCode::OK);
    // Nothing drains it and nothing reaches a function.
    assert_eq!(backlog(&runtime), 1);
    assert!(deliveries.try_recv().is_err());

    runtime
        .refresh_inventory(PROJECT, &current, &mut scheduler)
        .await
        .expect("refresh");
    assert_eq!(runtime.managed(&functions_subscription), Managed::Functions);
    let response = runtime
        .application()
        .oneshot(publish_request(
            "phase4-topic",
            &json!({ "messages": [{ "data": "e30=" }] }),
        ))
        .await
        .expect("publish");
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(backlog(&runtime), 0);
    assert!(
        deliveries
            .recv()
            .await
            .expect("dispatch")
            .path
            .ends_with("/us-central1-topicEcho-0")
    );
    scheduler.shutdown().await;
    runtime.shutdown().await;
}

/// The broker's cost model and memory bounds: one transition keeps counts,
/// indexes and holder counters equal to a scan; acknowledged messages stay
/// only while something can revive them; history rings stay bounded.
mod backlog {
    use std::collections::BTreeMap;
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

    use pbjson_types::Timestamp;

    use crate::broker::{Broker, HistoryLimits, MessageMark, visits};
    use crate::google::pubsub::v1::{
        DeadLetterPolicy, PubsubMessage, PushConfig, Subscription, Topic,
    };

    const ORDERS: &str = "projects/p/topics/orders";
    const DEAD: &str = "projects/p/topics/orders-dead";

    fn subscription_name(id: &str) -> String {
        format!("projects/p/subscriptions/{id}")
    }

    fn marks_name(id: &str) -> String {
        subscription_name(id)
    }

    fn create_topic(broker: &Broker, name: &str, retention: Option<i64>) {
        broker
            .create_topic(Topic {
                name: name.to_owned(),
                message_retention_duration: retention
                    .map(|seconds| pbjson_types::Duration { seconds, nanos: 0 }),
                ..Topic::default()
            })
            .expect("topic");
    }

    fn create_subscription(
        broker: &Broker,
        id: &str,
        topic: &str,
        configure: impl FnOnce(&mut Subscription),
    ) -> String {
        let mut subscription = Subscription {
            name: subscription_name(id),
            topic: topic.to_owned(),
            ..Subscription::default()
        };
        configure(&mut subscription);
        broker
            .create_subscription(subscription)
            .expect("subscription");
        subscription_name(id)
    }

    fn message(text: &str, key: &str, kind: Option<&str>) -> PubsubMessage {
        PubsubMessage {
            data: text.as_bytes().to_vec(),
            ordering_key: key.to_owned(),
            attributes: kind
                .map(|kind| BTreeMap::from([("kind".to_owned(), kind.to_owned())]))
                .unwrap_or_default(),
            ..PubsubMessage::default()
        }
    }

    fn publish(broker: &Broker, topic: &str, count: usize) -> Vec<u64> {
        let mut ids = Vec::with_capacity(count);
        let mut remaining = count;
        while remaining > 0 {
            let batch = remaining.min(1_000);
            let (published, _) = broker
                .publish(topic, (0..batch).map(|_| message("m", "", None)).collect())
                .expect("publish");
            ids.extend(published.iter().map(|id| id.parse::<u64>().expect("id")));
            remaining -= batch;
        }
        ids
    }

    fn pull_ack_ids(broker: &Broker, subscription: &str, max: i32) -> Vec<String> {
        broker
            .pull(subscription, max)
            .expect("pull")
            .into_iter()
            .map(|received| received.ack_id)
            .collect()
    }

    fn pull_and_ack_all(broker: &Broker, subscription: &str) {
        loop {
            let ack_ids = pull_ack_ids(broker, subscription, 1_000);
            if ack_ids.is_empty() {
                return;
            }
            broker.acknowledge(subscription, &ack_ids).expect("ack");
        }
    }

    fn timestamp(time: SystemTime) -> Timestamp {
        let since = time.duration_since(UNIX_EPOCH).expect("after the epoch");
        Timestamp {
            seconds: i64::try_from(since.as_secs()).expect("seconds"),
            nanos: i32::try_from(since.subsec_nanos()).expect("nanos"),
        }
    }

    /// A small deterministic generator, so a failing sequence replays.
    struct Sequence(u64);

    impl Sequence {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }

        fn below(&mut self, bound: usize) -> usize {
            usize::try_from(self.next() % u64::try_from(bound).expect("bound")).expect("index")
        }

        fn chance(&mut self, percent: usize) -> bool {
            self.below(100) < percent
        }
    }

    #[test]
    fn counters_indexes_and_holders_agree_with_a_scan_after_any_sequence() {
        let seeds: Vec<u64> = std::env::var("FIRENOOK_SEQUENCE_SEEDS").map_or_else(
            |_| {
                vec![
                    0x9e37_79b9_7f4a_7c15,
                    0x2545_f491_4f6c_dd1d,
                    0x1234_5678_9abc_def1,
                ]
            },
            |seeds| {
                seeds
                    .split(',')
                    .filter_map(|seed| seed.trim().parse().ok())
                    .collect()
            },
        );
        let _ = visits::take();
        let mut dead_lettered = 0;
        for seed in seeds {
            dead_lettered += run_sequence(seed);
        }
        // The sequences went through every rule that keeps or drops a copy.
        let seen = visits::take();
        assert!(seen.kept_for_peers > 0, "{seen:?}");
        assert!(seen.kept_for_snapshots > 0, "{seen:?}");
        assert!(seen.released > 0, "{seen:?}");
        assert!(seen.pruned > 0, "{seen:?}");
        assert!(dead_lettered > 0, "the sequences dead-lettered nothing");
    }

    /// 2,000 random operations on four subscriptions, the invariants checked
    /// after each; returns how many messages were dead-lettered.
    #[allow(clippy::too_many_lines)]
    fn run_sequence(seed: u64) -> u64 {
        let broker = Broker::new();
        create_topic(&broker, ORDERS, None);
        create_topic(&broker, DEAD, None);
        let a = create_subscription(&broker, "sub-a", ORDERS, |subscription| {
            subscription.enable_message_ordering = true;
            subscription.message_retention_duration = Some(pbjson_types::Duration {
                seconds: 600,
                nanos: 0,
            });
        });
        let b = create_subscription(&broker, "sub-b", ORDERS, |subscription| {
            subscription.filter = r#"attributes.kind != "skip""#.to_owned();
            subscription.dead_letter_policy = Some(DeadLetterPolicy {
                dead_letter_topic: DEAD.to_owned(),
                max_delivery_attempts: 5,
            });
        });
        let c = create_subscription(&broker, "sub-c", ORDERS, |subscription| {
            subscription.enable_exactly_once_delivery = true;
        });
        let d = create_subscription(&broker, "sub-d", DEAD, |_| {});
        let subscriptions = [a.clone(), b.clone(), c.clone(), d.clone()];
        let mut ack_ids: BTreeMap<String, Vec<String>> = BTreeMap::new();
        let mut moments = vec![SystemTime::now()];
        let mut snapshots: Vec<String> = Vec::new();
        let mut snapshot_counter = 0;
        let mut extra = false;
        let mut retain = false;
        let mut push = false;
        let mut late_ticks = 0;
        let mut random = Sequence(seed);
        broker.check_invariants();
        for step in 0..2_000 {
            match random.below(16) {
                0..=2 => {
                    let count = 1 + random.below(5);
                    let messages = (0..count)
                        .map(|index| {
                            let key = ["", "k1", "k2"][random.below(3)];
                            let kind = [None, Some("skip"), Some("go")][random.below(3)];
                            message(&format!("{step}-{index}"), key, kind)
                        })
                        .collect();
                    broker.publish(ORDERS, messages).expect("publish");
                    moments.push(SystemTime::now());
                }
                3 | 4 => {
                    let name = &subscriptions[random.below(4)];
                    let max = i32::try_from(1 + random.below(10)).expect("max");
                    ack_ids
                        .entry(name.clone())
                        .or_default()
                        .extend(pull_ack_ids(&broker, name, max));
                }
                5 => {
                    let name = &subscriptions[random.below(4)];
                    let held = ack_ids.entry(name.clone()).or_default();
                    if !held.is_empty() {
                        let take = 1 + random.below(held.len());
                        let chosen: Vec<String> = held.drain(..take).collect();
                        let _ = broker.acknowledge(name, &chosen);
                    }
                }
                6 => {
                    let name = &subscriptions[random.below(4)];
                    let held = ack_ids.entry(name.clone()).or_default();
                    if !held.is_empty() {
                        let take = 1 + random.below(held.len());
                        let chosen: Vec<String> = held.drain(..take).collect();
                        let seconds = if random.chance(70) { 0 } else { 30 };
                        let _ = broker.modify_ack_deadline(name, &chosen, seconds);
                    }
                }
                7 => {
                    // Past the retention, each time later than the last
                    // once-a-second pass, so the pass runs again.
                    let offset = match random.below(4) {
                        0 => 0,
                        1 => 15,
                        2 => 45,
                        _ => {
                            late_ticks += 2;
                            700 + late_ticks
                        }
                    };
                    let jobs = broker.tick_at(Instant::now() + Duration::from_secs(offset));
                    for job in jobs {
                        broker.push_finished(&job, random.chance(50));
                    }
                }
                8 => {
                    let name = &subscriptions[random.below(4)];
                    let target = if random.chance(20) {
                        SystemTime::now() + Duration::from_secs(3_600)
                    } else {
                        moments[random.below(moments.len())]
                    };
                    broker
                        .seek_to_time(name, &timestamp(target))
                        .expect("seek to a time");
                }
                9 => {
                    if snapshots.is_empty() || random.chance(50) {
                        snapshot_counter += 1;
                        let snapshot = format!("projects/p/snapshots/snap-{snapshot_counter}");
                        let source = &subscriptions[random.below(3)];
                        broker
                            .create_snapshot(&snapshot, source, BTreeMap::new())
                            .expect("snapshot");
                        snapshots.push(snapshot);
                    } else if random.chance(50) {
                        let snapshot = &snapshots[random.below(snapshots.len())];
                        let name = &subscriptions[random.below(3)];
                        broker
                            .seek_to_snapshot(name, snapshot)
                            .expect("seek to a snapshot");
                    } else {
                        let snapshot = snapshots.remove(random.below(snapshots.len()));
                        broker.delete_snapshot(&snapshot).expect("delete snapshot");
                    }
                }
                10 => broker.drain(&subscriptions[random.below(4)]),
                11 => {
                    push = !push;
                    let endpoint = if push { "http://127.0.0.1:9/push" } else { "" };
                    broker
                        .modify_push_config(
                            &c,
                            Some(PushConfig {
                                push_endpoint: endpoint.to_owned(),
                                ..PushConfig::default()
                            }),
                        )
                        .expect("push config");
                }
                12 => {
                    retain = !retain;
                    broker
                        .update_subscription(
                            Some(Subscription {
                                name: a.clone(),
                                retain_acked_messages: retain,
                                ..Subscription::default()
                            }),
                            &["retain_acked_messages".to_owned()],
                        )
                        .expect("retain");
                }
                14 | 15 => {
                    // A consumer that fails everything it gets.
                    let failing = pull_ack_ids(&broker, &b, 10);
                    if !failing.is_empty() {
                        broker.modify_ack_deadline(&b, &failing, 0).expect("nack");
                    }
                }
                _ => {
                    let name = subscription_name("sub-extra");
                    if extra {
                        broker.delete_subscription(&name).expect("delete");
                    } else {
                        create_subscription(&broker, "sub-extra", DEAD, |_| {});
                    }
                    extra = !extra;
                }
            }
            broker.check_invariants();
        }
        broker
            .subscription_counts(&b)
            .expect("counts")
            .dead_lettered_total
    }

    #[test]
    fn acked_messages_are_dropped_only_when_nothing_can_revive_them() {
        // (a) One subscription, no retention, no snapshot: an ack drops it;
        // with retention it stays.
        let broker = Broker::new();
        create_topic(&broker, ORDERS, None);
        let plain = create_subscription(&broker, "plain", ORDERS, |_| {});
        publish(&broker, ORDERS, 1);
        pull_and_ack_all(&broker, &plain);
        assert_eq!(broker.tracked_ids(&plain), BTreeMap::new());
        broker.check_invariants();

        let broker = Broker::new();
        create_topic(&broker, ORDERS, None);
        let kept = create_subscription(&broker, "kept", ORDERS, |subscription| {
            subscription.retain_acked_messages = true;
        });
        let ids = publish(&broker, ORDERS, 1);
        pull_and_ack_all(&broker, &kept);
        assert_eq!(
            broker.tracked_ids(&kept),
            BTreeMap::from([(ids[0], "acked")])
        );

        // (b) sub-a acks m while sub-b holds it; a snapshot taken from sub-b
        // afterwards lists m; seeking sub-a to it brings m back.
        let broker = Broker::new();
        create_topic(&broker, ORDERS, None);
        let a = create_subscription(&broker, "sub-a", ORDERS, |_| {});
        let b = create_subscription(&broker, "sub-b", ORDERS, |_| {});
        let m = publish(&broker, ORDERS, 1)[0];
        pull_and_ack_all(&broker, &a);
        assert_eq!(broker.tracked_ids(&a), BTreeMap::from([(m, "acked")]));
        broker.check_invariants();
        let snapshot = "projects/p/snapshots/from-b";
        broker
            .create_snapshot(snapshot, &b, BTreeMap::new())
            .expect("snapshot");
        broker.seek_to_snapshot(&a, snapshot).expect("seek");
        assert_eq!(broker.tracked_ids(&a), BTreeMap::from([(m, "available")]));
        broker.check_invariants();
        // Without the snapshot, once both let go, nothing keeps it.
        broker.delete_snapshot(snapshot).expect("delete snapshot");
        pull_and_ack_all(&broker, &a);
        assert_eq!(broker.tracked_ids(&a), BTreeMap::from([(m, "acked")]));
        pull_and_ack_all(&broker, &b);
        assert_eq!(broker.tracked_ids(&a), BTreeMap::new());
        assert_eq!(broker.tracked_ids(&b), BTreeMap::new());
        broker.check_invariants();

        // (c) sub-b acks m too: gone from both.
        let broker = Broker::new();
        create_topic(&broker, ORDERS, None);
        let a = create_subscription(&broker, "sub-a", ORDERS, |_| {});
        let b = create_subscription(&broker, "sub-b", ORDERS, |_| {});
        publish(&broker, ORDERS, 3);
        pull_and_ack_all(&broker, &a);
        assert_eq!(broker.tracked_ids(&a).len(), 3);
        pull_and_ack_all(&broker, &b);
        assert_eq!(broker.tracked_ids(&a), BTreeMap::new());
        assert_eq!(broker.tracked_ids(&b), BTreeMap::new());
        broker.check_invariants();

        // (d) Acknowledged with nothing holding it, then retention switched
        // on: a seek to before it does not bring it back (the stated divergence).
        let broker = Broker::new();
        create_topic(&broker, ORDERS, None);
        let a = create_subscription(&broker, "sub-a", ORDERS, |_| {});
        let before = SystemTime::now() - Duration::from_secs(1);
        publish(&broker, ORDERS, 1);
        pull_and_ack_all(&broker, &a);
        broker
            .update_subscription(
                Some(Subscription {
                    name: a.clone(),
                    retain_acked_messages: true,
                    ..Subscription::default()
                }),
                &["retain_acked_messages".to_owned()],
            )
            .expect("retain");
        broker.seek_to_time(&a, &timestamp(before)).expect("seek");
        assert_eq!(broker.pull(&a, 10).expect("pull").len(), 0);
        broker.check_invariants();
    }

    #[test]
    fn a_snapshot_keeps_what_it_can_revive() {
        let broker = Broker::new();
        create_topic(&broker, ORDERS, None);
        let a = create_subscription(&broker, "sub-a", ORDERS, |_| {});
        let listed = publish(&broker, ORDERS, 1)[0];
        let snapshot = "projects/p/snapshots/before";
        broker
            .create_snapshot(snapshot, &a, BTreeMap::new())
            .expect("snapshot");
        std::thread::sleep(Duration::from_millis(2));
        let later = publish(&broker, ORDERS, 1)[0];
        pull_and_ack_all(&broker, &a);
        assert_eq!(
            broker.tracked_ids(&a),
            BTreeMap::from([(listed, "acked"), (later, "acked")])
        );
        broker.seek_to_snapshot(&a, snapshot).expect("seek");
        assert_eq!(
            broker.tracked_ids(&a),
            BTreeMap::from([(listed, "available"), (later, "available")])
        );
        broker.check_invariants();
        broker.delete_snapshot(snapshot).expect("delete");
        pull_and_ack_all(&broker, &a);
        assert_eq!(broker.tracked_ids(&a), BTreeMap::new());
        broker.check_invariants();
    }

    #[test]
    fn retained_acked_messages_expire_with_the_subscription_retention_and_cap() {
        let broker = Broker::new();
        create_topic(&broker, ORDERS, None);
        let a = create_subscription(&broker, "sub-a", ORDERS, |subscription| {
            subscription.retain_acked_messages = true;
            subscription.message_retention_duration = Some(pbjson_types::Duration {
                seconds: 600,
                nanos: 0,
            });
        });
        publish(&broker, ORDERS, 3);
        pull_and_ack_all(&broker, &a);
        assert_eq!(broker.tracked_ids(&a).len(), 3);
        let _ = broker.tick_at(Instant::now() + Duration::from_secs(599));
        assert_eq!(broker.tracked_ids(&a).len(), 3);
        // The next once-a-second pass past the retention drops them.
        let _ = broker.tick_at(Instant::now() + Duration::from_secs(602));
        assert_eq!(broker.tracked_ids(&a), BTreeMap::new());
        broker.check_invariants();

        let broker = Broker::new();
        create_topic(&broker, ORDERS, None);
        let a = create_subscription(&broker, "sub-a", ORDERS, |subscription| {
            subscription.retain_acked_messages = true;
        });
        let ids = publish(&broker, ORDERS, 100_001);
        pull_and_ack_all(&broker, &a);
        assert_eq!(
            broker
                .subscription_counts(&a)
                .expect("counts")
                .retained_acked,
            100_001
        );
        let _ = broker.tick_at(Instant::now() + Duration::from_secs(2));
        let tracked = broker.tracked_ids(&a);
        assert_eq!(tracked.len(), 100_000);
        assert!(!tracked.contains_key(&ids[0]));
        assert!(tracked.contains_key(&ids[1]));
    }

    #[test]
    fn topic_history_is_bounded_by_count_bytes_time_and_the_global_cap() {
        let broker = Broker::new();
        create_topic(&broker, ORDERS, None);
        let ids = publish(&broker, ORDERS, 5_001);
        let window = broker.history_window(ORDERS).expect("window");
        assert_eq!(window.messages, 5_000);
        assert_eq!(window.dropped, 1);
        assert_eq!(window.oldest_id, Some(ids[1]));
        assert_eq!(window.capacity_messages, 5_000);
        assert_eq!(window.capacity_bytes, 16 << 20);

        // 17 MiB published: the ring keeps 16.
        let broker = Broker::new();
        create_topic(&broker, ORDERS, None);
        for _ in 0..17 {
            broker
                .publish(
                    ORDERS,
                    vec![PubsubMessage {
                        data: vec![b'x'; 1 << 20],
                        ..PubsubMessage::default()
                    }],
                )
                .expect("publish");
        }
        let window = broker.history_window(ORDERS).expect("window");
        assert_eq!(window.messages, 16);
        assert_eq!(window.bytes, 16 << 20);
        assert_eq!(window.dropped, 1);

        // A retention topic keeps its window, up to its own cap, and drops
        // by time in the tick.
        let broker = Broker::new();
        create_topic(&broker, ORDERS, Some(600));
        publish(&broker, ORDERS, 100_001);
        let window = broker.history_window(ORDERS).expect("window");
        assert_eq!(window.messages, 100_000);
        assert_eq!(window.capacity_messages, 100_000);
        assert_eq!(window.capacity_bytes, 256 << 20);
        let _ = broker.tick_at(Instant::now() + Duration::from_secs(601));
        assert_eq!(broker.history_window(ORDERS).expect("window").messages, 0);
        broker.check_invariants();

        // Over the global cap, the topic without retention holding the most
        // goes first, never below the floor, before any retention topic.
        let kibibyte = |count: usize| -> Vec<PubsubMessage> {
            (0..count)
                .map(|_| PubsubMessage {
                    data: vec![b'x'; 1_024],
                    ..PubsubMessage::default()
                })
                .collect()
        };
        let broker = Broker::with_limits(HistoryLimits {
            total_bytes: 1 << 20,
            bytes: 1 << 20,
            retention_bytes: 1 << 20,
            floor: 100,
            ..HistoryLimits::default()
        });
        let keep = "projects/p/topics/keep";
        let a = "projects/p/topics/topic-a";
        let b = "projects/p/topics/topic-b";
        create_topic(&broker, keep, Some(3_600));
        create_topic(&broker, a, None);
        create_topic(&broker, b, None);
        broker.publish(keep, kibibyte(600)).expect("publish");
        broker.publish(a, kibibyte(300)).expect("publish");
        broker.publish(b, kibibyte(200)).expect("publish");
        let count = |topic: &str| broker.history_window(topic).expect("window").messages;
        assert_eq!((count(keep), count(a), count(b)), (600, 224, 200));
        broker.publish(b, kibibyte(400)).expect("publish");
        assert_eq!(count(keep), 600);
        assert_eq!(count(a) + count(b), 424);
        assert!(count(a).abs_diff(count(b)) <= 1);
        broker.check_invariants();
        // Both at the floor, the retention topic gives way.
        let broker = Broker::with_limits(HistoryLimits {
            total_bytes: 1 << 20,
            bytes: 1 << 20,
            retention_bytes: 1 << 20,
            floor: 100,
            ..HistoryLimits::default()
        });
        create_topic(&broker, keep, Some(3_600));
        create_topic(&broker, a, None);
        broker.publish(keep, kibibyte(1_000)).expect("publish");
        broker.publish(a, kibibyte(300)).expect("publish");
        assert_eq!(broker.history_window(a).expect("window").messages, 100);
        assert_eq!(broker.history_window(keep).expect("window").messages, 924);
        broker.check_invariants();
    }

    #[test]
    fn a_subscription_created_later_gets_the_retained_window() {
        let broker = Broker::new();
        create_topic(&broker, ORDERS, Some(600));
        let ids = publish(&broker, ORDERS, 3);
        let late = create_subscription(&broker, "late", ORDERS, |_| {});
        assert_eq!(
            broker.tracked_ids(&late),
            ids.iter().map(|id| (*id, "available")).collect()
        );
        assert_eq!(broker.pull(&late, 10).expect("pull").len(), 3);
        broker.check_invariants();

        // Retention set later: the new subscription gets only what the ring
        // kept while the topic had none (the stated divergence).
        let broker = Broker::with_limits(HistoryLimits {
            messages: 10,
            ..HistoryLimits::default()
        });
        create_topic(&broker, ORDERS, None);
        let ids = publish(&broker, ORDERS, 15);
        broker
            .update_topic(
                Some(Topic {
                    name: ORDERS.to_owned(),
                    message_retention_duration: Some(pbjson_types::Duration {
                        seconds: 3_600,
                        nanos: 0,
                    }),
                    ..Topic::default()
                }),
                &["message_retention_duration".to_owned()],
            )
            .expect("retention");
        let late = create_subscription(&broker, "late", ORDERS, |_| {});
        let tracked = broker.tracked_ids(&late);
        assert_eq!(tracked.len(), 10);
        assert_eq!(tracked.keys().next(), Some(&ids[5]));
    }

    #[test]
    fn tick_visits_only_due_leases_and_pushes() {
        let broker = Broker::new();
        create_topic(&broker, ORDERS, None);
        let a = create_subscription(&broker, "sub-a", ORDERS, |_| {});
        publish(&broker, ORDERS, 100_000);
        let _ = visits::take();
        let jobs = broker.tick_at(Instant::now());
        assert_eq!(jobs.len(), 0);
        assert_eq!(visits::take().tick, 0);
        assert_eq!(broker.pull(&a, 10).expect("pull").len(), 10);
        let _ = visits::take();
        let _ = broker.tick_at(Instant::now() + Duration::from_secs(11));
        assert_eq!(visits::take().tick, 10);
        let counts = broker.subscription_counts(&a).expect("counts");
        assert_eq!((counts.available, counts.outstanding), (100_000, 0));

        // Push: only the due pushes, and an in-flight push is not due again.
        let pushed = create_subscription(&broker, "pushed", ORDERS, |subscription| {
            subscription.push_config = Some(PushConfig {
                push_endpoint: "http://127.0.0.1:9/push".to_owned(),
                ..PushConfig::default()
            });
        });
        publish(&broker, ORDERS, 5);
        let _ = visits::take();
        let jobs = broker.tick_at(Instant::now());
        assert_eq!(jobs.len(), 5);
        assert_eq!(visits::take().tick, 5);
        assert_eq!(broker.tick_at(Instant::now()).len(), 0);
        assert_eq!(visits::take().tick, 0);
        for job in &jobs {
            broker.push_finished(job, false);
        }
        assert_eq!(
            broker
                .tick_at(Instant::now() + Duration::from_secs(2))
                .len(),
            5
        );
        assert_eq!(
            broker.subscription_counts(&pushed).expect("counts").pushing,
            5
        );
        broker.check_invariants();
    }

    #[test]
    fn pull_and_ack_cost_what_they_take() {
        // The cost model holds at any backlog size; 100,000 keeps the default
        // run light (the ignored perf test runs a million).
        let broker = Broker::new();
        create_topic(&broker, ORDERS, None);
        let a = create_subscription(&broker, "sub-a", ORDERS, |_| {});
        publish(&broker, ORDERS, 100_000);
        let _ = visits::take();
        let ten = pull_ack_ids(&broker, &a, 10);
        assert_eq!(ten.len(), 10);
        assert_eq!(visits::take().take, 10);
        let thousand = pull_ack_ids(&broker, &a, 1_000);
        let _ = visits::take();
        broker.acknowledge(&a, &thousand).expect("ack");
        let counted = visits::take();
        assert_eq!(counted.ack_lookups, 1_000);
        assert_eq!(counted.map_walks, 0);
        let counts = broker.subscription_counts(&a).expect("counts");
        assert_eq!(
            (counts.available, counts.outstanding, counts.acked_total),
            (98_990, 10, 1_000)
        );

        // A pull skips the messages of a blocked ordering key, and only those.
        let broker = Broker::new();
        create_topic(&broker, ORDERS, None);
        let ordered = create_subscription(&broker, "ordered", ORDERS, |subscription| {
            subscription.enable_message_ordering = true;
        });
        broker
            .publish(ORDERS, (0..3).map(|_| message("k", "k", None)).collect())
            .expect("publish");
        publish(&broker, ORDERS, 20);
        assert_eq!(broker.pull(&ordered, 1).expect("pull").len(), 1);
        let _ = visits::take();
        assert_eq!(broker.pull(&ordered, 10).expect("pull").len(), 10);
        assert_eq!(visits::take().take, 12);
        assert_eq!(
            broker
                .subscription_counts(&ordered)
                .expect("counts")
                .blocked_keys,
            1
        );
        broker.check_invariants();
    }

    #[test]
    #[ignore = "timed; run with --ignored perf_ in release mode on the acceptance host"]
    fn perf_pull_and_ack_at_a_million() {
        let broker = Broker::new();
        create_topic(&broker, ORDERS, None);
        let a = create_subscription(&broker, "sub-a", ORDERS, |_| {});
        publish(&broker, ORDERS, 1_000_000);
        let started = Instant::now();
        assert_eq!(broker.pull(&a, 10).expect("pull").len(), 10);
        let pull = started.elapsed();
        let ack_ids = pull_ack_ids(&broker, &a, 1_000);
        let started = Instant::now();
        broker.acknowledge(&a, &ack_ids).expect("ack");
        let ack = started.elapsed();
        assert!(pull < Duration::from_millis(1), "pull 10 took {pull:?}");
        assert!(ack < Duration::from_millis(5), "ack 1,000 took {ack:?}");

        // The first message page of a 100,000-message retention topic.
        let broker = Broker::new();
        let retained = "projects/p/topics/retained";
        create_topic(&broker, retained, Some(3_600));
        publish(&broker, retained, 100_000);
        let started = Instant::now();
        let page = broker
            .history_page(
                retained,
                &crate::broker::inspect::MessageQuery::default(),
                None,
                None,
                100,
            )
            .expect("page");
        let first_page = started.elapsed();
        assert_eq!(page.rows.len(), 100);
        assert!(
            first_page < Duration::from_millis(50),
            "the first page took {first_page:?}"
        );
    }

    #[test]
    fn history_entries_record_what_each_subscription_did() {
        let broker = Broker::new();
        create_topic(&broker, ORDERS, None);
        create_topic(&broker, DEAD, None);
        let acked = create_subscription(&broker, "acked", ORDERS, |_| {});
        let dead = create_subscription(&broker, "dead", ORDERS, |subscription| {
            subscription.dead_letter_policy = Some(DeadLetterPolicy {
                dead_letter_topic: DEAD.to_owned(),
                max_delivery_attempts: 5,
            });
        });
        let drained = create_subscription(&broker, "drained", ORDERS, |_| {});
        let filtered = create_subscription(&broker, "filtered", ORDERS, |subscription| {
            subscription.filter = r#"attributes.kind = "other""#.to_owned();
        });
        let waiting = create_subscription(&broker, "waiting", ORDERS, |_| {});
        let (ids, _) = broker
            .publish(ORDERS, vec![message("m", "", Some("order"))])
            .expect("publish");
        let id: u64 = ids[0].parse().expect("id");
        std::thread::sleep(Duration::from_millis(2));
        let later = create_subscription(&broker, "later", ORDERS, |_| {});
        pull_and_ack_all(&broker, &acked);
        for _ in 0..5 {
            let ack_ids = pull_ack_ids(&broker, &dead, 10);
            broker
                .modify_ack_deadline(&dead, &ack_ids, 0)
                .expect("nack");
        }
        broker.drain(&drained);
        let marks: BTreeMap<String, MessageMark> = broker
            .message_marks(ORDERS, id)
            .expect("marks")
            .into_iter()
            .collect();
        assert_eq!(
            marks,
            BTreeMap::from([
                (acked, MessageMark::Acked),
                (dead.clone(), MessageMark::DeadLettered),
                (drained, MessageMark::Drained),
                (filtered, MessageMark::Filtered),
                (waiting, MessageMark::Available),
                (later, MessageMark::NotTracked),
            ])
        );
        assert_eq!(
            broker
                .subscription_counts(&dead)
                .expect("counts")
                .dead_lettered_total,
            1
        );
        // "acked" keeps its acknowledged copy while "waiting" still holds the
        // message; the two outcomes recorded cost eight bytes each in the ring.
        assert_eq!(
            broker.tracked_ids(&marks_name("acked")),
            BTreeMap::from([(id, "acked")])
        );
        let window = broker.history_window(ORDERS).expect("window");
        assert_eq!(window.bytes, 1 + 4 + 5 + 2 * 8);
        broker.check_invariants();
    }
}

/// The scheduler, keyed by function id: pause, run now, runs kept, the
/// phase across reloads and two regions sharing one topic.
mod schedules {
    use firenook_functions_bridge::{
        DispatchRequest, FunctionsInventory, TriggerObserver, TriggerRegistry,
    };
    use time::OffsetDateTime;

    use std::sync::{Arc, Mutex};

    use axum::http::StatusCode;
    use serde_json::json;
    use tower::ServiceExt as _;

    use super::{PROJECT, inventory, publish_request};
    use crate::google::pubsub::v1::{PubsubMessage, Subscription, Topic};
    use crate::{
        LOG_SCHEDULE, Managed, PubsubLogLine, PubsubRuntime, RunScheduleError, RunTrigger,
        ScheduleControl, router,
    };

    const TICK: &str = "us-central1-scheduledTick";
    const EUROPE: &str = "europe-west1-scheduledTick";

    fn topic() -> String {
        format!("projects/{PROJECT}/topics/firebase-schedule-scheduledTick")
    }

    fn published(runtime: &PubsubRuntime) -> u32 {
        runtime
            .broker()
            .history_window(&topic())
            .expect("schedule topic")
            .messages
    }

    fn start(
        inventory: &FunctionsInventory,
    ) -> (
        PubsubRuntime,
        tokio::sync::mpsc::UnboundedReceiver<DispatchRequest>,
        TriggerRegistry,
    ) {
        let background = TriggerRegistry::default();
        let (observer, deliveries) = TriggerObserver::channel(background.clone());
        let runtime = router(PROJECT, inventory, observer.queue(), background.clone());
        (runtime, deliveries, background)
    }

    /// The fixture's inventory with `scheduledTick` also in europe-west1.
    fn two_regions() -> FunctionsInventory {
        let mut inventory = inventory();
        let mut copy = inventory
            .functions()
            .find(|function| function.name == "scheduledTick")
            .expect("scheduledTick")
            .clone();
        copy.id = EUROPE.to_owned();
        copy.region = "europe-west1".to_owned();
        inventory.backends[0].function_triggers.push(copy);
        inventory
    }

    #[tokio::test]
    async fn schedules_pause_run_now_and_report_next() {
        let (runtime, mut deliveries, background) = start(&inventory());
        let view = runtime.schedule_view(TICK).expect("scheduledTick");
        assert_eq!(view.function_name, "scheduledTick");
        assert_eq!(view.region, "us-central1");
        assert_eq!(view.topic, topic());
        assert_eq!(view.expression, "every 5 minutes");
        assert_eq!(view.evaluated_in, "UTC");
        assert!(view.automatic);
        assert_eq!(
            view.next_run_at, None,
            "no clock before the scheduler starts"
        );

        let before = OffsetDateTime::now_utc();
        let due = runtime.schedule_due(TICK).expect("automatic");
        assert!(due >= before + time::Duration::minutes(5));
        assert_eq!(runtime.schedule_view(TICK).unwrap().next_run_at, Some(due));
        let detail = runtime.schedule_detail(TICK).expect("detail");
        assert_eq!(detail.upcoming.len(), 5);
        assert_eq!(
            detail.upcoming[1] - detail.upcoming[0],
            time::Duration::minutes(5)
        );

        // Paused: the clock's tick publishes nothing and moves on.
        ScheduleControl::set_paused(&runtime, TICK, true).expect("pause");
        let revision = runtime.schedule_changes(0).revision;
        runtime.clock_tick(TICK, due);
        assert_eq!(published(&runtime), 0);
        let view = runtime.schedule_view(TICK).unwrap();
        assert!(view.paused);
        assert_eq!(view.runs, 0);
        assert_eq!(view.next_run_at, Some(due + time::Duration::minutes(5)));
        assert_eq!(
            runtime.schedule_changes(revision).changed.len(),
            1,
            "the moved tick is a change"
        );

        // Run now works while paused and records a console run.
        let outcome = ScheduleControl::run(&runtime, TICK).expect("run");
        assert_eq!(published(&runtime), 1);
        let dispatch = deliveries.recv().await.expect("dispatch");
        assert!(dispatch.path.ends_with("/us-central1-scheduledTick-0"));
        let view = ScheduleControl::schedule(&runtime, TICK).unwrap();
        assert_eq!(view.runs, 1);
        let last = view.last_run.expect("last run");
        assert_eq!(last.trigger, RunTrigger::Console);
        assert_eq!(
            last.message_id.as_deref(),
            Some(outcome.message_id.as_str())
        );

        // Background triggers paused: Run now is refused and a clock tick
        // is recorded as skipped.
        background.set_background_enabled(false);
        assert_eq!(
            ScheduleControl::run(&runtime, TICK),
            Err(RunScheduleError::BackgroundPaused)
        );
        assert_eq!(
            runtime.run_schedule(TICK),
            Err(RunScheduleError::BackgroundPaused)
        );
        ScheduleControl::set_paused(&runtime, TICK, false).expect("resume");
        let due = runtime.schedule_due(TICK).expect("due");
        runtime.clock_tick(TICK, due);
        let view = runtime.schedule_view(TICK).unwrap();
        assert_eq!(view.runs, 2);
        let skipped = view.last_run.expect("skipped run");
        assert_eq!(skipped.trigger, RunTrigger::Clock);
        assert_eq!(skipped.message_id, None);
        assert_eq!(
            skipped.skipped.as_deref(),
            Some("Background triggers are paused, so the tick was not published.")
        );
        assert_eq!(published(&runtime), 1);
        background.set_background_enabled(true);

        // A clock tick publishes and records a clock run.
        let due = runtime.schedule_due(TICK).expect("due");
        runtime.clock_tick(TICK, due);
        assert_eq!(published(&runtime), 2);
        let view = runtime.schedule_view(TICK).unwrap();
        assert_eq!(view.last_run.unwrap().trigger, RunTrigger::Clock);
        // A stale tick (the clock moved on) does nothing.
        runtime.clock_tick(TICK, due);
        assert_eq!(published(&runtime), 2);

        // 25 runs: the first, the nineteen latest, and 5 in between.
        for _ in 0..22 {
            runtime.run_schedule(TICK).expect("run");
        }
        let detail = runtime.schedule_detail(TICK).unwrap();
        assert_eq!(detail.view.runs, 25);
        assert_eq!(detail.first_run.unwrap().trigger, RunTrigger::Console);
        assert_eq!(detail.last_runs.len(), 19);
        assert_eq!(detail.omitted_runs, 5);
        assert!(
            detail.last_runs[0].at >= detail.last_runs[18].at,
            "newest first"
        );
        assert_eq!(
            detail.last_runs[0].message_id.as_deref(),
            Some("24"),
            "the newest run published the 24th message (one run was skipped)"
        );
        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn an_unchanged_schedule_keeps_its_phase_across_a_reload() {
        let current = inventory();
        let (mut runtime, _deliveries, _background) = start(&current);
        let mut scheduler = runtime.start_scheduler().expect("scheduler");
        let due = runtime.schedule_due(TICK).expect("due");
        ScheduleControl::set_paused(&runtime, TICK, true).expect("pause");
        runtime.run_schedule(TICK).expect("run");
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;

        runtime
            .refresh_inventory(PROJECT, &current, &mut scheduler)
            .await
            .expect("reload");
        let view = runtime.schedule_view(TICK).unwrap();
        assert_eq!(view.next_run_at, Some(due), "the phase is kept");
        assert!(view.paused, "the pause is kept");
        assert_eq!(view.runs, 1, "the runs are kept");

        // A changed expression starts its clock afresh; pause and runs stay.
        let mut edited = current.clone();
        for function in &mut edited.backends[0].function_triggers {
            if let Some(schedule) = &mut function.schedule {
                schedule.schedule = "every 7 minutes".to_owned();
            }
        }
        let before = OffsetDateTime::now_utc();
        runtime
            .refresh_inventory(PROJECT, &edited, &mut scheduler)
            .await
            .expect("reload");
        let due = runtime.schedule_due(TICK).expect("due");
        assert!(due >= before + time::Duration::minutes(7));
        let view = runtime.schedule_view(TICK).unwrap();
        assert_eq!(view.expression, "every 7 minutes");
        assert!(view.paused);
        assert_eq!(view.runs, 1);

        // A schedule that left is gone, and a live view learns of it.
        let revision = runtime.schedule_changes(0).revision;
        let empty = FunctionsInventory {
            generation: 0,
            backends: Vec::new(),
        };
        runtime
            .refresh_inventory(PROJECT, &empty, &mut scheduler)
            .await
            .expect("reload");
        assert!(runtime.schedule_view(TICK).is_none());
        let changes = runtime.schedule_changes(revision);
        assert!(changes.removed);
        assert!(changes.revision > revision);
        scheduler.shutdown().await;
        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn the_clock_writes_its_next_tick_before_it_sleeps() {
        let (runtime, _deliveries, _background) = start(&inventory());
        let mut watch = runtime.schedule_watch();
        let scheduler = runtime.start_scheduler().expect("scheduler");
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while runtime.schedule_view(TICK).unwrap().next_run_at.is_none() {
                watch.changed().await.expect("watch");
            }
        })
        .await
        .expect("the clock set its next tick");
        scheduler.shutdown().await;
        runtime.shutdown().await;
    }

    /// A user topic with a subscription, messages, a snapshot, a schema and
    /// a refused publish, beside the functions' own topics.
    async fn populate(runtime: &PubsubRuntime) {
        let broker = runtime.broker();
        let orders = format!("projects/{PROJECT}/topics/orders");
        let worker = format!("projects/{PROJECT}/subscriptions/orders-worker");
        let function_topic = format!("projects/{PROJECT}/topics/phase4-topic");
        broker
            .create_topic(Topic {
                name: orders.clone(),
                ..Topic::default()
            })
            .expect("topic");
        broker
            .create_subscription(Subscription {
                name: worker.clone(),
                topic: orders.clone(),
                ..Subscription::default()
            })
            .expect("subscription");
        let message = || PubsubMessage {
            data: b"m".to_vec(),
            ..PubsubMessage::default()
        };
        broker
            .publish(&orders, vec![message(), message(), message()])
            .expect("publish");
        broker
            .publish(&function_topic, vec![message()])
            .expect("publish");
        broker
            .create_snapshot(
                &format!("projects/{PROJECT}/snapshots/before"),
                &worker,
                std::collections::BTreeMap::new(),
            )
            .expect("snapshot");
        broker
            .create_schema(
                &format!("projects/{PROJECT}"),
                "order-schema",
                Some(crate::google::pubsub::v1::Schema {
                    r#type: crate::google::pubsub::v1::schema::Type::Avro as i32,
                    definition: r#"{"type":"record","name":"Order","fields":[{"name":"id","type":"string"}]}"#.to_owned(),
                    ..Default::default()
                }),
            )
            .expect("schema");
        let response = runtime
            .application()
            .oneshot(publish_request(
                "missing",
                &json!({ "messages": [{ "data": "e30=" }] }),
            ))
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn clear_leaves_a_clean_broker_with_function_topics() {
        let (runtime, _deliveries, _background) = start(&inventory());
        populate(&runtime).await;
        let broker = runtime.broker();
        let function_topic = format!("projects/{PROJECT}/topics/phase4-topic");
        let function_subscription =
            format!("projects/{PROJECT}/subscriptions/emulator-sub-phase4-topic");
        let message = || PubsubMessage {
            data: b"m".to_vec(),
            ..PubsubMessage::default()
        };
        let last = runtime.run_schedule(TICK).expect("run").message_id;
        runtime.set_schedule_paused(TICK, true).expect("pause");

        let removed = runtime.reset();
        assert_eq!(removed.broker.topics, 3);
        assert_eq!(removed.broker.subscriptions, 3);
        assert_eq!(removed.broker.snapshots, 1);
        assert_eq!(removed.broker.schemas, 1);
        assert_eq!(removed.broker.messages, 5);
        assert_eq!(
            removed.broker.backlog, 4,
            "orders-worker's three, and the one published past the runtime's fanout"
        );
        assert_eq!(removed.rejections, 1);
        assert_eq!(removed.schedule_runs, 1);

        // Only the functions' own topics and subscriptions, empty.
        let mut topics: Vec<String> = broker
            .resource_ids("topics")
            .into_iter()
            .map(|(_, id)| id)
            .collect();
        topics.sort();
        assert_eq!(topics, ["firebase-schedule-scheduledTick", "phase4-topic"]);
        let mut subscriptions: Vec<String> = broker
            .resource_ids("subscriptions")
            .into_iter()
            .map(|(_, id)| id)
            .collect();
        subscriptions.sort();
        assert_eq!(
            subscriptions,
            [
                "emulator-sub-firebase-schedule-scheduledTick",
                "emulator-sub-phase4-topic"
            ]
        );
        assert_eq!(runtime.managed(&function_subscription), Managed::Functions);
        assert_eq!(broker.history_window(&function_topic).unwrap().messages, 0);
        assert!(
            broker
                .get_snapshot(&format!("projects/{PROJECT}/snapshots/before"))
                .is_err()
        );
        assert!(
            broker
                .get_schema(
                    &format!("projects/{PROJECT}/schemas/order-schema"),
                    crate::google::pubsub::v1::SchemaView::Basic,
                )
                .is_err()
        );
        assert_eq!(runtime.rejected().entries.len(), 0);
        let view = runtime.schedule_view(TICK).expect("schedule");
        assert_eq!(view.runs, 0);
        assert!(view.last_run.is_none());
        assert!(view.paused, "pause flags are kept");
        broker.check_invariants();

        // Message ids keep counting.
        let (ids, _) = broker
            .publish(&function_topic, vec![message()])
            .expect("publish");
        assert!(ids[0].parse::<u64>().unwrap() > last.parse::<u64>().unwrap());
        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn console_views_follow_a_cleared_topic() {
        use crate::broker::inspect::{ConsoleCursor, DeltaScope};
        let (runtime, _deliveries, _background) = start(&inventory());
        let broker = runtime.broker();
        let orders = format!("projects/{PROJECT}/topics/orders");
        let worker = format!("projects/{PROJECT}/subscriptions/orders-worker");
        let make = || {
            broker
                .create_topic(Topic {
                    name: orders.clone(),
                    ..Topic::default()
                })
                .expect("topic");
            broker
                .create_subscription(Subscription {
                    name: worker.clone(),
                    topic: orders.clone(),
                    ..Subscription::default()
                })
                .expect("subscription");
        };
        let message = || PubsubMessage {
            data: b"m".to_vec(),
            ..PubsubMessage::default()
        };
        make();
        let reader = broker.backlog_reader(&worker).expect("reader");
        let scope = DeltaScope {
            project: PROJECT.to_owned(),
            counters: false,
            throughput: Vec::new(),
            topic: Some(orders.clone()),
            subscription: Some(worker.clone()),
            deliveries: true,
            max_changed: 200,
        };
        let mut cursor = ConsoleCursor::default();
        broker
            .publish(&orders, vec![message(), message(), message()])
            .expect("publish");
        let _ = broker.console_delta(&mut cursor, &scope);
        broker.publish(&orders, vec![message()]).expect("publish");
        let delta = broker.console_delta(&mut cursor, &scope);
        assert_eq!(delta.published.expect("published").added, 1);

        // The clear removes both; the view's topic and subscription come
        // back with fewer messages than its cursor counted.
        let _ = runtime.reset();
        make();
        let (ids, _) = broker.publish(&orders, vec![message()]).expect("publish");
        let delta = broker.console_delta(&mut cursor, &scope);
        let published = delta.published.expect("the new message is reported");
        assert_eq!(published.added, 1);
        assert_eq!(published.ids, [ids[0].parse::<u64>().unwrap()]);
        assert!(delta.backlog_reset, "the subscription is a new one");
        // The open view still records the new subscription's moved rows.
        let _ = broker.pull(&worker, 1).expect("pull");
        let delta = broker.console_delta(&mut cursor, &scope);
        assert_eq!(delta.backlog.len(), 2, "old and new key of the leased row");
        drop(reader);
        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn schedule_problems_reach_the_log_sink_with_refs() {
        let broken = |expression: &str| {
            let mut inventory = inventory();
            for function in &mut inventory.backends[0].function_triggers {
                if let Some(schedule) = &mut function.schedule {
                    schedule.schedule = expression.to_owned();
                }
            }
            inventory
        };
        let current = broken("not a schedule");
        let (mut runtime, _deliveries, _background) = start(&current);
        let lines: Arc<Mutex<Vec<PubsubLogLine>>> = Arc::default();
        let sink_lines = Arc::clone(&lines);
        runtime.set_log_sink(Arc::new(move |line| {
            sink_lines.lock().expect("lines").push(line);
        }));
        let expected = PubsubLogLine {
            level: "WARN",
            kind: LOG_SCHEDULE,
            text: format!(
                "schedule of {TICK} not run automatically (unsupported Firebase schedule expression: not a schedule); run it from the console or through the Functions trigger route"
            ),
            topic: Some(topic()),
            subscription: None,
            function_id: Some(TICK.to_owned()),
        };
        assert_eq!(*lines.lock().unwrap(), [expected], "found before the sink");

        // The same problem after a reload is not logged again; a new one is.
        let mut scheduler = runtime.start_scheduler().expect("scheduler");
        runtime
            .refresh_inventory(PROJECT, &current, &mut scheduler)
            .await
            .expect("reload");
        assert_eq!(lines.lock().unwrap().len(), 1);
        runtime
            .refresh_inventory(PROJECT, &broken("every day 25:00"), &mut scheduler)
            .await
            .expect("reload");
        let lines = lines.lock().unwrap().clone();
        assert_eq!(lines.len(), 2);
        assert_eq!(
            lines[1].text,
            format!(
                "schedule of {TICK} not run automatically (invalid schedule time of day: 25:00); run it from the console or through the Functions trigger route"
            )
        );
        scheduler.shutdown().await;
        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn schedules_are_keyed_by_function_id() {
        let (runtime, mut deliveries, _background) = start(&two_regions());
        let us = runtime.schedule_view(TICK).expect("us-central1");
        let europe = runtime.schedule_view(EUROPE).expect("europe-west1");
        assert_eq!(us.topic, europe.topic);
        assert_eq!(us.shares_topic_with, [EUROPE]);
        assert_eq!(europe.shares_topic_with, [TICK]);
        assert_eq!(europe.region, "europe-west1");
        assert_eq!(runtime.schedules_view().len(), 2);

        // Run now through either id publishes once to the shared topic,
        // which reaches both functions.
        let control: std::sync::Arc<dyn ScheduleControl> = std::sync::Arc::new(runtime.clone());
        control.run(EUROPE).expect("run");
        assert_eq!(published(&runtime), 1);
        let mut paths = [
            deliveries.recv().await.expect("first").path,
            deliveries.recv().await.expect("second").path,
        ];
        paths.sort();
        assert!(paths[0].ends_with("/europe-west1-scheduledTick-0"));
        assert!(paths[1].ends_with("/us-central1-scheduledTick-0"));
        assert_eq!(control.schedule(EUROPE).unwrap().runs, 1);
        assert_eq!(control.schedule(TICK).unwrap().runs, 0);

        // Pausing one leaves the other's clock running.
        control.set_paused(TICK, true).expect("pause");
        assert!(!control.schedule(EUROPE).unwrap().paused);
        let due = runtime.schedule_due(EUROPE).expect("due");
        runtime.clock_tick(EUROPE, due);
        assert_eq!(published(&runtime), 2);
        let due = runtime.schedule_due(TICK).expect("due");
        runtime.clock_tick(TICK, due);
        assert_eq!(published(&runtime), 2);

        // Unknown ids.
        assert!(control.schedule("us-central1-nope").is_none());
        assert_eq!(
            control.set_paused("us-central1-nope", true),
            Err(RunScheduleError::NotScheduled)
        );
        assert_eq!(
            control.run("us-central1-nope"),
            Err(RunScheduleError::NotScheduled)
        );
        runtime.shutdown().await;
    }
}

/// What the console reads and does: push streaks, consumers, the console
/// delta, console actions, history and backlog pages, refusals, function
/// fanout and redelivery.
mod console {
    use std::collections::BTreeMap;
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant, SystemTime};

    use axum::body::Body;
    use axum::http::{Request as HttpRequest, StatusCode};
    use firenook_functions_bridge::{DispatchRequest, TriggerObserver, TriggerRegistry};
    use serde_json::{Value as JsonValue, json};
    use tower::ServiceExt as _;

    use super::{PROJECT, inventory, publish_request};
    use crate::broker::inspect::{
        BacklogState, Comparison, ConsoleCursor, DeltaScope, MessageClause, MessageFlag,
        MessageQuery, MessageTerm, PayloadEncoding, payload_preview,
    };
    use crate::broker::{
        Broker, ConsumerCounts, ConsumerKind, FanoutSkip, HistoryLimits, MessageMark, ResourceKind,
        visits,
    };
    use crate::filter::Filter;
    use crate::google::pubsub::v1::publisher_server::Publisher as _;
    use crate::google::pubsub::v1::{
        DeadLetterPolicy, PublishRequest, PubsubMessage, PushConfig, Subscription, Topic,
    };
    use crate::runtime::{PushOutcome, PushStreaks};
    use crate::{
        LOG_PUSH, OutgoingMessage, PubsubLogLine, PubsubRuntime, PushStreakRecord, RedeliverError,
        router,
    };

    const ORDERS: &str = "projects/p/topics/orders";
    const DEAD: &str = "projects/p/topics/orders-dead";

    fn topic(broker: &Broker, name: &str, retention: Option<i64>) {
        broker
            .create_topic(Topic {
                name: name.to_owned(),
                message_retention_duration: retention
                    .map(|seconds| pbjson_types::Duration { seconds, nanos: 0 }),
                ..Topic::default()
            })
            .expect("topic");
    }

    fn subscription(
        broker: &Broker,
        id: &str,
        topic: &str,
        configure: impl FnOnce(&mut Subscription),
    ) -> String {
        let name = format!("projects/p/subscriptions/{id}");
        let mut subscription = Subscription {
            name: name.clone(),
            topic: topic.to_owned(),
            ..Subscription::default()
        };
        configure(&mut subscription);
        broker
            .create_subscription(subscription)
            .expect("subscription");
        name
    }

    fn message(data: &str) -> PubsubMessage {
        PubsubMessage {
            data: data.as_bytes().to_vec(),
            ..PubsubMessage::default()
        }
    }

    fn publish(broker: &Broker, topic: &str, messages: Vec<PubsubMessage>) -> Vec<u64> {
        broker
            .publish(topic, messages)
            .expect("publish")
            .0
            .iter()
            .map(|id| id.parse().expect("id"))
            .collect()
    }

    fn publish_many(broker: &Broker, topic: &str, count: usize) -> Vec<u64> {
        let mut ids = Vec::with_capacity(count);
        let mut remaining = count;
        while remaining > 0 {
            let batch = remaining.min(1_000);
            ids.extend(publish(
                broker,
                topic,
                (0..batch)
                    .map(|index| message(&format!("m{index}")))
                    .collect(),
            ));
            remaining -= batch;
        }
        ids
    }

    fn ack_ids(broker: &Broker, subscription: &str, max: i32) -> Vec<String> {
        broker
            .pull(subscription, max)
            .expect("pull")
            .into_iter()
            .map(|received| received.ack_id)
            .collect()
    }

    fn query(terms: Vec<MessageTerm>) -> MessageQuery {
        MessageQuery {
            clauses: terms
                .into_iter()
                .map(|term| MessageClause {
                    any: vec![term],
                    negated: false,
                })
                .collect(),
            expr: None,
        }
    }

    fn page_ids(page: &crate::broker::inspect::HistoryPage) -> Vec<u64> {
        page.rows.iter().map(|row| row.message.id).collect()
    }

    #[test]
    #[allow(clippy::too_many_lines)]
    fn push_attempts_are_counted_apart_and_coalesced() {
        // Three failed pushes, then the subscription is switched to pull with
        // a dead-letter policy: deliveries count from one, as if never pushed.
        let broker = Broker::new();
        topic(&broker, ORDERS, None);
        topic(&broker, DEAD, None);
        let pushed = subscription(&broker, "pushed", ORDERS, |subscription| {
            subscription.push_config = Some(PushConfig {
                push_endpoint: "http://127.0.0.1:9/push".to_owned(),
                ..PushConfig::default()
            });
        });
        let id = publish(&broker, ORDERS, vec![message("m")])[0];
        let mut attempts = Vec::new();
        for round in 0..3_u64 {
            let jobs = broker.tick_at(Instant::now() + Duration::from_secs(2 * round));
            assert_eq!(jobs.len(), 1);
            attempts.push(jobs[0].attempt);
            broker.push_finished(&jobs[0], false);
        }
        assert_eq!(attempts, vec![1, 2, 3]);
        broker
            .modify_push_config(&pushed, Some(PushConfig::default()))
            .expect("switch to pull");
        broker
            .update_subscription(
                Some(Subscription {
                    name: pushed.clone(),
                    dead_letter_policy: Some(DeadLetterPolicy {
                        dead_letter_topic: DEAD.to_owned(),
                        max_delivery_attempts: 5,
                    }),
                    ..Subscription::default()
                }),
                &["dead_letter_policy".to_owned()],
            )
            .expect("dead letter policy");
        for attempt in 1..=5 {
            let received = broker.pull(&pushed, 10).expect("pull");
            assert_eq!(received.len(), 1);
            assert_eq!(received[0].delivery_attempt, attempt);
            assert_eq!(
                broker
                    .subscription_counts(&pushed)
                    .expect("counts")
                    .dead_lettered_total,
                0
            );
            broker
                .modify_ack_deadline(&pushed, &[received[0].ack_id.clone()], 0)
                .expect("nack");
        }
        assert_eq!(
            broker
                .subscription_counts(&pushed)
                .expect("counts")
                .dead_lettered_total,
            1
        );
        let view = broker.message_view(ORDERS, id).expect("view");
        assert_eq!(view.subscriptions[0].mark, MessageMark::DeadLettered);

        // 312 failures of one message, a second apart: one streak, at most
        // six records a minute; a 200 then ends it and starts another.
        let mut streaks = PushStreaks::default();
        let started = Instant::now();
        let failure = PushOutcome {
            status: Some(500),
            error: None,
            latency: Duration::from_millis(18),
        };
        let mut emitted: Vec<(u64, PushStreakRecord)> = Vec::new();
        for attempt in 1..=312_u32 {
            let second = u64::from(attempt - 1);
            let records = streaks.record(
                "sub",
                7,
                attempt,
                &failure,
                Some("{\"error\":\"db locked\"}".to_owned()),
                started + Duration::from_secs(second),
                SystemTime::now(),
            );
            emitted.extend(records.into_iter().map(|record| (second, record)));
        }
        let current = streaks.current("sub", 7).expect("one streak");
        assert_eq!(
            (current.count, current.first_attempt, current.last_attempt),
            (312, 1, 312)
        );
        assert!(
            emitted
                .iter()
                .all(|(_, record)| record.streak == current.streak)
        );
        for window in 0..=252_u64 {
            let in_window = emitted
                .iter()
                .filter(|(second, _)| (window..window + 60).contains(second))
                .count();
            assert!(
                in_window <= 6,
                "{in_window} records in the minute from {window} s"
            );
        }
        let success = PushOutcome {
            status: Some(200),
            error: None,
            latency: Duration::from_millis(21),
        };
        let records = streaks.record(
            "sub",
            7,
            313,
            &success,
            None,
            started + Duration::from_secs(312),
            SystemTime::now(),
        );
        assert_eq!(records.len(), 2);
        assert_eq!(
            (records[0].streak.as_str(), records[0].count),
            (current.streak.as_str(), 312)
        );
        assert_eq!(
            (
                records[1].status,
                records[1].count,
                records[1].first_attempt
            ),
            (Some(200), 1, 313)
        );
        assert_ne!(records[1].streak, current.streak);
        assert_eq!(streaks.current("sub", 7), None);
    }

    #[tokio::test]
    async fn a_push_endpoint_reaches_the_sink_with_its_outcomes() {
        // An endpoint that fails twice, then accepts.
        let calls = Arc::new(Mutex::new(0_u32));
        let counted = Arc::clone(&calls);
        let endpoint = axum::Router::new().route(
            "/push",
            axum::routing::post(move || {
                let counted = Arc::clone(&counted);
                async move {
                    let mut calls = counted.lock().expect("calls");
                    *calls += 1;
                    if *calls <= 2 {
                        (
                            StatusCode::INTERNAL_SERVER_ERROR,
                            "{\"error\":\"db locked\"}",
                        )
                    } else {
                        (StatusCode::OK, "")
                    }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("listener");
        let address = listener.local_addr().expect("address");
        let server = tokio::spawn(async move {
            let _ = axum::serve(listener, endpoint).await;
        });
        let background = TriggerRegistry::default();
        let (observer, _deliveries) = TriggerObserver::channel(background.clone());
        let runtime = router(PROJECT, &inventory(), observer.queue(), background);
        let records: Arc<Mutex<Vec<PushStreakRecord>>> = Arc::default();
        let sink_records = Arc::clone(&records);
        runtime.set_push_sink(Arc::new(move |record| {
            sink_records.lock().expect("records").push(record);
        }));
        let lines: Arc<Mutex<Vec<PubsubLogLine>>> = Arc::default();
        let sink_lines = Arc::clone(&lines);
        runtime.set_log_sink(Arc::new(move |line| {
            sink_lines.lock().expect("lines").push(line);
        }));
        let broker = runtime.broker();
        topic(broker, ORDERS, None);
        let pushed = subscription(broker, "pushed", ORDERS, |subscription| {
            subscription.push_config = Some(PushConfig {
                push_endpoint: format!("http://{address}/push"),
                ..PushConfig::default()
            });
        });
        let id = publish(broker, ORDERS, vec![message("m")])[0];
        let deadline = Instant::now() + Duration::from_secs(10);
        while broker
            .subscription_counts(&pushed)
            .expect("counts")
            .acked_total
            == 0
        {
            assert!(Instant::now() < deadline, "the push never succeeded");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let records = records.lock().expect("records").clone();
        let failures: Vec<&PushStreakRecord> = records
            .iter()
            .filter(|record| record.status == Some(500))
            .collect();
        let latest_failure = failures.last().expect("the failing streak");
        assert_eq!(latest_failure.message_id, id);
        assert_eq!(latest_failure.count, 2);
        assert_eq!(
            latest_failure.response.as_deref(),
            Some("{\"error\":\"db locked\"}")
        );
        let delivered = records
            .iter()
            .find(|record| record.status == Some(200))
            .expect("the delivered streak");
        assert_eq!(delivered.first_attempt, 3);
        assert_ne!(delivered.streak, latest_failure.streak);
        // The failing streak logged once, with its subscription and topic.
        let lines = lines.lock().expect("lines").clone();
        assert_eq!(lines.len(), 1, "{lines:?}");
        assert_eq!(lines[0].kind, LOG_PUSH);
        assert_eq!(lines[0].level, "WARN");
        assert_eq!(lines[0].subscription.as_deref(), Some(pushed.as_str()));
        assert_eq!(lines[0].topic.as_deref(), Some(ORDERS));
        assert_eq!(
            lines[0].text,
            format!(
                "push of message {id} to http://{address}/push answered 500; the emulator retries every second until the endpoint answers 2xx"
            )
        );
        runtime.shutdown().await;
        server.abort();
    }

    #[test]
    fn consumers_count_streaming_and_waiting_pulls() {
        let broker = Broker::new();
        topic(&broker, ORDERS, None);
        let worker = subscription(&broker, "worker", ORDERS, |_| {});
        let mut changed = broker.watch();
        changed.borrow_and_update();
        let mut console = broker.console_watch();
        console.borrow_and_update();
        let first = broker.consumer_guard(&worker, ConsumerKind::Streaming);
        let second = broker.consumer_guard(&worker, ConsumerKind::Streaming);
        let waiting = broker.consumer_guard(&worker, ConsumerKind::Waiting);
        assert_eq!(
            broker.consumers(&worker),
            ConsumerCounts {
                streaming: 2,
                waiting: 1
            }
        );
        drop(first);
        drop(waiting);
        assert_eq!(
            broker.consumers(&worker),
            ConsumerCounts {
                streaming: 1,
                waiting: 0
            }
        );
        drop(second);
        assert_eq!(broker.consumers(&worker), ConsumerCounts::default());
        let before = SystemTime::now();
        assert_eq!(broker.pull(&worker, 1).expect("pull").len(), 0);
        let view = broker.subscription_view(&worker).expect("view");
        assert!(
            view.summary
                .counters
                .last_pull_at
                .is_some_and(|at| at >= before)
        );
        assert!(
            !changed.has_changed().expect("watch"),
            "a consumer woke subscribers"
        );
        assert!(console.has_changed().expect("watch"));
    }

    #[test]
    #[allow(clippy::too_many_lines)]
    fn console_delta_reports_only_what_changed() {
        let broker = Broker::new();
        let other = "projects/p/topics/payments";
        topic(&broker, ORDERS, None);
        topic(&broker, other, None);
        let worker = subscription(&broker, "worker", ORDERS, |_| {});
        subscription(&broker, "ledger", other, |_| {});
        let index = broker.topics_index("p");
        assert_eq!(index.topics.len(), 2);
        let scope = DeltaScope {
            project: "p".to_owned(),
            counters: true,
            throughput: vec![ORDERS.to_owned()],
            topic: Some(ORDERS.to_owned()),
            subscription: Some(worker.clone()),
            deliveries: false,
            max_changed: 200,
        };
        let _reader = broker.backlog_reader(&worker).expect("reader");
        let mut counters = ConsoleCursor::at(index.revision);
        let first = broker.console_delta(&mut counters, &scope);
        assert!(first.is_empty(), "{first:?}");

        let ids = publish(
            &broker,
            ORDERS,
            vec![message("a"), message("b"), message("c")],
        );
        publish(&broker, other, vec![message("x"), message("y")]);
        let delta = broker.console_delta(&mut counters, &scope);
        let topics: Vec<&str> = delta
            .topics
            .iter()
            .map(|topic| topic.name.as_str())
            .collect();
        assert_eq!(topics, vec![ORDERS, other]);
        let orders = &delta.topics[0];
        assert_eq!(orders.published, 3);
        assert_eq!(orders.latest_id, Some(ids[2]));
        assert_eq!(
            orders
                .most_behind
                .as_ref()
                .map(|most| (most.subscription.as_str(), most.backlog)),
            Some((worker.as_str(), 3))
        );
        let published = delta.published.expect("new ids of the scoped topic");
        assert_eq!(published.ids, vec![ids[2], ids[1], ids[0]]);
        assert_eq!(published.added, 3);
        assert!(!published.overflow);
        assert_eq!(delta.throughput.len(), 1);
        let (_, window) = &delta.throughput[0];
        assert_eq!(
            window.buckets.iter().map(|(_, count)| count).sum::<u32>(),
            3
        );
        assert!(window.buckets.len() <= 2, "sparse: {:?}", window.buckets);
        assert_eq!(delta.backlog.len(), 3, "three new rows");
        assert_eq!(delta.resources.len(), 0);

        // A pull moves one row: its old and new keys, and the counters.
        assert_eq!(broker.pull(&worker, 1).expect("pull").len(), 1);
        let delta = broker.console_delta(&mut counters, &scope);
        assert_eq!(delta.backlog.len(), 2);
        assert!(delta.backlog.iter().all(|key| key.id == ids[0]));
        assert_eq!(delta.subscriptions.len(), 1);
        assert_eq!(delta.subscriptions[0].counts.outstanding, 1);
        assert!(delta.published.is_none());

        // A schema is a resource change and nothing else.
        broker
            .create_schema(
                "projects/p",
                "order-schema",
                Some(crate::google::pubsub::v1::Schema {
                    r#type: crate::google::pubsub::v1::schema::Type::Avro as i32,
                    definition: r#"{"type":"record","name":"Order","fields":[{"name":"id","type":"string"}]}"#.to_owned(),
                    ..Default::default()
                }),
            )
            .expect("schema");
        let delta = broker.console_delta(&mut counters, &scope);
        assert_eq!(delta.resources, vec![ResourceKind::Schemas]);
        assert!(delta.topics.is_empty() && delta.subscriptions.is_empty());

        // Past the cap the delta says so instead of listing.
        let tight = DeltaScope {
            max_changed: 1,
            ..scope.clone()
        };
        publish(&broker, ORDERS, vec![message("d")]);
        publish(&broker, other, vec![message("z")]);
        let delta = broker.console_delta(&mut counters, &tight);
        assert!(delta.overflow);
        assert_eq!(delta.topics.len(), 0);
        let delta = broker.console_delta(&mut counters, &scope);
        assert!(delta.topics.is_empty() && !delta.overflow);
    }

    #[test]
    fn force_ack_and_release_follow_the_engine_rules() {
        let broker = Broker::new();
        topic(&broker, ORDERS, None);
        topic(&broker, DEAD, None);
        let worker = subscription(&broker, "worker", ORDERS, |subscription| {
            subscription.dead_letter_policy = Some(DeadLetterPolicy {
                dead_letter_topic: DEAD.to_owned(),
                max_delivery_attempts: 5,
            });
        });
        let id = publish(&broker, ORDERS, vec![message("m")])[0];
        assert_eq!(
            broker.release(&worker, id).expect_err("not leased").code,
            tonic::Code::FailedPrecondition
        );
        for attempt in 1..=5 {
            let received = broker.pull(&worker, 1).expect("pull");
            assert_eq!(received[0].delivery_attempt, attempt);
            broker.release(&worker, id).expect("release");
        }
        assert_eq!(
            broker
                .subscription_counts(&worker)
                .expect("counts")
                .dead_lettered_total,
            1
        );
        assert_eq!(
            broker.force_ack(&worker, id).expect_err("gone").code,
            tonic::Code::NotFound
        );

        // A console ack makes the app's own ack stale.
        let once = subscription(&broker, "once", ORDERS, |subscription| {
            subscription.enable_exactly_once_delivery = true;
        });
        let id = publish(&broker, ORDERS, vec![message("n")])[0];
        let held = ack_ids(&broker, &once, 1);
        broker.force_ack(&once, id).expect("console ack");
        let stale = broker.acknowledge(&once, &held).expect_err("stale");
        assert_eq!(
            (stale.code, stale.message.as_str()),
            (tonic::Code::InvalidArgument, "")
        );
        let counts = broker.subscription_counts(&once).expect("counts");
        assert_eq!((counts.outstanding, counts.acked_total), (0, 1));
        broker.check_invariants();
    }

    #[test]
    #[allow(clippy::too_many_lines)]
    fn history_pages_are_stable_and_filtered_outside_the_lock() {
        let broker = Broker::new();
        topic(&broker, ORDERS, None);
        let ids = publish_many(&broker, ORDERS, 250);
        let all = MessageQuery::default();
        let first = broker
            .history_page(ORDERS, &all, None, None, 100)
            .expect("page");
        assert_eq!(
            page_ids(&first),
            ids[150..].iter().rev().copied().collect::<Vec<_>>()
        );
        assert_eq!((first.total, first.exact), (250, true));
        // New publishes do not shift the pages that follow.
        publish_many(&broker, ORDERS, 10);
        let second = broker
            .history_page(ORDERS, &all, first.next_cursor, None, 100)
            .expect("page");
        assert_eq!(
            page_ids(&second),
            ids[50..150].iter().rev().copied().collect::<Vec<_>>()
        );
        let third = broker
            .history_page(ORDERS, &all, second.next_cursor, None, 100)
            .expect("page");
        assert_eq!(
            page_ids(&third),
            ids[..50].iter().rev().copied().collect::<Vec<_>>()
        );
        assert_eq!(third.next_cursor, None);
        let above = broker
            .history_page(ORDERS, &all, None, second.prev_cursor, 100)
            .expect("page");
        assert_eq!(
            page_ids(&above),
            ids[150..250].iter().rev().copied().collect::<Vec<_>>()
        );

        // Terms that read no data, words, and the filter expression.
        let broker = Broker::new();
        topic(&broker, ORDERS, None);
        let attributes = |pairs: &[(&str, &str)]| -> BTreeMap<String, String> {
            pairs
                .iter()
                .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
                .collect()
        };
        let keyed = publish(
            &broker,
            ORDERS,
            vec![
                PubsubMessage {
                    data: b"{\"order\":\"Big Coffee\"}".to_vec(),
                    ordering_key: "cust-7".to_owned(),
                    attributes: attributes(&[("region", "eu")]),
                    ..PubsubMessage::default()
                },
                PubsubMessage {
                    data: b"plain tea".to_vec(),
                    attributes: attributes(&[
                        ("region", "us"),
                        ("CloudPubSubDeadLetterSourceSubscription", "w"),
                    ]),
                    ..PubsubMessage::default()
                },
                PubsubMessage {
                    data: vec![0xff, 0xfe, 0x00],
                    ordering_key: "cust-8".to_owned(),
                    ..PubsubMessage::default()
                },
            ],
        );
        let find = |query: &MessageQuery| -> Vec<u64> {
            page_ids(
                &broker
                    .history_page(ORDERS, query, None, None, 100)
                    .expect("page"),
            )
        };
        assert_eq!(
            find(&query(vec![MessageTerm::Id(Comparison::Gt, keyed[0])])),
            vec![keyed[2], keyed[1]]
        );
        assert_eq!(
            find(&query(vec![MessageTerm::Key {
                value: "cust-".to_owned(),
                prefix: true
            }])),
            vec![keyed[2], keyed[0]]
        );
        assert_eq!(
            find(&query(vec![MessageTerm::Attribute {
                key: "region".to_owned(),
                comparison: Comparison::Eq,
                value: "eu".to_owned(),
                prefix: false
            }])),
            vec![keyed[0]]
        );
        assert_eq!(
            find(&query(vec![MessageTerm::Flag(MessageFlag::DeadLettered)])),
            vec![keyed[1]]
        );
        assert_eq!(
            find(&query(vec![MessageTerm::Flag(MessageFlag::Binary)])),
            vec![keyed[2]]
        );
        assert_eq!(
            find(&query(vec![MessageTerm::Flag(MessageFlag::Json)])),
            vec![keyed[0]]
        );
        assert_eq!(
            find(&query(vec![MessageTerm::Word("coffee".to_owned())])),
            vec![keyed[0]]
        );
        let negated = MessageQuery {
            clauses: vec![MessageClause {
                any: vec![MessageTerm::Flag(MessageFlag::Key)],
                negated: true,
            }],
            expr: None,
        };
        assert_eq!(find(&negated), vec![keyed[1]]);
        let expression = MessageQuery {
            clauses: Vec::new(),
            expr: Some(
                Filter::parse(r#"attributes.region = "us" OR attributes.region = "eu""#)
                    .expect("filter"),
            ),
        };
        assert_eq!(find(&expression), vec![keyed[1], keyed[0]]);

        // A word search examines 20,000 messages per request and continues
        // where it stopped; its count is a floor until then.
        let broker = Broker::new();
        topic(&broker, ORDERS, Some(3_600));
        publish_many(&broker, ORDERS, 30_000);
        let nothing = query(vec![MessageTerm::Word("absent".to_owned())]);
        let _ = visits::take();
        let partial = broker
            .history_page(ORDERS, &nothing, None, None, 100)
            .expect("page");
        assert_eq!(partial.rows.len(), 0);
        assert!(!partial.exact);
        assert_eq!(partial.scanned, Some(20_000));
        let seen = visits::take();
        assert_eq!(seen.scanned, 20_000);
        assert_eq!(
            seen.locks, 2,
            "the lock is taken for the pointer copy and the rows only"
        );
        let rest = broker
            .history_page(ORDERS, &nothing, partial.next_cursor, None, 100)
            .expect("page");
        assert!(rest.exact);
        assert_eq!((rest.total, rest.next_cursor), (0, None));
        assert_eq!(visits::take().scanned, 10_000);
        // New publishes extend the remembered search instead of rescanning.
        publish_many(&broker, ORDERS, 5);
        let refreshed = broker
            .history_page(ORDERS, &nothing, None, None, 100)
            .expect("page");
        assert!(refreshed.exact);
        assert_eq!(visits::take().scanned, 5);

        // The byte budget: data checks stop after 64 MiB.
        let broker = Broker::new();
        topic(&broker, ORDERS, Some(3_600));
        for _ in 0..70 {
            publish(
                &broker,
                ORDERS,
                vec![PubsubMessage {
                    data: vec![b'x'; 1 << 20],
                    ..PubsubMessage::default()
                }],
            );
        }
        let json = query(vec![MessageTerm::Flag(MessageFlag::Json)]);
        let page = broker
            .history_page(ORDERS, &json, None, None, 100)
            .expect("page");
        assert!(!page.exact);
        assert_eq!(page.scanned, Some(64));
    }

    #[test]
    fn previews_show_json_text_or_base64() {
        let json = payload_preview(b"{ \"a\" : [1, 2] }");
        assert_eq!(
            (json.encoding, json.text.as_str(), json.truncated),
            (PayloadEncoding::Json, "{\"a\":[1,2]}", false)
        );
        let text = payload_preview("é".repeat(300).as_bytes());
        assert_eq!(text.encoding, PayloadEncoding::Text);
        assert_eq!(text.text.chars().count(), 256);
        assert!(text.truncated);
        let binary = payload_preview(&[0xff; 200]);
        assert_eq!(binary.encoding, PayloadEncoding::Binary);
        assert!(binary.truncated);
        assert_eq!(binary.text.len(), 256);
    }

    #[test]
    #[allow(clippy::too_many_lines)]
    fn backlog_pages_follow_the_delivery_order() {
        let broker = Broker::new();
        topic(&broker, ORDERS, None);
        let worker = subscription(&broker, "worker", ORDERS, |_| {});
        let ids = publish_many(&broker, ORDERS, 5);
        let held = ack_ids(&broker, &worker, 2);
        // The first is nacked: it queues behind the later ones.
        broker
            .modify_ack_deadline(&worker, &held[..1], 0)
            .expect("nack");
        let page = broker
            .backlog_page(&worker, None, None, None, 100)
            .expect("page");
        let order: Vec<(u64, BacklogState, Option<u64>)> = page
            .rows
            .iter()
            .map(|row| (row.message.id, row.state, row.place))
            .collect();
        assert_eq!(
            order,
            vec![
                (ids[1], BacklogState::Outstanding, None),
                (ids[2], BacklogState::Available, Some(1)),
                (ids[3], BacklogState::Available, Some(2)),
                (ids[4], BacklogState::Available, Some(3)),
                (ids[0], BacklogState::Available, Some(4)),
            ]
        );
        assert_eq!(page.total, 5);
        assert!(page.rows[0].lease_expires_at.is_some());
        assert_eq!(page.rows[4].attempts, 1);
        // The next pull takes them in exactly that order.
        let next: Vec<u64> = broker
            .pull(&worker, 4)
            .expect("pull")
            .iter()
            .map(|received| {
                received
                    .message
                    .as_ref()
                    .expect("message")
                    .message_id
                    .parse()
                    .expect("id")
            })
            .collect();
        assert_eq!(next, vec![ids[2], ids[3], ids[4], ids[0]]);

        // Pages by cursor, forward and back, never repeat or skip a row.
        let broker = Broker::new();
        topic(&broker, ORDERS, None);
        let worker = subscription(&broker, "worker", ORDERS, |_| {});
        publish_many(&broker, ORDERS, 9);
        let _ = ack_ids(&broker, &worker, 3);
        let full: Vec<u64> = broker
            .backlog_page(&worker, None, None, None, 100)
            .expect("page")
            .rows
            .iter()
            .map(|row| row.message.id)
            .collect();
        let mut walked = Vec::new();
        let mut places = Vec::new();
        let mut cursor = None;
        let mut pages = Vec::new();
        loop {
            let page = broker
                .backlog_page(&worker, None, cursor, None, 2)
                .expect("page");
            walked.extend(page.rows.iter().map(|row| row.message.id));
            places.extend(page.rows.iter().filter_map(|row| row.place));
            pages.push(page.rows.first().map(|row| row.message.id));
            match page.next_cursor {
                Some(next) => cursor = Some(next),
                None => break,
            }
        }
        assert_eq!(walked, full);
        assert_eq!(places, (1..=6).collect::<Vec<u64>>());
        let last = broker
            .backlog_page(&worker, None, cursor, None, 2)
            .expect("page");
        let back = broker
            .backlog_page(&worker, None, None, last.prev_cursor, 2)
            .expect("page");
        let back_ids: Vec<u64> = back.rows.iter().map(|row| row.message.id).collect();
        // The last page is the ninth row; the page before it is the two rows above.
        assert_eq!(back_ids, full[6..8].to_vec());
        assert_eq!(
            back.rows
                .iter()
                .filter_map(|row| row.place)
                .collect::<Vec<_>>(),
            vec![4, 5]
        );
        let available = broker
            .backlog_page(&worker, Some(BacklogState::Available), None, None, 100)
            .expect("page");
        assert_eq!(available.total, 6);
        assert!(
            available
                .rows
                .iter()
                .all(|row| row.state == BacklogState::Available)
        );

        // An ordering key held by an outstanding message blocks the rest of
        // its key, as the next pull decides; a batch read follows moves.
        let broker = Broker::new();
        topic(&broker, ORDERS, None);
        let ordered = subscription(&broker, "ordered", ORDERS, |subscription| {
            subscription.enable_message_ordering = true;
        });
        let keyed = publish(
            &broker,
            ORDERS,
            vec![
                PubsubMessage {
                    data: b"1".to_vec(),
                    ordering_key: "k".to_owned(),
                    ..PubsubMessage::default()
                },
                PubsubMessage {
                    data: b"2".to_vec(),
                    ordering_key: "k".to_owned(),
                    ..PubsubMessage::default()
                },
            ],
        );
        let before = broker
            .backlog_page(&ordered, None, None, None, 100)
            .expect("page");
        let first_key = before.rows[0].key;
        let held = ack_ids(&broker, &ordered, 1);
        assert_eq!(held.len(), 1);
        let page = broker
            .backlog_page(&ordered, None, None, None, 100)
            .expect("page");
        let waiting = page
            .rows
            .iter()
            .find(|row| row.message.id == keyed[1])
            .expect("the second message");
        assert_eq!(waiting.blocked_by, Some(keyed[0]));
        let moved = page.rows[0].key;
        let rows = broker.backlog_rows(&ordered, &[first_key, moved]);
        assert!(rows[0].is_none(), "the old position is gone");
        assert_eq!(rows[1].as_ref().map(|row| row.message.id), Some(keyed[0]));
    }

    #[tokio::test]
    #[allow(clippy::too_many_lines)]
    async fn a_pull_never_wakes_itself() {
        use crate::google::pubsub::v1::subscriber_client::SubscriberClient;
        use crate::google::pubsub::v1::{PullRequest, StreamingPullRequest};

        let background = TriggerRegistry::default();
        let (observer, _deliveries) = TriggerObserver::channel(background.clone());
        let runtime = router(PROJECT, &inventory(), observer.queue(), background);
        let broker = runtime.broker().clone();
        let orders = format!("projects/{PROJECT}/topics/orders");
        topic(&broker, &orders, None);
        let streaming = format!("projects/{PROJECT}/subscriptions/streaming");
        let polling = format!("projects/{PROJECT}/subscriptions/polling");
        for name in [&streaming, &polling] {
            broker
                .create_subscription(Subscription {
                    name: name.clone(),
                    topic: orders.clone(),
                    ..Subscription::default()
                })
                .expect("subscription");
        }
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("listener");
        let address = listener.local_addr().expect("address");
        let server = tokio::spawn(
            tonic::transport::Server::builder()
                .accept_http1(true)
                .add_routes(runtime.routes())
                .serve_with_incoming(tonic::transport::server::TcpIncoming::from(listener)),
        );
        // A console view following the counters the whole time.
        let reader_broker = broker.clone();
        let reader = tokio::spawn(async move {
            let mut watch = reader_broker.console_watch();
            let mut cursor = ConsoleCursor::default();
            let scope = DeltaScope {
                project: PROJECT.to_owned(),
                counters: true,
                max_changed: 200,
                ..DeltaScope::default()
            };
            while watch.changed().await.is_ok() {
                let _ = reader_broker.console_delta(&mut cursor, &scope);
            }
        });
        let channel = tonic::transport::Endpoint::from_shared(format!("http://{address}"))
            .expect("endpoint")
            .connect()
            .await
            .expect("channel");
        let mut stream_client = SubscriberClient::new(channel.clone());
        let (requests, receiver) = tokio::sync::mpsc::channel(4);
        requests
            .send(StreamingPullRequest {
                subscription: streaming.clone(),
                stream_ack_deadline_seconds: 10,
                ..StreamingPullRequest::default()
            })
            .await
            .expect("first request");
        let _ = visits::take();
        let mut stream = stream_client
            .streaming_pull(tokio_stream::wrappers::ReceiverStream::new(receiver))
            .await
            .expect("stream")
            .into_inner();
        let mut poll_client = SubscriberClient::new(channel);
        let poll_subscription = polling.clone();
        let poll = tokio::spawn(async move {
            let mut request = tonic::Request::new(PullRequest {
                subscription: poll_subscription,
                max_messages: 10,
                ..PullRequest::default()
            });
            request.set_timeout(Duration::from_secs(20));
            poll_client.pull(request).await
        });
        tokio::time::sleep(Duration::from_secs(2)).await;
        let pulls = visits::take().pulls;
        assert!(pulls <= 4, "{pulls} pulls in 2 s on an empty subscription");
        assert_eq!(
            broker.consumers(&streaming),
            ConsumerCounts {
                streaming: 1,
                waiting: 0
            }
        );
        assert_eq!(broker.consumers(&polling).waiting, 1);
        // A publish still wakes both at once.
        broker
            .publish(&orders, vec![message("wake")])
            .expect("publish");
        let streamed = tokio::time::timeout(Duration::from_secs(5), stream.message())
            .await
            .expect("the stream woke")
            .expect("stream")
            .expect("a response");
        assert_eq!(streamed.received_messages.len(), 1);
        let pulled = tokio::time::timeout(Duration::from_secs(5), poll)
            .await
            .expect("the long poll woke")
            .expect("task")
            .expect("pull");
        assert_eq!(pulled.into_inner().received_messages.len(), 1);
        drop(requests);
        reader.abort();
        server.abort();
        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn refused_requests_are_kept_and_coalesced() {
        let background = TriggerRegistry::default();
        let (observer, _deliveries) = TriggerObserver::channel(background.clone());
        let runtime = router(PROJECT, &inventory(), observer.queue(), background);
        let broker = runtime.broker();
        topic(broker, &format!("projects/{PROJECT}/topics/orders"), None);
        topic(broker, "projects/demo-elsewhere/topics/payments", None);
        let missing = format!("projects/{PROJECT}/topics/order");
        let status = runtime
            .publish(tonic::Request::new(PublishRequest {
                topic: missing.clone(),
                messages: vec![message("m")],
            }))
            .await
            .expect_err("no such topic");
        assert_eq!(status.code(), tonic::Code::NotFound);
        let response = runtime
            .application()
            .oneshot(publish_request(
                "order",
                &json!({ "messages": [{ "data": "e30=" }] }),
            ))
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let response = runtime
            .application()
            .oneshot(publish_request(
                "payments",
                &json!({ "messages": [{ "data": "e30=" }] }),
            ))
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        // The console's own publish is not an app's refusal.
        assert!(
            runtime
                .publish_from_console(
                    &missing,
                    vec![OutgoingMessage {
                        data: b"m".to_vec(),
                        ..OutgoingMessage::default()
                    }]
                )
                .is_err()
        );
        let pull = HttpRequest::post(format!("/v1/projects/{PROJECT}/subscriptions/workers:pull"))
            .header("content-type", "application/json")
            .body(Body::from(r#"{"maxMessages":1,"returnImmediately":true}"#))
            .expect("pull request");
        let response = runtime.application().oneshot(pull).await.expect("response");
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let rejected = runtime.rejected();
        assert_eq!(rejected.entries.len(), 3);
        let order = &rejected.entries[0];
        assert_eq!(
            (
                order.operation,
                order.resource.as_str(),
                order.count,
                order.code
            ),
            ("publish", missing.as_str(), 2, "NOT_FOUND")
        );
        assert_eq!(order.error, "Topic not found");
        assert_eq!(order.suggestion.as_deref(), Some("orders"));
        let payments = &rejected.entries[1];
        assert_eq!(payments.elsewhere.as_deref(), Some("demo-elsewhere"));
        assert_eq!(payments.suggestion, None);
        assert_eq!(rejected.entries[2].operation, "pull");

        for index in 0..201 {
            let _ = runtime
                .publish(tonic::Request::new(PublishRequest {
                    topic: format!("projects/{PROJECT}/topics/missing-{index}"),
                    messages: vec![message("m")],
                }))
                .await;
        }
        let rejected = runtime.rejected();
        assert_eq!(rejected.entries.len(), 200);
        assert_eq!(rejected.dropped, 4);
        runtime.shutdown().await;
    }

    fn deliveries_runtime() -> (
        PubsubRuntime,
        tokio::sync::mpsc::UnboundedReceiver<DispatchRequest>,
        TriggerRegistry,
    ) {
        let background = TriggerRegistry::default();
        let (observer, deliveries) = TriggerObserver::channel(background.clone());
        let runtime = router(PROJECT, &inventory(), observer.queue(), background.clone());
        (runtime, deliveries, background)
    }

    fn without_times(body: &[u8]) -> JsonValue {
        let mut value: JsonValue = serde_json::from_slice(body).expect("JSON body");
        value["time"] = JsonValue::Null;
        value["data"]["message"]["publishTime"] = JsonValue::Null;
        value["data"]["message"]["publish_time"] = JsonValue::Null;
        value
    }

    #[tokio::test]
    async fn redeliver_reaches_one_function_with_a_fresh_event_id() {
        let (runtime, mut deliveries, _background) = deliveries_runtime();
        let topic = format!("projects/{PROJECT}/topics/phase4-topic");
        let outcome = runtime
            .publish_from_console(
                &topic,
                vec![OutgoingMessage {
                    data: b"{\"n\":1}".to_vec(),
                    ..OutgoingMessage::default()
                }],
            )
            .expect("publish");
        assert_eq!(
            (
                outcome.functions,
                outcome.functions_skipped,
                outcome.subscriptions
            ),
            (1, 0, 0)
        );
        let id: u64 = outcome.ids[0].parse().expect("id");
        let original = deliveries.recv().await.expect("dispatch");
        let function = "us-central1-topicEcho";
        let first = runtime.redeliver(&topic, id, function).expect("redeliver");
        let second = runtime.redeliver(&topic, id, function).expect("redeliver");
        assert_ne!(first, second);
        assert_ne!(first, original.event_id);
        for event in [&first, &second] {
            let dispatch = deliveries.recv().await.expect("redelivery");
            assert_eq!(&dispatch.event_id, event);
            assert!(dispatch.path.ends_with("/us-central1-topicEcho-0"));
        }
        assert!(
            deliveries.try_recv().is_err(),
            "only that function, only twice"
        );
        let fanout = runtime
            .broker()
            .message_view(&topic, id)
            .expect("view")
            .fanout
            .expect("fanout");
        let targets: Vec<(&str, bool)> = fanout
            .targets
            .iter()
            .map(|target| (target.event_id.as_str(), target.redelivery))
            .collect();
        assert_eq!(
            targets,
            vec![
                (original.event_id.as_str(), false),
                (first.as_str(), true),
                (second.as_str(), true)
            ]
        );
        let preview = runtime
            .dispatch_preview(&topic, id, function)
            .expect("preview");
        assert_eq!(preview.content_type, original.headers["content-type"]);
        assert_eq!(without_times(&preview.body), without_times(&original.body));
        assert_eq!(
            runtime.redeliver(&topic, id, "us-central1-other"),
            Err(RedeliverError::NotATarget)
        );
        assert_eq!(
            runtime.redeliver(&topic, id + 100, function),
            Err(RedeliverError::MessageNotKept)
        );
        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn a_paused_background_switch_records_skipped_targets() {
        let (runtime, mut deliveries, background) = deliveries_runtime();
        background.set_background_enabled(false);
        let topic = format!("projects/{PROJECT}/topics/phase4-topic");
        let response = runtime
            .application()
            .oneshot(publish_request(
                "phase4-topic",
                &json!({ "messages": [{ "data": "e30=" }] }),
            ))
            .await
            .expect("publish");
        assert_eq!(response.status(), StatusCode::OK);
        assert!(
            deliveries.try_recv().is_err(),
            "nothing reaches the delivery queue"
        );
        let page = runtime
            .broker()
            .history_page(&topic, &MessageQuery::default(), None, None, 10)
            .expect("page");
        let fanout = page.rows[0].fanout.clone().expect("fanout");
        assert_eq!(fanout.skipped, Some(FanoutSkip::BackgroundOff));
        assert_eq!(fanout.targets.len(), 1);
        assert_eq!(fanout.targets[0].function_id, "us-central1-topicEcho");
        assert_eq!(
            runtime.redeliver(&topic, page.rows[0].message.id, "us-central1-topicEcho"),
            Err(RedeliverError::BackgroundPaused)
        );
        let outcome = runtime
            .publish_from_console(
                &topic,
                vec![OutgoingMessage {
                    data: b"{}".to_vec(),
                    ..OutgoingMessage::default()
                }],
            )
            .expect("publish");
        assert_eq!((outcome.functions, outcome.functions_skipped), (1, 1));
        runtime.shutdown().await;
    }

    #[test]
    fn history_limits_are_the_documented_ones() {
        let limits = HistoryLimits::default();
        assert_eq!(
            (
                limits.messages,
                limits.bytes,
                limits.retention_messages,
                limits.retention_bytes,
                limits.total_bytes
            ),
            (5_000, 16 << 20, 100_000, 256 << 20, 512 << 20)
        );
    }
}

/// The console's diagnostics: filter positions, schema reasons and paths,
/// JSON written as Avro binary, examples and templates.
mod diagnostics {
    use std::collections::BTreeMap;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    use crate::avro::{
        definition_problem, encode_json, example_json, explain_json, parse_definition,
        validate_binary, validate_json,
    };
    use crate::filter::Filter;
    use crate::templates::{Draft, DraftData, TemplateError, expand, prepare, prepare_all};

    /// The matcher the wire used before `explain_json`, kept verbatim so
    /// the rewrite is held to the same answers.
    mod reference {
        use apache_avro::Schema;
        use apache_avro::schema::{Name, ResolvedSchema};
        use serde_json::Value as JsonValue;

        pub(super) fn accepts(schema: &Schema, message: &[u8]) -> bool {
            let Ok(value) = serde_json::from_slice::<JsonValue>(message) else {
                return false;
            };
            let Ok(resolved) = ResolvedSchema::try_from(schema) else {
                return false;
            };
            matches_json(schema, &value, &resolved, None)
        }

        fn matches_json(
            schema: &Schema,
            value: &JsonValue,
            resolved: &ResolvedSchema<'_>,
            namespace: Option<&str>,
        ) -> bool {
            match schema {
                Schema::Null => value.is_null(),
                Schema::Boolean => value.is_boolean(),
                Schema::Int | Schema::Date | Schema::TimeMillis => value
                    .as_i64()
                    .is_some_and(|number| i32::try_from(number).is_ok()),
                Schema::Long
                | Schema::TimeMicros
                | Schema::TimestampMillis
                | Schema::TimestampMicros
                | Schema::TimestampNanos
                | Schema::LocalTimestampMillis
                | Schema::LocalTimestampMicros
                | Schema::LocalTimestampNanos => value.as_i64().is_some(),
                Schema::Float | Schema::Double => value.is_number(),
                Schema::Bytes
                | Schema::String
                | Schema::BigDecimal
                | Schema::Uuid(_)
                | Schema::Decimal(_) => value.is_string(),
                Schema::Duration(fixed) | Schema::Fixed(fixed) => value
                    .as_str()
                    .is_some_and(|text| text.chars().count() == fixed.size),
                Schema::Array(array) => value.as_array().is_some_and(|items| {
                    items
                        .iter()
                        .all(|item| matches_json(&array.items, item, resolved, namespace))
                }),
                Schema::Map(map) => value.as_object().is_some_and(|entries| {
                    entries
                        .values()
                        .all(|item| matches_json(&map.types, item, resolved, namespace))
                }),
                Schema::Union(union) => {
                    if value.is_null() {
                        return union
                            .variants()
                            .iter()
                            .any(|variant| matches!(variant, Schema::Null));
                    }
                    let Some(object) = value.as_object() else {
                        return false;
                    };
                    if object.len() != 1 {
                        return false;
                    }
                    let (branch, inner) = object.iter().next().expect("one entry");
                    union.variants().iter().any(|variant| {
                        json_type_name(variant, resolved, namespace)
                            .is_some_and(|name| name == *branch)
                            && matches_json(variant, inner, resolved, namespace)
                    })
                }
                Schema::Record(record) => {
                    let Some(object) = value.as_object() else {
                        return false;
                    };
                    let record_namespace = record
                        .name
                        .namespace()
                        .map(str::to_owned)
                        .or_else(|| namespace.map(str::to_owned));
                    let scope = record_namespace.as_deref();
                    if object.len() != record.fields.len() {
                        return false;
                    }
                    record.fields.iter().all(|field| {
                        object
                            .get(&field.name)
                            .is_some_and(|item| matches_json(&field.schema, item, resolved, scope))
                    })
                }
                Schema::Enum(symbols) => value
                    .as_str()
                    .is_some_and(|text| symbols.symbols.iter().any(|symbol| symbol == text)),
                Schema::Ref { name } => {
                    let Some(target) = lookup(name, resolved, namespace) else {
                        return false;
                    };
                    matches_json(target, value, resolved, namespace)
                }
            }
        }

        fn lookup<'s>(
            name: &Name,
            resolved: &ResolvedSchema<'s>,
            namespace: Option<&str>,
        ) -> Option<&'s Schema> {
            let full = name.fullname(namespace);
            resolved
                .get_names()
                .iter()
                .find(|(candidate, _)| {
                    candidate.fullname(None) == full || candidate.name() == name.name()
                })
                .map(|(_, schema)| *schema)
        }

        /// The union branch label a JSON value carries for `schema`.
        fn json_type_name(
            schema: &Schema,
            resolved: &ResolvedSchema<'_>,
            namespace: Option<&str>,
        ) -> Option<String> {
            Some(match schema {
                Schema::Null => "null".to_owned(),
                Schema::Boolean => "boolean".to_owned(),
                Schema::Int | Schema::Date | Schema::TimeMillis => "int".to_owned(),
                Schema::Long
                | Schema::TimeMicros
                | Schema::TimestampMillis
                | Schema::TimestampMicros
                | Schema::TimestampNanos
                | Schema::LocalTimestampMillis
                | Schema::LocalTimestampMicros
                | Schema::LocalTimestampNanos => "long".to_owned(),
                Schema::Float => "float".to_owned(),
                Schema::Double => "double".to_owned(),
                Schema::Bytes | Schema::BigDecimal | Schema::Decimal(_) => "bytes".to_owned(),
                Schema::String | Schema::Uuid(_) => "string".to_owned(),
                Schema::Array(_) => "array".to_owned(),
                Schema::Map(_) => "map".to_owned(),
                Schema::Union(_) => return None,
                Schema::Record(record) => record.name.fullname(namespace),
                Schema::Enum(symbols) => symbols.name.fullname(namespace),
                Schema::Fixed(fixed) | Schema::Duration(fixed) => fixed.name.fullname(namespace),
                Schema::Ref { name } => {
                    let target = lookup(name, resolved, namespace)?;
                    return json_type_name(target, resolved, namespace);
                }
            })
        }
    }

    const READING: &str = r#"{"type":"record","name":"Reading","fields":[{"name":"sensor","type":"string"},{"name":"value","type":"double"}]}"#;
    const ORDER: &str = r#"{"type":"record","name":"Order","namespace":"shop","fields":[
        {"name":"id","type":"string"},
        {"name":"customer","type":{"type":"record","name":"Customer","fields":[{"name":"name","type":"string"},{"name":"vip","type":"boolean"}]}},
        {"name":"items","type":{"type":"array","items":{"type":"record","name":"Item","fields":[{"name":"sku","type":"string"},{"name":"price","type":"double"},{"name":"count","type":"int"}]}}},
        {"name":"tags","type":{"type":"map","values":"string"}},
        {"name":"note","type":["null","string"]},
        {"name":"status","type":{"type":"enum","name":"Status","symbols":["NEW","PAID","SHIPPED"]}},
        {"name":"hash","type":{"type":"fixed","name":"Hash","size":4}},
        {"name":"day","type":{"type":"int","logicalType":"date"}},
        {"name":"at","type":{"type":"long","logicalType":"timestamp-millis"}},
        {"name":"total","type":{"type":"bytes","logicalType":"decimal","precision":8,"scale":2}},
        {"name":"ref","type":{"type":"string","logicalType":"uuid"}}
    ]}"#;
    const NODE: &str = r#"{"type":"record","name":"Node","fields":[{"name":"value","type":"int"},{"name":"next","type":["null","Node"]}]}"#;
    const ENVELOPE: &str = r#"{"type":"record","name":"Envelope","namespace":"com.example","fields":[
        {"name":"inner","type":{"type":"record","name":"Inner","fields":[{"name":"id","type":"long"}]}},
        {"name":"kind","type":{"type":"enum","name":"Kind","symbols":["A","B"]}},
        {"name":"choice","type":["Inner","string"]}
    ]}"#;
    const NUMBERS: &str = r#"{"type":"array","items":{"type":"map","values":"int"}}"#;
    const CHOICE: &str = r#"["null","int","string"]"#;

    const GOOD_ORDER: &str = r#"{"id":"o-1","customer":{"name":"Ada","vip":true},"items":[{"sku":"a","price":2.5,"count":2}],"tags":{"channel":"web"},"note":{"string":"leave at door"},"status":"PAID","hash":"abcd","day":20000,"at":1728000000000,"total":"\u0001","ref":"00000000-0000-4000-8000-000000000000"}"#;

    #[allow(clippy::too_many_lines)]
    fn corpus() -> Vec<(&'static str, String)> {
        let order = |change: &dyn Fn(&mut serde_json::Value)| {
            let mut value: serde_json::Value = serde_json::from_str(GOOD_ORDER).expect("order");
            change(&mut value);
            value.to_string()
        };
        vec![
            (READING, r#"{"sensor":"s1","value":1.5}"#.to_owned()),
            (READING, r#"{"sensor":"s1","value":2}"#.to_owned()),
            (READING, r#"{"sensor":1,"value":1.5}"#.to_owned()),
            (READING, r#"{"sensor":"s1"}"#.to_owned()),
            (
                READING,
                r#"{"sensor":"s1","value":1.5,"extra":true}"#.to_owned(),
            ),
            (READING, "not json".to_owned()),
            (READING, "[]".to_owned()),
            (ORDER, GOOD_ORDER.to_owned()),
            (
                ORDER,
                order(&|value| value["note"] = serde_json::Value::Null),
            ),
            (
                ORDER,
                order(&|value| value["note"] = serde_json::json!("plain")),
            ),
            (
                ORDER,
                order(&|value| value["note"] = serde_json::json!({"int": 1})),
            ),
            (
                ORDER,
                order(&|value| value["items"][0]["price"] = serde_json::json!("free")),
            ),
            (
                ORDER,
                order(&|value| value["items"][0]["count"] = serde_json::json!(3_000_000_000_u64)),
            ),
            (
                ORDER,
                order(&|value| value["items"] = serde_json::json!([])),
            ),
            (
                ORDER,
                order(&|value| value["tags"] = serde_json::json!({"a": 1})),
            ),
            (
                ORDER,
                order(&|value| value["status"] = serde_json::json!("LOST")),
            ),
            (
                ORDER,
                order(&|value| value["hash"] = serde_json::json!("abc")),
            ),
            (ORDER, order(&|value| value["day"] = serde_json::json!(1.5))),
            (
                ORDER,
                order(&|value| value["at"] = serde_json::json!("now")),
            ),
            (
                ORDER,
                order(&|value| value["customer"]["vip"] = serde_json::json!("yes")),
            ),
            (
                ORDER,
                order(&|value| {
                    value.as_object_mut().expect("object").remove("ref");
                }),
            ),
            (ORDER, order(&|value| value["total"] = serde_json::json!(1))),
            (NODE, r#"{"value":1,"next":null}"#.to_owned()),
            (
                NODE,
                r#"{"value":1,"next":{"Node":{"value":2,"next":null}}}"#.to_owned(),
            ),
            (
                NODE,
                r#"{"value":1,"next":{"Node":{"value":"two","next":null}}}"#.to_owned(),
            ),
            (
                NODE,
                r#"{"value":1,"next":{"Leaf":{"value":2}}}"#.to_owned(),
            ),
            (
                ENVELOPE,
                r#"{"inner":{"id":1},"kind":"A","choice":{"com.example.Inner":{"id":2}}}"#
                    .to_owned(),
            ),
            (
                ENVELOPE,
                r#"{"inner":{"id":1},"kind":"B","choice":{"string":"x"}}"#.to_owned(),
            ),
            (
                ENVELOPE,
                r#"{"inner":{"id":1},"kind":"C","choice":{"string":"x"}}"#.to_owned(),
            ),
            (
                ENVELOPE,
                r#"{"inner":{"id":1},"kind":"A","choice":{"Inner":{"id":2}}}"#.to_owned(),
            ),
            (NUMBERS, r#"[{"a":1},{"b":2,"c":3}]"#.to_owned()),
            (NUMBERS, r#"[{"a":1},{"b":"two"}]"#.to_owned()),
            (NUMBERS, r"[[1]]".to_owned()),
            (CHOICE, "null".to_owned()),
            (CHOICE, r#"{"int":7}"#.to_owned()),
            (CHOICE, r#"{"string":"x"}"#.to_owned()),
            (CHOICE, "7".to_owned()),
            (CHOICE, r#"{"int":7,"string":"x"}"#.to_owned()),
            (r#""string""#, r#""x""#.to_owned()),
            (r#""long""#, "12.5".to_owned()),
        ]
    }

    #[test]
    fn filter_check_reports_the_position() {
        let syntax = Filter::check("attributes.k = ").expect_err("no value");
        assert_eq!(syntax.position, 15);
        assert_eq!(syntax.message, "Expected a quoted value after =.");
        let syntax = Filter::check(r#"data = "x""#).expect_err("data");
        assert_eq!(syntax.position, 0);
        assert!(
            syntax.message.contains("attributes only"),
            "{}",
            syntax.message
        );
        let syntax = Filter::check(r#"attributes.k = "x" attributes.j = "y""#).expect_err("no AND");
        assert_eq!(syntax.position, 19);
        let syntax = Filter::check(r#"(attributes.k = "x""#).expect_err("open group");
        assert_eq!(syntax.position, 19);
        let syntax = Filter::check(r#"attributes.k = "x"#).expect_err("open string");
        assert_eq!(syntax.position, 15);
        // Offsets count UTF-16 units, as the browser does: the emoji is two.
        let syntax = Filter::check("attributes.k = \"😀\" x").expect_err("trailing word");
        assert_eq!(syntax.position, 20);
        let syntax = Filter::check("attributes.é😀").expect_err("not a key character");
        assert_eq!(syntax.position, 12);
        assert!(
            Filter::check(r#"attributes.k = "x" AND NOT hasPrefix(attributes.sku, "t")"#).is_ok()
        );
        // The wire's answer is the recorded application error, whatever the reason.
        for text in ["attributes.k = ", r#"data = "x""#, "", "attributes.k = \"x"] {
            let error = Filter::parse(text).expect_err("refused");
            assert_eq!(error.message, "Application error processing RPC");
            assert_eq!(error.code, tonic::Code::Unknown);
        }
    }

    #[test]
    fn explain_json_agrees_with_validate_json() {
        let corpus = corpus();
        assert_eq!(corpus.len(), 40);
        for (definition, message) in &corpus {
            let schema = parse_definition(definition).expect("definition");
            let explained = explain_json(&schema, message.as_bytes());
            assert_eq!(
                explained.is_ok(),
                validate_json(&schema, message.as_bytes()).is_ok(),
                "{message}"
            );
            assert_eq!(
                explained.is_ok(),
                reference::accepts(&schema, message.as_bytes()),
                "the rewrite changed the wire's answer for {message}"
            );
        }
        let path = |definition: &str, message: &str| {
            let schema = parse_definition(definition).expect("definition");
            explain_json(&schema, message.as_bytes()).expect_err("refused")
        };
        let order = |change: &dyn Fn(&mut serde_json::Value)| {
            let mut value: serde_json::Value = serde_json::from_str(GOOD_ORDER).expect("order");
            change(&mut value);
            value.to_string()
        };
        let cases = [
            (
                READING,
                r#"{"sensor":1,"value":1.5}"#.to_owned(),
                "$.sensor",
            ),
            (READING, r#"{"sensor":"s1"}"#.to_owned(), "$.value"),
            (
                READING,
                r#"{"sensor":"s1","value":1.5,"extra":true}"#.to_owned(),
                "$.extra",
            ),
            (READING, "not json".to_owned(), "$"),
            (
                ORDER,
                order(&|value| value["items"][0]["price"] = serde_json::json!("free")),
                "$.items[0].price",
            ),
            (
                ORDER,
                order(&|value| value["note"] = serde_json::json!({"int": 1})),
                "$.note",
            ),
            (
                ORDER,
                order(&|value| value["tags"] = serde_json::json!({"a": 1})),
                "$.tags.a",
            ),
            (
                ORDER,
                order(&|value| value["status"] = serde_json::json!("LOST")),
                "$.status",
            ),
            (
                NODE,
                r#"{"value":1,"next":{"Node":{"value":"two","next":null}}}"#.to_owned(),
                "$.next.Node.value",
            ),
            (NUMBERS, r#"[{"a":1},{"b":"two"}]"#.to_owned(), "$[1].b"),
        ];
        for (definition, message, expected) in cases {
            assert_eq!(path(definition, &message).path, expected, "{message}");
        }
        let problem = path(
            ORDER,
            &order(&|value| value["status"] = serde_json::json!("LOST")),
        );
        assert_eq!(problem.expected, "one of NEW, PAID, SHIPPED");
        assert_eq!(problem.found, "string \"LOST\"");
        let problem = path(READING, r#"{"sensor":"s1"}"#);
        assert!(problem.found.starts_with("nothing"), "{}", problem.found);
    }

    #[test]
    fn encode_json_round_trips_through_validate_binary() {
        for (definition, message) in [
            (READING, r#"{"sensor":"s1","value":1.5}"#),
            (ORDER, GOOD_ORDER),
            (
                NODE,
                r#"{"value":1,"next":{"Node":{"value":2,"next":{"Node":{"value":3,"next":null}}}}}"#,
            ),
            (
                ENVELOPE,
                r#"{"inner":{"id":1},"kind":"B","choice":{"com.example.Inner":{"id":2}}}"#,
            ),
            (CHOICE, r#"{"string":"x"}"#),
            (NUMBERS, r#"[{"a":1},{"b":2}]"#),
        ] {
            let schema = parse_definition(definition).expect("definition");
            let binary = encode_json(&schema, message.as_bytes()).expect("encoded");
            validate_binary(&schema, &binary).expect("the binary decodes");
        }
        // Reading (s1, 1.5) as the binary encoding writes it.
        let schema = parse_definition(READING).expect("definition");
        assert_eq!(
            encode_json(&schema, br#"{"sensor":"s1","value":1.5}"#).expect("encoded"),
            vec![4, b's', b'1', 0, 0, 0, 0, 0, 0, 248, 63]
        );
        let problem = encode_json(&schema, br#"{"sensor":1,"value":1.5}"#).expect_err("refused");
        assert_eq!(problem.path, "$.sensor");
    }

    #[test]
    fn definition_problem_names_the_reason() {
        assert_eq!(definition_problem(READING), None);
        let missing = definition_problem(r#"{"type":"record","fields":[]}"#).expect("refused");
        assert!(
            missing.reason.to_lowercase().contains("name"),
            "{}",
            missing.reason
        );
        assert_eq!((missing.line, missing.column), (None, None));
        let syntax =
            definition_problem("{\n  \"type\": \"record\",\n  \"name\": }").expect("refused");
        assert_eq!((syntax.line, syntax.column), (Some(3), Some(11)));
        assert!(!syntax.reason.contains("line"), "{}", syntax.reason);
        let empty = definition_problem("  ").expect("refused");
        assert_eq!(empty.reason, "The definition is empty.");
        // The wire keeps its fixed answer.
        assert_eq!(
            parse_definition(r#"{"type":"record","fields":[]}"#)
                .expect_err("refused")
                .message,
            "Could not parse schema definition"
        );
    }

    #[test]
    fn templates_and_examples_come_from_the_engine() {
        let now = UNIX_EPOCH + Duration::from_millis(1_728_000_000_123);
        let draft = Draft {
            data: DraftData::Json(
                r#"{"n":{{i}},"id":"{{uuid}}","at":"{{now}}","ts":{{ts}}}"#.to_owned(),
            ),
            attributes: BTreeMap::from([("batch".to_owned(), "b-{{i}}".to_owned())]),
            ordering_key: "{{i}}".to_owned(),
        };
        let first = expand(&draft, 1, now).expect("expanded");
        let DraftData::Json(text) = &first.data else {
            panic!("JSON stays JSON");
        };
        let value: serde_json::Value = serde_json::from_str(text).expect("valid JSON");
        assert_eq!(value["n"], 1);
        assert_eq!(value["at"], "2024-10-04T00:00:00.123Z");
        assert_eq!(value["ts"], 1_728_000_000_123_u64);
        assert_eq!(first.attributes["batch"], "b-1");
        assert_eq!(
            first.ordering_key, "{{i}}",
            "the ordering key is not a template"
        );
        let messages =
            prepare_all(&[draft.clone(), draft.clone(), draft], now, true, None).expect("prepared");
        let ids: Vec<String> = messages
            .iter()
            .map(|message| {
                let value: serde_json::Value = serde_json::from_slice(&message.data).expect("JSON");
                value["id"].as_str().expect("uuid").to_owned()
            })
            .collect();
        assert_eq!(ids.len(), 3);
        assert!(ids[0] != ids[1] && ids[1] != ids[2] && ids[0] != ids[2]);
        assert!(ids.iter().all(|id| id.len() == 36 && &id[14..15] == "4"));
        assert_eq!(messages[2].attributes["batch"], "b-3");

        // JSON that breaks only once expanded says so, against message 1.
        let broken = Draft {
            data: DraftData::Json(r#"{"n": {{i}}x}"#.to_owned()),
            attributes: BTreeMap::new(),
            ordering_key: String::new(),
        };
        let error = prepare(&broken, 1, now, true, None).expect_err("invalid after expansion");
        assert!(
            matches!(
                error,
                TemplateError::InvalidJson {
                    message: 1,
                    expanded: true,
                    ..
                }
            ),
            "{error:?}"
        );
        assert!(
            error
                .to_string()
                .starts_with("Message 1 is not valid JSON after expansion")
        );
        let unknown = Draft {
            data: DraftData::Text("{{nope}}".to_owned()),
            attributes: BTreeMap::new(),
            ordering_key: String::new(),
        };
        assert!(matches!(
            expand(&unknown, 1, now),
            Err(TemplateError::UnknownPlaceholder { .. })
        ));
        // Without the template switch the text is sent as written.
        let literal = prepare(&unknown, 1, now, false, None).expect("literal");
        assert_eq!(literal.data, b"{{nope}}");

        // Avro JSON for a binary topic, written through the schema.
        let schema = parse_definition(READING).expect("definition");
        let avro = Draft {
            data: DraftData::AvroJson(r#"{"sensor":"s{{i}}","value":1.5}"#.to_owned()),
            attributes: BTreeMap::new(),
            ordering_key: String::new(),
        };
        let encoded = prepare(&avro, 1, now, true, Some(&schema)).expect("encoded");
        validate_binary(&schema, &encoded.data).expect("binary");
        assert!(matches!(
            prepare(&avro, 1, now, true, None),
            Err(TemplateError::NoSchema)
        ));

        // Examples pass the wire's own check, for every kind of type.
        for definition in [READING, ORDER, NODE, ENVELOPE, NUMBERS, CHOICE] {
            let schema = parse_definition(definition).expect("definition");
            let example = example_json(&schema).expect("an example");
            explain_json(&schema, example.as_bytes()).expect("accepted");
            validate_json(&schema, example.as_bytes()).expect("accepted by the wire");
        }
        let schema = parse_definition(ORDER).expect("definition");
        let example: serde_json::Value =
            serde_json::from_str(&example_json(&schema).expect("example")).expect("JSON");
        assert_eq!(example["status"], "NEW");
        assert_eq!(example["note"], serde_json::json!({"string": "note"}));
        assert_eq!(example["hash"], "aaaa");
        let impossible = parse_definition(
            r#"{"type":"record","name":"Loop","fields":[{"name":"again","type":"Loop"}]}"#,
        );
        if let Ok(schema) = impossible {
            assert!(example_json(&schema).is_err());
        }
        let _ = SystemTime::now();
    }
}
