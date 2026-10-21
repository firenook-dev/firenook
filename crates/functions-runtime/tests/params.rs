//! A codebase's params, env file chain and triggers end to end: defaults
//! applied as the official emulator applies them without a terminal (in the
//! function's options and in `.value()`), the `.env.<alias>` file of the
//! alias the project was selected by, and the warning for a trigger whose
//! service the suite does not run.
#![allow(clippy::too_many_lines)] // Scenarios read best whole.

mod support;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use firenook_functions_runtime::console::RuntimeStatus;
use firenook_functions_runtime::monitor::FunctionLoadState;
use firenook_functions_runtime::{LogDelivery, LogEvent, RunningServices};
use serde_json::{Value, json};
use support::{Harness, PROJECT};

/// The manifest the SDK writes for `index.js` below (its discovery output,
/// recorded from firebase-functions 7.2.5).
const PARAMS_MANIFEST: &str = r#"{"specVersion":"v1alpha1","endpoints":{"params":{"availableMemoryMb":"{{ params.MEMORY_MB }}","timeoutSeconds":null,"minInstances":"{{ params.MIN_INSTANCES }}","maxInstances":null,"platform":"gcfv2","region":"{{ params.REGION }}","secretEnvironmentVariables":[{"key":"API_KEY"}],"labels":{},"httpsTrigger":{},"entryPoint":"params"}},"requiredAPIs":[],"extensions":{},"params":[{"name":"REGION","type":"string","default":"europe-west1"},{"name":"MEMORY_MB","type":"int","default":512},{"name":"MIN_INSTANCES","type":"int","default":0},{"name":"GREETING","type":"string","default":"hello"},{"name":"ENABLED","type":"boolean","default":true},{"name":"COLOURS","type":"list","default":["red","green"]},{"name":"FROM_ENV","type":"string","default":"default-value"},{"type":"secret","name":"API_KEY"}]}"#;

const PARAMS_INDEX: &str = r#"
const { defineString, defineInt, defineBoolean, defineList, defineSecret } = require("firebase-functions/params");
const greeting = defineString("GREETING", { default: "hello" });
const memory = defineInt("MEMORY_MB", { default: 512 });
const enabled = defineBoolean("ENABLED", { default: true });
const colours = defineList("COLOURS", { default: ["red", "green"] });
const fromEnv = defineString("FROM_ENV", { default: "default-value" });
const apiKey = defineSecret("API_KEY");
exports.params = (req, res) => {
  let list;
  try { list = colours.value(); } catch (error) { list = `error: ${error.message}`; }
  res.json({
    greeting: greeting.value(), memory: memory.value(), enabled: enabled.value(), colours: list,
    fromEnv: fromEnv.value(), apiKey: apiKey.value(),
    env: { REGION: process.env.REGION ?? null, COLOURS: process.env.COLOURS ?? null },
  });
};
"#;

fn messages(events: &[LogEvent], level: &str) -> Vec<String> {
    events
        .iter()
        .filter(|event| event.level == level)
        .map(|event| format!("{}: {}", event.label, event.message))
        .collect()
}

