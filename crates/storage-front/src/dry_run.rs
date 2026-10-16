//! Rules judged without a request being made: the playground, the console's
//! pre-upload check, the access column, and every re-run of a recorded
//! decision.
//!
//! A dry run builds its rules request through the same function a real
//! request does (`evaluation_request`) and its proposed object through the
//! real write path's own metadata code (`apply_metadata`, `rules_object`),
//! so the verdict it gives is the one a client would get. Nothing here is
//! recorded: no decision, no coverage.

use std::collections::BTreeMap;

use firenook_rules_engine::{
    AllowDecision, Auth, EvaluationRequest, ExplanationStep, StorageObject, Timestamp, Value,
};
use firenook_rules_runtime::DecisionOutcome;
use serde_json::{Map as JsonMap, Value as JsonValue, json};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use crate::decisions::NO_RULESET_MESSAGE;
use crate::rules::{
    InstalledRules, LIST_V1_MESSAGE, NativeRules, Operation, auth_from_authorization,
    evaluation_request, json_value, rules_object,
};
use crate::{StorageData, StoredObject, apply_metadata, etag, lock, object_key};

/// Per-request document reads the rules may make (`firestore.get()`).
pub const DOCUMENT_ACCESS_LIMIT: usize = 10;

/// `request.auth` given directly, as an identity picker or a recorded
/// decision supplies it.
#[derive(Clone, Debug, PartialEq)]
pub struct RulesAuth {
    /// `None` for a token without a `user_id` (`request.auth.uid == null`).
    pub uid: Option<String>,
    /// The token's claims, exactly as `request.auth.token` exposes them.
    pub token: JsonMap<String, JsonValue>,
}

/// What an upload or a metadata change proposes. Each standard field:
/// `None` leaves it, `Some(None)` clears it, `Some(Some(_))` sets it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ProposedObject {
    /// An upload's size in bytes.
    pub size: Option<u64>,
    pub content_type: Option<Option<String>>,
    pub cache_control: Option<Option<String>>,
    pub content_disposition: Option<Option<String>>,
    pub content_encoding: Option<Option<String>>,
    pub content_language: Option<Option<String>>,
    /// Keys to set (a value) or remove (`None`).
    pub custom_metadata: Option<BTreeMap<String, Option<String>>>,
}

/// An object as Storage rules see it: the official runtime's fourteen keys.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RulesObjectView {
    pub name: String,
    pub bucket: String,
    pub size: u64,
    pub content_type: Option<String>,
    pub content_disposition: Option<String>,
    pub content_encoding: Option<String>,
    pub metadata: BTreeMap<String, String>,
    /// A decimal string, as the protocol writes it.
    pub generation: String,
    pub metageneration: String,
    /// RFC 3339.
    pub time_created: String,
    pub updated: String,
    pub md5_hash: String,
    pub crc32c: String,
    pub etag: String,
}

impl RulesObjectView {
    pub(crate) fn of(object: &StorageObject) -> Self {
        Self {
            name: object.name.clone(),
            bucket: object.bucket.clone(),
            size: u64::try_from(object.size).unwrap_or(0),
            content_type: object.content_type.clone(),
            content_disposition: object.content_disposition.clone(),
            content_encoding: object.content_encoding.clone(),
            metadata: object.metadata.clone(),
            generation: object.generation.to_string(),
            metageneration: object.metageneration.to_string(),
            time_created: rfc3339(object.time_created),
            updated: rfc3339(object.updated),
            md5_hash: object.md5_hash.clone(),
            crc32c: object.crc32c.clone(),
            etag: object.etag.clone(),
        }
    }

    /// The stored object this view stands for, as the write path would hold
    /// it (fields the rules cannot see are left empty).
    fn stored(&self) -> StoredObject {
        StoredObject {
            name: self.name.clone(),
            bucket: self.bucket.clone(),
            generation: self.generation.parse().unwrap_or(0),
            metageneration: self.metageneration.parse().unwrap_or(1),
            content_type: self.content_type.clone(),
            storage_class: "STANDARD".to_owned(),
            content_disposition: self.content_disposition.clone(),
            content_encoding: self.content_encoding.clone(),
            content_language: None,
            cache_control: None,
            download_tokens: Vec::new(),
            custom_metadata: self.metadata.clone(),
            time_created: self.time_created.clone(),
            updated: self.updated.clone(),
            size: self.size,
            md5_hash: self.md5_hash.clone(),
            crc32c: self.crc32c.parse().unwrap_or(0),
            etag: self.etag.clone(),
            data_file: String::new(),
        }
    }
}

