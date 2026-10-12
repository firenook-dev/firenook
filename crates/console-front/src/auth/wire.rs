//! Every Auth Console API type, as the console reads it (generated into
//! `console/src/api/generated/auth/`). auth-front answers in plain Rust
//! values; these are their wire forms, converted with `From`. Every name
//! starts with `Auth`, the family prefix, so nothing collides with another
//! section's generated types.

use firenook_auth_front::console as engine;
use firenook_auth_front::console::{bulk, export, import, mint, tenants};
use firenook_auth_front::observe;
use firenook_auth_front::util::iso_from_millis;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::jobs::BulkTarget;
use crate::paging::{BatchGetResponse, Page, Total};

fn count(value: usize) -> u64 {
    u64::try_from(value).unwrap_or(u64::MAX)
}

fn micros(duration: std::time::Duration) -> u64 {
    u64::try_from(duration.as_micros()).unwrap_or(u64::MAX)
}

// ---------------------------------------------------------------- users

/// One page of the users table: the foundation's `Page<AuthUserRow>`
/// (items, nextCursor, prevCursor, total, scanned) flattened, so the
/// console's `useCursorRows` takes it as it is, plus what only the first
/// page carries. `total` is exact (the index counts; `scanned` stays null).
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "auth/")]
pub struct AuthUsersPage {
    #[serde(flatten)]
    pub page: Page<AuthUserRow>,
    /// Counts for the filters panel. First page only.
    pub facets: Option<AuthUserFacets>,
    /// Users in this tenant (or the project), whatever the filter. First
    /// page only.
    #[ts(type = "number | null")]
    pub scope_total: Option<u64>,
    /// Microseconds the engine spent, for the count's tooltip.
    #[ts(type = "number")]
    pub took_micros: u64,
}

/// What one 32 px row shows — never the whole record.
// The flags are the row's own columns, one each.
#[allow(clippy::struct_excessive_bools)]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "auth/")]
pub struct AuthUserRow {
    /// `localId`.
    pub uid: String,
    /// The tenant the user belongs to; null for the project's own users.
    pub tenant: Option<String>,
    pub email: Option<String>,
    pub email_verified: bool,
    pub phone_number: Option<String>,
    pub display_name: Option<String>,
    pub photo_url: Option<String>,
    /// Linked provider ids, in link order.
    pub providers: Vec<String>,
    /// No linked provider and no custom-token sign-in.
    pub anonymous: bool,
    pub disabled: bool,
    /// Second factors enrolled.
    pub mfa: u32,
    /// Top-level custom claim keys, in key order.
    pub claim_keys: Vec<String>,
    /// Signed in with a custom token.
    pub custom_auth: bool,
    /// Epoch milliseconds.
    #[ts(type = "number | null")]
    pub created_at: Option<i64>,
    /// `lastLoginAt`, epoch milliseconds.
    #[ts(type = "number | null")]
    pub last_sign_in_at: Option<i64>,
}

impl From<engine::UserRow> for AuthUserRow {
    fn from(row: engine::UserRow) -> Self {
        Self {
            uid: row.uid,
            tenant: row.tenant,
            email: row.email,
            email_verified: row.email_verified,
            phone_number: row.phone_number,
            display_name: row.display_name,
            photo_url: row.photo_url,
            providers: row.providers,
            anonymous: row.anonymous,
            disabled: row.disabled,
            mfa: row.mfa,
            claim_keys: row.claim_keys,
            custom_auth: row.custom_auth,
            created_at: row.created_at,
            last_sign_in_at: row.last_sign_in_at,
        }
    }
}

/// Counts over the users the filter's base terms select (words, `email`,
/// `phone`, `name`, `uid`, `created`, `signed-in`), ignoring its facet
/// terms (`is`, `has`, `provider`, `claim`), so a count does not change
/// when its own facet is pressed.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "auth/")]
pub struct AuthUserFacets {
    #[ts(type = "number")]
    pub disabled: u64,
    /// Users with an email that is not verified.
    #[ts(type = "number")]
    pub unverified: u64,
    #[ts(type = "number")]
    pub anonymous: u64,
    #[ts(type = "number")]
    pub custom_token: u64,
    #[ts(type = "number")]
    pub sample: u64,
    #[ts(type = "number")]
    pub mfa: u64,
    #[ts(type = "number")]
    pub claims: u64,
    #[ts(type = "number")]
    pub never_signed_in: u64,
    /// Users per provider id, most first.
    pub providers: Vec<AuthProviderCount>,
}

impl From<engine::UserFacets> for AuthUserFacets {
    fn from(facets: engine::UserFacets) -> Self {
        Self {
            disabled: facets.disabled,
            unverified: facets.unverified,
            anonymous: facets.anonymous,
            custom_token: facets.custom_token,
            sample: facets.sample,
            mfa: facets.mfa,
            claims: facets.claims,
            never_signed_in: facets.never_signed_in,
            providers: facets
                .providers
                .into_iter()
                .map(AuthProviderCount::from)
                .collect(),
        }
    }
}

/// Users per provider id.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "auth/")]
pub struct AuthProviderCount {
    pub provider: String,
    #[ts(type = "number")]
    pub users: u64,
}

impl From<engine::ProviderCount> for AuthProviderCount {
    fn from(count: engine::ProviderCount) -> Self {
        Self {
            provider: count.provider,
            users: count.users,
        }
    }
}

/// `POST /users:batchGet`: the foundation's answer (one item per uid, in
/// the request's order: the row, or none when deleted or no longer
/// matching `q`, and the loaded page it sorts into), plus the figures the
/// page shows, recounted for the request's `q`, so one request per live
/// window patches rows and refreshes the count and the panel.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "auth/")]
pub struct AuthUsersBatchGet {
    #[serde(flatten)]
    pub rows: BatchGetResponse<AuthUserRow>,
    pub total: Total,
    pub facets: AuthUserFacets,
    #[ts(type = "number")]
    pub scope_total: u64,
}

/// One account in full, for the inspector.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "auth/")]
pub struct AuthUserDetail {
    pub row: AuthUserRow,
    /// The password, when it is stored in the emulator's recoverable form
    /// (`fakeHash:salt=…:password=<this>`).
    pub password: Option<String>,
    /// A password hash is set that the emulator cannot read back (imported
    /// from production).
    pub password_opaque: bool,
    #[ts(type = "number | null")]
    pub password_updated_at: Option<i64>,
    /// ID tokens issued before this instant are refused, epoch seconds.
    #[ts(type = "number | null")]
    pub valid_since: Option<i64>,
    /// Epoch milliseconds.
    #[ts(type = "number | null")]
    pub last_refresh_at: Option<i64>,
    pub initial_email: Option<String>,
    pub email_link_sign_in: bool,
    pub provider_info: Vec<AuthProviderInfo>,
    pub mfa: Vec<AuthMfaEnrollment>,
    pub passkeys: Vec<AuthPasskey>,
    /// Custom claims exactly as stored (`customAttributes`).
    pub claims_text: Option<String>,
    #[ts(type = "Record<string, unknown> | null")]
    pub claims: Option<serde_json::Map<String, serde_json::Value>>,
    /// JavaScript length (UTF-16 code units) of `claimsText`: the measure
    /// the 1,000 limit applies to.
    pub claims_length: u32,
    /// The stored record as exported to `accounts.json`.
    #[ts(type = "Record<string, unknown>")]
    pub record: serde_json::Map<String, serde_json::Value>,
}

