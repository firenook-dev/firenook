//! Explained evaluation: inline values, editor positions and the list query
//! reason. Constructed policy cases, not oracle captures; every case also
//! checks that explaining a decision does not change it.

use std::collections::BTreeMap;

use firenook_rules_engine::{
    AllowDecision, Auth, ConstraintOperator, DocumentAccess, DocumentAccessError,
    EmptyDocumentAccess, EvaluationExplanation, EvaluationRequest, EvaluationResult,
    FieldConstraint, MAXIMUM_EXPLANATION_STEPS, QueryFilter, QueryScope, RequestOperation,
    Resource, Ruleset, Timestamp, Value, compile,
};

fn explain(
    rules: &Ruleset,
    request: &EvaluationRequest,
    access: &impl DocumentAccess,
) -> (EvaluationResult, EvaluationExplanation) {
    let explained = rules.explainer().evaluate(request, access);
    assert_eq!(
        explained.0,
        rules.evaluate(request, access),
        "explaining must not change the decision"
    );
    assert_eq!(
        explained.0,
        rules.evaluate_with_trace(request, access).0,
        "explaining must not change the decision"
    );
    explained
}

fn signed_in(request: &mut EvaluationRequest, uid: &str) {
    request.auth = Some(Auth {
        uid: Some(uid.to_owned()),
        token: BTreeMap::from([("sub".to_owned(), Value::from(uid))]),
    });
}

/// UTF-16 offset of a byte offset, the way an editor counts.
fn utf16(source: &str, byte: usize) -> usize {
    source[..byte].encode_utf16().count()
}

/// The step for the first occurrence of `text` in the source after `after`.
fn step<'e>(
    source: &str,
    explanation: &'e EvaluationExplanation,
    text: &str,
    after: &str,
) -> &'e firenook_rules_engine::ExplanationStep {
    let base = source.find(after).expect("anchor");
    let start = base + source[base..].find(text).expect("expression");
    let (from, to) = (utf16(source, start), utf16(source, start + text.len()));
    explanation
        .steps
        .iter()
        .find(|step| step.span.from == from && step.span.to == to)
        .unwrap_or_else(|| panic!("no step for {text:?} in {:#?}", explanation.steps))
}

const OWNER_RULES: &str = "rules_version = '2';
// Règles de démonstration 😀: the comment makes UTF-16 offsets differ from bytes.
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId} {
      allow get: if request.auth.uid == userId;
    }
  }
}
";

#[test]
fn a_denied_get_shows_each_operand_and_the_comparison_in_utf16_positions() {
    let rules = compile(OWNER_RULES).expect("compiles");
    let mut request = EvaluationRequest::new(
        RequestOperation::Get,
        "/databases/(default)/documents/users/u1",
        Timestamp::new(1_760_000_000, 0),
    );
    signed_in(&mut request, "u2");
    let (result, explanation) = explain(&rules, &request, &EmptyDocumentAccess);
    assert!(!result.allowed);
    let anchor = "allow get";
    let uid = step(OWNER_RULES, &explanation, "request.auth.uid", anchor);
    assert_eq!(uid.value, "\"u2\"");
    assert!(!uid.error);
    assert_eq!(uid.span.line, 6);
    let wildcard = step(OWNER_RULES, &explanation, "userId", anchor);
    assert_eq!(wildcard.value, "\"u1\"");
    let comparison = step(
        OWNER_RULES,
        &explanation,
        "request.auth.uid == userId",
        anchor,
    );
    assert_eq!(comparison.value, "false");
    // The positions are UTF-16 and really differ from the byte offsets here.
    let byte_start = OWNER_RULES.find("request.auth.uid ==").expect("present");
    assert_ne!(comparison.span.from, byte_start);
    assert_eq!(comparison.span.from, utf16(OWNER_RULES, byte_start));
    let auth = step(OWNER_RULES, &explanation, "request.auth", anchor);
    assert_eq!(auth.value, "{uid: \"u2\", token: {…}}");
    let request_step = step(OWNER_RULES, &explanation, "request", anchor);
    assert_eq!(request_step.value, "request(get users/u1)");
    // Operands come before the expression that uses them.
    let order = |text: &str| {
        let step = step(OWNER_RULES, &explanation, text, anchor);
        explanation
            .steps
            .iter()
            .position(|candidate| candidate == step)
            .expect("listed")
    };
    assert!(order("request.auth.uid") < order("request.auth.uid == userId"));
    assert!(order("userId") < order("request.auth.uid == userId"));
    // The allow condition is placed on its source too.
    assert_eq!(explanation.allows.len(), 1);
    let condition = explanation.allows[0];
    assert_eq!(condition.decision, AllowDecision::Deny);
    assert_eq!(condition.condition, comparison.span);
    assert!(!explanation.truncated);
    assert_eq!(explanation.query_reason, None);
}

