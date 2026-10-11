//! The request guard on the whole console mount.
//!
//! The Console API can change and delete everything the emulator holds, and
//! it answers on the developer's own machine, where every page they visit
//! can send it requests. One middleware on the whole mount keeps that from
//! depending on every handler using the right extractor:
//!
//! - **Host.** A request must name a host the console answers for, so a
//!   page that rebinds its own name to `127.0.0.1` (DNS rebinding) is
//!   refused before anything else happens.
//! - **`Sec-Fetch-Site`.** Browsers say where a request came from; only the
//!   console itself (`same-origin`, or `none` for a typed address) may call
//!   the Console API. A page on another port of the same host is
//!   `same-site` and refused too.
//! - **Mutations carry JSON or the console header.** A form or a bodiless
//!   `fetch` is a "simple" request any page can send without a preflight; a
//!   JSON content type or a custom header makes the browser ask first, and
//!   the engine never answers that preflight. A binary body (an upload)
//!   carries `x-firenook-console` instead.
//! - **Streams and sockets are same-origin.** A `WebSocket` bypasses CORS, so an
//!   upgrade must come with this console's own `Origin`; so must the live
//!   channel when the browser names one.
//!
//! Native mounts (a service's own HTTP application reached through the
//! console, such as Firestore REST or Identity Toolkit) keep their service's
//! semantics and get the Host rule only: the services answer any origin on
//! their own ports anyway, as the official emulators do.

use std::collections::BTreeSet;
use std::sync::Arc;

use axum::extract::{Request, State};
use axum::http::{HeaderMap, Method, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};

use crate::api_error::ApiError;

/// Sent on every request the console makes (`apiSend` and `nativeFetch` add
/// `1`; Auth's pages name `write`, `try` or `replay`). Any token of 1 to 16
/// characters from `[a-z0-9-]` lets a binary body through the guard, and the
/// services read it to mark a request as the console's own.
pub const CONSOLE_HEADER: &str = "x-firenook-console";
/// What caused a function to run: `x-firenook-cause-<kind>: <id>` (the
/// Functions stream's family; Auth's blocking calls send
/// `x-firenook-cause-auth-call`).
pub const CAUSE_HEADER_PREFIX: &str = "x-firenook-cause-";
/// Auth's call id, answered only to a request that carried the console
/// header or a cause header.
pub const ACTIVITY_HEADER: &str = "x-firenook-activity";
/// The Functions invocation id, answered only to a request that carried the
/// console header or a cause header.
pub const EXECUTION_HEADER: &str = "x-firenook-execution";
/// Storage's upload metadata header, unchanged.
pub const METADATA_HEADER: &str = "x-firenook-metadata";
/// Storage's keep-download-tokens header, unchanged.
pub const KEEP_TOKENS_HEADER: &str = "x-firenook-keep-tokens";
/// Firestore REST's row-preview header, unchanged.
pub const PREVIEW_HEADER: &str = "x-firenook-preview";

/// The path of the live channel inside the console mount.
const LIVE_PATH: &str = "/api/v1/live";

/// The host names the console answers for.
#[derive(Clone, Debug)]
pub struct AllowedHosts {
    /// Every host is accepted: the engine is bound to a wildcard address and
    /// nobody named the hosts, so the machine's own names cannot be known.
    any: bool,
    /// Lowercase names without port or brackets.
    names: Arc<BTreeSet<String>>,
}

impl AllowedHosts {
    /// `localhost`, `127.0.0.1` and `::1`.
    #[must_use]
    pub fn loopback() -> Self {
        Self::named(std::iter::empty::<&str>())
    }

    /// The hosts a console bound to `bound` answers for: the loopback names,
    /// `bound` itself unless it is a wildcard, and every name in `extra`
    /// (`--allowed-hosts`, for a deployment behind another name). Bound to a
    /// wildcard (`0.0.0.0`, `::`) with no `extra`, every host is accepted.
    #[must_use]
    pub fn new<I, S>(bound: &str, extra: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        let extra = extra
            .into_iter()
            .map(|name| normalize(name.as_ref()))
            .filter(|name| !name.is_empty())
            .collect::<Vec<_>>();
        let bound = normalize(bound);
        if is_wildcard(&bound) {
            if extra.is_empty() {
                return Self {
                    any: true,
                    names: Arc::default(),
                };
            }
            return Self::named(extra);
        }
        Self::named(extra.into_iter().chain(std::iter::once(bound)))
    }

    fn named<I, S>(extra: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        let mut names = ["localhost", "127.0.0.1", "::1"]
            .into_iter()
            .map(str::to_owned)
            .collect::<BTreeSet<_>>();
        names.extend(extra.into_iter().map(|name| normalize(name.as_ref())));
        Self {
            any: false,
            names: Arc::new(names),
        }
    }

