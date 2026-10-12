use std::time::Duration;

use axum::body::to_bytes;
use axum::http::{Request, StatusCode};
use firenook_suite_front::{ConsoleSink as _, LogInput, LogLevel, RingBudget, kinds};
use serde_json::{Value, json};
use tower::ServiceExt as _;

use super::*;
use crate::observe::log::CONSOLE_LOG_ENTRIES;

fn running() -> Shutdown {
    let (stop, receiver) = tokio::sync::watch::channel(false);
    std::mem::forget(stop);
    Shutdown::new(receiver)
}

fn log() -> ConsoleLog {
    ConsoleLog::with_budget(&RingBudget::new(1 << 32))
}

fn api(log: &ConsoleLog) -> Router {
    router(LogsApi {
        log: Some(log.clone()),
        project: Arc::from("demo-logs"),
        shutdown: running(),
    })
}

fn line(level: LogLevel, service: &str, message: &str) -> LogInput {
    LogInput {
        level,
        service: service.to_owned(),
        message: message.to_owned(),
        ..LogInput::default()
    }
}

async fn get(router: &Router, uri: &str) -> (StatusCode, axum::http::HeaderMap, Vec<u8>) {
    let response = router
        .clone()
        .oneshot(Request::get(uri).body(Body::empty()).expect("request"))
        .await
        .expect("response");
    let status = response.status();
    let headers = response.headers().clone();
    let body = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body")
        .to_vec();
    (status, headers, body)
}

async fn json(router: &Router, uri: &str) -> (StatusCode, Value) {
    let (status, _, body) = get(router, uri).await;
    (
        status,
        serde_json::from_slice(&body).expect("a JSON answer"),
    )
}

async fn page(router: &Router, uri: &str) -> LogPage {
    let (status, _, body) = get(router, uri).await;
    assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&body));
    serde_json::from_slice(&body).expect("a LogPage")
}

fn messages(page: &LogPage) -> Vec<&str> {
    page.items
        .iter()
        .map(|item| item.message.as_str())
        .collect()
}

fn ten_lines() -> ConsoleLog {
    let log = log();
    for index in 1..=10 {
        let level = if index % 2 == 0 {
            LogLevel::Warn
        } else {
            LogLevel::Info
        };
        log.accept(line(level, "hub", &format!("line {index}")));
    }
    log
}

fn at(log: &ConsoleLog, seq: u64) -> String {
    Cursor {
        epoch: log.epoch(),
        seq,
    }
    .to_string()
}

#[tokio::test]
async fn a_page_assembled_from_stored_entries_equals_the_value_built_one() {
    let log = ten_lines();
    let router = api(&log);
    let (status, headers, body) = get(&router, "/logs/entries?limit=3").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers[header::CONTENT_TYPE], "application/json");
    let assembled: LogPage = serde_json::from_slice(&body).expect("a LogPage");
    let built = LogPage {
        items: log.lines(false)[7..]
            .iter()
            .map(|line| serde_json::from_str(&line.json).expect("entry"))
            .collect(),
        older: Some(at(&log, 8)),
        newer: None,
        tail: at(&log, 10),
        anchor: None,
    };
    assert_eq!(assembled, built);
    // And the body is exactly what serializing the value would write.
    assert_eq!(
        serde_json::from_slice::<Value>(&body).expect("json"),
        serde_json::to_value(&built).expect("json")
    );
}

