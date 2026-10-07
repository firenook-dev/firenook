//! What just changed, and putting it back.
//!
//! Every write the emulator accepts — from the console, from the app under
//! development, from a trigger — passes through the store's commit
//! observers with the document as it was and as it became. Keeping a
//! bounded window of those lets the console answer the question a local
//! database is asked more than any other: *what did I just do, and can I
//! undo it?*
//!
//! Three things make the undo trustworthy rather than a guess. It restores
//! the exact document the commit replaced, not a re-derivation of it. It
//! carries a precondition per document, so a commit that something has
//! changed since is refused whole rather than quietly overwriting newer
//! work. And it is one atomic commit, so a partial undo cannot happen.
//!
//! The window holds document data, so it is kept only while diagnostics are
//! enabled, bounded in both commits and bytes, and never persisted.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use axum::Json;
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use firenook_core_store::{
    Change, CommitObservation, CommitObserver, Document, DocumentKey, Precondition, Store,
    Timestamp, Write, document_key_logical_bytes, fields_logical_bytes,
};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Commits retained. Older ones fall off the back of the window.
const MAX_COMMITS: usize = 200;
/// Document bytes retained across the whole window.
const MAX_BYTES: u64 = 8 * 1024 * 1024;
/// A commit larger than this keeps its paths but not its documents: one
/// bulk import must not evict everything a person might actually undo.
const MAX_COMMIT_BYTES: u64 = 2 * 1024 * 1024;
/// Entries one listing may return.
const PAGE_LIMIT: usize = 100;

/// What happened to a document in a commit.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum LoggedKind {
    Created,
    Updated,
    Deleted,
}

/// One document in a logged commit.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LoggedDocument {
    /// Database id, for example `(default)`.
    pub database: String,
    /// Relative document path, for example `users/u_9f3k2`.
    pub path: String,
    pub kind: LoggedKind,
}

/// One atomic commit as the console lists it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LoggedCommit {
    /// Identifies this commit for an undo. Monotonic within the process.
    #[ts(type = "number")]
    pub id: u64,
    /// Store revision the commit installed.
    #[ts(type = "number")]
    pub revision: u64,
    /// Commit time, RFC 3339.
    pub commit_time: String,
    pub documents: Vec<LoggedDocument>,
    /// Whether the documents needed to put this back are still held. A
    /// commit too large to retain keeps its paths and loses its undo.
    pub undoable: bool,
    /// The commit this one undid, when it was an undo.
    #[ts(type = "number | null")]
    pub undid: Option<u64>,
    /// Whether an undo of this commit has already been applied.
    pub undone: bool,
}

/// The window, newest first.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ChangeLogPage {
    pub commits: Vec<LoggedCommit>,
    /// How many commits the window holds in total, across databases.
    #[ts(type = "number")]
    pub retained: u64,
}

/// What an undo did.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct UndoResult {
    /// The commit that was undone.
    #[ts(type = "number")]
    pub id: u64,
    /// The commit the undo itself installed.
    #[ts(type = "number")]
    pub revision: u64,
    /// Documents restored, deleted or recreated.
    #[ts(type = "number")]
    pub documents: u64,
}

/// One retained document transition, with the images an undo needs.
#[derive(Clone)]
struct Retained {
    key: DocumentKey,
    before: Option<Arc<Document>>,
    after: Option<Arc<Document>>,
}

impl Retained {
    const fn kind(&self) -> LoggedKind {
        match (&self.before, &self.after) {
            (None, Some(_)) => LoggedKind::Created,
            (Some(_), None) => LoggedKind::Deleted,
            _ => LoggedKind::Updated,
        }
    }

