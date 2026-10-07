//! The schema index: the shape of a database without opening a document.
//!
//! Firestore has no schema, but data has a shape. Every document path
//! alternates collection and document ids, so replacing the document ids
//! with `*` turns `users/u_9f3k2/orders/o_20251/items/i_3` into the pattern
//! `users/*/orders/*/items`, and the set of patterns with their counts is
//! the tree the console draws: which collections exist, where they nest,
//! how many documents each holds and how many parents carry it.
//!
//! The store indexes documents and collection groups, not patterns, and
//! discovering patterns on demand would visit every parent document. So
//! the console keeps its own index: one key-only walk of a snapshot the
//! first time a console asks about a database, after which every commit
//! the store observes moves the counts. Reading the tree then costs a few
//! dozen nodes to serialise, whatever the size of the database. The index
//! is process-local and never persisted; it is rebuilt from the store on
//! the next start, in about the time the keys take to be read once.
//!
//! The same walk keeps the *concrete* collections — `users/u_9f3k2/orders`,
//! not `users/*/orders` — with the documents in each, which is what the
//! grid's subcollections column needs per row. Asking the store instead
//! costs one `ListCollectionIds` and one count per rendered row, so
//! scrolling a large collection fires thousands of small requests; the
//! index answers a whole screen in one, from memory.

use std::collections::{BTreeMap, HashMap};
use std::ops::Bound;
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard};

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Json, Router};
use firenook_core_store::{CommitObservation, CommitObserver, DatabaseName, Snapshot, Store};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::Notify;
use tokio::sync::futures::OwnedNotified;
use ts_rs::TS;

/// The shape of one database.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SchemaSnapshot {
    /// Database id.
    pub database: String,
    /// Store revision the counts correspond to.
    #[ts(type = "number")]
    pub revision: u64,
    /// Documents in the database, at every depth.
    #[ts(type = "number")]
    pub documents: u64,
    /// Root collections in id order, each with the patterns nested below it.
    pub collections: Vec<SchemaNode>,
}

/// One collection pattern: a collection id at one position in the tree,
/// standing for every collection with that id under every document of the
/// parent pattern.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SchemaNode {
    /// Collection id, for example `orders`.
    pub id: String,
    /// The pattern: the collection ids on the way down with every document
    /// id replaced by an asterisk, so `users`, `*`, `orders` joined by
    /// slashes for the orders of every user.
    pub pattern: String,
    /// Documents directly inside collections matching the pattern.
    #[ts(type = "number")]
    pub documents: u64,
    /// For a nested pattern, how many parent documents (existing or
    /// missing) have this subcollection. Absent at the root.
    #[ts(type = "number | null")]
    pub parents: Option<u64>,
    /// Patterns nested below this one, in id order.
    pub children: Vec<SchemaNode>,
}

/// The subcollections of a batch of documents, as the grid asks for them:
/// one request for a whole screen of rows.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SubcollectionsSnapshot {
    /// Database id.
    pub database: String,
    /// Store revision the counts correspond to.
    #[ts(type = "number")]
    pub revision: u64,
    /// One entry per requested parent, in the order asked.
    pub parents: Vec<ParentSubcollections>,
}

/// What one parent holds. The parent is a document path, or the empty
/// string for the database root.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ParentSubcollections {
    /// The path asked about, echoed so the client can match answers to
    /// requests without relying on order.
    pub path: String,
    /// The collections directly under it, in id order.
    pub collections: Vec<Subcollection>,
}

/// One collection directly under a parent.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Subcollection {
    /// Collection id, for example `orders`.
    pub id: String,
    /// Documents directly inside it. Zero when the collection exists only
    /// because documents live further down, which is how Firestore lists
    /// collections too.
    #[ts(type = "number")]
    pub documents: u64,
}

/// The console's schema index over one store.
#[derive(Clone)]
pub struct SchemaIndex {
    store: Store,
    project: Arc<str>,
    databases: Arc<Mutex<HashMap<String, Entry>>>,
}

enum Entry {
    /// A walk is in progress; commits seen meanwhile wait here.
    Building {
        pending: Vec<Pending>,
        done: Arc<Notify>,
    },
    Ready(DatabaseIndex),
}

struct Pending {
    revision: u64,
    path: Arc<str>,
    created: bool,
}

