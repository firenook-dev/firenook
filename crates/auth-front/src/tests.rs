//! Crate-level checks; the behavioural gate is the corpus replay
//! (`conformance/src/auth/replay-firenook.ts`).

use std::collections::BTreeMap;

use axum::body::{Body, to_bytes};
use axum::http::{Method, Request};
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use firenook_functions_bridge::{TriggerObserver, TriggerRegistry};
use serde_json::{Value as JsonValue, json};
use tower::ServiceExt as _;

use super::*;
use crate::util::decode_jwt;

fn test_runtime() -> AuthRuntime {
    let registry = TriggerRegistry::default();
    let (observer, _receiver) = TriggerObserver::channel(registry.clone());
    AuthRuntime::new("demo-auth", observer.queue(), registry, None).expect("runtime")
}

async fn call(
    runtime: &AuthRuntime,
    method: Method,
    uri: &str,
    body: &JsonValue,
) -> (u16, JsonValue) {
    let mut request = Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json")
        .header("host", "127.0.0.1:9099");
    // Admin routes carry the Admin SDK's owner credential; client routes carry
    // their API key in the path.
    if !uri.contains("key=") {
        request = request.header("authorization", "Bearer owner");
    }
    let request = request.body(Body::from(body.to_string())).expect("request");
    let response = runtime
        .application()
        .oneshot(request)
        .await
        .expect("response");
    let status = response.status().as_u16();
    let bytes = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body");
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(JsonValue::Null),
    )
}

#[tokio::test]
async fn password_sign_up_lookup_and_refresh() {
    let runtime = test_runtime();
    let (status, body) = call(
        &runtime,
        Method::POST,
        "/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake",
        &json!({ "email": "Alice@Example.com", "password": "password1", "returnSecureToken": true }),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["email"], "alice@example.com");
    let id_token = body["idToken"].as_str().expect("id token").to_owned();
    let refresh = body["refreshToken"]
        .as_str()
        .expect("refresh token")
        .to_owned();
    let (status, body) = call(
        &runtime,
        Method::POST,
        "/identitytoolkit.googleapis.com/v1/accounts:lookup?key=fake",
        &json!({ "idToken": id_token }),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["users"][0]["email"], "alice@example.com");
    let (status, body) = call(
        &runtime,
        Method::POST,
        "/securetoken.googleapis.com/v1/token?key=fake",
        &json!({ "grant_type": "refresh_token", "refresh_token": refresh }),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["token_type"], "Bearer");
    assert_eq!(runtime.user_count(), 1);
}

#[tokio::test]
async fn missing_api_key_and_unknown_routes_answer_like_the_official_emulator() {
    let runtime = test_runtime();
    let response = runtime
        .application()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/identitytoolkit.googleapis.com/v1/accounts:signUp")
                .header("content-type", "application/json")
                .body(Body::from("{}"))
                .expect("request"),
        )
        .await
        .expect("response");
    let status = response.status().as_u16();
    let body: JsonValue = serde_json::from_slice(
        &to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body"),
    )
    .expect("JSON");
    assert_eq!(status, 403);
    assert_eq!(
        body["error"]["message"],
        "The request is missing a valid API key."
    );
    let (status, body) = call(&runtime, Method::GET, "/nothing", &json!({})).await;
    assert_eq!(status, 404);
    assert_eq!(body["error"]["status"], "NOT_FOUND");
    let (status, _) = call(
        &runtime,
        Method::GET,
        "/identitytoolkit.googleapis.com/v1/accounts:lookup?key=fake",
        &json!({}),
    )
    .await;
    assert_eq!(status, 405);
}

#[test]
fn frozen_fixture_covers_every_official_operation() {
    let fixture: JsonValue = serde_json::from_str(include_str!(
        "../../../conformance/fixtures/auth-v1/emulator-programs.json"
    ))
    .expect("fixture");
    assert_eq!(fixture["targetVersion"], "15.22.0");
    assert_eq!(
        fixture["coverage"]["officialImplementedMissing"]
            .as_array()
            .map(Vec::len),
        Some(0)
    );
    assert!(
        fixture["stepCount"]
            .as_u64()
            .is_some_and(|steps| steps >= 500)
    );
}

