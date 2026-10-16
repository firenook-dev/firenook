//! A plan has to describe the query the engine would actually run. These
//! tests hold `plan` to the iterator that really ran, name each candidate
//! source, and check the index advice against both an empty catalog and a
//! project that declares the index.

use firenook_core_store::{
    DatabaseName, DiskOptions, DocumentKey, Fields, Precondition, Store, StoreOptions, Value, Write,
};

use crate::{
    Direction, FieldFilter, FieldOperator, FieldPath, Filter, IndexCatalog, IndexDirection,
    IndexMode, IndexScope, Limit, Query, QueryCandidates, QueryScope, execute_iter, plan,
};

struct TestDirectory(std::path::PathBuf);

impl TestDirectory {
    fn new() -> Self {
        static SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "firenook-plan-{}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
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
    DatabaseName::new("demo-plan", "(default)").unwrap()
}

fn field(name: &str) -> FieldPath {
    FieldPath::field([name]).unwrap()
}

fn equality(name: &str, value: &str) -> Filter {
    Filter::Field(FieldFilter {
        path: field(name),
        operator: FieldOperator::Equal,
        value: Value::String(value.into()),
    })
}

/// Four documents under `teams/t1/orders`, enough for every candidate source.
fn seed(store: &Store) {
    let writes = (0..4)
        .map(|index| Write::Set {
            key: DocumentKey::new(database(), format!("teams/t1/orders/o{index}")).unwrap(),
            fields: Fields::from([
                ("status".to_owned(), Value::String("open".into())),
                ("total".to_owned(), Value::Integer(i64::from(index))),
            ]),
            transforms: Vec::new(),
            precondition: Precondition::None,
        })
        .collect::<Vec<_>>();
    store.commit(&writes).unwrap();
}

fn orders() -> Query {
    Query::new(QueryScope::collection("teams/t1/orders").unwrap())
}

fn group() -> Query {
    Query::new(QueryScope::collection_group("orders").unwrap())
}

/// Every shape the console can produce from its query line.
fn queries() -> Vec<(&'static str, Query)> {
    vec![
        ("the whole collection", orders()),
        (
            "one equality filter",
            orders().filter(equality("status", "open")),
        ),
        (
            "ordered by a field",
            orders().order_by(field("total"), Direction::Descending),
        ),
        (
            "filtered and ordered",
            orders()
                .filter(equality("status", "open"))
                .order_by(field("total"), Direction::Ascending),
        ),
        ("a first page", orders().limit(Limit::First(2))),
        ("a last page", orders().limit(Limit::Last(2))),
        (
            "named documents",
            orders().filter(Filter::Field(FieldFilter {
                path: FieldPath::DocumentId,
                operator: FieldOperator::In,
                value: Value::Array(vec![
                    Value::Reference(
                        DocumentKey::new(database(), "teams/t1/orders/o1")
                            .unwrap()
                            .to_string()
                            .into(),
                    ),
                    Value::Reference(
                        DocumentKey::new(database(), "teams/t1/orders/o2")
                            .unwrap()
                            .to_string()
                            .into(),
                    ),
                ]),
            })),
        ),
        ("the collection group", group()),
        (
            "the group under one ancestor",
            group().under_ancestor("teams/t1").unwrap(),
        ),
    ]
}

#[test]
fn a_plan_names_the_strategy_the_query_actually_runs_with() {
    let directory = TestDirectory::new();
    let memory = Store::new(StoreOptions::default());
    let disk = Store::open_disk(&directory.0, DiskOptions::default()).unwrap();
    seed(&memory);
    seed(&disk);
    let mut seen = std::collections::BTreeSet::new();
    for (store, backing) in [(&memory, "memory"), (&disk, "disk")] {
        let snapshot = store.snapshot();
        for (name, query) in queries() {
            let planned = plan(&snapshot, &database(), &query).unwrap();
            let actual = execute_iter(
                &snapshot,
                &database(),
                &query,
                crate::DatabaseEdition::Standard,
            )
            .unwrap()
            .strategy();
            assert_eq!(
                planned.strategy, actual,
                "{backing}: the plan for {name} disagrees with the iterator"
            );
            seen.insert(format!("{:?}", planned.strategy));
        }
    }
    // A matrix that only ever produced one strategy would prove nothing.
    assert_eq!(
        seen,
        ["Buffered", "OrderedDisk", "Streaming"]
            .map(str::to_owned)
            .into_iter()
            .collect::<std::collections::BTreeSet<_>>(),
        "the matrix must exercise every strategy"
    );
}

#[test]
fn a_plan_names_where_the_candidates_come_from() {
    let directory = TestDirectory::new();
    let disk = Store::open_disk(&directory.0, DiskOptions::default()).unwrap();
    seed(&disk);
    let snapshot = disk.snapshot();
    let candidates = |query: &Query| plan(&snapshot, &database(), query).unwrap().candidates;

    assert_eq!(
        candidates(&orders()),
        QueryCandidates::CollectionScan,
        "an unfiltered collection reads every document"
    );
    assert_eq!(
        candidates(&orders().filter(equality("status", "open"))),
        QueryCandidates::EqualityIndex {
            fields: vec!["status".to_owned()]
        },
        "an equality filter goes through the field index"
    );
    assert_eq!(
        candidates(&group()),
        QueryCandidates::CollectionGroupScan { ancestor: None }
    );
    assert_eq!(
        candidates(&group().under_ancestor("teams/t1").unwrap()),
        QueryCandidates::CollectionGroupScan {
            ancestor: Some("teams/t1".to_owned())
        }
    );
    let (_, named) = queries()
        .into_iter()
        .find(|(name, _)| *name == "named documents")
        .unwrap();
    assert_eq!(
        candidates(&named),
        QueryCandidates::DocumentNames { names: 2 },
        "pinned names are read directly, not scanned"
    );
}

#[test]
fn a_memory_store_has_no_field_index_to_narrow_with() {
    let memory = Store::new(StoreOptions::default());
    seed(&memory);
    let snapshot = memory.snapshot();
    assert_eq!(
        plan(
            &snapshot,
            &database(),
            &orders().filter(equality("status", "open"))
        )
        .unwrap()
        .candidates,
        QueryCandidates::CollectionScan,
        "without the disk field index the same filter scans"
    );
}

#[test]
fn the_plan_reports_the_scope_and_the_order_the_engine_appends() {
    let memory = Store::new(StoreOptions::default());
    seed(&memory);
    let snapshot = memory.snapshot();
    let planned = plan(
        &snapshot,
        &database(),
        &orders().order_by(field("total"), Direction::Descending),
    )
    .unwrap();
    assert_eq!(planned.target, "teams/t1/orders");
    assert_eq!(planned.scope, IndexScope::Collection);
    assert_eq!(planned.orders.len(), 2, "__name__ is appended: {planned:?}");
    assert_eq!(planned.orders[1].path, FieldPath::DocumentId);
    assert_eq!(planned.orders[1].direction, Direction::Descending);

    let planned = plan(&snapshot, &database(), &group()).unwrap();
    assert_eq!(planned.target, "orders");
    assert_eq!(planned.scope, IndexScope::CollectionGroup);
}

const DECLARED: &str = r#"{
  "indexes": [
    {
      "collectionGroup": "orders",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "status", "order": "ASCENDING" },
        { "fieldPath": "total", "order": "ASCENDING" },
        { "fieldPath": "__name__", "order": "ASCENDING" }
      ]
    }
  ]
}"#;

