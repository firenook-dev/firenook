//! Bulk work: one engine mechanism for every long action, so no section
//! deletes 100,000 users 500 at a time from the browser, assembles a large
//! download in browser memory, or polls for progress.
//!
//! A section's route `POST /<section>/<things>:<verb>` starts a job with
//! [`JobRegistry::start`] and answers `202` with the [`Job`] at once; the
//! work reports through its [`JobHandle`] and checks `cancelled()` between
//! batches. The `jobs` topic pushes each job's state (at most four times a
//! second per job, and always its final state) from a ring of job states,
//! so a reconnecting tab catches up; `GET /jobs?section=` lists running jobs
//! and those finished in the last ten minutes, so a reloaded page
//! re-attaches; `POST /jobs/{id}/cancel` stops one. While a section has a
//! job running, its `<section>.jobs` badge says so. At most four jobs run
//! per section and one for the suite (`suite.*`); the next is `409
//! conflict`. The suite's stop cancels every job and waits for it to reach
//! its next check.

use std::collections::{BTreeMap, VecDeque};
use std::panic::AssertUnwindSafe;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::Duration;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use firenook_suite_front::replay::random_epoch;
use firenook_suite_front::{Cursor, Entry, ReplayRing, RingBudget, RingLimits};
use futures_util::FutureExt as _;
use futures_util::future::BoxFuture;
use futures_util::stream::{self, StreamExt as _};
use serde::{Deserialize, Serialize};
use tokio::sync::{Notify, broadcast};
use tokio::task::JoinHandle;
use tokio::time::Instant;
use ts_rs::TS;

use crate::api_error::ApiError;
use crate::instance::random_id;
use crate::json::ConsoleJson;
use crate::live::badges::{BadgeBoard, BadgeHandle, BadgeKind, BadgeNoun, BadgeTone};
use crate::live::{LiveTopic, ResetReason, TopicEvent, TopicStream, topic_params};
use crate::section::section_label;
use crate::sse::Shutdown;
use crate::time::rfc3339_now;

/// What a bulk action applies to: named rows, or every row a filter
/// matches, so "Select all 48,213 matching" never sends 48,213 ids.
#[derive(Clone, Debug, PartialEq, Deserialize, TS)]
#[serde(rename_all = "camelCase", tag = "by")]
pub enum BulkTarget {
    /// These rows, by key; at most 10,000.
    Keys { keys: Vec<String> },
    /// Every row the list route answers for `q` within `scope`: the list
    /// route's own params as JSON (`{ "bucket", "prefix" }`, `{ "tenant" }`),
    /// read by the section into its own params type.
    Query {
        q: String,
        #[ts(type = "Record<string, unknown>")]
        #[serde(default)]
        scope: serde_json::Value,
    },
}

impl BulkTarget {
    /// The most keys one target names.
    pub const MAX_KEYS: usize = 10_000;

    /// Refuses a target over the limit.
    pub fn check(&self) -> Result<(), ApiError> {
        match self {
            Self::Keys { keys } if keys.len() > Self::MAX_KEYS => Err(ApiError::invalid(format!(
                "A bulk action names at most {} rows; this one names {}.",
                Self::MAX_KEYS,
                keys.len()
            ))
            .with_fix("Select every matching row instead, which sends the filter, not the keys.")),
            Self::Keys { .. } | Self::Query { .. } => Ok(()),
        }
    }
}

