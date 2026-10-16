use firenook_suite_front::{Audience, EntityRef, RingBudget};
use serde_json::json;

use super::*;
use crate::observe::fields::{LogFilter, Window};

/// A log under a budget of its own, so tests that fill rings never evict
/// each other's lines through the process's shared budget.
fn log() -> ConsoleLog {
    ConsoleLog::with_budget(&RingBudget::new(1 << 32))
}

fn line(level: LogLevel, service: &str, message: &str) -> LogInput {
    LogInput {
        level,
        service: service.to_owned(),
        message: message.to_owned(),
        ..LogInput::default()
    }
}

fn info(message: &str) -> LogInput {
    line(LogLevel::Info, "hub", message)
}

fn filter(q: &str) -> LogFilter {
    LogFilter::parse(Some(q), Window::default()).expect("a valid filter")
}

/// The messages of every kept line `q` matches, oldest first.
fn matching(log: &ConsoleLog, q: &str) -> Vec<String> {
    log.export(&filter(q))
        .iter()
        .map(|line| entry(line).message)
        .collect()
}

fn entry(line: &LogMeta) -> LogEntry {
    serde_json::from_str(&line.json).expect("a stored entry parses as a LogEntry")
}

#[test]
fn an_entry_is_serialized_once_with_its_cursor_and_every_field() {
    let log = log();
    log.accept(LogInput {
        level: LogLevel::Warn,
        service: "functions".to_owned(),
        source: Some("functions[us-central1-hello]".to_owned()),
        function: Some("us-central1-hello".to_owned()),
        codebase: Some("default".to_owned()),
        execution: Some("a3f9c1-1".to_owned()),
        kind: Some(kinds::FUNCTION_FAILED),
        message: "Cart is empty".to_owned(),
        payload: Some(json!({ "cartId": "c_19" })),
        refs: vec![EntityRef::function("us-central1-hello")],
        audience: Audience::Console,
        ..LogInput::default()
    });
    let lines = log.lines(false);
    assert_eq!(lines.len(), 1);
    let stored = entry(&lines[0]);
    assert_eq!(
        stored.cursor,
        Cursor {
            epoch: log.epoch(),
            seq: 1
        }
        .to_string()
    );
    assert!(
        OffsetDateTime::parse(&stored.time, &time::format_description::well_known::Rfc3339).is_ok()
    );
    assert_eq!(
        stored.time.len(),
        "2026-10-12T04:06:09.126Z".len(),
        "{}",
        stored.time
    );
    assert_eq!(
        stored,
        LogEntry {
            cursor: stored.cursor.clone(),
            time: stored.time.clone(),
            level: LogLevel::Warn,
            service: "functions".to_owned(),
            source: Some("functions[us-central1-hello]".to_owned()),
            function: Some("us-central1-hello".to_owned()),
            extension: None,
            codebase: Some("default".to_owned()),
            execution: Some("a3f9c1-1".to_owned()),
            kind: Some("function.failed".to_owned()),
            message: "Cart is empty".to_owned(),
            payload: Some(json!({ "cartId": "c_19" })),
            refs: vec![EntityRef::function("us-central1-hello")],
            truncated: false,
        }
    );
    // Optional fields are left out, not written as null.
    log.accept(info("plain"));
    let plain = &log.lines(false)[1].json;
    assert!(!plain.contains("null"), "{plain}");
    assert!(!plain.contains("refs"), "{plain}");
    assert!(!plain.contains("truncated"), "{plain}");
    assert!(lines[0].flags.problem);
}

#[test]
fn cursors_are_contiguous_and_carry_the_epoch() {
    let log = log();
    for index in 0..5 {
        log.accept(info(&format!("line {index}")));
    }
    let cursors: Vec<Cursor> = log
        .lines(false)
        .iter()
        .map(|line| entry(line).cursor.parse().expect("a cursor"))
        .collect();
    assert_eq!(
        cursors.iter().map(|cursor| cursor.seq).collect::<Vec<_>>(),
        [1, 2, 3, 4, 5]
    );
    assert!(cursors.iter().all(|cursor| cursor.epoch == log.epoch()));
    assert_eq!(log.tail(), cursors[4]);
    // Another log is another epoch.
    assert_ne!(
        ConsoleLog::with_budget(&RingBudget::new(1 << 20)).epoch(),
        log.epoch()
    );
}

