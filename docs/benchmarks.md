# Benchmarks

[Docs](README.md) · Benchmarks

Firenook 0.2.0 against the official Firebase emulator (firebase-tools 15.22.0
on Java 26 with its default settings), measured on 21–22 October 2026. Every
figure on this page comes from one recorded run whose numbers are kept in
[`benchmarks/020-paired-acceptance.json`](../benchmarks/020-paired-acceptance.json).
The 0.2.0-next.6 run of 18–19 October is kept in
[`benchmarks/next6-paired-acceptance.json`](../benchmarks/next6-paired-acceptance.json).

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/benchmark-dark.svg">
  <img alt="Firenook against the official emulator: 10 times less memory, writes 40 times faster, listener updates 19 times faster, restarts 52 times sooner, orderBy with a limit 8 times faster, 61% less CPU" src="assets/benchmark-light.svg" width="880">
</picture>

## What ran

- **One server**: an AMD Ryzen 5 3600 (6 cores, 12 threads) with 64 GiB of
  memory and NVMe storage, Ubuntu 24.04, Node 24.20.0. One emulator at a time,
  official first, each from a clean start, nothing else running.
- **One real application and its data**: a production web application with its
  API, a Functions codebase and a cache worker, on a copy of its data: 211,205
  Firestore documents, 33,352 Storage objects (6.7 GB) and one Auth user. Both
  stacks ran the same application revision and had to end with identical data.
- **Two hours of its traffic per emulator**: writes from two busy sessions, open
  listeners, a filtered query every 15 seconds, a Firestore-triggered function,
  and a Storage upload, metadata read, download and delete, plus an idle second
  client issuing the same reads. Latency is measured by the client, from call
  to answer, for every operation: 5,280 writes and 60,000 listener updates per
  emulator, every one delivered.
- **Then each emulator on its own**: Firestore, Auth and Storage with the same
  data and no application, for starts, stops, query shapes, an upgrade from
  0.2.0-next.8 and a store grown to 2.5 million documents.

## Two hours of an application's traffic

| Median / 99th percentile, ms | Official | Firenook | Median |
| --- | ---: | ---: | --- |
| Write, acknowledged | 208.2 / 279.8 | 5.1 / 50.6 | 40× faster |
| Listener update after a write | 209 / 258 | 11 / 60 | 19× faster |
| Filtered query under load | 33.1 / 44.1 | 6.6 / 31.0 | 5.0× faster |
| The same query from an idle client | 32.6 / 43.8 | 7.1 / 30.9 | 4.5× faster |
| Firestore-triggered function | 3.80 / 8.02 | 3.11 / 4.49 | 1.2× faster |
| Storage upload, metadata, download, delete | 17.8 / 26.8 | 8.6 / 11.8 | 2.0× faster |

Both emulators completed exactly the same operations with no error, stall or
lost update, and Firenook was faster at the median and at the 99th percentile
on every row. Within the Storage cycle, downloads were the one step where it
was not: 2.30 / 5.01 ms against 2.12 / 4.31 ms.

## Memory, CPU and disk

| Over the two hours | Official | Firenook |
| --- | ---: | ---: |
| Emulator memory, peak (PSS) | 22.57 GiB (Java) | **2.11 GiB** |
| Emulator memory, first → last sample | 15.42 → 22.57 GiB | 1.64 → 1.67 GiB |
| Whole stack, peak (emulator and application) | 38.83 GiB | 17.43 GiB |
| Emulator CPU time | 1,586 s | **616 s** |
| Disk written by the whole server | 3.66 GB | 1.83 GB |

The official emulator keeps all data in its Java heap and kept growing for the
whole run; Firenook keeps data on disk and caches what it reads. Most of what
the official stack's server wrote was swap: it paged out 3.1 GB during the two
hours, where Firenook's stack paged out nothing. Firenook's writes are its
data, since every acknowledged write is durable within a second; the official
emulator writes its data only when it exports. The application's own web
server peaked at about 12.1 GiB on both stacks, so most of Firenook's stack
total is the application.

## Start, stop and start again

Firestore, Auth and Storage with the same data, no application. To keep its
data, the official emulator exports on every stop and imports on every start;
Firenook keeps its data and picks it up.

| | Official | Firenook |
| --- | ---: | ---: |
| First start, importing the data | 56.7 s | 28.3 s |
| Start again with the data | 30.7–31.7 s | **0.59–0.60 s** |
| Stop with the data saved | 54–58 s (export) | **0.05–0.26 s** |
| Memory once ready | 6.9 GiB | 0.16 GiB |
| Memory after the 26 query shapes | 11.9 GiB | 0.65 GiB |

Every Firenook stop left its data files closed cleanly, so no start needed a
repair. Both first starts took longer than in the 0.2.0-next.6 run (35.0 s and
18.3 s then), and so did 0.2.0-next.8's on the same day (29.4 s), so the
difference is the server's on the day, not the release's. After reading the
data, 0.2.0 takes about 2.5 s more than 0.2.0-next.8 to be ready: it builds the
ordered index (4.3 s against 1.8 s from the last document read to ready).

