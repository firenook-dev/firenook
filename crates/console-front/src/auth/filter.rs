//! The Auth pages' filter fields, in the shared grammar (`filter.rs`), and
//! what each filter means here: the users table's `q` translated into
//! auth-front's [`UserFilter`] (the index that evaluates it lives there),
//! and the matchers the Activity and Inbox lists and their topics run.
//!
//! The browser declares the same fields (`src/auth/fields.ts`) and reads
//! the same case files; it parses only to paint tokens, complete and show
//! errors, and never filters rows.

use firenook_auth_front::console::filter::{
    Choice, ClaimMatch, IdMatch, TextTerm, TimeTerm, UserFilter, UserHas, UserState,
};
use serde_json::Value as JsonValue;
use time::OffsetDateTime;

use super::feed::{ActivityEntry, MessageEntry, has};
use super::wire::{AuthCallKind, AuthCaller, AuthConsoleOrigin, AuthMessageDelivery};
use crate::api_error::ApiError;
use crate::filter::{
    FieldKind, FieldSet, FieldSpec, FilterError, FilterOp, FilterQuery, FilterTerm, parse_duration,
    parse_number, parse_time,
};

/// The users table (`GET /auth/users?q=`).
pub(crate) const USER_FIELDS: FieldSet = FieldSet {
    fields: &[
        FieldSpec {
            key: "is",
            aliases: &[],
            kind: FieldKind::Enum {
                values: &[
                    "disabled",
                    "verified",
                    "anonymous",
                    "custom-token",
                    "sample",
                ],
                aliases: &[],
            },
            help: "Account state",
        },
        FieldSpec {
            key: "has",
            aliases: &[],
            kind: FieldKind::Enum {
                values: &[
                    "email", "phone", "password", "mfa", "claims", "photo", "name", "sign-in",
                ],
                aliases: &[],
            },
            help: "What the account has",
        },
        FieldSpec {
            key: "provider",
            aliases: &["p"],
            kind: FieldKind::Exact,
            help: "Linked sign-in provider",
        },
        FieldSpec {
            key: "claim",
            aliases: &[],
            kind: FieldKind::Exact,
            help: "Custom claim",
        },
        FieldSpec {
            key: "created",
            aliases: &[],
            kind: FieldKind::Time,
            help: "When the account was created",
        },
        FieldSpec {
            key: "signed-in",
            aliases: &["last-sign-in"],
            kind: FieldKind::Time,
            help: "Last sign-in",
        },
        FieldSpec {
            key: "uid",
            aliases: &["id"],
            kind: FieldKind::Exact,
            help: "Account id",
        },
        FieldSpec {
            key: "email",
            aliases: &[],
            kind: FieldKind::Text,
            help: "Email address",
        },
        FieldSpec {
            key: "phone",
            aliases: &[],
            kind: FieldKind::Text,
            help: "Phone number",
        },
        FieldSpec {
            key: "name",
            aliases: &[],
            kind: FieldKind::Text,
            help: "Display name",
        },
    ],
    regex: false,
};

/// The Activity list and topic.
pub(crate) const ACTIVITY_FIELDS: FieldSet = FieldSet {
    fields: &[
        FieldSpec {
            key: "is",
            aliases: &[],
            kind: FieldKind::Enum {
                values: &["error", "new-user"],
                aliases: &[],
            },
            help: "What the call did",
        },
        FieldSpec {
            key: "kind",
            aliases: &[],
            kind: FieldKind::Enum {
                values: &[
                    "sign-in", "sign-up", "refresh", "code", "account", "config", "lookup", "other",
                ],
                aliases: &[],
            },
            help: "What kind of call",
        },
        FieldSpec {
            key: "caller",
            aliases: &[],
            kind: FieldKind::Enum {
                values: &["app", "admin", "console", "link", "picker", "emulator"],
                aliases: &[],
            },
            help: "Who called",
        },
        FieldSpec {
            key: "op",
            aliases: &[],
            kind: FieldKind::Text,
            help: "The operation, like signInWithPassword",
        },
        FieldSpec {
            key: "provider",
            aliases: &["p"],
            kind: FieldKind::Exact,
            help: "Sign-in provider",
        },
        FieldSpec {
            key: "uid",
            aliases: &["id"],
            kind: FieldKind::Exact,
            help: "Account id",
        },
        FieldSpec {
            key: "has",
            aliases: &[],
            kind: FieldKind::Enum {
                values: &["blocking", "trigger", "message", "change", "config"],
                aliases: &[],
            },
            help: "What the call caused",
        },
        FieldSpec {
            key: "status",
            aliases: &[],
            kind: FieldKind::Number,
            help: "HTTP status",
        },
        FieldSpec {
            key: "took",
            aliases: &[],
            kind: FieldKind::Duration,
            help: "How long the call took",
        },
        FieldSpec {
            key: "at",
            aliases: &[],
            kind: FieldKind::Time,
            help: "When the call was made",
        },
    ],
    regex: false,
};