#[tokio::test]
async fn defaulted_params_load_and_reach_the_function() {
    let harness = match Harness::start_with_files(
        PARAMS_INDEX,
        PARAMS_MANIFEST,
        LogDelivery::Attributed,
        &[
            (".env", "FROM_ENV=from-dotenv\n"),
            (".secret.local", "API_KEY=local-secret\n"),
        ],
        |_| {},
    )
    .await
    {
        Ok(harness) => harness,
        Err(reason) => {
            eprintln!("skipped: {reason}");
            return;
        }
    };
    let codebase = harness.monitor.codebase("default").expect("registered");
    assert_eq!(
        codebase.state,
        FunctionLoadState::Ready,
        "{:?}",
        codebase.error
    );
    assert_eq!(codebase.function_count, 1);
    // The defaults resolved the options: the region and the memory.
    let function = harness
        .runtime
        .console()
        .function("europe-west1-params")
        .await
        .expect("served in the default region");
    assert_eq!(function.definition["availableMemoryMb"], json!(512));
    let region = function
        .params
        .iter()
        .find(|param| param.name == "REGION")
        .expect("declared");
    assert_eq!(region.value.as_deref(), Some("europe-west1"));
    assert_eq!(region.file, None);
    let from_env = function
        .params
        .iter()
        .find(|param| param.name == "FROM_ENV")
        .expect("declared");
    assert_eq!(from_env.value.as_deref(), Some("from-dotenv"));
    assert_eq!(from_env.file.as_deref(), Some(".env"));
    let (response, body) = harness
        .call_text(
            Request::get(format!("/{PROJECT}/europe-west1/params"))
                .body(Body::empty())
                .expect("a request"),
        )
        .await;
    assert_eq!(response.status(), StatusCode::OK, "{body}");
    let body: Value = serde_json::from_str(&body).expect("JSON");
    assert_eq!(
        body,
        json!({
            "greeting": "hello",
            "memory": 512,
            "enabled": true,
            "colours": ["red", "green"],
            "fromEnv": "from-dotenv",
            "apiKey": "local-secret",
            "env": {"REGION": "europe-west1", "COLOURS": "[\"red\",\"green\"]"},
        })
    );
    // The defaults are taken again at every load, never written.
    let source = harness.directory.path().join("functions");
    assert!(!source.join(".env.local").exists());
    let infos = messages(&harness.events(), "INFO");
    assert!(
        infos.iter().any(|line| line
            == "functions: Params no env file sets take their default: REGION, MEMORY_MB, MIN_INSTANCES, GREETING, ENABLED, COLOURS."),
        "{infos:#?}"
    );
    harness.stop().await;
}

const REQUIRED_MANIFEST: &str = "specVersion: v1alpha1
params:
  - name: GREETING
    type: string
    default: hello
  - name: REQUIRED_VALUE
    type: string
    description: Needed by the shop
  - name: COUNT
    type: int
endpoints:
  api:
    entryPoint: api
    platform: gcfv2
    httpsTrigger: {}
";

#[tokio::test]
async fn a_param_without_a_value_or_default_stops_the_load_with_the_official_question() {
    let harness = Harness::start_without_worker(REQUIRED_MANIFEST, &[]).await;
    let codebase = harness.monitor.codebase("default").expect("registered");
    assert_eq!(codebase.state, FunctionLoadState::Failed);
    assert_eq!(codebase.function_count, 0);
    let error = codebase.error.expect("the load failed");
    assert_eq!(
        error.message,
        format!(
            "Question \"Enter a string value for REQUIRED_VALUE:\" does not have a default and cannot be answered in non-interactive mode. Firenook never prompts: set the value in .env, .env.{PROJECT} or .env.local, or give the param a default."
        )
    );
    let errors = messages(&harness.events(), "ERROR");
    assert!(
        errors.iter().any(|line| line.starts_with(
            "functions: Failed to load function definition from source: FirebaseError: Question \"Enter a string value for REQUIRED_VALUE:\""
        )),
        "{errors:#?}"
    );
    harness.stop().await;

    // A value in an env file answers it; the next param asks next.
    let harness =
        Harness::start_without_worker(REQUIRED_MANIFEST, &[(".env", "REQUIRED_VALUE=given\n")])
            .await;
    let codebase = harness.monitor.codebase("default").expect("registered");
    assert!(
        codebase
            .error
            .expect("COUNT has no value")
            .message
            .starts_with("Question \"Enter an integer value for COUNT:\""),
    );
    harness.stop().await;

    let harness = Harness::start_without_worker(
        REQUIRED_MANIFEST,
        &[(".env", "REQUIRED_VALUE=given\nCOUNT=3\n")],
    )
    .await;
    let codebase = harness.monitor.codebase("default").expect("registered");
    assert_eq!(codebase.state, FunctionLoadState::Ready);
    harness.stop().await;
}

