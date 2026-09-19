//! Cloud Tasks emulator for the fireside emulator suite.
//!
//! The oracle is firebase-tools 15.22.0's `TasksEmulator` (its Express app
//! in `tasksEmulator.js` and the `TaskQueue`/`Queue` engine in
//! `taskQueue.js`), recorded in the `tasks-v1` corpus at
//! `conformance/fixtures/tasks-v1/emulator-programs.json`: queue
//! registration with the `??` defaults, enqueue/delete over the wire and
//! through the Admin SDK, the `X-CloudTasks-*` headers every dispatch
//! carries, the retry ladder, the dispatch deadline, concurrency and rate
//! limits, and `/queueStats`.
//!
//! The official quirks are reproduced on purpose, because clients and the
//! corpus observe them:
//!
//! - an auto-generated task name starts with a slash
//!   (`/projects/…/tasks/<random>`), while `DELETE` builds the name without
//!   one, so a generated name can never be deleted;
//! - `maxAttempts` is off by one: a queue with `maxAttempts: 3` runs a
//!   failing task four times (the check is `currentAttempt > maxAttempts`
//!   after the attempt ran), and `maxRetrySeconds` keeps retrying past
//!   `maxAttempts` until its clock runs out;
//! - `numberOfTasks` counts pending tasks with a signed counter that a
//!   delete always decrements: deleting a task that was already dispatched
//!   succeeds (its name is still in the node map), the counter goes to
//!   `-1`, and the task keeps running; a second delete is a 404, and the
//!   name can never be enqueued again (`queuedIds` never shrinks);
//! - `X-CloudTasks-TaskETA` is `Date.now()` (an integer of milliseconds)
//!   unless the task carries a `scheduleTime`, whose string is sent as is;
//!   a schedule time never delays a task;
//! - `runningTasks` in `/queueStats` is the dispatch slot count, that is
//!   `maxConcurrentDispatches`, not the number of running tasks;
//! - `tasksAdded` and `failedTasks` are five-minute counts divided by five
//!   (`0.2`, `1.6`), `completedLastMin` a one-minute count;
//! - a 5xx response leaves `executionCount` alone while any other non-2xx
//!   increments it, and `X-CloudTasks-TaskPreviousResponse` is sent only
//!   after a response (an aborted or failed request sets none);
//! - the queue id validator applies `^[A-Za-z0-9-]+$` (at most 100
//!   characters) while its error message describes another rule;
//! - re-registering a key replaces the queue and drops its pending tasks;
//!   `timeoutSeconds` and `retry` are stored and never used; any project id
//!   is accepted.
//!
//! What the official engine does with its linked list after removing a
//! dequeued node (it can lose pending tasks) is not reproduced: a removed
//! task that already left the pending queue simply keeps running.

#![forbid(unsafe_code)]

pub mod config;
pub mod functions;
mod http;
pub mod json;
pub mod queue;
pub mod runtime;

pub use config::{QueueConfig, queue_key};
pub use functions::{DiscoveredQueue, discover};
pub use json::OrderedJson;
pub use queue::{Outcome, RunRequest, Statistics, TaskQueue, TaskRecord};
pub use runtime::{EnqueueError, LogSink, RemoveError, TasksRuntime};

#[cfg(test)]
mod tests;
