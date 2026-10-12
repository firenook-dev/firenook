import type { Locator, Page, Request } from '@playwright/test'
import { type Engine, expect, test } from './fixtures'
import { ownerFetch } from './support/api'
import { readClipboard } from './support/clipboard'
import { dropLive, restoreLive } from './support/live'
import { cutRings, paintOf, paintedAtItsOwnCentre } from './support/look'
import { documentsOf } from './support/shell'
import {
  PAGE_LIMIT,
  asParam,
  bucketsOf,
  folderFigures,
  getMetadata,
  ownerJson,
  person,
  putFile,
  removeFile,
  resetToSeed,
  seed,
  tokenFor,
  upload,
} from './support/storage'

// The Storage Files page against the real engine and the storage profile:
// two buckets the seeder filled (scripts/seed/storage.mjs) and the per-bucket
// rules of scripts/fixtures/storage.mjs. Every count is the seed manifest's
// (`seed`) or follows from the page limit; a journey that adds or removes
// files does it in places no other journey counts, and puts back what it
// changed.

test.beforeAll(async ({ engine }) => {
  await resetToSeed(engine)
})

/** The Files page at a view, once its listing (or the state standing in for it) has painted. */
async function openFiles(page: Page, engine: Engine, search: Record<string, string> = {}) {
  const query = new URLSearchParams(search).toString()
  await page.goto(`${engine.origin}/console/storage${query ? `?${query}` : ''}`)
  await expect(page.getByTestId('storage-toolbar')).toBeVisible()
}

const list = (page: Page) => page.getByTestId('file-list')
const rows = (page: Page) => list(page).getByTestId('data-row')
/** A row by its key: a file's full name or a folder's prefix. */
const row = (page: Page, key: string) =>
  list(page).locator(`tr[data-key="${key.replaceAll('"', '\\"')}"]`)
const count = (page: Page) => page.getByTestId('listing-count')
const treeNode = (page: Page, prefix: string) =>
  page.getByTestId('folder-tree').locator(`[data-node-id="${prefix.replaceAll('"', '\\"')}"]`)

/** What the journeys read of an object's record (`StorageObjectDetail`). */
interface ObjectDetail {
  generation: string
  contentType: string | null
  cacheControl: string | null
  customMetadata: Record<string, string>
  downloadTokens: string[]
}

/** The DOM of a picture or a sound, as `evaluate` hands it over (this file is typed for Node). */
type Media = { naturalWidth: number; complete: boolean; duration: number }

/** An object's record, as the console's own route answers the owner. */
const objectOf = (engine: Engine, bucket: string, name: string) =>
  ownerJson<ObjectDetail>(
    engine,
    `/storage/object?bucket=${encodeURIComponent(bucket)}&name=${encodeURIComponent(name)}`,
  )

/** Which of `names` the bucket holds (`POST /storage/objects:exists`), sorted. */
async function existing(
  engine: Engine,
  bucket: string,
  names: readonly string[],
): Promise<string[]> {
  const answer = await ownerJson<{ existing: string[] }>(engine, '/storage/objects:exists', {
    method: 'POST',
    body: JSON.stringify({ bucket, names }),
  })
  return answer.existing.toSorted()
}

/** An object's bytes as text, through the console's media route. */
async function mediaText(engine: Engine, bucket: string, name: string): Promise<string> {
  const response = await ownerFetch(
    engine,
    `/storage/object/media?bucket=${encodeURIComponent(bucket)}&name=${encodeURIComponent(name)}`,
  )
  expect(response.ok).toBe(true)
  return response.text()
}

const inspector = (page: Page) => page.getByTestId('file-inspector')
/** One of the inspector's own tabs (the event payloads below have tabs of their own). */
const inspectorTab = (page: Page, name: string) =>
  inspector(page)
    .getByRole('tablist')
    .first()
    .getByRole('tab', { name: new RegExp(`^${name}`) })

/** A picture the page asked for: a thumbnail or an image from the media route. */
function isPicture(request: Request): boolean {
  const path = new URL(request.url()).pathname
  return path.endsWith('/storage/object/thumbnail') || path.endsWith('/storage/object/media')
}

/** The folder a name is in: `users/u1/` for `users/u1/a.png`. */
const parentPath = (name: string) => name.slice(0, name.lastIndexOf('/') + 1)

/** `1,201` as the console writes numbers. */
const figure = (value: number) => value.toLocaleString('en-US')

/** The console API's list requests for one folder of a bucket, as the page sends them. */
function listRequests(page: Page, prefix: string) {
  const seen: Request[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (
      request.method() === 'GET' &&
      url.pathname.endsWith('/console/api/v1/storage/objects') &&
      (url.searchParams.get('prefix') ?? '') === prefix &&
      url.searchParams.get('kind') !== 'folders'
    )
      seen.push(request)
  })
  return seen
}

/** The search params of the page's address. */
const searchOf = (page: Page) => new URL(page.url()).searchParams

/** Scrolls a virtual list to its end until `done` holds, as a reader keeps scrolling. */
async function scrollUntil(scroller: Locator, done: () => Promise<boolean>) {
  await expect
    .poll(
      async () => {
        await scroller.evaluate((element) => {
          element.scrollTop = element.scrollHeight
        })
        return done()
      },
      { timeout: 30_000, intervals: [100, 200, 300] },
    )
    .toBe(true)
}

test('the Files page opens on the default bucket, its folders and both buckets’ figures', async ({
  page,
  engine,
}) => {
  const buckets = bucketsOf(engine)
  await openFiles(page, engine)

  const nav = page.getByTestId('primary-nav')
  await expect(nav.getByTestId('nav-page-files')).toHaveAttribute('data-active', 'true')
  const rulesPage = nav.locator('[data-testid="nav-page-rules"][href$="/console/storage/rules"]')
  await expect(rulesPage).toBeVisible()
  await expect(rulesPage).not.toHaveAttribute('data-active', 'true')

  // The root holds only folders, so the count names folders.
  await expect(count(page)).toHaveText(`${figure(seed.default.rootFolders)} folders`)
  await expect(rows(page)).toHaveCount(seed.default.rootFolders)
  await expect(treeNode(page, '')).toContainText(figure(seed.default.files))
  await expect(treeNode(page, '')).toHaveAttribute('aria-current', 'location')

  // Both buckets, each with its figures, the default one marked.
  await page.getByTestId('bucket-picker').getByRole('combobox').click()
  const main = page.getByRole('option', { name: new RegExp(buckets.default) })
  const media = page.getByRole('option', { name: new RegExp(buckets.media) })
  await expect(main).toContainText(`default · ${figure(seed.default.files)} ·`)
  await expect(media).toContainText(`${figure(seed.media.files)} ·`)
  await page.keyboard.press('Escape')
})

test('folders open on Enter, a double click or a link, and the path goes back up', async ({
  page,
  engine,
  context,
}) => {
  const buckets = bucketsOf(engine)
  await openFiles(page, engine)

  // A click on a folder row moves the cursor, and goes nowhere.
  await row(page, 'public/').locator('td').nth(2).click()
  await expect(row(page, 'public/')).toHaveAttribute('data-cursor', '')
  expect(searchOf(page).get('path')).toBeNull()
  // Enter goes in.
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/path=public%2F/)
  await expect(row(page, 'public/docs/')).toBeVisible()
  await expect(treeNode(page, 'public/')).toHaveAttribute('aria-current', 'location')

  // A double click goes in too; a segment of the path goes back up.
  await row(page, 'public/docs/').locator('td').nth(2).dblclick()
  await expect(page).toHaveURL(/path=public%2Fdocs%2F/)
  await expect(row(page, seed.names.readme)).toBeVisible()
  await page
    .getByTestId('path-segment')
    .filter({ hasText: /^public$/ })
    .click()
  await expect(page).toHaveURL(/path=public%2F$/)
  await page.getByTestId('path-segment').first().click()
  await expect(page).not.toHaveURL(/path=/)

  // The folder's name is a real link: ⌘-click opens a new page there.
  const opened = context.waitForEvent('page')
  await row(page, 'reports/')
    .getByTestId('folder-link')
    .click({ modifiers: ['ControlOrMeta'] })
  const other = await opened
  await other.waitForLoadState()
  expect(new URL(other.url()).searchParams.get('path')).toBe('reports/')
  await expect(
    other.getByTestId('file-list').locator(`tr[data-key="${seed.names.pdf}"]`),
  ).toBeVisible()
  await other.close()
  // This page stayed where it was.
  expect(searchOf(page).get('path')).toBeNull()

  // ⌘L: the path as text, completed from the engine.
  await page.keyboard.press('ControlOrMeta+l')
  const input = page.getByTestId('path-input')
  await expect(input).toBeFocused()
  await input.fill(`gs://${buckets.default}/pub`)
  await expect(page.getByTestId('path-completion').first()).toHaveText('public/')
  await input.press('Tab')
  await expect(input).toHaveValue(`gs://${buckets.default}/public/`)
  await input.press('Enter')
  await expect(page).toHaveURL(/path=public%2F$/)

  // A download URL an app was handed lands on the file, in its folder.
  const downloadUrl = `http://127.0.0.1:${engine.ports.storage}/v0/b/${buckets.default}/o/${encodeURIComponent(seed.names.avatar)}?alt=media&token=a1b2c3`
  await page.keyboard.press('ControlOrMeta+l')
  await page.evaluate(
    (text) =>
      (
        navigator as Navigator & { clipboard: { writeText(value: string): Promise<void> } }
      ).clipboard.writeText(text),
    downloadUrl,
  )
  await page.keyboard.press('ControlOrMeta+v')
  await expect(page).toHaveURL(new RegExp(`path=users%2F${seed.users.ada}%2F`))
  expect(searchOf(page).get('object')).toBe(seed.names.avatar)
  await expect(page.getByTestId('file-inspector')).toBeVisible()

  // An empty segment is a folder of its own, said as (empty), never collapsed.
  await openFiles(page, engine, { path: 'misc//' })
  await expect(page.getByTestId('path-segment').last()).toHaveText('(empty)')
  await expect(row(page, seed.names.double)).toBeVisible()
  await openFiles(page, engine)
  await row(page, '/').locator('td').nth(2).dblclick()
  await expect(row(page, seed.names.lead)).toBeVisible()
})