#[tokio::test]
async fn pages_move_before_after_and_around_a_cursor() {
    let log = ten_lines();
    let router = api(&log);
    let older = page(
        &router,
        &format!("/logs/entries?limit=3&before={}", at(&log, 8)),
    )
    .await;
    assert_eq!(messages(&older), ["line 5", "line 6", "line 7"]);
    assert_eq!(older.older, Some(at(&log, 5)));
    assert_eq!(older.newer, Some(at(&log, 7)));
    let forward = page(
        &router,
        &format!("/logs/entries?q=level:warn&after={}&limit=2", at(&log, 3)),
    )
    .await;
    assert_eq!(messages(&forward), ["line 4", "line 6"]);
    assert_eq!(forward.newer, Some(at(&log, 6)));
    assert_eq!(forward.older, Some(at(&log, 4)));
    let empty = page(
        &router,
        &format!("/logs/entries?q=level:warn&after={}", at(&log, 10)),
    )
    .await;
    assert_eq!(empty.items, Vec::<LogEntry>::new());
    assert_eq!(empty.older, Some(at(&log, 11)));
    assert_eq!(empty.newer, None);
    let around = page(
        &router,
        &format!("/logs/entries?q=level:warn&around={}&each=1", at(&log, 5)),
    )
    .await;
    assert_eq!(messages(&around), ["line 4", "line 5", "line 6"]);
    assert_eq!(around.anchor, Some(at(&log, 5)));
    assert_eq!(around.tail, at(&log, 10));
}

#[tokio::test]
async fn parameter_errors_carry_the_field_message_and_the_span() {
    let log = ten_lines();
    let router = api(&log);
    let (status, body) = json(&router, "/logs/entries?q=ok%20level:warning").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"]["code"], "invalid-argument");
    assert_eq!(
        body["error"]["message"],
        "\"level:\" is one of debug, info, warn, error."
    );
    assert_eq!(body["span"], json!({ "from": 3, "to": 16 }));
    let (status, body) = json(&router, "/logs/entries?q=%2F(%3F%3Dx)%2F").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(
        body["error"]["message"]
            .as_str()
            .expect("message")
            .contains("look-around"),
        "{body}"
    );
    assert_eq!(body["span"], json!({ "from": 0, "to": 7 }));
    for (uri, message) in [
        (
            "/logs/entries?limit=0".to_owned(),
            "`limit` is a number from 1 to 2000.",
        ),
        (
            "/logs/entries?each=501".to_owned(),
            "`each` is a number from 1 to 500.",
        ),
        (
            "/logs/entries?before=nope".to_owned(),
            "This cursor is not one this engine wrote.",
        ),
        (
            format!("/logs/entries?before={}&after={}", at(&log, 2), at(&log, 1)),
            "Use one of `before`, `after` and `around` in one request.",
        ),
        (
            "/logs/entries?from=yesterday".to_owned(),
            "`from` needs a time, like -5m, 2026-10-12T04:00:00Z or today, or reload.",
        ),
        (
            "/logs/histogram?buckets=241".to_owned(),
            "`buckets` is a number from 1 to 240.",
        ),
        (
            "/logs/entries:export?format=csv".to_owned(),
            "`format` is ndjson or text, not `csv`.",
        ),
    ] {
        let (status, body) = json(&router, &uri).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{uri}");
        assert_eq!(body["error"]["message"], message, "{uri}");
    }
}

#[tokio::test]
async fn one_line_by_cursor_or_why_it_is_gone() {
    let log = log();
    for index in 0..CONSOLE_LOG_ENTRIES + 5 {
        log.accept(line(LogLevel::Info, "hub", &format!("{index}")));
    }
    let router = api(&log);
    let newest = at(&log, u64::try_from(CONSOLE_LOG_ENTRIES).expect("fits") + 5);
    let (status, body) = json(&router, &format!("/logs/entries/{newest}")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["cursor"], newest);
    let evicted = at(&log, 2);
    let (status, body) = json(&router, &format!("/logs/entries/{evicted}")).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(
        body["error"]["message"],
        format!("The engine no longer keeps line {evicted}; it keeps the newest 20,000.")
    );
    let foreign = Cursor {
        epoch: log.epoch().wrapping_add(1),
        seq: 3,
    };
    let (status, body) = json(&router, &format!("/logs/entries/{foreign}")).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(
        body["error"]["message"],
        "This line was logged by an earlier run of the engine."
    );
    let (status, _) = json(&router, "/logs/entries/not-a-cursor").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let future = at(&log, 999_999);
    let (status, body) = json(&router, &format!("/logs/entries/{future}")).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(
        body["error"]["message"],
        format!("No line {future} has been logged yet.")
    );
}

