//! Bulk changes (test 13), clearing every user, and the bulk smoke ceiling.

use std::cell::{Cell, RefCell};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use firenook_functions_bridge::{TriggerObserver, TriggerRegistry};
use serde_json::{Value as JsonValue, json};

use super::*;
use crate::AuthRuntime;
use crate::console::UsersQuery;
use crate::console::filter::{Choice, IdMatch, UserState};
use crate::observe::{AuthObserver, CallRecord, Step};

const PROJECT: &str = "demo-auth";

type Dispatches = tokio::sync::mpsc::UnboundedReceiver<firenook_functions_bridge::DispatchRequest>;

fn runtime_with_dispatches() -> (AuthRuntime, Dispatches) {
    let registry = TriggerRegistry::default();
    let (observer, dispatches) = TriggerObserver::channel(registry.clone());
    (
        AuthRuntime::new(PROJECT, observer.queue(), registry, None).expect("runtime"),
        dispatches,
    )
}

/// `count` project users `u00000…` (and in `tenant` when given), half
/// disabled, every third with claims.
fn populate(runtime: &AuthRuntime, tenant: Option<&str>, count: usize) {
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
            for index in 0..count {
                let mut user = json!({
                    "email": format!("user{index}@example.test"),
                    "disabled": index % 2 == 1,
                    "emailVerified": index % 4 == 0,
                });
                if index % 3 == 0 {
                    user["customAttributes"] =
                        json!(json!({ "role": "editor", "n": index }).to_string());
                }
                state
                    .create_user_with_local_id(
                        &format!("u{index:05}"),
                        user.as_object().expect("object"),
                    )
                    .expect("create")
                    .expect("new");
            }
        })
        .expect("populated");
}

fn user(runtime: &AuthRuntime, tenant: Option<&str>, uid: &str) -> Option<UserRecord> {
    let handle = runtime.runtime();
    let data = lock(&handle.inner.data);
    let agent = data.projects.get(PROJECT)?;
    match tenant {
        None => agent.project.get_user_by_local_id(uid),
        Some(tenant) => agent.tenants.get(tenant)?.project.get_user_by_local_id(uid),
    }
}

fn claims(runtime: &AuthRuntime, uid: &str) -> JsonValue {
    user(runtime, None, uid)
        .and_then(|user| str_field(&user, "customAttributes").map(str::to_owned))
        .map_or(JsonValue::Null, |text| {
            serde_json::from_str(&text).expect("claims")
        })
}

/// Records what the work reports.
#[derive(Default)]
struct Report {
    total: Cell<u64>,
    progress: RefCell<Vec<u64>>,
    skipped: Cell<u64>,
    failed: RefCell<Vec<(String, String)>>,
    cancel_after: Cell<Option<usize>>,
    during: RefCell<Option<Box<dyn Fn()>>>,
}

impl BulkProgress for Report {
    fn total(&self, total: u64) {
        self.total.set(total);
    }

    fn progress(&self, done: u64) {
        self.progress.borrow_mut().push(done);
        if let Some(during) = self.during.borrow().as_ref() {
            during();
        }
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
        self.cancel_after
            .get()
            .is_some_and(|after| self.progress.borrow().len() >= after)
    }
}

fn keys(uids: &[&str]) -> BulkUsers {
    BulkUsers::Keys(uids.iter().map(|uid| (None, (*uid).to_owned())).collect())
}

#[derive(Default)]
struct Collect(Mutex<Vec<CallRecord>>);

impl AuthObserver for Collect {
    fn call(&self, record: CallRecord) {
        self.0.lock().expect("records").push(record);
    }
}

// ---------------------------------------------------------------- 13

