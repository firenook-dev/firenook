//! Finding users by what a person types: ⌘K and the identity pickers.
//!
//! The lock is held only to take the index snapshots of the scopes searched
//! (the project's and every tenant's, O(1) each); the search then runs on
//! them. Exact uid and email first, in every scope; then email and uid
//! prefixes (range reads of the ordered sets); then, only while more are
//! wanted, a scan of each digest's searchable text — the project's first,
//! then tenants with the most users first — within a budget of digests
//! examined and until the caller says stop.

use serde_json::{Map as JsonMap, Value as JsonValue};

use super::index::IndexSnapshot;
use super::{ConsoleError, UserRow};
use crate::{Runtime, lock};

/// Which users a search looks through.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SearchScope {
    /// The project's users and every tenant's.
    Every,
    /// The project's own users.
    Project,
    /// One tenant's users.
    Tenant(String),
}

/// One user a search found.
#[derive(Clone, Debug, PartialEq)]
pub struct FoundUser {
    pub row: UserRow,
    /// Parsed custom claims, when set.
    pub claims: Option<JsonMap<String, JsonValue>>,
}

/// What a search found.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct UserSearch {
    /// Best first: exact, then prefix, then substring matches.
    pub users: Vec<FoundUser>,
    /// Digests the substring scan examined.
    pub examined: u64,
    /// The scan stopped (budget spent or told to stop) before it was done.
    pub exhausted: bool,
}

impl Runtime {
    /// At most `limit` users of `project` matching `text` in `scope`, best
    /// first. An empty `text` lists the first users by uid, the project's
    /// first. The substring scan examines at most `budget` digests and stops
    /// when `stop` says so. Creates nothing; an unknown tenant is
    /// `not-found`.
    pub fn search_users(
        &self,
        project: &str,
        scope: &SearchScope,
        text: &str,
        limit: usize,
        budget: usize,
        stop: &dyn Fn() -> bool,
    ) -> Result<UserSearch, ConsoleError> {
        let scopes: Vec<(Option<String>, IndexSnapshot)> = {
            let data = lock(&self.inner.data);
            match (data.projects.get(project), scope) {
                (None, SearchScope::Tenant(tenant)) => {
                    return Err(ConsoleError::unknown_tenant(tenant));
                }
                (None, _) => Vec::new(),
                (Some(agent), SearchScope::Project) => {
                    vec![(None, agent.project.user_index().snapshot())]
                }
                (Some(agent), SearchScope::Tenant(tenant)) => {
                    let state = agent
                        .tenants
                        .get(tenant)
                        .ok_or_else(|| ConsoleError::unknown_tenant(tenant))?;
                    vec![(Some(tenant.clone()), state.project.user_index().snapshot())]
                }
                (Some(agent), SearchScope::Every) => {
                    std::iter::once((None, agent.project.user_index().snapshot()))
                        .chain(agent.tenants.iter().map(|(id, tenant)| {
                            (Some(id.clone()), tenant.project.user_index().snapshot())
                        }))
                        .collect()
                }
            }
        };
        let text = text.trim();
        let mut found = Found {
            slots: vec![Vec::new(); scopes.len()],
            search: UserSearch::default(),
            limit,
        };
        if text.is_empty() {
            for (scope, (_, index)) in scopes.iter().enumerate() {
                let wanted = found.wanted();
                if wanted == 0 {
                    break;
                }
                found.push(&scopes, scope, index.first_by_uid(wanted));
            }
            return Ok(found.search);
        }
        let lower = text.to_lowercase();
        for (scope, (_, index)) in scopes.iter().enumerate() {
            found.push(&scopes, scope, index.exact_matches(text, &lower));
        }
        for (scope, (_, index)) in scopes.iter().enumerate() {
            let wanted = found.wanted();
            if wanted == 0 {
                return Ok(found.search);
            }
            found.push(&scopes, scope, index.prefix_matches(text, &lower, wanted));
        }
        // The project first, then tenants with the most users first.
        let mut order: Vec<usize> = (0..scopes.len()).collect();
        order.sort_by_key(|scope| {
            let (tenant, index) = &scopes[*scope];
            (tenant.is_some(), std::cmp::Reverse(index.len()))
        });
        let mut remaining = budget;
        for scope in order {
            let wanted = found.wanted();
            if wanted == 0 {
                break;
            }
            let (_, index) = &scopes[scope];
            let (slots, stopped) =
                index.substring_matches(&lower, &found.slots[scope], wanted, &mut remaining, stop);
            found.push(&scopes, scope, slots);
            if stopped {
                found.search.exhausted = true;
                break;
            }
        }
        let mut search = found.search;
        search.examined = u64::try_from(budget - remaining).unwrap_or(u64::MAX);
        Ok(search)
    }
}

/// What a search found so far, per scope and in order.
struct Found {
    slots: Vec<Vec<u32>>,
    search: UserSearch,
    limit: usize,
}

impl Found {
    fn wanted(&self) -> usize {
        self.limit.saturating_sub(self.search.users.len())
    }

    /// Adds the users at `slots` of scope `scope` not found already.
    fn push(&mut self, scopes: &[(Option<String>, IndexSnapshot)], scope: usize, slots: Vec<u32>) {
        let (tenant, index) = &scopes[scope];
        for slot in slots {
            if self.search.users.len() >= self.limit {
                return;
            }
            if self.slots[scope].contains(&slot) {
                continue;
            }
            if let Some((row, claims)) = index.hit_at(slot, tenant.as_deref()) {
                self.slots[scope].push(slot);
                self.search.users.push(FoundUser { row, claims });
            }
        }
    }
}

#[cfg(test)]
#[path = "search_tests.rs"]
mod tests;
