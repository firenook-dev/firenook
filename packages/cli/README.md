# Firenook CLI — local emulator preview

Prebuilt Rust local emulator, with the same Firebase client/Admin SDKs. It
serves Firestore, Auth, Storage, Functions and Pub/Sub (any subset, selected
by `firebase.json` and `--only`) with the supporting hub, Eventarc, Tasks,
logging and Emulator UI listeners. Realtime Database, Hosting, App Hosting and
Data Connect are not provided.

Install the unscoped `firenook` package; the `@firenook/cli-<platform>`
packages are its optional dependencies and are never installed directly.
Releases up to `0.1.0-next.9` were published as `@fireside-dev/cli`; the root
project README records what changes when migrating. The following
exact-version command is for this `0.2.0-next.1` preview package once
published. Repository development may precede registry availability; check
the root project README for the currently published version.

```sh
npm install --save-dev --save-exact firenook@0.2.0-next.1
npx firenook setup
npx firenook init                      # new project: firebase.json, rules, a Functions codebase
npx firenook init --adopt              # existing project: check it, add what Firenook needs
npx firenook doctor --project demo-my-app
npx firenook emulators:start --project demo-my-app
```

Use the same package with Bun. Put `firenook emulators:start ...` in your
project's package scripts; npm/Bun resolve its local executable. No Rust build,
postinstall downloader, Git dependency, remote tarball dependency or global
installation is required. Keep optional dependencies enabled: they select the
platform binary. Lock the version in your project. No automatic upgrades.

## Requirements and boundaries

- Node 24; macOS x64/arm64, Linux x64/arm64 glibc (Ubuntu 24.04 baseline),
  or native Windows x64. Each platform requires passing native packaging CI.
  Windows builds statically link the C runtime; no separate C++ redistributable
  is required by the Firenook executable.
- No Java: Storage Security Rules are compiled and evaluated natively
  (`rules_version = '2'` and version-1 sources, `firestore.get()` /
  `firestore.exists()` against the local Firestore, `PUT /internal/setRules`).
- No firebase-tools: Functions run on Firenook's own runtime, one Node worker
  per codebase, discovered through the `firebase-functions` SDK already in the
  codebase's `node_modules` (tested with 7.2.5). The recorded contract is the
  official emulator's behaviour for HTTP/callable/streaming, Firestore, Storage,
  Auth (including blocking functions), Pub/Sub, schedules, Eventarc custom
  events, dotenv/secret files, reload and background controls.
- `setup` explicitly downloads the pinned public Emulator UI asset and verifies
  size/SHA-256. Ordinary installation/start does not download it. `doctor` is
  read-only and names missing dependencies.
