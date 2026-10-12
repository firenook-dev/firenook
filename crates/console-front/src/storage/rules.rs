//! The Storage rules page's API: what governs a bucket, installing and
//! saving, checking a draft with the folders each match block governs,
//! history, dry runs, recorded decisions with their re-run, impact,
//! coverage and access checks.
//!
//! In single-file mode one ruleset governs every bucket, so every bucket
//! names the same scope; in per-bucket mode each configured bucket has its
//! own. `bucket` defaults to the default bucket.

use std::collections::BTreeMap;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::header;
use axum::response::{IntoResponse, Response};
use firenook_rules_engine::{AllowDecision, ExplanationStep};
use firenook_storage_front::{
    CoverageError, DecisionAllow, DryRunRequest, DryRunResult, Operation, ProposedObject,
    RecordedObject, RulesAuth, RulesMode, RulesObjectView, RulesOrigin as EngineOrigin, RulesScope,
    StorageRulesHandle, StorageRulesMap as EngineMap,
};
use serde::de::Deserializer;
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use ts_rs::TS;

use super::StorageRoutes;
use super::decision_feed::{StorageDecisionBatch, StorageDecisionsParams};
use super::files::StorageRulesMode;
use crate::api_error::ApiError;
use crate::blocking::blocking;
use crate::json::ConsoleJson;
use crate::rules::{
    GoverningMatch, RulesDiagnostic, RulesOrigin, RulesOutline, RulesVersion, UnusedMatch,
    diagnostic, not_compiled, operations, origin, outline_view, version,
};
use crate::rules_eval::{AllowTrace, EvaluateAuth, ExplainStep, RulesMethod, RulesOutcome};

/// The largest ruleset the console accepts.
const MAX_SOURCE_BYTES: usize = 256 * 1024;
/// Requests one dry run takes.
const MAX_REQUESTS: usize = 200;

/// The Storage rules governing a bucket.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "storage/")]
pub(crate) struct StorageRulesDocument {
    /// The bucket asked about; null when one ruleset governs every bucket.
    pub bucket: Option<String>,
    pub mode: StorageRulesMode,
    /// The source in force; empty when none is (the bucket is refused).
    pub source: String,
    pub enforced: bool,
    pub hash: String,
    pub origin: Option<RulesOrigin>,
    /// The file `firebase.json` names for this scope; saving writes here.
    pub path: Option<String>,
    /// The file's current text, when it is set and readable.
    pub file_source: Option<String>,
    /// Why the file on disk is not in force. Positions refer to `fileSource`.
    pub file_problems: Vec<RulesDiagnostic>,
    /// Buckets these rules govern (single-file mode: every bucket the
    /// console knows).
    pub governs: Vec<String>,
    /// These are the emulator's open default rules for a demo project.
    pub open_default: bool,
}

/// `PUT /storage/rules`.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "storage/")]
pub(crate) struct StorageRulesWrite {
    #[serde(default)]
    #[ts(optional)]
    pub bucket: Option<String>,
    pub source: String,
    /// Also write the scope's file.
    #[serde(default)]
    pub save: bool,
}

/// What `PUT /storage/rules` did.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "storage/")]
pub(crate) struct StorageRulesInstalled {
    /// The scope's bucket; null when one ruleset governs every bucket.
    pub bucket: Option<String>,
    /// Whether the text was also written to the scope's file.
    pub saved: bool,
    /// The scope's file, when it has one.
    pub path: Option<String>,
}

/// `POST /storage/rules/check`.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "storage/")]
pub(crate) struct StorageRulesCheckBody {
    #[serde(default)]
    #[ts(optional)]
    pub bucket: Option<String>,
    pub source: String,
}

/// A draft, compiled and read but not installed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "storage/")]
pub(crate) struct StorageRulesCheck {
    /// Compiler errors (then `outline` and `map` are null), or the lints'
    /// warnings for a draft that compiles.
    pub diagnostics: Vec<RulesDiagnostic>,
    pub outline: Option<RulesOutline>,
    /// Which match blocks govern the bucket's folders; null when the draft
    /// does not compile or the folder index is still being built.
    pub map: Option<StorageRulesMap>,
}

/// Which match blocks govern which folder shapes of a bucket.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "storage/")]
pub(crate) struct StorageRulesMap {
    pub bucket: String,
    pub folders: Vec<StorageFolderRules>,
    pub unused_matches: Vec<UnusedMatch>,
    /// Some levels had more than twenty folders and are written as a star
    /// segment.
    pub grouped: bool,
}

