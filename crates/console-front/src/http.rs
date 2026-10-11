//! HTTP helpers every section shares.
//!
//! [`forwarded`] is how a service's own application is mounted under the
//! console (`/console/api/v1/<service>/native/*`, and the older Firestore
//! REST and Identity Toolkit addresses). A mounted application answers on
//! the console's origin, so whatever it serves — an HTTP function's HTML, a
//! Storage object shown inline — would otherwise be a document of the
//! console itself, with every console route in reach of its scripts.

use axum::Router;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, header};
use axum::middleware::{self, Next};
use axum::response::Response;

/// `x-forwarded-host`: the host the browser addressed.
const FORWARDED_HOST: HeaderName = HeaderName::from_static("x-forwarded-host");
/// `x-forwarded-proto`: `http` or `https`, as the browser sees the console.
const FORWARDED_PROTO: HeaderName = HeaderName::from_static("x-forwarded-proto");
/// `x-forwarded-prefix`: where the application is mounted on that host.
const FORWARDED_PREFIX: HeaderName = HeaderName::from_static("x-forwarded-prefix");

/// Mounts a service's own application under the console. Every response is
/// sandboxed (`Content-Security-Policy: sandbox`, `X-Content-Type-Options:
/// nosniff`, replacing whatever the service sent), and every request tells
/// the application where it came from: any `x-forwarded-*` the client sent
/// is dropped, and `x-forwarded-host`, `-proto` and `-prefix` (`prefix`, the
/// mount's full path under the console origin) are set, so an application
/// that writes URLs to itself (Storage's upload `Location`) points them back
/// through the mount. The request guard's `Host` rule applies before this.
///
/// A route that must not be sandboxed opts out in its own code with the
/// reason beside it (a PDF preview: browsers refuse to render a sandboxed
/// PDF).
pub(crate) fn forwarded(app: Router, prefix: &'static str) -> Router {
    app.layer(middleware::from_fn_with_state(prefix, forward))
}

async fn forward(State(prefix): State<&'static str>, mut request: Request, next: Next) -> Response {
    let (host, proto) = origin_of(request.headers());
    let headers = request.headers_mut();
    let stale: Vec<HeaderName> = headers
        .keys()
        .filter(|name| name.as_str().starts_with("x-forwarded-") || *name == header::FORWARDED)
        .cloned()
        .collect();
    for name in stale {
        headers.remove(name);
    }
    if let Some(host) = host.and_then(|host| HeaderValue::from_str(&host).ok()) {
        headers.insert(FORWARDED_HOST, host);
    }
    headers.insert(FORWARDED_PROTO, HeaderValue::from_static(proto));
    headers.insert(FORWARDED_PREFIX, HeaderValue::from_static(prefix));
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("sandbox"),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    response
}

/// The host and scheme the browser used to reach the console. The `Origin`
/// a browser sends with every change (and the guard keeps same-origin) is
/// the page's own address, and stays right behind a reverse proxy that
/// rewrites `Host` or terminates TLS; without it, the `Host` over plain
/// HTTP, which is what the engine itself serves.
fn origin_of(headers: &HeaderMap) -> (Option<String>, &'static str) {
    if let Some(origin) = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
    {
        for (scheme, proto) in [("https://", "https"), ("http://", "http")] {
            if let Some(authority) = origin.strip_prefix(scheme)
                && is_authority(authority)
            {
                return (Some(authority.to_owned()), proto);
            }
        }
    }
    let host = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .filter(|host| is_authority(host))
        .map(str::to_owned);
    (host, "http")
}

/// A `host[:port]` with nothing that could smuggle a path, a query or
/// credentials into a URL built from it.
fn is_authority(text: &str) -> bool {
    !text.is_empty()
        && text.len() <= 255
        && text.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_' | b':' | b'[' | b']')
        })
}

#[cfg(test)]
mod tests {
    use axum::body::{Body, to_bytes};
    use axum::http::StatusCode;
    use axum::routing::get;
    use tower::ServiceExt as _;

    use super::*;

