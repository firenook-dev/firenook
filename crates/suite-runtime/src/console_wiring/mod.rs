//! One file per console stream that builds that stream's part of the
//! console from the running suite, and the lifecycle hooks `run()` calls.
//!
//! The call sites are written once, in `run()`, `prepare`/`finish` and the
//! inventory follower, so no stream edits them: a stream fills in the
//! bodies in its own file (`auth.rs`, `storage.rs`, `compute.rs`,
//! `messaging.rs`, `observe.rs`). A stream that needs something
//! [`HookContext`] does not carry asks the foundation for it instead of
//! editing `run()`.
//!
//! The hooks, each called once at its site:
//!
//! - `prepared`: the suite's services are prepared, before the console;
//! - `functions_options`: just before the Functions runtime starts;
//! - `ready`: the stream's services are up (compute's `ready` runs right
//!   after Functions start and hands the runtime to the console; the
//!   others once every service has started);
//! - `before_finish`: from `finish_suite`, in a fixed order — Storage,
//!   Pub/Sub, Auth, compute, observe — before background delivery drains;
//! - `inventory_refreshed`: after each Functions reload.

pub(crate) mod auth;
pub(crate) mod compute;
pub(crate) mod messaging;
pub(crate) mod observe;
pub(crate) mod storage;

use std::collections::BTreeMap;
use std::sync::Arc;

use firenook_auth_front::AuthRuntime;
use firenook_console_front::{
    AbsentKind, AbsentReason, ComputeParts, SectionFix, SectionFixKind, UnsupportedService,
};
use firenook_functions_bridge::{FunctionsInventory, TriggerRegistry};
use firenook_functions_runtime::FunctionsRuntime;
use firenook_pubsub_front::PubsubRuntime;
use firenook_storage_front::StorageRuntime;
use firenook_suite_front::LoggingRuntime;
use firenook_tasks_front::TasksRuntime;

use crate::SuiteConfig;
use crate::launch::{LaunchContext, LaunchReason};

/// What a lifecycle hook can read at its call site; the `Option`s fill in
/// as the suite starts.
#[derive(Clone, Copy)]
#[allow(
    dead_code,
    reason = "the section streams' hooks read what they need of it"
)]
pub(crate) struct HookContext<'a> {
    pub(crate) config: &'a SuiteConfig,
    pub(crate) logging: &'a LoggingRuntime,
    pub(crate) triggers: &'a TriggerRegistry,
    pub(crate) compute: Option<&'a ComputeParts>,
    pub(crate) auth: Option<&'a Arc<AuthRuntime>>,
    pub(crate) storage: Option<&'a Arc<StorageRuntime>>,
    pub(crate) functions: Option<&'a FunctionsRuntime>,
    pub(crate) inventory: Option<&'a FunctionsInventory>,
    pub(crate) pubsub: Option<&'a PubsubRuntime>,
    pub(crate) tasks: Option<&'a TasksRuntime>,
}

impl<'a> HookContext<'a> {
    /// The context before any optional service is known.
    pub(crate) const fn new(
        config: &'a SuiteConfig,
        logging: &'a LoggingRuntime,
        triggers: &'a TriggerRegistry,
    ) -> Self {
        Self {
            config,
            logging,
            triggers,
            compute: None,
            auth: None,
            storage: None,
            functions: None,
            inventory: None,
            pubsub: None,
            tasks: None,
        }
    }
}

/// Options the Functions runtime takes from the console (the compute stream
/// adds its `Monitor`).
#[derive(Default)]
pub(crate) struct FunctionsConsoleOptions {}

/// The services are prepared; the console is not built yet.
pub(crate) fn prepared(context: &HookContext<'_>) {
    record("auth.prepared");
    auth::prepared(context);
    record("storage.prepared");
    storage::prepared(context);
    record("compute.prepared");
    compute::prepared(context);
    record("messaging.prepared");
    messaging::prepared(context);
    record("observe.prepared");
    observe::prepared(context);
}