// ------------------------------------------------------------------
// The frozen next.7-era fixtures under `conformance/fixtures/firebase-suite-v1`
// stay green: the gate `benchmarks/phase-i-auth.json` lists them as
// `existingAuthFixturesUnchanged`. Their placeholders (`<generated-...>`,
// `<emulator-token-redacted>`, `{ "redacted": "emulator-jwt", "claims" }`)
// are resolved from the live run.

type Dispatches = tokio::sync::mpsc::UnboundedReceiver<firenook_functions_bridge::DispatchRequest>;

fn fixture_runtime(project: &str) -> (AuthRuntime, Dispatches) {
    let registry = TriggerRegistry::default();
    let (observer, receiver) = TriggerObserver::channel(registry.clone());
    (
        AuthRuntime::new(project, observer.queue(), registry, None).expect("runtime"),
        receiver,
    )
}

/// An Admin-SDK-shaped custom token (unsigned, as the emulator accepts).
fn custom_token(uid: &str, claims: &JsonValue) -> String {
    let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"none","typ":"JWT"}"#);
    let now = crate::util::now_seconds();
    let payload = URL_SAFE_NO_PAD.encode(
        json!({
            "aud": crate::token::CUSTOM_TOKEN_AUDIENCE,
            "iat": now,
            "exp": now + 3600,
            "iss": "firebase-adminsdk@example.iam.gserviceaccount.com",
            "sub": "firebase-adminsdk@example.iam.gserviceaccount.com",
            "uid": uid,
            "claims": claims,
        })
        .to_string(),
    );
    format!("{header}.{payload}.")
}

/// Values learned from earlier observations that later requests reference.
#[derive(Default)]
struct Learned {
    local_id: Option<String>,
    id_token: Option<String>,
    /// Refresh tokens by the sign-in provider they were issued for.
    refresh_tokens: BTreeMap<String, String>,
}

impl Learned {
    fn absorb(&mut self, response: &JsonValue) {
        let learn = |keys: &[&str], slot: &mut Option<String>| {
            for key in keys {
                if let Some(value) = response.get(*key).and_then(JsonValue::as_str) {
                    *slot = Some(value.to_owned());
                }
            }
        };
        learn(&["localId"], &mut self.local_id);
        learn(&["idToken", "id_token"], &mut self.id_token);
        if let Some(refresh) = response.get("refreshToken").and_then(JsonValue::as_str)
            && let Some(id_token) = response.get("idToken").and_then(JsonValue::as_str)
            && let Some((_, claims)) = decode_jwt(id_token)
        {
            let provider = claims["firebase"]["sign_in_provider"]
                .as_str()
                .unwrap_or_default()
                .to_owned();
            self.refresh_tokens.insert(provider, refresh.to_owned());
        }
        if let Some(first) = response["users"][0]
            .get("localId")
            .and_then(JsonValue::as_str)
        {
            self.local_id = Some(first.to_owned());
        }
    }

