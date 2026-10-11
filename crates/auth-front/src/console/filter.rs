//! The structured filter the console's users table is read with.
//!
//! The console's filter field is text in the shared filter grammar
//! (`provider:google.com -is:verified created:>-7d ada`); the console layer
//! parses and validates it and translates it into a [`UserFilter`], because
//! the index that evaluates it lives here. The semantics are the grammar's:
//! every term and word must hold; repeated plain terms of one `is`, `has`,
//! `provider`, `claim` or `uid` key are any-of; negated terms each exclude;
//! several ranges on one time key all apply.
//!
//! Terms split in two groups. Base terms (`words`, `email`, `name`, `phone`,
//! `uid`, `created`, `signedIn`) choose which users the facet counts are
//! taken over; facet terms (`is`, `has`, `provider`, `claim`) do not, so a
//! facet's count does not change when that facet is pressed.

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value as JsonValue;

/// What the console asks of the users table.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UserFilter {
    /// Bare words: each is a substring of the email, the phone's digits, the
    /// uid or the display name, case-insensitively; a word of at least three
    /// digits once ` -()+.` are dropped is also compared with the phone's digits.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub words: Vec<TextTerm>,
    /// `email:` — a case-insensitive substring of the email.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub email: Vec<TextTerm>,
    /// `name:` — a case-insensitive substring of the display name.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub name: Vec<TextTerm>,
    /// `phone:` — compared as digits: `5550100` finds `+15550100`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub phone: Vec<TextTerm>,
    /// `uid:` — exact, or a prefix (`sample-*`).
    #[serde(default, skip_serializing_if = "Choice::is_empty")]
    pub uid: Choice<IdMatch>,
    /// `created:` — `createdAt`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub created: Vec<TimeTerm>,
    /// `signed-in:` — `lastLoginAt`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub signed_in: Vec<TimeTerm>,
    /// `is:` — account state.
    #[serde(default, skip_serializing_if = "Choice::is_empty")]
    pub is: Choice<UserState>,
    /// `has:` — what the account has.
    #[serde(default, skip_serializing_if = "Choice::is_empty")]
    pub has: Choice<UserHas>,
    /// `provider:` — a linked provider id, exact or a prefix (`saml.*`).
    #[serde(default, skip_serializing_if = "Choice::is_empty")]
    pub provider: Choice<IdMatch>,
    /// `claim:` — a custom claim key, or a key with a JSON scalar value.
    #[serde(default, skip_serializing_if = "Choice::is_empty")]
    pub claim: Choice<ClaimMatch>,
}

impl UserFilter {
    /// No term at all: every user in scope matches.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        !self.has_base_terms() && !self.has_facet_terms()
    }

    /// Words, `email`, `name`, `phone`, `uid`, `created` or `signedIn` terms.
    #[must_use]
    pub fn has_base_terms(&self) -> bool {
        !(self.words.is_empty()
            && self.email.is_empty()
            && self.name.is_empty()
            && self.phone.is_empty()
            && self.uid.is_empty()
            && self.created.is_empty()
            && self.signed_in.is_empty())
    }

    /// `is`, `has`, `provider` or `claim` terms.
    #[must_use]
    pub fn has_facet_terms(&self) -> bool {
        !(self.is.is_empty()
            && self.has.is_empty()
            && self.provider.is_empty()
            && self.claim.is_empty())
    }

    /// A stable text form, so two requests with the same filter are known to
    /// be the same.
    pub(crate) fn key(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }
}

/// A text term or a word, and whether it was negated (`-ada`).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextTerm {
    pub value: String,
    #[serde(default, skip_serializing_if = "is_false")]
    pub negated: bool,
}

impl TextTerm {
    #[must_use]
    pub fn new(value: impl Into<String>) -> Self {
        Self {
            value: value.into(),
            negated: false,
        }
    }

    #[must_use]
    pub fn negated(value: impl Into<String>) -> Self {
        Self {
            value: value.into(),
            negated: true,
        }
    }
}

/// A time range in epoch milliseconds, `from` inclusive and `until`
/// exclusive (`created:>2026-10-01` is `from` the next millisecond; a day is
/// `from` its start `until` the next day's). A user without the time never
/// matches a range, so it always passes a negated one.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TimeTerm {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub until: Option<i64>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub negated: bool,
}

impl TimeTerm {
    pub(crate) fn contains(&self, value: Option<i64>) -> bool {
        value.is_some_and(|value| {
            self.from.is_none_or(|from| value >= from)
                && self.until.is_none_or(|until| value < until)
        })
    }
}

/// Repeated plain terms of one key (any of them) and its negated terms
/// (none of them).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Choice<T> {
    #[serde(default = "Vec::new", skip_serializing_if = "Vec::is_empty")]
    pub any_of: Vec<T>,
    #[serde(default = "Vec::new", skip_serializing_if = "Vec::is_empty")]
    pub none_of: Vec<T>,
}

impl<T> Default for Choice<T> {
    fn default() -> Self {
        Self {
            any_of: Vec::new(),
            none_of: Vec::new(),
        }
    }
}

