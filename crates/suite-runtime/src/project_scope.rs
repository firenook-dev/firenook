//! `singleProjectMode`: the official Auth emulator warns once per foreign
//! project id it is asked about ("Multiple projectIds are not recommended in
//! single project mode") and keeps serving; Fireside applies the same warning
//! to every Auth and Firestore HTTP request whose path names another project.
//! With `singleProjectMode: false` nothing is logged. The data plane is
//! multi-project either way.

use std::collections::BTreeSet;
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::extract::Request;
use axum::middleware::{self, Next};
use axum::response::Response;
use fireside_suite_front::LoggingRuntime;

use crate::SuiteConfig;

#[derive(Clone)]
struct Scope {
    configured: Arc<str>,
    logging: LoggingRuntime,
    warned: Arc<Mutex<BTreeSet<String>>>,
    enabled: bool,
}

/// Wraps an Auth or Firestore HTTP router with the warning.
pub(crate) fn apply(router: Router, config: &SuiteConfig, logging: &LoggingRuntime) -> Router {
    let scope = Scope {
        configured: config.project_id.as_str().into(),
        logging: logging.clone(),
        warned: Arc::new(Mutex::new(BTreeSet::new())),
        enabled: config.single_project_mode,
    };
    router.layer(middleware::from_fn_with_state(scope, warn))
}

async fn warn(
    axum::extract::State(scope): axum::extract::State<Scope>,
    request: Request,
    next: Next,
) -> Response {
    if scope.enabled
        && let Some(project) = project_in_path(request.uri().path())
        && project != scope.configured.as_ref()
    {
        let first = scope
            .warned
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(project.to_owned());
        if first {
            let message = format!(
                "Multiple projectIds are not recommended in single project mode. Requested project ID {project}, but the emulator is configured for {}. To opt-out of single project mode add/set the '\"singleProjectMode\": false' property in the firebase.json emulators config.",
                scope.configured
            );
            eprintln!("fireside: {message}");
            scope.logging.record("WARN", Some("hub"), message);
        }
    }
    next.run(request).await
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
    use super::project_in_path;

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
}
