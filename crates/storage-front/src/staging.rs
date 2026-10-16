//! Bytes on their way into an object: staged files, what they count, and
//! what an earlier process left behind.
//!
//! An upload streams to `uploads/<id>.part` and is renamed onto its object
//! file when it commits. A staged file that never commits (the client
//! aborted, the rules refused it, the disk filled) must not outlive its
//! request, so it is owned by a [`StagedFile`] that removes it when dropped.
//! While bytes are staged they are counted per bucket, so a console can say
//! how much is in flight without reading the directory.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use time::OffsetDateTime;

use crate::{StorageConfig, StorageData, stable_id};

/// Makes every staging path unique within the process: two uploads staged
/// in the same clock tick (macOS reports microseconds) would otherwise write
/// one file.
static STAGING_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// A fresh staging path of `kind` (`upload`, `copy`).
pub(crate) fn staging_path(config: &StorageConfig, kind: &str) -> PathBuf {
    staging_path_at(
        config,
        kind,
        OffsetDateTime::now_utc().unix_timestamp_nanos(),
    )
}

fn staging_path_at(config: &StorageConfig, kind: &str, nanos: i128) -> PathBuf {
    let id = stable_id(&[
        &config.project,
        kind,
        &std::process::id().to_string(),
        &nanos.to_string(),
        &STAGING_SEQUENCE.fetch_add(1, Ordering::Relaxed).to_string(),
    ]);
    config.data_dir.join("uploads").join(format!("{id}.part"))
}

/// Staged uploads of one bucket: files and bytes, rising while bytes are
/// written and falling when a staged file commits or is dropped.
#[derive(Debug, Default)]
pub(crate) struct BucketGauge {
    files: AtomicU64,
    bytes: AtomicU64,
}

impl BucketGauge {
    fn add_bytes(&self, bytes: u64) {
        self.bytes.fetch_add(bytes, Ordering::Relaxed);
    }

    fn release(&self, files: u64, bytes: u64) {
        // Saturating: a release never runs before its own increments, but a
        // gauge is a figure, not an invariant worth a panic.
        self.files
            .update(Ordering::Relaxed, Ordering::Relaxed, |value| {
                value.saturating_sub(files)
            });
        self.bytes
            .update(Ordering::Relaxed, Ordering::Relaxed, |value| {
                value.saturating_sub(bytes)
            });
    }
}

/// The in-flight gauges of every bucket that has staged anything.
#[derive(Debug, Default)]
pub(crate) struct StagingGauge {
    buckets: Mutex<BTreeMap<String, Arc<BucketGauge>>>,
}

impl StagingGauge {
    /// The gauge of `bucket`, created on first use.
    pub(crate) fn bucket(&self, bucket: &str) -> Arc<BucketGauge> {
        let mut buckets = self
            .buckets
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(gauge) = buckets.get(bucket) {
            return Arc::clone(gauge);
        }
        let gauge = Arc::new(BucketGauge::default());
        buckets.insert(bucket.to_owned(), Arc::clone(&gauge));
        gauge
    }

    fn snapshot(&self, bucket: &str) -> (u64, u64) {
        let buckets = self
            .buckets
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        buckets.get(bucket).map_or((0, 0), |gauge| {
            (
                gauge.files.load(Ordering::Relaxed),
                gauge.bytes.load(Ordering::Relaxed),
            )
        })
    }

    /// Counts the bytes of one resumable chunk while it is appended; the
    /// session itself already counts as an upload.
    pub(crate) fn chunk(&self, bucket: &str) -> ChunkGauge {
        ChunkGauge {
            gauge: self.bucket(bucket),
            bytes: 0,
        }
    }
}

/// Bytes of one resumable chunk being appended, released when it ends.
pub(crate) struct ChunkGauge {
    gauge: Arc<BucketGauge>,
    bytes: u64,
}

impl ChunkGauge {
    pub(crate) fn add(&mut self, bytes: u64) {
        self.bytes = self.bytes.saturating_add(bytes);
        self.gauge.add_bytes(bytes);
    }
}

impl Drop for ChunkGauge {
    fn drop(&mut self) {
        self.gauge.release(0, self.bytes);
    }
}

/// Bytes staged by uploads still in progress in one bucket: single uploads
/// being received and resumable sessions not yet finished.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct InFlight {
    /// Uploads holding staged bytes.
    pub uploads: u32,
    /// Their staged bytes.
    pub bytes: u64,
}

/// What `bucket` has in flight: the staging gauge plus every live resumable
/// session (a denied or cancelled session holds no bytes).
pub(crate) fn in_flight(gauge: &StagingGauge, data: &StorageData, bucket: &str) -> InFlight {
    let (files, bytes) = gauge.snapshot(bucket);
    let (sessions, received) = data
        .uploads
        .values()
        .filter(|session| session.bucket == bucket && !session.denied && !session.cancelled)
        .fold((0_u64, 0_u64), |(count, bytes), session| {
            (count + 1, bytes.saturating_add(session.received))
        });
    InFlight {
        uploads: u32::try_from(files.saturating_add(sessions)).unwrap_or(u32::MAX),
        bytes: bytes.saturating_add(received),
    }
}

/// A staged file that is removed when dropped, unless it was committed
/// (renamed onto its object) or belongs to a resumable session, which keeps
/// its bytes so the client can resume.
#[derive(Debug)]
pub(crate) struct StagedFile {
    path: PathBuf,
    keep: bool,
    /// The bucket gauge this file counts in, and the bytes it added.
    counted: Option<(Arc<BucketGauge>, u64)>,
}

