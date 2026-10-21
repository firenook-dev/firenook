//! Two suites for one project: the Hub locator the official CLI reads, and
//! the record each Firenook suite keeps of itself, its folder and its hub.

mod support;

use std::net::TcpListener;
use std::path::PathBuf;

use support::{FIRESTORE_AND_AUTH, Launch, Scratch, json_file, start};

/// The official CLI keeps `hub-<project>.json` for the suite that wrote it
/// while that suite runs: a second one warns and leaves it. Each Firenook
/// suite also records itself, with its project folder, so a command run in
/// a folder finds that folder's suite; and each stops cleanly.
#[test]
fn a_second_suite_for_one_project_leaves_the_first_ones_locator() {
    let scratch = Scratch::new("collide");
    let id = format!("demo-collide-{}", std::process::id());
    let first_dir = scratch.project("first", FIRESTORE_AND_AUTH);
    let second_dir = scratch.project("second", FIRESTORE_AND_AUTH);
    let tmp = scratch.tmp();
    let locator = tmp.join(format!("hub-{id}.json"));

    let first = start(&Launch::new(&first_dir, &id, &tmp));
    let first_pid = first.child.id();
    assert_eq!(json_file(&locator)["pid"], first_pid);
    let second = start(&Launch::new(&second_dir, &id, &tmp));
    let second_pid = second.child.id();
    assert_eq!(
        json_file(&locator)["pid"],
        first_pid,
        "the second suite took the first one's locator"
    );
    assert!(
        second
            .printed()
            .contains("running multiple instances of the emulator suite"),
        "{}",
        second.printed()
    );

    // Each suite's own record names its folder and its hub.
    let records = tmp.join("firenook-hubs");
    for (pid, folder, engine) in [
        (first_pid, &first_dir, &first),
        (second_pid, &second_dir, &second),
    ] {
        let record = json_file(&records.join(format!("hub-{id}-{pid}.json")));
        assert_eq!(record["projectId"], id.as_str());
        assert_eq!(record["pid"], pid);
        assert_eq!(
            PathBuf::from(record["projectDir"].as_str().expect("projectDir")),
            **folder
        );
        assert_eq!(
            record["origins"][0],
            format!("http://127.0.0.1:{}", engine.port("hub"))
        );
    }

    let (status, printed) = first.stop();
    assert!(
        status.success(),
        "the first suite's stop failed:\n{printed}"
    );
    assert!(!locator.exists(), "the first suite left its locator");
    assert!(!records.join(format!("hub-{id}-{first_pid}.json")).exists());
    let (status, printed) = second.stop();
    assert!(
        status.success(),
        "the second suite's stop failed:\n{printed}"
    );
    assert!(
        !locator.exists(),
        "the second suite wrote a locator at its stop"
    );
    assert!(!records.join(format!("hub-{id}-{second_pid}.json")).exists());
}

/// A locator whose suite is gone (killed, so it never removed the file) is
/// replaced, as the official CLI replaces one whose process is dead.
#[test]
fn a_stale_locator_is_replaced() {
    let scratch = Scratch::new("stale");
    let id = format!("demo-stale-{}", std::process::id());
    let dir = scratch.project("app", FIRESTORE_AND_AUTH);
    let tmp = scratch.tmp();
    let locator = tmp.join(format!("hub-{id}.json"));
    let dead = TcpListener::bind("127.0.0.1:0")
        .expect("port")
        .local_addr()
        .expect("address")
        .port();
    std::fs::write(
        &locator,
        format!(r#"{{"version":"15.22.0","origins":["http://127.0.0.1:{dead}"],"pid":1}}"#),
    )
    .expect("stale locator");
    let engine = start(&Launch::new(&dir, &id, &tmp));
    assert_eq!(json_file(&locator)["pid"], engine.child.id());
    let (status, printed) = engine.stop();
    assert!(status.success(), "{printed}");
    assert!(!locator.exists());
}
