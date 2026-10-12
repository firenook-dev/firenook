import type { Page, Request } from '@playwright/test'
import { expect, test } from './fixtures'
import { readClipboard } from './support/clipboard'
import { readDownload } from './support/downloads'
import { setVisibility } from './support/live'
import {
  ADA,
  GRACE,
  NEEDS_ATTRIBUTION,
  attributesInvocations,
  callFunction,
  cursorOf,
  facetsOf,
  histogramOf,
  histogramTotal,
  lineOf,
  listAs,
  logPage,
  logRow,
  logRows,
  matchCount,
  openLogs,
  part,
  queryOf,
  readAs,
  tokenColour,
  unique,
} from './support/observe'

// The Logs page against a real engine (project `observe`: every service,
// every stream's functions, `scripts/seed/observe.mjs`). Lines come from
// what an app does — a function called over HTTP, a read the rules refuse,
// a codebase edited on disk — and every count the page shows is compared
// with the engine's own answer. Journeys share the worker's engine and
// mark their own lines (a uid, a burst's size), so none reads another's.
//
// Functions output on this engine is plain until compute's monitor says
// which invocation printed each line: the journeys about invocations
// (attribution, a structured logger payload, a handler's error) run once
// it does, and skip with that reason before.

/** Errors the engine logs itself: a call to `stalls` times out after its one second. */
const TIMED_OUT = 'Your function timed out after ~1s.'

/** Calls `stalls` and waits for the engine's error line about it. */
async function timeOut(engine: Parameters<typeof callFunction>[0]) {
  const before = await cursorOf(engine, `"${TIMED_OUT}"`)
  const call = await callFunction(engine, 'stalls')
  expect(call.status).toBe(500)
  return lineOf(engine, `"${TIMED_OUT}"`, before ? { after: before } : {})
}

test('history arrives first, then each new line as it is logged', async ({ page, engine }) => {
  await openLogs(page, engine)
  // History: the engine's own start, kept since it started.
  await expect(logRow(page, 'All emulators ready').first()).toBeVisible()
  await expect(page.getByTestId('log-edge')).toContainText("The engine's log begins here")

  const uid = unique('u')
  await callFunction(engine, 'hello', { uid })
  // Without a reload, in the order they were printed.
  const begin = logRow(page, 'Beginning execution of "us-central1-hello"').last()
  const loading = logRow(page, `loading cart for ${uid}`)
  const empty = logRow(page, 'Cart is empty').last()
  await expect(begin).toBeVisible()
  await expect(loading).toBeVisible()
  await expect(empty).toBeVisible()
  await expect(part(empty, 'level')).toHaveText('warn')
  await expect(part(loading, 'level')).toHaveText('')
  // Following: the newest line is the last row and it is in view.
  await expect(logRows(page).last()).toBeInViewport()
  await expect(page.getByTestId('logs-pause')).toHaveText('Pause')

  if (await attributesInvocations(engine)) {
    // Each line names the function that printed it, and the call ends with one line.
    await expect(part(loading, 'source')).toHaveText('hello')
    await expect(part(empty, 'source')).toHaveText('hello')
    await expect(logRow(page, /Finished "us-central1-hello"/).last()).toBeVisible()
  }
})

test('a line says which invocation printed it, and opens exactly that one', async ({
  page,
  engine,
}) => {
  test.skip(!(await attributesInvocations(engine)), NEEDS_ATTRIBUTION)
  const uid = unique('u')
  await callFunction(engine, 'hello', { uid })
  await openLogs(page, engine)
  await logRow(page, `loading cart for ${uid}`).click()
  const inspector = page.getByTestId('log-inspector')
  await expect(inspector.getByTestId('fact-function')).toContainText('us-central1-hello')
  const execution = /[0-9a-f]{6}-\d+/.exec(
    await inspector.getByTestId('fact-execution').innerText(),
  )?.[0]
  expect(execution).toMatch(/^[0-9a-f]{6}-\d+$/)

  await inspector.getByTestId('show-invocation').click()
  await expect.poll(() => queryOf(page)).toContain(`execution:${execution}`)
  // Exactly the call's own lines, in the order it printed them.
  const rows = logRows(page)
  await expect(rows).toHaveCount(4)
  await expect(rows.nth(0)).toContainText('Beginning execution of "us-central1-hello"')
  await expect(rows.nth(1)).toContainText(`loading cart for ${uid}`)
  await expect(rows.nth(2)).toContainText('Cart is empty')
  await expect(rows.nth(3)).toContainText('Finished "us-central1-hello"')
  await expect(page.getByTestId('logs-match-count')).toHaveText('4 lines')
})