/// What governs one folder shape.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "storage/")]
pub(crate) struct StorageFolderRules {
    /// A folder shape: real folder names, with a star segment standing for
    /// any folder at a level holding more than twenty of them; empty for
    /// the bucket root.
    pub pattern: String,
    /// Files directly in the folders the shape stands for.
    #[ts(type = "number")]
    pub files: u64,
    pub governed_by: Vec<GoverningMatch>,
    /// No match block covers files here, so every client request for them
    /// is denied.
    pub uncovered: bool,
    /// Folders below this one hold files but sit past the analysis depth;
    /// they were not probed.
    pub deeper: bool,
}

/// Each standard field: absent leaves it, null clears it, a string sets it.
#[allow(
    clippy::option_option,
    reason = "absent, null and a value mean three different things on the wire"
)]
pub(crate) mod double_option {
    use serde::{Deserialize, Deserializer, Serializer};

    #[allow(
        clippy::ref_option,
        reason = "serde's serialize_with hands the field by reference"
    )]
    pub(crate) fn serialize<S: Serializer>(
        value: &Option<Option<String>>,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        match value {
            Some(Some(text)) => serializer.serialize_str(text),
            Some(None) | None => serializer.serialize_none(),
        }
    }

    pub(crate) fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Option<Option<String>>, D::Error> {
        Option::<String>::deserialize(deserializer).map(Some)
    }
}

/// What an upload or metadata change proposes. Absent and null survive the
/// round trip from a decision's detail to a playground body.
#[allow(
    clippy::option_option,
    reason = "absent, null and a value mean three different things on the wire"
)]
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "storage/")]
pub(crate) struct StorageProposedObject {
    /// Create: the upload's size in bytes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub size: Option<u64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "double_option"
    )]
    #[ts(optional, type = "string | null")]
    pub content_type: Option<Option<String>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "double_option"
    )]
    #[ts(optional, type = "string | null")]
    pub cache_control: Option<Option<String>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "double_option"
    )]
    #[ts(optional, type = "string | null")]
    pub content_disposition: Option<Option<String>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "double_option"
    )]
    #[ts(optional, type = "string | null")]
    pub content_encoding: Option<Option<String>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "double_option"
    )]
    #[ts(optional, type = "string | null")]
    pub content_language: Option<Option<String>>,
    /// Keys to set (a string) or remove (null).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "Record<string, string | null>")]
    pub custom_metadata: Option<BTreeMap<String, Option<String>>>,
}

/// The object as Storage rules see it (the official runtime's fourteen
/// keys).
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "storage/")]
pub(crate) struct StorageRulesObjectView {
    pub name: String,
    pub bucket: String,
    #[ts(type = "number")]
    pub size: u64,
    pub content_type: Option<String>,
    pub content_disposition: Option<String>,
    pub content_encoding: Option<String>,
    pub metadata: BTreeMap<String, String>,
    pub generation: String,
    pub metageneration: String,
    pub time_created: String,
    pub updated: String,
    pub md5_hash: String,
    pub crc32c: String,
    pub etag: String,
}

/// A replay's `resource`: absent reads the store now, `null` means the
/// object did not exist, an object is the one recorded.
#[derive(Clone, Debug, Default, PartialEq, Eq, TS)]
#[ts(export_to = "storage/")]
pub(crate) enum StorageRecordedObject {
    #[default]
    ReadStore,
    Missing,
    Object(Box<StorageRulesObjectView>),
}

impl StorageRecordedObject {
    const fn reads_store(&self) -> bool {
        matches!(self, Self::ReadStore)
    }
}

impl Serialize for StorageRecordedObject {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::ReadStore | Self::Missing => serializer.serialize_none(),
            Self::Object(object) => object.serialize(serializer),
        }
    }
}

impl<'de> Deserialize<'de> for StorageRecordedObject {
    // Only called when the field is present; `#[serde(default)]` covers absent.
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Ok(Option::<StorageRulesObjectView>::deserialize(deserializer)?
            .map_or(Self::Missing, |object| Self::Object(Box::new(object))))
    }
}

