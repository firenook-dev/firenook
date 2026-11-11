//! The Firestore indexes: what each database's index file declares, and the
//! indexes production would refuse queries for.
//!
//! The local engine answers a query whose composite index the project has
//! not declared, as the official emulator does, so a query that works here
//! can fail after a deploy. The suite keeps every such index
//! ([`MissingIndexes`]): which database, the index, the first query that
//! needed it (its fields and operators, never its values), how many queries
//! needed it and whether the file in force declares it now.
//!
//! This module serves the console's Indexes page: what each file in force
//! declares (`GET /firestore/indexes`), the missing list
//! (`GET /firestore/indexes/missing`), and edits to the file
//! (`POST /firestore/indexes/edit`), which add an entry or take one out of
//! `firestore.indexes.json` itself and put the file in force at once. It
//! keeps every open page current on the live channel's `firestore.indexes`
//! topic, counts the indexes still missing on the page's
//! `firestore.indexes` badge, and puts a file saved in an editor in force
//! ([`FirestoreIndexes::install`]).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use axum::Json;
use axum::extract::State;
use firenook_query_engine::{
    Direction, FieldOperator, FieldOverrideEntry, IndexCatalog, IndexCatalogs, IndexDirection,
    IndexMode, IndexRequirement, MISSING_INDEXES_LISTED, MissingIndexChange, MissingIndexRecord,
    MissingIndexes, QueryShape,
};
use firenook_rules_runtime::source_hash;
use futures_util::stream::{self, StreamExt as _};
use serde::{Deserialize, Serialize};
use tokio::sync::watch;
use tokio::time::Instant;
use ts_rs::TS;

use crate::api_error::ApiError;
use crate::blocking::blocking;
use crate::explain::{ExplainIndexField, ExplainOrder, index_fields, scope_name};
use crate::index_file::{self, Outcome, Section};
use crate::live::badges::{BadgeHandle, BadgeTone};
use crate::live::{LiveTopic, TopicEvent, TopicStream, topic_params};
use crate::sse::Shutdown;
use crate::time::rfc3339_system;

/// How often a subscriber hears that only the query counts moved: often
/// enough to watch them climb, rarely enough that a flood of queries does
/// not refetch the list on every one.
const COUNTS_EVERY: Duration = Duration::from_secs(2);

/// Told of an edit the console saved to a database's index file: the
/// database, and the line to log. The file watcher finds the text already
/// in force and says nothing, so this is the edit's one line.
pub type IndexesSaved = Arc<dyn Fn(&str, String) + Send + Sync>;

/// One field filter of the query that needed an index, without its value.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "firestore/")]
pub struct QueryFilterShape {
    pub field: String,
    /// The operator as the SDKs spell it: `==`, `<`, `<=`, `>`, `>=`, `!=`,
    /// `in`, `not-in`, `array-contains`, `array-contains-any`.
    pub op: String,
}

/// The first query that needed a missing index, as it was asked.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "firestore/")]
pub struct MissingIndexQuery {
    /// The collection path, or the collection id of a collection group
    /// query.
    pub target: String,
    pub collection_group: bool,
    pub filters: Vec<QueryFilterShape>,
    /// Whether filters are joined by `or` anywhere.
    pub disjunction: bool,
    pub orders: Vec<ExplainOrder>,
}

/// One index production would refuse a query for.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "firestore/")]
pub struct MissingIndexItem {
    pub database: String,
    pub collection_group: String,
    /// `collection` or `collectionGroup`.
    pub scope: String,
    pub fields: Vec<ExplainIndexField>,
    /// Whether it spans more than one field.
    pub composite: bool,
    /// Where the entry goes in `firestore.indexes.json`: `indexes`, or
    /// `fieldOverrides` for a single field.
    pub section: String,
    /// The entry to add there.
    #[ts(type = "Record<string, unknown>")]
    pub entry: serde_json::Value,
    pub query: MissingIndexQuery,
    /// How many queries needed it while it was not declared.
    #[ts(type = "number")]
    pub queries: u64,
    /// RFC 3339.
    pub first_seen: String,
    /// RFC 3339.
    pub last_seen: String,
    /// Whether the index file in force declares it now.
    pub declared: bool,
}

/// A database's index file, as `firebase.json` names it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "firestore/")]
pub struct IndexFileStatus {
    pub database: String,
    pub path: String,
    /// Why the file is not what is in force: it could not be read, or it is
    /// not a valid index file. The indexes it last declared stay in force.
    pub problem: Option<String>,
}

