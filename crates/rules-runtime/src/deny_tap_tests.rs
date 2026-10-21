use std::collections::BTreeMap;

use firenook_core_store::{
    DocumentKey, Fields, Precondition, Store, StoreOptions, Timestamp as StoreTimestamp, Value,
    Write,
};
use firenook_query_engine::{Query, QueryScope as Scope};
use firenook_rules_engine::{Auth, Timestamp};
use serde_json::Value as Json;
use tokio::sync::broadcast::error::TryRecvError;

use super::*;
use crate::request_history::RequestHistory;
use crate::{Authorization, SnapshotAccess, evaluation_request, query_candidate, query_policy};

const PROJECT: &str = "demo-denials";
const DENY: &str = "rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /{document=**} { allow read, write: if false; } } }";
const ALLOW: &str = "rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /{document=**} { allow read, write: if true; } } }";
const MIXED: &str = "rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /public/{id} { allow read: if true; } match /private/{id} { allow read: if false; } } }";
/// `resource` is null for a document that does not exist, so reading its
/// data fails instead of denying.
const FAILING: &str = "rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /{document=**} { allow read: if resource.data.owner == 'nobody'; } } }";

fn database() -> DatabaseName {
    DatabaseName::new(PROJECT, "(default)").expect("database")
}

fn key(path: &str) -> DocumentKey {
    DocumentKey::new(database(), path).expect("key")
}

fn user(uid: &str) -> Authorization {
    Authorization::Client(Some(Auth {
        uid: Some(uid.to_owned()),
        token: BTreeMap::new(),
    }))
}

fn get(path: &str) -> EvaluationRequest {
    EvaluationRequest::new(
        RequestOperation::Get,
        format!("/databases/(default)/documents/{path}"),
        Timestamp::new(1_788_200_100, 0),
    )
}

fn time() -> StoreTimestamp {
    StoreTimestamp::new(1_788_200_100, 0).expect("time")
}

/// A list request built the way the fronts build one from a decoded query.
fn list(query: &Query) -> EvaluationRequest {
    let candidate = query_candidate(&database(), query).expect("candidate");
    evaluation_request(
        RequestOperation::List,
        &candidate,
        time(),
        None,
        None,
        query_policy(query),
    )
}

fn access() -> SnapshotAccess {
    SnapshotAccess::current(Store::new(StoreOptions::default()).snapshot(), PROJECT)
}

fn drain(denials: &mut broadcast::Receiver<Arc<Denial>>) -> Vec<Arc<Denial>> {
    std::iter::from_fn(|| denials.try_recv().ok()).collect()
}

fn built(runtime: &RulesRuntime) -> usize {
    runtime.tap.built.load(Ordering::Relaxed)
}

async fn history_events(history: &RequestHistory) -> Vec<Json> {
    let mut subscription = history.subscribe().expect("subscribe");
    let frame = subscription.recv().await.expect("history");
    let events: Json = serde_json::from_str(frame.text()).expect("json");
    events.as_array().expect("array").clone()
}

#[tokio::test]
async fn a_refused_read_sends_one_denial_naming_the_recorded_decision() {
    let history = RequestHistory::default();
    let runtime = RulesRuntime::with_request_history(history.clone());
    runtime.install_default(DENY).expect("install");
    let mut denials = runtime.subscribe_denials();

    let result = runtime.evaluate(
        &database(),
        &user("u_9f3k2"),
        &get("users/u_2fc4c"),
        &access(),
    );
    assert!(!result.allowed);

    let received = drain(&mut denials);
    assert_eq!(received.len(), 1, "exactly one denial per refusal");
    let events = history_events(&history).await;
    let id = events[0]["requestId"].as_str().expect("request id");
    assert_eq!(
        *received[0],
        Denial {
            database: database(),
            operation: RequestOperation::Get,
            path: "/databases/(default)/documents/users/u_2fc4c".to_owned(),
            uid: Some("u_9f3k2".to_owned()),
            error: None,
            refused_by: vec![RefusingAllow {
                line: 1,
                operation: RequestOperation::Get,
                error: None,
            }],
            request_id: Some(Arc::from(id)),
            origin: DenialOrigin::App,
        }
    );
    assert_eq!(received[0].relative_path(), "users/u_2fc4c");
    assert!(
        runtime.decision(id).is_some(),
        "the id opens the retained decision"
    );
}

