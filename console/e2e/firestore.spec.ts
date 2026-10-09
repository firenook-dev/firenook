import { type Locator, expect, test } from '@playwright/test'

// The Firestore workbench against a real engine seeded by scripts/seed-firestore.mjs.
const origin = () => {
  const value = process.env.FIRENOOK_CONSOLE_ORIGIN
  if (!value) throw new Error('the engine global setup did not run')
  return value
}
const project = () => process.env.FIRENOOK_CONSOLE_PROJECT ?? 'demo-console-e2e'

/** A box's right edge; Playwright reports position and size, not edges. */
const edge = (box: { x: number; width: number } | null) => (box ? box.x + box.width : NaN)
const documents = () =>
  `${origin()}/console/api/v1/firestore/v1/projects/${project()}/databases/(default)/documents`
const owner = { authorization: 'Bearer owner', 'content-type': 'application/json' }
/** The resource name a write names, as opposed to the URL it is sent to. */
const resource = () => `projects/${project()}/databases/(default)/documents`

test('a collection is a typed grid counted once, in the query line', async ({ page }) => {
  await page.goto(`${origin()}/console/firestore?path=users`)
  const header = page.getByRole('table').locator('thead')
  await expect(header.getByText('displayName')).toBeVisible()
  await expect(header.getByText('lastSeen')).toBeVisible()
  await expect(header.getByText('timestamp', { exact: true }).first()).toBeVisible()
  await expect(page.getByTestId('match-count')).toContainText('240 documents')
  // Only there: the path bar does not print the same figure a row above,
  // where it would carry neither the query nor the identity in force.
  await expect(page.getByTestId('path-bar')).not.toContainText('240')
  await expect(page.getByTestId('grid-row').first()).toBeVisible()
})

test('the query line runs the SDK chain and pages with cursors', async ({ page }) => {
  await page.goto(`${origin()}/console/firestore?path=users`)
  await expect(page.getByTestId('grid-row').first()).toBeVisible()
  await page.keyboard.press('f')
  const input = page.getByTestId('query-input')
  await expect(input).toBeFocused()
  await input.fill('where("plan", "==", "pro").orderBy("lastSeen", "desc").limit(20)')
  await input.press('Enter')
  await expect(page).toHaveURL(/q=where/)
  await expect(page.getByTestId('match-count')).toContainText(/\d+ documents/)
  await expect(page.getByText('plan == "pro"')).toBeVisible()
  // The scroller fills its first pages; every row is a distinct document.
  await expect(page.getByTestId('grid-row').first()).toBeVisible()
  const ids = await page.getByTestId('grid-row').locator('td:nth-child(2)').allInnerTexts()
  expect(new Set(ids.map((id) => id.trim())).size).toBe(ids.length)
  expect(ids.length).toBeGreaterThan(20)
})

test('viewing as a user applies the rules the app would hit', async ({ page }) => {
  await page.goto(`${origin()}/console/firestore?path=users&as=u_k65eq%3Aada%40example.test`)
  await expect(page.getByText('Denied by security rules')).toBeVisible()
  await expect(page.getByTestId('view-as')).toContainText('ada@example.test')
  // Her own document is readable.
  await page.goto(
    `${origin()}/console/firestore?path=users&as=u_k65eq%3Aada%40example.test&doc=users%2Fu_k65eq`,
  )
  const inspector = page.getByTestId('inspector')
  await expect(inspector.getByLabel('displayName value')).toHaveValue('Ada Lovelace')
  await expect(inspector.getByText('orders')).toBeVisible()
  // The Requests drawer streams the evaluations with the lines that fired.
  await page.getByTestId('requests-drawer').getByRole('button').first().click()
  await expect(page.getByTestId('requests-drawer')).toContainText('Live')
  await page.getByTestId('view-as').click()
  await page.getByRole('menuitem', { name: /Anonymous/ }).click()
  await expect(page.getByTestId('requests-drawer')).toContainText('denied', { timeout: 10_000 })
  await expect(page.getByTestId('requests-drawer')).toContainText(/line \d+/)
})

test('the inspector saves typed edits and the change flashes back through the live channel', async ({
  page,
}) => {
  await page.goto(`${origin()}/console/firestore?path=teams&doc=teams%2Ft_real`)
  const inspector = page.getByTestId('inspector')
  await inspector.getByLabel('seats value').fill('9')
  await inspector.getByTestId('save-document').click()
  await expect(page.getByText('Document saved')).toBeVisible()
  const row = page.getByTestId('grid-row').filter({ hasText: 't_real' })
  await expect(row).toContainText('9')

  // A write from outside the console (an app, the CLI) reaches the grid
  // without any polling: the row updates and flashes.
  const response = await page.request.post(`${documents()}:commit`, {
    headers: owner,
    data: {
      writes: [
        {
          update: {
            name: `projects/${project()}/databases/(default)/documents/teams/t_real`,
            fields: { seats: { integerValue: '11' } },
          },
          updateMask: { fieldPaths: ['seats'] },
        },
      ],
    },
  })
  expect(response.ok()).toBeTruthy()
  await expect(row).toContainText('11', { timeout: 5_000 })
  await expect(page.getByText(/Live · \d+ change/)).toBeVisible()
})

test('documents are added and deleted from the workbench', async ({ page }) => {
  await page.goto(`${origin()}/console/firestore?path=teams`)
  await expect(page.getByTestId('grid-row').first()).toBeVisible()
  await page.keyboard.press('n')
  await page.getByTestId('new-document-id').fill('t_journey')
  await page.getByRole('dialog').getByRole('tab', { name: 'JSON' }).click()
  await page.getByTestId('document-json').fill('{"name": "Journey", "seats": 2, "tags": ["e2e"]}')
  await page.getByRole('button', { name: 'Apply to fields' }).click()
  await expect(page.getByRole('dialog')).toContainText('Fields · 3')
  await page.getByTestId('create-submit').click()
  await expect(page).toHaveURL(/doc=teams%2Ft_journey/)
  await expect(page.getByTestId('inspector')).toContainText('teams/t_journey')
  await expect(page.getByTestId('grid-row').filter({ hasText: 't_journey' })).toBeVisible()

  await page.getByLabel('Select t_journey').click()
  await page.getByTestId('delete-selected').click()
  await page.getByTestId('confirm-delete').click()
  await expect(page.getByText('Document deleted')).toBeVisible()
  await expect(page.getByTestId('grid-row').filter({ hasText: 't_journey' })).toHaveCount(0)
  const gone = await page.request.get(`${documents()}/teams/t_journey`, { headers: owner })
  expect(gone.status()).toBe(404)
})

test('rows show their subcollections and the tree walks three levels deep', async ({ page }) => {
  // Ada sits past the first page of ids, so ask for her by query.
  await page.goto(
    `${origin()}/console/firestore?path=users&q=${encodeURIComponent('where("email", "==", "ada@example.test")')}`,
  )
  // The schema says users can hold orders and sessions, so the grid has
  // a subcollections column, and Ada's row names hers.
  await expect(page.getByTestId('subcollections-head')).toBeVisible()
  const ada = page.getByTestId('grid-row').filter({ hasText: 'u_k65eq' })
  await expect(ada.getByTestId('subcollection-link')).toHaveCount(2)
  await expect(ada.getByTestId('subcollection-link').first()).toContainText('orders')
  await ada.getByTestId('subcollection-link').filter({ hasText: 'orders' }).click()
  await expect(page).toHaveURL(/path=users%2Fu_k65eq%2Forders$/)
  await expect(page.getByTestId('path-bar')).toContainText('orders')
  // An ancestor keeps its count — it is the only place that figure appears.
  await expect(page.getByTestId('path-bar')).toContainText('240')
  // Every order carries its items as a subcollection of its own.
  const order = page.getByTestId('grid-row').first()
  await expect(order.getByTestId('subcollection-link')).toHaveText(/items/)
  await order.getByTestId('subcollection-link').click()
  await expect(page).toHaveURL(/path=users%2Fu_k65eq%2Forders%2F[^%]+%2Fitems$/)
  await expect(page.getByRole('table').locator('thead')).toContainText('sku')
  // A user without subcollections has no chips.
  await page.goto(`${origin()}/console/firestore?path=users`)
  await expect(page.getByTestId('grid-row').first()).toBeVisible()
  await expect(page.getByTestId('subcollections-chip').first()).toBeVisible()
  const chips = await page.getByTestId('subcollections-chip').count()
  const rows = await page.getByTestId('grid-row').count()
  expect(chips).toBeGreaterThan(0)
  expect(chips).toBeLessThan(rows)
})

