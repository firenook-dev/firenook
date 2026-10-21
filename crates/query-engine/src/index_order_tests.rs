//! A query ordered by one field of a disk collection walks that field's index
//! instead of reading and sorting the collection. The walk changes which
//! documents are read, never what comes back or in which order. These tests
//! run identical writes and queries against a memory store, a disk store
//! without the index (both sort) and a disk store with it, in both editions,
//! and require identical results in identical order.

use super::*;
use firenook_core_store::{
    DiskOptions, FieldPath as StoreFieldPath, Precondition, Revision, Store, StoreOptions,
    Timestamp, Write,
};

struct TestDirectory(std::path::PathBuf);

impl TestDirectory {
    fn new() -> Self {
        static SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "firenook-index-order-{}-{}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A small deterministic generator, so a failure reproduces from its seed.
struct Lcg(u64);

impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        self.0 >> 33
    }

    fn below(&mut self, bound: usize) -> usize {
        usize::try_from(self.next()).unwrap() % bound
    }

    fn chance(&mut self, percent: usize) -> bool {
        self.below(100) < percent
    }

    fn pick<'a, T>(&mut self, values: &'a [T]) -> &'a T {
        &values[self.below(values.len())]
    }
}

const DATABASE: &str = "demo-index-order";

fn database() -> DatabaseName {
    DatabaseName::new(DATABASE, "(default)").unwrap()
}

fn text(value: &str) -> Value {
    Value::String(value.into())
}

fn reference(path: &str) -> Value {
    Value::Reference(Arc::from(format!(
        "projects/{DATABASE}/databases/(default)/documents/{path}"
    )))
}

/// Values for the ordered fields: every type, equal values of both numeric
/// types, both zeros, NaNs, the edges of the integers, strings and bytes
/// sharing their first 64 and 1,500 bytes, references with equal numeric
/// ids, and arrays, maps and vectors the index can only group.
fn mixed_values() -> Vec<Value> {
    let inline = "s".repeat(64);
    let compared = "c".repeat(1_500);
    vec![
        Value::Null,
        Value::Boolean(false),
        Value::Boolean(true),
        Value::Double(f64::NAN),
        Value::Double(f64::from_bits(0x7ff8_0000_0000_0001)),
        Value::Double(f64::NEG_INFINITY),
        Value::Integer(i64::MIN),
        Value::Double(-(2_f64.powi(63))),
        Value::Double(-1.5),
        Value::Integer(-1),
        Value::Double(-0.3),
        Value::Double(-0.0),
        Value::Integer(0),
        Value::Double(0.0),
        Value::Double(0.5),
        Value::Integer(1),
        Value::Double(1.0),
        Value::Integer(2),
        Value::Double(2.5),
        Value::Integer(3),
        Value::Integer(9_007_199_254_740_993),
        Value::Double(9_007_199_254_740_992.0),
        Value::Integer(i64::MAX),
        Value::Double(2_f64.powi(63)),
        Value::Double(f64::INFINITY),
        Value::Timestamp(Timestamp::new(-5, 0).unwrap()),
        Value::Timestamp(Timestamp::new(10, 0).unwrap()),
        Value::Timestamp(Timestamp::new(10, 5).unwrap()),
        text(""),
        text("a"),
        text("a\0"),
        text("ab"),
        text("b"),
        text(&format!("{inline}a")),
        text(&format!("{inline}b")),
        text(&inline),
        text(&format!("{compared}a")),
        text(&format!("{compared}b")),
        Value::Bytes(Arc::from(&b"a"[..])),
        Value::Bytes([vec![7_u8; 1_500], vec![1]].concat().into()),
        Value::Bytes([vec![7_u8; 1_500], vec![2]].concat().into()),
        reference("jobs/__id5__"),
        reference("jobs/__id05__"),
        reference("jobs/j-1"),
        reference(&format!("jobs/{}", "r".repeat(300))),
        Value::GeoPoint {
            latitude: -0.0,
            longitude: f64::NAN,
        },
        Value::GeoPoint {
            latitude: 0.0,
            longitude: 1.0,
        },
        Value::Array(Vec::new()),
        Value::Array(vec![Value::Integer(1)]),
        Value::Array(vec![Value::Double(1.0), text("x")]),
        Value::Array(vec![text("x")]),
        Value::Vector(Vec::new()),
        Value::Vector(vec![1.0]),
        Value::Vector(vec![0.0, 2.0]),
        Value::Map(BTreeMap::new()),
        Value::Map(BTreeMap::from([("k".to_owned(), Value::Integer(1))])),
        Value::Map(BTreeMap::from([("k".to_owned(), Value::Double(1.0))])),
        Value::Map(BTreeMap::from([("z".to_owned(), Value::Null)])),
    ]
}

