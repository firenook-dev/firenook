//! SMS multi-factor enrolment and sign-in, and the shape-only passkeys.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde_json::{Map as JsonMap, Value as JsonValue, json};

use super::{Ctx, new_random_id, obfuscate_phone_number, verify_phone_number};
use crate::Runtime;
use crate::blocking::{BlockingContext, OauthTokens};
use crate::error::{ApiError, ensure, require};
use crate::state::{
    BlockingEvent, PROVIDER_ANONYMOUS, PROVIDER_CUSTOM, PROVIDER_GAME_CENTER, PROVIDER_PHONE,
    UpdateOptions, UserRecord, passkeys,
};
use crate::token::{
    IssueOptions, SecondFactor, issue_tokens, parse_id_token, parse_pending_credential,
};
use crate::util::{is_valid_phone, now_iso, now_millis, str_field, truthy, truthy_str};

const MFA_INELIGIBLE_PROVIDERS: &[&str] = &[
    PROVIDER_ANONYMOUS,
    PROVIDER_PHONE,
    PROVIDER_CUSTOM,
    PROVIDER_GAME_CENTER,
];
const NOT_ENABLED: &str = "OPERATION_NOT_ALLOWED : SMS based MFA not enabled.";

fn enrollments(user: &UserRecord) -> Vec<JsonValue> {
    user.get("mfaInfo")
        .and_then(JsonValue::as_array)
        .cloned()
        .unwrap_or_default()
}

fn has_enrolled_phone(user: &UserRecord, phone: &str) -> bool {
    enrollments(user).iter().any(|enrollment| {
        enrollment
            .get("unobfuscatedPhoneInfo")
            .and_then(JsonValue::as_str)
            == Some(phone)
    })
}

pub fn mfa_enrollment_start(rt: &Runtime, ctx: &Ctx) -> Result<JsonValue, ApiError> {
    rt.scope(ctx, |scope| {
        ensure!(!scope.disable_auth(), "PROJECT_DISABLED");
        ensure!(scope.sms_mfa_enabled(), NOT_ENABLED);
        ensure!(ctx.body_truthy("idToken"), "MISSING_ID_TOKEN");
        let parsed = parse_id_token(scope, ctx.body_str("idToken").unwrap_or_default())?;
        ensure!(
            !MFA_INELIGIBLE_PROVIDERS.contains(&parsed.sign_in_provider.as_str()),
            "UNSUPPORTED_FIRST_FACTOR : MFA is not available for the given first factor."
        );
        ensure!(
            truthy(parsed.user.get("emailVerified")),
            "UNVERIFIED_EMAIL : Need to verify email first before enrolling second factors."
        );
        let info = ctx.body.get("phoneEnrollmentInfo").filter(|value| truthy(Some(value)));
        ensure!(info.is_some(), "INVALID_ARGUMENT : ((Missing phoneEnrollmentInfo.))");
        let phone = info.and_then(|info| info.get("phoneNumber")).and_then(JsonValue::as_str).filter(|phone| !phone.is_empty());
        ensure!(phone.is_some_and(is_valid_phone), "INVALID_PHONE_NUMBER : Invalid format.");
        let phone = phone.unwrap_or_default();
        ensure!(
            !has_enrolled_phone(&parsed.user, phone),
            "SECOND_FACTOR_EXISTS : Phone number already enrolled as second factor for this account."
        );
        let verification = scope.project().create_verification_code(phone);
        rt.log("BULLET", &format!("To enroll MFA with {phone}, use the code {}.", verification.code));
        Ok(json!({ "phoneSessionInfo": { "sessionInfo": verification.session_info } }))
    })
}

