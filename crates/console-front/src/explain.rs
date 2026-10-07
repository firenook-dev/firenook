//! Why a query is slow, and what production would ask for before running it.
//!
//! The local engine answers every query it is given. Production does not: a
//! filter with an order on another field needs a composite index declared in
//! `firestore.indexes.json`, and a query that works perfectly here fails
//! there with nothing but a link. So this endpoint answers two different
//! questions at once — how the engine will answer the query now, taken from
//! the same code that answers it, and what the query would require of a real
//! project.
//!
//! Rules are not evaluated. The plan and the index requirement do not depend
//! on who is asking, and the count is the engine's own, so the console labels
//! it as such rather than implying a client would see those documents.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Instant;

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use firenook_core_store::{DatabaseName, Store};
use firenook_query_engine::{
    DatabaseEdition, IndexAdvice, IndexCatalog, IndexDirection, IndexMode, IndexScope, Limit,
    Query, QueryCandidates, QueryStrategy, execute, plan,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value as JsonValue};
use ts_rs::TS;

/// What the console asks about.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExplainRequest {
    /// Database id; `(default)` when absent.
    database: Option<String>,
    /// The document path a collection-group query is scoped under, or the
    /// parent of the collection, exactly as `runQuery` takes it.
    parent: Option<String>,
    /// The query, in the REST wire shape the console already builds.
    structured_query: Map<String, JsonValue>,
}

/// One field of the order the results arrive in.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ExplainOrder {
    /// Field path, or `__name__` for the document name.
    pub field: String,
    /// `true` when descending.
    pub descending: bool,
}

/// Where the candidate documents come from before any filter runs. This is
/// what separates a query that touches three documents from one that reads
/// the collection.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ExplainCandidates {
    /// The document names are pinned, so they are read directly.
    DocumentNames {
        #[ts(type = "number")]
        names: usize,
    },
    /// An equality field index narrows the collection first.
    EqualityIndex { fields: Vec<String> },
    /// Every document of the collection is read.
    CollectionScan,
    /// Every document of the collection group is read.
    CollectionGroupScan { ancestor: Option<String> },
}

/// How the results are produced once the candidates are chosen.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ExplainStrategy {
    /// Filtered and limited while reading, decoding only the fields a filter
    /// or an order looks at.
    Streaming,
    /// Disk keys are sorted on their order values before any payload is
    /// decoded.
    OrderedDisk,
    /// The whole result set is materialized and sorted in memory.
    Buffered,
}

/// One field of an index requirement, as `firestore.indexes.json` spells it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ExplainIndexField {
    pub field_path: String,
    /// `ascending`, `descending`, `arrayContains` or `vector`.
    pub mode: String,
    /// The dimension of a vector field, when that is the mode.
    #[ts(type = "number | null")]
    pub dimension: Option<usize>,
}

/// The index production would require for this query.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ExplainIndex {
    /// Whether the project's `firestore.indexes.json` already declares it.
    pub declared: bool,
    /// Whether it spans more than one field. Production creates single-field
    /// indexes inside a collection on its own and never creates these.
    pub composite: bool,
    pub collection_group: String,
    /// `collection` or `collectionGroup`.
    pub scope: String,
    pub fields: Vec<ExplainIndexField>,
    /// The entry to paste into `firestore.indexes.json`, already formatted.
    pub config_entry: String,
}

/// The answer: how this query runs, and what it would require elsewhere.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Explanation {
    pub database: String,
    /// The collection path, or the collection id of a group query.
    pub target: String,
    /// `collection` or `collectionGroup`.
    pub scope: String,
    pub candidates: ExplainCandidates,
    pub strategy: ExplainStrategy,
    pub orders: Vec<ExplainOrder>,
    /// Documents the engine matched, with no rules applied.
    #[ts(type = "number")]
    pub documents_matched: usize,
    /// Whether the query's own limit stopped it short, so the match count is
    /// a floor rather than the total.
    pub limited: bool,
    /// How long the engine took to answer it just now.
    #[ts(type = "number")]
    pub elapsed_micros: u64,
    /// The index requirement, when the query has one.
    pub index: Option<ExplainIndex>,
}