#[derive(Default)]
struct DatabaseIndex {
    /// The newest revision applied.
    revision: u64,
    /// Pattern → counts, for every pattern that has documents or parents.
    patterns: HashMap<String, Counts>,
    /// Concrete collection path → its counts. Sorted, because the paths
    /// under one document are a contiguous range: that is what answers
    /// "which subcollections does this document have" without a scan.
    collections: BTreeMap<Box<str>, CollectionCounts>,
}

#[derive(Clone, Copy, Default)]
struct Counts {
    documents: u64,
    parents: u64,
}

/// One concrete collection. `below` is what decides whether the collection
/// exists at all, because `ListCollectionIds` lists a collection when any
/// document lives anywhere beneath it — `teams/t1` has `channels` even when
/// every channel document is missing and only its messages are real.
#[derive(Clone, Copy, Default)]
struct CollectionCounts {
    documents: u64,
    below: u64,
}

enum Step<T> {
    Ready(T),
    Wait(Pin<Box<OwnedNotified>>),
    Build(Arc<Notify>),
}

/// Why a schema could not be answered.
#[derive(Debug)]
pub enum SchemaError {
    /// The database id is not a valid Firestore identifier.
    InvalidDatabase(String),
    /// The walk that builds the index did not finish.
    BuildFailed,
}

impl SchemaIndex {
    /// Creates the index for `project`'s store and registers it as a
    /// commit observer. Nothing is walked until a database is asked for.
    #[must_use]
    pub fn attach(store: &Store, project: &str) -> Self {
        let index = Self {
            store: store.clone(),
            project: Arc::from(project),
            databases: Arc::new(Mutex::new(HashMap::new())),
        };
        store.add_commit_observer(Arc::new(index.clone()));
        index
    }

    pub(crate) fn router(self) -> Router {
        Router::new()
            .route("/schema", axum::routing::get(schema))
            .route("/subcollections", axum::routing::post(subcollections))
            .with_state(self)
    }

    /// The shape of `database_id`, walking it first if no console has asked
    /// yet. Concurrent callers share one walk.
    pub async fn snapshot(&self, database_id: &str) -> Result<SchemaSnapshot, SchemaError> {
        self.read(database_id, |index| index.tree(database_id))
            .await
    }

    /// The subcollections of every path in `paths`, in the order asked.
    /// Answered from the index, so a whole screen of grid rows costs one
    /// request and no document read.
    pub async fn subcollections(
        &self,
        database_id: &str,
        paths: &[String],
    ) -> Result<SubcollectionsSnapshot, SchemaError> {
        self.read(database_id, |index| SubcollectionsSnapshot {
            database: database_id.to_owned(),
            revision: index.revision,
            parents: paths
                .iter()
                .map(|path| ParentSubcollections {
                    path: path.clone(),
                    collections: index.children(path),
                })
                .collect(),
        })
        .await
    }

    /// Reads the index for `database_id`, walking it first if no console has
    /// asked yet. Concurrent callers share one walk.
    async fn read<T>(
        &self,
        database_id: &str,
        answer: impl Fn(&DatabaseIndex) -> T,
    ) -> Result<T, SchemaError> {
        let database = DatabaseName::new(self.project.clone(), database_id)
            .map_err(|error| SchemaError::InvalidDatabase(error.to_string()))?;
        loop {
            // The lock never outlives this block, so no await holds it.
            let step = {
                let mut databases = lock(&self.databases);
                match databases.get(database_id) {
                    Some(Entry::Ready(index)) => Step::Ready(answer(index)),
                    Some(Entry::Building { done, .. }) => {
                        // Register for the wake-up before the lock goes, so a
                        // walk that finishes in between cannot be missed.
                        let mut notified = Box::pin(Arc::clone(done).notified_owned());
                        notified.as_mut().enable();
                        Step::Wait(notified)
                    }
                    None => {
                        let done = Arc::new(Notify::new());
                        databases.insert(
                            database_id.to_owned(),
                            Entry::Building {
                                pending: Vec::new(),
                                done: Arc::clone(&done),
                            },
                        );
                        Step::Build(done)
                    }
                }
            };
            match step {
                Step::Ready(answered) => return Ok(answered),
                Step::Wait(notified) => notified.await,
                Step::Build(done) => self.build(database.clone(), &done).await?,
            }
        }
    }

