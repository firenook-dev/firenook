//! The console handle over a running runtime: functions and their keys,
//! environments, env edits that reload or put files back, the one matcher,
//! Eventarc's channels, and calls that are recorded however they end.
#![allow(clippy::too_many_lines)] // Scenarios read best whole.

mod support;

use std::collections::BTreeMap;
use std::time::Duration;

use axum::body::Bytes;
use firenook_functions_runtime::LogDelivery;
use firenook_functions_runtime::console::{
    AuthEvent, ConsoleError, DispatchFrame, DispatchInput, DispatchTarget, EnvChange, EnvFile,
    EnvSource, FirestoreChange, MatchInput, RuntimeStatus, StorageEvent, TriggersQuery,
};
use firenook_functions_runtime::monitor::{
    EventarcOrigin, FunctionKind, FunctionStale, InvocationOrigin, InvocationOutcome,
};
use serde_json::json;
use support::{Harness, PROJECT, eventually};

const MANIFEST: &str = "specVersion: v1alpha1
params:
  - name: GREETING
    type: string
    default: hi
  - name: API_KEY
    type: secret
  - name: UNSET
    type: string
    default: later
  - name: TAGS
    type: list
    default: [a, b]
endpoints:
  api:
    entryPoint: api
    platform: gcfv2
    httpsTrigger: {}
    timeoutSeconds: '{{ params.TIMEOUT }}'
    minInstances: 2
    secretEnvironmentVariables:
      - key: API_KEY
  addMessage:
    entryPoint: addMessage
    platform: gcfv2
    callableTrigger: {}
  nightly:
    entryPoint: nightly
    platform: gcfv2
    scheduleTrigger:
      schedule: every 5 minutes
  onOrder:
    entryPoint: onOrder
    platform: gcfv1
    eventTrigger:
      eventType: providers/cloud.firestore/eventTypes/document.create
      eventFilters:
        resource: projects/demo-dispatch/databases/(default)/documents/orders/{orderId}
  onAnyOrder:
    entryPoint: onAnyOrder
    platform: gcfv2
    eventTrigger:
      eventType: google.cloud.firestore.document.v1.written
      eventFilters:
        database: (default)
        namespace: (default)
      eventFilterPathPatterns:
        document: orders/{rest=**}
  onUpload:
    entryPoint: onUpload
    platform: gcfv2
    eventTrigger:
      eventType: google.cloud.storage.object.v1.finalized
      eventFilters:
        bucket: uploads
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
      options:
        idToken: true
  onEmail:
    entryPoint: onEmail
    platform: gcfv1
    eventTrigger:
      eventType: google.pubsub.topic.publish
      eventFilters:
        resource: projects/demo-dispatch/topics/emails
  resize:
    entryPoint: resize
    platform: gcfv2
    taskQueueTrigger: {}
  onGreeted:
    entryPoint: onGreeted
    platform: gcfv2
    eventTrigger:
      eventType: test.greeter.v1.greeted
      channel: firebase
      eventFilters:
        tier: vip
";

const CHANNEL: &str = "projects/demo-dispatch/locations/us-central1/channels/firebase";

async fn offline() -> Harness {
    Harness::start_without_worker(
        MANIFEST,
        &[
            (".env", "# settings\nGREETING=hello\nTIMEOUT=30\n"),
            (".env.local", "LOCAL_ONLY=1\n"),
            (".secret.local", "API_KEY=s3cret\n"),
        ],
    )
    .await
}

