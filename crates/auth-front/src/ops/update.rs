//! `accounts:update` (`setAccountInfoImpl`) for clients, the owner and the
//! out-of-band action page.

use serde_json::{Map as JsonMap, Value as JsonValue, json};

use super::oob::{create_oob_record, log_oob_message};
use super::{
    Ctx, PASSWORD_MIN_LENGTH, fake_salt, hash_password, mfa_enrollments_from_request,
    validate_serialized_custom_claims,
};
use crate::Runtime;
use crate::error::{ApiError, ensure, require};
use crate::state::{
    PROVIDER_ANONYMOUS, PROVIDER_PASSWORD, PROVIDER_PHONE, ProviderInfo, Scope, UpdateOptions,
    UserRecord, passkeys,
};
use crate::token::{IssueOptions, issue_tokens, parse_id_token};
use crate::util::{
    canonicalize_email, is_valid_email, is_valid_phone, mirror_field, now_millis, now_seconds,
    str_field, truthy, truthy_str,
};

pub fn set_account_info(rt: &Runtime, ctx: &Ctx) -> Result<JsonValue, ApiError> {
    rt.scope(ctx, |scope| {
        ensure!(!scope.disable_auth(), "PROJECT_DISABLED");
        set_account_info_impl(
            rt,
            scope,
            &ctx.body,
            ctx.privileged,
            Some(&ctx.emulator_url),
        )
    })
}

