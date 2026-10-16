//! The monitor's cost on the delivery path, against fixed budgets.
//!
//! Function delivery is a measured lane, so recording must not move it:
//! `begin` + `response_head` + `finish` for a 1 KiB request with 12 headers
//! (the live sink's serialization of each row included, as the console's
//! ring does it), `begin` for a 4 MiB body (only its first 256 KiB are
//! kept), and routing a worker's log line by its execution id, plain and
//! structured. Criterion reports the numbers; after it, each path is timed
//! again and the run fails when one breaches its budget (under `cargo
//! bench` only: `cargo test` runs the binary once, unoptimized, as a smoke
//! test).
//!
//! The budgets sit about ten times above what a development machine
//! measures while other work runs on it (a round trip with the sink about
//! 6 µs, a 4 MiB begin 8 to 20 µs, a log line well under 1 µs), so a
//! shared CI runner's noise never reaches them while the regressions that
//! matter do: parsing an event body on the dispatch path, copying a large
//! body whole, or a scan of the kept records per call each cost far more.
//! Run with `cargo bench -p firenook-functions-runtime --bench monitor --
//! --quick`.

use std::collections::VecDeque;
use std::hint::black_box;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::body::Bytes;
use axum::http::{HeaderMap, HeaderName, HeaderValue};
use criterion::{Criterion, criterion_group};
use firenook_functions_runtime::monitor::{
    FunctionKind, InvocationCause, InvocationEnd, InvocationOrigin, InvocationStart,
    InvocationTarget, MonitorEvent,
};
use firenook_functions_runtime::{LiveSink, LogEvent, LogStream, Monitor, MonitorLimits};

/// `begin` + `response_head` + `finish` of a small request, the sink's
/// serialization included.
const ROUND_TRIP_BUDGET: Duration = Duration::from_micros(50);
/// `begin` of a 4 MiB body.
const LARGE_BEGIN_BUDGET: Duration = Duration::from_micros(150);
/// Routing one log line.
const LOG_BUDGET: Duration = Duration::from_micros(5);

/// What the console's live sink does under the monitor's lock: serialize
/// the row once and push it into a bounded ring.
struct RingSink {
    ring: Mutex<VecDeque<Arc<str>>>,
}

impl RingSink {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            ring: Mutex::new(VecDeque::with_capacity(10_000)),
        })
    }
}

impl LiveSink for RingSink {
    fn push(&self, event: &Arc<MonitorEvent>) {
        // The row once, and the function's stats with that row spliced in
        // as `last` instead of serialized a second time.
        let json = match event.as_ref() {
            MonitorEvent::InvocationStarted { summary, stats }
            | MonitorEvent::InvocationFinished { summary, stats } => {
                let row = serde_json::to_string(summary).unwrap_or_default();
                let counters = serde_json::json!({
                    "runs": stats.runs,
                    "failures": stats.failures,
                    "inFlight": stats.in_flight,
                    "p50Ms": stats.p50_ms,
                    "p95Ms": stats.p95_ms,
                })
                .to_string();
                let mut entry = String::with_capacity(row.len() * 2 + counters.len() + 16);
                entry.push_str(&row);
                entry.push_str(&counters[..counters.len() - 1]);
                entry.push_str(",\"last\":");
                entry.push_str(&row);
                entry.push('}');
                entry
            }
            MonitorEvent::LoadLine { line, .. } => serde_json::to_string(line).unwrap_or_default(),
            _ => String::new(),
        };
        let mut ring = self
            .ring
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if ring.len() == 10_000 {
            ring.pop_front();
        }
        ring.push_back(Arc::from(json));
    }
}

fn monitor() -> Monitor {
    let monitor = Monitor::new(MonitorLimits::default());
    let sink: Arc<dyn LiveSink> = RingSink::new();
    let _ = monitor.set_live_sink(sink);
    monitor
}

fn request_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    for (name, value) in [
        ("host", "127.0.0.1:5001"),
        ("user-agent", "node"),
        ("accept", "application/json"),
        ("accept-encoding", "gzip, deflate"),
        ("content-type", "application/json"),
        ("content-length", "1024"),
        ("connection", "keep-alive"),
        (
            "x-cloud-trace-context",
            "105445aa7843bc8bf206b12000100000/1;o=1",
        ),
        (
            "traceparent",
            "00-105445aa7843bc8bf206b12000100000-0000000000000001-01",
        ),
        ("x-firenook-cause-document", "orders/o_123"),
        ("x-firenook-cause-database", "(default)"),
        (
            "x-firenook-event-id",
            "6b1e2c1d-0d7a-4c6e-9a55-8f3b2a1c9d00",
        ),
    ] {
        headers.insert(
            HeaderName::from_static(name),
            HeaderValue::from_static(value),
        );
    }
    headers
}

fn start(body: Bytes, headers: HeaderMap) -> InvocationStart {
    InvocationStart {
        function_id: "us-central1-onOrderCreated".to_owned(),
        codebase: "default".to_owned(),
        kind: FunctionKind::Firestore,
        origin: InvocationOrigin::Emulator,
        cause: InvocationCause::Firestore {
            event_type: "google.cloud.firestore.document.v1.created".to_owned(),
            database: "(default)".to_owned(),
            document: "orders/o_123".to_owned(),
            event_id: Some("6b1e2c1d-0d7a-4c6e-9a55-8f3b2a1c9d00".to_owned()),
        },
        summary: "orders/o_123 created".to_owned(),
        target: InvocationTarget::Trigger,
        method: "POST".to_owned(),
        path: "/".to_owned(),
        headers,
        body,
        replay_of: None,
        delivery: None,
    }
}

