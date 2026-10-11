//! What a console asks of the Storage rules: what is in force and since
//! when, installing a draft, the rules file's state, dry runs, access
//! checks, the impact of a draft on recorded decisions, a decision's
//! explained re-run, and coverage.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use firenook_rules_engine::{Diagnostic, GoverningMatch, Ruleset, UnusedMatch};
use firenook_rules_runtime::coverage::CoverageError;
use firenook_rules_runtime::{DecisionOutcome, InstalledVersion, LoadError, RulesOrigin};
use serde_json::{Map as JsonMap, Value as JsonValue};
use tokio::sync::broadcast;

use crate::decisions::{DecisionLog, allows, deciding_line};
use crate::dry_run::{self, DryRunRequest, DryRunResult, RecordedObject, RulesAuth};
use crate::folder_index::FolderShape;
use crate::rules::{
    InstalledRules, NativeRules, Operation, RulesMode, RulesScope, StorageRulesEvent,
};
use crate::{StorageState, lock};

/// How long a bucket's folder shapes stand after its folders changed.
const SHAPES_REUSE: Duration = Duration::from_secs(2);

/// One bucket's folder shapes, and the revision they were read at.
pub(crate) struct CachedShapes {
    revision: u64,
    at: Instant,
    shapes: Arc<(Vec<FolderShape>, bool)>,
}

/// Names and operations one access check covers at most.
pub const ACCESS_NAMES: usize = 200;
pub const ACCESS_OPERATIONS: usize = 3;

/// The Storage rules, as a console works with them.
#[derive(Clone)]
pub struct StorageRulesHandle {
    state: StorageState,
}

/// A recorded decision, re-run with every expression's value.
#[derive(Clone, Debug, PartialEq)]
pub struct DecisionDetail {
    pub id: String,
    pub recorded_outcome: DecisionOutcome,
    /// The re-run against the ruleset that decided it.
    pub result: DryRunResult,
    /// The source that decided it; positions refer to this text.
    pub rules: String,
    pub rules_hash: String,
    /// The request, replayable as a dry run.
    pub request: DryRunRequest,
    /// The caller's token claims, as `request.auth.token` exposed them.
    pub claims: JsonMap<String, JsonValue>,
}

/// Which match blocks govern the files of one folder shape.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FolderRules {
    /// `users/*/avatars/`; `''` for the bucket root.
    pub pattern: String,
    /// Files directly in the folders the pattern stands for.
    pub files: u64,
    pub governed_by: Vec<GoverningMatch>,
    /// No match block covers the files here, so every client request for
    /// them is denied.
    pub uncovered: bool,
    /// Folders below hold files but sit past the analysis depth; they were
    /// not probed (never reported as governed).
    pub deeper: bool,
}

/// Which match blocks govern which folders of a bucket.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StorageRulesMap {
    pub bucket: String,
    pub folders: Vec<FolderRules>,
    /// Match blocks that govern none of those folders.
    pub unused_matches: Vec<UnusedMatch>,
    /// Some level had more than twenty folders and is written as a star.
    pub grouped: bool,
}

/// One decision a draft would turn around.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImpactFlip {
    pub id: String,
    pub operation: Operation,
    pub bucket: String,
    pub path: String,
    pub uid: Option<String>,
    pub before: DecisionOutcome,
    pub after: DecisionOutcome,
}

/// What applying a draft would turn around among the decisions the engine
/// can still re-run.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Impact {
    /// Re-runnable decisions of the scope that were re-evaluated.
    pub considered: usize,
    pub flips: Vec<ImpactFlip>,
}

/// One operation's verdict in an access check.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AccessVerdict {
    pub operation: Operation,
    pub outcome: DecisionOutcome,
    /// The line that decided it, when one did.
    pub line: Option<usize>,
}

/// What an identity may do with one object.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccessRow {
    pub name: String,
    pub verdicts: Vec<AccessVerdict>,
}

