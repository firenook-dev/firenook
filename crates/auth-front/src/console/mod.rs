//! What the console reads from the Auth emulator, and how, so that no console
//! request slows the app's own Auth calls.
//!
//! Every account has a small digest in a per-scope [`index`] (the project's
//! users and each tenant's) kept up to date beside the emulator's own maps.
//! A console read takes the data lock only to find the scope — with
//! `projects.get` and `tenants.get`, never the official API's lookups that
//! create a project or a tenant on first reference — and to take an O(1)
//! snapshot of that index; filtering, counting, ordering and paging then run
//! on the snapshot with the lock released.
//!
//! Results are plain Rust values; the console layer turns them into its wire
//! types, cursors and errors.

use std::fmt::{self, Display, Formatter};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Map as JsonMap, Value as JsonValue};

use crate::state::{AuthData, ProjectState, UserRecord};
use crate::util::{str_field, truthy, truthy_str};
use crate::{Runtime, lock};

pub mod filter;
pub(crate) mod index;

#[cfg(test)]
mod tests;

pub use filter::{Choice, ClaimMatch, IdMatch, TextTerm, TimeTerm, UserFilter, UserHas, UserState};
use index::IndexSnapshot;

/// Rows per page when the request names no size.
pub const DEFAULT_PAGE_SIZE: usize = 100;
/// The most rows one page holds.
pub const MAX_PAGE_SIZE: usize = 500;
/// The most users one batch read names.
pub const MAX_BATCH_USERS: usize = 500;
/// The most claim keys [`UsersView::claim_keys`] lists.
pub const MAX_CLAIM_KEYS: usize = 200;
/// Distinct values [`ClaimKey::samples`] keeps per key.
pub const CLAIM_SAMPLES: usize = 3;

// ---------------------------------------------------------------- errors

/// Why a console read was refused, in words for the developer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConsoleError {
    pub kind: ConsoleErrorKind,
    pub message: String,
    /// What the developer can do about it, when anything.
    pub fix: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConsoleErrorKind {
    /// A tenant or a user that does not exist.
    NotFound,
    /// A request the engine cannot answer as asked (a cursor of another sort).
    InvalidArgument,
}

impl ConsoleError {
    fn not_found(message: String, fix: &str) -> Self {
        Self {
            kind: ConsoleErrorKind::NotFound,
            message,
            fix: Some(fix.to_owned()),
        }
    }

    pub(crate) fn invalid(message: impl Into<String>) -> Self {
        Self {
            kind: ConsoleErrorKind::InvalidArgument,
            message: message.into(),
            fix: None,
        }
    }

    fn unknown_tenant(tenant: &str) -> Self {
        Self::not_found(
            format!("There is no tenant `{tenant}` in this project."),
            "Pick a tenant from the list, or create it in Settings.",
        )
    }

    fn unknown_user(uid: &str, tenant: Option<&str>) -> Self {
        let message = match tenant {
            None => format!("There is no user `{uid}` among the project's users."),
            Some(tenant) => format!("There is no user `{uid}` in tenant `{tenant}`."),
        };
        Self::not_found(message, "It may have been deleted; reload the list.")
    }

    pub(crate) fn foreign_cursor() -> Self {
        Self::invalid("This cursor belongs to another sort; start from the first page.")
    }

    pub(crate) fn unreadable_cursor() -> Self {
        Self::invalid("This cursor is not one this engine wrote.")
    }
}

impl Display for ConsoleError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for ConsoleError {}

// ---------------------------------------------------------------- order

/// The columns the users table sorts by; each has an ordered set in the
/// index, so a sorted page is a range read.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UserColumn {
    /// `createdAt`.
    Created,
    /// `lastLoginAt`.
    SignedIn,
    Email,
    /// The display name, case-insensitively.
    Name,
    /// The phone number's digits.
    Phone,
    Uid,
}

