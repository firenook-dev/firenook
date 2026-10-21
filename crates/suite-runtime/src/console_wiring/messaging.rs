//! The messaging stream's part of the console: Pub/Sub and Cloud Tasks,
//! built from the running suite.
//!
//! `pubsub_ready` and `tasks_ready` hand each runtime to the console, with
//! compute's invocation record when Functions run, and give it a log sink
//! whose lines reach observe's log with the resources they are about;
//! `before_finish` stops the Pub/Sub lease and push timer.
//! The foreign projects an app names on these ports are recorded by
//! `project_scope`, which wraps both listeners; nothing here adds to that.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use firenook_console_front::{ComputeParts, Late, PubsubConsole, TasksConsole};
use firenook_functions_bridge::FunctionsInventory;
use firenook_functions_runtime::Monitor;
use firenook_pubsub_front::{LOG_PUSH, LOG_SCHEDULE, PubsubLogLine, PubsubRuntime};
use firenook_suite_front::{Audience, EntityRef, LogInput, LogLevel, LoggingRuntime, kinds};
use firenook_tasks_front::{LOG_FAILED, LogSink, TasksLogLine, TasksRuntime};

use super::{FunctionsConsoleOptions, HookContext};
use crate::{SuiteConfig, terminal};

/// Compute's invocation record, which joins each delivery, schedule run
/// and task attempt to the invocation it caused: the monitor the Functions
/// runtime records into (`start_functions_runtime` takes the same one).
///
/// `None` in a suite without Functions; the console then serves everything
/// but the deliveries routes and topic, which say Functions is not running.
fn monitor_of(compute: Option<&ComputeParts>) -> Option<Monitor> {
    compute.map(|parts| parts.monitor().clone())
}

/// A Pub/Sub line as observe's log takes it: the schedule's and the push
/// subscription's lines with their topic, subscription and function.
///
/// Neither kind ever reached the official Logging feed (a schedule's
/// problem was printed to stderr, a push failure nowhere), so both stay
/// console-only.
fn pubsub_input(line: PubsubLogLine) -> LogInput {
    let mut refs = Vec::new();
    if let Some(topic) = &line.topic {
        refs.push(EntityRef::pubsub_topic(topic));
    }
    if let Some(subscription) = &line.subscription {
        refs.push(EntityRef::pubsub_subscription(subscription));
    }
    if let Some(function_id) = &line.function_id {
        refs.push(EntityRef::pubsub_schedule(function_id));
    }
    LogInput {
        level: LogLevel::parse(line.level),
        service: "pubsub".to_owned(),
        kind: match line.kind {
            LOG_SCHEDULE => Some(kinds::PUBSUB_SCHEDULE),
            LOG_PUSH => Some(kinds::PUBSUB_PUSH),
            _ => None,
        },
        message: line.text,
        refs,
        audience: Audience::Console,
        ..LogInput::default()
    }
}

/// Says a schedule's line as the suite prints it: on stderr, exactly as
/// before; with the terminal's events on, a start-up warning (the terminal
/// lists them under `w`) before readiness and a line of the log after it.
/// The Pub/Sub runtime is built with it, so the problems found then are
/// said this way too.
pub(crate) fn print_schedule_line(line: &PubsubLogLine) {
    terminal::print(
        line.level,
        "pubsub",
        &line.text,
        &format!("firenook pubsub: {}", line.text),
    );
}

/// The Pub/Sub runtime's log sink: a schedule's line is printed as
/// [`print_schedule_line`] says it, and every line reaches the console's
/// log.
///
/// Setting a sink replays the schedule problems found when the runtime was
/// built, which it printed then; `printing` stays off during that replay
/// so the terminal shows each once.
fn pubsub_log_sink(
    logging: &LoggingRuntime,
    printing: Arc<AtomicBool>,
) -> firenook_pubsub_front::LogSink {
    let logging = logging.clone();
    Arc::new(move |line: PubsubLogLine| {
        if line.kind == LOG_SCHEDULE && printing.load(Ordering::Acquire) {
            print_schedule_line(&line);
        }
        logging.emit(pubsub_input(line));
    })
}

