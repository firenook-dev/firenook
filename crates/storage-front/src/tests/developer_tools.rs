use super::*;

#[tokio::test]
async fn configured_default_bucket_matches_official_ui_discovery() {
    let fixture: JsonValue = serde_json::from_str(include_str!(
        "../../../../conformance/fixtures/developer-tools-buckets-v1/fixture.json"
    ))
    .expect("official bucket discovery");
    let (runtime, _dispatches, root) = runtime("bucket-ui", None).await;
    // The UI asked twice in one session; both answers are the same listing.
    for (index, exchange) in fixture["exchanges"]
        .as_array()
        .expect("exchanges")
        .iter()
        .enumerate()
    {
        assert_eq!(exchange["method"], "GET");
        let response = runtime
            .application()
            .oneshot(request(
                Method::GET,
                exchange["path"].as_str().expect("path"),
                Body::empty(),
            ))
            .await
            .expect("discovery");
        assert_eq!(u64::from(response.status().as_u16()), exchange["status"]);
        let mut actual: JsonValue = serde_json::from_slice(
            &to_bytes(response.into_body(), usize::MAX)
                .await
                .expect("body"),
        )
        .expect("JSON");
        let expected = &exchange["response"];
        let bucket = &mut actual["items"][0];
        assert_eq!(bucket["name"], format!("{PROJECT}.appspot.com"));
        assert_eq!(bucket["id"], bucket["name"]);
        assert_eq!(
            bucket["selfLink"],
            format!("http://127.0.0.1:21002/v1/b/{PROJECT}.appspot.com")
        );
        assert!(OffsetDateTime::parse(bucket["timeCreated"].as_str().unwrap(), &Rfc3339).is_ok());
        assert_eq!(bucket["timeCreated"], bucket["updated"]);
        for field in ["name", "id", "selfLink", "timeCreated", "updated"] {
            bucket[field] = expected["items"][0][field].clone();
        }
        assert_eq!(&actual, expected);
        firenook_conformance_ledger::checked(
            "developer-tools-buckets-v1",
            &(index + 1).to_string(),
            firenook_conformance_ledger::Compared::Answer,
        );
    }
    runtime.shutdown().await.expect("shutdown");
    std::fs::remove_dir_all(root).expect("remove synthetic storage");
}

/// The capture's sanitiser (`observe-ui.mjs`): token, password and salt
/// fields are left out of the recorded answers.
fn sanitize(value: &JsonValue) -> JsonValue {
    match value {
        JsonValue::Object(fields) => JsonValue::Object(
            fields
                .iter()
                .filter(|(key, _)| {
                    let key = key.to_ascii_lowercase();
                    !["token", "password", "salt"]
                        .iter()
                        .any(|word| key.contains(word))
                })
                .map(|(key, child)| (key.clone(), sanitize(child)))
                .collect(),
        ),
        JsonValue::Array(items) => JsonValue::Array(items.iter().map(sanitize).collect()),
        other => other.clone(),
    }
}

