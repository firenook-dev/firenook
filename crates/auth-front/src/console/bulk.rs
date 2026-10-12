//! Bulk changes to many users at once, and clearing every user.
//!
//! The users are resolved once — named keys, or every user a filter matches
//! in one scope, read from an index snapshot outside the lock — then changed
//! in chunks of 2,000, one critical section each, so the app's own calls
//! interleave and none waits longer than one chunk. Every user is changed
//! through the state's own paths (`update_user_by_local_id`, `delete_user`),
//! so the index, the notices, lifecycle events and persistence follow as for
//! any call. Progress, failures and cancellation go through a
//! [`BulkProgress`] the console turns into its job. The whole action is one
//! Activity record.

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{Map as JsonMap, Value as JsonValue, json};

use super::filter::UserFilter;
use super::index::IndexSnapshot;
use super::{ConsoleCall, ConsoleError, ConsoleErrorKind};
use crate::observe::ConsoleOrigin;
use crate::ops::validate_serialized_custom_claims;
use crate::state::{AuthData, ProjectState, UpdateOptions, UserRecord};
use crate::util::{now_seconds, str_field, truthy};
use crate::{Runtime, lock};

/// Users one critical section changes.
pub const CHUNK: usize = 2_000;
/// The most users one action names by key.
pub const MAX_KEYS: usize = 10_000;
/// The most users a delete that runs `user.delete` triggers may remove.
pub const MAX_TRIGGERED_DELETES: usize = 10_000;

/// What to do to each user.
#[derive(Clone, Debug, PartialEq)]
pub enum BulkAction {
    Disable,
    Enable,
    /// Mark the email verified (users without an email are passed over).
    Verify,
    /// Revoke refresh tokens: ID tokens issued before now are refused.
    Revoke,
    SetClaims {
        claims: JsonMap<String, JsonValue>,
        mode: ClaimsMode,
    },
    RemoveClaims {
        keys: Vec<String>,
    },
    /// With `triggers`, Functions get `user.delete` for each user, as
    /// `deleteUsers` does; without, nothing is queued (the emulator's own
    /// delete-all semantics).
    Delete {
        triggers: bool,
    },
}

/// How `SetClaims` treats the claims a user already has.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClaimsMode {
    /// Keys replace, a `null` value removes the key, others stay.
    Merge,
    /// The claims become exactly these (`null` values dropped).
    Replace,
}

impl BulkAction {
    /// The verb in `/users:<verb>` and `firenook.console.users.<verb>`.
    #[must_use]
    pub const fn verb(&self) -> &'static str {
        match self {
            Self::Disable => "disable",
            Self::Enable => "enable",
            Self::Verify => "verify",
            Self::Revoke => "revoke",
            Self::SetClaims { .. } => "setClaims",
            Self::RemoveClaims { .. } => "removeClaims",
            Self::Delete { .. } => "delete",
        }
    }

    /// "Disable", "Set claims of"…, for a job's title.
    #[must_use]
    pub const fn title(&self) -> &'static str {
        match self {
            Self::Disable => "Disable",
            Self::Enable => "Enable",
            Self::Verify => "Verify the email of",
            Self::Revoke => "Revoke the tokens of",
            Self::SetClaims { .. } => "Set claims of",
            Self::RemoveClaims { .. } => "Remove claims from",
            Self::Delete { .. } => "Delete",
        }
    }
}

/// Who an action applies to.
#[derive(Clone, Debug, PartialEq)]
pub enum BulkUsers {
    /// These users: `(tenant, uid)`, the tenant absent for project users.
    Keys(Vec<(Option<String>, String)>),
    /// Every user `filter` matches in one scope when the action runs.
    Query {
        tenant: Option<String>,
        filter: Box<UserFilter>,
    },
}

/// One user a target names: its tenant (absent for project users) and uid.
type Target = (Option<String>, Arc<str>);

/// What an action would do (the dry run's answer).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BulkPreview {
    /// Users the target names that exist.
    pub matched: u64,
    /// Users the action would change (or delete).
    pub changed: u64,
    /// Matched but already as asked.
    pub unchanged: u64,
    /// `user.delete` events a delete would queue.
    pub triggers: u64,
    pub took: Duration,
}

/// How an action ended.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BulkOutcome {
    pub total: u64,
    pub changed: u64,
    pub skipped: u64,
    pub failed: u64,
    pub cancelled: bool,
}