fn phone_verification(
    body: &JsonMap<String, JsonValue>,
    missing_message: &str,
) -> Result<(String, String), ApiError> {
    let info = body
        .get("phoneVerificationInfo")
        .filter(|value| truthy(Some(value)));
    let info = require!(info, missing_message);
    if truthy(info.get("androidVerificationProof")) {
        return Err(ApiError::not_implemented(
            "androidVerificationProof is unsupported!",
        ));
    }
    let code = info
        .get("code")
        .and_then(JsonValue::as_str)
        .filter(|value| !value.is_empty());
    let session = info
        .get("sessionInfo")
        .and_then(JsonValue::as_str)
        .filter(|value| !value.is_empty());
    ensure!(code.is_some(), "MISSING_CODE");
    ensure!(session.is_some(), "MISSING_SESSION_INFO");
    Ok((
        session.unwrap_or_default().to_owned(),
        code.unwrap_or_default().to_owned(),
    ))
}

pub fn mfa_enrollment_finalize(rt: &Runtime, ctx: &Ctx) -> Result<JsonValue, ApiError> {
    rt.scope(ctx, |scope| {
        ensure!(!scope.disable_auth(), "PROJECT_DISABLED");
        ensure!(scope.sms_mfa_enabled(), NOT_ENABLED);
        ensure!(ctx.body_truthy("idToken"), "MISSING_ID_TOKEN");
        let parsed = parse_id_token(scope, ctx.body_str("idToken").unwrap_or_default())?;
        ensure!(
            !MFA_INELIGIBLE_PROVIDERS.contains(&parsed.sign_in_provider.as_str()),
            "UNSUPPORTED_FIRST_FACTOR : MFA is not available for the given first factor."
        );
        let (session, code) = phone_verification(&ctx.body, "INVALID_ARGUMENT : ((Missing phoneVerificationInfo.))")?;
        let phone = verify_phone_number(scope, &session, &code)?;
        ensure!(
            !has_enrolled_phone(&parsed.user, &phone),
            "SECOND_FACTOR_EXISTS : Phone number already enrolled as second factor for this account."
        );
        let existing = enrollments(&parsed.user);
        let existing_ids: Vec<String> = existing
            .iter()
            .filter_map(|enrollment| enrollment.get("mfaEnrollmentId").and_then(JsonValue::as_str).filter(|id| !id.is_empty()).map(str::to_owned))
            .collect();
        let mut enrollment = JsonMap::new();
        if let Some(name) = ctx.body.get("displayName").filter(|value| !value.is_null()) {
            enrollment.insert("displayName".to_owned(), name.clone());
        }
        enrollment.insert("enrolledAt".to_owned(), json!(now_iso()));
        let enrollment_id = new_random_id(28, &existing_ids);
        enrollment.insert("mfaEnrollmentId".to_owned(), json!(enrollment_id));
        enrollment.insert("phoneInfo".to_owned(), json!(phone));
        enrollment.insert("unobfuscatedPhoneInfo".to_owned(), json!(phone));
        let mut list = existing;
        list.push(JsonValue::Object(enrollment));
        let mut updates = UserRecord::new();
        updates.insert("mfaInfo".to_owned(), JsonValue::Array(list));
        let local_id = str_field(&parsed.user, "localId").unwrap_or_default().to_owned();
        let user = scope.project().update_user_by_local_id(&local_id, &updates, UpdateOptions::default())?;
        let tokens = issue_tokens(
            scope,
            &user,
            &parsed.sign_in_provider,
            &IssueOptions {
                second_factor: Some(SecondFactor {
                    identifier: enrollment_id,
                    provider: PROVIDER_PHONE.to_owned(),
                }),
                ..IssueOptions::default()
            },
        )?;
        Ok(json!({ "idToken": tokens.id_token, "refreshToken": tokens.refresh_token }))
    })
}

