use super::*;
use crate::{
    JsonValue, QueryPolicy, Request, Router, RulesRuntime, Store,
    router_with_query_policy_memory_and_rules,
};
use axum::body::to_bytes;
use firenook_rules_runtime::request_history::RequestHistory;
use tower::ServiceExt as _;

const PROJECT: &str = "demo-fireside-coverage";
const SOURCE: &str = "rules_version = '2'; service cloud.firestore { match /databases/{db}/documents/items/{item} { allow get: if request.method == 'get'; } }";

#[test]
fn http_report_admission_matches_the_predeclared_bound() {
    let contract: JsonValue =
        serde_json::from_str(include_str!("../../../../benchmarks/phase-b-coverage.json")).unwrap();
    assert_eq!(
        contract["maximumInFlightHttpReportsPerRouter"],
        MAXIMUM_IN_FLIGHT_REPORTS
    );
}

fn application(rules: RulesRuntime) -> Router {
    router_with_query_policy_memory_and_rules(Store::default(), QueryPolicy::default(), None, rules)
}
async fn get(app: &Router, suffix: &str) -> Response {
    app.clone()
        .oneshot(
            Request::get(format!("/emulator/v1/projects/{PROJECT}:{suffix}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap()
}
async fn body(response: Response) -> JsonValue {
    serde_json::from_slice(
        &to_bytes(response.into_body(), 40 * 1024 * 1024)
            .await
            .unwrap(),
    )
    .unwrap()
}

#[tokio::test]
async fn actual_http_reports_cover_reload_evaluation_and_explicit_unavailability() {
    let disabled = application(RulesRuntime::default());
    assert_eq!(
        get(&disabled, "ruleCoverage").await.status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    let rules = RulesRuntime::with_request_history(RequestHistory::default());
    let app = application(rules);
    assert_eq!(
        get(&app, "ruleCoverage").await.status(),
        StatusCode::NOT_FOUND
    );
    let put = |source: &str| {
        Request::put(format!("/emulator/v1/projects/{PROJECT}:securityRules"))
            .header(CONTENT_TYPE, "application/json")
            .body(Body::from(
                json!({"rules":{"files":[{"name":"firestore.rules","content":source}]}})
                    .to_string(),
            ))
            .unwrap()
    };
    assert_eq!(
        app.clone().oneshot(put(SOURCE)).await.unwrap().status(),
        StatusCode::OK
    );
    let before = body(get(&app, "ruleCoverage").await).await;
    assert_eq!(before["rules"]["files"][0]["content"], SOURCE);
    assert!(before["report"][0].get("values").is_none());
    let read = app
        .clone()
        .oneshot(
            Request::get(format!(
                "/v1/projects/{PROJECT}/databases/(default)/documents/items/one"
            ))
            .body(Body::empty())
            .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(read.status(), StatusCode::NOT_FOUND); // allowed read, absent document
    let after = body(get(&app, "ruleCoverage").await).await;
    assert_eq!(after["report"][0]["values"][0]["value"]["boolValue"], true);
    assert_eq!(after["report"][0]["values"][0]["count"], 1);
    assert_eq!(
        app.clone().oneshot(put("broken")).await.unwrap().status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(body(get(&app, "ruleCoverage").await).await, after);
    assert_eq!(
        app.clone().oneshot(put(SOURCE)).await.unwrap().status(),
        StatusCode::OK
    );
    assert!(
        body(get(&app, "ruleCoverage").await).await["report"][0]
            .get("values")
            .is_none()
    );
}

#[tokio::test]
async fn project_report_covers_the_default_database_unless_another_is_named() {
    let rules = RulesRuntime::with_request_history(RequestHistory::default());
    rules.install_default(SOURCE).unwrap();
    let other_source = SOURCE.replace("== 'get'", "!= 'get'");
    rules
        .install_database(
            &firenook_core_store::DatabaseName::new(PROJECT, "other").unwrap(),
            &other_source,
        )
        .unwrap();
    let app = application(rules);
    for database in ["(default)", "other"] {
        let read = app
            .clone()
            .oneshot(
                Request::get(format!(
                    "/v1/projects/{PROJECT}/databases/{database}/documents/items/one"
                ))
                .body(Body::empty())
                .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            read.status(),
            if database == "other" {
                StatusCode::FORBIDDEN
            } else {
                StatusCode::NOT_FOUND
            }
        );
    }
    let default = body(get(&app, "ruleCoverage").await).await;
    assert_eq!(default["rules"]["files"][0]["content"], SOURCE);
    assert_eq!(default["report"][0]["values"][0]["count"], 1);
    let other = body(get(&app, "ruleCoverage?database=other").await).await;
    assert_eq!(other["rules"]["files"][0]["content"], other_source);
    assert_eq!(other["report"][0]["values"][0]["count"], 1);
    assert_eq!(
        get(&app, "ruleCoverage?database=a/b").await.status(),
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn report_budget_survives_handler_return_body_collection_and_frame_clones() {
    let rules = RulesRuntime::with_request_history(RequestHistory::default());
    rules.install_default(SOURCE).unwrap();
    let app = application(rules);
    let first = get(&app, "ruleCoverage").await;
    assert_eq!(first.status(), StatusCode::OK);
    assert_eq!(first.headers()["cache-control"], "no-store");
    assert_eq!(
        get(&app, "ruleCoverage").await.status(),
        StatusCode::TOO_MANY_REQUESTS
    );
    let bytes = to_bytes(first.into_body(), 40 * 1024 * 1024).await.unwrap();
    let slice = bytes.slice(..1);
    drop(bytes);
    assert_eq!(
        get(&app, "ruleCoverage").await.status(),
        StatusCode::TOO_MANY_REQUESTS
    );
    drop(slice);
    assert_eq!(get(&app, "ruleCoverage").await.status(), StatusCode::OK);
}

#[tokio::test]
async fn html_and_script_are_static_same_origin_and_never_interpolate_rule_text() {
    let rules = RulesRuntime::with_request_history(RequestHistory::default());
    rules
        .install_default(&format!(
            "{SOURCE}\n// </script><img src=x onerror=alert(1)> 中文 🚀"
        ))
        .unwrap();
    let app = application(rules);
    let response = get(&app, "ruleCoverage.html").await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["content-security-policy"], CSP);
    assert_eq!(response.headers()["x-content-type-options"], "nosniff");
    let html = to_bytes(response.into_body(), 65536).await.unwrap();
    assert_eq!(html, HTML);
    assert!(!HTML.contains("onerror"));
    let response = app
        .oneshot(
            Request::get("/emulator/v1/coverage.js")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(!SCRIPT.contains("innerHTML"));
    assert!(SCRIPT.contains("textContent"));
}

/// The official emulator's coverage recording
/// (`conformance/fixtures/developer-tools-coverage-v1`), replayed through
/// the REST router as it was captured: the owner's seed write, then for each
/// policy a rules reload, the report, two reads and the report again, then a
/// rejected reload, the report it kept and a rejected parameter name.
mod oracle {
    use super::*;
    use firenook_conformance_ledger::{self as ledger, Compared};

    const SET: &str = "developer-tools-coverage-v1";

    /// Recorded answers Firenook gives otherwise with no documented reason.
    /// The replay asserts each still differs as described; whoever fixes one
    /// moves it out of this table and the replay notes it in the ledger.
    const BUG_CANDIDATES: &[(&str, &str)] = &[];

    // The documented reasons a recorded report differs.
    const LAZY_PLANNER: &str = "coverage counts Firenook's one evaluation of each read, with the document; the official emulator's lazy planner first evaluates without it (bare undefined values and doubled counts) and gives short-circuited expressions empty values (DESIGN.md, Live bounded coverage observations)";
    const CAUSE_TEXT: &str = "an error value's cause text is Firenook's own message (DESIGN.md, Live bounded coverage observations)";

    async fn send(
        app: &Router,
        method: &str,
        path: &str,
        body: Option<&JsonValue>,
        owner: bool,
    ) -> (StatusCode, JsonValue) {
        let mut request = Request::builder()
            .method(method)
            .uri(path)
            .header(CONTENT_TYPE, "application/json");
        if owner {
            request = request.header(axum::http::header::AUTHORIZATION, "Bearer owner");
        }
        let body = body.map_or_else(Body::empty, |body| Body::from(body.to_string()));
        let response = app
            .clone()
            .oneshot(request.body(body).unwrap())
            .await
            .unwrap();
        let status = response.status();
        (status, self::body(response).await)
    }

    fn reload(source: &JsonValue) -> JsonValue {
        json!({"rules": {"files": [{"name": "firestore.rules", "content": source}]}})
    }

    /// A report as recorded: Firenook adds its documented `firenookCoverage`
    /// accounting (DESIGN.md, Live bounded coverage observations), checked
    /// complete and removed; request times, which differ on every run, are
    /// normalised, merging the values they alone told apart.
    fn report(mut actual: JsonValue) -> JsonValue {
        let extension = actual
            .as_object_mut()
            .unwrap()
            .remove("firenookCoverage")
            .expect("Firenook's accounting");
        assert_eq!(extension["truncated"], false);
        assert_eq!(extension["omittedValues"], 0);
        assert_eq!(extension["omittedOperations"], 0);
        normalized(actual)
    }

    fn normalized(mut report: JsonValue) -> JsonValue {
        if let Some(nodes) = report.get_mut("report").and_then(JsonValue::as_array_mut) {
            nodes.iter_mut().for_each(normalize_node);
        }
        report
    }

    fn normalize_node(node: &mut JsonValue) {
        if let Some(values) = node.get_mut("values").and_then(JsonValue::as_array_mut) {
            let mut merged: Vec<JsonValue> = Vec::new();
            for mut entry in values.drain(..) {
                if let Some(fields) = entry.pointer_mut("/value/mapValue/fields")
                    && fields.get("method").is_some()
                    && fields.get("time").is_some()
                {
                    // The request map: its time is the read's own.
                    assert!(fields["time"]["timestampValue"].is_string());
                    fields["time"] = json!({"timestampValue": "<request-time>"});
                }
                match merged
                    .iter_mut()
                    .find(|seen| seen["value"] == entry["value"])
                {
                    Some(seen) => {
                        seen["count"] = json!(
                            seen["count"].as_u64().unwrap() + entry["count"].as_u64().unwrap()
                        );
                    }
                    None => merged.push(entry),
                }
            }
            *values = merged;
        }
        if let Some(children) = node.get_mut("children").and_then(JsonValue::as_array_mut) {
            children.iter_mut().for_each(normalize_node);
        }
    }

    /// The recorded report without the official planner's lazy first pass,
    /// which DESIGN.md documents Firenook does not imitate. The official
    /// emulator evaluates a read without its document first; when that pass
    /// needs the document it is undefined, and a second pass evaluates with
    /// the document. Firenook evaluates once, with the document. So the
    /// first pass's bare `{"undefined":{}}` values go, an expression both
    /// passes evaluated alike keeps one pass's count (half of the recorded
    /// one), and a short-circuited expression's empty value objects go
    /// (Firenook reports no values for an expression it did not evaluate).
    /// Answers whether anything was taken out.
    fn without_lazy_first_pass(report: &mut JsonValue) -> bool {
        let mut changed = false;
        let roots = report.get_mut("report").and_then(JsonValue::as_array_mut);
        for root in roots.into_iter().flatten() {
            let passes = root["values"]
                .as_array()
                .and_then(|values| {
                    values
                        .iter()
                        .find(|entry| entry["value"] == json!({"undefined": {}}))
                })
                .map_or(0, |entry| entry["count"].as_u64().unwrap());
            changed |= first_pass(root, passes);
        }
        changed
    }

    fn first_pass(node: &mut JsonValue, passes: u64) -> bool {
        let mut changed = false;
        if let Some(values) = node.get_mut("values").and_then(JsonValue::as_array_mut) {
            let before = values.len();
            values.retain(|entry| entry["value"] != json!({"undefined": {}}));
            changed |= values.len() != before;
            if values.len() == before
                && passes > 0
                && values.len() == 1
                && values[0]["count"] == 2 * passes
            {
                values[0]["count"] = json!(passes);
                changed = true;
            }
            if values.iter().all(|entry| entry["value"] == json!({})) {
                node.as_object_mut().unwrap().remove("values");
                changed = true;
            }
        }
        for child in node
            .get_mut("children")
            .and_then(JsonValue::as_array_mut)
            .into_iter()
            .flatten()
        {
            changed |= first_pass(child, passes);
        }
        changed
    }

    /// Takes Firenook's own error cause text into the recorded report
    /// (documented); answers whether any was taken and whether an error's
    /// source position differs, which is not documented.
    fn own_cause_text(recorded: &mut JsonValue, actual: &JsonValue) -> (bool, bool) {
        let (mut taken, mut moved) = (false, false);
        let pairs = recorded
            .get_mut("report")
            .and_then(JsonValue::as_array_mut)
            .into_iter()
            .flatten()
            .zip(
                actual
                    .get("report")
                    .and_then(JsonValue::as_array)
                    .into_iter()
                    .flatten(),
            );
        for (recorded, actual) in pairs {
            let (t, m) = cause_text(recorded, actual);
            taken |= t;
            moved |= m;
        }
        (taken, moved)
    }

    fn cause_text(recorded: &mut JsonValue, actual: &JsonValue) -> (bool, bool) {
        let (mut taken, mut moved) = (false, false);
        if let (Some(recorded), Some(actual)) = (
            recorded.get_mut("values").and_then(JsonValue::as_array_mut),
            actual.get("values").and_then(JsonValue::as_array),
        ) {
            for (recorded, actual) in recorded.iter_mut().zip(actual) {
                let (Some(recorded), Some(actual)) = (
                    recorded.pointer_mut("/value/undefined"),
                    actual.pointer("/value/undefined"),
                ) else {
                    continue;
                };
                if recorded.get("causeMessage").is_some() && actual.get("causeMessage").is_some() {
                    if recorded["causeMessage"] != actual["causeMessage"] {
                        recorded["causeMessage"] = actual["causeMessage"].clone();
                        taken = true;
                    }
                    if recorded["sourcePosition"] != actual["sourcePosition"] {
                        recorded["sourcePosition"] = actual["sourcePosition"].clone();
                        moved = true;
                    }
                }
            }
        }
        let children = recorded
            .get_mut("children")
            .and_then(JsonValue::as_array_mut)
            .into_iter()
            .flatten()
            .zip(
                actual
                    .get("children")
                    .and_then(JsonValue::as_array)
                    .into_iter()
                    .flatten(),
            );
        for (recorded, actual) in children {
            let (t, m) = cause_text(recorded, actual);
            taken |= t;
            moved |= m;
        }
        (taken, moved)
    }

    /// The jar emits a set in hash iteration order; DESIGN.md says serialized
    /// set order is not a compatibility guarantee. Every member is compared.
    fn canonical_sets(value: &mut JsonValue) {
        match value {
            JsonValue::Object(fields) => {
                if let Some(values) = fields
                    .get_mut("setValue")
                    .and_then(|set| set.get_mut("values"))
                    .and_then(JsonValue::as_array_mut)
                {
                    values.sort_by_cached_key(JsonValue::to_string);
                }
                fields.values_mut().for_each(canonical_sets);
            }
            JsonValue::Array(values) => values.iter_mut().for_each(canonical_sets),
            _ => {}
        }
    }

    /// A rejected reload's error: the recorded status and code, and the
    /// two messages, which the bug table describes.
    fn rejected(
        status: StatusCode,
        actual: &JsonValue,
        recorded_status: &JsonValue,
        recorded: &JsonValue,
    ) -> (String, String) {
        assert_eq!(
            u64::from(status.as_u16()),
            recorded_status.as_u64().unwrap()
        );
        assert_eq!(actual["error"]["code"], recorded["error"]["code"]);
        assert_eq!(actual["error"]["status"], recorded["error"]["status"]);
        (
            actual["error"]["message"].as_str().unwrap().to_owned(),
            recorded["error"]["message"].as_str().unwrap().to_owned(),
        )
    }

    /// One recorded case's outcome: noted (checked, or differing for the
    /// documented reasons given), or a listed bug candidate.
    enum Outcome {
        Noted(Compared, Vec<&'static str>),
        Bug,
    }

    const CONTROL: &str = "/emulator/v1/projects/demo-fireside-coverage";

    async fn coverage(app: &Router) -> JsonValue {
        let (status, report) =
            send(app, "GET", &format!("{CONTROL}:ruleCoverage"), None, false).await;
        assert_eq!(status, StatusCode::OK);
        report
    }

    /// The owner's seed write; its times differ on every run.
    async fn seed(app: &Router, seed: &JsonValue) -> Outcome {
        let (status, mut answer) = send(
            app,
            "PATCH",
            seed["path"].as_str().unwrap(),
            Some(&seed["body"]),
            true,
        )
        .await;
        assert_eq!(u64::from(status.as_u16()), seed["status"].as_u64().unwrap());
        let mut recorded = seed["response"].clone();
        for time in ["createTime", "updateTime"] {
            assert!(answer[time].is_string());
            answer[time] = json!("<time>");
            recorded[time] = json!("<time>");
        }
        assert_eq!(answer, recorded, "seed");
        Outcome::Noted(Compared::Answer, vec![])
    }

    /// One policy: reload, the report, two reads, the report again.
    async fn profile(app: &Router, profile: &JsonValue, document: &str) -> Outcome {
        let id = profile["id"].as_str().unwrap();
        let (status, _) = send(
            app,
            "PUT",
            &format!("{CONTROL}:securityRules"),
            Some(&reload(&profile["source"])),
            false,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{id} reload");
        assert_eq!(
            report(coverage(app).await),
            normalized(profile["before"].clone()),
            "{id} before"
        );
        for _ in 0..2 {
            let (status, _) = send(app, "GET", document, None, false).await;
            assert_eq!(
                u64::from(status.as_u16()),
                profile["status"].as_u64().unwrap(),
                "{id} read"
            );
        }
        let mut actual = report(coverage(app).await);
        let mut recorded = normalized(profile["after"].clone());
        canonical_sets(&mut actual);
        canonical_sets(&mut recorded);
        let mut reasons = Vec::new();
        if without_lazy_first_pass(&mut recorded) {
            reasons.push(LAZY_PLANNER);
        }
        let (taken, moved) = own_cause_text(&mut recorded, &actual);
        if taken {
            reasons.push(CAUSE_TEXT);
        }
        assert_eq!(actual, recorded, "{id} after");
        let case = format!("profiles/{id}");
        let listed = BUG_CANDIDATES.iter().any(|(listed, _)| *listed == case);
        assert_eq!(
            moved, listed,
            "{case}: an error's position differs only where listed"
        );
        if listed {
            Outcome::Bug
        } else {
            Outcome::Noted(Compared::Answer, reasons)
        }
    }

    /// A rejected reload keeps the last valid rules and their coverage; a
    /// namespace name as a parameter is rejected too.
    async fn rejections(app: &Router, fixture: &JsonValue) -> Vec<(String, Outcome)> {
        let mut outcomes = Vec::new();
        let invalid = &fixture["invalidReload"];
        let (status, answer) = send(
            app,
            "PUT",
            invalid["path"].as_str().unwrap(),
            Some(&invalid["body"]),
            false,
        )
        .await;
        let (actual, recorded) =
            rejected(status, &answer, &invalid["status"], &invalid["response"]);
        assert_eq!(actual, recorded);
        assert_eq!(answer, invalid["response"]);
        outcomes.push((
            "invalid-reload".to_owned(),
            Outcome::Noted(Compared::Answer, vec![]),
        ));
        assert_eq!(
            report(coverage(app).await),
            normalized(fixture["afterInvalidReload"].clone()),
            "after the rejected reload"
        );
        outcomes.push((
            "after-invalid-reload".to_owned(),
            Outcome::Noted(Compared::Answer, vec![]),
        ));
        for (index, rejection) in fixture["compileRejections"]
            .as_array()
            .unwrap()
            .iter()
            .enumerate()
        {
            let (status, answer) = send(
                app,
                "PUT",
                &format!("{CONTROL}:securityRules"),
                Some(&reload(&rejection["source"])),
                false,
            )
            .await;
            let (actual, recorded) =
                rejected(status, &answer, &rejection["status"], &rejection["data"]);
            assert_eq!(actual, recorded);
            assert_eq!(answer, rejection["data"]);
            outcomes.push((
                format!("compile-rejections/{}", index + 1),
                Outcome::Noted(Compared::Answer, vec![]),
            ));
        }
        outcomes
    }

    #[tokio::test]
    async fn the_official_coverage_recording_replays_through_the_rest_router() {
        let fixture: JsonValue = serde_json::from_str(include_str!(
            "../../../../conformance/fixtures/developer-tools-coverage-v1/fixture.json"
        ))
        .unwrap();
        assert_eq!(fixture["project"], PROJECT);
        let app = application(RulesRuntime::with_request_history(RequestHistory::default()));
        let mut outcomes = vec![("seed".to_owned(), seed(&app, &fixture["seed"]).await)];
        let document = fixture["seed"]["path"].as_str().unwrap();
        for recorded in fixture["profiles"].as_array().unwrap() {
            outcomes.push((
                format!("profiles/{}", recorded["id"].as_str().unwrap()),
                profile(&app, recorded, document).await,
            ));
        }
        outcomes.extend(rejections(&app, &fixture).await);

        let mut bugs = Vec::new();
        for (case, outcome) in outcomes {
            match outcome {
                Outcome::Noted(compared, reasons) if reasons.is_empty() => {
                    ledger::checked(SET, &case, compared);
                }
                Outcome::Noted(compared, reasons) => {
                    ledger::differs(SET, &case, compared, &reasons.join("; "));
                }
                Outcome::Bug => bugs.push(case),
            }
        }
        let listed = BUG_CANDIDATES
            .iter()
            .map(|(case, _)| (*case).to_owned())
            .collect::<Vec<_>>();
        assert_eq!(bugs, listed, "every listed bug candidate still differs");
    }
}
