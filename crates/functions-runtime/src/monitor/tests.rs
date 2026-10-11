use std::sync::Mutex as StdMutex;

use axum::http::{HeaderName, HeaderValue};
use serde_json::json;

use super::*;

struct Counting(std::sync::atomic::AtomicUsize);

impl LiveSink for Counting {
    fn push(&self, _event: &Arc<MonitorEvent>) {
        self.0.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    }
}

/// Keeps every pushed event and a head counter, like the console's ring.
#[derive(Default)]
struct Recording {
    events: StdMutex<Vec<Arc<MonitorEvent>>>,
}

impl LiveSink for Recording {
    fn push(&self, event: &Arc<MonitorEvent>) {
        self.events.lock().expect("events").push(Arc::clone(event));
    }
}

impl Recording {
    fn taken(&self) -> Vec<Arc<MonitorEvent>> {
        std::mem::take(&mut *self.events.lock().expect("events"))
    }

    fn head(&self) -> usize {
        self.events.lock().expect("events").len()
    }
}

fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
    let mut map = HeaderMap::new();
    for (name, value) in pairs {
        map.append(
            HeaderName::from_bytes(name.as_bytes()).expect("name"),
            HeaderValue::from_str(value).expect("value"),
        );
    }
    map
}

fn start(function: &str, kind: FunctionKind, body: Bytes, headers: HeaderMap) -> InvocationStart {
    InvocationStart {
        function_id: function.to_owned(),
        codebase: "default".to_owned(),
        kind,
        origin: InvocationOrigin::Emulator,
        cause: InvocationCause::Unknown,
        summary: "POST /".to_owned(),
        target: InvocationTarget::Trigger,
        method: "POST".to_owned(),
        path: "/".to_owned(),
        headers,
        body,
        replay_of: None,
        delivery: None,
    }
}

fn http(monitor: &Monitor, function: &str) -> InvocationToken {
    monitor.begin(start(
        function,
        FunctionKind::Http,
        Bytes::from_static(b"{}"),
        HeaderMap::new(),
    ))
}

fn finish_ok(monitor: &Monitor, token: &InvocationToken) -> InvocationSummary {
    monitor.response_head(token, 200, &HeaderMap::new());
    monitor
        .finish(token, InvocationEnd::default())
        .expect("a summary")
}

fn line(token: &InvocationToken, level: &str, message: &str) -> LogEvent {
    LogEvent::new(level, "functions", message.to_owned())
        .with_execution(token.id.to_string())
        .with_codebase("default")
}

fn registered(monitor: &Monitor, id: &str) {
    monitor.codebase_registered(CodebaseRegistration {
        id: id.to_owned(),
        kind: FunctionCodebaseKind::User,
        directory: "functions".to_owned(),
        runtime: Some("nodejs22".to_owned()),
        inspect_port: None,
    });
}

#[test]
fn release_limits_are_the_defaults() {
    let limits = MonitorLimits::default();
    assert_eq!(limits.invocations, 2_000);
    assert_eq!(limits.kind_floor, 200);
    assert_eq!(limits.body_bytes, 256 * 1024);
    assert_eq!(limits.touched, 4_096);
}

#[test]
fn nonces_are_six_hex_characters() {
    let monitor = Monitor::new(MonitorLimits::default());
    let nonce = monitor.nonce();
    assert_eq!(nonce.len(), 6, "{nonce}");
    assert!(
        nonce.bytes().all(|byte| byte.is_ascii_hexdigit()),
        "{nonce}"
    );
    assert_eq!(monitor.clone().nonce(), nonce);
    assert_eq!(monitor.seq_of(&monitor.id_for(12)), Some(12));
    assert_eq!(monitor.seq_of("zzzzzz-12"), None);
    assert_eq!(monitor.seq_of("nonsense"), None);
}

#[test]
fn a_new_monitor_is_starting_and_holds_nothing() {
    let monitor = Monitor::new(MonitorLimits::default());
    let nonce = monitor.nonce().to_owned();
    assert_eq!(monitor.phase(), FunctionsPhase::Starting);
    assert_eq!(monitor.codebases(), Vec::new());
    assert_eq!(monitor.load_log("default", None), None);
    assert_eq!(monitor.stats("us-central1-api"), FunctionStats::default());
    let keep_all = InvocationQuery {
        filter: None,
        limit: 200,
    };
    assert_eq!(
        monitor.invocations(&keep_all, None),
        InvocationPage::default()
    );
    assert_eq!(monitor.by_event_id("18"), None);
    assert_eq!(
        monitor.by_task("queue:demo-us-central1-resize", "7891", 0),
        None
    );
    assert_eq!(monitor.kept_after(FunctionKind::Pubsub), None);
    let id = format!("{nonce}-1");
    assert_eq!(monitor.invocation(&id), None);
    assert_eq!(monitor.invocation_since(&id, 0, 0), None);
    assert_eq!(monitor.request_body(&id), None);
    assert_eq!(monitor.response_body(&id), None);
    assert_eq!(monitor.header(&id, "authorization"), None);
    let google = EventarcEventQuery {
        channel: Some("google"),
        filter: None,
        limit: 200,
    };
    assert_eq!(monitor.events(&google, None), EventarcEventPage::default());
    assert_eq!(monitor.event(&id), None);
}

