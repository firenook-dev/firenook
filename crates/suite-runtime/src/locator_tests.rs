use std::time::{Duration, Instant};

use axum::Router;
use axum::routing::get;
use serde_json::json;
use tokio::net::{TcpListener, TcpSocket, TcpStream};

use crate::locator_answers;

/// Whether a locator naming `origins` and `pid` is held by a running suite,
/// read from a locator file as a starting suite reads it.
async fn held(origins: &[&str], pid: u64) -> bool {
    static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let path = std::env::temp_dir().join(format!(
        "firenook-locator-test-{}-{}.json",
        std::process::id(),
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    std::fs::write(&path, json!({ "pid": pid, "origins": origins }).to_string())
        .expect("write the locator");
    let answered = locator_answers(&path).await;
    let _ = std::fs::remove_file(&path);
    answered
}

/// A loopback origin that never accepts a connection: its accept queue is
/// full, so the kernel drops the next handshake and a connect waits until it
/// times out. Windows treats a closed loopback port the same way, which is
/// the start a killed suite's locator delayed there (#181).
async fn origin_that_never_accepts() -> (String, TcpListener, Vec<TcpStream>) {
    let socket = TcpSocket::new_v4().expect("socket");
    socket.bind("127.0.0.1:0".parse().unwrap()).expect("bind");
    let listener = socket.listen(1).expect("listen");
    let address = listener.local_addr().expect("address");
    let mut queued = Vec::new();
    for _ in 0..64 {
        match tokio::time::timeout(Duration::from_millis(100), TcpStream::connect(address)).await {
            Ok(Ok(stream)) => queued.push(stream),
            // A refused connect (Windows answers a full queue so) fails at
            // once, which is the fast case this origin stands in for anyway.
            Ok(Err(_)) | Err(_) => break,
        }
    }
    if cfg!(target_os = "linux") {
        // Linux drops the handshake, so the connect must still be waiting:
        // otherwise this origin would not stand in for one that never accepts.
        let waiting =
            tokio::time::timeout(Duration::from_millis(300), TcpStream::connect(address)).await;
        assert!(
            waiting.is_err(),
            "the full queue accepted a connection: {waiting:?}"
        );
    }
    (format!("http://{address}"), listener, queued)
}

/// A loopback origin nothing listens on, as a killed suite leaves its
/// locator's. Linux and macOS refuse a connection to it at once; Windows
/// retries the handshake until the connect times out.
fn closed_origin() -> String {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
    let address = listener.local_addr().expect("address");
    drop(listener);
    format!("http://{address}")
}

async fn origin_answering_pid(pid: u64) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let address = listener.local_addr().expect("address");
    let app = Router::new().route(
        "/",
        get(move || async move { axum::Json(json!({ "pid": pid })) }),
    );
    tokio::spawn(async move { axum::serve(listener, app).await });
    format!("http://{address}")
}

#[tokio::test]
async fn a_stale_locator_whose_origins_never_accept_is_settled_at_once() {
    let (first, _first_listener, _first_queue) = origin_that_never_accepts().await;
    let (second, _second_listener, _second_queue) = origin_that_never_accepts().await;
    let started = Instant::now();
    assert!(!held(&[first.as_str(), second.as_str()], 4242).await);
    let elapsed = started.elapsed();
    // One after another, each origin used to cost the two-second request
    // timeout; asked at once, with the short connect timeout, both cost one.
    assert!(
        elapsed < Duration::from_secs(1),
        "two origins that never accept took {elapsed:?}"
    );
}

#[tokio::test]
async fn a_killed_suites_locator_is_settled_at_once() {
    let (first, second) = (closed_origin(), closed_origin());
    let started = Instant::now();
    assert!(!held(&[first.as_str(), second.as_str()], 4242).await);
    let elapsed = started.elapsed();
    assert!(
        elapsed < Duration::from_secs(1),
        "two closed origins took {elapsed:?}"
    );
}

#[tokio::test]
async fn a_running_suite_is_found_beside_an_origin_that_never_accepts() {
    let (silent, _listener, _queue) = origin_that_never_accepts().await;
    let running = origin_answering_pid(4242).await;
    let started = Instant::now();
    assert!(held(&[silent.as_str(), running.as_str()], 4242).await);
    assert!(started.elapsed() < Duration::from_secs(1));
}

#[tokio::test]
async fn a_locator_whose_suite_answers_with_another_pid_is_free() {
    let other = origin_answering_pid(7).await;
    assert!(!held(&[other.as_str()], 4242).await);
}