/// The Functions runtime is about to start with `options`.
pub(crate) fn functions_options(context: &HookContext<'_>, options: &mut FunctionsConsoleOptions) {
    record("auth.functions_options");
    auth::functions_options(context, options);
    record("storage.functions_options");
    storage::functions_options(context, options);
    record("compute.functions_options");
    compute::functions_options(context, options);
    record("messaging.functions_options");
    messaging::functions_options(context, options);
    record("observe.functions_options");
    observe::functions_options(context, options);
}

/// Every service has started (compute's own `ready` ran when Functions
/// did).
pub(crate) fn ready(context: &HookContext<'_>) {
    record("auth.ready");
    auth::ready(context);
    record("storage.ready");
    storage::ready(context);
    record("messaging.ready");
    messaging::ready(context);
    record("observe.ready");
    observe::ready(context);
}

/// The suite is stopping: each stream's last work, in the fixed order, before
/// background delivery drains.
pub(crate) async fn before_finish(context: &HookContext<'_>) {
    record("storage.before_finish");
    storage::before_finish(context).await;
    record("messaging.before_finish");
    messaging::before_finish(context).await;
    record("auth.before_finish");
    auth::before_finish(context).await;
    record("compute.before_finish");
    compute::before_finish(context).await;
    record("observe.before_finish");
    observe::before_finish(context).await;
}

/// Functions reloaded and routing was refreshed for `inventory`.
pub(crate) fn inventory_refreshed(context: &HookContext<'_>, inventory: &FunctionsInventory) {
    record("auth.inventory_refreshed");
    auth::inventory_refreshed(context, inventory);
    record("storage.inventory_refreshed");
    storage::inventory_refreshed(context, inventory);
    record("compute.inventory_refreshed");
    compute::inventory_refreshed(context, inventory);
    record("messaging.inventory_refreshed");
    messaging::inventory_refreshed(context, inventory);
    record("observe.inventory_refreshed");
    observe::inventory_refreshed(context, inventory);
}

#[cfg(test)]
thread_local! {
    /// The hooks called on this thread, in order, for the order test.
    static CALLS: std::cell::RefCell<Vec<&'static str>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// Notes a hook call, for the order test.
#[cfg(test)]
fn record(hook: &'static str) {
    CALLS.with(|calls| calls.borrow_mut().push(hook));
}

/// Hook calls are noted in tests only.
#[cfg(not(test))]
const fn record(_hook: &'static str) {}

/// The hooks called on this thread since the last call, in order.
#[cfg(test)]
pub(crate) fn recorded() -> Vec<&'static str> {
    CALLS.with(|calls| std::mem::take(&mut *calls.borrow_mut()))
}

/// The five data services as `--only` and the launch context name them,
/// with the console section each one is.
const DATA_SERVICES: [&str; 5] = ["firestore", "auth", "storage", "functions", "pubsub"];

/// Sections that run with Functions, and what each says when it cannot.
const FOLLOWERS: [(&str, &str); 3] = [
    (
        "extensions",
        "Extensions run on the Functions emulator, which this engine does not run.",
    ),
    (
        "eventarc",
        "Eventarc runs with Functions, which this engine does not run.",
    ),
    (
        "tasks",
        "Cloud Tasks runs with Functions, which this engine does not run.",
    ),
];

fn selected(config: &SuiteConfig, service: &str) -> bool {
    let services = config.services;
    match service {
        "firestore" => services.firestore,
        "auth" => services.auth,
        "storage" => services.storage,
        "functions" => services.functions,
        "pubsub" => services.pubsub,
        _ => true,
    }
}

/// The label a fix uses for `service`.
fn label(service: &str) -> &'static str {
    match service {
        "firestore" => "Firestore",
        "auth" => "Authentication",
        "storage" => "Storage",
        "functions" => "Functions",
        _ => "Pub/Sub",
    }
}

