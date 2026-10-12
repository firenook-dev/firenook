//! Links between sections.
//!
//! A section's payload that points at something another section shows (a
//! log line's function, an invocation's document, a decision's user)
//! carries an [`EntityRef`], and the console turns it into a link through
//! the target section's registry, or plain text when that section is
//! absent or not built yet. Every key is written by the constructors here,
//! so no section formats one by hand. A key splits at its first `|` (the
//! first two for a Cloud Tasks queue, the first three for a task): every
//! leading part is an id that cannot contain `|`, so the last part may hold
//! anything, an object name included.
//!
//! The type lives here, below the console, because log lines carry refs and
//! every crate that writes a log line reaches this crate, while none reaches
//! the console's own crate (which re-exports it).

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Something a section shows, as another section's payload points at it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct EntityRef {
    /// `<section>.<thing>`: one of the pinned kinds, the same kinds as a
    /// search hit's.
    pub kind: String,
    /// What that section opens it by, in the kind's key format.
    pub key: String,
    /// The text to show, when it is not the key.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub label: Option<String>,
}

/// A leading key part: an id that never holds `|` (a database, a bucket, a
/// tenant, a project, a location, a queue). One that does is a caller's
/// mistake; it is written with `|` replaced so the key still splits right.
fn id_part(id: &str) -> String {
    debug_assert!(
        !id.contains('|'),
        "a leading key part never holds `|`: {id}"
    );
    id.replace('|', "_")
}

impl EntityRef {
    fn new(kind: &str, key: String) -> Self {
        Self {
            kind: kind.to_owned(),
            key,
            label: None,
        }
    }

    fn pair(kind: &str, id: &str, rest: &str) -> Self {
        Self::new(kind, format!("{}|{rest}", id_part(id)))
    }

    /// The same reference, shown as `label`.
    #[must_use]
    pub fn with_label(mut self, label: impl Into<String>) -> Self {
        self.label = Some(label.into());
        self
    }

    /// The key's parts: the leading ids and the free last part, split as the
    /// kind writes them (one part for the single-id kinds).
    #[must_use]
    pub fn parts(&self) -> Vec<&str> {
        let leading = match self.kind.as_str() {
            "firestore.collection"
            | "firestore.document"
            | "firestore.decision"
            | "auth.user"
            | "storage.object"
            | "storage.folder"
            | "storage.decision"
            | "pubsub.message" => 1,
            "tasks.queue" => 2,
            "tasks.task" => 3,
            _ => 0,
        };
        self.key.splitn(leading + 1, '|').collect()
    }

    /// `firestore.collection`: `<database>|<pattern>`.
    #[must_use]
    pub fn firestore_collection(database: &str, pattern: &str) -> Self {
        Self::pair("firestore.collection", database, pattern)
    }

    /// `firestore.document`: `<database>|<path>`.
    #[must_use]
    pub fn firestore_document(database: &str, path: &str) -> Self {
        Self::pair("firestore.document", database, path)
    }

    /// `firestore.decision`: `<database>|<request id>`.
    #[must_use]
    pub fn firestore_decision(database: &str, request_id: &str) -> Self {
        Self::pair("firestore.decision", database, request_id)
    }

    /// `auth.user`: `<tenant>|<uid>`, the tenant empty for the project's
    /// users.
    #[must_use]
    pub fn auth_user(tenant: Option<&str>, uid: &str) -> Self {
        Self::pair("auth.user", tenant.unwrap_or_default(), uid)
    }

    /// `auth.call`: `<call id>`.
    #[must_use]
    pub fn auth_call(id: &str) -> Self {
        Self::new("auth.call", id.to_owned())
    }

    /// `auth.message`: `<message id>`.
    #[must_use]
    pub fn auth_message(id: &str) -> Self {
        Self::new("auth.message", id.to_owned())
    }

    /// `storage.object`: `<bucket>|<name>`.
    #[must_use]
    pub fn storage_object(bucket: &str, name: &str) -> Self {
        Self::pair("storage.object", bucket, name)
    }

    /// `storage.folder`: `<bucket>|<prefix>`.
    #[must_use]
    pub fn storage_folder(bucket: &str, prefix: &str) -> Self {
        Self::pair("storage.folder", bucket, prefix)
    }

