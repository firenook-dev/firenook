//! Replays every program of the frozen emulator oracle
//! (`conformance/fixtures/storage-rules-v1/emulator-programs.json`) over HTTP
//! against the native rules layer. Each step must reproduce the recorded
//! status (and error message, when both sides carry one) unless it is listed
//! in `DIVERGENCES`, where production precedence or a non-rules difference is
//! named and the Fireside outcome is asserted instead.

use std::collections::BTreeMap;
use std::sync::{Arc, RwLock};

use axum::body::{Body, to_bytes};
use axum::http::{Method, Request};
use base64::engine::general_purpose::STANDARD as BASE64;
use fireside_functions_bridge::{TriggerObserver, TriggerRegistry};
use fireside_rules_engine::{DocumentAccessError, Resource, Value};
use serde_json::{Value as JsonValue, json};
use tower::ServiceExt as _;

use super::*;

const PROGRAMS: &str =
    include_str!("../../../conformance/fixtures/storage-rules-v1/emulator-programs.json");

fn test_root(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "fireside-storage-{label}-{}-{}",
        std::process::id(),
        OffsetDateTime::now_utc().unix_timestamp_nanos()
    ))
}

/// Steps where Fireside must differ from the recording, with the reason and
/// the asserted Fireside status. Every entry names a divergence recorded in
/// the fixture README or a non-rules API difference.
const DIVERGENCES: &[(&str, &str, u16, &str)] = &[
    (
        "request-resource-create-shape",
        "method-string",
        200,
        "request-method-undefined: production defines request.method",
    ),
    (
        "request-resource-update-patch",
        "method-update",
        200,
        "request-method-undefined: production defines request.method",
    ),
    (
        "request-resource-get-list-delete",
        "get-media-uses-get",
        200,
        "request-method-undefined: production defines request.method",
    ),
    (
        "request-resource-get-list-delete",
        "list-method-string",
        200,
        "request-method-undefined: production defines request.method",
    ),
    (
        "upload-over-existing",
        "overwrite-method-is-create",
        200,
        "request-method-undefined: production defines request.method",
    ),
    (
        "path-matching",
        "root-recursive-list-one-segment-is-path",
        200,
        "list-prefix-template-matching: production indexes a one-segment recursive binding",
    ),
    (
        "path-matching",
        "list-exact-match-single-wildcard",
        200,
        "list-prefix-template-matching: production matches /la/{x} for a list on /la/q",
    ),
    (
        "bypass-json-api",
        "json-patch-anonymous",
        200,
        "the JSON API PATCH route is implemented by Fireside (501 in the official emulator); rules are not consulted either way",
    ),
];

/// Latest-state documents seeded by the programs, keyed by rules path.
#[derive(Default)]
struct SeededDocuments {
    documents: RwLock<BTreeMap<String, Resource>>,
}

impl SeededDocuments {
    fn write(&self, project: &str, path: &str, fields: &JsonValue) {
        let resource = Resource::new(
            format!("projects/{project}/databases/(default)/documents/{path}"),
            fields
                .as_object()
                .expect("fields object")
                .iter()
                .map(|(key, value)| (key.clone(), firestore_value(value)))
                .collect(),
        );
        self.documents
            .write()
            .expect("documents")
            .insert(format!("/databases/(default)/documents/{path}"), resource);
    }

    fn clear(&self) {
        self.documents.write().expect("documents").clear();
    }
}

impl FirestoreDocuments for SeededDocuments {
    fn document(&self, path: &str) -> Result<Option<Resource>, DocumentAccessError> {
        if !path.starts_with("/databases/") || !path.contains("/documents/") {
            return Err(DocumentAccessError::new("not a document path"));
        }
        Ok(self.documents.read().expect("documents").get(path).cloned())
    }
}

fn firestore_value(value: &JsonValue) -> Value {
    let field = value.as_object().expect("typed value");
    if let Some(value) = field.get("booleanValue") {
        Value::Bool(value.as_bool().expect("bool"))
    } else if let Some(value) = field.get("integerValue") {
        Value::Integer(value.as_str().map_or_else(
            || value.as_i64().expect("int"),
            |text| text.parse().expect("int"),
        ))
    } else if let Some(value) = field.get("doubleValue") {
        Value::Float(value.as_f64().expect("float"))
    } else if let Some(value) = field.get("stringValue") {
        Value::String(value.as_str().expect("string").to_owned())
    } else if let Some(value) = field.get("arrayValue") {
        Value::List(
            value["values"]
                .as_array()
                .map(|values| values.iter().map(firestore_value).collect())
                .unwrap_or_default(),
        )
    } else if let Some(value) = field.get("mapValue") {
        Value::Map(
            value["fields"]
                .as_object()
                .map(|fields| {
                    fields
                        .iter()
                        .map(|(key, value)| (key.clone(), firestore_value(value)))
                        .collect()
                })
                .unwrap_or_default(),
        )
    } else {
        Value::Null
    }
}

