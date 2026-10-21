//! REST transcoding of the Firestore methods served by the native service
//! alone: createDocument, batchWrite, partitionQuery, executePipeline, and
//! runQuery / runAggregationQuery with a consistency selector (a
//! transaction, a new transaction or a read time), whose transaction state
//! only the native service holds.
use super::{
    DatabasePath, DocumentPath, HeaderMap, Json, JsonValue, PAYLOAD_INVALID, Path, RestBody,
    RestError, RestState, State, json, listing, read_json, read_options, request_authorization,
    request_json,
};
use firenook_grpc_front::google::firestore::v1::{
    BatchWriteRequest, CreateDocumentRequest, Document, DocumentMask, ExecutePipelineRequest,
    PartitionQueryRequest, RunAggregationQueryRequest, RunQueryRequest,
    firestore_server::Firestore as _,
};
use serde::de::DeserializeOwned;
use tokio_stream::StreamExt as _;

/// Whether a query reads in a transaction or at a read time.
pub(super) fn has_consistency_selector(body: &JsonValue) -> bool {
    ["transaction", "newTransaction", "readTime"]
        .iter()
        .any(|key| body.get(key).is_some())
}

/// A request message from a REST body with the path's resource field set;
/// a body the message cannot hold is the payload's fault.
fn message<T: DeserializeOwned>(
    mut body: JsonValue,
    field: &str,
    resource: &str,
) -> Result<T, RestError> {
    body[field] = json!(resource);
    serde_json::from_value(body).map_err(|_| RestError::invalid(PAYLOAD_INVALID))
}

fn database(path: &DatabasePath) -> String {
    format!("projects/{}/databases/{}", path.project, path.database)
}

/// Owner authentication, which the official emulator requires of the
/// methods no client SDK sends.
fn require_owner(headers: &HeaderMap, project: &str, message: &str) -> Result<(), RestError> {
    if request_authorization(headers, project)?.is_owner() {
        Ok(())
    } else {
        Err(RestError::permission_denied(message))
    }
}

/// `POST …/documents/{parent}/{collectionId}`: the document is created with
/// the given `documentId` or an automatic one, evaluated by Security Rules as
/// a create, refused with `ALREADY_EXISTS` when it exists, and answered with
/// `mask`'s fields only.
pub(super) async fn create_document(
    state: &RestState,
    path: DocumentPath,
    parameters: Vec<(String, String)>,
    headers: &HeaderMap,
    body: &[u8],
) -> Result<Json<JsonValue>, RestError> {
    let document: Document = serde_json::from_value(request_json(body)?)
        .map_err(|_| RestError::invalid(PAYLOAD_INVALID))?;
    let root = format!(
        "projects/{}/databases/{}/documents",
        path.project, path.database
    );
    let (parent, collection_id) = match path.document.rsplit_once('/') {
        Some((parent, collection)) => (format!("{root}/{parent}"), collection.to_owned()),
        None => (root, path.document.clone()),
    };
    let mut document_id = String::new();
    let mut mask = Vec::new();
    for (key, value) in parameters {
        match key.as_str() {
            "documentId" => document_id = value,
            "mask.fieldPaths" => mask.push(value),
            // Standard Google API parameters (key, prettyPrint, …) and any
            // other unknown one are ignored, as the official emulator does.
            _ => {}
        }
    }
    let request = CreateDocumentRequest {
        parent,
        collection_id,
        document_id,
        document: Some(document),
        mask: (!mask.is_empty()).then_some(DocumentMask { field_paths: mask }),
        ..CreateDocumentRequest::default()
    };
    let created = state
        .service
        .create_document_for_client(request, read_options::authorization(headers)?)
        .await
        .map_err(|error| listing::status(&error))?;
    read_json::document(&created).map(Json)
}

/// runQuery with a consistency selector, through the native service; its
/// new transaction is the stream's first item, on its own.
pub(super) async fn run_query(
    state: &RestState,
    parent: String,
    mut body: JsonValue,
    headers: &HeaderMap,
) -> Result<Json<JsonValue>, RestError> {
    // The official REST adapter answers explainOptions with the plain
    // results, as the other runQuery path does.
    if let Some(body) = body.as_object_mut() {
        body.remove("explainOptions");
    }
    let request: RunQueryRequest = message(body, "parent", &parent)?;
    let responses = state
        .service
        .run_query_for_client(request, read_options::authorization(headers)?)
        .await
        .map_err(|error| listing::status(&error))?;
    let mut items = Vec::new();
    for mut response in responses {
        if !response.transaction.is_empty() && response.document.is_some() {
            items.push(json!({"transaction": super::BASE64.encode(&response.transaction)}));
            response.transaction.clear();
        }
        items.push(read_json::query(&response)?);
    }
    Ok(Json(JsonValue::Array(items)))
}

