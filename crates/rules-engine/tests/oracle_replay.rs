use std::collections::BTreeMap;

use firenook_conformance_ledger as ledger;
use firenook_rules_engine::{
    Auth, DocumentAccess, DocumentAccessError, EmptyDocumentAccess, EvaluationRequest, Query,
    RequestOperation, Resource, Timestamp, Value, compile,
};
use serde_json::Value as JsonValue;

/// The case sets `conformance/src/report/cases.mjs` lists these fixtures as.
const PRODUCTION_SET: &str = "rules-v2/production-rules-api";
const OFFICIAL_SET: &str = "rules-v2/official-emulator";

const EXPRESSION_CORPUS: &str =
    include_str!("../../../conformance/fixtures/rules-v2/production-expression-corpus.json");
const LANGUAGE_CONTRACT: &str =
    include_str!("../../../conformance/fixtures/rules-v2/production-language-contract.json");
const LIMIT_PROBES: &str =
    include_str!("../../../conformance/fixtures/rules-v2/production-limit-probes.json");
const JAVA_ACCESS: &str =
    include_str!("../../../conformance/fixtures/rules-v2/java-access-accounting.json");
// Recorded with the same rules source as `JAVA_ACCESS`; read only for the
// verdicts the ledger compares the hand-built requests' results with.
const JAVA_GET_AFTER: &str =
    include_str!("../../../conformance/fixtures/rules-v2/java-get-after.json");
const JAVA_RUNTIME_ERRORS: &str =
    include_str!("../../../conformance/fixtures/rules-v2/java-runtime-errors.json");

/// Notes a Java observation as checked when the verdict the test asserted is
/// the one the official emulator answered (200 allows, 403 denies).
fn ledger_java_verdict(fixture: &JsonValue, file: &str, id: &str, allowed: bool) {
    let recorded = fixture["observations"]
        .as_array()
        .expect("observations")
        .iter()
        .find(|observation| observation["id"] == id)
        .and_then(|observation| observation["status"].as_u64());
    if recorded == Some(if allowed { 200 } else { 403 }) {
        ledger::checked(
            OFFICIAL_SET,
            &format!("{file}/{id}"),
            ledger::Compared::Verdict,
        );
    }
}

#[derive(Default)]
struct CoverageVisits(usize);
impl firenook_rules_engine::CoverageObserver for CoverageVisits {
    fn observe(
        &mut self,
        _: firenook_rules_engine::ExpressionKey,
        _: firenook_rules_engine::ExpressionValue<'_>,
    ) {
        self.0 += 1;
    }
}

#[test]
fn replays_all_1024_production_expression_cases() {
    let fixture: JsonValue = serde_json::from_str(EXPRESSION_CORPUS).expect("valid corpus fixture");
    let mut replayed = 0_usize;
    for batch in fixture["batches"].as_array().expect("batches array") {
        let rules = compile(batch["source"].as_str().expect("rules source"))
            .expect("captured production rules source should compile");
        let cases = batch["cases"].as_array().expect("cases array");
        let results = batch["response"]["testResults"]
            .as_array()
            .expect("testResults array");
        assert_eq!(cases.len(), results.len());
        for (case, expected) in cases.iter().zip(results) {
            let request = evaluation_request(&case["request"], None);
            let actual = rules.evaluate(&request, &EmptyDocumentAccess);
            let mut coverage = CoverageVisits::default();
            assert_eq!(
                actual,
                rules
                    .evaluate_with_coverage(&request, &EmptyDocumentAccess, &mut coverage)
                    .0,
                "coverage must preserve {}",
                case["id"]
            );
            assert_eq!(
                actual,
                rules.evaluate_with_trace(&request, &EmptyDocumentAccess).0,
                "tracing must preserve the complete verdict and accounting for {}",
                case["id"]
            );
            let expected_allowed = expected["state"] == "SUCCESS";
            assert_eq!(
                actual.allowed,
                expected_allowed,
                "{}: {} => {actual:?}",
                case["id"].as_str().unwrap_or("unknown"),
                case["expression"].as_str().unwrap_or("unknown")
            );
            ledger::checked(
                PRODUCTION_SET,
                &format!("expression-corpus/{}", case["id"].as_str().expect("id")),
                ledger::Compared::Verdict,
            );
            replayed += 1;
        }
    }
    assert_eq!(replayed, 1_024);
}