#[test]
fn an_unauthenticated_get_shows_auth_null_and_the_error_it_causes() {
    let rules = compile(OWNER_RULES).expect("compiles");
    let request = EvaluationRequest::new(
        RequestOperation::Get,
        "/databases/(default)/documents/users/u1",
        Timestamp::new(1_760_000_000, 0),
    );
    let (result, explanation) = explain(&rules, &request, &EmptyDocumentAccess);
    assert!(!result.allowed);
    assert!(result.error.is_some());
    let anchor = "allow get";
    assert_eq!(
        step(OWNER_RULES, &explanation, "request.auth", anchor).value,
        "null"
    );
    let uid = step(OWNER_RULES, &explanation, "request.auth.uid", anchor);
    assert!(uid.error, "{uid:?}");
    assert_eq!(
        Some(uid.value.as_str()),
        result.error.as_ref().map(|error| error.message.as_str())
    );
    assert_eq!(explanation.allows[0].decision, AllowDecision::Error);
}

#[test]
fn a_function_called_twice_is_shown_twice() {
    let source = "rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function isUser(uid) { return request.auth.uid == uid; }
    match /items/{item} {
      allow get: if isUser('a') || isUser('b');
    }
  }
}
";
    let rules = compile(source).expect("compiles");
    let mut request = EvaluationRequest::new(
        RequestOperation::Get,
        "/databases/(default)/documents/items/one",
        Timestamp::new(0, 0),
    );
    signed_in(&mut request, "b");
    let (result, explanation) = explain(&rules, &request, &EmptyDocumentAccess);
    assert!(result.allowed);
    let start = source.find("request.auth.uid == uid").expect("present");
    let (from, to) = (
        utf16(source, start),
        utf16(source, start + "request.auth.uid == uid".len()),
    );
    let values = explanation
        .steps
        .iter()
        .filter(|step| step.span.from == from && step.span.to == to)
        .map(|step| step.value.as_str())
        .collect::<Vec<_>>();
    assert_eq!(values, ["false", "true"]);
}

#[test]
fn an_explanation_stops_at_its_cap_and_says_so() {
    let elements = vec!["request.path"; 300].join(", ");
    let source = format!(
        "rules_version = '2'; service cloud.firestore {{ match /databases/{{database}}/documents/items/{{item}} {{ allow get: if [{elements}].size() > 0; }} }}"
    );
    let rules = compile(&source).expect("compiles");
    let request = EvaluationRequest::new(
        RequestOperation::Get,
        "/databases/(default)/documents/items/one",
        Timestamp::new(0, 0),
    );
    let (result, explanation) = explain(&rules, &request, &EmptyDocumentAccess);
    assert!(result.allowed, "{result:?}");
    assert!(explanation.truncated);
    assert_eq!(explanation.steps.len(), MAXIMUM_EXPLANATION_STEPS);
    // The allow trace is not part of the cap.
    assert_eq!(explanation.allows.len(), 1);
    assert_eq!(explanation.allows[0].decision, AllowDecision::Allow);
}

struct Admins;
impl DocumentAccess for Admins {
    fn get(&self, path: &str) -> Result<Option<Resource>, DocumentAccessError> {
        Ok(path.ends_with("/admins/u1").then(|| {
            Resource::new(
                path,
                BTreeMap::from([("level".to_owned(), Value::Integer(3))]),
            )
        }))
    }
    fn get_after(&self, path: &str) -> Result<Option<Resource>, DocumentAccessError> {
        self.get(path)
    }
}