test('a payload opens as a tree whose values filter the log', async ({ page, engine }) => {
  // A refused read carries the details of the decision as its payload.
  const order = unique('o')
  expect(await readAs(engine, ADA, `users/${GRACE.uid}/orders/${order}`)).toBe(403)
  const denial = await lineOf(engine, `kind:rules.denied "${order}"`)
  await openLogs(page, engine, { q: 'kind:rules.denied' })
  const row = page.locator(`[data-testid="log-row"][data-cursor="${denial.cursor}"]`)
  await expect(row).toBeVisible()
  // The cursor row (↓ from the field's end lands on rows; a click opens the
  // inspector too), then → expands it in place.
  await row.click()
  await page.getByTestId('log-inspector').getByRole('button', { name: 'Close the line' }).click()
  await page.keyboard.press('ArrowRight')
  const tree = page.getByTestId('log-detail').getByTestId('payload-tree')
  const path = tree.locator('[data-testid="payload-tree-row"][data-path="path"]')
  await expect(path).toContainText(`users/${GRACE.uid}/orders/${order}`)
  await expect(tree.locator('[data-path="origin"]')).toContainText('"app"')
  await path.hover()
  await path.getByTestId('payload-tree-filter').click()
  await expect
    .poll(() => queryOf(page))
    .toBe(`kind:rules.denied payload.path:"users/${GRACE.uid}/orders/${order}"`)
  await expect(logRows(page)).toHaveCount(1)
  await expect(logRows(page).first()).toHaveAttribute('data-cursor', denial.cursor)
  await expect(page.getByTestId('logs-match-count')).toHaveText('1 line')

  if (await attributesInvocations(engine)) {
    // A firebase-functions logger call: its fields are the payload, the
    // message its text, its severity the level.
    const uid = unique('u')
    await callFunction(engine, 'hello', { uid })
    await openLogs(page, engine, { q: `"Cart is empty"` })
    const empty = logRows(page).last()
    await expect(part(empty, 'message')).toHaveText('Cart is empty')
    await empty.click()
    await page.getByRole('button', { name: 'Close the line' }).click()
    await page.keyboard.press('ArrowRight')
    const cart = page.locator('[data-testid="payload-tree-row"][data-path="cartId"]').last()
    await expect(cart).toContainText('"c_19"')
    await cart.hover()
    await cart.getByTestId('payload-tree-filter').click()
    await expect.poll(() => queryOf(page)).toBe('"Cart is empty" payload.cartId:"c_19"')
  }
})

test('the feed follows, freezes the moment you scroll, and catches up on End', async ({
  page,
  engine,
}) => {
  await openLogs(page, engine)
  await callFunction(engine, 'burst', { n: 3000 })
  await expect(logRow(page, 'burst line 2999 of 3000')).toBeInViewport()

  // Twenty rows up with the wheel: the reader's scroll pauses the feed.
  await page.getByTestId('logs-feed-scroll').hover()
  await page.mouse.wheel(0, -480)
  await expect(page.getByTestId('logs-pause')).toHaveText(/^Paused/)
  await expect.poll(() => new URL(page.url()).searchParams.get('paused')).toBe('true')
  const rows = page.getByTestId('feed-row')
  const drawn = await rows.count()
  const top = await rows.first().innerText()

  // Lines keep arriving; the view holds still and counts them.
  await callFunction(engine, 'burst', { n: 5000 })
  await expect(page.getByTestId('logs-pause')).toHaveText(/^Paused · [\d,]+ new$/)
  await expect(page.getByTestId('jump-to-latest')).toHaveText(/^[\d,]+ new · Jump to latest$/)
  await lineOf(engine, '"burst line 4999 of 5000"')
  expect(await rows.count()).toBe(drawn)
  expect(await rows.first().innerText()).toBe(top)

  // End: back to the newest, following.
  await page.keyboard.press('End')
  await expect(page.getByTestId('logs-pause')).toHaveText('Pause')
  await expect.poll(() => new URL(page.url()).searchParams.get('paused')).toBeNull()
  await expect(logRows(page).last()).toContainText('burst line 4999 of 5000')
  await expect(logRows(page).last()).toBeInViewport()

  // `p` pauses and resumes the same way.
  await page.keyboard.press('p')
  await expect(page.getByTestId('logs-pause')).toHaveText(/^Paused/)
  await expect.poll(() => new URL(page.url()).searchParams.get('paused')).toBe('true')
  await page.keyboard.press('p')
  await expect(page.getByTestId('logs-pause')).toHaveText('Pause')

  // The feed says what it is doing in its own words; never "Live".
  for (const id of ['logs-pause', 'range-picker'])
    await expect(page.getByTestId(id)).not.toContainText('Live')
})

