//! Replays the frozen Phase G production corpus
//! (`conformance/fixtures/storage-rules-v1/production-expression-corpus.json`)
//! for `service firebase.storage` and the request-model facts that are
//! expressible without HTTP. The HTTP-level emulator programs are replayed by
//! `storage-front`.

use std::collections::BTreeMap;

use fireside_rules_engine::{
    Auth, DocumentAccess, DocumentAccessError, EmptyDocumentAccess, EvaluationRequest,
    RequestOperation, Resource, RulesService, StorageObject, Timestamp, Value, compile,
};
use serde_json::Value as JsonValue;

const EXPRESSION_CORPUS: &str = include_str!(
    "../../../conformance/fixtures/storage-rules-v1/production-expression-corpus.json"
);

/// Cases whose supplied resource carries keys the Storage runtime never
/// exposes (`cacheControl`, `contentLanguage`). Fireside's object model has
/// fourteen keys (storage-rules-v1 emulator programs), so the same
/// expressions are asserted to deny with a runtime error instead.
const OUTSIDE_RUNTIME_VALUE_DOMAIN: &[&str] = &[
    "res-cache-control-present",
    "res-content-language-present",
    "rr-cache-control-present",
];

#[test]
fn replays_every_production_storage_expression_case() {
    let fixture: JsonValue = serde_json::from_str(EXPRESSION_CORPUS).expect("valid corpus");
    let mut replayed = 0_usize;
    let mut with_error = 0_usize;
    for batch in fixture["batches"].as_array().expect("batches") {
        let source = batch["source"].as_str().expect("source");
        let rules = compile(source).expect("captured production source should compile");
        assert_eq!(rules.service(), RulesService::FirebaseStorage);
        assert_eq!(rules.rules_version(), 2);
        let cases = batch["cases"].as_array().expect("cases");
        let requests = batch["testCases"].as_array().expect("testCases");
        let results = batch["response"]["testResults"]
            .as_array()
            .expect("testResults");
        assert_eq!(cases.len(), requests.len());
        assert_eq!(cases.len(), results.len());
        for ((case, test_case), expected) in cases.iter().zip(requests).zip(results) {
            let id = case["id"].as_str().expect("id");
            let request = storage_request(test_case);
            let access = MockAccess::from_case(test_case);
            let actual = rules.evaluate(&request, &access);
            let expected_allowed = expected["state"] == "SUCCESS";
            let expected_error = expected["debugMessages"]
                .as_array()
                .is_some_and(|messages| {
                    messages
                        .iter()
                        .any(|message| message.as_str().is_some_and(|m| m.starts_with("Error:")))
                });
            if OUTSIDE_RUNTIME_VALUE_DOMAIN.contains(&id) {
                assert!(
                    !actual.allowed && actual.error.is_some(),
                    "{id}: a fourteen-key object must deny with an error => {actual:?}"
                );
                replayed += 1;
                continue;
            }
            assert_eq!(
                actual.allowed,
                expected_allowed,
                "{id}: {} => {actual:?}",
                case["expression"].as_str().unwrap_or("custom match")
            );
            if !expected_allowed && expected_error {
                assert!(
                    actual.error.is_some(),
                    "{id}: production denied with a runtime error, Fireside denied silently"
                );
                with_error += 1;
            }
            assert_eq!(
                actual,
                rules.evaluate_with_trace(&request, &access).0,
                "tracing must preserve the verdict for {id}"
            );
            replayed += 1;
        }
    }
    assert_eq!(
        u64::try_from(replayed).expect("count"),
        fixture["caseCount"].as_u64().expect("caseCount")
    );
    assert_eq!(
        u64::try_from(with_error).expect("count"),
        fixture["verdictSummary"]["denyWithRuntimeError"]
            .as_u64()
            .expect("denyWithRuntimeError")
    );
}

#[test]
fn storage_object_value_has_exactly_the_fourteen_runtime_keys() {
    let object = sample_object("users/alice/deck.png", 12);
    let Value::Map(map) = object.to_value() else {
        panic!("object must be a map")
    };
    assert_eq!(map.len(), 14);
    assert_eq!(map["contentDisposition"], Value::Null);
    assert_eq!(map["size"], Value::Integer(12));
    assert!(matches!(map["timeCreated"], Value::Timestamp(_)));
    assert!(!map.contains_key("cacheControl"));
}

