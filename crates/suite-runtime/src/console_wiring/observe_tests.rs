use std::sync::Mutex;

use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode};
use axum::routing::delete;
use firenook_console_front::{ConsoleServices, ForeignProjects, console_router};
use firenook_core_store::{DatabaseName, DocumentKey, Fields, Write};
use firenook_suite_front::{ConsoleSink, ServiceInfo, SuiteDirectory};
use serde_json::Value;
use tokio::sync::watch;
use tower::ServiceExt as _;

use super::*;
use crate::SuiteConfig;
use crate::diagnostics_tests::test_config;

/// Every line the console sink was handed.
#[derive(Default)]
struct Lines(Mutex<Vec<LogInput>>);

impl ConsoleSink for Lines {
    fn accept(&self, input: LogInput) {
        self.0.lock().expect("lines").push(input);
    }
}

impl Lines {
    fn take(&self) -> Vec<LogInput> {
        std::mem::take(&mut *self.0.lock().expect("lines"))
    }
}

fn captured() -> (LoggingRuntime, Arc<Lines>) {
    let logging = LoggingRuntime::new();
    let lines = Arc::new(Lines::default());
    logging.set_console_sink(lines.clone());
    (logging, lines)
}

fn stop_signal() -> (watch::Sender<bool>, Shutdown) {
    let (stop, receiver) = watch::channel(false);
    (stop, Shutdown::new(receiver))
}

fn database() -> DatabaseName {
    DatabaseName::new("demo-observe", "(default)").expect("database")
}

fn denial(origin: DenialOrigin, operation: RequestOperation, path: &str) -> Arc<Denial> {
    Arc::new(Denial {
        database: database(),
        operation,
        path: format!("/databases/(default)/documents/{path}"),
        uid: Some("u_9f3k2".to_owned()),
        error: None,
        request_id: Some(Arc::from("r_12")),
        origin,
    })
}

#[test]
fn a_denial_says_who_was_refused_what_and_links_its_decision() {
    let app = denial_input(&denial(
        DenialOrigin::App,
        RequestOperation::Get,
        "users/u_2fc4c",
    ));
    assert_eq!(app.kind, Some(kinds::RULES_DENIED));
    assert_eq!(app.level, LogLevel::Warn);
    assert_eq!(app.audience, Audience::Console);
    assert_eq!(app.service, "firestore");
    assert_eq!(app.message, "Rules denied get on users/u_2fc4c for u_9f3k2");
    assert_eq!(
        app.refs,
        [
            EntityRef::firestore_document("(default)", "users/u_2fc4c"),
            EntityRef::firestore_decision("(default)", "r_12"),
        ]
    );
    assert_eq!(
        app.payload,
        Some(json!({
            "method": "get",
            "path": "users/u_2fc4c",
            "database": "(default)",
            "uid": "u_9f3k2",
            "requestId": "r_12",
            "origin": "app",
        }))
    );
    let list = denial_input(&denial(DenialOrigin::App, RequestOperation::List, "users"));
    assert_eq!(list.message, "Rules denied list on users for u_9f3k2");
    assert_eq!(
        list.refs[0],
        EntityRef::firestore_collection("(default)", "users")
    );
    let console = denial_input(&Denial {
        uid: None,
        error: Some("Null value error".to_owned()),
        request_id: None,
        ..(*denial(DenialOrigin::Console, RequestOperation::Get, "users/u_2")).clone()
    });
    assert_eq!(console.kind, Some(kinds::RULES_DENIED_CONSOLE));
    assert_eq!(console.level, LogLevel::Info);
    assert_eq!(
        console.message,
        "Rules denied get on users/u_2 from the console (viewing as an unauthenticated client): Null value error"
    );
    assert_eq!(console.refs.len(), 1, "no decision was kept");
    assert!(!kinds::is_problem(kinds::RULES_DENIED_CONSOLE));
}

