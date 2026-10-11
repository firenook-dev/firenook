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

test('the query field is built like the path field, and nothing cuts its outline', async ({
  page,
}) => {
  await page.goto(`${origin()}/console/firestore?path=users`)
  const first = page.getByTestId('grid-row').first()
  await expect(first).toBeVisible()
  // Opening the line changes what is in it, not how tall it is: the
  // grid under it stays where it was. Shut, it was 5 px shorter.
  const top = (await first.boundingBox())?.y
  await page.getByRole('button', { name: 'Filter' }).click()
  const field = page.getByTestId('query-field')
  const input = page.getByTestId('query-input')
  await expect(input).toBeFocused()
  expect((await first.boundingBox())?.y).toBe(top)
  // Focused, the two fields wear the same outline and ground.
  const focused = await fieldLook(field)
  await page.keyboard.press('Escape')
  await expect(input).toHaveCount(0)
  expect((await first.boundingBox())?.y).toBe(top)
  await page.keyboard.press('/')
  expect(await fieldLook(page.getByTestId('path-field'))).toEqual(focused)
  expect(focused.ring).toBe(true)
  // The ring is painted outside the box, so whatever clips the field has
  // to leave it room on every side. It used to be 28 px in a 28 px
  // scroller: focus drew two brackets and no top or bottom.
  await page.keyboard.press('Escape')
  await page.keyboard.press('f')
  await expect(input).toBeFocused()
  expect(await ringRoom(field)).toBeGreaterThanOrEqual(1)

  // At rest it is a line to read, like the path.
  await page.getByTestId('grid-row').first().locator('td').nth(2).click()
  expect((await fieldLook(field)).ring).toBe(false)

  // Clearing is the field's own control, and leaves the caret in it.
  await input.fill('where("plan", "==", "pro")')
  await input.press('Enter')
  await expect(page).toHaveURL(/q=where/)
  await page.getByTestId('query-clear').click()
  await expect(page).not.toHaveURL(/q=where/)
  await expect(input).toBeFocused()
  await expect(input).toHaveValue('')
})

test('the count names itself on hover, and Run stays put however long it is', async ({ page }) => {
  await page.goto(`${origin()}/console/firestore?path=users`)
  await expect(page.getByTestId('grid-row').first()).toBeVisible()
  await page.keyboard.press('f')
  const input = page.getByTestId('query-input')
  const count = page.getByTestId('match-count')
  const run = page.getByRole('button', { name: 'Run' })
  // The figure alone: the time it took is the tip's, with what it counts.
  await expect(count).toHaveText('240 documents')
  await count.hover()
  await expect(
    page.getByText(
      /^Every document in this collection, not only the rows loaded\. Counted in \d+ ms\.$/,
    ),
  ).toBeVisible()
  await page.getByTestId('explain-toggle').hover()
  await expect(
    page.getByText('What this query reads, and the index production needs'),
  ).toBeVisible()

  // The field takes what the row has left, so a count that changed width
  // used to carry Run with it: 240 to 67 documents moved it 12 px.
  const at = (await run.boundingBox())?.x
  for (const [query, figure] of [
    ['where("plan", "==", "pro")', /^\d+ documents$/],
    ['where("plan", "==", "nobody")', /^0 documents$/],
  ] as const) {
    await input.fill(query)
    await input.press('Enter')
    await expect(count).toHaveText(figure)
    expect((await run.boundingBox())?.x).toBe(at)
  }
  // A query that does not parse has no count, and the slot stays.
  await input.fill('where("plan", "==", "pro')
  await input.press('Enter')
  await expect(page.getByTestId('query-unparsed')).toBeVisible()
  await expect(count).toHaveCount(0)
  expect((await run.boundingBox())?.x).toBe(at)
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
  // The channel says whether what you are looking at is current. It is
  // the only thing left in that corner: the window it used to open is
  // gone, and a count you cannot look into is trivia.
  await expect(page.getByTestId('live-state')).toContainText('Live')
})

test('documents are added and deleted from the workbench', async ({ page }) => {
  await page.goto(`${origin()}/console/firestore?path=teams`)
  await expect(page.getByTestId('grid-row').first()).toBeVisible()
  await page.keyboard.press('n')
  await page.getByTestId('new-document-id').fill('t_journey')
  await page.getByRole('dialog').getByRole('tab', { name: 'JSON' }).click()
  // No Apply: the text is the draft, so the tab counts it as it is typed.
  await page.getByTestId('document-json').fill('{"name": "Journey", "seats": 2, "tags": ["e2e"]}')
  await expect(page.getByRole('dialog')).toContainText('Fields · 3')
  await page.getByTestId('create-submit').click()
  await expect(page).toHaveURL(/doc=teams%2Ft_journey/)
  await expect(page.getByTestId('inspector')).toContainText('teams/t_journey')
  await expect(page.getByTestId('grid-row').filter({ hasText: 't_journey' })).toBeVisible()

  // With something beneath it, which "Also delete subcollections
  // underneath" — ticked by default — is there to take along.
  await put(page.request, 'teams/t_journey/notes/n1', { body: { stringValue: 'beneath' } })
  await page.getByLabel('Select t_journey').click()
  await page.getByTestId('delete-selected').click()
  await page.getByTestId('confirm-delete').click()
  await expect(page.getByText('2 documents deleted')).toBeVisible()
  await expect(page.getByTestId('grid-row').filter({ hasText: 't_journey' })).toHaveCount(0)
  const gone = await page.request.get(`${documents()}/teams/t_journey`, { headers: owner })
  expect(gone.status()).toBe(404)
  // It sent no mode, which the engine reads as the document alone, and the
  // subcollection outlived the document it belonged to.
  const beneath = await page.request.get(`${documents()}/teams/t_journey/notes/n1`, {
    headers: owner,
  })
  expect(beneath.status()).toBe(404)
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
  await nested.getByTestId('open-row').click()
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
  await page.getByTestId('grid-row').first().getByTestId('open-row').click()
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
  const face = (selector: string) =>
    page.getByTestId('inspector').evaluate(
      (root, within) =>
        [...root.querySelectorAll(within)]
          .filter((el) => el.getAttribute('type') !== 'checkbox')
          .map((el) => {
            const style = el.ownerDocument.defaultView!.getComputedStyle(el)
            return `${style.fontSize} ${/mono|plex/i.test(style.fontFamily) ? 'mono' : 'sans'}`
          }),
      selector,
    )
  expect([
    ...new Set(await face('input[aria-label$=" value"], textarea[aria-label$=" value"]')),
  ]).toEqual(['12px mono'])

  // And a name is not a value. Both were 12 px mono, which is two kinds of
  // thing in one voice: the eye had nothing to tell a label from the data
  // it labels, so a column of pairs read as a column of tokens.
  expect([
    ...new Set(await face('input[aria-label$=" name"], input[data-testid="new-field-name"]')),
  ]).toEqual(['13px sans'])
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
  await ghost.getByTestId('open-row').click()
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
  await expect(page.getByTestId('subcollections')).toContainText('Subcollections · none')
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
  const cell = page.getByTestId('grid-row').first().locator('td[data-field="type"]')
  const id = (await page.getByTestId('grid-row').first().locator('td').nth(1).innerText()).trim()
  await cell.dblclick()
  const editor = page.getByTestId('cell-editor').getByRole('textbox', { name: 'type value' })
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

  // Editing it in place reads the whole value first, so what is saved is
  // never the fragment the page was drawn from.
  await note.dblclick()
  const editing = page.getByTestId('cell-editor').getByRole('textbox', { name: 'note value' })
  await expect(editing).toHaveValue(long)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('cell-editor')).toHaveCount(0)

  // The inspector holds the whole value, because it fetches the document.
  await row.getByTestId('open-row').click()
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
  await page.getByTestId('grid-row').first().getByTestId('open-row').click()
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

  // Past one page of the grid, still all of it. The grid's page size was
  // read as a limit, and 240 users exported as 100.
  await page.goto(`${origin()}/console/firestore?path=users`)
  await expect(page.getByTestId('grid-row').first()).toBeVisible()
  await page.getByTestId('export-open').click()
  const usersDownload = page.waitForEvent('download')
  await page.getByTestId('confirm-export').click()
  const users = JSON.parse(await readDownload(await usersDownload)) as Record<string, unknown>
  expect(Object.keys(users)).toHaveLength(240)
  await page.goto(`${origin()}/console/firestore?path=products`)
  await expect(page.getByTestId('grid-row').first()).toBeVisible()
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

/** A field's outline and ground, as the eye sees them. */
const fieldLook = (field: Locator) =>
  field.evaluate((el) => {
    const style = el.ownerDocument.defaultView!.getComputedStyle(el)
    return {
      ring: style.boxShadow
        .split(/,(?![^(]*\))/)
        .some(
          (layer: string) =>
            layer.trim().endsWith(' 0px 0px 0px 1px') && !layer.includes('rgba(0, 0, 0, 0)'),
        ),
      shadow: style.boxShadow,
      background: style.backgroundColor,
      height: (el as { offsetHeight: number }).offsetHeight,
      radius: style.borderRadius,
    }
  })

/** The least room any ancestor that clips leaves around a box, px. */
const ringRoom = (field: Locator) =>
  field.evaluate((el) => {
    const view = el.ownerDocument.defaultView!
    const box = el.getBoundingClientRect()
    let room = Infinity
    for (let up = el.parentElement; up; up = up.parentElement) {
      const style = view.getComputedStyle(up)
      if (style.overflowX === 'visible' && style.overflowY === 'visible') continue
      const clip = up.getBoundingClientRect()
      // A scroller clips at its padding edge, inside its border.
      const top = clip.top + Number.parseFloat(style.borderTopWidth)
      const bottom = clip.bottom - Number.parseFloat(style.borderBottomWidth)
      const left = clip.left + Number.parseFloat(style.borderLeftWidth)
      room = Math.min(room, box.top - top, bottom - box.bottom, box.left - left)
    }
    return room
  })

/** A download's bytes, as text. */
async function readDownload(download: { path(): Promise<string> }): Promise<string> {
  const { readFile } = await import('node:fs/promises')
  return readFile(await download.path(), 'utf8')
}

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

/** How many text lines a field is drawn across, its own padding discounted. */
async function lineCount(field: Locator): Promise<number> {
  return field.evaluate((el) => {
    const style = el.ownerDocument.defaultView!.getComputedStyle(el)
    const text =
      el.getBoundingClientRect().height -
      Number.parseFloat(style.paddingTop) -
      Number.parseFloat(style.paddingBottom)
    return Math.round(text / Number.parseFloat(style.lineHeight))
  })
}

/**
 * Whether a value is drawn in a box. The ring belongs to the box around
 * the field rather than to the field — a growing value is a textarea lying
 * on top of a mirror of its own text, and only their container knows how
 * tall the pair ended up — so this looks at the field and what holds it.
 */
async function boxedValues(fields: Locator): Promise<boolean[]> {
  return fields.evaluateAll((all) =>
    all.map((el) => {
      const view = el.ownerDocument.defaultView!
      let node = el
      for (let depth = 0; depth < 3; depth += 1) {
        if (view.getComputedStyle(node).boxShadow !== 'none') return true
        const up = node.parentElement
        if (up === null) return false
        node = up
      }
      return false
    }),
  )
}

/** Keys with a number each, for a map wide enough to be worth shutting. */
/** How a control is drawn: the two properties a variant change shows up in. */
async function paint(locator: Locator): Promise<{ background: string; opacity: string }> {
  return await locator.evaluate((el) => {
    const style = el.ownerDocument.defaultView!.getComputedStyle(el)
    return { background: style.backgroundColor, opacity: style.opacity }
  })
}

/** The drawn height of a band of panel chrome. */
async function band(locator: Locator): Promise<number> {
  return (await locator.boundingBox())!.height
}

function numbered(keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.map((key, index) => [key, { integerValue: String(index) }]))
}

