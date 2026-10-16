//! Compute's sections over a real Functions runtime (its worker never
//! starts: loads, registrations, environments, the matcher, the record and
//! the routes all work without Node), and the section's own facts.
#![allow(clippy::too_many_lines)] // Scenarios read best whole.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode, header};
use firenook_functions_bridge::TriggerRegistry;
use firenook_functions_runtime::monitor::{
    CodebaseRegistration, FunctionCodebaseKind, FunctionKind, InvocationCause, InvocationEnd,
    InvocationOrigin, InvocationOutcome, InvocationOutcomeClass, InvocationStart,
    InvocationSummary, InvocationTarget, LoadReport,
};
use firenook_functions_runtime::{
    CodebaseConfig, EmulatorHosts, FunctionsRuntime, LogDelivery, LogSink, Monitor, MonitorLimits,
    RuntimeConfig, RuntimeOptions,
};
use firenook_suite_front::{RingBudget, ServiceInfo, SuiteDirectory};
use serde_json::Value;
use tower::ServiceExt as _;

use super::*;
use crate::foreign::ForeignProjects;
use crate::instance::Instance;
use crate::jobs::JobRegistry;
use crate::live::badges::BadgeBoard;
use crate::tests::running;
use crate::{ConsoleServices, console_router};

pub(crate) const PROJECT: &str = "demo-compute";

/// A fresh directory, removed when dropped.
pub(crate) struct Scratch(pub(crate) PathBuf);

impl Scratch {
    pub(crate) fn new(name: &str) -> Self {
        use std::sync::atomic::{AtomicU64, Ordering};
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "firenook-compute-{name}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).expect("scratch directory");
        Self(path.canonicalize().expect("canonical"))
    }

    pub(crate) fn path(&self) -> &Path {
        &self.0
    }

    pub(crate) fn write(&self, relative: &str, text: &str) {
        let path = self.0.join(relative);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("directory");
        }
        std::fs::write(path, text).expect("written");
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// The context `console_router` gives a section.
pub(crate) fn context() -> SectionContext {
    SectionContext {
        project: Arc::from(PROJECT),
        shutdown: running(),
        badges: BadgeBoard::default(),
        instance: Instance::new(),
        jobs: JobRegistry::new(),
        rings: RingBudget::new(64 * 1024 * 1024),
        foreign: ForeignProjects::default(),
    }
}

/// The manifest every runtime here loads: one function of each kind the
/// routes treat differently.
pub(crate) const MANIFEST: &str = "specVersion: v1alpha1
params:
  - name: GREETING
    type: string
    default: hi
  - name: API_KEY
    type: secret
endpoints:
  api:
    entryPoint: api
    platform: gcfv2
    httpsTrigger: {}
    timeoutSeconds: '{{ params.TIMEOUT }}'
    minInstances: 2
    secretEnvironmentVariables:
      - key: API_KEY
      - key: MISSING_KEY
  addMessage:
    entryPoint: addMessage
    platform: gcfv2
    callableTrigger: {}
  nightly:
    entryPoint: nightly
    platform: gcfv2
    scheduleTrigger:
      schedule: every 5 minutes
      timeZone: Asia/Kuala_Lumpur
  onOrder:
    entryPoint: onOrder
    platform: gcfv2
    eventTrigger:
      eventType: google.cloud.firestore.document.v1.created
      eventFilters:
        database: (default)
        namespace: (default)
      eventFilterPathPatterns:
        document: orders/{orderId}
  onUpload:
    entryPoint: onUpload
    platform: gcfv2
    eventTrigger:
      eventType: google.cloud.storage.object.v1.finalized
      eventFilters:
        bucket: uploads
  onEmail:
    entryPoint: onEmail
    platform: gcfv1
    eventTrigger:
      eventType: google.pubsub.topic.publish
      eventFilters:
        resource: projects/demo-compute/topics/emails
  resize:
    entryPoint: resize
    platform: gcfv2
    taskQueueTrigger:
      retryConfig:
        maxAttempts: 3
  beforeCreate:
    entryPoint: beforeCreate
    platform: gcfv2
    blockingTrigger:
      eventType: providers/cloud.auth/eventTypes/user.beforeCreate
      options:
        idToken: true
  onGreeted:
    entryPoint: onGreeted
    platform: gcfv2
    eventTrigger:
      eventType: test.greeter.v1.greeted
      channel: firebase
      eventFilters:
        tier: vip
";

/// The channel `onGreeted` listens on.
pub(crate) const CHANNEL: &str = "projects/demo-compute/locations/us-central1/channels/firebase";

/// How a [`Suite`] is set up.
pub(crate) struct Setup {
    /// Files in the codebase directory, besides `functions.yaml`.
    pub(crate) files: Vec<(&'static str, &'static str)>,
    /// The hub services the suite runs; `None` for "did not say".
    pub(crate) services: Option<&'static [&'static str]>,
    pub(crate) pubsub: Option<Late<PubsubConsole>>,
    pub(crate) tasks: Option<Late<TasksConsole>>,
    /// Load the `greeter` extension instance ([`write_greeter`]).
    pub(crate) greeter: bool,
}

