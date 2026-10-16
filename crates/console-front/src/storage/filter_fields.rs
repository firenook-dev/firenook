//! Storage's filter fields in the console's one grammar, and how a parsed
//! filter becomes what the engine evaluates.
//!
//! Words and `name:` match the name below the folder; `type:` the
//! contentType (a trailing `*` matches by prefix); `size:` bytes; `updated:`
//! and `created:` times (a day for a date, since the moment otherwise);
//! `meta.<key>:` a custom metadata value (the key keeps its case); `has:`
//! the fields an object has. A key repeated with `:` matches any of its
//! values, and every negated term excludes on its own.

use firenook_storage_front::{FilterClause, FilterPredicate, HasField, MetaCompare, StorageFilter};
use time::OffsetDateTime;

use crate::filter::{
    FieldKind, FieldSet, FieldSpec, FilterOp, FilterQuery, parse_bytes, parse_time,
};

/// Storage's filter fields, served in `GET /storage/objects/meta`.
pub(crate) static STORAGE_FILTER_FIELDS: FieldSet = FieldSet {
    fields: &[
        FieldSpec {
            key: "name",
            aliases: &[],
            kind: FieldKind::Text,
            help: "Name below the folder",
        },
        FieldSpec {
            key: "type",
            aliases: &["contenttype"],
            kind: FieldKind::Exact,
            help: "Content type, like type:image/*",
        },
        FieldSpec {
            key: "size",
            aliases: &[],
            kind: FieldKind::Bytes,
            help: "Size, like size:>5MB",
        },
        FieldSpec {
            key: "updated",
            aliases: &[],
            kind: FieldKind::Time,
            help: "Last changed, like updated:>-1h",
        },
        FieldSpec {
            key: "created",
            aliases: &[],
            kind: FieldKind::Time,
            help: "Created, like created:<2026-10-01",
        },
        FieldSpec {
            key: "meta",
            aliases: &[],
            kind: FieldKind::Path {
                prefixes: &["meta."],
            },
            help: "Custom metadata, like meta.ownerUid:u_9f3k2",
        },
        FieldSpec {
            key: "has",
            aliases: &[],
            kind: FieldKind::Enum {
                values: &["token", "type", "metadata", "encoding", "cache"],
                aliases: &[],
            },
            help: "Has a field: has:token, -has:type",
        },
    ],
    regex: false,
};

const DAY_MS: i64 = 86_400_000;

fn millis(time: OffsetDateTime) -> i64 {
    i64::try_from(time.unix_timestamp_nanos() / 1_000_000).unwrap_or(i64::MAX)
}

/// What one validated term asks of an entry.
fn predicate(key: &str, op: FilterOp, value: &str, now: OffsetDateTime) -> FilterPredicate {
    match key {
        "type" => match value.strip_suffix('*') {
            Some(prefix) => FilterPredicate::Type {
                value: prefix.to_owned(),
                prefix: true,
            },
            None => FilterPredicate::Type {
                value: value.to_owned(),
                prefix: false,
            },
        },
        "size" => {
            let bytes = parse_bytes(value).unwrap_or(0);
            let (min, max) = match op {
                FilterOp::Eq => (Some(bytes), Some(bytes)),
                FilterOp::Gt => (Some(bytes.saturating_add(1)), None),
                FilterOp::Ge => (Some(bytes), None),
                FilterOp::Lt => match bytes.checked_sub(1) {
                    Some(max) => (None, Some(max)),
                    // Smaller than nothing: matches nothing.
                    None => (Some(1), Some(0)),
                },
                FilterOp::Le => (None, Some(bytes)),
            };
            FilterPredicate::Size { min, max }
        }
        "updated" | "created" => {
            let at = parse_time(value, now).map_or(0, millis);
            let day = value.len() == 10 || value.eq_ignore_ascii_case("today");
            let (from, until) = match op {
                FilterOp::Eq if day => (Some(at), Some(at.saturating_add(DAY_MS))),
                FilterOp::Eq | FilterOp::Ge => (Some(at), None),
                FilterOp::Gt => (Some(at.saturating_add(1)), None),
                FilterOp::Lt => (None, Some(at)),
                FilterOp::Le => (None, Some(at.saturating_add(1))),
            };
            if key == "updated" {
                FilterPredicate::Updated { from, until }
            } else {
                FilterPredicate::Created { from, until }
            }
        }
        "has" => FilterPredicate::Has(match value {
            "token" => HasField::Token,
            "type" => HasField::Type,
            "metadata" => HasField::Metadata,
            "encoding" => HasField::Encoding,
            _ => HasField::Cache,
        }),
        meta if meta.starts_with("meta.") => {
            let compare = match op {
                FilterOp::Eq => MetaCompare::Eq,
                FilterOp::Gt => MetaCompare::Gt,
                FilterOp::Ge => MetaCompare::Ge,
                FilterOp::Lt => MetaCompare::Lt,
                FilterOp::Le => MetaCompare::Le,
            };
            let (value, prefix) = match value.strip_suffix('*') {
                Some(prefix) if op == FilterOp::Eq => (prefix, true),
                _ => (value, false),
            };
            FilterPredicate::Meta {
                key: meta["meta.".len()..].to_owned(),
                compare,
                value: value.to_owned(),
                prefix,
            }
        }
        // `name` and anything text.
        _ => FilterPredicate::Name(value.to_lowercase()),
    }
}