/// `GET /firestore/indexes/missing`.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "firestore/")]
pub struct MissingIndexList {
    /// Whether `--strict-indexes` refuses these queries, as production
    /// does; otherwise they are answered.
    pub strict: bool,
    /// Still missing first, then the most recently needed.
    pub indexes: Vec<MissingIndexItem>,
    /// Queries that needed an index past the listed ones.
    #[ts(type = "number")]
    pub unlisted: u64,
    pub files: Vec<IndexFileStatus>,
}

/// The `changed` event of `firestore.indexes`: the lists are stale.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "firestore/")]
pub struct IndexesChanged {}

/// A composite index the file declares, under `indexes`.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "firestore/")]
pub struct DeclaredIndex {
    pub collection_group: String,
    /// `collection` or `collectionGroup`.
    pub scope: String,
    /// Without the `__name__` every index ends with, unless the file gives
    /// it a direction of its own.
    pub fields: Vec<ExplainIndexField>,
    /// The entry as the file writes it: what Copy copies and Remove names.
    #[ts(type = "Record<string, unknown>")]
    pub entry: serde_json::Value,
}

/// One index of a field override.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "firestore/")]
pub struct OverrideIndex {
    /// `collection` or `collectionGroup`.
    pub scope: String,
    /// `ascending`, `descending`, `arrayContains` or `vector`.
    pub mode: String,
    #[ts(type = "number | null")]
    pub dimension: Option<usize>,
}

/// A field override the file declares, under `fieldOverrides`: the indexes
/// one field has in place of the automatic ones.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "firestore/")]
pub struct DeclaredFieldOverride {
    pub collection_group: String,
    pub field_path: String,
    /// None: the field is not indexed at all.
    pub indexes: Vec<OverrideIndex>,
    /// Whether documents expire at the time this field holds.
    pub ttl: bool,
    #[ts(type = "Record<string, unknown>")]
    pub entry: serde_json::Value,
}

/// One database's index file and what it declares.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "firestore/")]
pub struct DatabaseIndexes {
    pub database: String,
    /// The file, as `firebase.json` names it.
    pub path: String,
    /// Why the file on disk is not what is in force; the indexes it last
    /// declared stay.
    pub problem: Option<String>,
    /// The version of the file in force, which an edit names so that it
    /// never overwrites a change it has not seen; `null` before the file was
    /// ever read.
    pub revision: Option<String>,
    pub indexes: Vec<DeclaredIndex>,
    pub field_overrides: Vec<DeclaredFieldOverride>,
}

/// `GET /firestore/indexes`.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "firestore/")]
pub struct DeclaredIndexList {
    /// Whether `--strict-indexes` refuses a query whose index is not
    /// declared, as production does.
    pub strict: bool,
    /// Each database `firebase.json` names an index file for.
    pub databases: Vec<DatabaseIndexes>,
}

/// One entry of an edit.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "firestore/")]
pub struct IndexFileEntry {
    /// `indexes` or `fieldOverrides`.
    pub section: String,
    /// The entry as the file writes it.
    #[ts(type = "Record<string, unknown>")]
    pub entry: serde_json::Value,
}

/// `POST /firestore/indexes/edit`: entries to add to a database's index
/// file and entries to take out of it.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "firestore/")]
pub struct IndexesEditBody {
    #[ts(optional = nullable)]
    pub database: Option<String>,
    /// The `revision` the page read. The edit is refused when the file
    /// changed since.
    pub revision: Option<String>,
    #[serde(default)]
    pub add: Vec<IndexFileEntry>,
    #[serde(default)]
    pub remove: Vec<IndexFileEntry>,
}

/// What an edit did.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "firestore/")]
pub struct IndexesEdited {
    /// The database's file as it is in force now.
    pub file: DatabaseIndexes,
    /// Whether the file was written: false when every entry was declared
    /// already, or not there to take out.
    pub saved: bool,
    pub added: u32,
    pub removed: u32,
    pub unchanged: u32,
}

/// What moved since the start, as two counters a subscriber compares.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct Revision {
    /// An index listed, declared or missing again, or a file's status.
    listed: u64,
    /// Query counts.
    counted: u64,
}

struct IndexFile {
    path: PathBuf,
    problem: Option<String>,
    /// The text in force, once the file was read and valid.
    source: Option<Arc<str>>,
}

