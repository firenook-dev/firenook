//! The user index: what the console needs of every account to filter,
//! count, order and show it, kept beside the emulator's own maps so that no
//! console read touches the records.
//!
//! One index per scope (the project's users, each tenant's). Every structure
//! is an `im` persistent structure, so [`UserIndex::snapshot`] is a handful of
//! reference-count increments under the data lock, and every query then runs
//! on the snapshot outside it. Upkeep is incremental: a change removes the
//! account's old entries and inserts the new ones, O(log n), and a change
//! that alters nothing the console shows (a token refresh only moves
//! `lastRefreshAt`) touches nothing at all.

use std::cmp::Ordering;
#[cfg(test)]
use std::collections::BTreeMap;
use std::collections::{BTreeSet, HashMap};
use std::fmt;
use std::ops::Bound;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering as AtomicOrdering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use im::{HashMap as ImHashMap, OrdMap, OrdSet, Vector};
use serde_json::{Map as JsonMap, Value as JsonValue};

use super::filter::{
    ClaimMatch, IdMatch, TextTerm, TimeTerm, UserFilter, UserHas, UserState, digits, json_equal,
    phone_word,
};
use super::{
    BatchUser, CLAIM_SAMPLES, ClaimKey, ClaimKeys, ConsoleError, CursorKey, DEFAULT_PAGE_SIZE,
    MAX_BATCH_USERS, MAX_CLAIM_KEYS, MAX_PAGE_SIZE, ProviderCount, SortDirection, UserColumn,
    UserCursor, UserFacets, UserRow, UserSort, UsersBatch, UsersBatchQuery, UsersPage, UsersQuery,
    millis_field,
};
use crate::state::{UserRecord, provider_infos};
use crate::util::{str_field, truthy, truthy_str};

/// The uid prefix of sample users (`is:sample`).
pub(crate) const SAMPLE_PREFIX: &str = "sample-";
/// Pinned match lists kept per scope.
const PIN_CAPACITY: usize = 8;
/// A pin unused this long is dropped.
const PIN_IDLE: Duration = Duration::from_secs(120);

const DISABLED: u16 = 1;
const VERIFIED: u16 = 1 << 1;
const EMAIL: u16 = 1 << 2;
const PHONE: u16 = 1 << 3;
const PASSWORD: u16 = 1 << 4;
const PHOTO: u16 = 1 << 5;
const NAME: u16 = 1 << 6;
const ANONYMOUS: u16 = 1 << 7;
const CUSTOM_AUTH: u16 = 1 << 8;
const SAMPLE: u16 = 1 << 9;

// ---------------------------------------------------------------- digests

/// One account as the console sees it.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct UserDigest {
    uid: Arc<str>,
    email: Option<Arc<str>>,
    /// The email lower-cased, the `email` order's key (the same allocation
    /// when the stored email already is).
    email_key: Option<Arc<str>>,
    phone: Option<Box<str>>,
    /// The phone's digits, the `phone` order's key and what phone terms match.
    phone_digits: Option<Arc<str>>,
    display_name: Option<Box<str>>,
    /// The display name lower-cased, the `name` order's key.
    name_key: Option<Arc<str>>,
    photo_url: Option<Box<str>>,
    /// Email, phone digits, uid and display name, lower-cased, '\n'-joined:
    /// what words match.
    haystack: Box<str>,
    created_at: Option<i64>,
    last_sign_in_at: Option<i64>,
    flags: u16,
    mfa: u8,
    /// Interned provider ids, in link order.
    providers: Box<[u32]>,
    /// Interned top-level claim keys, sorted by key.
    claim_keys: Box<[u32]>,
    /// The stored claims text, when it holds at least one key: what claim
    /// value terms and the claim key samples read.
    claims: Option<Arc<str>>,
}

impl UserDigest {
    const fn has(&self, flag: u16) -> bool {
        self.flags & flag != 0
    }

    fn value(&self, column: UserColumn) -> Option<SortValue> {
        match column {
            UserColumn::Created => self.created_at.map(SortValue::Time),
            UserColumn::SignedIn => self.last_sign_in_at.map(SortValue::Time),
            UserColumn::Email => self.email_key.clone().map(SortValue::Text),
            UserColumn::Name => self.name_key.clone().map(SortValue::Text),
            UserColumn::Phone => self.phone_digits.clone().map(SortValue::Text),
            UserColumn::Uid => Some(SortValue::Text(self.uid.clone())),
        }
    }

    /// The parsed claims, for claim value terms.
    fn parsed_claims(&self) -> Option<JsonMap<String, JsonValue>> {
        match serde_json::from_str::<JsonValue>(self.claims.as_deref()?).ok()? {
            JsonValue::Object(map) => Some(map),
            _ => None,
        }
    }
}

/// Provider ids and claim keys, interned per scope so a digest holds `u32`s.
/// Ids are never reused, so a pinned or cached id keeps its meaning.
#[derive(Clone, Default)]
struct Interner {
    names: Vector<Arc<str>>,
    ids: ImHashMap<Arc<str>, u32>,
}

impl Interner {
    fn intern(&mut self, name: &str) -> u32 {
        if let Some(id) = self.ids.get(name) {
            return *id;
        }
        let id = u32::try_from(self.names.len()).unwrap_or(u32::MAX);
        let name: Arc<str> = Arc::from(name);
        self.names.push_back(name.clone());
        self.ids.insert(name, id);
        id
    }

    fn id(&self, name: &str) -> Option<u32> {
        self.ids.get(name).copied()
    }

    fn name(&self, id: u32) -> &str {
        self.names.get(slot_index(id)).map_or("", |name| name)
    }

    fn len(&self) -> usize {
        self.names.len()
    }

    /// Ids whose names start with `prefix`.
    fn with_prefix(&self, prefix: &str) -> Vec<u32> {
        self.names
            .iter()
            .enumerate()
            .filter(|(_, name)| name.starts_with(prefix))
            .filter_map(|(id, _)| u32::try_from(id).ok())
            .collect()
    }
}

/// The facet counts every user contributes to, kept as users change.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct Counters {
    disabled: u64,
    unverified: u64,
    anonymous: u64,
    custom_token: u64,
    sample: u64,
    mfa: u64,
    claims: u64,
    never_signed_in: u64,
}

impl Counters {
    fn apply(&mut self, digest: &UserDigest, add: bool) {
        let bump = |counter: &mut u64, applies: bool| {
            if applies {
                *counter = if add {
                    counter.saturating_add(1)
                } else {
                    counter.saturating_sub(1)
                };
            }
        };
        bump(&mut self.disabled, digest.has(DISABLED));
        bump(
            &mut self.unverified,
            digest.has(EMAIL) && !digest.has(VERIFIED),
        );
        bump(&mut self.anonymous, digest.has(ANONYMOUS));
        bump(&mut self.custom_token, digest.has(CUSTOM_AUTH));
        bump(&mut self.sample, digest.has(SAMPLE));
        bump(&mut self.mfa, digest.mfa > 0);
        bump(&mut self.claims, !digest.claim_keys.is_empty());
        bump(&mut self.never_signed_in, digest.last_sign_in_at.is_none());
    }
}

// ---------------------------------------------------------------- the index

/// Everything a snapshot shares with the live index.
#[derive(Clone, Default)]
struct IndexData {
    /// Slot → digest; a freed slot is reused.
    slots: Vector<Option<Arc<UserDigest>>>,
    /// uid → slot; also the uid order.
    by_uid: OrdMap<Arc<str>, u32>,
    created: OrdSet<(i64, u32)>,
    signed_in: OrdSet<(i64, u32)>,
    email: OrdSet<(Arc<str>, u32)>,
    name: OrdSet<(Arc<str>, u32)>,
    phone: OrdSet<(Arc<str>, u32)>,
    /// Slots whose key for that order is absent: they sort last both ways.
    created_null: OrdSet<u32>,
    signed_in_null: OrdSet<u32>,
    email_null: OrdSet<u32>,
    name_null: OrdSet<u32>,
    phone_null: OrdSet<u32>,
    counters: Counters,
    /// Users per provider id.
    provider_counts: ImHashMap<u32, u32>,
    /// Users per claim key.
    claim_counts: ImHashMap<u32, u32>,
    providers: Interner,
    claim_names: Interner,
    /// Moves on every digest change.
    generation: u64,
    /// Moves only when some user's custom claims change.
    claims_generation: u64,
}

