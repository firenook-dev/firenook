//! The handle a console calls: plain Rust over the service's own state, so
//! every read and write shares the real paths, rules and lock discipline.
//! No HTTP types are invented here; the console crate maps these answers to
//! its API.

use time::OffsetDateTime;
use tokio::sync::broadcast;

use crate::staging::{self, InFlight};
use crate::{ChangeEvent, ObjectChangeRecord, StorageState, lock};

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

    /// Bytes staged by uploads still in progress in `bucket`: single
    /// uploads being received and resumable sessions not yet finished.
    #[must_use]
    pub fn in_flight(&self, bucket: &str) -> InFlight {
        let data = lock(&self.state.inner);
        staging::in_flight(&self.state.staging, &data, bucket)
    }
}
