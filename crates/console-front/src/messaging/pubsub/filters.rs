//! The message filter: the shared grammar's fields for a topic's history,
//! and the validated query turned into the broker's [`MessageQuery`].
//!
//! `id:>1180`, `key:order-*`, `attributes.region:eu`, `has:key`,
//! `is:dead-lettered`; free words match the first 64 KiB of the data's
//! text. Repeated plain terms of one exact or enum key match any of their
//! values; each negated term excludes on its own; ranges on one key must
//! all hold. The `expr` parameter is not part of this grammar: it is a
//! Pub/Sub filter expression, parsed by the engine's own filter.

use firenook_pubsub_front::broker::inspect::{
    Comparison, MessageClause, MessageFlag, MessageQuery, MessageTerm,
};
use firenook_pubsub_front::filter::Filter;

use crate::api_error::ApiError;
use crate::filter::{FieldKind, FieldSet, FieldSpec, FilterError, FilterOp, FilterQuery};

/// The fields of a topic's message filter.
pub(crate) const MESSAGE_FIELDS: FieldSet = FieldSet {
    fields: &[
        FieldSpec {
            key: "id",
            aliases: &[],
            kind: FieldKind::Number,
            help: "Message id",
        },
        FieldSpec {
            key: "key",
            aliases: &["orderingkey"],
            kind: FieldKind::Exact,
            help: "Ordering key (a trailing * matches the start)",
        },
        FieldSpec {
            key: "attributes",
            aliases: &["attribute"],
            kind: FieldKind::Path {
                prefixes: &["attributes."],
            },
            help: "An attribute, by its key",
        },
        FieldSpec {
            key: "has",
            aliases: &[],
            kind: FieldKind::Enum {
                values: &["key", "schema", "attributes"],
                aliases: &[],
            },
            help: "Messages that carry an ordering key, a schema or attributes",
        },
        FieldSpec {
            key: "is",
            aliases: &[],
            kind: FieldKind::Enum {
                values: &["dead-lettered", "binary", "json"],
                aliases: &[("deadlettered", "dead-lettered")],
            },
            help: "Dead-lettered, binary or JSON messages",
        },
    ],
    regex: false,
};

/// The attribute prefix of the `attributes.` path field.
const ATTRIBUTES: &str = "attributes.";

/// `q` parsed, validated and turned into the broker's query, with `expr`
/// (a Pub/Sub filter expression) when one is given.
pub(crate) fn message_query(q: Option<&str>, expr: Option<&str>) -> Result<MessageQuery, ApiError> {
    let mut query = match q.map(str::trim).filter(|text| !text.is_empty()) {
        Some(text) => to_message_query(&MESSAGE_FIELDS.parse(text)?)?,
        None => MessageQuery::default(),
    };
    if let Some(expr) = expr.map(str::trim).filter(|text| !text.is_empty()) {
        query.expr = Some(Filter::check(expr).map_err(|syntax| {
            ApiError::invalid(format!(
                "The filter expression is not valid: {}",
                syntax.message
            ))
            .with_extra(
                "span",
                serde_json::json!({ "from": syntax.position, "to": syntax.position }),
            )
            .with_fix("Write it as a subscription filter: attributes.region = \"eu\".")
        })?);
    }
    Ok(query)
}

fn comparison(op: FilterOp) -> Comparison {
    match op {
        FilterOp::Eq => Comparison::Eq,
        FilterOp::Gt => Comparison::Gt,
        FilterOp::Ge => Comparison::Ge,
        FilterOp::Lt => Comparison::Lt,
        FilterOp::Le => Comparison::Le,
    }
}

/// A value with a trailing `*` as a prefix match.
fn prefixed(value: &str) -> (String, bool) {
    match value.strip_suffix('*') {
        Some(start) => (start.to_owned(), true),
        None => (value.to_owned(), false),
    }
}

