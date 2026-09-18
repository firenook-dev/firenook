//! Blocking functions (`beforeCreate` / `beforeSignIn`) as the official
//! emulator calls them: the JWT it sends, the HTTP contract and how the
//! response updates the account.

use std::time::Duration;

use serde_json::{Map as JsonMap, Value as JsonValue, json};

use crate::error::{ApiError, ensure};
use crate::state::{BlockingEvent, PROVIDER_PHONE, UserRecord, provider_infos};
use crate::util::{
    coerce_primitive_to_string, now_seconds, random_base64url, str_field, truthy, unsigned_jwt,
};

const TIMEOUT_MS: u64 = 60_000;

/// Sign-in context forwarded to the function.
#[derive(Debug, Default, Clone)]
pub struct BlockingContext {
    pub sign_in_method: Option<String>,
    pub sign_in_second_factor: Option<String>,
    pub sign_in_attributes: Option<String>,
    pub raw_user_info: Option<String>,
}

/// OAuth credentials of a federated sign-in, forwarded when configured.
#[derive(Debug, Default, Clone)]
pub struct OauthTokens {
    pub id_token: Option<String>,
    pub access_token: Option<String>,
    pub refresh_token: Option<String>,
    pub token_secret: Option<String>,
    pub expires_in: Option<String>,
}

/// What the function asked to change.
#[derive(Debug, Default, Clone)]
pub struct BlockingOutcome {
    pub updates: UserRecord,
    pub extra_claims: Option<JsonMap<String, JsonValue>>,
}

/// Resolved target of one blocking event.
#[derive(Debug, Clone)]
pub struct BlockingTarget {
    pub uri: String,
    pub forward_access_token: bool,
    pub forward_id_token: bool,
    pub forward_refresh_token: bool,
    pub project_id: String,
    pub tenant_id: Option<String>,
}

/// `fetchBlockingFunction`: `None` target means no function is configured.
pub async fn fetch_blocking_function(
    client: &reqwest::Client,
    target: Option<BlockingTarget>,
    event: BlockingEvent,
    user: &UserRecord,
    context: &BlockingContext,
    oauth: &OauthTokens,
) -> Result<BlockingOutcome, ApiError> {
    let Some(target) = target else {
        return Ok(BlockingOutcome::default());
    };
    let jwt = generate_blocking_jwt(&target, event, user, context, oauth);
    let body = json!({ "data": { "jwt": jwt } });
    let response = client
        .post(&target.uri)
        .header("content-type", "application/json")
        .timeout(Duration::from_millis(TIMEOUT_MS))
        .body(serde_json::to_vec(&body).unwrap_or_default())
        .send()
        .await;
    let response = match response {
        Ok(response) => response,
        Err(error) if error.is_timeout() => {
            return Err(ApiError::internal(
                format!(
                    "BLOCKING_FUNCTION_ERROR_RESPONSE : ((Deadline exceeded making request to {}.))",
                    target.uri
                ),
                &error.to_string(),
            ));
        }
        Err(error) => {
            return Err(ApiError::internal(
                format!(
                    "BLOCKING_FUNCTION_ERROR_RESPONSE : ((Failed to make request to {}.))",
                    target.uri
                ),
                &error.to_string(),
            ));
        }
    };
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    ensure!(
        status.is_success(),
        format!(
            "BLOCKING_FUNCTION_ERROR_RESPONSE : ((HTTP request to {} returned HTTP error {}: {}))",
            target.uri,
            status.as_u16(),
            text
        )
    );
    let parsed: JsonValue = serde_json::from_str(&text).map_err(|error| {
        ApiError::internal(
            "BLOCKING_FUNCTION_ERROR_RESPONSE : ((Response body is not valid JSON.))",
            &format!("{error}"),
        )
    })?;
    process_response(event, &parsed)
}

