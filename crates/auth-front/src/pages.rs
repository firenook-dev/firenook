//! Routes outside the Identity Toolkit API: readiness, the `OpenAPI`
//! document, the `/emulator/action` landing page and the popup helper pages.

use std::collections::BTreeMap;
use std::fmt::Write as _;

use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::{Map as JsonMap, Value as JsonValue, json};

use crate::error::ApiError;
use crate::ops::oob::reset_password;
use crate::ops::update::set_account_info_impl;
use crate::{Runtime, pretty_json};

const HANDLER: &str = include_str!("oauth-handler.html");
const IFRAME: &str = include_str!("oauth-iframe.html");

#[must_use]
pub fn readiness() -> Response {
    pretty_json(
        StatusCode::OK,
        &json!({
            "authEmulator": {
                "ready": true,
                "docs": "https://firebase.google.com/docs/emulator-suite",
                "apiSpec": "/emulator/openapi.json",
            }
        }),
    )
}

pub fn openapi(protocol: &str, host: Option<&str>) -> Response {
    pretty_json(
        StatusCode::OK,
        &crate::spec::SPEC.served_document(protocol, host),
    )
}

fn auth_emulator_json(status: StatusCode, body: &JsonValue) -> Response {
    pretty_json(status, &json!({ "authEmulator": body }))
}

fn redirect(location: &str) -> Response {
    // Express `res.redirect(303, url)` sends a text/plain body naming the target.
    let body = format!("See Other. Redirecting to {location}");
    (
        StatusCode::SEE_OTHER,
        [
            (header::LOCATION, location.to_owned()),
            (header::CONTENT_TYPE, "text/plain; charset=utf-8".to_owned()),
        ],
        body,
    )
        .into_response()
}