impl From<engine::UserDetail> for AuthUserDetail {
    fn from(detail: engine::UserDetail) -> Self {
        Self {
            row: detail.row.into(),
            password: detail.password,
            password_opaque: detail.password_opaque,
            password_updated_at: detail.password_updated_at,
            valid_since: detail.valid_since,
            last_refresh_at: detail.last_refresh_at,
            initial_email: detail.initial_email,
            email_link_sign_in: detail.email_link_sign_in,
            provider_info: detail
                .provider_info
                .into_iter()
                .map(AuthProviderInfo::from)
                .collect(),
            mfa: detail
                .mfa
                .into_iter()
                .map(AuthMfaEnrollment::from)
                .collect(),
            passkeys: detail.passkeys.into_iter().map(AuthPasskey::from).collect(),
            claims_text: detail.claims_text,
            claims: detail.claims,
            claims_length: detail.claims_length,
            record: detail.record,
        }
    }
}

/// One linked sign-in provider of an account.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "auth/")]
pub struct AuthProviderInfo {
    pub provider_id: String,
    pub raw_id: Option<String>,
    pub email: Option<String>,
    pub display_name: Option<String>,
    pub photo_url: Option<String>,
    pub phone_number: Option<String>,
    pub federated_id: Option<String>,
    pub screen_name: Option<String>,
}

impl From<engine::ProviderEntry> for AuthProviderInfo {
    fn from(entry: engine::ProviderEntry) -> Self {
        Self {
            provider_id: entry.provider_id,
            raw_id: entry.raw_id,
            email: entry.email,
            display_name: entry.display_name,
            photo_url: entry.photo_url,
            phone_number: entry.phone_number,
            federated_id: entry.federated_id,
            screen_name: entry.screen_name,
        }
    }
}

/// One enrolled second factor.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "auth/")]
pub struct AuthMfaEnrollment {
    pub enrollment_id: String,
    pub display_name: Option<String>,
    /// The full number (`unobfuscatedPhoneInfo`), not the masked one tokens
    /// carry.
    pub phone_number: Option<String>,
    pub enrolled_at: Option<String>,
}

impl From<engine::MfaEntry> for AuthMfaEnrollment {
    fn from(entry: engine::MfaEntry) -> Self {
        Self {
            enrollment_id: entry.enrollment_id,
            display_name: entry.display_name,
            phone_number: entry.phone_number,
            enrolled_at: entry.enrolled_at,
        }
    }
}

/// One passkey of an account.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "auth/")]
pub struct AuthPasskey {
    pub credential_id: String,
    pub name: Option<String>,
}

impl From<engine::PasskeyEntry> for AuthPasskey {
    fn from(entry: engine::PasskeyEntry) -> Self {
        Self {
            credential_id: entry.credential_id,
            name: entry.name,
        }
    }
}

// ---------------------------------------------------------------- tokens

/// The second factor a minted token carries.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export_to = "auth/")]
pub enum AuthMintFactor {
    /// A first-factor token, as for a user without MFA.
    None,
    /// This enrolled factor.
    #[serde(rename_all = "camelCase")]
    Enrollment { id: String },
}

impl From<AuthMintFactor> for mint::MintFactor {
    fn from(factor: AuthMintFactor) -> Self {
        match factor {
            AuthMintFactor::None => Self::None,
            AuthMintFactor::Enrollment { id } => Self::Enrollment(id),
        }
    }
}

/// The tokens a sign-in of an account would produce, minted without signing
/// in. `idToken` and `expiresAt` keep the meaning `AuthToken` gives them.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "auth/")]
pub struct AuthMintedToken {
    pub id_token: String,
    /// When the ID token stops being accepted, RFC 3339.
    pub expires_at: String,
    /// A refresh token whose grant keeps the factor and the session claims.
    pub refresh_token: String,
    /// A token the emulator's `signInWithCustomToken` accepts: the strict
    /// JSON form `{"uid": …}` (with `claims` when they were given).
    pub custom_token: String,
    /// The ID token's payload.
    #[ts(type = "Record<string, unknown>")]
    pub payload: serde_json::Map<String, serde_json::Value>,
    pub provider: String,
    /// Providers this account could have signed in with.
    pub providers: Vec<String>,
    /// The factor the token carries, when any.
    pub second_factor: Option<AuthMfaEnrollment>,
    /// Claims Auth replaces with its own value in the token.
    pub shadowed: Vec<AuthClaimNote>,
    /// Claims that replace a profile claim (`name`, `picture`).
    pub overrides: Vec<AuthClaimNote>,
    /// JavaScript length (UTF-16 code units) of the claims as compact JSON.
    pub claims_length: u32,
    /// What beforeSignIn did, when it ran.
    pub before_sign_in: Option<AuthMintBlocking>,
    /// How this token differs from one a real sign-in would produce, one
    /// sentence each.
    pub differences: Vec<String>,
}

impl From<mint::MintedToken> for AuthMintedToken {
    fn from(token: mint::MintedToken) -> Self {
        Self {
            expires_at: rfc3339_seconds(token.expires_at),
            id_token: token.id_token,
            refresh_token: token.refresh_token,
            custom_token: token.custom_token,
            payload: token.payload,
            provider: token.provider,
            providers: token.providers,
            second_factor: token.second_factor.map(AuthMfaEnrollment::from),
            shadowed: token
                .shadowed
                .into_iter()
                .map(AuthClaimNote::from)
                .collect(),
            overrides: token
                .overrides
                .into_iter()
                .map(AuthClaimNote::from)
                .collect(),
            claims_length: token.claims_length,
            before_sign_in: token.before_sign_in.map(AuthMintBlocking::from),
            differences: token.differences,
        }
    }
}

/// Epoch seconds in RFC 3339.
pub(crate) fn rfc3339_seconds(seconds: i64) -> String {
    time::OffsetDateTime::from_unix_timestamp(seconds)
        .ok()
        .and_then(|at| {
            at.format(&time::format_description::well_known::Rfc3339)
                .ok()
        })
        .unwrap_or_default()
}

/// What beforeSignIn did for a mint.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "auth/")]
pub struct AuthMintBlocking {
    pub function: Option<String>,
    #[ts(type = "number")]
    pub duration_micros: u64,
    pub custom_claims: Vec<String>,
    pub session_claims: Vec<String>,
    /// The console call that ran it: its Activity entry.
    #[ts(type = "number")]
    pub call: u64,
}

impl From<mint::MintBlocking> for AuthMintBlocking {
    fn from(blocking: mint::MintBlocking) -> Self {
        Self {
            function: blocking.function,
            duration_micros: micros(blocking.duration),
            custom_claims: blocking.custom_claims,
            session_claims: blocking.session_claims,
            call: blocking.call,
        }
    }
}