    /// An application that echoes the forwarded headers it received and
    /// tries to set its own security headers.
    fn echo() -> Router {
        Router::new()
            .route(
                "/page",
                get(|request: Request| async move {
                    let read = |name: &str| {
                        request
                            .headers()
                            .get(name)
                            .and_then(|value| value.to_str().ok())
                            .unwrap_or("-")
                            .to_owned()
                    };
                    (
                        [
                            (header::CONTENT_TYPE, "text/html"),
                            (header::CONTENT_SECURITY_POLICY, "default-src *"),
                        ],
                        format!(
                            "{} {} {} {} {}",
                            read("x-forwarded-host"),
                            read("x-forwarded-proto"),
                            read("x-forwarded-prefix"),
                            read("x-forwarded-for"),
                            read("forwarded"),
                        ),
                    )
                }),
            )
            .fallback(|| async { (StatusCode::IM_A_TEAPOT, "fallback") })
    }

    async fn call(router: Router, uri: &str, headers: &[(&str, &str)]) -> (Response, String) {
        let mut request = Request::get(uri);
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        let response = router
            .oneshot(request.body(Body::empty()).expect("request"))
            .await
            .expect("response");
        let (parts, body) = response.into_parts();
        let body = to_bytes(body, usize::MAX).await.expect("body");
        (
            Response::from_parts(parts, Body::empty()),
            String::from_utf8_lossy(&body).into_owned(),
        )
    }

    #[tokio::test]
    async fn responses_are_sandboxed_and_the_client_cannot_choose_the_forwarded_headers() {
        let mount = || {
            Router::new().nest_service(
                "/storage/native",
                forwarded(echo(), "/console/api/v1/storage/native"),
            )
        };
        let (response, body) = call(
            mount(),
            "/storage/native/page",
            &[
                ("host", "127.0.0.1:4000"),
                ("x-forwarded-host", "evil.example"),
                ("x-forwarded-proto", "https"),
                ("x-forwarded-prefix", "/elsewhere"),
                ("x-forwarded-for", "10.0.0.1"),
                ("forwarded", "host=evil.example"),
            ],
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            body,
            "127.0.0.1:4000 http /console/api/v1/storage/native - -"
        );
        assert_eq!(
            response
                .headers()
                .get_all(header::CONTENT_SECURITY_POLICY)
                .iter()
                .collect::<Vec<_>>(),
            ["sandbox"]
        );
        assert_eq!(
            response.headers()[header::X_CONTENT_TYPE_OPTIONS],
            "nosniff"
        );
        // The fallback of a mounted application is covered too.
        let (response, body) =
            call(mount(), "/storage/native/other", &[("host", "localhost")]).await;
        assert_eq!(response.status(), StatusCode::IM_A_TEAPOT);
        assert_eq!(body, "fallback");
        assert_eq!(
            response.headers()[header::CONTENT_SECURITY_POLICY],
            "sandbox"
        );
    }

    #[tokio::test]
    async fn the_browser_origin_names_the_host_and_scheme_behind_a_proxy() {
        let mount = forwarded(echo(), "/console/api/v1/storage/native");
        let (_, body) = call(
            mount.clone(),
            "/page",
            &[
                ("host", "127.0.0.1:4000"),
                ("origin", "https://console.example.test"),
            ],
        )
        .await;
        assert_eq!(
            body,
            "console.example.test https /console/api/v1/storage/native - -"
        );
        // An origin that is not an address is ignored for the Host.
        let (_, body) = call(
            mount,
            "/page",
            &[("host", "localhost:4000"), ("origin", "null")],
        )
        .await;
        assert_eq!(
            body,
            "localhost:4000 http /console/api/v1/storage/native - -"
        );
    }

    #[test]
    fn only_plain_authorities_are_used() {
        for good in [
            "localhost",
            "127.0.0.1:4000",
            "[::1]:4000",
            "console.example.test",
        ] {
            assert!(is_authority(good), "{good}");
        }
        for bad in ["", "evil.example/path", "a@b", "a b", "host?x", "host#x"] {
            assert!(!is_authority(bad), "{bad}");
        }
    }
}
