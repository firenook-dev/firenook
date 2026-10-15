//! The broker's read models as the console API's types, and the join of a
//! message's fanout with compute's record of invocations (the function
//! marks and delivery rows).

use std::collections::{BTreeMap, HashMap};
use std::time::SystemTime;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use firenook_functions_runtime::Monitor;
use firenook_functions_runtime::monitor::{
    FunctionKind, FunctionLogLevel, InvocationOutcomeClass, InvocationSummary, MonitorView,
};
use firenook_pubsub_front::broker::inspect::{
    BacklogRow, BacklogState, HistoryRow, MessageAtSubscription, MessageView, PayloadEncoding,
    PayloadPreview, SchemaDetail, SchemaSummary, SubscriptionCountersView, SubscriptionSummary,
    SubscriptionView, TopicCounters, TopicSummary, TopicView,
};
use firenook_pubsub_front::broker::{Fanout, FanoutSkip, FanoutTarget, MessageMark, StoredMessage};
use firenook_pubsub_front::{
    FunctionTarget, Managed, PushStreakRecord, Rejection, RunTrigger, ScheduleDetail, ScheduleRun,
    TargetKind,
};
use time::OffsetDateTime;

use super::types::{
    PubsubBacklogRow, PubsubBacklogState, PubsubConsumers, PubsubDeadLetter,
    PubsubDeadLetterSource, PubsubDeliveryRow, PubsubDeliverySummary, PubsubFunctionMark,
    PubsubFunctionMarkAt, PubsubFunctionTarget, PubsubHistoryWindow, PubsubManaged,
    PubsubMessageAt, PubsubMessageAtSubscription, PubsubMessageDetail, PubsubMessageRow,
    PubsubMessageSchema, PubsubMessageState, PubsubMostBehind, PubsubPayloadEncoding,
    PubsubPayloadPreview, PubsubPushStreak, PubsubRejected, PubsubRetry, PubsubSchedule,
    PubsubScheduleRun, PubsubSchemaDetail, PubsubSchemaRevision, PubsubSchemaSummary,
    PubsubSchemaUse, PubsubSubscription, PubsubSubscriptionCounters, PubsubSubscriptionSummary,
    PubsubTargetKind, PubsubTopicCounters, PubsubTopicDetail, PubsubTopicKind, PubsubTopicSchema,
    PubsubTopicSummary,
};
use crate::entity::EntityRef;
use crate::messaging::shared::{millis, second_window, time, time_of, u32_of};

/// Why a delivery was not sent while background triggers were off.
const SKIPPED_BACKGROUND: &str = "Background triggers were paused, so the event was dropped.";

/// A time as the scheduler keeps it, as the API writes it.
pub(crate) fn odt(at: OffsetDateTime) -> String {
    time(SystemTime::from(at))
}

/// What the topic pages know besides the broker: who listens on each topic
/// and which topics are schedules'.
#[derive(Clone, Debug, Default)]
pub(crate) struct Targets {
    /// Function targets by topic full name.
    pub(crate) by_topic: BTreeMap<String, Vec<FunctionTarget>>,
    /// Scheduled function ids by their synthetic topic's full name.
    pub(crate) schedules: BTreeMap<String, Vec<String>>,
}

impl Targets {
    fn of(&self, topic: &str) -> &[FunctionTarget] {
        self.by_topic.get(topic).map_or(&[], Vec::as_slice)
    }

    /// A function's name, as the targets know it (a function no longer
    /// listening keeps its id).
    pub(crate) fn name(&self, topic: &str, function_id: &str) -> String {
        self.of(topic)
            .iter()
            .find(|target| target.function_id == function_id)
            .map_or_else(|| function_id.to_owned(), |target| target.name.clone())
    }

    /// The monitor's kind of a function's deliveries on `topic`.
    fn kind(&self, topic: &str, function_id: &str) -> FunctionKind {
        let schedule = self
            .of(topic)
            .iter()
            .find(|target| target.function_id == function_id)
            .map_or_else(
                || self.schedules.contains_key(topic),
                |target| target.kind == TargetKind::Schedule,
            );
        if schedule {
            FunctionKind::Schedule
        } else {
            FunctionKind::Pubsub
        }
    }
}