#[test]
fn the_handle_and_its_queries_cross_threads_and_awaits() {
    fn shared<T: Send + Sync + Clone + 'static>() {}
    fn sendable<T: Send>(_: &T) {}
    shared::<Monitor>();
    let words = |summary: &InvocationSummary| summary.summary.contains("orders/");
    let query = InvocationQuery {
        filter: Some(&words),
        limit: 10,
    };
    sendable(&query);
    let on_google = |summary: &EventarcEventSummary| summary.channel == "google";
    let events = EventarcEventQuery {
        channel: None,
        filter: Some(&on_google),
        limit: 10,
    };
    sendable(&events);
}

#[test]
fn one_live_sink_per_monitor() {
    let monitor = Monitor::new(MonitorLimits::default());
    let first: Arc<dyn LiveSink> = Arc::new(Counting(0.into()));
    let second: Arc<dyn LiveSink> = Arc::new(Counting(0.into()));
    assert!(monitor.set_live_sink(first).is_ok());
    let refused = monitor.clone().set_live_sink(Arc::clone(&second));
    assert!(refused.is_err_and(|sink| Arc::ptr_eq(&sink, &second)));
}

#[test]
fn begin_and_finish_carry_absolute_stats() {
    let monitor = Monitor::new(MonitorLimits::default());
    let sink = Arc::new(Recording::default());
    assert!(monitor.set_live_sink(sink.clone()).is_ok());
    registered(&monitor, "default");
    let _ = sink.taken();
    let token = http(&monitor, "us-central1-api");
    assert_eq!(&*token.id, format!("{}-1", monitor.nonce()));
    let events = sink.taken();
    let [started] = events.as_slice() else {
        panic!("one event: {events:?}");
    };
    let MonitorEvent::InvocationStarted { summary, stats } = &**started else {
        panic!("a start: {started:?}");
    };
    assert_eq!(summary.outcome_class, InvocationOutcomeClass::Running);
    assert_eq!(stats.in_flight, 1);
    assert_eq!(stats.runs, 0);
    assert_eq!(
        monitor
            .codebase("default")
            .expect("registered")
            .worker
            .in_flight,
        1
    );
    let finished = finish_ok(&monitor, &token);
    assert_eq!(finished.outcome, Some(InvocationOutcome::Succeeded));
    assert_eq!(finished.status, Some(200));
    assert!(finished.duration_ms.is_some());
    let events = sink.taken();
    let [ended] = events.as_slice() else {
        panic!("one event: {events:?}");
    };
    let MonitorEvent::InvocationFinished { summary, stats } = &**ended else {
        panic!("a finish: {ended:?}");
    };
    assert_eq!(summary.seq, token.seq);
    assert_eq!(stats.in_flight, 0);
    assert_eq!(stats.runs, 1);
    assert_eq!(stats.failures, 0);
    assert_eq!(stats.last.as_ref().map(|last| last.seq), Some(token.seq));
    assert!(stats.p50_ms.is_some());
    // A failure counts; the stats stay absolute.
    let failing = http(&monitor, "us-central1-api");
    monitor.response_head(&failing, 500, &HeaderMap::new());
    let failed = monitor
        .finish(&failing, InvocationEnd::default())
        .expect("a summary");
    assert_eq!(failed.outcome, Some(InvocationOutcome::Failed));
    let stats = monitor.stats("us-central1-api");
    assert_eq!((stats.runs, stats.failures, stats.in_flight), (2, 1, 0));
    assert_eq!(monitor.finish(&failing, InvocationEnd::default()), None);
}

#[test]
fn the_runtimes_own_endings_keep_their_words() {
    let monitor = Monitor::new(MonitorLimits::default());
    let token = http(&monitor, "us-central1-slow");
    let summary = monitor
        .finish(
            &token,
            InvocationEnd {
                outcome: Some(InvocationOutcome::TimedOut),
                error: Some("Timed out after 1s".to_owned()),
                client_gone: false,
            },
        )
        .expect("a summary");
    assert_eq!(summary.outcome, Some(InvocationOutcome::TimedOut));
    assert_eq!(summary.outcome_class, InvocationOutcomeClass::Failed);
    assert_eq!(summary.error.as_deref(), Some("Timed out after 1s"));
    // A restart's interrupted calls crash with the restart's reason.
    registered(&monitor, "default");
    let running = http(&monitor, "us-central1-api");
    assert_eq!(monitor.running("default"), 1);
    assert_eq!(monitor.interrupt("default", "the worker was restarted"), 1);
    let crashed = monitor
        .finish(
            &running,
            InvocationEnd {
                outcome: Some(InvocationOutcome::Crashed),
                error: Some("Request to function failed: reset".to_owned()),
                client_gone: false,
            },
        )
        .expect("a summary");
    assert_eq!(crashed.error.as_deref(), Some("the worker was restarted"));
}

