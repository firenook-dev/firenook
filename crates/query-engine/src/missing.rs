//! The indexes each database declares, replaced when its file is saved, and
//! the queries that needed one it does not declare.
//!
//! Production refuses a query whose composite index the project has not
//! declared; the official emulator answers it. Firenook answers it too and
//! keeps, per database and index, what a developer needs to fix it before a
//! deploy: the index to declare, the shape of the first query that needed it
//! (its fields and operators, never its values), how many queries needed it,
//! and whether the file in force declares it now.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, RwLock};
use std::time::SystemTime;

use crate::indexes::{IndexCatalog, IndexRequirement};
use crate::query::{Direction, FieldOperator, Filter, Query, QueryScope};
use crate::{MissingIndex, MissingIndexSink};

/// How many distinct missing indexes are listed. Code that orders by a map
/// entry named after a user (`ratings.<uid>`) needs a different index for
/// every user, so the list is bounded; past it, queries are only counted.
pub const MISSING_INDEXES_LISTED: usize = 1_000;

/// The declared indexes of every database. A database without a catalog of
/// its own reads the fallback: the standalone server's one file, or nothing
/// declared. A database's catalog is replaced when its file is saved.
#[derive(Debug, Default)]
pub struct IndexCatalogs {
    fallback: Arc<IndexCatalog>,
    databases: RwLock<BTreeMap<String, Arc<IndexCatalog>>>,
}

impl IndexCatalogs {
    /// The catalogs in force at start: `databases` by database id, and
    /// `fallback` for any other database.
    #[must_use]
    pub fn new(
        fallback: Arc<IndexCatalog>,
        databases: BTreeMap<String, Arc<IndexCatalog>>,
    ) -> Self {
        Self {
            fallback,
            databases: RwLock::new(databases),
        }
    }

    /// The catalog `database` reads now.
    #[must_use]
    pub fn catalog(&self, database: &str) -> Arc<IndexCatalog> {
        self.databases
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .get(database)
            .map_or_else(|| Arc::clone(&self.fallback), Arc::clone)
    }

    /// Puts `catalog` in force for `database`, as when its file is saved.
    pub fn replace(&self, database: &str, catalog: IndexCatalog) {
        self.databases
            .write()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(database.to_owned(), Arc::new(catalog));
    }
}

/// One field filter of a query, without its value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShapeFilter {
    /// The field path, `__name__` for the document id.
    pub field: String,
    pub operator: FieldOperator,
}

/// One `orderBy` of a query.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShapeOrder {
    /// The field path, `__name__` for the document id.
    pub field: String,
    pub direction: Direction,
}

/// What a query asked, without its values: enough to find it in the code.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueryShape {
    /// The collection path, or the collection id of a collection group query.
    pub target: String,
    /// Whether it reads every collection with that id.
    pub collection_group: bool,
    /// Each field filter's field and operator, in the query's order.
    pub filters: Vec<ShapeFilter>,
    /// Whether filters are joined by `or` anywhere.
    pub disjunction: bool,
    /// The query's own `orderBy` clauses, in order.
    pub orders: Vec<ShapeOrder>,
}

impl QueryShape {
    /// The shape of `query`.
    #[must_use]
    pub fn of(query: &Query) -> Self {
        let (target, collection_group) = match query.scope_ref() {
            QueryScope::Collection(path) => (path.clone(), false),
            QueryScope::CollectionGroup(id) => (id.clone(), true),
            QueryScope::AllDescendants => (String::new(), true),
        };
        let mut shape = Self {
            target,
            collection_group,
            filters: Vec::new(),
            disjunction: false,
            orders: query
                .orders_ref()
                .iter()
                .map(|order| ShapeOrder {
                    field: order.path.to_string(),
                    direction: order.direction,
                })
                .collect(),
        };
        if let Some(filter) = query.filter_ref() {
            shape.add(filter);
        }
        shape
    }

    fn add(&mut self, filter: &Filter) {
        match filter {
            Filter::Field(field) => self.filters.push(ShapeFilter {
                field: field.path.to_string(),
                operator: field.operator,
            }),
            Filter::And(filters) => {
                for filter in filters {
                    self.add(filter);
                }
            }
            Filter::Or(filters) => {
                self.disjunction = true;
                for filter in filters {
                    self.add(filter);
                }
            }
        }
    }
}

/// One index a query needed that its database's file did not declare.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MissingIndexRecord {
    /// The database id, `(default)` or a named one.
    pub database: String,
    /// The index to declare.
    pub requirement: IndexRequirement,
    /// The first query that needed it.
    pub query: QueryShape,
    /// How many queries needed it while it was not declared.
    pub queries: u64,
    pub first_seen: SystemTime,
    pub last_seen: SystemTime,
    /// Whether the file in force declares it now.
    pub declared: bool,
}