/// runAggregationQuery with a consistency selector, as [`run_query`].
pub(super) async fn run_aggregation_query(
    state: &RestState,
    parent: String,
    mut body: JsonValue,
    headers: &HeaderMap,
) -> Result<Json<JsonValue>, RestError> {
    if let Some(body) = body.as_object_mut() {
        body.remove("explainOptions");
    }
    let request: RunAggregationQueryRequest = message(body, "parent", &parent)?;
    let responses = state
        .service
        .run_aggregation_query_for_client(request, read_options::authorization(headers)?)
        .await
        .map_err(|error| listing::status(&error))?;
    let mut items = Vec::new();
    for mut response in responses {
        if !response.transaction.is_empty() && response.result.is_some() {
            items.push(json!({"transaction": super::BASE64.encode(&response.transaction)}));
            response.transaction.clear();
        }
        items.push(read_json::aggregation(&response)?);
    }
    Ok(Json(JsonValue::Array(items)))
}

/// `documents:batchWrite`: each write applied on its own, with a status per
/// write. The official emulator requires owner authentication here.
pub(super) async fn batch_write(
    State(state): State<RestState>,
    Path(path): Path<DatabasePath>,
    headers: HeaderMap,
    RestBody(body): RestBody,
) -> Result<Json<JsonValue>, RestError> {
    require_owner(
        &headers,
        &path.project,
        "Batch writes require admin authentication.",
    )?;
    let request: BatchWriteRequest = message(body, "database", &database(&path))?;
    let response = state
        .service
        .batch_write(tonic::Request::new(request))
        .await
        .map_err(|error| listing::status(&error))?;
    read_json::batch_write(&response.into_inner()).map(Json)
}

/// `documents:partitionQuery`. The official emulator does not implement it
/// (UNIMPLEMENTED); the native service does, as production does, and REST
/// answers it the same way. Its cursors name documents whatever the rules
/// say, so it needs owner authentication.
pub(super) async fn partition_at_root(
    State(state): State<RestState>,
    Path(path): Path<DatabasePath>,
    headers: HeaderMap,
    RestBody(body): RestBody,
) -> Result<Json<JsonValue>, RestError> {
    let parent = format!("{}/documents", database(&path));
    partition(&state, &path.project, parent, body, &headers).await
}

/// partitionQuery under `parent` (a document parent is refused by the
/// native service, as production refuses it).
pub(super) async fn partition(
    state: &RestState,
    project: &str,
    parent: String,
    body: JsonValue,
    headers: &HeaderMap,
) -> Result<Json<JsonValue>, RestError> {
    require_owner(
        headers,
        project,
        "Partition queries require admin authentication.",
    )?;
    let request: PartitionQueryRequest = message(body, "parent", &parent)?;
    let response = state
        .service
        .partition_query(tonic::Request::new(request))
        .await
        .map_err(|error| listing::status(&error))?;
    read_json::partition(&response.into_inner()).map(Json)
}

/// `documents:executePipeline`: the native service's Enterprise pipelines,
/// and production's `FAILED_PRECONDITION` on a Standard edition database.
pub(super) async fn execute_pipeline(
    State(state): State<RestState>,
    Path(path): Path<DatabasePath>,
    headers: HeaderMap,
    RestBody(body): RestBody,
) -> Result<Json<JsonValue>, RestError> {
    require_owner(
        &headers,
        &path.project,
        "Pipeline operations require admin authentication.",
    )?;
    let request: ExecutePipelineRequest = message(body, "database", &database(&path))?;
    let mut stream = state
        .service
        .execute_pipeline(tonic::Request::new(request))
        .await
        .map_err(|error| listing::status(&error))?
        .into_inner();
    let mut items = Vec::new();
    while let Some(response) = stream.next().await {
        let response = response.map_err(|error| listing::status(&error))?;
        let mut encoded = serde_json::to_value(response)
            .map_err(|error| RestError::internal(error.to_string()))?;
        firenook_grpc_front::utc_as_z(&mut encoded);
        items.push(encoded);
    }
    Ok(Json(JsonValue::Array(items)))
}

use base64::Engine as _;
