use std::path::PathBuf;

use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode};
use firenook_functions_bridge::{TriggerObserver, TriggerRegistry};
use serde_json::Value as JsonValue;
use time::OffsetDateTime;
use tower::ServiceExt as _;

use super::*;

const PROJECT: &str = "demo-fireside-storage-list-pagination";
const BUCKET: &str = "synthetic-objects.example.test";
const ORACLE: &str = include_str!(
    "../../../conformance/fixtures/firebase-suite-v1/storage-list-pagination/fixture.json"
);

#[test]
fn list_page_replays_the_official_pagination_fixture() {
    let fixture: JsonValue = serde_json::from_str(ORACLE).expect("oracle fixture");
    assert_eq!(fixture["targetVersion"], "15.22.0");
    assert_eq!(fixture["objectCorpus"]["count"], 1_002);
    let data = corpus();

    let first = list_objects(&data, BUCKET, "objects/", None, None, 1_000);
    assert_page(&first, fixture_observation(&fixture, "gcs-default-first"));
    let second = list_objects(
        &data,
        BUCKET,
        "objects/",
        None,
        first.next_page_token.as_deref(),
        1_000,
    );
    assert_page(&second, fixture_observation(&fixture, "gcs-default-second"));

    let small = list_objects(&data, BUCKET, "objects/", None, None, 2);
    assert_page(&small, fixture_observation(&fixture, "gcs-small-first"));
    let resumed = list_objects(
        &data,
        BUCKET,
        "objects/",
        None,
        small.next_page_token.as_deref(),
        2,
    );
    assert_page(&resumed, fixture_observation(&fixture, "gcs-small-second"));
    let unknown = list_objects(
        &data,
        BUCKET,
        "objects/",
        None,
        Some("objects/not-present.json"),
        2,
    );
    assert_page(&unknown, fixture_observation(&fixture, "gcs-unknown-token"));
}

#[test]
fn delimiter_prefixes_are_global_while_only_items_are_paginated() {
    let mut data = StorageData::default();
    for name in [
        "prefix/a.txt",
        "prefix/b.txt",
        "prefix/nested/a.txt",
        "prefix/nested/deeper/a.txt",
    ] {
        insert(&mut data, name);
    }

    let page = list_objects(&data, BUCKET, "prefix/", Some("/"), None, 1);
    assert_eq!(names(&page), ["prefix/a.txt"]);
    assert_eq!(page.next_page_token.as_deref(), Some("prefix/b.txt"));
    assert_eq!(page.prefixes, ["prefix/nested/"]);
}

#[tokio::test]
async fn gcs_and_firebase_routes_emit_sdk_compatible_continuation_pages() {
    let root = test_root();
    let registry = TriggerRegistry::default();
    let (observer, _receiver) = TriggerObserver::channel(registry.clone());
    let runtime = StorageRuntime::start(
        StorageConfig {
            project: PROJECT.to_owned(),
            durability: StorageDurability::default(),
            origin: "http://127.0.0.1:21002".to_owned(),
            data_dir: root.clone(),
            rules: None,
        },
        observer.queue(),
        registry,
    )
    .await
    .expect("runtime");
    *lock(&runtime.state.inner) = corpus();
    let fixture: JsonValue = serde_json::from_str(ORACLE).expect("oracle fixture");

    for (base, route) in [
        (format!("/storage/v1/b/{BUCKET}/o"), "gcs"),
        (format!("/v0/b/{BUCKET}/o"), "firebase"),
    ] {
        let first = request_json(
            &runtime,
            &format!("{base}?prefix=objects%2F&maxResults=1000"),
        )
        .await;
        assert_eq!(first["items"].as_array().map(Vec::len), Some(1_000));
        assert_eq!(first["nextPageToken"], "objects/1000.json");

        let second = request_json(
            &runtime,
            &format!("{base}?prefix=objects%2F&maxResults=1000&pageToken=objects%2F1000.json"),
        )
        .await;
        assert_eq!(
            second["items"]
                .as_array()
                .expect("items")
                .iter()
                .map(|item| item["name"].as_str().expect("name"))
                .collect::<Vec<_>>(),
            ["objects/1000.json", "objects/1001.json"],
        );
        assert!(second.get("nextPageToken").is_none());
        ledger_route_page(
            &first,
            fixture_observation(&fixture, &format!("{route}-default-first")),
        );
        ledger_route_page(
            &second,
            fixture_observation(&fixture, &format!("{route}-default-second")),
        );
    }

    replay_delimiter_and_autopagination(&runtime, &fixture).await;

    runtime.shutdown().await.expect("shutdown");
    let _ = std::fs::remove_dir_all(root);
}

