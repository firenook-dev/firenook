//! The legacy `www.googleapis.com/identitytoolkit/v3/relyingparty` routes the
//! official emulator rewrites onto v1 operations.

use serde_json::{Map as JsonMap, Value as JsonValue};

use crate::error::ApiError;

pub const PREFIX: &str = "/www.googleapis.com/identitytoolkit/v3/relyingparty/";
const V1_PREFIX: &str = "/identitytoolkit.googleapis.com/v1/";

const REWRITES: &[(&str, &str)] = &[
    ("createAuthUri", "accounts:createAuthUri"),
    ("deleteAccount", "accounts:delete"),
    ("emailLinkSignin", "accounts:signInWithEmailLink"),
    ("getAccountInfo", "accounts:lookup"),
    ("getOobConfirmationCode", "accounts:sendOobCode"),
    ("getProjectConfig", "projects"),
    ("getRecaptchaParam", "recaptchaParams"),
    ("publicKeys", "publicKeys"),
    ("resetPassword", "accounts:resetPassword"),
    ("sendVerificationCode", "accounts:sendVerificationCode"),
    ("setAccountInfo", "accounts:update"),
    ("setProjectConfig", "setProjectConfig"),
    ("signupNewUser", "accounts:signUp"),
    ("verifyAssertion", "accounts:signInWithIdp"),
    ("verifyCustomToken", "accounts:signInWithCustomToken"),
    ("verifyPassword", "accounts:signInWithPassword"),
    ("verifyPhoneNumber", "accounts:signInWithPhoneNumber"),
];

/// What a legacy request turns into.
pub enum Rewrite {
    /// Same method and body, new path.
    Path(String),
    /// `downloadAccount`: `GET` with the body merged into the query string.
    Download { path: String, query: String },
    /// `uploadAccount`: `POST` with the body minus `targetProjectId`.
    Upload { path: String, body: JsonValue },
    /// `signOutUser`.
    NotImplemented,
    /// Not a legacy route.
    None,
}

/// Resolves a legacy path (query string excluded). `body` is the parsed JSON
/// body for the two account routes, camel-cased.
pub fn rewrite(
    method: &str,
    path: &str,
    query: &str,
    body: Option<&JsonMap<String, JsonValue>>,
) -> Result<Rewrite, ApiError> {
    let Some(name) = path.strip_prefix(PREFIX) else {
        return Ok(Rewrite::None);
    };
    if name == "signOutUser" && method == "POST" {
        return Ok(Rewrite::NotImplemented);
    }
    if (name == "downloadAccount" || name == "uploadAccount") && method == "POST" {
        let body = body.cloned().unwrap_or_default();
        let Some(target) = body
            .get("targetProjectId")
            .and_then(JsonValue::as_str)
            .filter(|value| !value.is_empty())
        else {
            return Err(ApiError::bad_request("INSUFFICIENT_PERMISSION"));
        };
        let target: String = url::form_urlencoded::byte_serialize(target.as_bytes()).collect();
        let mut rest = body.clone();
        rest.remove("targetProjectId");
        if name == "downloadAccount" {
            let body_query: String = url::form_urlencoded::Serializer::new(String::new())
                .extend_pairs(
                    rest.iter()
                        .map(|(key, value)| (key.clone(), js_string(value))),
                )
                .finish();
            let merged = if query.is_empty() {
                body_query
            } else if body_query.is_empty() {
                query.to_owned()
            } else {
                format!("{query}&{body_query}")
            };
            return Ok(Rewrite::Download {
                path: format!("{V1_PREFIX}projects/{target}/accounts:batchGet"),
                query: merged,
            });
        }
        return Ok(Rewrite::Upload {
            path: format!("{V1_PREFIX}projects/{target}/accounts:batchCreate"),
            body: JsonValue::Object(rest),
        });
    }
    for (old, new) in REWRITES {
        if *old == name {
            return Ok(Rewrite::Path(format!("{V1_PREFIX}{new}")));
        }
    }
    Ok(Rewrite::None)
}

/// `URLSearchParams(object)` stringification.
fn js_string(value: &JsonValue) -> String {
    match value {
        JsonValue::String(text) => text.clone(),
        JsonValue::Null => "null".to_owned(),
        JsonValue::Array(items) => items.iter().map(js_string).collect::<Vec<_>>().join(","),
        JsonValue::Object(_) => "[object Object]".to_owned(),
        other => other.to_string(),
    }
}