test('facets, words, regular expressions and exclusions narrow the log, in the URL', async ({
  page,
  engine,
}) => {
  await timeOut(engine)
  await callFunction(engine, 'burst', { n: 2000 })
  await openLogs(page, engine)

  // "Only" on Error: the filter is the level, the rows are errors.
  const error = page.getByTestId('logs-facets').locator('[data-term="level:error"]').locator('..')
  await error.hover()
  await error.getByTestId('facet-only').click()
  await expect.poll(() => queryOf(page)).toBe('level:error')
  await expect(logRow(page, TIMED_OUT).first()).toBeVisible()
  const levels = await logRows(page).locator('[data-part="level"]').allInnerTexts()
  expect(levels.length).toBeGreaterThan(0)
  expect(new Set(levels)).toEqual(new Set(['error']))
  // The facet's count is the rows shown, and MatchCount agrees.
  const count = Number(
    ((await error.locator('[data-term="level:error"] span').last().textContent()) ?? '').replace(
      /\D/g,
      '',
    ),
  )
  expect(count).toBe(levels.length)
  expect(await matchCount(page)).toBe(count)
  // A reload keeps the view: it is the URL.
  await page.reload()
  await expect(logRow(page, TIMED_OUT).first()).toBeVisible()
  expect(queryOf(page)).toBe('level:error')

  // Words: marks in the rows that match.
  const field = page.getByTestId('logs-filter-input')
  await field.fill('burst line 12')
  await field.press('Enter')
  await expect.poll(() => queryOf(page)).toBe('burst line 12')
  // Every word marked in the newest match, on the neutral ground.
  const newest = logRows(page).last()
  await expect(newest).toContainText(/burst line \d*12/)
  await expect(newest.locator('mark').first()).toBeVisible()
  expect(await newest.locator('mark').allInnerTexts()).toEqual(
    expect.arrayContaining(['burst', 'line', '12']),
  )

  // A regular expression, counted by the engine.
  await field.fill('/burst line 1\\d{3} of 2000/')
  await field.press('Enter')
  await expect(page.getByTestId('logs-match-count')).toHaveText('1,000 lines')

  // A negated phrase takes every burst line out.
  await field.fill('-"burst line"')
  await field.press('Enter')
  await expect.poll(() => queryOf(page)).toBe('-"burst line"')
  await expect(logRows(page).first()).toBeVisible()
  await expect(logRow(page, 'burst line')).toHaveCount(0)

  // "Hide lines like this" from a row's menu adds the line's start, negated.
  const hello = logRow(page, 'http function initialized').first()
  const hidden = await part(hello, 'message').innerText()
  await hello.click({ button: 'right' })
  await page.getByTestId('log-row-menu').getByText('Hide lines like this').click()
  const q = queryOf(page) ?? ''
  expect(q.startsWith('-"burst line" -"')).toBe(true)
  expect(hidden.startsWith(q.slice('-"burst line" -"'.length, -1))).toBe(true)
  await expect(logRow(page, hidden)).toHaveCount(0)
})

