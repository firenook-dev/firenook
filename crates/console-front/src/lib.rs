//! The Firenook console: the emulator's own UI, embedded in the engine
//! binary, and the Console API it talks to.
//!
//! The console is a client-only application built from `console/` at the
//! repository root. Its build output (`console/dist`) is embedded at compile
//! time in release builds and read from disk in debug builds, so UI work
//! needs no engine rebuild. The suite mounts [`console_router`] under
//! `/console` on the Emulator UI port; every asset and API call is
//! same-origin, so the console works whatever scheme the UI was opened with.

mod api_error;
mod auth;
mod blocking;
mod compute;
mod databases;
mod entity;
mod explain;
mod filter;
mod firestore;
mod firestore_search;
mod foreign;
mod guard;
mod http;
mod instance;
mod jobs;
mod json;
mod late;
mod live;
mod messaging;
mod observe;
mod paging;
mod rules;
mod rules_eval;
mod schema;
mod search;
mod section;
mod sse;
mod storage;
mod suite;
mod time;

use std::collections::BTreeMap;
use std::hash::{Hash as _, Hasher as _};
use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::extract::State;
use axum::http::{StatusCode, Uri, header};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{any, get};
use firenook_suite_front::{EngineRelease, RingBudget, SuiteDirectory};
use futures_util::StreamExt as _;
use futures_util::stream::BoxStream;
use rust_embed::{Embed, EmbeddedFile};
use serde::Serialize;
use tokio_stream::wrappers::WatchStream;
use ts_rs::TS;

pub use api_error::{ApiError, ApiErrorBody, ApiErrorDetail, ErrorCode};
pub use auth::{AuthConsole, AuthToken, AuthTokenRequest, IdentityUser};
pub use compute::{ComputeConsole, ComputeParts};
pub use databases::{DatabaseCatalog, DatabaseInfo, DatabaseList};
pub use entity::EntityRef;
pub use explain::{
    ExplainCandidates, ExplainIndex, ExplainIndexField, ExplainOrder, ExplainStrategy, Explanation,
    QueryExplainer,
};
pub use filter::FieldSpecInfo;
pub use firestore::{
    ChangeBatch, ChangeFeed, ChangeHello, ChangeKind, ChangedCollection, DocumentChange,
    FirestoreConsole,
};
pub use foreign::{ForeignProject, ForeignProjects};
pub use guard::{
    ACTIVITY_HEADER, AllowedHosts, CAUSE_HEADER_PREFIX, CONSOLE_HEADER, EXECUTION_HEADER,
    KEEP_TOKENS_HEADER, METADATA_HEADER, PREVIEW_HEADER,
};
pub use jobs::{BulkTarget, Job, JobError, JobList, JobRegistry, JobState};
pub use late::Late;
pub use live::badges::{Badge, BadgeKind, BadgeNoun, BadgeSet, BadgeTone};
pub use live::{
    LiveEnd, LiveHello, LiveLimits, LiveProbe, LiveRefusal, LiveReset, LiveSubscribe,
    LiveSubscriptionsRequest, LiveSubscriptionsResponse, ResetReason,
};
pub use messaging::{PubsubConsole, TasksConsole};
pub use observe::ObserveConsole;
pub use paging::{BatchGetItem, BatchGetRequest, BatchGetResponse, ListMeta, Page, Total};
pub use rules::{
    CollectionRules, GoverningMatch, OutlineAllow, OutlineMatch, RulesChanged, RulesCheck,
    RulesDiagnostic, RulesDocument, RulesEditor, RulesFileStatus, RulesInstalled, RulesLintCode,
    RulesMap, RulesOperation, RulesOrigin, RulesOutline, RulesSeverity, RulesVersion, UnusedMatch,
};
pub use rules_eval::{
    AllowTrace, DecisionDetail, EvaluateAuth, EvaluateFieldReference, EvaluateOrder, EvaluateQuery,
    EvaluateRequest, EvaluateResult, ExplainStep, FirestoreRestValue, ImpactFlip, RecordedResource,
    RulesEvaluateBody, RulesEvaluation, RulesEvaluator, RulesImpact, RulesImpactBody, RulesMethod,
    RulesOutcome,
};
pub use schema::{
    ParentSubcollections, SchemaError, SchemaIndex, SchemaNode, SchemaSnapshot, Subcollection,
    SubcollectionsSnapshot,
};
pub use search::{SearchGroup, SearchHit, SearchResults};
pub use section::{
    AbsentKind, AbsentReason, ClearReport, SectionFix, SectionFixKind, SectionState, SectionStatus,
    SectionSummary, SummaryFigure, SummaryUnit,
};
pub use sse::Shutdown;
pub use storage::StorageConsole;
pub use suite::{
    BackgroundTriggers, DataFacts, DataMode, DroppedCount, ExportDestination, ExportResult,
    MemoryReport, RingSize, SuiteControls, SuiteSettings,
};

use instance::Instance;
use live::badges::BadgeBoard;
use section::{Section, SectionContext, section_order, section_rank, section_service};

