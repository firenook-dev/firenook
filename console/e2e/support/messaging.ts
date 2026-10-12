// What the messaging journeys do to an engine behind the page's back: make
// their own topics, subscriptions and client queues (the seeded ones are
// read, never changed), publish and enqueue the way an app does — over the
// Pub/Sub and Tasks ports — and wait for a job the console started.

import { expect } from '@playwright/test'
import type { Engine } from '../fixtures'
import { ownerFetch } from './api'

// The Console API answers as journeys read them: the parts of the generated
// types (`src/api/generated/messaging/`) the specs assert on. The e2e
// TypeScript project cannot import the app's sources, so these restate them;
// a field added here must exist there.

export interface PageView<T> {
  items: T[]
  nextCursor: string | null
  prevCursor: string | null
  total: { count: number; exact: boolean } | null
}

export interface JobView {
  id: string
  kind: string
  section: string
  state: 'running' | 'done' | 'failed' | 'cancelled'
  total: number | null
  done: number
  skipped: number
  errorCount: number
}

export interface SubscriptionCountersView {
  name: string
  backlog: number
  available: number
  outstanding: number
  pushing: number
  retainedAcked: number
  ackedTotal: number
  deadLetteredTotal: number
  consumers: { streaming: number; waitingPulls: number; lastPullAt: string | null }
}

export interface SubscriptionSummaryView {
  name: string
  project: string
  id: string
  topic: string | null
  delivery: string
  managed: 'no' | 'functions' | 'orphaned'
  ordering: boolean
  exactlyOnce: boolean
  deadLetterTopic: string | null
  filter: string | null
  counters: SubscriptionCountersView
}

export interface TopicSummaryView {
  name: string
  project: string
  id: string
  kind: 'user' | 'schedule'
  scheduleFunction: string | null
  schema: string | null
  counters: { name: string; published: number; latestMessageId: string | null }
  subscriptions: SubscriptionSummaryView[]
  functions: { functionId: string; name: string; region: string; kind: string }[]
}

export interface TopicIndexView extends PageView<TopicSummaryView> {
  project: string
  otherProjects: { project: string; topics: number; subscriptions: number }[]
  detached: SubscriptionSummaryView[]
  revision: number
}

export interface SubscriptionDetailView {
  subscription: {
    summary: SubscriptionSummaryView
    pushEndpoint: string | null
    ackDeadlineSeconds: number
    retainAcked: boolean
    deadLetter: { topic: string; maxDeliveryAttempts: number } | null
  }
  deadLetteredInHistory: number
}

export interface MessageRowView {
  id: string
  publishTime: string
  size: number
  data: { encoding: 'json' | 'text' | 'binary'; text: string; truncated: boolean }
  attributes: Record<string, string>
  orderingKey: string | null
}

export interface DeliveryRowView {
  messageId: string
  functionId: string
  eventId: string
  mark: 'queued' | 'running' | 'delivered' | 'failed' | 'skipped' | 'not-kept'
  status: number | null
  error: string | null
  redelivery: boolean
}

export interface DeliveryPageView extends PageView<DeliveryRowView> {
  counts: {
    all: number
    queued: number
    running: number
    delivered: number
    failed: number
    skipped: number
  }
}

export interface PushStreakView {
  streak: string
  messageId: string
  count: number
  status: number | null
  error: string | null
  response: string | null
}

export interface MessageDetailView {
  topic: string
  id: string
  dataText: string | null
  attributes: Record<string, string>
  orderingKey: string | null
  functions: DeliveryRowView[]
  push: PushStreakView[]
}

export interface SchemaDetailView {
  name: string
  kind: string
  /** Oldest first. */
  revisions: { id: string; createdAt: string; definition: string }[]
}

export interface TopicDetailView {
  summary: TopicSummaryView
  schema: {
    schema: string
    deleted: boolean
    encoding: string
    firstRevisionId: string | null
    lastRevisionId: string | null
    boundRevisionId: string
  } | null
}

export interface ScheduleRunView {
  at: string
  trigger: 'clock' | 'console'
  messageId: string | null
  skipped: string | null
  delivery: DeliveryRowView | null
}

export interface ScheduleView {
  functionId: string
  functionName: string
  region: string
  topic: string
  expression: string
  timeZone: string | null
  evaluatedIn: string
  automatic: boolean
  problem: string | null
  paused: boolean
  nextRunAt: string | null
  runs: number
  firstRun: ScheduleRunView | null
  lastRuns: ScheduleRunView[]
}

