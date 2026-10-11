//! The console's wiring as the suite builds it: why absent sections are
//! absent, the late sections, the Auth fallback, and the hooks' order.

use std::sync::Arc;

use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode, header};
use firenook_console_front::{
    AbsentKind, ConsoleServices, Late, SectionFixKind, Shutdown, console_router,
};
use firenook_functions_bridge::{FunctionsInventory, TriggerObserver, TriggerRegistry};
use firenook_suite_front::{LoggingRuntime, ServiceInfo, SuiteDirectory};
use serde_json::{Value, json};
use tower::ServiceExt as _;

use super::*;
use crate::diagnostics_tests::test_config;
use crate::{LaunchContext, ServiceSelection};

fn launch(services: &[(&str, LaunchReason)], args: &[&str]) -> LaunchContext {
    LaunchContext {
        services: services
            .iter()
            .map(|(name, reason)| ((*name).to_owned(), *reason))
            .collect(),
        skipped: vec!["database".to_owned(), "hosting".to_owned()],
        command: "firenook emulators:start".to_owned(),
        args: args.iter().map(|arg| (*arg).to_owned()).collect(),
    }
}

fn selection(only: &str) -> SuiteConfig {
    SuiteConfig {
        services: ServiceSelection::parse(only).expect("selection"),
        ..test_config()
    }
}

#[test]
fn a_service_firebase_json_lacks_says_what_to_add() {
    let config = selection("firestore,auth,functions,pubsub");
    let launch = launch(
        &[("storage", LaunchReason::NotConfigured)],
        &["--only", "firestore,auth,functions,pubsub"],
    );
    let reasons = absent_reasons(&config, Some(&launch), true);
    assert_eq!(reasons.keys().collect::<Vec<_>>(), ["storage"]);
    let storage = &reasons["storage"];
    assert_eq!(storage.kind, AbsentKind::NotConfigured);
    assert_eq!(storage.detail, "firebase.json does not configure Storage.");
    assert_eq!(storage.fixes.len(), 1);
    assert_eq!(storage.fixes[0].kind, SectionFixKind::FirebaseJson);
    assert_eq!(storage.fixes[0].label, "Add it to firebase.json");
    assert!(
        storage.fixes[0]
            .text
            .contains("\"emulators\": { \"storage\": {} }")
            && storage.fixes[0]
                .text
                .contains("\"storage\": { \"rules\": \"storage.rules\" }"),
        "{}",
        storage.fixes[0].text
    );
}

#[test]
fn a_service_only_left_out_reprints_the_developers_command_with_it_added() {
    let config = selection("firestore,auth");
    let launch = launch(
        &[
            ("storage", LaunchReason::ExcludedByOnly),
            ("functions", LaunchReason::NotConfigured),
            ("pubsub", LaunchReason::NotConfigured),
        ],
        &[
            "--only",
            "firestore,auth",
            "--project",
            "demo-app",
            "--import",
            "./seed",
        ],
    );
    let reasons = absent_reasons(&config, Some(&launch), false);
    let storage = &reasons["storage"];
    assert_eq!(storage.kind, AbsentKind::ExcludedByOnly);
    assert_eq!(
        storage.detail,
        "This engine was started with --only firestore,auth."
    );
    assert_eq!(storage.fixes[0].kind, SectionFixKind::Command);
    assert_eq!(storage.fixes[0].label, "Start with Storage");
    assert_eq!(
        storage.fixes[0].text,
        "firenook emulators:start --only firestore,auth,storage --project demo-app --import ./seed"
    );
    // Functions' followers say whom they follow, with Functions' fix.
    assert_eq!(reasons["functions"].kind, AbsentKind::NotConfigured);
    for follower in ["extensions", "eventarc", "tasks"] {
        let reason = &reasons[follower];
        assert_eq!(reason.kind, AbsentKind::Requires, "{follower}");
        assert!(reason.detail.contains("Functions"), "{follower}");
        assert_eq!(reason.fixes, reasons["functions"].fixes, "{follower}");
    }
    assert_eq!(
        reasons["pubsub"].detail,
        "firebase.json does not configure the Pub/Sub emulator."
    );
}

