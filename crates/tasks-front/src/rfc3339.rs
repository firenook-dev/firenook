//! RFC 3339 timestamps without a date library: the schedule times clients
//! send (`2030-01-01T00:00:00.000Z`, offsets included) and the one the
//! console's enqueue writes, as JavaScript's `toISOString` does.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Days from 1970-01-01 to a proleptic Gregorian date.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let month_index = (month + 9) % 12;
    let day_of_year = (153 * month_index + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// The proleptic Gregorian date `days` after 1970-01-01.
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let days = days + 719_468;
    let era = days.div_euclid(146_097);
    let day_of_era = days - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 {
        month_index + 3
    } else {
        month_index - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

fn digits(text: &str) -> Option<i64> {
    (!text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit()))
        .then(|| text.parse().ok())
        .flatten()
}

/// An RFC 3339 date-time (`T` or a space between date and time, any number
/// of fraction digits, `Z` or `±HH:MM`) as an instant; `None` when it does
/// not parse or falls before 1970.
#[must_use]
pub(crate) fn parse(text: &str) -> Option<SystemTime> {
    let text = text.trim();
    let (date, rest) = text.split_at_checked(10)?;
    let rest = rest.strip_prefix(['T', 't', ' '])?;
    let mut date_parts = date.split('-');
    let year = digits(date_parts.next()?)?;
    let month = digits(date_parts.next()?)?;
    let day = digits(date_parts.next()?)?;
    if date_parts.next().is_some() || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let (clock, offset_seconds) = if let Some(clock) = rest.strip_suffix(['Z', 'z']) {
        (clock, 0)
    } else {
        let split = rest.rfind(['+', '-'])?;
        let (clock, offset) = rest.split_at(split);
        let sign = if offset.starts_with('-') { -1 } else { 1 };
        let (hours, minutes) = offset[1..].split_once(':')?;
        let (hours, minutes) = (digits(hours)?, digits(minutes)?);
        if hours > 23 || minutes > 59 {
            return None;
        }
        (clock, sign * (hours * 3_600 + minutes * 60))
    };
    let (whole, fraction) = clock.split_once('.').unwrap_or((clock, ""));
    let mut clock_parts = whole.split(':');
    let hour = digits(clock_parts.next()?)?;
    let minute = digits(clock_parts.next()?)?;
    let second = digits(clock_parts.next()?)?;
    if clock_parts.next().is_some() || hour > 23 || minute > 59 || second > 60 {
        return None;
    }
    let nanos = if fraction.is_empty() {
        0
    } else {
        digits(fraction)?;
        let mut padded: String = fraction.chars().take(9).collect();
        while padded.len() < 9 {
            padded.push('0');
        }
        u32::try_from(digits(&padded)?).ok()?
    };
    let seconds = days_from_civil(year, month, day) * 86_400 + hour * 3_600 + minute * 60 + second
        - offset_seconds;
    let seconds = u64::try_from(seconds).ok()?;
    UNIX_EPOCH.checked_add(Duration::new(seconds, nanos))
}

/// `Date.prototype.toISOString`: UTC with milliseconds,
/// `2026-10-12T07:15:00.000Z`.
#[must_use]
pub(crate) fn format_millis(time: SystemTime) -> String {
    let since = time.duration_since(UNIX_EPOCH).unwrap_or_default();
    let seconds = i64::try_from(since.as_secs()).unwrap_or(i64::MAX);
    let (year, month, day) = civil_from_days(seconds.div_euclid(86_400));
    let of_day = seconds.rem_euclid(86_400);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        of_day / 3_600,
        of_day % 3_600 / 60,
        of_day % 60,
        since.subsec_millis()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timestamps_parse_and_format_like_javascript() {
        let at = |seconds: u64, millis: u64| {
            UNIX_EPOCH + Duration::from_secs(seconds) + Duration::from_millis(millis)
        };
        assert_eq!(parse("1970-01-01T00:00:00Z"), Some(UNIX_EPOCH));
        assert_eq!(
            parse("2030-01-01T00:00:00.000Z"),
            Some(at(1_893_456_000, 0))
        );
        assert_eq!(
            parse("2030-01-01T02:00:00.250+02:00"),
            Some(at(1_893_456_000, 250))
        );
        assert_eq!(
            parse("2029-12-31 19:30:00-04:30"),
            Some(at(1_893_456_000, 0))
        );
        assert_eq!(parse("2024-02-29T12:00:00Z"), Some(at(1_709_208_000, 0)));
        for bad in [
            "",
            "tomorrow",
            "2030-13-01T00:00:00Z",
            "2030-01-01T24:00:00Z",
            "2030-01-01",
            "1969-12-31T23:59:59Z",
            "2030-01-01T00:00:00",
        ] {
            assert_eq!(parse(bad), None, "{bad}");
        }
        assert_eq!(
            format_millis(at(1_893_456_000, 7)),
            "2030-01-01T00:00:00.007Z"
        );
        assert_eq!(
            format_millis(at(1_709_208_000, 0)),
            "2024-02-29T12:00:00.000Z"
        );
        let now = SystemTime::now();
        let round = parse(&format_millis(now)).expect("round trip");
        assert!(now.duration_since(round).unwrap_or_default() < Duration::from_millis(1));
    }
}