/// Everything the endpoint needs: the store to plan and run against, the
/// edition that decides value comparison, and the project's declared indexes.
#[derive(Clone)]
pub struct QueryExplainer {
    store: Store,
    project: Arc<str>,
    edition: DatabaseEdition,
    /// The declared indexes of each database that configures a file; a
    /// database without one declares nothing.
    indexes: Arc<BTreeMap<String, Arc<IndexCatalog>>>,
}

impl QueryExplainer {
    /// An explainer over `project`'s store. `indexes` holds the catalog
    /// parsed from each database's index file; a database with no entry
    /// declares nothing, so every requirement is reported as missing.
    #[must_use]
    pub fn new(
        store: &Store,
        project: &str,
        edition: DatabaseEdition,
        indexes: BTreeMap<String, Arc<IndexCatalog>>,
    ) -> Self {
        Self {
            store: store.clone(),
            project: Arc::from(project),
            edition,
            indexes: Arc::new(indexes),
        }
    }

    pub(crate) fn router(self) -> axum::Router {
        axum::Router::new()
            .route("/explain", axum::routing::post(explain))
            .with_state(self)
    }

    fn explain(&self, request: &ExplainRequest) -> Result<Explanation, ExplainError> {
        let database_id = request.database.as_deref().unwrap_or("(default)");
        let database = DatabaseName::new(self.project.as_ref(), database_id)
            .map_err(|error| ExplainError::invalid(error.to_string()))?;
        let query = firenook_rest_front::structured_query(
            &request.structured_query,
            request.parent.as_deref(),
        )
        .map_err(ExplainError::invalid)?;

        let snapshot = self.store.snapshot();
        let planned = plan(&snapshot, &database, &query)
            .map_err(|error| ExplainError::invalid(error.to_string()))?;
        // The same query the grid would issue, timed as the engine answers
        // it. Nothing is cached between the plan and the run, so the elapsed
        // time is the cost of the whole answer.
        let started = Instant::now();
        let documents = execute(&snapshot, &database, &query, self.edition)
            .map_err(|error| ExplainError::invalid(error.to_string()))?;
        let elapsed = started.elapsed();

        Ok(Explanation {
            database: database_id.to_owned(),
            target: planned.target,
            scope: scope_name(planned.scope).to_owned(),
            candidates: candidates(planned.candidates),
            strategy: strategy(planned.strategy),
            orders: planned
                .orders
                .iter()
                .map(|order| ExplainOrder {
                    field: order.path.to_string(),
                    descending: matches!(
                        order.direction,
                        firenook_query_engine::Direction::Descending
                    ),
                })
                .collect(),
            limited: limit_reached(&query, documents.len()),
            documents_matched: documents.len(),
            elapsed_micros: u64::try_from(elapsed.as_micros()).unwrap_or(u64::MAX),
            index: self
                .indexes
                .get(database_id)
                .cloned()
                .unwrap_or_default()
                .advise(&query)
                .as_ref()
                .map(index),
        })
    }
}

/// Whether the query's own limit is what stopped the count, which makes the
/// number a floor and not the total.
fn limit_reached(query: &Query, matched: usize) -> bool {
    match query.limit_ref() {
        Some(Limit::First(limit) | Limit::Last(limit)) => matched >= *limit,
        None => false,
    }
}

const fn scope_name(scope: IndexScope) -> &'static str {
    match scope {
        IndexScope::Collection => "collection",
        IndexScope::CollectionGroup => "collectionGroup",
    }
}

fn candidates(candidates: QueryCandidates) -> ExplainCandidates {
    match candidates {
        QueryCandidates::DocumentNames { names } => ExplainCandidates::DocumentNames { names },
        QueryCandidates::EqualityIndex { fields } => ExplainCandidates::EqualityIndex { fields },
        QueryCandidates::CollectionScan => ExplainCandidates::CollectionScan,
        QueryCandidates::CollectionGroupScan { ancestor } => {
            ExplainCandidates::CollectionGroupScan { ancestor }
        }
    }
}

const fn strategy(strategy: QueryStrategy) -> ExplainStrategy {
    match strategy {
        QueryStrategy::Streaming => ExplainStrategy::Streaming,
        QueryStrategy::OrderedDisk => ExplainStrategy::OrderedDisk,
        QueryStrategy::Buffered => ExplainStrategy::Buffered,
    }
}