/// `processBlockingFunctionResponse`.
pub fn process_response(
    event: BlockingEvent,
    response: &JsonValue,
) -> Result<BlockingOutcome, ApiError> {
    let mut outcome = BlockingOutcome::default();
    let Some(record) = response
        .get("userRecord")
        .filter(|value| truthy(Some(value)))
    else {
        return Ok(outcome);
    };
    let mask = record
        .get("updateMask")
        .and_then(JsonValue::as_str)
        .filter(|mask| !mask.is_empty());
    ensure!(
        mask.is_some(),
        "BLOCKING_FUNCTION_ERROR_RESPONSE : ((Response UserRecord is missing updateMask.))"
    );
    for field in mask.unwrap_or_default().split(',') {
        match field {
            "displayName" | "photoUrl" => {
                match coerce_primitive_to_string(record.get(field)) {
                    Some(value) => outcome.updates.insert(field.to_owned(), json!(value)),
                    None => outcome.updates.insert(field.to_owned(), JsonValue::Null),
                };
            }
            "disabled" | "emailVerified" => {
                outcome
                    .updates
                    .insert(field.to_owned(), json!(truthy(record.get(field))));
            }
            "customClaims" => {
                let claims = record
                    .get("customClaims")
                    .cloned()
                    .unwrap_or(JsonValue::Null);
                let serialized = serde_json::to_string(&claims).unwrap_or_default();
                crate::ops::validate_serialized_custom_claims(&serialized)?;
                outcome
                    .updates
                    .insert("customAttributes".to_owned(), json!(serialized));
            }
            "sessionClaims" if event == BlockingEvent::BeforeSignIn => {
                outcome.extra_claims = record
                    .get("sessionClaims")
                    .and_then(JsonValue::as_object)
                    .cloned();
            }
            _ => {}
        }
    }
    Ok(outcome)
}

