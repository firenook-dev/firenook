// The Pub/Sub world every messaging journey stands on, checked through the
// Console API against the real engine: what the seeder made, what the
// fixture's functions (the real SDK) do with it, and the journey helpers
// themselves. When this file fails, the journeys after it would fail for a
// reason that is not theirs.

import { expect, test } from './fixtures'
import {
  type DeliveryPageView,
  type JobView,
  type MessageDetailView,
  type MessageRowView,
  type PageView,
  type ScheduleView,
  type SubscriptionDetailView,
  type TopicIndexView,
  OTHER_PROJECT,
  consoleCall,
  createSubscription,
  createTopic,
  deleteTopic,
  functionUrl,
  holdPull,
  publishOverPort,
  subscriptionName,
  topicName,
  uniqueId,
  waitForJob,
} from './support/messaging'

const enc = encodeURIComponent

test('the seeded topics, their subscriptions and the functions that consume them', async ({
  engine,
}) => {
  const index = await consoleCall<TopicIndexView>(engine, 'GET', '/pubsub/topics')
  const topic = (id: string) => index.items.find((item) => item.name === topicName(engine, id))

  const orders = topic('orders')
  expect(orders?.counters.published).toBeGreaterThanOrEqual(40)
  expect(orders?.subscriptions.map((subscription) => subscription.id)).toEqual(
    expect.arrayContaining(['orders-worker', 'orders-filtered', 'emulator-sub-orders']),
  )
  expect(
    orders?.subscriptions.find((subscription) => subscription.id === 'emulator-sub-orders')
      ?.managed,
  ).toBe('functions')
  expect(orders?.functions).toEqual([
    expect.objectContaining({ functionId: 'us-central1-onOrderPlaced', kind: 'cloudevent' }),
  ])
  expect(topic('orders-dead')?.functions.map((target) => target.name)).toEqual([
    'onOrderDeadLettered',
  ])
  expect(topic('payments')?.counters.published).toBeGreaterThanOrEqual(5)
  expect(topic('payments')?.subscriptions.map((subscription) => subscription.id)).toContain(
    'payments-worker',
  )
  expect(topic('audit-log')?.subscriptions).toEqual([])

  // One synthetic topic per scheduled function, which the panel groups.
  for (const name of ['nightlyCleanup', 'weeklyDigest'])
    expect(topic(`firebase-schedule-${name}`)).toMatchObject({
      kind: 'schedule',
      scheduleFunction: `us-central1-${name}`,
    })

  // The app that writes under another project id: the tree lists it, and
  // the engine has told the shell, whose banner names it.
  expect(index.otherProjects).toContainEqual(
    expect.objectContaining({ project: OTHER_PROJECT, topics: 1 }),
  )
  const status = await consoleCall<{
    foreignProjects: { projectId: string; services: string[] }[]
  }>(engine, 'GET', '/status')
  expect(status.foreignProjects).toContainEqual(
    expect.objectContaining({ projectId: OTHER_PROJECT, services: ['pubsub'] }),
  )

  const subscription = (id: string) =>
    consoleCall<SubscriptionDetailView>(
      engine,
      'GET',
      `/pubsub/subscription?name=${enc(subscriptionName(engine, id))}`,
    )
  const worker = (await subscription('orders-worker')).subscription
  expect(worker.summary.ordering).toBe(true)
  expect(worker.deadLetter).toEqual({
    topic: topicName(engine, 'orders-dead'),
    maxDeliveryAttempts: 5,
  })
  expect((await subscription('orders-filtered')).subscription.summary.filter).toBe(
    'attributes.region = "eu"',
  )
  const payments = (await subscription('payments-worker')).subscription
  expect(payments.summary.exactlyOnce).toBe(true)
  expect(payments.retainAcked).toBe(true)
})

test('the seeded messages reach onOrderPlaced, decoded by the real SDK', async ({ engine }) => {
  const orders = topicName(engine, 'orders')
  const page = await consoleCall<PageView<MessageRowView>>(
    engine,
    'GET',
    `/pubsub/messages?topic=${enc(orders)}&q=${enc('key:cust-1')}`,
  )
  expect(page.total?.count).toBeGreaterThanOrEqual(8)
  const row = page.items[0]
  expect(row?.orderingKey).toBe('cust-1')
  expect(row?.data.encoding).toBe('json')
  expect(['eu', 'us']).toContain(row?.attributes.region)

  // Each of the 40 ran the handler and succeeded: the deliveries are
  // compute's record of the invocations, joined by event id.
  await expect
    .poll(
      async () =>
        (
          await consoleCall<DeliveryPageView>(
            engine,
            'GET',
            `/pubsub/deliveries?topic=${enc(orders)}`,
          )
        ).counts.delivered,
      { timeout: 60_000 },
    )
    .toBeGreaterThanOrEqual(40)
})