/// A dry run's `resource`: the store read now, an object that did not
/// exist, or the object as a recorded decision saw it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum RecordedObject {
    #[default]
    ReadStore,
    Missing,
    Object(Box<RulesObjectView>),
}

/// One request to judge without making it.
#[derive(Clone, Debug, PartialEq)]
pub struct DryRunRequest {
    pub method: Operation,
    pub bucket: String,
    /// The object name; for a list, the folder prefix.
    pub path: String,
    /// An `Authorization` value, decoded as the protocol decodes it.
    pub authorization: Option<String>,
    /// `request.auth` given directly; wins over `authorization`.
    pub auth: Option<RulesAuth>,
    /// Create and update: what is proposed.
    pub proposed: Option<ProposedObject>,
    /// A replay's `request.resource` exactly as recorded (its hashes and
    /// generation included, which a proposal cannot say); `proposed` edits
    /// apply on top of it. `None` builds it from `resource` and `proposed`.
    pub request_resource: Option<RulesObjectView>,
    pub resource: RecordedObject,
    /// `request.time`; now when absent.
    pub time: Option<OffsetDateTime>,
}

/// One allow statement an evaluation ran, placed as an editor places it.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DecisionAllow {
    pub line: usize,
    /// UTF-16 offset where the condition starts.
    pub from: usize,
    /// Exclusive UTF-16 end; equal to `from` for `allow read;`.
    pub to: usize,
    pub decision: AllowDecision,
}

/// What a dry run or a re-run decided, and why.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DryRunResult {
    pub outcome: DecisionOutcome,
    /// The evaluator's error, or why the request could not reach the rules.
    pub error: Option<String>,
    pub allows: Vec<DecisionAllow>,
    /// Every executed expression and its value, in evaluation order.
    pub explanation: Vec<ExplanationStep>,
    /// More expressions ran than `explanation` holds.
    pub truncated: bool,
    pub document_accesses: usize,
    pub document_access_limit: usize,
    pub resource: Option<RulesObjectView>,
    pub request_resource: Option<RulesObjectView>,
    /// Update: custom metadata keys added, removed or changed.
    pub changed_keys: Option<Vec<String>>,
}

impl DryRunResult {
    /// A request the rules never judged.
    pub(crate) fn refused(message: &str) -> Self {
        Self {
            outcome: DecisionOutcome::Error,
            error: Some(message.to_owned()),
            allows: Vec::new(),
            explanation: Vec::new(),
            truncated: false,
            document_accesses: 0,
            document_access_limit: DOCUMENT_ACCESS_LIMIT,
            resource: None,
            request_resource: None,
            changed_keys: None,
        }
    }
}

/// The rules request of a dry run, with the objects it carries.
pub(crate) struct Prepared {
    pub(crate) request: EvaluationRequest,
    resource: Option<RulesObjectView>,
    request_resource: Option<RulesObjectView>,
    changed_keys: Option<Vec<String>>,
}

