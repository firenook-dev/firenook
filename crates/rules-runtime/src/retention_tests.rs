use std::collections::BTreeMap;

use firenook_core_store::{Store, StoreOptions};
use firenook_rules_engine::{RequestOperation, Timestamp};
use serde_json::Value as Json;

use super::*;
use crate::request_history::RequestHistory;
use crate::{Authorization, RulesRuntime, SnapshotAccess};

const PROJECT: &str = "demo-decisions";
const DENY: &str = "rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /{document=**} { allow read, write: if false; } } }";

fn database() -> DatabaseName {
    DatabaseName::new(PROJECT, "(default)").expect("database")
}

fn get(path: &str) -> EvaluationRequest {
    EvaluationRequest::new(
        RequestOperation::Get,
        format!("/databases/(default)/documents/{path}"),
        Timestamp::new(1_760_000_000, 0),
    )
}

fn denied() -> EvaluationResult {
    EvaluationResult {
        allowed: false,
        error: None,
        evaluated_expressions: 1,
        document_accesses: 0,
        document_cache_hits: 0,
        matching_allows: 1,
        refused_by: Vec::new(),
    }
}

fn installed() -> Arc<InstalledRules> {
    InstalledRules::compile(DENY).expect("compiles")
}

#[tokio::test]
async fn a_recorded_decision_is_retained_under_its_event_id() {
    let history = RequestHistory::default();
    let runtime = RulesRuntime::with_request_history(history.clone());
    assert!(runtime.retains_decisions());
    runtime.install_default(DENY).expect("install");
    let access = SnapshotAccess::current(Store::new(StoreOptions::default()).snapshot(), PROJECT);
    let request = get("users/u1");
    let result = runtime.evaluate(&database(), &Authorization::Client(None), &request, &access);
    assert!(!result.allowed);
    // The owner bypasses the rules and is never recorded, so never retained.
    let _ = runtime.evaluate(&database(), &Authorization::Owner, &request, &access);

    let mut subscription = history.subscribe().expect("subscribe");
    let frame = subscription.recv().await.expect("history");
    let events: Json = serde_json::from_str(frame.text()).expect("json");
    let events = events.as_array().expect("array");
    assert_eq!(events.len(), 1, "the owner request is not recorded");
    let id = events[0]["requestId"].as_str().expect("id");

    let decision = runtime.decision(id).expect("retained");
    assert_eq!(decision.request_id(), id);
    assert_eq!(decision.recorded(), DecisionOutcome::Deny);
    assert_eq!(decision.database(), &database());
    assert_eq!(decision.request().path, request.path);
    assert_eq!(decision.ruleset().source(), DENY);
    assert_eq!(runtime.retained_decisions(&database()).len(), 1);
    assert!(
        runtime
            .retained_decisions(&DatabaseName::new(PROJECT, "other").expect("database"))
            .is_empty()
    );
    assert!(runtime.decision("not-an-id").is_none());
}

#[test]
fn without_diagnostics_nothing_is_retained() {
    let runtime = RulesRuntime::default();
    runtime.install_default(DENY).expect("install");
    let access = SnapshotAccess::current(Store::new(StoreOptions::default()).snapshot(), PROJECT);
    let _ = runtime.evaluate(
        &database(),
        &Authorization::Client(None),
        &get("users/u1"),
        &access,
    );
    assert!(!runtime.retains_decisions());
    assert!(runtime.retained_decisions(&database()).is_empty());
}

#[test]
fn the_ring_keeps_the_newest_2000_decisions_however_old() {
    let retention = DecisionRetention::default();
    let rules = installed();
    for index in 0..2_050 {
        retention.retain(
            &format!("id-{index}"),
            PROJECT,
            &rules,
            &get(&format!("items/{index}")),
            &denied(),
        );
    }
    let kept = retention.of_database(&database());
    assert_eq!(kept.len(), RETAINED_DECISIONS);
    assert_eq!(retention.len(), RETAINED_DECISIONS);
    assert_eq!(kept[0].request_id(), "id-50", "oldest first");
    assert!(retention.find("id-49").is_none());
    assert!(retention.find("id-2049").is_some());
    assert_eq!(retention.omitted(), 0);
}

#[test]
fn a_ruleset_source_is_charged_once_for_every_decision_it_made() {
    let retention = DecisionRetention::default();
    let rules = installed();
    for index in 0..3 {
        retention.retain(
            &format!("id-{index}"),
            PROJECT,
            &rules,
            &get(&format!("a/{index}")),
            &denied(),
        );
    }
    let ring = retention.lock();
    let entries: usize = ring.entries.iter().map(|entry| entry.bytes).sum();
    assert_eq!(
        ring.bytes,
        entries + DENY.len(),
        "the source once, not three times"
    );
    assert_eq!(ring.sources.get(&rules.source_hash), Some(&3));
}

#[test]
fn the_byte_budget_evicts_the_oldest_and_refuses_an_oversized_entry() {
    let retention = DecisionRetention::default();
    let rules = installed();
    let with_document = |megabytes: usize| {
        let mut request = get("blobs/b");
        request.resource = Some(Resource::new(
            "projects/demo-decisions/databases/(default)/documents/blobs/b",
            BTreeMap::from([(
                "payload".to_owned(),
                Value::String("x".repeat(megabytes * 1024 * 1024)),
            )]),
        ));
        request
    };
    for index in 0..3 {
        retention.retain(
            &format!("big-{index}"),
            PROJECT,
            &rules,
            &with_document(6),
            &denied(),
        );
    }
    assert!(retention.find("big-0").is_none(), "evicted for bytes");
    assert!(retention.find("big-1").is_some());
    assert!(retention.find("big-2").is_some());
    assert!(retention.lock().bytes <= RETAINED_BYTES);

    retention.retain("huge", PROJECT, &rules, &with_document(17), &denied());
    assert!(retention.find("huge").is_none());
    assert_eq!(retention.omitted(), 1);
    assert!(retention.find("big-2").is_some(), "nothing evicted for it");

    // Evicting the last decision a source made releases the source too.
    let other = InstalledRules::compile(&DENY.replace("false", "1 == 2")).expect("compiles");
    for index in 0..3 {
        retention.retain(
            &format!("other-{index}"),
            PROJECT,
            &other,
            &with_document(6),
            &denied(),
        );
    }
    let ring = retention.lock();
    assert!(!ring.sources.contains_key(&rules.source_hash));
    let entries: usize = ring.entries.iter().map(|entry| entry.bytes).sum();
    assert_eq!(ring.bytes, entries + other.rules.source().len());
}

#[test]
fn a_contended_ring_skips_the_decision_instead_of_waiting() {
    let retention = DecisionRetention::default();
    let rules = installed();
    let held = retention.lock();
    retention.retain("skipped", PROJECT, &rules, &get("a/1"), &denied());
    drop(held);
    assert_eq!(retention.omitted(), 1);
    assert!(retention.find("skipped").is_none());
}
