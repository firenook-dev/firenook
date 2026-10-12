//! A console filter, evaluated against objects and folders.
//!
//! The console parses and validates the filter text in its one grammar and
//! hands down what each term means, already resolved: sizes in bytes,
//! times in Unix milliseconds, keys canonical. This module only answers
//! "does this entry match", so every listing, view and bulk target shares
//! one meaning of a filter.
//!
//! Every clause must hold; a clause holds when any of its predicates does
//! (the grammar's "a key repeated with `:` matches any of its values"), or,
//! negated, when none does. Folders are matched by name only: a filter with
//! any other clause lists files alone.

use crate::StoredObject;

/// A validated filter: every clause must hold.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct StorageFilter {
    pub clauses: Vec<FilterClause>,
}

/// Predicates of which one must hold, or, negated, none may.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FilterClause {
    pub any: Vec<FilterPredicate>,
    pub negated: bool,
}

/// One thing an entry can be asked.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FilterPredicate {
    /// The name below the folder contains this text, case-insensitively
    /// (given lowercased).
    Name(String),
    /// The contentType equals `value`, or starts with it when `prefix`.
    Type { value: String, prefix: bool },
    /// The size in bytes lies in `[min, max]` (either end open).
    Size { min: Option<u64>, max: Option<u64> },
    /// The last update, Unix milliseconds, lies in `[from, until)`.
    Updated {
        from: Option<i64>,
        until: Option<i64>,
    },
    /// The creation time, Unix milliseconds, lies in `[from, until)`.
    Created {
        from: Option<i64>,
        until: Option<i64>,
    },
    /// A custom metadata value: equal to `value` (or starting with it when
    /// `prefix`), or ordered against it: numerically when both are numbers,
    /// else as text.
    Meta {
        key: String,
        compare: MetaCompare,
        value: String,
        prefix: bool,
    },
    /// The object has this field.
    Has(HasField),
}

/// How a metadata value compares.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MetaCompare {
    Eq,
    Gt,
    Ge,
    Lt,
    Le,
}

/// What `has:` asks about.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HasField {
    /// A download token.
    Token,
    /// A contentType.
    Type,
    /// Any custom metadata.
    Metadata,
    /// A contentEncoding.
    Encoding,
    /// A cacheControl.
    Cache,
}

impl StorageFilter {
    /// A filter with no clauses matches everything.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.clauses.is_empty()
    }

    /// Whether only names are asked about, so folders can match too.
    #[must_use]
    pub fn names_only(&self) -> bool {
        self.clauses.iter().all(|clause| {
            clause
                .any
                .iter()
                .all(|predicate| matches!(predicate, FilterPredicate::Name(_)))
        })
    }

    /// Whether the filter reads anything but what a folder level's summary
    /// of each object holds (its name, size, update time, type and which
    /// fields it has): metadata values and creation times need the object.
    pub(crate) fn needs_objects(&self) -> bool {
        self.clauses.iter().any(|clause| {
            clause.any.iter().any(|predicate| {
                matches!(
                    predicate,
                    FilterPredicate::Meta { .. } | FilterPredicate::Created { .. }
                )
            })
        })
    }

    /// Whether a folder whose name below the listed folder is `relative`
    /// matches.
    #[must_use]
    pub fn matches_folder(&self, relative: &str) -> bool {
        self.names_only()
            && self.clauses.iter().all(|clause| {
                clause.negated
                    != clause.any.iter().any(|predicate| match predicate {
                        FilterPredicate::Name(text) => contains_folded(relative, text),
                        _ => false,
                    })
            })
    }

    /// Whether `object`, whose name below the listed folder is `relative`,
    /// matches.
    pub(crate) fn matches_object(&self, relative: &str, object: &StoredObject) -> bool {
        self.matches_facts(relative, &ObjectFacts::of(object), Some(object))
    }

    /// Whether an object described by `facts` matches; `object` is needed
    /// only when [`Self::needs_objects`].
    pub(crate) fn matches_facts(
        &self,
        relative: &str,
        facts: &ObjectFacts<'_>,
        object: Option<&StoredObject>,
    ) -> bool {
        self.clauses.iter().all(|clause| {
            clause.negated
                != clause
                    .any
                    .iter()
                    .any(|predicate| predicate_holds(predicate, relative, facts, object))
        })
    }
}