/// Builds the rules request a client making `dry` would send.
pub(crate) fn prepare(data: &StorageData, dry: &DryRunRequest) -> Prepared {
    let time = dry.time.map_or_else(crate::rules::now, timestamp);
    let before = match &dry.resource {
        RecordedObject::ReadStore => data
            .objects
            .get(&object_key(&dry.bucket, &dry.path))
            .cloned(),
        RecordedObject::Missing => None,
        RecordedObject::Object(view) => Some(view.stored()),
    };
    let proposed = dry.proposed.clone().unwrap_or_default();
    let recorded = dry
        .request_resource
        .as_ref()
        .filter(|_| matches!(dry.method, Operation::Create | Operation::Update));
    let after = match dry.method {
        _ if recorded.is_some() => recorded.map(|view| {
            let mut object = view.stored();
            apply_metadata(&mut object, &patch(&proposed));
            if let Some(size) = proposed.size {
                object.size = size;
            }
            object
        }),
        Operation::Create => {
            let mut object = new_object(&dry.bucket, &dry.path, &proposed, time);
            if let Some(before) = &before {
                object.time_created.clone_from(&before.time_created);
            }
            apply_metadata(&mut object, &patch(&proposed));
            Some(object)
        }
        Operation::Update => before.as_ref().map(|before| {
            let mut object = before.clone();
            apply_metadata(&mut object, &patch(&proposed));
            object.metageneration = object.metageneration.saturating_add(1);
            object.updated = rfc3339(time);
            object.etag = etag(object.generation, object.metageneration);
            object
        }),
        Operation::Get | Operation::List | Operation::Delete => None,
    };
    let changed_keys = (dry.method == Operation::Update).then(|| {
        let empty = BTreeMap::new();
        let old = before
            .as_ref()
            .map_or(&empty, |object| &object.custom_metadata);
        let new = after
            .as_ref()
            .map_or(&empty, |object| &object.custom_metadata);
        let mut keys = old
            .keys()
            .chain(new.keys())
            .filter(|key| old.get(*key) != new.get(*key))
            .cloned()
            .collect::<Vec<_>>();
        keys.sort();
        keys.dedup();
        keys
    });
    let auth = dry.auth.as_ref().map_or_else(
        || auth_from_authorization(dry.authorization.as_deref()),
        |auth| {
            Some(Auth {
                uid: auth.uid.clone(),
                token: auth
                    .token
                    .iter()
                    .map(|(key, value)| (key.clone(), json_value(value)))
                    .collect(),
            })
        },
    );
    let resource = before.as_ref().map(rules_object);
    let request_resource = after.as_ref().map(rules_object);
    Prepared {
        resource: resource.as_ref().map(RulesObjectView::of),
        request_resource: request_resource.as_ref().map(RulesObjectView::of),
        request: evaluation_request(
            dry.method,
            &dry.bucket,
            &dry.path,
            resource,
            request_resource,
            auth,
            time,
        ),
        changed_keys,
    }
}

/// An upload's object before its metadata is applied, as the commit path
/// builds it: an absent type is `application/octet-stream`.
fn new_object(
    bucket: &str,
    name: &str,
    proposed: &ProposedObject,
    time: Timestamp,
) -> StoredObject {
    let generation = u64::try_from(time.seconds())
        .unwrap_or(0)
        .saturating_mul(1_000_000)
        .saturating_add(u64::from(time.nanoseconds() / 1_000));
    StoredObject {
        name: name.to_owned(),
        bucket: bucket.to_owned(),
        generation,
        metageneration: 1,
        content_type: Some("application/octet-stream".to_owned()),
        storage_class: "STANDARD".to_owned(),
        content_disposition: None,
        content_encoding: None,
        content_language: None,
        cache_control: None,
        download_tokens: Vec::new(),
        custom_metadata: BTreeMap::new(),
        time_created: rfc3339(time),
        updated: rfc3339(time),
        size: proposed.size.unwrap_or(0),
        md5_hash: String::new(),
        crc32c: 0,
        etag: etag(generation, 1),
        data_file: String::new(),
    }
}

/// The proposal as the JSON metadata body the write path applies.
fn patch(proposed: &ProposedObject) -> JsonValue {
    let mut body = JsonMap::new();
    for (field, value) in [
        ("contentType", &proposed.content_type),
        ("cacheControl", &proposed.cache_control),
        ("contentDisposition", &proposed.content_disposition),
        ("contentEncoding", &proposed.content_encoding),
        ("contentLanguage", &proposed.content_language),
    ] {
        if let Some(value) = value {
            body.insert(field.to_owned(), json!(value));
        }
    }
    if let Some(metadata) = &proposed.custom_metadata {
        body.insert(
            "metadata".to_owned(),
            JsonValue::Object(
                metadata
                    .iter()
                    .map(|(key, value)| (key.clone(), json!(value)))
                    .collect(),
            ),
        );
    }
    JsonValue::Object(body)
}