/// One request to evaluate.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "storage/")]
pub(crate) struct StorageEvaluateRequest {
    pub method: RulesMethod,
    pub bucket: String,
    /// The object name; for a list, the folder prefix (empty or ending in
    /// `/`).
    pub path: String,
    /// An `Authorization` header value, parsed as a real request's.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub authorization: Option<String>,
    /// `request.auth` directly; the alternative to `authorization`.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub auth: Option<EvaluateAuth>,
    /// Create and update: what is proposed.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub proposed: Option<StorageProposedObject>,
    /// Replay: the proposed object exactly as recorded (its hashes and
    /// generation included). Dropped when the playground edits `proposed`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub request_resource: Option<StorageRulesObjectView>,
    /// Replay: the object as recorded (null: it did not exist). Absent
    /// reads the store now.
    #[serde(default, skip_serializing_if = "StorageRecordedObject::reads_store")]
    #[ts(optional = nullable, as = "Option<StorageRulesObjectView>")]
    pub resource: StorageRecordedObject,
    /// `request.time`, RFC 3339; absent is now.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub time: Option<String>,
}

/// `POST /storage/rules/evaluate`.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "storage/")]
pub(crate) struct StorageEvaluateBody {
    /// The bucket of a request that names none; the default bucket when
    /// absent.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub bucket: Option<String>,
    /// A draft; absent evaluates the rules in force.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub source: Option<String>,
    pub requests: Vec<StorageEvaluateRequest>,
}

/// One request's verdict and why.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "storage/")]
pub(crate) struct StorageEvaluateResult {
    pub outcome: RulesOutcome,
    /// The evaluator's error, or why the request could not reach the rules.
    pub error: Option<String>,
    pub allows: Vec<AllowTrace>,
    pub explanation: Vec<ExplainStep>,
    pub truncated: bool,
    #[ts(type = "number")]
    pub document_accesses: usize,
    #[ts(type = "number")]
    pub document_access_limit: usize,
    pub resource: Option<StorageRulesObjectView>,
    pub request_resource: Option<StorageRulesObjectView>,
    /// Update: custom metadata keys added, removed or changed.
    pub changed_keys: Option<Vec<String>>,
}

/// Every result of one dry run, in request order.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "storage/")]
pub(crate) struct StorageRulesEvaluation {
    pub results: Vec<StorageEvaluateResult>,
}

/// One request the Storage rules judged.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "storage/")]
pub(crate) struct StorageDecision {
    /// `s` and a number, path-safe.
    pub id: String,
    pub at: String,
    pub bucket: String,
    pub method: RulesMethod,
    pub path: String,
    pub outcome: RulesOutcome,
    pub error: Option<String>,
    pub uid: Option<String>,
    /// The token's tenant, for a link to the Auth user; null for project
    /// users.
    pub tenant: Option<String>,
    pub provider: Option<String>,
    /// No `Authorization` at all.
    pub anonymous: bool,
    pub allows: Vec<AllowTrace>,
    pub rules_hash: String,
    pub no_ruleset: bool,
    /// An upload's size.
    #[ts(type = "number | null")]
    pub size: Option<u64>,
    pub content_type: Option<String>,
    pub via_console: bool,
}

/// A recorded decision, explained by re-running it.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "storage/")]
pub(crate) struct StorageDecisionDetail {
    pub id: String,
    pub recorded_outcome: RulesOutcome,
    /// The re-run against the ruleset that decided it, with every
    /// expression's value.
    pub result: StorageEvaluateResult,
    /// The source that decided it; positions refer to this text.
    pub rules: String,
    pub rules_hash: String,
    /// The request, replayable through `POST /storage/rules/evaluate`.
    pub request: StorageEvaluateRequest,
    /// The caller's token claims, exactly as `request.auth.token` exposed
    /// them.
    #[ts(type = "Record<string, unknown>")]
    pub claims: serde_json::Map<String, serde_json::Value>,
}

/// `POST /storage/rules/impact`.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "storage/")]
pub(crate) struct StorageImpactBody {
    #[serde(default)]
    #[ts(optional = nullable)]
    pub bucket: Option<String>,
    pub source: String,
}

/// What a draft would change among the decisions the engine can re-run.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "storage/")]
pub(crate) struct StorageRulesImpact {
    #[ts(type = "number")]
    pub considered: usize,
    pub flips: Vec<StorageImpactFlip>,
}

/// One decision a draft would decide differently.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "storage/")]
pub(crate) struct StorageImpactFlip {
    pub id: String,
    pub method: RulesMethod,
    pub bucket: String,
    pub path: String,
    pub uid: Option<String>,
    pub before: RulesOutcome,
    pub after: RulesOutcome,
}

/// `POST /storage/rules/access`.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "storage/")]
pub(crate) struct StorageAccessBody {
    pub bucket: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub authorization: Option<String>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub auth: Option<EvaluateAuth>,
    /// At most 200.
    pub names: Vec<String>,
    /// At most 3.
    pub methods: Vec<RulesMethod>,
}

