//! The task filter: the shared grammar's fields for a queue's tasks and
//! history, and the validated query as the engine's [`TaskQuery`].
//!
//! `name:order-*` (the full or the short name; a trailing `*` matches the
//! start), `is:generated`, `is:console`; free words match the payload
//! preview. Repeated `name:` terms match any of their values; each negated
//! term excludes on its own.

use firenook_tasks_front::inspect::{TaskClause, TaskQuery, TaskTerm};

use crate::api_error::ApiError;
use crate::filter::{FieldKind, FieldSet, FieldSpec};

/// The fields of the task filter.
pub(crate) const TASK_FIELDS: FieldSet = FieldSet {
    fields: &[
        FieldSpec {
            key: "name",
            aliases: &["id"],
            kind: FieldKind::Exact,
            help: "Task name, full or short (a trailing * matches the start)",
        },
        FieldSpec {
            key: "is",
            aliases: &[],
            kind: FieldKind::Enum {
                values: &["generated", "console"],
                aliases: &[],
            },
            help: "Named by the emulator, or enqueued from the console",
        },
    ],
    regex: false,
};

/// `q` parsed, validated and turned into the engine's query.
pub(crate) fn task_query(q: Option<&str>) -> Result<TaskQuery, ApiError> {
    let Some(text) = q.map(str::trim).filter(|text| !text.is_empty()) else {
        return Ok(TaskQuery::default());
    };
    let filter = TASK_FIELDS.parse(text)?;
    let mut clauses: Vec<(Option<String>, TaskClause)> = Vec::new();
    for term in &filter.terms {
        let task_term = match term.key.as_str() {
            "name" => match term.value.strip_suffix('*') {
                Some(start) => TaskTerm::Name {
                    value: start.to_owned(),
                    prefix: true,
                },
                None => TaskTerm::Name {
                    value: term.value.clone(),
                    prefix: false,
                },
            },
            _ if term.value == "generated" => TaskTerm::Generated,
            _ => TaskTerm::Console,
        };
        let shared = (!term.negated).then(|| term.key.clone());
        if let Some(key) = &shared
            && let Some((_, clause)) = clauses
                .iter_mut()
                .find(|(existing, _)| existing.as_ref() == Some(key))
        {
            clause.any.push(task_term);
            continue;
        }
        clauses.push((
            shared,
            TaskClause {
                any: vec![task_term],
                negated: term.negated,
            },
        ));
    }
    for word in &filter.words {
        clauses.push((
            None,
            TaskClause {
                any: vec![TaskTerm::Word(word.text.clone())],
                negated: word.negated,
            },
        ));
    }
    Ok(TaskQuery {
        clauses: clauses.into_iter().map(|(_, clause)| clause).collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terms_become_clauses() {
        let query = task_query(Some("name:order-* name:refund -is:generated card")).expect("query");
        assert_eq!(query.clauses.len(), 3);
        assert_eq!(
            query.clauses[0].any,
            [
                TaskTerm::Name {
                    value: "order-".to_owned(),
                    prefix: true
                },
                TaskTerm::Name {
                    value: "refund".to_owned(),
                    prefix: false
                }
            ]
        );
        assert!(query.clauses[1].negated);
        assert_eq!(query.clauses[1].any, [TaskTerm::Generated]);
        assert_eq!(query.clauses[2].any, [TaskTerm::Word("card".to_owned())]);
        assert_eq!(task_query(None).expect("empty"), TaskQuery::default());
        let error = task_query(Some("queue:x")).expect_err("unknown key");
        assert_eq!(error.status(), axum::http::StatusCode::BAD_REQUEST);
    }
}
