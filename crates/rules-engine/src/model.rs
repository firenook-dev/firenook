use std::collections::BTreeMap;
use std::error::Error;
use std::fmt;

use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

/// One value understood by Firestore Security Rules.
#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    /// The null value.
    Null,
    /// A boolean.
    Bool(bool),
    /// A signed 64-bit integer.
    Integer(i64),
    /// An IEEE-754 double.
    Float(f64),
    /// A UTF-8 string.
    String(String),
    /// An ordered list.
    List(Vec<Self>),
    /// A string-keyed map.
    Map(BTreeMap<String, Self>),
    /// A UTC timestamp.
    Timestamp(Timestamp),
    /// A signed duration.
    Duration(RulesDuration),
    /// An absolute Firestore document path.
    Path(String),
    /// Arbitrary bytes.
    Bytes(Vec<u8>),
    /// A latitude/longitude pair.
    LatLng(LatLng),
}

impl From<bool> for Value {
    fn from(value: bool) -> Self {
        Self::Bool(value)
    }
}

impl From<i64> for Value {
    fn from(value: i64) -> Self {
        Self::Integer(value)
    }
}

impl From<String> for Value {
    fn from(value: String) -> Self {
        Self::String(value)
    }
}

impl From<&str> for Value {
    fn from(value: &str) -> Self {
        Self::String(value.to_owned())
    }
}

/// A UTC timestamp with nanosecond precision.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub struct Timestamp {
    seconds: i64,
    nanoseconds: u32,
}

impl Timestamp {
    /// Creates a timestamp from Unix seconds and fractional nanoseconds.
    #[must_use]
    pub const fn new(seconds: i64, nanoseconds: u32) -> Self {
        Self {
            seconds,
            nanoseconds,
        }
    }

    /// Parses an RFC 3339 timestamp.
    ///
    /// # Errors
    ///
    /// Returns an error when the timestamp is malformed or outside the
    /// supported range.
    pub fn parse_rfc3339(value: &str) -> Result<Self, TimestampParseError> {
        let parsed = OffsetDateTime::parse(value, &Rfc3339)
            .map_err(|error| TimestampParseError(error.to_string()))?;
        Ok(Self::from_offset_date_time(parsed))
    }

    /// Returns Unix seconds.
    #[must_use]
    pub const fn seconds(self) -> i64 {
        self.seconds
    }

    /// Returns fractional nanoseconds.
    #[must_use]
    pub const fn nanoseconds(self) -> u32 {
        self.nanoseconds
    }

    pub(crate) fn from_offset_date_time(value: OffsetDateTime) -> Self {
        Self::new(value.unix_timestamp(), value.nanosecond())
    }

    pub(crate) fn to_offset_date_time(self) -> Result<OffsetDateTime, String> {
        OffsetDateTime::from_unix_timestamp_nanos(
            i128::from(self.seconds) * 1_000_000_000 + i128::from(self.nanoseconds),
        )
        .map_err(|error| error.to_string())
    }
}

/// Error returned when an RFC 3339 timestamp cannot be parsed.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TimestampParseError(String);

impl fmt::Display for TimestampParseError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl Error for TimestampParseError {}

/// A signed, normalized duration.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RulesDuration {
    /// Whole seconds.
    pub seconds: i64,
    /// Fractional nanoseconds in the range `0..1_000_000_000`.
    pub nanoseconds: i32,
}

impl RulesDuration {
    /// Creates a duration from a total number of nanoseconds.
    #[must_use]
    pub fn from_nanoseconds(total: i128) -> Self {
        let seconds = total.div_euclid(1_000_000_000);
        let nanoseconds = total.rem_euclid(1_000_000_000);
        Self {
            seconds: i64::try_from(seconds).unwrap_or(if seconds.is_negative() {
                i64::MIN
            } else {
                i64::MAX
            }),
            nanoseconds: i32::try_from(nanoseconds).unwrap_or_default(),
        }
    }

    pub(crate) fn total_nanoseconds(self) -> i128 {
        i128::from(self.seconds) * 1_000_000_000 + i128::from(self.nanoseconds)
    }
}

