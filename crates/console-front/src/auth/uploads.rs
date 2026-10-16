//! Import files on disk between the check and the import.
//!
//! `POST /auth/imports` streams the body to
//! `<temp dir>/firenook-console-imports/<instance>/<importId>.json`, never
//! holding it in memory. At most two uploads are kept (a third replaces the
//! oldest), each for 10 minutes; one is removed when it is imported or
//! discarded, and the instance's directory when the suite stops.

use std::collections::VecDeque;
use std::hash::{BuildHasher as _, Hasher as _};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use axum::body::{Body, Bytes};
use futures_util::StreamExt as _;

use crate::api_error::ApiError;
use crate::sse::Shutdown;

/// The largest file an import takes.
pub(crate) const MAX_UPLOAD: u64 = 512 * 1024 * 1024;
/// Uploads kept at once.
pub(crate) const MAX_PENDING: usize = 2;
/// How long an upload is kept.
pub(crate) const UPLOAD_LIFETIME: Duration = Duration::from_mins(10);
/// How often expired uploads are swept.
const SWEEP_EVERY: Duration = Duration::from_mins(1);

/// One kept upload.
#[derive(Clone, Debug)]
pub(crate) struct Upload {
    pub(crate) id: String,
    pub(crate) path: PathBuf,
    pub(crate) project: String,
    pub(crate) tenant: Option<String>,
    /// Users in the file, once the check counted them.
    pub(crate) total: Option<u64>,
    at: Instant,
}

struct Inner {
    dir: PathBuf,
    pending: Mutex<VecDeque<Upload>>,
    next: AtomicU64,
}

/// The kept uploads of one engine instance. Cheap to clone.
#[derive(Clone)]
pub(crate) struct Uploads {
    inner: Arc<Inner>,
}

fn remove(path: &Path) {
    let _ = std::fs::remove_file(path);
}

impl Uploads {
    /// Uploads under `<temp dir>/firenook-console-imports/<instance>`; the
    /// directory is created on the first upload and removed when the suite
    /// stops. Spawns the sweeper, so it is called within the runtime.
    pub(crate) fn start(instance: &str, shutdown: Shutdown) -> Self {
        let uploads = Self::at(
            std::env::temp_dir()
                .join("firenook-console-imports")
                .join(instance),
        );
        let sweeper = uploads.clone();
        tokio::spawn(async move {
            let stopped = shutdown.stopped();
            tokio::pin!(stopped);
            loop {
                tokio::select! {
                    () = &mut stopped => break,
                    () = tokio::time::sleep(SWEEP_EVERY) => sweeper.sweep(),
                }
            }
            sweeper.remove_all();
        });
        uploads
    }

    /// Uploads under `dir`, with no sweeper.
    pub(crate) fn at(dir: PathBuf) -> Self {
        Self {
            inner: Arc::new(Inner {
                dir,
                pending: Mutex::new(VecDeque::new()),
                next: AtomicU64::new(1),
            }),
        }
    }

    fn pending(&self) -> std::sync::MutexGuard<'_, VecDeque<Upload>> {
        self.inner
            .pending
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    fn new_id(&self) -> String {
        let count = self.inner.next.fetch_add(1, Ordering::Relaxed);
        let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
        hasher.write_u64(count);
        format!("{count}-{:016x}", hasher.finish())
    }

