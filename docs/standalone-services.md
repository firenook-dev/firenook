# One service on its own

[Docs](README.md) · One service on its own

Pub/Sub and Auth can run without the rest of the suite, for tests that need only one of them.

## Pub/Sub

```sh
firenook native pubsub --project-id demo-my-app --port 8085
PUBSUB_EMULATOR_HOST=127.0.0.1:8085 node ./publisher.mjs
```

`firenook native pubsub` serves the same Pub/Sub implementation the suite
runs — the `google.pubsub.v1` services and `google.iam.v1` policy over gRPC
and HTTP/JSON on one port, so the Google client libraries connect with
`PUBSUB_EMULATOR_HOST` — without Firestore, Storage or Functions. The
conformance replay drives this command.

## Auth

```sh
firenook native auth --project-id demo-my-app --port 9099                 # the Auth service alone, in memory
firenook native auth --project-id demo-my-app --state-file ./auth.json    # persisted accounts, codes and config
```

`firenook native auth` serves the same Auth implementation the suite runs
(every operation of the official Auth emulator, the popup/redirect helper
pages, `/emulator/openapi.json`) without Firestore, Storage or Functions. Add
`--functions-origin http://host:port` to deliver `user.create`/`user.delete`
multicasts to a Functions host; blocking functions come from the project's
configuration. The conformance replay drives this command.
