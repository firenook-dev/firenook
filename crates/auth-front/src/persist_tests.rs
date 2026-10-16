//! The state file's writer: bursts coalesce, `flush` makes the file equal
//! the state, old and new files load, the writer holds the lock only for a
//! snapshot, the last handle writes what is left, and an operation answers
//! once its change is on disk.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use firenook_functions_bridge::{TriggerObserver, TriggerRegistry};
use serde_json::{Value as JsonValue, json};

use crate::state::UserRecord;
use crate::{AuthRuntime, lock};

const PROJECT: &str = "demo-auth";

fn directory(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "firenook-auth-{name}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ))
}

fn persisting(file: &Path) -> AuthRuntime {
    let registry = TriggerRegistry::default();
    let (observer, _receiver) = TriggerObserver::channel(registry.clone());
    AuthRuntime::new(
        PROJECT,
        observer.queue(),
        registry,
        Some(file.to_path_buf()),
    )
    .expect("runtime")
}

fn record(value: &JsonValue) -> UserRecord {
    value.as_object().cloned().expect("a JSON object")
}

/// `users` accounts in the project, created in one change.
fn populate(runtime: &AuthRuntime, users: usize) {
    runtime
        .runtime()
        .update(|data| {
            let state = &mut data.agent(PROJECT).project;
            for index in 0..users {
                let user = record(&json!({
                    "email": format!("user{index}@example.test"),
                    "displayName": format!("User {index}"),
                    "passwordHash": format!("fakeHash:salt=s{index}:password=p{index}"),
                    "salt": format!("s{index}"),
                    "customAttributes": json!({ "n": index }).to_string(),
                }));
                state
                    .create_user_with_local_id(&format!("u{index:05}"), &user)
                    .expect("create")
                    .expect("new");
            }
        })
        .expect("populated");
}

fn on_disk(file: &Path) -> JsonValue {
    serde_json::from_slice(&std::fs::read(file).expect("state file")).expect("state JSON")
}

fn in_memory(runtime: &AuthRuntime) -> JsonValue {
    serde_json::to_value(&*lock(&runtime.runtime().inner.data)).expect("state JSON")
}

fn encodes(runtime: &AuthRuntime) -> u64 {
    runtime.runtime().persist_stats().expect("persists").encodes
}

// ---------------------------------------------------------------- 28

#[test]
fn a_burst_of_a_thousand_changes_is_encoded_at_most_five_times() {
    let root = directory("burst");
    let file = root.join("auth-state.json");
    let runtime = persisting(&file);
    populate(&runtime, 10_000);
    runtime.flush().expect("flush");
    let before = encodes(&runtime);
    let handle = runtime.runtime();
    for index in 0..1_000 {
        handle
            .update(|data| {
                let state = &mut data.agent(PROJECT).project;
                let mut fields = UserRecord::new();
                fields.insert("displayName".to_owned(), json!(format!("Renamed {index}")));
                state
                    .update_user_by_local_id(
                        &format!("u{:05}", index * 7 % 10_000),
                        &fields,
                        crate::state::UpdateOptions::default(),
                    )
                    .expect("update");
            })
            .expect("change");
    }
    runtime.flush().expect("flush");
    let burst = encodes(&runtime) - before;
    assert!(
        (1..=5).contains(&burst),
        "{burst} encodes for 1,000 changes"
    );
    assert_eq!(on_disk(&file), in_memory(&runtime));
    drop(runtime);
    let _ = std::fs::remove_dir_all(&root);
}

// ---------------------------------------------------------------- 29