#[test]
fn without_a_launch_context_the_engine_says_only_what_it_knows() {
    let config = selection("firestore");
    let reasons = absent_reasons(&config, None, false);
    for id in ["auth", "storage", "functions", "pubsub"] {
        assert_eq!(reasons[id].kind, AbsentKind::Unknown, "{id}");
        assert_eq!(reasons[id].fixes, Vec::new(), "{id}");
    }
    assert_eq!(
        reasons["storage"].detail,
        "This engine was started without Storage."
    );
    assert_eq!(reasons["tasks"].kind, AbsentKind::Requires);
    assert_eq!(unsupported(None), Vec::new());
}

#[test]
fn a_project_without_any_functions_reports_functions_absent_with_the_reason() {
    // Functions were asked for (no --only), and turned off because
    // firebase.json configures no codebase and no extension.
    let mut config = test_config();
    config.services.functions = false;
    let reasons = absent_reasons(&config, None, true);
    let functions = &reasons["functions"];
    assert_eq!(functions.kind, AbsentKind::NotConfigured);
    assert_eq!(
        functions.detail,
        "firebase.json configures no Functions codebase and no Extensions."
    );
    assert_eq!(
        functions.fixes[0].text,
        "\"functions\": [{ \"source\": \"functions\" }]"
    );
    assert_eq!(reasons.len(), 4, "{reasons:?}");
}

#[test]
fn skipped_firebase_json_services_are_listed_as_unsupported() {
    let launch = launch(&[], &[]);
    let listed = unsupported(Some(&launch));
    assert_eq!(listed.len(), 2);
    assert_eq!(listed[0].name, "database");
    assert_eq!(
        listed[0].detail,
        "Realtime Database is configured in firebase.json; Firenook does not emulate it yet."
    );
    assert_eq!(listed[1].name, "hosting");
}

fn directory() -> SuiteDirectory {
    SuiteDirectory::new(
        "demo-diagnostics",
        [ServiceInfo::listening("hub", "127.0.0.1", 6)],
    )
    .expect("directory")
}

/// A stop signal that never fires in the test.
fn running() -> Shutdown {
    let (stop, receiver) = tokio::sync::watch::channel(false);
    std::mem::forget(stop);
    Shutdown::new(receiver)
}

async fn call(
    router: &axum::Router,
    request: Request<Body>,
) -> (StatusCode, axum::http::HeaderMap, Value) {
    let response = router.clone().oneshot(request).await.expect("response");
    let status = response.status();
    let headers = response.headers().clone();
    let body = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body");
    (
        status,
        headers,
        serde_json::from_slice(&body).unwrap_or(Value::Null),
    )
}

fn section<'a>(status: &'a Value, id: &str) -> &'a Value {
    status["sections"]
        .as_array()
        .expect("sections")
        .iter()
        .find(|section| section["id"] == id)
        .unwrap_or_else(|| panic!("{id} in {status}"))
}

