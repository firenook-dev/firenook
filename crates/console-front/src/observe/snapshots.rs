//! Downloading a snapshot of the running suite: a zip of a standard export
//! (the folder `--import` reads), prepared by a foundation job.
//!
//! `POST /overview/snapshots` checks what it can at once (the services
//! named, a staging folder, the free space beside it) and starts a
//! `suite.snapshot` job, so the registry's one-suite-job rule keeps a
//! snapshot from ever capturing a half-done reset. The job hands the suite
//! exporter (the hub's own export, one export at a time) a folder beside
//! the state directory, never the system's temporary directory, which on
//! many systems is memory. The prepared snapshot waits up to 10 minutes;
//! its download streams a zip from a blocking task through a bounded
//! channel, so memory stays flat whatever the export's size, and the folder
//! is removed once the transfer ends or the browser goes away.

use std::collections::BTreeSet;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::extract::{Path as RoutePath, State};
use axum::http::{HeaderValue, header};
use axum::response::{IntoResponse as _, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use firenook_suite_front::{ExportCommand, SnapshotPort};
use futures_util::FutureExt as _;
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use tokio::sync::{mpsc, oneshot};
use tokio_stream::wrappers::ReceiverStream;
use ts_rs::TS;

use crate::api_error::ApiError;
use crate::blocking::blocking;
use crate::http::attachment;
use crate::instance::random_id;
use crate::jobs::{JobRegistry, accepted};
use crate::json::ConsoleJson;
use crate::sse::Shutdown;

/// How long a prepared snapshot waits for its download.
pub(crate) const SNAPSHOT_KEPT: Duration = Duration::from_mins(10);
/// What the archive's stream is cut into.
const CHUNK: usize = 64 * 1024;
/// Chunks the stream holds while the browser reads.
const CHUNKS_IN_FLIGHT: usize = 8;
/// The services a snapshot can hold.
const SNAPSHOT_TARGETS: [&str; 3] = ["firestore", "auth", "storage"];

/// `GET /overview/snapshots/{id}`: a prepared snapshot the download route
/// serves.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "observe/")]
pub(crate) struct OverviewSnapshotFile {
    pub(crate) id: String,
    /// Files in the export.
    pub(crate) files: u32,
    /// Their bytes, before compression.
    #[ts(type = "number")]
    pub(crate) bytes: u64,
    /// When the engine discards it, RFC 3339.
    pub(crate) expires_at: String,
}

/// `POST /overview/snapshots`: `{}`. A snapshot holds every service this
/// engine runs whose data an export keeps; choosing services is the save
/// on the engine's machine's (`POST /suite/export`).
#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct SnapshotRequest {}

/// A snapshot waiting for its download.
#[derive(Debug)]
struct Prepared {
    id: String,
    /// The staging folder, removed with everything in it.
    root: PathBuf,
    /// The export inside it: the archive's root folder.
    name: String,
    files: u32,
    bytes: u64,
    expires_at: String,
}

impl Prepared {
    fn file(&self) -> OverviewSnapshotFile {
        OverviewSnapshotFile {
            id: self.id.clone(),
            files: self.files,
            bytes: self.bytes,
            expires_at: self.expires_at.clone(),
        }
    }
}

struct Inner {
    port: Option<SnapshotPort>,
    jobs: JobRegistry,
    shutdown: Shutdown,
    /// One prepared snapshot at a time.
    prepared: Mutex<Option<Prepared>>,
}

/// The snapshot routes' shared state.
#[derive(Clone)]
pub(crate) struct Snapshots {
    inner: Arc<Inner>,
}

fn lock(mutex: &Mutex<Option<Prepared>>) -> MutexGuard<'_, Option<Prepared>> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl Snapshots {
    pub(crate) fn new(port: Option<SnapshotPort>, jobs: JobRegistry, shutdown: Shutdown) -> Self {
        Self {
            inner: Arc::new(Inner {
                port,
                jobs,
                shutdown,
                prepared: Mutex::new(None),
            }),
        }
    }

    /// The prepared snapshot `id`, taken out of the slot.
    fn take(&self, id: &str) -> Option<Prepared> {
        let mut prepared = lock(&self.inner.prepared);
        if prepared.as_ref().is_some_and(|kept| kept.id == id) {
            prepared.take()
        } else {
            None
        }
    }

    /// Discards snapshot `id`, folder and all; whether it was kept.
    async fn discard(&self, id: &str) -> bool {
        let Some(prepared) = self.take(id) else {
            return false;
        };
        remove(prepared.root).await;
        true
    }

    /// Keeps `prepared`, discarding the one it replaces, and lets it go
    /// after [`SNAPSHOT_KEPT`] or when the suite stops.
    async fn keep(&self, prepared: Prepared) {
        let id = prepared.id.clone();
        let replaced = lock(&self.inner.prepared).replace(prepared);
        if let Some(replaced) = replaced {
            remove(replaced.root).await;
        }
        let snapshots = self.clone();
        let stopped = self.inner.shutdown.clone().stopped();
        tokio::spawn(async move {
            tokio::select! {
                () = tokio::time::sleep(SNAPSHOT_KEPT) => {}
                () = stopped => {}
            }
            snapshots.discard(&id).await;
        });
    }
}