    /// The write that puts this document back as it was.
    fn inverse(&self) -> Write {
        match (&self.before, &self.after) {
            // It did not exist; remove it, unless it has moved on since.
            (None, Some(after)) => Write::Delete {
                key: self.key.clone(),
                precondition: Precondition::UpdateTime(after.update_time()),
            },
            // It was deleted; put it back, unless something took the name.
            (Some(before), None) => Write::Create {
                key: self.key.clone(),
                fields: before.fields().clone(),
            },
            // It was replaced; restore it, unless it has moved on since.
            (Some(before), after) => Write::Set {
                key: self.key.clone(),
                fields: before.fields().clone(),
                transforms: Vec::new(),
                precondition: after.as_ref().map_or(Precondition::Exists(true), |after| {
                    Precondition::UpdateTime(after.update_time())
                }),
            },
            (None, None) => Write::Verify {
                key: self.key.clone(),
                precondition: Precondition::None,
            },
        }
    }
}

struct Entry {
    id: u64,
    revision: u64,
    commit_time: Timestamp,
    /// Empty when the commit was too large to retain; the paths survive.
    retained: Vec<Retained>,
    documents: Vec<LoggedDocument>,
    bytes: u64,
    undid: Option<u64>,
    undone: bool,
}

#[derive(Default)]
struct Window {
    entries: VecDeque<Entry>,
    bytes: u64,
    next_id: u64,
}

impl Window {
    fn push(&mut self, entry: Entry) {
        self.bytes = self.bytes.saturating_add(entry.bytes);
        self.entries.push_back(entry);
        while self.entries.len() > MAX_COMMITS || self.bytes > MAX_BYTES {
            let Some(dropped) = self.entries.pop_front() else {
                break;
            };
            self.bytes = self.bytes.saturating_sub(dropped.bytes);
        }
    }
}

/// A bounded window of recent commits, registered with the store.
#[derive(Clone)]
pub struct ChangeLog {
    window: Arc<Mutex<Window>>,
    store: Store,
}

impl ChangeLog {
    /// Creates the log and registers it with `store`.
    #[must_use]
    pub fn attach(store: &Store) -> Self {
        let log = Self {
            window: Arc::new(Mutex::new(Window::default())),
            store: store.clone(),
        };
        store.add_commit_observer(Arc::new(log.clone()));
        log
    }

    pub(crate) fn router(self) -> axum::Router {
        axum::Router::new()
            .route("/changelog", axum::routing::get(changelog))
            .route("/undo", axum::routing::post(undo))
            .with_state(self)
    }

    /// The window for one database, newest first.
    #[must_use]
    pub fn page(&self, database: &str, limit: usize) -> ChangeLogPage {
        let window = self.window.lock().unwrap_or_else(|poisoned| {
            // A panic in a previous observer must not take the log down
            // with it; the window is only ever appended to and trimmed.
            poisoned.into_inner()
        });
        let commits = window
            .entries
            .iter()
            .rev()
            .filter(|entry| {
                entry
                    .documents
                    .iter()
                    .any(|document| document.database == database)
            })
            .take(limit.min(PAGE_LIMIT))
            .map(|entry| LoggedCommit {
                id: entry.id,
                revision: entry.revision,
                commit_time: rfc3339(entry.commit_time),
                documents: entry.documents.clone(),
                undoable: !entry.retained.is_empty() && !entry.undone,
                undid: entry.undid,
                undone: entry.undone,
            })
            .collect();
        ChangeLogPage {
            commits,
            retained: entry_count(&window),
        }
    }

    /// Puts one commit back, as one atomic commit of its own.
    pub fn undo(&self, id: u64) -> Result<UndoResult, UndoError> {
        let writes = {
            let window = self
                .window
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let entry = window
                .entries
                .iter()
                .find(|entry| entry.id == id)
                .ok_or(UndoError::Forgotten)?;
            if entry.undone {
                return Err(UndoError::AlreadyUndone);
            }
            if entry.retained.is_empty() {
                return Err(UndoError::TooLarge);
            }
            // In reverse, so a document written twice in one commit ends on
            // the image it had before the commit began.
            entry
                .retained
                .iter()
                .rev()
                .map(Retained::inverse)
                .collect::<Vec<_>>()
        };
        let documents = u64::try_from(writes.len()).unwrap_or(u64::MAX);
        let result = self
            .store
            .commit(&writes)
            .map_err(|error| UndoError::Refused(error.to_string()))?;
        // The observer has already recorded the undo by the time commit
        // returns, so the new entry is found by the revision it installed
        // rather than by being the newest, which a concurrent commit could
        // take from it.
        let mut window = self
            .window
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        for entry in &mut window.entries {
            if entry.id == id {
                entry.undone = true;
            } else if entry.revision == result.revision.get() {
                entry.undid = Some(id);
            }
        }
        Ok(UndoResult {
            id,
            revision: result.revision.get(),
            documents,
        })
    }
}

