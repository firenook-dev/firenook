//! Native Storage Security Rules: rulesets compiled by `firenook-rules-engine`
//! and evaluated in process with the request model recorded from the official
//! emulator (`conformance/fixtures/storage-rules-v1`).

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::fmt;
use std::path::PathBuf;
use std::sync::{Arc, RwLock};

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use firenook_rules_engine::{
    AllowLocation, Auth, Diagnostic, DocumentAccess, DocumentAccessError, EvaluationRequest,
    RequestOperation, Resource, Ruleset, SourceSpan, StorageObject, Timestamp, Value, compile,
};
use firenook_rules_runtime::{
    InstalledVersion, LoadError, MAXIMUM_VERSIONS, RulesOrigin, source_hash,
};
use serde_json::Value as JsonValue;
use time::OffsetDateTime;
use tokio::sync::broadcast;

use crate::{StorageError, StoredObject};

/// Latest-state Cloud Firestore document lookup behind `firestore.get` and
/// `firestore.exists`. `path` is the rules path
/// (`/databases/{database}/documents/{document}`); the returned resource
/// name is exposed as `__name__`.
pub trait FirestoreDocuments: Send + Sync {
    /// Returns the current document, or `None` when it does not exist.
    ///
    /// # Errors
    ///
    /// Returns an error when the path is not a document path or the store
    /// cannot answer.
    fn document(&self, path: &str) -> Result<Option<Resource>, DocumentAccessError>;
}

/// A lookup that finds no documents, for suites without Cloud Firestore.
#[derive(Clone, Copy, Debug, Default)]
pub struct NoFirestoreDocuments;

impl FirestoreDocuments for NoFirestoreDocuments {
    fn document(&self, _path: &str) -> Result<Option<Resource>, DocumentAccessError> {
        Ok(None)
    }
}

/// One rules source file.
#[derive(Debug, Clone)]
pub struct RulesFile {
    /// Source filename for diagnostics.
    pub name: String,
    /// Firebase Storage rules source.
    pub content: String,
}

/// One rules source bound to a Storage bucket.
#[derive(Debug, Clone)]
pub struct BucketRules {
    /// Bucket id.
    pub bucket: String,
    /// Source filename for diagnostics.
    pub name: String,
    /// Firebase Storage rules source.
    pub content: String,
}

/// Which buckets a ruleset governs, mirroring the official emulator's two
/// rules managers.
#[derive(Debug, Clone)]
pub enum RulesSource {
    /// One source governs every bucket (`firebase.json` `storage.rules`).
    Single(RulesFile),
    /// Resource-keyed sources (`firebase.json` Storage targets). A bucket
    /// without a source has no ruleset and refuses every request.
    PerBucket(Vec<BucketRules>),
}

/// Native Storage rules configuration.
#[derive(Clone)]
pub struct NativeRulesConfig {
    /// Sources to compile at startup.
    pub source: RulesSource,
    /// Cloud Firestore lookup for `firestore.*`.
    pub documents: Arc<dyn FirestoreDocuments>,
}

impl fmt::Debug for NativeRulesConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NativeRulesConfig")
            .field("source", &self.source)
            .finish_non_exhaustive()
    }
}

/// Which buckets one installed ruleset governs.
#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub enum RulesScope {
    /// One ruleset for every bucket: `firebase.json` `storage: { rules }`,
    /// or the open default of a demo project.
    AllBuckets,
    /// One bucket's own ruleset: `firebase.json` Storage targets.
    Bucket(String),
}

impl RulesScope {
    /// What a scope's coverage and decisions are filed under: `storage/*`
    /// or `storage/<bucket>`.
    #[must_use]
    pub fn key(&self) -> String {
        match self {
            Self::AllBuckets => "storage/*".to_owned(),
            Self::Bucket(bucket) => format!("storage/{bucket}"),
        }
    }

    /// The bucket of a per-bucket scope.
    #[must_use]
    pub fn bucket(&self) -> Option<&str> {
        match self {
            Self::AllBuckets => None,
            Self::Bucket(bucket) => Some(bucket),
        }
    }

    /// Whether requests to `bucket` are judged by this scope's rules.
    #[must_use]
    pub fn governs(&self, bucket: &str) -> bool {
        match self {
            Self::AllBuckets => true,
            Self::Bucket(own) => own == bucket,
        }
    }
}