/// One piece of bulk work and how far it got.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    /// `auth.delete-users`, `storage.move`, `suite.clear`.
    pub kind: String,
    /// The section the job belongs to, or `suite`.
    pub section: String,
    /// One line: "Delete 1,204 users".
    pub title: String,
    /// How many items it will go through, when known.
    #[ts(type = "number | null")]
    pub total: Option<u64>,
    #[ts(type = "number")]
    pub done: u64,
    /// Items passed over on purpose (already in the wanted state, or
    /// excluded by the verb's own rule), counted apart from failures.
    #[ts(type = "number")]
    pub skipped: u64,
    /// The first 20 failures, each with the key and why.
    pub errors: Vec<JobError>,
    /// Every failure, counted.
    #[ts(type = "number")]
    pub error_count: u64,
    pub state: JobState,
    /// RFC 3339.
    pub started_at: String,
    /// RFC 3339, once it finished.
    pub finished_at: Option<String>,
    /// Why it failed or stopped, when it did: "The engine stopped."
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub message: Option<String>,
    /// What it produced, when that is more than its counts (a suite clear's
    /// `ClearReport` per section).
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "unknown")]
    pub result: Option<serde_json::Value>,
}

/// Where a job is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum JobState {
    Running,
    Done,
    Failed,
    Cancelled,
}

/// One item a job could not do.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
pub struct JobError {
    pub key: String,
    pub message: String,
    /// The section's own detail for this item (Storage puts the rules
    /// decision and its explained re-run here).
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "unknown")]
    pub detail: Option<serde_json::Value>,
}

/// `GET /jobs?section=`.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
pub struct JobList {
    /// Running jobs and those finished in the last ten minutes, oldest
    /// first.
    pub jobs: Vec<Job>,
}

/// Jobs one section may run at once.
const PER_SECTION: usize = 4;
/// Suite jobs (`suite.*`) that may run at once.
const PER_SUITE: usize = 1;
/// How long a finished job is kept.
const KEEP_FINISHED: Duration = Duration::from_mins(10);
/// Finished jobs kept at most.
const MAX_FINISHED: usize = 100;
/// Failures a job reports one by one.
const MAX_ERRORS: usize = 20;
/// The shortest gap between two pushed states of one job.
const PUSH_EVERY: Duration = Duration::from_millis(250);
/// How long the stop waits for jobs to reach their next check.
const STOP_GRACE: Duration = Duration::from_secs(10);
/// The job-state ring: 1,000 states, 4 MiB.
const RING_LIMITS: RingLimits = RingLimits {
    entries: 1_000,
    bytes: 4 * 1024 * 1024,
    floor: 64,
};
/// The section suite-wide jobs belong to.
const SUITE: &str = "suite";

/// What a job's work reports through. Cheap to clone; every clone reports
/// to the same job.
#[derive(Clone)]
pub(crate) struct JobHandle {
    shared: Arc<JobShared>,
    /// Added to every `progress` this handle reports: a part of a larger job
    /// (one section of a suite clear) counts from where the others left off.
    offset: Arc<AtomicU64>,
}

#[allow(
    dead_code,
    reason = "the section streams report their bulk work through every method"
)]
impl JobHandle {
    /// `done` items so far (counted from this handle's start).
    pub(crate) fn progress(&self, done: u64) {
        self.shared.done.store(
            self.offset.load(Ordering::Acquire) + done,
            Ordering::Release,
        );
        self.shared.dirty.notify_one();
    }

    /// `by` more items passed over on purpose.
    pub(crate) fn skipped(&self, by: u64) {
        self.shared.skipped.fetch_add(by, Ordering::AcqRel);
        self.shared.dirty.notify_one();
    }

    /// The total became known.
    pub(crate) fn set_total(&self, total: u64) {
        self.shared.total.store(total, Ordering::Release);
        self.shared.dirty.notify_one();
    }

    /// One item failed.
    pub(crate) fn failed_item(&self, key: &str, message: impl Into<String>) {
        self.record_error(key, message.into(), None);
    }

    /// One item failed, with the section's own detail.
    pub(crate) fn failed_item_with(
        &self,
        key: &str,
        message: impl Into<String>,
        detail: serde_json::Value,
    ) {
        self.record_error(key, message.into(), Some(detail));
    }

