# Combined-candidate qualification status

Updated 2026-09-17. Exact-source quality and platform qualification have passed.
A private representative consumer completed its paired cheap checks and frozen
sequential full-data/endurance/lifecycle run. This is not a release receipt or
permission to publish: final audit, scope limitations and registry-installed
verification remain separate from a harness's recorded PASS.

The audit found that one consumer cache assertion counted any WebSocket frame,
including a keepalive, as an update. That assertion does not establish cache
invalidation or support ranking its elapsed time as backend performance. A short
supplemental check outside the protected runner then correlated a
matching-document mutation with a typed update notification and the changed,
decoded Storage object on a fresh full-data store. It passed on both the
official emulator and the exact candidate, twice per backend plus a delete
round trip, so the invalidation path itself is verified. The original run and
its protected runner remain unchanged; no product correction or long rerun was
required. A first version of that supplemental check read from a bucket whose
rules deny anonymous reads and recorded HTTP 403; that was a test
misconfiguration, and the candidate enforcing Storage rules on the read is the
expected behavior. Raw consumer data, schema, logs and investigation fixtures
remain private and are not publication artifacts.

Known performance limitations of this candidate, from the same private
acceptance and short idle/light-load component measurements on one host:

- Superseded 2026-09-15. Under that consumer's two-hour concurrent workload,
  the first acceptance recorded a limit-1 collection query and a 64 KiB Storage
  upload/metadata/download/delete cycle with higher medians than the official
  emulator. Small tests then showed the harness was measuring its own process:
  every workload lane shared one start clock, and the memory/health sampler
  (a `/proc` scan and a full boot-journal capture) ran in the same event loop
  on that clock, so each timed read included the harness's own work; an idle
  observer process issuing the same read at the same instants saw idle latency
  throughout. The private harness was corrected (distinct lane phase offsets,
  out-of-process sampling, an idle observer control recorded beside every busy
  read) and both two-hour soaks were re-run on the same host, frozen seed and
  candidate binary. The query then measured about 6 ms in the busy process and
  7 ms in the observer, equal to its idle figure and about five times faster
  than the official emulator under the same load; the Storage cycle fell to
  about 56 ms but stays roughly five times the official cycle and 3.5 times its
  own idle cycle, and that remainder is unattributed because the cycle has no
  observer lane yet. The official emulator's own cells also improved once the
  clock was staggered, so the two acceptance tables are not comparable to each
  other. The engine did not change for this correction.
- Superseded 2026-09-16 by `0.1.0-next.6`. Storage upload and delete paid an
  fsync per mutation, and every Firestore commit paid a journal sync, a
  durable redb commit and a checkpoint, for immediate durability. Write-behind
  durability (acknowledge after the journal write, sync once a second and on
  shutdown, `--durability per-commit` to opt out) removed that cost: on the
  same host and workload the consumer's write-commit median went from 23.9 ms
  to 3.2 ms and its 64 KiB Storage upload from 18.0 ms to 2.7 ms. The
  remaining Storage-cycle gap of the re-measure was the server socket's Nagle
  delay on reused keep-alive connections (a 64 KiB download 40.7 ms reused
  versus 0.7 ms fresh), fixed by `TCP_NODELAY` on every HTTP front.
- Fresh-start import of a ~8 GB dataset (about 211,000 documents and 33,000
  objects) into the disk/WAL store was about 11 s slower than the Java
  in-memory import at the emulator-suite level. With `0.1.0-next.6`'s
  single-transaction seed import the consumer's whole-application readiness
  reached parity with the official stack (45.6 s versus 45.4 s), while a
  standalone Firestore import of the same seed is still 16 s versus 7 s: the
  Java emulator only deserializes into memory, Firenook builds a durable store
  and its field directory. Persistent-dataset resume is unaffected (about 2 s).
- Queries that read a whole large collection in field order, or count it, run
  at roughly half the Java emulator's speed on `0.1.0-next.6` (a 10,918
  document collection of ~30 KiB documents: `orderBy` limit 20 189 ms versus
  94 ms, `count()` 133 ms versus 84 ms on the consumer's host) because every
  candidate's bytes are copied out of the store to sort or count it. Point
  reads, equality and membership filters, offsets, collection groups, writes
  and first listener snapshots are faster than the Java emulator on that host
  (18 of the 26 measured shapes).