- The existing `firebase.json`, `.firebaserc` (aliases, Storage targets) and
  rules/index files are read as the official CLI reads them; see
  [Configuration](#configuration). No app SDK replacement is needed.
- Any lowercase project id is accepted. A `demo-*` id never reaches cloud
  services; a real id starts every Functions worker with the emulator hosts and
  without Google credentials, but this CLI is not a network sandbox: Functions
  are user code and can still call external APIs. No cloud login or deployment
  command exists.
- Use synthetic credentials only. Like the official Auth emulator, exported
  password hashes use a reversible development format, not secure production
  password storage. Never commit real credentials or emulator user exports.
- Firenook never prompts: destructive commands need `--force`, and
  `--non-interactive` is accepted as a no-op. Windows ARM64/32-bit and Linux
  musl/Alpine are not claimed supported.
- `firenook native ...` exposes the existing advanced native CLI explicitly.
  It does not receive the adapter's project, state or credential safeguards.

## Commands

```sh
firenook init [--force] [--dry-run] [--no-functions] [--project ID]   # scaffold a project
firenook init --adopt [--dry-run] [--json]        # adapt an existing firebase.json
firenook use [alias|projectId] [--add ID [--alias NAME]] [--unalias NAME] [--clear]
firenook target:apply storage NAME BUCKET...      # .firebaserc Storage targets
firenook target:clear storage NAME
firenook setup                                    # verified Emulator UI asset
firenook doctor [options]                         # read-only checks, JSON
firenook emulators:start [options]
firenook emulators:exec [options] "npm test"      # script through the shell
firenook emulators:exec [options] -- CMD ARGS...  # argv command, no shell
firenook emulators:export DIR [--force] [--only firestore,auth,storage]
firenook firestore:delete PATH (-r | --shallow) [-f] [--database ID]
firenook firestore:delete --all-collections -f [--database ID]
firenook functions:invoke NAME [--data JSON] [--region R] [--method M]
firenook functions:invoke NAME --event-data JSON [--resource PATH] [--params JSON] [--auth JSON] [--event-type T]
firenook ext:vendor [--instance ID]...
firenook mcp [--project ID] [--only firestore,auth,storage,functions,pubsub,tasks]
firenook binary-path | native ARGS...
```

`init` writes `firebase.json` (Firestore, Storage in the `{rules}` form, a
JavaScript Functions codebase unless `--no-functions`, every emulator on the
official default port, `ui.enabled: true`, `singleProjectMode: true`),
`.firebaserc` with `demo-<directory name>` (or `--project`), the official
Firestore/Storage rules and indexes templates, `functions/package.json` and
`functions/index.js`, and appends `.firenook/` and `*-debug.log` to
`.gitignore`. Nothing is installed; it refuses to overwrite `firebase.json`
without `--force`. `init --adopt` runs the launcher's own checks over an
existing project and prints a plan: errors Firenook cannot accept, official
services it skips, and additions it can make (missing `emulators` entries for
configured services, a missing `.firebaserc` default, referenced rules files
that do not exist). Without `--dry-run`/`--json` the additions are applied by
editing the parsed JSON, never rewriting other keys; errors leave every file
untouched and exit 1.

`use`, `target:apply` and `target:clear` are pure `.firebaserc` edits: no
network, no login. `use <alias|id>` records `projects.default`, `--add`
records an alias, `--unalias`/`--clear` remove one. Only `storage` targets
exist for Firenook (`database`/`hosting` are refused).

`emulators:export` finds the running suite through the same locator file the
official CLI writes (`<tmpdir>/hub-<projectId>.json`, then the configured hub
port), refuses the project directory or an ancestor, refuses a foreign
non-empty directory without `--force` (an earlier export is replaced), and
asks the hub to export the running exportable services. `firestore:delete`
speaks to the running Firestore emulator: a document path deletes that
document (`-r` also its subcollections), a collection path needs `-r` or
`--shallow`, `--all-collections` clears the database; `-r` on a collection and
`--all-collections` need `--force`. Both print JSON with `--json`.

Common options: `-P`/`--project`, `-c`/`--config`, `--json`, `--debug`,
`--log-verbosity LEVEL` (`DEBUG` behaves like `--debug`; the other levels are
accepted for compatibility and Firenook prints its full log),
`--non-interactive`. `--debug` passes `--debug-log` to the engine, which
appends every suite log record to
`<project>/.firenook/runs/session-*/firenook-debug.log`; the path is printed in
the launch banner and recorded in `launch.json`.

Not provided: `functions:shell` (Firenook never starts a second Functions
runtime; call functions on the running suite with `functions:invoke`, which
also injects the background events the shell would), and every deploy/login
command (never intercepted). `firenook mcp` serves the running suite to an
agent; see [Model Context Protocol](#model-context-protocol).

## Configuration

- **Services.** A service starts when `firebase.json` has its top-level
  section (`firestore`, `storage`, `functions`; `extensions` counts as
  functions) or an `emulators.<name>` entry (Auth and Pub/Sub have no section,
  so they need the entry), exactly like the official `filterEmulatorTargets`.
  `--only` narrows the list with the official names; `extensions` maps to
  functions, `eventarc`/`tasks`/`hub`/`ui`/`logging` follow their parent, and
  `database`/`hosting`/`dataconnect`/`apphosting` are refused as not
  implemented. Nothing configured means `No emulators to start, run firenook
  init to get started.`
- **Skipped services.** `emulators.database`, `.hosting`, `.dataconnect` and
  `.apphosting` entries are skipped with a warning; unknown keys are errors.
- **Storage** accepts the `{rules}` object, the array of `{target, rules}`
  entries (with `.firebaserc` targets or `--storage-bucket target=bucket`), or
  no section at all (open default rules for the project bucket).
- **Firestore** accepts the object form or an array of `{database, rules,
  indexes}` entries (one entry may omit `database` for `(default)`); the
  engine serves every listed database.
- **Functions** need `--minimum-functions` at `1` only when a codebase or
  extensions are configured and selected; otherwise the CLI passes `0`, and
  the engine drops Functions (with Eventarc and Tasks) with a notice when
  `firebase.json` has no `functions` codebase and no `extensions`.
- **UI.** `emulators.ui.enabled: false` disables the Emulator UI (and the
  logging listener, as in the official suite); `--ui` cannot re-enable it.
  `emulators:exec` keeps the UI off unless `--ui` is given or `ui.enabled` is
  explicitly `true`; `emulators:start` keeps it on unless disabled.
  `emulators.singleProjectMode` (default `true`) is passed through.
- **Host.** `--host` or `emulators.<name>.host` binds every listener; clients
  are pointed at the connectable address (`0.0.0.0` → `127.0.0.1`, `::` →
  `::1`). A non-loopback host prints a warning: the emulators have no
  authentication, so every service, the data and arbitrary Functions execution
  are reachable from any device that can reach that host. Per-service hosts
  that differ from the chosen host and are not loopback are errors.
- **Ports** come from `emulators.<name>.port`, `emulators.firestore.websocketPort`
  and the `--*-port` overrides, falling back to the official defaults
  (Firestore 8080, Auth 9099, Storage 9199, Functions 5001, Pub/Sub 8085, hub
  4400, UI 4000, logging 4500, Eventarc 9299, Tasks 9499, Firestore WebSocket
  9150); every port is passed to the engine explicitly and they must be
  distinct.

## Functions and Extensions

```sh
firenook emulators:start --project demo-my-app --inspect-functions        # debugger on 9229, 9230, ...
firenook emulators:start --project demo-my-app --inspect-functions=9333   # one codebase, explicit port
firenook functions:invoke helloWorld --project demo-my-app                # GET-less POST to the HTTPS route
firenook functions:invoke addMessage --project demo-my-app --data '{"text":"hi"}'   # callable body {"data": ...}
firenook functions:invoke onUserWritten --project demo-my-app --resource users/alice \
  --event-data '{"before":{"plan":"free"},"after":{"plan":"pro"}}'        # a Firestore document event
firenook ext:vendor --project demo-my-app                                 # copy registry Extensions into the project
firenook emulators:start --project demo-my-app --offline                  # never contact the Extensions registry
```

`functions:invoke` finds the running suite through the hub locator (so a
suite started on other ports is found) and, without `--event-data`, sends a
plain request (`--method`, default `POST`) or a callable body (`--data`) to the
function's HTTPS route. With `--event-data` it reads the loaded functions
(`GET /backends`), selects the named one (`--region` when a name is deployed
in several regions), builds the event exactly as the official `functions:shell`
does (`createLegacyEvent` for first-generation functions, a structured
`application/json` CloudEvent for second-generation ones) and posts it to the
suite's trigger route, which hands it unchanged to the codebase worker. The
delivery status and body are printed; `--json` prints the whole record
including the envelope. HTTPS/callable functions refuse `--event-data` (use
`--data`); Auth blocking functions are driven by the Auth emulator; Realtime
Database functions are not emulated.

| Trigger | `--event-data` | Notes |
| --- | --- | --- |
| Firestore (v1 `document.*`, v2 `google.cloud.firestore.document.v1.*`) | `{"before": {...}, "after": {...}}` as plain JSON fields (a bare object is the created/deleted document) | `--resource users/alice` names the document; wildcards are read back into `params`, or `--params '{"uid":"alice"}'` fills the trigger pattern. Values are encoded like the shell (`integerValue`, `mapValue`, ...) with `{"$timestamp"}`, `{"$ref"}`, `{"$geo"}` and `{"$bytes"}` sentinels for the types JSON lacks; each document value also carries its `name`, which the SDK uses for `snapshot.ref`. |
| Storage (v1 `google.storage.object.*`, v2 `google.cloud.storage.object.v1.*`) | the object metadata; `name` is required, `bucket` defaults to the trigger's bucket, `contentType`, `size`, `generation`, `metageneration`, timestamps, `id`, `selfLink` and `mediaLink` are defaulted | v1 events carry `resource: projects/_/buckets/<bucket>/objects/<name>`. |
| Pub/Sub (v1 `google.pubsub.topic.publish`, v2 `messagePublished`) | `{"data": <string or JSON>, "attributes": {...}, "orderingKey": "..."}` (string data is sent as given, other JSON as its text; both base64 on the wire) | Published through the Pub/Sub emulator when it runs, so every subscriber sees the message; otherwise the shell envelope goes straight to the trigger. |
| Auth v1 (`user.create`, `user.delete`) | a UserRecord (`uid` and `metadata` timestamps are defaulted) | `resource` defaults to `projects/<id>`. |
| Schedule | ignored (`{}`) | v2: an empty CloudEvent with Cloud Scheduler's `X-CloudScheduler-*` headers; v1: the legacy event on the `firebase-schedule-<name>` topic. |
| Eventarc custom (`onCustomEventPublished`) | the CloudEvent `data` | `--event-type` overrides the type; the channel is part of the trigger key. |
| Task queue (`onTaskDispatched`) | the task payload, enqueued as `{"data": ...}` | Sent to the Cloud Tasks emulator (`POST .../queues/<name>/tasks`) with the Admin SDK's request, so retries and rate limits apply. |

`--auth '{"uid": "...", "token": {...}}'` (or `{"admin": true}`) fills the
legacy event's `auth` as the shell's `constructAuth` does; first-generation
events default to `{"admin": false}` like the shell.

`firebase.json` `extensions` instances run like the official emulator: a
local path is read from disk; a registry ref (`publisher/name@version`) is
taken from `extensions/.sources/<publisher>/<name>@<version>` in the project
(vendored), then from the shared firebase-tools cache
(`~/.cache/firebase/extensions`, or `FIREBASE_EXTENSIONS_CACHE_PATH`), and
otherwise downloaded from the registry and built with `npm install` /
`npm run gcp-build`. Parameters come from `extensions/<instance>.env`,
`.env.<alias>`, `.env.<projectId>`, `.env.local` and `.secret.local` with the
official precedence, defaults and `${param:X}` substitution.

The registry (metadata and, on first use, the source archive) is contacted
with the Firebase CLI's stored login or a `FIREBASE_TOKEN` refresh token, the
same credential the official emulator uses; Firenook stores the registry
objects next to the source (`firenook-registry.json`) so every later start is
offline. Secret Manager is never contacted: provide secret parameters in
`extensions/<instance>.secret.local`. `firenook ext:vendor` copies each
resolved source into the project and records how unpinned refs resolved, which
is the recommended path for CI and for teammates without a Firebase login;
`--offline` (or `FIRENOOK_OFFLINE=1`) turns any remaining registry access into
a startup error. `firenook doctor` lists every instance with its source and
whether it starts offline. Dynamic (in-code) extensions, Python/Dart runtimes
and the registry's `latest-approved` listing rules beyond version resolution
are not supported.

## Model Context Protocol

```sh
firenook mcp --project demo-my-app                       # stdio server for the running suite
firenook mcp --project demo-my-app --only firestore,auth  # a subset of the tool groups
```

`firenook mcp` is a dependency-free MCP server over stdio (newline-delimited
JSON-RPC 2.0; protocol `2025-06-18`, and `2025-03-26`/`2024-11-05` clients are
accepted) that gives a coding agent the running local suite: `initialize`,
`ping`, `tools/list` and `tools/call`, capabilities `{"tools": {}}`. Register
it with the agent's MCP configuration, for example:

```json
{"mcpServers": {"firenook": {"command": "npx", "args": ["firenook", "mcp", "--project", "demo-my-app"]}}}
```

Every tool resolves the suite through the hub locator on each call (falling
back to the project's configured ports), so a suite restarted on other ports
is found, and returns a clear error while nothing runs. Results are JSON text;
Firestore documents are plain JSON with the `{"$timestamp"}`, `{"$ref"}`,
`{"$geo"}` and `{"$bytes"}` sentinels, so a document read back can be written
again without losing types. Emulator routes are called with the owner token
the Admin SDK uses, never through Security Rules. Stdout carries only JSON-RPC
lines; diagnostics go to stderr.

| Tool | Does |
| --- | --- |
| `firenook_status` | hub locator, hub status, the `/emulators` listing and the CLI version |
| `firestore_get`, `firestore_query`, `firestore_set`, `firestore_delete`, `firestore_list_collections` | read a document, run a structured query (`where`, `orderBy`, `limit`), write (replace or `merge`), delete (document or collection, `recursive`), list collection ids |
| `auth_list_users`, `auth_get_user`, `auth_create_user`, `auth_delete_user`, `auth_oob_codes`, `auth_verification_codes` | accounts and the pending email/SMS codes the emulator holds instead of sending them |
| `storage_list`, `storage_get_metadata` | objects and folder prefixes under a prefix; one object's metadata |
| `functions_list`, `functions_invoke` | the loaded functions with their trigger kind and URL; `functions:invoke` as a tool (`data` for HTTPS/callable, `eventData` and `resource` for background events) |
| `pubsub_publish`, `tasks_stats`, `emulators_export` | publish through the Pub/Sub emulator, Cloud Tasks queue statistics, `emulators:export` |

Nothing is sent anywhere but the local emulators: the server holds no
credentials, contacts no cloud service and never reaches outside the machine.
Treat what an agent writes through it as you would any emulator data: synthetic
only.

## State and tests

```sh
firenook emulators:start --project demo-my-app --import ./seed --export-on-exit ./export
firenook emulators:exec --project demo-my-app -- node ./integration-test.mjs
```

CLI options follow the pinned Firebase source contract where supported. A
test command is either an argv list after `--` (spawned directly, no shell) or
one quoted script string (`firenook emulators:exec "npm test"`), which runs
through the platform shell exactly as the official `emulators:exec` does; the
CLI says so on stderr. Two or more bare arguments without `--` are refused with
the rewritten command. The command starts only after native suite readiness;
the CLI waits for export/shutdown and propagates failures. On Windows, invoke
native programs directly (`-- node test.mjs`); for `.cmd` scripts use the
script form or an explicit interpreter (`-- cmd.exe /c npm test`). The
launcher uses a private control pipe for graceful native export/shutdown rather
than treating Unix signals as portable. Paths containing spaces are supported.

Disk/WAL is the default. Fresh runs use a new `.firenook/runs/session-*` working
directory; add `.firenook/` to your own gitignore. These directories are retained
for recovery, including after errors. They are **data**, not disposable caches.
The installer never deletes them. Retain a completed export before removing old
stopped working directories. Do not point state at your seed/export directory.

Explicit native resume needs both `--state-dir ./local-state` and
`--resume-state --import ./seed`. The seed must stay immutable; export elsewhere.
Without resume, never reuse a state directory as an implicit reset/reimport.
`--export-on-exit` without a directory follows `--import`; never use this with
an immutable resume seed. Ctrl-C requests graceful export; await completion.

Writes are acknowledged as soon as they are journaled and are synced to the
drive once a second and on shutdown (write-behind durability). Killing the
emulator loses nothing; only a kernel crash or power cut can lose the last
second of writes, and the state stays consistent. `--durability per-commit`
syncs every write before acknowledging it, at the drive's flush latency
(typically 10 to 30 ms per write) instead of under a millisecond.

Roll back by cleanly stopping Firenook, retaining its completed official-format
export, then starting the official CLI on separate working state. Never run
both on the same ports or let both own a working directory.

## Pub/Sub on its own

```sh
firenook native pubsub --project-id demo-my-app --port 8085
PUBSUB_EMULATOR_HOST=127.0.0.1:8085 node ./publisher.mjs
```

`firenook native pubsub` serves the same Pub/Sub implementation the suite
runs — the `google.pubsub.v1` services and `google.iam.v1` policy over gRPC
and HTTP/JSON on one port, so the Google client libraries connect with
`PUBSUB_EMULATOR_HOST` — without Firestore, Storage or Functions. The
conformance replay drives this command.

## Auth on its own

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

## Evidence and versioning

Package version is separate from native engine version. `firenook --version`
prints the package version and exact engine source revision. `binary-path`
verifies the installed platform package's source/version/hash before returning
its native executable. Receipts are integrity checks, not a substitute for npm
registry provenance and your lockfile.

The package pins its engine in `release.json`, including native Windows lifecycle,
disk startup and the Auth export/import and popup/redirect flows. Since
`0.1.0-next.8` Auth carries every operation of the official Auth emulator,
replayed from a recorded corpus: every sign-in method with the fake IdP
credentials the official emulator accepts, tenants, SMS MFA, passkeys, OOB and
phone codes, blocking functions and export/import. Imported accounts can be
selected without real Google credentials; disabled accounts remain rejected.
Real provider round trips, real email/SMS delivery and the routes the official
emulator itself answers with 501 are not provided.
Release checks cover SDK conformance and packed installation, plus synthetic
read/write, listener, disk-reopen and export/import scenarios. A check passing
for one engine revision or consumer does not certify another revision or every
application. This package makes no universal performance or memory-reduction
claim; measure your own representative workload before adopting it.

Functions execution uses the user's Node with Firenook's runtime; user code
can still reach external services. Pub/Sub is a full emulator since
`0.1.0-next.8` (pull, streaming pull, push, ordering, filters, dead-letter,
seek, snapshots, Avro schemas); Protocol Buffer schemas, IAM and export
subscriptions are not, and neither are Realtime Database, Hosting, App Hosting
and Data Connect. Supporting UI routes do not imply full Emulator UI parity.
Windows power-loss durability and network filesystems have not been qualified;
the native Windows checks cover local-disk writes, reopen, export and import.