/// A Cloud Tasks line as observe's log takes it, with its queue and task.
/// The official record is the one `LoggingRuntime::record` always wrote
/// (same level, emulator and text).
fn tasks_input(line: TasksLogLine) -> LogInput {
    let mut refs = Vec::new();
    if let Some(parts) = &line.queue {
        refs.push(EntityRef::tasks_queue(
            &parts.project,
            &parts.location,
            &parts.queue,
        ));
        if let Some((id, _name)) = &line.task {
            refs.push(EntityRef::tasks_task(
                &parts.project,
                &parts.location,
                &parts.queue,
                &id.to_string(),
            ));
        }
    }
    LogInput {
        level: LogLevel::parse(line.level),
        service: "tasks".to_owned(),
        kind: (line.kind == LOG_FAILED).then_some(kinds::TASKS_FAILED),
        message: line.text,
        refs,
        ..LogInput::default()
    }
}

/// The Cloud Tasks runtime's log sink: the suite's printing, unchanged
/// (warnings and errors to stderr, debug lines nowhere, the rest to
/// stdout), and the line with its refs for every log.
pub(crate) fn tasks_log_sink(logging: &LoggingRuntime) -> LogSink {
    let logging = logging.clone();
    LogSink::new(move |line: TasksLogLine| {
        if line.level == "WARN" || line.level == "ERROR" {
            eprintln!("firenook tasks: {}", line.text);
        } else if line.level != "DEBUG" {
            println!("firenook tasks: {}", line.text);
        }
        logging.emit(tasks_input(line));
    })
}

/// Cloud Tasks has started: hands it to the console (`late` is the one
/// `Late` for it; compute's section holds a clone).
///
/// The runtime's log sink is replaced here by one that keeps the suite's
/// printing and adds the queue and task refs; the lines Tasks wrote while
/// it registered its queues went through the printer it was built with.
pub(crate) fn tasks_ready(
    late: &Late<TasksConsole>,
    tasks: &TasksRuntime,
    compute: Option<&ComputeParts>,
    _config: &SuiteConfig,
    logging: &LoggingRuntime,
) {
    tasks.set_log_sink(tasks_log_sink(logging));
    late.set(TasksConsole::new(
        tasks.application(),
        tasks.clone(),
        monitor_of(compute),
    ));
}

/// Pub/Sub has started: hands it to the console (`late` is the one `Late`
/// for it; compute's section holds a clone).
pub(crate) fn pubsub_ready(
    late: &Late<PubsubConsole>,
    pubsub: &PubsubRuntime,
    compute: Option<&ComputeParts>,
    _config: &SuiteConfig,
    logging: &LoggingRuntime,
) {
    let printing = Arc::new(AtomicBool::new(false));
    pubsub.set_log_sink(pubsub_log_sink(logging, printing.clone()));
    printing.store(true, Ordering::Release);
    late.set(PubsubConsole::new(
        pubsub.application(),
        pubsub.clone(),
        monitor_of(compute),
    ));
}

/// The suite's services are prepared; the console is not built yet.
pub(crate) fn prepared(_context: &HookContext<'_>) {}

/// The Functions runtime is about to start.
pub(crate) fn functions_options(
    _context: &HookContext<'_>,
    _options: &mut FunctionsConsoleOptions,
) {
}

/// Every service has started.
pub(crate) fn ready(_context: &HookContext<'_>) {}

/// The suite is stopping (see `before_finish` in `mod.rs` for the order):
/// the Pub/Sub lease and push timer stops for good, after the scheduler and
/// before background delivery drains, handing pending dead letters to
/// functions first.
pub(crate) async fn before_finish(context: &HookContext<'_>) {
    if let Some(pubsub) = context.pubsub {
        pubsub.shutdown().await;
    }
}

/// Functions reloaded and routing was refreshed for the inventory.
pub(crate) fn inventory_refreshed(_context: &HookContext<'_>, _inventory: &FunctionsInventory) {}

#[cfg(test)]
mod tests;