/// Judges prepared requests and explains each, never recording. `draft`
/// replaces the rules in force for every request.
pub(crate) fn evaluate(
    rules: &NativeRules,
    data: &std::sync::Mutex<StorageData>,
    requests: &[DryRunRequest],
    draft: Option<&std::sync::Arc<InstalledRules>>,
) -> Vec<DryRunResult> {
    // One explainer per ruleset, however many requests share it.
    let mut rulesets: Vec<std::sync::Arc<InstalledRules>> = Vec::new();
    let chosen = requests
        .iter()
        .map(|request| {
            let rules = draft
                .cloned()
                .or_else(|| rules.installed(&request.bucket))?;
            let position = rulesets
                .iter()
                .position(|known| std::sync::Arc::ptr_eq(known, &rules))
                .unwrap_or_else(|| {
                    rulesets.push(rules);
                    rulesets.len() - 1
                });
            Some(position)
        })
        .collect::<Vec<_>>();
    let explainers = rulesets
        .iter()
        .map(|rules| rules.ruleset.explainer())
        .collect::<Vec<_>>();
    requests
        .iter()
        .zip(chosen)
        .map(|(request, chosen)| {
            let Some(position) = chosen else {
                return DryRunResult::refused(NO_RULESET_MESSAGE);
            };
            let installed = &rulesets[position];
            let prepared = prepare(&lock(data), request);
            if request.method == Operation::List && installed.ruleset.rules_version() < 2 {
                return DryRunResult {
                    resource: prepared.resource,
                    ..DryRunResult::refused(LIST_V1_MESSAGE)
                };
            }
            explained(&explainers[position], &prepared, &rules.access())
        })
        .collect()
}

/// Judges a prepared request with every expression's value.
fn explained(
    explainer: &firenook_rules_engine::RulesExplainer<'_>,
    prepared: &Prepared,
    access: &crate::rules::Documents<'_>,
) -> DryRunResult {
    let (result, explanation) = explainer.evaluate(&prepared.request, access);
    DryRunResult {
        outcome: DecisionOutcome::of(&result),
        error: result.error.map(|error| error.message),
        allows: explanation
            .allows
            .iter()
            .map(|allow| DecisionAllow {
                line: allow.condition.line,
                from: allow.condition.from,
                to: allow.condition.to,
                decision: allow.decision,
            })
            .collect(),
        explanation: explanation.steps,
        truncated: explanation.truncated,
        document_accesses: result.document_accesses,
        document_access_limit: DOCUMENT_ACCESS_LIMIT,
        resource: prepared.resource.clone(),
        request_resource: prepared.request_resource.clone(),
        changed_keys: prepared.changed_keys.clone(),
    }
}

/// A recorded request judged again exactly as it was made, against the
/// ruleset that decided it, with every expression's value.
pub(crate) fn rerun(
    rules: &NativeRules,
    installed: &InstalledRules,
    request: &EvaluationRequest,
) -> DryRunResult {
    let resource = request.storage_resource.as_ref();
    let proposal = request.storage_request_resource.as_ref();
    let changed_keys =
        (request.operation == firenook_rules_engine::RequestOperation::Update).then(|| {
            let empty = BTreeMap::new();
            let old = resource.map_or(&empty, |object| &object.metadata);
            let new = proposal.map_or(&empty, |object| &object.metadata);
            let mut keys = old
                .keys()
                .chain(new.keys())
                .filter(|key| old.get(*key) != new.get(*key))
                .cloned()
                .collect::<Vec<_>>();
            keys.sort();
            keys.dedup();
            keys
        });
    if request.operation == firenook_rules_engine::RequestOperation::List
        && installed.ruleset.rules_version() < 2
    {
        return DryRunResult::refused(LIST_V1_MESSAGE);
    }
    let prepared = Prepared {
        request: request.clone(),
        resource: resource.map(RulesObjectView::of),
        request_resource: proposal.map(RulesObjectView::of),
        changed_keys,
    };
    explained(&installed.ruleset.explainer(), &prepared, &rules.access())
}