    fn record_error(&self, key: &str, message: String, detail: Option<serde_json::Value>) {
        {
            let mut errors = lock(&self.shared.errors);
            errors.count += 1;
            if errors.first.len() < MAX_ERRORS {
                errors.first.push(JobError {
                    key: key.to_owned(),
                    message,
                    detail,
                });
            }
        }
        self.shared.dirty.notify_one();
    }

    /// What the job produced, shown with its final state.
    pub(crate) fn set_result(&self, result: serde_json::Value) {
        lock(&self.shared.outcome).result = Some(result);
    }

    /// Whether the job was cancelled (by the person or the suite's stop).
    /// Checked between batches; the work then returns.
    pub(crate) fn cancelled(&self) -> bool {
        self.shared.cancel.load(Ordering::Acquire)
    }

    /// A handle on the same job whose progress counts from `offset`, set
    /// later with [`JobHandle::start_at`].
    pub(crate) fn part(&self) -> Self {
        Self {
            shared: Arc::clone(&self.shared),
            offset: Arc::new(AtomicU64::new(0)),
        }
    }

    /// This part's progress now counts from `offset`.
    pub(crate) fn start_at(&self, offset: u64) {
        self.offset.store(offset, Ordering::Release);
    }

    /// Items done so far, across every part.
    pub(crate) fn done(&self) -> u64 {
        self.shared.done.load(Ordering::Acquire)
    }
}

/// One job's live state, written by its work and read by the registry.
struct JobShared {
    id: String,
    kind: String,
    section: String,
    title: String,
    started_at: String,
    /// `u64::MAX` while unknown.
    total: AtomicU64,
    done: AtomicU64,
    skipped: AtomicU64,
    errors: Mutex<Errors>,
    cancel: AtomicBool,
    /// Something changed since the last pushed state.
    dirty: Notify,
    outcome: Mutex<Outcome>,
}

#[derive(Default)]
struct Errors {
    first: Vec<JobError>,
    count: u64,
}

struct Outcome {
    state: JobState,
    finished_at: Option<String>,
    message: Option<String>,
    result: Option<serde_json::Value>,
}

impl JobShared {
    fn job(&self) -> Job {
        let errors = lock(&self.errors);
        let outcome = lock(&self.outcome);
        let total = self.total.load(Ordering::Acquire);
        Job {
            id: self.id.clone(),
            kind: self.kind.clone(),
            section: self.section.clone(),
            title: self.title.clone(),
            total: (total != u64::MAX).then_some(total),
            done: self.done.load(Ordering::Acquire),
            skipped: self.skipped.load(Ordering::Acquire),
            errors: errors.first.clone(),
            error_count: errors.count,
            state: outcome.state,
            started_at: self.started_at.clone(),
            finished_at: outcome.finished_at.clone(),
            message: outcome.message.clone(),
            result: outcome.result.clone(),
        }
    }
}

/// What the ring's entries carry beside their JSON.
#[derive(Clone, Debug)]
struct StateMeta {
    id: Arc<str>,
    section: Arc<str>,
}

struct Record {
    shared: Arc<JobShared>,
    task: Option<JoinHandle<()>>,
    /// When it finished, for the ten-minute window.
    finished: Option<Instant>,
    /// The newest state pushed to the ring.
    last: Option<Entry<StateMeta>>,
}

#[derive(Default)]
struct Jobs {
    /// Every kept job, by id.
    records: BTreeMap<String, Record>,
    /// Ids in the order they started.
    order: VecDeque<String>,
    /// One badge per section that has run a job.
    gauges: BTreeMap<String, BadgeHandle>,
    stopping: bool,
}

struct Inner {
    jobs: Mutex<Jobs>,
    ring: ReplayRing<StateMeta>,
    badges: OnceLock<BadgeBoard>,
}

/// The engine's jobs. Cheap to clone; the suite keeps a clone to stop them
/// first when it stops.
#[derive(Clone)]
pub struct JobRegistry {
    inner: Arc<Inner>,
}