/// What moved in the list.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MissingIndexChange {
    /// An index joined the list, was needed again after being declared, or
    /// a file now declares one.
    Listed,
    /// Only the query counts moved.
    Counted,
}

/// Told of every change to the list, outside its lock.
pub type MissingIndexListener = Arc<dyn Fn(MissingIndexChange) + Send + Sync>;

/// A missing index as kept: the query that first needed it is kept whole,
/// so a saved file can be asked whether it declares the index now.
struct Slot {
    query: Query,
    shape: QueryShape,
    queries: u64,
    first_seen: SystemTime,
    last_seen: SystemTime,
    declared: bool,
    /// Whether the developer was told since a file last declared it.
    warned: bool,
}

#[derive(Default)]
struct Slots {
    /// Database id, then the index.
    by_database: BTreeMap<String, BTreeMap<IndexRequirement, Slot>>,
    listed: usize,
    /// Queries that needed an index past [`MISSING_INDEXES_LISTED`].
    unlisted: u64,
}

/// Every index the suite's queries needed and their databases did not
/// declare, with the developer told once of each: when it is first needed,
/// and again when it is needed after a saved file declared it and a later
/// one took it out.
pub struct MissingIndexes {
    slots: Mutex<Slots>,
    warn: Option<MissingIndexSink>,
    listeners: Mutex<Vec<MissingIndexListener>>,
}

impl std::fmt::Debug for MissingIndexes {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let slots = lock(&self.slots);
        formatter
            .debug_struct("MissingIndexes")
            .field("listed", &slots.listed)
            .field("unlisted", &slots.unlisted)
            .field("warns", &self.warn.is_some())
            .finish_non_exhaustive()
    }
}

impl MissingIndexes {
    /// An empty list; `warn` is told of each index the first time it is
    /// needed.
    #[must_use]
    pub fn new(warn: Option<MissingIndexSink>) -> Self {
        Self {
            slots: Mutex::default(),
            warn,
            listeners: Mutex::default(),
        }
    }

    /// Tells `listener` of every change from now on.
    pub fn subscribe(&self, listener: MissingIndexListener) {
        lock(&self.listeners).push(listener);
    }

    /// Counts a query on `database` that needed `requirement`, undeclared,
    /// and warns when that is news.
    pub(crate) fn record(&self, database: &str, requirement: &IndexRequirement, query: &Query) {
        let now = SystemTime::now();
        let (change, warn) = {
            let mut slots = lock(&self.slots);
            let listed = slots.listed;
            let indexes = slots.by_database.entry(database.to_owned()).or_default();
            if let Some(slot) = indexes.get_mut(requirement) {
                slot.queries += 1;
                slot.last_seen = now;
                let warn = !std::mem::replace(&mut slot.warned, true);
                if std::mem::replace(&mut slot.declared, false) {
                    (MissingIndexChange::Listed, warn)
                } else {
                    (MissingIndexChange::Counted, warn)
                }
            } else if listed >= MISSING_INDEXES_LISTED {
                slots.unlisted += 1;
                (MissingIndexChange::Counted, false)
            } else {
                indexes.insert(
                    requirement.clone(),
                    Slot {
                        query: query.clone(),
                        shape: QueryShape::of(query),
                        queries: 1,
                        first_seen: now,
                        last_seen: now,
                        declared: false,
                        warned: true,
                    },
                );
                slots.listed += 1;
                (MissingIndexChange::Listed, true)
            }
        };
        if warn && let Some(sink) = &self.warn {
            sink(&MissingIndex {
                database: database.to_owned(),
                requirement: requirement.clone(),
            });
        }
        self.tell(change);
    }

    /// Asks the catalogs in force whether they declare each listed index
    /// now, after a file was saved.
    pub fn refresh(&self, catalogs: &IndexCatalogs) {
        let moved = {
            let mut slots = lock(&self.slots);
            let mut moved = false;
            for (database, indexes) in &mut slots.by_database {
                let catalog = catalogs.catalog(database);
                for slot in indexes.values_mut() {
                    let declared = catalog
                        .advise(&slot.query)
                        .is_none_or(|advice| advice.declared);
                    moved |= declared != slot.declared;
                    slot.declared = declared;
                    // Declared, it is news again the next time it is missing.
                    slot.warned &= !declared;
                }
            }
            moved
        };
        if moved {
            self.tell(MissingIndexChange::Listed);
        }
    }

