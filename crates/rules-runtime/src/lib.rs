//! Shared Security Rules loading, authentication, and snapshot policy runtime.

#![forbid(unsafe_code)]

use std::collections::BTreeMap;

pub mod coverage;
mod decision_tap;
mod deny_tap;
mod dry_run;
mod query;
mod request_event;
pub mod request_history;
mod retention;
mod versions;
pub use decision_tap::{DECISION_CAPACITY, RecordedDecision};
pub use deny_tap::{DENIAL_CAPACITY, Denial, DenialOrigin};
pub use dry_run::{
    DryRunError, DryRunOperation, DryRunRequest, DryRunRules, EvaluationAccess, PreparedRequest,
    prepare_dry_run,
};
pub use query::{query_candidate, query_policy};
pub use retention::{DecisionOutcome, RETAINED_BYTES, RETAINED_DECISIONS, RetainedDecision};
use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::sync::{Arc, Mutex, MutexGuard, RwLock, RwLockReadGuard, RwLockWriteGuard};
pub use versions::{InstalledVersion, MAXIMUM_VERSIONS, RulesEvent, RulesOrigin, source_hash};

use base64::Engine as _;
use base64::alphabet;
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use firenook_core_store::{
    DatabaseName, Document, DocumentKey, Snapshot, Timestamp as StoreTimestamp,
    Value as StoreValue, Write, WritePreview,
};
use firenook_rules_engine::{
    Auth, Diagnostic, DocumentAccess, DocumentAccessError, EvaluationRequest, Resource, Ruleset,
    Timestamp, Value, compile,
};
use serde_json::Value as JsonValue;

pub use firenook_rules_engine::{
    AtomicEvaluationResult, EvaluationResult, PRODUCTION_DENIAL, Query as RulesQuery,
    RefusingAllow, RequestOperation,
};

/// Owner/admin bypass token used by the emulator control plane and backend SDKs.
pub const OWNER_BEARER_TOKEN: &str = "Bearer owner";

const TOKEN_SEGMENT: GeneralPurposeConfig =
    GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent);
const TOKEN_URL_SAFE: GeneralPurpose = GeneralPurpose::new(&alphabet::URL_SAFE, TOKEN_SEGMENT);
const TOKEN_STANDARD: GeneralPurpose = GeneralPurpose::new(&alphabet::STANDARD, TOKEN_SEGMENT);

/// Atomically replaceable rulesets, resolved per database.
///
/// Production Firestore deploys Security Rules per database, so a lookup for
/// `projects/{project}/databases/{database}` resolves, in order:
///
/// 1. the ruleset installed for that exact database
///    ([`install_database`](Self::install_database), the suite's
///    `firebase.json` entries);
/// 2. the project-wide ruleset ([`install_project`](Self::install_project)),
///    which the emulator's `PUT /emulator/v1/projects/{project}:securityRules`
///    hot-reload route installs — that route stays project-wide, as the
///    official route is, and a hot reload replaces the project's rules
///    outright: it drops the database-specific rulesets installed at startup,
///    so a client reloading rules (rules unit testing) governs every database
///    of the project from then on, as on the official emulator;
/// 3. the ruleset of the project's stand-in database
///    ([`govern_unlisted_with`](Self::govern_unlisted_with)), for a database
///    `firebase.json` does not list: the official emulator applies its one
///    rules file to every database (`conformance/fixtures/request-identity-v1`);
/// 4. the startup default ([`install_default`](Self::install_default)).
///
/// No ruleset at any level is the emulator's explicit open-with-warning
/// mode.
///
/// Clones share everything. A handle made with
/// [`with_origin`](Self::with_origin) shares everything too, and reports the
/// requests it refuses as entering from that origin.
#[derive(Clone, Default)]
pub struct RulesRuntime {
    state: Arc<RwLock<RuntimeState>>,
    write_guard: Arc<Mutex<()>>,
    recorder: Option<request_event::RequestRecorder>,
    coverage: Option<Arc<coverage::CoverageStore>>,
    /// Install and rules-file notifications for the console's live view.
    events: versions::Events,
    /// Refused requests, for the console's log.
    tap: Arc<deny_tap::DenyTap>,
    /// Every recorded decision, for the console's decisions feed.
    decisions: Arc<decision_tap::DecisionTap>,
    /// Where the requests this handle evaluates entered.
    origin: DenialOrigin,
}

#[derive(Default)]
struct RuntimeState {
    default: Option<Arc<InstalledRules>>,
    projects: BTreeMap<String, Arc<InstalledRules>>,
    databases: BTreeMap<DatabaseName, Arc<InstalledRules>>,
    /// Per project, the database whose own ruleset governs the project's
    /// databases that have none.
    stand_ins: BTreeMap<String, DatabaseName>,
    /// What governed each database over time, and its rules file's problems.
    versions: versions::Versions,
}

impl RuntimeState {
    /// The level that governs `database`, as a database whose own entry to
    /// read: the database itself, or its project's stand-in when the
    /// database has no ruleset of its own.
    fn governed_as<'a>(&'a self, database: &'a DatabaseName) -> &'a DatabaseName {
        if self.databases.contains_key(database) {
            return database;
        }
        self.stand_ins
            .get(database.project_id())
            .filter(|stand_in| self.databases.contains_key(*stand_in))
            .unwrap_or(database)
    }
}