#[tokio::test]
async fn functions_group_their_keys_and_read_their_status() {
    let harness = offline().await;
    let console = harness.runtime.console();
    let functions = console.functions().await;
    let ids: Vec<&str> = functions.iter().map(|view| view.id.as_str()).collect();
    assert!(
        ids.contains(&"us-central1-api") && ids.contains(&"us-central1-onGreeted"),
        "{ids:?}"
    );
    let api = console.function("us-central1-api").await.expect("listed");
    assert_eq!(api.kind, FunctionKind::Http);
    assert_eq!(api.path.as_deref(), Some("/demo-dispatch/us-central1/api"));
    assert_eq!(api.timeout_seconds, 30);
    assert_eq!(api.status, RuntimeStatus::Receiving);
    assert_eq!(api.secrets.len(), 1);
    assert!(api.secrets[0].provided);
    assert_eq!(api.declared, [("minInstances".to_owned(), json!(2))]);
    let greeting = api
        .params
        .iter()
        .find(|param| param.name == "GREETING")
        .expect("declared");
    assert_eq!(greeting.value.as_deref(), Some("hello"));
    assert_eq!(greeting.file.as_deref(), Some(".env"));
    assert!(!greeting.unresolved);
    let secret = api
        .params
        .iter()
        .find(|param| param.name == "API_KEY")
        .expect("declared");
    assert!(secret.secret && secret.value.is_none() && !secret.unresolved);
    // No file sets it: the codebase loaded with its default, and the
    // console still offers to write it where the official prompt would.
    let unset = api
        .params
        .iter()
        .find(|param| param.name == "UNSET")
        .expect("declared");
    assert!(unset.unresolved);
    assert_eq!(unset.value.as_deref(), Some("later"));
    assert_eq!(unset.file, None);
    // Only functions the URL route reaches have a path.
    let nightly = console
        .function("us-central1-nightly")
        .await
        .expect("listed");
    assert_eq!(nightly.kind, FunctionKind::Schedule);
    assert_eq!(nightly.path, None);
    assert!(
        console
            .function("us-central1-addMessage")
            .await
            .expect("listed")
            .path
            .is_some()
    );
    let blocking = console
        .function("us-central1-beforeCreate")
        .await
        .expect("listed");
    assert!(blocking.path.is_some());
    let wired = blocking.blocking.expect("blocking");
    assert!(wired.wired && wired.forward.id_token && !wired.forward.access_token);
    // Pausing and resuming background triggers leaves the old key behind;
    // the current one comes first.
    harness.runtime.set_background_enabled(false).await;
    let paused = console
        .function("us-central1-onEmail")
        .await
        .expect("listed");
    assert_eq!(paused.status, RuntimeStatus::Paused);
    harness.runtime.set_background_enabled(true).await;
    let resumed = console
        .function("us-central1-onEmail")
        .await
        .expect("listed");
    assert_eq!(resumed.status, RuntimeStatus::Receiving);
    let keys: Vec<(Option<u32>, bool)> = resumed
        .keys
        .iter()
        .map(|key| (key.generation, key.enabled))
        .collect();
    assert_eq!(keys, [(Some(1), true), (Some(0), false)]);
    harness.stop().await;
}

