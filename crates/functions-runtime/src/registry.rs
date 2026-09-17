//! The trigger table (`FunctionsEmulator.triggers`), its keys, the
//! multicast fan-out for Auth and Storage events, the Eventarc channel
//! subscriptions, the blocking-function configuration, and the in-process
//! registration of Firestore triggers with the bridge.
use std::collections::{BTreeMap, HashMap};

use fireside_functions_bridge::TriggerRegistry;
use serde_json::{Map, Value, json};

use crate::log::{LogEvent, LogSink};
use crate::manifest::Definition;

/// Services whose event triggers this suite delivers (`upstreamIgnoreReason`).
const DELIVERED_SERVICES: [&str; 5] = [
    "firestore.googleapis.com",
    "pubsub.googleapis.com",
    "eventarc.googleapis.com",
    "firebaseauth.googleapis.com",
    "storage.googleapis.com",
];

/// One registered definition.
#[derive(Debug, Clone)]
pub struct Record {
    pub key: String,
    pub definition: Definition,
    pub codebase: String,
    pub extension_instance: Option<String>,
    pub enabled: bool,
    /// Why the definition receives no deliveries, when it does not.
    pub ignored: Option<String>,
    pub url: Option<String>,
}

/// A registered Eventarc channel subscription.
#[derive(Debug, Clone)]
pub struct EventarcSubscription {
    pub project: String,
    pub trigger_key: String,
    pub event_type: String,
    pub channel: String,
    pub filters: BTreeMap<String, String>,
}

/// Blocking-function configuration the Auth front consumes.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BlockingConfig {
    pub before_create: Option<String>,
    pub before_sign_in: Option<String>,
    pub forward_access_token: bool,
    pub forward_id_token: bool,
    pub forward_refresh_token: bool,
}

impl BlockingConfig {
    /// The `blockingFunctions` JSON the official emulator `PATCHes` into Auth.
    #[must_use]
    pub fn to_json(&self) -> Value {
        let mut triggers = Map::new();
        if let Some(url) = &self.before_create {
            triggers.insert("beforeCreate".to_owned(), json!({"functionUri": url}));
        }
        if let Some(url) = &self.before_sign_in {
            triggers.insert("beforeSignIn".to_owned(), json!({"functionUri": url}));
        }
        json!({
            "triggers": triggers,
            "forwardInboundCredentials": {
                "accessToken": self.forward_access_token,
                "idToken": self.forward_id_token,
                "refreshToken": self.forward_refresh_token,
            }
        })
    }
}

/// The trigger table.
#[derive(Debug)]
pub struct Registry {
    project: String,
    records: Vec<Record>,
    index: HashMap<String, usize>,
    generation: u32,
    multicast: HashMap<String, Vec<String>>,
    eventarc: HashMap<String, Vec<EventarcSubscription>>,
    /// Subscriptions registered through the Eventarc emulator route by
    /// something other than this runtime's own definitions.
    external_eventarc: Vec<EventarcSubscription>,
    blocking: BlockingConfig,
}

/// The outcome of registering one definition.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Admission {
    pub key: String,
    pub ignored: Option<String>,
    pub url: Option<String>,
}

impl Registry {
    #[must_use]
    pub fn new(project: &str) -> Self {
        Self {
            project: project.to_owned(),
            records: Vec::new(),
            index: HashMap::new(),
            generation: 0,
            multicast: HashMap::new(),
            eventarc: HashMap::new(),
            external_eventarc: Vec::new(),
            blocking: BlockingConfig::default(),
        }
    }

    #[must_use]
    pub fn generation(&self) -> u32 {
        self.generation
    }

    #[must_use]
    pub fn records(&self) -> &[Record] {
        &self.records
    }

    #[must_use]
    pub fn get(&self, key: &str) -> Option<&Record> {
        self.index.get(key).map(|index| &self.records[*index])
    }

    /// Keys in registration order, as the 404 body lists them.
    #[must_use]
    pub fn keys(&self) -> Vec<&str> {
        self.records
            .iter()
            .map(|record| record.key.as_str())
            .collect()
    }