/// What an identity may do with each object.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "storage/")]
pub(crate) struct StorageAccess {
    pub results: Vec<StorageAccessResult>,
}

/// One object's verdicts.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "storage/")]
pub(crate) struct StorageAccessResult {
    pub name: String,
    pub verdicts: Vec<StorageAccessVerdict>,
}

/// One operation's verdict.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "storage/")]
pub(crate) struct StorageAccessVerdict {
    pub method: RulesMethod,
    pub outcome: RulesOutcome,
    /// The deciding line.
    #[ts(type = "number | null")]
    pub line: Option<usize>,
}

// ---------------------------------------------------------------------------
// Conversions between the engine's values and the console's.

pub(crate) const fn method_of(operation: Operation) -> RulesMethod {
    match operation {
        Operation::Get => RulesMethod::Get,
        Operation::List => RulesMethod::List,
        Operation::Create => RulesMethod::Create,
        Operation::Update => RulesMethod::Update,
        Operation::Delete => RulesMethod::Delete,
    }
}

const fn operation_of(method: RulesMethod) -> Operation {
    match method {
        RulesMethod::Get => Operation::Get,
        RulesMethod::List => Operation::List,
        RulesMethod::Create => Operation::Create,
        RulesMethod::Update => Operation::Update,
        RulesMethod::Delete => Operation::Delete,
    }
}

pub(crate) const fn allow_trace(allow: &DecisionAllow) -> AllowTrace {
    AllowTrace {
        line: allow.line,
        from: allow.from,
        to: allow.to,
        outcome: match allow.decision {
            AllowDecision::Allow => RulesOutcome::Allow,
            AllowDecision::Deny => RulesOutcome::Deny,
            AllowDecision::Error => RulesOutcome::Error,
        },
    }
}

fn explain_step(step: &ExplanationStep) -> ExplainStep {
    ExplainStep {
        from: step.span.from,
        to: step.span.to,
        line: step.span.line,
        value: step.value.clone(),
        error: step.error,
    }
}

fn object_view(view: &RulesObjectView) -> StorageRulesObjectView {
    StorageRulesObjectView {
        name: view.name.clone(),
        bucket: view.bucket.clone(),
        size: view.size,
        content_type: view.content_type.clone(),
        content_disposition: view.content_disposition.clone(),
        content_encoding: view.content_encoding.clone(),
        metadata: view.metadata.clone(),
        generation: view.generation.clone(),
        metageneration: view.metageneration.clone(),
        time_created: view.time_created.clone(),
        updated: view.updated.clone(),
        md5_hash: view.md5_hash.clone(),
        crc32c: view.crc32c.clone(),
        etag: view.etag.clone(),
    }
}

fn engine_view(view: &StorageRulesObjectView) -> RulesObjectView {
    RulesObjectView {
        name: view.name.clone(),
        bucket: view.bucket.clone(),
        size: view.size,
        content_type: view.content_type.clone(),
        content_disposition: view.content_disposition.clone(),
        content_encoding: view.content_encoding.clone(),
        metadata: view.metadata.clone(),
        generation: view.generation.clone(),
        metageneration: view.metageneration.clone(),
        time_created: view.time_created.clone(),
        updated: view.updated.clone(),
        md5_hash: view.md5_hash.clone(),
        crc32c: view.crc32c.clone(),
        etag: view.etag.clone(),
    }
}

/// A dry run's result as the console shows it.
pub(crate) fn evaluate_result(result: &DryRunResult) -> StorageEvaluateResult {
    StorageEvaluateResult {
        outcome: result.outcome.into(),
        error: result.error.clone(),
        allows: result.allows.iter().map(allow_trace).collect(),
        explanation: result.explanation.iter().map(explain_step).collect(),
        truncated: result.truncated,
        document_accesses: result.document_accesses,
        document_access_limit: result.document_access_limit,
        resource: result.resource.as_ref().map(object_view),
        request_resource: result.request_resource.as_ref().map(object_view),
        changed_keys: result.changed_keys.clone(),
    }
}

fn proposed_of(proposed: &ProposedObject) -> StorageProposedObject {
    StorageProposedObject {
        size: proposed.size,
        content_type: proposed.content_type.clone(),
        cache_control: proposed.cache_control.clone(),
        content_disposition: proposed.content_disposition.clone(),
        content_encoding: proposed.content_encoding.clone(),
        content_language: proposed.content_language.clone(),
        custom_metadata: proposed.custom_metadata.clone(),
    }
}