fn index(advice: &IndexAdvice) -> ExplainIndex {
    let entry = advice.requirement.config_entry();
    ExplainIndex {
        declared: advice.declared,
        composite: advice.requirement.is_composite(),
        collection_group: advice.requirement.collection_group.clone(),
        scope: scope_name(advice.requirement.query_scope).to_owned(),
        fields: advice
            .requirement
            .fields
            .iter()
            .map(|field| ExplainIndexField {
                field_path: field.field_path.clone(),
                mode: match field.mode {
                    IndexMode::Ordered(IndexDirection::Ascending) => "ascending",
                    IndexMode::Ordered(IndexDirection::Descending) => "descending",
                    IndexMode::ArrayContains => "arrayContains",
                    IndexMode::Vector(_) => "vector",
                }
                .to_owned(),
                dimension: match field.mode {
                    IndexMode::Vector(dimension) => Some(dimension),
                    IndexMode::Ordered(_) | IndexMode::ArrayContains => None,
                },
            })
            .collect(),
        config_entry: serde_json::to_string_pretty(&entry).unwrap_or_else(|_| entry.to_string()),
    }
}

struct ExplainError {
    status: StatusCode,
    message: String,
}

impl ExplainError {
    fn invalid(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: message.into(),
        }
    }
}

impl IntoResponse for ExplainError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(serde_json::json!({ "error": { "message": self.message } })),
        )
            .into_response()
    }
}

/// `POST /explain`: how this query runs, and what it needs in production.
async fn explain(
    State(explainer): State<QueryExplainer>,
    Json(request): Json<ExplainRequest>,
) -> Result<Json<Explanation>, ExplainError> {
    // Planning reads the store and running the query reads every candidate,
    // which is work the async workers must not block on.
    tokio::task::spawn_blocking(move || explainer.explain(&request))
        .await
        .map_err(|_| ExplainError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: "the explain task did not finish".to_owned(),
        })?
        .map(Json)
}

#[cfg(test)]
mod tests {
    use axum::body::{Body, to_bytes};
    use axum::http::Request;
    use firenook_core_store::{DocumentKey, Fields, Value, Write};
    use tower::ServiceExt as _;

    use super::*;

    const PROJECT: &str = "demo-explain";

    fn database() -> DatabaseName {
        DatabaseName::new(PROJECT, "(default)").expect("name")
    }

    fn store() -> Store {
        let store = Store::default();
        let writes = (0..5)
            .map(|index| Write::Create {
                key: DocumentKey::new(database(), format!("teams/t1/orders/o{index}"))
                    .expect("path"),
                fields: Fields::from([
                    ("status".to_owned(), Value::String("open".into())),
                    ("total".to_owned(), Value::Integer(i64::from(index))),
                ]),
            })
            .collect::<Vec<_>>();
        store.commit(&writes).expect("commit");
        store
    }

    fn explainer(indexes: BTreeMap<String, Arc<IndexCatalog>>) -> QueryExplainer {
        QueryExplainer::new(&store(), PROJECT, DatabaseEdition::Standard, indexes)
    }

