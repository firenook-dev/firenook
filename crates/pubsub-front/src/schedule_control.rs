//! The scheduler as other parts of the suite use it: one schedule per
//! `onSchedule` function, keyed by the function's region-qualified id.
//!
//! Two regions' functions of one name each keep their own clock, pause and
//! runs, while both publish to the one synthetic topic the clock uses,
//! `firebase-schedule-<name>`, so a tick of either reaches both functions.
//! The console's Pub/Sub › Schedules page and the Functions section's
//! schedule card and Run now both go through [`ScheduleControl`], so neither
//! reaches into the scheduler's internals.

use time::OffsetDateTime;

/// What other console sections may ask of the scheduler.
///
/// The console holds it as `Arc<dyn ScheduleControl>` and calls it from
/// request handlers, so every method is synchronous and answers from memory
/// without waiting on I/O.
pub trait ScheduleControl: Send + Sync + 'static {
    /// The function's schedule as the scheduler sees it, or `None` when the
    /// function has no schedule (or no function has that id).
    fn schedule(&self, function_id: &str) -> Option<ScheduleView>;

    /// Publishes one tick now, exactly as the clock does: the same message
    /// to the same topic, so it reaches every function listening on it. It
    /// works while the schedule is paused and records a
    /// [`RunTrigger::Console`] run.
    ///
    /// Fails with [`RunScheduleError::NotScheduled`] for an unknown id,
    /// [`RunScheduleError::BackgroundPaused`] while background triggers are
    /// paused (nothing is published), and [`RunScheduleError::Publish`] when
    /// the broker refuses the message.
    fn run(&self, function_id: &str) -> Result<RunOutcome, RunScheduleError>;

    /// Pauses or resumes the clock for that function only; other functions
    /// sharing its topic keep their own clocks. While paused the clock keeps
    /// its phase and publishes nothing; [`ScheduleControl::run`] still works.
    ///
    /// Fails with [`RunScheduleError::NotScheduled`] for an unknown id.
    fn set_paused(&self, function_id: &str, paused: bool) -> Result<(), RunScheduleError>;
}

/// One function's schedule, as [`ScheduleControl::schedule`] reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScheduleView {
    /// The region-qualified Functions id the scheduler is keyed by.
    pub function_id: String,
    /// The exported function name.
    pub function_name: String,
    /// The function's region.
    pub region: String,
    /// The full name of the topic the clock publishes to,
    /// `projects/<project>/topics/firebase-schedule-<name>`.
    pub topic: String,
    /// Ids of the other functions (one name, other regions) whose schedules
    /// publish to the same topic, so each of their ticks reaches this one too.
    pub shares_topic_with: Vec<String>,
    /// The schedule expression as the function declares it.
    pub expression: String,
    /// The IANA time zone the function declares, if any.
    pub time_zone: Option<String>,
    /// The zone the scheduler evaluates the expression in: the declared one,
    /// or `UTC` when none is declared. Intervals (`every N minutes`) do not
    /// depend on it.
    pub evaluated_in: String,
    /// Whether the clock runs it. An expression the scheduler cannot
    /// evaluate runs only through [`ScheduleControl::run`].
    pub automatic: bool,
    /// Why the clock does not run it, in the scheduler's words, when
    /// `automatic` is false.
    pub problem: Option<String>,
    /// Paused with [`ScheduleControl::set_paused`].
    pub paused: bool,
    /// When the clock next ticks (a paused schedule publishes nothing then);
    /// `None` when the schedule is not automatic.
    pub next_run_at: Option<OffsetDateTime>,
    /// Runs since the engine started, from the clock and the console.
    pub runs: u64,
    /// The newest run, if any.
    pub last_run: Option<ScheduleRun>,
}

/// One run of a schedule, from the clock or the console.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScheduleRun {
    /// When it ran.
    pub at: OffsetDateTime,
    /// What started it.
    pub trigger: RunTrigger,
    /// The published message's id; `None` when nothing was published.
    pub message_id: Option<String>,
    /// Why nothing was published (background triggers paused, or the broker
    /// refused the tick); `None` when it was published.
    pub skipped: Option<String>,
}

/// What started a run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RunTrigger {
    /// The schedule's clock.
    Clock,
    /// [`ScheduleControl::run`]: Pub/Sub › Schedules or the Functions
    /// section's Run now.
    Console,
}

impl RunTrigger {
    /// `clock` or `console`, as the console API spells it.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Clock => "clock",
            Self::Console => "console",
        }
    }
}

/// A tick [`ScheduleControl::run`] published.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunOutcome {
    /// The published message's id on the schedule's topic.
    pub message_id: String,
}

/// Why the scheduler refused a request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunScheduleError {
    /// No function with that id has a schedule.
    NotScheduled,
    /// Background triggers are paused, so the tick was not published.
    BackgroundPaused,
    /// The broker refused the tick, with its message.
    Publish(String),
}

impl std::fmt::Display for RunScheduleError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotScheduled => formatter.write_str("No scheduled function has this id."),
            Self::BackgroundPaused => formatter
                .write_str("Background triggers are paused, so the tick was not published."),
            Self::Publish(message) => write!(formatter, "The tick was not published: {message}"),
        }
    }
}

impl std::error::Error for RunScheduleError {}

// The console shares the scheduler between sections as `Arc<dyn ScheduleControl>`.
const _: fn(&dyn ScheduleControl) = |_| {};

/// The runtime's scheduler: `Arc::new(runtime.clone())` is the console's
/// `Arc<dyn ScheduleControl>`.
impl ScheduleControl for crate::runtime::PubsubRuntime {
    fn schedule(&self, function_id: &str) -> Option<ScheduleView> {
        self.schedule_view(function_id)
    }

    fn run(&self, function_id: &str) -> Result<RunOutcome, RunScheduleError> {
        self.run_schedule(function_id)
    }

    fn set_paused(&self, function_id: &str, paused: bool) -> Result<(), RunScheduleError> {
        self.set_schedule_paused(function_id, paused)
    }
}