#[test]
fn lines_are_routed_by_execution() {
    let monitor = Monitor::new(MonitorLimits::default());
    registered(&monitor, "default");
    let token = http(&monitor, "us-central1-api");
    assert_eq!(
        monitor.log(&line(&token, "INFO", "hello")).as_deref(),
        Some("us-central1-api")
    );
    // A line without an execution goes to its codebase's load log.
    let load =
        LogEvent::new("INFO", "functions", "module loaded".to_owned()).with_codebase("default");
    assert_eq!(monitor.log(&load), None);
    // A runtime message with no codebase is not the monitor's.
    assert_eq!(
        monitor.log(&LogEvent::new("INFO", "functions", "x".to_owned())),
        None
    );
    let finished = finish_ok(&monitor, &token);
    assert_eq!(finished.log_count, 1);
    // A line printed after the end lands in the finished record.
    let late = line(&token, "WARN", "still working")
        .with_time(SystemTime::now() + Duration::from_millis(5));
    assert_eq!(monitor.log(&late).as_deref(), Some("us-central1-api"));
    let detail = monitor.invocation(&token.id).expect("kept");
    assert_eq!(detail.logs.len(), 2);
    assert_eq!(detail.logs[0].message, "hello");
    assert!(!detail.logs[0].after_finish);
    assert_eq!(detail.logs[1].level, FunctionLogLevel::Warn);
    assert!(detail.logs[1].after_finish);
    let log = monitor.load_log("default", None).expect("a load log");
    assert_eq!(log.len(), 1);
    assert_eq!(log[0].message, "module loaded");
    assert_eq!(
        monitor.load_log("default", Some(0)).expect("known"),
        Vec::new()
    );
}

#[test]
fn a_line_whose_record_is_gone_goes_to_the_load_log() {
    let monitor = Monitor::new(MonitorLimits {
        invocations: 1,
        kind_floor: 0,
        ..MonitorLimits::default()
    });
    registered(&monitor, "default");
    let first = http(&monitor, "us-central1-api");
    finish_ok(&monitor, &first);
    let second = http(&monitor, "us-central1-api");
    finish_ok(&monitor, &second);
    assert_eq!(monitor.invocation(&first.id), None);
    assert_eq!(monitor.log(&line(&first, "INFO", "late")), None);
    let log = monitor.load_log("default", None).expect("known");
    assert_eq!(log.last().map(|line| line.message.as_str()), Some("late"));
    assert!(monitor.kept_after(FunctionKind::Http).is_some());
}

#[test]
fn only_the_function_error_line_is_the_error() {
    let monitor = Monitor::new(MonitorLimits::default());
    let sink = Arc::new(Recording::default());
    assert!(monitor.set_live_sink(sink.clone()).is_ok());
    let token = monitor.begin(start(
        "us-central1-onOrder",
        FunctionKind::Firestore,
        Bytes::from_static(b"{}"),
        HeaderMap::new(),
    ));
    monitor.log(&line(&token, "ERROR", "printed with console.error"));
    monitor.response_head(&token, 500, &HeaderMap::new());
    let summary = monitor
        .finish(
            &token,
            InvocationEnd {
                outcome: Some(InvocationOutcome::Failed),
                ..InvocationEnd::default()
            },
        )
        .expect("a summary");
    assert_eq!(summary.error, None);
    let _ = sink.taken();
    // The handler's error line can arrive after the answer it preceded.
    let error = line(
        &token,
        "ERROR",
        "Error: boom\n    at handler (index.js:3:9)",
    )
    .with_kind(FUNCTION_ERROR)
    .with_time(SystemTime::now() + Duration::from_millis(5));
    monitor.log(&error);
    let detail = monitor.invocation(&token.id).expect("kept");
    assert_eq!(detail.summary.error.as_deref(), Some("Error: boom"));
    assert!(!detail.logs[1].after_finish);
    let events = sink.taken();
    assert!(events.iter().any(|event| matches!(&**event,
        MonitorEvent::InvocationFinished { summary, stats }
            if summary.error.as_deref() == Some("Error: boom") && stats.failures == 1)));
    assert_eq!(
        monitor
            .stats("us-central1-onOrder")
            .last
            .and_then(|last| last.error)
            .as_deref(),
        Some("Error: boom")
    );
}

#[test]
fn a_structured_line_keeps_its_severity_and_fields() {
    let monitor = Monitor::new(MonitorLimits::default());
    let token = http(&monitor, "us-central1-api");
    monitor.log(&line(
        &token,
        "INFO",
        r#"{"severity":"ERROR","message":"charge failed","orderId":"o_1"}"#,
    ));
    let detail = monitor.invocation(&token.id).expect("kept");
    let kept = &detail.logs[0];
    assert_eq!(kept.level, FunctionLogLevel::Error);
    assert_eq!(kept.message, "charge failed");
    assert_eq!(kept.fields, Some(json!({"orderId": "o_1"})));
}

