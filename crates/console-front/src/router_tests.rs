//! The console router as the suite assembles it, every section present:
//! what the request guard lets through and what it refuses.

use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;

use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode, header};
use axum::routing::post;
use firenook_core_store::Store;
use firenook_query_engine::DatabaseEdition;
use firenook_rules_runtime::RulesRuntime;
use firenook_rules_runtime::request_history::RequestHistory;
use firenook_suite_front::ServiceInfo;
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tower::ServiceExt as _;

use super::*;
use crate::tests::running;

const PROJECT: &str = "demo-console";

/// Every Firestore part the suite hands the console, over one store.
pub(crate) fn firestore_console(store: &Store) -> FirestoreConsole {
    let rules = RulesRuntime::with_request_history(RequestHistory::default());
    let schema = SchemaIndex::attach(store, PROJECT);
    let (stop, shutdown) = tokio::sync::watch::channel(false);
    // The Requests feed's history maintainer runs until its owner stops;
    // the test process is that owner.
    std::mem::forget(stop);
    FirestoreConsole {
        rest: firenook_rest_front::router(store.clone()),
        changes: ChangeFeed::attach(store),
        schema: schema.clone(),
        databases: DatabaseCatalog::new(store, PROJECT, Vec::new()),
        explain: QueryExplainer::new(store, PROJECT, DatabaseEdition::Standard, BTreeMap::new()),
        rules: RulesEditor::new(&rules, PROJECT, BTreeMap::new()).with_schema(&schema),
        rules_evaluator: RulesEvaluator::new(&rules, store, PROJECT),
        requests: Some(firenook_suite_front::requests_router(
            rules.request_history(),
            shutdown,
        )),
    }
}

/// A stand-in for the Auth emulator's application: it answers every path,
/// as the real one's fallback handler does.
fn auth_application() -> Router {
    Router::new().fallback(|| async { "auth" })
}

/// A stand-in for a service's own application that answers every path,
/// and says which service it is.
fn native_application(name: &'static str) -> Router {
    Router::new().fallback(move || async move { name })
}

/// Every section present, the late ones already handed over, answering for
/// `hosts`.
pub(crate) fn full_services(store: &Store, hosts: AllowedHosts) -> ConsoleServices {
    let compute = ComputeParts::new();
    compute.late.set(ComputeConsole {
        functions: native_application("functions"),
        eventarc: native_application("eventarc"),
    });
    let pubsub = Late::pending("Pub/Sub");
    pubsub.set(PubsubConsole {
        native: native_application("pubsub"),
    });
    let tasks = Late::pending("Cloud Tasks");
    tasks.set(TasksConsole {
        native: native_application("tasks"),
    });
    ConsoleServices {
        firestore: Some(firestore_console(store)),
        auth: Some(AuthConsole {
            native: auth_application(),
        }),
        storage: Some(StorageConsole {
            native: native_application("storage"),
        }),
        compute: Some(compute),
        pubsub: Some(pubsub),
        tasks: Some(tasks),
        allowed_hosts: hosts,
        ..ConsoleServices::new(
            SuiteDirectory::new(
                PROJECT,
                [
                    ServiceInfo::listening("hub", "127.0.0.1", 34_400),
                    ServiceInfo::listening("firestore", "127.0.0.1", 38_080),
                ],
            )
            .expect("directory"),
            running(),
        )
    }
}

fn router() -> Router {
    console_router(full_services(&Store::default(), AllowedHosts::loopback()))
}

/// Every route path registered on `router`, read from its debug form: axum
/// has no route listing, and its `Debug` prints each path it registered.
/// The test that uses this asserts it found the routes it knows exist, so a
/// change in that form fails loudly instead of passing empty.
fn route_paths(router: &Router) -> BTreeSet<String> {
    let debug = format!("{router:?}");
    let mut paths = BTreeSet::new();
    let mut rest = debug.as_str();
    while let Some(start) = rest.find("RouteId(") {
        rest = &rest[start..];
        let Some(open) = rest.find(": \"") else {
            break;
        };
        let after = &rest[open + 3..];
        let Some(close) = after.find('"') else {
            break;
        };
        paths.insert(after[..close].to_owned());
        rest = &after[close..];
    }
    paths
}