impl Default for JobRegistry {
    fn default() -> Self {
        Self::new()
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl JobRegistry {
    /// An empty registry, its ring counted against the process's budget.
    #[must_use]
    pub fn new() -> Self {
        Self::with_budget(&RingBudget::shared())
    }

    fn with_budget(budget: &RingBudget) -> Self {
        Self {
            inner: Arc::new(Inner {
                jobs: Mutex::new(Jobs::default()),
                ring: ReplayRing::new("jobs", RING_LIMITS, random_epoch(), budget),
                badges: OnceLock::new(),
            }),
        }
    }

    /// Publishes the `<section>.jobs` badges on `badges` and cancels every
    /// job when the suite stops. Called once, by the console router.
    pub(crate) fn attach(&self, badges: &BadgeBoard, shutdown: Shutdown) {
        let _ = self.inner.badges.set(badges.clone());
        let registry = self.clone();
        tokio::spawn(async move {
            shutdown.stopped().await;
            registry.stop().await;
        });
    }

    /// Starts `work` on the runtime and answers with the job at once.
    /// `409 conflict` when the section already runs its limit of jobs (four,
    /// or one for the suite); `503` once the suite is stopping.
    #[allow(
        dead_code,
        reason = "the section streams start their bulk work with it; the suite clear builds its own"
    )]
    pub(crate) fn start<F>(
        &self,
        section: &str,
        kind: &str,
        title: String,
        total: Option<u64>,
        work: F,
    ) -> Result<Job, ApiError>
    where
        F: FnOnce(JobHandle) -> BoxFuture<'static, Result<(), ApiError>> + Send + 'static,
    {
        self.try_start(section, kind, title, total, |handle| Ok(work(handle)))
    }

    /// [`JobRegistry::start`], where building the work can refuse before
    /// anything starts (the refusal is the answer, and no job is kept).
    /// `build` runs under the registry's lock, so it only builds the work's
    /// future: it never starts or reads jobs.
    pub(crate) fn try_start<F>(
        &self,
        section: &str,
        kind: &str,
        title: String,
        total: Option<u64>,
        build: F,
    ) -> Result<Job, ApiError>
    where
        F: FnOnce(JobHandle) -> Result<BoxFuture<'static, Result<(), ApiError>>, ApiError>,
    {
        let mut jobs = lock(&self.inner.jobs);
        if jobs.stopping {
            return Err(ApiError::unavailable(
                "The engine is stopping, so it starts no more bulk actions.",
            ));
        }
        let limit = if section == SUITE {
            PER_SUITE
        } else {
            PER_SECTION
        };
        let running = Self::running(&jobs, section);
        if running >= limit {
            let message = if section == SUITE {
                "Another suite action is still running.".to_owned()
            } else {
                format!(
                    "Another bulk action is still running in {}.",
                    section_label(section)
                )
            };
            return Err(ApiError::conflict(message)
                .with_fix("Wait for it to finish, or cancel it, and try again."));
        }
        let shared = Arc::new(JobShared {
            id: random_id('j'),
            kind: kind.to_owned(),
            section: section.to_owned(),
            title,
            started_at: rfc3339_now(),
            total: AtomicU64::new(total.unwrap_or(u64::MAX)),
            done: AtomicU64::new(0),
            skipped: AtomicU64::new(0),
            errors: Mutex::new(Errors::default()),
            cancel: AtomicBool::new(false),
            dirty: Notify::new(),
            outcome: Mutex::new(Outcome {
                state: JobState::Running,
                finished_at: None,
                message: None,
                result: None,
            }),
        });
        let handle = JobHandle {
            shared: Arc::clone(&shared),
            offset: Arc::new(AtomicU64::new(0)),
        };
        let work = build(handle)?;
        let id = shared.id.clone();
        let task = tokio::spawn(run(self.clone(), Arc::clone(&shared), work));
        jobs.records.insert(
            id.clone(),
            Record {
                shared: Arc::clone(&shared),
                task: Some(task),
                finished: None,
                last: None,
            },
        );
        jobs.order.push_back(id.clone());
        self.publish(&mut jobs, &id);
        self.update_gauge(&mut jobs, section);
        Ok(shared.job())
    }

