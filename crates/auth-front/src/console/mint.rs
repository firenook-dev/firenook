//! Tokens without signing in, and what a pasted token is.
//!
//! [`Runtime::mint`] builds the tokens a sign-in of an existing account
//! would produce — its provider, tenant and second factor, a draft of custom
//! claims, and on request what the beforeSignIn function adds — on a copy of
//! the record, so nothing is stored: no `lastLoginAt`, no `lastRefreshAt`,
//! no generation moved. It also says how the token differs from one a real
//! sign-in would produce.
//!
//! [`Runtime::inspect_token`] decodes a pasted token and judges it as the
//! Auth emulator's own calls, the Admin SDK's `verifyIdToken` (with and
//! without `checkRevoked`) and the sign-in endpoints would. It reads the
//! state without creating a project or a tenant. The rules' verdict needs the
//! rules runtime, which the console layer adds beside these.

use std::collections::BTreeMap;
use std::time::Duration;

use serde_json::{Map as JsonMap, Value as JsonValue, json};

use super::{ConsoleCall, ConsoleError, ConsoleErrorKind, MfaEntry, find_scope};
use crate::blocking::{BlockingContext, OauthTokens};
use crate::observe::ConsoleOrigin;
use crate::ops::{Ctx, custom_claims_length, validate_custom_claims};
use crate::state::{
    BlockingEvent, PROVIDER_ANONYMOUS, PROVIDER_CUSTOM, PROVIDER_PASSWORD, PROVIDER_PHONE,
    UserRecord, provider_infos,
};
use crate::token::{
    CUSTOM_TOKEN_AUDIENCE, IssueOptions, SecondFactor, decode_refresh_token, mint_without_sign_in,
};
use crate::util::{decode_jwt, now_seconds, str_field, truthy, truthy_str};
use crate::{Runtime, lock};

/// Claims Auth writes itself, after the custom claims, so a custom claim of
/// that name never reaches the token as set.
const SHADOWED: [(&str, &str); 6] = [
    ("email", "Auth writes the account's email here."),
    (
        "email_verified",
        "Auth writes whether the account's email is verified here.",
    ),
    (
        "phone_number",
        "Auth writes the account's phone number here.",
    ),
    (
        "provider_id",
        "Auth writes `anonymous` here for anonymous sign-ins and removes it otherwise.",
    ),
    ("user_id", "Auth writes the account's uid here."),
    (
        "auth_time",
        "Auth writes the time of the last sign-in here.",
    ),
];

/// Profile claims a custom claim of the same name replaces.
const OVERRIDES: [(&str, &str); 2] = [
    ("name", "Your claim replaces the account's display name."),
    ("picture", "Your claim replaces the account's photo URL."),
];

/// What to mint.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct MintRequest {
    pub uid: String,
    /// The provider the token says was used; the account's own when absent.
    pub provider: Option<String>,
    /// Custom claims to mint with instead of the stored ones: a draft.
    pub claims: Option<JsonMap<String, JsonValue>>,
    /// The second factor; absent: the account's first enrolled one.
    pub second_factor: Option<MintFactor>,
    /// Call beforeSignIn as a sign-in would and put what it returns in the
    /// token. The account is not changed; the function's side effects happen.
    pub run_before_sign_in: bool,
}

/// The second factor a minted token carries.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MintFactor {
    /// A first-factor token, as for a user without MFA.
    None,
    /// This enrolled factor.
    Enrollment(String),
}

/// A minted token and what to know about it.
#[derive(Clone, Debug, PartialEq)]
pub struct MintedToken {
    pub id_token: String,
    /// A refresh token whose grant keeps the factor and the session claims.
    pub refresh_token: String,
    /// What the emulator's `signInWithCustomToken` accepts: the strict JSON
    /// form `{"uid": …}`, with `claims` when a draft was given.
    pub custom_token: String,
    /// The ID token's payload.
    pub payload: JsonMap<String, JsonValue>,
    pub provider: String,
    /// Providers this account could sign in with.
    pub providers: Vec<String>,
    pub second_factor: Option<MfaEntry>,
    /// Epoch seconds.
    pub expires_at: i64,
    /// Claims Auth replaces with its own value in the token.
    pub shadowed: Vec<ClaimNote>,
    /// Claims that replace a profile claim (`name`, `picture`).
    pub overrides: Vec<ClaimNote>,
    /// JavaScript length (UTF-16 code units) of the claims as compact JSON.
    pub claims_length: u32,
    /// What beforeSignIn did, when it ran.
    pub before_sign_in: Option<MintBlocking>,
    /// How this token differs from one a real sign-in would produce.
    pub differences: Vec<String>,
}

