//! `GET /auth/identities?q=&limit=&tenant=&project=`: the users an identity
//! picker offers (Firestore's "view as", the rules playgrounds, callables,
//! Storage's "as"), in any tenant, answered from auth-front's user index
//! (`Runtime::search_users`: exact matches, then prefixes, then a bounded
//! substring scan). The emulator's own `accounts:query` cannot bound its
//! answer (it answers 501 for `limit`, as the official emulator does), so
//! the picker asks here.

use axum::Json;
use axum::extract::{Query, State};
use firenook_auth_front::console::search::{FoundUser, SearchScope};
use firenook_auth_front::console::{ConsoleError, ConsoleErrorKind};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::api_error::ApiError;
use crate::blocking::blocking;
use crate::paging::{Page, Total};

/// Accounts one search scans for substrings, across every tenant.
pub(crate) const SCAN_BUDGET: usize = 20_000;
/// Users one answer holds: default and maximum.
const DEFAULT_LIMIT: usize = 20;
const MAX_LIMIT: usize = 50;

/// One account as an identity picker shows it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct IdentityUser {
    pub uid: String,
    /// The tenant the account belongs to; `null` for the project's users.
    pub tenant: Option<String>,
    pub email: Option<String>,
    pub display_name: Option<String>,
    pub disabled: bool,
    pub email_verified: bool,
    /// Sign-in providers, in the account's order (`password`,
    /// `google.com`…).
    pub providers: Vec<String>,
    /// Parsed custom claims, when set.
    #[ts(type = "Record<string, unknown> | null")]
    pub claims: Option<serde_json::Value>,
}

impl From<FoundUser> for IdentityUser {
    fn from(found: FoundUser) -> Self {
        let row = found.row;
        Self {
            uid: row.uid,
            tenant: row.tenant,
            email: row.email,
            display_name: row.display_name,
            disabled: row.disabled,
            email_verified: row.email_verified,
            providers: row.providers,
            claims: found.claims.map(serde_json::Value::Object),
        }
    }
}

/// `?q=&limit=&tenant=&project=`. Without `tenant`, the project's users and
/// every tenant's; `tenant=` (empty), the project's only.
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct IdentityParams {
    #[serde(default)]
    q: String,
    #[serde(default)]
    limit: Option<usize>,
    #[serde(default)]
    tenant: Option<String>,
    #[serde(default)]
    project: Option<String>,
}

pub(crate) async fn search(
    State(state): State<super::routes::AuthRoutes>,
    Query(params): Query<IdentityParams>,
) -> Result<Json<Page<IdentityUser>>, ApiError> {
    let runtime = state.console.runtime.clone();
    let project = params
        .project
        .clone()
        .filter(|project| !project.is_empty())
        .unwrap_or_else(|| runtime.default_project().to_owned());
    let limit = params.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let text = params.q.trim().to_owned();
    let scope = match params.tenant {
        None => SearchScope::Every,
        Some(tenant) if tenant.is_empty() => SearchScope::Project,
        Some(tenant) => SearchScope::Tenant(tenant),
    };
    blocking("the identity search", move || {
        let found = runtime
            .search_users(&project, &scope, &text, limit, SCAN_BUDGET, &|| false)
            .map_err(|error| refused(error, &scope))?;
        let count = u64::try_from(found.users.len()).unwrap_or(u64::MAX);
        Ok(Page {
            items: found.users.into_iter().map(IdentityUser::from).collect(),
            next_cursor: None,
            prev_cursor: None,
            total: found.exhausted.then_some(Total {
                count,
                exact: false,
            }),
            scanned: found.exhausted.then_some(found.examined),
        })
    })
    .await
    .map(Json)
}

/// An unknown tenant, as the picker words it.
fn refused(error: ConsoleError, scope: &SearchScope) -> ApiError {
    match (error.kind, scope) {
        (ConsoleErrorKind::NotFound, SearchScope::Tenant(tenant)) => ApiError::not_found(format!(
            "This project has no tenant named {tenant}."
        ))
        .with_fix("Pick a tenant from the list, or leave tenant out to search every tenant."),
        _ => super::routes::console_error(error),
    }
}