#[test]
fn caps_record_one_not_kept_line() {
    let monitor = Monitor::new(MonitorLimits {
        log_lines: 3,
        ..MonitorLimits::default()
    });
    let token = http(&monitor, "us-central1-api");
    for index in 0..10 {
        monitor.log(&line(&token, "INFO", &format!("line {index}")));
    }
    let detail = monitor.invocation(&token.id).expect("kept");
    assert_eq!(detail.logs.len(), 4);
    assert_eq!(detail.logs[3].kind.as_deref(), Some(LINES_NOT_KEPT));
    assert_eq!(detail.logs_dropped, 7);
    assert_eq!(detail.summary.log_count, 3);
    let bytes = Monitor::new(MonitorLimits {
        log_bytes: 400,
        ..MonitorLimits::default()
    });
    let token = http(&bytes, "us-central1-api");
    for _ in 0..10 {
        bytes.log(&line(&token, "INFO", &"x".repeat(100)));
    }
    let detail = bytes.invocation(&token.id).expect("kept");
    assert_eq!(
        detail.logs.last().and_then(|line| line.kind.as_deref()),
        Some(LINES_NOT_KEPT)
    );
    assert!(detail.logs.len() < 10);
}

#[test]
fn load_logs_are_bounded_per_codebase() {
    let monitor = Monitor::new(MonitorLimits {
        load_log_lines: 3,
        ..MonitorLimits::default()
    });
    registered(&monitor, "default");
    registered(&monitor, "jobs");
    for index in 0..5 {
        monitor.log(
            &LogEvent::new("INFO", "functions", format!("default {index}"))
                .with_codebase("default"),
        );
    }
    monitor.log(&LogEvent::new(
        "INFO",
        "extensions[jobs]",
        "from a label".to_owned(),
    ));
    let default = monitor.load_log("default", None).expect("known");
    let indexes: Vec<u32> = default.iter().map(|line| line.index).collect();
    assert_eq!(indexes, [2, 3, 4]);
    assert_eq!(
        monitor.load_log("jobs", None).expect("known")[0].message,
        "from a label"
    );
    assert_eq!(
        monitor.load_log("default", Some(3)).expect("known").len(),
        1
    );
}

#[test]
fn the_event_id_index_answers_the_newest_and_leaves_with_its_record() {
    let monitor = Monitor::new(MonitorLimits {
        invocations: 2,
        kind_floor: 0,
        ..MonitorLimits::default()
    });
    let with_id = |id: &str| headers(&[("x-firenook-event-id", id)]);
    let first = monitor.begin(start(
        "us-central1-onEmail",
        FunctionKind::Pubsub,
        Bytes::new(),
        with_id("18"),
    ));
    finish_ok(&monitor, &first);
    let redelivered = monitor.begin(start(
        "us-central1-onEmail",
        FunctionKind::Pubsub,
        Bytes::new(),
        with_id("18"),
    ));
    assert_eq!(
        monitor.by_event_id("18").map(|summary| summary.seq),
        Some(redelivered.seq)
    );
    finish_ok(&monitor, &redelivered);
    let other = monitor.begin(start(
        "us-central1-onEmail",
        FunctionKind::Pubsub,
        Bytes::new(),
        headers(&[("ce-id", "c-1")]),
    ));
    finish_ok(&monitor, &other);
    assert_eq!(
        monitor.by_event_id("c-1").map(|summary| summary.seq),
        Some(other.seq)
    );
    assert_eq!(
        monitor.by_event_id("18").map(|summary| summary.seq),
        Some(redelivered.seq)
    );
    let last = monitor.begin(start(
        "us-central1-onEmail",
        FunctionKind::Pubsub,
        Bytes::new(),
        HeaderMap::new(),
    ));
    finish_ok(&monitor, &last);
    let fourth = http(&monitor, "us-central1-api");
    finish_ok(&monitor, &fourth);
    assert_eq!(monitor.by_event_id("18"), None);
    let kept = monitor
        .kept_after(FunctionKind::Pubsub)
        .expect("pubsub records were let go");
    assert!(kept <= SystemTime::now());
}

#[test]
fn task_attempts_are_indexed() {
    let monitor = Monitor::new(MonitorLimits::default());
    let attempt = headers(&[
        ("x-cloudtasks-queuename", "queue:demo-us-central1-resize"),
        ("x-cloudtasks-taskname", "7891"),
        ("x-cloudtasks-taskretrycount", "1"),
    ]);
    let token = monitor.begin(start(
        "us-central1-resize",
        FunctionKind::Tasks,
        Bytes::new(),
        attempt,
    ));
    let summary = monitor
        .by_task("queue:demo-us-central1-resize", "7891", 1)
        .expect("indexed");
    assert_eq!(summary.seq, token.seq);
    assert_eq!(summary.attempt, 2);
    assert_eq!(
        monitor.by_task("queue:demo-us-central1-resize", "7891", 0),
        None
    );
}

#[test]
fn in_flight_records_are_never_evicted() {
    let monitor = Monitor::new(MonitorLimits {
        invocations: 5,
        kind_floor: 0,
        ..MonitorLimits::default()
    });
    let running: Vec<InvocationToken> = (0..20)
        .map(|_| http(&monitor, "us-central1-slow"))
        .collect();
    for _ in 0..50 {
        let token = http(&monitor, "us-central1-fast");
        finish_ok(&monitor, &token);
    }
    for token in &running {
        assert!(monitor.invocation(&token.id).is_some());
    }
    let all = InvocationQuery {
        filter: None,
        limit: 1_000,
    };
    assert_eq!(monitor.invocations(&all, None).total, 25);
}