/// Removes a staging folder, off the runtime; a folder already gone is
/// fine.
async fn remove(root: PathBuf) {
    let _ = blocking("the snapshot cleanup", move || {
        let _ = std::fs::remove_dir_all(&root);
        Ok(())
    })
    .await;
}

/// The snapshot routes.
pub(crate) fn router(snapshots: Snapshots) -> Router {
    Router::new()
        .route("/overview/snapshots", post(prepare))
        .route("/overview/snapshots/{id}", get(file).delete(delete))
        .route("/overview/snapshots/{id}/download", get(download))
        .with_state(snapshots)
}

/// `1.3 GB`, `400 MB`, as the console writes sizes (powers of 1024).
pub(crate) fn size_text(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["bytes", "KB", "MB", "GB", "TB"];
    #[allow(clippy::cast_precision_loss, reason = "a size shown to one decimal")]
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{bytes} bytes")
    } else if value < 10.0 {
        format!("{value:.1} {}", UNITS[unit])
    } else {
        format!("{value:.0} {}", UNITS[unit])
    }
}

/// A token nobody can guess: 128 bits from two keyed hashes.
fn snapshot_id() -> String {
    let first = random_id('s');
    let second = random_id('s');
    format!("{}{}", &first[1..], &second[1..])
}

/// `20261012-040609`, in UTC.
fn stamp(now: OffsetDateTime) -> String {
    format!(
        "{:04}{:02}{:02}-{:02}{:02}{:02}",
        now.year(),
        u8::from(now.month()),
        now.day(),
        now.hour(),
        now.minute(),
        now.second()
    )
}

/// The services a snapshot holds: every one this engine runs whose data
/// an export keeps.
fn snapshot_targets(port: &SnapshotPort) -> Result<BTreeSet<String>, ApiError> {
    let targets: BTreeSet<String> = port
        .targets
        .iter()
        .filter(|target| SNAPSHOT_TARGETS.contains(&target.as_str()))
        .cloned()
        .collect();
    if targets.is_empty() {
        return Err(ApiError::precondition(
            "No service this engine runs keeps data a snapshot could hold.",
        ));
    }
    Ok(targets)
}

/// Refuses a snapshot the volume beside `root` has no room for: it needs
/// about 1.1 times what the export writes. Platforms that cannot tell skip
/// the check and report the export's own error instead.
async fn check_space(
    port: &SnapshotPort,
    root: &Path,
    targets: &BTreeSet<String>,
) -> Result<(), ApiError> {
    let port = port.clone();
    let parent = root.parent().unwrap_or(root).to_path_buf();
    let targets = targets.clone();
    let (free, size) = blocking("the free space check", move || {
        Ok(((port.free_space)(&parent), (port.size)(&targets)))
    })
    .await?;
    let needed = size.saturating_add(size / 10);
    match free {
        Some(free) if free < needed => Err(ApiError::precondition(format!(
            "Not enough free space next to the state folder: the snapshot needs about {} and {} are free.",
            size_text(needed),
            size_text(free)
        ))
        .with_fix("Free some space, or save the snapshot on the engine's machine instead.")),
        _ => Ok(()),
    }
}

