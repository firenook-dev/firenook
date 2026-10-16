#![allow(clippy::too_many_lines)] // Scenarios read best whole.

use std::time::Duration;

use firenook_functions_runtime::monitor::{
    CodebaseRegistration, DeliveryPlan, EventReceived, EventarcOrigin, FunctionCodebaseKind,
    FunctionKind, InvocationCause, InvocationOrigin, InvocationStart, InvocationTarget,
};
use firenook_functions_runtime::{LogEvent, LogStream};
use serde_json::{Value, json};

use super::super::tests::{CHANNEL, Suite, begin, finish};
use super::*;
use crate::live::TopicStream;

/// The next named event of a topic stream, skipping cursor-only ticks.
async fn next_event(stream: &mut TopicStream) -> (String, Value) {
    loop {
        let event = tokio::time::timeout(Duration::from_secs(5), stream.next())
            .await
            .expect("an event in time")
            .expect("the stream is open");
        match event {
            TopicEvent::Event { name: "tick", .. } => {}
            TopicEvent::Event { name, data, .. } => {
                return (
                    name.to_owned(),
                    serde_json::from_str(&data).expect("JSON data"),
                );
            }
            other => panic!("unexpected {other:?}"),
        }
    }
}

/// The cursor of the next event, ticks included.
async fn next_cursor(stream: &mut TopicStream) -> String {
    let event = tokio::time::timeout(Duration::from_secs(5), stream.next())
        .await
        .expect("an event in time")
        .expect("open");
    match event {
        TopicEvent::Event { cursor, .. } => cursor.expect("a cursor").to_string(),
        other => panic!("unexpected {other:?}"),
    }
}

/// Nothing more arrives for a while.
async fn quiet(stream: &mut TopicStream) {
    loop {
        match tokio::time::timeout(Duration::from_millis(400), stream.next()).await {
            Err(_) => return,
            Ok(Some(TopicEvent::Event { name: "tick", .. })) => {}
            Ok(other) => panic!("unexpected {other:?}"),
        }
    }
}

fn register(suite: &Suite, id: &str) {
    suite.monitor().codebase_registered(CodebaseRegistration {
        id: id.to_owned(),
        kind: FunctionCodebaseKind::User,
        directory: id.to_owned(),
        runtime: None,
        inspect_port: None,
    });
}

#[tokio::test]
async fn a_window_coalesces_starts_with_finishes_and_caps_a_burst_with_exact_stats() {
    let suite = Suite::starting();
    let topic = suite.topic("functions.events");
    let mut stream = topic.open(&json!({}), None).expect("opened");
    // The replay is empty: a cursor first, so the subscription can resume.
    next_cursor(&mut stream).await;
    let monitor = suite.monitor();
    for index in 0..60 {
        let function = if index < 59 {
            "us-central1-api"
        } else {
            "us-central1-other"
        };
        let token = begin(
            monitor,
            function,
            FunctionKind::Http,
            InvocationCause::Unknown,
            &[],
        );
        finish(monitor, &token, 200);
    }
    let (name, batch) = next_event(&mut stream).await;
    assert_eq!(name, "batch");
    let items = batch["items"].as_array().expect("items");
    assert_eq!(items.len(), 50);
    assert_eq!(batch["burst"], 10);
    // Each row is the finished one, newest last.
    assert!(items.iter().all(|item| item["outcomeClass"] == "succeeded"));
    assert_eq!(items[49]["seq"], 60);
    assert_eq!(items[0]["seq"], 11);
    let stats = batch["stats"].as_array().expect("stats");
    assert_eq!(stats.len(), 2);
    let api = stats
        .iter()
        .find(|entry| entry["functionId"] == "us-central1-api")
        .expect("api stats");
    assert_eq!(api["stats"]["runs"], 59);
    assert_eq!(api["stats"]["inFlight"], 0);
    assert_eq!(api["stats"]["last"]["seq"], 59);
    // The hand-written stats entry is the type's own JSON.
    let typed = FunctionStatsEntry {
        function_id: "us-central1-api".to_owned(),
        stats: suite.monitor().stats("us-central1-api"),
    };
    // (through text both ways: the parser may round a float's last digit)
    let typed: Value =
        serde_json::from_str(&serde_json::to_string(&typed).expect("json")).expect("parsed");
    assert_eq!(api, &typed);
    assert_eq!(batch["changes"], json!([]));
}