test('a folder of more than a thousand files pages as it scrolls, every one once', async ({
  page,
  engine,
}) => {
  const total = seed.counts['exports/'] ?? 0
  expect(total).toBeGreaterThan(10 * PAGE_LIMIT)
  const requests = listRequests(page, 'exports/')
  const names = new Set<string>()
  let listed = 0
  page.on('response', async (response) => {
    if (!requests.includes(response.request())) return
    const body = (await response.json()) as {
      items: Array<{ type: string; name?: string; prefix?: string }>
    }
    for (const item of body.items) {
      listed += 1
      names.add(item.name ?? item.prefix ?? '')
    }
  })
  await openFiles(page, engine, { path: 'exports/' })
  await expect(count(page)).toHaveText(new RegExp(`^${figure(total)} files · `))
  await expect(rows(page).first()).toBeVisible()
  expect(await rows(page).count()).toBeLessThan(80)

  const footer = page.getByTestId('table-footer-text')
  await scrollUntil(page.getByTestId('file-list-scroll'), async () =>
    /^[\d,]+ loaded$/.test((await footer.textContent()) ?? ''),
  )
  await expect(footer).toHaveText(`${figure(total)} loaded`)
  // Every entry once, in as many pages as the limit makes.
  await expect.poll(() => listed).toBe(total)
  expect(names.size).toBe(total)
  expect(requests).toHaveLength(Math.ceil(total / PAGE_LIMIT))
  // Still a window: never every row in the page.
  expect(await rows(page).count()).toBeLessThan(80)
  await expect(row(page, 'exports/export-1199.csv')).toBeVisible()

  // Home: back to the first row.
  await rows(page).last().click()
  await page.keyboard.press('Home')
  await expect(row(page, seed.names.zip)).toBeVisible()
  await expect(row(page, seed.names.zip)).toHaveAttribute('data-cursor', '')
})

test('a listing sorts and filters in the engine, and a sorted view says when it is behind', async ({
  page,
  engine,
}) => {
  const { default: bucket } = bucketsOf(engine)
  const larger = {
    bucket,
    name: 'public/data/zz-larger.csv',
    size: seed.largest.size + 1024,
    contentType: 'text/csv',
  }
  expect(seed.largest.name.startsWith('public/data/')).toBe(true)
  await openFiles(page, engine, { path: 'public/data/' })

  // Size, largest first: the order is the engine's and the address says it.
  const size = list(page).getByRole('columnheader', { name: /Size/ })
  await size.getByTestId('sort-header').click()
  if ((await size.getAttribute('aria-sort')) !== 'descending')
    await size.getByTestId('sort-header').click()
  await expect(size).toHaveAttribute('aria-sort', 'descending')
  await expect(page).toHaveURL(/sort=size%3Adesc/)
  await expect(rows(page).first()).toHaveAttribute('data-key', seed.largest.name)

  // A file larger still arrives from outside: counted, not slotted in, until Refresh.
  try {
    await putFile(engine, larger)
    await expect(page.getByTestId('listing-count-refresh')).toHaveText('1 change · Refresh')
    await expect(rows(page).first()).toHaveAttribute('data-key', seed.largest.name)
    await page.getByTestId('listing-count-refresh').click()
    await expect(rows(page).first()).toHaveAttribute('data-key', larger.name)
    await expect(page.getByTestId('listing-count-refresh')).toHaveCount(0)
  } finally {
    await removeFile(engine, larger)
  }

  // A filter on the type, in a folder of CSVs: every match counted.
  await openFiles(page, engine, { path: 'exports/' })
  await expect(count(page)).toHaveText(
    new RegExp(`^${figure(seed.counts['exports/'] ?? 0)} files · `),
  )
  await page.keyboard.press('f')
  const filter = page.getByTestId('storage-filter-input')
  await expect(filter).toBeFocused()
  await filter.fill('type:text/csv')
  await expect(count(page)).toHaveText(new RegExp(`^${figure(seed.csvCount)} matching · `))
  await expect(page).toHaveURL(/q=type%3Atext%2Fcsv/)

  // Everything under public/: nested files by their names from here; a size filter.
  await openFiles(page, engine, { path: 'public/' })
  await page.keyboard.press('g')
  await expect(page).toHaveURL(/flat=true/)
  await expect(page.getByTestId('scope-picker')).toContainText('Everything under it')
  await expect(row(page, seed.names.bigCsv)).toContainText('data/big.csv')
  await expect(list(page).locator('tr[data-key$="/"]')).toHaveCount(0)
  await page.getByTestId('storage-filter-input').fill('size:>1MB')
  await expect(count(page)).toHaveText(/^1 matching · /)
  await expect(rows(page)).toHaveCount(1)
  await expect(rows(page).first()).toHaveAttribute('data-key', seed.names.bigCsv)

  // A filter the grammar refuses says why, naming Storage's keys, once the
  // caret leaves it (Escape leaves the field); the list never keeps the last
  // good rows under it. Clearing it brings them back.
  const input = page.getByTestId('storage-filter-input')
  await input.fill('foo:bar')
  await input.press('Escape')
  await expect(input).not.toBeFocused()
  await expect(page.getByTestId('storage-filter-box')).toHaveAttribute('data-invalid', 'true')
  const error = page.getByTestId('storage-filter-error')
  for (const key of ['name', 'type', 'size', 'updated', 'created', 'meta', 'has'])
    await expect(error).toContainText(key)
  await expect(page.getByTestId('query-error')).toBeVisible()
  await expect(rows(page)).toHaveCount(0)
  await page.getByTestId('storage-filter-clear').click()
  await expect(input).toHaveValue('')
  await expect(page.getByTestId('storage-filter-box')).not.toHaveAttribute('data-invalid', 'true')
  await expect(page).not.toHaveURL(/q=/)
  await expect(row(page, seed.names.bigCsv)).toBeVisible()
})

test('the grid draws a picture only for the tiles in view, three at a time', async ({
  page,
  engine,
}) => {
  const { media } = bucketsOf(engine)
  const thumbnails = new Set<string>()
  const pictures = new Set<string>()
  let inFlight = 0
  let most = 0
  page.on('request', (request) => {
    if (!isPicture(request)) return
    const url = new URL(request.url())
    if (url.pathname.endsWith('/thumbnail')) thumbnails.add(url.searchParams.get('name') ?? '')
    pictures.add(url.searchParams.get('name') ?? '')
    inFlight += 1
    most = Math.max(most, inFlight)
  })
  const settle = (request: Request) => {
    if (isPicture(request)) inFlight -= 1
  }
  page.on('requestfinished', settle)
  page.on('requestfailed', settle)

  // The list draws icons: it never asks for a picture.
  await openFiles(page, engine, { bucket: media, path: 'banners/' })
  await expect(row(page, 'banners/banner-01.png')).toBeVisible()
  expect(pictures.size).toBe(0)

  await page.keyboard.press('v')
  await expect(page).toHaveURL(/layout=grid/)
  const grid = page.getByTestId('file-grid-scroll')
  const tiles = page.getByTestId('file-tile')
  await expect(tiles.first()).toBeVisible()
  // Every tile in view gets its picture.
  const inView = () =>
    grid.evaluate((element) => {
      const box = element.getBoundingClientRect()
      const shown = [...element.querySelectorAll('[data-testid="file-tile"]')].filter((tile) => {
        const at = tile.getBoundingClientRect()
        return at.bottom > box.top && at.top < box.bottom
      })
      const firstTop = shown[0]?.getBoundingClientRect().top
      return {
        keys: shown.map((tile) => tile.getAttribute('data-key') ?? ''),
        perRow: shown.filter((tile) => tile.getBoundingClientRect().top === firstTop).length,
      }
    })
  const visible = await inView()
  expect(visible.keys.length).toBeLessThan(seed.media.banners)
  await expect
    .poll(async () => {
      const loaded = await tiles
        .getByTestId('tile-image')
        .evaluateAll((images) =>
          (images as unknown as Media[]).filter(
            (image) => image.complete && image.naturalWidth > 0,
          ),
        )
      return loaded.length
    })
    .toBeGreaterThanOrEqual(visible.keys.length)
  for (const key of visible.keys) expect(thumbnails.has(key)).toBe(true)
  // Only those in view and the row after them; never more than three at once.
  expect(thumbnails.size).toBeLessThanOrEqual(visible.keys.length + visible.perRow)
  expect(most).toBeGreaterThan(0)
  expect(most).toBeLessThanOrEqual(3)
  // A thumbnail is small: the engine scaled it.
  const width = await tiles
    .first()
    .getByTestId('tile-image')
    .evaluate((image) => (image as unknown as Media).naturalWidth)
  expect(width).toBeGreaterThan(0)
  expect(width).toBeLessThanOrEqual(320)

  // A small image and an SVG come from the media route as they are; JSON has its icon.
  await openFiles(page, engine, { path: 'public/', layout: 'grid' })
  for (const name of [seed.names.logo, seed.names.logoSvg]) {
    const image = page
      .locator(`[data-testid="file-tile"][data-key="${name}"]`)
      .getByTestId('tile-image')
    await expect(image).toHaveAttribute('src', /\/console\/api\/v1\/storage\/object\/media\?/)
    await expect
      .poll(() => image.evaluate((element) => (element as unknown as Media).naturalWidth))
      .toBeGreaterThan(0)
  }
  await openFiles(page, engine, { path: 'public/data/', layout: 'grid' })
  const json = page.locator(`[data-testid="file-tile"][data-key="${seed.names.products}"]`)
  await expect(json).toContainText('json')
  await expect(json.getByTestId('tile-image')).toHaveCount(0)
  await expect(json.locator('svg').first()).toBeVisible()

  // Ticking a tile: the selection bar.
  await json.hover()
  await json.getByRole('checkbox').click()
  await expect(page.getByTestId('selection-count')).toContainText('1')
  await page.getByTestId('clear-selection').click()
  await expect(page.getByTestId('selection-count')).toHaveCount(0)
})