    async fn build(&self, database: DatabaseName, done: &Notify) -> Result<(), SchemaError> {
        let store = self.store.clone();
        let database_id = database.database_id().to_owned();
        let walked = tokio::task::spawn_blocking(move || {
            let snapshot = store.snapshot();
            DatabaseIndex::walk(&snapshot, &database)
        })
        .await;
        let mut databases = lock(&self.databases);
        let outcome = if let Ok(mut index) = walked {
            // Commits that landed while walking and are newer than the
            // snapshot are not in it yet; older ones already are.
            if let Some(Entry::Building { pending, .. }) = databases.get_mut(&database_id) {
                for change in pending.drain(..) {
                    if change.revision > index.revision {
                        index.apply(&change.path, change.created, change.revision);
                    }
                }
            }
            databases.insert(database_id, Entry::Ready(index));
            Ok(())
        } else {
            databases.remove(&database_id);
            Err(SchemaError::BuildFailed)
        };
        drop(databases);
        done.notify_waiters();
        outcome
    }
}

impl CommitObserver for SchemaIndex {
    fn committed(&self, observation: &CommitObservation) {
        let mut databases = lock(&self.databases);
        if databases.is_empty() {
            return;
        }
        for change in &observation.changes {
            let created = match (&change.before, &change.after) {
                (None, Some(_)) => true,
                (Some(_), None) => false,
                // An update moves no document; the shape is unchanged.
                _ => continue,
            };
            if change.key.database().project_id() != &*self.project {
                continue;
            }
            let revision = change.revision.get();
            match databases.get_mut(change.key.database().database_id()) {
                Some(Entry::Ready(index)) => index.apply(change.key.path(), created, revision),
                Some(Entry::Building { pending, .. }) => pending.push(Pending {
                    revision,
                    path: Arc::from(change.key.path()),
                    created,
                }),
                None => {}
            }
        }
    }
}

impl DatabaseIndex {
    /// Counts every document of `database` in `snapshot`, keys only.
    fn walk(snapshot: &Snapshot, database: &DatabaseName) -> Self {
        let revision = snapshot.revision().get();
        let mut index = Self {
            revision,
            ..Self::default()
        };
        let mut cursor = snapshot.key_cursor(database, "");
        while let Some(key) = cursor.next() {
            index.apply(key.path(), true, revision);
        }
        index
    }

    /// Moves the counts for one document coming (`created`) or going.
    fn apply(&mut self, path: &str, created: bool, revision: u64) {
        self.revision = self.revision.max(revision);
        let Some((collection, _)) = path.rsplit_once('/') else {
            return;
        };
        let nested = collection.contains('/');
        // Whether the document's own collection gained its first document or
        // lost its last one, which is exactly when its parent starts or
        // stops carrying the subcollection.
        let turned = self.move_collections(collection, created);
        let pattern = pattern_of(path);
        let empty = {
            let counts = self.patterns.entry(pattern.clone()).or_default();
            if created {
                counts.documents += 1;
                if nested && turned {
                    counts.parents += 1;
                }
            } else {
                counts.documents = counts.documents.saturating_sub(1);
                if nested && turned {
                    counts.parents = counts.parents.saturating_sub(1);
                }
            }
            counts.documents == 0 && counts.parents == 0
        };
        if empty {
            self.patterns.remove(&pattern);
        }
    }

    /// Moves every concrete collection on the way down to `collection` by
    /// one document below it, and `collection` itself by one document in
    /// it. Returns whether `collection` gained its first document or lost
    /// its last. A collection with nothing left below it is forgotten.
    fn move_collections(&mut self, collection: &str, created: bool) -> bool {
        let mut turned = false;
        for ancestor in collection_paths(collection) {
            let own = ancestor.len() == collection.len();
            if created {
                // `entry` would allocate the key on every document; the
                // steady state is a path the walk has already seen.
                if !self.collections.contains_key(ancestor) {
                    self.collections
                        .insert(Box::from(ancestor), CollectionCounts::default());
                }
                let Some(counts) = self.collections.get_mut(ancestor) else {
                    continue;
                };
                counts.below += 1;
                if own {
                    counts.documents += 1;
                    turned = counts.documents == 1;
                }
                continue;
            }
            let Some(counts) = self.collections.get_mut(ancestor) else {
                continue;
            };
            counts.below = counts.below.saturating_sub(1);
            if own {
                counts.documents = counts.documents.saturating_sub(1);
                turned = counts.documents == 0;
            }
            if counts.below == 0 {
                self.collections.remove(ancestor);
            }
        }
        turned
    }

