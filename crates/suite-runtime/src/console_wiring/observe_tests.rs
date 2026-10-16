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

#[test]
fn the_engine_details_say_how_the_engine_was_started() {
    let config = SuiteConfig {
        services: ServiceSelection::parse("firestore,functions").expect("selection"),
        debug_log: Some(std::path::PathBuf::from("/work/debug.log")),
        ..test_config()
    };
    let details = engine_details(&config, None);
    let engine = details.config.expect("a suite's configuration");
    assert_eq!(engine.host, "127.0.0.1");
    assert_eq!(engine.connect_host, "127.0.0.1");
    assert_eq!(engine.debug_log.as_deref(), Some("/work/debug.log"));
    assert!(engine.demo_project);
    assert!(engine.diagnostics);
    assert_eq!(engine.default_bucket, "demo-diagnostics.appspot.com");
    assert_eq!(engine.selected, ["functions", "firestore"]);
    assert_eq!(
        engine_details(&test_config(), None)
            .config
            .expect("config")
            .selected,
        Vec::<String>::new(),
        "every service started: nothing was selected"
    );
}

#[test]
fn the_connection_lists_what_the_sdks_read_for_running_services_only() {
    let names = |config: &SuiteConfig| {
        connection_env(config, None)
            .into_iter()
            .map(|variable| variable.name)
            .collect::<Vec<_>>()
    };
    assert_eq!(
        names(&test_config()),
        [
            "GCLOUD_PROJECT",
            "GOOGLE_CLOUD_PROJECT",
            "FIRESTORE_EMULATOR_HOST",
            "FIREBASE_AUTH_EMULATOR_HOST",
            "FIREBASE_STORAGE_EMULATOR_HOST",
            "STORAGE_EMULATOR_HOST",
            "FIREBASE_EMULATOR_HUB",
            "PUBSUB_EMULATOR_HOST",
            "CLOUD_TASKS_EMULATOR_HOST",
            "CLOUD_EVENTARC_EMULATOR_HOST",
        ]
    );
    let firestore_only = SuiteConfig {
        services: ServiceSelection::parse("firestore").expect("selection"),
        ..test_config()
    };
    assert_eq!(
        names(&firestore_only),
        [
            "GCLOUD_PROJECT",
            "GOOGLE_CLOUD_PROJECT",
            "FIRESTORE_EMULATOR_HOST",
            "FIREBASE_EMULATOR_HUB"
        ]
    );
    let env = connection_env(&test_config(), None);
    let value = |name: &str| {
        env.iter()
            .find(|variable| variable.name == name)
            .expect("listed")
            .clone()
    };
    assert_eq!(value("FIRESTORE_EMULATOR_HOST").value, "127.0.0.1:1");
    assert_eq!(value("STORAGE_EMULATOR_HOST").value, "http://127.0.0.1:3");
    assert_eq!(
        value("CLOUD_EVENTARC_EMULATOR_HOST").value,
        "http://127.0.0.1:10"
    );
    assert_eq!(
        value("CLOUD_TASKS_EMULATOR_HOST").set_by,
        OverviewEnvSource::Functions
    );
    assert_eq!(
        value("PUBSUB_EMULATOR_HOST").set_by,
        OverviewEnvSource::Exec
    );
    // Pinned against the two places that set them: the npm CLI's exec
    // environment and the Functions workers' environment.
    let exec = include_str!("../../../../packages/cli/src/runtime.mjs");
    let workers = include_str!("../../../functions-runtime/src/lib.rs");
    for variable in &env {
        let source = match variable.set_by {
            OverviewEnvSource::Exec => exec,
            OverviewEnvSource::Functions => workers,
        };
        assert!(
            source.contains(&variable.name),
            "{} is not set where the list says",
            variable.name
        );
        if variable.set_by == OverviewEnvSource::Exec && variable.name != "GOOGLE_CLOUD_PROJECT" {
            assert!(
                workers.contains(&variable.name),
                "{} also reaches Functions workers",
                variable.name
            );
        }
    }
    let with_credentials = connection_env(
        &test_config(),
        Some((
            "/work/demo-adc.json".to_owned(),
            "{\"type\":\"authorized_user\"}".to_owned(),
        )),
    );
    let credentials = with_credentials
        .iter()
        .find(|variable| variable.name == "GOOGLE_APPLICATION_CREDENTIALS")
        .expect("listed");
    assert_eq!(credentials.value, "/work/demo-adc.json");
    assert_eq!(
        credentials.note.as_deref(),
        Some("{\"type\":\"authorized_user\"}")
    );
}

