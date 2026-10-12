//! Minting without signing in (tests 9 and 10) and token inspection (11).

use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::{Body as HttpBody, to_bytes};
use axum::extract::State;
use axum::http::{Method, Request, StatusCode};
use axum::response::{IntoResponse, Response};
use base64::Engine as _;
use serde_json::{Value as JsonValue, json};

use super::*;
use crate::observe::{AuthObserver, CallRecord, Step};
use crate::tests::{call, test_runtime};
use crate::token::generate_jwt;
use crate::{AuthRuntime, lock};

const PROJECT: &str = "demo-auth";
const ADMIN: &str = "/identitytoolkit.googleapis.com/v1/projects/demo-auth";
const CLIENT: &str = "/identitytoolkit.googleapis.com/v1";

fn record(value: &JsonValue) -> UserRecord {
    value.as_object().cloned().expect("an object")
}

async fn create(runtime: &AuthRuntime, tenant: Option<&str>, user: &JsonValue) -> String {
    let path = match tenant {
        None => format!("{ADMIN}/accounts"),
        Some(tenant) => format!("{ADMIN}/tenants/{tenant}/accounts"),
    };
    let (status, body) = call(runtime, Method::POST, &path, user).await;
    assert_eq!(status, 200, "{body}");
    body["localId"].as_str().expect("uid").to_owned()
}

fn stored(runtime: &AuthRuntime, tenant: Option<&str>, uid: &str) -> UserRecord {
    let handle = runtime.runtime();
    let data = lock(&handle.inner.data);
    let agent = &data.projects[PROJECT];
    let scope = match tenant {
        None => &agent.project,
        Some(tenant) => &agent.tenants[tenant].project,
    };
    scope.get_user_by_local_id(uid).expect("stored")
}

fn generation(runtime: &AuthRuntime) -> u64 {
    lock(&runtime.runtime().inner.data).generation()
}

/// A payload without the times a second apart.
fn timeless(mut payload: JsonMap<String, JsonValue>) -> JsonMap<String, JsonValue> {
    payload.remove("iat");
    payload.remove("exp");
    payload
}

fn payload_of(token: &str) -> JsonMap<String, JsonValue> {
    match decode_jwt(token).expect("a JWT").1 {
        JsonValue::Object(object) => object,
        other => panic!("{other}"),
    }
}

fn mint_request(uid: &str) -> MintRequest {
    MintRequest {
        uid: uid.to_owned(),
        ..MintRequest::default()
    }
}

// ---------------------------------------------------------------- 9