    /// The collections directly under `parent` (a document path, or the
    /// empty string for the database root), in id order, with the documents
    /// in each. Paths sharing a prefix are contiguous, so a document's
    /// subcollections are one range of the map.
    fn children(&self, parent: &str) -> Vec<Subcollection> {
        let prefix = if parent.is_empty() {
            String::new()
        } else {
            format!("{parent}/")
        };
        self.collections
            .range::<str, _>((Bound::Included(prefix.as_str()), Bound::Unbounded))
            .take_while(|(path, _)| path.starts_with(prefix.as_str()))
            // Deeper collections share the prefix too; only the direct ones
            // have no further slash.
            .filter(|(path, _)| !path[prefix.len()..].contains('/'))
            .map(|(path, counts)| Subcollection {
                id: path[prefix.len()..].to_owned(),
                documents: counts.documents,
            })
            .collect()
    }

    /// The patterns as a tree, root collections first, children in id
    /// order. A pattern with documents only further down (missing
    /// ancestors all the way) still appears, with zero of its own.
    fn tree(&self, database_id: &str) -> SchemaSnapshot {
        let mut roots: BTreeMap<String, Node> = BTreeMap::new();
        for (pattern, counts) in &self.patterns {
            insert(
                &mut roots,
                &pattern.split("/*/").collect::<Vec<_>>(),
                *counts,
            );
        }
        let collections = roots
            .iter()
            .map(|(id, node)| emit(id, id.clone(), node, false))
            .collect::<Vec<_>>();
        SchemaSnapshot {
            database: database_id.to_owned(),
            revision: self.revision,
            documents: self.patterns.values().map(|counts| counts.documents).sum(),
            collections,
        }
    }
}

/// A pattern tree under construction.
#[derive(Default)]
struct Node {
    counts: Counts,
    children: BTreeMap<String, Node>,
}

fn insert(level: &mut BTreeMap<String, Node>, ids: &[&str], counts: Counts) {
    let Some((first, rest)) = ids.split_first() else {
        return;
    };
    let node = level.entry((*first).to_owned()).or_default();
    if rest.is_empty() {
        node.counts = counts;
    } else {
        insert(&mut node.children, rest, counts);
    }
}

fn emit(id: &str, pattern: String, node: &Node, nested: bool) -> SchemaNode {
    SchemaNode {
        id: id.to_owned(),
        documents: node.counts.documents,
        parents: nested.then_some(node.counts.parents),
        children: node
            .children
            .iter()
            .map(|(child, grandchild)| {
                emit(child, format!("{pattern}/*/{child}"), grandchild, true)
            })
            .collect(),
        pattern,
    }
}

/// `users/u1/orders` → `users`, `users/u1/orders`: every collection on the
/// way down to `collection`, itself last. A collection path ends at every
/// other slash — the one before a document id.
fn collection_paths(collection: &str) -> impl Iterator<Item = &str> {
    collection
        .match_indices('/')
        .enumerate()
        .filter_map(|(index, (at, _))| (index % 2 == 0).then_some(&collection[..at]))
        .chain(std::iter::once(collection))
}

/// `users/u1/orders/o1` → `users/*/orders`: the document ids of a path
/// replaced by `*`, ending at the document's own collection.
fn pattern_of(path: &str) -> String {
    let segments = path.split('/').collect::<Vec<_>>();
    let collections = segments.len().saturating_sub(1);
    let mut pattern = String::with_capacity(path.len());
    for (index, segment) in segments[..collections].iter().enumerate() {
        if index > 0 {
            pattern.push('/');
        }
        pattern.push_str(if index % 2 == 0 { segment } else { "*" });
    }
    pattern
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[derive(Debug, Deserialize)]
struct SchemaParams {
    database: Option<String>,
}

/// Paths the console asks about in one request. The cap is well past a
/// screen of grid rows and keeps one request from asking for the whole
/// database.
const PATH_LIMIT: usize = 500;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubcollectionsRequest {
    /// Database id; `(default)` when absent.
    database: Option<String>,
    /// Document paths, or the empty string for the database root.
    #[serde(default)]
    paths: Vec<String>,
}

/// `POST /subcollections`: for every path in the body, the collections
/// directly under it with the documents in each. The body is a list because
/// the grid asks about every rendered row at once; one request per row is
/// what this endpoint exists to replace.
///
/// Like `/schema`, this reads the engine's own index and evaluates no rules:
/// it answers structure, which is what the console's navigation already
/// shows, and the workbench asks it with the owner scope.
async fn subcollections(
    State(index): State<SchemaIndex>,
    Json(request): Json<SubcollectionsRequest>,
) -> Response {
    if request.paths.len() > PATH_LIMIT {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": { "message":
                format!("at most {PATH_LIMIT} paths per request; {} were asked for", request.paths.len()) } })),
        )
            .into_response();
    }
    if let Some(path) = request
        .paths
        .iter()
        .find(|path| !path.is_empty() && !is_document_path(path))
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": { "message":
                format!("not a document path: {path}") } })),
        )
            .into_response();
    }
    let database = request.database.as_deref().unwrap_or("(default)");
    match index.subcollections(database, &request.paths).await {
        Ok(snapshot) => Json(snapshot).into_response(),
        Err(error) => schema_error(error),
    }
}

