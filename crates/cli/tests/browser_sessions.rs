//! Clients still connected when the suite stops: the store must close.

mod support;

use std::io::{Read as _, Write as _};
use std::net::TcpStream;
use std::time::Duration;

use support::{
    FIRESTORE_AND_AUTH, Launch, Scratch, http, opens_without_repair, start, write_document,
};

/// A `WebChannel` request with the form body the browser SDK sends.
fn webchannel_post(address: &str, path: &str, query: &str, body: &str) -> String {
    http(
        address,
        &format!(
            "POST {path}?{query} HTTP/1.1\r\nHost: {address}\r\nOrigin: http://127.0.0.1:5000\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        ),
    )
}

fn percent(text: &str) -> String {
    text.bytes()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() || b"-_.~".contains(&byte) {
                (byte as char).to_string()
            } else {
                format!("%{byte:02X}")
            }
        })
        .collect()
}

/// Opens a `WebChannel` session as the browser SDK does, sending `first` in
/// the handshake; returns the session id and its `gsessionid`.
fn open_session(address: &str, path: &str, project: &str, first: &str) -> (String, String) {
    let database = format!("projects/{project}/databases/(default)");
    let query = format!(
        "VER=8&database={}&RID=1&CVER=22&X-HTTP-Session-Id=gsessionid&zx=a&t=1",
        percent(&database)
    );
    let body = format!(
        "headers={}&count=1&ofs=0&req0___data__={}",
        percent("Authorization:Bearer owner\r\n"),
        percent(first)
    );
    let response = webchannel_post(address, path, &query, &body);
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    let at = response
        .find("[\"c\",\"")
        .expect("session id in the handshake")
        + 6;
    let sid = response[at..]
        .split('"')
        .next()
        .expect("session id")
        .to_owned();
    let gsession_id = response
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("x-http-session-id")
                .then(|| value.trim().to_owned())
        })
        .expect("X-HTTP-Session-Id in the handshake");
    (sid, gsession_id)
}

/// Listen and Write sessions the browser SDK opened, still there when the
/// suite stops, as they are after a web page ran (a page that is closed or
/// navigated away never says goodbye): the stop ends them, the store
/// closes, and the next start needs no repair.
#[test]
fn a_stop_closes_firestore_with_browser_sessions_still_open() {
    let scratch = Scratch::new("webchannel");
    let id = format!("demo-webchannel-{}", std::process::id());
    let dir = scratch.project("app", FIRESTORE_AND_AUTH);
    let tmp = scratch.tmp();
    let engine = start(&Launch::new(&dir, &id, &tmp));
    let address = format!("127.0.0.1:{}", engine.port("firestore"));
    write_document(&id, engine.port("firestore"), "o_1");
    let database = format!("projects/{id}/databases/(default)");
    let listen = format!(
        r#"{{"database":"{database}","addTarget":{{"documents":{{"documents":["{database}/documents/orders/o_1"]}},"targetId":2}}}}"#
    );
    let (listen_sid, gsession_id) = open_session(
        &address,
        "/google.firestore.v1.Firestore/Listen/channel",
        &id,
        &listen,
    );
    let (write_sid, _) = open_session(
        &address,
        "/google.firestore.v1.Firestore/Write/channel",
        &id,
        &format!(r#"{{"database":"{database}"}}"#),
    );
    assert_ne!(listen_sid, write_sid);
    // A backchannel the SDK keeps open for the Listen stream's answers.
    let mut backchannel = TcpStream::connect(&address).expect("backchannel");
    write!(
        backchannel,
        "GET /google.firestore.v1.Firestore/Listen/channel?VER=8&database={}&gsessionid={gsession_id}&RID=rpc&SID={listen_sid}&AID=0&CI=0&TYPE=xmlhttp&zx=b&t=1 HTTP/1.1\r\nHost: {address}\r\nOrigin: http://127.0.0.1:5000\r\n\r\n",
        percent(&database)
    )
    .expect("backchannel request");
    let mut first = [0_u8; 64];
    backchannel
        .set_read_timeout(Some(Duration::from_secs(20)))
        .expect("timeout");
    let read = backchannel.read(&mut first).expect("backchannel answer");
    assert!(
        String::from_utf8_lossy(&first[..read]).starts_with("HTTP/1.1 200"),
        "{}",
        String::from_utf8_lossy(&first[..read])
    );
    let (status, printed) = engine.stop();
    assert!(status.success(), "the stop failed ({status}):\n{printed}");
    assert!(!printed.contains("still held"), "{printed}");
    assert!(
        opens_without_repair(&dir.join("state/firestore/firenook.redb")),
        "Firestore was left open:\n{printed}"
    );
    drop(backchannel);
}
