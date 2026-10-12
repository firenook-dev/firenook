//! Firestore in the console: the same-origin REST surface the workbench
//! reads and writes through, a live change feed fed by the store's commit
//! observers, and the Requests diagnostics feed.
//!
//! The change feed is the live channel's `firestore.changes` topic. From
//! the first subscription in the engine's life it records every commit's
//! document paths in a ring (never the documents), even while nobody is
//! subscribed, so a console tab that reconnects or comes back from the
//! background gets the commits it missed replayed and refetches only the
//! queries they touch. A headless run that never opens the console pays
//! nothing for it.
//!
//! Everything here is reachable under the console's own origin, so the
//! workbench works wherever the console page itself loads from (a plain
//! port, a reverse proxy, an HTTPS alias); nothing in the browser needs the
//! Firestore port.

use std::collections::{BTreeSet, HashMap};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};

use axum::Router;
use axum::extract::{Query, State};
use axum::response::IntoResponse;
use axum::response::sse::Event;
use firenook_core_store::{
    Change, CommitObservation, CommitObserver, CommitOrigin, DocumentKey, Store, Timestamp,
};
use firenook_suite_front::replay::random_epoch;
use firenook_suite_front::{Cursor, Entry, ReplayRing, RingBudget, RingLimits};
use futures_util::future::BoxFuture;
use futures_util::stream::{self, BoxStream, StreamExt as _};
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::wrappers::errors::BroadcastStreamRecvError;
use ts_rs::TS;

use crate::api_error::ApiError;
use crate::databases::DatabaseCatalog;
use crate::explain::QueryExplainer;
use crate::firestore_search::FirestoreSearch;
use crate::http::forwarded;
use crate::jobs::JobHandle;
use crate::live::badges::{BadgeKind, BadgeNoun};
use crate::live::replay::{ReplayOptions, replay_topic};
use crate::live::{LiveTopic, ResetReason, TopicEvent, TopicStream, topic_params};
use crate::observe::firestore_data::FirestoreData;
use crate::rules::RulesEditor;
use crate::rules_eval::RulesEvaluator;
use crate::schema::SchemaIndex;
use crate::search::SearchSource;
use crate::section::{
    ClearOptions, ClearReport, Section, SectionContext, SectionStatus, SectionSummary,
};
use crate::sse::{Shutdown, json_event, sse_response};
use crate::time::rfc3339;

/// Commits retained for a slow console before it is told to resync (the
/// legacy `/changes` stream).
const FEED_CAPACITY: usize = 512;

/// What the change ring keeps: 20,000 batches or 4 MiB of paths, and never
/// fewer than 2,000 batches when the process's rings share out memory.
const CHANGE_RING: RingLimits = RingLimits {
    entries: 20_000,
    bytes: 4 * 1024 * 1024,
    floor: 2_000,
};

/// A commit that touches more documents is recorded as the collections it
/// touched, and so is a window that merges more keys than this.
const KEYS_PER_BATCH: usize = 500;

/// Keys one subscriber's window may carry; a burst past it is a `reset`.
const KEYS_PER_WINDOW: usize = 1_000;

/// Where the Firestore REST front answers under `/firestore`: the protocol's
/// own paths (`/v1/projects/…`) and the emulator's (`/emulator/v1/…`). They
/// are a native mount, which the request guard leaves to the REST front's
/// own semantics.
pub(crate) const REST_PREFIXES: [&str; 2] = ["/v1", "/emulator"];

/// The Firestore services the console mounts.
#[derive(Clone)]
pub struct FirestoreConsole {
    /// A REST front sharing the engine's service, nested under
    /// `/api/v1/firestore` so the Firestore REST protocol is same-origin.
    pub rest: Router,
    /// The live change feed, already registered with the store.
    pub changes: ChangeFeed,
    /// The schema index, already registered with the store.
    pub schema: SchemaIndex,
    /// The project's databases, declared and written.
    pub databases: DatabaseCatalog,
    /// How a query runs and what it would require in production.
    pub explain: QueryExplainer,
    /// The security rules, as text that can be changed.
    pub rules: RulesEditor,
    /// Dry runs, recorded decisions explained, and a draft's impact.
    pub rules_evaluator: RulesEvaluator,
    /// The Requests diagnostics feed (`/requests` upgrades to a websocket),
    /// when the Firestore front records evaluations.
    pub requests: Option<Router>,
}

/// One atomic commit as the console sees it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ChangeBatch {
    /// Store revision the commit installed.
    #[ts(type = "number")]
    pub revision: u64,
    /// Commit time, RFC 3339.
    pub commit_time: String,
    /// Every document the commit changed, in write order.
    pub changes: Vec<DocumentChange>,
    /// Set when the commit, or the commits a live window merged, touched
    /// more documents than are listed one by one: `changes` is then empty
    /// and `collections` names every collection touched. Reload them.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub truncated: Option<bool>,
    /// The collections a truncated batch touched.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub collections: Option<Vec<ChangedCollection>>,
}

/// A collection a truncated batch touched.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ChangedCollection {
    /// Database id, for example `(default)`.
    pub database: String,
    /// Relative collection path, for example `users` or a subcollection
    /// under one document.
    pub path: String,
}

/// One document transition inside a commit.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DocumentChange {
    /// Database id, for example `(default)`.
    pub database: String,
    /// Relative document path, for example `users/u_9f3k2`.
    pub path: String,
    /// What happened to the document.
    pub kind: ChangeKind,
}

/// The transition a change describes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum ChangeKind {
    Created,
    Updated,
    Deleted,
}

/// The first event on a change stream: where the store is now, so the
/// console knows which revision its data corresponds to.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ChangeHello {
    /// Current store revision.
    #[ts(type = "number")]
    pub revision: u64,
}

/// Records store commits for the `firestore.changes` topic, and fans them
/// out to every open legacy change stream. Housekeeping commits (a reset's
/// batches) are not recorded: the reset announces the database rebuilt
/// once when it starts and once when it ends instead, so an open page
/// reloads twice rather than once per batch.
#[derive(Clone)]
pub struct ChangeFeed {
    sender: broadcast::Sender<Arc<ChangeBatch>>,
    /// Databases announced rebuilt, for the legacy change streams.
    rebuilt: broadcast::Sender<Arc<str>>,
    /// Firestore's figures for the Overview, kept from the same commits.
    data: FirestoreData,
    store: Store,
    /// Path-only batches, recorded from the first subscription on.
    recorded: ReplayRing<ChangeMeta>,
    recording: Arc<AtomicBool>,
}

