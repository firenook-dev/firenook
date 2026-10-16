//! Storage in the console (the storage stream's module). Owns
//! `/api/v1/storage/...`.
//!
//! The Files page and the Rules page read and change Storage through the
//! service's own console handle (`StorageConsoleApi`), so every listing,
//! write and rules check shares the service's real paths, rules and lock
//! discipline. Live state reaches the pages as three topics on the
//! console's one live channel; bulk work runs as the console's jobs.
//!
//! The Storage emulator's own HTTP application is mounted at
//! `/storage/native`, sandboxed and told it is reached through the console
//! (`x-forwarded-*`), so the URLs it writes into its answers (an upload's
//! `Location`, `selfLink`, `mediaLink`) continue through the console.

mod bulk;
mod decision_feed;
mod errors;
mod files;
mod filter_fields;
mod rules;
mod search;
mod topics;

use std::sync::{Arc, OnceLock};
use std::time::Duration;

use axum::Router;
use axum::routing::{get, post};
use firenook_functions_runtime::Monitor;
use firenook_storage_front::{BulkProgress, ConsoleRefusal, StorageConsoleApi, StorageRulesEvent};
use firenook_suite_front::LoggingRuntime;
use futures_util::future::BoxFuture;
use futures_util::stream::{BoxStream, StreamExt as _};

use crate::api_error::ApiError;
use crate::http::forwarded;
use crate::jobs::JobHandle;
use crate::live::LiveTopic;
use crate::live::badges::{BadgeKind, BadgeNoun, BadgeTone};
use crate::search::SearchSource;
use crate::section::{
    ClearOptions, ClearReport, Section, SectionContext, SectionStatus, SectionSummary,
    SummaryFigure, SummaryUnit,
};

use decision_feed::{DecisionFeed, DecisionsTopic};
use topics::{ObjectsFeed, ObjectsTopic, RulesTopic};

/// Where the Storage emulator's application is mounted, as the browser
/// sees it.
pub(crate) const NATIVE_PREFIX: &str = "/console/api/v1/storage/native";

/// Storage's part of the console.
pub struct StorageConsole {
    /// The Storage emulator's own HTTP application (same-origin at
    /// `/storage/native`).
    pub native: Router,
    /// What the console's routes, topics, search, summary and clear call.
    pub api: StorageConsoleApi,
    /// The suite's log, for the `storage.denied` lines the decision feed
    /// writes.
    pub logging: LoggingRuntime,
    /// The Functions record, in a suite with Functions: Activity names the
    /// invocations a file's events started.
    pub monitor: Option<Monitor>,
    /// The feeds the section starts with its first context.
    feeds: OnceLock<Feeds>,
}

impl StorageConsole {
    /// Storage's console over the service's application, its console
    /// handle and the suite's log.
    #[must_use]
    pub fn new(native: Router, api: StorageConsoleApi, logging: LoggingRuntime) -> Self {
        Self {
            native,
            api,
            logging,
            monitor: None,
            feeds: OnceLock::new(),
        }
    }

    /// The same console, reading the Functions record (`None` without
    /// Functions).
    #[must_use]
    pub fn with_monitor(mut self, monitor: Option<Monitor>) -> Self {
        self.monitor = monitor;
        self
    }
}

/// What the routes share.
#[derive(Clone)]
pub(crate) struct StorageRoutes {
    pub(crate) api: StorageConsoleApi,
    pub(crate) jobs: crate::jobs::JobRegistry,
    /// The decision feed; `None` without diagnostics.
    pub(crate) feed: Option<DecisionFeed>,
    /// The Functions record; `None` without Functions.
    pub(crate) monitor: Option<Monitor>,
}

/// The feeds a section builds once, from the first context it is given.
struct Feeds {
    objects: ObjectsFeed,
    decisions: Option<DecisionFeed>,
}

/// The Storage section.
pub(crate) struct StorageSection(pub(crate) StorageConsole);

impl StorageSection {
    /// The feeds, started with the first context (the router's and the
    /// topics' are the same one).
    fn feeds(&self, context: &SectionContext) -> &Feeds {
        self.0.feeds.get_or_init(|| {
            let rules = self.0.api.rules();
            if let Some(rules) = &rules {
                spawn_rules_badge(rules.clone(), context);
            }
            Feeds {
                objects: ObjectsFeed::new(
                    self.0.api.clone(),
                    &context.rings,
                    context.shutdown.clone(),
                ),
                decisions: DecisionFeed::start(
                    rules.as_ref(),
                    &context.rings,
                    self.0.logging.clone(),
                    context.shutdown.clone(),
                ),
            }
        })
    }
}

