import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Engine, dedicated, expect } from './fixtures'
import { readClipboard, ticked } from './support/clipboard'

// The Indexes page: what the index file declares, the indexes production
// would refuse the app's queries for, and Add and Remove, which write the
// file. Each journey starts its own engine: what one leaves in the engine's
// list would put a toolbar button in front of the other Firestore journeys,
// and these change the profile's index file. The `data` profile's file
// declares one composite index on `users`, so a query it serves is never
// listed and one on `orders` is.

/** `orders` where `status ==` ordered by `total` descending: (status, total desc). */
const ORDERS_BY_TOTAL = {
  from: [{ collectionId: 'orders' }],
  where: {
    fieldFilter: {
      field: { fieldPath: 'status' },
      op: 'EQUAL',
      value: { stringValue: 'open' },
    },
  },
  orderBy: [{ field: { fieldPath: 'total' }, direction: 'DESCENDING' }],
}

/** The declared index's query: `users` where `plan ==` ordered by `lastSeen` descending. */
const USERS_BY_LAST_SEEN = {
  from: [{ collectionId: 'users' }],
  where: {
    fieldFilter: { field: { fieldPath: 'plan' }, op: 'EQUAL', value: { stringValue: 'pro' } },
  },
  orderBy: [{ field: { fieldPath: 'lastSeen' }, direction: 'DESCENDING' }],
}

const ENTRY = {
  collectionGroup: 'orders',
  queryScope: 'COLLECTION',
  fields: [
    { fieldPath: 'status', order: 'ASCENDING' },
    { fieldPath: 'total', order: 'DESCENDING' },
  ],
}

/** A query as the app sends it: REST `runQuery` with the Admin SDK's owner token. */
async function appQuery(engine: Engine, structuredQuery: object): Promise<Response> {
  const host = new URL(engine.origin).hostname
  return fetch(
    `http://${host}:${engine.ports.firestore}/v1/projects/${engine.project}/databases/(default)/documents:runQuery`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer owner' },
      body: JSON.stringify({ structuredQuery }),
    },
  )
}

