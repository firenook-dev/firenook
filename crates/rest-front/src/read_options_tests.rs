use super::*;
use axum::body::to_bytes;
use tower::ServiceExt as _;

const ROOT: &str = "/v1/projects/demo-fireside-rest-reads/databases/(default)/documents";

fn fixture() -> JsonValue {
    serde_json::from_str(include_str!(
        "../../../conformance/fixtures/rest-read-options-v1/fixture.json"
    ))
    .unwrap()
}

async fn request(
    router: &Router,
    path: &str,
    method: &str,
    body: JsonValue,
    owner: bool,
) -> (StatusCode, JsonValue) {
    let mut request = Request::builder()
        .uri(format!("{ROOT}{path}"))
        .method(method)
        .header(CONTENT_TYPE, "application/json");
    if owner {
        request = request.header(AUTHORIZATION, "Bearer owner");
    }
    let response = router
        .clone()
        .oneshot(
            request
                .body(Body::from(serde_json::to_vec(&body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

async fn seeded() -> (Router, JsonValue) {
    let fixture = fixture();
    let rules = RulesRuntime::default();
    rules
        .install_default(fixture["rules"].as_str().unwrap())
        .unwrap();
    let router = router_with_query_policy_memory_and_rules(
        Store::default(),
        QueryPolicy::default(),
        None,
        rules,
    );
    let (status, seed) = request(
        &router,
        "/notes/a",
        "PATCH",
        fixture["exchanges"][0]["body"].clone(),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    if fixture["exchanges"][0]["id"] == "seed" && fixture["exchanges"][0]["status"] == 200 {
        firenook_conformance_ledger::checked(
            "rest-read-options-v1",
            "seed",
            firenook_conformance_ledger::Compared::Status,
        );
    }
    (router, seed)
}

#[tokio::test]
async fn native_read_adapter_preserves_rest_value_json_and_sdk_utc_timestamps() {
    let (router, _) = seeded().await;
    let fields = json!({
        "nullable":{"nullValue":null},
        "special":{"doubleValue":"NaN"},
        "infinity":{"doubleValue":"Infinity"},
        "when":{"timestampValue":"2026-01-02T03:04:05.123Z"},
        "nested":{"mapValue":{"fields":{
            "timestampValue":{"stringValue":"literal+00:00"},
            "nullValue":{"stringValue":"NULL_VALUE"},
            "items":{"arrayValue":{"values":[{"nullValue":null},{"doubleValue":"-Infinity"}]}}
        }}}
    });
    let (status, written) = request(
        &router,
        "/notes/values",
        "PATCH",
        json!({"fields":fields}),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, read) = request(&router, "/notes/values", "GET", JsonValue::Null, true).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(read, written);
    let (status, batch) = request(
        &router,
        ":batchGet",
        "POST",
        json!({"documents":[format!("{}/notes/values", &ROOT[4..])]}),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(batch[0]["found"], written);
    assert!(batch[0]["readTime"].as_str().unwrap().ends_with('Z'));
    let token = transaction(&router, false).await;
    let (status, commit) =
        request(&router, ":commit", "POST", transaction_write(&token), true).await;
    assert_eq!(status, StatusCode::OK);
    assert!(commit["commitTime"].as_str().unwrap().ends_with('Z'));
    assert!(
        commit["writeResults"][0]["updateTime"]
            .as_str()
            .unwrap()
            .ends_with('Z')
    );
}

fn query_value(value: &str) -> String {
    use std::fmt::Write as _;
    value.bytes().fold(String::new(), |mut output, byte| {
        if byte.is_ascii_alphanumeric() || b"-._~".contains(&byte) {
            output.push(char::from(byte));
        } else {
            write!(output, "%{byte:02X}").unwrap();
        }
        output
    })
}

async fn transaction(router: &Router, read_only: bool) -> String {
    let options = if read_only {
        json!({"readOnly":{}})
    } else {
        json!({"readWrite":{}})
    };
    let (status, result) = request(
        router,
        ":beginTransaction",
        "POST",
        json!({"options":options}),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    result["transaction"].as_str().unwrap().to_owned()
}

fn transaction_write(token: &str) -> JsonValue {
    json!({"transaction":token,"writes":[{"update":{
        "name":format!("{}/notes/a", &ROOT[4..]),
        "fields":{"title":{"stringValue":"committed"}}
    }}]})
}

#[tokio::test]
async fn rest_transaction_commits_preserve_native_read_conflicts_and_rules() {
    let (router, _) = seeded().await;
    let token = transaction(&router, false).await;
    let path = format!("/notes/a?transaction={}", query_value(&token));
    assert_eq!(
        request(&router, &path, "GET", JsonValue::Null, true)
            .await
            .0,
        StatusCode::OK
    );
    request(
        &router,
        "/notes/a",
        "PATCH",
        json!({"fields":{"title":{"stringValue":"changed"}}}),
        true,
    )
    .await;
    let (status, result) =
        request(&router, ":commit", "POST", transaction_write(&token), true).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(result["error"]["status"], "ABORTED");
    assert_eq!(
        request(&router, "/notes/a", "GET", JsonValue::Null, true)
            .await
            .1["fields"]["title"]["stringValue"],
        "changed"
    );

    let token = transaction(&router, false).await;
    assert_eq!(
        request(&router, ":commit", "POST", transaction_write(&token), false)
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    let token = transaction(&router, true).await;
    let (status, result) =
        request(&router, ":commit", "POST", transaction_write(&token), true).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(result["error"]["status"], "FAILED_PRECONDITION");
    let token = transaction(&router, false).await;
    assert_eq!(
        request(&router, ":commit", "POST", transaction_write(&token), true)
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        request(&router, "/notes/a", "GET", JsonValue::Null, true)
            .await
            .1["fields"]["title"]["stringValue"],
        "committed"
    );
}

/// #169: two transactions read the same missing document and both write
/// it. Whether the read was a single-document GET or a batchGet, the second
/// commit is ABORTED and the first one's write stands, so no update is lost.
#[tokio::test]
async fn a_missing_document_read_in_a_transaction_is_checked_at_commit() {
    let (router, _) = seeded().await;
    let name = format!("{}/notes/seq", &ROOT[4..]);
    let write = |token: &str, seq: &str| {
        json!({"transaction":token,"writes":[{"update":{
            "name":name,
            "fields":{"seq":{"integerValue":seq}}
        }}]})
    };
    for read in ["get", "batchGet"] {
        request(&router, "/notes/seq", "DELETE", JsonValue::Null, true).await;
        let first = transaction(&router, false).await;
        let second = transaction(&router, false).await;
        for token in [&first, &second] {
            let status = if read == "get" {
                let path = format!("/notes/seq?transaction={}", query_value(token));
                request(&router, &path, "GET", JsonValue::Null, true)
                    .await
                    .0
            } else {
                request(
                    &router,
                    ":batchGet",
                    "POST",
                    json!({"documents":[name], "transaction":token}),
                    true,
                )
                .await
                .0
            };
            let expected = if read == "get" {
                StatusCode::NOT_FOUND
            } else {
                StatusCode::OK
            };
            assert_eq!(status, expected, "{read} of the missing document");
        }
        let (status, _) = request(&router, ":commit", "POST", write(&first, "1"), true).await;
        assert_eq!(status, StatusCode::OK, "{read}: the first commit");
        let (status, result) = request(&router, ":commit", "POST", write(&second, "2"), true).await;
        assert_eq!(status, StatusCode::CONFLICT, "{read}: the second commit");
        assert_eq!(result["error"]["status"], "ABORTED", "{read}");
        let (_, stored) = request(&router, "/notes/seq", "GET", JsonValue::Null, true).await;
        assert_eq!(stored["fields"]["seq"]["integerValue"], "1", "{read}");
    }
}

#[tokio::test]
async fn rest_get_masks_and_denials_match_captured_observations() {
    let (router, _) = seeded().await;
    for row in fixture()["exchanges"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|row| {
            matches!(
                row["id"].as_str(),
                Some(
                    "get-mask"
                        | "get-nested-mask"
                        | "get-absent-mask"
                        | "get-repeated-mask"
                        | "get-invalid-mask"
                        | "get-anonymous"
                )
            )
        })
    {
        let (status, result) = request(
            &router,
            row["path"].as_str().unwrap(),
            "GET",
            JsonValue::Null,
            row["owner"].as_bool().unwrap(),
        )
        .await;
        assert_eq!(
            u64::from(status.as_u16()),
            row["status"].as_u64().unwrap(),
            "{}",
            row["id"]
        );
        if status.is_success() {
            assert_eq!(result["fields"], row["response"]["fields"], "{}", row["id"]);
        }
        // A read's fields as recorded; a refusal's status.
        firenook_conformance_ledger::checked(
            "rest-read-options-v1",
            row["id"].as_str().unwrap(),
            if status.is_success() {
                firenook_conformance_ledger::Compared::Answer
            } else {
                firenook_conformance_ledger::Compared::Status
            },
        );
    }
}

#[tokio::test]
async fn rest_batch_mask_projects_the_captured_fields_and_does_not_bypass_rules() {
    let (router, _) = seeded().await;
    let body =
        json!({"documents":[format!("{}/notes/a",&ROOT[4..])],"mask":{"fieldPaths":["title"]}});
    let (status, result) = request(&router, ":batchGet", "POST", body.clone(), true).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        result[0]["found"]["fields"],
        json!({"title":{"stringValue":"before 火🔥"}})
    );
    assert_eq!(
        request(&router, ":batchGet", "POST", body, false).await.0,
        StatusCode::FORBIDDEN
    );
}

#[tokio::test]
async fn rest_consistency_selectors_share_native_snapshots_and_rollback() {
    let (router, seed) = seeded().await;
    let (status, begin) = request(
        &router,
        ":beginTransaction",
        "POST",
        json!({"options":{"readOnly":{}}}),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let token = begin["transaction"].as_str().unwrap();
    let path = format!(
        "/notes/a?transaction={}&mask.fieldPaths=title",
        query_value(token)
    );
    assert_eq!(
        request(&router, &path, "GET", JsonValue::Null, true)
            .await
            .1["fields"]["title"]["stringValue"],
        "before 火🔥"
    );
    request(
        &router,
        "/notes/a",
        "PATCH",
        json!({"fields":{"title":{"stringValue":"after"}}}),
        true,
    )
    .await;
    let (status, old) = request(&router, &path, "GET", JsonValue::Null, true).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(old["fields"]["title"]["stringValue"], "before 火🔥");
    let documents = json!([
        format!("{}/notes/a", &ROOT[4..]),
        format!("{}/notes/missing", &ROOT[4..])
    ]);
    let (status, old) = request(
        &router,
        ":batchGet",
        "POST",
        json!({"documents":documents,"transaction":token,"mask":{"fieldPaths":["title"]}}),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        old[0]["found"]["fields"]["title"]["stringValue"],
        "before 火🔥"
    );
    let (status, historical) = request(
        &router,
        ":batchGet",
        "POST",
        json!({"documents":documents,"readTime":seed["updateTime"]}),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        historical[0]["found"]["fields"]["title"]["stringValue"],
        "before 火🔥"
    );
    let (status, fresh) = request(
        &router,
        ":batchGet",
        "POST",
        json!({"documents":documents,"newTransaction":{"readOnly":{}}}),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(fresh[0].as_object().unwrap().len(), 1);
    assert!(
        fresh[0]["transaction"]
            .as_str()
            .is_some_and(|token| !token.is_empty())
    );
    assert_eq!(
        request(
            &router,
            ":rollback",
            "POST",
            json!({"transaction":token}),
            true
        )
        .await
        .0,
        StatusCode::OK
    );
    assert!(
        !request(&router, &path, "GET", JsonValue::Null, true)
            .await
            .0
            .is_success()
    );
}

/// The capture's three gRPC `GetDocument` calls (`grpcGet` in
/// `conformance/src/suite/capture-rest-read-options.mjs`), each in the
/// read-only transaction the REST `beginTransaction` opened, sent to the
/// gRPC service the REST routes share, as the product composes them: before
/// the mutation, after it, and after the REST rollback.
#[tokio::test]
#[allow(clippy::too_many_lines)] // The capture's sequence reads best whole.
async fn grpc_get_document_in_the_rest_transaction_matches_the_captured_calls() {
    use firenook_grpc_front::FirestoreService;
    use firenook_grpc_front::google::firestore::v1::firestore_server::Firestore as _;
    use firenook_grpc_front::google::firestore::v1::{
        DocumentMask, GetDocumentRequest, get_document_request::ConsistencySelector,
    };

    const SET: &str = "rest-read-options-v1";
    let fixture = fixture();
    let recorded = |id: &str| {
        fixture["grpc"]
            .as_array()
            .unwrap()
            .iter()
            .find(|call| call["id"] == id)
            .unwrap()
            .clone()
    };
    let rules = RulesRuntime::default();
    rules
        .install_default(fixture["rules"].as_str().unwrap())
        .unwrap();
    let store = Store::default();
    let service = FirestoreService::new_with_query_policy_and_rules(
        store.clone(),
        QueryPolicy::default(),
        rules.clone(),
    );
    let router = router_with_shared_service(
        store,
        QueryPolicy::default(),
        None,
        rules,
        TriggerRegistry::default(),
        service.clone(),
    );
    let (status, seed) = request(
        &router,
        "/notes/a",
        "PATCH",
        fixture["exchanges"][0]["body"].clone(),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let token = transaction(&router, true).await;
    let get = || {
        let mut call = tonic::Request::new(GetDocumentRequest {
            name: format!("{}/notes/a", &ROOT[4..]),
            mask: Some(DocumentMask {
                field_paths: vec!["title".to_owned()],
            }),
            consistency_selector: Some(ConsistencySelector::Transaction(
                BASE64.decode(&token).unwrap(),
            )),
            ..GetDocumentRequest::default()
        });
        call.metadata_mut()
            .insert("authorization", "Bearer owner".parse().unwrap());
        service.get_document(call)
    };
    // A document read in the transaction: its name, the masked field and the
    // seed's version, which the recording shows as `{seconds, nanos}` equal
    // to the seed answer's `updateTime` (and here the replay's own seed).
    let seed_version = time::OffsetDateTime::parse(seed["updateTime"].as_str().unwrap(), &Rfc3339)
        .unwrap()
        .unix_timestamp_nanos();
    let recorded_seed_version = time::OffsetDateTime::parse(
        fixture["exchanges"][0]["response"]["updateTime"]
            .as_str()
            .unwrap(),
        &Rfc3339,
    )
    .unwrap()
    .unix_timestamp_nanos();
    let instant = |timestamp: &JsonValue| {
        i128::from(
            timestamp["seconds"]
                .as_str()
                .unwrap()
                .parse::<i64>()
                .unwrap(),
        ) * 1_000_000_000
            + i128::from(timestamp["nanos"].as_i64().unwrap())
    };
    let matches_read =
        |id: &str, document: &firenook_grpc_front::google::firestore::v1::Document| {
            let call = recorded(id);
            let create = document
                .create_time
                .as_ref()
                .map(|time| i128::from(time.seconds) * 1_000_000_000 + i128::from(time.nanos));
            let update = document
                .update_time
                .as_ref()
                .map(|time| i128::from(time.seconds) * 1_000_000_000 + i128::from(time.nanos));
            call["status"] == 0
                && document.name == call["response"]["name"]
                && document.fields.keys().collect::<Vec<_>>() == ["title"]
                && call["response"]["fields"].as_object().unwrap().len() == 1
                && matches!(
                    &document.fields["title"].value_type,
                    Some(firenook_grpc_front::google::firestore::v1::value::ValueType::StringValue(title))
                        if *title == call["response"]["fields"]["title"]["stringValue"]
                )
                && instant(&call["response"]["createTime"]) == recorded_seed_version
                && instant(&call["response"]["updateTime"]) == recorded_seed_version
                && create == Some(seed_version)
                && update == Some(seed_version)
        };

    let before = get().await.unwrap().into_inner();
    assert!(matches_read("get-in-read-only", &before), "{before:?}");
    firenook_conformance_ledger::checked(
        SET,
        "grpc/get-in-read-only",
        firenook_conformance_ledger::Compared::Answer,
    );

    let mutate = fixture["exchanges"]
        .as_array()
        .unwrap()
        .iter()
        .find(|exchange| exchange["id"] == "mutate")
        .unwrap();
    let (status, _) = request(&router, "/notes/a", "PATCH", mutate["body"].clone(), true).await;
    assert_eq!(status, StatusCode::OK);
    let after = get().await.unwrap().into_inner();
    assert!(
        matches_read("get-read-only-after-mutation", &after),
        "{after:?}"
    );
    firenook_conformance_ledger::checked(
        SET,
        "grpc/get-read-only-after-mutation",
        firenook_conformance_ledger::Compared::Answer,
    );

    let (status, _) = request(
        &router,
        ":rollback",
        "POST",
        json!({"transaction":token}),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let refused = get()
        .await
        .expect_err("a rolled-back transaction refuses reads");
    let call = recorded("get-rolled-back");
    assert_eq!(
        i64::from(refused.code() as i32),
        call["status"].as_i64().unwrap()
    );
    assert_eq!(refused.message(), call["details"].as_str().unwrap());
    firenook_conformance_ledger::checked(
        SET,
        "grpc/get-rolled-back",
        firenook_conformance_ledger::Compared::Error,
    );
}