    fn resolve(&self, value: &JsonValue, path: &str, expected: &JsonValue) -> JsonValue {
        match value {
            JsonValue::String(text) => JsonValue::String(match text.as_str() {
                // The same placeholder stands for the wrong password in the
                // rejected sign-in.
                "<synthetic-password-redacted>" if expected["status"] == 400 => {
                    "synthetic-wrong-password".to_owned()
                }
                "<synthetic-password-redacted>" => "synthetic-password-1".to_owned(),
                "<emulator-token-redacted>" if path.contains("signInWithCustomToken") => {
                    custom_token(
                        "phase4-custom-user",
                        &json!({ "tier": "oracle", "emoji": "🔥" }),
                    )
                }
                "<emulator-token-redacted>" => {
                    self.id_token.clone().expect("an id token was issued")
                }
                "<emulator-refresh-token-redacted>" => {
                    // The recording refreshed the account whose provider the
                    // expected claims name.
                    let provider =
                        expected["response"]["id_token"]["claims"]["firebase"]["sign_in_provider"]
                            .as_str()
                            .unwrap_or("password");
                    self.refresh_tokens
                        .get(provider)
                        .cloned()
                        .unwrap_or_else(|| panic!("no refresh token for {provider}"))
                }
                "<generated-localId>" => self.local_id.clone().expect("a localId was issued"),
                other => other.to_owned(),
            }),
            JsonValue::Array(items) => JsonValue::Array(
                items
                    .iter()
                    .map(|item| self.resolve(item, path, expected))
                    .collect(),
            ),
            JsonValue::Object(map) => JsonValue::Object(
                map.iter()
                    .map(|(key, item)| (key.clone(), self.resolve(item, path, expected)))
                    .collect(),
            ),
            other => other.clone(),
        }
    }
}

/// `expected` from the fixture against the live `actual`: placeholders
/// accept any value of the recorded presence, redacted JWTs are decoded and
/// their claims compared, everything else must be equal.
fn assert_shape(expected: &JsonValue, actual: &JsonValue, path: &str) {
    match expected {
        JsonValue::String(text) if text.starts_with('<') && text.ends_with('>') => {
            assert!(
                !actual.is_null(),
                "{path}: expected a value for {text}, got null"
            );
        }
        JsonValue::Object(map) if map.get("redacted") == Some(&json!("emulator-jwt")) => {
            let token = actual
                .as_str()
                .unwrap_or_else(|| panic!("{path}: expected a JWT"));
            let (_, payload) = decode_jwt(token).unwrap_or_else(|| panic!("{path}: not a JWT"));
            assert_shape(&map["claims"], &payload, &format!("{path}.claims"));
        }
        JsonValue::Object(map) => {
            let actual_map = actual
                .as_object()
                .unwrap_or_else(|| panic!("{path}: expected an object, got {actual}"));
            let expected_keys: Vec<&String> = map.keys().collect();
            let actual_keys: Vec<&String> = actual_map.keys().collect();
            assert_eq!(expected_keys, actual_keys, "{path}: key set");
            for (key, item) in map {
                assert_shape(item, &actual_map[key], &format!("{path}.{key}"));
            }
        }
        JsonValue::Array(items) => {
            let actual_items = actual
                .as_array()
                .unwrap_or_else(|| panic!("{path}: expected an array, got {actual}"));
            assert_eq!(items.len(), actual_items.len(), "{path}: length");
            for (index, item) in items.iter().enumerate() {
                // Account lists are matched by identity: generated ids sort
                // differently from one run to the next.
                let live = match account_key(item) {
                    Some(key) => actual_items
                        .iter()
                        .find(|candidate| account_key(candidate).as_deref() == Some(key.as_str()))
                        .unwrap_or_else(|| panic!("{path}[{index}]: no account {key}")),
                    None => &actual_items[index],
                };
                assert_shape(item, live, &format!("{path}[{index}]"));
            }
        }
        other => assert_eq!(other, actual, "{path}"),
    }
}

/// The stable identity of an exported account, when the item is one.
fn account_key(item: &JsonValue) -> Option<String> {
    let literal = |field: &str| {
        item.get(field)
            .and_then(JsonValue::as_str)
            .filter(|value| !value.starts_with('<'))
            .map(str::to_owned)
    };
    item.get("localId")?;
    literal("email")
        .or_else(|| literal("localId"))
        .or_else(|| literal("phoneNumber"))
}