test('an image opens in the inspector with its bytes, where it lives and its tokens', async ({
  page,
  engine,
  context,
}) => {
  const { default: bucket } = bucketsOf(engine)
  const avatar = seed.names.avatar
  const size = seed.sizes[avatar] ?? 0
  await openFiles(page, engine, { path: `users/${seed.users.ada}/` })
  await row(page, avatar).click()
  await expect(page).toHaveURL(new RegExp(`object=${encodeURIComponent(avatar)}`))
  const panel = inspector(page)
  const image = panel.getByTestId('preview-image')
  await expect
    .poll(() => image.evaluate((element) => (element as unknown as Media).naturalWidth))
    .toBeGreaterThan(0)
  await expect(panel.getByTestId('fact-size')).toContainText(`${figure(size)} bytes`)

  // gs:// and the path, copied.
  await panel.getByTestId('location-gs').hover()
  await panel.getByTestId('location-gs-copy').click()
  await expect.poll(() => readClipboard(page)).toBe(`gs://${bucket}/${avatar}`)
  // The row is still the cursor: ⌥⌘C copies its path.
  await page.keyboard.press('Alt+ControlOrMeta+c')
  await expect.poll(() => readClipboard(page)).toBe(avatar)

  // The URL an app gets, said as such, with its token.
  const download = panel.getByTestId('location-download')
  await expect(download).toContainText('For an app connected to')
  await expect(download).toContainText('token=')

  // Open in a new tab: the console's own media route, same origin.
  const opened = context.waitForEvent('page')
  await row(page, avatar).getByTestId('row-menu-button').click()
  await page.getByTestId('row-menu-open-tab').click()
  const tab = await opened
  await tab.waitForLoadState()
  const url = new URL(tab.url())
  expect(url.origin).toBe(engine.origin)
  expect(url.pathname).toBe('/console/api/v1/storage/object/media')
  expect(url.searchParams.get('name')).toBe(avatar)
  await tab.close()

  // Tokens: hidden until shown; one more, then one fewer.
  const tokens = panel.getByTestId('token-row')
  await expect(tokens).toHaveCount(1)
  await expect(tokens.first().getByTestId('token-value-masked')).toContainText('••••')
  await tokens.first().getByRole('button', { name: 'Show the token' }).click()
  await expect(tokens.first().getByTestId('token-value-value')).toHaveText(/^[0-9a-f-]{36}$/)
  await panel.getByTestId('token-create').hover()
  await expect(page.locator('.kumo-tooltip-popup')).toContainText('onMetadataUpdated')
  await panel.getByTestId('token-create').click()
  await expect(tokens).toHaveCount(2)
  expect((await objectOf(engine, bucket, avatar)).downloadTokens).toHaveLength(2)
  // The toast says so, over the panel's corner, and goes once the pointer leaves it.
  const created = page.getByText('Token created', { exact: true })
  await expect(created).toBeVisible()
  await page.mouse.move(0, 0)
  await expect(created).toHaveCount(0, { timeout: 15_000 })
  await tokens.last().getByTestId('token-revoke').click()
  await expect(tokens).toHaveCount(1)
  expect((await objectOf(engine, bucket, avatar)).downloadTokens).toHaveLength(1)

  // The inspector's width is the reader's, remembered under its own key.
  const grip = page.getByTestId('file-inspector-resize')
  const box = (await grip.boundingBox())!
  const before = Math.round((await panel.boundingBox())!.width)
  await page.mouse.move(box.x + box.width / 2, box.y + 200)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 - 30, box.y + 200, { steps: 8 })
  await page.mouse.up()
  const dragged = Math.round((await panel.boundingBox())!.width)
  expect(Math.abs(dragged - before - 30)).toBeLessThan(4)
  expect(
    await page.evaluate(() =>
      localStorage.getItem('firenook.console.inspector-width.storage.object'),
    ),
  ).toBe(String(dragged))
  await page.reload()
  await expect(panel.getByTestId('fact-size')).toBeVisible()
  expect(Math.round((await panel.boundingBox())!.width)).toBe(dragged)

  // As Ada, the tokens are Admin's.
  await openFiles(page, engine, {
    path: `users/${seed.users.ada}/`,
    object: avatar,
    as: decodeURIComponent(asParam(person('ada'))),
  })
  await expect(panel.getByTestId('tokens-admin-only')).toContainText(
    'Only Admin can see and manage download tokens',
  )
  await expect(panel.getByTestId('token-row')).toHaveCount(0)
})

test('each kind of file previews as what it is, and a wrong content type is fixed in place', async ({
  page,
  engine,
}) => {
  const { default: bucket } = bucketsOf(engine)
  const open = async (name: string) => {
    const at = name.lastIndexOf('/')
    await openFiles(page, engine, { path: name.slice(0, at + 1), object: name })
    await expect(inspector(page).getByTestId('fact-size')).toBeVisible()
  }
  const panel = inspector(page)

  // JSON as text and as a tree; its declared type is right, so no warning.
  await open(seed.names.products)
  await expect(panel.getByTestId('preview-text')).toContainText('"products"')
  await panel.getByRole('tab', { name: 'Tree' }).click()
  await expect(panel.getByTestId('preview-json-tree')).toContainText('products')
  await expect(panel.getByTestId('type-mismatch')).toHaveCount(0)

  // Markdown as text; a CSV as a table.
  await open(seed.names.readme)
  await expect(panel.getByTestId('preview-text')).toContainText('# Readme')
  await open(seed.names.bigCsv)
  await expect(panel.getByTestId('preview-csv-row').first()).toBeVisible()
  await expect(panel.getByTestId('preview-csv')).toContainText('quoted')

  // A PDF in the browser's own viewer, from the console's origin.
  await open(seed.names.pdf)
  const frame = panel.getByTestId('preview-pdf')
  await expect(frame).toBeVisible()
  const src = (await frame.getAttribute('src')) ?? ''
  expect(src).toContain('/console/api/v1/storage/object/media')
  const pdf = await ownerFetch(engine, src.replace(/^.*\/console\//, '/console/'))
  expect(pdf.headers.get('content-type')).toBe('application/pdf')

  // Sound plays: the browser reads its length.
  await open(seed.names.tone)
  await expect
    .poll(() =>
      panel
        .getByTestId('preview-audio')
        .evaluate((element) => (element as unknown as Media).duration),
    )
    .toBeGreaterThan(0)

  // A zip lists its entries; bytes show as hex.
  await open(seed.names.zip)
  await expect(panel.getByTestId('archive-entry')).toHaveCount(2)
  await expect(panel.getByTestId('preview-archive')).toContainText('readme.md')
  await open(seed.names.blob)
  await expect(panel.getByTestId('hex-row').first()).toBeVisible()

  // PNG bytes stored as octet-stream: the band says so, and one click fixes it.
  await open(seed.names.mislabelled)
  const band = panel.getByTestId('type-mismatch')
  await expect(band).toContainText('application/octet-stream')
  await panel.getByTestId('type-mismatch-fix').click()
  await expect(band).toHaveCount(0)
  await expect(row(page, seed.names.mislabelled)).toContainText('image/png')
  expect((await objectOf(engine, bucket, seed.names.mislabelled)).contentType).toBe('image/png')
  try {
    // A .docx is a zip, and says so: no band.
    await open(seed.names.report)
    await expect(panel.getByTestId('type-mismatch')).toHaveCount(0)

    // gzip-encoded JSON previews decoded, and cannot be edited as text.
    await open(seed.names.events)
    await expect(panel.getByTestId('preview-text')).toContainText('click')
    await expect(panel.getByTestId('preview-text-extent')).toContainText('Stored gzip-encoded')
    const edit = panel.getByTestId('preview-edit')
    await expect(edit).toBeDisabled()
    await edit.locator('xpath=..').hover()
    await expect(page.locator('.kumo-tooltip-popup')).toContainText(/gzip/i)
  } finally {
    const response = await ownerFetch(engine, '/storage/object/metadata', {
      method: 'POST',
      body: JSON.stringify({
        bucket,
        name: seed.names.mislabelled,
        metadata: { contentType: 'application/octet-stream' },
      }),
    })
    expect(response.ok).toBe(true)
  }
})

test('metadata is one draft: changes counted, saved together, and a newer version offered', async ({
  page,
  engine,
}) => {
  const { default: bucket } = bucketsOf(engine)
  const name = seed.names.graceAvatar
  await openFiles(page, engine, {
    path: `users/${seed.users.grace}/`,
    object: name,
    tab: 'metadata',
  })
  const panel = inspector(page)
  await expect(panel.getByTestId('metadata-tab')).toBeVisible()
  const cache = panel.getByTestId('field-cacheControl').getByRole('combobox')
  await cache.fill('public, max-age=600')
  await page.keyboard.press('Escape')
  const custom = panel.getByTestId('custom-metadata')
  await custom.getByTestId('custom-metadata-add-key').pressSequentially('source')
  await custom.getByTestId('custom-metadata-value').last().fill('camera')
  await custom
    .getByTestId('custom-metadata-row')
    .filter({ has: page.locator('input[value="ownerUid"]') })
    .getByTestId('custom-metadata-remove')
    .click()
  const save = panel.getByTestId('inspector-save')
  await expect(save).toHaveText('Save 3')
  await save.click()
  await expect(page.getByText(/^Saved the metadata of avatar\.png$/)).toBeVisible()
  await expect(save).toHaveText('Save')
  const saved = await objectOf(engine, bucket, name)
  expect(saved.cacheControl).toBe('public, max-age=600')
  expect(saved.customMetadata).toEqual({ source: 'camera' })

  // The change is in the file's activity.
  await inspectorTab(page, 'Activity').click()
  await expect(panel.getByTestId('activity-change').first()).toHaveAttribute(
    'data-kind',
    'metadata',
  )

  // Another hand changes it while a draft is open: the band offers the new version.
  await inspectorTab(page, 'Metadata').click()
  await cache.fill('no-cache')
  const response = await ownerFetch(engine, '/storage/object/metadata', {
    method: 'POST',
    body: JSON.stringify({ bucket, name, metadata: { cacheControl: 'private, max-age=60' } }),
  })
  expect(response.ok).toBe(true)
  await expect(panel.getByTestId('changed-underneath')).toBeVisible()
  await panel.getByTestId('load-new-version').click()
  await expect(cache).toHaveValue('private, max-age=60')
  await expect(save).toHaveText('Save')
})

test('a text file is edited in place and saved as a new generation', async ({ page, engine }) => {
  const { default: bucket } = bucketsOf(engine)
  const name = seed.names.readme
  const before = await objectOf(engine, bucket, name)
  await openFiles(page, engine, { path: 'public/docs/', object: name })
  const panel = inspector(page)
  await panel.getByTestId('preview-edit').click()
  const editor = panel.getByTestId('preview-text')
  await expect(editor).toHaveAttribute('contenteditable', 'true')
  await editor.click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type('\nEdited in the console.')
  const save = panel.getByTestId('inspector-save')
  await expect(save).toHaveText('Save 1')
  await save.click()
  await expect(page.getByText(/^Saved readme\.md$/)).toBeVisible()
  const text = await mediaText(engine, bucket, name)
  expect(text.endsWith('Edited in the console.')).toBe(true)
  const after = await objectOf(engine, bucket, name)
  expect(after.generation).not.toBe(before.generation)
  expect(after.contentType).toBe(before.contentType)
})

/** A file as the page's file input takes it. */
const pick = (name: string, mimeType = 'image/png', size = 2048) => ({
  name,
  mimeType,
  buffer: Buffer.alloc(size, 9),
})

/** Drops files on an element the way the browser does: dragenter, dragover, drop. */
async function dropFiles(target: Locator, names: readonly string[]) {
  await target.evaluate((element, files) => {
    const browser = globalThis as unknown as {
      DataTransfer: new () => { items: { add(file: unknown): void } }
      File: new (parts: string[], name: string, options: { type: string }) => unknown
      DragEvent: new (type: string, init: object) => unknown
    }
    const transfer = new browser.DataTransfer()
    for (const name of files)
      transfer.items.add(new browser.File([`bytes of ${name}`], name, { type: 'text/plain' }))
    for (const type of ['dragenter', 'dragover', 'drop'])
      element.dispatchEvent(
        new browser.DragEvent(type, {
          bubbles: true,
          cancelable: true,
          dataTransfer: transfer,
        }) as never,
      )
  }, names)
}

/** Slows this page's uploads to `bytesPerSecond` (CDP), or lets them go again. */
async function throttleUploads(page: Page, bytesPerSecond: number | undefined) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Network.enable')
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: bytesPerSecond ?? -1,
  })
}