impl Default for Setup {
    fn default() -> Self {
        Self {
            files: vec![
                (".env", "# settings\nGREETING=hello\nTIMEOUT=30\n"),
                (".secret.local", "API_KEY=s3cret\n"),
            ],
            services: None,
            pubsub: None,
            tasks: None,
            greeter: false,
        }
    }
}

/// A local extension, `greeter`, with a select, a secret and a validated
/// param, an HTTP function, a task-queue lifecycle function and events.
pub(crate) fn write_greeter(directory: &Scratch) {
    directory.write(
        "extensions-local/greeter/extension.yaml",
        "name: greeter
version: 0.1.0
specVersion: v1beta
displayName: Greeter
description: Greets new users.
license: Apache-2.0
author:
  authorName: Example Author
  url: https://example.com
apis:
  - apiName: firestore.googleapis.com
    reason: Stores greetings.
  - apiName: translate.googleapis.com
    reason: Translates greetings.
roles:
  - role: datastore.user
    reason: Writes greetings.
events:
  - type: test.greeter.v1.greeted
    description: A user was greeted.
  - type: test.greeter.v1.skipped
    description: A user was skipped.
lifecycleEvents:
  onInstall:
    function: backfill
    processingMessage: Greeting existing users
resources:
  - name: greet
    type: firebaseextensions.v1beta.function
    description: Greets one user.
    properties:
      location: ${param:LOCATION}
      runtime: nodejs22
      httpsTrigger: {}
  - name: backfill
    type: firebaseextensions.v1beta.function
    description: Greets existing users.
    properties:
      location: ${param:LOCATION}
      runtime: nodejs22
      taskQueueTrigger: {}
params:
  - param: LOCATION
    label: Location
    type: select
    default: us-central1
    required: true
    immutable: true
    options:
      - value: us-central1
        label: Iowa
      - value: europe-west1
        label: Belgium
  - param: GREETING
    label: Greeting
    type: string
    default: Hello
    validationRegex: ^[A-Z].*$
    validationErrorMessage: Start with a capital letter.
  - param: API_KEY
    type: secret
    required: true
",
    );
    directory.write(
        "extensions-local/greeter/POSTINSTALL.md",
        "# Greeter\n\nSee [Firestore](http://127.0.0.1:4000/firestore) for greetings.\n",
    );
    directory.write(
        "extensions-local/greeter/functions/package.json",
        "{\"name\":\"greeter\"}",
    );
    directory.write(
        "extensions/greeter.env",
        "LOCATION=us-central1\nGREETING=hello\nEVENTARC_CHANNEL=projects/demo-compute/locations/us-central1/channels/firebase\nALLOWED_EVENT_TYPES=test.greeter.v1.greeted\n",
    );
}