fn entry_count(window: &Window) -> u64 {
    u64::try_from(window.entries.len()).unwrap_or(u64::MAX)
}

/// One transition per document, however many writes a commit made to it.
///
/// A commit that writes the same document twice delivers two changes. Their
/// inverses would be two writes in one undo commit, each with a
/// precondition on a different update time, and the store evaluates both
/// against the state before the undo begins — so one of them is always
/// wrong and the whole undo is refused. The honest inverse is a single
/// write back to the image the document had before the commit began, with
/// a precondition on the image it had after.
fn collapse(changes: &[Change]) -> Vec<Retained> {
    let mut collapsed: Vec<Retained> = Vec::with_capacity(changes.len());
    for change in changes {
        if let Some(existing) = collapsed
            .iter_mut()
            .find(|retained| retained.key == change.key)
        {
            // Keep the earliest `before` and the latest `after`.
            existing.after.clone_from(&change.after);
        } else {
            collapsed.push(Retained {
                key: change.key.clone(),
                before: change.before.clone(),
                after: change.after.clone(),
            });
        }
    }
    collapsed
}

fn change_bytes(change: &Change) -> u64 {
    let image = |document: &Option<Arc<Document>>| {
        document
            .as_ref()
            .map_or(0, |document| fields_logical_bytes(document.fields()))
    };
    document_key_logical_bytes(&change.key)
        .saturating_add(image(&change.before))
        .saturating_add(image(&change.after))
}

impl CommitObserver for ChangeLog {
    fn committed(&self, observation: &CommitObservation) {
        let bytes = observation.changes.iter().map(change_bytes).sum::<u64>();
        let mut retained = collapse(&observation.changes);
        let documents = retained
            .iter()
            .map(|change| LoggedDocument {
                database: change.key.database().database_id().to_owned(),
                path: change.key.path().to_owned(),
                kind: change.kind(),
            })
            .collect();
        // A bulk import would otherwise evict every commit a person might
        // actually want back. Its paths stay listed; only its undo is lost.
        if bytes > MAX_COMMIT_BYTES {
            retained.clear();
        }
        let mut window = self
            .window
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        window.next_id = window.next_id.saturating_add(1);
        let id = window.next_id;
        window.push(Entry {
            id,
            revision: observation.result.revision.get(),
            commit_time: observation.result.commit_time,
            bytes: if retained.is_empty() { 0 } else { bytes },
            retained,
            documents,
            undid: None,
            undone: false,
        });
    }
}

fn rfc3339(value: Timestamp) -> String {
    time::OffsetDateTime::from_unix_timestamp(value.seconds())
        .and_then(|timestamp| timestamp.replace_nanosecond(value.nanos()))
        .ok()
        .and_then(|timestamp| {
            timestamp
                .format(&time::format_description::well_known::Rfc3339)
                .ok()
        })
        .unwrap_or_default()
}

/// Why an undo did not happen.
#[derive(Debug, PartialEq, Eq)]
pub enum UndoError {
    /// The window no longer holds it.
    Forgotten,
    /// It has already been put back.
    AlreadyUndone,
    /// Its documents were too large to retain.
    TooLarge,
    /// The store refused the writes, which a precondition failing is.
    Refused(String),
}

