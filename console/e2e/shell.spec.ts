import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { type Engine, expect, test } from './fixtures'
import { ownerFetch } from './support/api'
import { type KitBuild, type KitHarness, buildKitHarness, openKitHarness } from './support/kit'
import { dropLive, liveRequests, loadHidden, restoreLive, setVisibility } from './support/live'
import {
  badgeOf,
  commit,
  documentsOf,
  firestoreReads,
  statusOf,
  subscriptionLog,
  text,
} from './support/shell'

// The shell's journeys (foundation §9.3, project `shell`, profile `all`)
// that share the worker's engine: the one live connection, a dropped
// connection, the rules badge, shortcuts, background tabs, error codes, the
// decisions socket, paused triggers, the kit's pages and a foreign project.
// Journeys that stop, restart or slow an engine, or need one nobody has
// touched (3, 5, 7, 11, 15, 17, 18), start their own in
// `shell-engines.spec.ts`; journey 4 needs an engine without Storage and
// lives with the `data` project in `console-gate.spec.ts`. Never a mocked
// API. The opt-in perf journeys (§8.4) are tagged @perf, at the end:
//
//   FIRENOOK_PERF=1 FIRENOOK_SEED_SCALE=large npx playwright test --project=shell --grep @perf

test('one live connection serves every page and every tab of a browser', async ({
  context,
  engine,
}) => {
  const live = liveRequests(context)
  const subscriptions = subscriptionLog(context)
  const legacy: string[] = []
  context.on('request', (request) => {
    if (/\/firestore\/changes|\/rules\/live/.test(request.url())) legacy.push(request.url())
  })

  const page = await context.newPage()
  await page.goto(`${engine.origin}/console/firestore?path=products`)
  await expect(page.getByTestId('grid-row').first()).toBeVisible()
  await expect.poll(() => subscriptions.added.includes('firestore.changes')).toBe(true)

  // Each page takes its topics and gives them back as it is left.
  // (Storage has a Rules page too: this is Firestore's.)
  await page.locator('[data-testid="nav-page-rules"][href="/console/firestore/rules"]').click()
  await expect(page.getByTestId('rules-source')).toBeVisible()
  await expect.poll(() => subscriptions.added.includes('firestore.rules')).toBe(true)
  await expect.poll(() => subscriptions.removed.includes('firestore.changes')).toBe(true)
  // Authentication's first page: its Users page once built, its entry before.
  await page.getByTestId('nav-page-users').or(page.locator('a[data-testid="nav-auth"]')).click()
  await expect(page).toHaveURL(/\/console\/auth$/)
  await expect.poll(() => subscriptions.removed.includes('firestore.rules')).toBe(true)
  // Functions has pages of its own: its heading folds them, the page leads there.
  await page.getByTestId('nav-page-all-functions').click()
  await expect(page).toHaveURL(/\/console\/functions$/)
  await page.goBack()
  await expect(page).toHaveURL(/\/console\/auth$/)

  // Two more tabs ride the same connection, and a write reaches them through it.
  const second = await context.newPage()
  await second.goto(`${engine.origin}/console/firestore?path=teams`)
  await expect(second.getByTestId('grid-row').first()).toBeVisible()
  const third = await context.newPage()
  await third.goto(`${engine.origin}/console/firestore/rules`)
  await expect(third.getByTestId('rules-source')).toBeVisible()
  await commit(engine, [{ path: 'teams/t_one_channel', fields: { name: text('One channel') } }])
  await expect(second.locator('tr[data-path="teams/t_one_channel"]')).toBeVisible()

  expect(live.open()).toBe(1)
  expect(live.most()).toBe(1)
  expect(live.opened()).toBe(1)
  expect(legacy).toEqual([])
  await commit(engine, [{ path: 'teams/t_one_channel' }])
})