/// The Firestore indexes in force, the queries that needed one undeclared,
/// and each database's index file.
#[derive(Clone)]
pub struct FirestoreIndexes {
    catalogs: Arc<IndexCatalogs>,
    missing: Arc<MissingIndexes>,
    strict: bool,
    files: Arc<Mutex<BTreeMap<String, IndexFile>>>,
    revision: watch::Sender<Revision>,
    /// One edit at a time, from reading the file to putting it in force.
    editing: Arc<Mutex<()>>,
    saved: Option<IndexesSaved>,
}

impl FirestoreIndexes {
    /// The indexes as the suite started: `files` names each database's
    /// index file and the text it put in force, or why it was not read.
    #[must_use]
    pub fn new(
        catalogs: Arc<IndexCatalogs>,
        missing: Arc<MissingIndexes>,
        strict: bool,
        files: impl IntoIterator<Item = (String, PathBuf, Result<String, String>)>,
    ) -> Self {
        let (revision, _) = watch::channel(Revision::default());
        let told = revision.clone();
        missing.subscribe(Arc::new(move |change| {
            told.send_modify(|revision| match change {
                MissingIndexChange::Listed => revision.listed += 1,
                MissingIndexChange::Counted => revision.counted += 1,
            });
        }));
        Self {
            catalogs,
            missing,
            strict,
            files: Arc::new(Mutex::new(
                files
                    .into_iter()
                    .map(|(database, path, read)| {
                        let (source, problem) = match read {
                            Ok(source) => (Some(Arc::from(source)), None),
                            Err(problem) => (None, Some(problem)),
                        };
                        (
                            database,
                            IndexFile {
                                path,
                                problem,
                                source,
                            },
                        )
                    })
                    .collect(),
            )),
            revision,
            editing: Arc::new(Mutex::new(())),
            saved: None,
        }
    }

    /// Tells `saved` of every edit the console writes to an index file.
    #[must_use]
    pub fn with_saved_report(mut self, saved: IndexesSaved) -> Self {
        self.saved = Some(saved);
        self
    }

    /// The catalogs every query and explanation reads.
    #[must_use]
    pub fn catalogs(&self) -> &Arc<IndexCatalogs> {
        &self.catalogs
    }

    /// The hash ([`source_hash`]) of `database`'s file in force, when it was
    /// ever read: what the file watcher compares a saved file with.
    #[must_use]
    pub fn in_force_hash(&self, database: &str) -> Option<String> {
        self.files
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(database)
            .and_then(|file| file.source.as_deref().map(source_hash))
    }

    /// Puts `source`, a database's saved index file, in force: its queries
    /// are checked against it from the next one, and every listed index is
    /// asked whether it is declared now. A file that is not valid changes
    /// nothing and says why.
    pub fn install(&self, database: &str, source: &str) -> Result<(), String> {
        let catalog = IndexCatalog::from_json(source).map_err(|error| error.to_string())?;
        self.catalogs.replace(database, catalog);
        if let Some(file) = self
            .files
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get_mut(database)
        {
            file.source = Some(Arc::from(source));
        }
        self.missing.refresh(&self.catalogs);
        // What the file declares changed, whether or not a listed index did.
        self.revision.send_modify(|revision| revision.listed += 1);
        Ok(())
    }

    /// Records why `database`'s index file is not what is in force (`None`
    /// once it is fine again).
    pub fn set_file_problem(&self, database: &str, problem: Option<String>) {
        let changed = {
            let mut files = self.files.lock().unwrap_or_else(PoisonError::into_inner);
            files.get_mut(database).is_some_and(|file| {
                let changed = file.problem != problem;
                file.problem = problem;
                changed
            })
        };
        if changed {
            self.revision.send_modify(|revision| revision.listed += 1);
        }
    }

    /// The list as the console shows it.
    #[must_use]
    pub fn list(&self) -> MissingIndexList {
        let files = self
            .files
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .iter()
            .map(|(database, file)| IndexFileStatus {
                database: database.clone(),
                path: file.path.display().to_string(),
                problem: file.problem.clone(),
            })
            .collect();
        MissingIndexList {
            strict: self.strict,
            indexes: self
                .missing
                .list()
                .iter()
                .map(|record| item(record, &self.catalogs.catalog(&record.database)))
                .collect(),
            unlisted: self.missing.unlisted(),
            files,
        }
    }

    /// What each database's file in force declares.
    #[must_use]
    pub fn declared(&self) -> DeclaredIndexList {
        let files = self.files.lock().unwrap_or_else(PoisonError::into_inner);
        DeclaredIndexList {
            strict: self.strict,
            databases: files
                .iter()
                .map(|(database, file)| database_indexes(database, file))
                .collect(),
        }
    }