/// A geographic coordinate.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LatLng {
    /// Latitude in degrees.
    pub latitude: f64,
    /// Longitude in degrees.
    pub longitude: f64,
}

/// The document-shaped rules resource value.
#[derive(Clone, Debug, PartialEq)]
pub struct Resource {
    /// Canonical document name.
    pub name: String,
    /// Document fields.
    pub data: BTreeMap<String, Value>,
    /// Create time, when available.
    pub create_time: Option<Timestamp>,
    /// Update time, when available.
    pub update_time: Option<Timestamp>,
}

impl Resource {
    /// Creates a resource with document data and no explicit timestamps.
    #[must_use]
    pub fn new(name: impl Into<String>, data: BTreeMap<String, Value>) -> Self {
        Self {
            name: name.into(),
            data,
            create_time: None,
            update_time: None,
        }
    }
}

/// The Firebase service a ruleset is written for.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RulesService {
    /// `service cloud.firestore`: document paths under `/databases/…/documents`.
    CloudFirestore,
    /// `service firebase.storage`: object paths under `/b/{bucket}/o`.
    FirebaseStorage,
}

impl RulesService {
    /// Source spelling of the service head.
    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::CloudFirestore => "cloud.firestore",
            Self::FirebaseStorage => "firebase.storage",
        }
    }
}

/// The Cloud Storage object exposed as `resource` and `request.resource`
/// under `service firebase.storage`.
///
/// The field set is the fourteen keys the official emulator hands to the
/// rules runtime (`conformance/fixtures/storage-rules-v1`): `cacheControl`
/// and `contentLanguage` are never exposed; absent content fields are present
/// with a null value; custom metadata values are always strings.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StorageObject {
    /// Object name within the bucket, slashes included.
    pub name: String,
    /// Bucket name.
    pub bucket: String,
    /// Content generation.
    pub generation: i64,
    /// Metadata generation, starting at 1.
    pub metageneration: i64,
    /// Content length in bytes.
    pub size: i64,
    /// Creation time.
    pub time_created: Timestamp,
    /// Last metadata or content update.
    pub updated: Timestamp,
    /// Base64 MD5 digest of the content.
    pub md5_hash: String,
    /// Base64 CRC32C of the content.
    pub crc32c: String,
    /// Entity tag.
    pub etag: String,
    /// `Content-Disposition`, when set.
    pub content_disposition: Option<String>,
    /// `Content-Encoding`, when set.
    pub content_encoding: Option<String>,
    /// `Content-Type`, when set.
    pub content_type: Option<String>,
    /// Custom metadata, never including `firebaseStorageDownloadTokens`.
    pub metadata: BTreeMap<String, String>,
}

impl StorageObject {
    /// The rules value: a fourteen-key map with typed fields.
    #[must_use]
    pub fn to_value(&self) -> Value {
        let optional = |value: &Option<String>| {
            value
                .as_ref()
                .map_or(Value::Null, |value| Value::String(value.clone()))
        };
        let mut map = BTreeMap::new();
        map.insert("name".to_owned(), Value::String(self.name.clone()));
        map.insert("bucket".to_owned(), Value::String(self.bucket.clone()));
        map.insert("generation".to_owned(), Value::Integer(self.generation));
        map.insert(
            "metageneration".to_owned(),
            Value::Integer(self.metageneration),
        );
        map.insert("size".to_owned(), Value::Integer(self.size));
        map.insert(
            "timeCreated".to_owned(),
            Value::Timestamp(self.time_created),
        );
        map.insert("updated".to_owned(), Value::Timestamp(self.updated));
        map.insert("md5Hash".to_owned(), Value::String(self.md5_hash.clone()));
        map.insert("crc32c".to_owned(), Value::String(self.crc32c.clone()));
        map.insert("etag".to_owned(), Value::String(self.etag.clone()));
        map.insert(
            "contentDisposition".to_owned(),
            optional(&self.content_disposition),
        );
        map.insert(
            "contentEncoding".to_owned(),
            optional(&self.content_encoding),
        );
        map.insert("contentType".to_owned(), optional(&self.content_type));
        map.insert(
            "metadata".to_owned(),
            Value::Map(
                self.metadata
                    .iter()
                    .map(|(key, value)| (key.clone(), Value::String(value.clone())))
                    .collect(),
            ),
        );
        Value::Map(map)
    }
}