async fn replay_observations(
    runtime: &AuthRuntime,
    observations: &[JsonValue],
) -> Vec<(String, JsonValue)> {
    let mut learned = Learned::default();
    let mut responses = Vec::new();
    for observation in observations {
        let id = observation["id"].as_str().unwrap_or_default();
        let path = observation["path"].as_str().unwrap_or_default();
        let method = observation["method"].as_str().unwrap_or("GET");
        let mut request = Request::builder()
            .method(Method::from_bytes(method.as_bytes()).expect("method"))
            .uri(path)
            .header("host", "127.0.0.1:9099");
        // Admin routes carry the Admin SDK's owner credential; client routes
        // carry their API key in the path.
        if !path.contains("key=") {
            request = request.header("authorization", "Bearer owner");
        }
        let body = match observation.get("request") {
            Some(body) if !body.is_null() => {
                request = request.header("content-type", "application/json");
                Body::from(learned.resolve(body, path, observation).to_string())
            }
            _ => Body::empty(),
        };
        let response = runtime
            .application()
            .oneshot(request.body(body).expect("request"))
            .await
            .expect("response");
        let status = response.status().as_u16();
        let content_type = response
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_owned();
        let bytes = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body");
        assert_eq!(status, observation["status"], "{id}: status");
        assert_eq!(
            content_type, observation["responseHeaders"]["content-type"],
            "{id}: content type"
        );
        if content_type.starts_with("text/html") {
            // Firenook serves its own helper pages (named divergence).
            responses.push((id.to_owned(), JsonValue::Null));
            continue;
        }
        let actual: JsonValue =
            serde_json::from_slice(&bytes).unwrap_or_else(|_| panic!("{id}: response is not JSON"));
        assert_shape(&observation["response"], &actual, id);
        learned.absorb(&actual);
        responses.push((id.to_owned(), actual));
    }
    responses
}

fn load_suite_fixture(name: &str) -> JsonValue {
    let root = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../conformance/fixtures/firebase-suite-v1/"
    );
    serde_json::from_str(
        &std::fs::read_to_string(format!("{root}{name}/fixture.json")).expect("fixture file"),
    )
    .expect("fixture JSON")
}

#[tokio::test]
async fn phase4_suite_fixtures_replay_in_sequence() {
    // The three fixtures were recorded on one emulator session, in this order.
    let identity = load_suite_fixture("auth-identity-toolkit-and-admin");
    let browser = load_suite_fixture("auth-browser-oauth-and-token-refresh");
    let lifecycle = load_suite_fixture("auth-import-export-and-trigger-dispatch");
    assert_eq!(identity["targetVersion"], "15.22.0");
    let project = identity["targetProject"].as_str().expect("project");
    assert_eq!(browser["targetProject"], project);
    assert_eq!(lifecycle["targetProject"], project);
    let (runtime, mut dispatches) = fixture_runtime(project);

    let observations = identity["observations"].as_array().expect("observations");
    assert_eq!(observations.len(), 11);
    replay_observations(&runtime, observations).await;
    let observations = browser["observations"].as_array().expect("observations");
    assert_eq!(observations.len(), 6);
    replay_observations(&runtime, observations).await;
    // Client sign-ups above multicast their own create events.
    tokio::task::yield_now().await;
    while dispatches.try_recv().is_ok() {}

    let mut seen = Vec::new();
    for observation in lifecycle["observations"].as_array().expect("observations") {
        replay_observations(&runtime, std::slice::from_ref(observation)).await;
        tokio::task::yield_now().await;
        while let Ok(dispatch) = dispatches.try_recv() {
            seen.push((
                observation["id"].as_str().unwrap_or_default().to_owned(),
                dispatch,
            ));
        }
    }
    let invariants = &lifecycle["invariants"];
    assert_eq!(
        seen.iter()
            .filter(|(id, _)| id.contains("batch-import"))
            .count() as u64,
        invariants["batchImportDispatchCount"]
    );
    assert_eq!(seen.len() as u64, invariants["capturedDispatchCount"]);
    let expected = lifecycle["dispatches"].as_array().expect("dispatches");
    for ((id, dispatch), recorded) in seen.iter().zip(expected) {
        assert_eq!(dispatch.path, recorded["path"], "{id}: dispatch path");
        let body: JsonValue = serde_json::from_slice(&dispatch.body).expect("dispatch JSON");
        assert_shape(&recorded["body"], &body, &format!("{id}.dispatch"));
    }
}

