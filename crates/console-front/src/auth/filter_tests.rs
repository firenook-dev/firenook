use serde_json::{Value, json};
use time::format_description::well_known::Rfc3339;

use super::*;
use crate::filter::golden;

const USERS: &str = include_str!("../../../../console/src/auth/filter-cases/users.json");
const ACTIVITY: &str = include_str!("../../../../console/src/auth/filter-cases/activity.json");
const INBOX: &str = include_str!("../../../../console/src/auth/filter-cases/inbox.json");
const USER_FILTER: &str =
    include_str!("../../../../console/src/auth/filter-cases/user-filter.json");

fn at(text: &str) -> OffsetDateTime {
    OffsetDateTime::parse(text, &Rfc3339).expect("RFC 3339")
}

fn ms(text: &str) -> i64 {
    millis(at(text))
}

#[test]
fn every_case_of_the_three_files_holds() {
    let users = golden::run(USERS);
    assert!(users >= 40, "users.json holds {users} cases, fewer than 40");
    assert!(golden::run(ACTIVITY) >= 15);
    assert!(golden::run(INBOX) >= 10);
}

/// A field as the files write it, every list present.
fn normalized(field: &Value) -> Value {
    let list = |name: &str| field.get(name).cloned().unwrap_or_else(|| json!([]));
    json!({
        "key": field["key"],
        "aliases": list("aliases"),
        "kind": field["kind"],
        "help": field["help"],
        "values": list("values"),
        "valueAliases": field.get("valueAliases").cloned().unwrap_or_else(|| json!({})),
        "prefixes": list("prefixes"),
    })
}

#[test]
fn the_files_declare_exactly_the_engines_fields() {
    for (file, set) in [
        (USERS, &USER_FIELDS),
        (ACTIVITY, &ACTIVITY_FIELDS),
        (INBOX, &MESSAGE_FIELDS),
    ] {
        let file: Value = serde_json::from_str(file).expect("json");
        let declared: Vec<Value> = file["fields"]
            .as_array()
            .expect("fields")
            .iter()
            .map(normalized)
            .collect();
        let engine: Vec<Value> = set
            .infos()
            .iter()
            .map(|info| normalized(&serde_json::to_value(info).expect("info")))
            .collect();
        assert_eq!(declared, engine);
    }
}

#[test]
fn every_users_case_translates_to_its_pinned_user_filter() {
    let file: Value = serde_json::from_str(USER_FILTER).expect("json");
    let now = at(file["now"].as_str().expect("now"));
    let mut failures = Vec::new();
    let cases = file["cases"].as_array().expect("cases");
    for case in cases {
        let text = case["text"].as_str().expect("text");
        let query = USER_FIELDS.parse(text).expect("a valid users filter");
        match (
            translate_users(&query, now),
            case.get("filter"),
            case.get("error"),
        ) {
            (Ok(filter), Some(wanted), None) => {
                let actual = serde_json::to_value(&filter).expect("filter");
                if &actual != wanted {
                    failures.push(format!("{text}: expected {wanted}, got {actual}"));
                }
            }
            (Err(error), None, Some(wanted)) => {
                let actual =
                    json!({ "from": error.from, "to": error.to, "message": error.message });
                if &actual != wanted {
                    failures.push(format!("{text}: expected error {wanted}, got {actual}"));
                }
            }
            (outcome, _, _) => failures.push(format!("{text}: unexpected {outcome:?}")),
        }
    }
    assert_eq!(failures, Vec::<String>::new());
    // Every valid users case is pinned.
    let users: Value = serde_json::from_str(USERS).expect("json");
    let valid = users["cases"]
        .as_array()
        .expect("cases")
        .iter()
        .filter(|case| case.get("ok").is_some())
        .count();
    assert_eq!(cases.len(), valid);
}