/// Emulator authentication exposed as `request.auth`.
#[derive(Clone, Debug, PartialEq)]
pub struct Auth {
    /// Firebase user identifier; `None` when the token carries no `user_id`
    /// claim (Storage exposes `request.auth.uid == null` then).
    pub uid: Option<String>,
    /// Token claims, excluding the synthesized `uid` field.
    pub token: BTreeMap<String, Value>,
}

/// Query constraints visible to rules.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Query {
    /// Requested limit.
    pub limit: Option<i64>,
    /// Requested offset.
    pub offset: Option<i64>,
    /// Requested sort directions.
    pub order_by: BTreeMap<String, String>,
    /// Potential result predicates; these are not a materialized document.
    pub filter: Option<QueryFilter>,
    /// Query path domain, independent of whether any document exists.
    pub scope: Option<QueryScope>,
}

/// Domain of document paths whose access a list request must prove.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum QueryScope {
    /// Direct children of a relative collection path.
    Collection(String),
    /// Any matching collection below the optional relative ancestor document.
    CollectionGroup {
        /// Collection ID at any descendant depth.
        collection_id: String,
        /// Optional ancestor document, relative to the database.
        ancestor: Option<String>,
    },
}

/// A constraint operator, kept separate from executable row filtering.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConstraintOperator {
    /// Exact equality.
    Equal,
    /// Strict lower bound.
    Greater,
    /// Inclusive lower bound.
    GreaterEqual,
    /// Strict upper bound.
    Less,
    /// Inclusive upper bound.
    LessEqual,
    /// Excluded scalar value.
    NotEqual,
    /// Every possible element must be authorized.
    In,
    /// Excluded scalar values.
    NotIn,
    /// A guaranteed member of an otherwise unknown array.
    ArrayContains,
    /// A disjunction of array membership guarantees.
    ArrayContainsAny,
}

/// A field predicate supplied by the client query.
#[derive(Clone, Debug, PartialEq)]
pub struct FieldConstraint {
    /// Decoded field path, preserving quoted segments.
    pub field: Vec<String>,
    /// Predicate operator.
    pub operator: ConstraintOperator,
    /// Typed operand, not a sample from a stored row.
    pub value: Value,
}

/// Boolean structure of a query's potential result set.
#[derive(Clone, Debug, PartialEq)]
pub enum QueryFilter {
    /// One field constraint.
    Field(FieldConstraint),
    /// All operands apply within a proof branch.
    And(Vec<Self>),
    /// Every alternative must be authorized.
    Or(Vec<Self>),
}

/// The concrete operation checked by an allow declaration.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RequestOperation {
    /// Fetch one document.
    Get,
    /// Read a query or collection.
    List,
    /// Create a new document.
    Create,
    /// Replace or update an existing document.
    Update,
    /// Delete an existing document.
    Delete,
}

/// One request evaluated against an installed ruleset.
#[derive(Clone, Debug, PartialEq)]
pub struct EvaluationRequest {
    /// Service whose value surface the request exposes.
    pub service: RulesService,
    /// Concrete operation.
    pub operation: RequestOperation,
    /// Canonical `/databases/.../documents/...` or `/b/{bucket}/o/...` path.
    pub path: String,
    /// Authenticated user, or `None` for an unauthenticated request.
    pub auth: Option<Auth>,
    /// Server request time.
    pub time: Timestamp,
    /// Existing document exposed as `resource` under Cloud Firestore.
    pub resource: Option<Resource>,
    /// Proposed document exposed as `request.resource` under Cloud Firestore.
    pub request_resource: Option<Resource>,
    /// Query shape exposed as `request.query` under Cloud Firestore.
    pub query: Query,
    /// Stored object exposed as `resource` under Firebase Storage.
    pub storage_resource: Option<StorageObject>,
    /// Proposed object exposed as `request.resource` under Firebase Storage.
    pub storage_request_resource: Option<StorageObject>,
}