/// `gcs-delimiter` and `sdk-autopagination`, over the same corpus.
async fn replay_delimiter_and_autopagination(runtime: &StorageRuntime, fixture: &JsonValue) {
    // `gcs-delimiter`: the small page with `delimiter=/`. Under `objects/`
    // nothing nests, so the official answer was byte-identical to the same
    // page without a delimiter (one `responseSha256`); Firenook's must be too.
    let delimiter = fixture_observation(fixture, "gcs-delimiter");
    assert_eq!(
        delimiter["responseSha256"],
        fixture_observation(fixture, "gcs-small-first")["responseSha256"]
    );
    let base = format!("/storage/v1/b/{BUCKET}/o?prefix=objects%2F");
    let with = request_json(runtime, &format!("{base}&delimiter=%2F&maxResults=2")).await;
    let without = request_json(runtime, &format!("{base}&maxResults=2")).await;
    assert_eq!(
        with, without,
        "a delimiter with nothing nested changes nothing"
    );
    assert_eq!(
        with.get("prefixes")
            .cloned()
            .unwrap_or_else(|| JsonValue::Array(Vec::new())),
        delimiter["prefixes"]
    );
    ledger_route_page(&with, delimiter);

    // `sdk-autopagination`: what @google-cloud/storage 7.22.0's
    // `bucket.getFiles({ prefix: "objects/" })` sends. `Bucket#getFiles` asks
    // `GET /o` with the query, then the same query with `pageToken` set to
    // each `nextPageToken` until there is none (build/cjs/src/bucket.js); the
    // client loop is reproduced here, the pages are Firenook's own answers.
    let recorded = &fixture["sdkAutopagination"];
    assert_eq!(recorded["packageVersion"], "7.22.0");
    let mut names = Vec::new();
    let mut token: Option<String> = None;
    let mut calls = 0;
    loop {
        let page = request_json(
            runtime,
            &match &token {
                None => base.clone(),
                Some(token) => format!("{base}&pageToken={}", token.replace('/', "%2F")),
            },
        )
        .await;
        calls += 1;
        names.extend(
            page["items"]
                .as_array()
                .expect("items")
                .iter()
                .map(|item| item["name"].as_str().expect("name").to_owned()),
        );
        match page.get("nextPageToken").and_then(JsonValue::as_str) {
            Some(next) => token = Some(next.to_owned()),
            None => break,
        }
        assert!(calls < 10, "pagination must end");
    }
    let expected: Vec<String> = (0..1_002)
        .map(|index| format!("objects/{index:04}.json"))
        .collect();
    assert_eq!(names, expected, "every object once, in order");
    if u64::try_from(names.len()).ok() == recorded["count"].as_u64()
        && names.first().map(String::as_str) == recorded["first"].as_str()
        && names.get(999).map(String::as_str) == recorded["boundaryBefore"].as_str()
        && names.get(1_000).map(String::as_str) == recorded["boundaryAfter"].as_str()
        && names.last().map(String::as_str) == recorded["last"].as_str()
    {
        firenook_conformance_ledger::checked(
            "firebase-suite-v1/storage",
            "storage-list-pagination/sdk-autopagination",
            firenook_conformance_ledger::Compared::Behaviour,
        );
    }
}

async fn request_json(runtime: &StorageRuntime, uri: &str) -> JsonValue {
    let response = runtime
        .application()
        .oneshot(
            Request::builder()
                .uri(uri)
                .header("authorization", "Bearer owner")
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("response body");
    serde_json::from_slice(&body).expect("response JSON")
}

fn corpus() -> StorageData {
    let mut data = StorageData::default();
    for index in 0..1_002 {
        insert(&mut data, &format!("objects/{index:04}.json"));
    }
    data
}

fn insert(data: &mut StorageData, name: &str) {
    let object = StoredObject {
        name: name.to_owned(),
        bucket: BUCKET.to_owned(),
        generation: 1,
        metageneration: 1,
        content_type: Some("application/json".to_owned()),
        storage_class: "STANDARD".to_owned(),
        content_disposition: None,
        content_encoding: None,
        content_language: None,
        cache_control: None,
        download_tokens: Vec::new(),
        custom_metadata: BTreeMap::new(),
        time_created: "2026-09-04T00:00:00Z".to_owned(),
        updated: "2026-09-04T00:00:00Z".to_owned(),
        size: 0,
        md5_hash: String::new(),
        crc32c: 0,
        etag: "synthetic".to_owned(),
        data_file: "unused".to_owned(),
    };
    data.objects.insert(object_key(BUCKET, name), object);
}

fn fixture_observation<'a>(fixture: &'a JsonValue, id: &str) -> &'a JsonValue {
    fixture["observations"]
        .as_array()
        .expect("observations")
        .iter()
        .find(|observation| observation["id"] == id)
        .unwrap_or_else(|| panic!("missing fixture observation {id}"))
}

fn assert_page(page: &ObjectListPage<'_>, observation: &JsonValue) {
    assert_eq!(page.items.len(), observation["itemCount"]);
    assert_eq!(names(page), fixture_names(observation));
    assert_eq!(
        page.next_page_token.as_deref(),
        observation.get("nextPageToken").and_then(JsonValue::as_str),
    );
    ledger_page(observation);
}

/// Notes a recorded page in the conformance ledger.
fn ledger_page(observation: &JsonValue) {
    firenook_conformance_ledger::checked(
        "firebase-suite-v1/storage",
        &format!(
            "storage-list-pagination/{}",
            observation["id"].as_str().expect("id")
        ),
        firenook_conformance_ledger::Compared::Answer,
    );
}

/// Notes `page` as checked when its names and token are the recorded ones.
fn ledger_route_page(page: &JsonValue, observation: &JsonValue) {
    let names: Vec<&str> = page["items"]
        .as_array()
        .expect("items")
        .iter()
        .map(|item| item["name"].as_str().expect("name"))
        .collect();
    if names == fixture_names(observation)
        && page.get("nextPageToken") == observation.get("nextPageToken")
    {
        ledger_page(observation);
    }
}

fn names<'a>(page: &'a ObjectListPage<'a>) -> Vec<&'a str> {
    page.items
        .iter()
        .map(|object| object.name.as_str())
        .collect()
}

fn fixture_names(observation: &JsonValue) -> Vec<&str> {
    observation["itemNames"]
        .as_array()
        .expect("itemNames")
        .iter()
        .map(|name| name.as_str().expect("item name"))
        .collect()
}

fn test_root() -> PathBuf {
    std::env::temp_dir().join(format!(
        "firenook-storage-pagination-{}-{}",
        std::process::id(),
        OffsetDateTime::now_utc().unix_timestamp_nanos(),
    ))
}
