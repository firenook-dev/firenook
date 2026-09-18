# Pub/Sub oracle corpus (Phase J1)

Raw programs recorded against the official Google Cloud Pub/Sub emulator
(`cloud-pubsub-emulator-0.8.33`, one fresh JVM per program) over both of its
transports — `google.pubsub.v1` Publisher, Subscriber and SchemaService and
`google.iam.v1` IAMPolicy over gRPC (grpc-js with the client library's own
proto files) and the HTTP/JSON adapter on the same port — with a recording
HTTP server as the push endpoint. Everything is synthetic: no credentials, no
real data.

| File | Contents |
| --- | --- |
| `emulator-programs.json` | `42` programs / `916` steps (654 gRPC calls, 216 HTTP/JSON requests, 12 streaming-pull sessions, 18 push-endpoint observations, 10 timed waits), every step with its request, the normalized response and the push requests it produced |
| `SHA256SUMS` | digests frozen in `benchmarks/phase-j-pubsub.json` (`capture.frozenFixtureSha256`) |

Re-record with `npm run capture:pubsub:emulator` (the jar from the Firebase
CLI cache, `PUBSUB_EMULATOR_JAR` to point elsewhere, `PUBSUB_EMULATOR_JAVA`
for the Java binary; about seven minutes because of the ack-deadline waits;
`--programs=a,b` records a subset, `--debug` prints raw responses). Two
recordings differ only in `capturedAt` / `completedAt`: the normalization
below removes every run-dependent value, which consecutive recordings
confirmed byte for byte once the two ordered-subscription programs were
limited to what the official emulator itself answers consistently (see
[Divergences](#divergences)).

## Programs

| Program | Area | Steps | Covers |
| --- | --- | --- | --- |
| `topic-names` | topics | 20 | topic name validation on create, get and delete |
| `topic-crud` | topics | 31 | topic create/get/list/update/delete over gRPC |
| `topic-crud-http` | topics | 20 | topic create/get/list/update/delete over HTTP/JSON |
| `topic-children` | topics | 24 | listTopicSubscriptions, listTopicSnapshots and detachSubscription |
| `publish-validation` | publish | 22 | publish request validation and message id allocation |
| `publish-http` | publish | 14 | publish over HTTP/JSON including malformed bodies |
| `subscription-create-validation` | subscriptions | 55 | createSubscription names, bounds and policies |
| `subscription-crud-http` | subscriptions | 20 | subscription create/get/list/update/delete over HTTP/JSON |
| `subscription-update` | subscriptions | 34 | updateSubscription masks and modifyPushConfig |
| `subscription-topic-lifecycle` | subscriptions | 17 | a deleted topic leaves `_deleted-topic_` subscriptions behind |
| `pull-ack` | pull | 33 | pull, acknowledge and modifyAckDeadline over gRPC |
| `pull-ack-http` | pull | 15 | pull, acknowledge and modifyAckDeadline over HTTP/JSON |
| `pull-batches` | pull | 13 | maxMessages batching across a larger backlog |
| `ack-deadline-expiry` | pull | 15 | an unacknowledged message is redelivered after its ack deadline |
| `blocking-pull` | pull | 7 | pull without returnImmediately waits for redelivery |
| `dead-letter` | pull | 20 | deliveryAttempt and dead-letter forwarding after maxDeliveryAttempts |
| `retained-acked-and-seek-time` | seek | 23 | retainAckedMessages, seek to a time and seek to the future |
| `snapshots` | seek | 42 | snapshot create/get/list/delete and seek to a snapshot |
| `ordering-keys` | ordering | 23 | one ordering key delivers in order and blocks on its outstanding message; the unordered mirror |
| `filters` | filters | 26 | attribute filters: equality, existence, hasPrefix, NOT/AND/OR |
| `streaming-pull` | streaming | 9 | streamingPull delivery, in-stream ack and modifyAckDeadline |
| `streaming-pull-redelivery` | streaming | 10 | messages outstanding on a closed stream and delivery to a live stream |
| `streaming-pull-ordering` | streaming | 6 | one ordering key over streamingPull |
| `push-delivery` | push | 16 | push envelope, pull on a push subscription and switching push/pull |
| `push-retry` | push | 18 | push retries on non-2xx endpoint answers |
| `schemas-avro` | schemas | 60 | Avro schema create/get/list/commit/rollback/delete and validation |
| `schemas-http` | schemas | 25 | schema operations over HTTP/JSON |
| `schema-topic-binding` | schemas | 30 | topics bound to a schema validate published messages |
| `iam` | iam | 12 | IAM policy calls on topics, subscriptions and schemas |
| `http-surface` | http | 40 | unknown paths, methods and bodies on the HTTP surface |
| `projects` | misc | 18 | resources are scoped by project and cross-project references |
| `exactly-once` | pull | 10 | exactly-once delivery flags on pull and acknowledge |
| `retention` | pull | 11 | topic and subscription message retention settings |
| `http-list-paging` | http | 22 | pagination parameters over HTTP/JSON for every list |
| `fan-out` | pull | 18 | every subscription gets its own copy; subscriptions created later start empty |
| `dead-letter-and-filter-http` | http | 25 | deliveryAttempt, dead-letter forwarding, filters and error mapping over HTTP/JSON |
| `push-envelope` | push | 21 | push envelopes for every message shape and push subscriptions' lifecycle |
| `streaming-pull-two-streams` | streaming | 12 | two streams on one subscription share the backlog; ids belong to the subscription |
| `topic-fields-http` | topics | 18 | topic fields over HTTP/JSON: labels, storage policy, KMS, schema settings, masks |
| `detached-and-expiration` | subscriptions | 17 | detached subscriptions and expiration policies |
| `snapshot-semantics` | seek | 28 | snapshot contents across subscriptions, acked messages and later publishes |
| `modify-ack-deadline-semantics` | pull | 16 | modifyAckDeadline extends, shortens and expires leases |

## RPC coverage

All 37 RPCs of the four services are exercised over gRPC; 36 over HTTP/JSON
(`StreamingPull` has no HTTP form). `coverage.operations` in the fixture
lists each RPC with the transports it was recorded on.

## Step shapes

- `grpc`: `{ service, method, body }` → `{ body }` (the response as grpc-js
  decodes it: bytes base64, 64-bit integers as decimal strings, enums as
  names, `Duration`/`Timestamp` as `{ seconds, nanos }`) or
  `{ error: { code, status, message } }`.
- `http`: `{ method, path, body? }` → `{ status, contentType, body }` (parsed
  JSON) or `{ status, contentType, text }` for a non-JSON answer.
- `stream`: a scripted `StreamingPull` session (`write`, `waitMs`, `end`,
  `cancel`) → `{ received: { messages, properties }, status }` — the
  messages flattened in arrival order (the official server batches them
  arbitrarily), the distinct non-message response fields, and the terminal
  status.
- `pushes`: waits for at least N push requests → the distinct envelopes
  (method, path, `content-type`, body) sorted, `atLeastSatisfied`, and the
  exact `count` only when none was expected (retries repeat an envelope on a
  timer, so their number is not a contract).
- `pushStatus`, `sleep`: control steps with an empty response.

## Normalization

| Value | Template |
| --- | --- |
| `messageId` / `messageIds[]` / `message_id` | `{{messageId:<step>}}`, `#n` for later ids of the same step (also inside push envelopes and dead-letter copies) |
| `ackId` | `{{ackId:<step>}}` (`subscription:N` in the official emulator, a global counter) |
| `revisionId`, `firstRevisionId`, `lastRevisionId`, `googclient_schemarevisionid`, `name@revision` | `{{revisionId:<step>}}` (random 8-hex ids) |
| `publishTime`, `publish_time`, `expireTime`, `revisionCreateTime`, `CloudPubSubDeadLetterSourceTopicPublishTime`, time-based `nextPageToken` | `{{time}}` |
| the push endpoint's origin | `{{pushOrigin}}` |
| `{{timeBetween:a:b}}` in a request | resolved at run time to the midpoint between two earlier steps (`seek` to a time between two publishes) |
| `{ "$b64repeat": { text, count } }` in a request | base64 of `text` repeated (the 10 MB publish) |

Ids are templated by key only: an ack id is a prefix of the next one, so no
blind substring replacement runs. `pull-ordered`, `pull-more` and
`pull-after-deadline` steps are sorted by message id before normalization
(`sortReceived`) where the recorded order is not a contract.

## What the official emulator does (facts the implementation follows)

- Resource ids are 3–255 characters, start with a letter, use
  `[A-Za-z0-9-_.~+%]` and must not start with `goog` (case-sensitive:
  `GoogTopic` is accepted); the project segment may even be empty. A bad name
  answers `INVALID_ARGUMENT` `Invalid [topics] name: (name=...)` (the
  collection in brackets), before any existence check.
- Message ids are decimal strings from one global counter; ack ids are
  `<subscription name>:<global counter>`; both are opaque to clients.
- Publish: `No messages to publish`, `Some messages are empty` (no data and
  no attributes — an ordering key alone does not count); no size or attribute
  limits (a 10 MB message, 101 attributes, 257-byte keys and `googclient_`
  keys are accepted); client-supplied `messageId`/`publishTime` are replaced.
- Subscriptions default to `ackDeadlineSeconds: 10` (0 → 10; 1–600 accepted,
  otherwise `ack_deadline_secs out of bounds`), `messageRetentionDuration`
  604800s (600s–604800s accepted), `pushConfig: {}`; dead-letter
  `maxDeliveryAttempts` 5 by default, 5–100 (`OUT_OF_RANGE` otherwise), the
  dead-letter topic must exist; a retry policy defaults to 10s/600s and
  rejects `maximum_backoff < minimum_backoff`; `expirationPolicy` and
  `filter` cannot be updated, `topic`, `enable_message_ordering` and
  `detached` are immutable, `labels` is not an updatable field; a filter that
  does not parse (or names `data`/`orderingKey`) fails with `UNKNOWN`
  `Application error processing RPC`.
- A subscription created after a publish does not see it, unless the topic
  has its own `messageRetentionDuration`, in which case the retained
  messages are delivered to it.
- Pull: `maxMessages` 0 → `No max_messages specified`, negative → empty;
  without `returnImmediately` a pull waits about 89 seconds for a message,
  or returns empty just before the caller's deadline. Messages deliver in
  publish order; a nacked or expired message queues behind later ones. A
  detached subscription answers `FAILED_PRECONDITION` `Subscription is
  detached.` and is not listed under its topic.
- Acknowledge: unknown or stale ids are ignored (`INVALID_ARGUMENT` with an
  empty message on an exactly-once subscription), `garbage` → `Invalid ack id
  (ack_id=garbage)`, another subscription's id → `Subscription X received an
  invalid ack ID Y, meant for subscription: Z`. `modifyAckDeadline` 0 nacks,
  negative → `Ack deadline cannot be negative`, above 600 is accepted.
- Dead-lettering: `deliveryAttempt` counts deliveries; after
  `maxDeliveryAttempts` a nack (or expiry) forwards the message to the
  dead-letter topic with `CloudPubSubDeadLetterSourceDeliveryCount`,
  `...SourceSubscription` (short id), `...SourceSubscriptionProject` and
  `...SourceTopicPublishTime` attributes.
- Deleting a topic leaves its subscriptions with `topic: _deleted-topic_` and
  their backlog pullable; re-creating the topic is a distinct topic (they
  stay detached from it, seeks to old snapshots fail with
  `FAILED_PRECONDITION`).
- Seek to a time makes messages published before it acknowledged and the
  others deliverable; acknowledged messages come back only with
  `retainAckedMessages`. Snapshots record the unacknowledged (available or
  leased) messages of their subscription, keep the topic name even after the
  topic is gone, drop `labels`, and seeking to one restores the acknowledgement
  state of the messages the seeking subscription already has (it does not
  add messages the subscription never received). `updateSnapshot`,
  `detachSubscription` and every IAM method are `UNIMPLEMENTED` (IAM with
  an empty message; HTTP `501` without a `message`).
- Push: on publish the emulator POSTs
  `{"subscription": ..., "message": {publishTime, data, publish_time, messageId, attributes, message_id}}`
  (no ordering key, `attributes` always present) with only a `content-type`
  header — push config attributes are stored, not sent; any non-2xx answer
  (including redirects) is retried every second until a 2xx; a pull on a
  push subscription is empty; switching to pull (empty `pushConfig`)
  releases the backlog to pulls and switching back pushes what is not leased.
- Streaming pull: the first request must name the subscription and use a
  `streamAckDeadlineSeconds` between 10 and 600; a missing subscription ends
  the stream with `NOT_FOUND` `Subscription does not exist (resource=<id>)`;
  every message-bearing response also carries `subscriptionProperties` and
  empty `acknowledgeConfirmation`/`modifyAckDeadlineConfirmation`; nothing is
  sent while there is nothing to deliver; leases outlive a closed stream.
- Schemas: Avro only (`PROTOCOL_BUFFER` → `UNIMPLEMENTED` `Protocol buffer
  support not implemented in emulator`); a definition that does not parse →
  `Could not parse schema definition`; missing type → `Invalid schema type`;
  revisions list oldest first, `commit` and `rollback` each add one, a
  revision is addressed as `name@revision` (the `revisionId` field is
  ignored), the last one cannot be deleted; `view=BASIC` omits the
  definition. A topic binds the schema's latest revision at creation/update
  (`firstRevisionId`/`lastRevisionId` must exist), validates published data
  as JSON or binary Avro (`Could not parse message`), stamps
  `googclient_schemaencoding`/`googclient_schemaname`/`googclient_schemarevisionid`
  attributes, and after the schema is deleted shows `_deleted-schema_` and
  rejects publishes with `NOT_FOUND` `Schema associated with topic deleted.`.
- HTTP/JSON: successes are pretty-printed proto3 JSON (`{\n}` for an empty
  message), errors are compact `{"error":{"code","message","status"}}`;
  `Not Found\n` (no content type) for anything unrouted, `Not Found
  (Unsupported API version "v2")`, `/` answers `Ok`; the path is decoded
  before routing (`%3A` is `:`); `updateMask` in the body wins over the
  query parameter and lowerCamelCase paths are accepted there;
  `null` fields are dropped and `"true"` is read as a boolean; a body that
  does not fit the message → `Payload isn't valid for request.`.
- Three requests make the official emulator's HTTP adapter hang without an
  answer (a topic body whose `name` differs from the path, a schema with a
  numeric `type`, `pageSize=abc`); they are not in the corpus.

## Divergences

None in the corpus: the fixture is the official emulator's behaviour and the
replay (`npm run replay:pubsub -- --binary <fireside>`) compares every step —
3,755 values — with no named divergence. Two areas were deliberately kept
out of the corpus because the official emulator itself answers them
differently from run to run, so no contract exists to hold Fireside to:

- the interleaving of several ordering keys in one pull response and the
  delivery order after nacks and expiries across keys (recorded in three
  captures as, for the same program, `a1 a2 a3 b1 b2 c1`, `a1 a2 b1 c1 a3 b2`
  and `a2 a3 b1 c1 b2 a1`, with the following pulls diverging further);
  Fireside delivers messages of one ordering key in publish order, holds a
  key while one of its messages is outstanding, and queues a nacked or
  expired message behind later ones — the single-key contract the corpus
  does record;
- the order in which several leases that expired together are redelivered
  (`pull-after-deadline` steps are compared as sorted sets).
