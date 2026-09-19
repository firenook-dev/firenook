//! The Identity Toolkit operations, ported one to one from the official
//! emulator's `operations.ts`: same validation order, same error strings,
//! same response fields.

use std::collections::BTreeMap;

use serde_json::{Map as JsonMap, Value as JsonValue, json};

use crate::error::{ApiError, ensure, require};
use crate::state::{Scope, UserRecord};
use crate::util::{is_valid_phone, random_id, str_field, truthy_str};

pub mod admin;
pub mod config;
pub mod mfa;
pub mod oob;
pub mod signin;
pub mod signup;
pub mod tenants;
pub mod update;

pub const PASSWORD_MIN_LENGTH: usize = 6;
const CUSTOM_ATTRIBUTES_MAX_LENGTH: usize = 1000;
const FORBIDDEN_CUSTOM_CLAIMS: &[&str] = &[
    "iss",
    "aud",
    "sub",
    "iat",
    "exp",
    "nbf",
    "jti",
    "nonce",
    "azp",
    "acr",
    "amr",
    "cnf",
    "auth_time",
    "firebase",
    "at_hash",
    "c_hash",
];

/// Request context after routing, security and validation.
#[derive(Debug, Clone)]
pub struct Ctx {
    pub project_id: String,
    pub tenant_id: Option<String>,
    /// `ctx.security?.Oauth2`: the owner bearer authenticated the call.
    pub privileged: bool,
    pub body: JsonMap<String, JsonValue>,
    pub query: BTreeMap<String, JsonValue>,
    /// `authEmulatorUrl(req)`: `http://<host header>`.
    pub emulator_url: String,
}

impl Ctx {
    #[must_use]
    pub fn body_str(&self, field: &str) -> Option<&str> {
        str_field(&self.body, field)
    }

    /// A field with JavaScript truthiness (non-empty string).
    #[must_use]
    pub fn body_truthy_str(&self, field: &str) -> Option<&str> {
        truthy_str(&self.body, field)
    }

    #[must_use]
    pub fn body_truthy(&self, field: &str) -> bool {
        crate::util::truthy(self.body.get(field))
    }

    #[must_use]
    pub fn query_str(&self, name: &str) -> Option<&str> {
        self.query.get(name).and_then(JsonValue::as_str)
    }
}

/// `hashPassword`: the emulator's recoverable development hash.
#[must_use]
pub fn hash_password(password: &str, salt: &str) -> String {
    format!("fakeHash:salt={salt}:password={password}")
}

/// The digest early Firenook builds exported before adopting the official
/// format (`base64(sha256(salt, 0, password))`); accepted on sign-in and
/// upgraded to `hash_password` so later exports are portable.
#[must_use]
pub fn legacy_hash_password(password: &str, salt: &str) -> String {
    use base64::Engine as _;
    use sha2::Digest as _;
    let mut digest = sha2::Sha256::new();
    digest.update(salt.as_bytes());
    digest.update([0]);
    digest.update(password.as_bytes());
    base64::engine::general_purpose::STANDARD.encode(digest.finalize())
}

/// Whether `password` matches the account's stored hash (official format, or
/// the legacy Firenook digest).
#[must_use]
pub fn password_matches(user: &UserRecord, password: &str) -> bool {
    let Some(salt) = truthy_str(user, "salt") else {
        return false;
    };
    let Some(stored) = str_field(user, "passwordHash") else {
        return false;
    };
    stored == hash_password(password, salt) || stored == legacy_hash_password(password, salt)
}

#[must_use]
pub fn fake_salt() -> String {
    format!("fakeSalt{}", random_id(20))
}

/// `validateSerializedCustomClaims`.
pub fn validate_serialized_custom_claims(claims: &str) -> Result<(), ApiError> {
    ensure!(
        claims.len() <= CUSTOM_ATTRIBUTES_MAX_LENGTH,
        "CLAIMS_TOO_LARGE"
    );
    let parsed: JsonValue =
        serde_json::from_str(claims).map_err(|_| ApiError::bad_request("INVALID_CLAIMS"))?;
    validate_custom_claims(&parsed)
}

/// `validateCustomClaims`.
pub fn validate_custom_claims(claims: &JsonValue) -> Result<(), ApiError> {
    let object = claims.as_object();
    ensure!(object.is_some(), "INVALID_CLAIMS");
    for reserved in FORBIDDEN_CUSTOM_CLAIMS {
        ensure!(
            !object.is_some_and(|object| object.contains_key(*reserved)),
            format!("FORBIDDEN_CLAIM : {reserved}")
        );
    }
    Ok(())
}

/// `newRandomId(length, existingIds)`.
#[must_use]
pub fn new_random_id(length: usize, existing: &[String]) -> String {
    loop {
        let id = random_id(length);
        if !existing.contains(&id) {
            return id;
        }
    }
}

