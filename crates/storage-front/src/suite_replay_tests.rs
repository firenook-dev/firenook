//! Replays the three Storage recordings one official emulator session made
//! (firebase-tools 15.22.0, `conformance/src/suite/capture-storage.ts`), in
//! the order it made them, against one Storage runtime with the same two
//! bucket rules: `storage-firebase-v0-and-download-tokens`, then
//! `storage-gcs-json-and-resumable-upload`, then
//! `storage-multi-bucket-rules-and-import-export`, whose export holds every
//! object the two before it wrote.
//!
//! Each recorded request is sent with the bytes, headers and credentials the
//! capture sent, and the answer is compared after the capture's own
//! normalisation (`normalizeObservations` there) is applied to Firenook's
//! answer: status, the recorded headers except `content-length` (it measures
//! the body before normalisation; the body itself is compared), and the body.
//! A case is noted in the conformance ledger only after its comparison passed.

use axum::body::to_bytes;
use axum::http::Request;
use firenook_functions_bridge::TriggerObserver;
use tower::ServiceExt as _;

use super::*;

const SET: &str = "firebase-suite-v1/storage";
const PROJECT: &str = "demo-fireside-phase4-storage-oracle";
const DEFAULT_BUCKET: &str = "demo-synthetic-app.appspot.com";
const ASSETS_BUCKET: &str = "synthetic-objects.example.test";
const ORIGIN: &str = "http://127.0.0.1:21002";

fn fixture(name: &str) -> JsonValue {
    let path = format!(
        "{}/../../conformance/fixtures/firebase-suite-v1/{name}/fixture.json",
        env!("CARGO_MANIFEST_DIR")
    );
    serde_json::from_str(&std::fs::read_to_string(path).expect("fixture file")).expect("fixture")
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest
        .iter()
        .fold(String::with_capacity(64), |mut text, byte| {
            use std::fmt::Write as _;
            write!(text, "{byte:02x}").expect("hex");
            text
        })
}

/// The capture's `unsignedJwt`: the same claims, `iat` and `exp`.
fn unsigned_jwt(claims: &JsonValue) -> String {
    let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"none","typ":"JWT"}"#);
    let mut claims = claims.clone();
    claims["iat"] = json!(1_700_000_000_u64);
    claims["exp"] = json!(4_102_444_800_u64);
    let body = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).expect("claims"));
    format!("{header}.{body}.")
}

fn user_token(uid: &str, admin: bool, provider: &str) -> String {
    let mut claims = json!({
        "aud": PROJECT,
        "iss": format!("https://securetoken.google.com/{PROJECT}"),
        "sub": uid,
        "user_id": uid,
        "firebase": { "sign_in_provider": provider, "identities": {} },
    });
    if admin {
        claims["admin"] = json!(true);
    }
    unsigned_jwt(&claims)
}

/// One request as the capture sent it.
struct Sent {
    method: Method,
    uri: String,
    headers: Vec<(&'static str, String)>,
    body: Vec<u8>,
}

impl Sent {
    fn new(method: Method, uri: impl Into<String>) -> Self {
        Self {
            method,
            uri: uri.into(),
            headers: Vec::new(),
            body: Vec::new(),
        }
    }

    fn header(mut self, name: &'static str, value: impl Into<String>) -> Self {
        self.headers.push((name, value.into()));
        self
    }

    /// The capture's `observeJson` body: JSON with `content-type: application/json`.
    fn json(mut self, value: &JsonValue) -> Self {
        self.headers
            .insert(0, ("content-type", "application/json".to_owned()));
        self.body = serde_json::to_vec(value).expect("JSON");
        self
    }

