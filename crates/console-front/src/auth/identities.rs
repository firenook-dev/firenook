//! `GET /auth/identities?q=&limit=&tenant=&project=`: the users an identity
//! picker offers (Firestore's "view as", the rules playgrounds, callables,
//! Storage's "as"), in any tenant, answered from the maps the Auth emulator
//! keeps anyway. The emulator's own `accounts:query` cannot bound its
//! answer (it answers 501 for `limit`, as the official emulator does), so
//! the picker asks here.

use axum::Json;
use axum::extract::{Query, State};
use firenook_auth_front::Runtime;
use firenook_auth_front::state::{
    AuthData, IdentityBudget, ProjectState, UserRecord, provider_infos,
};
use firenook_auth_front::util::{str_field, truthy};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::api_error::ApiError;
use crate::blocking::blocking;
use crate::paging::{Page, Total};

/// Accounts one search scans for substrings, across every tenant.
const SCAN_BUDGET: usize = 20_000;
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

impl IdentityUser {
    fn of(user: &UserRecord, tenant: Option<&str>) -> Self {
        let text = |field: &str| {
            str_field(user, field)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
        };
        Self {
            uid: str_field(user, "localId").unwrap_or_default().to_owned(),
            tenant: tenant.map(str::to_owned),
            email: text("email"),
            display_name: text("displayName"),
            disabled: truthy(user.get("disabled")),
            email_verified: truthy(user.get("emailVerified")),
            providers: provider_infos(user)
                .iter()
                .filter_map(|info| str_field(info, "providerId").map(str::to_owned))
                .collect(),
            claims: str_field(user, "customAttributes")
                .and_then(|claims| serde_json::from_str::<serde_json::Value>(claims).ok())
                .filter(serde_json::Value::is_object),
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
    State(runtime): State<Runtime>,
    Query(params): Query<IdentityParams>,
) -> Result<Json<Page<IdentityUser>>, ApiError> {
    let project = params
        .project
        .clone()
        .filter(|project| !project.is_empty())
        .unwrap_or_else(|| runtime.default_project().to_owned());
    let limit = params.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let text = params.q.trim().to_owned();
    let tenant = params.tenant;
    blocking("the identity search", move || {
        runtime.read(|data| search_in(data, &project, tenant.as_deref(), &text, limit))
    })
    .await
    .map(Json)
}

/// The search over one read of the emulator's state: the project's users,
/// then each tenant's in id order, under one scan budget.
fn search_in(
    data: &AuthData,
    project: &str,
    tenant: Option<&str>,
    text: &str,
    limit: usize,
) -> Result<Page<IdentityUser>, ApiError> {
    let empty = Page {
        items: Vec::new(),
        next_cursor: None,
        prev_cursor: None,
        total: Some(Total {
            count: 0,
            exact: true,
        }),
        scanned: None,
    };
    let Some(agent) = data.projects.get(project) else {
        if let Some(tenant) = tenant.filter(|tenant| !tenant.is_empty()) {
            return Err(no_tenant(tenant));
        }
        return Ok(empty);
    };
    let scopes: Vec<(Option<&str>, &ProjectState)> = match tenant {
        None => std::iter::once((None, &agent.project))
            .chain(
                agent
                    .tenants
                    .iter()
                    .map(|(id, state)| (Some(id.as_str()), &state.project)),
            )
            .collect(),
        Some("") => vec![(None, &agent.project)],
        Some(tenant) => {
            let state = agent.tenants.get(tenant).ok_or_else(|| no_tenant(tenant))?;
            vec![(Some(tenant), &state.project)]
        }
    };
    let mut budget = IdentityBudget::new(SCAN_BUDGET);
    let mut items = Vec::new();
    for (tenant, state) in scopes {
        let wanted = limit - items.len();
        if wanted == 0 {
            break;
        }
        items.extend(
            state
                .search_identities(text, wanted, &mut budget)
                .into_iter()
                .map(|user| IdentityUser::of(user, tenant)),
        );
    }
    let count = u64::try_from(items.len()).unwrap_or(u64::MAX);
    Ok(Page {
        items,
        next_cursor: None,
        prev_cursor: None,
        total: budget.exhausted().then_some(Total {
            count,
            exact: false,
        }),
        scanned: budget.exhausted().then(|| budget.examined()),
    })
}

fn no_tenant(tenant: &str) -> ApiError {
    ApiError::not_found(format!("This project has no tenant named {tenant}."))
        .with_fix("Pick a tenant from the list, or leave tenant out to search every tenant.")
}