test('files upload into the folder on screen, ask about names already taken, and keep the tab', async ({
  page,
  engine,
}) => {
  const { default: bucket } = bucketsOf(engine)
  await putFile(engine, { bucket, name: 'inbox/sub/keep.txt', size: 10, contentType: 'text/plain' })
  await openFiles(page, engine, { path: 'inbox/' })
  await expect(row(page, 'inbox/sub/')).toBeVisible()

  // Three files from the picker: the tray, then the rows, arriving live.
  await page
    .getByTestId('upload-input')
    .setInputFiles([pick('a.png'), pick('b.png'), pick('c.png')])
  await expect(page.getByTestId('upload-tray')).toBeVisible()
  await expect(page.getByTestId('tray-summary')).toHaveText('Uploaded 3 files')
  for (const name of ['a.png', 'b.png', 'c.png'])
    await expect(row(page, `inbox/${name}`)).toBeVisible()
  await expect(row(page, 'inbox/a.png')).toHaveClass(/row-flash/)

  // Dropped on a folder's row: into that folder.
  await dropFiles(row(page, 'inbox/sub/').locator('td').nth(2), ['dropped.txt'])
  await expect
    .poll(async () => (await existing(engine, bucket, ['inbox/sub/dropped.txt'])).length)
    .toBe(1)

  // Names already taken: one question. Skip leaves the file as it was and sends the new one.
  const before = await objectOf(engine, bucket, 'inbox/a.png')
  await page.getByTestId('upload-input').setInputFiles([pick('a.png'), pick('d.png')])
  const dialog = page.getByTestId('conflict-dialog')
  await expect(dialog).toContainText('a.png')
  await expect(page.getByTestId('conflict-confirm')).toHaveText('Upload 1')
  await page.getByTestId('conflict-confirm').click()
  await expect(row(page, 'inbox/d.png')).toBeVisible()
  expect((await objectOf(engine, bucket, 'inbox/a.png')).generation).toBe(before.generation)
  // Keep both: a second name beside the first.
  await page.getByTestId('upload-input').setInputFiles([pick('a.png')])
  await expect(page.getByTestId('conflict-confirm')).toHaveText('Nothing to upload')
  await dialog.getByText('Keep both (name (1).png)').click()
  await page.getByTestId('conflict-confirm').click()
  await expect(row(page, 'inbox/a (1).png')).toBeVisible()

  // A pasted image is uploaded here, named for when it was pasted.
  await page.locator('body').evaluate((body) => {
    const browser = globalThis as unknown as {
      DataTransfer: new () => { items: { add(file: unknown): void } }
      File: new (parts: Uint8Array[], name: string, options: { type: string }) => unknown
      ClipboardEvent: new (type: string, init: object) => unknown
    }
    const transfer = new browser.DataTransfer()
    transfer.items.add(
      new browser.File([new Uint8Array([137, 80, 78, 71])], 'image.png', { type: 'image/png' }),
    )
    body.ownerDocument.dispatchEvent(
      new browser.ClipboardEvent('paste', { clipboardData: transfer, bubbles: true }) as never,
    )
  })
  await expect(list(page).locator('tr[data-key^="inbox/pasted-"][data-key$=".png"]')).toHaveCount(1)

  // While bytes are in flight, the Storage item says so from any page, and
  // leaving the tab asks first.
  await throttleUploads(page, 256 * 1024)
  await page
    .getByTestId('upload-input')
    .setInputFiles([pick('slow.bin', 'application/octet-stream', 4 * 1024 * 1024)])
  await expect(page.getByTestId('tray-row').filter({ hasText: 'slow.bin' })).toHaveAttribute(
    'data-state',
    'uploading',
  )
  await page.getByTestId('primary-nav').getByTestId('nav-page-data').click()
  await expect(page).toHaveURL(/\/console\/firestore/)
  await expect(page.getByTestId('nav-badge-storage')).toHaveText('1')
  const asked = page.waitForEvent('dialog')
  void page.close({ runBeforeUnload: true })
  const leave = await asked
  expect(leave.type()).toBe('beforeunload')
  await leave.dismiss()
  expect(page.isClosed()).toBe(false)
  await page.getByTestId('primary-nav').getByTestId('nav-page-files').click()
  await page.getByTestId('tray-cancel-all').click()
  await expect(page.getByTestId('tray-row').filter({ hasText: 'slow.bin' })).toHaveAttribute(
    'data-state',
    'cancelled',
  )
  await expect(page.getByTestId('nav-badge-storage')).toHaveCount(0)
  await throttleUploads(page, undefined)
})

test('a folder uploads with everything in it, and the tree follows', async ({ page, engine }) => {
  const { default: bucket } = bucketsOf(engine)
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const root = mkdtempSync(join(tmpdir(), 'firenook-storage-folder-'))
  const album = join(root, 'album')
  mkdirSync(join(album, 'nested'), { recursive: true })
  writeFileSync(join(album, 'one.txt'), 'one')
  writeFileSync(join(album, 'nested', 'two.txt'), 'two')
  await putFile(engine, { bucket, name: 'folders/readme.txt', size: 4, contentType: 'text/plain' })
  await openFiles(page, engine, { path: 'folders/' })
  await page.getByTestId('upload-folder-input').setInputFiles(album)
  await expect(row(page, 'folders/album/')).toBeVisible()
  await expect
    .poll(async () =>
      existing(engine, bucket, ['folders/album/one.txt', 'folders/album/nested/two.txt']),
    )
    .toEqual(['folders/album/nested/two.txt', 'folders/album/one.txt'])
  await expect(treeNode(page, 'folders/album/')).toBeVisible()
  await expect(treeNode(page, 'folders/album/')).toContainText('2')
})

test('a large upload cancelled half way leaves nothing staged in the engine', async ({
  page,
  engine,
}) => {
  const { default: bucket } = bucketsOf(engine)
  const inFlight = async () => {
    const buckets = await ownerJson<{
      buckets: Array<{ name: string; inFlight: { bytes: number } }>
    }>(engine, '/storage/buckets')
    return buckets.buckets.find((entry) => entry.name === bucket)?.inFlight.bytes ?? -1
  }
  await putFile(engine, { bucket, name: 'large/readme.txt', size: 4, contentType: 'text/plain' })
  await openFiles(page, engine, { path: 'large/' })
  await throttleUploads(page, 1024 * 1024)
  try {
    // 50 MB, written out (a page takes no larger buffer); zeros, so the disk keeps it sparse.
    const { closeSync, openSync, ftruncateSync } = await import('node:fs')
    const big = test.info().outputPath('big.bin')
    const handle = openSync(big, 'w')
    ftruncateSync(handle, 50 * 1024 * 1024)
    closeSync(handle)
    await page.getByTestId('upload-input').setInputFiles(big)
    const item = page.getByTestId('tray-row').filter({ hasText: 'big.bin' })
    await expect(item).toHaveAttribute('data-state', 'uploading')
    await expect(item).toContainText(/[1-9]\d?%/)
    await expect.poll(inFlight).toBeGreaterThan(0)
    await item.getByTestId('tray-cancel').click()
    await expect(item).toHaveAttribute('data-state', 'cancelled')
    await expect(item.getByTestId('tray-row-message')).toHaveText('Cancelled')
    await expect.poll(inFlight).toBe(0)
    expect(await existing(engine, bucket, ['large/big.bin'])).toEqual([])
  } finally {
    await throttleUploads(page, undefined)
  }
})