    #[must_use]
    pub fn blocking(&self) -> &BlockingConfig {
        &self.blocking
    }

    #[must_use]
    pub fn multicast_targets(&self, key: &str) -> Vec<String> {
        self.multicast.get(key).cloned().unwrap_or_default()
    }

    #[must_use]
    pub fn eventarc_subscriptions(
        &self,
        event_type: &str,
        channel: &str,
    ) -> Vec<EventarcSubscription> {
        let mut subscriptions = self
            .eventarc
            .get(&format!("{event_type}-{channel}"))
            .cloned()
            .unwrap_or_default();
        subscriptions.extend(
            self.external_eventarc
                .iter()
                .filter(|subscription| {
                    subscription.event_type == event_type && subscription.channel == channel
                })
                .cloned(),
        );
        subscriptions
    }

    /// Registers a subscription received on the Eventarc emulator route.
    pub fn add_external_eventarc(
        &mut self,
        project: String,
        trigger_key: String,
        event_type: String,
        channel: String,
        filters: BTreeMap<String, String>,
    ) {
        self.external_eventarc.push(EventarcSubscription {
            project,
            trigger_key,
            event_type,
            channel,
            filters,
        });
    }

    /// Removes an externally registered subscription; `false` when unknown.
    pub fn remove_external_eventarc(
        &mut self,
        trigger_key: &str,
        event_type: &str,
        channel: &str,
    ) -> bool {
        let before = self.external_eventarc.len();
        self.external_eventarc.retain(|subscription| {
            !(subscription.trigger_key == trigger_key
                && subscription.event_type == event_type
                && subscription.channel == channel)
        });
        self.external_eventarc.len() != before
    }

    /// `GET /google/getTriggers`: subscriptions keyed `<eventType>-<channel>`.
    #[must_use]
    pub fn eventarc_json(&self) -> Value {
        let mut out: Map<String, Value> = Map::new();
        let all = self
            .eventarc
            .values()
            .flatten()
            .chain(self.external_eventarc.iter());
        for subscription in all {
            let key = format!("{}-{}", subscription.event_type, subscription.channel);
            let entry = out.entry(key).or_insert_with(|| Value::Array(Vec::new()));
            if let Some(list) = entry.as_array_mut() {
                list.push(json!({
                    "projectId": subscription.project,
                    "triggerName": subscription.trigger_key,
                    "eventTrigger": {"eventType": subscription.event_type, "channel": subscription.channel, "eventFilters": subscription.filters},
                }));
            }
        }
        Value::Object(out)
    }

    /// `getTriggerKey`.
    #[must_use]
    pub fn key_for(&self, definition: &Definition) -> String {
        match definition.event_trigger() {
            Some(event) => {
                let base = format!("{}-{}", definition.id(), self.generation);
                match event.get("channel").and_then(Value::as_str) {
                    Some(channel) => format!("{base}-{channel}"),
                    None => base,
                }
            }
            None => definition.id(),
        }
    }

    /// Removes every record of a codebase, unregistering its bridge and
    /// multicast entries. Returns the removed keys.
    pub fn remove_codebase(
        &mut self,
        codebase: &str,
        project: &str,
        triggers: &TriggerRegistry,
    ) -> Vec<String> {
        let removed: Vec<Record> = self
            .records
            .iter()
            .filter(|record| record.codebase == codebase)
            .cloned()
            .collect();
        for record in &removed {
            Self::unregister_side_effects(record, project, triggers);
        }
        self.records.retain(|record| record.codebase != codebase);
        self.rebuild_index();
        removed.into_iter().map(|record| record.key).collect()
    }

    fn rebuild_index(&mut self) {
        self.index = self
            .records
            .iter()
            .enumerate()
            .map(|(index, record)| (record.key.clone(), index))
            .collect();
        let mut multicast: HashMap<String, Vec<String>> = HashMap::new();
        let mut eventarc: HashMap<String, Vec<EventarcSubscription>> = HashMap::new();
        for record in &self.records {
            if record.ignored.is_some() {
                continue;
            }
            for key in multicast_keys(&record.definition, &self.project) {
                multicast.entry(key).or_default().push(record.key.clone());
            }
            if let Some(subscription) =
                eventarc_subscription(&record.definition, &record.key, &self.project)
            {
                eventarc
                    .entry(format!(
                        "{}-{}",
                        subscription.event_type, subscription.channel
                    ))
                    .or_default()
                    .push(subscription);
            }
        }
        self.multicast = multicast;
        self.eventarc = eventarc;
        self.blocking = self.derive_blocking();
    }