#[test]
fn replays_the_targeted_language_contract() {
    let fixture: JsonValue = serde_json::from_str(LANGUAGE_CONTRACT).expect("valid fixture");
    let rules = compile(fixture["source"].as_str().expect("rules source"))
        .expect("targeted production source should compile");
    let cases = fixture["cases"].as_array().expect("cases array");
    let requests = fixture["testCases"].as_array().expect("testCases array");
    assert_eq!(cases.len(), requests.len());
    for (index, (case, test_case)) in cases.iter().zip(requests).enumerate() {
        let request = evaluation_request(&test_case["request"], case.get("resource"));
        let actual = rules.evaluate(&request, &EmptyDocumentAccess);
        assert!(
            actual.allowed,
            "targeted case {} ({}) should allow: {actual:?}",
            index,
            case["id"].as_str().unwrap_or("unknown")
        );
        let id = case["id"].as_str().expect("id");
        let case_id = format!("language-contract/{id}");
        match fixture["response"]["testResults"][index]["state"].as_str() {
            Some("SUCCESS") => ledger::checked(PRODUCTION_SET, &case_id, ledger::Compared::Verdict),
            Some(_) if id == "debug-return" => ledger::differs(
                PRODUCTION_SET,
                &case_id,
                ledger::Compared::Verdict,
                "production's projects.test has no debug() (Function not found); Firenook evaluates debug() to its argument, as the emulator does",
            ),
            _ => {}
        }
    }
}

#[test]
fn replays_the_frozen_call_depth_boundary() {
    let fixture: JsonValue = serde_json::from_str(LIMIT_PROBES).expect("valid fixture");
    for observation in fixture["observations"].as_array().expect("observations") {
        let id = observation["id"].as_str().expect("id");
        if id != "function-depth-21" && id != "function-depth-22" {
            continue;
        }
        let result = compile(observation["source"].as_str().expect("source"));
        assert_eq!(
            result.is_ok(),
            id == "function-depth-21",
            "{id}: {result:?}"
        );
        // Only the refusal is the whole recorded answer: production also
        // evaluated the accepted depth, which is not replayed here.
        let refused = observation["response"]["issues"]
            .as_array()
            .is_some_and(|issues| issues.iter().any(|issue| issue["severity"] == "ERROR"));
        if result.is_err() && refused {
            ledger::checked(
                PRODUCTION_SET,
                &format!("limit-probes/{id}"),
                ledger::Compared::Verdict,
            );
        }
    }
}

#[test]
fn denies_at_the_frozen_evaluated_expression_limit() {
    let fixture: JsonValue = serde_json::from_str(LIMIT_PROBES).expect("valid fixture");
    for observation in fixture["observations"].as_array().expect("observations") {
        let id = observation["id"].as_str().expect("id");
        if id != "balanced-expression-terms-100" && id != "balanced-expression-terms-125" {
            continue;
        }
        let rules = compile(observation["source"].as_str().expect("source"))
            .expect("balanced expression probe should compile");
        let mut request = EvaluationRequest::new(
            RequestOperation::Get,
            "/databases/(default)/documents/phase3/limit-probe",
            Timestamp::new(0, 0),
        );
        request.auth = Some(Auth {
            uid: Some("limit-probe".to_owned()),
            token: BTreeMap::from([("n".to_owned(), Value::Integer(100_000))]),
        });
        let actual = rules.evaluate(&request, &EmptyDocumentAccess);
        assert_eq!(actual.allowed, id.ends_with("100"), "{id}: {actual:?}");
        if id.ends_with("125") {
            assert!(
                actual
                    .error
                    .as_ref()
                    .is_some_and(|error| error.message.contains("1000 expressions")),
                "{actual:?}"
            );
        }
        let recorded_allowed = observation["response"]["testResults"][0]["state"] == "SUCCESS";
        if recorded_allowed == actual.allowed {
            ledger::checked(
                PRODUCTION_SET,
                &format!("limit-probes/{id}"),
                ledger::Compared::Verdict,
            );
        }
    }
}

