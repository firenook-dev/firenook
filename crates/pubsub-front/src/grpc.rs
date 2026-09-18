//! The `google.pubsub.v1` Publisher, Subscriber and `SchemaService` services and
//! the `google.iam.v1` `IAMPolicy` service over gRPC, mapped onto the broker.

use std::pin::Pin;
use std::time::Duration;

use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tonic::{Request, Response, Status, Streaming};

use crate::broker::{Broker, LONG_POLL};
use crate::error::PubsubError;
use crate::google::iam::v1::iam_policy_server::IamPolicy;
use crate::google::iam::v1::{
    GetIamPolicyRequest, Policy, SetIamPolicyRequest, TestIamPermissionsRequest,
    TestIamPermissionsResponse,
};
use crate::google::pubsub::v1::publisher_server::Publisher;
use crate::google::pubsub::v1::schema_service_server::SchemaService;
use crate::google::pubsub::v1::streaming_pull_response::{
    AcknowledgeConfirmation, ModifyAckDeadlineConfirmation, SubscriptionProperties,
};
use crate::google::pubsub::v1::subscriber_server::Subscriber;
use crate::google::pubsub::v1::validate_message_request::SchemaSpec;
use crate::google::pubsub::v1::{
    AcknowledgeRequest, CommitSchemaRequest, CreateSchemaRequest, CreateSnapshotRequest,
    DeleteSchemaRequest, DeleteSchemaRevisionRequest, DeleteSnapshotRequest,
    DeleteSubscriptionRequest, DeleteTopicRequest, DetachSubscriptionRequest,
    DetachSubscriptionResponse, Encoding, GetSchemaRequest, GetSnapshotRequest,
    GetSubscriptionRequest, GetTopicRequest, ListSchemaRevisionsRequest,
    ListSchemaRevisionsResponse, ListSchemasRequest, ListSchemasResponse, ListSnapshotsRequest,
    ListSnapshotsResponse, ListSubscriptionsRequest, ListSubscriptionsResponse,
    ListTopicSnapshotsRequest, ListTopicSnapshotsResponse, ListTopicSubscriptionsRequest,
    ListTopicSubscriptionsResponse, ListTopicsRequest, ListTopicsResponse,
    ModifyAckDeadlineRequest, ModifyPushConfigRequest, PublishRequest, PublishResponse,
    PullRequest, PullResponse, RollbackSchemaRequest, Schema, SchemaView, SeekRequest,
    SeekResponse, Snapshot, StreamingPullRequest, StreamingPullResponse, Subscription, Topic,
    UpdateSnapshotRequest, UpdateSubscriptionRequest, UpdateTopicRequest, ValidateMessageRequest,
    ValidateMessageResponse, ValidateSchemaRequest, ValidateSchemaResponse, seek_request,
};
use crate::runtime::PubsubRuntime;

fn view(value: i32) -> SchemaView {
    SchemaView::try_from(value).unwrap_or(SchemaView::Unspecified)
}

/// The client's `grpc-timeout`, so a long poll answers before it lapses.
fn client_timeout<T>(request: &Request<T>) -> Option<Duration> {
    let value = request.metadata().get("grpc-timeout")?.to_str().ok()?;
    let (digits, unit) = value.split_at(value.len().checked_sub(1)?);
    let amount: u64 = digits.parse().ok()?;
    Some(match unit {
        "H" => Duration::from_secs(amount * 3600),
        "M" => Duration::from_secs(amount * 60),
        "S" => Duration::from_secs(amount),
        "m" => Duration::from_millis(amount),
        "u" => Duration::from_micros(amount),
        "n" => Duration::from_nanos(amount),
        _ => return None,
    })
}

