//! `GET /pubsub/setup` and `POST /pubsub/setup/import`: a project's topics,
//! subscriptions and schemas (every revision, in order) as one document,
//! never messages; and that document created again, in dependency order,
//! with the schema revisions replayed and the topics' bindings rewritten to
//! the revision ids the import created. Schedule topics and the functions'
//! own subscriptions are left out: the functions create them.

use std::collections::HashMap;

use axum::Json;
use axum::extract::{Query, State};

use super::errors::pubsub_error;
use super::types::{
    PubsubCreateSubscriptionBody, PubsubCreateTopicBody, PubsubDeadLetter, PubsubRetry,
    PubsubRevisionMapping, PubsubSchemaBinding, PubsubSetup, PubsubSetupResult,
    PubsubSetupRevision, PubsubSetupSchema, PubsubSetupSkip,
};
use super::{
    ProjectQuery, PubsubApi, commit_schema_named, create_schema_named, subscription_request,
    targets, topic_request,
};
use crate::api_error::ApiError;
use crate::blocking::blocking;
use crate::json::ConsoleJson;
use crate::messaging::PubsubConsole;

/// The setup document's version: 2 carries every schema revision.
const VERSION: u32 = 2;

/// The project's setup, as `GET /pubsub/setup` answers it.
pub(crate) fn setup_of(console: &PubsubConsole, project: &str) -> PubsubSetup {
    let broker = console.runtime.broker();
    let schemas = broker
        .schemas_view(project)
        .iter()
        .filter_map(|summary| broker.schema_detail(&summary.name))
        .map(|detail| PubsubSetupSchema {
            name: detail.name,
            kind: detail.kind.to_owned(),
            revisions: detail
                .revisions
                .into_iter()
                .map(|revision| PubsubSetupRevision {
                    id: revision.id,
                    definition: revision.definition,
                })
                .collect(),
        })
        .collect();
    let targets = targets(console);
    let index = broker.topics_index(project);
    let mut topics = Vec::new();
    let mut subscriptions = Vec::new();
    for summary in &index.topics {
        if targets.schedules.contains_key(&summary.name) {
            continue;
        }
        let Some(view) = broker.topic_view(&summary.name) else {
            continue;
        };
        topics.push(PubsubCreateTopicBody {
            name: summary.name.clone(),
            labels: view.labels.clone(),
            retention_seconds: view.retention_seconds,
            schema: view
                .schema
                .as_ref()
                .filter(|schema| !schema.deleted)
                .map(|schema| PubsubSchemaBinding {
                    schema: schema.schema.clone(),
                    encoding: schema.encoding.to_owned(),
                    first_revision_id: schema.first_revision_id.clone(),
                    last_revision_id: schema.last_revision_id.clone(),
                }),
            default_subscription: false,
        });
        for subscription in &view.subscriptions {
            if console.runtime.managed(&subscription.summary.name)
                != firenook_pubsub_front::Managed::No
            {
                continue;
            }
            subscriptions.push(PubsubCreateSubscriptionBody {
                name: subscription.summary.name.clone(),
                topic: summary.name.clone(),
                ack_deadline_seconds: Some(subscription.ack_deadline_seconds),
                push_endpoint: subscription.push_endpoint.clone(),
                push_attributes: subscription.push_attributes.clone(),
                filter: subscription.summary.filter.clone(),
                ordering: subscription.summary.ordering,
                exactly_once: subscription.summary.exactly_once,
                retain_acked: subscription.retain_acked,
                retention_seconds: Some(subscription.retention_seconds),
                expiration_ttl_seconds: subscription.expiration_ttl_seconds,
                dead_letter: subscription.dead_letter.as_ref().map(|(topic, attempts)| {
                    PubsubDeadLetter {
                        topic: topic.clone(),
                        max_delivery_attempts: *attempts,
                    }
                }),
                retry: subscription.retry.map(|(minimum, maximum)| PubsubRetry {
                    minimum_backoff_seconds: minimum,
                    maximum_backoff_seconds: maximum,
                }),
                labels: subscription.labels.clone(),
            });
        }
    }
    PubsubSetup {
        version: VERSION,
        project: project.to_owned(),
        schemas,
        topics,
        subscriptions,
    }
}

pub(crate) async fn export(
    State(api): State<PubsubApi>,
    Query(query): Query<ProjectQuery>,
) -> Result<Json<PubsubSetup>, ApiError> {
    let console = api.console()?;
    let project = api.project(query.project.as_deref());
    blocking("the setup export", move || {
        Ok(Json(setup_of(&console, &project)))
    })
    .await
}

