//! Authentication in the console (the auth stream's module). Owns
//! `/api/v1/auth/...`.
//!
//! The Auth emulator's own HTTP application (Identity Toolkit, Secure
//! Token, the emulator routes) is the fallback under `/auth`, so the
//! console reaches it same-origin at its usual paths
//! (`/auth/identitytoolkit.googleapis.com/v1/...`). Console-own routes are
//! added beside it and take precedence: the identity search
//! (`identities.rs`) and the token minting (`tokens.rs`), which the
//! foundation built for every section's identity picker.

mod identities;
mod tokens;

use axum::Router;
use axum::routing::{get, post};

use crate::http::forwarded;
use crate::section::{Section, SectionContext, SectionStatus};

pub use identities::IdentityUser;
pub use tokens::{AuthToken, AuthTokenRequest};

/// Where the Auth emulator's application is mounted, as the browser sees it.
pub(crate) const NATIVE_PREFIX: &str = "/console/api/v1/auth";

/// The Auth emulator's own paths under `/api/v1/auth`: its readiness page
/// at the root is a GET, and everything else it serves is under these. The
/// request guard treats only these as the emulator's (its own semantics);
/// every other path under `/auth` is a console route.
pub(crate) const NATIVE_PATHS: [&str; 4] = [
    "/identitytoolkit.googleapis.com",
    "/securetoken.googleapis.com",
    "/www.googleapis.com",
    "/emulator",
];

/// Authentication's part of the console.
pub struct AuthConsole {
    /// The Auth emulator's own HTTP application (Identity Toolkit, the
    /// emulator routes), reachable same-origin as the fallback under `/auth`.
    pub native: Router,
    /// The emulator's state, for console-own reads and writes (the identity
    /// search, minted tokens).
    pub runtime: firenook_auth_front::Runtime,
}

/// The Authentication section.
pub(crate) struct AuthSection(pub(crate) AuthConsole);

impl Section for AuthSection {
    fn statuses(&self) -> Vec<SectionStatus> {
        vec![SectionStatus::ready("auth")]
    }

    fn router(&self, _context: &SectionContext) -> Router {
        // Mounted as one service, so every path under `/auth` arrives with
        // the prefix stripped: the console's own routes first, and the
        // native application (one fallback handler) for everything else.
        Router::new().nest_service(
            "/auth",
            Router::new()
                .route("/identities", get(identities::search))
                .route("/tokens", post(tokens::mint))
                .with_state(self.0.runtime.clone())
                .fallback_service(forwarded(self.0.native.clone(), NATIVE_PREFIX)),
        )
    }
}

/// The auth stream's TypeScript bindings, into `generated/auth/` (and the
/// foundation's identity types).
#[cfg(test)]
pub(crate) fn export_bindings(config: &ts_rs::Config) {
    use ts_rs::TS as _;
    IdentityUser::export_all(config).expect("TypeScript bindings written");
    AuthTokenRequest::export_all(config).expect("TypeScript bindings written");
    AuthToken::export_all(config).expect("TypeScript bindings written");
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