/// A claim and why the token does not carry it as set.
#[derive(Clone, Debug, Serialize, TS)]
#[ts(export_to = "auth/")]
pub struct AuthClaimNote {
    pub key: String,
    pub reason: String,
}

impl From<mint::ClaimNote> for AuthClaimNote {
    fn from(note: mint::ClaimNote) -> Self {
        Self {
            key: note.key,
            reason: note.reason,
        }
    }
}

/// `POST /token/inspect`.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(export_to = "auth/")]
pub struct AuthTokenInspectRequest {
    pub token: String,
}

/// What a pasted token is, and how each consumer judges it.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "auth/")]
pub struct AuthTokenInspection {
    pub kind: AuthTokenKind,
    /// The header says a real algorithm (production-signed), not `none`.
    pub signed: bool,
    #[ts(type = "Record<string, unknown> | null")]
    pub header: Option<serde_json::Map<String, serde_json::Value>>,
    #[ts(type = "Record<string, unknown> | null")]
    pub payload: Option<serde_json::Map<String, serde_json::Value>>,
    pub project: Option<String>,
    pub tenant: Option<String>,
    pub uid: Option<String>,
    /// The account exists in that tenant (or the project) now.
    pub user_exists: bool,
    /// One verdict per consumer, in the order the console lists them.
    pub checks: Vec<AuthTokenCheck>,
}

