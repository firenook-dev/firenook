use std::io::Read as _;

use axum::http::{Request, StatusCode};
use futures_util::StreamExt as _;
use serde_json::{Value, json};
use tower::ServiceExt as _;

use super::*;
use crate::jobs::{Job, JobState};

/// A folder of the test's own, removed when it ends.
struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Self {
        let path =
            std::env::temp_dir().join(format!("firenook-snapshots-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).expect("scratch");
        Self(path)
    }

    /// Staging folders under this one, each new.
    fn staging(&self) -> firenook_suite_front::SnapshotStaging {
        let root = self.0.clone();
        let next = Arc::new(std::sync::atomic::AtomicU32::new(0));
        Arc::new(move || {
            let index = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            Ok(root.join(format!(".firenook-snapshot-{index}")))
        })
    }

    /// Whether anything is left under this folder.
    fn empty(&self) -> bool {
        std::fs::read_dir(&self.0).is_ok_and(|mut entries| entries.next().is_none())
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// An exporter that writes a small standard export, after `gate` opens
/// when one is given; `payload` bytes go in one file.
fn exporter(gate: Option<oneshot::Receiver<()>>, payload: usize) -> mpsc::Sender<ExportCommand> {
    let (sender, mut commands) = mpsc::channel::<ExportCommand>(4);
    tokio::spawn(async move {
        let mut gate = gate;
        while let Some(command) = commands.recv().await {
            if let Some(gate) = gate.take() {
                let _ = gate.await;
            }
            let destination = command.destination.clone();
            let written = tokio::task::spawn_blocking(move || {
                std::fs::create_dir_all(destination.join("firestore_export"))?;
                std::fs::write(
                    destination.join("firebase-export-metadata.json"),
                    br#"{"version":"1"}"#,
                )?;
                std::fs::write(
                    destination
                        .join("firestore_export")
                        .join("all.overall_export_metadata"),
                    (0..payload)
                        .map(|index| u8::try_from(index * 7919 % 251).expect("a byte"))
                        .collect::<Vec<_>>(),
                )
            })
            .await
            .expect("written");
            let _ = command
                .completion
                .send(written.map_err(|error| error.to_string()));
        }
    });
    sender
}

fn port(
    scratch: &Scratch,
    exporter: mpsc::Sender<ExportCommand>,
    free: Option<u64>,
) -> SnapshotPort {
    SnapshotPort {
        exporter,
        staging: scratch.staging(),
        free_space: Arc::new(move |_| free),
        size: Arc::new(|_| 1_000),
        targets: vec!["firestore".to_owned(), "auth".to_owned()],
        project: "demo-snap".to_owned(),
    }
}

fn running() -> (tokio::sync::watch::Sender<bool>, Shutdown) {
    let (stop, receiver) = tokio::sync::watch::channel(false);
    (stop, Shutdown::new(receiver))
}

struct Harness {
    router: Router,
    jobs: JobRegistry,
    _stop: tokio::sync::watch::Sender<bool>,
}

fn harness(port: SnapshotPort) -> Harness {
    let jobs = JobRegistry::new();
    let (stop, shutdown) = running();
    Harness {
        router: router(Snapshots::new(Some(port), jobs.clone(), shutdown)),
        jobs,
        _stop: stop,
    }
}

async fn send(
    router: &Router,
    request: Request<Body>,
) -> (StatusCode, axum::http::HeaderMap, Vec<u8>) {
    let response = router.clone().oneshot(request).await.expect("response");
    let status = response.status();
    let headers = response.headers().clone();
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body")
        .to_vec();
    (status, headers, body)
}

fn post(body: &Value) -> Request<Body> {
    Request::post("/overview/snapshots")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_string()))
        .expect("request")
}

async fn start(harness: &Harness, body: &Value) -> Job {
    let (status, _, answer) = send(&harness.router, post(body)).await;
    assert_eq!(
        status,
        StatusCode::ACCEPTED,
        "{}",
        String::from_utf8_lossy(&answer)
    );
    let answer: Value = serde_json::from_slice(&answer).expect("a job");
    harness
        .jobs
        .get(answer["id"].as_str().expect("the job id"))
        .expect("kept")
}

async fn finished(jobs: &JobRegistry, id: &str) -> Job {
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            let job = jobs.get(id).expect("kept");
            if job.state != JobState::Running {
                return job;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the job finishes")
}

fn snapshot_of(job: &Job) -> String {
    job.result.as_ref().expect("a result")["snapshot"]
        .as_str()
        .expect("the snapshot id")
        .to_owned()
}

#[tokio::test]
async fn a_snapshot_is_prepared_by_a_job_and_downloads_once_as_a_zip_of_the_export() {
    let scratch = Scratch::new("download");
    let harness = harness(port(&scratch, exporter(None, 300_000), Some(u64::MAX)));
    let job = start(&harness, &json!({})).await;
    assert_eq!(job.kind, "suite.snapshot");
    assert_eq!(job.section, "suite");
    assert_eq!(job.title, "Prepare a snapshot");
    let job = finished(&harness.jobs, &job.id).await;
    assert_eq!(job.state, JobState::Done, "{job:?}");
    let id = snapshot_of(&job);
    assert_eq!(id.len(), 32, "128 bits: {id}");
    let (status, _, body) = send(
        &harness.router,
        Request::get(format!("/overview/snapshots/{id}"))
            .body(Body::empty())
            .expect("request"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let file: Value = serde_json::from_slice(&body).expect("json");
    assert_eq!(file["files"], 2);
    assert_eq!(file["bytes"], 300_000 + 15);
    assert!(file["expiresAt"].is_string());
    let (status, headers, body) = send(
        &harness.router,
        Request::get(format!("/overview/snapshots/{id}/download"))
            .body(Body::empty())
            .expect("request"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers[header::CONTENT_TYPE], "application/zip");
    let disposition = headers[header::CONTENT_DISPOSITION]
        .to_str()
        .expect("ascii");
    assert!(
        disposition.starts_with("attachment; filename=\"firenook-demo-snap-"),
        "{disposition}"
    );
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(body)).expect("a zip");
    let names: Vec<String> = archive
        .file_names()
        .map(|name| name.expect("name").into_owned())
        .collect();
    let root = names[0]
        .split('/')
        .next()
        .expect("a root folder")
        .to_owned();
    assert!(root.starts_with("firenook-demo-snap-"), "{names:?}");
    assert!(
        names.contains(&format!("{root}/firebase-export-metadata.json")),
        "{names:?}"
    );
    let mut metadata = String::new();
    archive
        .by_name(&format!("{root}/firebase-export-metadata.json"))
        .expect("the metadata")
        .read_to_string(&mut metadata)
        .expect("read");
    assert_eq!(metadata, r#"{"version":"1"}"#);
    let large = archive
        .by_name(&format!(
            "{root}/firestore_export/all.overall_export_metadata"
        ))
        .expect("the data");
    assert_eq!(large.size(), 300_000);
    assert_eq!(large.compression(), zip::CompressionMethod::Deflated);
    drop(large);
    // The folder is gone once the transfer ends, and so is the snapshot.
    wait_empty(&scratch).await;
    let (status, _, body) = send(
        &harness.router,
        Request::get(format!("/overview/snapshots/{id}/download"))
            .body(Body::empty())
            .expect("request"),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let error: Value = serde_json::from_slice(&body).expect("json");
    assert_eq!(
        error["error"]["message"],
        "The engine no longer keeps this snapshot; it keeps the newest one for 10 minutes."
    );
    assert_eq!(error["error"]["fix"], "Prepare it again.");
}

async fn wait_empty(scratch: &Scratch) {
    tokio::time::timeout(Duration::from_secs(10), async {
        while !scratch.empty() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the staging folder is removed");
}

#[tokio::test]
async fn a_download_abandoned_mid_way_still_removes_the_folder() {
    let scratch = Scratch::new("abandoned");
    let harness = harness(port(&scratch, exporter(None, 4 * 1024 * 1024), None));
    let job = finished(&harness.jobs, &start(&harness, &json!({})).await.id).await;
    let id = snapshot_of(&job);
    let response = harness
        .router
        .clone()
        .oneshot(
            Request::get(format!("/overview/snapshots/{id}/download"))
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");
    let mut body = response.into_body().into_data_stream();
    let first = body.next().await.expect("a chunk").expect("bytes");
    assert!(!first.is_empty());
    drop(body);
    wait_empty(&scratch).await;
}

#[tokio::test(start_paused = true)]
async fn a_snapshot_nobody_downloads_expires_after_ten_minutes() {
    let scratch = Scratch::new("expiry");
    let harness = harness(port(&scratch, exporter(None, 10), None));
    let job = finished(&harness.jobs, &start(&harness, &json!({})).await.id).await;
    let id = snapshot_of(&job);
    tokio::time::sleep(SNAPSHOT_KEPT + Duration::from_secs(1)).await;
    wait_empty(&scratch).await;
    let (status, _, _) = send(
        &harness.router,
        Request::get(format!("/overview/snapshots/{id}"))
            .body(Body::empty())
            .expect("request"),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn one_suite_job_at_a_time_and_the_prepare_outlives_its_request() {
    let scratch = Scratch::new("conflict");
    let (open, gate) = oneshot::channel();
    let harness = harness(port(&scratch, exporter(Some(gate), 10), None));
    // The request answers at once; nothing about it matters afterwards.
    let first = start(&harness, &json!({})).await;
    let (status, _, body) = send(&harness.router, post(&json!({}))).await;
    assert_eq!(status, StatusCode::CONFLICT);
    let error: Value = serde_json::from_slice(&body).expect("json");
    assert_eq!(error["error"]["code"], "conflict");
    open.send(()).expect("opened");
    let job = finished(&harness.jobs, &first.id).await;
    assert_eq!(job.state, JobState::Done);
}

#[tokio::test]
async fn a_cancelled_prepare_keeps_nothing() {
    let scratch = Scratch::new("cancel");
    let (open, gate) = oneshot::channel();
    let harness = harness(port(&scratch, exporter(Some(gate), 10), None));
    let job = start(&harness, &json!({})).await;
    harness.jobs.cancel(&job.id);
    open.send(()).expect("opened");
    let job = finished(&harness.jobs, &job.id).await;
    assert_eq!(job.state, JobState::Cancelled, "{job:?}");
    assert_eq!(job.result, None);
    wait_empty(&scratch).await;
}

#[tokio::test]
async fn a_snapshot_that_would_not_fit_is_refused_before_any_job() {
    let scratch = Scratch::new("space");
    let mut port = port(&scratch, exporter(None, 10), Some(400 * 1024 * 1024));
    port.size = Arc::new(|_| 1_300 * 1024 * 1024);
    let harness = harness(port);
    let (status, _, body) = send(&harness.router, post(&json!({}))).await;
    assert_eq!(status, StatusCode::PRECONDITION_FAILED);
    let error: Value = serde_json::from_slice(&body).expect("json");
    assert_eq!(error["error"]["code"], "failed-precondition");
    assert_eq!(
        error["error"]["message"],
        "Not enough free space next to the state folder: the snapshot needs about 1.4 GB and 400 MB are free."
    );
    assert_eq!(
        error["error"]["fix"],
        "Free some space, or save the snapshot on the engine's machine instead."
    );
    assert_eq!(harness.jobs.list(Some("suite")).len(), 0, "no job started");
}

#[tokio::test]
async fn a_snapshot_holds_every_service_the_engine_runs_and_takes_no_arguments() {
    let scratch = Scratch::new("targets");
    let harness = harness(port(&scratch, exporter(None, 10), None));
    for body in [json!({ "targets": ["firestore"] }), json!({ "extra": 1 })] {
        let (status, _, _) = send(&harness.router, post(&body)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    }
    let mut nothing = port(&scratch, exporter(None, 10), None);
    nothing.targets = vec!["pubsub".to_owned()];
    let empty = self::harness(nothing);
    let (status, _, answer) = send(&empty.router, post(&json!({}))).await;
    assert_eq!(status, StatusCode::PRECONDITION_FAILED);
    let error: Value = serde_json::from_slice(&answer).expect("json");
    assert_eq!(
        error["error"]["message"],
        "No service this engine runs keeps data a snapshot could hold."
    );
    assert_eq!(empty.jobs.list(Some("suite")).len(), 0, "no job started");
    let detached = router(Snapshots::new(None, JobRegistry::new(), running().1));
    let (status, _, _) = send(&detached, post(&json!({}))).await;
    assert_eq!(status, StatusCode::PRECONDITION_FAILED);
}

#[tokio::test]
async fn a_cross_site_download_never_reaches_the_route() {
    let directory = firenook_suite_front::SuiteDirectory::new(
        "demo-snap",
        [firenook_suite_front::ServiceInfo::listening(
            "hub",
            "127.0.0.1",
            4,
        )],
    )
    .expect("directory");
    let router = crate::console_router(crate::ConsoleServices::new(directory, running().1));
    let response = router
        .oneshot(
            Request::get("/api/v1/overview/snapshots/0123456789abcdef0123456789abcdef/download")
                .header("sec-fetch-site", "cross-site")
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

#[test]
fn sizes_read_as_the_console_writes_them() {
    assert_eq!(size_text(512), "512 bytes");
    assert_eq!(size_text(400 * 1024 * 1024), "400 MB");
    assert_eq!(size_text(1_395_864_371), "1.3 GB");
    assert_eq!(size_text(10 * 1024), "10 KB");
}
