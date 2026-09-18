//! `signUp` (`identitytoolkit.accounts.signUp` and the privileged
//! `projects.accounts` create).

use serde_json::{Map as JsonMap, Value as JsonValue, json};

use super::{
    Ctx, PASSWORD_MIN_LENGTH, fake_salt, hash_password, mfa_enrollments_from_request,
    mirror_request,
};
use crate::Runtime;
use crate::blocking::{BlockingContext, OauthTokens};
use crate::error::{ApiError, ensure, require};
use crate::state::{
    BlockingEvent, PROVIDER_ANONYMOUS, PROVIDER_PASSWORD, UpdateOptions, UserRecord,
};
use crate::token::{IssueOptions, issue_tokens, parse_id_token};
use crate::util::{
    canonicalize_email, is_valid_email, is_valid_phone, now_millis, now_seconds, truthy,
};

pub async fn sign_up(rt: &Runtime, ctx: &Ctx) -> Result<JsonValue, ApiError> {
    let now = now_millis();
    let body = &ctx.body;
    let has_id_token = ctx.body_truthy("idToken");
    let has_password = ctx.body_truthy("password");
    let has_email = ctx.body_truthy("email");
    let local_id_param = ctx.body_truthy_str("localId").map(str::to_owned);

    // Validation and the pending record, under the lock.
    let (mut updates, provider, existing_user, local_id) = rt.scope(ctx, |scope| {
        ensure!(!scope.disable_auth(), "PROJECT_DISABLED");
        let mut provider: Option<&'static str> = None;
        let mut updates = UserRecord::new();
        updates.insert("lastLoginAt".to_owned(), json!(now.to_string()));
        if ctx.privileged {
            if has_id_token {
                ensure!(local_id_param.is_none(), "UNEXPECTED_PARAMETER : User ID");
            }
            if let Some(local_id) = &local_id_param {
                ensure!(
                    scope.project().get_user_by_local_id(local_id).is_none(),
                    "DUPLICATE_LOCAL_ID"
                );
            }
            mirror_request(&mut updates, "displayName", body);
            mirror_request(&mut updates, "photoUrl", body);
            updates.insert(
                "emailVerified".to_owned(),
                json!(ctx.body_truthy("emailVerified")),
            );
            if let Some(phone) = ctx.body_truthy_str("phoneNumber") {
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
            if ctx.body_truthy("disabled") {
                updates.insert("disabled".to_owned(), json!(true));
            }
        } else {
            ensure!(local_id_param.is_none(), "UNEXPECTED_PARAMETER : User ID");
            if has_id_token || has_password || has_email {
                mirror_request(&mut updates, "displayName", body);
                updates.insert("emailVerified".to_owned(), json!(false));
                ensure!(has_email, "MISSING_EMAIL");
                ensure!(has_password, "MISSING_PASSWORD");
                provider = Some(PROVIDER_PASSWORD);
                ensure!(scope.allow_password_signup(), "OPERATION_NOT_ALLOWED");
            } else {
                provider = Some(PROVIDER_ANONYMOUS);
                ensure!(scope.enable_anonymous_user(), "ADMIN_ONLY_OPERATION");
            }
        }
        let email_is_empty_string = body.get("email").and_then(JsonValue::as_str) == Some("");
        if has_email || (email_is_empty_string && provider.is_some()) {
            let email = ctx.body_str("email").unwrap_or_default();
            ensure!(is_valid_email(email), "INVALID_EMAIL");
            let email = canonicalize_email(email);
            ensure!(
                scope.project().get_user_by_email(&email).is_none(),
                "EMAIL_EXISTS"
            );
            updates.insert("email".to_owned(), json!(email));
        }
        if let Some(password) = ctx.body_truthy_str("password") {
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
            updates.insert("passwordUpdatedAt".to_owned(), json!(now));
            updates.insert("validSince".to_owned(), json!(now_seconds().to_string()));
        }
        if let Some(enrollments) = body
            .get("mfaInfo")
            .and_then(JsonValue::as_array)
            .filter(|list| !list.is_empty())
        {
            updates.insert(
                "mfaInfo".to_owned(),
                JsonValue::Array(mfa_enrollments_from_request(enrollments, true)?),
            );
        }
        if let Some(tenant) = &scope.tenant_id {
            updates.insert("tenantId".to_owned(), json!(tenant));
        }
        let existing = if has_id_token {
            Some(parse_id_token(scope, ctx.body_str("idToken").unwrap_or_default())?.user)
        } else {
            None
        };
        let local_id = if existing.is_none() {
            Some(
                local_id_param
                    .clone()
                    .unwrap_or_else(|| scope.project().generate_local_id()),
            )
        } else {
            None
        };
        Ok((updates, provider, existing, local_id))
    })?;

    let blocked = has_email && !ctx.privileged;
    let context = BlockingContext {
        sign_in_method: Some("password".to_owned()),
        ..BlockingContext::default()
    };
    let mut extra_claims = None;
    let user = match existing_user {
        None => {
            let Some(local_id) = local_id else {
                return Err(ApiError::unknown(
                    "Internal assertion error: missing localId",
                    "unknown",
                ));
            };
            updates.insert("createdAt".to_owned(), json!(now.to_string()));
            if blocked {
                let mut before_create = UserRecord::new();
                before_create.insert("localId".to_owned(), json!(local_id));
                for (key, value) in &updates {
                    before_create.insert(key.clone(), value.clone());
                }
                let outcome = rt
                    .blocking(
                        ctx,
                        BlockingEvent::BeforeCreate,
                        &before_create,
                        &context,
                        &OauthTokens::default(),
                    )
                    .await?;
                for (key, value) in outcome.updates {
                    updates.insert(key, value);
                }
            }
            let mut user = rt.scope(ctx, |scope| {
                let created = scope
                    .project()
                    .create_user_with_local_id(&local_id, &updates)?;
                Ok(require!(created, "DUPLICATE_LOCAL_ID"))
            })?;
            if blocked {
                if !truthy(user.get("disabled")) {
                    let outcome = rt
                        .blocking(
                            ctx,
                            BlockingEvent::BeforeSignIn,
                            &user,
                            &context,
                            &OauthTokens::default(),
                        )
                        .await?;
                    extra_claims = outcome.extra_claims;
                    let local_id = local_id.clone();
                    user = rt.scope(ctx, |scope| {
                        scope.project().update_user_by_local_id(
                            &local_id,
                            &outcome.updates,
                            UpdateOptions::default(),
                        )
                    })?;
                }
                ensure!(!truthy(user.get("disabled")), "USER_DISABLED");
            }
            user
        }
        Some(existing) => {
            let local_id = existing
                .get("localId")
                .and_then(JsonValue::as_str)
                .unwrap_or_default()
                .to_owned();
            rt.scope(ctx, |scope| {
                scope.project().update_user_by_local_id(
                    &local_id,
                    &updates.clone(),
                    UpdateOptions::default(),
                )
            })?
        }
    };

    rt.scope(ctx, |scope| {
        let mut response = JsonMap::new();
        response.insert(
            "kind".to_owned(),
            json!("identitytoolkit#SignupNewUserResponse"),
        );
        response.insert(
            "localId".to_owned(),
            user.get("localId").cloned().unwrap_or(JsonValue::Null),
        );
        super::insert_opt(
            &mut response,
            "displayName",
            user.get("displayName").cloned(),
        );
        super::insert_opt(&mut response, "email", user.get("email").cloned());
        if let Some(provider) = provider {
            let tokens = issue_tokens(
                scope,
                &user,
                provider,
                &IssueOptions {
                    extra_claims: extra_claims.clone(),
                    ..IssueOptions::default()
                },
            )?;
            tokens.apply(&mut response);
        }
        Ok(JsonValue::Object(response))
    })
}