/// One recorded commit: the keys it touched, which the store already holds,
/// so recording costs no copy of a path.
#[derive(Clone, Debug)]
pub(crate) struct ChangeMeta {
    revision: u64,
    commit_time: Timestamp,
    touched: Touched,
}

#[derive(Clone, Debug)]
enum Touched {
    /// The common case, without an allocation.
    One(DocumentKey, ChangeKind),
    Many(Arc<[(DocumentKey, ChangeKind)]>),
    /// A commit over [`KEYS_PER_BATCH`] documents: its collections.
    Collections(Arc<[(Arc<str>, String)]>),
    /// The database was rewritten in bulk: whoever shows it reloads.
    Rebuilt(Arc<str>),
}

impl Touched {
    /// What the ring counts for it: the paths, with a little for the rest.
    fn weight(&self) -> usize {
        const OVERHEAD: usize = 16;
        let key = |key: &DocumentKey| key.database().database_id().len() + key.path().len();
        match self {
            Self::One(document, _) => key(document) + OVERHEAD,
            Self::Many(documents) => documents
                .iter()
                .map(|(document, _)| key(document) + OVERHEAD)
                .sum(),
            Self::Collections(collections) => collections
                .iter()
                .map(|(database, path)| database.len() + path.len() + OVERHEAD)
                .sum(),
            Self::Rebuilt(database) => database.len() + OVERHEAD,
        }
    }
}

fn kind_of(change: &Change) -> ChangeKind {
    match (&change.before, &change.after) {
        (None, Some(_)) => ChangeKind::Created,
        (Some(_), None) => ChangeKind::Deleted,
        _ => ChangeKind::Updated,
    }
}

/// The collection a document path lies in.
fn collection_of(path: &str) -> &str {
    path.rsplit_once('/')
        .map_or(path, |(collection, _)| collection)
}

/// The JSON every recorded batch carries: none. The topic builds each
/// subscriber's batch from the keys, filtered by its scope.
fn no_json() -> Arc<str> {
    static EMPTY: OnceLock<Arc<str>> = OnceLock::new();
    EMPTY.get_or_init(|| Arc::from("")).clone()
}

/// What the change stream handler needs: the feed and the suite's stop
/// signal, which ends every open stream so a console tab never holds the UI
/// listener's graceful shutdown open.
#[derive(Clone)]
struct ChangeStreams {
    feed: ChangeFeed,
    shutdown: Shutdown,
}

impl ChangeFeed {
    /// Creates the feed and registers it with `store`.
    #[must_use]
    pub fn attach(store: &Store) -> Self {
        let (sender, _) = broadcast::channel(FEED_CAPACITY);
        let (rebuilt, _) = broadcast::channel(FEED_CAPACITY);
        let feed = Self {
            sender,
            rebuilt,
            data: FirestoreData::default(),
            store: store.clone(),
            recorded: ReplayRing::new(
                "firestore.changes",
                CHANGE_RING,
                random_epoch(),
                &RingBudget::shared(),
            ),
            recording: Arc::new(AtomicBool::new(false)),
        };
        store.add_commit_observer(Arc::new(feed.clone()));
        feed
    }

    /// The `firestore.changes` topic over this feed.
    pub(crate) fn topic(&self) -> ChangesTopic {
        ChangesTopic { feed: self.clone() }
    }

    /// Firestore's figures for the Overview, kept from this feed's commits.
    pub(crate) const fn data(&self) -> &FirestoreData {
        &self.data
    }

    /// The store this feed observes.
    pub(crate) const fn store(&self) -> &Store {
        &self.store
    }

    /// Tells every open view of `database` (and every view of all
    /// databases) to reload what it shows: its documents were rewritten in
    /// bulk by commits this feed does not record one by one (a reset). A
    /// subscriber that resumes from a cursor before the announcement is
    /// told too.
    pub fn announce_rebuilt(&self, database: &str) {
        if self.recording.load(Ordering::Relaxed) {
            let touched = Touched::Rebuilt(Arc::from(database));
            let weight = touched.weight();
            self.recorded.push_weighted(
                ChangeMeta {
                    revision: self.store.revision().get(),
                    commit_time: now(),
                    touched,
                },
                no_json(),
                weight,
            );
        }
        // A send only fails when no legacy stream is open.
        let _ = self.rebuilt.send(Arc::from(database));
    }

    /// Records one commit's keys, cheaply: one ring push under a short lock,
    /// never waiting on a subscriber.
    fn record(&self, observation: &CommitObservation) {
        let touched = match observation.changes.as_slice() {
            [] => return,
            [change] => Touched::One(change.key.clone(), kind_of(change)),
            changes if changes.len() <= KEYS_PER_BATCH => Touched::Many(
                changes
                    .iter()
                    .map(|change| (change.key.clone(), kind_of(change)))
                    .collect(),
            ),
            changes => {
                let mut collections = BTreeSet::new();
                for change in changes {
                    collections.insert((
                        change.key.database().database_id(),
                        collection_of(change.key.path()),
                    ));
                }
                Touched::Collections(
                    collections
                        .into_iter()
                        .map(|(database, path)| (Arc::from(database), path.to_owned()))
                        .collect(),
                )
            }
        };
        let weight = touched.weight();
        self.recorded.push_weighted(
            ChangeMeta {
                revision: observation.result.revision.get(),
                commit_time: observation.result.commit_time,
                touched,
            },
            no_json(),
            weight,
        );
    }

    fn router(self, shutdown: Shutdown) -> Router {
        Router::new()
            .route("/changes", axum::routing::get(changes))
            .with_state(ChangeStreams {
                feed: self,
                shutdown,
            })
    }
}