struct InstalledRules {
    rules: Arc<Ruleset>,
    source_hash: String,
}

impl InstalledRules {
    fn compile(source: &str) -> Result<Arc<Self>, LoadError> {
        Ok(Arc::new(Self {
            rules: Arc::new(compile(source).map_err(LoadError::new)?),
            source_hash: source_hash(source),
        }))
    }
}

impl RulesRuntime {
    /// Creates an opt-in diagnostic producer. Configure before sharing runtime
    /// clones; the ordinary default keeps the untraced evaluation path.
    #[must_use]
    pub fn with_request_history(history: request_history::RequestHistory) -> Self {
        Self {
            recorder: Some(request_event::RequestRecorder::new(history)),
            coverage: Some(Arc::new(coverage::CoverageStore::default())),
            ..Self::default()
        }
    }

    /// The history attached to this runtime's real evaluation producer.
    /// `None` means diagnostics are disabled, never a healthy empty feed.
    #[must_use]
    pub fn request_history(&self) -> Option<request_history::RequestHistory> {
        self.recorder
            .as_ref()
            .map(request_event::RequestRecorder::history)
    }

    /// Compiles and installs the startup ruleset used by databases without a
    /// ruleset of their own or a later project-wide hot reload.
    pub fn install_default(&self, source: &str) -> Result<(), LoadError> {
        let rules = InstalledRules::compile(source)?;
        let version = versions::version(&rules, RulesOrigin::Startup);
        {
            let mut state = write_lock(&self.state);
            state.default = Some(rules);
            state.record_default(&version);
        }
        self.events.installed(RulesOrigin::Startup);
        Ok(())
    }

    /// Compiles then atomically replaces one project's project-wide ruleset,
    /// the hot-reload route's level, displacing the project's
    /// database-specific rulesets. A failed compilation leaves every previous
    /// ruleset untouched.
    pub fn install_project(&self, project: &str, source: &str) -> Result<(), LoadError> {
        let rules = InstalledRules::compile(source)?;
        let version = versions::version(&rules, RulesOrigin::Reload);
        {
            let mut state = write_lock(&self.state);
            state
                .databases
                .retain(|database, _| database.project_id() != project);
            state.projects.insert(project.to_owned(), rules);
            state.record_project(project, &version);
        }
        self.events.installed(RulesOrigin::Reload);
        Ok(())
    }

    /// Compiles then atomically replaces the ruleset of one database, which
    /// takes precedence over the project-wide and default rulesets. A failed
    /// compilation leaves the previous ruleset untouched. Recorded as the
    /// startup configuration; [`install_database_from`](Self::install_database_from)
    /// names another origin.
    pub fn install_database(&self, database: &DatabaseName, source: &str) -> Result<(), LoadError> {
        self.install_database_from(database, source, RulesOrigin::Startup)
    }

    /// [`install_database`](Self::install_database), recording where the
    /// ruleset came from in the database's version history.
    pub fn install_database_from(
        &self,
        database: &DatabaseName,
        source: &str,
        origin: RulesOrigin,
    ) -> Result<(), LoadError> {
        let rules = InstalledRules::compile(source)?;
        let version = versions::version(&rules, origin);
        {
            let mut state = write_lock(&self.state);
            state.databases.insert(database.clone(), rules);
            state.record_database(database, &version);
        }
        self.events.installed(origin);
        Ok(())
    }

    /// Returns the immutable ruleset active for a database, or `None` for the
    /// emulator's explicit open-with-warning mode.
    #[must_use]
    pub fn rules_for(&self, database: &DatabaseName) -> Option<Arc<Ruleset>> {
        self.installed_for(database)
            .map(|installed| installed.rules.clone())
    }

    /// Serialize one database's bounded coverage without evaluating rules.
    /// Disabled, missing-source and contended diagnostics are explicit failures.
    ///
    /// # Errors
    /// Returns the relevant diagnostic error rather than a healthy empty report.
    pub fn coverage_json(
        &self,
        database: &DatabaseName,
    ) -> Result<Vec<u8>, coverage::CoverageError> {
        let coverage = self
            .coverage
            .as_ref()
            .ok_or(coverage::CoverageError::Disabled)?;
        let installed = self
            .installed_for(database)
            .ok_or(coverage::CoverageError::NoRules)?;
        coverage.report(&database.to_string(), &installed.rules)
    }

    fn installed_for(&self, database: &DatabaseName) -> Option<Arc<InstalledRules>> {
        let state = read_lock(&self.state);
        state
            .databases
            .get(database)
            .or_else(|| state.projects.get(database.project_id()))
            .or_else(|| state.databases.get(state.governed_as(database)))
            .or(state.default.as_ref())
            .cloned()
    }

    /// Makes `database`'s own ruleset govern every database of its project
    /// that has none, as the rules of a database `firebase.json` does not
    /// list. The stand-in follows that ruleset as it changes (a file reload,
    /// the console's editor); a project-wide reload still governs every
    /// database.
    pub fn govern_unlisted_with(&self, database: &DatabaseName) {
        write_lock(&self.state)
            .stand_ins
            .insert(database.project_id().to_owned(), database.clone());
        self.events.installed(RulesOrigin::Startup);
    }

