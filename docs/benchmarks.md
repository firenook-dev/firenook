# Benchmarks

[Docs](README.md) · Benchmarks

Firenook 0.2.0-next.6 against the official Firebase emulator (firebase-tools
15.22.0 on Java 26 with its default settings), measured on 18–19 October 2026.
Every figure on this page comes from one recorded run whose numbers are kept in
[`benchmarks/next6-paired-acceptance.json`](../benchmarks/next6-paired-acceptance.json),
except the [check of 0.2.0-next.7](#020-next7-against-020-next6) against it,
which has its own record.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/benchmark-dark.svg">
  <img alt="Firenook against the official emulator: 9 times less memory, writes 38 times faster, listener updates 18 times faster, restarts 39 times sooner, 80 times sooner on 2.5 million documents, 61% less CPU" src="assets/benchmark-light.svg" width="880">
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
  data and no application, for starts, stops, query shapes and a store grown
  to 2.5 million documents.

## Two hours of an application's traffic

| Median / 99th percentile, ms | Official | Firenook | Median |
| --- | ---: | ---: | --- |
| Write, acknowledged | 202.8 / 267.3 | 5.3 / 53.7 | 38× faster |
| Listener update after a write | 203 / 257 | 11 / 62 | 18× faster |
| Filtered query under load | 32.0 / 43.7 | 6.9 / 27.2 | 4.6× faster |
| The same query from an idle client | 32.1 / 40.7 | 7.5 / 29.8 | 4.3× faster |
| Firestore-triggered function | 3.75 / 7.23 | 3.06 / 4.83 | 1.2× faster |
| Storage upload, metadata, download, delete | 11.7 / 21.8 | 8.6 / 12.2 | 1.4× faster |

Both emulators completed every operation with no error, stall or lost update.

## Memory, CPU and disk

| Over the two hours | Official | Firenook |
| --- | ---: | ---: |
| Emulator memory, peak (PSS) | 19.56 GiB (Java) | **2.16 GiB** |
| Emulator memory, first → last sample | 14.12 → 19.14 GiB | 1.77 → 1.83 GiB |
| Whole stack, peak (emulator and application) | 29.66 GiB | 11.09 GiB |
| Emulator CPU time | 1,597 s | **625 s** |
| Disk written by the whole server | 1.24 GB | 1.97 GB |

The official emulator keeps all data in its Java heap and kept growing for the
whole run; Firenook keeps data on disk and caches what it reads. It also
writes more: every acknowledged write is durable within a second, where the
official emulator writes its data only when it exports. The application's own
web server used about 7.4 GiB on both stacks, so most of Firenook's stack total
is the application.

## Start, stop and start again

Firestore, Auth and Storage with the same data, no application. To keep its
data, the official emulator exports on every stop and imports on every start;
Firenook keeps its data and picks it up.

| | Official | Firenook |
| --- | ---: | ---: |
| First start, importing the data | 35.0 s | 18.3 s |
| Start again with the data | 21.6–23.6 s | **0.54–0.57 s** |
| Stop with the data saved | 50–57 s (export) | **0.04–0.30 s** |
| Memory once ready | 7.0 GiB | 0.15 GiB |

Every Firenook stop left its data files closed cleanly, so no start needed a
repair. Inside the full application, where its own builds dominate, the stack
was ready in 37.9 s on Firenook against 49.1 s, and export-and-stop took
33.0 s against 58.1 s.

## A store grown to 2.5 million documents

The same data grown by 2,500,000 small documents through the Admin SDK (a
7.46 GB store), then started three times on 0.2.0-next.6, twice on
0.2.0-next.5, and twice on the official emulator importing an export of the
same data (9.81 GB, which Firenook wrote in 35 s).

| Start | Ready | Memory |
| --- | ---: | ---: |
| Firenook 0.2.0-next.6 | 0.56 s each time | 0.15 GiB |
| Firenook 0.2.0-next.5 | 17.8 s, then 7.0 s | 0.25 GiB |
| Official emulator | 48.2 s, then 45.1 s | 15.6 GiB |

0.2.0-next.6 keeps the document count with the data and closes its files on
stop; 0.2.0-next.5 counted every document at each start and left its files to
be repaired after a stop. The official emulator's Java process sat at 15.1–15.3
GiB, near the edge of its default heap on this machine; a larger store would
likely need `-Xmx`.

## Query shapes

26 query shapes against the same data, each run once to warm up and then 25
times, over gRPC. Every result was identical on both. Milliseconds.

| Shape | Official p50 | Firenook p50 | Official p99 | Firenook p99 | Faster |
| --- | ---: | ---: | ---: | ---: | --- |
| Document id in 10 ids | 574 | 22.0 | 607 | 31.6 | Firenook, 26.1× |
| Collection, limit 1 | 83.3 | 3.57 | 90.8 | 6.57 | Firenook, 23.3× |
| count() of a collection | 85.3 | 5.05 | 86.4 | 11.1 | Firenook, 16.9× |
| Small collection: == on a string | 27.2 | 1.85 | 27.9 | 1.98 | Firenook, 14.7× |
| array-contains | 717 | 97.3 | 733 | 109 | Firenook, 7.4× |
| == on a boolean, limit 20 | 105 | 18.9 | 127 | 34.4 | Firenook, 5.5× |
| array-contains-any of 5 values | 354 | 75.8 | 361 | 98.0 | Firenook, 4.7× |
| count() with == on a boolean | 82.4 | 19.3 | 84.2 | 28.9 | Firenook, 4.3× |
| == on a string field | 127 | 31.7 | 149 | 41.6 | Firenook, 4.0× |
| offset 1000, limit 20 | 101 | 29.1 | 110 | 39.6 | Firenook, 3.5× |
| Collection group, limit 20 | 56.5 | 18.4 | 68.4 | 22.7 | Firenook, 3.1× |
| Second collection: array-contains plus orderBy a timestamp | 36.8 | 14.8 | 47.0 | 23.5 | Firenook, 2.5× |
| Second collection: == on a boolean, limit 50 | 118 | 53.5 | 132 | 70.3 | Firenook, 2.2× |
| Listener: first snapshot of 20 documents | 115 | 54.4 | 124 | 66.9 | Firenook, 2.1× |
| Collection, limit 100 | 208 | 101 | 242 | 126 | Firenook, 2.1× |
| Second collection: == plus != | 59.9 | 33.0 | 70.0 | 48.8 | Firenook, 1.8× |
| Get one document by id | 5.73 | 3.47 | 7.12 | 4.97 | Firenook, 1.7× |
| Write one document, then delete it | 3.35 | 2.07 | 5.02 | 3.28 | Firenook, 1.6× |
| Transaction: read, modify, write | 5.42 | 4.06 | 6.30 | 6.07 | Firenook, 1.3× |
| Ids only, limit 500 | 91.7 | 90.6 | 111 | 119 | Firenook, 1.0× |
| == plus orderBy on another field | 98.9 | 109 | 111 | 134 | official, 1.1× |
| Batch get of 50 documents | 72.8 | 130 | 276 | 172 | official, 1.8× |
| Range on an integer field, limit 20 | 94.2 | 172 | 103 | 209 | official, 1.8× |
| Five cursor pages of 20 | 480 | 888 | 501 | 960 | official, 1.8× |
| orderBy an integer field, limit 20 | 94.4 | 178 | 100 | 211 | official, 1.9× |
| orderBy a timestamp, descending, limit 20 | 96.0 | 201 | 118 | 224 | official, 2.1× |

Firenook is faster on 20 of the 26. The official emulator is faster where a
query orders or range-filters a large collection (10,918 documents here) or
reads many documents by key: Firenook's field index serves equality filters,
and ordered and range indexes are the next step.

## Writes on their own

To check that the newest release did not slow writes, 0.2.0-next.5 and
0.2.0-next.6 took turns on fresh copies of the same store, with no application
around them: 2,000 writes one at a time, each confirmed by a listener, then
4,000 from eight writers at once.

| Round | Release | Write, median / p99 | Listener, median | Eight writers |
| --- | --- | ---: | ---: | ---: |
| 1 | 0.2.0-next.5 | 0.67 / 1.67 ms | 0.75 ms | 1,097 writes/s |
| 2 | 0.2.0-next.6 | 0.65 / 1.15 ms | 0.71 ms | 3,054 writes/s |
| 3 | 0.2.0-next.5 | 0.87 / 1.11 ms | 0.95 ms | 3,077 writes/s |
| 4 | 0.2.0-next.6 | 0.85 / 1.05 ms | 0.94 ms | 3,344 writes/s |

On its own a write commits in under a millisecond; inside the application, with
its functions, listeners and web server on the same machine, the median was
5.3 ms. That is up from about 3.3 ms in the September run of 0.1.0-next.7,
while the application around it also grew; this run does not separate the two.

## 0.2.0-next.7 against 0.2.0-next.6

0.2.0-next.7 changes no write, query or storage path these figures measure, so
the paired run was not repeated. Instead it was checked against 0.2.0-next.6 on
the same server and data on 20 October 2026, one release at a time, taking
turns, with Firestore, Auth and Storage only. The numbers are kept in
[`benchmarks/next7-regression.json`](../benchmarks/next7-regression.json).

| | 0.2.0-next.6 | 0.2.0-next.7 |
| --- | ---: | ---: |
| First start, importing the data (4 each) | 21.4 s | 21.8 s |
| Start again with the data (3 each) | 0.56 s | 0.58 s |
| Memory once ready | 0.15 GiB | 0.16 GiB |
| Memory after the 26 query shapes | 0.24 GiB | 0.27 GiB |
| Write, median / p99 (5 rounds each) | 0.72 / 1.13 ms | 0.76 / 1.12 ms |
| Listener, median | 0.80 ms | 0.83 ms |
| Eight writers | 3,213 writes/s | 3,257 writes/s |
| A project with seven functions, ready (5 each) | **6.82 s** | **0.78 s** |

Of the 26 query shapes above, run four times on each release, 20 answered
within 5% of 0.2.0-next.6, two faster and four slower by 5 to 20%, at most 1.8 ms
(a write and delete, a collection-group query, a filtered count and a
transaction). On those four, 0.2.0-next.6 itself varied by 16 to 61% from one
round to the next, and the 2,000 writes above, the stronger measure of a write,
are unchanged. Memory is 11 MB higher once ready and 21 MB higher after the
queries.

The functions row is the one 0.2.0-next.7 set out to change: discovering a
codebase waited about 6 s for the SDK's discovery server to exit, kept open by
an idle connection, and now takes about 0.2 s. Every emulator, Functions
included, is ready in under a second.

A project with no seed, started four times with `--keep-data`, was ready in
0.35 s the first time and 0.17 s after, and found every document the earlier
runs wrote.

One finding from the copies: a start on a freshly copied data folder took 0.65
to 16 s on both releases, most often several seconds, until the copy was
flushed to the disk with `sync`, and 0.56 to 0.66 s on both after it. The slow start the 0.2.0-next.6 run saw on
copied data is the copy's pending writes reaching the disk, not Firenook.

## How it was kept fair

- One emulator at a time on an otherwise idle server, from a clean start, swap
  emptied before each stack started.
- The official emulator ran with Java's default settings, as a developer gets
  it. Firenook ran its defaults: data on disk, acknowledged writes durable
  within a second.
- Same data, same application revision, same workload; the run fails unless
  both stacks end with identical data.
- Every percentile is computed from all recorded operations, and an
  independent audit recomputed every figure from the raw samples and verified
  the 95 checksummed evidence files.
- The application's own scheduled jobs were kept outside both measuring windows.

## Limits

- One server and one application. Measure your own workload before relying on
  these numbers.
- The official stack put 4.8 GB into swap while starting and 0.8 GB more during
  its two hours; Firenook's put 36 MB and none. The official medians match the
  September runs, where neither swapped.
- The application's start times include its own builds and are similar on
  both; the emulator-only starts and stops above are the ones that isolate the
  emulators.
- One browser journey of the application waits on its cache worker, which the
  official emulator wakes early by notifying a listener for a document the
  listener's filter excludes; Firenook does not, so that journey runs longer on
  Firenook. It is not an emulator latency and is left out above.

The September run of 0.1.0-next.7 on the same server is recorded in
[`benchmarks/phase-h-functions-runtime.json`](../benchmarks/phase-h-functions-runtime.json) (`receipts.h5.pairedAcceptance`).