pub(crate) fn function_target(target: &FunctionTarget) -> PubsubFunctionTarget {
    PubsubFunctionTarget {
        function_id: target.function_id.clone(),
        name: target.name.clone(),
        region: target.region.clone(),
        kind: match target.kind {
            TargetKind::CloudEvent => PubsubTargetKind::Cloudevent,
            TargetKind::Legacy => PubsubTargetKind::Legacy,
            TargetKind::Schedule => PubsubTargetKind::Schedule,
        },
        entity: EntityRef::function(&target.function_id),
    }
}

pub(crate) fn managed(managed: Managed) -> PubsubManaged {
    match managed {
        Managed::No => PubsubManaged::No,
        Managed::Functions => PubsubManaged::Functions,
        Managed::Orphaned => PubsubManaged::Orphaned,
    }
}

pub(crate) fn topic_counters(counters: &TopicCounters) -> PubsubTopicCounters {
    PubsubTopicCounters {
        name: counters.name.clone(),
        published: counters.published,
        last_published_at: time_of(counters.last_published_at),
        latest_message_id: counters.latest_id.map(|id| id.to_string()),
        most_behind: counters
            .most_behind
            .as_ref()
            .map(|behind| PubsubMostBehind {
                subscription: behind.subscription.clone(),
                backlog: behind.backlog,
            }),
    }
}

pub(crate) fn subscription_counters(view: &SubscriptionCountersView) -> PubsubSubscriptionCounters {
    let counts = &view.counts;
    PubsubSubscriptionCounters {
        name: view.name.clone(),
        backlog: counts.available + counts.outstanding + counts.pushing,
        available: counts.available,
        outstanding: counts.outstanding,
        pushing: counts.pushing,
        retained_acked: counts.retained_acked,
        backlog_bytes: counts.backlog_bytes,
        oldest_unacked_at: time_of(counts.oldest_unacked_at),
        redelivered: counts.redelivered,
        acked_total: counts.acked_total,
        dead_lettered_total: counts.dead_lettered_total,
        blocked_keys: counts.blocked_keys,
        consumers: PubsubConsumers {
            streaming: view.consumers.streaming,
            waiting_pulls: view.consumers.waiting,
            last_pull_at: time_of(view.last_pull_at),
        },
    }
}

pub(crate) fn subscription_summary(
    summary: &SubscriptionSummary,
    managed_by: &dyn Fn(&str) -> Managed,
) -> PubsubSubscriptionSummary {
    PubsubSubscriptionSummary {
        name: summary.name.clone(),
        project: summary.project.clone(),
        id: summary.id.clone(),
        topic: summary.topic.clone(),
        delivery: if summary.push { "push" } else { "pull" }.to_owned(),
        managed: managed(managed_by(&summary.name)),
        ordering: summary.ordering,
        exactly_once: summary.exactly_once,
        dead_letter_topic: summary.dead_letter_topic.clone(),
        filter: summary.filter.clone(),
        counters: subscription_counters(&summary.counters),
    }
}

pub(crate) fn topic_summary(
    summary: &TopicSummary,
    targets: &Targets,
    managed_by: &dyn Fn(&str) -> Managed,
) -> PubsubTopicSummary {
    let schedule = targets.schedules.get(&summary.name);
    PubsubTopicSummary {
        name: summary.name.clone(),
        project: summary.project.clone(),
        id: summary.id.clone(),
        kind: if schedule.is_some() {
            PubsubTopicKind::Schedule
        } else {
            PubsubTopicKind::User
        },
        schedule_function: schedule.and_then(|ids| ids.first().cloned()),
        schema: summary.schema.clone(),
        counters: topic_counters(&summary.counters),
        subscriptions: summary
            .subscriptions
            .iter()
            .map(|subscription| subscription_summary(subscription, managed_by))
            .collect(),
        functions: targets
            .of(&summary.name)
            .iter()
            .map(function_target)
            .collect(),
    }
}

