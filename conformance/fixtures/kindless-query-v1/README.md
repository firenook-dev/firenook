# Kindless queries and `recursiveDelete`

Independent live capture from the official Firestore emulator 1.22.0, using only
synthetic documents and local callers. The jar, Node, Java and SDK identities
are recorded in `fixture.json`. `passed` means the capture completed, not that
every request succeeded. No production project or consumer data is used.

A kindless query is an all-descendants selector with no collection id. It is the
query the Admin SDK's `recursiveDelete` sends: names only, 5,000 at a time, with
a `__name__` range for a collection and a cursor for the next page.

Observed contracts:

- Results sort by path segment with numeric ids first, not by the bytes of the
  path: `rd/__id5__`, `rd/A`, `rd/a`, `rd/a/sub/x`, `rd/ghost/sub/z`,
  `rd-sibling/a`, `rd0/a`.
- A parent document need not exist, and a parent with nothing below it is empty.
- Only `__name__` may filter or order: a field filter answers `INVALID_ARGUMENT`
  `kind is required for filter: <field>`, a field order or field inequality
  `kind is required for all orders except __key__ ascending`, and a descending
  name order `FAILED_PRECONDITION`. A `__name__` filter on a non-reference value
  answers `__key__ filter value must be a Key`.
- `count()` works; `sum()` is refused with the order error.
- Security Rules apply to signed-in and signed-out callers, and a match must cover
  the whole subtree queried. `match /rd/{doc}` does not prove a query at the
  root; `match /top/parent/{rest=**}` proves one under `top/parent`, not above
  it. The owner bypasses rules.
- One database's kindless query never sees another's documents.

Two official behaviours worth knowing:

- **A kindless listener gets its first snapshot and no change after that.** The
  `control-collection` listener runs the same driver on a plain collection and
  does hear its changes, so the empty list is the emulator's answer. It also
  shows a change repeated on the plain collection, which the replay compares as
  a set.
- **A selector with an empty id and no `allDescendants`** lists the direct
  children of every collection under the parent. No SDK sends it.

## Replay and differences

`conformance/test/kindless-query-replay.test.mjs` runs the same observations
against the native engine, in memory and on disk, and lists each accepted
difference with its reason:

- The native engine keeps refusing the empty-id selector without
  `allDescendants` (`INVALID_ARGUMENT`).
- A parent that names a collection is `INVALID_ARGUMENT` in both, with a
  different wording over gRPC.

The Google client takes about seven seconds to report a refused stream, from
either emulator, so the read-only cases run concurrently.

Reproduce with Node 24.20.0 and
`node conformance/src/suite/capture-kindless-query.mjs <fresh-output-directory>`.
The driver starts and stops only its own official emulator.