/**
 * The whole document replaced by a paste, the way a person does it:
 * select all, then paste. `fill()` would set the text without the paste
 * event the editor tidies on.
 */
async function replaceJson(
  page: { keyboard: { press: (key: string) => Promise<void> } },
  editor: Locator,
  text: string,
) {
  await editor.click()
  await page.keyboard.press('ControlOrMeta+a')
  await editor.evaluate((el, pasted) => {
    const window = el.ownerDocument.defaultView!
    const data = new window.DataTransfer()
    data.setData('text/plain', pasted)
    el.dispatchEvent(new window.ClipboardEvent('paste', { clipboardData: data, bubbles: true }))
  }, text)
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
  // It is a control, so it lives in the row's strip with every other one:
  // as the word at the end of the value it sat exactly where the strip is
  // drawn, and once values wore boxes the strip covered it and nothing
  // could reach it.
  await page.goto(`${origin()}/console/firestore?path=teams&doc=teams%2Ft_numbers`)
  await press(inspector.getByLabel('whole is a double'))
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

test('every value wears a box, and the controls still arrive under the pointer', async ({
  page,
}) => {
  await page.goto(`${origin()}/console/firestore?path=users&doc=users%2Fu_k65eq`)
  const inspector = page.getByTestId('inspector')
  await expect(inspector.getByLabel('displayName value')).toHaveValue('Ada Lovelace')

  // A value used to wear nothing at rest, on the rule that it is text you
  // read far more often than you change. The rule was wrong about what the
  // reader needs to know: a bordered control says "you can type here"
  // before anybody tries one, and a column of bare text says the opposite,
  // so the panel read as a dump of a document rather than an editor of one.
  // Nothing else argued otherwise either — the type menu, the only hint
  // that a value's type can be changed at all, is under the pointer.
  const values = inspector.locator('input[aria-label$=" value"], textarea[aria-label$=" value"]')
  const drawn = await boxedValues(values)
  expect(drawn.length).toBeGreaterThan(5)
  expect(drawn.filter((box) => !box)).toEqual([])

  // The box costs nothing — a ring is painted with a shadow, so a boxed
  // line is exactly as tall as a bare one. What the old rule was really
  // protecting against was boxes stacked two pixels apart, which is a wall
  // and not a list, and the answer to that is the air between them.
  const gaps = await inspector
    .getByTestId('field-row')
    .first()
    .evaluate((el) => {
      const view = el.ownerDocument.defaultView!
      return {
        between: view.getComputedStyle(el.parentElement!).rowGap,
        within: view.getComputedStyle(el).rowGap,
      }
    })
  expect(Number.parseFloat(gaps.between)).toBeGreaterThanOrEqual(10)

  // But the air goes between two fields, not inside one. A row holds its
  // line, the region under a long value, its notes and its children, and
  // those are one thing — a subgrid inherits the gaps of the grid above
  // it, so given the list's own gap an error message drifted a field's
  // height below the field and read as belonging to the next one.
  expect(Number.parseFloat(gaps.within)).toBeLessThan(Number.parseFloat(gaps.between))

  // And the drawer has one content column, which the field list is in.
  // It was not: the list sat at `pl-0`, so a row's ground began 1 px from
  // the panel's edge and its values ended 19 px from the other, while the
  // path, the tabs, Subcollections, Save and Delete all sat on 12 and 11.
  // A name is further in than all of them, by the width of the caret
  // column it shares the row with, and that is the column doing its job.
  const panel = (await inspector.boundingBox())!
  const inset = async (locator: Locator) => {
    const box = (await locator.boundingBox())!
    return { left: box.x - panel.x, right: panel.x + panel.width - (box.x + box.width) }
  }
  // The footer's left end and its right end are the panel's two columns:
  // the tools start where a field name starts, and Save ends where a
  // value ends.
  const ground = await inset(inspector.getByTestId('field-row').first().locator('> div').first())
  const tools = await inset(inspector.getByTestId('document-code'))
  const save = await inset(inspector.getByTestId('save-document'))
  const value = await inset(inspector.getByLabel('displayName value'))
  expect(Math.abs(ground.left - tools.left)).toBeLessThan(2)
  expect(Math.abs(value.right - save.right)).toBeLessThan(2)

  // The caret hangs in that margin; it does not stand in a column of its
  // own. It had one, given to every row whether or not it held a caret,
  // because giving it only to maps pushed a map's name past its own
  // siblings. A column costs every row to serve the few: a document of
  // fourteen fields with one map in it paid 18 px of nothing thirteen
  // times, and its names sat 31 px in while every other label in the
  // drawer sat on 12. Out of the flow it cannot push anything, so a name
  // is a name whether or not the field opens.
  const plain = await inset(inspector.getByLabel('displayName name'))
  const holder = await inset(inspector.getByLabel('settings name'))
  expect(Math.abs(plain.left - tools.left)).toBeLessThan(2)
  expect(Math.abs(holder.left - plain.left)).toBeLessThan(1)

  // And hanging is not the same as gone: it has to be inside the panel
  // and drawn there, which is what a left offset alone cannot tell apart
  // from a caret clipped off the edge by the scroller.
  // `address` and not `settings`: the paint test reads the document at a
  // point, so it answers "nothing here" for a row below the fold just as
  // it does for one that is clipped.
  const caret = inspector.getByLabel('Collapse address')
  expect((await inset(caret)).left).toBeGreaterThan(1)
  expect(await paintedAtItsOwnCentre(caret)).toBe(true)

  // Every control in the strip is one square with room around it. Kumo's
  // own square button renders 12 px here — the root font is 14 px, so
  // every rem-based size comes out an eighth smaller than the design
  // system means — and three of those two pixels apart read as one smudge
  // rather than as three controls.
  const row = inspector
    .getByLabel('address name')
    .locator('xpath=ancestor::*[@data-testid="field-row"][1]')
  await row.locator('> div').first().hover()
  const rhythm = await row
    .locator('> div > span')
    .last()
    .evaluate((el) => {
      const kids = [...el.children].map((kid) => kid.getBoundingClientRect())
      return {
        heights: kids.map((box) => Math.round(box.height)),
        gaps: kids.slice(1).map((box, i) => Math.round(box.x - (kids[i]!.x + kids[i]!.width))),
      }
    })
  expect(rhythm.heights.length).toBeGreaterThan(2)
  expect(new Set(rhythm.heights).size).toBe(1)
  expect(Math.min(...rhythm.heights)).toBeGreaterThanOrEqual(20)
  expect(Math.min(...rhythm.gaps)).toBeGreaterThanOrEqual(3)

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

  // The line that marks a list descends from the caret that opened it.
  // It used to descend from nothing: the line sat inside the name column
  // while the caret hangs outside it, so eleven pixels of white stood
  // between the chevron and the rail it heads — the same eleven at every
  // depth, because the gap is built in rather than drifting. An arrow and
  // a line that never meet are two marks near each other, not a statement
  // about what contains what, and the tree has to be read off the indent
  // alone.
  const rails = await inspector.evaluate((panel) => {
    const view = panel.ownerDocument.defaultView!
    return [...panel.querySelectorAll('[data-testid="field-row"] > div')]
      .filter((el) => view.getComputedStyle(el).borderLeftWidth === '1px')
      .map((rail) => {
        const caret = rail
          .closest('[data-testid="field-row"]')
          ?.querySelector(':scope > div > div > button[aria-expanded]')
        if (!caret) return undefined
        const chevron = caret.getBoundingClientRect()
        return rail.getBoundingClientRect().left + 0.5 - (chevron.left + chevron.width / 2)
      })
      .filter((offset) => offset !== undefined)
  })
  expect(rails.length).toBeGreaterThan(1)
  expect(rails.filter((offset) => Math.abs(offset) >= 1)).toEqual([])

  // Moving it there cost the indent nothing: the padding carries what the
  // margin gave up, so the step from a name to its child is the same at
  // every depth and the same as it was.
  const step = (await left('city')) - (await left('address'))
  expect(Math.abs((await left('projects')) - (await left('limits')) - step)).toBeLessThan(1)

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

  // And one value column. They began at eight different offsets spread
  // over 58 px, so reading down the values — which is half of what anyone
  // does with a document — meant following a staircase.
  const values = await textLeft(inspector.getByLabel('balance value'))
  for (const field of ['bio', 'displayName', 'email', 'plan', 'lastSeen']) {
    expect(
      Math.abs((await textLeft(inspector.getByLabel(`${field} value`))) - values),
    ).toBeLessThan(1)
  }

  // One column for the whole document, not one per list. A nested list
  // used to build its own tracks and size them to its own widest name, so
  // a map of short names inside a document of long ones started its
  // values 26 px LEFT of its parent's siblings and ran that much wider:
  // the deeper the row, the further out it burst, which reads as the
  // opposite of containment.
  expect(Math.abs((await textLeft(inspector.getByLabel('city value'))) - values)).toBeLessThan(1)
  // Two strings, so the boxes are comparable: a number shares its box
  // with the word saying how it is stored, and is narrower by that word.
  const outer = (await inspector.getByLabel('bio value').boundingBox())!
  const inner = (await inspector.getByLabel('city value').boundingBox())!
  expect(Math.abs(inner.width - outer.width)).toBeLessThan(1)

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
  const region = inspector.getByLabel('redirectUri value')
  await expect(region).toHaveValue(/\n/)

  // A region goes under the line at the panel's own width: it starts
  // where a name starts and ends where a line's own box ends. It started
  // 21 px in, standing clear of a caret column that has not existed since
  // the caret began hanging in the margin.
  const box = (await region.boundingBox())!
  const label = (await inspector.getByLabel('short name').boundingBox())!
  const line = (await inspector.getByLabel('short value').boundingBox())!
  expect(Math.abs(box.x - label.x)).toBeLessThan(2)
  expect(Math.abs(box.x + box.width - (line.x + line.width))).toBeLessThan(2)
})

test('a shut container says what it holds, and a big one opens shut', async ({ page }) => {
  await put(page.request, 'teams/t_shape', {
    config: {
      mapValue: {
        fields: numbered(['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta']),
      },
    },
    small: {
      mapValue: { fields: { dasd: { mapValue: { fields: { dsad: { stringValue: 'x' } } } } } },
    },
  })
  await page.goto(`${origin()}/console/firestore?path=teams&doc=teams%2Ft_shape`)
  const inspector = page.getByTestId('inspector')
  const summaryOf = (name: string) =>
    inspector
      .getByLabel(`${name} name`)
      .locator('xpath=ancestor::*[@data-testid="field-row"][1]//*[@data-testid="field-summary"]')
      .first()

  // A small map is open, and an open map says nothing: its fields are
  // listed directly beneath it, which is the one thing `{ 1 field }` was
  // telling anybody — and it said it loudest on the map it helped least.
  await expect(inspector.getByLabel('dsad value')).toHaveValue('x')
  await expect(summaryOf('small')).toHaveText('')

  // Shut, it says what is in it. A name is what you scan a document for.
  await inspector.getByLabel('Collapse small').click()
  await expect(summaryOf('small')).toHaveText('{ dasd }')

  // And a map big enough to bury what follows it opens shut, so the
  // document opens scannable — with the keys, and how many more.
  await expect(inspector.getByLabel('alpha value')).toHaveCount(0)
  await expect(summaryOf('config')).toHaveText('{ alpha, beta, delta, +5 }')

  // And what it holds is the way in. The caret is four pixels of chevron;
  // the words beside it are what the eye went to, so they open it too.
  await summaryOf('config').click()
  await expect(inspector.getByLabel('alpha value')).toHaveValue('0')
  await drop(page.request, 'teams/t_shape')
})

test('a timestamp picks from the field it is in, not from a button beside it', async ({ page }) => {
  await put(page.request, 'teams/t_when', { at: { timestampValue: '2026-09-20T07:45:55.267Z' } })
  await page.goto(`${origin()}/console/firestore?path=teams&doc=teams%2Ft_when`)
  const inspector = page.getByTestId('inspector')
  const field = inspector.getByLabel('at value')
  await expect(field).toHaveValue('2026-09-20T07:45:55.267Z')

  // The calendar was a button in the row's strip: drawn on hover, at the
  // far end of the line, for a value at the near end. A control nobody can
  // see is a control nobody finds — the third time that was true here. The
  // field opens it, the way the reference field opens its completions.
  await expect(inspector.getByLabel('Pick at')).toHaveCount(0)
  const panel = page.getByTestId('timestamp-picker')
  await expect(panel).toHaveCount(0)
  await field.click()
  await expect(panel).toHaveCount(1)

  // It hangs off a field inside the scrolling column, so it is drawn in a
  // portal; `toBeVisible` cannot see a clip, so ask what is painted there.
  expect(await paintedAtItsOwnCentre(panel)).toBe(true)

  // And it opens on the value's own month rather than on this one.
  await expect(panel).toContainText('September 2026')

  // A day keeps the time of day, and the panel stays up: the calendar
  // takes focus onto the day it selects, which is not focus leaving.
  await panel.locator('button').filter({ hasText: /^25$/ }).first().click()
  await expect(field).toHaveValue('2026-09-25T07:45:55.267Z')
  await expect(panel).toHaveCount(1)

  // The pickers speak in days and seconds; the stored instant keeps the
  // milliseconds neither of them can say, because the text is the truth.
  await panel.locator('input[type="time"]').fill('11:30:00')
  await expect(field).toHaveValue(/:00\.267Z$/)

  // Focus leaving the field *and* its panel is what shuts it.
  await inspector.getByTestId('new-field-name').click()
  await expect(panel).toHaveCount(0)
  await drop(page.request, 'teams/t_when')
})

test('a map and its JSON are the same subtree, written two ways', async ({ page }) => {
  await put(page.request, 'teams/t_json', {
    redirectUri: {
      mapValue: {
        fields: {
          app: { mapValue: { fields: { scheme: { stringValue: 'example-dev' } } } },
          at: { timestampValue: '2026-09-20T09:00:00Z' },
        },
      },
    },
  })
  await page.goto(`${origin()}/console/firestore?path=teams&doc=teams%2Ft_json`)
  const inspector = page.getByTestId('inspector')
  await expect(inspector.getByLabel('scheme value')).toHaveValue('example-dev')

  // A container's `text` is empty — its children are its value — and the
  // button only flipped a flag, so the JSON view read something the rows
  // had never written: `{}` for a map with fields in it, marked changed,
  // and that empty map is what the next Save would have stored.
  const toggle = inspector.getByLabel('Edit redirectUri as JSON')
  const look = () =>
    toggle.evaluate((el) => {
      const style = el.ownerDocument.defaultView!.getComputedStyle(el)
      return `${style.backgroundColor} ${style.boxShadow}`
    })
  await toggle.locator('xpath=ancestor::*[@data-testid="field-row"][1]/*[1]').hover()
  const resting = await look()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await press(toggle)
  const shown = inspector.getByLabel('redirectUri value')
  expect(JSON.parse(await shown.inputValue())).toEqual({
    app: { scheme: 'example-dev' },
    at: '2026-09-20T09:00:00.000Z',
  })

  // And looking is not editing: the two views stand for one value, so
  // opening this one leaves the document with nothing to save.
  await expect(inspector.getByTestId('save-pending')).toHaveCount(0)

  // The control says it is on. `ghost` and `secondary` resolved to the
  // same white square at this size, so the toggle looked identical
  // whether the row was in JSON or not — the one thing it is there to
  // report. It is pressed now, and drawn as something pressed.
  await toggle.locator('xpath=ancestor::*[@data-testid="field-row"][1]/*[1]').hover()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  expect(await look()).not.toBe(resting)

  // What is typed becomes rows again, and the type JSON cannot write down
  // survives because the row the JSON still describes is the row kept.
  await shown.fill('{"app": {"scheme": "example-prod"}, "at": "2026-09-20T09:00:00.000Z"}')
  await press(inspector.getByLabel('Edit redirectUri as JSON'))
  await expect(inspector.getByLabel('scheme value')).toHaveValue('example-prod')
  await inspector.getByTestId('save-document').click()
  await expect(page.getByText('Document saved')).toBeVisible()

  const stored = await page.request.get(`${documents()}/teams/t_json`, { headers: owner })
  const saved = (await stored.json()) as {
    fields: { redirectUri: { mapValue: { fields: Record<string, Record<string, unknown>> } } }
  }
  const fields = saved.fields.redirectUri.mapValue.fields
  expect(fields.app).toEqual({ mapValue: { fields: { scheme: { stringValue: 'example-prod' } } } })
  expect(Object.keys(fields.at ?? {})).toEqual(['timestampValue'])
  await drop(page.request, 'teams/t_json')
})

test('the header counts the document against the 1 MiB a document may hold', async ({ page }) => {
  await put(page.request, 'teams/t_size', { note: { stringValue: 'small' } })
  await page.goto(`${origin()}/console/firestore?path=teams&doc=teams%2Ft_size`)
  const inspector = page.getByTestId('inspector')
  const size = inspector.getByTestId('document-size')
  // By Firestore's own rule: the name is `teams` (6) + `t_size` (7) +
  // 16 = 29, the one field is `note` (5) + "small" (6) = 11, and a
  // document carries 32 over. 72 bytes.
  await expect(size).toHaveText('72 B')

  // It counts the draft, not the stored document, which is the whole
  // point of having it: the number moves while you type, before there
  // is anything to save.
  await inspector.getByLabel('note value').fill('small'.padEnd(2000, '!'))
  await expect(size).toHaveText('2.0 KB')
  await expect(inspector.getByTestId('save-pending')).toContainText('1 change')

  // And it says what it is counting against.
  await size.hover()
  await expect(page.getByText('of 1,048,576 bytes a document may hold')).toBeVisible()

  // Quiet while there is nothing to warn about: colour here is spent on
  // what can be done, and a document using a fifth of a per cent of its
  // room is not news.
  const quiet = await size.evaluate(
    (el) => el.ownerDocument.defaultView!.getComputedStyle(el).color,
  )
  await drop(page.request, 'teams/t_size')

  // Over the limit it is a different colour and a different sentence,
  // because this engine will store what Firestore would refuse — there
  // is no document-size check anywhere in the crates, so without this
  // the first anybody hears of it is a failed write in production.
  await put(page.request, 'teams/t_big', {
    blob: { stringValue: 'x'.repeat(1_100_000) },
  })
  await page.goto(`${origin()}/console/firestore?path=teams&doc=teams%2Ft_big`)
  // And how full it is, now that that is the news.
  await expect(size).toHaveText('1.05 MB · 105%')
  const loud = await size.evaluate((el) => el.ownerDocument.defaultView!.getComputedStyle(el).color)
  expect(loud).not.toBe(quiet)
  await size.hover()
  await expect(page.getByText('Firestore will reject it')).toBeVisible()
  await drop(page.request, 'teams/t_big')
})

test('the chip beside the path times the write, not anything in the document', async ({ page }) => {
  // A document carrying a `createdAt` field years before the write that
  // put it in the engine. The chip reads `updateTime` — the engine's own
  // record — so the two are allowed to disagree, and a reader who takes
  // the chip for the field would read it wrong by six years.
  await put(page.request, 'teams/t_when', {
    createdAt: { timestampValue: '2020-01-01T00:00:00Z' },
    name: { stringValue: 'When' },
  })
  await page.goto(`${origin()}/console/firestore?path=teams&doc=teams%2Ft_when`)
  const inspector = page.getByTestId('inspector')
  await expect(inspector.getByLabel('name value')).toHaveValue('When')
  const chip = inspector.getByTestId('document-changed')
  // The chip says the write happened a moment ago; the `createdAt` row
  // under it says seven years. Both are right, about different things,
  // and the chip is the one nothing in the document can tell you.
  await expect(chip).toHaveText('just now')
  await expect(inspector.getByTestId('field-row').first()).toContainText('7 y ago')

  // And it names the event it counts from, which "just now" beside a
  // path does not. In the console's own tooltip, not the browser's: a
  // native `title` waits about a second and arrives in the platform's
  // skin, beside Kumo tooltips that do neither.
  await chip.hover()
  await expect(page.getByText('Last changed 2026-', { exact: false })).toBeVisible()
  await drop(page.request, 'teams/t_when')
})

test('the new-document dialog is wide enough for the editor it holds', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.goto(`${origin()}/console/firestore?path=users&doc=users%2Fu_k65eq`)
  await page.getByTestId('inspector').getByTestId('add-subcollection').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()

  // What the width is for: a line of JSON the length of a real one fits
  // on one line. At Kumo's largest size the tab held 43 columns —
  // exactly `  "createdAt": "2026-10-10T18:32:32.415Z",` — and a hash or
  // a URL from an ordinary document wrapped. A 78-character line is
  // measured against a short one; wrapped, it would be twice the height.
  await dialog.getByRole('tab', { name: 'JSON' }).click()
  const editor = dialog.getByTestId('document-json')
  await expect(editor).toBeVisible()
  const long = `  "secretHash": "${'x'.repeat(78 - '  "secretHash": "",'.length)}",`
  expect(long).toHaveLength(78)
  await editor.fill(`{\n${long}\n  "n": 1\n}`)
  const heights = await dialog
    .locator('.cm-line')
    .evaluateAll((lines) => lines.map((line) => Math.round(line.getBoundingClientRect().height)))
  expect(heights).toHaveLength(4)
  expect(heights[1]).toBe(heights[2])

  // And Kumo's own bound still holds on a small window: the override
  // widens the dialog, it does not let it leave the screen.
  await page.setViewportSize({ width: 600, height: 900 })
  const box = (await dialog.boundingBox())!
  expect(box.x).toBeGreaterThanOrEqual(8)
  expect(box.x + box.width).toBeLessThanOrEqual(600 - 8)
})

