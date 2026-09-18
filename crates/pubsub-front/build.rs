use std::error::Error;

use prost::Message as _;

const SERVICES: [&str; 3] = [
    "proto/google/pubsub/v1/pubsub.proto",
    "proto/google/pubsub/v1/schema.proto",
    "proto/google/iam/v1/iam_policy.proto",
];

fn main() -> Result<(), Box<dyn Error>> {
    println!("cargo:rerun-if-changed=proto");

    let descriptors = protox::compile(SERVICES, ["proto"])?;
    tonic_prost_build::configure()
        .build_client(true)
        .build_server(true)
        // Every map (attributes, labels, tags) keeps a stable order on the
        // wire and in JSON, like the official emulator's sorted maps.
        .btree_map(".")
        .compile_well_known_types(true)
        .extern_path(".google.protobuf.Any", "::pbjson_types::Any")
        .extern_path(".google.protobuf.Duration", "::pbjson_types::Duration")
        .extern_path(".google.protobuf.Empty", "::pbjson_types::Empty")
        .extern_path(".google.protobuf.FieldMask", "::pbjson_types::FieldMask")
        .extern_path(".google.protobuf.Struct", "::pbjson_types::Struct")
        .extern_path(".google.protobuf.Timestamp", "::pbjson_types::Timestamp")
        .compile_fds(descriptors.clone())?;
    pbjson_build::Builder::new()
        .register_descriptors(&descriptors.encode_to_vec())?
        .btree_map([".google.pubsub.v1", ".google.iam.v1", ".google.type"])
        .extern_path(".google.protobuf.Any", "::pbjson_types::Any")
        .extern_path(".google.protobuf.Duration", "::pbjson_types::Duration")
        .extern_path(".google.protobuf.Empty", "::pbjson_types::Empty")
        .extern_path(".google.protobuf.FieldMask", "::pbjson_types::FieldMask")
        .extern_path(".google.protobuf.Struct", "::pbjson_types::Struct")
        .extern_path(".google.protobuf.Timestamp", "::pbjson_types::Timestamp")
        .build(&[".google.pubsub.v1", ".google.iam.v1", ".google.type"])?;

    Ok(())
}
