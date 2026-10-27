# Contributing

## Issues

Open an [issue](https://github.com/firenook-dev/firenook/issues/new/choose)
with one of its forms: a bug, a difference from the official emulator, or a
feature request. [Report a problem](https://firenook.dev/docs/help/report)
says what to include. A security problem goes privately through
[vulnerability reporting](https://github.com/firenook-dev/firenook/security/advisories/new),
never in an issue.

## Pull requests

For more than a small fix, open an issue first, so the change is agreed
before you write it. A pull request makes one change, with a test that fails
without it, and passes the checks under [Building and testing](#building-and-testing).

## AI tools

AI tools are welcome, in issues and in code. Say in the issue or pull request
which tool helped and how much. A person must have seen the problem a report
describes, and must understand every line of a change they submit; an issue
or pull request that reads as unreviewed AI output is closed. Coding agents
working in this repository follow [AGENTS.md](AGENTS.md).

## Changing the engine

1. Reproduce a protocol issue against a pinned official emulator, authorized
   synthetic cloud project, or readable official client implementation.
2. Commit the independent synthetic fixture before a behavior change. Preserve
   target/version, input, observed output, provenance and checksums. Constructed
   unit models must not be presented as live oracle captures.
3. Implement a bounded product correction and update DESIGN.md. Do not remove
   regression assertions, weaken thresholds or broaden an error allowlist to
   make a capture pass. Keep failed diagnostic evidence outside public fixtures.
4. Run Rust quality, generic fixture/replay tests, the pinned SDK matrix and the
   required native package checks. Platform skips must be reported honestly.
5. Test reviewed immutable candidates in private consumer environments using
   private local packages or explicit native-binary overrides. Do not commit
   consumer schemas, rules, trigger inventories, datasets, logs or environment.

Public source must build/test without access to a private consumer checkout.
Production cloud traffic requires explicit authorization and tiny synthetic
fixtures. Package publication and source visibility are release-owner actions,
not implied by a green test or a merged product change.

## Building and testing

Install the toolchain in `rust-toolchain.toml`, Node 24.20.0 and npm 12.0.2.
Browser tests require Chrome/Chromium; recording the official oracles requires
Java, firebase-tools 15.22.0 and their exact documented emulator artifacts.
The product itself runs neither Java nor firebase-tools; CI verifies a suite
start with `java` absent from `PATH` and replays the Functions/Extensions
corpus against a project whose `node_modules` holds only the Functions SDK.

```sh
cargo test --locked --workspace --all-targets --all-features
cargo clippy --locked --workspace --all-targets --all-features -- -D warnings
npm ci --prefix conformance
npm run check --prefix conformance
npm test --prefix conformance
npm run test:firenook:disk --prefix conformance
node --test packaging/*.test.mjs
```

A source build can serve Firestore alone with bounded coverage:
`cargo run -p firenook -- firestore --diagnostics --rules firestore.rules`.
Recording is opt-in for that standalone command; `--websocket-port` also
enables it and serves the Requests feed on that port. To try a reviewed
candidate in your own application without publishing it, use
[local packages](packaging/LOCAL-DEVELOPMENT.md).
[DESIGN.md](DESIGN.md) describes the component boundaries.

## Independence

This repository never names the consumers it is tested against, the hosts it
is measured on, private repositories, people or personal paths (see
`AGENTS.md` for the vocabulary to use instead). `node scripts/check-independence.mjs`
scans every tracked file with built-in patterns, the project's former name
(sealed corpora, banked results and release history keep it; see `AGENTS.md`)
plus a private term list that is never committed; CI runs it on the tree and
on the commit messages of a change. Install the local hooks once:

```sh
git config core.hooksPath .githooks
```

## License of contributions

Firenook is licensed under the Apache License 2.0 ([LICENSE](LICENSE)).
Unless you say otherwise, a contribution you submit for inclusion is
licensed under the same terms (section 5 of the license), and you confirm
that you have the right to submit it. A contributor license agreement is
planned before the first external pull request is merged; until then, the
Apache License's own contribution clause applies. The Firenook name and mark
are not licensed with the source; see [TRADEMARKS.md](TRADEMARKS.md).