#[tokio::test]
async fn refresh_reuse_fixture_replays_for_every_flow() {
    let fixture = load_suite_fixture("auth-refresh-reuse");
    let project = fixture["targetProject"].as_str().expect("project");
    let observations: BTreeMap<&str, &JsonValue> = fixture["observations"]
        .as_array()
        .expect("observations")
        .iter()
        .map(|item| (item["id"].as_str().unwrap_or_default(), item))
        .collect();
    let (runtime, _dispatches) = fixture_runtime(project);
    let runtime = &runtime;
    let refresh = |token: String| async move {
        call(
            runtime,
            Method::POST,
            "/securetoken.googleapis.com/v1/token?key=synthetic-api-key",
            &json!({ "grant_type": "refresh_token", "refresh_token": token }),
        )
        .await
    };
    let check = |id: &str, (status, body): (u16, JsonValue), original: &str, uid: &str| {
        let expected = observations[id];
        assert_eq!(u64::from(status), expected["status"], "{id}");
        if status != 200 {
            assert_eq!(body["error"]["message"], expected["error"], "{id}");
            return;
        }
        assert_eq!(
            body["refresh_token"] == original,
            expected["sameRefreshToken"],
            "{id}"
        );
        assert_eq!(
            body["access_token"] == body["id_token"],
            expected["accessTokenEqualsIdToken"],
            "{id}"
        );
        assert_eq!(body["user_id"] == uid, expected["userMatches"], "{id}");
        assert_eq!(body["expires_in"], expected["expiresIn"], "{id}");
        assert_eq!(body["token_type"], expected["tokenType"], "{id}");
        assert_eq!(body["project_id"], expected["projectId"], "{id}");
        let (_, claims) = decode_jwt(body["id_token"].as_str().expect("id token")).expect("JWT");
        assert_eq!(claims["aud"], expected["claims"]["aud"], "{id}");
        assert_eq!(claims["iss"], expected["claims"]["iss"], "{id}");
        assert_eq!(
            claims["firebase"]["sign_in_provider"], expected["claims"]["provider"],
            "{id}"
        );
    };
    let flows: [(&str, &str, JsonValue); 3] = [
        (
            "anonymous",
            "/identitytoolkit.googleapis.com/v1/accounts:signUp?key=synthetic-api-key",
            json!({ "returnSecureToken": true }),
        ),
        (
            "password",
            "/identitytoolkit.googleapis.com/v1/accounts:signUp?key=synthetic-api-key",
            json!({ "email": "refresh@example.invalid", "password": "synthetic-password", "returnSecureToken": true }),
        ),
        (
            "custom",
            "/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=synthetic-api-key",
            json!({ "token": custom_token("custom-refresh-user", &json!({})), "returnSecureToken": true }),
        ),
    ];
    for (flow, path, body) in flows {
        let (status, signup) = call(runtime, Method::POST, path, &body).await;
        assert_eq!(status, 200, "{flow}: {signup}");
        let token = signup["refreshToken"]
            .as_str()
            .expect("refresh token")
            .to_owned();
        let (_, claims) = decode_jwt(signup["idToken"].as_str().expect("id token")).expect("JWT");
        let uid = claims["user_id"].as_str().expect("uid").to_owned();
        check(
            &format!("{flow}-first"),
            refresh(token.clone()).await,
            &token,
            &uid,
        );
        check(
            &format!("{flow}-repeat-original"),
            refresh(token.clone()).await,
            &token,
            &uid,
        );
        let results = tokio::join!(
            refresh(token.clone()),
            refresh(token.clone()),
            refresh(token.clone()),
            refresh(token.clone())
        );
        for (index, result) in [results.0, results.1, results.2, results.3]
            .into_iter()
            .enumerate()
        {
            check(
                &format!("{flow}-concurrent-{}", index + 1),
                result,
                &token,
                &uid,
            );
        }
        let admin = format!("/identitytoolkit.googleapis.com/v1/projects/{project}/accounts");
        for (disabled, id) in [(true, "disabled"), (false, "reenabled-original")] {
            let (status, body) = call(
                runtime,
                Method::POST,
                &format!("{admin}:update"),
                &json!({ "localId": uid, "disableUser": disabled }),
            )
            .await;
            assert_eq!(status, 200, "{flow}: {body}");
            check(
                &format!("{flow}-{id}"),
                refresh(token.clone()).await,
                &token,
                &uid,
            );
        }
        let (status, _) = call(
            runtime,
            Method::POST,
            &format!("{admin}:delete"),
            &json!({ "localId": uid }),
        )
        .await;
        assert_eq!(status, 200);
        check(
            &format!("{flow}-deleted"),
            refresh(token.clone()).await,
            &token,
            &uid,
        );
    }
    check(
        "unknown-token",
        refresh("unknown".to_owned()).await,
        "unknown",
        "",
    );
}

