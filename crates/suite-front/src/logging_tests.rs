use super::*;
use futures_util::StreamExt as _;
use std::sync::Arc;
use std::time::Duration;

#[tokio::test]
async fn logging_real_tcp_nonreader_is_disconnected_without_blocking_producers() {
    let runtime = LoggingRuntime::new();
    for _ in 0..LOG_REPLAY_CAPACITY {
        runtime.record("INFO", None, "x".repeat(7800));
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let application = runtime.application();
    let server = tokio::spawn(async move {
        axum::serve(listener, application).await.unwrap();
    });
    let tcp = tokio::net::TcpSocket::new_v4().unwrap();
    tcp.set_recv_buffer_size(1024).unwrap();
    let tcp = tcp.connect(address).await.unwrap();
    let (client, _) = tokio_tungstenite::client_async(format!("ws://{address}/"), tcp)
        .await
        .unwrap();
    // Keep the TCP peer alive but never read its multi-megabyte replay.
    assert_eq!(
        runtime.state.slots.available_permits(),
        logging::MAXIMUM_SUBSCRIBERS - 1
    );
    let began = std::time::Instant::now();
    runtime.record("INFO", None, "recording continues behind blocked UI");
    assert!(began.elapsed() < Duration::from_secs(1));
    // Loopback kernels can buffer the entire initial replay despite a small
    // requested receive window. Keep producing bounded batches until the peer
    // has genuinely stopped draining, rather than assuming handshake == stall.
    for _ in 0..16 {
        for _ in 0..512 {
            runtime.record("INFO", None, "x".repeat(7800));
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let reclaimed = tokio::time::timeout(Duration::from_secs(35), async {
        while runtime.state.slots.available_permits() != logging::MAXIMUM_SUBSCRIBERS {
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await;
    drop(client);
    server.abort();
    assert!(
        reclaimed.is_ok(),
        "kernel-backed nonreader retained a log subscription beyond send deadline"
    );
    assert_eq!(runtime.state.history.followers(), 0);
}

#[test]
fn log_limits_cover_serialized_escaping_and_all_retained_records() {
    let contract: JsonValue =
        serde_json::from_str(include_str!("../../../benchmarks/phase-b-logging.json")).unwrap();
    assert_eq!(contract["maximumHistoryRecords"], LOG_REPLAY_CAPACITY);
    assert_eq!(
        contract["maximumSerializedRecordBytes"],
        logging::MAXIMUM_RECORD_BYTES
    );
    assert_eq!(
        contract["maximumHistoryBytes"],
        LOG_REPLAY_CAPACITY * logging::MAXIMUM_RECORD_BYTES
    );
    assert_eq!(contract["maximumSubscribers"], logging::MAXIMUM_SUBSCRIBERS);
    let runtime = LoggingRuntime::new();
    for index in 0..LOG_REPLAY_CAPACITY + 10 {
        runtime.record(
            "INFO",
            Some("functions"),
            format!("{index}{}", "\u{0000}".repeat(2000)),
        );
    }
    runtime.record(&"L".repeat(65), None, "synthetic hidden label");
    let history = runtime.state.history.snapshot();
    assert_eq!(history.len(), LOG_REPLAY_CAPACITY);
    for encoded in history.iter().map(|entry| &entry.json) {
        assert!(encoded.len() <= logging::MAXIMUM_RECORD_BYTES);
        let record: LogRecord = serde_json::from_str(encoded).unwrap();
        assert_eq!(record.level, "WARN");
        assert!(record.message.contains("omitted"));
        assert!(!encoded.contains("hidden label"));
    }
}

#[tokio::test]
async fn logging_caps_clients_replays_after_reconnect_and_obeys_owner_shutdown() {
    let runtime = LoggingRuntime::new();
    let (shutdown, receiver) = tokio::sync::watch::channel(false);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let application = runtime.application_with_shutdown(receiver);
    let server = tokio::spawn(async move {
        axum::serve(listener, application).await.unwrap();
    });
    runtime.record("INFO", None, "retained startup failure: synthetic");
    let mut clients = Vec::new();
    for _ in 0..logging::MAXIMUM_SUBSCRIBERS {
        let (mut socket, _) = tokio_tungstenite::connect_async(format!("ws://{address}/"))
            .await
            .unwrap();
        let frame = tokio::time::timeout(Duration::from_secs(2), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(
            frame
                .to_text()
                .unwrap()
                .contains("retained startup failure")
        );
        clients.push(socket);
    }
    let error = tokio_tungstenite::connect_async(format!("ws://{address}/"))
        .await
        .unwrap_err();
    match error {
        tokio_tungstenite::tungstenite::Error::Http(response) => {
            assert_eq!(response.status().as_u16(), 429);
        }
        other => panic!("unexpected: {other}"),
    }
    drop(clients.pop()); // abrupt browser loss, with no later log to wake cleanup
    tokio::time::timeout(Duration::from_secs(2), async {
        while runtime.state.slots.available_permits() != 1 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let (mut socket, _) = tokio_tungstenite::connect_async(format!("ws://{address}/"))
        .await
        .unwrap();
    assert!(
        socket
            .next()
            .await
            .unwrap()
            .unwrap()
            .to_text()
            .unwrap()
            .contains("retained startup failure")
    );
    clients.push(socket);
    shutdown.send(true).unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        while runtime.state.slots.available_permits() != logging::MAXIMUM_SUBSCRIBERS {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(runtime.state.history.followers(), 0);
    let error = tokio_tungstenite::connect_async(format!("ws://{address}/"))
        .await
        .unwrap_err();
    match error {
        tokio_tungstenite::tungstenite::Error::Http(response) => {
            assert_eq!(response.status().as_u16(), 503);
        }
        other => panic!("unexpected: {other}"),
    }
    server.abort();
}

#[test]
fn oversized_log_record_is_replaced_with_an_explicit_payload_free_warning() {
    let contract: JsonValue =
        serde_json::from_str(include_str!("../../../benchmarks/phase-b-logging.json")).unwrap();
    let maximum =
        usize::try_from(contract["maximumSerializedRecordBytes"].as_u64().unwrap()).unwrap();
    let logging = LoggingRuntime::new();
    logging.record(
        "INFO",
        Some("functions"),
        "sensitive-synthetic".repeat(maximum),
    );
    let history = logging.state.history.snapshot();
    let encoded = &history.first().unwrap().json;
    assert!(
        encoded.len() <= maximum,
        "record bytes must be bounded, not merely record count"
    );
    assert!(encoded.contains("omitted"));
    assert!(!encoded.contains("sensitive-synthetic"));
}

#[tokio::test]
async fn idle_logging_disconnect_releases_its_live_subscription() {
    let logging = LoggingRuntime::new();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let application = logging.application();
    let server = tokio::spawn(async move {
        axum::serve(listener, application).await.unwrap();
    });
    let (mut socket, _) = tokio_tungstenite::connect_async(format!("ws://{address}/"))
        .await
        .unwrap();
    logging.record("INFO", None, "synthetic startup");
    tokio::time::timeout(Duration::from_secs(2), socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(logging.state.history.followers(), 1);
    socket.close(None).await.unwrap();
    drop(socket);
    let released = tokio::time::timeout(Duration::from_secs(2), async {
        while logging.state.history.followers() != 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await;
    server.abort();
    assert!(
        released.is_ok(),
        "closed browser retained an idle logging receiver"
    );
}

/// The console's side of a test: every line the sink was given.
#[derive(Default)]
struct ConsoleLines(std::sync::Mutex<Vec<LogInput>>);

impl ConsoleSink for ConsoleLines {
    fn accept(&self, input: LogInput) {
        lock(&self.0).push(input);
    }
}

impl ConsoleLines {
    fn take(&self) -> Vec<LogInput> {
        std::mem::take(&mut *lock(&self.0))
    }
}

/// A debug-log file of its own, removed when the test ends.
struct DebugLog(std::path::PathBuf);

impl DebugLog {
    fn new(name: &str) -> Self {
        let path =
            std::env::temp_dir().join(format!("firenook-log-{name}-{}.log", std::process::id()));
        let _ = std::fs::remove_file(&path);
        Self(path)
    }

    fn lines(&self) -> Vec<String> {
        std::fs::read_to_string(&self.0)
            .unwrap_or_default()
            .lines()
            .map(normalise_log_line)
            .collect()
    }
}

impl Drop for DebugLog {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// The official feed's records, oldest first, with their times replaced.
fn official_records(logging: &LoggingRuntime) -> Vec<String> {
    logging
        .state
        .history
        .snapshot()
        .iter()
        .map(|entry| normalise_record(&entry.json))
        .collect()
}

/// A websocket record with its time replaced, so a capture compares.
fn normalise_record(json: &str) -> String {
    let marker = "\"timestamp\":\"";
    let start = json.find(marker).expect("timestamp") + marker.len();
    let end = start + json[start..].find('"').expect("timestamp end");
    format!("{}<time>{}", &json[..start], &json[end..])
}

/// A debug-log line (`[LEVEL] [time] [emulator] message`) with its time
/// replaced.
fn normalise_log_line(line: &str) -> String {
    let start = line.find("] [").expect("time") + 3;
    let end = start + line[start..].find("] [").expect("time end");
    format!("{}<time>{}", &line[..start], &line[end..])
}

/// The printed lines of one 300-line burst (about 20 KB), as a worker's
/// stdout gives them line by line.
fn burst_lines() -> Vec<String> {
    (0..300)
        .map(|index| match index {
            0 => String::new(),
            7 => "    at handler (/workspace/functions/index.js:12:9)".to_owned(),
            42 => "quote \" backslash \\ tab \t done".to_owned(),
            99 => "火🔥 unicode survives".to_owned(),
            _ => format!("line {index:03} {}", "abcdefghij".repeat(3 + index % 3)),
        })
        .collect()
}

const BURST_LABEL: &str = "functions[us-central1-burst]";

#[test]
fn record_writes_todays_record_and_hands_the_console_the_same_line() {
    let log = DebugLog::new("record");
    let logging = LoggingRuntime::new();
    logging.set_file_sink(&log.0).unwrap();
    let console = Arc::new(ConsoleLines::default());
    logging.set_console_sink(console.clone());
    logging.record("INFO", Some("functions"), "x");
    logging.record("WARN", None, "m");
    assert_eq!(
        official_records(&logging),
        [
            r#"{"level":"INFO","data":{"metadata":{"emulator":{"name":"functions"},"message":"x"}},"timestamp":"<time>","message":"x"}"#,
            r#"{"level":"WARN","data":{},"timestamp":"<time>","message":"m"}"#,
        ]
    );
    assert_eq!(
        log.lines(),
        ["[INFO] [<time>] [functions] x", "[WARN] [<time>] [suite] m"]
    );
    let lines = console.take();
    assert_eq!(lines.len(), 2);
    assert_eq!(
        (
            lines[0].level,
            lines[0].service.as_str(),
            lines[0].message.as_str()
        ),
        (LogLevel::Info, "functions", "x")
    );
    assert_eq!(
        (
            lines[1].level,
            lines[1].service.as_str(),
            lines[1].message.as_str()
        ),
        (LogLevel::Warn, "hub", "m")
    );
    assert_eq!(lines[1].kind, None);
    assert_eq!(lines[1].audience, Audience::Everyone);
}

#[test]
fn a_console_line_reaches_neither_the_official_feed_nor_the_file() {
    let log = DebugLog::new("console-only");
    let logging = LoggingRuntime::new();
    logging.set_file_sink(&log.0).unwrap();
    let console = Arc::new(ConsoleLines::default());
    logging.set_console_sink(console.clone());
    logging.emit(LogInput {
        level: LogLevel::Warn,
        service: "firestore".to_owned(),
        kind: Some(kinds::RULES_DENIED),
        message: "Rules denied get on users/u_2 for u_9".to_owned(),
        refs: vec![EntityRef::firestore_document("(default)", "users/u_2")],
        audience: Audience::Console,
        ..LogInput::default()
    });
    assert!(logging.is_empty(), "{:?}", official_records(&logging));
    assert_eq!(log.lines(), Vec::<String>::new());
    let lines = console.take();
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0].kind, Some("rules.denied"));
    assert_eq!(lines[0].refs[0].key, "(default)|users/u_2");
}

#[test]
fn function_output_carries_the_keys_the_official_ui_reads() {
    let logging = LoggingRuntime::new();
    let console = Arc::new(ConsoleLines::default());
    logging.set_console_sink(console.clone());
    logging.emit(LogInput {
        level: LogLevel::Error,
        service: "functions".to_owned(),
        source: Some("extensions[resize]".to_owned()),
        function: Some("ext-resize-generate".to_owned()),
        extension: Some("resize".to_owned()),
        message: "resize failed".to_owned(),
        payload: Some(serde_json::json!({ "width": 64, "tags": ["a"] })),
        legacy_text: Some("extensions[resize]: resize failed".to_owned()),
        legacy_level: Some("WARN"),
        ..LogInput::default()
    });
    // An Eventarc line keeps the emulator name the feed always filed it
    // under, and a payload that is not an object stays out of `data.user`.
    logging.emit(LogInput {
        level: LogLevel::Info,
        service: "eventarc".to_owned(),
        message: "delivered".to_owned(),
        payload: Some(serde_json::json!([1, 2])),
        legacy_emulator: Some("functions"),
        ..LogInput::default()
    });
    assert_eq!(
        official_records(&logging),
        [
            r#"{"level":"WARN","data":{"metadata":{"emulator":{"name":"functions"},"extension":{"instanceId":"resize"},"function":{"name":"ext-resize-generate"},"message":"extensions[resize]: resize failed"},"user":{"tags":["a"],"width":64}},"timestamp":"<time>","message":"extensions[resize]: resize failed"}"#,
            r#"{"level":"INFO","data":{"metadata":{"emulator":{"name":"functions"},"message":"delivered"}},"timestamp":"<time>","message":"delivered"}"#,
        ]
    );
    let lines = console.take();
    assert_eq!(lines[0].message, "resize failed");
    assert_eq!(lines[0].level, LogLevel::Error);
    assert_eq!(lines[1].service, "eventarc");
}

#[test]
fn a_multi_line_functions_line_matches_todays_records_byte_for_byte() {
    let log = DebugLog::new("multiline");
    let logging = LoggingRuntime::new();
    logging.set_file_sink(&log.0).unwrap();
    let console = Arc::new(ConsoleLines::default());
    logging.set_console_sink(console.clone());
    let lines = burst_lines();
    let message = lines.join("\n");
    assert!(message.len() > 10_000, "{} bytes", message.len());
    logging.emit(LogInput {
        level: LogLevel::Info,
        service: "functions".to_owned(),
        source: Some(BURST_LABEL.to_owned()),
        message: message.clone(),
        legacy_text: Some(
            lines
                .iter()
                .map(|line| format!("{BURST_LABEL}: {line}"))
                .collect::<Vec<_>>()
                .join("\n"),
        ),
        legacy_level: Some("INFO"),
        legacy_emulator: Some("functions"),
        ..LogInput::default()
    });
    // Captured from the suite before lines carried structure: one record
    // and one debug-log line per printed line.
    let golden_records = include_str!("../tests/golden/multiline-console-log.ws.ndjson")
        .lines()
        .collect::<Vec<_>>();
    let golden_log = include_str!("../tests/golden/multiline-console-log.log")
        .lines()
        .collect::<Vec<_>>();
    assert_eq!(golden_records.len(), 300);
    assert_eq!(official_records(&logging), golden_records);
    assert_eq!(log.lines(), golden_log);
    let entries = console.take();
    assert_eq!(entries.len(), 1, "one console entry for the whole burst");
    assert_eq!(entries[0].message, message);
    assert_eq!(entries[0].message.lines().count(), 300);
}

#[test]
fn a_line_over_the_record_limit_is_omitted_in_the_feed_but_whole_in_the_debug_log() {
    let file = DebugLog::new("oversized");
    let logging = LoggingRuntime::new();
    logging.set_file_sink(&file.0).unwrap();
    let whole = format!("start {} end", "x".repeat(logging::MAXIMUM_RECORD_BYTES));
    logging.record("INFO", Some("functions"), whole.clone());
    let records = official_records(&logging);
    assert_eq!(records.len(), 1);
    assert!(records[0].contains(OMITTED_TEXT), "{}", records[0]);
    assert!(!records[0].contains("start"));
    assert_eq!(
        file.lines(),
        [format!("[INFO] [<time>] [functions] {whole}")]
    );
    // A label the feed refuses is omitted in the file too.
    logging.record(&"L".repeat(65), Some("functions"), "hidden");
    assert!(
        file.lines()[1].ends_with(OMITTED_TEXT),
        "{:?}",
        file.lines()
    );
}

const OMITTED_TEXT: &str = "Oversized log record omitted; diagnostic payload was not retained";

#[test]
fn without_a_console_sink_nothing_is_kept_for_the_console() {
    let logging = LoggingRuntime::new();
    logging.record("INFO", Some("hub"), "before the console");
    logging.emit(LogInput {
        service: "hub".to_owned(),
        message: "also before".to_owned(),
        audience: Audience::Console,
        ..LogInput::default()
    });
    assert_eq!(logging.len(), 1, "the console-only line went nowhere");
    // Every clone shares the sink installed on any of them.
    let console = Arc::new(ConsoleLines::default());
    logging.clone().set_console_sink(console.clone());
    logging.record("INFO", Some("hub"), "after");
    let lines = console.take();
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0].message, "after");
}