    /// `storage.decision`: `<bucket or *>|<decision id>`.
    #[must_use]
    pub fn storage_decision(bucket: Option<&str>, id: &str) -> Self {
        Self::pair("storage.decision", bucket.unwrap_or("*"), id)
    }

    /// `functions.function`: `<function id>`.
    #[must_use]
    pub fn function(id: &str) -> Self {
        Self::new("functions.function", id.to_owned())
    }

    /// `functions.invocation`: `<invocation id>`.
    #[must_use]
    pub fn invocation(id: &str) -> Self {
        Self::new("functions.invocation", id.to_owned())
    }

    /// `functions.codebase`: `<codebase>`.
    #[must_use]
    pub fn codebase(name: &str) -> Self {
        Self::new("functions.codebase", name.to_owned())
    }

    /// `extensions.instance`: `<instance id>`.
    #[must_use]
    pub fn extension_instance(id: &str) -> Self {
        Self::new("extensions.instance", id.to_owned())
    }

    /// `eventarc.event`: `<event id>`.
    #[must_use]
    pub fn eventarc_event(id: &str) -> Self {
        Self::new("eventarc.event", id.to_owned())
    }

    /// `eventarc.channel`: `<channel name>`.
    #[must_use]
    pub fn eventarc_channel(name: &str) -> Self {
        Self::new("eventarc.channel", name.to_owned())
    }

    /// `pubsub.topic`: the full resource name.
    #[must_use]
    pub fn pubsub_topic(name: &str) -> Self {
        Self::new("pubsub.topic", name.to_owned())
    }

    /// `pubsub.subscription`: the full resource name.
    #[must_use]
    pub fn pubsub_subscription(name: &str) -> Self {
        Self::new("pubsub.subscription", name.to_owned())
    }

    /// `pubsub.schema`: the full resource name.
    #[must_use]
    pub fn pubsub_schema(name: &str) -> Self {
        Self::new("pubsub.schema", name.to_owned())
    }

    /// `pubsub.message`: `<topic full name>|<message id>`.
    #[must_use]
    pub fn pubsub_message(topic: &str, id: &str) -> Self {
        Self::pair("pubsub.message", topic, id)
    }

    /// `pubsub.schedule`: `<function id>`.
    #[must_use]
    pub fn pubsub_schedule(function_id: &str) -> Self {
        Self::new("pubsub.schedule", function_id.to_owned())
    }

    /// `tasks.queue`: `<project>|<location>|<queue id>`.
    #[must_use]
    pub fn tasks_queue(project: &str, location: &str, queue: &str) -> Self {
        Self::new(
            "tasks.queue",
            format!("{}|{}|{queue}", id_part(project), id_part(location)),
        )
    }

    /// `tasks.task`: `<project>|<location>|<queue id>|<task id>`.
    #[must_use]
    pub fn tasks_task(project: &str, location: &str, queue: &str, id: &str) -> Self {
        Self::new(
            "tasks.task",
            format!(
                "{}|{}|{}|{id}",
                id_part(project),
                id_part(location),
                id_part(queue)
            ),
        )
    }