#[tokio::test]
async fn refresh_grant_survives_a_durable_restart() {
    let file = std::env::temp_dir().join(format!(
        "firenook-auth-refresh-{}-{}.json",
        std::process::id(),
        crate::util::now_millis()
    ));
    let registry = TriggerRegistry::default();
    let (observer, _dispatches) = TriggerObserver::channel(registry.clone());
    let runtime = AuthRuntime::new(
        "demo-auth",
        observer.queue(),
        registry.clone(),
        Some(file.clone()),
    )
    .expect("runtime");
    let (_, signup) = call(
        &runtime,
        Method::POST,
        "/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake",
        &json!({ "email": "durable@example.invalid", "password": "synthetic-password", "returnSecureToken": true }),
    )
    .await;
    let token = signup["refreshToken"]
        .as_str()
        .expect("refresh token")
        .to_owned();
    drop(runtime);
    let restarted = AuthRuntime::new("demo-auth", observer.queue(), registry, Some(file.clone()))
        .expect("restart");
    assert_eq!(restarted.user_count(), 1);
    let (status, body) = call(
        &restarted,
        Method::POST,
        "/securetoken.googleapis.com/v1/token?key=fake",
        &json!({ "grant_type": "refresh_token", "refresh_token": token }),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["refresh_token"], token);
    std::fs::remove_file(file).expect("remove test state");
}

#[tokio::test]
async fn developer_tools_tenant_discovery_matches_the_official_ui_capture() {
    let fixture: JsonValue = serde_json::from_str(
        &std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../conformance/fixtures/developer-tools-v1/fixture.json"
        ))
        .expect("fixture file"),
    )
    .expect("fixture JSON");
    let exchange = fixture["browser"]["exchanges"]
        .as_array()
        .expect("exchanges")
        .iter()
        .find(|exchange| {
            exchange["service"] == "auth"
                && exchange["path"]
                    .as_str()
                    .is_some_and(|path| path.ends_with("/tenants"))
        })
        .expect("official tenant discovery");
    let (runtime, _dispatches) = fixture_runtime("demo-fireside-developer-tools");
    let (status, body) = call(
        &runtime,
        Method::GET,
        exchange["path"].as_str().expect("path"),
        &JsonValue::Null,
    )
    .await;
    assert_eq!(u64::from(status), exchange["status"]);
    assert_eq!(body, exchange["response"]);
}