struct Recorded {
    status: u16,
    headers: BTreeMap<String, String>,
    body: JsonValue,
}

async fn send(
    runtime: &StorageRuntime,
    method: &str,
    path: &str,
    headers: &BTreeMap<String, String>,
    body: Option<Vec<u8>>,
) -> Recorded {
    // A browser or Node `fetch` percent-encodes non-ASCII bytes of the request
    // target before sending; the recorded raw-UTF-8 step reached the emulator
    // that way.
    let target = path
        .bytes()
        .map(|byte| {
            if byte.is_ascii_graphic() {
                char::from(byte).to_string()
            } else {
                format!("%{byte:02X}")
            }
        })
        .collect::<String>();
    let mut request = Request::builder()
        .method(Method::from_bytes(method.as_bytes()).expect("method"))
        .uri(target);
    for (name, value) in headers {
        request = request.header(name.as_str(), value.as_str());
    }
    let response = runtime
        .application()
        .oneshot(
            request
                .body(body.map_or_else(Body::empty, Body::from))
                .unwrap_or_else(|error| panic!("request {method} {path}: {error}")),
        )
        .await
        .expect("response");
    let status = response.status().as_u16();
    let headers = response
        .headers()
        .iter()
        .map(|(name, value)| {
            (
                name.as_str().to_owned(),
                value.to_str().unwrap_or_default().to_owned(),
            )
        })
        .collect::<BTreeMap<_, _>>();
    let bytes = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body");
    let body = serde_json::from_slice(&bytes)
        .unwrap_or_else(|_| JsonValue::String(String::from_utf8_lossy(&bytes).into_owned()));
    Recorded {
        status,
        headers,
        body,
    }
}

fn resolve_templates(path: &str, previous: &BTreeMap<String, Recorded>) -> String {
    let mut resolved = path.to_owned();
    while let Some(start) = resolved.find("{{") {
        let end = resolved[start..].find("}}").expect("template end") + start;
        let template = &resolved[start + 2..end];
        let (kind, step) = template.split_once(':').expect("template kind");
        let source = previous.get(step).expect("template source step");
        let value = match kind {
            "uploadUrl" => {
                let url = url::Url::parse(
                    source
                        .headers
                        .get("x-goog-upload-url")
                        .or_else(|| source.headers.get("location"))
                        .expect("upload url"),
                )
                .expect("upload url");
                format!(
                    "{}{}",
                    url.path(),
                    url.query().map_or(String::new(), |q| format!("?{q}"))
                )
            }
            "token" => percent_encode(
                source.body["downloadTokens"]
                    .as_str()
                    .expect("download tokens")
                    .split(',')
                    .next()
                    .expect("token"),
            ),
            other => panic!("unknown template {other}"),
        };
        resolved.replace_range(start..end + 2, &value);
    }
    resolved
}

fn resolve_authorization(value: &str, tokens: &JsonValue) -> String {
    if let Some(name) = value.strip_prefix("firebase:@") {
        format!("Firebase {}", tokens[name]["jwt"].as_str().expect("jwt"))
    } else if let Some(name) = value.strip_prefix('@') {
        format!("Bearer {}", tokens[name]["jwt"].as_str().expect("jwt"))
    } else {
        value.to_owned()
    }
}

fn set_rules_body(files: &JsonValue) -> Vec<u8> {
    serde_json::to_vec(&json!({ "rules": { "files": files } })).expect("json")
}

fn error_message(body: &JsonValue) -> Option<&str> {
    body.get("error")
        .and_then(|error| error.get("message"))
        .or_else(|| body.get("message"))
        .and_then(JsonValue::as_str)
}

fn recorded_status(value: &JsonValue) -> u16 {
    u16::try_from(value.as_u64().expect("status")).expect("http status")
}