/// How `firebase.json` assigns Storage rules to buckets.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RulesMode {
    /// `storage: { rules }`: one file governs every bucket.
    Single,
    /// `storage: [{ target, rules }]`: each targeted bucket has its own file.
    PerBucket,
    /// No `storage` section in a demo project: the emulator's open default
    /// rules govern every bucket.
    OpenDefault,
}

/// The rules files `firebase.json` names, so a console can say which file
/// governs a scope and save to it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RulesFiles {
    /// No `storage` section in a demo project: the open default, no file.
    None,
    /// One file for every bucket.
    Single(PathBuf),
    /// Each targeted bucket's file.
    PerBucket(BTreeMap<String, PathBuf>),
}

/// The ruleset in force for a scope, with where it came from.
#[derive(Debug)]
pub struct InstalledRules {
    pub ruleset: Arc<Ruleset>,
    /// Stable hash of the source, as the Firestore runtime computes it.
    pub hash: String,
    pub origin: RulesOrigin,
    pub installed_at: OffsetDateTime,
    /// Each allow statement's condition as an editor places it, by the byte
    /// offset of its `allow`, so a decision's trace names lines and ranges
    /// without rescanning the source per request.
    conditions: BTreeMap<usize, SourceSpan>,
}

impl InstalledRules {
    fn new(ruleset: Ruleset, origin: RulesOrigin) -> Self {
        let conditions = condition_spans(&ruleset);
        Self {
            hash: source_hash(ruleset.source()),
            ruleset: Arc::new(ruleset),
            origin,
            installed_at: OffsetDateTime::now_utc(),
            conditions,
        }
    }

    /// Compiles `source`, or says why it does not compile.
    pub(crate) fn compile(source: &str, origin: RulesOrigin) -> Result<Self, Vec<Diagnostic>> {
        compile(source).map(|ruleset| Self::new(ruleset, origin))
    }

    /// The source in force.
    #[must_use]
    pub fn source(&self) -> &str {
        self.ruleset.source()
    }

    /// The condition of the allow statement an evaluation trace names.
    pub(crate) fn condition(&self, location: AllowLocation) -> SourceSpan {
        self.conditions
            .get(&location.byte_offset)
            .copied()
            .unwrap_or(SourceSpan {
                line: location.line,
                from: 0,
                to: 0,
            })
    }

    fn version(&self) -> Arc<InstalledVersion> {
        Arc::new(InstalledVersion {
            hash: self.hash.clone(),
            source: self.ruleset.shared_source(),
            origin: self.origin,
            installed_at: self.installed_at,
        })
    }
}

/// The condition range of every allow statement, by its statement's byte
/// offset (the offset an evaluation trace carries).
fn condition_spans(ruleset: &Ruleset) -> BTreeMap<usize, SourceSpan> {
    let source = ruleset.source();
    let line_starts = std::iter::once(0)
        .chain(source.match_indices('\n').map(|(offset, _)| offset + 1))
        .collect::<Vec<_>>();
    let mut spans = BTreeMap::new();
    for block in ruleset.outline().matches {
        for allow in block.allows {
            let Some(start) = line_starts.get(allow.statement.line - 1) else {
                continue;
            };
            let Some((offset, _)) = source[*start..]
                .char_indices()
                .nth(allow.statement.column - 1)
            else {
                continue;
            };
            spans.insert(
                start + offset,
                SourceSpan {
                    line: allow.condition_range.line,
                    from: allow.condition_range.from,
                    to: allow.condition_range.to,
                },
            );
        }
    }
    spans
}

#[derive(Clone)]
enum RulesetTable {
    Single(Arc<InstalledRules>),
    PerBucket(BTreeMap<String, Arc<InstalledRules>>),
}

/// What changed about the Storage rules in force.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum StorageRulesEvent {
    /// A ruleset was installed for the scope.
    Installed {
        scope: RulesScope,
        origin: RulesOrigin,
    },
    /// A reload through `/internal/setRules` did not compile, so no ruleset
    /// is in force and every request is refused until a valid one loads (as
    /// the official emulator does).
    Dropped { scope: RulesScope },
    /// The rules file watcher finished a pass for the scope; its problems,
    /// if any, are in `file_problems`.
    FileChecked { scope: RulesScope },
}