#[tokio::test]
async fn environments_name_each_file_and_never_list_inherited_values() {
    let harness = offline().await;
    let console = harness.runtime.console();
    let environment = console.environment("default").await.expect("known");
    assert_eq!(environment.files, [".env", ".env.local"]);
    assert!(environment.editable);
    let greeting = environment
        .variables
        .iter()
        .find(|variable| variable.key == "GREETING")
        .expect("listed");
    assert_eq!(greeting.value.as_deref(), Some("hello"));
    assert_eq!(greeting.source, EnvSource::DotEnv);
    assert_eq!(greeting.file, Some(EnvFile::Env));
    let local = environment
        .variables
        .iter()
        .find(|variable| variable.key == "LOCAL_ONLY")
        .expect("listed");
    assert_eq!(local.file, Some(EnvFile::EnvLocal));
    let secret = environment
        .variables
        .iter()
        .find(|variable| variable.key == "API_KEY")
        .expect("listed");
    assert!(secret.secret && secret.value.is_none());
    // A param no env file sets is listed with the default the worker gets,
    // from no file; a list as the JSON `.value()` parses.
    let variable = |key: &str| {
        environment
            .variables
            .iter()
            .find(|variable| variable.key == key)
            .cloned()
            .expect("listed")
    };
    let unset = variable("UNSET");
    assert_eq!(unset.value.as_deref(), Some("later"));
    assert_eq!(unset.source, EnvSource::ParamDefault);
    assert_eq!((unset.file, unset.file_name), (None, None));
    assert_eq!(variable("TAGS").value.as_deref(), Some(r#"["a","b"]"#));
    assert_eq!(variable("TAGS").source, EnvSource::ParamDefault);
    assert!(
        environment
            .variables
            .iter()
            .filter(|variable| variable.key == "GREETING")
            .count()
            == 1,
        "an env file value is listed once, from its file"
    );
    assert!(
        environment
            .variables
            .iter()
            .any(|variable| variable.key == "FUNCTIONS_EMULATOR"
                && variable.source == EnvSource::Emulator)
    );
    // The engine's own environment is counted, never listed.
    assert!(environment.inherited > 0);
    for (key, value) in std::env::vars() {
        assert!(
            !environment
                .variables
                .iter()
                .any(|variable| variable.key == key
                    && variable.source != EnvSource::Emulator
                    && variable.value.as_deref() == Some(value.as_str())),
            "{key} leaked"
        );
    }
    assert!(
        !environment
            .variables
            .iter()
            .any(|variable| variable.key == "PATH")
    );
    assert_eq!(
        console.secret("default", "API_KEY").await.as_deref(),
        Some("s3cret")
    );
    assert_eq!(console.secret("default", "MISSING").await, None);
    assert!(console.environment("nope").await.is_none());
    harness.stop().await;
}

#[tokio::test]
async fn env_edits_reload_once_or_put_every_byte_back() {
    let harness = offline().await;
    let console = harness.runtime.console();
    let env = harness
        .directory
        .path()
        .canonicalize()
        .expect("a path")
        .join("functions/.env");
    let written = console
        .edit_env(
            "default",
            vec![
                EnvChange {
                    file: EnvFile::Env,
                    key: "GREETING".to_owned(),
                    value: Some("good day".to_owned()),
                },
                EnvChange {
                    file: EnvFile::SecretLocal,
                    key: "OTHER_SECRET".to_owned(),
                    value: Some("x".to_owned()),
                },
            ],
        )
        .await
        .expect("written and reloaded");
    assert_eq!(written, [".env", ".secret.local"]);
    assert_eq!(
        std::fs::read_to_string(&env).expect("read"),
        "# settings\nGREETING=\"good day\"\nTIMEOUT=30\n"
    );
    let environment = console.environment("default").await.expect("known");
    assert!(environment.variables.iter().any(
        |variable| variable.key == "GREETING" && variable.value.as_deref() == Some("good day")
    ));
    assert_eq!(harness.monitor.codebase("default").expect("known").loads, 2);
    // A value the load refuses puts the files back, byte for byte.
    let before = std::fs::read(&env).expect("read");
    let refused = console
        .edit_env(
            "default",
            vec![EnvChange {
                file: EnvFile::Env,
                key: "TIMEOUT".to_owned(),
                value: Some("soon".to_owned()),
            }],
        )
        .await
        .expect_err("refused");
    let ConsoleError::Conflict { message, detail } = refused else {
        panic!("a conflict: {refused:?}");
    };
    assert_eq!(
        message,
        "default did not load with this change, so your files were put back."
    );
    assert!(
        detail
            .expect("the load error")
            .contains("Parameter value soon is not an integer")
    );
    assert_eq!(std::fs::read(&env).expect("read"), before);
    assert_eq!(
        harness.monitor.codebase("default").expect("known").state,
        firenook_functions_runtime::monitor::FunctionLoadState::Ready
    );
    // Keys the dialect refuses, and files that do not exist here.
    assert!(matches!(
        console
            .edit_env(
                "default",
                vec![EnvChange {
                    file: EnvFile::Env,
                    key: "lowercase".to_owned(),
                    value: Some("x".to_owned()),
                }],
            )
            .await,
        Err(ConsoleError::Invalid(_))
    ));
    assert!(matches!(
        console
            .edit_env(
                "default",
                vec![EnvChange {
                    file: EnvFile::EnvAlias,
                    key: "A".to_owned(),
                    value: Some("x".to_owned()),
                }],
            )
            .await,
        Err(ConsoleError::Invalid(_))
    ));
    harness.stop().await;
}

#[tokio::test]
async fn an_env_file_changed_in_an_editor_flags_the_codebase_without_reloading() {
    let harness = offline().await;
    let env = harness
        .directory
        .path()
        .canonicalize()
        .expect("a path")
        .join("functions/.env");
    // Give the platform's watcher a moment to start delivering.
    tokio::time::sleep(Duration::from_millis(200)).await;
    // A touch with the same bytes is not a change.
    std::fs::write(&env, "# settings\nGREETING=hello\nTIMEOUT=30\n").expect("written");
    tokio::time::sleep(Duration::from_millis(1_600)).await;
    assert_eq!(
        harness.monitor.codebase("default").expect("known").stale,
        None
    );
    std::fs::write(&env, "# settings\nGREETING=changed\nTIMEOUT=30\n").expect("written");
    eventually("the stale flag", || {
        harness
            .monitor
            .codebase("default")
            .is_some_and(|codebase| codebase.stale.is_some())
    })
    .await;
    let codebase = harness.monitor.codebase("default").expect("known");
    assert!(
        matches!(codebase.stale, Some(FunctionStale::EnvChanged { ref file, .. }) if file == ".env")
    );
    assert_eq!(codebase.loads, 1);
    harness.stop().await;
}

#[tokio::test]
async fn one_matcher_answers_who_fires_and_why_not() {
    let harness = offline().await;
    let console = harness.runtime.console();
    let listeners = |query: TriggersQuery| {
        let console = console.clone();
        async move {
            let mut ids: Vec<String> = console
                .triggers(&query)
                .await
                .into_iter()
                .map(|listener| listener.function_id)
                .collect();
            ids.sort();
            ids
        }
    };
    assert_eq!(
        listeners(TriggersQuery::parse("firestore", "(default)|orders/o_1", None).expect("valid"))
            .await,
        ["us-central1-onAnyOrder", "us-central1-onOrder"]
    );
    assert_eq!(
        listeners(
            TriggersQuery::parse("firestore", "(default)|orders/o_1", Some("updated"))
                .expect("valid")
        )
        .await,
        ["us-central1-onAnyOrder"]
    );
    assert_eq!(
        listeners(TriggersQuery::parse("firestore", "other|orders/o_1", None).expect("valid"))
            .await,
        Vec::<String>::new()
    );
    assert_eq!(
        listeners(TriggersQuery::parse("storage", "uploads|a.png", None).expect("valid")).await,
        ["us-central1-onUpload"]
    );
    assert_eq!(
        listeners(TriggersQuery::parse("storage", "other|a.png", None).expect("valid")).await,
        Vec::<String>::new()
    );
    assert_eq!(
        listeners(TriggersQuery::parse("auth", "", None).expect("valid")).await,
        ["us-central1-beforeCreate", "us-central1-onUser"]
    );
    assert_eq!(
        listeners(
            TriggersQuery::parse("pubsub", "projects/demo-dispatch/topics/emails", None)
                .expect("valid")
        )
        .await,
        ["us-central1-onEmail"]
    );
    assert_eq!(
        listeners(
            TriggersQuery::parse(
                "pubsub",
                "projects/demo-dispatch/topics/firebase-schedule-nightly",
                None
            )
            .expect("valid")
        )
        .await,
        ["us-central1-nightly"]
    );
    assert_eq!(
        listeners(
            TriggersQuery::parse(
                "eventarc",
                &format!("{CHANNEL}|test.greeter.v1.greeted"),
                None
            )
            .expect("valid")
        )
        .await,
        ["us-central1-onGreeted"]
    );
    assert_eq!(
        listeners(
            TriggersQuery::parse("tasks", "queue:demo-dispatch-us-central1-resize", None)
                .expect("valid")
        )
        .await,
        ["us-central1-resize"]
    );
    // Why not, per change.
    let matches = console
        .match_triggers(&MatchInput::Firestore {
            database: "(default)".to_owned(),
            path: "orders/o_1/items/i_1".to_owned(),
            changes: vec![FirestoreChange::Created, FirestoreChange::Deleted],
        })
        .await;
    let row = |function: &str, change: &str| {
        matches
            .iter()
            .find(|row| row.function_id == function && row.change.as_deref() == Some(change))
            .cloned()
            .expect("a row")
    };
    assert!(row("us-central1-onAnyOrder", "created").fires);
    assert_eq!(
        row("us-central1-onAnyOrder", "created").reason,
        "matches orders/{rest=**}"
    );
    assert!(!row("us-central1-onOrder", "created").fires);
    assert_eq!(
        row("us-central1-onOrder", "created").reason,
        "orders/{orderId} does not match orders/o_1/items/i_1"
    );
    assert_eq!(
        row("us-central1-onOrder", "deleted").reason,
        "listens for created documents, not deleted ones"
    );
    let eventarc = console
        .match_triggers(&MatchInput::Eventarc {
            channel: CHANNEL.to_owned(),
            event_type: "test.greeter.v1.greeted".to_owned(),
            attributes: BTreeMap::from([("tier".to_owned(), "gold".to_owned())]),
        })
        .await;
    assert_eq!(eventarc.len(), 1);
    assert!(!eventarc[0].fires);
    assert_eq!(eventarc[0].reason, "tier is gold, it wants vip");
    let storage = console
        .match_triggers(&MatchInput::Storage {
            bucket: "uploads".to_owned(),
            events: vec![StorageEvent::Deleted],
        })
        .await;
    assert!(!storage[0].fires);
    let auth = console
        .match_triggers(&MatchInput::Auth {
            tenant: None,
            events: vec![AuthEvent::BeforeCreate],
        })
        .await;
    assert!(
        auth.iter()
            .any(|row| row.function_id == "us-central1-beforeCreate" && row.fires)
    );
    // Paused background triggers fire nothing, and say so.
    harness.runtime.set_background_enabled(false).await;
    let paused = console
        .match_triggers(&MatchInput::Pubsub {
            topic: "projects/demo-dispatch/topics/emails".to_owned(),
        })
        .await;
    let email = paused
        .iter()
        .find(|row| row.function_id == "us-central1-onEmail")
        .expect("a row");
    assert!(!email.fires);
    assert_eq!(email.reason, "background triggers are paused");
    let nightly = paused
        .iter()
        .find(|row| row.function_id == "us-central1-nightly")
        .expect("a row");
    assert_eq!(
        nightly.reason,
        "listens on firebase-schedule-nightly, not emails"
    );
    harness.stop().await;
}

#[tokio::test]
async fn channels_list_listeners_and_publishing_records_the_event() {
    let harness = offline().await;
    let console = harness.runtime.console();
    let view = console.eventarc().await;
    let names: Vec<&str> = view
        .channels
        .iter()
        .map(|channel| channel.name.as_str())
        .collect();
    assert!(
        names.contains(&"google") && names.contains(&CHANNEL),
        "{names:?}"
    );
    let firebase = view
        .channels
        .iter()
        .find(|channel| channel.name == CHANNEL)
        .expect("listed");
    assert_eq!(
        firebase.subscriptions[0].function_id.as_deref(),
        Some("us-central1-onGreeted")
    );
    assert_eq!(firebase.subscriptions[0].filters["tier"], "vip");
    let ids = console
        .publish(
            "google",
            vec![json!({"type": "nobody.listens", "id": "c-1", "source": "//console", "specversion": "1.0"})],
            EventarcOrigin::Console,
        )
        .await
        .expect("published");
    let event = harness.monitor.event(&ids[0]).expect("recorded");
    assert_eq!(event.summary.origin, EventarcOrigin::Console);
    assert!(event.summary.unheard);
    let again = console
        .replay_event(&ids[0], false)
        .await
        .expect("replayed");
    let replayed = harness.monitor.event(&again).expect("recorded");
    assert_eq!(replayed.summary.origin, EventarcOrigin::Replay);
    assert_eq!(replayed.replay_of.as_deref(), Some(ids[0].as_str()));
    assert_ne!(replayed.summary.event_id.as_deref(), Some("c-1"));
    let kept = console.replay_event(&ids[0], true).await.expect("replayed");
    assert_eq!(
        harness
            .monitor
            .event(&kept)
            .expect("recorded")
            .summary
            .event_id
            .as_deref(),
        Some("c-1")
    );
    assert!(matches!(
        console
            .publish("google", vec![json!({"id": "x"})], EventarcOrigin::Console)
            .await,
        Err(ConsoleError::Invalid(_))
    ));
    harness.stop().await;
}

const INDEX: &str = r#"
exports.api = (req, res) => {
  res.write("start ");
  setTimeout(() => res.end("auth=" + (req.headers.authorization || "none")), 150);
};
exports.slow = (req, res) => { setTimeout(() => res.send("done"), 600); };
"#;

const LIVE: &str = "specVersion: v1alpha1
endpoints:
  api:
    entryPoint: api
    platform: gcfv2
    httpsTrigger: {}
  slow:
    entryPoint: slow
    platform: gcfv2
    httpsTrigger: {}
";

#[tokio::test]
async fn calls_are_recorded_whoever_reads_them_and_replays_resend_every_header() {
    let harness = match Harness::start(INDEX, LIVE, LogDelivery::Attributed).await {
        Ok(harness) => harness,
        Err(reason) => {
            eprintln!("skipped: {reason}");
            return;
        }
    };
    let console = harness.runtime.console();
    let mut stream = console
        .dispatch(
            "us-central1-api",
            DispatchInput {
                target: DispatchTarget::Url {
                    method: "GET".to_owned(),
                    path_and_query: "/hello?x=1".to_owned(),
                },
                headers: vec![("authorization".to_owned(), "Bearer t0ken".to_owned())],
                body: Bytes::new(),
                origin: InvocationOrigin::Console,
                replay_of: None,
            },
        )
        .await
        .expect("dispatched");
    assert_eq!(stream.invocation.origin, InvocationOrigin::Console);
    let id = stream.invocation.id.clone();
    let mut body = Vec::new();
    let mut finished = None;
    while let Some(frame) = stream.frames.recv().await {
        match frame {
            DispatchFrame::Head { status, headers } => {
                assert_eq!(status, 200);
                assert!(
                    headers
                        .iter()
                        .all(|header| !header.name.starts_with("x-firenook-"))
                );
            }
            DispatchFrame::Chunk(bytes) => body.extend_from_slice(&bytes),
            DispatchFrame::Finished(summary) => finished = Some(summary),
        }
    }
    assert_eq!(String::from_utf8_lossy(&body), "start auth=Bearer t0ken");
    let finished = finished.expect("a final summary");
    assert_eq!(finished.outcome, Some(InvocationOutcome::Succeeded));
    // The replay re-sends the stored authorization header, read in the engine.
    let mut replay = console.replay(&id).await.expect("replayed");
    assert_eq!(replay.invocation.origin, InvocationOrigin::Replay);
    assert_eq!(replay.invocation.replay_of.as_deref(), Some(id.as_str()));
    let mut replayed = Vec::new();
    while let Some(frame) = replay.frames.recv().await {
        if let DispatchFrame::Chunk(bytes) = frame {
            replayed.extend_from_slice(&bytes);
        }
    }
    assert_eq!(
        String::from_utf8_lossy(&replayed),
        "start auth=Bearer t0ken"
    );
    // A stream nobody reads is still drained and recorded.
    let dropped = console
        .dispatch(
            "us-central1-api",
            DispatchInput {
                target: DispatchTarget::Url {
                    method: "GET".to_owned(),
                    path_and_query: String::new(),
                },
                headers: Vec::new(),
                body: Bytes::new(),
                origin: InvocationOrigin::Console,
                replay_of: None,
            },
        )
        .await
        .expect("dispatched");
    let dropped_id = dropped.invocation.id.clone();
    drop(dropped);
    eventually("the drained call", || {
        harness
            .monitor
            .invocation(&dropped_id)
            .is_some_and(|detail| detail.summary.outcome == Some(InvocationOutcome::Succeeded))
    })
    .await;
    // A restart interrupts what runs and says how many.
    let slow = console
        .dispatch(
            "us-central1-slow",
            DispatchInput {
                target: DispatchTarget::Url {
                    method: "GET".to_owned(),
                    path_and_query: String::new(),
                },
                headers: Vec::new(),
                body: Bytes::new(),
                origin: InvocationOrigin::Console,
                replay_of: None,
            },
        )
        .await
        .expect("dispatched");
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(
        console.restart_worker("default").await.expect("restarted"),
        1
    );
    eventually("the interrupted call", || {
        harness
            .monitor
            .invocation(&slow.invocation.id)
            .is_some_and(|detail| detail.summary.outcome.is_some())
    })
    .await;
    let interrupted = harness
        .monitor
        .invocation(&slow.invocation.id)
        .expect("kept");
    assert_eq!(
        interrupted.summary.outcome,
        Some(InvocationOutcome::Crashed)
    );
    assert_eq!(
        interrupted.summary.error.as_deref(),
        Some("the worker was restarted")
    );
    assert!(matches!(
        console
            .dispatch(
                "us-central1-missing",
                DispatchInput {
                    target: DispatchTarget::Trigger,
                    headers: Vec::new(),
                    body: Bytes::new(),
                    origin: InvocationOrigin::Console,
                    replay_of: None,
                }
            )
            .await,
        Err(ConsoleError::NotFound(_))
    ));
    let _ = PROJECT;
    harness.stop().await;
}
