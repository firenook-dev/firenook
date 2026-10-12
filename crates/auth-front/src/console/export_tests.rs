//! Exports (test 15) and the export smoke ceiling.

use std::time::{Duration, Instant};

use serde_json::{Value as JsonValue, json};

use super::*;
use crate::AuthRuntime;
use crate::tests::test_runtime;

const PROJECT: &str = "demo-auth";

fn populate(runtime: &AuthRuntime, count: usize) {
    runtime
        .runtime()
        .update(|data| {
            let state = &mut data.agent(PROJECT).project;
            for index in 0..count {
                let user = json!({
                    "email": format!("e{index}@example.test"),
                    "displayName": format!("Export {index}"),
                    "createdAt": (1_700_000_000_000_i64 + i64::try_from(index).expect("index")).to_string(),
                });
                state
                    .create_user_with_local_id(&format!("e{index:05}"), user.as_object().expect("object"))
                    .expect("create")
                    .expect("new");
            }
        })
        .expect("populated");
}

fn whole(stream: &mut ExportStream, chunk: usize) -> (Vec<u8>, usize) {
    let mut file = Vec::new();
    let mut chunks = 0;
    while let Some(part) = stream.next_chunk(chunk) {
        file.extend_from_slice(&part);
        chunks += 1;
    }
    (file, chunks)
}

#[test]
fn an_export_is_a_point_in_time_and_chunks_equal_the_whole() {
    let runtime = test_runtime();
    populate(&runtime, 5_000);
    let handle = runtime.runtime();
    let everyone = ExportSelection::Filter(Box::default());
    let mut stream = handle
        .export(PROJECT, None, &everyone, ExportFormat::Json)
        .expect("export");
    assert_eq!(stream.len(), 5_000);
    let first = stream.next_chunk(EXPORT_CHUNK).expect("first chunk");
    // A user created while the file streams is not in it.
    handle
        .update(|data| {
            data.agent(PROJECT)
                .project
                .create_user_with_local_id("late", &UserRecord::new())
                .expect("create");
        })
        .expect("created");
    let mut file = first;
    let (rest, chunks) = whole(&mut stream, EXPORT_CHUNK);
    file.extend_from_slice(&rest);
    assert_eq!(chunks, 2, "two more chunks of at most 2,000 users");
    let parsed: JsonValue = serde_json::from_slice(&file).expect("JSON");
    assert_eq!(parsed["kind"], "identitytoolkit#DownloadAccountResponse");
    let users = parsed["users"].as_array().expect("users");
    assert_eq!(users.len(), 5_000);
    assert!(users.iter().all(|user| user["localId"] != "late"));
    // In chunks or at once, the same file (the snapshot holds still).
    let mut again = handle
        .export(PROJECT, None, &everyone, ExportFormat::Json)
        .expect("export");
    let (at_once, chunks) = whole(&mut again, 10_000);
    assert_eq!(chunks, 1);
    let at_once: JsonValue = serde_json::from_slice(&at_once).expect("JSON");
    assert_eq!(at_once["users"].as_array().expect("users").len(), 5_001);
    // A selection keeps its order and drops unknown uids.
    let mut selection = handle
        .export(
            PROJECT,
            None,
            &ExportSelection::Uids(vec![
                "e00002".to_owned(),
                "ghost".to_owned(),
                "e00001".to_owned(),
            ]),
            ExportFormat::Json,
        )
        .expect("export");
    let (file, _) = whole(&mut selection, EXPORT_CHUNK);
    let parsed: JsonValue = serde_json::from_slice(&file).expect("JSON");
    let uids: Vec<&str> = parsed["users"]
        .as_array()
        .expect("users")
        .iter()
        .map(|user| user["localId"].as_str().expect("uid"))
        .collect();
    assert_eq!(uids, ["e00002", "e00001"]);
    // An empty scope is an empty, valid file.
    let mut empty = handle
        .export("demo-empty", None, &everyone, ExportFormat::Json)
        .expect("export");
    assert!(empty.is_empty());
    let (file, _) = whole(&mut empty, EXPORT_CHUNK);
    assert_eq!(
        serde_json::from_slice::<JsonValue>(&file).expect("JSON"),
        json!({ "kind": "identitytoolkit#DownloadAccountResponse", "users": [] })
    );
}

#[test]
fn csv_rows_quote_what_needs_quoting() {
    let runtime = test_runtime();
    runtime
        .runtime()
        .update(|data| {
            let state = &mut data.agent(PROJECT).project;
            let user = json!({
                "email": "quote@example.test",
                "displayName": "Lovelace, \"Ada\"",
                "phoneNumber": "+15550100",
                "createdAt": "1700000000000",
                "lastLoginAt": "1700000100000",
                "customAttributes": "{\"role\":\"admin\",\"tier\":2}",
                "emailVerified": true,
            });
            state
                .create_user_with_local_id("q1", user.as_object().expect("object"))
                .expect("create")
                .expect("new");
        })
        .expect("created");
    let mut stream = runtime
        .runtime()
        .export(
            PROJECT,
            None,
            &ExportSelection::Filter(Box::default()),
            ExportFormat::Csv,
        )
        .expect("export");
    let (file, _) = whole(&mut stream, EXPORT_CHUNK);
    let text = String::from_utf8(file).expect("UTF-8");
    let lines: Vec<&str> = text.split("\r\n").collect();
    assert_eq!(lines[0], CSV_HEADER);
    assert_eq!(
        lines[1],
        "q1,quote@example.test,true,+15550100,\"Lovelace, \"\"Ada\"\"\",,phone,false,2023-11-14T22:13:20.000Z,2023-11-14T22:15:00.000Z,\"{\"\"role\"\":\"\"admin\"\",\"\"tier\"\":2}\""
    );
    assert_eq!(lines[2], "");
}

/// The CI ceiling of an export at 10,000 users (debug build): the lock is
/// held at most 200 µs for the snapshot.
#[test]
fn an_export_holds_the_lock_only_for_its_snapshot() {
    let runtime = test_runtime();
    populate(&runtime, 10_000);
    let handle = runtime.runtime();
    let hold = (0..10)
        .map(|_| {
            let started = Instant::now();
            let stream = handle
                .export(
                    PROJECT,
                    None,
                    &ExportSelection::Uids(Vec::new()),
                    ExportFormat::Json,
                )
                .expect("export");
            let took = started.elapsed();
            drop(stream);
            took
        })
        .min()
        .unwrap_or_default();
    assert!(
        hold <= Duration::from_micros(200),
        "the snapshot took {hold:?}"
    );
}