/// The Inbox list and topic.
pub(crate) const MESSAGE_FIELDS: FieldSet = FieldSet {
    fields: &[
        FieldSpec {
            key: "is",
            aliases: &[],
            kind: FieldKind::Enum {
                values: &["used", "returned", "restored"],
                aliases: &[],
            },
            help: "What became of the message",
        },
        FieldSpec {
            key: "type",
            aliases: &[],
            kind: FieldKind::Enum {
                values: &["email", "sms"],
                aliases: &[],
            },
            help: "Email or SMS",
        },
        FieldSpec {
            key: "kind",
            aliases: &[],
            kind: FieldKind::Enum {
                values: &[
                    "verify",
                    "reset",
                    "sign-in",
                    "change",
                    "recover",
                    "sms",
                    "mfa-enroll",
                    "mfa-sign-in",
                ],
                aliases: &[],
            },
            help: "What the message is for",
        },
        FieldSpec {
            key: "uid",
            aliases: &["id"],
            kind: FieldKind::Exact,
            help: "Account id",
        },
        FieldSpec {
            key: "to",
            aliases: &[],
            kind: FieldKind::Text,
            help: "Recipient",
        },
        FieldSpec {
            key: "at",
            aliases: &[],
            kind: FieldKind::Time,
            help: "When it was sent",
        },
    ],
    regex: false,
};

/// The message for a `claim:` value without a key.
const CLAIM_MESSAGE: &str = "\"claim:\" is a claim key, or key=value, like claim:role=admin.";

/// "now", rounded down to the minute, so relative times resolve to the
/// same instant across a session's requests (and pinned match lists keep
/// matching).
pub(crate) fn now_minute() -> OffsetDateTime {
    let now = OffsetDateTime::now_utc();
    now.replace_second(0)
        .and_then(|now| now.replace_nanosecond(0))
        .unwrap_or(now)
}

fn millis(at: OffsetDateTime) -> i64 {
    i64::try_from(at.unix_timestamp_nanos() / 1_000_000).unwrap_or(i64::MAX)
}

/// A day value: `YYYY-MM-DD` or `today`, which names a whole day.
fn is_day(value: &str) -> bool {
    value.eq_ignore_ascii_case("today") || (value.len() == 10 && value.as_bytes()[4] == b'-')
}

const DAY_MS: i64 = 86_400_000;

/// A time term as a range `[from, until)` in epoch milliseconds. A day is
/// the whole day: `created:2026-10-01` is that day, `>` after it, `<`
/// before it. An instant (RFC 3339, `now`, `-7d`) is a point: `>` from the
/// next millisecond, `<` until it; with `:`, since it.
pub(crate) fn time_term(term: &FilterTerm, now: OffsetDateTime) -> TimeTerm {
    let at = parse_time(&term.value, now).map_or(0, millis);
    let day = is_day(&term.value);
    let (from, until) = match (term.op, day) {
        (FilterOp::Eq, true) => (Some(at), Some(at + DAY_MS)),
        (FilterOp::Eq, false) | (FilterOp::Ge, _) => (Some(at), None),
        (FilterOp::Gt, true) => (Some(at + DAY_MS), None),
        (FilterOp::Gt, false) => (Some(at + 1), None),
        (FilterOp::Lt, _) => (None, Some(at)),
        (FilterOp::Le, true) => (None, Some(at + DAY_MS)),
        (FilterOp::Le, false) => (None, Some(at + 1)),
    };
    TimeTerm {
        from,
        until,
        negated: term.negated,
    }
}

