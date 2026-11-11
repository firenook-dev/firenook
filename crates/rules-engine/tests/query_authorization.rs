use std::collections::BTreeMap;

use firenook_rules_engine::{
    Auth, ConstraintOperator as Op, DocumentAccess, DocumentAccessError, EmptyDocumentAccess,
    EvaluationRequest, FieldConstraint, Query, QueryFilter, QueryScope, RequestOperation, Resource,
    Timestamp, Value, compile,
};
use serde_json::Value as Json;

const RULES: &str = include_str!(
    "../../../conformance/fixtures/rules-v2/query-authorization/java-1.21.0/firestore.rules"
);
const ORACLES: [&str; 2] = [
    include_str!(
        "../../../conformance/fixtures/rules-v2/query-authorization/java-1.21.0/grpc.json"
    ),
    include_str!(
        "../../../conformance/fixtures/rules-v2/query-authorization/java-1.22.0/grpc.json"
    ),
];

struct Permissions;
impl DocumentAccess for Permissions {
    fn get(&self, path: &str) -> Result<Option<Resource>, DocumentAccessError> {
        // No presentation/result rows are available to the evaluator, including
        // in the positive cases. Only explicitly accessed rules documents exist.
        let uid = match path {
            "/databases/(default)/documents/permissions/granted"
            | "/databases/(default)/documents/permissions/granted2" => "query-owner",
            "/databases/(default)/documents/permissions/denied" => "other-owner",
            _ => return Ok(None),
        };
        Ok(Some(Resource::new(
            path,
            BTreeMap::from([("uid".to_owned(), Value::from(uid))]),
        )))
    }
    fn get_after(&self, path: &str) -> Result<Option<Resource>, DocumentAccessError> {
        self.get(path)
    }
}

fn value(json: &Json) -> Value {
    match json {
        Json::Null => Value::Null,
        Json::Bool(value) => Value::Bool(*value),
        Json::Number(value) => Value::Integer(value.as_i64().expect("integer seed")),
        Json::String(value) => Value::String(value.clone()),
        Json::Array(values) => Value::List(values.iter().map(value).collect()),
        Json::Object(_) => panic!("unexpected case operand"),
    }
}

fn filter(json: &Json) -> QueryFilter {
    if let Some(filters) = json["filters"].as_array() {
        let filters = filters.iter().map(filter).collect();
        return if json["op"] == "AND" {
            QueryFilter::And(filters)
        } else {
            QueryFilter::Or(filters)
        };
    }
    QueryFilter::Field(FieldConstraint {
        field: json["field"]
            .as_str()
            .expect("field")
            .split('.')
            .map(str::to_owned)
            .collect(),
        operator: match json["op"].as_str().expect("operator") {
            "==" => Op::Equal,
            "!=" => Op::NotEqual,
            ">" => Op::Greater,
            ">=" => Op::GreaterEqual,
            "<" => Op::Less,
            "<=" => Op::LessEqual,
            "in" => Op::In,
            "not-in" => Op::NotIn,
            "array-contains" => Op::ArrayContains,
            "array-contains-any" => Op::ArrayContainsAny,
            other => panic!("unknown operator {other}"),
        },
        value: value(&json["value"]),
    })
}

fn request(case: &Json) -> EvaluationRequest {
    let collection = case["collection"].as_str().expect("collection");
    let collection_path = case["parent"].as_str().map_or_else(
        || collection.to_owned(),
        |parent| format!("{parent}/{collection}"),
    );
    let mut request = EvaluationRequest::new(
        RequestOperation::List,
        format!("/databases/(default)/documents/{collection_path}/not-a-row"),
        Timestamp::new(1, 0),
    );
    request.auth = Some(Auth {
        uid: Some("query-owner".to_owned()),
        token: BTreeMap::from([(
            "email_verified".to_owned(),
            Value::Bool(case["unverified"] != true),
        )]),
    });
    request.query = Query {
        limit: case["limit"].as_i64(),
        offset: Some(case["offset"].as_i64().unwrap_or(0)),
        order_by: case["orderBy"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|order| {
                (
                    order[0].as_str().expect("field").to_owned(),
                    if order[1] == "desc" { "DESC" } else { "ASC" }.to_owned(),
                )
            })
            .collect(),
        filter: case.get("filter").map(filter),
        scope: Some(if case["group"] == true {
            QueryScope::CollectionGroup {
                collection_id: collection.to_owned(),
                ancestor: case["parent"].as_str().map(str::to_owned),
            }
        } else {
            QueryScope::Collection(collection_path)
        }),
    };
    request
}

