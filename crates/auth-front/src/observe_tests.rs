//! The console's record of every call: one record per call with its caller,
//! credential and origin, the operation's description, its error code, the
//! bodies kept as handles, and every step the call caused.

use std::collections::BTreeSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::{Body as HttpBody, Bytes, to_bytes};
use axum::extract::State;
use axum::http::{HeaderMap, Method, Request, StatusCode};
use axum::response::{IntoResponse, Response};
use firenook_functions_bridge::{TriggerObserver, TriggerRegistry};
use serde_json::{Value as JsonValue, json};
use tower::ServiceExt as _;

use super::*;
use crate::{AuthLogLine, AuthMessageRef, AuthRuntime};

const CLIENT: &str = "/identitytoolkit.googleapis.com/v1";
const ADMIN: &str = "/identitytoolkit.googleapis.com/v1/projects/demo-auth";

/// Keeps every record it is handed.
#[derive(Default)]
struct Collect(Mutex<Vec<CallRecord>>);

impl AuthObserver for Collect {
    fn call(&self, record: CallRecord) {
        self.0.lock().expect("records").push(record);
    }
}

impl Collect {
    fn take(&self) -> Vec<CallRecord> {
        std::mem::take(&mut *self.0.lock().expect("records"))
    }

    fn last(&self) -> CallRecord {
        self.0
            .lock()
            .expect("records")
            .last()
            .cloned()
            .expect("a record")
    }
}

type Dispatches = tokio::sync::mpsc::UnboundedReceiver<firenook_functions_bridge::DispatchRequest>;

struct Observed {
    runtime: AuthRuntime,
    records: Arc<Collect>,
    registry: TriggerRegistry,
    _dispatches: Dispatches,
}

fn observed(keep_bodies: bool) -> Observed {
    let registry = TriggerRegistry::default();
    let (observer, dispatches) = TriggerObserver::channel(registry.clone());
    let runtime =
        AuthRuntime::new("demo-auth", observer.queue(), registry.clone(), None).expect("runtime");
    let records = Arc::new(Collect::default());
    runtime.set_observer(records.clone(), keep_bodies);
    Observed {
        runtime,
        records,
        registry,
        _dispatches: dispatches,
    }
}

async fn send(
    runtime: &AuthRuntime,
    method: Method,
    uri: &str,
    headers: &[(&str, &str)],
    body: Option<&JsonValue>,
) -> (u16, HeaderMap, JsonValue) {
    let mut request = Request::builder()
        .method(method)
        .uri(uri)
        .header("host", "127.0.0.1:9099");
    if body.is_some() {
        request = request.header("content-type", "application/json");
    }
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    let request = request
        .body(body.map_or_else(HttpBody::empty, |body| HttpBody::from(body.to_string())))
        .expect("request");
    let response = runtime
        .application()
        .oneshot(request)
        .await
        .expect("response");
    let status = response.status().as_u16();
    let headers = response.headers().clone();
    let bytes = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body");
    (
        status,
        headers,
        serde_json::from_slice(&bytes).unwrap_or(JsonValue::Null),
    )
}

async fn client(runtime: &AuthRuntime, operation: &str, body: &JsonValue) -> JsonValue {
    let (status, _, answer) = send(
        runtime,
        Method::POST,
        &format!("{CLIENT}/{operation}?key=fake"),
        &[],
        Some(body),
    )
    .await;
    assert_eq!(status, 200, "{operation}: {answer}");
    answer
}

async fn admin(runtime: &AuthRuntime, path: &str, body: &JsonValue) -> JsonValue {
    let (status, _, answer) = send(
        runtime,
        Method::POST,
        &format!("{ADMIN}/{path}"),
        &[("authorization", "Bearer owner")],
        Some(body),
    )
    .await;
    assert_eq!(status, 200, "{path}: {answer}");
    answer
}

fn steps_of<'a>(record: &'a CallRecord, wanted: &str) -> Vec<&'a Step> {
    record
        .steps
        .iter()
        .filter(|step| {
            let name = match step {
                Step::Blocking { .. } => "blocking",
                Step::Trigger { .. } => "trigger",
                Step::MessageSent(_) => "message",
                Step::MessageUsed { .. } => "used",
                Step::User { .. } => "user",
                Step::UsersCleared { .. } => "cleared",
                Step::Config { .. } => "config",
            };
            name == wanted
        })
        .collect()
}

fn sent(record: &CallRecord) -> MessageRecord {
    match steps_of(record, "message").first() {
        Some(Step::MessageSent(message)) => message.clone(),
        _ => panic!("no message in {:?}", record.steps),
    }
}

fn used(record: &CallRecord) -> Vec<String> {
    steps_of(record, "used")
        .into_iter()
        .filter_map(|step| match step {
            Step::MessageUsed { key } => Some(key.clone()),
            _ => None,
        })
        .collect()
}

// ---------------------------------------------------------------- 20