pub(crate) fn subscription(
    view: &SubscriptionView,
    managed_by: &dyn Fn(&str) -> Managed,
) -> PubsubSubscription {
    PubsubSubscription {
        summary: subscription_summary(&view.summary, managed_by),
        push_endpoint: view.push_endpoint.clone(),
        push_attributes: view.push_attributes.clone(),
        ack_deadline_seconds: view.ack_deadline_seconds,
        retain_acked: view.retain_acked,
        retention_seconds: view.retention_seconds,
        expiration_ttl_seconds: view.expiration_ttl_seconds,
        dead_letter: view
            .dead_letter
            .as_ref()
            .map(|(topic, attempts)| PubsubDeadLetter {
                topic: topic.clone(),
                max_delivery_attempts: *attempts,
            }),
        retry: view.retry.map(|(minimum, maximum)| PubsubRetry {
            minimum_backoff_seconds: minimum,
            maximum_backoff_seconds: maximum,
        }),
        labels: view.labels.clone(),
        detached: view.detached,
        created_at: time(view.created_at),
    }
}

pub(crate) fn topic_detail(
    view: &TopicView,
    targets: &Targets,
    managed_by: &dyn Fn(&str) -> Managed,
) -> PubsubTopicDetail {
    PubsubTopicDetail {
        summary: topic_summary(&view.summary, targets, managed_by),
        labels: view.labels.clone(),
        retention_seconds: view.retention_seconds,
        schema: view.schema.as_ref().map(|schema| PubsubTopicSchema {
            schema: schema.schema.clone(),
            deleted: schema.deleted,
            encoding: schema.encoding.to_owned(),
            first_revision_id: schema.first_revision_id.clone(),
            last_revision_id: schema.last_revision_id.clone(),
            bound_revision_id: schema.bound_revision_id.clone(),
        }),
        kms_key_name: view.kms_key_name.clone(),
        created_at: time(view.created_at),
        history: PubsubHistoryWindow {
            messages: view.history.messages,
            bytes: view.history.bytes,
            oldest_id: view.history.oldest_id.map(|id| id.to_string()),
            capacity_messages: view.history.capacity_messages,
            capacity_bytes: view.history.capacity_bytes,
            dropped: view.history.dropped,
        },
        throughput: second_window(&view.throughput),
        subscriptions: view
            .subscriptions
            .iter()
            .map(|view| subscription(view, managed_by))
            .collect(),
        dead_letter_for: view.dead_letter_for.clone(),
        ordering_keys: view.keys.ordering_keys.clone(),
        attribute_keys: view.keys.attribute_keys.clone(),
    }
}

pub(crate) fn preview(preview: &PayloadPreview) -> PubsubPayloadPreview {
    PubsubPayloadPreview {
        encoding: match preview.encoding {
            PayloadEncoding::Json => PubsubPayloadEncoding::Json,
            PayloadEncoding::Text => PubsubPayloadEncoding::Text,
            PayloadEncoding::Binary => PubsubPayloadEncoding::Binary,
        },
        text: preview.text.clone(),
        truncated: preview.truncated,
    }
}

pub(crate) fn state(mark: MessageMark) -> PubsubMessageState {
    match mark {
        MessageMark::Available => PubsubMessageState::Available,
        MessageMark::Outstanding => PubsubMessageState::Outstanding,
        MessageMark::Pushing => PubsubMessageState::Pushing,
        MessageMark::Acked => PubsubMessageState::Acked,
        MessageMark::DeadLettered => PubsubMessageState::DeadLettered,
        MessageMark::Drained => PubsubMessageState::Drained,
        MessageMark::Filtered => PubsubMessageState::Filtered,
        MessageMark::NotTracked => PubsubMessageState::NotTracked,
    }
}

fn attributes(message: &StoredMessage) -> BTreeMap<String, String> {
    message
        .message
        .attributes
        .iter()
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect()
}

fn ordering_key(message: &StoredMessage) -> Option<String> {
    let key = &message.message.ordering_key;
    (!key.is_empty()).then(|| key.clone())
}

// ------------------------------------------------------------ the delivery join