#[test]
fn the_ring_keeps_at_most_its_entries_and_its_bytes() {
    let log = log();
    for index in 0..CONSOLE_LOG_ENTRIES + 10 {
        log.accept(info(&format!("{index}")));
    }
    assert_eq!(log.lines(false).len(), CONSOLE_LOG_ENTRIES);
    assert_eq!(log.lines(false)[0].seq, 11);
    // 8 KiB messages: the byte cap evicts long before the entry cap.
    let big = log_with_big_lines(4_000);
    let kept = big.lines(false);
    assert!(kept.len() < 4_000 && kept.len() > 500, "{}", kept.len());
    assert!(
        big.main.bytes() <= CONSOLE_LOG_BYTES,
        "{}",
        big.main.bytes()
    );
    // Each line counts its JSON, its search text and the slot overhead.
    let weight = |line: &Arc<LogMeta>| line.json.len() + line.text.len() + SLOT_OVERHEAD;
    assert_eq!(big.main.bytes(), kept.iter().map(weight).sum::<usize>());
    assert!(big.main.bytes() + weight(&kept[0]) > CONSOLE_LOG_BYTES);
}

fn log_with_big_lines(count: usize) -> ConsoleLog {
    let log = log();
    for index in 0..count {
        log.accept(info(&format!("{index:05} {}", "x".repeat(8 * 1024))));
    }
    log
}

#[test]
fn a_long_message_is_cut_at_a_character_boundary_and_marked() {
    let log = log();
    // Three bytes per character, so the cap falls inside one.
    let message = "火".repeat(CONSOLE_MESSAGE_BYTES / 3 + 10);
    log.accept(info(&message));
    let stored = entry(&log.lines(false)[0]);
    assert!(stored.truncated);
    assert!(stored.message.len() <= CONSOLE_MESSAGE_BYTES);
    assert!(stored.message.len() > CONSOLE_MESSAGE_BYTES - 3);
    assert!(stored.message.chars().all(|character| character == '火'));
}

#[test]
fn a_large_payload_is_elided_and_a_scalar_one_is_wrapped() {
    let log = log();
    let mut large = info("large");
    large.payload = Some(json!({ "blob": "y".repeat(CONSOLE_PAYLOAD_BYTES) }));
    log.accept(large);
    let mut scalar = info("scalar");
    scalar.payload = Some(json!([1, 2]));
    log.accept(scalar);
    let lines = log.lines(false);
    let elided = entry(&lines[0]);
    assert!(elided.truncated);
    let size = elided.payload.expect("a payload")["firenookElided"]
        .as_u64()
        .expect("the size");
    assert_eq!(
        usize::try_from(size).expect("size"),
        CONSOLE_PAYLOAD_BYTES + "{\"blob\":\"\"}".len()
    );
    assert_eq!(entry(&lines[1]).payload, Some(json!({ "value": [1, 2] })));
    assert!(!entry(&lines[1]).truncated);
}

#[test]
fn a_label_past_its_limit_omits_the_line_with_a_notice() {
    let log = log();
    let mut oversized = info("secret");
    oversized.function = Some("f".repeat(65));
    log.accept(oversized);
    let stored = entry(&log.lines(false)[0]);
    assert_eq!(stored.level, LogLevel::Warn);
    assert_eq!(stored.service, "hub");
    assert!(
        stored.message.contains("longer than 64 bytes"),
        "{}",
        stored.message
    );
    assert!(!stored.message.contains("secret"));
}