impl CommitObserver for ChangeFeed {
    fn committed(&self, observation: &CommitObservation) {
        self.data.committed(observation);
        if observation.origin == CommitOrigin::Maintenance {
            return;
        }
        if self.recording.load(Ordering::Relaxed) {
            self.record(observation);
        }
        if self.sender.receiver_count() == 0 {
            return;
        }
        let batch = ChangeBatch {
            revision: observation.result.revision.get(),
            commit_time: rfc3339(observation.result.commit_time),
            changes: observation
                .changes
                .iter()
                .map(|change| DocumentChange {
                    database: change.key.database().database_id().to_owned(),
                    path: change.key.path().to_owned(),
                    kind: match (&change.before, &change.after) {
                        (None, Some(_)) => ChangeKind::Created,
                        (Some(_), None) => ChangeKind::Deleted,
                        _ => ChangeKind::Updated,
                    },
                })
                .collect(),
            truncated: None,
            collections: None,
        };
        // A send only fails when no stream is open; nothing to retain then.
        let _ = self.sender.send(Arc::new(batch));
    }
}

/// Which changes one stream wants.
#[derive(Debug, Default, Deserialize)]
pub(crate) struct ChangeScope {
    /// Database id; every database when absent.
    database: Option<String>,
    /// A document or collection path; a change matches when its path is the
    /// scope or lies under it. Empty means everything.
    #[serde(default)]
    scope: String,
}

impl ChangeScope {
    fn matches(&self, change: &DocumentChange) -> bool {
        self.matches_document(&change.database, &change.path)
    }

    fn wants_database(&self, database: &str) -> bool {
        self.database
            .as_deref()
            .is_none_or(|wanted| wanted == database)
    }

    /// The document is the scope or lies under it.
    fn matches_document(&self, database: &str, path: &str) -> bool {
        self.wants_database(database) && (self.scope.is_empty() || within(path, &self.scope))
    }

    /// Something in the collection may be the scope or lie under it: the
    /// collection lies under the scope, or the scope lies in it.
    fn matches_collection(&self, database: &str, path: &str) -> bool {
        self.wants_database(database)
            && (self.scope.is_empty() || within(path, &self.scope) || within(&self.scope, path))
    }

    fn touches(&self, meta: &ChangeMeta) -> bool {
        let document =
            |key: &DocumentKey| self.matches_document(key.database().database_id(), key.path());
        match &meta.touched {
            Touched::One(key, _) => document(key),
            Touched::Many(keys) => keys.iter().any(|(key, _)| document(key)),
            Touched::Collections(collections) => collections
                .iter()
                .any(|(database, path)| self.matches_collection(database, path)),
            Touched::Rebuilt(database) => self.wants_database(database),
        }
    }
}

/// `path` is `parent` or lies under it.
fn within(path: &str, parent: &str) -> bool {
    path == parent
        || path
            .strip_prefix(parent)
            .is_some_and(|rest| rest.starts_with('/'))
}

/// `firestore.changes` parameters.
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ChangeParams {
    /// Database id; every database when absent.
    database: Option<String>,
    /// A document or collection path; everything when absent.
    scope: Option<String>,
}

/// The live channel's `firestore.changes` topic: `change` → [`ChangeBatch`],
/// one per subscriber per 100 ms with the window's commits merged, paths
/// deduplicated and filtered by scope; `tick` while the scope matches
/// nothing. It resumes by replay from the change ring.
pub(crate) struct ChangesTopic {
    feed: ChangeFeed,
}

impl LiveTopic for ChangesTopic {
    fn name(&self) -> &'static str {
        "firestore.changes"
    }

    fn open(
        &self,
        params: &serde_json::Value,
        after: Option<&str>,
    ) -> Result<TopicStream, ApiError> {
        let params: ChangeParams = topic_params(params)?;
        let scope = Arc::new(ChangeScope {
            database: params.database,
            scope: params.scope.unwrap_or_default(),
        });
        self.feed.recording.store(true, Ordering::Relaxed);
        let ring = &self.feed.recorded;
        // A new subscriber has just loaded what it shows, so it starts from
        // now. A cursor the ring no longer holds is a reset: the subscriber
        // reloads everything, and replaying what the ring still has would
        // only make it load some of that twice.
        let now = ring.position();
        let (reset, from) = match after {
            None => (None, now),
            Some(after) => match resume_point(ring, after, now) {
                Ok(cursor) => (None, cursor),
                Err(missed) => (
                    Some(TopicEvent::Reset {
                        reason: ResetReason::Gap,
                        missed,
                    }),
                    now,
                ),
            },
        };
        let filter = Arc::clone(&scope);
        let options = ReplayOptions {
            filter: Some(Arc::new(move |meta: &ChangeMeta| filter.touches(meta))),
            shape: Some(Box::new(move |entries: &[Entry<ChangeMeta>]| {
                merge(entries, &scope)
            })),
            ..ReplayOptions::default()
        };
        let stream = replay_topic(ring, Some(&from.to_string()), "change", options).map(
            // A window past the key budget is a reset: reload what is shown.
            |event| match event {
                TopicEvent::Event {
                    name: "change",
                    data,
                    ..
                } if Arc::ptr_eq(&data, &burst()) => TopicEvent::Reset {
                    reason: ResetReason::Lagged,
                    missed: None,
                },
                // A database rebuilt in bulk: reload what is shown.
                TopicEvent::Event {
                    name: "change",
                    data,
                    ..
                } if Arc::ptr_eq(&data, &rebuilt()) => TopicEvent::Reset {
                    reason: ResetReason::Rebuilt,
                    missed: None,
                },
                other => other,
            },
        );
        Ok(match reset {
            Some(reset) => stream::once(async { reset }).chain(stream).boxed(),
            None => stream.boxed(),
        })
    }
}

/// Where a subscriber resumes: its cursor while the ring still holds what
/// came after it, or the entries lost (`None`: cannot be counted).
fn resume_point(
    ring: &ReplayRing<ChangeMeta>,
    after: &str,
    now: Cursor,
) -> Result<Cursor, Option<u64>> {
    let cursor = after.parse::<Cursor>().map_err(|_| None)?;
    if cursor.epoch != ring.epoch() || cursor.seq > now.seq {
        return Err(None);
    }
    match ring.oldest() {
        Some(oldest) if cursor.seq + 1 < oldest.seq => Err(Some(oldest.seq - cursor.seq - 1)),
        _ => Ok(cursor),
    }
}

/// The marker a window's shaper answers when it merged too many keys.
fn burst() -> Arc<str> {
    static BURST: OnceLock<Arc<str>> = OnceLock::new();
    BURST.get_or_init(|| Arc::from("null")).clone()
}

