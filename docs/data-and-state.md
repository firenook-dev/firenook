# Data, state and tests

[Docs](README.md) · Data, state and tests

Keeping your data between runs, starting from a seed, exports, durability, keeping the store small, and running tests against the suite.

```sh
firenook emulators:start --project demo-my-app --import ./seed --export-on-exit ./export
firenook emulators:start --project demo-my-app --keep-data       # data kept in .firenook/state
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

The command's environment is the official one: `GCLOUD_PROJECT`,
`FIREBASE_CONFIG` (unless yours sets one) and, for each emulator the hub lists
as running and for no other, its variables: `FIRESTORE_EMULATOR_HOST` and
`FIREBASE_FIRESTORE_EMULATOR_ADDRESS`, `FIREBASE_AUTH_EMULATOR_HOST`,
`FIREBASE_STORAGE_EMULATOR_HOST` and `STORAGE_EMULATOR_HOST` (a URL),
`PUBSUB_EMULATOR_HOST`, `FIREBASE_EMULATOR_HUB`, and with Functions
`CLOUD_TASKS_EMULATOR_HOST` and `CLOUD_EVENTARC_EMULATOR_HOST` (a URL).
Firenook adds `GOOGLE_CLOUD_PROJECT`, a gcloud directory of the run's own
(`CLOUDSDK_CONFIG`) and `GOOGLE_APPLICATION_CREDENTIALS`, pointing at demo
credentials it writes in the run directory. The Python, Go and Java Admin
SDKs look up credentials when they start, and these keep yours out of the
tests. When your environment already sets `GOOGLE_APPLICATION_CREDENTIALS`,
exec passes it on unchanged, as the official `emulators:exec` does, writes no
demo credentials and says so on stderr; a call that needs an access token
then gets one with your credentials, from Google.

The demo credentials are an `authorized_user` file, the one kind every release
of every Admin SDK reads (firebase-admin for Node.js 12 and earlier refuses
any newer kind when it starts, and so do the other SDKs' auth libraries from
before late 2022 to late 2023).
None of the SDKs sends their token request to Google:

| Admin SDK | Its token |
| --- | --- |
| Node.js, firebase-admin 11 to 14 | Every Node.js SDK sends its refresh to Google whatever the file says, so exec adds `--require` of the CLI's `src/exec-token.cjs` to `NODE_OPTIONS` (after yours): in each Node.js process of the command it answers that one request with the emulators' token, and passes any other on unchanged |
| Python, google-auth 1.22 or later (every firebase-admin 6 or 7 install has 1.25 or later) | The file holds the emulators' own token, which the SDK uses as it is and never refreshes |
| Go, golang.org/x/oauth2 from May 2021 (firebase-admin-go 4.8 or later) | Refreshed from the hub, the file's `token_uri` (`/firenook/oauth2/token` on the hub port) |
| Java, google-auth-library 1.32 or later (firebase-admin 9.5 or later) | Refreshed from the hub, the file's `token_uri` |

Only two calls to the emulators need a token at all: an Eventarc publish from
Node.js and any Python Storage call. The Go and Java SDKs need none for the
emulators, so their older releases, which refresh at Google whatever
`token_uri` says, reach Google only for a service the suite does not
emulate. A runtime that does not read `NODE_OPTIONS` (Bun, Deno) gives a
Node.js SDK no preload, so its Eventarc publish asks Google for a token,
which refuses these credentials. A call to a service the suite does not
emulate goes to Google whatever the credentials, as with the official exec,
and fails there with these.

Disk/WAL is the default. Fresh runs use a new `.firenook/runs/session-*` working
directory; add `.firenook/` to your own gitignore. These directories are retained
for recovery, including after errors. They are **data**, not disposable caches.
The installer never deletes them. Retain a completed export before removing old
stopped working directories. Do not point state at your seed/export directory.

To keep data between runs, add `--keep-data`: it is short for
`--state-dir ./.firenook/state --resume-state`, and `--state-dir` names another
directory. `--import ./seed` is optional. With a seed, the first start imports
it and every later start picks up the saved data; without one, the first start
begins empty. Saved data remembers how it began, so data started from a seed
refuses a start without that `--import`, and data started without a seed
refuses one with `--import` (import a seed into a new `--state-dir` instead).
The seed must stay immutable; export elsewhere. Without resume, never reuse a
state directory as an implicit reset/reimport. Data kept without a seed needs
0.2.0-next.7 or later; an earlier release refuses it and changes nothing.
`--export-on-exit` without a directory follows `--import`; never use this with
an immutable resume seed. Ctrl-C requests graceful export; await completion.

An `--import` is read as the official CLI reads it. A directory with
`firebase-export-metadata.json` is a suite export; one holding a production
Firestore export (`*.overall_export_metadata`) imports that into Firestore.
A directory with neither, or a file, is no import: the start warns `Could not
find import/export metadata file, skipping data import!` and goes on empty.
A directory that does not exist is refused, unless `--export-on-exit` writes
it: `--import ./data --export-on-exit` then starts empty the first time, and
the stop creates `./data` for the next start.

Picking saved data up checks that the seed has not changed since it was
imported. Each file's size and times are recorded at the import
(`native-seed.json`, beside the receipt), so the check reads only a file whose
details changed, to tell a touched file from an edited one. Files operating
systems write into any folder they show (`.DS_Store`, `._*`, `Thumbs.db`,
`desktop.ini`) are ignored. When the seed did change, the start is refused and
nothing is deleted: import the changed seed into a new `--state-dir`, or keep
the data with the seed as it is now:

```sh
firenook state:adopt-seed --state-dir ./local-state --import ./seed
```

The previous receipt is kept beside the new one. Data saved by 0.2.0-next.4 or
earlier is checked in full once, then recorded; it stays readable by those
versions.

The documents' count is saved with the data, so a start reads it instead of
counting every document; data an earlier release wrote since is counted once.
A clean stop also saves the console's map of the collections, the tree beside
the Firestore grid, so the next start shows it at once instead of reading
every document key again (39 s on a store of 2.7 million documents). After a
crash, or any change to the data since that stop, the console maps the
database again the first time it is opened, listing the root collections
meanwhile.
Saved data's Firestore file grows with use and never shrinks by itself:
deleted and rewritten documents leave free pages behind. With the emulator
stopped, `state:inspect` shows what the file holds, table by table, and how
much of it is free, and `state:compact` returns the free pages to the disk.
Every document stays as it is. The file is copied first (a copy-on-write
clone where the file system has one), and the copy is removed once the
compaction succeeds; `--no-copy` skips it. The console Overview shows the
file's size on disk.

```sh
firenook state:inspect --state-dir ./local-state
firenook state:compact --state-dir ./local-state
```

Writes are acknowledged as soon as they are journaled and are synced to the
drive once a second and on shutdown (write-behind durability). Killing the
emulator loses nothing; only a kernel crash or power cut can lose the last
second of writes, and the state stays consistent. `--durability per-commit`
syncs every write before acknowledging it, at the drive's flush latency
(typically 10 to 30 ms per write) instead of under a millisecond.

A stop at any moment, even while the data is still opening, closes the data
cleanly: a check of the seed or a repair is abandoned, an import into a fresh
run's directory ends at once, and an import into saved data finishes first,
since half an import could never be picked up. Clients still connected do
not hold the stop up: the Listen and Write sessions a web page opened end
with it, as do gRPC streams and the console's own. A launcher that goes away
without a word (killed, or its terminal's process gone) stops the engine the
same way, saving the data: on every platform the engine's stdin is a pipe
only the launcher holds, and its end is a stop. A process killed anyway leaves
the store to repair at the next start, and the launcher says the engine was
ended (in a terminal, that the next start checks the data first). Under write-behind, the store saves
what a repair needs with each sync, so that repair takes moments;
`--durability per-commit` leaves that out to keep its commit latency, and
repairs by reading the store once, with its progress on screen.

Disk state keeps an equality index over every document's top-level fields, so
a query with `==` or `in` on them reads only the documents holding the value,
not the whole collection. Results are identical either way. A state last
written by an older release rebuilds the index once on the next start (one read
of every stored document). `FIRENOOK_FIELD_INDEXES=0` turns it off for a
comparison; queries then scan, as before.

Roll back by cleanly stopping Firenook, retaining its completed official-format
export, then starting the official CLI on separate working state. Never run
both on the same ports or let both own a working directory.
