use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use firenook_core_store::Write;
use firenook_query_engine::QueryPolicy;
use firenook_rules_runtime::request_history::RequestHistory;
use tower::ServiceExt as _;

use super::*;

const PROJECT: &str = "demo-rules-eval";

const NOTES: &str = "rules_version = '2';
// Notizen, nur für ihre Eigentümer 📝
service cloud.firestore {
  match /databases/{database}/documents {
    match /notes/{noteId} {
      allow get, list: if request.auth != null && resource.data.owner == request.auth.uid;
      allow create: if request.auth != null && request.resource.data.owner == request.auth.uid;
      allow update: if request.auth != null && resource.data.owner == request.auth.uid
        && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['title']);
      allow delete: if request.auth != null && resource.data.owner == request.auth.uid
        && !exists(/databases/$(database)/documents/locks/$(noteId));
    }
  }
}
";

const DENY_ALL: &str = "rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /{document=**} { allow read, write: if false; } } }";
const ALLOW_ALL: &str = "rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /{document=**} { allow read, write: if true; } } }";

fn database() -> DatabaseName {
    DatabaseName::new(PROJECT, "(default)").expect("database")
}

struct Harness {
    runtime: RulesRuntime,
    store: Store,
    history: RequestHistory,
}

impl Harness {
    fn new(rules: &str) -> Self {
        let history = RequestHistory::default();
        let runtime = RulesRuntime::with_request_history(history.clone());
        runtime
            .install_database(&database(), rules)
            .expect("rules compile");
        let harness = Self {
            runtime,
            store: Store::default(),
            history,
        };
        harness.seed(
            "notes/n1",
            &json!({"owner": {"stringValue": "u1"}, "title": {"stringValue": "a"}}),
        );
        harness.seed("notes/locked", &json!({"owner": {"stringValue": "u1"}}));
        harness.seed("locks/locked", &json!({}));
        harness
    }

    fn seed(&self, path: &str, fields: &JsonValue) {
        let fields = firenook_rest_front::document_fields(fields.as_object().expect("object"))
            .expect("fields");
        self.store
            .commit(&[Write::Create {
                key: DocumentKey::new(database(), path).expect("key"),
                fields,
            }])
            .expect("seed");
    }

    async fn console(
        &self,
        method: Method,
        uri: &str,
        body: Option<JsonValue>,
    ) -> (StatusCode, JsonValue) {
        let router = RulesEvaluator::new(&self.runtime, &self.store, PROJECT).router();
        call(router, method, uri, None, body).await
    }

    async fn evaluate(&self, body: JsonValue) -> (StatusCode, JsonValue) {
        self.console(Method::POST, "/rules/evaluate", Some(body))
            .await
    }

    /// The real REST front, sharing this runtime and store.
    async fn rest(
        &self,
        method: Method,
        path: &str,
        uid: Option<&str>,
        body: Option<JsonValue>,
    ) -> (StatusCode, JsonValue) {
        let router = firenook_rest_front::router_with_query_policy_memory_and_rules(
            self.store.clone(),
            QueryPolicy::default(),
            None,
            self.runtime.clone(),
        );
        let uri = format!("/v1/projects/{PROJECT}/databases/(default)/documents{path}");
        call(router, method, &uri, uid.map(token), body).await
    }

    async fn recorded_ids(&self) -> Vec<String> {
        let mut subscription = self.history.subscribe().expect("subscribe");
        let frame = subscription.recv().await.expect("history");
        let events: JsonValue = serde_json::from_str(frame.text()).expect("json");
        events
            .as_array()
            .expect("array")
            .iter()
            .map(|event| event["requestId"].as_str().expect("id").to_owned())
            .collect()
    }
}

async fn call(
    router: axum::Router,
    method: Method,
    uri: &str,
    authorization: Option<String>,
    body: Option<JsonValue>,
) -> (StatusCode, JsonValue) {
    let mut request = Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json");
    if let Some(authorization) = authorization {
        request = request.header("authorization", authorization);
    }
    let request = request
        .body(body.map_or_else(Body::empty, |body| Body::from(body.to_string())))
        .expect("request");
    let response = router.oneshot(request).await.expect("response");
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body");
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(JsonValue::Null),
    )
}