/// An engine request as the console's replayable request.
pub(crate) fn evaluate_request(request: &DryRunRequest) -> StorageEvaluateRequest {
    StorageEvaluateRequest {
        method: method_of(request.method),
        bucket: request.bucket.clone(),
        path: request.path.clone(),
        authorization: request.authorization.clone(),
        auth: request.auth.as_ref().map(|auth| EvaluateAuth {
            uid: auth.uid.clone().unwrap_or_default(),
            token: auth.token.clone(),
        }),
        proposed: request.proposed.as_ref().map(proposed_of),
        request_resource: request.request_resource.as_ref().map(object_view),
        resource: match &request.resource {
            RecordedObject::ReadStore => StorageRecordedObject::ReadStore,
            RecordedObject::Missing => StorageRecordedObject::Missing,
            RecordedObject::Object(object) => {
                StorageRecordedObject::Object(Box::new(object_view(object)))
            }
        },
        time: request.time.and_then(|time| time.format(&Rfc3339).ok()),
    }
}

/// A console request as the engine's dry run.
fn dry_run_request(request: &StorageEvaluateRequest) -> Result<DryRunRequest, ApiError> {
    if request.authorization.is_some() && request.auth.is_some() {
        return Err(ApiError::invalid(
            "A request carries an authorization or an auth, not both.",
        ));
    }
    if matches!(
        request.authorization.as_deref(),
        Some("Bearer owner" | "Firebase owner")
    ) {
        return Err(ApiError::invalid(
            "Owner credentials skip the rules; evaluate as a user, an anonymous client or a custom identity.",
        ));
    }
    let time = request
        .time
        .as_deref()
        .map(|text| {
            OffsetDateTime::parse(text, &Rfc3339)
                .map_err(|_| ApiError::invalid(format!("time {text} is not an RFC 3339 time.")))
        })
        .transpose()?;
    Ok(DryRunRequest {
        method: operation_of(request.method),
        bucket: request.bucket.clone(),
        path: request.path.clone(),
        authorization: request.authorization.clone(),
        auth: request.auth.as_ref().map(|auth| RulesAuth {
            uid: (!auth.uid.is_empty()).then(|| auth.uid.clone()),
            token: auth.token.clone(),
        }),
        proposed: request.proposed.as_ref().map(|proposed| ProposedObject {
            size: proposed.size,
            content_type: proposed.content_type.clone(),
            cache_control: proposed.cache_control.clone(),
            content_disposition: proposed.content_disposition.clone(),
            content_encoding: proposed.content_encoding.clone(),
            content_language: proposed.content_language.clone(),
            custom_metadata: proposed.custom_metadata.clone(),
        }),
        request_resource: request.request_resource.as_ref().map(engine_view),
        resource: match &request.resource {
            StorageRecordedObject::ReadStore => RecordedObject::ReadStore,
            StorageRecordedObject::Missing => RecordedObject::Missing,
            StorageRecordedObject::Object(object) => {
                RecordedObject::Object(Box::new(engine_view(object)))
            }
        },
        time,
    })
}

const fn rules_mode(mode: RulesMode) -> StorageRulesMode {
    match mode {
        RulesMode::Single => StorageRulesMode::Single,
        RulesMode::PerBucket => StorageRulesMode::PerBucket,
        RulesMode::OpenDefault => StorageRulesMode::OpenDefault,
    }
}

fn rules_map(map: &EngineMap) -> StorageRulesMap {
    StorageRulesMap {
        bucket: map.bucket.clone(),
        folders: map
            .folders
            .iter()
            .map(|folder| StorageFolderRules {
                pattern: folder.pattern.clone(),
                files: folder.files,
                governed_by: folder
                    .governed_by
                    .iter()
                    .map(|block| GoverningMatch {
                        line: block.line,
                        path: block.path.clone(),
                        operations: operations(&block.operations),
                    })
                    .collect(),
                uncovered: folder.uncovered,
                deeper: folder.deeper,
            })
            .collect(),
        unused_matches: map
            .unused_matches
            .iter()
            .map(|block| UnusedMatch {
                line: block.line,
                path: block.path.clone(),
            })
            .collect(),
        grouped: map.grouped,
    }
}

// ---------------------------------------------------------------------------
// Routes.

