//! Queue registration: the `taskQueueConfig` document the official
//! `createTaskQueueHandler` builds from a request body with `??` defaults,
//! and the numeric view of it the dispatch engine computes with.

use indexmap::IndexMap;
use serde_json::Number;

use crate::json::OrderedJson;

/// The message the official validator returns; its prose describes a
/// different rule than the code applies (`^[A-Za-z0-9-]+$`, at most 100
/// characters), and both are reproduced as they are.
pub const INVALID_QUEUE_ID: &str = "Queue ID must start with a letter followed by up to 62 letters, numbers, hyphens, or underscores and must end with a letter or a number";

/// The message for `rateLimits.maxConcurrentDispatches > 5000`.
pub const OVER_CONCURRENCY_LIMIT: &str = "cannot set maxConcurrentDispatches to a value over 5000";

/// The pending-queue capacity of every queue.
pub const QUEUE_CAPACITY: i64 = 10_000;

/// `validateQueueId`: the code's rule, not the prose of its error message.
#[must_use]
pub fn valid_queue_id(queue: &str) -> bool {
    !queue.is_empty()
        && queue.len() <= 100
        && queue
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

/// `queue:{project}-{location}-{queue}`, the controller's queue key.
#[must_use]
pub fn queue_key(project: &str, location: &str, queue: &str) -> String {
    format!("queue:{project}-{location}-{queue}")
}

/// Why a registration body was rejected.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConfigError {
    /// `maxConcurrentDispatches > 5000` (a 400 with `OVER_CONCURRENCY_LIMIT`).
    OverConcurrencyLimit,
    /// `new Array(maxConcurrentDispatches)` throws (an Express 500 page).
    InvalidArrayLength,
}

/// A registered queue's configuration.
#[derive(Debug, Clone, PartialEq)]
pub struct QueueConfig {
    /// The `taskQueueConfig` document: `retryConfig`, `rateLimits`,
    /// `timeoutSeconds`, `retry`, then `defaultUri` when the body had the key.
    document: OrderedJson,
    /// `retryConfig.maxAttempts` as a number.
    pub max_attempts: f64,
    /// `retryConfig.maxRetrySeconds`; `None` is JSON `null`.
    pub max_retry_seconds: Option<f64>,
    /// `retryConfig.maxBackoffSeconds` as a number.
    pub max_backoff_seconds: f64,
    /// `retryConfig.maxDoublings` as a number.
    pub max_doublings: f64,
    /// `retryConfig.minBackoffSeconds` as a number.
    pub min_backoff_seconds: f64,
    /// The dispatch slot count, `new Array(maxConcurrentDispatches).length`.
    pub slots: usize,
    /// `rateLimits.maxDispatchesPerSecond` as a number.
    pub max_dispatches_per_second: f64,
    /// `defaultUri`: `None` when the body had no key (`undefined`), so an
    /// empty task URL becomes `undefined` and disappears from the echo.
    pub default_uri: Option<OrderedJson>,
}

