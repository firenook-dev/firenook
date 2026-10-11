//! Which run of the engine a console is talking to.

use std::hash::{BuildHasher as _, Hasher as _};

use crate::time::rfc3339_now;

/// One engine start: a random id the console compares to tell a restart
/// from a reconnect, when it started, and the epoch its feeds' cursors
/// carry, so a cursor from a previous run is recognised as a gap.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Instance {
    /// 16 lowercase hex characters.
    pub(crate) id: String,
    /// RFC 3339.
    pub(crate) started_at: String,
    /// The low 32 bits of the id.
    pub(crate) epoch: u32,
}

impl Instance {
    /// A new run: the id hashes the start time and the process id with a
    /// per-process random key, so two runs never share one.
    pub(crate) fn new() -> Self {
        let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
        hasher.write_u32(std::process::id());
        if let Ok(elapsed) = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
            hasher.write_u128(elapsed.as_nanos());
        }
        let hash = hasher.finish();
        // Truncation keeps the low 32 bits, which is the point.
        #[allow(clippy::cast_possible_truncation)]
        let epoch = hash as u32;
        Self {
            id: format!("{hash:016x}"),
            started_at: rfc3339_now(),
            epoch,
        }
    }
}

/// A random id of `prefix` and 16 hex characters, for things the console
/// names on the fly (live connections).
pub(crate) fn random_id(prefix: char) -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
    hasher.write_u64(COUNTER.fetch_add(1, Ordering::Relaxed));
    if let Ok(elapsed) = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
        hasher.write_u128(elapsed.as_nanos());
    }
    format!("{prefix}{:016x}", hasher.finish())
}

#[cfg(test)]
mod tests {
    use time::OffsetDateTime;
    use time::format_description::well_known::Rfc3339;

    use super::*;

    #[test]
    fn every_run_has_its_own_id_and_its_epoch_is_the_ids_low_bits() {
        let first = Instance::new();
        let second = Instance::new();
        assert_ne!(first.id, second.id);
        assert_eq!(first.id.len(), 16);
        assert!(
            first
                .id
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        );
        assert_eq!(format!("{:08x}", first.epoch), first.id[8..]);
        assert!(OffsetDateTime::parse(&first.started_at, &Rfc3339).is_ok());
        let ids = (0..32)
            .map(|_| random_id('c'))
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(ids.len(), 32);
        assert!(ids.iter().all(|id| id.starts_with('c') && id.len() == 17));
    }
}