test('a dropped connection catches up on what it missed, and refetches only that', async ({
  page,
  engine,
}) => {
  let loads = 0
  page.on('load', () => {
    loads += 1
  })
  await page.goto(`${engine.origin}/console/firestore?path=products`)
  await expect(page.getByTestId('grid-row').first()).toBeVisible()
  const badge = badgeOf(page)
  await expect(badge).toHaveText(/^engine /)

  await dropLive(page)
  await expect(badge).toHaveText('reconnecting', { timeout: 3_000 })
  // Sorted first, so the row is in the rows the grid draws.
  const missed = `0_missed_${Date.now()}`
  const teams = Array.from({ length: 20 }, (_, index) => `teams/t_missed_${index}`)
  try {
    await commit(engine, [{ path: `products/${missed}`, fields: { name: text('Missed') } }])
    await commit(
      engine,
      teams.map((path) => ({ path, fields: { name: text('Elsewhere') } })),
    )
    const watch = firestoreReads(page)
    await restoreLive(page)
    await expect(badge).toHaveText(/^engine /, { timeout: 15_000 })
    // The gap fix: the commit made while away is replayed, so the row is
    // there without a reload.
    await expect(page.locator(`tr[data-path="products/${missed}"]`)).toBeVisible()
    await page.waitForTimeout(500)
    watch.stop()
    expect(loads).toBe(1)
    // Twenty writes to another collection refetched nothing of it.
    expect(watch.reads.filter((read) => read.includes('teams'))).toEqual([])
    expect(watch.reads.some((read) => read.includes('products'))).toBe(true)
  } finally {
    await commit(engine, [{ path: `products/${missed}` }, ...teams.map((path) => ({ path }))])
  }
})

test('a rules file that stops compiling badges Rules at once, and the badge goes when it is fixed', async ({
  page,
  engine,
}) => {
  const file = join(engine.directory, 'firestore.rules')
  const original = readFileSync(file, 'utf8')
  await page.goto(`${engine.origin}/console/firestore?path=products`)
  await expect(page.getByTestId('grid-row').first()).toBeVisible()
  try {
    writeFileSync(file, `${original}\nmatch {`)
    const badge = page.getByTestId('nav-badge-firestore-rules')
    await expect(badge).toBeVisible({ timeout: 3_000 })
    await expect(badge).toHaveText('1')
    await expect(badge).toHaveAccessibleName('1 rules file does not compile')
    await badge.hover()
    await expect(page.locator('.kumo-tooltip-popup')).toHaveText('1 rules file does not compile')
    // Collapsed to icons, the counts are out of sight: Firestore's icon
    // carries the badge's tone as a dot instead.
    await page.mouse.move(800, 400)
    await page.getByTestId('nav-toggle').click()
    const dot = page.getByTestId('nav-dot-firestore')
    await expect(dot).toBeVisible()
    await expect(dot).toHaveAttribute('data-tone', 'danger')
    await page.getByTestId('nav-toggle').click()
  } finally {
    writeFileSync(file, original)
  }
  await expect(page.getByTestId('nav-badge-firestore-rules')).toHaveCount(0, { timeout: 5_000 })
})

test('? lists the keys of the page, Escape closes it, and / edits the path', async ({
  page,
  engine,
}) => {
  await page.goto(`${engine.origin}/console/firestore?path=products`)
  await expect(page.getByTestId('grid-row').first()).toBeVisible()
  await page.keyboard.press('?')
  const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('region', { name: 'Everywhere' })).toContainText(
    'Search the console',
  )
  const firestore = dialog.getByRole('region', { name: 'This page · Firestore' })
  const row = (label: string) => firestore.getByRole('listitem').filter({ hasText: label })
  await expect(row('New document').locator('kbd')).toHaveText('n')
  await expect(row('Filter the documents').locator('kbd')).toHaveText('f')
  await expect(row('Explain the query').locator('kbd')).toHaveText('e')
  await expect(row('Switch between this collection and its group').locator('kbd')).toHaveText('g')
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  // Firestore keeps `/` for its path, the line the page reads from.
  await page.keyboard.press('/')
  await expect(page.getByTestId('path-input')).toBeFocused()
})