    fn bytes(mut self, bytes: &[u8]) -> Self {
        self.body = bytes.to_vec();
        self
    }
}

/// What Firenook answered, normalised the way the capture normalised the
/// official answer.
struct Answer {
    status: u16,
    headers: HeaderMap,
    /// The answer as the capture recorded its kind: JSON, text, or the
    /// `{byteLength, sha256, utf8}` of a download.
    body: JsonValue,
    raw: JsonValue,
}

async fn send(runtime: &StorageRuntime, sent: Sent, download: bool) -> Answer {
    let mut builder = Request::builder().method(sent.method).uri(&sent.uri);
    for (name, value) in &sent.headers {
        builder = builder.header(*name, value);
    }
    let response = runtime
        .application()
        .oneshot(builder.body(Body::from(sent.body)).expect("request"))
        .await
        .expect("response");
    let status = response.status().as_u16();
    let headers = response.headers().clone();
    let bytes = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body");
    let content_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    // `observeDownload` keeps a JSON answer as JSON and digests any other;
    // `observeJson`/`observeBytes` parse the text, keeping it when not JSON.
    let raw = if download && !content_type.contains("application/json") {
        json!({
            "byteLength": bytes.len(),
            "sha256": sha256_hex(&bytes),
            "utf8": String::from_utf8_lossy(&bytes),
        })
    } else if bytes.is_empty() {
        JsonValue::Null
    } else {
        serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| JsonValue::String(String::from_utf8_lossy(&bytes).into_owned()))
    };
    Answer {
        status,
        headers,
        body: normalize(&raw),
        raw,
    }
}

/// `normalizeString`: the origin, upload ids, tokens and generations.
fn normalize_string(value: &str) -> String {
    let mut text = value.replace(ORIGIN, "<storage-origin>");
    for parameter in ["upload_id", "token", "delete_token"] {
        text = replace_parameter(
            &text,
            parameter,
            match parameter {
                "upload_id" => "<upload-id>",
                _ => "<download-token>",
            },
        );
    }
    text = replace_parameter(&text, "generation", "<generation>");
    // The capture replaced a 13-digit trailing generation (the official
    // emulator's milliseconds); Firenook's generations have 16 digits, as
    // production's do. Both vary per run.
    if let Some((head, tail)) = text.rsplit_once('/')
        && tail.len() >= 13
        && tail.bytes().all(|byte| byte.is_ascii_digit())
    {
        text = format!("{head}/<generation>");
    }
    text
}

fn replace_parameter(text: &str, name: &str, placeholder: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(index) = ["?", "&"]
        .iter()
        .filter_map(|separator| rest.find(&format!("{separator}{name}=")))
        .min()
    {
        let start = index + name.len() + 2;
        out.push_str(&rest[..start]);
        rest = &rest[start..];
        let end = rest.find('&').unwrap_or(rest.len());
        out.push_str(placeholder);
        rest = &rest[end..];
    }
    out.push_str(rest);
    out
}

fn uuid_or_digits(value: &str) -> bool {
    (!value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()))
        || (value.len() == 36
            && value
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() || byte == b'-'))
}

/// `sanitizeStorageResponse` then `normalizeDynamic`, in one pass.
fn normalize(value: &JsonValue) -> JsonValue {
    match value {
        JsonValue::Array(items) => JsonValue::Array(items.iter().map(normalize).collect()),
        JsonValue::String(text) => JsonValue::String(normalize_string(text)),
        JsonValue::Object(fields) => {
            let mut out = JsonMap::new();
            for (key, child) in fields {
                let normalized = match (key.as_str(), child) {
                    ("downloadTokens" | "firebaseStorageDownloadTokens", child) => {
                        let count = match child {
                            JsonValue::String(text) if !text.is_empty() => text.split(',').count(),
                            JsonValue::Array(items) => items.len(),
                            _ => 0,
                        };
                        json!(format!(
                            "<{count}-download-token{}>",
                            if count == 1 { "" } else { "s" }
                        ))
                    }
                    ("eventId" | "id", JsonValue::String(text)) if uuid_or_digits(text) => {
                        json!(format!("<generated-{key}>"))
                    }
                    (
                        "generation" | "metageneration",
                        JsonValue::String(_) | JsonValue::Number(_),
                    )
                    | (
                        "timeCreated"
                        | "updated"
                        | "timeStorageClassUpdated"
                        | "timestamp"
                        | "time",
                        JsonValue::String(_),
                    ) => json!(format!("<generated-{key}>")),
                    ("etag", JsonValue::String(_)) => json!("<generated-etag>"),
                    ("host", JsonValue::String(text)) if text.starts_with("127.0.0.1:") => {
                        json!("<functions-emulator-host>")
                    }
                    (_, child) => normalize(child),
                };
                out.insert(key.clone(), normalized);
            }
            JsonValue::Object(out)
        }
        other => other.clone(),
    }
}