impl UndoError {
    fn parts(&self) -> (StatusCode, String) {
        match self {
            Self::Forgotten => (
                StatusCode::NOT_FOUND,
                "this change is older than the window the console keeps".to_owned(),
            ),
            Self::AlreadyUndone => (
                StatusCode::CONFLICT,
                "this change has already been undone".to_owned(),
            ),
            Self::TooLarge => (
                StatusCode::CONFLICT,
                "this change was too large to keep the documents it replaced".to_owned(),
            ),
            Self::Refused(error) => (
                StatusCode::CONFLICT,
                format!("a document has changed since; nothing was undone ({error})"),
            ),
        }
    }
}

impl IntoResponse for UndoError {
    fn into_response(self) -> Response {
        let (status, message) = self.parts();
        (
            status,
            Json(serde_json::json!({ "error": { "message": message } })),
        )
            .into_response()
    }
}

#[derive(Debug, Deserialize)]
pub(crate) struct ChangeLogRequest {
    database: Option<String>,
    limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UndoRequest {
    id: u64,
}

/// `GET /changelog?database=(default)&limit=50`: recent commits, newest first.
async fn changelog(
    State(log): State<ChangeLog>,
    Query(request): Query<ChangeLogRequest>,
) -> Json<ChangeLogPage> {
    let database = request.database.as_deref().unwrap_or("(default)");
    Json(log.page(database, request.limit.unwrap_or(PAGE_LIMIT)))
}

/// `POST /undo`: put one commit back.
async fn undo(
    State(log): State<ChangeLog>,
    Json(request): Json<UndoRequest>,
) -> Result<Json<UndoResult>, UndoError> {
    // Restoring documents writes to the store, which is work the async
    // workers must not block on.
    tokio::task::spawn_blocking(move || log.undo(request.id))
        .await
        .map_err(|_| UndoError::Refused("the undo task did not finish".to_owned()))?
        .map(Json)
}

#[cfg(test)]
mod tests {
    use axum::body::{Body, to_bytes};
    use axum::http::Request;
    use firenook_core_store::{Fields, Value};
    use tower::ServiceExt as _;

    use super::*;

    const PROJECT: &str = "demo-changelog";

    fn key(path: &str) -> DocumentKey {
        DocumentKey::new(
            firenook_core_store::DatabaseName::new(PROJECT, "(default)").expect("database"),
            path,
        )
        .expect("path")
    }

    fn text(value: &str) -> Fields {
        Fields::from([("note".to_owned(), Value::String(value.into()))])
    }

    fn note(store: &Store, path: &str) -> Option<String> {
        store
            .snapshot()
            .get(&key(path))
            .and_then(|document| match document.fields().get("note") {
                Some(Value::String(value)) => Some(value.to_string()),
                _ => None,
            })
    }

    #[test]
    fn a_creation_is_undone_by_removing_the_document() {
        let store = Store::default();
        let log = ChangeLog::attach(&store);
        store
            .commit(&[Write::Create {
                key: key("notes/n1"),
                fields: text("first"),
            }])
            .expect("commit");

        let page = log.page("(default)", 10);
        assert_eq!(page.commits.len(), 1);
        assert_eq!(page.commits[0].documents[0].kind, LoggedKind::Created);
        assert!(page.commits[0].undoable);

        log.undo(page.commits[0].id).expect("undo");
        assert_eq!(note(&store, "notes/n1"), None);
    }

    #[test]
    fn an_update_is_undone_to_the_exact_document_it_replaced() {
        let store = Store::default();
        let log = ChangeLog::attach(&store);
        store
            .commit(&[Write::Create {
                key: key("notes/n1"),
                fields: text("first"),
            }])
            .expect("create");
        store
            .commit(&[Write::Set {
                key: key("notes/n1"),
                fields: text("second"),
                transforms: Vec::new(),
                precondition: Precondition::None,
            }])
            .expect("update");
        assert_eq!(note(&store, "notes/n1").as_deref(), Some("second"));

        let page = log.page("(default)", 10);
        let update = page.commits.first().expect("the newest commit");
        assert_eq!(update.documents[0].kind, LoggedKind::Updated);
        log.undo(update.id).expect("undo");
        assert_eq!(note(&store, "notes/n1").as_deref(), Some("first"));
    }

