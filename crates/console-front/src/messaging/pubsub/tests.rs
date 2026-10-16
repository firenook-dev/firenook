//! Pub/Sub's console routes against a real runtime: resources, publishing,
//! messages and their actions, subscriptions, backlogs, deliveries,
//! schemas, filters, schedules, setup, search, jobs, limits and lists.

#![allow(
    clippy::too_many_lines,
    reason = "each test walks one scenario end to end against a real runtime"
)]

use std::fmt::Write as _;
use std::time::{Duration, Instant};

use axum::http::{Method, StatusCode};
use firenook_functions_runtime::monitor::FunctionKind;
use firenook_functions_runtime::{Monitor, MonitorLimits};
use serde_json::{Value, json};
use tower::ServiceExt as _;

use super::filters::MESSAGE_FIELDS;
use super::*;
use crate::messaging::tests::{
    ORDERS, PROJECT, SCHEDULE_TOPIC, Suite, begin_dispatch, create_subscription, create_topic,
    finish_invocation, publish, suite,
};
use crate::search::SearchSource as _;

const AVRO: &str = r#"{"type":"record","name":"Order","fields":[{"name":"id","type":"string"},{"name":"total","type":"double"}]}"#;
const AVRO_2: &str = r#"{"type":"record","name":"Order","fields":[{"name":"id","type":"string"},{"name":"total","type":"double"},{"name":"note","type":["null","string"],"default":null}]}"#;
const AVRO_3: &str = r#"{"type":"record","name":"Order","fields":[{"name":"id","type":"string"},{"name":"total","type":"double"},{"name":"note","type":["null","string"],"default":null},{"name":"tag","type":["null","string"],"default":null}]}"#;

fn topic_name(id: &str) -> String {
    format!("projects/{PROJECT}/topics/{id}")
}

fn subscription_name(id: &str) -> String {
    format!("projects/{PROJECT}/subscriptions/{id}")
}

fn encoded(text: &str) -> String {
    url_encode(text)
}

/// Percent-encodes a query value.
fn url_encode(text: &str) -> String {
    let mut out = String::new();
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.~".contains(&byte) {
            out.push(char::from(byte));
        } else {
            let _ = write!(out, "%{byte:02X}");
        }
    }
    out
}

// ------------------------------------------------------------ R-CF-04