/// What lives beside the index and its snapshots without being part of the
/// data: the pinned match lists and the claim keys cache.
#[derive(Default)]
struct Shared {
    pins: Mutex<PinCache>,
    claim_keys: Mutex<Option<(u64, Arc<ClaimKeys>)>>,
    /// Full passes over the digests, so tests can prove a pin is scanned once.
    scans: AtomicUsize,
    /// Claim key computations, so tests can prove the cache holds.
    claim_scans: AtomicUsize,
}

/// The index of one scope, owned by its `ProjectState`.
pub(crate) struct UserIndex {
    data: IndexData,
    free: Vec<u32>,
    shared: Arc<Shared>,
}

impl Default for UserIndex {
    fn default() -> Self {
        Self {
            data: IndexData::default(),
            free: Vec::new(),
            shared: Arc::new(Shared::default()),
        }
    }
}

impl fmt::Debug for UserIndex {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("UserIndex")
            .field("users", &self.data.by_uid.len())
            .field("generation", &self.data.generation)
            .finish_non_exhaustive()
    }
}

impl UserIndex {
    /// An index of `users`, built from scratch (state load, rebuilds).
    pub(crate) fn build<'a, R: std::borrow::Borrow<UserRecord> + 'a>(
        users: impl IntoIterator<Item = (&'a String, &'a R)>,
    ) -> Self {
        let mut index = Self::default();
        for (local_id, record) in users {
            index.upsert(local_id, record.borrow());
        }
        index
    }

    /// An O(1) point-in-time copy for reads outside the data lock.
    pub(crate) fn snapshot(&self) -> IndexSnapshot {
        IndexSnapshot {
            data: self.data.clone(),
            shared: self.shared.clone(),
        }
    }

    /// Brings the account's digest up to date with `record`.
    pub(crate) fn upsert(&mut self, local_id: &str, record: &UserRecord) {
        let slot = self.data.by_uid.get(local_id).copied();
        let previous = slot.and_then(|slot| self.data.digest(slot).cloned());
        let digest = self
            .data
            .build_digest(local_id, record, previous.as_deref());
        if previous.as_deref() == Some(&digest) {
            return;
        }
        let claims_changed = previous
            .as_deref()
            .map_or(digest.claims.is_some(), |previous| {
                previous.claims != digest.claims || previous.claim_keys != digest.claim_keys
            });
        if let (Some(slot), Some(previous)) = (slot, previous) {
            self.data.replace(slot, &previous, Arc::new(digest));
        } else {
            let slot = self.free.pop().unwrap_or_else(|| {
                let slot = u32::try_from(self.data.slots.len()).unwrap_or(u32::MAX);
                self.data.slots.push_back(None);
                slot
            });
            self.data.link(slot, Arc::new(digest));
        }
        self.data.generation = self.data.generation.wrapping_add(1);
        if claims_changed {
            self.data.claims_generation = self.data.claims_generation.wrapping_add(1);
        }
    }

    /// Drops the account.
    pub(crate) fn remove(&mut self, local_id: &str) {
        let Some(slot) = self.data.by_uid.get(local_id).copied() else {
            return;
        };
        let Some(previous) = self.data.digest(slot).cloned() else {
            return;
        };
        self.data.unlink(slot, &previous);
        self.data.slots.set(slot_index(slot), None);
        self.free.push(slot);
        self.data.generation = self.data.generation.wrapping_add(1);
        if previous.claims.is_some() {
            self.data.claims_generation = self.data.claims_generation.wrapping_add(1);
        }
    }

    /// Drops every account (`deleteAllAccounts`).
    pub(crate) fn clear(&mut self) {
        let generation = self.data.generation.wrapping_add(1);
        let claims_generation = self.data.claims_generation.wrapping_add(1);
        self.data = IndexData {
            generation,
            claims_generation,
            ..IndexData::default()
        };
        self.free.clear();
    }
}

impl IndexData {
    fn digest(&self, slot: u32) -> Option<&Arc<UserDigest>> {
        self.slots.get(slot_index(slot)).and_then(Option::as_ref)
    }

    /// The digest of `record`, reusing what an unchanged previous digest
    /// already holds (the parsed claim keys above all).
    fn build_digest(
        &mut self,
        local_id: &str,
        record: &UserRecord,
        previous: Option<&UserDigest>,
    ) -> UserDigest {
        let uid: Arc<str> = previous
            .filter(|previous| &*previous.uid == local_id)
            .map_or_else(|| Arc::from(local_id), |previous| previous.uid.clone());
        let email = truthy_str(record, "email").map(|email| {
            previous
                .and_then(|previous| previous.email.clone())
                .filter(|kept| &**kept == email)
                .unwrap_or_else(|| Arc::from(email))
        });
        let email_key = email.as_ref().map(|email| {
            if email.chars().any(char::is_uppercase) {
                Arc::from(email.to_lowercase())
            } else {
                email.clone()
            }
        });
        let phone = truthy_str(record, "phoneNumber");
        let phone_digits = phone
            .map(digits)
            .filter(|digits| !digits.is_empty())
            .map(|digits| {
                previous
                    .and_then(|previous| previous.phone_digits.clone())
                    .filter(|kept| **kept == *digits)
                    .unwrap_or_else(|| Arc::from(digits))
            });
        let display_name = truthy_str(record, "displayName");
        let name_key = display_name.map(|name| {
            let lower = name.to_lowercase();
            previous
                .and_then(|previous| previous.name_key.clone())
                .filter(|kept| **kept == *lower)
                .unwrap_or_else(|| Arc::from(lower))
        });
        let photo_url = truthy_str(record, "photoUrl");
        // A sign-in changes none of the searched fields: keep the haystack.
        let haystack = match previous {
            Some(previous)
                if &*previous.uid == local_id
                    && previous.email_key == email_key
                    && previous.phone_digits == phone_digits
                    && previous.name_key == name_key =>
            {
                previous.haystack.clone()
            }
            _ => format!(
                "{}\n{}\n{}\n{}",
                email_key.as_deref().unwrap_or_default(),
                phone_digits.as_deref().unwrap_or_default(),
                local_id.to_lowercase(),
                name_key.as_deref().unwrap_or_default(),
            )
            .into_boxed_str(),
        };

        let mut providers: Vec<u32> = Vec::new();
        for info in provider_infos(record) {
            if let Some(provider) = str_field(&info, "providerId") {
                let id = self.providers.intern(provider);
                if !providers.contains(&id) {
                    providers.push(id);
                }
            }
        }

        let claims_text = truthy_str(record, "customAttributes");
        let (claim_keys, claims) = match previous {
            Some(previous)
                if previous.claims.as_deref() == claims_text
                    && (claims_text.is_some() || previous.claim_keys.is_empty()) =>
            {
                (previous.claim_keys.clone(), previous.claims.clone())
            }
            _ => self.claim_keys_of(claims_text),
        };

        let mut flags = 0;
        let mut set = |flag: u16, on: bool| {
            if on {
                flags |= flag;
            }
        };
        set(DISABLED, truthy(record.get("disabled")));
        set(VERIFIED, truthy(record.get("emailVerified")));
        set(EMAIL, email.is_some());
        set(PHONE, phone.is_some());
        set(PASSWORD, truthy(record.get("passwordHash")));
        set(PHOTO, photo_url.is_some());
        set(NAME, display_name.is_some());
        let custom_auth = truthy(record.get("customAuth"));
        set(CUSTOM_AUTH, custom_auth);
        set(ANONYMOUS, providers.is_empty() && !custom_auth);
        set(SAMPLE, local_id.starts_with(SAMPLE_PREFIX));

        let mfa = record
            .get("mfaInfo")
            .and_then(JsonValue::as_array)
            .map_or(0, |enrollments| {
                u8::try_from(enrollments.len()).unwrap_or(u8::MAX)
            });

        UserDigest {
            uid,
            email,
            email_key,
            phone: phone.map(Box::from),
            phone_digits,
            display_name: display_name.map(Box::from),
            name_key,
            photo_url: photo_url.map(Box::from),
            haystack,
            created_at: millis_field(record, "createdAt"),
            last_sign_in_at: millis_field(record, "lastLoginAt"),
            flags,
            mfa,
            providers: providers.into_boxed_slice(),
            claim_keys,
            claims,
        }
    }

    /// The sorted, interned top-level keys of a claims text, and the text
    /// itself when it holds any.
    fn claim_keys_of(&mut self, claims: Option<&str>) -> (Box<[u32]>, Option<Arc<str>>) {
        let Some(text) = claims else {
            return (Box::default(), None);
        };
        let Ok(JsonValue::Object(map)) = serde_json::from_str::<JsonValue>(text) else {
            return (Box::default(), None);
        };
        if map.is_empty() {
            return (Box::default(), None);
        }
        let mut names: Vec<&String> = map.keys().collect();
        names.sort();
        let keys: Vec<u32> = names
            .into_iter()
            .map(|name| self.claim_names.intern(name))
            .collect();
        (keys.into_boxed_slice(), Some(Arc::from(text)))
    }

