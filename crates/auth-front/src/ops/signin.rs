//! Sign-in operations: password, custom token, email link, phone, federated
//! identity providers, `createAuthUri` and the secure-token refresh grant.

use serde_json::{Map as JsonMap, Value as JsonValue, json};

use super::{
    Ctx, insert_opt, is_mfa_enabled, mfa_pending, validate_custom_claims, verify_phone_number,
};
use crate::Runtime;
use crate::blocking::{BlockingContext, OauthTokens};
use crate::error::{ApiError, ensure, require};
use crate::state::{
    BlockingEvent, PROVIDER_CUSTOM, PROVIDER_PASSWORD, PROVIDER_PHONE, ProviderInfo,
    SIGNIN_METHOD_EMAIL_LINK, UpdateOptions, UserRecord,
};
use crate::token::{
    CUSTOM_TOKEN_AUDIENCE, IssueOptions, decode_refresh_token, issue_tokens, parse_id_token,
};
use crate::util::{
    OrderedJson, canonicalize_email, coerce_primitive_to_string, decode_jwt, is_valid_email,
    is_valid_phone, now_millis, now_seconds, str_field, stringify_ordered, truthy, truthy_str,
};
use base64::Engine as _;

fn local_id_of(user: &UserRecord) -> String {
    str_field(user, "localId").unwrap_or_default().to_owned()
}

// ---------------------------------------------------------------- password

pub async fn sign_in_with_password(rt: &Runtime, ctx: &Ctx) -> Result<JsonValue, ApiError> {
    let (user, email) = rt.scope(ctx, |scope| {
        ensure!(!scope.disable_auth(), "PROJECT_DISABLED");
        ensure!(scope.allow_password_signup(), "PASSWORD_LOGIN_DISABLED");
        let email = ctx.body_str("email");
        ensure!(email.is_some(), "MISSING_EMAIL");
        let email = email.unwrap_or_default();
        ensure!(is_valid_email(email), "INVALID_EMAIL");
        ensure!(ctx.body_truthy("password"), "MISSING_PASSWORD");
        if ctx.body_truthy("captchaResponse") || ctx.body_truthy("captchaChallenge") {
            return Err(ApiError::not_implemented("captcha unimplemented"));
        }
        if ctx.body_truthy("idToken") || ctx.body_truthy("pendingIdToken") {
            return Err(ApiError::not_implemented(
                "idToken / pendingIdToken is no longer in use and unsupported by the Auth Emulator.",
            ));
        }
        let email = canonicalize_email(email);
        let user = scope.project().get_user_by_email(&email);
        let password = ctx.body_str("password").unwrap_or_default();
        if scope.improved_email_privacy() {
            let user = require!(user, "INVALID_LOGIN_CREDENTIALS");
            ensure!(!truthy(user.get("disabled")), "USER_DISABLED");
            let salt = truthy_str(&user, "salt");
            ensure!(truthy(user.get("passwordHash")) && salt.is_some(), "INVALID_LOGIN_CREDENTIALS");
            ensure!(super::password_matches(&user, password), "INVALID_LOGIN_CREDENTIALS");
            Ok((user, email))
        } else {
            let user = require!(user, "EMAIL_NOT_FOUND");
            ensure!(!truthy(user.get("disabled")), "USER_DISABLED");
            let salt = truthy_str(&user, "salt");
            ensure!(truthy(user.get("passwordHash")) && salt.is_some(), "INVALID_PASSWORD");
            ensure!(super::password_matches(&user, password), "INVALID_PASSWORD");
            Ok((user, email))
        }
    })?;
    let mut response = JsonMap::new();
    response.insert(
        "kind".to_owned(),
        json!("identitytoolkit#VerifyPasswordResponse"),
    );
    response.insert("registered".to_owned(), json!(true));
    response.insert("localId".to_owned(), json!(local_id_of(&user)));
    response.insert("email".to_owned(), json!(email));
    let pending = rt.scope(ctx, |scope| Ok(is_mfa_enabled(scope, &user)))?;
    if pending {
        return rt.scope(ctx, |scope| {
            response.extend(mfa_pending(scope, &user, PROVIDER_PASSWORD));
            Ok(JsonValue::Object(response))
        });
    }
    let outcome = rt
        .blocking(
            ctx,
            BlockingEvent::BeforeSignIn,
            &user,
            &BlockingContext {
                sign_in_method: Some("password".to_owned()),
                ..BlockingContext::default()
            },
            &OauthTokens::default(),
        )
        .await?;
    rt.scope(ctx, |scope| {
        let mut updates = outcome.updates.clone();
        updates.insert("lastLoginAt".to_owned(), json!(now_millis().to_string()));
        // A legacy Fireside digest that just verified is rewritten in the
        // official format so the next export is portable.
        let password = ctx.body_str("password").unwrap_or_default();
        if let Some(salt) = truthy_str(&user, "salt")
            && str_field(&user, "passwordHash")
                != Some(super::hash_password(password, salt).as_str())
        {
            updates.insert(
                "passwordHash".to_owned(),
                json!(super::hash_password(password, salt)),
            );
        }
        let user = scope.project().update_user_by_local_id(
            &local_id_of(&user),
            &updates,
            UpdateOptions::default(),
        )?;
        ensure!(!truthy(user.get("disabled")), "USER_DISABLED");
        let tokens = issue_tokens(
            scope,
            &user,
            PROVIDER_PASSWORD,
            &IssueOptions {
                extra_claims: outcome.extra_claims.clone(),
                ..IssueOptions::default()
            },
        )?;
        tokens.apply(&mut response);
        Ok(JsonValue::Object(response))
    })
}

// ---------------------------------------------------------------- custom token

