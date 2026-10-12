//! Tenants with chosen ids (test 12), tenant pages and summary counts.

use std::sync::{Arc, Mutex};

use super::*;
use crate::observe::{AuthObserver, CallRecord, ConfigChange, Step};
use crate::tests::test_runtime;

const PROJECT: &str = "demo-auth";

#[derive(Default)]
struct Collect(Mutex<Vec<CallRecord>>);

impl AuthObserver for Collect {
    fn call(&self, record: CallRecord) {
        self.0.lock().expect("records").push(record);
    }
}

fn with_id(id: &str) -> TenantCreate {
    TenantCreate {
        tenant_id: Some(id.to_owned()),
        display_name: Some(format!("{id} corp")),
        allow_password_signup: true,
        ..TenantCreate::default()
    }
}

#[test]
fn a_tenant_is_created_with_the_id_asked_for_and_recorded() {
    let runtime = test_runtime();
    let records = Arc::new(Collect::default());
    runtime.set_observer(records.clone(), false);
    let handle = runtime.runtime();
    let created = handle
        .create_tenant(PROJECT, &with_id("acme"))
        .expect("created");
    assert_eq!(created.tenant_id, "acme");
    assert_eq!(created.display_name.as_deref(), Some("acme corp"));
    assert!(created.allow_password_signup);
    assert_eq!(created.mfa_state, "DISABLED");
    assert_eq!(created.users, 0);
    let recorded = records.0.lock().expect("records").clone();
    assert_eq!(recorded.len(), 1);
    assert_eq!(recorded[0].operation, "firenook.console.createTenant");
    assert_eq!(
        recorded[0].steps,
        [Step::Config {
            tenant: Some("acme".to_owned()),
            what: ConfigChange::TenantCreated
        }]
    );

    let taken = handle
        .create_tenant(PROJECT, &with_id("acme"))
        .expect_err("taken");
    assert_eq!(taken.kind, ConsoleErrorKind::AlreadyExists);
    assert_eq!(taken.message, "A tenant `acme` already exists.");
    for bad in ["ab", "1abc", "a_b", "a23456789012345678901"] {
        let refused = handle.create_tenant(PROJECT, &with_id(bad)).expect_err(bad);
        assert_eq!(refused.kind, ConsoleErrorKind::InvalidArgument, "{bad}");
        assert_eq!(
            refused.message,
            "A tenant id starts with a letter and holds 4 to 20 letters, digits or hyphens."
        );
    }
    let random = handle
        .create_tenant(
            PROJECT,
            &TenantCreate {
                mfa_state: Some("ENABLED".to_owned()),
                mfa_providers: vec!["PHONE_SMS".to_owned()],
                ..TenantCreate::default()
            },
        )
        .expect("created");
    assert_eq!(random.tenant_id.len(), 28);
    assert_eq!(random.mfa_state, "ENABLED");
    assert_eq!(random.mfa_providers, ["PHONE_SMS"]);
    let refused = handle
        .create_tenant(
            PROJECT,
            &TenantCreate {
                mfa_providers: vec!["TOTP".to_owned()],
                ..with_id("other")
            },
        )
        .expect_err("TOTP");
    assert_eq!(refused.kind, ConsoleErrorKind::InvalidArgument);
}

#[test]
fn tenant_pages_filter_count_users_and_create_nothing() {
    let runtime = test_runtime();
    let handle = runtime.runtime();
    assert_eq!(
        handle.tenant_page(PROJECT, "", None, 0),
        TenantPage::default()
    );
    assert!(
        lock(&handle.inner.data).projects.is_empty(),
        "a read creates nothing"
    );
    for id in ["acme", "beta-co", "gamma"] {
        handle
            .create_tenant(PROJECT, &with_id(id))
            .expect("created");
    }
    handle
        .update(|data| {
            let agent = data.agent(PROJECT);
            for uid in ["a1", "a2"] {
                agent
                    .tenants
                    .get_mut("acme")
                    .expect("acme")
                    .project
                    .create_user_with_local_id(uid, &crate::state::UserRecord::new())
                    .expect("create");
            }
            agent
                .project
                .create_user_with_local_id("p1", &crate::state::UserRecord::new())
                .expect("create");
        })
        .expect("users");
    let page = handle.tenant_page(PROJECT, "", None, 2);
    assert_eq!(
        page.tenants
            .iter()
            .map(|tenant| tenant.tenant_id.as_str())
            .collect::<Vec<_>>(),
        ["acme", "beta-co"]
    );
    assert_eq!(page.tenants[0].users, 2);
    assert_eq!(page.next.as_deref(), Some("beta-co"));
    assert_eq!(page.total, 3);
    assert_eq!(page.project_users, 1);
    let next = handle.tenant_page(PROJECT, "", page.next.as_deref(), 2);
    assert_eq!(next.tenants.len(), 1);
    assert_eq!(next.next, None);
    let found = handle.tenant_page(PROJECT, "BETA", None, 0);
    assert_eq!(found.total, 1);
    assert_eq!(found.tenants[0].tenant_id, "beta-co");
    let by_name = handle.tenant_page(PROJECT, "gamma corp", None, 0);
    assert_eq!(by_name.total, 1);
    let batch = handle.tenants_by_id(PROJECT, &["gamma".to_owned(), "gone".to_owned()]);
    assert_eq!(
        batch[0].as_ref().map(|tenant| tenant.tenant_id.as_str()),
        Some("gamma")
    );
    assert_eq!(batch[1], None);
    let counts = handle.summary_counts(PROJECT);
    assert_eq!(
        counts,
        SummaryCounts {
            users: 1,
            tenants: 3,
            tenant_users: 2
        }
    );
    assert_eq!(
        handle.summary_counts("demo-unseen"),
        SummaryCounts::default()
    );
}