#[tokio::test]
#[allow(clippy::too_many_lines)]
async fn replays_every_recorded_emulator_program() {
    let fixture: JsonValue = serde_json::from_str(PROGRAMS).expect("fixture");
    let project = fixture["targetProject"].as_str().expect("project");
    let tokens = &fixture["tokens"];
    let documents = Arc::new(SeededDocuments::default());
    let root = test_root("rules-replay");
    let registry = TriggerRegistry::default();
    let (observer, _receiver) = TriggerObserver::channel(registry.clone());
    let default_bucket = fixture["buckets"]["default"].as_str().expect("bucket");
    let assets_bucket = fixture["buckets"]["assets"].as_str().expect("bucket");
    let open = |bucket: &str| {
        BucketRules {
        bucket: bucket.to_owned(),
        name: format!("{bucket}.rules"),
        content: "rules_version = '2';\nservice firebase.storage {\n  match /b/{bucket}/o {\n    match /{allPaths=**} {\n      allow read, write: if true;\n    }\n  }\n}\n".to_owned(),
    }
    };
    let runtime = StorageRuntime::start(
        StorageConfig {
            project: project.to_owned(),
            durability: StorageDurability::default(),
            origin: "http://127.0.0.1:21002".to_owned(),
            data_dir: root.clone(),
            rules: Some(NativeRulesConfig {
                source: RulesSource::PerBucket(vec![open(default_bucket), open(assets_bucket)]),
                documents: documents.clone(),
            }),
        },
        observer.queue(),
        registry,
    )
    .await
    .expect("Storage runtime");

    let mut replayed = 0_usize;
    let mut diverged = 0_usize;
    for program in fixture["programs"].as_array().expect("programs") {
        let program_id = program["id"].as_str().expect("program id");
        let reset = send(&runtime, "POST", "/internal/reset", &BTreeMap::new(), None).await;
        assert_eq!(reset.status, 200, "{program_id}: reset");
        documents.clear();
        let install = send(
            &runtime,
            "PUT",
            "/internal/setRules",
            &BTreeMap::from([("content-type".to_owned(), "application/json".to_owned())]),
            Some(set_rules_body(&program["rules"])),
        )
        .await;
        assert_eq!(
            install.status,
            recorded_status(&program["rulesInstall"]["response"]["status"]),
            "{program_id}: ruleset install"
        );
        for seed in program["firestoreSeed"].as_array().expect("seed") {
            documents.write(
                project,
                seed["path"].as_str().expect("seed path"),
                program_seed_fields(program, seed),
            );
        }
        let mut previous: BTreeMap<String, Recorded> = BTreeMap::new();
        for step in program["observations"].as_array().expect("observations") {
            let step_id = step["id"].as_str().expect("step id");
            if let Some(files) = step["rulesInstall"]["files"].as_array() {
                let install = send(
                    &runtime,
                    "PUT",
                    "/internal/setRules",
                    &BTreeMap::from([("content-type".to_owned(), "application/json".to_owned())]),
                    Some(set_rules_body(&JsonValue::Array(files.clone()))),
                )
                .await;
                assert_eq!(
                    install.status,
                    recorded_status(&step["rulesInstall"]["response"]["status"]),
                    "{program_id}/{step_id}: step ruleset install"
                );
            }
            if let Some(write) = step["firestoreWrite"].as_object() {
                documents.write(
                    project,
                    write["path"].as_str().expect("write path"),
                    step_write_fields(program, step),
                );
            }
            let request = &step["request"];
            let path = resolve_templates(request["path"].as_str().expect("path"), &previous);
            let mut headers = BTreeMap::new();
            for (name, value) in request["headers"].as_object().expect("headers") {
                let value = value.as_str().expect("header value");
                headers.insert(
                    name.clone(),
                    if name == "authorization" {
                        resolve_authorization(value, tokens)
                    } else {
                        value.to_owned()
                    },
                );
            }
            let body = request.get("body").map(|body| {
                if let Some(content_type) = body["contentTypeHeader"].as_str() {
                    headers.insert("content-type".to_owned(), content_type.to_owned());
                }
                BASE64
                    .decode(body["base64"].as_str().expect("base64"))
                    .expect("body bytes")
            });
            let actual = send(
                &runtime,
                request["method"].as_str().expect("method"),
                &path,
                &headers,
                body,
            )
            .await;
            let recorded = recorded_status(&step["response"]["status"]);
            if let Some((_, _, expected, reason)) = DIVERGENCES
                .iter()
                .find(|(program, step, _, _)| *program == program_id && *step == step_id)
            {
                assert_ne!(
                    *expected, recorded,
                    "{program_id}/{step_id}: a listed divergence must actually diverge"
                );
                assert_eq!(actual.status, *expected, "{program_id}/{step_id}: {reason}");
                diverged += 1;
            } else {
                assert_eq!(
                    actual.status, recorded,
                    "{program_id}/{step_id}: {} {path} => {:?}",
                    request["method"], actual.body
                );
                if let (Some(expected), Some(actual_message)) = (
                    error_message(&step["response"]["body"]),
                    error_message(&actual.body),
                ) {
                    assert_eq!(actual_message, expected, "{program_id}/{step_id}: message");
                }
                if let Some(expected) = step["response"]["headers"]["x-goog-upload-status"].as_str()
                {
                    assert_eq!(
                        actual
                            .headers
                            .get("x-goog-upload-status")
                            .map(String::as_str),
                        Some(expected),
                        "{program_id}/{step_id}: upload status"
                    );
                }
            }
            previous.insert(step_id.to_owned(), actual);
            replayed += 1;
        }
    }
    assert_eq!(
        replayed,
        usize::try_from(fixture["stepCount"].as_u64().expect("stepCount")).expect("count")
    );
    assert_eq!(
        diverged,
        DIVERGENCES.len(),
        "every listed divergence must be exercised"
    );

    // The crash the official runtime suffers on an empty path segment: Fireside
    // answers, evaluating the remaining segments.
    let crash = &fixture["oracleCrashNotRecordedLive"];
    let install = send(
        &runtime,
        "PUT",
        "/internal/setRules",
        &BTreeMap::from([("content-type".to_owned(), "application/json".to_owned())]),
        Some(set_rules_body(
            &json!([{ "name": "open.rules", "content": open(default_bucket).content }]),
        )),
    )
    .await;
    assert_eq!(install.status, 200);
    let answered = send(
        &runtime,
        crash["request"]["method"].as_str().expect("method"),
        crash["request"]["path"].as_str().expect("path"),
        &BTreeMap::from([
            (
                "authorization".to_owned(),
                resolve_authorization("@alice", tokens),
            ),
            ("content-type".to_owned(), "text/plain".to_owned()),
        ]),
        Some(b"x".to_vec()),
    )
    .await;
    assert_eq!(answered.status, 200, "{:?}", answered.body);

    runtime.shutdown().await.expect("shutdown");
    std::fs::remove_dir_all(root).expect("remove test storage");
}