    /// `logs.entry`: `<cursor>`.
    #[must_use]
    pub fn log_entry(cursor: &str) -> Self {
        Self::new("logs.entry", cursor.to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_pinned(cases: &[(EntityRef, &str, &str)]) {
        for (entity, kind, key) in cases {
            assert_eq!(entity.kind, *kind);
            assert_eq!(entity.key, *key, "{kind}");
            assert_eq!(entity.label, None);
        }
    }

    #[test]
    fn the_data_sections_constructors_write_their_pinned_kinds_and_keys() {
        assert_pinned(&[
            (
                EntityRef::firestore_collection("(default)", "users/*/orders"),
                "firestore.collection",
                "(default)|users/*/orders",
            ),
            (
                EntityRef::firestore_document("analytics", "users/u_1"),
                "firestore.document",
                "analytics|users/u_1",
            ),
            (
                EntityRef::firestore_decision("(default)", "r_7"),
                "firestore.decision",
                "(default)|r_7",
            ),
            (EntityRef::auth_user(None, "u_1"), "auth.user", "|u_1"),
            (
                EntityRef::auth_user(Some("acme"), "u_1"),
                "auth.user",
                "acme|u_1",
            ),
            (EntityRef::auth_call("c_1"), "auth.call", "c_1"),
            (EntityRef::auth_message("m_1"), "auth.message", "m_1"),
            (
                EntityRef::storage_object("b", "a|b.png"),
                "storage.object",
                "b|a|b.png",
            ),
            (
                EntityRef::storage_folder("b", "avatars/"),
                "storage.folder",
                "b|avatars/",
            ),
            (
                EntityRef::storage_decision(None, "d_1"),
                "storage.decision",
                "*|d_1",
            ),
            (
                EntityRef::storage_decision(Some("b"), "d_1"),
                "storage.decision",
                "b|d_1",
            ),
        ]);
    }

    #[test]
    fn the_other_constructors_write_their_pinned_kinds_and_keys() {
        assert_pinned(&[
            (
                EntityRef::function("us-central1-hello"),
                "functions.function",
                "us-central1-hello",
            ),
            (EntityRef::invocation("i_1"), "functions.invocation", "i_1"),
            (
                EntityRef::codebase("default"),
                "functions.codebase",
                "default",
            ),
            (
                EntityRef::extension_instance("resize"),
                "extensions.instance",
                "resize",
            ),
            (EntityRef::eventarc_event("e_1"), "eventarc.event", "e_1"),
            (
                EntityRef::eventarc_channel("firebase"),
                "eventarc.channel",
                "firebase",
            ),
            (
                EntityRef::pubsub_topic("projects/p/topics/t"),
                "pubsub.topic",
                "projects/p/topics/t",
            ),
            (
                EntityRef::pubsub_subscription("projects/p/subscriptions/s"),
                "pubsub.subscription",
                "projects/p/subscriptions/s",
            ),
            (
                EntityRef::pubsub_schema("projects/p/schemas/s"),
                "pubsub.schema",
                "projects/p/schemas/s",
            ),
            (
                EntityRef::pubsub_message("projects/p/topics/t", "42"),
                "pubsub.message",
                "projects/p/topics/t|42",
            ),
            (
                EntityRef::pubsub_schedule("nightly"),
                "pubsub.schedule",
                "nightly",
            ),
            (
                EntityRef::tasks_queue("p", "us-central1", "q"),
                "tasks.queue",
                "p|us-central1|q",
            ),
            (
                EntityRef::tasks_task("p", "us-central1", "q", "t|1"),
                "tasks.task",
                "p|us-central1|q|t|1",
            ),
            (
                EntityRef::log_entry("0000abcd.12"),
                "logs.entry",
                "0000abcd.12",
            ),
        ]);
    }

    #[test]
    fn keys_split_back_at_their_leading_bars_and_the_last_part_keeps_any() {
        assert_eq!(
            EntityRef::storage_object("b", "a|b|c.png").parts(),
            ["b", "a|b|c.png"]
        );
        assert_eq!(
            EntityRef::tasks_task("p", "l", "q", "t|x").parts(),
            ["p", "l", "q", "t|x"]
        );
        assert_eq!(
            EntityRef::tasks_queue("p", "l", "q|x").parts(),
            ["p", "l", "q|x"]
        );
        assert_eq!(EntityRef::auth_user(None, "u|1").parts(), ["", "u|1"]);
        assert_eq!(EntityRef::log_entry("a|b").parts(), ["a|b"]);
    }

    #[test]
    fn a_label_is_sent_only_when_set() {
        let plain = serde_json::to_value(EntityRef::function("f")).expect("json");
        assert_eq!(
            plain,
            serde_json::json!({ "kind": "functions.function", "key": "f" })
        );
        let labelled =
            serde_json::to_value(EntityRef::auth_user(None, "u_1").with_label("ada@example.test"))
                .expect("json");
        assert_eq!(labelled["label"], "ada@example.test");
    }

    #[test]
    fn a_ref_reads_back_with_or_without_its_label() {
        let labelled = EntityRef::auth_user(Some("acme"), "u_1").with_label("Ada");
        let json = serde_json::to_string(&labelled).expect("json");
        assert_eq!(
            serde_json::from_str::<EntityRef>(&json).expect("read"),
            labelled
        );
        assert_eq!(
            serde_json::from_str::<EntityRef>(r#"{"kind":"functions.function","key":"f"}"#)
                .expect("read"),
            EntityRef::function("f")
        );
    }
}