/// Versions of one scope, oldest first, bounded, consecutive identical
/// sources collapsed.
type History = VecDeque<Arc<InstalledVersion>>;

#[derive(Default)]
struct RulesState {
    /// `None` after a failed reload: the official emulator drops the
    /// previous ruleset and refuses every request until a valid one loads
    /// (storage-rules-v1 lifecycle-set-rules).
    table: Option<RulesetTable>,
    /// Recorded under the same lock as the install, so a scope's newest
    /// version is always the ruleset in force.
    versions: BTreeMap<RulesScope, History>,
    file_problems: BTreeMap<RulesScope, LoadError>,
}

impl RulesState {
    fn record(&mut self, scope: RulesScope, version: &Arc<InstalledVersion>) {
        let history = self.versions.entry(scope).or_default();
        if history.back().is_some_and(|last| last.hash == version.hash) {
            return;
        }
        if history.len() == MAXIMUM_VERSIONS {
            history.pop_front();
        }
        history.push_back(Arc::clone(version));
    }
}

/// Change notifications retained for a slow subscriber before it is told it
/// lagged (and re-reads).
const EVENT_CAPACITY: usize = 64;

/// Installed rulesets, their versions, and the document lookup they
/// evaluate against.
#[derive(Clone)]
pub(crate) struct NativeRules {
    state: Arc<RwLock<RulesState>>,
    documents: Arc<dyn FirestoreDocuments>,
    mode: RulesMode,
    files: Arc<Option<RulesFiles>>,
    /// The file names the startup sources carried, by scope.
    names: Arc<BTreeMap<RulesScope, String>>,
    events: broadcast::Sender<StorageRulesEvent>,
}

/// Outcome of one rules evaluation.
pub(crate) enum Verdict {
    Allowed,
    /// Denied; carries the runtime error text when evaluation failed.
    Denied(Option<String>),
    /// The bucket has no loaded ruleset.
    NoRuleset,
}

/// Which Storage operation a request performs, as the rules see it.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
pub enum Operation {
    Get,
    List,
    Create,
    Update,
    Delete,
}

impl Operation {
    /// The rules' `request.method` name.
    #[must_use]
    pub const fn method(self) -> &'static str {
        match self {
            Self::Get => "get",
            Self::List => "list",
            Self::Create => "create",
            Self::Update => "update",
            Self::Delete => "delete",
        }
    }

    pub(crate) const fn permission(self) -> &'static str {
        match self {
            Self::Get => "READ",
            Self::List => "LIST",
            Self::Create | Self::Update | Self::Delete => "WRITE",
        }
    }

    pub(crate) const fn request_operation(self) -> RequestOperation {
        match self {
            Self::Get => RequestOperation::Get,
            Self::List => RequestOperation::List,
            Self::Create => RequestOperation::Create,
            Self::Update => RequestOperation::Update,
            Self::Delete => RequestOperation::Delete,
        }
    }

    pub(crate) const fn of_request(operation: RequestOperation) -> Self {
        match operation {
            RequestOperation::Get => Self::Get,
            RequestOperation::List => Self::List,
            RequestOperation::Create => Self::Create,
            RequestOperation::Update => Self::Update,
            RequestOperation::Delete => Self::Delete,
        }
    }
}

/// The message the evaluator's refusal of a list below version 2 carries.
pub(crate) const LIST_V1_MESSAGE: &str =
    "Permission denied. List operations are only allowed for rules_version='2'.";

