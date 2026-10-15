// Cloud Tasks journeys (messaging spec §9.3, project `messaging`), against
// the real engine and the fixture's real `onTaskDispatched` functions:
// processOrder (maxAttempts 3, backoff 1–4 s, 2 slots, 10 a second) fails
// with HttpsError('internal', 'card declined') when its data says `fail`,
// sendEmail does nothing, and badQueue_1 is refused. Journeys that change a
// queue register their own client queue (queues cannot be deleted) and
// read processOrder only by deltas.

import type { Locator, Page } from '@playwright/test'
import { type Engine, expect, test } from './fixtures'
import { badgeOf } from './support/shell'
import { dropLive, restoreLive } from './support/live'
import {
  type HistoryRowView,
  LOCATION,
  type PageView,
  type QueueAddress,
  type QueueListView,
  consoleCall,
  enqueueOverPort,
  queueKey,
  registerQueue,
  uniqueId,
} from './support/messaging'

const enc = encodeURIComponent

/** Opens the Cloud Tasks page on a queue (by id: the page resolves it). */
async function openQueue(page: Page, engine: Engine, queue: string, search = '') {
  await page.goto(`${engine.origin}/console/tasks?queue=${enc(queue)}${search}`)
  await expect(page.getByTestId('queue-field-id')).toHaveText(queue)
}

/** Replaces what a JSON editor holds, as typing a whole value would. */
async function fillJson(page: Page, editor: Locator, text: string) {
  await editor.click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('Delete')
  await page.keyboard.insertText(text)
}

/** A queue's finished tasks, as the Console API answers them. */
async function historyOf(engine: Engine, queue: QueueAddress | string): Promise<HistoryRowView[]> {
  const key = typeof queue === 'string' ? queue : queue.key
  const page = await consoleCall<PageView<HistoryRowView>>(
    engine,
    'GET',
    `/tasks/history?queue=${enc(key)}&limit=500`,
  )
  return page.items
}

const PROCESS_ORDER = (engine: Engine) => queueKey(engine.project, LOCATION, 'processOrder')

/** A row of a table, by text it holds. */
const rowOf = (table: Locator, text: string) =>
  table.getByTestId('data-row').filter({ hasText: text })

test('J-TK-01 the queues register from their functions; badQueue_1 is refused; Configuration says where each value came from', async ({
  page,
  engine,
}) => {
  await page.goto(`${engine.origin}/console/tasks`)
  const tree = page.getByTestId('queues-tree')
  await expect(tree.getByRole('treeitem', { name: 'processOrder' })).toBeVisible()
  await expect(tree.getByRole('treeitem', { name: 'sendEmail' })).toBeVisible()
  await expect(tree.getByRole('treeitem', { name: 'Not registered' })).toBeVisible()
  await expect(tree.getByRole('treeitem', { name: 'badQueue_1' })).toBeVisible()
  // The root lists every queue and says why badQueue_1 is missing, in the engine's words.
  const list = await consoleCall<QueueListView>(engine, 'GET', '/tasks/queues')
  const reason = list.rejectedRegistrations.find((entry) => entry.name === 'badQueue_1')?.reason
  expect(reason).toBeTruthy()
  const rejected = page.getByTestId('tasks-rejected-banner')
  await expect(rejected).toContainText('badQueue_1')
  await expect(rejected).toContainText(reason?.replace(/[.\s]*$/, '') ?? '')
  const queues = page.getByTestId('queues-table')
  await expect(rowOf(queues, 'processOrder')).toBeVisible()
  await expect(rowOf(queues, 'sendEmail')).toBeVisible()

  await tree.getByRole('treeitem', { name: 'processOrder' }).click()
  await expect(page).toHaveURL(/queue=processOrder/)
  await expect(page).not.toHaveURL(/location=/)
  await page.getByRole('tab', { name: /^Configuration/ }).click()
  const value = (key: string) => page.locator(`[data-testid="config-value"][data-key="${key}"]`)
  const trigger = "processOrder's taskQueueTrigger"
  for (const [key, expected] of [
    ['retryConfig.maxAttempts', '3'],
    ['retryConfig.minBackoffSeconds', '1'],
    ['retryConfig.maxBackoffSeconds', '4'],
    ['rateLimits.maxConcurrentDispatches', '2'],
    ['rateLimits.maxDispatchesPerSecond', '10'],
  ] as const) {
    await expect(value(key).getByTestId('config-value-value')).toHaveText(expected)
    await expect(value(key).getByTestId('config-value-source')).toHaveText(trigger)
  }
  await expect(value('retryConfig.maxDoublings').getByTestId('config-value-value')).toHaveText('16')
  await expect(value('retryConfig.maxDoublings').getByTestId('config-value-source')).toHaveText(
    'emulator default',
  )
  await expect(page.getByTestId('config-queue-name')).toHaveText(
    `projects/${engine.project}/locations/${LOCATION}/queues/processOrder`,
  )
  // Live traffic is Configuration's: slots, and the rate limit, which holds nothing back.
  await expect(page.getByTestId('gauge-slots')).toBeVisible()
  await expect(page.getByTestId('gauge-rate')).toContainText('10 a second')
  // The ladder is the dispatcher's: four runs, the last after 7 s, with the off-by-one said.
  await expect(page.getByTestId('ladder-step')).toHaveCount(4)
  await expect(page.getByTestId('ladder-step').last()).toContainText('+7 s')
  await expect(page.getByTestId('config-off-by-one')).toContainText(
    'maxAttempts 3 runs a failing task 4 times',
  )
})