    /// Streams `body` to a new upload of `project` (and `tenant`). Over 512
    /// MiB is refused and nothing is kept.
    pub(crate) async fn receive(
        &self,
        body: Body,
        project: &str,
        tenant: Option<&str>,
    ) -> Result<Upload, ApiError> {
        let id = self.new_id();
        let path = self.inner.dir.join(format!("{id}.json"));
        let (sender, receiver) = std::sync::mpsc::sync_channel::<Bytes>(16);
        let dir = self.inner.dir.clone();
        let file_path = path.clone();
        let writer = tokio::task::spawn_blocking(move || -> std::io::Result<()> {
            std::fs::create_dir_all(&dir)?;
            let mut file = std::io::BufWriter::new(std::fs::File::create(&file_path)?);
            for chunk in receiver {
                file.write_all(&chunk)?;
            }
            file.flush()
        });
        let mut stream = body.into_data_stream();
        let mut size: u64 = 0;
        let mut failure = None;
        while let Some(chunk) = stream.next().await {
            match chunk {
                Ok(chunk) => {
                    size += u64::try_from(chunk.len()).unwrap_or(u64::MAX);
                    if size > MAX_UPLOAD {
                        failure = Some(ApiError::too_large("The file is over 512 MiB."));
                        break;
                    }
                    if sender.send(chunk).is_err() {
                        break;
                    }
                }
                Err(error) => {
                    failure = Some(ApiError::invalid(format!(
                        "The upload did not finish: {error}."
                    )));
                    break;
                }
            }
        }
        drop(sender);
        let written = writer
            .await
            .map_err(|_| ApiError::internal("saving the upload did not finish"))?;
        if let Some(failure) = failure {
            remove(&path);
            return Err(failure);
        }
        if let Err(error) = written {
            remove(&path);
            return Err(ApiError::internal(format!(
                "The upload could not be saved: {error}."
            )));
        }
        let upload = Upload {
            id,
            path,
            project: project.to_owned(),
            tenant: tenant.map(str::to_owned),
            total: None,
            at: Instant::now(),
        };
        let mut pending = self.pending();
        pending.push_back(upload.clone());
        while pending.len() > MAX_PENDING {
            if let Some(old) = pending.pop_front() {
                remove(&old.path);
            }
        }
        Ok(upload)
    }

    /// Records how many users the check counted.
    pub(crate) fn set_total(&self, id: &str, total: u64) {
        if let Some(upload) = self.pending().iter_mut().find(|upload| upload.id == id) {
            upload.total = Some(total);
        }
    }

    /// A kept upload; expired or unknown is `not-found`.
    pub(crate) fn get(&self, id: &str) -> Result<Upload, ApiError> {
        self.sweep();
        self.pending()
            .iter()
            .find(|upload| upload.id == id)
            .cloned()
            .ok_or_else(|| {
                ApiError::not_found("This upload has expired: uploads are kept for 10 minutes.")
                    .with_fix("Choose the file again.")
            })
    }

    /// Takes an upload out of the kept list for an import, which removes
    /// its file when done; the sweeper no longer touches it.
    pub(crate) fn claim(&self, id: &str) -> Option<Upload> {
        let mut pending = self.pending();
        let index = pending.iter().position(|upload| upload.id == id)?;
        pending.remove(index)
    }

    /// Removes an upload and its file.
    pub(crate) fn discard(&self, id: &str) {
        if let Some(upload) = self.claim(id) {
            remove(&upload.path);
        }
    }

    /// Removes a claimed upload's file.
    pub(crate) fn finished(upload: &Upload) {
        remove(&upload.path);
    }

    /// Removes uploads older than 10 minutes.
    pub(crate) fn sweep(&self) {
        let mut pending = self.pending();
        pending.retain(|upload| {
            let keep = upload.at.elapsed() < UPLOAD_LIFETIME;
            if !keep {
                remove(&upload.path);
            }
            keep
        });
    }

    /// Removes every upload and the instance's directory.
    pub(crate) fn remove_all(&self) {
        self.pending().clear();
        let _ = std::fs::remove_dir_all(&self.inner.dir);
    }

    /// The directory uploads are written to.
    #[cfg(test)]
    pub(crate) fn dir(&self) -> &Path {
        &self.inner.dir
    }

    /// Ages an upload, for the expiry test.
    #[cfg(test)]
    pub(crate) fn age(&self, id: &str, by: Duration) {
        if let Some(upload) = self.pending().iter_mut().find(|upload| upload.id == id) {
            upload.at = upload.at.checked_sub(by).unwrap_or(upload.at);
        }
    }
}