/// Keeps the `storage.rules` badge at the number of rules files that do not
/// compile, from now until the suite stops.
fn spawn_rules_badge(rules: firenook_storage_front::StorageRulesHandle, context: &SectionContext) {
    let badge = context.badges.handle(
        "storage.rules",
        BadgeKind::Gauge,
        BadgeNoun::new(
            "Storage rules file does not compile",
            "Storage rules files do not compile",
        ),
    );
    let publish = move |rules: &firenook_storage_front::StorageRulesHandle| {
        let broken = rules
            .scopes()
            .iter()
            .filter(|scope| !rules.file_problems(scope).is_empty())
            .count();
        let broken = u64::try_from(broken).unwrap_or(u64::MAX);
        badge.set(
            broken,
            if broken == 0 {
                BadgeTone::Neutral
            } else {
                BadgeTone::Danger
            },
        );
    };
    let mut events = rules.subscribe();
    publish(&rules);
    let stopped = context.shutdown.clone().stopped();
    tokio::spawn(async move {
        tokio::pin!(stopped);
        loop {
            tokio::select! {
                biased;
                () = &mut stopped => return,
                event = events.recv() => match event {
                    Ok(StorageRulesEvent::FileChecked { .. })
                    | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => publish(&rules),
                    Ok(_) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
                },
            }
        }
    });
}

/// A clear's progress, reported to the suite's clear job.
struct ClearProgress {
    job: JobHandle,
    done: std::sync::atomic::AtomicU64,
}

impl BulkProgress for ClearProgress {
    fn done(&self, by: u64) {
        let done = self.done.fetch_add(by, std::sync::atomic::Ordering::AcqRel) + by;
        self.job.progress(done);
    }

    fn skipped(&self, _by: u64) {}

    fn failed(&self, name: &str, message: &str, _refusal: Option<&ConsoleRefusal>) {
        self.job.failed_item(name, message);
    }

    fn cancelled(&self) -> bool {
        self.job.cancelled()
    }
}

impl Section for StorageSection {
    fn statuses(&self) -> Vec<SectionStatus> {
        vec![SectionStatus::ready("storage")]
    }

    fn status_changes(&self) -> Option<BoxStream<'static, ()>> {
        // The folder index finishing, and counts moving (every change the
        // service announces moves one, and so does a window lost to lag):
        // at most one tick every 500 ms.
        let receiver = self.0.api.subscribe();
        Some(
            futures_util::stream::unfold(receiver, |mut receiver| async move {
                if let Err(tokio::sync::broadcast::error::RecvError::Closed) = receiver.recv().await
                {
                    return None;
                }
                tokio::time::sleep(Duration::from_millis(500)).await;
                // What arrived meanwhile is in the counts the tick reads.
                while receiver.try_recv().is_ok() {}
                Some(((), receiver))
            })
            .boxed(),
        )
    }

    fn router(&self, context: &SectionContext) -> Router {
        let feeds = self.feeds(context);
        let routes = StorageRoutes {
            api: self.0.api.clone(),
            jobs: context.jobs.clone(),
            feed: feeds.decisions.clone(),
            monitor: self.0.monitor.clone(),
        };
        let api = Router::new()
            .route("/buckets", get(files::buckets))
            .route("/objects", get(files::objects))
            .route("/objects/meta", get(files::objects_meta))
            .route("/objects:batchGet", post(files::batch_get))
            .route("/objects:exists", post(files::exists))
            .route("/objects:delete", post(bulk::delete))
            .route("/objects:move", post(bulk::relocate))
            .route("/objects:copy", post(bulk::copy))
            .route("/objects:metadata", post(bulk::metadata))
            .route(
                "/objects:export",
                post(files::export_ticket).get(files::export_stream),
            )
            .route("/folder", get(files::folder))
            .route("/folder/profile", get(files::profile))
            .route("/folders", post(files::create_folder))
            .route(
                "/object",
                get(files::object)
                    .put(files::upload)
                    .delete(files::delete_object),
            )
            .route("/object/metadata", post(files::update_metadata))
            .route("/object/token", post(files::token))
            .route("/object/resend", post(files::resend))
            .route("/object/media", get(files::media))
            .route("/object/thumbnail", get(files::thumbnail))
            .route("/object/activity", get(files::activity))
            .route("/object/events", get(files::events))
            .route("/rules", get(rules::read_rules).put(rules::write_rules))
            .route("/rules/check", post(rules::check_rules))
            .route("/rules/history", get(rules::rules_history))
            .route("/rules/evaluate", post(rules::evaluate))
            .route("/rules/decisions/{id}", get(rules::decision))
            .route("/rules/impact", post(rules::impact))
            .route("/rules/coverage", get(rules::coverage))
            .route("/rules/access", post(rules::access))
            .with_state(routes)
            .nest_service("/native", forwarded(self.0.native.clone(), NATIVE_PREFIX));
        Router::new().nest("/storage", api)
    }

    fn topics(&self, context: &SectionContext) -> Vec<Arc<dyn LiveTopic>> {
        let feeds = self.feeds(context);
        let mut topics: Vec<Arc<dyn LiveTopic>> =
            vec![Arc::new(ObjectsTopic(feeds.objects.clone()))];
        if let Some(rules) = self.0.api.rules() {
            topics.push(Arc::new(RulesTopic {
                rules,
                default_bucket: self.0.api.default_bucket(),
            }));
        }
        if let Some(decisions) = &feeds.decisions {
            topics.push(Arc::new(DecisionsTopic(decisions.clone())));
        }
        topics
    }

    fn search(&self, _context: &SectionContext) -> Option<Arc<dyn SearchSource>> {
        Some(Arc::new(search::StorageSearch(self.0.api.clone())))
    }

    fn summary(&self, _id: &str) -> Option<SectionSummary> {
        let counts = self.0.api.summary();
        let buckets = u64::try_from(counts.buckets).unwrap_or(u64::MAX);
        let bucket_text = format!(
            "{} {}",
            bulk::count(buckets),
            if buckets == 1 { "bucket" } else { "buckets" }
        );
        let headline = match counts.objects.zip(counts.bytes) {
            Some((objects, bytes)) => format!(
                "{} {} · {} in {bucket_text}",
                bulk::count(objects),
                if objects == 1 { "object" } else { "objects" },
                bulk::size(bytes)
            ),
            None => format!("{bucket_text} · counting objects…"),
        };
        Some(SectionSummary {
            headline,
            figures: vec![
                SummaryFigure {
                    label: "Objects".to_owned(),
                    value: counts.objects,
                    unit: SummaryUnit::Count,
                },
                SummaryFigure {
                    label: "Stored".to_owned(),
                    value: counts.bytes,
                    unit: SummaryUnit::Bytes,
                },
                SummaryFigure {
                    label: "Buckets".to_owned(),
                    value: Some(buckets),
                    unit: SummaryUnit::Count,
                },
            ],
        })
    }

    fn clear(
        &self,
        _id: &str,
        job: JobHandle,
        _options: ClearOptions,
    ) -> Option<BoxFuture<'static, Result<ClearReport, ApiError>>> {
        // `/internal/reset` semantics: no Storage event, whatever
        // `runTriggers` says (a per-bucket empty is a delete job, which
        // does send them).
        let api = self.0.api.clone();
        Some(Box::pin(async move {
            let progress = ClearProgress {
                job,
                done: std::sync::atomic::AtomicU64::new(0),
            };
            let removed = api.clear_all(&progress).await?;
            Ok(ClearReport {
                section: "storage".to_owned(),
                removed,
            })
        }))
    }
}

