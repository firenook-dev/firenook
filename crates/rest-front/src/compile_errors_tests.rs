//! Replays `developer-tools-compile-errors-v1` through the REST router: rules
//! reloads (`PUT …:securityRules`) of sources that do not compile, recorded
//! from the official Firestore emulator one after another, each answer
//! compared whole (status and body).
//!
//! A case is noted only after its comparison passed; the others are listed
//! below with their reasons, and in `conformance/unreplayed.json`.

use super::*;
use axum::body::to_bytes;
use firenook_conformance_ledger::{self as ledger, Compared};
use std::collections::BTreeSet;
use tower::ServiceExt as _;

const SET: &str = "developer-tools-compile-errors-v1";

/// Recorded answers Firenook gives otherwise, by reason. The replay asserts
/// each still differs; whoever fixes one moves it out of this table and the
/// replay notes it in the ledger.
const BUG_CANDIDATES: &[(&str, &[&str])] = &[(
    "the official emulator compiles rules_version '1' and answers its warning; Firenook serves version 2 only, and no recording shows version 1 of the language, which the official emulator evaluates otherwise (a recursive wildcard matches one or more segments) and compiles otherwise (no let)",
    &["version/one"],
)];

#[tokio::test]
async fn the_official_compile_error_recording_replays_through_the_rest_router() {
    let fixture: JsonValue = serde_json::from_str(include_str!(
        "../../../conformance/fixtures/developer-tools-compile-errors-v1/fixture.json"
    ))
    .expect("fixture");
    let router = router_with_query_policy_memory_and_rules(
        Store::default(),
        QueryPolicy::default(),
        None,
        RulesRuntime::default(),
    );
    let path = fixture["request"]["path"].as_str().expect("path");
    let file = &fixture["request"]["file"];
    let mut different = BTreeSet::new();
    for reload in fixture["reloads"].as_array().expect("reloads") {
        let case = reload["id"].as_str().expect("id");
        let body = json!({"rules": {"files": [{"name": file, "content": reload["source"]}]}});
        let response = router
            .clone()
            .oneshot(
                Request::put(path)
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(body.to_string()))
                    .expect("request"),
            )
            .await
            .expect("answer");
        let status = response.status().as_u16();
        let bytes = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body");
        let answer: JsonValue = serde_json::from_slice(&bytes).expect("a JSON answer");
        if reload["status"] == status && reload["response"] == answer {
            ledger::checked(SET, case, Compared::Answer);
        } else {
            different.insert(case.to_owned());
        }
    }
    let listed = BUG_CANDIDATES
        .iter()
        .flat_map(|(_, cases)| cases.iter().map(|case| (*case).to_owned()))
        .collect::<BTreeSet<_>>();
    assert_eq!(
        different, listed,
        "every listed bug candidate still differs, and every other answer is the recorded one"
    );
}