#[test]
fn each_action_changes_the_named_users_and_passes_over_the_rest() {
    let (runtime, _dispatches) = runtime_with_dispatches();
    populate(&runtime, None, 8);
    let handle = runtime.runtime();

    // Disable: u00001 is disabled already.
    let report = Report::default();
    let outcome = handle
        .bulk_apply(
            PROJECT,
            &keys(&["u00000", "u00001", "u00002"]),
            &BulkAction::Disable,
            &report,
        )
        .expect("disabled");
    assert_eq!((outcome.changed, outcome.skipped), (2, 1));
    assert_eq!(report.skipped.get(), 1);
    assert_eq!(report.total.get(), 3);
    assert_eq!(*report.progress.borrow(), [3]);
    assert!(truthy(
        user(&runtime, None, "u00000")
            .expect("user")
            .get("disabled")
    ));

    // Enable.
    let outcome = handle
        .bulk_apply(
            PROJECT,
            &keys(&["u00000", "u00004"]),
            &BulkAction::Enable,
            &Report::default(),
        )
        .expect("enabled");
    assert_eq!((outcome.changed, outcome.skipped), (1, 1));

    // Verify: u00000 is verified already.
    let outcome = handle
        .bulk_apply(
            PROJECT,
            &keys(&["u00000", "u00002"]),
            &BulkAction::Verify,
            &Report::default(),
        )
        .expect("verified");
    assert_eq!((outcome.changed, outcome.skipped), (1, 1));
    assert!(truthy(
        user(&runtime, None, "u00002")
            .expect("user")
            .get("emailVerified")
    ));

    // Revoke sets validSince.
    let outcome = handle
        .bulk_apply(
            PROJECT,
            &keys(&["u00002"]),
            &BulkAction::Revoke,
            &Report::default(),
        )
        .expect("revoked");
    assert_eq!(outcome.changed, 1);
    assert!(
        user(&runtime, None, "u00002")
            .expect("user")
            .get("validSince")
            .is_some()
    );

    // Merge: keys replace, null removes, others stay.
    let merge = BulkAction::SetClaims {
        claims: json!({ "role": "admin", "n": null, "tier": 2 })
            .as_object()
            .cloned()
            .expect("object"),
        mode: ClaimsMode::Merge,
    };
    handle
        .bulk_apply(
            PROJECT,
            &keys(&["u00000", "u00001"]),
            &merge,
            &Report::default(),
        )
        .expect("merged");
    assert_eq!(
        claims(&runtime, "u00000"),
        json!({ "role": "admin", "tier": 2 })
    );
    assert_eq!(
        claims(&runtime, "u00001"),
        json!({ "role": "admin", "tier": 2 })
    );
    // Applying the same merge again changes nothing.
    let outcome = handle
        .bulk_apply(PROJECT, &keys(&["u00000"]), &merge, &Report::default())
        .expect("merged again");
    assert_eq!((outcome.changed, outcome.skipped), (0, 1));
    // Replace: exactly these.
    let replace = BulkAction::SetClaims {
        claims: json!({ "plan": "pro" })
            .as_object()
            .cloned()
            .expect("object"),
        mode: ClaimsMode::Replace,
    };
    handle
        .bulk_apply(PROJECT, &keys(&["u00000"]), &replace, &Report::default())
        .expect("replaced");
    assert_eq!(claims(&runtime, "u00000"), json!({ "plan": "pro" }));
    // Remove keys; removing the last removes the claims.
    handle
        .bulk_apply(
            PROJECT,
            &keys(&["u00000", "u00001"]),
            &BulkAction::RemoveClaims {
                keys: vec!["plan".to_owned(), "tier".to_owned()],
            },
            &Report::default(),
        )
        .expect("removed");
    assert_eq!(claims(&runtime, "u00000"), JsonValue::Null);
    assert_eq!(claims(&runtime, "u00001"), json!({ "role": "admin" }));

    // Claims over the limit fail per user while the rest change.
    let big = "é".repeat(990);
    let report = Report::default();
    let outcome = handle
        .bulk_apply(
            PROJECT,
            &keys(&["u00001", "u00002", "ghost"]),
            &BulkAction::SetClaims {
                claims: json!({ "big": big }).as_object().cloned().expect("object"),
                mode: ClaimsMode::Merge,
            },
            &report,
        )
        .expect("partly applied");
    assert_eq!(outcome.failed, 2);
    assert_eq!(outcome.changed, 1, "u00002 had no claims: its object fits");
    assert_eq!(
        *report.failed.borrow(),
        [
            ("|u00001".to_owned(), "CLAIMS_TOO_LARGE".to_owned()),
            ("|ghost".to_owned(), "USER_NOT_FOUND".to_owned()),
        ]
    );
}