impl From<mint::TokenInspection> for AuthTokenInspection {
    fn from(inspection: mint::TokenInspection) -> Self {
        Self {
            kind: inspection.kind.into(),
            signed: inspection.signed,
            header: inspection.header,
            payload: inspection.payload,
            project: inspection.project,
            tenant: inspection.tenant,
            uid: inspection.uid,
            user_exists: inspection.user_exists,
            checks: inspection
                .checks
                .into_iter()
                .map(AuthTokenCheck::from)
                .collect(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "auth/")]
pub enum AuthTokenKind {
    IdToken,
    SessionCookie,
    CustomToken,
    RefreshToken,
    Unknown,
}

impl From<mint::TokenKind> for AuthTokenKind {
    fn from(kind: mint::TokenKind) -> Self {
        match kind {
            mint::TokenKind::IdToken => Self::IdToken,
            mint::TokenKind::SessionCookie => Self::SessionCookie,
            mint::TokenKind::CustomToken => Self::CustomToken,
            mint::TokenKind::RefreshToken => Self::RefreshToken,
            mint::TokenKind::Unknown => Self::Unknown,
        }
    }
}

/// One consumer's verdict.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "auth/")]
pub struct AuthTokenCheck {
    pub consumer: AuthTokenConsumer,
    pub ok: bool,
    /// Why it is refused, or a note on why it is accepted.
    pub reason: Option<String>,
    pub fix: Option<String>,
}

impl From<mint::TokenCheck> for AuthTokenCheck {
    fn from(check: mint::TokenCheck) -> Self {
        Self {
            consumer: check.consumer.into(),
            ok: check.ok,
            reason: check.reason,
            fix: check.fix,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "auth/")]
pub enum AuthTokenConsumer {
    /// Firestore and Storage rules (`request.auth`).
    Rules,
    /// The Auth emulator's own calls that take an ID token
    /// (`accounts:lookup`, `accounts:update`).
    AuthEmulator,
    /// `verifyIdToken(token)` / `verifySessionCookie(cookie)` with the Admin
    /// SDK.
    Verify,
    /// The same with `checkRevoked: true`.
    VerifyRevoked,
    /// `signInWithCustomToken` (custom tokens) or the refresh grant (refresh
    /// tokens).
    SignIn,
}

impl From<mint::TokenConsumer> for AuthTokenConsumer {
    fn from(consumer: mint::TokenConsumer) -> Self {
        match consumer {
            mint::TokenConsumer::Rules => Self::Rules,
            mint::TokenConsumer::AuthEmulator => Self::AuthEmulator,
            mint::TokenConsumer::Verify => Self::Verify,
            mint::TokenConsumer::VerifyRevoked => Self::VerifyRevoked,
            mint::TokenConsumer::SignIn => Self::SignIn,
        }
    }
}

/// `GET /claims`: the custom claim keys users carry.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "auth/")]
pub struct AuthClaimKeys {
    /// At most 200, most users first.
    pub keys: Vec<AuthClaimKey>,
    #[ts(type = "number")]
    pub users_with_claims: u64,
}

/// One custom claim key.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "auth/")]
pub struct AuthClaimKey {
    pub key: String,
    #[ts(type = "number")]
    pub users: u64,
    /// JSON types seen for this key (`string`, `boolean`, `number`,
    /// `array`, `object`, `null`).
    pub kinds: Vec<String>,
    /// Up to three distinct values.
    #[ts(type = "unknown[]")]
    pub samples: Vec<serde_json::Value>,
}

impl From<engine::ClaimKeys> for AuthClaimKeys {
    fn from(keys: engine::ClaimKeys) -> Self {
        Self {
            keys: keys
                .keys
                .into_iter()
                .map(|key| AuthClaimKey {
                    key: key.key,
                    users: key.users,
                    kinds: key.kinds,
                    samples: key.samples,
                })
                .collect(),
            users_with_claims: keys.users_with_claims,
        }
    }
}

// ---------------------------------------------------------------- bulk

/// `POST /users:disable|enable|verify|revoke`.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "auth/")]
pub struct AuthBulkRequest {
    /// `keys`: `auth.user` keys (`<tenant>|<uid>`, tenant empty for project
    /// users), at most 10,000. `query`: every user `q` matches when the job
    /// runs, in `scope` — the users list's own params as JSON
    /// (`{"tenant":"acme"}`; `{}` for project users; `q` empty = every user
    /// of that scope).
    pub target: BulkTarget,
    /// Count what would change; change nothing (answers `AuthBulkPreview`).
    #[serde(default)]
    pub dry_run: bool,
}

/// `POST /users:setClaims`. Merge: keys replace, a `null` value removes the
/// key. Replace: the claims become exactly these.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "auth/")]
pub struct AuthSetClaimsRequest {
    pub target: BulkTarget,
    #[ts(type = "Record<string, unknown>")]
    pub claims: serde_json::Map<String, serde_json::Value>,
    pub mode: AuthClaimsMode,
    #[serde(default)]
    pub dry_run: bool,
}

/// `POST /users:removeClaims`.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "auth/")]
pub struct AuthRemoveClaimsRequest {
    pub target: BulkTarget,
    pub keys: Vec<String>,
    #[serde(default)]
    pub dry_run: bool,
}

const fn yes() -> bool {
    true
}

/// `POST /users:delete`. With `triggers` (the default), Functions get
/// `user.delete` for each user, as `deleteUsers` does — at most 10,000
/// users per action. Without, nothing is queued, as the emulator's
/// delete-all.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "auth/")]
pub struct AuthDeleteUsersRequest {
    pub target: BulkTarget,
    #[serde(default = "yes")]
    pub triggers: bool,
    #[serde(default)]
    pub dry_run: bool,
}

/// What a bulk job would do (the dry run's answer).
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "auth/")]
pub struct AuthBulkPreview {
    #[ts(type = "number")]
    pub matched: u64,
    #[ts(type = "number")]
    pub changed: u64,
    /// Matched but already as asked (disabling a disabled user).
    #[ts(type = "number")]
    pub unchanged: u64,
    /// `user.delete` events a delete would queue (0 without triggers).
    #[ts(type = "number")]
    pub triggers: u64,
    #[ts(type = "number")]
    pub took_micros: u64,
}

impl From<bulk::BulkPreview> for AuthBulkPreview {
    fn from(preview: bulk::BulkPreview) -> Self {
        Self {
            matched: preview.matched,
            changed: preview.changed,
            unchanged: preview.unchanged,
            triggers: preview.triggers,
            took_micros: micros(preview.took),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "auth/")]
pub enum AuthClaimsMode {
    Merge,
    Replace,
}

impl From<AuthClaimsMode> for bulk::ClaimsMode {
    fn from(mode: AuthClaimsMode) -> Self {
        match mode {
            AuthClaimsMode::Merge => Self::Merge,
            AuthClaimsMode::Replace => Self::Replace,
        }
    }
}

// ---------------------------------------------------------------- import

/// What importing an uploaded file would do.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "auth/")]
pub struct AuthImportPreview {
    /// Pass to `POST /users:import`; valid for 10 minutes.
    pub import_id: String,
    /// `emulator`, `cli` or `array`.
    pub recognised: String,
    #[ts(type = "number")]
    pub total: u64,
    pub by_provider: Vec<AuthProviderCount>,
    #[ts(type = "number")]
    pub with_password: u64,
    /// Hashes the emulator cannot check (production exports).
    #[ts(type = "number")]
    pub opaque_hashes: u64,
    #[ts(type = "number")]
    pub with_claims: u64,
    /// Users whose uid already exists here (first 200) and how many in all.
    pub existing: Vec<String>,
    #[ts(type = "number")]
    pub existing_count: u64,
    /// The first 200 problems.
    pub problems: Vec<AuthImportFailure>,
    #[ts(type = "number")]
    pub problem_count: u64,
    #[ts(type = "number")]
    pub took_micros: u64,
}

impl AuthImportPreview {
    pub(crate) fn of(import_id: String, preview: import::ImportPreview) -> Self {
        Self {
            import_id,
            recognised: preview.format.as_str().to_owned(),
            total: preview.total,
            by_provider: preview
                .by_provider
                .into_iter()
                .map(AuthProviderCount::from)
                .collect(),
            with_password: preview.with_password,
            opaque_hashes: preview.opaque_hashes,
            with_claims: preview.with_claims,
            existing: preview.existing,
            existing_count: preview.existing_count,
            problems: preview
                .problems
                .into_iter()
                .map(|problem| AuthImportFailure {
                    index: problem.index,
                    uid: problem.uid,
                    message: problem.message,
                })
                .collect(),
            problem_count: preview.problem_count,
            took_micros: micros(preview.took),
        }
    }
}

/// `POST /users:import`: commit a kept upload as a job.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "auth/")]
pub struct AuthImportRequest {
    pub import_id: String,
    pub mode: AuthImportMode,
    /// Every imported user gets this password (stored the emulator's way).
    #[serde(default)]
    #[ts(optional)]
    pub replace_password: Option<String>,
    /// Answer the preview with these options applied; import nothing.
    #[serde(default)]
    pub dry_run: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "auth/")]
pub enum AuthImportMode {
    Skip,
    Overwrite,
}

impl From<AuthImportMode> for import::ImportMode {
    fn from(mode: AuthImportMode) -> Self {
        match mode {
            AuthImportMode::Skip => Self::Skip,
            AuthImportMode::Overwrite => Self::Overwrite,
        }
    }
}

/// One user an import refuses.
#[derive(Clone, Debug, Serialize, TS)]
#[ts(export_to = "auth/")]
pub struct AuthImportFailure {
    /// Its place in the file, from 0.
    #[ts(type = "number")]
    pub index: u64,
    pub uid: Option<String>,
    pub message: String,
}

// ---------------------------------------------------------------- messages

/// A code or a link the emulator would have sent.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "auth/")]
pub struct AuthMessage {
    #[ts(type = "number")]
    pub id: u64,
    /// RFC 3339; absent for a code found in saved state.
    pub at: Option<String>,
    pub tenant: Option<String>,
    pub kind: AuthMessageKind,
    /// `email` or `sms`.
    pub channel: String,
    pub to: String,
    pub new_email: Option<String>,
    pub uid: Option<String>,
    /// The `oobCode`, or the six-digit SMS code.
    pub code: String,
    /// The link exactly as the emulator generated it.
    pub link: Option<String>,
    pub continue_url: Option<String>,
    pub delivery: AuthMessageDelivery,
    /// Set when a console call created it.
    pub origin: Option<AuthConsoleOrigin>,
    pub used: bool,
    pub used_at: Option<String>,
    /// The call that created it.
    #[ts(type = "number | null")]
    pub activity: Option<u64>,
    /// The call that used it.
    #[ts(type = "number | null")]
    pub used_by: Option<u64>,
    /// The line the emulator printed, verbatim; empty when returned.
    pub text: String,
}

/// `GET /messages`: the foundation's `Page<AuthMessage>`, flattened.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "auth/")]
pub struct AuthMessagePage {
    #[serde(flatten)]
    pub page: Page<AuthMessage>,
    /// First page only.
    pub facets: Option<AuthMessageFacets>,
    /// The inbox feed's position when the page was read: subscribe to
    /// `auth.inbox` after it to receive only what is newer.
    pub live_after: String,
}

/// Counts over the kept messages for the filter's base terms.
#[derive(Clone, Debug, Default, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "auth/")]
pub struct AuthMessageFacets {
    #[ts(type = "number")]
    pub unused: u64,
    #[ts(type = "number")]
    pub returned: u64,
    #[ts(type = "number")]
    pub restored: u64,
    pub kinds: Vec<AuthMessageKindCount>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "auth/")]
pub enum AuthMessageKind {
    VerifyEmail,
    PasswordReset,
    EmailSignIn,
    VerifyAndChangeEmail,
    RecoverEmail,
    SmsSignIn,
    SmsMfaEnrollment,
    SmsMfaSignIn,
}