test('tabs opened in the background take no connection, and catch up when shown', async ({
  context,
  engine,
}) => {
  await context.addInitScript(() =>
    localStorage.setItem('firenook.console.live-timing', JSON.stringify({ releaseMs: 500 })),
  )
  const live = liveRequests(context)
  const visible = await context.newPage()
  await visible.goto(`${engine.origin}/console/firestore?path=products`)
  await expect(visible.getByTestId('grid-row').first()).toBeVisible()

  const paths = [
    'firestore?path=teams',
    'firestore/rules',
    'auth',
    'functions',
    'firestore?path=users',
    '',
  ]
  const background: Page[] = []
  for (const path of paths) {
    const tab = await context.newPage()
    await loadHidden(tab)
    await tab.goto(`${engine.origin}/console/${path}`)
    background.push(tab)
  }
  await visible.waitForTimeout(1_000)
  expect(live.open()).toBeLessThanOrEqual(1)
  expect(live.opened()).toBe(1)

  // The visible page is not queued behind anything: a collection loads at once.
  const started = Date.now()
  await visible.keyboard.press('/')
  await visible.getByTestId('path-input').fill('users')
  await visible.getByTestId('path-input').press('Enter')
  await expect(visible.getByTestId('grid-row').first()).toBeVisible()
  await expect(visible.locator('tr[data-path^="users/"]').first()).toBeVisible()
  expect(Date.now() - started).toBeLessThan(2_000)

  // A write while a tab slept is on it once it is shown, through the same connection.
  const sleeper = background[0]!
  await expect(sleeper.getByTestId('grid-row').first()).toBeAttached()
  try {
    await commit(engine, [
      { path: 'teams/t_slept', fields: { name: text('Written while asleep') } },
    ])
    await setVisibility(sleeper, 'visible')
    await expect(sleeper.locator('tr[data-path="teams/t_slept"]')).toBeVisible({ timeout: 5_000 })
    expect(live.opened()).toBe(1)
  } finally {
    await commit(engine, [{ path: 'teams/t_slept' }])
  }
})

test('every error the console API sends has a code', async ({ engine }) => {
  const missing = await fetch(`${engine.origin}/console/api/v1/nothing`)
  expect(missing.status).toBe(404)
  expect(((await missing.json()) as { error: { code: string } }).error.code).toBe('not-found')

  const empty = await fetch(`${engine.origin}/console/api/v1/search?q=`)
  expect(empty.status).toBe(400)
  expect(((await empty.json()) as { error: { code: string } }).error.code).toBe('invalid-argument')

  // A change that is not JSON is refused before it reaches any route: a
  // plain-text POST is a simple request any page on the web can send.
  const plain = await fetch(`${engine.origin}/console/api/v1/suite/background`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: 'enabled=false',
  })
  expect(plain.status).toBe(415)
  expect(((await plain.json()) as { error: { code: string } }).error.code).toBe(
    'unsupported-media-type',
  )
})

test('the decisions feed reconnects by itself and lists nothing twice', async ({
  page,
  engine,
}) => {
  let sockets = 0
  let first: { close: (options?: { code?: number; reason?: string }) => Promise<void> } | undefined
  await page.routeWebSocket('**/console/api/v1/firestore/requests', (socket) => {
    sockets += 1
    if (sockets === 1) first = socket
    socket.connectToServer()
  })
  await page.goto(`${engine.origin}/console/firestore/rules`)
  await expect(page.getByTestId('decisions-count')).toBeVisible()
  // An anonymous read the rules deny is a decision.
  const read = () =>
    fetch(`${engine.origin}/console/api/v1${documentsOf(engine)}/users/u_nobody_${Date.now()}`)
  await read()
  const rows = page.getByTestId('decision-row')
  await expect(rows.first()).toBeVisible()
  const before = await rows.count()

  await first!.close({ code: 4000, reason: 'closed by the test' })
  await expect(page.getByTestId('decisions-reconnecting')).toBeVisible({ timeout: 3_000 })
  await expect(page.getByTestId('decisions-reconnecting')).toHaveCount(0, { timeout: 8_000 })
  expect(sockets).toBe(2)
  // The new socket's replayed history is deduplicated by request id.
  await page.waitForTimeout(500)
  await expect(rows).toHaveCount(before)
  await read()
  await expect(rows).toHaveCount(before + 1)
})

