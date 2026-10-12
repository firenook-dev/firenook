use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode};
use firenook_suite_front::{
    ConsoleSink as _, LogInput, OverviewConnection, OverviewEngineConfig, OverviewEnvSource,
    OverviewEnvVariable, OverviewNoticeLevel, RingBudget, kinds,
};
use serde_json::{Value, json};
use tower::ServiceExt as _;

use super::*;

fn log() -> ConsoleLog {
    ConsoleLog::with_budget(&RingBudget::new(1 << 32))
}

fn line(level: LogLevel, message: &str) -> LogInput {
    LogInput {
        level,
        service: "functions".to_owned(),
        message: message.to_owned(),
        ..LogInput::default()
    }
}

fn engine() -> OverviewEngineDetails {
    OverviewEngineDetails {
        config: Some(OverviewEngineConfig {
            host: "127.0.0.1".to_owned(),
            connect_host: "127.0.0.1".to_owned(),
            project_dir: "/work/app".to_owned(),
            firebase_json: "/work/app/firebase.json".to_owned(),
            diagnostics: true,
            debug_log: None,
            single_project_mode: true,
            offline: false,
            demo_project: true,
            node: "/usr/bin/node".to_owned(),
            default_bucket: "demo-app.appspot.com".to_owned(),
            selected: Vec::new(),
        }),
        connection: OverviewConnection {
            env: vec![OverviewEnvVariable {
                name: "FIRESTORE_EMULATOR_HOST".to_owned(),
                value: "127.0.0.1:8080".to_owned(),
                service: "firestore".to_owned(),
                set_by: OverviewEnvSource::Exec,
                note: None,
            }],
        },
    }
}

fn api(log: Option<&ConsoleLog>) -> OverviewApi {
    OverviewApi {
        log: log.cloned(),
        engine: Arc::new(engine()),
        notices: Arc::new(vec![OverviewNotice {
            level: OverviewNoticeLevel::Warn,
            code: "publicHost".to_owned(),
            message: "The emulators listen on 0.0.0.0.".to_owned(),
        }]),
    }
}

async fn get(router: Router, uri: &str) -> (StatusCode, Value) {
    let response = router
        .oneshot(Request::get(uri).body(Body::empty()).expect("request"))
        .await
        .expect("response");
    let status = response.status();
    let body = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body");
    (status, serde_json::from_slice(&body).expect("json"))
}

#[tokio::test]
async fn the_state_lists_notices_the_newest_problems_the_hour_and_the_totals() {
    let log = log();
    log.accept(line(LogLevel::Info, "fine"));
    log.accept(LogInput {
        kind: Some(kinds::FUNCTION_FAILED),
        source: Some("functions[us-central1-hello]".to_owned()),
        ..line(
            LogLevel::Error,
            &format!("{}\n    at handler (index.js:3:9)", "x".repeat(300)),
        )
    });
    for index in 0..9 {
        log.accept(line(LogLevel::Warn, &format!("slow {index}")));
        log.accept(LogInput {
            kind: Some(kinds::RULES_DENIED),
            ..line(LogLevel::Warn, &format!("denied {index}"))
        });
    }
    let (status, state) = get(router(api(Some(&log))), "/overview").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(state["notices"][0]["code"], "publicHost");
    assert_eq!(state["notices"][0]["level"], "warn");
    let problems = state["problems"].as_array().expect("problems");
    assert_eq!(problems.len(), 8);
    // Newest first, problems only: the plain warnings are not problems.
    assert_eq!(problems[0]["firstLine"], "denied 8");
    assert_eq!(problems[7]["firstLine"], "denied 1");
    assert_eq!(problems[0]["kind"], "rules.denied");
    assert_eq!(problems[0]["source"], "functions");
    assert_eq!(state["hour"].as_array().expect("hour").len(), 60);
    let minute = &state["hour"][59];
    assert_eq!(minute["error"], 1);
    assert_eq!(minute["warn"], 18);
    assert_eq!(
        state["logs"],
        json!({ "entries": 20, "errors": 1, "warnings": 18, "problems": 10 })
    );
    // An older problem keeps only its first line, cut at 200 characters.
    let all = api(Some(&log)).state(now_millis());
    let failed = OverviewApi {
        log: Some(log.clone()),
        ..api(None)
    };
    assert_eq!(all.problems.len(), 8);
    let error = log.recent_problems(100);
    let entry: LogEntry =
        serde_json::from_str(&error.last().expect("the error").json).expect("entry");
    let shown = problem(entry);
    assert_eq!(shown.first_line.chars().count(), FIRST_LINE_CHARS);
    assert_eq!(shown.source, "functions[us-central1-hello]");
    assert_eq!(failed.state(now_millis()).logs.errors, 1);
}