#[test]
fn a_query_target_takes_the_matching_users_of_its_scope() {
    let (runtime, _dispatches) = runtime_with_dispatches();
    populate(&runtime, None, 10);
    populate(&runtime, Some("acme"), 6);
    let handle = runtime.runtime();
    let disabled = UserFilter {
        is: Choice {
            any_of: vec![UserState::Disabled],
            none_of: Vec::new(),
        },
        ..UserFilter::default()
    };
    let target = BulkUsers::Query {
        tenant: Some("acme".to_owned()),
        filter: Box::new(disabled.clone()),
    };
    let preview = handle
        .bulk_preview(PROJECT, &target, &BulkAction::Enable)
        .expect("preview");
    assert_eq!(
        (
            preview.matched,
            preview.changed,
            preview.unchanged,
            preview.triggers
        ),
        (3, 3, 0, 0)
    );
    // A dry run changes nothing.
    assert!(truthy(
        user(&runtime, Some("acme"), "u00001")
            .expect("user")
            .get("disabled")
    ));
    let outcome = handle
        .bulk_apply(PROJECT, &target, &BulkAction::Enable, &Report::default())
        .expect("enabled");
    assert_eq!(outcome.changed, 3);
    assert!(!truthy(
        user(&runtime, Some("acme"), "u00001")
            .expect("user")
            .get("disabled")
    ));
    assert!(
        truthy(
            user(&runtime, None, "u00001")
                .expect("user")
                .get("disabled")
        ),
        "the project's users are another scope"
    );
    let uids = BulkUsers::Query {
        tenant: None,
        filter: Box::new(UserFilter {
            uid: Choice {
                any_of: vec![IdMatch::parse("u0000*")],
                none_of: Vec::new(),
            },
            ..UserFilter::default()
        }),
    };
    assert_eq!(handle.bulk_count(PROJECT, &uids).expect("count"), 10);
    let unknown = handle
        .bulk_preview(
            PROJECT,
            &BulkUsers::Query {
                tenant: Some("nowhere".to_owned()),
                filter: Box::default(),
            },
            &BulkAction::Disable,
        )
        .expect_err("unknown tenant");
    assert_eq!(unknown.kind, ConsoleErrorKind::NotFound);
}

#[test]
fn deletes_queue_one_trigger_each_or_none_and_refuse_over_the_limit() {
    let (runtime, mut dispatches) = runtime_with_dispatches();
    populate(&runtime, None, 6);
    let handle = runtime.runtime();
    let preview = handle
        .bulk_preview(
            PROJECT,
            &keys(&["u00000", "u00001"]),
            &BulkAction::Delete { triggers: true },
        )
        .expect("preview");
    assert_eq!((preview.changed, preview.triggers), (2, 2));
    handle
        .bulk_apply(
            PROJECT,
            &keys(&["u00000", "u00001"]),
            &BulkAction::Delete { triggers: true },
            &Report::default(),
        )
        .expect("deleted");
    let mut queued = 0;
    while let Ok(dispatch) = dispatches.try_recv() {
        if String::from_utf8_lossy(&dispatch.body).contains("user.delete") {
            queued += 1;
        }
    }
    assert_eq!(queued, 2);
    assert!(user(&runtime, None, "u00000").is_none());
    handle
        .bulk_apply(
            PROJECT,
            &keys(&["u00002", "u00003"]),
            &BulkAction::Delete { triggers: false },
            &Report::default(),
        )
        .expect("deleted quietly");
    assert!(
        dispatches.try_recv().is_err(),
        "nothing queued without triggers"
    );
    assert!(user(&runtime, None, "u00002").is_none());

    // Over the limit: refused before any change.
    let many: Vec<(Option<String>, String)> = (0..=MAX_TRIGGERED_DELETES)
        .map(|index| (None, format!("x{index}")))
        .collect();
    let refused = handle
        .bulk_apply(
            PROJECT,
            &BulkUsers::Keys(many),
            &BulkAction::Delete { triggers: true },
            &Report::default(),
        )
        .expect_err("over the limit");
    assert_eq!(refused.kind, ConsoleErrorKind::FailedPrecondition);
    assert!(user(&runtime, None, "u00004").is_some());
}