/// A claim and why the token does not carry it as set.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClaimNote {
    pub key: String,
    pub reason: String,
}

/// What beforeSignIn did for a mint.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MintBlocking {
    pub function: Option<String>,
    pub duration: Duration,
    pub custom_claims: Vec<String>,
    pub session_claims: Vec<String>,
    /// The console call that ran it (shown in Activity).
    pub call: u64,
}

/// The provider a sign-in of `user` would use when none is asked for:
/// password, else phone, else its first federated provider, else custom
/// for a custom-token user, else anonymous.
fn default_provider(user: &UserRecord, linked: &[String]) -> String {
    if truthy(user.get("passwordHash")) && truthy(user.get("email")) {
        return PROVIDER_PASSWORD.to_owned();
    }
    if truthy(user.get("phoneNumber")) {
        return PROVIDER_PHONE.to_owned();
    }
    if let Some(federated) = linked
        .iter()
        .find(|provider| *provider != PROVIDER_PASSWORD && *provider != PROVIDER_PHONE)
    {
        return federated.clone();
    }
    if truthy(user.get("customAuth")) {
        return PROVIDER_CUSTOM.to_owned();
    }
    PROVIDER_ANONYMOUS.to_owned()
}

fn enrollments(user: &UserRecord) -> Vec<MfaEntry> {
    user.get("mfaInfo")
        .and_then(JsonValue::as_array)
        .into_iter()
        .flatten()
        .filter_map(JsonValue::as_object)
        .map(|enrollment| MfaEntry {
            enrollment_id: str_field(enrollment, "mfaEnrollmentId")
                .unwrap_or_default()
                .to_owned(),
            display_name: truthy_str(enrollment, "displayName").map(str::to_owned),
            phone_number: truthy_str(enrollment, "unobfuscatedPhoneInfo")
                .or_else(|| truthy_str(enrollment, "phoneInfo"))
                .map(str::to_owned),
            enrolled_at: truthy_str(enrollment, "enrolledAt").map(str::to_owned),
        })
        .collect()
}

fn claims_of(user: &UserRecord) -> JsonMap<String, JsonValue> {
    str_field(user, "customAttributes")
        .and_then(|text| serde_json::from_str::<JsonValue>(text).ok())
        .and_then(|value| match value {
            JsonValue::Object(object) => Some(object),
            _ => None,
        })
        .unwrap_or_default()
}

