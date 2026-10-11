//! The one change path over HTTP: events in commit order, kinds and actors
//! on the activity ring, what became of each trigger event, and where rules
//! and flush errors are logged.

use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex};

use axum::body::Body;
use axum::http::{Method, Request, StatusCode, header};
use firenook_functions_bridge::{TriggerObserver, TriggerRegistry};
use tokio::sync::broadcast::error::TryRecvError;
use tower::ServiceExt as _;

use super::*;

const PROJECT: &str = "demo-storage-changes";
const BUCKET: &str = "demo-storage-changes.appspot.com";

fn root(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "firenook-changes-{label}-{}-{}",
        std::process::id(),
        OffsetDateTime::now_utc().unix_timestamp_nanos()
    ))
}

struct Harness {
    runtime: StorageRuntime,
    registry: TriggerRegistry,
    dispatches: Option<tokio::sync::mpsc::UnboundedReceiver<DispatchRequest>>,
    root: PathBuf,
}

async fn start(label: &str, options: StorageOptions, rules: Option<NativeRulesConfig>) -> Harness {
    start_durable(label, options, rules, StorageDurability::PerCommit).await
}

async fn start_durable(
    label: &str,
    options: StorageOptions,
    rules: Option<NativeRulesConfig>,
    durability: StorageDurability,
) -> Harness {
    let root = root(label);
    let registry = TriggerRegistry::default();
    let (observer, dispatches) = TriggerObserver::channel(registry.clone());
    let runtime = StorageRuntime::start_with(
        StorageConfig {
            project: PROJECT.to_owned(),
            origin: "http://127.0.0.1:21002".to_owned(),
            data_dir: root.clone(),
            rules,
            durability,
        },
        options,
        observer.queue(),
        registry.clone(),
    )
    .await
    .expect("Storage runtime");
    Harness {
        runtime,
        registry,
        dispatches: Some(dispatches),
        root,
    }
}

impl Harness {
    async fn finish(self) {
        let Self { runtime, root, .. } = self;
        runtime.shutdown().await.expect("shutdown");
        std::fs::remove_dir_all(root).expect("remove test storage");
    }

    async fn send(
        &self,
        method: Method,
        uri: &str,
        headers: &[(&str, &str)],
        body: Body,
    ) -> Response {
        let mut request = Request::builder().method(method).uri(uri);
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        self.runtime
            .application()
            .oneshot(request.body(body).expect("request"))
            .await
            .expect("response")
    }

    async fn upload(&self, name: &str, headers: &[(&str, &str)]) -> Response {
        self.send(
            Method::POST,
            &format!("/v0/b/{BUCKET}/o?name={}", percent_encode(name)),
            headers,
            Body::from(format!("bytes of {name}")),
        )
        .await
    }

    fn drain_dispatches(&mut self) -> usize {
        let receiver = self.dispatches.as_mut().expect("dispatch receiver");
        let mut count = 0;
        while receiver.try_recv().is_ok() {
            count += 1;
        }
        count
    }
}

const OWNER: (&str, &str) = ("authorization", "Bearer owner");

fn user_token(uid: &str, tenant: Option<&str>) -> String {
    let mut claims = json!({ "user_id": uid, "sub": uid });
    if let Some(tenant) = tenant {
        claims["firebase"] = json!({ "tenant": tenant });
    }
    format!(
        "Bearer {}.{}.",
        URL_SAFE_NO_PAD.encode(br#"{"alg":"none"}"#),
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).expect("claims"))
    )
}