#[test]
fn document_reads_are_counted_and_shown() {
    let source = "rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /reports/{report} {
      allow get: if exists(/databases/$(database)/documents/admins/$(request.auth.uid))
        && get(/databases/$(database)/documents/admins/$(request.auth.uid)).data.level > 2
        && !exists(/databases/$(database)/documents/banned/$(request.auth.uid));
    }
  }
}
";
    let rules = compile(source).expect("compiles");
    let mut request = EvaluationRequest::new(
        RequestOperation::Get,
        "/databases/(default)/documents/reports/r1",
        Timestamp::new(0, 0),
    );
    signed_in(&mut request, "u1");
    let (result, explanation) = explain(&rules, &request, &Admins);
    assert!(result.allowed, "{result:?}");
    // exists() and get() of the same document share one billed read.
    assert_eq!(result.document_accesses, 2);
    assert_eq!(result.document_cache_hits, 1);
    let anchor = "allow get";
    assert_eq!(
        step(
            source,
            &explanation,
            "exists(/databases/$(database)/documents/admins/$(request.auth.uid))",
            anchor
        )
        .value,
        "true"
    );
    assert_eq!(
        step(
            source,
            &explanation,
            "get(/databases/$(database)/documents/admins/$(request.auth.uid))",
            anchor
        )
        .value,
        "resource(admins/u1)"
    );
    assert_eq!(
        step(
            source,
            &explanation,
            "/databases/$(database)/documents/admins/$(request.auth.uid)",
            anchor
        )
        .value,
        "/databases/(default)/documents/admins/u1"
    );
}

const LIST_RULES: &str = "rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /orders/{orderId} {
      allow list: if request.auth != null
        && resource.data.owner == request.auth.uid;
    }
  }
}
";

fn list(filter: Option<QueryFilter>) -> EvaluationRequest {
    let mut request = EvaluationRequest::new(
        RequestOperation::List,
        "/databases/(default)/documents/orders/rules-candidate",
        Timestamp::new(0, 0),
    );
    request.query.scope = Some(QueryScope::Collection("orders".to_owned()));
    request.query.filter = filter;
    signed_in(&mut request, "u1");
    request
}

fn owner(operator: ConstraintOperator, value: &str) -> QueryFilter {
    QueryFilter::Field(FieldConstraint {
        field: vec!["owner".to_owned()],
        operator,
        value: Value::from(value),
    })
}

#[test]
fn a_list_without_the_owner_filter_is_told_which_filter_it_needs() {
    let rules = compile(LIST_RULES).expect("compiles");
    let (result, explanation) = explain(&rules, &list(None), &EmptyDocumentAccess);
    assert!(!result.allowed);
    let reason = explanation.query_reason.clone().expect("a reason");
    assert_eq!(
        reason,
        "The query must filter on owner: the rule at line 6 needs resource.data.owner == request.auth.uid for every result. Add where('owner', '==', \"u1\")."
    );
    let anchor = "allow list";
    assert_eq!(
        step(LIST_RULES, &explanation, "resource.data.owner", anchor).value,
        "query: owner unconstrained"
    );
    assert_eq!(
        step(LIST_RULES, &explanation, "resource.data", anchor).value,
        "query: any result's data"
    );
    assert_eq!(
        step(
            LIST_RULES,
            &explanation,
            "resource.data.owner == request.auth.uid",
            anchor
        )
        .value,
        "query: unproven"
    );
}

#[test]
fn a_provable_list_needs_no_reason() {
    let rules = compile(LIST_RULES).expect("compiles");
    let (result, explanation) = explain(
        &rules,
        &list(Some(owner(ConstraintOperator::Equal, "u1"))),
        &EmptyDocumentAccess,
    );
    assert!(result.allowed, "{result:?}");
    assert_eq!(explanation.query_reason, None);
    assert_eq!(
        step(
            LIST_RULES,
            &explanation,
            "resource.data.owner",
            "allow list"
        )
        .value,
        "query: owner == \"u1\""
    );
}

