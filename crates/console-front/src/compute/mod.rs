//! Functions, Extensions and Eventarc in the console (the compute stream's
//! module). Owns `/api/v1/functions/...`, `/api/v1/extensions/...` and
//! `/api/v1/eventarc/...`, and the topics `functions.events`,
//! `functions.invocation`, `functions.codebase-log`, `eventarc.events` and
//! `extensions.changes`.
//!
//! Functions start after the console is serving, so two things reach it at
//! different times. The runtime's [`Monitor`] exists before Functions
//! start (the suite creates it in `console_wiring::compute::parts` and
//! hands it to the runtime), so the snapshot, the invocation history and
//! every topic answer from the first request and a page opened during
//! startup sees codebases turn ready live. The runtime's control handle
//! and the Extensions control arrive later through [`Late`]s: routes that
//! need them answer `503 starting` until the suite hands them over.
//! Pub/Sub and Cloud Tasks follow Functions; compute reaches them through
//! messaging's own `Late`s, cloned in by `console_router`, never a second
//! pair of its own.

mod eventarc;
mod extensions;
mod filters;
mod functions;
mod live;
mod search;
mod topics;

use std::collections::BTreeSet;
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use std::time::Duration;

use axum::Router;
use firenook_extensions::LoadOutcome;
use firenook_extensions::control::ExtensionsControl;
use firenook_functions_runtime::console::{ConsoleError, ConsoleHandle};
use firenook_functions_runtime::monitor::{
    EventarcEventQuery, FunctionCodebaseKind, FunctionLoadState,
};
use firenook_functions_runtime::watcher::SourceWatcher;
use firenook_functions_runtime::{Monitor, MonitorLimits};
use futures_util::StreamExt as _;
use futures_util::stream::{self, BoxStream};
use tokio::sync::watch;
use tokio_stream::wrappers::WatchStream;

use crate::api_error::ApiError;
use crate::late::{Late, late_native};
use crate::live::LiveTopic;
use crate::messaging::{PubsubConsole, TasksConsole};
use crate::search::SearchSource;
use crate::section::{
    Section, SectionContext, SectionStatus, SectionSummary, SummaryFigure, SummaryUnit,
};
use crate::sse::Shutdown;

/// Where the Functions port's application is mounted, as the browser sees it.
pub(crate) const FUNCTIONS_PREFIX: &str = "/console/api/v1/functions/native";
/// Where the Eventarc emulator's application is mounted.
pub(crate) const EVENTARC_PREFIX: &str = "/console/api/v1/eventarc/native";

/// What a section waiting on Functions says.
const DISCOVERING: &str = "Discovering functions…";
/// A section ticks its status at most this often while its counts change.
const STATUS_EVERY: Duration = Duration::from_millis(500);

/// What the suite tells compute's console about itself before Functions
/// start.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct ComputeSuite {
    /// The Functions service as apps reach it (`http://127.0.0.1:5001`),
    /// the base of every function address the console shows or copies.
    pub(crate) address: Option<String>,
    /// The hub names of the services this suite runs (`firestore`, `auth`,
    /// `storage`, `pubsub`), so a function whose events come from a service
    /// that is not running says so; `None` when the suite did not say.
    pub(crate) services: Option<BTreeSet<String>>,
}

impl ComputeSuite {
    /// Whether the suite runs `service`; true when the suite did not say.
    #[must_use]
    pub(crate) fn runs(&self, service: &str) -> bool {
        self.services
            .as_ref()
            .is_none_or(|services| services.contains(service))
    }
}