test('the JSON tab spends the panel on the JSON', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  // Eighteen fields: twenty lines of JSON, which the old box showed
  // twelve of.
  const keys = Array.from({ length: 18 }, (_, index) => `f${index}`)
  await put(page.request, 'teams/t_tall', numbered(keys))
  await page.goto(`${origin()}/console/firestore?path=teams&doc=teams%2Ft_tall&tab=json`)
  const inspector = page.getByTestId('inspector')
  const editor = inspector.getByTestId('document-json')
  await expect(editor).toBeVisible()

  // The box was `rows={12}` — 224 of the panel's 593 pixels — and the
  // 282 below the Apply line, half the panel, were empty while the text
  // inside those 224 scrolled. Nothing idles under the one action now.
  const actions = (await inspector.getByTestId('json-actions').boundingBox())!
  const below = (await inspector.getByTestId('subcollections').boundingBox())!
  expect(Math.round(below.y - (actions.y + actions.height))).toBeLessThanOrEqual(2)

  // And the room went to the text: a document that needed three screens
  // of a twelve-row box is read without scrolling at all. Measured on
  // the editor's scroller, which is the thing that would scroll — the
  // element holding the text grows to its own content and would say it
  // fits whatever height the panel gave it.
  const shown = await editor.evaluate((el) => {
    const scroller = el.closest('.cm-scroller')!
    return { fits: scroller.scrollHeight <= scroller.clientHeight, height: scroller.clientHeight }
  })
  expect(shown.height).toBeGreaterThan(400)
  expect(shown.fits).toBe(true)
  await drop(page.request, 'teams/t_tall')
})

