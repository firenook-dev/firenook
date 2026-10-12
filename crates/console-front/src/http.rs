//! HTTP helpers every section shares: answers that arrive over time
//! ([`ndjson_response`]), files the browser saves ([`attachment`]), and
//! service applications mounted under the console ([`forwarded`]).
//!
//! [`forwarded`] is how a service's own application is mounted under the
//! console (`/console/api/v1/<service>/native/*`, and the older Firestore
//! REST and Identity Toolkit addresses). A mounted application answers on
//! the console's origin, so whatever it serves — an HTTP function's HTML, a
//! Storage object shown inline — would otherwise be a document of the
//! console itself, with every console route in reach of its scripts.

use std::fmt::Write as _;

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse as _, Response};
use futures_util::{Stream, StreamExt as _};
use serde::Serialize;

use crate::sse::Shutdown;

/// `x-forwarded-host`: the host the browser addressed.
const FORWARDED_HOST: HeaderName = HeaderName::from_static("x-forwarded-host");
/// `x-forwarded-proto`: `http` or `https`, as the browser sees the console.
const FORWARDED_PROTO: HeaderName = HeaderName::from_static("x-forwarded-proto");
/// `x-forwarded-prefix`: where the application is mounted on that host.
const FORWARDED_PREFIX: HeaderName = HeaderName::from_static("x-forwarded-prefix");

/// `application/x-ndjson`: one JSON value per line, each line sent as soon
/// as its item arrives, ending when `items` ends or the suite stops. For
/// answers that arrive over time and are not a subscription: an
/// invocation's frames, an export.
#[allow(
    dead_code,
    reason = "the section streams answer exports and invocations with it"
)]
pub(crate) fn ndjson_response<S, T>(items: S, shutdown: Shutdown) -> Response
where
    S: Stream<Item = T> + Send + 'static,
    T: Serialize,
{
    let lines = items
        .map(|item| {
            // The console's own types always serialize.
            let mut line = serde_json::to_vec(&item).unwrap_or_else(|_| b"null".to_vec());
            line.push(b'\n');
            Ok::<_, std::convert::Infallible>(Bytes::from(line))
        })
        .take_until(shutdown.stopped());
    (
        [
            (
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/x-ndjson"),
            ),
            (header::CACHE_CONTROL, HeaderValue::from_static("no-store")),
            (
                HeaderName::from_static("x-accel-buffering"),
                HeaderValue::from_static("no"),
            ),
        ],
        Body::from_stream(lines),
    )
        .into_response()
}

/// `Content-Disposition: attachment` for a streamed body the browser saves
/// as `filename`: an ASCII `filename` for old clients and the exact name as
/// RFC 5987 `filename*`.
#[allow(dead_code, reason = "the section streams name their exports with it")]
pub(crate) fn attachment(filename: &str) -> [(HeaderName, HeaderValue); 1] {
    let fallback: String = filename
        .chars()
        .map(|character| {
            if character.is_ascii_graphic() && !matches!(character, '"' | '\\' | '%' | ';') {
                character
            } else if character == ' ' {
                ' '
            } else {
                '_'
            }
        })
        .collect();
    let mut encoded = String::with_capacity(filename.len() * 3);
    for byte in filename.bytes() {
        if byte.is_ascii_alphanumeric() || b"!#$&+-.^_`|~".contains(&byte) {
            encoded.push(char::from(byte));
        } else {
            let _ = write!(encoded, "%{byte:02X}");
        }
    }
    let value = format!("attachment; filename=\"{fallback}\"; filename*=UTF-8''{encoded}");
    [(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&value).unwrap_or_else(|_| HeaderValue::from_static("attachment")),
    )]
}

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

    #[tokio::test]
    async fn ndjson_sends_each_item_as_it_comes_and_ends_on_stop() {
        let (items, receiver) = tokio::sync::mpsc::unbounded_channel::<serde_json::Value>();
        let (stop, stopped) = tokio::sync::watch::channel(false);
        let response = ndjson_response(
            tokio_stream::wrappers::UnboundedReceiverStream::new(receiver),
            Shutdown::new(stopped),
        );
        assert_eq!(
            response.headers()[header::CONTENT_TYPE],
            "application/x-ndjson"
        );
        let mut body = response.into_body().into_data_stream();
        items.send(serde_json::json!({ "frame": 1 })).expect("sent");
        let first = tokio::time::timeout(std::time::Duration::from_secs(5), body.next())
            .await
            .expect("the first line came alone")
            .expect("a chunk")
            .expect("bytes");
        assert_eq!(&first[..], b"{\"frame\":1}\n");
        items.send(serde_json::json!("two")).expect("sent");
        let second = body.next().await.expect("a chunk").expect("bytes");
        assert_eq!(&second[..], b"\"two\"\n");
        stop.send(true).expect("stopped");
        let end = tokio::time::timeout(std::time::Duration::from_secs(5), body.next())
            .await
            .expect("the body ended on stop");
        assert!(end.is_none(), "{end:?}");
        drop(items);
    }

    #[test]
    fn an_attachment_names_a_unicode_file_both_ways() {
        let [(name, value)] = attachment("users 火🔥 \"q\".ndjson");
        assert_eq!(name, header::CONTENT_DISPOSITION);
        assert_eq!(
            value.to_str().expect("ascii"),
            "attachment; filename=\"users __ _q_.ndjson\"; filename*=UTF-8''users%20%E7%81%AB%F0%9F%94%A5%20%22q%22.ndjson"
        );
        let [(_, plain)] = attachment("export.csv");
        assert_eq!(
            plain.to_str().expect("ascii"),
            "attachment; filename=\"export.csv\"; filename*=UTF-8''export.csv"
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