pub fn sign_in_with_custom_token(rt: &Runtime, ctx: &Ctx) -> Result<JsonValue, ApiError> {
    rt.scope(ctx, |scope| {
        ensure!(!scope.disable_auth(), "PROJECT_DISABLED");
        let token = ctx.body_truthy_str("token");
        ensure!(token.is_some(), "MISSING_CUSTOM_TOKEN");
        let token = token.unwrap_or_default();
        let payload: JsonMap<String, JsonValue> = if token.starts_with('{') {
            serde_json::from_str::<JsonValue>(token)
                .ok()
                .and_then(|value| value.as_object().cloned())
                .ok_or_else(|| {
                    ApiError::bad_request("INVALID_CUSTOM_TOKEN : ((Auth Emulator only accepts strict JSON or JWTs as fake custom tokens.))")
                })?
        } else {
            let decoded = decode_jwt(token);
            if scope.is_tenant() {
                let tenant_claim = decoded
                    .as_ref()
                    .and_then(|(_, payload)| payload.get("tenant_id").and_then(JsonValue::as_str).map(str::to_owned));
                ensure!(tenant_claim.as_deref() == scope.tenant_id.as_deref(), "TENANT_ID_MISMATCH");
            }
            let (header, payload) = require!(decoded, "INVALID_CUSTOM_TOKEN : Invalid assertion format");
            if header.get("alg").and_then(JsonValue::as_str) != Some("none") {
                rt.log("WARN", "Received a signed custom token. Auth Emulator does not validate JWTs and IS NOT SECURE");
            }
            let audience = payload.get("aud").and_then(JsonValue::as_str).unwrap_or_default().to_owned();
            ensure!(
                audience == CUSTOM_TOKEN_AUDIENCE,
                format!(
                    "INVALID_CUSTOM_TOKEN : ((Invalid aud (audience): {} Note: Firebase ID Tokens / third-party tokens cannot be used with signInWithCustomToken.))",
                    payload.get("aud").map_or_else(|| "undefined".to_owned(), json_display)
                )
            );
            payload.as_object().cloned().unwrap_or_default()
        };
        let local_id = coerce_primitive_to_string(payload.get("uid")).or_else(|| coerce_primitive_to_string(payload.get("user_id")));
        let local_id = require!(local_id.filter(|id| !id.is_empty()), "MISSING_IDENTIFIER");
        let mut extra_claims = JsonMap::new();
        if let Some(claims) = payload.get("claims") {
            validate_custom_claims(claims)?;
            extra_claims = claims.as_object().cloned().unwrap_or_default();
        }
        let existing = scope.project().get_user_by_local_id(&local_id);
        let is_new = existing.is_none();
        let now = now_millis();
        let mut updates = UserRecord::new();
        updates.insert("customAuth".to_owned(), json!(true));
        updates.insert("lastLoginAt".to_owned(), json!(now.to_string()));
        match &scope.tenant_id {
            Some(tenant) => updates.insert("tenantId".to_owned(), json!(tenant)),
            None => updates.insert("tenantId".to_owned(), JsonValue::Null),
        };
        let user = if let Some(user) = existing {
            ensure!(!truthy(user.get("disabled")), "USER_DISABLED");
            scope.project().update_user_by_local_id(&local_id, &updates, UpdateOptions::default())?
        } else {
            updates.insert("createdAt".to_owned(), json!(now.to_string()));
            scope
                .project()
                .create_user_with_local_id(&local_id, &updates)?
                .ok_or_else(|| ApiError::unknown(format!("Internal assertion error: trying to create duplicate localId: {local_id}"), "unknown"))?
        };
        let mut response = JsonMap::new();
        response.insert("kind".to_owned(), json!("identitytoolkit#VerifyCustomTokenResponse"));
        response.insert("isNewUser".to_owned(), json!(is_new));
        let tokens = issue_tokens(
            scope,
            &user,
            PROVIDER_CUSTOM,
            &IssueOptions {
                extra_claims: Some(extra_claims),
                ..IssueOptions::default()
            },
        )?;
        tokens.apply(&mut response);
        Ok(JsonValue::Object(response))
    })
}

/// JavaScript template-literal rendering of a JSON value.
fn json_display(value: &JsonValue) -> String {
    match value {
        JsonValue::String(text) => text.clone(),
        JsonValue::Null => "null".to_owned(),
        other => other.to_string(),
    }
}

// ---------------------------------------------------------------- email link