#[tokio::test]
async fn the_console_reports_the_suites_reasons_and_late_sections_until_they_are_handed_over() {
    let config = SuiteConfig {
        launch: Some(launch(
            &[("storage", LaunchReason::NotConfigured)],
            &["--only", "firestore,auth,functions,pubsub"],
        )),
        ..selection("firestore,auth,functions,pubsub")
    };
    let logging = LoggingRuntime::new();
    let parts = compute::parts(&config);
    let tasks = Late::pending("Cloud Tasks");
    let router = console_router(ConsoleServices {
        compute: Some(parts.clone()),
        tasks: Some(tasks.clone()),
        pubsub: Some(Late::pending("Pub/Sub")),
        observe: observe::observe_console(&logging, &config),
        absent: absent_reasons(&config, config.launch.as_ref(), true),
        unsupported: unsupported(config.launch.as_ref()),
        ..ConsoleServices::new(directory(), running())
    });
    let (status, _, value) = call(
        &router,
        Request::get("/api/v1/status")
            .body(Body::empty())
            .expect("request"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(section(&value, "storage")["reason"], "not-configured");
    assert_eq!(section(&value, "functions")["state"], "starting");
    assert_eq!(section(&value, "tasks")["state"], "starting");
    assert_eq!(value["unsupported"][1]["name"], "hosting");
    let (status, _, value) = call(
        &router,
        Request::get("/api/v1/functions/native/backends")
            .body(Body::empty())
            .expect("request"),
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(value["error"]["code"], "starting");
    // Compute's ready hook needs the running Functions runtime; without
    // one it hands nothing over and the sections keep starting.
    let triggers = TriggerRegistry::default();
    compute::ready(&HookContext {
        compute: Some(&parts),
        ..HookContext::new(&config, &logging, &triggers)
    });
    assert!(!parts.late.is_ready());
    // Cloud Tasks is handed over by its own hook.
    let tasks_runtime = firenook_tasks_front::TasksRuntime::new(
        &config.project_id,
        &FunctionsInventory {
            generation: 0,
            backends: Vec::new(),
        },
        "http://127.0.0.1:4",
        Arc::new(|_: &str, _: &str| {}),
    );
    messaging::tasks_ready(&tasks, &tasks_runtime, Some(&parts), &config, &logging);
    let (_, _, value) = call(
        &router,
        Request::get("/api/v1/status")
            .body(Body::empty())
            .expect("request"),
    )
    .await;
    assert_eq!(section(&value, "tasks")["state"], "ready");
    assert_eq!(section(&value, "functions")["state"], "starting");
}

#[tokio::test]
async fn the_auth_emulator_is_still_reached_through_the_console_fallback() {
    let config = test_config();
    let registry = TriggerRegistry::default();
    let (observer, _dispatches) = TriggerObserver::channel(registry.clone());
    let auth = Arc::new(
        firenook_auth_front::AuthRuntime::new(&config.project_id, observer.queue(), registry, None)
            .expect("auth"),
    );
    let logging = LoggingRuntime::new();
    let router = console_router(ConsoleServices {
        auth: Some(auth::auth_console(&auth, &config, &logging)),
        ..ConsoleServices::new(directory(), running())
    });
    let (status, headers, value) = call(
        &router,
        Request::post(
            "/api/v1/auth/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key",
        )
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            json!({ "email": "ada@example.test", "password": "secret-1", "returnSecureToken": true })
                .to_string(),
        ))
        .expect("request"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{value}");
    assert!(value["localId"].is_string(), "{value}");
    assert_eq!(headers[header::CONTENT_SECURITY_POLICY], "sandbox");
    assert_eq!(auth.user_count(), 1);
    let (status, _, value) = call(
        &router,
        Request::post(format!(
            "/api/v1/auth/identitytoolkit.googleapis.com/v1/projects/{}/accounts:query",
            config.project_id
        ))
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(json!({ "returnUserInfo": true }).to_string()))
        .expect("request"),
    )
    .await;
    assert_ne!(status, StatusCode::NOT_FOUND, "{value}");
    assert!(
        value
            .get("error")
            .is_none_or(|error| error["code"] != "not-found"),
        "{value}"
    );
}

#[tokio::test]
async fn every_hook_runs_once_and_finishing_follows_the_fixed_order() {
    let config = test_config();
    let logging = LoggingRuntime::new();
    let triggers = TriggerRegistry::default();
    let context = HookContext::new(&config, &logging, &triggers);
    let _ = recorded();
    prepared(&context);
    let mut options = FunctionsConsoleOptions::default();
    functions_options(&context, &mut options);
    ready(&context);
    before_finish(&context).await;
    let inventory = FunctionsInventory {
        generation: 1,
        backends: Vec::new(),
    };
    inventory_refreshed(&context, &inventory);
    let streams = ["auth", "storage", "compute", "messaging", "observe"];
    let mut expected: Vec<String> = Vec::new();
    expected.extend(streams.iter().map(|stream| format!("{stream}.prepared")));
    expected.extend(
        streams
            .iter()
            .map(|stream| format!("{stream}.functions_options")),
    );
    // Compute's ready runs when Functions start, not here.
    expected.extend(
        ["auth", "storage", "messaging", "observe"]
            .iter()
            .map(|stream| format!("{stream}.ready")),
    );
    expected.extend(
        ["storage", "messaging", "auth", "compute", "observe"]
            .iter()
            .map(|stream| format!("{stream}.before_finish")),
    );
    expected.extend(
        streams
            .iter()
            .map(|stream| format!("{stream}.inventory_refreshed")),
    );
    assert_eq!(recorded(), expected);
}