/// The loader configuration over `directory`'s `greeter` instance.
pub(crate) fn extensions_config(directory: &Scratch) -> firenook_extensions::ExtensionsConfig {
    firenook_extensions::ExtensionsConfig {
        project_id: PROJECT.to_owned(),
        project_dir: directory.path().to_path_buf(),
        extensions: vec![(
            "greeter".to_owned(),
            "./extensions-local/greeter".to_owned(),
        )],
        aliases: Vec::new(),
        database_url: format!("https://{PROJECT}.firebaseio.com"),
        storage_bucket: format!("{PROJECT}.appspot.com"),
        npm: PathBuf::from("npm"),
        cache_dir: directory.path().join("cache"),
        endpoints: firenook_extensions::registry::Endpoints {
            registry_origin: "http://127.0.0.1:1".to_owned(),
            token_origin: "http://127.0.0.1:1".to_owned(),
            client_id: String::new(),
            client_secret: String::new(),
        },
        credential: None,
        offline: true,
        ui_origin: Some("http://127.0.0.1:4000/".to_owned()),
    }
}

/// Compute's section over a running runtime (or none yet).
pub(crate) struct Suite {
    pub(crate) parts: ComputeParts,
    pub(crate) section: ComputeSection,
    pub(crate) context: SectionContext,
    pub(crate) router: Router,
    pub(crate) runtime: Option<FunctionsRuntime>,
    pub(crate) directory: Scratch,
}

impl Suite {
    /// The section before Functions start.
    pub(crate) fn starting() -> Self {
        let parts = ComputeParts::new();
        Self::assemble(parts, Setup::default(), None, Scratch::new("starting"))
    }

    /// The section over a runtime that loaded [`MANIFEST`], handed over.
    pub(crate) async fn running(setup: Setup) -> Self {
        let directory = Scratch::new("suite");
        directory.write("functions/functions.yaml", MANIFEST);
        directory.write(
            "functions/package.json",
            "{\"name\":\"compute\",\"main\":\"index.js\"}",
        );
        directory.write("functions/index.js", "");
        for (name, text) in &setup.files {
            directory.write(&format!("functions/{name}"), text);
        }
        let monitor = Monitor::new(MonitorLimits::default());
        let services = setup.services.map(|services| {
            services
                .iter()
                .map(|service| (*service).to_owned())
                .collect::<BTreeSet<_>>()
        });
        let parts = ComputeParts::for_suite(
            monitor.clone(),
            Some("http://127.0.0.1:5001".to_owned()),
            services,
        );
        let triggers = TriggerRegistry::default();
        let (log, _events) = LogSink::recording();
        let greeter = setup.greeter;
        if greeter {
            write_greeter(&directory);
        }
        // The console exists before Functions start, as in a suite.
        let mut suite = Self::assemble(parts, setup, None, directory);
        let loaded = if greeter {
            let config = extensions_config(&suite.directory);
            let outcome = firenook_extensions::load_outcome(&config, &log)
                .await
                .expect("the extension loads");
            Some((config, outcome))
        } else {
            None
        };
        let root = suite.directory.path().to_path_buf();
        let host = "127.0.0.1:1".to_owned();
        let config = RuntimeConfig {
            project_id: PROJECT.to_owned(),
            project_alias: None,
            host: "127.0.0.1".to_owned(),
            functions_port: 5001,
            project_dir: root.clone(),
            node: PathBuf::from("/nonexistent/firenook-test-node"),
            state_dir: root.join("state"),
            default_bucket: format!("{PROJECT}.appspot.com"),
            hosts: EmulatorHosts {
                firestore: host.clone(),
                auth: host.clone(),
                storage: host.clone(),
                pubsub: host.clone(),
                hub: host.clone(),
                eventarc: host.clone(),
                tasks: host,
            },
            codebases: vec![CodebaseConfig {
                id: "default".to_owned(),
                source_dir: root.join("functions"),
                runtime: Some("nodejs22".to_owned()),
                ignore: Vec::new(),
                config_dir: None,
            }],
            extensions: loaded
                .as_ref()
                .map(|(_, outcome)| {
                    outcome
                        .loaded
                        .iter()
                        .map(|extension| extension.backend.clone())
                        .collect()
                })
                .unwrap_or_default(),
            inspect: None,
        };
        let runtime = FunctionsRuntime::start_with(
            config,
            triggers,
            log.clone(),
            RuntimeOptions {
                monitor: monitor.clone(),
                log_delivery: LogDelivery::Attributed,
            },
        )
        .await
        .expect("the runtime starts");
        let control = loaded.map(|(config, outcome)| {
            firenook_extensions::control::ExtensionsControl::new(
                config,
                &outcome,
                runtime.console(),
                monitor,
                log,
            )
        });
        suite.parts.hand_over(runtime.console(), control);
        suite.parts.late.set(ComputeConsole {
            functions: runtime.router(),
            eventarc: runtime.eventarc_router(),
        });
        suite.runtime = Some(runtime);
        suite
    }