impl UserColumn {
    pub const ALL: [Self; 6] = [
        Self::Created,
        Self::SignedIn,
        Self::Email,
        Self::Name,
        Self::Phone,
        Self::Uid,
    ];

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Created => "created",
            Self::SignedIn => "signedIn",
            Self::Email => "email",
            Self::Name => "name",
            Self::Phone => "phone",
            Self::Uid => "uid",
        }
    }

    #[must_use]
    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|column| column.as_str() == value)
    }

    /// Whether the column's values are times (else text).
    pub(crate) const fn is_time(self) -> bool {
        matches!(self, Self::Created | Self::SignedIn)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SortDirection {
    Asc,
    Desc,
}

/// A column and a direction. Accounts without a value for the column sort
/// last in either direction; ties keep the index's order.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserSort {
    pub column: UserColumn,
    pub direction: SortDirection,
}

impl Default for UserSort {
    /// Newest first: `created:desc`.
    fn default() -> Self {
        Self {
            column: UserColumn::Created,
            direction: SortDirection::Desc,
        }
    }
}

impl UserSort {
    /// `<column>:asc|desc`, as the console's `sort` parameter spells it.
    #[must_use]
    pub fn parse(value: &str) -> Option<Self> {
        let (column, direction) = value.split_once(':')?;
        let direction = match direction {
            "asc" => SortDirection::Asc,
            "desc" => SortDirection::Desc,
            _ => return None,
        };
        Some(Self {
            column: UserColumn::parse(column)?,
            direction,
        })
    }
}

impl Display for UserSort {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        let direction = match self.direction {
            SortDirection::Asc => "asc",
            SortDirection::Desc => "desc",
        };
        write!(formatter, "{}:{direction}", self.column.as_str())
    }
}

/// Where a page ends (passed back to read the next one) or begins (passed
/// back to read the one above). The console makes it opaque; the engine
/// checks it on return.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UserCursor {
    /// The sort the page was read with; another sort refuses the cursor.
    pub sort: UserSort,
    /// The row's value for the sort column; absent when the account has none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<CursorKey>,
    /// The row's place in the index, which orders ties.
    pub slot: u32,
    /// The filtered first page's match list this cursor slices, while the
    /// engine keeps it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pin: Option<u64>,
    /// The position in that list: the next page starts here, the page above
    /// ends here.
    #[serde(default)]
    pub pos: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum CursorKey {
    /// Epoch milliseconds (`created`, `signedIn`).
    Time(i64),
    /// The email, the lower-cased display name, the phone's digits or the uid.
    Text(String),
}

// ---------------------------------------------------------------- reads

/// One page of the users table.
#[derive(Clone, Debug, PartialEq)]
pub struct UsersQuery {
    pub filter: UserFilter,
    pub sort: UserSort,
    /// Continue after this cursor (a page's `next`).
    pub cursor: Option<UserCursor>,
    /// Read the page above this cursor (a page's `prev`).
    pub before: Option<UserCursor>,
    /// Rows per page: 0 means [`DEFAULT_PAGE_SIZE`]; at most [`MAX_PAGE_SIZE`].
    pub limit: usize,
}

impl Default for UsersQuery {
    fn default() -> Self {
        Self {
            filter: UserFilter::default(),
            sort: UserSort::default(),
            cursor: None,
            before: None,
            limit: DEFAULT_PAGE_SIZE,
        }
    }
}

/// What one page holds.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UsersPage {
    pub rows: Vec<UserRow>,
    /// Pass as `cursor` for the next page; absent at the end.
    pub next: Option<UserCursor>,
    /// Pass as `before` for the page above; absent at the start.
    pub prev: Option<UserCursor>,
    /// Users the filter matches, exactly. First page only.
    pub total: Option<u64>,
    /// Counts for the filters panel. First page only.
    pub facets: Option<UserFacets>,
    /// Users in the scope, whatever the filter. First page only.
    pub scope_total: Option<u64>,
    /// Time spent after the snapshot was taken.
    pub took: Duration,
}