pub async fn sign_in_with_email_link(rt: &Runtime, ctx: &Ctx) -> Result<JsonValue, ApiError> {
    let (user_from_token, email, user_from_email) = rt.scope(ctx, |scope| {
        ensure!(!scope.disable_auth(), "PROJECT_DISABLED");
        ensure!(scope.enable_email_link_signin(), "OPERATION_NOT_ALLOWED");
        let user_from_token = match ctx.body_truthy_str("idToken") {
            Some(token) => Some(parse_id_token(scope, token)?.user),
            None => None,
        };
        let email = ctx.body_truthy_str("email");
        ensure!(email.is_some(), "MISSING_EMAIL");
        let email = canonicalize_email(email.unwrap_or_default());
        let code = ctx.body_truthy_str("oobCode");
        ensure!(code.is_some(), "MISSING_OOB_CODE");
        let code = code.unwrap_or_default();
        let oob = scope.project().validate_oob_code(code);
        let oob = require!(
            oob.filter(|oob| oob.request_type == "EMAIL_SIGNIN"),
            "INVALID_OOB_CODE"
        );
        ensure!(
            email == oob.email,
            "INVALID_EMAIL : The email provided does not match the sign-in email address."
        );
        scope.project().delete_oob_code(code);
        let user_from_email = scope.project().get_user_by_email(&email);
        Ok((user_from_token, email, user_from_email))
    })?;
    let context = BlockingContext {
        sign_in_method: Some("emailLink".to_owned()),
        ..BlockingContext::default()
    };
    let is_new = user_from_token.is_none() && user_from_email.is_none();
    let now = now_millis();
    let mut updates = UserRecord::new();
    updates.insert("email".to_owned(), json!(email));
    updates.insert("emailVerified".to_owned(), json!(true));
    updates.insert("emailLinkSignin".to_owned(), json!(true));
    if let Some(tenant) = &ctx.tenant_id {
        updates.insert("tenantId".to_owned(), json!(tenant));
    }
    let mut extra_claims = None;
    let user = if is_new {
        updates.insert("createdAt".to_owned(), json!(now.to_string()));
        let local_id = rt.scope(ctx, |scope| Ok(scope.project().generate_local_id()))?;
        let mut before_create = UserRecord::new();
        before_create.insert("localId".to_owned(), json!(local_id));
        before_create.extend(updates.clone());
        let outcome = rt
            .blocking(
                ctx,
                BlockingEvent::BeforeCreate,
                &before_create,
                &context,
                &OauthTokens::default(),
            )
            .await?;
        updates.extend(outcome.updates);
        let user = rt.scope(ctx, |scope| {
            scope
                .project()
                .create_user_with_local_id(&local_id, &updates)?
                .ok_or_else(|| {
                    ApiError::unknown("Internal assertion error: duplicate localId", "unknown")
                })
        })?;
        let mfa = rt.scope(ctx, |scope| Ok(is_mfa_enabled(scope, &user)))?;
        if !truthy(user.get("disabled")) && !mfa {
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
            rt.scope(ctx, |scope| {
                scope.project().update_user_by_local_id(
                    &local_id,
                    &outcome.updates,
                    UpdateOptions::default(),
                )
            })?
        } else {
            user
        }
    } else {
        let Some(user) = user_from_token.clone().or_else(|| user_from_email.clone()) else {
            return Err(ApiError::unknown(
                "Internal assertion error: no account for the email link",
                "unknown",
            ));
        };
        ensure!(!truthy(user.get("disabled")), "USER_DISABLED");
        if let (Some(from_token), Some(from_email)) = (&user_from_token, &user_from_email) {
            ensure!(
                local_id_of(from_token) == local_id_of(from_email),
                "EMAIL_EXISTS"
            );
        }
        let mfa = rt.scope(ctx, |scope| Ok(is_mfa_enabled(scope, &user)))?;
        if !truthy(user.get("disabled")) && !mfa {
            let mut merged = user.clone();
            merged.extend(updates.clone());
            let outcome = rt
                .blocking(
                    ctx,
                    BlockingEvent::BeforeSignIn,
                    &merged,
                    &context,
                    &OauthTokens::default(),
                )
                .await?;
            updates.extend(outcome.updates);
            extra_claims = outcome.extra_claims;
        }
        let local_id = local_id_of(&user);
        rt.scope(ctx, |scope| {
            scope.project().update_user_by_local_id(
                &local_id,
                &updates.clone(),
                UpdateOptions::default(),
            )
        })?
    };
    rt.scope(ctx, |scope| {
        let mut response = JsonMap::new();
        response.insert(
            "kind".to_owned(),
            json!("identitytoolkit#EmailLinkSigninResponse"),
        );
        response.insert("email".to_owned(), json!(email));
        response.insert("localId".to_owned(), json!(local_id_of(&user)));
        response.insert("isNewUser".to_owned(), json!(is_new));
        ensure!(!truthy(user.get("disabled")), "USER_DISABLED");
        if is_mfa_enabled(scope, &user) {
            response.extend(mfa_pending(scope, &user, PROVIDER_PASSWORD));
            return Ok(JsonValue::Object(response));
        }
        let mut refresh = UserRecord::new();
        refresh.insert("lastLoginAt".to_owned(), json!(now_millis().to_string()));
        let user = scope.project().update_user_by_local_id(
            &local_id_of(&user),
            &refresh,
            UpdateOptions::default(),
        )?;
        let tokens = issue_tokens(
            scope,
            &user,
            PROVIDER_PASSWORD,
            &IssueOptions {
                extra_claims: extra_claims.clone(),
                ..IssueOptions::default()
            },
        )?;
        tokens.apply(&mut response);
        Ok(JsonValue::Object(response))
    })
}

// ---------------------------------------------------------------- phone

pub fn send_verification_code(rt: &Runtime, ctx: &Ctx) -> Result<JsonValue, ApiError> {
    rt.scope(ctx, |scope| {
        ensure!(!scope.disable_auth(), "PROJECT_DISABLED");
        ensure!(!scope.is_tenant(), "UNSUPPORTED_TENANT_OPERATION");
        let phone = ctx.body_truthy_str("phoneNumber");
        ensure!(phone.is_some_and(is_valid_phone), "INVALID_PHONE_NUMBER : Invalid format.");
        let phone = phone.unwrap_or_default();
        let user = scope.project().get_user_by_phone_number(phone);
        ensure!(
            user.is_none_or(|user| user.get("mfaInfo").and_then(JsonValue::as_array).is_none_or(Vec::is_empty)),
            "UNSUPPORTED_FIRST_FACTOR : A phone number cannot be set as a first factor on an SMS based MFA user."
        );
        let verification = scope.project().create_verification_code(phone);
        rt.log(
            "BULLET",
            &format!("To verify the phone number {}, use the code {}.", verification.phone_number, verification.code),
        );
        Ok(json!({ "sessionInfo": verification.session_info }))
    })
}