/// The differences between one answer and its recording: status, the
/// recorded headers except `content-length` (it measures the official body
/// before normalisation; the body is compared) and the body.
fn differences(answer: &Answer, recorded: &JsonValue) -> Vec<String> {
    let id = recorded["id"].as_str().expect("id");
    let mut found = Vec::new();
    if u64::from(answer.status) != recorded["status"] {
        found.push(format!(
            "{id}: status {} where {} was recorded ({})",
            answer.status, recorded["status"], answer.raw
        ));
    }
    for (name, value) in recorded["responseHeaders"].as_object().expect("headers") {
        if name == "content-length" {
            continue;
        }
        let actual = answer
            .headers
            .get(name.as_str())
            .and_then(|value| value.to_str().ok())
            .map(normalize_string);
        if actual.as_deref() != value.as_str() {
            found.push(format!(
                "{id}: header {name} {actual:?} where {value} was recorded"
            ));
        }
    }
    json_differences(
        &recorded["response"],
        &answer.body,
        &format!("{id}: body"),
        &mut found,
    );
    found
}

fn json_differences(expected: &JsonValue, actual: &JsonValue, path: &str, found: &mut Vec<String>) {
    match (expected, actual) {
        (JsonValue::Object(left), JsonValue::Object(right)) => {
            for key in left
                .keys()
                .chain(right.keys().filter(|key| !left.contains_key(*key)))
            {
                json_differences(
                    left.get(key).unwrap_or(&JsonValue::Null),
                    right.get(key).unwrap_or(&JsonValue::Null),
                    &format!("{path}.{key}"),
                    found,
                );
            }
            if left.keys().ne(right.keys()) && left.len() == right.len() {
                found.push(format!(
                    "{path}: key order {:?} where {:?} was recorded",
                    right.keys().collect::<Vec<_>>(),
                    left.keys().collect::<Vec<_>>()
                ));
            }
        }
        (JsonValue::Array(left), JsonValue::Array(right)) if left.len() == right.len() => {
            for (index, (left, right)) in left.iter().zip(right).enumerate() {
                json_differences(left, right, &format!("{path}[{index}]"), found);
            }
        }
        _ if expected != actual => {
            found.push(format!("{path}: {actual} where {expected} was recorded"));
        }
        _ => {}
    }
}

fn observation<'a>(fixture: &'a JsonValue, id: &str) -> &'a JsonValue {
    fixture["observations"]
        .as_array()
        .expect("observations")
        .iter()
        .find(|observation| observation["id"] == id)
        .unwrap_or_else(|| panic!("no recorded {id}"))
}

/// Sends `sent` and compares the answer with recording `id` of `scenario`;
/// returns Firenook's raw answer for the steps after it. The case is noted
/// at the end of the test, once every difference is classified.
async fn replay(
    runtime: &StorageRuntime,
    fixture: &JsonValue,
    scenario: &str,
    id: &str,
    sent: Sent,
    download: bool,
) -> Answer {
    let recorded = observation(fixture, id);
    assert_eq!(recorded["method"], sent.method.as_str(), "{id}: method");
    assert_eq!(
        recorded["path"].as_str().expect("path"),
        normalize_string(&sent.uri),
        "{id}: the recorded request"
    );
    if let Some(digest) = recorded["request"]["sha256"].as_str() {
        assert_eq!(sha256_hex(&sent.body), digest, "{id}: the recorded bytes");
    }
    let answer = send(runtime, sent, download).await;
    let found = differences(&answer, recorded);
    COMPARED.with_borrow_mut(|all| all.push((format!("{scenario}/{id}"), found)));
    answer
}

thread_local! {
    /// Every compared case with the differences found, in order.
    static COMPARED: std::cell::RefCell<Vec<(String, Vec<String>)>> =
        const { std::cell::RefCell::new(Vec::new()) };
}