/// What one row of the users table shows — never the whole record.
// The flags are the row's own columns, one each, as the wire row has them.
#[allow(clippy::struct_excessive_bools)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UserRow {
    /// `localId`.
    pub uid: String,
    /// The tenant the user belongs to; `None` for the project's own users.
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
    /// Top-level custom claim keys, sorted.
    pub claim_keys: Vec<String>,
    /// Signed in with a custom token.
    pub custom_auth: bool,
    /// Epoch milliseconds.
    pub created_at: Option<i64>,
    /// `lastLoginAt`, epoch milliseconds.
    pub last_sign_in_at: Option<i64>,
}

/// Counts over the users the filter's base terms select, ignoring its facet
/// terms, so a count does not change when its own facet is pressed.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct UserFacets {
    pub disabled: u64,
    /// Users with an email that is not verified.
    pub unverified: u64,
    pub anonymous: u64,
    pub custom_token: u64,
    pub sample: u64,
    pub mfa: u64,
    pub claims: u64,
    pub never_signed_in: u64,
    /// Users per provider id, most first.
    pub providers: Vec<ProviderCount>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderCount {
    pub provider: String,
    pub users: u64,
}

/// Rows the live channel named, read again for the page's filter and order.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct UsersBatchQuery {
    /// At most [`MAX_BATCH_USERS`] uids.
    pub uids: Vec<String>,
    pub filter: UserFilter,
    pub sort: UserSort,
    /// Where each loaded page starts: the cursor it was read with, `None`
    /// for the page at the top. A row is placed in the last page whose start
    /// is above it.
    pub page_starts: Vec<Option<UserCursor>>,
}

/// One item per requested uid, in the request's order, and the figures the
/// page shows, recounted for the filter.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UsersBatch {
    pub items: Vec<BatchUser>,
    pub total: u64,
    pub facets: UserFacets,
    pub scope_total: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BatchUser {
    pub uid: String,
    /// Absent: deleted, or no longer matching the filter.
    pub row: Option<UserRow>,
    /// The index in `page_starts` of the loaded page the row sorts into;
    /// absent above the first loaded page.
    pub page: Option<u32>,
}

/// The custom claim keys users carry, for completion and the claims editor.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ClaimKeys {
    /// At most [`MAX_CLAIM_KEYS`], most users first.
    pub keys: Vec<ClaimKey>,
    pub users_with_claims: u64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ClaimKey {
    pub key: String,
    pub users: u64,
    /// JSON types seen for this key: `string`, `number`, `boolean`, `array`,
    /// `object`, `null`.
    pub kinds: Vec<String>,
    /// Up to [`CLAIM_SAMPLES`] distinct values.
    pub samples: Vec<JsonValue>,
}

/// One account in full, for the inspector.
#[derive(Clone, Debug, PartialEq)]
pub struct UserDetail {
    pub row: UserRow,
    /// The password, when it is stored in the emulator's recoverable form
    /// (`fakeHash:salt=…:password=<this>`).
    pub password: Option<String>,
    /// A password hash is set that the emulator cannot read back.
    pub password_opaque: bool,
    /// Epoch milliseconds.
    pub password_updated_at: Option<i64>,
    /// ID tokens issued before this instant are refused, epoch seconds.
    pub valid_since: Option<i64>,
    /// Epoch milliseconds.
    pub last_refresh_at: Option<i64>,
    pub initial_email: Option<String>,
    pub email_link_sign_in: bool,
    pub provider_info: Vec<ProviderEntry>,
    pub mfa: Vec<MfaEntry>,
    pub passkeys: Vec<PasskeyEntry>,
    /// Custom claims exactly as stored (`customAttributes`).
    pub claims_text: Option<String>,
    pub claims: Option<JsonMap<String, JsonValue>>,
    /// JavaScript length (UTF-16 code units) of `claims_text`: the measure
    /// the 1,000 limit applies to.
    pub claims_length: u32,
    /// The stored record, as exported to `accounts.json`.
    pub record: UserRecord,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ProviderEntry {
    pub provider_id: String,
    pub raw_id: Option<String>,
    pub email: Option<String>,
    pub display_name: Option<String>,
    pub photo_url: Option<String>,
    pub phone_number: Option<String>,
    pub federated_id: Option<String>,
    pub screen_name: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct MfaEntry {
    pub enrollment_id: String,
    pub display_name: Option<String>,
    /// The full number (`unobfuscatedPhoneInfo`), not the masked one tokens carry.
    pub phone_number: Option<String>,
    pub enrolled_at: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PasskeyEntry {
    pub credential_id: String,
    pub name: Option<String>,
}

/// A point-in-time view of one scope's users, taken under the data lock in
/// O(1). Reading it never takes the lock, so it can run on any thread for as
/// long as it needs.
#[derive(Clone)]
pub struct UsersView {
    tenant: Option<String>,
    index: IndexSnapshot,
}

impl fmt::Debug for UsersView {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("UsersView")
            .field("tenant", &self.tenant)
            .field("users", &self.index.len())
            .finish_non_exhaustive()
    }
}

impl UsersView {
    /// The tenant this view reads; `None` for the project's own users.
    #[must_use]
    pub fn tenant(&self) -> Option<&str> {
        self.tenant.as_deref()
    }