/// A console request's refusal with its explanation, so "See why" never
/// needs the decision log.
#[derive(Clone, Debug, PartialEq)]
pub struct ConsoleRefusal {
    /// The decision recorded for it, when the log kept one.
    pub decision: Option<String>,
    /// The line that refused it.
    pub line: Option<usize>,
    /// The explained re-run.
    pub evaluation: Option<DryRunResult>,
    /// The request, replayable as a dry run.
    pub request: Option<DryRunRequest>,
}

impl StorageRulesHandle {
    pub(crate) const fn new(state: StorageState) -> Self {
        Self { state }
    }

    fn rules(&self) -> &NativeRules {
        self.state
            .rules
            .as_ref()
            .expect("a rules handle exists only with rules")
    }

    /// How `firebase.json` assigns rules to buckets.
    #[must_use]
    pub fn mode(&self) -> RulesMode {
        self.rules().mode()
    }

    /// Every scope: the one of every bucket in single-file mode, else each
    /// bucket with rules of its own.
    #[must_use]
    pub fn scopes(&self) -> Vec<RulesScope> {
        self.rules().scopes()
    }

    /// The scope whose rules judge requests to `bucket`.
    #[must_use]
    pub fn scope_of(&self, bucket: &str) -> RulesScope {
        self.rules().scope_of(bucket)
    }

    /// The ruleset in force for `scope`; `None` when its requests are
    /// refused (no ruleset, or one dropped by a failed reload).
    #[must_use]
    pub fn current(&self, scope: &RulesScope) -> Option<Arc<InstalledRules>> {
        self.rules().current(scope)
    }

    /// The file `firebase.json` names for `scope`; saving writes here.
    #[must_use]
    pub fn file(&self, scope: &RulesScope) -> Option<PathBuf> {
        self.rules().file(scope)
    }

    /// The name the scope's source goes by in reports (its file's name).
    #[must_use]
    pub fn file_name(&self, scope: &RulesScope) -> String {
        self.rules().file_name(scope)
    }

    /// Why the file on disk is not what is in force for `scope`.
    #[must_use]
    pub fn file_problems(&self, scope: &RulesScope) -> Vec<Diagnostic> {
        self.rules().file_problems(scope)
    }

    /// Records the outcome of one rules file check: its problems, or `None`
    /// when the file is fine (which clears earlier ones). Subscribers are
    /// told either way.
    pub fn set_file_problems(&self, scope: &RulesScope, problems: Option<LoadError>) {
        self.rules().set_file_problems(scope, problems);
    }

    /// Compiles `source` and makes it the scope's ruleset from the next
    /// request on. A source that does not compile changes nothing.
    ///
    /// # Errors
    /// The compiler's diagnostics when `source` does not compile.
    pub fn install(
        &self,
        scope: &RulesScope,
        source: &str,
        origin: RulesOrigin,
    ) -> Result<(), Vec<Diagnostic>> {
        self.rules().install(scope, source, origin).map(|_| ())
    }

    /// The rulesets that governed `scope`, newest first, at most fifty.
    #[must_use]
    pub fn history(&self, scope: &RulesScope) -> Vec<InstalledVersion> {
        self.rules().history(scope)
    }

    /// Installs, dropped rulesets and rules file checks, from now on.
    #[must_use]
    pub fn subscribe(&self) -> broadcast::Receiver<StorageRulesEvent> {
        self.rules().subscribe()
    }

    /// The decision log; `None` when the suite runs without diagnostics.
    #[must_use]
    pub fn decisions(&self) -> Option<&DecisionLog> {
        self.state.decisions.as_deref()
    }

    /// Judges each request without making it, against `draft` when given,
    /// else against the rules in force for its bucket. Nothing is recorded.
    ///
    /// # Errors
    /// The compiler's diagnostics when `draft` does not compile.
    pub fn evaluate(
        &self,
        requests: &[DryRunRequest],
        draft: Option<&str>,
    ) -> Result<Vec<DryRunResult>, Vec<Diagnostic>> {
        let draft = draft
            .map(|source| InstalledRules::compile(source, RulesOrigin::Console).map(Arc::new))
            .transpose()?;
        Ok(dry_run::evaluate(
            self.rules(),
            &self.state.inner,
            requests,
            draft.as_ref(),
        ))
    }