/// An unsigned emulator token for `uid`, as client SDKs send to the emulator.
fn token(uid: &str) -> String {
    let now = now().seconds();
    let header = URL_SAFE_NO_PAD.encode(json!({"alg": "none", "typ": "JWT"}).to_string());
    let payload = URL_SAFE_NO_PAD.encode(
        json!({
            "aud": PROJECT,
            "iss": format!("https://securetoken.google.com/{PROJECT}"),
            "iat": now - 60,
            "exp": now + 3600,
            "sub": uid,
            "user_id": uid,
        })
        .to_string(),
    );
    format!("Bearer {header}.{payload}.")
}

fn string(value: &str) -> JsonValue {
    json!({ "stringValue": value })
}

/// One operation, as both a dry run and the equivalent real REST call.
struct Case {
    name: &'static str,
    uid: Option<&'static str>,
    dry_run: JsonValue,
    method: Method,
    rest_path: String,
    rest_body: Option<JsonValue>,
}

fn cases() -> Vec<Case> {
    let owner_query = json!({
        "where": { "fieldFilter": { "field": { "fieldPath": "owner" }, "op": "EQUAL", "value": string("u1") } }
    });
    let mut cases = Vec::new();
    for uid in [Some("u1"), Some("u2"), None] {
        cases.push(Case {
            name: "get",
            uid,
            dry_run: json!({ "method": "get", "path": "notes/n1" }),
            method: Method::GET,
            rest_path: "/notes/n1".to_owned(),
            rest_body: None,
        });
    }
    for uid in ["u1", "u2"] {
        cases.push(Case {
            name: "create",
            uid: Some(uid),
            dry_run: json!({ "method": "create", "path": "notes/n2", "data": { "owner": string("u1") } }),
            method: Method::PATCH,
            rest_path: "/notes/n2?currentDocument.exists=false".to_owned(),
            rest_body: Some(json!({ "fields": { "owner": string("u1") } })),
        });
    }
    for (field, value) in [("title", "b"), ("owner", "u2")] {
        cases.push(Case {
            name: "update",
            uid: Some("u1"),
            dry_run: json!({ "method": "update", "path": "notes/n1", "data": { field: string(value) } }),
            method: Method::PATCH,
            rest_path: format!("/notes/n1?updateMask.fieldPaths={field}&currentDocument.exists=true"),
            rest_body: Some(json!({ "fields": { field: string(value) } })),
        });
    }
    for (uid, note) in [("u1", "n1"), ("u1", "locked"), ("u2", "n1")] {
        cases.push(Case {
            name: "delete",
            uid: Some(uid),
            dry_run: json!({ "method": "delete", "path": format!("notes/{note}") }),
            method: Method::DELETE,
            rest_path: format!("/notes/{note}"),
            rest_body: None,
        });
    }
    for query in [owner_query.clone(), json!({})] {
        let mut structured = json!({ "from": [{ "collectionId": "notes" }] });
        if let Some(filter) = query.get("where") {
            structured["where"] = filter.clone();
        }
        cases.push(Case {
            name: "list",
            uid: Some("u1"),
            dry_run: json!({ "method": "list", "path": "notes", "query": query }),
            method: Method::POST,
            rest_path: ":runQuery".to_owned(),
            rest_body: Some(json!({ "structuredQuery": structured })),
        });
    }
    cases
}

#[tokio::test]
async fn dry_runs_reach_the_verdict_the_real_rest_request_gets() {
    let mut allowed = 0;
    for case in cases() {
        let harness = Harness::new(NOTES);
        let mut request = case.dry_run.clone();
        if let Some(uid) = case.uid {
            request["authorization"] = json!(token(uid));
        }
        let revision = harness.store.revision();
        let (status, body) = harness.evaluate(json!({ "requests": [request] })).await;
        assert_eq!(status, StatusCode::OK, "{} {body}", case.name);
        assert_eq!(
            harness.store.revision(),
            revision,
            "a dry run commits nothing"
        );
        let dry = &body["results"][0];
        let (rest_status, rest_body) = harness
            .rest(
                case.method.clone(),
                &case.rest_path,
                case.uid,
                case.rest_body.clone(),
            )
            .await;
        assert!(
            rest_status == StatusCode::OK || rest_status == StatusCode::FORBIDDEN,
            "{} {rest_status} {rest_body}",
            case.name
        );
        assert_eq!(
            dry["outcome"] == "allow",
            rest_status == StatusCode::OK,
            "{} as {:?}: dry run {dry} vs REST {rest_status} {rest_body}",
            case.name,
            case.uid
        );
        if dry["outcome"] == "allow" {
            allowed += 1;
        }
        if case.name == "delete" && case.uid == Some("u1") {
            assert_eq!(dry["documentAccesses"], 1, "exists() is charged: {dry}");
            assert_eq!(dry["documentAccessLimit"], 10);
        }
    }
    assert_eq!(allowed, 5, "the matrix covers both verdicts");
}