pub async fn sign_in_with_phone_number(rt: &Runtime, ctx: &Ctx) -> Result<JsonValue, ApiError> {
    let (phone, user_from_phone, user_from_token) = rt.scope(ctx, |scope| {
        ensure!(!scope.disable_auth(), "PROJECT_DISABLED");
        ensure!(!scope.is_tenant(), "UNSUPPORTED_TENANT_OPERATION");
        let phone = if let Some(proof) = ctx.body_truthy_str("temporaryProof") {
            let phone = ctx.body_truthy_str("phoneNumber");
            ensure!(phone.is_some(), "MISSING_PHONE_NUMBER");
            let record = scope
                .project()
                .validate_temporary_proof(proof, phone.unwrap_or_default());
            require!(record, "INVALID_TEMPORARY_PROOF").phone_number
        } else {
            let session = ctx.body_truthy_str("sessionInfo");
            ensure!(session.is_some(), "MISSING_SESSION_INFO");
            let code = ctx.body_truthy_str("code");
            ensure!(code.is_some(), "MISSING_CODE");
            verify_phone_number(scope, session.unwrap_or_default(), code.unwrap_or_default())?
        };
        let user_from_phone = scope.project().get_user_by_phone_number(&phone);
        let user_from_token = match ctx.body_truthy_str("idToken") {
            Some(token) => Some(parse_id_token(scope, token)?.user),
            None => None,
        };
        Ok((phone, user_from_phone, user_from_token))
    })?;
    if let (Some(from_phone), Some(from_token)) = (&user_from_phone, &user_from_token)
        && local_id_of(from_phone) != local_id_of(from_token)
    {
        ensure!(!ctx.body_truthy("temporaryProof"), "PHONE_NUMBER_EXISTS");
        return rt.scope(ctx, |scope| {
            let proof = scope.project().create_temporary_proof(&phone);
            Ok(json!({
                "phoneNumber": proof.phone_number,
                "temporaryProof": proof.temporary_proof,
                "temporaryProofExpiresIn": proof.temporary_proof_expires_in,
            }))
        });
    }
    let context = BlockingContext {
        sign_in_method: Some("phone".to_owned()),
        ..BlockingContext::default()
    };
    let existing = user_from_token.or(user_from_phone);
    let is_new = existing.is_none();
    let now = now_millis();
    let mut updates = UserRecord::new();
    updates.insert("phoneNumber".to_owned(), json!(phone));
    updates.insert("lastLoginAt".to_owned(), json!(now.to_string()));
    let mut extra_claims = None;
    let user = match existing {
        None => {
            updates.insert("createdAt".to_owned(), json!(now.to_string()));
            let local_id = rt.scope(ctx, |scope| Ok(scope.project().generate_local_id()))?;
            let mut before_create = UserRecord::new();
            before_create.insert("localId".to_owned(), json!(local_id));
            before_create.extend(updates.clone());
            let outcome = rt
                .blocking(
                    ctx,
                    BlockingEvent::BeforeCreate,
                    &before_create,
                    &context,
                    &OauthTokens::default(),
                )
                .await?;
            updates.extend(outcome.updates);
            let user = rt.scope(ctx, |scope| {
                scope
                    .project()
                    .create_user_with_local_id(&local_id, &updates)?
                    .ok_or_else(|| {
                        ApiError::unknown("Internal assertion error: duplicate localId", "unknown")
                    })
            })?;
            if truthy(user.get("disabled")) {
                user
            } else {
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
                rt.scope(ctx, |scope| {
                    scope.project().update_user_by_local_id(
                        &local_id,
                        &outcome.updates,
                        UpdateOptions::default(),
                    )
                })?
            }
        }
        Some(user) => {
            ensure!(!truthy(user.get("disabled")), "USER_DISABLED");
            ensure!(
                user.get("mfaInfo")
                    .and_then(JsonValue::as_array)
                    .is_none_or(Vec::is_empty),
                "UNSUPPORTED_FIRST_FACTOR : A phone number cannot be set as a first factor on an SMS based MFA user."
            );
            if !truthy(user.get("disabled")) {
                let mut merged = user.clone();
                merged.extend(updates.clone());
                let outcome = rt
                    .blocking(
                        ctx,
                        BlockingEvent::BeforeSignIn,
                        &merged,
                        &context,
                        &OauthTokens::default(),
                    )
                    .await?;
                updates.extend(outcome.updates);
                extra_claims = outcome.extra_claims;
            }
            let local_id = local_id_of(&user);
            rt.scope(ctx, |scope| {
                scope.project().update_user_by_local_id(
                    &local_id,
                    &updates.clone(),
                    UpdateOptions::default(),
                )
            })?
        }
    };
    ensure!(!truthy(user.get("disabled")), "USER_DISABLED");
    rt.scope(ctx, |scope| {
        let tokens = issue_tokens(
            scope,
            &user,
            PROVIDER_PHONE,
            &IssueOptions {
                extra_claims: extra_claims.clone(),
                ..IssueOptions::default()
            },
        )?;
        let mut response = JsonMap::new();
        response.insert("isNewUser".to_owned(), json!(is_new));
        response.insert("phoneNumber".to_owned(), json!(phone));
        response.insert("localId".to_owned(), json!(local_id_of(&user)));
        tokens.apply(&mut response);
        Ok(JsonValue::Object(response))
    })
}

// ---------------------------------------------------------------- refresh grant

pub fn grant_token(rt: &Runtime, ctx: &Ctx) -> Result<JsonValue, ApiError> {
    rt.scope(ctx, |scope| {
        let grant_type = ctx.body_truthy_str("grantType");
        ensure!(grant_type.is_some(), "MISSING_GRANT_TYPE");
        ensure!(grant_type == Some("refresh_token"), "INVALID_GRANT_TYPE");
        let refresh = ctx.body_truthy_str("refreshToken");
        ensure!(refresh.is_some(), "MISSING_REFRESH_TOKEN");
        let record = decode_refresh_token(refresh.unwrap_or_default())?;
        ensure!(
            record.project_id == scope.project_id,
            "INVALID_REFRESH_TOKEN"
        );
        if scope.is_tenant() {
            ensure!(record.tenant_id == scope.tenant_id, "TENANT_ID_MISMATCH");
        }
        let user = scope.project().get_user_by_local_id(&record.local_id);
        let user = require!(user, "INVALID_REFRESH_TOKEN");
        ensure!(!truthy(user.get("disabled")), "USER_DISABLED");
        let tokens = issue_tokens(
            scope,
            &user,
            &record.provider,
            &IssueOptions {
                extra_claims: Some(record.extra_claims.clone()),
                second_factor: record.second_factor.clone(),
                sign_in_attributes: None,
            },
        )?;
        Ok(json!({
            "id_token": tokens.id_token,
            "access_token": tokens.id_token,
            "expires_in": tokens.expires_in,
            "refresh_token": tokens.refresh_token,
            "token_type": "Bearer",
            "user_id": record.local_id,
            "project_id": crate::state::PROJECT_NUMBER,
        }))
    })
}

// ---------------------------------------------------------------- createAuthUri

pub fn create_auth_uri(rt: &Runtime, ctx: &Ctx) -> Result<JsonValue, ApiError> {
    rt.scope(ctx, |scope| {
        ensure!(!scope.disable_auth(), "PROJECT_DISABLED");
        let session_id = ctx
            .body_truthy_str("sessionId")
            .map_or_else(|| crate::util::random_id(27), str::to_owned);
        if ctx.body_truthy("providerId") {
            return Err(ApiError::not_implemented(
                "Sign-in with IDP is not yet supported.",
            ));
        }
        let identifier = ctx.body_truthy_str("identifier");
        ensure!(identifier.is_some(), "MISSING_IDENTIFIER");
        ensure!(ctx.body_truthy("continueUri"), "MISSING_CONTINUE_URI");
        let identifier = identifier.unwrap_or_default();
        ensure!(is_valid_email(identifier), "INVALID_IDENTIFIER");
        let email = canonicalize_email(identifier);
        ensure!(
            crate::util::is_absolute_uri(ctx.body_str("continueUri").unwrap_or_default()),
            "INVALID_CONTINUE_URI"
        );
        let mut all_providers: Vec<String> = Vec::new();
        let mut signin_methods: Vec<String> = Vec::new();
        let mut registered = false;
        let users = scope.project().get_users_by_email_or_provider_email(&email);
        if scope.one_account_per_email() {
            if let Some(first) = users.first() {
                registered = true;
                for info in crate::state::provider_infos(first) {
                    let provider = str_field(&info, "providerId").unwrap_or_default();
                    if provider == PROVIDER_PASSWORD {
                        all_providers.push(provider.to_owned());
                        if truthy(first.get("passwordHash")) {
                            signin_methods.push(PROVIDER_PASSWORD.to_owned());
                        }
                        if truthy(first.get("emailLinkSignin")) {
                            signin_methods.push(SIGNIN_METHOD_EMAIL_LINK.to_owned());
                        }
                    } else if provider != PROVIDER_PHONE {
                        all_providers.push(provider.to_owned());
                        signin_methods.push(provider.to_owned());
                    }
                }
            }
        } else if let Some(user) = users.iter().find(|user| truthy(user.get("email"))) {
            registered = true;
            if truthy(user.get("passwordHash")) || truthy(user.get("emailLinkSignin")) {
                all_providers.push(PROVIDER_PASSWORD.to_owned());
                let first = &users[0];
                if truthy(first.get("passwordHash")) {
                    signin_methods.push(PROVIDER_PASSWORD.to_owned());
                }
                if truthy(first.get("emailLinkSignin")) {
                    signin_methods.push(SIGNIN_METHOD_EMAIL_LINK.to_owned());
                }
            }
        }
        if scope.improved_email_privacy() {
            return Ok(
                json!({ "kind": "identitytoolkit#CreateAuthUriResponse", "sessionId": session_id }),
            );
        }
        Ok(json!({
            "kind": "identitytoolkit#CreateAuthUriResponse",
            "registered": registered,
            "allProviders": all_providers,
            "sessionId": session_id,
            "signinMethods": signin_methods,
        }))
    })
}