#[test]
fn a_large_body_is_copied_and_a_small_one_shared() {
    let monitor = Monitor::new(MonitorLimits::default());
    let large = Bytes::from(vec![b'a'; 4 * 1024 * 1024]);
    let token = monitor.begin(start(
        "us-central1-upload",
        FunctionKind::Http,
        large.clone(),
        HeaderMap::new(),
    ));
    let kept = monitor.request_body(&token.id).expect("kept");
    assert_eq!(kept.bytes.len(), 256 * 1024);
    assert_eq!(kept.size, 4 * 1024 * 1024);
    assert!(kept.truncated);
    // The kept head does not pin the 4 MiB allocation.
    let source = large.as_ptr() as usize..large.as_ptr() as usize + large.len();
    assert!(!source.contains(&(kept.bytes.as_ptr() as usize)));
    let retained = monitor
        .lock()
        .in_flight
        .get(&token.seq)
        .expect("running")
        .retained;
    assert!(retained < 300 * 1024, "{retained}");
    let small = Bytes::from(vec![b'b'; 100 * 1024]);
    let token = monitor.begin(start(
        "us-central1-upload",
        FunctionKind::Http,
        small.clone(),
        HeaderMap::new(),
    ));
    let kept = monitor.request_body(&token.id).expect("kept");
    assert_eq!(kept.bytes.as_ptr(), small.as_ptr());
    assert!(!kept.truncated);
    let detail = monitor.invocation(&token.id).expect("kept");
    assert!(detail.replayable);
}

#[test]
fn past_the_in_flight_limit_only_summaries_are_kept() {
    let monitor = Monitor::new(MonitorLimits {
        in_flight: 2,
        ..MonitorLimits::default()
    });
    let _first = http(&monitor, "us-central1-api");
    let _second = http(&monitor, "us-central1-api");
    let third = http(&monitor, "us-central1-api");
    monitor.log(&line(&third, "INFO", "not kept"));
    let detail = monitor.invocation(&third.id).expect("its summary");
    assert!(!detail.replayable);
    assert!(detail.not_replayable.is_some());
    assert_eq!(detail.logs.len(), 0);
    assert_eq!(detail.logs_dropped, 1);
    assert_eq!(monitor.request_body(&third.id), None);
}

#[test]
fn details_withhold_sensitive_headers_and_reveal_them_one_at_a_time() {
    let monitor = Monitor::new(MonitorLimits::default());
    let token = monitor.begin(InvocationStart {
        target: InvocationTarget::Url,
        method: "GET".to_owned(),
        path: "/hello?x=1".to_owned(),
        ..start(
            "us-central1-api",
            FunctionKind::Http,
            Bytes::new(),
            headers(&[
                ("authorization", "Bearer secret-token"),
                ("x-firebase-appcheck", "check"),
                ("accept", "application/json"),
                ("x-firenook-console", "functions"),
            ]),
        )
    });
    let mut response_headers = headers(&[("content-type", "application/json")]);
    response_headers.insert("set-cookie", HeaderValue::from_static("a=b"));
    monitor.response_head(&token, 200, &response_headers);
    monitor.response_chunk(&token, b"{\"ok\":");
    monitor.response_chunk(&token, b"true}");
    monitor.finish(&token, InvocationEnd::default());
    let detail = monitor.invocation(&token.id).expect("kept");
    let authorization = detail
        .request
        .headers
        .iter()
        .find(|header| header.name == "authorization")
        .expect("listed");
    assert_eq!(authorization.value, None);
    assert!(authorization.sensitive);
    assert!(
        detail
            .request
            .headers
            .iter()
            .all(|header| !header.name.starts_with("x-firenook-"))
    );
    let serialized = serde_json::to_string(&detail).expect("json");
    assert!(!serialized.contains("secret-token"), "{serialized}");
    assert_eq!(
        monitor.header(&token.id, "Authorization").as_deref(),
        Some("Bearer secret-token")
    );
    let response = detail.response.expect("a response");
    assert_eq!(response.body.text, "{\"ok\":true}");
    assert_eq!(response.chunks, 2);
    assert!(response.streaming);
    assert_eq!(detail.event, None);
    assert_eq!(detail.live_cursor, "0.11");
    let recorded = monitor.recorded_request(&token.id).expect("kept");
    assert_eq!(
        recorded.headers.get("authorization").expect("kept"),
        "Bearer secret-token"
    );
    assert_eq!(recorded.path, "/hello?x=1");
}

