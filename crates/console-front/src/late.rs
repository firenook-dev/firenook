//! Services the suite starts after the console is already serving.
//!
//! Functions take seconds to discover, and Pub/Sub and Cloud Tasks are
//! built after them, but the console page loads at once. A [`Late`] lets a
//! section's routes and topics exist from the first request: they answer
//! `503 starting` until the suite hands the running service over, and then
//! serve it, so a page opened while Functions start begins working the
//! moment they are up.

use std::sync::Arc;

use axum::Router;
use axum::extract::Request;
use axum::response::IntoResponse;
use tokio::sync::watch;
use tower::ServiceExt as _;

use crate::api_error::ApiError;
use crate::http::forwarded;
use crate::sse::Shutdown;

/// A service the suite starts after the console is already serving: its
/// routes and topics exist from the first request and answer `starting`
/// until the runtime is handed over.
#[derive(Clone)]
pub struct Late<T: Clone + Send + Sync + 'static> {
    label: &'static str,
    cell: Arc<watch::Sender<Option<T>>>,
}

impl<T: Clone + Send + Sync + 'static> Late<T> {
    /// Not started yet; `label` names it in messages ("Functions").
    #[must_use]
    pub fn pending(label: &'static str) -> Self {
        Self {
            label,
            cell: Arc::new(watch::Sender::new(None)),
        }
    }

    /// Hands the running service over. Later calls replace it (a reload).
    pub fn set(&self, value: T) {
        self.cell.send_replace(Some(value));
    }

    /// The service, or `ApiError::starting(label)`.
    pub fn get(&self) -> Result<T, ApiError> {
        self.cell
            .borrow()
            .clone()
            .ok_or_else(|| ApiError::starting(self.label))
    }

    /// Whether the service has been handed over.
    #[must_use]
    pub fn is_ready(&self) -> bool {
        self.cell.borrow().is_some()
    }

    /// What messages call the service.
    #[must_use]
    pub const fn label(&self) -> &'static str {
        self.label
    }

    /// Waits for the service; `None` when the suite stopped first.
    pub async fn wait(&self, shutdown: Shutdown) -> Option<T> {
        let mut changes = self.cell.subscribe();
        let ready = changes.wait_for(Option::is_some);
        tokio::select! {
            biased;
            () = shutdown.stopped() => None,
            value = ready => value.ok().and_then(|value| value.clone()),
        }
    }

    /// Ticks whenever the service is set (for the shell's status).
    #[must_use]
    pub fn changes(&self) -> watch::Receiver<Option<T>> {
        self.cell.subscribe()
    }
}

/// A native application mounted under the console for a late service:
/// every request answers 503 `starting` until it is set, then reaches the
/// router `pick` returns, prefix stripped, through [`forwarded`] (sandboxed
/// responses and `x-forwarded-*` naming `prefix`, the mount's full path).
pub(crate) fn late_native<T: Clone + Send + Sync + 'static>(
    late: Late<T>,
    prefix: &'static str,
    pick: fn(&T) -> Router,
) -> Router {
    let reach = move |request: Request| {
        let late = late.clone();
        async move {
            match late.get() {
                Ok(service) => match pick(&service).oneshot(request).await {
                    Ok(response) => response,
                    Err(never) => match never {},
                },
                Err(error) => error.into_response(),
            }
        }
    };
    forwarded(Router::new().fallback(reach), prefix)
}

#[cfg(test)]
mod tests {
    use axum::body::{Body, to_bytes};
    use axum::http::{StatusCode, header};
    use axum::routing::get;

    use super::*;
    use crate::api_error::ErrorCode;
    use crate::tests::running;

    #[tokio::test]
    async fn get_before_set_is_starting_with_the_label_and_wait_resolves_on_set() {
        let late: Late<u32> = Late::pending("Functions");
        assert!(!late.is_ready());
        let error = late.get().expect_err("not yet");
        assert_eq!(error.detail().code, ErrorCode::Starting);
        assert_eq!(error.detail().message, "Functions is still starting.");
        let waiting = tokio::spawn({
            let late = late.clone();
            async move { late.wait(running()).await }
        });
        let mut changes = late.changes();
        tokio::task::yield_now().await;
        late.set(7);
        assert_eq!(waiting.await.expect("joined"), Some(7));
        assert!(late.is_ready());
        assert_eq!(late.get().expect("set"), 7);
        changes.changed().await.expect("ticked");
        assert_eq!(*changes.borrow(), Some(7));
        // A reload replaces the service.
        late.set(8);
        assert_eq!(late.get().expect("replaced"), 8);
    }

    #[tokio::test]
    async fn wait_returns_none_when_the_suite_stops_first() {
        let late: Late<u32> = Late::pending("Pub/Sub");
        let (stop, receiver) = watch::channel(false);
        let waiting = tokio::spawn({
            let late = late.clone();
            async move { late.wait(Shutdown::new(receiver)).await }
        });
        tokio::task::yield_now().await;
        stop.send(true).expect("sent");
        assert_eq!(waiting.await.expect("joined"), None);
    }

    #[tokio::test]
    async fn a_late_native_mount_answers_starting_then_forwards_with_the_prefix_stripped() {
        #[derive(Clone)]
        struct Service(&'static str);
        let late: Late<Service> = Late::pending("Cloud Tasks");
        let mounted = Router::new().nest_service(
            "/tasks/native",
            late_native(late.clone(), "/console/api/v1/tasks/native", |service| {
                let name = service.0;
                Router::new().route(
                    "/v2/queues",
                    get(move |request: Request| async move {
                        let prefix = request
                            .headers()
                            .get("x-forwarded-prefix")
                            .and_then(|value| value.to_str().ok())
                            .unwrap_or_default()
                            .to_owned();
                        format!("{name} {} {prefix}", request.uri().path())
                    }),
                )
            }),
        );
        let call = || async {
            let response = mounted
                .clone()
                .oneshot(
                    Request::get("/tasks/native/v2/queues")
                        .header(header::HOST, "127.0.0.1:4000")
                        .body(Body::empty())
                        .expect("request"),
                )
                .await
                .expect("response");
            let status = response.status();
            let headers = response.headers().clone();
            let body = to_bytes(response.into_body(), usize::MAX)
                .await
                .expect("body");
            (status, headers, String::from_utf8_lossy(&body).into_owned())
        };
        let (status, headers, body) = call().await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(headers[header::CONTENT_TYPE], "application/json");
        let value: serde_json::Value = serde_json::from_str(&body).expect("json");
        assert_eq!(value["error"]["code"], "starting");
        assert_eq!(value["error"]["message"], "Cloud Tasks is still starting.");
        late.set(Service("tasks"));
        let (status, headers, body) = call().await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, "tasks /v2/queues /console/api/v1/tasks/native");
        assert_eq!(headers[header::CONTENT_SECURITY_POLICY], "sandbox");
    }
}
