//! Replays `conformance/fixtures/official-export-v1.22.0`: the official
//! emulator's export of the four synthetic documents
//! `conformance/src/seed-export.ts` wrote. firebase-tools' `emulators:export`
//! asks the Firestore emulator for it with `POST
//! /emulator/v1/projects/{project}:export`; the replay sends that request to
//! the REST routes over a store holding the same four documents (read from
//! the official export itself) and compares what is written with the
//! recorded export: the same files, the overall metadata byte for byte, the
//! kind metadata but for the export's own start and end times, and the same
//! records, each decoding to the same document. Two things are not compared,
//! neither of which an importer reads: the order of the records (the
//! official export holds them in the order the capture's four concurrent
//! writes landed; Firenook writes them in name order), and their bytes (the
//! official writer puts a field set by a transform, `incremented` from
//! `FieldValue.increment(3)`, after the others; Firenook writes every field
//! in name order, and an importer reads the properties as a set).

use super::*;
use firenook_export_format::{ExportReader, LevelDbLogReader, LogOptions, decode_kind_metadata};
use tower::ServiceExt as _;

const OFFICIAL: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../conformance/fixtures/official-export-v1.22.0/firestore_export"
);
const PROJECT: &str = "demo-fireside-export-oracle";
const OVERALL: &str = "firestore_export.overall_export_metadata";
const KINDS: &str = "all_namespaces/all_kinds";

fn files(root: &std::path::Path) -> Vec<String> {
    let mut found = Vec::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        for entry in std::fs::read_dir(&directory).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                pending.push(path);
            } else {
                found.push(
                    path.strip_prefix(root)
                        .unwrap()
                        .to_string_lossy()
                        .replace('\\', "/"),
                );
            }
        }
    }
    found.sort();
    found
}

fn records(path: &std::path::Path) -> Vec<Vec<u8>> {
    let bytes = std::fs::read(path).unwrap();
    let mut reader = LevelDbLogReader::new(bytes.as_slice(), LogOptions::default());
    let mut records = Vec::new();
    while let Some(record) = reader.next_record().unwrap() {
        records.push(record);
    }
    records
}

#[tokio::test]
async fn the_export_route_writes_the_official_export_of_the_same_documents() {
    let official = std::path::Path::new(OFFICIAL);
    let documents = ExportReader::open(official.join(OVERALL))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(documents.len(), 4);
    let store = Store::default();
    let writes = documents
        .iter()
        .map(|document| Write::Set {
            key: document.key().clone(),
            fields: document.fields().clone(),
            transforms: Vec::new(),
            precondition: Precondition::None,
        })
        .collect::<Vec<_>>();
    store.commit(&writes).unwrap();

    let directory = std::env::temp_dir().join(format!(
        "firenook-official-export-replay-{}-{}",
        std::process::id(),
        OffsetDateTime::now_utc().unix_timestamp_nanos()
    ));
    std::fs::create_dir_all(&directory).unwrap();
    // The body firebase-tools sends the Firestore emulator for an export.
    let body = json!({
        "database": format!("projects/{PROJECT}/databases/(default)"),
        "export_directory": directory,
        "export_name": "firestore_export",
    });
    let response = router(store)
        .oneshot(
            Request::post(format!("/emulator/v1/projects/{PROJECT}:export"))
                .header(CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let written = directory.join("firestore_export");

    assert_eq!(files(&written), files(official));
    assert_eq!(
        std::fs::read(written.join(OVERALL)).unwrap(),
        std::fs::read(official.join(OVERALL)).unwrap()
    );
    let kind_metadata = |root: &std::path::Path| {
        decode_kind_metadata(
            &std::fs::read(
                root.join(KINDS)
                    .join("all_namespaces_all_kinds.export_metadata"),
            )
            .unwrap(),
        )
        .unwrap()
    };
    let (ours, theirs) = (kind_metadata(&written), kind_metadata(official));
    assert_eq!(ours.export_prefix(), theirs.export_prefix());
    assert_eq!(ours.shards(), theirs.shards());
    // Each record's length and document, by document name; compared through
    // `Debug`, where a NaN reads the same on both sides.
    let by_name = |records: Vec<Vec<u8>>| {
        records
            .iter()
            .map(|record| {
                let document = firenook_export_format::decode_entity(record).unwrap();
                (
                    document.key().path().to_owned(),
                    (record.len(), format!("{document:?}")),
                )
            })
            .collect::<BTreeMap<_, _>>()
    };
    let ours = by_name(records(&written.join(KINDS).join("output-0")));
    let theirs = by_name(records(&official.join(KINDS).join("output-0")));
    assert_eq!(ours.len(), 4);
    assert_eq!(ours, theirs);
    std::fs::remove_dir_all(&directory).unwrap();
    firenook_conformance_ledger::checked(
        "official-export-v1.22.0",
        "export",
        firenook_conformance_ledger::Compared::Behaviour,
    );
}