impl From<observe::MessageKind> for AuthMessageKind {
    fn from(kind: observe::MessageKind) -> Self {
        match kind {
            observe::MessageKind::VerifyEmail => Self::VerifyEmail,
            observe::MessageKind::PasswordReset => Self::PasswordReset,
            observe::MessageKind::EmailSignIn => Self::EmailSignIn,
            observe::MessageKind::VerifyAndChangeEmail => Self::VerifyAndChangeEmail,
            observe::MessageKind::RecoverEmail => Self::RecoverEmail,
            observe::MessageKind::SmsSignIn => Self::SmsSignIn,
            observe::MessageKind::SmsMfaEnrollment => Self::SmsMfaEnrollment,
            observe::MessageKind::SmsMfaSignIn => Self::SmsMfaSignIn,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "auth/")]
pub enum AuthMessageDelivery {
    /// Logged, as an email or SMS would have been sent.
    Sent,
    /// Handed to the caller (an Admin SDK `generate…Link` call); nothing was
    /// logged.
    Returned,
    /// Found in saved state when the engine started.
    Restored,
}

impl From<observe::Delivery> for AuthMessageDelivery {
    fn from(delivery: observe::Delivery) -> Self {
        match delivery {
            observe::Delivery::Sent => Self::Sent,
            observe::Delivery::Returned => Self::Returned,
            observe::Delivery::Restored => Self::Restored,
        }
    }
}

/// Messages of one kind.
#[derive(Clone, Debug, Serialize, TS)]
#[ts(export_to = "auth/")]
pub struct AuthMessageKindCount {
    pub kind: AuthMessageKind,
    #[ts(type = "number")]
    pub messages: u64,
}

// ---------------------------------------------------------------- activity

/// `GET /activity`: the foundation's `Page<AuthActivitySummary>`, flattened.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "auth/")]
pub struct AuthActivityPage {
    /// `total` (first page only) counts the matching calls kept.
    #[serde(flatten)]
    pub page: Page<AuthActivitySummary>,
    /// First page only.
    pub facets: Option<AuthActivityFacets>,
    /// Whether request and response bodies are kept (`--no-diagnostics`
    /// off).
    pub bodies_retained: bool,
    /// The activity feed's position when the page was read: subscribe to
    /// `auth.activity` after it to receive only what is newer.
    pub live_after: String,
}

/// Counts over the kept calls for the filter's base terms (words, `uid`,
/// `provider`, `op`, `has`, `at`, `took`, `status`), ignoring its facet
/// terms (`is`, `kind`, `caller`).
#[derive(Clone, Debug, Default, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "auth/")]
pub struct AuthActivityFacets {
    #[ts(type = "number")]
    pub errors: u64,
    #[ts(type = "number")]
    pub new_users: u64,
    /// Calls per kind, every kind listed.
    pub kinds: Vec<AuthCallKindCount>,
    /// Calls per caller.
    pub callers: Vec<AuthCallerCount>,
}

/// What a call is, by its operation (the `kind:` filter values).
#[derive(Clone, Copy, Debug, Serialize, TS, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
#[ts(export_to = "auth/")]
pub enum AuthCallKind {
    SignIn,
    SignUp,
    Refresh,
    Code,
    Account,
    Config,
    Lookup,
    Other,
}

impl From<observe::CallKind> for AuthCallKind {
    fn from(kind: observe::CallKind) -> Self {
        match kind {
            observe::CallKind::SignIn => Self::SignIn,
            observe::CallKind::SignUp => Self::SignUp,
            observe::CallKind::Refresh => Self::Refresh,
            observe::CallKind::Code => Self::Code,
            observe::CallKind::Account => Self::Account,
            observe::CallKind::Config => Self::Config,
            observe::CallKind::Lookup => Self::Lookup,
            observe::CallKind::Other => Self::Other,
        }
    }
}

/// Calls of one kind.
#[derive(Clone, Debug, Serialize, TS)]
#[ts(export_to = "auth/")]
pub struct AuthCallKindCount {
    pub kind: AuthCallKind,
    #[ts(type = "number")]
    pub calls: u64,
}

/// Calls of one caller.
#[derive(Clone, Debug, Serialize, TS)]
#[ts(export_to = "auth/")]
pub struct AuthCallerCount {
    pub caller: AuthCaller,
    #[ts(type = "number")]
    pub calls: u64,
}

/// One call to the Auth emulator, as a row of the Activity list.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "auth/")]
pub struct AuthActivitySummary {
    /// The call id: what `?entry=`, `x-firenook-activity`, messages, the
    /// `auth.call` key and the Functions page's `authCall` name the call by.
    #[ts(type = "number")]
    pub id: u64,
    /// RFC 3339 with milliseconds.
    pub at: String,
    #[ts(type = "number")]
    pub duration_micros: u64,
    pub project: String,
    pub tenant: Option<String>,
    pub caller: AuthCaller,
    /// Set for console calls: `write`, `try` or `replay`.
    pub origin: Option<AuthConsoleOrigin>,
    pub credential: AuthCredential,
    pub client: Option<String>,
    pub method: String,
    pub path: String,
    pub operation: String,
    /// The operation's kind.
    pub kind: AuthCallKind,
    pub identifier: Option<String>,
    pub provider: Option<String>,
    pub uid: Option<String>,
    pub new_user: Option<bool>,
    pub status: u16,
    pub error: Option<AuthCallError>,
    pub steps: Vec<AuthStep>,
    /// Steps beyond the 50 kept.
    pub more_steps: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "auth/")]
pub enum AuthConsoleOrigin {
    Write,
    Try,
    Replay,
}

impl From<observe::ConsoleOrigin> for AuthConsoleOrigin {
    fn from(origin: observe::ConsoleOrigin) -> Self {
        match origin {
            observe::ConsoleOrigin::Write => Self::Write,
            observe::ConsoleOrigin::Try => Self::Try,
            observe::ConsoleOrigin::Replay => Self::Replay,
        }
    }
}

/// One thing a call caused.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export_to = "auth/")]
pub enum AuthStep {
    /// A blocking function ran (or refused, or failed).
    #[serde(rename_all = "camelCase")]
    Blocking {
        event: String,
        function: Option<String>,
        uri: String,
        #[ts(type = "number")]
        duration_micros: u64,
        /// The Functions invocation id (`functions.invocation` key).
        invocation: Option<String>,
        changed: Vec<String>,
        custom_claims: Vec<String>,
        session_claims: Vec<String>,
        failure: Option<AuthBlockingFailure>,
    },
    /// A lifecycle event for Functions. `outcome` is `queued`,
    /// `deliveryOff` or `failed: <reason>`.
    #[serde(rename_all = "camelCase")]
    Trigger {
        event: String,
        uid: String,
        outcome: String,
    },
    /// A code or link was created.
    #[serde(rename_all = "camelCase")]
    Message {
        #[ts(type = "number")]
        id: u64,
        message: AuthMessageKind,
        to: String,
    },
    /// A code was used.
    #[serde(rename_all = "camelCase")]
    MessageUsed {
        #[ts(type = "number | null")]
        id: Option<u64>,
    },
    #[serde(rename_all = "camelCase")]
    User {
        tenant: Option<String>,
        uid: String,
        change: AuthUserChangeKind,
        fields: Vec<String>,
    },
    #[serde(rename_all = "camelCase")]
    UsersCleared { tenant: Option<String> },
    #[serde(rename_all = "camelCase")]
    Config {
        tenant: Option<String>,
        what: AuthConfigChange,
    },
}