#[test]
fn every_filter_key_matches_alone_and_negated() {
    let log = log();
    log.accept(line(LogLevel::Debug, "functions", "debugging"));
    log.accept(LogInput {
        function: Some("us-central1-hello".to_owned()),
        codebase: Some("default".to_owned()),
        execution: Some("x1-1".to_owned()),
        ..line(LogLevel::Info, "functions", "hello ran")
    });
    log.accept(LogInput {
        function: Some("ext-resize-generate".to_owned()),
        extension: Some("resize".to_owned()),
        ..line(LogLevel::Warn, "functions", "resize slow")
    });
    log.accept(LogInput {
        kind: Some(kinds::RULES_DENIED),
        ..line(LogLevel::Warn, "firestore", "Rules denied get on users/u_1")
    });
    log.accept(LogInput {
        kind: Some(kinds::FUNCTION_FAILED),
        function: Some("us-central1-hello".to_owned()),
        ..line(LogLevel::Error, "functions", "hello failed")
    });
    log.accept(line(LogLevel::Info, "pubsub", "published"));
    log.accept(LogInput {
        kind: Some(kinds::ENGINE_READY),
        ..line(LogLevel::Info, "hub", "All emulators ready")
    });
    log.accept(LogInput {
        kind: Some(kinds::FUNCTIONS_RECEIPT),
        ..line(LogLevel::Debug, "functions", "Functions host ready")
    });

    assert_eq!(matching(&log, "level:error"), ["hello failed"]);
    assert_eq!(
        matching(&log, "level:warn level:error"),
        [
            "resize slow",
            "Rules denied get on users/u_1",
            "hello failed"
        ]
    );
    assert_eq!(
        matching(&log, "-level:info -level:warn"),
        ["debugging", "hello failed"]
    );
    assert_eq!(matching(&log, "service:pubsub"), ["published"]);
    assert_eq!(
        matching(&log, "-service:functions -service:firestore"),
        ["published", "All emulators ready"]
    );
    assert_eq!(
        matching(&log, "function:us-central1-hello"),
        ["hello ran", "hello failed"]
    );
    assert_eq!(
        matching(&log, "function:us-central1-*"),
        ["hello ran", "hello failed"]
    );
    assert_eq!(
        matching(&log, "-function:us-central1-hello service:functions"),
        ["debugging", "resize slow"]
    );
    assert_eq!(matching(&log, "instance:resize"), ["resize slow"]);
    assert_eq!(matching(&log, "codebase:default"), ["hello ran"]);
    assert_eq!(matching(&log, "execution:x1-1"), ["hello ran"]);
    assert_eq!(
        matching(&log, "kind:rules.denied"),
        ["Rules denied get on users/u_1"]
    );
    assert_eq!(matching(&log, "kind:function.*"), ["hello failed"]);
    assert_eq!(
        matching(&log, "is:problem"),
        ["Rules denied get on users/u_1", "hello failed"]
    );
    assert_eq!(matching(&log, "is:marker"), ["All emulators ready"]);
    assert_eq!(
        matching(&log, "-is:marker level:info"),
        ["hello ran", "published"]
    );
    // Engine internals are left out unless the filter asks for them.
    assert!(!matching(&log, "").contains(&"Functions host ready".to_owned()));
    assert_eq!(matching(&log, "is:internal"), ["Functions host ready"]);
    assert_eq!(
        matching(&log, "kind:functions.receipt"),
        ["Functions host ready"]
    );
    assert_eq!(matching(&log, "").len(), 7);
}

#[test]
fn words_phrases_and_regexes_search_every_text_field() {
    let log = log();
    log.accept(LogInput {
        source: Some("functions[us-central1-checkout]".to_owned()),
        payload: Some(json!({ "order": { "id": "O_77" } })),
        ..line(LogLevel::Info, "functions", "Order Placed")
    });
    log.accept(info("heartbeat ok"));
    log.accept(info("heartbeat failed"));
    log.accept(info("Request timed out"));
    assert_eq!(matching(&log, "order"), ["Order Placed"]);
    assert_eq!(
        matching(&log, "checkout"),
        ["Order Placed"],
        "the source is searched"
    );
    assert_eq!(
        matching(&log, "o_77"),
        ["Order Placed"],
        "payload values are searched"
    );
    assert_eq!(matching(&log, "\"heartbeat ok\""), ["heartbeat ok"]);
    assert_eq!(
        matching(&log, "-\"heartbeat ok\""),
        ["Order Placed", "heartbeat failed", "Request timed out"]
    );
    assert_eq!(
        matching(&log, "heartbeat failed"),
        ["heartbeat failed"],
        "every word must occur"
    );
    // A regex is case-sensitive unless it ends with i: no smart case.
    assert_eq!(matching(&log, "/timed? out/"), ["Request timed out"]);
    assert_eq!(matching(&log, "/request/"), Vec::<String>::new());
    assert_eq!(matching(&log, "/request/i"), ["Request timed out"]);
    assert_eq!(
        matching(&log, "-/^heartbeat/"),
        ["Order Placed", "Request timed out"]
    );
}