#[tokio::test]
async fn one_record_per_call_says_who_called_and_how() {
    let observed = observed(true);
    let runtime = &observed.runtime;
    let records = &observed.records;

    // An app with an API key.
    let signup = client(
        runtime,
        "accounts:signUp",
        &json!({ "email": "ada@example.test", "password": "password1", "returnSecureToken": true }),
    )
    .await;
    let record = records.last();
    assert_eq!(
        (record.caller, record.credential),
        (Caller::Client, Credential::ApiKey)
    );
    assert_eq!(record.operation, "identitytoolkit.accounts.signUp");
    assert_eq!(record.kind, CallKind::SignUp);
    assert_eq!(record.method, "POST");
    assert_eq!(
        record.path,
        "/identitytoolkit.googleapis.com/v1/accounts:signUp"
    );
    assert_eq!(record.status, 200);
    assert_eq!(record.project, "demo-auth");
    assert_eq!(record.origin, None);
    let first_id = record.id;

    // The Admin SDK, and a service account.
    admin(
        runtime,
        "accounts:lookup",
        &json!({ "localId": [signup["localId"]] }),
    )
    .await;
    let record = records.last();
    assert_eq!(
        (record.caller, record.credential),
        (Caller::Admin, Credential::Owner)
    );
    assert!(record.id > first_id, "call ids increase");
    let (status, _, _) = send(
        runtime,
        Method::POST,
        &format!("{ADMIN}/accounts:lookup"),
        &[("authorization", "Bearer ya29.sample-access-token")],
        Some(&json!({ "localId": [signup["localId"]] })),
    )
    .await;
    assert_eq!(status, 200);
    let record = records.last();
    assert_eq!(
        (record.caller, record.credential),
        (Caller::Admin, Credential::ServiceAccount)
    );
    assert!(
        record
            .headers
            .contains(&("authorization".to_owned(), "Bearer ya29.…".to_owned())),
        "{:?}",
        record.headers
    );

    // The console, with each origin token.
    for (token, origin) in [
        ("write", ConsoleOrigin::Write),
        ("try", ConsoleOrigin::Try),
        ("replay", ConsoleOrigin::Replay),
        ("1", ConsoleOrigin::Write),
        ("bulk-9", ConsoleOrigin::Write),
    ] {
        let (status, _, _) = send(
            runtime,
            Method::POST,
            &format!("{ADMIN}/accounts:lookup"),
            &[
                ("authorization", "Bearer owner"),
                ("x-firenook-console", token),
            ],
            Some(&json!({ "localId": [signup["localId"]] })),
        )
        .await;
        assert_eq!(status, 200);
        let record = records.last();
        assert_eq!(record.caller, Caller::Console, "{token}");
        assert_eq!(record.origin, Some(origin), "{token}");
    }

    // An action link and the account picker.
    let link = admin(
        runtime,
        "accounts:sendOobCode",
        &json!({ "requestType": "VERIFY_EMAIL", "email": "ada@example.test", "returnOobLink": true }),
    )
    .await["oobLink"]
        .as_str()
        .expect("link")
        .to_owned();
    let path = link
        .strip_prefix("http://127.0.0.1:9099")
        .expect("on the emulator");
    let (status, _, _) = send(runtime, Method::GET, path, &[], None).await;
    assert_eq!(status, 200);
    let record = records.last();
    assert_eq!(record.caller, Caller::ActionLink);
    assert_eq!(record.operation, "emulator.action.verifyEmail");
    assert_eq!(record.kind, CallKind::Account);
    assert_eq!(used(&record).len(), 1, "the link's code was used");
    let (status, _, _) = send(
        runtime,
        Method::GET,
        "/emulator/auth/handler?apiKey=fake&providerId=google.com",
        &[],
        None,
    )
    .await;
    assert_eq!(status, 200);
    let record = records.last();
    assert_eq!(record.caller, Caller::AccountPicker);
    assert_eq!(record.operation, "emulator.accountPicker");
    assert_eq!(record.provider.as_deref(), Some("google.com"));

    // The emulator's own API.
    let (status, _, _) = send(
        runtime,
        Method::GET,
        "/emulator/v1/projects/demo-auth/oobCodes",
        &[],
        None,
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(records.last().caller, Caller::EmulatorApi);

    // Not calls: preflights, readiness, the API document, the popup frame.
    let before = records.take().len();
    assert!(before > 0);
    for (method, path) in [
        (
            Method::OPTIONS,
            "/identitytoolkit.googleapis.com/v1/accounts:signUp",
        ),
        (Method::GET, "/"),
        (Method::GET, "/emulator/openapi.json"),
        (Method::GET, "/emulator/auth/iframe"),
    ] {
        let _ = send(runtime, method, path, &[], None).await;
    }
    assert_eq!(records.take().len(), 0, "none of these is recorded");
}

// ---------------------------------------------------------------- 21

#[test]
fn every_dispatched_operation_has_a_kind() {
    // A Windows checkout may give the source CRLF line ends.
    let source = include_str!("lib.rs").replace("\r\n", "\n");
    let start = source.find("async fn dispatch(").expect("dispatch");
    let end = source[start..]
        .find("\n}\n")
        .map(|offset| start + offset)
        .expect("end of dispatch");
    let mut operations = BTreeSet::new();
    for piece in source[start..end].split('"').skip(1).step_by(2) {
        if piece.contains('.') && !piece.contains(' ') {
            operations.insert(piece.to_owned());
        }
    }
    assert!(operations.len() >= 50, "{operations:?}");
    for operation in &operations {
        assert_ne!(
            kind_of(operation),
            CallKind::Other,
            "{operation} has no kind"
        );
    }
    assert_eq!(kind_of("emulator.action.resetPassword"), CallKind::Account);
    assert_eq!(kind_of("firenook.console.users.disable"), CallKind::Account);
    assert_eq!(kind_of("firenook.console.createTenant"), CallKind::Config);
    assert_eq!(kind_of("firenook.console.mint"), CallKind::SignIn);
    assert_eq!(kind_of(""), CallKind::Other);
}

#[tokio::test]
async fn each_operation_is_described_by_identifier_provider_and_uid() {
    let observed = observed(false);
    let runtime = &observed.runtime;
    let records = &observed.records;
    let describe = |record: &CallRecord| {
        (
            record.identifier.clone(),
            record.provider.clone(),
            record.uid.clone(),
            record.new_user,
        )
    };

    let signup = client(
        runtime,
        "accounts:signUp",
        &json!({ "email": "ada@example.test", "password": "password1", "returnSecureToken": true }),
    )
    .await;
    let uid = signup["localId"].as_str().expect("uid").to_owned();
    let id_token = signup["idToken"].as_str().expect("token").to_owned();
    let refresh = signup["refreshToken"].as_str().expect("refresh").to_owned();
    assert_eq!(
        describe(&records.last()),
        (
            Some("ada@example.test".to_owned()),
            Some("password".to_owned()),
            Some(uid.clone()),
            Some(true)
        )
    );

    client(
        runtime,
        "accounts:signUp",
        &json!({ "returnSecureToken": true }),
    )
    .await;
    let record = records.last();
    assert_eq!(record.provider.as_deref(), Some("anonymous"));
    assert_eq!(
        record.identifier, record.uid,
        "an anonymous user is named by uid"
    );

    client(
        runtime,
        "accounts:signInWithPassword",
        &json!({ "email": "ada@example.test", "password": "password1" }),
    )
    .await;
    assert_eq!(
        describe(&records.last()),
        (
            Some("ada@example.test".to_owned()),
            Some("password".to_owned()),
            Some(uid.clone()),
            Some(false)
        )
    );

    client(
        runtime,
        "accounts:signInWithCustomToken",
        &json!({ "token": json!({ "uid": "custom-1" }).to_string() }),
    )
    .await;
    assert_eq!(
        describe(&records.last()),
        (
            Some("custom-1".to_owned()),
            Some("custom".to_owned()),
            Some("custom-1".to_owned()),
            Some(true)
        )
    );

    client(
        runtime,
        "accounts:signInWithIdp",
        &json!({
            "requestUri": "http://localhost",
            "postBody": format!("id_token={}&providerId=google.com", fake_idp_token("g-1", "grace@example.test")),
            "returnSecureToken": true
        }),
    )
    .await;
    let record = records.last();
    assert_eq!(record.provider.as_deref(), Some("google.com"));
    assert_eq!(record.identifier.as_deref(), Some("grace@example.test"));
    assert_eq!(record.new_user, Some(true));

    let session = client(
        runtime,
        "accounts:sendVerificationCode",
        &json!({ "phoneNumber": "+15550100" }),
    )
    .await["sessionInfo"]
        .as_str()
        .expect("session")
        .to_owned();
    assert_eq!(records.last().identifier.as_deref(), Some("+15550100"));
    let code = sent(&records.last()).code;
    client(
        runtime,
        "accounts:signInWithPhoneNumber",
        &json!({ "sessionInfo": session, "code": code }),
    )
    .await;
    let record = records.last();
    assert_eq!(record.identifier.as_deref(), Some("+15550100"));
    assert_eq!(record.provider.as_deref(), Some("phone"));
    assert_eq!(record.new_user, Some(true));

    let (status, _, _) = send(
        runtime,
        Method::POST,
        "/securetoken.googleapis.com/v1/token?key=fake",
        &[],
        Some(&json!({ "grant_type": "refresh_token", "refresh_token": refresh })),
    )
    .await;
    assert_eq!(status, 200);
    let record = records.last();
    assert_eq!(record.kind, CallKind::Refresh);
    assert_eq!(record.uid.as_deref(), Some(uid.as_str()));
    assert_eq!(record.provider.as_deref(), Some("password"));

    client(
        runtime,
        "accounts:update",
        &json!({ "idToken": id_token, "displayName": "Ada" }),
    )
    .await;
    let record = records.last();
    assert_eq!(record.uid.as_deref(), Some(uid.as_str()));
    assert_eq!(record.identifier.as_deref(), Some("ada@example.test"));
    assert_eq!(record.kind, CallKind::Account);

    client(runtime, "accounts:lookup", &json!({ "idToken": id_token })).await;
    let record = records.last();
    assert_eq!(record.uid.as_deref(), Some(uid.as_str()));
    assert_eq!(record.kind, CallKind::Lookup);

    client(
        runtime,
        "accounts:createAuthUri",
        &json!({ "identifier": "ada@example.test", "continueUri": "http://localhost" }),
    )
    .await;
    assert_eq!(
        records.last().identifier.as_deref(),
        Some("ada@example.test")
    );

    admin(
        runtime,
        "accounts:batchCreate",
        &json!({ "users": [{ "localId": "i1" }, { "localId": "i2" }] }),
    )
    .await;
    assert_eq!(records.last().identifier.as_deref(), Some("2 users"));

    admin(runtime, "accounts:delete", &json!({ "localId": "i1" })).await;
    let record = records.last();
    assert_eq!(record.uid.as_deref(), Some("i1"));
    assert_eq!(record.kind, CallKind::Account);

    let (status, _, _) = send(
        runtime,
        Method::POST,
        "/identitytoolkit.googleapis.com/v2/projects/demo-auth/tenants",
        &[("authorization", "Bearer owner")],
        Some(&json!({ "displayName": "acme" })),
    )
    .await;
    assert_eq!(status, 200);
    let record = records.last();
    assert_eq!(record.identifier.as_deref(), Some("acme"));
    assert_eq!(record.kind, CallKind::Config);
}

/// An unsigned Google ID token as the emulator's identity-provider sign-in
/// accepts it.
fn fake_idp_token(sub: &str, email: &str) -> String {
    use base64::Engine as _;
    let encode = |value: &JsonValue| {
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(value.to_string())
    };
    format!(
        "{}.{}.",
        encode(&json!({ "alg": "none" })),
        encode(&json!({ "sub": sub, "email": email, "email_verified": true }))
    )
}

// ---------------------------------------------------------------- 22

/// What the test blocking function received, and how it answers.
#[derive(Clone, Default)]
struct Function {
    received: Arc<Mutex<Vec<(HeaderMap, JsonValue)>>>,
}

async fn function_handler(
    State(function): State<Function>,
    request: Request<HttpBody>,
) -> Response {
    let (parts, body) = request.into_parts();
    let bytes = to_bytes(body, usize::MAX).await.unwrap_or_default();
    let body: JsonValue = serde_json::from_slice(&bytes).unwrap_or(JsonValue::Null);
    function
        .received
        .lock()
        .expect("received")
        .push((parts.headers.clone(), body));
    match parts.uri.path() {
        "/ok" => (
            [("x-firenook-execution", "inv-42")],
            axum::Json(json!({ "userRecord": {
                "updateMask": "displayName,customClaims,sessionClaims",
                "displayName": "Blocked Not",
                "customClaims": { "role": "admin", "tier": 2 },
                "sessionClaims": { "session": "journey" }
            } })),
        )
            .into_response(),
        _ => (
            StatusCode::FORBIDDEN,
            axum::Json(json!({ "error": {
                "message": "Sign-ups from blocked.test are not allowed",
                "status": "PERMISSION_DENIED"
            } })),
        )
            .into_response(),
    }
}

/// A local HTTP server standing in for blocking functions: `/ok` changes
/// the account, anything else refuses.
async fn serve_function() -> (String, Function) {
    let function = Function::default();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("listener");
    let address = listener.local_addr().expect("address");
    let application = Router::new()
        .fallback(function_handler)
        .with_state(function.clone());
    tokio::spawn(async move {
        let _ = axum::serve(listener, application).await;
    });
    (format!("http://{address}"), function)
}

async fn set_blocking(runtime: &AuthRuntime, event: &str, uri: &str) {
    let (status, _, answer) = send(
        runtime,
        Method::PATCH,
        "/identitytoolkit.googleapis.com/v2/projects/demo-auth/config?updateMask=blockingFunctions",
        &[("authorization", "Bearer owner")],
        Some(&json!({ "blockingFunctions": { "triggers": { event: { "functionUri": uri } } } })),
    )
    .await;
    assert_eq!(status, 200, "{answer}");
}

#[tokio::test]
async fn blocking_functions_are_steps_with_their_changes_failures_and_invocation() {
    let observed = observed(true);
    let runtime = &observed.runtime;
    let records = &observed.records;
    let (base, function) = serve_function().await;

    // The configuration change is a step of its own call.
    set_blocking(runtime, "beforeCreate", &format!("{base}/ok")).await;
    let record = records.last();
    assert_eq!(
        steps_of(&record, "config"),
        [&Step::Config {
            tenant: None,
            what: ConfigChange::Project
        }]
    );

    let answer = client(
        runtime,
        "accounts:signUp",
        &json!({ "email": "lin@example.test", "password": "password1", "returnSecureToken": true }),
    )
    .await;
    assert_eq!(answer["displayName"], "Blocked Not");
    let record = records.last();
    let Some(Step::Blocking {
        event,
        uri,
        function: name,
        invocation,
        changed,
        custom_claims,
        session_claims,
        failure,
        ..
    }) = steps_of(&record, "blocking").first().copied()
    else {
        panic!("no blocking step in {:?}", record.steps);
    };
    assert_eq!(*event, "beforeCreate");
    assert_eq!(uri, &format!("{base}/ok"));
    assert_eq!(name.as_deref(), Some("ok"));
    assert_eq!(invocation.as_deref(), Some("inv-42"));
    assert_eq!(changed, &["displayName".to_owned()]);
    assert_eq!(custom_claims, &["role".to_owned(), "tier".to_owned()]);
    assert_eq!(
        session_claims,
        &Vec::<String>::new(),
        "beforeCreate takes no session claims"
    );
    assert_eq!(failure, &None);
    // The request carried the call id as its cause.
    let received = function.received.lock().expect("received").clone();
    let (headers, body) = received.last().expect("a request");
    assert_eq!(
        headers["x-firenook-cause-auth-call"],
        record.id.to_string().as_str()
    );
    assert!(body["data"]["jwt"].is_string());

    // beforeSignIn returns session claims.
    set_blocking(runtime, "beforeSignIn", &format!("{base}/ok")).await;
    client(
        runtime,
        "accounts:signInWithPassword",
        &json!({ "email": "lin@example.test", "password": "password1" }),
    )
    .await;
    let record = records.last();
    match steps_of(&record, "blocking").first() {
        Some(Step::Blocking {
            session_claims,
            event,
            ..
        }) => {
            assert_eq!(*event, "beforeSignIn");
            assert_eq!(session_claims, &["session".to_owned()]);
        }
        other => panic!("{other:?}"),
    }

    // A refusal: the function's own message, its status and the engine's line.
    set_blocking(runtime, "beforeCreate", &format!("{base}/refuse")).await;
    let (status, _, answer) = send(
        runtime,
        Method::POST,
        &format!("{CLIENT}/accounts:signUp?key=fake"),
        &[],
        Some(&json!({ "email": "x@blocked.test", "password": "password1" })),
    )
    .await;
    assert_eq!(status, 400, "{answer}");
    let record = records.last();
    match steps_of(&record, "blocking").first() {
        Some(Step::Blocking {
            failure: Some(failure),
            ..
        }) => {
            assert_eq!(
                failure.message,
                "Sign-ups from blocked.test are not allowed"
            );
            assert_eq!(failure.status, Some(403));
            assert_eq!(
                failure.raw,
                answer["error"]["message"].as_str().expect("message")
            );
            assert!(
                failure
                    .raw
                    .starts_with("BLOCKING_FUNCTION_ERROR_RESPONSE : ((HTTP request to")
            );
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(
        record.error.as_ref().map(|error| error.code.as_str()),
        Some("BLOCKING_FUNCTION_ERROR_RESPONSE")
    );

    // A function that cannot be reached: the transport sentence.
    let closed = {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("port");
        listener.local_addr().expect("address").port()
    };
    set_blocking(
        runtime,
        "beforeCreate",
        &format!("http://127.0.0.1:{closed}/gone"),
    )
    .await;
    let (status, _, _) = send(
        runtime,
        Method::POST,
        &format!("{CLIENT}/accounts:signUp?key=fake"),
        &[],
        Some(&json!({ "email": "y@example.test", "password": "password1" })),
    )
    .await;
    assert_eq!(status, 500);
    match steps_of(&records.last(), "blocking").first() {
        Some(Step::Blocking {
            failure: Some(failure),
            function,
            ..
        }) => {
            assert_eq!(
                failure.message,
                format!("Failed to make request to http://127.0.0.1:{closed}/gone.")
            );
            assert_eq!(failure.status, None);
            assert_eq!(function.as_deref(), Some("gone"));
        }
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn triggers_messages_users_and_configuration_are_steps() {
    let observed = observed(false);
    let runtime = &observed.runtime;
    let records = &observed.records;

    // A sign-up: the user, then its trigger.
    let signup = client(
        runtime,
        "accounts:signUp",
        &json!({ "email": "ada@example.test", "password": "password1", "returnSecureToken": true }),
    )
    .await;
    let uid = signup["localId"].as_str().expect("uid").to_owned();
    let id_token = signup["idToken"].as_str().expect("token").to_owned();
    let record = records.last();
    assert_eq!(
        steps_of(&record, "user"),
        [&Step::User {
            tenant: None,
            uid: uid.clone(),
            change: UserChange::Created,
            fields: Vec::new()
        }]
    );
    assert_eq!(
        steps_of(&record, "trigger"),
        [&Step::Trigger {
            event: "user.create",
            uid: uid.clone(),
            outcome: TriggerOutcome::Queued
        }]
    );

    // Paused background triggers: counted and dropped.
    observed.registry.set_background_enabled(false);
    client(
        runtime,
        "accounts:signUp",
        &json!({ "email": "b@example.test", "password": "password1" }),
    )
    .await;
    match steps_of(&records.last(), "trigger").first() {
        Some(Step::Trigger { outcome, .. }) => assert_eq!(outcome, &TriggerOutcome::DeliveryOff),
        other => panic!("{other:?}"),
    }
    observed.registry.set_background_enabled(true);

    // An update names the fields it set.
    client(
        runtime,
        "accounts:update",
        &json!({ "idToken": id_token, "displayName": "Ada", "photoUrl": "https://example.test/a.png" }),
    )
    .await;
    match steps_of(&records.last(), "user").first() {
        Some(Step::User { change, fields, .. }) => {
            assert_eq!(*change, UserChange::Updated);
            assert!(fields.contains(&"displayName".to_owned()), "{fields:?}");
            assert!(fields.contains(&"photoUrl".to_owned()), "{fields:?}");
        }
        other => panic!("{other:?}"),
    }

    // Every kind of out-of-band code, sent or returned.
    for (request_type, kind, extra) in [
        (
            "VERIFY_EMAIL",
            MessageKind::VerifyEmail,
            json!({ "idToken": id_token }),
        ),
        (
            "PASSWORD_RESET",
            MessageKind::PasswordReset,
            json!({ "email": "ada@example.test" }),
        ),
        (
            "EMAIL_SIGNIN",
            MessageKind::EmailSignIn,
            json!({ "email": "new@example.test" }),
        ),
        (
            "VERIFY_AND_CHANGE_EMAIL",
            MessageKind::VerifyAndChangeEmail,
            json!({ "idToken": id_token, "newEmail": "ada.new@example.test" }),
        ),
    ] {
        let mut body = extra.clone();
        body["requestType"] = json!(request_type);
        body["continueUrl"] = json!("https://app.example.test/done");
        client(runtime, "accounts:sendOobCode", &body).await;
        let message = sent(&records.last());
        assert_eq!(message.kind, kind, "{request_type}");
        assert_eq!(message.delivery, Delivery::Sent);
        assert_eq!(message.project, "demo-auth");
        assert_eq!(
            message.continue_url.as_deref(),
            Some("https://app.example.test/done")
        );
        assert!(message.text.contains(&message.code), "{}", message.text);
        assert!(
            message
                .link
                .as_deref()
                .is_some_and(|link| link.contains(&message.code))
        );
        assert_eq!(message.key, message.code);
        assert!(message.at_millis.is_some());
        if request_type == "EMAIL_SIGNIN" {
            assert_eq!(message.uid, None, "no account yet");
        } else {
            assert_eq!(message.uid.as_deref(), Some(uid.as_str()), "{request_type}");
        }
    }
    let returned = admin(
        runtime,
        "accounts:sendOobCode",
        &json!({ "requestType": "PASSWORD_RESET", "email": "ada@example.test", "returnOobLink": true }),
    )
    .await;
    let message = sent(&records.last());
    assert_eq!(message.delivery, Delivery::Returned);
    assert_eq!(message.text, "", "nothing was printed");
    assert_eq!(message.code, returned["oobCode"]);

    // A returned reset code used through the API.
    client(
        runtime,
        "accounts:resetPassword",
        &json!({ "oobCode": message.code, "newPassword": "password2" }),
    )
    .await;
    assert_eq!(used(&records.last()), std::slice::from_ref(&message.code));

    // An email sign-in link used.
    let link_code = admin(
        runtime,
        "accounts:sendOobCode",
        &json!({ "requestType": "EMAIL_SIGNIN", "email": "link@example.test", "returnOobLink": true }),
    )
    .await["oobCode"]
        .as_str()
        .expect("code")
        .to_owned();
    client(
        runtime,
        "accounts:signInWithEmailLink",
        &json!({ "email": "link@example.test", "oobCode": link_code }),
    )
    .await;
    assert_eq!(used(&records.last()), [link_code]);

    // An email change through a verify-and-change code sends a recover
    // code, and the recover code is used too.
    let signin = client(
        runtime,
        "accounts:signInWithPassword",
        &json!({ "email": "ada@example.test", "password": "password2", "returnSecureToken": true }),
    )
    .await;
    let token = signin["idToken"].as_str().expect("token").to_owned();
    let change = admin(
        runtime,
        "accounts:sendOobCode",
        &json!({ "requestType": "VERIFY_AND_CHANGE_EMAIL", "idToken": token, "newEmail": "changed@example.test", "returnOobLink": true }),
    )
    .await["oobCode"]
        .as_str()
        .expect("code")
        .to_owned();
    client(runtime, "accounts:update", &json!({ "oobCode": change })).await;
    assert_eq!(used(&records.last()), [change]);
    // Changing the email with an ID token sends the recover link.
    let signin = client(
        runtime,
        "accounts:signInWithPassword",
        &json!({ "email": "changed@example.test", "password": "password2", "returnSecureToken": true }),
    )
    .await;
    client(
        runtime,
        "accounts:update",
        &json!({ "idToken": signin["idToken"], "email": "again@example.test" }),
    )
    .await;
    let recover = sent(&records.last());
    assert_eq!(recover.kind, MessageKind::RecoverEmail);
    assert_eq!(recover.uid.as_deref(), Some(uid.as_str()));
    client(
        runtime,
        "accounts:update",
        &json!({ "oobCode": recover.code }),
    )
    .await;
    assert_eq!(used(&records.last()), [recover.key]);

    // A verify-email code used.
    let verify = admin(
        runtime,
        "accounts:sendOobCode",
        &json!({ "requestType": "VERIFY_EMAIL", "email": "changed@example.test", "returnOobLink": true }),
    )
    .await["oobCode"]
        .as_str()
        .expect("code")
        .to_owned();
    client(runtime, "accounts:update", &json!({ "oobCode": verify })).await;
    assert_eq!(used(&records.last()), [verify]);

    // SMS: sign-in, MFA enrolment, MFA sign-in, each used.
    let session = client(
        runtime,
        "accounts:sendVerificationCode",
        &json!({ "phoneNumber": "+15550100" }),
    )
    .await["sessionInfo"]
        .as_str()
        .expect("session")
        .to_owned();
    let message = sent(&records.last());
    assert_eq!(message.kind, MessageKind::SmsSignIn);
    assert_eq!(message.key, session);
    assert_eq!(
        message.text,
        format!(
            "To verify the phone number +15550100, use the code {}.",
            message.code
        )
    );
    client(
        runtime,
        "accounts:signInWithPhoneNumber",
        &json!({ "sessionInfo": session, "code": message.code }),
    )
    .await;
    assert_eq!(used(&records.last()), [session]);

    let enrol = client(
        runtime,
        "accounts:signUp",
        &json!({ "email": "mfa@example.test", "password": "password1", "returnSecureToken": true }),
    )
    .await;
    let mfa_uid = enrol["localId"].as_str().expect("uid").to_owned();
    admin(
        runtime,
        "accounts:update",
        &json!({ "localId": mfa_uid, "emailVerified": true }),
    )
    .await;
    let signin = client(
        runtime,
        "accounts:signInWithPassword",
        &json!({ "email": "mfa@example.test", "password": "password1", "returnSecureToken": true }),
    )
    .await;
    let token = signin["idToken"].as_str().expect("token").to_owned();
    let (status, _, start) = send(
        runtime,
        Method::POST,
        "/identitytoolkit.googleapis.com/v2/accounts/mfaEnrollment:start?key=fake",
        &[],
        Some(&json!({ "idToken": token, "phoneEnrollmentInfo": { "phoneNumber": "+15550199" } })),
    )
    .await;
    assert_eq!(status, 200, "{start}");
    let message = sent(&records.last());
    assert_eq!(message.kind, MessageKind::SmsMfaEnrollment);
    assert_eq!(message.uid.as_deref(), Some(mfa_uid.as_str()));
    let enrolment_session = start["phoneSessionInfo"]["sessionInfo"]
        .as_str()
        .expect("session")
        .to_owned();
    let (status, _, finished) = send(
        runtime,
        Method::POST,
        "/identitytoolkit.googleapis.com/v2/accounts/mfaEnrollment:finalize?key=fake",
        &[],
        Some(&json!({ "idToken": token, "phoneVerificationInfo": { "sessionInfo": enrolment_session, "code": message.code } })),
    )
    .await;
    assert_eq!(status, 200, "{finished}");
    assert_eq!(used(&records.last()), [enrolment_session]);
    let signin = client(
        runtime,
        "accounts:signInWithPassword",
        &json!({ "email": "mfa@example.test", "password": "password1" }),
    )
    .await;
    let pending = signin["mfaPendingCredential"]
        .as_str()
        .expect("pending")
        .to_owned();
    let enrollment = signin["mfaInfo"][0]["mfaEnrollmentId"]
        .as_str()
        .expect("enrollment")
        .to_owned();
    let (status, _, start) = send(
        runtime,
        Method::POST,
        "/identitytoolkit.googleapis.com/v2/accounts/mfaSignIn:start?key=fake",
        &[],
        Some(&json!({ "mfaPendingCredential": pending, "mfaEnrollmentId": enrollment })),
    )
    .await;
    assert_eq!(status, 200, "{start}");
    let message = sent(&records.last());
    assert_eq!(message.kind, MessageKind::SmsMfaSignIn);
    assert_eq!(message.uid.as_deref(), Some(mfa_uid.as_str()));
    let sign_in_session = start["phoneResponseInfo"]["sessionInfo"]
        .as_str()
        .expect("session")
        .to_owned();
    let (status, _, _) = send(
        runtime,
        Method::POST,
        "/identitytoolkit.googleapis.com/v2/accounts/mfaSignIn:finalize?key=fake",
        &[],
        Some(&json!({ "mfaPendingCredential": pending, "phoneVerificationInfo": { "sessionInfo": sign_in_session, "code": message.code } })),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(used(&records.last()), [sign_in_session]);

    // A delete, then every account.
    admin(runtime, "accounts:delete", &json!({ "localId": mfa_uid })).await;
    let record = records.last();
    assert_eq!(
        steps_of(&record, "user"),
        [&Step::User {
            tenant: None,
            uid: mfa_uid.clone(),
            change: UserChange::Deleted,
            fields: Vec::new()
        }]
    );
    assert_eq!(steps_of(&record, "trigger").len(), 1, "user.delete queued");
    let (status, _, _) = send(
        runtime,
        Method::DELETE,
        "/emulator/v1/projects/demo-auth/accounts",
        &[],
        None,
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(
        steps_of(&records.last(), "cleared"),
        [&Step::UsersCleared { tenant: None }]
    );

    // Tenants: created, updated, deleted, each a configuration step.
    let (status, _, tenant) = send(
        runtime,
        Method::POST,
        "/identitytoolkit.googleapis.com/v2/projects/demo-auth/tenants",
        &[("authorization", "Bearer owner")],
        Some(&json!({ "displayName": "acme", "allowPasswordSignup": true })),
    )
    .await;
    assert_eq!(status, 200);
    let tenant_id = tenant["tenantId"].as_str().expect("tenant").to_owned();
    assert_eq!(
        steps_of(&records.last(), "config"),
        [&Step::Config {
            tenant: Some(tenant_id.clone()),
            what: ConfigChange::TenantCreated
        }]
    );
    let (status, _, _) = send(
        runtime,
        Method::PATCH,
        &format!("/identitytoolkit.googleapis.com/v2/projects/demo-auth/tenants/{tenant_id}?updateMask=displayName"),
        &[("authorization", "Bearer owner")],
        Some(&json!({ "displayName": "acme two" })),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(
        steps_of(&records.last(), "config"),
        [&Step::Config {
            tenant: Some(tenant_id.clone()),
            what: ConfigChange::TenantUpdated
        }]
    );
    // A tenant's user names its tenant.
    client(
        runtime,
        "accounts:signUp",
        &json!({ "email": "t@acme.test", "password": "password1", "tenantId": tenant_id }),
    )
    .await;
    let record = records.last();
    assert_eq!(record.tenant.as_deref(), Some(tenant_id.as_str()));
    match steps_of(&record, "user").first() {
        Some(Step::User { tenant, .. }) => assert_eq!(tenant.as_deref(), Some(tenant_id.as_str())),
        other => panic!("{other:?}"),
    }
    let (status, _, _) = send(
        runtime,
        Method::DELETE,
        &format!("/identitytoolkit.googleapis.com/v2/projects/demo-auth/tenants/{tenant_id}"),
        &[("authorization", "Bearer owner")],
        None,
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(
        steps_of(&records.last(), "config"),
        [&Step::Config {
            tenant: Some(tenant_id),
            what: ConfigChange::TenantDeleted
        }]
    );
}

// ---------------------------------------------------------------- 23

#[test]
fn error_codes_lead_the_message_or_come_from_the_status() {
    assert_eq!(
        error_code(
            "WEAK_PASSWORD : Password should be at least 6 characters",
            None,
            400
        ),
        "WEAK_PASSWORD"
    );
    assert_eq!(error_code("USER_DISABLED", None, 400), "USER_DISABLED");
    assert_eq!(
        error_code(
            "TENANT_ID_MISMATCH: ((Refresh token tenant ID does not match.))",
            None,
            400
        ),
        "TENANT_ID_MISMATCH"
    );
    assert_eq!(
        error_code(
            "The request is missing a valid API key.",
            Some("PERMISSION_DENIED"),
            403
        ),
        "PERMISSION_DENIED"
    );
    assert_eq!(error_code("Not Found", Some("NOT_FOUND"), 404), "NOT_FOUND");
    assert_eq!(
        error_code("Method POST not allowed for /x", None, 405),
        "METHOD_NOT_ALLOWED"
    );
    assert_eq!(error_code("", None, 500), "INTERNAL");
    let error = CallError::of_response(
        400,
        br#"{"error":{"code":400,"message":"INVALID_PASSWORD","errors":[]}}"#,
    )
    .expect("an error");
    assert_eq!(error.code, "INVALID_PASSWORD");
    assert_eq!(CallError::of_response(200, b"{}"), None);
}

// ---------------------------------------------------------------- 24

#[tokio::test]
async fn bodies_are_kept_as_handles_up_to_their_limit() {
    let small = Bytes::from(vec![b'a'; BODY_LIMIT]);
    match Body::of(&small, true) {
        Body::Kept(kept) => {
            assert_eq!(kept.as_ptr(), small.as_ptr(), "the same buffer, not a copy");
        }
        other => panic!("{other:?}"),
    }
    let large = Bytes::from(vec![b'a'; BODY_LIMIT + 1]);
    assert_eq!(
        Body::of(&large, true),
        Body::Dropped {
            bytes: u64::try_from(BODY_LIMIT + 1).expect("size")
        }
    );
    assert_eq!(Body::of(&small, false), Body::NotKept);

    let observed = observed(true);
    client(
        &observed.runtime,
        "accounts:signUp",
        &json!({ "email": "ada@example.test", "password": "password1", "returnSecureToken": true }),
    )
    .await;
    let record = observed.records.last();
    match (&record.request, &record.response) {
        (Body::Kept(request), Body::Kept(response)) => {
            let request: JsonValue = serde_json::from_slice(request).expect("request JSON");
            assert_eq!(request["password"], "password1", "kept as received");
            let response: JsonValue = serde_json::from_slice(response).expect("response JSON");
            assert_eq!(response["email"], "ada@example.test");
        }
        other => panic!("{other:?}"),
    }
    // A token is never kept in a header.
    let token = response_token(&record);
    let mut headers = HeaderMap::new();
    headers.insert(
        "authorization",
        format!("Bearer {token}").parse().expect("header"),
    );
    headers.insert(
        "x-client-version",
        "Chrome/JsCore/12.0.0/FirebaseCore-web"
            .parse()
            .expect("header"),
    );
    headers.insert("cookie", "session=secret".parse().expect("header"));
    let kept = kept_headers(&headers);
    assert_eq!(
        kept,
        [
            (
                "x-client-version".to_owned(),
                "Chrome/JsCore/12.0.0/FirebaseCore-web".to_owned()
            ),
            (
                "authorization".to_owned(),
                format!("Bearer <id token, {} bytes>", token.len())
            ),
        ],
        "only the listed headers, the token reduced"
    );
    assert_eq!(reduce_authorization("Bearer owner"), "Bearer owner");
    assert_eq!(reduce_authorization("Bearer opaque"), "Bearer <6 bytes>");
    assert_eq!(
        client_of(&headers).as_deref(),
        Some("Chrome/JsCore/12.0.0/FirebaseCore-web")
    );

    // Without bodies (diagnostics off) only summaries are kept.
    let quiet = observed_without_bodies();
    client(
        &quiet.runtime,
        "accounts:signUp",
        &json!({ "returnSecureToken": true }),
    )
    .await;
    let record = quiet.records.last();
    assert_eq!(
        (record.request, record.response),
        (Body::NotKept, Body::NotKept)
    );
}

fn response_token(record: &CallRecord) -> String {
    match &record.response {
        Body::Kept(bytes) => serde_json::from_slice::<JsonValue>(bytes).expect("JSON")["idToken"]
            .as_str()
            .expect("token")
            .to_owned(),
        other => panic!("{other:?}"),
    }
}

fn observed_without_bodies() -> Observed {
    observed(false)
}

// ---------------------------------------------------------------- 25

#[tokio::test]
async fn the_activity_header_answers_only_the_console_and_names_the_record() {
    let observed = observed(false);
    let runtime = &observed.runtime;
    let (_, headers, _) = send(
        runtime,
        Method::POST,
        &format!("{CLIENT}/accounts:signUp?key=fake"),
        &[],
        Some(&json!({ "returnSecureToken": true })),
    )
    .await;
    assert!(
        !headers.contains_key(ACTIVITY_HEADER),
        "an app never sees it"
    );
    let (_, headers, _) = send(
        runtime,
        Method::POST,
        &format!("{CLIENT}/accounts:signUp?key=fake"),
        &[("x-firenook-console", "write")],
        Some(&json!({ "returnSecureToken": true })),
    )
    .await;
    // The record is there when the response is.
    let record = observed.records.last();
    assert_eq!(headers[ACTIVITY_HEADER], record.id.to_string().as_str());

    // Without an observer the console still learns the call id.
    let plain = crate::tests::test_runtime();
    let (_, headers, _) = send(
        &plain,
        Method::POST,
        &format!("{CLIENT}/accounts:signUp?key=fake"),
        &[("x-firenook-console", "1")],
        Some(&json!({ "returnSecureToken": true })),
    )
    .await;
    assert!(headers.contains_key(ACTIVITY_HEADER));
}

// ---------------------------------------------------------------- 26

#[tokio::test]
async fn without_an_observer_notices_are_drained_and_no_step_is_kept() {
    let runtime = crate::tests::test_runtime();
    client(
        &runtime,
        "accounts:signUp",
        &json!({ "email": "a@example.test", "password": "password1" }),
    )
    .await;
    admin(
        &runtime,
        "accounts:sendOobCode",
        &json!({ "requestType": "PASSWORD_RESET", "email": "a@example.test", "returnOobLink": true }),
    )
    .await;
    let handle = runtime.runtime();
    let data = crate::lock(&handle.inner.data);
    let agent = &data.projects["demo-auth"];
    assert_eq!(agent.project.notices, Vec::new());
    assert_eq!(agent.notices, Vec::new());
    drop(data);
    let trace = Trace::new(7, None, false);
    trace.push(Step::UsersCleared { tenant: None });
    assert!(!trace.recording());
    assert_eq!(trace.take(), Vec::new());
}

// ---------------------------------------------------------------- 27

#[tokio::test]
async fn saved_codes_come_back_as_restored_messages() {
    let directory = std::env::temp_dir().join(format!(
        "firenook-auth-saved-{}-{}",
        std::process::id(),
        crate::util::now_millis()
    ));
    let file = directory.join("auth-state.json");
    let registry = TriggerRegistry::default();
    let (observer, _dispatches) = TriggerObserver::channel(registry.clone());
    let runtime = AuthRuntime::new(
        "demo-auth",
        observer.queue(),
        registry.clone(),
        Some(file.clone()),
    )
    .expect("runtime");
    client(
        &runtime,
        "accounts:signUp",
        &json!({ "email": "a@example.test", "password": "password1" }),
    )
    .await;
    let link = admin(
        &runtime,
        "accounts:sendOobCode",
        &json!({ "requestType": "PASSWORD_RESET", "email": "a@example.test", "returnOobLink": true, "continueUrl": "https://app.example.test/next" }),
    )
    .await;
    client(
        &runtime,
        "accounts:sendVerificationCode",
        &json!({ "phoneNumber": "+15550123" }),
    )
    .await;
    drop(runtime);

    let restarted =
        AuthRuntime::new("demo-auth", observer.queue(), registry, Some(file)).expect("restart");
    let saved = restarted.runtime().saved_messages();
    assert_eq!(saved.len(), 2);
    let reset = saved
        .iter()
        .find(|message| message.kind == MessageKind::PasswordReset)
        .expect("the reset link");
    assert_eq!(reset.delivery, Delivery::Restored);
    assert_eq!(reset.at_millis, None);
    assert_eq!(reset.code, link["oobCode"]);
    assert_eq!(reset.to, "a@example.test");
    assert_eq!(reset.project, "demo-auth");
    assert!(reset.uid.is_some());
    assert_eq!(
        reset.continue_url.as_deref(),
        Some("https://app.example.test/next")
    );
    let sms = saved
        .iter()
        .find(|message| message.kind == MessageKind::SmsSignIn)
        .expect("the SMS code");
    assert_eq!(sms.to, "+15550123");
    assert_eq!(sms.code.len(), 6);
    assert_ne!(reset.id, sms.id);
    drop(restarted);
    let _ = std::fs::remove_dir_all(&directory);
}

// ---------------------------------------------------------------- 27a

/// A log line as a sink received it: kind, text and message.
type Line = (String, String, Option<AuthMessageRef>);

#[tokio::test]
async fn codes_reach_the_log_with_their_message_and_the_same_text() {
    let observed = observed(false);
    let runtime = &observed.runtime;
    let lines: Arc<Mutex<Vec<Line>>> = Arc::default();
    let sink = lines.clone();
    runtime.set_line_sink(Arc::new(move |line: &AuthLogLine<'_>| {
        sink.lock().expect("lines").push((
            line.kind.to_owned(),
            line.text.to_owned(),
            line.message.cloned(),
        ));
    }));
    let signup = client(
        runtime,
        "accounts:signUp",
        &json!({ "email": "ada@example.test", "password": "password1" }),
    )
    .await;
    let uid = signup["localId"].as_str().expect("uid").to_owned();
    client(
        runtime,
        "accounts:sendOobCode",
        &json!({ "requestType": "PASSWORD_RESET", "email": "ada@example.test" }),
    )
    .await;
    let reset = sent(&observed.records.last());
    client(
        runtime,
        "accounts:sendVerificationCode",
        &json!({ "phoneNumber": "+15550100" }),
    )
    .await;
    let sms = sent(&observed.records.last());
    let lines = lines.lock().expect("lines").clone();
    assert_eq!(lines.len(), 2, "{lines:?}");
    let (kind, text, message) = &lines[0];
    assert_eq!(kind, "BULLET");
    assert_eq!(
        text,
        &format!(
            "To reset the password for ada@example.test, follow this link: {}&newPassword=NEW_PASSWORD_HERE",
            reset.link.as_deref().expect("link")
        )
    );
    assert_eq!(text, &reset.text, "the inbox keeps the printed line");
    assert_eq!(
        message.as_ref(),
        Some(&AuthMessageRef {
            id: reset.id,
            project: "demo-auth".to_owned(),
            tenant: None,
            uid: Some(uid),
        })
    );
    let (_, text, message) = &lines[1];
    assert_eq!(text, &sms.text);
    assert_eq!(message.as_ref().map(|message| message.id), Some(sms.id));
    assert!(sms.id > reset.id, "message ids increase");

    // A text sink still receives the same lines.
    let texts: Arc<Mutex<Vec<String>>> = Arc::default();
    let sink = texts.clone();
    runtime.set_log_sink(Arc::new(move |_kind: &str, text: &str| {
        sink.lock().expect("texts").push(text.to_owned());
    }));
    client(
        runtime,
        "accounts:sendVerificationCode",
        &json!({ "phoneNumber": "+15550101" }),
    )
    .await;
    assert_eq!(
        texts.lock().expect("texts").clone(),
        [sent(&observed.records.last()).text]
    );
    // Lines that print no code carry no message.
    tokio::time::sleep(Duration::from_millis(1)).await;
}
