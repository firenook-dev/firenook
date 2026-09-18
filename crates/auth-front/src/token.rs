//! Tokens as the official emulator issues and parses them: unsigned id
//! tokens, self-describing refresh tokens, session cookies and MFA pending
//! credentials.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde_json::{Map as JsonMap, Value as JsonValue, json};

use crate::error::{ApiError, ensure, require};
use crate::state::{PROVIDER_PASSWORD, Scope, UpdateOptions, UserRecord, provider_infos};
use crate::util::{decode_jwt, now_iso, now_seconds, str_field, truthy, truthy_str, unsigned_jwt};

pub const CUSTOM_TOKEN_AUDIENCE: &str =
    "https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit";
const EXPIRES_IN_SECONDS: i64 = 3600;

/// `secondFactor` of an issued token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SecondFactor {
    pub identifier: String,
    pub provider: String,
}

/// Inputs of `issueTokens`.
#[derive(Debug, Default, Clone)]
pub struct IssueOptions {
    pub extra_claims: Option<JsonMap<String, JsonValue>>,
    pub second_factor: Option<SecondFactor>,
    pub sign_in_attributes: Option<JsonValue>,
}

/// `{ idToken, refreshToken, expiresIn }`.
#[derive(Debug, Clone)]
pub struct IssuedTokens {
    pub id_token: String,
    pub refresh_token: String,
    pub expires_in: String,
}

impl IssuedTokens {
    /// Spreads the tokens into a response object.
    pub fn apply(&self, response: &mut JsonMap<String, JsonValue>) {
        response.insert("idToken".to_owned(), json!(self.id_token));
        response.insert("refreshToken".to_owned(), json!(self.refresh_token));
        response.insert("expiresIn".to_owned(), json!(self.expires_in));
    }
}

/// `issueTokens`: refreshes `lastRefreshAt`, then generates both tokens.
pub fn issue_tokens(
    scope: &mut Scope<'_>,
    user: &UserRecord,
    sign_in_provider: &str,
    options: &IssueOptions,
) -> Result<IssuedTokens, ApiError> {
    let local_id = str_field(user, "localId").unwrap_or_default().to_owned();
    let mut fields = UserRecord::new();
    fields.insert("lastRefreshAt".to_owned(), json!(now_iso()));
    let user =
        scope
            .project()
            .update_user_by_local_id(&local_id, &fields, UpdateOptions::default())?;
    let tenant_id = scope.tenant_id.clone();
    let id_token = generate_jwt(
        &user,
        &scope.project_id,
        sign_in_provider,
        options,
        tenant_id.as_deref(),
    );
    let refresh_token = create_refresh_token(&scope.project_id, &user, sign_in_provider, options);
    Ok(IssuedTokens {
        id_token,
        refresh_token,
        expires_in: EXPIRES_IN_SECONDS.to_string(),
    })
}

/// `generateJwt`: the exact claim set of the official emulator.
#[must_use]
pub fn generate_jwt(
    user: &UserRecord,
    project_id: &str,
    sign_in_provider: &str,
    options: &IssueOptions,
    tenant_id: Option<&str>,
) -> String {
    let mut identities = JsonMap::new();
    if let Some(email) = truthy_str(user, "email") {
        identities.insert("email".to_owned(), json!([email]));
    }
    for info in provider_infos(user) {
        if let (Some(provider), Some(raw)) =
            (truthy_str(&info, "providerId"), truthy_str(&info, "rawId"))
            && provider != PROVIDER_PASSWORD
        {
            let entry = identities
                .entry(provider.to_owned())
                .or_insert_with(|| json!([]));
            if let Some(list) = entry.as_array_mut() {
                list.push(json!(raw));
            }
        }
    }
    let custom_attributes = str_field(user, "customAttributes")
        .and_then(|value| serde_json::from_str::<JsonValue>(value).ok())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    let mut claims = JsonMap::new();
    // Field order follows the official object literal; `undefined` values are
    // dropped by JSON serialization, so absent fields are omitted here.
    if let Some(name) = user.get("displayName").filter(|value| !value.is_null()) {
        claims.insert("name".to_owned(), name.clone());
    }
    if let Some(picture) = user.get("photoUrl").filter(|value| !value.is_null()) {
        claims.insert("picture".to_owned(), picture.clone());
    }
    for (key, value) in custom_attributes {
        claims.insert(key, value);
    }
    if let Some(extra) = &options.extra_claims {
        for (key, value) in extra {
            claims.insert(key.clone(), value.clone());
        }
    }
    let mut set = |key: &str, value: Option<JsonValue>| match value {
        Some(value) if !value.is_null() => {
            claims.insert(key.to_owned(), value);
        }
        _ => {
            claims.remove(key);
        }
    };
    set("email", user.get("email").cloned());
    set("email_verified", user.get("emailVerified").cloned());
    set("phone_number", user.get("phoneNumber").cloned());
    set(
        "provider_id",
        (sign_in_provider == "anonymous").then(|| json!(sign_in_provider)),
    );
    set("auth_time", Some(json!(auth_time(user))));
    set("user_id", user.get("localId").cloned());
    let mut firebase = JsonMap::new();
    firebase.insert("identities".to_owned(), JsonValue::Object(identities));
    firebase.insert("sign_in_provider".to_owned(), json!(sign_in_provider));
    if let Some(factor) = &options.second_factor {
        firebase.insert(
            "second_factor_identifier".to_owned(),
            json!(factor.identifier),
        );
        firebase.insert("sign_in_second_factor".to_owned(), json!(factor.provider));
    }
    if let Some(tenant) = tenant_id {
        firebase.insert("tenant".to_owned(), json!(tenant));
    }
    if let Some(attributes) = &options.sign_in_attributes
        && !attributes.is_null()
    {
        firebase.insert("sign_in_attributes".to_owned(), attributes.clone());
    }
    set("firebase", Some(JsonValue::Object(firebase)));
    let now = now_seconds();
    claims.insert("iat".to_owned(), json!(now));
    claims.insert("exp".to_owned(), json!(now + EXPIRES_IN_SECONDS));
    claims.insert("aud".to_owned(), json!(project_id));
    claims.insert(
        "iss".to_owned(),
        json!(format!("https://securetoken.google.com/{project_id}")),
    );
    claims.insert(
        "sub".to_owned(),
        user.get("localId").cloned().unwrap_or(JsonValue::Null),
    );
    unsigned_jwt(&JsonValue::Object(claims))
}

