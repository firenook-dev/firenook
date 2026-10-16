//! What the running engine reports as its own version.
//!
//! Every crate in this workspace carries a placeholder version, because the
//! product is not released from crates.io: it ships as an npm package whose
//! version is decided by the packaging checkout, and that checkout is a
//! *different* commit from the engine source the binary is built from (the
//! release pins `engineRevision`). So the binary cannot learn its release
//! version at compile time — `CARGO_PKG_VERSION` would report the
//! placeholder, which is worse than silence because it looks like an answer.
//!
//! The distribution that launches the engine knows both facts and passes
//! them in: `FIRENOOK_RELEASE_VERSION` is the version the user installed and
//! `FIRENOOK_ENGINE_REVISION` the engine source it was built from. A binary
//! nobody launched that way — a `cargo run`, a developer's own build — has
//! no release to report and says exactly that.

use std::env;

/// Environment variable carrying the release version of the distribution
/// that launched this engine.
pub const RELEASE_VERSION_VARIABLE: &str = "FIRENOOK_RELEASE_VERSION";
/// Environment variable carrying the engine source commit the binary was
/// built from.
pub const ENGINE_REVISION_VARIABLE: &str = "FIRENOOK_ENGINE_REVISION";

/// Longest release version accepted. Comfortably past the longest the
/// packaging produces (`0.2.0-local.g` plus twelve hex characters).
const VERSION_LIMIT: usize = 64;

/// How this engine identifies itself.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct EngineRelease {
    version: Option<String>,
    revision: Option<String>,
}

impl EngineRelease {
    /// What the launching distribution declared. A value that is not a
    /// plausible version or commit is ignored rather than shown: the
    /// variables reach the console's status document, and a wrong answer
    /// there is worse than an honest absence.
    #[must_use]
    pub fn from_environment() -> Self {
        Self::declared(
            env::var(RELEASE_VERSION_VARIABLE).ok().as_deref(),
            env::var(ENGINE_REVISION_VARIABLE).ok().as_deref(),
        )
    }

    /// The release for explicitly supplied values, validated as
    /// [`Self::from_environment`] validates the environment.
    #[must_use]
    pub fn declared(version: Option<&str>, revision: Option<&str>) -> Self {
        Self {
            version: version.filter(|value| is_version(value)).map(str::to_owned),
            revision: revision
                .filter(|value| is_revision(value))
                .map(str::to_owned),
        }
    }

    /// The release version, when a distribution declared one.
    #[must_use]
    pub fn version(&self) -> Option<&str> {
        self.version.as_deref()
    }

    /// The engine source commit, when a distribution declared one.
    #[must_use]
    pub fn revision(&self) -> Option<&str> {
        self.revision.as_deref()
    }

    /// One line for `--version`, naming what is known and, when the release
    /// is not, where the version actually comes from.
    #[must_use]
    pub fn label(&self) -> String {
        match (&self.version, &self.revision) {
            (Some(version), Some(revision)) => format!("{version} (engine source {revision})"),
            (Some(version), None) => version.clone(),
            (None, Some(revision)) => {
                format!("unreleased build of engine source {revision}")
            }
            (None, None) => {
                "unreleased build (the firenook CLI reports the installed version)".to_owned()
            }
        }
    }
}

/// A plausible release version: short, and made only of the characters npm
/// versions use, so nothing arbitrary reaches the console from a stray
/// environment variable.
fn is_version(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= VERSION_LIMIT
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'+'))
}

/// A full git commit, as the packaging records it.
fn is_revision(value: &str) -> bool {
    value.len() == 40 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;

    const REVISION: &str = "63d554c15f2699cf623c7fac19a4d1393c77f322";

    #[test]
    fn a_declared_release_is_reported_as_declared() {
        let release = EngineRelease::declared(Some("0.2.0-next.2"), Some(REVISION));
        assert_eq!(release.version(), Some("0.2.0-next.2"));
        assert_eq!(release.revision(), Some(REVISION));
        assert_eq!(
            release.label(),
            format!("0.2.0-next.2 (engine source {REVISION})")
        );
    }

    #[test]
    fn a_local_candidate_version_is_accepted() {
        let release = EngineRelease::declared(Some("0.2.0-local.g2f62d31579fe"), None);
        assert_eq!(release.version(), Some("0.2.0-local.g2f62d31579fe"));
        assert_eq!(release.label(), "0.2.0-local.g2f62d31579fe");
    }

    #[test]
    fn nothing_declared_says_so_instead_of_naming_the_placeholder_crate_version() {
        let release = EngineRelease::default();
        assert_eq!(release.version(), None);
        assert_eq!(release.revision(), None);
        assert_eq!(
            release.label(),
            "unreleased build (the firenook CLI reports the installed version)"
        );
        assert!(
            !release.label().contains(env!("CARGO_PKG_VERSION")),
            "the workspace placeholder must never be reported as a version"
        );
    }

    #[test]
    fn an_implausible_declaration_is_ignored_rather_than_shown() {
        let long = "1".repeat(VERSION_LIMIT + 1);
        for version in ["", "0.2.0 next", "0.2.0/../etc", "<b>0.2.0</b>", &long] {
            assert_eq!(
                EngineRelease::declared(Some(version), None).version(),
                None,
                "{version:?}"
            );
        }
        for revision in [
            "",
            "63d554c1",
            &REVISION[1..],
            &format!("{REVISION}0"),
            "zz",
        ] {
            assert_eq!(
                EngineRelease::declared(None, Some(revision)).revision(),
                None,
                "{revision:?}"
            );
        }
    }

    #[test]
    fn a_revision_without_a_version_still_names_the_build() {
        let release = EngineRelease::declared(None, Some(REVISION));
        assert_eq!(
            release.label(),
            format!("unreleased build of engine source {REVISION}")
        );
    }
}
