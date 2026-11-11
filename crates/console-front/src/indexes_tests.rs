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

const EMPTY: &str = r#"{"indexes":[],"fieldOverrides":[]}"#;

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
            Ok(EMPTY.to_owned()),
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

/// A database's index file in a directory of its own, removed afterwards.
struct OnDisk {
    directory: PathBuf,
    file: PathBuf,
    indexes: FirestoreIndexes,
    policy: QueryPolicy,
    said: Arc<std::sync::Mutex<Vec<(String, String)>>>,
}

impl OnDisk {
    /// `source`: the file as the suite read it at start; `None`: not there.
    fn new(name: &str, source: Option<&str>) -> Self {
        let directory =
            std::env::temp_dir().join(format!("firenook-indexes-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&directory);
        std::fs::create_dir_all(&directory).expect("directory");
        let file = directory.join("firestore.indexes.json");
        let read = match source {
            Some(source) => {
                std::fs::write(&file, source).expect("write");
                Ok(source.to_owned())
            }
            None => Err("it could not be read".to_owned()),
        };
        let catalog = source.map_or_else(IndexCatalog::default, |source| {
            IndexCatalog::from_json(source).expect("valid")
        });
        let catalogs = Arc::new(IndexCatalogs::new(
            Arc::default(),
            BTreeMap::from([("(default)".to_owned(), Arc::new(catalog))]),
        ));
        let missing = Arc::new(MissingIndexes::new(None));
        let said = Arc::new(std::sync::Mutex::new(Vec::new()));
        let told = Arc::clone(&said);
        let indexes = FirestoreIndexes::new(
            Arc::clone(&catalogs),
            Arc::clone(&missing),
            true,
            [("(default)".to_owned(), file.clone(), read)],
        )
        .with_saved_report(Arc::new(move |database: &str, line| {
            told.lock().expect("lock").push((database.to_owned(), line));
        }));
        let policy =
            QueryPolicy::new(DatabaseEdition::Standard).with_indexes(catalogs, true, Some(missing));
        Self {
            directory,
            file,
            indexes,
            policy,
            said,
        }
    }

    fn revision(&self) -> Option<String> {
        self.indexes.declared().databases[0].revision.clone()
    }

    fn edit(&self, add: &[JsonValue], remove: &[JsonValue]) -> Result<IndexesEdited, ApiError> {
        self.edit_at(self.revision().as_deref(), add, remove)
    }

    fn edit_at(
        &self,
        revision: Option<&str>,
        add: &[JsonValue],
        remove: &[JsonValue],
    ) -> Result<IndexesEdited, ApiError> {
        let body = json!({
            "revision": revision,
            "add": add.iter().map(|entry| json!({"section": "indexes", "entry": entry})).collect::<Vec<_>>(),
            "remove": remove.iter().map(|entry| json!({"section": "indexes", "entry": entry})).collect::<Vec<_>>(),
        });
        self.indexes
            .edit(&serde_json::from_value(body).expect("a body"))
    }

    fn on_disk(&self) -> String {
        std::fs::read_to_string(&self.file).expect("read")
    }
}

impl Drop for OnDisk {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}

fn orders_entry() -> JsonValue {
    serde_json::from_str::<JsonValue>(DECLARED).expect("json")["indexes"][0].clone()
}

/// What the file declares is listed entry by entry, in the file's order,
/// with the entry as written.
#[tokio::test]
async fn the_declared_list_reads_the_file_in_force() {
    let source = r#"{
  "indexes": [
    {"collectionGroup": "orders", "queryScope": "COLLECTION_GROUP", "fields": [
      {"fieldPath": "status", "order": "ASCENDING"}, {"fieldPath": "tags", "arrayConfig": "CONTAINS"}]}
  ],
  "fieldOverrides": [
    {"collectionGroup": "events", "fieldPath": "expiresAt", "ttl": true, "indexes": []},
    {"collectionGroup": "items", "fieldPath": "a", "indexes": [{"order": "ASCENDING", "queryScope": "COLLECTION_GROUP"}]}
  ]
}"#;
    let disk = OnDisk::new("declared", Some(source));
    let response = disk
        .indexes
        .router()
        .oneshot(
            Request::get("/indexes")
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::OK);
    let body: JsonValue = serde_json::from_slice(
        &to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body"),
    )
    .expect("json");
    assert_eq!(body["strict"], true);
    let database = &body["databases"][0];
    assert_eq!(database["database"], "(default)");
    assert_eq!(database["path"], disk.file.display().to_string());
    assert!(database["problem"].is_null());
    assert_eq!(
        database["revision"],
        firenook_rules_runtime::source_hash(source)
    );
    let index = &database["indexes"][0];
    assert_eq!(index["collectionGroup"], "orders");
    assert_eq!(index["scope"], "collectionGroup");
    assert_eq!(index["fields"][1]["mode"], "arrayContains");
    assert_eq!(index["entry"]["fields"][1]["arrayConfig"], "CONTAINS");
    let ttl = &database["fieldOverrides"][0];
    assert_eq!(ttl["fieldPath"], "expiresAt");
    assert_eq!(ttl["ttl"], true);
    assert_eq!(ttl["indexes"], json!([]));
    assert_eq!(
        database["fieldOverrides"][1]["indexes"],
        json!([{"scope": "collectionGroup", "mode": "ascending", "dimension": null}])
    );
}

/// An index added from the page is written to the file and in force at
/// once, said once in the log; taken out, the file is as it was.
#[tokio::test]
async fn an_edit_writes_the_file_and_puts_it_in_force() {
    let disk = OnDisk::new("edit", Some(EMPTY));
    disk.policy
        .validate("(default)", &query())
        .expect_err("refused: the file declares nothing");
    let edited = disk.edit(&[orders_entry()], &[]).expect("edited");
    assert!(edited.saved);
    assert_eq!((edited.added, edited.removed, edited.unchanged), (1, 0, 0));
    assert_eq!(edited.file.indexes.len(), 1);
    assert_eq!(edited.file.indexes[0].entry, orders_entry());
    disk.policy
        .validate("(default)", &query())
        .expect("answered: the file declares it now");
    let written = disk.on_disk();
    assert_eq!(
        disk.indexes.in_force_hash("(default)"),
        Some(firenook_rules_runtime::source_hash(&written)),
        "what is written is what is in force, so the watcher installs nothing"
    );
    assert_eq!(
        disk.said.lock().expect("lock").as_slice(),
        [(
            "(default)".to_owned(),
            format!(
                "database \"(default)\" indexes saved to {} from the console (1 added)",
                disk.file.display()
            )
        )]
    );

    // Asked again, nothing is written.
    let again = disk.edit(&[orders_entry()], &[]).expect("edited");
    assert!(!again.saved);
    assert_eq!(again.unchanged, 1);
    assert_eq!(disk.said.lock().expect("lock").len(), 1);

    let removed = disk.edit(&[], &[orders_entry()]).expect("edited");
    assert_eq!(removed.removed, 1);
    assert_eq!(disk.on_disk(), EMPTY);
    disk.policy
        .validate("(default)", &query())
        .expect_err("refused again");
}

/// An edit never overwrites a change it has not seen: one the page did not
/// read, or one saved in an editor that the watcher has not put in force.
#[tokio::test]
async fn an_edit_refuses_a_file_changed_since_the_page_read_it() {
    let disk = OnDisk::new("conflict", Some(EMPTY));
    let stale = disk.revision();
    disk.edit(&[orders_entry()], &[]).expect("edited");
    let refused = disk
        .edit_at(stale.as_deref(), &[orders_entry()], &[])
        .expect_err("stale");
    assert_eq!(refused.detail().code, crate::api_error::ErrorCode::Conflict);
    assert_eq!(
        refused.detail().message,
        "firestore.indexes.json changed since this page read it"
    );

    let mine = "{\n  \"indexes\": [],\n  \"fieldOverrides\": []\n}\n";
    std::fs::write(&disk.file, mine).expect("an editor saves");
    let refused = disk.edit(&[], &[orders_entry()]).expect_err("not seen");
    assert_eq!(refused.detail().code, crate::api_error::ErrorCode::Conflict);
    assert_eq!(disk.on_disk(), mine, "the editor's save stands");
}

/// A file that is not valid, a database with no file and an entry that is
/// not an index are refused, and the file is left as it was.
#[tokio::test]
async fn what_cannot_be_edited_is_refused() {
    let disk = OnDisk::new("refused", Some(EMPTY));
    disk.indexes
        .set_file_problem("(default)", Some("invalid index JSON: EOF".to_owned()));
    let refused = disk.edit(&[orders_entry()], &[]).expect_err("not valid");
    assert_eq!(
        refused.detail().code,
        crate::api_error::ErrorCode::FailedPrecondition
    );
    assert_eq!(
        refused.detail().message,
        "firestore.indexes.json is not valid: invalid index JSON: EOF"
    );
    disk.indexes.set_file_problem("(default)", None);

    let elsewhere = serde_json::from_value::<IndexesEditBody>(json!({
        "database": "orders-eu", "revision": null, "add": [{"section": "indexes", "entry": orders_entry()}],
    }))
    .expect("a body");
    let refused = disk.indexes.edit(&elsewhere).expect_err("no file");
    assert_eq!(
        refused.detail().message,
        "firebase.json names no index file for database \"orders-eu\""
    );

    let bad = disk
        .edit(
            &[json!({"collectionGroup": "orders", "fields": [{"fieldPath": "a"}]})],
            &[],
        )
        .expect_err("not an index");
    assert_eq!(
        bad.detail().code,
        crate::api_error::ErrorCode::InvalidArgument
    );
    let section = serde_json::from_value::<IndexesEditBody>(json!({
        "revision": disk.revision(), "add": [{"section": "rules", "entry": {}}],
    }))
    .expect("a body");
    assert!(disk.indexes.edit(&section).is_err());
    assert_eq!(disk.on_disk(), EMPTY);
}

/// A file `firebase.json` names that is not there yet is made by the first
/// index added.
#[tokio::test]
async fn the_first_index_makes_the_file() {
    let disk = OnDisk::new("first", None);
    assert!(!disk.file.exists());
    assert_eq!(disk.revision(), None);
    assert!(disk.indexes.declared().databases[0].problem.is_some());
    let edited = disk.edit(&[orders_entry()], &[]).expect("edited");
    assert!(edited.saved);
    assert!(edited.file.problem.is_none(), "the file is there now");
    assert!(disk.on_disk().starts_with("{\n  \"indexes\": [\n    {\n"));
    disk.policy
        .validate("(default)", &query())
        .expect("answered");
}