    /// Whether every host is accepted (a wildcard bind with no names).
    #[must_use]
    pub const fn accepts_any(&self) -> bool {
        self.any
    }

    /// Whether a request whose `Host` is `host` (port included or not) is
    /// answered. The port is not compared: a rebinding attack is a foreign
    /// *name*, and a forwarded port (a container, a tunnel) is the same
    /// console.
    #[must_use]
    pub fn allows(&self, host: &str) -> bool {
        self.any || self.names.contains(&normalize(strip_port(host)))
    }
}

impl Default for AllowedHosts {
    fn default() -> Self {
        Self::loopback()
    }
}

/// Paths inside the console mount that reach a service's own application:
/// every `/api/v1/<section>/native/...` (where sections mount their
/// service's application), and the older addresses recorded with
/// [`NativeMounts::add`] (Firestore REST, Identity Toolkit).
#[derive(Clone, Debug, Default)]
pub(crate) struct NativeMounts {
    prefixes: Vec<String>,
}

impl NativeMounts {
    /// Records that everything under `prefix` (a path inside the console
    /// mount, such as `/api/v1/auth`) is a native mount.
    pub(crate) fn add(&mut self, prefix: &str) {
        self.prefixes.push(prefix.trim_end_matches('/').to_owned());
    }

    fn contains(&self, path: &str) -> bool {
        is_section_native(path)
            || self.prefixes.iter().any(|prefix| {
                path.strip_prefix(prefix.as_str())
                    .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
            })
    }
}

/// `/api/v1/<section>/native` and everything under it.
fn is_section_native(path: &str) -> bool {
    let Some(rest) = path.strip_prefix("/api/v1/") else {
        return false;
    };
    let mut segments = rest.splitn(3, '/');
    segments.next().is_some_and(|section| !section.is_empty()) && segments.next() == Some("native")
}

/// What the guard checks requests against.
#[derive(Clone, Debug)]
pub(crate) struct GuardPolicy {
    pub(crate) hosts: AllowedHosts,
    pub(crate) natives: Arc<NativeMounts>,
}

/// The middleware: refuses what the module documentation says, and passes
/// everything else on unchanged.
pub(crate) async fn guard(
    State(policy): State<GuardPolicy>,
    request: Request,
    next: Next,
) -> Response {
    match check(&policy, request.method(), request.uri(), request.headers()) {
        Ok(()) => next.run(request).await,
        Err(refusal) => refusal.into_response(),
    }
}

fn check(
    policy: &GuardPolicy,
    method: &Method,
    uri: &axum::http::Uri,
    headers: &HeaderMap,
) -> Result<(), ApiError> {
    // A browser always names the host; a request without one (a tool
    // speaking HTTP/1.0) cannot be a rebound page.
    let host = header_str(headers, header::HOST)
        .or_else(|| uri.authority().map(axum::http::uri::Authority::as_str));
    if let Some(host) = host
        && !policy.hosts.allows(host)
    {
        let name = strip_port(host);
        return Err(ApiError::permission_denied(format!(
            "This console does not answer for host {name}."
        ))
        .with_fix(format!(
            "Start the engine with --allowed-hosts {name} if you meant to."
        )));
    }
    // The application itself (the shell and its assets) opens from any
    // link or bookmark; only the Console API is the console's alone.
    if !uri.path().starts_with("/api/") || policy.natives.contains(uri.path()) {
        return Ok(());
    }
    let fetch_site = header_str(headers, "sec-fetch-site");
    if let Some(site) = fetch_site
        && !matches!(site, "same-origin" | "none")
    {
        return Err(ApiError::permission_denied(
            "Only the console itself can call the Console API.",
        ));
    }
    let upgrade = header_str(headers, header::UPGRADE)
        .is_some_and(|value| value.eq_ignore_ascii_case("websocket"));
    let live = *method == Method::GET && uri.path() == LIVE_PATH;
    if upgrade || live {
        let origin = header_str(headers, header::ORIGIN);
        // A WebSocket always carries an `Origin`; a same-origin
        // `EventSource` does not (browsers add it only to cross-origin
        // requests), and a cross-origin one is refused by `Sec-Fetch-Site`
        // above or by its `Origin` here.
        let required = upgrade;
        let same = match origin {
            Some(origin) => {
                host.is_some_and(|host| origin_authority(origin).eq_ignore_ascii_case(host))
                    // A development proxy that rewrites `Host` (Vite's
                    // `changeOrigin`) keeps the browser's own attestation.
                    || fetch_site == Some("same-origin")
            }
            None => !required,
        };
        if !same {
            return Err(ApiError::permission_denied(
                "Only the console itself can open this stream.",
            )
            .with_fix("Open it from the console's own page, at the address the engine prints."));
        }
    }
    let mutation = !matches!(*method, Method::GET | Method::HEAD | Method::OPTIONS);
    if mutation && !is_json(headers) && !has_console_token(headers) {
        return Err(
            ApiError::media_type("Console API changes are sent as JSON.").with_fix(
                "Send the body with content-type: application/json, or send a binary body with an x-firenook-console header.",
            ),
        );
    }
    Ok(())
}

