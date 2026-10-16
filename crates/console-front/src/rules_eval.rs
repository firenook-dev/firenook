//! Rules you can question: a dry-run playground, the explanation behind a
//! recorded decision, and what a draft would change about recent traffic.
//!
//! The Requests feed says a request was denied and on which line. That is
//! where debugging starts, not where it ends: the question is which value
//! made the condition false. These routes answer it by evaluating again with
//! an explanation — every expression the decision executed, in order, with
//! the value it produced — against either the ruleset that made a recorded
//! decision or a draft that is not in force yet.
//!
//! Nothing here commits, records a Requests event or feeds coverage. A dry
//! run builds its evaluator request through the same code the REST front
//! builds a real one with (the document key, a non-mutating write preview,
//! the decoded structured query), so its verdict is the one a client would
//! get; only a replay of a recorded decision substitutes the document it
//! recorded for the store's current one.
//!
//! Rendered values follow the rules language: `null`, `true`, `42`, `1.0`,
//! `"text"`, `[1, 2]`, `{plan: "pro", seats: 11}`, timestamps in RFC 3339,
//! paths as `/databases/(default)/documents/users/u1`, `request.auth` as
//! `{uid: "u1", token: {…}}`, a document as `resource(users/u1)`, and, inside
//! a list proof, what the query guarantees: `query: owner == "u1"`,
//! `query: owner unconstrained`, `query: unproven`.

use std::collections::BTreeMap;
use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, State};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use firenook_core_store::{DatabaseName, DocumentKey, Store, Timestamp as StoreTimestamp};
use firenook_rules_engine::{
    AllowDecision, Auth, ConstraintOperator, EvaluationExplanation, EvaluationRequest,
    EvaluationResult, QueryFilter, QueryScope, RequestOperation, Resource, Timestamp, Value,
};
use firenook_rules_runtime::{
    Authorization, DecisionOutcome, DryRunOperation, DryRunRequest, DryRunRules, RetainedDecision,
    RulesRuntime, prepare_dry_run,
};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value as JsonValue, json};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use ts_rs::TS;

use crate::api_error::ApiError;

/// Requests one dry run may carry.
const MAX_REQUESTS: usize = 200;

/// The largest draft accepted, as `PUT /rules` limits a ruleset.
const MAX_SOURCE_BYTES: usize = 256 * 1024;

/// Per-operation `get()`/`exists()` budget. Every dry run and every re-run
/// evaluates one operation alone, so this is the limit that applied to it.
const DOCUMENT_ACCESS_LIMIT: usize = 10;

/// A Firestore REST `Value`, for the generated TypeScript only: the wire
/// carries the protocol's own JSON, which this type describes.
#[derive(TS)]
#[ts(rename_all = "camelCase")]
// Never constructed, and its field names are the protocol's.
#[allow(dead_code, clippy::struct_field_names)]
pub struct FirestoreRestValue {
    #[ts(optional)]
    null_value: Option<()>,
    #[ts(optional)]
    boolean_value: Option<bool>,
    /// A decimal string on the wire.
    #[ts(optional, type = "string | number")]
    integer_value: Option<String>,
    /// `"NaN"`, `"Infinity"` and `"-Infinity"` travel as strings.
    #[ts(optional, type = "number | string")]
    double_value: Option<f64>,
    /// RFC 3339.
    #[ts(optional)]
    timestamp_value: Option<String>,
    #[ts(optional)]
    string_value: Option<String>,
    /// Base64.
    #[ts(optional)]
    bytes_value: Option<String>,
    /// `projects/{p}/databases/{d}/documents/…`.
    #[ts(optional)]
    reference_value: Option<String>,
    #[ts(optional)]
    geo_point_value: Option<FirestoreGeoPoint>,
    #[ts(optional)]
    array_value: Option<FirestoreArrayValue>,
    #[ts(optional)]
    map_value: Option<FirestoreMapValue>,
}

/// `geoPointValue`.
#[derive(TS)]
#[allow(dead_code)]
pub(crate) struct FirestoreGeoPoint {
    latitude: f64,
    longitude: f64,
}

/// `arrayValue`.
#[derive(TS)]
#[allow(dead_code)]
pub(crate) struct FirestoreArrayValue {
    #[ts(optional)]
    values: Option<Vec<FirestoreRestValue>>,
}

/// `mapValue`.
#[derive(TS)]
#[allow(dead_code)]
pub(crate) struct FirestoreMapValue {
    #[ts(optional)]
    fields: Option<BTreeMap<String, FirestoreRestValue>>,
}

/// REST typed `fields`.
type RestFields = Map<String, JsonValue>;