#[test]
fn a_problem_names_the_function_or_instance_that_printed_it() {
    let log = log();
    // An attributed line: printed under `functions`, naming its function.
    log.accept(LogInput {
        function: Some("us-central1-fails".to_owned()),
        execution: Some("a1b2c3-1".to_owned()),
        service: "functions".to_owned(),
        ..line(LogLevel::Error, "TypeError: cannot read 'id' of undefined")
    });
    log.accept(LogInput {
        extension: Some("greeter".to_owned()),
        service: "functions".to_owned(),
        ..line(LogLevel::Error, "greeting failed")
    });
    let sources: Vec<String> = api(Some(&log))
        .state(now_millis())
        .problems
        .into_iter()
        .map(|problem| problem.source)
        .collect();
    assert_eq!(
        sources,
        ["extensions[greeter]", "functions[us-central1-fails]"]
    );
}

#[tokio::test]
async fn without_a_suite_log_the_state_still_answers() {
    let (status, state) = get(router(api(None)), "/overview").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(state["problems"], json!([]));
    assert_eq!(state["logs"]["entries"], 0);
    assert_eq!(state["hour"].as_array().expect("hour").len(), 60);
}

#[tokio::test]
async fn the_engine_details_never_repeat_a_data_fact() {
    let (status, details) = get(router(api(None)), "/overview/engine").await;
    assert_eq!(status, StatusCode::OK);
    let config = details["config"].as_object().expect("config");
    let keys: Vec<&str> = config.keys().map(String::as_str).collect();
    for fact in [
        "stateDir",
        "resumed",
        "importedFrom",
        "exportOnExit",
        "durability",
        "mode",
    ] {
        assert!(!keys.contains(&fact), "{fact} is a data fact: {keys:?}");
    }
    for key in [
        "host",
        "connectHost",
        "projectDir",
        "firebaseJson",
        "diagnostics",
        "debugLog",
        "singleProjectMode",
        "offline",
        "demoProject",
        "node",
        "defaultBucket",
        "selected",
    ] {
        assert!(keys.contains(&key), "{key} missing: {keys:?}");
    }
    assert_eq!(details["connection"]["env"][0]["setBy"], "exec");
    assert_eq!(details["connection"]["env"][0]["note"], Value::Null);
}

async fn next_state(stream: &mut TopicStream) -> (String, Value) {
    match tokio::time::timeout(Duration::from_secs(5), stream.next())
        .await
        .expect("a state in time")
        .expect("the topic goes on")
    {
        TopicEvent::Event { name, cursor, data } => {
            assert_eq!(name, "state");
            (
                cursor.expect("a generation").to_string(),
                serde_json::from_str(&data).expect("json"),
            )
        }
        other => panic!("unexpected {other:?}"),
    }
}

#[tokio::test]
async fn the_topic_sends_the_state_then_each_change_and_resumes_by_comparing() {
    let log = log();
    let topic = OverviewTopic {
        api: api(Some(&log)),
    };
    let mut stream = topic.open(&json!({}), None).expect("opened");
    let (generation, state) = next_state(&mut stream).await;
    assert_eq!(state["logs"]["entries"], 0);
    log.accept(line(LogLevel::Error, "boom"));
    let (later, state) = next_state(&mut stream).await;
    assert_ne!(later, generation);
    assert_eq!(state["logs"]["errors"], 1);
    // A subscriber that has this generation is sent nothing until it moves.
    let mut resumed = topic.open(&json!({}), Some(&later)).expect("opened");
    let quiet = tokio::time::timeout(Duration::from_millis(200), resumed.next()).await;
    assert!(quiet.is_err(), "nothing new to send");
    log.accept(line(LogLevel::Warn, "again"));
    let (_, state) = next_state(&mut resumed).await;
    assert_eq!(state["logs"]["warnings"], 1);
    let refused = topic
        .open(&json!({ "extra": true }), None)
        .err()
        .expect("refused");
    assert_eq!(refused.status(), StatusCode::BAD_REQUEST);
    assert_eq!(topic.name(), "overview");
}