    fn running(jobs: &Jobs, section: &str) -> usize {
        jobs.records
            .values()
            .filter(|record| record.finished.is_none() && record.shared.section == section)
            .count()
    }

    /// Pushes job `id`'s state now (under the registry's lock, so a
    /// subscriber taking the current states and the live tail sees each
    /// state exactly once).
    fn publish(&self, jobs: &mut Jobs, id: &str) {
        let Some(record) = jobs.records.get_mut(id) else {
            return;
        };
        let job = record.shared.job();
        let meta = StateMeta {
            id: Arc::from(job.id.as_str()),
            section: Arc::from(job.section.as_str()),
        };
        // The console's own types always serialize.
        let json: Arc<str> = Arc::from(serde_json::to_string(&job).unwrap_or_default());
        let cursor = self.inner.ring.push(meta.clone(), Arc::clone(&json));
        record.last = Some(Entry { cursor, meta, json });
    }

    fn update_gauge(&self, jobs: &mut Jobs, section: &str) {
        let Some(badges) = self.inner.badges.get() else {
            return;
        };
        let count = u64::try_from(Self::running(jobs, section)).unwrap_or(u64::MAX);
        let gauge = jobs.gauges.entry(section.to_owned()).or_insert_with(|| {
            badges.handle(
                &format!("{section}.jobs"),
                BadgeKind::Gauge,
                BadgeNoun::new("bulk action running", "bulk actions running"),
            )
        });
        gauge.set(count, BadgeTone::Neutral);
    }

    /// Drops finished jobs past ten minutes, and the oldest past 100.
    fn prune(jobs: &mut Jobs) {
        let now = Instant::now();
        let expired: Vec<String> = jobs
            .records
            .iter()
            .filter(|(_, record)| {
                record
                    .finished
                    .is_some_and(|finished| now.duration_since(finished) > KEEP_FINISHED)
            })
            .map(|(id, _)| id.clone())
            .collect();
        for id in &expired {
            jobs.records.remove(id);
        }
        let mut finished = jobs
            .order
            .iter()
            .filter(|id| {
                jobs.records
                    .get(*id)
                    .is_some_and(|record| record.finished.is_some())
            })
            .count();
        let mut excess: Vec<String> = Vec::new();
        for id in &jobs.order {
            if finished <= MAX_FINISHED {
                break;
            }
            if jobs
                .records
                .get(id)
                .is_some_and(|record| record.finished.is_some())
            {
                excess.push(id.clone());
                finished -= 1;
            }
        }
        for id in &excess {
            jobs.records.remove(id);
        }
        let records = &jobs.records;
        jobs.order.retain(|id| records.contains_key(id));
    }

    /// Job `id`, while it is kept.
    pub(crate) fn get(&self, id: &str) -> Option<Job> {
        let mut jobs = lock(&self.inner.jobs);
        Self::prune(&mut jobs);
        jobs.records.get(id).map(|record| record.shared.job())
    }

    /// Running jobs and those finished in the last ten minutes, of
    /// `section` (every section when `None`), oldest first.
    pub(crate) fn list(&self, section: Option<&str>) -> Vec<Job> {
        let mut jobs = lock(&self.inner.jobs);
        Self::prune(&mut jobs);
        jobs.order
            .iter()
            .filter_map(|id| jobs.records.get(id))
            .filter(|record| section.is_none_or(|section| record.shared.section == section))
            .map(|record| record.shared.job())
            .collect()
    }

    /// Asks job `id` to stop at its next check; the job as it is now.
    pub(crate) fn cancel(&self, id: &str) -> Option<Job> {
        let jobs = lock(&self.inner.jobs);
        let record = jobs.records.get(id)?;
        if record.finished.is_none() {
            record.shared.cancel.store(true, Ordering::Release);
            record.shared.dirty.notify_one();
        }
        Some(record.shared.job())
    }