/// `GET /emulator/action`.
pub fn action(rt: &Runtime, pairs: &[(String, String)]) -> Response {
    let get = |name: &str| {
        pairs
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
            .filter(|value| !value.is_empty())
    };
    let Some(_api_key) = get("apiKey") else {
        return auth_emulator_json(
            StatusCode::BAD_REQUEST,
            &json!({
                "error": "missing apiKey query parameter",
                "instructions": "Please modify the URL to specify an apiKey, such as ...&apiKey=YOUR_API_KEY",
            }),
        );
    };
    let Some(oob_code) = get("oobCode") else {
        return auth_emulator_json(
            StatusCode::BAD_REQUEST,
            &json!({
                "error": "missing oobCode query parameter",
                "instructions": "Please modify the URL to specify an oobCode, such as ...&oobCode=YOUR_OOB_CODE",
            }),
        );
    };
    let tenant = get("tenantId").map(str::to_owned);
    let continue_url = get("continueUrl").map(str::to_owned);
    let project_id = rt.default_project().to_owned();
    let ctx = crate::ops::Ctx {
        project_id,
        tenant_id: tenant,
        privileged: false,
        body: JsonMap::new(),
        query: BTreeMap::new(),
        emulator_url: rt.emulator_url(None),
    };
    match get("mode") {
        Some("recoverEmail") => {
            const RETRY: &str = "If you're trying to test the reverting email flow, try changing the email again to generate a new link.";
            let matches = rt
                .scope(&ctx, |scope| {
                    Ok(scope
                        .project()
                        .validate_oob_code(oob_code)
                        .is_some_and(|oob| oob.request_type == "RECOVER_EMAIL"))
                })
                .unwrap_or(false);
            if !matches {
                return auth_emulator_json(
                    StatusCode::BAD_REQUEST,
                    &json!({ "error": "Requested mode does not match the OOB code provided.", "instructions": RETRY }),
                );
            }
            let mut body = JsonMap::new();
            body.insert("oobCode".to_owned(), json!(oob_code));
            match rt.scope(&ctx, |scope| {
                set_account_info_impl(rt, scope, &body, false, None)
            }) {
                Ok(response) => auth_emulator_json(
                    StatusCode::OK,
                    &json!({ "success": "The email has been successfully reset.", "email": response.get("email").cloned().unwrap_or(JsonValue::Null) }),
                ),
                Err(error)
                    if error.is_not_implemented()
                        || (error.is_bad_request() && error.message == "INVALID_OOB_CODE") =>
                {
                    auth_emulator_json(
                        StatusCode::BAD_REQUEST,
                        &json!({ "error": "Your request to revert your email has expired or the link has already been used.", "instructions": RETRY }),
                    )
                }
                Err(error) => error.into_response(),
            }
        }
        Some("resetPassword") => {
            let oob = rt
                .scope(&ctx, |scope| {
                    Ok(scope.project().validate_oob_code(oob_code))
                })
                .ok()
                .flatten();
            let Some(oob) = oob.filter(|oob| oob.request_type == "PASSWORD_RESET") else {
                return auth_emulator_json(
                    StatusCode::BAD_REQUEST,
                    &json!({
                        "error": "Your request to reset your password has expired or the link has already been used.",
                        "instructions": "Try resetting your password again.",
                    }),
                );
            };
            let Some(new_password) = get("newPassword") else {
                return auth_emulator_json(
                    StatusCode::BAD_REQUEST,
                    &json!({
                        "error": "missing newPassword query parameter",
                        "instructions": format!("To reset the password for {}, send an HTTP GET request to the following URL.", oob.email),
                        "instructions2": "You may use a web browser or any HTTP client, such as curl.",
                        "urlTemplate": format!("{}&newPassword=NEW_PASSWORD_HERE", oob.oob_link),
                    }),
                );
            };
            if new_password == "NEW_PASSWORD_HERE" {
                return auth_emulator_json(
                    StatusCode::BAD_REQUEST,
                    &json!({
                        "error": "newPassword must be something other than 'NEW_PASSWORD_HERE'",
                        "instructions": "The string 'NEW_PASSWORD_HERE' is just a placeholder.",
                        "instructions2": "Please change the URL to specify a new password instead.",
                        "urlTemplate": format!("{}&newPassword=NEW_PASSWORD_HERE", oob.oob_link),
                    }),
                );
            }
            match rt.scope(&ctx, |scope| {
                reset_password(scope, Some(oob_code), Some(new_password))
            }) {
                Ok(response) => match &continue_url {
                    Some(url) => redirect(url),
                    None => auth_emulator_json(
                        StatusCode::OK,
                        &json!({ "success": "The password has been successfully updated.", "email": response.get("email").cloned().unwrap_or(JsonValue::Null) }),
                    ),
                },
                Err(error) => error.into_response(),
            }
        }
        Some("verifyEmail") => {
            let mut body = JsonMap::new();
            body.insert("oobCode".to_owned(), json!(oob_code));
            match rt.scope(&ctx, |scope| {
                set_account_info_impl(rt, scope, &body, false, None)
            }) {
                Ok(response) => match &continue_url {
                    Some(url) => redirect(url),
                    None => auth_emulator_json(
                        StatusCode::OK,
                        &json!({ "success": "The email has been successfully verified.", "email": response.get("email").cloned().unwrap_or(JsonValue::Null) }),
                    ),
                },
                Err(error)
                    if error.is_not_implemented()
                        || (error.is_bad_request() && error.message == "INVALID_OOB_CODE") =>
                {
                    auth_emulator_json(
                        StatusCode::BAD_REQUEST,
                        &json!({ "error": "Your request to verify your email has expired or the link has already been used.", "instructions": "Try verifying your email again." }),
                    )
                }
                Err(error) => error.into_response(),
            }
        }
        Some("verifyAndChangeEmail") => {
            let mut body = JsonMap::new();
            body.insert("oobCode".to_owned(), json!(oob_code));
            match rt.scope(&ctx, |scope| {
                set_account_info_impl(rt, scope, &body, false, None)
            }) {
                Ok(response) => match &continue_url {
                    Some(url) => redirect(url),
                    None => auth_emulator_json(
                        StatusCode::OK,
                        &json!({ "success": "The email has been successfully changed.", "newEmail": response.get("newEmail").cloned().unwrap_or(JsonValue::Null) }),
                    ),
                },
                Err(error)
                    if error.is_not_implemented()
                        || (error.is_bad_request() && error.message == "INVALID_OOB_CODE") =>
                {
                    auth_emulator_json(
                        StatusCode::BAD_REQUEST,
                        &json!({ "error": "Your request to change your email has expired or the link has already been used.", "instructions": "Try changing your email again." }),
                    )
                }
                Err(error) => error.into_response(),
            }
        }
        Some("signIn") => {
            let Some(continue_url) = &continue_url else {
                return auth_emulator_json(
                    StatusCode::BAD_REQUEST,
                    &json!({ "error": "Missing continueUrl query parameter", "instructions": "To sign in, append &continueUrl=YOUR_APP_URL to the link." }),
                );
            };
            let Ok(mut target) = url::Url::parse(continue_url) else {
                return ApiError::unknown(format!("Invalid URL: {continue_url}"), "TypeError")
                    .into_response();
            };
            // `URLSearchParams.set` for every query name but continueUrl, in
            // request order: replace an existing name in place, else append.
            let mut merged: Vec<(String, String)> = target
                .query_pairs()
                .map(|(key, value)| (key.into_owned(), value.into_owned()))
                .collect();
            for (name, value) in pairs {
                if name == "continueUrl" {
                    continue;
                }
                if let Some(entry) = merged.iter_mut().find(|(key, _)| key == name) {
                    value.clone_into(&mut entry.1);
                    merged.retain(|(key, current)| key != name || current == value);
                } else {
                    merged.push((name.clone(), value.clone()));
                }
            }
            target.query_pairs_mut().clear().extend_pairs(
                merged
                    .iter()
                    .map(|(key, value)| (key.as_str(), value.as_str())),
            );
            if merged.is_empty() {
                target.set_query(None);
            }
            redirect(target.as_str())
        }
        _ => auth_emulator_json(StatusCode::BAD_REQUEST, &json!({ "error": "Invalid mode" })),
    }
}

