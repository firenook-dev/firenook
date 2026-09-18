# Fireside CLI — local emulator preview

Prebuilt Rust local emulator, with the same Firebase client/Admin SDKs. This is
a preview of a **complete-suite local configuration**: Firestore, Auth,
Storage, Functions, a limited Pub/Sub adapter and supporting hub/UI services. It is not a
universal replacement for every Firebase product or arbitrary service subsets.

Install the scoped package, not the unrelated unscoped `fireside` package.
The following exact-version command is for this `0.1.0-next.7` preview package
once published. Repository development may precede registry availability; check
the root project README for the currently published version.

```sh
npm install --save-dev --save-exact @fireside-dev/cli@0.1.0-next.7
npx fireside setup
npx fireside doctor --project demo-my-app
npx fireside emulators:start --project demo-my-app
```

Use the same package with Bun. Put `fireside emulators:start ...` in your
project's package scripts; npm/Bun resolve its local executable. No Rust build,
postinstall downloader, Git dependency, remote tarball dependency or global
installation is required. Keep optional dependencies enabled: they select the
platform binary. Lock the version in your project. No automatic upgrades.

## Requirements and boundaries

- Node 24; macOS x64/arm64, Linux x64/arm64 glibc (Ubuntu 24.04 baseline),
  or native Windows x64. Each platform requires passing native packaging CI.
  Windows builds statically link the C runtime; no separate C++ redistributable
  is required by the Fireside executable.
- No Java: Storage Security Rules are compiled and evaluated natively
  (`rules_version = '2'` and version-1 sources, `firestore.get()` /
  `firestore.exists()` against the local Firestore, `PUT /internal/setRules`).
- No firebase-tools: Functions run on Fireside's own runtime, one Node worker
  per codebase, discovered through the `firebase-functions` SDK already in the
  codebase's `node_modules` (tested with 7.2.5). The recorded contract is the
  official emulator's behaviour for HTTP/callable/streaming, Firestore, Storage,
  Auth (including blocking functions), Pub/Sub, schedules, Eventarc custom
  events, dotenv/secret files, reload and background controls.
- `setup` explicitly downloads the pinned public Emulator UI asset and verifies
  size/SHA-256. Ordinary installation/start does not download it. `doctor` is
  read-only and names missing dependencies.
- Existing `firebase.json` configures all five service emulators; `.firebaserc`
  aliases/Storage targets and existing rules/index paths are reused. Storage is
  currently the native suite's array-of-targets format, not every Firebase CLI
  configuration shape. No app SDK replacement is needed.
- Use a `demo-*` project. No cloud login or deployment commands. Functions are
  user code and can still call external APIs; this is not a network sandbox.
- Use synthetic credentials only. Like the official Auth emulator, exported
  password hashes use a reversible development format, not secure production
  password storage. Never commit real credentials or emulator user exports.
- Unsupported services, subsets, multi-project configurations, public bind
  addresses and UI-disable requests fail before launch. Windows ARM64/32-bit,
  Linux musl/Alpine and arbitrary partial suites are not claimed supported.
- `fireside native ...` exposes the existing advanced native CLI explicitly.
  It does not receive the adapter's project, state or credential safeguards.

## Functions and Extensions

```sh
fireside emulators:start --project demo-my-app --inspect-functions        # debugger on 9229, 9230, ...
fireside emulators:start --project demo-my-app --inspect-functions=9333   # one codebase, explicit port
fireside functions:invoke helloWorld --project demo-my-app                # GET-less POST to the HTTPS route
fireside functions:invoke addMessage --project demo-my-app --data '{"text":"hi"}'   # callable body {"data": ...}
fireside ext:vendor --project demo-my-app                                 # copy registry Extensions into the project
fireside emulators:start --project demo-my-app --offline                  # never contact the Extensions registry
```

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
same credential the official emulator uses; Fireside stores the registry
objects next to the source (`fireside-registry.json`) so every later start is
offline. Secret Manager is never contacted: provide secret parameters in
`extensions/<instance>.secret.local`. `fireside ext:vendor` copies each
resolved source into the project and records how unpinned refs resolved, which
is the recommended path for CI and for teammates without a Firebase login;
`--offline` (or `FIRESIDE_OFFLINE=1`) turns any remaining registry access into
a startup error. `fireside doctor` lists every instance with its source and
whether it starts offline. Dynamic (in-code) extensions, Python/Dart runtimes
and the registry's `latest-approved` listing rules beyond version resolution
are not supported.

## State and tests

```sh
fireside emulators:start --project demo-my-app --import ./seed --export-on-exit ./export
fireside emulators:exec --project demo-my-app -- node ./integration-test.mjs
```

CLI options follow the pinned Firebase source contract where supported. Test
commands are arguments after `--`, not implicitly executed by a shell. Use
`-- sh -c '...'` deliberately when needed. The command starts only after native
suite readiness; the CLI waits for export/shutdown and propagates failures.
On Windows, invoke native programs directly (`-- node test.mjs`); for `.cmd`
scripts use an explicit command interpreter (`-- cmd.exe /c npm test`). The
launcher uses a private control pipe for graceful native export/shutdown rather
than treating Unix signals as portable. Paths containing spaces are supported.

Disk/WAL is the default. Fresh runs use a new `.fireside/runs/session-*` working
directory; add `.fireside/` to your own gitignore. These directories are retained
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

Roll back by cleanly stopping Fireside, retaining its completed official-format
export, then starting the official CLI on separate working state. Never run
both on the same ports or let both own a working directory.

## Auth on its own

```sh
fireside native auth --project-id demo-my-app --port 9099                 # the Auth service alone, in memory
fireside native auth --project-id demo-my-app --state-file ./auth.json    # persisted accounts, codes and config
```

`fireside native auth` serves the same Auth implementation the suite runs
(every operation of the official Auth emulator, the popup/redirect helper
pages, `/emulator/openapi.json`) without Firestore, Storage or Functions. Add
`--functions-origin http://host:port` to deliver `user.create`/`user.delete`
multicasts to a Functions host; blocking functions come from the project's
configuration. The conformance replay drives this command.

## Evidence and versioning

Package version is separate from native engine version. `fireside --version`
prints the package version and exact engine source revision. `binary-path`
verifies the installed platform package's source/version/hash before returning
its native executable. Receipts are integrity checks, not a substitute for npm
registry provenance and your lockfile.

The package pins its engine in `release.json`, including native Windows lifecycle,
disk startup, Auth export/import password-login corrections and the captured
Google popup/redirect account-picker repair. Imported accounts can be selected
without real Google credentials; disabled accounts remain rejected. These are
the fixture-tested browser flows, not arbitrary OAuth/provider or tenant support.
Release checks cover SDK conformance and packed installation, plus synthetic
read/write, listener, disk-reopen and export/import scenarios. A check passing
for one engine revision or consumer does not certify another revision or every
application. This package makes no universal performance or memory-reduction
claim; measure your own representative workload before adopting it.

Functions execution uses the user's Node with Fireside's runtime; user code
can still reach external services. General Pub/Sub subscriber delivery,
arbitrary Auth provider/tenant flows, Realtime Database, Hosting, App Hosting
and Data Connect are not covered by this preview. Supporting UI routes do not imply full Emulator UI parity.
Windows power-loss durability and network filesystems have not been qualified;
the native Windows checks cover local-disk writes, reopen, export and import.