#[tokio::test]
async fn packaged_password_round_trip_and_legacy_digest_upgrade() {
    let fixture: JsonValue = serde_json::from_str(include_str!(
        "../../../packaging/fixtures/auth-password-roundtrip.json"
    ))
    .expect("fixture");
    let (runtime, _dispatches) = fixture_runtime("demo-password-roundtrip");
    let mut user = fixture["user"].clone();
    user["localId"] = json!("synthetic-roundtrip-user");
    let (status, _) = call(
        &runtime,
        Method::POST,
        "/identitytoolkit.googleapis.com/v1/projects/demo-password-roundtrip/accounts:batchCreate",
        &json!({ "users": [user] }),
    )
    .await;
    assert_eq!(u64::from(status), fixture["expected"]["importStatus"]);
    for (password, expected) in [
        (
            fixture["password"].as_str().expect("password"),
            &fixture["expected"]["correctPasswordStatus"],
        ),
        ("wrong", &fixture["expected"]["wrongPasswordStatus"]),
    ] {
        let (status, _) = call(
            &runtime,
            Method::POST,
            "/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo",
            &json!({ "email": fixture["email"], "password": password, "returnSecureToken": true }),
        )
        .await;
        assert_eq!(u64::from(status), *expected);
    }

    // A directory export re-imports and still signs in.
    let root = std::env::temp_dir().join(format!(
        "firenook-password-{}-{}",
        std::process::id(),
        crate::util::now_millis()
    ));
    runtime.export_directory(&root).expect("export");
    let (imported, _dispatches) = fixture_runtime("demo-password-roundtrip");
    assert_eq!(imported.import_directory(&root).expect("import"), 1);
    let (status, _) = call(
        &imported,
        Method::POST,
        "/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo",
        &json!({ "email": fixture["email"], "password": fixture["password"], "returnSecureToken": true }),
    )
    .await;
    assert_eq!(status, 200);
    std::fs::remove_dir_all(root).expect("remove export");

    // An early Firenook export's digest signs in and is upgraded in place.
    let salt = "synthetic-legacy-salt";
    let password = "synthetic-legacy-password";
    let (status, _) = call(
        &runtime,
        Method::POST,
        "/identitytoolkit.googleapis.com/v1/projects/demo-password-roundtrip/accounts:batchCreate",
        &json!({ "users": [{ "localId": "legacy", "email": "legacy@example.test", "salt": salt,
            "passwordHash": crate::ops::legacy_hash_password(password, salt) }] }),
    )
    .await;
    assert_eq!(status, 200);
    let (status, _) = call(
        &runtime,
        Method::POST,
        "/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo",
        &json!({ "email": "legacy@example.test", "password": password, "returnSecureToken": true }),
    )
    .await;
    assert_eq!(status, 200);
    let (_, lookup) = call(
        &runtime,
        Method::POST,
        "/identitytoolkit.googleapis.com/v1/projects/demo-password-roundtrip/accounts:lookup",
        &json!({ "localId": ["legacy"] }),
    )
    .await;
    assert_eq!(
        lookup["users"][0]["passwordHash"],
        crate::ops::hash_password(password, salt)
    );
}

