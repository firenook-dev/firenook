//! HTTP/JSON transcoding of the same services on the Pub/Sub port, as the
//! official emulator's adapter answers: proto3 JSON bodies (pbjson), pretty
//! printed successes, compact `{"error": ...}` failures, plain `Not Found`
//! for anything the adapter does not route.

use std::collections::BTreeMap;
use std::time::Duration;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Request, State};
use axum::http::{Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::error::PubsubError;
use crate::google::pubsub::v1::validate_message_request::SchemaSpec;
use crate::google::pubsub::v1::{
    AcknowledgeRequest, CommitSchemaRequest, CreateSnapshotRequest, Encoding,
    ListSchemaRevisionsResponse, ListSchemasResponse, ListSnapshotsResponse,
    ListSubscriptionsResponse, ListTopicSnapshotsResponse, ListTopicSubscriptionsResponse,
    ListTopicsResponse, ModifyAckDeadlineRequest, ModifyPushConfigRequest, PublishRequest,
    PublishResponse, PullRequest, RollbackSchemaRequest, Schema, SchemaView, SeekRequest, Snapshot,
    Subscription, Topic, UpdateSubscriptionRequest, UpdateTopicRequest, ValidateMessageRequest,
    ValidateSchemaRequest,
};
use crate::runtime::PubsubRuntime;

/// The axum application for the Pub/Sub port's HTTP/JSON surface.
pub fn router(runtime: PubsubRuntime) -> Router {
    Router::new().fallback(handle).with_state(runtime)
}

/// A plain-text answer without a content type, as the adapter's fallbacks.
fn plain(status: StatusCode, text: &str) -> Response {
    let mut response = Response::new(axum::body::Body::from(format!("{text}\n")));
    *response.status_mut() = status;
    response
}

fn not_found(text: &str) -> Response {
    plain(StatusCode::NOT_FOUND, text)
}

fn json<T: Serialize>(value: &T) -> Response {
    // The official adapter pretty prints with protobuf's JsonFormat; an
    // empty message is `{\n}`.
    let mut text = serde_json::to_string_pretty(value).unwrap_or_else(|_| "{}".to_owned());
    if text == "{}" {
        "{\n}".clone_into(&mut text);
    }
    text.push('\n');
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json")],
        text,
    )
        .into_response()
}

fn empty() -> Response {
    json(&serde_json::Map::new())
}

fn parse<T: DeserializeOwned + Default>(body: &Bytes) -> Result<T, PubsubError> {
    if body.is_empty() {
        return Ok(T::default());
    }
    let invalid = || PubsubError::invalid_argument("Payload isn't valid for request.");
    let mut value: serde_json::Value = serde_json::from_slice(body).map_err(|_| invalid())?;
    // protobuf's JSON parser drops `null` fields and reads `"true"`/`"false"`
    // for booleans.
    coerce(&mut value);
    // proto3 JSON writes a field mask as `"a,b"`; the generated type reads
    // the message form, so translate (lowerCamelCase paths become snake_case).
    if let Some(object) = value.as_object_mut()
        && let Some(serde_json::Value::String(mask)) = object.get("updateMask")
    {
        let paths: Vec<serde_json::Value> = mask
            .split(',')
            .filter(|path| !path.is_empty())
            .map(|path| serde_json::Value::String(snake_case(path)))
            .collect();
        object.insert(
            "updateMask".to_owned(),
            serde_json::json!({ "paths": paths }),
        );
    }
    serde_json::from_value(value).map_err(|_| invalid())
}

/// `?updateMask=` and body masks arrive as comma-separated proto3 JSON
/// field masks; lowerCamelCase paths become `snake_case`.
fn mask_paths(
    mask: Option<pbjson_types::FieldMask>,
    query: &BTreeMap<String, String>,
) -> Vec<String> {
    if let Some(mask) = mask {
        return mask.paths;
    }
    query
        .get("updateMask")
        .map(|value| {
            value
                .split(',')
                .filter(|path| !path.is_empty())
                .map(snake_case)
                .collect()
        })
        .unwrap_or_default()
}

const BOOL_FIELDS: &[&str] = &[
    "retainAckedMessages",
    "enableMessageOrdering",
    "enableExactlyOnceDelivery",
    "detached",
    "returnImmediately",
    "satisfiesPzs",
    "writeMetadata",
    "useTopicSchema",
    "useTableSchema",
    "dropUnknownFields",
];

