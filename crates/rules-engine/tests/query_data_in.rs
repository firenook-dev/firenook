use std::collections::BTreeMap;

use firenook_rules_engine::{
    ConstraintOperator as Op, EmptyDocumentAccess, EvaluationRequest, FieldConstraint, Query,
    QueryFilter, QueryScope, RequestOperation, Resource, Timestamp, Value, compile,
};

fn allowed(condition: &str, operation: RequestOperation, filter: Option<QueryFilter>) -> bool {
    let source = format!(
        "rules_version = '2'; service cloud.firestore {{ match /databases/{{db}}/documents/records/{{id}} {{ allow get, list: if {condition}; }} }}"
    );
    let path = "/databases/(default)/documents/records/r1";
    let mut request = EvaluationRequest::new(operation, path, Timestamp::new(1, 0));
    if operation == RequestOperation::List {
        request.query = Query {
            filter,
            scope: Some(QueryScope::Collection("records".to_owned())),
            ..Query::default()
        };
    } else {
        request.resource = Some(Resource::new(
            path,
            BTreeMap::from([("f".to_owned(), Value::from("x"))]),
        ));
    }
    compile(&source)
        .expect("source")
        .evaluate(&request, &EmptyDocumentAccess)
        .allowed
}

fn on(field: &[&str], operator: Op, value: impl Into<Value>) -> QueryFilter {
    QueryFilter::Field(FieldConstraint {
        field: field.iter().map(|part| (*part).to_owned()).collect(),
        operator,
        value: value.into(),
    })
}

// Measured on the official emulator: a list query's `resource.data` holds the
// fields its filters name, with any operator, and no other field.
#[test]
fn a_key_is_in_query_data_exactly_when_a_filter_names_it() {
    let list = RequestOperation::List;
    for filter in [
        on(&["f"], Op::Equal, "x"),
        on(&["f"], Op::Equal, Value::Null),
        on(&["f"], Op::In, Value::List(vec!["x".into(), "y".into()])),
        on(&["f"], Op::NotEqual, "x"),
        on(&["f"], Op::Greater, "a"),
        on(&["f", "g"], Op::Equal, 1_i64),
    ] {
        let filter = Some(filter);
        assert!(
            allowed("'f' in resource.data", list, filter.clone()),
            "{filter:?}"
        );
        assert!(
            !allowed("!('f' in resource.data)", list, filter.clone()),
            "{filter:?}"
        );
    }
    for filter in [None, Some(on(&["g"], Op::Equal, "x"))] {
        assert!(
            !allowed("'f' in resource.data", list, filter.clone()),
            "{filter:?}"
        );
        assert!(
            allowed("!('f' in resource.data)", list, filter.clone()),
            "{filter:?}"
        );
    }
    let either = QueryFilter::Or(vec![on(&["f"], Op::Equal, "x"), on(&["g"], Op::Equal, "x")]);
    assert!(!allowed("'f' in resource.data", list, Some(either)));
    assert!(allowed("'f' in resource.data", RequestOperation::Get, None));
    assert!(!allowed(
        "'g' in resource.data",
        RequestOperation::Get,
        None
    ));
}