/// What compute's console needs from before Functions start, and the late
/// parts. Created by `console_wiring::compute::parts` before the console is
/// built; its [`Monitor`] is handed to the Functions runtime, so what compute
/// records exists before the first function runs. Cheap to clone.
#[derive(Clone)]
pub struct ComputeParts {
    /// The Functions port's routers, handed over when Functions are up; the
    /// sections report `ready` once it is set.
    pub late: Late<ComputeConsole>,
    /// The runtime's control handle and the Extensions control, handed over
    /// with `late` ([`ComputeParts::hand_over`]).
    pub(crate) control: Late<ComputeControl>,
    monitor: Monitor,
    suite: Arc<ComputeSuite>,
    /// Ticks when a summary figure may have changed.
    counts: Arc<watch::Sender<u64>>,
    /// The rings and the live sink, built once the console has a context.
    live: Arc<OnceLock<Arc<live::ComputeLive>>>,
    /// The Extensions instances Functions started with, from the suite's
    /// start helper to its `ready` hook.
    started: Arc<Mutex<Option<LoadOutcome>>>,
    /// The suite's file watchers that feed this console, stopped when the
    /// suite stops.
    watchers: Arc<Mutex<Vec<SourceWatcher>>>,
}

impl ComputeParts {
    /// Functions not started yet, with a monitor of the release bounds.
    #[must_use]
    pub fn new() -> Self {
        Self::with_suite(
            Monitor::new(MonitorLimits::default()),
            ComputeSuite::default(),
        )
    }

    /// Functions not started yet, recording into `monitor`. `address` is the
    /// Functions service as apps reach it (`http://127.0.0.1:5001`), the base
    /// of every function address the console shows or copies; `services`
    /// the hub names of the services the suite runs (`firestore`, `auth`,
    /// `storage`, `pubsub`), so a function whose events come from a service
    /// that is not running says so.
    #[must_use]
    pub fn for_suite(
        monitor: Monitor,
        address: Option<String>,
        services: Option<BTreeSet<String>>,
    ) -> Self {
        Self::with_suite(monitor, ComputeSuite { address, services })
    }

    fn with_suite(monitor: Monitor, suite: ComputeSuite) -> Self {
        Self {
            late: Late::pending("Functions"),
            control: Late::pending("Functions"),
            monitor,
            suite: Arc::new(suite),
            counts: Arc::new(watch::Sender::new(0)),
            live: Arc::new(OnceLock::new()),
            started: Arc::new(Mutex::new(None)),
            watchers: Arc::new(Mutex::new(Vec::new())),
        }
    }

    /// The record of everything Functions do, which the runtime feeds and
    /// the console reads (messaging joins its deliveries to it).
    #[must_use]
    pub fn monitor(&self) -> &Monitor {
        &self.monitor
    }

    /// What the suite said about itself.
    pub(crate) fn suite(&self) -> &ComputeSuite {
        &self.suite
    }

    /// Hands the running runtime's control handle and the Extensions
    /// control (`None` without an Extensions configuration) to the console;
    /// the routes that need them serve from now on.
    pub fn hand_over(&self, runtime: ConsoleHandle, extensions: Option<ExtensionsControl>) {
        self.control.set(ComputeControl {
            runtime,
            extensions,
        });
    }

    /// Whether [`ComputeParts::hand_over`] ran.
    #[must_use]
    pub fn handed_over(&self) -> bool {
        self.control.is_ready()
    }

    /// Keeps what loading the Extensions instances produced until the
    /// suite's `ready` hook builds their control from it.
    pub fn hand_over_extensions(&self, outcome: LoadOutcome) {
        *lock(&self.started) = Some(outcome);
    }

    /// What [`ComputeParts::hand_over_extensions`] kept, once.
    #[must_use]
    pub fn take_extensions(&self) -> Option<LoadOutcome> {
        lock(&self.started).take()
    }

    /// Keeps a file watcher running until [`ComputeParts::stop_watchers`].
    pub fn keep_watcher(&self, watcher: SourceWatcher) {
        lock(&self.watchers).push(watcher);
    }

    /// Stops every watcher kept with [`ComputeParts::keep_watcher`].
    pub fn stop_watchers(&self) {
        for watcher in std::mem::take(&mut *lock(&self.watchers)) {
            watcher.stop();
        }
    }

    /// How many watchers are kept.
    #[must_use]
    pub fn watcher_count(&self) -> usize {
        lock(&self.watchers).len()
    }

    /// The rings and the live sink, built on first use with the console's
    /// context. One console per suite builds them; another console over the
    /// same parts (tests) shares them.
    fn live(&self, context: &SectionContext) -> Arc<live::ComputeLive> {
        Arc::clone(self.live.get_or_init(|| {
            live::ComputeLive::install(&self.monitor, context, Arc::clone(&self.counts))
        }))
    }
}

