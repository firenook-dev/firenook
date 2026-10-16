use super::*;
use crate::filter::golden;

/// The Logs cases, shared with the console's Vitest.
const CASES: &str = include_str!("../../../../console/src/logs/filter-cases.json");

#[test]
fn every_logs_golden_case_holds() {
    let count = golden::run(CASES);
    assert!(
        count >= 40,
        "the Logs cases file holds {count} cases, fewer than 40"
    );
}

#[test]
fn the_cases_file_declares_exactly_the_engines_fields() {
    let file: Value = serde_json::from_str(CASES).expect("json");
    assert_eq!(file["regex"], true);
    let declared: Vec<Value> = file["fields"]
        .as_array()
        .expect("fields")
        .iter()
        .map(|field| {
            // The file leaves empty lists out; the engine writes them.
            let mut field = field.clone();
            for (name, empty) in [
                ("aliases", serde_json::json!([])),
                ("values", serde_json::json!([])),
                ("valueAliases", serde_json::json!({})),
                ("prefixes", serde_json::json!([])),
            ] {
                if field.get(name).is_none() {
                    field[name] = empty;
                }
            }
            field
        })
        .collect();
    let engine: Vec<Value> = LOG_FIELD_SET
        .infos()
        .iter()
        .map(|info| serde_json::to_value(info).expect("json"))
        .collect();
    assert_eq!(declared, engine);
}

/// The answer body of the error `q` is refused with: `error` and, beside
/// it, the `span` to underline.
async fn refusal(q: &str) -> serde_json::Value {
    use axum::response::IntoResponse as _;
    let error = LogFilter::parse(Some(q), Window::default()).expect_err("refused");
    assert_eq!(error.status(), axum::http::StatusCode::BAD_REQUEST);
    let body = axum::body::to_bytes(error.into_response().into_body(), usize::MAX)
        .await
        .expect("body");
    let mut body: serde_json::Value = serde_json::from_slice(&body).expect("json");
    let span = body["span"].take();
    let mut detail = body["error"].take();
    detail["span"] = span;
    detail
}

#[tokio::test]
async fn regexes_the_engine_cannot_run_are_refused_by_construct_with_their_span() {
    let detail = refusal("level:error /(?=x)y/").await;
    assert_eq!(
        detail["message"],
        "This regular expression uses look-around `(?=`, which the engine's regex syntax does not support."
    );
    assert_eq!(
        detail["fix"],
        "The engine uses Rust's regex syntax: no look-around or backreferences."
    );
    assert_eq!(detail["span"], serde_json::json!({ "from": 12, "to": 20 }));
    let behind = refusal("/(?<!a)b/").await;
    assert!(
        behind["message"]
            .as_str()
            .expect("message")
            .contains("`(?<!`"),
        "{behind}"
    );
    let backreference = refusal("/(a)\\1/").await;
    assert_eq!(
        backreference["message"],
        "This regular expression uses a backreference `\\1`, which the engine's regex syntax does not support."
    );
    let oversized = refusal("/(\\w{100}){100}/").await;
    assert_eq!(
        oversized["message"],
        "This regular expression is too large for the engine to search with."
    );
    assert_eq!(
        oversized["span"],
        serde_json::json!({ "from": 0, "to": 16 })
    );
    let invalid = refusal("/a(b/").await;
    assert!(
        invalid["message"]
            .as_str()
            .expect("message")
            .starts_with("This regular expression is not valid: "),
        "{invalid}"
    );
}

#[tokio::test]
async fn a_bad_term_is_the_grammars_message_with_its_span() {
    let detail = refusal("ok level:warning").await;
    assert_eq!(
        detail["message"],
        "\"level:\" is one of debug, info, warn, error."
    );
    assert_eq!(detail["span"], serde_json::json!({ "from": 3, "to": 16 }));
}

#[test]
fn problems_only_filters_are_recognised() {
    let problems_only = |q: &str| {
        LogFilter::parse(Some(q), Window::default())
            .expect("valid")
            .problems_only()
    };
    assert!(problems_only("is:problem"));
    assert!(problems_only("level:error"));
    assert!(problems_only("level:error service:functions"));
    assert!(problems_only("kind:rules.denied"));
    assert!(problems_only("kind:function.failed kind:function.timeout"));
    assert!(!problems_only(""));
    assert!(!problems_only("level:warn level:error"));
    assert!(!problems_only("-is:problem"));
    // function.start is not a problem kind, so the prefix is not either.
    assert!(!problems_only("kind:function.*"));
    assert!(!problems_only("kind:rules.denied.console"));
    assert!(!problems_only("kind:nothing.*"));
}

#[test]
fn the_window_reads_relative_absolute_and_reload_times() {
    let now = OffsetDateTime::parse(
        "2026-10-12T04:00:00Z",
        &time::format_description::well_known::Rfc3339,
    )
    .expect("now");
    let millis = |text: &str| {
        OffsetDateTime::parse(text, &time::format_description::well_known::Rfc3339)
            .map(|time| i64::try_from(time.unix_timestamp_nanos() / 1_000_000).expect("fits"))
            .expect("time")
    };
    let window = window(Some("-5m"), Some("2026-10-12T04:00:00Z"), None, now).expect("window");
    assert_eq!(window.from_ms, Some(millis("2026-10-12T03:55:00Z")));
    assert_eq!(window.to_ms, Some(millis("2026-10-12T04:00:00Z")));
    assert_eq!(
        super::window(Some("reload"), None, Some(42), now).expect("window"),
        Window {
            from_ms: Some(42),
            to_ms: None
        }
    );
    // Before the first reload, "since the last reload" is every line.
    assert_eq!(
        super::window(Some("reload"), None, None, now).expect("window"),
        Window::default()
    );
    let refused = super::window(Some("yesterday"), None, None, now).expect_err("refused");
    assert_eq!(
        refused.detail().message,
        "`from` needs a time, like -5m, 2026-10-12T04:00:00Z or today, or reload."
    );
    let reversed = super::window(Some("-1m"), Some("-5m"), None, now).expect_err("refused");
    assert_eq!(reversed.detail().message, "`from` is after `to`.");
}