#[tokio::test]
async fn denials_are_logged_fifty_a_second_per_origin_and_the_rest_summed_up() {
    let (logging, lines) = captured();
    let (stop, shutdown) = stop_signal();
    let (sender, receiver) = broadcast::channel(512);
    spawn_denial_log(receiver, &logging, &shutdown);
    for _ in 0..120 {
        sender
            .send(denial(
                DenialOrigin::App,
                RequestOperation::Get,
                "users/u_1",
            ))
            .expect("sent");
    }
    sender
        .send(denial(
            DenialOrigin::Console,
            RequestOperation::Get,
            "users/u_1",
        ))
        .expect("sent");
    tokio::time::sleep(Duration::from_millis(200)).await;
    let first = lines.take();
    let app = first
        .iter()
        .filter(|line| line.kind == Some(kinds::RULES_DENIED))
        .count();
    // Fifty at once, and the bucket's refill over the moments it took.
    assert!((50..=60).contains(&app), "{app}");
    // The console's own denial has a bucket of its own.
    assert_eq!(
        first
            .iter()
            .filter(|line| line.kind == Some(kinds::RULES_DENIED_CONSOLE))
            .count(),
        1
    );
    tokio::time::sleep(Duration::from_millis(1_000)).await;
    let summary = lines.take();
    assert_eq!(
        summary.len(),
        1,
        "{:?}",
        summary.iter().map(|line| &line.message).collect::<Vec<_>>()
    );
    assert_eq!(
        summary[0].message,
        format!(
            "{} more denials in the last second were not logged one by one",
            120 - app
        )
    );
    assert_eq!(summary[0].kind, Some(kinds::RULES_DENIED));
    // The bucket has filled again.
    sender
        .send(denial(
            DenialOrigin::App,
            RequestOperation::Get,
            "users/u_1",
        ))
        .expect("sent");
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(lines.take().len(), 1);
    // The forwarder ends with the suite.
    stop.send(true).expect("stopped");
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(
        sender.receiver_count(),
        0,
        "the forwarder let go of the tap"
    );
}

#[tokio::test]
async fn a_forwarder_that_fell_behind_says_how_many_denials_it_lost() {
    let (logging, lines) = captured();
    let (_stop, shutdown) = stop_signal();
    let (sender, receiver) = broadcast::channel(4);
    for _ in 0..10 {
        sender
            .send(denial(
                DenialOrigin::App,
                RequestOperation::Get,
                "users/u_1",
            ))
            .expect("sent");
    }
    spawn_denial_log(receiver, &logging, &shutdown);
    tokio::time::sleep(Duration::from_millis(200)).await;
    let seen = lines.take();
    assert_eq!(
        seen[0].message,
        "6 Firestore rules denials were not logged: the console's log fell behind the rules engine"
    );
    assert_eq!(seen[0].kind, None);
    assert_eq!(seen.len(), 5);
}

#[tokio::test]
async fn rules_taking_effect_and_background_switches_are_markers() {
    let (logging, lines) = captured();
    let (stop, shutdown) = stop_signal();
    let config = test_config();
    let foreign = ForeignProjects::default();
    let triggers = TriggerRegistry::default();
    let rules = RulesRuntime::default();
    prepared(&HookContext {
        firestore_rules: Some(&rules),
        shutdown: Some(&shutdown),
        ..HookContext::new(&config, &logging, &foreign, &triggers)
    });
    let source = "rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n    match /{document=**} { allow read: if true; }\n  }\n}\n";
    rules
        .install_database_from(&database(), source, RulesOrigin::Console)
        .expect("installed");
    rules
        .install_database_from(&database(), source, RulesOrigin::File)
        .expect("installed");
    triggers.set_background_enabled(false);
    let wait_for = |count: usize| {
        let lines = lines.clone();
        async move {
            tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    if lines.0.lock().expect("lines").len() >= count {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            })
            .await
            .expect("the lines in time");
        }
    };
    wait_for(2).await;
    triggers.set_background_enabled(true);
    wait_for(3).await;
    let seen = lines.take();
    let applied: Vec<&LogInput> = seen
        .iter()
        .filter(|line| line.kind == Some(kinds::RULES_APPLIED))
        .collect();
    assert_eq!(applied.len(), 1, "a file reload is the watcher's own line");
    assert_eq!(
        applied[0].message,
        "Firestore rules applied from the console"
    );
    assert_eq!(applied[0].payload, Some(json!({ "origin": "console" })));
    let switches: Vec<&LogInput> = seen
        .iter()
        .filter(|line| line.kind == Some(kinds::HUB_BACKGROUND_TRIGGERS))
        .collect();
    assert_eq!(switches.len(), 2);
    assert_eq!(switches[0].level, LogLevel::Warn);
    assert_eq!(
        switches[0].payload.as_ref().expect("payload")["enabled"],
        false
    );
    assert!(switches[0].payload.as_ref().expect("payload")["since"].is_string());
    assert_eq!(switches[1].message, "Background triggers resumed");
    assert_eq!(switches[1].audience, Audience::Console);
    assert!(kinds::is_marker(kinds::HUB_BACKGROUND_TRIGGERS));
    stop.send(true).expect("stopped");
}

