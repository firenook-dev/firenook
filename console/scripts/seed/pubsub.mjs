// The Pub/Sub world the messaging journeys read: topics, subscriptions and
// messages written through the Pub/Sub port's HTTP/JSON API, exactly as an
// app's client library would. Journeys never change these; each one that
// mutates makes its own resources (`e2e/support/messaging.ts`).
//
// - `orders` (its function `onOrderPlaced` comes from the fixture),
//   `payments`, `audit-log` and `orders-dead` (`onOrderDeadLettered`);
// - `projects/demo-elsewhere/topics/orders`: an app using another project
//   id, the classic silent bug the shell's foreign-project banner names;
// - `orders-worker` (pull, ordered, dead-lettering into `orders-dead` after
//   5 deliveries), `orders-filtered` (`attributes.region = "eu"`) and
//   `payments-worker` (exactly-once, keeping acknowledged messages);
// - 40 messages on `orders` (regions eu and us, ordering keys cust-1 to
//   cust-5) and 5 on `payments`.
//
// FIRENOOK_SEED_SCALE=large (or `{ large: true }`, which the scale
// journeys pass so the shared engine never carries the load) adds the perf
// dataset: 2,000 topics `load-0000`…`load-1999`, and `bulk` (one hour of
// retention) holding 50,000 messages, published in batches of 1,000.
// Everything is synthetic.

import { largeScale } from './identities.mjs'

/** Another project id an app might use by mistake. */
const OTHER_PROJECT = 'demo-elsewhere'

/** Requests the large dataset keeps in flight at once. */
const PARALLEL = 32

/**
 * @param {{ origin: string, project: string, ports: Record<string, number> }} engine
 * @param {{ large?: boolean }} [options] `large` defaults to FIRENOOK_SEED_SCALE=large
 */
export async function seed(engine, options = {}) {
  const pubsub = pubsubPort(engine)
  const { project } = engine
  const topic = (id) => topicName(project, id)

  // Function topics exist already (the functions' targets create them at
  // start), so a topic that is there is left as it is.
  for (const id of ['orders', 'payments', 'audit-log', 'orders-dead'])
    await createTopic(pubsub, project, id)
  await createTopic(pubsub, OTHER_PROJECT, 'orders')

  await createSubscription(pubsub, project, 'orders-worker', {
    topic: topic('orders'),
    enableMessageOrdering: true,
    deadLetterPolicy: { deadLetterTopic: topic('orders-dead'), maxDeliveryAttempts: 5 },
  })
  await createSubscription(pubsub, project, 'orders-filtered', {
    topic: topic('orders'),
    filter: 'attributes.region = "eu"',
  })
  await createSubscription(pubsub, project, 'payments-worker', {
    topic: topic('payments'),
    enableExactlyOnceDelivery: true,
    retainAckedMessages: true,
  })

  await publish(
    pubsub,
    project,
    'orders',
    Array.from({ length: 40 }, (_, index) => ({
      data: {
        orderId: `o_${20_001 + index}`,
        amount: Math.round((12.5 + index * 3.75) * 100) / 100,
        items: [`sku-${(index % 7) + 1}`, `sku-${(index % 3) + 10}`],
      },
      attributes: {
        region: index % 2 === 0 ? 'eu' : 'us',
        channel: index % 3 === 0 ? 'app' : 'web',
      },
      orderingKey: `cust-${(index % 5) + 1}`,
    })),
  )
  await publish(
    pubsub,
    project,
    'payments',
    Array.from({ length: 5 }, (_, index) => ({
      data: { paymentId: `p_${3_001 + index}`, amount: 20 + index * 5, currency: 'EUR' },
      attributes: { method: index % 2 === 0 ? 'card' : 'transfer' },
    })),
  )

  if (options.large ?? largeScale()) await seedLarge(pubsub, project)
}

/** 2,000 topics, and `bulk` with 50,000 messages in its one-hour retention. */
async function seedLarge(pubsub, project) {
  await inParallel(
    Array.from({ length: 2_000 }, (_, index) => `load-${String(index).padStart(4, '0')}`),
    (id) => createTopic(pubsub, project, id),
  )
  await createTopic(pubsub, project, 'bulk', { messageRetentionDuration: '3600s' })
  const batches = Array.from({ length: 50 }, (_, batch) => batch)
  await inParallel(batches, (batch) =>
    publish(
      pubsub,
      project,
      'bulk',
      Array.from({ length: 1_000 }, (_, index) => {
        const n = batch * 1_000 + index + 1
        return {
          data: { n, kind: n % 10 === 0 ? 'tenth' : 'plain' },
          attributes: { batch: String(batch) },
        }
      }),
    ),
  )
}

/** A topic's full name. */
function topicName(project, id) {
  return `projects/${project}/topics/${id}`
}

/** The Pub/Sub port an app would use, on the engine's own host. */
function pubsubPort(engine) {
  return `http://${new URL(engine.origin).hostname}:${engine.ports.pubsub}/v1/projects`
}

/** `PUT …/topics/{id}`; one that exists already is left alone. */
async function createTopic(pubsub, project, id, body = {}) {
  await send('PUT', `${pubsub}/${project}/topics/${encodeURIComponent(id)}`, body, {
    exists: true,
  })
}

/** `PUT …/subscriptions/{id}`; one that exists already is left alone. */
async function createSubscription(pubsub, project, id, body) {
  await send('PUT', `${pubsub}/${project}/subscriptions/${encodeURIComponent(id)}`, body, {
    exists: true,
  })
}

/** `POST …/topics/{id}:publish`, each message's JSON data base64-encoded as a client library sends it. */
async function publish(pubsub, project, id, messages) {
  await send('POST', `${pubsub}/${project}/topics/${encodeURIComponent(id)}:publish`, {
    messages: messages.map((message) => ({
      data: Buffer.from(JSON.stringify(message.data)).toString('base64'),
      ...(message.attributes ? { attributes: message.attributes } : {}),
      ...(message.orderingKey ? { orderingKey: message.orderingKey } : {}),
    })),
  })
}

/** A `PUT` or `POST` with a JSON body; `exists` accepts 409 (already there). */
async function send(method, url, body, { exists = false } = {}) {
  const init = {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }
  const response = await fetch(url, init)
  if (response.ok || (exists && response.status === 409)) return
  throw new Error(`Seeding Pub/Sub: ${method} ${url} → ${response.status} ${await response.text()}`)
}

/** Runs `work` over every item, `PARALLEL` at a time. */
async function inParallel(items, work) {
  let next = 0
  const lane = async () => {
    while (next < items.length) {
      const item = items[next]
      next += 1
      await work(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(PARALLEL, items.length) }, lane))
}