/// The Storage requests the official Emulator UI made in
/// `developer-tools-v1` (`browser.exchanges`, service `storage`), sent in
/// order to the Storage router with the project's open rules. The capture
/// kept each request's path and query keys, not the values: the UI lists the
/// bucket root (`delimiter=/`, empty `prefix`), uploads the file its test
/// picked with the Firebase JS SDK (a multipart upload named by `name`; the
/// bytes are `observe-ui.mjs`'s file) and deletes it with "Delete all files".
#[tokio::test]
#[allow(clippy::too_many_lines)]
async fn official_ui_storage_requests_replay_in_order() {
    let fixture: JsonValue = serde_json::from_str(include_str!(
        "../../../../conformance/fixtures/developer-tools-v1/fixture.json"
    ))
    .expect("developer tools fixture");
    let project = fixture["project"].as_str().expect("project");
    let bucket = format!("{project}.appspot.com");
    let root = test_root("ui-storage");
    let registry = TriggerRegistry::default();
    let (observer, _dispatches) = TriggerObserver::channel(registry.clone());
    let runtime = StorageRuntime::start(
        StorageConfig {
            project: project.to_owned(),
            durability: StorageDurability::default(),
            origin: "http://127.0.0.1:21002".to_owned(),
            data_dir: root.clone(),
            // The capture's storage.rules.
            rules: Some(NativeRulesConfig {
                source: RulesSource::Single(RulesFile {
                    name: "storage.rules".to_owned(),
                    content: "rules_version = '2'; service firebase.storage { match /b/{bucket}/o { match /{object=**} { allow read, write: if true; } } }\n".to_owned(),
                }),
                documents: Arc::new(NoFirestoreDocuments),
            }),
        },
        observer.queue(),
        registry,
    )
    .await
    .expect("Storage runtime");
    let file = "Independent developer-tool fixture 中文 🚀\n";
    let boundary = "18446744073709551615";
    let exchanges: Vec<(usize, &JsonValue)> = fixture["browser"]["exchanges"]
        .as_array()
        .expect("exchanges")
        .iter()
        .enumerate()
        .filter(|(_, exchange)| exchange["service"] == "storage")
        .collect();
    assert_eq!(exchanges.len(), 12);
    let mut generation = None;
    for (index, exchange) in exchanges {
        let case = format!("ui/{}", index + 1);
        let path = exchange["path"].as_str().expect("path");
        assert!(
            path.starts_with(&format!("/v0/b/{bucket}/o")),
            "{case}: {path}"
        );
        let method = exchange["method"].as_str().expect("method");
        let keys: Vec<&str> = exchange["queryKeys"]
            .as_array()
            .expect("query keys")
            .iter()
            .map(|key| key.as_str().expect("key"))
            .collect();
        let mut builder = Request::builder()
            .header(header::AUTHORIZATION, "Bearer owner")
            .method(method);
        let body = match (method, keys.as_slice()) {
            ("GET", ["delimiter", "prefix"]) => {
                builder = builder.uri(format!("{path}?delimiter=%2F&prefix="));
                Body::empty()
            }
            ("POST", ["name"]) => {
                // @firebase/storage `multipartUpload`: the metadata part is
                // the writable fields set (`name`, the file's `contentType`).
                builder = builder
                    .uri(format!("{path}?name=synthetic.txt"))
                    .header("x-goog-upload-protocol", "multipart")
                    .header(
                        header::CONTENT_TYPE,
                        format!("multipart/related; boundary={boundary}"),
                    );
                Body::from(format!(
                    "--{boundary}\r\nContent-Type: application/json; charset=utf-8\r\n\r\n{{\"name\":\"synthetic.txt\",\"contentType\":\"text/plain\"}}\r\n--{boundary}\r\nContent-Type: text/plain\r\n\r\n{file}\r\n--{boundary}--"
                ))
            }
            (_, []) => {
                builder = builder.uri(path);
                Body::empty()
            }
            other => panic!("{case}: unexpected request {other:?}"),
        };
        let response = runtime
            .application()
            .oneshot(builder.body(body).expect("request"))
            .await
            .expect("response");
        let status = response.status().as_u16();
        let bytes = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body");
        assert_eq!(u64::from(status), exchange["status"], "{case}: status");
        let recorded = &exchange["response"];
        if recorded.is_null() {
            // The capture could not read this body (a 404 and a 204 here);
            // a 204 has none by definition.
            let compared = if status == 204 {
                assert!(bytes.is_empty(), "{case}: a 204 has no body");
                firenook_conformance_ledger::Compared::Answer
            } else {
                firenook_conformance_ledger::Compared::Status
            };
            firenook_conformance_ledger::checked("developer-tools-v1", &case, compared);
            continue;
        }
        let mut actual = sanitize(&serde_json::from_slice(&bytes).expect("JSON"));
        if actual.get("name").is_some() {
            // Generated per run: the generation and its etag, and the times
            // the fixture already replaced with <timestamp>.
            let value = actual["generation"]
                .as_str()
                .expect("generation")
                .to_owned();
            assert!(value.bytes().all(|byte| byte.is_ascii_digit()), "{case}");
            assert_eq!(
                *generation.get_or_insert_with(|| value.clone()),
                value,
                "{case}"
            );
            assert!(actual["etag"].as_str().is_some_and(|etag| !etag.is_empty()));
            for field in ["generation", "etag", "timeCreated", "updated"] {
                actual[field] = recorded[field].clone();
            }
            assert!(
                recorded["timeCreated"] == "<timestamp>" && recorded["updated"] == "<timestamp>"
            );
        }
        assert_eq!(&actual, recorded, "{case}: body");
        firenook_conformance_ledger::checked(
            "developer-tools-v1",
            &case,
            firenook_conformance_ledger::Compared::Answer,
        );
    }
    runtime.shutdown().await.expect("shutdown");
    std::fs::remove_dir_all(root).expect("remove synthetic storage");
}