    fn assemble(
        parts: ComputeParts,
        setup: Setup,
        runtime: Option<FunctionsRuntime>,
        directory: Scratch,
    ) -> Self {
        let section = ComputeSection {
            parts: parts.clone(),
            pubsub: setup.pubsub,
            tasks: setup.tasks,
        };
        let context = context();
        let router = section.router(&context);
        Self {
            parts,
            section,
            context,
            router,
            runtime,
            directory,
        }
    }

    pub(crate) fn monitor(&self) -> &Monitor {
        self.parts.monitor()
    }

    pub(crate) fn topic(&self, name: &str) -> Arc<dyn LiveTopic> {
        self.section
            .topics(&self.context)
            .into_iter()
            .find(|topic| topic.name() == name)
            .unwrap_or_else(|| panic!("a {name} topic"))
    }

    pub(crate) async fn send(
        &self,
        method: Method,
        uri: &str,
        body: Option<Value>,
    ) -> (StatusCode, Vec<u8>) {
        let mut request = Request::builder().method(method).uri(uri);
        let body = match body {
            Some(body) => {
                request = request.header(header::CONTENT_TYPE, "application/json");
                Body::from(body.to_string())
            }
            None => Body::empty(),
        };
        let response = self
            .router
            .clone()
            .oneshot(request.body(body).expect("request"))
            .await
            .expect("response");
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body")
            .to_vec();
        (status, bytes)
    }