test('debug lines show by default, and engine internals are one switch away', async ({
  page,
  engine,
}) => {
  await openLogs(page, engine)
  const internals = page.getByTestId('logs-facets').locator('[data-term="is:internal"]')
  await expect(internals).toContainText('Engine internals')
  await expect(internals).toHaveAttribute('aria-pressed', 'false')
  const facets = await facetsOf(engine)
  expect(facets.internalHidden).toBeGreaterThan(0)
  await expect(internals).toContainText(
    new Intl.NumberFormat('en-US').format(facets.internalHidden),
  )

  // Saving a file of the codebase: the engine's debug line about the reload.
  const before = await cursorOf(engine, '"Functions routing refreshed"')
  const { utimesSync } = await import('node:fs')
  const { join } = await import('node:path')
  const now = new Date()
  utimesSync(join(engine.directory, 'functions', 'observe.js'), now, now)
  const detected = await lineOf(engine, '"File change detected"', before ? { after: before } : {})
  expect(detected.level).toBe('debug')
  const row = page.locator(`[data-testid="log-row"][data-cursor="${detected.cursor}"]`)
  await expect(row).toBeVisible()
  await expect(part(row, 'level')).toHaveText('debug')
  expect(queryOf(page)).toBeNull()
  // The codebase is back before the next journey calls it.
  await lineOf(engine, '"Functions routing refreshed"', { after: detected.cursor, timeout: 60_000 })

  await callFunction(engine, 'debugs')
  const debug = logRow(page, 'debug detail for the e2e').last()
  await expect(debug).toBeVisible()
  if (await attributesInvocations(engine)) await expect(part(debug, 'level')).toHaveText('debug')
})

test('a line of many lines opens in place, and copies whole', async ({ page, engine }) => {
  const line = await timeOut(engine)
  await openLogs(page, engine)
  const row = page.locator(`[data-testid="log-row"][data-cursor="${line.cursor}"]`)
  await expect(part(row, 'level')).toHaveText('error')
  await expect(part(row, 'message')).toHaveText(`${TIMED_OUT} To configure this timeout, see`)
  await expect(row.locator('[data-part="more"]')).toHaveText('+1 line')

  // → opens it under the cursor, ← closes it.
  const feedRow = page.locator(`[data-testid="feed-row"]:has([data-cursor="${line.cursor}"])`)
  await row.click()
  await page.getByRole('button', { name: 'Close the line' }).click()
  await page.keyboard.press('ArrowRight')
  await expect(row.getByTestId('log-row-expand')).toHaveAttribute('aria-expanded', 'true')
  await expect(feedRow.getByTestId('log-detail-message')).toContainText(
    'https://firebase.google.com/docs/functions/manage-functions',
  )
  await page.keyboard.press('ArrowLeft')
  await expect(row.getByTestId('log-row-expand')).toHaveAttribute('aria-expanded', 'false')
  await expect(feedRow.getByTestId('log-detail')).toHaveCount(0)

  // Copy (`c` on the cursor row) puts every line of it on the clipboard.
  await page.keyboard.press('c')
  await expect.poll(() => readClipboard(page)).toContain(TIMED_OUT)
  const copied = await readClipboard(page)
  expect(copied).toContain('https://firebase.google.com/docs/functions/manage-functions')
  expect(copied).toMatch(/ ERROR /)

  if (await attributesInvocations(engine)) {
    // A handler's error: its stack under the message.
    await callFunction(engine, 'fails')
    await openLogs(page, engine, { q: 'level:error "cannot read"' })
    const failed = logRows(page).last()
    await expect(part(failed, 'message')).toContainText("TypeError: cannot read 'id' of undefined")
    await expect(failed.locator('[data-part="more"]')).toHaveText(/^\+[\d,]+ lines?$/)
    await failed.click()
    await page.getByRole('button', { name: 'Close the line' }).click()
    await page.keyboard.press('ArrowRight')
    await expect(
      page
        .locator('[data-testid="feed-row"]')
        .filter({ has: failed })
        .getByTestId('log-detail-message'),
    ).toContainText('at ')
  }
})