const KINDS: [&str; 3] = ["run", "embed", "sync"];
const ORDERED: [&str; 3] = ["n", "s", "v"];

fn small_number(random: &mut Lcg) -> Value {
    let value = i64::try_from(random.below(6)).unwrap();
    if random.chance(50) {
        Value::Integer(value)
    } else {
        #[allow(clippy::cast_precision_loss)]
        Value::Double(value as f64 + if random.chance(30) { 0.5 } else { 0.0 })
    }
}

fn document_fields(random: &mut Lcg, mixed: &[Value]) -> Fields {
    let mut fields = Fields::new();
    if random.chance(85) {
        // Mostly a few numbers, so many documents share a value.
        let value = if random.chance(70) {
            small_number(random)
        } else {
            random.pick(mixed).clone()
        };
        fields.insert("n".to_owned(), value);
    }
    if random.chance(80) {
        let value = if random.chance(60) {
            text(&format!("{}{}", "s".repeat(64), random.below(3)))
        } else {
            random.pick(mixed).clone()
        };
        fields.insert("s".to_owned(), value);
    }
    if random.chance(70) {
        fields.insert("v".to_owned(), random.pick(mixed).clone());
    }
    if random.chance(85) {
        fields.insert("k".to_owned(), text(random.pick(&KINDS)));
    }
    if random.chance(40) {
        fields.insert(
            "tags".to_owned(),
            Value::Array(vec![text(random.pick(&KINDS))]),
        );
    }
    if random.chance(30) {
        fields.insert(
            "meta".to_owned(),
            Value::Map(BTreeMap::from([(
                "kind".to_owned(),
                text(random.pick(&KINDS)),
            )])),
        );
    }
    fields
}

fn random_id(random: &mut Lcg) -> String {
    match random.below(4) {
        0 => format!("__id{}__", i64::try_from(random.below(12)).unwrap() - 3),
        _ => format!("j-{}", random.below(30)),
    }
}

fn random_path(random: &mut Lcg) -> String {
    match random.below(12) {
        0 => format!("jobs/j-{}/events/e-{}", random.below(3), random.below(4)),
        1 => format!("other/j-{}", random.below(5)),
        _ => format!("jobs/{}", random_id(random)),
    }
}

fn random_writes(random: &mut Lcg, mixed: &[Value]) -> Vec<Write> {
    let mut seen = BTreeSet::new();
    let mut writes = Vec::new();
    for _ in 0..random.below(6).saturating_add(1) {
        let path = random_path(random);
        if !seen.insert(path.clone()) {
            continue;
        }
        let key = DocumentKey::new(database(), path).unwrap();
        writes.push(match random.below(10) {
            0 => Write::Delete {
                key,
                precondition: Precondition::None,
            },
            1 | 2 => {
                let fields = document_fields(random, mixed);
                let mask = ["n", "s", "v", "k", "tags"]
                    .iter()
                    .filter(|_| random.chance(50))
                    .map(|field| StoreFieldPath::new(vec![(*field).to_owned()]).unwrap())
                    .collect::<Vec<_>>();
                Write::Patch {
                    key,
                    fields,
                    update_mask: mask,
                    transforms: Vec::new(),
                    precondition: Precondition::None,
                }
            }
            _ => Write::Set {
                key,
                fields: document_fields(random, mixed),
                transforms: Vec::new(),
                precondition: Precondition::None,
            },
        });
    }
    writes
}