dedicated(
  'the Indexes page lists what the app needed, adds it to the file and takes it out again',
  async ({ page, dedicatedEngine, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    const engine = await dedicatedEngine('data')
    const path = join(engine.directory, 'firestore.indexes.json')
    const original = readFileSync(path, 'utf8')
    const declared = JSON.parse(original) as { indexes: object[]; fieldOverrides: object[] }
    await page.goto(`${engine.origin}/console/firestore`)
    await expect(page.getByTestId('firestore-workbench')).toBeVisible({ timeout: 15_000 })
    const button = page.getByTestId('missing-indexes-button')
    // Nothing needed an index yet, and the declared one is never listed.
    expect((await appQuery(engine, USERS_BY_LAST_SEEN)).status).toBe(200)
    await expect(button).toHaveCount(0)

    // The app's query is answered, as the official emulator answers it, and
    // the toolbar says so while the page watches.
    expect((await appQuery(engine, ORDERS_BY_TOTAL)).status).toBe(200)
    await expect(button).toHaveAttribute('data-missing', '1')
    await expect(button).toContainText('1 index missing')
    await expect(page.getByTestId('nav-badge-firestore-indexes')).toContainText('1')

    // The count is the way to the page.
    await button.click()
    await expect(page).toHaveURL(/\/console\/firestore\/indexes/)
    await expect(page.getByTestId('indexes-file-name')).toHaveText('firestore.indexes.json')
    const composite = page.getByTestId('composite-indexes')
    await expect(composite).toHaveAttribute('data-rows', '1')
    await expect(composite.getByTestId('data-row')).toContainText('users')
    await expect(composite.getByTestId('data-row')).toContainText('lastSeen')
    await expect(page.getByTestId('field-overrides')).toContainText('No overrides')

    const needed = page.getByTestId('indexes-needed')
    await expect(needed.getByTestId('missing-indexes-headline')).toHaveText(
      'Your app ran a query whose index is not in firestore.indexes.json. It works in the emulator, but production would reject it. Add the index before you deploy.',
    )
    await expect(needed.getByTestId('indexes-needed-count')).toHaveText('1')
    const row = needed.getByTestId('missing-index')
    await expect(row).toHaveCount(1)
    await expect(row).toHaveAttribute('data-declared', 'false')
    await expect(row.getByTestId('missing-index-query')).toHaveText(
      'where("status", "==", …).orderBy("total", "desc")',
    )
    await expect(row).toContainText('orders')
    await expect(row).toContainText('Composite index')
    await expect(row.getByTestId('missing-index-count')).toContainText('1 query')

    // Counts follow, at most every two seconds.
    for (let index = 0; index < 2; index += 1)
      expect((await appQuery(engine, ORDERS_BY_TOTAL)).status).toBe(200)
    await expect(row.getByTestId('missing-index-count')).toContainText('3 queries', {
      timeout: 10_000,
    })

    // What it copies is the entry to add, and every one at once as a file.
    const copyEntry = row.getByTestId('copy-missing-entry')
    await copyEntry.click()
    await ticked(copyEntry)
    expect(JSON.parse(await readClipboard(page))).toEqual(ENTRY)
    const copyAll = needed.getByTestId('copy-missing-file')
    await copyAll.click()
    await ticked(copyAll)
    expect(JSON.parse(await readClipboard(page))).toEqual({ indexes: [ENTRY], fieldOverrides: [] })

    // The page is a link.
    await page.reload()
    await expect(page.getByTestId('missing-index')).toHaveCount(1, { timeout: 15_000 })

    // Add writes the entry into the file after the one there, and it is in
    // force at once: the row turns to declared and the table has it.
    await page.getByTestId('add-missing-entry').click()
    await expect(page.getByTestId('missing-index')).toHaveAttribute('data-declared', 'true')
    await expect(page.getByTestId('missing-index')).toContainText('Added')
    await expect(page.getByTestId('missing-indexes-headline')).toHaveText(
      "Every index your app's queries needed is in firestore.indexes.json now.",
    )
    await expect(composite).toHaveAttribute('data-rows', '2')
    await expect(page.getByTestId('nav-badge-firestore-indexes')).toHaveCount(0)
    const written = readFileSync(path, 'utf8')
    expect(JSON.parse(written)).toEqual({ ...declared, indexes: [...declared.indexes, ENTRY] })
    // Only the new lines: what was there is as it was.
    const before = original.slice(0, original.indexOf('\n  ],'))
    expect(written.startsWith(before)).toBe(true)
    expect(written.endsWith(original.slice(original.indexOf('\n  ],')))).toBe(true)

    // Remove takes it out, and the file is byte for byte what it was.
    const ordersRow = composite.getByTestId('data-row').filter({ hasText: 'orders' })
    await ordersRow.click({ button: 'right' })
    await page.getByTestId('row-menu-remove').click()
    const confirm = page.getByTestId('index-remove-confirm')
    await expect(confirm).toContainText('status ↑, total ↓ comes out of firestore.indexes.json')
    await confirm.getByRole('button', { name: /^Remove/ }).click()
    await expect(composite).toHaveAttribute('data-rows', '1')
    expect(readFileSync(path, 'utf8')).toBe(original)
    await expect(page.getByTestId('missing-index')).toHaveAttribute('data-declared', 'false')

    // A save in an editor is followed as well.
    writeFileSync(
      path,
      JSON.stringify({ ...declared, indexes: [...declared.indexes, ENTRY] }, null, 2),
    )
    await expect(page.getByTestId('missing-index')).toHaveAttribute('data-declared', 'true', {
      timeout: 15_000,
    })
    await expect(composite).toHaveAttribute('data-rows', '2')

    // A file that is not valid keeps the indexes in force and says why.
    writeFileSync(path, '{"indexes": [')
    await expect(page.getByTestId('indexes-file-problem')).toContainText(
      'firestore.indexes.json has an error: invalid index JSON',
      { timeout: 15_000 },
    )
    await expect(composite).toHaveAttribute('data-rows', '2')

    // The warning is a line of the log, a problem of its own kind; each
    // edit from the console is a marker, as a file saved in an editor is.
    await page.goto(`${engine.origin}/console/logs?q=kind%3Afirestore.index.missing`)
    const line = page.getByTestId('log-row')
    await expect(line).toHaveCount(1, { timeout: 15_000 })
    await expect(line).toContainText('production would refuse a query answered here')
    await page.goto(`${engine.origin}/console/logs?q=kind%3Afirestore.indexes.reloaded`)
    const markers = page.getByTestId('log-marker-line')
    await expect(markers.filter({ hasText: 'from the console (1 added)' })).toHaveCount(1, {
      timeout: 15_000,
    })
    await expect(markers.filter({ hasText: 'from the console (1 removed)' })).toHaveCount(1)
    await expect(markers.filter({ hasText: 'indexes reloaded from' })).toHaveCount(1)
  },
)

dedicated(
  'with --strict-indexes the query is refused as production refuses it, and Add all lets it through',
  async ({ page, dedicatedEngine }) => {
    const engine = await dedicatedEngine('data', { args: ['--strict-indexes'] })
    const refused = await appQuery(engine, ORDERS_BY_TOTAL)
    expect(refused.status).toBe(400)
    const body = (await refused.json()) as Array<{ error?: { status: string; message: string } }>
    const error = Array.isArray(body) ? body.find((item) => item.error)?.error : undefined
    expect(error?.status ?? (body as unknown as { error: { status: string } }).error.status).toBe(
      'FAILED_PRECONDITION',
    )
    // The declared index's query is answered.
    expect((await appQuery(engine, USERS_BY_LAST_SEEN)).status).toBe(200)

    await page.goto(`${engine.origin}/console/firestore/indexes`)
    await expect(page.getByTestId('missing-indexes-headline')).toHaveText(
      'Your app ran a query whose index is not in firestore.indexes.json, so it failed, as it would in production. Add the index to let it run.',
      { timeout: 15_000 },
    )
    await expect(page.getByTestId('indexes-file')).toContainText('Started with --strict-indexes')
    await expect(page.getByTestId('missing-index')).toHaveCount(1)

    // Added, the query is let through with no restart.
    await page.getByTestId('add-missing-all').click()
    await expect(page.getByTestId('missing-index')).toHaveAttribute('data-declared', 'true')
    expect((await appQuery(engine, ORDERS_BY_TOTAL)).status).toBe(200)
  },
)