#[test]
fn reload_route_rules_are_an_api_origin_and_startup_rules_are_not_logged() {
    assert_eq!(
        rules_applied_input(RulesOrigin::Reload)
            .expect("logged")
            .payload,
        Some(json!({ "origin": "api" }))
    );
    assert!(rules_applied_input(RulesOrigin::Startup).is_none());
    assert!(rules_applied_input(RulesOrigin::File).is_none());
}

#[test]
fn a_functions_event_keeps_its_official_text_and_level_and_gains_structure() {
    let event = LogEvent::new("WARN", "functions", "line one\nline two".to_owned());
    let input = functions_input(&event);
    assert_eq!(input.service, "functions");
    assert_eq!(input.source, None);
    assert_eq!(input.level, LogLevel::Warn);
    assert_eq!(input.message, "line one\nline two");
    assert_eq!(
        input.legacy_text.as_deref(),
        Some("functions: line one\nfunctions: line two")
    );
    assert_eq!(input.legacy_level, Some("WARN"));
    assert_eq!(input.legacy_emulator, Some("functions"));
    assert_eq!(input.audience, Audience::Everyone);
    let extension = functions_input(&LogEvent::new(
        "INFO",
        "extensions[resize-images]",
        "resized".to_owned(),
    ));
    assert_eq!(extension.service, "functions");
    assert_eq!(extension.extension.as_deref(), Some("resize-images"));
    assert_eq!(
        extension.source.as_deref(),
        Some("extensions[resize-images]")
    );
    assert_eq!(
        extension.refs,
        [EntityRef::extension_instance("resize-images")]
    );
    let eventarc = functions_input(&LogEvent::new(
        "ERROR",
        "eventarc",
        "delivery failed".to_owned(),
    ));
    assert_eq!(eventarc.service, "eventarc");
    assert_eq!(eventarc.legacy_emulator, Some("functions"));
    assert_eq!(eventarc.level, LogLevel::Error);
    let empty = functions_input(&LogEvent::new("INFO", "functions", String::new()));
    assert_eq!(empty.legacy_text.as_deref(), Some("functions: "));
    assert_eq!(legacy_level("NOTICE"), "INFO");
}

#[test]
fn the_official_record_of_a_functions_event_is_todays() {
    let logging = LoggingRuntime::new();
    logging.emit(functions_input(&LogEvent::new(
        "INFO",
        "functions",
        "hello\nworld".to_owned(),
    )));
    // Two records, each the prefixed line, with today's level.
    assert_eq!(logging.len(), 2);
}

#[tokio::test]
async fn the_official_clear_route_is_logged_with_what_it_removed() {
    let (logging, lines) = captured();
    let store = Store::default();
    let writes: Vec<Write> = (0..3)
        .map(|index| Write::Create {
            key: DocumentKey::new(database(), format!("users/u_{index}")).expect("key"),
            fields: Fields::new(),
        })
        .collect();
    store.commit(&writes).expect("seeded");
    let clearing = store.clone();
    let router = Router::new().route(
        "/emulator/v1/projects/{project}/databases/{database}/documents",
        delete(move || {
            let store = clearing.clone();
            async move {
                let deletes: Vec<Write> = (0..3)
                    .map(|index| Write::Delete {
                        key: DocumentKey::new(database(), format!("users/u_{index}")).expect("key"),
                        precondition: firenook_core_store::Precondition::None,
                    })
                    .collect();
                store.commit(&deletes).expect("cleared");
                StatusCode::OK
            }
        }),
    );
    let router = firestore_cleared_layer(router, &logging, &store);
    let response = router
        .clone()
        .oneshot(
            Request::delete("/emulator/v1/projects/demo-observe/databases/(default)/documents")
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::OK);
    let seen = lines.take();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].kind, Some(kinds::FIRESTORE_CLEARED));
    assert_eq!(
        seen[0].message,
        "Firestore database (default) cleared through the emulator's clear route: 3 documents removed"
    );
    assert_eq!(
        seen[0].payload,
        Some(json!({ "database": "(default)", "documents": 3 }))
    );
    // Other routes and methods pass through unlogged.
    let response = router
        .oneshot(
            Request::get("/emulator/v1/projects/demo-observe/databases/(default)/documents")
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED);
    assert_eq!(lines.take().len(), 0);
    assert_eq!(
        cleared_database(
            &Method::DELETE,
            "/emulator/v1/projects/p/databases/d/documents/x"
        ),
        None
    );
}