impl Default for ComputeParts {
    fn default() -> Self {
        Self::new()
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The running Functions runtime's applications, as the console mounts
/// them.
#[derive(Clone)]
pub struct ComputeConsole {
    /// The Functions port's router (`/backends`, `/{project}/{region}/{name}`).
    pub functions: Router,
    /// The Eventarc emulator's router.
    pub eventarc: Router,
}

/// What the console may ask of the running Functions runtime and its
/// Extensions instances.
#[derive(Clone)]
pub(crate) struct ComputeControl {
    pub(crate) runtime: ConsoleHandle,
    /// `None` when the suite runs no Extensions configuration.
    pub(crate) extensions: Option<ExtensionsControl>,
}

/// The Functions, Extensions and Eventarc sections.
pub(crate) struct ComputeSection {
    pub(crate) parts: ComputeParts,
    /// Messaging's Lates, cloned in by `console_router` (one `Late` per
    /// runtime): compute publishes, enqueues and runs schedules through the
    /// running Pub/Sub and Cloud Tasks emulators' own applications.
    pub(crate) pubsub: Option<Late<PubsubConsole>>,
    pub(crate) tasks: Option<Late<TasksConsole>>,
}

/// What every compute route reads.
#[derive(Clone)]
pub(crate) struct ComputeState {
    pub(crate) parts: ComputeParts,
    pub(crate) live: Arc<live::ComputeLive>,
    pub(crate) pubsub: Option<Late<PubsubConsole>>,
    pub(crate) tasks: Option<Late<TasksConsole>>,
    pub(crate) project: Arc<str>,
    pub(crate) shutdown: Shutdown,
}

impl ComputeState {
    fn monitor(&self) -> &Monitor {
        &self.parts.monitor
    }

    /// The runtime's control, or `503 starting`.
    fn control(&self) -> Result<ComputeControl, ApiError> {
        self.parts.control.get()
    }

    fn runtime(&self) -> Result<ConsoleHandle, ApiError> {
        self.control().map(|control| control.runtime)
    }
}

impl ComputeSection {
    fn state(&self, context: &SectionContext) -> ComputeState {
        ComputeState {
            live: self.parts.live(context),
            parts: self.parts.clone(),
            pubsub: self.pubsub.clone(),
            tasks: self.tasks.clone(),
            project: Arc::clone(&context.project),
            shutdown: context.shutdown.clone(),
        }
    }
}

impl Section for ComputeSection {
    fn statuses(&self) -> Vec<SectionStatus> {
        let ready = self.parts.late.is_ready();
        ["functions", "extensions", "eventarc"]
            .into_iter()
            .map(|id| {
                if ready {
                    SectionStatus::ready(id)
                } else {
                    SectionStatus::starting(id, DISCOVERING)
                }
            })
            .collect()
    }

    fn status_changes(&self) -> Option<BoxStream<'static, ()>> {
        let handed_over = WatchStream::from_changes(self.parts.late.changes()).map(|_| ());
        let counted = throttled(self.parts.counts.subscribe(), STATUS_EVERY);
        Some(stream::select(handed_over, counted).boxed())
    }

    fn router(&self, context: &SectionContext) -> Router {
        let state = self.state(context);
        Router::new()
            .nest_service(
                "/functions/native",
                late_native(self.parts.late.clone(), FUNCTIONS_PREFIX, |console| {
                    console.functions.clone()
                }),
            )
            .nest_service(
                "/eventarc/native",
                late_native(self.parts.late.clone(), EVENTARC_PREFIX, |console| {
                    console.eventarc.clone()
                }),
            )
            .merge(functions::router(state.clone()))
            .merge(extensions::router(state.clone()))
            .merge(eventarc::router(state))
    }

    fn topics(&self, context: &SectionContext) -> Vec<Arc<dyn LiveTopic>> {
        topics::all(&self.state(context))
    }

    fn search(&self, _context: &SectionContext) -> Option<Arc<dyn SearchSource>> {
        Some(Arc::new(search::ComputeSearch::new(
            self.parts.control.clone(),
        )))
    }

    fn summary(&self, id: &str) -> Option<SectionSummary> {
        let codebases = self.parts.monitor.codebases();
        match id {
            "functions" => {
                let functions: u64 = codebases
                    .iter()
                    .map(|codebase| u64::from(codebase.function_count))
                    .sum();
                let user = codebases
                    .iter()
                    .filter(|codebase| codebase.kind == FunctionCodebaseKind::User)
                    .count() as u64;
                let failing = codebases
                    .iter()
                    .filter(|codebase| codebase.state == FunctionLoadState::Failed)
                    .count() as u64;
                let mut headline = format!(
                    "{} · {}",
                    counted(functions, "function", "functions"),
                    counted(user, "codebase", "codebases")
                );
                if failing > 0 {
                    headline.push_str(" · ");
                    headline.push_str(&counted(failing, "failing load", "failing loads"));
                }
                Some(SectionSummary {
                    headline,
                    figures: vec![
                        figure("functions", functions),
                        figure("codebases", user),
                        figure("failing loads", failing),
                    ],
                })
            }
            "extensions" => {
                let instances = codebases
                    .iter()
                    .filter(|codebase| codebase.kind == FunctionCodebaseKind::Extension)
                    .count() as u64;
                Some(SectionSummary {
                    headline: counted(instances, "instance", "instances"),
                    figures: vec![figure("instances", instances)],
                })
            }
            "eventarc" => {
                let kept = self
                    .parts
                    .monitor
                    .events(
                        &EventarcEventQuery {
                            channel: None,
                            filter: None,
                            limit: 0,
                        },
                        None,
                    )
                    .total;
                Some(SectionSummary {
                    headline: format!("{} kept", counted(kept, "event", "events")),
                    figures: vec![figure("events kept", kept)],
                })
            }
            _ => None,
        }
    }
}

/// `1 function`, `1,204 functions`.
pub(crate) fn counted(count: u64, one: &str, other: &str) -> String {
    let noun = if count == 1 { one } else { other };
    format!("{} {noun}", grouped(count))
}

/// `1,204`.
pub(crate) fn grouped(count: u64) -> String {
    let digits = count.to_string();
    let mut grouped = String::with_capacity(digits.len() + digits.len() / 3);
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            grouped.push(',');
        }
        grouped.push(digit);
    }
    grouped
}