test('a new folder is made from n or a link, and is empty until something arrives', async ({
  page,
  engine,
}) => {
  await openFiles(page, engine)
  await page.keyboard.press('n')
  await expect(page).toHaveURL(/new=folder/)
  await page.getByTestId('create-folder-name').fill('drafts')
  await page.getByTestId('create-folder-confirm').click()
  await expect(page).not.toHaveURL(/new=/)
  await expect(row(page, 'drafts/')).toBeVisible()
  await expect(row(page, 'drafts/')).toContainText('empty')
  // No nameless row in the parent: the marker is the folder.
  await expect(list(page).locator('tr[data-key=""]')).toHaveCount(0)
  await row(page, 'drafts/').locator('td').nth(2).dblclick()
  await expect(page.getByTestId('folder-empty')).toContainText('This folder is empty')
  await expect(rows(page)).toHaveCount(0)

  // A link opens the same dialog.
  await openFiles(page, engine, { new: 'folder' })
  await expect(page.getByTestId('create-folder-dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page).not.toHaveURL(/new=/)
})

test('rename in place follows the open file; a move runs as a job and asks before replacing', async ({
  page,
  engine,
}) => {
  const { default: bucket } = bucketsOf(engine)
  for (const name of ['one', 'two', 'three', 'four', 'five'])
    await putFile(engine, {
      bucket,
      name: `moving/${name}.txt`,
      size: 16,
      contentType: 'text/plain',
    })
  await putFile(engine, { bucket, name: 'archive/five.txt', size: 8, contentType: 'text/plain' })
  await openFiles(page, engine, { path: 'moving/' })

  // F2 on the open file: renamed where it is, and the address follows.
  await row(page, 'moving/one.txt').click()
  await expect(page).toHaveURL(/object=moving%2Fone\.txt/)
  await page.keyboard.press('F2')
  const input = page.getByTestId('rename-input')
  await expect(input).toBeFocused()
  await input.fill('first.txt')
  await input.press('Enter')
  await expect(row(page, 'moving/first.txt')).toBeVisible()
  await expect(page).toHaveURL(/object=moving%2Ffirst\.txt/)
  await page.keyboard.press('Escape')

  // Three ticked files into archive/: a job the engine runs, banner and all.
  for (const name of ['two', 'three', 'four'])
    await row(page, `moving/${name}.txt`).getByRole('checkbox').click()
  await page.getByTestId('selection-move').click()
  await page.getByTestId('move-destination').fill('archive/')
  const started = page.waitForResponse(
    (response) =>
      response.url().endsWith('/storage/objects:move') && response.request().method() === 'POST',
  )
  await page.getByTestId('move-confirm').click()
  const response = await started
  expect(response.status()).toBe(202)
  const job = (await response.json()) as { id: string; kind: string; section: string }
  expect(job).toMatchObject({ kind: 'storage.move', section: 'storage' })
  await expect(page.getByTestId('storage-job').first()).toContainText('Move')
  for (const name of ['two', 'three', 'four'])
    await expect(row(page, `moving/${name}.txt`)).toHaveCount(0)
  expect(
    await existing(engine, bucket, ['archive/two.txt', 'archive/three.txt', 'archive/four.txt']),
  ).toHaveLength(3)

  // A moved file's activity: created there.
  await openFiles(page, engine, { path: 'archive/', object: 'archive/two.txt', tab: 'activity' })
  await expect(inspector(page).getByTestId('activity-change').first()).toHaveAttribute(
    'data-kind',
    'created',
  )

  // Over a name that is taken, Replace asks first, naming it.
  await openFiles(page, engine, { path: 'moving/' })
  await row(page, 'moving/five.txt').getByRole('checkbox').click()
  await page.getByTestId('selection-move').click()
  await page.getByTestId('move-destination').fill('archive/')
  await page.getByTestId('move-dialog').getByText('Replace it').click()
  await page.getByTestId('move-confirm').click()
  const danger = page.getByTestId('storage-danger')
  await expect(danger).toContainText('Replace 1 file')
  await expect(danger).toContainText(
    'In archive/, these names are taken and are replaced: five.txt.',
  )
  await page.getByTestId('storage-danger-confirm').click()
  await expect
    .poll(
      async () =>
        (await objectOf(engine, bucket, 'archive/five.txt').catch(() => undefined))?.generation,
    )
    .toBeTruthy()
  await expect.poll(async () => existing(engine, bucket, ['moving/five.txt'])).toEqual([])
  expect(await mediaText(engine, bucket, 'archive/five.txt')).toHaveLength(16)
})

/** Runs a bulk verb through the console API as the owner and waits for its job to end. */
async function bulk(engine: Engine, verb: 'copy' | 'move' | 'delete', body: object) {
  const job = await ownerJson<{ id: string }>(engine, `/storage/objects:${verb}`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
  await expect
    .poll(async () => (await ownerJson<{ state: string }>(engine, `/jobs/${job.id}`)).state, {
      timeout: 60_000,
    })
    .toBe('done')
}

test('a folder is deleted as a job: counted first, followed while it runs, found again after a reload', async ({
  page,
  engine,
}) => {
  const { default: bucket } = bucketsOf(engine)
  // A copy of exports/ to delete, so the seed's own folder stays for the others.
  const before = await folderFigures(engine, bucket, '')
  await bulk(engine, 'copy', {
    bucket,
    target: { by: 'keys', keys: ['exports/'] },
    destination: { bucket, prefix: 'doomed/' },
    onConflict: 'skip',
  })
  const folder = await ownerJson<{ objects: number; bytes: number }>(
    engine,
    `/storage/folder?bucket=${encodeURIComponent(bucket)}&prefix=doomed%2F`,
  )
  expect(folder.objects).toBe(seed.csvCount + 1)
  const preview = await ownerJson<{ objects: number; bytes: number }>(
    engine,
    '/storage/objects:delete',
    {
      method: 'POST',
      body: JSON.stringify({
        bucket,
        target: { by: 'keys', keys: ['doomed/'] },
        onConflict: 'skip',
        dryRun: true,
      }),
    },
  )
  expect(preview.objects).toBe(folder.objects)
  expect(preview.bytes).toBe(folder.bytes)

  await openFiles(page, engine)
  await expect(treeNode(page, 'doomed/')).toBeVisible()
  await row(page, 'doomed/').getByTestId('row-menu-button').click()
  await page.getByTestId('row-menu-delete').click()
  const danger = page.getByTestId('storage-danger')
  await expect(danger).toContainText('Delete doomed/')
  await expect(danger).toContainText(
    `doomed/ and everything under it — ${figure(folder.objects)} files ·`,
  )

  // The nav's Storage item carries the engine's job gauge while it runs:
  // watched from now, since a delete this size is quick.
  await page.evaluate(() => {
    const browser = globalThis as unknown as {
      gaugeSeen?: boolean
      document: { querySelector(selector: string): unknown }
      MutationObserver: new (callback: () => void) => {
        observe(target: unknown, options: { childList: boolean; subtree: boolean }): void
      }
    }
    browser.gaugeSeen = false
    new browser.MutationObserver(() => {
      if (browser.document.querySelector('[data-testid="nav-badge-storage"]'))
        browser.gaugeSeen = true
    }).observe(browser.document, { childList: true, subtree: true })
  })
  await page.getByTestId('storage-danger-confirm').click()
  await expect(danger.getByTestId('storage-danger-progress')).toBeVisible()
  await expect(danger.getByTestId('storage-danger-progress')).toContainText(
    `Done: ${figure(folder.objects)} of ${figure(folder.objects)} deleted`,
    { timeout: 30_000 },
  )
  expect(
    await page.evaluate(() => (globalThis as unknown as { gaugeSeen?: boolean }).gaugeSeen),
  ).toBe(true)
  await page.keyboard.press('Escape')
  await expect(row(page, 'doomed/')).toHaveCount(0)
  await expect(treeNode(page, 'doomed/')).toHaveCount(0)
  await expect(treeNode(page, '')).toContainText(figure(before.objects))

  // A long delete outlives a reload: the banner finds it again from the engine.
  await bulk(engine, 'copy', {
    bucket,
    target: { by: 'keys', keys: ['exports/'] },
    destination: { bucket, prefix: 'doomed-again/' },
    onConflict: 'skip',
  })
  await openFiles(page, engine)
  await row(page, 'doomed-again/').getByRole('checkbox').click()
  await page.keyboard.press('Backspace')
  await expect(danger).toContainText(`${figure(folder.objects)} files`)
  await page.getByTestId('storage-danger-confirm').click()
  await page.reload()
  const banner = page.getByTestId('storage-job').filter({ hasText: /Delete .*doomed-again\// })
  await expect(banner).toBeVisible()
  await expect(banner.getByTestId('job-progress')).toContainText(`${figure(folder.objects)}`)
  await expect(row(page, 'doomed-again/')).toHaveCount(0)
})

test('files download by name, a selection as a zip, and an interrupted zip can be asked for again', async ({
  page,
  engine,
}) => {
  const { default: bucket } = bucketsOf(engine)
  await openFiles(page, engine, { path: 'public/docs/' })
  const single = page.waitForEvent('download')
  await row(page, seed.names.readme).getByTestId('row-menu-button').click()
  await page.getByTestId('row-menu-download').click()
  expect((await single).suggestedFilename()).toBe('readme.md')

  // Three files: one zip, its central directory listing three entries.
  await openFiles(page, engine, { path: 'public/data/' })
  for (const name of [seed.names.products, seed.names.events, seed.names.bigCsv])
    await row(page, name).getByRole('checkbox').click()
  const zipped = page.waitForEvent('download')
  await page.getByTestId('selection-download').click()
  const download = await zipped
  expect(download.suggestedFilename()).toMatch(/\.zip$/)
  const { readFile } = await import('node:fs/promises')
  const bytes = await readFile(await download.path())
  expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK')
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  expect(end).toBeGreaterThan(0)
  expect(bytes.readUInt16LE(end + 10)).toBe(3)

  // A ticket read halfway and dropped still serves the next request.
  const ticket = await ownerJson<{ url: string }>(engine, '/storage/objects:export', {
    method: 'POST',
    body: JSON.stringify({ bucket, target: { by: 'keys', keys: ['public/data/'] } }),
  })
  const url = new URL(ticket.url, engine.origin).toString()
  const aborted = new AbortController()
  const first = await fetch(url, { signal: aborted.signal })
  expect(first.status).toBe(200)
  const reader = first.body!.getReader()
  await reader.read()
  aborted.abort()
  await reader.closed.catch(() => undefined)
  await expect
    .poll(async () => {
      const again = await fetch(url)
      if (again.status !== 200) return again.status
      return Buffer.from(await again.arrayBuffer())
        .subarray(0, 2)
        .toString('latin1')
    })
    .toBe('PK')
})

test('the list follows the app live: one row, a burst, a delete, and a dropped channel', async ({
  page,
  engine,
}) => {
  const { default: bucket } = bucketsOf(engine)
  // Three pages of filler after where the new names fall.
  for (let index = 0; index < 2 * PAGE_LIMIT + 50; index += 1)
    await putFile(engine, {
      bucket,
      name: `live/z-filler-${String(index).padStart(3, '0')}.txt`,
      size: 4,
      contentType: 'text/plain',
    })
  const loads: number[] = []
  page.on('load', () => loads.push(Date.now()))
  await openFiles(page, engine, { path: 'live/' })
  const pages = listRequests(page, 'live/')
  // Every page loaded, then back to the top.
  const footer = page.getByTestId('table-footer-text')
  await scrollUntil(page.getByTestId('file-list-scroll'), async () =>
    /^[\d,]+ loaded$/.test((await footer.textContent()) ?? ''),
  )
  await page.getByTestId('file-list-scroll').evaluate((element) => {
    element.scrollTop = 0
  })
  const batches: string[][] = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/storage/objects:batchGet'))
      batches.push((request.postDataJSON() as { keys: string[] }).keys)
  })

  // One file from the app: on screen within a second, no reload.
  const owner = 'owner'
  expect(
    (
      await upload(engine, {
        bucket,
        name: 'live/0-first.png',
        size: 64,
        contentType: 'image/png',
        token: owner,
      })
    ).status,
  ).toBe(200)
  await expect(row(page, 'live/0-first.png')).toBeVisible({ timeout: 1_000 })

  // A burst of forty, one every 100 ms: the list grows while it lasts, a
  // row read at a time and the one page it falls in, never every page.
  const before = { batches: batches.length, pages: pages.length }
  const growth: number[] = []
  const burst = (async () => {
    for (let index = 0; index < 40; index += 1) {
      const sent = Date.now()
      await upload(engine, {
        bucket,
        name: `live/a-burst-${String(index).padStart(2, '0')}.png`,
        size: 64,
        contentType: 'image/png',
        token: owner,
      })
      growth.push(await list(page).locator('tr[data-key^="live/a-burst-"]').count())
      // The app's pace, not a wait for the page.
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, 100 - (Date.now() - sent))))
    }
  })()
  await burst
  const during = batches.length - before.batches
  expect(during).toBeGreaterThanOrEqual(8)
  expect(new Set(growth).size).toBeGreaterThanOrEqual(8)
  const total = 2 * PAGE_LIMIT + 50 + 1 + 40
  await expect(count(page)).toHaveText(new RegExp(`^${figure(total)} files · `))
  await expect(page.getByTestId('table-footer-text')).toHaveText(`${figure(total)} loaded`)
  // Only the first page's rows were read again: from its start, and the rows
  // just above the second page (which its new rows pushed past the page
  // size), two reads a batch at most, and a read a newer batch made
  // pointless is dropped and read again. The pages after it were never asked
  // for again.
  const refetched = pages.slice(before.pages)
  expect(refetched.length).toBeLessThanOrEqual(4 * during)
  for (const request of refetched)
    expect(new URL(request.url()).searchParams.get('cursor')).toBeNull()

  // The open file deleted from outside: the inspector says who.
  await row(page, 'live/0-first.png').click()
  await expect(inspector(page).getByTestId('fact-size')).toBeVisible()
  await removeFile(engine, { bucket, name: 'live/0-first.png' })
  await expect(inspector(page).getByTestId('object-deleted')).toContainText('Deleted by Admin')
  await page.keyboard.press('Escape')

  // The channel drops: the top bar says so, and only there.
  const badge = page.getByTestId('engine-badge')
  await expect(badge).toHaveText(/^engine /)
  await dropLive(page)
  await expect(badge).toHaveText('reconnecting', { timeout: 3_000 })
  await expect(page.getByTestId('storage-live')).toHaveCount(0)
  expect(
    (
      await upload(engine, {
        bucket,
        name: 'live/00-while-dropped.png',
        size: 64,
        contentType: 'image/png',
        token: owner,
      })
    ).status,
  ).toBe(200)
  await expect(row(page, 'live/00-while-dropped.png')).toHaveCount(0)
  await restoreLive(page)
  await expect(badge).toHaveText(/^engine /, { timeout: 15_000 })
  // Replayed from where it left off: the row is read by name, nothing reloads.
  await expect(row(page, 'live/00-while-dropped.png')).toBeVisible()
  expect(batches.some((keys) => keys.includes('live/00-while-dropped.png'))).toBe(true)
  expect(loads).toHaveLength(1)
})