/// `claim:role` or `claim:role=admin`: a key, and a value read as JSON when
/// it is a JSON scalar (`true`, `3`, `null`, `"text"`), as a string
/// otherwise.
fn claim_match(term: &FilterTerm) -> Result<ClaimMatch, FilterError> {
    let refuse = || FilterError {
        message: CLAIM_MESSAGE.to_owned(),
        from: term.from,
        to: term.to,
    };
    match term.value.split_once('=') {
        None => Ok(ClaimMatch::key(term.value.clone())),
        Some(("", _)) => Err(refuse()),
        Some((key, value)) => {
            let value = match serde_json::from_str::<JsonValue>(value) {
                Ok(scalar @ (JsonValue::Bool(_) | JsonValue::Number(_) | JsonValue::Null)) => {
                    scalar
                }
                Ok(JsonValue::String(text)) => JsonValue::String(text),
                _ => JsonValue::String(value.to_owned()),
            };
            Ok(ClaimMatch::value(key, value))
        }
    }
}

fn choose<T>(choice: &mut Choice<T>, value: T, negated: bool) {
    if negated {
        choice.none_of.push(value);
    } else {
        choice.any_of.push(value);
    }
}

/// The users table's `q`, validated against [`USER_FIELDS`] and translated.
pub(crate) fn user_filter(q: &str, now: OffsetDateTime) -> Result<UserFilter, ApiError> {
    translate_users(&USER_FIELDS.parse(q)?, now).map_err(ApiError::from)
}

/// A validated users filter as auth-front's [`UserFilter`].
pub(crate) fn translate_users(
    query: &FilterQuery,
    now: OffsetDateTime,
) -> Result<UserFilter, FilterError> {
    let mut filter = UserFilter::default();
    for word in &query.words {
        filter.words.push(TextTerm {
            value: word.text.clone(),
            negated: word.negated,
        });
    }
    for term in &query.terms {
        let text = || TextTerm {
            value: term.value.clone(),
            negated: term.negated,
        };
        match term.key.as_str() {
            "email" => filter.email.push(text()),
            "name" => filter.name.push(text()),
            "phone" => filter.phone.push(text()),
            "uid" => choose(&mut filter.uid, IdMatch::parse(&term.value), term.negated),
            "provider" => choose(
                &mut filter.provider,
                IdMatch::parse(&term.value),
                term.negated,
            ),
            "is" => {
                if let Some(state) = UserState::parse(&term.value) {
                    choose(&mut filter.is, state, term.negated);
                }
            }
            "has" => {
                if let Some(has) = UserHas::parse(&term.value) {
                    choose(&mut filter.has, has, term.negated);
                }
            }
            "claim" => choose(&mut filter.claim, claim_match(term)?, term.negated),
            "created" => filter.created.push(time_term(term, now)),
            "signed-in" => filter.signed_in.push(time_term(term, now)),
            _ => {}
        }
    }
    Ok(filter)
}

// ---------------------------------------------------------------- matchers

/// One term's test on a list entry.
type Test<T> = Box<dyn Fn(&T) -> bool + Send + Sync>;

/// A compiled filter over entries of `T`: its base terms (which choose the
/// entries the facets count) and its facet terms.
pub(crate) struct Matcher<T> {
    base: Vec<Test<T>>,
    facets: Vec<Test<T>>,
}

impl<T> Matcher<T> {
    /// Every term holds.
    pub(crate) fn matches(&self, entry: &T) -> bool {
        self.base_matches(entry) && self.facets.iter().all(|test| test(entry))
    }

    /// Every base term holds (what the facets count over).
    pub(crate) fn base_matches(&self, entry: &T) -> bool {
        self.base.iter().all(|test| test(entry))
    }
}