/**
 * The editor's three inks, as sRGB against the ground and as OKLab
 * coordinates against each other.
 *
 * Both are needed. A contrast check alone passes a palette that is
 * indistinguishable — two colours of the same lightness have a ratio of
 * 1 against each other — and the first version of this palette was
 * exactly that: keys and strings two greys 0.06 of a lightness step
 * apart, each with a fine ratio against white and neither telling you
 * anything about the other.
 */
async function codeInk(editor: Locator): Promise<{
  contrast: Record<string, number>
  gamut: Record<string, boolean>
  apart: Record<string, number>
}> {
  return editor.evaluate((el) => {
    const window = el.ownerDocument.defaultView!
    const probe = el.ownerDocument.createElement('span')
    el.append(probe)
    // `getComputedStyle` hands back the `oklch()` it was given, which is
    // not a thing to measure. Mixing in a named space makes the browser
    // resolve it: `color(srgb r g b)` and `oklab(L a b)`, both as plain
    // numbers, and neither of them guessed at from the other.
    const numbers = (space: string, css: string) => {
      probe.style.color = ''
      probe.style.color = `color-mix(in ${space}, ${css} 100%, transparent)`
      return window
        .getComputedStyle(probe)
        .color.match(/-?[\d.]+/g)!
        .map(Number)
    }
    const srgb = (css: string) => {
      const [r, g, b] = numbers('srgb', css)
      return [r!, g!, b!] as [number, number, number]
    }
    const oklab = (css: string) => {
      const [lightness, a, b] = numbers('oklab', css)
      return [lightness!, a!, b!] as [number, number, number]
    }
    // This body is serialised and run in the browser, so an outer-scope
    // helper is not there when it arrives.
    // oxlint-disable-next-line unicorn/consistent-function-scoping
    const channel = (value: number) => {
      // Clamped, because an out-of-gamut ink reports a channel outside
      // 0..1 and the screen shows the clipped colour, not that one.
      const unit = Math.min(1, Math.max(0, value))
      return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4
    }
    const luminance = ([r, g, b]: [number, number, number]) =>
      0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
    const ratio = (a: [number, number, number], b: [number, number, number]) => {
      const one = luminance(a)
      const other = luminance(b)
      const high = Math.max(one, other)
      const low = Math.min(one, other)
      return Math.round(((high + 0.05) / (low + 0.05)) * 10) / 10
    }
    // This body is serialised and run in the browser, so an outer-scope
    // helper is not there when it arrives.
    // oxlint-disable-next-line unicorn/consistent-function-scoping
    const distance = (a: [number, number, number], b: [number, number, number]) =>
      Math.round(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) * 1000) / 1000

    const ground = srgb('var(--color-kumo-control)')
    const contrast: Record<string, number> = {}
    const gamut: Record<string, boolean> = {}
    const lab: Record<string, [number, number, number]> = {}
    for (const name of ['key', 'string', 'literal', 'punctuation']) {
      const ink = srgb(`var(--color-firenook-code-${name})`)
      contrast[name] = ratio(ink, ground)
      gamut[name] = ink.every((value) => value >= -0.001 && value <= 1.001)
      lab[name] = oklab(`var(--color-firenook-code-${name})`)
    }
    const apart: Record<string, number> = {
      'key/string': distance(lab.key!, lab.string!),
      'string/literal': distance(lab.string!, lab.literal!),
      'key/literal': distance(lab.key!, lab.literal!),
    }
    probe.remove()
    return { contrast, gamut, apart }
  })
}

test('the JSON view reads the types the text can tell it, and no more', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  await put(page.request, 'teams/t_read', { seed: { stringValue: 'x' } })
  await page.goto(`${origin()}/console/firestore?path=teams&doc=teams%2Ft_read&tab=json`)
  const inspector = page.getByTestId('inspector')
  const editor = inspector.getByTestId('document-json')
  await expect(editor).toBeVisible()

  await replaceJson(
    page,
    editor,
    '{"whenISO":"2026-01-01T00:00:00.000Z","aDouble":3.0,"anInt":3,' +
      '"here":{"latitude":1.5,"longitude":2.5},' +
      '"vec":{"__type__":"__vector__","value":[0.1,0.2]},' +
      '"plainMap":{"latitude":1,"longitude":2,"label":"home"},' +
      '"notADate":"2026 was a year"}',
  )

  // The point survives being laid out. `JSON.stringify` writes the
  // double 3 as `3`, so Format and the tidying of a pasted document
  // both used to destroy the only evidence of the type before anything
  // could read it, and `3.0` went in as an integer.
  await expect(editor).toContainText('3.0')

  // Four values are typed by something other than the plain reading —
  // and not one of them is marked, because the text is what types them,
  // so editing any of them costs nothing. A mark here would be a box
  // and three lines of prose beside a value in no danger.
  await expect(inspector.locator('.cm-lint-marker')).toHaveCount(0)

  await inspector.getByTestId('save-document').click()
  await expect(page.getByText('Document saved')).toBeVisible()
  const stored = await page.request.get(`${documents()}/teams/t_read`, { headers: owner })
  const saved = (await stored.json()) as {
    fields: Record<string, Record<string, { fields?: Record<string, unknown> }>>
  }
  const kind = (name: string) => Object.keys(saved.fields[name] ?? {})[0]

  // Read, because the characters or the shape say so.
  expect(kind('aDouble')).toBe('doubleValue')
  expect(kind('here')).toBe('geoPointValue')
  expect(kind('whenISO')).toBe('timestampValue')
  // A vector is a map carrying Firestore's own marker, which is both
  // how it is stored and how this console writes it down.
  expect(Object.keys(saved.fields.vec?.mapValue?.fields ?? {})).toContain('__type__')

  // And left alone, because nothing in the text says otherwise. A map
  // with a third field is somebody's data, not a geopoint; a sentence
  // with a year in it is not an instant; a bare 3 is an integer.
  expect(kind('anInt')).toBe('integerValue')
  expect(kind('plainMap')).toBe('mapValue')
  expect(Object.keys(saved.fields.plainMap?.mapValue?.fields ?? {})).toHaveLength(3)
  expect(kind('notADate')).toBe('stringValue')
  await drop(page.request, 'teams/t_read')
})

test('the two views are one draft, and only Save writes', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  await put(page.request, 'teams/t_views', {
    name: { stringValue: 'Probe' },
    openedAt: { timestampValue: '2026-09-20T09:00:00Z' },
  })
  await page.goto(`${origin()}/console/firestore?path=teams&doc=teams%2Ft_views&tab=json`)
  const inspector = page.getByTestId('inspector')
  const editor = inspector.getByTestId('document-json')
  await expect(editor).toBeVisible()

  // Apply to fields is gone, and so is the hand-off it stood for. It was
  // doing two jobs — turning text into rows, and rescuing that text from
  // a tab switch that would otherwise discard it — and the tab beside it
  // already does the first.
  await expect(inspector.getByTestId('apply-json')).toHaveCount(0)
  await expect(inspector.getByTestId('save-document')).toBeDisabled()

  // Text that reads as a document *is* the document, with nothing
  // pressed: four fields where there were two, and a change to save.
  await replaceJson(
    page,
    editor,
    '{"name":"Probe","openedAt":"2026-09-20T09:00:00.000Z","brandNew":"hello","nested":{"deep":[1,2]}}',
  )
  await expect(inspector).toContainText('Fields · 4')
  await expect(inspector.getByTestId('save-pending')).toContainText('2 changes')
  await expect(inspector.getByTestId('save-document')).toBeEnabled()

  // Text that does not read as a document leaves the rows where they
  // were and holds Save, because the rows behind it are no longer what
  // is on screen.
  await replaceJson(page, editor, '{"name":"Probe",,,}')
  await expect(inspector).toContainText('Fields · 4')
  await expect(inspector.getByTestId('save-blocked')).toContainText('does not parse')
  await expect(inspector.getByTestId('save-document')).toBeDisabled()

  // And it is never thrown away. Entering this view used to rebuild the
  // text from the rows, so a glance at the other tab silently discarded
  // anything typed and not applied.
  const broken = await editor.textContent()
  await inspector.getByRole('tab', { name: /Fields/ }).click()
  await inspector.getByRole('tab', { name: 'JSON' }).click()
  await expect(inspector.getByTestId('document-json')).toHaveText(broken ?? '')

  // Unless the rows moved while it was away, in which case they are the
  // newer truth and the stale text goes.
  await inspector.getByRole('tab', { name: /Fields/ }).click()
  await inspector.getByTestId('new-field-name').fill('addedInRows')
  await inspector.getByTestId('add-field').click()
  await inspector.getByRole('tab', { name: 'JSON' }).click()
  await expect(inspector.getByTestId('document-json')).toContainText('addedInRows')

  // Save writes from this view, and the timestamp the text cannot spell
  // comes through it as a timestamp.
  await replaceJson(page, editor, '{"name":"Probed","openedAt":"2026-09-20T09:00:00.000Z"}')
  await inspector.getByTestId('save-document').click()
  await expect(page.getByText('Document saved')).toBeVisible()
  const stored = await page.request.get(`${documents()}/teams/t_views`, { headers: owner })
  const saved = (await stored.json()) as { fields: Record<string, Record<string, unknown>> }
  expect(Object.keys(saved.fields.openedAt ?? {})).toEqual(['timestampValue'])
  expect(saved.fields.name).toEqual({ stringValue: 'Probed' })
  await drop(page.request, 'teams/t_views')
})