// ---------------------------------------------------------------- federated

struct IdpClaims {
    provider_id: String,
    claims: JsonMap<String, JsonValue>,
    /// The claims with their original key order, for `rawUserInfo`.
    claims_ordered: OrderedJson,
    oauth_id_token: Option<String>,
    oauth_access_token: Option<String>,
    saml_response: Option<JsonValue>,
    saml_ordered: Option<OrderedJson>,
}

/// `getNormalizedUri` + `parseClaims`: the credential fields of the request.
fn parse_credential(ctx: &Ctx) -> Result<IdpClaims, ApiError> {
    let request_uri = ctx.body_truthy_str("requestUri");
    ensure!(request_uri.is_some(), "MISSING_REQUEST_URI");
    let Ok(mut uri) = url::Url::parse(request_uri.unwrap_or_default()) else {
        return Err(ApiError::bad_request("INVALID_REQUEST_URI"));
    };
    let mut fields: Vec<(String, String)> = uri
        .query_pairs()
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect();
    let set = |fields: &mut Vec<(String, String)>, key: String, value: String| {
        if let Some(entry) = fields.iter_mut().find(|(existing, _)| *existing == key) {
            entry.1 = value;
        } else {
            fields.push((key, value));
        }
    };
    if let Some(post_body) = ctx.body_truthy_str("postBody") {
        for (key, value) in url::form_urlencoded::parse(post_body.as_bytes()) {
            set(&mut fields, key.into_owned(), value.into_owned());
        }
    }
    if let Some(fragment) = uri.fragment().filter(|fragment| !fragment.is_empty()) {
        let fragment = fragment.to_owned();
        for (key, value) in url::form_urlencoded::parse(fragment.as_bytes()) {
            set(&mut fields, key.into_owned(), value.into_owned());
        }
        uri.set_fragment(None);
    }
    let get = |name: &str| {
        fields
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.clone())
            .filter(|value| !value.is_empty())
    };
    let provider_id = get("providerId").map(|provider| provider.to_lowercase());
    let normalized = {
        let mut rebuilt = uri.clone();
        rebuilt.query_pairs_mut().clear().extend_pairs(
            fields
                .iter()
                .map(|(key, value)| (key.as_str(), value.as_str())),
        );
        if fields.is_empty() {
            rebuilt.set_query(None);
        }
        rebuilt.to_string()
    };
    let provider_id = require!(
        provider_id,
        format!(
            "INVALID_CREDENTIAL_OR_PROVIDER_ID : Invalid IdP response/credential: {normalized}"
        )
    );
    let oauth_id_token = get("id_token");
    let oauth_access_token = get("access_token");
    let claims = match parse_claims(oauth_id_token.as_deref())? {
        Some(claims) => Some(claims),
        None => parse_claims(oauth_access_token.as_deref())?,
    };
    let Some(claims_ordered) = claims else {
        if let Some(token) = &oauth_id_token {
            return Err(ApiError::bad_request(format!(
                "INVALID_IDP_RESPONSE : Unable to parse id_token: {token} ((Auth Emulator only accepts strict JSON or JWTs as fake id_tokens.))"
            )));
        }
        if oauth_access_token.is_some() {
            if provider_id == "google.com" || provider_id == "apple.com" {
                return Err(ApiError::not_implemented(format!(
                    "The Auth Emulator only support sign-in with {provider_id} using id_token, not access_token. Please update your code to use id_token."
                )));
            }
            return Err(ApiError::not_implemented(format!(
                "The Auth Emulator does not support {provider_id} sign-in with credentials."
            )));
        }
        return Err(ApiError::not_implemented(
            "The Auth Emulator only supports sign-in with credentials (id_token required).",
        ));
    };
    let saml_ordered =
        match get("SAMLResponse") {
            Some(text) => Some(OrderedJson::parse(&text).ok_or_else(|| {
                ApiError::unknown("Unexpected token in SAMLResponse", "SyntaxError")
            })?),
            None => None,
        };
    let saml_response = saml_ordered.as_ref().map(OrderedJson::to_value);
    let claims = claims_ordered
        .to_value()
        .as_object()
        .cloned()
        .unwrap_or_default();
    Ok(IdpClaims {
        provider_id,
        claims,
        claims_ordered,
        oauth_id_token,
        oauth_access_token,
        saml_response,
        saml_ordered,
    })
}