/// The engine's filter for a validated query, times resolved against `now`
/// (whole seconds, so one query text keeps one cached view within a
/// second).
pub(crate) fn storage_filter(query: &FilterQuery, now: OffsetDateTime) -> StorageFilter {
    let now = now.replace_nanosecond(0).unwrap_or(now);
    let mut clauses = Vec::new();
    for word in &query.words {
        clauses.push(FilterClause {
            any: vec![FilterPredicate::Name(word.text.to_lowercase())],
            negated: word.negated,
        });
    }
    // Positive equality on one exact, enum or path key: any of its values.
    let mut grouped: Vec<(String, usize)> = Vec::new();
    for term in &query.terms {
        let groupable = term.op == FilterOp::Eq
            && !term.negated
            && (matches!(term.key.as_str(), "type" | "has") || term.key.starts_with("meta."));
        let built = predicate(&term.key, term.op, &term.value, now);
        if groupable {
            if let Some((_, index)) = grouped.iter().find(|(key, _)| *key == term.key) {
                clauses[*index].any.push(built);
                continue;
            }
            grouped.push((term.key.clone(), clauses.len()));
        }
        clauses.push(FilterClause {
            any: vec![built],
            negated: term.negated,
        });
    }
    StorageFilter { clauses }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parsed(text: &str) -> StorageFilter {
        let query = STORAGE_FILTER_FIELDS.parse(text).expect("valid");
        storage_filter(
            &query,
            OffsetDateTime::from_unix_timestamp(1_790_000_000).expect("time"),
        )
    }

    #[test]
    fn terms_become_the_engines_predicates() {
        let filter =
            parsed("photo type:image/* type:video/mp4 size:>5MB -has:type meta.ownerUid:u_9f3k2");
        assert_eq!(filter.clauses.len(), 5);
        assert_eq!(
            filter.clauses[0].any,
            [FilterPredicate::Name("photo".to_owned())]
        );
        assert_eq!(
            filter.clauses[1].any,
            [
                FilterPredicate::Type {
                    value: "image/".to_owned(),
                    prefix: true
                },
                FilterPredicate::Type {
                    value: "video/mp4".to_owned(),
                    prefix: false
                }
            ],
            "a repeated key matches any of its values"
        );
        assert_eq!(
            filter.clauses[2].any,
            [FilterPredicate::Size {
                min: Some(5 * 1024 * 1024 + 1),
                max: None
            }]
        );
        assert!(filter.clauses[3].negated);
        assert_eq!(
            filter.clauses[4].any,
            [FilterPredicate::Meta {
                key: "ownerUid".to_owned(),
                compare: MetaCompare::Eq,
                value: "u_9f3k2".to_owned(),
                prefix: false
            }],
            "the key keeps its case"
        );
        let day = parsed("updated:2026-10-01");
        let FilterPredicate::Updated { from, until } = &day.clauses[0].any[0] else {
            panic!("{day:?}");
        };
        assert_eq!(
            until.expect("end") - from.expect("start"),
            DAY_MS,
            "a date means that day"
        );
        let since = parsed("updated:>-1h");
        assert!(matches!(
            since.clauses[0].any[0],
            FilterPredicate::Updated {
                from: Some(_),
                until: None
            }
        ));
        // Two negated repeats each exclude.
        let both = parsed("-has:type -has:cache");
        assert_eq!(both.clauses.len(), 2);
        assert!(both.clauses.iter().all(|clause| clause.negated));
    }
}