/// What the official emulator decided in `conformance/fixtures/kindless-query-v1`.
#[test]
fn a_query_with_no_collection_needs_a_match_covering_the_whole_subtree() {
    let decide = |rule: &str, ancestor: Option<&str>| {
        let source = format!(
            "rules_version = '2';\nservice cloud.firestore {{ match /databases/{{database}}/documents {{ {rule} }} }}"
        );
        let rules = compile(&source).expect("rules");
        let mut request = request(&serde_json::json!({ "collection": "rules-candidate" }));
        request.query.scope = Some(QueryScope::AllDescendants {
            ancestor: ancestor.map(str::to_owned),
        });
        rules.evaluate(&request, &Permissions).allowed
    };
    for (rule, at_root, under_document) in [
        ("match /{document=**} { allow read: if true; }", true, true),
        ("match /{document=**} { allow list: if true; }", true, true),
        ("match /{document=**} { allow get: if true; }", false, false),
        (
            "match /{document=**} { allow read: if false; }",
            false,
            false,
        ),
        ("match /rd/{doc} { allow read: if true; }", false, false),
        (
            "match /{path=**}/sub/{doc} { allow read: if true; }",
            false,
            false,
        ),
        (
            "match /top/parent/{rest=**} { allow read: if true; }",
            false,
            true,
        ),
        (
            "match /top/{which}/{rest=**} { allow read: if which == 'parent'; }",
            false,
            true,
        ),
    ] {
        assert_eq!(decide(rule, None), at_root, "at the root: {rule}");
        assert_eq!(
            decide(rule, Some("top/parent")),
            under_document,
            "under a document: {rule}"
        );
    }
}

#[test]
fn replays_both_official_query_oracles_without_any_result_rows() {
    let rules = compile(RULES).expect("oracle source");
    // `conformance/src/report/cases.mjs` counts the 1.22.0 recording only.
    for (source, counted) in ORACLES.into_iter().zip([false, true]) {
        let oracle: Json = serde_json::from_str(source).expect("oracle JSON");
        for case in oracle["cases"].as_array().expect("cases") {
            let request = request(case);
            assert!(request.resource.is_none());
            let actual = rules.evaluate(&request, &Permissions);
            assert_eq!(
                actual,
                rules.evaluate_with_trace(&request, &Permissions).0,
                "query proof and accounting must not change when tracing is enabled: {}",
                case["id"]
            );
            let expected = oracle["observations"]
                .as_array()
                .expect("observations")
                .iter()
                .find(|observation| {
                    observation["id"] == case["id"] && observation["operation"] == "RunQuery"
                })
                .expect("native verdict");
            assert_eq!(
                actual.allowed,
                expected["code"] == 0,
                "{}: {actual:?}",
                case["id"]
            );
            if case["id"] == "owner-equality" || case["id"] == "short-circuit-missing-get" {
                assert_eq!(actual.document_accesses, 0, "short circuit must avoid get");
            }
            if case["id"] == "permission-in-all-granted" {
                assert_eq!(actual.document_accesses, 2);
            }
            if counted {
                firenook_conformance_ledger::checked(
                    "rules-v2/official-emulator",
                    &format!(
                        "query-authorization/{}/grpc/RunQuery",
                        case["id"].as_str().expect("id")
                    ),
                    firenook_conformance_ledger::Compared::Verdict,
                );
            }
        }
    }
}