/// `generateBlockingFunctionJwt`.
fn generate_blocking_jwt(
    target: &BlockingTarget,
    event: BlockingEvent,
    user: &UserRecord,
    context: &BlockingContext,
    oauth: &OauthTokens,
) -> String {
    let issued_at = now_seconds();
    let mut user_record = JsonMap::new();
    let mut set = |key: &str, value: Option<JsonValue>| {
        if let Some(value) = value.filter(|value| !value.is_null()) {
            user_record.insert(key.to_owned(), value);
        }
    };
    set("uid", user.get("localId").cloned());
    set("email", user.get("email").cloned());
    set("email_verified", user.get("emailVerified").cloned());
    set("display_name", user.get("displayName").cloned());
    set("photo_url", user.get("photoUrl").cloned());
    set("disabled", user.get("disabled").cloned());
    set("phone_number", user.get("phoneNumber").cloned());
    set(
        "custom_claims",
        Some(
            str_field(user, "customAttributes")
                .and_then(|value| serde_json::from_str::<JsonValue>(value).ok())
                .unwrap_or_else(|| json!({})),
        ),
    );
    let mut jwt = JsonMap::new();
    jwt.insert(
        "iss".to_owned(),
        json!(format!(
            "https://securetoken.google.com/{}",
            target.project_id
        )),
    );
    jwt.insert("aud".to_owned(), json!(target.uri));
    jwt.insert("iat".to_owned(), json!(issued_at));
    // The official emulator divides the millisecond timeout by 100.
    jwt.insert(
        "exp".to_owned(),
        json!(issued_at + i64::try_from(TIMEOUT_MS / 100).unwrap_or(600)),
    );
    jwt.insert("event_id".to_owned(), json!(random_base64url(16)));
    jwt.insert("event_type".to_owned(), json!(event.name()));
    jwt.insert(
        "user_agent".to_owned(),
        json!("NotYetSupportedInFirebaseAuthEmulator"),
    );
    jwt.insert("ip_address".to_owned(), json!("127.0.0.1"));
    jwt.insert("locale".to_owned(), json!("en"));
    if let Some(tenant) = &target.tenant_id {
        user_record.insert("tenant_id".to_owned(), json!(tenant));
    }
    let mut provider_data = Vec::new();
    for info in provider_infos(user) {
        let mut provider = JsonMap::new();
        for (source, name) in [
            ("providerId", "provider_id"),
            ("displayName", "display_name"),
            ("photoUrl", "photo_url"),
            ("email", "email"),
            ("rawId", "uid"),
            ("phoneNumber", "phone_number"),
        ] {
            if let Some(value) = info.get(source).filter(|value| !value.is_null()) {
                provider.insert(name.to_owned(), value.clone());
            }
        }
        provider_data.push(JsonValue::Object(provider));
    }
    user_record.insert("provider_data".to_owned(), JsonValue::Array(provider_data));
    if let Some(enrollments) = user.get("mfaInfo").and_then(JsonValue::as_array) {
        let mut factors = Vec::new();
        for enrollment in enrollments {
            let Some(id) = enrollment
                .get("mfaEnrollmentId")
                .and_then(JsonValue::as_str)
                .filter(|id| !id.is_empty())
            else {
                continue;
            };
            let mut factor = JsonMap::new();
            factor.insert("uid".to_owned(), json!(id));
            for (source, name) in [
                ("displayName", "display_name"),
                ("enrolledAt", "enrollment_time"),
                ("phoneInfo", "phone_number"),
            ] {
                if let Some(value) = enrollment.get(source).filter(|value| !value.is_null()) {
                    factor.insert(name.to_owned(), value.clone());
                }
            }
            factor.insert("factor_id".to_owned(), json!(PROVIDER_PHONE));
            factors.push(JsonValue::Object(factor));
        }
        user_record.insert(
            "multi_factor".to_owned(),
            json!({ "enrolled_factors": factors }),
        );
    }
    let last_login = str_field(user, "lastLoginAt").and_then(|value| value.parse::<i64>().ok());
    let created = str_field(user, "createdAt").and_then(|value| value.parse::<i64>().ok());
    if truthy(user.get("lastLoginAt")) || truthy(user.get("createdAt")) {
        let mut metadata = JsonMap::new();
        if let Some(value) = last_login {
            metadata.insert("last_sign_in_time".to_owned(), json!(value));
        }
        if let Some(value) = created {
            metadata.insert("creation_time".to_owned(), json!(value));
        }
        user_record.insert("metadata".to_owned(), JsonValue::Object(metadata));
    }
    jwt.insert("user_record".to_owned(), JsonValue::Object(user_record));
    jwt.insert(
        "sub".to_owned(),
        user.get("localId").cloned().unwrap_or(JsonValue::Null),
    );
    if let Some(method) = &context.sign_in_method {
        jwt.insert("sign_in_method".to_owned(), json!(method));
    }
    if let Some(factor) = &context.sign_in_second_factor {
        jwt.insert("sign_in_second_factor".to_owned(), json!(factor));
    }
    if let Some(attributes) = &context.sign_in_attributes {
        jwt.insert("sign_in_attributes".to_owned(), json!(attributes));
    }
    if let Some(raw) = &context.raw_user_info {
        jwt.insert("raw_user_info".to_owned(), json!(raw));
    }
    if let Some(tenant) = &target.tenant_id {
        jwt.insert("tenant_id".to_owned(), json!(tenant));
    }
    if target.forward_access_token {
        if let Some(token) = &oauth.access_token {
            jwt.insert("oauth_access_token".to_owned(), json!(token));
        }
        if let Some(secret) = &oauth.token_secret {
            jwt.insert("oauth_token_secret".to_owned(), json!(secret));
        }
        if let Some(expires) = &oauth.expires_in {
            jwt.insert("oauth_expires_in".to_owned(), json!(expires));
        }
    }
    if target.forward_id_token
        && let Some(token) = &oauth.id_token
    {
        jwt.insert("oauth_id_token".to_owned(), json!(token));
    }
    if target.forward_refresh_token
        && let Some(token) = &oauth.refresh_token
    {
        jwt.insert("oauth_refresh_token".to_owned(), json!(token));
    }
    unsigned_jwt(&JsonValue::Object(jwt))
}
