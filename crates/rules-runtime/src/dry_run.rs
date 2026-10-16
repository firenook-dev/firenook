//! Dry runs: one request evaluated the way a real client's would be — built by
//! the same code the serving fronts build theirs with — against a draft or
//! the rules in force, without committing anything, recording a Requests
//! event or feeding coverage.
//!
//! The fronts build an evaluator request from a store key, the current
//! document and a non-mutating write preview ([`evaluation_request`],
//! [`write_operation`], [`firenook_core_store::Snapshot::preview_writes`],
//! [`query_candidate`] and [`query_policy`]). A dry run goes through exactly
//! those, so its verdict is the verdict that client would get. Only a replay
//! of a recorded decision departs from the store: it supplies the document
//! as it was when the decision was made.

use std::sync::Arc;

use firenook_core_store::{
    DatabaseName, DocumentKey, FieldPath, Fields, Precondition, Snapshot,
    Timestamp as StoreTimestamp, Write, WritePreview,
};
use firenook_query_engine::Query;
use firenook_rules_engine::{
    Auth, DocumentAccess, DocumentAccessError, EvaluationRequest, RequestOperation, Resource,
    Ruleset,
};

use crate::{
    InstalledRules, LoadError, RulesQuery, RulesRuntime, SnapshotAccess, evaluation_request,
    query_candidate, query_policy, rules_path, rules_timestamp, store_value, write_operation,
};

/// The rules a dry run evaluates against.
#[derive(Clone)]
pub struct DryRunRules(Option<Arc<InstalledRules>>);

impl DryRunRules {
    /// The ruleset; `None` is the emulator's open-with-warning mode, in which
    /// every client request is allowed without evaluating anything.
    #[must_use]
    pub fn ruleset(&self) -> Option<&Ruleset> {
        self.0.as_deref().map(|installed| installed.rules.as_ref())
    }

    /// The stable hash of the source, as the Requests release key spells it.
    #[must_use]
    pub fn source_hash(&self) -> Option<&str> {
        self.0
            .as_deref()
            .map(|installed| installed.source_hash.as_str())
    }
}

impl RulesRuntime {
    /// Compiles `draft` without installing it anywhere, or, without one,
    /// takes the rules in force for `database`.
    pub fn dry_run_rules(
        &self,
        database: &DatabaseName,
        draft: Option<&str>,
    ) -> Result<DryRunRules, LoadError> {
        match draft {
            Some(source) => InstalledRules::compile(source).map(|rules| DryRunRules(Some(rules))),
            None => Ok(DryRunRules(self.installed_for(database))),
        }
    }
}

/// One operation to dry-run, already decoded from its wire shape.
#[derive(Clone, Debug)]
pub enum DryRunOperation {
    /// Read one document.
    Get(DocumentKey),
    /// Run a query, decoded exactly as `runQuery` decodes it.
    List {
        /// The database the query reads.
        database: DatabaseName,
        /// The decoded query.
        query: Box<Query>,
    },
    /// Create a document that must not exist yet.
    Create {
        /// The new document.
        key: DocumentKey,
        /// Its fields.
        fields: Fields,
    },
    /// Update an existing document: `fields` replace top-level keys, `remove`
    /// deletes top-level keys, every other key is kept.
    Update {
        /// The document.
        key: DocumentKey,
        /// Top-level keys to set.
        fields: Fields,
        /// Top-level keys to delete.
        remove: Vec<String>,
    },
    /// Delete a document, existing or not.
    Delete(DocumentKey),
}

/// A dry-run request: the operation, who asks, when, and — for a replay —
/// the document as it was.
#[derive(Clone, Debug)]
pub struct DryRunRequest {
    /// What is asked.
    pub operation: DryRunOperation,
    /// `request.auth`; `None` for an unauthenticated client.
    pub auth: Option<Auth>,
    /// `request.time`, and the update time a write would stamp.
    pub time: StoreTimestamp,
    /// The document before the operation as a replay recorded it
    /// (`Some(None)`: it did not exist); `None` reads the store now.
    pub before: Option<Option<Fields>>,
}

/// A request ready to evaluate, with the view its `get()`, `exists()` and
/// `getAfter()` calls read.
#[derive(Clone, Debug)]
pub struct PreparedRequest {
    /// The evaluator request.
    pub request: EvaluationRequest,
    /// The documents rule calls read.
    pub access: EvaluationAccess,
}