    /// What an identity may do with each object, against the rules in
    /// force, unrecorded: `get`, `list` (the name as a prefix) and `delete`
    /// see the object as it is; `create` and `update` propose it unchanged.
    /// At most [`ACCESS_NAMES`] names and [`ACCESS_OPERATIONS`] operations.
    #[must_use]
    pub fn access(
        &self,
        bucket: &str,
        identity: (Option<&str>, Option<&RulesAuth>),
        names: &[String],
        operations: &[Operation],
    ) -> Vec<AccessRow> {
        let rules = self.rules();
        let installed = rules.installed(bucket);
        names
            .iter()
            .take(ACCESS_NAMES)
            .map(|name| AccessRow {
                name: name.clone(),
                verdicts: operations
                    .iter()
                    .take(ACCESS_OPERATIONS)
                    .map(|operation| {
                        let Some(installed) = &installed else {
                            return AccessVerdict {
                                operation: *operation,
                                outcome: DecisionOutcome::Error,
                                line: None,
                            };
                        };
                        if *operation == Operation::List && installed.ruleset.rules_version() < 2 {
                            return AccessVerdict {
                                operation: *operation,
                                outcome: DecisionOutcome::Error,
                                line: None,
                            };
                        }
                        let request = DryRunRequest {
                            method: *operation,
                            bucket: bucket.to_owned(),
                            path: name.clone(),
                            authorization: identity.0.map(str::to_owned),
                            auth: identity.1.cloned(),
                            proposed: None,
                            request_resource: None,
                            resource: RecordedObject::ReadStore,
                            time: None,
                        };
                        let prepared = dry_run::prepare(&lock(&self.state.inner), &request);
                        let (result, trace) = installed
                            .ruleset
                            .evaluate_with_trace(&prepared.request, &rules.access());
                        AccessVerdict {
                            operation: *operation,
                            outcome: DecisionOutcome::of(&result),
                            line: deciding_line(&allows(installed, &trace), result.allowed),
                        }
                    })
                    .collect(),
            })
            .collect()
    }

    /// Re-runs every re-runnable decision of `scope` against `draft` and
    /// lists those it would turn around. Compiles and evaluates on the
    /// calling thread: call it off the request workers.
    ///
    /// # Errors
    /// The compiler's diagnostics when `draft` does not compile.
    pub fn impact(&self, scope: &RulesScope, draft: &str) -> Result<Impact, Vec<Diagnostic>> {
        let draft = InstalledRules::compile(draft, RulesOrigin::Console)?;
        let Some(log) = self.decisions() else {
            return Ok(Impact::default());
        };
        let access = self.rules().access();
        let mut impact = Impact::default();
        for retained in log.retained() {
            let record = &retained.record;
            if !scope.governs(&record.bucket) || record.no_ruleset {
                continue;
            }
            impact.considered += 1;
            let after = if record.operation == Operation::List && draft.ruleset.rules_version() < 2
            {
                DecisionOutcome::Error
            } else {
                DecisionOutcome::of(&draft.ruleset.evaluate(&retained.request, &access))
            };
            if after != record.outcome {
                impact.flips.push(ImpactFlip {
                    id: record.id.clone(),
                    operation: record.operation,
                    bucket: record.bucket.clone(),
                    path: record.name.clone(),
                    uid: record.uid.clone(),
                    before: record.outcome,
                    after,
                });
            }
        }
        Ok(impact)
    }

    /// Decision `id` re-run against the ruleset that decided it, with every
    /// expression's value, reading the current Cloud Firestore documents
    /// for `firestore.get()`; `None` once the engine no longer keeps its
    /// request (it keeps the newest 2,000).
    #[must_use]
    pub fn detail(&self, id: &str) -> Option<DecisionDetail> {
        let retained = self.decisions()?.find(id)?;
        let record = &retained.record;
        let request = dry_run::replay(&record.bucket, &record.name, &retained.request);
        let result = match &retained.rules {
            // Nothing was evaluated: the bucket had no ruleset.
            None => DryRunResult::refused(crate::decisions::NO_RULESET_MESSAGE),
            Some(rules) => dry_run::rerun(self.rules(), rules, &retained.request),
        };
        Some(DecisionDetail {
            id: record.id.clone(),
            recorded_outcome: record.outcome,
            result,
            rules: retained
                .rules
                .as_ref()
                .map(|rules| rules.source().to_owned())
                .unwrap_or_default(),
            rules_hash: record.rules_hash.clone(),
            claims: retained
                .request
                .auth
                .as_ref()
                .map(|auth| {
                    auth.token
                        .iter()
                        .map(|(key, value)| (key.clone(), dry_run::value_json(value)))
                        .collect()
                })
                .unwrap_or_default(),
            request,
        })
    }

