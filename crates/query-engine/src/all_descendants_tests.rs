//! Queries that name no collection, the shape `recursiveDelete` sends, against
//! both backends. The expected order is the official emulator capture in
//! `conformance/fixtures/kindless-query-v1`.
use super::*;
use firenook_core_store::{DiskOptions, Precondition, Store, StoreOptions, Write};

struct TestDirectory(std::path::PathBuf);
impl TestDirectory {
    fn new() -> Self {
        static SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "firenook-all-descendants-{}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
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

fn db() -> DatabaseName {
    DatabaseName::new("demo", "(default)").unwrap()
}
fn set(database: &DatabaseName, path: &str) -> Write {
    Write::Set {
        key: DocumentKey::new(database.clone(), path).unwrap(),
        fields: BTreeMap::from([("n".into(), Value::Integer(1))]),
        transforms: vec![],
        precondition: Precondition::None,
    }
}
fn seed(store: &Store, paths: &[&str]) {
    let writes = paths
        .iter()
        .map(|path| set(&db(), path))
        .collect::<Vec<_>>();
    store.commit(&writes).unwrap();
}
/// Runs `check` on an empty store of each backend.
fn on_both_backends(check: impl Fn(&Store)) {
    check(&Store::new(StoreOptions::default()));
    let directory = TestDirectory::new();
    let store = Store::open_disk(&directory.0, DiskOptions::default()).unwrap();
    check(&store);
    drop(store);
}
fn all() -> Query {
    Query::new(QueryScope::AllDescendants)
}
fn paths(store: &Store, query: &Query) -> Vec<String> {
    paths_at(&store.snapshot(), query)
}
fn paths_at(snapshot: &Snapshot, query: &Query) -> Vec<String> {
    execute_iter(snapshot, &db(), query, DatabaseEdition::Standard)
        .unwrap()
        .map(|document| document.key().path().to_owned())
        .collect()
}
fn name(path: &str) -> Value {
    Value::Reference(Arc::from(format!(
        "projects/demo/databases/(default)/documents/{path}"
    )))
}
fn on_name(operator: FieldOperator, path: &str) -> Filter {
    Filter::Field(FieldFilter {
        path: FieldPath::DocumentId,
        operator,
        value: name(path),
    })
}
/// The filter the Admin SDK sends for one collection.
fn sdk_range(collection: &str) -> Filter {
    Filter::And(vec![
        on_name(
            FieldOperator::GreaterThanOrEqual,
            &format!("{collection}/{LOWEST_RESOURCE_ID}"),
        ),
        on_name(
            FieldOperator::LessThan,
            &format!("{collection}\0/{LOWEST_RESOURCE_ID}"),
        ),
    ])
}

const TREE: [&str; 14] = [
    "rd/A",
    "rd/a",
    "rd/__id5__",
    "rd/a/sub/x",
    "rd/a/sub/x/deep/y",
    "rd/ghost/sub/z",
    "rd-sibling/a",
    "rd0/a",
    "rc/a",
    "top/parent",
    "top/parent/c1/one",
    "top/parent/c1/one/c2/two",
    "top/parent/c3/three",
    "top/other/c1/four",
];

#[test]
fn names_come_in_segment_order_with_numeric_ids_first() {
    on_both_backends(|store| {
        seed(store, &TREE);
        assert_eq!(
            paths(store, &all()),
            [
                "rc/a",
                "rd/__id5__",
                "rd/A",
                "rd/a",
                "rd/a/sub/x",
                "rd/a/sub/x/deep/y",
                "rd/ghost/sub/z",
                "rd-sibling/a",
                "rd0/a",
                "top/other/c1/four",
                "top/parent",
                "top/parent/c1/one",
                "top/parent/c1/one/c2/two",
                "top/parent/c3/three",
            ]
        );
    });
}

#[test]
fn an_ancestor_keeps_only_what_is_below_it() {
    on_both_backends(|store| {
        seed(store, &TREE);
        let under = |path: &str| all().under_ancestor(path).unwrap();
        assert_eq!(
            paths(store, &under("top/parent")),
            [
                "top/parent/c1/one",
                "top/parent/c1/one/c2/two",
                "top/parent/c3/three"
            ]
        );
        // A document that does not exist still has what is below it.
        assert_eq!(paths(store, &under("rd/ghost")), ["rd/ghost/sub/z"]);
        assert_eq!(paths(store, &under("nope/nope")), [""; 0]);
        // `top/parent` is not below `top/par`, however the bytes compare.
        assert_eq!(paths(store, &under("top/par")), [""; 0]);
    });
}

#[test]
fn the_sdk_range_covers_one_collection_and_nothing_beside_it() {
    on_both_backends(|store| {
        seed(store, &TREE);
        assert_eq!(
            paths(store, &all().filter(sdk_range("rd"))),
            [
                "rd/__id5__",
                "rd/A",
                "rd/a",
                "rd/a/sub/x",
                "rd/a/sub/x/deep/y",
                "rd/ghost/sub/z",
            ]
        );
        let below_parent = all()
            .under_ancestor("top/parent")
            .unwrap()
            .filter(sdk_range("top/parent/c1"));
        assert_eq!(
            paths(store, &below_parent),
            ["top/parent/c1/one", "top/parent/c1/one/c2/two"]
        );
    });
}

#[test]
fn a_range_that_is_not_exactly_one_collection_is_not_narrowed() {
    let range = |lower: String, upper: String| {
        Filter::And(vec![
            on_name(FieldOperator::GreaterThanOrEqual, &lower),
            on_name(FieldOperator::LessThan, &upper),
        ])
    };
    let lowest = LOWEST_RESOURCE_ID;
    for filter in [
        // The bound starts inside the collection, or ends in another one.
        range(format!("rd/x{lowest}"), format!("rd\0/{lowest}")),
        range(format!("rd/{lowest}"), format!("rd0/{lowest}")),
        range(format!("rd/{lowest}"), "rd\0/x".to_owned()),
        on_name(FieldOperator::GreaterThan, "rd/a"),
    ] {
        assert_eq!(name_range_collection(&filter, &db()), None, "{filter:?}");
    }
    assert_eq!(
        name_range_collection(&sdk_range("a/b/c"), &db()).as_deref(),
        Some("a/b/c")
    );
    // A range in another database is not this database's collection.
    let other = DatabaseName::new("demo", "other").unwrap();
    assert_eq!(name_range_collection(&sdk_range("rd"), &other), None);
    // Disagreeing with the ancestor keeps the ancestor.
    let query = all()
        .under_ancestor("top/parent")
        .unwrap()
        .filter(sdk_range("rd"));
    assert_eq!(descendant_prefix(&query, &db()), "top/parent/");
}

/// A small deterministic generator: no dependency, the same sequence each run.
struct Random(u64);
impl Random {
    fn below(&mut self, bound: usize) -> usize {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1);
        usize::try_from((self.0 >> 33) % u64::try_from(bound).unwrap()).unwrap()
    }
    fn id(&mut self) -> String {
        const IDS: [&str; 12] = [
            "a", "a-b", "a0", "A", "__id-3__", "__id5__", "__id12__", "b", "c.d", "z", "_x_", "é",
        ];
        IDS[self.below(IDS.len())].to_owned()
    }
    fn path(&mut self) -> String {
        let pairs = 1 + self.below(3);
        (0..pairs * 2)
            .map(|_| self.id())
            .collect::<Vec<_>>()
            .join("/")
    }
}

#[test]
fn a_limit_selects_the_lowest_names_across_collections_as_a_full_sort_would() {
    on_both_backends(|store| {
        let mut random = Random(7);
        let mut every = BTreeSet::new();
        for _ in 0..4 {
            let batch = (0..150).map(|_| random.path()).collect::<BTreeSet<_>>();
            let writes = batch
                .iter()
                .map(|path| set(&db(), path))
                .collect::<Vec<_>>();
            store.commit(&writes).unwrap();
            every.extend(batch);
        }
        let mut sorted = every.iter().cloned().collect::<Vec<_>>();
        sorted.sort_by(|left, right| compare_resource_paths(left, right));
        for round in 0..200 {
            let start = random.path();
            let (mut query, expected): (Query, Vec<&String>) = match round % 4 {
                0 => (
                    all().start_after(vec![name(&start)]),
                    sorted
                        .iter()
                        .filter(|path| compare_resource_paths(path, &start) == Ordering::Greater)
                        .collect(),
                ),
                1 => (
                    all().filter(on_name(FieldOperator::GreaterThanOrEqual, &start)),
                    sorted
                        .iter()
                        .filter(|path| compare_resource_paths(path, &start) != Ordering::Less)
                        .collect(),
                ),
                2 => {
                    let ancestor = random.path();
                    let prefix = format!("{ancestor}/");
                    (
                        all().under_ancestor(ancestor).unwrap(),
                        sorted
                            .iter()
                            .filter(|path| path.starts_with(&prefix))
                            .collect(),
                    )
                }
                _ => (all(), sorted.iter().collect()),
            };
            let offset = random.below(4);
            let limit = random.below(40);
            query = query.offset(offset).limit(Limit::First(limit));
            let expected = expected
                .into_iter()
                .skip(offset)
                .take(limit)
                .cloned()
                .collect::<Vec<_>>();
            assert_eq!(paths(store, &query), expected, "round {round}: {query:?}");
        }
    });
}

#[test]
fn a_past_snapshot_keeps_seeing_what_it_saw() {
    on_both_backends(|store| {
        seed(store, &["c/a", "c/b", "c/b/kids/one", "d/a"]);
        let before = store.snapshot();
        let revision = before.revision();
        store
            .commit(&[
                Write::Delete {
                    key: DocumentKey::new(db(), "c/a").unwrap(),
                    precondition: Precondition::None,
                },
                set(&db(), "c/new"),
                set(&db(), "c/b/kids/two"),
            ])
            .unwrap();
        let saw = ["c/a", "c/b", "c/b/kids/one", "d/a"];
        assert_eq!(paths_at(&before, &all()), saw);
        let historical = store.snapshot_at(revision).unwrap();
        assert_eq!(paths_at(&historical, &all()), saw);
        assert_eq!(
            paths_at(&historical, &all().limit(Limit::First(2))),
            ["c/a", "c/b"]
        );
        assert_eq!(
            paths(store, &all()),
            ["c/b", "c/b/kids/one", "c/b/kids/two", "c/new", "d/a"]
        );
    });
}

#[test]
fn another_database_is_never_seen() {
    on_both_backends(|store| {
        let other = DatabaseName::new("demo", "other").unwrap();
        let project = DatabaseName::new("demo-2", "(default)").unwrap();
        store
            .commit(&[
                set(&db(), "c/here"),
                set(&other, "c/there"),
                set(&project, "c/elsewhere"),
            ])
            .unwrap();
        assert_eq!(paths(store, &all()), ["c/here"]);
        let names = execute_iter(&store.snapshot(), &other, &all(), DatabaseEdition::Standard)
            .unwrap()
            .map(|document| document.key().path().to_owned())
            .collect::<Vec<_>>();
        assert_eq!(names, ["c/there"]);
    });
}

#[test]
fn it_counts_and_explains_itself() {
    on_both_backends(|store| {
        seed(store, &TREE);
        let snapshot = store.snapshot();
        let count_of = |query: &Query| count(&snapshot, &db(), query, DatabaseEdition::Standard);
        assert_eq!(count_of(&all()), Ok(14));
        assert_eq!(count_of(&all().filter(sdk_range("rd"))), Ok(6));
        assert_eq!(count_of(&all().limit(Limit::First(4))), Ok(4));
        assert_eq!(
            count_of(&all().under_ancestor("top/parent").unwrap()),
            Ok(3)
        );
        let plan = plan(
            &snapshot,
            &db(),
            &all().under_ancestor("top/parent").unwrap(),
        )
        .unwrap();
        assert_eq!(
            plan.candidates,
            QueryCandidates::DescendantKeys {
                ancestor: Some("top/parent".to_owned())
            }
        );
        assert_eq!(plan.strategy, QueryStrategy::Streaming);
    });
}

#[test]
fn only_names_may_filter_or_order_it() {
    let run = |query: Query| {
        let store = Store::new(StoreOptions::default());
        execute_iter(&store.snapshot(), &db(), &query, DatabaseEdition::Standard)
            .map(|_| ())
            .unwrap_err()
    };
    let field = || FieldPath::field(["n"]).unwrap();
    let on_field = |operator| {
        Filter::Field(FieldFilter {
            path: field(),
            operator,
            value: Value::Integer(1),
        })
    };
    assert_eq!(
        run(all().filter(on_field(FieldOperator::Equal))),
        QueryError::KindRequiredForFilter("n".to_owned())
    );
    // An inequality orders by its field, so the order is what is reported.
    assert_eq!(
        run(all().filter(on_field(FieldOperator::GreaterThan))),
        QueryError::KindRequiredForOrder
    );
    assert_eq!(
        run(all().order_by(field(), Direction::Ascending)),
        QueryError::KindRequiredForOrder
    );
    assert_eq!(
        run(all().filter(Filter::And(vec![
            on_name(FieldOperator::GreaterThan, "rd/a"),
            on_field(FieldOperator::Equal),
        ]))),
        QueryError::KindRequiredForFilter("n".to_owned())
    );
    let descending = run(all().order_by(FieldPath::DocumentId, Direction::Descending));
    assert_eq!(descending, QueryError::DescendingKeyScan);
    assert!(descending.is_failed_precondition());
    assert_eq!(
        run(all().filter(Filter::Field(FieldFilter {
            path: FieldPath::DocumentId,
            operator: FieldOperator::GreaterThan,
            value: Value::String("rd".into()),
        }))),
        QueryError::KeyFilterValueNotKey
    );
}

#[test]
fn it_counts_but_sums_nothing() {
    let sum = Aggregation::Sum {
        alias: "s".to_owned(),
        field: FieldPath::field(["n"]).unwrap(),
    };
    let tally = Aggregation::Count {
        alias: "c".to_owned(),
    };
    assert_eq!(
        validate_aggregations(&all(), std::slice::from_ref(&tally)),
        Ok(())
    );
    assert_eq!(
        validate_aggregations(&all(), std::slice::from_ref(&sum)),
        Err(QueryError::KindRequiredForOrder)
    );
    let named = Query::new(QueryScope::collection("c").unwrap());
    assert_eq!(validate_aggregations(&named, &[sum]), Ok(()));
}

#[test]
fn only_a_document_can_be_its_ancestor() {
    assert!(all().under_ancestor("top").is_err());
    assert!(all().under_ancestor("top/parent").is_ok());
    assert!(
        Query::new(QueryScope::collection("c").unwrap())
            .under_ancestor("top/parent")
            .is_err()
    );
}
