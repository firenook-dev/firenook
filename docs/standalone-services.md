# One service on its own

[Docs](README.md) · One service on its own

Firestore, Pub/Sub and Auth can run without the rest of the suite, for tests that need only one of them.

## Firestore

```sh
firenook native firestore --project_id demo-my-app --port 8080                          # in memory
firenook native firestore --project_id demo-my-app --rules firestore.rules --data-dir ./data   # rules, data kept on disk
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node ./app.mjs
```

`firenook native firestore` serves the same Firestore implementation the
suite runs — gRPC for the server SDKs, REST, and the WebChannel the web SDK
uses, on one port — without Auth, Storage or Functions. It takes the flags of
the official Firestore emulator: `--host`, `--port`, `--project_id`,
`--rules`, `--seed_from_export DIR` (an official export, imported at
start), `--single_project_mode`, `--websocket_port` (the rules' request
stream) and `--functions_emulator HOST:PORT` (Firestore triggers delivered
to a Functions host). The data is in memory unless `--data-dir DIR` keeps it
on disk (with a write-ahead journal; `--no-wal`, `--durability
write-behind|per-commit` and `--redb-cache-size BYTES` tune it).
`--database-edition enterprise` serves an Enterprise-edition database,
`--strict-indexes` refuses, as production does, a query that needs an index
the current directory's `firestore.indexes.json` does not declare, and
`--worker-threads N` (four at most by default) sizes the runtime. The
conformance replay drives this command.

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
