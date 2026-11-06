use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;

use firenook_core_store::{
    DatabaseName, DocumentKey, ListenerMemoryRegistration, Revision, RuntimeMemoryAccounting,
    Snapshot, SnapshotError, Store, Timestamp,
};
use firenook_query_engine::QueryPolicy;
use firenook_rules_runtime::{
    Authorization, RequestOperation, RulesQuery, RulesRuntime, SnapshotAccess, evaluation_request,
};
use firenook_watch_broker::{
    ChangeBatch, ChangeKind, TargetSpec, WatchChange, WatchDocument, WatchTarget,
};
use md5::{Digest as _, Md5};
use tokio::sync::{mpsc, watch};
use tokio::time::{MissedTickBehavior, interval};
use tokio_stream::wrappers::ReceiverStream;
use tokio_stream::{Stream, StreamExt as _};
use tonic::{Code, Status};

use crate::codec::{
    ReadTimeClass, classify_listen_read_time, decode_database_name, decode_document_name,
    decode_parent, encode_fields, encode_timestamp,
};
use crate::google::firestore::v1::listen_request::TargetChange as RequestedTargetChange;
use crate::google::firestore::v1::listen_response::ResponseType;
use crate::google::firestore::v1::target::ResumeType;
use crate::google::firestore::v1::target::TargetType;
use crate::google::firestore::v1::target::query_target::QueryType;
use crate::google::firestore::v1::target_change::TargetChangeType;
use crate::google::firestore::v1::{
    BitSequence, BloomFilter, DocumentChange, DocumentDelete, DocumentRemove, ExistenceFilter,
    ListenRequest, ListenResponse, Target, TargetChange,
};
use crate::google::rpc;
use crate::query_codec::{decode_query, query_status};
use crate::service::{
    AuthorizationSource, ReadPool, ResponseStream, require_atomic_rules_allowed,
    require_rules_allowed,
};

const POLL_INTERVAL: Duration = Duration::from_millis(1_000);
const RESPONSE_BUFFER: usize = 128;