#[tokio::test]
async fn the_export_streams_every_matching_line_as_a_file() {
    let log = log();
    log.accept(LogInput {
        source: Some("functions[us-central1-hello]".to_owned()),
        payload: Some(json!({ "cartId": "c_19" })),
        ..line(LogLevel::Warn, "functions", "Cart is empty")
    });
    log.accept(line(LogLevel::Info, "hub", "first\nsecond"));
    log.accept(line(LogLevel::Debug, "auth", "quiet"));
    let router = api(&log);
    let (status, headers, body) = get(
        &router,
        "/logs/entries:export?q=-service:auth&format=ndjson",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers[header::CONTENT_TYPE], "application/x-ndjson");
    let disposition = headers[header::CONTENT_DISPOSITION]
        .to_str()
        .expect("ascii");
    assert!(
        disposition.starts_with("attachment; filename=\"firenook-logs-demo-logs-"),
        "{disposition}"
    );
    assert!(disposition.contains(".ndjson\""), "{disposition}");
    let text = String::from_utf8(body).expect("utf-8");
    let lines: Vec<LogEntry> = text
        .lines()
        .map(|line| serde_json::from_str(line).expect("one entry per line"))
        .collect();
    assert_eq!(lines.len(), 2);
    assert_eq!(lines[0].message, "Cart is empty");
    let (_, headers, body) = get(&router, "/logs/entries:export?format=text").await;
    assert!(
        headers[header::CONTENT_DISPOSITION]
            .to_str()
            .expect("ascii")
            .contains(".txt\"")
    );
    let text = String::from_utf8(body).expect("utf-8");
    let lines: Vec<&str> = text.lines().collect();
    assert!(
        lines[0].ends_with(" WARN  functions[us-central1-hello] Cart is empty"),
        "{text}"
    );
    assert_eq!(lines[1], "    {\"cartId\":\"c_19\"}");
    assert!(lines[2].ends_with(" INFO  hub first"), "{text}");
    assert_eq!(lines[3], "    second");
    assert!(lines[4].ends_with(" DEBUG auth quiet"), "{text}");
}

#[tokio::test]
async fn facets_and_the_histogram_answer_for_the_filter() {
    let log = ten_lines();
    let router = api(&log);
    let (status, facets) = json(&router, "/logs/facets?q=level:warn").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(facets["kept"], 10);
    assert_eq!(facets["matched"], 5);
    assert_eq!(
        facets["levels"],
        json!([
            { "value": "debug", "count": 0 },
            { "value": "info", "count": 5 },
            { "value": "warn", "count": 5 },
            { "value": "error", "count": 0 },
        ])
    );
    assert_eq!(facets["services"], json!([{ "value": "hub", "count": 5 }]));
    assert_eq!(facets["internalHidden"], 0);
    let (status, histogram) = json(&router, "/logs/histogram?buckets=5").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(histogram["buckets"].as_array().expect("buckets").len(), 5);
    let total: u64 = histogram["buckets"]
        .as_array()
        .expect("buckets")
        .iter()
        .map(|bucket| {
            ["debug", "info", "warn", "error"]
                .iter()
                .map(|level| bucket[level].as_u64().expect("count"))
                .sum::<u64>()
        })
        .sum();
    assert_eq!(total, 10);
    assert!(histogram["bucketMs"].as_u64().expect("bucket") >= 1);
}

