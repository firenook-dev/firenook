//! Storage rules as a console works with them: versions and installs,
//! recorded decisions and their explained re-runs, dry runs, access checks,
//! impact and coverage — over the real protocol routes.

use std::path::PathBuf;
use std::sync::Arc;

use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use firenook_functions_bridge::{TriggerObserver, TriggerRegistry};
use firenook_rules_engine::AllowDecision;
use tower::ServiceExt as _;

use super::*;

const PROJECT: &str = "demo-storage-rules";
const BUCKET: &str = "demo-storage-rules.appspot.com";
const MEDIA: &str = "demo-storage-rules-media";

/// Line 6 is the write allow, whose first check is the size.
const RULES: &str = "rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /users/{uid}/{allPaths=**} {
      allow read: if request.auth != null && request.auth.uid == uid;
      allow write: if request.resource.size < 5 * 1024 * 1024
        && request.auth != null && request.auth.uid == uid
        && request.resource.contentType.matches('image/.*');
    }
    match /public/{allPaths=**} {
      allow read;
    }
  }
}
";

const MEDIA_RULES: &str = "rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read;
      allow write: if request.auth != null;
    }
  }
}
";

struct Harness {
    runtime: StorageRuntime,
    root: PathBuf,
}

fn root(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "firenook-rules-{label}-{}-{}",
        std::process::id(),
        OffsetDateTime::now_utc().unix_timestamp_nanos()
    ))
}

async fn start(label: &str, source: RulesSource, files: Option<RulesFiles>) -> Harness {
    let root = root(label);
    let registry = TriggerRegistry::default();
    let (observer, _receiver) = TriggerObserver::channel(registry.clone());
    let runtime = StorageRuntime::start_with(
        StorageConfig {
            project: PROJECT.to_owned(),
            origin: "http://127.0.0.1:21002".to_owned(),
            data_dir: root.clone(),
            rules: Some(NativeRulesConfig {
                source,
                documents: Arc::new(NoFirestoreDocuments),
            }),
            durability: StorageDurability::PerCommit,
        },
        StorageOptions {
            diagnostics: true,
            rules_files: files,
            ..StorageOptions::default()
        },
        observer.queue(),
        registry,
    )
    .await
    .expect("Storage runtime");
    Harness { runtime, root }
}

async fn single(label: &str) -> Harness {
    start(
        label,
        RulesSource::Single(RulesFile {
            name: "config/storage.rules".to_owned(),
            content: RULES.to_owned(),
        }),
        Some(RulesFiles::Single(PathBuf::from("config/storage.rules"))),
    )
    .await
}

impl Harness {
    fn rules(&self) -> StorageRulesHandle {
        self.runtime.console().rules().expect("rules")
    }

    fn log(&self) -> std::sync::Arc<DecisionLog> {
        self.runtime
            .state
            .decisions
            .clone()
            .expect("diagnostics are on")
    }

    async fn send(
        &self,
        method: Method,
        uri: &str,
        headers: &[(&str, &str)],
        body: Body,
    ) -> StatusCode {
        let mut request = Request::builder().method(method).uri(uri);
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        self.runtime
            .application()
            .oneshot(request.body(body).expect("request"))
            .await
            .expect("response")
            .status()
    }

    /// Uploads `users/u_ada/avatar.png` (3 bytes) as the owner.
    async fn seed_avatar(&self) {
        assert_eq!(
            self.send(
                Method::POST,
                &format!("/v0/b/{BUCKET}/o?name=users%2Fu_ada%2Favatar.png"),
                &[("authorization", "Bearer owner")],
                Body::from("png")
            )
            .await,
            StatusCode::OK
        );
    }

    async fn finish(self) {
        self.runtime.shutdown().await.expect("shutdown");
        std::fs::remove_dir_all(self.root).expect("remove test storage");
    }
}