#[test]
fn without_diagnostics_a_denial_names_no_decision_and_says_why_the_rules_failed() {
    let runtime = RulesRuntime::default();
    runtime.install_default(FAILING).expect("install");
    let mut denials = runtime.subscribe_denials();
    let result = runtime.evaluate(
        &database(),
        &Authorization::Client(None),
        &get("users/u_1"),
        &access(),
    );
    assert!(!result.allowed);

    let received = drain(&mut denials);
    assert_eq!(received.len(), 1);
    let denial = &received[0];
    assert_eq!(denial.uid, None, "an unauthenticated client");
    assert_eq!(denial.request_id, None, "diagnostics are off");
    assert_eq!(
        denial.error,
        result.error.map(|error| error.message),
        "the evaluation error, as the front reports it"
    );
    assert!(denial.error.is_some());
}

#[test]
fn allowed_owner_and_open_mode_requests_send_nothing() {
    let runtime = RulesRuntime::default();
    let mut denials = runtime.subscribe_denials();
    let reads = [get("users/u_1"), get("users/u_2")];

    // No rules at all: the open-with-warning mode allows everything.
    let _ = runtime.evaluate(&database(), &user("u_1"), &reads[0], &access());
    runtime.install_default(ALLOW).expect("allow");
    let _ = runtime.evaluate(&database(), &user("u_1"), &reads[0], &access());
    let _ = runtime.evaluate_atomic(&database(), &user("u_1"), &reads, &access());
    // The owner bypasses rules that deny everything.
    runtime.install_default(DENY).expect("deny");
    let _ = runtime.evaluate(&database(), &Authorization::Owner, &reads[0], &access());
    let _ = runtime.evaluate_atomic(&database(), &Authorization::Owner, &reads, &access());

    assert_eq!(denials.try_recv(), Err(TryRecvError::Empty));
    assert_eq!(built(&runtime), 0);
}

#[test]
fn nothing_is_built_while_nobody_listens() {
    let runtime = RulesRuntime::default();
    runtime.install_default(DENY).expect("install");
    let refuse = |runtime: &RulesRuntime| {
        let _ = runtime.evaluate(&database(), &user("u_1"), &get("users/u_1"), &access());
        let _ = runtime.evaluate_atomic(
            &database(),
            &user("u_1"),
            &[get("users/u_1"), get("users/u_2")],
            &access(),
        );
    };

    refuse(&runtime);
    assert_eq!(built(&runtime), 0, "nothing ever subscribed");
    drop(runtime.subscribe_denials());
    refuse(&runtime);
    assert_eq!(built(&runtime), 0, "every subscriber has gone");

    let mut denials = runtime.subscribe_denials();
    refuse(&runtime);
    assert_eq!(built(&runtime), 3);
    assert_eq!(drain(&mut denials).len(), 3);
}

#[test]
fn the_atomic_path_sends_one_denial_per_refused_operation() {
    for runtime in [
        RulesRuntime::default(),
        RulesRuntime::with_request_history(RequestHistory::default()),
    ] {
        runtime.install_default(MIXED).expect("install");
        let mut denials = runtime.subscribe_denials();
        let result = runtime.evaluate_atomic_with_read_transaction(
            &database(),
            &user("u_1"),
            &[get("public/a"), get("private/b"), get("private/c")],
            &access(),
            true,
        );
        assert!(!result.allowed);

        let received = drain(&mut denials);
        assert_eq!(
            received
                .iter()
                .map(|denial| denial.relative_path())
                .collect::<Vec<_>>(),
            ["private/b", "private/c"]
        );
        let ids = received
            .iter()
            .map(|denial| denial.request_id.clone())
            .collect::<Vec<_>>();
        if runtime.retains_decisions() {
            assert!(ids.iter().all(Option::is_some), "{ids:?}");
            assert_ne!(ids[0], ids[1], "each operation is its own decision");
            for denial in &received {
                let id = denial.request_id.as_deref().expect("kept");
                assert_eq!(
                    runtime.decision(id).expect("retained").request().path,
                    denial.path,
                    "the id opens this operation's decision"
                );
            }
        } else {
            assert!(ids.iter().all(Option::is_none), "{ids:?}");
        }
    }
}