#[test]
fn consumer_rulesets_evaluate_natively() {
    let default_rules = compile(
        r"rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /users/{uid}/{allPaths=**} {
      allow read, write: if request.auth.uid == uid || request.auth.token.admin == true;
    }
  }
}
",
    )
    .expect("default rules compile");
    let assets_rules = compile(
        r"rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /users/{uid}/{allPaths=**} {
      allow read, write: if request.auth.uid == uid || request.auth.token.admin == true;
    }
    match /{allPaths=**} {
      allow write: if request.auth.token.admin == true;
      allow get: if true;
    }
  }
}
",
    )
    .expect("assets rules compile");
    let time = Timestamp::new(1_768_480_496, 0);
    let object = sample_object("users/alice/deck.png", 12);
    let mut get = EvaluationRequest::storage(
        RequestOperation::Get,
        "/b/demo.appspot.com/o/users/alice/deck.png",
        time,
    );
    get.storage_resource = Some(object.clone());

    // Anonymous: request.auth.uid is a null-value error, then the admin claim
    // is a null-value error; both deny.
    let anonymous = default_rules.evaluate(&get, &EmptyDocumentAccess);
    assert!(!anonymous.allowed && anonymous.error.is_some());

    get.auth = Some(user("alice", &[]));
    assert!(default_rules.evaluate(&get, &EmptyDocumentAccess).allowed);
    get.auth = Some(user("bob", &[]));
    let bob = default_rules.evaluate(&get, &EmptyDocumentAccess);
    assert!(
        !bob.allowed && bob.error.is_some(),
        "missing admin claim errors"
    );
    get.auth = Some(user("admin-user", &[("admin", Value::Bool(true))]));
    assert!(default_rules.evaluate(&get, &EmptyDocumentAccess).allowed);

    // The assets bucket admits anonymous get everywhere and never list.
    let mut anonymous_get = EvaluationRequest::storage(
        RequestOperation::Get,
        "/b/assets.example.test/o/catalog/cache.json",
        time,
    );
    anonymous_get.storage_resource = Some(sample_object("catalog/cache.json", 2));
    assert!(
        assets_rules
            .evaluate(&anonymous_get, &EmptyDocumentAccess)
            .allowed
    );
    let anonymous_list = EvaluationRequest::storage(
        RequestOperation::List,
        "/b/assets.example.test/o/users/alice/images",
        time,
    );
    assert!(
        !assets_rules
            .evaluate(&anonymous_list, &EmptyDocumentAccess)
            .allowed
    );
    let mut alice_list = anonymous_list.clone();
    alice_list.auth = Some(user("alice", &[]));
    assert!(
        assets_rules
            .evaluate(&alice_list, &EmptyDocumentAccess)
            .allowed
    );
    let mut alice_root_list =
        EvaluationRequest::storage(RequestOperation::List, "/b/assets.example.test/o", time);
    alice_root_list.auth = Some(user("alice", &[]));
    assert!(
        !assets_rules
            .evaluate(&alice_root_list, &EmptyDocumentAccess)
            .allowed
    );

    // Uploads: create with request.resource, admin only outside /users.
    let mut upload = EvaluationRequest::storage(
        RequestOperation::Create,
        "/b/assets.example.test/o/catalog/other.json",
        time,
    );
    upload.storage_request_resource = Some(sample_object("catalog/other.json", 2));
    upload.auth = Some(user("alice", &[]));
    let alice_upload = assets_rules.evaluate(&upload, &EmptyDocumentAccess);
    assert!(!alice_upload.allowed && alice_upload.error.is_some());
    upload.auth = Some(user("admin-user", &[("admin", Value::Bool(true))]));
    assert!(assets_rules.evaluate(&upload, &EmptyDocumentAccess).allowed);
}

#[test]
fn accepts_a_storage_ruleset_without_rules_version_and_records_it() {
    let rules = compile(
        r"service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read, write: if true;
    }
  }
}
",
    )
    .expect("v1 storage rules compile");
    assert_eq!(rules.service(), RulesService::FirebaseStorage);
    assert_eq!(rules.rules_version(), 1);
    let error = compile(
        r"service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read: if true; }
  }
}
",
    )
    .expect_err("firestore rules still require rules_version");
    assert!(error[0].message.contains("rules_version"));
}

#[test]
fn accepts_a_trailing_allow_without_semicolon() {
    let rules = compile(
        r"rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    allow read: if true
  }
}
",
    )
    .expect("missing trailing semicolon is accepted");
    let request = EvaluationRequest::storage(
        RequestOperation::Get,
        "/b/demo.appspot.com/o/life/obj.txt",
        Timestamp::new(0, 0),
    );
    assert!(
        !rules.evaluate(&request, &EmptyDocumentAccess).allowed,
        "the allow sits on /b/{{bucket}}/o and matches no object"
    );
}