/// What the join reads besides a message's fanout: the invocations
/// compute's record keeps for the event ids in question (read under its
/// lock once, then joined outside it), whether it let go of any since a
/// fanout, and the delivery queue's depth.
#[derive(Debug)]
pub(crate) struct Join<'a> {
    /// Functions run in this suite (compute's record exists).
    pub(crate) functions: bool,
    pub(crate) invocations: HashMap<String, InvocationSummary>,
    /// Every Pub/Sub delivery that began after this is still kept; `None`
    /// while the record let go of none.
    pub(crate) kept_pubsub: Option<SystemTime>,
    /// The same, for schedule ticks.
    pub(crate) kept_schedule: Option<SystemTime>,
    pub(crate) depth: usize,
    pub(crate) targets: &'a Targets,
}

impl<'a> Join<'a> {
    /// Reads, under compute's lock once, the invocations of `event_ids`.
    pub(crate) fn read<'e>(
        monitor: Option<&Monitor>,
        depth: usize,
        targets: &'a Targets,
        event_ids: impl IntoIterator<Item = &'e str>,
    ) -> Self {
        let Some(monitor) = monitor else {
            return Self {
                functions: false,
                invocations: HashMap::new(),
                kept_pubsub: None,
                kept_schedule: None,
                depth,
                targets,
            };
        };
        let ids: Vec<&str> = event_ids.into_iter().collect();
        monitor.snapshot(|view| {
            let mut invocations: HashMap<String, InvocationSummary> = ids
                .iter()
                .filter_map(|id| view.by_event_id(id).map(|found| ((*id).to_owned(), found)))
                .collect();
            let mut reads = ERROR_LINE_READS;
            for invocation in invocations.values_mut() {
                if reads == 0 {
                    break;
                }
                if invocation.outcome_class == InvocationOutcomeClass::Failed
                    && invocation.error.is_none()
                {
                    reads -= 1;
                    invocation.error = logged_error(view, &invocation.id);
                }
            }
            Self {
                functions: true,
                invocations,
                kept_pubsub: view.kept_after(FunctionKind::Pubsub),
                kept_schedule: view.kept_after(FunctionKind::Schedule),
                depth,
                targets,
            }
        })
    }

    /// One fanout target's delivery row.
    pub(crate) fn row(
        &self,
        topic: &str,
        message: &StoredMessage,
        fanout: &Fanout,
        target: &FanoutTarget,
    ) -> PubsubDeliveryRow {
        let invocation = self.invocations.get(&target.event_id);
        let mark = self.mark(topic, fanout, target);
        PubsubDeliveryRow {
            message_id: message.id.to_string(),
            published_at: time(message.published_at),
            function_id: target.function_id.clone(),
            function_name: self.targets.name(topic, &target.function_id),
            function_ref: EntityRef::function(&target.function_id),
            event_id: target.event_id.clone(),
            mark,
            invocation: invocation.map(|invocation| EntityRef::invocation(&invocation.id)),
            started_at: invocation.map(|invocation| invocation.started_at.clone()),
            duration_ms: invocation.and_then(|invocation| invocation.duration_ms),
            status: invocation.and_then(|invocation| invocation.status),
            error: invocation.and_then(|invocation| invocation.error.clone()),
            skipped_reason: (mark == PubsubFunctionMark::Skipped && invocation.is_none())
                .then(|| SKIPPED_BACKGROUND.to_owned()),
            queue_depth: (mark == PubsubFunctionMark::Queued).then(|| u32_of(self.depth)),
            redelivery: target.redelivery,
        }
    }

    /// One fanout target's mark: the invocation's outcome while compute
    /// keeps it; skipped when background triggers were off at the publish
    /// (a later redelivery was sent); queued when the record has let go of
    /// nothing of its kind that began after the target was handed over (so
    /// no invocation of it has begun); otherwise no longer kept.
    pub(crate) fn mark(
        &self,
        topic: &str,
        fanout: &Fanout,
        target: &FanoutTarget,
    ) -> PubsubFunctionMark {
        if let Some(invocation) = self.invocations.get(&target.event_id) {
            return match invocation.outcome_class {
                InvocationOutcomeClass::Succeeded => PubsubFunctionMark::Delivered,
                InvocationOutcomeClass::Failed => PubsubFunctionMark::Failed,
                InvocationOutcomeClass::Skipped => PubsubFunctionMark::Skipped,
                InvocationOutcomeClass::Running => PubsubFunctionMark::Running,
            };
        }
        if fanout.skipped == Some(FanoutSkip::BackgroundOff) && !target.redelivery {
            return PubsubFunctionMark::Skipped;
        }
        let kept = match self.targets.kind(topic, &target.function_id) {
            FunctionKind::Schedule => self.kept_schedule,
            _ => self.kept_pubsub,
        };
        match kept {
            Some(since) if target.at < since => PubsubFunctionMark::NotKept,
            _ => PubsubFunctionMark::Queued,
        }
    }

    /// A row's function marks, one per target (a redelivery's mark wins
    /// over the publish's own for that function). Empty without Functions.
    pub(crate) fn marks(&self, topic: &str, fanout: Option<&Fanout>) -> Vec<PubsubFunctionMarkAt> {
        let Some(fanout) = fanout.filter(|_| self.functions) else {
            return Vec::new();
        };
        let mut marks: Vec<PubsubFunctionMarkAt> = Vec::new();
        for target in &fanout.targets {
            let mark = self.mark(topic, fanout, target);
            match marks
                .iter_mut()
                .find(|existing| existing.function_id == target.function_id)
            {
                Some(existing) => existing.mark = mark,
                None => marks.push(PubsubFunctionMarkAt {
                    function_id: target.function_id.clone(),
                    mark,
                }),
            }
        }
        marks
    }
}