    /// Cancels every job and waits (up to 10 s) for each to reach its next
    /// check; a job that does not is abandoned and reported cancelled. Later
    /// starts are refused. Called first when the suite stops, and on the
    /// stop signal.
    pub async fn stop(&self) {
        let tasks: Vec<JoinHandle<()>> = {
            let mut jobs = lock(&self.inner.jobs);
            jobs.stopping = true;
            jobs.records
                .values_mut()
                .filter(|record| record.finished.is_none())
                .filter_map(|record| {
                    record.shared.cancel.store(true, Ordering::Release);
                    record.shared.dirty.notify_one();
                    record.task.take()
                })
                .collect()
        };
        if tasks.is_empty() {
            return;
        }
        let aborts: Vec<_> = tasks.iter().map(JoinHandle::abort_handle).collect();
        let waited = tokio::time::timeout(STOP_GRACE, futures_util::future::join_all(tasks)).await;
        if waited.is_err() {
            for abort in aborts {
                abort.abort();
            }
            let mut jobs = lock(&self.inner.jobs);
            let abandoned: Vec<String> = jobs
                .records
                .iter()
                .filter(|(_, record)| record.finished.is_none())
                .map(|(id, _)| id.clone())
                .collect();
            for id in abandoned {
                if let Some(record) = jobs.records.get(&id) {
                    finish_outcome(&record.shared, JobState::Cancelled, Some(stopped_message()));
                }
                self.finished(&mut jobs, &id);
            }
        }
    }

    /// Marks job `id` finished: pushed, counted out of its gauge.
    fn finished(&self, jobs: &mut Jobs, id: &str) {
        let Some(record) = jobs.records.get_mut(id) else {
            return;
        };
        record.finished = Some(Instant::now());
        record.task = None;
        let section = record.shared.section.clone();
        self.publish(jobs, id);
        self.update_gauge(jobs, &section);
        Self::prune(jobs);
    }

    /// `GET /jobs`, `GET /jobs/{id}`, `POST /jobs/{id}/cancel`.
    pub(crate) fn router(&self) -> Router {
        Router::new()
            .route("/jobs", get(list))
            .route("/jobs/{id}", get(one))
            .route("/jobs/{id}/cancel", post(cancel))
            .with_state(self.clone())
    }

    /// The `jobs` topic.
    pub(crate) fn topic(&self) -> JobsTopic {
        JobsTopic {
            registry: self.clone(),
        }
    }
}

const fn stopped_message() -> &'static str {
    "The engine stopped."
}

fn finish_outcome(shared: &JobShared, state: JobState, message: Option<&str>) {
    let mut outcome = lock(&shared.outcome);
    if outcome.state != JobState::Running {
        return;
    }
    outcome.state = state;
    outcome.finished_at = Some(rfc3339_now());
    outcome.message = message.map(str::to_owned);
}