fn figure(label: &str, value: u64) -> SummaryFigure {
    SummaryFigure {
        label: label.to_owned(),
        value: Some(value),
        unit: SummaryUnit::Count,
    }
}

/// One tick per change of `receiver`, at most one per `every`: a burst of
/// changes is one tick, the next no sooner than `every` after it.
fn throttled(receiver: watch::Receiver<u64>, every: Duration) -> BoxStream<'static, ()> {
    stream::unfold(
        (receiver, None::<tokio::time::Instant>),
        move |(mut receiver, last)| async move {
            receiver.changed().await.ok()?;
            if let Some(last) = last {
                tokio::time::sleep_until(last + every).await;
            }
            receiver.mark_unchanged();
            Some(((), (receiver, Some(tokio::time::Instant::now()))))
        },
    )
    .boxed()
}

/// A random version-4 UUID: a test event's or a published event's id.
pub(crate) fn random_uuid() -> String {
    use std::hash::{BuildHasher as _, Hasher as _};
    let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
    hasher.write_u128(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |since| since.as_nanos()),
    );
    let high = hasher.finish();
    hasher.write_u64(high);
    let low = hasher.finish();
    format!(
        "{:08x}-{:04x}-4{:03x}-{:04x}-{:012x}",
        high >> 32,
        (high >> 16) & 0xffff,
        high & 0x0fff,
        (low >> 48) & 0x3fff | 0x8000,
        low & 0xffff_ffff_ffff
    )
}

