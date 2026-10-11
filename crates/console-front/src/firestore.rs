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
use firenook_core_store::{
    Change, CommitObservation, CommitObserver, DocumentKey, Store, Timestamp,
};
use firenook_suite_front::replay::random_epoch;
use firenook_suite_front::{Cursor, Entry, ReplayRing, RingBudget, RingLimits};
use futures_util::stream::{self, StreamExt as _};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::api_error::ApiError;
use crate::databases::DatabaseCatalog;
use crate::explain::QueryExplainer;
use crate::http::forwarded;
use crate::live::badges::{BadgeKind, BadgeNoun};
use crate::live::replay::{ReplayOptions, replay_topic};
use crate::live::{LiveTopic, ResetReason, TopicEvent, TopicStream, topic_params};
use crate::rules::RulesEditor;
use crate::rules_eval::RulesEvaluator;
use crate::schema::SchemaIndex;
use crate::section::{Section, SectionContext, SectionStatus, SectionSummary};
use crate::time::rfc3339;

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

/// Records store commits for the `firestore.changes` topic.
#[derive(Clone)]
pub struct ChangeFeed {
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

impl ChangeFeed {
    /// Creates the feed and registers it with `store`.
    #[must_use]
    pub fn attach(store: &Store) -> Self {
        let feed = Self {
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
}

impl CommitObserver for ChangeFeed {
    fn committed(&self, observation: &CommitObservation) {
        // Nothing at all until a console first subscribes: a headless run
        // pays one relaxed load per commit.
        if self.recording.load(Ordering::Relaxed) {
            self.record(observation);
        }
    }
}

/// Which changes one subscriber wants.
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

/// One subscriber's window as one batch: every document its scope matches,
/// once, with what happened to it across the window; the window's last
/// revision and commit time. Past [`KEYS_PER_BATCH`] documents the batch
/// names their collections instead; past [`KEYS_PER_WINDOW`] collections it
/// is a burst, and the subscriber reloads.
fn merge(entries: &[Entry<ChangeMeta>], scope: &ChangeScope) -> Option<Arc<str>> {
    let last = &entries.last()?.meta;
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

/// Where the Firestore REST front is mounted, as the browser sees it.
const REST_MOUNT: &str = "/console/api/v1/firestore";

/// The console's Firestore routes: the schema index, the database list, the
/// query explainer, the rules, the Requests feed and the REST front, mounted
/// together under `/api/v1/firestore`. The change feed is not a route: it is
/// the live channel's `firestore.changes` topic. The REST front is a
/// service's own application on the console origin, so it goes through
/// `forwarded`.
pub(crate) fn firestore_router(console: FirestoreConsole) -> Router {
    let mut router = console
        .schema
        .router()
        .merge(console.databases.router())
        .merge(console.explain.router())
        .merge(console.rules_evaluator.router())
        .merge(console.rules.router());
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
        Router::new().nest("/firestore", firestore_router(self.0.clone()))
    }

    fn topics(&self, _context: &SectionContext) -> Vec<Arc<dyn LiveTopic>> {
        vec![
            Arc::new(self.0.changes.topic()),
            Arc::new(self.0.rules.topic()),
        ]
    }

    fn summary(&self, _id: &str) -> Option<SectionSummary> {
        crate::observe::firestore_data::summary(&self.0)
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use std::sync::atomic::AtomicI64;

    use firenook_core_store::{DatabaseName, Fields, Precondition, Value as StoreValue, Write};
    use serde_json::{Value, json};

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

    #[test]
    fn scope_matches_the_path_itself_and_everything_under_it() {
        let scope = ChangeScope {
            database: Some("(default)".to_owned()),
            scope: "users".to_owned(),
        };
        assert!(scope.matches_document("(default)", "users/u1"));
        assert!(scope.matches_document("(default)", "users/u1/orders/o1"));
        assert!(!scope.matches_document("(default)", "users-archive/u1"));
        assert!(!scope.matches_document("analytics", "users/u1"));
    }

    #[test]
    fn an_empty_scope_matches_every_change() {
        let scope = ChangeScope::default();
        assert!(scope.matches_document("(default)", "anything/at/all/here"));
    }
}