    fn link(&mut self, slot: u32, digest: Arc<UserDigest>) {
        self.by_uid.insert(digest.uid.clone(), slot);
        insert_keyed(
            &mut self.created,
            &mut self.created_null,
            digest.created_at,
            slot,
        );
        insert_keyed(
            &mut self.signed_in,
            &mut self.signed_in_null,
            digest.last_sign_in_at,
            slot,
        );
        insert_keyed(
            &mut self.email,
            &mut self.email_null,
            digest.email_key.clone(),
            slot,
        );
        insert_keyed(
            &mut self.name,
            &mut self.name_null,
            digest.name_key.clone(),
            slot,
        );
        insert_keyed(
            &mut self.phone,
            &mut self.phone_null,
            digest.phone_digits.clone(),
            slot,
        );
        self.counters.apply(&digest, true);
        for provider in &digest.providers {
            *self.provider_counts.entry(*provider).or_insert(0) += 1;
        }
        for key in &digest.claim_keys {
            *self.claim_counts.entry(*key).or_insert(0) += 1;
        }
        self.slots.set(slot_index(slot), Some(digest));
    }

    /// Replaces an account's digest, touching only the orders, counts and
    /// tables whose keys changed: a sign-in moves the `signed_in` entry and
    /// nothing else.
    fn replace(&mut self, slot: u32, previous: &UserDigest, digest: Arc<UserDigest>) {
        if previous.created_at != digest.created_at {
            remove_keyed(
                &mut self.created,
                &mut self.created_null,
                previous.created_at,
                slot,
            );
            insert_keyed(
                &mut self.created,
                &mut self.created_null,
                digest.created_at,
                slot,
            );
        }
        if previous.last_sign_in_at != digest.last_sign_in_at {
            remove_keyed(
                &mut self.signed_in,
                &mut self.signed_in_null,
                previous.last_sign_in_at,
                slot,
            );
            insert_keyed(
                &mut self.signed_in,
                &mut self.signed_in_null,
                digest.last_sign_in_at,
                slot,
            );
        }
        if previous.email_key != digest.email_key {
            remove_keyed(
                &mut self.email,
                &mut self.email_null,
                previous.email_key.clone(),
                slot,
            );
            insert_keyed(
                &mut self.email,
                &mut self.email_null,
                digest.email_key.clone(),
                slot,
            );
        }
        if previous.name_key != digest.name_key {
            remove_keyed(
                &mut self.name,
                &mut self.name_null,
                previous.name_key.clone(),
                slot,
            );
            insert_keyed(
                &mut self.name,
                &mut self.name_null,
                digest.name_key.clone(),
                slot,
            );
        }
        if previous.phone_digits != digest.phone_digits {
            remove_keyed(
                &mut self.phone,
                &mut self.phone_null,
                previous.phone_digits.clone(),
                slot,
            );
            insert_keyed(
                &mut self.phone,
                &mut self.phone_null,
                digest.phone_digits.clone(),
                slot,
            );
        }
        self.counters.apply(previous, false);
        self.counters.apply(&digest, true);
        if previous.providers != digest.providers {
            for provider in &previous.providers {
                decrement(&mut self.provider_counts, *provider);
            }
            for provider in &digest.providers {
                *self.provider_counts.entry(*provider).or_insert(0) += 1;
            }
        }
        if previous.claim_keys != digest.claim_keys {
            for key in &previous.claim_keys {
                decrement(&mut self.claim_counts, *key);
            }
            for key in &digest.claim_keys {
                *self.claim_counts.entry(*key).or_insert(0) += 1;
            }
        }
        self.slots.set(slot_index(slot), Some(digest));
    }

    fn unlink(&mut self, slot: u32, digest: &UserDigest) {
        self.by_uid.remove(&*digest.uid);
        remove_keyed(
            &mut self.created,
            &mut self.created_null,
            digest.created_at,
            slot,
        );
        remove_keyed(
            &mut self.signed_in,
            &mut self.signed_in_null,
            digest.last_sign_in_at,
            slot,
        );
        remove_keyed(
            &mut self.email,
            &mut self.email_null,
            digest.email_key.clone(),
            slot,
        );
        remove_keyed(
            &mut self.name,
            &mut self.name_null,
            digest.name_key.clone(),
            slot,
        );
        remove_keyed(
            &mut self.phone,
            &mut self.phone_null,
            digest.phone_digits.clone(),
            slot,
        );
        self.counters.apply(digest, false);
        for provider in &digest.providers {
            decrement(&mut self.provider_counts, *provider);
        }
        for key in &digest.claim_keys {
            decrement(&mut self.claim_counts, *key);
        }
    }
}

fn insert_keyed<K: Ord + Clone>(
    values: &mut OrdSet<(K, u32)>,
    nulls: &mut OrdSet<u32>,
    key: Option<K>,
    slot: u32,
) {
    match key {
        Some(key) => {
            values.insert((key, slot));
        }
        None => {
            nulls.insert(slot);
        }
    }
}

fn remove_keyed<K: Ord + Clone>(
    values: &mut OrdSet<(K, u32)>,
    nulls: &mut OrdSet<u32>,
    key: Option<K>,
    slot: u32,
) {
    match key {
        Some(key) => {
            values.remove(&(key, slot));
        }
        None => {
            nulls.remove(&slot);
        }
    }
}

fn decrement(counts: &mut ImHashMap<u32, u32>, id: u32) {
    let remaining = counts.get(&id).copied().unwrap_or(0).saturating_sub(1);
    if remaining == 0 {
        counts.remove(&id);
    } else {
        counts.insert(id, remaining);
    }
}

fn slot_index(slot: u32) -> usize {
    usize::try_from(slot).unwrap_or(usize::MAX)
}

// ---------------------------------------------------------------- order

/// A row's value for the sort column.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum SortValue {
    Time(i64),
    Text(Arc<str>),
}

/// A place in an order: the value (absent sorts last) and the slot (ties).
#[derive(Clone, Debug, PartialEq, Eq)]
struct Position {
    value: Option<SortValue>,
    slot: u32,
}

impl Position {
    fn time(&self) -> Option<i64> {
        match &self.value {
            Some(SortValue::Time(time)) => Some(*time),
            _ => None,
        }
    }

    fn text(&self) -> Option<Arc<str>> {
        match &self.value {
            Some(SortValue::Text(text)) => Some(text.clone()),
            _ => None,
        }
    }

    fn cursor(&self, sort: UserSort, pin: Option<(u64, usize)>) -> UserCursor {
        UserCursor {
            sort,
            key: self.value.as_ref().map(|value| match value {
                SortValue::Time(time) => CursorKey::Time(*time),
                SortValue::Text(text) => CursorKey::Text(text.to_string()),
            }),
            slot: self.slot,
            pin: pin.map(|(id, _)| id),
            pos: pin.map_or(0, |(_, pos)| u32::try_from(pos).unwrap_or(u32::MAX)),
        }
    }

    /// The position a cursor names, checked against the request's sort.
    fn of_cursor(cursor: &UserCursor, sort: UserSort) -> Result<Self, ConsoleError> {
        if cursor.sort != sort {
            return Err(ConsoleError::foreign_cursor());
        }
        let value = match (&cursor.key, sort.column.is_time()) {
            (None, _) if sort.column != UserColumn::Uid => None,
            (Some(CursorKey::Time(time)), true) => Some(SortValue::Time(*time)),
            (Some(CursorKey::Text(text)), false) => Some(SortValue::Text(Arc::from(text.as_str()))),
            _ => return Err(ConsoleError::unreadable_cursor()),
        };
        Ok(Self {
            value,
            slot: cursor.slot,
        })
    }
}

/// Where `digest` (at `slot`) sits in `column`'s order.
fn position(slot: u32, digest: &UserDigest, column: UserColumn) -> Position {
    Position {
        value: digest.value(column),
        slot,
    }
}

/// The order of two positions in a sort: values before absent values, then
/// by value (reversed for `desc`) and slot; absent values by slot.
fn compare(sort: UserSort, left: &Position, right: &Position) -> Ordering {
    match (&left.value, &right.value) {
        (Some(a), Some(b)) => {
            let order = a.cmp(b).then(left.slot.cmp(&right.slot));
            match sort.direction {
                SortDirection::Asc => order,
                SortDirection::Desc => order.reverse(),
            }
        }
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => left.slot.cmp(&right.slot),
    }
}