/// A job's task: the work, its states pushed at most every 250 ms while it
/// runs, then its final state.
async fn run(
    registry: JobRegistry,
    shared: Arc<JobShared>,
    work: BoxFuture<'static, Result<(), ApiError>>,
) {
    let mut work = AssertUnwindSafe(work).catch_unwind();
    let mut next_push = tokio::time::Instant::now();
    let outcome = loop {
        tokio::select! {
            biased;
            outcome = &mut work => break outcome,
            () = shared.dirty.notified() => {
                let wait = tokio::time::sleep_until(next_push);
                tokio::pin!(wait);
                tokio::select! {
                    biased;
                    outcome = &mut work => break outcome,
                    () = &mut wait => {}
                }
                registry.publish(&mut lock(&registry.inner.jobs), &shared.id);
                next_push = tokio::time::Instant::now() + PUSH_EVERY;
            }
        }
    };
    let stopping = lock(&registry.inner.jobs).stopping;
    let cancelled = shared.cancel.load(Ordering::Acquire);
    let (state, message) = match outcome {
        Ok(Ok(())) => {
            let total = shared.total.load(Ordering::Acquire);
            let complete = total != u64::MAX && shared.done.load(Ordering::Acquire) >= total;
            if cancelled && !complete {
                let message = if stopping {
                    stopped_message()
                } else {
                    "Cancelled."
                };
                (JobState::Cancelled, Some(message.to_owned()))
            } else {
                (JobState::Done, None)
            }
        }
        Ok(Err(_)) if cancelled => {
            let message = if stopping {
                stopped_message()
            } else {
                "Cancelled."
            };
            (JobState::Cancelled, Some(message.to_owned()))
        }
        Ok(Err(error)) => {
            let detail = error.detail();
            let message = match &detail.fix {
                Some(fix) => format!("{} {fix}", detail.message),
                None => detail.message.clone(),
            };
            (JobState::Failed, Some(message))
        }
        Err(_) => (
            JobState::Failed,
            Some("The job stopped unexpectedly: the engine hit a fault in it.".to_owned()),
        ),
    };
    finish_outcome(&shared, state, message.as_deref());
    let mut jobs = lock(&registry.inner.jobs);
    registry.finished(&mut jobs, &shared.id);
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ListParams {
    #[serde(default)]
    section: Option<String>,
}

async fn list(
    State(registry): State<JobRegistry>,
    Query(params): Query<ListParams>,
) -> Json<JobList> {
    Json(JobList {
        jobs: registry.list(
            params
                .section
                .as_deref()
                .filter(|section| !section.is_empty()),
        ),
    })
}

fn unknown_job(id: &str) -> ApiError {
    ApiError::not_found(format!(
        "There is no job {id}; finished jobs are kept for ten minutes."
    ))
}

async fn one(
    State(registry): State<JobRegistry>,
    Path(id): Path<String>,
) -> Result<Json<Job>, ApiError> {
    registry.get(&id).map(Json).ok_or_else(|| unknown_job(&id))
}

/// `{}`: a cancel takes no arguments.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CancelRequest {}

async fn cancel(
    State(registry): State<JobRegistry>,
    Path(id): Path<String>,
    ConsoleJson(CancelRequest {}): ConsoleJson<CancelRequest>,
) -> Result<Json<Job>, ApiError> {
    registry
        .cancel(&id)
        .map(Json)
        .ok_or_else(|| unknown_job(&id))
}

/// A started job, as a section's route answers it: `202 Accepted`.
#[allow(
    dead_code,
    reason = "the section streams answer their bulk routes with it"
)]
pub(crate) fn accepted(job: Job) -> Response {
    (StatusCode::ACCEPTED, Json(job)).into_response()
}

/// The `jobs` topic: `{ section? }`; `job` → `Job`. On open, the current
/// state of every kept job (of the section); then each new state. Resumes
/// from a cursor by replaying the ring (each job's newest state only); a
/// cursor the ring no longer holds is a `reset gap` followed by the current
/// states.
pub(crate) struct JobsTopic {
    registry: JobRegistry,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct JobsParams {
    #[serde(default)]
    section: Option<String>,
}

impl LiveTopic for JobsTopic {
    fn name(&self) -> &'static str {
        "jobs"
    }

    fn open(
        &self,
        params: &serde_json::Value,
        after: Option<&str>,
    ) -> Result<TopicStream, ApiError> {
        let params: JobsParams = topic_params(params)?;
        let section: Option<Arc<str>> = params.section.map(Arc::from);
        let (outbox, live) = self.registry.catch_up(section.as_deref(), after, None);
        let state = Follower {
            registry: self.registry.clone(),
            section,
            live,
            outbox,
            consumed: None,
        };
        Ok(stream::unfold(state, |mut state| async move {
            state.next().await.map(|event| (event, state))
        })
        .boxed())
    }
}

