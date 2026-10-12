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