test('paused background triggers are said on every page, with what was dropped and Resume', async ({
  page,
  engine,
}) => {
  const hub = `http://127.0.0.1:${engine.ports.hub}`
  await page.goto(`${engine.origin}/console/firestore?path=products`)
  await expect(page.getByTestId('grid-row').first()).toBeVisible()
  const banner = page.getByTestId('banner-triggers-paused')
  try {
    // As a test harness does it: straight to the hub.
    expect((await fetch(`${hub}/functions/disableBackgroundTriggers`, { method: 'PUT' })).ok).toBe(
      true,
    )
    await expect(banner).toBeVisible({ timeout: 1_000 })
    await expect(banner).toContainText(
      /Background triggers are paused, so events are dropped, not queued — since \d\d:\d\d:\d\d\./,
    )
    for (const path of [
      '',
      'firestore/rules',
      'auth',
      'storage',
      'functions',
      'extensions',
      'pubsub',
      'eventarc',
      'tasks',
      'logs',
    ]) {
      await page.goto(`${engine.origin}/console/${path}`)
      await expect(banner, `the banner on /console/${path}`).toBeVisible({ timeout: 1_000 })
    }

    // A write a function listens to (`shellWatched`, the fixture's): it is
    // dropped, not queued, and the banner counts it.
    await page.goto(`${engine.origin}/console/firestore?path=products`)
    await commit(engine, [{ path: 'shellWatched/w1', fields: { name: text('No function ran') } }])
    await expect(banner).toContainText('1 Firestore change reached no function.')

    await page.getByTestId('resume-triggers').click()
    await expect(banner).toHaveCount(0, { timeout: 5_000 })
    expect((await statusOf(engine)).backgroundTriggers).toMatchObject({
      enabled: true,
      since: null,
      dropped: [],
    })
  } finally {
    await fetch(`${hub}/functions/enableBackgroundTriggers`, { method: 'PUT' })
    await commit(engine, [{ path: 'shellWatched/w1' }])
  }
})

/** Whether the section page on screen is its real screen, not the placeholder. */
test.describe('kit pages', () => {
  // The first section pages built on the kit's DataTable and FeedList.
  test('a table page reads as a grid, row by row, with its inspector’s steps', async ({
    page,
    engine,
  }) => {
    await page.goto(`${engine.origin}/console/auth`)
    await expect(page.getByRole('heading', { name: 'Authentication' }).first()).toBeVisible()
    const grid = page.getByRole('grid').first()
    await expect(grid).toBeVisible()
    await expect(grid).toMatchAriaSnapshot(`
      - grid:
        - rowgroup:
          - row
        - rowgroup:
          - row
    `)
    const total = Number(await grid.getAttribute('aria-rowcount'))
    expect(total === -1 || total > 1).toBe(true)
    const rows = grid.locator('tbody tr[aria-rowindex]')
    await expect(rows.first()).toHaveAttribute('aria-rowindex', '2')
    await grid.focus()
    await page.keyboard.press('Enter')
    const previous = page.getByRole('button', { name: /^Previous / })
    const next = page.getByRole('button', { name: /^Next / })
    await expect(previous).toBeVisible()
    await expect(next).toBeVisible()
  })

  test('a feed page is a log that does not speak every line', async ({ page, engine }) => {
    await page.goto(`${engine.origin}/console/logs`)
    await expect(page.getByRole('heading', { name: 'Logs' }).first()).toBeVisible()
    const log = page.getByRole('log').first()
    await expect(log).toBeVisible()
    await expect(log).toHaveAttribute('aria-live', 'off')
    await expect(page.getByRole('main')).toMatchAriaSnapshot(`
      - log
    `)
  })
})

// Last of the worker engine's journeys: once an app has written to another
// project id, the engine keeps saying so, on every page.
test('an app that writes to another project is named, shown and taught the fix', async ({
  page,
  engine,
}) => {
  const response = await fetch(
    `http://127.0.0.1:${engine.ports.firestore}/v1/projects/my-prod/databases/(default)/documents:commit`,
    {
      method: 'POST',
      headers: { authorization: 'Bearer owner', 'content-type': 'application/json' },
      body: JSON.stringify({
        writes: [
          {
            update: {
              name: 'projects/my-prod/databases/(default)/documents/orders/o1',
              fields: { total: { integerValue: '42' } },
            },
          },
        ],
      }),
    },
  )
  expect(response.ok).toBe(true)

  await page.goto(`${engine.origin}/console/firestore?path=products`)
  const banner = page.getByTestId('banner-foreign-project')
  await expect(banner).toBeVisible({ timeout: 5_000 })
  await expect(banner).toContainText('my-prod')
  await expect(page.getByTestId('engine-badge-foreign')).toBeVisible()

  await page.getByTestId('foreign-show').click()
  await expect(page).toHaveURL(/project=my-prod/)
  await expect(page.getByTestId('banner-foreign-view')).toContainText('my-prod')
  await page.goto(`${engine.origin}/console/firestore?project=my-prod&path=orders`)
  await expect(page.locator('tr[data-path="orders/o1"]')).toBeVisible()

  // An empty collection says how an app connects to this emulator instead.
  await page.goto(`${engine.origin}/console/firestore?project=my-prod&path=invoices`)
  const snippet = page.getByTestId('empty-collection-connect')
  const firestore = (await statusOf(engine)).services.find(
    (service) => service.name === 'firestore',
  )!
  await expect(snippet).toContainText(
    `connectFirestoreEmulator(getFirestore(app), '${firestore.host}', ${firestore.port})`,
  )
  await expect(snippet).toContainText(engine.project)
})

