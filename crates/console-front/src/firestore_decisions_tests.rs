use std::collections::BTreeMap;
use std::time::Duration;

use firenook_core_store::{DatabaseName, Store, StoreOptions};
use firenook_rules_engine::{Auth, EvaluationRequest, Timestamp};
use firenook_rules_runtime::request_history::RequestHistory;
use firenook_rules_runtime::{Authorization, SnapshotAccess};
use futures_util::StreamExt as _;
use serde_json::{Value, json};
use tokio::sync::watch;

use super::*;
use crate::live::TopicEvent;

const PROJECT: &str = "demo-firestore-decisions";
const RULES: &str = "rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n    match /public/{id} {\n      allow read: if true;\n    }\n    match /users/{uid} {\n      allow read: if request.auth != null && request.auth.uid == uid;\n    }\n  }\n}";

fn database(id: &str) -> DatabaseName {
    DatabaseName::new(PROJECT, id).expect("database")
}

fn get(database: &str, path: &str) -> EvaluationRequest {
    EvaluationRequest::new(
        RequestOperation::Get,
        format!("/databases/{database}/documents/{path}"),
        Timestamp::new(1_788_200_100, 0),
    )
}

fn user(uid: &str) -> Authorization {
    Authorization::Client(Some(Auth {
        uid: Some(uid.to_owned()),
        token: BTreeMap::new(),
    }))
}

struct Fixture {
    rules: RulesRuntime,
    feed: DecisionFeed,
    store: Store,
    _stop: watch::Sender<bool>,
}

fn fixture() -> Fixture {
    let rules = RulesRuntime::with_request_history(RequestHistory::default());
    rules.install_default(RULES).expect("install");
    let (stop, shutdown) = watch::channel(false);
    let feed = DecisionFeed::start(
        &rules,
        &RingBudget::new(64 * 1024 * 1024),
        Shutdown::new(shutdown),
    )
    .expect("diagnostics record decisions");
    Fixture {
        rules,
        feed,
        store: Store::new(StoreOptions::default()),
        _stop: stop,
    }
}

impl Fixture {
    fn read(&self, id: &str, path: &str, who: &Authorization) {
        let access = SnapshotAccess::current(self.store.snapshot(), PROJECT);
        let _ = self
            .rules
            .evaluate(&database(id), who, &get(id, path), &access);
    }