#[tokio::test]
async fn subscriptions_filter_by_function_codebase_q_and_changes_only() {
    let suite = Suite::starting();
    let topic = suite.topic("functions.events");
    let mut by_function = topic
        .open(&json!({"function": "us-central1-onOrder"}), None)
        .expect("opened");
    let mut failed = topic
        .open(&json!({"q": "outcome:failed"}), None)
        .expect("opened");
    let mut changes = topic
        .open(&json!({"changesOnly": true}), None)
        .expect("opened");
    let mut jobs = topic
        .open(&json!({"codebase": "jobs"}), None)
        .expect("opened");
    for stream in [&mut by_function, &mut failed, &mut changes, &mut jobs] {
        next_cursor(stream).await;
    }
    register(&suite, "default");
    let monitor = suite.monitor();
    let api = begin(
        monitor,
        "us-central1-api",
        FunctionKind::Http,
        InvocationCause::Unknown,
        &[],
    );
    finish(monitor, &api, 500);
    let order = begin(
        monitor,
        "us-central1-onOrder",
        FunctionKind::Firestore,
        InvocationCause::Unknown,
        &[],
    );
    finish(monitor, &order, 204);

    let (_, batch) = next_event(&mut by_function).await;
    let rows: Vec<&str> = batch["items"]
        .as_array()
        .expect("items")
        .iter()
        .map(|item| item["functionId"].as_str().unwrap_or_default())
        .collect();
    assert_eq!(rows, ["us-central1-onOrder"]);
    assert_eq!(batch["changes"][0]["kind"], "codebase", "{batch}");

    let (_, batch) = next_event(&mut failed).await;
    assert_eq!(batch["items"].as_array().map(Vec::len), Some(1));
    assert_eq!(batch["items"][0]["functionId"], "us-central1-api");

    let (_, batch) = next_event(&mut changes).await;
    assert_eq!(batch["items"], json!([]));
    assert_eq!(batch["stats"], json!([]));
    assert_eq!(batch["changes"][0]["codebase"]["codebase"]["id"], "default");

    // Nothing of codebase `jobs` happened.
    quiet(&mut jobs).await;
}

#[tokio::test]
async fn a_bad_filter_or_an_unknown_parameter_is_refused_when_subscribing() {
    let suite = Suite::starting();
    let topic = suite.topic("functions.events");
    let error = topic
        .open(&json!({"q": "fn:a nope:b"}), None)
        .err()
        .expect("refused");
    assert_eq!(
        error.detail().code,
        crate::api_error::ErrorCode::InvalidArgument
    );
    let body = serde_json::to_value(crate::api_error::ApiErrorBody {
        error: error.detail().clone(),
    })
    .expect("json");
    assert!(
        body["error"]["message"]
            .as_str()
            .is_some_and(|message| message.contains("Unknown filter")),
        "{body}"
    );
    let error = topic
        .open(&json!({"functon": "x"}), None)
        .err()
        .expect("refused");
    assert!(
        error.detail().message.contains("not valid"),
        "{}",
        error.detail().message
    );
    let events = suite.topic("eventarc.events");
    assert!(events.open(&json!({"q": "kind:x"}), None).is_err());
    assert!(
        suite
            .topic("extensions.changes")
            .open(&json!({"x": 1}), None)
            .is_err()
    );
}