// ---------------------------------------------------------------------------
// Perf (§8.4): opt-in, measured on the worker engine seeded at the large
// scale. Design targets the primitives are built against, not claims.

const PERF = process.env.FIRENOOK_PERF === '1'

/** What `framesDuring` keeps on the page; this file is typed for Node, not the DOM. */
interface FrameRecorder {
  __frames: number[]
  __framing: boolean
  requestAnimationFrame(callback: (now: number) => void): number
  performance: { now(): number }
}

/** Frame intervals the page paints while `work` runs, ms. */
async function framesDuring(page: Page, work: () => Promise<void>): Promise<number[]> {
  await page.evaluate(() => {
    const record = globalThis as unknown as FrameRecorder
    record.__frames = []
    record.__framing = true
    let last = record.performance.now()
    const tick = (now: number) => {
      record.__frames.push(now - last)
      last = now
      if (record.__framing) record.requestAnimationFrame(tick)
    }
    record.requestAnimationFrame(tick)
  })
  await work()
  return page.evaluate(() => {
    const record = globalThis as unknown as FrameRecorder
    record.__framing = false
    return record.__frames.slice(1)
  })
}

function p95(values: number[]): number {
  const sorted = values.toSorted((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0
}

/** Marks the grid's scroller so a journey can drive it. */
async function gridScroller(page: Page) {
  await page
    .locator('table')
    .first()
    .evaluate((table) => {
      let node = table.parentElement
      while (node && node.scrollHeight <= node.clientHeight + 1) node = node.parentElement
      node?.setAttribute('data-perf-scroller', '')
    })
  return page.locator('[data-perf-scroller]')
}

/**
 * Scrolls a grid ten rows a frame, in the page, until the row of `path` is
 * drawn: the window slides under the scroll, so the row says how far it got.
 */
function scrollerTo(scroller: Locator, path: string) {
  return scroller.evaluate(
    (node, target) =>
      new Promise<void>((resolve, reject) => {
        const view = node.ownerDocument.defaultView!
        const started = view.performance.now()
        const step = () => {
          if (node.querySelector(`tr[data-path="${target}"]`)) return resolve()
          if (view.performance.now() - started > 90_000)
            return reject(new Error(`${target} was not reached in 90 s`))
          node.scrollTop += 320
          view.requestAnimationFrame(step)
        }
        view.requestAnimationFrame(step)
      }),
    path,
  )
}

const bulkIds = (from: number, count: number) =>
  Array.from({ length: count }, (_, index) => `bulk/b${String(from + index).padStart(6, '0')}`)

/** 1,000 keys a second for `seconds`: a commit of 100 every 100 ms. */
async function burst(engine: Engine, paths: string[], seconds: number) {
  const end = Date.now() + seconds * 1_000
  let round = 0
  while (Date.now() < end) {
    const tick = Date.now()
    await commit(
      engine,
      paths.map((path) => ({ path, fields: { n: { integerValue: String(round) } } })),
    )
    round += 1
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, 100 - (Date.now() - tick))))
  }
}