#[test]
fn unknown_constraints_do_not_become_false_under_negation_or_type_tests() {
    let request = request(&serde_json::json!({"collection":"records"}));
    for condition in [
        "!(resource.data.createdBy == 'other')",
        "!(resource.data.createdBy is string)",
        "!(resource.data is map)",
        "!(resource is map)",
        "resource.data != {}",
        "resource.data.createdBy == null",
        "id == 'not-a-row'",
    ] {
        let source = format!(
            "rules_version = '2'; service cloud.firestore {{ match /databases/{{db}}/documents/records/{{id}} {{ allow list: if {condition}; }} }}"
        );
        let result = compile(&source)
            .expect("source")
            .evaluate(&request, &EmptyDocumentAccess);
        assert!(!result.allowed, "{condition}: {result:?}");
    }
}

#[test]
fn resource_is_never_null_in_a_query_proof() {
    let request = request(&serde_json::json!({
        "collection": "records",
        "filter": {"field": "createdBy", "op": "==", "value": "query-owner"}
    }));
    // Verdicts recorded from the official emulator (firebase-tools 15.31.0).
    for (condition, allowed) in [
        ("resource != null", true),
        ("null != resource", true),
        ("!(resource == null)", true),
        ("resource == null", false),
        (
            "resource == null || resource.data.createdBy == request.auth.uid",
            true,
        ),
    ] {
        let source = format!(
            "rules_version = '2'; service cloud.firestore {{ match /databases/{{db}}/documents/records/{{id}} {{ allow list: if {condition}; }} }}"
        );
        let result = compile(&source)
            .expect("source")
            .evaluate(&request, &EmptyDocumentAccess);
        assert_eq!(result.allowed, allowed, "{condition}: {result:?}");
    }
}

#[test]
fn alternatives_do_not_multiply_document_access_budgets() {
    struct Existing;
    impl DocumentAccess for Existing {
        fn get(&self, path: &str) -> Result<Option<Resource>, DocumentAccessError> {
            Ok(Some(Resource::new(path, BTreeMap::new())))
        }
        fn get_after(&self, path: &str) -> Result<Option<Resource>, DocumentAccessError> {
            self.get(path)
        }
    }
    let rules = compile(RULES).expect("source");
    let case = serde_json::json!({ "collection": "dynamicExists", "filter": {"field":"permissionId", "op":"in", "value": (0..11).map(|i| format!("permission-{i}")).collect::<Vec<_>>()}});
    let result = rules.evaluate(&request(&case), &Existing);
    assert!(!result.allowed);
    assert_eq!(result.document_accesses, 10);
    assert!(
        result
            .error
            .expect("budget error")
            .message
            .contains("access calls")
    );
}

