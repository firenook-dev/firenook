use firenook_suite_front::{ConsoleSink as _, LogInput, LogLevel, RingBudget, kinds};

use super::*;
use crate::foreign::ForeignProjects;
use crate::instance::Instance;
use crate::jobs::JobRegistry;
use crate::live::badges::BadgeBoard;
use crate::sse::Shutdown;

fn context(badges: &BadgeBoard) -> (tokio::sync::watch::Sender<bool>, SectionContext) {
    let (stop, receiver) = tokio::sync::watch::channel(false);
    let context = SectionContext {
        project: Arc::from("demo-observe"),
        shutdown: Shutdown::new(receiver),
        badges: badges.clone(),
        instance: Instance::new(),
        jobs: JobRegistry::new(),
        rings: RingBudget::new(1 << 30),
        foreign: ForeignProjects::default(),
    };
    (stop, context)
}

fn line(level: LogLevel, kind: Option<&'static str>) -> LogInput {
    LogInput {
        level,
        service: "firestore".to_owned(),
        kind,
        message: "x".to_owned(),
        ..LogInput::default()
    }
}

fn badge(board: &BadgeBoard, id: &str) -> crate::live::badges::Badge {
    board
        .snapshot()
        .badges
        .into_iter()
        .find(|badge| badge.id == id)
        .unwrap_or_else(|| panic!("{id} is published"))
}

#[tokio::test]
async fn the_badges_count_errors_and_app_denials_with_the_newest_cursor() {
    let log = ConsoleLog::with_budget(&RingBudget::new(1 << 30));
    let board = BadgeBoard::default();
    let (stop, context) = context(&board);
    spawn_badges(&log, &context);
    assert_eq!(badge(&board, "logs.errors").count, 0);
    assert_eq!(badge(&board, "firestore.denials").count, 0);
    log.accept(line(LogLevel::Error, None));
    log.accept(line(LogLevel::Warn, Some(kinds::RULES_DENIED)));
    log.accept(line(LogLevel::Info, Some(kinds::RULES_DENIED_CONSOLE)));
    log.accept(line(LogLevel::Error, Some(kinds::FUNCTION_FAILED)));
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while badge(&board, "logs.errors").count < 2 {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("the badge in time");
    let errors = badge(&board, "logs.errors");
    assert_eq!(errors.count, 2);
    assert_eq!(errors.tone, BadgeTone::Attention);
    assert_eq!(errors.kind, BadgeKind::Counter);
    let epoch = log.epoch();
    assert_eq!(errors.cursor, Some(Cursor { epoch, seq: 4 }.to_string()));
    let denials = badge(&board, "firestore.denials");
    assert_eq!(denials.count, 1, "the console's own denial is not counted");
    assert_eq!(denials.tone, BadgeTone::Neutral);
    assert_eq!(denials.cursor, Some(Cursor { epoch, seq: 2 }.to_string()));
    stop.send(true).expect("stopped");
}

#[test]
fn the_logs_summary_reads_lines_and_errors() {
    let summary = logs_summary(20_000, 3);
    assert_eq!(summary.headline, "20,000 lines · 3 errors");
    assert_eq!(summary.figures[0].value, Some(20_000));
    assert_eq!(summary.figures[1].label, "Errors since start");
    assert_eq!(logs_summary(1, 1).headline, "1 line · 1 error");
}

#[test]
fn every_observe_type_is_named_for_its_family_and_the_kinds_are_exported() {
    let out =
        std::env::temp_dir().join(format!("firenook-observe-bindings-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&out);
    export_bindings(&ts_rs::Config::new().with_out_dir(&out));
    let mut names = Vec::new();
    for entry in std::fs::read_dir(out.join("observe")).expect("generated/observe") {
        let path = entry.expect("entry").path();
        let text = std::fs::read_to_string(&path).expect("read");
        for line in text.lines() {
            if let Some(rest) = line
                .strip_prefix("export type ")
                .or_else(|| line.strip_prefix("export const "))
            {
                let name: String = rest
                    .chars()
                    .take_while(|character| character.is_alphanumeric() || *character == '_')
                    .collect();
                names.push(name);
            }
        }
    }
    let _ = std::fs::remove_dir_all(&out);
    names.sort();
    for name in &names {
        assert!(
            name.starts_with("Log") || name.starts_with("Overview") || name == "LOG_KINDS",
            "{name} does not carry its family's prefix"
        );
    }
    for expected in [
        "LOG_KINDS",
        "LogEntry",
        "LogFacetCount",
        "LogFacets",
        "LogHistogram",
        "LogKindInfo",
        "LogLevel",
        "LogLevelCounts",
        "LogPage",
        "LogTotals",
        "OverviewConnection",
        "OverviewEngineConfig",
        "OverviewEngineDetails",
        "OverviewEnvSource",
        "OverviewEnvVariable",
        "OverviewNotice",
        "OverviewNoticeLevel",
        "OverviewProblem",
        "OverviewSnapshotFile",
        "OverviewState",
    ] {
        assert!(
            names.iter().any(|name| name == expected),
            "{expected} in {names:?}"
        );
    }
    let kinds = log_kinds_module();
    assert_eq!(
        kinds.matches("{ kind: ").count(),
        firenook_suite_front::kinds::all().count()
    );
    assert!(kinds.contains("{ kind: \"rules.denied\", label: \"Rules denied\", problem: true, marker: false, internal: false },"));
}

#[test]
fn a_reset_marker_says_what_was_deleted_and_whether_it_finished() {
    let report = |section: &str, removed| ClearReport {
        section: section.to_owned(),
        removed,
    };
    let done = reset_input(
        &report("firestore", 211_260),
        Duration::from_millis(1_250),
        false,
    );
    assert_eq!(done.kind, Some(kinds::DATA_RESET));
    assert_eq!(done.level, LogLevel::Info);
    assert_eq!(done.service, "firestore");
    assert_eq!(done.audience, firenook_suite_front::Audience::Console);
    assert_eq!(
        done.message,
        "Firestore reset from the console: 211,260 documents deleted"
    );
    assert_eq!(
        done.payload,
        Some(serde_json::json!({
            "section": "firestore",
            "removed": 211_260,
            "durationMs": 1_250,
            "cancelled": false,
        }))
    );
    for (section, removed, cancelled, service, message) in [
        (
            "auth",
            1,
            false,
            "auth",
            "Authentication reset from the console: 1 user deleted",
        ),
        (
            "storage",
            3,
            true,
            "storage",
            "Storage reset from the console was cancelled after 3 objects were deleted",
        ),
        (
            "pubsub",
            1,
            true,
            "pubsub",
            "Pub/Sub reset from the console was cancelled after 1 item was deleted",
        ),
        (
            "tasks",
            0,
            true,
            "tasks",
            "Cloud Tasks reset from the console was cancelled before anything was deleted",
        ),
        (
            "extensions",
            2,
            false,
            "functions",
            "Extensions reset from the console: 2 items deleted",
        ),
    ] {
        let line = reset_input(&report(section, removed), Duration::ZERO, cancelled);
        assert_eq!(line.service, service, "{section}");
        assert_eq!(line.message, message, "{section}");
        assert_eq!(line.payload.expect("a payload")["cancelled"], cancelled);
    }
}