    pub(crate) async fn get(&self, uri: &str) -> (StatusCode, Value) {
        let (status, bytes) = self.send(Method::GET, uri, None).await;
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    pub(crate) async fn post(&self, uri: &str, body: Value) -> (StatusCode, Value) {
        let (status, bytes) = self.send(Method::POST, uri, Some(body)).await;
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    /// The NDJSON lines of a streamed answer.
    pub(crate) async fn post_lines(&self, uri: &str, body: Value) -> (StatusCode, Vec<Value>) {
        let (status, bytes) = self.send(Method::POST, uri, Some(body)).await;
        let lines = String::from_utf8_lossy(&bytes)
            .lines()
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_str(line).unwrap_or(Value::Null))
            .collect();
        (status, lines)
    }

    pub(crate) async fn stop(self) {
        if let Some(runtime) = self.runtime {
            runtime.shutdown().await;
        }
    }
}

/// Waits (up to 10 s) until `check` holds.
pub(crate) async fn eventually(what: &str, mut check: impl AsyncFnMut() -> bool) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while !check().await {
        assert!(
            std::time::Instant::now() < deadline,
            "timed out waiting for {what}"
        );
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
}

/// An invocation recorded straight into a monitor.
pub(crate) fn begin(
    monitor: &Monitor,
    function: &str,
    kind: FunctionKind,
    cause: InvocationCause,
    headers: &[(&str, &str)],
) -> firenook_functions_runtime::monitor::InvocationToken {
    let mut map = axum::http::HeaderMap::new();
    for (name, value) in headers {
        map.insert(
            axum::http::HeaderName::from_bytes(name.as_bytes()).expect("name"),
            axum::http::HeaderValue::from_str(value).expect("value"),
        );
    }
    monitor.begin(InvocationStart {
        function_id: function.to_owned(),
        codebase: "default".to_owned(),
        kind,
        origin: InvocationOrigin::Emulator,
        cause,
        summary: "POST /".to_owned(),
        target: InvocationTarget::Trigger,
        method: "POST".to_owned(),
        path: "/".to_owned(),
        headers: map,
        body: axum::body::Bytes::from_static(b"{\"hello\":\"world\"}"),
        replay_of: None,
        delivery: None,
    })
}

/// Finishes an invocation with `status` (an outcome classified from it).
pub(crate) fn finish(
    monitor: &Monitor,
    token: &firenook_functions_runtime::monitor::InvocationToken,
    status: u16,
) {
    monitor.response_head(token, status, &axum::http::HeaderMap::new());
    monitor.finish(token, InvocationEnd::default());
}

/// An invocation summary for tests that need one without a monitor.
pub(crate) fn summary(seq: u64, function: &str, kind: FunctionKind) -> InvocationSummary {
    InvocationSummary {
        id: format!("abc123-{seq}"),
        seq,
        function_id: function.to_owned(),
        codebase: "default".to_owned(),
        kind,
        origin: InvocationOrigin::Emulator,
        cause: InvocationCause::Unknown,
        summary: "POST /".to_owned(),
        started_at: "2026-10-12T08:00:00.000Z".to_owned(),
        duration_ms: Some(12.0),
        outcome: Some(InvocationOutcome::Succeeded),
        outcome_class: InvocationOutcomeClass::Succeeded,
        status: Some(200),
        callable_status: None,
        cold: false,
        attempt: 1,
        event_id: None,
        replay_of: None,
        log_count: 0,
        error: None,
    }
}

// ── The section's own facts ──────────────────────────────────────────────

#[tokio::test]
async fn statuses_say_starting_until_functions_are_handed_over() {
    let suite = Suite::starting();
    let states: Vec<_> = suite
        .section
        .statuses()
        .into_iter()
        .map(|status| (status.id, status.state))
        .collect();
    assert_eq!(
        states,
        [
            (
                "functions".to_owned(),
                crate::section::SectionState::Starting
            ),
            (
                "extensions".to_owned(),
                crate::section::SectionState::Starting
            ),
            (
                "eventarc".to_owned(),
                crate::section::SectionState::Starting
            ),
        ]
    );
    assert_eq!(
        suite.section.statuses()[0].detail.as_deref(),
        Some("Discovering functions…")
    );
    let mut changes = suite.section.status_changes().expect("ticks");
    suite.parts.late.set(ComputeConsole {
        functions: Router::new(),
        eventarc: Router::new(),
    });
    tokio::time::timeout(std::time::Duration::from_secs(2), changes.next())
        .await
        .expect("a tick")
        .expect("open");
    assert!(
        suite
            .section
            .statuses()
            .iter()
            .all(|status| status.state == crate::section::SectionState::Ready)
    );
}

#[tokio::test]
async fn summaries_count_functions_codebases_failing_loads_instances_and_events() {
    let suite = Suite::starting();
    let monitor = suite.monitor();
    for (id, kind) in [
        ("default", FunctionCodebaseKind::User),
        ("jobs", FunctionCodebaseKind::User),
        ("greeter", FunctionCodebaseKind::Extension),
    ] {
        monitor.codebase_registered(CodebaseRegistration {
            id: id.to_owned(),
            kind,
            directory: id.to_owned(),
            runtime: None,
            inspect_port: None,
        });
    }
    let loaded = |count| LoadReport {
        function_count: count,
        env_files: Vec::new(),
        not_loaded: Vec::new(),
        error: None,
        kept_previous: false,
        diff: firenook_functions_runtime::monitor::FunctionRegistryDiff::default(),
        elapsed: std::time::Duration::from_millis(5),
    };
    monitor.codebase_loaded("default", loaded(1_203));
    monitor.codebase_loaded("greeter", loaded(1));
    monitor.codebase_loaded(
        "jobs",
        LoadReport {
            error: Some(firenook_functions_runtime::monitor::load_error(
                "SyntaxError: Unexpected token",
                Path::new("/project"),
                std::time::SystemTime::now(),
            )),
            ..loaded(0)
        },
    );
    let functions = suite.section.summary("functions").expect("a summary");
    assert_eq!(
        functions.headline,
        "1,204 functions · 2 codebases · 1 failing load"
    );
    let figures: Vec<_> = functions
        .figures
        .iter()
        .map(|figure| (figure.label.as_str(), figure.value))
        .collect();
    assert_eq!(
        figures,
        [
            ("Functions", Some(1_204)),
            ("Codebases", Some(2)),
            ("Failing loads", Some(1)),
        ]
    );
    assert_eq!(
        suite
            .section
            .summary("extensions")
            .expect("a summary")
            .headline,
        "1 instance"
    );
    assert_eq!(
        suite
            .section
            .summary("eventarc")
            .expect("a summary")
            .headline,
        "0 events kept"
    );
    assert!(suite.section.summary("pubsub").is_none());
}

#[tokio::test]
async fn the_failed_badge_counts_failures_and_the_load_badge_follows_failing_codebases() {
    let suite = Suite::starting();
    let monitor = suite.monitor();
    // The sink is installed with the section's live state.
    let _ = suite.section.topics(&suite.context);
    let badge = |id: &str| {
        suite
            .context
            .badges
            .snapshot()
            .badges
            .into_iter()
            .find(|badge| badge.id == id)
            .unwrap_or_else(|| panic!("a {id} badge"))
    };
    assert_eq!(badge("functions.failed").count, 0);
    assert_eq!(badge("functions.load").count, 0);
    let ok = begin(
        monitor,
        "us-central1-api",
        FunctionKind::Http,
        InvocationCause::Unknown,
        &[],
    );
    finish(monitor, &ok, 200);
    let failed = begin(
        monitor,
        "us-central1-api",
        FunctionKind::Http,
        InvocationCause::Unknown,
        &[],
    );
    finish(monitor, &failed, 500);
    let skipped = begin(
        monitor,
        "us-central1-api",
        FunctionKind::Http,
        InvocationCause::Unknown,
        &[],
    );
    monitor.finish(
        &skipped,
        InvocationEnd {
            outcome: Some(InvocationOutcome::Paused),
            ..InvocationEnd::default()
        },
    );
    assert_eq!(badge("functions.failed").count, 1);
    assert_eq!(
        badge("functions.failed").tone,
        crate::live::badges::BadgeTone::Danger
    );
    monitor.codebase_registered(CodebaseRegistration {
        id: "default".to_owned(),
        kind: FunctionCodebaseKind::User,
        directory: "functions".to_owned(),
        runtime: None,
        inspect_port: None,
    });
    let failing = LoadReport {
        function_count: 0,
        env_files: Vec::new(),
        not_loaded: Vec::new(),
        error: Some(firenook_functions_runtime::monitor::load_error(
            "Error: boom",
            Path::new("/project"),
            std::time::SystemTime::now(),
        )),
        kept_previous: false,
        diff: firenook_functions_runtime::monitor::FunctionRegistryDiff::default(),
        elapsed: std::time::Duration::from_millis(1),
    };
    monitor.codebase_loaded("default", failing.clone());
    assert_eq!(badge("functions.load").count, 1);
    monitor.codebase_loaded(
        "default",
        LoadReport {
            error: None,
            function_count: 3,
            ..failing
        },
    );
    assert_eq!(badge("functions.load").count, 0);
}

#[tokio::test]
async fn compute_mutations_sit_under_the_console_guard() {
    let parts = ComputeParts::new();
    let router = console_router(ConsoleServices {
        compute: Some(parts),
        ..ConsoleServices::new(
            SuiteDirectory::new(
                PROJECT,
                [ServiceInfo::listening("hub", "127.0.0.1", 34_400)],
            )
            .expect("directory"),
            running(),
        )
    });
    let send = |request: Request<Body>| {
        let router = router.clone();
        async move { router.oneshot(request).await.expect("response").status() }
    };
    let cross_site = Request::post("/api/v1/functions/invocations/abc-1/replay")
        .header(header::CONTENT_TYPE, "application/json")
        .header("sec-fetch-site", "cross-site")
        .body(Body::from("{}"))
        .expect("request");
    assert_eq!(send(cross_site).await, StatusCode::FORBIDDEN);
    let form = Request::post("/api/v1/functions/codebases/default/reload")
        .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
        .body(Body::from("a=b"))
        .expect("request");
    assert_eq!(send(form).await, StatusCode::UNSUPPORTED_MEDIA_TYPE);
    // The console's own call reaches the route, which answers while
    // Functions start.
    let own = Request::post("/api/v1/functions/codebases/default/reload")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from("{}"))
        .expect("request");
    assert_eq!(send(own).await, StatusCode::SERVICE_UNAVAILABLE);
    let snapshot = Request::get("/api/v1/functions")
        .body(Body::empty())
        .expect("request");
    assert_eq!(send(snapshot).await, StatusCode::OK);
}