/// An operation the rules distinguish.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum RulesMethod {
    Get,
    List,
    Create,
    Update,
    Delete,
}

/// What a decision came to, as the Requests feed names it.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum RulesOutcome {
    Allow,
    Deny,
    Error,
}

impl From<DecisionOutcome> for RulesOutcome {
    fn from(outcome: DecisionOutcome) -> Self {
        match outcome {
            DecisionOutcome::Allow => Self::Allow,
            DecisionOutcome::Deny => Self::Deny,
            DecisionOutcome::Error => Self::Error,
        }
    }
}

/// `request.auth` given directly instead of as a token.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, TS)]
pub struct EvaluateAuth {
    pub uid: String,
    /// Plain JSON claims, exactly as `request.auth.token` exposes them.
    #[ts(type = "Record<string, unknown>")]
    pub token: Map<String, JsonValue>,
}

/// One `orderBy` entry, in the REST structured-query shape.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, TS)]
pub struct EvaluateOrder {
    pub field: EvaluateFieldReference,
    /// `ASCENDING` when absent.
    #[ts(optional, type = "'ASCENDING' | 'DESCENDING'")]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub direction: Option<String>,
}

/// `{ fieldPath }`.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct EvaluateFieldReference {
    pub field_path: String,
}

/// The query a list runs, in the REST structured-query shapes.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct EvaluateQuery {
    /// A REST `Filter`: `fieldFilter`, `unaryFilter` or `compositeFilter`.
    #[serde(rename = "where", default, skip_serializing_if = "Option::is_none")]
    #[ts(rename = "where", optional, type = "unknown")]
    pub filter: Option<JsonValue>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub order_by: Option<Vec<EvaluateOrder>>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub limit: Option<u32>,
}

/// One request to evaluate. The playground leaves `resource` and `time` out;
/// a [`DecisionDetail`] fills them so the request replays exactly as it was
/// recorded.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct EvaluateRequest {
    pub method: RulesMethod,
    /// Relative: `users/u1` (a document) or, for a list, `users/u1/orders`
    /// (a collection).
    pub path: String,
    /// List only: a collection-group query over the last segment's id, below
    /// the rest of the path.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub group: Option<bool>,
    /// An `Authorization` header value, parsed exactly as a real request's
    /// (unsigned emulator tokens). The owner credential skips the rules and
    /// is refused.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub authorization: Option<String>,
    /// `request.auth` directly; the alternative to `authorization`.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub auth: Option<EvaluateAuth>,
    /// Create: the new document. Update: top-level keys set over the
    /// existing document.
    #[serde(default)]
    #[ts(optional = nullable, as = "Option<BTreeMap<String, FirestoreRestValue>>")]
    pub data: Option<RestFields>,
    /// Update only: top-level keys the update deletes.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub remove_keys: Option<Vec<String>>,
    /// List only.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub query: Option<EvaluateQuery>,
    /// Replay: the document before, as recorded (`null`: it did not exist).
    /// Absent reads the store now.
    #[serde(default, skip_serializing_if = "RecordedResource::reads_store")]
    #[ts(optional = nullable, as = "Option<BTreeMap<String, FirestoreRestValue>>")]
    pub resource: RecordedResource,
    /// Replay: `request.time`, RFC 3339. Absent is now.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub time: Option<String>,
}

/// A replay's `resource`, where `null` and absent mean different things: a
/// document that did not exist when the decision was made, or "read the
/// store now".
#[derive(Clone, Debug, Default, PartialEq)]
pub enum RecordedResource {
    /// Absent: the document is read from the store.
    #[default]
    ReadStore,
    /// `null`: the document did not exist.
    Missing,
    /// The document's fields as recorded.
    Fields(RestFields),
}

impl RecordedResource {
    const fn reads_store(&self) -> bool {
        matches!(self, Self::ReadStore)
    }
}

impl Serialize for RecordedResource {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::ReadStore | Self::Missing => serializer.serialize_none(),
            Self::Fields(fields) => fields.serialize(serializer),
        }
    }
}

impl<'de> Deserialize<'de> for RecordedResource {
    // Only called when the field is present; `#[serde(default)]` covers absent.
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Ok(Option::<RestFields>::deserialize(deserializer)?.map_or(Self::Missing, Self::Fields))
    }
}

/// `POST /rules/evaluate`.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RulesEvaluateBody {
    #[serde(default)]
    #[ts(optional = nullable)]
    pub database: Option<String>,
    /// A draft to evaluate against; absent evaluates the rules in force.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub source: Option<String>,
    pub requests: Vec<EvaluateRequest>,
}

/// `POST /rules/impact`.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RulesImpactBody {
    #[serde(default)]
    #[ts(optional = nullable)]
    pub database: Option<String>,
    pub source: String,
}

