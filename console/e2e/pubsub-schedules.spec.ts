// Pub/Sub's Schedules page against a real engine (project `messaging`): the
// fixture's `nightlyCleanup` (every 5 minutes) and `weeklyDigest` (`0 9 * *
// 1` in Europe/Paris, which throws). The clock may tick `nightlyCleanup`
// during a journey, so runs are asserted by what the console started and by
// deltas, never by absolute counts; a pause is undone in `finally`.

import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { type ScheduleView, consoleCall, topicName } from './support/messaging'

const enc = encodeURIComponent
const NIGHTLY = 'us-central1-nightlyCleanup'
const DIGEST = 'us-central1-weeklyDigest'

/** A schedule as the engine reports it now. */
async function scheduleOf(engine: Parameters<typeof consoleCall>[0], functionId: string) {
  const page = await consoleCall<{ items: ScheduleView[] }>(engine, 'GET', '/pubsub/schedules')
  const found = page.items.find((item) => item.functionId === functionId)
  if (!found) throw new Error(`No schedule ${functionId}`)
  return found
}

/** The Schedules page, with a schedule open or not. */
async function openSchedules(page: Page, origin: string, schedule?: string) {
  await page.goto(
    `${origin}/console/pubsub/schedules${schedule ? `?schedule=${enc(schedule)}` : ''}`,
  )
  await expect(page.getByTestId('pubsub-schedules-page')).toBeVisible()
}

const row = (page: Page, functionId: string) =>
  page.getByTestId('pubsub-schedules-table').locator(`tr[data-key="${functionId}"]`)

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

test('J-SH-01 the table: schedules in words, their zone and their next run', async ({
  page,
  engine,
}) => {
  await openSchedules(page, engine.origin)
  const nightly = row(page, NIGHTLY)
  await expect(nightly).toContainText('nightlyCleanup')
  await expect(nightly).toContainText('every 5 minutes')
  await expect(nightly).toContainText('us-central1')
  await expect(nightly.getByTestId('schedule-state')).toHaveAttribute('data-state', 'running')
  const nightlyNext = Date.parse((await scheduleOf(engine, NIGHTLY)).nextRunAt ?? '')
  expect(nightlyNext - Date.now()).toBeLessThanOrEqual(5 * 60_000)
  await expect(nightly.getByTestId('schedule-next')).toHaveText(/^(in \d+ (s|min)|due now)$/)

  // The cron in its zone: in words, and next due at 09:00 in Paris.
  const digest = row(page, DIGEST)
  await expect(digest).toContainText('0 9 * * 1')
  await expect(digest).toContainText('every Monday at 09:00')
  await expect(digest).toContainText('Europe/Paris')
  const expected = nextParisMonday(new Date())
  expect((await scheduleOf(engine, DIGEST)).nextRunAt).toBe(expected.toISOString())
  await digest.getByTestId('schedule-next').hover()
  await expect(page.locator('.kumo-tooltip-popup')).toContainText('09:00 Europe/Paris')

  // Opened: the next five, in the zone and here.
  await digest.click()
  const inspector = page.getByTestId('pubsub-schedule-inspector')
  await expect(inspector.getByTestId('schedule-zone')).toContainText('Europe/Paris')
  await expect(inspector.getByTestId('schedule-upcoming-run')).toHaveCount(5)
  await expect(inspector.getByTestId('schedule-upcoming-run').first()).toContainText('09:00')
})

/** The runs the console started, newest first, among those kept. */
const consoleRuns = (schedule: ScheduleView) =>
  [...schedule.lastRuns, ...(schedule.firstRun ? [schedule.firstRun] : [])].filter(
    (run) => run.trigger === 'console',
  )

test('J-SH-02 run now asks first, then the tick is delivered and its message kept', async ({
  page,
  engine,
}) => {
  const before = await scheduleOf(engine, NIGHTLY)
  await openSchedules(page, engine.origin)
  await row(page, NIGHTLY).click()
  const inspector = page.getByTestId('pubsub-schedule-inspector')
  await expect(inspector).toBeVisible()
  // Escape the inspector's own focus: `r` belongs to the page.
  await page.getByTestId('pubsub-schedules-field').click()
  await page.keyboard.press('r')
  const confirm = page.getByTestId('pubsub-run-now')
  await expect(confirm).toContainText('Run nightlyCleanup now?')
  await expect(confirm).toContainText('It runs your function’s code')
  // Nothing has run on the key alone.
  expect(consoleRuns(await scheduleOf(engine, NIGHTLY))).toHaveLength(consoleRuns(before).length)
  await page.keyboard.press('Enter')
  await expect(confirm).toBeHidden()

  // Live: a console run, delivered, one more run counted.
  const run = inspector.getByTestId('schedule-run').and(page.locator('[data-trigger="console"]'))
  await expect(run.first()).toHaveAttribute('data-mark', 'delivered', { timeout: 15_000 })
  const after = await scheduleOf(engine, NIGHTLY)
  expect(after.runs).toBeGreaterThan(before.runs)
  const latest = consoleRuns(after)[0]
  expect(latest?.delivery?.mark).toBe('delivered')

  // Its tick is a message of the schedule topic, one link away.
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
  await openSchedules(page, engine.origin, DIGEST)
  await page.getByTestId('schedule-run-now').click()
  const confirm = page.getByTestId('pubsub-run-now')
  await expect(confirm).toContainText('Run weeklyDigest now?')
  await page.getByTestId('pubsub-run-now-confirm').click()
  await expect(confirm).toBeHidden()
  const inspector = page.getByTestId('pubsub-schedule-inspector')
  const run = inspector.getByTestId('schedule-run').first()
  await expect(run).toHaveAttribute('data-trigger', 'console')
  await expect(run).toHaveAttribute('data-mark', 'failed', { timeout: 15_000 })
  await expect(run.getByTestId('schedule-run-error')).toContainText('digest service unavailable')
  // The table's last run says so too, and the count moved by one.
  await expect(row(page, DIGEST).getByTestId('schedule-last')).toBeVisible()
  expect((await scheduleOf(engine, DIGEST)).runs).toBe(before.runs + 1)
})

test('J-SH-04 pause and resume a schedule’s clock, live', async ({ page, engine }) => {
  try {
    await openSchedules(page, engine.origin, NIGHTLY)
    const state = row(page, NIGHTLY).getByTestId('schedule-state')
    await expect(state).toHaveAttribute('data-state', 'running')
    await page.getByTestId('schedule-pause').click()
    await expect(state).toHaveAttribute('data-state', 'paused')
    await expect(page.getByTestId('schedule-inspector-state')).toContainText('paused')
    await expect(page.getByTestId('schedule-paused-note')).toBeVisible()
    expect((await scheduleOf(engine, NIGHTLY)).paused).toBe(true)
    await expect(page.getByTestId('schedule-pause')).toHaveText('Resume')
    await page.getByTestId('schedule-pause').click()
    await expect(state).toHaveAttribute('data-state', 'running')
    expect((await scheduleOf(engine, NIGHTLY)).paused).toBe(false)
  } finally {
    await consoleCall(engine, 'POST', '/pubsub/schedule/resume', { functionId: NIGHTLY })
  }
})