/// Why `service` is not configured, and what to add to firebase.json.
fn not_configured(service: &str) -> AbsentReason {
    let (detail, snippet) = match service {
        "firestore" => (
            "firebase.json does not configure Firestore.",
            "\"emulators\": { \"firestore\": {} },\n\"firestore\": { \"rules\": \"firestore.rules\" }",
        ),
        "auth" => (
            "firebase.json does not configure the Auth emulator.",
            "\"emulators\": { \"auth\": {} }",
        ),
        "storage" => (
            "firebase.json does not configure Storage.",
            "\"emulators\": { \"storage\": {} },\n\"storage\": { \"rules\": \"storage.rules\" }",
        ),
        "functions" => (
            "firebase.json configures no Functions codebase and no Extensions.",
            "\"functions\": [{ \"source\": \"functions\" }]",
        ),
        _ => (
            "firebase.json does not configure the Pub/Sub emulator.",
            "\"emulators\": { \"pubsub\": {} }",
        ),
    };
    AbsentReason {
        kind: AbsentKind::NotConfigured,
        detail: detail.to_owned(),
        fixes: vec![SectionFix {
            label: "Add it to firebase.json".to_owned(),
            kind: SectionFixKind::FirebaseJson,
            text: snippet.to_owned(),
        }],
    }
}

/// Why `service` was left out by `--only`, and the developer's own command
/// line with it added.
fn excluded_by_only(service: &str, config: &SuiteConfig, launch: &LaunchContext) -> AbsentReason {
    let only = launch
        .only()
        .map_or_else(|| config.services.names().join(","), str::to_owned);
    AbsentReason {
        kind: AbsentKind::ExcludedByOnly,
        detail: format!("This engine was started with --only {only}."),
        fixes: launch
            .with_only(service)
            .map(|command| SectionFix {
                label: format!("Start with {}", label(service)),
                kind: SectionFixKind::Command,
                text: command,
            })
            .into_iter()
            .collect(),
    }
}

/// Why each section is absent: from the launch context when the npm CLI
/// passed one, else from the selection alone ([`AbsentKind::Unknown`]).
/// `functions_requested` is the selection before a project without any
/// Functions codebase turned Functions off.
pub(crate) fn absent_reasons(
    config: &SuiteConfig,
    launch: Option<&LaunchContext>,
    functions_requested: bool,
) -> BTreeMap<String, AbsentReason> {
    let mut reasons = BTreeMap::new();
    for service in DATA_SERVICES {
        if selected(config, service) {
            continue;
        }
        let reason = if service == "functions" && functions_requested {
            // Asked for, and turned off because nothing would run.
            not_configured(service)
        } else {
            match launch
                .and_then(|launch| launch.services.get(service).map(|reason| (launch, *reason)))
            {
                Some((_, LaunchReason::NotConfigured)) => not_configured(service),
                Some((launch, LaunchReason::ExcludedByOnly)) => {
                    excluded_by_only(service, config, launch)
                }
                Some((_, LaunchReason::Other)) | None => AbsentReason::unknown(service),
            }
        };
        if service == "functions" {
            for (follower, detail) in FOLLOWERS {
                reasons.insert(
                    follower.to_owned(),
                    AbsentReason {
                        kind: AbsentKind::Requires,
                        detail: detail.to_owned(),
                        fixes: reason.fixes.clone(),
                    },
                );
            }
        }
        reasons.insert(service.to_owned(), reason);
    }
    reasons
}

/// `firebase.json` services Firenook does not emulate, from the launch
/// context.
pub(crate) fn unsupported(launch: Option<&LaunchContext>) -> Vec<UnsupportedService> {
    launch
        .map(|launch| launch.skipped.as_slice())
        .unwrap_or_default()
        .iter()
        .map(|name| {
            let label = match name.as_str() {
                "database" => "Realtime Database",
                "hosting" => "Hosting",
                "dataconnect" => "Data Connect",
                "apphosting" => "App Hosting",
                other => other,
            };
            UnsupportedService {
                name: name.clone(),
                detail: format!(
                    "{label} is configured in firebase.json; Firenook does not emulate it yet."
                ),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests;