/// Every result of one dry run, in request order.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RulesEvaluation {
    pub results: Vec<EvaluateResult>,
}

/// One allow condition the evaluator ran.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AllowTrace {
    /// One-based line of the condition.
    #[ts(type = "number")]
    pub line: usize,
    /// UTF-16 offset where the condition starts.
    #[ts(type = "number")]
    pub from: usize,
    /// UTF-16 offset where it ends (exclusive); equal to `from` for
    /// `allow read;`.
    #[ts(type = "number")]
    pub to: usize,
    pub outcome: RulesOutcome,
}

/// One executed expression and its value.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ExplainStep {
    #[ts(type = "number")]
    pub from: usize,
    #[ts(type = "number")]
    pub to: usize,
    #[ts(type = "number")]
    pub line: usize,
    /// The value in the rules notation, at most 160 characters (a longer one
    /// ends in `…`), or the error message when `error` is set.
    pub value: String,
    pub error: bool,
}

/// One request's verdict and why.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct EvaluateResult {
    pub outcome: RulesOutcome,
    /// The evaluator's error when the outcome is `error`, or why the
    /// operation could not reach the rules (a create of a document that
    /// exists, an update of one that does not).
    pub error: Option<String>,
    /// Every allow condition executed, in order.
    pub allows: Vec<AllowTrace>,
    /// Executed expressions in evaluation order, operands first; at most 400.
    pub explanation: Vec<ExplainStep>,
    /// More expressions ran than `explanation` holds.
    pub truncated: bool,
    /// `get()`/`exists()` reads charged.
    #[ts(type = "number")]
    pub document_accesses: usize,
    #[ts(type = "number")]
    pub document_cache_hits: usize,
    #[ts(type = "number")]
    pub document_access_limit: usize,
    /// A denied list: what the query must filter on for the rules to hold
    /// for every result.
    pub query_reason: Option<String>,
    /// The document before.
    #[ts(as = "Option<BTreeMap<String, FirestoreRestValue>>")]
    pub resource: Option<RestFields>,
    /// The document after; writes only.
    #[ts(as = "Option<BTreeMap<String, FirestoreRestValue>>")]
    pub request_resource: Option<RestFields>,
    /// Update only: top-level keys added, removed or changed.
    pub changed_keys: Option<Vec<String>>,
}

/// A recorded decision, explained by re-running it.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DecisionDetail {
    pub request_id: String,
    pub recorded_outcome: RulesOutcome,
    /// The re-run against the ruleset that decided it, reading the current
    /// store for `get()`/`exists()`.
    pub result: EvaluateResult,
    /// The source that decided it; positions refer to this text.
    pub rules: String,
    pub rules_hash: String,
    /// The request, replayable through `POST /rules/evaluate`.
    pub request: EvaluateRequest,
}

/// What a draft would change about the retained decisions.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RulesImpact {
    /// Retained decisions of the database, all re-evaluated.
    #[ts(type = "number")]
    pub considered: usize,
    /// Only the decisions whose outcome the draft changes.
    pub flips: Vec<ImpactFlip>,
}

/// One decision a draft would decide differently.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ImpactFlip {
    pub request_id: String,
    pub method: RulesMethod,
    pub path: String,
    pub uid: Option<String>,
    /// Under the rules that decided it, re-run now.
    pub before: RulesOutcome,
    /// Under the draft.
    pub after: RulesOutcome,
    /// `request.time`, RFC 3339.
    pub time: String,
}

/// Dry runs, decision details and impact for one project's databases.
#[derive(Clone)]
pub struct RulesEvaluator {
    rules: RulesRuntime,
    store: Store,
    project: Arc<str>,
}

impl RulesEvaluator {
    /// An evaluator over `project`'s store and the runtime every front
    /// evaluates against.
    #[must_use]
    pub fn new(rules: &RulesRuntime, store: &Store, project: &str) -> Self {
        Self {
            rules: rules.clone(),
            store: store.clone(),
            project: Arc::from(project),
        }
    }

    /// The runtime every front evaluates against, whose recorded decisions
    /// these routes explain.
    pub(crate) const fn runtime(&self) -> &RulesRuntime {
        &self.rules
    }

    pub(crate) fn router(self) -> axum::Router {
        axum::Router::new()
            .route("/rules/evaluate", axum::routing::post(evaluate))
            .route(
                "/rules/decisions/{request_id}",
                axum::routing::get(decision),
            )
            .route("/rules/impact", axum::routing::post(impact))
            .with_state(self)
    }