export interface QueueView {
  key: string
  project: string
  location: string
  id: string
  origin: 'function' | 'client'
  function: { functionId: string; name: string; region: string } | null
  paused: boolean
  holdScheduled: boolean
  registrations: number
  config: {
    maxAttempts: number
    maxRetrySeconds: number | null
    minBackoffSeconds: number
    maxBackoffSeconds: number
    maxDoublings: number
    maxConcurrentDispatches: number
    maxDispatchesPerSecond: number
    values: { key: string; value: string; provided: boolean; unused: boolean }[]
  }
}

export interface QueueListView extends PageView<QueueView> {
  project: string
  projects: string[]
  rejectedRegistrations: { functionId: string; name: string; region: string; reason: string }[]
  refused: { operation: string; queue: string; location: string; status: number; count: number }[]
  revision: number
}

export interface HistoryRowView {
  id: string
  taskId: string
  name: string
  shortName: string
  outcome: 'succeeded' | 'failed' | 'cancelled' | 'deleted' | 'purged' | 'replaced'
  attempts: number
  lastStatus: number | null
  lastError: string | null
}

export interface TaskDetailView {
  attempts: {
    attempt: number
    status: number | null
    error: string | null
    response: string | null
  }[]
  omittedAttempts: number
  stops: string
}

/** Where the fixture's functions run, and so its queues. */
export const LOCATION = 'us-central1'

/** The project the Pub/Sub seeder publishes under by mistake, as an app might. */
export const OTHER_PROJECT = 'demo-elsewhere'

/**
 * A fresh id for what one journey makes, `j-<journey>-<random>`: unique
 * across runs on one engine, and a valid topic, subscription, schema and
 * queue id (a letter first, no underscore).
 */
export function uniqueId(journey: string): string {
  return `j-${journey.toLowerCase()}-${Math.random().toString(36).slice(2, 8)}`
}

export const topicName = (engine: Engine, id: string, project = engine.project) =>
  `projects/${project}/topics/${id}`
export const subscriptionName = (engine: Engine, id: string, project = engine.project) =>
  `projects/${project}/subscriptions/${id}`
export const schemaName = (engine: Engine, id: string, project = engine.project) =>
  `projects/${project}/schemas/${id}`

/** The Tasks emulator's key for a queue: what the console API addresses it by. */
export const queueKey = (project: string, location: string, queue: string) =>
  `queue:${project}-${location}-${queue}`

/** A port of the engine, on its own host, as an app reaches it. */
export function portUrl(engine: Engine, service: 'pubsub' | 'tasks' | 'functions'): string {
  const port = engine.ports[service]
  if (port === undefined) throw new Error(`The engine has no ${service} port.`)
  return `http://${new URL(engine.origin).hostname}:${port}`
}

/** A fixture function's own URL on the Functions port (`pushSink`, `processOrder`). */
export function functionUrl(engine: Engine, name: string, region = LOCATION): string {
  return `${portUrl(engine, 'functions')}/${engine.project}/${region}/${name}`
}

/** A Console API call as the owner that must succeed; answers its JSON body (`undefined` for 204). */
export async function consoleCall<T>(
  engine: Engine,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await ownerFetch(engine, path, {
    method,
    ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
  })
  const text = await response.text()
  expect(response.ok, `${method} ${path} → ${response.status} ${text}`).toBe(true)
  return (text === '' ? undefined : JSON.parse(text)) as T
}

/** A new topic's options, as `PubsubCreateTopicBody` takes them. */
export interface TopicOptions {
  labels?: Record<string, string>
  retentionSeconds?: number
  schema?: {
    schema: string
    encoding: 'JSON' | 'BINARY'
    firstRevisionId?: string
    lastRevisionId?: string
  }
  /** Also create `<id>-sub`. */
  defaultSubscription?: boolean
}

/** A new subscription's options, as `PubsubCreateSubscriptionBody` takes them. */
export interface SubscriptionOptions {
  ackDeadlineSeconds?: number
  pushEndpoint?: string
  filter?: string
  ordering?: boolean
  exactlyOnce?: boolean
  retainAcked?: boolean
  retentionSeconds?: number
  deadLetter?: { topic: string; maxDeliveryAttempts: number }
  retry?: { minimumBackoffSeconds: number; maximumBackoffSeconds: number }
  labels?: Record<string, string>
}

