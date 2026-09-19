# Phase J — Pub/Sub emulator (`0.1.0-next.8`, together with Phase I)

Written 2026-09-18 against `main` 10f3087 (published engine 0720434). It ships
with [Phase I](phase-i-auth.md) (complete Authentication) as `0.1.0-next.8`.

## Status (2026-09-19)

J0–J4 are done. Gate `benchmarks/phase-j-pubsub.json` (frozen); corpus
`conformance/fixtures/pubsub-v1` — 42 programs / 916 steps against
`cloud-pubsub-emulator-0.8.33` over gRPC (654 calls, 12 streaming-pull
sessions) and HTTP/JSON (216 requests) with a recording push endpoint, every
RPC of the four services covered, two recordings identical (`receipts.j1`).
`crates/pubsub-front` is rewritten as a broker (leases, ack deadlines,
redelivery behind later messages, dead-lettering, ordering keys, filters,
topic retention, seek/snapshots, push loop, Avro schema revisions) behind
tonic services and the HTTP/JSON transcoder on one port; `firenook pubsub`
runs it standalone for the replay. The replay compares 3,755 values with
0 mismatches and no named divergence, three runs identical; the pinned
`@google-cloud/pubsub` 5.3.1 client passes publish, streaming `on('message')`,
ordering, push, schema and admin flows with `PUBSUB_EMULATOR_HOST`; the
Phase H Functions/Extensions corpus replays unchanged. J5 qualification is
recorded in `receipts.j5` (2026-09-19): CI green on the exact head, the
consumer gates and the nine browser journeys pass on the candidate with the
discovered schedules and function targets installed on the rewritten broker;
the paired 2 h soak was waived by the owner for this release (see the I5
status). Published as `0.1.0-next.8` on 2026-09-19 (release run 35372788758,
`next` → next.8, `latest` untouched).

Two changes to the plan as delivered: the replay is the TypeScript harness
driving the standalone service (as in Phase I) rather than Rust replay
tests, so both sides share one transport and normalization; and timing steps
replay against the real clock (the corpus records only the timing outcomes
the official emulator answers consistently) instead of an injectable clock.
The official emulator's multi-key ordered delivery differs between its own
runs, so the corpus holds Firenook to the single-key contract only
(`conformance/fixtures/pubsub-v1/README.md`, Divergences).

## Goal

Replace the function-oriented Pub/Sub adapter with a Pub/Sub emulator that
answers like the official one on the Pub/Sub port: the `google.pubsub.v1`
Publisher, Subscriber and Schema services over gRPC (what every Google client
library uses when `PUBSUB_EMULATOR_HOST` is set) and the HTTP/JSON transcoding
of the same services on the same port, with real subscriptions — pull,
streaming pull, push delivery to local endpoints, acknowledgement deadlines and
redelivery, ordering keys, filters, retention, seek and snapshots, dead-letter
and retry policies as the official emulator honours them. Function delivery
(`onMessagePublished`, v1 `onPublish`, `onSchedule`) keeps working and becomes
what it is in the official suite: an internal subscriber on
`emulator-sub-<topic>`.

Same discipline as Phases G, H and I: the official emulator is recorded first
over both transports, the corpus is frozen, the implementation replays it, and
every difference is either fixed or named.

Out of scope: persistence across restarts (the official emulator is in-memory
too and exports nothing), IAM semantics beyond the official fake answers,
BigQuery/Cloud Storage export subscriptions, Kinesis/AWS ingestion, and an
Emulator UI tab (the official UI has none).

## State before the phase (verified 2026-09-18)

`crates/pubsub-front` (1,246 lines) is an axum HTTP/JSON router with nine
routes: topics list/create/get/delete/`:publish`, subscriptions
list/create/get/delete, `:pull` (always `[]`) and `:acknowledge` (no-op).
Publishing fans out to the discovered function targets through the
`functions-bridge` queue; `SchedulerRuntime` ticks `onSchedule` topics (cron
and `every N units`, UTC; `every day HH:MM` outside UTC is rejected, cron with
a zone runs in UTC with a warning). There is no gRPC service, no message
backlog, no ack, no push, no ordering, no filter, no snapshot, no schema.