#[test]
fn replays_query_path_oracles_without_resolving_child_wildcards_to_rows() {
    struct Parents;
    impl DocumentAccess for Parents {
        fn get(&self, path: &str) -> Result<Option<Resource>, DocumentAccessError> {
            let uid = match path {
                "/databases/(default)/documents/queryParents/granted"
                | "/databases/(default)/documents/queryParents/emptyGranted" => "query-owner",
                "/databases/(default)/documents/queryParents/denied" => "other-owner",
                path if path.starts_with("/databases/(default)/documents/queryBudget/p") => {
                    return Ok(Some(Resource::new(path, BTreeMap::new())));
                }
                _ => return Permissions.get(path),
            };
            Ok(Some(Resource::new(
                path,
                BTreeMap::from([("uid".to_owned(), Value::from(uid))]),
            )))
        }
        fn get_after(&self, path: &str) -> Result<Option<Resource>, DocumentAccessError> {
            self.get(path)
        }
    }
    let rules = compile(include_str!(
        "../../../conformance/fixtures/rules-v2/query-paths/java-1.21.0/firestore.rules"
    ))
    .expect("oracle source");
    for (source, counted) in [
        include_str!("../../../conformance/fixtures/rules-v2/query-paths/java-1.21.0/grpc.json"),
        include_str!("../../../conformance/fixtures/rules-v2/query-paths/java-1.22.0/grpc.json"),
    ]
    .into_iter()
    .zip([false, true])
    {
        let oracle: Json = serde_json::from_str(source).expect("oracle JSON");
        for case in oracle["cases"].as_array().expect("cases") {
            let actual = rules.evaluate(&request(case), &Parents);
            let expected = oracle["observations"]
                .as_array()
                .expect("observations")
                .iter()
                .find(|observation| {
                    observation["id"] == case["id"] && observation["operation"] == "RunQuery"
                })
                .expect("native verdict");
            assert_eq!(
                actual.allowed,
                expected["code"] == 0,
                "{}: {actual:?}",
                case["id"]
            );
            let id = case["id"].as_str().expect("id");
            if id.starts_with("path-unknownOnly-") || id.starts_with("path-literalOr-") {
                assert_eq!(
                    actual.document_accesses, 0,
                    "unknown paths must not be read"
                );
            }
            if id.starts_with("path-budgetErrorOr-") {
                assert_eq!(
                    actual.document_accesses, 10,
                    "the eleventh read must not run"
                );
            }
            if id == "path-members-granted" || id == "path-members-empty-granted" {
                assert_eq!(
                    actual.document_accesses, 1,
                    "only the concrete parent is read"
                );
            }
            if counted {
                firenook_conformance_ledger::checked(
                    "rules-v2/official-emulator",
                    &format!("query-paths/{id}/grpc/RunQuery"),
                    firenook_conformance_ledger::Compared::Verdict,
                );
            }
        }
    }
}

#[test]
fn get_reads_a_constrained_field_and_defaults_any_other() {
    let owner = serde_json::json!({"field": "createdBy", "op": "==", "value": "query-owner"});
    let other = serde_json::json!({"field": "createdBy", "op": "==", "value": "other-owner"});
    let either =
        serde_json::json!({"field": "createdBy", "op": "in", "value": ["query-owner", "carol"]});
    // Verdicts recorded from the official emulator (firebase-tools 15.31.0).
    for (condition, filter, allowed) in [
        (
            "resource.data.get('createdBy', '') == request.auth.uid",
            Some(&owner),
            true,
        ),
        (
            "resource.data.get('createdBy', '') == request.auth.uid",
            None,
            false,
        ),
        (
            "resource.data.get('createdBy', '') == request.auth.uid",
            Some(&other),
            false,
        ),
        (
            "resource.data.get('createdBy', 'query-owner') == request.auth.uid",
            None,
            true,
        ),
        (
            "resource.data.get('createdBy', '') != 'other-owner'",
            Some(&owner),
            true,
        ),
        (
            "resource.data.get('createdBy', '') in ['query-owner', 'carol']",
            Some(&either),
            true,
        ),
    ] {
        let mut case = serde_json::json!({"collection": "records"});
        if let Some(filter) = filter {
            case["filter"] = filter.clone();
        }
        let source = format!(
            "rules_version = '2'; service cloud.firestore {{ match /databases/{{db}}/documents/records/{{id}} {{ allow list: if {condition}; }} }}"
        );
        let result = compile(&source)
            .expect("source")
            .evaluate(&request(&case), &EmptyDocumentAccess);
        assert_eq!(
            result.allowed, allowed,
            "{condition} with {filter:?}: {result:?}"
        );
    }
}

