//! Every console section, and what the console says about each.
//!
//! A stream's part of the console is one [`Section`] in its own directory
//! (`auth/`, `storage/`, `compute/`, `messaging/`, `observe/`); `lib.rs`
//! assembles them, so a stream fills in its own module and never edits the
//! shared files. The status lists every sidebar section in one order —
//! `console/src/lib/section-order.json`, which the client sorts its
//! registry by too — with whether it can be used now and, when it cannot,
//! why and how to turn it on.

use std::sync::Arc;

use axum::Router;
use firenook_suite_front::RingBudget;
use futures_util::future::BoxFuture;
use futures_util::stream::BoxStream;
use serde::Serialize;
use ts_rs::TS;

use crate::api_error::ApiError;
use crate::foreign::ForeignProjects;
use crate::instance::Instance;
use crate::jobs::{JobHandle, JobRegistry};
use crate::live::LiveTopic;
use crate::live::badges::BadgeBoard;
use crate::search::SearchSource;
use crate::sse::Shutdown;

/// The sidebar's sections in their one canonical order, read from the file
/// the client sorts its registry by.
pub(crate) const SECTION_ORDER_JSON: &str =
    include_str!("../../../console/src/lib/section-order.json");

/// The section ids in sidebar order.
pub(crate) fn section_order() -> &'static [String] {
    static ORDER: std::sync::OnceLock<Vec<String>> = std::sync::OnceLock::new();
    ORDER.get_or_init(|| {
        // The file is part of this crate's source; a malformed one fails
        // the crate's tests, never a running engine's requests.
        serde_json::from_str(SECTION_ORDER_JSON).unwrap_or_default()
    })
}

/// Where `id` sits in the sidebar; unknown ids sort last.
pub(crate) fn section_rank(id: &str) -> usize {
    section_order()
        .iter()
        .position(|known| known == id)
        .unwrap_or(usize::MAX)
}

/// A section's label, as the sidebar names it.
pub(crate) fn section_label(id: &str) -> &str {
    match id {
        "firestore" => "Firestore",
        "auth" => "Authentication",
        "storage" => "Storage",
        "functions" => "Functions",
        "extensions" => "Extensions",
        "eventarc" => "Eventarc",
        "pubsub" => "Pub/Sub",
        "tasks" => "Cloud Tasks",
        "logs" => "Logs",
        other => other,
    }
}

/// The service an engine must run for section `id` to exist: Eventarc,
/// Extensions and Cloud Tasks come with Functions.
pub(crate) fn section_service(id: &str) -> &str {
    match id {
        "extensions" | "eventarc" | "tasks" => "Functions",
        other => section_label(other),
    }
}

/// What every section module is given.
#[derive(Clone)]
#[allow(
    dead_code,
    reason = "the section streams read the project, the instance and the foreign-project recorder"
)]
pub(crate) struct SectionContext {
    /// The configured project id.
    pub(crate) project: Arc<str>,
    /// Every stream a section opens ends on it.
    pub(crate) shutdown: Shutdown,
    /// Where the section publishes its navigation badges.
    pub(crate) badges: BadgeBoard,
    /// This engine run (its cursors' epoch).
    pub(crate) instance: Instance,
    /// Where the section starts its bulk work.
    pub(crate) jobs: JobRegistry,
    /// The process's ring budget, for a section's own feeds.
    pub(crate) rings: RingBudget,
    /// Project ids requests named that are not the configured one.
    pub(crate) foreign: ForeignProjects,
}

/// One stream's part of the console.
pub(crate) trait Section: Send + Sync + 'static {
    /// The sidebar sections this module answers for, as they are now.
    fn statuses(&self) -> Vec<SectionStatus>;
    /// Ticks when `statuses` or `summary` may have changed (a late service
    /// became ready, counts moved). A section ticks at most every 500 ms
    /// while its counts change.
    fn status_changes(&self) -> Option<BoxStream<'static, ()>> {
        None
    }
    /// Routes under `/api/v1`, every path carrying the section's own prefix.
    fn router(&self, context: &SectionContext) -> Router;
    /// Live topics this section publishes.
    fn topics(&self, _context: &SectionContext) -> Vec<Arc<dyn LiveTopic>> {
        Vec::new()
    }
    /// What ⌘K finds here (`GET /search`).
    fn search(&self, _context: &SectionContext) -> Option<Arc<dyn SearchSource>> {
        None
    }
    /// Counts and a headline for sidebar section `id` (one this module
    /// answers for), for the Overview and the nav tooltip. Cheap: counters
    /// the section keeps anyway. Asked only while `id` is ready.
    fn summary(&self, _id: &str) -> Option<SectionSummary> {
        None
    }
    /// Removes everything sidebar section `id` holds (`POST /suite/clear`),
    /// reporting progress to `job` and checking `job.cancelled()` between
    /// batches. `None`: the section cannot be cleared. Building the future
    /// does no work; the clear starts when the job polls it.
    fn clear(
        &self,
        _id: &str,
        _job: JobHandle,
        _options: ClearOptions,
    ) -> Option<BoxFuture<'static, Result<ClearReport, ApiError>>> {
        None
    }
}

/// How a clear runs.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct ClearOptions {
    /// Deliver the triggers the removals would fire (`runTriggers`); off by
    /// default, so a reset does not set off every function that listens.
    pub(crate) run_triggers: bool,
}

/// What a clear removed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
pub struct ClearReport {
    /// The section id.
    pub section: String,
    /// Documents, users, objects, messages or tasks removed.
    #[ts(type = "number")]
    pub removed: u64,
}