/// Pulls, waiting up to the long-poll window (or just inside the client's
/// deadline) when nothing is available and the caller did not ask for an
/// immediate answer.
pub async fn pull_with_wait(
    runtime: &PubsubRuntime,
    subscription: &str,
    max_messages: i32,
    return_immediately: bool,
    client_timeout: Option<Duration>,
) -> Result<PullResponse, PubsubError> {
    if max_messages == 0 {
        return Err(PubsubError::invalid_argument("No max_messages specified"));
    }
    if max_messages < 0 {
        // The official emulator answers a negative maximum with nothing.
        runtime.broker().subscription_check(subscription)?;
        return Ok(PullResponse::default());
    }
    let broker = runtime.broker();
    let wait = client_timeout
        .map(|timeout| timeout.saturating_sub(Duration::from_millis(150)))
        .map_or(LONG_POLL, |timeout| timeout.min(LONG_POLL));
    let deadline = tokio::time::Instant::now() + wait;
    let mut changes = broker.watch();
    loop {
        let received = broker.pull(subscription, max_messages)?;
        if !received.is_empty() || return_immediately {
            return Ok(PullResponse {
                received_messages: received,
            });
        }
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return Ok(PullResponse::default());
        }
        if tokio::time::timeout(remaining, changes.changed())
            .await
            .is_err()
        {
            return Ok(PullResponse::default());
        }
    }
}

#[tonic::async_trait]
impl Publisher for PubsubRuntime {
    async fn create_topic(&self, request: Request<Topic>) -> Result<Response<Topic>, Status> {
        Ok(Response::new(
            self.broker().create_topic(request.into_inner())?,
        ))
    }

    async fn update_topic(
        &self,
        request: Request<UpdateTopicRequest>,
    ) -> Result<Response<Topic>, Status> {
        let request = request.into_inner();
        let paths = request
            .update_mask
            .map(|mask| mask.paths)
            .unwrap_or_default();
        Ok(Response::new(
            self.broker().update_topic(request.topic, &paths)?,
        ))
    }

    async fn publish(
        &self,
        request: Request<PublishRequest>,
    ) -> Result<Response<PublishResponse>, Status> {
        let request = request.into_inner();
        let (message_ids, published) = self.broker().publish(&request.topic, request.messages)?;
        self.deliver_to_functions(&published);
        Ok(Response::new(PublishResponse { message_ids }))
    }

    async fn get_topic(
        &self,
        request: Request<GetTopicRequest>,
    ) -> Result<Response<Topic>, Status> {
        Ok(Response::new(
            self.broker().get_topic(&request.into_inner().topic)?,
        ))
    }

    async fn list_topics(
        &self,
        request: Request<ListTopicsRequest>,
    ) -> Result<Response<ListTopicsResponse>, Status> {
        let request = request.into_inner();
        let (topics, next_page_token) =
            self.broker()
                .list_topics(&request.project, request.page_size, &request.page_token)?;
        Ok(Response::new(ListTopicsResponse {
            topics,
            next_page_token,
        }))
    }

    async fn list_topic_subscriptions(
        &self,
        request: Request<ListTopicSubscriptionsRequest>,
    ) -> Result<Response<ListTopicSubscriptionsResponse>, Status> {
        let request = request.into_inner();
        let (subscriptions, next_page_token) = self.broker().list_topic_subscriptions(
            &request.topic,
            request.page_size,
            &request.page_token,
        )?;
        Ok(Response::new(ListTopicSubscriptionsResponse {
            subscriptions,
            next_page_token,
        }))
    }

    async fn list_topic_snapshots(
        &self,
        request: Request<ListTopicSnapshotsRequest>,
    ) -> Result<Response<ListTopicSnapshotsResponse>, Status> {
        let request = request.into_inner();
        let (snapshots, next_page_token) = self.broker().list_topic_snapshots(
            &request.topic,
            request.page_size,
            &request.page_token,
        )?;
        Ok(Response::new(ListTopicSnapshotsResponse {
            snapshots,
            next_page_token,
        }))
    }

