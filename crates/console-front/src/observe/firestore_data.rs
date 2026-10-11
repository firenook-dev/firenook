//! Firestore's Overview figures (the observe stream fills them in): the
//! Firestore section's [`Section::summary`] delegates here, so the finished
//! Firestore files are not edited for them.
//!
//! [`Section::summary`]: crate::section::Section::summary

use crate::firestore::FirestoreConsole;
use crate::section::SectionSummary;

/// Firestore's documents and databases, for the Overview; `None` until the
/// observe stream counts them.
pub(crate) const fn summary(_firestore: &FirestoreConsole) -> Option<SectionSummary> {
    None
}