impl QueueConfig {
    /// Builds the configuration as `createTaskQueueHandler` does; `body` is
    /// the parsed JSON body (an empty object when Express parsed none).
    pub fn from_body(body: &OrderedJson) -> Result<Self, ConfigError> {
        let retry = body.get("retryConfig");
        let limits = body.get("rateLimits");
        let field = |section: Option<&OrderedJson>, key: &str, fallback: OrderedJson| {
            OrderedJson::or_default(section.and_then(|section| section.get(key)), fallback)
        };
        let max_attempts = field(retry, "maxAttempts", integer(3));
        let max_retry_seconds = field(retry, "maxRetrySeconds", OrderedJson::Null);
        let max_backoff_seconds = field(retry, "maxBackoffSeconds", integer(3600));
        let max_doublings = field(retry, "maxDoublings", integer(16));
        let min_backoff_seconds = field(
            retry,
            "minBackoffSeconds",
            OrderedJson::Number(Number::from_f64(0.1).unwrap_or_else(|| Number::from(0))),
        );
        let max_concurrent = field(limits, "maxConcurrentDispatches", integer(1000));
        let max_per_second = field(limits, "maxDispatchesPerSecond", integer(500));
        let timeout_seconds = OrderedJson::or_default(body.get("timeoutSeconds"), integer(10));
        let retry_flag = OrderedJson::or_default(body.get("retry"), OrderedJson::Bool(false));
        let default_uri = body.get("defaultUri").cloned();

        let mut retry_config = IndexMap::new();
        retry_config.insert("maxAttempts".to_owned(), max_attempts.clone());
        retry_config.insert("maxRetrySeconds".to_owned(), max_retry_seconds.clone());
        retry_config.insert("maxBackoffSeconds".to_owned(), max_backoff_seconds.clone());
        retry_config.insert("maxDoublings".to_owned(), max_doublings.clone());
        retry_config.insert("minBackoffSeconds".to_owned(), min_backoff_seconds.clone());
        let mut rate_limits = IndexMap::new();
        rate_limits.insert("maxConcurrentDispatches".to_owned(), max_concurrent.clone());
        rate_limits.insert("maxDispatchesPerSecond".to_owned(), max_per_second.clone());
        let mut document = IndexMap::new();
        document.insert("retryConfig".to_owned(), OrderedJson::Object(retry_config));
        document.insert("rateLimits".to_owned(), OrderedJson::Object(rate_limits));
        document.insert("timeoutSeconds".to_owned(), timeout_seconds);
        document.insert("retry".to_owned(), retry_flag);
        if let Some(uri) = &default_uri {
            document.insert("defaultUri".to_owned(), uri.clone());
        }

        if max_concurrent.js_number() > 5000.0 {
            return Err(ConfigError::OverConcurrencyLimit);
        }
        Ok(Self {
            document: OrderedJson::Object(document),
            max_attempts: max_attempts.js_number(),
            max_retry_seconds: if max_retry_seconds.is_null() {
                None
            } else {
                Some(max_retry_seconds.js_number())
            },
            max_backoff_seconds: max_backoff_seconds.js_number(),
            max_doublings: max_doublings.js_number(),
            min_backoff_seconds: min_backoff_seconds.js_number(),
            slots: array_length(&max_concurrent)?,
            max_dispatches_per_second: max_per_second.js_number(),
            default_uri,
        })
    }

    /// The `taskQueueConfig` document in the official key order.
    #[must_use]
    pub fn document(&self) -> &OrderedJson {
        &self.document
    }

    /// `rateLimits.maxDispatchesPerSecond` as registered (for `maxRate`).
    #[must_use]
    pub fn max_rate(&self) -> OrderedJson {
        self.document
            .get("rateLimits")
            .and_then(|limits| limits.get("maxDispatchesPerSecond"))
            .cloned()
            .unwrap_or(OrderedJson::Null)
    }

    /// `rateLimits.maxConcurrentDispatches` as registered (for `maxConcurrent`).
    #[must_use]
    pub fn max_concurrent(&self) -> OrderedJson {
        self.document
            .get("rateLimits")
            .and_then(|limits| limits.get("maxConcurrentDispatches"))
            .cloned()
            .unwrap_or(OrderedJson::Null)
    }
}

fn integer(value: i64) -> OrderedJson {
    OrderedJson::Number(Number::from(value))
}

/// `new Array(value).fill(null).length`: an integral number in range is the
/// length, any other number throws, and a non-number is a single element.
fn array_length(value: &OrderedJson) -> Result<usize, ConfigError> {
    match value {
        OrderedJson::Number(number) => {
            let length = number.as_f64().unwrap_or(f64::NAN);
            if length.fract() != 0.0 || !(0.0..=5000.0).contains(&length) {
                return Err(ConfigError::InvalidArrayLength);
            }
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            Ok(length as usize)
        }
        _ => Ok(1),
    }
}