#[tokio::test]
async fn an_update_reports_the_keys_it_changes() {
    let harness = Harness::new(NOTES);
    let (status, body) = harness
        .evaluate(json!({ "requests": [
            { "method": "update", "path": "notes/n1", "auth": { "uid": "u1", "token": {} },
              "data": { "title": string("b") } },
            { "method": "update", "path": "notes/n1", "auth": { "uid": "u1", "token": {} },
              "removeKeys": ["title"] },
        ] }))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let changed = &body["results"][0];
    assert_eq!(changed["outcome"], "allow", "{changed}");
    assert_eq!(changed["changedKeys"], json!(["title"]));
    assert_eq!(changed["resource"]["title"], string("a"));
    assert_eq!(changed["requestResource"]["title"], string("b"));
    assert_eq!(changed["requestResource"]["owner"], string("u1"));
    let removed = &body["results"][1];
    assert_eq!(removed["changedKeys"], json!(["title"]));
    assert!(
        removed["requestResource"].get("title").is_none(),
        "{removed}"
    );
}

#[tokio::test]
async fn operations_that_fail_before_the_rules_say_so() {
    let harness = Harness::new(ALLOW_ALL);
    let (status, body) = harness
        .evaluate(json!({ "requests": [
            { "method": "create", "path": "notes/n1", "data": {} },
            { "method": "update", "path": "notes/missing", "data": {} },
        ] }))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    for result in body["results"].as_array().expect("results") {
        assert_eq!(result["outcome"], "error", "{result}");
        assert!(
            result["error"]
                .as_str()
                .is_some_and(|message| message.contains("notes/"))
        );
    }
}

#[tokio::test]
async fn a_draft_is_evaluated_instead_of_the_rules_in_force_and_installs_nothing() {
    let harness = Harness::new(DENY_ALL);
    let request = json!({ "method": "get", "path": "notes/n1" });
    let (_, in_force) = harness.evaluate(json!({ "requests": [request] })).await;
    assert_eq!(in_force["results"][0]["outcome"], "deny");
    let (status, drafted) = harness
        .evaluate(json!({ "source": ALLOW_ALL, "requests": [request] }))
        .await;
    assert_eq!(status, StatusCode::OK, "{drafted}");
    assert_eq!(drafted["results"][0]["outcome"], "allow");
    assert_eq!(drafted["results"][0]["allows"][0]["outcome"], "allow");
    assert_eq!(
        harness
            .runtime
            .rules_for(&database())
            .expect("rules")
            .source(),
        DENY_ALL,
        "the draft was never installed"
    );
}

#[tokio::test]
async fn a_draft_that_does_not_compile_is_refused_with_diagnostics() {
    let harness = Harness::new(DENY_ALL);
    let (status, body) = harness
        .evaluate(json!({ "source": "service cloud.firestore { match", "requests": [] }))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(
        body["error"]["message"]
            .as_str()
            .is_some_and(|m| !m.is_empty())
    );
    let diagnostics = body["diagnostics"].as_array().expect("diagnostics");
    assert!(
        diagnostics[0]["line"]
            .as_u64()
            .is_some_and(|line| line >= 1),
        "{body}"
    );
}

#[tokio::test]
async fn dry_runs_record_no_requests_and_no_coverage() {
    let harness = Harness::new(NOTES);
    let coverage = harness
        .runtime
        .coverage_json(&database())
        .expect("coverage");
    let requests = cases()
        .into_iter()
        .map(|case| {
            let mut request = case.dry_run;
            request["auth"] = json!({ "uid": "u1", "token": {} });
            request
        })
        .collect::<Vec<_>>();
    let (status, _) = harness.evaluate(json!({ "requests": requests })).await;
    assert_eq!(status, StatusCode::OK);
    let statistics = harness.history.maintain().expect("statistics");
    assert_eq!(statistics.retained_events, 0);
    assert!(harness.runtime.retained_decisions(&database()).is_empty());
    assert_eq!(
        harness
            .runtime
            .coverage_json(&database())
            .expect("coverage"),
        coverage,
        "coverage counts nothing a dry run evaluated"
    );
    // The same request issued for real is recorded, so the check above means something.
    let (status, _) = harness
        .rest(Method::GET, "/notes/n1", Some("u1"), None)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        harness
            .history
            .maintain()
            .expect("statistics")
            .retained_events,
        1
    );
    assert_ne!(
        harness
            .runtime
            .coverage_json(&database())
            .expect("coverage"),
        coverage
    );
}