impl EvaluationRequest {
    /// Creates a Cloud Firestore request with no authentication, resources,
    /// or query options.
    #[must_use]
    pub fn new(operation: RequestOperation, path: impl Into<String>, time: Timestamp) -> Self {
        Self {
            service: RulesService::CloudFirestore,
            operation,
            path: path.into(),
            auth: None,
            time,
            resource: None,
            request_resource: None,
            query: Query::default(),
            storage_resource: None,
            storage_request_resource: None,
        }
    }

    /// Creates a Firebase Storage request with no authentication or objects.
    /// `path` is `/b/{bucket}/o/{name}` (or `/b/{bucket}/o[/{prefix}]` for a
    /// list); empty segments must already be dropped by the caller.
    #[must_use]
    pub fn storage(operation: RequestOperation, path: impl Into<String>, time: Timestamp) -> Self {
        Self {
            service: RulesService::FirebaseStorage,
            ..Self::new(operation, path, time)
        }
    }
}

/// A storage lookup error surfaced to the rules runtime.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DocumentAccessError {
    message: String,
}

impl DocumentAccessError {
    /// Creates an access error.
    #[must_use]
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl fmt::Display for DocumentAccessError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl Error for DocumentAccessError {}

/// Snapshot-aware document access used by `get`, `exists`, and `getAfter`.
pub trait DocumentAccess {
    /// Returns the document visible in the request snapshot.
    ///
    /// # Errors
    ///
    /// Returns an error when storage cannot provide the snapshot value.
    fn get(&self, path: &str) -> Result<Option<Resource>, DocumentAccessError>;

    /// Returns the document after applying the atomic pending write set.
    ///
    /// # Errors
    ///
    /// Returns an error when storage cannot provide the post-write value.
    fn get_after(&self, path: &str) -> Result<Option<Resource>, DocumentAccessError>;
}

/// A document accessor that always reports a missing document.
#[derive(Clone, Copy, Debug, Default)]
pub struct EmptyDocumentAccess;

impl DocumentAccess for EmptyDocumentAccess {
    fn get(&self, _path: &str) -> Result<Option<Resource>, DocumentAccessError> {
        Ok(None)
    }

    fn get_after(&self, _path: &str) -> Result<Option<Resource>, DocumentAccessError> {
        Ok(None)
    }
}

/// Runtime failure that converts to a deny verdict.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeError {
    /// Stable human-readable failure text.
    pub message: String,
    pub(crate) expression_key: Option<crate::ExpressionKey>,
}

impl RuntimeError {
    pub(crate) fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            expression_key: None,
        }
    }

    /// Original expression that produced this error, preserved on propagation.
    /// Compiler and non-expression failures may not carry an expression key.
    #[must_use]
    pub const fn expression_key(&self) -> Option<crate::ExpressionKey> {
        self.expression_key
    }
}

impl fmt::Display for RuntimeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl Error for RuntimeError {}

/// Complete deterministic result of one rules evaluation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EvaluationResult {
    /// Whether at least one matching allow condition evaluated to true.
    pub allowed: bool,
    /// Runtime failure, if evaluation terminated with a deny.
    pub error: Option<RuntimeError>,
    /// Expression nodes evaluated before the verdict.
    pub evaluated_expressions: usize,
    /// Billable document accesses after cache elimination.
    pub document_accesses: usize,
    /// Repeated document access calls served from the per-request cache.
    pub document_cache_hits: usize,
    /// Matching allow declarations considered.
    pub matching_allows: usize,
}

/// Combined verdict and accounting for one transaction or batched write.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AtomicEvaluationResult {
    /// True only when every operation is allowed.
    pub allowed: bool,
    /// Per-operation verdicts in request order.
    pub operations: Vec<EvaluationResult>,
    /// Distinct access calls across the whole atomic request.
    pub document_accesses: usize,
    /// Access calls served by the shared atomic-request cache.
    pub document_cache_hits: usize,
}