#[test]
fn only_the_demo_credentials_stub_is_ever_shown() {
    let directory =
        std::env::temp_dir().join(format!("firenook-observe-adc-{}", std::process::id()));
    std::fs::create_dir_all(&directory).expect("directory");
    let stub = directory.join("demo-adc.json");
    std::fs::write(
        &stub,
        r#"{"type":"authorized_user","client_id":"demo","client_secret":"demo","refresh_token":"demo"}"#,
    )
    .expect("written");
    let real = directory.join("adc.json");
    std::fs::write(
        &real,
        r#"{"type":"authorized_user","client_id":"1234.apps","client_secret":"s3cret","refresh_token":"1//real"}"#,
    )
    .expect("written");
    let (path, note) = demo_credentials(&stub).expect("the stub is shown");
    assert_eq!(path, stub.display().to_string());
    assert!(note.contains("\"client_id\":\"demo\""), "{note}");
    assert_eq!(demo_credentials(&real), None);
    assert_eq!(demo_credentials(&directory.join("missing.json")), None);
    let _ = std::fs::remove_dir_all(&directory);
}

#[test]
fn notices_say_what_the_startup_banner_warned_about() {
    let codes = |config: &SuiteConfig| {
        notices(config)
            .into_iter()
            .map(|notice| notice.code)
            .collect::<Vec<_>>()
    };
    assert_eq!(codes(&test_config()), Vec::<String>::new());
    let risky = SuiteConfig {
        project_id: "my-prod".into(),
        host: "0.0.0.0".into(),
        diagnostics: false,
        services: ServiceSelection::parse("firestore,functions").expect("selection"),
        ..test_config()
    };
    let shown = notices(&risky);
    assert_eq!(
        shown
            .iter()
            .map(|notice| notice.code.as_str())
            .collect::<Vec<_>>(),
        [
            "nonDemoProject",
            "missingEmulators",
            "publicHost",
            "diagnosticsOff"
        ]
    );
    assert_eq!(shown[0].level, OverviewNoticeLevel::Warn);
    assert!(
        shown[0].message.contains("\"my-prod\""),
        "{}",
        shown[0].message
    );
    assert!(
        shown[1].message.ends_with("auth, pubsub, storage."),
        "{}",
        shown[1].message
    );
    assert!(shown[2].message.contains("0.0.0.0"));
    assert_eq!(shown[3].level, OverviewNoticeLevel::Info);
    // A demo project's missing emulators fail rather than reach production.
    let demo = SuiteConfig {
        services: ServiceSelection::parse("functions").expect("selection"),
        ..test_config()
    };
    assert_eq!(codes(&demo), Vec::<String>::new());
}