/// The entries of an `im` ordered set from the largest down, strictly below
/// `below` (from the top when `None`).
///
/// im 15.1's B-tree iterators lose entries when `next_back` steps back
/// across a node (`iter().rev()` and `range(..).rev()` both skip whole
/// runs once a set outgrows one node), while a fresh range's first
/// `next_back` is right. So each step asks a fresh range below the entry
/// it last gave: O(log n) a step, and every entry once, in order.
fn descending<T: Ord + Clone>(set: &OrdSet<T>, below: Option<T>) -> impl Iterator<Item = &T> {
    let first = match below {
        None => set.get_max(),
        Some(bound) => set
            .range((Bound::Unbounded, Bound::Excluded(bound)))
            .next_back(),
    };
    std::iter::successors(first, move |last| {
        set.range((Bound::Unbounded, Bound::Excluded((*last).clone())))
            .next_back()
    })
}

/// The slots of a uid map from the largest uid down, strictly below
/// `below` (from the top when `None`); see [`descending`] for why.
fn descending_uids(
    uids: &OrdMap<Arc<str>, u32>,
    below: Option<Arc<str>>,
) -> impl Iterator<Item = u32> + '_ {
    let first = match below {
        None => uids.get_max().map(|(uid, slot)| (uid, slot)),
        Some(bound) => uids
            .range::<_, str>((Bound::Unbounded, Bound::Excluded(&*bound)))
            .next_back(),
    };
    std::iter::successors(first, move |(last, _)| {
        uids.range::<_, str>((Bound::Unbounded, Bound::Excluded(&***last)))
            .next_back()
    })
    .map(|(_, slot)| *slot)
}

/// Slots of one column in page order (`forward`) or its reverse, after (or
/// before) `from`, or from the edge. Every walk downwards in key order goes
/// through [`descending`], never an im iterator run backwards.
fn walk_column<'a, K: Ord + Clone>(
    values: &'a OrdSet<(K, u32)>,
    nulls: &'a OrdSet<u32>,
    descending_values: bool,
    from: Option<(Option<K>, u32)>,
    forward: bool,
) -> Box<dyn Iterator<Item = u32> + 'a> {
    let slot = |entry: &(K, u32)| entry.1;
    let nulls_all = || nulls.iter().copied();
    let down = |below: Option<(K, u32)>| descending(values, below).map(slot);
    match (forward, from, descending_values) {
        (true, None, false) => Box::new(values.iter().map(slot).chain(nulls_all())),
        (true, None, true) => Box::new(down(None).chain(nulls_all())),
        (true, Some((Some(key), at)), false) => Box::new(
            values
                .range((Bound::Excluded((key, at)), Bound::Unbounded))
                .map(slot)
                .chain(nulls_all()),
        ),
        (true, Some((Some(key), at)), true) => Box::new(down(Some((key, at))).chain(nulls_all())),
        (true, Some((None, at)), _) => Box::new(
            nulls
                .range((Bound::Excluded(at), Bound::Unbounded))
                .copied(),
        ),
        (false, None, false) => Box::new(descending(nulls, None).copied().chain(down(None))),
        (false, None, true) => Box::new(
            descending(nulls, None)
                .copied()
                .chain(values.iter().map(slot)),
        ),
        (false, Some((Some(key), at)), false) => Box::new(down(Some((key, at)))),
        (false, Some((Some(key), at)), true) => Box::new(
            values
                .range((Bound::Excluded((key, at)), Bound::Unbounded))
                .map(slot),
        ),
        (false, Some((None, at)), false) => {
            Box::new(descending(nulls, Some(at)).copied().chain(down(None)))
        }
        (false, Some((None, at)), true) => Box::new(
            descending(nulls, Some(at))
                .copied()
                .chain(values.iter().map(slot)),
        ),
    }
}

// ---------------------------------------------------------------- the filter

/// A [`UserFilter`] resolved against one snapshot: lower-cased text, digit
/// forms, provider and claim ids.
struct CompiledFilter {
    words: Vec<(String, Option<String>, bool)>,
    email: Vec<(String, bool)>,
    name: Vec<(String, bool)>,
    phone: Vec<(String, bool)>,
    uid: super::Choice<IdMatch>,
    created: Vec<TimeTerm>,
    signed_in: Vec<TimeTerm>,
    is: super::Choice<UserState>,
    has: super::Choice<UserHas>,
    /// Each `provider:` term as the ids it stands for.
    provider_any: Vec<Vec<u32>>,
    provider_none: Vec<Vec<u32>>,
    claim_any: Vec<CompiledClaim>,
    claim_none: Vec<CompiledClaim>,
    base: bool,
    facets: bool,
}

/// A `claim:` term: the key's id in this snapshot (none when no user
/// carries it), the key itself and the value it must hold.
struct CompiledClaim {
    id: Option<u32>,
    key: String,
    value: Option<JsonValue>,
}

impl CompiledFilter {
    fn new(filter: &UserFilter, data: &IndexData) -> Self {
        let lower = |terms: &[TextTerm]| -> Vec<(String, bool)> {
            terms
                .iter()
                .map(|term| (term.value.to_lowercase(), term.negated))
                .collect()
        };
        let providers = |matches: &[IdMatch]| -> Vec<Vec<u32>> {
            matches
                .iter()
                .map(|matched| match matched {
                    IdMatch::Exact(id) => data.providers.id(id).into_iter().collect(),
                    IdMatch::Prefix(prefix) => data.providers.with_prefix(prefix),
                })
                .collect()
        };
        let claims = |matches: &[ClaimMatch]| -> Vec<CompiledClaim> {
            matches
                .iter()
                .map(|matched| CompiledClaim {
                    id: data.claim_names.id(&matched.key),
                    key: matched.key.clone(),
                    value: matched.value.clone(),
                })
                .collect()
        };
        Self {
            words: filter
                .words
                .iter()
                .map(|word| {
                    (
                        word.value.to_lowercase(),
                        phone_word(&word.value),
                        word.negated,
                    )
                })
                .collect(),
            email: lower(&filter.email),
            name: lower(&filter.name),
            phone: filter
                .phone
                .iter()
                .map(|term| (digits(&term.value), term.negated))
                .collect(),
            uid: filter.uid.clone(),
            created: filter.created.clone(),
            signed_in: filter.signed_in.clone(),
            is: filter.is.clone(),
            has: filter.has.clone(),
            provider_any: providers(&filter.provider.any_of),
            provider_none: providers(&filter.provider.none_of),
            claim_any: claims(&filter.claim.any_of),
            claim_none: claims(&filter.claim.none_of),
            base: filter.has_base_terms(),
            facets: filter.has_facet_terms(),
        }
    }

    fn matches(&self, digest: &UserDigest) -> bool {
        self.base_matches(digest) && self.facets_match(digest)
    }

    /// Words, text, uid and time terms.
    fn base_matches(&self, digest: &UserDigest) -> bool {
        if !self.base {
            return true;
        }
        let words = self.words.iter().all(|(word, phone, negated)| {
            let found = digest.haystack.contains(word.as_str())
                || phone.as_deref().is_some_and(|phone| {
                    digest
                        .phone_digits
                        .as_deref()
                        .is_some_and(|digits| digits.contains(phone))
                });
            found != *negated
        });
        let text = |terms: &[(String, bool)], value: Option<&str>| {
            terms.iter().all(|(term, negated)| {
                value.is_some_and(|value| value.contains(term.as_str())) != *negated
            })
        };
        words
            && text(&self.email, digest.email_key.as_deref())
            && text(&self.name, digest.name_key.as_deref())
            && text(&self.phone, digest.phone_digits.as_deref())
            && self.uid.admits(|matched| matched.matches(&digest.uid))
            && self
                .created
                .iter()
                .all(|term| term.contains(digest.created_at) != term.negated)
            && self
                .signed_in
                .iter()
                .all(|term| term.contains(digest.last_sign_in_at) != term.negated)
    }