fn round_trip(monitor: &Monitor, body: &Bytes, headers: &HeaderMap, answer: &HeaderMap) {
    let token = monitor.begin(start(body.clone(), headers.clone()));
    monitor.response_head(&token, 204, answer);
    black_box(monitor.finish(&token, InvocationEnd::default()));
}

/// Times `begin` alone for a 4 MiB body, finishing each one untimed.
fn large_begins(monitor: &Monitor, body: &Bytes, iterations: u64) -> Duration {
    let mut spent = Duration::ZERO;
    for _ in 0..iterations {
        let headers = HeaderMap::new();
        let started = Instant::now();
        let token = monitor.begin(start(body.clone(), headers));
        spent += started.elapsed();
        monitor.finish(&token, InvocationEnd::default());
    }
    spent
}

/// Times routing `iterations` lines, each group of 900 into a fresh
/// invocation so every line is kept (past the 1,000-line cap a line only
/// counts), finishing each invocation untimed.
fn route_lines(
    monitor: &Monitor,
    body: &Bytes,
    headers: &HeaderMap,
    structured: bool,
    iterations: u64,
) -> Duration {
    let mut spent = Duration::ZERO;
    let mut left = iterations;
    while left > 0 {
        let group = left.min(900);
        left -= group;
        let running = monitor.begin(start(body.clone(), headers.clone()));
        let line = log_line(&running.id, structured);
        let started = Instant::now();
        for _ in 0..group {
            black_box(monitor.log(&line));
        }
        spent += started.elapsed();
        monitor.finish(&running, InvocationEnd::default());
    }
    spent
}

fn log_line(execution: &str, structured: bool) -> LogEvent {
    let message = if structured {
        r#"{"severity":"INFO","message":"order accepted","orderId":"o_123","total":42}"#.to_owned()
    } else {
        "order accepted o_123".to_owned()
    };
    LogEvent::new("INFO", "functions", message)
        .with_execution(execution.to_owned())
        .with_stream(LogStream::Stdout)
}

fn benches(criterion: &mut Criterion) {
    let body = Bytes::from(vec![b'x'; 1024]);
    let headers = request_headers();
    let answer = HeaderMap::new();
    let recorder = monitor();
    criterion.bench_function("begin + head + finish (1 KiB, 12 headers)", |bench| {
        bench.iter(|| round_trip(&recorder, &body, &headers, &answer));
    });
    let large = Bytes::from(vec![b'y'; 4 * 1024 * 1024]);
    criterion.bench_function("begin (4 MiB body)", |bench| {
        bench.iter_custom(|iterations| large_begins(&recorder, &large, iterations));
    });
    for structured in [false, true] {
        let name = if structured {
            "log routing (structured)"
        } else {
            "log routing (plain)"
        };
        criterion.bench_function(name, |bench| {
            bench.iter_custom(|iterations| {
                route_lines(&recorder, &body, &headers, structured, iterations)
            });
        });
    }
}

criterion_group!(monitor_benches, benches);

/// The median time of one call over five batches of `iterations`.
fn median_per_call(iterations: u32, mut batch: impl FnMut(u32) -> Duration) -> Duration {
    let mut samples: Vec<Duration> = (0..5).map(|_| batch(iterations) / iterations).collect();
    samples.sort_unstable();
    samples[2]
}

/// Times each path again and fails the run when one breaches its budget.
fn enforce_budgets() {
    let body = Bytes::from(vec![b'x'; 1024]);
    let headers = request_headers();
    let answer = HeaderMap::new();
    let recorder = monitor();
    let mut breaches = Vec::new();
    let mut check = |name: &str, measured: Duration, budget: Duration| {
        println!("budget {name}: {measured:?} (at most {budget:?})");
        if measured > budget {
            breaches.push(format!(
                "{name} took {measured:?}, over its {budget:?} budget"
            ));
        }
    };
    let round_trips = median_per_call(20_000, |iterations| {
        let started = Instant::now();
        for _ in 0..iterations {
            round_trip(&recorder, &body, &headers, &answer);
        }
        started.elapsed()
    });
    check("begin + head + finish", round_trips, ROUND_TRIP_BUDGET);
    let large = Bytes::from(vec![b'y'; 4 * 1024 * 1024]);
    let large_begin = median_per_call(200, |iterations| {
        large_begins(&recorder, &large, u64::from(iterations))
    });
    check("begin of a 4 MiB body", large_begin, LARGE_BEGIN_BUDGET);
    for structured in [false, true] {
        let routed = median_per_call(9_000, |iterations| {
            route_lines(
                &recorder,
                &body,
                &headers,
                structured,
                u64::from(iterations),
            )
        });
        let name = if structured {
            "log routing (structured)"
        } else {
            "log routing (plain)"
        };
        check(name, routed, LOG_BUDGET);
    }
    assert!(breaches.is_empty(), "{}", breaches.join("\n"));
}

fn main() {
    monitor_benches();
    Criterion::default().configure_from_args().final_summary();
    // `cargo test --all-targets` runs this binary once as a smoke test, in an
    // unoptimized build: the budgets are for `cargo bench`, which passes
    // `--bench`.
    if std::env::args().any(|argument| argument == "--bench") {
        enforce_budgets();
    }
}