/// Built console assets. `build.rs` guarantees the folder exists, so a
/// checkout without a console build still compiles and the router answers
/// with a build-needed page instead of a broken shell.
#[derive(Embed)]
#[folder = "$CARGO_MANIFEST_DIR/../../console/dist"]
#[exclude = ".vite/*"]
struct Assets;

/// Where the engine serves the console on the Emulator UI port.
pub const CONSOLE_PATH: &str = "/console";

/// The console's view of the running suite.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleStatus {
    /// Configured Firebase project id.
    pub project_id: String,
    /// The engine serving this console.
    pub engine: EngineInfo,
    /// Every service the suite runs, in name order.
    pub services: Vec<ServiceStatus>,
    /// Random per engine start. A console that sees it change knows the
    /// engine restarted and reloads what it shows.
    pub instance: String,
    /// When this engine started, RFC 3339.
    pub started_at: String,
    /// Every console section in sidebar order, with whether it can be used
    /// now.
    pub sections: Vec<SectionStatus>,
    /// Switches that change what the console can offer.
    pub features: ConsoleFeatures,
    /// Services firebase.json configures that Firenook does not emulate
    /// (Realtime Database, Hosting, Data Connect, App Hosting).
    pub unsupported: Vec<UnsupportedService>,
    /// Whether background triggers are delivered; a test harness can pause
    /// them through the hub, which changes what every section does.
    pub background_triggers: BackgroundTriggers,
    /// Where the data lives and whether it survives a restart.
    pub data: DataFacts,
    /// Project ids requests named that are not this emulator's, newest
    /// first, at most 8: the usual reason the console looks empty.
    pub foreign_projects: Vec<ForeignProject>,
}

/// The engine serving the console.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct EngineInfo {
    /// Product name.
    pub name: String,
    /// The release this engine ships as, as the distribution that launched
    /// it declares. Absent for a binary run straight from a build, which has
    /// no release version to report: the crate versions in this workspace
    /// are a placeholder, so reporting one would invent an answer.
    pub version: Option<String>,
    /// The engine source commit this binary was built from, when the
    /// distribution recorded one.
    pub revision: Option<String>,
    /// A hash of the console application this engine serves (its
    /// `index.html`). With `revision` it tells a page that sees a new
    /// instance whether the engine restarted or was updated.
    pub console_build: String,
}

/// One running service as the console shows it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ServiceStatus {
    /// Emulator service name, as the hub advertises it.
    pub name: String,
    /// Connect host.
    pub host: String,
    /// Bound port.
    pub port: u16,
    /// Whether the service listens on its own port (as opposed to a
    /// dependency advertised with a port but served by another listener).
    pub listening: bool,
    /// Process id for services that expose it.
    pub pid: Option<u32>,
}

/// Switches that change what the console can offer.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleFeatures {
    /// Bounded Requests and coverage are kept; `--no-diagnostics` turns them
    /// off and the console then says why a decisions feed is empty.
    pub diagnostics: bool,
}

/// A service firebase.json configures that Firenook does not emulate.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
pub struct UnsupportedService {
    /// The firebase.json key: `database`, `hosting`, `dataconnect`,
    /// `apphosting`.
    pub name: String,
    /// "Realtime Database is configured in firebase.json; Firenook does not
    /// emulate it yet."
    pub detail: String,
}

/// What the suite hands the console. Every section is here from the start,
/// so a section stream fills in its own module and never edits this struct.
pub struct ConsoleServices {
    /// The running suite's directory.
    pub directory: SuiteDirectory,
    /// The release this engine ships as, read once at startup.
    pub release: EngineRelease,
    /// Flips when the suite stops; every stream the console opens ends on it.
    pub shutdown: Shutdown,
    /// Switches that change what the console can offer.
    pub features: ConsoleFeatures,
    /// Firestore, when the suite runs it.
    pub firestore: Option<FirestoreConsole>,
    /// Authentication, when the suite runs it.
    pub auth: Option<AuthConsole>,
    /// Storage, when the suite runs it.
    pub storage: Option<StorageConsole>,
    /// Functions with Extensions and Eventarc, when the suite runs
    /// Functions: what exists before Functions start (compute adds its
    /// `Monitor`) and the late runtime. Built by
    /// `console_wiring::compute::parts(&config)` before the console.
    pub compute: Option<ComputeParts>,
    /// Pub/Sub, when the suite runs it. Late: built after Functions. The one
    /// `Late` for this runtime: `console_router` clones it into the compute
    /// section.
    pub pubsub: Option<Late<PubsubConsole>>,
    /// Cloud Tasks, which follows Functions. Late; also cloned into the
    /// compute section.
    pub tasks: Option<Late<TasksConsole>>,
    /// Logs and the overview; always present.
    pub observe: ObserveConsole,
    /// Why each absent section is absent, keyed by section id. A section
    /// with no entry reports "This engine was started without <Label>."
    pub absent: BTreeMap<String, AbsentReason>,
    /// Services `firebase.json` configures that Firenook does not emulate.
    pub unsupported: Vec<UnsupportedService>,
    /// Background triggers, persistence facts and export.
    pub suite: SuiteControls,
    /// Project ids requests named that are not the configured one; the
    /// suite's services record into it.
    pub foreign: ForeignProjects,
    /// Hosts the console answers for; every other `Host` is refused, so a
    /// page that rebinds its own name to this machine reaches nothing.
    pub allowed_hosts: AllowedHosts,
    /// The console's bulk work. The suite keeps a clone and stops the jobs
    /// first when it stops.
    pub jobs: JobRegistry,
}

