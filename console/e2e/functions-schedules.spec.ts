// A scheduled function's Schedule tab and the overview's Next run, against
// a real engine with the messaging profile's functions (this file's own
// worker engine): `nightlyCleanup` (every 5 minutes) and `weeklyDigest`
// (`0 9 * * 1` in Europe/Paris, which throws). The scheduler is Pub/Sub's;
// the console's place for a schedule is its function. The clock may tick
// `nightlyCleanup` during a journey, so runs are asserted by what the
// console started and by deltas, never by absolute counts; a pause is
// undone in `finally`.

import type { Page } from '@playwright/test'
import { type Engine, expect, test } from './fixtures'
import { type ScheduleView, consoleCall, topicName } from './support/messaging'

test.use({ profile: 'messaging' })

const enc = encodeURIComponent
const NIGHTLY = 'us-central1-nightlyCleanup'
const DIGEST = 'us-central1-weeklyDigest'

/** A schedule as the engine reports it now. */
async function scheduleOf(engine: Engine, functionId: string) {
  const page = await consoleCall<{ items: ScheduleView[] }>(engine, 'GET', '/pubsub/schedules')
  const found = page.items.find((item) => item.functionId === functionId)
  if (!found) throw new Error(`No schedule ${functionId}`)
  return found
}

/** A scheduled function's Schedule tab (its Run tab). */
async function openSchedule(page: Page, engine: Engine, functionId: string) {
  await page.goto(`${engine.origin}/console/functions?function=${enc(functionId)}&tab=run`)
  await expect(page.getByTestId('schedule-form')).toBeVisible()
}

/** The next Monday 09:00 in Paris after `from`, as an instant (08:00Z in winter, 07:00Z in summer). */
function nextParisMonday(from: Date): Date {
  const paris = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Paris',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
  // Walk whole hours forward until Paris reads Monday 09:00.
  const start = new Date(from)
  start.setUTCMinutes(0, 0, 0)
  for (let hours = 1; hours <= 24 * 8; hours += 1) {
    const at = new Date(start.getTime() + hours * 3_600_000)
    const parts = Object.fromEntries(paris.formatToParts(at).map((part) => [part.type, part.value]))
    if (parts.weekday === 'Mon' && parts.hour === '09' && parts.minute === '00') return at
  }
  throw new Error('No Monday 09:00 in Paris within a week')
}

/** The runs the console started, newest first, among those kept. */
const consoleRuns = (schedule: ScheduleView) =>
  [...schedule.lastRuns, ...(schedule.firstRun ? [schedule.firstRun] : [])].filter(
    (run) => run.trigger === 'console',
  )

test('J-SH-01 the overview says when each schedule runs next; its tab, in words and in its zone', async ({
  page,
  engine,
}) => {
  await page.goto(`${engine.origin}/console/functions`)
  const table = page.getByTestId('functions-overview')
  const nightly = table.locator(`tr[data-key="${NIGHTLY}"]`)
  await expect(nightly.getByTestId('overview-next')).toHaveAttribute('data-state', 'running')
  await expect(nightly.getByTestId('overview-next')).toHaveText(/^(in \d+ (s|min)|due now)$/)
  await expect(nightly.getByTestId('overview-trigger')).toHaveText('every 5 minutes')
  const nightlyNext = Date.parse((await scheduleOf(engine, NIGHTLY)).nextRunAt ?? '')
  expect(nightlyNext - Date.now()).toBeLessThanOrEqual(5 * 60_000)

  // The cron in its zone: in words in the trigger, next due at 09:00 in Paris.
  const digest = table.locator(`tr[data-key="${DIGEST}"]`)
  await expect(digest.getByTestId('overview-trigger')).toHaveText(
    '0 9 * * 1 (every Monday at 09:00) · Europe/Paris',
  )
  const expected = nextParisMonday(new Date())
  expect((await scheduleOf(engine, DIGEST)).nextRunAt).toBe(expected.toISOString())
  await digest.getByTestId('overview-next').hover()
  await expect(page.locator('.kumo-tooltip-popup')).toContainText('09:00 Europe/Paris')

  // Its tab: the expression and its words, the zone declared, the next five.
  await openSchedule(page, engine, DIGEST)
  await expect(page.getByTestId('schedule-expression')).toHaveText('0 9 * * 1')
  await expect(page.getByTestId('schedule-words')).toHaveText('every Monday at 09:00')
  await expect(page.getByTestId('schedule-zone')).toHaveText('Declared Europe/Paris')
  await expect(page.getByTestId('schedule-state')).toHaveAttribute('data-state', 'running')
  await expect(page.getByTestId('schedule-upcoming-run')).toHaveCount(5)
  await expect(page.getByTestId('schedule-upcoming-run').first()).toContainText('09:00')
})

