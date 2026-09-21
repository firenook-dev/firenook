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

use std::collections::{BTreeMap, HashMap};
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
    /// Nested collection path → its direct document count, so a delete
    /// knows when a parent loses the last document of a subcollection.
    collections: HashMap<Arc<str>, u64>,
}

#[derive(Clone, Copy, Default)]
struct Counts {
    documents: u64,
    parents: u64,
}

enum Step {
    Ready(SchemaSnapshot),
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
            .with_state(self)
    }

    /// The shape of `database_id`, walking it first if no console has asked
    /// yet. Concurrent callers share one walk.
    pub async fn snapshot(&self, database_id: &str) -> Result<SchemaSnapshot, SchemaError> {
        let database = DatabaseName::new(self.project.clone(), database_id)
            .map_err(|error| SchemaError::InvalidDatabase(error.to_string()))?;
        loop {
            // The lock never outlives this block, so no await holds it.
            let step = {
                let mut databases = lock(&self.databases);
                match databases.get(database_id) {
                    Some(Entry::Ready(index)) => Step::Ready(index.tree(database_id)),
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
                Step::Ready(snapshot) => return Ok(snapshot),
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
        let pattern = pattern_of(path);
        let empty = {
            let counts = self.patterns.entry(pattern.clone()).or_default();
            if created {
                counts.documents += 1;
                if nested {
                    let in_collection = self.collections.entry(Arc::from(collection)).or_insert(0);
                    *in_collection += 1;
                    if *in_collection == 1 {
                        counts.parents += 1;
                    }
                }
            } else {
                counts.documents = counts.documents.saturating_sub(1);
                if nested && let Some(in_collection) = self.collections.get_mut(collection) {
                    *in_collection = in_collection.saturating_sub(1);
                    if *in_collection == 0 {
                        self.collections.remove(collection);
                        counts.parents = counts.parents.saturating_sub(1);
                    }
                }
            }
            counts.documents == 0 && counts.parents == 0
        };
        if empty {
            self.patterns.remove(&pattern);
        }
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

/// `GET /schema?database=(default)`: the tree of collection patterns with
/// live counts.
async fn schema(State(index): State<SchemaIndex>, Query(params): Query<SchemaParams>) -> Response {
    let database = params.database.as_deref().unwrap_or("(default)");
    match index.snapshot(database).await {
        Ok(snapshot) => Json(snapshot).into_response(),
        Err(SchemaError::InvalidDatabase(message)) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": { "message": message } })),
        )
            .into_response(),
        Err(SchemaError::BuildFailed) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": { "message": "the schema walk did not finish" } })),
        )
            .into_response(),
    }
}

#[cfg(test)]
mod tests {
    use firenook_core_store::{DocumentKey, Fields, Precondition, Write};

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