#[tokio::test]
async fn resuming_after_the_snapshots_cursor_replays_exactly_what_came_after() {
    let suite = Suite::starting();
    let monitor = suite.monitor();
    // Rings fill only once the section's live state exists.
    let topic = suite.topic("functions.events");
    for _ in 0..3 {
        let token = begin(
            monitor,
            "us-central1-api",
            FunctionKind::Http,
            InvocationCause::Unknown,
            &[],
        );
        finish(monitor, &token, 200);
    }
    let (_, snapshot) = suite.get("/functions").await;
    let cursor = snapshot["liveCursor"]
        .as_str()
        .expect("a cursor")
        .to_owned();
    for _ in 0..2 {
        let token = begin(
            monitor,
            "us-central1-api",
            FunctionKind::Http,
            InvocationCause::Unknown,
            &[],
        );
        finish(monitor, &token, 200);
    }
    let mut stream = topic.open(&json!({}), Some(&cursor)).expect("opened");
    let (_, batch) = next_event(&mut stream).await;
    let seqs: Vec<u64> = batch["items"]
        .as_array()
        .expect("items")
        .iter()
        .filter_map(|item| item["seq"].as_u64())
        .collect();
    assert_eq!(seqs, [4, 5]);
    assert_eq!(batch["stats"][0]["stats"]["runs"], 5);
}

#[tokio::test]
async fn one_invocation_streams_its_snapshot_lines_chunks_and_end() {
    let suite = Suite::starting();
    let monitor = suite.monitor();
    let token = begin(
        monitor,
        "us-central1-api",
        FunctionKind::Http,
        InvocationCause::Unknown,
        &[],
    );
    let topic = suite.topic("functions.invocation");
    let mut stream = topic
        .open(&json!({"id": token.id.to_string()}), None)
        .expect("opened");
    let (name, snapshot) = next_event(&mut stream).await;
    assert_eq!(name, "snapshot");
    assert_eq!(snapshot["detail"]["summary"]["id"], token.id.as_ref());
    assert_eq!(snapshot["detail"]["summary"]["outcomeClass"], "running");
    assert_eq!(snapshot["refs"][0]["kind"], "functions.function");
    monitor.log(
        &LogEvent::new("INFO", "functions", "hello from the handler".to_owned())
            .with_execution(token.id.to_string())
            .with_stream(LogStream::Stdout),
    );
    let (name, lines) = next_event(&mut stream).await;
    assert_eq!(name, "log");
    assert_eq!(lines[0]["message"], "hello from the handler");
    monitor.response_head(&token, 200, &axum::http::HeaderMap::new());
    monitor.response_chunk(&token, b"partial ");
    let (name, chunks) = next_event(&mut stream).await;
    assert_eq!(name, "chunk");
    assert_eq!(chunks[0]["text"], "partial ");
    monitor.response_chunk(&token, b"answer");
    monitor.finish(
        &token,
        firenook_functions_runtime::monitor::InvocationEnd::default(),
    );
    let mut names = Vec::new();
    loop {
        let event = tokio::time::timeout(Duration::from_secs(5), stream.next())
            .await
            .expect("in time");
        match event {
            Some(TopicEvent::Event { name, data, .. }) => {
                if name == "chunk" {
                    let chunks: Value = serde_json::from_str(&data).expect("json");
                    assert_eq!(chunks[0]["text"], "answer");
                }
                if name == "finished" {
                    let summary: Value = serde_json::from_str(&data).expect("json");
                    assert_eq!(summary["outcome"], "succeeded");
                }
                names.push(name);
            }
            Some(TopicEvent::End(None)) => break,
            other => panic!("unexpected {other:?}"),
        }
    }
    assert_eq!(names, ["chunk", "finished"]);
    assert!(stream.next().await.is_none(), "the topic ends");

    // A finished invocation's subscription is its snapshot and its end.
    let mut stream = topic
        .open(&json!({"id": token.id.to_string()}), None)
        .expect("opened");
    let (name, _) = next_event(&mut stream).await;
    assert_eq!(name, "snapshot");
    let (name, _) = next_event(&mut stream).await;
    assert_eq!(name, "finished");
    assert!(matches!(stream.next().await, Some(TopicEvent::End(None))));

    let error = topic
        .open(&json!({"id": format!("{}-999", monitor.nonce())}), None)
        .err()
        .expect("not kept");
    assert_eq!(
        error.detail().message,
        "The engine no longer keeps invocation #999; it keeps the newest 2,000."
    );
}