/// Why the cases in [`DIFFERS`] answer otherwise, deliberately: a one-shot
/// `v0` upload takes its content type from the request `Content-Type` (commit "name a
/// one-shot upload by its Content-Type"; the storage-rules-v1 replay in
/// `rules_replay_tests.rs` records the same choice), as firebase-tools 15.34.0
/// stores it (`storage-native-clients-v1` `uploads/object-path-media` and
/// `uploads/bucket-path-media-put`, checked by its replay).
const V0_CONTENT_TYPE: &str = "a v0 one-shot upload takes its content type from the request Content-Type, as firebase-tools 15.34.0 stores it (storage-native-clients-v1 uploads/object-path-media, bucket-path-media-put); 15.22.0 stored application/octet-stream";

/// Cases whose only differences in status or body come from [`V0_CONTENT_TYPE`]:
/// the upload's own answer, and every later answer about that object.
const DIFFERS: &[&str] = &[
    "storage-firebase-v0-and-download-tokens/firebase-v0-media-upload",
    "storage-firebase-v0-and-download-tokens/download-token-bypasses-rules",
    "storage-firebase-v0-and-download-tokens/firebase-v0-get-metadata",
    "storage-firebase-v0-and-download-tokens/firebase-v0-update-metadata",
    "storage-firebase-v0-and-download-tokens/firebase-v0-create-download-token",
    "storage-firebase-v0-and-download-tokens/firebase-v0-delete-download-token",
    "storage-multi-bucket-rules-and-import-export/default-bucket-owner-upload",
    "storage-multi-bucket-rules-and-import-export/default-bucket-owner-read",
    "storage-multi-bucket-rules-and-import-export/assets-bucket-admin-upload",
    "storage-multi-bucket-rules-and-import-export/assets-bucket-public-read",
    "storage-multi-bucket-rules-and-import-export/reimported-default-object-byte-check",
    "storage-multi-bucket-rules-and-import-export/reimported-assets-object-byte-check",
];

/// Why the cases in [`GCS_DIFFERS`] answer otherwise, deliberately: a GCS
/// JSON API media upload's `Content-Type` header is the object's content
/// type, as Cloud Storage documents it ("Uploading objects", JSON API:
/// `OBJECT_CONTENT_TYPE` is the content type of the object), the same choice
/// as [`V0_CONTENT_TYPE`]; firebase-tools 15.22.0 stored
/// `application/octet-stream`.
const GCS_CONTENT_TYPE: &str = "a GCS uploadType=media upload's Content-Type is the object's content type, as Cloud Storage documents it (docs.cloud.google.com/storage/docs/uploading-objects, JSON API), and as firebase-tools 15.34.0 does for a v0 one-shot upload; 15.22.0 stored application/octet-stream";

/// The GCS media upload, its listing and its copy: their only differences in
/// status or body come from [`GCS_CONTENT_TYPE`].
const GCS_DIFFERS: &[&str] = &[
    "storage-gcs-json-and-resumable-upload/gcs-json-media-upload",
    "storage-gcs-json-and-resumable-upload/gcs-list-objects",
    "storage-gcs-json-and-resumable-upload/gcs-emulator-copy-alias",
];

/// Header differences outside the recorded answer (status and body), asserted
/// so that a change shows here; they do not hold a case back.
const HEADER_DIFFERENCES: &[(&str, &str)] = &[
    (
        "header content-type Some(\"application/json\") where \"application/json; charset=utf-8\" was recorded",
        "a JSON answer's Content-Type has no charset parameter (RFC 8259 defines none; Express adds it)",
    ),
    (
        "header cache-control None where \"public,max-age=60\" was recorded",
        "the official v0 metadata update and token answers repeat the object's Cache-Control on the JSON answer itself",
    ),
    (
        "header content-disposition None where \"inline\" was recorded",
        "the official v0 metadata update and token answers repeat the object's Content-Disposition on the JSON answer itself",
    ),
];

/// Whether a difference is the object's content type, as [`V0_CONTENT_TYPE`]
/// and [`GCS_CONTENT_TYPE`] describe it.
fn is_content_type(difference: &str) -> bool {
    let recorded = "where \"application/octet-stream\" was recorded";
    difference.ends_with(recorded)
        && (difference.contains(": body.contentType: \"text/plain")
            || difference.contains(": body.items[0].contentType: \"text/plain")
            || difference.contains(": header content-type Some(\"text/plain"))
}