/// `parseClaims`: strict JSON or a JWT; `None` when a JWT does not decode.
/// The claims keep their key order for `rawUserInfo`.
fn parse_claims(token: Option<&str>) -> Result<Option<OrderedJson>, ApiError> {
    let Some(token) = token.filter(|token| !token.is_empty()) else {
        return Ok(None);
    };
    let claims = if token.starts_with('{') {
        OrderedJson::parse(token).ok_or_else(|| {
            ApiError::bad_request(format!(
                "INVALID_IDP_RESPONSE : Unable to parse id_token: {token} ((Auth Emulator failed to parse fake id_token as strict JSON.))"
            ))
        })?
    } else {
        let Some(payload) = decode_jwt_ordered(token) else {
            return Ok(None);
        };
        payload
    };
    let sub = claims.get("sub");
    ensure!(
        sub.is_some_and(
            |sub| !matches!(sub, OrderedJson::Null | OrderedJson::Bool(false))
                && sub.as_str() != Some("")
        ),
        "INVALID_IDP_RESPONSE : Invalid Idp Response: id_token missing required fields. ((Missing \"sub\" field. This field is required and must be a unique identifier.))"
    );
    ensure!(
        sub.is_some_and(|sub| sub.as_str().is_some()),
        "INVALID_IDP_RESPONSE : ((The \"sub\" field must be a string.))"
    );
    Ok(Some(claims))
}

/// The payload of a JWT with its key order.
fn decode_jwt_ordered(token: &str) -> Option<OrderedJson> {
    decode_jwt(token)?;
    let payload = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload.trim_end_matches('='))
        .ok()?;
    OrderedJson::parse(std::str::from_utf8(&bytes).ok()?)
}

struct IdpProfile {
    response: JsonMap<String, JsonValue>,
    raw_id: String,
}

/// `fakeFetchUserInfoFromIdp`.
fn fake_fetch_user_info(provider_id: &str, credential: &IdpClaims) -> IdpProfile {
    let claims = &credential.claims;
    let saml = credential.saml_response.as_ref();
    let raw_id = str_field(claims, "sub").unwrap_or_default().to_owned();
    let email = truthy_str(claims, "email").map(canonicalize_email);
    let email_verified = truthy(claims.get("email_verified"));
    let display_name = claims.get("name").cloned();
    let photo_url = claims.get("picture").cloned();
    let mut response = JsonMap::new();
    response.insert(
        "kind".to_owned(),
        json!("identitytoolkit#VerifyAssertionResponse"),
    );
    response.insert("context".to_owned(), json!(""));
    response.insert("providerId".to_owned(), json!(provider_id));
    insert_opt(&mut response, "displayName", display_name.clone());
    insert_opt(&mut response, "fullName", display_name.clone());
    insert_opt(
        &mut response,
        "screenName",
        claims.get("screen_name").cloned(),
    );
    insert_opt(&mut response, "email", email.clone().map(JsonValue::String));
    response.insert("emailVerified".to_owned(), json!(email_verified));
    insert_opt(&mut response, "photoUrl", photo_url.clone());
    let mut federated_id = raw_id.clone();
    if provider_id == "google.com" {
        federated_id = format!("https://accounts.google.com/{raw_id}");
        let mut scopes = "openid https://www.googleapis.com/auth/userinfo.profile".to_owned();
        if email.is_some() {
            scopes.push_str(" https://www.googleapis.com/auth/userinfo.email");
        }
        insert_opt(
            &mut response,
            "firstName",
            claims.get("given_name").cloned(),
        );
        insert_opt(
            &mut response,
            "lastName",
            claims.get("family_name").cloned(),
        );
        response.insert(
            "rawUserInfo".to_owned(),
            json!(stringify_ordered(&[
                ("granted_scopes", Some(json!(scopes))),
                ("id", Some(json!(raw_id))),
                ("name", display_name),
                ("given_name", claims.get("given_name").cloned()),
                ("family_name", claims.get("family_name").cloned()),
                ("verified_email", Some(json!(email_verified))),
                ("locale", Some(json!("en"))),
                ("email", email.map(JsonValue::String)),
                ("picture", photo_url),
            ])),
        );
    } else if provider_id.starts_with("saml.") {
        let name_id = saml
            .and_then(|saml| saml.pointer("/assertion/subject/nameId"))
            .and_then(JsonValue::as_str)
            .filter(|id| !id.is_empty());
        if let Some(name_id) = name_id
            && is_valid_email(name_id)
        {
            response.insert("email".to_owned(), json!(name_id));
        }
        response.insert("emailVerified".to_owned(), json!(true));
        let statements = credential
            .saml_ordered
            .as_ref()
            .and_then(|saml| saml.get("assertion"))
            .and_then(|assertion| assertion.get("attributeStatements"));
        if let Some(statements) = statements {
            response.insert("rawUserInfo".to_owned(), json!(statements.stringify()));
        }
    } else {
        response.insert(
            "rawUserInfo".to_owned(),
            json!(credential.claims_ordered.stringify()),
        );
    }
    response.insert("federatedId".to_owned(), json!(federated_id));
    IdpProfile { response, raw_id }
}

struct AccountUpdates {
    fields: UserRecord,
    delete_providers: Vec<String>,
}

fn handle_idp_sign_up(
    response: &mut JsonMap<String, JsonValue>,
    email_required: bool,
) -> AccountUpdates {
    let mut fields = UserRecord::new();
    for key in [
        "dateOfBirth",
        "displayName",
        "language",
        "photoUrl",
        "screenName",
    ] {
        fields.insert(
            key.to_owned(),
            response.get(key).cloned().unwrap_or(JsonValue::Null),
        );
    }
    if email_required && truthy(response.get("email")) {
        fields.insert(
            "email".to_owned(),
            response.get("email").cloned().unwrap_or(JsonValue::Null),
        );
        fields.insert(
            "emailVerified".to_owned(),
            response
                .get("emailVerified")
                .cloned()
                .unwrap_or(JsonValue::Null),
        );
    }
    response.insert("isNewUser".to_owned(), json!(true));
    AccountUpdates {
        fields,
        delete_providers: Vec::new(),
    }
}