impl NativeRules {
    /// Compiles every configured ruleset (a failure is a startup failure)
    /// and records each as the scope's first version.
    pub(crate) fn start(
        config: &NativeRulesConfig,
        files: Option<&RulesFiles>,
    ) -> Result<Self, StorageError> {
        let table = compile_table(&config.source, RulesOrigin::Startup)?;
        let mode = match (files, &config.source) {
            (Some(RulesFiles::None), _) => RulesMode::OpenDefault,
            (Some(RulesFiles::Single(_)), _) | (None, RulesSource::Single(_)) => RulesMode::Single,
            (Some(RulesFiles::PerBucket(_)), _) | (None, RulesSource::PerBucket(_)) => {
                RulesMode::PerBucket
            }
        };
        let names = match &config.source {
            RulesSource::Single(file) => {
                BTreeMap::from([(RulesScope::AllBuckets, file_name(&file.name))])
            }
            RulesSource::PerBucket(buckets) => buckets
                .iter()
                .map(|rules| {
                    (
                        RulesScope::Bucket(rules.bucket.clone()),
                        file_name(&rules.name),
                    )
                })
                .collect(),
        };
        let mut state = RulesState::default();
        match &table {
            RulesetTable::Single(rules) => state.record(RulesScope::AllBuckets, &rules.version()),
            RulesetTable::PerBucket(buckets) => {
                for (bucket, rules) in buckets {
                    state.record(RulesScope::Bucket(bucket.clone()), &rules.version());
                }
            }
        }
        state.table = Some(table);
        Ok(Self {
            state: Arc::new(RwLock::new(state)),
            documents: Arc::clone(&config.documents),
            mode,
            files: Arc::new(files.cloned()),
            names: Arc::new(names),
            events: broadcast::channel(EVENT_CAPACITY).0,
        })
    }

    fn read(&self) -> std::sync::RwLockReadGuard<'_, RulesState> {
        self.state
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn write(&self) -> std::sync::RwLockWriteGuard<'_, RulesState> {
        self.state
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub(crate) const fn mode(&self) -> RulesMode {
        self.mode
    }

    pub(crate) fn scope_of(&self, bucket: &str) -> RulesScope {
        match self.mode {
            RulesMode::Single | RulesMode::OpenDefault => RulesScope::AllBuckets,
            RulesMode::PerBucket => RulesScope::Bucket(bucket.to_owned()),
        }
    }

    /// Buckets `firebase.json` or an install has given rules of their own.
    fn known_buckets(&self, state: &RulesState) -> BTreeSet<String> {
        let mut buckets = BTreeSet::new();
        if let Some(RulesFiles::PerBucket(files)) = &*self.files {
            buckets.extend(files.keys().cloned());
        }
        if let Some(RulesetTable::PerBucket(table)) = &state.table {
            buckets.extend(table.keys().cloned());
        }
        buckets.extend(
            state
                .versions
                .keys()
                .filter_map(|scope| scope.bucket().map(str::to_owned)),
        );
        buckets
    }

    /// Every scope: the one of every bucket in single-file mode, else each
    /// bucket with rules of its own.
    pub(crate) fn scopes(&self) -> Vec<RulesScope> {
        match self.mode {
            RulesMode::Single | RulesMode::OpenDefault => vec![RulesScope::AllBuckets],
            RulesMode::PerBucket => self
                .known_buckets(&self.read())
                .into_iter()
                .map(RulesScope::Bucket)
                .collect(),
        }
    }

    /// The ruleset that judges requests to `bucket`, if any.
    pub(crate) fn installed(&self, bucket: &str) -> Option<Arc<InstalledRules>> {
        match self.read().table.as_ref()? {
            RulesetTable::Single(rules) => Some(Arc::clone(rules)),
            RulesetTable::PerBucket(buckets) => buckets.get(bucket).cloned(),
        }
    }

    /// The ruleset in force for `scope`; `None` when its requests are
    /// refused (no ruleset, or one dropped by a failed reload).
    pub(crate) fn current(&self, scope: &RulesScope) -> Option<Arc<InstalledRules>> {
        match (self.read().table.as_ref()?, scope) {
            (RulesetTable::Single(rules), _) => Some(Arc::clone(rules)),
            (RulesetTable::PerBucket(buckets), RulesScope::Bucket(bucket)) => {
                buckets.get(bucket).cloned()
            }
            (RulesetTable::PerBucket(_), RulesScope::AllBuckets) => None,
        }
    }

    /// Whether `bucket` currently has a ruleset.
    pub(crate) fn has_ruleset(&self, bucket: &str) -> bool {
        self.installed(bucket).is_some()
    }