    /// Every listed index: those still missing first, then the most
    /// recently needed.
    #[must_use]
    pub fn list(&self) -> Vec<MissingIndexRecord> {
        let slots = lock(&self.slots);
        let mut records = slots
            .by_database
            .iter()
            .flat_map(|(database, indexes)| {
                indexes
                    .iter()
                    .map(|(requirement, slot)| MissingIndexRecord {
                        database: database.clone(),
                        requirement: requirement.clone(),
                        query: slot.shape.clone(),
                        queries: slot.queries,
                        first_seen: slot.first_seen,
                        last_seen: slot.last_seen,
                        declared: slot.declared,
                    })
            })
            .collect::<Vec<_>>();
        drop(slots);
        records.sort_by(|left, right| {
            left.declared
                .cmp(&right.declared)
                .then_with(|| right.last_seen.cmp(&left.last_seen))
        });
        records
    }

    /// How many listed indexes are still missing.
    #[must_use]
    pub fn missing(&self) -> usize {
        lock(&self.slots)
            .by_database
            .values()
            .flat_map(BTreeMap::values)
            .filter(|slot| !slot.declared)
            .count()
    }

    /// Queries that needed an index past the listed ones.
    #[must_use]
    pub fn unlisted(&self) -> u64 {
        lock(&self.slots).unlisted
    }

