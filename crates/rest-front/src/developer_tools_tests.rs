//! Replays `developer-tools-v1`'s Firestore requests against the REST router
//! with the recording's rules and diagnostics on: the observations the
//! capture made over HTTP (coverage before, writes, reads, listing, coverage
//! after and its HTML page), then the two the official Emulator UI made
//! (`browser.exchanges`, service `firestore`).
//!
//! A case is noted only after its comparison passed, `differs` only where a
//! document names why Firenook answers otherwise.

use super::*;
use axum::body::to_bytes;
use firenook_rules_runtime::request_history::RequestHistory;
use tower::ServiceExt as _;

const SET: &str = "developer-tools-v1";

fn fixture() -> JsonValue {
    serde_json::from_str(include_str!(
        "../../../conformance/fixtures/developer-tools-v1/fixture.json"
    ))
    .expect("fixture")
}

async fn send(
    router: &Router,
    method: &str,
    path: &str,
    body: &JsonValue,
    owner: bool,
) -> (StatusCode, HeaderMap, Vec<u8>) {
    let mut request = Request::builder().method(method).uri(path);
    if !body.is_null() {
        request = request.header(CONTENT_TYPE, "application/json");
    }
    if owner {
        request = request.header(AUTHORIZATION, "Bearer owner");
    }
    let body = if body.is_null() {
        Body::empty()
    } else {
        Body::from(serde_json::to_vec(body).expect("JSON"))
    };
    let response = router
        .clone()
        .oneshot(request.body(body).expect("request"))
        .await
        .expect("response");
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = to_bytes(response.into_body(), 64 * 1024 * 1024)
        .await
        .expect("body")
        .to_vec();
    (status, headers, bytes)
}

/// The fixture replaced document times and timestamp values with
/// `<timestamp>`; they are this run's own (checked to be RFC 3339 first).
fn normalize_times(value: &mut JsonValue) {
    match value {
        JsonValue::Object(fields) => {
            for (key, child) in fields.iter_mut() {
                if matches!(key.as_str(), "createTime" | "updateTime" | "timestampValue") {
                    let text = child.as_str().expect("a time");
                    assert!(OffsetDateTime::parse(text, &Rfc3339).is_ok(), "{text}");
                    *child = json!("<timestamp>");
                } else {
                    normalize_times(child);
                }
            }
        }
        JsonValue::Array(items) => items.iter_mut().for_each(normalize_times),
        _ => {}
    }
}

/// The capture named the rules file by its path in the oracle's working
/// directory (`<oracle-workdir>/firestore.rules`); the file name is compared.
fn normalize_rules_name(report: &mut JsonValue) {
    for file in report["rules"]["files"]
        .as_array_mut()
        .into_iter()
        .flatten()
    {
        let name = file["name"].as_str().expect("file name");
        let base = name.rsplit('/').next().expect("base name").to_owned();
        file["name"] = json!(format!("<oracle-workdir>/{base}"));
    }
}

/// Bug candidates: answered otherwise with no documented reason, kept out
/// of the ledger. The test fails once one matches, so whoever fixes it
/// moves the case into the ledger.
/// `coverage-after`: the report after the reads and writes. Each PATCH is
/// evaluated once, as the create it is; the official jar also evaluates its
/// preliminary update check, so its write rule (line 6) counts two visits
/// where Firenook counts one, and its read rule shows the planner's
/// `undefined` visits (DESIGN.md: coverage uses actual evaluator visits and
/// never re-evaluates policy to manufacture the jar's planner visit counts;
/// the producer evaluates once).
const COVERAGE_AFTER: &str = "coverage counts Firenook's one evaluation of each write, as the create it is; the official jar also counts its preliminary update check, so the write rule's visits are doubled, and its read rule shows the planner's undefined visits (DESIGN.md: coverage uses actual evaluator visits, never manufactured planner visit counts; the producer evaluates once; runtime error causes are Firenook's own text)";

/// `coverage-html`: an independent same-origin renderer that fetches the
/// JSON report, not the jar's page with the report embedded (DESIGN.md,
/// Native coverage reports).
const COVERAGE_HTML: &str = "the coverage page is Firenook's own same-origin renderer that fetches the JSON report (DESIGN.md, Native coverage reports); the official page embeds the report: status, content type and title match";

