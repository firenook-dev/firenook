//! Wall-clock `onSchedule` delivery: every discovered schedule publishes an
//! empty tick to its synthetic `firebase-schedule-*` topic on its cadence.
//!
//! Cadences: `every N minutes|mins|hours`, the same within a daily window
//! (`every 2 hours from 10:00 to 14:00`, `every 15 mins synchronized`),
//! `every day HH:MM`, `every monday 09:00`, `every mon,wed,fri 09:00`, and
//! five-field cron. Clock times and cron fields are civil times in the
//! schedule's declared zone (UTC when none is declared), evaluated with the
//! IANA time-zone database the engine bundles, so a machine without
//! `/usr/share/zoneinfo` runs `Europe/Paris` at the same instants as any
//! other. A civil time a daylight-saving change skips runs right after the
//! gap; one it repeats runs once, at its first occurrence.
//!
//! The scheduler is keyed by function id: [`ScheduleBook`] keeps each
//! schedule's cadence, pause flag, next tick and runs, and survives codebase
//! reloads, so an unchanged schedule keeps its next tick (its phase) across
//! one.

use std::collections::{BTreeMap, VecDeque};
use std::time::Duration;

use time::{Date, OffsetDateTime, PrimitiveDateTime, Time, UtcOffset};

use crate::functions::{ScheduleDefinition, topic_resource};
use crate::runtime::PubsubRuntime;
use crate::schedule_control::{ScheduleRun, ScheduleView};