    /// `is`, `has`, `provider` and `claim` terms.
    fn facets_match(&self, digest: &UserDigest) -> bool {
        if !self.facets {
            return true;
        }
        let state = |state: &UserState| match state {
            UserState::Disabled => digest.has(DISABLED),
            UserState::Verified => digest.has(VERIFIED),
            UserState::Anonymous => digest.has(ANONYMOUS),
            UserState::CustomToken => digest.has(CUSTOM_AUTH),
            UserState::Sample => digest.has(SAMPLE),
        };
        let has = |has: &UserHas| match has {
            UserHas::Email => digest.has(EMAIL),
            UserHas::Phone => digest.has(PHONE),
            UserHas::Password => digest.has(PASSWORD),
            UserHas::Mfa => digest.mfa > 0,
            UserHas::Claims => !digest.claim_keys.is_empty(),
            UserHas::Photo => digest.has(PHOTO),
            UserHas::Name => digest.has(NAME),
            UserHas::SignIn => digest.last_sign_in_at.is_some(),
        };
        let provider = |ids: &Vec<u32>| digest.providers.iter().any(|id| ids.contains(id));
        let mut parsed: Option<Option<JsonMap<String, JsonValue>>> = None;
        let mut claim = |term: &CompiledClaim| {
            if !term.id.is_some_and(|id| digest.claim_keys.contains(&id)) {
                return false;
            }
            let Some(value) = &term.value else {
                return true;
            };
            parsed
                .get_or_insert_with(|| digest.parsed_claims())
                .as_ref()
                .and_then(|claims| claims.get(&term.key))
                .is_some_and(|stored| json_equal(stored, value))
        };
        self.is.admits(state)
            && self.has.admits(has)
            && (self.provider_any.is_empty() || self.provider_any.iter().any(provider))
            && !self.provider_none.iter().any(provider)
            && (self.claim_any.is_empty() || self.claim_any.iter().any(&mut claim))
            && !self.claim_none.iter().any(&mut claim)
    }
}

// ---------------------------------------------------------------- pins

/// A filtered first page's ordered match list, so later pages slice it
/// instead of scanning again.
struct Pin {
    id: u64,
    filter: String,
    sort: UserSort,
    uids: Arc<[Arc<str>]>,
    used: Instant,
}

#[derive(Default)]
struct PinCache {
    pins: Vec<Pin>,
}

static NEXT_PIN: AtomicU64 = AtomicU64::new(1);

impl PinCache {
    fn expire(&mut self, now: Instant) {
        self.pins
            .retain(|pin| now.saturating_duration_since(pin.used) < PIN_IDLE);
    }

    fn insert(&mut self, filter: String, sort: UserSort, uids: Arc<[Arc<str>]>) -> u64 {
        let now = Instant::now();
        self.expire(now);
        if self.pins.len() >= PIN_CAPACITY
            && let Some(oldest) = self
                .pins
                .iter()
                .enumerate()
                .min_by_key(|(_, pin)| pin.used)
                .map(|(index, _)| index)
        {
            self.pins.swap_remove(oldest);
        }
        let id = NEXT_PIN.fetch_add(1, AtomicOrdering::Relaxed);
        self.pins.push(Pin {
            id,
            filter,
            sort,
            uids,
            used: now,
        });
        id
    }

    fn get(&mut self, id: u64, filter: &str, sort: UserSort) -> Option<Arc<[Arc<str>]>> {
        let now = Instant::now();
        self.expire(now);
        let pin = self
            .pins
            .iter_mut()
            .find(|pin| pin.id == id && pin.sort == sort && pin.filter == filter)?;
        pin.used = now;
        Some(pin.uids.clone())
    }
}

fn guard<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

// ---------------------------------------------------------------- reads

/// A point-in-time copy of one scope's index.
#[derive(Clone)]
pub(crate) struct IndexSnapshot {
    data: IndexData,
    shared: Arc<Shared>,
}

/// Facet counts tallied over the users a filter's base terms select.
struct Tally {
    counters: Counters,
    providers: Vec<u64>,
}

impl Tally {
    fn new(providers: usize) -> Self {
        Self {
            counters: Counters::default(),
            providers: vec![0; providers],
        }
    }

    fn add(&mut self, digest: &UserDigest) {
        self.counters.apply(digest, true);
        for provider in &digest.providers {
            if let Some(count) = self.providers.get_mut(slot_index(*provider)) {
                *count += 1;
            }
        }
    }
}

/// What one pass over the digests found.
struct Pass {
    facets: UserFacets,
    total: u64,
    matched: Vec<u32>,
}

impl IndexSnapshot {
    /// The view of a scope that does not exist yet.
    pub(crate) fn empty() -> Self {
        UserIndex::default().snapshot()
    }

    pub(crate) fn len(&self) -> u64 {
        u64::try_from(self.data.by_uid.len()).unwrap_or(u64::MAX)
    }

    pub(crate) const fn generation(&self) -> u64 {
        self.data.generation
    }

    pub(crate) const fn claims_generation(&self) -> u64 {
        self.data.claims_generation
    }

    fn digest_of(&self, uid: &str) -> Option<(u32, &Arc<UserDigest>)> {
        let slot = *self.data.by_uid.get(uid)?;
        Some((slot, self.data.digest(slot)?))
    }

    /// The uids `filter` matches, in uid order: what a bulk action or an
    /// export over a query works through. One pass over the digests.
    pub(crate) fn matching_uids(&self, filter: &UserFilter) -> Vec<Arc<str>> {
        if filter.is_empty() {
            return self.data.by_uid.keys().cloned().collect();
        }
        let compiled = CompiledFilter::new(filter, &self.data);
        self.data
            .by_uid
            .iter()
            .filter(|(_, slot)| {
                self.data
                    .digest(**slot)
                    .is_some_and(|digest| compiled.matches(digest))
            })
            .map(|(uid, _)| uid.clone())
            .collect()
    }

    /// Whether the scope holds `uid`.
    pub(crate) fn contains(&self, uid: &str) -> bool {
        self.data.by_uid.contains_key(uid)
    }

    /// Slots whose uid is `text` or whose email is `text` (lower-cased).
    pub(crate) fn exact_matches(&self, text: &str, lower: &str) -> Vec<u32> {
        let mut slots = Vec::new();
        if let Some(slot) = self.data.by_uid.get(text) {
            slots.push(*slot);
        }
        let key: Arc<str> = Arc::from(lower);
        for (email, slot) in self.data.email.range((key.clone(), 0)..) {
            if *email != key {
                break;
            }
            if !slots.contains(slot) {
                slots.push(*slot);
            }
        }
        slots
    }

    /// Slots whose email starts with `lower`, in email order, then whose
    /// uid starts with `text`, in uid order: range reads, at most `limit`.
    pub(crate) fn prefix_matches(&self, text: &str, lower: &str, limit: usize) -> Vec<u32> {
        let mut slots = Vec::new();
        let key: Arc<str> = Arc::from(lower);
        for (email, slot) in self.data.email.range((key, 0)..) {
            if slots.len() >= limit || !email.starts_with(lower) {
                break;
            }
            slots.push(*slot);
        }
        for (uid, slot) in self
            .data
            .by_uid
            .range::<_, str>((Bound::Included(text), Bound::Unbounded))
        {
            if slots.len() >= limit || !uid.starts_with(text) {
                break;
            }
            if !slots.contains(slot) {
                slots.push(*slot);
            }
        }
        slots
    }

    /// Slots whose searchable text (email, phone digits, uid, display name,
    /// lower-cased) contains `lower`, in uid order, skipping `seen`, until
    /// `limit` match or `budget` digests were examined (it is spent as they
    /// are) or `stop` says so. Answers the matches and whether it stopped
    /// before the end.
    pub(crate) fn substring_matches(
        &self,
        lower: &str,
        seen: &[u32],
        limit: usize,
        budget: &mut usize,
        stop: &dyn Fn() -> bool,
    ) -> (Vec<u32>, bool) {
        let mut slots = Vec::new();
        for (_, slot) in &self.data.by_uid {
            if slots.len() >= limit {
                return (slots, false);
            }
            if *budget == 0 || stop() {
                return (slots, true);
            }
            *budget -= 1;
            if seen.contains(slot) {
                continue;
            }
            if self
                .data
                .digest(*slot)
                .is_some_and(|digest| digest.haystack.contains(lower))
            {
                slots.push(*slot);
            }
        }
        (slots, false)
    }

    /// The first `limit` slots in uid order.
    pub(crate) fn first_by_uid(&self, limit: usize) -> Vec<u32> {
        self.data.by_uid.values().take(limit).copied().collect()
    }

    /// The row at `slot`, and its parsed claims.
    pub(crate) fn hit_at(
        &self,
        slot: u32,
        tenant: Option<&str>,
    ) -> Option<(UserRow, Option<JsonMap<String, JsonValue>>)> {
        let digest = self.data.digest(slot)?;
        Some((self.row(digest, tenant), digest.parsed_claims()))
    }

    /// The uid of the account whose email is `email` (compared lower-cased).
    pub(crate) fn uid_of_email(&self, email: &str) -> Option<Arc<str>> {
        let key: Arc<str> = Arc::from(email.to_lowercase().as_str());
        let (found, slot) = self.data.email.range((key.clone(), 0)..).next()?;
        if *found != key {
            return None;
        }
        self.data.digest(*slot).map(|digest| digest.uid.clone())
    }