/// `getAuthTime`: `lastLoginAt` (ms) or `lastRefreshAt` (ISO), in seconds.
fn auth_time(user: &UserRecord) -> i64 {
    if let Some(last_login) =
        str_field(user, "lastLoginAt").and_then(|value| value.parse::<i64>().ok())
    {
        return last_login.div_euclid(1000);
    }
    if let Some(refresh) = str_field(user, "lastRefreshAt")
        && let Ok(parsed) =
            time::OffsetDateTime::parse(refresh, &time::format_description::well_known::Rfc3339)
    {
        return parsed.unix_timestamp();
    }
    now_seconds()
}

/// `createRefreshTokenFor`: base64 JSON with the official marker.
#[must_use]
pub fn create_refresh_token(
    project_id: &str,
    user: &UserRecord,
    provider: &str,
    options: &IssueOptions,
) -> String {
    let mut record = JsonMap::new();
    record.insert(
        "_AuthEmulatorRefreshToken".to_owned(),
        json!("DO NOT MODIFY"),
    );
    record.insert(
        "localId".to_owned(),
        user.get("localId").cloned().unwrap_or(JsonValue::Null),
    );
    record.insert("provider".to_owned(), json!(provider));
    record.insert(
        "extraClaims".to_owned(),
        JsonValue::Object(options.extra_claims.clone().unwrap_or_default()),
    );
    record.insert("projectId".to_owned(), json!(project_id));
    if let Some(factor) = &options.second_factor {
        record.insert(
            "secondFactor".to_owned(),
            json!({ "identifier": factor.identifier, "provider": factor.provider }),
        );
    }
    if let Some(tenant) = user.get("tenantId").filter(|value| !value.is_null()) {
        record.insert("tenantId".to_owned(), tenant.clone());
    }
    BASE64.encode(serde_json::to_vec(&JsonValue::Object(record)).unwrap_or_default())
}

/// Decoded refresh token record.
#[derive(Debug, Clone)]
pub struct RefreshRecord {
    pub local_id: String,
    pub provider: String,
    pub extra_claims: JsonMap<String, JsonValue>,
    pub project_id: String,
    pub second_factor: Option<SecondFactor>,
    pub tenant_id: Option<String>,
}

/// `decodeRefreshToken`.
pub fn decode_refresh_token(token: &str) -> Result<RefreshRecord, ApiError> {
    let record = BASE64
        .decode(token)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<JsonValue>(&bytes).ok())
        .and_then(|value| value.as_object().cloned())
        .ok_or_else(|| ApiError::bad_request("INVALID_REFRESH_TOKEN"))?;
    ensure!(
        truthy(record.get("_AuthEmulatorRefreshToken")),
        "INVALID_REFRESH_TOKEN"
    );
    let second_factor = record
        .get("secondFactor")
        .and_then(JsonValue::as_object)
        .map(|factor| SecondFactor {
            identifier: str_field(factor, "identifier")
                .unwrap_or_default()
                .to_owned(),
            provider: str_field(factor, "provider").unwrap_or_default().to_owned(),
        });
    Ok(RefreshRecord {
        local_id: str_field(&record, "localId").unwrap_or_default().to_owned(),
        provider: str_field(&record, "provider")
            .unwrap_or_default()
            .to_owned(),
        extra_claims: record
            .get("extraClaims")
            .and_then(JsonValue::as_object)
            .cloned()
            .unwrap_or_default(),
        project_id: str_field(&record, "projectId")
            .unwrap_or_default()
            .to_owned(),
        second_factor,
        tenant_id: str_field(&record, "tenantId").map(str::to_owned),
    })
}

