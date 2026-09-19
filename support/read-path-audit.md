# Read-path audit: whole-store scans and shared-runtime stalls (`0.2.0-next.2`)

**Status (2026-09-20): implemented and merged-ready on the `0.2.0-next.1` engine;
publication waits for the release owner.** This is a fix round, not a roadmap
phase: no new service, no new API. It came out of a consumer report that the
official Emulator UI's Firestore data browser took seconds per refresh against
a private consumer seed (211,260 documents, 33,354 Storage objects, 8.3 GB
persistent store) and that the Auth tab was slow at the same time.

## What the UI does

The Emulator UI (Google's `ui-v1.15.0` bundle, served by Firenook) polls three
REST metadata operations every 10 s while the Firestore tab is open:
`documents:listCollectionIds` (the root column), `documents/{collection}?
mask.fieldPaths=_none_&pageSize=300&showMissing=true` (missing-document
placeholders) and `documents/{document}:listCollectionIds` (the selected
document's sub-collections). Its document list itself is one SDK `Listen` with
`limit(9500)`.

## Findings

Every service runs on one Tokio runtime with `min(cores, 4)` workers. Two
defect classes were found in the audit, both engine-side:

| # | Defect | Where |
| --- | --- | --- |
| 1 | `ListCollectionIds` (root and per document) iterated **every document of the database** and copied each encoded body | `grpc-front::service::list_collection_ids` |
| 2 | `ListDocuments` with `show_missing`, and without a collection id, did the same | `grpc-front::service::collect_list_documents` |
| 3 | The REST `runAggregationQuery` materialized and decoded every result for a `count`; the gRPC path was already lazy | `rest-front::run_aggregation_query` |
| 4 | The lazy `count` still copied each document body; no index-only path | `query-engine::count` |
| 5 | Recursive delete and clear-database re-scanned the whole database per 500-document batch, copying bodies | `rest-front::delete_path`, `clear_database` |
| 6 | Every Firestore read handler ran inline on the shared async workers, so four slow reads froze Auth, Storage, the Hub and the UI's own endpoints | every read handler; `listen` initial evaluation and refresh; suite export |
| 7 | The REST query decoder ignored `select` (the gRPC codec honoured it): a projected query returned whole documents | `rest-front::decode_query` |
| 8 | Read-only Auth operations (`accounts:lookup`, `accounts:batchGet`, `accounts:query`, …) serialized and rewrote the whole Auth state file under the global lock | `auth-front::Runtime::scope` |
| 9 | The Requests-diagnostics loss report printed one line per second under load, and events were serialized under the buffer lock, so concurrent evaluations contended and were omitted as "busy" | `rules-runtime::request_history`, `suite-front::requests` |
| 10 | Listen streams polled the store every 10 ms each; the Functions bridge already had a push observer | `grpc-front::listen` |
| 11 | A change anywhere in a listened collection re-ran the whole query and deep-compared every visible document | `watch-broker::WatchTarget::refresh_with_changes` |

Auth lookups (indexed), Storage listing (prefix range) and persistence
(journal + write-behind), Pub/Sub, Cloud Tasks, Functions dispatch and the Hub
were audited and found sound.

## Fixes

- **Key cursor.** `Snapshot::key_cursor(database, prefix)` walks document keys
  under a path prefix in byte order without touching bodies, on both backends
  and through the snapshot overlay, and `seek` skips a subtree in one B-tree
  descent. `direct_collection_ids` and `direct_children` build on it: one skip
  per collection or per child, never a visit per document. A present child's
  subtree is skipped only once the walk is inside it, because `abc-2` sorts
  between `abc` and `abc/…`; the store test pins that ordering on both
  backends, with overlay-only deletions and additions.
- **Index-only count.** `Snapshot::count_collection` / `count_collection_group`
  count the collection indexes (overlay-adjusted); `query_engine::count` uses
  them whenever no filter, cursor, field order or `limit_to_last` narrows the
  scope, then applies `offset`/`limit`. The REST aggregation handler now uses
  the same lazy `count` path as gRPC for count-only aggregations.
- **Read pool.** `FirestoreService::run_read` runs CPU-bound reads on the
  blocking pool with one permit per core (at least two): listings, batch
  gets, aggregations, partitions, pipelines, planning of queries, the initial
  evaluation and every refresh of listen targets, and the REST query and
  aggregation handlers (whose JSON body is built there too). `RunQuery` results
  are produced by a blocking producer into a bounded channel (64 responses)
  paced by the client, and a transaction's read set still grows exactly as the
  client consumes results. The suite's Firestore export moved to the blocking
  pool as well.
- **REST `select`.** Decoded exactly like the gRPC codec. Recorded first
  against the official emulator: `REST v1 runQuery honors select projections
  and count aggregations` in `conformance/test/rest.test.ts` passes on
  firebase-tools 15.22.0 (Java) and on both Firenook backends.
- **Recursive delete / clear.** Walk keys under the path (or the database)
  with the cursor; bodies are never read.
- **Auth persistence.** `ProjectState`, `AgentState` and `AuthData` carry
  never-serialized mutation counters bumped by every state-changing method;
  `Runtime::scope` serializes the state only when the generation changed and
  writes the file after releasing the data lock (writes are serialized by
  their own lock). `reads_never_rewrite_the_state_file_and_writes_still_do`
  pins it.
- **Requests diagnostics.** Admission stays a non-blocking probe (a contended
  producer still neither waits nor allocates; the sealed Phase B test holds),
  but serialization now happens outside the lock, bounded to 16 concurrent
  events, so the lock is held for the push alone. Omissions are counted by
  reason (busy / oversized / invalid) and the stderr report is summarized at
  most once a minute.
- **Commit notifier.** The service registers a `CommitObserver` that feeds a
  `watch` channel; listen streams wake on commits and keep a 1 s fallback poll.
- **Incremental listeners.** `IncrementalQuery` (query engine) exposes scope
  and filter membership, sort keys and projection for one document.
  `WatchTarget` keeps each visible document's sort key and applies the keys
  touched since its revision directly to the view: additions, removals,
  modifications, and window entry/eviction for a full `limit` window, using
  the cached sort keys to find the window's last entry. It falls back to a
  full evaluation only when a document leaves or moves within a full window,
  or when the query uses `offset`, `limit_to_last` or nearest-neighbor
  ranking. Changes are applied to a copy, so a fallback part-way through
  leaves the view untouched. A randomized property test (`incremental_views_
  always_equal_a_full_evaluation_on_both_backends`, 3 seeds × 60 steps × 12
  query shapes × 2 backends in the suite; a 24 × 400 pass was run once
  locally) asserts after every commit that the view equals a fresh evaluation
  and that replaying the emitted changes onto the previous view reproduces it.

## Developer-machine observations

Not acceptance numbers: measured on this checkout's host (Apple M2 Pro,
12 cores, 32 GiB, macOS) against a copy-on-write clone of the private consumer
seed above, the published `0.2.0-next.1` binary versus a release build of this
branch, each on its own clone with `--only firestore,auth,storage --no-ui`
and idle otherwise. The acceptance-host round records the release lanes.

| Operation | `0.2.0-next.1` | this branch |
| --- | --- | --- |
| root `listCollectionIds` (28 collections) | 1.69 s / 1.55 s | 24 ms cold / 0.5 ms |
| `documents/{doc}:listCollectionIds` | 1.79 s | 3 ms |
| `listDocuments … showMissing` (10 children) | 1.28 s | 5 ms |
| `listDocuments … showMissing` (10,918 children, page 300) | 2.04 s | 112 ms |
| `count()` on 10,918 documents, no filter | 0.94 s | 4 ms |
| `count()` on 6,161 large documents, no filter | 0.29 s | 80 ms |
| REST `runQuery … select __name__`, 50 results | 3,164,601 B | 12,651 B |
| tiny `runQuery` issued during four concurrent root `listCollectionIds` | 2.78 s | 0.7 ms |
| server-confirmed listener update after a write into a listened 9,500-document window (3 writes + 1 update) | 0.84–1.03 s | 38–69 ms |
| write to an unrelated collection while that listener is open | 972 ms → 37 ms across runs (worker starvation) | 28–42 ms |
| `listDocuments` page of 300, present documents only | 22 ms | 23 ms |
| `runQuery` limit 50 | 59 ms | 63 ms |
| initial 9,500-document listen (about 500 MB of documents) | 7.5–10.6 s | 7.8–10.8 s |
| whole 10,918-document collection as one REST body (595 MB JSON) | 13.5 s | 14.3 s |

The last three rows are the cost of the payload itself (decode, encode,
transport) and were not targets of this round; they no longer occupy an async
worker. On the loaded consumer machine that reported the problem the same
scans took 6–14 s and a concurrent Auth `accounts:query` waited 14 s behind
four of them.

## Verification

- `cargo test --workspace`: 49 suites green; `cargo clippy --workspace
  --all-targets --all-features -- -D warnings` clean; `cargo fmt --check`.
- Conformance `test:firestore` + `test:control`: 37/37 on the official
  emulator (firebase-tools 15.22.0, Java 25), 37/37 on Firenook in memory
  and disk modes. Auth oracle replay: 61 programs, 1,068 steps, 17,303
  values, 0 mismatches.
- The release build resumed the consumer seed clone (`--resume-state`) and
  stopped cleanly with 211,260 documents, 1 user and 33,354 objects.

## Left for a later round

- The per-document cost of large payloads (rows above): a streaming REST
  encoder and a cheaper WebChannel framing would help the initial listen and
  whole-collection reads, and are independent of this audit.
- The REST body is still assembled as one JSON value before it is sent.
- Filtered counts still copy each candidate body to read the filtered field;
  a borrowed field decode would remove that copy.