    fn derive_blocking(&self) -> BlockingConfig {
        let mut config = BlockingConfig::default();
        for record in &self.records {
            if !record.enabled || record.ignored.is_some() {
                continue;
            }
            let Some(blocking) = record.definition.blocking_trigger() else {
                continue;
            };
            let event_type = blocking
                .get("eventType")
                .and_then(Value::as_str)
                .unwrap_or("");
            let options = blocking.get("options").and_then(Value::as_object);
            let flag = |name: &str| {
                options
                    .and_then(|map| map.get(name))
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
            };
            match event_type {
                "providers/cloud.auth/eventTypes/user.beforeCreate" => {
                    config.before_create.clone_from(&record.url);
                }
                "providers/cloud.auth/eventTypes/user.beforeSignIn" => {
                    config.before_sign_in.clone_from(&record.url);
                }
                _ => continue,
            }
            config.forward_access_token = flag("accessToken");
            config.forward_id_token = flag("idToken");
            config.forward_refresh_token = flag("refreshToken");
        }
        config
    }

    fn unregister_side_effects(record: &Record, project: &str, triggers: &TriggerRegistry) {
        if record.ignored.is_some() {
            return;
        }
        if record.definition.service() == "firestore.googleapis.com" {
            if record.definition.platform() == "gcfv2" {
                triggers.remove_v2(project, &record.key);
            } else {
                triggers.remove_v1(project, &record.key);
            }
        }
    }

    /// Registers definitions for a codebase (`loadTriggers` with `force`),
    /// keeping the current generation. Returns one admission per definition,
    /// in order.
    #[allow(clippy::too_many_arguments)]
    pub fn register(
        &mut self,
        codebase: &str,
        extension_instance: Option<&str>,
        definitions: &[Definition],
        project: &str,
        functions_origin: &str,
        triggers: &TriggerRegistry,
        log: &LogSink,
    ) -> Vec<Admission> {
        let mut admissions = Vec::with_capacity(definitions.len());
        for definition in definitions {
            let key = self.key_for(definition);
            let (ignored, url) =
                Self::admit(definition, &key, project, functions_origin, triggers, log);
            let record = Record {
                key: key.clone(),
                definition: definition.clone(),
                codebase: codebase.to_owned(),
                extension_instance: extension_instance.map(str::to_owned),
                enabled: true,
                ignored: ignored.clone(),
                url: url.clone(),
            };
            if let Some(index) = self.index.get(&key).copied() {
                self.records[index] = record;
            } else {
                self.records.push(record);
            }
            admissions.push(Admission { key, ignored, url });
        }
        self.rebuild_index();
        admissions
    }

