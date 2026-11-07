//! The conditional operator `c ? a : b`. Every verdict below was recorded
//! from the official emulator (firebase-tools 15.34.0) with
//! `@firebase/rules-unit-testing`.

use std::collections::BTreeMap;

use firenook_rules_engine::{
    Auth, ConstraintOperator, EmptyDocumentAccess, EvaluationRequest, FieldConstraint, Query,
    QueryFilter, QueryScope, RequestOperation, Timestamp, Value, compile,
};

fn allows(operation: &str, condition: &str, request: &EvaluationRequest) -> bool {
    let source = format!(
        "rules_version = '2'; service cloud.firestore {{
           match /databases/{{database}}/documents {{
             match /notes/{{id}} {{ allow {operation}: if {condition}; }}
           }}
         }}"
    );
    compile(&source)
        .unwrap_or_else(|error| panic!("{condition}: {error:?}"))
        .evaluate(request, &EmptyDocumentAccess)
        .allowed
}

#[test]
fn a_get_takes_one_branch_of_a_boolean_condition() {
    // Signed out, so `request.auth.uid` is an error.
    let request = EvaluationRequest::new(
        RequestOperation::Get,
        "/databases/(default)/documents/notes/n1",
        Timestamp::new(1, 0),
    );
    for (condition, allowed) in [
        ("true ? true : false", true),
        ("false ? true : false", false),
        ("true?true:false", true),
        // Looser than `||` and `&&`.
        ("true || false ? false : true", false),
        ("false && false ? false : true", true),
        // Groups to the right.
        ("true ? false : true ? true : true", false),
        ("true ? false ? false : true : false", true),
        // Only the taken branch is evaluated.
        ("true ? true : request.auth.uid == 'x'", true),
        ("false ? request.auth.uid == 'x' : true", true),
        ("request.auth.uid == 'x' ? true : true", false),
        ("(request.auth.uid == 'x' ? true : true) || true", true),
        // The condition must be a boolean.
        ("1 ? true : true", false),
        ("null ? true : true", false),
        ("'a' ? true : true", false),
        ("[] ? true : true", false),
        // A branch is any value.
        ("true ? 1 : 2", false),
        (
            "(request.auth == null ? 'anon' : request.auth.uid) == 'anon'",
            true,
        ),
        ("[1, 2][false ? 0 : 1] == 2", true),
        ("{'a': false ? 1 : 2}.a == 2", true),
        ("'abc'.size() == (true ? 3 : 4)", true),
    ] {
        assert_eq!(allows("get", condition, &request), allowed, "{condition}");
    }
}

#[test]
fn a_query_proof_takes_a_branch_only_when_the_filters_decide_the_condition() {
    let request = |owner: Option<&str>| {
        let mut request = EvaluationRequest::new(
            RequestOperation::List,
            "/databases/(default)/documents/notes/not-a-row",
            Timestamp::new(1, 0),
        );
        request.auth = Some(Auth {
            uid: Some("alice".to_owned()),
            token: BTreeMap::new(),
        });
        request.query = Query {
            filter: owner.map(|owner| {
                QueryFilter::Field(FieldConstraint {
                    field: vec!["owner".to_owned()],
                    operator: ConstraintOperator::Equal,
                    value: Value::from(owner),
                })
            }),
            scope: Some(QueryScope::Collection("notes".to_owned())),
            ..Query::default()
        };
        request
    };
    // Verdicts without a filter, with owner == 'alice', with owner == 'bob'.
    for (condition, allowed) in [
        ("request.auth != null ? true : false", [true, true, true]),
        (
            "resource.data.owner == request.auth.uid ? true : false",
            [false, true, false],
        ),
        (
            "request.auth != null ? resource.data.owner == request.auth.uid : false",
            [false, true, false],
        ),
        (
            "resource.data.owner == 'nobody' ? true : true",
            [false, true, true],
        ),
    ] {
        for (owner, allowed) in [None, Some("alice"), Some("bob")].into_iter().zip(allowed) {
            assert_eq!(
                allows("list", condition, &request(owner)),
                allowed,
                "{condition} with owner {owner:?}"
            );
        }
    }
}

#[test]
fn a_conditional_needs_its_colon() {
    let source = "rules_version = '2'; service cloud.firestore {
       match /databases/{database}/documents {
         match /notes/{id} { allow get: if true ? true; }
       }
     }";
    assert!(compile(source).is_err());
}
