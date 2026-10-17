//! `singleProjectMode`: the official Auth emulator warns once per foreign
//! project id it is asked about ("Multiple projectIds are not recommended in
//! single project mode") and keeps serving; Firenook applies the same warning
//! to every request whose project is another one, on every front an app
//! talks to: Auth, Firestore (REST, `WebChannel` and gRPC), Pub/Sub (HTTP and
//! gRPC) and Cloud Tasks. Each foreign id is also recorded in the console's
//! [`ForeignProjects`], which is how the console can say why it looks empty
//! when the app is configured with another project. With
//! `singleProjectMode: false` nothing is logged or recorded. The data plane
//! is multi-project either way.

use std::borrow::Cow;
use std::collections::BTreeSet;
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::extract::Request;
use axum::middleware::{self, Next};
use axum::response::Response;
use firenook_console_front::ForeignProjects;
use firenook_suite_front::LoggingRuntime;

use crate::SuiteConfig;

#[derive(Clone)]
struct Scope {
    configured: Arc<str>,
    logging: LoggingRuntime,
    foreign: ForeignProjects,
    /// `auth`, `firestore`, `pubsub` or `tasks`, as the console names it.
    service: &'static str,
    warned: Arc<Mutex<BTreeSet<String>>>,
    enabled: bool,
}

/// Wraps one front's HTTP router (`service` names it in the console) with
/// the warning and the recorder.
pub(crate) fn apply(
    router: Router,
    config: &SuiteConfig,
    logging: &LoggingRuntime,
    foreign: &ForeignProjects,
    service: &'static str,
) -> Router {
    let scope = Scope {
        configured: config.project_id.as_str().into(),
        logging: logging.clone(),
        foreign: foreign.clone(),
        service,
        warned: Arc::new(Mutex::new(BTreeSet::new())),
        enabled: config.single_project_mode,
    };
    router.layer(middleware::from_fn_with_state(scope, warn))
}

/// [`apply`] for a port that serves gRPC beside HTTP (Firestore, Pub/Sub).
pub(crate) fn apply_routes(
    routes: tonic::service::Routes,
    config: &SuiteConfig,
    logging: &LoggingRuntime,
    foreign: &ForeignProjects,
    service: &'static str,
) -> tonic::service::Routes {
    tonic::service::Routes::from(apply(
        routes.into_axum_router(),
        config,
        logging,
        foreign,
        service,
    ))
}

async fn warn(
    axum::extract::State(scope): axum::extract::State<Scope>,
    request: Request,
    next: Next,
) -> Response {
    if scope.enabled
        && let Some(project) = requested_project(&request)
        && project != scope.configured.as_ref()
    {
        scope.foreign.record(&project, scope.service);
        let first = scope
            .warned
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(project.clone().into_owned());
        if first {
            let message = format!(
                "Multiple projectIds are not recommended in single project mode. Requested project ID {project}, but the emulator is configured for {}. To opt-out of single project mode add/set the '\"singleProjectMode\": false' property in the firebase.json emulators config.",
                scope.configured
            );
            crate::terminal::print(
                "WARN",
                "firenook",
                &message,
                &format!("firenook: {message}"),
            );
            scope.logging.record("WARN", Some("hub"), message);
        }
    }
    next.run(request).await
}

/// The project a request names, wherever its protocol puts it: the
/// `projects/{id}` segment of the path (REST, Pub/Sub HTTP, Cloud Tasks),
/// the `database` query parameter (`WebChannel`), the
/// `google-cloud-resource-prefix` metadata the SDKs send with every gRPC
/// call (Firestore), or a resource in `x-goog-request-params` (Pub/Sub
/// gRPC).
fn requested_project(request: &Request) -> Option<Cow<'_, str>> {
    let uri = request.uri();
    if let Some(project) = project_in_path(uri.path()) {
        return Some(Cow::Borrowed(project));
    }
    if let Some(database) = uri
        .query()
        .into_iter()
        .flat_map(|query| query.split('&'))
        .find_map(|pair| {
            pair.split_once('=')
                .filter(|(name, _)| *name == "database")
                .map(|(_, value)| percent_decode(value))
        })
        && let Some(project) = project_in_path(&database)
    {
        return Some(Cow::Owned(project.to_owned()));
    }
    let header = |name: &str| {
        request
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
    };
    if let Some(project) = header("google-cloud-resource-prefix").and_then(project_in_path) {
        return Some(Cow::Borrowed(project));
    }
    header("x-goog-request-params")
        .into_iter()
        .flat_map(|params| params.split('&'))
        .filter_map(|pair| pair.split_once('=').map(|(_, value)| percent_decode(value)))
        .find_map(|value| project_in_path(&value).map(str::to_owned))
        .map(Cow::Owned)
}