#[tokio::test]
async fn watchers_and_the_extension_hand_over_are_kept_until_asked() {
    let parts = ComputeParts::new();
    assert!(parts.take_extensions().is_none());
    parts.hand_over_extensions(firenook_extensions::LoadOutcome::default());
    assert!(parts.take_extensions().is_some());
    assert!(parts.take_extensions().is_none(), "taken once");
    let directory = Scratch::new("watch");
    let watcher = firenook_functions_runtime::watcher::SourceWatcher::start(
        directory.path(),
        firenook_functions_runtime::watcher::WatchMode::NonRecursive,
        |_| true,
        |_| {},
    )
    .expect("a watcher");
    parts.keep_watcher(watcher);
    assert_eq!(parts.watcher_count(), 1);
    parts.stop_watchers();
    assert_eq!(parts.watcher_count(), 0);
    assert!(!parts.handed_over());
}

// ── Generated bindings ───────────────────────────────────────────────────

#[test]
fn compute_bindings_carry_their_family_names_and_no_comment_closers() {
    let directory = Scratch::new("bindings");
    export_bindings(&ts_rs::Config::new().with_out_dir(directory.path()));
    let compute = directory.path().join("compute");
    let summary = std::fs::read_to_string(compute.join("InvocationSummary.ts")).expect("written");
    assert!(
        summary.contains("outcomeClass: InvocationOutcomeClass"),
        "{summary}"
    );
    let mut names = Vec::new();
    for entry in std::fs::read_dir(&compute).expect("compute bindings") {
        let path = entry.expect("entry").path();
        let name = path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or_default()
            .to_owned();
        let text = std::fs::read_to_string(&path).expect("readable");
        // A doc comment holding `*/` would end the generated comment early.
        for comment in text.split("/**").skip(1) {
            let body = comment.split("*/").next().unwrap_or_default();
            assert!(!body.contains("*/"), "{name}");
        }
        names.push(name);
    }
    assert!(names.len() > 60, "{} compute bindings", names.len());
    let strays: Vec<&String> = names
        .iter()
        .filter(|name| {
            !["Function", "Invocation", "Eventarc", "Extension"]
                .iter()
                .any(|family| name.starts_with(family))
        })
        .collect();
    assert!(strays.is_empty(), "{strays:?}");
    // Every compute type lands in compute/, none at the root.
    let root: Vec<_> = std::fs::read_dir(directory.path())
        .expect("root")
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name != "compute")
        .collect();
    assert!(
        root.iter()
            .all(|name| !name.starts_with("Function") && !name.starts_with("Invocation")),
        "{root:?}"
    );
}