fn coerce(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Object(map) => {
            map.retain(|_, item| !item.is_null());
            for (key, item) in map.iter_mut() {
                if BOOL_FIELDS.contains(&key.as_str())
                    && let serde_json::Value::String(text) = item
                {
                    match text.as_str() {
                        "true" => *item = serde_json::Value::Bool(true),
                        "false" => *item = serde_json::Value::Bool(false),
                        _ => {}
                    }
                }
                coerce(item);
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                coerce(item);
            }
        }
        _ => {}
    }
}

fn snake_case(path: &str) -> String {
    let mut output = String::with_capacity(path.len() + 4);
    for character in path.chars() {
        if character.is_ascii_uppercase() {
            output.push('_');
            output.push(character.to_ascii_lowercase());
        } else {
            output.push(character);
        }
    }
    output
}

fn percent_decode(path: &str) -> String {
    let mut output = Vec::with_capacity(path.len());
    let bytes = path.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%'
            && index + 2 < bytes.len()
            && let Ok(byte) = u8::from_str_radix(&path[index + 1..index + 3], 16)
        {
            output.push(byte);
            index += 3;
        } else {
            output.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(output).unwrap_or_else(|_| path.to_owned())
}

fn query_map(query: Option<&str>) -> BTreeMap<String, String> {
    query
        .map(|text| {
            url::form_urlencoded::parse(text.as_bytes())
                .map(|(key, value)| (key.into_owned(), value.into_owned()))
                .collect()
        })
        .unwrap_or_default()
}

fn page_size(query: &BTreeMap<String, String>) -> i32 {
    query
        .get("pageSize")
        .and_then(|value| value.parse().ok())
        .unwrap_or(0)
}

fn schema_view(query: &BTreeMap<String, String>) -> SchemaView {
    match query.get("view").map(String::as_str) {
        Some("FULL" | "2") => SchemaView::Full,
        Some("BASIC" | "1") => SchemaView::Basic,
        _ => SchemaView::Unspecified,
    }
}

struct Route<'a> {
    project: &'a str,
    collection: &'a str,
    /// The resource id, with any `@revision`.
    id: Option<&'a str>,
    verb: Option<&'a str>,
    /// A nested collection (`topics/{t}/subscriptions`).
    child: Option<&'a str>,
}

/// Splits `/v1/projects/{p}/{collection}[/{id}[:verb]][/child]`.
fn parse_route(path: &str) -> Option<Route<'_>> {
    let rest = path.strip_prefix("/v1/projects/")?;
    let (project, rest) = rest.split_once('/')?;
    if project.is_empty() {
        return None;
    }
    let (collection, rest) = match rest.split_once('/') {
        Some((collection, rest)) => (collection, Some(rest)),
        None => (rest, None),
    };
    let (collection, collection_verb) = match collection.split_once(':') {
        Some((name, verb)) => (name, Some(verb)),
        None => (collection, None),
    };
    let Some(rest) = rest else {
        return Some(Route {
            project,
            collection,
            id: None,
            verb: collection_verb,
            child: None,
        });
    };
    if rest.is_empty() {
        return None;
    }
    let (item, child) = match rest.split_once('/') {
        Some((item, child)) => (item, Some(child)),
        None => (rest, None),
    };
    if child.is_some_and(|child| child.is_empty() || child.contains('/')) {
        return None;
    }
    let (id, verb) = match item.rsplit_once(':') {
        Some((id, verb)) => (id, Some(verb)),
        None => (item, None),
    };
    Some(Route {
        project,
        collection,
        id: Some(id),
        verb,
        child,
    })
}

async fn handle(State(runtime): State<PubsubRuntime>, request: Request) -> Response {
    let method = request.method().clone();
    let path = request.uri().path().to_owned();
    let query = query_map(request.uri().query());
    let timeout = request
        .headers()
        .get("x-goog-request-timeout")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<f64>().ok())
        .map(Duration::from_secs_f64);
    let Ok(body) = axum::body::to_bytes(request.into_body(), 64 * 1024 * 1024).await else {
        return PubsubError::invalid_argument("Payload isn't valid for request.").into_response();
    };
    if method == Method::OPTIONS {
        return StatusCode::OK.into_response();
    }
    if method == Method::HEAD {
        let mut response = Response::new(axum::body::Body::empty());
        *response.status_mut() = StatusCode::NOT_FOUND;
        return response;
    }
    if path == "/" {
        return plain(StatusCode::OK, "Ok");
    }
    // The adapter routes on the decoded path (`%3A` is `:`).
    let path = percent_decode(&path);
    if let Some(version) = path
        .strip_prefix('/')
        .and_then(|rest| rest.split('/').next())
        .filter(|segment| {
            segment.starts_with('v')
                && *segment != "v1"
                && segment[1..].chars().all(|c| c.is_ascii_digit())
        })
    {
        return not_found(&format!(
            "Not Found (Unsupported API version \"{version}\")"
        ));
    }
    let Some(route) = parse_route(&path) else {
        return not_found("Not Found");
    };
    match dispatch(&runtime, &method, &route, &query, &body, timeout).await {
        Some(Ok(response)) => response,
        Some(Err(error)) => error.into_response(),
        None => not_found("Not Found"),
    }
}