    /// The row the table shows for `uid`.
    pub(crate) fn row_of(&self, uid: &str, tenant: Option<&str>) -> Option<UserRow> {
        self.digest_of(uid)
            .map(|(_, digest)| self.row(digest, tenant))
    }

    fn row(&self, digest: &UserDigest, tenant: Option<&str>) -> UserRow {
        UserRow {
            uid: digest.uid.to_string(),
            tenant: tenant.map(str::to_owned),
            email: digest.email.as_deref().map(str::to_owned),
            email_verified: digest.has(VERIFIED),
            phone_number: digest.phone.as_deref().map(str::to_owned),
            display_name: digest.display_name.as_deref().map(str::to_owned),
            photo_url: digest.photo_url.as_deref().map(str::to_owned),
            providers: digest
                .providers
                .iter()
                .map(|id| self.data.providers.name(*id).to_owned())
                .collect(),
            anonymous: digest.has(ANONYMOUS),
            disabled: digest.has(DISABLED),
            mfa: u32::from(digest.mfa),
            claim_keys: digest
                .claim_keys
                .iter()
                .map(|id| self.data.claim_names.name(*id).to_owned())
                .collect(),
            custom_auth: digest.has(CUSTOM_AUTH),
            created_at: digest.created_at,
            last_sign_in_at: digest.last_sign_in_at,
        }
    }