    async fn delete_topic(
        &self,
        request: Request<DeleteTopicRequest>,
    ) -> Result<Response<pbjson_types::Empty>, Status> {
        self.broker().delete_topic(&request.into_inner().topic)?;
        Ok(Response::new(pbjson_types::Empty {}))
    }

    async fn detach_subscription(
        &self,
        _request: Request<DetachSubscriptionRequest>,
    ) -> Result<Response<DetachSubscriptionResponse>, Status> {
        Err(Status::unimplemented(
            "Method google.pubsub.v1.Publisher/DetachSubscription is unimplemented",
        ))
    }
}

type StreamingPullStream =
    Pin<Box<dyn tokio_stream::Stream<Item = Result<StreamingPullResponse, Status>> + Send>>;

#[tonic::async_trait]
impl Subscriber for PubsubRuntime {
    type StreamingPullStream = StreamingPullStream;

    async fn create_subscription(
        &self,
        request: Request<Subscription>,
    ) -> Result<Response<Subscription>, Status> {
        Ok(Response::new(
            self.broker().create_subscription(request.into_inner())?,
        ))
    }

    async fn get_subscription(
        &self,
        request: Request<GetSubscriptionRequest>,
    ) -> Result<Response<Subscription>, Status> {
        Ok(Response::new(
            self.broker()
                .get_subscription(&request.into_inner().subscription)?,
        ))
    }

    async fn update_subscription(
        &self,
        request: Request<UpdateSubscriptionRequest>,
    ) -> Result<Response<Subscription>, Status> {
        let request = request.into_inner();
        let paths = request
            .update_mask
            .map(|mask| mask.paths)
            .unwrap_or_default();
        Ok(Response::new(
            self.broker()
                .update_subscription(request.subscription, &paths)?,
        ))
    }

    async fn list_subscriptions(
        &self,
        request: Request<ListSubscriptionsRequest>,
    ) -> Result<Response<ListSubscriptionsResponse>, Status> {
        let request = request.into_inner();
        let (subscriptions, next_page_token) = self.broker().list_subscriptions(
            &request.project,
            request.page_size,
            &request.page_token,
        )?;
        Ok(Response::new(ListSubscriptionsResponse {
            subscriptions,
            next_page_token,
        }))
    }

    async fn delete_subscription(
        &self,
        request: Request<DeleteSubscriptionRequest>,
    ) -> Result<Response<pbjson_types::Empty>, Status> {
        self.broker()
            .delete_subscription(&request.into_inner().subscription)?;
        Ok(Response::new(pbjson_types::Empty {}))
    }

    async fn modify_ack_deadline(
        &self,
        request: Request<ModifyAckDeadlineRequest>,
    ) -> Result<Response<pbjson_types::Empty>, Status> {
        let request = request.into_inner();
        self.broker().modify_ack_deadline(
            &request.subscription,
            &request.ack_ids,
            request.ack_deadline_seconds,
        )?;
        Ok(Response::new(pbjson_types::Empty {}))
    }

    async fn acknowledge(
        &self,
        request: Request<AcknowledgeRequest>,
    ) -> Result<Response<pbjson_types::Empty>, Status> {
        let request = request.into_inner();
        self.broker()
            .acknowledge(&request.subscription, &request.ack_ids)?;
        Ok(Response::new(pbjson_types::Empty {}))
    }

    async fn pull(&self, request: Request<PullRequest>) -> Result<Response<PullResponse>, Status> {
        let timeout = client_timeout(&request);
        let request = request.into_inner();
        #[allow(deprecated)]
        let immediately = request.return_immediately;
        Ok(Response::new(
            pull_with_wait(
                self,
                &request.subscription,
                request.max_messages,
                immediately,
                timeout,
            )
            .await?,
        ))
    }