impl ConsoleServices {
    /// A console with the directory alone (no data services), reporting the
    /// release the environment declares, ending its streams on `shutdown`.
    #[must_use]
    pub fn new(directory: SuiteDirectory, shutdown: Shutdown) -> Self {
        Self {
            directory,
            release: EngineRelease::from_environment(),
            shutdown,
            features: ConsoleFeatures::default(),
            firestore: None,
            auth: None,
            storage: None,
            compute: None,
            pubsub: None,
            tasks: None,
            observe: ObserveConsole::detached(),
            absent: BTreeMap::new(),
            unsupported: Vec::new(),
            suite: SuiteControls::detached(),
            foreign: ForeignProjects::default(),
            allowed_hosts: AllowedHosts::loopback(),
            jobs: JobRegistry::new(),
        }
    }
}

/// Every section module the suite runs, in sidebar order of their first
/// section. Compute holds clones of messaging's `Late`s: one per runtime.
fn assemble(services: &mut ConsoleServices) -> Vec<Arc<dyn Section>> {
    let mut sections: Vec<Arc<dyn Section>> = Vec::new();
    if let Some(firestore) = services.firestore.take() {
        sections.push(Arc::new(firestore::FirestoreSection(firestore)));
    }
    if let Some(auth) = services.auth.take() {
        sections.push(Arc::new(auth::AuthSection(auth)));
    }
    if let Some(storage) = services.storage.take() {
        sections.push(Arc::new(storage::StorageSection(storage)));
    }
    if let Some(parts) = services.compute.take() {
        sections.push(Arc::new(compute::ComputeSection {
            parts,
            pubsub: services.pubsub.clone(),
            tasks: services.tasks.clone(),
        }));
    }
    if let Some(pubsub) = services.pubsub.take() {
        sections.push(Arc::new(messaging::PubsubSection(pubsub)));
    }
    if let Some(tasks) = services.tasks.take() {
        sections.push(Arc::new(messaging::TasksSection(tasks)));
    }
    sections.push(Arc::new(observe::ObserveSection(services.observe.clone())));
    sections
}

/// Everything the status is made of, shared by `GET /status` and the
/// `shell` topic.
#[derive(Clone)]
pub(crate) struct StatusSource {
    inner: Arc<StatusInner>,
}

struct StatusInner {
    project: String,
    engine: EngineInfo,
    services: Vec<ServiceStatus>,
    instance: Instance,
    features: ConsoleFeatures,
    unsupported: Vec<UnsupportedService>,
    suite: SuiteControls,
    foreign: ForeignProjects,
    sections: Vec<Arc<dyn Section>>,
    /// Every section id no module answers for, with why.
    absent: Vec<(String, AbsentReason)>,
}

impl StatusSource {
    fn new(
        services: &ConsoleServices,
        instance: Instance,
        sections: Vec<Arc<dyn Section>>,
    ) -> Self {
        let present: Vec<String> = sections
            .iter()
            .flat_map(|section| section.statuses())
            .map(|status| status.id)
            .collect();
        let absent = section_order()
            .iter()
            .filter(|id| !present.contains(id))
            .map(|id| {
                let reason = services
                    .absent
                    .get(id)
                    .cloned()
                    .unwrap_or_else(|| AbsentReason::unknown(id));
                (id.clone(), reason)
            })
            .collect();
        let directory = &services.directory;
        Self {
            inner: Arc::new(StatusInner {
                project: directory.project().to_owned(),
                engine: EngineInfo {
                    name: "Firenook".to_owned(),
                    version: services.release.version().map(str::to_owned),
                    revision: services.release.revision().map(str::to_owned),
                    console_build: console_build(),
                },
                services: directory
                    .services()
                    .map(|service| ServiceStatus {
                        name: service.name.clone(),
                        host: service.host.clone(),
                        port: service.port,
                        listening: service.include_listen,
                        pid: service.pid,
                    })
                    .collect(),
                instance,
                features: services.features,
                unsupported: services.unsupported.clone(),
                suite: services.suite.clone(),
                foreign: services.foreign.clone(),
                sections,
                absent,
            }),
        }
    }

    /// The status as it is now.
    pub(crate) fn status(&self) -> ConsoleStatus {
        let inner = &self.inner;
        let mut sections: Vec<SectionStatus> = Vec::with_capacity(section_order().len());
        for section in &inner.sections {
            for mut status in section.statuses() {
                if status.state == SectionState::Ready {
                    status.summary = section.summary(&status.id);
                }
                sections.push(status);
            }
        }
        sections.extend(
            inner
                .absent
                .iter()
                .map(|(id, reason)| SectionStatus::absent(id, reason)),
        );
        sections.sort_by_key(|status| section_rank(&status.id));
        ConsoleStatus {
            project_id: inner.project.clone(),
            engine: inner.engine.clone(),
            services: inner.services.clone(),
            instance: inner.instance.id.clone(),
            started_at: inner.instance.started_at.clone(),
            sections,
            features: inner.features,
            unsupported: inner.unsupported.clone(),
            background_triggers: inner.suite.background_triggers(),
            data: inner.suite.data(),
            foreign_projects: inner.foreign.snapshot(),
        }
    }