/// A document path alternates collection and document ids, so it has an
/// even number of non-empty segments. Refusing anything else keeps a
/// collection path — whose children are documents, not collections — from
/// being answered with a confident empty list.
fn is_document_path(path: &str) -> bool {
    let segments = path.split('/').collect::<Vec<_>>();
    segments.len() % 2 == 0 && segments.iter().all(|segment| !segment.is_empty())
}

fn schema_error(error: SchemaError) -> Response {
    match error {
        SchemaError::InvalidDatabase(message) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": { "message": message } })),
        )
            .into_response(),
        SchemaError::BuildFailed => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": { "message": "the schema walk did not finish" } })),
        )
            .into_response(),
    }
}

/// `GET /schema?database=(default)`: the tree of collection patterns with
/// live counts.
async fn schema(State(index): State<SchemaIndex>, Query(params): Query<SchemaParams>) -> Response {
    let database = params.database.as_deref().unwrap_or("(default)");
    match index.snapshot(database).await {
        Ok(snapshot) => Json(snapshot).into_response(),
        Err(error) => schema_error(error),
    }
}

#[cfg(test)]
mod tests {
    use axum::body::{Body, to_bytes};
    use axum::http::Request;
    use firenook_core_store::{DocumentKey, Fields, Precondition, Write};
    use tower::ServiceExt as _;

    use super::*;

    const PROJECT: &str = "demo-schema";

    fn key(path: &str) -> DocumentKey {
        DocumentKey::new(DatabaseName::new(PROJECT, "(default)").expect("name"), path)
            .expect("path")
    }

    fn create(path: &str) -> Write {
        Write::Create {
            key: key(path),
            fields: Fields::new(),
        }
    }

    fn delete(path: &str) -> Write {
        Write::Delete {
            key: key(path),
            precondition: Precondition::None,
        }
    }

    fn flat(node: &SchemaNode, out: &mut Vec<(String, u64, Option<u64>)>) {
        out.push((node.pattern.clone(), node.documents, node.parents));
        for child in &node.children {
            flat(child, out);
        }
    }

    fn patterns(snapshot: &SchemaSnapshot) -> Vec<(String, u64, Option<u64>)> {
        let mut out = Vec::new();
        for node in &snapshot.collections {
            flat(node, &mut out);
        }
        out
    }

    async fn ask(index: &SchemaIndex, paths: &[&str]) -> Vec<(String, Vec<(String, u64)>)> {
        let owned = paths
            .iter()
            .map(|path| (*path).to_owned())
            .collect::<Vec<_>>();
        index
            .subcollections("(default)", &owned)
            .await
            .expect("subcollections")
            .parents
            .into_iter()
            .map(|parent| {
                (
                    parent.path,
                    parent
                        .collections
                        .into_iter()
                        .map(|child| (child.id, child.documents))
                        .collect(),
                )
            })
            .collect()
    }

