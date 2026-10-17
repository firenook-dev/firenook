import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { liveRequests, setVisibility } from './support/live'
import {
  ADA,
  GRACE,
  callFunction,
  cursorOf,
  facetsOf,
  lineOf,
  logRow,
  readAs,
  tokenColour,
} from './support/observe'

// Observe's part of the shell (observe §9.3, `overview-shell.spec.ts`)
// against the worker's engine: the Logs and Rules badges as errors and
// denials happen, the suite-wide ⌘K actions, and the one live connection a
// browser keeps however many Logs pages it opens. A late tab seeing a
// snapshot job is in `overview-engines.spec.ts`, which can give the job
// enough data to still be running when that tab opens.

const TIMED_OUT = '"Your function timed out after ~1s."'

/** An error the engine logs itself: a call to `stalls` times out. */
async function anError(engine: Parameters<typeof callFunction>[0]) {
  const before = await cursorOf(engine, TIMED_OUT)
  await callFunction(engine, 'stalls')
  return lineOf(engine, TIMED_OUT, before ? { after: before } : {})
}

/** A nav badge's count, 0 when there is none. */
async function countOf(page: Page, id: string): Promise<number> {
  const badge = page.getByTestId(id)
  if ((await badge.count()) === 0) return 0
  return Number((await badge.innerText()).replaceAll(',', ''))
}

test('errors badge Logs in every tab until Logs is opened', async ({ browser, engine }) => {
  const context = await browser.newContext()
  const one = await context.newPage()
  const two = await context.newPage()
  for (const page of [one, two]) {
    await page.goto(`${engine.origin}/console/firestore?path=products`)
    await expect(page.getByTestId('grid-row').first()).toBeVisible()
  }
  const before = await countOf(one, 'nav-badge-logs')

  await anError(engine)
  for (const page of [one, two])
    await expect(page.getByTestId('nav-badge-logs')).toHaveText(String(before + 1), {
      timeout: 3_000,
    })
  // Attention, not danger: a new error is news, not a broken section.
  const badge = one.getByTestId('nav-badge-logs')
  await expect(badge).toHaveAccessibleName(
    `${before + 1} new ${before + 1 === 1 ? 'error' : 'errors'} since you last opened Logs`,
  )
  expect(
    await badge.evaluate(
      (node) => node.ownerDocument.defaultView!.getComputedStyle(node).backgroundColor,
    ),
  ).toBe(await tokenColour(one, '--color-kumo-warning-tint', 'backgroundColor'))

  // Opening Logs sees them, in every tab, and a reload remembers it.
  await one.goto(`${engine.origin}/console/logs`)
  await expect(logRow(one, 'Your function timed out after ~1s.').first()).toBeVisible()
  for (const page of [one, two])
    await expect(page.getByTestId('nav-badge-logs')).toHaveCount(0, { timeout: 3_000 })
  await two.reload()
  await expect(two.getByTestId('grid-row').first()).toBeVisible()
  await expect(two.getByTestId('nav-badge-logs')).toHaveCount(0)

  // Collapsed to icons, a new error is a dot on the Logs icon. (While Logs
  // is open in a tab, what it shows is seen: the first tab leaves it.)
  await one.goto(`${engine.origin}/console/firestore?path=products`)
  await expect(one.getByTestId('grid-row').first()).toBeVisible()
  await two.getByTestId('nav-toggle').click()
  const error = await anError(engine)
  const dot = two.getByTestId('nav-dot-logs')
  await expect(dot).toBeVisible({ timeout: 3_000 })
  await expect(dot).toHaveAttribute('data-tone', 'attention')
  await two.getByTestId('nav-toggle').click()

  // The badged item opens Logs on the errors, with what is new marked.
  await two.getByTestId('nav-logs').click()
  await expect(two).toHaveURL(/\/console\/logs\?/)
  const url = new URL(two.url())
  expect(url.searchParams.get('q')).toBe('level:error')
  expect(url.searchParams.get('since')).toMatch(/^[\w-]+\.\d+$/)
  const marker = two.getByTestId('log-marker').filter({ hasText: 'New since your last visit' })
  await expect(marker).toBeVisible()
  const newest = two.locator(`[data-testid="feed-row"]:has([data-cursor="${error.cursor}"])`)
  await expect(newest).toBeVisible()
  const above = await marker.boundingBox()
  const below = await newest.boundingBox()
  expect((above?.y ?? Infinity) < (below?.y ?? -Infinity)).toBe(true)
  await context.close()
})