impl StagedFile {
    /// A new staged file of one upload, counted in `gauge`.
    pub(crate) fn new(path: PathBuf, gauge: Arc<BucketGauge>) -> Self {
        gauge.files.fetch_add(1, Ordering::Relaxed);
        Self {
            path,
            keep: false,
            counted: Some((gauge, 0)),
        }
    }

    /// A resumable session's bytes: kept whatever happens unless discarded,
    /// and counted by the session rather than here.
    pub(crate) const fn session(path: PathBuf) -> Self {
        Self {
            path,
            keep: true,
            counted: None,
        }
    }

    /// The session record naming these bytes is gone (a finished upload):
    /// from now on the request owns them and they go unless committed.
    pub(crate) fn orphaned(mut self) -> Self {
        self.keep = false;
        self
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    /// Counts bytes just written to the file.
    pub(crate) fn add(&mut self, bytes: u64) {
        if let Some((gauge, counted)) = &mut self.counted {
            gauge.add_bytes(bytes);
            *counted = counted.saturating_add(bytes);
        }
    }

    /// The file was renamed onto its object: nothing to remove.
    pub(crate) fn committed(mut self) {
        self.keep = true;
    }

    /// Removes the file now, a session's included (the rules refused it).
    pub(crate) fn discard(mut self) {
        self.keep = false;
    }
}

impl Drop for StagedFile {
    fn drop(&mut self) {
        if let Some((gauge, bytes)) = self.counted.take() {
            gauge.release(1, bytes);
        }
        if !self.keep {
            // Best effort: the directory is this crate's, and a file that
            // cannot be removed now is an orphan the next open removes.
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

/// Removes every file in `uploads/` that no resumable session names: what a
/// crash mid-upload (or mid-move) left behind. Returns the files and bytes
/// removed.
pub(crate) fn remove_orphans(root: &Path, data: &StorageData) -> (u64, u64) {
    let named = data
        .uploads
        .values()
        .map(|session| root.join(&session.staging_file))
        .collect::<BTreeSet<_>>();
    let Ok(entries) = std::fs::read_dir(root.join("uploads")) else {
        return (0, 0);
    };
    let mut removed = (0_u64, 0_u64);
    for entry in entries.flatten() {
        let path = entry.path();
        if named.contains(&path) {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if metadata.is_file() && std::fs::remove_file(&path).is_ok() {
            removed.0 += 1;
            removed.1 = removed.1.saturating_add(metadata.len());
        }
    }
    removed
}

/// `48 MB`, `1.2 GB`: the size a log line or a console figure prints.
pub(crate) fn format_bytes(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["bytes", "KB", "MB", "GB", "TB"];
    let mut value = bytes;
    let mut unit = 0;
    let mut remainder = 0;
    while value >= 1_000 && unit + 1 < UNITS.len() {
        remainder = value % 1_000;
        value /= 1_000;
        unit += 1;
    }
    if unit == 0 {
        if bytes == 1 {
            "1 byte".to_owned()
        } else {
            format!("{bytes} bytes")
        }
    } else if value < 10 {
        format!("{value}.{} {}", remainder / 100, UNITS[unit])
    } else {
        format!("{value} {}", UNITS[unit])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(root: &Path) -> StorageConfig {
        StorageConfig {
            project: "demo-staging".to_owned(),
            origin: "http://127.0.0.1:1".to_owned(),
            data_dir: root.to_path_buf(),
            rules: None,
            durability: crate::StorageDurability::PerCommit,
        }
    }

    #[test]
    fn paths_are_unique_within_a_microsecond() {
        let config = config(Path::new("/staging-root"));
        let frozen = 1_700_000_000_000_000_000_i128;
        let paths = (0..10_000)
            .map(|_| staging_path_at(&config, "upload", frozen))
            .collect::<BTreeSet<_>>();
        assert_eq!(paths.len(), 10_000);
        assert!(
            paths
                .iter()
                .all(|path| path.starts_with("/staging-root/uploads"))
        );
    }

    #[test]
    fn a_dropped_staged_file_is_removed_and_uncounted() {
        let root = std::env::temp_dir().join(format!(
            "firenook-staged-drop-{}-{}",
            std::process::id(),
            OffsetDateTime::now_utc().unix_timestamp_nanos()
        ));
        std::fs::create_dir_all(root.join("uploads")).unwrap();
        let gauges = StagingGauge::default();
        let path = root.join("uploads/a.part");
        std::fs::write(&path, b"12345").unwrap();
        let mut staged = StagedFile::new(path.clone(), gauges.bucket("b"));
        staged.add(5);
        assert_eq!(gauges.snapshot("b"), (1, 5));
        drop(staged);
        assert_eq!(gauges.snapshot("b"), (0, 0));
        assert!(!path.exists());

        let kept = root.join("uploads/b.part");
        std::fs::write(&kept, b"x").unwrap();
        let mut staged = StagedFile::new(kept.clone(), gauges.bucket("b"));
        staged.add(1);
        staged.committed();
        assert_eq!(gauges.snapshot("b"), (0, 0));
        assert!(kept.exists());

        let session = root.join("uploads/session.part");
        std::fs::write(&session, b"x").unwrap();
        drop(StagedFile::session(session.clone()));
        assert!(session.exists(), "a session keeps its bytes");
        StagedFile::session(session.clone()).discard();
        assert!(!session.exists(), "a refused session's bytes go");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn sizes_read_like_a_console_figure() {
        assert_eq!(format_bytes(0), "0 bytes");
        assert_eq!(format_bytes(1), "1 byte");
        assert_eq!(format_bytes(999), "999 bytes");
        assert_eq!(format_bytes(1_000), "1.0 KB");
        assert_eq!(format_bytes(48_200_000), "48 MB");
        assert_eq!(format_bytes(1_250_000_000), "1.2 GB");
    }
}
