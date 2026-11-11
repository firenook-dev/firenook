//! The indexes production would refuse queries for.
//!
//! The local engine answers a query whose composite index the project has
//! not declared, as the official emulator does, so a query that works here
//! can fail after a deploy. The suite keeps every such index
//! ([`MissingIndexes`]): which database, the index, the first query that
//! needed it (its fields and operators, never its values), how many queries
//! needed it and whether the file in force declares it now. This module
//! shows that list to the console (`GET /firestore/indexes/missing`), keeps
//! it current on the live channel's `firestore.indexes` topic, counts the
//! indexes still missing on the Data page's `firestore.indexes` badge, and
//! puts a saved index file in force ([`FirestoreIndexes::install`]).

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use axum::Json;
use axum::extract::State;
use firenook_query_engine::{
    Direction, FieldOperator, IndexCatalog, IndexCatalogs, MissingIndexChange, MissingIndexRecord,
    MissingIndexes, QueryShape,
};
use futures_util::stream::{self, StreamExt as _};
use serde::{Deserialize, Serialize};
use tokio::sync::watch;
use tokio::time::Instant;
use ts_rs::TS;

use crate::api_error::ApiError;
use crate::explain::{ExplainIndexField, ExplainOrder, index_fields, scope_name};
use crate::live::badges::{BadgeHandle, BadgeTone};
use crate::live::{LiveTopic, TopicEvent, TopicStream, topic_params};
use crate::sse::Shutdown;
use crate::time::rfc3339_system;

/// How often a subscriber hears that only the query counts moved: often
/// enough to watch them climb, rarely enough that a flood of queries does
/// not refetch the list on every one.
const COUNTS_EVERY: Duration = Duration::from_secs(2);

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

/// The `changed` event of `firestore.indexes`: the list is stale.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "firestore/")]
pub struct IndexesChanged {}

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
}

impl FirestoreIndexes {
    /// The indexes as the suite started: `files` names each database's
    /// index file and why it was not read, when it was not.
    #[must_use]
    pub fn new(
        catalogs: Arc<IndexCatalogs>,
        missing: Arc<MissingIndexes>,
        strict: bool,
        files: impl IntoIterator<Item = (String, PathBuf, Option<String>)>,
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
                    .map(|(database, path, problem)| (database, IndexFile { path, problem }))
                    .collect(),
            )),
            revision,
        }
    }

    /// The catalogs every query and explanation reads.
    #[must_use]
    pub fn catalogs(&self) -> &Arc<IndexCatalogs> {
        &self.catalogs
    }

    /// Puts `source`, a database's saved index file, in force: its queries
    /// are checked against it from the next one, and every listed index is
    /// asked whether it is declared now. A file that is not valid changes
    /// nothing and says why.
    pub fn install(&self, database: &str, source: &str) -> Result<(), String> {
        let catalog = IndexCatalog::from_json(source).map_err(|error| error.to_string())?;
        self.catalogs.replace(database, catalog);
        self.missing.refresh(&self.catalogs);
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
            indexes: self.missing.list().iter().map(item).collect(),
            unlisted: self.missing.unlisted(),
            files,
        }
    }

    pub(crate) fn router(&self) -> axum::Router {
        axum::Router::new()
            .route("/indexes/missing", axum::routing::get(missing_route))
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

fn item(record: &MissingIndexRecord) -> MissingIndexItem {
    let (section, entry) = record.requirement.declaration();
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