test('acting as a person: what they may do, why a refusal, and nothing they may not read is asked for', async ({
  page,
  engine,
}) => {
  const { default: bucket } = bucketsOf(engine)
  const ada = person('ada')
  const grace = person('grace')
  await openFiles(page, engine, { path: `users/${ada.uid}/` })
  await expect(row(page, seed.names.avatar)).toBeVisible()

  // Ada, picked from the Auth users the engine lists.
  const listed = page.waitForRequest((request) =>
    request.url().includes('/console/api/v1/auth/identities'),
  )
  await page.getByTestId('identity-picker').click()
  await listed
  const minted = page.waitForRequest(
    (request) =>
      request.url().includes('/storage/objects?') &&
      (request.headers().authorization ?? '').startsWith('Bearer ey'),
  )
  // The engine lists every user the seeds made (Auth's seed makes dozens):
  // Ada is found by searching, as a person with many users would.
  await page.getByTestId('identity-picker-search').fill(ada.email)
  await page
    .getByTestId('identity-picker-user')
    .filter({ hasText: new RegExp(`^${ada.email.replaceAll('.', '\\.')}`) })
    .click()
  await expect.poll(() => searchOf(page).get('as')).toBe(`${ada.uid}:${ada.email}`)
  await minted
  // What she may do with each file, from a dry run: read it, not delete it
  // (the write allow reads request.resource, which a delete does not have).
  await expect(list(page).getByRole('columnheader', { name: 'Access' })).toBeVisible()
  await expect(row(page, seed.names.avatar).getByTestId('access-cell')).toHaveText('read')

  // Grace's folder, typed into the path: refused, with the line in the rules' words.
  await page.keyboard.press('ControlOrMeta+l')
  await page.getByTestId('path-input').fill(`gs://${bucket}/users/${grace.uid}/`)
  await page.getByTestId('path-input').press('Enter')
  await expect.poll(() => searchOf(page).get('path')).toBe(`users/${grace.uid}/`)
  expect(searchOf(page).get('as')).toBe(`${ada.uid}:${ada.email}`)
  const denied = page.getByTestId('denied-panel')
  await expect(denied).toContainText(`${ada.email} can't list users/${grace.uid}/`)
  await expect(denied).toContainText('Line 5 refused it.')
  await expect(denied).toContainText(
    'allow read: if request.auth != null && request.auth.uid == uid',
  )
  // The 403 carried its explanation: newer decisions do not take it away.
  for (let index = 0; index < 300; index += 1)
    expect((await getMetadata(engine, { bucket, name: seed.names.logo })).status).toBe(200)
  await page.getByTestId('denied-see-why').click()
  const why = page.getByTestId('refusal-detail')
  await expect(why.getByTestId('explained-allow').first()).toContainText('line 5')
  await expect(why.getByTestId('refusal-open-rules')).toBeVisible()
  await why.getByTestId('refusal-open-rules').click()
  await expect(page).toHaveURL(/\/console\/storage\/rules\?/)
  await expect(page).toHaveURL(/decision=s\d+/)
  await expect(page.getByTestId('decision-detail')).toBeVisible()

  // In the grid of a folder she may list, a file she may not read is a
  // lock with its line, and no picture of it is asked for.
  const asked: string[] = []
  page.on('request', (request) => {
    if (isPicture(request)) asked.push(new URL(request.url()).searchParams.get('name') ?? '')
  })
  await openFiles(page, engine, { path: 'shared/', layout: 'grid', as: `${ada.uid}:${ada.email}` })
  const tile = (name: string) => page.locator(`[data-testid="file-tile"][data-key="${name}"]`)
  await expect(tile(seed.names.sharedGrace).getByTestId('tile-locked')).toContainText(
    'No read · line 18',
  )
  await expect(tile(seed.names.sharedAda).getByTestId('tile-image')).toBeVisible()
  await expect.poll(() => asked.includes(seed.names.sharedAda)).toBe(true)
  expect(asked).not.toContain(seed.names.sharedGrace)

  // A 7 MB video is refused before a byte goes.
  const puts: string[] = []
  page.on('request', (request) => {
    if (request.method() === 'PUT' && request.url().includes('/storage/object?'))
      puts.push(request.url())
  })
  await openFiles(page, engine, { path: `users/${ada.uid}/`, as: `${ada.uid}:${ada.email}` })
  await expect(page.getByTestId('upload-menu')).toBeVisible()
  const { closeSync, openSync, ftruncateSync } = await import('node:fs')
  const movie = test.info().outputPath('clip.mov')
  const handle = openSync(movie, 'w')
  ftruncateSync(handle, 7 * 1024 * 1024)
  closeSync(handle)
  await page.getByTestId('upload-input').setInputFiles(movie)
  const refused = page.getByTestId('tray-row').filter({ hasText: 'clip.mov' })
  await expect(refused.getByTestId('tray-row-message')).toHaveText(/^Refused by line 6 — not sent/)
  expect(puts).toEqual([])
})

test('another bucket is a pick away, and one no rules serve says so', async ({ page, engine }) => {
  const { media } = bucketsOf(engine)
  await openFiles(page, engine)
  await page.getByTestId('bucket-picker').getByRole('combobox').click()
  await page.getByRole('option', { name: new RegExp(media) }).click()
  await expect.poll(() => searchOf(page).get('bucket')).toBe(media)
  await expect(row(page, 'banners/')).toBeVisible()
  await row(page, 'banners/').locator('td').nth(2).dblclick()
  await page.keyboard.press('v')
  await expect(page.getByTestId('file-tile'))
  await expect(page.getByTestId('file-tile').first()).toBeVisible()
  await expect(page.getByTestId('file-tile').first().getByTestId('tile-image')).toBeVisible()

  // A bucket by name that no target names: every client request to it is refused.
  const unlisted = `${engine.project}-unlisted`
  await page.getByTestId('bucket-menu').click()
  await page.getByTestId('bucket-open-by-name').click()
  await page.getByTestId('open-bucket-name').fill(unlisted)
  await page.getByTestId('open-bucket-confirm').click()
  await expect.poll(() => searchOf(page).get('bucket')).toBe(unlisted)
  await expect(page.getByTestId('bucket-not-served')).toContainText(
    `No rules govern gs://${unlisted}`,
  )
  await expect(page.getByTestId('bucket-not-served')).toContainText('the Admin SDK included')
})