#[tokio::test]
async fn a_denied_list_names_the_missing_filter_and_a_provable_one_does_not() {
    let harness = Harness::new(NOTES);
    let (_, body) = harness
        .evaluate(json!({ "requests": [
            { "method": "list", "path": "notes", "auth": { "uid": "u1", "token": {} } },
            { "method": "list", "path": "notes", "auth": { "uid": "u1", "token": {} },
              "query": { "where": { "fieldFilter": { "field": { "fieldPath": "owner" }, "op": "EQUAL", "value": string("u1") } },
                         "orderBy": [{ "field": { "fieldPath": "owner" }, "direction": "ASCENDING" }],
                         "limit": 10 } },
        ] }))
        .await;
    let denied = &body["results"][0];
    assert_ne!(denied["outcome"], "allow");
    let reason = denied["queryReason"].as_str().expect("a reason");
    assert!(
        reason.starts_with("The query must filter on owner: the rule at line 6"),
        "{reason}"
    );
    assert!(
        reason.ends_with("Add where('owner', '==', \"u1\")."),
        "{reason}"
    );
    let allowed = &body["results"][1];
    assert_eq!(allowed["outcome"], "allow", "{allowed}");
    assert_eq!(allowed["queryReason"], JsonValue::Null);
    assert!(
        allowed["explanation"]
            .as_array()
            .expect("steps")
            .iter()
            .any(|step| step["value"] == "query: owner == \"u1\"")
    );
}

#[tokio::test]
async fn a_collection_group_list_is_decoded_like_run_query() {
    let rules = "rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /{path=**}/notes/{note} { allow list: if resource.data.owner == request.auth.uid; } } }";
    let harness = Harness::new(rules);
    let (_, body) = harness
        .evaluate(json!({ "requests": [
            { "method": "list", "path": "users/u1/notes", "group": true, "auth": { "uid": "u1", "token": {} } },
        ] }))
        .await;
    let result = &body["results"][0];
    assert_ne!(result["outcome"], "allow");
    assert!(
        result["explanation"]
            .as_array()
            .expect("steps")
            .iter()
            .any(|step| step["value"] == "request(list group notes under users/u1)"),
        "{result}"
    );
    assert!(result["queryReason"].as_str().is_some());
}

