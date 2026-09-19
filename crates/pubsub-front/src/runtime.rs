//! The Pub/Sub runtime: the broker plus function delivery (every discovered
//! function topic keeps the official `emulator-sub-<topic>` subscription and
//! publishes reach the Functions host through the delivery queue), the
//! lease/push timer and the `onSchedule` scheduler.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use firenook_functions_bridge::{DispatchQueue, FunctionsInventory, TriggerRegistry};

use crate::broker::{Broker, Published, PushJob};
use crate::functions::{ScheduleDefinition, Target, build_dispatch, discover, topic_resource};
use crate::google::iam::v1::iam_policy_server::IamPolicyServer;
use crate::google::pubsub::v1::publisher_server::PublisherServer;
use crate::google::pubsub::v1::schema_service_server::SchemaServiceServer;
use crate::google::pubsub::v1::subscriber_server::SubscriberServer;
use crate::google::pubsub::v1::{PubsubMessage, Subscription};
use crate::scheduler::{ScheduleError, SchedulerRuntime};

/// The lease and push timer resolution.
const TICK: Duration = Duration::from_millis(50);

struct Inner {
    project: String,
    broker: Broker,
    queue: DispatchQueue,
    background: TriggerRegistry,
    targets: Mutex<BTreeMap<String, Vec<Target>>>,
    schedules: Mutex<Vec<ScheduleDefinition>>,
    http: reqwest::Client,
    ticker: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

/// Shared Pub/Sub state; cheap to clone.
#[derive(Clone)]
pub struct PubsubRuntime {
    inner: Arc<Inner>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl PubsubRuntime {
    /// Builds the runtime for `project` with the function targets of
    /// `inventory`; call from inside a Tokio runtime so the timer starts.
    #[must_use]
    pub fn new(
        project: &str,
        inventory: &FunctionsInventory,
        queue: DispatchQueue,
        background: TriggerRegistry,
    ) -> Self {
        let (targets, schedules) = discover(project, inventory);
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(30))
            .build()
            .unwrap_or_default();
        let runtime = Self {
            inner: Arc::new(Inner {
                project: project.to_owned(),
                broker: Broker::new(),
                queue,
                background,
                targets: Mutex::new(BTreeMap::new()),
                schedules: Mutex::new(schedules),
                http,
                ticker: Mutex::new(None),
            }),
        };
        runtime.install_targets(targets);
        runtime.start_ticker();
        runtime
    }

    /// The broker behind the transports.
    #[must_use]
    pub fn broker(&self) -> &Broker {
        &self.inner.broker
    }

    /// The project requests without a project address.
    #[must_use]
    pub fn project(&self) -> &str {
        &self.inner.project
    }

    /// Discovered schedule inventory.
    #[must_use]
    pub fn schedules(&self) -> Vec<ScheduleDefinition> {
        lock(&self.inner.schedules).clone()
    }

    /// The HTTP/JSON application for the Pub/Sub port.
    pub fn application(&self) -> axum::Router {
        crate::http::router(self.clone())
    }

    /// The gRPC services mounted beside the HTTP/JSON application on one port.
    #[must_use]
    pub fn routes(&self) -> tonic::service::Routes {
        // The official emulator accepts messages well past gRPC's 4 MB default.
        const MAX_MESSAGE: usize = 64 * 1024 * 1024;
        tonic::service::Routes::from(self.application())
            .add_service(
                PublisherServer::new(self.clone())
                    .max_decoding_message_size(MAX_MESSAGE)
                    .max_encoding_message_size(MAX_MESSAGE),
            )
            .add_service(
                SubscriberServer::new(self.clone())
                    .max_decoding_message_size(MAX_MESSAGE)
                    .max_encoding_message_size(MAX_MESSAGE),
            )
            .add_service(SchemaServiceServer::new(self.clone()))
            .add_service(IamPolicyServer::new(self.clone()))
    }

    /// Starts wall-clock schedule delivery. Manual topic publishing remains
    /// available to deterministic test harnesses.
    pub fn start_scheduler(&self) -> Result<SchedulerRuntime, ScheduleError> {
        self.start_ticker();
        let schedules = self.schedules();
        Ok(SchedulerRuntime::start(self, &schedules))
    }

    /// Reconciles function targets after completed source registration.
    /// Explicit topics, subscriptions, message ids and queued deliveries survive.
    pub async fn refresh_inventory(
        &mut self,
        project: &str,
        inventory: &FunctionsInventory,
        scheduler: &mut SchedulerRuntime,
    ) -> Result<(), ScheduleError> {
        let (targets, discovered) = discover(project, inventory);
        scheduler.stop().await;
        self.install_targets(targets);
        *lock(&self.inner.schedules) = discovered;
        *scheduler = self.start_scheduler()?;
        Ok(())
    }

    fn install_targets(&self, targets: BTreeMap<String, Vec<Target>>) {
        for topic in targets.keys() {
            self.inner.broker.ensure_topic(topic);
            if let Some((project, short)) = crate::functions::parse_topic_resource(topic) {
                let _ = self.inner.broker.create_subscription(Subscription {
                    name: format!("projects/{project}/subscriptions/emulator-sub-{short}"),
                    topic: topic.clone(),
                    ..Subscription::default()
                });
            }
        }
        *lock(&self.inner.targets) = targets;
    }

    fn start_ticker(&self) {
        let mut slot = lock(&self.inner.ticker);
        if slot.as_ref().is_some_and(|task| !task.is_finished()) {
            return;
        }
        let Ok(handle) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let runtime = self.clone();
        *slot = Some(handle.spawn(async move {
            loop {
                tokio::time::sleep(TICK).await;
                for job in runtime.inner.broker.tick() {
                    let runtime = runtime.clone();
                    tokio::spawn(async move { runtime.push(job).await });
                }
            }
        }));
    }

    async fn push(&self, job: PushJob) {
        let mut request = self
            .inner
            .http
            .post(&job.endpoint)
            .header("content-type", "application/json");
        for (name, value) in &job.headers {
            request = request.header(name, value);
        }
        let delivered = match request.body(job.body.clone()).send().await {
            Ok(response) => response.status().is_success(),
            Err(_) => false,
        };
        self.inner.broker.push_finished(&job, delivered);
    }

    /// Hands a publish to the functions listening on its topic; the official
    /// `emulator-sub-<topic>` subscription is drained as their consumer would.
    pub fn deliver_to_functions(&self, published: &Published) {
        let targets = lock(&self.inner.targets)
            .get(&published.topic)
            .cloned()
            .unwrap_or_default();
        if targets.is_empty() {
            return;
        }
        if let Some((project, short)) = crate::functions::parse_topic_resource(&published.topic) {
            self.inner.broker.drain(&format!(
                "projects/{project}/subscriptions/emulator-sub-{short}"
            ));
        }
        if !self.inner.background.background_enabled() {
            return;
        }
        for message in &published.messages {
            for target in &targets {
                let _ = self
                    .inner
                    .queue
                    .enqueue(build_dispatch(&published.topic, target, message));
            }
        }
    }

    pub(crate) fn publish_scheduled(&self, schedule: &ScheduleDefinition) {
        if !self.inner.background.background_enabled() {
            return;
        }
        let topic = topic_resource(&schedule.project, &schedule.topic);
        if let Ok((_, published)) = self.inner.broker.publish(
            &topic,
            vec![PubsubMessage {
                data: b"{}".to_vec(),
                ..PubsubMessage::default()
            }],
        ) {
            self.deliver_to_functions(&published);
        }
    }
}
