# Pipeline: from a change to a release

This is the record of how a Fireside change is proven, measured and shipped.
`AGENTS.md` is the short form. The vocabulary rule there applies here: the
consumer, the private harness, the private acceptance host and the private
consumer seed are named only as such.

## Principles

- **The official emulator is the specification.** Behaviour is recorded from a
  pinned official emulator (or an authorized synthetic cloud project) into a
  frozen fixture before Fireside is changed. Replays are deterministic and run
  anywhere.
- **Regressions are caught by deterministic checks, not wall-clock timing.**
  Fixture replays, Rust tests and counters run on shared CI without noise.
  Wall-clock latency, startup time and memory are measured only on the private
  acceptance host.
- **The 2-hour paired soak is a release instrument.** It qualifies a release
  line; it is not the per-change regression test.
- **Private references point at public, never the reverse.** The private
  harness pulls a public candidate by hash. This repository holds only the
  resulting numbers.

## Layers

| # | Layer | Where | Typical time | Exit criterion |
| --- | --- | --- | --- | --- |
| 1 | Oracle recording — a new or extended conformance fixture for the behaviour | contributor machine | minutes to an hour, once | fixture frozen: `SHA256SUMS`, README, `benchmarks/*.json` receipt |
| 2 | Implement and replay the touched fixture | contributor machine | seconds per iteration | touched fixture 100 % |
| 3 | Deterministic PR gate | GitHub CI | ~15 min, parallel jobs | every corpus replays; Rust gate; packaging checks; SDK browser matrix; five-platform packed installs; independence check |
| 4 | Review | human | — | behaviour changes cite the oracle diff; performance claims cite numbers (see below) |
| 5 | Consumer gates on the packed candidate | private harness, private acceptance host | ~10 min | the consumer's integration and extensions gates, its browser journeys, an offline vendored start |
| 6 | Candidate benchmark | private acceptance host | ~30 min | readiness, latency lanes, peak memory, lifecycle parity against the previous release row and the banked official row; no lane regresses beyond its recorded band |
| 6b | Bank an official row | private acceptance host | ~30 min, only when a lane is added or the official toolchain, seed or harness changes | stored keyed by those identities; a stale key is never compared |
| 7 | Release qualification | private acceptance host | ~2.5 h (Fireside soak, export/restart, fresh-setup stages); the official 2 h row only when its key changed | `result.passed`, checksums, an independent audit of the evidence, the phase receipt's `receipts` block |
| 8 | Release | GitHub + npm | ~20 min | tag, protected `npm-release` approval, registry integrity equals the release assets, consumer pin bump |

Layers 1–4 and 8 live in this repository. Layers 5–7 run from the private
harness and report back as numbers.

## What each layer proves

**Correctness** is settled in layers 1–3. A behaviour is correct when the
official recording replays without divergence, or when the divergence is
recorded in the replay's divergence table with its reason and the adopted
behaviour. Weakening a threshold, dropping an assertion or widening an
allowlist to make a capture pass is never acceptable.

**No regression** is layer 3's job and must stay deterministic: replay
counts, instruction/allocation/syscall counters where they exist, binary
size, and short leak guards (an RSS delta after a fixed number of operations,
bounded far below what a real leak would produce).

**Numbers** come from layers 6 and 7 only. A published figure names the lane,
both values, the candidate hash, the host spec, the comparison row and the
run it came from.

**Stability** over hours, export/restart cycles and a fresh setup is layer 7,
once per release line.

## Comparison rows

Two rows exist for every lane: the previous Fireside release and the official
emulator. The official row is banked from a layer-6b run keyed by the official
toolchain version, the seed identity, the harness identity and the lane set;
any key change invalidates it. A new lane therefore always starts with one
official measurement. The official emulator's multi-hour memory growth figure
is a property of that emulator and is refreshed only with its toolchain.

## Launch discipline for long runs

A long run fails in its first minute or not at all: disk needed by every
stage is computed at launch, launch windows are checked against the
consumer's scheduled functions so neither stack straddles a schedule the
other does not, and a transient browser verifier swap is retried once. A run
that fails after measurement is retained as a failure and rerun; it is never
resumed or relabelled.
