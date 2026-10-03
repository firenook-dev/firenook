//! The disk store's field index changes which documents a query reads, never
//! what it returns. These tests run identical writes and queries against a
//! memory store and a disk store without the index (both scan) and a disk
//! store with it, and require identical results.

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
            "firenook-field-index-queries-{}-{}-{}",
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

fn text(value: &str) -> Value {
    Value::String(value.into())
}

fn reference(id: &str) -> Value {
    Value::Reference(Arc::from(format!(
        "projects/demo-field-index/databases/(default)/documents/jobs/{id}"
    )))
}

/// Values that stress the index's equality rules: integers and doubles that
/// are equal, both zeros, NaNs with different bits, strings and bytes equal
/// in their first 1,500 bytes, references with equal numeric ids, and the
/// types the index does not hold.
fn mixed_values() -> Vec<Value> {
    let long = "p".repeat(1_500);
    vec![
        Value::Null,
        Value::Boolean(false),
        Value::Boolean(true),
        Value::Integer(0),
        Value::Integer(1),
        Value::Integer(-1),
        Value::Integer(i64::MIN),
        Value::Integer(9_007_199_254_740_993),
        Value::Double(0.0),
        Value::Double(-0.0),
        Value::Double(1.0),
        Value::Double(1.5),
        Value::Double(f64::NAN),
        Value::Double(f64::from_bits(0x7ff8_0000_0000_0001)),
        Value::Double(f64::INFINITY),
        Value::Double(-(2_f64.powi(63))),
        Value::Double(9_007_199_254_740_992.0),
        Value::Timestamp(Timestamp::new(10, 0).unwrap()),
        Value::Timestamp(Timestamp::new(10, 5).unwrap()),
        text(""),
        text("queued"),
        text("1"),
        text(&(long.clone() + "a")),
        text(&(long.clone() + "b")),
        Value::Bytes(Arc::from(&b"queued"[..])),
        Value::Bytes([vec![7_u8; 1_500], vec![1]].concat().into()),
        Value::Bytes([vec![7_u8; 1_500], vec![2]].concat().into()),
        reference("__id5__"),
        reference("__id05__"),
        reference("j-1"),
        Value::GeoPoint {
            latitude: -0.0,
            longitude: f64::NAN,
        },
        Value::GeoPoint {
            latitude: 0.0,
            longitude: 1.0,
        },
        Value::Array(vec![]),
        Value::Array(vec![text("queued")]),
        Value::Map(BTreeMap::from([("k".to_owned(), Value::Integer(1))])),
        Value::Vector(vec![1.0]),
    ]
}

const STATUSES: [&str; 4] = ["queued", "running", "completed", "failed"];
const OWNERS: [&str; 3] = ["owner-a", "owner-b", "owner-c"];
const KINDS: [&str; 2] = ["run", "embed"];

fn document_fields(random: &mut Lcg, mixed: &[Value]) -> Fields {
    let mut fields = Fields::new();
    if random.chance(90) {
        let status = if random.chance(85) {
            text(random.pick(&STATUSES))
        } else {
            random.pick(mixed).clone()
        };
        fields.insert("status".to_owned(), status);
    }
    if random.chance(85) {
        fields.insert("owner".to_owned(), text(random.pick(&OWNERS)));
    }
    if random.chance(80) {
        fields.insert("kind".to_owned(), text(random.pick(&KINDS)));
    }
    if random.chance(70) {
        let value = if random.chance(50) {
            Value::Integer(i64::try_from(random.below(5)).unwrap())
        } else {
            random.pick(mixed).clone()
        };
        fields.insert("n".to_owned(), value);
    }
    if random.chance(70) {
        fields.insert("v".to_owned(), random.pick(mixed).clone());
    }
    if random.chance(30) {
        // A literal dotted top-level name and a nested map.
        fields.insert("a.b".to_owned(), text(random.pick(&STATUSES)));
    }
    if random.chance(30) {
        fields.insert(
            "meta".to_owned(),
            Value::Map(BTreeMap::from([(
                "status".to_owned(),
                text(random.pick(&STATUSES)),
            )])),
        );
    }
    fields
}