/** Creates a topic through the Console API (`POST /pubsub/topics`). */
export function createTopic(
  engine: Engine,
  id: string,
  options: TopicOptions = {},
): Promise<TopicSummaryView> {
  return consoleCall(engine, 'POST', '/pubsub/topics', { ...options, name: topicName(engine, id) })
}

/** Creates a subscription on one of the project's topics (by id) through the Console API. */
export function createSubscription(
  engine: Engine,
  id: string,
  topic: string,
  options: SubscriptionOptions = {},
): Promise<SubscriptionSummaryView> {
  return consoleCall(engine, 'POST', '/pubsub/subscriptions', {
    ...options,
    name: subscriptionName(engine, id),
    topic: topicName(engine, topic),
  })
}

/** Deletes a journey's topic and, by default, its subscriptions; one already gone is fine. */
export async function deleteTopic(
  engine: Engine,
  id: string,
  subscriptions: 'keep' | 'delete' = 'delete',
): Promise<void> {
  const response = await ownerFetch(engine, '/pubsub/topic', {
    method: 'DELETE',
    body: JSON.stringify({ name: topicName(engine, id), subscriptions }),
  })
  expect([204, 404], `deleting topic ${id} → ${response.status}`).toContain(response.status)
}

/** Deletes a journey's subscription; one already gone is fine. */
export async function deleteSubscription(engine: Engine, id: string): Promise<void> {
  const response = await ownerFetch(engine, '/pubsub/subscription', {
    method: 'DELETE',
    body: JSON.stringify({ name: subscriptionName(engine, id) }),
  })
  expect([204, 404], `deleting subscription ${id} → ${response.status}`).toContain(response.status)
}

/** One message as an app hands it to its client library. */
export interface PortMessage {
  /** JSON-able data (sent as its JSON text), or a string sent as UTF-8 text. */
  data?: unknown
  attributes?: Record<string, string>
  orderingKey?: string
}

/** Publishes over the Pub/Sub port (`…/topics/{id}:publish`), as an app does; answers the message ids. */
export async function publishOverPort(
  engine: Engine,
  topic: string,
  messages: readonly PortMessage[],
  project = engine.project,
): Promise<{ status: number; messageIds: string[]; text: string }> {
  const response = await fetch(
    `${portUrl(engine, 'pubsub')}/v1/projects/${project}/topics/${encodeURIComponent(topic)}:publish`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: messages.map((message) => ({
          data: Buffer.from(
            typeof message.data === 'string' ? message.data : JSON.stringify(message.data ?? {}),
          ).toString('base64'),
          ...(message.attributes ? { attributes: message.attributes } : {}),
          ...(message.orderingKey ? { orderingKey: message.orderingKey } : {}),
        })),
      }),
    },
  )
  const text = await response.text()
  const ids = response.ok ? ((JSON.parse(text) as { messageIds?: string[] }).messageIds ?? []) : []
  return { status: response.status, messageIds: ids, text }
}

/**
 * Opens a long-poll pull over the Pub/Sub port (`returnImmediately: false`),
 * the way a waiting subscriber holds one, and leaves it waiting; `stop`
 * aborts it. On an empty subscription it leases nothing.
 */
export function holdPull(engine: Engine, subscription: string): { stop: () => Promise<void> } {
  const controller = new AbortController()
  const pending = fetch(
    `${portUrl(engine, 'pubsub')}/v1/projects/${engine.project}/subscriptions/${encodeURIComponent(subscription)}:pull`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ maxMessages: 1, returnImmediately: false }),
      signal: controller.signal,
    },
  ).then(
    (response) => response.body?.cancel(),
    () => undefined,
  )
  return {
    stop: async () => {
      controller.abort()
      await pending
    },
  }
}

/**
 * Pulls a subscription's next message over the Pub/Sub port and nacks it
 * (`modifyAckDeadline` 0), round after round, as a subscriber that keeps
 * failing does, until nothing comes back or `rounds` are spent; answers
 * how many deliveries were nacked. With a dead-letter policy the message
 * moves to its dead-letter topic once its deliveries run out.
 */
