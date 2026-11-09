//! Functions declared outside the service block. Every verdict below was
//! recorded from the official emulator (firebase-tools 15.34.0).

use firenook_rules_engine::{
    EmptyDocumentAccess, EvaluationRequest, RequestOperation, Timestamp, compile,
};

fn allows_get(source: &str, path: &str) -> bool {
    let request = EvaluationRequest::new(
        RequestOperation::Get,
        format!("/databases/(default)/documents/{path}"),
        Timestamp::new(1, 0),
    );
    compile(source)
        .unwrap_or_else(|error| panic!("{source}: {error:?}"))
        .evaluate(&request, &EmptyDocumentAccess)
        .allowed
}

#[test]
fn a_function_before_or_after_the_service_block_is_callable_inside_it() {
    let source = "rules_version = '2';
        function before() { return true; }
        service cloud.firestore {
          match /databases/{database}/documents {
            match /a/{id} { allow read: if before() && after(); }
            match /b/{id} { match /c/{x} { allow read: if before(); } }
          }
        }
        function after() { return true; }";
    assert!(allows_get(source, "a/x"));
    assert!(allows_get(source, "b/y/c/z"));
}

#[test]
fn a_function_in_the_service_block_shadows_a_top_level_one() {
    for inner in [
        "function t() { return true; } match /databases/{database}/documents {",
        "match /databases/{database}/documents { function t() { return true; }",
    ] {
        let source = format!(
            "rules_version = '2';
             function t() {{ return false; }}
             service cloud.firestore {{
               {inner}
                 match /a/{{id}} {{ allow read: if t(); }}
               }}
             }}"
        );
        assert!(allows_get(&source, "a/x"), "{inner}");
    }
}

#[test]
fn a_service_function_calls_a_top_level_one() {
    let source = "rules_version = '2';
        function t() { return true; }
        service cloud.firestore {
          function s() { return t(); }
          match /databases/{database}/documents {
            match /a/{id} { allow read: if s(); }
          }
        }";
    assert!(allows_get(source, "a/x"));
}

#[test]
fn a_top_level_function_is_declared_once() {
    let source = "rules_version = '2';
        function t() { return true; }
        function t() { return true; }
        service cloud.firestore {
          match /databases/{database}/documents {
            match /a/{id} { allow read: if t(); }
          }
        }";
    let errors = compile(source).expect_err("a second t() is refused");
    assert_eq!(
        errors[0].message,
        "function \"t\" is declared more than once"
    );
    assert_eq!(errors[0].line, 3);
}