fn random_path(random: &mut Lcg) -> String {
    match random.below(10) {
        0 => format!("jobs/j-{}/events/e-{}", random.below(3), random.below(4)),
        1 => format!("other/j-{}", random.below(5)),
        2 | 3 => format!("jobs/__id{}__", random.below(12)),
        _ => format!("jobs/j-{}", random.below(25)),
    }
}

fn random_writes(random: &mut Lcg, database: &DatabaseName, mixed: &[Value]) -> Vec<Write> {
    let mut seen = BTreeSet::new();
    let mut writes = Vec::new();
    for _ in 0..random.below(5).saturating_add(1) {
        let path = random_path(random);
        if !seen.insert(path.clone()) {
            continue;
        }
        let key = DocumentKey::new(database.clone(), path).unwrap();
        writes.push(match random.below(10) {
            0 | 1 => Write::Delete {
                key,
                precondition: Precondition::None,
            },
            2 | 3 => {
                let fields = document_fields(random, mixed);
                let mask = ["status", "owner", "n", "v", "kind"]
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

fn operand(random: &mut Lcg, mixed: &[Value], field: &str) -> Value {
    if random.chance(30) {
        return random.pick(mixed).clone();
    }
    match field {
        "status" | "a.b" => text(random.pick(&STATUSES)),
        "owner" => text(random.pick(&OWNERS)),
        "kind" => text(random.pick(&KINDS)),
        _ => {
            if random.chance(50) {
                Value::Integer(i64::try_from(random.below(5)).unwrap())
            } else {
                Value::Double(f64::from(u32::try_from(random.below(5)).unwrap()))
            }
        }
    }
}

fn conjunct(random: &mut Lcg, mixed: &[Value]) -> Filter {
    let field = *random.pick(&["status", "owner", "kind", "n", "v", "a.b"]);
    match random.below(10) {
        0..=4 => field_filter(
            path(field),
            FieldOperator::Equal,
            operand(random, mixed, field),
        ),
        5..=7 => {
            let values = (0..random.below(5))
                .map(|_| operand(random, mixed, field))
                .collect::<Vec<_>>();
            field_filter(path(field), FieldOperator::In, Value::Array(values))
        }
        8 => field_filter(
            FieldPath::field(["meta", "status"]).unwrap(),
            FieldOperator::Equal,
            text(random.pick(&STATUSES)),
        ),
        _ => {
            let operator = *random.pick(&[
                FieldOperator::NotEqual,
                FieldOperator::GreaterThan,
                FieldOperator::LessThanOrEqual,
                FieldOperator::ArrayContains,
                FieldOperator::NotIn,
            ]);
            let value = if operator == FieldOperator::NotIn {
                Value::Array(vec![operand(random, mixed, field)])
            } else {
                operand(random, mixed, field)
            };
            field_filter(path(field), operator, value)
        }
    }
}

fn random_query(random: &mut Lcg, mixed: &[Value]) -> Query {
    let collection = match random.below(10) {
        0 => "jobs/j-1/events",
        1 => "other",
        _ => "jobs",
    };
    let mut filters = (0..random.below(3).saturating_add(1))
        .map(|_| conjunct(random, mixed))
        .collect::<Vec<_>>();
    if random.chance(15) {
        let either = Filter::Or(vec![conjunct(random, mixed), conjunct(random, mixed)]);
        filters.push(either);
    }
    let filter = if filters.len() == 1 && random.chance(50) {
        filters.pop().unwrap()
    } else if random.chance(20) {
        // Nested conjunctions flatten into the same lookups.
        let last = filters.pop().unwrap();
        Filter::And(vec![Filter::And(filters), last])
    } else {
        Filter::And(filters)
    };
    let mut query = Query::new(QueryScope::collection(collection).unwrap()).filter(filter);
    match random.below(4) {
        0 => query = query.order_by(path("n"), Direction::Ascending),
        1 => query = query.order_by(FieldPath::DocumentId, Direction::Descending),
        _ => {}
    }
    match random.below(5) {
        0 => query = query.limit(Limit::First(random.below(4).saturating_add(1))),
        1 => query = query.limit(Limit::Last(random.below(3).saturating_add(1))),
        _ => {}
    }
    if random.chance(10) {
        query = query.offset(1);
    }
    if random.chance(10) {
        query = query.select(vec![path("status")]);
    }
    query
}

/// The queue head a job worker listens to, and its claim query.
fn queue_queries(owner: &str, kind: &str) -> [Query; 2] {
    let scoped = |status: Filter| {
        Filter::And(vec![
            field_filter(path("owner"), FieldOperator::Equal, text(owner)),
            field_filter(path("kind"), FieldOperator::Equal, text(kind)),
            status,
        ])
    };
    let active = field_filter(
        path("status"),
        FieldOperator::In,
        Value::Array(vec![text("queued"), text("running")]),
    );
    [
        Query::new(QueryScope::collection("jobs").unwrap())
            .filter(scoped(active.clone()))
            .order_by(path("n"), Direction::Ascending)
            .limit(Limit::First(1)),
        Query::new(QueryScope::collection("jobs").unwrap())
            .filter(Filter::And(vec![
                scoped(active),
                field_filter(path("n"), FieldOperator::LessThanOrEqual, Value::Integer(3)),
            ]))
            .order_by(path("n"), Direction::Ascending)
            .limit(Limit::First(25)),
    ]
}

/// Results as the client sees them: names, fields and projections, in order.
/// Commit times are left out: each store stamps its own.
fn outcome(
    snapshot: &Snapshot,
    database: &DatabaseName,
    query: &Query,
    edition: DatabaseEdition,
) -> Result<(Vec<String>, u64), String> {
    let documents = execute(snapshot, database, query, edition)
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
    let counted = count(snapshot, database, query, edition).map_err(|error| error.to_string())?;
    Ok((documents, counted))
}

#[test]
fn indexed_queries_return_exactly_what_scans_return() {
    let database = DatabaseName::new("demo-field-index", "(default)").unwrap();
    let mixed = mixed_values();
    let mut compared = 0_usize;
    let mut indexed = 0_usize;
    for seed in 0..10_u64 {
        let indexed_directory = TestDirectory::new();
        let scanned_directory = TestDirectory::new();
        let with_index = Store::open_disk(&indexed_directory.0, DiskOptions::default()).unwrap();
        let without_index = Store::open_disk(
            &scanned_directory.0,
            DiskOptions {
                field_indexes: false,
                ..DiskOptions::default()
            },
        )
        .unwrap();
        let memory = Store::new(StoreOptions::default());
        let stores = [&memory, &without_index, &with_index];
        let mut random = Lcg(seed.wrapping_mul(7_919).wrapping_add(3));
        let mut revisions: Vec<Revision> = Vec::new();
        for step in 0..70 {
            let writes = random_writes(&mut random, &database, &mixed);
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

            let mut queries = (0..6)
                .map(|_| random_query(&mut random, &mixed))
                .collect::<Vec<_>>();
            queries.extend(queue_queries(random.pick(&OWNERS), random.pick(&KINDS)));
            let past = (revisions.len() > 3 && random.chance(40))
                .then(|| revisions[revisions.len() - 1 - random.below(3)]);
            for query in &queries {
                let snapshots = stores
                    .iter()
                    .map(|store| match past {
                        Some(revision) => store.snapshot_at(revision).unwrap(),
                        None => store.snapshot(),
                    })
                    .collect::<Vec<_>>();
                if let QueryScope::Collection(collection) = query.scope_ref() {
                    let lookups = equality_lookups(query);
                    let equalities = lookups
                        .iter()
                        .map(|(field, values)| FieldEquality { field, values })
                        .collect::<Vec<_>>();
                    if snapshots[2]
                        .iter_collection_equal(&database, collection, &equalities)
                        .is_some()
                    {
                        indexed += 1;
                    }
                }
                for edition in [DatabaseEdition::Standard, DatabaseEdition::Enterprise] {
                    let expected = outcome(&snapshots[0], &database, query, edition);
                    for (store, snapshot) in ["disk without index", "disk with index"]
                        .iter()
                        .zip(&snapshots[1..])
                    {
                        assert_eq!(
                            outcome(snapshot, &database, query, edition),
                            expected,
                            "seed {seed} step {step} {store} {edition:?} at {past:?}: {query:?}"
                        );
                    }
                    compared += 1;
                }
            }
        }
    }
    // The comparison is only meaningful if the index answered most queries.
    assert!(compared > 10_000, "{compared} comparisons");
    assert!(
        indexed * 2 > compared / 2,
        "{indexed} of {} queries used the index",
        compared / 2
    );
}

#[test]
fn a_restarted_store_answers_from_a_rebuilt_index() {
    let database = DatabaseName::new("demo-field-index", "(default)").unwrap();
    let mixed = mixed_values();
    let directory = TestDirectory::new();
    let memory = Store::new(StoreOptions::default());
    let mut random = Lcg(99);
    for round in 0..4 {
        // Alternate releases: the index off writes without maintaining it,
        // the next open with it on must rebuild before answering.
        let disk = Store::open_disk(
            &directory.0,
            DiskOptions {
                field_indexes: round % 2 == 1,
                ..DiskOptions::default()
            },
        )
        .unwrap();
        for _ in 0..25 {
            let writes = random_writes(&mut random, &database, &mixed);
            assert_eq!(memory.commit(&writes).is_ok(), disk.commit(&writes).is_ok());
        }
        drop(disk);
        let reopened = Store::open_disk(&directory.0, DiskOptions::default()).unwrap();
        for _ in 0..60 {
            let query = random_query(&mut random, &mixed);
            assert_eq!(
                outcome(
                    &reopened.snapshot(),
                    &database,
                    &query,
                    DatabaseEdition::Standard
                ),
                outcome(
                    &memory.snapshot(),
                    &database,
                    &query,
                    DatabaseEdition::Standard
                ),
                "round {round}: {query:?}"
            );
        }
    }
}

#[test]
fn every_value_finds_every_value_it_equals() {
    // Exhaustive over the tricky values: one document per value, then `==`
    // and `in` with every value as the operand. The random test rarely draws
    // a given pair; this one draws all of them.
    let database = DatabaseName::new("demo-field-index", "(default)").unwrap();
    let mixed = mixed_values();
    let directory = TestDirectory::new();
    let disk = Store::open_disk(&directory.0, DiskOptions::default()).unwrap();
    let memory = Store::new(StoreOptions::default());
    let writes = mixed
        .iter()
        .enumerate()
        .map(|(index, value)| Write::Set {
            key: DocumentKey::new(database.clone(), format!("values/v-{index}")).unwrap(),
            fields: Fields::from([("x".to_owned(), value.clone())]),
            transforms: Vec::new(),
            precondition: Precondition::None,
        })
        .collect::<Vec<_>>();
    memory.commit(&writes).unwrap();
    disk.commit(&writes).unwrap();
    let (memory, disk) = (memory.snapshot(), disk.snapshot());
    for operand in &mixed {
        for filter in [
            field_filter(path("x"), FieldOperator::Equal, operand.clone()),
            field_filter(
                path("x"),
                FieldOperator::In,
                Value::Array(vec![operand.clone(), text("absent")]),
            ),
        ] {
            let query = Query::new(QueryScope::collection("values").unwrap()).filter(filter);
            for edition in [DatabaseEdition::Standard, DatabaseEdition::Enterprise] {
                assert_eq!(
                    outcome(&disk, &database, &query, edition),
                    outcome(&memory, &database, &query, edition),
                    "{edition:?}: {query:?}"
                );
            }
        }
    }
}
