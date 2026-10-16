//! Tenants for the console: create one with the id you choose, page through
//! them with their user counts, and the counts the Overview shows.
//!
//! The official `tenants.create` always draws a random id; the console's
//! create takes one (or draws one when none is given), and is recorded as a
//! console call with a configuration step, so every open tenant picker
//! hears of it. Reads go through `projects.get` and never create anything.

use serde_json::{Map as JsonMap, Value as JsonValue, json};

use super::{ConsoleCall, ConsoleError, ConsoleErrorKind};
use crate::observe::ConsoleOrigin;
use crate::state::TenantState;
use crate::util::{str_field, truthy};
use crate::{Runtime, lock};

/// Tenants a list holds when the request names no size: as many as it may.
pub const DEFAULT_TENANTS_LISTED: usize = MAX_TENANTS_LISTED;
/// The most tenants one list holds; a filter finds the others.
pub const MAX_TENANTS_LISTED: usize = 500;

/// A tenant to create.
// The flags are the tenant's own settings, one each, as the request has them.
#[allow(clippy::struct_excessive_bools)]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TenantCreate {
    /// Absent: a random 28-character id, as the official `tenants.create`.
    pub tenant_id: Option<String>,
    pub display_name: Option<String>,
    pub allow_password_signup: bool,
    pub enable_email_link_signin: bool,
    pub enable_anonymous_user: bool,
    pub disable_auth: bool,
    /// `DISABLED`, `ENABLED` or `MANDATORY`.
    pub mfa_state: Option<String>,
    pub mfa_providers: Vec<String>,
}

/// One tenant as the console lists it.
// The flags are the tenant's own settings, one each, as the wire type has them.
#[allow(clippy::struct_excessive_bools)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TenantInfo {
    pub tenant_id: String,
    pub display_name: Option<String>,
    pub users: u64,
    pub allow_password_signup: bool,
    pub enable_email_link_signin: bool,
    pub enable_anonymous_user: bool,
    pub disable_auth: bool,
    /// `DISABLED`, `ENABLED` or `MANDATORY`.
    pub mfa_state: String,
    pub mfa_providers: Vec<String>,
}

/// The tenants a filter matches, the first of them in id order.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TenantList {
    pub tenants: Vec<TenantInfo>,
    /// Tenants `q` matches, the listed ones and any past the limit.
    pub total: u64,
    /// The project's own users.
    pub project_users: u64,
}

/// The counts the Overview and the Settings page show.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SummaryCounts {
    /// The project's own users.
    pub users: u64,
    pub tenants: u64,
    /// Users across every tenant.
    pub tenant_users: u64,
}

/// A letter first, then 3 to 19 letters, digits or hyphens.
fn valid_tenant_id(id: &str) -> bool {
    let mut characters = id.chars();
    characters
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic())
        && (4..=20).contains(&id.chars().count())
        && characters.all(|character| character.is_ascii_alphanumeric() || character == '-')
}