/// `POST /overview/snapshots`: `202` with the `suite.snapshot` job; its
/// result names the prepared snapshot once it is done.
async fn prepare(
    State(snapshots): State<Snapshots>,
    ConsoleJson(SnapshotRequest {}): ConsoleJson<SnapshotRequest>,
) -> Result<Response, ApiError> {
    let Some(port) = snapshots.inner.port.clone() else {
        return Err(ApiError::precondition(
            "This console is not attached to a running suite, so there is nothing to export.",
        ));
    };
    let targets = snapshot_targets(&port)?;
    let root = (port.staging)().map_err(|reason| {
        ApiError::precondition(format!(
            "The engine cannot prepare a snapshot here: {reason}"
        ))
        .with_fix("Save the snapshot on the engine's machine instead, or export with firenook emulators:export <dir>.")
    })?;
    check_space(&port, &root, &targets).await?;
    let name = format!(
        "firenook-{}-{}",
        port.project,
        stamp(OffsetDateTime::now_utc())
    );
    let worker = snapshots.clone();
    let job = snapshots.inner.jobs.start(
        "suite",
        "suite.snapshot",
        "Prepare a snapshot".to_owned(),
        Some(1),
        move |handle| {
            async move {
                if handle.cancelled() {
                    return Ok(());
                }
                let export = root.join(&name);
                let (completion, finished) = oneshot::channel();
                port.exporter
                    .send(ExportCommand {
                        destination: export.clone(),
                        targets,
                        completion,
                    })
                    .await
                    .map_err(|_| ApiError::unavailable("The engine is stopping."))?;
                let exported = finished
                    .await
                    .map_err(|_| ApiError::unavailable("The engine is stopping."))?;
                if let Err(reason) = exported {
                    remove(root).await;
                    return Err(ApiError::internal(format!(
                        "The export did not finish: {reason}"
                    )));
                }
                if handle.cancelled() {
                    remove(root).await;
                    return Ok(());
                }
                let (files, bytes) =
                    blocking("the snapshot count", move || Ok(count(&export))).await?;
                let id = snapshot_id();
                worker
                    .keep(Prepared {
                        id: id.clone(),
                        root,
                        name,
                        files,
                        bytes,
                        expires_at: crate::observe::log::format_time(
                            OffsetDateTime::now_utc() + SNAPSHOT_KEPT,
                        ),
                    })
                    .await;
                handle.progress(1);
                handle.set_result(serde_json::json!({
                    "snapshot": id,
                    "files": files,
                    "bytes": bytes,
                }));
                Ok(())
            }
            .boxed()
        },
    )?;
    Ok(accepted(job))
}

/// Files and bytes under `folder`.
fn count(folder: &Path) -> (u32, u64) {
    let mut files: u32 = 0;
    let mut bytes: u64 = 0;
    for (_, path) in walk(folder) {
        files = files.saturating_add(1);
        bytes = bytes.saturating_add(std::fs::metadata(&path).map_or(0, |metadata| metadata.len()));
    }
    (files, bytes)
}

/// Every file under `folder` with its path relative to it (`/`-separated),
/// in name order.
fn walk(folder: &Path) -> Vec<(String, PathBuf)> {
    let mut found = Vec::new();
    let mut pending = vec![(String::new(), folder.to_path_buf())];
    while let Some((prefix, directory)) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&directory) else {
            continue;
        };
        let mut entries: Vec<_> = entries.flatten().collect();
        entries.sort_by_key(std::fs::DirEntry::file_name);
        for entry in entries {
            let name = entry.file_name().to_string_lossy().into_owned();
            let relative = if prefix.is_empty() {
                name
            } else {
                format!("{prefix}/{name}")
            };
            match entry.file_type() {
                Ok(kind) if kind.is_dir() => pending.push((relative, entry.path())),
                Ok(kind) if kind.is_file() => found.push((relative, entry.path())),
                _ => {}
            }
        }
    }
    found.sort();
    found
}

/// `GET /overview/snapshots/{id}`.
async fn file(
    State(snapshots): State<Snapshots>,
    RoutePath(id): RoutePath<String>,
) -> Result<Json<OverviewSnapshotFile>, ApiError> {
    lock(&snapshots.inner.prepared)
        .as_ref()
        .filter(|prepared| prepared.id == id)
        .map(|prepared| Json(prepared.file()))
        .ok_or_else(gone)
}

