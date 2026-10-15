use std::collections::BTreeMap;

use firenook_core_store::{
    DocumentKey, Fields, Precondition, Store, StoreOptions, Timestamp as StoreTimestamp, Write,
};
use firenook_query_engine::{Query, QueryScope as Scope};
use firenook_rules_engine::{AllowDecision, Auth, Timestamp, Value};
use tokio::sync::broadcast::error::TryRecvError;

use super::*;
use crate::request_history::RequestHistory;
use crate::{Authorization, SnapshotAccess, evaluation_request, query_candidate, query_policy};

const PROJECT: &str = "demo-decisions";
const MIXED: &str = "rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n    match /public/{id} {\n      allow read, write: if true;\n    }\n    match /private/{id} {\n      allow read: if request.auth != null && request.auth.uid == id;\n    }\n  }\n}";

fn database() -> DatabaseName {
    DatabaseName::new(PROJECT, "(default)").expect("database")
}

fn get(path: &str) -> EvaluationRequest {
    EvaluationRequest::new(
        RequestOperation::Get,
        format!("/databases/(default)/documents/{path}"),
        Timestamp::new(1_788_200_100, 0),
    )
}

fn access() -> SnapshotAccess {
    SnapshotAccess::current(Store::new(StoreOptions::default()).snapshot(), PROJECT)
}

/// A tenant user signed in with a password, as the Auth emulator's tokens say it.
fn tenant_user(uid: &str) -> Authorization {
    Authorization::Client(Some(Auth {
        uid: Some(uid.to_owned()),
        token: BTreeMap::from([(
            "firebase".to_owned(),
            Value::Map(BTreeMap::from([
                ("tenant".to_owned(), Value::String("t-1".to_owned())),
                (
                    "sign_in_provider".to_owned(),
                    Value::String("password".to_owned()),
                ),
            ])),
        )]),
    }))
}

fn diagnostics() -> RulesRuntime {
    let runtime = RulesRuntime::with_request_history(RequestHistory::default());
    runtime.install_default(MIXED).expect("install");
    runtime
}

fn drain(decisions: &mut broadcast::Receiver<Arc<RecordedDecision>>) -> Vec<Arc<RecordedDecision>> {
    std::iter::from_fn(|| decisions.try_recv().ok()).collect()
}

fn built(runtime: &RulesRuntime) -> usize {
    runtime.decisions.built.load(Ordering::Relaxed)
}

#[test]
fn every_recorded_decision_is_handed_over_allowed_and_denied_alike() {
    let runtime = diagnostics();
    let mut decisions = runtime.subscribe_decisions();

    let allowed = runtime.evaluate(
        &database(),
        &Authorization::Client(None),
        &get("public/p_1"),
        &access(),
    );
    let denied = runtime.evaluate(
        &database(),
        &tenant_user("u_1"),
        &get("private/u_2"),
        &access(),
    );
    assert!(allowed.allowed);
    assert!(!denied.allowed);

    let received = drain(&mut decisions);
    assert_eq!(received.len(), 2, "one decision per evaluation");
    let (first, second) = (&received[0], &received[1]);
    assert_eq!(first.outcome, DecisionOutcome::Allow);
    assert_eq!(first.relative_path(), "public/p_1");
    assert!(first.anonymous);
    assert_eq!(first.uid, None);
    assert_eq!(first.allows.len(), 1);
    assert_eq!(first.allows[0].decision, AllowDecision::Allow);
    assert_eq!(first.allows[0].location.line, 5);

    assert_eq!(second.outcome, DecisionOutcome::Deny);
    assert_eq!(second.operation, RequestOperation::Get);
    assert_eq!(second.relative_path(), "private/u_2");
    assert_eq!(second.uid.as_deref(), Some("u_1"));
    assert_eq!(second.tenant.as_deref(), Some("t-1"));
    assert_eq!(second.provider.as_deref(), Some("password"));
    assert!(!second.anonymous);
    assert_eq!(second.allows[0].location.line, 8);
    assert_eq!(second.allows[0].decision, AllowDecision::Deny);
    assert_eq!(second.origin, DenialOrigin::App);
    assert_eq!(second.time, Timestamp::new(1_788_200_100, 0));
    assert_eq!(second.rules.source(), MIXED);
    assert_eq!(*second.rules_hash, crate::source_hash(MIXED));
    // Retained, under the id the Requests feed and the re-run use.
    assert!(second.retained);
    assert!(runtime.decision(&second.request_id).is_some());
    assert_ne!(first.request_id, second.request_id);
}