#[test]
fn a_snapshot_is_staged_beside_the_state_directory_never_inside_it() {
    let root =
        std::env::temp_dir().join(format!("firenook-observe-staging-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join("state")).expect("state");
    std::fs::create_dir_all(root.join("seed")).expect("seed");
    // An import seed is an export: its metadata names what it holds.
    for seed in [root.join("seed"), root.clone()] {
        std::fs::write(
            seed.join("firebase-export-metadata.json"),
            r#"{"version":"14.0.0"}"#,
        )
        .expect("metadata");
    }
    let config = SuiteConfig {
        state_dir: root.join("state"),
        project_dir: root.join("app"),
        ..test_config()
    };
    let staging = snapshot_staging(&config).expect("a staging folder");
    assert_eq!(staging.parent(), Some(root.as_path()));
    assert!(
        staging
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with(".firenook-snapshot-")),
        "{}",
        staging.display()
    );
    assert_ne!(
        snapshot_staging(&config).expect("another"),
        staging,
        "each one fresh"
    );
    // Resuming from a seed: the sibling passes the export check.
    let resuming = SuiteConfig {
        resume_state: true,
        import: Some(root.join("seed")),
        ..config.clone()
    };
    let checked = snapshot_staging(&resuming).expect("a checked staging folder");
    assert_eq!(checked.parent(), Some(root.as_path()));
    assert!(crate::native_state::validate_export_destination(&resuming, &checked).is_ok());
    // A seed that holds both the state's parent and the project is refused
    // with the engine's reason.
    let holding = SuiteConfig {
        resume_state: true,
        import: Some(root.clone()),
        project_dir: root.join("app"),
        ..config.clone()
    };
    let refused = snapshot_staging(&holding).expect_err("every candidate overlaps the seed");
    assert!(refused.contains("separate"), "{refused}");
    let _ = std::fs::remove_dir_all(&root);
}

#[cfg(unix)]
#[test]
fn free_space_is_read_from_the_nearest_existing_folder() {
    let missing = std::env::temp_dir()
        .join("firenook-observe-no-such-folder")
        .join("deeper");
    let free = free_space(&missing).expect("the volume's free space");
    assert!(free > 0);
}

#[tokio::test]
async fn the_snapshot_port_covers_the_running_services_and_sizes_firestore() {
    let (logging, _) = captured();
    let config = SuiteConfig {
        services: ServiceSelection::parse("firestore,auth").expect("selection"),
        ..test_config()
    };
    let foreign = ForeignProjects::default();
    let triggers = TriggerRegistry::default();
    let store = Store::default();
    store
        .commit(&[Write::Create {
            key: DocumentKey::new(database(), "users/u_1").expect("key"),
            fields: Fields::new(),
        }])
        .expect("seeded");
    let (exporter, _commands) = tokio::sync::mpsc::channel(1);
    let base = HookContext::new(&config, &logging, &foreign, &triggers);
    assert!(snapshot_port(&base).is_none(), "no exporter, no snapshots");
    let port = snapshot_port(&HookContext {
        exporter: Some(&exporter),
        store: Some(&store),
        ..base
    })
    .expect("a port");
    assert_eq!(port.targets, ["firestore", "auth"]);
    assert_eq!(port.project, "demo-diagnostics");
    let everything: std::collections::BTreeSet<String> = ["firestore".to_owned()].into();
    assert!((port.size)(&everything) > 0);
    assert_eq!((port.size)(&std::collections::BTreeSet::new()), 0);
}

#[test]
fn an_attributed_logger_line_reads_as_its_severity_message_and_fields() {
    use firenook_functions_runtime::LogStream;
    let event = LogEvent::new(
        "WARN",
        "functions",
        r#"{"severity":"WARNING","message":"Cart is empty","cartId":"c_19","items":[]}"#.to_owned(),
    )
    .with_stream(LogStream::Stderr)
    .with_execution("a1b2c3-7")
    .with_function("us-central1-hello")
    .with_codebase("default");
    let input = functions_input(&event);
    assert_eq!(input.level, LogLevel::Warn);
    assert_eq!(input.message, "Cart is empty");
    assert_eq!(
        input.payload,
        Some(json!({ "cartId": "c_19", "items": [] }))
    );
    assert_eq!(input.function.as_deref(), Some("us-central1-hello"));
    assert_eq!(input.execution.as_deref(), Some("a1b2c3-7"));
    assert_eq!(input.codebase.as_deref(), Some("default"));
    assert_eq!(input.source, None);
    assert_eq!(
        input.refs,
        [
            EntityRef::function("us-central1-hello"),
            EntityRef::invocation("a1b2c3-7"),
        ]
    );
    // The official record is the printed line, at its stream's level.
    assert_eq!(
        input.legacy_text.as_deref(),
        Some(
            r#"functions: {"severity":"WARNING","message":"Cart is empty","cartId":"c_19","items":[]}"#
        )
    );
    assert_eq!(input.legacy_level, Some("WARN"));
    assert_eq!(input.audience, Audience::Everyone);
}

#[test]
fn a_worker_line_keeps_its_true_level_and_records_at_its_streams() {
    use firenook_functions_runtime::LogStream;
    let debug = functions_input(
        &LogEvent::new("DEBUG", "functions", "detail".to_owned()).with_stream(LogStream::Stdout),
    );
    assert_eq!(debug.level, LogLevel::Debug);
    assert_eq!(debug.legacy_level, Some("INFO"));
    let error = functions_input(
        &LogEvent::new(
            "ERROR",
            "functions",
            "TypeError: boom\n    at handler (index.js:3:9)\r\n".to_owned(),
        )
        .with_stream(LogStream::Stderr),
    );
    assert_eq!(error.level, LogLevel::Error);
    assert_eq!(error.legacy_level, Some("WARN"));
    assert_eq!(
        error.legacy_text.as_deref(),
        Some("functions: TypeError: boom\nfunctions:     at handler (index.js:3:9)\nfunctions: ")
    );
    assert_eq!(
        error.message, "TypeError: boom\n    at handler (index.js:3:9)\r\n",
        "the console keeps the message whole"
    );
}

#[test]
fn lifecycle_lines_carry_their_facts_their_kind_and_what_caused_them() {
    let start = functions_input(
        &LogEvent::new(
            "INFO",
            "functions",
            r#"Beginning execution of "us-central1-onCartDeleted""#.to_owned(),
        )
        .with_kind("function.start")
        .with_function("us-central1-onCartDeleted")
        .with_execution("a1b2c3-8")
        .with_detail(json!({ "cause": {
            "type": "firestore",
            "eventType": "google.cloud.firestore.document.v1.deleted",
            "database": "(default)",
            "document": "carts/c_1",
            "eventId": "e1",
        }})),
    );
    assert_eq!(start.kind, Some(kinds::FUNCTION_START));
    assert_eq!(start.level, LogLevel::Info);
    assert_eq!(
        start.payload.as_ref().expect("payload")["cause"]["document"],
        "carts/c_1"
    );
    assert_eq!(
        start.refs,
        [
            EntityRef::function("us-central1-onCartDeleted"),
            EntityRef::invocation("a1b2c3-8"),
            EntityRef::firestore_document("(default)", "carts/c_1"),
        ]
    );
    // A 500 ends as a failure, a warning in the console, INFO as recorded.
    let failed = functions_input(
        &LogEvent::new("INFO", "functions", r#"Finished "x" in 3ms"#.to_owned())
            .with_kind("function.failed")
            .with_detail(json!({ "durationMs": 3.0, "status": 500, "outcome": "failed" })),
    );
    assert_eq!(failed.level, LogLevel::Warn);
    assert_eq!(failed.legacy_level, Some("INFO"));
    assert_eq!(
        failed.payload,
        Some(json!({ "durationMs": 3.0, "status": 500, "outcome": "failed" }))
    );
    // A handled background failure has no line in the official feed.
    let handled = functions_input(
        &LogEvent::new("ERROR", "functions", "Finished with an error".to_owned())
            .with_kind("function.failed")
            .with_detail(json!({ "outcome": "failed", "consoleOnly": true })),
    );
    assert_eq!(handled.audience, Audience::Console);
    assert_eq!(handled.level, LogLevel::Error);
    assert_eq!(handled.payload, Some(json!({ "outcome": "failed" })));
    let timeout = functions_input(
        &LogEvent::new(
            "ERROR",
            "functions[us-central1-slow]",
            "timed out".to_owned(),
        )
        .with_kind("function.timeout"),
    );
    assert_eq!(timeout.kind, Some(kinds::FUNCTION_TIMEOUT));
    assert_eq!(timeout.level, LogLevel::Error);
    // A kind the console does not declare is left out.
    let thrown = functions_input(
        &LogEvent::new("ERROR", "functions", "TypeError".to_owned()).with_kind("function.error"),
    );
    assert_eq!(thrown.kind, None);
    assert_eq!(thrown.level, LogLevel::Error);
}

#[test]
fn every_cause_links_to_what_it_names() {
    let refs = |cause: Value| cause_refs(&cause, Some("us-central1-tick"));
    assert_eq!(
        refs(json!({ "type": "storage", "bucket": "b", "object": "a/b.png" })),
        [EntityRef::storage_object("b", "a/b.png")]
    );
    assert_eq!(
        refs(json!({ "type": "auth", "uid": "u_1", "tenant": "t-1" })),
        [EntityRef::auth_user(Some("t-1"), "u_1")]
    );
    assert_eq!(
        refs(json!({ "type": "callable", "uid": "u_1", "tenant": null })),
        [EntityRef::auth_user(None, "u_1")]
    );
    assert_eq!(
        refs(json!({ "type": "pubsub", "topic": "projects/p/topics/t", "messageId": "9" })),
        [
            EntityRef::pubsub_message("projects/p/topics/t", "9"),
            EntityRef::pubsub_topic("projects/p/topics/t"),
        ]
    );
    assert_eq!(
        refs(json!({ "type": "schedule", "topic": "projects/p/topics/firebase-schedule-x" })),
        [EntityRef::pubsub_schedule("us-central1-tick")]
    );
    assert_eq!(
        refs(json!({ "type": "eventarc", "channel": "c", "event": "ev_1" })),
        [
            EntityRef::eventarc_event("ev_1"),
            EntityRef::eventarc_channel("c")
        ]
    );
    assert_eq!(
        refs(json!({ "type": "blocking", "authCall": "call_1", "uid": "u_2" })),
        [
            EntityRef::auth_call("call_1"),
            EntityRef::auth_user(None, "u_2")
        ]
    );
    for empty in [
        json!({ "type": "http", "method": "GET", "path": "/" }),
        json!({ "type": "task", "queue": "q", "task": "t" }),
        json!({ "type": "unknown" }),
        json!(null),
    ] {
        assert_eq!(refs(empty.clone()), Vec::<EntityRef>::new(), "{empty}");
    }
}