/// `%2F` and friends decoded; a malformed escape is kept as typed.
fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        let hex = |at: usize| {
            bytes
                .get(at)
                .and_then(|byte| char::from(*byte).to_digit(16))
        };
        match (bytes[index], hex(index + 1), hex(index + 2)) {
            (b'%', Some(high), Some(low)) => {
                // Two hex digits make one byte.
                #[allow(clippy::cast_possible_truncation)]
                decoded.push((high * 16 + low) as u8);
                index += 3;
            }
            (b'+', _, _) => {
                decoded.push(b' ');
                index += 1;
            }
            (byte, _, _) => {
                decoded.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

/// The `projects/{id}` segment of an emulator REST path, if any.
pub(crate) fn project_in_path(path: &str) -> Option<&str> {
    let mut segments = path.split('/').filter(|segment| !segment.is_empty());
    while let Some(segment) = segments.next() {
        if segment == "projects" {
            return segments
                .next()
                .map(|project| project.split_once(':').map_or(project, |(id, _)| id))
                .filter(|project| !project.is_empty());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use axum::routing::any;
    use tower::ServiceExt as _;

    use super::*;
    use crate::diagnostics_tests::test_config;

    #[test]
    fn project_segments_are_found_in_auth_and_firestore_paths() {
        assert_eq!(
            project_in_path("/v1/projects/demo-a/databases/(default)/documents/x"),
            Some("demo-a")
        );
        assert_eq!(
            project_in_path("/identitytoolkit.googleapis.com/v1/projects/other/accounts:query"),
            Some("other")
        );
        assert_eq!(
            project_in_path("/emulator/v1/projects/demo-a:securityRules"),
            Some("demo-a")
        );
        assert_eq!(
            project_in_path("/identitytoolkit.googleapis.com/v1/accounts:signUp"),
            None
        );
        assert_eq!(project_in_path("/v1/projects/"), None);
    }

    fn router(foreign: &ForeignProjects, service: &'static str, enabled: bool) -> Router {
        let config = SuiteConfig {
            single_project_mode: enabled,
            ..test_config()
        };
        apply(
            Router::new().fallback(any(|| async { "served" })),
            &config,
            &LoggingRuntime::new(),
            foreign,
            service,
        )
    }

    async fn call(router: &Router, request: Request) {
        let response = router.clone().oneshot(request).await.expect("response");
        assert_eq!(response.status(), axum::http::StatusCode::OK);
    }

    #[tokio::test]
    async fn every_front_records_the_foreign_project_its_protocol_names() {
        let foreign = ForeignProjects::default();
        let get = |uri: &str| Request::get(uri).body(Body::empty()).expect("request");
        // Auth and Firestore REST: the path.
        call(
            &router(&foreign, "auth", true),
            get("/identitytoolkit.googleapis.com/v1/projects/auth-prod/accounts:query"),
        )
        .await;
        call(
            &router(&foreign, "firestore", true),
            get("/v1/projects/rest-prod/databases/(default)/documents/items/a"),
        )
        .await;
        // WebChannel: the database query parameter.
        call(
            &router(&foreign, "firestore", true),
            get("/google.firestore.v1.Firestore/Listen/channel?VER=8&database=projects%2Fchannel-prod%2Fdatabases%2F(default)&RID=1"),
        )
        .await;
        // gRPC: the resource prefix every SDK call carries.
        call(
            &router(&foreign, "firestore", true),
            Request::post("/google.firestore.v1.Firestore/Commit")
                .header(
                    "google-cloud-resource-prefix",
                    "projects/grpc-prod/databases/(default)",
                )
                .body(Body::empty())
                .expect("request"),
        )
        .await;
        // Pub/Sub over HTTP (the path) and gRPC (the routing header).
        call(
            &router(&foreign, "pubsub", true),
            Request::post("/v1/projects/http-prod/topics/orders:publish")
                .body(Body::empty())
                .expect("request"),
        )
        .await;
        call(
            &router(&foreign, "pubsub", true),
            Request::post("/google.pubsub.v1.Publisher/Publish")
                .header(
                    "x-goog-request-params",
                    "topic=projects%2Fgrpc-pubsub%2Ftopics%2Forders",
                )
                .body(Body::empty())
                .expect("request"),
        )
        .await;
        // Cloud Tasks: the path.
        call(
            &router(&foreign, "tasks", true),
            get("/v2/projects/tasks-prod/locations/us-central1/queues/q/tasks"),
        )
        .await;
        // The configured project, and a request naming none, are not foreign.
        call(
            &router(&foreign, "firestore", true),
            get("/v1/projects/demo-diagnostics/databases/(default)/documents/items/a"),
        )
        .await;
        call(&router(&foreign, "auth", true), get("/emulator/v1/config")).await;
        let mut recorded: Vec<(String, Vec<String>)> = foreign
            .snapshot()
            .into_iter()
            .map(|project| (project.project_id, project.services))
            .collect();
        recorded.sort();
        let service = |name: &str| vec![name.to_owned()];
        assert_eq!(
            recorded,
            [
                ("auth-prod".to_owned(), service("auth")),
                ("channel-prod".to_owned(), service("firestore")),
                ("grpc-prod".to_owned(), service("firestore")),
                ("grpc-pubsub".to_owned(), service("pubsub")),
                ("http-prod".to_owned(), service("pubsub")),
                ("rest-prod".to_owned(), service("firestore")),
                ("tasks-prod".to_owned(), service("tasks")),
            ]
        );
        assert_eq!(foreign.count(), 7);
    }

    #[tokio::test]
    async fn single_project_mode_off_records_nothing() {
        let foreign = ForeignProjects::default();
        call(
            &router(&foreign, "firestore", false),
            Request::get("/v1/projects/other/databases/(default)/documents/a")
                .body(Body::empty())
                .expect("request"),
        )
        .await;
        assert_eq!(foreign.count(), 0);
    }

    #[test]
    fn escapes_are_decoded_and_malformed_ones_kept() {
        assert_eq!(
            percent_decode("projects%2Fa%2Fdatabases"),
            "projects/a/databases"
        );
        assert_eq!(percent_decode("a+b%zz%2"), "a b%zz%2");
    }
}
