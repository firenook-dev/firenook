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