    /// Serializes policy evaluation and installation of a store write across
    /// every frontend sharing this runtime.
    #[must_use]
    pub fn write_lock(&self) -> RulesWriteGuard<'_> {
        RulesWriteGuard(mutex_lock(&self.write_guard))
    }

    /// Evaluates one operation, returning an allow result immediately when no
    /// rules file is installed or the owner bypass is present.
    #[must_use]
    pub fn evaluate(
        &self,
        database: &DatabaseName,
        authorization: &Authorization,
        request: &EvaluationRequest,
        access: &SnapshotAccess,
    ) -> EvaluationResult {
        self.evaluate_with_read_transaction(database, authorization, request, access, false)
    }

    /// Evaluates once with the resolved transaction mode for diagnostic reads.
    /// The flag does not change policy, snapshots or access accounting.
    #[must_use]
    pub fn evaluate_with_read_transaction(
        &self,
        database: &DatabaseName,
        authorization: &Authorization,
        request: &EvaluationRequest,
        access: &SnapshotAccess,
        in_read_write_transaction: bool,
    ) -> EvaluationResult {
        let Some(installed) = self.installed_for(database) else {
            return allowed_result();
        };
        if authorization.is_owner() {
            return allowed_result();
        }
        let mut request = request.clone();
        request.auth = authorization.auth().cloned();
        let Some(recorder) = &self.recorder else {
            let result = installed.rules.evaluate(&request, access);
            self.tap
                .observe(self.origin, database, &request, &result, None);
            return result;
        };
        let mut coverage = self.coverage.as_ref().and_then(|coverage| {
            coverage.session(
                &database.to_string(),
                &installed.rules,
                AtomicContext {
                    in_read_write_transaction,
                    writes: None,
                },
            )
        });
        let (result, trace) = match coverage.as_mut() {
            Some(observer) => installed
                .rules
                .evaluate_with_coverage(&request, access, observer),
            None => installed.rules.evaluate_with_trace(&request, access),
        };
        drop(coverage);
        let event = recorder.record(
            database.project_id(),
            &installed,
            &request,
            &result,
            &trace,
            request_event::Metadata {
                in_read_write_transaction,
                write: None,
            },
        );
        self.tap
            .observe(self.origin, database, &request, &result, event.kept());
        self.decisions.observe(&decision_tap::Recorded {
            origin: self.origin,
            database,
            installed: &installed,
            request: &request,
            result: &result,
            trace: &trace,
            request_id: &event.id,
            retained: event.retained,
        });
        result
    }

    /// Evaluates one atomic write set with shared access accounting.
    #[must_use]
    pub fn evaluate_atomic(
        &self,
        database: &DatabaseName,
        authorization: &Authorization,
        requests: &[EvaluationRequest],
        access: &SnapshotAccess,
    ) -> firenook_rules_engine::AtomicEvaluationResult {
        self.evaluate_atomic_with_read_transaction(database, authorization, requests, access, false)
    }

    /// Shared-accounting read batch with its resolved transaction mode. A batch
    /// alone is not a transaction; read-only transactions also pass false.
    #[must_use]
    pub fn evaluate_atomic_with_read_transaction(
        &self,
        database: &DatabaseName,
        authorization: &Authorization,
        requests: &[EvaluationRequest],
        access: &SnapshotAccess,
        in_read_write_transaction: bool,
    ) -> AtomicEvaluationResult {
        self.evaluate_atomic_context(
            database,
            authorization,
            requests,
            access,
            AtomicContext {
                in_read_write_transaction,
                writes: None,
            },
        )
    }

    fn evaluate_atomic_context(
        &self,
        database: &DatabaseName,
        authorization: &Authorization,
        requests: &[EvaluationRequest],
        access: &SnapshotAccess,
        context: AtomicContext<'_>,
    ) -> AtomicEvaluationResult {
        let Some(installed) = self.installed_for(database) else {
            return firenook_rules_engine::AtomicEvaluationResult {
                allowed: true,
                operations: requests.iter().map(|_| allowed_result()).collect(),
                document_accesses: 0,
                document_cache_hits: 0,
            };
        };
        if authorization.is_owner() {
            return firenook_rules_engine::AtomicEvaluationResult {
                allowed: true,
                operations: requests.iter().map(|_| allowed_result()).collect(),
                document_accesses: 0,
                document_cache_hits: 0,
            };
        }
        let requests = requests
            .iter()
            .cloned()
            .map(|mut request| {
                request.auth = authorization.auth().cloned();
                request
            })
            .collect::<Vec<_>>();
        let Some(recorder) = &self.recorder else {
            let result = installed.rules.evaluate_atomic(&requests, access);
            if !result.allowed {
                for (request, operation) in requests.iter().zip(&result.operations) {
                    self.tap
                        .observe(self.origin, database, request, operation, None);
                }
            }
            return result;
        };
        let mut coverage = self.coverage.as_ref().and_then(|coverage| {
            coverage.session(&database.to_string(), &installed.rules, context)
        });
        let (result, traces) = match coverage.as_mut() {
            Some(observer) => installed
                .rules
                .evaluate_atomic_with_coverage(&requests, access, observer),
            None => installed
                .rules
                .evaluate_atomic_with_trace(&requests, access),
        };
        drop(coverage);
        for (index, ((request, operation), trace)) in requests
            .iter()
            .zip(&result.operations)
            .zip(&traces)
            .enumerate()
        {
            let event = recorder.record(
                database.project_id(),
                &installed,
                request,
                operation,
                trace,
                request_event::Metadata {
                    in_read_write_transaction: context.in_read_write_transaction,
                    write: context.writes.and_then(|writes| writes.get(index)),
                },
            );
            self.tap
                .observe(self.origin, database, request, operation, event.kept());
            self.decisions.observe(&decision_tap::Recorded {
                origin: self.origin,
                database,
                installed: &installed,
                request,
                result: operation,
                trace,
                request_id: &event.id,
                retained: event.retained,
            });
        }
        result
    }

    /// Evaluates a transaction or batch against the original snapshot and a
    /// complete non-mutating post-write preview.
    pub fn evaluate_writes(
        &self,
        database: &DatabaseName,
        authorization: &Authorization,
        writes: &[Write],
        snapshot: &Snapshot,
        time: StoreTimestamp,
    ) -> Result<AtomicEvaluationResult, firenook_core_store::CommitError> {
        if writes.is_empty() {
            return Ok(AtomicEvaluationResult {
                allowed: true,
                operations: Vec::new(),
                document_accesses: 0,
                document_cache_hits: 0,
            });
        }
        let preview = snapshot.preview_writes(writes, time)?;
        let access = SnapshotAccess {
            snapshot: snapshot.clone(),
            preview: Some(preview.clone()),
            project: database.project_id().to_owned(),
        };
        let requests = dry_run::write_requests(writes, snapshot, &preview, time);
        Ok(self.evaluate_atomic_context(
            database,
            authorization,
            &requests,
            &access,
            AtomicContext {
                in_read_write_transaction: false,
                writes: Some(writes),
            },
        ))
    }
}