/// A denial carries production's text first, then what the official
/// emulator says (COMPATIBILITY.md, the rules section). The official text
/// here also starts with the error of the jar's preliminary evaluation
/// before the document is read ("evaluation error at L5:19"), which
/// Firenook does not make: it evaluates a request once (DESIGN.md, "Unlike
/// the jar's preliminary/lazy planner"; `developer_tracing.rs` records the
/// same choice for these events).
const DENIAL: &str = "Firenook's denial starts with production's text (\"Missing or insufficient permissions.\") and then names the allow that refused it, without the official jar's preliminary pre-read evaluation error (COMPATIBILITY.md rules denials; DESIGN.md, no preliminary planner)";

/// The entry the official jar's preliminary evaluation adds first.
const PRELIMINARY: &str = "evaluation error at L5:19 for 'get' @ L5, ";

/// `read-missing`: the condition fails reading `resource.data` of a missing
/// document, and the failure is named in Firenook's own words, as its
/// runtime error causes are (DESIGN.md, "Runtime error cause text remains
/// Firenook's actual message"); the official cause is the jar's.
const CAUSES: [(&str, &str); 1] = [(
    "Null value error.",
    "field \"data\" is not available on this value",
)];
const CAUSE: &str =
    "; the failed condition's cause is Firenook's own text (DESIGN.md, runtime error cause text)";

#[tokio::test]
#[allow(clippy::too_many_lines)]
async fn official_developer_tools_firestore_requests_replay_in_order() {
    let fixture = fixture();
    let project = fixture["project"].as_str().expect("project");
    let rules = RulesRuntime::with_request_history(RequestHistory::default());
    rules
        .install_default(fixture["rules"].as_str().expect("rules"))
        .expect("rules compile");
    let router = router_with_query_policy_memory_and_rules(
        Store::default(),
        QueryPolicy::default(),
        None,
        rules,
    );
    for observation in fixture["observations"].as_array().expect("observations") {
        let id = observation["id"].as_str().expect("id");
        let case = format!("observations/{id}");
        let path = observation["path"].as_str().expect("path");
        let (status, headers, bytes) = send(
            &router,
            observation["method"].as_str().expect("method"),
            path,
            &observation["requestBody"],
            observation["admin"] == true,
        )
        .await;
        assert_eq!(
            u64::from(status.as_u16()),
            observation["status"],
            "{id}: {}",
            String::from_utf8_lossy(&bytes)
        );
        let recorded = &observation["body"];
        if id.starts_with("write-") {
            // Replayed by verify-native-suite.mjs (status).
            continue;
        }
        if id == "coverage-html" {
            let content_type = headers
                .get(CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .unwrap_or_default();
            assert!(content_type.starts_with("text/html"), "{content_type}");
            let html = String::from_utf8(bytes).expect("HTML");
            let title = html
                .split_once("<title>")
                .and_then(|(_, rest)| rest.split_once("</title>"))
                .map(|(title, _)| title)
                .expect("a title");
            assert_eq!(title, recorded["title"]);
            assert_ne!(
                html.len() as u64,
                recorded["byteLength"].as_u64().expect("length")
            );
            firenook_conformance_ledger::differs(
                SET,
                &case,
                firenook_conformance_ledger::Compared::Answer,
                COVERAGE_HTML,
            );
            continue;
        }
        let mut actual: JsonValue = serde_json::from_slice(&bytes).expect("JSON");
        normalize_times(&mut actual);
        if id.starts_with("coverage-") {
            normalize_rules_name(&mut actual);
            // Firenook's own completeness block (DESIGN.md, coverage limits).
            let completeness = actual
                .as_object_mut()
                .expect("report")
                .remove("firenookCoverage")
                .expect("completeness");
            assert_eq!(completeness["truncated"], false);
            if id == "coverage-after" {
                assert_eq!(actual["rules"], recorded["rules"], "{id}: rules");
                assert_coverage_after(&recorded["report"], &actual["report"]);
                firenook_conformance_ledger::differs(
                    SET,
                    &case,
                    firenook_conformance_ledger::Compared::Behaviour,
                    COVERAGE_AFTER,
                );
                continue;
            }
        }
        if status == StatusCode::FORBIDDEN {
            let message = actual["error"]["message"].as_str().expect("message");
            let official = recorded["error"]["message"].as_str().expect("message");
            let without_preliminary = official.replacen(PRELIMINARY, "", 1);
            assert_ne!(
                without_preliminary, official,
                "{id}: the recorded preliminary error"
            );
            let mut reason = DENIAL.to_owned();
            let mut expected = format!("Missing or insufficient permissions.{without_preliminary}");
            for (jar, own) in CAUSES {
                if expected.contains(jar) {
                    expected = expected.replace(jar, own);
                    reason.push_str(CAUSE);
                }
            }
            assert_eq!(message, expected, "{id}");
            actual["error"]["message"] = json!(official);
            assert_eq!(&actual, recorded, "{id}: body");
            firenook_conformance_ledger::differs(
                SET,
                &case,
                firenook_conformance_ledger::Compared::Error,
                &reason,
            );
            continue;
        }
        assert_eq!(&actual, recorded, "{id}: body");
        firenook_conformance_ledger::checked(
            SET,
            &case,
            firenook_conformance_ledger::Compared::Answer,
        );
    }

    // The two Firestore requests the official UI made afterwards: its
    // coverage page (the capture recorded only the status) and "Clear all
    // data".
    for (index, exchange) in fixture["browser"]["exchanges"]
        .as_array()
        .expect("exchanges")
        .iter()
        .enumerate()
        .filter(|(_, exchange)| exchange["service"] == "firestore")
    {
        let case = format!("ui/{}", index + 1);
        let path = exchange["path"].as_str().expect("path");
        assert!(path.contains(project), "{case}");
        let (status, _, bytes) = send(
            &router,
            exchange["method"].as_str().expect("method"),
            path,
            &JsonValue::Null,
            true,
        )
        .await;
        assert_eq!(u64::from(status.as_u16()), exchange["status"], "{case}");
        if exchange["response"].is_null() {
            firenook_conformance_ledger::checked(
                SET,
                &case,
                firenook_conformance_ledger::Compared::Status,
            );
            continue;
        }
        let actual: JsonValue = serde_json::from_slice(&bytes).expect("JSON");
        assert_eq!(actual, exchange["response"], "{case}");
        firenook_conformance_ledger::checked(
            SET,
            &case,
            firenook_conformance_ledger::Compared::Answer,
        );
    }
    let (status, _, _) = send(
        &router,
        "GET",
        &format!("/v1/projects/{project}/databases/(default)/documents/notes/visible"),
        &JsonValue::Null,
        true,
    )
    .await;
    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "clearing removed the documents"
    );
}