Inside the full application both stacks start from an import (the run restarts
from an export), and the application compiles its web server at the same time.
The stack was ready in 55.7 s on Firenook against 86.5 s, and in 42.9 s against
86.8 s after the restart. Stopping it after the two hours, with the official
emulator exporting, took 29.6 s against 79.8 s, and a fresh checkout of the
application was ready in 64.8 s on Firenook against 100.6 s on the official
emulator.

## Upgrading from 0.2.0-next.8

0.2.0 replaces the equality index of earlier releases with an ordered one. The
first start of 0.2.0 on a store 0.2.0-next.8 wrote (the same 211,202 documents,
3.3 GB) builds it once:

| Start on next.8's store | Ready |
| --- | ---: |
| First, building the ordered index | 8.0 s (7.4 s of it indexing) |
| Every start after | 0.61 s |

0.2.0-next.8 opens a store 0.2.0 has written, and builds its own index again
the same way.

## A store grown to 2.5 million documents

The same data grown by 2,500,000 small documents through the Admin SDK, written
by 0.2.0-next.8 (a 7.4 GB store of 2,711,202 documents), then started on
0.2.0-next.8, on 0.2.0, and on the official emulator importing an export of the
same data (9.81 GB). Four queries on the grown collection, each run 5 to 15
times; milliseconds at the median.

| | Official, Java defaults | Official, 24 GiB heap | 0.2.0-next.8 | 0.2.0 |
| --- | ---: | ---: | ---: | ---: |
| Start | 50.3 s, then out of memory | 55.2 s | 0.55–0.57 s | **0.62 s** |
| Memory | 14.5 → 16.2 GiB | 20.7 → 24.7 GiB | 0.10–0.16 GiB | 0.11 GiB |
| orderBy a timestamp, descending, limit 20 | — | 8,550 | 5,128 | **4.3** |
| Range on an integer, limit 20 | — | 8,205 | 4,023 | **3.2** |
| == plus orderBy descending, limit 20 | — | 14,124 | 5.4 | **5.6** |
| == on a string, limit 20 | — | 27,562 | 4.3 | **3.4** |

With Java's default settings (a heap of a quarter of the memory, about 15.5
GiB here) the official emulator announced it was ready, then ran out of memory
loading the data at the first query, which failed after 3 minutes. With
`-Xmx24g` it answered every query, each in 8 to 28 seconds. 0.2.0 walks its
ordered index to the 20 documents asked for.

The first start of 0.2.0 on this store, written by 0.2.0-next.8, built the
ordered index once: 49.9 s (49.3 s of indexing 2,711,202 documents), and
0.62 s on every start after. The index grew the file from 7.4 to 9.1 GB.

## Query shapes

26 query shapes against the same data, each run once to warm up and then 25
times, over gRPC: three rounds on 0.2.0 (the median of the three is shown) and
one on the official emulator. Milliseconds.

Every answer was the same on both: each shape's documents, in the same order,
with the same data, and four walks over a whole collection that the new index
serves (its 10,918 documents ordered by an integer and by a timestamp, a range
of 9,376 and an equality ordered descending of 5,459).

| Shape | Official p50 | 0.2.0 p50 | Official p99 | 0.2.0 p99 | Faster |
| --- | ---: | ---: | ---: | ---: | --- |
| Document id in 10 ids | 615 | 13.4 | 646 | 22.7 | Firenook, 46.0× |
| Collection, limit 1 | 88.6 | 2.60 | 90.4 | 3.32 | Firenook, 34.1× |
| Small collection: == on a string | 28.3 | 1.68 | 28.7 | 1.79 | Firenook, 16.8× |
| count() of a collection | 86.1 | 7.99 | 88.8 | 9.21 | Firenook, 10.8× |
| array-contains | 724 | 70.5 | 739 | 83.1 | Firenook, 10.3× |
| orderBy an integer field, limit 20 | 96.3 | 12.0 | 111 | 25.0 | Firenook, 8.0× |
| Range on an integer field, limit 20 | 95.5 | 13.2 | 118 | 22.2 | Firenook, 7.2× |
| == on a boolean, limit 20 | 108 | 15.3 | 118 | 23.9 | Firenook, 7.0× |
| == plus orderBy on another field | 99.3 | 14.7 | 113 | 23.8 | Firenook, 6.8× |
| Five cursor pages of 20 | 489 | 74.8 | 515 | 86.7 | Firenook, 6.5× |
| == on a string field | 124 | 20.0 | 139 | 29.7 | Firenook, 6.2× |
| array-contains-any of 5 values | 352 | 61.0 | 443 | 84.5 | Firenook, 5.8× |
| Second collection: array-contains plus orderBy a timestamp | 37.3 | 7.62 | 44.9 | 15.8 | Firenook, 4.9× |
| orderBy a timestamp, descending, limit 20 | 109 | 24.7 | 125 | 36.0 | Firenook, 4.4× |
| Collection group, limit 20 | 57.0 | 14.2 | 68.0 | 22.8 | Firenook, 4.0× |
| count() with == on a boolean | 83.8 | 24.6 | 104 | 29.8 | Firenook, 3.4× |
| offset 1000, limit 20 | 102 | 32.0 | 109 | 45.7 | Firenook, 3.2× |
| Collection, limit 100 | 210 | 78.3 | 231 | 92.4 | Firenook, 2.7× |
| Second collection: == on a boolean, limit 50 | 116 | 45.2 | 131 | 63.7 | Firenook, 2.6× |
| Second collection: == plus != | 61.4 | 26.5 | 73.7 | 38.2 | Firenook, 2.3× |
| Listener: first snapshot of 20 documents | 115 | 51.0 | 133 | 62.1 | Firenook, 2.2× |
| Batch get of 50 documents | 80.6 | 43.8 | 165 | 58.4 | Firenook, 1.8× |
| Get one document by id | 5.26 | 3.31 | 20.6 | 4.74 | Firenook, 1.6× |
| Write one document, then delete it | 3.01 | 1.96 | 4.16 | 3.56 | Firenook, 1.5× |
| Transaction: read, modify, write | 5.51 | 3.95 | 5.97 | 12.5 | Firenook, 1.4× |
| Ids only, limit 500 | 97.8 | 98.3 | 142 | 115 | tie |