    #[test]
    fn a_deletion_is_undone_by_putting_the_document_back() {
        let store = Store::default();
        let log = ChangeLog::attach(&store);
        store
            .commit(&[Write::Create {
                key: key("notes/n1"),
                fields: text("first"),
            }])
            .expect("create");
        store
            .commit(&[Write::Delete {
                key: key("notes/n1"),
                precondition: Precondition::None,
            }])
            .expect("delete");

        let page = log.page("(default)", 10);
        let deletion = page.commits.first().expect("the newest commit");
        assert_eq!(deletion.documents[0].kind, LoggedKind::Deleted);
        log.undo(deletion.id).expect("undo");
        assert_eq!(note(&store, "notes/n1").as_deref(), Some("first"));
    }

    #[test]
    fn an_undo_is_refused_whole_when_a_document_moved_on() {
        let store = Store::default();
        let log = ChangeLog::attach(&store);
        store
            .commit(&[
                Write::Create {
                    key: key("notes/n1"),
                    fields: text("first"),
                },
                Write::Create {
                    key: key("notes/n2"),
                    fields: text("first"),
                },
            ])
            .expect("create");
        store
            .commit(&[
                Write::Set {
                    key: key("notes/n1"),
                    fields: text("second"),
                    transforms: Vec::new(),
                    precondition: Precondition::None,
                },
                Write::Set {
                    key: key("notes/n2"),
                    fields: text("second"),
                    transforms: Vec::new(),
                    precondition: Precondition::None,
                },
            ])
            .expect("update");
        let update = log.page("(default)", 10).commits[0].id;

        // Something else writes one of the two documents afterwards.
        store
            .commit(&[Write::Set {
                key: key("notes/n2"),
                fields: text("someone else"),
                transforms: Vec::new(),
                precondition: Precondition::None,
            }])
            .expect("later write");

        let refused = log.undo(update).expect_err("the undo must be refused");
        assert!(matches!(refused, UndoError::Refused(_)), "{refused:?}");
        // Nothing was put back, not even the document that had not moved on.
        assert_eq!(note(&store, "notes/n1").as_deref(), Some("second"));
        assert_eq!(note(&store, "notes/n2").as_deref(), Some("someone else"));
    }

    #[test]
    fn a_document_written_twice_in_one_commit_ends_where_it_started() {
        let store = Store::default();
        let log = ChangeLog::attach(&store);
        store
            .commit(&[Write::Create {
                key: key("notes/n1"),
                fields: text("first"),
            }])
            .expect("create");
        store
            .commit(&[
                Write::Set {
                    key: key("notes/n1"),
                    fields: text("second"),
                    transforms: Vec::new(),
                    precondition: Precondition::None,
                },
                Write::Set {
                    key: key("notes/n1"),
                    fields: text("third"),
                    transforms: Vec::new(),
                    precondition: Precondition::None,
                },
            ])
            .expect("twice");
        let twice = log.page("(default)", 10).commits[0].id;
        log.undo(twice).expect("undo");
        assert_eq!(note(&store, "notes/n1").as_deref(), Some("first"));
    }

    #[test]
    fn an_undo_is_itself_a_commit_that_can_be_undone() {
        let store = Store::default();
        let log = ChangeLog::attach(&store);
        store
            .commit(&[Write::Create {
                key: key("notes/n1"),
                fields: text("first"),
            }])
            .expect("create");
        let creation = log.page("(default)", 10).commits[0].id;
        log.undo(creation).expect("undo");
        assert_eq!(note(&store, "notes/n1"), None);

        let page = log.page("(default)", 10);
        let undo = &page.commits[0];
        assert_eq!(undo.undid, Some(creation));
        assert!(
            page.commits
                .iter()
                .any(|commit| commit.id == creation && commit.undone),
            "the original is marked as undone: {page:?}"
        );
        // Undoing the undo puts the document back.
        log.undo(undo.id).expect("redo");
        assert_eq!(note(&store, "notes/n1").as_deref(), Some("first"));
    }