/// Pins [`COVERAGE_AFTER`]: the same tree at the same
/// positions; on the read rule (line 5) the same values once the jar's
/// manufactured `undefined` visits are left out and an error is compared as
/// an error (its cause text and position are each engine's own, DESIGN.md);
/// on the write rule (line 6) every recorded value is Firenook's, counted
/// twice (the operands both evaluations share) or once (the `request` itself,
/// whose method tells the two apart), or the same request evaluated as an
/// `update`, which Firenook does not evaluate.
fn assert_coverage_after(recorded: &JsonValue, actual: &JsonValue) {
    let recorded = recorded.as_array().expect("nodes");
    let actual = actual.as_array().expect("nodes");
    assert_eq!(recorded.len(), actual.len(), "nodes");
    for (expected, node) in recorded.iter().zip(actual) {
        let position = &expected["sourcePosition"];
        assert_eq!(position, &node["sourcePosition"]);
        let summary = |values: &JsonValue| -> Vec<(JsonValue, u64)> {
            values
                .as_array()
                .into_iter()
                .flatten()
                .filter(|value| value["value"] != json!({ "undefined": {} }))
                .map(|value| {
                    let shown = if value["value"]["undefined"].is_object() {
                        json!("error")
                    } else {
                        value["value"].clone()
                    };
                    (shown, value["count"].as_u64().expect("count"))
                })
                .collect()
        };
        let (official, own) = (summary(&expected["values"]), summary(&node["values"]));
        if position["line"] == 5 {
            assert_eq!(official, own, "line 5 at {position}");
        } else {
            for (value, count) in &official {
                let update = value["mapValue"]["fields"]["method"]["stringValue"] == "update";
                let ours = own.iter().find(|(candidate, _)| candidate == value);
                assert!(
                    update && ours.is_none()
                        || ours
                            .is_some_and(|(_, own)| *count == 2 * own || !update && *count == *own),
                    "line 6 at {position}: {value} counted {count}"
                );
            }
            assert!(
                own.iter()
                    .all(|value| official.iter().any(|(candidate, _)| *candidate == value.0))
            );
        }
        assert_coverage_after(
            &expected.get("children").cloned().unwrap_or(json!([])),
            &node.get("children").cloned().unwrap_or(json!([])),
        );
    }
}