The official emulator is `cloud-pubsub-emulator-0.8.33` (Java; zip
`93768f87…`, jar `4b2892ba…`), which the Firebase CLI downloads and starts on
the Pub/Sub port. Its classes: `PublisherService` (createTopic, getTopic,
listTopics, updateTopic, deleteTopic, publish, listTopicSubscriptions,
listTopicSnapshots, detachSubscription), `SubscriberService`
(createSubscription, getSubscription, updateSubscription, listSubscriptions,
deleteSubscription, modifyAckDeadline, acknowledge, pull, streamingPull,
modifyPushConfig, seek, createSnapshot, getSnapshot, listSnapshots,
deleteSnapshot), `SchemaService` (createSchema, getSchema, listSchemas,
listSchemaRevisions, commitSchema, rollbackSchema, deleteSchemaRevision,
deleteSchema, validateSchema, validateMessage), `IamPolicyService`
(get/set/testIamPermissions), an `HttpJsonAdapter` for REST on the same port,
`OrderedMessageBacklog`/`OrderingKeyHasher`, `FilterExpression*`,
`HttpEndpointPusher`/`PushLoop`, `SnapshotData`, `AvroSchema`.

Why it matters beyond the consumer: Firenook exports `PUBSUB_EMULATOR_HOST`
to every function worker (`functions-runtime/src/lib.rs:516`), and every
Google client library that honours it speaks gRPC, so
`new PubSub().topic(t).publishMessage(...)` from a function or an app fails
today. The consumer itself publishes nothing and runs two `onSchedule`
functions; it is unaffected either way.

## Oracles and precedence (freeze before implementation)

Record in `benchmarks/phase-j-pubsub.json`, `frozen: true`, before any product
change:

1. **Official Pub/Sub emulator** 0.8.33 started from the cached zip (exact
   hashes), driven over gRPC with `@google-cloud/pubsub` 5.3.1's generated
   gapic clients (`v1.PublisherClient`, `v1.SubscriberClient`,
   `v1.SchemaServiceClient`) and over HTTP/JSON with raw requests, with a
   recording HTTP server as the push endpoint. This oracle owns request
   validation, gRPC status codes and messages, the HTTP status/JSON error
   mapping, message ids, ordering, redelivery timing, push envelope, schema
   validation.
2. **firebase-tools 15.22.0 `PubsubEmulator`** for the Functions integration
   (already recorded in `firebase-suite-v1/pubsub-schedule-and-function-dispatch`
   and `functions-runtime-v1`): topic/subscription naming, the legacy and
   CloudEvent envelopes, the client library's streaming-pull consumption.
3. Cloud Pub/Sub API reference, for naming only.

Classification rule: the official emulator wins; a divergence is allowed only
for a documented emulator limitation where production behaviour is followed
instead, named in the fixture README and asserted in the replay.

## Work packages

### J0 — Freeze the gate (½ day)

- `benchmarks/phase-j-pubsub.json`: toolchain pins (Rust, tonic/prost from
  the workspace, Node 24, `@google-cloud/pubsub` 5.3.1, emulator 0.8.33 hashes,
  Java for the oracle only), the RPC inventory above (37 RPCs across four
  services, both transports), the named checks with pass criteria, and the
  acceptance identities J5 fills in.

### J1 — Oracle corpus (4–5 days)

New fixture set `conformance/fixtures/pubsub-v1/` (`emulator-programs.json`,
`README.md`, `SHA256SUMS`, CI integrity check). Tooling
`conformance/src/pubsub/{emulator-plan.ts,capture-emulator.ts}`: each program
starts a fresh emulator process (or resets by deleting every resource), every
step is a gRPC call (recorded as method, request JSON, status code, message,
response JSON) or an HTTP/JSON call (method, path, body, status, response),
with wall-clock-dependent fields normalized (`messageId`, `publishTime`,
`ackId`, deadlines as relative). Target ≥40 programs / ≥400 steps:

- Topics: name validation (`projects/{p}/topics/{t}` rules, reserved `goog`
  prefix), create/get/list (page size, page token)/update (mask)/delete,
  publish on a missing topic, `listTopicSubscriptions`, `detachSubscription`,
  message size and attribute limits as the emulator enforces them.
- Publish: data/attributes/orderingKey combinations, empty data, batch of
  messages, message id monotonicity, `publishTime`, publishing with a schema
  (valid, invalid, encoding JSON/BINARY).
- Subscriptions: create with every field the emulator honours
  (`ackDeadlineSeconds` bounds, `messageRetentionDuration`, `retainAckedMessages`,
  `enableMessageOrdering`, `filter`, `deadLetterPolicy`, `retryPolicy`,
  `expirationPolicy`, `enableExactlyOnceDelivery`, push config with
  `pushEndpoint`/attributes/OIDC token), get/list/update/delete, subscription
  on a missing or deleted topic (`_deleted-topic_`), duplicate names.
- Pull: `maxMessages`, `returnImmediately`, empty backlog wait, ack, nack via
  `modifyAckDeadline 0`, deadline expiry and redelivery, `deliveryAttempt`,
  ack of unknown/expired ack ids, exactly-once ack responses.