#[test]
fn refused_writes_name_their_operation() {
    let store = Store::new(StoreOptions::default());
    let fields = Fields::from([("value".to_owned(), Value::Integer(1))]);
    store
        .commit(&[
            Write::Create {
                key: key("items/existing"),
                fields: fields.clone(),
            },
            Write::Create {
                key: key("items/doomed"),
                fields: fields.clone(),
            },
        ])
        .expect("seed");
    let runtime = RulesRuntime::default();
    runtime.install_default(DENY).expect("install");
    let mut denials = runtime.subscribe_denials();

    let verdict = runtime
        .evaluate_writes(
            &database(),
            &user("u_1"),
            &[
                Write::Set {
                    key: key("items/existing"),
                    fields: fields.clone(),
                    transforms: Vec::new(),
                    precondition: Precondition::None,
                },
                Write::Create {
                    key: key("items/new"),
                    fields,
                },
                Write::Delete {
                    key: key("items/doomed"),
                    precondition: Precondition::None,
                },
            ],
            &store.snapshot(),
            time(),
        )
        .expect("preview");
    assert!(!verdict.allowed);

    let received = drain(&mut denials);
    assert_eq!(
        received
            .iter()
            .map(|denial| (denial.operation, denial.relative_path()))
            .collect::<Vec<_>>(),
        [
            (RequestOperation::Update, "items/existing"),
            (RequestOperation::Create, "items/new"),
            (RequestOperation::Delete, "items/doomed"),
        ]
    );
    assert!(
        received
            .iter()
            .all(|denial| denial.uid.as_deref() == Some("u_1"))
    );
}

#[test]
fn a_refused_list_names_the_collection_or_the_collection_group() {
    let runtime = RulesRuntime::default();
    runtime.install_default(DENY).expect("install");
    let mut denials = runtime.subscribe_denials();
    let queries = [
        Query::new(Scope::collection("users").expect("scope")),
        Query::new(Scope::collection("users/u_1/orders").expect("scope")),
        Query::new(Scope::collection_group("orders").expect("scope")),
        Query::new(Scope::collection_group("orders").expect("scope"))
            .under_ancestor("users/u_1")
            .expect("ancestor"),
    ];
    for query in &queries {
        let result = runtime.evaluate(&database(), &user("u_1"), &list(query), &access());
        assert!(!result.allowed);
    }

    let received = drain(&mut denials);
    assert!(
        received
            .iter()
            .all(|denial| denial.operation == RequestOperation::List)
    );
    assert_eq!(
        received
            .iter()
            .map(|denial| denial.path.as_str())
            .collect::<Vec<_>>(),
        [
            "/databases/(default)/documents/users",
            "/databases/(default)/documents/users/u_1/orders",
            "/databases/(default)/documents/**/orders",
            "/databases/(default)/documents/users/u_1/**/orders",
        ]
    );
    assert_eq!(received[0].relative_path(), "users");
    assert_eq!(received[3].relative_path(), "users/u_1/**/orders");
}

#[tokio::test]
async fn a_console_handle_tags_its_refusals_and_shares_rules_recorder_and_tap() {
    let history = RequestHistory::default();
    let runtime = RulesRuntime::with_request_history(history.clone());
    let console = runtime.with_origin(DenialOrigin::Console);
    assert_eq!(runtime.origin(), DenialOrigin::App);
    assert_eq!(console.origin(), DenialOrigin::Console);
    assert_eq!(console.clone().origin(), DenialOrigin::Console);
    assert_eq!(
        console.with_origin(DenialOrigin::App).origin(),
        DenialOrigin::App
    );

    // Rules installed on the original after the split govern the console
    // handle, and a subscription on either hears both.
    runtime.install_default(DENY).expect("install");
    let mut from_original = runtime.subscribe_denials();
    let mut from_console = console.subscribe_denials();
    let read = get("users/u_2fc4c");
    let _ = console.evaluate(&database(), &user("u_9f3k2"), &read, &access());
    let _ = runtime.evaluate(&database(), &user("u_9f3k2"), &read, &access());

    let received = drain(&mut from_original);
    assert_eq!(drain(&mut from_console), received);
    assert_eq!(
        received
            .iter()
            .map(|denial| denial.origin)
            .collect::<Vec<_>>(),
        [DenialOrigin::Console, DenialOrigin::App]
    );
    let console_id = received[0]
        .request_id
        .as_deref()
        .expect("the console's decision is kept");
    assert!(
        runtime.decision(console_id).is_some(),
        "one shared retention"
    );
    let events = history_events(&history).await;
    assert_eq!(events.len(), 2, "one shared Requests feed");
    assert_eq!(events[0]["requestId"], console_id);
}

#[test]
fn a_subscriber_that_falls_behind_is_told_how_many_it_missed() {
    let runtime = RulesRuntime::default();
    runtime.install_default(DENY).expect("install");
    let mut denials = runtime.subscribe_denials();
    for index in 0..DENIAL_CAPACITY + 10 {
        let _ = runtime.evaluate(
            &database(),
            &user("u_1"),
            &get(&format!("users/u_{index}")),
            &access(),
        );
    }
    assert_eq!(denials.try_recv(), Err(TryRecvError::Lagged(10)));
    assert_eq!(drain(&mut denials).len(), DENIAL_CAPACITY);
}
