//! Staged uploads over HTTP: what an aborted body, a failed resumable chunk
//! and a crash leave behind, and what the in-flight gauge says meanwhile.

use std::path::PathBuf;

use axum::body::{Body, Bytes, to_bytes};
use axum::http::{Method, Request, StatusCode, header};
use firenook_functions_bridge::{TriggerObserver, TriggerRegistry};
use tower::ServiceExt as _;

use super::*;

const PROJECT: &str = "demo-storage-staging";
const BUCKET: &str = "demo-storage-staging.appspot.com";

fn root(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "firenook-staging-{label}-{}-{}",
        std::process::id(),
        OffsetDateTime::now_utc().unix_timestamp_nanos()
    ))
}

async fn start(root: &FilePath) -> StorageRuntime {
    let registry = TriggerRegistry::default();
    let (observer, _receiver) = TriggerObserver::channel(registry.clone());
    StorageRuntime::start(
        StorageConfig {
            project: PROJECT.to_owned(),
            origin: "http://127.0.0.1:21002".to_owned(),
            data_dir: root.to_path_buf(),
            rules: None,
            durability: StorageDurability::PerCommit,
        },
        observer.queue(),
        registry,
    )
    .await
    .expect("Storage runtime")
}

fn staged_files(root: &FilePath) -> Vec<PathBuf> {
    let mut files = std::fs::read_dir(root.join("uploads"))
        .expect("uploads directory")
        .map(|entry| entry.expect("entry").path())
        .collect::<Vec<_>>();
    files.sort();
    files
}

/// A body that delivers `bytes` and then fails, as a connection the client
/// dropped mid-upload does.
fn aborted_body(bytes: usize) -> Body {
    Body::from_stream(futures_util::stream::iter(vec![
        Ok::<_, std::io::Error>(Bytes::from(vec![7_u8; bytes])),
        Err(std::io::Error::other("client went away")),
    ]))
}

async fn send(runtime: &StorageRuntime, method: Method, uri: &str, body: Body) -> Response {
    runtime
        .application()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(uri)
                .header(header::AUTHORIZATION, "Bearer owner")
                .body(body)
                .expect("request"),
        )
        .await
        .expect("response")
}

#[tokio::test]
async fn aborted_body_leaves_nothing() {
    let root = root("aborted");
    let runtime = start(&root).await;
    for uri in [
        format!("/upload/storage/v1/b/{BUCKET}/o?uploadType=media&name=big.bin"),
        format!("/v0/b/{BUCKET}/o?name=big.bin"),
    ] {
        let response = send(&runtime, Method::POST, &uri, aborted_body(1 << 20)).await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{uri}");
        assert_eq!(staged_files(&root), Vec::<PathBuf>::new(), "{uri}");
        assert_eq!(runtime.console().in_flight(BUCKET), InFlight::default());
    }
    assert_eq!(runtime.object_count(), 0);
    runtime.shutdown().await.expect("shutdown");
    std::fs::remove_dir_all(root).expect("remove test storage");
}

#[tokio::test]
async fn the_gauge_counts_bytes_while_they_arrive() {
    let root = root("gauge");
    let runtime = start(&root).await;
    let (sender, receiver) = tokio::sync::mpsc::channel::<Result<Bytes, std::io::Error>>(1);
    let body = Body::from_stream(tokio_stream_from(receiver));
    let router = runtime.application();
    let upload = tokio::spawn(async move {
        router
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri(format!(
                        "/upload/storage/v1/b/{BUCKET}/o?uploadType=media&name=slow.bin"
                    ))
                    .header(header::AUTHORIZATION, "Bearer owner")
                    .body(body)
                    .expect("request"),
            )
            .await
            .expect("response")
    });
    sender
        .send(Ok(Bytes::from(vec![1_u8; 300_000])))
        .await
        .expect("first chunk");
    let mut seen = InFlight::default();
    for _ in 0..200 {
        seen = runtime.console().in_flight(BUCKET);
        if seen.bytes == 300_000 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert_eq!(
        seen,
        InFlight {
            uploads: 1,
            bytes: 300_000
        }
    );
    sender
        .send(Ok(Bytes::from(vec![2_u8; 200_000])))
        .await
        .expect("second chunk");
    drop(sender);
    let response = upload.await.expect("upload task");
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(runtime.console().in_flight(BUCKET), InFlight::default());
    assert_eq!(runtime.object_bytes(), 500_000);
    assert_eq!(staged_files(&root), Vec::<PathBuf>::new());
    runtime.shutdown().await.expect("shutdown");
    std::fs::remove_dir_all(root).expect("remove test storage");
}

fn tokio_stream_from(
    mut receiver: tokio::sync::mpsc::Receiver<Result<Bytes, std::io::Error>>,
) -> impl futures_util::Stream<Item = Result<Bytes, std::io::Error>> {
    futures_util::stream::poll_fn(move |context| receiver.poll_recv(context))
}