/// Why a blocking function refused or failed.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "auth/")]
pub struct AuthBlockingFailure {
    /// The function's own message.
    pub message: String,
    /// The HTTP status the function answered, when it answered.
    pub status: Option<u16>,
    /// The engine's line exactly as the caller saw it.
    pub raw: String,
}

/// One call in full, for the detail.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "auth/")]
pub struct AuthActivityDetail {
    pub summary: AuthActivitySummary,
    /// The request body as received, when kept.
    pub request: Option<String>,
    /// The response body as sent, when kept.
    pub response: Option<String>,
    #[ts(type = "number")]
    pub request_bytes: u64,
    #[ts(type = "number")]
    pub response_bytes: u64,
    pub query: Vec<AuthHeader>,
    pub headers: Vec<AuthHeader>,
    /// The bodies were kept but have since been dropped for newer calls.
    pub bodies_dropped: bool,
    /// The request can be sent again from the console.
    pub replayable: bool,
    /// What a replay repeats, when the operation is not idempotent.
    pub replay_effect: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "auth/")]
pub enum AuthCaller {
    Client,
    Admin,
    Console,
    ActionLink,
    AccountPicker,
    EmulatorApi,
}

impl From<observe::Caller> for AuthCaller {
    fn from(caller: observe::Caller) -> Self {
        match caller {
            observe::Caller::Client => Self::Client,
            observe::Caller::Admin => Self::Admin,
            observe::Caller::Console => Self::Console,
            observe::Caller::ActionLink => Self::ActionLink,
            observe::Caller::AccountPicker => Self::AccountPicker,
            observe::Caller::EmulatorApi => Self::EmulatorApi,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "auth/")]
pub enum AuthCredential {
    ApiKey,
    Owner,
    ServiceAccount,
    None,
}

impl From<observe::Credential> for AuthCredential {
    fn from(credential: observe::Credential) -> Self {
        match credential {
            observe::Credential::ApiKey => Self::ApiKey,
            observe::Credential::Owner => Self::Owner,
            observe::Credential::ServiceAccount => Self::ServiceAccount,
            observe::Credential::None => Self::None,
        }
    }
}

/// What a call failed with: `code` is the part of the message before
/// " : " (`WEAK_PASSWORD`), or the status (`INVALID_ARGUMENT`) when the
/// message is prose.
#[derive(Clone, Debug, Serialize, TS)]
#[ts(export_to = "auth/")]
pub struct AuthCallError {
    pub code: String,
    pub message: String,
}

/// A header or query parameter of a recorded call.
#[derive(Clone, Debug, Serialize, TS)]
#[ts(export_to = "auth/")]
pub struct AuthHeader {
    pub name: String,
    pub value: String,
}

// ---------------------------------------------------------------- tenants

/// `POST /tenants`: a tenant with the id you choose.
#[allow(clippy::struct_excessive_bools)]
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "auth/")]
pub struct AuthTenantCreate {
    /// The id to create the tenant under; absent: a random 28-character id,
    /// as the official `tenants.create`. A letter first, then letters,
    /// digits or hyphens; 4 to 20 characters.
    #[serde(default)]
    #[ts(optional)]
    pub tenant_id: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub allow_password_signup: bool,
    #[serde(default)]
    pub enable_email_link_signin: bool,
    #[serde(default)]
    pub enable_anonymous_user: bool,
    #[serde(default)]
    pub disable_auth: bool,
    /// `DISABLED`, `ENABLED` or `MANDATORY`.
    #[serde(default)]
    #[ts(optional)]
    pub mfa_state: Option<String>,
    #[serde(default)]
    pub mfa_providers: Vec<String>,
}

impl From<AuthTenantCreate> for tenants::TenantCreate {
    fn from(create: AuthTenantCreate) -> Self {
        Self {
            tenant_id: create.tenant_id,
            display_name: create.display_name,
            allow_password_signup: create.allow_password_signup,
            enable_email_link_signin: create.enable_email_link_signin,
            enable_anonymous_user: create.enable_anonymous_user,
            disable_auth: create.disable_auth,
            mfa_state: create.mfa_state,
            mfa_providers: create.mfa_providers,
        }
    }
}

/// `GET /tenants`: the foundation's `Page<AuthTenant>`, flattened.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "auth/")]
pub struct AuthTenantPage {
    #[serde(flatten)]
    pub page: Page<AuthTenant>,
    /// The project's own users. First page only.
    #[ts(type = "number | null")]
    pub project_users: Option<u64>,
}

/// One tenant.
#[allow(clippy::struct_excessive_bools)]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "auth/")]
pub struct AuthTenant {
    pub tenant_id: String,
    pub display_name: Option<String>,
    #[ts(type = "number")]
    pub users: u64,
    pub allow_password_signup: bool,
    pub enable_email_link_signin: bool,
    pub enable_anonymous_user: bool,
    pub disable_auth: bool,
    /// `DISABLED`, `ENABLED` or `MANDATORY`.
    pub mfa_state: String,
    pub mfa_providers: Vec<String>,
}

impl From<tenants::TenantInfo> for AuthTenant {
    fn from(tenant: tenants::TenantInfo) -> Self {
        Self {
            tenant_id: tenant.tenant_id,
            display_name: tenant.display_name,
            users: tenant.users,
            allow_password_signup: tenant.allow_password_signup,
            enable_email_link_signin: tenant.enable_email_link_signin,
            enable_anonymous_user: tenant.enable_anonymous_user,
            disable_auth: tenant.disable_auth,
            mfa_state: tenant.mfa_state,
            mfa_providers: tenant.mfa_providers,
        }
    }
}

/// `GET /hooks`: the blocking functions a sign-up and a sign-in would call.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "auth/")]
pub struct AuthHooks {
    pub before_create: Option<AuthBlockingHook>,
    pub before_sign_in: Option<AuthBlockingHook>,
    pub forward_id_token: bool,
    pub forward_access_token: bool,
    pub forward_refresh_token: bool,
}

/// One blocking function.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "auth/")]
pub struct AuthBlockingHook {
    pub uri: String,
    /// The function name, the last segment of the uri.
    pub function: Option<String>,
    /// `functions` (discovered) or `config` (set with updateConfig).
    pub source: String,
}

impl From<firenook_auth_front::BlockingTargets> for AuthHooks {
    fn from(targets: firenook_auth_front::BlockingTargets) -> Self {
        let hook = |target: Option<firenook_auth_front::HookTarget>| {
            target.map(|target| AuthBlockingHook {
                function: observe::function_of(&target.uri),
                uri: target.uri,
                source: match target.source {
                    firenook_auth_front::HookSource::Config => "config",
                    firenook_auth_front::HookSource::Functions => "functions",
                }
                .to_owned(),
            })
        };
        Self {
            before_create: hook(targets.before_create),
            before_sign_in: hook(targets.before_sign_in),
            forward_id_token: targets.forward_id_token,
            forward_access_token: targets.forward_access_token,
            forward_refresh_token: targets.forward_refresh_token,
        }
    }
}