pub async fn sign_in_with_idp(rt: &Runtime, ctx: &Ctx) -> Result<JsonValue, ApiError> {
    if ctx.body_truthy("returnRefreshToken") {
        return Err(ApiError::not_implemented(
            "returnRefreshToken is not implemented yet.",
        ));
    }
    if ctx.body_truthy("pendingIdToken") {
        return Err(ApiError::not_implemented(
            "pendingIdToken is not implemented yet.",
        ));
    }
    let disabled = rt.scope(ctx, |scope| Ok(scope.disable_auth()))?;
    ensure!(!disabled, "PROJECT_DISABLED");
    let credential = parse_credential(ctx)?;
    let mut sign_in_attributes: Option<JsonValue> = None;
    if let Some(saml) = &credential.saml_response {
        sign_in_attributes = saml.pointer("/assertion/attributeStatements").cloned();
        ensure!(
            truthy(saml.get("assertion")),
            "INVALID_IDP_RESPONSE ((Missing assertion in SAMLResponse.))"
        );
        ensure!(
            truthy(saml.pointer("/assertion/subject")),
            "INVALID_IDP_RESPONSE ((Missing assertion.subject in SAMLResponse.))"
        );
        ensure!(
            truthy(saml.pointer("/assertion/subject/nameId")),
            "INVALID_IDP_RESPONSE ((Missing assertion.subject.nameId in SAMLResponse.))"
        );
    }
    let provider_id = credential.provider_id.clone();
    let IdpProfile {
        mut response,
        raw_id,
    } = fake_fetch_user_info(&provider_id, &credential);
    response.insert(
        "oauthAccessToken".to_owned(),
        json!(
            credential
                .oauth_access_token
                .clone()
                .unwrap_or_else(|| format!("FirebaseAuthEmulatorFakeAccessToken_{provider_id}"))
        ),
    );
    insert_opt(
        &mut response,
        "oauthIdToken",
        credential.oauth_id_token.clone().map(JsonValue::String),
    );

    // Resolve linking / sign-in against the store.
    let return_credential = ctx.body_truthy("returnIdpCredential");
    let outcome: Result<(AccountUpdates, JsonMap<String, JsonValue>), ApiError> =
        rt.scope(ctx, |scope| {
            let user_from_token = match ctx.body_truthy_str("idToken") {
                Some(token) => Some(parse_id_token(scope, token)?.user),
                None => None,
            };
            let user_matching_provider = scope
                .project()
                .get_user_by_provider_raw_id(&provider_id, &raw_id);
            let mut response = response.clone();
            if let Some(from_token) = user_from_token {
                ensure!(
                    user_matching_provider.is_none(),
                    "FEDERATED_USER_ID_ALREADY_LINKED"
                );
                // handleLinkIdp
                let response_email = truthy_str(&response, "email").map(str::to_owned);
                if scope.one_account_per_email()
                    && let Some(email) = &response_email
                {
                    let matching = scope.project().get_user_by_email(email);
                    ensure!(
                        matching.is_none_or(
                            |matching| local_id_of(&matching) == local_id_of(&from_token)
                        ),
                        "EMAIL_EXISTS"
                    );
                }
                response.insert("localId".to_owned(), json!(local_id_of(&from_token)));
                let mut fields = UserRecord::new();
                if scope.one_account_per_email()
                    && let Some(email) = &response_email
                    && !truthy(from_token.get("email"))
                {
                    fields.insert("email".to_owned(), json!(email));
                    fields.insert(
                        "emailVerified".to_owned(),
                        response
                            .get("emailVerified")
                            .cloned()
                            .unwrap_or(json!(false)),
                    );
                }
                if let Some(email) = &response_email
                    && truthy(response.get("emailVerified"))
                    && (truthy_str(&fields, "email").or(truthy_str(&from_token, "email"))
                        == Some(email.as_str()))
                {
                    fields.insert("emailVerified".to_owned(), json!(true));
                }
                return Ok((
                    AccountUpdates {
                        fields,
                        delete_providers: Vec::new(),
                    },
                    response,
                ));
            }
            if scope.one_account_per_email() {
                let user_matching_email = truthy_str(&response, "email")
                    .and_then(|email| scope.project().get_user_by_email(email));
                // handleIdpSigninEmailRequired
                if let Some(matching) = user_matching_provider {
                    response.insert("localId".to_owned(), json!(local_id_of(&matching)));
                    return Ok((
                        AccountUpdates {
                            fields: UserRecord::new(),
                            delete_providers: Vec::new(),
                        },
                        response,
                    ));
                }
                if let Some(matching) = user_matching_email {
                    if truthy(response.get("emailVerified")) {
                        if crate::state::provider_infos(&matching).iter().any(|info| {
                            str_field(info, "providerId") == Some(provider_id.as_str())
                                && str_field(info, "rawId") != Some(raw_id.as_str())
                        }) {
                            response.insert("emailRecycled".to_owned(), json!(true));
                        }
                        response.insert("localId".to_owned(), json!(local_id_of(&matching)));
                        let mut fields = UserRecord::new();
                        let mut delete_providers = Vec::new();
                        if !truthy(matching.get("emailVerified")) {
                            fields.insert("passwordHash".to_owned(), JsonValue::Null);
                            fields.insert("phoneNumber".to_owned(), JsonValue::Null);
                            fields
                                .insert("validSince".to_owned(), json!(now_seconds().to_string()));
                            delete_providers = crate::state::provider_infos(&matching)
                                .iter()
                                .filter_map(|info| str_field(info, "providerId").map(str::to_owned))
                                .collect();
                        }
                        for key in [
                            "dateOfBirth",
                            "displayName",
                            "language",
                            "photoUrl",
                            "screenName",
                        ] {
                            fields.insert(
                                key.to_owned(),
                                response.get(key).cloned().unwrap_or(JsonValue::Null),
                            );
                        }
                        fields.insert("emailVerified".to_owned(), json!(true));
                        return Ok((
                            AccountUpdates {
                                fields,
                                delete_providers,
                            },
                            response,
                        ));
                    }
                    response.insert("needConfirmation".to_owned(), json!(true));
                    response.insert("localId".to_owned(), json!(local_id_of(&matching)));
                    let verified: Vec<JsonValue> = crate::state::provider_infos(&matching)
                        .iter()
                        .filter_map(|info| str_field(info, "providerId").map(str::to_owned))
                        .filter(|provider| {
                            provider != PROVIDER_PASSWORD && provider != PROVIDER_PHONE
                        })
                        .map(JsonValue::String)
                        .collect();
                    response.insert("verifiedProvider".to_owned(), JsonValue::Array(verified));
                    return Ok((
                        AccountUpdates {
                            fields: UserRecord::new(),
                            delete_providers: Vec::new(),
                        },
                        response,
                    ));
                }
                let updates = handle_idp_sign_up(&mut response, true);
                return Ok((updates, response));
            }
            // handleIdpSigninEmailNotRequired
            if let Some(matching) = user_matching_provider {
                response.insert("localId".to_owned(), json!(local_id_of(&matching)));
                return Ok((
                    AccountUpdates {
                        fields: UserRecord::new(),
                        delete_providers: Vec::new(),
                    },
                    response,
                ));
            }
            let updates = handle_idp_sign_up(&mut response, false);
            Ok((updates, response))
        });
    let (account_updates, mut response) = match outcome {
        Ok(value) => value,
        Err(error) if return_credential && error.is_bad_request() => {
            response.insert("errorMessage".to_owned(), json!(error.message));
            return Ok(JsonValue::Object(response));
        }
        Err(error) => return Err(error),
    };
    if truthy(response.get("needConfirmation")) {
        return Ok(JsonValue::Object(response));
    }
    let mut provider_info = ProviderInfo::new();
    provider_info.insert("providerId".to_owned(), json!(provider_id));
    provider_info.insert("rawId".to_owned(), json!(raw_id));
    provider_info.insert("federatedId".to_owned(), json!(raw_id));
    for key in ["displayName", "photoUrl", "email", "screenName"] {
        insert_opt(&mut provider_info, key, response.get(key).cloned());
    }
    let oauth = OauthTokens {
        id_token: truthy_str(&response, "oauthIdToken").map(str::to_owned),
        access_token: truthy_str(&response, "oauthAccessToken").map(str::to_owned),
        refresh_token: truthy_str(&response, "oauthRefreshToken").map(str::to_owned),
        token_secret: truthy_str(&response, "oauthTokenSecret").map(str::to_owned),
        expires_in: coerce_primitive_to_string(response.get("oauthExpireIn")),
    };
    let context = BlockingContext {
        sign_in_method: Some(provider_id.clone()),
        sign_in_second_factor: None,
        sign_in_attributes: sign_in_attributes
            .as_ref()
            .map(|value| serde_json::to_string(value).unwrap_or_default()),
        raw_user_info: truthy_str(&response, "rawUserInfo").map(str::to_owned),
    };
    let mut extra_claims = None;
    let user = if truthy(response.get("isNewUser")) {
        let now = now_millis();
        let mut updates = account_updates.fields.clone();
        updates.insert("createdAt".to_owned(), json!(now.to_string()));
        updates.insert("lastLoginAt".to_owned(), json!(now.to_string()));
        updates.insert(
            "providerUserInfo".to_owned(),
            json!([JsonValue::Object(provider_info.clone())]),
        );
        match &ctx.tenant_id {
            Some(tenant) => updates.insert("tenantId".to_owned(), json!(tenant)),
            None => updates.insert("tenantId".to_owned(), JsonValue::Null),
        };
        let local_id = rt.scope(ctx, |scope| Ok(scope.project().generate_local_id()))?;
        let mut before_create = UserRecord::new();
        before_create.insert("localId".to_owned(), json!(local_id));
        before_create.extend(updates.clone());
        let outcome = rt
            .blocking(
                ctx,
                BlockingEvent::BeforeCreate,
                &before_create,
                &context,
                &oauth,
            )
            .await?;
        updates.extend(outcome.updates);
        let user = rt.scope(ctx, |scope| {
            scope
                .project()
                .create_user_with_local_id(&local_id, &updates)?
                .ok_or_else(|| {
                    ApiError::unknown("Internal assertion error: duplicate localId", "unknown")
                })
        })?;
        response.insert("localId".to_owned(), json!(local_id));
        let mfa = rt.scope(ctx, |scope| Ok(is_mfa_enabled(scope, &user)))?;
        if !truthy(user.get("disabled")) && !mfa {
            let outcome = rt
                .blocking(ctx, BlockingEvent::BeforeSignIn, &user, &context, &oauth)
                .await?;
            extra_claims = outcome.extra_claims;
            rt.scope(ctx, |scope| {
                scope.project().update_user_by_local_id(
                    &local_id,
                    &outcome.updates,
                    UpdateOptions::default(),
                )
            })?
        } else {
            user
        }
    } else {
        let local_id = truthy_str(&response, "localId").map(str::to_owned);
        let Some(local_id) = local_id else {
            return Err(ApiError::unknown(
                "Internal assertion error: localId not set for existing user.",
                "unknown",
            ));
        };
        let existing = rt.scope(ctx, |scope| {
            Ok(scope.project().get_user_by_local_id(&local_id))
        })?;
        let existing = require!(existing, "USER_NOT_FOUND");
        let mut updates = account_updates.fields.clone();
        let mfa = rt.scope(ctx, |scope| Ok(is_mfa_enabled(scope, &existing)))?;
        if !truthy(existing.get("disabled")) && !mfa {
            let mut merged = existing.clone();
            merged.extend(updates.clone());
            let outcome = rt
                .blocking(ctx, BlockingEvent::BeforeSignIn, &merged, &context, &oauth)
                .await?;
            extra_claims = outcome.extra_claims;
            updates.extend(outcome.updates);
        }
        let delete_providers = account_updates.delete_providers.clone();
        rt.scope(ctx, |scope| {
            scope.project().update_user_by_local_id(
                &local_id,
                &updates,
                crate::state::UpdateOptions {
                    upsert_providers: vec![provider_info.clone()],
                    delete_providers: delete_providers.iter().map(String::as_str).collect(),
                },
            )
        })?
    };
    rt.scope(ctx, |scope| {
        // `user.email === response.email` also holds when both are undefined.
        if user.get("email").filter(|value| !value.is_null())
            == response.get("email").filter(|value| !value.is_null())
        {
            match user.get("emailVerified").filter(|value| !value.is_null()) {
                Some(verified) => response.insert("emailVerified".to_owned(), verified.clone()),
                None => response.remove("emailVerified"),
            };
        }
        if let Some(tenant) = &scope.tenant_id {
            response.insert("tenantId".to_owned(), json!(tenant));
        }
        if is_mfa_enabled(scope, &user) {
            response.extend(mfa_pending(scope, &user, &provider_id));
            return Ok(JsonValue::Object(response));
        }
        let mut refresh = UserRecord::new();
        refresh.insert("lastLoginAt".to_owned(), json!(now_millis().to_string()));
        let user = scope.project().update_user_by_local_id(
            &local_id_of(&user),
            &refresh,
            UpdateOptions::default(),
        )?;
        ensure!(!truthy(user.get("disabled")), "USER_DISABLED");
        let tokens = issue_tokens(
            scope,
            &user,
            &provider_id,
            &IssueOptions {
                extra_claims: extra_claims.clone(),
                second_factor: None,
                sign_in_attributes: sign_in_attributes.clone(),
            },
        )?;
        tokens.apply(&mut response);
        Ok(JsonValue::Object(response))
    })
}