/// Terms grouped as the grammar reads them: repeated plain terms of one
/// enum or exact key match any of their values; a negated term excludes;
/// every other term must hold.
fn grouped<T: 'static>(
    terms: &[FilterTerm],
    any_of_keys: &[&str],
    test: &dyn Fn(&FilterTerm) -> Test<T>,
    is_facet: &dyn Fn(&str) -> bool,
) -> Matcher<T> {
    let mut matcher = Matcher {
        base: Vec::new(),
        facets: Vec::new(),
    };
    let mut groups: Vec<(String, Vec<Test<T>>)> = Vec::new();
    for term in terms {
        let compiled = test(term);
        if term.negated {
            let excluded: Test<T> = Box::new(move |entry| !compiled(entry));
            if is_facet(&term.key) {
                matcher.facets.push(excluded);
            } else {
                matcher.base.push(excluded);
            }
        } else if term.op == FilterOp::Eq && any_of_keys.contains(&term.key.as_str()) {
            match groups.iter_mut().find(|(key, _)| *key == term.key) {
                Some((_, tests)) => tests.push(compiled),
                None => groups.push((term.key.clone(), vec![compiled])),
            }
        } else if is_facet(&term.key) {
            matcher.facets.push(compiled);
        } else {
            matcher.base.push(compiled);
        }
    }
    for (key, tests) in groups {
        let any: Test<T> = Box::new(move |entry| tests.iter().any(|test| test(entry)));
        if is_facet(&key) {
            matcher.facets.push(any);
        } else {
            matcher.base.push(any);
        }
    }
    matcher
}

fn contains(haystack: Option<&str>, needle: &str) -> bool {
    haystack.is_some_and(|haystack| haystack.to_lowercase().contains(needle))
}

fn exact(value: Option<&str>, wanted: &IdMatch) -> bool {
    value.is_some_and(|value| match wanted {
        IdMatch::Exact(exact) => value == exact,
        IdMatch::Prefix(prefix) => value.starts_with(prefix.as_str()),
    })
}

/// A number or duration comparison.
fn compare(op: FilterOp, actual: f64, wanted: f64) -> bool {
    match op {
        FilterOp::Eq => (actual - wanted).abs() < f64::EPSILON,
        FilterOp::Gt => actual > wanted,
        FilterOp::Ge => actual >= wanted,
        FilterOp::Lt => actual < wanted,
        FilterOp::Le => actual <= wanted,
    }
}

/// A word test for text fields, lower-cased once.
fn word_test<T: 'static>(word: &str, fields: fn(&T) -> Vec<Option<&str>>) -> Test<T> {
    let needle = word.to_lowercase();
    Box::new(move |entry| {
        fields(entry)
            .into_iter()
            .any(|field| contains(field, &needle))
    })
}

const fn caller_value(caller: AuthCaller) -> &'static str {
    match caller {
        AuthCaller::Client => "app",
        AuthCaller::Admin => "admin",
        AuthCaller::Console => "console",
        AuthCaller::ActionLink => "link",
        AuthCaller::AccountPicker => "picker",
        AuthCaller::EmulatorApi => "emulator",
    }
}

const fn kind_value(kind: AuthCallKind) -> &'static str {
    match kind {
        AuthCallKind::SignIn => "sign-in",
        AuthCallKind::SignUp => "sign-up",
        AuthCallKind::Refresh => "refresh",
        AuthCallKind::Code => "code",
        AuthCallKind::Account => "account",
        AuthCallKind::Config => "config",
        AuthCallKind::Lookup => "lookup",
        AuthCallKind::Other => "other",
    }
}

fn at_of(entry: &ActivityEntry) -> i64 {
    OffsetDateTime::parse(
        &entry.summary.at,
        &time::format_description::well_known::Rfc3339,
    )
    .map_or(0, millis)
}

fn activity_words(entry: &ActivityEntry) -> Vec<Option<&str>> {
    vec![
        entry.summary.identifier.as_deref(),
        entry.summary.uid.as_deref(),
        Some(entry.summary.operation.as_str()),
        Some(entry.summary.path.as_str()),
        entry.error_code.as_deref(),
    ]
}

/// The Activity filter: `q` (validated against [`ACTIVITY_FIELDS`]), the
/// tenant scope (`None` every tenant, `(none)` project calls, else that
/// tenant), and whether the console's own writes are shown.
pub(crate) struct ActivityFilter {
    project: String,
    tenant: Option<String>,
    console: bool,
    matcher: Matcher<ActivityEntry>,
}

