use super::*;
use firenook_core_store::{Precondition, Store, StoreOptions, Value, Write};
use firenook_query_engine::{FieldPath, Limit};

fn database() -> DatabaseName {
    DatabaseName::new("demo", "(default)").unwrap()
}

fn key(path: &str) -> DocumentKey {
    DocumentKey::new(database(), path).unwrap()
}

fn write(store: &Store, path: &str, value: i64) {
    store
        .commit(&[Write::Set {
            key: key(path),
            fields: BTreeMap::from([("value".into(), Value::Integer(value))]),
            transforms: Vec::new(),
            precondition: Precondition::None,
        }])
        .unwrap();
}

fn target(store: &Store, spec: TargetSpec) -> WatchTarget {
    WatchTarget::initialize(
        1,
        database(),
        spec,
        DatabaseEdition::Standard,
        &store.snapshot(),
    )
    .unwrap()
    .0
}

fn query(collection: &str) -> TargetSpec {
    TargetSpec::Query(Box::new(Query::new(
        QueryScope::collection(collection).unwrap(),
    )))
}

#[test]
fn unrelated_changes_preserve_result_map_without_reconstruction() {
    // Matches the official oracle: initial colors, unrelated commits, then a
    // matching update and delete. Node identity adds an internal efficiency
    // assertion, not an invented observable wire requirement.
    let store = Store::default();
    write(&store, "colors/seed", 0);
    let mut target = target(&store, query("colors"));
    let old_node = std::ptr::from_ref(&target.documents[&key("colors/seed")]);
    let usage = target.logical_memory_usage();
    for value in 0..3 {
        let after = target.revision();
        write(&store, "unrelated/seed", value);
        let changes = store.changes_since(after).unwrap();
        let batch = target
            .refresh_with_changes(&store.snapshot(), Some(&changes))
            .unwrap();
        assert!(batch.changes.is_empty());
        assert_eq!(target.revision(), store.revision());
        assert_eq!(target.logical_memory_usage(), usage);
        assert_eq!(
            old_node,
            std::ptr::from_ref(&target.documents[&key("colors/seed")])
        );
    }
    let after = target.revision();
    write(&store, "colors/seed", 1);
    let changes = store.changes_since(after).unwrap();
    let batch = target
        .refresh_with_changes(&store.snapshot(), Some(&changes))
        .unwrap();
    assert_eq!(batch.changes.len(), 1);
    assert_eq!(batch.changes[0].kind, ChangeKind::Upsert);
    let after = target.revision();
    store
        .commit(&[Write::Delete {
            key: key("colors/seed"),
            precondition: Precondition::None,
        }])
        .unwrap();
    let changes = store.changes_since(after).unwrap();
    let batch = target
        .refresh_with_changes(&store.snapshot(), Some(&changes))
        .unwrap();
    assert_eq!(batch.changes.len(), 1);
    assert_eq!(batch.changes[0].kind, ChangeKind::Delete);
}

#[test]
fn absent_history_falls_back_to_full_evaluation() {
    let store = Store::default();
    write(&store, "colors/seed", 0);
    let mut target = target(&store, query("colors"));
    write(&store, "colors/seed", 1);
    let batch = target
        .refresh_with_changes(&store.snapshot(), None)
        .unwrap();
    assert_eq!(batch.changes.len(), 1);
    assert_eq!(
        target.documents[&key("colors/seed")].fields()["value"],
        Value::Integer(1)
    );
}

#[test]
fn expired_retained_history_cannot_hide_a_matching_change() {
    let store = Store::new(StoreOptions {
        max_change_log_entries: 1,
        ..StoreOptions::default()
    });
    write(&store, "colors/seed", 0);
    let mut target = target(&store, query("colors"));
    let after = target.revision();
    write(&store, "colors/seed", 1);
    write(&store, "unrelated/seed", 0);
    let history = store.changes_since(after).ok();
    assert!(history.is_none());
    let batch = target
        .refresh_with_changes(&store.snapshot(), history.as_deref())
        .unwrap();
    assert_eq!(batch.changes.len(), 1);
    assert_eq!(target.revision(), store.revision());
}

#[test]
fn captured_snapshot_never_skips_future_matching_commit() {
    let store = Store::default();
    write(&store, "colors/seed", 0);
    let mut target = target(&store, query("colors"));
    let after = target.revision();
    write(&store, "unrelated/seed", 0);
    let captured = store.snapshot();
    write(&store, "colors/seed", 1);
    let history = store.changes_since(after).unwrap();
    assert!(
        target
            .refresh_with_changes(&captured, Some(&history))
            .unwrap()
            .changes
            .is_empty()
    );
    assert_eq!(target.revision(), captured.revision());
    assert_eq!(
        target.documents[&key("colors/seed")].fields()["value"],
        Value::Integer(0)
    );
    let batch = target
        .refresh_with_changes(&store.snapshot(), Some(&history))
        .unwrap();
    assert_eq!(batch.changes.len(), 1);
    assert_eq!(
        target.documents[&key("colors/seed")].fields()["value"],
        Value::Integer(1)
    );
}

