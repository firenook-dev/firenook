//! Wall-clock `onSchedule` delivery: every discovered schedule publishes an
//! empty tick to its synthetic `firebase-schedule-*` topic on its cadence
//! (`every N minutes|hours`, `every day HH:MM` in UTC, five-field cron in UTC).

use std::time::Duration;

use time::{OffsetDateTime, Time};

use crate::functions::ScheduleDefinition;
use crate::runtime::PubsubRuntime;

/// A schedule Firenook cannot run on a clock.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScheduleError(pub String);

impl std::fmt::Display for ScheduleError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for ScheduleError {}

/// Active wall-clock scheduler tasks.
pub struct SchedulerRuntime {
    shutdown: tokio::sync::watch::Sender<bool>,
    tasks: Vec<tokio::task::JoinHandle<()>>,
}

impl SchedulerRuntime {
    pub(crate) fn start(runtime: &PubsubRuntime, schedules: &[ScheduleDefinition]) -> Self {
        let (shutdown, _) = tokio::sync::watch::channel(false);
        let mut tasks = Vec::with_capacity(schedules.len());
        for schedule in schedules {
            let cadence = match Cadence::parse(schedule) {
                Ok(cadence) => cadence,
                Err(error) => {
                    // The official emulator never runs schedules on a clock;
                    // an expression Firenook cannot evaluate keeps the manual
                    // trigger route and loses only the automatic ticks.
                    eprintln!(
                        "firenook pubsub: schedule for {} not run automatically ({error}); fire it through the Functions trigger route",
                        schedule.topic
                    );
                    continue;
                }
            };
            let runtime = runtime.clone();
            let schedule = schedule.clone();
            let mut stopped = shutdown.subscribe();
            tasks.push(tokio::spawn(async move {
                loop {
                    let delay = cadence.delay_from(OffsetDateTime::now_utc());
                    tokio::select! {
                        () = tokio::time::sleep(delay) => {
                            runtime.publish_scheduled(&schedule);
                        }
                        changed = stopped.changed() => {
                            if changed.is_err() || *stopped.borrow() {
                                break;
                            }
                        }
                    }
                }
            }));
        }
        Self { shutdown, tasks }
    }

    /// Stops every schedule without firing an extra tick.
    pub async fn shutdown(mut self) {
        self.stop().await;
    }