    /// Ticks whenever the status may have changed.
    pub(crate) fn changes(&self) -> BoxStream<'static, ()> {
        let suite = self.inner.suite.changes();
        let foreign = WatchStream::from_changes(self.inner.foreign.changes())
            .map(|_| ())
            .boxed();
        futures_util::stream::select_all(
            self.inner
                .sections
                .iter()
                .filter_map(|section| section.status_changes())
                .chain([suite, foreign]),
        )
        .boxed()
    }

    /// The topic prefixes of absent sections, with the service that turns
    /// each on, for the live hub's refusals.
    fn absent_topics(&self) -> BTreeMap<&'static str, &'static str> {
        section_order()
            .iter()
            .filter(|id| self.inner.absent.iter().any(|(absent, _)| absent == *id))
            .map(|id| (id.as_str(), section_service(id.as_str())))
            .collect()
    }

    /// A status over `services` alone, for tests of what reads it.
    #[cfg(test)]
    pub(crate) fn for_tests(mut services: ConsoleServices) -> Self {
        let sections = assemble(&mut services);
        Self::new(&services, Instance::new(), sections)
    }
}

/// The console router: the Console API under `/api/v1` and the embedded
/// application for every other path. Mount it under [`CONSOLE_PATH`], from
/// within the suite's Tokio runtime (sections start their background tasks
/// here, each ending on the stop signal).
///
/// Every section the suite runs is a module (`section.rs`); the status
/// lists all of them in the one sidebar order, with why each absent one is
/// absent. One request guard covers the whole mount (`guard.rs`): the
/// `Host` must be one the console answers for, and the Console API takes
/// calls only from the console itself, mutations only with JSON or the
/// console header, and streams and sockets only from its own origin. A
/// service's own application mounted here (Firestore REST, Identity
/// Toolkit, `/<section>/native`) keeps that service's semantics and gets
/// the `Host` rule only.
///
/// The live channel (`/api/v1/live`) is the only route that streams: every
/// page's live updates are topics on it (`live/`).
pub fn console_router(mut services: ConsoleServices) -> Router {
    let instance = Instance::new();
    let context = SectionContext {
        project: Arc::from(services.directory.project()),
        shutdown: services.shutdown.clone(),
        badges: BadgeBoard::default(),
        instance: instance.clone(),
        jobs: services.jobs.clone(),
        rings: RingBudget::shared(),
        foreign: services.foreign.clone(),
    };
    spawn_foreign_badge(&context);
    context
        .jobs
        .attach(&context.badges, context.shutdown.clone());
    let sections = assemble(&mut services);
    let status = StatusSource::new(&services, instance.clone(), sections.clone());
    let mut topics: Vec<Arc<dyn live::LiveTopic>> = vec![
        Arc::new(live::shell::ShellTopic::new(
            status.clone(),
            context.badges.clone(),
        )),
        Arc::new(context.jobs.topic()),
    ];
    for section in &sections {
        topics.extend(section.topics(&context));
    }
    let hub = live::LiveHub::new(
        topics,
        status.absent_topics(),
        live::HelloFacts {
            instance,
            console_build: console_build(),
            engine_revision: services.release.revision().map(str::to_owned),
        },
        services.shutdown.clone(),
    );
    let sources = sections
        .iter()
        .filter_map(|section| section.search(&context))
        .collect();
    let mut api = Router::new()
        .route("/status", get(status_route))
        .with_state(status)
        .merge(search::Search::new(sources).router())
        .merge(suite::memory_router(context.rings.clone()))
        .merge(services.suite.router())
        .merge(suite::clear_router(
            sections.clone(),
            context.jobs.clone(),
            context.project.clone(),
        ))
        .merge(context.jobs.router())
        .merge(hub.router());
    for section in &sections {
        api = api.merge(section.router(&context));
    }
    // The older native addresses; every `/<section>/native` mount is one
    // by convention.
    let mut natives = guard::NativeMounts::default();
    for prefix in firestore::REST_PREFIXES {
        natives.add(&format!("/api/v1/firestore{prefix}"));
    }
    for path in auth::NATIVE_PATHS {
        natives.add(&format!("/api/v1/auth{path}"));
    }
    let policy = guard::GuardPolicy {
        hosts: services.allowed_hosts,
        natives: Arc::new(natives),
    };
    Router::new()
        .nest("/api/v1", api)
        .route("/api/{*rest}", any(unknown_api))
        .fallback(asset)
        .layer(axum::middleware::from_fn_with_state(policy, guard::guard))
}