    fn tell(&self, change: MissingIndexChange) {
        let listeners = lock(&self.listeners).clone();
        for listener in listeners {
            listener(change);
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use firenook_core_store::Value;

    use super::*;
    use crate::query::{FieldFilter, FieldPath};
    use crate::{DatabaseEdition, QueryPolicy};

    fn field(name: &str) -> FieldPath {
        FieldPath::field([name]).expect("field")
    }

    fn equal(name: &str, value: Value) -> Filter {
        Filter::Field(FieldFilter {
            path: field(name),
            operator: FieldOperator::Equal,
            value,
        })
    }

    /// `orders` where `status ==` ordered by `total` descending: a composite
    /// index on (status, total desc).
    fn open_by_total() -> Query {
        Query::new(QueryScope::collection("orders").expect("scope"))
            .filter(equal("status", Value::Integer(1)))
            .order_by(field("total"), Direction::Descending)
    }

    const DECLARED: &str = r#"{"indexes":[{"collectionGroup":"orders","queryScope":"COLLECTION","fields":[
        {"fieldPath":"status","order":"ASCENDING"},{"fieldPath":"total","order":"DESCENDING"}]}]}"#;

    struct Fixture {
        catalogs: Arc<IndexCatalogs>,
        missing: Arc<MissingIndexes>,
        policy: QueryPolicy,
        warned: Arc<Mutex<Vec<String>>>,
        changes: Arc<Mutex<Vec<MissingIndexChange>>>,
    }

    fn fixture(strict: bool) -> Fixture {
        let warned = Arc::new(Mutex::new(Vec::new()));
        let told = Arc::clone(&warned);
        let missing = Arc::new(MissingIndexes::new(Some(Arc::new(
            move |missing: &MissingIndex| {
                lock(&told).push(format!(
                    "{} {}",
                    missing.database, missing.requirement.collection_group
                ));
            },
        ))));
        let changes = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&changes);
        missing.subscribe(Arc::new(move |change| lock(&seen).push(change)));
        let catalogs = Arc::new(IndexCatalogs::new(
            Arc::default(),
            BTreeMap::from([("(default)".to_owned(), Arc::default())]),
        ));
        let policy = QueryPolicy::new(DatabaseEdition::Standard).with_indexes(
            Arc::clone(&catalogs),
            strict,
            Some(Arc::clone(&missing)),
        );
        Fixture {
            catalogs,
            missing,
            policy,
            warned,
            changes,
        }
    }

    #[test]
    fn a_missing_index_is_listed_once_and_counted_each_time() {
        let fixture = fixture(false);
        for _ in 0..3 {
            fixture
                .policy
                .validate("(default)", &open_by_total())
                .expect("answered, as the official emulator answers it");
        }
        assert_eq!(*lock(&fixture.warned), ["(default) orders"]);
        assert_eq!(
            *lock(&fixture.changes),
            [
                MissingIndexChange::Listed,
                MissingIndexChange::Counted,
                MissingIndexChange::Counted
            ]
        );
        let [record] = fixture.missing.list().try_into().expect("one index");
        assert_eq!(record.database, "(default)");
        assert_eq!(record.queries, 3);
        assert!(!record.declared);
        assert!(record.first_seen <= record.last_seen);
        assert_eq!(
            record.query,
            QueryShape {
                target: "orders".to_owned(),
                collection_group: false,
                filters: vec![ShapeFilter {
                    field: "status".to_owned(),
                    operator: FieldOperator::Equal,
                }],
                disjunction: false,
                orders: vec![ShapeOrder {
                    field: "total".to_owned(),
                    direction: Direction::Descending,
                }],
            },
        );
        assert_eq!(fixture.missing.missing(), 1);
    }

    #[test]
    fn a_saved_file_that_declares_it_marks_it_declared_and_queries_stop_counting() {
        let fixture = fixture(true);
        fixture
            .policy
            .validate("(default)", &open_by_total())
            .expect_err("refused under --strict-indexes");
        fixture.catalogs.replace(
            "(default)",
            IndexCatalog::from_json(DECLARED).expect("catalog"),
        );
        fixture.missing.refresh(&fixture.catalogs);
        let [record] = fixture.missing.list().try_into().expect("one index");
        assert!(record.declared, "the saved file declares it");
        assert_eq!(fixture.missing.missing(), 0);
        fixture
            .policy
            .validate("(default)", &open_by_total())
            .expect("answered at once, with no restart");
        assert_eq!(fixture.missing.list()[0].queries, 1);
        assert_eq!(
            lock(&fixture.changes).last(),
            Some(&MissingIndexChange::Listed)
        );
    }

    #[test]
    fn an_index_taken_out_again_is_warned_of_again() {
        let fixture = fixture(false);
        let query = open_by_total();
        fixture
            .policy
            .validate("(default)", &query)
            .expect("answered");
        fixture.catalogs.replace(
            "(default)",
            IndexCatalog::from_json(DECLARED).expect("catalog"),
        );
        fixture.missing.refresh(&fixture.catalogs);
        fixture
            .catalogs
            .replace("(default)", IndexCatalog::default());
        fixture.missing.refresh(&fixture.catalogs);
        assert_eq!(fixture.missing.missing(), 1, "declared nowhere now");
        fixture
            .policy
            .validate("(default)", &query)
            .expect("answered");
        assert_eq!(lock(&fixture.warned).len(), 2, "news again");
        assert_eq!(fixture.missing.list()[0].queries, 2);
    }

    #[test]
    fn each_database_is_listed_on_its_own_and_the_missing_come_first() {
        let fixture = fixture(false);
        let other = Query::new(QueryScope::collection_group("lines").expect("scope"))
            .filter(equal("sku", Value::Integer(1)))
            .order_by(field("at"), Direction::Ascending);
        fixture
            .policy
            .validate("(default)", &open_by_total())
            .expect("answered");
        fixture
            .policy
            .validate("archive", &other)
            .expect("answered");
        fixture.catalogs.replace(
            "(default)",
            IndexCatalog::from_json(DECLARED).expect("catalog"),
        );
        fixture.missing.refresh(&fixture.catalogs);
        let records = fixture.missing.list();
        assert_eq!(
            records
                .iter()
                .map(|record| (record.database.as_str(), record.declared))
                .collect::<Vec<_>>(),
            [("archive", false), ("(default)", true)]
        );
        assert!(records[0].query.collection_group);
        assert_eq!(records[0].query.target, "lines");
    }

    #[test]
    fn an_or_query_is_shaped_with_every_field() {
        let query =
            Query::new(QueryScope::collection("orders").expect("scope")).filter(Filter::Or(vec![
                equal("status", Value::Integer(1)),
                Filter::And(vec![
                    equal("owner", Value::Integer(2)),
                    equal("kind", Value::Integer(3)),
                ]),
            ]));
        let shape = QueryShape::of(&query);
        assert!(shape.disjunction);
        assert_eq!(
            shape
                .filters
                .iter()
                .map(|filter| filter.field.as_str())
                .collect::<Vec<_>>(),
            ["status", "owner", "kind"]
        );
    }

    #[test]
    fn past_the_listed_bound_queries_are_counted_but_not_listed_or_warned() {
        let fixture = fixture(false);
        let ordered_by = |name: String| {
            Query::new(QueryScope::collection("scores").expect("scope"))
                .filter(equal("season", Value::Integer(1)))
                .order_by(field(&name), Direction::Ascending)
        };
        for index in 0..=MISSING_INDEXES_LISTED {
            fixture
                .policy
                .validate("(default)", &ordered_by(format!("user{index}")))
                .expect("answered");
        }
        assert_eq!(fixture.missing.list().len(), MISSING_INDEXES_LISTED);
        assert_eq!(fixture.missing.unlisted(), 1);
        assert_eq!(lock(&fixture.warned).len(), MISSING_INDEXES_LISTED);
    }
}