test('J-TK-02 a task enqueued from the console runs, and leaves Tasks for History as succeeded', async ({
  page,
  engine,
}) => {
  await openQueue(page, engine, 'processOrder')
  await page.keyboard.press('n')
  const dialog = page.getByTestId('enqueue-dialog')
  await expect(dialog).toBeVisible()
  await fillJson(page, page.getByTestId('enqueue-payload'), '{"orderId":"o_1"}')
  const id = uniqueId('tk02')
  await dialog.getByTestId('enqueue-id').fill(id)
  await dialog.getByTestId('enqueue-headers-toggle').click()
  await dialog.getByTestId('enqueue-headers-add-key').fill('x-synthetic-header')
  await dialog
    .getByTestId('enqueue-headers-row')
    .last()
    .getByTestId('enqueue-headers-value')
    .fill('console')
  await page.keyboard.press('ControlOrMeta+Enter')
  await expect(dialog).toBeHidden()

  // The inspector follows the new task through to its answer.
  const inspector = page.getByTestId('task-inspector')
  await expect(inspector).toBeVisible()
  await expect(inspector.getByTestId('task-outcome')).toHaveText('succeeded', { timeout: 20_000 })
  // It left the Tasks list by a patch, with no reload.
  await expect(rowOf(page.getByTestId('task-table'), id)).toHaveCount(0)
  await inspector.getByRole('tab', { name: /^Request/ }).click()
  await expect(inspector.getByTestId('task-headers')).toContainText('x-synthetic-header')
  await expect(inspector.getByTestId('task-headers')).toContainText('console')
  await inspector.getByRole('tab', { name: /^Attempts/ }).click()
  const attempt = inspector.getByTestId('attempt').first()
  // onTaskDispatched answers 204.
  await expect(attempt.getByTestId('attempt-status')).toHaveText('204')
  // The invocation it caused, from compute's record, a link into Functions.
  await expect(attempt.getByTestId('attempt-invocation').getByRole('link')).toBeVisible()

  await page.getByRole('tab', { name: /^History/ }).click()
  const row = rowOf(page.getByTestId('history-table'), id)
  await expect(row.getByTestId('history-outcome')).toHaveText('succeeded')
  await expect(row.getByTestId('task-result')).toHaveText('204')

  // Each attempt links to the lines its function printed, in Logs.
  await row.click()
  await page
    .getByTestId('task-inspector')
    .getByRole('tab', { name: /^Attempts/ })
    .click()
  await expect(page.getByTestId('attempt').first()).toBeVisible()
  await expect(page.getByTestId('attempt-logs').first()).toHaveAttribute(
    'href',
    /function%3Aus-central1-processOrder|function:us-central1-processOrder/,
  )
})

