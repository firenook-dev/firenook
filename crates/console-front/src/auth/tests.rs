use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode};
use firenook_auth_front::state::{Scope, UserRecord};
use firenook_auth_front::token::parse_id_token;
use firenook_auth_front::{AuthRuntime, BlockingFunctions, BlockingResolver};
use firenook_functions_bridge::{TriggerObserver, TriggerRegistry};
use serde_json::{Value, json};
use tower::ServiceExt as _;

use crate::{ConsoleServices, console_router};

const PROJECT: &str = "demo-console";

/// Counts every time the Auth emulator looks for its blocking functions.
struct CountingResolver(Arc<AtomicUsize>);

impl BlockingResolver for CountingResolver {
    fn resolve(&self) -> Pin<Box<dyn Future<Output = BlockingFunctions> + Send + '_>> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { BlockingFunctions::default() })
    }
}

struct Fixture {
    auth: AuthRuntime,
    router: axum::Router,
    blocking: Arc<AtomicUsize>,
}

fn fixture() -> Fixture {
    let registry = TriggerRegistry::default();
    let (observer, _deliveries) = TriggerObserver::channel(registry.clone());
    let auth = firenook_auth_front::router(PROJECT, observer.queue(), registry);
    let blocking = Arc::new(AtomicUsize::new(0));
    auth.set_blocking_functions(Arc::new(CountingResolver(Arc::clone(&blocking))));
    let router = console_router(ConsoleServices {
        auth: Some(crate::AuthConsole::attach(
            &auth,
            true,
            firenook_suite_front::LoggingRuntime::new(),
        )),
        ..crate::tests::directory_services()
    });
    Fixture {
        auth,
        router,
        blocking,
    }
}

/// Creates an account straight in the emulator's state.
fn add(fixture: &Fixture, tenant: Option<&str>, uid: &str, fields: &Value) {
    let props: UserRecord = fields.as_object().cloned().unwrap_or_default();
    fixture
        .auth
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

async fn get(fixture: &Fixture, uri: &str) -> (StatusCode, Value) {
    let response = fixture
        .router
        .clone()
        .oneshot(Request::get(uri).body(Body::empty()).expect("request"))
        .await
        .expect("response");
    let status = response.status();
    let body = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body");
    (status, serde_json::from_slice(&body).unwrap_or(Value::Null))
}

async fn post(fixture: &Fixture, uri: &str, body: &Value) -> (StatusCode, Value) {
    let response = fixture
        .router
        .clone()
        .oneshot(
            Request::post(uri)
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .expect("request"),
        )
        .await
        .expect("response");
    let status = response.status();
    let body = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body");
    (status, serde_json::from_slice(&body).unwrap_or(Value::Null))
}

fn uids(page: &Value) -> Vec<String> {
    page["items"]
        .as_array()
        .expect("items")
        .iter()
        .map(|item| item["uid"].as_str().expect("uid").to_owned())
        .collect()
}

/// Ada in the project, Ada in tenant acme, and Grace.
fn people() -> Fixture {
    let fixture = fixture();
    add(
        &fixture,
        None,
        "u_ada",
        &json!({
            "email": "ada@example.test",
            "displayName": "Ada Lovelace",
            "emailVerified": true,
            "customAttributes": "{\"role\":\"admin\"}",
            "providerUserInfo": [
                { "providerId": "password", "email": "ada@example.test", "rawId": "ada@example.test" },
                { "providerId": "google.com", "rawId": "g-1" },
            ],
        }),
    );
    add(
        &fixture,
        None,
        "u_grace",
        &json!({ "email": "grace@example.test", "disabled": true }),
    );
    add(
        &fixture,
        Some("acme"),
        "t_ada",
        &json!({ "email": "ada@acme.test" }),
    );
    fixture
}

#[tokio::test]
async fn identities_search_the_project_and_every_tenant_with_every_field() {
    let fixture = people();
    let (status, page) = get(&fixture, "/api/v1/auth/identities?q=ada").await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert_eq!(uids(&page), ["u_ada", "t_ada"]);
    assert_eq!(page["items"][1]["tenant"], "acme");
    let ada = &page["items"][0];
    assert_eq!(
        *ada,
        json!({
            "uid": "u_ada",
            "tenant": null,
            "email": "ada@example.test",
            "displayName": "Ada Lovelace",
            "disabled": false,
            "emailVerified": true,
            "providers": stored_providers(&fixture, "u_ada"),
            "claims": { "role": "admin" },
        })
    );
    let mut providers = stored_providers(&fixture, "u_ada");
    providers.sort();
    assert_eq!(providers, ["google.com", "password"]);
    assert_eq!(page["scanned"], Value::Null);
    let (_, page) = get(&fixture, "/api/v1/auth/identities?q=ada&tenant=").await;
    assert_eq!(
        uids(&page),
        ["u_ada"],
        "tenant= is the project's users only"
    );
    let (_, page) = get(&fixture, "/api/v1/auth/identities?q=ada&tenant=acme").await;
    assert_eq!(uids(&page), ["t_ada"]);
    let (status, body) = get(&fixture, "/api/v1/auth/identities?q=ada&tenant=nope").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(
        body["error"]["message"],
        "This project has no tenant named nope."
    );
    let (_, page) = get(&fixture, "/api/v1/auth/identities?q=GRACE").await;
    assert_eq!(page["items"][0]["disabled"], true);
    assert_eq!(page["items"][0]["claims"], Value::Null);
    // No text: the first users by uid, the project's first.
    let (_, page) = get(&fixture, "/api/v1/auth/identities?limit=2").await;
    assert_eq!(uids(&page), ["u_ada", "u_grace"]);
    let (_, page) = get(&fixture, "/api/v1/auth/identities").await;
    assert_eq!(uids(&page), ["u_ada", "u_grace", "t_ada"]);
    // Another project: nobody there.
    let (_, page) = get(&fixture, "/api/v1/auth/identities?project=my-prod").await;
    assert_eq!(uids(&page), Vec::<String>::new());
    let (status, _) = get(&fixture, "/api/v1/auth/identities?sort=uid").await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "unknown parameters are refused"
    );
}