/// Runs kept besides the first: the newest nineteen.
const LATEST_RUNS: usize = 19;
/// Upcoming ticks a schedule's detail lists.
const UPCOMING: usize = 5;

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
    /// One clock task per automatic schedule of `function_ids`.
    pub(crate) fn start(runtime: &PubsubRuntime, function_ids: Vec<String>) -> Self {
        let (shutdown, _) = tokio::sync::watch::channel(false);
        let mut tasks = Vec::with_capacity(function_ids.len());
        let Ok(handle) = tokio::runtime::Handle::try_current() else {
            return Self { shutdown, tasks };
        };
        for function_id in function_ids {
            let runtime = runtime.clone();
            let mut stopped = shutdown.subscribe();
            tasks.push(handle.spawn(async move {
                // `None`: the schedule left the inventory or cannot run on a clock.
                while let Some(due) = runtime.schedule_due(&function_id) {
                    let delay = Duration::try_from(due - OffsetDateTime::now_utc())
                        .unwrap_or(Duration::ZERO);
                    tokio::select! {
                        () = tokio::time::sleep(delay) => {
                            runtime.clock_tick(&function_id, due);
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

// ------------------------------------------------------------------ zones

/// The zone a schedule's clock times and cron fields are civil times in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Zone {
    Utc,
    /// A zone with one offset all year (`Etc/GMT-5` is five hours east).
    Fixed(UtcOffset),
    /// A zone of the bundled IANA database, with its daylight-saving rules.
    Tz(jiff::tz::TimeZone),
}

impl Zone {
    /// The zone a schedule declares: UTC when it declares none.
    pub(crate) fn resolve(name: Option<&str>) -> Result<Self, String> {
        let Some(name) = name.map(str::trim).filter(|name| !name.is_empty()) else {
            return Ok(Self::Utc);
        };
        let bare = name.strip_prefix("Etc/").unwrap_or(name);
        if matches!(
            bare,
            "UTC" | "UCT" | "GMT" | "GMT0" | "GMT+0" | "GMT-0" | "Greenwich" | "Universal" | "Zulu"
        ) {
            return Ok(Self::Utc);
        }
        // `Etc/GMT+5` is five hours west of Greenwich: the POSIX sign.
        if name.starts_with("Etc/GMT")
            && let Some(hours) = bare
                .strip_prefix("GMT")
                .and_then(|hours| hours.parse::<i8>().ok())
            && (-14..=12).contains(&hours)
            && let Ok(offset) = UtcOffset::from_hms(-hours, 0, 0)
        {
            return Ok(Self::Fixed(offset));
        }
        jiff::tz::TimeZone::get(name)
            .map(Self::Tz)
            .map_err(|_| format!("time zone {name} is not in this engine's time-zone database"))
    }

    /// The civil time in this zone at `instant`.
    fn civil(&self, instant: OffsetDateTime) -> PrimitiveDateTime {
        let offset = match self {
            Self::Utc => UtcOffset::UTC,
            Self::Fixed(offset) => *offset,
            Self::Tz(zone) => {
                if let Some(civil) = jiff::Timestamp::new(
                    instant.unix_timestamp(),
                    i32::try_from(instant.nanosecond()).unwrap_or(0),
                )
                .ok()
                .and_then(|timestamp| from_jiff(zone.to_datetime(timestamp)))
                {
                    return civil;
                }
                // Outside the database's range (never for a real clock):
                // the instant's own UTC civil time.
                UtcOffset::UTC
            }
        };
        let local = instant.to_offset(offset);
        PrimitiveDateTime::new(local.date(), local.time())
    }

    /// The instant a civil time in this zone names. A time a transition
    /// skips resolves forward by the gap and a repeated one to its earlier
    /// instant (jiff's compatible disambiguation); a zone with one offset
    /// has neither.
    fn instant(&self, civil: PrimitiveDateTime) -> OffsetDateTime {
        let offset = match self {
            Self::Utc => UtcOffset::UTC,
            Self::Fixed(offset) => *offset,
            Self::Tz(zone) => {
                if let Some(instant) = to_jiff(civil)
                    .and_then(|civil| zone.to_ambiguous_timestamp(civil).compatible().ok())
                    .and_then(|timestamp| {
                        OffsetDateTime::from_unix_timestamp(timestamp.as_second()).ok()
                    })
                {
                    return instant;
                }
                UtcOffset::UTC
            }
        };
        civil.assume_offset(offset).to_offset(UtcOffset::UTC)
    }
}

/// A civil time from jiff's calendar to the `time` crate's.
fn from_jiff(civil: jiff::civil::DateTime) -> Option<PrimitiveDateTime> {
    let month = time::Month::try_from(u8::try_from(civil.month()).ok()?).ok()?;
    let date = Date::from_calendar_date(
        i32::from(civil.year()),
        month,
        u8::try_from(civil.day()).ok()?,
    )
    .ok()?;
    let time = Time::from_hms(
        u8::try_from(civil.hour()).ok()?,
        u8::try_from(civil.minute()).ok()?,
        u8::try_from(civil.second()).ok()?,
    )
    .ok()?;
    Some(PrimitiveDateTime::new(date, time))
}

/// A civil time from the `time` crate's calendar to jiff's (to the second;
/// schedules never name a fraction).
fn to_jiff(civil: PrimitiveDateTime) -> Option<jiff::civil::DateTime> {
    jiff::civil::DateTime::new(
        i16::try_from(civil.year()).ok()?,
        i8::try_from(u8::from(civil.month())).ok()?,
        i8::try_from(civil.day()).ok()?,
        i8::try_from(civil.hour()).ok()?,
        i8::try_from(civil.minute()).ok()?,
        i8::try_from(civil.second()).ok()?,
        0,
    )
    .ok()
}

// ---------------------------------------------------------------- cadence

/// How a schedule's clock ticks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Cadence {
    /// `every N minutes|hours`: from when the clock starts, independent of
    /// zones.
    Interval(Duration),
    /// At one civil time on the weekdays set (bit `n` = `n` days after
    /// Sunday): `every day 03:00`, `every monday 09:00`.
    Weekly {
        weekdays: u8,
        time: Time,
        zone: Zone,
    },
    /// Every `every` from `from` up to `to` each day (past midnight when
    /// `to` is earlier): `every 2 hours from 10:00 to 14:00`.
    Window {
        every: time::Duration,
        from: Time,
        to: Time,
        zone: Zone,
    },
    Cron {
        spec: CronSpec,
        zone: Zone,
    },
}

/// A five-field cron expression (minute, hour, day of month, month, day of
/// week; `*`, lists, ranges, `/step`, month and weekday names, `7` for
/// Sunday). When both day fields are restricted a day matching either runs,
/// as cron has it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct CronSpec {
    minutes: u64,
    hours: u32,
    days: u32,
    months: u16,
    weekdays: u8,
    any_day: bool,
    any_weekday: bool,
}

const MONTHS: [&str; 12] = [
    "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
];
const WEEKDAYS: [&str; 7] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const WEEKDAY_NAMES: [&str; 7] = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
];

impl CronSpec {
    pub(crate) fn parse(expression: &str) -> Option<Self> {
        let fields: Vec<&str> = expression.split_ascii_whitespace().collect();
        if fields.len() != 5 {
            return None;
        }
        let weekdays = Self::field(fields[4], 0, 7, &WEEKDAYS)?;
        // `7` is Sunday too.
        let weekdays = (weekdays & 0x7f) | u64::from(weekdays & (1 << 7) != 0);
        Some(Self {
            minutes: Self::field(fields[0], 0, 59, &[])?,
            hours: u32::try_from(Self::field(fields[1], 0, 23, &[])?).ok()?,
            days: u32::try_from(Self::field(fields[2], 1, 31, &[])?).ok()?,
            months: u16::try_from(Self::field(fields[3], 1, 12, &MONTHS)?).ok()?,
            weekdays: u8::try_from(weekdays).ok()?,
            any_day: fields[2] == "*" || fields[2] == "?",
            any_weekday: fields[4] == "*" || fields[4] == "?",
        })
    }

    /// One value of a field: a number, or a name (`names[0]` is the field's
    /// minimum when it has names: `sun` is 0, `jan` 1).
    fn value(text: &str, minimum: u64, names: &[&str]) -> Option<u64> {
        if let Ok(value) = text.parse::<u64>() {
            return Some(value);
        }
        let lower = text.to_ascii_lowercase();
        names
            .iter()
            .position(|name| *name == lower)
            .and_then(|position| u64::try_from(position).ok())
            .map(|position| position + minimum)
    }

    /// Bit set of the allowed values of one field.
    fn field(text: &str, minimum: u64, maximum: u64, names: &[&str]) -> Option<u64> {
        let mut bits = 0_u64;
        for part in text.split(',') {
            let (range, step) = match part.split_once('/') {
                Some((range, step)) => (range, step.parse::<u64>().ok().filter(|step| *step > 0)?),
                None => (part, 1),
            };
            let (start, end) = if range == "*" || range == "?" {
                (minimum, maximum)
            } else if let Some((start, end)) = range.split_once('-') {
                (
                    Self::value(start, minimum, names)?,
                    Self::value(end, minimum, names)?,
                )
            } else {
                let value = Self::value(range, minimum, names)?;
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

    fn matches(self, civil: PrimitiveDateTime) -> bool {
        let weekday = civil.weekday().number_days_from_sunday();
        let day = self.days & (1 << u32::from(civil.day())) != 0;
        let weekday = self.weekdays & (1 << weekday) != 0;
        let day_matches = match (self.any_day, self.any_weekday) {
            (true, true) => true,
            (false, true) => day,
            (true, false) => weekday,
            (false, false) => day || weekday,
        };
        self.minutes & (1 << u64::from(civil.minute())) != 0
            && self.hours & (1 << u32::from(civil.hour())) != 0
            && self.months & (1 << u16::from(u8::from(civil.month()))) != 0
            && day_matches
    }

    /// The next matching minute strictly after `now` in `zone`, within a
    /// year.
    pub(crate) fn next_after(self, now: OffsetDateTime, zone: &Zone) -> Option<OffsetDateTime> {
        let start = zone.civil(now);
        let mut candidate =
            start.replace_second(0).ok()?.replace_nanosecond(0).ok()? + time::Duration::minutes(1);
        let limit = start + time::Duration::days(366);
        while candidate <= limit {
            if self.matches(candidate) {
                let instant = zone.instant(candidate);
                if instant > now {
                    return Some(instant);
                }
            }
            candidate += time::Duration::minutes(1);
        }
        None
    }
}

/// `HH:MM`, 24-hour.
fn clock(text: &str) -> Result<Time, ScheduleError> {
    let invalid = || ScheduleError(format!("invalid schedule time of day: {text}"));
    let (hour, minute) = text.split_once(':').ok_or_else(invalid)?;
    let hour = hour.parse::<u8>().map_err(|_| invalid())?;
    let minute = minute.parse::<u8>().map_err(|_| invalid())?;
    if minute > 59 || hour > 23 || text.len() > 5 {
        return Err(invalid());
    }
    Time::from_hms(hour, minute, 0).map_err(|_| invalid())
}

/// `N minutes|mins|hours` as a duration.
fn period(count: &str, unit: &str) -> Option<Duration> {
    let count = count.parse::<u64>().ok().filter(|count| *count > 0)?;
    let seconds = match unit {
        "minute" | "minutes" | "min" | "mins" => count.checked_mul(60)?,
        "hour" | "hours" => count.checked_mul(3_600)?,
        _ => return None,
    };
    Some(Duration::from_secs(seconds))
}

/// A comma-separated weekday list (`mon,wed,fri`, `monday`) as a bit set.
fn weekday_set(text: &str) -> Option<u8> {
    let mut bits = 0_u8;
    for part in text.split(',') {
        let lower = part.to_ascii_lowercase();
        let day = WEEKDAYS
            .iter()
            .position(|name| *name == lower)
            .or_else(|| WEEKDAY_NAMES.iter().position(|name| *name == lower))?;
        bits |= 1 << day;
    }
    Some(bits)
}

impl Cadence {
    pub(crate) fn parse(schedule: &ScheduleDefinition) -> Result<Self, ScheduleError> {
        Self::parse_expression(&schedule.expression, schedule.time_zone.as_deref())
    }

    pub(crate) fn parse_expression(
        expression: &str,
        time_zone: Option<&str>,
    ) -> Result<Self, ScheduleError> {
        let words = expression.split_ascii_whitespace().collect::<Vec<_>>();
        let zone = || Zone::resolve(time_zone).map_err(ScheduleError);
        match words.as_slice() {
            ["every", count, unit] if period(count, unit).is_some() => {
                return Ok(Self::Interval(period(count, unit).unwrap_or_default()));
            }
            ["every", count, unit, "from", from, "to", to] => {
                if let Some(every) = period(count, unit) {
                    return Ok(Self::Window {
                        every: time::Duration::try_from(every).unwrap_or(time::Duration::HOUR),
                        from: clock(from)?,
                        to: clock(to)?,
                        zone: zone()?,
                    });
                }
            }
            ["every", count, unit, "synchronized"] => {
                if let Some(every) = period(count, unit) {
                    return Ok(Self::Window {
                        every: time::Duration::try_from(every).unwrap_or(time::Duration::HOUR),
                        from: Time::MIDNIGHT,
                        to: Time::from_hms(23, 59, 0).unwrap_or(Time::MIDNIGHT),
                        zone: zone()?,
                    });
                }
            }
            ["every", "day", time] => {
                return Ok(Self::Weekly {
                    weekdays: 0x7f,
                    time: clock(time)?,
                    zone: zone()?,
                });
            }
            ["every", days, time] if weekday_set(days).is_some() => {
                return Ok(Self::Weekly {
                    weekdays: weekday_set(days).unwrap_or_default(),
                    time: clock(time)?,
                    zone: zone()?,
                });
            }
            _ => {}
        }
        if let Some(spec) = CronSpec::parse(expression) {
            return Ok(Self::Cron {
                spec,
                zone: zone()?,
            });
        }
        Err(ScheduleError(format!(
            "unsupported Firebase schedule expression: {expression}"
        )))
    }

    /// The tick after `now`; `None` when the cadence never ticks again
    /// within a year (a cron for the 31st of February).
    pub(crate) fn next_after(&self, now: OffsetDateTime) -> Option<OffsetDateTime> {
        match self {
            Self::Interval(duration) => Some(now + *duration),
            Self::Cron { spec, zone } => spec.next_after(now, zone),
            Self::Weekly {
                weekdays,
                time,
                zone,
            } => {
                let mut date = zone.civil(now).date();
                for _ in 0..8 {
                    if weekdays & (1 << date.weekday().number_days_from_sunday()) != 0 {
                        let instant = zone.instant(PrimitiveDateTime::new(date, *time));
                        if instant > now {
                            return Some(instant);
                        }
                    }
                    date = date.next_day()?;
                }
                None
            }
            Self::Window {
                every,
                from,
                to,
                zone,
            } => {
                // A window that runs past midnight may have started yesterday.
                let mut date = zone.civil(now).date().previous_day()?;
                for _ in 0..3 {
                    if let Some(next) = window_next(date, *every, *from, *to, zone, now) {
                        return Some(next);
                    }
                    date = date.next_day()?;
                }
                None
            }
        }
    }
}

/// The first tick after `now` of the window that starts on `date`.
fn window_next(
    date: Date,
    every: time::Duration,
    from: Time,
    to: Time,
    zone: &Zone,
    now: OffsetDateTime,
) -> Option<OffsetDateTime> {
    let start = PrimitiveDateTime::new(date, from);
    let end = if to >= from {
        PrimitiveDateTime::new(date, to)
    } else {
        PrimitiveDateTime::new(date.next_day()?, to)
    };
    let mut candidate = start;
    while candidate <= end {
        let instant = zone.instant(candidate);
        if instant > now {
            return Some(instant);
        }
        candidate += every;
    }
    None
}

// ------------------------------------------------------------------- book

/// One schedule's state, kept across codebase reloads by function id.
#[derive(Debug)]
pub(crate) struct ScheduleEntry {
    pub(crate) definition: ScheduleDefinition,
    pub(crate) cadence: Result<Cadence, String>,
    pub(crate) paused: bool,
    /// When the clock next ticks; written by the clock before it sleeps.
    pub(crate) next_at: Option<OffsetDateTime>,
    pub(crate) runs: u64,
    pub(crate) first_run: Option<ScheduleRun>,
    /// The newest runs after the first, oldest first.
    pub(crate) latest: VecDeque<ScheduleRun>,
    pub(crate) omitted: u64,
    /// The book revision at which this schedule last changed.
    pub(crate) stamp: u64,
}

impl ScheduleEntry {
    fn new(definition: ScheduleDefinition) -> Self {
        let cadence = Cadence::parse(&definition).map_err(|error| error.0);
        Self {
            definition,
            cadence,
            paused: false,
            next_at: None,
            runs: 0,
            first_run: None,
            latest: VecDeque::new(),
            omitted: 0,
            stamp: 0,
        }
    }

    fn record(&mut self, run: ScheduleRun) {
        self.runs += 1;
        if self.first_run.is_none() {
            self.first_run = Some(run);
            return;
        }
        self.latest.push_back(run);
        if self.latest.len() > LATEST_RUNS {
            self.latest.pop_front();
            self.omitted += 1;
        }
    }

    fn forget_runs(&mut self) {
        self.runs = 0;
        self.first_run = None;
        self.latest.clear();
        self.omitted = 0;
    }

    fn last_run(&self) -> Option<&ScheduleRun> {
        self.latest.back().or(self.first_run.as_ref())
    }
}

/// One schedule as the console shows it (a scheduled function's Schedule
/// tab): the view plus its upcoming ticks and its kept runs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScheduleDetail {
    pub view: ScheduleView,
    /// The next five ticks (a paused schedule publishes nothing at them);
    /// empty when the schedule is not automatic.
    pub upcoming: Vec<OffsetDateTime>,
    /// The first run since start, kept for good.
    pub first_run: Option<ScheduleRun>,
    /// The nineteen latest runs after the first, newest first.
    pub last_runs: Vec<ScheduleRun>,
    /// Runs between the first and the kept latest.
    pub omitted_runs: u64,
}

/// The schedules that changed since a revision.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScheduleChanges {
    /// The book's revision now.
    pub revision: u64,
    /// Schedules stamped after the revision asked about.
    pub changed: Vec<ScheduleView>,
    /// A schedule left the inventory since then, so a view must refetch.
    pub removed: bool,
}

/// Every schedule's state, keyed by function id.
#[derive(Debug, Default)]
pub(crate) struct ScheduleBook {
    pub(crate) entries: BTreeMap<String, ScheduleEntry>,
    pub(crate) revision: u64,
    removed_at: u64,
}

impl ScheduleBook {
    fn bump(&mut self) -> u64 {
        self.revision += 1;
        self.revision
    }

    /// Takes a new inventory's schedules. An unchanged schedule keeps
    /// everything, its next tick included; a changed one keeps its pause
    /// flag and runs and starts its clock afresh; a schedule that left is
    /// forgotten. Returns the schedules whose problem is new.
    pub(crate) fn reconcile(
        &mut self,
        definitions: Vec<ScheduleDefinition>,
    ) -> Vec<(String, String)> {
        let revision = self.bump();
        let mut problems = Vec::new();
        let mut kept = BTreeMap::new();
        for definition in definitions {
            let id = definition.function_id.clone();
            let entry = match self.entries.remove(&id) {
                Some(entry) if entry.definition == definition => entry,
                Some(mut entry) => {
                    let fresh = ScheduleEntry::new(definition);
                    if let Err(problem) = &fresh.cadence
                        && entry.cadence.as_ref().err() != Some(problem)
                    {
                        problems.push((id.clone(), problem.clone()));
                    }
                    entry.definition = fresh.definition;
                    entry.cadence = fresh.cadence;
                    entry.next_at = None;
                    entry.stamp = revision;
                    entry
                }
                None => {
                    let mut entry = ScheduleEntry::new(definition);
                    if let Err(problem) = &entry.cadence {
                        problems.push((id.clone(), problem.clone()));
                    }
                    entry.stamp = revision;
                    entry
                }
            };
            kept.insert(id, entry);
        }
        if !self.entries.is_empty() {
            self.removed_at = revision;
        }
        self.entries = kept;
        problems
    }

    /// The next tick of an automatic schedule, computed and stored when the
    /// clock has none yet.
    pub(crate) fn due(&mut self, function_id: &str, now: OffsetDateTime) -> Option<OffsetDateTime> {
        let entry = self.entries.get_mut(function_id)?;
        let cadence = entry.cadence.as_ref().ok()?.clone();
        if let Some(next) = entry.next_at {
            return Some(next);
        }
        let next = cadence.next_after(now)?;
        entry.next_at = Some(next);
        let revision = self.bump();
        if let Some(entry) = self.entries.get_mut(function_id) {
            entry.stamp = revision;
        }
        Some(next)
    }

    /// The clock reached `due`: moves the next tick on (past `now` when the
    /// process slept through ticks) and says whether to publish (`None`:
    /// paused, gone, or not this tick).
    pub(crate) fn advance(
        &mut self,
        function_id: &str,
        due: OffsetDateTime,
        now: OffsetDateTime,
    ) -> Option<ScheduleDefinition> {
        let revision = self.bump();
        let entry = self.entries.get_mut(function_id)?;
        if entry.next_at != Some(due) {
            return None;
        }
        let cadence = entry.cadence.as_ref().ok()?.clone();
        let next = cadence
            .next_after(due)
            .filter(|next| *next > now)
            .or_else(|| cadence.next_after(now));
        entry.next_at = next;
        entry.stamp = revision;
        (!entry.paused).then(|| entry.definition.clone())
    }

    pub(crate) fn record(&mut self, function_id: &str, run: ScheduleRun) {
        let revision = self.bump();
        if let Some(entry) = self.entries.get_mut(function_id) {
            entry.record(run);
            entry.stamp = revision;
        }
    }

    pub(crate) fn set_paused(&mut self, function_id: &str, paused: bool) -> bool {
        let revision = self.bump();
        let Some(entry) = self.entries.get_mut(function_id) else {
            return false;
        };
        if entry.paused != paused {
            entry.paused = paused;
            entry.stamp = revision;
        }
        true
    }

    /// Forgets every run (the console's clear); pause flags and the clocks'
    /// next ticks stay.
    pub(crate) fn forget_runs(&mut self) {
        let revision = self.bump();
        for entry in self.entries.values_mut() {
            entry.forget_runs();
            entry.stamp = revision;
        }
    }

    /// Every schedule that cannot run on a clock, with the reason.
    pub(crate) fn problems(&self) -> Vec<(String, String)> {
        self.entries
            .iter()
            .filter_map(|(id, entry)| {
                entry
                    .cadence
                    .as_ref()
                    .err()
                    .map(|problem| (id.clone(), problem.clone()))
            })
            .collect()
    }

    /// The ids of the schedules a clock runs.
    pub(crate) fn automatic(&self) -> Vec<String> {
        self.entries
            .iter()
            .filter(|(_, entry)| entry.cadence.is_ok())
            .map(|(id, _)| id.clone())
            .collect()
    }

    pub(crate) fn view(&self, function_id: &str) -> Option<ScheduleView> {
        let entry = self.entries.get(function_id)?;
        let definition = &entry.definition;
        let topic = topic_resource(&definition.project, &definition.topic);
        let shares_topic_with = self
            .entries
            .iter()
            .filter(|(id, other)| {
                id.as_str() != function_id
                    && other.definition.project == definition.project
                    && other.definition.topic == definition.topic
            })
            .map(|(id, _)| id.clone())
            .collect();
        Some(ScheduleView {
            function_id: function_id.to_owned(),
            function_name: definition.function_name.clone(),
            region: definition.region.clone(),
            topic,
            shares_topic_with,
            expression: definition.expression.clone(),
            time_zone: definition.time_zone.clone(),
            evaluated_in: definition
                .time_zone
                .clone()
                .filter(|zone| !zone.trim().is_empty())
                .unwrap_or_else(|| "UTC".to_owned()),
            automatic: entry.cadence.is_ok(),
            problem: entry.cadence.as_ref().err().cloned(),
            paused: entry.paused,
            next_run_at: entry.next_at.filter(|_| entry.cadence.is_ok()),
            runs: entry.runs,
            last_run: entry.last_run().cloned(),
        })
    }

    pub(crate) fn detail(&self, function_id: &str) -> Option<ScheduleDetail> {
        let view = self.view(function_id)?;
        let entry = self.entries.get(function_id)?;
        let mut upcoming = Vec::with_capacity(UPCOMING);
        if let (Ok(cadence), Some(next)) = (entry.cadence.as_ref(), entry.next_at) {
            let mut at = next;
            upcoming.push(at);
            while upcoming.len() < UPCOMING {
                let Some(following) = cadence.next_after(at) else {
                    break;
                };
                at = following;
                upcoming.push(at);
            }
        }
        Some(ScheduleDetail {
            view,
            upcoming,
            first_run: entry.first_run.clone(),
            last_runs: entry.latest.iter().rev().cloned().collect(),
            omitted_runs: entry.omitted,
        })
    }

    pub(crate) fn changes_since(&self, revision: u64) -> ScheduleChanges {
        ScheduleChanges {
            revision: self.revision,
            changed: self
                .entries
                .iter()
                .filter(|(_, entry)| entry.stamp > revision)
                .filter_map(|(id, _)| self.view(id))
                .collect(),
            removed: self.removed_at > revision,
        }
    }
}