#[test]
fn a_day_is_the_whole_day_and_an_instant_is_a_point() {
    let now = at("2026-10-12T10:30:00Z");
    let term = |text: &str| {
        let query = USER_FIELDS.parse(text).expect("valid");
        time_term(&query.terms[0], now)
    };
    let day = ms("2026-10-01T00:00:00Z");
    let next = ms("2026-10-02T00:00:00Z");
    let range = |from: Option<i64>, until: Option<i64>| TimeTerm {
        from,
        until,
        negated: false,
    };
    assert_eq!(term("created:2026-10-01"), range(Some(day), Some(next)));
    assert_eq!(term("created:>2026-10-01"), range(Some(next), None));
    assert_eq!(term("created:>=2026-10-01"), range(Some(day), None));
    assert_eq!(term("created:<2026-10-01"), range(None, Some(day)));
    assert_eq!(term("created:<=2026-10-01"), range(None, Some(next)));
    let noon = ms("2026-10-01T12:00:00Z");
    assert_eq!(
        term("created:>2026-10-01T12:00:00Z"),
        range(Some(noon + 1), None)
    );
    assert_eq!(
        term("created:<=2026-10-01T12:00:00Z"),
        range(None, Some(noon + 1))
    );
    assert_eq!(
        term("created:today"),
        range(
            Some(ms("2026-10-12T00:00:00Z")),
            Some(ms("2026-10-13T00:00:00Z"))
        )
    );
    assert_eq!(
        term("created:>-7d"),
        range(Some(ms("2026-10-05T10:30:00Z") + 1), None)
    );
    let negated = USER_FIELDS.parse("-created:2026-10-01").expect("valid");
    assert!(time_term(&negated.terms[0], now).negated);
}

#[test]
fn now_is_rounded_to_the_minute() {
    let now = now_minute();
    assert_eq!((now.second(), now.nanosecond()), (0, 0));
}

#[test]
fn a_bad_users_filter_is_an_invalid_argument_with_its_span() {
    let error = user_filter("ada foo:bar", now_minute()).expect_err("unknown key");
    assert_eq!(error.status(), axum::http::StatusCode::BAD_REQUEST);
    let error = user_filter("claim:=x", now_minute()).expect_err("no key");
    assert_eq!(error.detail().message, CLAIM_MESSAGE);
}

#[test]
fn grouped_terms_are_any_of_and_negations_exclude_each() {
    let query = ACTIVITY_FIELDS
        .parse("kind:sign-in kind:sign-up -caller:admin uid:u_1")
        .expect("valid");
    let compiled = |term: &FilterTerm| -> Test<(String, String, String)> {
        let value = term.value.clone();
        match term.key.as_str() {
            "kind" => Box::new(move |entry: &(String, String, String)| entry.0 == value),
            "caller" => Box::new(move |entry: &(String, String, String)| entry.1 == value),
            _ => Box::new(move |entry: &(String, String, String)| entry.2 == value),
        }
    };
    let matcher = grouped(
        &query.terms,
        &["kind", "caller", "uid"],
        &compiled,
        &|key| key != "uid",
    );
    let entry =
        |kind: &str, caller: &str, uid: &str| (kind.to_owned(), caller.to_owned(), uid.to_owned());
    assert!(matcher.matches(&entry("sign-in", "app", "u_1")));
    assert!(matcher.matches(&entry("sign-up", "app", "u_1")));
    assert!(
        !matcher.matches(&entry("refresh", "app", "u_1")),
        "kind is any-of"
    );
    assert!(
        !matcher.matches(&entry("sign-in", "admin", "u_1")),
        "-caller excludes"
    );
    assert!(
        !matcher.matches(&entry("sign-in", "app", "u_2")),
        "uid holds"
    );
    // The facets (kind, caller) do not choose what is counted; uid does.
    assert!(matcher.base_matches(&entry("refresh", "admin", "u_1")));
    assert!(!matcher.base_matches(&entry("refresh", "admin", "u_2")));
}