test('the Rules badge counts the app’s denials, not the console’s, and a broken file outranks them', async ({
  page,
  engine,
}) => {
  await page.goto(`${engine.origin}/console/firestore?path=products`)
  await expect(page.getByTestId('grid-row').first()).toBeVisible()
  const rules = page.getByTestId('nav-badge-firestore-rules')
  // This browser has seen none of the app's earlier denials: the badge
  // counts every one the engine logged, once the shell has heard of them.
  const before = (await facetsOf(engine, { q: 'kind:rules.denied' })).matched
  await expect.poll(() => countOf(page, 'nav-badge-firestore-rules')).toBe(before)

  // The app, signed in as Ada, reads Grace's document.
  expect(await readAs(engine, ADA, `users/${GRACE.uid}`)).toBe(403)
  await expect(rules).toHaveText(String(before + 1), { timeout: 3_000 })
  await expect(rules).toHaveAccessibleName(
    `${before + 1} ${before + 1 === 1 ? 'rules denial' : 'rules denials'} since you last opened Firestore`,
  )

  // The console's own "view as" read is refused too, and counts for nothing:
  // an app denial after it lands one higher, not two.
  const viewer = await page.context().newPage()
  await viewer.goto(`${engine.origin}/console/firestore?path=users&as=${ADA.uid}`)
  await expect(viewer.getByText('Denied by security rules')).toBeVisible()
  await lineOf(engine, 'kind:rules.denied.console')
  await viewer.close()
  expect(await readAs(engine, ADA, `users/${GRACE.uid}`)).toBe(403)
  await expect(rules).toHaveText(String(before + 2), { timeout: 3_000 })

  // A rules file that stops compiling is a danger gauge: its number and tone lead.
  const file = join(engine.directory, 'firestore.rules')
  const original = readFileSync(file, 'utf8')
  try {
    writeFileSync(file, `${original}\nmatch {`)
    await expect(rules).toHaveText('1', { timeout: 3_000 })
    expect(
      await rules.evaluate(
        (node) => node.ownerDocument.defaultView!.getComputedStyle(node).backgroundColor,
      ),
    ).toBe(await tokenColour(page, '--color-kumo-danger', 'backgroundColor'))
    await rules.hover()
    const tooltip = page.locator('.kumo-tooltip-popup')
    await expect(tooltip).toContainText('1 rules file does not compile')
    await expect(tooltip).toContainText(`${before + 2} rules denials`)
  } finally {
    writeFileSync(file, original)
  }
  await expect(rules).toHaveText(String(before + 2), { timeout: 5_000 })
})