pub fn mfa_enrollment_withdraw(rt: &Runtime, ctx: &Ctx) -> Result<JsonValue, ApiError> {
    rt.scope(ctx, |scope| {
        ensure!(!scope.disable_auth(), "PROJECT_DISABLED");
        ensure!(ctx.body_truthy("idToken"), "MISSING_ID_TOKEN");
        let parsed = parse_id_token(scope, ctx.body_str("idToken").unwrap_or_default())?;
        ensure!(
            truthy(parsed.user.get("mfaInfo")),
            "MFA_ENROLLMENT_NOT_FOUND"
        );
        let existing = enrollments(&parsed.user);
        let target = ctx.body_str("mfaEnrollmentId");
        let remaining: Vec<JsonValue> = existing
            .iter()
            .filter(|enrollment| {
                enrollment
                    .get("mfaEnrollmentId")
                    .and_then(JsonValue::as_str)
                    != target
            })
            .cloned()
            .collect();
        ensure!(remaining.len() < existing.len(), "MFA_ENROLLMENT_NOT_FOUND");
        let mut updates = UserRecord::new();
        updates.insert("mfaInfo".to_owned(), JsonValue::Array(remaining));
        let local_id = str_field(&parsed.user, "localId")
            .unwrap_or_default()
            .to_owned();
        let user = scope.project().update_user_by_local_id(
            &local_id,
            &updates,
            UpdateOptions::default(),
        )?;
        let tokens = issue_tokens(
            scope,
            &user,
            &parsed.sign_in_provider,
            &IssueOptions::default(),
        )?;
        let mut response = JsonMap::new();
        tokens.apply(&mut response);
        Ok(JsonValue::Object(response))
    })
}

pub fn mfa_sign_in_start(rt: &Runtime, ctx: &Ctx) -> Result<JsonValue, ApiError> {
    rt.scope(ctx, |scope| {
        ensure!(!scope.disable_auth(), "PROJECT_DISABLED");
        ensure!(scope.sms_mfa_enabled(), NOT_ENABLED);
        ensure!(
            ctx.body_truthy("mfaPendingCredential"),
            "MISSING_MFA_PENDING_CREDENTIAL : Request does not have MFA pending credential."
        );
        ensure!(
            ctx.body_truthy("mfaEnrollmentId"),
            "MISSING_MFA_ENROLLMENT_ID : No second factor identifier is provided."
        );
        let (user, _) = parse_pending_credential(
            scope,
            ctx.body_str("mfaPendingCredential").unwrap_or_default(),
        )?;
        let target = ctx.body_str("mfaEnrollmentId");
        let enrollment = enrollments(&user).into_iter().find(|enrollment| {
            enrollment
                .get("mfaEnrollmentId")
                .and_then(JsonValue::as_str)
                == target
        });
        ensure!(enrollment.is_some(), "MFA_ENROLLMENT_NOT_FOUND");
        let phone = enrollment
            .as_ref()
            .and_then(|enrollment| enrollment.get("unobfuscatedPhoneInfo"))
            .and_then(JsonValue::as_str)
            .filter(|phone| !phone.is_empty())
            .map(str::to_owned);
        let phone = require!(phone, "INVALID_ARGUMENT : MFA provider not supported!");
        let verification = scope.project().create_verification_code(&phone);
        rt.log(
            "BULLET",
            &format!(
                "To sign in with MFA using {phone}, use the code {}.",
                verification.code
            ),
        );
        Ok(json!({ "phoneResponseInfo": { "sessionInfo": verification.session_info } }))
    })
}

