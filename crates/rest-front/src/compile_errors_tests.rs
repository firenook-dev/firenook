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

/// Where the official parser skips ahead after an error, Firenook stops: its
/// answer is the official answer's first lines (DESIGN.md, Rules compile
/// errors).
const RECOVERY: &str = "the official parser recovers and reports more problems after these first ones; Firenook answers them and stops";

/// Recorded answers Firenook gives otherwise, by reason. The replay asserts
/// each still differs; whoever fixes one moves it out of this table and the
/// replay notes it in the ledger.
const BUG_CANDIDATES: &[(&str, &[&str])] = &[
    (
        RECOVERY,
        &[
            "braces/service-open-missing",
            "braces/service-body-word",
            "braces/match-open-missing",
            "braces/function-open-missing",
            "parens/parameters-close-missing",
            "paths/leading-slash-missing",
            "paths/wildcard-empty",
            "paths/missing",
            "functions/parameter-comma-missing",
            "functions/return-missing",
            "functions/two-returns",
            "functions/if-statement",
            "let/then-word",
            "let/in-match",
            "keywords/fucntion",
            "keywords/retrun",
            "keywords/alow",
            "two/misspelling-and-string",
        ],
    ),
    (
        "the official emulator compiles this source and answers its warnings; Firenook refuses it",
        &[
            "top/service-name-misspelled",
            "version/one",
            "conditions/method-unknown",
        ],
    ),
    (
        "Firenook takes one service block; the official emulator takes a second, and refuses this source for its empty match block",
        &["top/two-services"],
    ),
    (
        "where `service` has no name the official parser goes on and reports two later tokens; no recording shows how it reads the `{`, so Firenook reports the missing name in its own words",
        &["top/service-name-missing"],
    ),
    (
        "the official lexer reads the `//` in a match path as a comment; Firenook reads one path and reports its empty segment",
        &["paths/double-slash"],
    ),
    (
        "Firenook takes `$(…)` in a match path as a literal segment and compiles the source; the official emulator refuses it",
        &["paths/interpolation"],
    ),
    (
        "the official emulator also reports the first binding as an unused variable, a warning Firenook does not give",
        &["production/duplicate-let"],
    ),
];

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