test('a refused read is a line that says why, told apart from the console’s own', async ({
  page,
  engine,
}) => {
  await openLogs(page, engine, { q: 'service:firestore' })
  // An app signed in as Ada reads Grace's document.
  expect(await readAs(engine, ADA, `users/${GRACE.uid}`)).toBe(403)
  const get = logRow(page, `Rules denied get on users/${GRACE.uid} for ${ADA.uid}`).last()
  await expect(get).toBeVisible()
  await expect(part(get, 'level')).toHaveText('warn')
  await expect(get.getByTestId('log-row-link')).toHaveText('See why')

  // "See why" opens the decision on the rules page.
  await get.getByTestId('log-row-link').click()
  await expect(page).toHaveURL(/\/console\/firestore\/rules\?.*decision=/)
  await expect(page.getByTestId('decision-detail')).toBeVisible()
  await expect(page.getByTestId('decision-path')).toHaveText(`users/${GRACE.uid}`)

  // The same from the keys: `o` on the cursor row.
  await page.goBack()
  await expect(get).toBeVisible()
  await get.click()
  await page.getByRole('button', { name: 'Close the line' }).click()
  await page.keyboard.press('o')
  await expect(page).toHaveURL(/\/console\/firestore\/rules\?.*decision=/)
  // Opening a line paused the feed; back to following.
  await openLogs(page, engine, { q: 'service:firestore' })

  // A refused query names the collection, and its line opens it.
  expect(await listAs(engine, ADA, 'users')).toBe(403)
  const list = logRow(page, `Rules denied list on users for ${ADA.uid}`).last()
  await expect(list).toBeVisible()
  await list.click()
  const inspector = page.getByTestId('log-inspector')
  const collection = inspector.getByTestId('log-inspector-ref').filter({ hasText: /^users$/ })
  await expect(collection).toBeVisible()
  await expect(collection.getByRole('link')).toHaveAttribute(
    'href',
    /\/console\/firestore\?.*path=users/,
  )

  // The console's "view as Ada" refused the same way: its own line, not a
  // problem. (The open line paused the feed: back to following first.)
  await openLogs(page, engine, { q: 'service:firestore' })
  const console_ = await page.context().newPage()
  await console_.goto(`${engine.origin}/console/firestore?path=users&as=${ADA.uid}`)
  await expect(console_.getByText('Denied by security rules')).toBeVisible()
  await console_.close()
  const viewing = logRow(page, `from the console (viewing as ${ADA.uid})`).last()
  await expect(viewing).toBeVisible()
  await expect(part(viewing, 'level')).toHaveText('')
  const problems = await facetsOf(engine, { q: `is:problem "viewing as ${ADA.uid}"` })
  expect(problems.matched).toBe(0)
})

test('downloads hold exactly what the filter shows', async ({ page, engine }) => {
  expect(await readAs(engine, ADA, `users/${GRACE.uid}`)).toBe(403)
  await lineOf(engine, 'kind:rules.denied')
  await openLogs(page, engine, { q: 'service:firestore' })
  await expect(logRows(page).first()).toBeVisible()
  const shown = await matchCount(page)

  await page.getByTestId('log-menu').click()
  const ndjson = page.waitForEvent('download')
  await page.getByTestId('log-menu-ndjson').click()
  const file = await ndjson
  expect(file.suggestedFilename()).toMatch(/^firenook-logs-.+\.ndjson$/)
  const lines = (await readDownload(file)).split('\n').filter((line) => line !== '')
  expect(lines).toHaveLength(shown)
  for (const line of lines) {
    const entry = JSON.parse(line) as { cursor: string; time: string; service: string }
    expect(entry.service).toBe('firestore')
    expect(typeof entry.cursor).toBe('string')
    expect(Number.isNaN(Date.parse(entry.time))).toBe(false)
  }

  await page.getByTestId('log-menu').click()
  const text = page.waitForEvent('download')
  await page.getByTestId('log-menu-text').click()
  const textFile = await text
  expect(textFile.suggestedFilename()).toMatch(/^firenook-logs-.+\.txt$/)
  const first = (await readDownload(textFile)).split('\n')[0] ?? ''
  expect(first).toMatch(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z (DEBUG|INFO |WARN |ERROR) \S+ \S/,
  )
})

test('a Google Emulator UI link opens the same view; foreign params are not read', async ({
  page,
  engine,
}) => {
  const attributed = await attributesInvocations(engine)
  await page.goto(
    `${engine.origin}/console/logs?q=${encodeURIComponent('metadata.function.name="us-central1-hello"')}`,
  )
  await expect.poll(() => queryOf(page)).toBe('function:us-central1-hello')
  await expect(page.getByTestId('logs-filter-input')).toHaveValue('function:us-central1-hello')
  if (attributed) {
    await expect(logRow(page, 'loading cart for').first()).toBeVisible()
    for (const text of await logRows(page).allInnerTexts()) expect(text).toContain('hello')
    // The link other sections build (`linkToLogs`): one invocation.
    await logRow(page, 'loading cart for').last().click()
    const execution = (await page.getByTestId('fact-execution').innerText()).split(/\s/)[0] ?? ''
    await page.goto(
      `${engine.origin}/console/logs?q=${encodeURIComponent(
        `function:us-central1-hello execution:${execution}`,
      )}`,
    )
    await expect(logRows(page)).toHaveCount(4)
  } else {
    // Functions lines name no function yet: the filter is right, and says it matches nothing.
    await expect(page.getByTestId('logs-no-match')).toBeVisible()
  }

  // A param of another tool's making is not a filter: every line shows.
  await openLogs(page, engine, { function: 'us-central1-hello' })
  await expect(page.getByTestId('logs-filter-input')).toHaveValue('')
  await expect(logRows(page).first()).toBeVisible()
  await expect.poll(() => matchCount(page)).toBe((await facetsOf(engine)).matched)
  expect(queryOf(page)).toBeNull()
})