    /// Slots in page order (`forward`) or its reverse, strictly after (or
    /// before) `from`, or from the edge.
    fn walk(
        &self,
        sort: UserSort,
        from: Option<&Position>,
        forward: bool,
    ) -> Box<dyn Iterator<Item = u32> + '_> {
        let descending = sort.direction == SortDirection::Desc;
        let data = &self.data;
        match sort.column {
            UserColumn::Created => walk_column(
                &data.created,
                &data.created_null,
                descending,
                from.map(|position| (position.time(), position.slot)),
                forward,
            ),
            UserColumn::SignedIn => walk_column(
                &data.signed_in,
                &data.signed_in_null,
                descending,
                from.map(|position| (position.time(), position.slot)),
                forward,
            ),
            UserColumn::Email => walk_column(
                &data.email,
                &data.email_null,
                descending,
                from.map(|position| (position.text(), position.slot)),
                forward,
            ),
            UserColumn::Name => walk_column(
                &data.name,
                &data.name_null,
                descending,
                from.map(|position| (position.text(), position.slot)),
                forward,
            ),
            UserColumn::Phone => walk_column(
                &data.phone,
                &data.phone_null,
                descending,
                from.map(|position| (position.text(), position.slot)),
                forward,
            ),
            UserColumn::Uid => {
                let after = from.and_then(Position::text);
                let slot = |(_, slot): (&Arc<str>, &u32)| *slot;
                let uids = &data.by_uid;
                match (forward != descending, after) {
                    (true, None) => Box::new(uids.iter().map(slot)),
                    (false, below) => Box::new(descending_uids(uids, below)),
                    (true, Some(uid)) => Box::new(
                        uids.range::<_, str>((Bound::Excluded(&*uid), Bound::Unbounded))
                            .map(slot),
                    ),
                }
            }
        }
    }

    /// The facet counts when the filter has no base terms: the counters.
    fn counted_facets(&self) -> UserFacets {
        let mut providers: Vec<ProviderCount> = self
            .data
            .provider_counts
            .iter()
            .map(|(id, users)| ProviderCount {
                provider: self.data.providers.name(*id).to_owned(),
                users: u64::from(*users),
            })
            .collect();
        sort_providers(&mut providers);
        facets_of(self.data.counters, providers)
    }

    fn tallied_facets(&self, tally: &Tally) -> UserFacets {
        let mut providers: Vec<ProviderCount> = tally
            .providers
            .iter()
            .enumerate()
            .filter(|(_, users)| **users > 0)
            .filter_map(|(id, users)| {
                Some(ProviderCount {
                    provider: self.data.providers.name(u32::try_from(id).ok()?).to_owned(),
                    users: *users,
                })
            })
            .collect();
        sort_providers(&mut providers);
        facets_of(tally.counters, providers)
    }

    /// One pass over every digest: the facets over the base terms, the
    /// number of full matches and, when asked, their slots.
    fn pass(&self, filter: &CompiledFilter, collect: bool) -> Pass {
        self.shared.scans.fetch_add(1, AtomicOrdering::Relaxed);
        let mut tally = filter.base.then(|| Tally::new(self.data.providers.len()));
        let mut total = 0;
        let mut matched = Vec::new();
        for (slot, digest) in self.data.slots.iter().enumerate() {
            let Some(digest) = digest else {
                continue;
            };
            if !filter.base_matches(digest) {
                continue;
            }
            if let Some(tally) = tally.as_mut() {
                tally.add(digest);
            }
            if filter.facets_match(digest) {
                total += 1;
                if collect && let Ok(slot) = u32::try_from(slot) {
                    matched.push(slot);
                }
            }
        }
        Pass {
            facets: tally.map_or_else(
                || self.counted_facets(),
                |tally| self.tallied_facets(&tally),
            ),
            total,
            matched,
        }
    }

    /// The matched slots' uids in the sort's order: by walking the ordered
    /// set when many match, by sorting the matches when few do.
    fn ordered_matches(&self, sort: UserSort, matched: &[u32]) -> Vec<Arc<str>> {
        let uid = |slot: u32| self.data.digest(slot).map(|digest| digest.uid.clone());
        if matched.len().saturating_mul(8) > self.data.by_uid.len() {
            let mut marks = vec![0_u64; self.data.slots.len().div_ceil(64)];
            for slot in matched {
                let slot = slot_index(*slot);
                if let Some(word) = marks.get_mut(slot / 64) {
                    *word |= 1 << (slot % 64);
                }
            }
            let marked = |slot: &u32| {
                let slot = slot_index(*slot);
                marks
                    .get(slot / 64)
                    .is_some_and(|word| word & (1 << (slot % 64)) != 0)
            };
            self.walk(sort, None, true)
                .filter(marked)
                .filter_map(uid)
                .collect()
        } else {
            let mut positions: Vec<Position> = matched
                .iter()
                .filter_map(|slot| {
                    self.data
                        .digest(*slot)
                        .map(|digest| position(*slot, digest, sort.column))
                })
                .collect();
            positions.sort_by(|left, right| compare(sort, left, right));
            positions
                .into_iter()
                .filter_map(|position| uid(position.slot))
                .collect()
        }
    }

    /// One page of the users table.
    pub(crate) fn page(
        &self,
        tenant: Option<&str>,
        query: &UsersQuery,
    ) -> Result<UsersPage, ConsoleError> {
        let started = Instant::now();
        let limit = match query.limit {
            0 => DEFAULT_PAGE_SIZE,
            limit => limit.min(MAX_PAGE_SIZE),
        };
        let sort = query.sort;
        if query.cursor.is_some() && query.before.is_some() {
            return Err(ConsoleError::invalid(
                "Pass either cursor or before, not both.",
            ));
        }
        let anchor = match (&query.cursor, &query.before) {
            (Some(cursor), _) => Some((cursor, true, Position::of_cursor(cursor, sort)?)),
            (None, Some(before)) => Some((before, false, Position::of_cursor(before, sort)?)),
            (None, None) => None,
        };
        let filter = CompiledFilter::new(&query.filter, &self.data);
        let filtered = filter.base || filter.facets;

        let mut page = match anchor {
            None if filtered => {
                self.first_filtered_page(tenant, &query.filter, &filter, sort, limit)
            }
            None => {
                let mut page = self.walk_page(tenant, &filter, sort, None, true, limit);
                page.total = Some(self.len());
                page.facets = Some(self.counted_facets());
                page.scope_total = Some(self.len());
                page
            }
            Some((cursor, forward, position)) => {
                let pinned = cursor
                    .pin
                    .and_then(|id| guard(&self.shared.pins).get(id, &query.filter.key(), sort));
                match pinned {
                    Some(uids) if filtered => self.pinned_page(
                        tenant,
                        &filter,
                        sort,
                        (cursor, &position),
                        forward,
                        &uids,
                        limit,
                    ),
                    _ => self.walk_page(tenant, &filter, sort, Some(&position), forward, limit),
                }
            }
        };
        page.took = started.elapsed();
        Ok(page)
    }

    /// A page read by walking the ordered set from `from` (or the edge),
    /// keeping the users the filter matches.
    fn walk_page(
        &self,
        tenant: Option<&str>,
        filter: &CompiledFilter,
        sort: UserSort,
        from: Option<&Position>,
        forward: bool,
        limit: usize,
    ) -> UsersPage {
        let mut found: Vec<(Position, &Arc<UserDigest>)> = Vec::with_capacity(limit + 1);
        for slot in self.walk(sort, from, forward) {
            let Some(digest) = self.data.digest(slot) else {
                continue;
            };
            if !filter.matches(digest) {
                continue;
            }
            found.push((position(slot, digest, sort.column), digest));
            if found.len() > limit {
                break;
            }
        }
        let more = found.len() > limit;
        found.truncate(limit);
        if !forward {
            found.reverse();
        }
        let first = found
            .first()
            .map(|(position, _)| position.cursor(sort, None));
        let last = found
            .last()
            .map(|(position, _)| position.cursor(sort, None));
        let (next, prev) = match (from, forward) {
            // The top page: what follows when there is more.
            (None, _) => (if more { last } else { None }, None),
            // Read downwards from a cursor: a row was above it.
            (Some(_), true) => (if more { last } else { None }, first),
            // Read upwards from `before`: its row is below.
            (Some(_), false) => (last, if more { first } else { None }),
        };
        UsersPage {
            rows: found
                .iter()
                .map(|(_, digest)| self.row(digest, tenant))
                .collect(),
            next,
            prev,
            total: None,
            facets: None,
            scope_total: None,
            took: Duration::ZERO,
        }
    }

    /// The first page of a filtered table: one pass for the facets and the
    /// match list, which is pinned when more pages follow.
    fn first_filtered_page(
        &self,
        tenant: Option<&str>,
        filter: &UserFilter,
        compiled: &CompiledFilter,
        sort: UserSort,
        limit: usize,
    ) -> UsersPage {
        let pass = self.pass(compiled, true);
        let ordered = self.ordered_matches(sort, &pass.matched);
        let rows_end = ordered.len().min(limit);
        let rows: Vec<(Position, UserRow)> = ordered[..rows_end]
            .iter()
            .filter_map(|uid| {
                let (slot, digest) = self.digest_of(uid)?;
                Some((
                    position(slot, digest, sort.column),
                    self.row(digest, tenant),
                ))
            })
            .collect();
        let next = if ordered.len() > limit {
            let uids: Arc<[Arc<str>]> = ordered.into();
            let id = guard(&self.shared.pins).insert(filter.key(), sort, uids);
            rows.last()
                .map(|(position, _)| position.cursor(sort, Some((id, rows_end))))
        } else {
            None
        };
        UsersPage {
            rows: rows.into_iter().map(|(_, row)| row).collect(),
            next,
            prev: None,
            total: Some(pass.total),
            facets: Some(pass.facets),
            scope_total: Some(self.len()),
            took: Duration::ZERO,
        }
    }

    /// A later page of a filtered table, sliced from its pinned match list;
    /// rows come from the current index, so users deleted (or no longer
    /// matching) since the first page are left out.
    #[allow(clippy::too_many_arguments)]
    fn pinned_page(
        &self,
        tenant: Option<&str>,
        filter: &CompiledFilter,
        sort: UserSort,
        (cursor, anchor): (&UserCursor, &Position),
        forward: bool,
        uids: &Arc<[Arc<str>]>,
        limit: usize,
    ) -> UsersPage {
        let pin = cursor.pin.unwrap_or_default();
        let pos = slot_index(cursor.pos).min(uids.len());
        let (start, end) = if forward {
            (pos, pos.saturating_add(limit).min(uids.len()))
        } else {
            (pos.saturating_sub(limit), pos)
        };
        let mut first_position = anchor.clone();
        let mut last_position = anchor.clone();
        let mut rows = Vec::with_capacity(end - start);
        for uid in &uids[start..end] {
            let Some((slot, digest)) = self.digest_of(uid) else {
                continue;
            };
            if !filter.matches(digest) {
                continue;
            }
            let at = position(slot, digest, sort.column);
            if rows.is_empty() {
                first_position = at.clone();
            }
            last_position = at;
            rows.push(self.row(digest, tenant));
        }
        if rows.is_empty() && !forward {
            first_position = last_position.clone();
        }
        UsersPage {
            rows,
            next: (end < uids.len()).then(|| last_position.cursor(sort, Some((pin, end)))),
            prev: (start > 0).then(|| first_position.cursor(sort, Some((pin, start)))),
            total: None,
            facets: None,
            scope_total: None,
            took: Duration::ZERO,
        }
    }

    /// The rows the live channel named, the page each falls in, and the
    /// figures the page shows.
    pub(crate) fn batch(
        &self,
        tenant: Option<&str>,
        query: &UsersBatchQuery,
    ) -> Result<UsersBatch, ConsoleError> {
        if query.uids.len() > MAX_BATCH_USERS {
            return Err(ConsoleError::invalid(format!(
                "A batch reads at most {MAX_BATCH_USERS} users; this one names {}.",
                query.uids.len()
            )));
        }
        let sort = query.sort;
        let starts: Vec<Option<Position>> = query
            .page_starts
            .iter()
            .map(|start| {
                start
                    .as_ref()
                    .map(|cursor| Position::of_cursor(cursor, sort))
                    .transpose()
            })
            .collect::<Result<_, _>>()?;
        let end = query
            .window_end
            .as_ref()
            .map(|cursor| Position::of_cursor(cursor, sort))
            .transpose()?;
        let filter = CompiledFilter::new(&query.filter, &self.data);
        let items = query
            .uids
            .iter()
            .map(|uid| {
                let found = self
                    .digest_of(uid)
                    .filter(|(_, digest)| filter.matches(digest));
                BatchUser {
                    uid: uid.clone(),
                    row: found.map(|(_, digest)| self.row(digest, tenant)),
                    page: found.and_then(|(slot, digest)| {
                        let at = position(slot, digest, sort.column);
                        page_of(sort, &at, &starts, end.as_ref())
                    }),
                }
            })
            .collect();
        let (total, facets) = if filter.base || filter.facets {
            let pass = self.pass(&filter, false);
            (pass.total, pass.facets)
        } else {
            (self.len(), self.counted_facets())
        };
        Ok(UsersBatch {
            items,
            total,
            facets,
            scope_total: self.len(),
        })
    }

    /// The custom claim keys: users per key from the maintained counts,
    /// kinds and samples from the users with claims, cached until some
    /// user's claims change.
    pub(crate) fn claim_keys(&self) -> Arc<ClaimKeys> {
        let generation = self.data.claims_generation;
        if let Some((cached, keys)) = guard(&self.shared.claim_keys).as_ref()
            && *cached == generation
        {
            return keys.clone();
        }
        self.shared
            .claim_scans
            .fetch_add(1, AtomicOrdering::Relaxed);
        let mut seen: HashMap<u32, (BTreeSet<&'static str>, Vec<JsonValue>)> = HashMap::new();
        for digest in self.data.slots.iter().flatten() {
            let Some(claims) = digest.parsed_claims() else {
                continue;
            };
            for (key, value) in claims {
                let Some(id) = self.data.claim_names.id(&key) else {
                    continue;
                };
                let (kinds, samples) = seen.entry(id).or_default();
                kinds.insert(kind_of(&value));
                if samples.len() < CLAIM_SAMPLES
                    && !samples.iter().any(|sample| json_equal(sample, &value))
                {
                    samples.push(value);
                }
            }
        }
        let mut keys: Vec<ClaimKey> = self
            .data
            .claim_counts
            .iter()
            .map(|(id, users)| {
                let (kinds, samples) = seen.remove(id).unwrap_or_default();
                ClaimKey {
                    key: self.data.claim_names.name(*id).to_owned(),
                    users: u64::from(*users),
                    kinds: kinds.into_iter().map(str::to_owned).collect(),
                    samples,
                }
            })
            .collect();
        keys.sort_by(|left, right| {
            right
                .users
                .cmp(&left.users)
                .then_with(|| left.key.cmp(&right.key))
        });
        keys.truncate(MAX_CLAIM_KEYS);
        let answer = Arc::new(ClaimKeys {
            keys,
            users_with_claims: self.data.counters.claims,
        });
        *guard(&self.shared.claim_keys) = Some((generation, answer.clone()));
        answer
    }

    /// Bytes the index holds, estimated from its layout: each digest and its
    /// heap strings, the slot vector, and every ordered set's B-tree nodes at
    /// the half-full fill `im` leaves after ascending inserts (its worst
    /// case), with allocator rounding.
    #[cfg(test)]
    pub(crate) fn estimated_bytes(&self) -> usize {
        estimate(&self.data)
    }

    #[cfg(test)]
    pub(crate) fn scans(&self) -> usize {
        self.shared.scans.load(AtomicOrdering::Relaxed)
    }

    #[cfg(test)]
    pub(crate) fn claim_scans(&self) -> usize {
        self.shared.claim_scans.load(AtomicOrdering::Relaxed)
    }

    /// Drops every pinned match list, as their expiry would.
    #[cfg(test)]
    pub(crate) fn forget_pins(&self) {
        guard(&self.shared.pins).pins.clear();
    }
}