#[test]
fn invocation_progress_reads_from_a_position() {
    let monitor = Monitor::new(MonitorLimits::default());
    let token = http(&monitor, "us-central1-stream");
    monitor.response_head(&token, 200, &headers(&[("content-type", "text/plain")]));
    monitor.log(&line(&token, "INFO", "one"));
    monitor.response_chunk(&token, "héllo".as_bytes());
    let progress = monitor.invocation_since(&token.id, 0, 0).expect("kept");
    assert_eq!(progress.lines.len(), 1);
    assert_eq!(progress.chunks[0].text, "héllo");
    assert_eq!((progress.next_line, progress.next_byte), (1, 6));
    assert_eq!(progress.finished, None);
    // A character cut between chunks waits for its end.
    monitor.response_chunk(&token, &"é".as_bytes()[..1]);
    let waiting = monitor.invocation_since(&token.id, 1, 6).expect("kept");
    assert_eq!(waiting.chunks, Vec::new());
    assert_eq!(waiting.next_byte, 6);
    monitor.response_chunk(&token, &"é".as_bytes()[1..]);
    monitor.log(&line(&token, "INFO", "two"));
    monitor.finish(&token, InvocationEnd::default());
    let rest = monitor.invocation_since(&token.id, 1, 6).expect("kept");
    assert_eq!(rest.lines[0].message, "two");
    assert_eq!(rest.chunks[0].text, "é");
    assert!(rest.finished.is_some());
}

#[tokio::test]
async fn touched_ids_reach_every_receiver() {
    let monitor = Monitor::new(MonitorLimits {
        touched: 0,
        ..MonitorLimits::default()
    });
    let mut first = monitor.touched();
    let mut second = monitor.clone().touched();
    let token = http(&monitor, "us-central1-api");
    monitor.log(&line(&token, "INFO", "x"));
    assert_eq!(first.recv().await.expect("an id"), token.id);
    assert_eq!(second.recv().await.expect("an id"), token.id);
}

#[test]
fn a_snapshot_reads_state_and_the_sinks_head_under_one_lock() {
    let monitor = Monitor::new(MonitorLimits::default());
    let sink = Arc::new(Recording::default());
    assert!(monitor.set_live_sink(sink.clone()).is_ok());
    let tokens: Vec<InvocationToken> = (0..200)
        .map(|_| http(&monitor, "us-central1-api"))
        .collect();
    let writer = {
        let monitor = monitor.clone();
        std::thread::spawn(move || {
            for token in &tokens {
                finish_ok(&monitor, token);
            }
        })
    };
    let mut checks = 0;
    while checks < 50 {
        let (counted, head) =
            monitor.snapshot(|view| (view.stats("us-central1-api").runs, sink.head()));
        // Every finish is either in the state (and its event before the head)
        // or after the head: the pushed events up to `head` hold exactly
        // `finished` finishes.
        let events = sink.events.lock().expect("events");
        let pushed = events[..head]
            .iter()
            .filter(|event| matches!(&***event, MonitorEvent::InvocationFinished { .. }))
            .count() as u64;
        drop(events);
        assert_eq!(pushed, counted);
        checks += 1;
    }
    writer.join().expect("finished");
}

#[test]
fn codebases_follow_loads_workers_and_stale_flags() {
    let monitor = Monitor::new(MonitorLimits::default());
    let sink = Arc::new(Recording::default());
    assert!(monitor.set_live_sink(sink.clone()).is_ok());
    registered(&monitor, "default");
    monitor.codebase_loading("default");
    assert_eq!(
        monitor.codebase("default").expect("known").state,
        FunctionLoadState::Loading
    );
    monitor.codebase_loaded(
        "default",
        LoadReport {
            function_count: 3,
            env_files: vec![".env".to_owned()],
            diff: FunctionRegistryDiff {
                added: vec!["us-central1-api".to_owned()],
                ..FunctionRegistryDiff::default()
            },
            elapsed: Duration::from_millis(120),
            ..LoadReport::default()
        },
    );
    let ready = monitor.codebase("default").expect("known");
    assert_eq!(
        (ready.state, ready.loads, ready.function_count),
        (FunctionLoadState::Ready, 1, 3)
    );
    assert_eq!(ready.load_ms, Some(120.0));
    assert!(sink.taken().iter().any(|event| matches!(&**event,
        MonitorEvent::Inventory { codebase, loads: 1, diff } if codebase == "default" && diff.added.len() == 1)));
    monitor.codebase_stale(
        "default",
        Some(FunctionStale::EnvChanged {
            file: ".env".to_owned(),
            changed_at: format_timestamp(SystemTime::now()),
        }),
    );
    assert!(monitor.codebase("default").expect("known").stale.is_some());
    // A failed reload keeps serving the previous load and clears the flags.
    monitor.codebase_loaded(
        "default",
        LoadReport {
            error: Some(load_error(
                "Failed to load: SyntaxError\n  at /project/functions/index.js:1",
                std::path::Path::new("/project"),
                SystemTime::now(),
            )),
            kept_previous: true,
            ..LoadReport::default()
        },
    );
    let failed = monitor.codebase("default").expect("known");
    assert_eq!(failed.state, FunctionLoadState::Failed);
    assert!(failed.serving_previous);
    assert_eq!(failed.function_count, 3);
    assert_eq!(failed.stale, None);
    let error = failed.error.expect("an error");
    assert_eq!(error.message, "Failed to load: SyntaxError");
    assert_eq!(error.detail.as_deref(), Some("  at ./functions/index.js:1"));
    monitor.worker_state("default", WorkerTransition::Starting);
    monitor.worker_state(
        "default",
        WorkerTransition::Running {
            pid: Some(42),
            node: Some("24.20.0".to_owned()),
            start: Duration::from_millis(300),
        },
    );
    let worker = monitor.codebase("default").expect("known").worker;
    assert_eq!(
        (worker.state, worker.pid, worker.restarts),
        (FunctionWorkerState::Running, Some(42), 0)
    );
    monitor.worker_state(
        "default",
        WorkerTransition::Exited {
            status: "exited with code 1".to_owned(),
        },
    );
    let worker = monitor.codebase("default").expect("known").worker;
    assert_eq!(worker.state, FunctionWorkerState::Exited);
    assert_eq!(worker.last_exit.as_deref(), Some("exited with code 1"));
    monitor.worker_state(
        "default",
        WorkerTransition::Running {
            pid: Some(43),
            node: None,
            start: Duration::from_millis(1),
        },
    );
    monitor.worker_state("default", WorkerTransition::Stopped);
    let worker = monitor.codebase("default").expect("known").worker;
    assert_eq!(
        (worker.state, worker.restarts),
        (FunctionWorkerState::Stopped, 1)
    );
}