#[test]
fn payload_terms_compare_json_test_presence_and_keep_the_fields_case() {
    let log = log();
    let with = |message: &str, payload: serde_json::Value| LogInput {
        payload: Some(payload),
        ..info(message)
    };
    log.accept(with(
        "one",
        json!({ "orderId": "o_1", "count": 3, "items": [] }),
    ));
    log.accept(with(
        "two",
        json!({ "orderId": "o_2", "count": 12, "user": { "name": "ada" } }),
    ));
    log.accept(with(
        "nested",
        json!({ "items": [{ "sku": "s1" }], "count": "7" }),
    ));
    log.accept(info("none"));
    assert_eq!(matching(&log, "payload.orderId:o_1"), ["one"]);
    assert_eq!(
        matching(&log, "payload.orderid:o_1"),
        Vec::<String>::new(),
        "the field name keeps its case"
    );
    assert_eq!(matching(&log, "payload.count:3"), ["one"]);
    assert_eq!(
        matching(&log, "payload.count:7"),
        ["nested"],
        "a string equal to the text"
    );
    assert_eq!(matching(&log, "payload.items:[]"), ["one"]);
    assert_eq!(matching(&log, "payload.items.0.sku:s1"), ["nested"]);
    assert_eq!(matching(&log, "payload.user.name:*"), ["two"]);
    assert_eq!(matching(&log, "-payload.orderId:*"), ["nested", "none"]);
    assert_eq!(
        matching(&log, "-payload.orderId:o_1"),
        ["two", "nested", "none"]
    );
    assert_eq!(matching(&log, "payload.count:>5"), ["two", "nested"]);
    assert!(filter("payload.count:>5").reads_payload());
}

#[test]
fn the_time_window_keeps_lines_recorded_inside_it() {
    let log = log();
    log.accept(info("early"));
    let lines = log.lines(false);
    let at = lines[0].time_ms;
    let inside = LogFilter::parse(
        None,
        Window {
            from_ms: Some(at),
            to_ms: Some(at),
        },
    )
    .expect("filter");
    let after = LogFilter::parse(
        None,
        Window {
            from_ms: Some(at + 1),
            to_ms: None,
        },
    )
    .expect("filter");
    assert_eq!(log.export(&inside).len(), 1);
    assert_eq!(log.export(&after).len(), 0);
}

#[test]
fn pages_read_backwards_forwards_and_around_a_line() {
    let log = log();
    for index in 1..=10 {
        let level = if index % 2 == 0 {
            LogLevel::Warn
        } else {
            LogLevel::Info
        };
        log.accept(line(level, "hub", &format!("line {index}")));
    }
    let messages = |slice: &LogSlice| {
        slice
            .lines
            .iter()
            .map(|line| entry(line).message)
            .collect::<Vec<_>>()
    };
    let all = filter("");
    let newest = log.page(&all, None, 3);
    assert_eq!(messages(&newest), ["line 8", "line 9", "line 10"]);
    assert!(newest.has_older);
    assert!(!newest.has_newer);
    assert_eq!(newest.tail, 10);
    let older = log.page(&all, Some(8), 3);
    assert_eq!(messages(&older), ["line 5", "line 6", "line 7"]);
    assert!(older.has_older && older.has_newer);
    let oldest = log.page(&all, Some(3), 5);
    assert_eq!(messages(&oldest), ["line 1", "line 2"]);
    assert!(!oldest.has_older);

    let warnings = filter("level:warn");
    let forward = log.forward(&warnings, 3, 2);
    assert_eq!(messages(&forward), ["line 4", "line 6"]);
    assert!(forward.has_older && forward.has_newer);
    let end = log.forward(&warnings, 8, 5);
    assert_eq!(messages(&end), ["line 10"]);
    assert!(!end.has_newer);

    // The anchor is included whatever the filter says.
    let around = log.around(&warnings, 5, 1);
    assert_eq!(messages(&around), ["line 4", "line 5", "line 6"]);
    assert_eq!(around.anchor, Some(5));
    assert!(around.has_older && around.has_newer);
    let gone = log.around(&warnings, 99, 1);
    assert_eq!(gone.anchor, None);
    assert_eq!(messages(&gone), ["line 10"]);
}