#[tokio::test]
async fn a_console_without_a_suite_log_says_so() {
    let router = router(LogsApi {
        log: None,
        project: Arc::from("demo-logs"),
        shutdown: running(),
    });
    for uri in [
        "/logs/entries",
        "/logs/facets",
        "/logs/histogram",
        "/logs/entries:export",
    ] {
        let (status, body) = json(&router, uri).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{uri}");
        assert_eq!(
            body["error"]["message"],
            "This console runs without a suite log."
        );
    }
    let refused = LogsTopic { log: None }
        .open(&json!({}), None)
        .err()
        .expect("refused");
    assert_eq!(refused.status(), StatusCode::SERVICE_UNAVAILABLE);
}

#[derive(Debug, PartialEq)]
enum Seen {
    Items(String, Vec<String>),
    Tick(String),
    Reset(ResetReason, Option<u64>),
}

async fn next(stream: &mut TopicStream) -> Seen {
    match tokio::time::timeout(Duration::from_secs(30), stream.next())
        .await
        .expect("an event in time")
        .expect("the stream goes on")
    {
        TopicEvent::Event {
            name: "tick",
            cursor,
            ..
        } => Seen::Tick(cursor.expect("a cursor").to_string()),
        TopicEvent::Event { name, cursor, data } => {
            assert_eq!(name, "entries");
            let data: Value = serde_json::from_str(&data).expect("json");
            let items = data["items"]
                .as_array()
                .expect("items")
                .iter()
                .map(|item| item["message"].as_str().expect("message").to_owned())
                .collect();
            Seen::Items(cursor.expect("a cursor").to_string(), items)
        }
        TopicEvent::Reset { reason, missed } => Seen::Reset(reason, missed),
        TopicEvent::End(_) => panic!("the log never ends"),
    }
}

fn open(log: &ConsoleLog, params: &Value, after: Option<&str>) -> TopicStream {
    LogsTopic {
        log: Some(log.clone()),
    }
    .open(params, after)
    .expect("opened")
}

#[tokio::test(start_paused = true)]
async fn the_topic_replays_after_a_cursor_and_follows() {
    let log = ten_lines();
    let mut stream = open(&log, &json!({ "q": "level:warn" }), Some(&at(&log, 6)));
    assert_eq!(
        next(&mut stream).await,
        Seen::Items(
            at(&log, 10),
            vec!["line 8".to_owned(), "line 10".to_owned()]
        )
    );
    log.accept(line(LogLevel::Warn, "hub", "line 11"));
    log.accept(line(LogLevel::Info, "hub", "line 12"));
    // The window's cursor is the last line it consumed, matched or not.
    assert_eq!(
        next(&mut stream).await,
        Seen::Items(at(&log, 12), vec!["line 11".to_owned()])
    );
}

#[tokio::test(start_paused = true)]
async fn a_stale_cursor_is_a_gap_with_what_was_missed() {
    let log = log();
    for index in 0..CONSOLE_LOG_ENTRIES + 10 {
        log.accept(line(LogLevel::Info, "hub", &format!("{index}")));
    }
    let mut stale = open(&log, &json!({}), Some(&at(&log, 5)));
    assert_eq!(
        next(&mut stale).await,
        Seen::Reset(ResetReason::Gap, Some(5))
    );
    let foreign = Cursor {
        epoch: log.epoch().wrapping_add(1),
        seq: 5,
    }
    .to_string();
    let mut other_run = open(&log, &json!({}), Some(&foreign));
    assert_eq!(
        next(&mut other_run).await,
        Seen::Reset(ResetReason::Gap, None)
    );
}

#[tokio::test(start_paused = true)]
async fn a_narrow_filter_moves_the_cursor_with_ticks() {
    let log = log();
    let mut stream = open(&log, &json!({ "q": "level:error" }), Some(&at(&log, 0)));
    assert_eq!(next(&mut stream).await, Seen::Tick(at(&log, 0)));
    for index in 0..1_000 {
        log.accept(line(LogLevel::Info, "hub", &format!("{index}")));
    }
    assert_eq!(next(&mut stream).await, Seen::Tick(at(&log, 1_000)));
}