test.describe('@perf', () => {
  test.skip(!PERF, 'opt-in: FIRENOOK_PERF=1 FIRENOOK_SEED_SCALE=large')

  test.beforeEach(async ({ engine }) => {
    const bulk = await ownerFetch(engine, `${documentsOf(engine)}/bulk?pageSize=1`)
    const listed = (await bulk.json()) as { documents?: unknown[] }
    expect(
      listed.documents?.length,
      'the perf journeys read `bulk`: run them with FIRENOOK_SEED_SCALE=large',
    ).toBe(1)
  })

  test('@perf a table scrolled through 10,000 rows paints at frame p95 ≤ 20 ms', async ({
    page,
    engine,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`${engine.origin}/console/firestore?path=bulk`)
    await expect(page.getByTestId('grid-row').first()).toBeVisible()
    // Measured once the engine's first look at the collections is over:
    // the schema panel counts `bulk` when it is.
    await expect(page.getByTestId('section-panel')).toContainText('20,000', { timeout: 30_000 })
    await page.waitForTimeout(1_000)
    const scroller = await gridScroller(page)
    // A fast flick, held: ten rows a frame, from the top to row 10,000 (the
    // window slides under it, so the row itself says how far it got).
    const frames = await framesDuring(page, () => scrollerTo(scroller, 'bulk/b009999'))
    const at = p95(frames)
    test.info().annotations.push({ type: 'frame p95', description: `${at.toFixed(1)} ms` })
    expect(at).toBeLessThanOrEqual(20)
  })

  test('@perf 1,000 changed keys a second for 10 s take at most 100 patch passes', async ({
    page,
    engine,
  }) => {
    await page.goto(`${engine.origin}/console/firestore?path=bulk`)
    // The first page (a hundred rows) holds every document the burst writes.
    await expect(page.locator('tr[data-path="bulk/b000000"]')).toBeVisible()
    await page.waitForTimeout(500)
    const watch = firestoreReads(page)
    await burst(engine, bulkIds(0, 100), 10)
    await page.waitForTimeout(500)
    watch.stop()
    const passes = watch.reads.filter((read) => /:batchGet|:runQuery/.test(read)).length
    test.info().annotations.push({ type: 'patch passes', description: String(passes) })
    expect(passes).toBeLessThanOrEqual(100)
  })

  test('@perf a list 50 pages deep patches a write burst without refetching its window', async ({
    page,
    engine,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`${engine.origin}/console/firestore?path=bulk`)
    await expect(page.getByTestId('grid-row').first()).toBeVisible()
    const scroller = await gridScroller(page)
    // Fifty pages of a hundred: down to row 5,000, the way the first perf
    // journey scrolls, and stop there.
    await scrollerTo(scroller, 'bulk/b005000')
    await page.waitForTimeout(500)
    const watch = firestoreReads(page)
    const frames = await framesDuring(page, () => burst(engine, bulkIds(4_950, 100), 10))
    await page.waitForTimeout(500)
    watch.stop()
    const requests = watch.reads.length
    const refetches = watch.reads.filter((read) => read.includes(':runQuery')).length
    test
      .info()
      .annotations.push(
        { type: 'requests', description: String(requests) },
        { type: 'frame p95', description: `${p95(frames).toFixed(1)} ms` },
      )
    expect(requests).toBeLessThanOrEqual(100)
    expect(refetches).toBe(0)
    expect(p95(frames)).toBeLessThanOrEqual(20)
  })

  test('@perf writes elsewhere, and a tab hidden and shown, read nothing of the grid', async ({
    page,
    engine,
  }) => {
    await page.goto(`${engine.origin}/console/firestore?path=products`)
    await expect(page.getByTestId('grid-row').first()).toBeVisible()
    await page.waitForTimeout(500)
    const watch = firestoreReads(page)
    const writes = (async () => {
      const end = Date.now() + 10_000
      let round = 0
      while (Date.now() < end) {
        const tick = Date.now()
        await commit(
          engine,
          Array.from({ length: 10 }, (_, index) => ({
            path: `teams/t_perf_${index}`,
            fields: { n: { integerValue: String(round) } },
          })),
        )
        round += 1
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, 100 - (Date.now() - tick))))
      }
    })()
    for (let turn = 0; turn < 2; turn += 1) {
      await page.waitForTimeout(2_000)
      await setVisibility(page, 'hidden')
      await page.waitForTimeout(1_000)
      await setVisibility(page, 'visible')
    }
    await writes
    await page.waitForTimeout(500)
    watch.stop()
    await commit(
      engine,
      Array.from({ length: 10 }, (_, index) => ({ path: `teams/t_perf_${index}` })),
    )
    expect(watch.reads.filter((read) => read.includes('products'))).toEqual([])
  })

  test('@perf six background tabs leave a visible page its connection and its speed', async ({
    context,
    engine,
  }) => {
    const live = liveRequests(context)
    for (let index = 0; index < 6; index += 1) {
      const tab = await context.newPage()
      await loadHidden(tab)
      await tab.goto(`${engine.origin}/console/firestore?path=users`)
    }
    const page = await context.newPage()
    let asked = 0
    page.on('request', (request) => {
      if (request.url().includes(':runQuery') && asked === 0) asked = Date.now()
    })
    await page.goto(`${engine.origin}/console/firestore?path=products`)
    await expect(page.getByTestId('grid-row').first()).toBeVisible()
    const firstPage = Date.now() - asked
    test.info().annotations.push({ type: 'first page', description: `${firstPage} ms` })
    expect(live.open()).toBeLessThanOrEqual(1)
    expect(firstPage).toBeLessThanOrEqual(500)
  })
})