/// Failed invocations without an error whose lines one join reads at most:
/// each is a copy of that invocation's kept lines under compute's lock.
const ERROR_LINE_READS: usize = 100;

/// The first line an invocation logged at error level, for one that failed
/// without a handler error: the SDK catches what an `onSchedule` handler
/// throws, logs its message and answers 500 with no body, so this line is
/// the only place the reason is.
fn logged_error(view: &MonitorView<'_>, id: &str) -> Option<String> {
    let progress = view.invocation_since(id, 0, u64::MAX)?;
    progress
        .lines
        .iter()
        .filter(|line| line.level == FunctionLogLevel::Error)
        .find_map(|line| {
            line.message
                .lines()
                .map(str::trim_end)
                .find(|text| !text.is_empty())
        })
        .map(str::to_owned)
}

/// The event ids of a fanout, for [`Join::read`].
pub(crate) fn event_ids(fanout: Option<&Fanout>) -> impl Iterator<Item = &str> {
    fanout
        .into_iter()
        .flat_map(|fanout| fanout.targets.iter().map(|target| target.event_id.as_str()))
}

pub(crate) fn message_row(topic: &str, row: &HistoryRow, join: &Join<'_>) -> PubsubMessageRow {
    let message = &row.message;
    PubsubMessageRow {
        id: message.id.to_string(),
        publish_time: time(message.published_at),
        size: u64::from(message.size),
        data: preview(&row.preview),
        attributes: attributes(message),
        ordering_key: ordering_key(message),
        deliveries: PubsubDeliverySummary {
            subscriptions: row
                .marks
                .iter()
                .map(|(subscription, mark)| PubsubMessageAt {
                    subscription: subscription.clone(),
                    state: state(*mark),
                })
                .collect(),
            more: row.more_marks,
            functions: join.marks(topic, row.fanout.as_ref()),
        },
    }
}

fn at_subscription(at: &MessageAtSubscription) -> PubsubMessageAtSubscription {
    PubsubMessageAtSubscription {
        subscription: at.subscription.clone(),
        state: state(at.mark),
        attempts: at.attempts.max(at.push_attempts),
        lease_expires_at: time_of(at.lease_expires_at),
        next_push_at: time_of(at.next_push_at),
        filtered_by: at.filtered_by.clone(),
    }
}