fn token(uid: &str) -> String {
    format!(
        "Bearer {}.{}.",
        URL_SAFE_NO_PAD.encode(br#"{"alg":"none"}"#),
        URL_SAFE_NO_PAD.encode(
            serde_json::to_vec(&json!({
                "user_id": uid,
                "sub": uid,
                "firebase": { "sign_in_provider": "password", "tenant": "tenant-a" }
            }))
            .expect("claims")
        )
    )
}

fn drain(
    feed: &mut tokio::sync::broadcast::Receiver<Arc<StorageDecisionRecord>>,
) -> Vec<Arc<StorageDecisionRecord>> {
    let mut records = Vec::new();
    while let Ok(record) = feed.try_recv() {
        records.push(record);
    }
    records
}

#[tokio::test]
async fn startup_console_and_reload_versions_are_recorded() {
    let harness = single("versions").await;
    let rules = harness.rules();
    assert_eq!(rules.mode(), RulesMode::Single);
    assert_eq!(rules.scopes(), [RulesScope::AllBuckets]);
    assert_eq!(rules.scope_of("any"), RulesScope::AllBuckets);
    assert_eq!(rules.file_name(&RulesScope::AllBuckets), "storage.rules");
    assert_eq!(
        rules.file(&RulesScope::AllBuckets),
        Some(PathBuf::from("config/storage.rules"))
    );
    let mut events = rules.subscribe();
    let startup = rules.current(&RulesScope::AllBuckets).expect("in force");
    assert_eq!(startup.origin, RulesOrigin::Startup);

    // A draft that does not compile changes nothing.
    let error = rules
        .install(
            &RulesScope::AllBuckets,
            "service firebase.storage {",
            RulesOrigin::Console,
        )
        .expect_err("does not compile");
    assert_ne!(error.len(), 0);
    assert_eq!(rules.history(&RulesScope::AllBuckets).len(), 1);
    assert_eq!(
        rules.current(&RulesScope::AllBuckets).expect("kept").hash,
        startup.hash
    );

    rules
        .install(&RulesScope::AllBuckets, MEDIA_RULES, RulesOrigin::Console)
        .expect("installs");
    // The same text again (the console saving what is in force) adds nothing.
    rules
        .install(&RulesScope::AllBuckets, MEDIA_RULES, RulesOrigin::File)
        .expect("installs");
    let history = rules.history(&RulesScope::AllBuckets);
    assert_eq!(
        history
            .iter()
            .map(|version| version.origin)
            .collect::<Vec<_>>(),
        [RulesOrigin::Console, RulesOrigin::Startup]
    );
    assert_eq!(
        events.try_recv().expect("installed"),
        StorageRulesEvent::Installed {
            scope: RulesScope::AllBuckets,
            origin: RulesOrigin::Console
        }
    );

    // `/internal/setRules` keeps its parity: a good body records `Reload`, a
    // broken one drops every ruleset.
    let body = |content: &str| {
        Body::from(
            serde_json::to_vec(
                &json!({ "rules": { "files": [{ "name": "storage.rules", "content": content }] } }),
            )
            .expect("body"),
        )
    };
    assert_eq!(
        harness
            .send(Method::PUT, "/internal/setRules", &[], body(RULES))
            .await,
        StatusCode::OK
    );
    assert_eq!(
        rules.history(&RulesScope::AllBuckets)[0].origin,
        RulesOrigin::Reload
    );
    assert_eq!(
        harness
            .send(Method::PUT, "/internal/setRules", &[], body("not rules"))
            .await,
        StatusCode::BAD_REQUEST
    );
    assert!(rules.current(&RulesScope::AllBuckets).is_none(), "dropped");
    let mut dropped = false;
    while let Ok(event) = events.try_recv() {
        dropped |= event
            == StorageRulesEvent::Dropped {
                scope: RulesScope::AllBuckets,
            };
    }
    assert!(dropped);
    // A console install brings the bucket back.
    rules
        .install(&RulesScope::AllBuckets, RULES, RulesOrigin::Console)
        .expect("installs");
    assert!(rules.current(&RulesScope::AllBuckets).is_some());

    rules.set_file_problems(
        &RulesScope::AllBuckets,
        Some(LoadError::unreadable("cannot read storage.rules")),
    );
    assert_eq!(rules.file_problems(&RulesScope::AllBuckets).len(), 1);
    rules.set_file_problems(&RulesScope::AllBuckets, None);
    assert_eq!(rules.file_problems(&RulesScope::AllBuckets), []);
    harness.finish().await;
}

#[tokio::test]
async fn per_bucket_scopes_install_one_bucket() {
    let harness = start(
        "per-bucket",
        RulesSource::PerBucket(vec![
            BucketRules {
                bucket: BUCKET.to_owned(),
                name: "storage.rules".to_owned(),
                content: RULES.to_owned(),
            },
            BucketRules {
                bucket: MEDIA.to_owned(),
                name: "storage.media.rules".to_owned(),
                content: MEDIA_RULES.to_owned(),
            },
        ]),
        None,
    )
    .await;
    let rules = harness.rules();
    assert_eq!(rules.mode(), RulesMode::PerBucket);
    assert_eq!(
        rules.scopes(),
        [
            RulesScope::Bucket(MEDIA.to_owned()),
            RulesScope::Bucket(BUCKET.to_owned())
        ]
    );
    let media = RulesScope::Bucket(MEDIA.to_owned());
    assert_eq!(rules.file_name(&media), "storage.media.rules");
    rules
        .install(&media, RULES, RulesOrigin::Console)
        .expect("installs");
    assert_eq!(
        rules
            .current(&RulesScope::Bucket(BUCKET.to_owned()))
            .expect("kept")
            .origin,
        RulesOrigin::Startup,
        "the other bucket keeps its rules"
    );
    assert_eq!(rules.history(&media).len(), 2);
    // A bucket nobody configured has no rules until one is installed.
    let unlisted = RulesScope::Bucket("demo-unlisted".to_owned());
    assert!(rules.current(&unlisted).is_none());
    rules
        .install(&unlisted, MEDIA_RULES, RulesOrigin::Console)
        .expect("installs");
    assert!(
        harness
            .runtime
            .state
            .rules
            .as_ref()
            .expect("rules")
            .has_ruleset("demo-unlisted")
    );
    harness.finish().await;
}

#[tokio::test]
async fn the_open_default_is_its_own_mode() {
    let harness = start(
        "open-default",
        RulesSource::Single(RulesFile {
            name: "emulators/default_storage.rules".to_owned(),
            content: MEDIA_RULES.to_owned(),
        }),
        Some(RulesFiles::None),
    )
    .await;
    let rules = harness.rules();
    assert_eq!(rules.mode(), RulesMode::OpenDefault);
    assert_eq!(rules.file(&RulesScope::AllBuckets), None);
    assert_eq!(
        rules.file_name(&RulesScope::AllBuckets),
        "default_storage.rules"
    );
    harness.finish().await;
}

#[tokio::test]
async fn decisions_record_who_what_and_the_lines_that_ran() {
    let harness = single("record").await;
    let log = harness.log();
    let mut feed = log.subscribe();
    let ada = token("u_ada");
    // Allowed read, denied read of another user's file, owner skips.
    assert_eq!(
        harness
            .send(
                Method::GET,
                &format!("/v0/b/{BUCKET}/o/users%2Fu_ada%2Fa.png"),
                &[("authorization", ada.as_str())],
                Body::empty()
            )
            .await,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        harness
            .send(
                Method::GET,
                &format!("/v0/b/{BUCKET}/o/users%2Fu_grace%2Fa.png"),
                &[("authorization", ada.as_str()), ("x-firenook-console", "1")],
                Body::empty()
            )
            .await,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        harness
            .send(
                Method::GET,
                &format!("/v0/b/{BUCKET}/o/users%2Fu_grace%2Fa.png"),
                &[("authorization", "Bearer owner")],
                Body::empty()
            )
            .await,
        StatusCode::NOT_FOUND
    );
    // An anonymous upload is judged as `create` with its size and type.
    assert_eq!(
        harness
            .send(
                Method::POST,
                &format!("/v0/b/{BUCKET}/o?name=users%2Fu_ada%2Fnote.txt"),
                &[],
                Body::from("hello")
            )
            .await,
        StatusCode::FORBIDDEN
    );
    let records = drain(&mut feed);
    assert_eq!(records.len(), 3, "the owner's request is not a decision");
    let allowed = &records[0];
    assert_eq!(allowed.id, "s1");
    assert_eq!(allowed.operation, Operation::Get);
    assert_eq!(allowed.outcome, DecisionOutcome::Allow);
    assert_eq!(allowed.uid.as_deref(), Some("u_ada"));
    assert_eq!(allowed.tenant.as_deref(), Some("tenant-a"));
    assert_eq!(allowed.provider.as_deref(), Some("password"));
    assert!(!allowed.anonymous && !allowed.via_console && !allowed.no_ruleset);
    assert_eq!(allowed.allows.len(), 1);
    assert_eq!(allowed.allows[0].line, 5);
    assert_eq!(allowed.allows[0].decision, AllowDecision::Allow);
    let utf16 = RULES.encode_utf16().collect::<Vec<_>>();
    assert_eq!(
        String::from_utf16(&utf16[allowed.allows[0].from..allowed.allows[0].to]).expect("text"),
        "request.auth != null && request.auth.uid == uid"
    );
    let denied = &records[1];
    assert_eq!(denied.outcome, DecisionOutcome::Deny);
    assert!(denied.via_console);
    assert_eq!(denied.name, "users/u_grace/a.png");
    let upload = &records[2];
    assert_eq!(upload.operation, Operation::Create);
    assert!(upload.anonymous);
    assert_eq!(upload.proposed_size, Some(5));
    assert_eq!(
        upload.proposed_content_type.as_deref(),
        Some("application/octet-stream")
    );
    assert_eq!(
        upload.rules_hash,
        harness
            .rules()
            .current(&RulesScope::AllBuckets)
            .expect("rules")
            .hash
    );
    assert_eq!(log.re_runnable(), 3);
    harness.finish().await;
}

#[tokio::test]
async fn detail_reruns_and_explains_a_denied_upload() {
    let harness = single("detail").await;
    let log = harness.log();
    let mut feed = log.subscribe();
    let ada = token("u_ada");
    assert_eq!(
        harness
            .send(
                Method::POST,
                &format!("/v0/b/{BUCKET}/o?name=users%2Fu_ada%2Fbig.mov"),
                &[("authorization", ada.as_str())],
                Body::from(vec![0_u8; 7_340_032])
            )
            .await,
        StatusCode::FORBIDDEN
    );
    let record = drain(&mut feed).pop().expect("recorded");
    assert_eq!(record.outcome, DecisionOutcome::Deny);
    assert_eq!(record.proposed_size, Some(7_340_032));
    let rules = harness.rules();
    let detail = rules.detail(&record.id).expect("still kept");
    assert_eq!(detail.recorded_outcome, DecisionOutcome::Deny);
    assert_eq!(detail.result.outcome, DecisionOutcome::Deny);
    assert_eq!(detail.rules, RULES);
    assert_eq!(detail.claims["user_id"], "u_ada");
    let size = detail
        .result
        .explanation
        .iter()
        .find(|step| step.value == "7340032")
        .expect("the size step");
    let utf16 = RULES.encode_utf16().collect::<Vec<_>>();
    assert_eq!(
        String::from_utf16(&utf16[size.span.from..size.span.to]).expect("text"),
        "request.resource.size"
    );
    assert_eq!(size.span.line, 6);
    // The request replays to the same verdict as a dry run.
    assert_eq!(detail.request.method, Operation::Create);
    assert_eq!(detail.request.resource, RecordedObject::Missing);
    let replayed = rules
        .evaluate(std::slice::from_ref(&detail.request), None)
        .expect("evaluates");
    assert_eq!(replayed[0].outcome, DecisionOutcome::Deny);
    assert_eq!(
        replayed[0]
            .request_resource
            .as_ref()
            .map(|object| object.size),
        Some(7_340_032)
    );
    // An evicted decision has no detail.
    assert!(rules.detail("s999999").is_none());
    harness.finish().await;
}

#[tokio::test]
async fn no_ruleset_and_v1_list_are_recorded_as_errors() {
    let harness = start(
        "refusals",
        RulesSource::PerBucket(vec![BucketRules {
            bucket: MEDIA.to_owned(),
            name: "storage.v1.rules".to_owned(),
            content: "service firebase.storage {\n  match /b/{bucket}/o/{path=**} {\n    allow read: if true;\n  }\n}\n".to_owned(),
        }]),
        None,
    )
    .await;
    let log = harness.log();
    let mut feed = log.subscribe();
    let ada = token("u_ada");
    assert_eq!(
        harness
            .send(
                Method::GET,
                &format!("/v0/b/{BUCKET}/o/a.png"),
                &[("authorization", ada.as_str())],
                Body::empty()
            )
            .await,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        harness
            .send(
                Method::GET,
                &format!("/v0/b/{MEDIA}/o?prefix="),
                &[("authorization", ada.as_str())],
                Body::empty()
            )
            .await,
        StatusCode::FORBIDDEN
    );
    let records = drain(&mut feed);
    assert_eq!(records.len(), 2);
    assert!(records[0].no_ruleset);
    assert_eq!(records[0].outcome, DecisionOutcome::Error);
    assert_eq!(
        records[0].error.as_deref(),
        Some("Permission denied. Storage Emulator has no loaded ruleset.")
    );
    assert_eq!(records[1].operation, Operation::List);
    assert_eq!(records[1].outcome, DecisionOutcome::Error);
    assert_eq!(
        records[1].error.as_deref(),
        Some("Permission denied. List operations are only allowed for rules_version='2'.")
    );
    harness.finish().await;
}

#[tokio::test]
async fn dry_runs_judge_like_requests_and_drafts() {
    let harness = single("dry-run").await;
    let rules = harness.rules();
    let log = harness.log();
    let ada = token("u_ada");
    harness.seed_avatar().await;
    let coverage_before = rules
        .coverage_report(&RulesScope::AllBuckets)
        .expect("report");
    let dry = |method, path: &str, proposed| DryRunRequest {
        method,
        bucket: BUCKET.to_owned(),
        path: path.to_owned(),
        authorization: Some(ada.clone()),
        auth: None,
        proposed,
        request_resource: None,
        resource: RecordedObject::ReadStore,
        time: None,
    };
    let results = rules
        .evaluate(
            &[
                dry(Operation::Get, "users/u_ada/avatar.png", None),
                dry(
                    Operation::Create,
                    "users/u_ada/clip.mov",
                    Some(ProposedObject {
                        size: Some(7_340_032),
                        content_type: Some(Some("video/quicktime".to_owned())),
                        ..ProposedObject::default()
                    }),
                ),
                dry(
                    Operation::Update,
                    "users/u_ada/avatar.png",
                    Some(ProposedObject {
                        custom_metadata: Some(std::collections::BTreeMap::from([(
                            "source".to_owned(),
                            Some("camera".to_owned()),
                        )])),
                        ..ProposedObject::default()
                    }),
                ),
            ],
            None,
        )
        .expect("evaluates");
    assert_eq!(results[0].outcome, DecisionOutcome::Allow);
    assert_eq!(
        results[0].resource.as_ref().map(|object| object.size),
        Some(3),
        "the store is read"
    );
    assert_eq!(results[1].outcome, DecisionOutcome::Deny);
    assert_eq!(
        results[2].changed_keys.as_deref(),
        Some(&["source".to_owned()][..])
    );
    assert_eq!(
        results[2]
            .request_resource
            .as_ref()
            .map(|object| object.metageneration.as_str()),
        Some("2")
    );
    // Against a draft that allows video, before it is applied.
    let draft = RULES.replace("matches('image/.*')", "matches('(image|video)/.*')");
    let draft = draft.replace("5 * 1024 * 1024", "10 * 1024 * 1024");
    let results = rules
        .evaluate(
            &[dry(
                Operation::Create,
                "users/u_ada/clip.mov",
                Some(ProposedObject {
                    size: Some(7_340_032),
                    content_type: Some(Some("video/quicktime".to_owned())),
                    ..ProposedObject::default()
                }),
            )],
            Some(&draft),
        )
        .expect("evaluates");
    assert_eq!(results[0].outcome, DecisionOutcome::Allow);
    assert!(rules.evaluate(&[], Some("not rules")).is_err());
    // Dry runs are not decisions and add no coverage.
    assert_eq!(log.re_runnable(), 0);
    assert_eq!(
        rules
            .coverage_report(&RulesScope::AllBuckets)
            .expect("report"),
        coverage_before
    );
    harness.finish().await;
}

#[tokio::test]
async fn access_checks_and_coverage() {
    let harness = single("access").await;
    let rules = harness.rules();
    let log = harness.log();
    let ada = token("u_ada");
    harness.seed_avatar().await;
    let coverage_before = rules
        .coverage_report(&RulesScope::AllBuckets)
        .expect("report");
    let rows = rules.access(
        BUCKET,
        (Some(ada.as_str()), None),
        &[
            "users/u_ada/avatar.png".to_owned(),
            "users/u_grace/a.png".to_owned(),
        ],
        &[Operation::Get, Operation::Delete],
    );
    assert_eq!(rows[0].verdicts[0].outcome, DecisionOutcome::Allow);
    assert_eq!(rows[0].verdicts[0].line, Some(5));
    assert_eq!(rows[1].verdicts[0].outcome, DecisionOutcome::Deny);
    assert_eq!(rows[1].verdicts[1].outcome, DecisionOutcome::Deny);
    // Access checks are not decisions and add no coverage.
    assert_eq!(log.re_runnable(), 0);
    assert_eq!(
        rules
            .coverage_report(&RulesScope::AllBuckets)
            .expect("report"),
        coverage_before
    );

    // Real traffic is observed, per expression, in the official shape.
    harness
        .send(
            Method::GET,
            &format!("/v0/b/{BUCKET}/o/users%2Fu_ada%2Favatar.png"),
            &[("authorization", ada.as_str())],
            Body::empty(),
        )
        .await;
    let report: JsonValue = serde_json::from_slice(
        &rules
            .coverage_report(&RulesScope::AllBuckets)
            .expect("report"),
    )
    .expect("JSON");
    assert_eq!(report["rules"]["files"][0]["name"], "storage.rules");
    assert_eq!(report["rules"]["files"][0]["content"], RULES);
    assert!(report["report"].to_string().contains("\"count\":1"));
    assert_eq!(
        report["firenookCoverage"]["countModel"],
        "actual-evaluator-visits"
    );
    harness.finish().await;
}

#[tokio::test]
async fn impact_lists_the_decisions_a_draft_turns_around() {
    let harness = single("impact").await;
    let ada = token("u_ada");
    for path in ["users%2Fu_ada%2Fa.png", "public%2Flogo.png"] {
        harness
            .send(
                Method::GET,
                &format!("/v0/b/{BUCKET}/o/{path}"),
                &[("authorization", ada.as_str())],
                Body::empty(),
            )
            .await;
    }
    let rules = harness.rules();
    let draft = RULES.replace("allow read;", "allow read: if false;");
    let impact = rules
        .impact(&RulesScope::AllBuckets, &draft)
        .expect("compiles");
    assert_eq!(impact.considered, 2);
    assert_eq!(impact.flips.len(), 1);
    assert_eq!(impact.flips[0].path, "public/logo.png");
    assert_eq!(impact.flips[0].before, DecisionOutcome::Allow);
    assert_eq!(impact.flips[0].after, DecisionOutcome::Deny);
    harness.finish().await;
}

#[tokio::test]
async fn a_console_refusal_carries_its_explanation() {
    let harness = single("refusal").await;
    let rules = harness.rules();
    // Fill the log with newer decisions: the explanation does not need it.
    let ada = token("u_ada");
    for _ in 0..50 {
        harness
            .send(
                Method::GET,
                &format!("/v0/b/{BUCKET}/o/public%2Fa.png"),
                &[("authorization", ada.as_str())],
                Body::empty(),
            )
            .await;
    }
    let request = DryRunRequest {
        method: Operation::Create,
        bucket: BUCKET.to_owned(),
        path: "users/u_ada/big.mov".to_owned(),
        authorization: Some(ada.clone()),
        auth: None,
        proposed: Some(ProposedObject {
            size: Some(7_340_032),
            content_type: Some(Some("video/quicktime".to_owned())),
            ..ProposedObject::default()
        }),
        request_resource: None,
        resource: RecordedObject::ReadStore,
        time: None,
    };
    let refusal = rules.explain_refusal(&request, Some("s7".to_owned()));
    assert_eq!(refusal.decision.as_deref(), Some("s7"));
    assert_eq!(refusal.line, Some(6));
    let evaluation = refusal.evaluation.expect("explained");
    assert_eq!(evaluation.outcome, DecisionOutcome::Deny);
    assert!(
        evaluation
            .explanation
            .iter()
            .any(|step| step.value == "7340032")
    );
    assert_eq!(refusal.request, Some(request));
    harness.finish().await;
}

#[tokio::test]
async fn the_map_probes_folders_that_hold_files() {
    let harness = single("map").await;
    harness.seed_avatar().await;
    for name in ["misc%2Fblob.bin", "users%2Fu_ada%2Fuploads%2F2026%2Fx.png"] {
        assert_eq!(
            harness
                .send(
                    Method::POST,
                    &format!("/v0/b/{BUCKET}/o?name={name}"),
                    &[("authorization", "Bearer owner")],
                    Body::from("x")
                )
                .await,
            StatusCode::OK
        );
    }
    let rules = harness.rules();
    let in_force = rules.current(&RulesScope::AllBuckets).expect("rules");
    assert!(
        harness
            .runtime
            .console()
            .folder_index_ready(std::time::Duration::from_secs(10))
            .await
            .expect("built")
    );
    let map = rules.map(BUCKET, &in_force.ruleset).expect("index built");
    let folders = map
        .folders
        .iter()
        .map(|folder| (folder.pattern.as_str(), folder.files, folder.uncovered))
        .collect::<Vec<_>>();
    assert_eq!(
        folders,
        [
            ("misc/", 1, true),
            ("users/u_ada/", 1, false),
            ("users/u_ada/uploads/2026/", 1, false),
        ]
    );
    assert_eq!(
        map.folders[1].governed_by[0].path,
        "/users/{uid}/{allPaths=**}"
    );
    assert_eq!(map.unused_matches.len(), 1, "public/ holds nothing");
    // A draft with a one-level user block leaves the deep folder uncovered.
    let draft = firenook_rules_engine::compile(&RULES.replace("{allPaths=**}", "{file}"))
        .expect("compiles");
    let map = rules.map(BUCKET, &draft).expect("index built");
    assert!(map.folders[2].uncovered);
    assert!(!map.folders[1].uncovered);
    harness.finish().await;
}
