//! Decision retention: the evaluation context behind each recorded Requests
//! event, so a console can ask why a request was decided as it was and what a
//! changed ruleset would have decided instead.
//!
//! A Requests event carries the verdict and the line that decided it, which
//! says *what* happened but not *why*: the values each expression produced
//! are gone once the evaluator returns. Keeping the request itself (its
//! path, auth, documents and query) and the ruleset that decided it makes the
//! decision re-runnable with an explanation, at any time while it is kept.
//!
//! The ring is bounded exactly like the Requests history — 256 entries, ten
//! minutes, the same byte budget — and admission never blocks a producer: a
//! contended ring skips the entry and counts it, as the history does. A
//! decision is retained before its event is published, so an id a console
//! sees is already retained unless admission was contended.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use firenook_core_store::{DatabaseName, Snapshot};
use firenook_rules_engine::{
    EvaluationRequest, EvaluationResult, QueryFilter, Resource, Ruleset, Value,
};

use crate::request_history::{MAXIMUM_AGE, MAXIMUM_BYTES, MAXIMUM_EVENTS};
use crate::{EvaluationAccess, InstalledRules, RulesRuntime};

/// The verdict of one decision, as the Requests feed names it.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DecisionOutcome {
    /// An allow condition held.
    Allow,
    /// No allow condition held and none failed.
    Deny,
    /// No allow condition held and evaluation failed.
    Error,
}

impl DecisionOutcome {
    /// The outcome of an evaluation result, classified as the Requests feed
    /// classifies it.
    #[must_use]
    pub const fn of(result: &EvaluationResult) -> Self {
        if result.allowed {
            Self::Allow
        } else if result.error.is_some() {
            Self::Error
        } else {
            Self::Deny
        }
    }

    /// `allow`, `deny` or `error`.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Allow => "allow",
            Self::Deny => "deny",
            Self::Error => "error",
        }
    }
}

/// One recorded operation's evaluation context.
pub struct RetainedDecision {
    request_id: String,
    database: DatabaseName,
    installed: Arc<InstalledRules>,
    request: EvaluationRequest,
    outcome: DecisionOutcome,
}

impl RetainedDecision {
    /// The id its Requests event carries.
    #[must_use]
    pub fn request_id(&self) -> &str {
        &self.request_id
    }

    /// The database it addressed.
    #[must_use]
    pub const fn database(&self) -> &DatabaseName {
        &self.database
    }

    /// The evaluator request exactly as it was evaluated, auth included.
    #[must_use]
    pub const fn request(&self) -> &EvaluationRequest {
        &self.request
    }

    /// The ruleset that decided it, which may no longer be in force.
    #[must_use]
    pub fn ruleset(&self) -> &Ruleset {
        &self.installed.rules
    }

    /// The stable hash of that ruleset's source.
    #[must_use]
    pub fn source_hash(&self) -> &str {
        &self.installed.source_hash
    }

    /// The verdict recorded at the time.
    #[must_use]
    pub const fn recorded(&self) -> DecisionOutcome {
        self.outcome
    }

    /// What a re-run reads: the current store for `get()`/`exists()`, and for
    /// a write the document it proposed for its own `getAfter()`.
    #[must_use]
    pub fn access(&self, snapshot: Snapshot) -> EvaluationAccess {
        EvaluationAccess::replaying(snapshot, self.database.project_id(), &self.request)
    }

    /// Bytes this entry is charged against the byte budget: its documents,
    /// auth and query values plus the ruleset source, the same source a
    /// Requests event carries in full.
    fn charged_bytes(&self) -> usize {
        let request = &self.request;
        let auth = request.auth.as_ref().map_or(0, |auth| {
            auth.uid.as_ref().map_or(0, String::len)
                + auth
                    .token
                    .iter()
                    .map(|(key, value)| key.len() + value_bytes(value))
                    .sum::<usize>()
        });
        256 + self.request_id.len()
            + request.path.len()
            + request.resource.as_ref().map_or(0, resource_bytes)
            + request.request_resource.as_ref().map_or(0, resource_bytes)
            + auth
            + request.query.filter.as_ref().map_or(0, filter_bytes)
            + self.installed.rules.source().len()
    }
}

fn resource_bytes(resource: &Resource) -> usize {
    resource.name.len()
        + resource
            .data
            .iter()
            .map(|(key, value)| key.len() + value_bytes(value))
            .sum::<usize>()
}

fn filter_bytes(filter: &QueryFilter) -> usize {
    match filter {
        QueryFilter::Field(constraint) => {
            constraint.field.iter().map(String::len).sum::<usize>() + value_bytes(&constraint.value)
        }
        QueryFilter::And(filters) | QueryFilter::Or(filters) => {
            16 + filters.iter().map(filter_bytes).sum::<usize>()
        }
    }
}

fn value_bytes(value: &Value) -> usize {
    16 + match value {
        Value::String(text) | Value::Path(text) => text.len(),
        Value::Bytes(bytes) => bytes.len(),
        Value::List(values) => values.iter().map(value_bytes).sum(),
        Value::Map(map) => map
            .iter()
            .map(|(key, value)| key.len() + value_bytes(value))
            .sum(),
        _ => 0,
    }
}

#[derive(Clone, Default)]
pub(crate) struct DecisionRetention {
    ring: Arc<Mutex<Ring>>,
    omitted: Arc<AtomicUsize>,
}

