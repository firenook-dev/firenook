# Preview compatibility

Firenook is not yet a universal Firebase Emulator Suite replacement.

| Surface | Current preview | Not claimed |
| --- | --- | --- |
| Firestore | Native/Admin and browser SDK paths, rules, realtime targets, disk/WAL, official-format import/export, named databases with per-database rules | Every production feature, edition or arbitrary client version |
| Auth | Every operation the official Auth emulator implements (61), replayed from a 1068-step oracle corpus and an 18-step custom-claims-limit corpus with parity: password, anonymous, custom token, email link, phone, fake IdP (Google/Apple/SAML/OIDC-shaped credentials), account update/delete, OOB and phone codes, session cookies, tenants, SMS MFA, passkeys, Admin batch create/get/delete/query, project and tenant configuration, emulator inspection routes, legacy `relyingparty` routes, blocking functions and lifecycle triggers, official-format export/import, the local popup/redirect helper pages | Anything the official emulator itself answers with 501 (IdP/SAML/OIDC provider configuration, `initializeAuth`, IAM on tenants, Game Center, reCAPTCHA enforcement, TOTP MFA); real email/SMS delivery; production token verification |
| Storage | Captured Firebase/GCS paths, metadata, gzip, pagination, single-file and multi-bucket rules, export/import; Security Rules evaluated natively (no Java) with the recorded official request model and production expression semantics, including `firestore.get`/`exists` and `/internal/setRules` | All GCS features; the official emulator's prefix-template `list` matching and missing `request.method` (production semantics are followed and recorded as divergences) |
| Functions | Firenook runtime with one Node worker per codebase: discovery through the pinned SDK control API or `functions.yaml`, HTTP/callable/streaming, Firestore/Storage/Auth/Pub/Sub/Eventarc/schedule/task-queue triggers, blocking Auth functions, dotenv/secret files, reload, background controls, `--inspect-functions`; every invocation kept with its request or event, its answer, its timing and the log lines it printed (the last 2,000, at most 64 MiB) | Pure Rust JavaScript execution, a network sandbox, Python/Dart runtimes, Secret Manager access, Firebase Alerts delivery (an alert function is listed and receives nothing), request headers named `x-firenook-*` (the engine's own, removed before a function sees them) |
| Extensions | Resolved and run by Firenook with the recorded parameter, spec and trigger semantics from local, vendored, cached or registry sources; an instance whose triggers need a service the suite does not emulate is left out and named; an instance's parameter files are watched and a change reloads that instance | Dynamic (in-code) extensions, lifecycle tasks (onInstall/onUpdate/onConfigure: an extension's task-queue functions are not delivered, as on the official emulator), Secret Manager access |
| Eventarc | Trigger registration, `getTriggers` and `publishEvents` on the `google` and named channels, delivery to `onCustomEventPublished` handlers by event type and filters; every event kept with what each subscription did, including events that could not be read or that nothing listens for (the last 1,000, at most 16 MiB) | Firebase Alerts on the native channel; publishing through the Admin SDK from function or extension code without a credential of its own (workers get a synthetic credential that Google's token endpoint refuses) |
| Cloud Tasks | The official emulator's four routes (queue registration, enqueue, delete, `/queueStats`), a queue per `onTaskDispatched` export, and its dispatcher (token bucket, dispatch slots, the `X-CloudTasks-*` headers, the retry ladder and backoff formula, execution count on non-5xx failures, `dispatchDeadline`), replayed from a 61-step oracle corpus with parity; the Admin SDK's `taskQueue().enqueue()`/`delete()` under `CLOUD_TASKS_EMULATOR_HOST` | Everything the official emulator does not do either: `scheduleTime` as a delay, OIDC tokens, queue pause/resume/purge, task listing, the Cloud Tasks v2 API surface, persistence, a UI tab |
| Pub/Sub | Every RPC of the official emulator (`google.pubsub.v1` Publisher, Subscriber, SchemaService and `google.iam.v1` IAMPolicy) over gRPC and HTTP/JSON on one port, replayed from a 916-step oracle corpus with parity: topics, publish, subscriptions with ack deadlines, redelivery, dead-letter and retry policies, ordering keys, filters, retention, seek, snapshots, pull, streaming pull, push delivery with retries, Avro schemas with revisions and topic binding, function delivery through `emulator-sub-<topic>` | Protocol Buffer schemas, IAM, `detachSubscription` and `updateSnapshot` (the official emulator answers 501 too); BigQuery/Cloud Storage/Bigtable export subscriptions; persistence across restarts (the official emulator has none) |
| Hub/UI | Captured discovery/control/static/logging paths; the hub lists only the services that run | Complete Emulator UI parity (the official UI asset is still served; an own UI is the next release) |
| Other services | None claimed | Realtime Database, Hosting, App Hosting, Data Connect and universal extensions (a `firebase.json` that configures them is accepted; those emulators are skipped with a warning) |
| CLI | `init` / `init --adopt`, `use`, `target:apply` / `target:clear`, `setup`, `doctor`, `emulators:start` / `emulators:exec` (any service subset, `--only`, `--ui`, `--debug`, the official compatibility flags, a shell-string script), `emulators:export` on a running suite, `firestore:delete`, `functions:invoke` for HTTPS/callable calls and background events, `ext:vendor`, `mcp`, state/resume | `functions:shell` (Firenook never starts a second Functions runtime), cloud deploy, login, and the official terminal launch experience (banner and status table) |
| Configuration | `firebase.json` service derivation as the official `filterEmulatorTargets`, `storage` object/array/absent, `firestore` object or database array, any project id (demo or real, with the official banners), any listen host (loopback connect addresses for a wildcard bind, one warning for a public bind), `emulators.ui.enabled: false`, `emulators.singleProjectMode`, per-service ports incl. Eventarc/Tasks/logging/WebSocket, a missing `.firebaserc` | Per-service listen hosts that differ from the suite host |

Since `0.1.0-next.4` the published engine includes the Firestore
Requests/rule-evaluation tracing and rules-coverage tooling whose
[scoped source qualification](support/phase-bcd-qualification.md) preceded it;
`firenook emulators:start` records bounded diagnostics by default and
`--no-diagnostics` disables them. Since `0.1.0-next.7` the Eventarc port
serves trigger registration, `getTriggers` and `publishEvents` on the `google`
and named channels and delivers to `onCustomEventPublished` handlers. Since
`0.1.0-next.9` the Tasks port is the Cloud Tasks emulator described above.

Functions workers print what they printed before: the terminal and the
logging feed carry the same lines, while the console also keeps each line
with the invocation that printed it. Request headers whose names start with
`x-firenook-` are the engine's control headers and are removed before a
function sees them, from `headers` and `rawHeaders` alike; an answer carries
`x-firenook-execution` only when its request asked for it. A worker ends
itself within a second of its runtime going away, so an engine killed
outright leaves no Node process behind.

While the suite runs, each Extensions instance's parameter files
(`extensions/<id>.env`, `extensions/<id>.env.<suffix>` and
`extensions/<id>.secret.local`) are watched: a change reloads that instance
in place, and a change that does not load is logged with its error. Writes
the console makes itself reload once, and are put back when the new values
do not load.

Firenook serves every Firestore database named on the wire
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

Each configured Firestore rules file is watched while the suite runs and
reloaded on change, as the official CLI watches the configured rules file
(chokidar) and re-uploads it. One second after the last change in a burst the
file is compiled and installed for the database that configures it. A file
identical to the rules in force is left alone (the console's own save lands
there), and a file that does not compile leaves the rules in force serving
requests: the diagnostics are logged and the console shows them beside the
file.

Storage rules files are watched and reloaded on change the same way, whether
or not Firestore runs: a `storage: { rules }` file governs every bucket, and
each `storage` target's file governs its bucket. A file that does not compile
leaves the previous rules in force, as the official watcher keeps its previous
ruleset. (`/internal/setRules` keeps the official semantics: a body that does
not compile leaves no ruleset until the next valid one.)

Storage events are sent only when the suite runs Functions, as the official
emulator dispatches them only then; with `--only storage` an upload, a
metadata change or a delete queues nothing.

Resumable upload sessions idle for seven days are removed with their staged
bytes (production expires a resumable session URI after a week; the official
emulator keeps unfinished sessions for ever).

The console works on Storage through its own routes, never through the
protocol, and a few of its behaviours have no counterpart in the official
emulator. It reads and writes as Admin in a bucket no rules govern, where
the emulator refuses every request, the Admin SDK's included, and the page
says so. A zero-byte `folder/` marker object is shown as an empty folder
(the protocol still lists it). Its uploads mint a download token and send
the finalize event as an upload through the SDK does (a text edited in
place as Admin keeps the file's tokens); a copy mints its own token, and a
move is one operation that sends the events a copy and then a delete would
send.
Bulk work runs in batches of 200 and waits between batches while the
Functions emulator has more than 10,000 requests queued. A client
identity's console listing read again within a minute (a refresh, a live
update) is recorded as one rules decision, not one per read.

Auth's action links (password reset, email verification, email sign-in and
email change) always carry the Auth emulator's own address, as the
registered official emulator's do, including for a code requested through
the console. Custom claims are held to the 1,000 limit as the official
emulator counts them: JavaScript string length (UTF-16 code units) of the
compact JSON, so `é` counts one and an emoji two. Auth state is written to
`auth-state.json` after the response instead of before it: a change reaches
the file within 250 ms (four times the last encode when that is longer,
which only a very large state takes), encoded off the request path, while
the native checkpoint, an import and a clean stop write it at once. A tool
that reads the file while the suite runs can see a state that much older.

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