export async function nackOverPort(
  engine: Engine,
  subscription: string,
  rounds = 10,
): Promise<number> {
  const base = `${portUrl(engine, 'pubsub')}/v1/projects/${engine.project}/subscriptions/${encodeURIComponent(subscription)}`
  const post = (verb: string, body: unknown) =>
    fetch(`${base}:${verb}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  let nacked = 0
  for (let round = 0; round < rounds; round += 1) {
    const pulled = (await (
      await post('pull', { maxMessages: 1, returnImmediately: true })
    ).json()) as {
      receivedMessages?: { ackId: string }[]
    }
    const ackId = pulled.receivedMessages?.[0]?.ackId
    if (!ackId) break
    const answer = await post('modifyAckDeadline', { ackIds: [ackId], ackDeadlineSeconds: 0 })
    expect(answer.ok, `nack → ${answer.status}`).toBe(true)
    nacked += 1
  }
  return nacked
}

/** A queue as its parts and its key. */
export interface QueueAddress {
  project: string
  location: string
  queue: string
  key: string
}

/**
 * Registers a client queue over the Tasks port (`POST …/queues/{id}`), its
 * tasks dispatched to a fixture function (`processOrder` by default). The
 * console cannot delete queues, so a journey's queue stays until the engine
 * stops; give each a fresh id.
 */
export async function registerQueue(
  engine: Engine,
  queue: string,
  options: {
    target?: string
    location?: string
    retryConfig?: Record<string, number | null>
    rateLimits?: Record<string, number>
  } = {},
): Promise<QueueAddress> {
  const location = options.location ?? LOCATION
  const response = await fetch(
    `${portUrl(engine, 'tasks')}/projects/${engine.project}/locations/${location}/queues/${encodeURIComponent(queue)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...(options.retryConfig ? { retryConfig: options.retryConfig } : {}),
        ...(options.rateLimits ? { rateLimits: options.rateLimits } : {}),
        defaultUri: functionUrl(engine, options.target ?? 'processOrder', location),
      }),
    },
  )
  expect(
    response.ok,
    `registering queue ${queue} → ${response.status} ${await response.text()}`,
  ).toBe(true)
  return {
    project: engine.project,
    location,
    queue,
    key: queueKey(engine.project, location, queue),
  }
}

/**
 * Enqueues over the Tasks port exactly as the Admin SDK's
 * `taskQueue(name).enqueue(data, options)` does: the body is `{"data": …}`,
 * base64; a task id becomes the full task name; a delay becomes the
 * schedule time.
 */
export async function enqueueOverPort(
  engine: Engine,
  queue: { project?: string; location?: string; queue: string },
  data: unknown,
  options: {
    id?: string
    scheduleDelaySeconds?: number
    dispatchDeadlineSeconds?: number
    headers?: Record<string, string>
  } = {},
): Promise<{ status: number; name: string | undefined; text: string }> {
  const project = queue.project ?? engine.project
  const location = queue.location ?? LOCATION
  const path = `projects/${project}/locations/${location}/queues/${queue.queue}`
  const task = {
    ...(options.id ? { name: `${path}/tasks/${options.id}` } : {}),
    ...(options.scheduleDelaySeconds
      ? { scheduleTime: new Date(Date.now() + options.scheduleDelaySeconds * 1000).toISOString() }
      : {}),
    ...(options.dispatchDeadlineSeconds
      ? { dispatchDeadline: `${options.dispatchDeadlineSeconds}s` }
      : {}),
    httpRequest: {
      url: '',
      headers: { 'Content-Type': 'application/json', ...options.headers },
      body: Buffer.from(JSON.stringify({ data })).toString('base64'),
    },
  }
  const response = await fetch(`${portUrl(engine, 'tasks')}/${path}/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ task }),
  })
  const text = await response.text()
  const name = response.ok
    ? (JSON.parse(text) as { task?: { name?: string } }).task?.name
    : undefined
  return { status: response.status, name, text }
}

/** Waits until a job the console started has ended (`GET /jobs/{id}`), and answers its last state. */
export async function waitForJob(engine: Engine, id: string, timeout = 30_000): Promise<JobView> {
  let job: JobView | undefined
  await expect
    .poll(
      async () => {
        job = await consoleCall<JobView>(engine, 'GET', `/jobs/${encodeURIComponent(id)}`)
        return job.state
      },
      { timeout, message: `job ${id} did not end` },
    )
    .not.toBe('running')
  if (!job) throw new Error(`job ${id} was never read`)
  return job
}