    fn database_file(&self, database: &str) -> Option<DatabaseIndexes> {
        self.files
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(database)
            .map(|file| database_indexes(database, file))
    }

    /// Adds entries to `database`'s index file and takes entries out of it,
    /// writes the file, and puts it in force. Refused, with the file left as
    /// it was, when `firebase.json` names no file for the database, when the
    /// file is not valid, when it changed since the page read `revision`, or
    /// when an entry is not one the file can hold.
    pub fn edit(&self, request: &IndexesEditBody) -> Result<IndexesEdited, ApiError> {
        let database = request.database.as_deref().unwrap_or("(default)");
        if request.add.len() + request.remove.len() > MISSING_INDEXES_LISTED {
            return Err(ApiError::invalid(format!(
                "an edit changes at most {MISSING_INDEXES_LISTED} entries"
            )));
        }
        let entries = |list: &[IndexFileEntry]| {
            list.iter()
                .map(|entry| {
                    Section::named(&entry.section)
                        .map(|section| (section, entry.entry.clone()))
                        .ok_or_else(|| {
                            ApiError::invalid(format!(
                                "\"{}\" is not a section of an index file: indexes or fieldOverrides",
                                entry.section
                            ))
                        })
                })
                .collect::<Result<Vec<_>, _>>()
        };
        let add = entries(&request.add)?;
        let remove = entries(&request.remove)?;
        let _editing = self.editing.lock().unwrap_or_else(PoisonError::into_inner);
        let (path, problem, in_force) = {
            let files = self.files.lock().unwrap_or_else(PoisonError::into_inner);
            let file = files.get(database).ok_or_else(|| {
                ApiError::precondition(format!(
                    "firebase.json names no index file for database \"{database}\""
                ))
                .with_fix("Name one under \"firestore\" in firebase.json, as \"indexes\": \"firestore.indexes.json\", and start the emulators again.")
            })?;
            (
                file.path.clone(),
                file.problem.clone(),
                file.source.as_deref().map(source_hash),
            )
        };
        let name = file_name(&path);
        let changed = || {
            ApiError::conflict(format!("{name} changed since this page read it"))
                .with_fix("The page shows it as it is now; make the change again.")
        };
        let disk = match std::fs::read_to_string(&path) {
            Ok(source) => Some(source),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => {
                return Err(ApiError::conflict(format!(
                    "{} could not be read: {error}",
                    path.display()
                )));
            }
        };
        // A file that is not there yet is made by the first edit; one that
        // is there and not valid is the developer's to fix.
        if let (Some(problem), Some(_)) = (problem, &disk) {
            return Err(
                ApiError::precondition(format!("{name} is not valid: {problem}"))
                    .with_fix("Fix it in your editor first: the console edits a valid file only."),
            );
        }
        // Saved in an editor a moment ago, before the watcher put it in
        // force: the page has not seen it either.
        if request.revision != in_force || disk.as_deref().map(source_hash) != in_force {
            return Err(changed());
        }
        let (text, outcome) = index_file::edit(disk.as_deref(), &add, &remove)
            .map_err(|error| ApiError::invalid(format!("{name} was not changed: {error}")))?;
        if outcome.changed() {
            std::fs::write(&path, &text).map_err(|error| {
                ApiError::conflict(format!("{} could not be written: {error}", path.display()))
            })?;
            // The watcher sees the write, finds it in force already and
            // installs nothing, so the edit is one change, not two.
            self.install(database, &text)
                .map_err(|error| ApiError::internal(format!("{name} was written but: {error}")))?;
            // A file that was not there is now.
            self.set_file_problem(database, None);
            if let Some(saved) = &self.saved {
                saved(
                    database,
                    format!(
                        "database \"{database}\" indexes saved to {} from the console ({})",
                        path.display(),
                        said(outcome)
                    ),
                );
            }
        }
        let count = |n: usize| u32::try_from(n).unwrap_or(u32::MAX);
        Ok(IndexesEdited {
            file: self
                .database_file(database)
                .ok_or_else(|| ApiError::internal("the index file went away"))?,
            saved: outcome.changed(),
            added: count(outcome.added),
            removed: count(outcome.removed),
            unchanged: count(outcome.unchanged),
        })
    }