fn info(id: &str, tenant: &TenantState) -> TenantInfo {
    let config = &tenant.config;
    let mfa = config.get("mfaConfig").and_then(JsonValue::as_object);
    TenantInfo {
        tenant_id: id.to_owned(),
        display_name: str_field(config, "displayName")
            .filter(|name| !name.is_empty())
            .map(str::to_owned),
        users: u64::try_from(tenant.project.user_count()).unwrap_or(u64::MAX),
        allow_password_signup: truthy(config.get("allowPasswordSignup")),
        enable_email_link_signin: truthy(config.get("enableEmailLinkSignin")),
        enable_anonymous_user: truthy(config.get("enableAnonymousUser")),
        disable_auth: truthy(config.get("disableAuth")),
        mfa_state: mfa
            .and_then(|mfa| str_field(mfa, "state"))
            .unwrap_or("DISABLED")
            .to_owned(),
        mfa_providers: mfa
            .and_then(|mfa| mfa.get("enabledProviders"))
            .and_then(JsonValue::as_array)
            .map(|providers| {
                providers
                    .iter()
                    .filter_map(JsonValue::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default(),
    }
}

impl Runtime {
    /// Creates a tenant of `project` with the id asked for (or a random
    /// one). A taken id is `already-exists`, a malformed one
    /// `invalid-argument`.
    pub fn create_tenant(
        &self,
        project: &str,
        create: &TenantCreate,
    ) -> Result<TenantInfo, ConsoleError> {
        if let Some(id) = &create.tenant_id
            && !valid_tenant_id(id)
        {
            return Err(ConsoleError::invalid(
                "A tenant id starts with a letter and holds 4 to 20 letters, digits or hyphens.",
            ));
        }
        let state = create
            .mfa_state
            .clone()
            .unwrap_or_else(|| "DISABLED".to_owned());
        if !matches!(state.as_str(), "DISABLED" | "ENABLED" | "MANDATORY") {
            return Err(ConsoleError::invalid(format!(
                "`{state}` is not a second-factor setting; use DISABLED, ENABLED or MANDATORY."
            )));
        }
        if let Some(provider) = create
            .mfa_providers
            .iter()
            .find(|provider| provider.as_str() != "PHONE_SMS")
        {
            return Err(ConsoleError::invalid(format!(
                "The emulator offers SMS second factors only (PHONE_SMS), not `{provider}`."
            )));
        }
        let mut body = JsonMap::new();
        if let Some(name) = create.display_name.as_ref().filter(|name| !name.is_empty()) {
            body.insert("displayName".to_owned(), json!(name));
        }
        body.insert(
            "allowPasswordSignup".to_owned(),
            json!(create.allow_password_signup),
        );
        body.insert(
            "enableEmailLinkSignin".to_owned(),
            json!(create.enable_email_link_signin),
        );
        body.insert(
            "enableAnonymousUser".to_owned(),
            json!(create.enable_anonymous_user),
        );
        body.insert("disableAuth".to_owned(), json!(create.disable_auth));
        body.insert(
            "mfaConfig".to_owned(),
            json!({ "state": state, "enabledProviders": create.mfa_providers }),
        );
        let config = crate::ops::tenants::tenant_from_request(&body);
        let mut call = ConsoleCall::start(
            self,
            "createTenant",
            "/tenants",
            project,
            None,
            ConsoleOrigin::Write,
        );
        let created = self
            .update_traced(call.trace(), |data| {
                let agent = data.agent(project);
                let id = match &create.tenant_id {
                    Some(id) => {
                        agent.create_tenant_with_id(id, config, project)?;
                        id.clone()
                    }
                    None => str_field(&agent.create_tenant(&config, project), "tenantId")
                        .unwrap_or_default()
                        .to_owned(),
                };
                agent.tenants.get(&id).map(|tenant| info(&id, tenant))
            })
            .map_err(|error| ConsoleError::of_kind(ConsoleErrorKind::Internal, error.0));
        let result = match created {
            Ok(Some(tenant)) => Ok(tenant),
            Ok(None) => Err(ConsoleError::of_kind(
                ConsoleErrorKind::AlreadyExists,
                format!(
                    "A tenant `{}` already exists.",
                    create.tenant_id.as_deref().unwrap_or_default()
                ),
            )
            .with_fix("Choose another id, or open the existing tenant.")),
            Err(error) => Err(error),
        };
        match &result {
            Ok(tenant) => {
                call.describe(
                    tenant
                        .display_name
                        .clone()
                        .or_else(|| Some(tenant.tenant_id.clone())),
                    None,
                );
                call.finish(self, None);
            }
            Err(error) => call.finish(self, Some(error)),
        }
        result
    }

    /// Tenants of `project` whose id or display name contains `q`
    /// (case-insensitive), in id order, at most `limit`. Creates nothing: an
    /// unseen project has no tenants.
    #[must_use]
    pub fn tenant_list(&self, project: &str, q: &str, limit: usize) -> TenantList {
        let limit = match limit {
            0 => DEFAULT_TENANTS_LISTED,
            limit => limit.min(MAX_TENANTS_LISTED),
        };
        let needle = q.trim().to_lowercase();
        let data = lock(&self.inner.data);
        let Some(agent) = data.projects.get(project) else {
            return TenantList::default();
        };
        let matches = |(id, tenant): &(&String, &TenantState)| {
            needle.is_empty()
                || id.to_lowercase().contains(&needle)
                || str_field(&tenant.config, "displayName")
                    .is_some_and(|name| name.to_lowercase().contains(&needle))
        };
        let total = agent.tenants.iter().filter(matches).count();
        let tenants = agent
            .tenants
            .iter()
            .filter(matches)
            .take(limit)
            .map(|(id, tenant)| info(id, tenant))
            .collect();
        TenantList {
            tenants,
            total: u64::try_from(total).unwrap_or(u64::MAX),
            project_users: u64::try_from(agent.project.user_count()).unwrap_or(u64::MAX),
        }
    }

    /// The tenants of `project` with these ids, in the request's order;
    /// `None` for one that does not exist.
    #[must_use]
    pub fn tenants_by_id(&self, project: &str, ids: &[String]) -> Vec<Option<TenantInfo>> {
        let data = lock(&self.inner.data);
        let agent = data.projects.get(project);
        ids.iter()
            .map(|id| {
                agent
                    .and_then(|agent| agent.tenants.get(id))
                    .map(|tenant| info(id, tenant))
            })
            .collect()
    }

    /// Users, tenants and tenant users of `project`, from counts the state
    /// keeps: O(tenants).
    #[must_use]
    pub fn summary_counts(&self, project: &str) -> SummaryCounts {
        let data = lock(&self.inner.data);
        data.projects
            .get(project)
            .map_or_else(SummaryCounts::default, |agent| SummaryCounts {
                users: u64::try_from(agent.project.user_count()).unwrap_or(u64::MAX),
                tenants: u64::try_from(agent.tenants.len()).unwrap_or(u64::MAX),
                tenant_users: agent
                    .tenants
                    .values()
                    .map(|tenant| u64::try_from(tenant.project.user_count()).unwrap_or(u64::MAX))
                    .sum(),
            })
    }

    /// Every project other than `configured` that holds users, for the
    /// console's foreign-project banner.
    #[must_use]
    pub fn projects_with_users(&self, configured: &str) -> Vec<String> {
        let data = lock(&self.inner.data);
        data.projects
            .iter()
            .filter(|(project, agent)| {
                project.as_str() != configured
                    && (agent.project.user_count() > 0
                        || agent
                            .tenants
                            .values()
                            .any(|tenant| tenant.project.user_count() > 0))
            })
            .map(|(project, _)| project.clone())
            .collect()
    }
}

#[cfg(test)]
#[path = "tenants_tests.rs"]
mod tests;