/// `setAccountInfoImpl(state, reqBody, { privileged, emulatorUrl })`.
pub fn set_account_info_impl(
    rt: &Runtime,
    scope: &mut Scope<'_>,
    body: &JsonMap<String, JsonValue>,
    privileged: bool,
    emulator_url: Option<&str>,
) -> Result<JsonValue, ApiError> {
    for field in ["provider", "upgradeToFederatedLogin"] {
        if body.contains_key(field) {
            return Err(ApiError::not_implemented(format!(
                "{field} is not implemented yet."
            )));
        }
    }
    let has = |field: &str| truthy(body.get(field));
    if privileged {
        ensure!(has("localId"), "MISSING_LOCAL_ID");
    } else {
        ensure!(
            has("idToken") || has("oobCode"),
            "INVALID_REQ_TYPE : Unsupported request parameters."
        );
        ensure!(
            body.get("customAttributes").is_none_or(JsonValue::is_null),
            "INSUFFICIENT_PERMISSION"
        );
    }
    if let Some(claims) = truthy_str(body, "customAttributes") {
        validate_serialized_custom_claims(claims)?;
    }
    let delete_attributes: Vec<String> = body
        .get("deleteAttribute")
        .and_then(JsonValue::as_array)
        .map(|list| {
            list.iter()
                .filter_map(JsonValue::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    for attribute in &delete_attributes {
        if attribute == "PROVIDER" || attribute == "RAW_USER_INFO" {
            return Err(ApiError::not_implemented(format!(
                "deleteAttribute: {attribute}"
            )));
        }
    }
    let mut updates = UserRecord::new();
    let mut user: UserRecord;
    let mut sign_in_provider: Option<String> = None;
    let mut is_email_update = false;
    let mut new_email: Option<String> = None;
    if let Some(code) = truthy_str(body, "oobCode") {
        let oob = scope.project().validate_oob_code(code);
        let oob = require!(oob, "INVALID_OOB_CODE");
        match oob.request_type.as_str() {
            "VERIFY_EMAIL" => {
                scope.project().delete_oob_code(code);
                sign_in_provider = Some(PROVIDER_PASSWORD.to_owned());
                user = require!(
                    scope.project().get_user_by_email(&oob.email),
                    "INVALID_OOB_CODE"
                );
                updates.insert("emailVerified".to_owned(), json!(true));
                if str_field(&user, "email") != Some(oob.email.as_str()) {
                    updates.insert("email".to_owned(), json!(oob.email));
                }
            }
            "VERIFY_AND_CHANGE_EMAIL" => {
                scope.project().delete_oob_code(code);
                let maybe = require!(
                    scope.project().get_user_by_email(&oob.email),
                    "INVALID_OOB_CODE"
                );
                let changed = require!(
                    oob.new_email.clone().filter(|email| !email.is_empty()),
                    "INVALID_OOB_CODE"
                );
                ensure!(
                    scope.project().get_user_by_email(&changed).is_none(),
                    "EMAIL_EXISTS"
                );
                user = maybe;
                if str_field(&user, "email") != Some(changed.as_str()) {
                    updates.insert("email".to_owned(), json!(changed));
                    updates.insert("emailVerified".to_owned(), json!(true));
                    new_email = Some(changed);
                }
            }
            "RECOVER_EMAIL" => {
                scope.project().delete_oob_code(code);
                let maybe = require!(
                    scope.project().get_user_by_initial_email(&oob.email),
                    "INVALID_OOB_CODE"
                );
                ensure!(
                    scope.project().get_user_by_email(&oob.email).is_none(),
                    "EMAIL_EXISTS"
                );
                user = maybe;
                if str_field(&user, "email") != Some(oob.email.as_str()) {
                    updates.insert("email".to_owned(), json!(oob.email));
                    updates.insert("emailVerified".to_owned(), json!(true));
                }
            }
            other => return Err(ApiError::not_implemented(other)),
        }
    } else {
        if let Some(token) = truthy_str(body, "idToken") {
            let parsed = parse_id_token(scope, token)?;
            user = parsed.user;
            sign_in_provider = Some(parsed.sign_in_provider);
            ensure!(
                body.get("disableUser").is_none_or(JsonValue::is_null),
                "OPERATION_NOT_ALLOWED"
            );
        } else {
            let local_id = require!(truthy_str(body, "localId"), "MISSING_LOCAL_ID");
            user = require!(
                scope.project().get_user_by_local_id(local_id),
                "USER_NOT_FOUND"
            );
        }
        if let Some(email) = truthy_str(body, "email") {
            ensure!(is_valid_email(email), "INVALID_EMAIL");
            let canonical = canonicalize_email(email);
            new_email = Some(canonical.clone());
            if str_field(&user, "email") != Some(canonical.as_str()) {
                ensure!(
                    scope.project().get_user_by_email(&canonical).is_none(),
                    "EMAIL_EXISTS"
                );
                updates.insert("email".to_owned(), json!(canonical));
                updates.insert("emailVerified".to_owned(), json!(false));
                is_email_update = true;
                if sign_in_provider.as_deref() != Some(PROVIDER_ANONYMOUS)
                    && truthy(user.get("email"))
                    && !truthy(user.get("initialEmail"))
                {
                    updates.insert(
                        "initialEmail".to_owned(),
                        user.get("email").cloned().unwrap_or(JsonValue::Null),
                    );
                }
            }
        }
        if let Some(password) = truthy_str(body, "password") {
            ensure!(
                password.chars().count() >= PASSWORD_MIN_LENGTH,
                format!(
                    "WEAK_PASSWORD : Password should be at least {PASSWORD_MIN_LENGTH} characters"
                )
            );
            let salt = fake_salt();
            updates.insert(
                "passwordHash".to_owned(),
                json!(hash_password(password, &salt)),
            );
            updates.insert("salt".to_owned(), json!(salt));
            updates.insert("passwordUpdatedAt".to_owned(), json!(now_millis()));
            sign_in_provider = Some(PROVIDER_PASSWORD.to_owned());
        }
        if has("password") || has("validSince") || truthy(updates.get("email")) {
            updates.insert("validSince".to_owned(), json!(now_seconds().to_string()));
        }
        if let Some(mfa) = body.get("mfa").filter(|value| truthy(Some(value))) {
            match mfa
                .get("enrollments")
                .and_then(JsonValue::as_array)
                .filter(|list| !list.is_empty())
            {
                Some(enrollments) => {
                    updates.insert(
                        "mfaInfo".to_owned(),
                        JsonValue::Array(mfa_enrollments_from_request(enrollments, false)?),
                    );
                }
                None => {
                    updates.insert("mfaInfo".to_owned(), JsonValue::Null);
                }
            }
        }
        let mut fields_to_copy = vec!["displayName", "photoUrl"];
        if privileged {
            if let Some(disable) = body.get("disableUser").filter(|value| !value.is_null()) {
                updates.insert("disabled".to_owned(), disable.clone());
            }
            if let Some(phone) = truthy_str(body, "phoneNumber")
                && str_field(&user, "phoneNumber") != Some(phone)
            {
                ensure!(
                    is_valid_phone(phone),
                    "INVALID_PHONE_NUMBER : Invalid format."
                );
                ensure!(
                    scope.project().get_user_by_phone_number(phone).is_none(),
                    "PHONE_NUMBER_EXISTS"
                );
                updates.insert("phoneNumber".to_owned(), json!(phone));
            }
            fields_to_copy.extend([
                "emailVerified",
                "customAttributes",
                "createdAt",
                "lastLoginAt",
                "validSince",
            ]);
        }
        for field in fields_to_copy {
            if body.get(field).is_some_and(|value| !value.is_null()) {
                mirror_field(&mut updates, field, body);
            }
        }
        for attribute in &delete_attributes {
            match attribute.as_str() {
                "DISPLAY_NAME" => {
                    updates.insert("displayName".to_owned(), JsonValue::Null);
                }
                "PHOTO_URL" => {
                    updates.insert("photoUrl".to_owned(), JsonValue::Null);
                }
                "PASSWORD" => {
                    updates.insert("passwordHash".to_owned(), JsonValue::Null);
                    updates.insert("salt".to_owned(), JsonValue::Null);
                }
                "EMAIL" => {
                    updates.insert("email".to_owned(), JsonValue::Null);
                    updates.insert("emailVerified".to_owned(), JsonValue::Null);
                    updates.insert("emailLinkSignin".to_owned(), JsonValue::Null);
                }
                _ => {}
            }
        }
        let delete_provider: Vec<String> = body
            .get("deleteProvider")
            .and_then(JsonValue::as_array)
            .map(|list| {
                list.iter()
                    .filter_map(JsonValue::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default();
        if delete_provider
            .iter()
            .any(|provider| provider == PROVIDER_PASSWORD)
        {
            for field in [
                "email",
                "emailVerified",
                "emailLinkSignin",
                "passwordHash",
                "salt",
            ] {
                updates.insert(field.to_owned(), JsonValue::Null);
            }
        }
        if delete_provider
            .iter()
            .any(|provider| provider == PROVIDER_PHONE)
        {
            updates.insert("phoneNumber".to_owned(), JsonValue::Null);
        }
        if let Some(delete_passkey) = body
            .get("deletePasskey")
            .filter(|value| truthy(Some(value)))
            .and_then(JsonValue::as_array)
        {
            let remove: Vec<&str> = delete_passkey
                .iter()
                .filter_map(JsonValue::as_str)
                .collect();
            let kept: Vec<JsonValue> = passkeys(&user)
                .into_iter()
                .filter(|key| {
                    truthy_str(key, "credentialId")
                        .is_some_and(|credential| !remove.contains(&credential))
                })
                .map(JsonValue::Object)
                .collect();
            updates.insert("passkeyInfo".to_owned(), JsonValue::Array(kept));
        }
    }
    let link = body
        .get("linkProviderUserInfo")
        .and_then(JsonValue::as_object)
        .filter(|_| truthy(body.get("linkProviderUserInfo")));
    if let Some(link) = link {
        ensure!(truthy(link.get("providerId")), "MISSING_PROVIDER_ID");
        ensure!(truthy(link.get("rawId")), "MISSING_RAW_ID");
    }
    let delete_providers: Vec<String> = body
        .get("deleteProvider")
        .and_then(JsonValue::as_array)
        .map(|list| {
            list.iter()
                .filter_map(JsonValue::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let local_id = str_field(&user, "localId").unwrap_or_default().to_owned();
    let upserts: Vec<ProviderInfo> = link.map(|info| vec![info.clone()]).unwrap_or_default();
    user = scope.project().update_user_by_local_id(
        &local_id,
        &updates,
        UpdateOptions {
            upsert_providers: upserts,
            delete_providers: delete_providers.iter().map(String::as_str).collect(),
        },
    )?;
    if sign_in_provider.as_deref() != Some(PROVIDER_ANONYMOUS)
        && truthy(user.get("initialEmail"))
        && is_email_update
    {
        let Some(emulator_url) = emulator_url else {
            return Err(ApiError::unknown(
                "Internal assertion error: missing emulatorUrl param",
                "Error",
            ));
        };
        let initial = truthy_str(&user, "initialEmail")
            .unwrap_or_default()
            .to_owned();
        let record = create_oob_record(
            scope,
            &initial,
            emulator_url,
            "RECOVER_EMAIL",
            "recoverEmail",
            None,
            None,
        );
        log_oob_message(rt, &record);
    }
    let mut response = JsonMap::new();
    response.insert(
        "kind".to_owned(),
        json!("identitytoolkit#SetAccountInfoResponse"),
    );
    response.insert("localId".to_owned(), json!(local_id));
    super::insert_opt(
        &mut response,
        "emailVerified",
        user.get("emailVerified").cloned(),
    );
    super::insert_opt(
        &mut response,
        "providerUserInfo",
        user.get("providerUserInfo").cloned(),
    );
    super::insert_opt(&mut response, "email", user.get("email").cloned());
    super::insert_opt(
        &mut response,
        "displayName",
        user.get("displayName").cloned(),
    );
    super::insert_opt(&mut response, "photoUrl", user.get("photoUrl").cloned());
    super::insert_opt(&mut response, "newEmail", new_email.map(JsonValue::String));
    super::insert_opt(
        &mut response,
        "passwordHash",
        user.get("passwordHash").cloned(),
    );
    if truthy(updates.get("validSince"))
        && let Some(provider) = &sign_in_provider
    {
        let tokens = issue_tokens(scope, &user, provider, &IssueOptions::default())?;
        tokens.apply(&mut response);
    }
    Ok(JsonValue::Object(response))
}