impl<T> Choice<T> {
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.any_of.is_empty() && self.none_of.is_empty()
    }

    /// Whether `matches` admits the value: one of `any_of` (when there are
    /// any) and none of `none_of`.
    pub(crate) fn admits(&self, mut matches: impl FnMut(&T) -> bool) -> bool {
        (self.any_of.is_empty() || self.any_of.iter().any(&mut matches))
            && !self.none_of.iter().any(matches)
    }
}

/// An exact id or a prefix (the trailing `*` of `uid:sample-*`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IdMatch {
    Exact(String),
    Prefix(String),
}

impl IdMatch {
    /// `value`, or a prefix when it ends with `*`.
    #[must_use]
    pub fn parse(value: &str) -> Self {
        match value.strip_suffix('*') {
            Some(prefix) => Self::Prefix(prefix.to_owned()),
            None => Self::Exact(value.to_owned()),
        }
    }

    pub(crate) fn matches(&self, value: &str) -> bool {
        match self {
            Self::Exact(exact) => value == exact,
            Self::Prefix(prefix) => value.starts_with(prefix.as_str()),
        }
    }
}

/// `is:` values.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum UserState {
    /// The account is disabled.
    Disabled,
    /// The email is verified.
    Verified,
    /// No linked provider and no custom-token sign-in.
    Anonymous,
    /// Signed in with a custom token (`customAuth`).
    CustomToken,
    /// A sample user: the uid starts with `sample-`.
    Sample,
}

impl UserState {
    pub const ALL: [Self; 5] = [
        Self::Disabled,
        Self::Verified,
        Self::Anonymous,
        Self::CustomToken,
        Self::Sample,
    ];

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Disabled => "disabled",
            Self::Verified => "verified",
            Self::Anonymous => "anonymous",
            Self::CustomToken => "custom-token",
            Self::Sample => "sample",
        }
    }

    #[must_use]
    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|state| state.as_str() == value)
    }
}

/// `has:` values.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum UserHas {
    Email,
    Phone,
    /// A password hash.
    Password,
    /// At least one second factor.
    Mfa,
    /// At least one custom claim.
    Claims,
    Photo,
    Name,
    /// A recorded sign-in (`lastLoginAt`).
    SignIn,
}

impl UserHas {
    pub const ALL: [Self; 8] = [
        Self::Email,
        Self::Phone,
        Self::Password,
        Self::Mfa,
        Self::Claims,
        Self::Photo,
        Self::Name,
        Self::SignIn,
    ];

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Email => "email",
            Self::Phone => "phone",
            Self::Password => "password",
            Self::Mfa => "mfa",
            Self::Claims => "claims",
            Self::Photo => "photo",
            Self::Name => "name",
            Self::SignIn => "sign-in",
        }
    }

    #[must_use]
    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|has| has.as_str() == value)
    }
}

/// `claim:role` (the key is present, whatever its value) or
/// `claim:plan=pro` (the key holds this value, compared as JSON; numbers by
/// value, so `3` equals `3.0`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClaimMatch {
    pub key: String,
    /// Absent: any value. Present, even `null`: exactly that value.
    #[serde(
        default,
        deserialize_with = "present_value",
        skip_serializing_if = "Option::is_none"
    )]
    pub value: Option<JsonValue>,
}

impl ClaimMatch {
    #[must_use]
    pub fn key(key: impl Into<String>) -> Self {
        Self {
            key: key.into(),
            value: None,
        }
    }

    #[must_use]
    pub fn value(key: impl Into<String>, value: JsonValue) -> Self {
        Self {
            key: key.into(),
            value: Some(value),
        }
    }
}

/// A present `value` is `Some`, even when it is `null`.
fn present_value<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<JsonValue>, D::Error> {
    JsonValue::deserialize(deserializer).map(Some)
}

/// JSON equality with numbers compared by value.
pub(crate) fn json_equal(left: &JsonValue, right: &JsonValue) -> bool {
    match (left, right) {
        (JsonValue::Number(left), JsonValue::Number(right)) => {
            match (left.as_i64(), right.as_i64()) {
                (Some(left), Some(right)) => left == right,
                _ => match (left.as_u64(), right.as_u64()) {
                    (Some(left), Some(right)) => left == right,
                    _ => left.as_f64() == right.as_f64(),
                },
            }
        }
        _ => left == right,
    }
}

/// The digits of a phone number or a phone term.
pub(crate) fn digits(text: &str) -> String {
    text.chars().filter(char::is_ascii_digit).collect()
}

/// A word that reads as a phone number: at least three digits once ` -()+.`
/// are dropped, and nothing else.
pub(crate) fn phone_word(word: &str) -> Option<String> {
    let stripped: String = word
        .chars()
        .filter(|character| !matches!(character, ' ' | '-' | '(' | ')' | '+' | '.'))
        .collect();
    (stripped.len() >= 3 && stripped.chars().all(|character| character.is_ascii_digit()))
        .then_some(stripped)
}

#[allow(clippy::trivially_copy_pass_by_ref)]
const fn is_false(value: &bool) -> bool {
    !*value
}