fn path(name: &str) -> FieldPath {
    FieldPath::field([name]).unwrap()
}

fn field_filter(path: FieldPath, operator: FieldOperator, value: Value) -> Filter {
    Filter::Field(FieldFilter {
        path,
        operator,
        value,
    })
}

/// An operand for a filter or cursor on `field`: usually one of the values
/// documents hold, so bounds land inside groups and on shared values.
fn operand(random: &mut Lcg, mixed: &[Value], field: &str) -> Value {
    if random.chance(40) {
        return random.pick(mixed).clone();
    }
    match field {
        "k" => text(random.pick(&KINDS)),
        "s" => text(&format!("{}{}", "s".repeat(64), random.below(3))),
        _ => small_number(random),
    }
}

/// A filter on the ordered field, the kind that bounds the walk.
fn order_filter(random: &mut Lcg, mixed: &[Value], field: &str) -> Filter {
    let operator = *random.pick(&[
        FieldOperator::LessThan,
        FieldOperator::LessThanOrEqual,
        FieldOperator::GreaterThan,
        FieldOperator::GreaterThanOrEqual,
        FieldOperator::Equal,
        FieldOperator::In,
        FieldOperator::NotEqual,
        FieldOperator::NotIn,
    ]);
    let value = match operator {
        FieldOperator::In | FieldOperator::NotIn => Value::Array(
            (0..random.below(4))
                .map(|_| operand(random, mixed, field))
                .collect(),
        ),
        _ => operand(random, mixed, field),
    };
    field_filter(path(field), operator, value)
}

/// A filter on another field: an equality the walk checks in the index, or
/// one only the engine can evaluate.
fn other_filter(random: &mut Lcg, mixed: &[Value]) -> Filter {
    match random.below(8) {
        0..=2 => field_filter(path("k"), FieldOperator::Equal, operand(random, mixed, "k")),
        3 => field_filter(
            path("k"),
            FieldOperator::In,
            Value::Array(
                (0..random.below(3))
                    .map(|_| operand(random, mixed, "k"))
                    .collect(),
            ),
        ),
        4 => field_filter(
            path("tags"),
            FieldOperator::ArrayContains,
            text(random.pick(&KINDS)),
        ),
        5 => field_filter(
            FieldPath::field(["meta", "kind"]).unwrap(),
            FieldOperator::Equal,
            text(random.pick(&KINDS)),
        ),
        6 => {
            let other = *random.pick(&ORDERED);
            field_filter(
                path(other),
                FieldOperator::Equal,
                operand(random, mixed, other),
            )
        }
        _ => Filter::Or(vec![
            field_filter(path("k"), FieldOperator::Equal, text(random.pick(&KINDS))),
            field_filter(path("n"), FieldOperator::Equal, small_number(random)),
        ]),
    }
}

fn cursor(random: &mut Lcg, mixed: &[Value], field: &str) -> Cursor {
    let mut values = vec![operand(random, mixed, field)];
    if random.chance(60) {
        values.push(match random.below(5) {
            0 => reference(&format!("other/{}", random_id(random))),
            1 => reference(&format!("jobs/j-1/events/e-{}", random.below(4))),
            _ => reference(&format!("jobs/{}", random_id(random))),
        });
    }
    Cursor {
        values,
        inclusive: random.chance(50),
    }
}