test('J-SH-02 run now publishes the tick, the run is delivered and its message one link away', async ({
  page,
  engine,
}) => {
  const before = await scheduleOf(engine, NIGHTLY)
  await openSchedule(page, engine, NIGHTLY)
  await expect(page.getByTestId('schedule-zone')).toHaveText('None declared · evaluated in UTC')
  await page.getByTestId('schedule-run').click()
  await expect(page.getByTestId('schedule-run-result')).toContainText('Published its tick')
  await expect(page.getByTestId('run-outcome')).toContainText('Succeeded', { timeout: 15_000 })

  // Live: a console run, delivered, one more run counted.
  const run = page.getByTestId('schedule-tick').and(page.locator('[data-trigger="console"]'))
  await expect(run.first()).toHaveAttribute('data-mark', 'delivered', { timeout: 15_000 })
  const after = await scheduleOf(engine, NIGHTLY)
  expect(after.runs).toBeGreaterThan(before.runs)
  const latest = consoleRuns(after)[0]
  expect(latest?.delivery?.mark).toBe('delivered')

  // Its tick is a message of the schedule topic, one link away in Pub/Sub.
  const messages = await consoleCall<{ items: { id: string }[] }>(
    engine,
    'GET',
    `/pubsub/messages?topic=${enc(topicName(engine, 'firebase-schedule-nightlyCleanup'))}`,
  )
  expect(messages.items.map((item) => item.id)).toContain(latest?.messageId)
  await run.first().getByTestId('schedule-run-message-link').click()
  await expect(page).toHaveURL(/\/console\/pubsub\?/)
  // (An id of digits travels quoted, so the router reads it back as text.)
  await expect(page).toHaveURL(new RegExp(`message=(%22)?${latest?.messageId ?? ''}(%22)?(&|$)`))
  await expect(page.getByTestId('pubsub-message-inspector')).toBeVisible()
})

test('J-SH-03 a failing schedule says what its handler threw', async ({ page, engine }) => {
  const before = await scheduleOf(engine, DIGEST)
  await openSchedule(page, engine, DIGEST)
  await page.getByTestId('schedule-run').click()
  const run = page.getByTestId('schedule-tick').and(page.locator('[data-trigger="console"]'))
  await expect(run.first()).toHaveAttribute('data-mark', 'failed', { timeout: 15_000 })
  await expect(run.first().getByTestId('schedule-run-error')).toContainText(
    'digest service unavailable',
  )
  expect((await scheduleOf(engine, DIGEST)).runs).toBe(before.runs + 1)
})

test('J-SH-04 pause and resume a schedule’s clock, live in the tab and the overview', async ({
  page,
  engine,
}) => {
  try {
    await openSchedule(page, engine, NIGHTLY)
    const state = page.getByTestId('schedule-state')
    await expect(state).toHaveAttribute('data-state', 'running')
    await page.getByTestId('schedule-pause').click()
    await expect(state).toHaveAttribute('data-state', 'paused')
    await expect(page.getByTestId('schedule-paused-note')).toBeVisible()
    expect((await scheduleOf(engine, NIGHTLY)).paused).toBe(true)
    await expect(page.getByTestId('schedule-pause')).toHaveText('Resume')

    // The overview says so too.
    await page.goto(`${engine.origin}/console/functions`)
    const next = page
      .getByTestId('functions-overview')
      .locator(`tr[data-key="${NIGHTLY}"]`)
      .getByTestId('overview-next')
    await expect(next).toHaveAttribute('data-state', 'paused')

    await openSchedule(page, engine, NIGHTLY)
    await page.getByTestId('schedule-pause').click()
    await expect(page.getByTestId('schedule-state')).toHaveAttribute('data-state', 'running')
    expect((await scheduleOf(engine, NIGHTLY)).paused).toBe(false)
  } finally {
    await consoleCall(engine, 'POST', '/pubsub/schedule/resume', { functionId: NIGHTLY })
  }
})

test('J-SH-05 a schedule found in Pub/Sub or ⌘K opens its function’s Schedule tab', async ({
  page,
  engine,
}) => {
  // The Pub/Sub tree keeps the schedule topics; a scheduled function's row opens it.
  await page.goto(`${engine.origin}/console/pubsub`)
  const tree = page.getByTestId('pubsub-tree')
  const group = tree.getByRole('treeitem', { name: 'Function schedules', exact: true })
  if ((await group.getAttribute('aria-expanded')) !== 'true')
    await group.getByTestId('panel-tree-toggle').click()
  const topic = tree.getByRole('treeitem', {
    name: 'firebase-schedule-nightlyCleanup',
    exact: true,
  })
  if ((await topic.getAttribute('aria-expanded')) !== 'true')
    await topic.getByTestId('panel-tree-toggle').click()
  await tree.getByRole('treeitem', { name: 'nightlyCleanup', exact: true }).click()
  await expect(page).toHaveURL(/\/console\/functions\?/)
  await expect(page.getByTestId('schedule-form')).toBeVisible()
  await expect(page.getByTestId('schedule-expression')).toHaveText('every 5 minutes')

  // ⌘K's schedule hit opens the same tab.
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByTestId('palette-input').fill('weeklyDigest')
  await page.getByRole('option').filter({ hasText: 'Schedule · 0 9 * * 1' }).click()
  await expect(page).toHaveURL(new RegExp(`function=${DIGEST}`))
  await expect(page.getByTestId('schedule-expression')).toHaveText('0 9 * * 1')
})