/// Notes every compared case: `checked`, or `differs` for [`DIFFERS`] and
/// [`GCS_DIFFERS`]; fails on any difference no table names.
fn note_compared(compared: &[(String, Vec<String>)]) {
    let mut unexplained = Vec::new();
    let mut header_seen = BTreeSet::new();
    let mut differing = BTreeSet::new();
    for (case, found) in compared {
        let id = case.rsplit_once('/').map_or(case.as_str(), |(_, id)| id);
        let mut content_type = false;
        for difference in found {
            let detail = difference
                .strip_prefix(&format!("{id}: "))
                .unwrap_or(difference);
            if let Some((pattern, _)) = HEADER_DIFFERENCES
                .iter()
                .find(|(pattern, _)| detail == *pattern)
            {
                header_seen.insert(*pattern);
            } else if is_content_type(difference) {
                content_type = true;
            } else {
                unexplained.push(format!("{case}: {difference}"));
            }
        }
        if content_type {
            differing.insert(case.as_str());
        } else if found.iter().all(|difference| !is_content_type(difference)) {
            firenook_conformance_ledger::checked(
                SET,
                case,
                firenook_conformance_ledger::Compared::Answer,
            );
        }
    }
    assert!(
        unexplained.is_empty(),
        "{} differences no table names:\n{}",
        unexplained.len(),
        unexplained.join("\n")
    );
    let expected: BTreeSet<&str> = DIFFERS
        .iter()
        .copied()
        .chain(GCS_DIFFERS.iter().copied())
        .collect();
    assert_eq!(differing, expected, "the cases that answer otherwise");
    for case in DIFFERS {
        firenook_conformance_ledger::differs(
            SET,
            case,
            firenook_conformance_ledger::Compared::Answer,
            V0_CONTENT_TYPE,
        );
    }
    for case in GCS_DIFFERS {
        firenook_conformance_ledger::differs(
            SET,
            case,
            firenook_conformance_ledger::Compared::Answer,
            GCS_CONTENT_TYPE,
        );
    }
    for (pattern, reason) in HEADER_DIFFERENCES {
        assert!(
            header_seen.contains(pattern),
            "no longer observed: {reason}"
        );
    }
}

fn header_text(answer: &Answer, name: header::HeaderName) -> String {
    answer
        .headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .expect("header")
        .to_owned()
}

fn rules() -> NativeRulesConfig {
    NativeRulesConfig {
        source: RulesSource::PerBucket(vec![
            BucketRules {
                bucket: DEFAULT_BUCKET.to_owned(),
                name: "synthetic-storage.default.rules".to_owned(),
                content: include_str!("../testdata/synthetic-storage.default.rules").to_owned(),
            },
            BucketRules {
                bucket: ASSETS_BUCKET.to_owned(),
                name: "synthetic-storage.assets.rules".to_owned(),
                content: include_str!("../testdata/synthetic-storage.assets.rules").to_owned(),
            },
        ]),
        documents: Arc::new(NoFirestoreDocuments),
    }
}

