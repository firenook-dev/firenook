//! Importing users (test 14) and the import smoke ceiling.

use std::cell::{Cell, RefCell};
use std::io::Read;
use std::ops::ControlFlow;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use axum::http::Method;
use firenook_functions_bridge::{TriggerObserver, TriggerRegistry};
use serde_json::{Value as JsonValue, json};

use super::*;
use crate::console::bulk::BulkProgress;
use crate::console::export::{EXPORT_CHUNK, ExportFormat, ExportSelection};
use crate::state::UserRecord;
use crate::tests::call;
use crate::{AuthRuntime, lock};

const PROJECT: &str = "demo-auth";

fn directory(name: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "firenook-auth-import-{name}-{}-{}",
        std::process::id(),
        crate::util::now_millis()
    ));
    std::fs::create_dir_all(&root).expect("directory");
    root
}

fn write(root: &std::path::Path, name: &str, value: &JsonValue) -> PathBuf {
    let path = root.join(name);
    std::fs::write(&path, value.to_string()).expect("written");
    path
}

type Dispatches = tokio::sync::mpsc::UnboundedReceiver<firenook_functions_bridge::DispatchRequest>;

fn runtime() -> (AuthRuntime, Dispatches) {
    let registry = TriggerRegistry::default();
    let (observer, dispatches) = TriggerObserver::channel(registry.clone());
    (
        AuthRuntime::new(PROJECT, observer.queue(), registry, None).expect("runtime"),
        dispatches,
    )
}

#[derive(Default)]
struct Report {
    total: Cell<u64>,
    progress: RefCell<Vec<u64>>,
    skipped: Cell<u64>,
    failed: RefCell<Vec<(String, String)>>,
}

impl BulkProgress for Report {
    fn total(&self, total: u64) {
        self.total.set(total);
    }

    fn progress(&self, done: u64) {
        self.progress.borrow_mut().push(done);
    }

    fn skipped(&self, by: u64) {
        self.skipped.set(self.skipped.get() + by);
    }

    fn failed(&self, key: &str, message: &str) {
        self.failed
            .borrow_mut()
            .push((key.to_owned(), message.to_owned()));
    }

    fn cancelled(&self) -> bool {
        false
    }
}

const SKIP: ImportOptions = ImportOptions {
    mode: ImportMode::Skip,
    replace_password: None,
};

/// Reads at most `step` bytes per call and counts the calls, so a test can
/// see how far the reader had got when a user was visited.
struct Trickle {
    bytes: Vec<u8>,
    position: usize,
    step: usize,
    read: std::rc::Rc<Cell<usize>>,
}

impl Read for Trickle {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        let end = (self.position + self.step.min(buffer.len())).min(self.bytes.len());
        let count = end - self.position;
        buffer[..count].copy_from_slice(&self.bytes[self.position..end]);
        self.position = end;
        self.read.set(self.position);
        Ok(count)
    }
}

// ---------------------------------------------------------------- 14

