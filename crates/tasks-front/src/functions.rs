//! Queue discovery: every function of a `/backends` inventory that carries a
//! `taskQueueTrigger` is registered the way the official Functions emulator
//! registers it, a `POST` of `{...taskQueueTrigger, defaultUri}` with the
//! function's HTTP URL.

use firenook_functions_bridge::FunctionsInventory;

use crate::config::{ConfigError, QueueConfig, queue_key, valid_queue_id};
use crate::json::OrderedJson;

/// One queue an inventory declares.
#[derive(Debug, Clone, PartialEq)]
pub struct DiscoveredQueue {
    /// `queue:{project}-{region}-{name}`.
    pub key: String,
    /// The function's exported name, the queue id.
    pub name: String,
    /// The registration body: the trigger's keys, then `defaultUri`.
    pub registration: OrderedJson,
}

impl DiscoveredQueue {
    /// The configuration the registration yields, or why the official
    /// Tasks emulator would have refused it (`Error adding Task Queue
    /// function`).
    pub fn config(&self) -> Result<QueueConfig, String> {
        if !valid_queue_id(&self.name) {
            return Err(crate::config::INVALID_QUEUE_ID.to_owned());
        }
        QueueConfig::from_body(&self.registration).map_err(|error| match error {
            ConfigError::OverConcurrencyLimit => crate::config::OVER_CONCURRENCY_LIMIT.to_owned(),
            ConfigError::InvalidArrayLength => "RangeError: Invalid array length".to_owned(),
        })
    }
}

/// The queues of `inventory`, in inventory order; `functions_origin` is
/// the Functions host (`http://host:port`, no trailing slash).
#[must_use]
pub fn discover(
    project: &str,
    inventory: &FunctionsInventory,
    functions_origin: &str,
) -> Vec<DiscoveredQueue> {
    let origin = functions_origin.trim_end_matches('/');
    inventory
        .functions()
        .filter_map(|function| {
            let trigger = function.task_queue_trigger.as_ref()?;
            let mut registration = match OrderedJson::from_value(trigger) {
                OrderedJson::Object(map) => map,
                _ => indexmap::IndexMap::new(),
            };
            registration.insert(
                "defaultUri".to_owned(),
                OrderedJson::String(format!(
                    "{origin}/{project}/{}/{}",
                    function.region, function.name
                )),
            );
            Some(DiscoveredQueue {
                key: queue_key(project, &function.region, &function.name),
                name: function.name.clone(),
                registration: OrderedJson::Object(registration),
            })
        })
        .collect()
}
