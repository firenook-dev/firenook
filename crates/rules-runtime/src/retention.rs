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
//! The ring keeps the newest [`RETAINED_DECISIONS`] within
//! [`RETAINED_BYTES`], each ruleset's source charged once however many
//! decisions it made — the window Storage keeps — so "why" still answers
//! for a denial the console's decisions feed lists from a while ago. (It
//! used to be bounded like the Requests history, 256 for ten minutes, and
//! "See why" on an older denial found nothing.) Admission never blocks a
//! producer: a contended ring skips the entry and counts it, as the history
//! does. A decision is retained before its event is published, so an id a
//! console sees is already retained unless admission was contended.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use firenook_core_store::{DatabaseName, Snapshot};
use firenook_rules_engine::{
    EvaluationRequest, EvaluationResult, QueryFilter, Resource, Ruleset, Value,
};

use crate::{EvaluationAccess, InstalledRules, RulesRuntime};

/// Decisions whose evaluation context is kept for a re-run.
pub const RETAINED_DECISIONS: usize = 2_000;
/// Bytes charged against those contexts, each ruleset source once.
pub const RETAINED_BYTES: usize = 16 * 1024 * 1024;

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
    /// auth and query values. Its ruleset's source is charged apart, once
    /// for every decision it made.
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
    /// Retained entries per ruleset source hash: a source is charged once.
    sources: HashMap<String, usize>,
}

struct Entry {
    bytes: usize,
    decision: Arc<RetainedDecision>,
}

impl DecisionRetention {
    /// Keeps one decision unless the ring is contended or the entry alone
    /// exceeds the byte budget. Never waits. Whether it was kept.
    pub(crate) fn retain(
        &self,
        request_id: &str,
        project: &str,
        installed: &Arc<InstalledRules>,
        request: &EvaluationRequest,
        result: &EvaluationResult,
    ) -> bool {
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
        let Ok(mut ring) = self.ring.try_lock() else {
            return self.omit();
        };
        let hash = installed.source_hash.as_str();
        let source = installed.rules.source().len();
        let charged_source = |ring: &Ring| {
            if ring.sources.contains_key(hash) {
                0
            } else {
                source
            }
        };
        if bytes + charged_source(&ring) > RETAINED_BYTES {
            drop(ring);
            return self.omit();
        }
        while ring.entries.len() >= RETAINED_DECISIONS
            || (!ring.entries.is_empty()
                && ring.bytes + bytes + charged_source(&ring) > RETAINED_BYTES)
        {
            ring.evict();
        }
        // The eviction above may have released this very source.
        let fresh = charged_source(&ring);
        *ring.sources.entry(hash.to_owned()).or_insert(0) += 1;
        ring.bytes += bytes + fresh;
        ring.entries.push_back(Entry {
            bytes,
            decision: Arc::new(decision),
        });
        true
    }

    /// Counts a decision that was not kept; `false` is the caller's answer.
    fn omit(&self) -> bool {
        self.omitted.fetch_add(1, Ordering::Relaxed);
        false
    }

    pub(crate) fn find(&self, request_id: &str) -> Option<Arc<RetainedDecision>> {
        self.lock()
            .entries
            .iter()
            .rev()
            .find(|entry| entry.decision.request_id == request_id)
            .map(|entry| entry.decision.clone())
    }

    pub(crate) fn of_database(&self, database: &DatabaseName) -> Vec<Arc<RetainedDecision>> {
        self.lock()
            .entries
            .iter()
            .filter(|entry| &entry.decision.database == database)
            .map(|entry| entry.decision.clone())
            .collect()
    }

    /// How many decisions are retained now.
    pub(crate) fn len(&self) -> usize {
        self.lock().entries.len()
    }

    /// Decisions that were not retained: a contended ring, or an entry
    /// larger than the whole budget.
    pub(crate) fn omitted(&self) -> usize {
        self.omitted.load(Ordering::Relaxed)
    }

    /// Readers are the console, never a producer, and only hold the ring to
    /// clone `Arc`s; waiting briefly here makes a producer skip, not stall.
    fn lock(&self) -> std::sync::MutexGuard<'_, Ring> {
        match self.ring.lock() {
            Ok(ring) => ring,
            Err(poisoned) => poisoned.into_inner(),
        }
    }
}

impl Ring {
    fn evict(&mut self) {
        let Some(entry) = self.entries.pop_front() else {
            return;
        };
        self.bytes = self.bytes.saturating_sub(entry.bytes);
        let installed = &entry.decision.installed;
        if let Some(count) = self.sources.get_mut(&installed.source_hash) {
            *count -= 1;
            if *count == 0 {
                self.sources.remove(&installed.source_hash);
                self.bytes = self.bytes.saturating_sub(installed.rules.source().len());
            }
        }
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

    /// How many decisions can be re-run now (every database), and how many
    /// were recorded without their context: a contended ring, or one
    /// larger than the whole budget.
    #[must_use]
    pub fn retained_counts(&self) -> (usize, usize) {
        self.recorder.as_ref().map_or((0, 0), |recorder| {
            let retention = recorder.retention();
            (retention.len(), retention.omitted())
        })
    }
}

#[cfg(test)]
#[path = "retention_tests.rs"]
mod tests;