    fn admit(
        definition: &Definition,
        key: &str,
        project: &str,
        functions_origin: &str,
        triggers: &TriggerRegistry,
        log: &LogSink,
    ) -> (Option<String>, Option<String>) {
        let id = definition.id();
        if definition.https_trigger().is_some() {
            let url = format!(
                "{functions_origin}/{project}/{}/{}",
                definition.region(),
                definition.name()
            );
            log.record(LogEvent::new(
                "INFO",
                &format!("functions[{id}]"),
                format!("http function initialized ({url})."),
            ));
            return (None, Some(url));
        }
        if let Some(event) = definition.event_trigger() {
            let service = definition.service();
            let service_name = short_service_name(&service);
            match service.as_str() {
                "firestore.googleapis.com" => {
                    let registered = if definition.platform() == "gcfv2" {
                        let bundle = v2_firestore_bundle(event);
                        bundle.and_then(|bundle| {
                            triggers
                                .register_v2(project, key, &bundle)
                                .map_err(|error| error.to_string())
                        })
                    } else {
                        let mut bundle = Map::new();
                        let mut trigger = event.clone();
                        trigger.insert("service".to_owned(), Value::String(service.clone()));
                        bundle.insert("eventTrigger".to_owned(), Value::Object(trigger));
                        triggers
                            .register_v1(project, key, &Value::Object(bundle))
                            .map_err(|error| error.to_string())
                    };
                    match registered {
                        Ok(()) => {
                            log.record(LogEvent::new(
                                "INFO",
                                &format!("functions[{id}]"),
                                "firestore function initialized.".to_owned(),
                            ));
                            (None, None)
                        }
                        Err(error) => {
                            log.warn(format!("Error adding firestore function: {error}"));
                            (
                                Some(format!("firestore trigger registration failed: {error}")),
                                None,
                            )
                        }
                    }
                }
                "pubsub.googleapis.com"
                | "firebaseauth.googleapis.com"
                | "storage.googleapis.com"
                | "eventarc.googleapis.com" => {
                    log.record(LogEvent::new(
                        "INFO",
                        &format!("functions[{id}]"),
                        format!("{service_name} function initialized."),
                    ));
                    (None, None)
                }
                other => {
                    let reason = format!(
                        "function ignored because the {service_name} emulator does not exist or is not running."
                    );
                    log.record(LogEvent::new(
                        "INFO",
                        &format!("functions[{id}]"),
                        reason.clone(),
                    ));
                    let _ = other;
                    (Some(reason), None)
                }
            }
        } else if definition.blocking_trigger().is_some() {
            let event_type = definition
                .blocking_trigger()
                .and_then(|blocking| blocking.get("eventType"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let url = format!(
                "{functions_origin}/{project}/{}/{}",
                definition.region(),
                definition.name()
            );
            if matches!(
                event_type,
                "providers/cloud.auth/eventTypes/user.beforeCreate"
                    | "providers/cloud.auth/eventTypes/user.beforeSignIn"
            ) {
                log.record(LogEvent::new(
                    "INFO",
                    &format!("functions[{id}]"),
                    format!("{event_type} function initialized ({url})."),
                ));
                (None, Some(url))
            } else {
                let reason = format!(
                    "function ignored because the {event_type} emulator does not exist or is not running."
                );
                log.record(LogEvent::new(
                    "INFO",
                    &format!("functions[{id}]"),
                    reason.clone(),
                ));
                (Some(reason), Some(url))
            }
        } else {
            log.warn(format!(
                "Unsupported function type on {}. Expected either an httpsTrigger, eventTrigger, or blockingTrigger.",
                definition.name()
            ));
            let reason =
                "function ignored because the unknown emulator does not exist or is not running."
                    .to_owned();
            log.record(LogEvent::new(
                "INFO",
                &format!("functions[{id}]"),
                reason.clone(),
            ));
            (Some(reason), None)
        }
    }

    /// `disableBackgroundTriggers`: every enabled event record is disabled.
    pub fn disable_background(&mut self, log: &LogSink) {
        for record in &mut self.records {
            if record.definition.event_trigger().is_some() && record.enabled {
                log.record(LogEvent::new(
                    "INFO",
                    &format!("functions[{}]", record.definition.entry_point()),
                    "function temporarily disabled.".to_owned(),
                ));
                record.enabled = false;
            }
        }
        self.rebuild_index();
    }

    /// `reloadTriggers`: bumps the generation and returns the definitions that
    /// need registering again (those without an enabled record), grouped by
    /// codebase in table order.
    pub fn begin_reload(&mut self) -> Vec<(String, Option<String>, Definition)> {
        self.generation += 1;
        let mut pending = Vec::new();
        for record in &self.records {
            let has_enabled_match = self.records.iter().any(|candidate| {
                candidate.enabled
                    && candidate.definition.entry_point() == record.definition.entry_point()
                    && candidate.definition.json().get("eventTrigger")
                        == record.definition.json().get("eventTrigger")
                    && candidate.codebase == record.codebase
            });
            if !has_enabled_match
                && !pending.iter().any(
                    |(codebase, _, definition): &(String, Option<String>, Definition)| {
                        codebase == &record.codebase && definition == &record.definition
                    },
                )
            {
                pending.push((
                    record.codebase.clone(),
                    record.extension_instance.clone(),
                    record.definition.clone(),
                ));
            }
        }
        pending
    }

    /// Whether any delivered record is enabled for the given key.
    #[must_use]
    pub fn is_enabled(&self, key: &str) -> Option<bool> {
        self.get(key).map(|record| record.enabled)
    }
}

fn short_service_name(service: &str) -> &'static str {
    match service {
        "firestore.googleapis.com" => "firestore",
        "pubsub.googleapis.com" => "pubsub",
        "firebaseauth.googleapis.com" => "auth",
        "storage.googleapis.com" => "storage",
        "eventarc.googleapis.com" => "eventarc",
        "firebasedatabase.googleapis.com" => "database",
        "firebasealerts.googleapis.com" => "firebasealerts",
        "cloudtasks.googleapis.com" => "tasks",
        _ => "unknown",
    }
}

/// `getV2FirestoreAttributes`.
fn v2_firestore_bundle(event: &Map<String, Value>) -> Result<Value, String> {
    let filters = event.get("eventFilters").and_then(Value::as_object);
    let patterns = event
        .get("eventFilterPathPatterns")
        .and_then(Value::as_object);
    let database = filters
        .and_then(|map| map.get("database"))
        .and_then(Value::as_str)
        .ok_or_else(|| "A database must be supplied for event trigger".to_owned())?;
    let namespace = filters
        .and_then(|map| map.get("namespace"))
        .and_then(Value::as_str)
        .ok_or_else(|| "A namespace must be supplied for event trigger".to_owned())?;
    let (document, match_type) = if let Some(document) = patterns
        .and_then(|map| map.get("document"))
        .and_then(Value::as_str)
    {
        (document, "PATH_PATTERN")
    } else if let Some(document) = filters
        .and_then(|map| map.get("document"))
        .and_then(Value::as_str)
    {
        (document, "EXACT")
    } else {
        return Err("A document must be supplied.".to_owned());
    };
    Ok(json!({
        "eventType": event.get("eventType").cloned().unwrap_or(Value::Null),
        "database": database,
        "namespace": namespace,
        "document": {"value": document, "matchType": match_type},
    }))
}

/// Multicast keys an Auth or Storage definition subscribes to
/// (`addAuthTrigger`, `addStorageTrigger`).
fn multicast_keys(definition: &Definition, project: &str) -> Vec<String> {
    let Some(event) = definition.event_trigger() else {
        return Vec::new();
    };
    let event_type = event.get("eventType").and_then(Value::as_str).unwrap_or("");
    match definition.service().as_str() {
        "firebaseauth.googleapis.com" => vec![format!("{project}:{event_type}")],
        "storage.googleapis.com" => {
            let resource = event.get("resource").and_then(Value::as_str).unwrap_or("");
            let bucket = resource
                .strip_prefix("projects/_/buckets/")
                .map_or(resource, |rest| rest.split('/').next().unwrap_or(rest));
            vec![format!("{project}:{event_type}:{bucket}")]
        }
        _ => Vec::new(),
    }
}

fn eventarc_subscription(
    definition: &Definition,
    key: &str,
    project: &str,
) -> Option<EventarcSubscription> {
    let event = definition.event_trigger()?;
    let channel = event.get("channel").and_then(Value::as_str)?;
    let filters = event
        .get("eventFilters")
        .and_then(Value::as_object)
        .map(|map| {
            map.iter()
                .filter_map(|(name, value)| {
                    value.as_str().map(|text| (name.clone(), text.to_owned()))
                })
                .collect()
        })
        .unwrap_or_default();
    Some(EventarcSubscription {
        project: project.to_owned(),
        trigger_key: key.to_owned(),
        event_type: event
            .get("eventType")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned(),
        channel: channel.to_owned(),
        filters,
    })
}

/// Whether the delivered-services list covers a service (reporting only).
#[must_use]
pub fn delivered_service(service: &str) -> bool {
    DELIVERED_SERVICES.contains(&service)
}