#[test]
fn a_firestore_ruleset_loads_for_storage_and_matches_nothing() {
    let rules = compile(
        r"rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if true; }
  }
}
",
    )
    .expect("firestore rules compile");
    assert_eq!(rules.service(), RulesService::CloudFirestore);
    let request = EvaluationRequest::storage(
        RequestOperation::Get,
        "/b/demo.appspot.com/o/life/obj.txt",
        Timestamp::new(0, 0),
    );
    assert!(!rules.evaluate(&request, &EmptyDocumentAccess).allowed);
}

#[test]
fn firestore_namespace_reads_through_the_accessor_without_an_access_budget() {
    let rules = compile(&format!(
        "rules_version = '2';\nservice firebase.storage {{\n  match /b/{{bucket}}/o {{\n    match /{{allPaths=**}} {{\n      allow get: if {};\n    }}\n  }}\n}}\n",
        (1..=21)
            .map(|index| format!(
                "firestore.get(/databases/(default)/documents/limits/d{index}).data.n == {index}"
            ))
            .collect::<Vec<_>>()
            .join(" && ")
    ))
    .expect("21 accesses compile");
    let access = MockAccess {
        entries: (1..=21)
            .map(|index| {
                (
                    Some(format!("/databases/(default)/documents/limits/d{index}")),
                    Ok(Some(Resource::new(
                        format!("/projects/demo/databases/(default)/documents/limits/d{index}"),
                        BTreeMap::from([("n".to_owned(), Value::Integer(index))]),
                    ))),
                )
            })
            .collect(),
    };
    let request = EvaluationRequest::storage(
        RequestOperation::Get,
        "/b/demo.appspot.com/o/fs/obj.txt",
        Timestamp::new(0, 0),
    );
    let result = rules.evaluate(&request, &access);
    assert!(result.allowed, "{result:?}");
    assert_eq!(result.document_accesses, 21);
}

fn sample_object(name: &str, size: i64) -> StorageObject {
    StorageObject {
        name: name.to_owned(),
        bucket: "demo.appspot.com".to_owned(),
        generation: 1_757_000_000_000_000,
        metageneration: 1,
        size,
        time_created: Timestamp::new(1_768_032_000, 0),
        updated: Timestamp::new(1_768_032_000, 0),
        md5_hash: "kAFQmDzST7DWlj99KOF/cg==".to_owned(),
        crc32c: "z8SuHQ==".to_owned(),
        etag: "CKjEgYS1u4gDEAI=".to_owned(),
        content_disposition: None,
        content_encoding: None,
        content_type: Some("image/png".to_owned()),
        metadata: BTreeMap::new(),
    }
}

fn user(uid: &str, claims: &[(&str, Value)]) -> Auth {
    let mut token = BTreeMap::from([
        ("sub".to_owned(), Value::String(uid.to_owned())),
        ("user_id".to_owned(), Value::String(uid.to_owned())),
    ]);
    for (key, value) in claims {
        token.insert((*key).to_owned(), value.clone());
    }
    Auth {
        uid: Some(uid.to_owned()),
        token,
    }
}

type MockEntry = (
    Option<String>,
    Result<Option<Resource>, DocumentAccessError>,
);

/// `functionMocks` of one `projects.test` case, answered by exact path.
struct MockAccess {
    entries: Vec<MockEntry>,
}

