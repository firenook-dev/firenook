//! Account management: lookup, delete, import/export batches, query,
//! session cookies, project discovery and reCAPTCHA parameters.

use serde_json::{Map as JsonMap, Value as JsonValue, json};

use super::{
    Ctx, fake_salt, hash_password, new_random_id, user_response, validate_serialized_custom_claims,
};
use crate::Runtime;
use crate::error::{ApiError, ensure, require};
use crate::state::{PROJECT_NUMBER, PROVIDER_PASSWORD, PROVIDER_PHONE, QueryOrder, UserRecord};
use crate::token::{parse_id_token, session_cookie};
use crate::util::{
    canonicalize_email, is_valid_email, is_valid_phone, now_iso, now_millis, now_seconds,
    str_field, truthy, truthy_str,
};

const SESSION_COOKIE_MIN_VALID_DURATION: i64 = 5 * 60;
pub const SESSION_COOKIE_MAX_VALID_DURATION: i64 = 14 * 24 * 60 * 60;

fn string_list(body: &JsonMap<String, JsonValue>, field: &str) -> Vec<String> {
    body.get(field)
        .and_then(JsonValue::as_array)
        .map(|list| {
            list.iter()
                .filter_map(JsonValue::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

pub fn lookup(rt: &Runtime, ctx: &Ctx) -> Result<JsonValue, ApiError> {
    rt.scope(ctx, |scope| {
        ensure!(!scope.disable_auth(), "PROJECT_DISABLED");
        let mut users: Vec<UserRecord> = Vec::new();
        let mut seen: Vec<String> = Vec::new();
        let mut add = |user: Option<UserRecord>| {
            if let Some(user) = user {
                let id = str_field(&user, "localId").unwrap_or_default().to_owned();
                if !seen.contains(&id) {
                    seen.push(id);
                    users.push(user);
                }
            }
        };
        if ctx.privileged {
            if ctx
                .body
                .get("initialEmail")
                .is_some_and(|value| truthy(Some(value)))
            {
                return Err(ApiError::not_implemented(
                    "Lookup by initialEmail is not implemented.",
                ));
            }
            for local_id in string_list(&ctx.body, "localId") {
                add(scope.project().get_user_by_local_id(&local_id));
            }
            for email in string_list(&ctx.body, "email") {
                add(scope
                    .project()
                    .get_user_by_email(&canonicalize_email(&email)));
            }
            for phone in string_list(&ctx.body, "phoneNumber") {
                add(scope.project().get_user_by_phone_number(&phone));
            }
            for federated in ctx
                .body
                .get("federatedUserId")
                .and_then(JsonValue::as_array)
                .into_iter()
                .flatten()
            {
                let provider = federated
                    .get("providerId")
                    .and_then(JsonValue::as_str)
                    .filter(|value| !value.is_empty());
                let raw = federated
                    .get("rawId")
                    .and_then(JsonValue::as_str)
                    .filter(|value| !value.is_empty());
                if let (Some(provider), Some(raw)) = (provider, raw) {
                    add(scope.project().get_user_by_provider_raw_id(provider, raw));
                }
            }
        } else {
            ensure!(ctx.body_truthy("idToken"), "MISSING_ID_TOKEN");
            let parsed = parse_id_token(scope, ctx.body_str("idToken").unwrap_or_default())?;
            add(Some(parsed.user));
        }
        let mut response = json!({ "kind": "identitytoolkit#GetAccountInfoResponse" });
        if !users.is_empty() {
            response["users"] = JsonValue::Array(users.iter().map(user_response).collect());
        }
        Ok(response)
    })
}

pub fn delete_account(rt: &Runtime, ctx: &Ctx) -> Result<JsonValue, ApiError> {
    rt.scope(ctx, |scope| {
        ensure!(!scope.disable_auth(), "PROJECT_DISABLED");
        let user = if ctx.privileged {
            let local_id = ctx.body_truthy_str("localId");
            ensure!(local_id.is_some(), "MISSING_LOCAL_ID");
            let maybe = scope
                .project()
                .get_user_by_local_id(local_id.unwrap_or_default());
            require!(maybe, "USER_NOT_FOUND")
        } else {
            ensure!(ctx.body_truthy("idToken"), "MISSING_ID_TOKEN");
            parse_id_token(scope, ctx.body_str("idToken").unwrap_or_default())?.user
        };
        scope.project().delete_user(&user);
        Ok(json!({ "kind": "identitytoolkit#DeleteAccountResponse" }))
    })
}

pub fn batch_create(rt: &Runtime, ctx: &Ctx) -> Result<JsonValue, ApiError> {
    rt.scope(ctx, |scope| {
        ensure!(!scope.disable_auth(), "PROJECT_DISABLED");
        let users = ctx
            .body
            .get("users")
            .and_then(JsonValue::as_array)
            .cloned()
            .unwrap_or_default();
        ensure!(!users.is_empty(), "MISSING_USER_ACCOUNT");
        let users: Vec<JsonMap<String, JsonValue>> = users
            .into_iter()
            .map(|user| user.as_object().cloned().unwrap_or_default())
            .collect();
        if ctx.body_truthy("sanityCheck") {
            if scope.one_account_per_email() {
                let mut emails: Vec<String> = Vec::new();
                for user in &users {
                    if let Some(email) = truthy_str(user, "email") {
                        ensure!(
                            !emails.contains(&email.to_owned()),
                            format!("DUPLICATE_EMAIL : {email}")
                        );
                        emails.push(email.to_owned());
                    }
                }
            }
            let mut providers: Vec<String> = Vec::new();
            for user in &users {
                for info in crate::state::provider_infos(user) {
                    let provider = str_field(&info, "providerId").unwrap_or_default();
                    let raw = str_field(&info, "rawId").unwrap_or_default();
                    let key = format!("{provider}:{raw}");
                    ensure!(
                        !providers.contains(&key),
                        format!("DUPLICATE_RAW_ID : Provider id({provider}), Raw id({raw})")
                    );
                    providers.push(key);
                }
            }
        }
        if !ctx.body_truthy("allowOverwrite") {
            let mut ids: Vec<String> = Vec::new();
            for user in &users {
                let local_id = str_field(user, "localId").unwrap_or_default().to_owned();
                ensure!(
                    !ids.contains(&local_id),
                    format!("DUPLICATE_LOCAL_ID : {local_id}")
                );
                ids.push(local_id);
            }
        }
        let mut errors = Vec::new();
        for (index, user) in users.iter().enumerate() {
            if let Err(error) = import_one(
                scope,
                user,
                ctx.body_truthy("allowOverwrite"),
                ctx.body_truthy("sanityCheck"),
            ) {
                if error.is_bad_request() {
                    let message = match error.message.as_str() {
                        "INVALID_CLAIMS" => "Invalid custom claims provided.",
                        "CLAIMS_TOO_LARGE" => "Custom claims provided are too large.",
                        other if other.starts_with("FORBIDDEN_CLAIM") => {
                            "Custom claims provided include a reserved claim."
                        }
                        other => other,
                    };
                    errors.push(json!({ "index": index, "message": message }));
                } else {
                    return Err(error);
                }
            }
        }
        Ok(json!({ "kind": "identitytoolkit#UploadAccountResponse", "error": errors }))
    })
}

fn import_one(
    scope: &mut crate::state::Scope<'_>,
    info: &JsonMap<String, JsonValue>,
    allow_overwrite: bool,
    sanity_check: bool,
) -> Result<(), ApiError> {
    let local_id = truthy_str(info, "localId");
    ensure!(local_id.is_some(), "localId is missing");
    let local_id = local_id.unwrap_or_default().to_owned();
    let upload_time = now_millis();
    let mut fields = UserRecord::new();
    for field in ["displayName", "photoUrl", "lastLoginAt"] {
        fields.insert(
            field.to_owned(),
            info.get(field).cloned().unwrap_or(JsonValue::Null),
        );
    }
    if let Some(tenant) = truthy_str(info, "tenantId") {
        ensure!(
            scope.is_tenant() && scope.tenant_id.as_deref() == Some(tenant),
            "Tenant id in userInfo does not match the tenant id in request."
        );
    }
    if let Some(tenant) = &scope.tenant_id {
        fields.insert("tenantId".to_owned(), json!(tenant));
    }
    if let Some(hash) = truthy_str(info, "passwordHash") {
        fields.insert("passwordHash".to_owned(), json!(hash));
        fields.insert(
            "salt".to_owned(),
            info.get("salt").cloned().unwrap_or(JsonValue::Null),
        );
        fields.insert("passwordUpdatedAt".to_owned(), json!(upload_time));
    } else if let Some(raw_password) = truthy_str(info, "rawPassword") {
        let salt = truthy_str(info, "salt").map_or_else(fake_salt, str::to_owned);
        fields.insert(
            "passwordHash".to_owned(),
            json!(hash_password(raw_password, &salt)),
        );
        fields.insert("salt".to_owned(), json!(salt));
        fields.insert("passwordUpdatedAt".to_owned(), json!(upload_time));
    }
    if let Some(claims) = truthy_str(info, "customAttributes") {
        validate_serialized_custom_claims(claims)?;
        fields.insert("customAttributes".to_owned(), json!(claims));
    }
    if info
        .get("providerUserInfo")
        .is_some_and(|value| truthy(Some(value)))
    {
        let mut providers = Vec::new();
        for entry in crate::state::provider_infos(info) {
            let provider = truthy_str(&entry, "providerId");
            let raw = truthy_str(&entry, "rawId");
            if provider == Some(PROVIDER_PASSWORD) || provider == Some(PROVIDER_PHONE) {
                continue;
            }
            if raw.is_none() || provider.is_none() {
                if !truthy(entry.get("federatedId")) {
                    return Err(ApiError::bad_request(
                        "federatedId or (providerId & rawId) is required",
                    ));
                }
                return Err(ApiError::bad_request(
                    "((Parsing federatedId is not implemented in Auth Emulator; please specify providerId AND rawId as a workaround.))",
                ));
            }
            let provider = provider.unwrap_or_default();
            let raw = raw.unwrap_or_default();
            let existing = scope.project().get_user_by_provider_raw_id(provider, raw);
            ensure!(
                existing.is_none_or(
                    |existing| str_field(&existing, "localId") == Some(local_id.as_str())
                ),
                "raw id exists in other account in database"
            );
            let mut entry = entry.clone();
            entry.insert("providerId".to_owned(), json!(provider));
            entry.insert("rawId".to_owned(), json!(raw));
            providers.push(JsonValue::Object(entry));
        }
        fields.insert("providerUserInfo".to_owned(), JsonValue::Array(providers));
    }
    if let Some(phone) = truthy_str(info, "phoneNumber") {
        ensure!(is_valid_phone(phone), "phone number format is invalid");
        fields.insert("phoneNumber".to_owned(), json!(phone));
    }
    fields.insert("validSince".to_owned(), json!(now_seconds().to_string()));
    fields.insert("createdAt".to_owned(), json!(upload_time.to_string()));
    if let Some(created) = info.get("createdAt")
        && created_is_numeric(created)
    {
        fields.insert("createdAt".to_owned(), created.clone());
    }
    if let Some(email) = truthy_str(info, "email") {
        ensure!(is_valid_email(email), "email is invalid");
        let existing = scope.project().get_user_by_email(email);
        ensure!(
            existing
                .is_none_or(|existing| str_field(&existing, "localId") == Some(local_id.as_str())),
            if sanity_check && scope.one_account_per_email() {
                "email exists in other account in database".to_owned()
            } else {
                format!("((Auth Emulator does not support importing duplicate email: {email}))")
            }
        );
        fields.insert("email".to_owned(), json!(canonicalize_email(email)));
    }
    fields.insert(
        "emailVerified".to_owned(),
        json!(truthy(info.get("emailVerified"))),
    );
    fields.insert("disabled".to_owned(), json!(truthy(info.get("disabled"))));
    if let Some(enrollments) = info
        .get("mfaInfo")
        .and_then(JsonValue::as_array)
        .filter(|list| !list.is_empty())
    {
        ensure!(
            truthy(fields.get("email")),
            "Second factor account requires email to be presented."
        );
        ensure!(
            truthy(fields.get("emailVerified")),
            "Second factor account requires email to be verified."
        );
        let mut existing_ids: Vec<String> = Vec::new();
        for enrollment in enrollments {
            if let Some(id) = enrollment
                .get("mfaEnrollmentId")
                .and_then(JsonValue::as_str)
                .filter(|id| !id.is_empty())
            {
                ensure!(
                    !existing_ids.contains(&id.to_owned()),
                    "Enrollment id already exists."
                );
                existing_ids.push(id.to_owned());
            }
        }
        let mut imported = Vec::new();
        for enrollment in enrollments {
            let mut entry = enrollment.as_object().cloned().unwrap_or_default();
            let id = truthy_str(&entry, "mfaEnrollmentId")
                .map_or_else(|| new_random_id(28, &existing_ids), str::to_owned);
            entry.insert("mfaEnrollmentId".to_owned(), json!(id));
            let enrolled_at = truthy_str(&entry, "enrolledAt").map_or_else(now_iso, str::to_owned);
            entry.insert("enrolledAt".to_owned(), json!(enrolled_at));
            let phone = truthy_str(&entry, "phoneInfo").map(str::to_owned);
            let phone = require!(phone, "Second factor not supported.");
            ensure!(is_valid_phone(&phone), "Phone number format is invalid");
            entry.insert("unobfuscatedPhoneInfo".to_owned(), json!(phone));
            imported.push(JsonValue::Object(entry));
        }
        fields.insert("mfaInfo".to_owned(), JsonValue::Array(imported));
    }
    if scope.project().get_user_by_local_id(&local_id).is_some() {
        ensure!(
            allow_overwrite,
            "localId belongs to an existing account - can not overwrite."
        );
    }
    scope
        .project()
        .overwrite_user_with_local_id(&local_id, &fields)?;
    Ok(())
}

/// `!isNaN(Number(userInfo.createdAt))` for a present field.
fn created_is_numeric(value: &JsonValue) -> bool {
    match value {
        JsonValue::Number(_) | JsonValue::Bool(_) | JsonValue::Null => true,
        JsonValue::String(text) => !text.trim().is_empty() && text.trim().parse::<f64>().is_ok(),
        JsonValue::Array(_) | JsonValue::Object(_) => false,
    }
}

pub fn batch_delete(rt: &Runtime, ctx: &Ctx) -> Result<JsonValue, ApiError> {
    rt.scope(ctx, |scope| {
        let local_ids = string_list(&ctx.body, "localIds");
        ensure!(
            !local_ids.is_empty() && local_ids.len() <= 1000,
            "LOCAL_ID_LIST_EXCEEDS_LIMIT"
        );
        let force = ctx.body_truthy("force");
        let mut errors = Vec::new();
        for (index, local_id) in local_ids.iter().enumerate() {
            let Some(user) = scope.project().get_user_by_local_id(local_id) else {
                continue;
            };
            if !truthy(user.get("disabled")) && !force {
                errors.push(json!({
                    "index": index,
                    "localId": local_id,
                    "message": "NOT_DISABLED : Disable the account before batch deletion.",
                }));
            } else {
                scope.project().delete_user(&user);
            }
        }
        let mut response = JsonMap::new();
        if !errors.is_empty() {
            response.insert("errors".to_owned(), JsonValue::Array(errors));
        }
        Ok(JsonValue::Object(response))
    })
}

pub fn batch_get(rt: &Runtime, ctx: &Ctx) -> Result<JsonValue, ApiError> {
    rt.scope(ctx, |scope| {
        ensure!(!scope.disable_auth(), "PROJECT_DISABLED");
        let max_results = ctx
            .query
            .get("maxResults")
            .and_then(JsonValue::as_i64)
            .filter(|value| *value != 0)
            .unwrap_or(20)
            .min(1000);
        let start = ctx.query_str("nextPageToken").map(str::to_owned);
        let query_tenant = ctx.query_str("tenantId").map(str::to_owned);
        let mut users = if let Some(tenant) = query_tenant.filter(|_| !scope.is_tenant()) {
            let project_id = scope.project_id.clone();
            let mut tenant_scope =
                crate::state::Scope::new_in(scope.agent(), &project_id, Some(&tenant));
            tenant_scope
                .project()
                .query_users(QueryOrder::Asc, start.as_deref())
        } else {
            scope
                .project()
                .query_users(QueryOrder::Asc, start.as_deref())
        };
        let mut next_page_token = None;
        if max_results >= 0 && i64::try_from(users.len()).unwrap_or(i64::MAX) >= max_results {
            users.truncate(usize::try_from(max_results).unwrap_or(0));
            if let Some(last) = users.last() {
                next_page_token = str_field(last, "localId").map(str::to_owned);
            }
        }
        let mut response = json!({
            "kind": "identitytoolkit#DownloadAccountResponse",
            "users": users.iter().map(user_response).collect::<Vec<_>>(),
        });
        if let Some(token) = next_page_token {
            response["nextPageToken"] = json!(token);
        }
        Ok(response)
    })
}

pub fn query_accounts(rt: &Runtime, ctx: &Ctx) -> Result<JsonValue, ApiError> {
    rt.scope(ctx, |scope| {
        ensure!(!scope.disable_auth(), "PROJECT_DISABLED");
        if ctx
            .body
            .get("expression")
            .and_then(JsonValue::as_array)
            .is_some_and(|list| !list.is_empty())
        {
            return Err(ApiError::not_implemented("expression is not implemented."));
        }
        if ctx.body.get("returnUserInfo") == Some(&JsonValue::Bool(false)) {
            return Ok(json!({ "recordsCount": scope.project().user_count().to_string() }));
        }
        if ctx.body_truthy("limit") {
            return Err(ApiError::not_implemented("limit is not implemented."));
        }
        let offset = ctx.body_truthy_str("offset").unwrap_or("0");
        if offset != "0" {
            return Err(ApiError::not_implemented("offset is not implemented."));
        }
        let order = if ctx.body_truthy_str("order") == Some("DESC") {
            QueryOrder::Desc
        } else {
            QueryOrder::Asc
        };
        let sort_by = ctx.body_truthy_str("sortBy").unwrap_or("USER_ID");
        let sort_by = if sort_by == "SORT_BY_FIELD_UNSPECIFIED" {
            "USER_ID"
        } else {
            sort_by
        };
        if sort_by != "USER_ID" {
            return Err(ApiError::not_implemented(
                "Only sorting by USER_ID is implemented.",
            ));
        }
        let users = scope.project().query_users(order, None);
        Ok(json!({
            "recordsCount": users.len().to_string(),
            "userInfo": users.iter().map(user_response).collect::<Vec<_>>(),
        }))
    })
}

pub fn create_session_cookie(rt: &Runtime, ctx: &Ctx) -> Result<JsonValue, ApiError> {
    rt.scope(ctx, |scope| {
        ensure!(ctx.body_truthy("idToken"), "MISSING_ID_TOKEN");
        let valid_duration = match ctx.body.get("validDuration") {
            Some(JsonValue::String(text)) => text.parse::<f64>().ok(),
            Some(JsonValue::Number(number)) => number.as_f64(),
            _ => None,
        }
        .filter(|value| *value != 0.0)
        .map_or(SESSION_COOKIE_MAX_VALID_DURATION, |value| {
            #[allow(clippy::cast_possible_truncation)]
            let seconds = value.trunc() as i64;
            seconds
        });
        ensure!(
            (SESSION_COOKIE_MIN_VALID_DURATION..=SESSION_COOKIE_MAX_VALID_DURATION)
                .contains(&valid_duration),
            "INVALID_DURATION"
        );
        let parsed = parse_id_token(scope, ctx.body_str("idToken").unwrap_or_default())?;
        Ok(json!({ "sessionCookie": session_cookie(&parsed.payload, valid_duration) }))
    })
}

pub fn get_projects(rt: &Runtime, ctx: &Ctx) -> Result<JsonValue, ApiError> {
    rt.scope(ctx, |scope| {
        ensure!(!scope.disable_auth(), "PROJECT_DISABLED");
        ensure!(!scope.is_tenant(), "UNSUPPORTED_TENANT_OPERATION");
        Ok(json!({ "projectId": PROJECT_NUMBER, "authorizedDomains": ["localhost"] }))
    })
}

pub fn get_recaptcha_params(rt: &Runtime, ctx: &Ctx) -> Result<JsonValue, ApiError> {
    rt.scope(ctx, |scope| {
        ensure!(!scope.disable_auth(), "PROJECT_DISABLED");
        Ok(json!({
            "kind": "identitytoolkit#GetRecaptchaParamResponse",
            "recaptchaStoken": "This-is-a-fake-token__Dont-send-this-to-the-Recaptcha-service__The-Auth-Emulator-does-not-support-Recaptcha",
            "recaptchaSiteKey": "Fake-key__Do-not-send-this-to-Recaptcha_",
        }))
    })
}