#[derive(Clone, Copy)]
struct AtomicContext<'a> {
    in_read_write_transaction: bool,
    writes: Option<&'a [Write]>,
}

/// Held while one rules-protected write is evaluated and committed.
pub struct RulesWriteGuard<'a>(#[allow(dead_code)] MutexGuard<'a, ()>);

fn allowed_result() -> EvaluationResult {
    EvaluationResult {
        allowed: true,
        error: None,
        evaluated_expressions: 0,
        document_accesses: 0,
        document_cache_hits: 0,
        matching_allows: 0,
        refused_by: Vec::new(),
    }
}

/// A compilation failure suitable for startup or hot-reload diagnostics.
#[derive(Clone, Debug, PartialEq)]
pub struct LoadError {
    /// Stable compiler diagnostics in source order.
    pub diagnostics: Vec<Diagnostic>,
}

impl LoadError {
    fn new(diagnostics: Vec<Diagnostic>) -> Self {
        Self { diagnostics }
    }
}

impl Display for LoadError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        for (index, diagnostic) in self.diagnostics.iter().enumerate() {
            if index > 0 {
                formatter.write_str("; ")?;
            }
            write!(
                formatter,
                "{}:{}: {}",
                diagnostic.line, diagnostic.column, diagnostic.message
            )?;
        }
        Ok(())
    }
}

impl Error for LoadError {}

/// Authentication state for one emulated request.
#[derive(Clone, Debug, PartialEq)]
pub enum Authorization {
    /// Emulator administrator bypass.
    Owner,
    /// Authenticated or unauthenticated client evaluated by rules.
    Client(Option<Auth>),
}

impl Authorization {
    /// Reads an emulator Authorization header the way the official emulator
    /// does (`conformance/fixtures/request-identity-v1`). No header is a
    /// signed-out client. `Bearer owner`, in any letter case, is the
    /// administrator. Any other `Bearer` credential is an ID token whose
    /// claims are read, not verified: its times, its project (`aud`, `iss`),
    /// its algorithm and signature, and which claims it carries are not
    /// checked, so the token `@firebase/rules-unit-testing` mints at time 0
    /// is read like one the Auth emulator issued a second ago. `request.auth.uid`
    /// is the `sub` claim when it is a string, and null otherwise; the whole
    /// payload is `request.auth.token`.
    pub fn parse(header: Option<&str>) -> Result<Self, AuthorizationError> {
        let Some(header) = header else {
            return Ok(Self::Client(None));
        };
        if header.eq_ignore_ascii_case(OWNER_BEARER_TOKEN) {
            return Ok(Self::Owner);
        }
        let token = header
            .split_once(' ')
            .filter(|(scheme, _)| scheme.eq_ignore_ascii_case("Bearer"))
            .map(|(_, token)| token)
            .ok_or(AuthorizationError::MalformedBearer)?;
        let mut segments = token.split('.');
        let (Some(encoded_header), Some(encoded_payload), Some(_signature), None) = (
            segments.next(),
            segments.next(),
            segments.next(),
            segments.next(),
        ) else {
            return Err(AuthorizationError::MalformedJwt);
        };
        decode_json(encoded_header)?;
        let payload = decode_json(encoded_payload)?;
        let uid = payload
            .get("sub")
            .and_then(JsonValue::as_str)
            .map(str::to_owned);
        let token = payload
            .as_object()
            .ok_or(AuthorizationError::InvalidEncoding)?
            .iter()
            .map(|(name, value)| Ok((name.clone(), json_to_rules_value(value)?)))
            .collect::<Result<BTreeMap<_, _>, AuthorizationError>>()?;
        Ok(Self::Client(Some(Auth { uid, token })))
    }

