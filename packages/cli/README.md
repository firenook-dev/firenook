<p align="center">
  <img alt="Firenook" src="https://raw.githubusercontent.com/firenook-dev/firenook/main/brand/logo/firenook-logo.svg" height="64">
</p>

<h3 align="center">A faster drop-in replacement for the Firebase Local Emulator Suite</h3>

<p align="center">
  Keep your <code>firebase.json</code>, SDKs and ports. Get 38× faster writes,
  9× less memory, no Java, and data that survives restarts.
</p>

<p align="center">
  <a href="https://github.com/firenook-dev/firenook/blob/main/docs/getting-started.md">Getting started</a> ·
  <a href="https://github.com/firenook-dev/firenook/blob/main/docs/README.md">Docs</a> ·
  <a href="https://github.com/firenook-dev/firenook/blob/main/docs/benchmarks.md">Benchmarks</a> ·
  <a href="https://github.com/firenook-dev/firenook/blob/main/COMPATIBILITY.md">Compatibility</a> ·
  <a href="https://github.com/firenook-dev/firenook">GitHub</a>
</p>

**Already using the Firebase emulators?** Install Firenook and change one word:

```sh
npm install --save-dev firenook
```

```diff
- firebase emulators:start --import ./data
+ firenook emulators:start --import ./data
```

Same flags, same ports, and your `firebase.json`, rules, Functions code and app
stay as they are. In a terminal, run it as `npx firenook emulators:start`. To
keep your data between runs, add `--keep-data`.
Firenook needs Node 24. Starting a new project? `npx firenook init` sets one
up on one screen, installs it and starts the emulators.

<p align="center">
  <img alt="firenook emulators:start: the start-up card, the ready summary and a live log of function calls" src="https://raw.githubusercontent.com/firenook-dev/firenook/main/docs/assets/terminal.gif" width="760">
</p>

## Why Firenook

- **A drop-in for the official emulator.** It reads `firebase.json`,
  `.firebaserc`, rules and indexes the way the Firebase CLI does, serves the
  same ports, and your client and Admin SDKs connect unchanged. It imports and
  exports the official format.
- **Fast and light.** Native Rust services with the data on disk. On a real
  application's two-hour workload, Firenook peaked at 2.16 GiB of memory where
  the official emulator reached 19.56 GiB, answered writes in 5.3 ms against
  203 ms at the median, and used 61% less CPU.
- **Your data stays.** Add `--keep-data` and Firestore, Auth and Storage come
  back with all your data in about half a second, even with millions of
  documents. A crash loses at most the last second of writes.
- **Nothing else to install.** No Java, no firebase-tools, nothing else
  downloaded at install or start (an Extension from the registry is fetched
  once, on first use). npm or Bun picks the native engine for your machine;
  Node runs your Functions.
- **A console and a terminal made for it**, and `firenook mcp` for your coding
  agent: Firestore, users and their tokens, logs and function calls, Security
  Rules decisions, Storage, Pub/Sub, Cloud Tasks and Eventarc as tools.
  `npx firenook mcp add` sets it up for Claude Code, Cursor and VS Code;
  [other agents](https://github.com/firenook-dev/firenook/blob/main/docs/mcp.md#connect-your-agent)
  run the same `npx firenook mcp`.

## Switching from the official emulator

Keep firebase-tools for deploying, and add `.firenook/` to your `.gitignore`:
every run keeps its working data there.

```console
$ npx firenook init --adopt --dry-run
  skip    Firenook: firebase.json configures the hosting emulator, which Firenook does not implement; skipping it.
  ok      nothing to change; services: firestore, auth, storage, functions
```

```diff
-  "emulators": "firebase emulators:start --import ./data --export-on-exit",
+  "emulators": "firenook emulators:start --import ./data --export-on-exit",
```

Same flags, same ports, the official export format both ways. To keep your
data between runs without exporting, replace `--export-on-exit` with
`--keep-data`; `./data` is then never written.
Starting fresh instead: `npx firenook init`.
[Getting started](https://github.com/firenook-dev/firenook/blob/main/docs/getting-started.md)
covers both.

## The console

**The console the Firebase emulators should have had.** Google's Emulator UI
has no page for your Functions, Pub/Sub, Cloud Tasks or Eventarc, only a log.
Firenook's console covers every service it runs, live, on the Emulator UI's
port, at
`http://127.0.0.1:4000/console`. It shows every function call with its
trigger, duration and logs, and an inbox of the codes and links Auth would
have sent. It has Firestore and Storage with their rules, Pub/Sub, Cloud
Tasks and Eventarc, and an Overview of every service's health.

<p align="center">
  <img alt="The console's Overview: the health of all nine services with their counts and ports, and recent problems" src="https://raw.githubusercontent.com/firenook-dev/firenook/main/docs/assets/console-overview-light.png">
</p>

## What it emulates

Firestore, Authentication, Cloud Storage (with native Security Rules), Cloud
Functions (every trigger type, reload on save, debugging), Extensions, Pub/Sub,
Cloud Tasks and Eventarc. Realtime Database, Hosting, App Hosting and Data
Connect are not emulated; a `firebase.json` that configures them still starts,
with a warning. See [compatibility](https://github.com/firenook-dev/firenook/blob/main/COMPATIBILITY.md).

## Benchmarks

<p align="center">
  <img alt="Firenook against the official emulator: 9 times less memory, writes 38 times faster, listener updates 18 times faster, restarts 39 times sooner, 80 times sooner on 2.5 million documents, 61% less CPU" src="https://raw.githubusercontent.com/firenook-dev/firenook/main/docs/assets/benchmark-light.svg" width="880">
</p>

One real application with 211,205 documents and 6.7 GB in Storage, and two
hours of its traffic against each emulator in turn on one server. The official
emulator answered 6 of 26 query shapes faster (ordering and range
filters over a large collection, batch gets).
[The method and every figure.](https://github.com/firenook-dev/firenook/blob/main/docs/benchmarks.md)

## Commands

```sh
firenook init [--yes]                         # a new project: choose, install, start
firenook init --adopt [--dry-run]             # adapt an existing firebase.json
firenook doctor                               # read-only checks, JSON
firenook emulators:start [options]            # --only, --project, --import, --export-on-exit, --inspect-functions
firenook emulators:start --keep-data [--import ./seed]   # keep data between runs, in .firenook/state
firenook emulators:start --build              # compile TypeScript first and on every save
firenook emulators:exec "npm test"            # start, run your tests, stop
firenook emulators:export ./export            # snapshot a running suite
firenook functions:invoke NAME [--data JSON | --event-data JSON]   # call any function, any trigger
firenook ext:vendor [--offline]               # copy registry Extensions into the project
firenook mcp                                  # the running suite as tools for a coding agent
firenook mcp add                              # give Claude Code, Cursor and VS Code that server
firenook state:inspect | state:compact --state-dir DIR
```

Every command and option: [CLI reference](https://github.com/firenook-dev/firenook/blob/main/docs/cli.md).

## Requirements

Node 24 on macOS (Apple silicon or Intel), Linux (x64 or arm64, glibc) or
Windows x64. Keep optional dependencies enabled: they carry the native engine
for your platform. Firenook is in preview (`0.2.0-next` releases): pin an exact
version (`--save-exact`) and upgrade on purpose.

## License

Apache License 2.0. Firebase, Cloud Firestore, Cloud Functions, Cloud Storage,
Cloud Pub/Sub and Cloud Tasks are trademarks of Google LLC; Firenook is not
affiliated with or endorsed by Google.