/// A parsed id token: the account, its sign-in provider and the payload.
#[derive(Debug, Clone)]
pub struct ParsedIdToken {
    pub user: UserRecord,
    pub sign_in_provider: String,
    pub payload: JsonMap<String, JsonValue>,
    pub signed: bool,
}

/// `parseIdToken`: validity, tenant, `validSince` and disabled checks.
pub fn parse_id_token(scope: &Scope<'_>, id_token: &str) -> Result<ParsedIdToken, ApiError> {
    let (header, payload) = require!(decode_jwt(id_token), "INVALID_ID_TOKEN");
    let signed = header.get("alg").and_then(JsonValue::as_str) != Some("none");
    let payload = payload.as_object().cloned().unwrap_or_default();
    let firebase = payload
        .get("firebase")
        .and_then(JsonValue::as_object)
        .cloned()
        .unwrap_or_default();
    if let Some(tenant) = truthy_str(&firebase, "tenant") {
        ensure!(
            scope.is_tenant(),
            "((Parsed token that belongs to tenant in a non-tenant project.))"
        );
        ensure!(
            scope.tenant_id.as_deref() == Some(tenant),
            "TENANT_ID_MISMATCH"
        );
    }
    let local_id = str_field(&payload, "user_id").unwrap_or_default();
    let user = scope.project_ref().get_user_by_local_id(local_id);
    let user = require!(user, "USER_NOT_FOUND");
    let valid_since = str_field(&user, "validSince").and_then(|value| value.parse::<i64>().ok());
    let issued_at = payload.get("iat").and_then(JsonValue::as_i64).unwrap_or(0);
    ensure!(
        valid_since.is_none_or(|since| issued_at >= since) || !truthy(user.get("validSince")),
        "TOKEN_EXPIRED"
    );
    ensure!(!truthy(user.get("disabled")), "USER_DISABLED");
    let sign_in_provider = str_field(&firebase, "sign_in_provider")
        .unwrap_or_default()
        .to_owned();
    Ok(ParsedIdToken {
        user,
        sign_in_provider,
        payload,
        signed,
    })
}

/// `mfaPending`: the pending credential and the redacted enrolments.
#[must_use]
pub fn pending_credential(scope: &Scope<'_>, user: &UserRecord, sign_in_provider: &str) -> String {
    let mut payload = JsonMap::new();
    payload.insert(
        "_AuthEmulatorMfaPendingCredential".to_owned(),
        json!("DO NOT MODIFY"),
    );
    payload.insert(
        "localId".to_owned(),
        user.get("localId").cloned().unwrap_or(JsonValue::Null),
    );
    payload.insert("signInProvider".to_owned(), json!(sign_in_provider));
    payload.insert("projectId".to_owned(), json!(scope.project_id));
    if let Some(tenant) = &scope.tenant_id {
        payload.insert("tenantId".to_owned(), json!(tenant));
    }
    BASE64.encode(serde_json::to_vec(&JsonValue::Object(payload)).unwrap_or_default())
}

/// `parsePendingCredential`.
pub fn parse_pending_credential(
    scope: &Scope<'_>,
    credential: &str,
) -> Result<(UserRecord, String), ApiError> {
    let payload = BASE64
        .decode(credential)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<JsonValue>(&bytes).ok())
        .and_then(|value| value.as_object().cloned());
    let payload = require!(
        payload,
        "((Invalid phoneVerificationInfo.mfaPendingCredential.))"
    );
    ensure!(
        truthy(payload.get("_AuthEmulatorMfaPendingCredential")),
        "((Invalid phoneVerificationInfo.mfaPendingCredential.))"
    );
    ensure!(
        str_field(&payload, "projectId") == Some(scope.project_id.as_str()),
        "INVALID_PROJECT_ID : Project ID does not match MFA pending credential."
    );
    if scope.is_tenant() {
        ensure!(
            str_field(&payload, "tenantId") == scope.tenant_id.as_deref(),
            "INVALID_PROJECT_ID : Project ID does not match MFA pending credential."
        );
    }
    let local_id = str_field(&payload, "localId").unwrap_or_default();
    let user = require!(
        scope.project_ref().get_user_by_local_id(local_id),
        "((User in pendingCredentialPayload does not exist.))"
    );
    Ok((
        user,
        str_field(&payload, "signInProvider")
            .unwrap_or_default()
            .to_owned(),
    ))
}

/// `createSessionCookie` payload from a parsed id token.
#[must_use]
pub fn session_cookie(payload: &JsonMap<String, JsonValue>, valid_duration: i64) -> String {
    let mut cookie = payload.clone();
    let issued_at = now_seconds();
    cookie.insert("iat".to_owned(), json!(issued_at));
    cookie.insert("exp".to_owned(), json!(issued_at + valid_duration));
    let audience = str_field(payload, "aud").unwrap_or_default().to_owned();
    cookie.insert(
        "iss".to_owned(),
        json!(format!("https://session.firebase.google.com/{audience}")),
    );
    unsigned_jwt(&JsonValue::Object(cookie))
}
