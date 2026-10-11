//! Authentication in the console (the auth stream's module). Owns
//! `/api/v1/auth/...`.
//!
//! The Auth emulator's own HTTP application (Identity Toolkit, Secure
//! Token, the emulator routes) is the fallback under `/auth`, so the
//! console reaches it same-origin at its usual paths
//! (`/auth/identitytoolkit.googleapis.com/v1/...`). Console-own routes are
//! added beside it and take precedence.

use axum::Router;

use crate::http::forwarded;
use crate::section::{Section, SectionContext, SectionStatus};

/// Where the Auth emulator's application is mounted, as the browser sees it.
pub(crate) const NATIVE_PREFIX: &str = "/console/api/v1/auth";

/// Authentication's part of the console.
pub struct AuthConsole {
    /// The Auth emulator's own HTTP application (Identity Toolkit, the
    /// emulator routes), reachable same-origin as the fallback under `/auth`.
    pub native: Router,
}

/// The Authentication section.
pub(crate) struct AuthSection(pub(crate) AuthConsole);

impl Section for AuthSection {
    fn statuses(&self) -> Vec<SectionStatus> {
        vec![SectionStatus::ready("auth")]
    }

    fn router(&self, _context: &SectionContext) -> Router {
        // The native application is one fallback handler, so it mounts as a
        // service: every path under `/auth` reaches it, prefix stripped.
        Router::new().nest_service("/auth", forwarded(self.0.native.clone(), NATIVE_PREFIX))
    }
}

/// The auth stream's TypeScript bindings, into `generated/auth/`.
#[cfg(test)]
pub(crate) fn export_bindings(_config: &ts_rs::Config) {}