fn header_str(headers: &HeaderMap, name: impl axum::http::header::AsHeaderName) -> Option<&str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}

fn is_json(headers: &HeaderMap) -> bool {
    header_str(headers, header::CONTENT_TYPE).is_some_and(|value| {
        value
            .split(';')
            .next()
            .is_some_and(|essence| essence.trim().eq_ignore_ascii_case("application/json"))
    })
}

/// Whether `x-firenook-console` holds a token of 1 to 16 characters from
/// `[a-z0-9-]`.
pub(crate) fn has_console_token(headers: &HeaderMap) -> bool {
    header_str(headers, CONSOLE_HEADER).is_some_and(|token| {
        (1..=16).contains(&token.len())
            && token
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    })
}

/// `host:port` without a scheme: `http://localhost:4000` → `localhost:4000`.
fn origin_authority(origin: &str) -> &str {
    origin
        .split_once("://")
        .map_or(origin, |(_, rest)| rest)
        .trim_end_matches('/')
}

/// `localhost:4000` → `localhost`, `[::1]:4000` → `[::1]`, `::1` → `::1`.
fn strip_port(host: &str) -> &str {
    if host.starts_with('[') {
        return host.find(']').map_or(host, |end| &host[..=end]);
    }
    match host.rsplit_once(':') {
        // One colon followed by digits is a port; more colons are a bare
        // IPv6 address.
        Some((name, port))
            if !name.contains(':')
                && !port.is_empty()
                && port.bytes().all(|b| b.is_ascii_digit()) =>
        {
            name
        }
        _ => host,
    }
}

/// Lowercase, without brackets or a trailing dot.
fn normalize(name: &str) -> String {
    name.trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .trim_end_matches('.')
        .to_ascii_lowercase()
}

fn is_wildcard(name: &str) -> bool {
    matches!(name, "0.0.0.0" | "::" | "")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hosts_are_compared_by_name_whatever_the_port_and_brackets() {
        let hosts = AllowedHosts::new("127.0.0.1", ["Console.Example.test"]);
        for allowed in [
            "localhost",
            "localhost:4000",
            "127.0.0.1:4000",
            "[::1]:4000",
            "[::1]",
            "::1",
            "console.example.test:443",
            "LOCALHOST.:4000",
        ] {
            assert!(hosts.allows(allowed), "{allowed}");
        }
        for refused in [
            "evil.example",
            "evil.example:4000",
            "127.0.0.2",
            "[::2]:4000",
        ] {
            assert!(!hosts.allows(refused), "{refused}");
        }
        assert!(!hosts.accepts_any());
    }

    #[test]
    fn a_wildcard_bind_accepts_any_host_unless_names_were_given() {
        assert!(AllowedHosts::new("0.0.0.0", None::<&str>).allows("my-laptop.local"));
        assert!(AllowedHosts::new("[::]", None::<&str>).accepts_any());
        let named = AllowedHosts::new("0.0.0.0", ["my-laptop.local"]);
        assert!(named.allows("my-laptop.local:4000"));
        assert!(named.allows("localhost:4000"));
        assert!(!named.allows("evil.example"));
        assert!(!named.allows("0.0.0.0"));
    }

    #[test]
    fn a_bound_host_is_allowed_beside_the_loopback_names() {
        let hosts = AllowedHosts::new("192.168.1.20", None::<&str>);
        assert!(hosts.allows("192.168.1.20:4000"));
        assert!(hosts.allows("localhost:4000"));
        assert!(!hosts.allows("192.168.1.21:4000"));
    }

    #[test]
    fn console_tokens_are_short_lowercase_words() {
        let token = |value: &str| {
            let mut headers = HeaderMap::new();
            headers.insert(CONSOLE_HEADER, value.parse().expect("header"));
            has_console_token(&headers)
        };
        for good in ["1", "write", "try", "replay", "a-b-c", "0123456789abcdef"] {
            assert!(token(good), "{good}");
        }
        for bad in ["Bad Token!", "0123456789abcdefg", "", "WRITE", "a_b"] {
            assert!(!token(bad), "{bad}");
        }
    }

    #[test]
    fn native_mounts_cover_their_prefix_and_nothing_beside_it() {
        let mut natives = NativeMounts::default();
        natives.add("/api/v1/auth/");
        assert!(natives.contains("/api/v1/auth"));
        assert!(natives.contains("/api/v1/auth/identitytoolkit.googleapis.com/v1/x"));
        assert!(!natives.contains("/api/v1/authx"));
        assert!(!natives.contains("/api/v1/status"));
    }
}