#[test]
fn scope_checks_are_conservative_for_nested_groups_documents_and_databases() {
    let store = Store::default();
    let collection = target(&store, query("parents/p/colors"));
    assert!(collection.contains_scope_key(&key("parents/p/colors/a")));
    assert!(!collection.contains_scope_key(&key("parents/p/colors/a/nested/b")));
    assert!(!collection.contains_scope_key(&key("parents/q/colors/a")));
    let group = target(
        &store,
        TargetSpec::Query(Box::new(Query::new(
            QueryScope::collection_group("colors").unwrap(),
        ))),
    );
    assert!(group.contains_scope_key(&key("colors/a")));
    assert!(group.contains_scope_key(&key("parents/p/colors/a")));
    assert!(!group.contains_scope_key(&key("colors/a/nested/b")));
    let other =
        DocumentKey::new(DatabaseName::new("other", "(default)").unwrap(), "colors/a").unwrap();
    assert!(!group.contains_scope_key(&other));
    let documents = target(
        &store,
        TargetSpec::Documents(BTreeSet::from([key("colors/missing")])),
    );
    assert!(documents.contains_scope_key(&key("colors/missing")));
    assert!(!documents.contains_scope_key(&key("colors/another")));
}

#[test]
fn matching_scope_still_reevaluates_limit_and_projection() {
    let store = Store::default();
    write(&store, "colors/b", 1);
    let query = Query::new(QueryScope::collection("colors").unwrap())
        .limit(Limit::First(1))
        .select(vec![FieldPath::field(["value"]).unwrap()]);
    let mut target = target(&store, TargetSpec::Query(Box::new(query)));
    let after = target.revision();
    write(&store, "colors/a", 2);
    let changes = store.changes_since(after).unwrap();
    let batch = target
        .refresh_with_changes(&store.snapshot(), Some(&changes))
        .unwrap();
    assert_eq!(batch.changes.len(), 2);
    assert_eq!(
        target.document_keys().cloned().collect::<Vec<_>>(),
        vec![key("colors/a")]
    );
}

/// Deterministic xorshift so a failure reproduces exactly.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }

    fn below(&mut self, bound: u64) -> u64 {
        self.next() % bound
    }

    fn value(&mut self) -> i64 {
        i64::try_from(self.below(10)).expect("small value")
    }

    fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        let index = usize::try_from(self.below(items.len() as u64)).expect("small index");
        &items[index]
    }
}

fn set_document(store: &Store, path: &str, value: i64, group: &str) {
    store
        .commit(&[Write::Set {
            key: key(path),
            fields: BTreeMap::from([
                ("value".into(), Value::Integer(value)),
                ("group".into(), Value::String(group.into())),
            ]),
            transforms: Vec::new(),
            precondition: Precondition::None,
        }])
        .unwrap();
}

fn delete_document(store: &Store, path: &str) {
    store
        .commit(&[Write::Delete {
            key: key(path),
            precondition: Precondition::None,
        }])
        .unwrap();
}

fn query_shapes() -> Vec<(&'static str, Query)> {
    let value = FieldPath::field(["value"]).unwrap();
    let group = FieldPath::field(["group"]).unwrap();
    let base = || Query::new(QueryScope::collection("items").unwrap());
    vec![
        ("plain", base()),
        ("limit 3", base().limit(Limit::First(3))),
        ("limit 1", base().limit(Limit::First(1))),
        (
            "order value desc limit 4",
            base()
                .order_by(value.clone(), firenook_query_engine::Direction::Descending)
                .limit(Limit::First(4)),
        ),
        (
            "order value asc",
            base().order_by(value.clone(), firenook_query_engine::Direction::Ascending),
        ),
        (
            "filter group == a",
            base().filter(firenook_query_engine::Filter::Field(
                firenook_query_engine::FieldFilter {
                    path: group.clone(),
                    operator: firenook_query_engine::FieldOperator::Equal,
                    value: Value::String("a".into()),
                },
            )),
        ),
        (
            "filter group == a limit 2 order value desc",
            base()
                .filter(firenook_query_engine::Filter::Field(
                    firenook_query_engine::FieldFilter {
                        path: group.clone(),
                        operator: firenook_query_engine::FieldOperator::Equal,
                        value: Value::String("a".into()),
                    },
                ))
                .order_by(value.clone(), firenook_query_engine::Direction::Descending)
                .limit(Limit::First(2)),
        ),
        (
            "value > 3 order value limit 3 select group",
            base()
                .filter(firenook_query_engine::Filter::Field(
                    firenook_query_engine::FieldFilter {
                        path: value.clone(),
                        operator: firenook_query_engine::FieldOperator::GreaterThan,
                        value: Value::Integer(3),
                    },
                ))
                .order_by(value.clone(), firenook_query_engine::Direction::Ascending)
                .limit(Limit::First(3))
                .select(vec![group.clone()]),
        ),
        (
            "start after value 2 limit 3",
            base()
                .order_by(value.clone(), firenook_query_engine::Direction::Ascending)
                .start_after(vec![Value::Integer(2)])
                .limit(Limit::First(3)),
        ),
        (
            "offset 1 limit 2 (full refresh)",
            base().offset(1).limit(Limit::First(2)),
        ),
        (
            "limit to last 2 (full refresh)",
            base().limit(Limit::Last(2)),
        ),
        (
            "group items/*/sub",
            Query::new(QueryScope::collection_group("sub").unwrap()).limit(Limit::First(3)),
        ),
    ]
}