    async fn ask(explainer: QueryExplainer, body: serde_json::Value) -> (StatusCode, JsonValue) {
        let response = explainer
            .router()
            .oneshot(
                Request::post("/explain")
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string()))
                    .expect("request"),
            )
            .await
            .expect("response");
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body");
        (status, serde_json::from_slice(&bytes).expect("json"))
    }

    /// The query the console's line `where("status","==","open").orderBy("total")`
    /// produces.
    fn composite_body() -> serde_json::Value {
        serde_json::json!({
            "parent": "teams/t1",
            "structuredQuery": {
                "from": [{ "collectionId": "orders" }],
                "where": {
                    "fieldFilter": {
                        "field": { "fieldPath": "status" },
                        "op": "EQUAL",
                        "value": { "stringValue": "open" },
                    }
                },
                "orderBy": [{ "field": { "fieldPath": "total" }, "direction": "ASCENDING" }],
            }
        })
    }

    #[tokio::test]
    async fn an_unfiltered_collection_reads_every_document_and_needs_no_index() {
        let (status, body) = ask(
            explainer(BTreeMap::new()),
            serde_json::json!({
                "parent": "teams/t1",
                "structuredQuery": { "from": [{ "collectionId": "orders" }] }
            }),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["target"], "teams/t1/orders");
        assert_eq!(body["scope"], "collection");
        assert_eq!(body["candidates"]["kind"], "collectionScan");
        assert_eq!(body["strategy"], "streaming");
        assert_eq!(body["documentsMatched"], 5);
        assert_eq!(body["limited"], false);
        assert_eq!(body["orders"][0]["field"], "__name__");
        assert!(body["index"].is_null(), "{body}");
        assert!(body["elapsedMicros"].is_u64());
    }

    #[tokio::test]
    async fn a_filter_with_an_order_elsewhere_names_the_composite_index() {
        let (status, body) = ask(explainer(BTreeMap::new()), composite_body()).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["index"]["composite"], true);
        assert_eq!(body["index"]["declared"], false);
        assert_eq!(body["index"]["collectionGroup"], "orders");
        assert_eq!(body["index"]["scope"], "collection");
        assert_eq!(body["index"]["fields"][0]["fieldPath"], "status");
        assert_eq!(body["index"]["fields"][0]["mode"], "ascending");
        assert_eq!(body["index"]["fields"][1]["fieldPath"], "total");
        // What we tell people to paste has to be what the engine accepts.
        let entry = body["index"]["configEntry"].as_str().expect("an entry");
        let catalog = IndexCatalog::from_json(&format!("{{\"indexes\":[{entry}]}}"))
            .expect("the entry we print is a valid index file");
        let declared: BTreeMap<String, Arc<IndexCatalog>> =
            BTreeMap::from([("(default)".to_owned(), Arc::new(catalog))]);
        let (_, body) = ask(explainer(declared), composite_body()).await;
        assert_eq!(
            body["index"]["declared"], true,
            "declaring the printed entry must satisfy the query: {body}"
        );
    }

    #[tokio::test]
    async fn a_limit_marks_the_count_as_a_floor() {
        let (_, body) = ask(
            explainer(BTreeMap::new()),
            serde_json::json!({
                "structuredQuery": {
                    "from": [{ "collectionId": "orders", "allDescendants": true }],
                    "limit": 2,
                }
            }),
        )
        .await;
        assert_eq!(body["scope"], "collectionGroup");
        assert_eq!(body["target"], "orders");
        assert_eq!(body["candidates"]["kind"], "collectionGroupScan");
        assert_eq!(body["documentsMatched"], 2);
        assert_eq!(body["limited"], true, "{body}");
    }

    #[tokio::test]
    async fn a_collection_group_filter_needs_its_index_declared_even_on_one_field() {
        let (_, body) = ask(
            explainer(BTreeMap::new()),
            serde_json::json!({
                "structuredQuery": {
                    "from": [{ "collectionId": "orders", "allDescendants": true }],
                    "where": {
                        "fieldFilter": {
                            "field": { "fieldPath": "status" },
                            "op": "EQUAL",
                            "value": { "stringValue": "open" },
                        }
                    },
                }
            }),
        )
        .await;
        assert_eq!(body["index"]["scope"], "collectionGroup");
        assert_eq!(body["index"]["composite"], false);
        assert_eq!(body["index"]["declared"], false);
    }

    #[tokio::test]
    async fn a_query_that_does_not_decode_is_refused_with_a_reason() {
        let (status, body) = ask(
            explainer(BTreeMap::new()),
            serde_json::json!({ "structuredQuery": { "from": [] } }),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(
            body["error"]["message"]
                .as_str()
                .is_some_and(|message| message.contains("collection selector")),
            "{body}"
        );
    }

    #[tokio::test]
    async fn an_invalid_database_is_refused_rather_than_silently_answered_as_default() {
        let (status, body) = ask(
            explainer(BTreeMap::new()),
            serde_json::json!({
                "database": "has/a/slash",
                "structuredQuery": { "from": [{ "collectionId": "orders" }] }
            }),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    }

    #[tokio::test]
    async fn the_named_database_is_the_one_explained() {
        let (_, body) = ask(
            explainer(BTreeMap::new()),
            serde_json::json!({
                "database": "analytics",
                "structuredQuery": { "from": [{ "collectionId": "orders" }] }
            }),
        )
        .await;
        assert_eq!(body["database"], "analytics");
        assert_eq!(
            body["documentsMatched"], 0,
            "another database holds none of these documents: {body}"
        );
    }
}