    async fn streaming_pull(
        &self,
        request: Request<Streaming<StreamingPullRequest>>,
    ) -> Result<Response<Self::StreamingPullStream>, Status> {
        let mut incoming = request.into_inner();
        let (sender, receiver) = mpsc::channel::<Result<StreamingPullResponse, Status>>(16);
        let runtime = self.clone();
        tokio::spawn(async move {
            let broker = runtime.broker();
            let first = match incoming.message().await {
                Ok(Some(first)) => first,
                Ok(None) => return,
                Err(status) => {
                    let _ = sender.send(Err(status)).await;
                    return;
                }
            };
            if let Err(error) = validate_first(&first) {
                let _ = sender.send(Err(error.into())).await;
                return;
            }
            let subscription = first.subscription.clone();
            if let Err(error) = stream_subscription_check(broker, &subscription) {
                let _ = sender.send(Err(error.into())).await;
                return;
            }
            if let Err(error) = apply_stream_acks(broker, &subscription, &first) {
                let _ = sender.send(Err(error.into())).await;
                return;
            }
            // Every message-bearing response carries the subscription
            // properties and empty confirmations, as the official stream does;
            // nothing is sent while there is nothing to deliver.
            let properties = broker
                .get_subscription(&subscription)
                .map(|found| SubscriptionProperties {
                    exactly_once_delivery_enabled: found.enable_exactly_once_delivery,
                    message_ordering_enabled: found.enable_message_ordering,
                })
                .unwrap_or_default();
            let mut changes = broker.watch();
            loop {
                match broker.pull(&subscription, 1000) {
                    Ok(batch) if !batch.is_empty() => {
                        if sender
                            .send(Ok(StreamingPullResponse {
                                received_messages: batch,
                                acknowledge_confirmation: Some(AcknowledgeConfirmation::default()),
                                modify_ack_deadline_confirmation: Some(
                                    ModifyAckDeadlineConfirmation::default(),
                                ),
                                subscription_properties: Some(properties),
                            }))
                            .await
                            .is_err()
                        {
                            return;
                        }
                    }
                    Ok(_) => {}
                    Err(error) => {
                        let _ = sender.send(Err(error.into())).await;
                        return;
                    }
                }
                tokio::select! {
                    next = incoming.message() => match next {
                        Ok(Some(request)) => {
                            if let Err(error) = apply_stream_acks(broker, &subscription, &request) {
                                let _ = sender.send(Err(error.into())).await;
                                return;
                            }
                        }
                        Ok(None) | Err(_) => return,
                    },
                    woken = changes.changed() => {
                        if woken.is_err() {
                            return;
                        }
                    }
                }
            }
        });
        Ok(Response::new(Box::pin(ReceiverStream::new(receiver))))
    }

    async fn modify_push_config(
        &self,
        request: Request<ModifyPushConfigRequest>,
    ) -> Result<Response<pbjson_types::Empty>, Status> {
        let request = request.into_inner();
        self.broker()
            .modify_push_config(&request.subscription, request.push_config)?;
        Ok(Response::new(pbjson_types::Empty {}))
    }

    async fn get_snapshot(
        &self,
        request: Request<GetSnapshotRequest>,
    ) -> Result<Response<Snapshot>, Status> {
        Ok(Response::new(
            self.broker().get_snapshot(&request.into_inner().snapshot)?,
        ))
    }

    async fn list_snapshots(
        &self,
        request: Request<ListSnapshotsRequest>,
    ) -> Result<Response<ListSnapshotsResponse>, Status> {
        let request = request.into_inner();
        let (snapshots, next_page_token) = self.broker().list_snapshots(
            &request.project,
            request.page_size,
            &request.page_token,
        )?;
        Ok(Response::new(ListSnapshotsResponse {
            snapshots,
            next_page_token,
        }))
    }

    async fn create_snapshot(
        &self,
        request: Request<CreateSnapshotRequest>,
    ) -> Result<Response<Snapshot>, Status> {
        let request = request.into_inner();
        Ok(Response::new(self.broker().create_snapshot(
            &request.name,
            &request.subscription,
            request.labels,
        )?))
    }