/// Each list rule over a filter, or over no filter, against the verdict the
/// official emulator recorded (firebase-tools 15.34.0, Firestore 1.22.0).
fn assert_list_verdicts(cases: &[(&str, Option<Json>, bool)]) {
    for (condition, filter, allowed) in cases {
        let mut case = serde_json::json!({"collection": "records"});
        if let Some(filter) = filter {
            case["filter"] = filter.clone();
        }
        let source = format!(
            "rules_version = '2'; service cloud.firestore {{ match /databases/{{db}}/documents/records/{{id}} {{ allow list: if {condition}; }} }}"
        );
        let result = compile(&source)
            .expect("source")
            .evaluate(&request(&case), &EmptyDocumentAccess);
        assert_eq!(
            result.allowed, *allowed,
            "{condition} with {filter:?}: {result:?}"
        );
    }
}

fn on(field: &str, op: &str, value: Json) -> Json {
    let mut filter = serde_json::json!({"field": field, "op": op});
    filter["value"] = value;
    filter
}

/// Every filter but `IS_NULL` matches only documents where its field holds a
/// value, and a filter on a field inside one makes it a map, so the official
/// emulator takes any of them as proof that the field is not null. A null
/// member of `in` matches nothing and still names a value.
#[test]
fn any_filter_but_is_null_proves_its_field_is_not_null() {
    let rule = "resource.data.v != null";
    let any = |filters: Vec<Json>| serde_json::json!({"op": "OR", "filters": filters});
    assert_list_verdicts(&[
        (rule, Some(on("v", "!=", "a".into())), true),
        (rule, Some(on("v", ">", "a".into())), true),
        (
            rule,
            Some(on("v", "not-in", serde_json::json!(["a"]))),
            true,
        ),
        (rule, Some(on("v", "array-contains", "a".into())), true),
        (rule, Some(on("v", "in", serde_json::json!([null]))), true),
        (
            rule,
            Some(on("v", "in", serde_json::json!([null, "a"]))),
            true,
        ),
        (
            rule,
            Some(on("v", "not-in", serde_json::json!([null]))),
            true,
        ),
        (rule, Some(on("v.y", "!=", "a".into())), true),
        (rule, Some(on("v", "==", Json::Null)), false),
        (rule, Some(on("w", "==", 1.into())), false),
        (rule, None, false),
        (
            rule,
            Some(any(vec![
                on("v", "==", "a".into()),
                on("v", "!=", "b".into()),
            ])),
            true,
        ),
        (
            rule,
            Some(any(vec![
                on("v", "!=", "a".into()),
                on("v", "==", Json::Null),
            ])),
            false,
        ),
        (
            "resource.data.get('v', null) != null",
            Some(on("v", "!=", "a".into())),
            true,
        ),
        ("resource.data.get('v', null) != null", None, false),
        (
            "resource.data.m.x != null",
            Some(on("m.x", ">", "a".into())),
            true,
        ),
        (
            "resource.data.m.x != null",
            Some(on("m.x", "==", Json::Null)),
            false,
        ),
        (
            "'v' in resource.data",
            Some(on("v", "!=", "a".into())),
            true,
        ),
        (
            "resource.data.v is string",
            Some(on("v", "!=", "a".into())),
            false,
        ),
    ]);
}

/// `IS_NULL` alone proves a field null; a branch that also needs a value
/// there matches nothing, and each filter still proves what it says. A
/// filter on a field inside one proves it is a map, and so no string.
#[test]
fn is_null_proves_null_and_a_field_inside_proves_a_map() {
    let rule = "resource.data.v == null";
    let contradiction = serde_json::json!({"op": "AND", "filters": [on("v", "==", Json::Null), on("v", "!=", "a".into())]});
    let archived = "resource.data.v != null && resource.data.v != 'archived'";
    assert_list_verdicts(&[
        (rule, Some(on("v", "==", Json::Null)), true),
        (rule, Some(on("v", "in", serde_json::json!([null]))), false),
        (rule, Some(on("v", "!=", "a".into())), false),
        (rule, Some(contradiction.clone()), true),
        ("resource.data.v != null", Some(contradiction), true),
        (archived, Some(on("v", "<", "a".into())), true),
        (archived, Some(on("v.y", "!=", "a".into())), true),
        (archived, Some(on("v", "!=", "a".into())), false),
    ]);
}