impl MockAccess {
    fn from_case(test_case: &JsonValue) -> Self {
        let mut entries = Vec::new();
        let mocks = test_case["functionMocks"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        // `firestore.get` mocks carry data; `firestore.exists` mocks only
        // decide presence, so a get mock for the same path wins.
        for mock in mocks
            .iter()
            .filter(|mock| mock["function"] == "firestore.get")
        {
            let path = mock["args"][0]["exactValue"].as_str().map(str::to_owned);
            let result = if mock["result"].get("undefined").is_some() {
                Err(DocumentAccessError::new("Service call error"))
            } else {
                let value = &mock["result"]["value"];
                let name = value["__name__"]
                    .as_str()
                    .map_or_else(|| path.clone().unwrap_or_default(), str::to_owned);
                let data = value["data"]
                    .as_object()
                    .map(|fields| {
                        fields
                            .iter()
                            .map(|(key, value)| (key.clone(), json_value(value)))
                            .collect()
                    })
                    .unwrap_or_default();
                Ok(Some(Resource::new(name, data)))
            };
            entries.push((path, result));
        }
        for mock in mocks
            .iter()
            .filter(|mock| mock["function"] == "firestore.exists")
        {
            let path = mock["args"][0]["exactValue"].as_str().map(str::to_owned);
            let present = mock["result"]["value"].as_bool().unwrap_or(false);
            entries.push((
                path.clone(),
                Ok(present.then(|| Resource::new(path.unwrap_or_default(), BTreeMap::new()))),
            ));
        }
        Self { entries }
    }
}

impl DocumentAccess for MockAccess {
    fn get(&self, path: &str) -> Result<Option<Resource>, DocumentAccessError> {
        self.entries
            .iter()
            .find(|(expected, _)| expected.as_deref().is_none_or(|expected| expected == path))
            .map_or_else(
                || Err(DocumentAccessError::new("Function not found error")),
                |(_, result)| result.clone(),
            )
    }

    fn get_after(&self, path: &str) -> Result<Option<Resource>, DocumentAccessError> {
        self.get(path)
    }
}

fn storage_request(test_case: &JsonValue) -> EvaluationRequest {
    let request = &test_case["request"];
    let operation = match request["method"].as_str().expect("method") {
        "get" => RequestOperation::Get,
        "list" => RequestOperation::List,
        "create" => RequestOperation::Create,
        "update" => RequestOperation::Update,
        "delete" => RequestOperation::Delete,
        other => panic!("unknown method {other}"),
    };
    let mut evaluation = EvaluationRequest::storage(
        operation,
        request["path"].as_str().expect("path"),
        Timestamp::parse_rfc3339(request["time"].as_str().expect("time")).expect("time"),
    );
    if let Some(auth) = request["auth"].as_object() {
        evaluation.auth = Some(Auth {
            uid: Some(auth["uid"].as_str().expect("uid").to_owned()),
            token: auth["token"]
                .as_object()
                .expect("token")
                .iter()
                .map(|(key, value)| (key.clone(), json_value(value)))
                .collect(),
        });
    }
    evaluation.storage_resource = storage_object(&test_case["resource"]);
    evaluation.storage_request_resource = storage_object(&request["resource"]);
    evaluation
}

/// Converts a corpus resource map into the runtime object. Keys outside the
/// fourteen-key model (`cacheControl`, `contentLanguage`) are dropped, which
/// is exactly what the official runtime does.
fn storage_object(value: &JsonValue) -> Option<StorageObject> {
    let map = value.as_object()?;
    let string = |key: &str| map[key].as_str().expect(key).to_owned();
    let optional = |key: &str| map.get(key).and_then(JsonValue::as_str).map(str::to_owned);
    let timestamp = |key: &str| Timestamp::parse_rfc3339(map[key].as_str().expect(key)).expect(key);
    Some(StorageObject {
        name: string("name"),
        bucket: string("bucket"),
        generation: map["generation"].as_i64().expect("generation"),
        metageneration: map["metageneration"].as_i64().expect("metageneration"),
        size: map["size"].as_i64().expect("size"),
        time_created: timestamp("timeCreated"),
        updated: timestamp("updated"),
        md5_hash: string("md5Hash"),
        crc32c: string("crc32c"),
        etag: string("etag"),
        content_disposition: optional("contentDisposition"),
        content_encoding: optional("contentEncoding"),
        content_type: optional("contentType"),
        metadata: map["metadata"]
            .as_object()
            .expect("metadata")
            .iter()
            .map(|(key, value)| {
                (
                    key.clone(),
                    value.as_str().expect("string metadata").to_owned(),
                )
            })
            .collect(),
    })
}

fn json_value(value: &JsonValue) -> Value {
    match value {
        JsonValue::Null => Value::Null,
        JsonValue::Bool(value) => Value::Bool(*value),
        JsonValue::Number(number) => number.as_i64().map_or_else(
            || Value::Float(number.as_f64().unwrap_or_default()),
            Value::Integer,
        ),
        JsonValue::String(value) => Value::String(value.clone()),
        JsonValue::Array(values) => Value::List(values.iter().map(json_value).collect()),
        JsonValue::Object(fields) => Value::Map(
            fields
                .iter()
                .map(|(key, value)| (key.clone(), json_value(value)))
                .collect(),
        ),
    }
}