/// Where bulk work reports, between chunks.
pub trait BulkProgress {
    /// How many users the work goes through.
    fn total(&self, total: u64);
    /// Users done so far (changed, passed over or failed).
    fn progress(&self, done: u64);
    /// `by` more users already as asked.
    fn skipped(&self, by: u64);
    /// One user failed; `key` is its `auth.user` key (`<tenant>|<uid>`).
    fn failed(&self, key: &str, message: &str);
    /// Stop before the next chunk.
    fn cancelled(&self) -> bool;
}

/// The `auth.user` key of a user: `<tenant>|<uid>`, the tenant empty for
/// project users.
#[must_use]
pub fn user_key(tenant: Option<&str>, uid: &str) -> String {
    format!("{}|{uid}", tenant.unwrap_or_default())
}

/// What one user needs.
enum Plan {
    Change(UserRecord),
    Delete,
    Skip,
    Fail(String),
}

fn stored_claims(user: &UserRecord) -> JsonMap<String, JsonValue> {
    str_field(user, "customAttributes")
        .and_then(|text| serde_json::from_str::<JsonValue>(text).ok())
        .and_then(|value| match value {
            JsonValue::Object(object) => Some(object),
            _ => None,
        })
        .unwrap_or_default()
}

/// The `customAttributes` change that makes a user's claims `claims`.
fn claims_change(before: &JsonMap<String, JsonValue>, claims: JsonMap<String, JsonValue>) -> Plan {
    if &claims == before {
        return Plan::Skip;
    }
    let mut fields = UserRecord::new();
    if claims.is_empty() {
        fields.insert("customAttributes".to_owned(), JsonValue::Null);
        return Plan::Change(fields);
    }
    let serialized = JsonValue::Object(claims).to_string();
    if let Err(error) = validate_serialized_custom_claims(&serialized) {
        return Plan::Fail(error.message);
    }
    fields.insert("customAttributes".to_owned(), json!(serialized));
    Plan::Change(fields)
}

fn plan(action: &BulkAction, user: &UserRecord) -> Plan {
    let set = |field: &str, value: JsonValue| {
        let mut fields = UserRecord::new();
        fields.insert(field.to_owned(), value);
        Plan::Change(fields)
    };
    match action {
        BulkAction::Disable if truthy(user.get("disabled")) => Plan::Skip,
        BulkAction::Disable => set("disabled", json!(true)),
        BulkAction::Enable if !truthy(user.get("disabled")) => Plan::Skip,
        BulkAction::Enable => set("disabled", json!(false)),
        BulkAction::Verify if !truthy(user.get("email")) || truthy(user.get("emailVerified")) => {
            Plan::Skip
        }
        BulkAction::Verify => set("emailVerified", json!(true)),
        BulkAction::Revoke => set("validSince", json!(now_seconds().to_string())),
        BulkAction::SetClaims { claims, mode } => {
            let before = stored_claims(user);
            let mut after = match mode {
                ClaimsMode::Merge => before.clone(),
                ClaimsMode::Replace => JsonMap::new(),
            };
            for (key, value) in claims {
                if value.is_null() {
                    after.remove(key);
                } else {
                    after.insert(key.clone(), value.clone());
                }
            }
            claims_change(&before, after)
        }
        BulkAction::RemoveClaims { keys } => {
            let before = stored_claims(user);
            let mut after = before.clone();
            for key in keys {
                after.remove(key);
            }
            claims_change(&before, after)
        }
        BulkAction::Delete { .. } => Plan::Delete,
    }
}

/// The accounts of one scope, for changing.
fn scope_mut<'a>(
    data: &'a mut AuthData,
    project: &str,
    tenant: Option<&str>,
) -> Option<&'a mut ProjectState> {
    let agent = data.projects.get_mut(project)?;
    match tenant {
        None => Some(&mut agent.project),
        Some(tenant) => agent
            .tenants
            .get_mut(tenant)
            .map(|state| &mut state.project),
    }
}

/// The scopes and users a target names, resolved on snapshots outside the
/// lock: `(tenant, uid)` in target order (uid order for a query).
fn resolve(
    runtime: &Runtime,
    project: &str,
    users: &BulkUsers,
) -> Result<Vec<Target>, ConsoleError> {
    match users {
        BulkUsers::Keys(keys) => Ok(keys
            .iter()
            .map(|(tenant, uid)| {
                (
                    tenant.clone().filter(|tenant| !tenant.is_empty()),
                    Arc::from(uid.as_str()),
                )
            })
            .collect()),
        BulkUsers::Query { tenant, filter } => {
            let tenant = tenant.as_deref().filter(|tenant| !tenant.is_empty());
            let view = runtime.users(project, tenant)?;
            Ok(view
                .index
                .matching_uids(filter)
                .into_iter()
                .map(|uid| (tenant.map(str::to_owned), uid))
                .collect())
        }
    }
}