#[test]
fn rules_watcher_lines_get_their_kinds() {
    let reloaded = rules_file_input("firestore", false, "reloaded".to_owned());
    assert_eq!(reloaded.kind, Some(kinds::RULES_RELOADED));
    assert_eq!(reloaded.legacy_level, Some("INFO"));
    let broken = rules_file_input("firestore", true, "did not compile".to_owned());
    assert_eq!(broken.kind, Some(kinds::RULES_FILE_ERROR));
    assert_eq!(broken.level, LogLevel::Warn);
    assert_eq!(
        rules_file_input("storage", true, "x".to_owned()).kind,
        Some(kinds::STORAGE_RULES)
    );
    assert_eq!(
        rules_file_input("storage", false, "x".to_owned()).kind,
        None
    );
}

/// The console's logs route over `logging`, as the suite builds it.
async fn logged(logging: &LoggingRuntime, query: &str) -> (StatusCode, Value) {
    let (_stop, shutdown) = stop_signal();
    let directory = SuiteDirectory::new(
        "demo-diagnostics",
        [ServiceInfo::listening("hub", "127.0.0.1", 6)],
    )
    .expect("directory");
    let router = console_router(ConsoleServices {
        observe: ObserveConsole::over(logging),
        ..ConsoleServices::new(directory, shutdown)
    });
    let response = router
        .oneshot(
            Request::get(format!("/api/v1/logs/entries?{query}"))
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");
    let status = response.status();
    let body = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body");
    (status, serde_json::from_slice(&body).expect("json"))
}

#[tokio::test]
async fn the_console_log_keeps_the_startup_lines_with_their_kinds() {
    let config = SuiteConfig {
        project_id: "my-project".into(),
        ..test_config()
    };
    let logging = crate::prepare_logging(&config).expect("logging");
    let (status, internal) = logged(&logging, "q=is:internal").await;
    assert_eq!(status, StatusCode::OK);
    let items = internal["items"].as_array().expect("items");
    assert_ne!(items.len(), 0, "{internal}");
    assert!(
        items
            .iter()
            .all(|item| item["kind"] == kinds::ENGINE_CONFIGURED),
        "{internal}"
    );
    // A non-demo project is a startup warning, which is a notice.
    let (_, notices) = logged(&logging, "q=kind:engine.notice").await;
    assert_ne!(
        notices["items"].as_array().expect("items").len(),
        0,
        "{notices}"
    );
    // The plain view leaves the engine's bookkeeping out.
    let (_, plain) = logged(&logging, "").await;
    assert!(
        plain["items"]
            .as_array()
            .expect("items")
            .iter()
            .all(|item| item["kind"] != kinds::ENGINE_CONFIGURED)
    );
}

#[tokio::test]
async fn without_the_console_no_console_log_is_kept() {
    let config = SuiteConfig {
        ui_enabled: false,
        ..test_config()
    };
    let logging = crate::prepare_logging(&config).expect("logging");
    assert!(logging.console_sink().is_none());
    let (status, body) = logged(&logging, "").await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        body["error"]["message"],
        "This console runs without a suite log."
    );
}

#[test]
fn banner_warnings_are_notices_and_their_records_unchanged() {
    let warning = banner_input("WARN", "careful".to_owned());
    assert_eq!(warning.kind, Some(kinds::ENGINE_NOTICE));
    assert_eq!(warning.legacy_level, Some("WARN"));
    assert_eq!(banner_input("INFO", "Starting".to_owned()).kind, None);
    let configured = configured_input("firestore configured".to_owned());
    assert_eq!(configured.kind, Some(kinds::ENGINE_CONFIGURED));
    assert!(kinds::is_internal(kinds::ENGINE_CONFIGURED));
}
