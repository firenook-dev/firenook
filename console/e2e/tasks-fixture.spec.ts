// The Cloud Tasks world every messaging journey stands on, checked through
// the Console API against the real engine: the queues the fixture's
// `onTaskDispatched` functions register (and the one the emulator refuses),
// and the journey helpers that register client queues and enqueue as the
// Admin SDK does.

import { expect, test } from './fixtures'
import {
  type HistoryRowView,
  type PageView,
  type QueueListView,
  type TaskDetailView,
  LOCATION,
  consoleCall,
  enqueueOverPort,
  queueKey,
  registerQueue,
  uniqueId,
} from './support/messaging'

const enc = encodeURIComponent

test('processOrder and sendEmail register from their functions; badQueue_1 is refused', async ({
  engine,
}) => {
  const list = await consoleCall<QueueListView>(engine, 'GET', '/tasks/queues')
  const queue = (id: string) => list.items.find((item) => item.id === id)

  const processOrder = queue('processOrder')
  expect(processOrder).toMatchObject({
    key: queueKey(engine.project, LOCATION, 'processOrder'),
    project: engine.project,
    location: LOCATION,
    origin: 'function',
    function: { functionId: `${LOCATION}-processOrder`, name: 'processOrder' },
  })
  expect(processOrder?.config).toMatchObject({
    maxAttempts: 3,
    minBackoffSeconds: 1,
    maxBackoffSeconds: 4,
    maxDoublings: 16,
    maxConcurrentDispatches: 2,
    maxDispatchesPerSecond: 10,
  })
  const provided = Object.fromEntries(
    processOrder?.config.values.map((value) => [value.key, value.provided]) ?? [],
  )
  expect(provided).toMatchObject({
    'retryConfig.maxAttempts': true,
    'retryConfig.maxDoublings': false,
    'rateLimits.maxConcurrentDispatches': true,
  })
  expect(queue('sendEmail')?.config.maxConcurrentDispatches).toBe(1000)

  expect(list.rejectedRegistrations).toContainEqual(
    expect.objectContaining({ name: 'badQueue_1', region: LOCATION }),
  )
  expect(queue('badQueue_1')).toBeUndefined()
})

test('a client queue takes Admin SDK tasks to processOrder: one succeeds, one runs out of retries', async ({
  engine,
}) => {
  const queue = await registerQueue(engine, uniqueId('fixture'), {
    // Two attempts a failing task, a tenth of a second apart, so this is quick.
    retryConfig: { maxAttempts: 1, minBackoffSeconds: 0.1, maxBackoffSeconds: 0.1 },
  })
  const list = await consoleCall<QueueListView>(engine, 'GET', '/tasks/queues')
  expect(list.items.find((item) => item.key === queue.key)).toMatchObject({
    origin: 'client',
    function: null,
  })

  const ok = await enqueueOverPort(
    engine,
    queue,
    { orderId: 'o_1' },
    {
      id: 'order-1',
      headers: { 'x-synthetic-header': 'fixture' },
    },
  )
  expect(ok.status).toBe(200)
  expect(ok.name).toBe(
    `projects/${engine.project}/locations/${LOCATION}/queues/${queue.queue}/tasks/order-1`,
  )
  const failing = await enqueueOverPort(engine, queue, { orderId: 'o_2', fail: true })
  expect(failing.status).toBe(200)

  const history = async () =>
    (
      await consoleCall<PageView<HistoryRowView>>(
        engine,
        'GET',
        `/tasks/history?queue=${enc(queue.key)}`,
      )
    ).items
  await expect
    .poll(async () => (await history()).map((row) => row.outcome).toSorted(), { timeout: 30_000 })
    .toEqual(['failed', 'succeeded'])
  const rows = await history()
  const succeeded = rows.find((row) => row.outcome === 'succeeded')
  const failed = rows.find((row) => row.outcome === 'failed')
  expect(succeeded).toMatchObject({ shortName: 'order-1', attempts: 1 })
  // maxAttempts 1 runs a failing task twice: the emulator checks the limit
  // before it counts the attempt.
  expect(failed).toMatchObject({ attempts: 2, lastStatus: 500 })

  const detail = await consoleCall<TaskDetailView>(
    engine,
    'GET',
    `/tasks/task?queue=${enc(queue.key)}&id=${failed?.taskId}`,
  )
  expect(detail.attempts.map((attempt) => attempt.status)).toEqual([500, 500])
  expect(detail.attempts[0]?.response).toMatch(/card declined/)

  // The name is reserved for the rest of the run, as the emulator does.
  const again = await enqueueOverPort(engine, queue, { orderId: 'o_1' }, { id: 'order-1' })
  expect(again.status).toBe(409)
})