/// `getMfaEnrollmentsFromRequest`.
pub fn mfa_enrollments_from_request(
    request: &[JsonValue],
    generate_ids: bool,
) -> Result<Vec<JsonValue>, ApiError> {
    let mut enrollments = Vec::new();
    let mut phones: Vec<String> = Vec::new();
    let mut ids: Vec<String> = Vec::new();
    for enrollment in request {
        let object = enrollment.as_object().cloned().unwrap_or_default();
        let phone = truthy_str(&object, "phoneInfo");
        ensure!(
            phone.is_some_and(is_valid_phone),
            "INVALID_MFA_PHONE_NUMBER : Invalid format."
        );
        let phone = phone.unwrap_or_default().to_owned();
        if phones.contains(&phone) {
            continue;
        }
        let id = if generate_ids {
            Some(new_random_id(28, &ids))
        } else {
            truthy_str(&object, "mfaEnrollmentId").map(str::to_owned)
        };
        ensure!(
            id.is_some(),
            "INVALID_MFA_ENROLLMENT_ID : mfaEnrollmentId must be defined."
        );
        let id = id.unwrap_or_default();
        ensure!(!ids.contains(&id), "DUPLICATE_MFA_ENROLLMENT_ID");
        let mut entry = object.clone();
        entry.insert("mfaEnrollmentId".to_owned(), json!(id));
        entry.insert("unobfuscatedPhoneInfo".to_owned(), json!(phone));
        enrollments.push(JsonValue::Object(entry));
        phones.push(phone);
        ids.push(id);
    }
    crate::state::validate_mfa_enrollments(&enrollments)?;
    Ok(enrollments)
}

/// `isMfaEnabled(state, user)`.
#[must_use]
pub fn is_mfa_enabled(scope: &Scope<'_>, user: &UserRecord) -> bool {
    let (state, _) = scope.mfa_config();
    (state == "ENABLED" || state == "MANDATORY")
        && user
            .get("mfaInfo")
            .and_then(JsonValue::as_array)
            .is_some_and(|list| !list.is_empty())
}

/// `obfuscatePhoneNumber`: every digit but the last four becomes `*`.
#[must_use]
pub fn obfuscate_phone_number(phone: &str) -> String {
    let mut chars: Vec<char> = phone.chars().collect();
    let mut digits = 0;
    for character in chars.iter_mut().rev() {
        if character.is_ascii_digit() {
            digits += 1;
            if digits > 4 {
                *character = '*';
            }
        }
    }
    chars.into_iter().collect()
}

/// `redactMfaInfo`.
#[must_use]
pub fn redact_mfa_info(enrollment: &JsonValue) -> JsonValue {
    let mut redacted = JsonMap::new();
    for field in ["displayName", "enrolledAt", "mfaEnrollmentId"] {
        if let Some(value) = enrollment.get(field).filter(|value| !value.is_null()) {
            redacted.insert(field.to_owned(), value.clone());
        }
    }
    if let Some(phone) = enrollment
        .get("unobfuscatedPhoneInfo")
        .and_then(JsonValue::as_str)
        .filter(|phone| !phone.is_empty())
    {
        redacted.insert("phoneInfo".to_owned(), json!(obfuscate_phone_number(phone)));
    }
    JsonValue::Object(redacted)
}

/// `mfaPending(state, user, signInProvider)` response fields.
#[must_use]
pub fn mfa_pending(
    scope: &Scope<'_>,
    user: &UserRecord,
    sign_in_provider: &str,
) -> JsonMap<String, JsonValue> {
    let mut response = JsonMap::new();
    response.insert(
        "mfaPendingCredential".to_owned(),
        json!(crate::token::pending_credential(
            scope,
            user,
            sign_in_provider
        )),
    );
    let enrollments: Vec<JsonValue> = user
        .get("mfaInfo")
        .and_then(JsonValue::as_array)
        .map(|list| list.iter().map(redact_mfa_info).collect())
        .unwrap_or_default();
    response.insert("mfaInfo".to_owned(), JsonValue::Array(enrollments));
    response
}

/// `verifyPhoneNumber(state, sessionInfo, code)`.
pub fn verify_phone_number(
    scope: &mut Scope<'_>,
    session_info: &str,
    code: &str,
) -> Result<String, ApiError> {
    let verification = scope.project().get_verification_code(session_info);
    let verification = require!(verification, "INVALID_SESSION_INFO");
    ensure!(verification.code == code, "INVALID_CODE");
    scope.project().delete_verification_code(session_info);
    Ok(verification.phone_number)
}

/// Inserts `value` unless it is `None`, mirroring `undefined` fields that JSON drops.
pub fn insert_opt(target: &mut JsonMap<String, JsonValue>, key: &str, value: Option<JsonValue>) {
    if let Some(value) = value.filter(|value| !value.is_null()) {
        target.insert(key.to_owned(), value);
    }
}

/// `updates[field] = reqBody[field]` semantics: absent → delete (`null` in the update map).
pub fn mirror_request(updates: &mut UserRecord, field: &str, body: &JsonMap<String, JsonValue>) {
    updates.insert(
        field.to_owned(),
        body.get(field).cloned().unwrap_or(JsonValue::Null),
    );
}

/// `redactPasswordHash` is the identity in the official emulator.
#[must_use]
pub fn user_response(user: &UserRecord) -> JsonValue {
    JsonValue::Object(user.clone())
}