    #[test]
    fn the_same_commit_is_not_undone_twice() {
        let store = Store::default();
        let log = ChangeLog::attach(&store);
        store
            .commit(&[Write::Create {
                key: key("notes/n1"),
                fields: text("first"),
            }])
            .expect("create");
        let creation = log.page("(default)", 10).commits[0].id;
        log.undo(creation).expect("undo");
        assert_eq!(log.undo(creation), Err(UndoError::AlreadyUndone));
    }

    #[test]
    fn the_window_forgets_the_oldest_commits_rather_than_growing() {
        let store = Store::default();
        let log = ChangeLog::attach(&store);
        for index in 0..(MAX_COMMITS + 20) {
            store
                .commit(&[Write::Create {
                    key: key(&format!("notes/n{index}")),
                    fields: text("x"),
                }])
                .expect("commit");
        }
        let page = log.page("(default)", PAGE_LIMIT);
        assert_eq!(page.retained, MAX_COMMITS as u64);
        // The oldest are gone, so their undo is refused rather than wrong.
        assert_eq!(log.undo(1), Err(UndoError::Forgotten));
        // The newest is still there.
        assert!(page.commits[0].undoable);
    }

    #[test]
    fn a_commit_too_large_to_retain_keeps_its_paths_and_loses_its_undo() {
        let store = Store::default();
        let log = ChangeLog::attach(&store);
        let big = "x".repeat(usize::try_from(MAX_COMMIT_BYTES).unwrap_or(usize::MAX) + 1);
        store
            .commit(&[Write::Create {
                key: key("notes/huge"),
                fields: Fields::from([("note".to_owned(), Value::String(big.into()))]),
            }])
            .expect("commit");
        let page = log.page("(default)", 10);
        assert_eq!(page.commits[0].documents[0].path, "notes/huge");
        assert!(
            !page.commits[0].undoable,
            "a commit whose documents were dropped must not offer an undo"
        );
        assert_eq!(log.undo(page.commits[0].id), Err(UndoError::TooLarge));
    }

    #[test]
    fn each_database_lists_only_its_own_commits() {
        let store = Store::default();
        let log = ChangeLog::attach(&store);
        let other = DocumentKey::new(
            firenook_core_store::DatabaseName::new(PROJECT, "analytics").expect("database"),
            "events/e1",
        )
        .expect("path");
        store
            .commit(&[Write::Create {
                key: key("notes/n1"),
                fields: text("first"),
            }])
            .expect("default");
        store
            .commit(&[Write::Create {
                key: other,
                fields: text("event"),
            }])
            .expect("analytics");
        assert_eq!(log.page("(default)", 10).commits.len(), 1);
        assert_eq!(log.page("analytics", 10).commits.len(), 1);
        assert_eq!(
            log.page("(default)", 10).retained,
            2,
            "the window holds both"
        );
    }

    #[tokio::test]
    async fn the_routes_list_and_undo() {
        let store = Store::default();
        let log = ChangeLog::attach(&store);
        store
            .commit(&[Write::Create {
                key: key("notes/n1"),
                fields: text("first"),
            }])
            .expect("commit");
        let router = log.router();

        let response = router
            .clone()
            .oneshot(
                Request::get("/changelog?database=(default)")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body");
        let page: serde_json::Value = serde_json::from_slice(&body).expect("json");
        assert_eq!(page["commits"][0]["documents"][0]["path"], "notes/n1");
        let id = page["commits"][0]["id"].as_u64().expect("an id");

        let response = router
            .clone()
            .oneshot(
                Request::post("/undo")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::json!({ "id": id }).to_string()))
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(note(&store, "notes/n1"), None);

        // A second undo is refused with a reason, not silently accepted.
        let response = router
            .oneshot(
                Request::post("/undo")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::json!({ "id": id }).to_string()))
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::CONFLICT);
        let body = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body");
        let error: serde_json::Value = serde_json::from_slice(&body).expect("json");
        assert!(
            error["error"]["message"]
                .as_str()
                .is_some_and(|message| message.contains("already been undone")),
            "{error}"
        );
    }
}
