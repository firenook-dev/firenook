# Contributing

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