impl StorageRoutes {
    /// The rules handle; the service runs with rules whenever the suite
    /// starts it, so its absence is an engine run without them.
    fn rules(&self) -> Result<StorageRulesHandle, ApiError> {
        self.api.rules().ok_or_else(|| {
            ApiError::unavailable(
                "Storage runs without rules here, so every request is allowed and there is nothing to edit.",
            )
        })
    }

    fn scope(&self, rules: &StorageRulesHandle, bucket: Option<&str>) -> (RulesScope, String) {
        let bucket = bucket.map_or_else(|| self.api.default_bucket(), str::to_owned);
        (rules.scope_of(&bucket), bucket)
    }
}

/// `?bucket`.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BucketQuery {
    bucket: Option<String>,
}

/// `GET /storage/rules?bucket`: the rules in force for the bucket's scope,
/// and its file.
pub(crate) async fn read_rules(
    State(routes): State<StorageRoutes>,
    Query(query): Query<BucketQuery>,
) -> Result<Json<StorageRulesDocument>, ApiError> {
    let rules = routes.rules()?;
    let (scope, _) = routes.scope(&rules, query.bucket.as_deref());
    let current = rules.current(&scope);
    let path = rules.file(&scope);
    let file_source = match path.clone() {
        Some(path) => tokio::task::spawn_blocking(move || std::fs::read_to_string(path).ok())
            .await
            .ok()
            .flatten(),
        None => None,
    };
    let governs = match &scope {
        RulesScope::Bucket(bucket) => vec![bucket.clone()],
        RulesScope::AllBuckets => routes
            .api
            .buckets()
            .buckets
            .into_iter()
            .map(|bucket| bucket.name)
            .collect(),
    };
    let mode = rules.mode();
    Ok(Json(StorageRulesDocument {
        bucket: scope.bucket().map(str::to_owned),
        mode: rules_mode(mode),
        source: current
            .as_ref()
            .map(|installed| installed.ruleset.source().to_owned())
            .unwrap_or_default(),
        enforced: current.is_some(),
        hash: current
            .as_ref()
            .map(|installed| installed.hash.clone())
            .unwrap_or_default(),
        origin: current.as_ref().map(|installed| origin(installed.origin)),
        path: path.map(|path| path.display().to_string()),
        file_source,
        file_problems: rules.file_problems(&scope).iter().map(diagnostic).collect(),
        governs,
        open_default: mode == RulesMode::OpenDefault,
    }))
}

/// `PUT /storage/rules`: compile and install for the scope; write the file
/// too with `save`.
pub(crate) async fn write_rules(
    State(routes): State<StorageRoutes>,
    ConsoleJson(request): ConsoleJson<StorageRulesWrite>,
) -> Result<Json<StorageRulesInstalled>, ApiError> {
    if request.source.len() > MAX_SOURCE_BYTES {
        return Err(ApiError::invalid(format!(
            "A ruleset is at most {MAX_SOURCE_BYTES} bytes."
        )));
    }
    let rules = routes.rules()?;
    let (scope, _) = routes.scope(&rules, request.bucket.as_deref());
    blocking("the rules task", move || {
        // Compile and install first: a ruleset that does not compile never
        // reaches the file, and the previous one keeps serving.
        rules
            .install(&scope, &request.source, EngineOrigin::Console)
            .map_err(|errors| not_compiled(&errors.iter().map(diagnostic).collect::<Vec<_>>()))?;
        let path = rules.file(&scope);
        let bucket = scope.bucket().map(str::to_owned);
        let Some(file) = path.filter(|_| request.save) else {
            return Ok(StorageRulesInstalled {
                bucket,
                saved: false,
                path: rules.file(&scope).map(|path| path.display().to_string()),
            });
        };
        // The watcher finds this text already in force: one version per save.
        std::fs::write(&file, &request.source).map_err(|error| {
            ApiError::conflict(format!(
                "The rules are in force, but {} could not be written: {error}.",
                file.display()
            ))
            .with_fix("Check that the file is writable, then save again.")
        })?;
        Ok(StorageRulesInstalled {
            bucket,
            saved: true,
            path: Some(file.display().to_string()),
        })
    })
    .await
    .map(Json)
}

