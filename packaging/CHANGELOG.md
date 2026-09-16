# 0.1.0-next.6 — write-behind durability, scan and import performance

- Pin the engine to `572d4fb5f9d986accf2473858930c1e9bc3e5d57`, the merge of
  [PR #39](https://github.com/sanjevirau/fireside/pull/39) on the next.5
  engine. This exact revision passed the seven-job CI, the five-platform
  packed-install matrix and a representative private consumer's fresh,
  sequential official-then-Fireside full-data acceptance (two two-hour soaks,
  initial and post-restart browser journeys, lifecycle parity, fresh setup and
  regression commands, all with zero errors); see
  `support/phase-f-qualification.md`.
- Write-behind durability is the default
  ([#39](https://github.com/sanjevirau/fireside/pull/39)). A Firestore commit
  is acknowledged after its journal write and a non-durable redb commit; a
  background flusher (every second) and shutdown sync the journal, persist the
  commits with one durable redb commit and truncate the journal. Storage keeps
  the same contract with its own metadata journal and syncs uploaded files
  before the metadata that references them becomes durable. Killing the
  process loses nothing acknowledged (reopen replays the journal); only a
  kernel crash or power cut can lose the last interval. `--durability
  per-commit` restores the previous flush-per-write behaviour. Measured on a
  Mac: single document set 13.1 ms → 0.59 ms. In the consumer's Linux soak
  the write-commit median went from 23.9 ms with per-commit durability to
  3.2 ms (official emulator on the same host and workload: 197.5 ms) and the
  64 KiB Storage upload from 18.0 ms to 2.7 ms.
- Every HTTP front (REST, Storage, Auth, hub, UI, Requests feed) sets
  `TCP_NODELAY` on accepted connections, as the gRPC front already did
  ([#35](https://github.com/sanjevirau/fireside/pull/35)). A 64 KiB download
  over a reused keep-alive connection on Linux fell from 40.7 ms to 0.5 ms
  (Nagle waiting on the client's delayed ACK); fresh connections were
  unaffected.
- Queries not served in `__name__` order no longer decode every scanned
  document ([#38](https://github.com/sanjevirau/fireside/pull/38)). Stored
  values gain a field directory that lets filters, order keys, cursors and
  vector distances read one field path; only result pages are decoded.
  `__name__ ==`/`in` filters read the named documents directly and count-only
  aggregations use a dedicated `count` path. Values written by earlier
  versions stay readable without migration. On a 10,918-document collection
  of ~30 KiB documents: `orderBy` field limit 20 642 → 106 ms, `count()`
  737 → 91 ms, `__name__ in` ten ids 646 → 10 ms.
- REST `ListDocuments` for a named collection reads the scoped collection
  index instead of scanning the whole database
  ([#37](https://github.com/sanjevirau/fireside/pull/37)): `pageSize=1` on a
  211,202-document store 1.3 s → 1–4 ms.
- Fresh-start seed import runs inside one redb transaction with pipelined
  export decoding and concurrent Storage object copies
  ([#36](https://github.com/sanjevirau/fireside/pull/36)); Storage import of
  33,353 objects 11.1 s → 3.9 s on a Mac. Persistent resume is unchanged.
- Dependencies: `tower-http` 0.6.11 → 0.7.1 and `tokio-tungstenite` 0.29 →
  0.30 (Rust), `actions/setup-java` v6.0.1 (CI). No change to the pinned
  `firebase-tools` (15.22.0), the Rust toolchain or the package layout.
- Limitations recorded with this release: ordered full-collection scans and
  `count()` over a large collection of large documents still run at roughly
  half the Java emulator's speed (CPU-bound copying of every candidate's
  bytes out of redb), and fresh import of a large seed remains slower than
  the Java in-memory import (16 s versus 7 s in the consumer's measurement,
  the Java figure carrying no durable state). State written by this version
  carries the field directory and a durability journal, so it is not meant
  to be reopened by an older package version. Prerelease on `next`; no
  stable or universal-compatibility claim.

# 0.1.0-next.5 — Functions admission parity for upstream-ignored handlers

- Pin the engine to `40c9f3f4fd32e9cc4409b14bee5ba390b1bf3c12`, the merge of
  [PR #30](https://github.com/sanjevirau/fireside/pull/30) on the next.4
  engine.
- Fix a startup regression in next.4: the Functions host rejected every
  handler that firebase-tools 15.22.0 itself marks ignored. A published
  Extension function whose `extension.yaml` declares only `taskQueueTrigger`
  (for example `algolia/firestore-algolia-search`'s full reindex) is
  discovered by upstream without a trigger and ignored; the official emulator
  logs it and starts, next.4 failed with `discovered but not admitted`. The
  host now fails readiness only when upstream ignored a handler after a
  registration with this suite's own peers, and reports upstream-untypable
  handlers by identity and reason on stderr with an `ignoredCount` in the
  READY receipt. Those handlers still receive no deliveries, as on the
  official emulator.
- Announce each completed native routing refresh on stdout after a Functions
  source reload (`fireside functions routing refreshed: N registered
  functions`); upstream `/backends` lists a new handler slightly before the
  native topic table is replaced.
- Recaptured the `functions-readiness-v1` oracle with the upstream-ignored
  scenario and archived the owned-adapter verification receipt. No dependency
  version, toolchain or package layout change. Prerelease on `next`; no stable
  or universal-compatibility claim. Private consumer acceptance evidence for
  the next.4 engine is not re-run for this host-level correction; the
  representative consumer's real configuration (three extensions, full
  dataset) reached readiness with a private local build of the fix before
  publication.

# 0.1.0-next.4 — Phase A–F qualified engine

- Pin the engine to `fc54e341a6da4fc6ca26849287f92f335a6184ce`, the candidate
  that passed exact-source CI, all five platform install cells and a
  representative private consumer's full-data endurance, restart, parity and
  fresh-setup acceptance. See `support/phase-f-qualification.md`.
- Engine changes since next.3 cover the Phase A–E work: developer-tool
  inspection and request tracing, rules coverage, Functions readiness and
  reload contracts, state upgrade, low-disk and interrupted-export recovery,
  REST read projection/transaction semantics, canonical REST value/timestamp
  encoding, and cheaper nested-value serialization.
- Known limitations recorded with this release: under one consumer's
  concurrent two-hour workload, a limit-1 collection query and a 64 KiB
  Storage cycle had higher medians than the official emulator, while idle and
  light-load medians were at parity or better; Storage mutations pay an fsync
  by design; fresh-start import of a large dataset is slower than the Java
  in-memory import. Persistent-dataset resume was not measured in that run.
- No dependency version, toolchain or package layout change. Prerelease on
  `next`; no stable or universal-compatibility claim.

# 0.1.0-next.3 — independent source identity

- Replace the remaining consumer-shaped serialization inputs with independently
  captured, domain-neutral records from both pinned official emulators.
- Preserve all seven read transports, eight repetitions, value/order assertions,
  and memory/disk-WAL replay. No engine runtime or dependency version change.
- Pin the engine in the rewritten public history. Earlier package bytes and
  signed provenance remain unchanged; the new identity needs fresh platform
  build/install checks and protected publication approval.
- Keep previous dependency advisories and preview compatibility limits explicit.

# 0.1.0-next.2 — public distribution cleanup (published)

- Describe the generic local emulator preview without naming private consumers,
  linking their reports, or claiming universal compatibility.
- Keep private application acceptance separate from the public engine/hash receipt.
- Remove a consumer name from an unsupported-schedule diagnostic. No API, data
  format, supported schedule, state lifecycle or workload behavior changes.
- Check actual npm archive bytes before publishing: explicit file allowlist,
  no links/path traversal, no credential markers, and private-policy checks.
- Preserve earlier package versions and their evidence. This is not a new
  performance result or endurance qualification.
- All seven quality jobs and all five native platform cells remain required.
  Publication completed through a separately reviewed recovery of the original
  archives. No stable-release qualification is implied by registry tags.

# 0.1.0-next.1 — browser Auth repair

- Add the SDK-compatible local account picker and iframe event relay.
- Cover imported Google accounts, synthetic accounts, cancellation, redirect,
  persistence, Unicode and disabled-account rejection with captured fixtures.
- Accept credentials supplied through requestUri as well as postBody.
- Add private local-candidate packaging with distinct source-version identity.
- Keep disk/WAL, resume, export and platform lifecycle safeguards unchanged.
- Provider/tenant coverage remains limited; this is not real Google login or
  a universal Firebase compatibility claim.

# 0.1.0-next.0 — first installable preview

- One npm CLI selects an exact native package for macOS x64/arm64, Linux
  x64/arm64 glibc, or Windows x64. No Rust build or install-time downloader.
- Explicit compatibility-asset setup, read-only doctor, suite start/exec,
  disk/WAL persistence and graceful export-first shutdown.
- Existing Node and Java helper dependencies remain. See the package README
  for supported configuration and service limits.
- Version/source/checksum receipts identify the tested artifacts; platform
  checks are not universal application or performance qualification.