    /// Whether this request bypasses Security Rules.
    #[must_use]
    pub const fn is_owner(&self) -> bool {
        matches!(self, Self::Owner)
    }

    /// Auth value exposed as `request.auth`.
    #[must_use]
    pub const fn auth(&self) -> Option<&Auth> {
        match self {
            Self::Owner | Self::Client(None) => None,
            Self::Client(Some(auth)) => Some(auth),
        }
    }
}

/// An Authorization header the emulator cannot read. Every front answers it
/// `INVALID_ARGUMENT`, as the official emulator answers an unreadable token
/// ("invalid jwt"): a code the SDKs do not retry, where `UNAUTHENTICATED`
/// would have them refresh a mock token that never changes, forever.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AuthorizationError {
    /// The header is not a `Bearer` credential.
    MalformedBearer,
    /// The token does not have exactly three dot-separated segments.
    MalformedJwt,
    /// The token's header or payload is not a base64 JSON object.
    InvalidEncoding,
}

impl Display for AuthorizationError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::MalformedBearer => {
                "invalid authorization: send `Bearer owner` or `Bearer <ID token>`"
            }
            Self::MalformedJwt => "invalid jwt: an ID token has three dot-separated segments",
            Self::InvalidEncoding => {
                "invalid jwt: an ID token's header and payload are base64 JSON objects"
            }
        })
    }
}

impl Error for AuthorizationError {}

/// One token segment: base64 in either alphabet, padded or not, as the
/// official emulator reads it, holding a JSON object.
fn decode_json(encoded: &str) -> Result<JsonValue, AuthorizationError> {
    let bytes = TOKEN_URL_SAFE
        .decode(encoded)
        .or_else(|_| TOKEN_STANDARD.decode(encoded))
        .map_err(|_| AuthorizationError::InvalidEncoding)?;
    let value: JsonValue =
        serde_json::from_slice(&bytes).map_err(|_| AuthorizationError::InvalidEncoding)?;
    if value.is_object() {
        Ok(value)
    } else {
        Err(AuthorizationError::InvalidEncoding)
    }
}

fn json_to_rules_value(value: &JsonValue) -> Result<Value, AuthorizationError> {
    match value {
        JsonValue::Null => Ok(Value::Null),
        JsonValue::Bool(value) => Ok(Value::Bool(*value)),
        JsonValue::Number(value) => value
            .as_i64()
            .map(Value::Integer)
            .or_else(|| value.as_f64().map(Value::Float))
            .ok_or(AuthorizationError::InvalidEncoding),
        JsonValue::String(value) => Ok(Value::String(value.clone())),
        JsonValue::Array(values) => values
            .iter()
            .map(json_to_rules_value)
            .collect::<Result<Vec<_>, _>>()
            .map(Value::List),
        JsonValue::Object(values) => values
            .iter()
            .map(|(name, value)| Ok((name.clone(), json_to_rules_value(value)?)))
            .collect::<Result<BTreeMap<_, _>, _>>()
            .map(Value::Map),
    }
}

/// Current and post-write snapshots exposed to rule document access calls.
#[derive(Clone, Debug)]
pub struct SnapshotAccess {
    snapshot: Snapshot,
    preview: Option<WritePreview>,
    project: String,
}

impl SnapshotAccess {
    /// Creates read-only access where `getAfter()` equals the current snapshot.
    #[must_use]
    pub fn current(snapshot: Snapshot, project: impl Into<String>) -> Self {
        Self {
            snapshot,
            preview: None,
            project: project.into(),
        }
    }

    /// Creates access with one atomic pending write set.
    pub fn with_writes(
        snapshot: Snapshot,
        writes: &[Write],
        request_time: StoreTimestamp,
    ) -> Result<Self, firenook_core_store::CommitError> {
        let preview = snapshot.preview_writes(writes, request_time)?;
        let project = writes
            .first()
            .map(write_key)
            .map_or_else(String::new, |key| key.database().project_id().to_owned());
        Ok(Self {
            snapshot,
            preview: Some(preview),
            project,
        })
    }
}

impl DocumentAccess for SnapshotAccess {
    fn get(&self, path: &str) -> Result<Option<Resource>, DocumentAccessError> {
        let key = parse_document_path(&self.project, path)?;
        Ok(self
            .snapshot
            .get(&key)
            .as_deref()
            .map(|document| resource(&key, document)))
    }

    fn get_after(&self, path: &str) -> Result<Option<Resource>, DocumentAccessError> {
        let key = parse_document_path(&self.project, path)?;
        let document = self
            .preview
            .as_ref()
            .map_or_else(|| self.snapshot.get(&key), |preview| preview.get(&key));
        Ok(document.as_deref().map(|document| resource(&key, document)))
    }
}