#[tokio::test]
async fn pubsub_through_the_console() {
    let suite = suite(None);
    let invoices = topic_name("invoices");
    // A topic with its default subscription.
    let (status, created) = suite
        .call(
            Method::POST,
            "/api/v1/pubsub/topics",
            Some(json!({ "name": invoices, "labels": { "team": "billing" }, "defaultSubscription": true })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    assert_eq!(created["id"], "invoices");
    assert_eq!(created["kind"], "user");
    assert_eq!(created["subscriptions"][0]["id"], "invoices-sub");
    assert_eq!(created["subscriptions"][0]["delivery"], "pull");
    // The index lists it, the function's topic with its target, and the
    // schedule's topic.
    let (_, index) = suite.call(Method::GET, "/api/v1/pubsub/topics", None).await;
    assert_eq!(index["project"], PROJECT);
    assert_eq!(index["total"]["count"], 3);
    let orders = index["items"]
        .as_array()
        .expect("items")
        .iter()
        .find(|topic| topic["name"] == ORDERS)
        .expect("orders")
        .clone();
    assert_eq!(
        orders["functions"][0]["functionId"],
        "us-central1-onOrderPlaced"
    );
    assert_eq!(
        orders["functions"][0]["entity"]["kind"],
        "functions.function"
    );
    assert_eq!(orders["subscriptions"][0]["managed"], "functions");
    let schedule = index["items"]
        .as_array()
        .expect("items")
        .iter()
        .find(|topic| topic["name"] == SCHEDULE_TOPIC)
        .expect("schedule topic")
        .clone();
    assert_eq!(schedule["kind"], "schedule");
    assert_eq!(schedule["scheduleFunction"], "us-central1-nightlyCleanup");

    // Publish JSON with attributes; the preview first.
    let message = json!({ "data": { "json": "{\"n\":{{i}}}" }, "attributes": { "region": "eu" } });
    let (status, preview) = suite
        .call(
            Method::POST,
            "/api/v1/pubsub/topic/publish",
            Some(json!({ "topic": invoices, "messages": [message], "template": true, "dryRun": true })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    assert_eq!(preview["dataText"], "{\"n\":1}");
    assert_eq!(preview["attributes"]["region"], "eu");
    let (status, published) = suite
        .call(
            Method::POST,
            "/api/v1/pubsub/topic/publish",
            Some(json!({ "topic": invoices, "messages": [message, message], "template": true })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{published}");
    assert_eq!(published["messageIds"].as_array().map(Vec::len), Some(2));
    assert_eq!(published["subscriptions"], 1);
    assert_eq!(published["functions"], 0);
    // A page and the detail.
    let (status, page) = suite
        .call(
            Method::GET,
            &format!("/api/v1/pubsub/messages?topic={}", encoded(&invoices)),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert_eq!(page["total"], json!({ "count": 2, "exact": true }));
    assert_eq!(
        page["items"][0]["data"]["text"], "{\"n\":2}",
        "newest first"
    );
    assert_eq!(page["items"][0]["data"]["encoding"], "json");
    assert_eq!(
        page["items"][0]["deliveries"]["subscriptions"][0]["state"],
        "available"
    );
    let id = page["items"][1]["id"].as_str().expect("id").to_owned();
    let (status, detail) = suite
        .call(
            Method::GET,
            &format!(
                "/api/v1/pubsub/message?topic={}&id={id}",
                encoded(&invoices)
            ),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{detail}");
    assert_eq!(detail["dataText"], "{\"n\":1}");
    assert_eq!(detail["dataJson"], true);
    assert_eq!(detail["inHistory"], true);
    assert_eq!(
        detail["subscriptions"][0]["subscription"],
        subscription_name("invoices-sub")
    );

    // A subscription with every option.
    let dead = topic_name("invoices-dead");
    create_topic(&suite.pubsub, &dead);
    let workers = subscription_name("invoice-workers");
    let (status, summary) = suite
        .call(
            Method::POST,
            "/api/v1/pubsub/subscriptions",
            Some(json!({
                "name": workers,
                "topic": invoices,
                "ackDeadlineSeconds": 30,
                "filter": "attributes.region = \"eu\"",
                "ordering": true,
                "retainAcked": true,
                "retentionSeconds": 3_600,
                "expirationTtlSeconds": 86_400,
                "deadLetter": { "topic": dead, "maxDeliveryAttempts": 5 },
                "retry": { "minimumBackoffSeconds": 10, "maximumBackoffSeconds": 60.5 },
                "labels": { "team": "billing" },
            })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{summary}");
    assert_eq!(summary["ordering"], true);
    assert_eq!(summary["filter"], "attributes.region = \"eu\"");
    assert_eq!(summary["deadLetterTopic"], dead);
    let (_, detail) = suite
        .call(
            Method::GET,
            &format!("/api/v1/pubsub/subscription?name={}", encoded(&workers)),
            None,
        )
        .await;
    let subscription = &detail["subscription"];
    assert_eq!(subscription["ackDeadlineSeconds"], 30);
    assert_eq!(subscription["retainAcked"], true);
    assert_eq!(subscription["retentionSeconds"], 3_600);
    assert_eq!(subscription["expirationTtlSeconds"], 86_400);
    assert_eq!(subscription["retry"]["maximumBackoffSeconds"], 60.5);
    assert_eq!(subscription["labels"]["team"], "billing");
    // The filter passed the eu message only: the backlog holds it alone.
    publish(&suite.pubsub, &invoices, "one");
    let message_with =
        |region: &str| json!({ "data": { "text": "x" }, "attributes": { "region": region } });
    suite
        .call(
            Method::POST,
            "/api/v1/pubsub/topic/publish",
            Some(
                json!({ "topic": invoices, "messages": [message_with("eu"), message_with("us")] }),
            ),
        )
        .await;
    let (status, backlog) = suite
        .call(
            Method::GET,
            &format!("/api/v1/pubsub/backlog?subscription={}", encoded(&workers)),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{backlog}");
    let waiting = backlog["items"].as_array().expect("items");
    assert_eq!(waiting.len(), 1, "the filter passed the eu message only");
    assert_eq!(waiting[0]["attributes"]["region"], "eu");
    // Purge: what waits is acknowledged, and kept as acked.
    let (status, purged) = suite
        .call(
            Method::POST,
            "/api/v1/pubsub/subscription/purge",
            Some(json!({ "name": workers })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{purged}");
    assert_eq!(purged["available"], 0);
    assert_eq!(purged["acked"], 1, "retainAcked keeps it");
    let (status, refused) = suite
        .call(
            Method::POST,
            "/api/v1/pubsub/subscription/purge",
            Some(json!({ "name": subscription_name("nope") })),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{refused}");

    // Schemas: create, commit, delete.
    let schema = format!("projects/{PROJECT}/schemas/order");
    let (status, created) = suite
        .call(
            Method::POST,
            "/api/v1/pubsub/schemas",
            Some(json!({ "name": schema, "kind": "AVRO", "definition": AVRO })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    assert_eq!(created["revisions"].as_array().map(Vec::len), Some(1));
    let (_, committed) = suite
        .call(
            Method::POST,
            "/api/v1/pubsub/schema/commit",
            Some(json!({ "name": schema, "definition": AVRO_2 })),
        )
        .await;
    assert_eq!(committed["revisions"].as_array().map(Vec::len), Some(2));
    let (_, schemas) = suite
        .call(Method::GET, "/api/v1/pubsub/schemas", None)
        .await;
    assert_eq!(schemas["items"][0]["kind"], "AVRO");
    // Checks: definition, message, example.
    let (_, check) = suite
        .call(
            Method::POST,
            "/api/v1/pubsub/schema/check",
            Some(json!({ "kind": "AVRO", "definition": "{\"type\":\"record\",\n\"fields\":[" })),
        )
        .await;
    assert_eq!(check["ok"], false);
    assert_eq!(check["engineMessage"], "Could not parse schema definition");
    assert_eq!(check["line"], 2);
    let (_, valid) = suite
        .call(
            Method::POST,
            "/api/v1/pubsub/schema/validate-message",
            Some(json!({ "schema": schema, "encoding": "JSON", "data": { "json": "{\"id\":\"o1\",\"total\":\"ten\"}" } })),
        )
        .await;
    assert_eq!(valid["ok"], false, "{valid}");
    assert_eq!(valid["problem"]["path"], "$.total");
    let (_, example) = suite
        .call(
            Method::POST,
            "/api/v1/pubsub/schema/example",
            Some(json!({ "definition": AVRO })),
        )
        .await;
    let example_json: Value =
        serde_json::from_str(example["json"].as_str().expect("example")).expect("JSON");
    assert!(example_json["id"].is_string(), "{example}");
    let bound = topic_name("bound");
    let (status, _) = suite
        .call(
            Method::POST,
            "/api/v1/pubsub/topics",
            Some(json!({ "name": bound, "schema": { "schema": schema, "encoding": "BINARY" } })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    // The composer's Fill example: the bound revision's example.
    let (_, example) = suite
        .call(
            Method::POST,
            "/api/v1/pubsub/schema/example",
            Some(json!({ "topic": bound })),
        )
        .await;
    assert!(example["json"].is_string(), "{example}");
    let (status, published) = suite
        .call(
            Method::POST,
            "/api/v1/pubsub/topic/publish",
            Some(json!({ "topic": bound, "messages": [{ "data": { "avroJson": "{\"id\":\"o2\",\"total\":1.0,\"note\":null}" } }] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{published}");
    let (status, _) = suite
        .call(
            Method::DELETE,
            "/api/v1/pubsub/topic",
            Some(json!({ "name": bound, "subscriptions": "delete" })),
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, _) = suite
        .call(
            Method::DELETE,
            "/api/v1/pubsub/schema",
            Some(json!({ "name": schema })),
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    // A filter check over the topic's history.
    let (_, check) = suite
        .call(
            Method::POST,
            "/api/v1/pubsub/filter/check",
            Some(json!({ "filter": "attributes.region = \"eu\"", "topic": invoices })),
        )
        .await;
    assert_eq!(check["ok"], true, "{check}");
    assert_eq!(check["checked"], 5);
    assert_eq!(check["matched"], 3);
    let (_, broken) = suite
        .call(
            Method::POST,
            "/api/v1/pubsub/filter/check",
            Some(json!({ "filter": "attributes.region = " })),
        )
        .await;
    assert_eq!(broken["ok"], false);
    assert_eq!(broken["engineMessage"], "Application error processing RPC");
    assert!(broken["position"].is_number());

    // An NDJSON export, as an attachment.
    let response = suite
        .router
        .clone()
        .oneshot(
            axum::http::Request::get(format!(
                "/api/v1/pubsub/messages:export?topic={}&q={}",
                encoded(&invoices),
                encoded("attributes.region:eu")
            ))
            .body(axum::body::Body::empty())
            .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["content-type"], "application/x-ndjson");
    assert!(
        response.headers()["content-disposition"]
            .to_str()
            .expect("header")
            .contains("invoices-messages.ndjson")
    );
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body");
    let lines: Vec<Value> = String::from_utf8_lossy(&body)
        .lines()
        .map(|line| serde_json::from_str(line).expect("a JSON line"))
        .collect();
    assert_eq!(lines.len(), 3);
    assert_eq!(lines[0]["attributes"]["region"], "eu");
    assert!(lines[0]["data"].is_string());
    // Topic update and delete keeping its subscriptions detached.
    let (status, _) = suite
        .call(
            Method::PATCH,
            "/api/v1/pubsub/topic",
            Some(json!({ "name": invoices, "mask": ["retention"], "retentionSeconds": 1_200 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let (_, detail) = suite
        .call(
            Method::GET,
            &format!("/api/v1/pubsub/topic?name={}", encoded(&invoices)),
            None,
        )
        .await;
    assert_eq!(detail["retentionSeconds"], 1_200);
    assert_eq!(detail["invocations"], Value::Null, "no function listens");
    assert_eq!(detail["labels"]["team"], "billing");
    assert_eq!(detail["attributeKeys"], json!(["region"]));
    let (status, _) = suite
        .call(
            Method::DELETE,
            "/api/v1/pubsub/topic",
            Some(json!({ "name": invoices, "subscriptions": "keep" })),
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (_, index) = suite.call(Method::GET, "/api/v1/pubsub/topics", None).await;
    let detached: Vec<&str> = index["detached"]
        .as_array()
        .expect("detached")
        .iter()
        .filter_map(|subscription| subscription["name"].as_str())
        .collect();
    assert!(detached.contains(&workers.as_str()), "{detached:?}");
    suite.stop.send(true).expect("stop");
}

// ------------------------------------------------------------ R-CF-05

#[tokio::test]
async fn engine_errors_keep_their_words_and_gain_a_fix() {
    let suite = suite(None);
    let (status, body) = suite
        .call(
            Method::POST,
            "/api/v1/pubsub/topics",
            Some(json!({ "name": "projects/demo-console/topics/1bad" })),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"]["code"], "invalid-argument");
    assert_eq!(
        body["error"]["message"],
        "Invalid [topics] name: (name=projects/demo-console/topics/1bad)"
    );
    assert!(
        body["error"]["fix"]
            .as_str()
            .is_some_and(|fix| fix.contains("3–255"))
    );
    assert_eq!(body["grpcCode"], "INVALID_ARGUMENT");
    let (status, body) = suite
        .call(
            Method::POST,
            "/api/v1/pubsub/topics",
            Some(json!({ "name": ORDERS })),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["error"]["code"], "already-exists");
    let (status, body) = suite
        .call(
            Method::GET,
            "/api/v1/pubsub/topic?name=projects/demo-console/topics/nope",
            None,
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["error"]["message"], "Topic not found");
    assert_eq!(body["grpcCode"], "NOT_FOUND");
    // Run now while background triggers are paused.
    suite.background.set_background_enabled(false);
    let (status, body) = suite
        .call(
            Method::POST,
            "/api/v1/pubsub/schedule/run",
            Some(json!({ "functionId": "us-central1-nightlyCleanup" })),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(
        body["error"]["message"],
        "Background triggers are paused, so the tick was not published."
    );
    assert_eq!(body["error"]["fix"], "Resume background triggers.");
    suite.stop.send(true).expect("stop");
}

// ------------------------------------------------------------ R-CF-07

#[tokio::test]
async fn request_bodies_have_their_limits_and_say_so() {
    let suite = suite(None);
    let big = topic_name("big");
    create_topic(&suite.pubsub, &big);
    // 3 MB in one request is above axum's 2 MB default and accepted.
    let three = "x".repeat(3 * 1024 * 1024);
    let (status, body) = suite
        .call(
            Method::POST,
            "/api/v1/pubsub/topic/publish",
            Some(json!({ "topic": big, "messages": [{ "data": { "text": three } }] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    // 65 MiB is refused as JSON, naming the limit.
    let huge = "x".repeat(65 * 1024 * 1024);
    let (status, body) = suite
        .call(
            Method::POST,
            "/api/v1/pubsub/topic/publish",
            Some(json!({ "topic": big, "messages": [{ "data": { "text": huge } }] })),
        )
        .await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(body["error"]["code"], "payload-too-large");
    assert!(
        body["error"]["message"]
            .as_str()
            .is_some_and(|message| message.contains("64 MB")),
        "{body}"
    );
    // A repeat past 64 MiB in all is refused before any copy is made.
    let hundred = "x".repeat(100 * 1024);
    let (status, body) = suite
        .call(
            Method::POST,
            "/api/v1/pubsub/messages:publish",
            Some(json!({ "topic": big, "messages": [{ "data": { "text": hundred } }], "repeat": 1_000 })),
        )
        .await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE, "{body}");
    assert_eq!(
        body["error"]["message"],
        "This publish would be 97.7 MB after repeating it 1,000 times; the console publishes up to 64 MiB at once."
    );
    assert_eq!(
        body["error"]["fix"],
        "Lower the count, or publish with an interval."
    );
    // Every other route stops at 1 MiB.
    let (status, _) = suite
        .call(
            Method::POST,
            "/api/v1/pubsub/subscription/push-config",
            Some(json!({ "subscription": "x", "endpoint": hundred.repeat(11) })),
        )
        .await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    suite.stop.send(true).expect("stop");
}

// ------------------------------------------------------------ R-CF-09

#[tokio::test]
async fn setup_round_trips_schema_revisions() {
    let first = suite(None);
    let schema = format!("projects/{PROJECT}/schemas/order");
    let created = create_schema_named(&first.pubsub, &schema, "AVRO", AVRO).expect("schema");
    let second = commit_schema_named(&first.pubsub, &schema, AVRO_2).expect("revision 2");
    commit_schema_named(&first.pubsub, &schema, AVRO_3).expect("revision 3");
    let bound = topic_name("orders-v2");
    first
        .call(
            Method::POST,
            "/api/v1/pubsub/topics",
            Some(json!({
                "name": bound,
                "schema": {
                    "schema": schema,
                    "encoding": "JSON",
                    "firstRevisionId": created.revision_id,
                    "lastRevisionId": second.revision_id,
                },
            })),
        )
        .await;
    let dead = topic_name("orders-v2-dead");
    create_topic(&first.pubsub, &dead);
    let (status, _) = first
        .call(
            Method::POST,
            "/api/v1/pubsub/subscriptions",
            Some(json!({
                "name": subscription_name("orders-v2-worker"),
                "topic": bound,
                "deadLetter": { "topic": dead, "maxDeliveryAttempts": 7 },
            })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    let (status, setup) = first.call(Method::GET, "/api/v1/pubsub/setup", None).await;
    assert_eq!(status, StatusCode::OK, "{setup}");
    assert_eq!(setup["version"], 2);
    assert_eq!(
        setup["schemas"][0]["revisions"].as_array().map(Vec::len),
        Some(3)
    );
    let topics: Vec<&str> = setup["topics"]
        .as_array()
        .expect("topics")
        .iter()
        .filter_map(|topic| topic["name"].as_str())
        .collect();
    assert!(
        !topics.contains(&SCHEDULE_TOPIC),
        "the schedule's topic is the function's"
    );
    let subscriptions: Vec<&str> = setup["subscriptions"]
        .as_array()
        .expect("subscriptions")
        .iter()
        .filter_map(|subscription| subscription["name"].as_str())
        .collect();
    assert!(
        subscriptions
            .iter()
            .all(|name| !name.contains("emulator-sub-")),
        "{subscriptions:?}"
    );
    first.stop.send(true).expect("stop");

    // Into a fresh engine.
    let fresh = suite(None);
    let (status, result) = fresh
        .call(
            Method::POST,
            "/api/v1/pubsub/setup/import",
            Some(setup.clone()),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    let revisions = result["revisions"].as_array().expect("revisions");
    assert_eq!(revisions.len(), 3);
    assert_eq!(revisions[0]["exported"], created.revision_id);
    // The function's topic exists in the fresh engine already.
    let skipped: Vec<&str> = result["skipped"]
        .as_array()
        .expect("skipped")
        .iter()
        .filter_map(|skip| skip["name"].as_str())
        .collect();
    assert_eq!(skipped, [ORDERS], "{result}");
    assert_eq!(result["skipped"][0]["reason"], "It already exists.");
    let (_, detail) = fresh
        .call(
            Method::GET,
            &format!("/api/v1/pubsub/topic?name={}", encoded(&bound)),
            None,
        )
        .await;
    // The binding names the revisions the import created.
    assert_eq!(detail["schema"]["firstRevisionId"], revisions[0]["created"]);
    assert_eq!(detail["schema"]["lastRevisionId"], revisions[1]["created"]);
    let (_, subscription) = fresh
        .call(
            Method::GET,
            &format!(
                "/api/v1/pubsub/subscription?name={}",
                encoded(&subscription_name("orders-v2-worker"))
            ),
            None,
        )
        .await;
    assert_eq!(
        subscription["subscription"]["deadLetter"]["maxDeliveryAttempts"],
        7
    );
    // A second import skips everything that exists now.
    let (_, again) = fresh
        .call(Method::POST, "/api/v1/pubsub/setup/import", Some(setup))
        .await;
    assert_eq!(again["created"], json!([]), "{again}");
    fresh.stop.send(true).expect("stop");
}

// ------------------------------------------------------------ R-CF-10

#[tokio::test]
async fn search_finds_topics_messages_and_schedules() {
    let suite = suite(None);
    let broker = suite.pubsub.runtime.broker();
    for index in 0..2_000 {
        broker
            .create_topic(firenook_pubsub_front::google::pubsub::v1::Topic {
                name: topic_name(&format!("load-{index:04}")),
                ..Default::default()
            })
            .expect("topic");
    }
    let target = topic_name("load-1500");
    let id = publish(&suite.pubsub, &target, "needle");
    let search = search::PubsubSearch::new({
        let late = Late::pending("Pub/Sub");
        late.set(suite.pubsub.clone());
        late
    });
    let cancel = std::sync::atomic::AtomicBool::new(false);
    let started = Instant::now();
    let found = search.search("load-15", 5, &cancel);
    assert!(
        started.elapsed() < Duration::from_millis(50),
        "{:?}",
        started.elapsed()
    );
    assert_eq!(found.hits.len(), 5);
    assert!(found.hits.iter().all(|hit| hit.kind == "pubsub.topic"));
    assert_eq!(found.hits[0].key, topic_name("load-1500"));
    let started = Instant::now();
    let found = search.search(&id.to_string(), 5, &cancel);
    assert!(
        started.elapsed() < Duration::from_millis(50),
        "{:?}",
        started.elapsed()
    );
    assert_eq!(found.hits[0].kind, "pubsub.message");
    assert_eq!(found.hits[0].key, format!("{target}|{id}"));
    let found = search.search("nightly", 5, &cancel);
    assert_eq!(found.hits[0].kind, "pubsub.schedule");
    assert_eq!(found.hits[0].key, "us-central1-nightlyCleanup");
    suite.stop.send(true).expect("stop");
}

// ------------------------------------------------------------ R-CF-12

#[tokio::test]
async fn publish_jobs_run_on_the_job_registry() {
    let suite = suite(None);
    let paced = topic_name("paced");
    create_topic(&suite.pubsub, &paced);
    create_subscription(&suite.pubsub, &subscription_name("paced-sub"), &paced);
    let draft = json!({ "data": { "text": "n{{i}}" } });
    // A burst: one job, counted to the end.
    let (status, job) = suite
        .call(
            Method::POST,
            "/api/v1/pubsub/messages:publish",
            Some(json!({ "topic": paced, "messages": [draft], "repeat": 2_500, "template": true })),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "past 1,000 repeats: {job}");
    let (status, job) = suite
        .call(
            Method::POST,
            "/api/v1/pubsub/messages:publish",
            Some(json!({ "topic": paced, "messages": [draft, draft], "repeat": 1_000, "template": true })),
        )
        .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{job}");
    assert_eq!(job["kind"], "pubsub.publish");
    assert_eq!(job["title"], "Publishing 2,000 messages to paced");
    let done = suite.finished(job["id"].as_str().expect("id")).await;
    assert_eq!(done["state"], "done", "{done}");
    assert_eq!(done["done"], 2_000);
    let (_, page) = suite
        .call(
            Method::GET,
            &format!("/api/v1/pubsub/messages?topic={}&limit=1", encoded(&paced)),
            None,
        )
        .await;
    assert_eq!(
        page["items"][0]["data"]["text"], "n2000",
        "templates count across the job"
    );
    // An interval: cancelled midway.
    let (status, job) = suite
        .call(
            Method::POST,
            "/api/v1/pubsub/messages:publish",
            Some(json!({ "topic": paced, "messages": [draft], "repeat": 20, "intervalMs": 100 })),
        )
        .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{job}");
    assert_eq!(
        job["title"],
        "Publishing 20 messages to paced, ten a second"
    );
    let id = job["id"].as_str().expect("id").to_owned();
    tokio::time::sleep(Duration::from_millis(350)).await;
    let (status, _) = suite
        .call(
            Method::POST,
            &format!("/api/v1/jobs/{id}/cancel"),
            Some(json!({})),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let cancelled = suite.finished(&id).await;
    assert_eq!(cancelled["state"], "cancelled", "{cancelled}");
    assert!(
        cancelled["done"]
            .as_u64()
            .is_some_and(|done| done > 0 && done < 20),
        "{cancelled}"
    );
    // Again from the history: kept ids publish, gone ones are skipped.
    let (_, page) = suite
        .call(
            Method::GET,
            &format!("/api/v1/pubsub/messages?topic={}&limit=2", encoded(&paced)),
            None,
        )
        .await;
    let ids: Vec<String> = page["items"]
        .as_array()
        .expect("items")
        .iter()
        .filter_map(|item| item["id"].as_str().map(str::to_owned))
        .collect();
    let (status, job) = suite
        .call(
            Method::POST,
            "/api/v1/pubsub/messages:publish",
            Some(json!({ "topic": paced, "target": { "by": "keys", "keys": [ids[0], ids[1], "999999"] } })),
        )
        .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{job}");
    let again = suite.finished(job["id"].as_str().expect("id")).await;
    assert_eq!(again["state"], "done", "{again}");
    assert_eq!(again["done"], 2);
    assert_eq!(again["skipped"], 1, "no message 999999 is kept");
    // A fifth running job of the section is refused.
    let mut running = Vec::new();
    for _ in 0..4 {
        let (status, job) = suite
            .call(
                Method::POST,
                "/api/v1/pubsub/messages:publish",
                Some(json!({ "topic": paced, "messages": [draft], "repeat": 50, "intervalMs": 5_000 })),
            )
            .await;
        assert_eq!(status, StatusCode::ACCEPTED, "{job}");
        running.push(job["id"].as_str().expect("id").to_owned());
    }
    let (status, refused) = suite
        .call(
            Method::POST,
            "/api/v1/pubsub/messages:publish",
            Some(json!({ "topic": paced, "messages": [draft] })),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{refused}");
    assert_eq!(refused["error"]["code"], "conflict");
    // The engine's stop cancels what runs.
    suite.jobs.stop().await;
    for id in &running {
        let job = suite.finished(id).await;
        assert_eq!(job["state"], "cancelled", "{job}");
    }
    suite.stop.send(true).expect("stop");
}

#[tokio::test]
async fn backlog_jobs_ack_and_release_by_query() {
    let suite = suite(None);
    let topic = topic_name("work");
    create_topic(&suite.pubsub, &topic);
    let worker = subscription_name("work-sub");
    create_subscription(&suite.pubsub, &worker, &topic);
    for index in 0..5 {
        publish(&suite.pubsub, &topic, &index.to_string());
    }
    let broker = suite.pubsub.runtime.broker();
    let _ = broker.pull(&worker, 2).expect("pull");
    // Release the two leased messages: every outstanding row.
    let (status, job) = suite
        .call(
            Method::POST,
            "/api/v1/pubsub/backlog:release",
            Some(json!({ "subscription": worker, "target": { "by": "query", "q": "", "scope": { "subscription": worker, "state": "outstanding" } } })),
        )
        .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{job}");
    assert_eq!(job["kind"], "pubsub.release");
    let done = suite.finished(job["id"].as_str().expect("id")).await;
    assert_eq!(done["done"], 2, "{done}");
    assert_eq!(
        broker
            .subscription_counts(&worker)
            .expect("counts")
            .available,
        5
    );
    // Acknowledge three by row key.
    let (_, page) = suite
        .call(
            Method::GET,
            &format!(
                "/api/v1/pubsub/backlog?subscription={}&limit=3",
                encoded(&worker)
            ),
            None,
        )
        .await;
    let keys: Vec<Value> = page["items"]
        .as_array()
        .expect("items")
        .iter()
        .map(|row| row["key"].clone())
        .collect();
    let (status, job) = suite
        .call(
            Method::POST,
            "/api/v1/pubsub/backlog:ack",
            Some(json!({ "subscription": worker, "target": { "by": "keys", "keys": keys } })),
        )
        .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{job}");
    let done = suite.finished(job["id"].as_str().expect("id")).await;
    assert_eq!(done["errorCount"], 0, "{done}");
    assert_eq!(
        broker
            .subscription_counts(&worker)
            .expect("counts")
            .available,
        2
    );
    // A backlog has no filter.
    let (status, refused) = suite
        .call(
            Method::POST,
            "/api/v1/pubsub/backlog:ack",
            Some(json!({ "subscription": worker, "target": { "by": "query", "q": "refund", "scope": {} } })),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{refused}");
    suite.stop.send(true).expect("stop");
}

// ------------------------------------------------------------ R-CF-13

/// The test inventory's subscriber of `orders`.
const ON_ORDER: &str = "us-central1-onOrderPlaced";

/// A message's delivery to a function by `event_id`, as its detail says
/// (the inspector's Deliveries tab).
async fn delivery(suite: &Suite, message: u64, event_id: &str) -> Value {
    let (status, detail) = suite
        .call(
            Method::GET,
            &format!(
                "/api/v1/pubsub/message?topic={}&id={message}",
                encoded(ORDERS)
            ),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{detail}");
    detail["functions"]
        .as_array()
        .expect("functions")
        .iter()
        .find(|row| row["eventId"] == event_id)
        .cloned()
        .unwrap_or_else(|| panic!("a delivery {event_id} in {detail}"))
}

#[tokio::test]
async fn deliveries_join_the_fanout_with_the_invocation_record() {
    // Compute keeps two finished invocations here, with no floor per kind,
    // so a third lets the oldest go.
    let monitor = Monitor::new(MonitorLimits {
        invocations: 2,
        kind_floor: 0,
        ..MonitorLimits::default()
    });
    let mut suite = suite(Some(monitor.clone()));
    // The topic links every run its messages started in Functions › Invocations.
    let (_, detail) = suite
        .call(
            Method::GET,
            &format!("/api/v1/pubsub/topic?name={}", encoded(ORDERS)),
            None,
        )
        .await;
    assert_eq!(
        detail["invocations"],
        json!({ "kind": "functions.invocations", "key": format!("topic:{ORDERS}") })
    );
    let id = publish(&suite.pubsub, ORDERS, "{\"order\":1}");
    let dispatch = suite.deliveries.recv().await.expect("dispatch");
    // Queued: handed over, no invocation recorded, the record kept everything.
    let row = delivery(&suite, id, &dispatch.event_id).await;
    assert_eq!(row["messageId"], id.to_string());
    assert_eq!(row["functionId"], "us-central1-onOrderPlaced");
    assert_eq!(row["functionName"], "onOrderPlaced");
    assert_eq!(row["mark"], "queued");
    assert!(row["queueDepth"].is_number());
    assert_eq!(row["invocation"], Value::Null);
    assert_eq!(row["functionRef"]["kind"], "functions.function");
    // The message's row carries the function's mark too.
    let messages = format!("/api/v1/pubsub/messages?topic={}", encoded(ORDERS));
    let (_, page) = suite.call(Method::GET, &messages, None).await;
    assert_eq!(
        page["items"][0]["deliveries"]["functions"],
        json!([{ "functionId": "us-central1-onOrderPlaced", "mark": "queued" }])
    );

    // Running, then delivered: compute recorded the request the dispatch
    // made, found by the event id the delivery queue sent.
    let first = begin_dispatch(&monitor, ON_ORDER, FunctionKind::Pubsub, &dispatch);
    let row = delivery(&suite, id, &dispatch.event_id).await;
    assert_eq!(row["mark"], "running");
    assert_eq!(row["invocation"]["key"], &*first.id);
    assert_eq!(row["queueDepth"], Value::Null);
    finish_invocation(&monitor, &first, 200, None);
    let row = delivery(&suite, id, &dispatch.event_id).await;
    assert_eq!(row["mark"], "delivered");
    assert_eq!(row["status"], 200);
    assert_eq!(row["error"], Value::Null);
    assert_eq!(
        row["invocation"],
        json!({ "kind": "functions.invocation", "key": &*first.id })
    );
    assert!(row["startedAt"].is_string());
    assert!(row["durationMs"].is_number());
    // The request shown is the one compute recorded, not a rebuilt one.
    let (status, body) = suite
        .call(
            Method::GET,
            &format!(
                "/api/v1/pubsub/dispatch?topic={}&id={id}&function=us-central1-onOrderPlaced",
                encoded(ORDERS)
            ),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["rebuilt"], false);
    assert_eq!(
        body["body"].as_str().map(str::as_bytes),
        Some(dispatch.body.as_slice())
    );

    // Failed: the handler threw; its status and the error's first line.
    let declined = publish(&suite.pubsub, ORDERS, "{\"order\":2}");
    let second = suite.deliveries.recv().await.expect("dispatch");
    let token = begin_dispatch(&monitor, ON_ORDER, FunctionKind::Pubsub, &second);
    finish_invocation(
        &monitor,
        &token,
        500,
        Some("Error: card declined\n    at handler (index.js:3:9)"),
    );
    let row = delivery(&suite, declined, &second.event_id).await;
    assert_eq!(row["messageId"], declined.to_string());
    assert_eq!(row["mark"], "failed");
    assert_eq!(row["status"], 500);
    assert_eq!(row["error"], "Error: card declined");
    assert_eq!(row["invocation"]["key"], &*token.id);

    // Background triggers paused: skipped, with the reason.
    suite.background.set_background_enabled(false);
    let paused = publish(&suite.pubsub, ORDERS, "{\"order\":3}");
    let (_, detail) = suite
        .call(
            Method::GET,
            &format!(
                "/api/v1/pubsub/message?topic={}&id={paused}",
                encoded(ORDERS)
            ),
            None,
        )
        .await;
    assert_eq!(detail["functions"][0]["mark"], "skipped");
    assert_eq!(
        detail["functions"][0]["skippedReason"],
        "Background triggers were paused, so the event was dropped."
    );
    suite.background.set_background_enabled(true);
    // A redelivery is its own row, sent even though the publish was not.
    let redeliver = |message: u64| json!({ "topic": ORDERS, "messageId": message.to_string(), "functionId": "us-central1-onOrderPlaced" });
    let (status, resent) = suite
        .call(
            Method::POST,
            "/api/v1/pubsub/message/redeliver",
            Some(redeliver(paused)),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{resent}");
    let resent = resent["eventId"].as_str().expect("event id").to_owned();
    let resent_dispatch = suite.deliveries.recv().await.expect("redelivery");
    assert_eq!(resent_dispatch.event_id, resent);
    let row = delivery(&suite, paused, &resent).await;
    assert_eq!(row["mark"], "queued");
    assert_eq!(row["redelivery"], true);

    // No longer kept: the redelivery's invocation is the third finished
    // one, so compute lets the first go. The first message's delivery
    // cannot say how it went any more; the second's is still kept.
    let third = begin_dispatch(&monitor, ON_ORDER, FunctionKind::Pubsub, &resent_dispatch);
    finish_invocation(&monitor, &third, 200, None);
    let row = delivery(&suite, id, &dispatch.event_id).await;
    assert_eq!(row["mark"], "not-kept");
    assert_eq!(row["invocation"], Value::Null);
    assert_eq!(row["status"], Value::Null);
    assert_eq!(row["queueDepth"], Value::Null);
    assert_eq!(
        delivery(&suite, declined, &second.event_id).await["mark"],
        "failed"
    );
    assert_eq!(delivery(&suite, paused, &resent).await["mark"], "delivered");
    // Each delivery's own request: the run again carries its own event id.
    let (_, body) = suite
        .call(
            Method::GET,
            &format!(
                "/api/v1/pubsub/dispatch?topic={}&id={paused}&function=us-central1-onOrderPlaced&event={resent}",
                encoded(ORDERS)
            ),
            None,
        )
        .await;
    assert_eq!(body["rebuilt"], false);
    assert_eq!(
        body["body"].as_str().map(str::as_bytes),
        Some(resent_dispatch.body.as_slice())
    );
    // A redelivery of that first message made now is queued, not taken
    // for one compute let go: it was handed over after the eviction.
    let (status, again) = suite
        .call(
            Method::POST,
            "/api/v1/pubsub/message/redeliver",
            Some(redeliver(id)),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{again}");
    let again = again["eventId"].as_str().expect("event id").to_owned();
    assert_eq!(delivery(&suite, id, &again).await["mark"], "queued");
    assert_eq!(
        delivery(&suite, id, &dispatch.event_id).await["mark"],
        "not-kept"
    );
    // Its message row shows the newest delivery's mark for the function.
    let (_, page) = suite.call(Method::GET, &messages, None).await;
    let first_id = id.to_string();
    let row = page["items"]
        .as_array()
        .expect("items")
        .iter()
        .find(|row| row["id"].as_str() == Some(first_id.as_str()))
        .expect("the first message");
    assert_eq!(
        row["deliveries"]["functions"],
        json!([{ "functionId": "us-central1-onOrderPlaced", "mark": "queued" }])
    );
    // Once compute lets the second go too, its dispatch is rebuilt.
    monitor.clear_invocations();
    let (_, body) = suite
        .call(
            Method::GET,
            &format!(
                "/api/v1/pubsub/dispatch?topic={}&id={declined}&function=us-central1-onOrderPlaced",
                encoded(ORDERS)
            ),
            None,
        )
        .await;
    assert_eq!(body["rebuilt"], true);
    assert!(
        body["contentType"]
            .as_str()
            .is_some_and(|value| value.starts_with("application/cloudevents+json"))
    );
    assert_eq!(
        delivery(&suite, declined, &second.event_id).await["mark"],
        "not-kept"
    );
    suite.stop.send(true).expect("stop");
}

/// An SDK that catches the handler's error itself (`onSchedule` logs the
/// message and answers 500 with no body) leaves compute no handler error:
/// the delivery says what the invocation logged at error level instead.
#[tokio::test]
async fn a_failure_the_sdk_caught_says_what_the_handler_logged() {
    let monitor = Monitor::new(MonitorLimits::default());
    let mut suite = suite(Some(monitor.clone()));
    let first = publish(&suite.pubsub, ORDERS, "{\"order\":1}");
    let dispatch = suite.deliveries.recv().await.expect("dispatch");
    let token = begin_dispatch(&monitor, ON_ORDER, FunctionKind::Pubsub, &dispatch);
    let line = |level: &str, message: &str| {
        firenook_functions_runtime::LogEvent::new(level, "functions", message.to_owned())
            .with_execution(&*token.id)
    };
    monitor.log(&line("INFO", "starting the digest"));
    // The SDK's logger writes a structured line; its severity is the level.
    monitor.log(&line(
        "INFO",
        r#"{"severity":"ERROR","message":"digest service unavailable\nretry later"}"#,
    ));
    monitor.log(&line("ERROR", "a second error"));
    finish_invocation(&monitor, &token, 500, None);
    let row = delivery(&suite, first, &dispatch.event_id).await;
    assert_eq!(row["mark"], "failed");
    assert_eq!(row["status"], 500);
    assert_eq!(row["error"], "digest service unavailable");

    // A handler error compute recorded wins over any line.
    let second_id = publish(&suite.pubsub, ORDERS, "{\"order\":2}");
    let second = suite.deliveries.recv().await.expect("dispatch");
    let token = begin_dispatch(&monitor, ON_ORDER, FunctionKind::Pubsub, &second);
    monitor.log(
        &firenook_functions_runtime::LogEvent::new("ERROR", "functions", "logged".to_owned())
            .with_execution(&*token.id),
    );
    finish_invocation(&monitor, &token, 500, Some("Error: thrown"));
    assert_eq!(
        delivery(&suite, second_id, &second.event_id).await["error"],
        "Error: thrown"
    );

    // A success that logged an error is no failure, and has no error.
    let third_id = publish(&suite.pubsub, ORDERS, "{\"order\":3}");
    let third = suite.deliveries.recv().await.expect("dispatch");
    let token = begin_dispatch(&monitor, ON_ORDER, FunctionKind::Pubsub, &third);
    monitor.log(
        &firenook_functions_runtime::LogEvent::new("ERROR", "functions", "noisy".to_owned())
            .with_execution(&*token.id),
    );
    finish_invocation(&monitor, &token, 200, None);
    let row = delivery(&suite, third_id, &third.event_id).await;
    assert_eq!(row["mark"], "delivered");
    assert_eq!(row["error"], Value::Null);
    suite.stop.send(true).expect("stop");
}

// ------------------------------------------------------------ R-CF-14

#[tokio::test]
async fn batch_gets_patch_rows() {
    let suite = suite(None);
    let topic = topic_name("patched");
    create_topic(&suite.pubsub, &topic);
    let worker = subscription_name("patched-sub");
    create_subscription(&suite.pubsub, &worker, &topic);
    for index in 0..4 {
        publish(&suite.pubsub, &topic, &format!("m{index}"));
    }
    let (_, page) = suite
        .call(
            Method::GET,
            &format!(
                "/api/v1/pubsub/backlog?subscription={}&limit=2",
                encoded(&worker)
            ),
            None,
        )
        .await;
    let first_key = page["items"][0]["key"].as_str().expect("key").to_owned();
    assert_eq!(page["items"][0]["place"], 1);
    let page_start = page["prevCursor"].clone();
    let next = page["nextCursor"].clone();
    // A pull and a nack move the first message behind the others.
    let broker = suite.pubsub.runtime.broker();
    let received = broker.pull(&worker, 1).expect("pull");
    broker
        .modify_ack_deadline(&worker, &[received[0].ack_id.clone()], 0)
        .expect("nack");
    let (_, moved) = suite
        .call(
            Method::GET,
            &format!(
                "/api/v1/pubsub/backlog?subscription={}&limit=10",
                encoded(&worker)
            ),
            None,
        )
        .await;
    let new_key = moved["items"][3]["key"]
        .as_str()
        .expect("moved key")
        .to_owned();
    assert_eq!(moved["items"][3]["id"], page["items"][0]["id"]);
    assert_eq!(moved["items"][3]["place"], 4, "behind the later ones");
    let (status, batch) = suite
        .call(
            Method::POST,
            &format!(
                "/api/v1/pubsub/backlog:batchGet?subscription={}",
                encoded(&worker)
            ),
            Some(json!({ "keys": [first_key, new_key], "pageStarts": [page_start, next] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{batch}");
    assert_eq!(batch["items"][0]["row"], Value::Null, "the old key left");
    assert_eq!(batch["items"][1]["row"]["state"], "available");
    assert_eq!(batch["items"][1]["page"], 1, "it falls in the second page");
    // Messages: a mark change comes back patched; a row outside the filter
    // comes back absent.
    let (_, messages) = suite
        .call(
            Method::GET,
            &format!("/api/v1/pubsub/messages?topic={}", encoded(&topic)),
            None,
        )
        .await;
    let newest = messages["items"][0]["id"].as_str().expect("id").to_owned();
    let oldest = messages["items"][3]["id"].as_str().expect("id").to_owned();
    broker
        .force_ack(&worker, newest.parse().expect("id"))
        .expect("ack");
    let (_, batch) = suite
        .call(
            Method::POST,
            &format!("/api/v1/pubsub/messages:batchGet?topic={}", encoded(&topic)),
            Some(json!({ "keys": [newest, oldest], "q": "m3", "pageStarts": [null] })),
        )
        .await;
    assert_eq!(
        batch["items"][0]["row"]["deliveries"]["subscriptions"][0]["state"],
        "acked"
    );
    assert_eq!(batch["items"][0]["page"], 0);
    assert_eq!(
        batch["items"][1]["row"],
        Value::Null,
        "m0 does not match m3"
    );
    // Past 500 keys a batch is refused.
    let keys: Vec<String> = (0..501).map(|index| index.to_string()).collect();
    let (status, refused) = suite
        .call(
            Method::POST,
            &format!("/api/v1/pubsub/messages:batchGet?topic={}", encoded(&topic)),
            Some(json!({ "keys": keys })),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{refused}");
    assert_eq!(refused["error"]["code"], "invalid-argument");
    suite.stop.send(true).expect("stop");
}

// ------------------------------------------------------------ R-CF-16

#[tokio::test]
async fn lists_are_pages() {
    let suite = suite(None);
    // The golden file declares the fields the engine validates with.
    let infos = MESSAGE_FIELDS.infos();
    let fields: Vec<&str> = infos.iter().map(|info| info.key.as_str()).collect();
    assert_eq!(fields, ["id", "key", "attributes", "has", "is"]);
    let cases: Value = serde_json::from_str(MESSAGE_CASES).expect("cases");
    let declared: Vec<&str> = cases["fields"]
        .as_array()
        .expect("fields")
        .iter()
        .filter_map(|field| field["key"].as_str())
        .collect();
    assert_eq!(declared, fields);
    for (field, info) in cases["fields"]
        .as_array()
        .expect("fields")
        .iter()
        .zip(&infos)
    {
        assert_eq!(field["kind"], info.kind);
        assert_eq!(field["help"], info.help);
    }
    assert!(crate::filter::golden::run(MESSAGE_CASES) >= 30);
    // The bounded lists are one page with an exact total.
    for uri in [
        "/api/v1/pubsub/topics",
        "/api/v1/pubsub/schemas",
        "/api/v1/pubsub/schedules",
        "/api/v1/pubsub/rejected",
    ] {
        let (status, page) = suite.call(Method::GET, uri, None).await;
        assert_eq!(status, StatusCode::OK, "{uri}");
        assert_eq!(page["nextCursor"], Value::Null, "{uri}");
        assert_eq!(page["total"]["exact"], true, "{uri}");
        assert!(page["items"].is_array(), "{uri}");
    }
    // A long list pages by cursor, both ways.
    let topic = topic_name("paged");
    create_topic(&suite.pubsub, &topic);
    for index in 0..250 {
        publish(&suite.pubsub, &topic, &index.to_string());
    }
    let (_, first) = suite
        .call(
            Method::GET,
            &format!(
                "/api/v1/pubsub/messages?topic={}&limit=100",
                encoded(&topic)
            ),
            None,
        )
        .await;
    assert_eq!(first["items"].as_array().map(Vec::len), Some(100));
    let cursor = first["nextCursor"].as_str().expect("next").to_owned();
    let (_, second) = suite
        .call(
            Method::GET,
            &format!(
                "/api/v1/pubsub/messages?topic={}&limit=100&cursor={cursor}",
                encoded(&topic)
            ),
            None,
        )
        .await;
    assert_eq!(second["items"][0]["data"]["text"], "149");
    let before = second["prevCursor"].as_str().expect("prev").to_owned();
    let (_, back) = suite
        .call(
            Method::GET,
            &format!(
                "/api/v1/pubsub/messages?topic={}&limit=100&before={before}",
                encoded(&topic)
            ),
            None,
        )
        .await;
    assert_eq!(back["items"][0], first["items"][0]);
    // The schedules list: the schedule with its next ticks.
    let (_, schedules) = suite
        .call(Method::GET, "/api/v1/pubsub/schedules", None)
        .await;
    let schedule = &schedules["items"][0];
    assert_eq!(schedule["functionId"], "us-central1-nightlyCleanup");
    assert_eq!(schedule["functionRef"]["kind"], "functions.function");
    assert_eq!(schedule["evaluatedIn"], "UTC");
    assert_eq!(schedule["automatic"], true);
    // Run now records a console run; pause and resume answer the schedule.
    let (status, run) = suite
        .call(
            Method::POST,
            "/api/v1/pubsub/schedule/run",
            Some(json!({ "functionId": "us-central1-nightlyCleanup" })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{run}");
    assert_eq!(run["trigger"], "console");
    assert!(run["messageId"].is_string());
    let (_, paused) = suite
        .call(
            Method::POST,
            "/api/v1/pubsub/schedule/pause",
            Some(json!({ "functionId": "us-central1-nightlyCleanup" })),
        )
        .await;
    assert_eq!(paused["paused"], true);
    assert_eq!(paused["runs"], 1);
    let (status, _) = suite
        .call(
            Method::POST,
            "/api/v1/pubsub/schedule/resume",
            Some(json!({ "functionId": "nope" })),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    suite.stop.send(true).expect("stop");
}

const MESSAGE_CASES: &str =
    include_str!("../../../../../console/src/pubsub/message-filter-cases.json");

/// A console route a test reaches with no runtime behind it never hangs.
#[tokio::test]
async fn the_suite_keeps_answering_after_the_runtime_stops() {
    let suite: Suite = suite(None);
    suite.pubsub.runtime.shutdown().await;
    let (status, _) = suite.call(Method::GET, "/api/v1/pubsub/topics", None).await;
    assert_eq!(status, StatusCode::OK);
    suite.stop.send(true).expect("stop");
}