/// The operation would fail before the rules are consulted, as the real
/// write would: creating a document that exists, updating one that does not.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DryRunError(pub String);

/// What `get()`, `exists()` and `getAfter()` read in a dry run or a replay:
/// the current store, with the operation's own write applied for
/// `getAfter()`. A replay applies the write it recorded, so a document the
/// write produced reads as it did when the decision was made.
#[derive(Clone, Debug)]
pub struct EvaluationAccess {
    snapshot: SnapshotAccess,
    own_write: Option<(String, Option<Resource>)>,
}

impl EvaluationAccess {
    /// Reads of the current snapshot only.
    #[must_use]
    pub fn current(snapshot: Snapshot, project: &str) -> Self {
        Self {
            snapshot: SnapshotAccess::current(snapshot, project),
            own_write: None,
        }
    }

    /// The current snapshot, with `request`'s own proposed document standing
    /// in for its path after the write.
    #[must_use]
    pub fn replaying(snapshot: Snapshot, project: &str, request: &EvaluationRequest) -> Self {
        let writes = matches!(
            request.operation,
            RequestOperation::Create | RequestOperation::Update | RequestOperation::Delete
        );
        Self {
            snapshot: SnapshotAccess::current(snapshot, project),
            own_write: writes.then(|| (request.path.clone(), request.request_resource.clone())),
        }
    }
}

impl DocumentAccess for EvaluationAccess {
    fn get(&self, path: &str) -> Result<Option<Resource>, DocumentAccessError> {
        self.snapshot.get(path)
    }

    fn get_after(&self, path: &str) -> Result<Option<Resource>, DocumentAccessError> {
        match &self.own_write {
            Some((own, after)) if own == path => Ok(after.clone()),
            _ => self.snapshot.get_after(path),
        }
    }
}

/// Builds the evaluator request a real client's operation would produce,
/// reading the store for the document before unless a replay supplies it.
pub fn prepare_dry_run(
    snapshot: &Snapshot,
    request: DryRunRequest,
) -> Result<PreparedRequest, DryRunError> {
    let DryRunRequest {
        operation,
        auth,
        time,
        before,
    } = request;
    let mut prepared = match (operation, before) {
        (DryRunOperation::Get(key), before) => {
            let current = snapshot.get(&key);
            let mut request = evaluation_request(
                RequestOperation::Get,
                &key,
                time,
                current.as_deref(),
                None,
                RulesQuery::default(),
            );
            if let Some(before) = before {
                request.resource = before.map(|fields| recorded(&key, &fields, None, None));
            }
            PreparedRequest {
                request,
                access: EvaluationAccess::current(snapshot.clone(), key.database().project_id()),
            }
        }
        (DryRunOperation::List { database, query }, _) => {
            let candidate = query_candidate(&database, &query).map_err(DryRunError)?;
            let request = evaluation_request(
                RequestOperation::List,
                &candidate,
                time,
                None,
                None,
                query_policy(&query),
            );
            PreparedRequest {
                request,
                access: EvaluationAccess::current(snapshot.clone(), database.project_id()),
            }
        }
        (operation, None) => through_preview(snapshot, operation, time)?,
        (operation, Some(before)) => replayed_write(snapshot, operation, time, before)?,
    };
    prepared.request.auth = auth;
    Ok(prepared)
}