    /// Users in the scope.
    #[must_use]
    pub fn len(&self) -> u64 {
        self.index.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Moves whenever some user's row, order or counts changed.
    #[must_use]
    pub fn generation(&self) -> u64 {
        self.index.generation()
    }

    /// Moves only when some user's custom claims changed.
    #[must_use]
    pub fn claims_generation(&self) -> u64 {
        self.index.claims_generation()
    }

    /// One page of the users table.
    pub fn page(&self, query: &UsersQuery) -> Result<UsersPage, ConsoleError> {
        self.index.page(self.tenant.as_deref(), query)
    }

    /// The rows the live channel named, with the count and the facets.
    pub fn batch(&self, query: &UsersBatchQuery) -> Result<UsersBatch, ConsoleError> {
        self.index.batch(self.tenant.as_deref(), query)
    }

    /// The custom claim keys users carry: counts kept by the index, kinds and
    /// samples cached until some user's claims change.
    #[must_use]
    pub fn claim_keys(&self) -> ClaimKeys {
        (*self.index.claim_keys()).clone()
    }
}

impl Runtime {
    /// A point-in-time view of the users of `project` (or its `tenant`).
    /// Creates nothing: a project the emulator has never seen has no users,
    /// and an unknown tenant is `not-found`.
    pub fn users(&self, project: &str, tenant: Option<&str>) -> Result<UsersView, ConsoleError> {
        let tenant = tenant.filter(|tenant| !tenant.is_empty());
        let index = {
            let data = lock(&self.inner.data);
            match find_scope(&data, project, tenant)? {
                Some(scope) => scope.user_index().snapshot(),
                None => IndexSnapshot::empty(),
            }
        };
        Ok(UsersView {
            tenant: tenant.map(str::to_owned),
            index,
        })
    }