#[test]
fn advice_names_the_composite_index_production_would_require() {
    let composite = orders()
        .filter(equality("status", "open"))
        .order_by(field("total"), Direction::Ascending);

    let advice = IndexCatalog::default()
        .advise(&composite)
        .expect("a filter plus an order on another field needs a composite index");
    assert!(advice.requirement.is_composite());
    assert!(!advice.declared, "an empty catalog declares nothing");
    assert_eq!(advice.requirement.collection_group, "orders");
    assert_eq!(advice.requirement.query_scope, IndexScope::Collection);
    assert_eq!(
        advice
            .requirement
            .fields
            .iter()
            .map(|field| field.field_path.as_str())
            .collect::<Vec<_>>(),
        ["status", "total"],
        "the requirement spells the index in order: {:?}",
        advice.requirement.fields
    );

    // `DECLARED` spells out the trailing `__name__` the way the Firebase CLI
    // does; the requirement leaves it implicit, and the two must still match.
    let declared = IndexCatalog::from_json(DECLARED).unwrap();
    let advice = declared
        .advise(&composite)
        .expect("the requirement stands whether or not it is declared");
    assert!(
        advice.declared,
        "the project declares this one, so nothing is missing"
    );
}

#[test]
fn a_declared_index_matches_whether_or_not_it_spells_out_the_document_name() {
    let composite = orders()
        .filter(equality("status", "open"))
        .order_by(field("total"), Direction::Ascending);
    let without = r#"{
      "indexes": [
        {
          "collectionGroup": "orders",
          "queryScope": "COLLECTION",
          "fields": [
            { "fieldPath": "status", "order": "ASCENDING" },
            { "fieldPath": "total", "order": "ASCENDING" }
          ]
        }
      ]
    }"#;
    for (shape, source) in [("implicit", without), ("explicit", DECLARED)] {
        assert!(
            IndexCatalog::from_json(source)
                .unwrap()
                .advise(&composite)
                .unwrap()
                .declared,
            "an index declared with an {shape} document name serves the query"
        );
    }
    // A `__name__` pointing the other way is a different index, not noise.
    let opposite = r#"{
      "indexes": [
        {
          "collectionGroup": "orders",
          "queryScope": "COLLECTION",
          "fields": [
            { "fieldPath": "status", "order": "ASCENDING" },
            { "fieldPath": "total", "order": "ASCENDING" },
            { "fieldPath": "__name__", "order": "DESCENDING" }
          ]
        }
      ]
    }"#;
    assert!(
        !IndexCatalog::from_json(opposite)
            .unwrap()
            .advise(&composite)
            .unwrap()
            .declared,
        "a descending document name is a different index and must not count"
    );
}