#[test]
fn a_list_filtering_on_another_owner_is_told_it_contradicts_the_rule() {
    let rules = compile(LIST_RULES).expect("compiles");
    let (result, explanation) = explain(
        &rules,
        &list(Some(owner(ConstraintOperator::Equal, "u2"))),
        &EmptyDocumentAccess,
    );
    assert!(!result.allowed);
    let reason = explanation.query_reason.expect("a reason");
    assert!(
        reason.starts_with(
            "The query's filter on owner (owner == \"u2\") contradicts the rule at line 6"
        ),
        "{reason}"
    );
    assert!(
        reason.ends_with("Use where('owner', '==', \"u1\")."),
        "{reason}"
    );
}

#[test]
fn a_list_with_a_weaker_filter_is_told_the_filter_does_not_guarantee_the_rule() {
    let source = "rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /posts/{post} {
      allow list: if resource.data.score > 10 || resource.data.public == true;
    }
  }
}
";
    let rules = compile(source).expect("compiles");
    let mut request = list(Some(QueryFilter::Field(FieldConstraint {
        field: vec!["score".to_owned()],
        operator: ConstraintOperator::Greater,
        value: Value::Integer(5),
    })));
    request.path = "/databases/(default)/documents/posts/rules-candidate".to_owned();
    request.query.scope = Some(QueryScope::Collection("posts".to_owned()));
    let (result, explanation) = explain(&rules, &request, &EmptyDocumentAccess);
    assert!(!result.allowed);
    let reason = explanation.query_reason.expect("a reason");
    assert_eq!(
        reason,
        "The query's filter on score (score > 5) does not guarantee the rule at line 5, which needs resource.data.score > 10 for every result. Use where('score', '>', 10). Alternatively, the rule at line 5 accepts where('public', '==', true)."
    );
}

#[test]
fn an_unprovable_collection_group_path_gets_a_general_reason() {
    let source = "rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{prefix=**}/orders/{orderId} {
      allow list: if prefix == /users/$(request.auth.uid);
    }
  }
}
";
    let rules = compile(source).expect("compiles");
    let mut request = list(None);
    request.query.scope = Some(QueryScope::CollectionGroup {
        collection_id: "orders".to_owned(),
        ancestor: None,
    });
    let (result, explanation) = explain(&rules, &request, &EmptyDocumentAccess);
    assert!(!result.allowed);
    let reason = explanation.query_reason.expect("a reason");
    assert!(
        reason.starts_with("The rule at line 5 cannot be proven for every document this query may return: prefix == /users/$(request.auth.uid) depends on"),
        "{reason}"
    );
}

#[test]
fn a_denial_the_query_cannot_change_has_no_query_reason() {
    let rules = compile(LIST_RULES).expect("compiles");
    let mut request = list(Some(owner(ConstraintOperator::Equal, "u1")));
    request.auth = None;
    let (result, explanation) = explain(&rules, &request, &EmptyDocumentAccess);
    assert!(!result.allowed);
    assert_eq!(explanation.query_reason, None);
}

#[test]
fn the_frozen_complex_ruleset_explains_without_changing_any_decision() {
    let rules = compile(include_str!(
        "../../../conformance/fixtures/rules-v2/complex-firestore.rules"
    ))
    .expect("compiles");
    for (operation, path) in [
        (
            RequestOperation::Get,
            "/databases/(default)/documents/users/u1",
        ),
        (
            RequestOperation::Create,
            "/databases/(default)/documents/templates/t1",
        ),
        (
            RequestOperation::Update,
            "/databases/(default)/documents/users/u1",
        ),
        (
            RequestOperation::Delete,
            "/databases/(default)/documents/anything/else",
        ),
    ] {
        for uid in [None, Some("u1")] {
            let mut request = EvaluationRequest::new(operation, path, Timestamp::new(0, 0));
            if let Some(uid) = uid {
                signed_in(&mut request, uid);
            }
            request.resource = Some(Resource::new(
                path,
                BTreeMap::from([("owner".to_owned(), Value::from("u1"))]),
            ));
            request.request_resource = request.resource.clone();
            let (_, explanation) = explain(&rules, &request, &EmptyDocumentAccess);
            assert!(explanation.steps.len() <= MAXIMUM_EXPLANATION_STEPS);
        }
    }
}