#[test]
fn clearing_keeps_running_calls_and_marks_the_kinds_let_go() {
    let monitor = Monitor::new(MonitorLimits::default());
    let done = http(&monitor, "us-central1-api");
    finish_ok(&monitor, &done);
    let running = http(&monitor, "us-central1-api");
    monitor.clear_invocations();
    assert_eq!(monitor.invocation(&done.id), None);
    assert!(monitor.invocation(&running.id).is_some());
    assert!(monitor.kept_after(FunctionKind::Http).is_some());
    assert_eq!(monitor.kept_after(FunctionKind::Pubsub), None);
}

#[test]
fn invocation_pages_run_newest_first_with_exact_totals() {
    let monitor = Monitor::new(MonitorLimits::default());
    let mut tokens = Vec::new();
    for index in 0..7 {
        let token = http(&monitor, "us-central1-api");
        if index % 2 == 0 {
            monitor.response_head(&token, 500, &HeaderMap::new());
            monitor.finish(&token, InvocationEnd::default());
        }
        tokens.push(token);
    }
    let failed =
        |summary: &InvocationSummary| summary.outcome_class == InvocationOutcomeClass::Failed;
    let query = InvocationQuery {
        filter: Some(&failed),
        limit: 2,
    };
    let first = monitor.invocations(&query, None);
    assert_eq!(first.total, 4);
    let seqs: Vec<u64> = first.items.iter().map(|summary| summary.seq).collect();
    assert_eq!(seqs, [7, 5]);
    assert_eq!(first.next, Some(5));
    let second = monitor.invocations(&query, first.next);
    let seqs: Vec<u64> = second.items.iter().map(|summary| summary.seq).collect();
    assert_eq!(seqs, [3, 1]);
    assert_eq!(second.next, None);
}