#[tokio::test]
#[allow(clippy::too_many_lines)]
async fn one_official_session_of_v0_gcs_and_multi_bucket_requests_replays_in_order() {
    let v0 = fixture("storage-firebase-v0-and-download-tokens");
    let gcs = fixture("storage-gcs-json-and-resumable-upload");
    let multi = fixture("storage-multi-bucket-rules-and-import-export");
    for recording in [&v0, &gcs, &multi] {
        assert_eq!(recording["targetVersion"], "15.22.0");
        assert_eq!(recording["targetProject"], PROJECT);
    }
    let root = std::env::temp_dir().join(format!(
        "firenook-storage-suite-replay-{}-{}",
        std::process::id(),
        OffsetDateTime::now_utc().unix_timestamp_nanos()
    ));
    let registry = TriggerRegistry::default();
    let (observer, mut dispatches) = TriggerObserver::channel(registry.clone());
    let runtime = StorageRuntime::start(
        StorageConfig {
            project: PROJECT.to_owned(),
            durability: StorageDurability::default(),
            origin: ORIGIN.to_owned(),
            data_dir: root.join("data"),
            rules: Some(rules()),
        },
        observer.queue(),
        registry,
    )
    .await
    .expect("Storage runtime");
    let storage = runtime;
    let runtime = &storage;

    // storage-firebase-v0-and-download-tokens
    let scenario = "storage-firebase-v0-and-download-tokens";
    let object = "users%2Falice%2F%E7%81%AB%F0%9F%94%A5.txt";
    replay(
        runtime,
        &v0,
        scenario,
        "readiness",
        Sent::new(Method::GET, "/v0/"),
        false,
    )
    .await;
    let upload = replay(
        runtime,
        &v0,
        scenario,
        "firebase-v0-media-upload",
        Sent::new(
            Method::POST,
            format!("/v0/b/{DEFAULT_BUCKET}/o?name={object}"),
        )
        .header("authorization", "Bearer owner")
        .header("content-type", "text/plain; charset=utf-8")
        .bytes("Firebase v0 says 火🔥\n".as_bytes()),
        false,
    )
    .await;
    let token = upload.raw["downloadTokens"]
        .as_str()
        .expect("a download token")
        .split(',')
        .next()
        .expect("first token")
        .to_owned();
    let media = format!("/v0/b/{DEFAULT_BUCKET}/o/{object}?alt=media");
    replay(
        runtime,
        &v0,
        scenario,
        "default-bucket-public-read-denied",
        Sent::new(Method::GET, media.clone()),
        false,
    )
    .await;
    replay(
        runtime,
        &v0,
        scenario,
        "download-token-bypasses-rules",
        Sent::new(Method::GET, format!("{media}&token={token}")),
        true,
    )
    .await;
    replay(
        runtime,
        &v0,
        scenario,
        "firebase-v0-get-metadata",
        Sent::new(Method::GET, format!("/v0/b/{DEFAULT_BUCKET}/o/{object}"))
            .header("authorization", "Bearer owner"),
        false,
    )
    .await;
    replay(
        runtime,
        &v0,
        scenario,
        "firebase-v0-list-prefix",
        Sent::new(
            Method::GET,
            format!(
                "/v0/b/{DEFAULT_BUCKET}/o?prefix=users%2Falice%2F&delimiter=%2F&maxResults=100"
            ),
        )
        .header("authorization", "Bearer owner"),
        false,
    )
    .await;
    replay(
        runtime,
        &v0,
        scenario,
        "firebase-v0-update-metadata",
        Sent::new(Method::PATCH, format!("/v0/b/{DEFAULT_BUCKET}/o/{object}"))
            .json(&observation(&v0, "firebase-v0-update-metadata")["request"])
            .header("authorization", "Bearer owner"),
        false,
    )
    .await;
    let created = replay(
        runtime,
        &v0,
        scenario,
        "firebase-v0-create-download-token",
        Sent::new(
            Method::POST,
            format!("/v0/b/{DEFAULT_BUCKET}/o/{object}?create_token=true"),
        )
        .json(&json!({}))
        .header("authorization", "Bearer owner"),
        false,
    )
    .await;
    let tokens: Vec<&str> = created.raw["downloadTokens"]
        .as_str()
        .expect("tokens")
        .split(',')
        .collect();
    assert_eq!(tokens.len(), 2, "creating a token keeps the first");
    assert_eq!(tokens[0], token);
    replay(
        runtime,
        &v0,
        scenario,
        "firebase-v0-delete-download-token",
        Sent::new(
            Method::POST,
            format!(
                "/v0/b/{DEFAULT_BUCKET}/o/{object}?delete_token={}",
                tokens[1]
            ),
        )
        .json(&json!({}))
        .header("authorization", "Bearer owner"),
        false,
    )
    .await;

    // storage-gcs-json-and-resumable-upload
    let scenario = "storage-gcs-json-and-resumable-upload";
    let media_name = "admin%2Fgcs-media-%E7%81%AB.txt";
    let resumable_name = "admin%2Fresumable-%F0%9F%94%A5.bin";
    replay(
        runtime,
        &gcs,
        scenario,
        "gcs-json-media-upload",
        Sent::new(
            Method::POST,
            format!("/upload/storage/v1/b/{ASSETS_BUCKET}/o?uploadType=media&name={media_name}"),
        )
        .header("content-type", "text/plain; charset=utf-8")
        .bytes("GCS media 火\n".as_bytes()),
        false,
    )
    .await;
    let start = replay(
        runtime,
        &gcs,
        scenario,
        "gcs-resumable-start",
        Sent::new(
            Method::POST,
            format!(
                "/upload/storage/v1/b/{ASSETS_BUCKET}/o?uploadType=resumable&name={resumable_name}"
            ),
        )
        .json(&observation(&gcs, "gcs-resumable-start")["request"])
        .header("x-upload-content-type", "application/octet-stream"),
        false,
    )
    .await;
    let location = header_text(&start, header::LOCATION).replace(ORIGIN, "");
    let resumable = "chunk-one-火|chunk-two-🔥".as_bytes();
    replay(
        runtime,
        &gcs,
        scenario,
        "gcs-resumable-upload-and-finalize",
        Sent::new(Method::PUT, location.clone())
            .header("content-type", "application/octet-stream")
            .bytes(resumable),
        false,
    )
    .await;
    replay(
        runtime,
        &gcs,
        scenario,
        "gcs-resumable-duplicate-finalize",
        Sent::new(Method::PUT, location).header("content-type", "application/octet-stream"),
        false,
    )
    .await;
    replay(
        runtime,
        &gcs,
        scenario,
        "gcs-list-objects",
        Sent::new(
            Method::GET,
            format!("/storage/v1/b/{ASSETS_BUCKET}/o?prefix=admin%2F&maxResults=100"),
        ),
        false,
    )
    .await;
    replay(
        runtime,
        &gcs,
        scenario,
        "gcs-download-resumable-object",
        Sent::new(
            Method::GET,
            format!("/download/storage/v1/b/{ASSETS_BUCKET}/o/{resumable_name}?alt=media"),
        ),
        true,
    )
    .await;
    let copy = json!({ "metadata": { "copied": "true" } });
    let copied = "admin%2Fcopied-%E7%81%AB.txt";
    replay(
        runtime,
        &gcs,
        scenario,
        "gcs-canonical-copy-path-not-implemented",
        Sent::new(
            Method::POST,
            format!(
                "/storage/v1/b/{ASSETS_BUCKET}/o/{media_name}/copyTo/b/{ASSETS_BUCKET}/o/{copied}"
            ),
        )
        .json(&copy),
        false,
    )
    .await;
    replay(
        runtime,
        &gcs,
        scenario,
        "gcs-emulator-copy-alias",
        Sent::new(
            Method::POST,
            format!("/b/{ASSETS_BUCKET}/o/{media_name}/copyTo/b/{ASSETS_BUCKET}/o/{copied}"),
        )
        .json(&copy),
        false,
    )
    .await;

    // storage-multi-bucket-rules-and-import-export
    let scenario = "storage-multi-bucket-rules-and-import-export";
    let owner = user_token("alice", false, "password");
    let other = user_token("bob", false, "password");
    let admin = user_token("admin-user", true, "custom");
    let private = "users%2Falice%2Fprivate.txt";
    let public = "catalog%2Fpublic-%E7%81%AB.txt";
    replay(
        runtime,
        &multi,
        scenario,
        "default-bucket-owner-upload",
        Sent::new(
            Method::POST,
            format!("/v0/b/{DEFAULT_BUCKET}/o?name={private}"),
        )
        .header("authorization", format!("Bearer {owner}"))
        .header("content-type", "text/plain")
        .bytes(b"private default bucket"),
        false,
    )
    .await;
    replay(
        runtime,
        &multi,
        scenario,
        "default-bucket-owner-read",
        Sent::new(
            Method::GET,
            format!("/v0/b/{DEFAULT_BUCKET}/o/{private}?alt=media"),
        )
        .header("authorization", format!("Bearer {owner}")),
        true,
    )
    .await;
    replay(
        runtime,
        &multi,
        scenario,
        "default-bucket-other-user-denied",
        Sent::new(
            Method::GET,
            format!("/v0/b/{DEFAULT_BUCKET}/o/{private}?alt=media"),
        )
        .header("authorization", format!("Bearer {other}")),
        true,
    )
    .await;
    replay(
        runtime,
        &multi,
        scenario,
        "assets-bucket-admin-upload",
        Sent::new(
            Method::POST,
            format!("/v0/b/{ASSETS_BUCKET}/o?name={public}"),
        )
        .header("authorization", format!("Bearer {admin}"))
        .header("content-type", "text/plain")
        .bytes("public assets 火🔥".as_bytes()),
        false,
    )
    .await;
    replay(
        runtime,
        &multi,
        scenario,
        "assets-bucket-public-read",
        Sent::new(
            Method::GET,
            format!("/v0/b/{ASSETS_BUCKET}/o/{public}?alt=media"),
        ),
        true,
    )
    .await;

    // The uploads above sent their lifecycle events; the export, reset and
    // import below send none (`exportImportDispatchCount`).
    tokio::task::yield_now().await;
    while dispatches.try_recv().is_ok() {}
    let export = root.join("storage-export");
    std::fs::create_dir_all(&export).expect("export directory");
    // The recorded path is the capture's own temporary directory.
    let exported = observation(&multi, "internal-export");
    let mut request = exported["request"].clone();
    request["path"] = json!(export.to_str().expect("UTF-8 path"));
    let answer = send(
        runtime,
        Sent::new(Method::POST, "/internal/export").json(&request),
        false,
    )
    .await;
    let found = differences(&answer, exported);
    assert_export_layout(&export, &multi);
    COMPARED.with_borrow_mut(|all| all.push((format!("{scenario}/internal-export"), found)));
    replay(
        runtime,
        &multi,
        scenario,
        "internal-reset",
        Sent::new(Method::POST, "/internal/reset").json(&json!({})),
        false,
    )
    .await;
    assert_eq!(runtime.object_count(), 0, "the reset removes every object");
    // The capture imported with the storage layer's own `import`.
    assert_eq!(runtime.import(&export).await.expect("import"), 6);
    replay(
        runtime,
        &multi,
        scenario,
        "reimported-default-object-byte-check",
        Sent::new(
            Method::GET,
            format!("/download/storage/v1/b/{DEFAULT_BUCKET}/o/{private}?alt=media"),
        ),
        true,
    )
    .await;
    replay(
        runtime,
        &multi,
        scenario,
        "reimported-assets-object-byte-check",
        Sent::new(
            Method::GET,
            format!("/download/storage/v1/b/{ASSETS_BUCKET}/o/{public}?alt=media"),
        ),
        true,
    )
    .await;
    tokio::task::yield_now().await;
    assert!(
        dispatches.try_recv().is_err(),
        "export, reset and import send no lifecycle event"
    );
    assert_eq!(multi["invariants"]["exportImportDispatchCount"], 0);

    storage.shutdown().await.expect("shutdown");
    COMPARED.with_borrow(|compared| {
        assert_eq!(
            compared.len(),
            26,
            "every recorded request of the three scenarios"
        );
        note_compared(compared);
    });
    std::fs::remove_dir_all(&root).expect("remove the replay's storage");
}