test("the code editor's ink tells a key from a string from a number, in both modes", async ({
  page,
}) => {
  await put(page.request, 'teams/t_ink', {
    plan: { stringValue: 'enterprise' },
    seats: { integerValue: '785' },
  })
  await page.goto(`${origin()}/console/firestore?path=teams&doc=teams%2Ft_ink&tab=json`)
  const inspector = page.getByTestId('inspector')
  await expect(inspector.getByTestId('document-json')).toBeVisible()

  for (const mode of ['light', 'dark'] as const) {
    await inspector.evaluate((el, which) => {
      const root = el.ownerDocument.documentElement
      if (which === 'dark') root.setAttribute('data-mode', 'dark')
      else root.removeAttribute('data-mode')
    }, mode)
    const { contrast, gamut, apart } = await codeInk(inspector.getByTestId('document-json'))

    // Paintable. An `oklch()` past its hue's sRGB ceiling is not an
    // error — the browser clips it — so an ink outside the gamut is
    // measured as one colour and seen as another.
    for (const [ink, inside] of Object.entries(gamut))
      expect(inside, `${ink} is inside sRGB in ${mode}`).toBe(true)

    // Readable: AAA for the three that carry meaning, AA for the
    // punctuation, which is scaffolding and is meant to recede.
    expect(contrast.key, `key in ${mode}`).toBeGreaterThanOrEqual(7)
    expect(contrast.string, `string in ${mode}`).toBeGreaterThanOrEqual(7)
    expect(contrast.literal, `literal in ${mode}`).toBeGreaterThanOrEqual(7)
    expect(contrast.punctuation, `punctuation in ${mode}`).toBeGreaterThanOrEqual(4.5)

    // Telling apart. Every pair clears a floor; the two that do real
    // work clear a wider one — key from string is the structure of the
    // document, and string from number is the distinction Firestore
    // punishes you for, since `"269"` and `269` read the same. Key from
    // number is allowed to be the closest pair: a key is always quoted
    // and always followed by a colon, and a bare number never is, so
    // nothing rests on the colour telling those two apart.
    for (const [pair, far] of Object.entries(apart))
      expect(far, `${pair} in ${mode}`).toBeGreaterThanOrEqual(0.13)
    expect(apart['key/string'], `key/string in ${mode}`).toBeGreaterThanOrEqual(0.19)
    expect(apart['string/literal'], `string/literal in ${mode}`).toBeGreaterThanOrEqual(0.25)
  }

  // And the editor is actually painting with them, not merely declaring
  // them: a key, a string and a number off the screen, each its own ink.
  await inspector.evaluate((el) => el.ownerDocument.documentElement.removeAttribute('data-mode'))
  const painted = await inspector.getByTestId('document-json').evaluate((el) => {
    const window = el.ownerDocument.defaultView!
    const ink = (css: string) => {
      const probe = el.ownerDocument.createElement('span')
      el.append(probe)
      probe.style.color = css
      const value = window.getComputedStyle(probe).color
      probe.remove()
      return value
    }
    const found: Record<string, string> = {}
    for (const span of el.querySelectorAll('span')) {
      if (span.querySelector('span')) continue
      const text = (span.textContent ?? '').trim()
      if (text && !(text in found)) found[text] = window.getComputedStyle(span).color
    }
    return {
      found,
      key: ink('var(--color-firenook-code-key)'),
      string: ink('var(--color-firenook-code-string)'),
      literal: ink('var(--color-firenook-code-literal)'),
    }
  })
  expect(painted.found['"plan"']).toBe(painted.key)
  expect(painted.found['"enterprise"']).toBe(painted.string)
  expect(painted.found['785']).toBe(painted.literal)
  await drop(page.request, 'teams/t_ink')
})

/**
 * What a mark is actually painted in. Both halves of it: the shape out
 * in the gutter and the squiggle under the value.
 *
 * Every colour comes back resolved through the same mix, because
 * `getComputedStyle` hands back the `oklch()` it was given while a
 * token read straight off `:root` comes back as its own notation — two
 * spellings of one colour, which compare unequal. Mixed in `srgb` both
 * arrive as `color(srgb r g b)` and can simply be told apart or equal.
 */
async function markPaint(
  inspector: Locator,
  severity: 'info' | 'error',
): Promise<{
  edge: string
  fill: string
  squiggle: string
  token: string
  tint: string
  shape: string
  image: string
  offCentre: number
}> {
  return inspector.evaluate((el, which) => {
    const page = el.ownerDocument
    const window = page.defaultView!
    const probe = page.createElement('span')
    el.append(probe)
    const resolve = (css: string) => {
      probe.style.color = ''
      probe.style.color = `color-mix(in srgb, ${css} 100%, transparent)`
      return window.getComputedStyle(probe).color
    }

    const marker = el.querySelector(`.cm-lint-marker-${which}`)!
    const onMarker = window.getComputedStyle(marker)
    // A parse error can land between two characters rather than on
    // one, and CodeMirror draws a point there instead of a range, so
    // the squiggle is reported as absent rather than assumed.
    const range = el.querySelector(`.cm-lintRange-${which}`)
    const onRange = range ? window.getComputedStyle(range) : undefined
    const name = which === 'error' ? 'danger' : 'info'

    // Sitting on its line's middle, not resting wherever a margin tuned
    // to one line height happens to drop it.
    const box = marker.getBoundingClientRect()
    const line = marker.closest('.cm-gutterElement')!.getBoundingClientRect()

    const measured = {
      edge: resolve(onMarker.borderTopColor),
      fill: resolve(onMarker.backgroundColor),
      squiggle: onRange ? resolve(onRange.textDecorationColor) : 'no range',
      token: resolve(`var(--color-kumo-${name})`),
      tint: resolve(`var(--color-kumo-${name}-tint)`),
      // `normal`, not a `url(data:image/svg+xml…)`: the library paints
      // its shapes as a CSS `content` with the colour written into the
      // SVG, where no variable can reach it.
      shape: onMarker.content,
      image: onRange ? onRange.backgroundImage : 'none',
      offCentre: Math.round((box.top + box.height / 2 - (line.top + line.height / 2)) * 100) / 100,
    }
    probe.remove()
    return measured
  }, severity)
}

test("a mark is painted from the console's own palette, in both modes", async ({ page }) => {
  await put(page.request, 'teams/t_mark', {
    name: { stringValue: 'Marks' },
    // Bytes, because that is one of the three the text cannot hold, and
    // so one of the three that is marked at all.
    blob: { bytesValue: 'aGVsbG8=' },
  })
  await page.goto(`${origin()}/console/firestore?path=teams&doc=teams%2Ft_mark&tab=json`)
  const inspector = page.getByTestId('inspector')
  const editor = inspector.getByTestId('document-json')
  await expect(editor).toBeVisible()
  // One mark, on the one value whose type the text cannot write down.
  await expect(inspector.locator('.cm-lint-marker-info')).toHaveCount(1)

  for (const mode of ['light', 'dark'] as const) {
    await inspector.evaluate((el, which) => {
      const root = el.ownerDocument.documentElement
      if (which === 'dark') root.setAttribute('data-mode', 'dark')
      else root.removeAttribute('data-mode')
    }, mode)
    const mark = await markPaint(inspector, 'info')

    // CodeMirror draws both halves itself, in colours written into the
    // library — `#aaf` on `#77e` for the square, `#999` for the
    // squiggle — and its dark theme changes neither. Both are the
    // console's now, which is the whole claim: a mark that follows the
    // theme rather than sitting outside it in pale lilac.
    expect(mark.shape, `the gutter SVG is gone in ${mode}`).toBe('normal')
    expect(mark.image, `the squiggle image is gone in ${mode}`).toBe('none')
    expect(mark.edge, `the gutter edge in ${mode}`).toBe(mark.token)
    expect(mark.fill, `the gutter fill in ${mode}`).toBe(mark.tint)
    expect(mark.squiggle, `the squiggle in ${mode}`).toBe(mark.token)
    expect(Math.abs(mark.offCentre), `the shape is on the line in ${mode}`).toBeLessThanOrEqual(1)
  }

  // And the one mark that means a problem rather than a note takes the
  // other end of the palette, so the two are never read for each other.
  await editor.fill('{"name": "Marks",,}')
  await expect(inspector.locator('.cm-lint-marker-error')).toHaveCount(1)
  const broken = await markPaint(inspector, 'error')
  expect(broken.shape).toBe('normal')
  expect(broken.edge).toBe(broken.token)
  expect(broken.edge).not.toBe(
    await inspector.evaluate((el) => {
      const window = el.ownerDocument.defaultView!
      const probe = el.ownerDocument.createElement('span')
      el.append(probe)
      probe.style.color = 'color-mix(in srgb, var(--color-kumo-info) 100%, transparent)'
      const value = window.getComputedStyle(probe).color
      probe.remove()
      return value
    }),
  )

  await inspector.evaluate((el) => el.ownerDocument.documentElement.removeAttribute('data-mode'))
  await drop(page.request, 'teams/t_mark')
})

test('a mark appears only where editing the value would cost something', async ({ page }) => {
  // One document, both halves of the rule. A timestamp the text holds
  // on its own, and bytes and a reference that nothing in the text can
  // say. An earlier version marked all three and explained the
  // mechanism behind each, which on a document of dates put a box and
  // three lines of prose beside values in no danger at all.
  await put(page.request, 'teams/t_promise', {
    when: { timestampValue: '2026-08-05T03:27:55.046Z' },
    blob: { bytesValue: 'aGVsbG8=' },
    who: { referenceValue: `${resource()}/users/u_1` },
  })
  await page.goto(`${origin()}/console/firestore?path=teams&doc=teams%2Ft_promise&tab=json`)
  const inspector = page.getByTestId('inspector')
  const editor = inspector.getByTestId('document-json')
  await expect(editor).toBeVisible()
  // Two of the three, not three of the three.
  await expect(inspector.locator('.cm-lint-marker')).toHaveCount(2)

  const tips: string[] = []
  for (const index of [0, 1]) {
    await inspector.locator('.cm-lint-marker').nth(index).hover()
    await expect(page.locator('.cm-tooltip-lint')).toBeVisible()
    tips.push((await page.locator('.cm-tooltip-lint').textContent()) ?? '')
    await inspector.getByTestId('json-actions').hover()
  }
  expect(tips.some((tip) => tip.includes('Bytes — one base64 string looks like any other'))).toBe(
    true,
  )
  expect(
    tips.some((tip) => tip.includes('A reference — one document path looks like any other')),
  ).toBe(true)
  // Every mark names the cost and the way round it, and none mentions
  // the draft model the JSON tab does not show.
  for (const tip of tips) {
    expect(tip).toContain('saves it as a string')
    expect(tip).toContain('The Fields tab keeps the type')
    expect(tip).not.toContain('row')
  }

  // Now do the thing the marks describe: replace every value with
  // another that looks exactly as valid, and save.
  await editor.fill(
    JSON.stringify(
      { when: '2027-01-01T00:00:00.000Z', blob: 'd29ybGQ=', who: 'users/u_2' },
      undefined,
      2,
    ),
  )
  await inspector.getByTestId('save-document').click()
  await expect(page.getByText('Document saved')).toBeVisible()

  const stored = await page.request.get(`${documents()}/teams/t_promise`, { headers: owner })
  const saved = (await stored.json()) as { fields: Record<string, Record<string, unknown>> }
  // The unmarked one kept its type, and took the new value.
  expect(Object.keys(saved.fields.when ?? {})).toEqual(['timestampValue'])
  expect(saved.fields.when?.timestampValue).toBe('2027-01-01T00:00:00Z')
  // The two that were marked came back as the strings they looked like,
  // although `d29ybGQ=` is valid base64 and `users/u_2` a valid path.
  expect(Object.keys(saved.fields.blob ?? {})).toEqual(['stringValue'])
  expect(Object.keys(saved.fields.who ?? {})).toEqual(['stringValue'])
  await drop(page.request, 'teams/t_promise')
})