    /// The explanation a console request's refusal carries: `request`
    /// judged again with every expression's value against the rules in
    /// force, and the decision recorded for it.
    #[must_use]
    pub fn explain_refusal(
        &self,
        request: &DryRunRequest,
        decision: Option<String>,
    ) -> ConsoleRefusal {
        let evaluation = dry_run::evaluate(
            self.rules(),
            &self.state.inner,
            std::slice::from_ref(request),
            None,
        )
        .remove(0);
        ConsoleRefusal {
            decision,
            line: deciding_line(
                &evaluation.allows,
                evaluation.outcome == DecisionOutcome::Allow,
            ),
            evaluation: Some(evaluation),
            request: Some(request.clone()),
        }
    }

    /// Which match blocks of `ruleset` (a draft, or the rules in force)
    /// govern the folders of `bucket` that directly hold files, each probed
    /// at its real depth; `None` while the folder index is being built.
    #[must_use]
    pub fn map(&self, bucket: &str, ruleset: &Ruleset) -> Option<StorageRulesMap> {
        let cached = {
            let data = lock(&self.state.inner);
            let index = data.folders.as_ref().filter(|index| index.is_built())?;
            let revision = index.stats(bucket, "").map_or(0, |root| root.subtree_rev);
            let mut cache = lock(&self.state.shapes);
            match cache.get(bucket) {
                // Unchanged, or recomputed less than SHAPES_REUSE ago: a
                // bucket under constant writes is walked at most that often.
                Some(cached)
                    if cached.revision == revision || cached.at.elapsed() < SHAPES_REUSE =>
                {
                    Arc::clone(&cached.shapes)
                }
                _ => {
                    let shapes = Arc::new(index.shapes(bucket));
                    cache.insert(
                        bucket.to_owned(),
                        CachedShapes {
                            revision,
                            at: Instant::now(),
                            shapes: Arc::clone(&shapes),
                        },
                    );
                    shapes
                }
            }
        };
        let (shapes, grouped) = (&cached.0, cached.1);
        let patterns = shapes
            .iter()
            .map(|shape| shape.pattern.as_str())
            .collect::<Vec<_>>();
        let governing = ruleset.governing_objects(bucket, &patterns);
        let folders = shapes
            .iter()
            .zip(governing.collections)
            .map(|(shape, governance)| {
                // A level that holds no file of its own (only deeper ones)
                // has nothing to govern or leave uncovered.
                let probed = shape.files > 0;
                FolderRules {
                    uncovered: probed && governance.uncovered(),
                    governed_by: if probed {
                        governance.governed_by
                    } else {
                        Vec::new()
                    },
                    pattern: shape.pattern.clone(),
                    files: shape.files,
                    deeper: shape.deeper,
                }
            })
            .collect();
        Some(StorageRulesMap {
            bucket: bucket.to_owned(),
            folders,
            unused_matches: governing.unused_matches,
            grouped,
        })
    }

    /// The official per-expression coverage report for the rules in force
    /// for `scope`, naming the scope's rules file.
    ///
    /// # Errors
    /// `Disabled` without diagnostics, `NoRules` when nothing is in force,
    /// `Busy` while an evaluation holds the store.
    pub fn coverage_report(&self, scope: &RulesScope) -> Result<Vec<u8>, CoverageError> {
        let log = self.decisions().ok_or(CoverageError::Disabled)?;
        let rules = self.current(scope).ok_or(CoverageError::NoRules)?;
        log.coverage
            .report(&scope.key(), &rules.ruleset, &self.file_name(scope))
    }
}
