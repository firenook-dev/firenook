//! Storage in the console (the storage stream's module). Owns
//! `/api/v1/storage/...`.
//!
//! The Storage emulator's own HTTP application is mounted at
//! `/storage/native`, sandboxed and told it is reached through the console
//! (`x-forwarded-*`), so the URLs it writes into its answers (an upload's
//! `Location`, `selfLink`, `mediaLink`) continue through the console.

use axum::Router;

use crate::http::forwarded;
use crate::section::{Section, SectionContext, SectionStatus};

/// Where the Storage emulator's application is mounted, as the browser
/// sees it.
pub(crate) const NATIVE_PREFIX: &str = "/console/api/v1/storage/native";

/// Storage's part of the console.
pub struct StorageConsole {
    /// The Storage emulator's own HTTP application.
    pub native: Router,
}

/// The Storage section.
pub(crate) struct StorageSection(pub(crate) StorageConsole);

impl Section for StorageSection {
    fn statuses(&self) -> Vec<SectionStatus> {
        vec![SectionStatus::ready("storage")]
    }

    fn router(&self, _context: &SectionContext) -> Router {
        Router::new().nest(
            "/storage",
            Router::new().nest_service("/native", forwarded(self.0.native.clone(), NATIVE_PREFIX)),
        )
    }
}

/// The storage stream's TypeScript bindings, into `generated/storage/`.
#[cfg(test)]
pub(crate) fn export_bindings(_config: &ts_rs::Config) {}
