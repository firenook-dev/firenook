//! The Auth Console API through the console router: routes, jobs, uploads,
//! exports, the Inbox and Activity, tenants, search, the summary and the
//! clear (tests 34, 37–42c of the section's plan).

use std::time::Duration;

use axum::body::{Body, to_bytes};
use axum::http::{HeaderMap, Method, Request, StatusCode};
use firenook_auth_front::AuthRuntime;
use firenook_auth_front::state::UserRecord;
use firenook_functions_bridge::{TriggerObserver, TriggerRegistry};
use serde_json::{Value, json};
use tokio::sync::watch;
use tower::ServiceExt as _;

use crate::sse::Shutdown;
use crate::{AuthConsole, ConsoleServices, console_router};

const PROJECT: &str = "demo-console";

struct Api {
    auth: AuthRuntime,
    console: AuthConsole,
    router: axum::Router,
    stop: watch::Sender<bool>,
}

fn api_with(keep_bodies: bool) -> Api {
    let registry = TriggerRegistry::default();
    let (observer, _deliveries) = TriggerObserver::channel(registry.clone());
    let auth = firenook_auth_front::router(PROJECT, observer.queue(), registry);
    let console = AuthConsole::attach(
        &auth,
        keep_bodies,
        firenook_suite_front::LoggingRuntime::new(),
    );
    let (stop, receiver) = watch::channel(false);
    let router = console_router(ConsoleServices {
        auth: Some(console.clone()),
        shutdown: Shutdown::new(receiver.clone()),
        ..ConsoleServices::new(
            crate::tests::directory_services().directory,
            Shutdown::new(receiver),
        )
    });
    Api {
        auth,
        console,
        router,
        stop,
    }
}

fn api() -> Api {
    api_with(true)
}

/// Creates an account straight in the emulator's state (no call, no event).
fn add(api: &Api, tenant: Option<&str>, uid: &str, fields: &Value) {
    let props: UserRecord = fields.as_object().cloned().unwrap_or_default();
    api.auth
        .runtime()
        .update(|data| {
            let agent = data.agent(PROJECT);
            let state = match tenant {
                Some(tenant) => {
                    agent.ensure_tenant(PROJECT, tenant);
                    &mut agent.tenants.get_mut(tenant).expect("tenant").project
                }
                None => &mut agent.project,
            };
            state
                .create_user_with_local_id(uid, &props)
                .expect("created")
                .expect("new");
        })
        .expect("saved");
}

async fn call(
    api: &Api,
    method: Method,
    uri: &str,
    body: Option<&Value>,
) -> (StatusCode, HeaderMap, Vec<u8>) {
    let mut request = Request::builder().method(method).uri(uri);
    if body.is_some() {
        request = request.header("content-type", "application/json");
    }
    let request = request
        .body(body.map_or_else(Body::empty, |body| Body::from(body.to_string())))
        .expect("request");
    let response = api.router.clone().oneshot(request).await.expect("response");
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body")
        .to_vec();
    (status, headers, bytes)
}

async fn get(api: &Api, uri: &str) -> (StatusCode, Value) {
    let (status, _, body) = call(api, Method::GET, uri, None).await;
    (status, serde_json::from_slice(&body).unwrap_or(Value::Null))
}

async fn post(api: &Api, uri: &str, body: &Value) -> (StatusCode, Value) {
    let (status, _, body) = call(api, Method::POST, uri, Some(body)).await;
    (status, serde_json::from_slice(&body).unwrap_or(Value::Null))
}

async fn delete(api: &Api, uri: &str) -> StatusCode {
    call(api, Method::DELETE, uri, Some(&json!({}))).await.0
}

/// A call to the Auth emulator's own application through the mount.
async fn native(api: &Api, path: &str, body: &Value) -> (StatusCode, Value) {
    post(
        api,
        &format!("/api/v1/auth/identitytoolkit.googleapis.com/v1/{path}?key=fake"),
        body,
    )
    .await
}