#[test]
fn the_reader_hands_users_over_one_at_a_time_in_every_format() {
    let users: Vec<JsonValue> = (0..200)
        .map(|index| json!({ "localId": format!("u{index}"), "email": format!("u{index}@example.test") }))
        .collect();
    let file = json!({ "kind": "identitytoolkit#DownloadAccountResponse", "users": users });
    let bytes = file.to_string().into_bytes();
    let length = bytes.len();
    let read = std::rc::Rc::new(Cell::new(0));
    let mut first_at = None;
    let shape = read_users(
        Trickle {
            bytes,
            position: 0,
            step: 512,
            read: read.clone(),
        },
        &mut |index, user| {
            assert!(user.is_ok());
            if index == 0 {
                first_at = Some(read.get());
            }
            ControlFlow::Continue(())
        },
    )
    .expect("read");
    assert_eq!(
        shape,
        ImportShape {
            format: ImportFormat::Emulator,
            users: 200
        }
    );
    assert!(
        first_at.is_some_and(|at| at < length / 2),
        "the first user was visited after {first_at:?} of {length} bytes"
    );

    // A CLI export: no kind, lastSignedInAt.
    let mut seen = Vec::new();
    let shape = read_users(
        json!({ "users": [{ "localId": "c1", "lastSignedInAt": "1700000000000" }] })
            .to_string()
            .as_bytes(),
        &mut |_, user| {
            seen.push(user.expect("a user"));
            ControlFlow::Continue(())
        },
    )
    .expect("read");
    assert_eq!(shape.format, ImportFormat::Cli);
    assert_eq!(seen[0]["lastLoginAt"], "1700000000000");
    assert!(seen[0].get("lastSignedInAt").is_none());

    // A plain array, with an element that is not a user.
    let mut elements = Vec::new();
    let shape = read_users(br#"[{"localId":"a1"}, 3]"#.as_slice(), &mut |_, element| {
        elements.push(element.is_ok());
        ControlFlow::Continue(())
    })
    .expect("read");
    assert_eq!(shape.format, ImportFormat::Array);
    assert_eq!(elements, [true, false]);

    // No users array, or not JSON.
    assert!(
        read_users(br#"{"kind":"x"}"#.as_slice(), &mut |_, _| {
            ControlFlow::Continue(())
        })
        .expect_err("no users")
        .0
        .contains("no `users` array")
    );
    assert!(
        read_users(b"{oops".as_slice(), &mut |_, _| ControlFlow::Continue(()))
            .expect_err("not JSON")
            .0
            .contains("not valid JSON")
    );
}