#[tokio::test]
async fn a_substring_search_stops_at_its_budget_and_says_how_far_it_got() {
    let fixture = fixture();
    fixture
        .auth
        .runtime()
        .update(|data| {
            let agent = data.agent(PROJECT);
            for index in 0..20_100 {
                let props: UserRecord = json!({ "email": format!("person{index}@example.test") })
                    .as_object()
                    .cloned()
                    .unwrap_or_default();
                agent
                    .project
                    .create_user_with_local_id(&format!("u{index:05}"), &props)
                    .expect("created");
            }
        })
        .expect("saved");
    let (status, page) = get(&fixture, "/api/v1/auth/identities?q=nobody").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(page["items"], json!([]));
    assert_eq!(page["scanned"], 20_000);
    assert_eq!(page["total"], json!({ "count": 0, "exact": false }));
}

#[tokio::test]
async fn the_emulators_own_query_still_refuses_a_limit() {
    let fixture = people();
    let response = fixture
        .router
        .clone()
        .oneshot(
            Request::post(format!(
                "/api/v1/auth/identitytoolkit.googleapis.com/v1/projects/{PROJECT}/accounts:query"
            ))
            .header("authorization", "Bearer owner")
            .header("content-type", "application/json")
            .body(Body::from(r#"{"limit":"2"}"#))
            .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::NOT_IMPLEMENTED);
}

fn parsed(fixture: &Fixture, tenant: Option<&str>, token: &str) -> (Value, String) {
    fixture
        .auth
        .runtime()
        .update(|data| {
            let agent = data.projects.get_mut(PROJECT).expect("project");
            let scope = Scope::new_in(agent, PROJECT, tenant);
            let parsed = parse_id_token(&scope, token).expect("the emulator accepts its token");
            (Value::Object(parsed.payload), parsed.sign_in_provider)
        })
        .expect("read")
}

/// The providers as the emulator keeps them on the account, in its order.
fn stored_providers(fixture: &Fixture, uid: &str) -> Vec<String> {
    fixture.auth.runtime().read(|data| {
        firenook_auth_front::state::provider_infos(&data.projects[PROJECT].project.users[uid])
            .iter()
            .filter_map(|info| {
                info.get("providerId")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
            .collect()
    })
}

fn last_login(fixture: &Fixture, uid: &str) -> Value {
    fixture.auth.runtime().read(|data| {
        let agent = &data.projects[PROJECT];
        agent
            .project
            .users
            .get(uid)
            .or_else(|| agent.tenants["acme"].project.users.get(uid))
            .and_then(|user| user.get("lastLoginAt").cloned())
            .unwrap_or(Value::Null)
    })
}

#[tokio::test]
async fn a_token_is_the_emulators_own_with_no_sign_in_recorded() {
    let fixture = people();
    let before = last_login(&fixture, "u_ada");
    let (status, token) = post(&fixture, "/api/v1/auth/tokens", &json!({ "uid": "u_ada" })).await;
    assert_eq!(status, StatusCode::OK, "{token}");
    let id_token = token["idToken"].as_str().expect("token");
    let (claims, provider) = parsed(&fixture, None, id_token);
    assert_eq!(claims["user_id"], "u_ada");
    assert_eq!(claims["role"], "admin", "custom claims are in the token");
    assert_eq!(claims["email"], "ada@example.test");
    assert_eq!(
        provider,
        stored_providers(&fixture, "u_ada")[0],
        "the account's first provider"
    );
    let exp = claims["exp"].as_i64().expect("exp");
    let expires = time::OffsetDateTime::parse(
        token["expiresAt"].as_str().expect("expiresAt"),
        &time::format_description::well_known::Rfc3339,
    )
    .expect("RFC 3339");
    assert_eq!(expires.unix_timestamp(), exp);
    assert_eq!(last_login(&fixture, "u_ada"), before, "no sign-in recorded");
    // The blocking functions are looked up once, to say whether a real
    // sign-in would call beforeSignIn; none is called.
    assert!(
        fixture.blocking.load(Ordering::SeqCst) <= 1,
        "looked up at most once"
    );
    assert!(
        token["beforeSignIn"].is_null(),
        "no blocking function ran: {token}"
    );
    // A tenant's user.
    let (status, token) = post(
        &fixture,
        "/api/v1/auth/tokens",
        &json!({ "uid": "t_ada", "tenant": "acme" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{token}");
    let (claims, _) = parsed(
        &fixture,
        Some("acme"),
        token["idToken"].as_str().expect("token"),
    );
    assert_eq!(claims["firebase"]["tenant"], "acme");
    assert_eq!(claims["user_id"], "t_ada");
}

#[tokio::test]
async fn a_token_for_nobody_is_not_found_and_the_body_is_checked() {
    let fixture = people();
    let (status, body) = post(&fixture, "/api/v1/auth/tokens", &json!({ "uid": "nobody" })).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(
        body["error"]["message"],
        "The Auth emulator has no user nobody in this project."
    );
    let (status, _) = post(
        &fixture,
        "/api/v1/auth/tokens",
        &json!({ "uid": "u_ada", "tenant": "acme" }),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "u_ada is not acme's");
    let (status, _) = post(
        &fixture,
        "/api/v1/auth/tokens",
        &json!({ "uid": "u_ada", "tenant": "nope" }),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, body) = post(
        &fixture,
        "/api/v1/auth/tokens",
        &json!({ "uid": "u_ada", "nonsense": {} }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(body["error"]["code"], "invalid-argument");
    // The tenant a lookup named was not created.
    let tenants: Vec<String> = fixture
        .auth
        .runtime()
        .read(|data| data.projects[PROJECT].tenants.keys().cloned().collect());
    assert_eq!(tenants, ["acme"]);
}

#[tokio::test]
async fn the_guard_treats_identities_and_tokens_as_console_routes() {
    let fixture = people();
    let response = fixture
        .router
        .clone()
        .oneshot(
            Request::get("/api/v1/auth/identities?q=ada")
                .header("sec-fetch-site", "cross-site")
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let response = fixture
        .router
        .clone()
        .oneshot(
            Request::post("/api/v1/auth/tokens")
                .header("content-type", "text/plain")
                .body(Body::from(r#"{"uid":"u_ada"}"#))
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
    // The emulator's own paths keep their semantics.
    let response = fixture
        .router
        .clone()
        .oneshot(
            Request::post(
                "/api/v1/auth/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake",
            )
            .header("sec-fetch-site", "cross-site")
            .header("content-type", "application/json")
            .body(Body::from("{}"))
            .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::OK);
}