#[test]
fn chunks_release_the_lock_report_progress_and_stop_when_cancelled() {
    let (runtime, _dispatches) = runtime_with_dispatches();
    populate(&runtime, None, 5_000);
    let handle = runtime.runtime();
    let records = Arc::new(Collect::default());
    runtime.set_observer(records.clone(), false);

    // Between chunks another change goes through: the lock is free.
    let report = Report::default();
    let signed_up = Arc::new(Mutex::new(0_u32));
    let during = {
        let handle = handle.clone();
        let signed_up = signed_up.clone();
        move || {
            let mut count = signed_up.lock().expect("count");
            *count += 1;
            let uid = format!("between-{count}");
            handle
                .update(|data| {
                    data.agent(PROJECT)
                        .project
                        .create_user_with_local_id(&uid, &UserRecord::new())
                        .expect("create");
                })
                .expect("a change between chunks");
        }
    };
    *report.during.borrow_mut() = Some(Box::new(during));
    let everyone = BulkUsers::Query {
        tenant: None,
        filter: Box::new(UserFilter {
            uid: Choice {
                any_of: vec![IdMatch::parse("u*")],
                none_of: Vec::new(),
            },
            ..UserFilter::default()
        }),
    };
    let outcome = handle
        .bulk_apply(PROJECT, &everyone, &BulkAction::Revoke, &report)
        .expect("revoked");
    assert_eq!(
        *report.progress.borrow(),
        [2_000, 4_000, 5_000],
        "one report per chunk"
    );
    assert_eq!(
        *signed_up.lock().expect("count"),
        3,
        "a change got in after each chunk"
    );
    assert_eq!(outcome.changed, 5_000);
    // One Activity record for the whole action, with every user's key.
    let recorded = records.0.lock().expect("records").clone();
    assert_eq!(recorded.len(), 1);
    assert_eq!(recorded[0].operation, "firenook.console.users.revoke");
    assert_eq!(recorded[0].identifier.as_deref(), Some("5,000 users"));
    assert_eq!(
        recorded[0]
            .steps
            .iter()
            .filter(|step| matches!(step, Step::User { .. }))
            .count(),
        5_000
    );

    // Cancelled after the first chunk: the first 2,000 are changed.
    let report = Report::default();
    report.cancel_after.set(Some(1));
    let outcome = handle
        .bulk_apply(PROJECT, &everyone, &BulkAction::Disable, &report)
        .expect("stopped");
    assert!(outcome.cancelled);
    assert_eq!(*report.progress.borrow(), [2_000]);
    let disabled_now = handle
        .users(PROJECT, None)
        .expect("view")
        .page(&UsersQuery {
            filter: UserFilter {
                is: Choice {
                    any_of: vec![UserState::Disabled],
                    none_of: Vec::new(),
                },
                ..UserFilter::default()
            },
            ..UsersQuery::default()
        })
        .expect("page")
        .total;
    // 2,500 were disabled to begin with; the chunk changed 1,000 more.
    assert_eq!(disabled_now, Some(3_500));
}