/// Limit probes Firenook answers otherwise than production, with no
/// documented reason. The replay below asserts each still differs as
/// described; whoever fixes one moves it out of this table and the replay
/// notes it in the ledger.
const LIMIT_BUG_CANDIDATES: &[(&str, &str)] = &[
    (
        "function-depth-21",
        "production evaluates the 21-function chain f0..f20 and allows; Firenook compiles it but denies at run time: `maximum allowed call depth of 20 is reached` at `f20()` (22:27)",
    ),
    (
        "function-depth-23",
        "both refuse to compile; production answers one issue, `Maximum allowed call depth of 20 is reached for [f0->f1->...->f20] call stack.` at 24:12 (the declaration of f21); Firenook answers `maximum allowed function call depth of 20 is exceeded` at 1:1 for each of f0 and f1",
    ),
    (
        "linear-expression-terms-60",
        "production answers 500 INTERNAL `Internal error encountered.` (backendError); Firenook compiles and allows",
    ),
    (
        "linear-expression-terms-70",
        "production answers 500 INTERNAL `Internal error encountered.` (backendError); Firenook compiles and allows",
    ),
    (
        "linear-expression-terms-80",
        "production answers 500 INTERNAL `Internal error encountered.` (backendError); Firenook compiles and allows",
    ),
    (
        "linear-expression-terms-90",
        "production answers 500 INTERNAL `Internal error encountered.` (backendError); Firenook compiles and allows",
    ),
    (
        "linear-expression-terms-100",
        "production refuses to compile, `Expression is too complex to evaluate safely.` (4 issues, the first at 5:21); Firenook has no such limit, compiles and allows (not implemented)",
    ),
    (
        "balanced-expression-terms-150",
        "both deny with `maximum of 1000 expressions to evaluate has been reached`; production stops at 15:116 (inside leaf12), Firenook at 24:33 (the call `leaf12()`): the budget is spent at another expression",
    ),
    (
        "balanced-expression-terms-175",
        "both deny with `maximum of 1000 expressions to evaluate has been reached`; production stops at 15:89 (inside leaf12), Firenook at 33:33 (the call `branch0_6()`): the budget is spent at another expression",
    ),
    (
        "balanced-expression-terms-200",
        "both deny with `maximum of 1000 expressions to evaluate has been reached`; production stops at 15:89 (inside leaf12), Firenook at 36:33 (the call `branch0_6()`): the budget is spent at another expression",
    ),
    (
        "balanced-expression-terms-225",
        "both deny with `maximum of 1000 expressions to evaluate has been reached`; production stops at 15:89 (inside leaf12), Firenook at 40:33 (the call `branch0_6()`): the budget is spent at another expression",
    ),
    (
        "balanced-expression-terms-250",
        "both deny with `maximum of 1000 expressions to evaluate has been reached`; production stops at 15:89 (inside leaf12), Firenook at 43:33 (the call `branch0_6()`): the budget is spent at another expression",
    ),
    (
        "balanced-expression-terms-300",
        "both deny with `maximum of 1000 expressions to evaluate has been reached`; production stops at 15:89 (inside leaf12), Firenook at 51:33 (the call `branch0_6()`): the budget is spent at another expression",
    ),
];

/// What `projects.test` answered for one probe, or what Firenook does with
/// it, in the terms both can be compared in.
#[derive(Debug, PartialEq)]
enum ProbeAnswer {
    /// Compiled and the request was allowed.
    Allowed,
    /// Compiled, and evaluation failed with this message at this line and
    /// column.
    Failed(String, usize, usize),
    /// Refused to compile with these issues (line, column, message).
    Refused(Vec<(usize, usize, String)>),
    /// No verdict: the API itself failed with this HTTP status and message.
    Unanswered(u64, String),
}

/// Production's answer, from the recording.
fn recorded_probe(observation: &JsonValue) -> ProbeAnswer {
    let response = &observation["response"];
    if observation["httpStatus"] != 200 {
        return ProbeAnswer::Unanswered(
            observation["httpStatus"].as_u64().expect("status"),
            response["error"]["message"]
                .as_str()
                .expect("message")
                .to_owned(),
        );
    }
    if let Some(issues) = response["issues"].as_array() {
        return ProbeAnswer::Refused(
            issues
                .iter()
                .map(|issue| {
                    let at = &issue["sourcePosition"];
                    (
                        usize::try_from(at["line"].as_u64().expect("line")).expect("line"),
                        usize::try_from(at["column"].as_u64().expect("column")).expect("column"),
                        issue["description"]
                            .as_str()
                            .expect("description")
                            .to_owned(),
                    )
                })
                .collect(),
        );
    }
    let result = &response["testResults"][0];
    if result["state"] == "SUCCESS" {
        return ProbeAnswer::Allowed;
    }
    // `Error: firestore.rules line [L], column [C]. Unable to evaluate the
    // expression as the <message>.` names the error position recorded
    // beside it.
    let [debug] = result["debugMessages"]
        .as_array()
        .expect("debug")
        .as_slice()
    else {
        panic!("one debug message: {result}");
    };
    let at = &result["errorPosition"];
    let (line, column) = (
        usize::try_from(at["line"].as_u64().expect("line")).expect("line"),
        usize::try_from(at["column"].as_u64().expect("column")).expect("column"),
    );
    let message = debug
        .as_str()
        .expect("debug")
        .strip_prefix(&format!(
            "Error: firestore.rules line [{line}], column [{column}]. Unable to evaluate the expression as the "
        ))
        .and_then(|message| message.strip_suffix('.'))
        .expect("production's debug message shape");
    ProbeAnswer::Failed(message.to_owned(), line, column)
}

