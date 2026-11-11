use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode};
use firenook_core_store::Value;
use firenook_query_engine::{
    DatabaseEdition, FieldFilter, FieldPath, Filter, Query, QueryPolicy, QueryScope,
};
use serde_json::{Value as JsonValue, json};
use tower::ServiceExt as _;

use super::*;

const DECLARED: &str = r#"{"indexes":[{"collectionGroup":"orders","queryScope":"COLLECTION","fields":[
    {"fieldPath":"status","order":"ASCENDING"},{"fieldPath":"total","order":"DESCENDING"}]}]}"#;

struct Fixture {
    indexes: FirestoreIndexes,
    policy: QueryPolicy,
}

fn fixture(strict: bool) -> Fixture {
    let catalogs = Arc::new(IndexCatalogs::new(
        Arc::default(),
        BTreeMap::from([("(default)".to_owned(), Arc::default())]),
    ));
    let missing = Arc::new(MissingIndexes::new(None));
    let indexes = FirestoreIndexes::new(
        Arc::clone(&catalogs),
        Arc::clone(&missing),
        strict,
        [(
            "(default)".to_owned(),
            PathBuf::from("firestore.indexes.json"),
            None,
        )],
    );
    let policy =
        QueryPolicy::new(DatabaseEdition::Standard).with_indexes(catalogs, strict, Some(missing));
    Fixture { indexes, policy }
}

/// `users/u1/orders` where `status in [...]`, `owner == ...`, ordered by
/// `total` descending.
fn query() -> Query {
    let filter = |name: &str, operator| {
        Filter::Field(FieldFilter {
            path: FieldPath::field([name]).expect("field"),
            operator,
            value: Value::Integer(1),
        })
    };
    Query::new(QueryScope::collection("users/u1/orders").expect("scope"))
        .filter(filter("status", FieldOperator::Equal))
        .order_by(
            FieldPath::field(["total"]).expect("field"),
            Direction::Descending,
        )
}

async fn get(indexes: &FirestoreIndexes) -> (StatusCode, JsonValue) {
    let response = indexes
        .router()
        .oneshot(
            Request::get("/indexes/missing")
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body");
    (status, serde_json::from_slice(&bytes).expect("json"))
}

#[tokio::test]
async fn the_list_names_the_index_the_query_and_the_entry_to_add() {
    let fixture = fixture(false);
    for _ in 0..2 {
        fixture
            .policy
            .validate("(default)", &query())
            .expect("answered");
    }
    let (status, body) = get(&fixture.indexes).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["strict"], false);
    assert_eq!(body["unlisted"], 0);
    assert_eq!(
        body["files"],
        json!([{"database": "(default)", "path": "firestore.indexes.json", "problem": null}])
    );
    let item = &body["indexes"][0];
    assert_eq!(item["database"], "(default)");
    assert_eq!(item["collectionGroup"], "orders");
    assert_eq!(item["scope"], "collection");
    assert_eq!(item["composite"], true);
    assert_eq!(item["section"], "indexes");
    assert_eq!(item["queries"], 2);
    assert_eq!(item["declared"], false);
    assert_eq!(
        item["fields"],
        json!([
            {"fieldPath": "status", "mode": "ascending", "dimension": null},
            {"fieldPath": "total", "mode": "descending", "dimension": null},
        ])
    );
    assert_eq!(
        item["query"],
        json!({
            "target": "users/u1/orders",
            "collectionGroup": false,
            "filters": [{"field": "status", "op": "=="}],
            "disjunction": false,
            "orders": [{"field": "total", "descending": true}],
        })
    );
    assert!(
        item["firstSeen"]
            .as_str()
            .is_some_and(|time| time.ends_with('Z'))
    );
    // What we tell people to add has to be what the engine accepts.
    let file = json!({ "indexes": [item["entry"].clone()] }).to_string();
    let catalog = IndexCatalog::from_json(&file).expect("the entry is a valid index file");
    assert!(
        catalog
            .advise(&query())
            .is_some_and(|advice| advice.declared),
        "declaring the entry serves the query"
    );
}

#[tokio::test]
async fn a_saved_file_that_declares_it_takes_effect_at_once() {
    let fixture = fixture(true);
    fixture
        .policy
        .validate("(default)", &query())
        .expect_err("refused under --strict-indexes");
    fixture
        .indexes
        .install("(default)", DECLARED)
        .expect("a valid file");
    fixture
        .policy
        .validate("(default)", &query())
        .expect("answered with no restart");
    let (_, body) = get(&fixture.indexes).await;
    assert_eq!(body["strict"], true);
    assert_eq!(body["indexes"][0]["declared"], true);
}

#[tokio::test]
async fn a_file_that_is_not_valid_changes_nothing_and_its_problem_is_shown() {
    let fixture = fixture(false);
    let error = fixture
        .indexes
        .install("(default)", "{\"indexes\": [")
        .expect_err("not valid");
    assert!(error.starts_with("invalid index JSON"), "{error}");
    fixture
        .indexes
        .set_file_problem("(default)", Some(error.clone()));
    let (_, body) = get(&fixture.indexes).await;
    assert_eq!(body["files"][0]["problem"], error);
    fixture.indexes.set_file_problem("(default)", None);
    let (_, body) = get(&fixture.indexes).await;
    assert!(body["files"][0]["problem"].is_null());
}

/// The topic's next event's name, or `None` when 10 s pass without one.
async fn next(stream: &mut TopicStream) -> Option<&'static str> {
    match tokio::time::timeout(Duration::from_secs(10), stream.next()).await {
        Ok(Some(TopicEvent::Event { name, .. })) => Some(name),
        Ok(_) => panic!("the topic ended"),
        Err(_) => None,
    }
}

#[tokio::test(start_paused = true)]
async fn the_topic_says_a_new_index_at_once_and_counts_at_most_every_two_seconds() {
    let fixture = fixture(false);
    let mut stream = fixture
        .indexes
        .topic()
        .open(&json!({}), None)
        .expect("opens");
    fixture
        .policy
        .validate("(default)", &query())
        .expect("answered");
    let started = Instant::now();
    assert_eq!(next(&mut stream).await, Some("changed"));
    assert!(started.elapsed() < Duration::from_millis(10), "at once");
    for _ in 0..50 {
        fixture
            .policy
            .validate("(default)", &query())
            .expect("answered");
    }
    let started = Instant::now();
    assert_eq!(next(&mut stream).await, Some("changed"));
    assert!(
        started.elapsed() + Duration::from_millis(10) >= COUNTS_EVERY,
        "50 counts wait out the interval, once: {:?}",
        started.elapsed()
    );
    // Nothing more until something moves.
    assert_eq!(next(&mut stream).await, None);
    // A saved file that declares it is told at once again.
    fixture
        .indexes
        .install("(default)", DECLARED)
        .expect("a valid file");
    let started = Instant::now();
    assert_eq!(next(&mut stream).await, Some("changed"));
    assert!(started.elapsed() < Duration::from_millis(10));
}