test('the keyboard reaches everything: rows, ticks, Quick Look, the row menu and delete', async ({
  page,
  engine,
}) => {
  await openFiles(page, engine, { path: 'public/data/' })
  await expect(rows(page)).toHaveCount(seed.counts['public/data/'] ?? 0)
  const cursor = () => list(page).locator('tr[data-cursor]')
  await page.keyboard.press('ArrowDown')
  await expect(cursor()).toHaveAttribute('data-key', seed.names.bigCsv)
  await page.keyboard.press('ArrowDown')
  await expect(cursor()).toHaveAttribute('data-key', seed.names.events)
  // Space ticks the cursor row.
  await page.keyboard.press('Space')
  await expect(cursor().getByRole('checkbox')).toBeChecked()
  await page.keyboard.press('Space')
  await expect(cursor().getByRole('checkbox')).not.toBeChecked()
  // ⇧Space: Quick Look, a link of its own, stepping with the arrows.
  await page.keyboard.press('Shift+Space')
  await expect(page).toHaveURL(/dialog=quick-look/)
  const look = page.getByTestId('quick-look')
  await expect(look).toBeVisible()
  await expect(page.getByTestId('quick-look-position')).toContainText('2')
  await page.keyboard.press('ArrowRight')
  await expect(page).toHaveURL(new RegExp(`object=${encodeURIComponent(seed.names.products)}`))
  await page.keyboard.press('ArrowLeft')
  await expect(page).toHaveURL(new RegExp(`object=${encodeURIComponent(seed.names.events)}`))
  await page.keyboard.press('Escape')
  await expect(look).toHaveCount(0)
  await expect(page).not.toHaveURL(/dialog=/)
  // Enter opens the cursor file; Escape closes it.
  await page.keyboard.press('Escape')
  await expect(inspector(page)).toHaveCount(0)
  await page.keyboard.press('Enter')
  await expect(inspector(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(inspector(page)).toHaveCount(0)
  // Shift+F10: the cursor row's menu.
  await page.keyboard.press('Shift+F10')
  await expect(page.getByTestId('row-menu-quick-look')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('row-menu-quick-look')).toHaveCount(0)
  // ⌫ on a ticked row asks first.
  await page.keyboard.press('Space')
  await expect(cursor().getByRole('checkbox')).toBeChecked()
  await page.keyboard.press('Backspace')
  await expect(page.getByTestId('storage-danger')).toContainText('Delete events.json.gz')
  await page.getByTestId('storage-danger-cancel').click()
  await expect(page.getByTestId('storage-danger')).toHaveCount(0)

  // ? lists Storage's keys, every one of them in the console's reserved table.
  await page.keyboard.press('?')
  const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' })
  await expect(dialog).toBeVisible()
  const storage = dialog.getByRole('region', { name: /Storage$/ })
  await expect(storage.first()).toContainText('Flip between the list and the grid')
  const reserved = new Set([
    'g',
    'v',
    'u',
    'n',
    '/',
    'f',
    'Esc',
    'Del',
    '⌫',
    'F2',
    '⇧U',
    '⌘L',
    '⇧Space',
    '⌥⌘C',
    'Shift+U',
    'Ctrl+L',
    'Shift+Space',
    'Ctrl+Alt+C',
  ])
  const keys = await storage.locator('kbd').allTextContents()
  expect(keys.length).toBeGreaterThan(0)
  for (const key of keys) expect(reserved, `${key} is not in the reserved table`).toContain(key)
  await page.keyboard.press('Escape')
})

test('⌘K finds files from anywhere, opens locations, and offers the page’s actions', async ({
  page,
  engine,
}) => {
  const { default: bucket } = bucketsOf(engine)
  await page.goto(`${engine.origin}/console/firestore`)
  await expect(page.getByTestId('primary-nav')).toBeVisible()
  await page.keyboard.press('ControlOrMeta+k')
  const input = page.getByTestId('palette-input')
  // A hundred and twenty other users have an avatar.png: her folder narrows it.
  await input.fill(`${seed.users.ada}/avatar.png`)
  const hit = page.getByRole('option', { name: new RegExp(`^${seed.names.avatar}`) })
  await expect(hit).toBeVisible()
  await expect(page.getByText('Objects', { exact: true })).toBeVisible()
  await hit.click()
  await expect(page).toHaveURL(/\/console\/storage\?/)
  expect(searchOf(page).get('path')).toBe(`users/${seed.users.ada}/`)
  expect(searchOf(page).get('object')).toBe(seed.names.avatar)
  await expect.poll(() => searchOf(page).get('bucket')).toBeNull()
  await expect(inspector(page).getByTestId('fact-size')).toBeVisible()

  // A location pasted in: opened.
  await page.keyboard.press('ControlOrMeta+k')
  await input.fill(`gs://${bucket}/public/`)
  await page.getByRole('option', { name: `Open gs://${bucket}/public/` }).click()
  await expect.poll(() => searchOf(page).get('path')).toBe('public/')

  // With a row as the cursor, its menu is in the palette; where you have been, too.
  await row(page, 'public/docs/').locator('td').nth(2).click()
  await page.keyboard.press('ControlOrMeta+k')
  await input.fill('Download as .zip')
  await expect(page.getByRole('option', { name: /Download as \.zip/ })).toBeVisible()
  await input.fill('')
  await expect(page.getByText('Recent', { exact: true })).toBeVisible()
  await expect(
    page.getByRole('option', { name: /^users\/u_k65eq\/avatar\.png/ }).first(),
  ).toBeVisible()
  await page.keyboard.press('Escape')

  // The section's own action, from another page: the upload dialog.
  await page.goto(`${engine.origin}/console/firestore`)
  await page.keyboard.press('ControlOrMeta+k')
  await input.fill('Upload files')
  await page.getByRole('option', { name: 'Upload files', exact: true }).click()
  await expect(page).toHaveURL(/\/console\/storage\?new=upload/)
  await expect(page.getByTestId('upload-dialog')).toBeVisible()
})

test('an upload reaches the app’s function, and its event can be sent again', async ({
  page,
  engine,
}) => {
  const { default: bucket } = bucketsOf(engine)
  const events = async (name: string) => {
    const response = await ownerFetch(engine, `${documentsOf(engine)}:runQuery`, {
      method: 'POST',
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: 'storageEvents' }],
          where: {
            fieldFilter: {
              field: { fieldPath: 'name' },
              op: 'EQUAL',
              value: { stringValue: name },
            },
          },
        },
      }),
    })
    expect(response.ok).toBe(true)
    const answer = (await response.json()) as Array<{
      document?: { name: string; fields: Record<string, { stringValue?: string }> }
    }>
    return answer.flatMap((entry) => (entry.document ? [entry.document] : []))
  }
  await putFile(engine, { bucket, name: 'trigger/readme.txt', size: 4, contentType: 'text/plain' })
  await openFiles(page, engine, { path: 'trigger/' })
  await page.getByTestId('upload-input').setInputFiles([pick('trigger-check.png')])
  await expect(row(page, 'trigger/trigger-check.png')).toBeVisible()
  await expect
    .poll(async () => (await events('trigger/trigger-check.png')).length, { timeout: 30_000 })
    .toBe(1)
  const [first] = await events('trigger/trigger-check.png')
  expect(first?.fields.bucket?.stringValue).toBe(bucket)

  await openFiles(page, engine, {
    path: 'trigger/',
    object: 'trigger/trigger-check.png',
    tab: 'activity',
  })
  const delivery = inspector(page).getByTestId('activity-delivery').first()
  await expect(delivery).toContainText('Sent to the Functions emulator')
  // Named as a link to the function, in Functions.
  await expect(delivery.getByRole('link', { name: 'storageFinalized' })).toBeVisible()
  // The v1 body the function got names the same object, as the function recorded it.
  const payloads = inspector(page).getByTestId('event-payloads')
  await payloads.getByRole('tab', { name: 'Raw' }).click()
  const payload = payloads.getByTestId('event-payload')
  await expect(payload).toContainText('"name": "trigger/trigger-check.png"')
  await expect(payload).toContainText(`"bucket": "${first?.fields.bucket?.stringValue}"`)

  // Sent again: a second event, the file untouched.
  const before = await objectOf(engine, bucket, 'trigger/trigger-check.png')
  await inspector(page).getByTestId('resend-finalize').click()
  await expect(page.getByText('Sent the finalize event to the Functions emulator')).toBeVisible()
  await expect
    .poll(async () => (await events('trigger/trigger-check.png')).length, { timeout: 30_000 })
    .toBe(2)
  const ids = (await events('trigger/trigger-check.png')).map((doc) => doc.name)
  expect(new Set(ids).size).toBe(2)
  expect((await objectOf(engine, bucket, 'trigger/trigger-check.png')).generation).toBe(
    before.generation,
  )
})

test('upload options travel with the files and are remembered; many files are edited at once', async ({
  page,
  engine,
}) => {
  const { default: bucket } = bucketsOf(engine)
  const ada = person('ada')
  await putFile(engine, { bucket, name: 'options/readme.txt', size: 4, contentType: 'text/plain' })
  await openFiles(page, engine, { path: 'options/' })
  await page.getByTestId('upload-menu').click()
  await page.getByTestId('upload-with-options').click()
  const dialog = page.getByTestId('upload-dialog')
  await expect(dialog).toBeVisible()
  const options = dialog.getByTestId('upload-options')
  if ((await options.getByTestId('upload-options-toggle').getAttribute('aria-expanded')) !== 'true')
    await options.getByTestId('upload-options-toggle').click()
  await options.getByRole('combobox', { name: 'cacheControl' }).fill('public, max-age=3600')
  await page.keyboard.press('Escape')
  const custom = options.getByTestId('upload-custom-metadata')
  await custom.getByTestId('upload-custom-metadata-add-key').pressSequentially('ownerUid')
  await custom.getByTestId('upload-custom-metadata-value').last().fill(ada.uid)
  await custom.getByTestId('upload-custom-metadata-add-key').pressSequentially('place')
  await custom.getByTestId('upload-custom-metadata-value').last().fill('été')
  await dialog
    .getByTestId('upload-dialog-input')
    .setInputFiles([pick('o1.png'), pick('o2.png'), pick('o3.png')])
  await dialog.getByTestId('upload-dialog-confirm').click()
  for (const name of ['o1', 'o2', 'o3'])
    await expect(row(page, `options/${name}.png`)).toBeVisible()
  for (const name of ['o1', 'o2', 'o3']) {
    const object = await objectOf(engine, bucket, `options/${name}.png`)
    expect(object.cacheControl).toBe('public, max-age=3600')
    expect(object.customMetadata).toEqual({ ownerUid: ada.uid, place: 'été' })
  }
  // Asked again, the dialog has them.
  await page.getByTestId('upload-menu').click()
  await page.getByTestId('upload-with-options').click()
  if ((await options.getByTestId('upload-options-toggle').getAttribute('aria-expanded')) !== 'true')
    await options.getByTestId('upload-options-toggle').click()
  await expect(options.getByRole('combobox', { name: 'cacheControl' })).toHaveValue(
    'public, max-age=3600',
  )
  await expect(custom.getByTestId('upload-custom-metadata-value').first()).toHaveValue(ada.uid)
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)

  // Five ticked files: one job sets a key and clears a field on every one.
  for (const name of ['o4', 'o5'])
    await putFile(engine, {
      bucket,
      name: `options/${name}.png`,
      size: 16,
      contentType: 'image/png',
    })
  await expect(row(page, 'options/o5.png')).toBeVisible()
  for (const name of ['o1', 'o2', 'o3', 'o4', 'o5'])
    await row(page, `options/${name}.png`).getByRole('checkbox').click()
  await page.getByTestId('selection-metadata').click()
  const edit = page.getByTestId('edit-metadata-dialog')
  await expect(edit).toContainText('Edit metadata of 5 files')
  await edit.getByTestId('bulk-set-keys-add-key').pressSequentially('reviewed')
  await edit.getByTestId('bulk-set-keys-value').last().fill('true')
  await edit
    .locator('label', { hasText: 'cacheControl' })
    .locator('xpath=..')
    .getByRole('checkbox', { name: 'Clear' })
    .click()
  const started = page.waitForResponse(
    (response) =>
      response.url().endsWith('/storage/objects:metadata') &&
      response.request().method() === 'POST',
  )
  await page.getByTestId('edit-metadata-confirm').click()
  expect((await started).status()).toBe(202)
  await expect
    .poll(async () => {
      const objects = await Promise.all(
        ['o1', 'o2', 'o3', 'o4', 'o5'].map((name) =>
          objectOf(engine, bucket, `options/${name}.png`),
        ),
      )
      return objects.every(
        (object) => object.customMetadata.reviewed === 'true' && object.cacheControl === null,
      )
    })
    .toBe(true)
  expect((await objectOf(engine, bucket, 'options/o1.png')).customMetadata.place).toBe('été')
})