test('the JSON tab is a code editor, and the types the rows carry are marked on it', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  await put(page.request, 'teams/t_code', {
    name: { stringValue: 'Mapping' },
    // A double that reads whole, and a timestamp. Both are types JSON
    // has no way of writing down, but only one of them is at risk: the
    // text reads an ISO date back as a date, and reads `4` as an
    // integer whatever the stored field says.
    seats: { doubleValue: 4 },
    opened: { timestampValue: '2026-09-20T09:00:00Z' },
    active: { booleanValue: true },
  })
  await page.goto(`${origin()}/console/firestore?path=teams&doc=teams%2Ft_code&tab=json`)
  const inspector = page.getByTestId('inspector')
  const editor = inspector.getByTestId('document-json')
  await expect(editor).toBeVisible()
  await expect(inspector.locator('.cm-lineNumbers')).toBeVisible()

  // One mark, on the one value editing would cost something.
  await expect(inspector.locator('.cm-lint-marker')).toHaveCount(1)
  await inspector.locator('.cm-lint-marker').hover()
  await expect(page.locator('.cm-tooltip-lint')).toBeVisible()
  const tip = (await page.locator('.cm-tooltip-lint').textContent()) ?? ''
  expect(tip).toContain('A double — 4 is also how an integer is written')
  expect(tip).toContain('saves it as an integer')
  await inspector.getByTestId('json-actions').hover()

  // A document pasted over this one arrives laid out, which is the case
  // anybody ever reached for a Format button for. One line in, six out.
  await replaceJson(
    page,
    editor,
    '{"name":"Mapping","seats":4,"opened":"2026-09-20T09:00:00.000Z","active":true}',
  )
  await expect(inspector.locator('.cm-line')).toHaveCount(6)

  // And one undo takes the paste and its laying out together, because
  // the tidying rewrote that transaction rather than following it.
  await page.keyboard.press('ControlOrMeta+z')
  await expect(inspector.locator('.cm-line')).toHaveCount(6)
  await expect(editor).toContainText('"active"')

  // Format itself is still there for a document gone ragged by hand.
  await editor.fill('{"name":"Mapping","seats":4}')
  await expect(inspector.locator('.cm-line')).toHaveCount(1)
  // Named for what it lays out. It is the only control in its band and
  // sits under a document that may be JSON or may be rows, so "Format"
  // alone left the reader to work out which of the two it meant.
  await expect(inspector.getByTestId('format-json')).toHaveText('Format JSON')
  await inspector.getByTestId('format-json').click()
  await expect(inspector.locator('.cm-line')).toHaveCount(4)

  // A parse error lands on the character that caused it, not in a
  // sentence under the box.
  await editor.fill('{"name": "Mapping",,}')
  await expect(inspector.locator('.cm-lint-marker-error')).toHaveCount(1)
  await inspector.locator('.cm-lint-marker-error').hover()
  await expect(page.locator('.cm-tooltip-lint')).toContainText('JSON')

  // And the rows are still the thing being saved: fix it, apply, save.
  await editor.fill('{"name": "Mapped", "seats": 4, "opened": "2026-09-20T09:00:00.000Z"}')
  await expect(inspector).toContainText('Fields · 3')
  await inspector.getByTestId('save-document').click()
  await expect(page.getByText('Document saved')).toBeVisible()

  // The timestamp survived the round trip through text, which is the
  // whole claim the marks make.
  const stored = await page.request.get(`${documents()}/teams/t_code`, { headers: owner })
  const saved = (await stored.json()) as { fields: Record<string, Record<string, unknown>> }
  expect(Object.keys(saved.fields.opened ?? {})).toEqual(['timestampValue'])
  expect(Object.keys(saved.fields.seats ?? {})).toEqual(['doubleValue'])
  await drop(page.request, 'teams/t_code')
})

