import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Engine, dedicated, expect } from './fixtures'
import { readClipboard, ticked } from './support/clipboard'

// The indexes production would refuse the app's queries for. Each journey
// starts its own engine: what one leaves in the engine's list would put a
// toolbar button in front of the other Firestore journeys. The `data`
// profile's index file declares one composite index on `users`, so a query
// it serves is never listed and one on `orders` is.

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

/** The index file with the composite index the project already declares, plus `added`. */
function writeIndexes(engine: Engine, added: object[]) {
  const path = join(engine.directory, 'firestore.indexes.json')
  const file = JSON.parse(readFileSync(path, 'utf8')) as { indexes: object[] }
  writeFileSync(path, JSON.stringify({ ...file, indexes: [...file.indexes, ...added] }, null, 2))
}

dedicated(
  'a query production would refuse is listed live with its entry, and a saved file declares it at once',
  async ({ page, dedicatedEngine, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    const engine = await dedicatedEngine('data')
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
    await expect(page.getByTestId('nav-badge-firestore-data')).toContainText('1')

    await button.click()
    await expect(page).toHaveURL(/[?&]indexes=true/)
    const panel = page.getByTestId('missing-indexes')
    await expect(panel.getByTestId('missing-indexes-headline')).toHaveText(
      'Production would refuse these queries: firestore.indexes.json does not declare their indexes. The emulator answers them.',
    )
    const row = panel.getByTestId('missing-index')
    await expect(row).toHaveCount(1)
    await expect(row).toHaveAttribute('data-declared', 'false')
    await expect(row).toContainText('orders')
    await expect(row).toContainText('status')
    await expect(row).toContainText('total')
    await expect(row.getByTestId('missing-index-query')).toHaveText(
      'where("status", "==", …).orderBy("total", "desc")',
    )
    await expect(row).toContainText('on orders, 1 query')
    await expect(button).toHaveClass(/bg-kumo-tint/)

    // Counts follow, at most every two seconds.
    for (let index = 0; index < 2; index += 1)
      expect((await appQuery(engine, ORDERS_BY_TOTAL)).status).toBe(200)
    await expect(row).toContainText('on orders, 3 queries, the latest', { timeout: 10_000 })

    // What it copies is the entry to add, and every one at once as a file.
    const copyEntry = row.getByTestId('copy-missing-entry')
    await copyEntry.click()
    await ticked(copyEntry)
    expect(JSON.parse(await readClipboard(page))).toEqual(ENTRY)
    const copyAll = panel.getByTestId('copy-missing-file')
    await copyAll.click()
    await ticked(copyAll)
    expect(JSON.parse(await readClipboard(page))).toEqual({ indexes: [ENTRY], fieldOverrides: [] })

    // The panel is a link.
    await page.reload()
    await expect(page.getByTestId('missing-index')).toHaveCount(1, { timeout: 15_000 })

    // Saving the index file puts it in force at once: the row turns to
    // declared, the count goes, and nothing needs a restart.
    writeIndexes(engine, [ENTRY])
    await expect(page.getByTestId('missing-index')).toHaveAttribute('data-declared', 'true', {
      timeout: 15_000,
    })
    await expect(page.getByTestId('missing-index')).toContainText('Declared now')
    await expect(page.getByTestId('missing-indexes-headline')).toHaveText(
      "firestore.indexes.json declares every index the app's queries needed.",
    )
    await expect(button).toHaveAttribute('data-missing', '0')
    await expect(page.getByTestId('nav-badge-firestore-data')).toHaveCount(0)

    // A file that is not valid keeps the indexes in force and says why.
    writeFileSync(join(engine.directory, 'firestore.indexes.json'), '{"indexes": [')
    await expect(page.getByTestId('missing-indexes-file-problem')).toContainText(
      'firestore.indexes.json is not valid: invalid index JSON',
      { timeout: 15_000 },
    )
    await expect(page.getByTestId('missing-index')).toHaveAttribute('data-declared', 'true')

    // The warning is a line of the log, a problem of its own kind.
    await page.goto(`${engine.origin}/console/logs?q=kind%3Afirestore.index.missing`)
    const line = page.getByTestId('log-row')
    await expect(line).toHaveCount(1, { timeout: 15_000 })
    await expect(line).toContainText('production would refuse a query answered here')
  },
)

dedicated(
  'with --strict-indexes the query is refused as production refuses it, and the panel says so',
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

    await page.goto(`${engine.origin}/console/firestore?indexes=true`)
    await expect(page.getByTestId('missing-indexes-headline')).toHaveText(
      '--strict-indexes refuses these queries, as production does, until firestore.indexes.json declares their indexes.',
      { timeout: 15_000 },
    )
    await expect(page.getByTestId('missing-index')).toHaveCount(1)

    // Saved, the file lets the query through with no restart.
    writeIndexes(engine, [ENTRY])
    await expect(page.getByTestId('missing-index')).toHaveAttribute('data-declared', 'true', {
      timeout: 15_000,
    })
    expect((await appQuery(engine, ORDERS_BY_TOTAL)).status).toBe(200)
  },
)