#[test]
fn a_bulk_action_is_persisted_in_at_most_two_writes() {
    let root = std::env::temp_dir().join(format!(
        "firenook-auth-bulk-{}-{}",
        std::process::id(),
        crate::util::now_millis()
    ));
    let registry = TriggerRegistry::default();
    let (observer, _dispatches) = TriggerObserver::channel(registry.clone());
    let runtime = AuthRuntime::new(
        PROJECT,
        observer.queue(),
        registry,
        Some(root.join("auth-state.json")),
    )
    .expect("runtime");
    populate(&runtime, None, 3_000);
    runtime.flush().expect("flush");
    let before = runtime.runtime().persist_stats().expect("persists").encodes;
    runtime
        .runtime()
        .bulk_apply(
            PROJECT,
            &BulkUsers::Query {
                tenant: None,
                filter: Box::default(),
            },
            &BulkAction::Verify,
            &Report::default(),
        )
        .expect("verified");
    runtime.flush().expect("flush");
    let writes = runtime.runtime().persist_stats().expect("persists").encodes - before;
    assert!((1..=2).contains(&writes), "{writes} writes");
    drop(runtime);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn clearing_removes_every_user_of_every_tenant_without_triggers() {
    let (runtime, mut dispatches) = runtime_with_dispatches();
    populate(&runtime, None, 2_500);
    populate(&runtime, Some("acme"), 10);
    while dispatches.try_recv().is_ok() {}
    let records = Arc::new(Collect::default());
    runtime.set_observer(records.clone(), false);
    let report = Report::default();
    let removed = runtime
        .runtime()
        .clear_users(PROJECT, &report)
        .expect("cleared");
    assert_eq!(removed, 2_510);
    assert_eq!(report.total.get(), 2_510);
    assert_eq!(*report.progress.borrow(), [2_000, 2_500, 2_510]);
    assert!(dispatches.try_recv().is_err(), "no user.delete");
    let counts = runtime.runtime().summary_counts(PROJECT);
    assert_eq!(
        (counts.users, counts.tenants, counts.tenant_users),
        (0, 1, 0)
    );
    let recorded = records.0.lock().expect("records").clone();
    assert_eq!(recorded.len(), 1);
    assert_eq!(
        recorded[0]
            .steps
            .iter()
            .filter(|step| matches!(step, Step::UsersCleared { .. }))
            .count(),
        2,
        "one cleared step per scope, no step per user"
    );
}

// ---------------------------------------------------------------- 19

/// The CI ceiling of a bulk action at 10,000 users (debug build): the
/// whole action within 5 s, no chunk holding the lock over 300 ms.
#[test]
fn a_bulk_action_over_ten_thousand_users_stays_within_its_ceilings() {
    let (runtime, _dispatches) = runtime_with_dispatches();
    populate(&runtime, None, 10_000);
    let handle = runtime.runtime();
    let longest = Arc::new(Mutex::new(Duration::ZERO));
    let last = Arc::new(Mutex::new(Instant::now()));
    let report = Report::default();
    {
        let longest = longest.clone();
        let last = last.clone();
        *report.during.borrow_mut() = Some(Box::new(move || {
            let mut last = last.lock().expect("last");
            let chunk = last.elapsed();
            let mut longest = longest.lock().expect("longest");
            *longest = (*longest).max(chunk);
            *last = Instant::now();
        }));
    }
    let started = Instant::now();
    *last.lock().expect("last") = Instant::now();
    handle
        .bulk_apply(
            PROJECT,
            &BulkUsers::Query {
                tenant: None,
                filter: Box::default(),
            },
            &BulkAction::Revoke,
            &report,
        )
        .expect("revoked");
    let took = started.elapsed();
    let chunk = *longest.lock().expect("longest");
    assert!(took <= Duration::from_secs(5), "the action took {took:?}");
    assert!(
        chunk <= Duration::from_millis(300),
        "a chunk took {chunk:?}"
    );
}

/// `cargo test -p firenook-auth-front --release -- --ignored --nocapture
/// bulk_import_export_bench`: a bulk disable, an import (preview and
/// commit) and an export of 100,000 users, printed (figures for a product
/// claim come from the private acceptance host only).
#[test]
#[ignore = "a benchmark, run by hand in release"]
fn bulk_import_export_bench_at_a_hundred_thousand_users() {
    use crate::console::export::{EXPORT_CHUNK, ExportFormat, ExportSelection};
    use crate::console::import::{ImportMode, ImportOptions};
    let (runtime, _dispatches) = runtime_with_dispatches();
    populate(&runtime, None, 100_000);
    let handle = runtime.runtime();
    let longest = Arc::new(Mutex::new(Duration::ZERO));
    let last = Arc::new(Mutex::new(Instant::now()));
    let report = Report::default();
    {
        let longest = longest.clone();
        let last = last.clone();
        *report.during.borrow_mut() = Some(Box::new(move || {
            let mut last = last.lock().expect("last");
            let mut longest = longest.lock().expect("longest");
            *longest = (*longest).max(last.elapsed());
            *last = Instant::now();
        }));
    }
    let started = Instant::now();
    *last.lock().expect("last") = Instant::now();
    handle
        .bulk_apply(
            PROJECT,
            &BulkUsers::Query {
                tenant: None,
                filter: Box::default(),
            },
            &BulkAction::Revoke,
            &report,
        )
        .expect("revoked");
    let bulk = started.elapsed();
    let chunk = *longest.lock().expect("longest");

    // The lock is held for the snapshot only: an export of no users is that.
    let hold = (0..9)
        .map(|_| {
            let started = Instant::now();
            drop(
                handle
                    .export(
                        PROJECT,
                        None,
                        &ExportSelection::Uids(Vec::new()),
                        ExportFormat::Json,
                    )
                    .expect("export"),
            );
            started.elapsed()
        })
        .min()
        .unwrap_or_default();
    let started = Instant::now();
    let mut stream = handle
        .export(
            PROJECT,
            None,
            &ExportSelection::Filter(Box::default()),
            ExportFormat::Json,
        )
        .expect("export");
    let mut file = Vec::new();
    while let Some(part) = stream.next_chunk(EXPORT_CHUNK) {
        file.extend_from_slice(&part);
    }
    let export = started.elapsed();
    let root = std::env::temp_dir().join(format!(
        "firenook-auth-bench-import-{}-{}",
        std::process::id(),
        crate::util::now_millis()
    ));
    std::fs::create_dir_all(&root).expect("directory");
    let path = root.join("accounts.json");
    std::fs::write(&path, &file).expect("written");
    let (fresh, _fresh_dispatches) = runtime_with_dispatches();
    let options = ImportOptions {
        mode: ImportMode::Skip,
        replace_password: None,
    };
    let started = Instant::now();
    fresh
        .runtime()
        .import_preview(PROJECT, None, &path, &options)
        .expect("preview");
    let preview = started.elapsed();
    fresh
        .runtime()
        .import_commit(PROJECT, None, &path, &options, &Report::default())
        .expect("imported");
    let import = started.elapsed();
    println!(
        "100,000 users: bulk revoke {bulk:?} (longest chunk {chunk:?}); export {} MB in {export:?} \
         (lock hold {hold:?}); import preview {preview:?}, preview and commit {import:?}",
        file.len() / 1_000_000
    );
    let _ = std::fs::remove_dir_all(&root);
}