/// `GET /summary`: the Auth pages' facts.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "auth/")]
pub struct AuthSummary {
    pub project_id: String,
    #[ts(type = "number")]
    pub users: u64,
    #[ts(type = "number")]
    pub tenants: u64,
    #[ts(type = "number")]
    pub tenant_users: u64,
    pub bodies_retained: bool,
    pub activity_capacity: u32,
    pub message_capacity: u32,
}

// ---------------------------------------------------------------- live

/// Accounts of one tenant (or the project) that changed in the last window.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "auth/")]
pub struct AuthUsersChanged {
    pub tenant: Option<String>,
    pub changes: Vec<AuthUserChangeEntry>,
}

/// One account and what happened to it. `fields` are the record fields an
/// update set, merged over the window; empty for created and deleted. An
/// update that set only `lastRefreshAt` (a token refresh) is never sent.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "auth/")]
pub struct AuthUserChangeEntry {
    pub uid: String,
    pub change: AuthUserChangeKind,
    pub fields: Vec<String>,
}

#[derive(Clone, Copy, Debug, Serialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "auth/")]
pub enum AuthUserChangeKind {
    Created,
    Updated,
    Deleted,
}

impl From<observe::UserChange> for AuthUserChangeKind {
    fn from(change: observe::UserChange) -> Self {
        match change {
            observe::UserChange::Created => Self::Created,
            observe::UserChange::Updated => Self::Updated,
            observe::UserChange::Deleted => Self::Deleted,
        }
    }
}

/// Every account of a tenant (or the project) was deleted.
#[derive(Clone, Debug, Serialize, TS)]
#[ts(export_to = "auth/")]
pub struct AuthUsersCleared {
    pub tenant: Option<String>,
}

/// A batch of the Activity feed.
#[allow(
    dead_code,
    reason = "the batch `replay_topic` sends, declared for the browser"
)]
#[derive(Clone, Debug, Serialize, TS)]
#[ts(export_to = "auth/")]
pub struct AuthActivityBatch {
    pub items: Vec<AuthActivityItem>,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export_to = "auth/")]
pub enum AuthActivityItem {
    /// One finished call.
    #[serde(rename_all = "camelCase")]
    Call { summary: Box<AuthActivitySummary> },
    /// The list was cleared (`DELETE /auth/activity`).
    Cleared,
}

/// A batch of the Inbox feed.
#[allow(
    dead_code,
    reason = "the batch `replay_topic` sends, declared for the browser"
)]
#[derive(Clone, Debug, Serialize, TS)]
#[ts(export_to = "auth/")]
pub struct AuthInboxBatch {
    pub items: Vec<AuthInboxItem>,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export_to = "auth/")]
pub enum AuthInboxItem {
    /// A code or link was created.
    #[serde(rename_all = "camelCase")]
    Issued { message: Box<AuthMessage> },
    /// A code was consumed by the call `usedBy`.
    #[serde(rename_all = "camelCase")]
    Used {
        #[ts(type = "number")]
        id: u64,
        used_at: String,
        #[ts(type = "number | null")]
        used_by: Option<u64>,
    },
    /// The list was cleared (`DELETE /auth/messages`).
    Cleared,
}

/// Configuration changed: the project's, or a tenant's.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "auth/")]
pub struct AuthConfigChanged {
    pub tenant: Option<String>,
    pub what: AuthConfigChange,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "auth/")]
pub enum AuthConfigChange {
    Project,
    TenantCreated,
    TenantUpdated,
    TenantDeleted,
}

impl From<observe::ConfigChange> for AuthConfigChange {
    fn from(change: observe::ConfigChange) -> Self {
        match change {
            observe::ConfigChange::Project => Self::Project,
            observe::ConfigChange::TenantCreated => Self::TenantCreated,
            observe::ConfigChange::TenantUpdated => Self::TenantUpdated,
            observe::ConfigChange::TenantDeleted => Self::TenantDeleted,
        }
    }
}

/// `auth.users` parameters: absent `tenant` is the project's users.
#[derive(Clone, Debug, Default, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "auth/")]
pub struct AuthUsersParams {
    #[serde(default)]
    #[ts(optional)]
    pub project: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub tenant: Option<String>,
}

/// `auth.activity` parameters: absent `tenant` is every tenant, `(none)`
/// the project's calls only.
#[derive(Clone, Debug, Default, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "auth/")]
pub struct AuthActivityParams {
    #[serde(default)]
    #[ts(optional)]
    pub project: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub tenant: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub q: Option<String>,
    /// Include the console's own background writes.
    #[serde(default)]
    pub console: bool,
}

/// `auth.inbox` parameters, as Activity's.
#[derive(Clone, Debug, Default, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "auth/")]
pub struct AuthInboxParams {
    #[serde(default)]
    #[ts(optional)]
    pub project: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub tenant: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub q: Option<String>,
}

/// `auth.config` and `auth.hooks` parameters.
#[derive(Clone, Debug, Default, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "auth/")]
pub struct AuthConfigParams {
    #[serde(default)]
    #[ts(optional)]
    pub project: Option<String>,
}

// ---------------------------------------------------------------- conversions from the observer

/// RFC 3339 with milliseconds.
pub(crate) fn at_millis(millis: i64) -> String {
    iso_from_millis(millis)
}

/// The step a call record carries, as the list shows it. `message_of`
/// resolves a used code's key to its message id.
pub(crate) fn step(step: &observe::Step, message_of: &dyn Fn(&str) -> Option<u64>) -> AuthStep {
    match step {
        observe::Step::Blocking {
            event,
            uri,
            function,
            duration,
            invocation,
            changed,
            custom_claims,
            session_claims,
            failure,
        } => AuthStep::Blocking {
            event: (*event).to_owned(),
            function: function.clone(),
            uri: uri.clone(),
            duration_micros: micros(*duration),
            invocation: invocation.clone(),
            changed: changed.clone(),
            custom_claims: custom_claims.clone(),
            session_claims: session_claims.clone(),
            failure: failure.as_ref().map(|failure| AuthBlockingFailure {
                message: failure.message.clone(),
                status: failure.status,
                raw: failure.raw.clone(),
            }),
        },
        observe::Step::Trigger {
            event,
            uid,
            outcome,
        } => AuthStep::Trigger {
            event: (*event).to_owned(),
            uid: uid.clone(),
            outcome: outcome.describe(),
        },
        observe::Step::MessageSent(message) => AuthStep::Message {
            id: message.id,
            message: message.kind.into(),
            to: message.to.clone(),
        },
        observe::Step::MessageUsed { key } => AuthStep::MessageUsed {
            id: message_of(key),
        },
        observe::Step::User {
            tenant,
            uid,
            change,
            fields,
        } => AuthStep::User {
            tenant: tenant.clone(),
            uid: uid.clone(),
            change: (*change).into(),
            fields: fields.clone(),
        },
        observe::Step::UsersCleared { tenant } => AuthStep::UsersCleared {
            tenant: tenant.clone(),
        },
        observe::Step::Config { tenant, what } => AuthStep::Config {
            tenant: tenant.clone(),
            what: (*what).into(),
        },
    }
}