/// Firenook's answer: the source compiled, then evaluated with the test
/// case the capture sent with every limit probe
/// (`conformance/src/rules/capture-phase3-boundaries.ts`).
fn firenook_probe(source: &str) -> ProbeAnswer {
    let rules = match compile(source) {
        Ok(rules) => rules,
        Err(diagnostics) => {
            return ProbeAnswer::Refused(
                diagnostics
                    .into_iter()
                    .map(|diagnostic| (diagnostic.line, diagnostic.column, diagnostic.message))
                    .collect(),
            );
        }
    };
    let request = evaluation_request(
        &serde_json::json!({
            "auth": {"uid": "limit-probe", "token": {"n": 10_000}},
            "method": "get",
            "path": "/databases/(default)/documents/phase3/limit-probe",
            "time": "2026-01-01T00:00:00Z",
        }),
        None,
    );
    let result = rules.evaluate(&request, &EmptyDocumentAccess);
    if result.allowed {
        return ProbeAnswer::Allowed;
    }
    let error = result.error.expect("a probe fails with an error");
    let start = error
        .expression_key()
        .expect("the failing expression")
        .start;
    let before = &source[..start];
    ProbeAnswer::Failed(
        error.message,
        before.matches('\n').count() + 1,
        before.rsplit('\n').next().unwrap_or(before).chars().count() + 1,
    )
}

/// Every limit probe the two tests above do not note: compile and verdict
/// for an accepted source (production's expression reports are not a
/// Firenook surface, so an allowed probe is compared as a verdict), and the
/// message with its line and column for a refusal or an evaluation error.
#[test]
fn replays_the_remaining_frozen_limit_probes() {
    let fixture: JsonValue = serde_json::from_str(LIMIT_PROBES).expect("valid fixture");
    let mut differing = Vec::new();
    for observation in fixture["observations"].as_array().expect("observations") {
        let id = observation["id"].as_str().expect("id");
        // Noted by the two tests above.
        if matches!(
            id,
            "function-depth-22" | "balanced-expression-terms-100" | "balanced-expression-terms-125"
        ) {
            continue;
        }
        let recorded = recorded_probe(observation);
        let actual = firenook_probe(observation["source"].as_str().expect("source"));
        let case = format!("limit-probes/{id}");
        match (&recorded, &actual) {
            (ProbeAnswer::Allowed, ProbeAnswer::Allowed) => {
                ledger::checked(PRODUCTION_SET, &case, ledger::Compared::Verdict);
            }
            _ if recorded == actual => {
                ledger::checked(PRODUCTION_SET, &case, ledger::Compared::Error);
            }
            _ => {
                eprintln!("{id}: production {recorded:?}, Firenook {actual:?}");
                differing.push(id);
            }
        }
    }
    assert_eq!(
        differing,
        LIMIT_BUG_CANDIDATES
            .iter()
            .map(|(id, _)| *id)
            .collect::<Vec<_>>(),
        "every listed bug candidate still differs, and nothing else does"
    );
}