fn assert_view_matches_full_evaluation(
    label: &str,
    step: usize,
    target: &WatchTarget,
    store: &Store,
    spec: &TargetSpec,
) {
    let fresh = WatchTarget::initialize(
        1,
        database(),
        spec.clone(),
        DatabaseEdition::Standard,
        &store.snapshot(),
    )
    .unwrap()
    .0;
    assert_eq!(
        target.documents.keys().collect::<Vec<_>>(),
        fresh.documents.keys().collect::<Vec<_>>(),
        "{label} step {step}: visible keys diverged from a full evaluation"
    );
    for (key, document) in &target.documents {
        assert!(
            fresh.documents.get(key) == Some(document),
            "{label} step {step}: {} diverged in content or projection",
            key.path()
        );
    }
    assert_eq!(
        target.order_keys.keys().collect::<Vec<_>>(),
        fresh.order_keys.keys().collect::<Vec<_>>(),
        "{label} step {step}: cached sort keys must cover exactly the view"
    );
    assert_eq!(target.revision(), store.revision());
}

fn run_incremental_property(store: &Store, seed: u64) {
    let mut rng = Rng(seed);
    let paths = [
        "items/a", "items/b", "items/c", "items/d", "items/e", "items/f", "items/g",
    ];
    let sub_paths = ["items/a/sub/x", "items/b/sub/y", "other/z/sub/w"];
    for path in paths {
        let value = rng.value();
        set_document(
            store,
            path,
            value,
            if rng.below(2) == 0 { "a" } else { "b" },
        );
    }
    for (label, query) in query_shapes() {
        let spec = TargetSpec::Query(Box::new(query));
        let mut target = target(store, spec.clone());
        let mut view_from_changes = target.documents.clone();
        for step in 0..60 {
            let after = target.revision();
            // A few commits per step, sometimes touching several keys.
            for _ in 0..=rng.below(3) {
                let roll = rng.below(10);
                if roll < 6 {
                    let path = rng.pick(&paths);
                    let group = if rng.below(2) == 0 { "a" } else { "b" };
                    let value = rng.value();
                    set_document(store, path, value, group);
                } else if roll < 8 {
                    let path = rng.pick(&paths);
                    delete_document(store, path);
                } else {
                    let path = rng.pick(&sub_paths);
                    let value = rng.value();
                    set_document(store, path, value, "a");
                }
            }
            let changes = store.changes_since(after).unwrap();
            let batch = target
                .refresh_with_changes(&store.snapshot(), Some(&changes))
                .unwrap();
            // The emitted changes, applied to the previous view, must produce
            // the new view: that is what a client does with them.
            for change in &batch.changes {
                match change.kind {
                    ChangeKind::Upsert => {
                        view_from_changes.insert(
                            change.key.clone(),
                            change.document.clone().expect("upsert carries a document"),
                        );
                    }
                    ChangeKind::Remove | ChangeKind::Delete => {
                        assert!(
                            view_from_changes.remove(&change.key).is_some(),
                            "{label} step {step}: removed {} was not visible",
                            change.key.path()
                        );
                    }
                }
            }
            assert_eq!(
                view_from_changes.keys().collect::<Vec<_>>(),
                target.documents.keys().collect::<Vec<_>>(),
                "{label} step {step}: replayed changes diverged from the view"
            );
            assert_view_matches_full_evaluation(label, step, &target, store, &spec);
        }
    }
}

#[test]
fn incremental_views_always_equal_a_full_evaluation_on_both_backends() {
    for seed in [0x9E37_79B9_7F4A_7C15_u64, 42, 7_777_777] {
        run_incremental_property(&Store::default(), seed);
        let directory = std::env::temp_dir().join(format!(
            "firenook-watch-incremental-{}-{seed}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&directory);
        let disk = Store::open_disk(&directory, firenook_core_store::DiskOptions::default())
            .expect("disk store");
        run_incremental_property(&disk, seed);
        drop(disk);
        let _ = std::fs::remove_dir_all(&directory);
    }
}