/// The dry run that replays a recorded request exactly: `resource` is the
/// object as it was, `proposed` rebuilt from the recorded
/// `request.resource`, `time` the recorded `request.time`.
pub(crate) fn replay(bucket: &str, name: &str, request: &EvaluationRequest) -> DryRunRequest {
    let before = request.storage_resource.as_ref();
    let proposed = request
        .storage_request_resource
        .as_ref()
        .map(|after| match before {
            Some(before)
                if request.operation == firenook_rules_engine::RequestOperation::Update =>
            {
                proposal_between(before, after)
            }
            _ => ProposedObject {
                size: Some(u64::try_from(after.size).unwrap_or(0)),
                content_type: Some(after.content_type.clone()),
                cache_control: None,
                content_disposition: Some(after.content_disposition.clone()),
                content_encoding: Some(after.content_encoding.clone()),
                content_language: None,
                custom_metadata: Some(
                    after
                        .metadata
                        .iter()
                        .map(|(key, value)| (key.clone(), Some(value.clone())))
                        .collect(),
                ),
            },
        });
    DryRunRequest {
        method: Operation::of_request(request.operation),
        bucket: bucket.to_owned(),
        path: name.to_owned(),
        authorization: None,
        auth: request.auth.as_ref().map(|auth| RulesAuth {
            uid: auth.uid.clone(),
            token: auth
                .token
                .iter()
                .map(|(key, value)| (key.clone(), value_json(value)))
                .collect(),
        }),
        proposed,
        request_resource: request
            .storage_request_resource
            .as_ref()
            .map(RulesObjectView::of),
        resource: before.map_or(RecordedObject::Missing, |object| {
            RecordedObject::Object(Box::new(RulesObjectView::of(object)))
        }),
        time: Some(offset(request.time)),
    }
}

/// The metadata change that turns `before` into `after`.
fn proposal_between(before: &StorageObject, after: &StorageObject) -> ProposedObject {
    let changed = |old: &Option<String>, new: &Option<String>| (old != new).then(|| new.clone());
    let mut custom = BTreeMap::new();
    for (key, value) in &after.metadata {
        if before.metadata.get(key) != Some(value) {
            custom.insert(key.clone(), Some(value.clone()));
        }
    }
    for key in before.metadata.keys() {
        if !after.metadata.contains_key(key) {
            custom.insert(key.clone(), None);
        }
    }
    ProposedObject {
        size: None,
        content_type: changed(&before.content_type, &after.content_type),
        cache_control: None,
        content_disposition: changed(&before.content_disposition, &after.content_disposition),
        content_encoding: changed(&before.content_encoding, &after.content_encoding),
        content_language: None,
        custom_metadata: (!custom.is_empty()).then_some(custom),
    }
}

/// A rules value as plain JSON (token claims are JSON to begin with).
pub(crate) fn value_json(value: &Value) -> JsonValue {
    match value {
        Value::Null => JsonValue::Null,
        Value::Bool(value) => JsonValue::Bool(*value),
        Value::Integer(value) => json!(value),
        Value::Float(value) => json!(value),
        Value::String(value) | Value::Path(value) => JsonValue::String(value.clone()),
        Value::List(values) => JsonValue::Array(values.iter().map(value_json).collect()),
        Value::Map(map) => JsonValue::Object(
            map.iter()
                .map(|(key, value)| (key.clone(), value_json(value)))
                .collect(),
        ),
        Value::Timestamp(time) => JsonValue::String(rfc3339(*time)),
        other => JsonValue::String(format!("{other:?}")),
    }
}

fn timestamp(time: OffsetDateTime) -> Timestamp {
    Timestamp::new(time.unix_timestamp(), time.nanosecond())
}

fn offset(time: Timestamp) -> OffsetDateTime {
    OffsetDateTime::from_unix_timestamp_nanos(
        i128::from(time.seconds()) * 1_000_000_000 + i128::from(time.nanoseconds()),
    )
    .unwrap_or(OffsetDateTime::UNIX_EPOCH)
}

fn rfc3339(time: Timestamp) -> String {
    offset(time)
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_owned())
}
