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
    let foreign = firenook_console_front::ForeignProjects::default();
    compute::ready(&HookContext {
        compute: Some(&parts),
        ..HookContext::new(&config, &logging, &foreign, &triggers)
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
    let foreign = firenook_console_front::ForeignProjects::default();
    let context = HookContext::new(&config, &logging, &foreign, &triggers);
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
    expected.push("console.jobs".to_owned());
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

#[test]
fn data_facts_say_where_the_data_lives() {
    let memory = test_config();
    let facts = suite::data_facts(&memory, false);
    assert_eq!(facts.mode, firenook_console_front::DataMode::Memory);
    assert_eq!(facts.state_dir, None);
    assert_eq!(facts.durability, "write-behind");
    let disk = SuiteConfig {
        firestore_in_memory: false,
        import: Some(std::path::PathBuf::from("/work/seed")),
        export_on_exit: Some(std::path::PathBuf::from("/work/out")),
        durability: firenook_core_store::DiskDurability::PerCommit,
        ..test_config()
    };
    let facts = suite::data_facts(&disk, false);
    assert_eq!(facts.mode, firenook_console_front::DataMode::Disk);
    assert_eq!(
        facts.state_dir.as_deref(),
        Some(disk.state_dir.display().to_string().as_str())
    );
    assert_eq!(facts.imported_from.as_deref(), Some("/work/seed"));
    assert_eq!(facts.export_on_exit.as_deref(), Some("/work/out"));
    assert_eq!(facts.durability, "per-commit");
    // A resumed start did not import the seed.
    let resumed = suite::data_facts(&disk, true);
    assert!(resumed.resumed);
    assert_eq!(resumed.imported_from, None);
}

#[test]
fn export_destinations_refuse_the_seed_while_the_engine_resumes_from_it() {
    let root = std::env::temp_dir().join(format!("firenook-destinations-{}", std::process::id()));
    // The seed and the state directory exist, as they do when the engine
    // resumes.
    for folder in ["seed", "state", "project"] {
        std::fs::create_dir_all(root.join(folder)).expect("folder");
    }
    std::fs::write(
        root.join("seed").join("firebase-export-metadata.json"),
        r#"{"version":"15.22.0"}"#,
    )
    .expect("seed metadata");
    let config = SuiteConfig {
        project_dir: root.join("project"),
        state_dir: root.join("state"),
        import: Some(root.join("seed")),
        export_on_exit: Some(root.join("out")),
        ..test_config()
    };
    let listed = suite::destinations(&config);
    let ids: Vec<&str> = listed
        .iter()
        .map(|destination| destination.id.as_str())
        .collect();
    assert_eq!(ids, ["export-on-exit", "seed", "project"]);
    assert!(
        listed
            .iter()
            .all(|destination| destination.refused.is_none())
    );
    assert_eq!(
        listed[2].path,
        root.join("project")
            .join("firenook-export")
            .display()
            .to_string()
    );
    let resuming = SuiteConfig {
        resume_state: true,
        ..config
    };
    let listed = suite::destinations(&resuming);
    assert_eq!(
        listed[1].refused.as_deref(),
        Some("The engine resumed its state, so the seed must not change.")
    );
    assert_eq!(listed[0].refused, None);
    assert_eq!(listed[2].refused, None);
    // A folder inside the state directory is refused with the engine's reason.
    let nested = SuiteConfig {
        export_on_exit: Some(resuming.state_dir.join("inside")),
        ..resuming
    };
    let listed = suite::destinations(&nested);
    assert!(
        listed[0].refused.as_deref().is_some_and(|reason| reason
            .starts_with("The engine will not export there:")
            && !reason.ends_with("..")),
        "{listed:?}"
    );
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn the_auth_wiring_records_restored_projects_that_hold_users_as_foreign() {
    let config = test_config();
    let registry = TriggerRegistry::default();
    let (observer, _dispatches) = TriggerObserver::channel(registry.clone());
    let auth = Arc::new(
        firenook_auth_front::AuthRuntime::new(&config.project_id, observer.queue(), registry, None)
            .expect("auth"),
    );
    // The restored state: users in the configured project, in my-prod,
    // and in a tenant of tenant-prod; an empty other project.
    auth.runtime()
        .update(|data| {
            let user = |uid: &str| {
                json!({ "email": format!("{uid}@example.test") })
                    .as_object()
                    .cloned()
                    .unwrap_or_default()
            };
            let mine = data.agent(&config.project_id);
            mine.project
                .create_user_with_local_id("mine", &user("mine"))
                .expect("created");
            let prod = data.agent("my-prod");
            prod.project
                .create_user_with_local_id("p1", &user("p1"))
                .expect("created");
            let tenanted = data.agent("tenant-prod");
            tenanted.ensure_tenant("tenant-prod", "acme");
            tenanted
                .tenants
                .get_mut("acme")
                .expect("tenant")
                .project
                .create_user_with_local_id("t1", &user("t1"))
                .expect("created");
            let _ = data.agent("empty-prod");
        })
        .expect("saved");
    let logging = LoggingRuntime::new();
    let triggers = TriggerRegistry::default();
    let foreign = firenook_console_front::ForeignProjects::default();
    let context = HookContext {
        auth: Some(&auth),
        ..HookContext::new(&config, &logging, &foreign, &triggers)
    };
    auth::prepared(&context);
    let mut recorded: Vec<(String, Vec<String>)> = foreign
        .snapshot()
        .into_iter()
        .map(|project| (project.project_id, project.services))
        .collect();
    recorded.sort();
    assert_eq!(
        recorded,
        [
            ("my-prod".to_owned(), vec!["auth".to_owned()]),
            ("tenant-prod".to_owned(), vec!["auth".to_owned()]),
        ]
    );
    // With several projects intended, nothing is foreign.
    let several = SuiteConfig {
        single_project_mode: false,
        ..test_config()
    };
    let quiet = firenook_console_front::ForeignProjects::default();
    auth::prepared(&HookContext {
        auth: Some(&auth),
        ..HookContext::new(&several, &logging, &quiet, &triggers)
    });
    assert_eq!(quiet.count(), 0);
}

/// The Auth state reaches its file off the request path within 250 ms;
/// the shutdown hook writes it at once, so a stop right after a burst of
/// writes leaves the file equal to the state.
#[tokio::test]
async fn the_auth_shutdown_hook_writes_the_state_left_after_a_burst() {
    let config = test_config();
    let logging = LoggingRuntime::new();
    let triggers = TriggerRegistry::default();
    let foreign = firenook_console_front::ForeignProjects::default();
    let root = std::env::temp_dir().join(format!(
        "firenook-auth-finish-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));
    let file = root.join("auth-state.json");
    let registry = TriggerRegistry::default();
    let (observer, _dispatches) = TriggerObserver::channel(registry.clone());
    let auth = Arc::new(
        firenook_auth_front::AuthRuntime::new(
            &config.project_id,
            observer.queue(),
            registry,
            Some(file.clone()),
        )
        .expect("auth"),
    );
    let router = auth.application();
    for index in 0..200 {
        let response = router
            .clone()
            .oneshot(
                Request::post("/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({ "email": format!("burst{index}@example.test"), "password": "password1" })
                            .to_string(),
                    ))
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::OK);
    }
    auth::before_finish(&HookContext {
        auth: Some(&auth),
        ..HookContext::new(&config, &logging, &foreign, &triggers)
    })
    .await;
    let on_disk: Value =
        serde_json::from_slice(&std::fs::read(&file).expect("state file")).expect("JSON");
    let in_memory = auth
        .runtime()
        .read(|data| serde_json::to_value(data).expect("JSON"));
    assert_eq!(on_disk, in_memory);
    assert_eq!(
        on_disk["projects"][config.project_id.as_str()]["users"]
            .as_object()
            .map(serde_json::Map::len),
        Some(200)
    );
    drop(router);
    drop(auth);
    let _ = std::fs::remove_dir_all(&root);
}

/// A code requested through the console mount links to the Auth emulator's
/// own origin, where the action page is served, not to the console's.
#[tokio::test]
async fn action_links_requested_through_the_console_point_at_the_auth_port() {
    let config = test_config();
    let logging = LoggingRuntime::new();
    let triggers = TriggerRegistry::default();
    let foreign = firenook_console_front::ForeignProjects::default();
    let registry = TriggerRegistry::default();
    let (observer, _dispatches) = TriggerObserver::channel(registry.clone());
    let auth = Arc::new(
        firenook_auth_front::AuthRuntime::new(&config.project_id, observer.queue(), registry, None)
            .expect("auth"),
    );
    auth::prepared(&HookContext {
        auth: Some(&auth),
        ..HookContext::new(&config, &logging, &foreign, &triggers)
    });
    let router = console_router(ConsoleServices {
        auth: Some(auth::auth_console(&auth, &config, &logging)),
        ..ConsoleServices::new(directory(), running())
    });
    let admin = format!(
        "/api/v1/auth/identitytoolkit.googleapis.com/v1/projects/{}",
        config.project_id
    );
    let (status, _, value) = call(
        &router,
        Request::post(format!("{admin}/accounts"))
            .header(header::HOST, "127.0.0.1:4000")
            .header(header::AUTHORIZATION, "Bearer owner")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                json!({ "email": "ada@example.test", "password": "secret-1" }).to_string(),
            ))
            .expect("request"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{value}");
    let (status, _, value) = call(
        &router,
        Request::post(format!("{admin}/accounts:sendOobCode"))
            .header(header::HOST, "127.0.0.1:4000")
            .header(header::AUTHORIZATION, "Bearer owner")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                json!({
                    "requestType": "PASSWORD_RESET",
                    "email": "ada@example.test",
                    "returnOobLink": true
                })
                .to_string(),
            ))
            .expect("request"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{value}");
    let link = value["oobLink"].as_str().expect("a link");
    let expected = format!("{}/emulator/action?", config.origin(config.ports.auth));
    assert!(link.starts_with(&expected), "{link}");
}