test('J-TK-03 a task name used before in this run is refused, and the dialog says why', async ({
  page,
  engine,
}) => {
  const id = uniqueId('tk03')
  const first = await enqueueOverPort(engine, { queue: 'processOrder' }, { orderId: 'o_3' }, { id })
  expect(first.status).toBe(200)
  // Opened as another section links to it (`tasksQueueLink(key, 'enqueue')`):
  // the dialog on the queue, the address cut to what it needs.
  await page.goto(
    `${engine.origin}/console/tasks?project=${engine.project}&queue=processOrder&location=${LOCATION}&new=task`,
  )
  const dialog = page.getByTestId('enqueue-dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('processOrder')
  await expect(page.getByTestId('queue-field-id')).toHaveText('processOrder')
  await expect(page).not.toHaveURL(/location=/)
  await expect(page).toHaveURL(/new=task/)
  await dialog.getByTestId('enqueue-id').fill(id)
  await dialog.getByTestId('enqueue-submit').click()
  const error = dialog.getByTestId('enqueue-error')
  await expect(error).toContainText(`A task named ${id} was enqueued before in this run.`)
  await expect(error).toContainText('The emulator keeps every task name until it stops.')
  await expect(dialog).toBeVisible()
})

test('J-TK-04 a failing task retries live, gives up after maxAttempts + 1, and counts on the badge', async ({
  page,
  engine,
}) => {
  await openQueue(page, engine, 'processOrder', '&new=task')
  const dialog = page.getByTestId('enqueue-dialog')
  await fillJson(page, page.getByTestId('enqueue-payload'), '{"orderId":"o_4","fail":true}')
  const id = uniqueId('tk04')
  await dialog.getByTestId('enqueue-id').fill(id)
  await dialog.getByTestId('enqueue-submit').click()
  const inspector = page.getByTestId('task-inspector')
  await inspector.getByRole('tab', { name: /^Attempts/ }).click()
  // Attempt 1 answers 500 with the SDK's error body; the backoff counts down.
  const first = inspector.getByTestId('attempt').first()
  await expect(first.getByTestId('attempt-status')).toHaveText('500', { timeout: 15_000 })
  await expect(first.getByTestId('attempt-response')).toContainText('card declined')
  await expect(inspector.getByTestId('task-state-word')).toHaveText('backoff')
  await expect(inspector.getByTestId('task-next')).toContainText('next attempt')
  await expect(inspector.getByTestId('task-retry-plan')).toContainText('last')
  // Somewhere else while it runs out of retries: the nav counts it.
  await page.goto(`${engine.origin}/console/firestore`)
  await expect(page.getByTestId('nav-badge-tasks')).toBeVisible({ timeout: 20_000 })
  await expect
    .poll(
      async () =>
        (await historyOf(engine, PROCESS_ORDER(engine))).find((row) => row.shortName === id)
          ?.outcome,
      {
        timeout: 20_000,
      },
    )
    .toBe('failed')

  await openQueue(page, engine, 'processOrder', '&view=history')
  const row = rowOf(page.getByTestId('history-table'), id)
  await expect(row.getByTestId('history-outcome')).toHaveText('failed')
  await expect(row).toContainText('4')
  await row.click()
  await expect(inspector.getByTestId('task-outcome')).toHaveText('failed')
  await inspector.getByRole('tab', { name: /^Attempts/ }).click()
  await expect(inspector.getByTestId('attempt')).toHaveCount(4)
  // Enqueue again opens the dialog filled from it.
  await inspector.getByTestId('task-enqueue-again').click()
  await expect(page).toHaveURL(/prefill=/)
  await expect(page.getByTestId('enqueue-dialog')).toBeVisible()
  await expect(page.getByTestId('enqueue-payload')).toContainText('"fail": true')
  await expect(page.getByTestId('enqueue-id')).toHaveValue('')
})

test('J-TK-05 pause holds tasks; Run now sends one past the pause; resume drains; purge empties into History', async ({
  page,
  engine,
}) => {
  const queue = await registerQueue(engine, uniqueId('tk05'))
  await openQueue(page, engine, queue.queue)
  await page.getByTestId('queue-pause').click()
  await expect(page.getByTestId('queue-resume')).toBeVisible()
  await expect(page.getByTestId('queue-paused')).toBeVisible()
  for (const order of ['a', 'b', 'c'])
    expect(
      (await enqueueOverPort(engine, queue, { orderId: order }, { id: `t-${order}` })).status,
    ).toBe(200)
  const table = page.getByTestId('task-table')
  await expect(table.getByTestId('data-row')).toHaveCount(3)
  await expect(rowOf(table, 't-b').getByTestId('task-state')).toHaveText('pending · #2')
  // One dispatcher serves every queue: a task of another queue enqueued
  // after these has run to the end, so the dispatcher has had its turns,
  // and the paused queue sent nothing.
  const other = await registerQueue(engine, uniqueId('tk05b'))
  expect((await enqueueOverPort(engine, other, { orderId: 'meanwhile' })).status).toBe(200)
  await expect
    .poll(async () => (await historyOf(engine, other)).map((row) => row.outcome), {
      timeout: 15_000,
    })
    .toEqual(['succeeded'])
  expect(
    (
      await consoleCall<PageView<unknown>>(
        engine,
        'GET',
        `/tasks/tasks?queue=${enc(queue.key)}&limit=1`,
      )
    ).total,
  ).toEqual({ count: 3, exact: true })
  await expect(table.getByTestId('data-row')).toHaveCount(3)

  // r on the cursor row asks first; Enter confirms.
  await rowOf(table, 't-b').click()
  await page.getByTestId('task-inspector-close').click()
  await page.keyboard.press('r')
  const confirm = page.getByTestId('run-confirm')
  await expect(confirm).toContainText('Run t-b now?')
  await page.keyboard.press('Enter')
  await expect(rowOf(table, 't-b')).toHaveCount(0, { timeout: 15_000 })
  await expect(table.getByTestId('data-row')).toHaveCount(2)
  await expect
    .poll(async () =>
      (await historyOf(engine, queue)).map((row) => `${row.shortName}:${row.outcome}`),
    )
    .toEqual(['t-b:succeeded'])

  await page.getByTestId('queue-resume').click()
  await expect(table.getByTestId('data-row')).toHaveCount(0, { timeout: 15_000 })
  await expect
    .poll(async () => (await historyOf(engine, queue)).length, { timeout: 15_000 })
    .toBe(3)

  await page.getByTestId('queue-pause').click()
  for (let index = 0; index < 5; index += 1)
    expect((await enqueueOverPort(engine, queue, { orderId: `p${index}` })).status).toBe(200)
  await expect(table.getByTestId('data-row')).toHaveCount(5)
  await page.getByTestId('queue-purge').click()
  const purge = page.getByTestId('queue-purge-confirm')
  await expect(purge).toContainText('5 pending')
  await purge.getByTestId('queue-purge-confirm-confirm').click()
  await expect(table.getByTestId('data-row')).toHaveCount(0)
  await page.getByRole('tab', { name: /^History/ }).click()
  await expect(page.getByRole('tab', { name: /^Purged/ })).toContainText('5')
  await page.getByRole('tab', { name: /^Purged/ }).click()
  await expect(page.getByTestId('history-table').getByTestId('data-row')).toHaveCount(5)
})

test('J-TK-06 Stop retrying moves a task in backoff to History as cancelled and frees its slot', async ({
  page,
  engine,
}) => {
  const queue = await registerQueue(engine, uniqueId('tk06'), {
    retryConfig: { maxAttempts: 5, minBackoffSeconds: 60, maxBackoffSeconds: 60 },
  })
  const id = 'stuck-1'
  await enqueueOverPort(engine, queue, { orderId: 'o_6', fail: true }, { id })
  await openQueue(page, engine, queue.queue)
  const row = rowOf(page.getByTestId('task-table'), id)
  await expect(row.getByTestId('task-state')).toHaveText('backoff', { timeout: 15_000 })
  await expect(page.getByTestId('slots-tokens')).toContainText('1/')
  await row.click()
  await page.getByTestId('task-stop').click()
  await expect(row).toHaveCount(0)
  await expect(page.getByTestId('slots-tokens')).toContainText('0/')
  await expect.poll(async () => (await historyOf(engine, queue))[0]?.outcome).toBe('cancelled')
})

test('J-TK-07 holding scheduled tasks makes a delay wait; Run now releases it; off, a delay runs at once', async ({
  page,
  engine,
}) => {
  const queue = await registerQueue(engine, uniqueId('tk07'))
  await openQueue(page, engine, queue.queue, '&view=config')
  await page.getByTestId('config-hold').getByRole('switch').click()
  await expect(page.getByTestId('queue-holding')).toBeVisible()

  await page.getByTestId('tasks-enqueue').click()
  const dialog = page.getByTestId('enqueue-dialog')
  await dialog.getByTestId('enqueue-id').fill('later-1')
  await dialog.getByTestId('enqueue-delay').fill('30')
  await expect(dialog.getByTestId('enqueue-delay-note')).toContainText('waits as held')
  await dialog.getByTestId('enqueue-submit').click()
  await page.getByRole('tab', { name: /^Tasks/ }).click()
  const row = rowOf(page.getByTestId('task-table'), 'later-1')
  await expect(row.getByTestId('task-state')).toHaveText(/^held · due in (30|29|28) s$/)
  await row.click()
  await page.getByTestId('task-run').click()
  await page.getByTestId('run-confirm-confirm').click()
  await expect
    .poll(async () => (await historyOf(engine, queue))[0]?.outcome, { timeout: 15_000 })
    .toBe('succeeded')

  // Off again: the emulator's own behaviour, a schedule time does not delay.
  await page.getByRole('tab', { name: /^Configuration/ }).click()
  await page.getByTestId('config-hold').getByRole('switch').click()
  await expect(page.getByTestId('queue-holding')).toHaveCount(0)
  expect(
    (
      await enqueueOverPort(
        engine,
        queue,
        { orderId: 'now' },
        { id: 'later-2', scheduleDelaySeconds: 30 },
      )
    ).status,
  ).toBe(200)
  await expect
    .poll(
      async () =>
        (await historyOf(engine, queue)).find((finished) => finished.shortName === 'later-2')
          ?.outcome,
      {
        timeout: 15_000,
      },
    )
    .toBe('succeeded')
})

test('J-TK-08 a task an app enqueues appears without a reload', async ({ page, engine }) => {
  await openQueue(page, engine, 'processOrder', '&view=history')
  const id = uniqueId('tk08')
  expect(
    (await enqueueOverPort(engine, { queue: 'processOrder' }, { orderId: 'o_8' }, { id })).status,
  ).toBe(200)
  const row = rowOf(page.getByTestId('history-table'), id)
  await expect(row.getByTestId('history-outcome')).toHaveText('succeeded', { timeout: 15_000 })
})

test('J-TK-09 an auto-named task, which the API cannot delete, deletes from the console', async ({
  page,
  engine,
}) => {
  const queue = await registerQueue(engine, uniqueId('tk09'))
  await consoleCall(engine, 'POST', '/tasks/queue/pause', { queue: queue.key })
  expect((await enqueueOverPort(engine, queue, { orderId: 'o_9' })).status).toBe(200)
  await openQueue(page, engine, queue.queue)
  const row = page.getByTestId('task-table').getByTestId('data-row').first()
  const name = row.getByTestId('task-generated')
  await expect(name).toHaveText(/^auto·\d{1,4}$/)
  await row.getByTestId('row-menu-button').click()
  await page.getByTestId('row-menu-delete').click()
  const confirm = page.getByTestId('task-delete')
  await expect(confirm).toContainText('The Cloud Tasks API cannot delete an auto-named task')
  await confirm.getByTestId('task-delete-confirm').click()
  await expect(page.getByTestId('task-table').getByTestId('data-row')).toHaveCount(0)
  await expect.poll(async () => (await historyOf(engine, queue))[0]?.outcome).toBe('deleted')
})

test('J-TK-11 a dropped channel is said once, by the engine badge; what arrived meanwhile is listed after', async ({
  page,
  engine,
}) => {
  const queue = await registerQueue(engine, uniqueId('tk11'))
  await consoleCall(engine, 'POST', '/tasks/queue/pause', { queue: queue.key })
  await openQueue(page, engine, queue.queue)
  await expect(page.getByTestId('tasks-empty')).toBeVisible()
  const badge = badgeOf(page)
  await dropLive(page)
  await expect(badge).toHaveText('reconnecting', { timeout: 3_000 })
  await expect(page.getByTestId('live-notice')).toHaveCount(0)
  expect(
    (await enqueueOverPort(engine, queue, { orderId: 'o_11' }, { id: 'missed-1' })).status,
  ).toBe(200)
  await restoreLive(page)
  await expect(badge).toHaveText(/^engine /, { timeout: 15_000 })
  await expect(rowOf(page.getByTestId('task-table'), 'missed-1')).toBeVisible({ timeout: 10_000 })
})

test('J-TK-13 a queue re-registered with new options says what it dropped, and keeps its pause and History', async ({
  page,
  engine,
}) => {
  const id = uniqueId('tk13')
  const queue = await registerQueue(engine, id)
  await consoleCall(engine, 'POST', '/tasks/queue/pause', { queue: queue.key })
  for (const order of ['a', 'b', 'c']) await enqueueOverPort(engine, queue, { orderId: order })
  await openQueue(page, engine, queue.queue)
  await expect(page.getByTestId('task-table').getByTestId('data-row')).toHaveCount(3)
  await registerQueue(engine, id, { retryConfig: { maxAttempts: 7 } })
  const banner = page.getByTestId('tasks-replaced-banner')
  await expect(banner).toContainText(`${id} re-registered at`)
  await expect(banner).toContainText('3 tasks were dropped (see History)')
  await expect(page.getByTestId('queue-resume')).toBeVisible()
  await expect(page.getByTestId('task-table').getByTestId('data-row')).toHaveCount(0)
  await banner.getByRole('button', { name: 'Show replaced' }).click()
  await expect(page.getByTestId('history-table').getByTestId('data-row')).toHaveCount(3)
  await expect(page.getByTestId('history-table').getByTestId('history-outcome').first()).toHaveText(
    'replaced',
  )
  await page.getByRole('tab', { name: /^Configuration/ }).click()
  await expect(
    page
      .locator('[data-testid="config-value"][data-key="retryConfig.maxAttempts"]')
      .getByTestId('config-value-value'),
  ).toHaveText('7')
  await expect(page.getByTestId('config-registrations')).toContainText('2 registrations')
})

test('J-TK-14 an enqueue into a queue in another region is listed, with where the queue is', async ({
  page,
  engine,
}) => {
  await page.goto(`${engine.origin}/console/tasks`)
  await expect(page.getByTestId('queues-table')).toBeVisible()
  const refused = await enqueueOverPort(
    engine,
    { queue: 'processOrder', location: 'us-east1' },
    { orderId: 'o_14' },
  )
  expect(refused.status).toBe(404)
  const tree = page.getByTestId('queues-tree')
  await expect(tree.getByRole('treeitem', { name: 'Refused enqueues' })).toBeVisible()
  await expect(tree.getByRole('treeitem', { name: 'us-east1/processOrder' })).toBeVisible()
  const banner = page
    .getByTestId('tasks-refused-banner')
    .filter({ hasText: 'us-east1/processOrder' })
  await expect(banner).toContainText('processOrder is registered in us-central1')
  await banner.getByTestId('tasks-refused-open').click()
  await expect(page.getByTestId('queue-field-id')).toHaveText('processOrder')
})

test('J-TK-15 a queue’s attempts are its function’s invocations: the link opens them filtered, live', async ({
  page,
  engine,
}) => {
  await openQueue(page, engine, 'processOrder')
  const link = page.getByTestId('queue-attempts-link')
  await expect(link).toHaveText('Attempts in Invocations')
  await link.click()
  await expect(page).toHaveURL(/\/console\/functions\/invocations\?/)
  await expect(page.getByTestId('invocations-filter-input')).toHaveValue(
    'function:us-central1-processOrder',
  )
  // A failing task's attempts arrive there as they happen, one row each.
  const id = uniqueId('tk15')
  expect(
    (
      await enqueueOverPort(
        engine,
        { queue: 'processOrder' },
        { orderId: 'o_15', fail: true },
        { id },
      )
    ).status,
  ).toBe(200)
  const attempts = page
    .getByTestId('invocations-list')
    .getByTestId('invocation-row')
    .filter({ hasText: `task ${id}` })
  await expect(attempts.filter({ hasText: 'attempt 2' })).toHaveCount(1, { timeout: 20_000 })
  await expect(attempts.filter({ hasText: 'attempt 1' })).toHaveAttribute('data-outcome', 'failed')
})

test('J-TK-16 ticked tasks delete and run as jobs; a task prints as code for the Tasks port', async ({
  page,
  engine,
}) => {
  const queue = await registerQueue(engine, uniqueId('tk16'))
  await consoleCall(engine, 'POST', '/tasks/queue/pause', { queue: queue.key })
  for (const name of ['bulk-1', 'bulk-2', 'bulk-3', 'bulk-4'])
    await enqueueOverPort(engine, queue, { orderId: name }, { id: name })
  await openQueue(page, engine, queue.queue)
  const table = page.getByTestId('task-table')
  await expect(table.getByTestId('data-row')).toHaveCount(4)

  // The task as code: curl to the Tasks port with its name and base64 body.
  await rowOf(table, 'bulk-1').click()
  await page.getByTestId('task-code').click()
  const code = page.getByTestId('task-code-popover')
  await code.getByRole('tab', { name: 'curl' }).click()
  await expect(code).toContainText(
    `:${engine.ports.tasks}/projects/${engine.project}/locations/${LOCATION}/queues/${queue.queue}/tasks`,
  )
  await expect(code).toContainText(`tasks/bulk-1`)
  await page.keyboard.press('Escape')
  await page.getByTestId('task-inspector-close').click()

  // Two ticked, Delete: a tasks.delete job, its progress in the confirmation.
  await rowOf(table, 'bulk-1').getByRole('checkbox').click()
  await rowOf(table, 'bulk-2').getByRole('checkbox').click()
  await expect(page.getByTestId('selection-count')).toHaveText('2 selected')
  await page.keyboard.press('Delete')
  const confirm = page.getByTestId('tasks-delete')
  await confirm.getByTestId('tasks-delete-confirm').click()
  await expect(confirm.getByTestId('tasks-delete-progress')).toContainText('2', { timeout: 15_000 })
  await confirm.getByTestId('tasks-delete-cancel').click()
  await expect(table.getByTestId('data-row')).toHaveCount(2)

  // ⌘A, Run now…: one confirmation for both, a tasks.run job past the pause.
  await table.getByTestId('data-row').first().click()
  await page.getByTestId('task-inspector-close').click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.getByTestId('tasks-run-ticked').click()
  await page.getByTestId('run-many-confirm-confirm').click()
  await expect(table.getByTestId('data-row')).toHaveCount(0, { timeout: 15_000 })
  await expect
    .poll(async () => (await historyOf(engine, queue)).map((row) => row.outcome).toSorted(), {
      timeout: 15_000,
    })
    .toEqual(['deleted', 'deleted', 'succeeded', 'succeeded'])
})

test('J-TK-17 ⌘K opens a queue and acts on the queue in view', async ({ page, engine }) => {
  const queue = await registerQueue(engine, uniqueId('tk17'))
  await openQueue(page, engine, 'processOrder')
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByTestId('palette-input').fill(queue.queue)
  await page
    .getByRole('option', { name: new RegExp(`^${queue.queue}`) })
    .first()
    .click()
  await expect(page.getByTestId('queue-field-id')).toHaveText(queue.queue)
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByTestId('palette-input').fill(`pause ${queue.queue}`)
  await page.getByRole('option', { name: `Pause ${queue.queue}` }).click()
  await expect(page.getByTestId('queue-resume')).toBeVisible()
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByTestId('palette-input').fill(`resume ${queue.queue}`)
  await page.getByRole('option', { name: `Resume ${queue.queue}` }).click()
  await expect(page.getByTestId('queue-pause')).toBeVisible()
})

test('a task enqueued while the queue page subscribes is listed', async ({ page, engine }) => {
  const queue = await registerQueue(engine, uniqueId('race'))
  // The page's live subscriptions wait until its first read of the tasks is
  // in, and a task is enqueued in between: `tasks.queue` names what changes
  // from the moment the engine takes it, so no event will tell of this one.
  let release: (() => void) | undefined
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route(/\/console\/api\/v1\/live\/[^/]+\/subscriptions$/, async (route) => {
    await held
    await route.continue()
  })
  try {
    const read = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/console/api/v1/tasks/tasks',
    )
    await openQueue(page, engine, queue.queue)
    await read
    const id = `race-${Date.now()}`
    // An hour out, so it stays pending for the length of the journey.
    expect(
      (await enqueueOverPort(engine, queue, { orderId: id }, { id, scheduleDelaySeconds: 3_600 }))
        .status,
    ).toBe(200)
    release?.()
    await expect(rowOf(page.getByTestId('task-table'), id)).toBeVisible()
  } finally {
    release?.()
    await page.unrouteAll({ behavior: 'ignoreErrors' })
  }
})
