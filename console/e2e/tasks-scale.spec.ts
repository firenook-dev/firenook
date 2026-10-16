// J-TK-10 (messaging spec §9.3, @perf): a Cloud Tasks queue at the
// emulator's capacity — sendEmail paused with 10,000 pending tasks. Opt-in:
//
//   FIRENOOK_PERF=1 npx playwright test e2e/tasks-scale.spec.ts
//
// The journey starts an engine of its own and fills the queue through the
// Tasks port (`scripts/seed/tasks.mjs` with `large`), so the messaging
// project's worker engine never carries the load; the file holds no worker
// engine.

import { dedicated, expect } from './fixtures'
import { seed as seedTasks } from '../scripts/seed/tasks.mjs'
import { LOCATION, type PageView, consoleCall, queueKey, scrollToEnd } from './support/messaging'

dedicated.use({ workerEngine: false })

const PERF = process.env.FIRENOOK_PERF === '1'
const enc = encodeURIComponent
const figure = (n: number) => n.toLocaleString('en-US')

/** Pending tasks one queue holds at most (`tasks-front` `QUEUE_CAPACITY`). */
const CAPACITY = 10_000
/** What a virtualized list may hold in the DOM at once: a screen and its overscan, never the list. */
const DOM_ROWS = 120

dedicated.describe('@perf', () => {
  dedicated.skip(!PERF, 'opt-in: FIRENOOK_PERF=1')

  dedicated(
    '@perf J-TK-10 10,000 pending tasks: counted exactly, a screen of rows in the DOM, full, then purged',
    async ({ page, dedicatedEngine }) => {
      dedicated.setTimeout(600_000)
      const engine = await dedicatedEngine('messaging', { seed: false })
      await seedTasks(engine, { large: true })
      const key = queueKey(engine.project, LOCATION, 'sendEmail')
      const pending = async () =>
        (
          await consoleCall<PageView<{ id: string }>>(
            engine,
            'GET',
            `/tasks/tasks?queue=${enc(key)}&limit=1`,
          )
        ).total
      expect(await pending()).toEqual({ count: CAPACITY, exact: true })

      await page.setViewportSize({ width: 1440, height: 900 })
      await page.goto(`${engine.origin}/console/tasks?queue=sendEmail`)
      await expect(page.getByTestId('queue-field-id')).toHaveText('sendEmail')
      await expect(page.getByTestId('queue-paused')).toBeVisible()
      await expect(page.getByTestId('tasks-filter-count')).toHaveText(`${figure(CAPACITY)} tasks`)

      // To the end of the queue: the last row is the last place in line,
      // numbered as the 10,000th row, with a screen of rows in the DOM.
      const table = page.getByTestId('task-table')
      await expect(table.getByTestId('data-row').first()).toBeVisible()
      const walk = await scrollToEnd(page.getByTestId('task-table-scroll'), {
        rows: '[data-testid="data-row"]',
        want: `[data-testid="data-row"][aria-rowindex="${CAPACITY + 1}"]`,
      })
      dedicated.info().annotations.push({ type: 'task rows', description: String(walk.most) })
      expect(walk.most).toBeLessThan(DOM_ROWS)
      const last = table.locator(`[data-testid="data-row"][aria-rowindex="${CAPACITY + 1}"]`)
      await expect(last.getByTestId('task-state')).toHaveText(`pending · #${figure(CAPACITY)}`)

      // One more, from the console: the engine's queue-full refusal, in the dialog.
      await page.getByTestId('tasks-enqueue').click()
      const dialog = page.getByTestId('enqueue-dialog')
      await expect(dialog).toBeVisible()
      await page.getByTestId('enqueue-submit').click()
      await expect(page.getByTestId('enqueue-error')).toHaveText(
        `sendEmail holds ${figure(CAPACITY)} pending tasks, the emulator's capacity. Purge it or let it drain.`,
      )
      await expect(dialog).toBeVisible()
      expect(await pending()).toEqual({ count: CAPACITY, exact: true })
      await page.keyboard.press('Escape')
      await expect(dialog).toBeHidden()

      // Purge empties it.
      await page.getByTestId('queue-purge').click()
      const purge = page.getByTestId('queue-purge-confirm')
      await expect(purge).toContainText(`${figure(CAPACITY)} pending`)
      await purge.getByTestId('queue-purge-confirm-confirm').click()
      await expect(purge).toBeHidden()
      await expect(table.getByTestId('data-row')).toHaveCount(0)
      expect(await pending()).toEqual({ count: 0, exact: true })
      await expect(page.getByTestId('queue-paused')).toBeVisible()
    },
  )
})