impl Runtime {
    /// The tokens a sign-in of `request.uid` would produce, minted without
    /// signing in. Creates nothing and changes nothing; an unknown tenant,
    /// user or second factor is `not-found`, a forbidden draft claim
    /// `invalid-argument`, a beforeSignIn refusal `failed-precondition`.
    pub async fn mint(
        &self,
        project: &str,
        tenant: Option<&str>,
        request: MintRequest,
    ) -> Result<MintedToken, ConsoleError> {
        let tenant = tenant.filter(|tenant| !tenant.is_empty());
        let record = {
            let data = lock(&self.inner.data);
            find_scope(&data, project, tenant)?.and_then(|scope| scope.shared_user(&request.uid))
        };
        let record = record.ok_or_else(|| ConsoleError::unknown_user(&request.uid, tenant))?;
        if let Some(claims) = &request.claims {
            validate_custom_claims(&JsonValue::Object(claims.clone())).map_err(|error| {
                ConsoleError::invalid(error.message)
                    .with_fix("Remove the reserved key; Firebase refuses it too.")
            })?;
        }
        let linked: Vec<String> = provider_infos(&record)
            .iter()
            .filter_map(|info| truthy_str(info, "providerId").map(str::to_owned))
            .collect();
        let mut providers = linked.clone();
        if !providers.iter().any(|provider| provider == PROVIDER_CUSTOM) {
            providers.push(PROVIDER_CUSTOM.to_owned());
        }
        if linked.is_empty() && !truthy(record.get("customAuth")) {
            providers.insert(0, PROVIDER_ANONYMOUS.to_owned());
        }
        let provider = match request
            .provider
            .as_deref()
            .filter(|value| !value.is_empty())
        {
            None => default_provider(&record, &linked),
            Some(asked) if providers.iter().any(|provider| provider == asked) => asked.to_owned(),
            Some(asked) => {
                return Err(ConsoleError::invalid(format!(
                    "This user cannot sign in with `{asked}`; it can sign in with {}.",
                    providers.join(", ")
                ))
                .with_fix("Pick one of the user's providers."));
            }
        };
        let enrolled = enrollments(&record);
        let factor = match &request.second_factor {
            None => enrolled.first().cloned(),
            Some(MintFactor::None) => None,
            Some(MintFactor::Enrollment(id)) => Some(
                enrolled
                    .iter()
                    .find(|enrollment| &enrollment.enrollment_id == id)
                    .cloned()
                    .ok_or_else(|| {
                        ConsoleError::not_found(
                            format!("This user has no second factor `{id}`."),
                            "Pick one of the user's enrolled factors, or mint without one.",
                        )
                    })?,
            ),
        };
        let mut user = UserRecord::clone(&record);
        if let Some(claims) = &request.claims {
            if claims.is_empty() {
                user.remove("customAttributes");
            } else {
                user.insert(
                    "customAttributes".to_owned(),
                    json!(JsonValue::Object(claims.clone()).to_string()),
                );
            }
        }
        let hooks = self.blocking_targets(project).await;
        let mut extra_claims = None;
        let mut before_sign_in = None;
        let ran = request.run_before_sign_in && hooks.before_sign_in.is_some();
        if ran {
            let (outcome, blocking) = self
                .mint_before_sign_in(project, tenant, &user, &provider, factor.is_some())
                .await?;
            for (field, value) in &outcome.updates {
                if value.is_null() {
                    user.remove(field);
                } else {
                    user.insert(field.clone(), value.clone());
                }
            }
            extra_claims = outcome.extra_claims;
            before_sign_in = Some(blocking);
        }
        let options = IssueOptions {
            extra_claims: extra_claims.clone(),
            second_factor: factor.as_ref().map(|factor| SecondFactor {
                identifier: factor.enrollment_id.clone(),
                provider: PROVIDER_PHONE.to_owned(),
            }),
            sign_in_attributes: None,
        };
        let tokens = mint_without_sign_in(&user, project, tenant, &provider, &options);
        let payload = decode_jwt(&tokens.id_token)
            .and_then(|(_, payload)| match payload {
                JsonValue::Object(object) => Some(object),
                _ => None,
            })
            .unwrap_or_default();
        let expires_at = payload
            .get("exp")
            .and_then(JsonValue::as_i64)
            .unwrap_or_else(|| now_seconds() + crate::token::ID_TOKEN_LIFETIME);
        let claims = claims_of(&user);
        let shadowed = SHADOWED
            .iter()
            .filter(|(key, _)| {
                claims
                    .get(*key)
                    .is_some_and(|value| payload.get(*key) != Some(value))
            })
            .map(|(key, reason)| ClaimNote {
                key: (*key).to_owned(),
                reason: (*reason).to_owned(),
            })
            .collect();
        let overrides = OVERRIDES
            .iter()
            .filter(|(key, _)| claims.contains_key(*key))
            .map(|(key, reason)| ClaimNote {
                key: (*key).to_owned(),
                reason: (*reason).to_owned(),
            })
            .collect();
        let claims_length = if claims.is_empty() {
            0
        } else {
            u32::try_from(custom_claims_length(&JsonValue::Object(claims).to_string()))
                .unwrap_or(u32::MAX)
        };
        let mut custom = JsonMap::new();
        custom.insert("uid".to_owned(), json!(request.uid));
        if let Some(claims) = &request.claims {
            custom.insert("claims".to_owned(), JsonValue::Object(claims.clone()));
        }
        let mut differences = vec![
            "auth_time is the user's last sign-in, not the time of this token.".to_owned(),
            "The user's last sign-in and last refresh times were not updated.".to_owned(),
        ];
        if request.claims.is_some() {
            differences
                .push("The custom claims are a draft: they are in this token only.".to_owned());
        }
        match (&hooks.before_sign_in, ran) {
            (Some(_), false) => differences.push(
                "Your beforeSignIn function did not run; a real sign-in would call it.".to_owned(),
            ),
            (Some(_), true) => differences.push(
                "beforeSignIn ran, but the account was not changed: what it set is in this token only."
                    .to_owned(),
            ),
            (None, _) => {}
        }
        if truthy(record.get("disabled")) {
            differences.push(
                "This user is disabled: a real sign-in fails with USER_DISABLED, but the rules accept this token."
                    .to_owned(),
            );
        }
        if !enrolled.is_empty() && factor.is_none() {
            differences.push(
                "This user has a second factor; a real sign-in ends with it, and this token has none."
                    .to_owned(),
            );
        }
        Ok(MintedToken {
            id_token: tokens.id_token,
            refresh_token: tokens.refresh_token,
            custom_token: JsonValue::Object(custom).to_string(),
            payload,
            provider,
            providers,
            second_factor: factor,
            expires_at,
            shadowed,
            overrides,
            claims_length,
            before_sign_in,
            differences,
        })
    }