    pub(crate) async fn stop(&mut self) {
        let _ = self.shutdown.send(true);
        for task in std::mem::take(&mut self.tasks) {
            let _ = task.await;
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub(crate) enum Cadence {
    Interval(Duration),
    DailyUtc(Time),
    Cron(CronSpec),
}

/// A five-field cron expression evaluated in UTC (minute, hour, day of
/// month, month, day of week; `*`, lists, ranges and `/step`).
#[derive(Debug, Clone, Copy)]
pub(crate) struct CronSpec {
    minutes: u64,
    hours: u32,
    days: u32,
    months: u16,
    weekdays: u8,
}

impl CronSpec {
    pub(crate) fn parse(expression: &str) -> Option<Self> {
        let fields: Vec<&str> = expression.split_ascii_whitespace().collect();
        if fields.len() != 5 {
            return None;
        }
        Some(Self {
            minutes: Self::field(fields[0], 0, 59)?,
            hours: u32::try_from(Self::field(fields[1], 0, 23)?).ok()?,
            days: u32::try_from(Self::field(fields[2], 1, 31)?).ok()?,
            months: u16::try_from(Self::field(fields[3], 1, 12)?).ok()?,
            weekdays: u8::try_from(Self::field(fields[4], 0, 6)? & 0x7f).ok()?,
        })
    }

    /// Bit set of the allowed values of one field.
    fn field(text: &str, minimum: u64, maximum: u64) -> Option<u64> {
        let mut bits = 0_u64;
        for part in text.split(',') {
            let (range, step) = match part.split_once('/') {
                Some((range, step)) => (range, step.parse::<u64>().ok().filter(|step| *step > 0)?),
                None => (part, 1),
            };
            let (start, end) = if range == "*" {
                (minimum, maximum)
            } else if let Some((start, end)) = range.split_once('-') {
                (start.parse::<u64>().ok()?, end.parse::<u64>().ok()?)
            } else {
                let value = range.parse::<u64>().ok()?;
                (value, if step == 1 { value } else { maximum })
            };
            if start < minimum || end > maximum || start > end {
                return None;
            }
            let mut value = start;
            while value <= end {
                bits |= 1 << value;
                value += step;
            }
        }
        Some(bits)
    }

    fn matches(self, moment: OffsetDateTime) -> bool {
        let weekday = moment.weekday().number_days_from_sunday();
        self.minutes & (1 << u64::from(moment.minute())) != 0
            && self.hours & (1 << u32::from(moment.hour())) != 0
            && self.days & (1 << u32::from(moment.day())) != 0
            && self.months & (1 << u16::from(u8::from(moment.month()))) != 0
            && self.weekdays & (1 << weekday) != 0
    }

    /// The next matching minute strictly after `now`, within a year.
    pub(crate) fn next_after(self, now: OffsetDateTime) -> Option<OffsetDateTime> {
        let mut candidate =
            now.replace_second(0).ok()?.replace_nanosecond(0).ok()? + time::Duration::minutes(1);
        let limit = now + time::Duration::days(366);
        while candidate <= limit {
            if self.matches(candidate) {
                return Some(candidate);
            }
            candidate += time::Duration::minutes(1);
        }
        None
    }
}

impl Cadence {
    pub(crate) fn parse(schedule: &ScheduleDefinition) -> Result<Self, ScheduleError> {
        let words = schedule
            .expression
            .split_ascii_whitespace()
            .collect::<Vec<_>>();
        if let ["every", count, unit] = words.as_slice()
            && let Ok(count) = count.parse::<u64>()
            && count > 0
        {
            let seconds = match *unit {
                "minute" | "minutes" => count.saturating_mul(60),
                "hour" | "hours" => count.saturating_mul(3_600),
                _ => 0,
            };
            if seconds > 0 {
                return Ok(Self::Interval(Duration::from_secs(seconds)));
            }
        }
        if let ["every", "day", clock] = words.as_slice() {
            if schedule
                .time_zone
                .as_deref()
                .is_some_and(|zone| zone != "UTC" && zone != "Etc/UTC")
            {
                return Err(ScheduleError(format!(
                    "unsupported non-UTC schedule zone: {}",
                    schedule.time_zone.as_deref().unwrap_or_default()
                )));
            }
            let (hour, minute) = clock
                .split_once(':')
                .ok_or_else(|| ScheduleError("invalid daily schedule clock".to_owned()))?;
            let hour = hour
                .parse::<u8>()
                .map_err(|_| ScheduleError("invalid daily schedule hour".to_owned()))?;
            let minute = minute
                .parse::<u8>()
                .map_err(|_| ScheduleError("invalid daily schedule minute".to_owned()))?;
            return Time::from_hms(hour, minute, 0)
                .map(Self::DailyUtc)
                .map_err(|error| ScheduleError(error.to_string()));
        }
        if let Some(cron) = CronSpec::parse(&schedule.expression) {
            if schedule
                .time_zone
                .as_deref()
                .is_some_and(|zone| zone != "UTC" && zone != "Etc/UTC")
            {
                eprintln!(
                    "firenook pubsub: cron schedule {} declares time zone {}; Firenook evaluates it in UTC",
                    schedule.expression,
                    schedule.time_zone.as_deref().unwrap_or_default()
                );
            }
            return Ok(Self::Cron(cron));
        }
        Err(ScheduleError(format!(
            "unsupported Firebase schedule expression: {}",
            schedule.expression
        )))
    }

    pub(crate) fn delay_from(self, now: OffsetDateTime) -> Duration {
        match self {
            Self::Interval(duration) => duration,
            Self::Cron(cron) => cron
                .next_after(now)
                .and_then(|next| Duration::try_from(next - now).ok())
                .unwrap_or(Duration::from_hours(8784)),
            Self::DailyUtc(time) => {
                let today = now.replace_time(time);
                let next = if today > now {
                    today
                } else {
                    today + time::Duration::days(1)
                };
                Duration::try_from(next - now).unwrap_or(Duration::from_secs(1))
            }
        }
    }
}