/// The validated query as clauses: one per term or word, except that plain
/// (`:`) terms repeated on one exact or enum key share a clause, matching
/// any of their values.
pub(crate) fn to_message_query(filter: &FilterQuery) -> Result<MessageQuery, ApiError> {
    let mut clauses: Vec<(Option<String>, MessageClause)> = Vec::new();
    for term in &filter.terms {
        let message_term = match term.key.as_str() {
            "id" => {
                let id = term.value.parse::<u64>().map_err(|_| {
                    ApiError::from(FilterError {
                        message: "\"id:\" needs a whole message id, like 1180.".to_owned(),
                        from: term.from,
                        to: term.to,
                    })
                })?;
                MessageTerm::Id(comparison(term.op), id)
            }
            "key" => {
                let (value, prefix) = prefixed(&term.value);
                MessageTerm::Key { value, prefix }
            }
            "has" => MessageTerm::Flag(match term.value.as_str() {
                "key" => MessageFlag::Key,
                "schema" => MessageFlag::Schema,
                _ => MessageFlag::Attributes,
            }),
            "is" => MessageTerm::Flag(match term.value.as_str() {
                "dead-lettered" => MessageFlag::DeadLettered,
                "binary" => MessageFlag::Binary,
                _ => MessageFlag::Json,
            }),
            path => {
                let key = path.strip_prefix(ATTRIBUTES).unwrap_or(path).to_owned();
                let (value, prefix) = if term.op == FilterOp::Eq {
                    prefixed(&term.value)
                } else {
                    (term.value.clone(), false)
                };
                MessageTerm::Attribute {
                    key,
                    comparison: comparison(term.op),
                    value,
                    prefix,
                }
            }
        };
        // Plain terms of one exact or enum key match any of their values.
        let shared = (!term.negated && term.op == FilterOp::Eq && term.key != "id")
            .then(|| term.key.clone());
        if let Some(key) = &shared
            && let Some((_, clause)) = clauses
                .iter_mut()
                .find(|(existing, _)| existing.as_ref() == Some(key))
        {
            clause.any.push(message_term);
            continue;
        }
        clauses.push((
            shared,
            MessageClause {
                any: vec![message_term],
                negated: term.negated,
            },
        ));
    }
    for word in &filter.words {
        clauses.push((
            None,
            MessageClause {
                any: vec![MessageTerm::Word(word.text.clone())],
                negated: word.negated,
            },
        ));
    }
    Ok(MessageQuery {
        clauses: clauses.into_iter().map(|(_, clause)| clause).collect(),
        expr: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terms_become_clauses() {
        let query = message_query(
            Some("id:>10 key:order-* key:audit attributes.Region:eu -is:binary refund"),
            Some("attributes.kind = \"a\""),
        )
        .expect("query");
        assert_eq!(query.clauses.len(), 5);
        assert_eq!(query.clauses[0].any, [MessageTerm::Id(Comparison::Gt, 10)]);
        assert_eq!(
            query.clauses[1].any,
            [
                MessageTerm::Key {
                    value: "order-".to_owned(),
                    prefix: true
                },
                MessageTerm::Key {
                    value: "audit".to_owned(),
                    prefix: false
                }
            ]
        );
        assert_eq!(
            query.clauses[2].any,
            [MessageTerm::Attribute {
                key: "Region".to_owned(),
                comparison: Comparison::Eq,
                value: "eu".to_owned(),
                prefix: false
            }],
            "the attribute key keeps its case"
        );
        assert!(query.clauses[3].negated);
        assert_eq!(
            query.clauses[3].any,
            [MessageTerm::Flag(MessageFlag::Binary)]
        );
        assert_eq!(
            query.clauses[4].any,
            [MessageTerm::Word("refund".to_owned())]
        );
        assert!(query.expr.is_some());
        let error = message_query(Some("id:1.5"), None).expect_err("not a whole id");
        assert_eq!(error.status(), axum::http::StatusCode::BAD_REQUEST);
        let error = message_query(None, Some("attributes.kind = ")).expect_err("bad expr");
        assert!(error.detail().message.starts_with("The filter expression"));
    }
}