    async fn post(index: SchemaIndex, body: serde_json::Value) -> (StatusCode, serde_json::Value) {
        let response = index
            .router()
            .oneshot(
                Request::post("/subcollections")
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string()))
                    .expect("request"),
            )
            .await
            .expect("response");
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body");
        (status, serde_json::from_slice(&bytes).expect("json"))
    }

    #[test]
    fn a_collection_path_ends_at_every_other_slash() {
        assert_eq!(collection_paths("users").collect::<Vec<_>>(), ["users"]);
        assert_eq!(
            collection_paths("users/u1/orders").collect::<Vec<_>>(),
            ["users", "users/u1/orders"]
        );
        assert_eq!(
            collection_paths("users/u1/orders/o1/items").collect::<Vec<_>>(),
            ["users", "users/u1/orders", "users/u1/orders/o1/items"]
        );
    }

    #[tokio::test]
    async fn one_request_answers_every_row_on_a_screen_with_its_counts() {
        let store = Store::default();
        store
            .commit(&[
                create("users/u1"),
                create("users/u2"),
                create("users/u3"),
                create("users/u1/orders/o1"),
                create("users/u1/orders/o2"),
                create("users/u1/sessions/s1"),
                create("users/u2/orders/o1"),
                // u3 has nothing below it at all.
                create("products/p1"),
            ])
            .expect("commit");
        let index = SchemaIndex::attach(&store, PROJECT);
        let answered = ask(&index, &["users/u1", "users/u2", "users/u3", ""]).await;
        assert_eq!(
            answered
                .iter()
                .map(|(path, children)| (path.as_str(), children.len()))
                .collect::<Vec<_>>(),
            [("users/u1", 2), ("users/u2", 1), ("users/u3", 0), ("", 2)],
            "every path is answered, in the order asked"
        );
        assert_eq!(
            answered[0].1,
            [("orders".to_owned(), 2), ("sessions".to_owned(), 1)],
            "ids in order, with the documents in each"
        );
        assert_eq!(
            answered[3].1,
            [("products".to_owned(), 1), ("users".to_owned(), 3)]
        );
    }

    #[tokio::test]
    async fn a_collection_with_only_descendants_is_still_listed_as_firestore_lists_it() {
        let store = Store::default();
        store
            .commit(&[
                // No channel document exists; only a message below one.
                create("teams/t1/channels/c1/messages/m1"),
                create("teams/t1/members/m1"),
            ])
            .expect("commit");
        let index = SchemaIndex::attach(&store, PROJECT);
        let answered = ask(&index, &["teams/t1", "teams/t1/channels/c1"]).await;
        assert_eq!(
            answered[0].1,
            [("channels".to_owned(), 0), ("members".to_owned(), 1)],
            "a subcollection holding nothing itself still exists, with no documents of its own"
        );
        assert_eq!(answered[1].1, [("messages".to_owned(), 1)]);
        // And it matches what the store itself would list.
        let database = DatabaseName::new(PROJECT, "(default)").expect("name");
        assert_eq!(
            store
                .snapshot()
                .direct_collection_ids(&database, Some("teams/t1"))
                .into_iter()
                .collect::<Vec<_>>(),
            ["channels", "members"]
        );
    }

    #[tokio::test]
    async fn a_sibling_whose_id_extends_another_is_never_skipped() {
        let store = Store::default();
        store
            .commit(&[
                // `orders` and `orders-archive` are distinct collections, and
                // `-` sorts below `/`, so a prefix scan that seeks past
                // `orders` jumps over `orders-archive`.
                create("users/u1/orders/o1"),
                create("users/u1/orders/o1/items/i1"),
                create("users/u1/orders-archive/o0"),
                create("users/u1-shadow/orders/o1"),
            ])
            .expect("commit");
        let index = SchemaIndex::attach(&store, PROJECT);
        let answered = ask(&index, &["users/u1"]).await;
        assert_eq!(
            answered[0].1,
            [("orders".to_owned(), 1), ("orders-archive".to_owned(), 1)]
        );
    }

    #[tokio::test]
    async fn counts_follow_commits_and_a_collection_disappears_with_its_last_document() {
        let store = Store::default();
        let index = SchemaIndex::attach(&store, PROJECT);
        store
            .commit(&[create("users/u1"), create("users/u1/orders/o1")])
            .expect("commit");
        assert_eq!(
            ask(&index, &["users/u1"]).await[0].1,
            [("orders".to_owned(), 1)]
        );
        store
            .commit(&[create("users/u1/orders/o2")])
            .expect("commit");
        assert_eq!(
            ask(&index, &["users/u1"]).await[0].1,
            [("orders".to_owned(), 2)]
        );
        store
            .commit(&[delete("users/u1/orders/o1"), delete("users/u1/orders/o2")])
            .expect("commit");
        assert!(
            ask(&index, &["users/u1"]).await[0].1.is_empty(),
            "the collection is gone once nothing is left below it"
        );
        // The deeper document keeps its ancestor collection alive.
        store
            .commit(&[create("users/u1/orders/o3/items/i1")])
            .expect("commit");
        assert_eq!(
            ask(&index, &["users/u1"]).await[0].1,
            [("orders".to_owned(), 0)]
        );
    }

    #[tokio::test]
    async fn the_schema_tree_keeps_reporting_the_same_parents_as_before() {
        // The concrete collections share their bookkeeping with the pattern
        // tree's parent counts, so the tree must not move.
        let store = Store::default();
        store
            .commit(&[
                create("users/u1/orders/o1"),
                create("users/u2/orders/o1"),
                create("teams/t1/channels/c1/messages/m1"),
            ])
            .expect("commit");
        let index = SchemaIndex::attach(&store, PROJECT);
        let snapshot = index.snapshot("(default)").await.expect("schema");
        assert_eq!(
            patterns(&snapshot),
            vec![
                ("teams".to_owned(), 0, None),
                ("teams/*/channels".to_owned(), 0, Some(0)),
                ("teams/*/channels/*/messages".to_owned(), 1, Some(1)),
                ("users".to_owned(), 0, None),
                ("users/*/orders".to_owned(), 2, Some(2)),
            ]
        );
    }

    #[tokio::test]
    async fn the_index_answers_exactly_what_the_store_would_list() {
        // The index exists to avoid asking the store per document, so the
        // two must agree on every parent in an awkward database: ids that
        // extend one another, missing parents, uneven depth, and a
        // collection whose documents all live further down.
        let paths = [
            "users/abc",
            "users/abc/posts/p1",
            "users/abc/posts/p1/comments/c1",
            "users/abc-2",
            "users/abc-2/posts/p2",
            "users/ghost/posts/p3",
            "users/ghost/posts/p3/replies/r1",
            "users/zed",
            "users-archive/old",
            "usersX/x",
            "teams/t1",
            "teams/t1/channels/c1/messages/m1",
            "teams/t1/channels-archive/c0",
        ];
        let store = Store::default();
        store.commit(&paths.map(create).to_vec()).expect("commit");
        let index = SchemaIndex::attach(&store, PROJECT);
        let database = DatabaseName::new(PROJECT, "(default)").expect("name");
        let snapshot = store.snapshot();
        // Every document path in the set, plus the ancestors that hold them,
        // plus paths with nothing below them at all.
        let mut parents = vec![String::new(), "users/nobody".to_owned()];
        for path in paths {
            let segments = path.split('/').collect::<Vec<_>>();
            for depth in (2..=segments.len()).step_by(2) {
                parents.push(segments[..depth].join("/"));
            }
        }
        parents.sort();
        parents.dedup();
        let answered = index
            .subcollections("(default)", &parents)
            .await
            .expect("subcollections");
        for parent in &answered.parents {
            let listed = snapshot
                .direct_collection_ids(
                    &database,
                    if parent.path.is_empty() {
                        None
                    } else {
                        Some(parent.path.as_str())
                    },
                )
                .into_iter()
                .collect::<Vec<_>>();
            assert_eq!(
                parent
                    .collections
                    .iter()
                    .map(|child| child.id.clone())
                    .collect::<Vec<_>>(),
                listed,
                "under {:?}",
                parent.path
            );
        }
        // And the counts are the counts the store would aggregate.
        let orders = answered
            .parents
            .iter()
            .find(|parent| parent.path == "users/abc")
            .expect("a parent with posts");
        assert_eq!(
            orders.collections,
            [Subcollection {
                id: "posts".to_owned(),
                documents: 1
            }]
        );
    }

    #[tokio::test]
    async fn the_route_answers_a_batch_and_refuses_what_it_cannot_answer() {
        let store = Store::default();
        store
            .commit(&[create("users/u1/orders/o1")])
            .expect("commit");
        let index = SchemaIndex::attach(&store, PROJECT);
        let (status, value) = post(
            index.clone(),
            json!({ "database": "(default)", "paths": ["users/u1"] }),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(value["database"], "(default)");
        assert_eq!(value["revision"], store.revision().get());
        assert_eq!(value["parents"][0]["path"], "users/u1");
        assert_eq!(value["parents"][0]["collections"][0]["id"], "orders");
        assert_eq!(value["parents"][0]["collections"][0]["documents"], 1);

        let (status, value) = post(index.clone(), json!({ "paths": ["users"] })).await;
        assert_eq!(
            status,
            StatusCode::BAD_REQUEST,
            "a collection path is not a parent document"
        );
        assert_eq!(value["error"]["message"], "not a document path: users");

        let (status, _) = post(index.clone(), json!({ "paths": ["users//o1"] })).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);

        let too_many = (0..=PATH_LIMIT)
            .map(|n| format!("users/u{n}"))
            .collect::<Vec<_>>();
        let (status, value) = post(index.clone(), json!({ "paths": too_many })).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(
            value["error"]["message"]
                .as_str()
                .expect("message")
                .contains("at most 500 paths"),
            "{value}"
        );

        let (status, _) = post(index, json!({ "database": "no/slashes", "paths": [] })).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    #[test]
    fn a_pattern_replaces_document_ids() {
        assert_eq!(pattern_of("users/u1"), "users");
        assert_eq!(pattern_of("users/u1/orders/o1"), "users/*/orders");
        assert_eq!(
            pattern_of("users/u1/orders/o1/items/i1"),
            "users/*/orders/*/items"
        );
    }

    #[tokio::test]
    async fn the_walk_counts_documents_and_parents_per_pattern() {
        let store = Store::default();
        store
            .commit(&[
                create("users/u1"),
                create("users/u2"),
                create("users/u1/orders/o1"),
                create("users/u1/orders/o2"),
                create("users/u2/orders/o1"),
                create("users/u1/orders/o1/items/i1"),
                create("teams/t1/channels/c1/messages/m1"),
            ])
            .expect("commit");
        let index = SchemaIndex::attach(&store, PROJECT);
        let snapshot = index.snapshot("(default)").await.expect("schema");
        assert_eq!(snapshot.documents, 7);
        assert_eq!(snapshot.revision, store.revision().get());
        assert_eq!(
            patterns(&snapshot),
            vec![
                ("teams".to_owned(), 0, None),
                ("teams/*/channels".to_owned(), 0, Some(0)),
                ("teams/*/channels/*/messages".to_owned(), 1, Some(1)),
                ("users".to_owned(), 2, None),
                ("users/*/orders".to_owned(), 3, Some(2)),
                ("users/*/orders/*/items".to_owned(), 1, Some(1)),
            ]
        );
    }

    #[tokio::test]
    async fn commits_move_the_counts_and_empty_patterns_disappear() {
        let store = Store::default();
        let index = SchemaIndex::attach(&store, PROJECT);
        store
            .commit(&[create("users/u1"), create("users/u1/orders/o1")])
            .expect("commit");
        assert_eq!(
            patterns(&index.snapshot("(default)").await.expect("schema")),
            vec![
                ("users".to_owned(), 1, None),
                ("users/*/orders".to_owned(), 1, Some(1)),
            ]
        );
        store
            .commit(&[create("users/u1/orders/o2"), create("users/u2/orders/o1")])
            .expect("commit");
        store
            .commit(&[delete("users/u1/orders/o1")])
            .expect("commit");
        let snapshot = index.snapshot("(default)").await.expect("schema");
        assert_eq!(
            patterns(&snapshot),
            vec![
                ("users".to_owned(), 1, None),
                ("users/*/orders".to_owned(), 2, Some(2)),
            ]
        );
        store
            .commit(&[delete("users/u1/orders/o2"), delete("users/u2/orders/o1")])
            .expect("commit");
        let snapshot = index.snapshot("(default)").await.expect("schema");
        assert_eq!(patterns(&snapshot), vec![("users".to_owned(), 1, None)]);
        assert_eq!(snapshot.revision, store.revision().get());
    }

    #[tokio::test]
    async fn an_update_changes_nothing_and_a_bad_database_is_refused() {
        let store = Store::default();
        let index = SchemaIndex::attach(&store, PROJECT);
        store.commit(&[create("users/u1")]).expect("commit");
        let before = index.snapshot("(default)").await.expect("schema");
        store
            .commit(&[Write::Set {
                key: key("users/u1"),
                fields: Fields::new(),
                transforms: Vec::new(),
                precondition: Precondition::None,
            }])
            .expect("commit");
        let after = index.snapshot("(default)").await.expect("schema");
        assert_eq!(patterns(&before), patterns(&after));
        assert!(matches!(
            index.snapshot("no/slashes").await,
            Err(SchemaError::InvalidDatabase(_))
        ));
    }
}
