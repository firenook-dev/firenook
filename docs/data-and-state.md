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
since half an import could never be picked up. A process killed anyway leaves
the store to repair at the next start. Under write-behind, the store saves
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