    async fn update_snapshot(
        &self,
        _request: Request<UpdateSnapshotRequest>,
    ) -> Result<Response<Snapshot>, Status> {
        Err(Status::unimplemented(
            "Method google.pubsub.v1.Subscriber/UpdateSnapshot is unimplemented",
        ))
    }

    async fn delete_snapshot(
        &self,
        request: Request<DeleteSnapshotRequest>,
    ) -> Result<Response<pbjson_types::Empty>, Status> {
        self.broker()
            .delete_snapshot(&request.into_inner().snapshot)?;
        Ok(Response::new(pbjson_types::Empty {}))
    }

    async fn seek(&self, request: Request<SeekRequest>) -> Result<Response<SeekResponse>, Status> {
        let request = request.into_inner();
        seek(self.broker(), &request.subscription, request.target)?;
        Ok(Response::new(SeekResponse {}))
    }
}

/// Seek to a time or a snapshot; the official order of checks.
pub fn seek(
    broker: &Broker,
    subscription: &str,
    target: Option<seek_request::Target>,
) -> Result<(), PubsubError> {
    match target {
        Some(seek_request::Target::Time(time)) => broker.seek_to_time(subscription, &time),
        Some(seek_request::Target::Snapshot(snapshot)) => {
            broker.seek_to_snapshot(subscription, &snapshot)
        }
        None => {
            broker.subscription_check(subscription).or_else(|error| {
                if error.code == tonic::Code::NotFound {
                    Err(error)
                } else {
                    Ok(())
                }
            })?;
            Err(PubsubError::invalid_argument(
                "No target was specified in the SeekRequest. Must specify either a time or a snapshot",
            ))
        }
    }
}

fn validate_first(first: &StreamingPullRequest) -> Result<(), PubsubError> {
    if first.subscription.is_empty() {
        return Err(PubsubError::invalid_argument(
            "first message must set subscription",
        ));
    }
    crate::names::parse("subscriptions", &first.subscription)?;
    if !(10..=600).contains(&first.stream_ack_deadline_seconds) {
        return Err(PubsubError::invalid_argument(
            "stream_ack_deadline_seconds must be between 10 and 600 seconds",
        ));
    }
    Ok(())
}

fn stream_subscription_check(broker: &Broker, subscription: &str) -> Result<(), PubsubError> {
    broker.subscription_check(subscription).map_err(|error| {
        if error.code == tonic::Code::NotFound {
            let id = subscription.rsplit('/').next().unwrap_or(subscription);
            PubsubError::not_found(format!("Subscription does not exist (resource={id})"))
        } else {
            error
        }
    })
}

fn apply_stream_acks(
    broker: &Broker,
    subscription: &str,
    request: &StreamingPullRequest,
) -> Result<(), PubsubError> {
    if !request.ack_ids.is_empty() {
        broker.acknowledge(subscription, &request.ack_ids)?;
    }
    for (ack_id, seconds) in request
        .modify_deadline_ack_ids
        .iter()
        .zip(&request.modify_deadline_seconds)
    {
        broker.modify_ack_deadline(subscription, std::slice::from_ref(ack_id), *seconds)?;
    }
    Ok(())
}

#[tonic::async_trait]
impl SchemaService for PubsubRuntime {
    async fn create_schema(
        &self,
        request: Request<CreateSchemaRequest>,
    ) -> Result<Response<Schema>, Status> {
        let request = request.into_inner();
        Ok(Response::new(self.broker().create_schema(
            &request.parent,
            &request.schema_id,
            request.schema,
        )?))
    }

    async fn get_schema(
        &self,
        request: Request<GetSchemaRequest>,
    ) -> Result<Response<Schema>, Status> {
        let request = request.into_inner();
        Ok(Response::new(
            self.broker()
                .get_schema(&request.name, view(request.view))?,
        ))
    }