/// Keeps the `shell.foreign` badge at the number of foreign project ids
/// seen, from now until the suite stops.
fn spawn_foreign_badge(context: &SectionContext) {
    let badge = context.badges.handle(
        "shell.foreign",
        BadgeKind::Gauge,
        BadgeNoun::new(
            "project your app uses is not this emulator's",
            "projects your app uses are not this emulator's",
        ),
    );
    let foreign = context.foreign.clone();
    let publish = move |badge: &live::badges::BadgeHandle| {
        let count = u64::try_from(foreign.count()).unwrap_or(u64::MAX);
        let tone = if count == 0 {
            BadgeTone::Neutral
        } else {
            BadgeTone::Danger
        };
        badge.set(count, tone);
    };
    let mut changes = context.foreign.changes();
    publish(&badge);
    let stopped = context.shutdown.clone().stopped();
    tokio::spawn(async move {
        tokio::pin!(stopped);
        loop {
            tokio::select! {
                biased;
                () = &mut stopped => break,
                news = changes.changed() => {
                    if news.is_err() {
                        break;
                    }
                    publish(&badge);
                }
            }
        }
    });
}

/// A hash of the console application this engine serves (its `index.html`,
/// which names every hashed asset), so a page can tell an engine that was
/// updated from one that restarted.
fn console_build() -> String {
    Assets::get("index.html").map_or_else(
        || "unbuilt".to_owned(),
        |index| {
            let mut hasher = std::collections::hash_map::DefaultHasher::new();
            index.data.hash(&mut hasher);
            format!("{:016x}", hasher.finish())
        },
    )
}

async fn status_route(State(status): State<StatusSource>) -> Json<ConsoleStatus> {
    Json(status.status())
}

async fn unknown_api(uri: Uri) -> ApiError {
    ApiError::not_found(format!("unknown console API route: {}", uri.path()))
}

/// Serves a built file, or the application shell for any path the client
/// router owns. Hashed build assets are immutable; the shell never caches.
async fn asset(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    if !path.is_empty()
        && !path.split('/').any(|segment| segment == "..")
        && let Some(file) = Assets::get(path)
    {
        return serve(path, file);
    }
    match Assets::get("index.html") {
        Some(index) => serve("index.html", index),
        None => not_built(),
    }
}

fn serve(path: &str, file: EmbeddedFile) -> Response {
    let cache = if path.starts_with("assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    (
        [
            (header::CONTENT_TYPE, file.metadata.mimetype().to_owned()),
            (header::CACHE_CONTROL, cache.to_owned()),
        ],
        file.data,
    )
        .into_response()
}

fn not_built() -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        [(header::CACHE_CONTROL, "no-store")],
        Html(NOT_BUILT_PAGE),
    )
        .into_response()
}

const NOT_BUILT_PAGE: &str = "<!doctype html><meta charset=\"utf-8\"><title>Firenook console</title>\
<style>body{font:14px/1.5 system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;color:#1f2328}code{font-size:.9em}</style>\
<h1>The console is not built into this engine</h1>\
<p>This binary was compiled without the console's build output. From the repository root run \
<code>npm ci --prefix console &amp;&amp; npm run build --prefix console</code> and rebuild the engine, \
or work on the console with <code>npm run dev --prefix console</code>, which proxies this engine's console API.</p>";

#[cfg(test)]
mod generated_names;
#[cfg(test)]
mod router_tests;

#[cfg(test)]
mod tests {
    use axum::body::{Body, to_bytes};
    use axum::http::Request;
    use firenook_suite_front::ServiceInfo;
    use tower::ServiceExt as _;

    use super::*;

    fn directory() -> SuiteDirectory {
        SuiteDirectory::new(
            "demo-console",
            [
                ServiceInfo::listening("hub", "127.0.0.1", 34_400),
                ServiceInfo::listening("firestore", "127.0.0.1", 38_080),
                ServiceInfo::dependency("tasks", "127.0.0.1", 39_499),
            ],
        )
        .expect("valid directory")
    }

    const REVISION: &str = "63d554c15f2699cf623c7fac19a4d1393c77f322";

    /// A console that reports the release a distribution declared. The test
    /// never reads the process environment: a release is data the launcher
    /// supplies, so the test supplies it too.
    fn services(release: EngineRelease) -> ConsoleServices {
        ConsoleServices {
            release,
            ..ConsoleServices::new(directory(), running())
        }
    }

    /// A console with the directory alone and no declared release.
    pub(crate) fn directory_services() -> ConsoleServices {
        services(EngineRelease::default())
    }

    /// A stop signal that never fires: its sender lives as long as the test
    /// process, so streams opened in a test end only when dropped.
    pub(crate) fn running() -> Shutdown {
        let (stop, receiver) = tokio::sync::watch::channel(false);
        std::mem::forget(stop);
        Shutdown::new(receiver)
    }

    async fn call(uri: &str) -> (StatusCode, axum::http::HeaderMap, Vec<u8>) {
        call_as(
            uri,
            EngineRelease::declared(Some("0.2.0-next.2"), Some(REVISION)),
        )
        .await
    }

    async fn call_as(
        uri: &str,
        release: EngineRelease,
    ) -> (StatusCode, axum::http::HeaderMap, Vec<u8>) {
        let response = console_router(services(release))
            .oneshot(Request::get(uri).body(Body::empty()).expect("request"))
            .await
            .expect("response");
        let status = response.status();
        let headers = response.headers().clone();
        let body = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body")
            .to_vec();
        (status, headers, body)
    }