#[test]
fn enforces_access_limits_cache_and_atomic_accounting() {
    let fixture: JsonValue = serde_json::from_str(JAVA_ACCESS).expect("valid fixture");
    let rules = compile(fixture["rulesSource"].as_str().expect("rules source"))
        .expect("Java access rules should compile");
    let mut documents = BTreeMap::new();
    for prefix in ["a", "e", "b"] {
        for index in 0..=21 {
            let path = format!("/databases/(default)/documents/access/{prefix}{index}");
            documents.insert(
                path.clone(),
                Resource::new(
                    path,
                    BTreeMap::from([("allowed".to_owned(), Value::Bool(true))]),
                ),
            );
        }
    }
    let access = FixtureAccess {
        current: documents,
        after: BTreeMap::new(),
    };

    for (id, expected_allowed, expected_accesses, expected_hits) in [
        ("probe/access-10", true, 10, 0),
        ("probe/access-11", false, 10, 0),
        ("probe/cached-11", true, 1, 10),
        ("probe/exists-10", true, 10, 0),
        ("probe/exists-11", false, 10, 0),
    ] {
        let request = EvaluationRequest::new(
            RequestOperation::Get,
            format!("/databases/(default)/documents/{id}"),
            Timestamp::new(0, 0),
        );
        let result = rules.evaluate(&request, &access);
        assert_eq!(result, rules.evaluate_with_trace(&request, &access).0);
        assert_eq!(result.allowed, expected_allowed, "{id}: {result:?}");
        assert_eq!(result.document_accesses, expected_accesses, "{id}");
        assert_eq!(result.document_cache_hits, expected_hits, "{id}");
        ledger_java_verdict(&fixture, "java-access-accounting", id, result.allowed);
    }

    let batch_20 = batch_requests(20);
    let result = rules.evaluate_atomic(&batch_20, &access);
    assert_eq!(
        result,
        rules.evaluate_atomic_with_trace(&batch_20, &access).0
    );
    assert!(result.allowed, "{result:?}");
    assert_eq!(result.document_accesses, 20);
    ledger_java_verdict(
        &fixture,
        "java-access-accounting",
        "batch-20-distinct-access-calls",
        result.allowed,
    );

    let batch_21 = batch_requests(21);
    let result = rules.evaluate_atomic(&batch_21, &access);
    assert_eq!(
        result,
        rules.evaluate_atomic_with_trace(&batch_21, &access).0
    );
    assert!(!result.allowed, "{result:?}");
    assert_eq!(result.document_accesses, 20);
    assert!(result.operations[20].error.is_some());
    ledger_java_verdict(
        &fixture,
        "java-access-accounting",
        "batch-21-distinct-access-calls",
        result.allowed,
    );
}

#[test]
fn get_after_uses_the_atomic_pending_snapshot() {
    let fixture: JsonValue = serde_json::from_str(JAVA_ACCESS).expect("valid fixture");
    let rules = compile(fixture["rulesSource"].as_str().expect("rules source"))
        .expect("Java access rules should compile");
    let counter_path = "/databases/(default)/documents/state/counter";
    let old_counter = Resource::new(
        counter_path,
        BTreeMap::from([("version".to_owned(), Value::Integer(0))]),
    );
    let new_counter = Resource::new(
        counter_path,
        BTreeMap::from([("version".to_owned(), Value::Integer(1))]),
    );
    let access = FixtureAccess {
        current: BTreeMap::from([(counter_path.to_owned(), old_counter.clone())]),
        after: BTreeMap::from([(counter_path.to_owned(), new_counter.clone())]),
    };
    let mut counter_update =
        EvaluationRequest::new(RequestOperation::Update, counter_path, Timestamp::new(0, 0));
    counter_update.resource = Some(old_counter);
    counter_update.request_resource = Some(new_counter);
    let mut dependent_create = EvaluationRequest::new(
        RequestOperation::Create,
        "/databases/(default)/documents/atomic/item",
        Timestamp::new(0, 0),
    );
    dependent_create.request_resource = Some(Resource::new(
        "/databases/(default)/documents/atomic/item",
        BTreeMap::from([("expectedVersion".to_owned(), Value::Integer(1))]),
    ));
    let result =
        rules.evaluate_atomic(&[counter_update.clone(), dependent_create.clone()], &access);
    assert!(result.allowed, "{result:?}");
    assert_eq!(result.document_accesses, 1);
    let recorded: JsonValue = serde_json::from_str(JAVA_GET_AFTER).expect("valid fixture");
    ledger_java_verdict(
        &recorded,
        "java-get-after",
        "get-after-sees-pending-write",
        result.allowed,
    );

    dependent_create.request_resource = Some(Resource::new(
        "/databases/(default)/documents/atomic/item",
        BTreeMap::from([("expectedVersion".to_owned(), Value::Integer(0))]),
    ));
    let result = rules.evaluate_atomic(&[counter_update, dependent_create], &access);
    assert!(!result.allowed, "{result:?}");
    ledger_java_verdict(
        &recorded,
        "java-get-after",
        "get-after-denies-stale-invariant",
        result.allowed,
    );
}