/// A message's data and attributes, as the inspector and a pull show them.
pub(crate) fn message_detail(
    topic: &str,
    message: &StoredMessage,
    in_history: bool,
    subscriptions: &[MessageAtSubscription],
    functions: Vec<PubsubDeliveryRow>,
    push: Vec<PubsubPushStreak>,
) -> PubsubMessageDetail {
    let data = &message.message.data;
    let data_text = std::str::from_utf8(data).ok().map(str::to_owned);
    let data_json = data_text
        .as_deref()
        .is_some_and(|text| serde_json::from_str::<serde::de::IgnoredAny>(text).is_ok());
    let attributes = attributes(message);
    let schema = attributes
        .get("googclient_schemaname")
        .map(|schema| PubsubMessageSchema {
            schema: schema.clone(),
            revision_id: attributes
                .get("googclient_schemarevisionid")
                .cloned()
                .unwrap_or_default(),
            encoding: attributes
                .get("googclient_schemaencoding")
                .cloned()
                .unwrap_or_default(),
        });
    let dead_letter_source = attributes
        .get("CloudPubSubDeadLetterSourceSubscription")
        .map(|subscription| PubsubDeadLetterSource {
            subscription: subscription.clone(),
            project: attributes
                .get("CloudPubSubDeadLetterSourceSubscriptionProject")
                .cloned()
                .unwrap_or_default(),
            delivery_count: attributes
                .get("CloudPubSubDeadLetterSourceDeliveryCount")
                .and_then(|count| count.parse().ok())
                .unwrap_or(0),
            original_publish_time: attributes
                .get("CloudPubSubDeadLetterSourceTopicPublishTime")
                .cloned()
                .unwrap_or_default(),
        });
    PubsubMessageDetail {
        topic: topic.to_owned(),
        id: message.id.to_string(),
        publish_time: time(message.published_at),
        size: u64::from(message.size),
        data_base64: BASE64.encode(data),
        data_text,
        data_json,
        ordering_key: ordering_key(message),
        attributes,
        schema,
        dead_letter_source,
        subscriptions: subscriptions.iter().map(at_subscription).collect(),
        functions,
        push,
        in_history,
    }
}

/// A message view's delivery rows, one per fanout target.
pub(crate) fn delivery_rows(view: &MessageView, join: &Join<'_>) -> Vec<PubsubDeliveryRow> {
    if !join.functions {
        return Vec::new();
    }
    view.fanout.as_ref().map_or_else(Vec::new, |fanout| {
        fanout
            .targets
            .iter()
            .map(|target| join.row(&view.topic, &view.message, fanout, target))
            .collect()
    })
}

pub(crate) fn backlog_state(state: BacklogState) -> PubsubBacklogState {
    match state {
        BacklogState::Available => PubsubBacklogState::Available,
        BacklogState::Outstanding => PubsubBacklogState::Outstanding,
        BacklogState::Pushing => PubsubBacklogState::Pushing,
        BacklogState::Acked => PubsubBacklogState::Acked,
    }
}

pub(crate) fn backlog_filter(state: PubsubBacklogState) -> BacklogState {
    match state {
        PubsubBacklogState::Available => BacklogState::Available,
        PubsubBacklogState::Outstanding => BacklogState::Outstanding,
        PubsubBacklogState::Pushing => BacklogState::Pushing,
        PubsubBacklogState::Acked => BacklogState::Acked,
    }
}

pub(crate) fn backlog_row(row: &BacklogRow) -> PubsubBacklogRow {
    let message = &row.message;
    PubsubBacklogRow {
        key: row.key.to_string(),
        id: message.id.to_string(),
        state: backlog_state(row.state),
        place: row.place,
        attempts: row.attempts.max(row.push_attempts),
        lease_expires_at: time_of(row.lease_expires_at),
        next_push_at: time_of(row.next_push_at),
        publish_time: time(message.published_at),
        size: u64::from(message.size),
        data: preview(&firenook_pubsub_front::broker::inspect::payload_preview(
            &message.message.data,
        )),
        attributes: attributes(message),
        ordering_key: ordering_key(message),
        blocked_by: row.blocked_by.map(|id| id.to_string()),
    }
}

pub(crate) fn schema_summary(summary: &SchemaSummary) -> PubsubSchemaSummary {
    PubsubSchemaSummary {
        name: summary.name.clone(),
        project: summary.project.clone(),
        id: summary.id.clone(),
        kind: summary.kind.to_owned(),
        revisions: summary.revisions,
        latest_revision_id: summary.latest_revision_id.clone(),
        latest_created_at: time(summary.latest_created_at),
        used_by: summary.used_by.clone(),
    }
}

