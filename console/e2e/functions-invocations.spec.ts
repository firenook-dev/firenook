import type { Page } from '@playwright/test'
import { type Engine, expect, test } from './fixtures'
import {
  callFunction,
  consoleJson,
  functionId,
  functionsSnapshot,
  invocationTotal,
} from './support/compute'
import { commit, statusOf } from './support/shell'

// The Invocations page's journeys (compute spec §9.3, 19–21) against the
// `compute` profile's engine: a burst of real Firestore writes, the
// engine's filter, pause and its counts, clearing the record, and the
// failures badge. Waits are on what the page or the engine ends up saying.
// No mocked API.

/** A name no other journey's documents carry. */
const unique = (stem: string) => `${stem}-${Date.now().toString(36)}`

const rows = (page: Page) => page.getByTestId('invocations-list').getByTestId('invocation-row')

/** The page's history length, to tell a replaced entry from a pushed one. */
const historyLength = (page: Page) =>
  page.evaluate(() => (globalThis as unknown as { history: { length: number } }).history.length)

/** Writes `count` order documents in one commit, as the owner. */
async function orders(engine: Engine, prefix: string, count: number) {
  await commit(
    engine,
    Array.from({ length: count }, (_, index) => ({
      path: `orders/${prefix}-${String(index).padStart(3, '0')}`,
      fields: { total: { integerValue: String(index) } },
    })),
  )
}

test('a burst stays readable: virtualized, filtered by the engine, paused and resumed', async ({
  page,
  engine,
}) => {
  const burst = unique('burst')
  const created = `function:${functionId('onOrderCreated')}`
  const before = await invocationTotal(engine, created)
  await page.goto(`${engine.origin}/console/functions/invocations`)
  await expect(page.getByTestId('invocations-toolbar')).toBeVisible()

  // 300 documents in one commit: 600 invocations, two functions each.
  await orders(engine, burst, 300)
  await expect.poll(() => invocationTotal(engine, created), { timeout: 60_000 }).toBe(before + 300)
  await expect
    .poll(() => invocationTotal(engine, `${created} outcome:running`), { timeout: 30_000 })
    .toBe(0)
  // A window over fifty rows is one marker row; Show reads the newest page.
  const marker = page.getByTestId('feed-marker').filter({ hasText: /more/ })
  if ((await marker.count()) > 0) {
    await marker.first().getByRole('button', { name: 'Show' }).click()
    await expect(page.getByTestId('feed-marker').filter({ hasText: /more/ })).toHaveCount(0)
  }
  await expect(rows(page).first().getByTestId('invocation-summary')).toContainText(burst)
  // However many there are, the page holds only what is in view.
  expect(await rows(page).count()).toBeLessThan(60)

  // The engine's filter: no failures among them, said either way.
  const filter = page.getByTestId('invocations-filter-input')
  for (const name of ['function', 'fn']) {
    await filter.fill(`${name}:${functionId('onOrderWritten')} outcome:failed`)
    await expect(page.getByText('No invocations match')).toBeVisible()
    await expect(rows(page)).toHaveCount(0)
  }

  // Pause: the list holds still, counts what arrives, and the address keeps it.
  await filter.fill(created)
  await expect(rows(page).first()).toBeVisible()
  const top = await rows(page).first().getAttribute('data-id')
  const length = await historyLength(page)
  // Out of the filter, so the keys are the page's.
  await page.getByTestId('invocations-scope').click()
  await page.keyboard.press('p')
  await expect(page).toHaveURL(/paused=true/)
  expect(new URL(page.url()).searchParams.get('q')).toBe(created)
  expect(await historyLength(page)).toBe(length)
  await page.reload()
  const pause = page.getByTestId('pause-button')
  await expect(pause).toHaveAttribute('data-paused', '')
  await expect(filter).toHaveValue(created)
  expect(await rows(page).first().getAttribute('data-id')).toBe(top)
  // The row on top stays where the eye left it while new ones arrive.
  const anchor = page.locator(`[data-testid="invocation-row"][data-id="${top}"]`)
  const at = (await anchor.boundingBox())!.y

  const late = unique('late')
  await orders(engine, late, 10)
  await expect(pause).toContainText('Paused · 10 new')
  expect((await anchor.boundingBox())!.y).toBe(at)
  // They are kept above the view, out of sight until asked for.
  await expect(page.getByTestId('invocations-list').getByText(late).first()).not.toBeInViewport()
  await page.getByTestId('jump-to-latest').click()
  await expect(rows(page).first().getByTestId('invocation-summary')).toContainText(late)
  await expect(page).not.toHaveURL(/paused=true/)

  // `e`: failed ones only, written into the filter.
  await page.getByTestId('invocations-scope').click()
  await page.keyboard.press('e')
  await expect(page).toHaveURL(/outcome%3Afailed/)
  await expect(filter).toHaveValue(`${created} outcome:failed`)
})

test('clear history empties the record and resets the figures', async ({ page, engine }) => {
  expect((await callFunction(engine, 'api', '/before-clear')).status).toBe(200)
  await page.goto(`${engine.origin}/console/functions/invocations`)
  await expect(rows(page).first()).toBeVisible()
  await page.getByTestId('invocations-clear').click()
  const confirm = page.getByTestId('invocations-clear-confirm')
  await expect(confirm).toContainText('Clear the history of')
  await expect(page.getByTestId('invocations-clear-confirm-consequences')).toContainText(
    'Function stats reset too.',
  )
  await page.getByTestId('invocations-clear-confirm-confirm').click()
  await expect(confirm).toBeHidden()
  await expect(page.getByTestId('invocations-empty')).toBeVisible()
  expect(await invocationTotal(engine)).toBe(0)
  const api = (await functionsSnapshot(engine)).functions.find(
    (summary) => summary.id === functionId('api'),
  ) as unknown as { stats: { runs: number; failures: number } }
  expect(api.stats).toMatchObject({ runs: 0, failures: 0 })
})

test('failed invocations are counted on the page that owns them', async ({ page, engine }) => {
  // Seen first, so the count starts here.
  await page.goto(`${engine.origin}/console/functions/invocations`)
  await expect(page.getByTestId('invocations-toolbar')).toBeVisible()
  const badge = page.getByTestId('nav-badge-functions-invocations')
  await page.goto(`${engine.origin}/console/firestore?path=products`)
  await expect(page.getByTestId('grid-row').first()).toBeVisible()
  await expect(badge).toHaveCount(0)
  for (let call = 0; call < 2; call++)
    expect((await callFunction(engine, 'api', '/fail')).status).toBe(500)
  await expect(badge).toHaveText('2')
  await expect(badge).toHaveAttribute('data-tone', 'danger')

  // The section's summary, as the Overview reads it.
  const functions = (await statusOf(engine)) as unknown as {
    sections: { id: string; summary: { headline: string } | null }[]
  }
  const snapshot = await functionsSnapshot(engine)
  const count = snapshot.functions.length.toLocaleString('en-US')
  expect(functions.sections.find((section) => section.id === 'functions')?.summary?.headline).toBe(
    `${count} functions · 3 codebases · 1 failing load`,
  )

  // Opening the page marks them seen.
  await page.getByTestId('nav-page-invocations').click()
  await expect(page.getByTestId('invocations-toolbar')).toBeVisible()
  await expect(badge).toHaveCount(0)
  await consoleJson(engine, '/status')
})
