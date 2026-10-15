//! The Storage Console API over a real Storage runtime in a temporary
//! directory: routes, errors, jobs, topics, summary and clear, denial log
//! lines, filters and search.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode, header};
use firenook_functions_bridge::{TriggerObserver, TriggerRegistry};
use firenook_storage_front::{
    NativeRulesConfig, NoFirestoreDocuments, RulesFile, RulesSource, StorageConfig,
    StorageDurability, StorageOptions, StorageRuntime,
};
use firenook_suite_front::{ConsoleSink, LogInput, LoggingRuntime, RingBudget};
use serde_json::{Value, json};
use tower::ServiceExt as _;

use super::*;
use crate::foreign::ForeignProjects;
use crate::instance::Instance;
use crate::jobs::JobRegistry;
use crate::live::TopicEvent;
use crate::live::badges::BadgeBoard;
use crate::{ConsoleServices, console_router};

const PROJECT: &str = "demo-console-storage";
const BUCKET: &str = "demo-console-storage.appspot.com";

const RULES: &str = "rules_version = '2';\nservice firebase.storage {\n  match /b/{bucket}/o {\n    match /users/{uid}/{file=**} {\n      allow read, write: if request.auth != null && request.auth.uid == uid\n        && (request.resource == null || request.resource.size < 1024);\n    }\n    match /public/{file=**} {\n      allow read;\n    }\n  }\n}\n";

/// Every line the console's log receives.
#[derive(Default)]
struct Captured(Mutex<Vec<LogInput>>);

impl ConsoleSink for Captured {
    fn accept(&self, input: LogInput) {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(input);
    }
}

struct Harness {
    runtime: StorageRuntime,
    router: Router,
    root: PathBuf,
    logging: LoggingRuntime,
    lines: Arc<Captured>,
    jobs: JobRegistry,
}

/// A directory of its own: the clock has microseconds on some platforms,
/// so a counter tells apart two made in one tick.
fn temp(label: &str) -> PathBuf {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    std::env::temp_dir().join(format!(
        "firenook-console-storage-{label}-{}-{}-{}",
        std::process::id(),
        time::OffsetDateTime::now_utc().unix_timestamp_nanos(),
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ))
}

fn open(root: &std::path::Path, rules: Option<&str>, diagnostics: bool) -> StorageRuntime {
    let registry = TriggerRegistry::default();
    let (observer, _deliveries) = TriggerObserver::channel(registry.clone());
    StorageRuntime::open(
        StorageConfig {
            project: PROJECT.to_owned(),
            origin: "http://127.0.0.1:29199".to_owned(),
            data_dir: root.to_path_buf(),
            rules: rules.map(|source| NativeRulesConfig {
                source: RulesSource::Single(RulesFile {
                    name: "storage.rules".to_owned(),
                    content: source.to_owned(),
                }),
                documents: Arc::new(NoFirestoreDocuments),
            }),
            durability: StorageDurability::PerCommit,
        },
        StorageOptions {
            functions: false,
            diagnostics,
            ..StorageOptions::default()
        },
        observer.queue(),
        registry,
    )
    .expect("Storage runtime")
}

fn harness(label: &str, rules: Option<&str>) -> Harness {
    let root = temp(label);
    let runtime = open(&root, rules, true);
    let logging = LoggingRuntime::new();
    let lines = Arc::new(Captured::default());
    logging.set_console_sink(lines.clone());
    let jobs = JobRegistry::new();
    let router = console_router(ConsoleServices {
        storage: Some(StorageConsole::new(
            runtime.application(),
            runtime.console(),
            logging.clone(),
        )),
        jobs: jobs.clone(),
        ..crate::tests::directory_services()
    });
    Harness {
        runtime,
        router,
        root,
        logging,
        lines,
        jobs,
    }
}

/// A Storage console for the foundation's router tests: a real runtime in a
/// directory removed at once (the routes they call read nothing from disk),
/// behind `native`.
pub(crate) fn router_console(native: Router) -> StorageConsole {
    let root = temp("router");
    let runtime = open(&root, None, false);
    let console = StorageConsole::new(native, runtime.console(), LoggingRuntime::new());
    // The console handle keeps what it needs; the runtime's files go.
    drop(runtime);
    let _ = std::fs::remove_dir_all(root);
    console
}

impl Harness {
    async fn finish(self) {
        let Self { runtime, root, .. } = self;
        runtime.shutdown().await.expect("shutdown");
        let _ = std::fs::remove_dir_all(root);
    }

    async fn send(&self, request: Request<Body>) -> (StatusCode, axum::http::HeaderMap, Vec<u8>) {
        let response = self
            .router
            .clone()
            .oneshot(request)
            .await
            .expect("response");
        let status = response.status();
        let headers = response.headers().clone();
        let body = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body");
        (status, headers, body.to_vec())
    }

    async fn get(&self, uri: &str, authorization: Option<&str>) -> (StatusCode, Value) {
        let mut request = Request::get(format!("/api/v1/storage{uri}"));
        if let Some(authorization) = authorization {
            request = request.header(header::AUTHORIZATION, authorization);
        }
        let (status, _, body) = self
            .send(request.body(Body::empty()).expect("request"))
            .await;
        (status, serde_json::from_slice(&body).unwrap_or(Value::Null))
    }