/// A message as the inbox shows it.
pub(crate) fn message(
    record: &observe::MessageRecord,
    activity: Option<u64>,
    used: Option<(i64, Option<u64>)>,
) -> AuthMessage {
    AuthMessage {
        id: record.id,
        at: record.at_millis.map(at_millis),
        tenant: record.tenant.clone(),
        kind: record.kind.into(),
        channel: if record.kind.is_sms() { "sms" } else { "email" }.to_owned(),
        to: record.to.clone(),
        new_email: record.new_email.clone(),
        uid: record.uid.clone(),
        code: record.code.clone(),
        link: record.link.clone(),
        continue_url: record.continue_url.clone(),
        delivery: record.delivery.into(),
        origin: record.origin.map(AuthConsoleOrigin::from),
        used: used.is_some(),
        used_at: used.map(|(at, _)| at_millis(at)),
        activity,
        used_by: used.and_then(|(_, by)| by),
        text: record.text.clone(),
    }
}

/// The total of a first page: exact.
pub(crate) const fn exact(count_value: u64) -> Total {
    Total {
        count: count_value,
        exact: true,
    }
}

/// `usize` as a JSON count.
pub(crate) fn len(value: usize) -> u64 {
    count(value)
}

/// The export's file format.
pub(crate) fn export_format(format: Option<&str>) -> Option<export::ExportFormat> {
    match format.unwrap_or("json") {
        "json" => Some(export::ExportFormat::Json),
        "csv" => Some(export::ExportFormat::Csv),
        _ => None,
    }
}

/// Every wire type, into `generated/auth/`.
#[cfg(test)]
pub(crate) fn export_bindings(config: &ts_rs::Config) {
    AuthUsersPage::export_all(config).expect("TypeScript bindings written");
    AuthUserRow::export_all(config).expect("TypeScript bindings written");
    AuthUserFacets::export_all(config).expect("TypeScript bindings written");
    AuthProviderCount::export_all(config).expect("TypeScript bindings written");
    AuthUsersBatchGet::export_all(config).expect("TypeScript bindings written");
    AuthUserDetail::export_all(config).expect("TypeScript bindings written");
    AuthProviderInfo::export_all(config).expect("TypeScript bindings written");
    AuthMfaEnrollment::export_all(config).expect("TypeScript bindings written");
    AuthPasskey::export_all(config).expect("TypeScript bindings written");
    AuthMintFactor::export_all(config).expect("TypeScript bindings written");
    AuthMintedToken::export_all(config).expect("TypeScript bindings written");
    AuthMintBlocking::export_all(config).expect("TypeScript bindings written");
    AuthClaimNote::export_all(config).expect("TypeScript bindings written");
    AuthTokenInspectRequest::export_all(config).expect("TypeScript bindings written");
    AuthTokenInspection::export_all(config).expect("TypeScript bindings written");
    AuthTokenKind::export_all(config).expect("TypeScript bindings written");
    AuthTokenCheck::export_all(config).expect("TypeScript bindings written");
    AuthTokenConsumer::export_all(config).expect("TypeScript bindings written");
    AuthClaimKeys::export_all(config).expect("TypeScript bindings written");
    AuthClaimKey::export_all(config).expect("TypeScript bindings written");
    AuthBulkRequest::export_all(config).expect("TypeScript bindings written");
    AuthSetClaimsRequest::export_all(config).expect("TypeScript bindings written");
    AuthRemoveClaimsRequest::export_all(config).expect("TypeScript bindings written");
    AuthDeleteUsersRequest::export_all(config).expect("TypeScript bindings written");
    AuthBulkPreview::export_all(config).expect("TypeScript bindings written");
    AuthClaimsMode::export_all(config).expect("TypeScript bindings written");
    AuthImportPreview::export_all(config).expect("TypeScript bindings written");
    AuthImportRequest::export_all(config).expect("TypeScript bindings written");
    AuthImportMode::export_all(config).expect("TypeScript bindings written");
    AuthImportFailure::export_all(config).expect("TypeScript bindings written");
    AuthMessage::export_all(config).expect("TypeScript bindings written");
    AuthMessagePage::export_all(config).expect("TypeScript bindings written");
    AuthMessageFacets::export_all(config).expect("TypeScript bindings written");
    AuthMessageKind::export_all(config).expect("TypeScript bindings written");
    AuthMessageDelivery::export_all(config).expect("TypeScript bindings written");
    AuthMessageKindCount::export_all(config).expect("TypeScript bindings written");
    AuthActivityPage::export_all(config).expect("TypeScript bindings written");
    AuthActivityFacets::export_all(config).expect("TypeScript bindings written");
    AuthCallKind::export_all(config).expect("TypeScript bindings written");
    AuthCallKindCount::export_all(config).expect("TypeScript bindings written");
    AuthCallerCount::export_all(config).expect("TypeScript bindings written");
    AuthActivitySummary::export_all(config).expect("TypeScript bindings written");
    AuthConsoleOrigin::export_all(config).expect("TypeScript bindings written");
    AuthStep::export_all(config).expect("TypeScript bindings written");
    AuthBlockingFailure::export_all(config).expect("TypeScript bindings written");
    AuthActivityDetail::export_all(config).expect("TypeScript bindings written");
    AuthCaller::export_all(config).expect("TypeScript bindings written");
    AuthCredential::export_all(config).expect("TypeScript bindings written");
    AuthCallError::export_all(config).expect("TypeScript bindings written");
    AuthHeader::export_all(config).expect("TypeScript bindings written");
    AuthTenantCreate::export_all(config).expect("TypeScript bindings written");
    AuthTenantPage::export_all(config).expect("TypeScript bindings written");
    AuthTenant::export_all(config).expect("TypeScript bindings written");
    AuthHooks::export_all(config).expect("TypeScript bindings written");
    AuthBlockingHook::export_all(config).expect("TypeScript bindings written");
    AuthSummary::export_all(config).expect("TypeScript bindings written");
    AuthUsersChanged::export_all(config).expect("TypeScript bindings written");
    AuthUserChangeEntry::export_all(config).expect("TypeScript bindings written");
    AuthUserChangeKind::export_all(config).expect("TypeScript bindings written");
    AuthUsersCleared::export_all(config).expect("TypeScript bindings written");
    AuthActivityBatch::export_all(config).expect("TypeScript bindings written");
    AuthActivityItem::export_all(config).expect("TypeScript bindings written");
    AuthInboxBatch::export_all(config).expect("TypeScript bindings written");
    AuthInboxItem::export_all(config).expect("TypeScript bindings written");
    AuthConfigChanged::export_all(config).expect("TypeScript bindings written");
    AuthConfigChange::export_all(config).expect("TypeScript bindings written");
    AuthUsersParams::export_all(config).expect("TypeScript bindings written");
    AuthActivityParams::export_all(config).expect("TypeScript bindings written");
    AuthInboxParams::export_all(config).expect("TypeScript bindings written");
    AuthConfigParams::export_all(config).expect("TypeScript bindings written");
}