test('an upload the app left half way is listed with what arrived, and is discarded', async ({
  page,
  engine,
}) => {
  const { default: bucket } = bucketsOf(engine)
  const storage = `http://127.0.0.1:${engine.ports.storage}`
  const name = 'sessions/half.bin'
  const start = await fetch(`${storage}/v0/b/${bucket}/o?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer owner',
      'content-type': 'application/json',
      'x-goog-upload-protocol': 'resumable',
      'x-goog-upload-command': 'start',
      'x-goog-upload-header-content-length': '200000',
      'x-goog-upload-header-content-type': 'application/octet-stream',
    },
    body: JSON.stringify({ name, contentType: 'application/octet-stream' }),
  })
  expect(start.ok).toBe(true)
  const url = start.headers.get('x-goog-upload-url') ?? ''
  expect(url).toContain('upload_id=')
  const chunk = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: 'Bearer owner',
      'x-goog-upload-command': 'upload',
      'x-goog-upload-offset': '0',
    },
    body: Buffer.alloc(100_000, 3),
  })
  expect(chunk.ok).toBe(true)

  await openFiles(page, engine)
  await page.getByTestId('bucket-menu').click()
  await expect(page.getByTestId('bucket-sessions')).toHaveText(/Uploads in progress · 1$/)
  await page.getByTestId('bucket-sessions').click()
  const popover = page.getByTestId('uploads-in-progress')
  const session = popover.getByTestId('session-row')
  await expect(session).toHaveCount(1)
  await expect(session).toContainText(name)
  await expect(session).toContainText(/100(\.0)? KB|97\.7 KB|100,000/)
  await session.getByTestId('session-discard').click()
  await expect(session).toHaveCount(0)
  const after = await fetch(url, {
    method: 'POST',
    headers: { authorization: 'Bearer owner', 'x-goog-upload-command': 'query' },
  })
  expect(after.status).toBe(404)
})

test('a pasted gs:// location of this bucket is copied into the folder on screen', async ({
  page,
  engine,
}) => {
  const { default: bucket } = bucketsOf(engine)
  const source = await objectOf(engine, bucket, seed.names.avatar)
  await openFiles(page, engine, { path: `users/${seed.users.ada}/` })
  // ⌘C on a row copies its name cell's value: the gs:// URL.
  await row(page, seed.names.avatar).locator('td[data-column="name"]').click()
  await page.keyboard.press('Escape')
  await page.keyboard.press('ControlOrMeta+c')
  await expect.poll(() => readClipboard(page)).toBe(`gs://${bucket}/${seed.names.avatar}`)
  const copied = await readClipboard(page)

  await putFile(engine, { bucket, name: 'pasted/readme.txt', size: 4, contentType: 'text/plain' })
  await openFiles(page, engine, { path: 'pasted/' })
  await page.locator('body').evaluate((body, text) => {
    const browser = globalThis as unknown as {
      DataTransfer: new () => { setData(type: string, value: string): void }
      ClipboardEvent: new (type: string, init: object) => unknown
    }
    const transfer = new browser.DataTransfer()
    transfer.setData('text/plain', text)
    body.ownerDocument.dispatchEvent(
      new browser.ClipboardEvent('paste', { clipboardData: transfer, bubbles: true }) as never,
    )
  }, copied)
  await expect(page.getByText('Copy avatar.png here?')).toBeVisible()
  const started = page.waitForResponse(
    (response) =>
      response.url().endsWith('/storage/objects:copy') && response.request().method() === 'POST',
  )
  await page.getByRole('button', { name: 'Copy here' }).click()
  expect((await started).status()).toBe(202)
  await expect(row(page, 'pasted/avatar.png')).toBeVisible()
  const copy = await objectOf(engine, bucket, 'pasted/avatar.png')
  expect(copy.downloadTokens).toHaveLength(1)
  expect(source.downloadTokens).not.toContain(copy.downloadTokens[0])
})

test('links from elsewhere open a file, and a decision on the Rules page', async ({
  page,
  engine,
  context,
}) => {
  const { default: bucket } = bucketsOf(engine)
  // The link the registry builds for `storage.object`: the bucket, its folder and the file.
  const link = new URLSearchParams({
    bucket,
    path: parentPath(seed.names.avatar),
    object: seed.names.avatar,
  })
  await page.goto(`${engine.origin}/console/storage?${link}`)
  await expect(inspector(page).getByTestId('fact-size')).toBeVisible()
  // The default bucket is the page's default: the address drops it.
  await expect.poll(() => searchOf(page).get('bucket')).toBeNull()
  expect(searchOf(page).get('object')).toBe(seed.names.avatar)

  // `storage.decision` → the Rules page with that decision open.
  const token = await tokenFor(engine, person('grace').uid)
  expect((await getMetadata(engine, { bucket, name: seed.names.avatar, token })).status).toBe(403)
  const decisions = await ownerJson<{
    items: Array<{ id: string; path: string; uid: string | null }>
  }>(
    engine,
    `/storage/rules/decisions?bucket=${encodeURIComponent(bucket)}&path=${encodeURIComponent(seed.names.avatar)}&denied=true`,
  )
  const decision = decisions.items.find((item) => item.uid === person('grace').uid)
  expect(decision).toBeDefined()
  const other = await context.newPage()
  await other.goto(
    `${engine.origin}/console/storage/rules?${new URLSearchParams({ bucket, panel: 'decisions', decision: decision?.id ?? '' })}`,
  )
  const detail = other.getByTestId('decision-detail')
  await expect(detail).toBeVisible()
  await expect(detail.getByTestId('decision-path')).toHaveText(seed.names.avatar)
  // Its uid links to the user, in Authentication.
  const uid = detail.getByTestId('decision-who')
  await expect(uid).toContainText(person('grace').uid)
  await expect(uid.getByRole('link')).toBeVisible()
  await other.close()
})

/** A run of text as `<size> <face>`. */
const font = (locator: Locator) =>
  locator.evaluate((el) => {
    const style = el.ownerDocument.defaultView!.getComputedStyle(el)
    return `${style.fontSize} ${/mono|plex/i.test(style.fontFamily) ? 'mono' : 'sans'}`
  })

/** A control's luminance once a hover or its end has settled (transitions run ~150 ms). */
async function settledPaint(control: Locator): Promise<number> {
  let last = -1
  let value = await paintOf(control)
  await expect
    .poll(async () => {
      last = value
      value = await paintOf(control)
      return value === last
    })
    .toBe(true)
  return value
}

test('row one holds its place at every width, and the page paints as one design', async ({
  page,
  engine,
}) => {
  const { default: bucket } = bucketsOf(engine)
  const ada = person('ada')
  await page.setViewportSize({ width: 1440, height: 900 })
  await openFiles(page, engine, { path: `users/${ada.uid}/` })
  await expect(row(page, seed.names.avatar)).toBeVisible()
  const rowOne = [
    'scope-picker',
    'path-field',
    'copy-path',
    'identity-picker',
    'upload-menu',
  ] as const
  for (const width of [1440, 1280, 1152, 1024]) {
    await page.setViewportSize({ width, height: 800 })
    await expect(row(page, seed.names.avatar)).toBeVisible()
    for (const id of rowOne) {
      const control = page.getByTestId('storage-toolbar').getByTestId(id).first()
      expect(await paintedAtItsOwnCentre(control), `${id} at ${width}px`).toBe(true)
    }
    // The toolbar never scrolls sideways, and Upload ends inside the window.
    const toolbar = page.getByTestId('storage-toolbar')
    expect(await toolbar.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1)
    const menu = (await page.getByTestId('upload-menu').boundingBox())!
    expect(menu.x + menu.width).toBeLessThanOrEqual(width)
    // A path too long for its box shows its end, where you are.
    const segments = page.getByTestId('path-segments')
    expect(
      await segments.evaluate((el) => el.scrollWidth - el.clientWidth - el.scrollLeft),
    ).toBeLessThanOrEqual(1)
  }

  // The scope picker leads in one place, however deep the path.
  await page.setViewportSize({ width: 1440, height: 900 })
  const scopeX = async () => (await page.getByTestId('scope-picker').boundingBox())!.x
  const xs: number[] = []
  for (const path of ['', 'users/', `users/${ada.uid}/`]) {
    await openFiles(page, engine, path ? { path } : {})
    await expect(page.getByTestId('listing-count')).toBeVisible()
    xs.push(await scopeX())
  }
  expect(new Set(xs).size).toBe(1)

  // Sort never moves with the count beside it: no folders, many, still
  // counting, and a sorted view behind its writes.
  const sortX = async () => (await page.getByTestId('sort-menu').boundingBox())!.x
  await openFiles(page, engine, { path: 'public/data/' })
  await expect(count(page)).toHaveText(/files/)
  const at = await sortX()
  await openFiles(page, engine, { path: 'users/' })
  await expect(count(page)).toHaveText(/folders/)
  expect(await sortX()).toBe(at)
  const gate: { open?: () => void } = {}
  const held = new Promise<void>((resolve) => {
    gate.open = resolve
  })
  await page.route('**/console/api/v1/storage/folder?**', async (route) => {
    await held
    await route.continue()
  })
  await openFiles(page, engine, { path: 'public/' })
  await expect(count(page)).toHaveText('…')
  expect(await sortX()).toBe(at)
  gate.open?.()
  await expect(count(page)).toHaveText(/files|folders/)
  await page.unroute('**/console/api/v1/storage/folder?**')
  await openFiles(page, engine, { path: 'public/data/', sort: 'size:desc' })
  await expect(rows(page).first()).toHaveAttribute('data-key', seed.largest.name)
  // (Another order has another label: the place to hold is this one's.)
  const bySize = await sortX()
  const later = { bucket, name: 'public/data/zz-later.csv', size: 10, contentType: 'text/csv' }
  try {
    await putFile(engine, later)
    await expect(page.getByTestId('listing-count-refresh')).toBeVisible()
    expect(await sortX()).toBe(bySize)
  } finally {
    await removeFile(engine, later)
  }

  // No ring is cut by the clip around it.
  await openFiles(page, engine, { path: `users/${ada.uid}/`, object: seed.names.avatar })
  await expect(inspector(page).getByTestId('fact-size')).toBeVisible()
  expect(await cutRings(page)).toEqual([])

  // The type scale: names 12 px mono, figures 11 px, the inspector's prose
  // 13 px and its values 12 px, a dialog's title 16 px.
  const nameCell = row(page, seed.names.avatar)
    .locator('td[data-column="name"] span.truncate')
    .first()
  expect(await font(nameCell)).toBe('12px mono')
  expect(
    await font(row(page, seed.names.avatar).locator('td[data-column="size"] span').first()),
  ).toMatch(/^11px /)
  const size = inspector(page).getByTestId('fact-size')
  expect(await font(size.locator('dt'))).toBe('13px sans')
  expect(await font(size.locator('dd'))).toBe('12px mono')
  await inspectorTab(page, 'Activity').click()
  expect(await font(inspector(page).getByTestId('activity-windows'))).toBe('11px sans')
  await inspectorTab(page, 'Details').click()
  await page.keyboard.press('n')
  const title = page.getByTestId('create-folder-dialog').getByRole('heading').first()
  expect(await font(title)).toMatch(/^16px/)
  await page.keyboard.press('Escape')

  // Hover is one ink step from each control's own colour, in both modes:
  // darker in light, lighter in dark, and never two steps at once (a path
  // segment and a tree arrow are measured with what holds them already lit,
  // as Firestore's are).
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await openFiles(page, engine, { path: 'public/docs/' })
    await expect(rows(page).first()).toBeVisible()
    const toward = scheme === 'light' ? -1 : 1
    const segments = page.getByTestId('path-segment')
    for (const [name, control, away] of [
      ['a column header', list(page).getByTestId('sort-header').first(), undefined],
      ['a path segment, field lit', segments.first(), segments.last()],
      ['the order', page.getByTestId('sort-menu'), undefined],
      ['a tree node', treeNode(page, 'public/data/'), undefined],
      [
        'a tree arrow, node lit',
        treeNode(page, 'public/').getByTestId('panel-tree-toggle'),
        treeNode(page, 'public/').locator('span.truncate'),
      ],
    ] as const) {
      if (away) await away.hover()
      else await page.mouse.move(700, 790)
      const rest = await settledPaint(control)
      await control.hover()
      const hover = await settledPaint(control)
      const step = toward * (hover - rest)
      expect(step, `${name} in ${scheme}`).toBeGreaterThanOrEqual(6)
      expect(step, `${name} in ${scheme}`).toBeLessThanOrEqual(30)
    }
  }
})