/// The marker a window's shaper answers when its scope's database was
/// rebuilt.
fn rebuilt() -> Arc<str> {
    static REBUILT: OnceLock<Arc<str>> = OnceLock::new();
    REBUILT.get_or_init(|| Arc::from("null")).clone()
}

/// Now, as a store timestamp (the time a rebuild was announced).
fn now() -> Timestamp {
    let elapsed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    Timestamp::new(
        i64::try_from(elapsed.as_secs()).unwrap_or(i64::MAX),
        elapsed.subsec_nanos(),
    )
    .unwrap_or_else(|_| Timestamp::new(0, 0).expect("the epoch is a valid timestamp"))
}

/// One subscriber's window as one batch: every document its scope matches,
/// once, with what happened to it across the window; the window's last
/// revision and commit time. Past [`KEYS_PER_BATCH`] documents the batch
/// names their collections instead; past [`KEYS_PER_WINDOW`] collections it
/// is a burst, and the subscriber reloads.
fn merge(entries: &[Entry<ChangeMeta>], scope: &ChangeScope) -> Option<Arc<str>> {
    let last = &entries.last()?.meta;
    if entries.iter().any(|entry| {
        matches!(&entry.meta.touched, Touched::Rebuilt(database) if scope.wants_database(database))
    }) {
        return Some(rebuilt());
    }
    let mut documents = MergedDocuments::default();
    let mut collections: BTreeSet<(&str, &str)> = BTreeSet::new();
    for entry in entries {
        match &entry.meta.touched {
            Touched::One(key, kind) => documents.add(scope, key, *kind),
            Touched::Many(keys) => {
                for (key, kind) in keys.iter() {
                    documents.add(scope, key, *kind);
                }
            }
            Touched::Collections(touched) => {
                for (database, path) in touched.iter() {
                    if scope.matches_collection(database, path) {
                        collections.insert((database, path.as_str()));
                    }
                }
            }
            Touched::Rebuilt(_) => {}
        }
    }
    let documents = documents.order;
    let mut changes = documents
        .iter()
        .map(|&(database, path, first, last)| DocumentChange {
            database: database.to_owned(),
            path: path.to_owned(),
            kind: merged_kind(first, last),
        })
        .collect::<Vec<_>>();
    if changes.len() > KEYS_PER_BATCH {
        for &(database, path, _, _) in &documents {
            collections.insert((database, collection_of(path)));
        }
        changes.clear();
    }
    if collections.len() > KEYS_PER_WINDOW {
        return Some(burst());
    }
    if changes.is_empty() && collections.is_empty() {
        return None;
    }
    let truncated = !collections.is_empty();
    let batch = ChangeBatch {
        revision: last.revision,
        commit_time: rfc3339(last.commit_time),
        changes: if truncated { Vec::new() } else { changes },
        truncated: truncated.then_some(true),
        collections: truncated.then(|| {
            collections
                .into_iter()
                .map(|(database, path)| ChangedCollection {
                    database: database.to_owned(),
                    path: path.to_owned(),
                })
                .collect()
        }),
    };
    serde_json::to_string(&batch).ok().map(Arc::from)
}

/// The documents of one window, once each in first-seen order, with what
/// happened to each first and last.
#[derive(Default)]
struct MergedDocuments<'a> {
    order: Vec<(&'a str, &'a str, ChangeKind, ChangeKind)>,
    seen: HashMap<(&'a str, &'a str), usize>,
}

impl<'a> MergedDocuments<'a> {
    fn add(&mut self, scope: &ChangeScope, key: &'a DocumentKey, kind: ChangeKind) {
        let database = key.database().database_id();
        let path = key.path();
        if !scope.matches_document(database, path) {
            return;
        }
        if let Some(&index) = self.seen.get(&(database, path)) {
            self.order[index].3 = kind;
        } else {
            self.seen.insert((database, path), self.order.len());
            self.order.push((database, path, kind, kind));
        }
    }
}

/// What happened to a document across a window, from what happened first
/// and last: it existed before unless it was created first, and exists
/// after unless it was deleted last. One that came and went in the window
/// is reported deleted, so a page that fetched it meanwhile drops it.
fn merged_kind(first: ChangeKind, last: ChangeKind) -> ChangeKind {
    match (first != ChangeKind::Created, last != ChangeKind::Deleted) {
        (true, true) => ChangeKind::Updated,
        (false, true) => ChangeKind::Created,
        (_, false) => ChangeKind::Deleted,
    }
}

/// `GET /changes?database=(default)&scope=users`: a server-sent event stream.
/// `hello` carries the current revision, `change` one commit, and `reset`
/// tells a console that fell behind to reload what it shows. The stream
/// ends when the suite stops, so shutdown never waits on a console tab.
async fn changes(
    State(streams): State<ChangeStreams>,
    Query(scope): Query<ChangeScope>,
) -> impl IntoResponse {
    let receiver = streams.feed.sender.subscribe();
    let rebuilt = streams.feed.rebuilt.subscribe();
    let hello = ChangeHello {
        revision: streams.feed.store.revision().get(),
    };
    let first = stream::once(async move { json_event("hello", &hello) });
    let wanted = scope.database.clone();
    let resets = BroadcastStream::new(rebuilt).filter_map(move |item| {
        let reset = match item {
            Ok(database) => wanted
                .as_deref()
                .is_none_or(|wanted| wanted == &*database)
                .then(|| Event::default().event("reset")),
            Err(BroadcastStreamRecvError::Lagged(_)) => Some(Event::default().event("reset")),
        };
        async move { reset }
    });
    let rest = BroadcastStream::new(receiver).filter_map(move |item| {
        let event = match item {
            Ok(batch) => {
                let changes = batch
                    .changes
                    .iter()
                    .filter(|change| scope.matches(change))
                    .cloned()
                    .collect::<Vec<_>>();
                if changes.is_empty() {
                    None
                } else {
                    Some(json_event(
                        "change",
                        &ChangeBatch {
                            revision: batch.revision,
                            commit_time: batch.commit_time.clone(),
                            changes,
                            truncated: None,
                            collections: None,
                        },
                    ))
                }
            }
            Err(BroadcastStreamRecvError::Lagged(_)) => Some(Event::default().event("reset")),
        };
        async move { event }
    });
    sse_response(first.chain(stream::select(rest, resets)), streams.shutdown)
}

