# Phase L — Configuration shapes (`0.1.0-next.9`, with Phases K and M)

Written 2026-09-19 against `main` 2c1ceb3 (published engine 03000f0,
`0.1.0-next.8`). It ships with [Phase K](phase-k-tasks.md) (Cloud Tasks)
and [Phase M](phase-m-cli.md) (CLI surface) as `0.1.0-next.9`.

## Status (2026-09-19)

Published as `0.1.0-next.9` on 2026-09-19 (release run 35440801335, `next` → next.9,
`latest` untouched) after exact-candidate CI on 7fb0c35, the consumer gates
and the nine browser journeys on the local candidate; see the checklist in [ROADMAP.md](../ROADMAP.md#phase-l--configuration-shapes-010-next9-with-phases-k-and-m)
and the receipts in `benchmarks/phase-l-configuration.json`.

## Goal

Accept the `firebase.json` / `.firebaserc` / launch shapes a generic public
project brings, the way the official CLI does, instead of the preview's
all-or-nothing profile: service subsets (`--only`, a project without
Functions or Storage), any project id, a wildcard listen host, several
Firestore databases, `emulators.ui.enabled: false` and
`emulators.singleProjectMode: false`. Where the official suite warns,
Fireside warns with the same words; where the official suite is silent about
a safety matter (a public bind), Fireside says so once at startup.

## State before the phase (verified 2026-09-19)

Every one of the five rows was blocked in the npm wrapper
(`packages/cli/src/options.mjs`), which is a hard allowlist: `demo-*` ids
only, the full five-service profile only, `storage` must be an array (the
engine already handled the object form, so the tracker's "done" was
unreachable from npm), `ui.enabled:false` / `singleProjectMode:false` /
`firestore` arrays rejected, loopback only, any `emulators.<name>` outside
the known list a hard error. In the engine: `SuiteConfig.host` doubled as
listen and connect address; every listener, runtime and hub entry was
unconditional; `SuiteDirectory` required `ui`, `logging`, `auth`,
`functions` and `pubsub`; `validate_config` refused non-demo ids and
`minimum_functions == 0`; a missing `.firebaserc` was a startup error (the
wrapper hid it by writing `{}`); the standalone `--single_project_mode` flag
was parsed and unused; the store, disk keys, watch broker and gRPC paths
already carried the database id, but rules were keyed by project only and
export hardcoded `(default)`.

Official behaviour (firebase-tools 15.22.0): `filterEmulatorTargets` starts
the emulators a top-level section or an `emulators.<name>` entry configures,
then applies `--only` with no dependency expansion; a demo project gets the
default open Storage rules when no `storage` section exists; `demo-*` prints
`Detected demo project ID …`; a real id prints `The following emulators are
not running, calls to these services from the Functions emulator will affect
production: …` and merely warns when ADC are present; `0.0.0.0` is accepted
without any warning and `connectableHostname` rewrites it to `127.0.0.1` for
clients; `ui.enabled:false` also stops the logging emulator;
`singleProjectMode` (default true) is a WARN in the Auth emulator, never an
error; and the Firestore emulator refuses more than one database (`Cloud
Firestore Emulator does not support multiple databases yet.`) and then loads
no rules at all.

## Work packages

### L1 — Service subsets (engine)

`ServiceSelection` on `SuiteConfig` (`--only`; `extensions` means
functions; `eventarc`, `tasks`, `hub`, `ui`, `logging` follow their parent;
`database`, `hosting`, `dataconnect`, `apphosting` are named as not
implemented). The hub always runs; Eventarc and Tasks follow Functions; the
requests WebSocket follows Firestore; the UI and logging listeners follow
`ui_enabled`. Every runtime, listener, hub entry, import and export step is
conditional; `--resume-state` keeps requiring the three data services its
receipt covers; the store is in-memory when Firestore is not selected (it
only backs Storage rules' `firestore.get()`).

### L2 — Project ids, hosts, UI and single-project mode (engine)

Any id without whitespace or slashes; the demo banner or the real-id
warnings (with the official "will affect production" line when Functions
runs and a service is missing). `--host` binds anything; `connect_host()`
(`0.0.0.0 → 127.0.0.1`, `:: → ::1`) is what the hub locator, the hub and UI
listings, the worker environment and the internal origins use; a
non-loopback bind prints one warning line. `--no-ui` drops the UI and logging
listeners; `--single-project-mode` warns once per foreign project id on the
Auth and Firestore HTTP routes with the official Auth text. `--debug-log`
appends every suite log record to a file. A missing `.firebaserc` and a
missing `storage` section (open default rules for demo ids) are accepted.

### L3 — Multiple Firestore databases (engine)

`firestore` as an array of `{database, rules, indexes}`; rules installed per
`(project, database)` with the precedence database-specific → project-wide
(the hot-reload route) → default; the store enumerates a project's
databases so the export writes every one of them into the single
`firestore_export` (the entity format carries the database id) and import
round-trips them.

### L4 — Wrapper (with Phase M)

`loadProject` derives the configured services as the official CLI does,
filters with `--only`, warns and skips the unimplemented emulator sections,
accepts the object storage form and its absence, any project id (with a
one-line warning for real ids), `firestore` arrays, `ui.enabled`,
`singleProjectMode`, any host (with the warning), and passes the new engine
flags.

### L5 — Qualification and release (shared with K and M)

Exact-candidate CI, consumer gates, release `0.1.0-next.9`, docs.

## Safety notes recorded for the docs

- A real project id never makes the suite contact Firebase: every worker
  gets every `*_EMULATOR_HOST`, `GOOGLE_APPLICATION_CREDENTIALS`,
  `FIREBASE_TOKEN` and `CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE` are stripped
  and `METADATA_SERVER_DETECTION=none` is set. User code that builds its own
  clients with explicit credentials can still reach the real project; the
  launcher says so.
- A public bind exposes unauthenticated Firestore, Auth, Storage and
  arbitrary Functions execution to the network; the banner says so once.