    /// Compiles `source` and makes it the scope's ruleset; a source that
    /// does not compile changes nothing and says why.
    pub(crate) fn install(
        &self,
        scope: &RulesScope,
        source: &str,
        origin: RulesOrigin,
    ) -> Result<Arc<InstalledRules>, Vec<Diagnostic>> {
        let rules = Arc::new(InstalledRules::compile(source, origin)?);
        let version = rules.version();
        {
            let mut state = self.write();
            match scope {
                RulesScope::AllBuckets => {
                    state.table = Some(RulesetTable::Single(Arc::clone(&rules)));
                    state.record(RulesScope::AllBuckets, &version);
                    if self.mode == RulesMode::PerBucket {
                        for bucket in self.known_buckets(&state) {
                            state.record(RulesScope::Bucket(bucket), &version);
                        }
                    }
                }
                RulesScope::Bucket(bucket) => {
                    let mut table = match state.table.take() {
                        Some(RulesetTable::PerBucket(table)) => table,
                        // One ruleset governed every bucket (a reload of a
                        // single file): each keeps it, this one changes.
                        Some(RulesetTable::Single(single)) => self
                            .known_buckets(&state)
                            .into_iter()
                            .map(|known| (known, Arc::clone(&single)))
                            .collect(),
                        // Dropped by a failed reload: the table starts again.
                        None => BTreeMap::new(),
                    };
                    table.insert(bucket.clone(), Arc::clone(&rules));
                    state.table = Some(RulesetTable::PerBucket(table));
                    state.record(scope.clone(), &version);
                }
            }
        }
        let _ = self.events.send(StorageRulesEvent::Installed {
            scope: scope.clone(),
            origin,
        });
        Ok(rules)
    }

    /// Replaces every ruleset, `/internal/setRules`'s way: a compile failure
    /// leaves no ruleset installed; a success records origin `Reload`.
    pub(crate) fn replace(&self, source: &RulesSource) -> Result<(), StorageError> {
        let compiled = compile_table(source, RulesOrigin::Reload);
        let mut affected = Vec::new();
        let outcome = {
            let mut state = self.write();
            match compiled {
                Ok(table) => {
                    match &table {
                        RulesetTable::Single(rules) => {
                            let version = rules.version();
                            affected.push(RulesScope::AllBuckets);
                            if self.mode == RulesMode::PerBucket {
                                affected.extend(
                                    self.known_buckets(&state)
                                        .into_iter()
                                        .map(RulesScope::Bucket),
                                );
                            }
                            for scope in &affected {
                                state.record(scope.clone(), &version);
                            }
                        }
                        RulesetTable::PerBucket(buckets) => {
                            for (bucket, rules) in buckets {
                                let scope = RulesScope::Bucket(bucket.clone());
                                state.record(scope.clone(), &rules.version());
                                affected.push(scope);
                            }
                        }
                    }
                    state.table = Some(table);
                    Ok(())
                }
                Err(error) => {
                    affected = self.scopes_locked(&state);
                    state.table = None;
                    Err(error)
                }
            }
        };
        for scope in affected {
            let _ = self.events.send(match outcome {
                Ok(()) => StorageRulesEvent::Installed {
                    scope,
                    origin: RulesOrigin::Reload,
                },
                Err(_) => StorageRulesEvent::Dropped { scope },
            });
        }
        outcome
    }

    fn scopes_locked(&self, state: &RulesState) -> Vec<RulesScope> {
        match self.mode {
            RulesMode::Single | RulesMode::OpenDefault => vec![RulesScope::AllBuckets],
            RulesMode::PerBucket => self
                .known_buckets(state)
                .into_iter()
                .map(RulesScope::Bucket)
                .collect(),
        }
    }

    /// The rulesets that governed `scope`, newest first, at most fifty.
    pub(crate) fn history(&self, scope: &RulesScope) -> Vec<InstalledVersion> {
        self.read()
            .versions
            .get(scope)
            .map(|history| {
                history
                    .iter()
                    .rev()
                    .map(|version| (**version).clone())
                    .collect()
            })
            .unwrap_or_default()
    }

    /// The file `firebase.json` names for `scope`.
    pub(crate) fn file(&self, scope: &RulesScope) -> Option<PathBuf> {
        match (&*self.files, scope) {
            (Some(RulesFiles::Single(path)), RulesScope::AllBuckets) => Some(path.clone()),
            (Some(RulesFiles::PerBucket(files)), RulesScope::Bucket(bucket)) => {
                files.get(bucket).cloned()
            }
            _ => None,
        }
    }