#[test]
fn facets_count_each_dimension_without_its_own_terms() {
    let log = log();
    log.accept(line(LogLevel::Info, "functions", "a"));
    log.accept(line(LogLevel::Error, "functions", "b"));
    log.accept(line(LogLevel::Error, "pubsub", "c"));
    log.accept(line(LogLevel::Warn, "auth", "d"));
    log.accept(LogInput {
        kind: Some(kinds::FUNCTIONS_RECEIPT),
        ..line(LogLevel::Debug, "functions", "receipt")
    });
    let facets = log.facets(&filter("level:error service:functions"));
    assert_eq!(facets.matched, 1);
    assert_eq!(facets.kept, 5);
    // Levels are counted over service:functions alone (the receipt is an
    // internal line the filter leaves out) ...
    assert_eq!(facets.levels, [0, 1, 0, 1]);
    // ... and services over level:error alone.
    assert_eq!(
        facets.services,
        [("functions".to_owned(), 1), ("pubsub".to_owned(), 1)]
    );
    assert_eq!(facets.internal_hidden, 0, "the receipt is not an error");
    let everything = log.facets(&filter(""));
    assert_eq!(everything.matched, 4);
    assert_eq!(everything.internal_hidden, 1);
    assert_eq!(everything.services[0], ("functions".to_owned(), 2));
    let internals = log.facets(&filter("is:internal"));
    assert_eq!(internals.internal_hidden, 0);
    assert_eq!(internals.kinds, [("functions.receipt".to_owned(), 1)]);
}

#[test]
fn totals_are_monotonic_across_eviction() {
    let log = log();
    log.accept(line(LogLevel::Error, "hub", "first error"));
    log.accept(LogInput {
        kind: Some(kinds::RULES_DENIED),
        ..line(LogLevel::Warn, "firestore", "denied")
    });
    log.accept(LogInput {
        kind: Some(kinds::RULES_DENIED_CONSOLE),
        ..line(LogLevel::Info, "firestore", "denied from the console")
    });
    for index in 0..CONSOLE_LOG_ENTRIES {
        log.accept(info(&format!("{index}")));
    }
    let totals = log.totals();
    assert_eq!(
        totals.entries,
        u64::try_from(CONSOLE_LOG_ENTRIES).expect("fits") + 3
    );
    assert_eq!(totals.levels.error, 1);
    assert_eq!(totals.levels.warn, 1);
    assert_eq!(totals.problems, 2);
    assert_eq!(totals.denials, 1, "console denials do not count");
    assert_eq!(totals.newest_error, Some(1));
    assert_eq!(totals.newest_denial, Some(2));
    assert_eq!(totals.levels.total(), totals.entries);
}