- Streaming pull: initial request fields, flow control, modify/ack in-stream,
  redelivery after stream close, ordering per key across pulls.
- Push: envelope (`message` + `subscription`), attributes, ordering key,
  endpoint 2xx/5xx behaviour and retry, `modifyPushConfig` switching between
  push and pull.
- Ordering: keys interleaved, in-order delivery per key, pause on nack.
- Filter: attribute equality, `hasPrefix`, `NOT`/`AND`/`OR`, invalid filter
  errors at create time.
- Seek: to a timestamp, to a snapshot; snapshot create/get/list/delete,
  `listTopicSnapshots`, expiry.
- Schema: Avro and Protocol Buffer definitions, revisions, commit/rollback,
  validate, topic binding and publish rejection.
- IAM: the three calls on topics and subscriptions.
- HTTP/JSON: each of the above over REST (`/v1/projects/{p}/topics/{t}`,
  `:publish`, `:pull`, `:acknowledge`, `:modifyAckDeadline`, `:seek`,
  `:modifyPushConfig`, snapshots, schemas, `?updateMask=`), including the
  JSON error body shape and status mapping for each gRPC code.
- Functions integration: firebase-tools 15.22.0's `PubsubEmulator` against the
  official emulator, creating `emulator-sub-<topic>` and consuming a publish
  with the recorded envelope (reusing the existing capture where it already
  covers this).

Exit: fixtures committed with checksums and README (RPC coverage table,
divergences empty or justified); CI integrity green.

### J2 — Engine: broker core (6–8 days)

- `crates/pubsub-front/src/broker/*`: `Topic`, `Subscription` (pull/push
  config, ordering, filter, policies), `Backlog` (per-subscription queue with
  ack deadlines, outstanding lease map, redelivery timer, retention,
  `deliveryAttempt`), `OrderedBacklog` (per-key FIFO with pause on nack),
  `Filter` (parser + evaluator for the official grammar), `Snapshot`, `Schema`
  (Avro via `apache-avro`, Protocol Buffers via `protox` descriptors),
  `PushLoop` (HTTP client with the official retry behaviour).
- Validation and error mapping tables from J1 (gRPC code, message, HTTP
  status, JSON body).
- Function delivery becomes an internal subscriber: for every discovered
  topic target Firenook creates `emulator-sub-<topic>` (visible to
  list/get, deletable like the official one) and consumes it through the
  broker, so user `pull` and functions compete exactly as they do officially.

### J3 — Transports (3–4 days)

- gRPC: `google/pubsub/v1/pubsub.proto` + `schema.proto` + `google/iam/v1`
  vendored beside the Firestore protos; tonic services `Publisher`,
  `Subscriber` (including the bidirectional `StreamingPull`), `SchemaService`,
  `IAMPolicy`; mounted on the Pub/Sub port with `accept_http1(true)` like the
  Firestore port.
- HTTP/JSON: the existing axum router extended to the full transcoding
  (`?updateMask`, `:` verbs, snapshots, schemas), proto-JSON field names,
  base64 `data`, the recorded error body.

### J4 — Replay (2–3 days)

- `crates/pubsub-front/src/replay_tests.rs` replays every J1 program over
  both transports (tonic client + tower oneshot) with a recording push
  endpoint; parity or a named divergence; timing steps use the recorded
  relative deadlines with a bounded clock.
- `@google-cloud/pubsub` 5.3.1 end to end against Firenook in the conformance
  job: publish, subscription `on('message')`, ordering, push, schema.
- Functions: the existing schedule/dispatch fixtures and the Phase H corpus
  replay unchanged.

### J5 — Qualification and release (shared with I5)

Exact-candidate CI, consumer gates, private paired acceptance (the
scheduled-function lane and the extensions gate exercise the new broker),
release `0.1.0-next.8`, docs (README, CLI guide, COMPATIBILITY, DESIGN,
ROADMAP, tracker).

## Sequencing and size

J0 → J1 → J2 → J3 → J4 → J5, after I1 on the same branch. Size 16–21 working
days. The bidirectional streaming pull and the ordering/redelivery timing are
the risk items; the corpus records the official timings so the replay can
bound them instead of guessing.

## Risks

- Timing-dependent oracle steps (ack deadline expiry, push retry): recorded
  with explicit relative deadlines and replayed against an injectable clock.
- Schema validation parity for Avro/Protobuf edge cases: the corpus covers
  the official emulator's accepted and rejected examples; anything beyond is
  named.
- The Java oracle only for capture and the CI oracle job, never at product
  runtime — the no-Java verification step stays.