test('a window in time: a preset, or the bars of the volume strip', async ({ page, engine }) => {
  await openLogs(page, engine)
  // A line now, so the last minute holds one.
  const marker = unique('minute')
  await callFunction(engine, 'hello', { uid: marker })
  await lineOf(engine, `"${marker}"`)

  await page.getByTestId('range-picker').click()
  await page.getByTestId('range-1m').click()
  await expect.poll(() => new URL(page.url()).searchParams.get('from')).toBe('-1m')
  await expect(page.getByTestId('range-picker')).toHaveText('Last minute')
  await expect(logRow(page, `loading cart for ${marker}`)).toBeVisible()
  // The page counts the window as the engine does, draws nothing older,
  // and, once it holds the whole window, says nothing older matches.
  await expect
    .poll(
      async () => (await matchCount(page)) === (await facetsOf(engine, { from: '-1m' })).matched,
    )
    .toBe(true)
  if ((await facetsOf(engine, { from: '-1m' })).matched <= 500)
    await expect(page.getByTestId('log-edge')).toHaveText('No older lines match')
  const older = await logPage(engine, {
    to: new Date(Date.now() - 61_000).toISOString(),
    limit: '1',
  })
  for (const line of older.items)
    await expect(page.locator(`[data-testid="log-row"][data-cursor="${line.cursor}"]`)).toHaveCount(
      0,
    )

  // A bar of the strip is a window of its own: from and to, read on the trigger.
  const bars = page.getByTestId('logs-volume').locator('[data-index]')
  await expect(bars.first()).toBeVisible()
  await bars.last().click()
  await expect.poll(() => new URL(page.url()).searchParams.get('to')).not.toBeNull()
  const url = new URL(page.url())
  const from = url.searchParams.get('from') ?? ''
  const to = url.searchParams.get('to') ?? ''
  expect(Number.isNaN(Date.parse(from))).toBe(false)
  expect(Date.parse(to)).toBeGreaterThan(Date.parse(from))
  await expect(page.getByTestId('range-picker')).toHaveText(
    /^\d{2}:\d{2}(:\d{2})?–\d{2}:\d{2}(:\d{2})?$/,
  )
  // The page counts that window exactly as the engine does.
  const facets = await facetsOf(engine, { from, to })
  await expect.poll(() => matchCount(page)).toBe(facets.matched)
})

test('a link to a line opens it among its neighbours, paused', async ({ page, engine }) => {
  await callFunction(engine, 'burst', { n: 5000 })
  const error = await timeOut(engine)
  await callFunction(engine, 'burst', { n: 1500 })
  // What `linkTo` builds for its `logs.entry` ref.
  await openLogs(page, engine, { entry: error.cursor })
  await expect.poll(() => new URL(page.url()).searchParams.get('paused')).toBe('true')
  await expect(page.getByTestId('logs-pause')).toHaveText(/^Paused/)
  const row = page.locator(`[data-testid="feed-row"]:has([data-cursor="${error.cursor}"])`)
  await expect(row).toBeInViewport()
  await expect(row).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('log-inspector-title')).toContainText(TIMED_OUT)
  // Its neighbours: the burst printed just before it.
  await expect(logRow(page, 'of 5000').first()).toBeVisible()
  await expect(page.getByTestId('logs-back-to-latest')).toBeVisible()

  // Rows up with the keys, then F8: back to the next problem, this one.
  await page.getByRole('button', { name: 'Close the line' }).click()
  for (let step = 0; step < 6; step += 1) await page.keyboard.press('ArrowUp')
  await expect(row).not.toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('F8')
  await expect(row).toHaveAttribute('aria-selected', 'true')
  await expect(row).toBeInViewport()

  await page.getByTestId('logs-back-to-latest').click()
  await expect(page.getByTestId('logs-pause')).toHaveText('Pause')
  await expect(logRows(page).last()).toContainText('burst line 1499 of 1500')
})

