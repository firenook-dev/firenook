//! Native Storage Security Rules: rulesets compiled by `fireside-rules-engine`
//! and evaluated in process with the request model recorded from the official
//! emulator (`conformance/fixtures/storage-rules-v1`).

use std::collections::BTreeMap;
use std::fmt;
use std::sync::{Arc, RwLock};

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use fireside_rules_engine::{
    Auth, DocumentAccess, DocumentAccessError, EvaluationRequest, RequestOperation, Resource,
    Ruleset, StorageObject, Timestamp, Value, compile,
};
use serde_json::Value as JsonValue;

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

#[derive(Clone)]
enum RulesetTable {
    Single(Arc<Ruleset>),
    PerBucket(BTreeMap<String, Arc<Ruleset>>),
}

/// Installed rulesets and the document lookup they evaluate against.
#[derive(Clone)]
pub(crate) struct NativeRules {
    /// `None` after a failed reload: the official emulator drops the
    /// previous ruleset and refuses every request until a valid one loads
    /// (storage-rules-v1 lifecycle-set-rules).
    table: Arc<RwLock<Option<RulesetTable>>>,
    documents: Arc<dyn FirestoreDocuments>,
}

/// Outcome of one rules evaluation.
pub(crate) enum Verdict {
    Allowed,
    /// Denied; carries the runtime error text when evaluation failed.
    Denied(Option<String>),
    /// The bucket has no loaded ruleset.
    NoRuleset,
}

/// Which service operation a request performs.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Operation {
    Get,
    List,
    Create,
    Update,
    Delete,
}

impl Operation {
    pub(crate) const fn permission(self) -> &'static str {
        match self {
            Self::Get => "READ",
            Self::List => "LIST",
            Self::Create | Self::Update | Self::Delete => "WRITE",
        }
    }

    const fn request_operation(self) -> RequestOperation {
        match self {
            Self::Get => RequestOperation::Get,
            Self::List => RequestOperation::List,
            Self::Create => RequestOperation::Create,
            Self::Update => RequestOperation::Update,
            Self::Delete => RequestOperation::Delete,
        }
    }
}

impl NativeRules {
    pub(crate) fn start(config: &NativeRulesConfig) -> Result<Self, StorageError> {
        let table = compile_table(&config.source)?;
        Ok(Self {
            table: Arc::new(RwLock::new(Some(table))),
            documents: Arc::clone(&config.documents),
        })
    }

    /// Replaces every ruleset. A compile failure leaves no ruleset installed.
    pub(crate) fn replace(&self, source: &RulesSource) -> Result<(), StorageError> {
        let compiled = compile_table(source);
        let mut table = self
            .table
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        match compiled {
            Ok(compiled) => {
                *table = Some(compiled);
                Ok(())
            }
            Err(error) => {
                *table = None;
                Err(error)
            }
        }
    }

    /// Whether `bucket` currently has a ruleset.
    pub(crate) fn has_ruleset(&self, bucket: &str) -> bool {
        self.ruleset(bucket).is_some()
    }

    fn ruleset(&self, bucket: &str) -> Option<Arc<Ruleset>> {
        let table = self
            .table
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        match table.as_ref()? {
            RulesetTable::Single(ruleset) => Some(Arc::clone(ruleset)),
            RulesetTable::PerBucket(buckets) => buckets.get(bucket).cloned(),
        }
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
        let Some(ruleset) = self.ruleset(bucket) else {
            return Verdict::NoRuleset;
        };
        if operation == Operation::List && ruleset.rules_version() < 2 {
            return Verdict::Denied(Some(
                "Permission denied. List operations are only allowed for rules_version='2'."
                    .to_owned(),
            ));
        }
        let mut request =
            EvaluationRequest::storage(operation.request_operation(), rules_path(bucket, name), {
                let now = time::OffsetDateTime::now_utc();
                Timestamp::new(now.unix_timestamp(), now.nanosecond())
            });
        request.auth = auth_from_authorization(authorization);
        request.storage_resource = before.map(rules_object);
        request.storage_request_resource = after.map(rules_object);
        let access = Documents(&*self.documents);
        let result = ruleset.evaluate(&request, &access);
        if result.allowed {
            Verdict::Allowed
        } else {
            Verdict::Denied(result.error.map(|error| error.message))
        }
    }
}

struct Documents<'a>(&'a dyn FirestoreDocuments);

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

fn compile_table(source: &RulesSource) -> Result<RulesetTable, StorageError> {
    let compile_file = |name: &str, content: &str| {
        compile(content).map(Arc::new).map_err(|diagnostics| {
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
/// `oracleCrashNotRecordedLive`); Fireside evaluates the remaining segments.
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

fn json_value(value: &JsonValue) -> Value {
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