/// `GET /emulator/auth/handler`: the account picker for a provider.
pub fn handler(rt: &Runtime, query: &BTreeMap<String, String>) -> Response {
    let get = |name: &str| {
        query
            .get(name)
            .filter(|value| !value.is_empty())
            .map(String::as_str)
    };
    let (Some(_api_key), Some(provider)) = (get("apiKey"), get("providerId")) else {
        // The official handler sets the HTML content type before this check,
        // so the JSON error travels as `text/html`.
        let text = serde_json::to_string_pretty(
            &json!({ "authEmulator": { "error": "missing apiKey or providerId query parameters" } }),
        )
        .unwrap_or_default();
        return (
            StatusCode::BAD_REQUEST,
            [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
            text,
        )
            .into_response();
    };
    let tenant = get("tenantId").or_else(|| get("tid")).map(str::to_owned);
    let ctx = crate::ops::Ctx {
        project_id: rt.default_project().to_owned(),
        tenant_id: tenant,
        privileged: false,
        body: JsonMap::new(),
        query: BTreeMap::new(),
        emulator_url: rt.emulator_url(None),
    };
    let infos = rt
        .scope(&ctx, |scope| {
            Ok(scope.project().list_provider_infos_by_provider_id(provider))
        })
        .unwrap_or_default();
    let accounts: Vec<JsonValue> = infos
        .iter()
        .map(|info| {
            let mut claims =
                json!({ "sub": info.get("rawId"), "iss": "", "aud": "", "exp": 0, "iat": 0 });
            for (source, target) in [
                ("displayName", "name"),
                ("screenName", "screen_name"),
                ("email", "email"),
            ] {
                if let Some(value) = info.get(source).filter(|value| !value.is_null()) {
                    claims[target] = value.clone();
                }
            }
            claims["email_verified"] = json!(true);
            if let Some(picture) = info.get("photoUrl").filter(|value| !value.is_null()) {
                claims["picture"] = picture.clone();
            }
            claims
        })
        .collect();
    // The official picker's markup: one `.js-reuse-account` per account
    // carrying its claims URL-encoded in `data-id-token`.
    let mut items = String::new();
    for (claims, info) in accounts.iter().zip(&infos) {
        let encoded: String = url::form_urlencoded::byte_serialize(
            serde_json::to_string(claims).unwrap_or_default().as_bytes(),
        )
        .collect();
        let name = info
            .get("displayName")
            .and_then(JsonValue::as_str)
            .unwrap_or("(No display name)");
        let email = info.get("email").and_then(JsonValue::as_str).unwrap_or("");
        let _ = write!(
            items,
            "<li><button type=\"button\" class=\"js-reuse-account\" data-id-token=\"{}\"><span>{}</span><span class=\"email\">{}</span></button></li>",
            encoded.replace('+', "%20"),
            html_escape(name),
            html_escape(email)
        );
    }
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        HANDLER.replace("__FIRENOOK_ACCOUNT_ITEMS__", &items),
    )
        .into_response()
}

fn html_escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

#[must_use]
pub fn iframe() -> Response {
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        IFRAME,
    )
        .into_response()
}