/// Builds one evaluator request from a store key and current/proposed state.
#[must_use]
pub fn evaluation_request(
    operation: RequestOperation,
    key: &DocumentKey,
    time: StoreTimestamp,
    current: Option<&Document>,
    proposed: Option<&Document>,
    query: RulesQuery,
) -> EvaluationRequest {
    let mut request = EvaluationRequest::new(operation, rules_path(key), rules_timestamp(time));
    request.resource = current.map(|document| resource(key, document));
    request.request_resource = proposed.map(|document| resource(key, document));
    request.query = query;
    if operation == RequestOperation::List && current.is_none() && request.query.scope.is_none() {
        request.query.scope = key.path().rsplit_once('/').map(|(collection, _)| {
            firenook_rules_engine::QueryScope::Collection(collection.to_owned())
        });
    }
    request
}

/// Converts a canonical store key into the path shape used by Rules matches.
#[must_use]
pub fn rules_path(key: &DocumentKey) -> String {
    format!(
        "/databases/{}/documents/{}",
        key.database().database_id(),
        key.path()
    )
}

/// Returns the operation and key associated with a store write.
#[must_use]
pub fn write_operation(write: &Write, snapshot: &Snapshot) -> (RequestOperation, DocumentKey) {
    match write {
        Write::Create { key, .. } => (RequestOperation::Create, key.clone()),
        Write::Set { key, .. } | Write::Patch { key, .. } => (
            if snapshot.get(key).is_some() {
                RequestOperation::Update
            } else {
                RequestOperation::Create
            },
            key.clone(),
        ),
        Write::Delete { key, .. } => (RequestOperation::Delete, key.clone()),
        Write::Verify { key, .. } => (RequestOperation::Get, key.clone()),
    }
}

fn write_key(write: &Write) -> &DocumentKey {
    match write {
        Write::Create { key, .. }
        | Write::Set { key, .. }
        | Write::Patch { key, .. }
        | Write::Delete { key, .. }
        | Write::Verify { key, .. } => key,
    }
}

fn parse_document_path(project: &str, path: &str) -> Result<DocumentKey, DocumentAccessError> {
    let path = path.strip_prefix("/databases/").ok_or_else(|| {
        DocumentAccessError::new("rules document path must begin with /databases/")
    })?;
    let (database, document) = path
        .split_once("/documents/")
        .ok_or_else(|| DocumentAccessError::new("rules document path must contain /documents/"))?;
    DocumentKey::new(
        DatabaseName::new(project, database)
            .map_err(|error| DocumentAccessError::new(error.to_string()))?,
        document,
    )
    .map_err(|error| DocumentAccessError::new(error.to_string()))
}

fn resource(key: &DocumentKey, document: &Document) -> Resource {
    Resource {
        name: key.to_string(),
        data: document
            .fields()
            .iter()
            .map(|(name, value)| (name.clone(), store_value(value)))
            .collect(),
        create_time: Some(rules_timestamp(document.create_time())),
        update_time: Some(rules_timestamp(document.update_time())),
    }
}

fn store_value(value: &StoreValue) -> Value {
    match value {
        StoreValue::Null => Value::Null,
        StoreValue::Boolean(value) => Value::Bool(*value),
        StoreValue::Integer(value) => Value::Integer(*value),
        StoreValue::Double(value) => Value::Float(*value),
        StoreValue::Timestamp(value) => Value::Timestamp(rules_timestamp(*value)),
        StoreValue::String(value) => Value::String(value.to_string()),
        StoreValue::Bytes(value) => Value::Bytes(value.to_vec()),
        StoreValue::Reference(value) => Value::Path(value.to_string()),
        StoreValue::GeoPoint {
            latitude,
            longitude,
        } => Value::LatLng(firenook_rules_engine::LatLng {
            latitude: *latitude,
            longitude: *longitude,
        }),
        StoreValue::Array(values) => Value::List(values.iter().map(store_value).collect()),
        StoreValue::Map(values) => Value::Map(
            values
                .iter()
                .map(|(name, value)| (name.clone(), store_value(value)))
                .collect(),
        ),
        StoreValue::Vector(values) => {
            Value::List(values.iter().copied().map(Value::Float).collect())
        }
    }
}

const fn rules_timestamp(value: StoreTimestamp) -> Timestamp {
    Timestamp::new(value.seconds(), value.nanos())
}