impl ActivityFilter {
    pub(crate) fn new(
        project: &str,
        tenant: Option<&str>,
        q: &str,
        console: bool,
        now: OffsetDateTime,
    ) -> Result<Self, ApiError> {
        let query = ACTIVITY_FIELDS.parse(q)?;
        let mut words: Vec<Test<ActivityEntry>> = query
            .words
            .iter()
            .map(|word| {
                let test = word_test(&word.text, activity_words);
                if word.negated {
                    Box::new(move |entry: &ActivityEntry| !test(entry)) as Test<ActivityEntry>
                } else {
                    test
                }
            })
            .collect();
        let test = |term: &FilterTerm| -> Test<ActivityEntry> {
            let value = term.value.clone();
            match term.key.as_str() {
                "is" => match value.as_str() {
                    "error" => Box::new(|entry: &ActivityEntry| entry.summary.status >= 400),
                    _ => Box::new(|entry: &ActivityEntry| entry.summary.new_user == Some(true)),
                },
                "kind" => Box::new(move |entry| kind_value(entry.summary.kind) == value),
                "caller" => Box::new(move |entry| caller_value(entry.summary.caller) == value),
                "op" => {
                    let needle = value.to_lowercase();
                    Box::new(move |entry| contains(Some(&entry.summary.operation), &needle))
                }
                "provider" => {
                    let wanted = IdMatch::parse(&value);
                    Box::new(move |entry| exact(entry.summary.provider.as_deref(), &wanted))
                }
                "uid" => {
                    let wanted = IdMatch::parse(&value);
                    Box::new(move |entry| exact(entry.summary.uid.as_deref(), &wanted))
                }
                "has" => {
                    let flag = match value.as_str() {
                        "blocking" => has::BLOCKING,
                        "trigger" => has::TRIGGER,
                        "message" => has::MESSAGE,
                        "change" => has::CHANGE,
                        _ => has::CONFIG,
                    };
                    Box::new(move |entry| entry.has & flag != 0)
                }
                "status" => {
                    let wanted = parse_number(&value).unwrap_or_default();
                    let op = term.op;
                    Box::new(move |entry| compare(op, f64::from(entry.summary.status), wanted))
                }
                "took" => {
                    let wanted = parse_duration(&value).unwrap_or_default().as_secs_f64() * 1e6;
                    let op = term.op;
                    #[allow(
                        clippy::cast_precision_loss,
                        reason = "a call's duration in microseconds, far below 2^52"
                    )]
                    Box::new(move |entry| compare(op, entry.summary.duration_micros as f64, wanted))
                }
                _ => {
                    let range = time_term(term, now);
                    let range = TimeTerm {
                        negated: false,
                        ..range
                    };
                    Box::new(move |entry| range_contains(&range, at_of(entry)))
                }
            }
        };
        let mut matcher = grouped(
            &query.terms,
            &["is", "kind", "caller", "provider", "uid", "has"],
            &test,
            &|key| matches!(key, "is" | "kind" | "caller"),
        );
        matcher.base.append(&mut words);
        Ok(Self {
            project: project.to_owned(),
            tenant: tenant.map(str::to_owned),
            console,
            matcher,
        })
    }

    /// Whether the entry is in the page's scope (project, tenant, the
    /// console's writes).
    pub(crate) fn in_scope(&self, entry: &ActivityEntry) -> bool {
        entry.summary.project == self.project
            && match self.tenant.as_deref() {
                None => true,
                Some("(none)") => entry.summary.tenant.is_none(),
                Some(tenant) => entry.summary.tenant.as_deref() == Some(tenant),
            }
            && (self.console || entry.summary.origin != Some(AuthConsoleOrigin::Write))
    }

    pub(crate) fn matches(&self, entry: &ActivityEntry) -> bool {
        self.in_scope(entry) && self.matcher.matches(entry)
    }

    pub(crate) fn base_matches(&self, entry: &ActivityEntry) -> bool {
        self.in_scope(entry) && self.matcher.base_matches(entry)
    }

    pub(crate) fn project(&self) -> &str {
        &self.project
    }
}

fn range_contains(range: &TimeTerm, at: i64) -> bool {
    range.from.is_none_or(|from| at >= from) && range.until.is_none_or(|until| at < until)
}