enum ResumePoint {
    Revision(Revision),
    ReadTime(Timestamp),
    ExpiredReadTime,
    /// A token or read time that names no state of this store: empty, as the
    /// Android SDK sends for a new target, or kept by a device from another
    /// emulator or an earlier run of this one. The target starts over, as on
    /// the official emulator.
    Unknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum InitialFilter {
    None,
    UnchangedNames,
    CountOnly,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum InitialMode {
    Normal,
    Reset,
}

struct InitialTarget {
    watch: WatchTarget,
    changes: ChangeBatch,
    filter: InitialFilter,
    mode: InitialMode,
    token: Vec<u8>,
    read_time: Timestamp,
}

struct ActiveTarget {
    watch: WatchTarget,
    policy: TargetPolicy,
    authorization: Authorization,
}

enum TargetPolicy {
    Documents(Vec<DocumentKey>),
    Query {
        candidate: DocumentKey,
        query: RulesQuery,
    },
}

struct ListenContext<'a> {
    store: &'a Store,
    sender: &'a mpsc::Sender<Result<ListenResponse, Status>>,
    query_policy: &'a QueryPolicy,
    rules: &'a RulesRuntime,
    reads: &'a ReadPool,
    authorization: &'a AuthorizationSource,
}

struct TargetInitialization {
    id: i32,
    database: DatabaseName,
    spec: TargetSpec,
    resume_point: Option<ResumePoint>,
    expected_count: Option<i32>,
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn stream<S>(
    store: Store,
    query_policy: QueryPolicy,
    rules: RulesRuntime,
    reads: ReadPool,
    commits: watch::Receiver<u64>,
    authorization: AuthorizationSource,
    memory_accounting: RuntimeMemoryAccounting,
    input: S,
) -> ResponseStream<ListenResponse>
where
    S: Stream<Item = Result<ListenRequest, Status>> + Send + Unpin + 'static,
{
    let (sender, receiver) = mpsc::channel(RESPONSE_BUFFER);
    tokio::spawn(run(
        store,
        query_policy,
        rules,
        reads,
        commits,
        authorization,
        memory_accounting,
        input,
        sender,
    ));
    Box::pin(ReceiverStream::new(receiver))
}

#[allow(clippy::too_many_arguments)]
async fn run<S>(
    store: Store,
    query_policy: QueryPolicy,
    rules: RulesRuntime,
    reads: ReadPool,
    mut commits: watch::Receiver<u64>,
    authorization: AuthorizationSource,
    memory_accounting: RuntimeMemoryAccounting,
    mut input: S,
    sender: mpsc::Sender<Result<ListenResponse, Status>>,
) where
    S: Stream<Item = Result<ListenRequest, Status>> + Send + Unpin,
{
    let mut targets = BTreeMap::<i32, ActiveTarget>::new();
    let memory_registration = memory_accounting.register_listener_stream();
    let mut next_assigned_id = 1;
    // Streams wake on commits; the slow poll only guards against a missed
    // notification.
    let mut poll = interval(POLL_INTERVAL);
    poll.set_missed_tick_behavior(MissedTickBehavior::Skip);
    commits.mark_unchanged();

    loop {
        tokio::select! {
            request = input.next() => {
                match request {
                    Some(Ok(request)) => {
                        let context = ListenContext {
                            store: &store,
                            sender: &sender,
                            query_policy: &query_policy,
                            rules: &rules,
                            reads: &reads,
                            authorization: &authorization,
                        };
                        if let Err(error) = handle_request(
                            &context,
                            &mut targets,
                            &mut next_assigned_id,
                            request,
                        ).await {
                            let _ = sender.send(Err(error)).await;
                            break;
                        }
                        record_target_memory(&memory_registration, &targets);
                    }
                    None => break,
                    Some(Err(error)) => {
                        let _ = sender.send(Err(error)).await;
                        break;
                    }
                }
            }
            changed = commits.changed(), if !targets.is_empty() => {
                if changed.is_err() {
                    break;
                }
                commits.mark_unchanged();
                if let Err(error) = refresh_targets(&store, &rules, &reads, &sender, &mut targets).await {
                    let _ = sender.send(Err(error)).await;
                    break;
                }
                record_target_memory(&memory_registration, &targets);
            }
            _ = poll.tick(), if !targets.is_empty() => {
                if let Err(error) = refresh_targets(&store, &rules, &reads, &sender, &mut targets).await {
                    let _ = sender.send(Err(error)).await;
                    break;
                }
                record_target_memory(&memory_registration, &targets);
            }
        }
    }
}

fn record_target_memory(
    registration: &ListenerMemoryRegistration,
    targets: &BTreeMap<i32, ActiveTarget>,
) {
    let (documents, logical_bytes) =
        targets
            .values()
            .fold((0_u64, 0_u64), |(documents, logical_bytes), target| {
                let usage = target.watch.logical_memory_usage();
                (
                    documents.saturating_add(usage.entries),
                    logical_bytes.saturating_add(usage.logical_bytes),
                )
            });
    registration.update(
        u64::try_from(targets.len()).unwrap_or(u64::MAX),
        documents,
        logical_bytes,
    );
}

async fn handle_request(
    context: &ListenContext<'_>,
    targets: &mut BTreeMap<i32, ActiveTarget>,
    next_assigned_id: &mut i32,
    request: ListenRequest,
) -> Result<(), Status> {
    let database = decode_database_name(&request.database)?;
    match request.target_change {
        Some(RequestedTargetChange::AddTarget(target)) => {
            add_target(context, targets, next_assigned_id, database, target).await
        }
        Some(RequestedTargetChange::RemoveTarget(id)) => {
            targets.remove(&id);
            send_target_change(
                context.sender,
                TargetChangeType::Remove,
                vec![id],
                None,
                None,
            )
            .await
        }
        None => Err(Status::invalid_argument(
            "listen request requires a target change",
        )),
    }
}

#[allow(clippy::too_many_lines)]
async fn add_target(
    context: &ListenContext<'_>,
    targets: &mut BTreeMap<i32, ActiveTarget>,
    next_assigned_id: &mut i32,
    database: DatabaseName,
    target: Target,
) -> Result<(), Status> {
    let expected_count = target
        .expected_count
        .filter(|count| count.value > 0)
        .map(|count| count.value);
    let id = assign_target_id(target.target_id, next_assigned_id);
    if id <= 0 {
        return Err(Status::invalid_argument(
            "listen target ID must be positive",
        ));
    }
    if targets.contains_key(&id) {
        send_target_error(
            context.sender,
            id,
            Code::AlreadyExists,
            "target ID is already active",
        )
        .await?;
        return Ok(());
    }
    let resume_point = decode_resume_point(context.store, &target);
    let authorization = context.authorization.resolve()?;
    let (spec, policy) = match decode_target_spec(&database, target.target_type) {
        Ok(decoded) => decoded,
        Err(error) => {
            send_target_error(context.sender, id, error.code(), error.message()).await?;
            return Ok(());
        }
    };
    if let TargetSpec::Query(query) = &spec
        && let Err(error) = context.query_policy.validate(query)
    {
        send_target_error(
            context.sender,
            id,
            Code::FailedPrecondition,
            &error.to_string(),
        )
        .await?;
        return Ok(());
    }
    let snapshot = context.store.snapshot();
    if let Err(error) = authorize_target(context.rules, &authorization, &policy, &snapshot) {
        send_target_error(context.sender, id, error.code(), error.message()).await?;
        return Ok(());
    }
    // The first evaluation of a target is the largest read a listener makes;
    // it runs on the read pool like any other query.
    let initial = {
        let store = context.store.clone();
        let query_policy = context.query_policy.clone();
        let snapshot = snapshot.clone();
        let initialization = TargetInitialization {
            id,
            database,
            spec,
            resume_point,
            expected_count,
        };
        context
            .reads
            .run(move || {
                Ok(initialize_target(
                    &store,
                    &query_policy,
                    &snapshot,
                    initialization,
                ))
            })
            .await?
    };
    let initial = match initial {
        Ok(initial) => initial,
        Err(error) => {
            send_target_error(context.sender, id, error.code(), error.message()).await?;
            return Ok(());
        }
    };
    // InitialTarget emits stream-wide checkpoints, including an early one for
    // CountOnly. Advance every existing sibling through this SAME snapshot
    // first; a newer checkpoint must never skip an undelivered sibling change.
    refresh_targets_at_snapshot(
        context.store,
        &snapshot,
        context.rules,
        context.reads,
        context.sender,
        targets,
    )
    .await?;
    send_initial_target(context.sender, id, &initial).await?;
    if !target.once {
        targets.insert(
            id,
            ActiveTarget {
                watch: initial.watch,
                policy,
                authorization,
            },
        );
    }
    Ok(())
}

fn decode_resume_point(store: &Store, target: &Target) -> Option<ResumePoint> {
    Some(match target.resume_type.as_ref()? {
        ResumeType::ResumeToken(token) => {
            decode_resume_token(store, token).map_or(ResumePoint::Unknown, ResumePoint::Revision)
        }
        ResumeType::ReadTime(read_time) => match classify_listen_read_time(*read_time, now()) {
            Ok(ReadTimeClass::Retained(read_time)) => ResumePoint::ReadTime(read_time),
            Ok(ReadTimeClass::Expired(_)) => ResumePoint::ExpiredReadTime,
            Err(_) => ResumePoint::Unknown,
        },
    })
}

fn assign_target_id(requested: i32, next_assigned_id: &mut i32) -> i32 {
    if requested != 0 {
        return requested;
    }
    let assigned = *next_assigned_id;
    *next_assigned_id = next_assigned_id.saturating_add(1);
    assigned
}

fn initialize_target(
    store: &Store,
    query_policy: &QueryPolicy,
    snapshot: &Snapshot,
    initialization: TargetInitialization,
) -> Result<InitialTarget, Status> {
    let TargetInitialization {
        id,
        database,
        spec,
        resume_point,
        expected_count,
    } = initialization;
    let mut mode = InitialMode::Normal;
    let (watch, changes, filter) = match resume_point.as_ref() {
        Some(ResumePoint::Revision(revision)) => match store.snapshot_at(*revision) {
            Ok(baseline) => resumed_target(
                id,
                database,
                spec,
                query_policy,
                &baseline,
                snapshot,
                expected_count,
            )?,
            // The local replay floor is a bounded-memory policy, not a terminal
            // subscription error. Explicitly discard the unavailable baseline
            // before replaying this target only.
            Err(SnapshotError::ResetRequired(_) | SnapshotError::FutureRevision { .. }) => {
                mode = InitialMode::Reset;
                fresh_target(
                    id,
                    database,
                    spec,
                    query_policy,
                    snapshot,
                    InitialFilter::None,
                )?
            }
            Err(error) => return Err(resume_snapshot_status(error)),
        },
        Some(ResumePoint::Unknown) => {
            mode = InitialMode::Reset;
            fresh_target(
                id,
                database,
                spec,
                query_policy,
                snapshot,
                InitialFilter::None,
            )?
        }
        Some(ResumePoint::ReadTime(read_time)) => {
            let baseline = store
                .snapshot_at_time(*read_time)
                .map_err(resume_snapshot_status)?;
            resumed_target(
                id,
                database,
                spec,
                query_policy,
                &baseline,
                snapshot,
                expected_count,
            )?
        }
        Some(ResumePoint::ExpiredReadTime) => fresh_target(
            id,
            database,
            spec,
            query_policy,
            snapshot,
            InitialFilter::CountOnly,
        )?,
        None => fresh_target(
            id,
            database,
            spec,
            query_policy,
            snapshot,
            InitialFilter::None,
        )?,
    };
    let token = resume_token(store, changes.revision);
    Ok(InitialTarget {
        watch,
        changes,
        filter,
        mode,
        token,
        read_time: snapshot.read_time(),
    })
}

async fn send_initial_target(
    sender: &mpsc::Sender<Result<ListenResponse, Status>>,
    id: i32,
    initial: &InitialTarget,
) -> Result<(), Status> {
    send_target_change(sender, TargetChangeType::Add, vec![id], None, None).await?;
    if initial.mode == InitialMode::Reset {
        send_target_change(
            sender,
            TargetChangeType::Reset,
            vec![id],
            Some(initial.token.clone()),
            Some(initial.read_time),
        )
        .await?;
    }
    if initial.filter == InitialFilter::CountOnly {
        send_target_change(
            sender,
            TargetChangeType::NoChange,
            Vec::new(),
            Some(initial.token.clone()),
            Some(initial.read_time),
        )
        .await?;
    }
    for change in &initial.changes.changes {
        send_document_change(sender, id, change.clone(), initial.read_time).await?;
    }
    match initial.filter {
        InitialFilter::None => {}
        InitialFilter::UnchangedNames => {
            send_existence_filter(sender, id, &initial.watch).await?;
        }
        InitialFilter::CountOnly => {
            send_count_existence_filter(sender, id, &initial.watch).await?;
        }
    }
    send_target_change(
        sender,
        TargetChangeType::Current,
        vec![id],
        Some(initial.token.clone()),
        Some(initial.read_time),
    )
    .await?;
    send_target_change(
        sender,
        TargetChangeType::NoChange,
        Vec::new(),
        Some(initial.token.clone()),
        Some(initial.read_time),
    )
    .await?;
    Ok(())
}

fn fresh_target(
    id: i32,
    database: DatabaseName,
    spec: TargetSpec,
    query_policy: &QueryPolicy,
    snapshot: &Snapshot,
    filter: InitialFilter,
) -> Result<(WatchTarget, ChangeBatch, InitialFilter), Status> {
    let (watch, initial) =
        WatchTarget::initialize(id, database, spec, query_policy.edition(), snapshot)
            .map_err(|error| query_status(&error))?;
    Ok((watch, initial, filter))
}

fn resumed_target(
    id: i32,
    database: DatabaseName,
    spec: TargetSpec,
    query_policy: &QueryPolicy,
    baseline: &firenook_core_store::Snapshot,
    snapshot: &firenook_core_store::Snapshot,
    expected_count: Option<i32>,
) -> Result<(WatchTarget, ChangeBatch, InitialFilter), Status> {
    let (mut watch, _) =
        WatchTarget::initialize(id, database, spec, query_policy.edition(), baseline)
            .map_err(|error| query_status(&error))?;
    let baseline_count = i32::try_from(watch.document_keys().count()).unwrap_or(i32::MAX);
    let replay = watch
        .refresh(snapshot)
        .map_err(|error| query_status(&error))?;
    let initial_filter = if expected_count.is_some_and(|expected| expected != baseline_count) {
        InitialFilter::UnchangedNames
    } else {
        InitialFilter::None
    };
    Ok((watch, replay, initial_filter))
}

fn decode_target_spec(
    database: &DatabaseName,
    target_type: Option<TargetType>,
) -> Result<(TargetSpec, TargetPolicy), Status> {
    match target_type {
        Some(TargetType::Query(target)) => {
            let (target_database, parent) = decode_parent(&target.parent)?;
            if &target_database != database {
                return Err(Status::invalid_argument(
                    "listen query belongs to a different database",
                ));
            }
            let Some(QueryType::StructuredQuery(query)) = target.query_type else {
                return Err(Status::invalid_argument(
                    "listen target requires a structured query",
                ));
            };
            let query = decode_query(parent.as_deref(), query)?;
            let policy = TargetPolicy::Query {
                candidate: firenook_rules_runtime::query_candidate(database, &query)
                    .map_err(Status::invalid_argument)?,
                query: firenook_rules_runtime::query_policy(&query),
            };
            Ok((TargetSpec::Query(Box::new(query)), policy))
        }
        Some(TargetType::Documents(target)) => {
            let documents = target
                .documents
                .into_iter()
                .map(|name| {
                    let key = decode_document_name(&name)?;
                    if key.database() != database {
                        return Err(Status::invalid_argument(
                            "listen document belongs to a different database",
                        ));
                    }
                    Ok(key)
                })
                .collect::<Result<BTreeSet<_>, _>>()?;
            let policy = TargetPolicy::Documents(documents.iter().cloned().collect());
            Ok((TargetSpec::Documents(documents), policy))
        }
        None => Err(Status::invalid_argument("listen target type is required")),
    }
}

fn authorize_target(
    rules: &RulesRuntime,
    authorization: &Authorization,
    policy: &TargetPolicy,
    snapshot: &Snapshot,
) -> Result<(), Status> {
    match policy {
        TargetPolicy::Documents(documents) => {
            // A documents target names one database; an empty target has
            // nothing to authorize.
            let Some(database) = documents.first().map(DocumentKey::database) else {
                return Ok(());
            };
            let request_time = now();
            let requests = documents
                .iter()
                .map(|key| {
                    let document = snapshot.get(key);
                    evaluation_request(
                        RequestOperation::Get,
                        key,
                        request_time,
                        document.as_deref(),
                        None,
                        RulesQuery::default(),
                    )
                })
                .collect::<Vec<_>>();
            require_atomic_rules_allowed(&rules.evaluate_atomic(
                database,
                authorization,
                &requests,
                &SnapshotAccess::current(snapshot.clone(), database.project_id()),
            ))
        }
        TargetPolicy::Query { candidate, query } => {
            let request = evaluation_request(
                RequestOperation::List,
                candidate,
                now(),
                None,
                None,
                query.clone(),
            );
            require_rules_allowed(&rules.evaluate(
                candidate.database(),
                authorization,
                &request,
                &SnapshotAccess::current(snapshot.clone(), candidate.database().project_id()),
            ))
        }
    }
}

async fn refresh_targets(
    store: &Store,
    rules: &RulesRuntime,
    reads: &ReadPool,
    sender: &mpsc::Sender<Result<ListenResponse, Status>>,
    targets: &mut BTreeMap<i32, ActiveTarget>,
) -> Result<(), Status> {
    let snapshot = store.snapshot();
    if refresh_targets_at_snapshot(store, &snapshot, rules, reads, sender, targets).await? {
        send_target_change(
            sender,
            TargetChangeType::NoChange,
            Vec::new(),
            Some(resume_token(store, snapshot.revision())),
            Some(snapshot.read_time()),
        )
        .await?;
    }
    Ok(())
}

/// One target's outcome from a refresh: its deltas, or the rules error that
/// removes it from the stream.
enum TargetRefresh {
    Changes(ChangeBatch),
    Denied(Status),
}

// Emit target-local deltas/removals only. The caller owns the checkpoint, so
// adding a target cannot accidentally certify a second, later snapshot.
async fn refresh_targets_at_snapshot(
    store: &Store,
    snapshot: &Snapshot,
    rules: &RulesRuntime,
    reads: &ReadPool,
    sender: &mpsc::Sender<Result<ListenResponse, Status>>,
    targets: &mut BTreeMap<i32, ActiveTarget>,
) -> Result<bool, Status> {
    if targets
        .values()
        .all(|target| target.watch.revision() >= snapshot.revision())
    {
        return Ok(false);
    }
    // Read a single bounded change history covering every target. Concurrent
    // commits may extend it beyond `snapshot`; the broker caps it by revision.
    // An expired history forces full refresh, never a guessed unchanged view.
    let history = targets
        .values()
        .map(|target| target.watch.revision())
        .min()
        .and_then(|after| store.changes_since(after).ok());
    // Rules checks and re-evaluations run on the read pool; the stream task
    // only sends what they produced. The targets are lent to the pool and
    // handed back; a failed refresh ends the stream anyway.
    let mut lent = std::mem::take(targets);
    let rules = rules.clone();
    let snapshot_for_refresh = snapshot.clone();
    let (lent, outcomes) = reads
        .run(move || {
            let mut outcomes = Vec::new();
            for target in lent.values_mut() {
                if target.watch.revision() >= snapshot_for_refresh.revision() {
                    continue;
                }
                let id = target.watch.id();
                if let Err(error) = authorize_target(
                    &rules,
                    &target.authorization,
                    &target.policy,
                    &snapshot_for_refresh,
                ) {
                    outcomes.push((id, TargetRefresh::Denied(error)));
                    continue;
                }
                let batch = target
                    .watch
                    .refresh_with_changes(&snapshot_for_refresh, history.as_deref())
                    .map_err(|error| query_status(&error))?;
                outcomes.push((id, TargetRefresh::Changes(batch)));
            }
            Ok((lent, outcomes))
        })
        .await?;
    *targets = lent;
    let mut changed = false;
    for (id, outcome) in outcomes {
        match outcome {
            TargetRefresh::Denied(error) => {
                send_target_error(sender, id, error.code(), error.message()).await?;
                targets.remove(&id);
            }
            TargetRefresh::Changes(batch) => {
                for change in batch.changes {
                    changed = true;
                    send_document_change(sender, id, change, snapshot.read_time()).await?;
                }
            }
        }
    }
    Ok(changed)
}

async fn send_document_change(
    sender: &mpsc::Sender<Result<ListenResponse, Status>>,
    target_id: i32,
    change: WatchChange,
    read_time: Timestamp,
) -> Result<(), Status> {
    let response_type = match change.kind {
        ChangeKind::Upsert => ResponseType::DocumentChange(DocumentChange {
            document: Some(encode_watch_document(
                change
                    .document
                    .as_ref()
                    .ok_or_else(|| Status::internal("upsert has no document"))?,
            )?),
            target_ids: vec![target_id],
            removed_target_ids: Vec::new(),
        }),
        ChangeKind::Delete => ResponseType::DocumentDelete(DocumentDelete {
            document: change.key.to_string(),
            removed_target_ids: vec![target_id],
            read_time: Some(encode_timestamp(read_time)),
        }),
        ChangeKind::Remove => ResponseType::DocumentRemove(DocumentRemove {
            document: change.key.to_string(),
            removed_target_ids: vec![target_id],
            read_time: Some(encode_timestamp(read_time)),
        }),
    };
    send(
        sender,
        ListenResponse {
            response_type: Some(response_type),
        },
    )
    .await
}

async fn send_existence_filter(
    sender: &mpsc::Sender<Result<ListenResponse, Status>>,
    target_id: i32,
    target: &WatchTarget,
) -> Result<(), Status> {
    let names = target
        .document_keys()
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    let count = i32::try_from(names.len()).unwrap_or(i32::MAX);
    send(
        sender,
        ListenResponse {
            response_type: Some(ResponseType::Filter(ExistenceFilter {
                target_id,
                count,
                unchanged_names: Some(unchanged_names_bloom_filter(&names)?),
            })),
        },
    )
    .await
}

async fn send_count_existence_filter(
    sender: &mpsc::Sender<Result<ListenResponse, Status>>,
    target_id: i32,
    target: &WatchTarget,
) -> Result<(), Status> {
    let count = i32::try_from(target.document_keys().count()).unwrap_or(i32::MAX);
    send(
        sender,
        ListenResponse {
            response_type: Some(ResponseType::Filter(ExistenceFilter {
                target_id,
                count,
                unchanged_names: Some(BloomFilter {
                    bits: Some(BitSequence {
                        bitmap: Vec::new(),
                        padding: 0,
                    }),
                    hash_count: 0,
                }),
            })),
        },
    )
    .await
}

fn unchanged_names_bloom_filter(names: &[String]) -> Result<BloomFilter, Status> {
    if names.is_empty() {
        return Ok(BloomFilter {
            bits: Some(BitSequence {
                bitmap: Vec::new(),
                padding: 0,
            }),
            hash_count: 0,
        });
    }

    let bit_count = names
        .len()
        .checked_mul(24)
        .and_then(|bits| bits.checked_add(5))
        .ok_or_else(|| Status::resource_exhausted("existence-filter bloom size overflow"))?;
    let byte_count = bit_count.div_ceil(8);
    let bit_count_u64 = u64::try_from(bit_count)
        .map_err(|_| Status::resource_exhausted("existence-filter bloom size overflow"))?;
    let count = u128::try_from(names.len()).unwrap_or(u128::MAX);
    let hashes = ((u128::try_from(bit_count).unwrap_or(u128::MAX) * 693 + count * 500)
        / (count * 1_000))
        .max(1);
    let hash_count = i32::try_from(hashes).unwrap_or(i32::MAX);
    let mut bitmap = vec![0_u8; byte_count];

    for name in names {
        let digest = Md5::digest(name.as_bytes());
        let first = u64::from_le_bytes(
            digest[..8]
                .try_into()
                .expect("MD5 has a fixed 16-byte output"),
        );
        let second = u64::from_le_bytes(
            digest[8..]
                .try_into()
                .expect("MD5 has a fixed 16-byte output"),
        );
        for index in 0..u64::try_from(hash_count).unwrap_or(u64::MAX) {
            let bit = first.wrapping_add(index.wrapping_mul(second)) % bit_count_u64;
            let byte = usize::try_from(bit / 8).expect("bit index fits allocated bitmap");
            bitmap[byte] |= 1 << (bit % 8);
        }
    }

    let padding = i32::try_from(byte_count * 8 - bit_count).expect("padding is at most seven");
    Ok(BloomFilter {
        bits: Some(BitSequence { bitmap, padding }),
        hash_count,
    })
}

fn encode_watch_document(
    document: &WatchDocument,
) -> Result<crate::google::firestore::v1::Document, Status> {
    Ok(crate::google::firestore::v1::Document {
        name: document.key().to_string(),
        fields: encode_fields(document.fields())?,
        create_time: Some(encode_timestamp(document.document().create_time())),
        update_time: Some(encode_timestamp(document.document().update_time())),
    })
}

async fn send_target_change(
    sender: &mpsc::Sender<Result<ListenResponse, Status>>,
    change_type: TargetChangeType,
    target_ids: Vec<i32>,
    token: Option<Vec<u8>>,
    read_time: Option<firenook_core_store::Timestamp>,
) -> Result<(), Status> {
    send(
        sender,
        ListenResponse {
            response_type: Some(ResponseType::TargetChange(TargetChange {
                target_change_type: change_type as i32,
                target_ids,
                cause: None,
                resume_token: token.unwrap_or_default(),
                read_time: read_time.map(encode_timestamp),
            })),
        },
    )
    .await
}

async fn send_target_error(
    sender: &mpsc::Sender<Result<ListenResponse, Status>>,
    target_id: i32,
    code: Code,
    message: &str,
) -> Result<(), Status> {
    send(
        sender,
        ListenResponse {
            response_type: Some(ResponseType::TargetChange(TargetChange {
                target_change_type: TargetChangeType::Remove as i32,
                target_ids: vec![target_id],
                cause: Some(rpc::Status {
                    code: code as i32,
                    message: message.to_owned(),
                    details: Vec::new(),
                }),
                resume_token: Vec::new(),
                read_time: None,
            })),
        },
    )
    .await
}

async fn send(
    sender: &mpsc::Sender<Result<ListenResponse, Status>>,
    response: ListenResponse,
) -> Result<(), Status> {
    sender
        .send(Ok(response))
        .await
        .map_err(|_| Status::cancelled("listen client disconnected"))
}

const RESUME_TOKEN_PREFIX: &[u8] = b"firenook-resume-";

/// Names a revision of this opened store, so a token kept from an earlier run,
/// which may count the same revisions over different data, is not taken for one.
fn resume_token(store: &Store, revision: Revision) -> Vec<u8> {
    let mut token = RESUME_TOKEN_PREFIX.to_vec();
    token.extend_from_slice(&store.instance().to_be_bytes());
    token.extend_from_slice(&revision.get().to_be_bytes());
    token
}

/// The revision a token names, if this store issued it.
fn decode_resume_token(store: &Store, token: &[u8]) -> Option<Revision> {
    let issued = token.strip_prefix(RESUME_TOKEN_PREFIX)?;
    let (instance, revision) = issued.split_first_chunk::<8>()?;
    let revision = <[u8; 8]>::try_from(revision).ok()?;
    (u64::from_be_bytes(*instance) == store.instance())
        .then(|| Revision::from_u64(u64::from_be_bytes(revision)))
}

fn resume_snapshot_status(error: SnapshotError) -> Status {
    match error {
        SnapshotError::ResetRequired(_) | SnapshotError::ReadTimeExpired { .. } => {
            Status::failed_precondition("listen resume token has expired")
        }
        SnapshotError::FutureRevision { .. } => Status::invalid_argument(error.to_string()),
    }
}

fn now() -> firenook_core_store::Timestamp {
    use std::time::{SystemTime, UNIX_EPOCH};

    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    firenook_core_store::Timestamp::new(
        i64::try_from(duration.as_secs()).unwrap_or(i64::MAX),
        duration.subsec_nanos(),
    )
    .expect("system time is a valid timestamp")
}

#[cfg(test)]
mod global_checkpoint_baseline_tests;

#[cfg(test)]
mod resume_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_resume_token_decodes_only_on_the_store_that_issued_it() {
        let store = Store::default();
        let revision = Revision::from_u64(42);
        let issued = resume_token(&store, revision);
        assert_eq!(decode_resume_token(&store, &issued), Some(revision));
        assert_eq!(decode_resume_token(&Store::default(), &issued), None);
        assert_eq!(
            decode_resume_token(&store, &issued[..issued.len() - 1]),
            None
        );
        assert_eq!(decode_resume_token(&store, b"other-resume-"), None);
    }

