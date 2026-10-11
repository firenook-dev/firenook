//! The handle a console calls: plain Rust over the service's own state, so
//! every read and write shares the real paths, rules and lock discipline.
//! No HTTP types are invented here; the console crate maps these answers to
//! its API.

use std::time::Duration;

use time::OffsetDateTime;
use tokio::sync::broadcast;

use crate::folder_index::{self, FolderIndexError, FolderStats};
use crate::staging::{self, InFlight};
use crate::{ChangeEvent, ObjectChangeRecord, StorageState, known_buckets, lock};

/// The figures the Overview shows for Storage.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct StorageSummaryCounts {
    /// Buckets the console knows: configured, and every one holding objects.
    pub buckets: usize,
    /// Files in every bucket; `None` while the folder index is being built.
    pub objects: Option<u64>,
    /// Their bytes; `None` while the folder index is being built.
    pub bytes: Option<u64>,
}

/// What the console's routes, topics, search, summary and clear call. A
/// cheap clone of the runtime's state.
#[derive(Clone)]
pub struct StorageConsoleApi {
    state: StorageState,
}

impl StorageConsoleApi {
    pub(crate) const fn new(state: StorageState) -> Self {
        Self { state }
    }

    /// The suite runs Functions, so object changes send Storage events.
    #[must_use]
    pub fn functions(&self) -> bool {
        self.state.options.functions
    }

    /// The storage revision: every committed change moved it on by one.
    #[must_use]
    pub fn revision(&self) -> u64 {
        lock(&self.state.inner).revision
    }

    /// Every object change from now on, in commit order.
    #[must_use]
    pub fn subscribe(&self) -> broadcast::Receiver<ChangeEvent> {
        self.state.feed.subscribe()
    }

    /// One object's changes the engine still holds, newest first, and the
    /// time its window starts (the oldest change it holds of any object).
    #[must_use]
    pub fn activity(
        &self,
        bucket: &str,
        name: &str,
    ) -> (Vec<ObjectChangeRecord>, Option<OffsetDateTime>) {
        self.state.feed.activity(bucket, name)
    }

    /// Buckets at once, and objects and bytes once the folder index is built.
    /// The first call starts the index walk; none waits for it.
    #[must_use]
    pub fn summary(&self) -> StorageSummaryCounts {
        folder_index::ensure_built(&self.state);
        let data = lock(&self.state.inner);
        let buckets = known_buckets(&self.state, &data).len();
        match &data.folders {
            Some(index) if index.is_built() => {
                let (objects, bytes) =
                    index
                        .roots()
                        .fold((0_u64, 0_u64), |(objects, bytes), (_, root)| {
                            (objects + root.objects, bytes.saturating_add(root.bytes))
                        });
                StorageSummaryCounts {
                    buckets,
                    objects: Some(objects),
                    bytes: Some(bytes),
                }
            }
            _ => StorageSummaryCounts {
                buckets,
                objects: None,
                bytes: None,
            },
        }
    }

    /// Whether the folder index is built, starting its walk if no console
    /// has yet and waiting up to `wait` for it (zero: never waits). An error
    /// once the walk has failed for good.
    pub async fn folder_index_ready(&self, wait: Duration) -> Result<bool, FolderIndexError> {
        folder_index::ready(&self.state, wait).await
    }

    /// One folder's figures (`prefix` empty for the bucket root, else ending
    /// in `/`); `None` while the index is being built or when nothing is
    /// there.
    #[must_use]
    pub fn folder(&self, bucket: &str, prefix: &str) -> Option<FolderStats> {
        let data = lock(&self.state.inner);
        data.folders
            .as_ref()
            .filter(|index| index.is_built())
            .and_then(|index| index.stats(bucket, prefix))
    }

    /// Bytes staged by uploads still in progress in `bucket`: single
    /// uploads being received and resumable sessions not yet finished.
    #[must_use]
    pub fn in_flight(&self, bucket: &str) -> InFlight {
        let data = lock(&self.state.inner);
        staging::in_flight(&self.state.staging, &data, bucket)
    }
}