    async fn json(
        &self,
        method: Method,
        uri: &str,
        body: &Value,
        authorization: Option<&str>,
    ) -> (StatusCode, Value) {
        let mut request = Request::builder()
            .method(method)
            .uri(format!("/api/v1/storage{uri}"))
            .header(header::CONTENT_TYPE, "application/json")
            .header("x-firenook-console", "1");
        if let Some(authorization) = authorization {
            request = request.header(header::AUTHORIZATION, authorization);
        }
        let (status, _, bytes) = self
            .send(request.body(Body::from(body.to_string())).expect("request"))
            .await;
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    async fn upload(
        &self,
        name: &str,
        bytes: &[u8],
        authorization: Option<&str>,
    ) -> (StatusCode, Value) {
        let mut request = Request::put(format!(
            "/api/v1/storage/object?bucket={BUCKET}&name={}",
            urlencode(name)
        ))
        .header(header::CONTENT_TYPE, "text/plain")
        .header("x-firenook-console", "1");
        request = request.header(
            header::AUTHORIZATION,
            authorization.unwrap_or("Bearer owner"),
        );
        let (status, _, body) = self
            .send(request.body(Body::from(bytes.to_vec())).expect("request"))
            .await;
        (status, serde_json::from_slice(&body).unwrap_or(Value::Null))
    }
}

fn urlencode(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            encoded.push(char::from(byte));
        } else {
            use std::fmt::Write as _;
            let _ = write!(encoded, "%{byte:02X}");
        }
    }
    encoded
}