test('the inspector takes the width it is given, and remembers it', async ({ page }) => {
  // Room to drag in, so what is measured is the behaviour and not the
  // window: the ceiling below is what the window has to do with it.
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${origin()}/console/firestore?path=users&doc=users%2Fu_k65eq`)
  const inspector = page.getByTestId('inspector')
  await expect(inspector.getByLabel('displayName value')).toHaveValue('Ada Lovelace')
  const width = async () => Math.round((await inspector.boundingBox())!.width)
  const grip = page.getByTestId('inspector-resize')
  const drag = async (by: number) => {
    const box = (await grip.boundingBox())!
    const from = box.x + box.width / 2
    await page.mouse.move(from, box.y + 200)
    await page.mouse.down()
    await page.mouse.move(from - by, box.y + 200, { steps: 8 })
    await page.mouse.up()
  }
  expect(await width()).toBe(420)

  // The grip is the panel's own left edge, and is drawn there. It was
  // not: in the flow the panel was `static`, which is not a containing
  // block, so the grip escaped to an ancestor and drew itself 523 px away
  // down the side of the grid. Every drag still changed the width, because
  // it landed on the clamp — which is what an assertion about the width
  // alone cannot tell apart from the real thing.
  const box = (await grip.boundingBox())!
  const panelEdge = (await inspector.boundingBox())!.x
  expect(Math.abs(box.x + box.width / 2 - panelEdge)).toBeLessThan(3)
  expect(await paintedAtItsOwnCentre(grip)).toBe(true)

  // The panel's width is the real constraint on the field editor, not the
  // arrangement inside it: a name column and a value column share 420 px,
  // which leaves a value thirty-nine characters before it wraps, and a
  // document of URLs and hashes has none that short. It follows the
  // pointer exactly, rather than jumping to whatever the clamp allows.
  await drag(180)
  expect(Math.abs((await width()) - 600)).toBeLessThan(4)

  // However far it is dragged, the grid beside it stays worth having.
  await drag(4000)
  const available = await inspector.evaluate(
    (el) => el.parentElement?.getBoundingClientRect().width ?? 0,
  )
  expect(await width()).toBeLessThanOrEqual(available - 360)

  // What it settled on is what it opens at next time.
  const settled = await width()
  await page.reload()
  await expect(inspector.getByLabel('displayName value')).toHaveValue('Ada Lovelace')
  expect(await width()).toBe(settled)

  // And the edge gives it back: a double-click is the way home.
  await grip.dblclick()
  expect(await width()).toBe(420)

  // Home is a share of the window, not a number picked on a laptop. The
  // flat 420 this started as is sixteen per cent of a 2557 px display,
  // against the twenty-six per cent Supabase gives the same panel — snug
  // on the machine it was chosen on and stingy on the one it shipped to.
  await page.evaluate(() => localStorage.removeItem('firenook.console.inspector-width'))
  await page.setViewportSize({ width: 2560, height: 900 })
  await page.reload()
  await expect(inspector.getByLabel('displayName value')).toHaveValue('Ada Lovelace')
  expect(await width()).toBeGreaterThan(640)
})

test('the bottom of the drawer spends colour on what can be done, not on what is there', async ({
  page,
}) => {
  await page.goto(`${origin()}/console/firestore?path=users&doc=users%2Fu_k65eq`)
  const inspector = page.getByTestId('inspector')
  await expect(inspector.getByLabel('displayName value')).toHaveValue('Ada Lovelace')

  // The one action of the add line is never drawn as unavailable. It was
  // `ghost` and `disabled` until a name was typed — which is every moment
  // anybody is looking for it — so half opacity sat on an already subtle
  // grey, beside a placeholder and a type chip that are subtle too, and
  // nothing in the band was at full strength. A control that can always
  // begin its own job has no disabled state to draw: with nothing typed
  // it points at the field that needs filling.
  const add = inspector.getByTestId('add-field')
  expect((await paint(add)).opacity).toBe('1')
  await expect(add).toBeEnabled()
  await add.click()
  await expect(inspector.getByTestId('new-field-name')).toBeFocused()

  // The fill means there is something to save. It used to be the brand
  // fill always, which a disabled button draws at half opacity, so "save
  // now" and "nothing to save" differed only by translucency — and the
  // washed accent still pulled hardest in a panel whose usual business is
  // reading.
  const save = inspector.getByTestId('save-document')
  const resting = await paint(save)
  await inspector.getByLabel('plan value').fill('team')
  await expect(inspector.getByTestId('save-pending')).toContainText('1 change')
  const armed = await paint(save)
  expect(armed.background).not.toBe(resting.background)
  expect(armed.opacity).toBe('1')

  // And red is spent once. A bordered destructive button was the loudest
  // mark in the footer at rest, louder than Save; the word keeps the
  // colour and the box goes.
  const destroy = inspector.getByLabel('Delete this document')
  expect((await paint(destroy)).background).toBe('rgba(0, 0, 0, 0)')
  await expect(destroy.locator('span').first()).toHaveText('Delete')

  // Empty, the subcollections section is one line. It was the tallest
  // band in the panel — 56 px against the footer's 42 — and the only one
  // with nothing in it, because a 12 px label was followed by a 13 px
  // "None yet." in the same grey: a sentence larger than its own heading.
  // On a document that has none — the seeded user holds orders and
  // sessions, so this needs one of its own.
  await put(page.request, 'teams/t_bare', { name: { stringValue: 'Bare' } })
  await page.goto(`${origin()}/console/firestore?path=teams&doc=teams%2Ft_bare`)
  await expect(inspector.getByLabel('name value')).toHaveValue('Bare')
  await expect(inspector.getByTestId('subcollections')).toContainText('Subcollections · none')
  const footer = await band(inspector.locator('footer'))
  expect(await band(inspector.getByTestId('subcollections'))).toBeLessThanOrEqual(footer)

  // The action sits at the right end of the row, where a hand goes
  // looking for the main button — and the tools went the other way, so
  // the confirming control is not seated against the destroying one.
  // Sending Save right without moving them would have put 3 px between
  // Save and Delete; there are two hundred.
  const saveBox = (await inspector.getByTestId('save-document').boundingBox())!
  const deleteBox = (await inspector.getByLabel('Delete this document').boundingBox())!
  const codeBox = (await inspector.getByTestId('document-code').boundingBox())!
  expect(saveBox.x).toBeGreaterThan(edge(deleteBox))
  expect(codeBox.x).toBeLessThan(deleteBox.x)
  expect(saveBox.x - edge(deleteBox)).toBeGreaterThan(80)

  // The rule divides the row by what the controls do, not by which one
  // is frightening. Code opens a panel and changes nothing; Duplicate
  // and Delete both change which documents exist, so they are the group
  // and Code is the one outside it. Three pixels is the rhythm within a
  // group, so the gap past the rule is several times it.
  const dupBox = (await inspector.getByTestId('duplicate-document').boundingBox())!
  const pastTheRule = dupBox.x - edge(codeBox)
  const withinGroup = deleteBox.x - edge(dupBox)
  expect(pastTheRule).toBeGreaterThan(withinGroup * 2)

  // Duplicate carries a word. It was the one bare glyph in a row of
  // labelled controls, and a copy glyph at that — the header above has
  // one too, which copies the path — so the control nobody could name
  // was also the one most easily taken for something else.
  await expect(inspector.getByTestId('duplicate-document')).toContainText('Duplicate')
  // And at any width the panel opens at, Code carries one as well.
  await expect(inspector.getByTestId('document-code')).toHaveText('Code')

  // Every icon button down here is the one size. Kumo's extra-small
  // square renders 12 px at a 14 px root, half of every other control in
  // the panel and below any sane hit target.
  const squares = await Promise.all(
    ['add-subcollection', 'document-code'].map(async (id) =>
      Math.round((await inspector.getByTestId(id).boundingBox())!.height),
    ),
  )
  expect(new Set(squares).size).toBe(1)
  expect(Math.min(...squares)).toBeGreaterThanOrEqual(20)

  // Dragged to the floor, the row gives up one word rather than
  // crowding Save against Delete. Measured with the word kept: Save
  // sits 13 px from Delete at 320, which is the adjacency this row's
  // whole layout exists to prevent. The word is the first thing to go
  // because Code is the one control down here that changes nothing.
  await inspector.evaluate((el) => {
    try {
      el.ownerDocument.defaultView!.localStorage.setItem('firenook.console.inspector-width', '320')
    } catch {
      /* a private window has no storage, and the default width still holds */
    }
  })
  await page.reload()
  await expect(inspector.getByTestId('save-document')).toBeVisible()
  await expect(inspector.getByTestId('document-code')).toHaveText('')
  // The two that act on the document keep theirs: a word is given up
  // to buy room, and only as much of it as the room needs.
  await expect(inspector.getByTestId('duplicate-document')).toContainText('Duplicate')
  await expect(inspector.getByLabel('Delete this document')).toContainText('Delete')
  const tight = (await inspector.getByTestId('save-document').boundingBox())!
  const tightDelete = (await inspector.getByLabel('Delete this document').boundingBox())!
  // A Save's own width of nothing between them, which is the least that
  // reads as the other end of the row.
  expect(Math.round(tight.x - edge(tightDelete))).toBeGreaterThanOrEqual(42)
})

/** Documents written straight to the engine, keyed by id, in batches it accepts. */
async function seed(
  request: { post: (url: string, options: object) => Promise<{ ok: () => boolean }> },
  collection: string,
  docs: Record<string, Record<string, unknown>>,
) {
  const writes = Object.entries(docs).map(([id, fields]) => ({
    update: { name: `${resource()}/${collection}/${id}`, fields },
  }))
  for (let at = 0; at < writes.length; at += 400) {
    const response = await request.post(`${documents()}:commit`, {
      headers: owner,
      data: { writes: writes.slice(at, at + 400) },
    })
    expect(response.ok()).toBeTruthy()
  }
}

/**
 * A cell, scrolled to. Columns are virtualized like rows, so one that is
 * off screen is not in the page until the grid has been scrolled to it.
 */
async function reach(page: import('@playwright/test').Page, path: string, field: string) {
  const cell = page.locator(`tr[data-path="${path}"] td[data-field="${field}"]`)
  const grid = page.getByTestId('grid-scroll')
  await grid.evaluate((el) => (el.scrollLeft = 0))
  await expect(page.locator(`tr[data-path="${path}"]`)).toBeVisible()
  for (let step = 0; step < 40 && (await cell.count()) === 0; step++) {
    await grid.evaluate((el) => (el.scrollLeft += 240))
    await page.waitForTimeout(40)
  }
  await cell.evaluate((td) => td.scrollIntoView({ inline: 'center', block: 'nearest' }))
  return cell
}

/**
 * A pinned column's edge: a strip on the cell's far side, shown, and as
 * tall as the cell, so each row's meets the next and the column has one
 * edge.
 */
const edgeOf = (cell: Locator) =>
  cell.evaluate((td) => {
    const strip = td.ownerDocument.defaultView!.getComputedStyle(td, '::after')
    return {
      shown: strip.content !== 'none' && strip.opacity === '1',
      full: Number.parseFloat(strip.height) === (td as { offsetHeight: number }).offsetHeight,
    }
  })

const text = (value: string) => ({ stringValue: value })

test('documents that disagree keep their columns still and say what each covers', async ({
  page,
}) => {
  // A hundred documents of one shape, ten of an older one among them, and
  // a second page that brings a field the first page never had.
  const docs: Record<string, Record<string, unknown>> = {}
  for (let at = 0; at < 120; at++) {
    const id = `d${String(at).padStart(3, '0')}`
    docs[id] = { name: text(`Name ${at}`), email: text(`${id}@example.test`) }
    if (at < 10) docs[id].legacy = text('yes')
    if (at >= 100) docs[id].plan = text('pro')
  }
  await seed(page.request, 'disagree', docs)
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.goto(`${origin()}/console/firestore?path=disagree`)
  await expect(page.getByTestId('grid-row').first()).toBeVisible()
  const order = () =>
    page
      .locator('thead button[data-testid^="column-"]')
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')))
  await expect.poll(order).toEqual(['column-email', 'column-name', 'column-legacy'])

  // The header says how much of the page has the field, and only when not
  // all of it does: a column reads as a promise every row keeps.
  await expect(page.getByTestId('column-legacy').getByTestId('column-coverage')).toHaveText('10%')
  await expect(page.getByTestId('column-name').getByTestId('column-coverage')).toHaveCount(0)
  await page.getByTestId('column-legacy').click()
  await expect(page.getByTestId('column-present')).toHaveText('In 10 of the 100 loaded documents')
  await page.keyboard.press('Escape')

  // A document without the field says so, which an empty cell did not.
  await expect(
    page.locator('tr[data-path="disagree/d011"] td[data-field="legacy"]').getByTestId('not-set'),
  ).toBeVisible()
  await expect(
    page.locator('tr[data-path="disagree/d001"] td[data-field="legacy"]').getByTestId('not-set'),
  ).toHaveCount(0)

  // The second page's field joins at the end. Ordered by count it went
  // before `legacy` — twenty documents to ten — and moved a column under
  // the reader mid-scroll.
  await page.getByTestId('grid-scroll').evaluate((el) => (el.scrollTop = el.scrollHeight))
  await expect(page.getByText('120 loaded')).toBeVisible()
  await expect.poll(order).toEqual(['column-email', 'column-name', 'column-legacy', 'column-plan'])
})

test('fields only one document has fold into a column, and come back on request', async ({
  page,
}) => {
  // Top-level keys per user: every document its own fifteen.
  const docs: Record<string, Record<string, unknown>> = {}
  for (let at = 0; at < 40; at++) {
    const fields: Record<string, unknown> = { owner: text(`u${at}`) }
    for (let key = 0; key < 15; key++) fields[`uid_${at}_${key}`] = { booleanValue: true }
    docs[`p${String(at).padStart(2, '0')}`] = fields
  }
  await seed(page.request, 'perkey', docs)
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.goto(`${origin()}/console/firestore?path=perkey`)
  await expect(page.getByTestId('grid-row').first()).toBeVisible()
  await expect(page.getByTestId('column-folded')).toContainText('+600 fields')
  await expect(page.locator('thead button[data-testid^="column-"]')).toHaveCount(2)
  await expect(page.locator('tr[data-path="perkey/p00"]').getByTestId('cell-folded')).toContainText(
    '+15',
  )

  await page.getByTestId('column-folded').click()
  await expect(page.getByRole('menu')).toContainText(
    '600 fields that only one of the 40 loaded documents have',
  )
  await page.getByTestId('unfold-columns').click()
  await expect(page.getByTestId('column-folded')).toHaveCount(0)
  await expect(page.getByTestId('column-uid_0_0')).toBeVisible()

  // Six hundred columns, and only the ones in view are in the page.
  // Drawn whole, the same grid over 1,501 fields was 143,667 elements and
  // scrolled in frames of up to 950 ms.
  expect(await page.locator('*').count()).toBeLessThan(6000)
})

test('the id stays in view while the fields scroll, and a flash never shows through it', async ({
  page,
}) => {
  const docs: Record<string, Record<string, unknown>> = {}
  for (let at = 0; at < 3; at++) {
    const fields: Record<string, unknown> = {}
    for (let key = 0; key < 14; key++) fields[`field${key}`] = text(`value ${at} ${key}`)
    docs[`w${at}`] = fields
  }
  await seed(page.request, 'pinned', docs)
  await page.setViewportSize({ width: 1400, height: 800 })
  await page.goto(`${origin()}/console/firestore?path=pinned`)
  const row = page.locator('tr[data-path="pinned/w0"]')
  await expect(row).toBeVisible()

  // A row is as tall as the virtualizer places it. They were 31.5 px
  // against an estimate of 36, so every spacer was worked out wrong.
  expect((await row.boundingBox())!.height).toBe(32)

  const grid = page.getByTestId('grid-scroll')
  const id = row.locator('td[data-field="__name__"]')
  // Nothing under the id yet, so nothing to set it apart from.
  expect((await edgeOf(id)).shown).toBe(false)
  await grid.evaluate((el) => (el.scrollLeft = 700))
  await expect
    .poll(async () => (await id.boundingBox())!.x - (await grid.boundingBox())!.x)
    .toBe(64)
  // And once fields pass beneath it, an edge, the full height of the row.
  // It was a shadow with a negative spread, which stopped short of every
  // row's top and bottom and drew the edge as a stack of pills; before that
  // it named a colour token that does not exist and drew nothing at all.
  await expect.poll(() => edgeOf(id)).toEqual({ shown: true, full: true })

  // Unfrozen from its own header menu, the id scrolls with the fields and
  // only the box stays, with the edge moving to it. The choice is kept.
  await page.getByTestId('id-header').click()
  await page.getByTestId('unfreeze-id').click()
  const check = row.locator('td[data-check]')
  await expect
    .poll(async () => (await id.boundingBox())!.x - (await grid.boundingBox())!.x)
    .toBeLessThan(0)
  expect((await check.boundingBox())!.x - (await grid.boundingBox())!.x).toBe(0)
  expect((await edgeOf(id)).shown).toBe(false)
  await expect.poll(() => edgeOf(check)).toEqual({ shown: true, full: true })
  await page.reload()
  await grid.evaluate((el) => (el.scrollLeft = 700))
  await expect
    .poll(async () => (await id.boundingBox())!.x - (await grid.boundingBox())!.x)
    .toBeLessThan(0)
  await page.getByTestId('id-header').click()
  await page.getByTestId('freeze-id').click()
  await expect
    .poll(async () => (await id.boundingBox())!.x - (await grid.boundingBox())!.x)
    .toBe(64)

  // A write flashes the row. The tint is translucent, and painted as the
  // pinned cell's ground it let the fields scrolling under it show
  // through for the length of the flash.
  await put(page.request, 'pinned/w0', { field0: text('changed') })
  await expect(row).toHaveClass(/row-flash/)
  const ground = await id.evaluate(
    (td) => td.ownerDocument.defaultView!.getComputedStyle(td).backgroundColor,
  )
  expect(ground).not.toMatch(/rgba|\/ 0?\.\d|transparent/)
})

test('every value edits where it is, as the inspector edits it', async ({ page }) => {
  await seed(page.request, 'inplace', {
    k1: {
      title: text('Hello'),
      ratio: { doubleValue: 269 },
      meta: { mapValue: { fields: { plan: text('pro'), seats: { integerValue: '5' } } } },
    },
    k2: { title: text('Second') },
  })
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.goto(`${origin()}/console/firestore?path=inplace`)
  const editor = page.getByTestId('cell-editor')
  const stored = async (path: string) => {
    const response = await page.request.get(`${documents()}/${path}`, { headers: owner })
    return ((await response.json()) as { fields: Record<string, unknown> }).fields
  }

  // A double that reads whole stays a double: the editor is the
  // inspector's, which says which of the two a number is.
  await (await reach(page, 'inplace/k1', 'ratio')).dblclick()
  await expect(editor).toHaveAttribute('data-layout', 'line')
  const ratio = editor.getByRole('textbox', { name: 'ratio value' })
  await expect(ratio).toBeFocused()
  await ratio.fill('270')
  await ratio.press('Enter')
  await expect(editor).toHaveCount(0)
  await expect.poll(async () => (await stored('inplace/k1')).ratio).toEqual({ doubleValue: 270 })

  // A map is a structure, so it opens as one: the inspector's own rows.
  await (await reach(page, 'inplace/k1', 'meta')).dblclick()
  await expect(editor).toHaveAttribute('data-layout', 'panel')
  const plan = editor.getByRole('textbox', { name: 'plan value' })
  await expect(plan).toBeFocused()
  await plan.fill('team')
  await plan.press('Enter')
  await expect
    .poll(async () => (await stored('inplace/k1')).meta)
    .toEqual({ mapValue: { fields: { plan: text('team'), seats: { integerValue: '5' } } } })

  // A field this document lacks opens as its column's type. Opened and
  // left alone, nothing is written; typed into, the field is created.
  await (await reach(page, 'inplace/k2', 'ratio')).dblclick()
  await expect(editor.getByRole('textbox', { name: 'ratio value' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(editor).toHaveCount(0)
  expect(Object.keys(await stored('inplace/k2'))).toEqual(['title'])
  await (await reach(page, 'inplace/k2', 'ratio')).dblclick()
  await page.keyboard.type('7')
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await stored('inplace/k2')).ratio).toEqual({ integerValue: '7' })

  // Clicking anywhere else is done, as in a sheet.
  await (await reach(page, 'inplace/k2', 'title')).dblclick()
  await page.keyboard.type('Clicked away')
  await page.mouse.click(800, 700)
  await expect(editor).toHaveCount(0)
  await expect.poll(async () => (await stored('inplace/k2')).title).toEqual(text('Clicked away'))
})

test('the keyboard walks the cells, edits the one it is on, and copies it', async ({ page }) => {
  const docs: Record<string, Record<string, unknown>> = {}
  for (let at = 0; at < 5; at++)
    docs[`p${at}`] = { email: text(`p${at}@example.test`), name: text(`Person ${at}`) }
  await seed(page.request, 'walk', docs)
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.goto(`${origin()}/console/firestore?path=walk`)
  await page.locator('tr[data-path="walk/p0"] td[data-field="email"]').click()
  await page.keyboard.press('Escape')

  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowDown')
  await expect(page.locator('td[data-cursor]')).toHaveCount(1)
  await expect(page.locator('tr[data-path="walk/p1"] td[data-field="name"]')).toHaveAttribute(
    'data-cursor',
    '',
  )
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('cell-editor')).toBeVisible()
  await page.keyboard.type('Renamed')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('cell-editor')).toHaveCount(0)
  await expect
    .poll(async () => {
      const response = await page.request.get(`${documents()}/walk/p1`, { headers: owner })
      return ((await response.json()) as { fields: Record<string, unknown> }).fields.name
    })
    .toEqual(text('Renamed'))

  const clipboard = () =>
    page.evaluate(() =>
      (
        navigator as Navigator & { clipboard: { readText(): Promise<string> } }
      ).clipboard.readText(),
    )
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ControlOrMeta+c')
  await expect.poll(clipboard).toBe('p1@example.test')
  // Left of the first field is the row's own cell, and that copies the id.
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ControlOrMeta+c')
  await expect.poll(clipboard).toBe('p1')
})

test('a column drags wider, keeps that width, and double-click gives it back', async ({ page }) => {
  await seed(page.request, 'widths', { w1: { email: text('a@example.test'), name: text('A') } })
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.goto(`${origin()}/console/firestore?path=widths`)
  const head = page.locator('th', { has: page.getByTestId('column-email') })
  const width = async () => Math.round((await head.boundingBox())!.width)
  const before = await width()
  await head.hover()
  const handle = (await page.getByTestId('resize-email').boundingBox())!
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
  await page.mouse.down()
  await page.mouse.move(handle.x + 120, handle.y + handle.height / 2, { steps: 6 })
  await page.mouse.up()
  expect(await width()).toBeGreaterThan(before + 100)

  await page.reload()
  await expect(head).toBeVisible()
  expect(await width()).toBeGreaterThan(before + 100)
  await page.getByTestId('resize-email').dblclick()
  await expect.poll(width).toBe(before)
})

test('a sort that leaves documents out says how many', async ({ page }) => {
  const docs: Record<string, Record<string, unknown>> = {}
  for (let at = 0; at < 40; at++)
    docs[`r${at}`] = { name: text(`R ${at}`), ...(at % 4 === 0 ? { referredBy: text('u1') } : {}) }
  await seed(page.request, 'sparse', docs)
  // Firestore sorts only the documents that have the field, and the grid
  // of what is left looks complete.
  await page.goto(
    `${origin()}/console/firestore?path=sparse&q=${encodeURIComponent('orderBy("referredBy")')}`,
  )
  await expect(page.getByTestId('match-count')).toContainText('10 documents')
  await expect(page.getByTestId('query-leaves-out')).toContainText(
    '30 documents without referredBy are left out',
  )
  // Every document has `name`, so sorting by it leaves nothing out.
  await page.goto(
    `${origin()}/console/firestore?path=sparse&q=${encodeURIComponent('orderBy("name")')}`,
  )
  await expect(page.getByTestId('match-count')).toContainText('40 documents')
  await expect(page.getByTestId('query-leaves-out')).toHaveCount(0)
})

test('shift-click ticks a run of rows, and ticking one does not open it', async ({ page }) => {
  const docs: Record<string, Record<string, unknown>> = {}
  for (let at = 0; at < 8; at++) docs[`t${at}`] = { name: text(`T ${at}`) }
  await seed(page.request, 'ticks', docs)
  await page.goto(`${origin()}/console/firestore?path=ticks`)
  const rows = page.getByTestId('grid-row')
  await rows.nth(1).getByRole('checkbox').click()
  await expect(page.getByTestId('inspector')).toHaveCount(0)
  await rows
    .nth(5)
    .getByRole('checkbox')
    .click({ modifiers: ['Shift'] })
  await expect(page.getByTestId('delete-selected')).toHaveText('Delete 5')
  // Shift on a press is also the browser's "extend the text selection",
  // and it painted every id, value and chip between the two rows.
  const selected = () =>
    page.locator('body').evaluate((body) => body.ownerDocument.getSelection()?.toString() ?? '')
  expect(await selected()).toBe('')
})

test('a click picks the cell; the open button opens the row, and an open panel follows', async ({
  page,
}) => {
  const docs: Record<string, Record<string, unknown>> = {}
  for (let at = 0; at < 4; at++) docs[`c${at}`] = { name: text(`C ${at}`), email: text(`c${at}@x`) }
  await seed(page.request, 'clicks', docs)
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.goto(`${origin()}/console/firestore?path=clicks`)
  const first = page.locator('tr[data-path="clicks/c0"]')
  const second = page.locator('tr[data-path="clicks/c1"]')
  const inspector = page.getByTestId('inspector')

  // A click is the cell's: the cursor lands on it and nothing else opens.
  // It used to open the panel, which took 40% of a 1600 px grid away.
  await first.locator('td[data-field="name"]').click()
  await expect(first.locator('td[data-field="name"]')).toHaveAttribute('data-cursor', '')
  await page.waitForTimeout(400)
  await expect(inspector).toHaveCount(0)

  // The way in shows on the row, and opens it.
  const open = first.getByTestId('open-row')
  await expect(open).toHaveCSS('opacity', '1')
  await expect(second.getByTestId('open-row')).toHaveCSS('opacity', '0')
  await open.click()
  await expect(inspector).toContainText('clicks/c0')
  await expect(open).toHaveAttribute('aria-pressed', 'true')

  // While it is open, the panel follows the row being worked on.
  await second.locator('td[data-field="email"]').click()
  await expect(inspector).toContainText('clicks/c1')
  // And the pressed button closes it again.
  await second.getByTestId('open-row').click()
  await expect(inspector).toHaveCount(0)
})

test('ticked rows turn the query line into their own bar, which reaches every document', async ({
  page,
}) => {
  // More than a page, and one document with a subcollection under it.
  const docs: Record<string, Record<string, unknown>> = {}
  for (let at = 0; at < 130; at++)
    docs[`s${String(at).padStart(3, '0')}`] = {
      name: text(`S ${at}`),
      at: { integerValue: `${at}` },
    }
  await seed(page.request, 'bulk', docs)
  await put(page.request, 'bulk/s000/notes/n1', { body: text('beneath') })
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.goto(`${origin()}/console/firestore?path=bulk`)
  const rows = page.getByTestId('grid-row')
  await expect(rows.first()).toBeVisible()
  const bar = page.getByTestId('selection-bar')
  await expect(bar).toHaveCount(0)

  // Ticking does not move the rows: the bar lies over the query line at
  // its height, so a shift-click aimed at the next row still lands on it.
  const before = (await rows.nth(2).boundingBox())!.y
  await rows.nth(1).getByRole('checkbox').click()
  await rows
    .nth(2)
    .getByRole('checkbox')
    .click({ modifiers: ['Shift'] })
  await expect(bar).toBeVisible()
  await expect(page.getByTestId('selection-count')).toHaveText('2 selected')
  expect((await rows.nth(2).boundingBox())!.y).toBe(before)
  // Delete has left the toolbar for the bar.
  await expect(page.getByTestId('toolbar').getByTestId('delete-selected')).toHaveCount(0)

  // Copy reads the two whole, by path.
  await page.getByTestId('copy-selection').click()
  await page.getByTestId('copy-json').click()
  await expect(page.getByText('Copied 2 documents as JSON')).toBeVisible()
  const copied = JSON.parse(
    await page.evaluate(() =>
      (
        navigator as Navigator & { clipboard: { readText(): Promise<string> } }
      ).clipboard.readText(),
    ),
  ) as Record<string, unknown>
  expect(Object.keys(copied)).toEqual(['s001', 's002'])

  // Every document, not the loaded hundred.
  await page.getByTestId('select-everything').click()
  await expect(page.getByTestId('selection-count')).toHaveText('All 130 selected')
  await page.getByTestId('delete-selected').click()
  await expect(
    page.getByRole('dialog').filter({ hasText: 'Delete all 130 documents' }),
  ).toBeVisible()
  await page.getByTestId('confirm-delete').click()
  await expect(page.getByText('131 documents deleted')).toBeVisible()
  await expect(bar).toHaveCount(0)
  const left = await page.request.get(`${documents()}/bulk/s129`, { headers: owner })
  expect(left.status()).toBe(404)
  // "Also delete subcollections underneath" now does: it sent no mode, and
  // the engine read that as the document alone.
  const beneath = await page.request.get(`${documents()}/bulk/s000/notes/n1`, { headers: owner })
  expect(beneath.status()).toBe(404)
})