    /// Where the console reads its generated types from.
    pub(crate) const GENERATED: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../console/src/api/generated"
    );

    /// Writes every TypeScript binding the console reads into `config`'s
    /// directory: the foundation's types, then each section module's.
    pub(crate) fn export_all_bindings(config: &ts_rs::Config) {
        ConsoleStatus::export_all(config).expect("TypeScript bindings written");
        ChangeBatch::export_all(config).expect("TypeScript bindings written");
        ChangeHello::export_all(config).expect("TypeScript bindings written");
        SchemaSnapshot::export_all(config).expect("TypeScript bindings written");
        SubcollectionsSnapshot::export_all(config).expect("TypeScript bindings written");
        DatabaseList::export_all(config).expect("TypeScript bindings written");
        Explanation::export_all(config).expect("TypeScript bindings written");
        RulesDocument::export_all(config).expect("TypeScript bindings written");
        RulesInstalled::export_all(config).expect("TypeScript bindings written");
        RulesDiagnostic::export_all(config).expect("TypeScript bindings written");
        RulesCheck::export_all(config).expect("TypeScript bindings written");
        RulesVersion::export_all(config).expect("TypeScript bindings written");
        RulesChanged::export_all(config).expect("TypeScript bindings written");
        RulesFileStatus::export_all(config).expect("TypeScript bindings written");
        ApiErrorBody::export_all(config).expect("TypeScript bindings written");
        ExportDestination::export_all(config).expect("TypeScript bindings written");
        ExportResult::export_all(config).expect("TypeScript bindings written");
        MemoryReport::export_all(config).expect("TypeScript bindings written");
        JobList::export_all(config).expect("TypeScript bindings written");
        BulkTarget::export_all(config).expect("TypeScript bindings written");
        ClearReport::export_all(config).expect("TypeScript bindings written");
        EntityRef::export_all(config).expect("TypeScript bindings written");
        Page::<()>::export_all(config).expect("TypeScript bindings written");
        BatchGetRequest::export_all(config).expect("TypeScript bindings written");
        BatchGetResponse::<()>::export_all(config).expect("TypeScript bindings written");
        ListMeta::export_all(config).expect("TypeScript bindings written");
        SearchResults::export_all(config).expect("TypeScript bindings written");
        live::export_bindings(config);
        auth::export_bindings(config);
        storage::export_bindings(config);
        compute::export_bindings(config);
        messaging::export_bindings(config);
        observe::export_bindings(config);
    }

    #[test]
    fn export_bindings() {
        let out = GENERATED;
        export_all_bindings(&ts_rs::Config::new().with_out_dir(out));
        let written = std::fs::read_to_string(format!("{out}/ConsoleStatus.ts")).expect("read");
        assert!(written.contains("projectId: string"), "{written}");
        assert!(
            written.contains("services: Array<ServiceStatus>"),
            "{written}"
        );
        assert!(
            written.contains("sections: Array<SectionStatus>"),
            "{written}"
        );
        let figure = std::fs::read_to_string(format!("{out}/SummaryFigure.ts")).expect("read");
        assert!(figure.contains("value: number | null"), "{figure}");
        // Generic types are written once, generic.
        let page = std::fs::read_to_string(format!("{out}/Page.ts")).expect("read");
        assert!(page.contains("export type Page<T>"), "{page}");
        assert!(page.contains("items: Array<T>"), "{page}");
        let batch = std::fs::read_to_string(format!("{out}/BatchGetResponse.ts")).expect("read");
        assert!(batch.contains("BatchGetResponse<T>"), "{batch}");
        let badge = std::fs::read_to_string(format!("{out}/live/Badge.ts")).expect("read");
        assert!(badge.contains("cursor?: string"), "{badge}");
        // Live types live in their own directory and import root types
        // with a relative path.
        let refusal = std::fs::read_to_string(format!("{out}/live/LiveRefusal.ts")).expect("read");
        assert!(refusal.contains("from \"../ApiErrorDetail\""), "{refusal}");
    }

    #[tokio::test]
    async fn status_reports_the_project_and_every_service_in_name_order() {
        let (status, headers, body) = call("/api/v1/status").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(headers[header::CONTENT_TYPE], "application/json");
        let value: serde_json::Value = serde_json::from_slice(&body).expect("json");
        assert_eq!(value["projectId"], "demo-console");
        assert_eq!(value["engine"]["name"], "Firenook");
        assert_eq!(value["engine"]["version"], "0.2.0-next.2");
        assert_eq!(value["engine"]["revision"], REVISION);
        let names: Vec<&str> = value["services"]
            .as_array()
            .expect("services")
            .iter()
            .map(|service| service["name"].as_str().expect("name"))
            .collect();
        assert_eq!(names, ["firestore", "hub", "tasks"]);
        assert_eq!(value["services"][0]["port"], 38_080);
        assert_eq!(value["services"][0]["listening"], true);
        assert_eq!(value["services"][2]["listening"], false);
        assert_eq!(value["services"][2]["pid"], serde_json::Value::Null);
        let instance = value["instance"].as_str().expect("instance");
        assert_eq!(instance.len(), 16);
        assert!(
            ::time::OffsetDateTime::parse(
                value["startedAt"].as_str().expect("startedAt"),
                &::time::format_description::well_known::Rfc3339
            )
            .is_ok()
        );
        let build = value["engine"]["consoleBuild"].as_str().expect("build");
        assert!(build == "unbuilt" || build.len() == 16, "{build}");
        assert_eq!(
            value["features"],
            serde_json::json!({ "diagnostics": false })
        );
        assert_eq!(value["unsupported"], serde_json::json!([]));
        // A console without a suite: triggers on, data in memory, no
        // foreign project.
        assert_eq!(
            value["backgroundTriggers"],
            serde_json::json!({ "enabled": true, "since": null, "dropped": [] })
        );
        assert_eq!(value["data"]["mode"], "memory");
        assert_eq!(value["data"]["stateDir"], serde_json::Value::Null);
        assert_eq!(value["foreignProjects"], serde_json::json!([]));
    }

    #[tokio::test]
    async fn the_status_carries_the_suites_switches_data_and_foreign_projects() {
        let triggers = firenook_functions_bridge::TriggerRegistry::default();
        let (exporter, _exports) = tokio::sync::mpsc::channel(1);
        let foreign = ForeignProjects::default();
        foreign.record("my-prod", "firestore");
        let services = || ConsoleServices {
            suite: SuiteControls::new(SuiteSettings {
                triggers: triggers.clone(),
                background: None,
                exporter: exporter.clone(),
                data: DataFacts {
                    mode: DataMode::Disk,
                    state_dir: Some("/work/state".to_owned()),
                    resumed: true,
                    imported_from: None,
                    export_on_exit: Some("/work/export".to_owned()),
                    durability: "per-commit".to_owned(),
                },
                destinations: Vec::new(),
            }),
            foreign: foreign.clone(),
            ..directory_services()
        };
        triggers.set_background_enabled(false);
        let status = status_of(services()).await;
        assert_eq!(status["backgroundTriggers"]["enabled"], false);
        assert_eq!(status["data"]["mode"], "disk");
        assert_eq!(status["data"]["stateDir"], "/work/state");
        assert_eq!(status["data"]["resumed"], true);
        assert_eq!(status["data"]["exportOnExit"], "/work/export");
        assert_eq!(status["data"]["durability"], "per-commit");
        assert_eq!(status["foreignProjects"][0]["projectId"], "my-prod");
        assert_eq!(
            status["foreignProjects"][0]["services"],
            serde_json::json!(["firestore"])
        );
        assert_eq!(status["foreignProjects"][0]["requests"], 1);
    }

    async fn status_of(services: ConsoleServices) -> serde_json::Value {
        let response = console_router(services)
            .oneshot(
                Request::get("/api/v1/status")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body");
        serde_json::from_slice(&body).expect("json")
    }

    fn section<'a>(status: &'a serde_json::Value, id: &str) -> &'a serde_json::Value {
        status["sections"]
            .as_array()
            .expect("sections")
            .iter()
            .find(|section| section["id"] == id)
            .unwrap_or_else(|| panic!("{id} in {status}"))
    }

    #[tokio::test]
    async fn every_section_is_listed_in_sidebar_order_absent_with_why_and_how() {
        let storage_reason = AbsentReason {
            kind: AbsentKind::NotConfigured,
            detail: "firebase.json does not configure Storage.".to_owned(),
            fixes: vec![SectionFix {
                label: "Add it to firebase.json".to_owned(),
                kind: SectionFixKind::FirebaseJson,
                text: "\"emulators\": { \"storage\": {} }".to_owned(),
            }],
        };
        let status = status_of(ConsoleServices {
            absent: BTreeMap::from([("storage".to_owned(), storage_reason)]),
            unsupported: vec![UnsupportedService {
                name: "database".to_owned(),
                detail: "Realtime Database is configured in firebase.json; Firenook does not emulate it yet.".to_owned(),
            }],
            features: ConsoleFeatures { diagnostics: true },
            ..directory_services()
        })
        .await;
        let ids: Vec<&str> = status["sections"]
            .as_array()
            .expect("sections")
            .iter()
            .map(|section| section["id"].as_str().expect("id"))
            .collect();
        assert_eq!(
            ids,
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
        let storage = section(&status, "storage");
        assert_eq!(storage["state"], "absent");
        assert_eq!(storage["reason"], "not-configured");
        assert_eq!(
            storage["detail"],
            "firebase.json does not configure Storage."
        );
        assert_eq!(storage["fixes"][0]["kind"], "firebase-json");
        // No reason given: the generic sentence, and no fix.
        let auth = section(&status, "auth");
        assert_eq!(auth["reason"], "unknown");
        assert_eq!(
            auth["detail"],
            "This engine was started without Authentication."
        );
        assert_eq!(auth["fixes"], serde_json::json!([]));
        // Logs are always there.
        let logs = section(&status, "logs");
        assert_eq!(logs["state"], "ready");
        assert_eq!(logs["reason"], serde_json::Value::Null);
        assert_eq!(status["features"]["diagnostics"], true);
        assert_eq!(status["unsupported"][0]["name"], "database");
    }

    #[tokio::test]
    async fn late_sections_start_then_serve() {
        let parts = ComputeParts::new();
        let pubsub = Late::pending("Pub/Sub");
        let tasks = Late::pending("Cloud Tasks");
        let services = || ConsoleServices {
            compute: Some(parts.clone()),
            pubsub: Some(pubsub.clone()),
            tasks: Some(tasks.clone()),
            ..directory_services()
        };
        let status = status_of(services()).await;
        for id in ["functions", "extensions", "eventarc", "pubsub", "tasks"] {
            assert_eq!(section(&status, id)["state"], "starting", "{id}");
            assert!(section(&status, id)["detail"].is_string(), "{id}");
        }
        let router = console_router(services());
        let starting = router
            .clone()
            .oneshot(
                Request::get("/api/v1/functions/native/backends")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(starting.status(), StatusCode::SERVICE_UNAVAILABLE);
        parts.late.set(ComputeConsole {
            functions: Router::new().route("/backends", get(|| async { "backends" })),
            eventarc: Router::new(),
        });
        pubsub.set(PubsubConsole {
            native: Router::new(),
        });
        let status = status_of(services()).await;
        for id in ["functions", "extensions", "eventarc", "pubsub"] {
            assert_eq!(section(&status, id)["state"], "ready", "{id}");
        }
        assert_eq!(section(&status, "tasks")["state"], "starting");
        let served = router
            .oneshot(
                Request::get("/api/v1/functions/native/backends")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(served.status(), StatusCode::OK);
        assert_eq!(served.headers()[header::CONTENT_SECURITY_POLICY], "sandbox");
    }

    #[tokio::test]
    async fn the_firestore_summary_delegates_to_observe_which_counts_nothing_yet() {
        let store = firenook_core_store::Store::default();
        let status = status_of(ConsoleServices {
            firestore: Some(router_tests::firestore_console(&store)),
            ..directory_services()
        })
        .await;
        let firestore = section(&status, "firestore");
        assert_eq!(firestore["state"], "ready");
        assert_eq!(firestore["summary"], serde_json::Value::Null);
    }

    #[tokio::test]
    async fn an_unknown_route_under_a_section_prefix_is_json() {
        let (status, headers, body) = call("/api/v1/storage/nothing").await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(headers[header::CONTENT_TYPE], "application/json");
        let value: serde_json::Value = serde_json::from_slice(&body).expect("json");
        assert_eq!(value["error"]["code"], "not-found");
    }

    #[tokio::test]
    async fn an_engine_nobody_released_reports_no_version_rather_than_the_placeholder() {
        let (status, _, body) = call_as("/api/v1/status", EngineRelease::default()).await;
        assert_eq!(status, StatusCode::OK);
        let value: serde_json::Value = serde_json::from_slice(&body).expect("json");
        assert_eq!(value["engine"]["version"], serde_json::Value::Null);
        assert_eq!(value["engine"]["revision"], serde_json::Value::Null);
        // Narrowed to the engine object: `127.0.0.1` contains the
        // placeholder as a substring, so the whole body cannot be scanned.
        let engine = value["engine"].to_string();
        assert!(
            !engine.contains(env!("CARGO_PKG_VERSION")),
            "the workspace placeholder must never reach the console: {engine}"
        );
    }

    #[tokio::test]
    async fn unknown_api_routes_answer_json_not_the_shell() {
        let (status, headers, body) = call("/api/v1/nothing").await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(headers[header::CONTENT_TYPE], "application/json");
        let value: serde_json::Value = serde_json::from_slice(&body).expect("json");
        assert_eq!(
            value["error"]["message"],
            "unknown console API route: /api/v1/nothing"
        );
        assert_eq!(value["error"]["code"], "not-found");
    }

    #[tokio::test]
    async fn every_client_route_serves_the_shell_and_hashed_assets_are_immutable() {
        let Some(index) = Assets::get("index.html") else {
            assert!(
                std::env::var_os("CI").is_none(),
                "CI must build the console before the Rust checks"
            );
            let (status, _, body) = call("/firestore").await;
            assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
            assert!(String::from_utf8_lossy(&body).contains("not built"));
            return;
        };
        for uri in ["/", "/firestore", "/auth/users/abc", "/not/a/file.html"] {
            let (status, headers, body) = call(uri).await;
            assert_eq!(status, StatusCode::OK, "{uri}");
            assert_eq!(headers[header::CACHE_CONTROL], "no-cache", "{uri}");
            assert!(
                headers[header::CONTENT_TYPE]
                    .to_str()
                    .expect("utf8")
                    .starts_with("text/html")
            );
            assert_eq!(body, index.data.as_ref(), "{uri}");
        }
        let hashed = Assets::iter()
            .find(|name| name.starts_with("assets/") && name.ends_with(".js"))
            .expect("a built script");
        let (status, headers, _) = call(&format!("/{hashed}")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            headers[header::CACHE_CONTROL],
            "public, max-age=31536000, immutable"
        );
        assert!(
            headers[header::CONTENT_TYPE]
                .to_str()
                .expect("utf8")
                .contains("javascript")
        );
        let (status, _, _) = call("/assets/../index.html").await;
        assert_eq!(status, StatusCode::OK, "traversal falls back to the shell");
    }
}
