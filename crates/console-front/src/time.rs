//! Times as the Console API writes them: RFC 3339, UTC.

use firenook_core_store::Timestamp;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

/// A store timestamp in RFC 3339; empty for one the calendar cannot hold.
pub(crate) fn rfc3339(value: Timestamp) -> String {
    OffsetDateTime::from_unix_timestamp(value.seconds())
        .and_then(|timestamp| timestamp.replace_nanosecond(value.nanos()))
        .ok()
        .and_then(|timestamp| timestamp.format(&Rfc3339).ok())
        .unwrap_or_default()
}

/// Now, in RFC 3339.
pub(crate) fn rfc3339_now() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn store_timestamps_are_rfc_3339() {
        let timestamp = Timestamp::new(1_700_000_000, 5_000_000).expect("valid");
        assert_eq!(rfc3339(timestamp), "2023-11-14T22:13:20.005Z");
        let now = rfc3339_now();
        assert!(OffsetDateTime::parse(&now, &Rfc3339).is_ok(), "{now}");
    }
}