    /// Waits until the forwarder has put `count` decisions in the ring.
    async fn holding(&self, count: u32) {
        tokio::time::timeout(Duration::from_secs(2), async {
            while self.feed.window().retained < count {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("the forwarder keeps up");
    }
}

/// The next event of `stream` within two seconds.
async fn next(stream: &mut TopicStream) -> TopicEvent {
    tokio::time::timeout(Duration::from_secs(2), stream.next())
        .await
        .expect("an event in time")
        .expect("the stream goes on")
}

fn decisions(event: &TopicEvent) -> Value {
    match event {
        TopicEvent::Event { name, data, .. } => {
            assert_eq!(*name, "decisions");
            serde_json::from_str(data).expect("json")
        }
        other => panic!("not an event: {other:?}"),
    }
}

#[tokio::test]
async fn every_decision_is_summarised_and_the_window_says_what_is_held() {
    let fixture = fixture();
    fixture.read("(default)", "public/p_1", &Authorization::Client(None));
    fixture.read("(default)", "users/u_2", &user("u_1"));
    fixture.holding(2).await;

    let topic = DecisionsTopic(fixture.feed.clone());
    let mut stream = topic.open(&json!({}), None).expect("open");
    let data = decisions(&next(&mut stream).await);
    let items = data["items"].as_array().expect("items");
    assert_eq!(items.len(), 2, "oldest first, both kept");
    assert_eq!(items[0]["path"], "public/p_1");
    assert_eq!(items[0]["outcome"], "allow");
    assert_eq!(items[0]["anonymous"], true);
    assert_eq!(
        items[0]["allows"],
        json!([{ "line": 5, "outcome": "allow" }])
    );
    let denied = &items[1];
    assert_eq!(denied["method"], "get");
    assert_eq!(denied["database"], "(default)");
    assert_eq!(denied["path"], "users/u_2");
    assert_eq!(denied["outcome"], "deny");
    assert_eq!(denied["uid"], "u_1");
    assert_eq!(denied["viaConsole"], false);
    assert_eq!(denied["at"], "2026-08-31T18:15:00Z");
    assert_eq!(denied["allows"], json!([{ "line": 8, "outcome": "deny" }]));
    assert_eq!(
        denied["rulesHash"],
        firenook_rules_runtime::source_hash(RULES)
    );
    // The id is the one the re-run opens.
    let id = denied["id"].as_str().expect("id");
    assert!(fixture.rules.decision(id).is_some());
    assert_eq!(data["window"]["retained"], 2);
    assert_eq!(data["window"]["reRunnable"], 2);
    assert_eq!(data["window"]["since"], "2026-08-31T18:15:00Z");
    assert_eq!(data["window"]["omitted"], 0);
}

#[tokio::test]
async fn the_engine_evaluates_every_parameter_on_the_replay_and_the_live_tail() {
    let fixture = fixture();
    fixture.read("(default)", "users/u_2", &user("u_1"));
    fixture.read("(default)", "users/u_1", &user("u_1"));
    fixture.read("(default)", "users_archive/u_1", &user("u_1"));
    fixture.read("other", "users/u_2", &user("u_1"));
    fixture.read("(default)", "public/p_1", &Authorization::Client(None));
    fixture.holding(5).await;
    let topic = DecisionsTopic(fixture.feed.clone());

    // A path is itself and everything under it, never a longer name.
    let mut users = topic
        .open(&json!({ "database": "(default)", "path": "users" }), None)
        .expect("open");
    let data = decisions(&next(&mut users).await);
    let paths: Vec<&str> = data["items"]
        .as_array()
        .expect("items")
        .iter()
        .map(|item| item["path"].as_str().expect("path"))
        .collect();
    assert_eq!(paths, ["users/u_2", "users/u_1"]);

    // Denials only, one user, one method; the live tail is filtered alike.
    let mut denied = topic
        .open(
            &json!({ "uid": "u_1", "denied": true, "method": "get" }),
            None,
        )
        .expect("open");
    let data = decisions(&next(&mut denied).await);
    let items = data["items"].as_array().expect("items");
    assert!(items.iter().all(|item| item["outcome"] != "allow"));
    assert_eq!(items.len(), 3, "{items:?}");
    fixture.read("(default)", "users/u_9", &user("u_1"));
    fixture.read("(default)", "users/u_1", &user("u_1"));
    let data = decisions(&next(&mut denied).await);
    let items = data["items"].as_array().expect("items");
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["path"], "users/u_9");

    assert!(
        topic.open(&json!({ "bucket": "x" }), None).is_err(),
        "unknown params are refused"
    );
}

#[tokio::test]
async fn a_console_read_says_where_it_entered() {
    let fixture = fixture();
    let console = fixture.rules.with_origin(DenialOrigin::Console);
    let access = SnapshotAccess::current(fixture.store.snapshot(), PROJECT);
    let _ = console.evaluate(
        &database("(default)"),
        &user("u_1"),
        &get("(default)", "users/u_2"),
        &access,
    );
    fixture.holding(1).await;
    let mut stream = DecisionsTopic(fixture.feed.clone())
        .open(&json!({}), None)
        .expect("open");
    let data = decisions(&next(&mut stream).await);
    assert_eq!(data["items"][0]["viaConsole"], true);
}

#[test]
fn without_diagnostics_there_is_no_feed() {
    let rules = RulesRuntime::default();
    let (_stop, shutdown) = watch::channel(false);
    assert!(DecisionFeed::start(&rules, &RingBudget::new(1024), Shutdown::new(shutdown)).is_none());
}

#[test]
fn export_firestore_decision_bindings() {
    let config = ts_rs::Config::new().with_out_dir(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../console/src/api/generated"
    ));
    FirestoreDecisionsParams::export_all(&config).expect("TypeScript bindings written");
    FirestoreDecisionBatch::export_all(&config).expect("TypeScript bindings written");
}