#[tokio::test]
async fn a_codebase_log_carries_only_that_codebases_lines() {
    let suite = Suite::starting();
    register(&suite, "default");
    register(&suite, "jobs");
    let topic = suite.topic("functions.codebase-log");
    let mut stream = topic
        .open(&json!({"codebase": "jobs"}), None)
        .expect("opened");
    next_cursor(&mut stream).await;
    let monitor = suite.monitor();
    for (codebase, message) in [
        ("default", "not this one"),
        ("jobs", "loaded the jobs module"),
    ] {
        monitor.log(
            &LogEvent::new("INFO", "functions", message.to_owned())
                .with_codebase(codebase.to_owned())
                .with_stream(LogStream::Stdout),
        );
    }
    let (name, lines) = next_event(&mut stream).await;
    assert_eq!(name, "lines");
    let messages: Vec<&str> = lines["items"]
        .as_array()
        .expect("items")
        .iter()
        .map(|line| line["message"].as_str().unwrap_or_default())
        .collect();
    assert_eq!(messages, ["loaded the jobs module"]);
    let (_, log) = suite.get("/functions/codebases/jobs/log").await;
    assert_eq!(log["lines"][0]["message"], "loaded the jobs module");
    assert!(
        topic.open(&json!({"codebase": "nothing"}), None).is_err(),
        "an unknown codebase is refused"
    );
}

#[tokio::test]
async fn an_events_row_is_replaced_when_one_of_its_deliveries_changes() {
    let suite = Suite::starting();
    let topic = suite.topic("eventarc.events");
    let mut stream = topic
        .open(&json!({"channel": CHANNEL}), None)
        .expect("opened");
    let mut elsewhere = topic
        .open(&json!({"channel": "google"}), None)
        .expect("opened");
    next_cursor(&mut stream).await;
    next_cursor(&mut elsewhere).await;
    let monitor = suite.monitor();
    let recorded = monitor.event_received(EventReceived {
        channel: CHANNEL.to_owned(),
        raw: json!({"id": "g-1", "type": "test.greeter.v1.greeted"}),
        converted: Ok(
            json!({"id": "g-1", "type": "test.greeter.v1.greeted", "specversion": "1.0",
            "source": "projects/demo-compute/instances/greeter", "data": {}}),
        ),
        origin: EventarcOrigin::App,
        replay_of: None,
        deliveries: vec![DeliveryPlan {
            trigger_key: "us-central1-onGreeted-0".to_owned(),
            function_id: Some("us-central1-onGreeted".to_owned()),
            mismatches: Vec::new(),
        }],
    });
    let token = monitor.begin(InvocationStart {
        function_id: "us-central1-onGreeted".to_owned(),
        codebase: "default".to_owned(),
        kind: FunctionKind::Eventarc,
        origin: InvocationOrigin::Emulator,
        cause: InvocationCause::Unknown,
        summary: String::new(),
        target: InvocationTarget::Trigger,
        method: "POST".to_owned(),
        path: "/".to_owned(),
        headers: axum::http::HeaderMap::new(),
        body: axum::body::Bytes::new(),
        replay_of: None,
        delivery: Some((recorded.seq, 0)),
    });
    finish(monitor, &token, 204);
    let (name, batch) = next_event(&mut stream).await;
    assert_eq!(name, "batch");
    let items = batch["items"].as_array().expect("items");
    assert_eq!(items.len(), 1, "{batch}");
    assert_eq!(items[0]["id"], recorded.id);
    assert_eq!(items[0]["delivered"], 1);
    assert_eq!(items[0]["pending"], 0);
    assert_eq!(batch["burst"], Value::Null);
    quiet(&mut elsewhere).await;
}

#[tokio::test]
async fn extension_changes_arrive_as_deduplicated_keys() {
    let suite = Suite::starting();
    let topic = suite.topic("extensions.changes");
    let mut stream = topic.open(&json!({}), None).expect("opened");
    let monitor = suite.monitor();
    for id in ["greeter", "greeter", "translator", "greeter"] {
        monitor.extension_changed(id);
    }
    let (name, changed) = next_event(&mut stream).await;
    assert_eq!(name, "changed");
    assert_eq!(changed, json!({"instanceIds": ["greeter", "translator"]}));
}