#[tokio::test]
async fn picker_lists_only_the_provider_accounts_and_escapes_profile_values() {
    let (runtime, _dispatches) = fixture_runtime("demo-auth");
    let name = "</script><img src=x onerror=alert(1)> 中文 😀";
    let (_, imported) = call(
        &runtime,
        Method::POST,
        "/identitytoolkit.googleapis.com/v1/projects/demo-auth/accounts:batchCreate",
        &json!({ "users": [
            { "localId": "google", "providerUserInfo": [{ "providerId": "google.com", "rawId": "subject", "displayName": name, "email": "google@example.test" }] },
            { "localId": "github", "providerUserInfo": [{ "providerId": "github.com", "rawId": "other", "email": "hidden@example.test" }] }
        ] }),
    )
    .await;
    assert_eq!(imported["error"], json!([]));
    let response = runtime
        .application()
        .oneshot(
            Request::builder()
                .uri("/emulator/auth/handler?apiKey=demo&providerId=google.com")
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), 200);
    let html = String::from_utf8(
        to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body")
            .to_vec(),
    )
    .expect("UTF-8");
    assert!(!html.contains(name), "profile values are escaped");
    assert!(
        !html.contains("hidden@example.test"),
        "other providers stay hidden"
    );
    assert_eq!(html.matches("class=\"js-reuse-account\"").count(), 1);
    let encoded = html
        .split("data-id-token=\"")
        .nth(1)
        .and_then(|rest| rest.split('"').next())
        .expect("data-id-token");
    let decoded: String = url::form_urlencoded::parse(encoded.as_bytes())
        .next()
        .map(|(key, _)| key.into_owned())
        .expect("URL-encoded claims");
    let claims: JsonValue = serde_json::from_str(&decoded).expect("claims JSON");
    assert_eq!(claims["sub"], "subject");
    assert_eq!(claims["name"], name);
    assert_eq!(claims["email"], "google@example.test");
}

#[tokio::test]
async fn reads_never_rewrite_the_state_file_and_writes_still_do() {
    let directory = std::env::temp_dir().join(format!(
        "firenook-auth-persist-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));
    let state_file = directory.join("auth-state.json");
    let registry = TriggerRegistry::default();
    let (observer, _receiver) = TriggerObserver::channel(registry.clone());
    let runtime = AuthRuntime::new(
        "demo-auth",
        observer.queue(),
        registry,
        Some(state_file.clone()),
    )
    .expect("runtime");
    let modified = || {
        std::fs::metadata(&state_file)
            .ok()
            .map(|m| (m.len(), m.modified().ok()))
    };

    let (status, body) = call(
        &runtime,
        Method::POST,
        "/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake",
        &json!({ "email": "reader@example.com", "password": "password1", "returnSecureToken": true }),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let after_signup = modified().expect("sign-up persists the state");
    let id_token = body["idToken"].as_str().expect("id token").to_owned();
    let local_id = body["localId"].as_str().expect("local id").to_owned();
    std::thread::sleep(std::time::Duration::from_millis(20));

    // Read-only operations: lookup by token, admin lookup, batchGet, query.
    for (uri, request) in [
        (
            "/identitytoolkit.googleapis.com/v1/accounts:lookup?key=fake",
            json!({ "idToken": id_token }),
        ),
        (
            "/identitytoolkit.googleapis.com/v1/projects/demo-auth/accounts:lookup",
            json!({ "localId": [local_id] }),
        ),
        (
            "/identitytoolkit.googleapis.com/v1/projects/demo-auth/accounts:query",
            json!({}),
        ),
        (
            "/identitytoolkit.googleapis.com/v1/projects/demo-auth/accounts:query",
            json!({ "returnUserInfo": false }),
        ),
    ] {
        let (status, body) = call(&runtime, Method::POST, uri, &request).await;
        assert_eq!(status, 200, "{uri}: {body}");
    }
    let (status, _) = call(
        &runtime,
        Method::GET,
        "/identitytoolkit.googleapis.com/v1/projects/demo-auth/accounts:batchGet?maxResults=10",
        &JsonValue::Null,
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(
        modified().expect("state file"),
        after_signup,
        "reads must not rewrite the state file"
    );

    // A mutation persists again.
    let (status, body) = call(
        &runtime,
        Method::POST,
        "/identitytoolkit.googleapis.com/v1/accounts:update?key=fake",
        &json!({ "idToken": id_token, "displayName": "Reader" }),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_ne!(modified().expect("state file"), after_signup);
    let persisted: JsonValue =
        serde_json::from_slice(&std::fs::read(&state_file).expect("state bytes")).expect("json");
    assert_eq!(
        persisted["projects"]["demo-auth"]["users"][&local_id]["displayName"],
        "Reader"
    );
    let _ = std::fs::remove_dir_all(&directory);
}
