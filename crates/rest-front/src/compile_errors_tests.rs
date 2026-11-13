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

const WORDED: &str = "a rules reload's compile error is worded by Firenook's parser, where the official emulator's parser words it otherwise";

/// Recorded answers Firenook gives otherwise, by reason. The replay asserts
/// each still differs; whoever fixes one moves it out of this table and the
/// replay notes it in the ledger.
const BUG_CANDIDATES: &[(&str, &[&str])] = &[
    (
        WORDED,
        &[
            "top/broken",
            "top/empty",
            "top/whitespace-only",
            "top/comment-only",
            "top/word-before",
            "top/word-after",
            "top/word-after-function",
            "top/service-name-missing",
            "top/match-outside-service",
            "version/number",
            "version/equals-missing",
            "version/colon",
            "version/value-missing",
            "version/unterminated",
            "version/after-service",
            "braces/service-open-missing",
            "braces/service-body-word",
            "braces/service-body-allow",
            "braces/match-open-missing",
            "braces/function-open-missing",
            "braces/function-close-missing",
            "braces/match-close-missing",
            "braces/service-close-missing",
            "semicolons/allow-doubled",
            "semicolons/match-close",
            "semicolons/let-missing",
            "parens/condition-close-missing",
            "parens/condition-close-extra",
            "parens/call-close-missing",
            "parens/parameters-close-missing",
            "parens/parameters-missing",
            "strings/single-unterminated",
            "strings/double-unterminated",
            "strings/escaped-close",
            "paths/leading-slash-missing",
            "paths/wildcard-empty",
            "paths/double-slash",
            "paths/trailing-slash",
            "paths/missing",
            "conditions/if-space",
            "conditions/if-at-line-end",
            "conditions/not-equal-cut",
            "conditions/not-equal-at-close",
            "conditions/not-cut",
            "conditions/group-cut",
            "conditions/single-equals",
            "conditions/triple-equals",
            "conditions/single-ampersand",
            "conditions/stray-ampersand",
            "conditions/single-pipe",
            "conditions/tilde",
            "conditions/if-missing",
            "conditions/colon-alone",
            "conditions/colon-missing",
            "conditions/method-comma-missing",
            "conditions/method-missing",
            "conditions/trailing-dot",
            "conditions/bad-character-at",
            "conditions/bad-character-hash",
            "conditions/is-type-unknown",
            "functions/name-missing",
            "functions/parameter-comma-missing",
            "functions/return-missing",
            "functions/return-value-missing",
            "functions/two-returns",
            "functions/body-empty",
            "functions/if-statement",
            "let/name-missing",
            "let/equals-missing",
            "let/without-return",
            "let/then-word",
            "let/in-match",
            "keywords/servce",
            "keywords/rules-verison",
            "keywords/fucntion",
            "keywords/retrun",
            "keywords/alow",
            "eof/after-rules-version",
            "eof/after-service",
            "eof/after-service-name",
            "eof/in-service",
            "eof/after-match",
            "eof/after-match-path",
            "eof/in-match",
            "eof/in-parameters",
            "eof/in-function",
            "eof/after-return",
            "eof/after-allow",
            "eof/after-method",
            "eof/after-if",
            "eof/in-condition",
            "eof/after-condition",
            "eof/in-arguments",
            "eof/after-declaration",
            "eof/after-inner-match",
            "eof/in-string",
            "eof/in-block-comment",
            "two/empty-conditions",
            "two/semicolon-and-brace",
            "two/misspelling-and-string",
            "two/method-and-if",
            "two/package-and-syntax",
            "positions/crlf",
            "positions/unicode",
            "positions/tab",
            "production/unexpected-token",
            "production/unclosed-block",
            "production/duplicate-let",
            "production/recursive-function",
            "production/invalid-recursive-wildcard",
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
        "the official emulator takes an allow without its `;` before another declaration; Firenook refuses it",
        &["semicolons/allow-missing"],
    ),
    (
        "Firenook compiles a source the official emulator refuses",
        &["strings/newline-inside", "paths/interpolation"],
    ),
    (
        "Firenook takes one service block; the official emulator takes a second, and refuses this source for its empty match block",
        &["top/two-services"],
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