fn random_query(random: &mut Lcg, mixed: &[Value]) -> Query {
    let collection = match random.below(12) {
        0 => "jobs/j-1/events",
        1 => "other",
        _ => "jobs",
    };
    let field = *random.pick(&ORDERED);
    let direction = if random.chance(50) {
        Direction::Ascending
    } else {
        Direction::Descending
    };
    let mut query = Query::new(QueryScope::collection(collection).unwrap());
    let mut filters = Vec::new();
    if random.chance(50) {
        filters.push(order_filter(random, mixed, field));
    }
    if random.chance(15) {
        filters.push(order_filter(random, mixed, field));
    }
    if random.chance(40) {
        filters.push(other_filter(random, mixed));
    }
    if random.chance(10) {
        filters.push(other_filter(random, mixed));
    }
    let explicit = filters.is_empty() || random.chance(70);
    match filters.len() {
        0 => {}
        1 if random.chance(50) => query = query.filter(filters.pop().unwrap()),
        _ => query = query.filter(Filter::And(filters)),
    }
    if explicit {
        query = query.order_by(path(field), direction);
        if random.chance(10) {
            // `__name__` spelled out, sometimes the other way.
            let name = if random.chance(50) {
                direction
            } else {
                match direction {
                    Direction::Ascending => Direction::Descending,
                    Direction::Descending => Direction::Ascending,
                }
            };
            query = query.order_by(FieldPath::DocumentId, name);
        }
    }
    if random.chance(30) {
        query.start = Some(cursor(random, mixed, field));
    }
    if random.chance(20) {
        query.end = Some(cursor(random, mixed, field));
    }
    match random.below(10) {
        0..=5 => query = query.limit(Limit::First(random.below(6).saturating_add(1))),
        6 => query = query.limit(Limit::First(0)),
        7 => query = query.limit(Limit::Last(random.below(3).saturating_add(1))),
        _ => {}
    }
    if random.chance(15) {
        query = query.offset(random.below(3).saturating_add(1));
    }
    if random.chance(10) {
        query = query.select(vec![path("k")]);
    }
    query
}

/// Results as the client sees them: names, fields and projections, in order,
/// and the count. Commit times are left out: each store stamps its own.
fn outcome(
    snapshot: &Snapshot,
    query: &Query,
    edition: DatabaseEdition,
) -> Result<(Vec<String>, u64), String> {
    let database = database();
    let documents = execute(snapshot, &database, query, edition)
        .map_err(|error| error.to_string())?
        .into_iter()
        .map(|document| {
            format!(
                "{}|{:?}|{:?}",
                document.key().path(),
                document.document().fields(),
                document.projected_fields()
            )
        })
        .collect();
    let counted = count(snapshot, &database, query, edition).map_err(|error| error.to_string())?;
    Ok((documents, counted))
}

fn walks(snapshot: &Snapshot, query: &Query) -> bool {
    execute_iter(snapshot, &database(), query, DatabaseEdition::Standard)
        .is_ok_and(|iterator| iterator.strategy() == QueryStrategy::IndexOrder)
}