Peak resident memory of the native emulator process was about 88% lower than
the official main emulator process on the first acceptance run and 91.5% lower
on the `0.1.0-next.6` run (1.67 GiB versus 19.52 GiB sampled PSS; whole
application stack 4.65 GiB versus 23.18 GiB), and write-commit and
listener-delivery p99 were several times lower. Those figures describe one
host and one workload, not a universal guarantee.

## Publication and registry-installed verification

`firenook@0.1.0-next.4` and its five platform packages, pinned to
engine `fc54e341a6da4fc6ca26849287f92f335a6184ce`, were published on 2026-09-11
by [release run 34599776222](https://github.com/firenook-dev/firenook/actions/runs/34599776222)
from tag `npm-v0.1.0-next.4` at main commit `178dc0181f57df7d375f13bd29d385c3558150b1`.
All seven quality jobs, five fresh native platform builds with npm/Bun/suite
smokes, and the combined artifact verifier passed inside that run before the
protected `npm-release` environment was approved. Publication used OIDC trusted
publishing; the registry carries SLSA v1 provenance for each package.

Registry-installed verification, performed on macOS arm64 with `npm install
--save-exact --ignore-scripts` from the public registry into an empty project:
all six exact versions resolve; the registry `dist.integrity` of the CLI and
platform tarballs equals the SHA-512 of the reviewed release assets attached to
the [GitHub prerelease](https://github.com/firenook-dev/firenook/releases/tag/npm-v0.1.0-next.4);
`firenook binary-path` verifies the packaged native hash and exits 0; `npm
audit signatures` reports verified attestations. The `next` dist-tag points at
`0.1.0-next.4`; `latest` was not moved and remains a separate reviewed step.

The representative private consumer updated its exact pin to `0.1.0-next.4`
through its own reviewed dependency change. Node/firebase-tools for Functions
and Java for Storage rules remain explicit compatibility dependencies.

`0.1.0-next.4` could not start that consumer's default project: its three
Firebase Extensions include two task-queue handlers that firebase-tools 15.22.0
discovers without a trigger and ignores on the official emulator, and the
Functions host treated any upstream-ignored record as a startup failure. The
acceptance had not exercised extensions. The host now classifies ignored
records with the pinned service resolver: a handler upstream cannot type is
reported with its reason and counted in the readiness receipt, while a handler
that fails registration with this suite still fails startup. The oracle fixture
gained an extension-shaped backend built with the pinned host's own
`extension.yaml` normalizer. That correction is `firenook@0.1.0-next.5`
(engine `40c9f3f4fd32e9cc4409b14bee5ba390b1bf3c12`, tag `npm-v0.1.0-next.5`,
[release run 34675478799](https://github.com/firenook-dev/firenook/actions/runs/34675478799),
[prerelease](https://github.com/firenook-dev/firenook/releases/tag/npm-v0.1.0-next.5)):
registry contents and attestations were verified against the release assets
for all six packages, `next` now selects `next.5`, and `latest` still selects
`next.2`. The engine is otherwise the qualified candidate plus that host
correction and a stdout announcement after each Functions routing refresh, so
the full-data acceptance was not re-run; the consumer verified the correction
with a private local build on its real three-extension project before
publication and pinned `next.5` exactly.

`firenook@0.1.0-next.6` pins engine
`572d4fb5f9d986accf2473858930c1e9bc3e5d57` (the merge of PR #39 on `main`:
`TCP_NODELAY` on every HTTP front, the single-transaction seed import, scoped
REST listing, lazy scan decoding and write-behind durability by default). That
exact engine passed the seven-job CI on its merge commit
([run 35089506458](https://github.com/firenook-dev/firenook/actions/runs/35089506458))
and, as the release PR's head, the five-platform packed-install matrix; the
prior head of PR #39 had failed the Windows packed install (Storage metadata
flush through a read-only handle, `Access is denied`), which was corrected
before the merge and is retained as a failure. The representative private
consumer then ran its full paired acceptance on that engine (2026-09-16): a
fresh official-then-Firenook sequence with no banked baseline and no host
waiver, two two-hour soaks, initial and post-restart browser journeys,
lifecycle parity, fresh setup and regression commands, all with zero errors,
60,000 of 60,000 listener deliveries on both backends and no swap activity on
Firenook. A first attempt on the same inputs failed before any measurement
when the official emulator's editor page did not load within 300 s; it is
retained as a failure, not relabelled. The consumer's private report holds the
raw evidence and an independent audit that re-derives every percentile and
memory peak from the recorded samples.

`0.1.0-next.6` was published on 2026-09-16 (UTC) by
[release run 35132738094](https://github.com/firenook-dev/firenook/actions/runs/35132738094)
from tag `npm-v0.1.0-next.6` at main commit
`65d9dce6067c8885ae7bb92c9c63322435e48c07` (the merge of release PR #40). All
seven quality jobs, five fresh native platform builds with npm/Bun/suite
smokes and the combined artifact verifier passed inside that run; the
downloaded artifacts were re-checked locally with
`publish-packages.mjs --check` before the protected `npm-release` environment
was approved. Publication used OIDC trusted publishing. Registry-installed
verification on macOS arm64 (`npm install --save-exact --ignore-scripts` into
an empty project from the public registry): all six exact versions resolve,
`firenook --version` reports the package version and engine
`572d4fb5f9d986accf2473858930c1e9bc3e5d57`, `firenook binary-path` verifies the
packaged native hash and exits 0, `npm audit signatures` reports verified
attestations, and the registry `dist.integrity` of every tarball equals the
SHA-512 of the corresponding asset on the
[GitHub prerelease](https://github.com/firenook-dev/firenook/releases/tag/npm-v0.1.0-next.6).
`next` now selects `0.1.0-next.6`; `latest` still selects `next.2` and remains
a separate reviewed decision.

Consequently a consumer-side extensions admission gate is now a required
receipt before any pin bump: it starts the consumer's real project with its
extensions through the normal launcher and checks the installed CLI against an
inventory captured from the official emulator on the same project (every
extension backend and handler with the same trigger kinds, upstream-ignored
handlers reported and counted rather than fatal, a clean stop). It fails on
`next.4` with the original error and passes on `next.5`. Acceptance evidence
recorded with extensions omitted does not stand in for it.

Candidate `fc54e341a6da4fc6ca26849287f92f335a6184ce` passed all seven jobs in
[CI 34538321458](https://github.com/firenook-dev/firenook/actions/runs/34538321458)
and all five native build/install jobs plus the combined verifier in
[packages 34538321468](https://github.com/firenook-dev/firenook/actions/runs/34538321468).
All five downloaded sets passed `check-local-platforms.mjs` locally too.
The [receipt](../benchmarks/results/phase-e/source-qualification.json) preserves
exact versions, archive hashes and npm/Bun/full-suite checks. The prior attempt
failed on a Windows LF-only test assertion before its native build; the corrected
test checks both LF and CRLF and still rejects an incorrect release guard.
That failed attempt is not relabelled as a pass.

The previous Installable packages workflow intentionally built the engine in
`packages/cli/release.json`. A PR's green package run therefore does not prove its
new Rust source built on every platform. Do not change that release pin merely
to test an unpublished engine.

Pull-request package checks now use the immutable PR head SHA for both packaging
source and engine, not GitHub's temporary merge SHA. For a reviewed combined
commit without an applicable PR, use the workflow's explicit `candidate` input
on the branch pointing at that exact commit. That manual mode builds `github.sha`,
checks the native checkout identity, and creates existing private local-package
identities on Linux x64/arm64, macOS x64/arm64 and Windows x64. Each platform
runs the existing npm/Bun packed installs and full synthetic suite smoke.
The combined checker verifies all five platform sets, native and CLI identities,
artifact hashes, private flags and all three smoke receipts. CLI packages are
intentionally host-specific in this local-only mode, so their hashes need not
match across platforms. They cannot enter the unchanged public publish path.
Product, Rust lock/toolchain, Functions host and fixture changes are included in
the package workflow's path filter. Documentation/evidence-only changes do not
automatically rebuild five native platforms.

Record the exact source commit, workflow run, all job results and artifacts.
This check requires neither npm login nor publication permissions. Release
workflow calls omit the candidate input and keep their existing pinned build
and publication verifier. No tag or registry version is created by candidate
qualification.

Exact-source CI and platform qualification do not replace private consumer
cheap-smoke prerequisites and frozen full-data/endurance/lifecycle checks.
An active unrelated workload must not be stopped to obtain a clean venue.
Do not replace changed-candidate acceptance with a previous binary's soak or
with small generic measurements. The final report must separate native emulator
memory from Java, Functions and application processes and preserve deviations.