    /// Runs beforeSignIn for a mint, as one console call of origin `try`
    /// (so the run and its step appear in Activity).
    async fn mint_before_sign_in(
        &self,
        project: &str,
        tenant: Option<&str>,
        user: &UserRecord,
        provider: &str,
        second_factor: bool,
    ) -> Result<(crate::blocking::BlockingOutcome, MintBlocking), ConsoleError> {
        let mut call =
            ConsoleCall::start(self, "mint", "/tokens", project, tenant, ConsoleOrigin::Try);
        let uid = crate::observe::uid_of(user);
        call.describe(
            truthy_str(user, "email")
                .or_else(|| truthy_str(user, "phoneNumber"))
                .map(str::to_owned)
                .or_else(|| uid.clone()),
            uid,
        );
        let ctx = Ctx {
            project_id: project.to_owned(),
            tenant_id: tenant.map(str::to_owned),
            privileged: true,
            body: JsonMap::new(),
            query: BTreeMap::new(),
            emulator_url: self.emulator_url(None),
            trace: call.trace().clone(),
        };
        let context = BlockingContext {
            sign_in_method: Some(provider.to_owned()),
            sign_in_second_factor: second_factor.then(|| PROVIDER_PHONE.to_owned()),
            ..BlockingContext::default()
        };
        let (result, report) = self
            .blocking_reported(
                &ctx,
                BlockingEvent::BeforeSignIn,
                user,
                &context,
                &OauthTokens::default(),
            )
            .await;
        match result {
            Ok(outcome) => {
                let blocking = MintBlocking {
                    function: report
                        .as_ref()
                        .and_then(|report| crate::observe::function_of(&report.uri)),
                    duration: report
                        .as_ref()
                        .map_or(Duration::ZERO, |report| report.duration),
                    custom_claims: crate::observe::object_keys_of_text(str_field(
                        &outcome.updates,
                        "customAttributes",
                    )),
                    session_claims: outcome
                        .extra_claims
                        .as_ref()
                        .map(|claims| claims.keys().cloned().collect())
                        .unwrap_or_default(),
                    call: call.id(),
                };
                call.finish(self, None);
                Ok((outcome, blocking))
            }
            Err(error) => {
                let message = report
                    .and_then(|report| report.failure)
                    .map_or(error.message, |failure| failure.message);
                let refused = ConsoleError::of_kind(
                    ConsoleErrorKind::FailedPrecondition,
                    format!("Your beforeSignIn function refused this sign-in: {message}"),
                )
                .with_fix("Turn off Run beforeSignIn, or change the function.");
                call.finish(self, Some(&refused));
                Err(refused)
            }
        }
    }
}

// ---------------------------------------------------------------- inspection