#[allow(clippy::too_many_lines)]
async fn dispatch(
    runtime: &PubsubRuntime,
    method: &Method,
    route: &Route<'_>,
    query: &BTreeMap<String, String>,
    body: &Bytes,
    timeout: Option<Duration>,
) -> Option<Result<Response, PubsubError>> {
    let broker = runtime.broker();
    let project = format!("projects/{}", route.project);
    let name = |collection: &str| route.id.map(|id| format!("{project}/{collection}/{id}"));
    let result: Result<Response, PubsubError> =
        match (route.collection, route.id, route.verb, route.child, method) {
            // ---- topics
            ("topics", None, None, None, &Method::GET) => broker
                .list_topics(
                    &project,
                    page_size(query),
                    query.get("pageToken").map_or("", String::as_str),
                )
                .map(|(topics, next_page_token)| {
                    json(&ListTopicsResponse {
                        topics,
                        next_page_token,
                    })
                }),
            ("topics", Some(_), None, None, &Method::PUT) => {
                parse::<Topic>(body).and_then(|mut topic| {
                    topic.name = name("topics").unwrap_or_default();
                    broker.create_topic(topic).map(|topic| json(&topic))
                })
            }
            ("topics", Some(_), None, None, &Method::GET) => broker
                .get_topic(&name("topics").unwrap_or_default())
                .map(|topic| json(&topic)),
            ("topics", Some(_), None, None, &Method::PATCH) => parse::<UpdateTopicRequest>(body)
                .and_then(|request| {
                    let paths = mask_paths(request.update_mask, query);
                    let mut topic = request.topic.unwrap_or_default();
                    topic.name = name("topics").unwrap_or_default();
                    broker
                        .update_topic(Some(topic), &paths)
                        .map(|topic| json(&topic))
                }),
            ("topics", Some(_), None, None, &Method::DELETE) => broker
                .delete_topic(&name("topics").unwrap_or_default())
                .map(|()| empty()),
            ("topics", Some(_), Some("publish"), None, &Method::POST) => {
                parse::<PublishRequest>(body).and_then(|request| {
                    let (message_ids, published) =
                        broker.publish(&name("topics").unwrap_or_default(), request.messages)?;
                    runtime.deliver_to_functions(&published);
                    Ok(json(&PublishResponse { message_ids }))
                })
            }
            ("topics", Some(_), None, Some("subscriptions"), &Method::GET) => broker
                .list_topic_subscriptions(
                    &name("topics").unwrap_or_default(),
                    page_size(query),
                    query.get("pageToken").map_or("", String::as_str),
                )
                .map(|(subscriptions, next_page_token)| {
                    json(&ListTopicSubscriptionsResponse {
                        subscriptions,
                        next_page_token,
                    })
                }),
            ("topics", Some(_), None, Some("snapshots"), &Method::GET) => broker
                .list_topic_snapshots(
                    &name("topics").unwrap_or_default(),
                    page_size(query),
                    query.get("pageToken").map_or("", String::as_str),
                )
                .map(|(snapshots, next_page_token)| {
                    json(&ListTopicSnapshotsResponse {
                        snapshots,
                        next_page_token,
                    })
                }),
            ("topics", Some(_), Some(verb), None, &Method::GET | &Method::DELETE)
                if verb == "publish" =>
            {
                // The adapter treats `topics/{t}:publish` as a topic name here.
                Err(PubsubError::invalid_name(
                    "topics",
                    &format!("{project}/topics/{}:{verb}", route.id.unwrap_or_default()),
                ))
            }
            ("topics", Some(_), Some("publish"), None, &Method::PUT) => Err(
                PubsubError::invalid_argument("Payload isn't valid for request."),
            ),
            (
                "topics" | "subscriptions" | "schemas" | "snapshots",
                Some(_),
                Some("getIamPolicy"),
                None,
                &Method::GET,
            )
            | (
                "topics" | "subscriptions" | "schemas" | "snapshots",
                Some(_),
                Some("setIamPolicy" | "testIamPermissions"),
                None,
                &Method::POST,
            ) => {
                if route.collection == "schemas" {
                    Err(PubsubError::invalid_name(
                        "schemas",
                        &format!(
                            "{project}/schemas/{}:{}",
                            route.id.unwrap_or_default(),
                            route.verb.unwrap_or_default()
                        ),
                    ))
                } else {
                    Err(PubsubError::unimplemented(""))
                }
            }
            // ---- subscriptions
            ("subscriptions", None, None, None, &Method::GET) => broker
                .list_subscriptions(
                    &project,
                    page_size(query),
                    query.get("pageToken").map_or("", String::as_str),
                )
                .map(|(subscriptions, next_page_token)| {
                    json(&ListSubscriptionsResponse {
                        subscriptions,
                        next_page_token,
                    })
                }),
            ("subscriptions", Some(_), None, None, &Method::PUT) => parse::<Subscription>(body)
                .and_then(|mut subscription| {
                    subscription.name = name("subscriptions").unwrap_or_default();
                    broker
                        .create_subscription(subscription)
                        .map(|subscription| json(&subscription))
                }),
            ("subscriptions", Some(_), None, None, &Method::GET) => broker
                .get_subscription(&name("subscriptions").unwrap_or_default())
                .map(|subscription| json(&subscription)),
            ("subscriptions", Some(_), None, None, &Method::PATCH) => {
                parse::<UpdateSubscriptionRequest>(body).and_then(|request| {
                    let paths = mask_paths(request.update_mask, query);
                    let mut subscription = request.subscription.unwrap_or_default();
                    subscription.name = name("subscriptions").unwrap_or_default();
                    broker
                        .update_subscription(Some(subscription), &paths)
                        .map(|subscription| json(&subscription))
                })
            }
            ("subscriptions", Some(_), None, None, &Method::DELETE) => broker
                .delete_subscription(&name("subscriptions").unwrap_or_default())
                .map(|()| empty()),
            ("subscriptions", Some(_), Some("pull"), None, &Method::POST) => {
                match parse::<PullRequest>(body) {
                    Ok(request) => {
                        #[allow(deprecated)]
                        let immediately = request.return_immediately;
                        crate::grpc::pull_with_wait(
                            runtime,
                            &name("subscriptions").unwrap_or_default(),
                            request.max_messages,
                            immediately,
                            timeout,
                        )
                        .await
                        .map(|response| json(&response))
                    }
                    Err(error) => Err(error),
                }
            }
            ("subscriptions", Some(_), Some("acknowledge"), None, &Method::POST) => {
                parse::<AcknowledgeRequest>(body).and_then(|request| {
                    broker
                        .acknowledge(&name("subscriptions").unwrap_or_default(), &request.ack_ids)
                        .map(|()| empty())
                })
            }
            ("subscriptions", Some(_), Some("modifyAckDeadline"), None, &Method::POST) => {
                parse::<ModifyAckDeadlineRequest>(body).and_then(|request| {
                    broker
                        .modify_ack_deadline(
                            &name("subscriptions").unwrap_or_default(),
                            &request.ack_ids,
                            request.ack_deadline_seconds,
                        )
                        .map(|()| empty())
                })
            }
            ("subscriptions", Some(_), Some("modifyPushConfig"), None, &Method::POST) => {
                parse::<ModifyPushConfigRequest>(body).and_then(|request| {
                    broker
                        .modify_push_config(
                            &name("subscriptions").unwrap_or_default(),
                            request.push_config,
                        )
                        .map(|()| empty())
                })
            }
            ("subscriptions", Some(_), Some("seek"), None, &Method::POST) => {
                parse::<SeekRequest>(body).and_then(|request| {
                    crate::grpc::seek(
                        broker,
                        &name("subscriptions").unwrap_or_default(),
                        request.target,
                    )
                    .map(|()| empty())
                })
            }
            ("subscriptions", Some(_), Some("detach"), None, &Method::POST) => {
                Err(PubsubError::unimplemented(
                    "Method google.pubsub.v1.Publisher/DetachSubscription is unimplemented",
                ))
            }
            // ---- snapshots
            ("snapshots", None, None, None, &Method::GET) => broker
                .list_snapshots(
                    &project,
                    page_size(query),
                    query.get("pageToken").map_or("", String::as_str),
                )
                .map(|(snapshots, next_page_token)| {
                    json(&ListSnapshotsResponse {
                        snapshots,
                        next_page_token,
                    })
                }),
            ("snapshots", Some(_), None, None, &Method::PUT) => {
                parse::<CreateSnapshotRequest>(body).and_then(|request| {
                    broker
                        .create_snapshot(
                            &name("snapshots").unwrap_or_default(),
                            &request.subscription,
                            request.labels,
                        )
                        .map(|snapshot| json(&snapshot))
                })
            }
            ("snapshots", Some(_), None, None, &Method::GET) => broker
                .get_snapshot(&name("snapshots").unwrap_or_default())
                .map(|snapshot| json(&snapshot)),
            ("snapshots", Some(_), None, None, &Method::PATCH) => Err(PubsubError::unimplemented(
                "Method google.pubsub.v1.Subscriber/UpdateSnapshot is unimplemented",
            )),
            ("snapshots", Some(_), None, None, &Method::DELETE) => broker
                .delete_snapshot(&name("snapshots").unwrap_or_default())
                .map(|()| empty()),
            // ---- schemas
            ("schemas", None, None, None, &Method::POST) => {
                parse::<Schema>(body).and_then(|schema| {
                    broker
                        .create_schema(
                            &project,
                            query.get("schemaId").map_or("", String::as_str),
                            Some(schema),
                        )
                        .map(|schema| json(&schema))
                })
            }
            ("schemas", None, None, None, &Method::GET) => broker
                .list_schemas(
                    &project,
                    schema_view(query),
                    page_size(query),
                    query.get("pageToken").map_or("", String::as_str),
                )
                .map(|(schemas, next_page_token)| {
                    json(&ListSchemasResponse {
                        schemas,
                        next_page_token,
                    })
                }),
            ("schemas", None, Some("validate"), None, &Method::POST) => {
                parse::<ValidateSchemaRequest>(body)
                    .and_then(|request| broker.validate_schema(request.schema).map(|()| empty()))
            }
            ("schemas", None, Some("validateMessage"), None, &Method::POST) => {
                parse::<ValidateMessageRequest>(body).and_then(|request| {
                    let (name, schema) = match request.schema_spec {
                        Some(SchemaSpec::Name(name)) => (Some(name), None),
                        Some(SchemaSpec::Schema(schema)) => (None, Some(schema)),
                        None => (None, None),
                    };
                    broker
                        .validate_message(
                            name.as_deref(),
                            schema,
                            &request.message,
                            Encoding::try_from(request.encoding).unwrap_or(Encoding::Unspecified),
                        )
                        .map(|()| empty())
                })
            }
            ("schemas", Some(_), None, None, &Method::GET) => broker
                .get_schema(&name("schemas").unwrap_or_default(), schema_view(query))
                .map(|schema| json(&schema)),
            ("schemas", Some(_), Some("listRevisions"), None, &Method::GET) => broker
                .list_schema_revisions(
                    &name("schemas").unwrap_or_default(),
                    schema_view(query),
                    page_size(query),
                    query.get("pageToken").map_or("", String::as_str),
                )
                .map(|(schemas, next_page_token)| {
                    json(&ListSchemaRevisionsResponse {
                        schemas,
                        next_page_token,
                    })
                }),
            ("schemas", Some(_), Some("commit"), None, &Method::POST) => {
                parse::<CommitSchemaRequest>(body).and_then(|request| {
                    broker
                        .commit_schema(&name("schemas").unwrap_or_default(), request.schema)
                        .map(|schema| json(&schema))
                })
            }
            ("schemas", Some(_), Some("rollback"), None, &Method::POST) => {
                parse::<RollbackSchemaRequest>(body).and_then(|request| {
                    broker
                        .rollback_schema(&name("schemas").unwrap_or_default(), &request.revision_id)
                        .map(|schema| json(&schema))
                })
            }
            ("schemas", Some(_), Some("deleteRevision"), None, &Method::DELETE) => broker
                .delete_schema_revision(&name("schemas").unwrap_or_default())
                .map(|schema| json(&schema)),
            ("schemas", Some(_), None, None, &Method::DELETE) => broker
                .delete_schema(&name("schemas").unwrap_or_default())
                .map(|()| empty()),
            _ => return None,
        };
    Some(result)
}

#[allow(dead_code)]
fn unused(_: Snapshot) {}