/// A runtime refusal as the console's error.
pub(crate) fn console_error(error: ConsoleError) -> ApiError {
    match error {
        ConsoleError::NotFound(message) => ApiError::not_found(message),
        ConsoleError::Invalid(message) => ApiError::invalid(message),
        ConsoleError::Conflict { message, detail } => conflict_with_detail(message, detail),
        ConsoleError::Unavailable(message) => ApiError::unavailable(message),
    }
}

/// `conflict` whose fix is the first line of `detail` (a load error) and
/// whose extra `detail` is all of it.
pub(crate) fn conflict_with_detail(message: String, detail: Option<String>) -> ApiError {
    let error = ApiError::conflict(message);
    match detail.filter(|detail| !detail.trim().is_empty()) {
        Some(detail) => {
            let first = detail.lines().next().unwrap_or_default().trim().to_owned();
            error
                .with_fix(first)
                .with_extra("detail", serde_json::Value::String(detail))
        }
        None => error,
    }
}

/// The compute stream's TypeScript bindings, into `generated/compute/`.
#[cfg(test)]
pub(crate) fn export_bindings(config: &ts_rs::Config) {
    use ts_rs::TS as _;
    // Every root type; the runtime's own types are written through them.
    functions::FunctionsSnapshot::export_all(config).expect("TypeScript bindings written");
    functions::FunctionDetail::export_all(config).expect("TypeScript bindings written");
    functions::FunctionInvokeRequest::export_all(config).expect("TypeScript bindings written");
    functions::InvocationFrame::export_all(config).expect("TypeScript bindings written");
    functions::FunctionTestEventRequest::export_all(config).expect("TypeScript bindings written");
    functions::FunctionPublishRequest::export_all(config).expect("TypeScript bindings written");
    functions::FunctionEnqueueRequest::export_all(config).expect("TypeScript bindings written");
    functions::FunctionBrokerResult::export_all(config).expect("TypeScript bindings written");
    functions::FunctionMatchRequest::export_all(config).expect("TypeScript bindings written");
    functions::FunctionMatchResult::export_all(config).expect("TypeScript bindings written");
    functions::FunctionTriggersResult::export_all(config).expect("TypeScript bindings written");
    functions::FunctionEnvEditRequest::export_all(config).expect("TypeScript bindings written");
    functions::FunctionEnvEditResult::export_all(config).expect("TypeScript bindings written");
    functions::FunctionRevealedValue::export_all(config).expect("TypeScript bindings written");
    functions::FunctionRestartResult::export_all(config).expect("TypeScript bindings written");
    functions::FunctionLoadLog::export_all(config).expect("TypeScript bindings written");
    topics::FunctionsLiveBatch::export_all(config).expect("TypeScript bindings written");
    functions::InvocationsResult::export_all(config).expect("TypeScript bindings written");
    functions::InvocationView::export_all(config).expect("TypeScript bindings written");
    eventarc::EventarcSnapshot::export_all(config).expect("TypeScript bindings written");
    eventarc::EventarcEventsResult::export_all(config).expect("TypeScript bindings written");
    eventarc::EventarcEventView::export_all(config).expect("TypeScript bindings written");
    topics::EventarcLiveBatch::export_all(config).expect("TypeScript bindings written");
    eventarc::EventarcPublishRequest::export_all(config).expect("TypeScript bindings written");
    eventarc::EventarcPublishResult::export_all(config).expect("TypeScript bindings written");
    eventarc::EventarcReplayRequest::export_all(config).expect("TypeScript bindings written");
    extensions::ExtensionsSnapshot::export_all(config).expect("TypeScript bindings written");
    extensions::ExtensionInstanceDetail::export_all(config).expect("TypeScript bindings written");
    extensions::ExtensionReconfigureRequest::export_all(config)
        .expect("TypeScript bindings written");
    extensions::ExtensionReconfigureResult::export_all(config)
        .expect("TypeScript bindings written");
    extensions::ExtensionParamProblem::export_all(config).expect("TypeScript bindings written");
    extensions::ExtensionVendorResult::export_all(config).expect("TypeScript bindings written");
    extensions::ExtensionRevealedValue::export_all(config).expect("TypeScript bindings written");
    extensions::ExtensionsChanged::export_all(config).expect("TypeScript bindings written");
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