/// The loaded page a row at `at` falls in. Page `i` starts at `starts[i]`
/// (its first row; `None` for the top of the list) and runs to the next
/// page's start; the last one ends at `end` (its last row) or runs to the
/// end of the list. `None` above the first page or below the window.
fn page_of(
    sort: UserSort,
    at: &Position,
    starts: &[Option<Position>],
    end: Option<&Position>,
) -> Option<u32> {
    let mut page = None;
    for (index, start) in starts.iter().enumerate() {
        let reached = start
            .as_ref()
            .is_none_or(|start| compare(sort, start, at) != Ordering::Greater);
        if !reached {
            break;
        }
        page = Some(index);
    }
    let page = page?;
    if page + 1 == starts.len()
        && end.is_some_and(|end| compare(sort, at, end) == Ordering::Greater)
    {
        return None;
    }
    u32::try_from(page).ok()
}

fn sort_providers(providers: &mut [ProviderCount]) {
    providers.sort_by(|left, right| {
        right
            .users
            .cmp(&left.users)
            .then_with(|| left.provider.cmp(&right.provider))
    });
}

fn facets_of(counters: Counters, providers: Vec<ProviderCount>) -> UserFacets {
    UserFacets {
        disabled: counters.disabled,
        unverified: counters.unverified,
        anonymous: counters.anonymous,
        custom_token: counters.custom_token,
        sample: counters.sample,
        mfa: counters.mfa,
        claims: counters.claims,
        never_signed_in: counters.never_signed_in,
        providers,
    }
}

const fn kind_of(value: &JsonValue) -> &'static str {
    match value {
        JsonValue::Null => "null",
        JsonValue::Bool(_) => "boolean",
        JsonValue::Number(_) => "number",
        JsonValue::String(_) => "string",
        JsonValue::Array(_) => "array",
        JsonValue::Object(_) => "object",
    }
}

// ---------------------------------------------------------------- memory

/// Rounds an allocation up to the allocator's 16-byte granularity.
#[cfg(test)]
const fn allocation(bytes: usize) -> usize {
    if bytes == 0 {
        0
    } else {
        bytes.div_ceil(16) * 16
    }
}

/// An `Arc<str>` of `text`: two counters and the bytes.
#[cfg(test)]
fn arc_str(text: &str) -> usize {
    allocation(16 + text.len())
}

/// The nodes of an `im` B-tree holding `entries` of `entry` bytes: 64 keys
/// and 65 child pointers per node, behind an `Arc`, counted at 32 keys per
/// node plus the inner levels.
#[cfg(test)]
fn btree(entries: usize, entry: usize) -> usize {
    if entries == 0 {
        return 0;
    }
    let node = allocation(16 + (16 + 64 * entry) + (16 + 65 * 8));
    let mut nodes = 0;
    let mut level = entries.div_ceil(32);
    loop {
        nodes += level;
        if level <= 1 {
            break;
        }
        level = level.div_ceil(32);
    }
    nodes * node
}

#[cfg(test)]
fn estimate(data: &IndexData) -> usize {
    let mut bytes = 0;
    for digest in data.slots.iter().flatten() {
        bytes += allocation(16 + size_of::<UserDigest>());
        bytes += arc_str(&digest.uid);
        if let Some(email) = &digest.email {
            bytes += arc_str(email);
        }
        if let (Some(key), Some(email)) = (&digest.email_key, &digest.email)
            && !Arc::ptr_eq(key, email)
        {
            bytes += arc_str(key);
        }
        bytes += digest
            .phone
            .as_deref()
            .map_or(0, |phone| allocation(phone.len()));
        bytes += digest.phone_digits.as_deref().map_or(0, arc_str);
        bytes += digest
            .display_name
            .as_deref()
            .map_or(0, |name| allocation(name.len()));
        bytes += digest.name_key.as_deref().map_or(0, arc_str);
        bytes += digest
            .photo_url
            .as_deref()
            .map_or(0, |url| allocation(url.len()));
        bytes += allocation(digest.haystack.len());
        bytes += allocation(4 * digest.providers.len());
        bytes += allocation(4 * digest.claim_keys.len());
        bytes += digest.claims.as_deref().map_or(0, arc_str);
    }
    // The slot vector: 64-entry chunks of one pointer each, and their tree.
    let chunks = data.slots.len().div_ceil(64);
    bytes += chunks * allocation(16 + 16 + 64 * 8);
    bytes += chunks.div_ceil(64) * allocation(16 + 16 + 64 * 8);
    let time = size_of::<(i64, u32)>();
    let text = size_of::<(Arc<str>, u32)>();
    let null = size_of::<u32>();
    bytes += btree(data.by_uid.len(), text);
    bytes += btree(data.created.len(), time) + btree(data.created_null.len(), null);
    bytes += btree(data.signed_in.len(), time) + btree(data.signed_in_null.len(), null);
    bytes += btree(data.email.len(), text) + btree(data.email_null.len(), null);
    bytes += btree(data.name.len(), text) + btree(data.name_null.len(), null);
    bytes += btree(data.phone.len(), text) + btree(data.phone_null.len(), null);
    bytes
}

// ---------------------------------------------------------------- tests

/// A comparable copy of an index, with slots resolved to uids, so an index
/// kept up to date one change at a time can be compared with one rebuilt
/// from the records.
#[cfg(test)]
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Canonical {
    digests: BTreeMap<String, String>,
    created: Vec<(Option<i64>, String)>,
    signed_in: Vec<(Option<i64>, String)>,
    email: Vec<(Option<String>, String)>,
    name: Vec<(Option<String>, String)>,
    phone: Vec<(Option<String>, String)>,
    counters: Counters,
    providers: BTreeMap<String, u32>,
    claims: BTreeMap<String, u32>,
}

#[cfg(test)]
impl UserIndex {
    pub(crate) fn canonical(&self) -> Canonical {
        let data = &self.data;
        let uid = |slot: u32| {
            data.digest(slot).map_or_else(
                || format!("<empty slot {slot}>"),
                |digest| digest.uid.to_string(),
            )
        };
        let keyed = |values: Vec<(Option<String>, u32)>| {
            let mut entries: Vec<(Option<String>, String)> = values
                .into_iter()
                .map(|(key, slot)| (key, uid(slot)))
                .collect();
            entries.sort();
            entries
        };
        let times = |values: &OrdSet<(i64, u32)>, nulls: &OrdSet<u32>| {
            let mut entries: Vec<(Option<i64>, String)> = values
                .iter()
                .map(|(time, slot)| (Some(*time), uid(*slot)))
                .chain(nulls.iter().map(|slot| (None, uid(*slot))))
                .collect();
            entries.sort();
            entries
        };
        let texts = |values: &OrdSet<(Arc<str>, u32)>, nulls: &OrdSet<u32>| {
            keyed(
                values
                    .iter()
                    .map(|(text, slot)| (Some(text.to_string()), *slot))
                    .chain(nulls.iter().map(|slot| (None, *slot)))
                    .collect(),
            )
        };
        let snapshot = self.snapshot();
        Canonical {
            digests: data
                .by_uid
                .iter()
                .map(|(uid, slot)| {
                    let row = data.digest(*slot).map(|digest| {
                        format!("{:?} {:?}", snapshot.row(digest, None), digest.haystack)
                    });
                    (uid.to_string(), row.unwrap_or_default())
                })
                .collect(),
            created: times(&data.created, &data.created_null),
            signed_in: times(&data.signed_in, &data.signed_in_null),
            email: texts(&data.email, &data.email_null),
            name: texts(&data.name, &data.name_null),
            phone: texts(&data.phone, &data.phone_null),
            counters: data.counters,
            providers: data
                .provider_counts
                .iter()
                .map(|(id, users)| (data.providers.name(*id).to_owned(), *users))
                .collect(),
            claims: data
                .claim_counts
                .iter()
                .map(|(id, users)| (data.claim_names.name(*id).to_owned(), *users))
                .collect(),
        }
    }
}
