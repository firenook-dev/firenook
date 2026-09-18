# Google API protocol provenance

The `.proto` files in this directory are the minimal transitive source graph
for `google/pubsub/v1/pubsub.proto`, `google/pubsub/v1/schema.proto` and
`google/iam/v1/iam_policy.proto` (the services the official Pub/Sub emulator
serves). They were copied without modification from:

- repository: `https://github.com/googleapis/googleapis`
- commit: `de3c0d362adbaafc7a0cd1254a8cd49a528505ee`
- retrieved: 2026-09-18
- license: Apache License 2.0; see `LICENSE` in this directory

`build.rs` compiles these definitions with protox, tonic-prost-build and
pbjson-build (for the HTTP/JSON transcoding). The generated Rust exists only
in Cargo's build output and is not checked in.