fn read_lock<T>(lock: &RwLock<T>) -> RwLockReadGuard<'_, T> {
    lock.read()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn write_lock<T>(lock: &RwLock<T>) -> RwLockWriteGuard<'_, T> {
    lock.write()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn mutex_lock<T>(lock: &Mutex<T>) -> MutexGuard<'_, T> {
    lock.lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use firenook_core_store::{Fields, Precondition, Store, StoreOptions};
    use serde_json::json;

    const PROJECT: &str = "demo-rules";

    fn database(id: &str) -> DatabaseName {
        DatabaseName::new(PROJECT, id).expect("database")
    }

    #[test]
    fn invalid_reload_keeps_the_previous_ruleset() {
        let runtime = RulesRuntime::default();
        runtime
            .install_project(PROJECT, rules("true"))
            .expect("valid rules");
        let before = runtime
            .rules_for(&database("(default)"))
            .expect("installed rules");
        assert!(runtime.install_project(PROJECT, "broken").is_err());
        let after = runtime
            .rules_for(&database("(default)"))
            .expect("previous rules");
        assert!(Arc::ptr_eq(&before, &after));
    }

    #[test]
    fn database_rules_beat_project_rules_which_beat_the_default() {
        let runtime = RulesRuntime::default();
        let other = database("other");
        let default = database("(default)");
        let foreign = DatabaseName::new("demo-elsewhere", "other").expect("database");
        assert!(runtime.rules_for(&other).is_none());

        runtime.install_default(rules("true")).expect("default");
        let installed_default = runtime.rules_for(&other).expect("default rules");
        assert!(Arc::ptr_eq(
            &installed_default,
            &runtime.rules_for(&default).expect("default rules")
        ));

        runtime
            .install_project(PROJECT, rules("false"))
            .expect("project");
        let project_wide = runtime.rules_for(&other).expect("project rules");
        assert!(!Arc::ptr_eq(&project_wide, &installed_default));
        assert!(Arc::ptr_eq(
            &project_wide,
            &runtime.rules_for(&default).expect("project rules")
        ));
        assert!(Arc::ptr_eq(
            &installed_default,
            &runtime.rules_for(&foreign).expect("default rules")
        ));

        runtime
            .install_database(&other, rules("true"))
            .expect("database");
        let database_specific = runtime.rules_for(&other).expect("database rules");
        assert!(!Arc::ptr_eq(&database_specific, &project_wide));
        assert!(Arc::ptr_eq(
            &project_wide,
            &runtime.rules_for(&default).expect("project rules")
        ));
        assert!(runtime.install_database(&other, "broken").is_err());
        assert!(Arc::ptr_eq(
            &database_specific,
            &runtime.rules_for(&other).expect("database rules")
        ));
        // A project-wide hot reload replaces the project's rules for every
        // database, as on the official emulator; a failed reload changes nothing.
        assert!(runtime.install_project(PROJECT, "broken").is_err());
        assert!(Arc::ptr_eq(
            &database_specific,
            &runtime.rules_for(&other).expect("database rules")
        ));
        runtime
            .install_project(PROJECT, rules("false"))
            .expect("project again");
        let reloaded = runtime.rules_for(&other).expect("reloaded rules");
        assert!(!Arc::ptr_eq(&reloaded, &database_specific));
        assert!(Arc::ptr_eq(
            &reloaded,
            &runtime.rules_for(&default).expect("reloaded rules")
        ));
    }

    #[test]
    fn evaluation_resolves_the_ruleset_of_the_requested_database() {
        let runtime = RulesRuntime::default();
        runtime.install_default(rules("false")).expect("default");
        runtime
            .install_database(&database("other"), rules("true"))
            .expect("database");
        let store = Store::new(StoreOptions::default());
        let access = SnapshotAccess::current(store.snapshot(), PROJECT);
        let authorization = Authorization::Client(None);
        for (database, path, allowed) in [
            (
                database("other"),
                "/databases/other/documents/items/one",
                true,
            ),
            (
                database("(default)"),
                "/databases/(default)/documents/items/one",
                false,
            ),
        ] {
            let request = EvaluationRequest::new(
                RequestOperation::Get,
                path,
                Timestamp::new(1_788_200_100, 0),
            );
            assert_eq!(
                runtime
                    .evaluate(&database, &authorization, &request, &access)
                    .allowed,
                allowed,
                "{database}"
            );
            assert_eq!(
                runtime
                    .evaluate_atomic(
                        &database,
                        &authorization,
                        std::slice::from_ref(&request),
                        &access
                    )
                    .allowed,
                allowed,
                "{database}"
            );
        }
    }

    fn token(header: &JsonValue, payload: &JsonValue) -> String {
        format!(
            "Bearer {}.{}.",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(header).expect("json")),
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(payload).expect("json"))
        )
    }

    fn uid(header: &str) -> Option<String> {
        Authorization::parse(Some(header))
            .expect("readable token")
            .auth()
            .expect("signed in")
            .uid
            .clone()
    }

    /// `conformance/fixtures/request-identity-v1`: the official emulator
    /// reads a token's claims and checks none of them.
    #[test]
    fn reads_tokens_as_the_official_emulator_does() {
        let unsigned = json!({"alg": "none", "type": "JWT"});
        let mock = |issued_at: i64, project: &str| {
            json!({
                "aud": project, "iss": format!("https://securetoken.google.com/{project}"),
                "iat": issued_at, "exp": issued_at + 3600, "auth_time": issued_at,
                "sub": "alice", "user_id": "alice", "role": "editor",
                "firebase": {"sign_in_provider": "custom", "identities": {}}
            })
        };
        // What `createMockUserToken` builds without an `iat`: issued at 0,
        // expired at 3600. A day in the future and another project read alike.
        for payload in [
            mock(0, PROJECT),
            mock(1_788_200_100 + 86_400, PROJECT),
            mock(1_788_200_100, "demo-other-project"),
            json!({"sub": "alice"}),
        ] {
            assert_eq!(uid(&token(&unsigned, &payload)).as_deref(), Some("alice"));
        }
        let parsed =
            Authorization::parse(Some(&token(&unsigned, &mock(0, PROJECT)))).expect("mock");
        assert_eq!(
            parsed.auth().expect("auth").token.get("role"),
            Some(&Value::String("editor".to_owned()))
        );
        // `uid` is `sub` alone: never `user_id`, null for a number.
        assert_eq!(uid(&token(&unsigned, &json!({"user_id": "alice"}))), None);
        assert_eq!(uid(&token(&unsigned, &json!({"sub": 7}))), None);
        assert_eq!(uid(&token(&unsigned, &json!({}))), None);
        // No algorithm, a signature nobody checks, standard padded base64
        // and a lowercase scheme are all read.
        assert_eq!(
            uid(&token(&json!({}), &json!({"sub": "alice"}))).as_deref(),
            Some("alice")
        );
        let signed = format!(
            "{}c2lnbmF0dXJl",
            token(&json!({"alg": "RS256", "kid": "x"}), &mock(0, PROJECT))
        );
        assert_eq!(uid(&signed).as_deref(), Some("alice"));
        let padded = format!(
            "Bearer {}.{}.",
            base64::engine::general_purpose::STANDARD.encode(br#"{"alg":"none"}"#),
            base64::engine::general_purpose::STANDARD.encode(br#"{"sub":"alice"}"#)
        );
        assert!(padded.contains('='));
        assert_eq!(uid(&padded).as_deref(), Some("alice"));
        assert_eq!(
            uid(&token(&unsigned, &json!({"sub": "alice"})).replacen("Bearer", "bearer", 1))
                .as_deref(),
            Some("alice")
        );
        for owner in [
            "Bearer owner",
            "bearer owner",
            "BEARER OWNER",
            "Bearer Owner",
        ] {
            assert_eq!(
                Authorization::parse(Some(owner)),
                Ok(Authorization::Owner),
                "{owner}"
            );
        }
        assert_eq!(Authorization::parse(None), Ok(Authorization::Client(None)));
    }

    #[test]
    fn refuses_what_is_not_a_bearer_token() {
        let two_segments = token(&json!({"alg": "none"}), &json!({"sub": "alice"}));
        let two_segments = two_segments.trim_end_matches('.');
        for (header, error) in [
            (
                "Basic YWxpY2U6c2VjcmV0",
                AuthorizationError::MalformedBearer,
            ),
            ("Firebase owner", AuthorizationError::MalformedBearer),
            ("Bearer", AuthorizationError::MalformedBearer),
            ("Bearer not-a-jwt", AuthorizationError::MalformedJwt),
            ("Bearer  owner", AuthorizationError::MalformedJwt),
            ("Bearer ", AuthorizationError::MalformedJwt),
            (two_segments, AuthorizationError::MalformedJwt),
            ("Bearer a.b.c.d", AuthorizationError::MalformedJwt),
            ("Bearer !!!.e30.", AuthorizationError::InvalidEncoding),
        ] {
            assert_eq!(Authorization::parse(Some(header)), Err(error), "{header}");
        }
        let array = token(&json!({"alg": "none"}), &json!(["alice"]));
        assert_eq!(
            Authorization::parse(Some(&array)),
            Err(AuthorizationError::InvalidEncoding)
        );
    }

    #[test]
    fn get_after_reads_the_complete_pending_write_set() {
        let store = Store::new(StoreOptions::default());
        let database = DatabaseName::new(PROJECT, "(default)").expect("database");
        let key = DocumentKey::new(database, "items/one").expect("key");
        store
            .commit(&[Write::Create {
                key: key.clone(),
                fields: Fields::from([("value".to_owned(), StoreValue::Integer(1))]),
            }])
            .expect("seed");
        let snapshot = store.snapshot();
        let time = StoreTimestamp::new(1_788_200_100, 0).expect("time");
        let access = SnapshotAccess::with_writes(
            snapshot,
            &[Write::Set {
                key: key.clone(),
                fields: Fields::from([("value".to_owned(), StoreValue::Integer(2))]),
                transforms: Vec::new(),
                precondition: Precondition::None,
            }],
            time,
        )
        .expect("preview");
        let before = access.get(&rules_path(&key)).expect("before").expect("doc");
        let after = access
            .get_after(&rules_path(&key))
            .expect("after")
            .expect("doc");
        assert_eq!(before.data.get("value"), Some(&Value::Integer(1)));
        assert_eq!(after.data.get("value"), Some(&Value::Integer(2)));
        assert_eq!(
            store.snapshot().get(&key).expect("stored").fields(),
            &Fields::from([("value".to_owned(), StoreValue::Integer(1))])
        );
    }

    fn rules(condition: &str) -> &str {
        match condition {
            "true" => {
                "rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /{document=**} { allow read, write: if true; } } }"
            }
            "false" => {
                "rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /{document=**} { allow read, write: if false; } } }"
            }
            _ => unreachable!(),
        }
    }
}