/// A concrete path for a route pattern: every `{parameter}` filled in.
fn concrete(pattern: &str) -> String {
    pattern
        .split('/')
        .map(|segment| {
            if segment.starts_with("{*") {
                "x/y".to_owned()
            } else if segment.contains('{') {
                let mut filled = String::new();
                let mut inside = false;
                for character in segment.chars() {
                    match character {
                        '{' => {
                            inside = true;
                            filled.push('x');
                        }
                        '}' => inside = false,
                        _ if inside => {}
                        _ => filled.push(character),
                    }
                }
                filled
            } else {
                segment.to_owned()
            }
        })
        .collect::<Vec<_>>()
        .join("/")
}

#[tokio::test]
async fn only_live_streams() {
    let router = router();
    let paths = route_paths(&router);
    for known in ["/api/v1/status", "/api/v1/live", "/api/v1/firestore/rules"] {
        assert!(
            paths.contains(known),
            "the route walk missed {known}: {paths:?}"
        );
    }
    assert!(paths.len() > 20, "{paths:?}");
    let mut streams = BTreeSet::new();
    for pattern in &paths {
        let uri = concrete(pattern);
        let response = tokio::time::timeout(
            Duration::from_secs(5),
            router.clone().oneshot(request(
                Method::GET,
                &uri,
                &[("accept", "text/event-stream")],
                "",
            )),
        )
        .await
        .unwrap_or_else(|_| panic!("{uri} answered within 5 s"))
        .expect("response");
        let streaming = response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.starts_with("text/event-stream"));
        if streaming {
            streams.insert(pattern.clone());
        }
    }
    let allowed = BTreeSet::from(["/api/v1/live".to_owned()]);
    assert_eq!(
        streams, allowed,
        "only the live channel streams; a page's live updates are topics on it"
    );
}

async fn send(router: &Router, request: Request<Body>) -> (StatusCode, serde_json::Value) {
    let response = router.clone().oneshot(request).await.expect("response");
    let status = response.status();
    let body = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body");
    (
        status,
        serde_json::from_slice(&body).unwrap_or(serde_json::Value::Null),
    )
}

fn request(method: Method, uri: &str, headers: &[(&str, &str)], body: &str) -> Request<Body> {
    let mut builder = Request::builder().method(method).uri(uri);
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }
    builder.body(Body::from(body.to_owned())).expect("request")
}

const CHECK: &str = "/api/v1/firestore/rules/check";
const DRAFT: &str = r#"{"source":"rules_version = '2';"}"#;