/// `POST /storage/rules/check`: compile and read a draft, installing
/// nothing. A draft that does not compile is an answer (200).
pub(crate) async fn check_rules(
    State(routes): State<StorageRoutes>,
    ConsoleJson(request): ConsoleJson<StorageRulesCheckBody>,
) -> Result<Json<StorageRulesCheck>, ApiError> {
    if request.source.len() > MAX_SOURCE_BYTES {
        return Err(ApiError::invalid(format!(
            "A ruleset is at most {MAX_SOURCE_BYTES} bytes."
        )));
    }
    let rules = routes.rules()?;
    let (_, bucket) = routes.scope(&rules, request.bucket.as_deref());
    blocking("the rules task", move || {
        let ruleset = match firenook_rules_engine::compile(&request.source) {
            Ok(ruleset) => ruleset,
            Err(errors) => {
                return Ok(StorageRulesCheck {
                    diagnostics: errors.iter().map(diagnostic).collect(),
                    outline: None,
                    map: None,
                });
            }
        };
        Ok(StorageRulesCheck {
            diagnostics: ruleset.lints().iter().map(diagnostic).collect(),
            outline: Some(outline_view(&ruleset.outline())),
            map: rules.map(&bucket, &ruleset).as_ref().map(rules_map),
        })
    })
    .await
    .map(Json)
}

/// `GET /storage/rules/history?bucket`: what governed the scope, newest
/// first.
pub(crate) async fn rules_history(
    State(routes): State<StorageRoutes>,
    Query(query): Query<BucketQuery>,
) -> Result<Json<Vec<RulesVersion>>, ApiError> {
    let rules = routes.rules()?;
    let (scope, _) = routes.scope(&rules, query.bucket.as_deref());
    Ok(Json(
        rules.history(&scope).into_iter().map(version).collect(),
    ))
}

/// `POST /storage/rules/evaluate`: dry runs against a draft or the rules in
/// force; nothing is recorded.
pub(crate) async fn evaluate(
    State(routes): State<StorageRoutes>,
    ConsoleJson(body): ConsoleJson<StorageEvaluateBody>,
) -> Result<Json<StorageRulesEvaluation>, ApiError> {
    if body.requests.len() > MAX_REQUESTS {
        return Err(ApiError::invalid(format!(
            "A dry run takes at most {MAX_REQUESTS} requests; this one has {}.",
            body.requests.len()
        )));
    }
    if body
        .source
        .as_ref()
        .is_some_and(|source| source.len() > MAX_SOURCE_BYTES)
    {
        return Err(ApiError::invalid(format!(
            "A ruleset is at most {MAX_SOURCE_BYTES} bytes."
        )));
    }
    let rules = routes.rules()?;
    let fallback = body
        .bucket
        .clone()
        .unwrap_or_else(|| routes.api.default_bucket());
    let requests = body
        .requests
        .iter()
        .map(|request| {
            let mut request = dry_run_request(request)?;
            // A request that names no bucket is about the body's.
            if request.bucket.is_empty() {
                request.bucket.clone_from(&fallback);
            }
            Ok(request)
        })
        .collect::<Result<Vec<_>, ApiError>>()?;
    blocking("the rules task", move || {
        let results = rules
            .evaluate(&requests, body.source.as_deref())
            .map_err(|errors| {
                ApiError::invalid("The draft does not compile, so nothing could be evaluated.")
                    .with_extra(
                        "diagnostics",
                        serde_json::to_value(errors.iter().map(diagnostic).collect::<Vec<_>>())
                            .unwrap_or_default(),
                    )
            })?;
        Ok(StorageRulesEvaluation {
            results: results.iter().map(evaluate_result).collect(),
        })
    })
    .await
    .map(Json)
}

fn diagnostics_off() -> ApiError {
    ApiError::unavailable("Storage rules decisions are not recorded in this engine.")
        .with_fix("Start the engine without --no-diagnostics to record them.")
}

/// `GET /storage/rules/decisions`: the decisions the feed holds that pass
/// the topic's params, the first paint before the topic replays.
pub(crate) async fn decisions(
    State(routes): State<StorageRoutes>,
    Query(params): Query<StorageDecisionsParams>,
) -> Result<Json<StorageDecisionBatch>, ApiError> {
    let feed = routes.feed.clone().ok_or_else(diagnostics_off)?;
    blocking("the decisions task", move || Ok(feed.snapshot(&params)))
        .await
        .map(Json)
}

/// `GET /storage/rules/decisions/{id}`: one decision re-run with every
/// expression's value.
pub(crate) async fn decision(
    State(routes): State<StorageRoutes>,
    Path(id): Path<String>,
) -> Result<Json<StorageDecisionDetail>, ApiError> {
    let rules = routes.rules()?;
    if rules.decisions().is_none() {
        return Err(diagnostics_off());
    }
    blocking("the rules task", move || {
        let detail = rules.detail(&id).ok_or_else(|| {
            ApiError::not_found(
                "The engine no longer keeps this decision's request; it keeps the newest 2,000.",
            )
            .with_fix(
                "Its verdict and lines are in the list; try the same request in the playground.",
            )
        })?;
        Ok(StorageDecisionDetail {
            id: detail.id,
            recorded_outcome: detail.recorded_outcome.into(),
            result: evaluate_result(&detail.result),
            rules: detail.rules,
            rules_hash: detail.rules_hash,
            request: evaluate_request(&detail.request),
            claims: detail.claims,
        })
    })
    .await
    .map(Json)
}