// The kit's own primitives at the load §8.1 sizes them for, on the kit
// harness (`e2e/kit-harness`): FeedList as Logs draws it, fed 10,000 lines a
// second the way the live channel hands them over, and JsonView as an
// inspector draws it, handed a 5 MB value. A primitive's budget is its own,
// whichever page draws it; the harness's files are the only thing served
// beside the engine, and no console API is involved.
test.describe('@perf kit', () => {
  test.skip(!PERF, 'opt-in: FIRENOOK_PERF=1')

  let kit: KitBuild | undefined
  test.beforeAll(async () => {
    test.setTimeout(180_000)
    kit = await buildKitHarness()
  })
  test.afterAll(() => kit?.remove())

  test('@perf a feed fed 10,000 lines a second for 10 s paints at frame p95 ≤ 25 ms in bounded memory', async ({
    page,
    engine,
  }) => {
    if (!kit) throw new Error('the kit harness did not build')
    await page.setViewportSize({ width: 1440, height: 900 })
    await openKitHarness(page, engine.origin, kit, 'feed')
    const cdp = await page.context().newCDPSession(page)
    const heap = async () => {
      await cdp.send('HeapProfiler.collectGarbage')
      return (await cdp.send('Runtime.getHeapUsage')).usedSize
    }
    const before = await heap()
    let run: Awaited<ReturnType<KitHarness['feed']>> | undefined
    const frames = await framesDuring(page, async () => {
      run = await page.evaluate(() =>
        (globalThis as unknown as { __kit: KitHarness }).__kit.feed(10_000, 10),
      )
    })
    const grown = (await heap()) - before
    test
      .info()
      .annotations.push(
        { type: 'frame p95', description: `${p95(frames).toFixed(1)} ms` },
        { type: 'heap growth', description: `${(grown / 1024 / 1024).toFixed(1)} MB` },
        { type: 'late windows', description: String(run?.late) },
      )
    // Every line reached the ring, which kept the newest 10,000 and drew a
    // screenful of them, following the newest.
    expect(run).toMatchObject({ pushed: 100_000, size: 10_000, dropped: 90_000, newestShown: true })
    expect(run?.drawn).toBeLessThan(100)
    expect(p95(frames)).toBeLessThanOrEqual(25)
    expect(grown).toBeLessThanOrEqual(50 * 1024 * 1024)
  })

  test('@perf a 5 MB JSON paints its tree within 100 ms of arriving', async ({ page, engine }) => {
    if (!kit) throw new Error('the kit harness did not build')
    await page.setViewportSize({ width: 1440, height: 900 })
    await openKitHarness(page, engine.origin, kit, 'json')
    const run = await page.evaluate(() =>
      (globalThis as unknown as { __kit: KitHarness }).__kit.json(5),
    )
    test
      .info()
      .annotations.push(
        { type: 'first paint', description: `${run.paintMs.toFixed(1)} ms` },
        { type: 'parse', description: `${run.parseMs.toFixed(1)} ms` },
        { type: 'values', description: String(run.nodes) },
      )
    expect(run.bytes).toBeGreaterThanOrEqual(5 * 1024 * 1024)
    expect(run.drawn).toBeGreaterThan(0)
    expect(run.paintMs).toBeLessThanOrEqual(100)
  })
})
