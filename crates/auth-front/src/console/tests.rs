//! The console's reads of the user index: upkeep on every mutation path,
//! paging both ways in every order, the filter, the facets, pins, reads that
//! never mutate and never hold the lock, claim keys, the CI smoke ceilings
//! and the measured memory per user.

use std::collections::BTreeSet;
use std::time::{Duration, Instant};

use axum::http::Method;
use serde_json::{Value as JsonValue, json};

use super::index::UserIndex;
use super::*;
use crate::state::{ProjectState, UserRecord};
use crate::tests::{Lcg, call, test_runtime};
use crate::{AuthRuntime, lock};

const PROJECT: &str = "demo-auth";
const ADMIN: &str = "/identitytoolkit.googleapis.com/v1/projects/demo-auth";
const CLIENT: &str = "/identitytoolkit.googleapis.com/v1";

fn record(value: &JsonValue) -> UserRecord {
    value.as_object().cloned().expect("a JSON object")
}

/// Runs `body` on the project's accounts, or a tenant's (created on first use).
fn with_state<T>(
    runtime: &AuthRuntime,
    tenant: Option<&str>,
    body: impl FnOnce(&mut ProjectState) -> T,
) -> T {
    let handle = runtime.runtime();
    let mut data = lock(&handle.inner.data);
    let agent = data.agent(PROJECT);
    match tenant {
        None => body(&mut agent.project),
        Some(tenant) => {
            agent.ensure_tenant(PROJECT, tenant);
            body(&mut agent.tenants.get_mut(tenant).expect("tenant").project)
        }
    }
}

fn create(state: &mut ProjectState, uid: &str, props: &JsonValue) {
    state
        .create_user_with_local_id(uid, &record(props))
        .expect("create")
        .expect("a new uid");
}

/// The index kept one change at a time equals one rebuilt from the records.
fn assert_follows(state: &ProjectState, context: &str) {
    assert_eq!(
        state.user_index().canonical(),
        UserIndex::build(&state.users).canonical(),
        "{context}"
    );
}

fn assert_every_scope_follows(runtime: &AuthRuntime, context: &str) {
    let handle = runtime.runtime();
    let data = lock(&handle.inner.data);
    for (project, agent) in &data.projects {
        assert_follows(&agent.project, &format!("{context} ({project})"));
        for (tenant, state) in &agent.tenants {
            assert_follows(&state.project, &format!("{context} ({project}/{tenant})"));
        }
    }
}

fn view(runtime: &AuthRuntime, tenant: Option<&str>) -> UsersView {
    runtime.runtime().users(PROJECT, tenant).expect("view")
}

fn sort(text: &str) -> UserSort {
    UserSort::parse(text).expect("a sort")
}

fn query(filter: &UserFilter, order: &str, limit: usize) -> UsersQuery {
    UsersQuery {
        filter: filter.clone(),
        sort: sort(order),
        cursor: None,
        before: None,
        limit,
    }
}

fn uids(page: &UsersPage) -> Vec<String> {
    page.rows.iter().map(|row| row.uid.clone()).collect()
}

/// Every matching uid in the sort's order, page by page downwards, and the
/// same read page by page upwards from the last page.
fn read_both_ways(
    view: &UsersView,
    filter: &UserFilter,
    order: &str,
    limit: usize,
    forget_pins: bool,
) -> (Vec<String>, Vec<String>) {
    let forget = || {
        if forget_pins {
            view.index.forget_pins();
        }
    };
    let mut page = view.page(&query(filter, order, limit)).expect("first page");
    assert!(page.prev.is_none(), "the top page has no page above");
    let mut down = uids(&page);
    while let Some(next) = page.next.clone() {
        forget();
        page = view
            .page(&UsersQuery {
                cursor: Some(next),
                ..query(filter, order, limit)
            })
            .expect("next page");
        assert!(page.total.is_none() && page.facets.is_none() && page.scope_total.is_none());
        down.extend(uids(&page));
    }
    let mut up = uids(&page);
    let mut prev = page.prev.clone();
    while let Some(before) = prev {
        forget();
        let above = view
            .page(&UsersQuery {
                before: Some(before),
                ..query(filter, order, limit)
            })
            .expect("page above");
        let mut rows = uids(&above);
        rows.extend(up);
        up = rows;
        prev = above.prev.clone();
    }
    (down, up)
}

fn matching(view: &UsersView, filter: &UserFilter) -> BTreeSet<String> {
    let page = view
        .page(&query(filter, "uid:asc", MAX_PAGE_SIZE))
        .expect("page");
    assert!(page.next.is_none(), "the fixture fits on one page");
    page.rows.into_iter().map(|row| row.uid).collect()
}

fn set(uids: &[&str]) -> BTreeSet<String> {
    uids.iter().map(|uid| (*uid).to_owned()).collect()
}

const GIVEN: &[&str] = &[
    "Ada", "Grace", "Linus", "Margaret", "Alan", "Barbara", "Edsger", "Frances", "Ken", "Radia",
];
const FAMILY: &[&str] = &[
    "Lovelace", "Hopper", "Torvalds", "Hamilton", "Turing", "Liskov", "Dijkstra", "Allen",
    "Thompson", "Perlman",
];

/// An account as apps create them: mostly password and Google users, some
/// phone, anonymous and custom-token ones, a quarter with claims, a few with
/// a second factor or disabled.
fn realistic_user(index: usize, random: &mut Lcg) -> (String, UserRecord) {
    let uid = crate::util::random_id(28);
    let given = *random.pick(GIVEN);
    let family = *random.pick(FAMILY);
    let name = format!("{given} {family}");
    let email = format!(
        "{}.{}{index}@example.test",
        given.to_lowercase(),
        family.to_lowercase()
    );
    let created = 1_700_000_000_000_i64 + i64::try_from(index).unwrap_or(0) * 60_000;
    let mut user = json!({ "createdAt": created.to_string() });
    if random.chance(80) {
        user["lastLoginAt"] = json!((created + 3_600_000).to_string());
    }
    match random.below(100) {
        0..=49 => {
            user["email"] = json!(email);
            user["salt"] = json!(format!("fakeSalt{index}"));
            user["passwordHash"] = json!(format!(
                "fakeHash:salt=fakeSalt{index}:password=password{index}"
            ));
            user["displayName"] = json!(name);
            user["emailVerified"] = json!(random.chance(70));
        }
        50..=69 => {
            let photo = format!("https://example.test/photos/{index}.png");
            user["email"] = json!(email);
            user["displayName"] = json!(name);
            user["photoUrl"] = json!(photo);
            user["emailVerified"] = json!(true);
            user["providerUserInfo"] = json!([{
                "providerId": "google.com", "rawId": format!("g{index}"),
                "federatedId": format!("g{index}"), "email": email,
                "displayName": name, "photoUrl": photo,
            }]);
        }
        70..=79 => user["phoneNumber"] = json!(format!("+1555{index:07}")),
        80..=89 => {}
        _ => user["customAuth"] = json!(true),
    }
    if random.chance(25) {
        let role = *random.pick(&["admin", "editor", "viewer"]);
        user["customAttributes"] =
            json!(json!({ "role": role, "tier": random.below(4) }).to_string());
    }
    if user.get("email").is_some() && random.chance(5) {
        user["emailVerified"] = json!(true);
        user["mfaInfo"] = json!([{
            "mfaEnrollmentId": format!("mfa{index}"),
            "phoneInfo": format!("+1666{index:07}"),
            "unobfuscatedPhoneInfo": format!("+1666{index:07}"),
            "displayName": "Work phone",
            "enrolledAt": "2026-01-01T00:00:00.000Z",
        }]);
    }
    if random.chance(3) {
        user["disabled"] = json!(true);
    }
    (uid, record(&user))
}

/// A runtime holding `users` realistic project users, and their uids in
/// creation order.
fn populated(users: usize, seed: u64) -> (AuthRuntime, Vec<String>) {
    let runtime = test_runtime();
    let mut random = Lcg::new(seed);
    let uids = with_state(&runtime, None, |state| {
        (0..users)
            .map(|index| {
                let (uid, user) = realistic_user(index, &mut random);
                state
                    .create_user_with_local_id(&uid, &user)
                    .expect("create")
                    .expect("new");
                uid
            })
            .collect::<Vec<_>>()
    });
    (runtime, uids)
}

// ---------------------------------------------------------------- 1. upkeep