/// `POST /storage/rules/impact`: what a draft would turn around among the
/// decisions the engine can re-run.
pub(crate) async fn impact(
    State(routes): State<StorageRoutes>,
    ConsoleJson(body): ConsoleJson<StorageImpactBody>,
) -> Result<Json<StorageRulesImpact>, ApiError> {
    if body.source.len() > MAX_SOURCE_BYTES {
        return Err(ApiError::invalid(format!(
            "A ruleset is at most {MAX_SOURCE_BYTES} bytes."
        )));
    }
    let rules = routes.rules()?;
    if rules.decisions().is_none() {
        return Err(diagnostics_off());
    }
    let (scope, _) = routes.scope(&rules, body.bucket.as_deref());
    blocking("the rules task", move || {
        let impact = rules
            .impact(&scope, &body.source)
            .map_err(|errors| not_compiled(&errors.iter().map(diagnostic).collect::<Vec<_>>()))?;
        Ok(StorageRulesImpact {
            considered: impact.considered,
            flips: impact
                .flips
                .into_iter()
                .map(|flip| StorageImpactFlip {
                    id: flip.id,
                    method: method_of(flip.operation),
                    bucket: flip.bucket,
                    path: flip.path,
                    uid: flip.uid,
                    before: flip.before.into(),
                    after: flip.after.into(),
                })
                .collect(),
        })
    })
    .await
    .map(Json)
}

/// `GET /storage/rules/coverage?bucket`: the official per-expression report
/// for the rules in force.
pub(crate) async fn coverage(
    State(routes): State<StorageRoutes>,
    Query(query): Query<BucketQuery>,
) -> Result<Response, ApiError> {
    let rules = routes.rules()?;
    let (scope, _) = routes.scope(&rules, query.bucket.as_deref());
    let report = blocking("the coverage task", move || {
        rules.coverage_report(&scope).map_err(|error| match error {
            CoverageError::Disabled => diagnostics_off(),
            CoverageError::NoRules => ApiError::not_found(
                "No rules are in force for this bucket, so there is no coverage.",
            ),
            other => ApiError::unavailable(format!("The coverage report is not ready: {other:?}.")),
        })
    })
    .await?;
    Ok(([(header::CONTENT_TYPE, "application/json")], report).into_response())
}

/// `POST /storage/rules/access`: what an identity may do with each object,
/// against the rules in force; nothing is recorded.
pub(crate) async fn access(
    State(routes): State<StorageRoutes>,
    ConsoleJson(body): ConsoleJson<StorageAccessBody>,
) -> Result<Json<StorageAccess>, ApiError> {
    if body.names.len() > firenook_storage_front::ACCESS_NAMES
        || body.methods.len() > firenook_storage_front::ACCESS_OPERATIONS
    {
        return Err(ApiError::invalid(format!(
            "An access check takes at most {} names and {} methods.",
            firenook_storage_front::ACCESS_NAMES,
            firenook_storage_front::ACCESS_OPERATIONS
        )));
    }
    let rules = routes.rules()?;
    blocking("the rules task", move || {
        let auth = body.auth.as_ref().map(|auth| RulesAuth {
            uid: (!auth.uid.is_empty()).then(|| auth.uid.clone()),
            token: auth.token.clone(),
        });
        let operations = body
            .methods
            .iter()
            .copied()
            .map(operation_of)
            .collect::<Vec<_>>();
        let rows = rules.access(
            &body.bucket,
            (body.authorization.as_deref(), auth.as_ref()),
            &body.names,
            &operations,
        );
        Ok(StorageAccess {
            results: rows
                .into_iter()
                .map(|row| StorageAccessResult {
                    name: row.name,
                    verdicts: row
                        .verdicts
                        .into_iter()
                        .map(|verdict| StorageAccessVerdict {
                            method: method_of(verdict.operation),
                            outcome: verdict.outcome.into(),
                            line: verdict.line,
                        })
                        .collect(),
                })
                .collect(),
        })
    })
    .await
    .map(Json)
}