#[tokio::test(start_paused = true)]
async fn batches_hold_at_most_a_thousand_lines_and_512_kib() {
    let small = log();
    for index in 0..1_500 {
        small.accept(line(LogLevel::Info, "hub", &format!("{index}")));
    }
    let mut stream = open(&small, &json!({}), None);
    let Seen::Items(_, first) = next(&mut stream).await else {
        panic!("items first");
    };
    assert_eq!(first.len(), 1_000);
    let Seen::Items(_, second) = next(&mut stream).await else {
        panic!("then the rest");
    };
    assert_eq!(second.len(), 500);
    let large = log();
    for index in 0..100 {
        large.accept(line(
            LogLevel::Info,
            "hub",
            &format!("{index} {}", "z".repeat(16 * 1024)),
        ));
    }
    let mut stream = open(&large, &json!({}), None);
    let mut total = 0;
    while total < 100 {
        let TopicEvent::Event { data, .. } = stream.next().await.expect("an event") else {
            panic!("items");
        };
        assert!(data.len() <= 512 * 1024 + 64 * 1024, "{}", data.len());
        let items: Value = serde_json::from_str(&data).expect("json");
        total += items["items"].as_array().expect("items").len();
    }
    assert_eq!(total, 100);
}

#[tokio::test(start_paused = true)]
async fn a_problems_only_subscription_replays_from_both_rings() {
    let log = log();
    log.accept(line(LogLevel::Info, "hub", "before"));
    for index in 0..3 {
        log.accept(line(
            LogLevel::Error,
            "functions",
            &format!("error {index}"),
        ));
    }
    log.accept(LogInput {
        kind: Some(kinds::RULES_DENIED),
        ..line(LogLevel::Warn, "firestore", "denied")
    });
    for index in 0..CONSOLE_LOG_ENTRIES {
        log.accept(line(LogLevel::Info, "hub", &format!("noise {index}")));
    }
    // From the start of the run: the evicted errors, then the live tail.
    let mut errors = open(&log, &json!({ "q": "level:error" }), Some(&at(&log, 1)));
    assert_eq!(
        next(&mut errors).await,
        Seen::Items(
            at(&log, 4),
            vec![
                "error 0".to_owned(),
                "error 1".to_owned(),
                "error 2".to_owned()
            ]
        )
    );
    log.accept(line(LogLevel::Error, "functions", "error 3"));
    loop {
        match next(&mut errors).await {
            Seen::Tick(_) => {}
            Seen::Items(_, items) => {
                assert_eq!(items, ["error 3"]);
                break;
            }
            Seen::Reset(reason, missed) => panic!("no gap expected: {reason:?} {missed:?}"),
        }
    }
    // Without a cursor: every retained problem.
    let mut problems = open(&log, &json!({ "q": "is:problem" }), None);
    let Seen::Items(_, items) = next(&mut problems).await else {
        panic!("items");
    };
    assert_eq!(items, ["error 0", "error 1", "error 2", "denied"]);
}

#[test]
fn a_bad_filter_or_parameter_is_refused_when_subscribing() {
    let log = log();
    let topic = LogsTopic {
        log: Some(log.clone()),
    };
    let refused = topic
        .open(&json!({ "q": "level:loud" }), None)
        .err()
        .expect("refused");
    assert_eq!(refused.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        refused.detail().message,
        "\"level:\" is one of debug, info, warn, error."
    );
    let unknown = topic
        .open(&json!({ "query": "x" }), None)
        .err()
        .expect("refused");
    assert!(
        unknown.detail().message.contains("unknown field"),
        "{}",
        unknown.detail().message
    );
    assert_eq!(topic.name(), "logs.entries");
}

#[test]
fn numbers_are_grouped_by_thousands() {
    assert_eq!(grouped(0), "0");
    assert_eq!(grouped(999), "999");
    assert_eq!(grouped(20_000), "20,000");
    assert_eq!(grouped(1_234_567), "1,234,567");
}