const ALIAS_MANIFEST: &str = "specVersion: v1alpha1
params:
  - name: ALIAS_VALUE
    type: string
endpoints:
  api:
    entryPoint: api
    platform: gcfv2
    region: ['{{ params.ALIAS_VALUE }}']
    httpsTrigger: {}
";

#[tokio::test]
async fn the_alias_env_file_is_read_between_the_project_file_and_env_local() {
    let files = [
        (
            ".env",
            "ALIAS_VALUE=us-east1\nBASE_VALUE=base\nLOCAL_VALUE=base\n",
        ),
        (
            ".env.staging",
            "ALIAS_VALUE=europe-west2\nLOCAL_VALUE=alias\n",
        ),
        (".env.local", "LOCAL_VALUE=local\n"),
    ];
    let harness = Harness::start_without_worker_configured(ALIAS_MANIFEST, &files, |config| {
        config.project_alias = Some("staging".to_owned());
    })
    .await;
    let codebase = harness.monitor.codebase("default").expect("registered");
    assert_eq!(codebase.env_files, [".env", ".env.staging", ".env.local"]);
    let console = harness.runtime.console();
    assert!(console.function("europe-west2-api").await.is_some());
    let environment = console.environment("default").await.expect("a codebase");
    let value = |key: &str| {
        environment
            .variables
            .iter()
            .find(|variable| variable.key == key)
            .map(|variable| (variable.value.clone(), variable.file_name.clone()))
    };
    assert_eq!(
        value("ALIAS_VALUE"),
        Some((
            Some("europe-west2".to_owned()),
            Some(".env.staging".to_owned())
        ))
    );
    assert_eq!(
        value("LOCAL_VALUE"),
        Some((Some("local".to_owned()), Some(".env.local".to_owned())))
    );
    harness.stop().await;

    // Selected by its id, the project has no alias: the file is not read.
    let harness = Harness::start_without_worker(ALIAS_MANIFEST, &files).await;
    let codebase = harness.monitor.codebase("default").expect("registered");
    assert_eq!(codebase.env_files, [".env", ".env.local"]);
    assert!(
        harness
            .runtime
            .console()
            .function("us-east1-api")
            .await
            .is_some()
    );
    harness.stop().await;

    // Both a project id file and an alias file: the official refusal.
    let harness = Harness::start_without_worker_configured(
        ALIAS_MANIFEST,
        &[
            (".env.staging", "ALIAS_VALUE=europe-west2\n"),
            (&format!(".env.{PROJECT}"), "ALIAS_VALUE=asia-east1\n"),
        ],
        |config| config.project_alias = Some("staging".to_owned()),
    )
    .await;
    let codebase = harness.monitor.codebase("default").expect("registered");
    assert_eq!(
        codebase.error.expect("refused").message,
        format!(
            "Can't have both dotenv files with projectId (env.{PROJECT}) and projectAlias (.env.staging) as extensions."
        )
    );
    harness.stop().await;
}

