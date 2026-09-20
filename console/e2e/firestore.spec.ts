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
  await page
    .getByTestId('new-document-json')
    .fill('{"name": "Journey", "seats": 2, "tags": ["e2e"]}')
  await page.getByRole('dialog').getByRole('button', { name: 'Add document' }).click()
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

test('the path bar completes collections and shows missing ancestors', async ({ page }) => {
  await page.goto(`${origin()}/console/firestore`)
  await expect(page.getByRole('button', { name: /^users/ })).toBeVisible()
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
