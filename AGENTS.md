# Working in this repository

Firenook is an independent, open-source Firebase emulator. Read this file
before changing anything; `support/pipeline.md` has the long form.

## Independence rule

This repository stands on its own. It never names, quotes or links the private
things around it: the consuming applications it is tested against, their
products, companies or people, the hosts it is measured on, private
repositories, or paths on anyone's machine. Use these nouns instead:

| Say | Never say |
| --- | --- |
| the consumer, the consumer codebase, the consumer's rulesets | a company, product or application name |
| the private consumer seed (with its size) | a dataset name or where it lives |
| the private acceptance host (with its CPU/RAM spec) | a provider, hostname or address |
| the private harness, the private acceptance | a private repository name |
| `<home>` / `{{home}}` placeholders in fixtures | a personal path |

Numbers, hardware specs, tool versions and commit hashes of *this* repository
are fine; identities are not. `node scripts/check-independence.mjs` enforces
the rule on every tracked file and, in CI, on commit messages; install the
hooks once with `git config core.hooksPath .githooks`. The private term list
is never committed here.

The same script fails on the project's former name (it was published as
"Fireside" up to `0.1.0-next.9`). The name survives only where it was
sealed: the frozen oracle corpora and their READMEs, the banked benchmark
results, the digest-pinned gate manifests, the release history and the
recovery receipts, plus the recorded identifiers those corpora carry
(`demo-fireside-*` project ids and the like, which the harness and the gates
must keep naming exactly) and the README's rename note. Everything else says
Firenook; do not add aliases of the old command, package or variable names.

Consumer-specific commands, gate names and documentation edits belong in the
consumer's own repository; here they are "the consumer integration gate",
"the consumer extensions gate", "the consumer's setup documentation".

## How a change moves

1. **Oracle first.** Record the official emulator's behaviour as a synthetic
   conformance fixture (`conformance/fixtures/*`, frozen with `SHA256SUMS` and
   a `benchmarks/*.json` receipt) before changing behaviour. Constructed
   fixtures are never presented as live captures.
2. **Implement and replay locally.** `cargo test --locked --workspace`, then
   replay the fixture you touched (for example
   `npm run replay:functions:runtime --prefix conformance -- --binary …`).
3. **Deterministic PR gate.** CI replays every corpus, runs the Rust and
   packaging checks, the pinned SDK browser matrix, the five-platform packed
   installs and the independence check. Never weaken a threshold, drop a
   regression assertion or widen an allowlist to make a capture pass; record a
   real divergence in the replay's divergence table with its reason.
4. **Private consumer gates and benchmarks** run from the private harness
   against the packed candidate, on the private acceptance host. Their results
   come back here only as numbers in a `benchmarks/*.json` receipt or a
   `support/phase-*.md` status line, in the vocabulary above.
5. **Release qualification** is the private paired acceptance recorded in the
   phase receipt (`receipts` block). Publication is a release-owner action:
   tag, protected `npm-release` approval, registry verification. A green test
   never implies a release.

## Performance claims

Need numbers from a recorded run: the lane, both values, the host spec, the
candidate hash and the comparison row (previous release or the official
emulator), and they must not regress any measured lane. Startup, memory and
latency figures come from the private acceptance host; never from a shared CI
runner.

## Layout

- `crates/` — the Rust workspace (`firenook` CLI, suite runtime, one crate per
  emulated service).
- `conformance/` — TypeScript oracle capture and replay tooling plus frozen
  fixtures.
- `packaging/`, `packages/cli/` — npm packaging, local candidate builds,
  release checks.
- `benchmarks/` — frozen gate receipts per phase; `support/` — phase plans and
  status; `DESIGN.md`, `COMPATIBILITY.md`, `ROADMAP.md` — the product record.