const TRIGGERS_MANIFEST: &str = "specVersion: v1alpha1
endpoints:
  api:
    entryPoint: api
    platform: gcfv2
    httpsTrigger: {}
  onUpload:
    entryPoint: onUpload
    platform: gcfv2
    eventTrigger:
      eventType: google.cloud.storage.object.v1.finalized
      eventFilters:
        bucket: uploads
  onCreated:
    entryPoint: onCreated
    platform: gcfv2
    eventTrigger:
      eventType: google.cloud.firestore.document.v1.created
      eventFilters:
        database: (default)
        namespace: (default)
      eventFilterPathPatterns:
        document: orders/{id}
  onMessage:
    entryPoint: onMessage
    platform: gcfv2
    eventTrigger:
      eventType: google.cloud.pubsub.topic.v1.messagePublished
      eventFilters:
        topic: orders
  nightly:
    entryPoint: nightly
    platform: gcfv2
    scheduleTrigger:
      schedule: every 5 minutes
  onUser:
    entryPoint: onUser
    platform: gcfv1
    eventTrigger:
      eventType: providers/firebase.auth/eventTypes/user.create
      eventFilters:
        resource: projects/demo-dispatch
  beforeCreate:
    entryPoint: beforeCreate
    platform: gcfv2
    blockingTrigger:
      eventType: providers/cloud.auth/eventTypes/user.beforeCreate
  onWritten:
    entryPoint: onWritten
    platform: gcfv2
    eventTrigger:
      eventType: google.firebase.database.ref.v1.written
      eventFilters:
        instance: demo-dispatch-default-rtdb
      eventFilterPathPatterns:
        ref: orders/{id}
";

#[tokio::test]
async fn a_trigger_on_a_service_the_suite_does_not_run_is_ignored_with_a_warning() {
    let only_firestore = RunningServices {
        firestore: true,
        auth: false,
        storage: false,
        pubsub: false,
    };
    let harness = Harness::start_without_worker_configured(TRIGGERS_MANIFEST, &[], |config| {
        config.services = only_firestore;
    })
    .await;
    let warnings = messages(&harness.events(), "WARN");
    let ignored = |id: &str, service: &str| {
        format!(
            "functions[{id}]: function ignored because the {service} emulator does not exist or is not running."
        )
    };
    for (id, service) in [
        ("us-central1-onUpload", "storage"),
        ("us-central1-onMessage", "pubsub"),
        ("us-central1-nightly", "pubsub"),
        ("us-central1-onUser", "auth"),
        ("us-central1-beforeCreate", "auth"),
        ("us-central1-onWritten", "database"),
    ] {
        assert!(
            warnings.contains(&ignored(id, service)),
            "{id}: {warnings:#?}"
        );
    }
    let infos = messages(&harness.events(), "INFO");
    assert!(
        infos.contains(
            &"functions[us-central1-onCreated]: firestore function initialized.".to_owned()
        ),
        "{infos:#?}"
    );
    assert_eq!(
        warnings.len(),
        6,
        "only the dead triggers warn: {warnings:#?}"
    );
    let console = harness.runtime.console();
    let upload = console
        .function("us-central1-onUpload")
        .await
        .expect("still listed");
    assert_eq!(
        upload.status,
        RuntimeStatus::Ignored(
            "function ignored because the storage emulator does not exist or is not running."
                .to_owned()
        )
    );
    // A blocking function stays callable on its URL.
    let before = console
        .function("us-central1-beforeCreate")
        .await
        .expect("listed");
    assert_eq!(
        before.path.as_deref(),
        Some("/demo-dispatch/us-central1/beforeCreate")
    );
    assert_eq!(harness.runtime.blocking().await.before_create, None);
    let receipt = harness.runtime.receipt().await.expect("a receipt");
    assert_eq!(receipt.ignored_count, 6);

    // A reload that ignores them for the same reason says it once more at
    // the information level, not as a new warning.
    let before_reload = harness.events().len();
    let reloaded = console.reload("default").await;
    assert!(reloaded.is_ok(), "{reloaded:?}");
    let after: Vec<LogEvent> = harness.events()[before_reload..].to_vec();
    assert!(
        messages(&after, "WARN").is_empty(),
        "{:#?}",
        messages(&after, "WARN")
    );
    assert!(messages(&after, "INFO").contains(&ignored("us-central1-onUpload", "storage")));
    harness.stop().await;

    // Every service running: nothing is ignored but the database trigger.
    let harness = Harness::start_without_worker(TRIGGERS_MANIFEST, &[]).await;
    assert_eq!(
        messages(&harness.events(), "WARN"),
        [ignored("us-central1-onWritten", "database")]
    );
    harness.stop().await;
}
