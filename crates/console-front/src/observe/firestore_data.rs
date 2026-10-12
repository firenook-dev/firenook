//! Firestore's Overview figures and its reset (the observe stream fills
//! them in): the Firestore section's [`Section::summary`] and
//! [`Section::clear`] delegate here, so the finished Firestore files are not
//! edited for them.
//!
//! [`Section::summary`]: crate::section::Section::summary
//! [`Section::clear`]: crate::section::Section::clear

use futures_util::future::BoxFuture;

use crate::api_error::ApiError;
use crate::firestore::FirestoreConsole;
use crate::jobs::JobHandle;
use crate::section::{ClearOptions, ClearReport, SectionSummary};

/// Firestore's documents and databases, for the Overview; `None` until the
/// observe stream counts them.
pub(crate) const fn summary(_firestore: &FirestoreConsole) -> Option<SectionSummary> {
    None
}

/// Removes every document of every database, for `POST /suite/clear`;
/// `None` until the observe stream implements it.
pub(crate) fn clear(
    _firestore: &FirestoreConsole,
    _job: JobHandle,
    _options: ClearOptions,
) -> Option<BoxFuture<'static, Result<ClearReport, ApiError>>> {
    None
}