/// What a pasted token is, and how each consumer judges it.
#[derive(Clone, Debug, PartialEq)]
pub struct TokenInspection {
    pub kind: TokenKind,
    /// The header says a real algorithm (production-signed), not `none`.
    pub signed: bool,
    pub header: Option<JsonMap<String, JsonValue>>,
    pub payload: Option<JsonMap<String, JsonValue>>,
    pub project: Option<String>,
    pub tenant: Option<String>,
    pub uid: Option<String>,
    /// The account exists in that tenant (or the project) now.
    pub user_exists: bool,
    /// One verdict per consumer, in the order the console lists them. The
    /// rules' verdict is the console layer's.
    pub checks: Vec<TokenCheck>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TokenKind {
    IdToken,
    SessionCookie,
    CustomToken,
    RefreshToken,
    Unknown,
}

/// One consumer's verdict.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TokenCheck {
    pub consumer: TokenConsumer,
    pub ok: bool,
    pub reason: Option<String>,
    pub fix: Option<String>,
}

impl TokenCheck {
    fn pass(consumer: TokenConsumer, reason: Option<String>) -> Self {
        Self {
            consumer,
            ok: true,
            reason,
            fix: None,
        }
    }

    fn fail(consumer: TokenConsumer, reason: String, fix: &str) -> Self {
        Self {
            consumer,
            ok: false,
            reason: Some(reason),
            fix: Some(fix.to_owned()),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TokenConsumer {
    /// Firestore and Storage rules (`request.auth`).
    Rules,
    /// The Auth emulator's own calls that take an ID token.
    AuthEmulator,
    /// `verifyIdToken` / `verifySessionCookie` with the Admin SDK.
    Verify,
    /// The same with `checkRevoked: true`.
    VerifyRevoked,
    /// `signInWithCustomToken` (custom tokens) or the refresh grant.
    SignIn,
}

/// `14 min`, `3 s`, `2 h`, `5 days`.
fn span(seconds: i64) -> String {
    let seconds = seconds.unsigned_abs();
    match seconds {
        0..60 => format!("{seconds} s"),
        60..3_600 => format!("{} min", seconds / 60),
        3_600..86_400 => format!("{} h", seconds / 3_600),
        _ => {
            let days = seconds / 86_400;
            if days == 1 {
                "1 day".to_owned()
            } else {
                format!("{days} days")
            }
        }
    }
}

/// `10:02:11` (UTC) for epoch seconds.
fn clock(seconds: i64) -> String {
    time::OffsetDateTime::from_unix_timestamp(seconds).map_or_else(
        |_| seconds.to_string(),
        |at| format!("{:02}:{:02}:{:02} UTC", at.hour(), at.minute(), at.second()),
    )
}

/// The JSON a refresh token encodes.
fn base64_json(token: &str) -> Option<JsonValue> {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD
        .decode(token)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
}

fn object(value: JsonValue) -> Option<JsonMap<String, JsonValue>> {
    match value {
        JsonValue::Object(object) => Some(object),
        _ => None,
    }
}

fn text(object: &JsonMap<String, JsonValue>, key: &str) -> Option<String> {
    object
        .get(key)
        .and_then(JsonValue::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

/// The account a token names, read without creating anything: `Err` with
/// the sentence when the tenant is unknown.
fn account(
    runtime: &Runtime,
    project: &str,
    tenant: Option<&str>,
    uid: Option<&str>,
) -> Result<Option<UserRecord>, String> {
    let data = lock(&runtime.inner.data);
    let Some(agent) = data.projects.get(project) else {
        return Ok(None);
    };
    let scope = match tenant {
        None => &agent.project,
        Some(tenant) => match agent.tenants.get(tenant) {
            Some(state) => &state.project,
            None => {
                return Err(format!(
                    "There is no tenant `{tenant}` in project `{project}`."
                ));
            }
        },
    };
    Ok(uid.and_then(|uid| scope.get_user_by_local_id(uid)))
}

impl Runtime {
    /// Decodes `token` (an ID token, a session cookie, a custom token in
    /// JSON or JWT form, or a refresh token) and judges it for `project`, the
    /// project the console runs. Changes and creates nothing.
    #[must_use]
    pub fn inspect_token(&self, project: &str, token: &str) -> TokenInspection {
        let token = token.trim();
        let token = token
            .strip_prefix("Bearer ")
            .or_else(|| token.strip_prefix("bearer "))
            .unwrap_or(token)
            .trim();
        if let Some((header, payload)) = decode_jwt(token) {
            let header = object(header);
            let payload = object(payload).unwrap_or_default();
            let signed = header
                .as_ref()
                .and_then(|header| header.get("alg"))
                .and_then(JsonValue::as_str)
                != Some("none");
            let issuer = text(&payload, "iss").unwrap_or_default();
            if issuer.starts_with("https://securetoken.google.com/") {
                return self.inspect_id_token(project, header, payload, signed, false);
            }
            if issuer.starts_with("https://session.firebase.google.com/") {
                return self.inspect_id_token(project, header, payload, signed, true);
            }
            if payload.get("aud").and_then(JsonValue::as_str) == Some(CUSTOM_TOKEN_AUDIENCE) {
                return Self::inspect_custom_token(header, payload, signed);
            }
            return TokenInspection {
                kind: TokenKind::Unknown,
                signed,
                header,
                payload: Some(payload),
                project: None,
                tenant: None,
                uid: None,
                user_exists: false,
                checks: Vec::new(),
            };
        }
        if token.starts_with('{')
            && let Some(payload) = serde_json::from_str::<JsonValue>(token)
                .ok()
                .and_then(object)
        {
            return Self::inspect_custom_token(None, payload, false);
        }
        if decode_refresh_token(token).is_ok() {
            return self.inspect_refresh_token(project, token);
        }
        TokenInspection {
            kind: TokenKind::Unknown,
            signed: false,
            header: None,
            payload: None,
            project: None,
            tenant: None,
            uid: None,
            user_exists: false,
            checks: Vec::new(),
        }
    }

    fn inspect_id_token(
        &self,
        project: &str,
        header: Option<JsonMap<String, JsonValue>>,
        payload: JsonMap<String, JsonValue>,
        signed: bool,
        cookie: bool,
    ) -> TokenInspection {
        let now = now_seconds();
        let audience = text(&payload, "aud");
        let tenant = payload
            .get("firebase")
            .and_then(JsonValue::as_object)
            .and_then(|firebase| text(firebase, "tenant"));
        let uid = text(&payload, "user_id").or_else(|| text(&payload, "sub"));
        let issued = payload.get("iat").and_then(JsonValue::as_i64).unwrap_or(0);
        let auth_time = payload
            .get("auth_time")
            .and_then(JsonValue::as_i64)
            .unwrap_or(issued);
        let expires = payload.get("exp").and_then(JsonValue::as_i64);
        let looked_up = account(self, project, tenant.as_deref(), uid.as_deref());
        let user = looked_up.as_ref().ok().cloned().flatten();
        let place = tenant.as_ref().map_or_else(
            || "among the project's users".to_owned(),
            |tenant| format!("in tenant `{tenant}`"),
        );
        let valid_since = user
            .as_ref()
            .and_then(|user| super::millis_field(user, "validSince"));

        // The emulator's own calls: tenant, user, validSince, disabled; not exp.
        let emulator = match &looked_up {
            Err(sentence) => TokenCheck::fail(
                TokenConsumer::AuthEmulator,
                format!(
                    "{sentence} The emulator would create it and then find no user (USER_NOT_FOUND)."
                ),
                "Sign in against the tenant the app uses, or create it in Settings.",
            ),
            Ok(None) => TokenCheck::fail(
                TokenConsumer::AuthEmulator,
                format!(
                    "There is no user `{}` {place}: the emulator answers USER_NOT_FOUND.",
                    uid.as_deref().unwrap_or("")
                ),
                "The account was deleted, or the app signed in against another project or tenant.",
            ),
            Ok(Some(user)) => {
                if let Some(since) = valid_since.filter(|since| issued < *since)
                    && truthy(user.get("validSince"))
                {
                    TokenCheck::fail(
                        TokenConsumer::AuthEmulator,
                        format!(
                            "Issued at {}, before the user's tokens were revoked at {}: the emulator answers TOKEN_EXPIRED.",
                            clock(issued),
                            clock(since)
                        ),
                        "Sign in again to get a fresh token.",
                    )
                } else if truthy(user.get("disabled")) {
                    TokenCheck::fail(
                        TokenConsumer::AuthEmulator,
                        "The user is disabled: the emulator answers USER_DISABLED.".to_owned(),
                        "Enable the user in the inspector, or test the disabled path on purpose.",
                    )
                } else {
                    TokenCheck::pass(
                        TokenConsumer::AuthEmulator,
                        expires.filter(|exp| *exp <= now).map(|_| {
                            "Accepted although it has expired: the emulator's own calls do not check `exp`."
                                .to_owned()
                        }),
                    )
                }
            }
        };

        // The Admin SDK: audience, issuer, subject, expiry.
        let expected_issuer = if cookie {
            format!("https://session.firebase.google.com/{project}")
        } else {
            format!("https://securetoken.google.com/{project}")
        };
        let what = if cookie { "session cookie" } else { "ID token" };
        let verify = if audience.as_deref() != Some(project) {
            TokenCheck::fail(
                TokenConsumer::Verify,
                format!(
                    "This {what} is for project `{}`; the emulator runs `{project}`.",
                    audience.as_deref().unwrap_or("")
                ),
                &format!(
                    "Initialize the app and the Admin SDK with projectId `{project}` (initializeApp({{ projectId: '{project}' }}))."
                ),
            )
        } else if text(&payload, "iss").as_deref() != Some(expected_issuer.as_str()) {
            TokenCheck::fail(
                TokenConsumer::Verify,
                format!("The {what}'s issuer is not `{expected_issuer}`."),
                "Use a token the Auth emulator issued for this project.",
            )
        } else if uid.as_deref().is_none_or(|uid| uid.chars().count() > 128) {
            TokenCheck::fail(
                TokenConsumer::Verify,
                format!(
                    "The {what} names no user (its `sub` is empty or longer than 128 characters)."
                ),
                "Use a token the Auth emulator issued.",
            )
        } else if let Some(exp) = expires.filter(|exp| *exp <= now) {
            TokenCheck::fail(
                TokenConsumer::Verify,
                format!("Expired {} ago (exp {}).", span(now - exp), clock(exp)),
                "Get a fresh token: the app's SDK refreshes it on its own; sign in again otherwise.",
            )
        } else if expires.is_none() {
            TokenCheck::fail(
                TokenConsumer::Verify,
                format!("The {what} has no `exp`."),
                "Use a token the Auth emulator issued.",
            )
        } else {
            TokenCheck::pass(
                TokenConsumer::Verify,
                signed.then(|| {
                    "Signed by production Firebase: the Admin SDK pointed at the emulator does not check signatures."
                        .to_owned()
                }),
            )
        };
        let revoked = match (verify.ok, &user) {
            (false, _) => TokenCheck {
                consumer: TokenConsumer::VerifyRevoked,
                ..verify.clone()
            },
            (true, None) => TokenCheck::fail(
                TokenConsumer::VerifyRevoked,
                format!(
                    "There is no user `{}` {place}: the Admin SDK answers auth/user-not-found.",
                    uid.as_deref().unwrap_or("")
                ),
                "The account was deleted, or the token is from another project or tenant.",
            ),
            (true, Some(user)) if truthy(user.get("disabled")) => TokenCheck::fail(
                TokenConsumer::VerifyRevoked,
                "The user is disabled: the Admin SDK answers auth/user-disabled.".to_owned(),
                "Enable the user in the inspector, or test the disabled path on purpose.",
            ),
            (true, Some(_)) => match valid_since.filter(|since| auth_time < *since) {
                Some(since) => TokenCheck::fail(
                    TokenConsumer::VerifyRevoked,
                    format!(
                        "Revoked: the user signed in at {}, before the tokens were revoked at {} (auth/id-token-revoked).",
                        clock(auth_time),
                        clock(since)
                    ),
                    "Sign in again to get a fresh token.",
                ),
                None => TokenCheck::pass(TokenConsumer::VerifyRevoked, None),
            },
        };
        TokenInspection {
            kind: if cookie {
                TokenKind::SessionCookie
            } else {
                TokenKind::IdToken
            },
            signed,
            header,
            payload: Some(payload),
            project: audience,
            tenant,
            uid,
            user_exists: user.is_some(),
            checks: vec![emulator, verify, revoked],
        }
    }

    fn inspect_custom_token(
        header: Option<JsonMap<String, JsonValue>>,
        payload: JsonMap<String, JsonValue>,
        signed: bool,
    ) -> TokenInspection {
        let uid = crate::util::coerce_primitive_to_string(payload.get("uid"))
            .or_else(|| crate::util::coerce_primitive_to_string(payload.get("user_id")))
            .filter(|uid| !uid.is_empty());
        let tenant = text(&payload, "tenant_id");
        let claims = payload.get("claims").map(validate_custom_claims);
        let sign_in = match (&uid, claims) {
            (None, _) => TokenCheck::fail(
                TokenConsumer::SignIn,
                "The custom token names no uid: signInWithCustomToken answers MISSING_IDENTIFIER."
                    .to_owned(),
                "Create the token with a uid (createCustomToken(uid)).",
            ),
            (Some(_), Some(Err(error))) => TokenCheck::fail(
                TokenConsumer::SignIn,
                format!(
                    "signInWithCustomToken refuses its claims: {}.",
                    error.message
                ),
                "Remove the reserved key; Firebase refuses it too.",
            ),
            (Some(uid), _) => TokenCheck::pass(
                TokenConsumer::SignIn,
                Some(if signed {
                    format!(
                        "Signed by a service account: the emulator accepts it without checking the signature and signs in `{uid}`."
                    )
                } else {
                    format!("signInWithCustomToken accepts it and signs in `{uid}`.")
                }),
            ),
        };
        let verify = TokenCheck::fail(
            TokenConsumer::Verify,
            "A custom token is not an ID token: verifyIdToken refuses it.".to_owned(),
            "Exchange it for an ID token with signInWithCustomToken first.",
        );
        TokenInspection {
            kind: TokenKind::CustomToken,
            signed,
            header,
            payload: Some(payload),
            project: None,
            tenant,
            uid,
            user_exists: false,
            checks: vec![sign_in, verify],
        }
    }

    fn inspect_refresh_token(&self, project: &str, token: &str) -> TokenInspection {
        let record = decode_refresh_token(token).ok();
        let payload = base64_json(token).and_then(object);
        let (token_project, tenant, uid) = record.as_ref().map_or((None, None, None), |record| {
            (
                Some(record.project_id.clone()).filter(|project| !project.is_empty()),
                record.tenant_id.clone(),
                Some(record.local_id.clone()).filter(|uid| !uid.is_empty()),
            )
        });
        let looked_up = account(self, project, tenant.as_deref(), uid.as_deref());
        let user = looked_up.as_ref().ok().cloned().flatten();
        let sign_in = match (token_project.as_deref() == Some(project), &looked_up) {
            (false, _) => TokenCheck::fail(
                TokenConsumer::SignIn,
                format!(
                    "This refresh token is for project `{}`; the emulator runs `{project}`: the grant answers INVALID_REFRESH_TOKEN.",
                    token_project.as_deref().unwrap_or("")
                ),
                "Sign in again against this project.",
            ),
            (true, Err(sentence)) => TokenCheck::fail(
                TokenConsumer::SignIn,
                format!("{sentence} The grant would find no user (INVALID_REFRESH_TOKEN)."),
                "Sign in against the tenant the app uses, or create it in Settings.",
            ),
            (true, Ok(None)) => TokenCheck::fail(
                TokenConsumer::SignIn,
                "The user it was issued to no longer exists: the grant answers INVALID_REFRESH_TOKEN."
                    .to_owned(),
                "Sign in again.",
            ),
            (true, Ok(Some(user))) if truthy(user.get("disabled")) => TokenCheck::fail(
                TokenConsumer::SignIn,
                "The user is disabled: the grant answers USER_DISABLED.".to_owned(),
                "Enable the user in the inspector, or test the disabled path on purpose.",
            ),
            (true, Ok(Some(_))) => TokenCheck::pass(
                TokenConsumer::SignIn,
                Some(
                    "The refresh grant accepts it. A refresh grant does not check validSince, as in the official emulator: revoking does not stop it."
                        .to_owned(),
                ),
            ),
        };
        let verify = TokenCheck::fail(
            TokenConsumer::Verify,
            "A refresh token is not an ID token: verifyIdToken refuses it.".to_owned(),
            "Exchange it for an ID token with the refresh grant (securetoken.googleapis.com/v1/token).",
        );
        TokenInspection {
            kind: TokenKind::RefreshToken,
            signed: false,
            header: None,
            payload,
            project: token_project,
            tenant,
            uid,
            user_exists: user.is_some(),
            checks: vec![sign_in, verify],
        }
    }
}

#[cfg(test)]
#[path = "mint_tests.rs"]
mod tests;
