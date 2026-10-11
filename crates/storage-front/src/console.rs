//! The handle a console calls: plain Rust over the service's own state, so
//! every read and write shares the real paths, rules and lock discipline.
//! No HTTP types are invented here; the console crate maps these answers to
//! its API.

use crate::staging::{self, InFlight};
use crate::{StorageState, lock};

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

    /// Bytes staged by uploads still in progress in `bucket`: single
    /// uploads being received and resumable sessions not yet finished.
    #[must_use]
    pub fn in_flight(&self, bucket: &str) -> InFlight {
        let data = lock(&self.state.inner);
        staging::in_flight(&self.state.staging, &data, bucket)
    }
}
