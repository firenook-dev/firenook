# Preview compatibility

Fireside is not yet a universal Firebase Emulator Suite replacement.

| Surface | Current preview | Not claimed |
| --- | --- | --- |
| Firestore | Native/Admin and browser SDK paths, rules, realtime targets, disk/WAL, official-format import/export, named databases with per-database rules | Every production feature, edition or arbitrary client version |
| Auth | Every operation the official Auth emulator implements (61), replayed from a 1068-step oracle corpus with parity: password, anonymous, custom token, email link, phone, fake IdP (Google/Apple/SAML/OIDC-shaped credentials), account update/delete, OOB and phone codes, session cookies, tenants, SMS MFA, passkeys, Admin batch create/get/delete/query, project and tenant configuration, emulator inspection routes, legacy `relyingparty` routes, blocking functions and lifecycle triggers, official-format export/import, the local popup/redirect helper pages | Anything the official emulator itself answers with 501 (IdP/SAML/OIDC provider configuration, `initializeAuth`, IAM on tenants, Game Center, reCAPTCHA enforcement, TOTP MFA); real email/SMS delivery; production token verification |
| Storage | Captured Firebase/GCS paths, metadata, gzip, pagination, single-file and multi-bucket rules, export/import; Security Rules evaluated natively (no Java) with the recorded official request model and production expression semantics, including `firestore.get`/`exists` and `/internal/setRules` | All GCS features; the official emulator's prefix-template `list` matching and missing `request.method` (production semantics are followed and recorded as divergences) |
| Functions | Fireside runtime with one Node worker per codebase: discovery through the pinned SDK control API or `functions.yaml`, HTTP/callable/streaming, Firestore/Storage/Auth/Pub/Sub/Eventarc/schedule/task-queue triggers, blocking Auth functions, dotenv/secret files, reload, background controls, `--inspect-functions`; Extensions resolved and run by Fireside with the recorded parameter, spec and trigger semantics from local, vendored, cached or registry sources | Pure Rust JavaScript execution, a network sandbox, Python/Dart runtimes, dynamic (in-code) extensions, Secret Manager access |
| Cloud Tasks | The official emulator's four routes (queue registration, enqueue, delete, `/queueStats`), a queue per `onTaskDispatched` export, and its dispatcher (token bucket, dispatch slots, the `X-CloudTasks-*` headers, the retry ladder and backoff formula, execution count on non-5xx failures, `dispatchDeadline`), replayed from a 61-step oracle corpus with parity; the Admin SDK's `taskQueue().enqueue()`/`delete()` under `CLOUD_TASKS_EMULATOR_HOST` | Everything the official emulator does not do either: `scheduleTime` as a delay, OIDC tokens, queue pause/resume/purge, task listing, the Cloud Tasks v2 API surface, persistence, a UI tab |
| Pub/Sub | Every RPC of the official emulator (`google.pubsub.v1` Publisher, Subscriber, SchemaService and `google.iam.v1` IAMPolicy) over gRPC and HTTP/JSON on one port, replayed from a 916-step oracle corpus with parity: topics, publish, subscriptions with ack deadlines, redelivery, dead-letter and retry policies, ordering keys, filters, retention, seek, snapshots, pull, streaming pull, push delivery with retries, Avro schemas with revisions and topic binding, function delivery through `emulator-sub-<topic>` | Protocol Buffer schemas, IAM, `detachSubscription` and `updateSnapshot` (the official emulator answers 501 too); BigQuery/Cloud Storage/Bigtable export subscriptions; persistence across restarts (the official emulator has none) |
| Hub/UI | Captured discovery/control/static/logging paths; the hub lists only the services that run | Complete Emulator UI parity (the official UI asset is still served; an own UI is the next release) |
| Other services | None claimed | Realtime Database, Hosting, App Hosting, Data Connect and universal extensions (a `firebase.json` that configures them is accepted; those emulators are skipped with a warning) |
| CLI | `init` / `init --adopt`, `use`, `target:apply` / `target:clear`, `setup`, `doctor`, `emulators:start` / `emulators:exec` (any service subset, `--only`, `--ui`, `--debug`, the official compatibility flags, a shell-string script), `emulators:export` on a running suite, `firestore:delete`, `functions:invoke` for HTTPS/callable calls and background events, `ext:vendor`, `mcp`, state/resume | `functions:shell` (Fireside never starts a second Functions runtime), cloud deploy, login, and the official terminal launch experience (banner and status table) |
| Configuration | `firebase.json` service derivation as the official `filterEmulatorTargets`, `storage` object/array/absent, `firestore` object or database array, any project id (demo or real, with the official banners), any listen host (loopback connect addresses for a wildcard bind, one warning for a public bind), `emulators.ui.enabled: false`, `emulators.singleProjectMode`, per-service ports incl. Eventarc/Tasks/logging/WebSocket, a missing `.firebaserc` | Per-service listen hosts that differ from the suite host |

Since `0.1.0-next.4` the published engine includes the Firestore
Requests/rule-evaluation tracing and rules-coverage tooling whose
[scoped source qualification](support/phase-bcd-qualification.md) preceded it;
`fireside emulators:start` records bounded diagnostics by default and
`--no-diagnostics` disables them. Since `0.1.0-next.7` the Eventarc port
serves trigger registration, `getTriggers` and `publishEvents` on the `google`
and named channels and delivers to `onCustomEventPublished` handlers. Since
`0.1.0-next.9` the Tasks port is the Cloud Tasks emulator described above.

Fireside serves every Firestore database named on the wire
(`projects/{project}/databases/{database}`), applies rules per database and
exports every database of the project into the one `firestore_export`, which
an import restores in full. A `firebase.json` `firestore` array lists one
entry per database (`database`, `rules`, `indexes`; an entry without
`database` is `(default)`, and a project may list only named databases); each
entry's rules govern that database alone until a project-wide
`PUT /emulator/v1/projects/{project}:securityRules` hot reload, which replaces
the project's rules for every database as it does on the official emulator. The official emulator refuses more than one
database (`Cloud Firestore Emulator does not support multiple databases yet.`)
and then loads no rules at all.

The package supports only its enumerated native targets after their exact
candidate checks pass. Linux musl, Windows ARM64/32-bit, network-filesystem
durability and Windows power-loss recovery are not qualified.

Use synthetic demo data, loopback interfaces and a representative private
consumer test before adoption. A real project id never makes the suite contact
Firebase (every Functions worker gets the emulator hosts and no Google
credentials), but user code with explicit credentials can still reach the
real project; a non-loopback listen host exposes the unauthenticated emulators
to the network. Consult the CLI guide for the configuration contract. Performance depends on workload and hardware; source separation
is not evidence of faster execution or lower memory.