    pub(crate) fn router(&self) -> axum::Router {
        axum::Router::new()
            .route("/indexes", axum::routing::get(declared_route))
            .route("/indexes/missing", axum::routing::get(missing_route))
            .route("/indexes/edit", axum::routing::post(edit_route))
            .with_state(self.clone())
    }

    /// The live channel's `firestore.indexes` topic.
    pub(crate) fn topic(&self) -> IndexesTopic {
        IndexesTopic {
            indexes: self.clone(),
        }
    }

    /// Keeps the `firestore.indexes` badge at the number of indexes still
    /// missing, until the suite stops.
    pub(crate) fn spawn_badge(&self, badge: BadgeHandle, shutdown: Shutdown) {
        fn publish(missing: &MissingIndexes, badge: &BadgeHandle) {
            let count = u64::try_from(missing.missing()).unwrap_or(u64::MAX);
            let tone = if count == 0 {
                BadgeTone::Neutral
            } else {
                BadgeTone::Attention
            };
            badge.set(count, tone);
        }
        let mut revisions = self.revision.subscribe();
        publish(&self.missing, &badge);
        let missing = Arc::clone(&self.missing);
        tokio::spawn(async move {
            let stopped = shutdown.stopped();
            tokio::pin!(stopped);
            let mut listed = revisions.borrow_and_update().listed;
            loop {
                tokio::select! {
                    biased;
                    () = &mut stopped => break,
                    moved = revisions.changed() => {
                        if moved.is_err() {
                            break;
                        }
                        let now = revisions.borrow_and_update().listed;
                        if now != listed {
                            listed = now;
                            publish(&missing, &badge);
                        }
                    }
                }
            }
        });
    }
}

async fn missing_route(State(indexes): State<FirestoreIndexes>) -> Json<MissingIndexList> {
    Json(indexes.list())
}

async fn declared_route(State(indexes): State<FirestoreIndexes>) -> Json<DeclaredIndexList> {
    Json(indexes.declared())
}

/// Reading and writing the file are blocking.
async fn edit_route(
    State(indexes): State<FirestoreIndexes>,
    Json(request): Json<IndexesEditBody>,
) -> Result<Json<IndexesEdited>, ApiError> {
    blocking("the index file edit", move || indexes.edit(&request))
        .await
        .map(Json)
}

/// A file's name, as people know it.
fn file_name(path: &Path) -> String {
    path.file_name().map_or_else(
        || path.display().to_string(),
        |name| name.to_string_lossy().into_owned(),
    )
}

/// What an edit did, as its log line says it: `1 added, 1 removed`.
fn said(outcome: Outcome) -> String {
    let mut parts = Vec::new();
    if outcome.added > 0 {
        parts.push(format!("{} added", outcome.added));
    }
    if outcome.removed > 0 {
        parts.push(format!("{} removed", outcome.removed));
    }
    parts.join(", ")
}

/// A database's file as the page shows it: what the text in force
/// declares, entry by entry, in the file's order.
fn database_indexes(database: &str, file: &IndexFile) -> DatabaseIndexes {
    let parsed = file
        .source
        .as_deref()
        .and_then(|source| serde_json::from_str::<serde_json::Value>(source).ok())
        .unwrap_or_default();
    let section = |key: &str| {
        parsed
            .get(key)
            .and_then(serde_json::Value::as_array)
            .cloned()
            .unwrap_or_default()
    };
    DatabaseIndexes {
        database: database.to_owned(),
        path: file.path.display().to_string(),
        problem: file.problem.clone(),
        revision: file.source.as_deref().map(source_hash),
        indexes: section("indexes")
            .into_iter()
            .filter_map(|entry| {
                let index = IndexRequirement::from_entry(&entry).ok()?;
                Some(DeclaredIndex {
                    collection_group: index.collection_group.clone(),
                    scope: scope_name(index.query_scope).to_owned(),
                    fields: index_fields(&index),
                    entry,
                })
            })
            .collect(),
        field_overrides: section("fieldOverrides")
            .into_iter()
            .filter_map(|entry| {
                let read = FieldOverrideEntry::from_entry(&entry).ok()?;
                Some(DeclaredFieldOverride {
                    collection_group: read.collection_group,
                    field_path: read.field_path,
                    indexes: read
                        .indexes
                        .iter()
                        .map(|index| OverrideIndex {
                            scope: scope_name(index.scope).to_owned(),
                            mode: match index.mode {
                                IndexMode::Ordered(IndexDirection::Ascending) => "ascending",
                                IndexMode::Ordered(IndexDirection::Descending) => "descending",
                                IndexMode::ArrayContains => "arrayContains",
                                IndexMode::Vector(_) => "vector",
                            }
                            .to_owned(),
                            dimension: match index.mode {
                                IndexMode::Vector(dimension) => Some(dimension),
                                IndexMode::Ordered(_) | IndexMode::ArrayContains => None,
                            },
                        })
                        .collect(),
                    ttl: read.ttl,
                    entry,
                })
            })
            .collect(),
    }
}