pub async fn mfa_sign_in_finalize(rt: &Runtime, ctx: &Ctx) -> Result<JsonValue, ApiError> {
    let (user, sign_in_provider, enrollment_id) = rt.scope(ctx, |scope| {
        ensure!(!scope.disable_auth(), "PROJECT_DISABLED");
        ensure!(scope.sms_mfa_enabled(), NOT_ENABLED);
        ensure!(
            ctx.body_truthy("mfaPendingCredential"),
            "MISSING_CREDENTIAL : Please set MFA Pending Credential."
        );
        let (session, code) =
            phone_verification(&ctx.body, "INVALID_ARGUMENT : MFA provider not supported!")?;
        let phone = verify_phone_number(scope, &session, &code)?;
        let (user, sign_in_provider) = parse_pending_credential(
            scope,
            ctx.body_str("mfaPendingCredential").unwrap_or_default(),
        )?;
        let enrollment_id = enrollments(&user)
            .iter()
            .find(|enrollment| {
                let unobfuscated = enrollment
                    .get("unobfuscatedPhoneInfo")
                    .and_then(JsonValue::as_str)
                    .filter(|value| !value.is_empty());
                unobfuscated == Some(phone.as_str())
                    || unobfuscated.is_some_and(|value| obfuscate_phone_number(value) == phone)
            })
            .and_then(|enrollment| {
                enrollment
                    .get("mfaEnrollmentId")
                    .and_then(JsonValue::as_str)
                    .filter(|id| !id.is_empty())
                    .map(str::to_owned)
            });
        Ok((user, sign_in_provider, enrollment_id))
    })?;
    let outcome = rt
        .blocking(
            ctx,
            BlockingEvent::BeforeSignIn,
            &user,
            &BlockingContext {
                sign_in_method: Some(sign_in_provider.clone()),
                sign_in_second_factor: Some("phone".to_owned()),
                ..BlockingContext::default()
            },
            &OauthTokens::default(),
        )
        .await?;
    rt.scope(ctx, |scope| {
        let mut updates = outcome.updates.clone();
        updates.insert("lastLoginAt".to_owned(), json!(now_millis().to_string()));
        let local_id = str_field(&user, "localId").unwrap_or_default().to_owned();
        let user = scope.project().update_user_by_local_id(
            &local_id,
            &updates,
            UpdateOptions::default(),
        )?;
        ensure!(enrollment_id.is_some(), "MFA_ENROLLMENT_NOT_FOUND");
        ensure!(!truthy(user.get("disabled")), "USER_DISABLED");
        let tokens = issue_tokens(
            scope,
            &user,
            &sign_in_provider,
            &IssueOptions {
                extra_claims: outcome.extra_claims.clone(),
                second_factor: Some(SecondFactor {
                    identifier: enrollment_id.clone().unwrap_or_default(),
                    provider: PROVIDER_PHONE.to_owned(),
                }),
                sign_in_attributes: None,
            },
        )?;
        Ok(json!({ "idToken": tokens.id_token, "refreshToken": tokens.refresh_token }))
    })
}

// ---------------------------------------------------------------- passkeys

pub fn passkey_enrollment_start(rt: &Runtime, ctx: &Ctx) -> Result<JsonValue, ApiError> {
    rt.scope(ctx, |scope| {
        ensure!(!scope.disable_auth(), "PROJECT_DISABLED");
        ensure!(ctx.body_truthy("idToken"), "MISSING_ID_TOKEN");
        let parsed = parse_id_token(scope, ctx.body_str("idToken").unwrap_or_default())?;
        let local_id = str_field(&parsed.user, "localId").unwrap_or_default();
        Ok(json!({
            "credentialCreationOptions": {
                "rp": { "name": "localhost", "id": "localhost" },
                "user": {
                    "id": BASE64.encode(local_id.as_bytes()),
                    "name": truthy_str(&parsed.user, "email").unwrap_or("user@example.com"),
                    "displayName": truthy_str(&parsed.user, "displayName").unwrap_or("User"),
                },
                "challenge": BASE64.encode(new_random_id(32, &[]).as_bytes()),
                "pubKeyCredParams": [
                    { "type": "public-key", "alg": -7 },
                    { "type": "public-key", "alg": -257 },
                ],
                "timeout": 60000,
                "attestation": "none",
            }
        }))
    })
}