/// One sidebar section and whether it can be used now.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SectionStatus {
    /// The section id, which is also the first segment of its console route:
    /// `firestore`, `auth`, `storage`, `functions`, `extensions`, `eventarc`,
    /// `pubsub`, `tasks` or `logs`.
    pub id: String,
    pub state: SectionState,
    /// Why it is absent; `null` unless `state` is `absent`.
    pub reason: Option<AbsentKind>,
    /// One sentence: why it is absent, or what it is waiting for.
    pub detail: Option<String>,
    /// What to do to turn it on, each shown as a labelled copyable block.
    pub fixes: Vec<SectionFix>,
    /// Counts and a headline for the Overview and the nav tooltip, when the
    /// section is ready.
    pub summary: Option<SectionSummary>,
}

impl SectionStatus {
    /// Section `id`, serving.
    pub(crate) fn ready(id: &str) -> Self {
        Self {
            id: id.to_owned(),
            state: SectionState::Ready,
            reason: None,
            detail: None,
            fixes: Vec::new(),
            summary: None,
        }
    }

    /// Section `id`, whose service is still starting; `detail` says what it
    /// waits for.
    pub(crate) fn starting(id: &str, detail: impl Into<String>) -> Self {
        Self {
            state: SectionState::Starting,
            detail: Some(detail.into()),
            ..Self::ready(id)
        }
    }

    /// Section `id`, not part of this suite, for `reason`.
    pub(crate) fn absent(id: &str, reason: &AbsentReason) -> Self {
        Self {
            state: SectionState::Absent,
            reason: Some(reason.kind),
            detail: Some(reason.detail.clone()),
            fixes: reason.fixes.clone(),
            ..Self::ready(id)
        }
    }
}

/// Whether a section can be used.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum SectionState {
    /// Serving.
    Ready,
    /// Its service is still starting; routes answer `starting` until it is up.
    Starting,
    /// Its service is not part of this suite.
    Absent,
}

/// Why a section is not part of this suite.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum AbsentKind {
    /// firebase.json does not configure the service.
    NotConfigured,
    /// The developer's `--only` left it out.
    ExcludedByOnly,
    /// It follows another service that is absent (Eventarc, Extensions and
    /// Cloud Tasks follow Functions).
    Requires,
    /// Started without a launch context (the engine run directly): the
    /// engine knows the service is off but not why.
    Unknown,
}

/// One way to turn a section on.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SectionFix {
    /// "Add it to firebase.json", "Start with Storage".
    pub label: String,
    pub kind: SectionFixKind,
    /// The snippet or the command, copied as is.
    pub text: String,
}

/// What a fix's text is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum SectionFixKind {
    /// A command line to run.
    Command,
    /// Keys to add to firebase.json.
    FirebaseJson,
}

/// Why a section is not part of this suite, as the suite knows it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AbsentReason {
    pub kind: AbsentKind,
    /// One sentence.
    pub detail: String,
    pub fixes: Vec<SectionFix>,
}

impl AbsentReason {
    /// The generic reason for a section the engine runs without and whose
    /// cause it does not know: "This engine was started without Storage."
    #[must_use]
    pub fn unknown(id: &str) -> Self {
        Self {
            kind: AbsentKind::Unknown,
            detail: format!("This engine was started without {}.", section_label(id)),
            fixes: Vec::new(),
        }
    }
}

/// What the Overview shows for one section.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
pub struct SectionSummary {
    /// "1,204 users · 3 tenants".
    pub headline: String,
    pub figures: Vec<SummaryFigure>,
}

/// One number of a section's summary.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
pub struct SummaryFigure {
    pub label: String,
    /// `null` while the section cannot count it cheaply yet (Storage's
    /// buckets while its folder index builds).
    #[ts(type = "number | null")]
    pub value: Option<u64>,
    /// How the console formats the number.
    pub unit: SummaryUnit,
}

/// How a summary figure is formatted.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum SummaryUnit {
    /// A plain count: "1,204".
    Count,
    /// A size in bytes: "1.2 GB".
    Bytes,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_order_file_names_every_section_once_in_sidebar_order() {
        let order: Vec<&str> = section_order().iter().map(String::as_str).collect();
        assert_eq!(
            order,
            [
                "firestore",
                "auth",
                "storage",
                "functions",
                "extensions",
                "pubsub",
                "eventarc",
                "tasks",
                "logs"
            ]
        );
        assert!(section_rank("firestore") < section_rank("logs"));
        assert_eq!(section_rank("nothing"), usize::MAX);
        for id in &order {
            assert_ne!(section_label(id), *id, "{id} has a label");
        }
        assert_eq!(section_service("tasks"), "Functions");
        assert_eq!(section_service("pubsub"), "Pub/Sub");
    }

    #[test]
    fn statuses_say_why_and_how() {
        let absent = SectionStatus::absent("storage", &AbsentReason::unknown("storage"));
        let json = serde_json::to_value(&absent).expect("json");
        assert_eq!(json["state"], "absent");
        assert_eq!(json["reason"], "unknown");
        assert_eq!(json["detail"], "This engine was started without Storage.");
        assert_eq!(json["fixes"], serde_json::json!([]));
        assert_eq!(json["summary"], serde_json::Value::Null);
        let starting = SectionStatus::starting("functions", "Discovering functions…");
        assert_eq!(starting.state, SectionState::Starting);
        assert_eq!(starting.reason, None);
        let fix = SectionFix {
            label: "Add it to firebase.json".to_owned(),
            kind: SectionFixKind::FirebaseJson,
            text: "\"emulators\": { \"auth\": {} }".to_owned(),
        };
        assert_eq!(
            serde_json::to_value(&fix).expect("json")["kind"],
            "firebase-json"
        );
    }
}