/// Where the Firestore REST front is mounted, as the browser sees it.
const REST_MOUNT: &str = "/console/api/v1/firestore";

/// The console's Firestore routes: the change feed, the schema index, the
/// database list, the Requests feed and the REST front, mounted together
/// under `/api/v1/firestore`. The REST front is a service's own
/// application on the console origin, so it goes through `forwarded`.
pub(crate) fn firestore_router(console: FirestoreConsole, shutdown: Shutdown) -> Router {
    let mut router = console
        .changes
        .router(shutdown.clone())
        .merge(console.schema.router())
        .merge(console.databases.router())
        .merge(console.explain.router())
        .merge(console.rules_evaluator.router())
        .merge(console.rules.router(shutdown));
    if let Some(requests) = console.requests {
        router = router.merge(requests);
    }
    router.merge(forwarded(console.rest, REST_MOUNT))
}

/// The Firestore section: the data page and the rules page.
pub(crate) struct FirestoreSection(pub(crate) FirestoreConsole);

/// What the `firestore.rules` badge counts.
fn rules_badge_noun() -> BadgeNoun {
    BadgeNoun::new("rules file does not compile", "rules files do not compile")
}

impl Section for FirestoreSection {
    fn statuses(&self) -> Vec<SectionStatus> {
        vec![SectionStatus::ready("firestore")]
    }

    fn router(&self, context: &SectionContext) -> Router {
        // The badge task lives as long as the suite: it counts the
        // configured databases whose rules file the watcher last found
        // broken, from now on every file check.
        self.0.rules.spawn_badge(
            context
                .badges
                .handle("firestore.rules", BadgeKind::Gauge, rules_badge_noun()),
            context.shutdown.clone(),
        );
        Router::new().nest(
            "/firestore",
            firestore_router(self.0.clone(), context.shutdown.clone()),
        )
    }

    fn topics(&self, _context: &SectionContext) -> Vec<Arc<dyn LiveTopic>> {
        vec![
            Arc::new(self.0.changes.topic()),
            Arc::new(self.0.rules.topic()),
        ]
    }

    fn search(&self, _context: &SectionContext) -> Option<Arc<dyn SearchSource>> {
        Some(Arc::new(FirestoreSearch::new(
            self.0.schema.clone(),
            self.0.databases.clone(),
        )))
    }