#[tokio::test]
async fn flush_makes_the_file_equal_the_state() {
    let root = directory("flush");
    let file = root.join("auth-state.json");
    let runtime = persisting(&file);
    populate(&runtime, 20);
    // Codes, a tenant with its own users and configuration.
    for (uri, body) in [
        (
            "/identitytoolkit.googleapis.com/v1/projects/demo-auth/accounts:sendOobCode",
            json!({ "requestType": "PASSWORD_RESET", "email": "user3@example.test", "returnOobLink": true }),
        ),
        (
            "/identitytoolkit.googleapis.com/v2/projects/demo-auth/tenants",
            json!({ "displayName": "acme", "allowPasswordSignup": true }),
        ),
    ] {
        let (status, answer) =
            crate::tests::call(&runtime, axum::http::Method::POST, uri, &body).await;
        assert_eq!(status, 200, "{answer}");
    }
    let tenant = lock(&runtime.runtime().inner.data).projects[PROJECT]
        .tenants
        .keys()
        .next()
        .cloned()
        .expect("tenant");
    let (status, answer) = crate::tests::call(
        &runtime,
        axum::http::Method::POST,
        "/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake",
        &json!({ "email": "t@acme.test", "password": "password1", "tenantId": tenant }),
    )
    .await;
    assert_eq!(status, 200, "{answer}");
    runtime.flush().expect("flush");
    let disk = on_disk(&file);
    assert_eq!(disk, in_memory(&runtime));
    assert_eq!(
        disk["projects"][PROJECT]["oobs"]
            .as_object()
            .map(serde_json::Map::len),
        Some(1)
    );
    assert_eq!(
        disk["projects"][PROJECT]["tenants"][&tenant]["users"]
            .as_object()
            .map(serde_json::Map::len),
        Some(1)
    );
    // The file is compact JSON, a fraction of the pretty form.
    let bytes = std::fs::read(&file).expect("bytes");
    assert!(!bytes.contains(&b'\n'), "compact JSON");
    // A flush with nothing changed writes nothing.
    let before = encodes(&runtime);
    runtime.flush().expect("flush");
    assert_eq!(encodes(&runtime), before);
    drop(runtime);
    let _ = std::fs::remove_dir_all(&root);
}

// ---------------------------------------------------------------- 30

#[test]
fn compact_and_pretty_files_both_load_into_the_persistent_maps() {
    let root = directory("formats");
    let file = root.join("auth-state.json");
    let runtime = persisting(&file);
    populate(&runtime, 50);
    runtime.flush().expect("flush");
    let expected = in_memory(&runtime);
    drop(runtime);

    // The writer's compact file.
    let reopened = persisting(&file);
    assert_eq!(in_memory(&reopened), expected);
    assert_eq!(reopened.user_count(), 50);
    drop(reopened);

    // A pretty file, as every earlier version wrote it.
    let pretty = root.join("pretty.json");
    std::fs::write(
        &pretty,
        serde_json::to_vec_pretty(&expected).expect("pretty"),
    )
    .expect("written");
    let from_pretty = persisting(&pretty);
    assert_eq!(in_memory(&from_pretty), expected);
    let handle = from_pretty.runtime();
    let data = lock(&handle.inner.data);
    let users = &data.projects[PROJECT].project.users;
    assert_eq!(users.len(), 50);
    assert_eq!(
        users.keys().next().map(String::as_str),
        Some("u00000"),
        "in key order"
    );
    // The derived indexes were rebuilt from the loaded maps.
    assert_eq!(
        data.projects[PROJECT]
            .project
            .get_user_by_email("user7@example.test")
            .and_then(|user| user.get("localId").cloned()),
        Some(json!("u00007"))
    );
    drop(data);
    drop(handle);
    drop(from_pretty);
    let _ = std::fs::remove_dir_all(&root);
}

// ---------------------------------------------------------------- 31

#[test]
fn the_writer_holds_the_lock_only_to_snapshot_ten_thousand_users() {
    let root = directory("hold");
    let file = root.join("auth-state.json");
    let runtime = persisting(&file);
    populate(&runtime, 10_000);
    runtime.flush().expect("flush");
    let stats = runtime.runtime().persist_stats().expect("persists");
    assert!(
        stats.longest_hold < Duration::from_millis(1),
        "the writer held the lock {:?}",
        stats.longest_hold
    );
    drop(runtime);
    let _ = std::fs::remove_dir_all(&root);
}

// ---------------------------------------------------------------- the writer