    fn database(&self, database_id: Option<&str>) -> Result<DatabaseName, ApiError> {
        DatabaseName::new(self.project.as_ref(), database_id.unwrap_or("(default)"))
            .map_err(|error| ApiError::invalid(error.to_string()))
    }

    fn rules(&self, database: &DatabaseName, draft: Option<&str>) -> Result<DryRunRules, ApiError> {
        if draft.is_some_and(|source| source.len() > MAX_SOURCE_BYTES) {
            return Err(ApiError::invalid(format!(
                "a ruleset is at most {MAX_SOURCE_BYTES} bytes"
            )));
        }
        self.rules
            .dry_run_rules(database, draft)
            .map_err(|error| draft_not_compiled(&crate::rules::diagnostics(&error)))
    }

    fn evaluate(&self, body: &RulesEvaluateBody) -> Result<RulesEvaluation, ApiError> {
        if body.requests.len() > MAX_REQUESTS {
            return Err(ApiError::invalid(format!(
                "a dry run carries at most {MAX_REQUESTS} requests"
            )));
        }
        let database = self.database(body.database.as_deref())?;
        let rules = self.rules(&database, body.source.as_deref())?;
        let decoded = body
            .requests
            .iter()
            .enumerate()
            .map(|(index, request)| {
                self.decode(&database, request)
                    .map_err(|message| ApiError::invalid(format!("requests[{index}]: {message}")))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let snapshot = self.store.snapshot();
        let explainer = rules
            .ruleset()
            .map(firenook_rules_engine::Ruleset::explainer);
        let results = decoded
            .into_iter()
            .map(|request| {
                let method = request.method;
                match prepare_dry_run(&snapshot, request.dry_run) {
                    Ok(prepared) => {
                        let (result, explanation) = match &explainer {
                            Some(explainer) => {
                                explainer.evaluate(&prepared.request, &prepared.access)
                            }
                            // No rules: the open-with-warning mode allows every request.
                            None => (allowed(), EvaluationExplanation::default()),
                        };
                        evaluate_result(method, &prepared.request, &result, explanation)
                    }
                    Err(error) => refused(error.0),
                }
            })
            .collect();
        Ok(RulesEvaluation { results })
    }

    fn decision(&self, request_id: &str) -> Result<DecisionDetail, ApiError> {
        let Some(decision) = self.rules.decision(request_id) else {
            return Err(ApiError::not_found(if self.rules.retains_decisions() {
                format!(
                    "decision {request_id} is not retained: the engine keeps the newest {} decisions",
                    firenook_rules_runtime::RETAINED_DECISIONS
                )
            } else {
                "decisions are not retained: request diagnostics are off".to_owned()
            }));
        };
        let request = decision.request();
        let (result, explanation) = decision
            .ruleset()
            .explainer()
            .evaluate(request, &decision.access(self.store.snapshot()));
        Ok(DecisionDetail {
            request_id: decision.request_id().to_owned(),
            recorded_outcome: decision.recorded().into(),
            result: evaluate_result(method_of(request.operation), request, &result, explanation),
            rules: decision.ruleset().source().to_owned(),
            rules_hash: decision.source_hash().to_owned(),
            request: replayable(&decision),
        })
    }

    fn impact(&self, body: &RulesImpactBody) -> Result<RulesImpact, ApiError> {
        let database = self.database(body.database.as_deref())?;
        let draft = self.rules(&database, Some(&body.source))?;
        let draft = draft
            .ruleset()
            .expect("a compiled draft always has a ruleset");
        let decisions = self.rules.retained_decisions(&database);
        let snapshot = self.store.snapshot();
        let flips = decisions
            .iter()
            .filter_map(|decision| {
                let request = decision.request();
                let access = decision.access(snapshot.clone());
                let before = DecisionOutcome::of(&decision.ruleset().evaluate(request, &access));
                let after = DecisionOutcome::of(&draft.evaluate(request, &access));
                (before != after).then(|| ImpactFlip {
                    request_id: decision.request_id().to_owned(),
                    method: method_of(request.operation),
                    path: relative_target(request).0,
                    uid: request.auth.as_ref().and_then(|auth| auth.uid.clone()),
                    before: before.into(),
                    after: after.into(),
                    time: rfc3339(request.time),
                })
            })
            .collect();
        Ok(RulesImpact {
            considered: decisions.len(),
            flips,
        })
    }

    /// The dry-run request a wire request describes, decoded the way the
    /// REST front decodes the same request.
    fn decode(
        &self,
        database: &DatabaseName,
        request: &EvaluateRequest,
    ) -> Result<Decoded, String> {
        let writes = matches!(request.method, RulesMethod::Create | RulesMethod::Update);
        if request.data.is_some() && !writes {
            return Err("data is only for create and update".to_owned());
        }
        if request.remove_keys.is_some() && request.method != RulesMethod::Update {
            return Err("removeKeys is only for update".to_owned());
        }
        if request.query.is_some() && request.method != RulesMethod::List {
            return Err("query is only for list".to_owned());
        }
        if request.group.is_some_and(|group| group) && request.method != RulesMethod::List {
            return Err("group is only for list".to_owned());
        }
        let key = || {
            DocumentKey::new(database.clone(), request.path.as_str())
                .map_err(|error| format!("{} is not a document path: {error}", request.path))
        };
        let fields = || {
            request
                .data
                .as_ref()
                .map_or_else(|| Ok(BTreeMap::new()), firenook_rest_front::document_fields)
        };
        let operation = match request.method {
            RulesMethod::Get => DryRunOperation::Get(key()?),
            RulesMethod::List => DryRunOperation::List {
                database: database.clone(),
                query: Box::new(list_query(request)?),
            },
            RulesMethod::Create => DryRunOperation::Create {
                key: key()?,
                fields: fields()?,
            },
            RulesMethod::Update => DryRunOperation::Update {
                key: key()?,
                fields: fields()?,
                remove: request.remove_keys.clone().unwrap_or_default(),
            },
            RulesMethod::Delete => DryRunOperation::Delete(key()?),
        };
        let before = match &request.resource {
            RecordedResource::ReadStore => None,
            RecordedResource::Missing => Some(None),
            RecordedResource::Fields(fields) => {
                Some(Some(firenook_rest_front::document_fields(fields)?))
            }
        };
        Ok(Decoded {
            method: request.method,
            dry_run: DryRunRequest {
                operation,
                auth: self.auth(request)?,
                time: match &request.time {
                    Some(time) => parse_time(time)?,
                    None => now(),
                },
                before,
            },
        })
    }

    fn auth(&self, request: &EvaluateRequest) -> Result<Option<Auth>, String> {
        match (&request.authorization, &request.auth) {
            (Some(_), Some(_)) => Err("give authorization or auth, not both".to_owned()),
            (Some(header), None) => {
                match Authorization::parse(Some(header), &self.project, now().seconds())
                    .map_err(|error| error.to_string())?
                {
                    Authorization::Owner => Err(
                        "the owner credential skips the rules, so there is nothing to evaluate"
                            .to_owned(),
                    ),
                    Authorization::Client(auth) => Ok(auth),
                }
            }
            (None, Some(auth)) => Ok(Some(Auth {
                uid: Some(auth.uid.clone()),
                token: auth
                    .token
                    .iter()
                    .map(|(name, value)| (name.clone(), claim_value(value)))
                    .collect(),
            })),
            (None, None) => Ok(None),
        }
    }
}

struct Decoded {
    method: RulesMethod,
    dry_run: DryRunRequest,
}

/// A list's query, decoded by the REST front's own `structuredQuery` decoder.
fn list_query(request: &EvaluateRequest) -> Result<firenook_query_engine::Query, String> {
    let segments = request.path.split('/').collect::<Vec<_>>();
    if segments.len() % 2 == 0 || segments.iter().any(|segment| segment.is_empty()) {
        return Err(format!("{} is not a collection path", request.path));
    }
    let (parent, collection) = request
        .path
        .rsplit_once('/')
        .map_or((None, request.path.as_str()), |(parent, collection)| {
            (Some(parent), collection)
        });
    let query = request.query.clone().unwrap_or_default();
    let mut structured = Map::new();
    structured.insert(
        "from".to_owned(),
        json!([{ "collectionId": collection, "allDescendants": request.group.unwrap_or(false) }]),
    );
    if let Some(filter) = query.filter {
        structured.insert("where".to_owned(), filter);
    }
    if let Some(orders) = query.order_by {
        structured.insert(
            "orderBy".to_owned(),
            serde_json::to_value(orders).map_err(|error| error.to_string())?,
        );
    }
    if let Some(limit) = query.limit {
        structured.insert("limit".to_owned(), json!(limit));
    }
    firenook_rest_front::structured_query(&structured, parent)
}

fn allowed() -> EvaluationResult {
    EvaluationResult {
        allowed: true,
        error: None,
        evaluated_expressions: 0,
        document_accesses: 0,
        document_cache_hits: 0,
        matching_allows: 0,
    }
}

/// An operation that fails before the rules, as the real write would.
fn refused(message: String) -> EvaluateResult {
    EvaluateResult {
        outcome: RulesOutcome::Error,
        error: Some(message),
        allows: Vec::new(),
        explanation: Vec::new(),
        truncated: false,
        document_accesses: 0,
        document_cache_hits: 0,
        document_access_limit: DOCUMENT_ACCESS_LIMIT,
        query_reason: None,
        resource: None,
        request_resource: None,
        changed_keys: None,
    }
}

fn evaluate_result(
    method: RulesMethod,
    request: &EvaluationRequest,
    result: &EvaluationResult,
    explanation: EvaluationExplanation,
) -> EvaluateResult {
    let writes = matches!(
        method,
        RulesMethod::Create | RulesMethod::Update | RulesMethod::Delete
    );
    EvaluateResult {
        outcome: DecisionOutcome::of(result).into(),
        error: result.error.as_ref().map(|error| error.message.clone()),
        allows: explanation
            .allows
            .iter()
            .map(|allow| AllowTrace {
                line: allow.condition.line,
                from: allow.condition.from,
                to: allow.condition.to,
                outcome: match allow.decision {
                    AllowDecision::Allow => RulesOutcome::Allow,
                    AllowDecision::Deny => RulesOutcome::Deny,
                    AllowDecision::Error => RulesOutcome::Error,
                },
            })
            .collect(),
        explanation: explanation
            .steps
            .into_iter()
            .map(|step| ExplainStep {
                from: step.span.from,
                to: step.span.to,
                line: step.span.line,
                value: step.value,
                error: step.error,
            })
            .collect(),
        truncated: explanation.truncated,
        document_accesses: result.document_accesses,
        document_cache_hits: result.document_cache_hits,
        document_access_limit: DOCUMENT_ACCESS_LIMIT,
        query_reason: explanation.query_reason,
        resource: request
            .resource
            .as_ref()
            .map(|resource| rest_fields(&resource.data)),
        request_resource: if writes {
            request
                .request_resource
                .as_ref()
                .map(|resource| rest_fields(&resource.data))
        } else {
            None
        },
        changed_keys: (method == RulesMethod::Update)
            .then(|| changed_keys(request.resource.as_ref(), request.request_resource.as_ref())),
    }
}

/// Top-level keys added, removed or changed between two documents.
fn changed_keys(before: Option<&Resource>, after: Option<&Resource>) -> Vec<String> {
    let empty = BTreeMap::new();
    let before = before.map_or(&empty, |resource| &resource.data);
    let after = after.map_or(&empty, |resource| &resource.data);
    let mut keys = before
        .keys()
        .chain(after.keys())
        .filter(|key| before.get(*key) != after.get(*key))
        .cloned()
        .collect::<Vec<_>>();
    keys.sort();
    keys.dedup();
    keys
}

/// A retained decision as a request the playground can send again.
fn replayable(decision: &RetainedDecision) -> EvaluateRequest {
    let request = decision.request();
    let method = method_of(request.operation);
    let (path, group) = relative_target(request);
    let fields = |resource: Option<&Resource>| resource.map(|resource| rest_fields(&resource.data));
    let (data, remove_keys) = match method {
        RulesMethod::Create => (fields(request.request_resource.as_ref()), None),
        RulesMethod::Update => {
            let removed = request.resource.as_ref().map(|before| {
                before
                    .data
                    .keys()
                    .filter(|key| {
                        request
                            .request_resource
                            .as_ref()
                            .is_none_or(|after| !after.data.contains_key(*key))
                    })
                    .cloned()
                    .collect::<Vec<_>>()
            });
            (fields(request.request_resource.as_ref()), removed)
        }
        _ => (None, None),
    };
    EvaluateRequest {
        method,
        path,
        group: group
            .then_some(true)
            .or((method == RulesMethod::List).then_some(false)),
        authorization: None,
        auth: request.auth.as_ref().map(|auth| EvaluateAuth {
            uid: auth.uid.clone().unwrap_or_default(),
            token: auth
                .token
                .iter()
                .map(|(name, value)| (name.clone(), claim_json(value)))
                .collect(),
        }),
        data,
        remove_keys,
        query: (method == RulesMethod::List).then(|| EvaluateQuery {
            filter: request.query.filter.as_ref().map(rest_filter),
            order_by: (!request.query.order_by.is_empty()).then(|| {
                request
                    .query
                    .order_by
                    .iter()
                    .map(|(field, direction)| EvaluateOrder {
                        field: EvaluateFieldReference {
                            field_path: field.clone(),
                        },
                        direction: Some(
                            if direction == "DESC" {
                                "DESCENDING"
                            } else {
                                "ASCENDING"
                            }
                            .to_owned(),
                        ),
                    })
                    .collect()
            }),
            limit: request
                .query
                .limit
                .map(|limit| u32::try_from(limit).unwrap_or(u32::MAX)),
        }),
        resource: if method == RulesMethod::List {
            RecordedResource::ReadStore
        } else {
            fields(request.resource.as_ref())
                .map_or(RecordedResource::Missing, RecordedResource::Fields)
        },
        time: Some(rfc3339(request.time)),
    }
}

/// The relative path a request is about, and whether a list is a
/// collection-group query.
fn relative_target(request: &EvaluationRequest) -> (String, bool) {
    if request.operation == RequestOperation::List {
        match &request.query.scope {
            Some(QueryScope::Collection(path)) => return (path.clone(), false),
            Some(QueryScope::CollectionGroup {
                collection_id,
                ancestor,
            }) => {
                return (
                    ancestor.as_ref().map_or_else(
                        || collection_id.clone(),
                        |ancestor| format!("{ancestor}/{collection_id}"),
                    ),
                    true,
                );
            }
            None => {}
        }
    }
    let path = request
        .path
        .find("/documents/")
        .map_or(request.path.as_str(), |index| {
            &request.path[index + "/documents/".len()..]
        });
    (path.to_owned(), false)
}

const fn method_of(operation: RequestOperation) -> RulesMethod {
    match operation {
        RequestOperation::Get => RulesMethod::Get,
        RequestOperation::List => RulesMethod::List,
        RequestOperation::Create => RulesMethod::Create,
        RequestOperation::Update => RulesMethod::Update,
        RequestOperation::Delete => RulesMethod::Delete,
    }
}

/// A rules filter back in the REST shape it was decoded from.
fn rest_filter(filter: &QueryFilter) -> JsonValue {
    match filter {
        QueryFilter::Field(constraint) => json!({
            "fieldFilter": {
                "field": { "fieldPath": field_path(&constraint.field) },
                "op": match constraint.operator {
                    ConstraintOperator::Equal => "EQUAL",
                    ConstraintOperator::NotEqual => "NOT_EQUAL",
                    ConstraintOperator::Less => "LESS_THAN",
                    ConstraintOperator::LessEqual => "LESS_THAN_OR_EQUAL",
                    ConstraintOperator::Greater => "GREATER_THAN",
                    ConstraintOperator::GreaterEqual => "GREATER_THAN_OR_EQUAL",
                    ConstraintOperator::In => "IN",
                    ConstraintOperator::NotIn => "NOT_IN",
                    ConstraintOperator::ArrayContains => "ARRAY_CONTAINS",
                    ConstraintOperator::ArrayContainsAny => "ARRAY_CONTAINS_ANY",
                },
                "value": rest_value(&constraint.value),
            }
        }),
        QueryFilter::And(filters) | QueryFilter::Or(filters) => json!({
            "compositeFilter": {
                "op": if matches!(filter, QueryFilter::And(_)) { "AND" } else { "OR" },
                "filters": filters.iter().map(rest_filter).collect::<Vec<_>>(),
            }
        }),
    }
}

/// A field path as the REST wire spells it: backticks around a segment that
/// is not a plain identifier.
fn field_path(segments: &[String]) -> String {
    segments
        .iter()
        .map(|segment| {
            let plain = segment
                .chars()
                .next()
                .is_some_and(|first| first.is_ascii_alphabetic() || first == '_')
                && segment
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric() || character == '_');
            if plain {
                segment.clone()
            } else {
                format!("`{}`", segment.replace('\\', "\\\\").replace('`', "\\`"))
            }
        })
        .collect::<Vec<_>>()
        .join(".")
}

fn rest_fields(fields: &BTreeMap<String, Value>) -> RestFields {
    fields
        .iter()
        .map(|(name, value)| (name.clone(), rest_value(value)))
        .collect()
}

/// A rules value in the REST typed shape a document read returns.
fn rest_value(value: &Value) -> JsonValue {
    match value {
        Value::Null => json!({ "nullValue": null }),
        Value::Bool(value) => json!({ "booleanValue": value }),
        Value::Integer(value) => json!({ "integerValue": value.to_string() }),
        Value::Float(value) if value.is_nan() => json!({ "doubleValue": "NaN" }),
        Value::Float(value) if value.is_infinite() => json!({
            "doubleValue": if *value > 0.0 { "Infinity" } else { "-Infinity" }
        }),
        Value::Float(value) => json!({ "doubleValue": value }),
        Value::String(value) => json!({ "stringValue": value }),
        Value::List(values) => json!({
            "arrayValue": { "values": values.iter().map(rest_value).collect::<Vec<_>>() }
        }),
        Value::Map(fields) => json!({ "mapValue": { "fields": rest_fields(fields) } }),
        Value::Timestamp(timestamp) => json!({ "timestampValue": rfc3339(*timestamp) }),
        Value::Path(path) => json!({ "referenceValue": path }),
        Value::Bytes(bytes) => json!({ "bytesValue": BASE64.encode(bytes) }),
        Value::LatLng(point) => json!({
            "geoPointValue": { "latitude": point.latitude, "longitude": point.longitude }
        }),
        // Durations exist only inside an evaluation, never in a document.
        Value::Duration(duration) => json!({
            "stringValue": format!("{}s", duration.seconds)
        }),
    }
}

/// A JSON claim as `request.auth.token` exposes it.
fn claim_value(value: &JsonValue) -> Value {
    match value {
        JsonValue::Null => Value::Null,
        JsonValue::Bool(value) => Value::Bool(*value),
        JsonValue::Number(number) => number.as_i64().map_or_else(
            || Value::Float(number.as_f64().unwrap_or(f64::NAN)),
            Value::Integer,
        ),
        JsonValue::String(value) => Value::String(value.clone()),
        JsonValue::Array(values) => Value::List(values.iter().map(claim_value).collect()),
        JsonValue::Object(values) => Value::Map(
            values
                .iter()
                .map(|(name, value)| (name.clone(), claim_value(value)))
                .collect(),
        ),
    }
}

/// A token claim back as plain JSON.
fn claim_json(value: &Value) -> JsonValue {
    match value {
        Value::Null => JsonValue::Null,
        Value::Bool(value) => json!(value),
        Value::Integer(value) => json!(value),
        Value::Float(value) => json!(value),
        Value::String(value) | Value::Path(value) => json!(value),
        Value::List(values) => JsonValue::Array(values.iter().map(claim_json).collect()),
        Value::Map(values) => JsonValue::Object(
            values
                .iter()
                .map(|(name, value)| (name.clone(), claim_json(value)))
                .collect(),
        ),
        // Claims arrive as JSON; anything else cannot occur in a token.
        Value::Timestamp(timestamp) => json!(rfc3339(*timestamp)),
        Value::Bytes(bytes) => json!(BASE64.encode(bytes)),
        Value::Duration(duration) => json!(duration.seconds),
        Value::LatLng(point) => json!({ "latitude": point.latitude, "longitude": point.longitude }),
    }
}

fn rfc3339(timestamp: Timestamp) -> String {
    OffsetDateTime::from_unix_timestamp_nanos(
        i128::from(timestamp.seconds()) * 1_000_000_000 + i128::from(timestamp.nanoseconds()),
    )
    .ok()
    .and_then(|time| time.format(&Rfc3339).ok())
    .unwrap_or_default()
}

fn parse_time(text: &str) -> Result<StoreTimestamp, String> {
    let parsed = OffsetDateTime::parse(text, &Rfc3339)
        .map_err(|error| format!("time must be RFC 3339: {error}"))?;
    StoreTimestamp::new(parsed.unix_timestamp(), parsed.nanosecond())
        .map_err(|error| error.to_string())
}

fn now() -> StoreTimestamp {
    let elapsed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    StoreTimestamp::new(
        i64::try_from(elapsed.as_secs()).unwrap_or(i64::MAX),
        elapsed.subsec_nanos(),
    )
    .expect("the system clock is a valid timestamp")
}

/// A draft that did not compile: the compiler's diagnostics ride beside the
/// error.
fn draft_not_compiled(diagnostics: &[crate::RulesDiagnostic]) -> ApiError {
    ApiError::invalid("the draft rules did not compile")
        .with_extra("diagnostics", json!(diagnostics))
}

/// Evaluation is CPU-bound and reads whole documents; keep it off the
/// request threads.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, ApiError> + Send + 'static,
) -> Result<Json<T>, ApiError> {
    crate::blocking::blocking("the evaluation task", work)
        .await
        .map(Json)
}

/// `POST /rules/evaluate`: dry runs against a draft or the rules in force.
async fn evaluate(
    State(evaluator): State<RulesEvaluator>,
    Json(body): Json<RulesEvaluateBody>,
) -> Result<Json<RulesEvaluation>, ApiError> {
    blocking(move || evaluator.evaluate(&body)).await
}

/// `GET /rules/decisions/{requestId}`: a recorded decision, explained.
async fn decision(
    State(evaluator): State<RulesEvaluator>,
    Path(request_id): Path<String>,
) -> Result<Json<DecisionDetail>, ApiError> {
    blocking(move || evaluator.decision(&request_id)).await
}

/// `POST /rules/impact`: the retained decisions a draft would flip.
async fn impact(
    State(evaluator): State<RulesEvaluator>,
    Json(body): Json<RulesImpactBody>,
) -> Result<Json<RulesImpact>, ApiError> {
    blocking(move || evaluator.impact(&body)).await
}

#[cfg(test)]
#[path = "rules_eval_tests.rs"]
mod tests;