async fn sign_up(api: &Api, email: &str) -> Value {
    let (status, body) = native(
        api,
        "accounts:signUp",
        &json!({ "email": email, "password": "secret-1", "returnSecureToken": true }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body
}

/// Waits for the job to leave `running`.
async fn finished(api: &Api, id: &str) -> Value {
    for _ in 0..400 {
        let (status, job) = get(api, &format!("/api/v1/jobs/{id}")).await;
        assert_eq!(status, StatusCode::OK, "{job}");
        if job["state"] != "running" {
            return job;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("job {id} did not finish");
}

fn items(page: &Value) -> &Vec<Value> {
    page["items"].as_array().expect("items")
}

fn field(page: &Value, name: &str) -> Vec<String> {
    items(page)
        .iter()
        .map(|item| item[name].as_str().unwrap_or_default().to_owned())
        .collect()
}

/// Ada (project), Grace (project, disabled), Turing (tenant acme).
fn people(api: &Api) {
    add(
        api,
        None,
        "u_ada",
        &json!({
            "email": "ada@example.test",
            "displayName": "Ada Lovelace",
            "emailVerified": true,
            "createdAt": "1790812800000",
            "customAttributes": "{\"role\":\"admin\",\"level\":3}",
            "providerUserInfo": [
                { "providerId": "password", "email": "ada@example.test", "rawId": "ada@example.test" },
            ],
        }),
    );
    add(
        api,
        None,
        "u_grace",
        &json!({ "email": "grace@example.test", "disabled": true }),
    );
    add(
        api,
        Some("acme"),
        "t_turing",
        &json!({ "email": "turing@acme.test" }),
    );
}

// ---------------------------------------------------------------- users

#[tokio::test]
async fn the_users_routes_answer_pages_rows_details_and_claims() {
    let api = api();
    people(&api);
    let (status, page) = get(&api, "/api/v1/auth/users").await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert_eq!(field(&page, "uid").len(), 2);
    assert_eq!(page["total"], json!({ "count": 2, "exact": true }));
    assert_eq!(page["scopeTotal"], 2);
    assert_eq!(page["facets"]["disabled"], 1);
    let (_, page) = get(&api, "/api/v1/auth/users?q=is:disabled").await;
    assert_eq!(field(&page, "uid"), ["u_grace"]);
    let (_, page) = get(&api, "/api/v1/auth/users?tenant=acme").await;
    assert_eq!(field(&page, "uid"), ["t_turing"]);
    assert_eq!(items(&page)[0]["tenant"], "acme");
    let (_, page) = get(&api, "/api/v1/auth/users?q=claim:level=3&sort=email:asc").await;
    assert_eq!(field(&page, "uid"), ["u_ada"]);
    // Paging: one row a page, there and back.
    let (_, first) = get(&api, "/api/v1/auth/users?limit=1&sort=uid:asc").await;
    assert_eq!(field(&first, "uid"), ["u_ada"]);
    let next = first["nextCursor"].as_str().expect("next");
    let (_, second) = get(
        &api,
        &format!("/api/v1/auth/users?limit=1&sort=uid:asc&cursor={next}"),
    )
    .await;
    assert_eq!(field(&second, "uid"), ["u_grace"]);
    assert_eq!(second["nextCursor"], Value::Null);

    let (status, meta) = get(&api, "/api/v1/auth/users/meta").await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        meta["sortable"]
            .as_array()
            .expect("sortable")
            .contains(&json!("created"))
    );
    assert_eq!(meta["fields"][0]["key"], "is");

    let (status, detail) = get(&api, "/api/v1/auth/user?uid=u_ada").await;
    assert_eq!(status, StatusCode::OK, "{detail}");
    assert_eq!(detail["row"]["email"], "ada@example.test");
    assert_eq!(detail["claims"]["role"], "admin");
    let (status, detail) = get(&api, "/api/v1/auth/user?uid=t_turing&tenant=acme").await;
    assert_eq!(status, StatusCode::OK, "{detail}");

    let (status, batch) = post(
        &api,
        "/api/v1/auth/users:batchGet",
        &json!({ "keys": ["u_ada", "gone"], "pageStarts": [null] }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{batch}");
    assert_eq!(batch["items"][0]["row"]["uid"], "u_ada", "{batch}");
    assert_eq!(batch["items"][0]["page"], 0);
    assert_eq!(batch["items"][1]["row"], Value::Null);
    assert_eq!(batch["total"]["count"], 2);

    let (status, claims) = get(&api, "/api/v1/auth/claims").await;
    assert_eq!(status, StatusCode::OK, "{claims}");
    assert_eq!(claims["usersWithClaims"], 1);
    let keys: Vec<&str> = claims["keys"]
        .as_array()
        .expect("keys")
        .iter()
        .map(|key| key["key"].as_str().expect("key"))
        .collect();
    assert_eq!(keys, ["level", "role"]);
}

#[tokio::test]
async fn refusals_are_api_errors_with_their_codes_and_fixes() {
    let api = api();
    people(&api);
    let (status, body) = get(&api, "/api/v1/auth/users?tenant=nope").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(
        body["error"]["message"],
        "There is no tenant `nope` in this project."
    );
    assert_eq!(
        body["error"]["fix"],
        "Pick a tenant from the list, or create it in Settings."
    );
    let (status, body) = get(&api, "/api/v1/auth/user?uid=nobody").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(
        body["error"]["message"],
        "There is no user `nobody` among the project's users."
    );
    let (status, body) = get(&api, "/api/v1/auth/users?q=ada%20foo:bar").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["span"], json!({ "from": 4, "to": 11 }));
    let (status, body) = get(&api, "/api/v1/auth/users?sort=photoUrl:asc").await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    let (status, body) = get(&api, "/api/v1/auth/activity/987654").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(
        body["error"]["message"],
        "The engine no longer keeps call #987,654; it keeps the newest 10,000."
    );
    let (status, body) = get(&api, "/api/v1/auth/messages/312").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(
        body["error"]["message"],
        "The engine no longer keeps message #312; it keeps the newest 2,000."
    );
    let (status, body) = post(
        &api,
        "/api/v1/auth/users:import",
        &json!({ "importId": "1-0", "mode": "skip" }),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(
        body["error"]["message"],
        "This upload has expired: uploads are kept for 10 minutes."
    );
    let (status, _) = get(&api, "/api/v1/auth/users?nonsense=1").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn another_project_answers_empty_and_creates_nothing() {
    let api = api();
    people(&api);
    for uri in [
        "/api/v1/auth/users?project=demo-other",
        "/api/v1/auth/tenants?project=demo-other",
        "/api/v1/auth/activity?project=demo-other",
        "/api/v1/auth/messages?project=demo-other",
        "/api/v1/auth/identities?project=demo-other",
    ] {
        let (status, page) = get(&api, uri).await;
        assert_eq!(status, StatusCode::OK, "{uri}: {page}");
        assert_eq!(items(&page).len(), 0, "{uri}");
    }
    let (_, summary) = get(&api, "/api/v1/auth/summary?project=demo-other").await;
    assert_eq!(summary["users"], 0);
    let projects: Vec<String> = api
        .auth
        .runtime()
        .read(|data| data.projects.keys().cloned().collect());
    assert_eq!(projects, [PROJECT]);
}

#[tokio::test]
async fn the_native_application_still_answers_through_the_fallback() {
    let api = api();
    let body = sign_up(&api, "new@example.test").await;
    assert!(body["idToken"].is_string());
    let (status, _) = get(
        &api,
        &format!("/api/v1/auth/emulator/v1/projects/{PROJECT}/config"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
}

// ---------------------------------------------------------------- bulk

#[tokio::test]
async fn a_bulk_verb_previews_then_runs_as_a_job() {
    let api = api();
    people(&api);
    let target = json!({ "by": "query", "q": "", "scope": {} });
    let (status, preview) = post(
        &api,
        "/api/v1/auth/users:disable",
        &json!({ "target": target, "dryRun": true }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    assert_eq!(preview["matched"], 2);
    assert_eq!(preview["changed"], 1, "Grace is disabled already");
    let (status, job) = post(
        &api,
        "/api/v1/auth/users:disable",
        &json!({ "target": target }),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{job}");
    assert_eq!(job["kind"], "auth.disable");
    assert_eq!(job["title"], "Disable 2 users");
    assert_eq!(job["total"], 2);
    let job = finished(&api, job["id"].as_str().expect("id")).await;
    assert_eq!(job["state"], "done", "{job}");
    assert_eq!(
        (job["done"].clone(), job["skipped"].clone()),
        (json!(2), json!(1)),
        "{job}"
    );
    let (_, page) = get(&api, "/api/v1/auth/users?q=is:disabled").await;
    assert_eq!(field(&page, "uid").len(), 2);

    // By keys, across scopes.
    let (status, job) = post(
        &api,
        "/api/v1/auth/users:setClaims",
        &json!({
            "target": { "by": "keys", "keys": ["|u_grace", "acme|t_turing"] },
            "claims": { "plan": "pro" },
            "mode": "merge",
        }),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{job}");
    finished(&api, job["id"].as_str().expect("id")).await;
    let (_, page) = get(&api, "/api/v1/auth/users?tenant=acme&q=claim:plan=pro").await;
    assert_eq!(field(&page, "uid"), ["t_turing"]);
    let (status, body) = post(
        &api,
        "/api/v1/auth/users:enable",
        &json!({ "target": { "by": "keys", "keys": ["no-bar"] } }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    let (status, _) = post(
        &api,
        "/api/v1/auth/users:removeClaims",
        &json!({ "target": target, "keys": [] }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn a_triggered_delete_over_ten_thousand_is_refused_before_any_job() {
    let api = api();
    api.auth
        .runtime()
        .update(|data| {
            let state = &mut data.agent(PROJECT).project;
            for index in 0..10_001 {
                state
                    .create_user_with_local_id(&format!("bulk-{index:05}"), &UserRecord::new())
                    .expect("created");
            }
        })
        .expect("saved");
    let (status, body) = post(
        &api,
        "/api/v1/auth/users:delete",
        &json!({ "target": { "by": "query", "q": "" }, "triggers": true }),
    )
    .await;
    assert_eq!(status, StatusCode::PRECONDITION_FAILED, "{body}");
    assert_eq!(
        body["error"]["message"],
        "A delete that runs your user.delete triggers is limited to 10,000 users per action."
    );
    let (_, jobs) = get(&api, "/api/v1/jobs?section=auth").await;
    assert_eq!(jobs["jobs"].as_array().map_or(0, Vec::len), 0, "{jobs}");
    // Without triggers it is a job.
    let (status, job) = post(
        &api,
        "/api/v1/auth/users:delete",
        &json!({ "target": { "by": "query", "q": "uid:bulk-0000*" } }),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{job}");
    let job = finished(&api, job["id"].as_str().expect("id")).await;
    assert_eq!(job["done"], 10);
}

// ---------------------------------------------------------------- tokens

#[tokio::test]
async fn a_minted_token_carries_a_draft_and_the_inspection_judges_tokens() {
    let api = api();
    people(&api);
    let (status, token) = post(
        &api,
        "/api/v1/auth/tokens",
        &json!({ "uid": "u_ada", "claims": { "role": "viewer" } }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{token}");
    assert_eq!(token["payload"]["role"], "viewer");
    assert!(token["refreshToken"].is_string());
    assert!(
        token["differences"]
            .as_array()
            .expect("differences")
            .iter()
            .any(|line| line.as_str().is_some_and(|line| line.contains("draft")))
    );
    let id_token = token["idToken"].as_str().expect("idToken").to_owned();

    let (status, inspection) = post(
        &api,
        "/api/v1/auth/token/inspect",
        &json!({ "token": format!("Bearer {id_token}") }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{inspection}");
    assert_eq!(inspection["kind"], "idToken");
    assert_eq!(inspection["uid"], "u_ada");
    assert_eq!(inspection["checks"][0]["consumer"], "rules");
    assert_eq!(inspection["checks"][0]["ok"], true, "{inspection}");

    // Another project's token: the rules refuse it, and say why.
    let (_, inspection) = post(
        &api,
        "/api/v1/auth/token/inspect?project=demo-other",
        &json!({ "token": id_token }),
    )
    .await;
    assert_eq!(inspection["checks"][0]["ok"], false);
    assert!(
        inspection["checks"][0]["reason"]
            .as_str()
            .is_some_and(|reason| reason.contains("`demo-console`")),
        "{inspection}"
    );
    // A custom token is not what the rules read.
    let (_, inspection) = post(
        &api,
        "/api/v1/auth/token/inspect",
        &json!({ "token": token["customToken"] }),
    )
    .await;
    assert_eq!(inspection["checks"][0]["ok"], false, "{inspection}");
    let (_, inspection) = post(
        &api,
        "/api/v1/auth/token/inspect",
        &json!({ "token": "not a token" }),
    )
    .await;
    assert_eq!(inspection["checks"][0]["ok"], false);
}

#[tokio::test]
async fn an_expired_token_is_explained() {
    use base64::Engine as _;
    let api = api();
    people(&api);
    let encode =
        |value: &Value| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(value.to_string());
    let now = time::OffsetDateTime::now_utc().unix_timestamp();
    let token = format!(
        "{}.{}.",
        encode(&json!({ "alg": "none", "typ": "JWT" })),
        encode(&json!({
            "sub": "u_ada", "user_id": "u_ada", "aud": PROJECT,
            "iss": format!("https://securetoken.google.com/{PROJECT}"),
            "iat": now - 7_200, "exp": now - 3_600, "auth_time": now - 7_200,
            "firebase": { "sign_in_provider": "password", "identities": {} },
        }))
    );
    let (_, inspection) = post(
        &api,
        "/api/v1/auth/token/inspect",
        &json!({ "token": token }),
    )
    .await;
    let check = &inspection["checks"][0];
    assert_eq!(check["ok"], false, "{inspection}");
    assert!(
        check["reason"]
            .as_str()
            .is_some_and(|reason| reason.starts_with("Expired 1 h ago")),
        "{check}"
    );
}

// ---------------------------------------------------------------- imports

#[tokio::test]
async fn an_upload_is_checked_imported_as_a_job_and_removed() {
    let api = api();
    people(&api);
    let file = json!({ "users": [
        { "localId": "imp-1", "email": "one@import.test" },
        { "localId": "imp-2", "email": "two@import.test", "customAttributes": "{\"a\":1}" },
        { "localId": "u_ada", "email": "ada@example.test" },
    ]});
    let (status, preview) = post(&api, "/api/v1/auth/imports", &file).await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    assert_eq!(preview["total"], 3);
    assert_eq!(preview["existing"], json!(["u_ada"]));
    let import_id = preview["importId"].as_str().expect("importId").to_owned();
    let uploads = api.console.live.uploads.get().expect("uploads").clone();
    let path = uploads.get(&import_id).expect("kept").path;
    assert_eq!(
        std::fs::metadata(&path).expect("on disk").len(),
        u64::try_from(file.to_string().len()).expect("size")
    );
    let (status, again) = post(
        &api,
        "/api/v1/auth/users:import",
        &json!({ "importId": import_id, "mode": "skip", "dryRun": true }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{again}");
    let (status, job) = post(
        &api,
        "/api/v1/auth/users:import",
        &json!({ "importId": import_id, "mode": "skip" }),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{job}");
    assert_eq!(job["kind"], "auth.import");
    let job = finished(&api, job["id"].as_str().expect("id")).await;
    assert_eq!(job["state"], "done", "{job}");
    let (_, page) = get(&api, "/api/v1/auth/users?q=uid:imp-*&sort=uid:asc").await;
    assert_eq!(field(&page, "uid"), ["imp-1", "imp-2"]);
    assert!(!path.exists(), "the file is removed after the import");
    let (status, _) = post(
        &api,
        "/api/v1/auth/users:import",
        &json!({ "importId": import_id, "mode": "skip" }),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "the upload is used up");
}

#[tokio::test]
async fn an_upload_that_is_not_json_is_refused() {
    let api = api();
    let upload = |console: bool| {
        let mut request = Request::post("/api/v1/auth/imports").header("content-type", "text/csv");
        if console {
            request = request.header(crate::CONSOLE_HEADER, "1");
        }
        request.body(Body::from("uid\n")).expect("request")
    };
    // The guard refuses a mutation that is neither JSON nor the console's.
    let response = api
        .router
        .clone()
        .oneshot(upload(false))
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
    // The route itself takes only JSON.
    let response = api
        .router
        .clone()
        .oneshot(upload(true))
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
    let body = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body");
    let body: Value = serde_json::from_slice(&body).expect("json");
    assert_eq!(
        body["error"]["message"],
        "Upload the file as application/json."
    );
    let (status, _) = post(&api, "/api/v1/auth/imports?tenant=nope", &json!([])).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn uploads_over_the_limit_expire_and_leave_with_the_engine() {
    let dir = std::env::temp_dir()
        .join("firenook-console-imports")
        .join(format!("test-{}", std::process::id()));
    let (stop, receiver) = watch::channel(false);
    let uploads = super::uploads::Uploads::start(
        &format!("test-{}", std::process::id()),
        Shutdown::new(receiver),
    );
    assert_eq!(uploads.dir(), dir);
    // Over 512 MiB, streamed: refused, nothing kept.
    let chunk = axum::body::Bytes::from(vec![b' '; 8 * 1024 * 1024]);
    let chunks =
        futures_util::stream::iter((0..65).map(move |_| Ok::<_, std::io::Error>(chunk.clone())));
    let refused = uploads
        .receive(Body::from_stream(chunks), PROJECT, None)
        .await
        .expect_err("too large");
    assert_eq!(refused.status(), StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(refused.detail().message, "The file is over 512 MiB.");
    assert_eq!(std::fs::read_dir(&dir).map_or(0, Iterator::count), 0);
    // A third upload replaces the oldest.
    let mut ids = Vec::new();
    for _ in 0..3 {
        let upload = uploads
            .receive(Body::from("[]"), PROJECT, None)
            .await
            .expect("kept");
        ids.push(upload.id);
    }
    assert!(uploads.get(&ids[0]).is_err(), "the oldest was replaced");
    assert!(uploads.get(&ids[2]).is_ok());
    // Ten minutes later it is gone.
    uploads.age(&ids[2], super::uploads::UPLOAD_LIFETIME);
    assert!(uploads.get(&ids[2]).is_err());
    // The directory leaves with the engine.
    assert!(dir.exists());
    stop.send(true).expect("stop");
    for _ in 0..100 {
        if !dir.exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(
        !dir.exists(),
        "the instance's directory is removed at shutdown"
    );
}

// ---------------------------------------------------------------- export

#[tokio::test]
async fn an_export_streams_json_or_csv_as_an_attachment() {
    let api = api();
    people(&api);
    let (status, headers, body) = call(
        &api,
        Method::GET,
        "/api/v1/auth/users:export?format=json",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let disposition = headers["content-disposition"].to_str().expect("header");
    assert!(
        disposition.starts_with("attachment; filename=\"auth-users-demo-console-")
            && disposition.contains(".json\""),
        "{disposition}"
    );
    let file: Value = serde_json::from_slice(&body).expect("the export parses");
    let uids: Vec<&str> = file["users"]
        .as_array()
        .expect("users")
        .iter()
        .map(|user| user["localId"].as_str().expect("localId"))
        .collect();
    assert_eq!(uids, ["u_ada", "u_grace"]);
    let (status, headers, body) = call(
        &api,
        Method::GET,
        "/api/v1/auth/users:export?format=csv&tenant=acme",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        headers["content-type"]
            .to_str()
            .expect("type")
            .starts_with("text/csv")
    );
    let text = String::from_utf8(body).expect("utf-8");
    assert!(
        text.starts_with(firenook_auth_front::console::export::CSV_HEADER),
        "{text}"
    );
    assert!(text.contains("t_turing"));
    let (_, _, body) = call(
        &api,
        Method::GET,
        "/api/v1/auth/users:export?format=json&uid=u_grace",
        None,
    )
    .await;
    let file: Value = serde_json::from_slice(&body).expect("json");
    assert_eq!(file["users"].as_array().map(Vec::len), Some(1));
    let (status, _, _) = call(
        &api,
        Method::GET,
        "/api/v1/auth/users:export?format=xml",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

// ---------------------------------------------------------------- inbox and activity

#[tokio::test]
async fn codes_reach_the_inbox_with_their_call_and_clear() {
    let api = api();
    sign_up(&api, "reset@example.test").await;
    let (status, sent) = native(
        &api,
        "accounts:sendOobCode",
        &json!({ "requestType": "PASSWORD_RESET", "email": "reset@example.test" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{sent}");
    let (status, page) = get(&api, "/api/v1/auth/messages").await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert_eq!(items(&page).len(), 1);
    let message = &items(&page)[0];
    assert_eq!(message["kind"], "passwordReset");
    assert_eq!(message["to"], "reset@example.test");
    assert_eq!(message["used"], false);
    assert!(page["liveAfter"].is_string());
    assert_eq!(page["facets"]["unused"], 1);
    let call = message["activity"].as_u64().expect("the call that sent it");
    let (_, by_call) = get(&api, &format!("/api/v1/auth/messages?activity={call}")).await;
    assert_eq!(items(&by_call).len(), 1);
    let id = message["id"].as_u64().expect("id");
    let (status, one) = get(&api, &format!("/api/v1/auth/messages/{id}")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(one["code"], message["code"]);
    let (_, filtered) = get(&api, "/api/v1/auth/messages?q=type:sms").await;
    assert_eq!(items(&filtered).len(), 0);
    // Using the code marks the message used.
    let (status, body) = native(
        &api,
        "accounts:resetPassword",
        &json!({ "oobCode": message["code"], "newPassword": "secret-2" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (_, page) = get(&api, "/api/v1/auth/messages?q=is:used").await;
    assert_eq!(items(&page).len(), 1, "{page}");
    assert!(items(&page)[0]["usedBy"].is_u64());
    assert_eq!(
        delete(&api, "/api/v1/auth/messages").await,
        StatusCode::NO_CONTENT
    );
    let (_, page) = get(&api, "/api/v1/auth/messages").await;
    assert_eq!(items(&page).len(), 0);
}

#[tokio::test]
async fn calls_reach_activity_with_bodies_filters_and_clear() {
    let api = api();
    sign_up(&api, "one@example.test").await;
    let (status, page) = get(&api, "/api/v1/auth/activity").await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert_eq!(page["bodiesRetained"], true);
    let call = items(&page)
        .iter()
        .find(|item| item["kind"] == "sign-up")
        .expect("the sign-up")
        .clone();
    assert_eq!(call["newUser"], true);
    assert_eq!(page["facets"]["newUsers"], 1);
    let (_, filtered) = get(&api, "/api/v1/auth/activity?q=kind:sign-up").await;
    assert_eq!(items(&filtered).len(), 1);
    let (_, none) = get(&api, "/api/v1/auth/activity?q=is:error").await;
    assert_eq!(items(&none).len(), 0);
    let (status, body) = get(&api, "/api/v1/auth/activity?q=status:abc").await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    let id = call["id"].as_u64().expect("id");
    let (status, detail) = get(&api, &format!("/api/v1/auth/activity/{id}")).await;
    assert_eq!(status, StatusCode::OK, "{detail}");
    assert!(
        detail["request"]
            .as_str()
            .is_some_and(|request| request.contains("one@example.test")),
        "{detail}"
    );
    assert_eq!(detail["replayable"], true);
    assert_eq!(detail["replayEffect"], "Replay creates another user.");
    assert_eq!(
        delete(&api, "/api/v1/auth/activity").await,
        StatusCode::NO_CONTENT
    );
    let (_, page) = get(&api, "/api/v1/auth/activity").await;
    assert_eq!(items(&page).len(), 0);
}

#[tokio::test]
async fn without_diagnostics_no_body_is_kept() {
    let api = api_with(false);
    sign_up(&api, "one@example.test").await;
    let (_, page) = get(&api, "/api/v1/auth/activity").await;
    assert_eq!(page["bodiesRetained"], false);
    let id = items(&page)[0]["id"].as_u64().expect("id");
    let (_, detail) = get(&api, &format!("/api/v1/auth/activity/{id}")).await;
    assert_eq!(detail["request"], Value::Null);
    assert_eq!(detail["replayable"], false);
}

// ---------------------------------------------------------------- tenants, hooks, summary

#[tokio::test]
async fn tenants_are_listed_created_and_read_by_id() {
    let api = api();
    people(&api);
    let (status, page) = get(&api, "/api/v1/auth/tenants").await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert_eq!(field(&page, "tenantId"), ["acme"]);
    assert_eq!(items(&page)[0]["users"], 1);
    assert_eq!(page["projectUsers"], 2);
    let (status, tenant) = post(
        &api,
        "/api/v1/auth/tenants",
        &json!({ "tenantId": "beta-1", "displayName": "Beta", "allowPasswordSignup": true }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{tenant}");
    assert_eq!(tenant["tenantId"], "beta-1");
    let (status, body) = post(
        &api,
        "/api/v1/auth/tenants",
        &json!({ "tenantId": "beta-1" }),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    let (status, _) = post(&api, "/api/v1/auth/tenants", &json!({ "tenantId": "1x" })).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (_, page) = get(&api, "/api/v1/auth/tenants?q=bet").await;
    assert_eq!(field(&page, "tenantId"), ["beta-1"]);
    let (status, batch) = post(
        &api,
        "/api/v1/auth/tenants:batchGet",
        &json!({ "keys": ["acme", "gone"] }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{batch}");
    assert_eq!(batch["items"][0]["row"]["tenantId"], "acme");
    assert_eq!(batch["items"][1]["row"], Value::Null);
    let (status, meta) = get(&api, "/api/v1/auth/tenants/meta").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(meta["defaultSort"], "tenantId:asc");
}

#[tokio::test]
async fn hooks_and_the_summary_answer() {
    let api = api();
    people(&api);
    let (status, hooks) = get(&api, "/api/v1/auth/hooks").await;
    assert_eq!(status, StatusCode::OK, "{hooks}");
    assert_eq!(hooks["beforeCreate"], Value::Null);
    assert_eq!(hooks["forwardIdToken"], false);
    let (status, summary) = get(&api, "/api/v1/auth/summary").await;
    assert_eq!(status, StatusCode::OK, "{summary}");
    assert_eq!(summary["projectId"], PROJECT);
    assert_eq!(summary["users"], 2);
    assert_eq!(summary["tenants"], 1);
    assert_eq!(summary["tenantUsers"], 1);
    assert_eq!(summary["activityCapacity"], 10_000);
    assert_eq!(summary["messageCapacity"], 2_000);
}

#[tokio::test]
async fn the_status_carries_the_summary_and_the_suite_clear_removes_every_user() {
    let api = api();
    people(&api);
    let (_, status) = get(&api, "/api/v1/status").await;
    let auth = status["sections"]
        .as_array()
        .expect("sections")
        .iter()
        .find(|section| section["id"] == "auth")
        .expect("auth")
        .clone();
    assert_eq!(auth["summary"]["headline"], "2 users · 1 tenant");
    assert_eq!(
        auth["summary"]["figures"],
        json!([
            { "label": "users", "value": 2, "unit": "count" },
            { "label": "tenants", "value": 1, "unit": "count" },
            { "label": "tenant users", "value": 1, "unit": "count" },
        ])
    );
    let (status, job) = post(
        &api,
        "/api/v1/suite/clear",
        &json!({ "sections": ["auth"] }),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{job}");
    let job = finished(&api, job["id"].as_str().expect("id")).await;
    assert_eq!(job["state"], "done", "{job}");
    assert_eq!(job["result"][0]["removed"], 3, "{job}");
    let (_, summary) = get(&api, "/api/v1/auth/summary").await;
    assert_eq!(
        (summary["users"].clone(), summary["tenantUsers"].clone()),
        (json!(0), json!(0))
    );
}

// ---------------------------------------------------------------- search

#[tokio::test]
async fn command_k_and_the_pickers_find_users_in_every_tenant() {
    let api = api();
    people(&api);
    let (status, results) = get(&api, "/api/v1/search?q=turing").await;
    assert_eq!(status, StatusCode::OK, "{results}");
    let auth = results["groups"]
        .as_array()
        .expect("groups")
        .iter()
        .find(|group| group["section"] == "auth")
        .expect("the auth group")
        .clone();
    assert_eq!(auth["hits"][0]["kind"], "auth.user");
    assert_eq!(auth["hits"][0]["key"], "acme|t_turing");
    assert_eq!(auth["hits"][0]["title"], "turing@acme.test");
    assert_eq!(auth["hits"][0]["detail"], "t_turing · tenant acme");
    let (_, results) = get(&api, "/api/v1/search?q=u_ada").await;
    let hit = results["groups"]
        .as_array()
        .expect("groups")
        .iter()
        .find(|group| group["section"] == "auth")
        .map(|group| group["hits"][0].clone())
        .expect("hit");
    assert_eq!(hit["key"], "|u_ada");
    assert_eq!(hit["detail"], "u_ada · password");
    let (_, page) = get(&api, "/api/v1/auth/identities?q=example").await;
    assert_eq!(field(&page, "uid"), ["u_ada", "u_grace"]);
    assert_eq!(items(&page)[0]["claims"]["role"], "admin");
    let (_, page) = get(&api, "/api/v1/auth/identities?q=test&tenant=acme").await;
    assert_eq!(field(&page, "uid"), ["t_turing"]);
}

// ---------------------------------------------------------------- bindings and logs

#[test]
fn every_wire_type_is_written_as_auth_and_reads_as_the_console_expects() {
    let directory =
        std::env::temp_dir().join(format!("firenook-auth-bindings-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&directory);
    let config = ts_rs::Config::new().with_out_dir(&directory);
    super::export_bindings(&config);
    let auth = directory.join("auth");
    let mut names = Vec::new();
    for entry in std::fs::read_dir(&auth).expect("generated/auth") {
        let path = entry.expect("entry").path();
        let name = path
            .file_name()
            .expect("name")
            .to_string_lossy()
            .into_owned();
        let text = std::fs::read_to_string(&path).expect("read");
        // A doc comment never closes its own block early.
        for comment in text.split("/**").skip(1) {
            let body = comment.split_once("*/").map_or(comment, |(body, _)| body);
            assert!(!body.contains("*/"), "{name}");
        }
        names.push(name);
    }
    assert!(
        names.iter().all(|name| name.starts_with("Auth")),
        "{names:?}"
    );
    assert!(names.len() >= 70, "{} files", names.len());
    let row = std::fs::read_to_string(auth.join("AuthUserRow.ts")).expect("row");
    assert!(row.contains("uid: string"));
    assert!(row.contains("createdAt: number | null"));
    let page = std::fs::read_to_string(auth.join("AuthUsersPage.ts")).expect("page");
    assert!(page.contains("from \"../Total\""), "{page}");
    let _ = std::fs::remove_dir_all(&directory);
}

/// Keeps every console line.
#[derive(Default)]
struct Lines(std::sync::Mutex<Vec<firenook_suite_front::LogInput>>);

impl firenook_suite_front::ConsoleSink for Lines {
    fn accept(&self, input: firenook_suite_front::LogInput) {
        self.0.lock().expect("lines").push(input);
    }
}

#[tokio::test]
async fn configuration_changes_are_logged_through_the_feeds_logging() {
    let registry = TriggerRegistry::default();
    let (observer, _deliveries) = TriggerObserver::channel(registry.clone());
    let auth = firenook_auth_front::router(PROJECT, observer.queue(), registry);
    let logging = firenook_suite_front::LoggingRuntime::new();
    let lines = std::sync::Arc::new(Lines::default());
    logging.set_console_sink(lines.clone());
    let console = AuthConsole::attach(&auth, false, logging);
    let (stop, receiver) = watch::channel(false);
    let router = console_router(ConsoleServices {
        auth: Some(console.clone()),
        ..ConsoleServices::new(
            crate::tests::directory_services().directory,
            Shutdown::new(receiver),
        )
    });
    let api = Api {
        auth,
        console,
        router,
        stop,
    };
    let (status, body) = post(
        &api,
        "/api/v1/auth/tenants",
        &json!({ "tenantId": "gamma" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let config: Vec<String> = lines
        .0
        .lock()
        .expect("lines")
        .iter()
        .filter(|line| line.kind == Some(firenook_suite_front::kinds::AUTH_CONFIG))
        .map(|line| line.message.clone())
        .collect();
    assert_eq!(config, ["Tenant gamma was created."]);
    let _ = api.stop.send(true);
}

// ---------------------------------------------------------------- bench

/// ⌘K and the users table at 100,000 users: prints the timings recorded in
/// the commit that added the section's API.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "a benchmark: cargo test -p firenook-console-front --release -- --ignored auth_search_bench --nocapture"]
async fn auth_search_bench() {
    use std::sync::atomic::AtomicBool;
    use std::time::Instant;

    use crate::search::SearchSource as _;
    let api = api_with(false);
    api.auth
        .runtime()
        .update(|data| {
            let state = &mut data.agent(PROJECT).project;
            for index in 0..100_000 {
                let mut user = UserRecord::new();
                user.insert(
                    "email".to_owned(),
                    json!(format!("user{index:06}@example.test")),
                );
                user.insert("displayName".to_owned(), json!(format!("User {index}")));
                user.insert(
                    "createdAt".to_owned(),
                    json!((1_790_000_000_000_i64 + index).to_string()),
                );
                state
                    .create_user_with_local_id(&format!("uid-{index:06}"), &user)
                    .expect("created");
            }
        })
        .expect("saved");
    let source = super::search::UserSource {
        runtime: api.console.runtime.clone(),
        project: std::sync::Arc::from(PROJECT),
    };
    let cancel = AtomicBool::new(false);
    let percentile = |mut samples: Vec<Duration>, p: usize| {
        samples.sort();
        samples[(samples.len() * p / 100).min(samples.len() - 1)]
    };
    for (label, text) in [
        ("exact email", "user054321@example.test"),
        ("uid prefix", "uid-0999"),
        ("substring", "r 4321"),
        ("miss", "zzzz"),
    ] {
        let mut samples = Vec::new();
        for _ in 0..50 {
            let started = Instant::now();
            let hits = source.search(text, 5, &cancel);
            samples.push(started.elapsed());
            std::hint::black_box(hits);
        }
        println!(
            "search {label:12} p50 {:?} p95 {:?} p99 {:?}",
            percentile(samples.clone(), 50),
            percentile(samples.clone(), 95),
            percentile(samples, 99)
        );
    }
    for (label, uri) in [
        ("users first page", "/api/v1/auth/users?limit=100"),
        (
            "users by email",
            "/api/v1/auth/users?limit=100&sort=email:asc",
        ),
        (
            "users filtered",
            "/api/v1/auth/users?limit=100&q=email:9999",
        ),
    ] {
        let mut samples = Vec::new();
        for _ in 0..30 {
            let started = Instant::now();
            let (status, _) = get(&api, uri).await;
            samples.push(started.elapsed());
            assert_eq!(status, StatusCode::OK);
        }
        println!(
            "route {label:16} p50 {:?} p95 {:?} p99 {:?}",
            percentile(samples.clone(), 50),
            percentile(samples.clone(), 95),
            percentile(samples, 99)
        );
    }
}