test('problems survive a flood that the rest of the log does not', async ({ page, engine }) => {
  const error = await timeOut(engine)
  await callFunction(engine, 'burst', { n: 25_000 })
  await lineOf(engine, '"burst line 24999 of 25000"')
  // The main ring has let go of everything before the burst; the problem ring kept the error.
  const older = await logPage(engine, { q: '"burst line"', before: error.cursor, limit: '1' })
  expect(older.items).toHaveLength(0)

  await openLogs(page, engine, { q: 'level:error' })
  // The newest error row: identical errors in a row of this view are one group (×N).
  const row = logRow(page, TIMED_OUT).last()
  await expect(row).toBeVisible()
  await row.click()
  await expect(page.getByTestId('log-inspector-title')).toContainText(TIMED_OUT)
  const facets = await facetsOf(engine, { q: 'level:error' })
  expect(facets.matched).toBeGreaterThanOrEqual(1)
  await expect.poll(() => matchCount(page)).toBe(facets.matched)
})

test('a hidden tab takes nothing, and catches up when it is shown', async ({ page, engine }) => {
  await page.addInitScript(() =>
    localStorage.setItem('firenook.console.live-timing', JSON.stringify({ releaseMs: 60_000 })),
  )
  await openLogs(page, engine)
  const cdp = await page.context().newCDPSession(page)
  const removals: number[] = []
  const onRequest = (request: Request) => {
    if (
      request.method() === 'POST' &&
      /\/console\/api\/v1\/live\/[^/]+\/subscriptions$/.test(new URL(request.url()).pathname) &&
      ((request.postDataJSON() as { remove?: string[] }).remove ?? []).length > 0
    )
      removals.push(request.timing().startTime)
  }
  page.on('request', onRequest)

  const heap = async () => {
    await cdp.send('HeapProfiler.collectGarbage')
    return (await cdp.send('Runtime.getHeapUsage')).usedSize
  }
  const before = await heap()
  const hiddenAt = await hide(page)
  await expect.poll(() => removals.length).toBeGreaterThan(0)
  expect((removals[0] ?? Infinity) - hiddenAt).toBeLessThanOrEqual(100)

  await callFunction(engine, 'burst', { n: 20_000 })
  await lineOf(engine, '"burst line 19999 of 20000"')
  expect((await heap()) - before).toBeLessThanOrEqual(5 * 1024 * 1024)
  page.off('request', onRequest)

  await setVisibility(page, 'visible')
  await expect(logRows(page).last()).toContainText('burst line 19999 of 20000')
  await cdp.detach()
})

/** Hides the page as `setVisibility` does, and says when (the browser's clock, epoch ms). */
function hide(page: Page): Promise<number> {
  return page.locator('html').evaluate((root) => {
    const shown = root.ownerDocument
    Object.defineProperty(shown, 'visibilityState', { configurable: true, get: () => 'hidden' })
    Object.defineProperty(shown, 'hidden', { configurable: true, get: () => true })
    const at = Date.now()
    shown.dispatchEvent(new Event('visibilitychange'))
    return at
  })
}

test('counts agree with the engine past its cap', async ({ page, engine }) => {
  await openLogs(page, engine)
  await callFunction(engine, 'burst', { n: 25_001 })
  await lineOf(engine, '"burst line 25000 of 25001"')
  const ended = Date.now()
  const agree = async () => {
    const [facets, histogram] = await Promise.all([facetsOf(engine), histogramOf(engine)])
    const strip = Number(await page.getByTestId('logs-volume-total').getAttribute('data-total'))
    return (await matchCount(page)) === facets.matched && strip === histogramTotal(histogram)
  }
  await expect.poll(agree, { timeout: 2_000, intervals: [100] }).toBe(true)
  expect(Date.now() - ended).toBeLessThanOrEqual(2_500)
  expect((await facetsOf(engine)).logged).toBeGreaterThan(20_000)
})