Firenook is faster on 25 of the 26 and ties on the last. The six shapes the
official emulator answered faster in the 0.2.0-next.6 run all walk the new
ordered index now:

| Shape | 0.2.0-next.8 p50 | 0.2.0 p50 | Official p50 |
| --- | ---: | ---: | ---: |
| orderBy an integer field, limit 20 | 177 | 12.0 | 96.3 |
| orderBy a timestamp, descending, limit 20 | 198 | 24.7 | 109 |
| Range on an integer field, limit 20 | 174 | 13.2 | 95.5 |
| == plus orderBy on another field | 107 | 14.7 | 99.3 |
| Five cursor pages of 20 | 875 | 74.8 | 489 |
| Batch get of 50 documents | 115 | 43.8 | 80.6 |

The tie, 500 document ids with no fields, reads each document whole before
dropping its fields; reading only the ids is a next step. The other shapes
answer as 0.2.0-next.8 did, within the variation between rounds.

## Writes on their own

To check that keeping the ordered index did not slow writes, 0.2.0-next.8 and
0.2.0 took turns on fresh copies of the same store, with no application around
them: 2,000 writes one at a time, each confirmed by a listener, then 4,000
from eight writers at once.

| Round | Release | Write, median / p99 | Listener, median | Eight writers |
| --- | --- | ---: | ---: | ---: |
| 1 | 0.2.0-next.8 | 0.67 / 1.33 ms | 0.74 ms | 2,919 writes/s |
| 2 | 0.2.0 | 0.67 / 1.17 ms | 0.73 ms | 3,078 writes/s |
| 3 | 0.2.0-next.8 | 0.61 / 1.32 ms | 0.66 ms | 3,139 writes/s |
| 4 | 0.2.0 | 0.62 / 1.12 ms | 0.68 ms | 3,374 writes/s |

On its own a write commits in under a millisecond; inside the application, with
its functions, listeners and web server on the same machine, the median was
5.1 ms, against 5.3 ms in the 0.2.0-next.6 run.

## How it was kept fair

- One emulator at a time on an otherwise idle server, from a clean start, swap
  emptied before each stack started.
- The official emulator ran with Java's default settings, as a developer gets
  it, except where a row says otherwise. Firenook ran its defaults: data on
  disk, acknowledged writes durable within a second.
- Same data, same application revision, same workload; the run fails unless
  both stacks end with identical data.
- Both stacks started the application with an empty build cache.
- Every percentile is computed from all recorded operations, and an
  independent audit recomputed every figure from the raw samples and verified
  the 95 checksummed evidence files.
- The application's own scheduled jobs were kept outside both measuring windows.

## Limits

- One server and one application. Measure your own workload before relying on
  these numbers.
- The official stack used more memory than the server could hold: it already
  had 7.7 GB in swap when its two hours began and paged out 3.1 GB more,
  against 1.6 GB and nothing more on Firenook. On a machine with more memory
  the official emulator would swap less.
- The application's start times include its own builds; the emulator-only
  starts and stops above are the ones that isolate the emulators.
- One browser journey of the application waits on its cache worker, which the
  official emulator wakes early by notifying a listener for a document the
  listener's filter excludes; Firenook does not, so that journey runs longer on
  Firenook. It is not an emulator latency and is left out above.

Earlier runs on the same server: 0.2.0-next.6 in
[`benchmarks/next6-paired-acceptance.json`](../benchmarks/next6-paired-acceptance.json),
the check of 0.2.0-next.7 against it in
[`benchmarks/next7-regression.json`](../benchmarks/next7-regression.json), and
0.1.0-next.7 in
[`benchmarks/phase-h-functions-runtime.json`](../benchmarks/phase-h-functions-runtime.json) (`receipts.h5.pairedAcceptance`).
