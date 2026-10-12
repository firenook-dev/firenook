//! Finding users: exact matches first, then prefixes as range reads, then a
//! substring scan within its budget, across the project and its tenants.

use serde_json::json;

use super::*;
use crate::AuthRuntime;
use crate::tests::test_runtime;

const PROJECT: &str = "demo-auth";

fn add(runtime: &AuthRuntime, tenant: Option<&str>, uid: &str, user: &serde_json::Value) {
    runtime
        .runtime()
        .update(|data| {
            let agent = data.agent(PROJECT);
            let state = match tenant {
                None => &mut agent.project,
                Some(tenant) => {
                    agent.ensure_tenant(PROJECT, tenant);
                    &mut agent.tenants.get_mut(tenant).expect("tenant").project
                }
            };
            state
                .create_user_with_local_id(uid, user.as_object().expect("object"))
                .expect("create")
                .expect("new");
        })
        .expect("added");
}

/// 10,000 accounts, three whose email starts with `ada`, one in a tenant.
fn crowd() -> AuthRuntime {
    let runtime = test_runtime();
    runtime
        .runtime()
        .update(|data| {
            let state = &mut data.agent(PROJECT).project;
            for index in 0..10_000 {
                state
                    .create_user_with_local_id(
                        &format!("u{index:05}"),
                        json!({ "email": format!("person{index}@example.test") })
                            .as_object()
                            .expect("object"),
                    )
                    .expect("create");
            }
        })
        .expect("crowd");
    add(
        &runtime,
        None,
        "a1",
        &json!({ "email": "ada@example.test", "displayName": "Ada", "customAttributes": "{\"role\":\"admin\"}" }),
    );
    add(
        &runtime,
        None,
        "a2",
        &json!({ "email": "ada.l@example.test" }),
    );
    add(
        &runtime,
        None,
        "a3",
        &json!({ "email": "adams@example.test" }),
    );
    add(
        &runtime,
        Some("acme"),
        "t1",
        &json!({ "email": "ada@acme.test" }),
    );
    runtime
}

fn uids(search: &UserSearch) -> Vec<String> {
    search
        .users
        .iter()
        .map(|user| user.row.uid.clone())
        .collect()
}

fn never() -> bool {
    false
}

#[test]
fn prefixes_are_range_reads_and_exact_matches_come_first() {
    let runtime = crowd();
    let handle = runtime.runtime();
    let found = handle
        .search_users(PROJECT, &SearchScope::Every, "ADA", 4, 20_000, &never)
        .expect("search");
    // Email order within a scope, the project before the tenant, nothing
    // scanned: `ada.l@` sorts before `ada@`.
    assert_eq!(uids(&found), ["a2", "a1", "a3", "t1"]);
    assert_eq!(found.examined, 0, "no scan was needed");
    assert_eq!(found.users[3].row.tenant.as_deref(), Some("acme"));
    assert_eq!(
        found.users[1].claims,
        json!({ "role": "admin" }).as_object().cloned()
    );
    // An exact email is first, ahead of every prefix.
    let exact = handle
        .search_users(
            PROJECT,
            &SearchScope::Every,
            "adams@example.test",
            10,
            20_000,
            &never,
        )
        .expect("search");
    assert_eq!(uids(&exact), ["a3"]);
    // An exact uid too.
    let uid = handle
        .search_users(PROJECT, &SearchScope::Project, "u09999", 3, 20_000, &never)
        .expect("search");
    assert_eq!(uids(&uid)[0], "u09999");
    // A uid prefix.
    let prefix = handle
        .search_users(PROJECT, &SearchScope::Project, "u0999", 10, 20_000, &never)
        .expect("search");
    assert_eq!(prefix.users.len(), 10);
    assert_eq!(uids(&prefix)[0], "u09990");
    // One tenant, the project only.
    let tenant = handle
        .search_users(
            PROJECT,
            &SearchScope::Tenant("acme".to_owned()),
            "ada",
            10,
            20_000,
            &never,
        )
        .expect("search");
    assert_eq!(uids(&tenant), ["t1"]);
    let project = handle
        .search_users(
            PROJECT,
            &SearchScope::Project,
            "ada@acme",
            10,
            20_000,
            &never,
        )
        .expect("search");
    assert_eq!(uids(&project), Vec::<String>::new());
}

#[test]
fn a_substring_scan_runs_only_while_more_are_wanted_and_stops_at_its_budget() {
    let runtime = crowd();
    add(
        &runtime,
        None,
        "zz",
        &json!({ "email": "z@example.test", "displayName": "Lovelace, Ada" }),
    );
    let handle = runtime.runtime();
    let found = handle
        .search_users(PROJECT, &SearchScope::Every, "lovelace", 5, 20_000, &never)
        .expect("search");
    assert_eq!(uids(&found), ["zz"]);
    assert_eq!(found.examined, 10_005, "every digest once");
    assert!(!found.exhausted);
    let stopped = handle
        .search_users(PROJECT, &SearchScope::Every, "lovelace", 5, 100, &never)
        .expect("search");
    assert_eq!(stopped.users.len(), 0);
    assert!(stopped.exhausted);
    assert_eq!(stopped.examined, 100);
    // Told to stop: it stops.
    let told = handle
        .search_users(PROJECT, &SearchScope::Every, "lovelace", 5, 20_000, &|| {
            true
        })
        .expect("search");
    assert!(told.exhausted);
    assert_eq!(told.examined, 0);
    // Prefix matches first, then substrings, each once.
    let mixed = handle
        .search_users(PROJECT, &SearchScope::Every, "ada", 6, 20_000, &never)
        .expect("search");
    assert_eq!(uids(&mixed), ["a2", "a1", "a3", "t1", "zz"]);
}

#[test]
fn no_text_lists_the_first_users_by_uid_and_creates_nothing() {
    let runtime = crowd();
    let handle = runtime.runtime();
    let first = handle
        .search_users(PROJECT, &SearchScope::Every, "", 3, 20_000, &never)
        .expect("search");
    assert_eq!(uids(&first), ["a1", "a2", "a3"]);
    assert_eq!(first.examined, 0);
    let empty = handle
        .search_users("demo-unseen", &SearchScope::Every, "ada", 3, 20_000, &never)
        .expect("search");
    assert_eq!(empty.users, Vec::new());
    let unknown = handle
        .search_users(
            PROJECT,
            &SearchScope::Tenant("nowhere".to_owned()),
            "ada",
            3,
            20_000,
            &never,
        )
        .expect_err("unknown tenant");
    assert_eq!(unknown.kind, super::super::ConsoleErrorKind::NotFound);
    let data = crate::lock(&handle.inner.data);
    assert!(!data.projects.contains_key("demo-unseen"));
    assert!(!data.projects[PROJECT].tenants.contains_key("nowhere"));
}