fn job_event(entry: &Entry<StateMeta>) -> TopicEvent {
    TopicEvent::Event {
        name: "job",
        cursor: Some(Arc::from(entry.cursor.to_string())),
        data: Arc::clone(&entry.json),
    }
}

/// Keeps each job's newest entry, in cursor order.
fn newest_per_job(entries: impl IntoIterator<Item = Entry<StateMeta>>) -> Vec<Entry<StateMeta>> {
    let mut newest: BTreeMap<Arc<str>, Entry<StateMeta>> = BTreeMap::new();
    for entry in entries {
        newest.insert(Arc::clone(&entry.meta.id), entry);
    }
    let mut entries: Vec<Entry<StateMeta>> = newest.into_values().collect();
    entries.sort_by_key(|entry| entry.cursor);
    entries
}

impl JobRegistry {
    /// What a subscriber of `section` gets first, and the live tail from
    /// there, taken under the registry's lock: the ring's entries after
    /// `after` when it still holds them, else (`reset`, with `reason` when
    /// recovering from lag) the current state of every kept job.
    fn catch_up(
        &self,
        section: Option<&str>,
        after: Option<&str>,
        lagged: Option<ResetReason>,
    ) -> (VecDeque<TopicEvent>, broadcast::Receiver<Entry<StateMeta>>) {
        let mut jobs = lock(&self.inner.jobs);
        Self::prune(&mut jobs);
        let follow = self.inner.ring.follow(after);
        let keep = |entry: &Entry<StateMeta>| {
            section.is_none_or(|section| &*entry.meta.section == section)
        };
        let mut outbox = VecDeque::new();
        if after.is_some() && !follow.gap {
            outbox.extend(
                newest_per_job(follow.replay.into_iter().filter(|entry| keep(entry)))
                    .iter()
                    .map(job_event),
            );
            return (outbox, follow.live);
        }
        if after.is_some() {
            outbox.push_back(TopicEvent::Reset {
                reason: lagged.unwrap_or(ResetReason::Gap),
                missed: follow.missed,
            });
        }
        let mut current: Vec<Entry<StateMeta>> = jobs
            .records
            .values()
            .filter_map(|record| record.last.clone())
            .filter(|entry| keep(entry))
            .collect();
        current.sort_by_key(|entry| entry.cursor);
        outbox.extend(current.iter().map(job_event));
        (outbox, follow.live)
    }
}

struct Follower {
    registry: JobRegistry,
    section: Option<Arc<str>>,
    live: broadcast::Receiver<Entry<StateMeta>>,
    outbox: VecDeque<TopicEvent>,
    consumed: Option<Cursor>,
}

impl Follower {
    async fn next(&mut self) -> Option<TopicEvent> {
        loop {
            if let Some(event) = self.outbox.pop_front() {
                if let TopicEvent::Event {
                    cursor: Some(cursor),
                    ..
                } = &event
                    && let Ok(cursor) = cursor.parse::<Cursor>()
                {
                    self.consumed = Some(cursor);
                }
                return Some(event);
            }
            match self.live.recv().await {
                Ok(entry) => {
                    let fresh = self.consumed.is_none_or(|consumed| entry.cursor > consumed);
                    let kept = self
                        .section
                        .as_deref()
                        .is_none_or(|section| &*entry.meta.section == section);
                    if fresh && kept {
                        self.outbox.push_back(job_event(&entry));
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    let after = self.consumed.map(|cursor| cursor.to_string());
                    let (outbox, live) = self.registry.catch_up(
                        self.section.as_deref(),
                        Some(after.as_deref().unwrap_or("00000000.0")),
                        Some(ResetReason::Lagged),
                    );
                    self.outbox = outbox;
                    self.live = live;
                }
                Err(broadcast::error::RecvError::Closed) => return None,
            }
        }
    }
}

#[cfg(test)]
#[path = "jobs_tests.rs"]
mod tests;