const fn message_kind_value(kind: super::wire::AuthMessageKind) -> &'static str {
    use super::wire::AuthMessageKind;
    match kind {
        AuthMessageKind::VerifyEmail => "verify",
        AuthMessageKind::PasswordReset => "reset",
        AuthMessageKind::EmailSignIn => "sign-in",
        AuthMessageKind::VerifyAndChangeEmail => "change",
        AuthMessageKind::RecoverEmail => "recover",
        AuthMessageKind::SmsSignIn => "sms",
        AuthMessageKind::SmsMfaEnrollment => "mfa-enroll",
        AuthMessageKind::SmsMfaSignIn => "mfa-sign-in",
    }
}

fn message_words(entry: &MessageEntry) -> Vec<Option<&str>> {
    vec![
        Some(entry.record.to.as_str()),
        Some(entry.record.code.as_str()),
        entry.record.uid.as_deref(),
    ]
}

/// The Inbox filter: `q` (validated against [`MESSAGE_FIELDS`]) and the
/// tenant scope, as Activity's.
pub(crate) struct MessageFilter {
    project: String,
    tenant: Option<String>,
    matcher: Matcher<MessageEntry>,
}

impl MessageFilter {
    pub(crate) fn new(
        project: &str,
        tenant: Option<&str>,
        q: &str,
        now: OffsetDateTime,
    ) -> Result<Self, ApiError> {
        let query = MESSAGE_FIELDS.parse(q)?;
        let mut words: Vec<Test<MessageEntry>> = query
            .words
            .iter()
            .map(|word| {
                let test = word_test(&word.text, message_words);
                if word.negated {
                    Box::new(move |entry: &MessageEntry| !test(entry)) as Test<MessageEntry>
                } else {
                    test
                }
            })
            .collect();
        let test = |term: &FilterTerm| -> Test<MessageEntry> {
            let value = term.value.clone();
            match term.key.as_str() {
                "is" => match value.as_str() {
                    "used" => Box::new(|entry: &MessageEntry| {
                        entry
                            .used
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner)
                            .is_some()
                    }),
                    "returned" => Box::new(|entry: &MessageEntry| {
                        AuthMessageDelivery::from(entry.record.delivery)
                            == AuthMessageDelivery::Returned
                    }),
                    _ => Box::new(|entry: &MessageEntry| {
                        AuthMessageDelivery::from(entry.record.delivery)
                            == AuthMessageDelivery::Restored
                    }),
                },
                "type" => Box::new(move |entry| {
                    (if entry.record.kind.is_sms() {
                        "sms"
                    } else {
                        "email"
                    }) == value
                }),
                "kind" => {
                    Box::new(move |entry| message_kind_value(entry.record.kind.into()) == value)
                }
                "uid" => {
                    let wanted = IdMatch::parse(&value);
                    Box::new(move |entry| exact(entry.record.uid.as_deref(), &wanted))
                }
                "to" => {
                    let needle = value.to_lowercase();
                    Box::new(move |entry| contains(Some(&entry.record.to), &needle))
                }
                _ => {
                    let range = TimeTerm {
                        negated: false,
                        ..time_term(term, now)
                    };
                    Box::new(move |entry| {
                        entry
                            .record
                            .at_millis
                            .is_some_and(|at| range_contains(&range, at))
                    })
                }
            }
        };
        let mut matcher = grouped(
            &query.terms,
            &["is", "type", "kind", "uid"],
            &test,
            &|key| matches!(key, "is" | "type" | "kind"),
        );
        matcher.base.append(&mut words);
        Ok(Self {
            project: project.to_owned(),
            tenant: tenant.map(str::to_owned),
            matcher,
        })
    }

    pub(crate) fn in_scope(&self, entry: &MessageEntry) -> bool {
        entry.record.project == self.project
            && match self.tenant.as_deref() {
                None => true,
                Some("(none)") => entry.record.tenant.is_none(),
                Some(tenant) => entry.record.tenant.as_deref() == Some(tenant),
            }
    }

    pub(crate) fn matches(&self, entry: &MessageEntry) -> bool {
        self.in_scope(entry) && self.matcher.matches(entry)
    }

    pub(crate) fn base_matches(&self, entry: &MessageEntry) -> bool {
        self.in_scope(entry) && self.matcher.base_matches(entry)
    }

    pub(crate) fn project(&self) -> &str {
        &self.project
    }
}

#[cfg(test)]
#[path = "filter_tests.rs"]
mod tests;
