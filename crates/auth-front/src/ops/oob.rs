//! Out-of-band codes: `sendOobCode`, `resetPassword` and the link/log
//! rendering the official emulator uses.

use serde_json::{Value as JsonValue, json};

use super::{Ctx, PASSWORD_MIN_LENGTH, fake_salt, hash_password};
use crate::Runtime;
use crate::error::{ApiError, ensure, require};
use crate::state::{OobRecord, Scope, UserRecord, provider_infos};
use crate::token::parse_id_token;
use crate::util::{canonicalize_email, is_absolute_uri, now_millis, now_seconds, str_field};

/// `createOobRecord`: the code and its `/emulator/action` link.
pub fn create_oob_record(
    scope: &mut Scope<'_>,
    email: &str,
    emulator_url: &str,
    request_type: &str,
    mode: &str,
    continue_url: Option<&str>,
    new_email: Option<&str>,
) -> OobRecord {
    let tenant = scope.tenant_id.clone();
    let base = emulator_url.to_owned();
    scope
        .project()
        .create_oob(email, new_email, request_type, |code| {
            let Ok(mut url) =
                url::Url::parse(&base).or_else(|_| url::Url::parse("http://unknown/"))
            else {
                return String::new();
            };
            url.set_path("/emulator/action");
            {
                let mut query = url.query_pairs_mut();
                query.append_pair("mode", mode);
                query.append_pair("lang", "en");
                query.append_pair("oobCode", code);
                query.append_pair("apiKey", "fake-api-key");
                if let Some(continue_url) = continue_url {
                    query.append_pair("continueUrl", continue_url);
                }
                if let Some(tenant) = &tenant {
                    query.append_pair("tenantId", tenant);
                }
            }
            url.to_string()
        })
}

/// `logOobMessage`.
pub fn log_oob_message(rt: &Runtime, record: &OobRecord) {
    let link = &record.oob_link;
    let email = &record.email;
    let message = match record.request_type.as_str() {
        "EMAIL_SIGNIN" => Some(format!("To sign in as {email}, follow this link: {link}")),
        "PASSWORD_RESET" => Some(format!(
            "To reset the password for {email}, follow this link: {link}&newPassword=NEW_PASSWORD_HERE"
        )),
        "VERIFY_EMAIL" => Some(format!(
            "To verify the email address {email}, follow this link: {link}"
        )),
        "VERIFY_AND_CHANGE_EMAIL" => Some(format!(
            "To verify and change the email address from {email} to {}, follow this link: {link}",
            record.new_email.clone().unwrap_or_default()
        )),
        "RECOVER_EMAIL" => Some(format!(
            "To reset your email address to {email}, follow this link: {link}"
        )),
        _ => None,
    };
    if let Some(message) = message {
        rt.log("BULLET", &message);
    }
}

pub fn send_oob_code(rt: &Runtime, ctx: &Ctx) -> Result<JsonValue, ApiError> {
    rt.scope(ctx, |scope| {
        ensure!(!scope.disable_auth(), "PROJECT_DISABLED");
        let request_type = ctx.body_truthy_str("requestType");
        ensure!(
            request_type.is_some_and(|value| value != "OOB_REQ_TYPE_UNSPECIFIED"),
            "MISSING_REQ_TYPE"
        );
        let request_type = request_type.unwrap_or_default().to_owned();
        let return_link = ctx.body_truthy("returnOobLink");
        if return_link {
            ensure!(ctx.privileged, "INSUFFICIENT_PERMISSION");
        }
        if let Some(continue_url) = ctx.body_truthy_str("continueUrl") {
            ensure!(
                is_absolute_uri(continue_url),
                "INVALID_CONTINUE_URI : ((expected an absolute URI with valid scheme and host))"
            );
        }
        let mut new_email: Option<String> = None;
        let email: String;
        let mode: &str;
        match request_type.as_str() {
            "EMAIL_SIGNIN" => {
                ensure!(scope.enable_email_link_signin(), "OPERATION_NOT_ALLOWED");
                mode = "signIn";
                let value = ctx.body_truthy_str("email");
                ensure!(value.is_some(), "MISSING_EMAIL");
                email = canonicalize_email(value.unwrap_or_default());
            }
            "PASSWORD_RESET" => {
                mode = "resetPassword";
                let value = ctx.body_truthy_str("email");
                ensure!(value.is_some(), "MISSING_EMAIL");
                email = canonicalize_email(value.unwrap_or_default());
                let user = scope.project().get_user_by_email(&email);
                if scope.improved_email_privacy() && user.is_none() {
                    return Ok(json!({ "kind": "identitytoolkit#GetOobConfirmationCodeResponse", "email": email }));
                }
                ensure!(user.is_some(), "EMAIL_NOT_FOUND");
            }
            "VERIFY_EMAIL" => {
                mode = "verifyEmail";
                if return_link && !ctx.body_truthy("idToken") {
                    let value = ctx.body_truthy_str("email");
                    ensure!(value.is_some(), "MISSING_EMAIL");
                    email = canonicalize_email(value.unwrap_or_default());
                    ensure!(scope.project().get_user_by_email(&email).is_some(), "USER_NOT_FOUND");
                } else {
                    let user = parse_id_token(scope, ctx.body_str("idToken").unwrap_or_default())?.user;
                    let value = str_field(&user, "email").filter(|value| !value.is_empty());
                    ensure!(value.is_some(), "MISSING_EMAIL");
                    email = value.unwrap_or_default().to_owned();
                }
            }
            "VERIFY_AND_CHANGE_EMAIL" => {
                mode = "verifyAndChangeEmail";
                let value = ctx.body_truthy_str("newEmail");
                ensure!(value.is_some(), "MISSING_NEW_EMAIL");
                let changed = canonicalize_email(value.unwrap_or_default());
                if return_link && !ctx.body_truthy("idToken") {
                    let value = ctx.body_truthy_str("email");
                    ensure!(value.is_some(), "MISSING_EMAIL");
                    email = canonicalize_email(value.unwrap_or_default());
                    ensure!(scope.project().get_user_by_email(&email).is_some(), "USER_NOT_FOUND");
                } else {
                    ensure!(ctx.body_truthy("idToken"), "MISSING_ID_TOKEN");
                    let user = parse_id_token(scope, ctx.body_str("idToken").unwrap_or_default())?.user;
                    let value = str_field(&user, "email").filter(|value| !value.is_empty());
                    ensure!(value.is_some(), "MISSING_EMAIL");
                    email = value.unwrap_or_default().to_owned();
                }
                ensure!(scope.project().get_user_by_email(&changed).is_none(), "EMAIL_EXISTS");
                new_email = Some(changed);
            }
            other => return Err(ApiError::not_implemented(other)),
        }
        if ctx.body_truthy("canHandleCodeInApp") {
            rt.log("WARN", "canHandleCodeInApp is unsupported in Auth Emulator. All OOB operations will complete via web.");
        }
        let record = create_oob_record(
            scope,
            &email,
            &ctx.emulator_url,
            &request_type,
            mode,
            ctx.body_truthy_str("continueUrl"),
            new_email.as_deref(),
        );
        if return_link {
            return Ok(json!({
                "kind": "identitytoolkit#GetOobConfirmationCodeResponse",
                "email": email,
                "oobCode": record.oob_code,
                "oobLink": record.oob_link,
            }));
        }
        log_oob_message(rt, &record);
        Ok(json!({ "kind": "identitytoolkit#GetOobConfirmationCodeResponse", "email": email }))
    })
}

