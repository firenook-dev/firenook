use std::collections::BTreeMap;
use std::sync::Arc;

use redb::{ReadableDatabase, ReadableTable};

use super::super::{
    DiskOptions, DiskStore, FIELD_INDEX, FIELD_INDEX_REVISION_KEY, METADATA, WalRecord,
    rebuild_field_index,
};
use super::value_key;
use crate::{
    DatabaseName, DocumentKey, FieldEquality, FieldPath, Fields, Precondition, Timestamp, Value,
    Write, compare_resource_paths,
};

struct TestDirectory(std::path::PathBuf);

impl TestDirectory {
    fn new() -> Self {
        static SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "firenook-field-index-{}-{}-{}",
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

fn database() -> DatabaseName {
    DatabaseName::new("demo-field-index", "(default)").unwrap()
}

fn key(path: &str) -> DocumentKey {
    DocumentKey::new(database(), path).unwrap()
}

fn set(path: &str, fields: Fields) -> Write {
    Write::Set {
        key: key(path),
        fields,
        transforms: Vec::new(),
        precondition: Precondition::None,
    }
}

fn delete(path: &str) -> Write {
    Write::Delete {
        key: key(path),
        precondition: Precondition::None,
    }
}

fn patch(path: &str, fields: Fields, mask: &[&str]) -> Write {
    Write::Patch {
        key: key(path),
        fields,
        update_mask: mask
            .iter()
            .map(|field| FieldPath::new(vec![(*field).to_owned()]).unwrap())
            .collect(),
        transforms: Vec::new(),
        precondition: Precondition::None,
    }
}

fn fields<const N: usize>(entries: [(&str, Value); N]) -> Fields {
    entries
        .into_iter()
        .map(|(name, value)| (name.to_owned(), value))
        .collect()
}

fn text(value: &str) -> Value {
    Value::String(value.into())
}

fn options(field_indexes: bool) -> DiskOptions {
    DiskOptions {
        field_indexes,
        ..DiskOptions::default()
    }
}

/// Every entry of the field index with its prefix id resolved to the
/// `[database][collection path][field]` it names, sorted. Ids depend on the
/// order fields were first indexed, so a rebuild may number them differently.
fn index_entries(store: &DiskStore) -> Vec<(Vec<u8>, Vec<u8>)> {
    let state = store.state();
    let transaction = state.database.begin_read().unwrap();
    let prefixes = transaction
        .open_table(super::super::FIELD_PREFIXES)
        .unwrap()
        .iter()
        .unwrap()
        .map(|entry| {
            let (prefix, id) = entry.unwrap();
            (id.value(), prefix.value().to_vec())
        })
        .filter(|(_, prefix)| !prefix.is_empty())
        .collect::<BTreeMap<_, _>>();
    let table = transaction.open_table(FIELD_INDEX).unwrap();
    let mut entries = table
        .iter()
        .unwrap()
        .map(|entry| {
            let (key, value) = entry.unwrap();
            let key = key.value();
            let id = u32::from_be_bytes(key[..4].try_into().unwrap());
            let mut resolved = prefixes[&id].clone();
            resolved.extend_from_slice(&key[4..]);
            (resolved, value.value().to_vec())
        })
        .collect::<Vec<_>>();
    entries.sort();
    entries
}

/// The paths the index offers for `field == one of values` in `collection`.
fn candidates(
    snapshot: &crate::Snapshot,
    collection: &str,
    lookups: &[(&str, &[Value])],
) -> Vec<String> {
    let equalities = lookups
        .iter()
        .map(|(field, values)| FieldEquality { field, values })
        .collect::<Vec<_>>();
    snapshot
        .iter_collection_equal(&database(), collection, &equalities)
        .expect("the disk snapshot reads the field index")
        .map(|(key, _)| key.path().to_owned())
        .collect()
}

#[test]
fn values_the_query_engine_compares_as_equal_share_one_key() {
    let long = "x".repeat(1_500);
    let reference = |id: &str| -> Value {
        Value::Reference(Arc::from(format!(
            "projects/p/databases/(default)/documents/items/{id}"
        )))
    };
    let equal = [
        (Value::Integer(1), Value::Double(1.0)),
        (Value::Integer(0), Value::Double(-0.0)),
        (Value::Double(0.0), Value::Double(-0.0)),
        (Value::Integer(i64::MIN), Value::Double(-(2_f64.powi(63)))),
        (
            Value::Double(f64::NAN),
            Value::Double(f64::from_bits(0x7ff8_0000_0000_0001)),
        ),
        (text(&(long.clone() + "a")), text(&(long.clone() + "b"))),
        (
            Value::Bytes([vec![1_u8; 1_500], vec![1]].concat().into()),
            Value::Bytes([vec![1_u8; 1_500], vec![2, 3]].concat().into()),
        ),
        (reference("__id5__"), reference("__id05__")),
        (reference("__id0__"), reference("__id-0__")),
        (
            Value::GeoPoint {
                latitude: -0.0,
                longitude: f64::NAN,
            },
            Value::GeoPoint {
                latitude: 0.0,
                longitude: f64::from_bits(0x7ff8_0000_0000_0002),
            },
        ),
        (
            Value::Timestamp(Timestamp::new(12, 34).unwrap()),
            Value::Timestamp(Timestamp::new(12, 34).unwrap()),
        ),
    ];
    for (left, right) in equal {
        assert_eq!(
            value_key(&left),
            value_key(&right),
            "{left:?} and {right:?} compare as equal"
        );
        assert!(value_key(&left).is_some());
    }

    let distinct = [
        (Value::Integer(1), Value::Double(1.5)),
        (
            Value::Integer(9_007_199_254_740_993),
            Value::Double(9_007_199_254_740_992.0),
        ),
        (text("a"), Value::Bytes(Arc::from(&b"a"[..]))),
        (Value::Boolean(true), Value::Integer(1)),
        (Value::Null, Value::Boolean(false)),
        (text(&"y".repeat(1_499)), text(&("y".repeat(1_499) + "z"))),
        (reference("a"), reference("a/b")),
        (
            Value::Double(f64::INFINITY),
            Value::Double(f64::NEG_INFINITY),
        ),
    ];
    for (left, right) in distinct {
        assert_ne!(
            value_key(&left),
            value_key(&right),
            "{left:?} and {right:?} differ"
        );
    }

    for unindexed in [
        Value::Array(vec![Value::Integer(1)]),
        Value::Map(BTreeMap::new()),
        Value::Vector(vec![1.0]),
    ] {
        assert_eq!(value_key(&unindexed), None);
    }
}

#[test]
fn value_keys_are_prefix_free() {
    // A lookup reads every entry under `[field][value key]`; no value's key
    // may extend another's, or one value would read another's documents.
    let values = [
        Value::Null,
        Value::Boolean(false),
        Value::Integer(7),
        Value::Double(0.5),
        Value::Double(f64::NAN),
        Value::Timestamp(Timestamp::new(1, 2).unwrap()),
        text(""),
        text("a"),
        text("ab"),
        text(&"long".repeat(40)),
        Value::Bytes(Arc::from(&b"a"[..])),
        Value::Reference(Arc::from("projects/p/databases/d/documents/a/b")),
        Value::GeoPoint {
            latitude: 1.0,
            longitude: 2.0,
        },
    ];
    let keys = values
        .iter()
        .map(|value| value_key(value).unwrap())
        .collect::<Vec<_>>();
    for (left_index, left) in keys.iter().enumerate() {
        for (right_index, right) in keys.iter().enumerate() {
            if left_index != right_index {
                assert!(
                    !right.starts_with(left),
                    "{:?} is a prefix of {:?}",
                    values[left_index],
                    values[right_index]
                );
            }
        }
    }
}

#[test]
fn the_maintained_index_equals_a_rebuild_after_every_kind_of_write() {
    let directory = TestDirectory::new();
    let store = DiskStore::open(&directory.0, DiskOptions::default()).unwrap();
    store
        .commit(&[
            set(
                "jobs/a",
                fields([
                    ("status", text("queued")),
                    ("owner", text("o1")),
                    ("tags", Value::Array(vec![text("x")])),
                    (
                        "meta",
                        Value::Map(BTreeMap::from([("k".to_owned(), text("v"))])),
                    ),
                ]),
            ),
            set(
                "jobs/b",
                fields([("status", text("running")), ("owner", text("o1"))]),
            ),
            set(
                "jobs/c",
                fields([("status", text("done")), ("n", Value::Double(2.0))]),
            ),
            set("jobs/c/events/e1", fields([("status", text("queued"))])),
            set("other/a", fields([("status", text("queued"))])),
        ])
        .unwrap();
    store
        .commit(&[
            // A changed value, a removed field and a field that becomes a map.
            patch(
                "jobs/a",
                fields([
                    ("status", text("running")),
                    ("owner", Value::Map(BTreeMap::new())),
                ]),
                &["status", "owner", "tags"],
            ),
            set("jobs/b", fields([("status", text("running"))])),
            delete("jobs/c"),
            set("jobs/d", fields([("n", Value::Integer(2))])),
        ])
        .unwrap();
    let maintained = index_entries(&store);
    assert_ne!(maintained.len(), 0);
    rebuild_field_index(&store.state().database).unwrap();
    assert_eq!(index_entries(&store), maintained);

    let snapshot = store.snapshot();
    assert_eq!(
        candidates(&snapshot, "jobs", &[("status", &[text("running")])]),
        ["jobs/a", "jobs/b"]
    );
    assert_eq!(
        candidates(&snapshot, "jobs", &[("status", &[text("queued")])]),
        Vec::<String>::new()
    );
    assert_eq!(
        candidates(&snapshot, "jobs", &[("owner", &[text("o1")])]),
        Vec::<String>::new()
    );
    assert_eq!(
        candidates(&snapshot, "jobs", &[("n", &[Value::Double(2.0)])]),
        ["jobs/d"]
    );
    assert_eq!(
        candidates(&snapshot, "jobs/c/events", &[("status", &[text("queued")])]),
        ["jobs/c/events/e1"]
    );
}

#[test]
fn a_store_last_written_without_the_index_rebuilds_it_on_open() {
    let directory = TestDirectory::new();
    {
        let store = DiskStore::open(&directory.0, DiskOptions::default()).unwrap();
        store
            .commit(&[set("jobs/a", fields([("status", text("queued"))]))])
            .unwrap();
    }
    {
        // An older release, or the index switched off: commits skip it.
        let store = DiskStore::open(&directory.0, options(false)).unwrap();
        assert!(
            store
                .snapshot()
                .iter_collection_equal(
                    &database(),
                    "jobs",
                    &[FieldEquality {
                        field: "status",
                        values: &[text("queued")],
                    }],
                )
                .is_none(),
            "a store opened without the index never reads it"
        );
        store
            .commit(&[
                set("jobs/a", fields([("status", text("done"))])),
                set("jobs/b", fields([("status", text("queued"))])),
            ])
            .unwrap();
        store.flush().unwrap();
    }
    let store = DiskStore::open(&directory.0, DiskOptions::default()).unwrap();
    let snapshot = store.snapshot();
    assert_eq!(
        candidates(&snapshot, "jobs", &[("status", &[text("queued")])]),
        ["jobs/b"]
    );
    assert_eq!(
        candidates(&snapshot, "jobs", &[("status", &[text("done")])]),
        ["jobs/a"]
    );
    let state = store.state();
    let transaction = state.database.begin_read().unwrap();
    let metadata = transaction.open_table(METADATA).unwrap();
    assert!(metadata.get(FIELD_INDEX_REVISION_KEY).unwrap().is_some());
}

#[test]
fn a_replayed_journal_record_updates_the_index() {
    let directory = TestDirectory::new();
    {
        let store = DiskStore::open(&directory.0, DiskOptions::default()).unwrap();
        store
            .commit(&[set("jobs/a", fields([("status", text("queued"))]))])
            .unwrap();
        // A commit journaled but not yet written to redb, as a crash leaves it.
        let mut state = store.state();
        let plan = state
            .memory
            .plan(&[set("jobs/a", fields([("status", text("done"))]))])
            .unwrap();
        let record = WalRecord::from_plan(&plan);
        state
            .journal
            .as_mut()
            .unwrap()
            .append(&record, &store.write_buffers, true)
            .unwrap();
    }
    let store = DiskStore::open(&directory.0, DiskOptions::default()).unwrap();
    let snapshot = store.snapshot();
    assert_eq!(
        snapshot.get(&key("jobs/a")).unwrap().fields()["status"],
        text("done")
    );
    assert_eq!(
        candidates(&snapshot, "jobs", &[("status", &[text("queued")])]),
        Vec::<String>::new()
    );
    assert_eq!(
        candidates(&snapshot, "jobs", &[("status", &[text("done")])]),
        ["jobs/a"]
    );
}

#[test]
fn a_bulk_load_maintains_the_index() {
    let directory = TestDirectory::new();
    let store = DiskStore::open(&directory.0, DiskOptions::default()).unwrap();
    {
        let mut bulk = store.begin_bulk_commit().unwrap();
        bulk.commit(&[
            set("jobs/a", fields([("status", text("queued"))])),
            set("jobs/b", fields([("status", text("queued"))])),
        ])
        .unwrap();
        bulk.commit(&[set("jobs/a", fields([("status", text("done"))]))])
            .unwrap();
        bulk.finish().unwrap();
    }
    let maintained = index_entries(&store);
    rebuild_field_index(&store.state().database).unwrap();
    assert_eq!(index_entries(&store), maintained);
    assert_eq!(
        candidates(&store.snapshot(), "jobs", &[("status", &[text("queued")])]),
        ["jobs/b"]
    );
}

#[test]
fn a_historical_snapshot_offers_the_documents_it_held() {
    let directory = TestDirectory::new();
    let store = DiskStore::open(&directory.0, DiskOptions::default()).unwrap();
    let first = store
        .commit(&[
            set("jobs/a", fields([("status", text("queued"))])),
            set("jobs/b", fields([("status", text("queued"))])),
        ])
        .unwrap()
        .revision;
    store
        .commit(&[
            set("jobs/a", fields([("status", text("done"))])),
            delete("jobs/b"),
        ])
        .unwrap();

    let past = store.snapshot_at(first).unwrap();
    let offered = candidates(&past, "jobs", &[("status", &[text("queued")])]);
    for path in ["jobs/a", "jobs/b"] {
        assert!(
            offered.iter().any(|offered| offered == path),
            "{path} in {offered:?}"
        );
    }
    // The overlay's own state is what the candidate carries.
    let documents = past
        .iter_collection_equal(
            &database(),
            "jobs",
            &[FieldEquality {
                field: "status",
                values: &[text("queued")],
            }],
        )
        .unwrap()
        .map(|(key, document)| (key.path().to_owned(), document.into_document()))
        .collect::<BTreeMap<_, _>>();
    assert_eq!(documents["jobs/a"].fields()["status"], text("queued"));

    let now = store.snapshot();
    assert_eq!(
        candidates(&now, "jobs", &[("status", &[text("queued")])]),
        Vec::<String>::new()
    );
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

    fn below(&mut self, bound: u64) -> u64 {
        self.next() % bound
    }
}

#[test]
fn the_join_returns_exactly_the_documents_every_conjunct_holds() {
    let statuses = ["queued", "running", "done", "failed"];
    let owners = ["o1", "o2", "o3"];
    for seed in 0..12_u64 {
        let directory = TestDirectory::new();
        let store = DiskStore::open(&directory.0, DiskOptions::default()).unwrap();
        let mut random = Lcg(seed.wrapping_add(17));
        let mut expected: BTreeMap<String, Fields> = BTreeMap::new();
        for _ in 0..40 {
            let mut writes = Vec::new();
            for _ in 0..random.below(6).saturating_add(1) {
                let id = match random.below(3) {
                    0 => format!("__id{}__", random.below(30)),
                    _ => format!("job-{}", random.below(60)),
                };
                let path = format!("jobs/{id}");
                if random.below(5) == 0 {
                    writes.push(delete(&path));
                    expected.remove(&path);
                } else {
                    let mut document = Fields::new();
                    document.insert(
                        "status".to_owned(),
                        text(statuses[usize::try_from(random.below(4)).unwrap()]),
                    );
                    if random.below(4) != 0 {
                        document.insert(
                            "owner".to_owned(),
                            text(owners[usize::try_from(random.below(3)).unwrap()]),
                        );
                    }
                    document.insert(
                        "rank".to_owned(),
                        Value::Integer(i64::try_from(random.below(3)).unwrap()),
                    );
                    writes.push(set(&path, document.clone()));
                    expected.insert(path, document);
                }
            }
            // One commit may name a key once.
            let mut seen = std::collections::BTreeSet::new();
            let writes = writes
                .into_iter()
                .rev()
                .filter(|write| seen.insert(super::super::write_key(write).clone()))
                .collect::<Vec<_>>();
            store.commit(&writes).unwrap();
            expected.clear();
            for (key, document) in store
                .snapshot()
                .iter_collection(&database(), "jobs")
                .map(|(key, document)| (key.path().to_owned(), document.fields().clone()))
            {
                expected.insert(key, document);
            }

            let snapshot = store.snapshot();
            let status_values = (0..random.below(3).saturating_add(1))
                .map(|_| text(statuses[usize::try_from(random.below(4)).unwrap()]))
                .collect::<Vec<_>>();
            let owner_values = vec![text(owners[usize::try_from(random.below(3)).unwrap()])];
            let rank = random.below(3);
            // Stored as integers, looked up as the equal doubles.
            let rank_values = vec![Value::Double(f64::from(u32::try_from(rank).unwrap()))];
            let mut lookups: Vec<(&str, &[Value])> = vec![("status", &status_values)];
            if random.below(2) == 0 {
                lookups.push(("owner", &owner_values));
            }
            if random.below(2) == 0 {
                lookups.push(("rank", &rank_values));
            }
            let mut wanted = expected
                .iter()
                .filter(|(_, document)| {
                    lookups.iter().all(|(field, values)| {
                        document.get(*field).is_some_and(|value| {
                            if *field == "rank" {
                                *value == Value::Integer(i64::try_from(rank).unwrap())
                            } else {
                                values.contains(value)
                            }
                        })
                    })
                })
                .map(|(path, _)| path.clone())
                .collect::<Vec<_>>();
            wanted.sort_by(|left, right| compare_resource_paths(left, right));
            assert_eq!(
                candidates(&snapshot, "jobs", &lookups),
                wanted,
                "seed {seed}, lookups {lookups:?}"
            );
        }
    }
}

#[test]
fn an_open_that_rebuilds_counts_documents_like_a_plain_open() {
    // The rebuild's pass also yields the memory accounting the open would
    // otherwise compute in a second pass over every document.
    let directory = TestDirectory::new();
    {
        let store = DiskStore::open(&directory.0, options(false)).unwrap();
        store
            .commit(&[
                set(
                    "jobs/a",
                    fields([("status", text("queued")), ("n", Value::Integer(3))]),
                ),
                set("jobs/a/events/e", fields([("type", text("delta"))])),
                set("other/b", fields([("payload", text(&"z".repeat(10_000)))])),
            ])
            .unwrap();
        store.flush().unwrap();
    }
    let rebuilt = {
        let store = DiskStore::open(&directory.0, DiskOptions::default()).unwrap();
        store.snapshot().logical_memory_usage()
    };
    let plain = {
        let store = DiskStore::open(&directory.0, DiskOptions::default()).unwrap();
        store.snapshot().logical_memory_usage()
    };
    assert_eq!(rebuilt, plain);
    assert_eq!(rebuilt.entries, 3);
}