async fn start_resumable(runtime: &StorageRuntime, name: &str) -> (String, String) {
    let response = send(
        runtime,
        Method::POST,
        &format!("/upload/storage/v1/b/{BUCKET}/o?uploadType=resumable&name={name}"),
        Body::empty(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let location = response
        .headers()
        .get(header::LOCATION)
        .and_then(|value| value.to_str().ok())
        .expect("location")
        .replace("http://127.0.0.1:21002", "");
    let id = query_fields(location.split_once('?').map(|(_, query)| query))
        .remove("upload_id")
        .expect("upload id");
    (location, id)
}

#[tokio::test]
async fn failed_chunk_truncates_the_session_file() {
    let root = root("chunk");
    let runtime = start(&root).await;
    let (location, id) = start_resumable(&runtime, "resumed.bin").await;
    let session_file = root.join(format!("uploads/{id}.part"));
    assert_eq!(
        std::fs::metadata(&session_file)
            .expect("session file")
            .len(),
        0
    );
    assert_eq!(
        runtime.console().in_flight(BUCKET),
        InFlight {
            uploads: 1,
            bytes: 0
        }
    );

    let failed = runtime
        .application()
        .oneshot(
            Request::builder()
                .method(Method::PUT)
                .uri(&location)
                .header(header::CONTENT_RANGE, "bytes 0-1999999/2000000")
                .body(aborted_body(1 << 20))
                .expect("chunk"),
        )
        .await
        .expect("chunk response");
    assert_eq!(failed.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        std::fs::metadata(&session_file)
            .expect("the session keeps its file")
            .len(),
        0,
        "the failed chunk is cut off again"
    );
    assert_eq!(runtime.console().in_flight(BUCKET).bytes, 0);

    let bytes = vec![9_u8; 2_000_000];
    let retried = runtime
        .application()
        .oneshot(
            Request::builder()
                .method(Method::PUT)
                .uri(&location)
                .header(header::CONTENT_RANGE, "bytes 0-1999999/2000000")
                .body(Body::from(bytes.clone()))
                .expect("retry"),
        )
        .await
        .expect("retry response");
    assert_eq!(retried.status(), StatusCode::OK);
    let download = send(
        &runtime,
        Method::GET,
        &format!("/download/storage/v1/b/{BUCKET}/o/resumed.bin?alt=media"),
        Body::empty(),
    )
    .await;
    assert_eq!(
        to_bytes(download.into_body(), usize::MAX)
            .await
            .expect("bytes")
            .as_ref(),
        bytes.as_slice()
    );
    assert_eq!(staged_files(&root), Vec::<PathBuf>::new());
    assert_eq!(runtime.console().in_flight(BUCKET), InFlight::default());
    runtime.shutdown().await.expect("shutdown");
    std::fs::remove_dir_all(root).expect("remove test storage");
}

#[tokio::test]
async fn orphans_are_removed_at_open() {
    let root = root("orphans");
    let runtime = start(&root).await;
    let (_, id) = start_resumable(&runtime, "unfinished.bin").await;
    runtime.shutdown().await.expect("shutdown");
    let session_file = root.join(format!("uploads/{id}.part"));
    let orphan = root.join("uploads/left-by-a-crash.part");
    std::fs::write(&orphan, vec![0_u8; 4_096]).expect("orphan");

    // The removal is said through the log sink the options give, from the
    // opening on, before anything could set one on the runtime.
    let said: Arc<Mutex<Vec<StorageLogLine>>> = Arc::default();
    let sink_said = Arc::clone(&said);
    let registry = TriggerRegistry::default();
    let (observer, _receiver) = TriggerObserver::channel(registry.clone());
    let runtime = StorageRuntime::start_with(
        StorageConfig {
            project: PROJECT.to_owned(),
            origin: "http://127.0.0.1:21002".to_owned(),
            data_dir: root.clone(),
            rules: None,
            durability: StorageDurability::PerCommit,
        },
        StorageOptions {
            log: Some(Arc::new(move |line| {
                sink_said.lock().expect("lines").push(line);
            })),
            ..StorageOptions::default()
        },
        observer.queue(),
        registry,
    )
    .await
    .expect("Storage runtime");
    assert!(
        !orphan.exists(),
        "a staged file no session names is removed"
    );
    assert!(session_file.exists(), "a session's staged file stays");
    assert_eq!(staged_files(&root), vec![session_file]);
    let said = said.lock().expect("lines").clone();
    let removed = said
        .iter()
        .find(|line| line.kind == "storage.uploads")
        .unwrap_or_else(|| panic!("the removal is said: {said:?}"));
    assert_eq!(removed.level, StorageLogLevel::Warn);
    assert!(
        removed
            .message
            .starts_with("removed 1 staged upload file left by an earlier run ("),
        "{}",
        removed.message
    );
    runtime.shutdown().await.expect("shutdown");
    std::fs::remove_dir_all(root).expect("remove test storage");
}