#[tokio::test]
async fn a_minted_token_is_the_one_a_sign_in_would_produce_and_changes_nothing() {
    let runtime = test_runtime();
    let handle = runtime.runtime();
    let password = create(
        &runtime,
        None,
        &json!({ "email": "ada@example.test", "password": "password1", "displayName": "Ada" }),
    )
    .await;
    let (status, body) = call(
        &runtime,
        Method::POST,
        &format!("{ADMIN}/accounts:update"),
        &json!({ "localId": password,
                 "customAttributes": r#"{"role":"admin","email":"spoof@example.test","name":"Countess"}"# }),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let phone = create(&runtime, None, &json!({ "phoneNumber": "+15550100" })).await;
    let anonymous = create(&runtime, None, &json!({})).await;
    let (status, custom) = call(
        &runtime,
        Method::POST,
        &format!("{CLIENT}/accounts:signInWithCustomToken?key=fake"),
        &json!({ "token": json!({ "uid": "custom-1" }).to_string() }),
    )
    .await;
    assert_eq!(status, 200, "{custom}");
    let federated = create(&runtime, None, &json!({ "email": "grace@example.test" })).await;
    handle
        .update(|data| {
            let state = &mut data.agent(PROJECT).project;
            let mut fields = UserRecord::new();
            fields.insert("lastLoginAt".to_owned(), json!("1800000000000"));
            state
                .update_user_by_local_id(
                    &federated,
                    &fields,
                    crate::state::UpdateOptions {
                        upsert_providers: vec![record(&json!({
                            "providerId": "google.com", "rawId": "g-1", "federatedId": "g-1",
                            "email": "grace@example.test"
                        }))],
                        delete_providers: Vec::new(),
                    },
                )
                .expect("linked");
        })
        .expect("updated");
    let (status, tenant) = call(
        &runtime,
        Method::POST,
        "/identitytoolkit.googleapis.com/v2/projects/demo-auth/tenants",
        &json!({ "displayName": "acme", "allowPasswordSignup": true }),
    )
    .await;
    assert_eq!(status, 200, "{tenant}");
    let tenant_id = tenant["tenantId"].as_str().expect("tenant").to_owned();
    let tenant_user = create(
        &runtime,
        Some(&tenant_id),
        &json!({ "email": "t@acme.test", "password": "password1" }),
    )
    .await;

    for (tenant, uid, provider) in [
        (None, password.as_str(), "password"),
        (None, phone.as_str(), "phone"),
        (None, anonymous.as_str(), "anonymous"),
        (None, "custom-1", "custom"),
        (None, federated.as_str(), "google.com"),
        (Some(tenant_id.as_str()), tenant_user.as_str(), "password"),
    ] {
        let before = stored(&runtime, tenant, uid);
        let generation_before = generation(&runtime);
        let minted = handle
            .mint(PROJECT, tenant, mint_request(uid))
            .await
            .unwrap_or_else(|error| panic!("{uid}: {error}"));
        assert_eq!(minted.provider, provider, "{uid}");
        let expected = generate_jwt(&before, PROJECT, provider, &IssueOptions::default(), tenant);
        assert_eq!(
            timeless(minted.payload.clone()),
            timeless(payload_of(&expected)),
            "{uid}: the payload a sign-in would give"
        );
        assert_eq!(payload_of(&minted.id_token), minted.payload);
        assert_eq!(
            minted.expires_at,
            minted.payload["exp"].as_i64().expect("exp")
        );
        assert_eq!(
            stored(&runtime, tenant, uid),
            before,
            "{uid}: nothing changed"
        );
        assert_eq!(
            generation(&runtime),
            generation_before,
            "{uid}: nothing written"
        );
        // The emulator's own calls accept it.
        let lookup = match tenant {
            None => json!({ "idToken": minted.id_token }),
            Some(tenant) => json!({ "idToken": minted.id_token, "tenantId": tenant }),
        };
        let (status, body) = call(
            &runtime,
            Method::POST,
            &format!("{CLIENT}/accounts:lookup?key=fake"),
            &lookup,
        )
        .await;
        assert_eq!(status, 200, "{uid}: {body}");
        assert_eq!(body["users"][0]["localId"], uid);
        assert!(
            minted
                .differences
                .iter()
                .any(|difference| difference.contains("auth_time")),
            "{:?}",
            minted.differences
        );
    }

    // Shadowed and overriding claims are named.
    let minted = handle
        .mint(PROJECT, None, mint_request(&password))
        .await
        .expect("minted");
    assert_eq!(
        minted
            .shadowed
            .iter()
            .map(|note| note.key.as_str())
            .collect::<Vec<_>>(),
        ["email"]
    );
    assert_eq!(
        minted
            .overrides
            .iter()
            .map(|note| note.key.as_str())
            .collect::<Vec<_>>(),
        ["name"]
    );
    assert_eq!(minted.payload["email"], "ada@example.test");
    assert_eq!(minted.payload["name"], "Countess");
    assert_eq!(
        minted.claims_length,
        u32::try_from(r#"{"role":"admin","email":"spoof@example.test","name":"Countess"}"#.len())
            .expect("length")
    );

    // A draft overrides the stored claims, and is not stored.
    let draft = MintRequest {
        claims: Some(record(&json!({ "role": "viewer", "plan": "pro" }))),
        ..mint_request(&password)
    };
    let minted = handle.mint(PROJECT, None, draft).await.expect("minted");
    assert_eq!(minted.payload["role"], "viewer");
    assert_eq!(minted.payload["plan"], "pro");
    assert!(minted.payload.get("name").is_some_and(|name| name == "Ada"));
    assert!(
        minted
            .differences
            .iter()
            .any(|difference| difference.contains("draft"))
    );
    assert!(
        str_field(&stored(&runtime, None, &password), "customAttributes")
            .is_some_and(|claims| claims.contains("admin"))
    );
    // A forbidden draft key is refused with the engine's words.
    let refused = handle
        .mint(
            PROJECT,
            None,
            MintRequest {
                claims: Some(record(&json!({ "iss": "x" }))),
                ..mint_request(&password)
            },
        )
        .await
        .expect_err("forbidden");
    assert_eq!(refused.kind, ConsoleErrorKind::InvalidArgument);
    assert_eq!(refused.message, "FORBIDDEN_CLAIM : iss");

    // The custom token signs in through the emulator.
    let minted = handle
        .mint(PROJECT, None, mint_request(&phone))
        .await
        .expect("minted");
    let (status, body) = call(
        &runtime,
        Method::POST,
        &format!("{CLIENT}/accounts:signInWithCustomToken?key=fake"),
        &json!({ "token": minted.custom_token }),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        payload_of(body["idToken"].as_str().expect("token"))["user_id"],
        phone.as_str()
    );

    // Unknown users and tenants are not found, and create nothing.
    let missing = handle
        .mint(PROJECT, None, mint_request("ghost"))
        .await
        .expect_err("ghost");
    assert_eq!(missing.kind, ConsoleErrorKind::NotFound);
    let missing = handle
        .mint(PROJECT, Some("nowhere"), mint_request("ghost"))
        .await
        .expect_err("nowhere");
    assert_eq!(missing.kind, ConsoleErrorKind::NotFound);
    assert!(
        !lock(&handle.inner.data).projects[PROJECT]
            .tenants
            .contains_key("nowhere")
    );
    // A provider the user cannot use is refused.
    let refused = handle
        .mint(
            PROJECT,
            None,
            MintRequest {
                provider: Some("github.com".to_owned()),
                ..mint_request(&password)
            },
        )
        .await
        .expect_err("not linked");
    assert_eq!(refused.kind, ConsoleErrorKind::InvalidArgument);
}

#[tokio::test]
async fn a_second_factor_user_mints_with_the_factor_and_a_disabled_user_says_so() {
    let runtime = test_runtime();
    let handle = runtime.runtime();
    let uid = create(
        &runtime,
        None,
        &json!({
            "email": "mfa@example.test", "password": "password1", "emailVerified": true,
            "mfaInfo": [
                { "phoneInfo": "+15550101", "displayName": "Work" },
                { "phoneInfo": "+15550102", "displayName": "Home" }
            ]
        }),
    )
    .await;
    let enrollments: Vec<String> = stored(&runtime, None, &uid)["mfaInfo"]
        .as_array()
        .expect("factors")
        .iter()
        .map(|factor| factor["mfaEnrollmentId"].as_str().expect("id").to_owned())
        .collect();
    let minted = handle
        .mint(PROJECT, None, mint_request(&uid))
        .await
        .expect("minted");
    assert_eq!(minted.payload["firebase"]["sign_in_second_factor"], "phone");
    assert_eq!(
        minted.payload["firebase"]["second_factor_identifier"],
        enrollments[0].as_str()
    );
    assert_eq!(
        minted
            .second_factor
            .as_ref()
            .map(|factor| factor.phone_number.as_deref()),
        Some(Some("+15550101"))
    );
    let second = handle
        .mint(
            PROJECT,
            None,
            MintRequest {
                second_factor: Some(MintFactor::Enrollment(enrollments[1].clone())),
                ..mint_request(&uid)
            },
        )
        .await
        .expect("minted");
    assert_eq!(
        second.payload["firebase"]["second_factor_identifier"],
        enrollments[1].as_str()
    );
    let none = handle
        .mint(
            PROJECT,
            None,
            MintRequest {
                second_factor: Some(MintFactor::None),
                ..mint_request(&uid)
            },
        )
        .await
        .expect("minted");
    assert!(
        none.payload["firebase"]
            .get("sign_in_second_factor")
            .is_none()
    );
    assert!(
        none.differences
            .iter()
            .any(|difference| difference.contains("second factor"))
    );
    let unknown = handle
        .mint(
            PROJECT,
            None,
            MintRequest {
                second_factor: Some(MintFactor::Enrollment("nope".to_owned())),
                ..mint_request(&uid)
            },
        )
        .await
        .expect_err("unknown factor");
    assert_eq!(unknown.kind, ConsoleErrorKind::NotFound);
    // The refresh token keeps the factor through the grant.
    let (status, body) = call(
        &runtime,
        Method::POST,
        "/securetoken.googleapis.com/v1/token?key=fake",
        &json!({ "grant_type": "refresh_token", "refresh_token": minted.refresh_token }),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let refreshed = payload_of(body["id_token"].as_str().expect("token"));
    assert_eq!(refreshed["firebase"]["sign_in_second_factor"], "phone");

    let (status, _) = call(
        &runtime,
        Method::POST,
        &format!("{ADMIN}/accounts:update"),
        &json!({ "localId": uid, "disableUser": true }),
    )
    .await;
    assert_eq!(status, 200);
    let disabled = handle
        .mint(PROJECT, None, mint_request(&uid))
        .await
        .expect("minted");
    assert!(
        disabled
            .differences
            .iter()
            .any(|difference| difference.contains("USER_DISABLED")),
        "{:?}",
        disabled.differences
    );
}

// ---------------------------------------------------------------- 10

#[derive(Default)]
struct Collect(Mutex<Vec<CallRecord>>);

impl AuthObserver for Collect {
    fn call(&self, record: CallRecord) {
        self.0.lock().expect("records").push(record);
    }
}

#[derive(Clone, Default)]
struct Function {
    calls: Arc<Mutex<u32>>,
}

async fn function(State(function): State<Function>, request: Request<HttpBody>) -> Response {
    *function.calls.lock().expect("calls") += 1;
    let refuse = request.uri().path() == "/refuse";
    let _ = to_bytes(request.into_body(), usize::MAX).await;
    if refuse {
        return (
            StatusCode::FORBIDDEN,
            axum::Json(json!({ "error": { "message": "Testers sign in on Fridays only", "status": "PERMISSION_DENIED" } })),
        )
            .into_response();
    }
    axum::Json(json!({ "userRecord": {
        "updateMask": "customClaims,sessionClaims",
        "customClaims": { "tester": true },
        "sessionClaims": { "session": "journey" }
    } }))
    .into_response()
}

async fn serve() -> (String, Function) {
    let state = Function::default();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("listener");
    let address = listener.local_addr().expect("address");
    let application = Router::new().fallback(function).with_state(state.clone());
    tokio::spawn(async move {
        let _ = axum::serve(listener, application).await;
    });
    (format!("http://{address}"), state)
}

async fn set_before_sign_in(runtime: &AuthRuntime, uri: &str) {
    let (status, body) = call(
        runtime,
        Method::PATCH,
        "/identitytoolkit.googleapis.com/v2/projects/demo-auth/config?updateMask=blockingFunctions",
        &json!({ "blockingFunctions": { "triggers": { "beforeSignIn": { "functionUri": uri } } } }),
    )
    .await;
    assert_eq!(status, 200, "{body}");
}

#[tokio::test]
async fn before_sign_in_runs_on_request_into_the_token_only() {
    let runtime = test_runtime();
    let handle = runtime.runtime();
    let records = Arc::new(Collect::default());
    runtime.set_observer(records.clone(), false);
    let (base, function_state) = serve().await;
    let uid = create(
        &runtime,
        None,
        &json!({ "email": "tester@claims.test", "password": "password1" }),
    )
    .await;
    set_before_sign_in(&runtime, &format!("{base}/ok")).await;

    // Not asked: the hook does not run, and the token says so.
    let minted = handle
        .mint(PROJECT, None, mint_request(&uid))
        .await
        .expect("minted");
    assert_eq!(*function_state.calls.lock().expect("calls"), 0);
    assert!(minted.before_sign_in.is_none());
    assert!(
        minted
            .differences
            .iter()
            .any(|difference| difference.contains("did not run"))
    );

    // Asked: its claims are in the token, the account is untouched.
    let before = stored(&runtime, None, &uid);
    let generation_before = generation(&runtime);
    records.0.lock().expect("records").clear();
    let minted = handle
        .mint(
            PROJECT,
            None,
            MintRequest {
                run_before_sign_in: true,
                ..mint_request(&uid)
            },
        )
        .await
        .expect("minted");
    assert_eq!(minted.payload["tester"], true);
    assert_eq!(minted.payload["session"], "journey");
    let blocking = minted.before_sign_in.as_ref().expect("it ran");
    assert_eq!(blocking.function.as_deref(), Some("ok"));
    assert_eq!(blocking.custom_claims, ["tester"]);
    assert_eq!(blocking.session_claims, ["session"]);
    assert_eq!(
        stored(&runtime, None, &uid),
        before,
        "the account was not changed"
    );
    assert_eq!(generation(&runtime), generation_before);
    let recorded = records.0.lock().expect("records").clone();
    assert_eq!(recorded.len(), 1, "one console record");
    let record = &recorded[0];
    assert_eq!(record.operation, "firenook.console.mint");
    assert_eq!(record.origin, Some(ConsoleOrigin::Try));
    assert_eq!(record.id, blocking.call);
    assert!(
        record.steps.iter().any(|step| matches!(
            step,
            Step::Blocking {
                event: "beforeSignIn",
                ..
            }
        )),
        "{:?}",
        record.steps
    );

    // A refusal is the function's own message.
    set_before_sign_in(&runtime, &format!("{base}/refuse")).await;
    let refused = handle
        .mint(
            PROJECT,
            None,
            MintRequest {
                run_before_sign_in: true,
                ..mint_request(&uid)
            },
        )
        .await
        .expect_err("refused");
    assert_eq!(refused.kind, ConsoleErrorKind::FailedPrecondition);
    assert_eq!(
        refused.message,
        "Your beforeSignIn function refused this sign-in: Testers sign in on Fridays only"
    );
    assert_eq!(
        refused.fix.as_deref(),
        Some("Turn off Run beforeSignIn, or change the function.")
    );
}

// ---------------------------------------------------------------- 11

fn check(inspection: &TokenInspection, consumer: TokenConsumer) -> &TokenCheck {
    inspection
        .checks
        .iter()
        .find(|check| check.consumer == consumer)
        .unwrap_or_else(|| panic!("no {consumer:?} in {:?}", inspection.checks))
}

fn unsigned(header: &JsonValue, payload: &JsonValue) -> String {
    let encode = |value: &JsonValue| {
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(value.to_string())
    };
    format!("{}.{}.", encode(header), encode(payload))
}

fn with_payload(token: &str, change: impl FnOnce(&mut JsonMap<String, JsonValue>)) -> String {
    let (header, payload) = decode_jwt(token).expect("a JWT");
    let mut payload = match payload {
        JsonValue::Object(object) => object,
        other => panic!("{other}"),
    };
    change(&mut payload);
    unsigned(&header, &JsonValue::Object(payload))
}

#[tokio::test]
async fn a_pasted_token_is_judged_as_each_consumer_would() {
    let runtime = test_runtime();
    let handle = runtime.runtime();
    let (status, signup) = call(
        &runtime,
        Method::POST,
        &format!("{CLIENT}/accounts:signUp?key=fake"),
        &json!({ "email": "ada@example.test", "password": "password1", "returnSecureToken": true }),
    )
    .await;
    assert_eq!(status, 200, "{signup}");
    let uid = signup["localId"].as_str().expect("uid").to_owned();
    let token = signup["idToken"].as_str().expect("token").to_owned();
    let refresh = signup["refreshToken"].as_str().expect("refresh").to_owned();

    // A fresh ID token passes everyone.
    let inspection = handle.inspect_token(PROJECT, &format!("Bearer {token}"));
    assert_eq!(inspection.kind, TokenKind::IdToken);
    assert!(!inspection.signed);
    assert_eq!(inspection.uid.as_deref(), Some(uid.as_str()));
    assert_eq!(inspection.project.as_deref(), Some(PROJECT));
    assert!(inspection.user_exists);
    assert!(
        inspection.checks.iter().all(|check| check.ok),
        "{:?}",
        inspection.checks
    );

    // Past exp: Verify refuses with the age; the emulator's own calls accept it.
    let expired = with_payload(&token, |payload| {
        payload.insert("exp".to_owned(), json!(now_seconds() - 14 * 60));
    });
    let inspection = handle.inspect_token(PROJECT, &expired);
    let verify = check(&inspection, TokenConsumer::Verify);
    assert!(!verify.ok);
    assert!(
        verify
            .reason
            .as_deref()
            .is_some_and(|reason| reason.starts_with("Expired 14 min ago (exp ")),
        "{verify:?}"
    );
    let emulator = check(&inspection, TokenConsumer::AuthEmulator);
    assert!(emulator.ok);
    assert!(
        emulator
            .reason
            .as_deref()
            .is_some_and(|reason| reason.contains("do not check `exp`"))
    );

    // Revoked after issue: the emulator answers TOKEN_EXPIRED, checkRevoked refuses.
    handle
        .update(|data| {
            let state = &mut data.agent(PROJECT).project;
            let mut fields = UserRecord::new();
            fields.insert(
                "validSince".to_owned(),
                json!((now_seconds() + 60).to_string()),
            );
            state
                .update_user_by_local_id(&uid, &fields, crate::state::UpdateOptions::default())
                .expect("revoked");
        })
        .expect("updated");
    let inspection = handle.inspect_token(PROJECT, &token);
    assert!(!check(&inspection, TokenConsumer::AuthEmulator).ok);
    assert!(
        check(&inspection, TokenConsumer::AuthEmulator)
            .reason
            .as_deref()
            .is_some_and(|reason| reason.contains("TOKEN_EXPIRED"))
    );
    assert!(check(&inspection, TokenConsumer::Verify).ok);
    assert!(!check(&inspection, TokenConsumer::VerifyRevoked).ok);

    // Disabled.
    handle
        .update(|data| {
            let state = &mut data.agent(PROJECT).project;
            let mut fields = UserRecord::new();
            fields.insert("validSince".to_owned(), JsonValue::Null);
            fields.insert("disabled".to_owned(), json!(true));
            state
                .update_user_by_local_id(&uid, &fields, crate::state::UpdateOptions::default())
                .expect("disabled");
        })
        .expect("updated");
    let inspection = handle.inspect_token(PROJECT, &token);
    assert!(
        check(&inspection, TokenConsumer::AuthEmulator)
            .reason
            .as_deref()
            .is_some_and(|reason| reason.contains("USER_DISABLED"))
    );
    assert!(!check(&inspection, TokenConsumer::VerifyRevoked).ok);

    // An unknown user, another tenant, another project.
    let ghost = with_payload(&token, |payload| {
        payload.insert("user_id".to_owned(), json!("ghost"));
        payload.insert("sub".to_owned(), json!("ghost"));
    });
    let inspection = handle.inspect_token(PROJECT, &ghost);
    assert!(!inspection.user_exists);
    assert!(
        check(&inspection, TokenConsumer::AuthEmulator)
            .reason
            .as_deref()
            .is_some_and(|reason| reason.contains("USER_NOT_FOUND"))
    );
    let elsewhere = with_payload(&token, |payload| {
        payload.insert(
            "firebase".to_owned(),
            json!({ "sign_in_provider": "password", "tenant": "acme" }),
        );
    });
    let inspection = handle.inspect_token(PROJECT, &elsewhere);
    assert_eq!(inspection.tenant.as_deref(), Some("acme"));
    assert!(!check(&inspection, TokenConsumer::AuthEmulator).ok);
    assert!(
        !lock(&handle.inner.data).projects[PROJECT]
            .tenants
            .contains_key("acme"),
        "nothing created"
    );
    let other = with_payload(&token, |payload| {
        payload.insert("aud".to_owned(), json!("demo-other"));
        payload.insert(
            "iss".to_owned(),
            json!("https://securetoken.google.com/demo-other"),
        );
    });
    let verify = check(
        &handle.inspect_token(PROJECT, &other),
        TokenConsumer::Verify,
    )
    .clone();
    assert_eq!(
        verify.reason.as_deref(),
        Some("This ID token is for project `demo-other`; the emulator runs `demo-auth`.")
    );
    assert!(
        verify
            .fix
            .as_deref()
            .is_some_and(|fix| fix.contains("initializeApp"))
    );

    // Production-signed.
    let (_, payload) = decode_jwt(&token).expect("JWT");
    let signed = unsigned(
        &json!({ "alg": "RS256", "kid": "abc", "typ": "JWT" }),
        &payload,
    );
    assert!(handle.inspect_token(PROJECT, &signed).signed);

    // A session cookie.
    let cookie = with_payload(&token, |payload| {
        payload.insert(
            "iss".to_owned(),
            json!("https://session.firebase.google.com/demo-auth"),
        );
    });
    assert_eq!(
        handle.inspect_token(PROJECT, &cookie).kind,
        TokenKind::SessionCookie
    );

    // Custom tokens, both forms.
    let json_form = json!({ "uid": "custom-1" }).to_string();
    let inspection = handle.inspect_token(PROJECT, &json_form);
    assert_eq!(inspection.kind, TokenKind::CustomToken);
    assert!(check(&inspection, TokenConsumer::SignIn).ok);
    assert!(!check(&inspection, TokenConsumer::Verify).ok);
    let jwt_form = unsigned(
        &json!({ "alg": "none" }),
        &json!({ "aud": CUSTOM_TOKEN_AUDIENCE, "uid": "custom-2", "claims": { "iss": "x" } }),
    );
    let inspection = handle.inspect_token(PROJECT, &jwt_form);
    assert_eq!(inspection.uid.as_deref(), Some("custom-2"));
    assert!(
        !check(&inspection, TokenConsumer::SignIn).ok,
        "a forbidden claim"
    );

    // A refresh token: the grant's own checks.
    let inspection = handle.inspect_token(PROJECT, &refresh);
    assert_eq!(inspection.kind, TokenKind::RefreshToken);
    let sign_in = check(&inspection, TokenConsumer::SignIn);
    assert!(!sign_in.ok, "the user is disabled");
    assert!(
        sign_in
            .reason
            .as_deref()
            .is_some_and(|reason| reason.contains("USER_DISABLED"))
    );

    // Not a token.
    let unknown = handle.inspect_token(PROJECT, "not a token");
    assert_eq!(unknown.kind, TokenKind::Unknown);
    assert_eq!(unknown.checks, Vec::new());
}