fn gone() -> ApiError {
    ApiError::not_found(
        "The engine no longer keeps this snapshot; it keeps the newest one for 10 minutes.",
    )
    .with_fix("Prepare it again.")
}

/// `DELETE /overview/snapshots/{id}` (body `{}`): discards it.
async fn delete(
    State(snapshots): State<Snapshots>,
    RoutePath(id): RoutePath<String>,
    ConsoleJson(_): ConsoleJson<serde_json::Value>,
) -> Result<Json<serde_json::Value>, ApiError> {
    if snapshots.discard(&id).await {
        Ok(Json(serde_json::json!({})))
    } else {
        Err(gone())
    }
}

/// `GET /overview/snapshots/{id}/download`: the zip, streamed once. The
/// folder is removed when the transfer ends, the browser goes away or the
/// suite stops.
async fn download(
    State(snapshots): State<Snapshots>,
    RoutePath(id): RoutePath<String>,
) -> Result<Response, ApiError> {
    let prepared = snapshots.take(&id).ok_or_else(gone)?;
    let filename = format!("{}.zip", prepared.name);
    let (sender, receiver) = mpsc::channel::<Result<Bytes, std::io::Error>>(CHUNKS_IN_FLIGHT);
    let shutdown = snapshots.inner.shutdown.clone();
    tokio::task::spawn_blocking(move || {
        let export = prepared.root.join(&prepared.name);
        let _ = write_zip(&export, &prepared.name, &sender, &shutdown);
        let _ = std::fs::remove_dir_all(&prepared.root);
    });
    let [disposition] = attachment(&filename);
    Ok((
        [
            (
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/zip"),
            ),
            (header::CACHE_CONTROL, HeaderValue::from_static("no-store")),
            disposition,
        ],
        Body::from_stream(ReceiverStream::new(receiver)),
    )
        .into_response())
}

/// Writes the archive into a bounded channel, 64 KiB at a time; a send
/// fails once the browser is gone, which ends the archive.
struct ChannelWriter<'a> {
    sender: &'a mpsc::Sender<Result<Bytes, std::io::Error>>,
    buffer: Vec<u8>,
}

impl ChannelWriter<'_> {
    fn send(&mut self) -> std::io::Result<()> {
        if self.buffer.is_empty() {
            return Ok(());
        }
        let chunk = Bytes::from(std::mem::replace(
            &mut self.buffer,
            Vec::with_capacity(CHUNK),
        ));
        self.sender.blocking_send(Ok(chunk)).map_err(|_| {
            std::io::Error::new(std::io::ErrorKind::BrokenPipe, "the download was abandoned")
        })
    }
}

impl std::io::Write for ChannelWriter<'_> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.buffer.extend_from_slice(bytes);
        if self.buffer.len() >= CHUNK {
            self.send()?;
        }
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.send()
    }
}

/// The export at `export` as a zip whose root folder is `name`: every file
/// a large-file (ZIP64) entry, deflated at level 1. Stops between files
/// once the suite is stopping.
fn write_zip(
    export: &Path,
    name: &str,
    sender: &mpsc::Sender<Result<Bytes, std::io::Error>>,
    shutdown: &Shutdown,
) -> zip::result::ZipResult<()> {
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .compression_level(Some(1))
        .large_file(true);
    let writer = ChannelWriter {
        sender,
        buffer: Vec::with_capacity(CHUNK),
    };
    let mut archive = zip::ZipWriter::new_stream(writer);
    for (relative, path) in walk(export) {
        if shutdown.is_stopping() {
            return Err(zip::result::ZipError::Io(std::io::Error::other(
                "the engine is stopping",
            )));
        }
        archive.start_file(format!("{name}/{relative}"), options)?;
        let mut file = std::fs::File::open(&path)?;
        std::io::copy(&mut file, &mut archive)?;
    }
    let mut writer = archive.finish()?.into_inner();
    writer.flush()?;
    Ok(())
}

#[cfg(test)]
#[path = "snapshots_tests.rs"]
mod tests;
