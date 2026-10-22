//! The hosts a suite listens on, as the official CLI binds them.

mod support;

use std::net::{TcpListener, TcpStream};
use std::time::Duration;

use support::{FIRESTORE_AND_AUTH, Launch, Scratch, get, json_file, start};

fn answers(address: &str) -> bool {
    TcpStream::connect_timeout(
        &address.parse().expect("socket address"),
        Duration::from_secs(2),
    )
    .is_ok()
}

/// `localhost`, the official default host, is 127.0.0.1 for every
/// emulator and also `::1` for the hub and the console, as the official
/// CLI binds it; clients are told 127.0.0.1.
#[test]
fn localhost_also_answers_the_hub_and_console_on_ipv6() {
    if TcpListener::bind("[::1]:0").is_err() {
        eprintln!("skipped: this host has no IPv6 loopback");
        return;
    }
    let scratch = Scratch::new("localhost");
    let id = format!("demo-localhost-{}", std::process::id());
    let dir = scratch.project("app", FIRESTORE_AND_AUTH);
    let tmp = scratch.tmp();
    let mut launch = Launch::new(&dir, &id, &tmp);
    launch.host = "localhost";
    let engine = start(&launch);
    for name in ["firestore", "auth", "hub", "ui"] {
        assert!(
            answers(&format!("127.0.0.1:{}", engine.port(name))),
            "{name} refused 127.0.0.1"
        );
    }
    for name in ["hub", "ui"] {
        assert!(
            answers(&format!("[::1]:{}", engine.port(name))),
            "{name} refused [::1]"
        );
    }
    // The others listen on the first address only, as officially.
    for name in ["firestore", "auth"] {
        assert!(
            !answers(&format!("[::1]:{}", engine.port(name))),
            "{name} answered [::1]"
        );
    }
    let hub = engine.port("hub");
    let listing: serde_json::Value = serde_json::from_str(
        get(&format!("[::1]:{hub}"), "/emulators")
            .split("\r\n\r\n")
            .nth(1)
            .expect("body"),
    )
    .expect("listing");
    assert_eq!(listing["firestore"]["host"], "127.0.0.1");
    assert_eq!(listing["hub"]["host"], "127.0.0.1");
    let addresses: Vec<&str> = listing["hub"]["listen"]
        .as_array()
        .expect("hub listen")
        .iter()
        .map(|listen| listen["address"].as_str().expect("address"))
        .collect();
    assert_eq!(addresses, ["127.0.0.1", "::1"]);
    let locator = json_file(&tmp.join(format!("hub-{id}.json")));
    assert_eq!(
        locator["origins"],
        serde_json::json!([
            format!("http://127.0.0.1:{hub}"),
            format!("http://[::1]:{hub}")
        ])
    );
    let (status, printed) = engine.stop();
    assert!(status.success(), "{printed}");
}

/// `::1` puts every emulator on the IPv6 loopback, and clients are told it.
#[test]
fn an_ipv6_host_answers_on_ipv6() {
    if TcpListener::bind("[::1]:0").is_err() {
        eprintln!("skipped: this host has no IPv6 loopback");
        return;
    }
    let scratch = Scratch::new("ipv6");
    let id = format!("demo-ipv6-{}", std::process::id());
    let dir = scratch.project("app", FIRESTORE_AND_AUTH);
    let tmp = scratch.tmp();
    let mut launch = Launch::new(&dir, &id, &tmp);
    launch.host = "::1";
    let engine = start(&launch);
    for name in ["firestore", "auth", "hub", "ui"] {
        assert!(
            answers(&format!("[::1]:{}", engine.port(name))),
            "{name} refused [::1]"
        );
    }
    let hub = engine.port("hub");
    let listing: serde_json::Value = serde_json::from_str(
        get(&format!("[::1]:{hub}"), "/emulators")
            .split("\r\n\r\n")
            .nth(1)
            .expect("body"),
    )
    .expect("listing");
    assert_eq!(listing["firestore"]["host"], "::1");
    let locator = json_file(&tmp.join(format!("hub-{id}.json")));
    assert_eq!(
        locator["origins"],
        serde_json::json!([format!("http://[::1]:{hub}")])
    );
    let (status, printed) = engine.stop();
    assert!(status.success(), "{printed}");
}