    #[test]
    fn bloom_dimensions_match_the_cloud_existence_filter_fixture() {
        let one = unchanged_names_bloom_filter(&["documents/alpha".to_owned()])
            .expect("one-name filter should build");
        let one_bits = one.bits.expect("filter bits should exist");
        assert_eq!(one_bits.bitmap.len(), 4);
        assert_eq!(one_bits.padding, 3);
        assert_eq!(one.hash_count, 20);

        let two = unchanged_names_bloom_filter(&[
            "documents/alpha".to_owned(),
            "documents/beta".to_owned(),
        ])
        .expect("two-name filter should build");
        let two_bits = two.bits.expect("filter bits should exist");
        assert_eq!(two_bits.bitmap.len(), 7);
        assert_eq!(two_bits.padding, 3);
        assert_eq!(two.hash_count, 18);
    }

    #[test]
    fn bundle_nanosecond_read_time_becomes_an_expired_listen_resume_point() {
        let target = Target {
            resume_type: Some(ResumeType::ReadTime(pbjson_types::Timestamp {
                seconds: 1_000,
                nanos: 9_999,
            })),
            ..Target::default()
        };

        assert!(matches!(
            decode_resume_point(&Store::default(), &target),
            Some(ResumePoint::ExpiredReadTime)
        ));
    }
}