/// What a filter reads of an object besides metadata values and the
/// creation time.
#[allow(
    clippy::struct_excessive_bools,
    reason = "one flag per field a filter can ask about"
)]
pub(crate) struct ObjectFacts<'a> {
    pub(crate) size: u64,
    pub(crate) updated_ms: Option<i64>,
    pub(crate) content_type: Option<&'a str>,
    pub(crate) token: bool,
    pub(crate) metadata: bool,
    pub(crate) encoding: bool,
    pub(crate) cache: bool,
}

impl<'a> ObjectFacts<'a> {
    pub(crate) fn of(object: &'a StoredObject) -> Self {
        Self {
            size: object.size,
            updated_ms: crate::folder_index::rfc3339_millis(&object.updated),
            content_type: object.content_type.as_deref(),
            token: !object.download_tokens.is_empty(),
            metadata: !object.custom_metadata.is_empty(),
            encoding: object.content_encoding.is_some(),
            cache: object.cache_control.is_some(),
        }
    }
}

fn in_range<T: PartialOrd + Copy>(
    value: T,
    from: Option<T>,
    until: Option<T>,
    until_inclusive: bool,
) -> bool {
    from.is_none_or(|from| value >= from)
        && until.is_none_or(|until| {
            if until_inclusive {
                value <= until
            } else {
                value < until
            }
        })
}

fn predicate_holds(
    predicate: &FilterPredicate,
    relative: &str,
    facts: &ObjectFacts<'_>,
    object: Option<&StoredObject>,
) -> bool {
    match predicate {
        FilterPredicate::Name(text) => contains_folded(relative, text),
        FilterPredicate::Type { value, prefix } => facts.content_type.is_some_and(|content_type| {
            if *prefix {
                content_type.starts_with(value.as_str())
            } else {
                content_type == value
            }
        }),
        FilterPredicate::Size { min, max } => in_range(facts.size, *min, *max, true),
        FilterPredicate::Updated { from, until } => facts
            .updated_ms
            .is_some_and(|updated| in_range(updated, *from, *until, false)),
        FilterPredicate::Created { from, until } => object
            .and_then(|object| crate::folder_index::rfc3339_millis(&object.time_created))
            .is_some_and(|created| in_range(created, *from, *until, false)),
        FilterPredicate::Meta {
            key,
            compare,
            value,
            prefix,
        } => object
            .and_then(|object| object.custom_metadata.get(key))
            .is_some_and(|actual| meta_holds(actual, *compare, value, *prefix)),
        FilterPredicate::Has(field) => match field {
            HasField::Token => facts.token,
            HasField::Type => facts.content_type.is_some(),
            HasField::Metadata => facts.metadata,
            HasField::Encoding => facts.encoding,
            HasField::Cache => facts.cache,
        },
    }
}

fn meta_holds(actual: &str, compare: MetaCompare, value: &str, prefix: bool) -> bool {
    if compare == MetaCompare::Eq {
        return if prefix {
            actual.starts_with(value)
        } else {
            actual == value
        };
    }
    let ordering = match (actual.parse::<f64>(), value.parse::<f64>()) {
        (Ok(left), Ok(right)) if left.is_finite() && right.is_finite() => left.partial_cmp(&right),
        _ => Some(actual.cmp(value)),
    };
    let Some(ordering) = ordering else {
        return false;
    };
    match compare {
        MetaCompare::Gt => ordering.is_gt(),
        MetaCompare::Ge => ordering.is_ge(),
        MetaCompare::Lt => ordering.is_lt(),
        MetaCompare::Le => ordering.is_le(),
        MetaCompare::Eq => ordering.is_eq(),
    }
}