test('type and colour: the data face, one hue a level, a neutral search mark', async ({
  page,
  engine,
}) => {
  await timeOut(engine)
  for (const theme of ['light', 'dark'] as const) {
    await page.addInitScript(
      (choice) => localStorage.setItem('firenook.console.theme', choice),
      theme,
    )
    await openLogs(page, engine, { q: 'level:error "timed out"' })
    await expect(page.locator('html')).toHaveAttribute('data-mode', theme)
    // Identical errors in a row of this view are one group: its row is the newest.
    const row = logRow(page, TIMED_OUT).last()
    await expect(row).toBeVisible()
    const style = (selector: string) =>
      row
        .locator(selector)
        .first()
        .evaluate((node) => {
          const computed = node.ownerDocument.defaultView!.getComputedStyle(node)
          return { size: computed.fontSize, family: computed.fontFamily, color: computed.color }
        })
    const message = await style('[data-part="message"]')
    expect(message.size).toBe('12px')
    expect(message.family).toMatch(/mono/i)
    expect((await style('[data-part="time"]')).size).toBe('11px')
    expect((await style('[data-testid="log-row-source"]')).size).toBe('11px')
    const facetCount = page
      .getByTestId('logs-facets')
      .locator('[data-term="level:error"] span')
      .last()
    expect(
      await facetCount.evaluate(
        (node) => node.ownerDocument.defaultView!.getComputedStyle(node).fontSize,
      ),
    ).toBe('11px')

    // The level's rail and word are danger red; the message keeps the row's ink.
    const danger = await tokenColour(page, '--color-kumo-danger')
    const rail = await part(row, 'level').evaluate(
      (node) => node.ownerDocument.defaultView!.getComputedStyle(node, '::before').backgroundColor,
    )
    expect(rail).toBe(danger)
    expect((await style('[data-part="level"]')).color).toBe(
      await tokenColour(page, '--text-color-kumo-danger'),
    )
    expect(message.color).toBe(await tokenColour(page, '--text-color-kumo-default'))

    // The search mark is the neutral fill, never a warning tint.
    const mark = row.locator('mark').first()
    await expect(mark).toBeVisible()
    const fill = await tokenColour(page, '--color-kumo-fill', 'backgroundColor')
    expect(
      await mark.evaluate(
        (node) => node.ownerDocument.defaultView!.getComputedStyle(node).backgroundColor,
      ),
    ).toBe(fill)
  }
})

test.describe('@perf', () => {
  test.skip(process.env.FIRENOOK_PERF !== '1', 'opt-in: FIRENOOK_PERF=1')

  test('@perf a burst of 20,000 lines keeps frames short and the inspector quick', async ({
    page,
    engine,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await openLogs(page, engine, { q: 'service:functions "burst line"' })
    await page.evaluate(() => {
      const record = globalThis as unknown as PerfRecorder
      record.__frames = []
      record.__longest = 0
      record.__framing = true
      let last = record.performance.now()
      const tick = (now: number) => {
        record.__frames.push(now - last)
        last = now
        if (record.__framing) record.requestAnimationFrame(tick)
      }
      record.requestAnimationFrame(tick)
      new record.PerformanceObserver((list) => {
        for (const entry of list.getEntries())
          record.__longest = Math.max(record.__longest, entry.duration)
      }).observe({ type: 'longtask', buffered: false })
    })
    const call = callFunction(engine, 'burst', { n: 20_000 })
    await expect(logRow(page, 'of 20000').first()).toBeVisible()
    // A row pressed mid-burst opens in the inspector quickly.
    const pressed = Date.now()
    await logRow(page, 'of 20000').first().click()
    await expect(page.getByTestId('log-inspector-title')).toContainText('of 20000')
    const opened = Date.now() - pressed
    await call
    await lineOf(engine, '"burst line 19999 of 20000"')
    const { frames, longest } = await page.evaluate(() => {
      const record = globalThis as unknown as PerfRecorder
      record.__framing = false
      return { frames: record.__frames.slice(1), longest: record.__longest }
    })
    const sorted = frames.toSorted((a, b) => a - b)
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0
    test
      .info()
      .annotations.push(
        { type: 'frame p95', description: `${p95.toFixed(1)} ms` },
        { type: 'longest task', description: `${longest.toFixed(0)} ms` },
        { type: 'inspector', description: `${opened} ms` },
      )
    expect(p95).toBeLessThanOrEqual(25)
    expect(longest).toBeLessThanOrEqual(150)
    expect(opened).toBeLessThanOrEqual(300)
  })
})

/** What the perf journey keeps on the page; this file is typed for Node, not the DOM. */
interface PerfRecorder {
  __frames: number[]
  __framing: boolean
  __longest: number
  requestAnimationFrame(callback: (now: number) => void): number
  performance: { now(): number }
  PerformanceObserver: new (callback: (list: { getEntries(): { duration: number }[] }) => void) => {
    observe(options: { type: string; buffered: boolean }): void
  }
}