test('⌘K: the suite’s data actions, each once', async ({ page, engine }) => {
  await page.goto(`${engine.origin}/console/firestore?path=products`)
  await expect(page.getByTestId('grid-row').first()).toBeVisible()
  const palette = async (text: string) => {
    await page.keyboard.press('ControlOrMeta+k')
    const input = page.getByTestId('palette-input')
    await expect(input).toBeVisible()
    await input.fill(text)
    return page.getByRole('option')
  }

  // Download is the card's own: started at once, followed on the Data
  // cards, downloaded by this tab when it is ready.
  const downloaded = page.waitForEvent('download', { timeout: 60_000 })
  const snapshot = (await palette('Download a snapshot')).filter({
    hasText: 'Download a snapshot',
  })
  await expect(snapshot).toHaveCount(1)
  await snapshot.click()
  await expect(page).toHaveURL(/\/console\/?#data$/)
  await expect(page.getByTestId('overview-data-section')).toBeInViewport()
  expect((await downloaded).suggestedFilename()).toMatch(/\.zip$/)
  await expect(page.getByTestId('overview-snapshot-taken')).toContainText('Snapshot downloaded')

  const documents = page.getByTestId('overview-figure-firestore-documents')
  await expect(documents).toHaveText(/^[\d,]+$/)
  const count = await documents.innerText()
  const reset = (await palette('Reset data')).filter({ hasText: 'Reset data…' })
  await expect(reset).toHaveCount(1)
  await reset.click()
  await expect(page).toHaveURL(/\/console\/?\?dialog=reset$/)
  await expect(page.getByTestId('reset-dialog')).toBeVisible()
  // Nothing is deleted until its own button is pressed.
  await page.getByTestId('reset-dialog-cancel').click()
  await expect(page.getByTestId('reset-dialog')).toHaveCount(0)
  await expect(documents).toHaveText(count)

  // The environment block an app's server code reads, from anywhere.
  const env = (await palette('Environment variables')).filter({
    hasText: 'Environment variables for your app',
  })
  await expect(env).toHaveCount(1)
  await env.click()
  await expect(page).toHaveURL(/\/console\/?\?connect=env$/)
  await expect(page.getByTestId('connect-snippet')).toContainText('FIRESTORE_EMULATOR_HOST=')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('connect')).toHaveCount(0)
  // A platform's snippet copies from ⌘K; its platform is one click away in the dialog.
  const platforms = await palette('flutter')
  await expect(platforms.filter({ hasText: 'Copy the Flutter snippet' })).toHaveCount(1)
  await expect(platforms.filter({ hasText: 'Connect with' })).toHaveCount(0)
  await page.keyboard.press('Escape')

  const errors = (await palette('Open logs: errors')).filter({ hasText: 'Open logs: errors only' })
  await expect(errors).toHaveCount(1)
  await errors.click()
  await expect(page).toHaveURL(/\/console\/logs\?q=level%3Aerror$/)
  await expect(page.getByTestId('logs-filter-input')).toHaveValue('level:error')
})

test('one live connection for every tab, given up while hidden', async ({ browser, engine }) => {
  const context = await browser.newContext()
  await context.addInitScript(() =>
    localStorage.setItem('firenook.console.live-timing', JSON.stringify({ releaseMs: 500 })),
  )
  const live = liveRequests(context)
  const retired: string[] = []
  context.on('request', (request) => {
    const path = new URL(request.url()).pathname
    if (/\/(events|logs\/stream|firestore\/changes|firestore\/rules\/live)$/.test(path))
      retired.push(path)
  })
  const pages: Page[] = []
  for (let index = 0; index < 4; index += 1) {
    const page = await context.newPage()
    await page.goto(`${engine.origin}/console/logs`)
    await expect(page.getByTestId('log-row').first()).toBeVisible()
    pages.push(page)
  }
  const overview = await context.newPage()
  await overview.goto(`${engine.origin}/console`)
  await expect(overview.getByTestId('overview-problems')).toBeVisible()
  pages.push(overview)
  // Lines arrive in every tab over the one connection.
  const uid = `shared_${Date.now()}`
  await callFunction(engine, 'hello', { uid })
  for (const page of pages.slice(0, 4))
    await expect(logRow(page, `loading cart for ${uid}`)).toBeVisible()
  expect(live.most()).toBeLessThanOrEqual(1)

  // Every tab hidden: the connection is given back.
  for (const page of pages) await setVisibility(page, 'hidden')
  await expect.poll(() => live.open(), { timeout: 2_000 }).toBe(0)

  // A line logged while nobody looks.
  const missed = `hidden_${Date.now()}`
  await callFunction(engine, 'hello', { uid: missed })
  await lineOf(engine, `"loading cart for ${missed}"`)

  // One shown: exactly one connection opens, and what it missed arrives at once.
  const opened = live.opened()
  const shown = pages[0] as Page
  await setVisibility(shown, 'visible')
  await expect.poll(() => live.opened(), { timeout: 2_000 }).toBe(opened + 1)
  await expect(logRow(shown, `loading cart for ${missed}`)).toBeVisible({ timeout: 1_000 })
  expect(live.most()).toBeLessThanOrEqual(1)
  expect(retired).toEqual([])
  live.dispose()
  await context.close()
})