#[derive(Default)]
struct Ring {
    entries: VecDeque<Entry>,
    bytes: usize,
}

struct Entry {
    recorded: Instant,
    bytes: usize,
    decision: Arc<RetainedDecision>,
}

impl DecisionRetention {
    /// Keeps one decision unless the ring is contended or the entry alone
    /// exceeds the byte budget. Never waits.
    pub(crate) fn retain(
        &self,
        request_id: &str,
        project: &str,
        installed: &Arc<InstalledRules>,
        request: &EvaluationRequest,
        result: &EvaluationResult,
    ) {
        self.retain_at(
            request_id,
            project,
            installed,
            request,
            result,
            Instant::now(),
        );
    }

    fn retain_at(
        &self,
        request_id: &str,
        project: &str,
        installed: &Arc<InstalledRules>,
        request: &EvaluationRequest,
        result: &EvaluationResult,
        now: Instant,
    ) {
        // Probe first, as the history does: a contended ring costs the
        // producer nothing, not even the copy of the request.
        match self.ring.try_lock() {
            Ok(admitted) => drop(admitted),
            Err(_) => return self.omit(),
        }
        let Some(database) = database_of(project, &request.path) else {
            return self.omit();
        };
        let decision = RetainedDecision {
            request_id: request_id.to_owned(),
            database,
            installed: installed.clone(),
            request: request.clone(),
            outcome: DecisionOutcome::of(result),
        };
        let bytes = decision.charged_bytes();
        if bytes > MAXIMUM_BYTES {
            return self.omit();
        }
        let Ok(mut ring) = self.ring.try_lock() else {
            return self.omit();
        };
        ring.expire(now);
        while ring.entries.len() >= MAXIMUM_EVENTS || ring.bytes + bytes > MAXIMUM_BYTES {
            ring.evict();
        }
        ring.bytes += bytes;
        ring.entries.push_back(Entry {
            recorded: now,
            bytes,
            decision: Arc::new(decision),
        });
    }

    fn omit(&self) {
        self.omitted.fetch_add(1, Ordering::Relaxed);
    }

    pub(crate) fn find(&self, request_id: &str) -> Option<Arc<RetainedDecision>> {
        self.find_at(request_id, Instant::now())
    }

    fn find_at(&self, request_id: &str, now: Instant) -> Option<Arc<RetainedDecision>> {
        let mut ring = self.lock();
        ring.expire(now);
        ring.entries
            .iter()
            .rev()
            .find(|entry| entry.decision.request_id == request_id)
            .map(|entry| entry.decision.clone())
    }

    pub(crate) fn of_database(&self, database: &DatabaseName) -> Vec<Arc<RetainedDecision>> {
        self.of_database_at(database, Instant::now())
    }

    fn of_database_at(&self, database: &DatabaseName, now: Instant) -> Vec<Arc<RetainedDecision>> {
        let mut ring = self.lock();
        ring.expire(now);
        ring.entries
            .iter()
            .filter(|entry| &entry.decision.database == database)
            .map(|entry| entry.decision.clone())
            .collect()
    }

    /// Readers are the console, never a producer, and only hold the ring to
    /// clone `Arc`s; waiting briefly here makes a producer skip, not stall.
    fn lock(&self) -> std::sync::MutexGuard<'_, Ring> {
        match self.ring.lock() {
            Ok(ring) => ring,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    #[cfg(test)]
    fn omitted(&self) -> usize {
        self.omitted.load(Ordering::Relaxed)
    }
}

impl Ring {
    fn evict(&mut self) {
        if let Some(entry) = self.entries.pop_front() {
            self.bytes -= entry.bytes;
        }
    }

    fn expire(&mut self, now: Instant) {
        // Admission order is not time order across producers, so every
        // bounded entry is inspected, as the history does.
        let mut bytes = self.bytes;
        self.entries.retain(|entry| {
            let keep = now.saturating_duration_since(entry.recorded) < MAXIMUM_AGE;
            if !keep {
                bytes -= entry.bytes;
            }
            keep
        });
        self.bytes = bytes;
    }
}

/// The database a rules path addresses: `/databases/{id}/documents/…`.
fn database_of(project: &str, path: &str) -> Option<DatabaseName> {
    let (database, _) = path.strip_prefix("/databases/")?.split_once("/documents")?;
    DatabaseName::new(project, database).ok()
}

impl RulesRuntime {
    /// Whether this runtime keeps decision contexts: only while request
    /// diagnostics are enabled.
    #[must_use]
    pub fn retains_decisions(&self) -> bool {
        self.recorder.is_some()
    }

    /// The retained context of the decision a Requests event names, or
    /// `None` when it expired, was evicted or was never retained.
    #[must_use]
    pub fn decision(&self, request_id: &str) -> Option<Arc<RetainedDecision>> {
        self.recorder.as_ref()?.retention().find(request_id)
    }

    /// Every retained decision for `database`, oldest first.
    #[must_use]
    pub fn retained_decisions(&self, database: &DatabaseName) -> Vec<Arc<RetainedDecision>> {
        self.recorder
            .as_ref()
            .map(|recorder| recorder.retention().of_database(database))
            .unwrap_or_default()
    }
}

#[cfg(test)]
#[path = "retention_tests.rs"]
mod tests;