#[tokio::test]
async fn a_ruleset_that_does_not_compile_is_a_startup_failure() {
    let fixture: JsonValue = serde_json::from_str(PROGRAMS).expect("fixture");
    let broken = &fixture["startupCompileError"]["rules"];
    let root = test_root("rules-broken");
    let registry = TriggerRegistry::default();
    let (observer, _receiver) = TriggerObserver::channel(registry.clone());
    let error = StorageRuntime::start(
        StorageConfig {
            project: fixture["targetProject"]
                .as_str()
                .expect("project")
                .to_owned(),
            durability: StorageDurability::default(),
            origin: "http://127.0.0.1:21002".to_owned(),
            data_dir: root.clone(),
            rules: Some(NativeRulesConfig {
                source: RulesSource::Single(RulesFile {
                    name: broken["name"].as_str().expect("name").to_owned(),
                    content: broken["content"].as_str().expect("content").to_owned(),
                }),
                documents: Arc::new(NoFirestoreDocuments),
            }),
        },
        observer.queue(),
        registry,
    )
    .await
    .err()
    .expect("a broken ruleset must not start");
    assert!(
        error.to_string().contains("broken.rules"),
        "diagnostic names the file: {error}"
    );
    let _ = std::fs::remove_dir_all(root);
}

/// The fixture records seed fields in the plan, not in the observation; the
/// plan is embedded in the program entry.
fn program_seed_fields<'a>(program: &'a JsonValue, seed: &'a JsonValue) -> &'a JsonValue {
    seed.get("fields").unwrap_or_else(|| {
        panic!(
            "program {} seed {} carries no fields",
            program["id"], seed["path"]
        )
    })
}

fn step_write_fields<'a>(program: &'a JsonValue, step: &'a JsonValue) -> &'a JsonValue {
    step["firestoreWrite"].get("fields").unwrap_or_else(|| {
        panic!(
            "program {} step {} write carries no fields",
            program["id"], step["id"]
        )
    })
}

#[test]
fn every_listed_divergence_targets_a_recorded_step() {
    let fixture: JsonValue = serde_json::from_str(PROGRAMS).expect("fixture");
    for (program_id, step_id, _, _) in DIVERGENCES {
        let program = fixture["programs"]
            .as_array()
            .expect("programs")
            .iter()
            .find(|program| program["id"] == *program_id)
            .unwrap_or_else(|| panic!("program {program_id} is not recorded"));
        assert!(
            program["observations"]
                .as_array()
                .expect("observations")
                .iter()
                .any(|step| step["id"] == *step_id),
            "step {program_id}/{step_id} is not recorded"
        );
    }
}