/// The records of every scope a target touches, cloned in O(1) each.
fn records_of(
    runtime: &Runtime,
    project: &str,
    targets: &[Target],
) -> std::collections::BTreeMap<Option<String>, im::OrdMap<String, Arc<UserRecord>>> {
    let tenants: std::collections::BTreeSet<Option<String>> =
        targets.iter().map(|(tenant, _)| tenant.clone()).collect();
    let data = lock(&runtime.inner.data);
    tenants
        .into_iter()
        .filter_map(|tenant| {
            let agent = data.projects.get(project)?;
            let users = match &tenant {
                None => agent.project.users.clone(),
                Some(id) => agent.tenants.get(id)?.project.users.clone(),
            };
            Some((tenant, users))
        })
        .collect()
}

impl Runtime {
    /// What `action` would do to `users`, changing nothing.
    pub fn bulk_preview(
        &self,
        project: &str,
        users: &BulkUsers,
        action: &BulkAction,
    ) -> Result<BulkPreview, ConsoleError> {
        let started = Instant::now();
        let targets = resolve(self, project, users)?;
        let records = records_of(self, project, &targets);
        let mut preview = BulkPreview::default();
        for (tenant, uid) in &targets {
            let Some(user) = records.get(tenant).and_then(|users| users.get(&**uid)) else {
                continue;
            };
            preview.matched += 1;
            match plan(action, user) {
                Plan::Change(_) => preview.changed += 1,
                Plan::Delete => {
                    preview.changed += 1;
                    if matches!(action, BulkAction::Delete { triggers: true }) {
                        preview.triggers += 1;
                    }
                }
                Plan::Skip => preview.unchanged += 1,
                Plan::Fail(_) => {}
            }
        }
        preview.took = started.elapsed();
        Ok(preview)
    }

    /// The number of users a target names now (a query's matches), for the
    /// refusal of a triggered delete over the limit before any job starts.
    pub fn bulk_count(&self, project: &str, users: &BulkUsers) -> Result<u64, ConsoleError> {
        Ok(u64::try_from(resolve(self, project, users)?.len()).unwrap_or(u64::MAX))
    }

    /// Applies `action` to `users` in chunks, reporting to `progress`
    /// between them and stopping when it is cancelled (what was changed
    /// stays changed). Synchronous: run it on a blocking thread.
    pub fn bulk_apply(
        &self,
        project: &str,
        users: &BulkUsers,
        action: &BulkAction,
        progress: &dyn BulkProgress,
    ) -> Result<BulkOutcome, ConsoleError> {
        let targets = resolve(self, project, users)?;
        if matches!(action, BulkAction::Delete { triggers: true })
            && targets.len() > MAX_TRIGGERED_DELETES
        {
            return Err(triggered_delete_refusal());
        }
        let tenant = match users {
            BulkUsers::Query { tenant, .. } => tenant.clone().filter(|tenant| !tenant.is_empty()),
            BulkUsers::Keys(_) => None,
        };
        let mut call = ConsoleCall::start(
            self,
            &format!("users.{}", action.verb()),
            &format!("/users:{}", action.verb()),
            project,
            tenant.as_deref(),
            ConsoleOrigin::Write,
        );
        call.describe(Some(users_phrase(targets.len())), None);
        let mut outcome = BulkOutcome {
            total: u64::try_from(targets.len()).unwrap_or(u64::MAX),
            ..BulkOutcome::default()
        };
        progress.total(outcome.total);
        let mut done = 0_u64;
        for chunk in targets.chunks(CHUNK) {
            if progress.cancelled() {
                outcome.cancelled = true;
                break;
            }
            let mut skipped = 0_u64;
            let mut failures: Vec<(String, String)> = Vec::new();
            let changed = self
                .update_traced(call.trace(), |data| {
                    let mut changed = 0_u64;
                    for (tenant, uid) in chunk {
                        let key = || user_key(tenant.as_deref(), uid);
                        let Some(state) = scope_mut(data, project, tenant.as_deref()) else {
                            failures.push((
                                key(),
                                format!(
                                    "There is no tenant `{}` in this project.",
                                    tenant.as_deref().unwrap_or_default()
                                ),
                            ));
                            continue;
                        };
                        let Some(user) = state.get_user_by_local_id(uid) else {
                            failures.push((key(), "USER_NOT_FOUND".to_owned()));
                            continue;
                        };
                        match plan(action, &user) {
                            Plan::Skip => skipped += 1,
                            Plan::Fail(message) => failures.push((key(), message)),
                            Plan::Delete => {
                                if matches!(action, BulkAction::Delete { triggers: true }) {
                                    state.delete_user(&user);
                                } else {
                                    state.delete_user_quietly(uid);
                                }
                                changed += 1;
                            }
                            Plan::Change(fields) => {
                                match state.update_user_by_local_id(
                                    uid,
                                    &fields,
                                    UpdateOptions::default(),
                                ) {
                                    Ok(_) => changed += 1,
                                    Err(error) => failures.push((key(), error.message)),
                                }
                            }
                        }
                    }
                    changed
                })
                .map_err(|error| ConsoleError::of_kind(ConsoleErrorKind::Internal, error.0))?;
            outcome.changed += changed;
            outcome.skipped += skipped;
            outcome.failed += u64::try_from(failures.len()).unwrap_or(u64::MAX);
            for (key, message) in &failures {
                progress.failed(key, message);
            }
            if skipped > 0 {
                progress.skipped(skipped);
            }
            done += u64::try_from(chunk.len()).unwrap_or(u64::MAX);
            progress.progress(done);
            // Let the app's calls waiting on the lock in before the next chunk.
            std::thread::yield_now();
        }
        call.finish(self, None);
        Ok(outcome)
    }