#[tokio::test]
async fn the_index_follows_every_mutation_path() {
    let runtime = test_runtime();
    let step = |name: &str| assert_every_scope_follows(&runtime, name);

    let (status, body) = call(
        &runtime,
        Method::POST,
        &format!("{CLIENT}/accounts:signUp?key=fake"),
        &json!({ "email": "ada@example.test", "password": "password1", "displayName": "Ada", "returnSecureToken": true }),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let ada = body["localId"].as_str().expect("uid").to_owned();
    let id_token = body["idToken"].as_str().expect("token").to_owned();
    let refresh = body["refreshToken"].as_str().expect("refresh").to_owned();
    step("client sign-up");

    let (status, body) = call(
        &runtime,
        Method::POST,
        &format!("{ADMIN}/accounts"),
        &json!({ "localId": "admin-made", "email": "grace@example.test", "phoneNumber": "+15550100", "displayName": "Grace" }),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    step("admin create");

    for (name, change) in [
        ("email", json!({ "email": "grace.hopper@example.test" })),
        ("phone", json!({ "phoneNumber": "+15550199" })),
        ("name", json!({ "displayName": "Grace Hopper" })),
        ("disabled", json!({ "disableUser": true })),
        ("enabled", json!({ "disableUser": false })),
        (
            "claims",
            json!({ "customAttributes": r#"{"role":"admin","tier":2}"# }),
        ),
        ("claims removed", json!({ "customAttributes": "{}" })),
        (
            "phone removed",
            json!({ "deleteAttribute": [], "deleteProvider": ["phone"] }),
        ),
    ] {
        let mut request = change.clone();
        request["localId"] = json!("admin-made");
        let (status, body) = call(
            &runtime,
            Method::POST,
            &format!("{ADMIN}/accounts:update"),
            &request,
        )
        .await;
        assert_eq!(status, 200, "{name}: {body}");
        step(&format!("update {name}"));
    }

    let (status, body) = call(
        &runtime,
        Method::POST,
        &format!("{ADMIN}/accounts:update"),
        &json!({ "localId": ada, "linkProviderUserInfo": { "providerId": "google.com", "rawId": "g-ada", "email": "ada@example.test", "displayName": "Ada G" } }),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    step("link a provider");
    let (status, body) = call(
        &runtime,
        Method::POST,
        &format!("{ADMIN}/accounts:update"),
        &json!({ "localId": ada, "deleteProvider": ["google.com"] }),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    step("unlink a provider");

    let (status, body) = call(
        &runtime,
        Method::POST,
        &format!("{ADMIN}/accounts:update"),
        &json!({ "localId": ada, "emailVerified": true, "mfa": { "enrollments": [{ "mfaEnrollmentId": "f1", "phoneInfo": "+15550111", "displayName": "Phone" }] } }),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    step("add a second factor");
    let (status, body) = call(
        &runtime,
        Method::POST,
        &format!("{ADMIN}/accounts:update"),
        &json!({ "localId": ada, "mfa": {} }),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    step("remove the second factor");

    let (status, body) = call(
        &runtime,
        Method::POST,
        &format!("{CLIENT}/accounts:signInWithCustomToken?key=fake"),
        &json!({ "token": r#"{"uid":"custom-user","claims":{"plan":"pro"}}"#, "returnSecureToken": true }),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    step("custom token sign-in");

    let (status, body) = call(
        &runtime,
        Method::POST,
        &format!("{ADMIN}/accounts:batchCreate"),
        &json!({ "users": [
            { "localId": "admin-made", "email": "imported@example.test", "displayName": "Imported" },
            { "localId": "imported-new", "phoneNumber": "+15550222", "createdAt": "1600000000000" },
        ] }),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    step("import with overwrite");

    let (status, body) = call(
        &runtime,
        Method::POST,
        &format!("{ADMIN}/tenants/acme/accounts"),
        &json!({ "localId": "tenant-user", "email": "ten@acme.test" }),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    step("tenant user");
    assert_eq!(view(&runtime, Some("acme")).len(), 1);

    // A token refresh moves `lastRefreshAt` only: nothing the console shows.
    let before = view(&runtime, None).generation();
    let (status, body) = call(
        &runtime,
        Method::POST,
        "/securetoken.googleapis.com/v1/token?key=fake",
        &json!({ "grant_type": "refresh_token", "refresh_token": refresh }),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        view(&runtime, None).generation(),
        before,
        "a refresh moves nothing"
    );
    // A sign-in moves the sign-in time.
    let (status, body) = call(
        &runtime,
        Method::POST,
        &format!("{CLIENT}/accounts:signInWithPassword?key=fake"),
        &json!({ "email": "ada@example.test", "password": "password1" }),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_ne!(view(&runtime, None).generation(), before);
    step("sign-in");

    let (status, body) = call(
        &runtime,
        Method::POST,
        &format!("{CLIENT}/accounts:delete?key=fake"),
        &json!({ "idToken": id_token }),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    step("delete");
    assert!(
        view(&runtime, None)
            .page(&UsersQuery::default())
            .expect("page")
            .rows
            .iter()
            .all(|row| row.uid != ada)
    );

    let (status, body) = call(
        &runtime,
        Method::DELETE,
        "/emulator/v1/projects/demo-auth/accounts",
        &json!({}),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    step("delete all");
    assert!(view(&runtime, None).is_empty());
    assert_eq!(view(&runtime, Some("acme")).len(), 1, "tenants keep theirs");
}

#[test]
fn random_operation_sequences_keep_the_index_equal_to_a_rebuild() {
    let mut random = Lcg::new(1);
    for sequence in 0..200 {
        let mut state = ProjectState::default();
        let mut live: Vec<String> = Vec::new();
        let mut next_id = 0;
        for operation in 0..(10 + random.below(30)) {
            let context = format!("sequence {sequence}, operation {operation}");
            match random.below(10) {
                0..=2 => {
                    next_id += 1;
                    let uid = if random.chance(30) {
                        format!("sample-{next_id}")
                    } else {
                        format!("u{next_id}")
                    };
                    let mut props =
                        json!({ "createdAt": (1000 + random.below(5) * 10).to_string() });
                    if random.chance(60) {
                        props["email"] = json!(format!("User{next_id}@Example.test"));
                    }
                    if random.chance(40) {
                        props["displayName"] = json!(*random.pick(&["Ada", "ada", "Grace", "Zed"]));
                    }
                    if random.chance(30) {
                        props["phoneNumber"] = json!(format!("+1 555 {next_id:04}"));
                    }
                    create(&mut state, &uid, &props);
                    live.push(uid);
                }
                3..=6 if !live.is_empty() => {
                    let uid = live[random.below(live.len())].clone();
                    let mut fields = UserRecord::new();
                    let (field, value) = match random.below(11) {
                        0 => ("email", json!(format!("{uid}@x.test"))),
                        1 => ("email", JsonValue::Null),
                        2 => ("displayName", json!(*random.pick(&["Bea", "bea", "Al"]))),
                        3 => ("disabled", json!(random.chance(50))),
                        4 => ("emailVerified", json!(random.chance(50))),
                        5 => (
                            "customAttributes",
                            json!(*random.pick(&[
                                r#"{"role":"admin"}"#,
                                r#"{"role":"viewer","n":3}"#,
                                "{}",
                                "not json",
                                "[1]",
                                r#"{"z":{"a":[1]}}"#,
                            ])),
                        ),
                        6 => ("lastLoginAt", json!((2000 + random.below(3)).to_string())),
                        7 => ("lastRefreshAt", json!("2026-10-12T00:00:00.000Z")),
                        8 => ("customAuth", json!(random.chance(50))),
                        9 => (
                            "mfaInfo",
                            json!([{ "mfaEnrollmentId": "m", "phoneInfo": "+15550000" }]),
                        ),
                        _ => ("phoneNumber", JsonValue::Null),
                    };
                    fields.insert(field.to_owned(), value);
                    let options = if random.chance(30) {
                        crate::state::UpdateOptions {
                            upsert_providers: vec![record(&json!({
                                "providerId": *random.pick(&["google.com", "saml.okta", "oidc.x"]),
                                "rawId": format!("raw-{uid}"),
                            }))],
                            delete_providers: Vec::new(),
                        }
                    } else if random.chance(20) {
                        crate::state::UpdateOptions {
                            upsert_providers: Vec::new(),
                            delete_providers: vec!["google.com", "saml.okta"],
                        }
                    } else {
                        crate::state::UpdateOptions::default()
                    };
                    state
                        .update_user_by_local_id(&uid, &fields, options)
                        .expect("update");
                }
                7 if !live.is_empty() => {
                    let uid = live.swap_remove(random.below(live.len()));
                    let user = state.get_user_by_local_id(&uid).expect("user");
                    state.delete_user(&user);
                }
                8 if !live.is_empty() => {
                    let uid = live[random.below(live.len())].clone();
                    state
                        .overwrite_user_with_local_id(
                            &uid,
                            &record(&json!({ "localId": uid, "displayName": "Imported", "customAttributes": r#"{"tier":1}"# })),
                        )
                        .expect("overwrite");
                }
                9 if random.chance(10) => {
                    state.delete_all_accounts();
                    live.clear();
                }
                _ => {}
            }
            assert_follows(&state, &context);
        }
    }
}

// ---------------------------------------------------------------- 2. pages

/// The order a sort gives `users` (in creation order, so creation order is
/// slot order): values first by value then creation, reversed for `desc`;
/// accounts without a value last, in creation order.
fn expected_order(
    users: &[(String, UserRecord)],
    column: UserColumn,
    direction: SortDirection,
) -> Vec<String> {
    #[derive(PartialEq, Eq, PartialOrd, Ord)]
    enum Key {
        Time(i64),
        Text(String),
    }
    let key = |user: &UserRecord, uid: &str| -> Option<Key> {
        let text = |field: &str| crate::util::truthy_str(user, field);
        match column {
            UserColumn::Created => millis_field(user, "createdAt").map(Key::Time),
            UserColumn::SignedIn => millis_field(user, "lastLoginAt").map(Key::Time),
            UserColumn::Email => text("email").map(|email| Key::Text(email.to_lowercase())),
            UserColumn::Name => text("displayName").map(|name| Key::Text(name.to_lowercase())),
            UserColumn::Phone => text("phoneNumber")
                .map(filter::digits)
                .filter(|digits| !digits.is_empty())
                .map(Key::Text),
            UserColumn::Uid => Some(Key::Text(uid.to_owned())),
        }
    };
    let mut valued: Vec<(Key, usize, &str)> = Vec::new();
    let mut absent: Vec<&str> = Vec::new();
    for (index, (uid, user)) in users.iter().enumerate() {
        match key(user, uid) {
            Some(key) => valued.push((key, index, uid)),
            None => absent.push(uid),
        }
    }
    valued.sort();
    if direction == SortDirection::Desc {
        valued.reverse();
    }
    valued
        .into_iter()
        .map(|(_, _, uid)| uid.to_owned())
        .chain(absent.into_iter().map(str::to_owned))
        .collect()
}

/// Users with ties and gaps in every column.
fn ordering_fixture(runtime: &AuthRuntime) -> Vec<(String, UserRecord)> {
    let mut random = Lcg::new(2);
    let users: Vec<(String, UserRecord)> = (0..61)
        .map(|index| {
            let mut user = json!({});
            if random.chance(85) {
                user["createdAt"] = json!((1000 + random.below(12) * 7).to_string());
            }
            if random.chance(60) {
                user["lastLoginAt"] = json!((5000 + random.below(9)).to_string());
            }
            if random.chance(70) {
                user["email"] = json!(format!(
                    "{}{index}@example.test",
                    random.pick(&["ada", "Bea", "cy"])
                ));
            }
            if random.chance(70) {
                user["displayName"] = json!(*random.pick(&["Ada", "ada", "Bea", "Cy", "Émile"]));
            }
            if random.chance(50) {
                user["phoneNumber"] = json!(format!("+1 (555) {:04}", random.below(20)));
            }
            if random.chance(30) {
                user["disabled"] = json!(true);
            }
            (format!("user-{index:02}"), record(&user))
        })
        .collect();
    with_state(runtime, None, |state| {
        for (uid, user) in &users {
            create(state, uid, &JsonValue::Object(user.clone()));
        }
    });
    users
}

#[test]
fn every_sort_pages_both_ways_with_nulls_last_and_ties_by_slot() {
    let runtime = test_runtime();
    let users = ordering_fixture(&runtime);
    let view = view(&runtime, None);
    let disabled = UserFilter {
        is: Choice {
            any_of: vec![UserState::Disabled],
            none_of: Vec::new(),
        },
        ..UserFilter::default()
    };
    let disabled_users: BTreeSet<String> = users
        .iter()
        .filter(|(_, user)| crate::util::truthy(user.get("disabled")))
        .map(|(uid, _)| uid.clone())
        .collect();
    // A few users (at most an eighth, so their match list is sorted rather
    // than walked), with an account lacking each column among them.
    let mut few: Vec<String> = Vec::new();
    for field in [
        "createdAt",
        "lastLoginAt",
        "email",
        "displayName",
        "phoneNumber",
    ] {
        if let Some((uid, _)) = users
            .iter()
            .find(|(uid, user)| user.get(field).is_none() && !few.contains(uid))
        {
            few.push(uid.clone());
        }
    }
    for (uid, _) in &users {
        if few.len() < 7 && !few.contains(uid) {
            few.push(uid.clone());
        }
    }
    let selective = UserFilter {
        uid: Choice {
            any_of: few.iter().map(|uid| IdMatch::Exact(uid.clone())).collect(),
            none_of: Vec::new(),
        },
        ..UserFilter::default()
    };
    for column in UserColumn::ALL {
        for direction in [SortDirection::Asc, SortDirection::Desc] {
            let order = UserSort { column, direction }.to_string();
            let expected = expected_order(&users, column, direction);
            let expected_few: Vec<String> = expected
                .iter()
                .filter(|uid| few.contains(*uid))
                .cloned()
                .collect();
            let (down, up) = read_both_ways(&view, &selective, &order, 2, false);
            assert_eq!(down, expected_few, "{order} sorted matches downwards");
            assert_eq!(up, expected_few, "{order} sorted matches upwards");
            let (down, up) = read_both_ways(&view, &UserFilter::default(), &order, 7, false);
            assert_eq!(down, expected, "{order} downwards");
            assert_eq!(up, expected, "{order} upwards");
            // Filtered: from the pinned match list, then with every pin
            // forgotten before each page (seek and walk).
            let expected_disabled: Vec<String> = expected
                .iter()
                .filter(|uid| disabled_users.contains(*uid))
                .cloned()
                .collect();
            for forget in [false, true] {
                let (down, up) = read_both_ways(&view, &disabled, &order, 4, forget);
                assert_eq!(
                    down, expected_disabled,
                    "{order} filtered downwards, forget {forget}"
                );
                assert_eq!(
                    up, expected_disabled,
                    "{order} filtered upwards, forget {forget}"
                );
            }
        }
    }
}

#[test]
fn cursors_continue_after_inserts_and_refuse_another_sort() {
    let runtime = test_runtime();
    let users = ordering_fixture(&runtime);
    let order = "created:desc";
    let first = view(&runtime, None)
        .page(&query(&UserFilter::default(), order, 10))
        .expect("first");
    let next = first.next.clone().expect("more pages");
    let last_uid = first.rows.last().expect("rows").uid.clone();
    // One account sorts above the cursor, one right below it.
    let last_created = users
        .iter()
        .find(|(uid, _)| *uid == last_uid)
        .and_then(|(_, user)| millis_field(user, "createdAt"))
        .expect("created");
    with_state(&runtime, None, |state| {
        create(state, "newest", &json!({ "createdAt": "999999" }));
        create(
            state,
            "just-below",
            &json!({ "createdAt": (last_created - 1).to_string() }),
        );
    });
    let after = view(&runtime, None);
    let page = after
        .page(&UsersQuery {
            cursor: Some(next),
            ..query(&UserFilter::default(), order, 10)
        })
        .expect("next");
    let all = {
        let mut users = users.clone();
        users.push((
            "newest".to_owned(),
            record(&json!({ "createdAt": "999999" })),
        ));
        users.push((
            "just-below".to_owned(),
            record(&json!({ "createdAt": (last_created - 1).to_string() })),
        ));
        expected_order(&users, UserColumn::Created, SortDirection::Desc)
    };
    let at = all
        .iter()
        .position(|uid| *uid == last_uid)
        .expect("cursor row");
    assert_eq!(uids(&page), all[at + 1..at + 11].to_vec());
    // The page above the second one is the first one, without the account
    // inserted above it since (it sorts before the first row).
    let above = after
        .page(&UsersQuery {
            before: page.prev.clone(),
            ..query(&UserFilter::default(), order, 10)
        })
        .expect("above");
    assert_eq!(uids(&above), all[at - 9..=at].to_vec());

    let foreign = after
        .page(&UsersQuery {
            cursor: first.next.clone(),
            ..query(&UserFilter::default(), "email:asc", 10)
        })
        .expect_err("another sort");
    assert_eq!(foreign.kind, ConsoleErrorKind::InvalidArgument);
    assert_eq!(
        foreign.message,
        "This cursor belongs to another sort; start from the first page."
    );
    let mut wrong_key = first.next.clone().expect("cursor");
    wrong_key.key = Some(CursorKey::Text("not a time".to_owned()));
    assert_eq!(
        after
            .page(&UsersQuery {
                cursor: Some(wrong_key),
                ..query(&UserFilter::default(), order, 10)
            })
            .expect_err("a text key for a time column")
            .message,
        "This cursor is not one this engine wrote."
    );
    let both = after
        .page(&UsersQuery {
            cursor: first.next.clone(),
            before: first.next.clone(),
            ..query(&UserFilter::default(), order, 10)
        })
        .expect_err("cursor and before");
    assert_eq!(both.kind, ConsoleErrorKind::InvalidArgument);
}

#[test]
fn page_sizes_default_to_100_and_stop_at_500() {
    let (runtime, _) = populated(620, 3);
    let view = view(&runtime, None);
    let page = |limit| {
        view.page(&query(&UserFilter::default(), "uid:asc", limit))
            .expect("page")
            .rows
            .len()
    };
    assert_eq!(page(0), DEFAULT_PAGE_SIZE);
    assert_eq!(page(900), MAX_PAGE_SIZE);
    assert_eq!(page(37), 37);
    let first = view
        .page(&query(&UserFilter::default(), "uid:asc", 0))
        .expect("first");
    assert_eq!(first.total, Some(620));
    assert_eq!(first.scope_total, Some(620));
    assert!(first.facets.is_some());
}

#[test]
fn batch_reads_patch_rows_place_new_ones_and_recount() {
    let runtime = test_runtime();
    let users = ordering_fixture(&runtime);
    let order = "created:desc";
    let text = UserFilter {
        words: vec![TextTerm::new("example")],
        ..UserFilter::default()
    };
    let snapshot = view(&runtime, None);
    let first = snapshot.page(&query(&text, order, 10)).expect("first");
    let second = snapshot
        .page(&UsersQuery {
            cursor: first.next.clone(),
            ..query(&text, order, 10)
        })
        .expect("second");
    let kept = first.rows[1].uid.clone();
    let deleted = first.rows[2].uid.clone();
    let unmatched = second.rows[0].uid.clone();
    with_state(&runtime, None, |state| {
        let user = state.get_user_by_local_id(&deleted).expect("user");
        state.delete_user(&user);
        let mut fields = UserRecord::new();
        fields.insert("email".to_owned(), JsonValue::Null);
        fields.insert("displayName".to_owned(), json!("Nobody"));
        state
            .update_user_by_local_id(&unmatched, &fields, crate::state::UpdateOptions::default())
            .expect("update");
        create(
            state,
            "fresh-top",
            &json!({ "createdAt": "999999", "email": "top@example.test" }),
        );
        create(
            state,
            "fresh-bottom",
            &json!({ "createdAt": "1", "email": "bottom@example.test" }),
        );
    });
    let _ = users;
    let now = view(&runtime, None);
    // The client sends each loaded page's first row (its `prev`) and the
    // last loaded page's last row (its `next`).
    let starts = vec![None, second.prev.clone()];
    let batch = now
        .batch(&UsersBatchQuery {
            uids: vec![
                kept.clone(),
                deleted.clone(),
                unmatched.clone(),
                "fresh-top".to_owned(),
                "fresh-bottom".to_owned(),
                "never-existed".to_owned(),
            ],
            filter: text.clone(),
            sort: sort(order),
            page_starts: starts.clone(),
            window_end: second.next.clone(),
        })
        .expect("batch");
    let item = |uid: &str| {
        batch
            .items
            .iter()
            .find(|item| item.uid == uid)
            .expect("item")
    };
    assert_eq!(batch.items.len(), 6, "one item per uid, in order");
    assert_eq!(batch.items[0].uid, kept);
    assert_eq!(item(&kept).page, Some(0));
    assert_eq!(
        item(&kept).row.as_ref().map(|row| row.uid.as_str()),
        Some(kept.as_str())
    );
    assert!(item(&deleted).row.is_none() && item(&deleted).page.is_none());
    assert!(
        item(&unmatched).row.is_none(),
        "no longer matches the filter"
    );
    assert_eq!(item("fresh-top").page, Some(0));
    if second.next.is_some() {
        assert_eq!(item("fresh-bottom").page, None, "below the loaded window");
    } else {
        assert_eq!(
            item("fresh-bottom").page,
            Some(1),
            "the window reaches the end"
        );
    }
    assert!(item("never-existed").row.is_none());
    // A page's first row belongs to that page.
    let second_first = second.rows[1].uid.clone();
    let on_start = now
        .batch(&UsersBatchQuery {
            uids: vec![second_first],
            filter: text.clone(),
            sort: sort(order),
            page_starts: vec![None, second.prev.clone()],
            window_end: None,
        })
        .expect("batch");
    assert!(on_start.items[0].page.is_some());
    // Without a window end, a row below every start is in the last page.
    let open_end = now
        .batch(&UsersBatchQuery {
            uids: vec!["fresh-bottom".to_owned()],
            filter: text.clone(),
            sort: sort(order),
            page_starts: starts,
            window_end: None,
        })
        .expect("batch");
    assert_eq!(open_end.items[0].page, Some(1));
    // The figures equal a first page's for the same filter.
    let fresh = now.page(&query(&text, order, 10)).expect("first again");
    assert_eq!(Some(batch.total), fresh.total);
    assert_eq!(Some(batch.facets.clone()), fresh.facets);
    assert_eq!(Some(batch.scope_total), fresh.scope_total);
    // A window that starts at the second page: a row above it has no page.
    let window = now
        .batch(&UsersBatchQuery {
            uids: vec!["fresh-top".to_owned(), "fresh-bottom".to_owned()],
            filter: text.clone(),
            sort: sort(order),
            page_starts: vec![second.prev.clone()],
            window_end: None,
        })
        .expect("batch");
    assert_eq!(window.items[0].page, None, "above the loaded window");
    assert!(window.items[0].row.is_some(), "still a row");
    assert_eq!(window.items[1].page, Some(0));
    // Unfiltered: the counters.
    let all = now
        .batch(&UsersBatchQuery {
            uids: vec![kept],
            sort: sort(order),
            ..UsersBatchQuery::default()
        })
        .expect("batch");
    assert_eq!(all.total, now.len());
    let too_many = now
        .batch(&UsersBatchQuery {
            uids: vec!["u".to_owned(); MAX_BATCH_USERS + 1],
            ..UsersBatchQuery::default()
        })
        .expect_err("too many");
    assert_eq!(too_many.kind, ConsoleErrorKind::InvalidArgument);
    let foreign = now
        .batch(&UsersBatchQuery {
            uids: vec!["u".to_owned()],
            sort: sort("uid:asc"),
            page_starts: vec![second.prev],
            ..UsersBatchQuery::default()
        })
        .expect_err("a start of another sort");
    assert_eq!(foreign.kind, ConsoleErrorKind::InvalidArgument);
}

// ---------------------------------------------------------------- 3. filter

fn filter_fixture(runtime: &AuthRuntime) {
    with_state(runtime, None, |state| {
        create(
            state,
            "u-ada",
            &json!({ "email": "ada@example.test", "passwordHash": "fakeHash:salt=s:password=p", "salt": "s",
                     "displayName": "Ada Lovelace", "emailVerified": true, "createdAt": "1000", "lastLoginAt": "5000",
                     "customAttributes": r#"{"role":"admin","admin":true,"n":3,"plan":"pro","flag":"true","maybe":null}"# }),
        );
        create(
            state,
            "u-grace",
            &json!({ "email": "grace@example.test", "displayName": "Grace Hopper", "photoUrl": "https://example.test/g.png",
                     "createdAt": "2000", "customAttributes": r#"{"role":"editor","n":3.0}"#,
                     "providerUserInfo": [{ "providerId": "google.com", "rawId": "g1" }] }),
        );
        create(
            state,
            "u-phone",
            &json!({ "phoneNumber": "+15550100", "createdAt": "3000", "lastLoginAt": "6000" }),
        );
        create(state, "u-anon", &json!({ "createdAt": "4000" }));
        create(
            state,
            "u-custom",
            &json!({ "customAuth": true, "createdAt": "5000", "customAttributes": r#"{"plan":"free"}"# }),
        );
        create(
            state,
            "sample-1",
            &json!({ "email": "s1@sample.test", "passwordHash": "fakeHash:salt=s:password=p", "salt": "s",
                     "disabled": true, "createdAt": "6000" }),
        );
        create(
            state,
            "u-saml",
            &json!({ "email": "linus@corp.test", "emailVerified": true, "createdAt": "7000",
                     "providerUserInfo": [{ "providerId": "saml.okta", "rawId": "s1" }],
                     "mfaInfo": [{ "mfaEnrollmentId": "m1", "phoneInfo": "+15550999" }] }),
        );
        create(
            state,
            "u-oidc",
            &json!({ "email": "Mixed@Corp.test", "createdAt": "8000",
                     "providerUserInfo": [{ "providerId": "oidc.github", "rawId": "o1" }, { "providerId": "google.com", "rawId": "g2" }] }),
        );
    });
}

#[test]
fn the_user_filter_means_what_the_grammar_says() {
    let runtime = test_runtime();
    filter_fixture(&runtime);
    let view = view(&runtime, None);
    let check = |filter: UserFilter, expected: &[&str]| {
        assert_eq!(matching(&view, &filter), set(expected), "{filter:?}");
    };
    let is = |any: &[UserState], none: &[UserState]| UserFilter {
        is: Choice {
            any_of: any.to_vec(),
            none_of: none.to_vec(),
        },
        ..UserFilter::default()
    };
    let has = |any: &[UserHas], none: &[UserHas]| UserFilter {
        has: Choice {
            any_of: any.to_vec(),
            none_of: none.to_vec(),
        },
        ..UserFilter::default()
    };
    let all = [
        "u-ada", "u-grace", "u-phone", "u-anon", "u-custom", "sample-1", "u-saml", "u-oidc",
    ];
    let without = |excluded: &[&str]| -> Vec<&str> {
        all.iter()
            .copied()
            .filter(|uid| !excluded.contains(uid))
            .collect()
    };
    // u-phone has a phone provider entry and u-custom signed in with a
    // custom token, so only u-anon is anonymous.
    for (state, expected) in [
        (UserState::Disabled, vec!["sample-1"]),
        (UserState::Verified, vec!["u-ada", "u-saml"]),
        (UserState::Anonymous, vec!["u-anon"]),
        (UserState::CustomToken, vec!["u-custom"]),
        (UserState::Sample, vec!["sample-1"]),
    ] {
        check(is(&[state], &[]), &expected);
        check(is(&[], &[state]), &without(&expected));
    }
    for (value, expected) in [
        (
            UserHas::Email,
            vec!["u-ada", "u-grace", "sample-1", "u-saml", "u-oidc"],
        ),
        (UserHas::Phone, vec!["u-phone"]),
        (UserHas::Password, vec!["u-ada", "sample-1"]),
        (UserHas::Mfa, vec!["u-saml"]),
        (UserHas::Claims, vec!["u-ada", "u-grace", "u-custom"]),
        (UserHas::Photo, vec!["u-grace"]),
        (UserHas::Name, vec!["u-ada", "u-grace"]),
        (UserHas::SignIn, vec!["u-ada", "u-phone"]),
    ] {
        check(has(&[value], &[]), &expected);
        check(has(&[], &[value]), &without(&expected));
    }
    // Repeated plain terms of one key are any-of; negated ones each exclude.
    check(
        is(&[UserState::Disabled, UserState::CustomToken], &[]),
        &["sample-1", "u-custom"],
    );
    let provider = |any: &[&str], none: &[&str]| UserFilter {
        provider: Choice {
            any_of: any.iter().map(|id| IdMatch::parse(id)).collect(),
            none_of: none.iter().map(|id| IdMatch::parse(id)).collect(),
        },
        ..UserFilter::default()
    };
    check(provider(&["google.com"], &[]), &["u-grace", "u-oidc"]);
    check(
        provider(&["google.com", "saml.okta"], &[]),
        &["u-grace", "u-oidc", "u-saml"],
    );
    check(provider(&["saml.*"], &[]), &["u-saml"]);
    check(
        provider(&[], &["google.com", "password"]),
        &without(&["u-grace", "u-oidc", "u-ada", "sample-1"]),
    );
    check(provider(&["never.seen"], &[]), &[]);
    let claim = |matches: Vec<ClaimMatch>| UserFilter {
        claim: Choice {
            any_of: matches,
            none_of: Vec::new(),
        },
        ..UserFilter::default()
    };
    check(claim(vec![ClaimMatch::key("role")]), &["u-ada", "u-grace"]);
    check(
        claim(vec![ClaimMatch::value("admin", json!(true))]),
        &["u-ada"],
    );
    check(
        claim(vec![ClaimMatch::value("n", json!(3))]),
        &["u-ada", "u-grace"],
    );
    check(
        claim(vec![ClaimMatch::value("plan", json!("pro"))]),
        &["u-ada"],
    );
    check(
        claim(vec![ClaimMatch::value("flag", json!("true"))]),
        &["u-ada"],
    );
    check(claim(vec![ClaimMatch::value("flag", json!(true))]), &[]);
    check(
        claim(vec![ClaimMatch::value("maybe", JsonValue::Null)]),
        &["u-ada"],
    );
    check(claim(vec![ClaimMatch::key("iss")]), &[]);
    check(
        UserFilter {
            claim: Choice {
                any_of: Vec::new(),
                none_of: vec![ClaimMatch::value("role", json!("admin"))],
            },
            ..UserFilter::default()
        },
        &without(&["u-ada"]),
    );
    // Time ranges: [from, until), all of them; a user without the time never matches one.
    let created = |terms: Vec<TimeTerm>| UserFilter {
        created: terms,
        ..UserFilter::default()
    };
    check(
        created(vec![TimeTerm {
            from: Some(3000),
            until: Some(6000),
            negated: false,
        }]),
        &["u-phone", "u-anon", "u-custom"],
    );
    check(
        created(vec![
            TimeTerm {
                from: Some(2000),
                ..TimeTerm::default()
            },
            TimeTerm {
                until: Some(4000),
                ..TimeTerm::default()
            },
        ]),
        &["u-grace", "u-phone"],
    );
    check(
        UserFilter {
            signed_in: vec![TimeTerm {
                from: Some(1),
                negated: true,
                ..TimeTerm::default()
            }],
            ..UserFilter::default()
        },
        &without(&["u-ada", "u-phone"]),
    );
    // Text: email, uid and name case-insensitively, the phone as digits.
    let words = |words: &[&str]| UserFilter {
        words: words.iter().map(|word| TextTerm::new(*word)).collect(),
        ..UserFilter::default()
    };
    check(words(&["ADA"]), &["u-ada"]);
    check(words(&["corp"]), &["u-saml", "u-oidc"]);
    check(words(&["mixed@corp"]), &["u-oidc"]);
    check(words(&["u-custom"]), &["u-custom"]);
    check(words(&["hopper", "grace"]), &["u-grace"]);
    check(words(&["555 0100"]), &["u-phone"]);
    check(words(&["(555) 0100"]), &["u-phone"]);
    check(
        UserFilter {
            words: vec![TextTerm::negated("example")],
            ..UserFilter::default()
        },
        &without(&["u-ada", "u-grace"]),
    );
    let text = |field: &str, value: &str| {
        let term = vec![TextTerm::new(value)];
        match field {
            "email" => UserFilter {
                email: term,
                ..UserFilter::default()
            },
            "name" => UserFilter {
                name: term,
                ..UserFilter::default()
            },
            _ => UserFilter {
                phone: term,
                ..UserFilter::default()
            },
        }
    };
    check(text("email", "EXAMPLE.test"), &["u-ada", "u-grace"]);
    check(text("name", "love"), &["u-ada"]);
    check(text("phone", "+1 (555) 0100"), &["u-phone"]);
    check(text("phone", "5550100"), &["u-phone"]);
    let uid = |any: &[&str]| UserFilter {
        uid: Choice {
            any_of: any.iter().map(|id| IdMatch::parse(id)).collect(),
            none_of: Vec::new(),
        },
        ..UserFilter::default()
    };
    check(uid(&["sample-*"]), &["sample-1"]);
    check(uid(&["u-ada", "u-anon"]), &["u-ada", "u-anon"]);
    check(uid(&["U-ADA"]), &[]);
    // Base and facet terms combine.
    check(
        UserFilter {
            words: vec![TextTerm::new("example")],
            has: Choice {
                any_of: vec![UserHas::Password],
                none_of: Vec::new(),
            },
            ..UserFilter::default()
        },
        &["u-ada"],
    );
}

#[test]
fn the_user_filter_round_trips_as_json() {
    let filter = UserFilter {
        words: vec![TextTerm::new("ada"), TextTerm::negated("bob")],
        uid: Choice {
            any_of: vec![IdMatch::parse("sample-*")],
            none_of: Vec::new(),
        },
        created: vec![TimeTerm {
            from: Some(1),
            until: None,
            negated: false,
        }],
        is: Choice {
            any_of: vec![UserState::CustomToken],
            none_of: vec![UserState::Verified],
        },
        has: Choice {
            any_of: Vec::new(),
            none_of: vec![UserHas::SignIn],
        },
        claim: Choice {
            any_of: vec![
                ClaimMatch::value("flag", JsonValue::Null),
                ClaimMatch::key("role"),
            ],
            none_of: Vec::new(),
        },
        ..UserFilter::default()
    };
    let text = serde_json::to_string(&filter).expect("serialize");
    assert_eq!(
        text,
        r#"{"words":[{"value":"ada"},{"value":"bob","negated":true}],"uid":{"anyOf":[{"prefix":"sample-"}]},"created":[{"from":1}],"is":{"anyOf":["custom-token"],"noneOf":["verified"]},"has":{"noneOf":["sign-in"]},"claim":{"anyOf":[{"key":"flag","value":null},{"key":"role"}]}}"#
    );
    assert_eq!(
        serde_json::from_str::<UserFilter>(&text).expect("parse"),
        filter
    );
    assert!(UserFilter::default().is_empty());
    assert!(serde_json::from_str::<UserFilter>(r#"{"nope":1}"#).is_err());
    for state in UserState::ALL {
        assert_eq!(UserState::parse(state.as_str()), Some(state));
    }
    for value in UserHas::ALL {
        assert_eq!(UserHas::parse(value.as_str()), Some(value));
    }
    for column in UserColumn::ALL {
        assert_eq!(UserColumn::parse(column.as_str()), Some(column));
    }
    assert_eq!(UserSort::default().to_string(), "created:desc");
    assert_eq!(
        UserSort::parse("signedIn:asc")
            .map(|sort| sort.to_string())
            .as_deref(),
        Some("signedIn:asc")
    );
    assert!(UserSort::parse("created").is_none() && UserSort::parse("age:asc").is_none());
}

// ---------------------------------------------------------------- 4. facets

#[test]
fn facets_ignore_facet_terms_and_follow_base_terms() {
    let runtime = test_runtime();
    filter_fixture(&runtime);
    let view = view(&runtime, None);
    let unfiltered = view
        .page(&query(&UserFilter::default(), "uid:asc", 10))
        .expect("page")
        .facets
        .expect("facets");
    assert_eq!(unfiltered.disabled, 1);
    assert_eq!(
        unfiltered.unverified, 3,
        "grace, sample-1, Mixed: an email, not verified"
    );
    assert_eq!(unfiltered.anonymous, 1);
    assert_eq!(unfiltered.custom_token, 1);
    assert_eq!(unfiltered.sample, 1);
    assert_eq!(unfiltered.mfa, 1);
    assert_eq!(unfiltered.claims, 3);
    assert_eq!(unfiltered.never_signed_in, 6);
    assert_eq!(
        unfiltered.providers.first(),
        Some(&ProviderCount {
            provider: "google.com".to_owned(),
            users: 2
        })
    );
    // A facet term changes the rows and the total, not the counts.
    let pressed = view
        .page(&query(
            &UserFilter {
                is: Choice {
                    any_of: vec![UserState::Disabled],
                    none_of: Vec::new(),
                },
                ..UserFilter::default()
            },
            "uid:asc",
            10,
        ))
        .expect("page");
    assert_eq!(pressed.total, Some(1));
    assert_eq!(pressed.facets.as_ref(), Some(&unfiltered));
    // A base term narrows the counts to what it selects.
    let corp = view
        .page(&query(
            &UserFilter {
                words: vec![TextTerm::new("corp")],
                ..UserFilter::default()
            },
            "uid:asc",
            10,
        ))
        .expect("page");
    let facets = corp.facets.expect("facets");
    assert_eq!(corp.total, Some(2));
    assert_eq!(corp.scope_total, Some(8));
    assert_eq!(facets.mfa, 1);
    assert_eq!(facets.unverified, 1);
    assert_eq!(facets.disabled, 0);
    assert_eq!(
        facets.providers,
        vec![
            ProviderCount {
                provider: "google.com".to_owned(),
                users: 1
            },
            ProviderCount {
                provider: "oidc.github".to_owned(),
                users: 1
            },
            ProviderCount {
                provider: "saml.okta".to_owned(),
                users: 1
            },
        ]
    );
}

#[test]
fn maintained_counters_equal_a_full_recount_on_random_states() {
    for seed in 0..20 {
        let (runtime, uids) = populated(150, 100 + seed);
        let mut random = Lcg::new(seed);
        with_state(&runtime, None, |state| {
            for _ in 0..40 {
                let uid = &uids[random.below(uids.len())];
                if let Some(user) = state.get_user_by_local_id(uid) {
                    if random.chance(20) {
                        state.delete_user(&user);
                    } else {
                        let mut fields = UserRecord::new();
                        fields.insert("disabled".to_owned(), json!(random.chance(50)));
                        fields.insert("customAttributes".to_owned(), json!(r#"{"x":1}"#));
                        state
                            .update_user_by_local_id(
                                uid,
                                &fields,
                                crate::state::UpdateOptions::default(),
                            )
                            .expect("update");
                    }
                }
            }
        });
        let view = view(&runtime, None);
        let counted = view
            .page(&query(&UserFilter::default(), "uid:asc", 1))
            .expect("page")
            .facets
            .expect("facets");
        // A word every haystack holds forces the full pass.
        let recounted = view
            .page(&query(
                &UserFilter {
                    words: vec![TextTerm::new("")],
                    ..UserFilter::default()
                },
                "uid:asc",
                1,
            ))
            .expect("page")
            .facets
            .expect("facets");
        assert_eq!(counted, recounted, "seed {seed}");
    }
}

// ---------------------------------------------------------------- 5. pins

#[test]
fn a_selective_filter_scans_once_and_later_pages_slice_its_pin() {
    let (runtime, accounts) = populated(400, 5);
    with_state(&runtime, None, |state| {
        for uid in accounts.iter().step_by(9) {
            let mut fields = UserRecord::new();
            fields.insert("disabled".to_owned(), json!(true));
            state
                .update_user_by_local_id(uid, &fields, crate::state::UpdateOptions::default())
                .expect("update");
        }
    });
    let disabled = UserFilter {
        is: Choice {
            any_of: vec![UserState::Disabled],
            none_of: Vec::new(),
        },
        ..UserFilter::default()
    };
    let snapshot = view(&runtime, None);
    let scans = snapshot.index.scans();
    let first = snapshot
        .page(&query(&disabled, "email:asc", 10))
        .expect("first");
    assert_eq!(
        snapshot.index.scans(),
        scans + 1,
        "the first page scans once"
    );
    let next = first.next.clone().expect("more");
    assert!(next.pin.is_some(), "the match list is pinned");
    let second = snapshot
        .page(&UsersQuery {
            cursor: Some(next.clone()),
            ..query(&disabled, "email:asc", 10)
        })
        .expect("second");
    let third = snapshot
        .page(&UsersQuery {
            cursor: second.next.clone(),
            ..query(&disabled, "email:asc", 10)
        })
        .expect("third");
    assert_eq!(
        snapshot.index.scans(),
        scans + 1,
        "later pages slice the pin"
    );
    assert_eq!(second.rows.len(), 10);
    assert_eq!(third.rows.len(), 10);

    // A user deleted after the first page is missing from the next.
    let victim = second.rows[3].uid.clone();
    with_state(&runtime, None, |state| {
        let user = state.get_user_by_local_id(&victim).expect("user");
        state.delete_user(&user);
    });
    let now = view(&runtime, None);
    let again = now
        .page(&UsersQuery {
            cursor: Some(next.clone()),
            ..query(&disabled, "email:asc", 10)
        })
        .expect("second again");
    let mut expected = uids(&second);
    expected.retain(|uid| *uid != victim);
    assert_eq!(uids(&again), expected);

    // An evicted pin falls back to seek and walk, with the same rows.
    let pinned = now
        .page(&UsersQuery {
            cursor: second.next.clone(),
            ..query(&disabled, "email:asc", 10)
        })
        .expect("pinned");
    now.index.forget_pins();
    let walked = now
        .page(&UsersQuery {
            cursor: second.next.clone(),
            ..query(&disabled, "email:asc", 10)
        })
        .expect("walked");
    assert_eq!(uids(&walked), uids(&pinned));
    assert!(
        walked
            .next
            .as_ref()
            .is_none_or(|cursor| cursor.pin.is_none())
    );
    // A pin is only used with the filter it was made for.
    let other = UserFilter {
        is: Choice {
            any_of: vec![UserState::Verified],
            none_of: Vec::new(),
        },
        ..UserFilter::default()
    };
    let refiltered = now
        .page(&UsersQuery {
            cursor: Some(next),
            ..query(&other, "email:asc", 10)
        })
        .expect("another filter");
    assert!(refiltered.rows.iter().all(|row| row.email_verified));
}

// ---------------------------------------------------------------- 6–8. reads

#[tokio::test]
async fn console_reads_never_mutate_or_create() {
    let directory = std::env::temp_dir().join(format!(
        "firenook-auth-console-reads-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));
    let state_file = directory.join("auth-state.json");
    let registry = firenook_functions_bridge::TriggerRegistry::default();
    let (observer, _receiver) =
        firenook_functions_bridge::TriggerObserver::channel(registry.clone());
    let runtime = AuthRuntime::new(
        PROJECT,
        observer.queue(),
        registry,
        Some(state_file.clone()),
    )
    .expect("runtime");
    let (status, body) = call(
        &runtime,
        Method::POST,
        &format!("{CLIENT}/accounts:signUp?key=fake"),
        &json!({ "email": "reader@example.test", "password": "password1", "returnSecureToken": true }),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let uid = body["localId"].as_str().expect("uid").to_owned();
    let (status, body) = call(
        &runtime,
        Method::POST,
        &format!("{ADMIN}/tenants/acme/accounts"),
        &json!({ "localId": "t1", "email": "t1@acme.test", "customAttributes": r#"{"role":"x"}"# }),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let stamp = || {
        std::fs::metadata(&state_file)
            .ok()
            .map(|meta| (meta.len(), meta.modified().ok()))
    };
    let generation = || lock(&runtime.runtime().inner.data).generation();
    runtime.flush().expect("flush");
    let encodes = || runtime.runtime().persist_stats().expect("persists").encodes;
    let before = (stamp().expect("persisted"), generation(), encodes());
    std::thread::sleep(Duration::from_millis(20));

    let handle = runtime.runtime();
    for tenant in [None, Some("acme")] {
        let view = handle.users(PROJECT, tenant).expect("view");
        let filtered = UserFilter {
            words: vec![TextTerm::new("e")],
            ..UserFilter::default()
        };
        let first = view.page(&query(&filtered, "email:asc", 1)).expect("page");
        if let Some(next) = first.next {
            view.page(&UsersQuery {
                cursor: Some(next),
                ..query(&filtered, "email:asc", 1)
            })
            .expect("next");
        }
        view.page(&UsersQuery::default()).expect("unfiltered");
        view.batch(&UsersBatchQuery {
            uids: vec![uid.clone()],
            ..UsersBatchQuery::default()
        })
        .expect("batch");
        let _ = view.claim_keys();
    }
    handle.user(PROJECT, None, &uid).expect("detail");
    handle
        .user(PROJECT, Some("acme"), "t1")
        .expect("tenant detail");
    assert!(handle.user(PROJECT, None, "ghost").is_err());
    assert!(handle.users(PROJECT, Some("no-such-tenant")).is_err());
    assert!(handle.user(PROJECT, Some("no-such-tenant"), "t1").is_err());
    assert!(handle.users("demo-other", None).expect("empty").is_empty());
    assert!(handle.users("demo-other", Some("acme")).is_err());
    runtime.flush().expect("flush");
    assert_eq!(
        (stamp().expect("state file"), generation(), encodes()),
        before,
        "reads change nothing"
    );
    {
        let data = lock(&handle.inner.data);
        assert!(
            !data.projects.contains_key("demo-other"),
            "no project was created"
        );
        assert!(
            !data.projects[PROJECT]
                .tenants
                .contains_key("no-such-tenant")
        );
    }

    // A fresh engine: nothing is created, nothing is written.
    let fresh_file = directory.join("fresh.json");
    let registry = firenook_functions_bridge::TriggerRegistry::default();
    let (observer, _receiver) =
        firenook_functions_bridge::TriggerObserver::channel(registry.clone());
    let fresh = AuthRuntime::new(
        PROJECT,
        observer.queue(),
        registry,
        Some(fresh_file.clone()),
    )
    .expect("runtime");
    let fresh_handle = fresh.runtime();
    let view = fresh_handle.users(PROJECT, None).expect("view");
    assert_eq!(
        view.page(&UsersQuery::default()).expect("page").rows,
        Vec::new()
    );
    assert_eq!(view.claim_keys().keys, Vec::new());
    assert!(fresh_handle.users(PROJECT, Some("acme")).is_err());
    assert!(fresh_handle.user(PROJECT, None, "ghost").is_err());
    assert_eq!(lock(&fresh_handle.inner.data).projects.len(), 0);
    assert!(!fresh_file.exists(), "nothing was persisted");
    let _ = std::fs::remove_dir_all(&directory);
}

#[test]
fn queries_run_outside_the_lock() {
    let (runtime, _) = populated(2_000, 7);
    let handle = runtime.runtime();
    // The query has taken its snapshot and is still running: it waits for a
    // sign-up on another thread, which needs the data lock. Were the lock
    // held by the query, the sign-up could not finish.
    let view = handle.users(PROJECT, None).expect("view");
    let application = runtime.application();
    let (done, finished) = std::sync::mpsc::channel();
    let signing_up = std::thread::spawn(move || {
        let threads = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("tokio");
        threads.block_on(async move {
            use tower::ServiceExt as _;
            let request = axum::http::Request::builder()
                .method(Method::POST)
                .uri(format!("{CLIENT}/accounts:signUp?key=fake"))
                .header("content-type", "application/json")
                .body(axum::body::Body::from(
                    json!({ "email": "while@example.test", "password": "password1" }).to_string(),
                ))
                .expect("request");
            let response = application.oneshot(request).await.expect("response");
            assert_eq!(response.status(), 200);
        });
        let _ = done.send(());
    });
    finished
        .recv_timeout(Duration::from_secs(30))
        .expect("the sign-up finishes while the query holds its snapshot");
    signing_up.join().expect("sign-up thread");
    let page = view
        .page(&query(
            &UserFilter {
                words: vec![TextTerm::new("while")],
                ..UserFilter::default()
            },
            "created:desc",
            10,
        ))
        .expect("page");
    assert_eq!(
        page.rows,
        Vec::new(),
        "the snapshot is the state before the sign-up"
    );
    assert_eq!(
        handle.users(PROJECT, None).expect("view").len(),
        view.len() + 1
    );
}

#[tokio::test]
async fn an_unknown_tenant_is_not_found_and_not_created() {
    let runtime = test_runtime();
    let (status, body) = call(
        &runtime,
        Method::POST,
        &format!("{ADMIN}/accounts"),
        &json!({ "localId": "p1" }),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let handle = runtime.runtime();
    let error = handle
        .users(PROJECT, Some("acme"))
        .expect_err("unknown tenant");
    assert_eq!(error.kind, ConsoleErrorKind::NotFound);
    assert_eq!(error.message, "There is no tenant `acme` in this project.");
    assert_eq!(
        error.fix.as_deref(),
        Some("Pick a tenant from the list, or create it in Settings.")
    );
    let error = handle.user(PROJECT, None, "u_x").expect_err("unknown user");
    assert_eq!(error.kind, ConsoleErrorKind::NotFound);
    assert_eq!(
        error.message,
        "There is no user `u_x` among the project's users."
    );
    assert_eq!(
        error.fix.as_deref(),
        Some("It may have been deleted; reload the list.")
    );
    let (status, _) = call(
        &runtime,
        Method::POST,
        &format!("{ADMIN}/tenants/globex/accounts"),
        &json!({ "localId": "g1" }),
    )
    .await;
    assert_eq!(status, 200);
    let error = handle
        .user(PROJECT, Some("globex"), "u_x")
        .expect_err("unknown tenant user");
    assert_eq!(error.message, "There is no user `u_x` in tenant `globex`.");
    let data = lock(&handle.inner.data);
    let tenants: Vec<&String> = data.projects[PROJECT].tenants.keys().collect();
    assert_eq!(tenants, vec!["globex"], "acme was not created");
}

#[tokio::test]
async fn the_detail_shows_every_stored_field() {
    let runtime = test_runtime();
    let (status, body) = call(
        &runtime,
        Method::POST,
        &format!("{ADMIN}/accounts"),
        &json!({ "localId": "detail", "email": "detail@example.test", "password": "s3cret!", "displayName": "Dee",
                 "phoneNumber": "+15550123", "emailVerified": true }),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let (status, body) = call(
        &runtime,
        Method::POST,
        &format!("{ADMIN}/accounts:update"),
        &json!({ "localId": "detail", "customAttributes": r#"{"role":"admin","tier":"é🔥"}"#,
                 "mfa": { "enrollments": [{ "mfaEnrollmentId": "f1", "phoneInfo": "+15550999", "displayName": "Work" }] },
                 "linkProviderUserInfo": { "providerId": "google.com", "rawId": "g-dee", "email": "dee@gmail.test", "displayName": "Dee G" } }),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let detail = runtime
        .runtime()
        .user(PROJECT, None, "detail")
        .expect("detail");
    assert_eq!(detail.password.as_deref(), Some("s3cret!"));
    assert!(!detail.password_opaque);
    assert!(detail.password_updated_at.is_some());
    assert_eq!(detail.row.uid, "detail");
    assert_eq!(detail.row.mfa, 1);
    assert_eq!(detail.row.claim_keys, vec!["role", "tier"]);
    assert_eq!(
        detail.claims_text.as_deref(),
        Some(r#"{"role":"admin","tier":"é🔥"}"#)
    );
    assert_eq!(detail.claims_length, 29, "é counts one, 🔥 two");
    assert_eq!(
        detail.claims.as_ref().map(|claims| claims["role"].clone()),
        Some(json!("admin"))
    );
    assert_eq!(detail.mfa[0].phone_number.as_deref(), Some("+15550999"));
    assert_eq!(detail.mfa[0].display_name.as_deref(), Some("Work"));
    let providers: Vec<&str> = detail
        .provider_info
        .iter()
        .map(|info| info.provider_id.as_str())
        .collect();
    assert!(
        providers.contains(&"google.com")
            && providers.contains(&"password")
            && providers.contains(&"phone")
    );
    assert_eq!(detail.record["localId"], "detail");
    // A production hash cannot be read back.
    let (status, _) = call(
        &runtime,
        Method::POST,
        &format!("{ADMIN}/accounts:batchCreate"),
        &json!({ "users": [{ "localId": "opaque", "email": "o@example.test", "passwordHash": "c2NyeXB0", "salt": "c2FsdA" }] }),
    )
    .await;
    assert_eq!(status, 200);
    let opaque = runtime
        .runtime()
        .user(PROJECT, None, "opaque")
        .expect("detail");
    assert!(opaque.password.is_none() && opaque.password_opaque);
}

// ---------------------------------------------------------------- 16. claim keys

#[tokio::test]
async fn claim_keys_count_kinds_samples_and_cache_until_claims_change() {
    let runtime = test_runtime();
    with_state(&runtime, None, |state| {
        for (index, claims) in [
            r#"{"role":"admin","tier":1}"#,
            r#"{"role":"editor","tier":2}"#,
            r#"{"role":"viewer","tier":"gold"}"#,
            r#"{"role":"admin"}"#,
            r#"{"role":"owner","flags":[1]}"#,
        ]
        .iter()
        .enumerate()
        {
            create(
                state,
                &format!("c{index}"),
                &json!({ "email": format!("c{index}@example.test"), "customAttributes": claims }),
            );
        }
        create(state, "plain", &json!({ "email": "plain@example.test" }));
    });
    let snapshot = view(&runtime, None);
    let keys = snapshot.claim_keys();
    assert_eq!(keys.users_with_claims, 5);
    let key = |name: &str| keys.keys.iter().find(|key| key.key == name).expect("key");
    assert_eq!(keys.keys[0].key, "role", "most users first");
    assert_eq!(key("role").users, 5);
    assert_eq!(key("role").kinds, vec!["string"]);
    assert_eq!(
        key("role").samples.len(),
        CLAIM_SAMPLES,
        "at most three distinct values"
    );
    assert_eq!(key("tier").users, 3);
    assert_eq!(key("tier").kinds, vec!["number", "string"]);
    assert_eq!(key("flags").kinds, vec!["array"]);
    let scans = snapshot.index.claim_scans();

    // A sign-in and a refresh change no claims: the cache holds.
    let (status, body) = call(
        &runtime,
        Method::POST,
        &format!("{CLIENT}/accounts:signUp?key=fake"),
        &json!({ "email": "new@example.test", "password": "password1", "returnSecureToken": true }),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let refresh = body["refreshToken"].as_str().expect("refresh").to_owned();
    let (status, _) = call(
        &runtime,
        Method::POST,
        "/securetoken.googleapis.com/v1/token?key=fake",
        &json!({ "grant_type": "refresh_token", "refresh_token": refresh }),
    )
    .await;
    assert_eq!(status, 200);
    let after_sign_in = view(&runtime, None);
    assert_eq!(
        after_sign_in.claims_generation(),
        snapshot.claims_generation()
    );
    assert_eq!(after_sign_in.claim_keys(), keys);
    assert_eq!(
        after_sign_in.index.claim_scans(),
        scans,
        "served from the cache"
    );

    // A claims change rebuilds it.
    let (status, _) = call(
        &runtime,
        Method::POST,
        &format!("{ADMIN}/accounts:update"),
        &json!({ "localId": "plain", "customAttributes": r#"{"beta":true}"# }),
    )
    .await;
    assert_eq!(status, 200);
    let changed = view(&runtime, None);
    assert_ne!(changed.claims_generation(), snapshot.claims_generation());
    let keys = changed.claim_keys();
    assert_eq!(changed.index.claim_scans(), scans + 1);
    assert_eq!(keys.users_with_claims, 6);
    assert!(
        keys.keys
            .iter()
            .any(|key| key.key == "beta" && key.kinds == vec!["boolean"])
    );
}

#[test]
fn claim_keys_stop_at_two_hundred() {
    let runtime = test_runtime();
    with_state(&runtime, None, |state| {
        for index in 0..230 {
            let claims = json!({ format!("key{index:03}"): index, "shared": true }).to_string();
            create(
                state,
                &format!("k{index}"),
                &json!({ "customAttributes": claims }),
            );
        }
    });
    let keys = view(&runtime, None).claim_keys();
    assert_eq!(keys.keys.len(), MAX_CLAIM_KEYS);
    assert_eq!(keys.keys[0].key, "shared");
    assert_eq!(keys.keys[0].users, 230);
}

// ---------------------------------------------------------------- 19. smoke

/// The CI ceilings (debug build, 10,000 users) of the engine budgets: about
/// ten times the expected figure, so they never flake and still catch a
/// change of complexity class.
#[test]
fn index_reads_and_upkeep_stay_within_their_ceilings_at_ten_thousand_users() {
    let (runtime, uids) = populated(10_000, 19);
    let handle = runtime.runtime();
    let best = |runs: usize, mut body: Box<dyn FnMut() -> Duration + '_>| {
        (0..runs).map(|_| body()).min().unwrap_or_default()
    };

    // The data lock is held only to resolve the scope and clone the index.
    let hold = best(
        20,
        Box::new(|| {
            let started = Instant::now();
            let _view = handle.users(PROJECT, None).expect("view");
            started.elapsed()
        }),
    );
    assert!(hold <= Duration::from_micros(200), "lock hold {hold:?}");

    let view = handle.users(PROJECT, None).expect("view");
    let unfiltered = query(&UserFilter::default(), "created:desc", 100);
    let first = best(5, Box::new(|| view.page(&unfiltered).expect("page").took));
    assert!(first <= Duration::from_millis(20), "first page {first:?}");
    let page = view.page(&unfiltered).expect("page");
    let later = UsersQuery {
        cursor: page.next.clone(),
        ..unfiltered.clone()
    };
    let next = best(5, Box::new(|| view.page(&later).expect("page").took));
    assert!(next <= Duration::from_millis(10), "later page {next:?}");

    let words = query(
        &UserFilter {
            words: vec![TextTerm::new("ada")],
            ..UserFilter::default()
        },
        "email:asc",
        100,
    );
    let filtered = best(3, Box::new(|| view.page(&words).expect("page").took));
    assert!(
        filtered <= Duration::from_millis(60),
        "filtered first page {filtered:?}"
    );
    let pinned_first = view.page(&words).expect("page");
    let pinned_query = UsersQuery {
        cursor: pinned_first.next.clone(),
        ..words.clone()
    };
    let pinned = best(5, Box::new(|| view.page(&pinned_query).expect("page").took));
    assert!(
        pinned <= Duration::from_millis(10),
        "pinned later page {pinned:?}"
    );

    let batch_uids: Vec<String> = uids.iter().step_by(20).take(500).cloned().collect();
    let batch = UsersBatchQuery {
        uids: batch_uids.clone(),
        sort: sort("created:desc"),
        page_starts: vec![None, page.next.clone()],
        ..UsersBatchQuery::default()
    };
    let batched = best(
        3,
        Box::new(|| {
            let started = Instant::now();
            view.batch(&batch).expect("batch");
            started.elapsed()
        }),
    );
    assert!(batched <= Duration::from_millis(20), "batchGet {batched:?}");
    let batch_words = UsersBatchQuery {
        filter: words.filter.clone(),
        ..batch.clone()
    };
    let batched_words = best(
        3,
        Box::new(|| {
            let started = Instant::now();
            view.batch(&batch_words).expect("batch");
            started.elapsed()
        }),
    );
    assert!(
        batched_words <= Duration::from_millis(60),
        "batchGet with words {batched_words:?}"
    );

    // Upkeep: one account change, averaged over 1,000 sign-in-like changes.
    let upkeep = with_state(&runtime, None, |state| {
        let mut index = UserIndex::build(&state.users);
        let records: Vec<(String, UserRecord)> = uids
            .iter()
            .take(1_000)
            .enumerate()
            .map(|(offset, uid)| {
                let mut user = state.get_user_by_local_id(uid).expect("user");
                user.insert(
                    "lastLoginAt".to_owned(),
                    json!((1_800_000_000_000_i64 + i64::try_from(offset).unwrap_or(0)).to_string()),
                );
                (uid.clone(), user)
            })
            .collect();
        let _held = index.snapshot();
        let started = Instant::now();
        for (uid, user) in &records {
            index.upsert(uid, user);
        }
        started.elapsed() / 1_000
    });
    assert!(
        upkeep <= Duration::from_micros(100),
        "index upkeep {upkeep:?} per change"
    );
}

/// Bytes per user of realistic users, from the index's layout, recorded at
/// 100,000 users by `index_memory_at_a_hundred_thousand_users` in release:
/// 795 bytes per user with every ordered set counted at `im`'s half-full
/// worst case (the process's resident memory grew by 846 bytes per user
/// across the same build). The check allows 1.25 times it.
const RECORDED_BYTES_PER_USER: usize = 795;

#[test]
fn index_memory_per_user_stays_near_the_recorded_figure() {
    let (runtime, _) = populated(10_000, 11);
    let snapshot = runtime.runtime().users(PROJECT, None).expect("view").index;
    let per_user = snapshot.estimated_bytes() / 10_000;
    assert!(
        per_user * 4 <= RECORDED_BYTES_PER_USER * 5,
        "{per_user} bytes per user; recorded {RECORDED_BYTES_PER_USER}"
    );
}

/// `cargo test -p firenook-auth-front --release -- --ignored --nocapture
/// index_bench`: the engine budgets of the index at 10,000 and 100,000
/// realistic users, printed (figures for a product claim come from the
/// private acceptance host only).
#[test]
#[ignore = "a benchmark, run by hand in release"]
fn index_bench_at_ten_and_a_hundred_thousand_users() {
    for users in [10_000, 100_000] {
        let (runtime, uids) = populated(users, 23);
        let handle = runtime.runtime();
        let best = |mut body: Box<dyn FnMut() -> Duration + '_>| {
            (0..9).map(|_| body()).min().unwrap_or_default()
        };
        let timed = |body: &dyn Fn()| {
            let started = Instant::now();
            body();
            started.elapsed()
        };
        let hold = best(Box::new(|| {
            timed(&|| drop(handle.users(PROJECT, None).expect("view")))
        }));
        let view = handle.users(PROJECT, None).expect("view");
        let unfiltered = query(&UserFilter::default(), "created:desc", 100);
        let first = best(Box::new(|| view.page(&unfiltered).expect("page").took));
        let page = view.page(&unfiltered).expect("page");
        let later_query = UsersQuery {
            cursor: page.next.clone(),
            ..unfiltered.clone()
        };
        let later = best(Box::new(|| view.page(&later_query).expect("page").took));
        let words = query(
            &UserFilter {
                words: vec![TextTerm::new("ada")],
                ..UserFilter::default()
            },
            "email:asc",
            100,
        );
        let filtered = best(Box::new(|| view.page(&words).expect("page").took));
        let pinned_first = view.page(&words).expect("page");
        let pinned_query = UsersQuery {
            cursor: pinned_first.next.clone(),
            ..words.clone()
        };
        let pinned = best(Box::new(|| view.page(&pinned_query).expect("page").took));
        let selective = query(
            &UserFilter {
                is: Choice {
                    any_of: vec![UserState::Disabled],
                    none_of: Vec::new(),
                },
                ..UserFilter::default()
            },
            "created:desc",
            100,
        );
        let selective_first = view.page(&selective).expect("page");
        let evicted_query = UsersQuery {
            cursor: selective_first.next.clone(),
            ..selective.clone()
        };
        let evicted = best(Box::new(|| {
            view.index.forget_pins();
            view.page(&evicted_query).expect("page").took
        }));
        let batch = UsersBatchQuery {
            uids: uids
                .iter()
                .step_by(users / 500)
                .take(500)
                .cloned()
                .collect(),
            sort: sort("created:desc"),
            page_starts: vec![None, page.next.clone()],
            ..UsersBatchQuery::default()
        };
        let batched = best(Box::new(|| {
            timed(&|| drop(view.batch(&batch).expect("batch")))
        }));
        let batch_words = UsersBatchQuery {
            filter: words.filter.clone(),
            ..batch.clone()
        };
        let batched_words = best(Box::new(|| {
            timed(&|| drop(view.batch(&batch_words).expect("batch")))
        }));
        let claims = timed(&|| drop(view.claim_keys()));
        let upkeep = with_state(&runtime, None, |state| {
            let mut index = UserIndex::build(&state.users);
            let records: Vec<(String, UserRecord)> = uids
                .iter()
                .take(1_000)
                .map(|uid| {
                    let mut user = state.get_user_by_local_id(uid).expect("user");
                    user.insert("lastLoginAt".to_owned(), json!("1800000000000"));
                    (uid.clone(), user)
                })
                .collect();
            let _held = index.snapshot();
            let started = Instant::now();
            for (uid, user) in &records {
                index.upsert(uid, user);
            }
            started.elapsed() / 1_000
        });
        println!(
            "{users} users: lock hold {hold:?}; first page {first:?}; later page {later:?}; \
             first page with words {filtered:?}; pinned later page {pinned:?}; \
             selective filter, pin evicted {evicted:?}; batchGet 500 {batched:?}; \
             batchGet 500 with words {batched_words:?}; claim keys uncached {claims:?}; \
             upkeep {upkeep:?} per change"
        );
    }
}

/// `cargo test -p firenook-auth-front --release -- --ignored --nocapture
/// index_memory_at`: the estimate per user at 100,000 realistic users, and
/// the resident memory the index added, measured around its build.
#[test]
#[ignore = "a measurement, run by hand in release"]
fn index_memory_at_a_hundred_thousand_users() {
    let mut random = Lcg::new(11);
    let users: std::collections::BTreeMap<String, UserRecord> = (0..100_000)
        .map(|index| realistic_user(index, &mut random))
        .collect();
    let before = resident_kib();
    let started = Instant::now();
    let index = UserIndex::build(&users);
    let built = started.elapsed();
    let after = resident_kib();
    let snapshot = index.snapshot();
    let per_user = snapshot.estimated_bytes() / users.len();
    println!(
        "100,000 users: built in {built:?}; estimated {per_user} bytes per user; resident +{} KiB ({} bytes per user)",
        after.saturating_sub(before),
        after.saturating_sub(before) * 1024 / 100_000
    );
}

/// The process's resident set in KiB, from `ps`.
fn resident_kib() -> usize {
    std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &std::process::id().to_string()])
        .output()
        .ok()
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .and_then(|text| text.trim().parse().ok())
        .unwrap_or(0)
}

// ---------------------------------------------------------------- persistence bench

/// A runtime that persists to a fresh state file, holding `users` realistic
/// project users, and the (email, password) of its password users.
fn persisted(users: usize, seed: u64) -> (AuthRuntime, std::path::PathBuf, Vec<(String, String)>) {
    let directory = std::env::temp_dir().join(format!(
        "firenook-auth-bench-{}-{users}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));
    let state_file = directory.join("auth-state.json");
    let registry = firenook_functions_bridge::TriggerRegistry::default();
    let (observer, _receiver) =
        firenook_functions_bridge::TriggerObserver::channel(registry.clone());
    let runtime = AuthRuntime::new(
        PROJECT,
        observer.queue(),
        registry,
        Some(state_file.clone()),
    )
    .expect("runtime");
    let mut random = Lcg::new(seed);
    let credentials = runtime
        .runtime()
        .update(|data| {
            let state = &mut data.agent(PROJECT).project;
            let mut credentials = Vec::new();
            for index in 0..users {
                let (uid, user) = realistic_user(index, &mut random);
                if let (Some(email), Some(hash), false) = (
                    str_field(&user, "email"),
                    str_field(&user, "passwordHash"),
                    truthy(user.get("disabled")),
                ) && let Some(password) = recoverable_password(hash)
                {
                    credentials.push((email.to_owned(), password));
                }
                state
                    .create_user_with_local_id(&uid, &user)
                    .expect("create")
                    .expect("new");
            }
            credentials
        })
        .expect("populated");
    runtime.flush().expect("flush");
    (runtime, directory, credentials)
}

/// Password sign-ins through the Auth application, timed one by one after
/// ten to warm up.
async fn sign_in_latencies(
    runtime: &AuthRuntime,
    credentials: &[(String, String)],
    samples: usize,
) -> Vec<Duration> {
    let mut latencies = Vec::with_capacity(samples);
    for round in 0..samples + 10 {
        let (email, password) = &credentials[round % credentials.len()];
        let started = Instant::now();
        let (status, body) = call(
            runtime,
            Method::POST,
            &format!("{CLIENT}/accounts:signInWithPassword?key=fake"),
            &json!({ "email": email, "password": password, "returnSecureToken": true }),
        )
        .await;
        let took = started.elapsed();
        assert_eq!(status, 200, "{body}");
        if round >= 10 {
            latencies.push(took);
        }
    }
    latencies
}

/// A sign-in never waits for the state to be encoded: at 10,000 users with
/// persistence on its p99 stays within 50 ms and within three times (plus
/// 2 ms of scheduling slack) the 100-user p99 measured in the same run.
#[tokio::test]
async fn a_sign_in_with_persistence_on_does_not_grow_with_the_user_count() {
    let mut p99 = Vec::new();
    for users in [100, 10_000] {
        let (runtime, directory, credentials) = persisted(users, 31);
        let mut latencies = sign_in_latencies(&runtime, &credentials, 200).await;
        p99.push(percentiles(&mut latencies).2);
        drop(runtime);
        let _ = std::fs::remove_dir_all(&directory);
    }
    let (small, large) = (p99[0], p99[1]);
    assert!(
        large <= Duration::from_millis(50),
        "p99 {large:?} at 10,000 users"
    );
    assert!(
        large <= small * 3 + Duration::from_millis(2),
        "p99 {large:?} at 10,000 users, {small:?} at 100"
    );
}

/// Percentiles of `samples` (sorted in place): p50, p95, p99.
fn percentiles(samples: &mut [Duration]) -> (Duration, Duration, Duration) {
    samples.sort();
    let at = |fraction: f64| {
        let last = samples.len().saturating_sub(1);
        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            clippy::cast_precision_loss,
            reason = "an index into a short sample list"
        )]
        let index = ((last as f64) * fraction).round() as usize;
        samples[index.min(last)]
    };
    (at(0.50), at(0.95), at(0.99))
}

/// `cargo test -p firenook-auth-front --release -- --ignored --nocapture
/// sign_in_bench`: password sign-in latency through the Auth application
/// with persistence on, at 100, 10,000 and 100,000 users, and the size of
/// the state file (figures for a product claim come from the private
/// acceptance host only).
#[test]
#[ignore = "a benchmark, run by hand in release"]
fn sign_in_bench_with_persistence() {
    let executor = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio");
    for (users, samples) in [(100, 300), (10_000, 300), (100_000, 100)] {
        let (runtime, directory, credentials) = persisted(users, 29);
        let mut latencies = executor.block_on(sign_in_latencies(&runtime, &credentials, samples));
        let (p50, p95, p99) = percentiles(&mut latencies);
        runtime.flush().expect("flush");
        let stats = runtime.runtime().persist_stats().expect("persists");
        let bytes = std::fs::metadata(directory.join("auth-state.json"))
            .map_or(0, |metadata| metadata.len());
        println!(
            "{users} users: sign-in p50 {p50:?} p95 {p95:?} p99 {p99:?}; auth-state.json {bytes} bytes; \
             {} encodes, last {:?}, writer lock hold at most {:?}",
            stats.encodes, stats.last_encode, stats.longest_hold
        );
        drop(runtime);
        let _ = std::fs::remove_dir_all(&directory);
    }
}