/// What an import did so far.
#[derive(Default)]
struct Imported {
    created: Vec<String>,
    skipped: Vec<PubsubSetupSkip>,
    revisions: Vec<PubsubRevisionMapping>,
}

impl Imported {
    fn skip(&mut self, name: &str, error: &ApiError) {
        let reason = if error.detail().code == crate::api_error::ErrorCode::AlreadyExists {
            "It already exists.".to_owned()
        } else {
            error.detail().message.clone()
        };
        self.skipped.push(PubsubSetupSkip {
            name: name.to_owned(),
            reason,
        });
    }
}

/// Creates `setup` in dependency order: schemas (each revision in turn),
/// then topics (bindings rewritten to the created revisions), then
/// subscriptions. What exists already, or what the engine refuses, is
/// skipped with the reason; everything else is created.
pub(crate) fn import_setup(console: &PubsubConsole, setup: &PubsubSetup) -> PubsubSetupResult {
    let mut done = Imported::default();
    // Exported revision id → the one created, per schema.
    let mut mapping: HashMap<(String, String), String> = HashMap::new();
    for schema in &setup.schemas {
        let mut revisions = schema.revisions.iter();
        let Some(first) = revisions.next() else {
            done.skipped.push(PubsubSetupSkip {
                name: schema.name.clone(),
                reason: "It has no revision to create.".to_owned(),
            });
            continue;
        };
        match create_schema_named(console, &schema.name, &schema.kind, &first.definition) {
            Ok(created) => {
                done.created.push(schema.name.clone());
                mapping.insert(
                    (schema.name.clone(), first.id.clone()),
                    created.revision_id.clone(),
                );
                done.revisions.push(PubsubRevisionMapping {
                    schema: schema.name.clone(),
                    exported: first.id.clone(),
                    created: created.revision_id,
                });
                for revision in revisions {
                    match commit_schema_named(console, &schema.name, &revision.definition) {
                        Ok(created) => {
                            mapping.insert(
                                (schema.name.clone(), revision.id.clone()),
                                created.revision_id.clone(),
                            );
                            done.revisions.push(PubsubRevisionMapping {
                                schema: schema.name.clone(),
                                exported: revision.id.clone(),
                                created: created.revision_id,
                            });
                        }
                        Err(error) => {
                            done.skip(&format!("{}@{}", schema.name, revision.id), &error);
                        }
                    }
                }
            }
            Err(error) => done.skip(&schema.name, &error),
        }
    }
    let broker = console.runtime.broker();
    for topic in &setup.topics {
        let mut body = topic.clone();
        if let Some(binding) = body.schema.as_mut() {
            let schema = binding_schema(&binding.schema);
            let rewrite = |id: Option<String>| {
                id.map(|exported| {
                    mapping
                        .get(&(schema.clone(), exported.clone()))
                        .cloned()
                        .unwrap_or(exported)
                })
            };
            binding.first_revision_id = rewrite(binding.first_revision_id.take());
            binding.last_revision_id = rewrite(binding.last_revision_id.take());
        }
        body.default_subscription = false;
        let result = topic_request(&body)
            .and_then(|request| broker.create_topic(request).map_err(pubsub_error));
        match result {
            Ok(_) => done.created.push(topic.name.clone()),
            Err(error) => done.skip(&topic.name, &error),
        }
    }
    for subscription in &setup.subscriptions {
        let result = subscription_request(subscription)
            .and_then(|request| broker.create_subscription(request).map_err(pubsub_error));
        match result {
            Ok(_) => done.created.push(subscription.name.clone()),
            Err(error) => done.skip(&subscription.name, &error),
        }
    }
    PubsubSetupResult {
        created: done.created,
        skipped: done.skipped,
        revisions: done.revisions,
    }
}

/// The schema a binding names, without a revision.
fn binding_schema(name: &str) -> String {
    name.split('@').next().unwrap_or(name).to_owned()
}

pub(crate) async fn import(
    State(api): State<PubsubApi>,
    ConsoleJson(setup): ConsoleJson<PubsubSetup>,
) -> Result<Json<PubsubSetupResult>, ApiError> {
    let console = api.console()?;
    if setup.version != VERSION {
        return Err(ApiError::invalid(format!(
            "This setup is version {}; the console imports version {VERSION}.",
            setup.version
        ))
        .with_fix("Export the setup again from this console."));
    }
    blocking("the setup import", move || {
        Ok(Json(import_setup(&console, &setup)))
    })
    .await
}
