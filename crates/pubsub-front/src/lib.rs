//! Pub/Sub emulator for the fireside emulator suite: the `google.pubsub.v1`
//! Publisher, Subscriber and `SchemaService` services and the `google.iam.v1`
//! policy service over gRPC and HTTP/JSON on one port, with a broker that
//! answers like the official `cloud-pubsub-emulator` (recorded corpus in
//! `conformance/fixtures/pubsub-v1`), function delivery through the
//! Functions host and wall-clock `onSchedule` ticks.

#![forbid(unsafe_code)]

pub mod avro;
pub mod broker;
pub mod error;
pub mod filter;
pub mod functions;
pub mod grpc;
pub mod http;
pub mod names;
pub mod runtime;
pub mod scheduler;

pub use broker::Broker;
pub use error::PubsubError;
pub use functions::ScheduleDefinition;
pub use runtime::PubsubRuntime;
pub use scheduler::{ScheduleError, SchedulerRuntime};

use fireside_functions_bridge::{DispatchQueue, FunctionsInventory, TriggerRegistry};

/// Generated Google API protocol types: the `google.pubsub.v1` services and
/// the `google.iam.v1` policy service, with proto3 JSON serialization.
pub mod google {
    #[allow(clippy::all, clippy::pedantic)]
    pub mod api {
        tonic::include_proto!("google.api");
    }

    pub mod pubsub {
        #[allow(clippy::all, clippy::pedantic)]
        pub mod v1 {
            tonic::include_proto!("google.pubsub.v1");
            include!(concat!(env!("OUT_DIR"), "/google.pubsub.v1.serde.rs"));
        }
    }

    pub mod iam {
        #[allow(clippy::all, clippy::pedantic)]
        pub mod v1 {
            tonic::include_proto!("google.iam.v1");
            include!(concat!(env!("OUT_DIR"), "/google.iam.v1.serde.rs"));
        }
    }

    #[allow(clippy::all, clippy::pedantic)]
    pub mod r#type {
        tonic::include_proto!("google.r#type");
        include!(concat!(env!("OUT_DIR"), "/google.r#type.serde.rs"));
    }
}

/// Builds the runtime for the configured Pub/Sub port.
#[must_use]
pub fn router(
    project: &str,
    inventory: &FunctionsInventory,
    queue: DispatchQueue,
    background: TriggerRegistry,
) -> PubsubRuntime {
    PubsubRuntime::new(project, inventory, queue, background)
}

#[cfg(test)]
mod tests;