#[tokio::test]
async fn a_change_without_json_or_the_console_header_is_refused() {
    let router = router();
    let (status, body) = send(
        &router,
        request(
            Method::POST,
            CHECK,
            &[("content-type", "text/plain")],
            DRAFT,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::UNSUPPORTED_MEDIA_TYPE, "{body}");
    assert_eq!(body["error"]["code"], "unsupported-media-type");
    assert_eq!(
        body["error"]["message"],
        "Console API changes are sent as JSON."
    );
    let (status, _) = send(
        &router,
        request(
            Method::POST,
            CHECK,
            &[("content-type", "application/json; charset=utf-8")],
            DRAFT,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn a_bodiless_handler_is_covered_and_a_console_token_lets_a_binary_body_through() {
    // A handler that reads no body is exactly what a form on another page
    // could call; the guard covers it without the handler's help.
    let policy = guard::GuardPolicy {
        hosts: AllowedHosts::loopback(),
        natives: Arc::default(),
    };
    let router = Router::new()
        .route("/api/v1/test/action", post(|| async { "done" }))
        .layer(axum::middleware::from_fn_with_state(policy, guard::guard));
    let binary = [("content-type", "application/octet-stream")];
    let (status, _) = send(
        &router,
        request(Method::POST, "/api/v1/test/action", &[], ""),
    )
    .await;
    assert_eq!(status, StatusCode::UNSUPPORTED_MEDIA_TYPE);
    let (status, _) = send(
        &router,
        request(Method::POST, "/api/v1/test/action", &binary, "\u{1}"),
    )
    .await;
    assert_eq!(status, StatusCode::UNSUPPORTED_MEDIA_TYPE);
    for token in ["1", "write", "try", "replay"] {
        let (status, _) = send(
            &router,
            request(
                Method::POST,
                "/api/v1/test/action",
                &[binary[0], (CONSOLE_HEADER, token)],
                "\u{1}",
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{token}");
    }
    for token in ["Bad Token!", "0123456789abcdefg"] {
        let (status, _) = send(
            &router,
            request(
                Method::POST,
                "/api/v1/test/action",
                &[binary[0], (CONSOLE_HEADER, token)],
                "\u{1}",
            ),
        )
        .await;
        assert_eq!(status, StatusCode::UNSUPPORTED_MEDIA_TYPE, "{token}");
    }
}

#[tokio::test]
async fn only_the_console_itself_may_call_the_console_api() {
    let router = router();
    for site in ["cross-site", "same-site"] {
        let (status, body) = send(
            &router,
            request(
                Method::GET,
                "/api/v1/status",
                &[("sec-fetch-site", site)],
                "",
            ),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{site}");
        assert_eq!(body["error"]["code"], "permission-denied");
        assert_eq!(
            body["error"]["message"],
            "Only the console itself can call the Console API."
        );
    }
    for headers in [
        &[("sec-fetch-site", "same-origin")][..],
        &[("sec-fetch-site", "none")],
        &[],
    ] {
        let (status, _) = send(&router, request(Method::GET, "/api/v1/status", headers, "")).await;
        assert_eq!(status, StatusCode::OK, "{headers:?}");
    }
    // The console itself opens from any link: a navigation from another
    // site reaches the shell, never the API.
    let response = router
        .clone()
        .oneshot(request(
            Method::GET,
            "/firestore",
            &[("sec-fetch-site", "cross-site")],
            "",
        ))
        .await
        .expect("response");
    assert_ne!(response.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn native_mounts_keep_their_own_semantics_but_not_a_foreign_host() {
    let router = router();
    let (status, _) = send(
        &router,
        request(
            Method::POST,
            "/api/v1/auth/identitytoolkit.googleapis.com/v1/accounts:signUp",
            &[("sec-fetch-site", "cross-site")],
            "",
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "the Auth application answered");
    let (status, _) = send(
        &router,
        request(
            Method::DELETE,
            "/api/v1/firestore/emulator/v1/projects/demo-console/databases/(default)/documents",
            &[],
            "",
        ),
    )
    .await;
    assert_ne!(status, StatusCode::UNSUPPORTED_MEDIA_TYPE);
    let (status, _) = send(
        &router,
        request(
            Method::POST,
            "/api/v1/auth/x",
            &[("host", "evil.example:4000")],
            "",
        ),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    // Every section's `/native` mount is one too, and each reaches its own
    // service, sandboxed.
    for service in ["storage", "functions", "eventarc", "pubsub", "tasks"] {
        let response = router
            .clone()
            .oneshot(request(
                Method::POST,
                &format!("/api/v1/{service}/native/anything"),
                &[("content-type", "text/plain")],
                "x",
            ))
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::OK, "{service}");
        assert_eq!(
            response.headers()[header::CONTENT_SECURITY_POLICY],
            "sandbox",
            "{service}"
        );
        let body = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body");
        assert_eq!(body, service.as_bytes());
        let (status, _) = send(
            &router,
            request(
                Method::GET,
                &format!("/api/v1/{service}/native/anything"),
                &[("host", "evil.example")],
                "",
            ),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{service}");
    }
    // A section's own routes beside the mount keep the console's rules.
    let (status, _) = send(
        &router,
        request(
            Method::POST,
            "/api/v1/storage/elsewhere",
            &[("content-type", "text/plain")],
            "x",
        ),
    )
    .await;
    assert_eq!(status, StatusCode::UNSUPPORTED_MEDIA_TYPE);
}

#[tokio::test]
async fn only_allowed_hosts_are_answered() {
    let router = router();
    let (status, body) = send(
        &router,
        request(
            Method::GET,
            "/api/v1/status",
            &[("host", "evil.example:4000")],
            "",
        ),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(
        body["error"]["message"],
        "This console does not answer for host evil.example."
    );
    assert_eq!(
        body["error"]["fix"],
        "Start the engine with --allowed-hosts evil.example if you meant to."
    );
    // The shell too: a rebound page gets nothing from this machine.
    let (status, _) = send(
        &router,
        request(Method::GET, "/", &[("host", "evil.example")], ""),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    for host in ["localhost:4000", "127.0.0.1:4000", "[::1]:4000"] {
        let (status, _) = send(
            &router,
            request(Method::GET, "/api/v1/status", &[("host", host)], ""),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{host}");
    }

    let bound = console_router(full_services(
        &Store::default(),
        AllowedHosts::new("192.168.1.20", None::<&str>),
    ));
    let (status, _) = send(
        &bound,
        request(
            Method::GET,
            "/api/v1/status",
            &[("host", "192.168.1.20:4000")],
            "",
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let wildcard = console_router(full_services(
        &Store::default(),
        AllowedHosts::new("0.0.0.0", None::<&str>),
    ));
    let (status, _) = send(
        &wildcard,
        request(
            Method::GET,
            "/api/v1/status",
            &[("host", "my-laptop.local:4000")],
            "",
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
}

/// Serves `router` on a loopback port and sends one raw WebSocket handshake
/// with the `Origin` that `origin` names for the server's address, answering
/// the response's status line.
async fn handshake(
    router: Router,
    path: &str,
    origin: impl FnOnce(std::net::SocketAddr) -> Option<String>,
) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let address = listener.local_addr().expect("address");
    let server = tokio::spawn(async move {
        axum::serve(listener, router).await.expect("serve");
    });
    let mut stream = tokio::net::TcpStream::connect(address)
        .await
        .expect("connect");
    let origin = origin(address).map_or_else(String::new, |origin| format!("Origin: {origin}\r\n"));
    let handshake = format!(
        "GET {path} HTTP/1.1\r\nHost: {address}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\
         Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n{origin}\r\n"
    );
    stream.write_all(handshake.as_bytes()).await.expect("write");
    let mut answer = vec![0_u8; 64];
    let read = tokio::time::timeout(Duration::from_secs(5), stream.read(&mut answer))
        .await
        .expect("an answer")
        .expect("read");
    server.abort();
    let text = String::from_utf8_lossy(&answer[..read]).to_string();
    text.lines().next().unwrap_or_default().to_owned()
}

#[tokio::test]
async fn the_requests_socket_opens_only_from_the_consoles_own_origin() {
    let path = "/api/v1/firestore/requests";
    let foreign = handshake(router(), path, |_| Some("http://evil.example".to_owned())).await;
    assert!(foreign.starts_with("HTTP/1.1 403"), "{foreign}");
    let missing = handshake(router(), path, |_| None).await;
    assert!(missing.starts_with("HTTP/1.1 403"), "{missing}");
    let own = handshake(router(), path, |address| Some(format!("http://{address}"))).await;
    assert!(own.starts_with("HTTP/1.1 101"), "{own}");
}

#[tokio::test]
async fn the_live_stream_opens_only_from_the_consoles_own_origin() {
    let router = router();
    let refused = [
        &[("origin", "http://evil.example")][..],
        &[("sec-fetch-site", "cross-site")],
        &[
            ("host", "127.0.0.1:4000"),
            ("origin", "http://localhost:4000"),
        ],
    ];
    for headers in refused {
        let response = router
            .clone()
            .oneshot(request(Method::GET, "/api/v1/live", headers, ""))
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::FORBIDDEN, "{headers:?}");
    }
    let allowed = [
        &[
            ("host", "127.0.0.1:4000"),
            ("origin", "http://127.0.0.1:4000"),
        ][..],
        // A same-origin EventSource names no Origin at all.
        &[
            ("host", "127.0.0.1:4000"),
            ("sec-fetch-site", "same-origin"),
        ],
        // A development proxy rewrote the Host; the browser attests the rest.
        &[
            ("host", "127.0.0.1:4000"),
            ("origin", "http://localhost:5173"),
            ("sec-fetch-site", "same-origin"),
        ],
    ];
    for headers in allowed {
        let response = router
            .clone()
            .oneshot(request(Method::GET, "/api/v1/live", headers, ""))
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::OK, "{headers:?}");
    }
}

#[tokio::test]
async fn firestore_changes_and_rules_ride_the_live_channel_until_the_suite_stops() {
    let store = Store::default();
    let (stop, shutdown) = tokio::sync::watch::channel(false);
    let router = console_router(ConsoleServices {
        shutdown: Shutdown::new(shutdown),
        ..full_services(&store, AllowedHosts::loopback())
    });
    let response = router
        .clone()
        .oneshot(request(Method::GET, "/api/v1/live", &[], ""))
        .await
        .expect("response");
    assert_eq!(
        response.headers()[header::CONTENT_TYPE],
        "text/event-stream"
    );
    let mut body = response.into_body().into_data_stream();
    let mut seen = String::new();
    let mut read_until = async |pattern: &str, seen: &mut String| {
        tokio::time::timeout(Duration::from_secs(5), async {
            while !seen.contains(pattern) {
                let chunk = body.next().await.expect("a chunk").expect("bytes");
                seen.push_str(&String::from_utf8_lossy(&chunk));
            }
        })
        .await
        .unwrap_or_else(|_| panic!("{pattern:?} never arrived: {seen}"));
    };
    read_until("event: hello", &mut seen).await;
    read_until("\n\n", &mut seen).await;
    let hello: serde_json::Value = serde_json::from_str(
        seen.lines()
            .find_map(|line| line.strip_prefix("data: "))
            .expect("hello data"),
    )
    .expect("json");
    let connection = hello["connection"].as_str().expect("connection");
    let (status, answer) = send(
        &router,
        request(
            Method::POST,
            &format!("/api/v1/live/{connection}/subscriptions"),
            &[("content-type", "application/json")],
            &serde_json::json!({ "add": [
                { "id": "t1.s1", "topic": "firestore.changes", "params": { "scope": "users" } },
                { "id": "t1.s2", "topic": "firestore.rules", "params": {} },
            ] })
            .to_string(),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    assert_eq!(answer["accepted"], serde_json::json!(["t1.s1", "t1.s2"]));
    read_until(r#""sub":"t1.s2","name":"file""#, &mut seen).await;
    read_until(r#""sub":"t1.s1","name":"tick""#, &mut seen).await;
    store
        .commit(&[firenook_core_store::Write::Create {
            key: firenook_core_store::DocumentKey::new(
                firenook_core_store::DatabaseName::new(PROJECT, "(default)").expect("database"),
                "users/u1",
            )
            .expect("key"),
            fields: firenook_core_store::Fields::new(),
        }])
        .expect("commit");
    read_until(r#""path":"users/u1","kind":"created""#, &mut seen).await;
    assert!(seen.contains(r#""sub":"t1.s1","name":"change""#), "{seen}");

    // The stop signal ends the one stream both topics ride, after saying
    // so, so a console tab never holds the engine's shutdown open.
    stop.send(true).expect("the stream is listening");
    read_until("event: stopping", &mut seen).await;
    tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(chunk) = body.next().await {
            chunk.expect("bytes");
        }
    })
    .await
    .expect("the stream ended after shutdown");
}

#[test]
fn the_header_family_has_one_spelling() {
    let names = [
        CONSOLE_HEADER,
        ACTIVITY_HEADER,
        EXECUTION_HEADER,
        METADATA_HEADER,
        KEEP_TOKENS_HEADER,
        PREVIEW_HEADER,
    ];
    for name in names {
        assert!(name.starts_with("x-firenook-"), "{name}");
        assert_eq!(header::HeaderName::from_static(name).as_str(), name);
    }
    assert!(CAUSE_HEADER_PREFIX.starts_with("x-firenook-cause-"));
}