    /// The name a report gives the scope's source: its file's name.
    pub(crate) fn file_name(&self, scope: &RulesScope) -> String {
        self.file(scope)
            .and_then(|path| {
                path.file_name()
                    .map(|name| name.to_string_lossy().into_owned())
            })
            .or_else(|| self.names.get(scope).cloned())
            .unwrap_or_else(|| "storage.rules".to_owned())
    }

    /// Records the outcome of one rules file check for `scope`.
    pub(crate) fn set_file_problems(&self, scope: &RulesScope, problems: Option<LoadError>) {
        {
            let mut state = self.write();
            match problems {
                Some(problems) => {
                    state.file_problems.insert(scope.clone(), problems);
                }
                None => {
                    state.file_problems.remove(scope);
                }
            }
        }
        let _ = self.events.send(StorageRulesEvent::FileChecked {
            scope: scope.clone(),
        });
    }

    /// Why the last rules file check for `scope` did not install it.
    pub(crate) fn file_problems(&self, scope: &RulesScope) -> Vec<Diagnostic> {
        self.read()
            .file_problems
            .get(scope)
            .map(|problems| problems.diagnostics.clone())
            .unwrap_or_default()
    }

    pub(crate) fn subscribe(&self) -> broadcast::Receiver<StorageRulesEvent> {
        self.events.subscribe()
    }

    /// What `firestore.get()` and `firestore.exists()` read.
    pub(crate) fn access(&self) -> Documents<'_> {
        Documents(&*self.documents)
    }

    /// Evaluates one operation on `/b/{bucket}/o/{name}` (or the list prefix).
    pub(crate) fn verify(
        &self,
        bucket: &str,
        name: &str,
        operation: Operation,
        before: Option<&StoredObject>,
        after: Option<&StoredObject>,
        authorization: Option<&str>,
    ) -> Verdict {
        let Some(installed) = self.installed(bucket) else {
            return Verdict::NoRuleset;
        };
        if operation == Operation::List && installed.ruleset.rules_version() < 2 {
            return Verdict::Denied(Some(LIST_V1_MESSAGE.to_owned()));
        }
        let request = evaluation_request(
            operation,
            bucket,
            name,
            before.map(rules_object),
            after.map(rules_object),
            auth_from_authorization(authorization),
            now(),
        );
        let result = installed.ruleset.evaluate(&request, &self.access());
        if result.allowed {
            Verdict::Allowed
        } else {
            Verdict::Denied(result.error.map(|error| error.message))
        }
    }
}

/// The request the rules judge for one operation, built one way for real
/// requests, dry runs, access checks and replays, so a dry run's verdict is
/// the one a client would get.
pub(crate) fn evaluation_request(
    operation: Operation,
    bucket: &str,
    name: &str,
    before: Option<StorageObject>,
    after: Option<StorageObject>,
    auth: Option<Auth>,
    time: Timestamp,
) -> EvaluationRequest {
    let mut request = EvaluationRequest::storage(
        operation.request_operation(),
        rules_path(bucket, name),
        time,
    );
    request.auth = auth;
    request.storage_resource = before;
    request.storage_request_resource = after;
    request
}

pub(crate) fn now() -> Timestamp {
    let now = time::OffsetDateTime::now_utc();
    Timestamp::new(now.unix_timestamp(), now.nanosecond())
}

/// The last path segment of a rules file name.
fn file_name(name: &str) -> String {
    name.rsplit(['/', '\\']).next().unwrap_or(name).to_owned()
}

pub(crate) struct Documents<'a>(&'a dyn FirestoreDocuments);

impl DocumentAccess for Documents<'_> {
    fn get(&self, path: &str) -> Result<Option<Resource>, DocumentAccessError> {
        Ok(self.0.document(path)?.map(|mut resource| {
            // The official runtime exposes the project-qualified name
            // (storage-rules-v1 firestore-document-shape).
            if !resource.name.starts_with('/') {
                resource.name.insert(0, '/');
            }
            resource
        }))
    }

    fn get_after(&self, path: &str) -> Result<Option<Resource>, DocumentAccessError> {
        self.get(path)
    }
}