    async fn list_schemas(
        &self,
        request: Request<ListSchemasRequest>,
    ) -> Result<Response<ListSchemasResponse>, Status> {
        let request = request.into_inner();
        let (schemas, next_page_token) = self.broker().list_schemas(
            &request.parent,
            view(request.view),
            request.page_size,
            &request.page_token,
        )?;
        Ok(Response::new(ListSchemasResponse {
            schemas,
            next_page_token,
        }))
    }

    async fn list_schema_revisions(
        &self,
        request: Request<ListSchemaRevisionsRequest>,
    ) -> Result<Response<ListSchemaRevisionsResponse>, Status> {
        let request = request.into_inner();
        let (schemas, next_page_token) = self.broker().list_schema_revisions(
            &request.name,
            view(request.view),
            request.page_size,
            &request.page_token,
        )?;
        Ok(Response::new(ListSchemaRevisionsResponse {
            schemas,
            next_page_token,
        }))
    }

    async fn commit_schema(
        &self,
        request: Request<CommitSchemaRequest>,
    ) -> Result<Response<Schema>, Status> {
        let request = request.into_inner();
        Ok(Response::new(
            self.broker().commit_schema(&request.name, request.schema)?,
        ))
    }

    async fn rollback_schema(
        &self,
        request: Request<RollbackSchemaRequest>,
    ) -> Result<Response<Schema>, Status> {
        let request = request.into_inner();
        Ok(Response::new(
            self.broker()
                .rollback_schema(&request.name, &request.revision_id)?,
        ))
    }

    async fn delete_schema_revision(
        &self,
        request: Request<DeleteSchemaRevisionRequest>,
    ) -> Result<Response<Schema>, Status> {
        let request = request.into_inner();
        Ok(Response::new(
            self.broker().delete_schema_revision(&request.name)?,
        ))
    }

    async fn delete_schema(
        &self,
        request: Request<DeleteSchemaRequest>,
    ) -> Result<Response<pbjson_types::Empty>, Status> {
        self.broker().delete_schema(&request.into_inner().name)?;
        Ok(Response::new(pbjson_types::Empty {}))
    }

    async fn validate_schema(
        &self,
        request: Request<ValidateSchemaRequest>,
    ) -> Result<Response<ValidateSchemaResponse>, Status> {
        self.broker().validate_schema(request.into_inner().schema)?;
        Ok(Response::new(ValidateSchemaResponse {}))
    }

    async fn validate_message(
        &self,
        request: Request<ValidateMessageRequest>,
    ) -> Result<Response<ValidateMessageResponse>, Status> {
        let request = request.into_inner();
        let (name, schema) = match request.schema_spec {
            Some(SchemaSpec::Name(name)) => (Some(name), None),
            Some(SchemaSpec::Schema(schema)) => (None, Some(schema)),
            None => (None, None),
        };
        self.broker().validate_message(
            name.as_deref(),
            schema,
            &request.message,
            Encoding::try_from(request.encoding).unwrap_or(Encoding::Unspecified),
        )?;
        Ok(Response::new(ValidateMessageResponse {}))
    }
}

#[tonic::async_trait]
impl IamPolicy for PubsubRuntime {
    async fn set_iam_policy(
        &self,
        _request: Request<SetIamPolicyRequest>,
    ) -> Result<Response<Policy>, Status> {
        Err(Status::unimplemented(""))
    }

    async fn get_iam_policy(
        &self,
        _request: Request<GetIamPolicyRequest>,
    ) -> Result<Response<Policy>, Status> {
        Err(Status::unimplemented(""))
    }

    async fn test_iam_permissions(
        &self,
        _request: Request<TestIamPermissionsRequest>,
    ) -> Result<Response<TestIamPermissionsResponse>, Status> {
        Err(Status::unimplemented(""))
    }
}
