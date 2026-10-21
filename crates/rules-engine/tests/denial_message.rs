//! A refused request names the allows that refused it, as the official
//! emulator's denial does (`false for 'get' @ L4`), after the text
//! production answers. Replays the denials recorded in
//! `conformance/fixtures/request-identity-v1`.

use std::collections::BTreeMap;

use firenook_rules_engine::{
    Auth, EmptyDocumentAccess, EvaluationRequest, RequestOperation, Resource, Timestamp, Value,
    compile,
};
use serde_json::Value as JsonValue;

const FIXTURE: &str =
    include_str!("../../../conformance/fixtures/request-identity-v1/fixture.json");

const PRODUCTION: &str = "Missing or insufficient permissions.";

fn fixture() -> JsonValue {
    serde_json::from_str(FIXTURE).expect("fixture JSON")
}

fn alice() -> Auth {
    Auth {
        uid: Some("alice".to_owned()),
        token: BTreeMap::from([("sub".to_owned(), Value::from("alice"))]),
    }
}

fn request(operation: RequestOperation, path: &str, auth: Option<Auth>) -> EvaluationRequest {
    let mut request = EvaluationRequest::new(
        operation,
        format!("/databases/(default)/documents/{path}"),
        Timestamp::new(1_788_200_100, 0),
    );
    request.auth = auth;
    request
}

/// The rule lines a message names, without repeats.
fn lines(message: &str) -> Vec<String> {
    let mut lines = Vec::new();
    for part in message.split("@ L").skip(1) {
        let line: String = part.chars().take_while(char::is_ascii_digit).collect();
        if !lines.contains(&line) {
            lines.push(line);
        }
    }
    lines
}

#[test]
fn a_denial_names_the_allows_that_refused_it_as_the_official_emulator_does() {
    let fixture = fixture();
    let rules = compile(fixture["rules"].as_str().expect("rules")).expect("rules compile");
    let official = |path: &[&str]| -> String {
        let mut value = &fixture;
        for key in path {
            value = &value[*key];
        }
        value["message"]
            .as_str()
            .expect("official message")
            .to_owned()
    };
    let read = |identity: &str, path: &str| {
        fixture["reads"]
            .as_array()
            .expect("reads")
            .iter()
            .find(|row| {
                row["database"] == "(default)" && row["identity"] == identity && row["path"] == path
            })
            .expect("recorded read")["grpc"]["message"]
            .as_str()
            .expect("message")
            .to_owned()
    };

    // Conditions that evaluated to false: exactly the official detail.
    for (request, expected) in [
        (
            request(RequestOperation::Get, "two/x", Some(alice())),
            official(&["denials", "twoAllows", "grpc"]),
        ),
        (
            request(RequestOperation::Get, "deny/x", None),
            read("absent", "deny/x"),
        ),
        (
            request(RequestOperation::Get, "anon/x", Some(alice())),
            read("user", "anon/x"),
        ),
    ] {
        let result = rules.evaluate(&request, &EmptyDocumentAccess);
        assert!(!result.allowed);
        assert_eq!(result.denial_message(), format!("{PRODUCTION}{expected}"));
    }

    // No allow applies.
    let elsewhere = rules.evaluate(
        &request(RequestOperation::Get, "elsewhere/x", Some(alice())),
        &EmptyDocumentAccess,
    );
    assert_eq!(
        official(&["denials", "noMatchingAllow", "grpc"]),
        "No matching allow statements"
    );
    assert_eq!(
        elsewhere.denial_message(),
        format!("{PRODUCTION}\nNo matching allow statements")
    );
    assert_eq!(elsewhere.refused_by, []);

    // A condition that failed: Firenook's error text, at the official line.
    let failed = rules.evaluate(
        &request(RequestOperation::Get, "alice/x", None),
        &EmptyDocumentAccess,
    );
    let message = failed.denial_message();
    assert!(message.starts_with(&format!("{PRODUCTION}\n")), "{message}");
    assert!(message.ends_with(" for 'get' @ L6"), "{message}");
    assert_eq!(lines(&message), lines(&read("absent", "alice/x")));
    assert_eq!(failed.refused_by.len(), 1);
    assert!(failed.refused_by[0].error.is_some());

    // A write names its operation.
    let mut create = request(RequestOperation::Create, "writes/small", Some(alice()));
    create.request_resource = Some(Resource {
        name: "projects/demo-firenook-identity/databases/(default)/documents/writes/small"
            .to_owned(),
        data: BTreeMap::from([("n".to_owned(), Value::Integer(0))]),
        create_time: None,
        update_time: None,
    });
    let created = rules.evaluate(&create, &EmptyDocumentAccess);
    assert_eq!(
        created.denial_message(),
        format!("{PRODUCTION}{}", official(&["denials", "create", "rest"]))
    );
    assert_eq!(created.refused_by[0].line, 14);
    assert_eq!(created.refused_by[0].operation, RequestOperation::Create);

    // An allowed request names nothing.
    let allowed = rules.evaluate(
        &request(RequestOperation::Get, "alice/x", Some(alice())),
        &EmptyDocumentAccess,
    );
    assert!(allowed.allowed);
    assert_eq!(allowed.refused_by, []);
}