#[test]
fn walked_queries_return_exactly_what_sorting_returns() {
    let mixed = mixed_values();
    let mut compared = 0_usize;
    let mut walked = 0_usize;
    let mut nonempty = 0_usize;
    for seed in 0..12_u64 {
        let indexed_directory = TestDirectory::new();
        let sorted_directory = TestDirectory::new();
        let with_index = Store::open_disk(&indexed_directory.0, DiskOptions::default()).unwrap();
        let without_index = Store::open_disk(
            &sorted_directory.0,
            DiskOptions {
                field_indexes: false,
                ..DiskOptions::default()
            },
        )
        .unwrap();
        let memory = Store::new(StoreOptions::default());
        let stores = [&memory, &without_index, &with_index];
        let mut random = Lcg(seed.wrapping_mul(7_919).wrapping_add(5));
        let mut revisions: Vec<Revision> = Vec::new();
        for step in 0..60 {
            let writes = random_writes(&mut random, &mixed);
            let committed = stores
                .iter()
                .map(|store| store.commit(&writes).map(|result| result.revision))
                .collect::<Vec<_>>();
            assert!(
                committed
                    .windows(2)
                    .all(|pair| pair[0].is_ok() == pair[1].is_ok()),
                "seed {seed} step {step}: commits disagree: {committed:?}"
            );
            if let Ok(revision) = committed[0] {
                revisions.push(revision);
            }
            let past = (revisions.len() > 3 && random.chance(10))
                .then(|| revisions[revisions.len() - 1 - random.below(3)]);
            for _ in 0..8 {
                let query = random_query(&mut random, &mixed);
                let snapshots = stores
                    .iter()
                    .map(|store| match past {
                        Some(revision) => store.snapshot_at(revision).unwrap(),
                        None => store.snapshot(),
                    })
                    .collect::<Vec<_>>();
                if walks(&snapshots[2], &query) {
                    walked += 1;
                }
                for edition in [DatabaseEdition::Standard, DatabaseEdition::Enterprise] {
                    let expected = outcome(&snapshots[0], &query, edition);
                    if expected
                        .as_ref()
                        .is_ok_and(|(documents, _)| !documents.is_empty())
                    {
                        nonempty += 1;
                    }
                    for (store, snapshot) in ["disk without index", "disk with index"]
                        .iter()
                        .zip(&snapshots[1..])
                    {
                        assert_eq!(
                            outcome(snapshot, &query, edition),
                            expected,
                            "seed {seed} step {step} {store} {edition:?} at {past:?}: {query:?}"
                        );
                    }
                    compared += 1;
                }
            }
        }
    }
    // The comparison is only meaningful if most queries walked the index and
    // many of them returned something.
    assert!(compared > 10_000, "{compared} comparisons");
    assert!(
        walked * 2 > compared / 2,
        "{walked} of {} queries walked the index",
        compared / 2
    );
    assert!(
        nonempty * 3 > compared,
        "{nonempty} of {compared} non-empty"
    );
}

#[test]
fn every_cursor_on_every_value_returns_what_sorting_returns() {
    // Exhaustive over the tricky values: one document per value and id
    // shape, then every cursor and range on every value in both directions.
    // The random test rarely draws a given pair; this one draws all of them.
    let mixed = mixed_values();
    let directory = TestDirectory::new();
    let disk = Store::open_disk(&directory.0, DiskOptions::default()).unwrap();
    let memory = Store::new(StoreOptions::default());
    let mut writes = Vec::new();
    for (index, value) in mixed.iter().enumerate() {
        for id in [format!("v-{index}"), format!("__id{index}__")] {
            writes.push(Write::Set {
                key: DocumentKey::new(database(), format!("values/{id}")).unwrap(),
                fields: Fields::from([("x".to_owned(), value.clone())]),
                transforms: Vec::new(),
                precondition: Precondition::None,
            });
        }
    }
    memory.commit(&writes).unwrap();
    disk.commit(&writes).unwrap();
    let (memory, disk) = (memory.snapshot(), disk.snapshot());
    let mut walked = 0_usize;
    let base = || Query::new(QueryScope::collection("values").unwrap());
    for (index, operand) in mixed.iter().enumerate() {
        let named = reference(&format!("values/v-{index}"));
        let mut queries = Vec::new();
        for direction in [Direction::Ascending, Direction::Descending] {
            let ordered = || base().order_by(path("x"), direction);
            for inclusive in [true, false] {
                for values in [vec![operand.clone()], vec![operand.clone(), named.clone()]] {
                    let cursor = Cursor { values, inclusive };
                    let mut start = ordered().limit(Limit::First(4));
                    start.start = Some(cursor.clone());
                    let mut end = ordered();
                    end.end = Some(cursor);
                    queries.extend([start, end]);
                }
            }
            for operator in [
                FieldOperator::LessThan,
                FieldOperator::LessThanOrEqual,
                FieldOperator::GreaterThan,
                FieldOperator::GreaterThanOrEqual,
                FieldOperator::Equal,
            ] {
                queries.push(
                    ordered()
                        .filter(field_filter(path("x"), operator, operand.clone()))
                        .limit(Limit::First(3)),
                );
            }
        }
        for query in queries {
            if walks(&disk, &query) {
                walked += 1;
            }
            for edition in [DatabaseEdition::Standard, DatabaseEdition::Enterprise] {
                assert_eq!(
                    outcome(&disk, &query, edition),
                    outcome(&memory, &query, edition),
                    "{edition:?}: {query:?}"
                );
            }
        }
    }
    assert!(walked > 1_000, "{walked} walked");
}