#[test]
fn eventarc_events_record_their_deliveries() {
    let monitor = Monitor::new(MonitorLimits::default());
    let sink = Arc::new(Recording::default());
    assert!(monitor.set_live_sink(sink.clone()).is_ok());
    let channel = "projects/demo/locations/us-central1/channels/firebase";
    let recorded = monitor.event_received(EventReceived {
        channel: channel.to_owned(),
        raw: json!({"id": "g-1", "type": "test.greeted", "source": "projects/demo/instances/greeter", "textData": "{}"}),
        converted: Ok(json!({"id": "g-1", "type": "test.greeted", "source": "projects/demo/instances/greeter",
            "specversion": "1.0", "datacontenttype": "application/json", "time": "2026-10-12T00:00:00Z",
            "subject": "ada", "data": {"name": "ada"}, "tier": "gold"})),
        origin: EventarcOrigin::App,
        replay_of: None,
        deliveries: vec![
            DeliveryPlan {
                trigger_key: "us-central1-onGreeted-0".to_owned(),
                function_id: Some("us-central1-onGreeted".to_owned()),
                mismatches: Vec::new(),
            },
            DeliveryPlan {
                trigger_key: "us-central1-onVip-0".to_owned(),
                function_id: Some("us-central1-onVip".to_owned()),
                mismatches: vec![EventarcFilterMismatch {
                    attribute: "tier".to_owned(),
                    expected: "vip".to_owned(),
                    actual: Some("gold".to_owned()),
                }],
            },
        ],
    });
    let summary = monitor.event(&recorded.id).expect("kept").summary;
    assert_eq!(
        (summary.matched, summary.filtered, summary.pending),
        (1, 1, 1)
    );
    assert_eq!(summary.publisher.as_deref(), Some("greeter"));
    assert!(!summary.unheard);
    let token = monitor.begin(InvocationStart {
        delivery: Some((recorded.seq, 0)),
        ..start(
            "us-central1-onGreeted",
            FunctionKind::Eventarc,
            Bytes::new(),
            HeaderMap::new(),
        )
    });
    let invocation = monitor.summary(token.seq).expect("running");
    assert!(matches!(&invocation.cause,
        InvocationCause::Eventarc { event: Some(event), subject: Some(subject), .. }
            if *event == recorded.id && subject == "ada"));
    assert_eq!(invocation.summary, "test.greeted from greeter");
    finish_ok(&monitor, &token);
    let detail = monitor.event(&recorded.id).expect("kept");
    assert_eq!(detail.summary.delivered, 1);
    assert_eq!(detail.summary.pending, 0);
    assert_eq!(
        detail.deliveries[0].invocation_id.as_deref(),
        Some(&*token.id)
    );
    assert_eq!(
        detail.deliveries[0].outcome,
        Some(InvocationOutcome::Succeeded)
    );
    assert!(detail.deliveries[0].duration_ms.is_some());
    assert_eq!(
        detail.attributes.get("tier").map(String::as_str),
        Some("gold")
    );
    assert_eq!(detail.data, json!({"name": "ada"}));
    let pushed = sink.taken();
    let latest = pushed.iter().rev().find_map(|event| match &**event {
        MonitorEvent::Event(summary) => Some(summary.clone()),
        _ => None,
    });
    assert_eq!(latest.map(|summary| summary.delivered), Some(1));
    // An event nothing listens for, and one that could not be read.
    let unheard = monitor.event_received(EventReceived {
        channel: "google".to_owned(),
        raw: json!({"type": "nobody.listens"}),
        converted: Ok(json!({"type": "nobody.listens"})),
        origin: EventarcOrigin::Console,
        replay_of: None,
        deliveries: Vec::new(),
    });
    assert!(monitor.event(&unheard.id).expect("kept").summary.unheard);
    let broken = monitor.event_received(EventReceived {
        channel: channel.to_owned(),
        raw: json!({"type": "test.greeted"}),
        converted: Err("CloudEvent 'id' is required.".to_owned()),
        origin: EventarcOrigin::App,
        replay_of: None,
        deliveries: Vec::new(),
    });
    let broken = monitor.event(&broken.id).expect("kept").summary;
    assert_eq!(
        broken.error.as_deref(),
        Some("CloudEvent 'id' is required.")
    );
    assert!(!broken.unheard);
    let google = EventarcEventQuery {
        channel: Some("google"),
        filter: None,
        limit: 10,
    };
    assert_eq!(monitor.events(&google, None).total, 1);
    let all = EventarcEventQuery {
        channel: None,
        filter: None,
        limit: 2,
    };
    let page = monitor.events(&all, None);
    assert_eq!(page.total, 3);
    assert_eq!(page.items.len(), 2);
    assert_eq!(page.next, Some(page.items[1].seq));
    monitor.clear_events();
    assert_eq!(monitor.event(&recorded.id), None);
}

#[test]
fn large_event_data_is_cut_and_counted() {
    let monitor = Monitor::new(MonitorLimits {
        event_data_bytes: 64,
        ..MonitorLimits::default()
    });
    let data = json!({"text": "é".repeat(100)});
    let recorded = monitor.event_received(EventReceived {
        channel: "google".to_owned(),
        raw: json!({"type": "a", "data": data.clone()}),
        converted: Ok(json!({"type": "a", "data": data})),
        origin: EventarcOrigin::App,
        replay_of: None,
        deliveries: Vec::new(),
    });
    let detail = monitor.event(&recorded.id).expect("kept");
    assert!(detail.data_truncated);
    assert!(detail.data_size > 64);
    assert!(detail.data.as_str().is_some_and(|text| text.len() <= 64));
}

#[test]
fn background_events_are_decoded_for_reading() {
    let monitor = Monitor::new(MonitorLimits::default());
    let token = monitor.begin(start(
        "us-central1-onOrder",
        FunctionKind::Firestore,
        Bytes::from_static(b"{\"context\":{\"eventId\":\"e\"},\"data\":{}}"),
        headers(&[("content-type", "application/json")]),
    ));
    let detail = monitor.invocation(&token.id).expect("kept");
    assert_eq!(
        detail.event,
        Some(json!({"context": {"eventId": "e"}, "data": {}}))
    );
    let binary = monitor.begin(start(
        "us-central1-onOrder",
        FunctionKind::Firestore,
        Bytes::from_static(b"CgQKAg=="),
        headers(&[
            ("content-type", "application/protobuf"),
            ("ce-type", "google.cloud.firestore.document.v1.created"),
            ("ce-document", "orders/o_1"),
        ]),
    ));
    let event = monitor
        .invocation(&binary.id)
        .expect("kept")
        .event
        .expect("decoded");
    assert_eq!(event["type"], "google.cloud.firestore.document.v1.created");
    assert_eq!(event["document"], "orders/o_1");
    assert_eq!(event["data"]["protobuf"], "CgQKAg==");
}

#[test]
fn exit_statuses_read_in_words() {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt as _;
        assert_eq!(
            exit_description(std::process::ExitStatus::from_raw(1 << 8)),
            "exited with code 1"
        );
        assert_eq!(
            exit_description(std::process::ExitStatus::from_raw(9)),
            "was killed by signal 9"
        );
    }
}