#[test]
fn problems_outlive_a_flood() {
    let log = log();
    log.accept(LogInput {
        kind: Some(kinds::FUNCTIONS_RELOADED),
        ..info("Functions reloaded")
    });
    for index in 0..3 {
        log.accept(line(
            LogLevel::Error,
            "functions",
            &format!("error {index}"),
        ));
    }
    for index in 0..25_000 {
        log.accept(info(&format!("noise {index}")));
    }
    assert!(
        log.lines(false)
            .iter()
            .all(|line| line.level == LogLevel::Info)
    );
    let errors = filter("level:error");
    assert!(errors.problems_only());
    let page = log.page(&errors, None, 500);
    assert_eq!(
        page.lines
            .iter()
            .map(|line| entry(line).message)
            .collect::<Vec<_>>(),
        ["error 0", "error 1", "error 2"]
    );
    assert!(!page.has_older);
    assert_eq!(log.facets(&errors).matched, 3);
    assert_eq!(
        log.facets(&errors).kept,
        u64::try_from(CONSOLE_LOG_ENTRIES).expect("fits") + 3
    );
    assert_eq!(matching(&log, "is:problem").len(), 3);
    assert_eq!(
        log.histogram(&errors, 10, now_millis())
            .buckets
            .iter()
            .map(|bucket| bucket.error)
            .sum::<u64>(),
        3
    );
    // The Overview's recent problems read the problem ring alone.
    assert_eq!(
        log.recent_problems(8)
            .iter()
            .map(|line| entry(line).message)
            .collect::<Vec<_>>(),
        ["error 2", "error 1", "error 0"]
    );
    // The reload marker left both rings; its time is still known.
    assert_eq!(log.get(1).map(|line| line.seq), None);
    assert_eq!(log.last_reload().map(|(seq, _)| seq), Some(1));
    // A line from the problem ring is found by its own cursor.
    assert_eq!(
        log.get(2).map(|line| entry(&line).message).as_deref(),
        Some("error 0")
    );
}

#[test]
fn the_histogram_counts_matching_lines_per_bucket() {
    let log = log();
    log.accept(line(LogLevel::Warn, "hub", "w"));
    log.accept(line(LogLevel::Error, "hub", "e"));
    let at = log.lines(false)[0].time_ms;
    let histogram = log.histogram(&filter(""), 4, at + 4_000);
    assert_eq!(histogram.from_ms, at);
    assert_eq!(histogram.to_ms, at + 4_000);
    assert_eq!(histogram.bucket_ms, 1_000);
    assert_eq!(histogram.buckets.len(), 4);
    assert_eq!(histogram.buckets[0].warn + histogram.buckets[1].warn, 1);
    let errors = log.histogram(&filter("level:error"), 4, at + 4_000);
    assert_eq!(
        errors.buckets.iter().map(|bucket| bucket.warn).sum::<u64>(),
        0
    );
}

#[test]
fn both_rings_are_in_the_memory_report() {
    let budget = RingBudget::new(1 << 30);
    let log = ConsoleLog::with_budget(&budget);
    log.accept(line(LogLevel::Error, "hub", "problem"));
    let report = budget.report();
    let names: Vec<&str> = report.iter().map(|ring| ring.name.as_str()).collect();
    assert_eq!(names, ["logs", "logs.problems"]);
    assert_eq!(report[0].entries, 1);
    assert_eq!(report[1].entries, 1);
    assert!(budget.used() > 0);
}

#[test]
fn times_have_exactly_three_fraction_digits() {
    let time = OffsetDateTime::from_unix_timestamp(1_760_241_969).expect("time");
    assert_eq!(format_time(time), "2025-10-12T04:06:09.000Z");
    assert_eq!(format_millis(1_760_241_969_126), "2025-10-12T04:06:09.126Z");
}

#[test]
fn the_minute_volume_counts_the_last_hour_and_zeroes_idle_minutes() {
    let log = log();
    log.accept(line(LogLevel::Error, "hub", "e"));
    log.accept(line(LogLevel::Info, "hub", "i"));
    let now = log.lines(false)[0].time_ms;
    let hour = log.hour(now);
    assert_eq!(hour[59].error, 1);
    assert_eq!(hour[59].info, 1);
    assert_eq!(hour.iter().map(LogLevelCounts::total).sum::<u64>(), 2);
    // Half an hour later the minute has moved back; an hour later it is gone.
    assert_eq!(log.hour(now + 30 * 60_000)[29].total(), 2);
    assert_eq!(
        log.hour(now + 61 * 60_000)
            .iter()
            .map(LogLevelCounts::total)
            .sum::<u64>(),
        0
    );
}