#[test]
fn advice_is_silent_where_production_indexes_itself() {
    // Single-field indexes inside one collection are automatic in production.
    assert!(
        IndexCatalog::default()
            .advise(&orders().filter(equality("status", "open")))
            .is_none()
    );
    assert!(IndexCatalog::default().advise(&orders()).is_none());
    assert!(
        IndexCatalog::default()
            .advise(&orders().order_by(field("total"), Direction::Ascending))
            .is_none()
    );
}

#[test]
fn a_collection_group_needs_its_single_field_index_declared() {
    let advice = IndexCatalog::default()
        .advise(&group().filter(equality("status", "open")))
        .expect("collection-group indexes are never automatic");
    assert_eq!(advice.requirement.query_scope, IndexScope::CollectionGroup);
    assert!(!advice.declared);
    assert!(
        !advice.requirement.is_composite(),
        "one field is not composite"
    );
}

#[test]
fn a_requirement_renders_the_entry_for_the_index_file() {
    let advice = IndexCatalog::default()
        .advise(
            &orders()
                .filter(equality("status", "open"))
                .order_by(field("total"), Direction::Descending),
        )
        .unwrap();
    let entry = advice.requirement.config_entry();
    assert_eq!(entry["collectionGroup"], "orders");
    assert_eq!(entry["queryScope"], "COLLECTION");
    assert_eq!(entry["fields"][0]["fieldPath"], "status");
    assert_eq!(entry["fields"][0]["order"], "ASCENDING");
    assert_eq!(entry["fields"][1]["order"], "DESCENDING");
    // The rendered entry is what the Firebase CLI reads, so the catalog
    // parsed from it must declare exactly this query.
    let file = serde_json::json!({ "indexes": [entry] }).to_string();
    let catalog = IndexCatalog::from_json(&file).unwrap();
    assert!(
        catalog
            .advise(
                &orders()
                    .filter(equality("status", "open"))
                    .order_by(field("total"), Direction::Descending)
            )
            .unwrap()
            .declared,
        "the entry we tell people to paste has to be the one that satisfies the query"
    );
}

#[test]
fn array_and_vector_fields_render_their_own_config_shapes() {
    use crate::{IndexRequirement, IndexRequirementField};
    let requirement = IndexRequirement {
        collection_group: "posts".to_owned(),
        query_scope: IndexScope::Collection,
        fields: vec![
            IndexRequirementField {
                field_path: "tags".to_owned(),
                mode: IndexMode::ArrayContains,
            },
            IndexRequirementField {
                field_path: "embedding".to_owned(),
                mode: IndexMode::Vector(3),
            },
            IndexRequirementField {
                field_path: "rank".to_owned(),
                mode: IndexMode::Ordered(IndexDirection::Descending),
            },
        ],
    };
    let entry = requirement.config_entry();
    assert_eq!(entry["fields"][0]["arrayConfig"], "CONTAINS");
    assert_eq!(entry["fields"][1]["vectorConfig"]["dimension"], 3);
    assert!(entry["fields"][1]["vectorConfig"]["flat"].is_object());
    assert_eq!(entry["fields"][2]["order"], "DESCENDING");
}