fn committed(event: &ChangeEvent) -> (u64, Vec<(String, ObjectChangeKind)>, usize) {
    match event {
        ChangeEvent::Committed {
            revision,
            touches,
            sessions,
            ..
        } => (
            *revision,
            touches
                .iter()
                .map(|(name, kind)| (name.to_string(), *kind))
                .collect(),
            sessions.len(),
        ),
        other => panic!("expected a committed change, got {other:?}"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn events_in_commit_order() {
    let harness = start("order", StorageOptions::default(), None).await;
    // No subscriber yet: writes cost nothing and are not replayed later.
    assert_eq!(
        harness.upload("before.txt", &[OWNER]).await.status(),
        StatusCode::OK
    );
    let console = harness.runtime.console();
    let start = console.revision();
    let mut events = console.subscribe();

    let writers = (0..4)
        .map(|writer| {
            let router = harness.runtime.application();
            tokio::spawn(async move {
                for file in 0..25 {
                    let response = router
                        .clone()
                        .oneshot(
                            Request::builder()
                                .method(Method::POST)
                                .uri(format!(
                                    "/upload/storage/v1/b/{BUCKET}/o?uploadType=media&name=w{writer}%2Ff{file}"
                                ))
                                .header(header::AUTHORIZATION, "Bearer owner")
                                .body(Body::from(vec![1_u8; 16]))
                                .expect("request"),
                        )
                        .await
                        .expect("response");
                    assert_eq!(response.status(), StatusCode::OK);
                }
            })
        })
        .collect::<Vec<_>>();
    for writer in writers {
        writer.await.expect("writer");
    }
    let mut seen = Vec::new();
    loop {
        match events.try_recv() {
            Ok(event) => seen.push(committed(&event)),
            Err(TryRecvError::Empty) => break,
            Err(error) => panic!("{error}"),
        }
    }
    assert_eq!(seen.len(), 100, "one event per write");
    for (offset, (revision, touches, sessions)) in seen.iter().enumerate() {
        assert_eq!(
            *revision,
            start + 1 + offset as u64,
            "gapless, in commit order"
        );
        assert_eq!(touches.len(), 1);
        assert_eq!(touches[0].1, ObjectChangeKind::Created);
        assert_eq!(*sessions, 0);
    }
    let mut names = seen
        .iter()
        .map(|(_, touches, _)| touches[0].0.clone())
        .collect::<Vec<_>>();
    names.sort();
    names.dedup();
    assert_eq!(names.len(), 100);

    // A resumable session announces its id, and its finish the object.
    let start = harness
        .send(
            Method::POST,
            &format!("/upload/storage/v1/b/{BUCKET}/o?uploadType=resumable&name=resumed.bin"),
            &[OWNER],
            Body::empty(),
        )
        .await;
    assert_eq!(start.status(), StatusCode::OK);
    let (_, touches, sessions) = committed(&events.try_recv().expect("session event"));
    assert_eq!(touches.len(), 0, "{touches:?}");
    assert_eq!(sessions, 1);

    // A reset is one event, and the revision keeps moving forwards.
    let before_reset = console.revision();
    let reset = harness
        .send(Method::POST, "/internal/reset", &[], Body::empty())
        .await;
    assert_eq!(reset.status(), StatusCode::OK);
    assert_eq!(events.try_recv().expect("reset"), ChangeEvent::Reset);
    assert!(console.revision() > before_reset);
    assert_eq!(harness.runtime.object_count(), 0);
    harness.finish().await;
}

#[tokio::test]
async fn kinds_and_actors() {
    let harness = start("kinds", StorageOptions::default(), None).await;
    let ada = user_token("u_ada", None);
    let tenant_user = user_token("u_t", Some("tenant-a"));
    let console_header = ("x-firenook-console", "1");
    assert_eq!(
        harness
            .upload("a.txt", &[OWNER, console_header])
            .await
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        harness
            .upload("a.txt", &[("authorization", ada.as_str())])
            .await
            .status(),
        StatusCode::OK
    );
    let patch = harness
        .send(
            Method::PATCH,
            &format!("/v0/b/{BUCKET}/o/a.txt"),
            &[
                ("authorization", tenant_user.as_str()),
                ("content-type", "application/json"),
            ],
            Body::from(r#"{"cacheControl":"no-store","metadata":{"source":"camera"}}"#),
        )
        .await;
    assert_eq!(patch.status(), StatusCode::OK);
    let token = harness
        .send(
            Method::POST,
            &format!("/v0/b/{BUCKET}/o/a.txt?create_token=true"),
            &[OWNER],
            Body::empty(),
        )
        .await;
    assert_eq!(token.status(), StatusCode::OK);
    let delete = harness
        .send(
            Method::DELETE,
            &format!("/v0/b/{BUCKET}/o/a.txt"),
            &[],
            Body::empty(),
        )
        .await;
    assert_eq!(delete.status(), StatusCode::NO_CONTENT);

    let (records, since) = harness.runtime.console().activity(BUCKET, "a.txt");
    assert!(since.is_some());
    let summary = records
        .iter()
        .rev()
        .map(|record| (record.kind, record.actor.clone(), record.via_console))
        .collect::<Vec<_>>();
    assert_eq!(
        summary,
        [
            (ObjectChangeKind::Created, Actor::Admin, true),
            (
                ObjectChangeKind::Replaced,
                Actor::User {
                    uid: "u_ada".to_owned(),
                    tenant: None
                },
                false
            ),
            (
                ObjectChangeKind::Metadata,
                Actor::User {
                    uid: "u_t".to_owned(),
                    tenant: Some("tenant-a".to_owned())
                },
                false
            ),
            (ObjectChangeKind::Tokens, Actor::Admin, false),
            (ObjectChangeKind::Deleted, Actor::Anonymous, false),
        ]
    );
    assert_eq!(records[2].metadata_keys, ["cacheControl", "source"]);
    assert!(
        records
            .windows(2)
            .all(|pair| pair[0].revision > pair[1].revision)
    );
    harness.finish().await;
}

#[tokio::test]
async fn delivery_is_reported() {
    // Functions is not in the suite: nothing is queued at all.
    let mut harness = start(
        "no-functions",
        StorageOptions {
            functions: false,
            ..StorageOptions::default()
        },
        None,
    )
    .await;
    assert_eq!(
        harness.upload("a.txt", &[OWNER]).await.status(),
        StatusCode::OK
    );
    assert_eq!(harness.drain_dispatches(), 0);
    let (records, _) = harness.runtime.console().activity(BUCKET, "a.txt");
    assert_eq!(records[0].delivery, EventDelivery::NoFunctions);
    assert!(!harness.runtime.console().functions());
    harness.finish().await;

    let mut harness = start("functions", StorageOptions::default(), None).await;
    assert_eq!(
        harness.upload("sent.txt", &[OWNER]).await.status(),
        StatusCode::OK
    );
    assert_eq!(harness.drain_dispatches(), 2, "the v1 and the v2 request");
    let (records, _) = harness.runtime.console().activity(BUCKET, "sent.txt");
    assert_eq!(records[0].delivery, EventDelivery::Sent);

    harness.registry.set_background_enabled(false);
    assert_eq!(
        harness.upload("paused.txt", &[OWNER]).await.status(),
        StatusCode::OK
    );
    assert_eq!(harness.drain_dispatches(), 0);
    let (records, _) = harness.runtime.console().activity(BUCKET, "paused.txt");
    assert_eq!(records[0].delivery, EventDelivery::Paused);

    harness.registry.set_background_enabled(true);
    drop(harness.dispatches.take());
    assert_eq!(
        harness.upload("failed.txt", &[OWNER]).await.status(),
        StatusCode::OK
    );
    let (records, _) = harness.runtime.console().activity(BUCKET, "failed.txt");
    assert_eq!(records[0].delivery, EventDelivery::Failed);
    harness.finish().await;
}

#[tokio::test]
async fn imports_are_recorded_as_the_system_and_send_nothing() {
    let mut source = start("import-source", StorageOptions::default(), None).await;
    assert_eq!(
        source.upload("seeded.txt", &[OWNER]).await.status(),
        StatusCode::OK
    );
    source.drain_dispatches();
    let export = source.root.join("export");
    source.runtime.export(&export).await.expect("export");

    let mut harness = start("import", StorageOptions::default(), None).await;
    let mut events = harness.runtime.console().subscribe();
    assert_eq!(harness.runtime.import(&export).await.expect("import"), 1);
    assert_eq!(harness.drain_dispatches(), 0);
    let (_, touches, _) = committed(&events.try_recv().expect("import event"));
    assert_eq!(
        touches,
        [("seeded.txt".to_owned(), ObjectChangeKind::Created)]
    );
    let (records, _) = harness.runtime.console().activity(BUCKET, "seeded.txt");
    assert_eq!(records[0].actor, Actor::System);
    assert_eq!(records[0].delivery, EventDelivery::NoEvent);
    harness.finish().await;
    source.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rules_and_flush_errors_reach_the_log_sink() {
    let rules = NativeRulesConfig {
        source: RulesSource::Single(RulesFile {
            name: "storage.rules".to_owned(),
            content: "rules_version = '2';\nservice firebase.storage {\n  match /b/{bucket}/o {\n    match /{path=**} {\n      allow read: if request.resource.size > 0;\n    }\n  }\n}\n".to_owned(),
        }),
        documents: Arc::new(NoFirestoreDocuments),
    };
    let harness = start_durable(
        "log-sink",
        StorageOptions::default(),
        Some(rules),
        StorageDurability::WriteBehind {
            interval: std::time::Duration::from_millis(20),
        },
    )
    .await;
    let lines = Arc::new(StdMutex::new(Vec::<StorageLogLine>::new()));
    let sink_lines = Arc::clone(&lines);
    harness.runtime.set_log_sink(Arc::new(move |line| {
        sink_lines.lock().expect("lines").push(line);
    }));

    let ada = user_token("u_ada", None);
    let denied = harness
        .send(
            Method::GET,
            &format!("/v0/b/{BUCKET}/o/missing.txt"),
            &[("authorization", ada.as_str())],
            Body::empty(),
        )
        .await;
    assert_eq!(denied.status(), StatusCode::FORBIDDEN);
    {
        let lines = lines.lock().expect("lines");
        assert_eq!(lines.len(), 1, "{lines:?}");
        assert_eq!(lines[0].kind, "storage.rules");
        assert_eq!(lines[0].level, StorageLogLevel::Warn);
        assert!(
            lines[0].message.starts_with(&format!(
                "get on gs://{BUCKET}/missing.txt failed in the rules: "
            )),
            "{}",
            lines[0].message
        );
    }

    // A directory where a synced object file should be makes the next
    // write-behind flush fail.
    harness
        .runtime
        .state
        .metadata
        .note_unsynced_file(harness.root.join("objects"));
    for _ in 0..200 {
        if lines.lock().expect("lines").len() > 1 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    {
        let lines = lines.lock().expect("lines");
        assert_eq!(lines.len(), 2, "{lines:?}");
        assert_eq!(lines[1].kind, "storage.flush");
        assert_eq!(lines[1].level, StorageLogLevel::Error);
        assert!(lines[1].message.starts_with("write-behind flush failed: "));
    }
    harness.finish().await;
}