    fn status_changes(&self) -> Option<BoxStream<'static, ()>> {
        Some(crate::observe::firestore_data::status_changes(&self.0))
    }

    fn summary(&self, _id: &str) -> Option<SectionSummary> {
        Some(crate::observe::firestore_data::summary(&self.0))
    }

    fn clear(
        &self,
        _id: &str,
        job: JobHandle,
        options: ClearOptions,
    ) -> Option<BoxFuture<'static, Result<ClearReport, ApiError>>> {
        crate::observe::firestore_data::clear(&self.0, job, options)
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use axum::body::Body;
    use axum::http::Request;
    use std::sync::atomic::AtomicI64;

    use firenook_core_store::{DatabaseName, Fields, Precondition, Value as StoreValue, Write};
    use serde_json::{Value, json};
    use tokio::sync::watch;
    use tower::ServiceExt as _;

    use super::*;

    fn key(database: &str, path: &str) -> DocumentKey {
        DocumentKey::new(
            DatabaseName::new("demo-changes", database).expect("database"),
            path,
        )
        .expect("key")
    }

    fn set(path: &str) -> Write {
        set_in("(default)", path)
    }

    /// A write that always changes the document (the store installs
    /// nothing for a write that changes nothing).
    fn set_in(database: &str, path: &str) -> Write {
        static VERSION: AtomicI64 = AtomicI64::new(0);
        Write::Set {
            key: key(database, path),
            fields: Fields::from([(
                "version".to_owned(),
                StoreValue::Integer(VERSION.fetch_add(1, Ordering::Relaxed)),
            )]),
            transforms: Vec::new(),
            precondition: Precondition::None,
        }
    }

    fn delete(path: &str) -> Write {
        Write::Delete {
            key: key("(default)", path),
            precondition: Precondition::None,
        }
    }

    fn commit(store: &Store, writes: &[Write]) {
        store.commit(writes).expect("commit");
    }

    #[derive(Debug)]
    enum Told {
        Change(
            #[allow(dead_code, reason = "read through Debug when a test fails")] String,
            Value,
        ),
        Tick(String),
        Reset(ResetReason, Option<u64>),
    }

    async fn next(stream: &mut TopicStream) -> Told {
        match tokio::time::timeout(Duration::from_secs(30), stream.next())
            .await
            .expect("told something")
            .expect("the topic goes on")
        {
            TopicEvent::Event {
                name: "tick",
                cursor,
                ..
            } => Told::Tick(cursor.expect("cursor").to_string()),
            TopicEvent::Event {
                name: "change",
                cursor,
                data,
            } => Told::Change(
                cursor.expect("cursor").to_string(),
                serde_json::from_str(&data).expect("json"),
            ),
            TopicEvent::Reset { reason, missed } => Told::Reset(reason, missed),
            other => panic!("unexpected {other:?}"),
        }
    }

    fn paths(batch: &Value) -> Vec<(String, String)> {
        batch["changes"]
            .as_array()
            .expect("changes")
            .iter()
            .map(|change| {
                (
                    change["path"].as_str().expect("path").to_owned(),
                    change["kind"].as_str().expect("kind").to_owned(),
                )
            })
            .collect()
    }

    fn open(feed: &ChangeFeed, params: &Value, after: Option<&str>) -> TopicStream {
        feed.topic().open(params, after).expect("opened")
    }

    #[tokio::test(start_paused = true)]
    async fn housekeeping_commits_send_no_batch_and_a_rebuild_resets_that_database_only() {
        let store = Store::default();
        let feed = ChangeFeed::attach(&store);
        let mut every = open(&feed, &json!({}), None);
        let mut default = open(&feed, &json!({ "database": "(default)" }), None);
        let mut other = open(&feed, &json!({ "database": "other" }), None);
        for stream in [&mut every, &mut default, &mut other] {
            assert!(matches!(next(stream).await, Told::Tick(_)));
        }
        // A reset's batches: no change reaches anyone.
        store
            .commit_maintenance(&[set("users/a"), set("users/b")])
            .expect("maintenance");
        feed.announce_rebuilt("(default)");
        assert!(matches!(
            next(&mut every).await,
            Told::Reset(ResetReason::Rebuilt, None)
        ));
        assert!(matches!(
            next(&mut default).await,
            Told::Reset(ResetReason::Rebuilt, None)
        ));
        // A client commit afterwards is a batch as always.
        commit(&store, &[set_in("other", "x/1")]);
        match next(&mut other).await {
            Told::Change(_, batch) => {
                assert_eq!(paths(&batch), [("x/1".to_owned(), "created".to_owned())]);
            }
            told => panic!("the other database hears only its own change, not {told:?}"),
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_subscriber_resuming_from_before_a_rebuild_is_told_to_reload() {
        let store = Store::default();
        let feed = ChangeFeed::attach(&store);
        let cursor = position(&feed, json!({ "database": "(default)" })).await;
        feed.announce_rebuilt("(default)");
        let mut resumed = open(&feed, &json!({ "database": "(default)" }), Some(&cursor));
        assert!(matches!(
            next(&mut resumed).await,
            Told::Reset(ResetReason::Rebuilt, None)
        ));
        let mut elsewhere = open(&feed, &json!({ "database": "other" }), Some(&cursor));
        assert!(matches!(next(&mut elsewhere).await, Told::Tick(_)));
    }

    #[tokio::test]
    async fn the_legacy_stream_reloads_on_a_rebuild_and_skips_housekeeping() {
        let store = Store::default();
        let feed = ChangeFeed::attach(&store);
        let (_stop, receiver) = watch::channel(false);
        let router = feed.clone().router(Shutdown::new(receiver));
        let response = router
            .oneshot(
                Request::get("/changes?database=(default)")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        let mut body = response.into_body().into_data_stream();
        let mut read = String::new();
        let mut until = async |marker: &str, read: &mut String| {
            tokio::time::timeout(Duration::from_secs(5), async {
                while !read.contains(marker) {
                    let chunk = body.next().await.expect("more").expect("chunk");
                    read.push_str(&String::from_utf8_lossy(&chunk));
                }
            })
            .await
            .expect("in time");
        };
        until("event: hello", &mut read).await;
        store
            .commit_maintenance(&[set("users/a")])
            .expect("maintenance");
        feed.announce_rebuilt("(default)");
        until("event: reset", &mut read).await;
        assert!(!read.contains("event: change"), "{read}");
    }

    /// Subscribes, takes the position it is given, and lets it go: what a
    /// console tab does before the browser hides it.
    async fn position(feed: &ChangeFeed, params: Value) -> String {
        let mut stream = open(feed, &params, None);
        match next(&mut stream).await {
            Told::Tick(cursor) => cursor,
            other => panic!("a new subscriber starts with its position, not {other:?}"),
        }
    }

    #[tokio::test(start_paused = true)]
    async fn commits_made_while_nobody_listened_are_replayed_on_resume_by_scope() {
        let store = Store::default();
        let feed = ChangeFeed::attach(&store);
        commit(&store, &[set("users/before")]);
        let cursor = position(&feed, json!({ "scope": "users" })).await;
        // The tab is released; the app keeps writing.
        commit(&store, &[set("users/u1")]);
        commit(&store, &[set("orders/o1")]);
        commit(&store, &[set("users/u2"), set("orders/o2")]);
        let mut resumed = open(&feed, &json!({ "scope": "users" }), Some(&cursor));
        let Told::Change(_, batch) = next(&mut resumed).await else {
            panic!("the missed commits come back");
        };
        assert_eq!(
            paths(&batch),
            [
                ("users/u1".to_owned(), "created".to_owned()),
                ("users/u2".to_owned(), "created".to_owned()),
            ],
            "only what the scope covers, never what came before the cursor"
        );
        assert_eq!(batch["revision"], store.revision().get());
        assert!(batch.get("truncated").is_none(), "{batch}");
    }

    #[tokio::test(start_paused = true)]
    async fn a_resume_after_only_unrelated_writes_replays_nothing_and_does_not_reset() {
        let store = Store::default();
        let feed = ChangeFeed::attach(&store);
        let cursor = position(&feed, json!({ "database": "(default)", "scope": "users" })).await;
        for index in 0..20 {
            commit(&store, &[set(&format!("orders/o{index}"))]);
            commit(&store, &[set_in("analytics", &format!("users/u{index}"))]);
        }
        let mut resumed = open(
            &feed,
            &json!({ "database": "(default)", "scope": "users" }),
            Some(&cursor),
        );
        match next(&mut resumed).await {
            Told::Tick(moved) => assert_ne!(moved, cursor, "the cursor caught up"),
            other => panic!("nothing to replay and no reset: {other:?}"),
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_cursor_that_left_the_ring_or_names_another_run_is_reset_without_a_replay() {
        let store = Store::default();
        let feed = ChangeFeed::attach(&store);
        let cursor = position(&feed, json!({})).await;
        for index in 0..(CHANGE_RING.entries + 5) {
            commit(&store, &[set(&format!("logs/l{index}"))]);
        }
        let mut resumed = open(&feed, &json!({}), Some(&cursor));
        match next(&mut resumed).await {
            Told::Reset(ResetReason::Gap, Some(5)) => {}
            other => panic!("a gap that counts what it lost, not {other:?}"),
        }
        // Then the position, not 20,000 batches it would reload anyway.
        assert!(matches!(next(&mut resumed).await, Told::Tick(_)));
        let mut foreign = open(&feed, &json!({}), Some("00000001.3"));
        assert!(matches!(
            next(&mut foreign).await,
            Told::Reset(ResetReason::Gap, None)
        ));
    }

    #[tokio::test(start_paused = true)]
    async fn a_thousand_commits_in_a_window_are_one_event_per_subscriber() {
        let store = Store::default();
        let feed = ChangeFeed::attach(&store);
        let mut all = open(&feed, &json!({}), None);
        let mut users = open(&feed, &json!({ "scope": "users" }), None);
        assert!(matches!(next(&mut all).await, Told::Tick(_)));
        assert!(matches!(next(&mut users).await, Told::Tick(_)));
        for index in 0..1_000 {
            commit(&store, &[set(&format!("users/u{}", index % 10))]);
        }
        let Told::Change(_, batch) = next(&mut all).await else {
            panic!("one change");
        };
        assert_eq!(
            batch["changes"].as_array().map(Vec::len),
            Some(10),
            "paths deduplicated across the window"
        );
        assert_eq!(batch["revision"], store.revision().get());
        let Told::Change(_, scoped) = next(&mut users).await else {
            panic!("one change");
        };
        assert_eq!(scoped["changes"].as_array().map(Vec::len), Some(10));
        // Nothing else is pending: the next thing either says is new.
        commit(&store, &[set("users/last")]);
        let Told::Change(_, last) = next(&mut all).await else {
            panic!("the next window");
        };
        assert_eq!(
            paths(&last),
            [("users/last".to_owned(), "created".to_owned())]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_scope_that_matches_nothing_is_ticked() {
        let store = Store::default();
        let feed = ChangeFeed::attach(&store);
        let mut quiet = open(&feed, &json!({ "scope": "users" }), None);
        let Told::Tick(start) = next(&mut quiet).await else {
            panic!("a position first");
        };
        commit(&store, &[set("orders/o1")]);
        let Told::Tick(moved) = next(&mut quiet).await else {
            panic!("a tick, not a change");
        };
        assert_ne!(moved, start);
    }

    #[tokio::test(start_paused = true)]
    async fn a_large_commit_is_recorded_as_its_collections() {
        let store = Store::default();
        let feed = ChangeFeed::attach(&store);
        let mut stream = open(&feed, &json!({ "scope": "users/u1" }), None);
        assert!(matches!(next(&mut stream).await, Told::Tick(_)));
        let mut writes = (0..600)
            .map(|index| set(&format!("users/u{index}")))
            .collect::<Vec<_>>();
        writes.push(set("users/u1/orders/o1"));
        writes.push(set("products/p1"));
        commit(&store, &writes);
        let Told::Change(_, batch) = next(&mut stream).await else {
            panic!("a truncated change");
        };
        assert_eq!(batch["truncated"], true);
        assert_eq!(batch["changes"], json!([]));
        // The scope lies in `users` and covers its own subcollection; the
        // products are outside it.
        assert_eq!(
            batch["collections"],
            json!([
                { "database": "(default)", "path": "users" },
                { "database": "(default)", "path": "users/u1/orders" },
            ])
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_window_reports_what_happened_to_each_document_across_it() {
        let store = Store::default();
        commit(&store, &[set("users/kept"), set("users/gone")]);
        let feed = ChangeFeed::attach(&store);
        let mut stream = open(&feed, &json!({}), None);
        assert!(matches!(next(&mut stream).await, Told::Tick(_)));
        commit(&store, &[set("users/new")]);
        commit(&store, &[set("users/new")]);
        commit(&store, &[set("users/kept")]);
        commit(&store, &[delete("users/gone")]);
        commit(&store, &[set("users/brief")]);
        commit(&store, &[delete("users/brief")]);
        let Told::Change(_, batch) = next(&mut stream).await else {
            panic!("one change");
        };
        assert_eq!(
            paths(&batch),
            [
                ("users/new".to_owned(), "created".to_owned()),
                ("users/kept".to_owned(), "updated".to_owned()),
                ("users/gone".to_owned(), "deleted".to_owned()),
                ("users/brief".to_owned(), "deleted".to_owned()),
            ]
        );
    }

    #[test]
    fn misspelt_parameters_are_refused() {
        let feed = ChangeFeed::attach(&Store::default());
        let error = feed
            .topic()
            .open(&json!({ "databse": "(default)" }), None)
            .err()
            .expect("refused");
        assert_eq!(error.detail().code, crate::ErrorCode::InvalidArgument);
    }

    #[test]
    fn nothing_is_recorded_until_the_first_subscription() {
        let store = Store::default();
        let feed = ChangeFeed::attach(&store);
        commit(&store, &[set("users/u1")]);
        assert!(feed.recorded.is_empty(), "a headless run pays nothing");
        let _ = feed.topic().open(&json!({}), None).expect("opened");
        commit(&store, &[set("users/u2")]);
        assert_eq!(feed.recorded.len(), 1);
        assert!(
            feed.recorded.bytes() > 0,
            "paths count against the ring's 4 MiB"
        );
    }

    const BENCH_COMMITS: u32 = 100_000;
    const BENCH_CHUNK: u32 = 10_000;
    const BENCH_ROUNDS: usize = 7;

    /// `count` single-document commits from `from`, over 1,000 documents.
    fn bench_commits(store: &Store, keys: &[DocumentKey], from: u32, count: u32) {
        for index in from..from + count {
            store
                .commit(&[Write::Set {
                    key: keys[index as usize % keys.len()].clone(),
                    fields: Fields::from([(
                        "version".to_owned(),
                        StoreValue::Integer(i64::from(index)),
                    )]),
                    transforms: Vec::new(),
                    precondition: Precondition::None,
                }])
                .expect("commit");
        }
    }

    /// Two stores, one recording and one not, take the same commits in
    /// interleaved chunks whose order alternates; answers every chunk's
    /// ratio (recording over not) and each round's totals.
    fn bench_interleaved(keys: &[DocumentKey]) -> (Vec<f64>, Vec<(Duration, Duration)>) {
        let timed = |store: &Store, from: u32| {
            let began = std::time::Instant::now();
            bench_commits(store, keys, from, BENCH_CHUNK);
            began.elapsed()
        };
        let mut ratios = Vec::new();
        let mut totals = Vec::new();
        for round in 0..=BENCH_ROUNDS {
            let plain = Store::default();
            let plain_feed = ChangeFeed::attach(&plain);
            let recording = Store::default();
            let recording_feed = ChangeFeed::attach(&recording);
            recording_feed.recording.store(true, Ordering::Relaxed);
            let (mut without, mut with) = (Duration::ZERO, Duration::ZERO);
            for (chunk, from) in (0..BENCH_COMMITS).step_by(BENCH_CHUNK as usize).enumerate() {
                let (base, recorded) = if chunk % 2 == 0 {
                    let base = timed(&plain, from);
                    (base, timed(&recording, from))
                } else {
                    let recorded = timed(&recording, from);
                    (timed(&plain, from), recorded)
                };
                without += base;
                with += recorded;
                // The first round warms caches and the allocator.
                if round > 0 {
                    ratios.push(recorded.as_secs_f64() / base.as_secs_f64());
                }
            }
            assert!(plain_feed.recorded.is_empty());
            assert_eq!(recording_feed.recorded.len(), CHANGE_RING.entries);
            if round > 0 {
                totals.push((without, with));
            }
        }
        ratios.sort_by(f64::total_cmp);
        totals.sort();
        (ratios, totals)
    }

    /// The observer call alone: the same captured commits replayed into a
    /// feed that records and one that does not; the fastest of each.
    fn bench_observer(keys: &[DocumentKey]) -> (Duration, Duration) {
        struct Capture(std::sync::Mutex<Vec<CommitObservation>>);
        impl CommitObserver for Capture {
            fn committed(&self, observation: &CommitObservation) {
                self.0.lock().expect("capture").push(observation.clone());
            }
        }
        let captured = {
            let store = Store::default();
            let capture = Arc::new(Capture(std::sync::Mutex::new(Vec::new())));
            store.add_commit_observer(capture.clone());
            bench_commits(&store, keys, 0, BENCH_COMMITS);
            std::mem::take(&mut *capture.0.lock().expect("capture"))
        };
        let observe = |recording: bool| {
            let feed = ChangeFeed::attach(&Store::default());
            feed.recording.store(recording, Ordering::Relaxed);
            let began = std::time::Instant::now();
            for observation in &captured {
                feed.committed(observation);
            }
            began.elapsed()
        };
        let fastest = |recording: bool| {
            (0..BENCH_ROUNDS)
                .map(|_| observe(recording))
                .min()
                .expect("rounds")
        };
        (fastest(false), fastest(true))
    }

    /// Risk 26: recording costs the commit path one ring push. Two stores
    /// with a change feed each, one recording and one not, take 100,000
    /// single-document commits each, in interleaved chunks of 10,000 whose
    /// order alternates, so a shared machine's load falls on both sides
    /// alike; the median of the chunks' ratios is the cost. The observer
    /// call alone is measured too, replaying the same captured commits into
    /// a feed that records and one that does not. More than 2 % fails. Run
    /// with `cargo test -p firenook-console-front --release recording_costs
    /// -- --ignored --nocapture`.
    #[test]
    #[ignore = "a benchmark: run it in release, alone"]
    fn recording_costs_the_commit_path_at_most_two_percent() {
        let keys = (0..1_000)
            .map(|index| key("(default)", &format!("bench/d{index}")))
            .collect::<Vec<_>>();
        let (ratios, totals) = bench_interleaved(&keys);
        let (observed_without, observed_with) = bench_observer(&keys);
        let nanos = |total: Duration| total.as_secs_f64() * 1e9 / f64::from(BENCH_COMMITS);
        let (median_without, median_with) = totals[totals.len() / 2];
        let commit_cost = nanos(median_without);
        let recording_cost = nanos(observed_with) - nanos(observed_without);
        let share = recording_cost / commit_cost;
        let slower = ratios[ratios.len() / 2] - 1.0;
        eprintln!(
            "firestore.changes recording, {BENCH_COMMITS} single-document commits per side in chunks of {BENCH_CHUNK}, \
             {BENCH_ROUNDS} rounds: median chunk ratio {:+.2} % ({} chunks, quartiles {:+.2} % and {:+.2} %); \
             median round without {median_without:?} ({commit_cost:.0} ns/commit), with {median_with:?} ({:.0} ns/commit); \
             the observer alone: {:.1} ns/commit without recording, {:.1} ns/commit with, \
             so recording adds {recording_cost:.1} ns to a {commit_cost:.0} ns commit = {:+.2} %",
            slower * 100.0,
            ratios.len(),
            (ratios[ratios.len() / 4] - 1.0) * 100.0,
            (ratios[ratios.len() * 3 / 4] - 1.0) * 100.0,
            nanos(median_with),
            nanos(observed_without),
            nanos(observed_with),
            share * 100.0,
        );
        assert!(
            slower <= 0.02,
            "recording made commits {:.2} % slower",
            slower * 100.0
        );
        assert!(
            share <= 0.02,
            "recording adds {:.2} % to a commit",
            share * 100.0
        );
    }

    fn change(database: &str, path: &str) -> DocumentChange {
        DocumentChange {
            database: database.to_owned(),
            path: path.to_owned(),
            kind: ChangeKind::Updated,
        }
    }

    #[test]
    fn scope_matches_the_path_itself_and_everything_under_it() {
        let scope = ChangeScope {
            database: Some("(default)".to_owned()),
            scope: "users".to_owned(),
        };
        assert!(scope.matches(&change("(default)", "users/u1")));
        assert!(scope.matches(&change("(default)", "users/u1/orders/o1")));
        assert!(!scope.matches(&change("(default)", "users-archive/u1")));
        assert!(!scope.matches(&change("analytics", "users/u1")));
    }

    #[test]
    fn an_empty_scope_matches_every_change() {
        let scope = ChangeScope::default();
        assert!(scope.matches(&change("(default)", "anything/at/all/here")));
    }

    #[tokio::test]
    async fn a_change_stream_ends_when_the_suite_stops() {
        let store = Store::default();
        let (stop, shutdown) = watch::channel(false);
        let router = ChangeFeed::attach(&store).router(Shutdown::new(shutdown));
        let response = router
            .oneshot(
                Request::get("/changes?database=(default)")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), axum::http::StatusCode::OK);
        // The greeting arrives while the suite runs; the body then only
        // ends because the suite stopped, not because a tab closed.
        let mut body = response.into_body().into_data_stream();
        let greeting = tokio::time::timeout(Duration::from_secs(5), body.next())
            .await
            .expect("the greeting arrives")
            .expect("a chunk")
            .expect("bytes");
        stop.send(true).expect("a subscriber is listening");
        let remainder = tokio::time::timeout(Duration::from_secs(5), async {
            let mut collected = Vec::new();
            while let Some(chunk) = body.next().await {
                collected.extend_from_slice(&chunk.expect("bytes"));
            }
            collected
        })
        .await
        .expect("the stream ended after shutdown");
        let body = [greeting.to_vec(), remainder].concat();
        let text = String::from_utf8(body).expect("utf-8");
        assert!(text.contains("event: hello"), "{text}");
    }
}