/// `resetPassword` shared by the API route and the action page.
pub fn reset_password(
    scope: &mut Scope<'_>,
    oob_code: Option<&str>,
    new_password: Option<&str>,
) -> Result<JsonValue, ApiError> {
    ensure!(!scope.disable_auth(), "PROJECT_DISABLED");
    ensure!(scope.allow_password_signup(), "PASSWORD_LOGIN_DISABLED");
    ensure!(
        oob_code.is_some_and(|code| !code.is_empty()),
        "MISSING_OOB_CODE"
    );
    let code = oob_code.unwrap_or_default();
    let oob = scope.project().validate_oob_code(code);
    let oob = require!(oob, "INVALID_OOB_CODE");
    if let Some(password) = new_password.filter(|password| !password.is_empty()) {
        ensure!(oob.request_type == "PASSWORD_RESET", "INVALID_OOB_CODE");
        ensure!(
            password.chars().count() >= PASSWORD_MIN_LENGTH,
            format!("WEAK_PASSWORD : Password should be at least {PASSWORD_MIN_LENGTH} characters")
        );
        scope.project().delete_oob_code(code);
        let user = scope.project().get_user_by_email(&oob.email);
        let user = require!(user, "INVALID_OOB_CODE");
        let salt = fake_salt();
        let mut updates = UserRecord::new();
        updates.insert("emailVerified".to_owned(), json!(true));
        updates.insert(
            "passwordHash".to_owned(),
            json!(hash_password(password, &salt)),
        );
        updates.insert("salt".to_owned(), json!(salt));
        updates.insert("passwordUpdatedAt".to_owned(), json!(now_millis()));
        updates.insert("validSince".to_owned(), json!(now_seconds().to_string()));
        let providers: Vec<String> = provider_infos(&user)
            .iter()
            .filter_map(|info| str_field(info, "providerId").map(str::to_owned))
            .collect();
        let local_id = str_field(&user, "localId").unwrap_or_default().to_owned();
        scope.project().update_user_by_local_id(
            &local_id,
            &updates,
            crate::state::UpdateOptions {
                upsert_providers: Vec::new(),
                delete_providers: providers.iter().map(String::as_str).collect(),
            },
        )?;
    }
    let mut response = json!({
        "kind": "identitytoolkit#ResetPasswordResponse",
        "requestType": oob.request_type,
    });
    if oob.request_type != "EMAIL_SIGNIN" {
        response["email"] = json!(oob.email);
    }
    if let Some(new_email) = &oob.new_email {
        response["newEmail"] = json!(new_email);
    }
    Ok(response)
}

pub fn reset_password_op(rt: &Runtime, ctx: &Ctx) -> Result<JsonValue, ApiError> {
    rt.scope(ctx, |scope| {
        reset_password(scope, ctx.body_str("oobCode"), ctx.body_str("newPassword"))
    })
}