pub fn passkey_enrollment_finalize(rt: &Runtime, ctx: &Ctx) -> Result<JsonValue, ApiError> {
    rt.scope(ctx, |scope| {
        ensure!(!scope.disable_auth(), "PROJECT_DISABLED");
        ensure!(ctx.body_truthy("idToken"), "MISSING_ID_TOKEN");
        let response = ctx.body.get("authenticatorRegistrationResponse").filter(|value| truthy(Some(value)));
        ensure!(response.is_some(), "MISSING_AUTHENTICATOR_RESPONSE");
        let parsed = parse_id_token(scope, ctx.body_str("idToken").unwrap_or_default())?;
        let credential = response.and_then(|response| response.get("id")).and_then(JsonValue::as_str).filter(|id| !id.is_empty());
        ensure!(credential.is_some(), "INVALID_CREDENTIAL_ID");
        let credential = credential.unwrap_or_default().to_owned();
        ensure!(
            scope.project().get_user_by_passkey_credential_id(&credential).is_none(),
            "CREDENTIAL_ALREADY_IN_USE"
        );
        let name = ctx
            .body_truthy_str("name")
            .or_else(|| ctx.body_truthy_str("displayName"))
            .unwrap_or("Unnamed Passkey")
            .to_owned();
        let mut list: Vec<JsonValue> = passkeys(&parsed.user).into_iter().map(JsonValue::Object).collect();
        list.push(json!({ "credentialId": credential, "name": name }));
        let mut updates = UserRecord::new();
        updates.insert("passkeyInfo".to_owned(), JsonValue::Array(list));
        let local_id = str_field(&parsed.user, "localId").unwrap_or_default().to_owned();
        let user = scope.project().update_user_by_local_id(&local_id, &updates, UpdateOptions::default())?;
        let tokens = issue_tokens(scope, &user, "passkey", &IssueOptions::default())?;
        Ok(json!({ "localId": local_id, "idToken": tokens.id_token, "refreshToken": tokens.refresh_token }))
    })
}

pub fn passkey_sign_in_start(rt: &Runtime, ctx: &Ctx) -> Result<JsonValue, ApiError> {
    rt.scope(ctx, |scope| {
        ensure!(!scope.disable_auth(), "PROJECT_DISABLED");
        Ok(json!({
            "credentialRequestOptions": {
                "challenge": BASE64.encode(new_random_id(32, &[]).as_bytes()),
                "rpId": "localhost",
                "userVerification": "required",
            }
        }))
    })
}

pub fn passkey_sign_in_finalize(rt: &Runtime, ctx: &Ctx) -> Result<JsonValue, ApiError> {
    rt.scope(ctx, |scope| {
        ensure!(!scope.disable_auth(), "PROJECT_DISABLED");
        let response = ctx
            .body
            .get("authenticatorAuthenticationResponse")
            .filter(|value| truthy(Some(value)));
        ensure!(response.is_some(), "MISSING_AUTHENTICATOR_RESPONSE");
        let credential = response
            .and_then(|response| response.get("id"))
            .and_then(JsonValue::as_str)
            .filter(|id| !id.is_empty());
        ensure!(credential.is_some(), "INVALID_CREDENTIAL_ID");
        let user = scope
            .project()
            .get_user_by_passkey_credential_id(credential.unwrap_or_default());
        let user = require!(user, "PASSKEY_CREDENTIAL_NOT_FOUND");
        ensure!(!truthy(user.get("disabled")), "USER_DISABLED");
        let mut updates = UserRecord::new();
        updates.insert("lastLoginAt".to_owned(), json!(now_millis().to_string()));
        let local_id = str_field(&user, "localId").unwrap_or_default().to_owned();
        let user = scope.project().update_user_by_local_id(
            &local_id,
            &updates,
            UpdateOptions::default(),
        )?;
        let tokens = issue_tokens(scope, &user, "passkey", &IssueOptions::default())?;
        Ok(json!({ "idToken": tokens.id_token, "refreshToken": tokens.refresh_token }))
    })
}