fn token(uid: &str) -> String {
    use base64::Engine as _;
    let encode = |bytes: &[u8]| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
    format!(
        "Bearer {}.{}.",
        encode(br#"{"alg":"none"}"#),
        encode(&serde_json::to_vec(&json!({ "user_id": uid, "sub": uid })).expect("claims"))
    )
}

fn names(page: &Value) -> Vec<String> {
    page["items"]
        .as_array()
        .expect("items")
        .iter()
        .map(|item| {
            item.get("name")
                .or_else(|| item.get("prefix"))
                .and_then(Value::as_str)
                .expect("a key")
                .to_owned()
        })
        .collect()
}

#[test]
fn export_storage_bindings() {
    let out = crate::tests::GENERATED;
    export_bindings(&ts_rs::Config::new().with_out_dir(out));
    let directory = std::path::Path::new(out).join("storage");
    let mut count = 0;
    for entry in std::fs::read_dir(&directory).expect("storage bindings") {
        let path = entry.expect("entry").path();
        let name = path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .expect("name");
        assert!(name.starts_with("Storage"), "{name} starts with Storage");
        let text = std::fs::read_to_string(&path).expect("read");
        for comment in text.split("/**").skip(1) {
            let body = comment.split("*/").next().unwrap_or_default();
            assert!(!body.contains("*/"), "{name}: a comment closes early");
        }
        count += 1;
    }
    assert!(count >= 70, "every Storage type is written ({count})");
    let page = std::fs::read_to_string(directory.join("StorageListPage.ts")).expect("page");
    assert!(
        page.contains("nextCursor"),
        "the foundation's page is flattened: {page}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[allow(clippy::too_many_lines, reason = "one route family, told in order")]
async fn listing_pages_both_ways_with_totals_and_meta() {
    let harness = harness("list", None);
    for index in 0..7 {
        assert_eq!(
            harness
                .upload(&format!("docs/f{index}.txt"), b"x", None)
                .await
                .0,
            StatusCode::OK
        );
    }
    assert_eq!(
        harness.upload("docs/sub/a.txt", b"x", None).await.0,
        StatusCode::OK
    );
    let console = harness.runtime.console();
    assert!(
        console
            .folder_index_ready(Duration::from_secs(10))
            .await
            .expect("index")
    );
    let (status, first) = harness
        .get(
            &format!("/objects?bucket={BUCKET}&prefix=docs/&limit=3"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{first}");
    assert_eq!(names(&first), ["docs/sub/", "docs/f0.txt", "docs/f1.txt"]);
    assert_eq!(first["items"][0]["type"], "folder");
    assert_eq!(
        first["totals"],
        json!({ "folders": 1, "files": 7, "bytes": 7, "filtered": false })
    );
    assert_eq!(first["total"], json!({ "count": 8, "exact": true }));
    assert!(first["prevCursor"].is_null());
    assert!(first.get("scanned").is_none_or(Value::is_null));
    let next = first["nextCursor"].as_str().expect("next").to_owned();
    assert!(next.starts_with("v1."));
    let (_, second) = harness
        .get(
            &format!("/objects?bucket={BUCKET}&prefix=docs/&limit=3&cursor={next}"),
            None,
        )
        .await;
    assert_eq!(
        names(&second),
        ["docs/f2.txt", "docs/f3.txt", "docs/f4.txt"]
    );
    let before = second["prevCursor"].as_str().expect("prev").to_owned();
    let (_, back) = harness
        .get(
            &format!("/objects?bucket={BUCKET}&prefix=docs/&limit=3&before={before}"),
            None,
        )
        .await;
    assert_eq!(names(&back), names(&first));
    // Sorted views and filters are evaluated by the engine.
    let (_, sorted) = harness
        .get(
            &format!("/objects?bucket={BUCKET}&prefix=docs/&sort=name:desc&limit=2"),
            None,
        )
        .await;
    assert_eq!(
        names(&sorted),
        ["docs/sub/", "docs/f6.txt"],
        "folders first, then files"
    );
    // Refresh asks for the view as the folder is now; the answer is never stale.
    let (status, refreshed) = harness
        .get(
            &format!("/objects?bucket={BUCKET}&prefix=docs/&sort=name:desc&limit=2&fresh=true"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{refreshed}");
    assert_eq!(names(&refreshed), names(&sorted));
    assert_eq!(refreshed["stale"], false);
    let (_, filtered) = harness
        .get(&format!("/objects?bucket={BUCKET}&prefix=docs/&q=f3"), None)
        .await;
    assert_eq!(names(&filtered), ["docs/f3.txt"]);
    assert_eq!(filtered["totals"]["filtered"], true);
    let (status, refused) = harness
        .get(&format!("/objects?bucket={BUCKET}&q=foo:bar"), None)
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(
        refused["error"]["message"]
            .as_str()
            .expect("message")
            .contains("Unknown filter")
    );
    assert!(refused["span"].is_object(), "the filter's span");
    let (status, refused) = harness
        .get(&format!("/objects?bucket={BUCKET}&prefix=docs"), None)
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        refused["error"]["message"],
        "prefix must be empty or end with `/`."
    );
    let (_, meta) = harness.get("/objects/meta", None).await;
    assert_eq!(meta["sortable"], json!(["name", "size", "updated", "type"]));
    assert_eq!(meta["defaultSort"], "name:asc");
    assert!(
        meta["fields"]
            .as_array()
            .expect("fields")
            .iter()
            .any(|field| field["key"] == "meta")
    );
    harness.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pages_respect_page_bytes() {
    let harness = harness("bytes", None);
    {
        let long = "n".repeat(1_000);
        for index in 0..500 {
            let (status, _) = harness
                .upload(&format!("long/{index:03}{long}"), b"", None)
                .await;
            assert_eq!(status, StatusCode::OK);
        }
    }
    let (_, page) = harness
        .get(
            &format!("/objects?bucket={BUCKET}&prefix=long/&limit=500"),
            None,
        )
        .await;
    let items = page["items"].as_array().expect("items").len();
    assert!(items < 500, "the page stopped at the byte budget ({items})");
    assert!(page["nextCursor"].is_string());
    assert!(serde_json::to_vec(&page).expect("json").len() < 600 * 1024);
    harness.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn batch_reads_exists_and_folders() {
    let harness = harness("batch", None);
    for name in ["a/b.png", "a/d.png", "a/e/f.txt"] {
        harness.upload(name, b"x", None).await;
    }
    let (_, page) = harness
        .get(&format!("/objects?bucket={BUCKET}&prefix=a/&limit=2"), None)
        .await;
    let starts = json!([Value::Null, page["nextCursor"]]);
    harness.upload("a/c.png", b"x", None).await;
    let (status, batch) = harness
        .json(
            Method::POST,
            "/objects:batchGet",
            &json!({
                "bucket": BUCKET,
                "prefix": "a/",
                "keys": ["a/b.png", "a/c.png", "a/gone.png", "a/e/"],
                "pageStarts": starts,
            }),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{batch}");
    let items = batch["items"].as_array().expect("items");
    assert_eq!(items[0]["row"]["name"], "a/b.png");
    assert_eq!(items[1]["row"]["name"], "a/c.png");
    assert!(
        items[1]["page"].is_number(),
        "a created name falls in a loaded page"
    );
    assert!(items[2]["row"].is_null(), "gone");
    assert_eq!(items[3]["row"]["type"], "folder");
    let (_, exists) = harness
        .json(
            Method::POST,
            "/objects:exists",
            &json!({ "bucket": BUCKET, "names": ["a/b.png", "nope"] }),
            None,
        )
        .await;
    assert_eq!(exists["existing"], json!(["a/b.png"]));
    let (status, created) = harness
        .json(
            Method::POST,
            "/folders",
            &json!({ "bucket": BUCKET, "prefix": "drafts/" }),
            Some("Bearer owner"),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    assert_eq!(created["empty"], true);
    let (status, again) = harness
        .json(
            Method::POST,
            "/folders",
            &json!({ "bucket": BUCKET, "prefix": "drafts/" }),
            Some("Bearer owner"),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(again["error"]["code"], "already-exists");
    let (status, folder) = harness
        .get(&format!("/folder?bucket={BUCKET}&prefix=a/"), None)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(folder["objects"], 4);
    assert_eq!(folder["folders"], 1);
    let (_, buckets) = harness.get("/buckets", None).await;
    assert_eq!(buckets["defaultBucket"], BUCKET);
    assert_eq!(buckets["buckets"][0]["isDefault"], true);
    assert_eq!(buckets["indexReady"], true);
    let (_, profile) = harness
        .get(&format!("/folder/profile?bucket={BUCKET}&prefix=a/"), None)
        .await;
    assert_eq!(profile["objects"], 4);
    assert_eq!(profile["childFolders"], json!(["e"]));
    harness.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[allow(clippy::too_many_lines, reason = "one route family, told in order")]
async fn object_routes_and_their_errors() {
    let harness = harness("object", Some(RULES));
    let ada = token("ada");
    let (status, uploaded) = harness
        .upload("users/ada/a.txt", b"hello", Some(&ada))
        .await;
    assert_eq!(status, StatusCode::OK, "{uploaded}");
    assert_eq!(uploaded["tokensVisible"], false);
    assert!(uploaded["decision"].is_string());
    let (status, refused) = harness
        .upload("users/ada/big.bin", &[0_u8; 2048], Some(&ada))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(refused["error"]["code"], "permission-denied");
    assert_eq!(
        refused["error"]["message"],
        "Permission denied. No WRITE permission."
    );
    assert!(refused["decision"].is_string());
    assert_eq!(refused["line"], 5);
    assert_eq!(refused["noRuleset"], false);
    let steps = refused["evaluation"]["explanation"]
        .as_array()
        .expect("explained");
    assert!(
        steps.iter().any(|step| step["value"] == "2048"),
        "the size the rules saw"
    );
    assert_eq!(refused["request"]["method"], "create");
    // Admin reads everything, tokens included.
    let (_, detail) = harness
        .get(
            &format!("/object?bucket={BUCKET}&name=users/ada/a.txt"),
            Some("Bearer owner"),
        )
        .await;
    assert_eq!(detail["tokensVisible"], true);
    assert_eq!(
        detail["downloadTokens"].as_array().expect("tokens").len(),
        1
    );
    assert_eq!(detail["sniffed"]["mime"], "text/plain");
    // Metadata with a stale metageneration.
    let (status, patched) = harness
        .json(
            Method::POST,
            "/object/metadata",
            &json!({ "bucket": BUCKET, "name": "users/ada/a.txt", "metadata": { "cacheControl": "no-store" }, "ifMetagenerationMatch": "1" }),
            Some("Bearer owner"),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{patched}");
    assert_eq!(patched["metageneration"], "2");
    let (status, stale) = harness
        .json(
            Method::POST,
            "/object/metadata",
            &json!({ "bucket": BUCKET, "name": "users/ada/a.txt", "metadata": {}, "ifMetagenerationMatch": "1" }),
            Some("Bearer owner"),
        )
        .await;
    assert_eq!(status, StatusCode::PRECONDITION_FAILED);
    assert_eq!(stale["current"], "2");
    // Tokens are Admin's.
    let (status, client) = harness
        .json(
            Method::POST,
            "/object/token",
            &json!({ "bucket": BUCKET, "name": "users/ada/a.txt", "action": "create" }),
            Some(&ada),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(
        client["error"]["message"],
        "Only the Admin SDK can create or revoke download tokens."
    );
    let (status, minted) = harness
        .json(
            Method::POST,
            "/object/token",
            &json!({ "bucket": BUCKET, "name": "users/ada/a.txt", "action": "create" }),
            Some("Bearer owner"),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        minted["downloadTokens"].as_array().expect("tokens").len(),
        2
    );
    // No thumbnail for text; a body over its limit.
    let (status, unsupported) = harness
        .get(
            &format!("/object/thumbnail?bucket={BUCKET}&name=users/ada/a.txt&w=320"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::UNSUPPORTED_MEDIA_TYPE);
    assert_eq!(unsupported["error"]["code"], "unsupported-media-type");
    let huge = json!({ "bucket": BUCKET, "names": vec!["x".repeat(100); 1_000] });
    let (status, too_large) = harness
        .json(Method::POST, "/objects:exists", &huge, None)
        .await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE, "{too_large}");
    // Media through the console's origin.
    let (status, headers, bytes) = harness
        .send(
            Request::get(format!(
                "/api/v1/storage/object/media?bucket={BUCKET}&name=users%2Fada%2Fa.txt"
            ))
            .body(Body::empty())
            .expect("request"),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(bytes, b"hello");
    assert_eq!(headers["x-content-type-options"], "nosniff");
    // Activity and event bodies.
    let (_, activity) = harness
        .get(
            &format!("/object/activity?bucket={BUCKET}&name=users/ada/a.txt"),
            None,
        )
        .await;
    let kinds = activity["changes"]
        .as_array()
        .expect("changes")
        .iter()
        .map(|change| change["kind"].as_str().expect("kind").to_owned())
        .collect::<Vec<_>>();
    assert_eq!(kinds, ["tokens", "metadata", "created"]);
    assert_eq!(activity["changes"][2]["actor"]["uid"], "ada");
    assert_eq!(activity["changes"][2]["delivery"], "no-functions");
    assert_eq!(activity["diagnostics"], true);
    let (_, events) = harness
        .get(
            &format!("/object/events?bucket={BUCKET}&name=users/ada/a.txt"),
            None,
        )
        .await;
    assert_eq!(events["functions"], false);
    assert_eq!(
        events["finalize"]["v1"]["eventType"],
        "google.storage.object.finalize"
    );
    let (_, resent) = harness
        .json(
            Method::POST,
            "/object/resend",
            &json!({ "bucket": BUCKET, "name": "users/ada/a.txt", "event": "finalize" }),
            Some("Bearer owner"),
        )
        .await;
    assert_eq!(resent, json!({ "sent": false, "delivery": "no-functions" }));
    // Delete, then 404.
    let (status, _) = harness
        .json(
            Method::DELETE,
            "/object",
            &json!({ "bucket": BUCKET, "name": "users/ada/a.txt" }),
            Some(&ada),
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, missing) = harness
        .get(
            &format!("/object?bucket={BUCKET}&name=users/ada/a.txt"),
            Some("Bearer owner"),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(missing["error"]["code"], "not-found");
    let (status, unknown) = harness.get("/nothing-here", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(unknown["error"]["code"], "not-found");
    harness.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[allow(clippy::too_many_lines, reason = "one route family, told in order")]
async fn bulk_routes_are_console_jobs() {
    let harness = harness("jobs", Some(RULES));
    for name in ["users/ada/a.txt", "users/ada/b.txt", "users/bob/c.txt"] {
        harness.upload(name, b"x", None).await;
    }
    let target = json!({ "by": "keys", "keys": ["users/"] });
    let (status, preview) = harness
        .json(
            Method::POST,
            "/objects:delete",
            &json!({ "bucket": BUCKET, "target": target, "dryRun": true }),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    assert_eq!(preview["objects"], 3);
    assert_eq!(
        harness.runtime.object_count(),
        3,
        "a dry run changes nothing"
    );
    let ada = token("ada");
    let (status, job) = harness
        .json(
            Method::POST,
            "/objects:delete",
            &json!({ "bucket": BUCKET, "target": target }),
            Some(&ada),
        )
        .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{job}");
    assert_eq!(job["section"], "storage");
    assert_eq!(job["kind"], "storage.delete");
    let id = job["id"].as_str().expect("id").to_owned();
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    let finished = loop {
        let job = harness.jobs.get(&id).expect("kept");
        if job.state != crate::jobs::JobState::Running {
            break job;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the job never finished"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    assert_eq!(finished.done, 2);
    assert_eq!(finished.error_count, 1);
    let error = &finished.errors[0];
    assert_eq!(error.key, "users/bob/c.txt");
    let detail = error.detail.as_ref().expect("detail");
    assert!(detail["decision"].is_string());
    assert!(detail["evaluation"]["allows"].is_array());
    assert_eq!(detail["request"]["path"], "users/bob/c.txt");
    let (status, listed) = (StatusCode::OK, harness.jobs.list(Some("storage")));
    assert_eq!(status, StatusCode::OK);
    assert_eq!(listed.len(), 1);
    // A copy onto a taken name skips it.
    harness.upload("public/one.txt", b"1", None).await;
    harness.upload("archive/one.txt", b"2", None).await;
    let (_, job) = harness
        .json(
            Method::POST,
            "/objects:copy",
            &json!({ "bucket": BUCKET, "target": { "by": "keys", "keys": ["public/one.txt"] }, "destination": { "bucket": BUCKET, "prefix": "archive/" } }),
            Some("Bearer owner"),
        )
        .await;
    let id = job["id"].as_str().expect("id").to_owned();
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    let copied = loop {
        let job = harness.jobs.get(&id).expect("kept");
        if job.state != crate::jobs::JobState::Running {
            break job;
        }
        assert!(std::time::Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    assert_eq!(copied.skipped, 1);
    // Downloads: a folder link and a ticket.
    let (status, headers, bytes) = harness
        .send(
            Request::get(format!(
                "/api/v1/storage/objects:export?bucket={BUCKET}&prefix=public/"
            ))
            .body(Body::empty())
            .expect("request"),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers[header::CONTENT_TYPE], "application/zip");
    assert!(bytes.starts_with(b"PK"));
    let (status, ticket) = harness
        .json(
            Method::POST,
            "/objects:export",
            &json!({ "bucket": BUCKET, "target": { "by": "keys", "keys": ["public/one.txt", "archive/one.txt"] } }),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{ticket}");
    assert_eq!(ticket["objects"], 2);
    let url = ticket["url"].as_str().expect("url").replace("/console", "");
    let (status, _, bytes) = harness
        .send(Request::get(url).body(Body::empty()).expect("request"))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert!(bytes.starts_with(b"PK"));
    harness.finish().await;
}

/// The Storage section built straight, with the context topics need.
fn section_with(harness: &Harness) -> (StorageSection, SectionContext) {
    let section = StorageSection(StorageConsole::new(
        harness.runtime.application(),
        harness.runtime.console(),
        harness.logging.clone(),
    ));
    let context = SectionContext {
        project: Arc::from(PROJECT),
        shutdown: crate::tests::running(),
        badges: BadgeBoard::default(),
        instance: Instance::new(),
        jobs: JobRegistry::new(),
        rings: RingBudget::new(64 * 1024 * 1024),
        foreign: ForeignProjects::default(),
    };
    (section, context)
}

fn topic(section: &StorageSection, context: &SectionContext, name: &str) -> Arc<dyn LiveTopic> {
    section
        .topics(context)
        .into_iter()
        .find(|topic| topic.name() == name)
        .unwrap_or_else(|| panic!("{name} is published"))
}

/// The next event of `stream` within two seconds.
async fn next(stream: &mut crate::live::TopicStream) -> TopicEvent {
    tokio::time::timeout(Duration::from_secs(2), stream.next())
        .await
        .expect("an event in time")
        .expect("the stream goes on")
}

fn event(event: &TopicEvent) -> (&'static str, Option<String>, Value) {
    match event {
        TopicEvent::Event { name, cursor, data } => (
            name,
            cursor.as_ref().map(ToString::to_string),
            serde_json::from_str(data).expect("json"),
        ),
        other => panic!("not an event: {other:?}"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_objects_topic_replays_and_filters_by_bucket() {
    let harness = harness("objects-topic", None);
    let (section, context) = section_with(&harness);
    let objects = topic(&section, &context, "storage.objects");
    let mut stream = objects
        .open(&json!({ "bucket": BUCKET }), None)
        .expect("open");
    // A fresh subscriber gets a cursor first.
    let (name, cursor, _) = event(&next(&mut stream).await);
    assert_eq!(name, "tick");
    let start = cursor.expect("cursor");
    harness.upload("live/a.txt", b"x", None).await;
    let (name, cursor, data) = event(&next(&mut stream).await);
    assert_eq!(name, "changed");
    assert_eq!(
        data["changes"],
        json!([{ "name": "live/a.txt", "kind": "created" }])
    );
    let after_first = cursor.expect("cursor");
    drop(stream);
    // Written while away, and a write to another bucket: the replay brings
    // this bucket's only.
    harness.upload("live/b.txt", b"x", None).await;
    harness
        .runtime
        .console()
        .upload(
            firenook_storage_front::ConsoleUpload {
                bucket: "other-bucket".to_owned(),
                name: "elsewhere.txt".to_owned(),
                ..Default::default()
            },
            Body::from("x"),
            &firenook_storage_front::Identity::Admin,
        )
        .await
        .expect("other bucket");
    let mut resumed = objects
        .open(&json!({ "bucket": BUCKET }), Some(&after_first))
        .expect("resume");
    let (name, _, data) = event(&next(&mut resumed).await);
    assert_eq!(name, "changed");
    assert_eq!(
        data["changes"],
        json!([{ "name": "live/b.txt", "kind": "created" }])
    );
    // From the start: both, folded into one window.
    let mut replay = objects
        .open(&json!({ "bucket": BUCKET }), Some(&start))
        .expect("replay");
    let (_, _, data) = event(&next(&mut replay).await);
    assert_eq!(data["changes"].as_array().expect("changes").len(), 2);
    // A cursor from another engine run: reset.
    let mut foreign = objects
        .open(&json!({ "bucket": BUCKET }), Some("1.0"))
        .expect("foreign");
    assert!(matches!(next(&mut foreign).await, TopicEvent::Reset { .. }));
    // A clear names the whole bucket.
    let mut live = objects
        .open(&json!({ "bucket": BUCKET }), None)
        .expect("live");
    let _ = next(&mut live).await;
    harness
        .runtime
        .console()
        .clear_all(&NoProgress)
        .await
        .expect("clear");
    let (_, _, data) = event(&next(&mut live).await);
    assert_eq!(data["truncated"], true);
    assert_eq!(data["folders"], json!([""]));
    assert!(
        objects
            .open(&json!({ "bucket": BUCKET, "prefix": "x/" }), None)
            .is_err(),
        "unknown params are refused"
    );
    harness.finish().await;
}

struct NoProgress;

impl firenook_storage_front::BulkProgress for NoProgress {
    fn done(&self, _by: u64) {}
    fn skipped(&self, _by: u64) {}
    fn failed(&self, _name: &str, _message: &str, _refusal: Option<&ConsoleRefusal>) {}
    fn cancelled(&self) -> bool {
        false
    }
}

/// A bulk action's progress nobody watches.
struct Quiet;

impl firenook_storage_front::BulkProgress for Quiet {
    fn done(&self, _by: u64) {}
    fn skipped(&self, _by: u64) {}
    fn failed(&self, name: &str, message: &str, _refusal: Option<&ConsoleRefusal>) {
        panic!("{name}: {message}");
    }
    fn cancelled(&self) -> bool {
        false
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_busy_window_names_folders() {
    let harness = harness("window", None);
    let (section, context) = section_with(&harness);
    let objects = topic(&section, &context, "storage.objects");
    let console = harness.runtime.console();
    for index in 0..1_200 {
        console
            .upload(
                firenook_storage_front::ConsoleUpload {
                    bucket: BUCKET.to_owned(),
                    name: format!("burst/d{}/f{index}.txt", index % 2),
                    ..Default::default()
                },
                Body::from("x"),
                &firenook_storage_front::Identity::Admin,
            )
            .await
            .expect("upload");
    }
    let mut stream = objects
        .open(&json!({ "bucket": BUCKET }), None)
        .expect("open");
    let (_, cursor, _) = event(&next(&mut stream).await);
    drop(stream);
    // Six batches of 200 deletions: replayed together, one window of 1,200
    // names, which names its folders instead.
    console
        .bulk(
            firenook_storage_front::BulkRequest {
                verb: firenook_storage_front::BulkVerb::Delete,
                bucket: BUCKET.to_owned(),
                source: firenook_storage_front::BulkSource::Keys(vec!["burst/".to_owned()]),
                destination: None,
                rename_to: None,
                metadata: None,
                on_conflict: firenook_storage_front::ConflictPolicy::Skip,
                console: true,
            },
            firenook_storage_front::Identity::Admin,
            &Quiet,
        )
        .await
        .expect("delete");
    let mut replay = objects
        .open(&json!({ "bucket": BUCKET }), cursor.as_deref())
        .expect("replay");
    let (name, _, data) = event(&next(&mut replay).await);
    assert_eq!(name, "changed");
    assert_eq!(data["truncated"], true, "{data}");
    assert_eq!(data["changes"], json!([]));
    assert_eq!(data["folders"], json!(["burst/d0/", "burst/d1/"]));
    harness.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_rules_topic_compares_hashes_and_says_the_file() {
    let harness = harness("rules-topic", Some(RULES));
    let (section, context) = section_with(&harness);
    let rules_topic = topic(&section, &context, "storage.rules");
    let mut stream = rules_topic.open(&json!({}), None).expect("open");
    let (name, cursor, data) = event(&next(&mut stream).await);
    assert_eq!(name, "file", "the file's status on every open");
    assert_eq!(data["problems"], json!([]));
    let hash = cursor.expect("the hash in force");
    let rules = harness.runtime.console().rules().expect("rules");
    let changed = RULES.replace("allow read;", "allow read: if true;");
    rules
        .install(
            &firenook_storage_front::RulesScope::AllBuckets,
            &changed,
            firenook_storage_front::RulesOrigin::Console,
        )
        .expect("installed");
    let (name, cursor, data) = event(&next(&mut stream).await);
    assert_eq!(name, "rules");
    assert_eq!(data["origin"], "console");
    assert_ne!(cursor.as_deref(), Some(hash.as_str()));
    // Coming back with the old hash: told at once.
    let mut resumed = rules_topic.open(&json!({}), Some(&hash)).expect("resume");
    let (name, _, _) = event(&next(&mut resumed).await);
    assert_eq!(name, "rules");
    let (name, _, _) = event(&next(&mut resumed).await);
    assert_eq!(name, "file");
    harness.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn decisions_replay_filter_and_log_denials() {
    let harness = harness("decisions", Some(RULES));
    let (section, context) = section_with(&harness);
    let decisions = topic(&section, &context, "storage.decisions");
    let mut denied = decisions
        .open(&json!({ "bucket": BUCKET, "denied": true }), None)
        .expect("open");
    let _ = next(&mut denied).await;
    let ada = token("ada");
    harness.upload("users/ada/ok.txt", b"x", Some(&ada)).await;
    harness.upload("users/bob/no.txt", b"x", Some(&ada)).await;
    let (name, _, data) = event(&next(&mut denied).await);
    assert_eq!(name, "decisions");
    let items = data["items"].as_array().expect("items");
    assert!(
        items.iter().all(|item| item["outcome"] != "allow"),
        "{items:?}"
    );
    assert_eq!(items.last().expect("one")["path"], "users/bob/no.txt");
    assert!(data["window"]["retained"].as_u64().expect("retained") >= 2);
    // One exact name, which no other file's decisions pass.
    let mut exact = decisions
        .open(
            &json!({ "bucket": BUCKET, "path": "users/ada/ok.txt" }),
            None,
        )
        .expect("open");
    let (_, _, exact) = event(&next(&mut exact).await);
    assert_eq!(exact["items"].as_array().expect("items").len(), 1);
    assert_eq!(exact["items"][0]["method"], "create");
    assert!(
        decisions
            .open(&json!({ "bucket": BUCKET, "folder": "x" }), None)
            .is_err(),
        "unknown params are refused"
    );
    // The denial reached the console's log with its links.
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    let line = loop {
        let found = harness
            .lines
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .iter()
            .find(|line| line.kind == Some("storage.denied.console"))
            .cloned();
        if let Some(line) = found {
            break line;
        }
        assert!(std::time::Instant::now() < deadline, "no denial line");
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    assert_eq!(
        line.message,
        "Rules denied create on users/bob/no.txt for ada"
    );
    let kinds = line
        .refs
        .iter()
        .map(|entity| entity.kind.as_str())
        .collect::<Vec<_>>();
    assert_eq!(kinds, ["storage.object", "storage.decision", "auth.user"]);
    // A detail's request replays to the same verdict.
    let id = items.last().expect("one")["id"]
        .as_str()
        .expect("id")
        .to_owned();
    let (status, detail) = harness.get(&format!("/rules/decisions/{id}"), None).await;
    assert_eq!(status, StatusCode::OK, "{detail}");
    let (_, replayed) = harness
        .json(
            Method::POST,
            "/rules/evaluate",
            &json!({ "requests": [detail["request"]] }),
            None,
        )
        .await;
    assert_eq!(replayed["results"][0]["outcome"], detail["recordedOutcome"]);
    let (status, gone) = harness.get("/rules/decisions/s999999", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(
        gone["error"]["message"]
            .as_str()
            .expect("message")
            .contains("newest 2,000")
    );
    harness.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rules_routes_read_check_install_and_evaluate() {
    let harness = harness("rules-routes", Some(RULES));
    let (_, document) = harness.get("/rules", None).await;
    assert_eq!(document["mode"], "single");
    assert!(document["bucket"].is_null());
    assert_eq!(document["enforced"], true);
    assert_eq!(document["source"], RULES);
    let (status, check) = harness
        .json(
            Method::POST,
            "/rules/check",
            &json!({ "source": "rules_version = '2';\nservice firebase.storage {" }),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert!(check["outline"].is_null());
    assert_ne!(check["diagnostics"], json!([]));
    harness.upload("public/a.txt", b"x", None).await;
    assert!(
        harness
            .runtime
            .console()
            .folder_index_ready(Duration::from_secs(10))
            .await
            .expect("index")
    );
    let (_, check) = harness
        .json(
            Method::POST,
            "/rules/check",
            &json!({ "source": RULES }),
            None,
        )
        .await;
    assert!(check["outline"].is_object());
    assert_eq!(check["map"]["folders"][0]["pattern"], "public/");
    let (status, refused) = harness
        .json(
            Method::PUT,
            "/rules",
            &json!({ "source": "not rules" }),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(refused["diagnostics"].is_array());
    let (status, installed) = harness
        .json(
            Method::PUT,
            "/rules",
            &json!({ "source": RULES.replace("allow read;", "allow read: if true;") }),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{installed}");
    assert_eq!(installed["saved"], false);
    let (_, history) = harness.get("/rules/history", None).await;
    assert_eq!(history[0]["origin"], "console");
    let (_, evaluation) = harness
        .json(
            Method::POST,
            "/rules/evaluate",
            &json!({ "requests": [{ "method": "create", "bucket": BUCKET, "path": "users/ada/x.txt", "authorization": token("ada"), "proposed": { "size": 4096, "contentType": null } }] }),
            None,
        )
        .await;
    assert_eq!(evaluation["results"][0]["outcome"], "deny");
    let (_, access) = harness
        .json(
            Method::POST,
            "/rules/access",
            &json!({ "bucket": BUCKET, "names": ["public/a.txt"], "methods": ["get", "delete"] }),
            None,
        )
        .await;
    let verdicts = access["results"][0]["verdicts"]
        .as_array()
        .expect("verdicts");
    assert_eq!(verdicts[0]["outcome"], "allow");
    assert_eq!(verdicts[1]["outcome"], "deny");
    let (status, report) = harness.get("/rules/coverage", None).await;
    assert_eq!(status, StatusCode::OK, "{report}");
    assert_eq!(report["rules"]["files"][0]["name"], "storage.rules");
    harness.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn summary_and_suite_clear() {
    let harness = harness("clear", None);
    for index in 0..3 {
        harness.upload(&format!("c/{index}.txt"), b"xy", None).await;
    }
    let (section, _) = section_with(&harness);
    assert!(
        harness
            .runtime
            .console()
            .folder_index_ready(Duration::from_secs(10))
            .await
            .expect("index")
    );
    let summary = section.summary("storage").expect("summary");
    assert_eq!(summary.headline, "3 objects · 6 B in 1 bucket");
    assert_eq!(summary.figures[0].value, Some(3));
    let (status, _, job) = harness
        .send(
            Request::post("/api/v1/suite/clear")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(json!({ "sections": ["storage"] }).to_string()))
                .expect("request"),
        )
        .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    let job: Value = serde_json::from_slice(&job).expect("job");
    let id = job["id"].as_str().expect("id").to_owned();
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    let done = loop {
        let job = harness.jobs.get(&id).expect("kept");
        if job.state != crate::jobs::JobState::Running {
            break job;
        }
        assert!(std::time::Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    assert_eq!(done.state, crate::jobs::JobState::Done);
    assert_eq!(
        done.result.expect("reports")[0],
        json!({ "section": "storage", "removed": 3 })
    );
    assert_eq!(harness.runtime.object_count(), 0);
    harness.finish().await;
}

#[test]
fn storage_filter_golden_cases() {
    let cases = include_str!("../../../../console/src/storage/filter-cases.json");
    let ran = crate::filter::golden::run(cases);
    assert!(ran >= 10, "{ran} cases");
    let file: Value = serde_json::from_str(cases).expect("json");
    let fields = serde_json::to_value(filter_fields::STORAGE_FILTER_FIELDS.infos()).expect("infos");
    let declared = file["fields"].as_array().expect("fields");
    for (declared, served) in declared.iter().zip(fields.as_array().expect("served")) {
        assert_eq!(declared["key"], served["key"]);
        assert_eq!(declared["kind"], served["kind"], "{}", served["key"]);
    }
    assert_eq!(
        declared.len(),
        fields.as_array().expect("served").len(),
        "the file declares Storage's fields"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn search_source_respects_the_budget() {
    let harness = harness("search", None);
    harness.upload("users/ada/avatar.png", b"x", None).await;
    harness.upload("avatar.png", b"x", None).await;
    let source = search::StorageSearch(harness.runtime.console());
    let cancel = std::sync::atomic::AtomicBool::new(false);
    let found = crate::search::SearchSource::search(&source, "avatar.png", 5, &cancel);
    assert_eq!(found.hits[0].kind, "storage.object");
    assert_eq!(found.hits[0].key, format!("{BUCKET}|avatar.png"));
    assert!(
        found.hits[0]
            .detail
            .as_deref()
            .expect("detail")
            .ends_with(&format!("gs://{BUCKET}"))
    );
    cancel.store(true, std::sync::atomic::Ordering::SeqCst);
    let stopped = crate::search::SearchSource::search(&source, "users", 5, &cancel);
    assert!(stopped.partial);
    harness.finish().await;
}

#[test]
fn activity_names_the_invocations_an_event_started() {
    use axum::body::Bytes;
    use axum::http::{HeaderMap, HeaderValue};
    use firenook_functions_runtime::MonitorLimits;
    use firenook_functions_runtime::monitor::{
        FunctionKind, InvocationCause, InvocationOrigin, InvocationStart, InvocationTarget,
    };
    use firenook_storage_front::{Actor, EventDelivery, ObjectChangeKind, ObjectChangeRecord};

    let monitor = Monitor::new(MonitorLimits::default());
    let begin = |function: &str, event: &str, replay_of: Option<String>| {
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-firenook-event-id",
            HeaderValue::from_str(event).expect("header"),
        );
        monitor
            .begin(InvocationStart {
                function_id: function.to_owned(),
                codebase: "default".to_owned(),
                kind: FunctionKind::Storage,
                origin: InvocationOrigin::Emulator,
                cause: InvocationCause::Storage {
                    event_type: "google.storage.object.finalize".to_owned(),
                    bucket: BUCKET.to_owned(),
                    object: "a.png".to_owned(),
                    event_id: Some(event.to_owned()),
                },
                summary: "a.png finalized".to_owned(),
                target: InvocationTarget::Trigger,
                method: "POST".to_owned(),
                path: "/".to_owned(),
                headers,
                body: Bytes::new(),
                replay_of,
                delivery: None,
            })
            .id
            .to_string()
    };
    // The v1 id reached two v1 functions, the v2 id one v2 function; the
    // first v1 function was retried, and the developer replayed one.
    let first = begin("us-central1-thumbs", "111", None);
    let other = begin("us-central1-audit", "111", None);
    let retried = begin("us-central1-thumbs", "111", None);
    let v2 = begin("us-central1-indexer", "c-2", None);
    begin("us-central1-thumbs", "111", Some(first.clone()));
    // Another file's event.
    begin("us-central1-thumbs", "999", None);

    let record = |revision: u64, event_ids: &[&str]| ObjectChangeRecord {
        revision,
        at: time::OffsetDateTime::now_utc(),
        bucket: BUCKET.to_owned(),
        name: "a.png".to_owned(),
        kind: ObjectChangeKind::Created,
        size: 1,
        content_type: None,
        metadata_keys: Vec::new(),
        actor: Actor::Admin,
        via_console: false,
        delivery: EventDelivery::Sent,
        event_ids: event_ids.iter().map(|id| (*id).to_owned()).collect(),
    };
    let changes = [record(2, &["111", "c-2"]), record(1, &[])];
    let started = files::started_by(Some(&monitor), &changes);
    let named = started
        .iter()
        .map(|(event, invocation)| {
            (
                event.as_str(),
                invocation.key.as_str(),
                invocation.label.as_deref(),
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(
        named,
        [
            ("111", other.as_str(), Some("us-central1-audit")),
            ("111", retried.as_str(), Some("us-central1-thumbs")),
            ("c-2", v2.as_str(), Some("us-central1-indexer")),
        ]
    );
    assert!(
        started
            .iter()
            .all(|(_, invocation)| invocation.kind == "functions.invocation")
    );
    // Without Functions, or with no sent event, nothing is read.
    assert_eq!(files::started_by(None, &changes), Vec::new());
    assert_eq!(files::started_by(Some(&monitor), &changes[1..]), Vec::new());
}