/// The export holds the recorded layout: `buckets.json` as recorded, one
/// blob per object with the recorded bytes and one metadata file per blob.
fn assert_export_layout(export: &FilePath, multi: &JsonValue) {
    let inventory = multi["exportInventory"].as_array().expect("inventory");
    let buckets = inventory
        .iter()
        .find(|entry| entry["path"] == "buckets.json")
        .expect("recorded buckets.json");
    let written: JsonValue =
        serde_json::from_slice(&std::fs::read(export.join("buckets.json")).expect("buckets.json"))
            .expect("buckets JSON");
    assert_eq!(written, buckets["json"], "buckets.json");
    let digests = |directory: &str| -> Vec<String> {
        let mut found: Vec<String> = std::fs::read_dir(export.join(directory))
            .expect("export directory")
            .map(|entry| {
                sha256_hex(&std::fs::read(entry.expect("entry").path()).expect("export file"))
            })
            .collect();
        found.sort();
        found
    };
    let mut recorded_blobs: Vec<String> = inventory
        .iter()
        .filter(|entry| {
            entry["path"]
                .as_str()
                .is_some_and(|path| path.starts_with("blobs/"))
        })
        .map(|entry| entry["sha256"].as_str().expect("sha256").to_owned())
        .collect();
    recorded_blobs.sort();
    assert_eq!(digests("blobs"), recorded_blobs, "exported object bytes");
    let metadata = std::fs::read_dir(export.join("metadata"))
        .expect("metadata directory")
        .count();
    assert_eq!(metadata, recorded_blobs.len(), "one metadata file per blob");
}
