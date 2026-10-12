// J-PS-18 (messaging spec §9.3, @perf): the Topics page at the scale it is
// built for — 2,000 topics, and `bulk` holding 50,000 messages in its hour
// of retention. Opt-in:
//
//   FIRENOOK_PERF=1 npx playwright test e2e/pubsub-scale.spec.ts
//
// The journey starts an engine of its own and seeds the large dataset into
// it (`scripts/seed/pubsub.mjs` with `large`), so the messaging project's
// worker engine never carries the load; the file holds no worker engine.

import { dedicated, expect } from './fixtures'
import { seed as seedPubsub } from '../scripts/seed/pubsub.mjs'
import {
  type PageView,
  type TopicIndexView,
  consoleCall,
  scrollToEnd,
  topicName,
} from './support/messaging'

dedicated.use({ workerEngine: false })

const PERF = process.env.FIRENOOK_PERF === '1'
const enc = encodeURIComponent
const figure = (n: number) => n.toLocaleString('en-US')

/** Cards the landing shows before it says how many more there are. */
const LANDING_CARDS = 24
/** What a virtualized list may hold in the DOM at once: a screen and its overscan, never the list. */
const DOM_ROWS = 120

interface TopicDetail {
  history: { messages: number; oldestId: string | null }
}

dedicated.describe('@perf', () => {
  dedicated.skip(!PERF, 'opt-in: FIRENOOK_PERF=1')

  dedicated(
    '@perf J-PS-18 2,000 topics and 50,000 messages: a screen of rows in the DOM, the counts exact',
    async ({ page, dedicatedEngine }) => {
      dedicated.setTimeout(600_000)
      const engine = await dedicatedEngine('messaging', { seed: false })
      await seedPubsub(engine, { large: true })

      const index = await consoleCall<TopicIndexView>(engine, 'GET', '/pubsub/topics')
      const userTopics = index.items.filter((topic) => topic.kind === 'user').length
      expect(userTopics).toBeGreaterThan(2_000)
      const bulk = topicName(engine, 'bulk')
      const detail = await consoleCall<TopicDetail>(
        engine,
        'GET',
        `/pubsub/topic?name=${enc(bulk)}`,
      )
      expect(detail.history.messages).toBe(50_000)
      const oldest = detail.history.oldestId
      expect(oldest).not.toBeNull()
      const first = await consoleCall<PageView<{ id: string }>>(
        engine,
        'GET',
        `/pubsub/messages?topic=${enc(bulk)}&limit=1`,
      )
      expect(first.total).toEqual({ count: 50_000, exact: true })

      await page.setViewportSize({ width: 1440, height: 900 })
      await page.goto(`${engine.origin}/console/pubsub`)
      await expect(page.getByTestId('pubsub-page')).toBeVisible()

      // The landing: the 24 most recently active topics, then how many more.
      await expect(page.getByTestId('pubsub-topic-card')).toHaveCount(LANDING_CARDS)
      await expect(page.getByTestId('pubsub-landing-more')).toHaveText(
        `${figure(userTopics - LANDING_CARDS)} more topics — filter them in the panel`,
      )

      // The panel scrolled through every topic holds a screen of rows at a time.
      const tree = page.getByTestId('pubsub-tree')
      await expect(tree.getByRole('treeitem', { name: 'audit-log', exact: true })).toBeVisible()
      const panel = await scrollToEnd(tree, {
        rows: '[data-testid="panel-tree-node"]',
        want: '[role="treeitem"][aria-label="load-1999"]',
      })
      dedicated.info().annotations.push({ type: 'panel rows', description: String(panel.most) })
      expect(panel.most).toBeGreaterThan(0)
      expect(panel.most).toBeLessThan(DOM_ROWS)

      // `bulk`'s messages, newest first, to the end: the last row is the
      // oldest message kept, numbered as the 50,000th of exactly 50,000.
      await page.goto(`${engine.origin}/console/pubsub?topic=bulk`)
      const table = page.getByTestId('pubsub-message-table')
      await expect(table.getByTestId('data-row').first()).toBeVisible()
      await expect(page.getByTestId('pubsub-message-count')).toHaveText(
        `${figure(50_000)} messages`,
      )
      const list = await scrollToEnd(page.getByTestId('pubsub-message-table-scroll'), {
        rows: '[data-testid="data-row"]',
        want: `tr[data-key="${oldest}"]`,
      })
      dedicated.info().annotations.push({ type: 'message rows', description: String(list.most) })
      expect(list.most).toBeLessThan(DOM_ROWS)
      const last = await table.getByTestId('data-row').evaluateAll((rows) =>
        rows
          .map((row) => ({
            key: row.getAttribute('data-key'),
            index: Number(row.getAttribute('aria-rowindex')),
          }))
          .reduce((a, b) => (b.index > a.index ? b : a)),
      )
      // The header is row 1 of the table, so the 50,000th message is row 50,001.
      expect(last).toEqual({ key: oldest, index: 50_001 })
      await expect(page.getByTestId('pubsub-message-count')).toHaveText(
        `${figure(50_000)} messages`,
      )
    },
  )
})