#[test]
fn a_tied_run_larger_than_the_page_is_sorted_before_the_limit() {
    // Every document holds a long string sharing its first 64 bytes: one
    // group the walk cannot order. Pages through it must still be the
    // sorted order, whichever way and from wherever they start.
    let directory = TestDirectory::new();
    let disk = Store::open_disk(&directory.0, DiskOptions::default()).unwrap();
    let memory = Store::new(StoreOptions::default());
    let prefix = "p".repeat(64);
    let writes = (0..60)
        .map(|index| Write::Set {
            key: DocumentKey::new(database(), format!("long/d-{}", (index * 37) % 60)).unwrap(),
            fields: Fields::from([
                (
                    "t".to_owned(),
                    text(&format!("{prefix}{:03}", (index * 7) % 23)),
                ),
                ("k".to_owned(), text(KINDS[index % 3])),
            ]),
            transforms: Vec::new(),
            precondition: Precondition::None,
        })
        .collect::<Vec<_>>();
    memory.commit(&writes).unwrap();
    disk.commit(&writes).unwrap();
    let (memory, disk) = (memory.snapshot(), disk.snapshot());
    for direction in [Direction::Ascending, Direction::Descending] {
        for limit in [1, 5, 59, 60, 61] {
            for offset in [0, 3] {
                let mut query = Query::new(QueryScope::collection("long").unwrap())
                    .order_by(path("t"), direction)
                    .limit(Limit::First(limit))
                    .offset(offset);
                assert!(walks(&disk, &query));
                assert_eq!(
                    outcome(&disk, &query, DatabaseEdition::Standard),
                    outcome(&memory, &query, DatabaseEdition::Standard),
                    "{query:?}"
                );
                query = query.filter(field_filter(path("k"), FieldOperator::Equal, text("run")));
                query.start = Some(Cursor {
                    values: vec![text(&format!("{prefix}010")), reference("long/d-5")],
                    inclusive: false,
                });
                assert!(walks(&disk, &query));
                assert_eq!(
                    outcome(&disk, &query, DatabaseEdition::Standard),
                    outcome(&memory, &query, DatabaseEdition::Standard),
                    "{query:?}"
                );
            }
        }
    }
}

#[test]
fn a_walk_stops_reading_once_the_limit_is_met() {
    let directory = TestDirectory::new();
    let disk = Store::open_disk(&directory.0, DiskOptions::default()).unwrap();
    let writes = (0..500_i64)
        .map(|index| Write::Set {
            key: DocumentKey::new(database(), format!("big/d-{index}")).unwrap(),
            fields: Fields::from([("rank".to_owned(), Value::Integer(index % 50))]),
            transforms: Vec::new(),
            precondition: Precondition::None,
        })
        .collect::<Vec<_>>();
    disk.commit(&writes).unwrap();
    let query = Query::new(QueryScope::collection("big").unwrap())
        .order_by(path("rank"), Direction::Descending)
        .limit(Limit::First(3));
    let mut iterator = execute_iter(
        &disk.snapshot(),
        &database(),
        &query,
        DatabaseEdition::Standard,
    )
    .unwrap();
    let QueryDocumentIteratorInner::IndexOrder(walk) = &mut iterator.inner else {
        panic!("a first page ordered by one field walks its index");
    };
    let mut read = 0_usize;
    while walk.next_lazy().is_some() {
        read += 1;
    }
    assert_eq!(read, 3);
    assert_eq!(
        walk.walk.by_ref().count(),
        497,
        "the page was answered before the rest of the collection was read"
    );
}