test('a screen of rows asks for its subcollections once, not once a row', async ({ page }) => {
  const batches: string[][] = []
  let perDocument = 0
  page.on('request', (request) => {
    const url = request.url()
    if (url.endsWith('/firestore/subcollections')) {
      const body = JSON.parse(request.postData() ?? '{}') as { paths?: string[] }
      batches.push(body.paths ?? [])
    }
    if (url.includes(':listCollectionIds')) perDocument += 1
  })
  await page.goto(`${origin()}/console/firestore?path=users`)
  await expect(page.getByTestId('subcollections-chip').first()).toBeVisible()
  const rows = await page.getByTestId('grid-row').count()
  expect(rows).toBeGreaterThan(10)

  // One request for the whole screen, naming every row it drew.
  expect(batches).toHaveLength(1)
  expect(batches[0]?.length).toBe(rows)
  expect(batches[0]?.[0]).toMatch(/^users\//)
  // And no per-document listing at all: that fan-out is what the batch
  // replaced, and it is what made scrolling a large collection expensive.
  expect(perDocument).toBe(0)

  // The counts came with the names, so no chip needs a request of its own.
  await expect(
    page.getByTestId('subcollection-link').filter({ hasText: 'orders' }).first(),
  ).toHaveText(/^orders\d+$/)

  // Opening a row reads the answer the grid already has. The id cell, not
  // the row's centre, which may land on a chip and navigate instead.
  const nested = page
    .getByTestId('grid-row')
    .filter({ has: page.getByTestId('subcollections-chip') })
    .first()
  await nested.getByRole('cell').nth(1).click()
  await expect(page.getByTestId('inspector')).toBeVisible()
  await expect(page.getByTestId('subcollections')).toContainText('Subcollections')
  expect(batches).toHaveLength(1)
  expect(perDocument).toBe(0)
})

test('the toolbar groups hold, and never overlap, as it narrows', async ({ page }) => {
  // The controls that act on the path lead the row, so they are in the same
  // place whatever the path is: a path changes length with every move, and a
  // control that slides with it can never be aimed at.
  const scopeAt = async (path: string) => {
    await page.goto(`${origin()}/console/firestore?path=${path}`)
    await expect(page.getByTestId('grid-row').first()).toBeVisible()
    return (await page.getByTestId('scope-picker').boundingBox())!.x
  }
  const near = await scopeAt('users')
  const far = await scopeAt('users/u_k65eq/orders')
  expect(far).toBe(near)
  // And the path runs after them, not before.
  const segments = (await page.getByTestId('path-segments').boundingBox())!.x
  expect(segments).toBeGreaterThan(edge(await page.getByTestId('path-controls').boundingBox()))

  // Copy belongs to the path and sits inside its field, against the right
  // edge: the end of the path wherever the path ends, and a target that a
  // longer path does not move.
  const copyAt = async (path: string) => {
    await page.goto(`${origin()}/console/firestore?path=${path}`)
    await expect(page.getByTestId('grid-row').first()).toBeVisible()
    return (await page.getByRole('button', { name: 'Copy the path' }).boundingBox())!
  }
  const shortPath = await copyAt('users')
  const longPath = await copyAt('users/u_k65eq/orders')
  expect(longPath.x).toBe(shortPath.x)
  const field = await page.getByTestId('path-field').boundingBox()
  expect(edge(longPath)).toBeLessThanOrEqual(edge(field))
  expect(edge(longPath)).toBeGreaterThan(edge(field) - 8)
  // The field ends exactly where the row's clip does, and a Tailwind `ring`
  // is a shadow painted outside the box — so an outline here loses its right
  // edge and the field reads as open-ended. At rest it is a fill, which
  // cannot be clipped; the outline belongs to focus, by which time the clip
  // has lifted for the completions.
  const chrome = await page
    .getByTestId('path-field')
    .evaluate((el) => el.ownerDocument.defaultView!.getComputedStyle(el).boxShadow)
  expect(chrome).toBe('none')

  for (const width of [1440, 1280, 1152, 1024]) {
    await page.setViewportSize({ width, height: 760 })
    await expect(page.getByTestId('grid-row').first()).toBeVisible()
    // Nothing paints over its neighbour: the path and its controls end
    // before the group that reports state begins, and New is last.
    const controls = edge(await page.getByTestId('view-as').boundingBox())
    const newMenu = await page.getByTestId('new-menu').boundingBox()
    expect(controls).toBeLessThanOrEqual(newMenu!.x + 1)
    expect(edge(newMenu)).toBeLessThanOrEqual(width)
    // And the toolbar itself never scrolls sideways.
    const overflow = await page
      .getByTestId('toolbar')
      .evaluate((el) => el.scrollWidth - el.clientWidth)
    expect(overflow).toBeLessThanOrEqual(1)
    // The path bar clips rather than painting over its neighbour, so a
    // control that no longer fits inside it disappears instead of
    // overlapping. Whatever else gives way, the scope must not.
    const bar = edge(await page.getByTestId('path-bar').boundingBox())
    expect(edge(await page.getByTestId('path-controls').boundingBox())).toBeLessThanOrEqual(bar + 1)
  }
})

test('one type scale holds across the grid and the panel beside it', async ({ page }) => {
  await page.goto(`${origin()}/console/firestore?path=users%2Fu_k65eq%2Forders`)
  await expect(page.getByTestId('grid-row').first()).toBeVisible()
  await page.getByTestId('grid-row').first().click()
  await expect(page.getByTestId('inspector')).toBeVisible()

  // Every rendered run of text, as `<size> <face>`. A block that names no
  // size of its own inherits one, and an `em` measures against whatever
  // ancestor happens to be set — which is how one row came to hold five
  // sizes at once. Reading them back is the only way to see that.
  const scale = (testId: string) =>
    page
      .getByTestId(testId)
      .first()
      .evaluate((root) => {
        const found = new Set<string>()
        for (const el of root.querySelectorAll('*')) {
          const own = [...el.childNodes]
            .filter((node) => node.nodeType === 3)
            .map((node) => node.textContent?.trim() ?? '')
            .join('')
          if (!own) continue
          const style = el.ownerDocument.defaultView!.getComputedStyle(el)
          found.add(`${style.fontSize} ${/mono|plex/i.test(style.fontFamily) ? 'mono' : 'sans'}`)
        }
        return [...found].toSorted()
      })

  // A row is the grid's 12 px, with 11 px for the detail beside a value —
  // the exact stamp under a relative time, the count in a container's chip.
  // The relative time is the only English in it, so the only sans.
  expect(await scale('grid-row')).toEqual(['11px mono', '12px mono', '12px sans'])

  // Every value in the panel is set the same way, whatever its type: a
  // string left in the interface face was two pixels larger than the
  // timestamp above it.
  const values = await page.getByTestId('inspector').evaluate((root) =>
    [...root.querySelectorAll('input, textarea')]
      .filter((el) => el.getAttribute('type') !== 'checkbox')
      .map((el) => {
        const style = el.ownerDocument.defaultView!.getComputedStyle(el)
        return `${style.fontSize} ${/mono|plex/i.test(style.fontFamily) ? 'mono' : 'sans'}`
      }),
  )
  expect([...new Set(values)]).toEqual(['12px mono'])
})

test('a type is named once, and only a column at odds with itself is coloured', async ({
  page,
}) => {
  // Two documents that disagree about `amount`, so one column is mixed and
  // the others are not.
  const written = await page.request.post(`${documents()}:commit`, {
    headers: owner,
    data: {
      writes: [
        {
          update: {
            name: `${resource()}/typecheck/one`,
            fields: { amount: { integerValue: '3' }, label: { stringValue: 'a' } },
          },
        },
        {
          update: {
            name: `${resource()}/typecheck/two`,
            fields: { amount: { stringValue: 'three' }, label: { nullValue: null } },
          },
        },
      ],
    },
  })
  expect(written.ok()).toBeTruthy()

  await page.goto(`${origin()}/console/firestore?path=typecheck`)
  await expect(page.getByTestId('grid-row')).toHaveCount(2)

  // The word names the type, so the chip does not need a colour to repeat
  // it: every settled column is drawn exactly alike, whatever its type.
  const grounds = await page
    .locator('thead [data-testid="type-badge"]:not([data-mixed])')
    .evaluateAll((badges) =>
      badges.map((el) => el.ownerDocument.defaultView!.getComputedStyle(el).backgroundColor),
    )
  expect(grounds.length).toBeGreaterThan(1)
  expect(new Set(grounds).size).toBe(1)

  // And the one column that disagrees with itself is the only thing in the
  // header wearing a colour at all.
  const mixed = page.locator('thead [data-testid="type-badge"][data-mixed]')
  await expect(mixed).toHaveCount(1)
  await expect(mixed).toHaveText(/string|integer|number/)
  expect(
    await mixed.evaluate(
      (el) => el.ownerDocument.defaultView!.getComputedStyle(el).backgroundColor,
    ),
  ).not.toBe(grounds[0])

  // Firestore has no schema, so a field is whatever each document makes it
  // and `null` is a value like any other — the way an optional field is
  // written, so that `== null` can find it. `label` is a string in one
  // document and null in the other, and that is not the bug the mark is
  // for: it stays a string column, drawn like every settled one.
  const label = page.locator('thead [data-testid="type-badge"]', { hasText: 'string' }).last()
  await expect(label).not.toHaveAttribute('data-mixed', '')
  await expect(page.getByTestId('cell-label').first()).not.toHaveClass(/warning/)

  // A mark nobody has seen before cannot have its only explanation in a
  // tooltip, so the column's own menu says what it found — and a column
  // that is merely sometimes null says so too, just without the colour.
  await page.getByTestId('column-amount').click()
  await expect(page.getByRole('menu')).toContainText('More than one type here')
  await expect(page.getByRole('menu')).toContainText('×1')
  await page.keyboard.press('Escape')
  await page.getByTestId('column-label').click()
  await expect(page.getByRole('menu')).toContainText('What this column holds')
  await expect(page.getByRole('menu')).toContainText('string ×1, null ×1')
  await page.keyboard.press('Escape')

  const removed = await page.request.post(`${documents()}:commit`, {
    headers: owner,
    data: {
      writes: [
        { delete: `${resource()}/typecheck/one` },
        { delete: `${resource()}/typecheck/two` },
      ],
    },
  })
  expect(removed.ok()).toBeTruthy()
})

test('the scope picker names both scopes, and reads what it says', async ({ page }) => {
  await page.goto(`${origin()}/console/firestore?path=users`)
  await expect(page.getByTestId('grid-row').first()).toBeVisible()
  // At rest it says which scope you are in, not what clicking would do.
  await expect(page.getByTestId('scope-picker')).toContainText('This collection')
  await page.getByTestId('scope-picker').click()
  // `users` sits at the root and nothing else carries the id, so the group
  // reads the same documents — the menu says so rather than leaving you to
  // toggle it and wonder why nothing moved.
  await expect(page.getByTestId('scope-one')).toContainText('240')
  await expect(page.getByTestId('scope-all')).toContainText('240')
  await expect(page.getByTestId('scope-all')).toContainText('The only users in the database')
  await page.keyboard.press('Escape')

  // A subcollection is the case where the two scopes differ: this user's
  // orders, against every user's.
  await page.goto(`${origin()}/console/firestore?path=users/u_k65eq/orders`)
  await expect(page.getByTestId('grid-row').first()).toBeVisible()
  await page.getByTestId('scope-picker').click()
  await expect(page.getByTestId('scope-one')).toContainText('Only the one under users/u_k65eq')
  await expect(page.getByTestId('scope-all')).toContainText(/\d+ of them/)
  const mine = Number((await page.getByTestId('scope-one').innerText()).match(/\d+/)?.[0])
  await page.getByTestId('scope-all').click()
  await expect(page).toHaveURL(/group=true/)
  await expect(page.getByTestId('scope-picker')).toContainText('All orders')
  // Every order in the database, named by path because an id no longer
  // identifies a row.
  await expect(page.getByRole('table').locator('thead')).toContainText('path')
  await expect(page.getByTestId('grid-row').first()).toContainText(/users\/[^/]+\/orders\//)
  const all = Number((await page.getByTestId('match-count').innerText()).replace(/[^\d].*$/, ''))
  expect(all).toBeGreaterThan(mine)

  // g flips it back without opening the menu.
  await page.keyboard.press('g')
  await expect(page).not.toHaveURL(/group=true/)
  await expect(page.getByTestId('scope-picker')).toContainText('This collection')
})

test('the schema tree shows the shape and opens a nested pattern as its group', async ({
  page,
}) => {
  const schema = await page.request.get(
    `${origin()}/console/api/v1/firestore/schema?database=(default)`,
  )
  expect(schema.status()).toBe(200)
  const tree = (await schema.json()) as {
    documents: number
    collections: Array<{
      id: string
      documents: number
      children: Array<{
        id: string
        pattern: string
        documents: number
        parents: number | null
        children: Array<{ id: string; pattern: string }>
      }>
    }>
  }
  const users = tree.collections.find((node) => node.id === 'users')
  expect(users).toBeDefined()
  const ordersNode = users?.children.find((node) => node.id === 'orders')
  expect(ordersNode?.pattern).toBe('users/*/orders')
  expect(ordersNode?.parents).toBeGreaterThan(0)
  expect(ordersNode?.children.map((node) => node.pattern)).toEqual(['users/*/orders/*/items'])

  await page.goto(`${origin()}/console/firestore?path=users`)
  const panel = page.getByTestId('section-panel')
  await expect(panel).toBeVisible()
  await expect(
    panel.getByTestId('schema-node').filter({ hasText: 'users' }).first(),
  ).toHaveAttribute('aria-current', 'location')
  // Only the path to where you are is open: orders shows under users, but
  // what lies under orders waits behind its caret.
  const orders = panel.locator('[data-pattern="users/*/orders"]')
  const items = panel.locator('[data-pattern="users/*/orders/*/items"]')
  await expect(orders).toBeVisible()
  await expect(items).toHaveCount(0)
  await expect(panel.locator('[data-pattern="products/*/reviews"]')).toHaveCount(0)
  await expect(panel.getByTestId('schema-summary')).toContainText('users')

  // The filter narrows the tree to matching ids and the way to them.
  await panel.getByTestId('schema-filter').fill('item')
  await expect(items).toBeVisible()
  await expect(panel.locator('[data-pattern="users/*/sessions"]')).toHaveCount(0)
  await expect(panel.locator('[data-pattern="products"]')).toHaveCount(0)
  await panel.getByTestId('schema-filter').press('Escape')
  await expect(panel.getByTestId('schema-filter')).toHaveValue('')
  await expect(items).toHaveCount(0)

  // A nested pattern opens as the collection group, with the full path per
  // row, and what lies under it opens in the tree.
  await orders.getByTestId('schema-node-open').click()
  await expect(page).toHaveURL(/path=users%2F\*%2Forders&group=true/)
  await expect(page.getByTestId('path-bar')).toContainText('*')
  // The scope picker names the scope it put you in, rather than saying `group`.
  await expect(page.getByTestId('scope-picker')).toContainText('All orders')
  await expect(page.getByTestId('grid-row').first()).toContainText(/users\/[^/]+\/orders\//)
  await expect(items).toBeVisible()
  await expect(panel.getByTestId('schema-summary')).toContainText(
    `${ordersNode?.documents} documents`,
  )
  await expect(panel.getByTestId('schema-summary')).toContainText(`in ${ordersNode?.parents} of`)
  // Nothing can be created at a pattern.
  await page.getByTestId('new-menu').click()
  await expect(page.getByTestId('new-root-collection')).toBeVisible()
  await expect(page.getByRole('menuitem', { name: /Document in/ })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)

  // Collapsing a node hides its children; the panel hides with t and comes
  // back from the bar above it.
  await orders.getByTestId('schema-node-toggle').click()
  await expect(items).toHaveCount(0)
  await page.keyboard.press('t')
  await expect(panel).toBeHidden()
  await page.getByTestId('panel-toggle').click()
  await expect(panel).toBeVisible()

  // The tree follows the data: a new subcollection appears with its count
  // and goes when its last document goes.
  const note = `projects/${project()}/databases/(default)/documents/users/u_k65eq/notes/n_1`
  const created = await page.request.post(`${documents()}:commit`, {
    headers: owner,
    data: { writes: [{ update: { name: note, fields: { text: { stringValue: 'hello' } } } }] },
  })
  expect(created.ok()).toBeTruthy()
  const notes = panel.locator('[data-pattern="users/*/notes"]')
  await expect(notes).toContainText('1')
  const deleted = await page.request.post(`${documents()}:commit`, {
    headers: owner,
    data: { writes: [{ delete: note }] },
  })
  expect(deleted.ok()).toBeTruthy()
  await expect(notes).toHaveCount(0)
})

test('the path bar completes collections and shows missing ancestors', async ({ page }) => {
  await page.goto(`${origin()}/console/firestore`)
  await expect(page.getByTestId('root-collection').filter({ hasText: 'users' })).toBeVisible()
  await page.keyboard.press('/')
  const input = page.getByTestId('path-input')
  await input.fill('users/u_k65eq/ord')
  const suggestion = page.getByRole('button', { name: 'users/u_k65eq/orders' })
  await expect(suggestion).toBeVisible()
  // The completions hang below the toolbar from inside it, and the toolbar
  // clips what does not fit so its controls never paint over their
  // neighbours. A clipped popup is an invisible one, and neither Playwright's
  // visibility check nor its click sees that — the click scrolls the clipping
  // box first, which nobody using a mouse can do. So ask the page what is
  // actually painted where the suggestion claims to be.
  expect(
    await suggestion.evaluate((el) => {
      const box = el.getBoundingClientRect()
      const at = el.ownerDocument.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
      return el.contains(at)
    }),
  ).toBe(true)
  await input.press('Tab')
  await input.press('Enter')
  await expect(page).toHaveURL(/path=users%2Fu_k65eq%2Forders/)
  await expect(page.getByRole('table').locator('thead')).toContainText('customer')

  await page.goto(`${origin()}/console/firestore?path=teams`)
  const ghost = page.getByTestId('grid-row').filter({ hasText: 't_ghost' })
  await expect(ghost).toBeVisible()
  await ghost.click()
  await expect(page.getByTestId('inspector')).toContainText('No document here')
  await expect(page.getByTestId('inspector')).toContainText('members')
})

test('the New menu creates a typed root collection, and a subcollection grows from the inspector', async ({
  page,
}) => {
  await page.goto(`${origin()}/console/firestore?path=teams`)
  await expect(page.getByTestId('grid-row').first()).toBeVisible()
  await page.getByTestId('new-menu').click()
  await page.getByTestId('new-root-collection').click()
  await page.getByTestId('new-collection-id').fill('invoices')
  await page.getByTestId('new-document-id').fill('inv_001')
  await page.getByTestId('new-field-name').fill('total')
  await page.getByTestId('new-field-name').press('Enter')
  await press(page.getByRole('button', { name: 'total type: string' }))
  await page.getByRole('menuitemradio', { name: 'number' }).click()
  await page.getByLabel('total value').fill('120')
  await page.getByTestId('create-submit').click()
  await expect(page).toHaveURL(/path=invoices&doc=invoices%2Finv_001/)
  await expect(page.getByTestId('path-bar')).toContainText('invoices')
  await expect(page.getByRole('table').locator('thead')).toContainText('number')
  const stored = await page.request.get(`${documents()}/invoices/inv_001`, { headers: owner })
  const body = (await stored.json()) as { fields: Record<string, unknown> }
  expect(body.fields.total).toEqual({ integerValue: '120' })
  expect(body.fields.createdAt).toHaveProperty('timestampValue')

  // The inspector's subcollections section grows the tree from here.
  await expect(page.getByTestId('subcollections')).toContainText('None yet')
  await page.getByTestId('add-subcollection').click()
  await page.getByTestId('new-collection-id').fill('lines')
  await page.getByTestId('create-submit').click()
  await expect(page).toHaveURL(/path=invoices%2Finv_001%2Flines/)
  await expect(page.getByTestId('path-bar')).toContainText('lines')

  // An explicit id that already exists is refused, not overwritten.
  await page.goto(`${origin()}/console/firestore?path=invoices`)
  await expect(page.getByTestId('grid-row').first()).toBeVisible()
  await page.keyboard.press('n')
  await page.getByTestId('new-document-id').fill('inv_001')
  await page.getByTestId('create-submit').click()
  await expect(page.getByRole('dialog')).toContainText('invoices/inv_001 already exists')
})

test('column headers sort, filter and hide; a scalar cell edits in place', async ({ page }) => {
  await page.goto(`${origin()}/console/firestore?path=events`)
  await expect(page.getByTestId('grid-row').first()).toBeVisible()
  await page.getByTestId('column-type').click()
  await page.getByRole('menuitem', { name: 'Sort descending' }).click()
  await expect(page).toHaveURL(/q=orderBy%28%22type%22%2C\+%22desc%22%29/)
  await page.getByTestId('column-type').click()
  await page.getByRole('menuitem', { name: 'Filter by type' }).click()
  const input = page.getByTestId('query-input')
  await expect(input).toBeFocused()
  await expect(input).toHaveValue('orderBy("type", "desc").where("type", "==", )')
  await input.fill('where("type", "==", "payment.failed")')
  await input.press('Enter')
  await expect(page.getByText('type == "payment.failed"')).toBeVisible()
  await expect(page.getByTestId('grid-row').first()).toBeVisible()
  const before = await page.getByTestId('grid-row').count()
  expect(before).toBeGreaterThan(0)

  // Double-clicking the cell edits it where it is; the row leaves the filter.
  const cell = page.getByTestId('grid-row').first().locator('td').nth(5)
  const id = (await page.getByTestId('grid-row').first().locator('td').nth(1).innerText()).trim()
  await cell.dblclick()
  const editor = page.getByTestId('inline-cell-editor')
  await expect(editor).toBeFocused()
  await editor.fill('payment.retried')
  await editor.press('Enter')
  await expect(page.getByTestId('grid-row')).toHaveCount(before - 1)
  const stored = await page.request.get(`${documents()}/events/${id}`, { headers: owner })
  const body = (await stored.json()) as { fields: Record<string, unknown> }
  expect(body.fields.type).toEqual({ stringValue: 'payment.retried' })

  await page.getByTestId('column-payload').click()
  await page.getByRole('menuitem', { name: 'Hide column' }).click()
  await expect(page.getByRole('table').locator('thead')).not.toContainText('payload')
  await page.getByTestId('show-all-columns').click()
  await expect(page.getByRole('table').locator('thead')).toContainText('payload')
})

test('JSON imports as typed documents, and the palette jumps anywhere', async ({ page }) => {
  await page.goto(`${origin()}/console/firestore?path=teams`)
  await expect(page.getByTestId('grid-row').first()).toBeVisible()
  await page.getByTestId('new-menu').click()
  await page.getByTestId('new-import').click()
  await page
    .getByTestId('import-json')
    .fill('{"t_import": {"name": "Imported", "since": "2026-09-20T09:00:00Z"}}')
  await expect(page.getByTestId('import-preview')).toContainText('1 document')
  await page.getByTestId('import-submit').click()
  await expect(page.getByText('1 document imported')).toBeVisible()
  const stored = await page.request.get(`${documents()}/teams/t_import`, { headers: owner })
  const body = (await stored.json()) as { fields: Record<string, unknown> }
  expect(body.fields.since).toEqual({ timestampValue: '2026-09-20T09:00:00Z' })

  // A reference cell peeks at its target without leaving the grid.
  await page.goto(`${origin()}/console/firestore?path=events`)
  await page.getByTestId('grid-row').first().locator('td').nth(2).locator('button').click()
  await expect(page).toHaveURL(/path=events&doc=users%2F/)
  await expect(page.getByTestId('inspector')).toContainText('users/')
  await page.getByTestId('open-in-grid').click()
  await expect(page).toHaveURL(/path=users&doc=users%2F/)

  // ⌘K: the page's collections and recents join the console palette.
  await page.keyboard.press('ControlOrMeta+k')
  const palette = page.getByTestId('palette-input')
  await palette.fill('prod')
  await page.getByRole('option', { name: /^products — / }).click()
  await expect(page).toHaveURL(/path=products/)
  await page.keyboard.press('ControlOrMeta+k')
  await palette.fill('teams/t_real')
  await page.getByRole('option', { name: /Open this document/ }).click()
  await expect(page).toHaveURL(/path=teams&doc=teams%2Ft_real/)

  // The path bar offers to create what does not exist yet.
  await page.getByRole('button', { name: 'Edit the path' }).click()
  await page.getByTestId('path-input').fill('teams/t_real/notes')
  await page.getByTestId('path-create-collection').click()
  await expect(page.getByRole('dialog')).toContainText('New subcollection under teams/t_real')
  await expect(page.getByTestId('new-collection-id')).toHaveValue('notes')
})

test('a database a client writes to joins the picker and opens on its own', async ({ page }) => {
  await page.goto(`${origin()}/console/firestore`)
  const panel = page.getByTestId('section-panel')
  const picker = panel.getByTestId('database-select').getByRole('combobox')
  await expect(picker).toContainText('(default)')
  await expect(panel.locator('[data-pattern="users"]')).toBeVisible()

  // An app that opens `getFirestore(app, 'analytics')` and writes brings the
  // database into being; nothing in firebase.json declares it.
  const analytics = `projects/${project()}/databases/analytics/documents`
  const written = await page.request.post(
    `${origin()}/console/api/v1/firestore/v1/${analytics}:commit`,
    {
      headers: owner,
      data: {
        writes: [
          {
            update: {
              name: `${analytics}/events/e_first`,
              fields: { kind: { stringValue: 'pageview' } },
            },
          },
        ],
      },
    },
  )
  expect(written.ok()).toBeTruthy()

  // Opening the picker asks the engine again, so the new database is there.
  await picker.click()
  await page.getByRole('option', { name: 'analytics' }).click()
  await expect(page).toHaveURL(/db=analytics/)
  await expect(picker).toContainText('analytics')
  await expect(panel.locator('[data-pattern="events"]')).toBeVisible()
  await expect(panel.locator('[data-pattern="users"]')).toHaveCount(0)
  await expect(panel.getByTestId('schema-summary')).toContainText('1 root collection · 1 document')
  await panel.locator('[data-pattern="events"]').getByTestId('schema-node-open').click()
  await expect(page).toHaveURL(/db=analytics.*path=events|path=events.*db=analytics/)
  await expect(page.getByTestId('grid-row').first()).toContainText('e_first')

  // Back to the default database, which the URL leaves unnamed.
  await picker.click()
  await page.getByRole('option', { name: '(default)' }).click()
  await expect(page).not.toHaveURL(/db=/)
  await expect(panel.locator('[data-pattern="users"]')).toBeVisible()
})

test('a query that does not parse says so, and stays editable', async ({ page }) => {
  // The page query is switched off while the text is broken. A disabled
  // TanStack query reads as pending, which used to leave the grid claiming
  // to load for ever, with the offending text hidden behind the filter
  // button so there was nothing to correct.
  await page.goto(
    `${origin()}/console/firestore?path=users&q=where%28%22plan%22%2C%22%3D%3D%22%2C%22pro`,
  )
  await expect(page.getByTestId('query-unparsed')).toContainText('This query did not parse')
  await expect(page.getByText('Loading users…')).toHaveCount(0)

  // The text that failed is in the line, ready to be fixed in place.
  const input = page.getByTestId('query-input')
  await expect(input).toHaveValue('where("plan","==","pro')
  await input.fill('where("plan", "==", "pro")')
  await input.press('Enter')
  await expect(page.getByTestId('query-unparsed')).toHaveCount(0)
  await expect(page.getByTestId('grid-row').first()).toBeVisible()
})

test('the grid loads previews of heavy documents, and says so rather than lying', async ({
  page,
}) => {
  const root = `projects/${project()}/databases/(default)/documents`
  const long = 'L'.repeat(5000)
  const payload = Object.fromEntries(
    Array.from({ length: 60 }, (_, index) => [`k${index}`, { stringValue: 'y'.repeat(400) }]),
  )
  const written = await page.request.post(`${documents()}:commit`, {
    headers: owner,
    data: {
      writes: [
        {
          update: {
            name: `${root}/heavy/h_1`,
            fields: {
              status: { stringValue: 'queued' },
              note: { stringValue: long },
              result: { mapValue: { fields: payload } },
              tags: {
                arrayValue: {
                  values: Array.from({ length: 40 }, (_, i) => ({ stringValue: `tag${i}` })),
                },
              },
            },
          },
        },
      ],
    },
  })
  expect(written.ok()).toBeTruthy()

  let pageBytes = 0
  page.on('response', async (response) => {
    if (!response.url().endsWith(':runQuery')) return
    pageBytes += (await response.body().catch(() => Buffer.alloc(0))).length
  })
  await page.goto(`${origin()}/console/firestore?path=heavy`)
  const row = page.getByTestId('grid-row').first()
  await expect(row).toBeVisible()
  await page.waitForTimeout(400)

  // The whole document is about 29 KB; the grid draws it from a fraction.
  expect(pageBytes).toBeGreaterThan(0)
  expect(pageBytes).toBeLessThan(10_000)

  // The counts are the engine's, not a count of what happened to arrive.
  await expect(row.getByText('{60}')).toBeVisible()
  await expect(row.getByText('[40]')).toBeVisible()

  // A cut string says it is cut instead of passing the fragment off whole.
  const note = row.getByTestId('cell-note')
  await expect(note).toContainText('…')
  await expect(note.getByTitle(/more bytes — open the row to read it all/)).toBeVisible()

  // And it refuses to be edited in place, which would save the fragment.
  await note.dblclick()
  await expect(note.locator('input')).toHaveCount(0)

  // The inspector holds the whole value, because it fetches the document.
  await row.getByRole('cell').nth(1).click()
  const inspector = page.getByTestId('inspector')
  await expect(inspector).toBeVisible()
  await expect(inspector.getByRole('textbox', { name: 'note value' })).toHaveValue(long)
})

test('a long field name keeps its column, and its controls, in bounds', async ({ page }) => {
  const field = 'aVeryLongFieldNameThatGoesOnAndOnForQuiteAWhileIndeed'
  const root = `projects/${project()}/databases/(default)/documents`
  const written = await page.request.post(`${documents()}:commit`, {
    headers: owner,
    data: {
      writes: [
        {
          update: {
            name: `${root}/widefields/w_1`,
            fields: { [field]: { stringValue: 'yes' }, after: { stringValue: 'visible' } },
          },
        },
      ],
    },
  })
  expect(written.ok()).toBeTruthy()

  await page.goto(`${origin()}/console/firestore?path=widefields`)
  await expect(page.getByTestId('grid-row').first()).toBeVisible()
  // One long name must not push every other column off the screen.
  const header = page.getByTestId(`column-${field}`)
  const width = (await header.boundingBox())?.width ?? 0
  expect(width).toBeLessThanOrEqual(320)
  await expect(page.getByTestId('column-after')).toBeVisible()

  // In the inspector the same name truncates rather than carrying the type
  // badge and the remove button out past the panel's edge.
  await page.getByTestId('grid-row').first().click()
  const panel = page.getByTestId('inspector')
  const remove = panel.getByRole('button', { name: `Remove ${field}` })
  await expect(remove).toBeVisible()
  expect(edge(await remove.boundingBox())).toBeLessThanOrEqual(edge(await panel.boundingBox()))
})

test('explain names what the query reads, and the index production would need', async ({
  page,
}) => {
  await page.goto(`${origin()}/console/firestore?path=users`)
  await expect(page.getByTestId('grid-row').first()).toBeVisible()

  // An unfiltered collection: the finding is that it reads everything.
  await page.keyboard.press('e')
  const panel = page.getByTestId('explain-panel')
  await expect(panel.getByTestId('explain-headline')).toHaveText('Reads every document in users')
  await expect(panel.getByTestId('explain-matched')).toHaveText('matched240 documents')
  await expect(panel.getByTestId('explain-order')).toContainText('__name__ asc')
  // Nothing to declare for a query production indexes by itself.
  await expect(page.getByTestId('explain-index')).toBeHidden()

  // The composite this project declares: confirmed, with nothing to do.
  const input = page.getByTestId('query-input')
  await input.fill('where("plan", "==", "pro").orderBy("lastSeen", "desc")')
  await input.press('Enter')
  const declared = page.getByTestId('explain-index')
  await expect(declared).toHaveAttribute('data-declared', 'true')
  await expect(declared).toContainText('firestore.indexes.json declares')
  await expect(page.getByTestId('copy-index-entry')).toBeHidden()

  // A composite it does not declare: the warning, and the entry to paste.
  await input.fill('where("plan", "==", "pro").orderBy("displayName", "asc")')
  await input.press('Enter')
  const missing = page.getByTestId('explain-index')
  await expect(missing).toHaveAttribute('data-declared', 'false')
  await expect(missing).toContainText('Production needs a composite index')
  await page.getByTestId('copy-index-entry').click()
  await expect(page.getByTestId('copy-index-entry')).toContainText('Copied')
  // What it copies has to be a real index file entry for this query.
  const copied = await page.evaluate(() =>
    (navigator as Navigator & { clipboard: { readText(): Promise<string> } }).clipboard.readText(),
  )
  expect(JSON.parse(copied)).toMatchObject({
    collectionGroup: 'users',
    queryScope: 'COLLECTION',
    fields: [
      { fieldPath: 'plan', order: 'ASCENDING' },
      { fieldPath: 'displayName', order: 'ASCENDING' },
    ],
  })

  // The filter narrows by the field index rather than reading the collection.
  await expect(panel.getByTestId('explain-headline')).toHaveText('Narrows users by the plan index')
  await page.getByLabel('Close the query plan').click()
  await expect(page.getByTestId('explain-panel')).toBeHidden()
})

test('export writes the whole result, in the shape asked for', async ({ page }) => {
  await page.goto(`${origin()}/console/firestore?path=products`)
  await expect(page.getByTestId('grid-row').first()).toBeVisible()

  // The whole collection, keyed by id, as the console's own import reads it.
  await page.getByTestId('export-open').click()
  await expect(page.getByTestId('export-scope')).toHaveText('Every document in products')
  const jsonDownload = page.waitForEvent('download')
  await page.getByTestId('confirm-export').click()
  const json = await jsonDownload
  expect(json.suggestedFilename()).toMatch(/^products-[\d-]+\.json$/)
  const exported = JSON.parse(await readDownload(json)) as Record<string, Record<string, unknown>>
  expect(Object.keys(exported)).toHaveLength(60)
  const [, first] = Object.entries(exported)[0] ?? []
  expect(typeof first?.name).toBe('string')

  // A query narrows the export, and CSV flattens it for a spreadsheet.
  const input = page.getByTestId('query-input')
  await page.keyboard.press('f')
  await input.fill('where("published", "==", false)')
  await input.press('Enter')
  await expect(page.getByTestId('match-count')).toContainText(/\d+ documents/)
  const matched = Number(
    (await page.getByTestId('match-count').innerText()).replace(/[^\d].*$/, ''),
  )
  expect(matched).toBeGreaterThan(0)
  expect(matched).toBeLessThan(60)

  await page.getByTestId('export-open').click()
  await expect(page.getByTestId('export-scope')).toContainText('where("published", "==", false)')
  await page.getByRole('tab', { name: 'CSV' }).click()
  const csvDownload = page.waitForEvent('download')
  await page.getByTestId('confirm-export').click()
  const csv = await csvDownload
  const lines = (await readDownload(csv)).trim().split('\n')
  expect(lines).toHaveLength(matched + 1)
  expect(lines[0]).toContain('__id__')
  // A nested map becomes dotted columns; an array stays in one.
  expect(lines[0]).toContain('dimensions.w')
  expect(lines[0]).toContain('categories')
})

test('a typed export imports back as the same documents', async ({ page }) => {
  // A reference, a geopoint and bytes have no plain-JSON form that survives
  // a round trip, so this is the export that has to keep them.
  const created = await page.request.post(`${documents()}:commit`, {
    headers: owner,
    data: {
      writes: [
        {
          update: {
            name: `${resource()}/roundtrip/one`,
            fields: {
              label: { stringValue: 'keep me' },
              owner: { referenceValue: `${resource()}/users/u_k65eq` },
              where: { geoPointValue: { latitude: 51.5, longitude: -0.12 } },
              blob: { bytesValue: 'ZmlyZW5vb2s=' },
              when: { timestampValue: '2026-03-04T05:06:07Z' },
              count: { integerValue: '42' },
            },
          },
        },
      ],
    },
  })
  expect(created.ok(), await created.text()).toBeTruthy()
  await page.goto(`${origin()}/console/firestore?path=roundtrip`)
  await expect(page.getByTestId('grid-row')).toHaveCount(1)

  await page.getByTestId('export-open').click()
  await page.getByRole('checkbox', { name: 'Keep Firestore types exactly' }).click()
  const download = page.waitForEvent('download')
  await page.getByTestId('confirm-export').click()
  const text = await readDownload(await download)
  expect(JSON.parse(text)).toMatchObject({
    one: {
      label: { stringValue: 'keep me' },
      where: { geoPointValue: { latitude: 51.5, longitude: -0.12 } },
      blob: { bytesValue: 'ZmlyZW5vb2s=' },
      when: { timestampValue: '2026-03-04T05:06:07Z' },
    },
  })

  // Importing that file back reproduces the types, instead of storing the
  // wrappers as maps. The id in the file is taken, so it lands beside it.
  await page.getByTestId('new-menu').click()
  await page.getByTestId('new-import').click()
  await page.getByTestId('import-json').fill(text.replace('"one"', '"two"'))
  await expect(page.getByTestId('import-preview')).toContainText('1 document')
  await page.getByTestId('import-submit').click()
  await expect(page.getByText('1 document imported')).toBeVisible()

  const back = await page.request.get(`${documents()}/roundtrip`, { headers: owner })
  const listed = (await back.json()) as {
    documents: { name: string; fields: Record<string, unknown> }[]
  }
  const copy = listed.documents.find((item) => item.name.endsWith('/two'))
  expect(copy?.fields).toMatchObject({
    label: { stringValue: 'keep me' },
    owner: { referenceValue: `${resource()}/users/u_k65eq` },
    where: { geoPointValue: { latitude: 51.5, longitude: -0.12 } },
    blob: { bytesValue: 'ZmlyZW5vb2s=' },
    when: { timestampValue: '2026-03-04T05:06:07Z' },
    count: { integerValue: '42' },
  })
})

/** A download's bytes, as text. */
async function readDownload(download: { path(): Promise<string> }): Promise<string> {
  const { readFile } = await import('node:fs/promises')
  return readFile(await download.path(), 'utf8')
}

test('a change can be undone, and refuses when something moved on', async ({ page }) => {
  const path = `${resource()}/undoable/one`
  const write = (text: string) =>
    page.request.post(`${documents()}:commit`, {
      headers: owner,
      data: { writes: [{ update: { name: path, fields: { note: { stringValue: text } } } }] },
    })
  expect((await write('first')).ok()).toBeTruthy()

  await page.goto(`${origin()}/console/firestore?path=undoable`)
  await expect(page.getByTestId('grid-row')).toHaveCount(1)
  expect((await write('second')).ok()).toBeTruthy()
  // The live channel brings the new value and the new entry without a reload.
  await expect(page.getByTestId('grid-row').first()).toContainText('second')

  await page.getByTestId('changes-trigger').click()
  const popover = page.getByTestId('changes-popover')
  await expect(popover).toContainText('1 updated')
  await expect(popover).toContainText('one')

  // Undo puts the document back as it was, exactly.
  await popover.getByRole('button', { name: 'Undo' }).first().click()
  await expect(page.getByText('Change undone')).toBeVisible()
  await expect(page.getByTestId('grid-row').first()).toContainText('first')

  // The undo is itself a change, and the original now says so.
  await page.getByTestId('changes-trigger').click()
  await expect(page.getByTestId('changes-popover')).toContainText('Undid an earlier change')
  await expect(page.getByTestId('changes-popover').getByText('undone')).toBeVisible()
  await page.keyboard.press('Escape')

  // A write that lands after a change makes its undo refuse, whole. The
  // entry is found by its own id rather than its position, because every
  // other journey writes to this database too.
  expect((await write('third')).ok()).toBeTruthy()
  await expect(page.getByTestId('grid-row').first()).toContainText('third')
  await page.getByTestId('changes-trigger').click()
  const undoThird = await page
    .getByTestId('changes-popover')
    .locator('li')
    .first()
    .getByRole('button', { name: 'Undo' })
    .getAttribute('data-testid')
  expect(undoThird).toMatch(/^undo-\d+$/)

  // The popover stays open while the write lands: the live channel keeps
  // the list current, so the entry is still there and still identified.
  expect((await write('fourth')).ok()).toBeTruthy()
  await expect(page.getByTestId('changes-popover')).toContainText('1 updated')
  await page.getByTestId(undoThird ?? 'undo-missing').click()
  await expect(page.getByRole('heading', { name: 'Nothing was undone' })).toBeVisible()
  await expect(page.getByText('a document has changed since')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('grid-row').first()).toContainText('fourth')
})

test('rules are text you can change, and the change is in force at once', async ({ page }) => {
  await page.goto(`${origin()}/console/firestore?path=users`)
  // Viewing as a user: her own document reads, another's does not.
  const asAda = `?path=users&as=u_k65eq%3Aada%40example.test`
  await page.goto(`${origin()}/console/firestore${asAda}`)
  await expect(page.getByText('Denied by security rules')).toBeVisible()

  await page.getByTestId('open-rules').click()
  const editor = page.getByTestId('rules-editor')
  await expect(editor).toContainText('Rules')
  const source = page.getByTestId('rules-source')
  await expect(source).toHaveValue(/allow read: if request.auth != null/)
  // The file it would save to is named, so nothing is written by surprise.
  await expect(editor).toContainText('firestore.rules')

  // Rules that do not compile change nothing, and say where.
  const original = (await source.inputValue()) as string
  await source.fill('service cloud.firestore { match')
  await page.getByTestId('rules-apply').click()
  await expect(page.getByRole('heading', { name: 'Nothing changed' })).toBeVisible()
  const problems = page.getByTestId('rules-diagnostics')
  await expect(problems).toBeVisible()
  await expect(problems.locator('li').first()).toContainText(/^\d+:\d+ /)

  // A ruleset that opens the collection takes effect on the next request.
  await source.fill(
    [
      "rules_version = '2';",
      'service cloud.firestore {',
      '  match /databases/{database}/documents {',
      '    match /{document=**} {',
      '      allow read: if true;',
      '    }',
      '  }',
      '}',
    ].join('\n'),
  )
  await page.getByTestId('rules-apply').click()
  await expect(page.getByRole('heading', { name: 'Rules applied' })).toBeVisible()
  await page.goto(`${origin()}/console/firestore${asAda}`)
  await expect(page.getByTestId('grid-row').first()).toBeVisible()
  await expect(page.getByText('Denied by security rules')).toBeHidden()

  // Put the project back as it was, applied but not written to the file.
  await page.getByTestId('open-rules').click()
  const restored = page.getByTestId('rules-source')
  // Wait for the editor to hold what is in force before replacing it: a
  // fill that lands while the fetch is still in flight is merged, not
  // replaced, by the controlled textarea.
  await expect(restored).toHaveValue(/allow read: if true/)
  await restored.fill(original)
  await expect(restored).toHaveValue(original)
  await page.getByTestId('rules-apply').click()
  await expect(page.getByRole('heading', { name: 'Rules applied' })).toBeVisible()
  await page.getByTestId('rules-close').click()
  await expect(page.getByTestId('toolbar')).toBeVisible()
})

/**
 * Whether the element is the thing the document paints at its own centre.
 * Playwright's own checks cannot answer this: `toBeVisible` does not test
 * for a clip by an ancestor's `overflow: hidden`, and `click` scrolls the
 * clipping box first, which no person can do. Both walked straight through
 * a popup that had been invisible for months.
 */
async function paintedAtItsOwnCentre(locator: Locator): Promise<boolean> {
  return locator.evaluate((el) => {
    const box = el.getBoundingClientRect()
    const hit = el.ownerDocument.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
    return el === hit || el.contains(hit)
  })
}

/** Whether anything above this element is holding it at zero opacity. */
async function faded(handle: Locator): Promise<boolean> {
  return handle.evaluate((el) => {
    const view = el.ownerDocument.defaultView!
    for (let node = el.parentElement; node; node = node.parentElement)
      if (Number(view.getComputedStyle(node).opacity) < 0.05) return true
    return false
  })
}

/**
 * Point at a row, then press one of its controls. The strip holding them is
 * drawn — and takes a click — only while its own line is under the pointer,
 * so reaching straight for a button that nothing is pointing at is asking
 * for something no person can do.
 */
async function press(control: Locator) {
  await control.locator('xpath=ancestor::*[@data-testid="field-row"][1]/*[1]').hover()
  await control.click()
}

/** Where a field's text begins, padding included — its column. */
async function textLeft(field: Locator): Promise<number> {
  return field.evaluate((el) => {
    const view = el.ownerDocument.defaultView!
    return (
      el.getBoundingClientRect().left + Number.parseFloat(view.getComputedStyle(el).paddingLeft)
    )
  })
}

/** Whether the text in a field runs past the box drawn around it. */
async function clipped(field: Locator): Promise<boolean> {
  return field.evaluate(
    (el) => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1,
  )
}

/** How many text lines a field is drawn across. */
async function lineCount(field: Locator): Promise<number> {
  const box = await field.boundingBox()
  return Math.round((box?.height ?? 0) / 18)
}

/** A document written straight to the engine, bypassing the console. */
async function put(
  request: { post: (url: string, options: object) => Promise<{ ok: () => boolean }> },
  path: string,
  fields: Record<string, unknown>,
) {
  const response = await request.post(`${documents()}:commit`, {
    headers: owner,
    data: { writes: [{ update: { name: `${resource()}/${path}`, fields } }] },
  })
  expect(response.ok()).toBeTruthy()
}

async function drop(
  request: { post: (url: string, options: object) => Promise<{ ok: () => boolean }> },
  ...paths: string[]
) {
  await request.post(`${documents()}:commit`, {
    headers: owner,
    data: { writes: paths.map((path) => ({ delete: `${resource()}/${path}` })) },
  })
}

test('a nested value edits as rows, and a rename is the same single write', async ({ page }) => {
  await put(page.request, 'teams/t_nested', {
    title: { stringValue: 'Nested' },
    legacy: { stringValue: 'drop me' },
    lead: { referenceValue: `${resource()}/users/u_k65eq` },
    billing: {
      mapValue: {
        fields: {
          currency: { stringValue: 'MYR' },
          contacts: {
            arrayValue: {
              values: [{ mapValue: { fields: { email: { stringValue: 'ada@example.test' } } } }],
            },
          },
        },
      },
    },
  })
  await page.goto(`${origin()}/console/firestore?path=teams&doc=teams%2Ft_nested`)
  const inspector = page.getByTestId('inspector')

  // A map is rows. Its entries — and the entries of the array inside it —
  // are edited where they are, not in a JSON textarea standing in for them.
  await expect(inspector.getByLabel('currency value')).toHaveValue('MYR')
  await inspector.getByLabel('email value').fill('grace@example.test')

  // An entry added to the map in place: name it, Enter, type the value.
  await press(inspector.getByLabel('Add to billing'))
  await expect(inspector.getByLabel('Field name', { exact: true })).toBeFocused()
  await page.keyboard.type('plan')
  await page.keyboard.press('Enter')
  await page.keyboard.type('pro')

  // A reference completes the path it is pointing at, a segment at a time.
  // Its list hangs off a row inside the scrolling column, where an
  // `absolute` popup is an invisible one the moment the row nears an edge:
  // `toBeVisible` cannot see that, and a click scrolls the clipping box
  // first, which nobody can do. So ask the document what it paints there.
  await inspector.getByLabel('lead value').fill('users/u_k6')
  const paths = page.getByTestId('reference-completions')
  await expect(paths).toContainText('u_k65eq')
  expect(await paintedAtItsOwnCentre(paths.getByRole('button').first())).toBe(true)
  await paths.getByRole('button', { name: /u_k65eq/ }).click()

  // Firestore has no rename: this is a delete and a set, in this document
  // alone, and the row says so before it is saved.
  await inspector.getByLabel('title name').fill('heading')
  await expect(inspector).toContainText('changes this document only')

  // A removal is shown on its own row, and can be taken back.
  await press(inspector.getByLabel('Remove legacy'))
  await expect(inspector).toContainText('Removed on save')
  await inspector.getByLabel('Keep legacy').click()
  await expect(inspector.getByLabel('legacy value')).toHaveValue('drop me')
  await press(inspector.getByLabel('Remove legacy'))

  await inspector.getByTestId('save-document').click()
  await expect(page.getByText('Document saved')).toBeVisible()

  const stored = await page.request.get(`${documents()}/teams/t_nested`, { headers: owner })
  const body = (await stored.json()) as { fields: Record<string, Record<string, never>> }
  expect(body.fields.heading).toEqual({ stringValue: 'Nested' })
  expect(body.fields.lead).toEqual({ referenceValue: `${resource()}/users/u_k65eq` })
  expect(body.fields.title).toBeUndefined()
  expect(body.fields.legacy).toBeUndefined()
  expect(body.fields.billing).toEqual({
    mapValue: {
      fields: {
        currency: { stringValue: 'MYR' },
        plan: { stringValue: 'pro' },
        contacts: {
          arrayValue: {
            values: [{ mapValue: { fields: { email: { stringValue: 'grace@example.test' } } } }],
          },
        },
      },
    },
  })
  await drop(page.request, 'teams/t_nested')
})

test('an integer and a double are told apart, and stay that way', async ({ page }) => {
  await put(page.request, 'teams/t_numbers', {
    whole: { doubleValue: 3 },
    count: { integerValue: '3' },
  })
  await page.goto(`${origin()}/console/firestore?path=teams&doc=teams%2Ft_numbers`)
  const inspector = page.getByTestId('inspector')

  // `3` is how Firestore writes both an integer and a double, so nothing in
  // the text can say which this is. The editor says it instead — and before
  // it did, every double that read whole came back an integer.
  await expect(inspector.getByLabel('whole is a double')).toHaveText('double')
  await expect(inspector.getByLabel('count is an integer')).toHaveText('integer')

  await inspector.getByLabel('count value').fill('4')
  await inspector.getByTestId('save-document').click()
  await expect(page.getByText('Document saved')).toBeVisible()
  const touched = await page.request.get(`${documents()}/teams/t_numbers`, { headers: owner })
  const after = (await touched.json()) as { fields: Record<string, unknown> }
  expect(after.fields.whole).toEqual({ doubleValue: 3 })
  expect(after.fields.count).toEqual({ integerValue: '4' })

  // Duplicating writes every field, which is where the narrowing used to
  // happen without anyone touching the number at all.
  await inspector.getByTestId('duplicate-document').click()
  await page.getByTestId('create-submit').click()
  await expect(page.getByText('Document added')).toBeVisible()
  const copy = new URL(page.url()).searchParams.get('doc') ?? ''
  expect(copy).toMatch(/^teams\//)
  const copied = await page.request.get(`${documents()}/${copy}`, { headers: owner })
  expect(((await copied.json()) as { fields: Record<string, unknown> }).fields.whole).toEqual({
    doubleValue: 3,
  })

  // And the form is the editor's to change, which is the other half of it.
  await page.goto(`${origin()}/console/firestore?path=teams&doc=teams%2Ft_numbers`)
  await inspector.getByLabel('whole is a double').click()
  await expect(inspector.getByLabel('whole is an integer')).toHaveText('integer')
  await inspector.getByTestId('save-document').click()
  await expect(page.getByText('Document saved')).toBeVisible()
  const narrowed = await page.request.get(`${documents()}/teams/t_numbers`, { headers: owner })
  expect(((await narrowed.json()) as { fields: Record<string, unknown> }).fields.whole).toEqual({
    integerValue: '3',
  })
  await drop(page.request, 'teams/t_numbers', copy)
})

test('a value is checked as it is typed, and Save knows whether there is anything to do', async ({
  page,
}) => {
  await put(page.request, 'teams/t_typed', { seats: { integerValue: '3' } })
  await page.goto(`${origin()}/console/firestore?path=teams&doc=teams%2Ft_typed`)
  const inspector = page.getByTestId('inspector')

  // An untouched document has nothing to save, and says so by being unable to.
  await expect(inspector.getByTestId('save-document')).toBeDisabled()

  await inspector.getByLabel('seats value').fill('banana')
  await expect(inspector).toContainText('Not a number')
  await expect(inspector.getByTestId('save-blocked')).toContainText('1 field to fix')
  await expect(inspector.getByTestId('save-document')).toBeDisabled()

  await inspector.getByLabel('seats value').fill('77')
  await expect(inspector.getByTestId('save-pending')).toContainText('1 change')
  await expect(inspector.getByTestId('save-document')).toBeEnabled()

  // Typing it back makes the change go away, because the panel compares
  // values rather than remembering that a key was pressed.
  await inspector.getByLabel('seats value').fill('3')
  await expect(inspector.getByTestId('save-document')).toBeDisabled()
  await drop(page.request, 'teams/t_typed')
})

test('a new field completes from the collection, with the type the collection gives it', async ({
  page,
}) => {
  await put(page.request, 'teams/t_sparse', { name: { stringValue: 'Sparse' } })
  await page.goto(`${origin()}/console/firestore?path=teams&doc=teams%2Ft_sparse`)
  const inspector = page.getByTestId('inspector')
  await inspector.getByTestId('new-field-name').click()

  const list = page.getByTestId('field-completions')
  await expect(list).toContainText('seats')
  // The list hangs off a control inside a scrolling column, where an
  // `absolute` popup is an invisible one the moment its row nears an edge.
  // `toBeVisible` cannot see that, and a click scrolls the clipping box
  // first, which nobody can do — so ask the document what it paints there.
  const painted = await list
    .getByRole('button')
    .first()
    .evaluate((el) => {
      const box = el.getBoundingClientRect()
      const hit = el.ownerDocument.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
      return el === hit || el.contains(hit)
    })
  expect(painted).toBe(true)

  await list.getByRole('button', { name: /seats/ }).click()
  // Typed the way the rest of the collection types it, with the value
  // already waiting for the keyboard.
  await expect(inspector.getByRole('button', { name: 'seats type: number' })).toBeVisible()
  await expect(inspector.getByLabel('seats value')).toBeFocused()
  await page.keyboard.type('5')
  await inspector.getByTestId('save-document').click()
  await expect(page.getByText('Document saved')).toBeVisible()
  const stored = await page.request.get(`${documents()}/teams/t_sparse`, { headers: owner })
  expect(((await stored.json()) as { fields: Record<string, unknown> }).fields.seats).toEqual({
    integerValue: '5',
  })
  await drop(page.request, 'teams/t_sparse')
})

test('a document at rest is text, and its controls arrive under the pointer', async ({ page }) => {
  await page.goto(`${origin()}/console/firestore?path=users&doc=users%2Fu_k65eq`)
  const inspector = page.getByTestId('inspector')
  await expect(inspector.getByLabel('displayName value')).toHaveValue('Ada Lovelace')

  // A value is read far more often than it is changed, so at rest it is
  // text. Filled boxes stacked down a 420 px column is what made a document
  // of a dozen short strings read as a form to fill in, and the panel had
  // thirty-seven of them with eighty-six buttons between them.
  const chrome = await inspector.locator('input[aria-label$=" value"]').evaluateAll((inputs) =>
    inputs.map((el) => {
      const style = el.ownerDocument.defaultView!.getComputedStyle(el)
      return style.boxShadow !== 'none' || style.borderTopWidth !== '0px'
    }),
  )
  expect(chrome.length).toBeGreaterThan(5)
  expect(chrome.filter(Boolean)).toEqual([])

  // The controls that are not the value keep their place in the row and
  // are drawn when the row is pointed at, delete loudest among them.
  const remove = inspector.getByLabel('Remove displayName')
  expect(await faded(remove)).toBe(true)
  await inspector.getByLabel('displayName value').hover()
  expect(await faded(remove)).toBe(false)

  // And the count in the footer has somewhere to point.
  await expect(inspector.getByTestId('unsaved-mark')).toHaveCount(0)
  await inspector.getByLabel('displayName value').fill('Ada L')
  await expect(inspector.getByTestId('unsaved-mark')).toHaveCount(1)
  await expect(inspector.getByTestId('save-pending')).toContainText('1 change')
})

test('a document is a tree, and depth is the only thing that moves a name', async ({ page }) => {
  await page.goto(`${origin()}/console/firestore?path=users&doc=users%2Fu_k65eq`)
  const inspector = page.getByTestId('inspector')
  await expect(inspector.getByLabel('displayName value')).toHaveValue('Ada Lovelace')
  const left = async (name: string) => (await inspector.getByLabel(`${name} name`).boundingBox())!.x
  const apart = async (a: string, b: string) => Math.abs((await left(a)) - (await left(b)))

  // Siblings line up whatever they hold, and a child sits right of its
  // parent. The caret column belonged to maps alone and was wider than the
  // indent, so a map stood right of its own siblings and `projects` was
  // drawn six pixels to the left of `limits`, the map containing it.
  expect(await apart('address', 'balance')).toBeLessThan(1)
  expect(await apart('city', 'digest')).toBeLessThan(1)
  expect(await left('settings')).toBeLessThan(await left('limits'))
  expect(await left('limits')).toBeLessThan(await left('projects'))

  // One name column, and the line that adds a field is in it. The tree is
  // the only thing in the panel that starts right of the panel's own
  // content column, so that step is the caret's width and nothing more —
  // on a document whose only map is its last field it is otherwise a
  // column of nothing a dozen rows tall.
  const column = await textLeft(inspector.getByLabel('address name'))
  expect(Math.abs((await textLeft(inspector.getByLabel('balance name'))) - column)).toBeLessThan(1)
  expect(Math.abs((await textLeft(inspector.getByTestId('new-field-name'))) - column)).toBeLessThan(
    2,
  )

  // A row is a line, and a name and its value share it. On two lines a
  // node is a block, and an indent says nothing against a block's height.
  const name = (await inspector.getByLabel('balance name').boundingBox())!
  const value = (await inspector.getByLabel('balance value').boundingBox())!
  expect(value.x).toBeGreaterThan(name.x + name.width)
  expect(Math.abs(value.y + value.height / 2 - (name.y + name.height / 2))).toBeLessThan(1)

  // The controls overlay the end of the line rather than holding a quarter
  // of it open at rest for buttons that are not drawn at rest — which is
  // the width this timestamp was being cut short by.
  const stamp = inspector.getByLabel('lastSeen value')
  await expect(stamp).toHaveValue(/^2026-/)
  expect(await clipped(stamp)).toBe(false)

  // And they stay down while a value has focus, so they never land on the
  // text being typed. A Tab into the strip still brings them up.
  await stamp.click()
  await page.mouse.move(8, 8)
  const remove = inspector.getByLabel('Remove lastSeen')
  expect(await faded(remove)).toBe(true)
  await page.keyboard.press('Tab')
  expect(await faded(remove)).toBe(false)
})

test('a value too long for its line wraps rather than being cut short', async ({ page }) => {
  await put(page.request, 'teams/t_long', {
    redirectUri: { stringValue: 'example-dev://app/gateway/callback?state=U3kVZ4r1ADid' },
    short: { stringValue: 'ok' },
  })
  await page.goto(`${origin()}/console/firestore?path=teams&doc=teams%2Ft_long`)
  const inspector = page.getByTestId('inspector')
  const long = inspector.getByLabel('redirectUri value')
  await expect(long).toHaveValue(/callback/)

  // A console is for reading a document before it is for editing one, and
  // a value cut off at the panel's edge is a value the panel failed to
  // show — a URL loses its path, which is the half that says anything. An
  // `input` cannot wrap at all, so a value needing two lines gets two.
  expect(await clipped(long)).toBe(false)
  expect(await lineCount(long)).toBeGreaterThan(1)
  expect(await lineCount(inspector.getByLabel('short value'))).toBe(1)

  // The name stays on the value's first line rather than floating between
  // the two of them.
  const name = (await inspector.getByLabel('redirectUri name').boundingBox())!
  const value = (await long.boundingBox())!
  expect(Math.abs(name.y - value.y)).toBeLessThan(2)

  // Enter still means "done with this one"; a newline is Shift, and that
  // is what turns the value into a region below the line.
  await long.click()
  await page.keyboard.press('Enter')
  await expect(long).toHaveValue(/callback\?state=U3kVZ4r1ADid$/)
  await long.click()
  await page.keyboard.press('Shift+Enter')
  await expect(inspector.getByLabel('redirectUri value')).toHaveValue(/\n/)
})
