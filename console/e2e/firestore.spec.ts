import { expect, test } from '@playwright/test'

// The Firestore workbench against a real engine seeded by scripts/seed-firestore.mjs.
const origin = () => {
  const value = process.env.FIRENOOK_CONSOLE_ORIGIN
  if (!value) throw new Error('the engine global setup did not run')
  return value
}
const project = () => process.env.FIRENOOK_CONSOLE_PROJECT ?? 'demo-console-e2e'
const documents = () =>
  `${origin()}/console/api/v1/firestore/v1/projects/${project()}/databases/(default)/documents`
const owner = { authorization: 'Bearer owner', 'content-type': 'application/json' }

test('a collection is a typed grid with live counts in the path bar', async ({ page }) => {
  await page.goto(`${origin()}/console/firestore?path=users`)
  const header = page.getByRole('table').locator('thead')
  await expect(header.getByText('displayName')).toBeVisible()
  await expect(header.getByText('lastSeen')).toBeVisible()
  await expect(header.getByText('timestamp', { exact: true }).first()).toBeVisible()
  await expect(page.getByTestId('path-bar')).toContainText('240')
  await expect(page.getByTestId('match-count')).toContainText('240 documents')
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
  await expect(page.getByTestId('requests-drawer')).toContainText('live')
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
  await expect(page.getByText(/live · \d+ change/)).toBeVisible()
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
  const orders = users?.children.find((node) => node.id === 'orders')
  expect(orders?.pattern).toBe('users/*/orders')
  expect(orders?.parents).toBeGreaterThan(0)
  expect(orders?.children.map((node) => node.pattern)).toEqual(['users/*/orders/*/items'])

  await page.goto(`${origin()}/console/firestore?path=users`)
  const rail = page.getByTestId('schema-rail')
  await expect(rail).toBeVisible()
  await expect(
    rail.getByTestId('schema-node').filter({ hasText: 'users' }).first(),
  ).toHaveAttribute('aria-current', 'location')
  // The tree is expanded: the three levels under users are all on screen.
  const items = rail.locator('[data-pattern="users/*/orders/*/items"]')
  await expect(items).toBeVisible()
  await expect(rail.getByTestId('schema-summary')).toContainText('users')
  // The path bar says what lives below users, from the same tree.
  await expect(page.getByTestId('path-below')).toContainText('orders')

  // A nested pattern opens as the collection group, with the full path per row.
  await rail.locator('[data-pattern="users/*/orders"]').getByTestId('schema-node-open').click()
  await expect(page).toHaveURL(/path=users%2F\*%2Forders&group=true/)
  await expect(page.getByTestId('path-bar')).toContainText('*')
  await expect(page.getByTestId('grid-row').first()).toContainText(/users\/[^/]+\/orders\//)
  await expect(rail.getByTestId('schema-summary')).toContainText(`${orders?.documents} documents`)
  await expect(rail.getByTestId('schema-summary')).toContainText(`in ${orders?.parents} of`)
  // Nothing can be created at a pattern.
  await page.getByTestId('new-menu').click()
  await expect(page.getByTestId('new-root-collection')).toBeVisible()
  await expect(page.getByRole('menuitem', { name: /Document in/ })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)

  // Collapsing a node hides its children; the rail hides with t and comes back.
  await rail.locator('[data-pattern="users/*/orders"]').getByTestId('schema-node-toggle').click()
  await expect(items).toHaveCount(0)
  await page.keyboard.press('t')
  await expect(rail).toHaveCount(0)
  await page.getByTestId('schema-rail-toggle').click()
  await expect(page.getByTestId('schema-rail')).toBeVisible()

  // The tree follows the data: a new subcollection appears with its count
  // and goes when its last document goes.
  const note = `projects/${project()}/databases/(default)/documents/users/u_k65eq/notes/n_1`
  const created = await page.request.post(`${documents()}:commit`, {
    headers: owner,
    data: { writes: [{ update: { name: note, fields: { text: { stringValue: 'hello' } } } }] },
  })
  expect(created.ok()).toBeTruthy()
  const notes = page.getByTestId('schema-rail').locator('[data-pattern="users/*/notes"]')
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
  await expect(page.getByRole('button', { name: 'users/u_k65eq/orders' })).toBeVisible()
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
  await page.getByRole('button', { name: 'total type: string' }).click()
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