fn item(record: &MissingIndexRecord, catalog: &IndexCatalog) -> MissingIndexItem {
    let (section, entry) = record.requirement.declaration_in(catalog);
    MissingIndexItem {
        database: record.database.clone(),
        collection_group: record.requirement.collection_group.clone(),
        scope: scope_name(record.requirement.query_scope).to_owned(),
        fields: index_fields(&record.requirement),
        composite: record.requirement.is_composite(),
        section: section.to_owned(),
        entry,
        query: query(&record.query),
        queries: record.queries,
        first_seen: rfc3339_system(record.first_seen),
        last_seen: rfc3339_system(record.last_seen),
        declared: record.declared,
    }
}

fn query(shape: &QueryShape) -> MissingIndexQuery {
    MissingIndexQuery {
        target: shape.target.clone(),
        collection_group: shape.collection_group,
        filters: shape
            .filters
            .iter()
            .map(|filter| QueryFilterShape {
                field: filter.field.clone(),
                op: operator(filter.operator).to_owned(),
            })
            .collect(),
        disjunction: shape.disjunction,
        orders: shape
            .orders
            .iter()
            .map(|order| ExplainOrder {
                field: order.field.clone(),
                descending: order.direction == Direction::Descending,
            })
            .collect(),
    }
}

/// An operator as the SDKs spell it.
const fn operator(operator: FieldOperator) -> &'static str {
    match operator {
        FieldOperator::Equal => "==",
        FieldOperator::LessThan => "<",
        FieldOperator::LessThanOrEqual => "<=",
        FieldOperator::GreaterThan => ">",
        FieldOperator::GreaterThanOrEqual => ">=",
        FieldOperator::NotEqual => "!=",
        FieldOperator::In => "in",
        FieldOperator::NotIn => "not-in",
        FieldOperator::ArrayContains => "array-contains",
        FieldOperator::ArrayContainsAny => "array-contains-any",
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct NoParams {}

/// The live channel's `firestore.indexes` topic: `changed` →
/// [`IndexesChanged`] when the list changed, at once for an index listed,
/// declared or missing again and a file's status, at most every
/// [`COUNTS_EVERY`] for query counts alone. Invalidation only: nothing to
/// resume.
pub(crate) struct IndexesTopic {
    indexes: FirestoreIndexes,
}

impl LiveTopic for IndexesTopic {
    fn name(&self) -> &'static str {
        "firestore.indexes"
    }

    fn open(
        &self,
        params: &serde_json::Value,
        _after: Option<&str>,
    ) -> Result<TopicStream, ApiError> {
        let NoParams {} = topic_params(params)?;
        let mut receiver = self.indexes.revision.subscribe();
        let seen = *receiver.borrow_and_update();
        let state = (receiver, seen, None::<Instant>);
        Ok(
            stream::unfold(state, |(mut receiver, mut seen, mut last)| async move {
                loop {
                    let now = *receiver.borrow_and_update();
                    if now.listed != seen.listed {
                        seen = now;
                        last = Some(Instant::now());
                        return Some((changed(), (receiver, seen, last)));
                    }
                    if now.counted != seen.counted {
                        // Counts alone: wait out the interval, unless the
                        // list itself moves meanwhile.
                        let due = last.map_or_else(Instant::now, |at| at + COUNTS_EVERY);
                        tokio::select! {
                            () = tokio::time::sleep_until(due) => {
                                seen = *receiver.borrow_and_update();
                                last = Some(Instant::now());
                                return Some((changed(), (receiver, seen, last)));
                            }
                            moved = receiver.changed() => {
                                if moved.is_err() {
                                    return None;
                                }
                                continue;
                            }
                        }
                    }
                    if receiver.changed().await.is_err() {
                        return None;
                    }
                }
            })
            .boxed(),
        )
    }
}

fn changed() -> TopicEvent {
    TopicEvent::json("changed", None, &IndexesChanged {})
}

#[cfg(test)]
#[path = "indexes_tests.rs"]
mod tests;
