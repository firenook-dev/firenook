//! What a start is given that the official CLI only warns about.

mod support;

use support::{FIRESTORE_AND_AUTH, Launch, Scratch, start, write_document};

/// An `--import` folder that holds no export metadata, or a file, is no
/// import: like the official CLI, the start warns and goes on without one.
#[test]
fn an_import_without_export_metadata_is_skipped_with_a_warning() {
    let scratch = Scratch::new("import");
    let id = format!("demo-import-{}", std::process::id());
    let dir = scratch.project("app", FIRESTORE_AND_AUTH);
    let tmp = scratch.tmp();
    let empty = scratch.root.join("empty-seed");
    std::fs::create_dir_all(&empty).expect("empty seed");
    let file = scratch.root.join("seed.txt");
    std::fs::write(&file, "not an export").expect("seed file");
    for seed in [&empty, &file] {
        let mut launch = Launch::new(&dir, &id, &tmp);
        launch.extra = vec!["--import".to_owned(), seed.display().to_string()];
        let engine = start(&launch);
        assert!(
            engine
                .printed()
                .contains("Could not find import/export metadata file, skipping data import!"),
            "{}",
            engine.printed()
        );
        let (status, printed) = engine.stop();
        assert!(status.success(), "{printed}");
        std::fs::remove_dir_all(dir.join("state")).expect("state removed");
    }
}

/// An index file the console cannot read is no reason to refuse a start:
/// the official emulator never reads it. The start warns and goes on.
#[test]
fn an_invalid_indexes_file_is_a_warning() {
    let scratch = Scratch::new("indexes");
    let id = format!("demo-indexes-{}", std::process::id());
    let dir = scratch.project(
        "app",
        r#"{"firestore":{"rules":"firestore.rules","indexes":"firestore.indexes.json"},"emulators":{"firestore":{},"auth":{}}}"#,
    );
    std::fs::write(dir.join("firestore.indexes.json"), "{ not json").expect("indexes");
    let tmp = scratch.tmp();
    let engine = start(&Launch::new(&dir, &id, &tmp));
    assert!(
        engine.printed().contains("firestore.indexes.json"),
        "{}",
        engine.printed()
    );
    write_document(&id, engine.port("firestore"), "o_1");
    let (status, printed) = engine.stop();
    assert!(status.success(), "{printed}");
}