#[tokio::test]
async fn a_recorded_denial_is_explained_and_replays_to_the_same_outcome() {
    let harness = Harness::new(NOTES);
    let (status, _) = harness
        .rest(Method::GET, "/notes/n1", Some("u2"), None)
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let id = harness.recorded_ids().await.pop().expect("recorded");
    let (status, detail) = harness
        .console(Method::GET, &format!("/rules/decisions/{id}"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{detail}");
    assert_eq!(detail["requestId"], id.as_str());
    assert_eq!(detail["recordedOutcome"], "deny");
    assert_eq!(detail["result"]["outcome"], "deny");
    assert_eq!(detail["rules"], NOTES);
    assert!(
        detail["rulesHash"]
            .as_str()
            .is_some_and(|hash| !hash.is_empty())
    );
    let request = &detail["request"];
    assert_eq!(request["method"], "get");
    assert_eq!(request["path"], "notes/n1");
    assert_eq!(request["auth"]["uid"], "u2");
    assert_eq!(request["resource"]["owner"], string("u1"));
    assert!(request["time"].as_str().is_some());
    // The positions refer to the source in `rules`: UTF-16, not bytes.
    let source = NOTES;
    let start = source.find("request.auth.uid;").expect("present");
    let from = source[..start].encode_utf16().count();
    let step = detail["result"]["explanation"]
        .as_array()
        .expect("steps")
        .iter()
        .find(|step| step["from"] == from && step["to"] == from + "request.auth.uid".len())
        .unwrap_or_else(|| panic!("no step at {from}: {detail}"));
    assert_eq!(step["value"], "\"u2\"");
    assert_eq!(step["line"], 6);

    let (status, replay) = harness.evaluate(json!({ "requests": [request] })).await;
    assert_eq!(status, StatusCode::OK, "{replay}");
    assert_eq!(replay["results"][0]["outcome"], "deny");
    assert_eq!(
        replay["results"][0]["explanation"],
        detail["result"]["explanation"]
    );
}

#[tokio::test]
async fn recorded_writes_replay_against_the_document_they_saw() {
    let harness = Harness::new(NOTES);
    let (status, _) = harness
        .rest(
            Method::PATCH,
            "/notes/n9?currentDocument.exists=false",
            Some("u1"),
            Some(json!({ "fields": { "owner": string("u1") } })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = harness
        .rest(
            Method::PATCH,
            "/notes/n1?updateMask.fieldPaths=title&currentDocument.exists=true",
            Some("u1"),
            Some(json!({ "fields": { "title": string("b") } })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let ids = harness.recorded_ids().await;
    assert_eq!(ids.len(), 2);
    for id in ids {
        let (status, detail) = harness
            .console(Method::GET, &format!("/rules/decisions/{id}"), None)
            .await;
        assert_eq!(status, StatusCode::OK, "{detail}");
        assert_eq!(detail["recordedOutcome"], "allow");
        // The create's document exists now and the update's has changed:
        // only the recorded `resource` makes the replay faithful.
        let (_, replay) = harness
            .evaluate(json!({ "requests": [detail["request"]] }))
            .await;
        assert_eq!(
            replay["results"][0]["outcome"], "allow",
            "{detail} {replay}"
        );
    }
}

#[tokio::test]
async fn recorded_lists_replay_with_the_query_they_ran() {
    let harness = Harness::new(NOTES);
    let filtered = json!({ "structuredQuery": {
        "from": [{ "collectionId": "notes" }],
        "where": { "compositeFilter": { "op": "AND", "filters": [
            { "fieldFilter": { "field": { "fieldPath": "owner" }, "op": "EQUAL", "value": string("u1") } },
            { "fieldFilter": { "field": { "fieldPath": "title" }, "op": "GREATER_THAN", "value": string("") } },
        ] } },
        "orderBy": [{ "field": { "fieldPath": "title" }, "direction": "DESCENDING" }],
        "limit": 5,
    } });
    let (status, _) = harness
        .rest(Method::POST, ":runQuery", Some("u1"), Some(filtered))
        .await;
    assert_eq!(status, StatusCode::OK);
    let unfiltered = json!({ "structuredQuery": { "from": [{ "collectionId": "notes" }] } });
    let (status, _) = harness
        .rest(Method::POST, ":runQuery", Some("u1"), Some(unfiltered))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let ids = harness.recorded_ids().await;
    let mut outcomes = Vec::new();
    for id in ids {
        let (status, detail) = harness
            .console(Method::GET, &format!("/rules/decisions/{id}"), None)
            .await;
        assert_eq!(status, StatusCode::OK, "{detail}");
        let request = &detail["request"];
        assert_eq!(request["method"], "list");
        assert_eq!(request["path"], "notes");
        assert_eq!(request["group"], false);
        assert!(
            request.get("resource").is_none(),
            "a list reads no document: {request}"
        );
        let (_, replay) = harness.evaluate(json!({ "requests": [request] })).await;
        let replayed = &replay["results"][0];
        assert_eq!(
            replayed["outcome"], detail["result"]["outcome"],
            "{detail} {replay}"
        );
        assert_eq!(replayed["queryReason"], detail["result"]["queryReason"]);
        outcomes.push((
            detail["recordedOutcome"].clone(),
            request["query"].clone(),
            detail["result"]["queryReason"].clone(),
        ));
    }
    let (allowed, query, reason) = &outcomes[0];
    assert_eq!(allowed, "allow");
    assert_eq!(query["limit"], 5);
    assert_eq!(
        query["orderBy"],
        json!([{ "field": { "fieldPath": "title" }, "direction": "DESCENDING" }])
    );
    assert_eq!(query["where"]["compositeFilter"]["op"], "AND");
    assert_eq!(*reason, JsonValue::Null);
    let (denied, _, reason) = &outcomes[1];
    assert_ne!(denied, "allow");
    assert!(
        reason
            .as_str()
            .is_some_and(|reason| reason.contains("filter on owner"))
    );
}

#[tokio::test]
async fn an_unknown_decision_is_not_found() {
    let harness = Harness::new(NOTES);
    let (status, body) = harness
        .console(Method::GET, "/rules/decisions/nothing-like-it", None)
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(
        body["error"]["message"]
            .as_str()
            .is_some_and(|m| m.contains("not retained"))
    );

    let runtime = RulesRuntime::default();
    let router = RulesEvaluator::new(&runtime, &Store::default(), PROJECT).router();
    let (status, body) = call(router, Method::GET, "/rules/decisions/x", None, None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(
        body["error"]["message"]
            .as_str()
            .is_some_and(|m| m.contains("diagnostics are off"))
    );
}

#[tokio::test]
async fn impact_lists_the_decisions_a_draft_flips_and_nothing_for_an_equivalent_one() {
    let harness = Harness::new(NOTES);
    let (status, _) = harness
        .rest(Method::GET, "/notes/n1", Some("u2"), None)
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = harness
        .rest(Method::GET, "/notes/n1", Some("u1"), None)
        .await;
    assert_eq!(status, StatusCode::OK);
    let denied = harness.recorded_ids().await[0].clone();

    let opened = NOTES.replace(
        "allow get, list: if request.auth != null && resource.data.owner == request.auth.uid;",
        "allow get: if true;\n      allow list: if request.auth != null && resource.data.owner == request.auth.uid;",
    );
    let (status, impact) = harness
        .console(
            Method::POST,
            "/rules/impact",
            Some(json!({ "source": opened })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{impact}");
    assert_eq!(impact["considered"], 2);
    assert_eq!(
        impact["flips"],
        json!([{
            "requestId": denied,
            "method": "get",
            "path": "notes/n1",
            "uid": "u2",
            "before": "deny",
            "after": "allow",
            "time": impact["flips"][0]["time"],
        }])
    );
    assert!(
        impact["flips"][0]["time"]
            .as_str()
            .is_some_and(|time| time.ends_with('Z'))
    );

    let equivalent = format!(
        "// the same rules, reformatted\n{}",
        NOTES.replace("  ", "    ")
    );
    let (status, impact) = harness
        .console(
            Method::POST,
            "/rules/impact",
            Some(json!({ "source": equivalent })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{impact}");
    assert_eq!(impact["considered"], 2);
    assert_eq!(impact["flips"], json!([]));

    let (status, body) = harness
        .console(
            Method::POST,
            "/rules/impact",
            Some(json!({ "source": "nonsense" })),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(body["diagnostics"].is_array());
}

#[tokio::test]
async fn requests_a_real_client_could_not_make_are_refused() {
    let harness = Harness::new(NOTES);
    for (request, expected) in [
        (
            json!({ "method": "get", "path": "notes/n1", "authorization": "Bearer owner" }),
            "owner",
        ),
        (
            json!({ "method": "get", "path": "notes/n1", "authorization": token("u1"), "auth": { "uid": "u1", "token": {} } }),
            "not both",
        ),
        (
            json!({ "method": "get", "path": "notes" }),
            "not a document path",
        ),
        (
            json!({ "method": "list", "path": "notes/n1" }),
            "not a collection path",
        ),
        (
            json!({ "method": "get", "path": "notes/n1", "data": {} }),
            "only for create and update",
        ),
        (
            json!({ "method": "get", "path": "notes/n1", "time": "yesterday" }),
            "RFC 3339",
        ),
    ] {
        let (status, body) = harness.evaluate(json!({ "requests": [request] })).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        let message = body["error"]["message"].as_str().expect("message");
        assert!(message.starts_with("requests[0]: "), "{message}");
        assert!(message.contains(expected), "{message}");
    }
    let many = vec![json!({ "method": "get", "path": "notes/n1" }); MAX_REQUESTS + 1];
    let (status, _) = harness.evaluate(json!({ "requests": many })).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[test]
fn export_rules_evaluation_bindings() {
    let out = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../console/src/api/generated"
    );
    let config = ts_rs::Config::new().with_out_dir(out);
    RulesEvaluateBody::export_all(&config).expect("TypeScript bindings written");
    RulesEvaluation::export_all(&config).expect("TypeScript bindings written");
    DecisionDetail::export_all(&config).expect("TypeScript bindings written");
    RulesImpactBody::export_all(&config).expect("TypeScript bindings written");
    RulesImpact::export_all(&config).expect("TypeScript bindings written");
    let request = std::fs::read_to_string(format!("{out}/EvaluateRequest.ts")).expect("read");
    assert!(
        request.contains("resource?: { [key in string]: FirestoreRestValue } | null"),
        "{request}"
    );
    assert!(request.contains("method: RulesMethod"), "{request}");
    let result = std::fs::read_to_string(format!("{out}/EvaluateResult.ts")).expect("read");
    assert!(result.contains("queryReason: string | null"), "{result}");
    let value = std::fs::read_to_string(format!("{out}/FirestoreRestValue.ts")).expect("read");
    assert!(value.contains("stringValue?: string"), "{value}");
}