#[test]
fn converts_the_frozen_runtime_errors_to_denials() {
    let fixture: JsonValue = serde_json::from_str(JAVA_ACCESS).expect("valid fixture");
    let recorded: JsonValue = serde_json::from_str(JAVA_RUNTIME_ERRORS).expect("valid fixture");
    let rules = compile(fixture["rulesSource"].as_str().expect("rules source"))
        .expect("Java runtime rules should compile");
    for id in [
        "runtime/missing-field",
        "runtime/division-zero",
        "runtime/list-out-of-bounds",
        "runtime/wrong-type-method",
        "runtime/missing-get-resource",
    ] {
        let mut request = EvaluationRequest::new(
            RequestOperation::Get,
            format!("/databases/(default)/documents/{id}"),
            Timestamp::new(0, 0),
        );
        request.resource = Some(Resource::new(
            format!("/databases/(default)/documents/{id}"),
            BTreeMap::from([("ordinal".to_owned(), Value::Integer(7))]),
        ));
        let result = rules.evaluate(&request, &EmptyDocumentAccess);
        assert!(!result.allowed, "{id}: {result:?}");
        assert!(result.error.is_some(), "{id}: {result:?}");
        ledger_java_verdict(&recorded, "java-runtime-errors", id, result.allowed);
    }
}

fn batch_requests(count: usize) -> Vec<EvaluationRequest> {
    (0..count)
        .map(|index| {
            EvaluationRequest::new(
                RequestOperation::Create,
                format!("/databases/(default)/documents/batch/b{index}"),
                Timestamp::new(0, 0),
            )
        })
        .collect()
}

fn evaluation_request(request: &JsonValue, existing: Option<&JsonValue>) -> EvaluationRequest {
    let operation = match request["method"].as_str().expect("request method") {
        "get" => RequestOperation::Get,
        "list" => RequestOperation::List,
        "create" => RequestOperation::Create,
        "update" => RequestOperation::Update,
        "delete" => RequestOperation::Delete,
        other => panic!("unknown request method {other}"),
    };
    let mut evaluation = EvaluationRequest::new(
        operation,
        request["path"].as_str().expect("request path"),
        Timestamp::parse_rfc3339(request["time"].as_str().expect("request time"))
            .expect("valid request time"),
    );
    evaluation.auth = request
        .get("auth")
        .filter(|auth| !auth.is_null())
        .map(|auth| Auth {
            uid: Some(auth["uid"].as_str().expect("auth uid").to_owned()),
            token: json_map(&auth["token"]),
        });
    evaluation.resource = existing.filter(|value| !value.is_null()).map(resource);
    evaluation.request_resource = request
        .get("resource")
        .filter(|value| !value.is_null())
        .map(resource);
    if let Some(query) = request.get("query") {
        evaluation.query = Query {
            limit: query.get("limit").and_then(JsonValue::as_i64),
            offset: query.get("offset").and_then(JsonValue::as_i64),
            ..Query::default()
        };
    }
    evaluation
}

fn resource(value: &JsonValue) -> Resource {
    Resource::new(
        value["__name__"].as_str().expect("resource name"),
        json_map(&value["data"]),
    )
}

fn json_map(value: &JsonValue) -> BTreeMap<String, Value> {
    value
        .as_object()
        .expect("JSON map")
        .iter()
        .map(|(key, value)| (key.clone(), json_value(value)))
        .collect()
}

fn json_value(value: &JsonValue) -> Value {
    match value {
        JsonValue::Null => Value::Null,
        JsonValue::Bool(value) => Value::Bool(*value),
        JsonValue::Number(value) => value.as_i64().map_or_else(
            || Value::Float(value.as_f64().expect("finite JSON number")),
            Value::Integer,
        ),
        JsonValue::String(value) => Value::String(value.clone()),
        JsonValue::Array(values) => Value::List(values.iter().map(json_value).collect()),
        JsonValue::Object(_) => Value::Map(json_map(value)),
    }
}

struct FixtureAccess {
    current: BTreeMap<String, Resource>,
    after: BTreeMap<String, Resource>,
}

impl DocumentAccess for FixtureAccess {
    fn get(&self, path: &str) -> Result<Option<Resource>, DocumentAccessError> {
        Ok(self.current.get(path).cloned())
    }

    fn get_after(&self, path: &str) -> Result<Option<Resource>, DocumentAccessError> {
        Ok(self.after.get(path).cloned())
    }
}