    /// One account in full. The record and the index snapshot are cloned
    /// under the lock; the answer is built after it is released.
    pub fn user(
        &self,
        project: &str,
        tenant: Option<&str>,
        uid: &str,
    ) -> Result<UserDetail, ConsoleError> {
        let tenant = tenant.filter(|tenant| !tenant.is_empty());
        let (record, index) = {
            let data = lock(&self.inner.data);
            let scope = find_scope(&data, project, tenant)?;
            let record = scope.and_then(|scope| scope.users.get(uid).cloned());
            let record = record.ok_or_else(|| ConsoleError::unknown_user(uid, tenant))?;
            let index =
                scope.map_or_else(IndexSnapshot::empty, |scope| scope.user_index().snapshot());
            (record, index)
        };
        let row = index
            .row_of(uid, tenant)
            .ok_or_else(|| ConsoleError::unknown_user(uid, tenant))?;
        Ok(detail(row, record))
    }
}

/// The accounts of `project` or its `tenant`, read without creating either.
fn find_scope<'a>(
    data: &'a AuthData,
    project: &str,
    tenant: Option<&str>,
) -> Result<Option<&'a ProjectState>, ConsoleError> {
    let agent = data.projects.get(project);
    match tenant {
        None => Ok(agent.map(|agent| &agent.project)),
        Some(tenant) => agent
            .and_then(|agent| agent.tenants.get(tenant))
            .map(|state| Some(&state.project))
            .ok_or_else(|| ConsoleError::unknown_tenant(tenant)),
    }
}

fn detail(row: UserRow, record: UserRecord) -> UserDetail {
    let hash = truthy_str(&record, "passwordHash");
    let password = hash.and_then(recoverable_password);
    let claims_text = truthy_str(&record, "customAttributes").map(str::to_owned);
    let claims = claims_text
        .as_deref()
        .and_then(|text| serde_json::from_str::<JsonValue>(text).ok())
        .and_then(|value| match value {
            JsonValue::Object(map) => Some(map),
            _ => None,
        });
    let claims_length = claims_text.as_deref().map_or(0, |text| {
        u32::try_from(crate::ops::custom_claims_length(text)).unwrap_or(u32::MAX)
    });
    UserDetail {
        row,
        password_opaque: hash.is_some() && password.is_none(),
        password,
        password_updated_at: millis_field(&record, "passwordUpdatedAt"),
        valid_since: millis_field(&record, "validSince"),
        last_refresh_at: str_field(&record, "lastRefreshAt").and_then(|text| {
            time::OffsetDateTime::parse(text, &time::format_description::well_known::Rfc3339)
                .ok()
                .and_then(|at| i64::try_from(at.unix_timestamp_nanos() / 1_000_000).ok())
        }),
        initial_email: truthy_str(&record, "initialEmail").map(str::to_owned),
        email_link_sign_in: truthy(record.get("emailLinkSignin")),
        provider_info: crate::state::provider_infos(&record)
            .iter()
            .map(|info| ProviderEntry {
                provider_id: str_field(info, "providerId").unwrap_or_default().to_owned(),
                raw_id: text_field(info, "rawId"),
                email: text_field(info, "email"),
                display_name: text_field(info, "displayName"),
                photo_url: text_field(info, "photoUrl"),
                phone_number: text_field(info, "phoneNumber"),
                federated_id: text_field(info, "federatedId"),
                screen_name: text_field(info, "screenName"),
            })
            .collect(),
        mfa: record
            .get("mfaInfo")
            .and_then(JsonValue::as_array)
            .into_iter()
            .flatten()
            .filter_map(JsonValue::as_object)
            .map(|enrollment| MfaEntry {
                enrollment_id: str_field(enrollment, "mfaEnrollmentId")
                    .unwrap_or_default()
                    .to_owned(),
                display_name: text_field(enrollment, "displayName"),
                phone_number: text_field(enrollment, "unobfuscatedPhoneInfo")
                    .or_else(|| text_field(enrollment, "phoneInfo")),
                enrolled_at: text_field(enrollment, "enrolledAt"),
            })
            .collect(),
        passkeys: crate::state::passkeys(&record)
            .iter()
            .map(|passkey| PasskeyEntry {
                credential_id: str_field(passkey, "credentialId")
                    .unwrap_or_default()
                    .to_owned(),
                name: text_field(passkey, "name"),
            })
            .collect(),
        claims_text,
        claims,
        claims_length,
        record,
    }
}

/// The password of the emulator's recoverable development hash
/// (`fakeHash:salt=<salt>:password=<password>`).
fn recoverable_password(hash: &str) -> Option<String> {
    let rest = hash.strip_prefix("fakeHash:salt=")?;
    let (_, password) = rest.split_once(":password=")?;
    Some(password.to_owned())
}

/// A non-empty string field, owned.
fn text_field(object: &JsonMap<String, JsonValue>, field: &str) -> Option<String> {
    truthy_str(object, field).map(str::to_owned)
}

/// A timestamp the emulator stores as a decimal string (or a number in
/// imported records).
pub(crate) fn millis_field(record: &JsonMap<String, JsonValue>, field: &str) -> Option<i64> {
    match record.get(field)? {
        JsonValue::String(text) => text.trim().parse().ok(),
        JsonValue::Number(number) => number.as_i64(),
        _ => None,
    }
}