fn compile_table(source: &RulesSource, origin: RulesOrigin) -> Result<RulesetTable, StorageError> {
    let compile_file = |name: &str, content: &str| {
        InstalledRules::compile(content, origin)
            .map(Arc::new)
            .map_err(|diagnostics| {
                StorageError(format!(
                    "Storage rules {name} failed to compile: {}",
                    diagnostics
                        .iter()
                        .map(|diagnostic| format!(
                            "{name}:{}:{}: {}",
                            diagnostic.line, diagnostic.column, diagnostic.message
                        ))
                        .collect::<Vec<_>>()
                        .join("; ")
                ))
            })
    };
    match source {
        RulesSource::Single(file) => Ok(RulesetTable::Single(compile_file(
            &file.name,
            &file.content,
        )?)),
        RulesSource::PerBucket(buckets) => {
            let mut table = BTreeMap::new();
            for rules in buckets {
                table.insert(
                    rules.bucket.clone(),
                    compile_file(&rules.name, &rules.content)?,
                );
            }
            Ok(RulesetTable::PerBucket(table))
        }
    }
}

/// `/b/{bucket}/o/{name}` with empty segments dropped: the official rules
/// runtime crashes on an empty segment (storage-rules-v1
/// `oracleCrashNotRecordedLive`); Firenook evaluates the remaining segments.
pub(crate) fn rules_path(bucket: &str, name: &str) -> String {
    let mut path = format!("/b/{bucket}/o");
    for segment in name.split('/').filter(|segment| !segment.is_empty()) {
        path.push('/');
        path.push_str(segment);
    }
    path
}

/// The fourteen-key object the official runtime hands to rules.
pub(crate) fn rules_object(object: &StoredObject) -> StorageObject {
    let timestamp =
        |value: &str| Timestamp::parse_rfc3339(value).unwrap_or_else(|_| Timestamp::new(0, 0));
    StorageObject {
        name: object.name.clone(),
        bucket: object.bucket.clone(),
        generation: i64::try_from(object.generation).unwrap_or(i64::MAX),
        metageneration: i64::try_from(object.metageneration).unwrap_or(i64::MAX),
        size: i64::try_from(object.size).unwrap_or(i64::MAX),
        time_created: timestamp(&object.time_created),
        updated: timestamp(&object.updated),
        md5_hash: object.md5_hash.clone(),
        crc32c: object.crc32c.to_string(),
        etag: object.etag.clone(),
        content_disposition: object.content_disposition.clone(),
        content_encoding: object.content_encoding.clone(),
        content_type: object.content_type.clone(),
        metadata: object
            .custom_metadata
            .iter()
            .filter(|(key, _)| key.as_str() != "firebaseStorageDownloadTokens")
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect(),
    }
}

/// `request.auth` from the `Authorization` header as the official emulator
/// derives it: the token is whatever follows the first space, decoded without
/// verification; `uid` is the `user_id` claim only; anything undecodable is
/// an anonymous request (storage-rules-v1 auth-shapes).
pub(crate) fn auth_from_authorization(authorization: Option<&str>) -> Option<Auth> {
    let token = authorization?.split(' ').nth(1)?;
    let payload = token.split('.').nth(1)?;
    let decoded = URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok()?;
    let JsonValue::Object(claims) = serde_json::from_slice::<JsonValue>(&decoded).ok()? else {
        return None;
    };
    let uid = claims
        .get("user_id")
        .and_then(JsonValue::as_str)
        .map(str::to_owned);
    Some(Auth {
        uid,
        token: claims
            .iter()
            .map(|(key, value)| (key.clone(), json_value(value)))
            .collect(),
    })
}

pub(crate) fn json_value(value: &JsonValue) -> Value {
    match value {
        JsonValue::Null => Value::Null,
        JsonValue::Bool(value) => Value::Bool(*value),
        JsonValue::Number(number) => number.as_i64().map_or_else(
            || Value::Float(number.as_f64().unwrap_or_default()),
            Value::Integer,
        ),
        JsonValue::String(value) => Value::String(value.clone()),
        JsonValue::Array(values) => Value::List(values.iter().map(json_value).collect()),
        JsonValue::Object(fields) => Value::Map(
            fields
                .iter()
                .map(|(key, value)| (key.clone(), json_value(value)))
                .collect(),
        ),
    }
}