test('the schedules: every five minutes, and a cron that runs in Europe/Paris and fails', async ({
  engine,
}) => {
  const schedules = await consoleCall<PageView<ScheduleView>>(engine, 'GET', '/pubsub/schedules')
  const schedule = (name: string) =>
    schedules.items.find((item) => item.functionId === `us-central1-${name}`)
  const nightly = schedule('nightlyCleanup')
  expect(nightly).toMatchObject({ expression: 'every 5 minutes', automatic: true, paused: false })
  const nextNightly = Date.parse(nightly?.nextRunAt ?? '')
  expect(nextNightly).toBeGreaterThan(Date.now() - 1_000)
  expect(nextNightly).toBeLessThanOrEqual(Date.now() + 5 * 60_000)

  const digest = schedule('weeklyDigest')
  expect(digest).toMatchObject({
    expression: '0 9 * * 1',
    timeZone: 'Europe/Paris',
    evaluatedIn: 'Europe/Paris',
    automatic: true,
  })
  // Monday 09:00 on the Paris clock, whatever the season (08:00Z or 07:00Z).
  const paris = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Paris',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(digest?.nextRunAt ?? 0))
  expect(paris).toBe('Mon 09:00')

  // Run now publishes the tick; the function throws, and the run says so
  // with the handler's error, from compute's record.
  const run = await consoleCall<{ messageId: string | null }>(
    engine,
    'POST',
    '/pubsub/schedule/run',
    {
      functionId: 'us-central1-weeklyDigest',
    },
  )
  expect(run.messageId).toBeTruthy()
  await expect
    .poll(
      async () => {
        const answer = await consoleCall<PageView<ScheduleView>>(engine, 'GET', '/pubsub/schedules')
        const found = answer.items.find((item) => item.functionId === 'us-central1-weeklyDigest')
        const runs = [...(found?.lastRuns ?? []), ...(found?.firstRun ? [found.firstRun] : [])]
        const ours = runs.find((entry) => entry.messageId === run.messageId)
        return ours?.delivery?.mark === 'failed' ? ours.delivery.error : ours?.delivery?.mark
      },
      { timeout: 30_000 },
    )
    .toMatch(/digest service unavailable/)
})

test('the journey helpers: an own topic, a publish over the port, a waiting pull and a job', async ({
  engine,
}) => {
  const topic = uniqueId('fixture')
  const subscription = `${topic}-sub`
  try {
    await createTopic(engine, topic)
    await createSubscription(engine, subscription, topic)

    const published = await publishOverPort(engine, topic, [
      { data: { n: 1 }, attributes: { region: 'eu' }, orderingKey: 'k-1' },
      { data: 'plain text' },
    ])
    expect(published.status).toBe(200)
    expect(published.messageIds).toHaveLength(2)
    const page = await consoleCall<PageView<MessageRowView>>(
      engine,
      'GET',
      `/pubsub/messages?topic=${enc(topicName(engine, topic))}`,
    )
    expect(page.items.map((row) => row.id)).toEqual(published.messageIds.toReversed())
    expect(page.items.map((row) => row.data.encoding)).toEqual(['text', 'json'])

    // A subscriber waiting on an empty subscription is a consumer, leasing nothing.
    const empty = `${topic}-empty`
    await createSubscription(engine, empty, topic)
    const consumers = async () =>
      (
        await consoleCall<SubscriptionDetailView>(
          engine,
          'GET',
          `/pubsub/subscription?name=${enc(subscriptionName(engine, empty))}`,
        )
      ).subscription.summary.counters.consumers.waitingPulls
    const pull = holdPull(engine, empty)
    await expect.poll(consumers).toBe(1)
    await pull.stop()
    await expect.poll(consumers).toBe(0)

    // A publish job the console starts, waited on to the end.
    const job = await consoleCall<JobView>(engine, 'POST', '/pubsub/messages:publish', {
      topic: topicName(engine, topic),
      messages: [{ data: { json: '{"n":"{{i}}"}' } }],
      repeat: 3,
      template: true,
    })
    const finished = await waitForJob(engine, job.id)
    expect(finished).toMatchObject({ state: 'done', done: 3, kind: 'pubsub.publish' })
  } finally {
    await deleteTopic(engine, topic)
  }
})

test('pushSink refuses a message as many times as it asks, then accepts it', async ({ engine }) => {
  const topic = uniqueId('push')
  try {
    await createTopic(engine, topic)
    await createSubscription(engine, `${topic}-push`, topic, {
      pushEndpoint: functionUrl(engine, 'pushSink'),
    })
    const [id] = (
      await publishOverPort(engine, topic, [{ data: { n: 1 }, attributes: { failTimes: '2' } }])
    ).messageIds
    await expect
      .poll(
        async () => {
          const detail = await consoleCall<MessageDetailView>(
            engine,
            'GET',
            `/pubsub/message?topic=${enc(topicName(engine, topic))}&id=${id}`,
          )
          return detail.push
            .toReversed()
            .map((streak) => `${streak.status ?? streak.error} ×${streak.count}`)
        },
        { timeout: 30_000 },
      )
      .toEqual(['500 ×2', '200 ×1'])
  } finally {
    await deleteTopic(engine, topic)
  }
})