#[test]
fn nothing_is_built_before_anyone_subscribes_and_nothing_without_diagnostics() {
    let runtime = diagnostics();
    let _ = runtime.evaluate(
        &database(),
        &Authorization::Client(None),
        &get("public/p_1"),
        &access(),
    );
    assert_eq!(built(&runtime), 0, "no subscriber in the engine's life yet");

    let quiet = RulesRuntime::default();
    quiet.install_default(MIXED).expect("install");
    let mut decisions = quiet.subscribe_decisions();
    let _ = quiet.evaluate(
        &database(),
        &Authorization::Client(None),
        &get("public/p_1"),
        &access(),
    );
    assert!(matches!(decisions.try_recv(), Err(TryRecvError::Empty)));
    assert_eq!(built(&quiet), 0, "no diagnostics, nothing recorded");
}

#[test]
fn the_owner_skips_the_rules_and_is_never_a_decision() {
    let runtime = diagnostics();
    let mut decisions = runtime.subscribe_decisions();
    let _ = runtime.evaluate(
        &database(),
        &Authorization::Owner,
        &get("private/u_2"),
        &access(),
    );
    assert!(drain(&mut decisions).is_empty());
}

#[test]
fn a_list_names_its_collection_and_a_console_read_says_where_it_entered() {
    let runtime = diagnostics();
    let console = runtime.with_origin(DenialOrigin::Console);
    let mut decisions = runtime.subscribe_decisions();
    let query = Query::new(Scope::collection("private").expect("scope"));
    let candidate = query_candidate(&database(), &query).expect("candidate");
    let list = evaluation_request(
        RequestOperation::List,
        &candidate,
        StoreTimestamp::new(1_788_200_100, 0).expect("time"),
        None,
        None,
        query_policy(&query),
    );
    let _ = console.evaluate(&database(), &tenant_user("u_1"), &list, &access());
    let received = drain(&mut decisions);
    assert_eq!(received.len(), 1);
    assert_eq!(received[0].operation, RequestOperation::List);
    assert_eq!(received[0].relative_path(), "private");
    assert_eq!(received[0].origin, DenialOrigin::Console);
}

#[test]
fn every_write_of_a_batch_is_its_own_decision() {
    let runtime = diagnostics();
    let mut decisions = runtime.subscribe_decisions();
    let store = Store::new(StoreOptions::default());
    let writes = ["public/a", "public/b"].map(|path| Write::Set {
        key: DocumentKey::new(database(), path).expect("key"),
        fields: Fields::new(),
        transforms: Vec::new(),
        precondition: Precondition::None,
    });
    let result = runtime
        .evaluate_writes(
            &database(),
            &Authorization::Client(None),
            &writes,
            &store.snapshot(),
            StoreTimestamp::new(1_788_200_100, 0).expect("time"),
        )
        .expect("preview");
    assert!(result.allowed);
    let received = drain(&mut decisions);
    assert_eq!(
        received
            .iter()
            .map(|decision| (decision.operation, decision.relative_path().to_owned()))
            .collect::<Vec<_>>(),
        vec![
            (RequestOperation::Create, "public/a".to_owned()),
            (RequestOperation::Create, "public/b".to_owned()),
        ]
    );
}
