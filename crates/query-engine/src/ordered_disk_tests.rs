use super::*;
use firenook_core_store::{DiskOptions, Precondition, Store, Write};

struct TestDirectory(std::path::PathBuf);
impl TestDirectory {
    fn new() -> Self {
        static SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "firenook-ordered-disk-{}-{}-{}",
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
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}
fn field(name: &str) -> FieldPath {
    FieldPath::field([name]).unwrap()
}
fn key(db: &DatabaseName, name: &str) -> DocumentKey {
    DocumentKey::new(db.clone(), name).unwrap()
}
fn write(db: &DatabaseName, name: &str, rank: Value) -> Write {
    Write::Set {
        key: key(db, name),
        fields: BTreeMap::from([
            ("rank".into(), rank),
            (
                "nested".into(),
                Value::Map(BTreeMap::from([("score".into(), Value::Integer(2))])),
            ),
            (
                "payload".into(),
                Value::String("unrelated payload".repeat(4096).into()),
            ),
        ]),
        transforms: vec![],
        precondition: Precondition::None,
    }
}
fn signature(documents: impl Iterator<Item = QueryDocument>) -> Vec<String> {
    documents
        .map(|d| {
            format!(
                "{:?}|{:?}|{:?}",
                d.key(),
                d.document(),
                d.projected_fields()
            )
        })
        .collect()
}
fn compare(snapshot: &Snapshot, db: &DatabaseName, query: &Query, edition: DatabaseEdition) {
    let expected = execute_buffered(
        snapshot,
        db,
        query,
        edition,
        &normalized_orders(query).unwrap(),
    )
    .unwrap();
    assert_eq!(
        signature(execute_iter(snapshot, db, query, edition).unwrap()),
        signature(expected.into_iter())
    );
}

#[test]
fn compact_disk_order_matches_buffered_oracle_semantics() {
    let dir = TestDirectory::new();
    let store = Store::open_disk(&dir.0, DiskOptions::default()).unwrap();
    let db = DatabaseName::new("demo", "(default)").unwrap();
    let values = [
        Value::Null,
        Value::Double(f64::NAN),
        Value::Integer(2),
        Value::Double(2.0),
        Value::String(("x".repeat(1500) + "z").into()),
        Value::String(("x".repeat(1500) + "a").into()),
        Value::Bytes([vec![1; 1500], vec![3]].concat().into()),
        Value::Bytes([vec![1; 1500], vec![2]].concat().into()),
        Value::Map(BTreeMap::from([("a".into(), Value::Integer(2))])),
        Value::Array(vec![Value::Integer(1), Value::String("CJK 中文 😀".into())]),
    ];
    let mut writes = values
        .into_iter()
        .enumerate()
        .map(|(i, value)| write(&db, &format!("items/__id{i}__"), value))
        .collect::<Vec<_>>();
    writes.extend([
        write(&db, "items/__id-2__", Value::Integer(2)),
        write(&db, "items/__id20__", Value::Integer(2)),
        Write::Set {
            key: key(&db, "items/missing"),
            fields: BTreeMap::new(),
            transforms: vec![],
            precondition: Precondition::None,
        },
    ]);
    store.commit(&writes).unwrap();
    let snapshot = store.snapshot();
    for edition in [DatabaseEdition::Standard, DatabaseEdition::Enterprise] {
        for direction in [Direction::Ascending, Direction::Descending] {
            let query = Query::new(QueryScope::collection("items").unwrap())
                .order_by(field("rank"), direction);
            compare(&snapshot, &db, &query, edition);
            compare(
                &snapshot,
                &db,
                &query.clone().offset(3).select(vec![field("payload")]),
                edition,
            );
            for inclusive in [true, false] {
                let mut cursor = query.clone();
                cursor.start = Some(Cursor {
                    values: vec![Value::Integer(2)],
                    inclusive,
                });
                compare(&snapshot, &db, &cursor.clone().offset(1), edition);
                cursor.start = None;
                cursor.end = Some(Cursor {
                    values: vec![Value::Integer(2)],
                    inclusive,
                });
                compare(&snapshot, &db, &cursor, edition);
            }
            for limit in [Limit::First(3), Limit::Last(3)] {
                let limited = query.clone().limit(limit);
                assert!(matches!(
                    execute_iter(&snapshot, &db, &limited, edition)
                        .unwrap()
                        .inner,
                    QueryDocumentIteratorInner::Buffered(_)
                ));
                compare(&snapshot, &db, &limited, edition);
            }
        }
        let implicit = Query::new(QueryScope::collection("items").unwrap()).filter(Filter::Field(
            FieldFilter {
                path: field("rank"),
                operator: FieldOperator::NotEqual,
                value: Value::Null,
            },
        ));
        compare(&snapshot, &db, &implicit, edition);
        let nested = Query::new(QueryScope::collection("items").unwrap()).order_by(
            FieldPath::field(["nested", "score"]).unwrap(),
            Direction::Descending,
        );
        compare(&snapshot, &db, &nested, edition);
    }
}

#[test]
fn ordered_disk_results_keep_original_snapshot_and_historical_overlay() {
    let dir = TestDirectory::new();
    let store = Store::open_disk(&dir.0, DiskOptions::default()).unwrap();
    let db = DatabaseName::new("demo", "(default)").unwrap();
    store
        .commit(&[
            write(&db, "parents/a/items/one", Value::Integer(1)),
            write(&db, "parents/a/items/two", Value::Integer(2)),
            write(&db, "parents/b/items/other", Value::Integer(0)),
        ])
        .unwrap();
    let snapshot = store.snapshot();
    let query = Query::new(QueryScope::collection_group("items").unwrap())
        .order_by(field("rank"), Direction::Descending)
        .select(vec![field("rank")]);
    let expected = signature(
        execute_buffered(
            &snapshot,
            &db,
            &query,
            DatabaseEdition::Standard,
            &normalized_orders(&query).unwrap(),
        )
        .unwrap()
        .into_iter(),
    );
    let iterator = execute_iter(&snapshot, &db, &query, DatabaseEdition::Standard).unwrap();
    assert!(matches!(
        &iterator.inner,
        QueryDocumentIteratorInner::OrderedDisk(_)
    ));
    store
        .commit(&[
            write(&db, "parents/a/items/one", Value::Integer(99)),
            Write::Delete {
                key: key(&db, "parents/a/items/two"),
                precondition: Precondition::None,
            },
            write(&db, "parents/a/items/new", Value::Integer(0)),
        ])
        .unwrap();
    assert_eq!(
        signature(iterator),
        expected,
        "later writes cannot change delayed retrieval or timestamps"
    );
    let historical = store.snapshot_at(snapshot.revision()).unwrap();
    let historical_iterator =
        execute_iter(&historical, &db, &query, DatabaseEdition::Standard).unwrap();
    let scoped = query.clone().under_ancestor("parents/a").unwrap();
    let scoped_iterator =
        execute_iter(&historical, &db, &scoped, DatabaseEdition::Standard).unwrap();
    let scoped_expected = signature(
        execute_buffered(
            &historical,
            &db,
            &scoped,
            DatabaseEdition::Standard,
            &normalized_orders(&scoped).unwrap(),
        )
        .unwrap()
        .into_iter(),
    );
    store
        .commit(&[
            write(&db, "parents/a/items/two", Value::Integer(-1)),
            Write::Delete {
                key: key(&db, "parents/a/items/one"),
                precondition: Precondition::None,
            },
        ])
        .unwrap();
    assert_eq!(signature(historical_iterator), expected);
    assert_eq!(signature(scoped_iterator), scoped_expected);
    assert_eq!(scoped_expected.len(), 2);
    compare(
        &historical,
        &db,
        &query.clone().offset(1),
        DatabaseEdition::Standard,
    );
}

#[test]
fn ordered_disk_iterator_retains_keys_not_unrelated_document_payloads() {
    let dir = TestDirectory::new();
    let store = Store::open_disk(&dir.0, DiskOptions::default()).unwrap();
    let db = DatabaseName::new("demo", "(default)").unwrap();
    store
        .commit(
            &(0..128)
                .map(|i| write(&db, &format!("items/{i}"), Value::Integer(i)))
                .collect::<Vec<_>>(),
        )
        .unwrap();
    let query = Query::new(QueryScope::collection("items").unwrap())
        .order_by(field("rank"), Direction::Descending)
        .offset(5);
    let iterator = execute_iter(&store.snapshot(), &db, &query, DatabaseEdition::Standard).unwrap();
    let QueryDocumentIteratorInner::OrderedDisk(ordered) = &iterator.inner else {
        panic!("must not retain decoded result vector");
    };
    assert_eq!(ordered.keys.len(), 123);
    assert!(ordered.projection.is_none());
    assert!(ordered.snapshot.is_disk_backed());
    assert_eq!(iterator.count(), 123);
}

fn reference(db: &DatabaseName, path: &str) -> Value {
    Value::Reference(std::sync::Arc::from(key(db, path).to_string()))
}

/// Seeds the same documents into a memory store and a disk store so results
/// can be compared across the decoded and encoded candidate paths.
fn paired_stores(dir: &TestDirectory, db: &DatabaseName) -> (Store, Store) {
    let memory = Store::default();
    let disk = Store::open_disk(&dir.0, DiskOptions::default()).unwrap();
    let mut writes = (0..40)
        .map(|index| write(db, &format!("items/{index:02}"), Value::Integer(index % 7)))
        .collect::<Vec<_>>();
    writes.push(write(db, "others/x", Value::Integer(1)));
    writes.push(write(db, "items/05/children/c", Value::Integer(1)));
    writes.push(write(db, "itemsArchive/z", Value::Integer(1)));
    memory.commit(&writes).unwrap();
    disk.commit(&writes).unwrap();
    (memory, disk)
}

/// Like `signature` but without commit times, which differ between two
/// separately committed stores.
fn timeless_signature(documents: impl Iterator<Item = QueryDocument>) -> Vec<String> {
    documents
        .map(|d| {
            format!(
                "{:?}|{:?}|{:?}",
                d.key(),
                d.document().fields(),
                d.projected_fields()
            )
        })
        .collect()
}

fn same_on_both_backends(memory: &Store, disk: &Store, db: &DatabaseName, query: &Query) {
    let edition = DatabaseEdition::Standard;
    let expected =
        timeless_signature(execute_iter(&memory.snapshot(), db, query, edition).unwrap());
    let actual = timeless_signature(execute_iter(&disk.snapshot(), db, query, edition).unwrap());
    assert_eq!(actual, expected, "{query:?}");
    assert!(
        !expected.is_empty(),
        "query must select something: {query:?}"
    );
    compare(&disk.snapshot(), db, query, edition);
    assert_eq!(
        count(&disk.snapshot(), db, query, edition).unwrap(),
        u64::try_from(expected.len()).unwrap(),
        "count on disk: {query:?}"
    );
    assert_eq!(
        count(&memory.snapshot(), db, query, edition).unwrap(),
        u64::try_from(expected.len()).unwrap(),
        "count in memory: {query:?}"
    );
}

#[test]
fn encoded_candidates_match_decoded_results_for_every_query_shape() {
    let dir = TestDirectory::new();
    let db = DatabaseName::new("lazy-scan", "(default)").unwrap();
    let (memory, disk) = paired_stores(&dir, &db);
    let scope = || QueryScope::collection("items").unwrap();
    let queries = vec![
        Query::new(scope()),
        Query::new(scope()).order_by(field("rank"), Direction::Descending),
        Query::new(scope())
            .order_by(field("rank"), Direction::Ascending)
            .limit(Limit::First(5)),
        Query::new(scope())
            .order_by(field("rank"), Direction::Ascending)
            .limit(Limit::Last(4)),
        Query::new(scope()).filter(Filter::Field(FieldFilter {
            path: field("rank"),
            operator: FieldOperator::GreaterThanOrEqual,
            value: Value::Integer(4),
        })),
        Query::new(scope())
            .filter(Filter::Field(FieldFilter {
                path: FieldPath::field(["nested", "score"]).unwrap(),
                operator: FieldOperator::Equal,
                value: Value::Integer(2),
            }))
            .order_by(field("rank"), Direction::Ascending)
            .start_after(vec![Value::Integer(2)])
            .limit(Limit::First(6)),
        Query::new(scope())
            .filter(Filter::Field(FieldFilter {
                path: FieldPath::DocumentId,
                operator: FieldOperator::In,
                value: Value::Array(vec![
                    reference(&db, "items/07"),
                    reference(&db, "items/03"),
                    reference(&db, "items/03"),
                    reference(&db, "others/x"),
                    reference(&db, "items/05/children/c"),
                    reference(&db, "items/99"),
                ]),
            }))
            .order_by(field("rank"), Direction::Descending),
        Query::new(scope()).filter(Filter::And(vec![
            Filter::Field(FieldFilter {
                path: FieldPath::DocumentId,
                operator: FieldOperator::Equal,
                value: reference(&db, "items/11"),
            }),
            Filter::Field(FieldFilter {
                path: field("rank"),
                operator: FieldOperator::Equal,
                value: Value::Integer(4),
            }),
        ])),
        Query::new(QueryScope::collection_group("children").unwrap()).filter(Filter::Field(
            FieldFilter {
                path: FieldPath::DocumentId,
                operator: FieldOperator::In,
                value: Value::Array(vec![
                    reference(&db, "items/05/children/c"),
                    reference(&db, "items/05"),
                ]),
            },
        )),
    ];
    for query in queries {
        same_on_both_backends(&memory, &disk, &db, &query);
    }
}

#[test]
fn named_candidates_respect_scope_database_and_order() {
    let db = DatabaseName::new("lazy-scan", "(default)").unwrap();
    let other = DatabaseName::new("lazy-scan", "other").unwrap();
    let query =
        Query::new(QueryScope::collection("items").unwrap()).filter(Filter::Field(FieldFilter {
            path: FieldPath::DocumentId,
            operator: FieldOperator::In,
            value: Value::Array(vec![
                reference(&db, "items/10"),
                reference(&db, "items/9"),
                reference(&db, "items/9"),
                reference(&other, "items/1"),
                reference(&db, "others/1"),
                reference(&db, "items/1/children/2"),
                Value::Reference(std::sync::Arc::from("not/a/document/name")),
            ]),
        }));
    let keys = named_candidates(&query, &db).unwrap();
    assert_eq!(
        keys.iter().map(DocumentKey::path).collect::<Vec<_>>(),
        ["items/10", "items/9"]
    );

    // A string value is not a reference: no point lookup, scan instead.
    let string_query =
        Query::new(QueryScope::collection("items").unwrap()).filter(Filter::Field(FieldFilter {
            path: FieldPath::DocumentId,
            operator: FieldOperator::Equal,
            value: Value::String("items/1".into()),
        }));
    assert!(named_candidates(&string_query, &db).is_none());
    // Membership inside an `or` cannot name the whole candidate set.
    let or_query = Query::new(QueryScope::collection("items").unwrap()).filter(Filter::Or(vec![
        Filter::Field(FieldFilter {
            path: FieldPath::DocumentId,
            operator: FieldOperator::Equal,
            value: reference(&db, "items/1"),
        }),
        Filter::Field(FieldFilter {
            path: field("rank"),
            operator: FieldOperator::Equal,
            value: Value::Integer(1),
        }),
    ]));
    assert!(named_candidates(&or_query, &db).is_none());
}