/// Whether `haystack` contains `needle` (already lowercased),
/// case-insensitively: byte comparison when both are ASCII, full Unicode
/// lowercasing otherwise.
pub(crate) fn contains_folded(haystack: &str, needle: &str) -> bool {
    if needle.is_empty() {
        return true;
    }
    if haystack.is_ascii() && needle.is_ascii() {
        let needle = needle.as_bytes();
        return haystack
            .as_bytes()
            .windows(needle.len())
            .any(|window| window.eq_ignore_ascii_case(needle));
    }
    haystack.to_lowercase().contains(needle)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;

    fn object(name: &str) -> StoredObject {
        StoredObject {
            name: name.to_owned(),
            bucket: "b".to_owned(),
            generation: 1,
            metageneration: 1,
            content_type: Some("image/png".to_owned()),
            storage_class: "STANDARD".to_owned(),
            content_disposition: None,
            content_encoding: None,
            content_language: None,
            cache_control: None,
            download_tokens: vec!["t".to_owned()],
            custom_metadata: BTreeMap::from([
                ("ownerUid".to_owned(), "u_9f3k2".to_owned()),
                ("width".to_owned(), "640".to_owned()),
            ]),
            time_created: "2026-10-01T08:00:00Z".to_owned(),
            updated: "2026-10-02T08:00:00Z".to_owned(),
            size: 6 * 1024 * 1024,
            md5_hash: String::new(),
            crc32c: 0,
            etag: String::new(),
            data_file: String::new(),
        }
    }

    fn clause(predicate: FilterPredicate) -> FilterClause {
        FilterClause {
            any: vec![predicate],
            negated: false,
        }
    }

    fn negated(predicate: FilterPredicate) -> FilterClause {
        FilterClause {
            any: vec![predicate],
            negated: true,
        }
    }

    fn filter(clauses: Vec<FilterClause>) -> StorageFilter {
        StorageFilter { clauses }
    }

    #[test]
    fn filter_terms() {
        let photo = object("users/u1/Photo.PNG");
        let relative = "Photo.PNG";
        let holds = |clauses: Vec<FilterClause>| filter(clauses).matches_object(relative, &photo);
        assert!(holds(vec![clause(FilterPredicate::Name(
            "photo".to_owned()
        ))]));
        assert!(
            !holds(vec![clause(FilterPredicate::Name("u1".to_owned()))]),
            "below the folder only"
        );
        assert!(holds(vec![clause(FilterPredicate::Type {
            value: "image/".to_owned(),
            prefix: true
        })]));
        assert!(!holds(vec![clause(FilterPredicate::Type {
            value: "image/".to_owned(),
            prefix: false
        })]));
        // Repeated equality on one key: any of them.
        assert!(holds(vec![FilterClause {
            any: vec![
                FilterPredicate::Type {
                    value: "video/".to_owned(),
                    prefix: true
                },
                FilterPredicate::Type {
                    value: "image/png".to_owned(),
                    prefix: false
                },
            ],
            negated: false,
        }]));
        assert!(holds(vec![clause(FilterPredicate::Size {
            min: Some(5 * 1024 * 1024 + 1),
            max: None
        })]));
        assert!(!holds(vec![clause(FilterPredicate::Size {
            min: None,
            max: Some(512)
        })]));
        let day = |text: &str| crate::folder_index::rfc3339_millis(text).expect("time");
        assert!(holds(vec![clause(FilterPredicate::Updated {
            from: Some(day("2026-10-02T00:00:00Z")),
            until: Some(day("2026-10-03T00:00:00Z")),
        })]));
        assert!(holds(vec![clause(FilterPredicate::Created {
            from: None,
            until: Some(day("2026-10-02T00:00:00Z")),
        })]));
        assert!(holds(vec![clause(FilterPredicate::Meta {
            key: "ownerUid".to_owned(),
            compare: MetaCompare::Eq,
            value: "u_9f3k2".to_owned(),
            prefix: false,
        })]));
        assert!(
            !holds(vec![clause(FilterPredicate::Meta {
                key: "owneruid".to_owned(),
                compare: MetaCompare::Eq,
                value: "u_9f3k2".to_owned(),
                prefix: false,
            })]),
            "the key keeps its case"
        );
        assert!(
            holds(vec![clause(FilterPredicate::Meta {
                key: "width".to_owned(),
                compare: MetaCompare::Gt,
                value: "99".to_owned(),
                prefix: false,
            })]),
            "numbers compare as numbers"
        );
        assert!(holds(vec![clause(FilterPredicate::Has(HasField::Token))]));
        assert!(holds(vec![negated(FilterPredicate::Has(
            HasField::Encoding
        ))]));
        // Each negated term excludes on its own.
        assert!(!holds(vec![
            negated(FilterPredicate::Has(HasField::Cache)),
            negated(FilterPredicate::Has(HasField::Type)),
        ]));
        // Folders match words only.
        let words = filter(vec![clause(FilterPredicate::Name("users".to_owned()))]);
        assert!(words.matches_folder("users/"));
        let typed = filter(vec![
            clause(FilterPredicate::Name("users".to_owned())),
            clause(FilterPredicate::Has(HasField::Token)),
        ]);
        assert!(!typed.matches_folder("users/"));
        assert!(!typed.names_only());
    }

    #[test]
    fn filter_is_case_insensitive_unicode() {
        let summer = object("été.png");
        let filter = filter(vec![clause(FilterPredicate::Name("été".to_owned()))]);
        assert!(filter.matches_object("ÉTÉ.png", &summer));
        assert!(filter.matches_object("été.png", &summer));
        assert!(contains_folded("Report-FINAL.pdf", "final"));
        assert!(!contains_folded("Report.pdf", "final"));
    }
}