#[test]
fn a_change_reaches_the_file_without_a_flush_and_the_last_handle_writes_the_rest() {
    let root = directory("writer");
    let file = root.join("auth-state.json");
    let runtime = persisting(&file);
    populate(&runtime, 3);
    // The writer publishes within its delay; allow for a loaded machine.
    let deadline = Instant::now() + Duration::from_secs(10);
    while !file.exists() {
        assert!(Instant::now() < deadline, "the writer never wrote");
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(
        on_disk(&file)["projects"][PROJECT]["users"]
            .as_object()
            .map(serde_json::Map::len),
        Some(3)
    );

    // A change and an immediate drop: the drop writes it.
    runtime
        .runtime()
        .update(|data| {
            let state = &mut data.agent(PROJECT).project;
            state
                .create_user_with_local_id("late", &UserRecord::new())
                .expect("create");
        })
        .expect("change");
    let expected = in_memory(&runtime);
    drop(runtime);
    assert_eq!(on_disk(&file), expected);
    let _ = std::fs::remove_dir_all(&root);
}

const CLIENT: &str = "/identitytoolkit.googleapis.com/v1";

async fn sign_up(runtime: &AuthRuntime, email: &str) -> (u16, JsonValue) {
    crate::tests::call(
        runtime,
        axum::http::Method::POST,
        &format!("{CLIENT}/accounts:signUp?key=fake"),
        &json!({ "email": email, "password": "password1" }),
    )
    .await
}

/// A sign-up is on disk when it answers, and when the state cannot be
/// written the sign-up fails instead of being acknowledged and lost; a
/// sign-in only stamps `lastLoginAt`, which is written behind and never
/// fails the sign-in.
#[tokio::test]
async fn an_operation_answers_once_its_change_is_on_disk() {
    let root = directory("answered");
    let state = root.join("state");
    let file = state.join("auth-state.json");
    let runtime = persisting(&file);
    let (status, body) = sign_up(&runtime, "ada@example.test").await;
    assert_eq!(status, 200, "{body}");
    let uid = body["localId"].as_str().expect("localId").to_owned();
    // No flush and no wait: the answer came after the write.
    assert!(
        on_disk(&file)["projects"][PROJECT]["users"]
            .get(&uid)
            .is_some(),
        "the account is on disk when the sign-up answers"
    );

    // The state's directory becomes a file: every write fails from here on.
    std::fs::remove_dir_all(&state).expect("remove the state directory");
    std::fs::write(&state, "not a directory").expect("block the state path");
    let (status, body) = sign_up(&runtime, "grace@example.test").await;
    assert_eq!(status, 500, "{body}");
    assert!(body.to_string().contains("Auth state"), "{body}");
    let (status, body) = crate::tests::call(
        &runtime,
        axum::http::Method::POST,
        &format!("{CLIENT}/accounts:signInWithPassword?key=fake"),
        &json!({ "email": "ada@example.test", "password": "password1" }),
    )
    .await;
    assert_eq!(status, 200, "{body}");

    std::fs::remove_file(&state).expect("unblock the state path");
    runtime.flush().expect("flush");
    assert_eq!(on_disk(&file), in_memory(&runtime));
    drop(runtime);
    let _ = std::fs::remove_dir_all(&root);
}

/// Earlier engines wrote the current layout with `version: 0` when they
/// started without a state file, and loading it read only users and
/// configuration: tenants, codes and proofs were lost on restart.
#[test]
fn a_current_layout_written_as_version_zero_loads_whole() {
    let root = directory("version-zero");
    let file = root.join("auth-state.json");
    let tenant = json!({
        "users": { "t1": { "localId": "t1", "email": "t1@acme.test" } },
        "oobs": {}, "verificationCodes": {}, "temporaryProofs": {},
        "config": { "tenantId": "acme", "allowPasswordSignup": true }
    });
    let written = json!({
        "version": 0,
        "projects": { PROJECT: {
            "users": { "u1": { "localId": "u1", "email": "u1@example.test" } },
            "oobs": { "code": {
                "email": "u1@example.test", "requestType": "PASSWORD_RESET",
                "oobCode": "code", "oobLink": "http://127.0.0.1:9099/emulator/action?oobCode=code"
            } },
            "verificationCodes": {}, "temporaryProofs": {},
            "config": { "signIn": { "allowDuplicateEmails": false } },
            "tenants": { "acme": tenant }
        } }
    });
    std::fs::create_dir_all(&root).expect("directory");
    std::fs::write(&file, written.to_string()).expect("written");
    let runtime = persisting(&file);
    let handle = runtime.runtime();
    let data = lock(&handle.inner.data);
    let agent = &data.projects[PROJECT];
    assert_eq!(agent.project.users.len(), 1);
    assert_eq!(agent.project.oobs.len(), 1, "codes survive");
    assert_eq!(
        agent.tenants["acme"].project.users.len(),
        1,
        "tenants survive"
    );
    assert_eq!(data.version, 2);
    drop(data);
    drop(handle);
    drop(runtime);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn the_checkpoint_writes_an_empty_state_and_a_runtime_without_a_file_writes_nothing() {
    let root = directory("checkpoint");
    let file = root.join("auth-state.json");
    let runtime = persisting(&file);
    runtime.checkpoint_native_state().expect("checkpoint");
    assert_eq!(on_disk(&file), json!({ "version": 2, "projects": {} }));
    drop(runtime);

    let memory = crate::tests::test_runtime();
    memory.flush().expect("nothing to flush");
    memory.checkpoint_native_state().expect("nothing to write");
    assert!(memory.runtime().persist_stats().is_none());
    let _ = std::fs::remove_dir_all(&root);
}