/// A write as the fronts evaluate one: the store's own non-mutating preview
/// supplies `request.resource` and `getAfter()`.
fn through_preview(
    snapshot: &Snapshot,
    operation: DryRunOperation,
    time: StoreTimestamp,
) -> Result<PreparedRequest, DryRunError> {
    let write = match operation {
        DryRunOperation::Create { key, fields } => {
            if snapshot.get(&key).is_some() {
                return Err(already_exists(&key));
            }
            Write::Create { key, fields }
        }
        DryRunOperation::Update {
            key,
            fields,
            remove,
        } => {
            if snapshot.get(&key).is_none() {
                return Err(missing(&key));
            }
            let update_mask = fields
                .keys()
                .chain(&remove)
                .map(|name| {
                    FieldPath::top(name.clone())
                        .map_err(|_| DryRunError(format!("{name:?} is not a field name")))
                })
                .collect::<Result<Vec<_>, _>>()?;
            Write::Patch {
                key,
                fields,
                update_mask,
                transforms: Vec::new(),
                precondition: Precondition::Exists(true),
            }
        }
        DryRunOperation::Delete(key) => Write::Delete {
            key,
            precondition: Precondition::None,
        },
        DryRunOperation::Get(_) | DryRunOperation::List { .. } => {
            unreachable!("reads are prepared without a write preview")
        }
    };
    let writes = std::slice::from_ref(&write);
    let preview = snapshot
        .preview_writes(writes, time)
        .map_err(|error| DryRunError(error.to_string()))?;
    let request = write_requests(writes, snapshot, &preview, time)
        .pop()
        .expect("one request per write");
    let project = request_project(&write);
    Ok(PreparedRequest {
        request,
        access: EvaluationAccess {
            snapshot: SnapshotAccess {
                snapshot: snapshot.clone(),
                preview: Some(preview),
                project,
            },
            own_write: None,
        },
    })
}

/// A recorded write replayed over the document it recorded, not the store's
/// current one: the after-document is the same top-level merge the store's
/// preview applies.
fn replayed_write(
    snapshot: &Snapshot,
    operation: DryRunOperation,
    time: StoreTimestamp,
    before: Option<Fields>,
) -> Result<PreparedRequest, DryRunError> {
    let (operation, key, after) = match operation {
        DryRunOperation::Create { key, fields } => {
            if before.is_some() {
                return Err(already_exists(&key));
            }
            let after = recorded(&key, &fields, Some(time), Some(time));
            (RequestOperation::Create, key, Some(after))
        }
        DryRunOperation::Update {
            key,
            fields,
            remove,
        } => {
            let Some(mut merged) = before.clone() else {
                return Err(missing(&key));
            };
            for name in &remove {
                merged.remove(name);
            }
            merged.extend(fields);
            let after = recorded(&key, &merged, None, Some(time));
            (RequestOperation::Update, key, Some(after))
        }
        DryRunOperation::Delete(key) => (RequestOperation::Delete, key, None),
        DryRunOperation::Get(_) | DryRunOperation::List { .. } => {
            unreachable!("reads are prepared without a write preview")
        }
    };
    let mut request = EvaluationRequest::new(operation, rules_path(&key), rules_timestamp(time));
    request.resource = before.map(|fields| recorded(&key, &fields, None, None));
    request.request_resource = after;
    let access =
        EvaluationAccess::replaying(snapshot.clone(), key.database().project_id(), &request);
    Ok(PreparedRequest { request, access })
}

/// The evaluator requests for an atomic write set, against the snapshot the
/// writes apply to and its preview. Shared by real writes and dry runs.
pub(crate) fn write_requests(
    writes: &[Write],
    snapshot: &Snapshot,
    preview: &WritePreview,
    time: StoreTimestamp,
) -> Vec<EvaluationRequest> {
    writes
        .iter()
        .map(|write| {
            let (operation, key) = write_operation(write, snapshot);
            let current = snapshot.get(&key);
            let proposed = preview.get(&key);
            evaluation_request(
                operation,
                &key,
                time,
                current.as_deref(),
                proposed.as_deref(),
                RulesQuery::default(),
            )
        })
        .collect()
}

/// A recorded document: its fields, with the store times a replay knows.
fn recorded(
    key: &DocumentKey,
    fields: &Fields,
    create_time: Option<StoreTimestamp>,
    update_time: Option<StoreTimestamp>,
) -> Resource {
    Resource {
        name: key.to_string(),
        data: fields
            .iter()
            .map(|(name, value)| (name.clone(), store_value(value)))
            .collect(),
        create_time: create_time.map(rules_timestamp),
        update_time: update_time.map(rules_timestamp),
    }
}

fn request_project(write: &Write) -> String {
    crate::write_key(write).database().project_id().to_owned()
}

fn already_exists(key: &DocumentKey) -> DryRunError {
    DryRunError(format!(
        "{} already exists, and a create needs a new document",
        key.path()
    ))
}

fn missing(key: &DocumentKey) -> DryRunError {
    DryRunError(format!(
        "{} does not exist, and an update needs an existing document",
        key.path()
    ))
}