pub(crate) fn schema_detail(detail: &SchemaDetail) -> PubsubSchemaDetail {
    PubsubSchemaDetail {
        name: detail.name.clone(),
        project: detail.project.clone(),
        id: detail.id.clone(),
        kind: detail.kind.to_owned(),
        revisions: detail
            .revisions
            .iter()
            .map(|revision| PubsubSchemaRevision {
                id: revision.id.clone(),
                created_at: time(revision.created_at),
                definition: revision.definition.clone(),
            })
            .collect(),
        used_by: detail
            .used_by
            .iter()
            .map(|used| PubsubSchemaUse {
                topic: used.topic.clone(),
                encoding: used.encoding.to_owned(),
                first_revision_id: used.first_revision_id.clone(),
                last_revision_id: used.last_revision_id.clone(),
                bound_revision_id: used.bound_revision_id.clone(),
            })
            .collect(),
    }
}

pub(crate) fn rejected(rejection: &Rejection) -> PubsubRejected {
    PubsubRejected {
        first_at: time(rejection.first_at),
        last_at: time(rejection.last_at),
        count: rejection.count,
        operation: rejection.operation.to_owned(),
        resource: rejection.resource.clone(),
        error: rejection.error.clone(),
        code: rejection.code.to_owned(),
        suggestion: rejection.suggestion.clone(),
        elsewhere: rejection.elsewhere.clone(),
    }
}

pub(crate) fn push_streak(record: &PushStreakRecord) -> PubsubPushStreak {
    PubsubPushStreak {
        streak: record.streak.clone(),
        subscription: record.subscription.clone(),
        message_id: record.message_id.to_string(),
        first_attempt: record.first_attempt,
        last_attempt: record.last_attempt,
        count: record.count,
        first_at: time(record.first_at),
        last_at: time(record.last_at),
        status: record.status,
        error: record.error.clone(),
        latency_ms: millis(record.latency),
        response: record.response.clone(),
    }
}

/// A schedule's run, with its tick's delivery to the function when compute
/// keeps it.
pub(crate) fn schedule_run(
    run: &ScheduleRun,
    delivery: Option<PubsubDeliveryRow>,
) -> PubsubScheduleRun {
    PubsubScheduleRun {
        at: odt(run.at),
        trigger: match run.trigger {
            RunTrigger::Clock => "clock",
            RunTrigger::Console => "console",
        }
        .to_owned(),
        message_id: run.message_id.clone(),
        skipped: run.skipped.clone(),
        delivery,
    }
}

/// A schedule as the Schedules page shows it; `deliveries` holds the
/// delivery rows of its runs' messages, by message id.
pub(crate) fn schedule(
    detail: &ScheduleDetail,
    deliveries: &HashMap<String, PubsubDeliveryRow>,
) -> PubsubSchedule {
    let view = &detail.view;
    let run = |run: &ScheduleRun| {
        let delivery = run
            .message_id
            .as_ref()
            .and_then(|id| deliveries.get(id))
            .cloned();
        schedule_run(run, delivery)
    };
    PubsubSchedule {
        function_id: view.function_id.clone(),
        function_ref: EntityRef::function(&view.function_id),
        function_name: view.function_name.clone(),
        region: view.region.clone(),
        topic: view.topic.clone(),
        shares_topic_with: view.shares_topic_with.clone(),
        expression: view.expression.clone(),
        time_zone: view.time_zone.clone(),
        evaluated_in: view.evaluated_in.clone(),
        automatic: view.automatic,
        problem: view.problem.clone(),
        paused: view.paused,
        next_run_at: view.next_run_at.map(odt),
        upcoming: detail.upcoming.iter().copied().map(odt).collect(),
        runs: view.runs,
        first_run: detail.first_run.as_ref().map(run),
        last_runs: detail.last_runs.iter().map(run).collect(),
        omitted_runs: detail.omitted_runs,
    }
}