#[tokio::test]
async fn the_preview_counts_finds_existing_users_and_problems_and_imports_nothing() {
    let (runtime, _dispatches) = runtime();
    let handle = runtime.runtime();
    let (status, body) = call(
        &runtime,
        Method::POST,
        "/identitytoolkit.googleapis.com/v1/projects/demo-auth/accounts",
        &json!({ "localId": "exists", "email": "taken@example.test" }),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let root = directory("preview");
    let path = write(
        &root,
        "users.json",
        &json!({ "users": [
            { "localId": "p1", "email": "p1@example.test", "passwordHash": "fakeHash:salt=s:password=x", "salt": "s" },
            { "localId": "p2", "email": "p2@example.test", "passwordHash": "bXlIYXNo", "salt": "c2FsdA==",
              "customAttributes": "{\"role\":\"admin\"}" },
            { "localId": "g1", "providerUserInfo": [{ "providerId": "google.com", "rawId": "g1" }] },
            { "localId": "ph1", "phoneNumber": "+15550100" },
            { "localId": "exists" },
            { "localId": "dupe", "email": "taken@example.test" },
            { "localId": "p1" },
            { "email": "nouid@example.test" },
            { "localId": "bad", "customAttributes": "{\"iss\":1}" },
            { "localId": "badphone", "phoneNumber": "555" }
        ] }),
    );
    let preview = handle
        .import_preview(PROJECT, None, &path, &SKIP)
        .expect("preview");
    assert_eq!(preview.format, ImportFormat::Cli);
    assert_eq!(preview.total, 10);
    assert_eq!(preview.with_password, 2);
    assert_eq!(preview.opaque_hashes, 1, "a production hash");
    assert_eq!(preview.with_claims, 2);
    assert_eq!(
        preview
            .by_provider
            .iter()
            .map(|count| (count.provider.as_str(), count.users))
            .collect::<Vec<_>>(),
        [("password", 2), ("phone", 2), ("google.com", 1)]
    );
    assert_eq!(preview.existing, ["exists"]);
    assert_eq!(preview.existing_count, 1);
    let problems: Vec<(u64, Option<&str>, &str)> = preview
        .problems
        .iter()
        .map(|problem| {
            (
                problem.index,
                problem.uid.as_deref(),
                problem.message.as_str(),
            )
        })
        .collect();
    assert_eq!(
        problems,
        [
            (
                5,
                Some("dupe"),
                "((Auth Emulator does not support importing duplicate email: taken@example.test))"
            ),
            (6, Some("p1"), "Another user in the file has the uid `p1`."),
            (7, None, "localId is missing"),
            (8, Some("bad"), "FORBIDDEN_CLAIM : iss"),
            (9, Some("badphone"), "phone number format is invalid"),
        ]
    );
    assert_eq!(preview.problem_count, 5);
    assert_eq!(runtime.user_count(), 1, "nothing imported");

    // An unknown tenant is not found and not created.
    assert_eq!(
        handle
            .import_preview(PROJECT, Some("nowhere"), &path, &SKIP)
            .expect_err("unknown tenant")
            .kind,
        ConsoleErrorKind::NotFound
    );
    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn a_commit_imports_in_chunks_without_triggers_and_skip_or_overwrite_existing() {
    let (runtime, mut dispatches) = runtime();
    let handle = runtime.runtime();
    let (status, _) = call(
        &runtime,
        Method::POST,
        "/identitytoolkit.googleapis.com/v1/projects/demo-auth/accounts",
        &json!({ "localId": "u00003", "displayName": "Kept" }),
    )
    .await;
    assert_eq!(status, 200);
    while dispatches.try_recv().is_ok() {}
    let root = directory("commit");
    let users: Vec<JsonValue> = (0..4_500)
        .map(|index| {
            json!({
                "localId": format!("u{index:05}"),
                "email": format!("user{index}@example.test"),
                "displayName": format!("User {index}"),
                "passwordHash": "bXlIYXNo",
                "salt": "c2FsdA=="
            })
        })
        .collect();
    let path = write(&root, "users.json", &json!(users));
    let report = Report::default();
    let outcome = handle
        .import_commit(PROJECT, None, &path, &SKIP, &report)
        .expect("imported");
    assert_eq!(
        (outcome.imported, outcome.skipped, outcome.failed),
        (4_499, 1, 0)
    );
    assert_eq!(
        *report.progress.borrow(),
        [2_000, 4_000, 4_500],
        "one report per chunk"
    );
    assert_eq!(report.total.get(), 4_500);
    assert_eq!(report.skipped.get(), 1);
    assert!(dispatches.try_recv().is_err(), "no lifecycle event");
    let kept = handle.user(PROJECT, None, "u00003").expect("kept");
    assert_eq!(kept.row.display_name.as_deref(), Some("Kept"));

    // Overwrite replaces it; a new password makes password sign-in work.
    let one = write(
        &root,
        "one.json",
        &json!([{ "localId": "u00003", "email": "user3@example.test", "displayName": "User 3",
                   "passwordHash": "bXlIYXNo", "salt": "c2FsdA==" }]),
    );
    let overwrite = ImportOptions {
        mode: ImportMode::Overwrite,
        replace_password: Some("secret-42".to_owned()),
    };
    let outcome = handle
        .import_commit(PROJECT, None, &one, &overwrite, &Report::default())
        .expect("overwritten");
    assert_eq!(outcome.imported, 1);
    assert_eq!(
        handle
            .user(PROJECT, None, "u00003")
            .expect("replaced")
            .row
            .display_name
            .as_deref(),
        Some("User 3")
    );
    let (status, body) = call(
        &runtime,
        Method::POST,
        "/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake",
        &json!({ "email": "user3@example.test", "password": "secret-42" }),
    )
    .await;
    assert_eq!(status, 200, "{body}");

    // A failing user is reported by its place and uid.
    let bad = write(
        &root,
        "bad.json",
        &json!([{ "localId": "v1", "phoneNumber": "555" }]),
    );
    let report = Report::default();
    let outcome = handle
        .import_commit(PROJECT, None, &bad, &SKIP, &report)
        .expect("ran");
    assert_eq!(outcome.failed, 1);
    assert_eq!(
        *report.failed.borrow(),
        [(
            "#0 v1".to_owned(),
            "phone number format is invalid".to_owned()
        )]
    );
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn export_delete_all_and_import_round_trips_every_record() {
    let (runtime, _dispatches) = runtime();
    let handle = runtime.runtime();
    handle
        .update(|data| {
            let state = &mut data.agent(PROJECT).project;
            for index in 0..300 {
                let mut user = json!({
                    "email": format!("r{index}@example.test"),
                    "displayName": format!("Round {index}"),
                    "passwordHash": format!("fakeHash:salt=s{index}:password=p{index}"),
                    "salt": format!("s{index}"),
                    "createdAt": (1_700_000_000_000_i64 + index).to_string(),
                    "lastLoginAt": (1_700_000_100_000_i64 + index).to_string(),
                    "emailVerified": index % 2 == 0,
                });
                if index % 5 == 0 {
                    user["customAttributes"] = json!(json!({ "n": index }).to_string());
                }
                if index % 7 == 0 {
                    user["phoneNumber"] = json!(format!("+1555{index:07}"));
                }
                state
                    .create_user_with_local_id(
                        &format!("r{index:04}"),
                        user.as_object().expect("object"),
                    )
                    .expect("create")
                    .expect("new");
            }
        })
        .expect("populated");
    let before: Vec<JsonValue> = {
        let data = lock(&handle.inner.data);
        data.projects[PROJECT]
            .project
            .users
            .values()
            .map(|user| JsonValue::Object(UserRecord::clone(user)))
            .collect()
    };
    let mut stream = handle
        .export(
            PROJECT,
            None,
            &ExportSelection::Filter(Box::default()),
            ExportFormat::Json,
        )
        .expect("export");
    let mut file = Vec::new();
    while let Some(chunk) = stream.next_chunk(EXPORT_CHUNK) {
        file.extend_from_slice(&chunk);
    }
    let root = directory("round-trip");
    let path = root.join("accounts.json");
    std::fs::write(&path, &file).expect("written");
    handle
        .update(|data| data.agent(PROJECT).project.delete_all_accounts())
        .expect("deleted");
    assert_eq!(runtime.user_count(), 0);
    handle
        .import_commit(PROJECT, None, &path, &SKIP, &Report::default())
        .expect("imported");
    let after: Vec<JsonValue> = {
        let data = lock(&handle.inner.data);
        data.projects[PROJECT]
            .project
            .users
            .values()
            .map(|user| JsonValue::Object(UserRecord::clone(user)))
            .collect()
    };
    assert_eq!(after.len(), 300);
    let strip = |records: &[JsonValue]| -> Vec<JsonValue> {
        records
            .iter()
            .map(|record| {
                let mut record = record.clone();
                // Import stamps when the password and the account were
                // imported, and writes `disabled` out (absent means false);
                // every other field round-trips.
                let object = record.as_object_mut().expect("object");
                for field in ["passwordUpdatedAt", "validSince"] {
                    object.remove(field);
                }
                object.entry("disabled").or_insert(json!(false));
                record
            })
            .collect()
    };
    assert_eq!(strip(&after), strip(&before));
    let _ = std::fs::remove_dir_all(&root);
}

// ---------------------------------------------------------------- 19

/// The CI ceiling of an import of 10,000 users (debug build): preview and
/// commit within 8 s.
#[test]
fn an_import_of_ten_thousand_users_stays_within_its_ceiling() {
    let (runtime, _dispatches) = runtime();
    let root = directory("smoke");
    let users: Vec<JsonValue> = (0..10_000)
        .map(|index| {
            json!({
                "localId": format!("s{index:05}"),
                "email": format!("smoke{index}@example.test"),
                "displayName": format!("Smoke {index}"),
                "passwordHash": format!("fakeHash:salt=s{index}:password=p{index}"),
                "salt": format!("s{index}"),
                "createdAt": "1700000000000"
            })
        })
        .collect();
    let path = write(&root, "users.json", &json!({ "users": users }));
    let started = Instant::now();
    let preview = runtime
        .runtime()
        .import_preview(PROJECT, None, &path, &SKIP)
        .expect("preview");
    assert_eq!(preview.problem_count, 0);
    runtime
        .runtime()
        .import_commit(PROJECT, None, &path, &SKIP, &Report::default())
        .expect("imported");
    let took = started.elapsed();
    assert_eq!(runtime.user_count(), 10_000);
    assert!(
        took <= Duration::from_secs(8),
        "preview and commit took {took:?}"
    );
    let _ = std::fs::remove_dir_all(&root);
}