/// The storage stream's TypeScript bindings, into `generated/storage/`.
#[cfg(test)]
pub(crate) fn export_bindings(config: &ts_rs::Config) {
    use ts_rs::TS as _;
    macro_rules! export {
        ($($name:ty),* $(,)?) => {
            $(<$name>::export_all(config).expect("TypeScript bindings written");)*
        };
    }
    export!(
        files::StorageRulesMode,
        files::StorageBuckets,
        files::StorageBucket,
        files::StorageInFlight,
        files::StorageListKind,
        files::StorageListPage,
        files::StorageListTotals,
        files::StorageEntry,
        files::StorageFolderEntry,
        files::StorageFileEntry,
        files::StorageFolder,
        files::StorageObjectDetail,
        files::StorageSniffed,
        files::StorageSniffFamily,
        files::StorageMetadataPatch,
        files::StorageUpdateObjectBody,
        files::StorageTokenBody,
        files::StorageTokenAction,
        files::StorageCreateFolderBody,
        files::StorageDeleteObjectBody,
        files::StorageExistsBody,
        files::StorageExistsResult,
        files::StorageActor,
        files::StorageActorKind,
        files::StorageEventDelivery,
        files::StorageObjectChange,
        files::StorageObjectChangeKind,
        files::StorageBatchGetRequest,
        files::StorageActivity,
        files::StorageEventPayloads,
        files::StorageEventBodies,
        files::StorageResendEventBody,
        files::StorageResendEvent,
        files::StorageResendResult,
        files::StorageProfile,
        files::StorageContentTypeCount,
        files::StorageExportBody,
        files::StorageExportTicket,
        bulk::StorageBulkBody,
        bulk::StorageDestination,
        bulk::StorageConflictPolicy,
        bulk::StorageBulkPreview,
        bulk::StorageBulkItemError,
        topics::StorageObjectsParams,
        topics::StorageObjectsChanged,
        topics::StorageObjectTouch,
        topics::StorageRulesParams,
        topics::StorageRulesChanged,
        topics::StorageRulesFileStatus,
        decision_feed::StorageDecisionsParams,
        decision_feed::StorageDecisionBatch,
        decision_feed::StorageDecisionWindow,
        rules::StorageRulesDocument,
        rules::StorageRulesWrite,
        rules::StorageRulesInstalled,
        rules::StorageRulesCheckBody,
        rules::StorageRulesCheck,
        rules::StorageRulesMap,
        rules::StorageFolderRules,
        rules::StorageProposedObject,
        rules::StorageEvaluateRequest,
        rules::StorageRecordedObject,
        rules::StorageRulesObjectView,
        rules::StorageEvaluateBody,
        rules::StorageEvaluateResult,
        rules::StorageRulesEvaluation,
        rules::StorageDecision,
        rules::StorageDecisionDetail,
        rules::StorageImpactBody,
        rules::StorageRulesImpact,
        rules::StorageImpactFlip,
        rules::StorageAccessBody,
        rules::StorageAccess,
        rules::StorageAccessResult,
        rules::StorageAccessVerdict,
    );
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;

#[cfg(test)]
pub(crate) use tests::router_console;