/// Parses a `PUT /internal/setRules` body with the official emulator's
/// validation messages.
pub(crate) fn parse_set_rules(body: &JsonValue) -> Result<RulesSource, &'static str> {
    let files = body
        .get("rules")
        .and_then(|rules| rules.get("files"))
        .and_then(JsonValue::as_array)
        .filter(|files| !files.is_empty())
        .ok_or("Request body must include 'rules.files' array")?;
    let file = |value: &JsonValue| {
        Some(RulesFile {
            name: value.get("name")?.as_str()?.to_owned(),
            content: value.get("content")?.as_str()?.to_owned(),
        })
    };
    if let [single] = files.as_slice() {
        return file(single)
            .map(RulesSource::Single)
            .ok_or("Each member of 'rules.files' array must contain 'name' and 'content'");
    }
    let mut buckets = Vec::with_capacity(files.len());
    for value in files {
        let (Some(file), Some(bucket)) = (
            file(value),
            value.get("resource").and_then(JsonValue::as_str),
        ) else {
            return Err(
                "Each member of 'rules.files' array must contain 'name', 'content', and 'resource'",
            );
        };
        buckets.push(BucketRules {
            bucket: bucket.to_owned(),
            name: file.name,
            content: file.content,
        });
    }
    Ok(RulesSource::PerBucket(buckets))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn jwt(claims: &JsonValue) -> String {
        let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"none","typ":"JWT"}"#);
        let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(claims).expect("json"));
        format!("{header}.{payload}.")
    }

    #[test]
    fn uid_comes_from_user_id_only() {
        let both = jwt(&serde_json::json!({ "sub": "alice", "user_id": "alice" }));
        let auth = auth_from_authorization(Some(&format!("Bearer {both}"))).expect("auth");
        assert_eq!(auth.uid.as_deref(), Some("alice"));
        let sub_only = jwt(&serde_json::json!({ "sub": "subonly" }));
        let auth = auth_from_authorization(Some(&format!("Firebase {sub_only}"))).expect("auth");
        assert_eq!(auth.uid, None);
        assert_eq!(auth.token["sub"], Value::String("subonly".to_owned()));
    }

    #[test]
    fn undecodable_tokens_are_anonymous() {
        assert!(auth_from_authorization(None).is_none());
        assert!(auth_from_authorization(Some("Bearer")).is_none());
        assert!(auth_from_authorization(Some("Bearer not-a-jwt")).is_none());
        assert!(auth_from_authorization(Some("Basic YWxpY2U6c2VjcmV0")).is_none());
    }

    #[test]
    fn rules_paths_drop_empty_segments() {
        assert_eq!(rules_path("b", "a//c/"), "/b/b/o/a/c");
        assert_eq!(rules_path("b", ""), "/b/b/o");
        assert_eq!(rules_path("b", "users/alice"), "/b/b/o/users/alice");
    }

    #[test]
    fn set_rules_bodies_follow_the_recorded_messages() {
        assert_eq!(
            parse_set_rules(&serde_json::json!({ "rules": {} })).err(),
            Some("Request body must include 'rules.files' array")
        );
        assert_eq!(
            parse_set_rules(&serde_json::json!({ "rules": { "files": [] } })).err(),
            Some("Request body must include 'rules.files' array")
        );
        assert_eq!(
            parse_set_rules(&serde_json::json!({ "rules": { "files": [{ "name": "a" }] } })).err(),
            Some("Each member of 'rules.files' array must contain 'name' and 'content'")
        );
        assert_eq!(
            parse_set_rules(&serde_json::json!({ "rules": { "files": [
                { "name": "a", "content": "x" }, { "name": "b", "content": "y" }
            ] } }))
            .err(),
            Some(
                "Each member of 'rules.files' array must contain 'name', 'content', and 'resource'"
            )
        );
        assert!(matches!(
            parse_set_rules(
                &serde_json::json!({ "rules": { "files": [{ "name": "a", "content": "x" }] } })
            ),
            Ok(RulesSource::Single(_))
        ));
    }
}