    /// Deletes every user of every tenant of `project` without triggers
    /// (codes stay, no `user.delete`), scope by scope in chunks of 2,000,
    /// reporting to `progress`. Answers the number removed.
    pub fn clear_users(
        &self,
        project: &str,
        progress: &dyn BulkProgress,
    ) -> Result<u64, ConsoleError> {
        let scopes: Vec<(Option<String>, IndexSnapshot)> = {
            let data = lock(&self.inner.data);
            data.projects
                .get(project)
                .map(|agent| {
                    std::iter::once((None, agent.project.user_index().snapshot()))
                        .chain(agent.tenants.iter().map(|(id, tenant)| {
                            (Some(id.clone()), tenant.project.user_index().snapshot())
                        }))
                        .collect()
                })
                .unwrap_or_default()
        };
        let total: u64 = scopes.iter().map(|(_, index)| index.len()).sum();
        progress.total(total);
        let mut call = ConsoleCall::start(
            self,
            "clear",
            "/suite/clear",
            project,
            None,
            ConsoleOrigin::Write,
        );
        call.describe(
            Some(users_phrase(usize::try_from(total).unwrap_or(usize::MAX))),
            None,
        );
        let mut removed = 0_u64;
        'scopes: for (tenant, index) in scopes {
            let uids = index.matching_uids(&UserFilter::default());
            for chunk in uids.chunks(CHUNK) {
                if progress.cancelled() {
                    break 'scopes;
                }
                removed += self
                    .update_traced(call.trace(), |data| {
                        scope_mut(data, project, tenant.as_deref())
                            .map_or(0, |state| state.remove_users_quietly(chunk))
                    })
                    .map_err(|error| ConsoleError::of_kind(ConsoleErrorKind::Internal, error.0))?;
                progress.progress(removed);
                std::thread::yield_now();
            }
            self.update_traced(call.trace(), |data| {
                if let Some(state) = scope_mut(data, project, tenant.as_deref()) {
                    state.note_cleared();
                }
            })
            .map_err(|error| ConsoleError::of_kind(ConsoleErrorKind::Internal, error.0))?;
        }
        call.finish(self, None);
        Ok(removed)
    }
}

/// "1 user", "1,204 users".
#[must_use]
pub fn users_phrase(count: usize) -> String {
    if count == 1 {
        "1 user".to_owned()
    } else {
        format!("{} users", thousands(count))
    }
}

/// `1,204`.
#[must_use]
pub fn thousands(count: usize) -> String {
    let digits = count.to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            out.push(',');
        }
        out.push(digit);
    }
    out
}

/// The refusal of a triggered delete over the limit.
#[must_use]
pub fn triggered_delete_refusal() -> ConsoleError {
    ConsoleError::of_kind(
        ConsoleErrorKind::FailedPrecondition,
        "A delete that runs your user.delete triggers is limited to 10,000 users per action.",
    )
    .with_fix("Narrow the filter, or delete without triggers.")
}

#[cfg(test)]
#[path = "bulk_tests.rs"]
mod tests;
