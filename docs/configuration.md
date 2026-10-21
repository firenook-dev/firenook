# Configuration

[Docs](README.md) · Configuration

How Firenook reads `firebase.json`, `.firebaserc` and the command line, and what it needs from your machine.

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
  no section at all (open default rules for the project bucket). A target's
  rules govern every bucket `.firebaserc` maps it to, as officially; a bucket
  no rules govern refuses every client request.
- **Firestore** accepts the object form or an array of `{database, rules,
  indexes}` entries (one entry may omit `database` for `(default)`); the
  engine serves every listed database.
- **Functions** need `--minimum-functions` at `1` only when a codebase or
  extensions are configured and selected; otherwise the CLI passes `0`, and
  the engine drops Functions (with Eventarc and Tasks) with a notice when
  `firebase.json` has no `functions` codebase and no `extensions`.
- **UI.** `emulators.ui.enabled: false` turns off the UI port, and with it
  the console and the logging listener, as in the official suite; `--ui`
  turns it on all the same, as the official `--ui` comes before that
  setting. `emulators:exec` keeps it off unless `--ui` is given or
  `ui.enabled` is explicitly `true`; `emulators:start` keeps it on unless
  disabled.
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

## Rules coverage and request tracing

`firenook emulators:start` records bounded diagnostics by default: each
Firestore request with its rule evaluation, and rules coverage. Open
`/emulator/v1/projects/<project>:ruleCoverage.html` on the Firestore port for
the coverage report, or leave out `.html` for JSON. The console's Firestore
Rules page shows the recorded requests with each decision, and the coverage. `--no-diagnostics` turns recording off,
and the debug endpoint then answers that it is unavailable. Reports can
contain document data and decoded auth claims, so keep them local.

## Requirements and boundaries

- Node 22, 24 or 26, which your Functions run on (see
  [Functions and Extensions](functions-and-extensions.md#node)); macOS
  x64/arm64, Linux x64/arm64 with glibc 2.28 or newer, or native Windows x64.
  Each platform requires passing native packaging CI. The Linux engine is
  linked against glibc 2.28 (the manylinux_2_28 image), and CI starts it on
  AlmaLinux 8, Debian 11, Ubuntu 22.04 and node:24-slim.
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
- Nothing is downloaded: no postinstall step and no setup step; the console
  is part of the engine. `setup`, which fetched Google's Emulator UI until
  `0.2.0-next.3`, does nothing now, so scripts that still run it pass.
  `doctor` is read-only and names missing dependencies and a Node the
  emulators do not start on, in its `problems`.
- The existing `firebase.json`, `.firebaserc` (aliases, Storage targets) and
  rules/index files are read as the official CLI reads them; see
  [Configuration](configuration.md). No app SDK replacement is needed.
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
  musl/Alpine are not claimed supported. On Alpine, or a glibc older than
  2.28, the CLI says what the engine needs and what the system has, and
  suggests a glibc image such as node:24-slim.
- `firenook native ...` exposes the existing advanced native CLI explicitly.
  It does not receive the adapter's project, state or credential safeguards.
