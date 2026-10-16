import { expect, test } from './fixtures'
import { ENGINE_REVISION, RELEASE_VERSION } from './engine'

const origin = () => {
  const value = process.env.FIRENOOK_CONSOLE_ORIGIN
  if (!value) throw new Error('the worker engine did not start')
  return value
}
const project = () => process.env.FIRENOOK_CONSOLE_PROJECT ?? 'demo-console-e2e'

test('the overview shows what the engine runs, where, and what it does not', async ({ page }) => {
  await page.goto(`${origin()}/console`)
  await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible()
  await expect(page.getByTestId('overview-project')).toHaveText(project())
  // A card per running section, each with the address an app connects to.
  const firestore = page.getByTestId('overview-card-firestore')
  await expect(firestore.getByTestId('overview-card-firestore-address')).toHaveText(
    /^127\.0\.0\.1:\d+$/,
  )
  await expect(firestore.getByTestId('overview-card-firestore-health')).toHaveText('Running')
  await expect(page.getByTestId('overview-card-auth')).toBeVisible()
  await expect(page.getByTestId('overview-infrastructure')).toContainText('Hub')
  // This profile starts Firestore and Authentication only: Storage says why it is missing.
  await expect(page.getByTestId('overview-absent-storage')).toBeVisible()
  // The release the launcher declared, not the placeholder crate version:
  // the engine is built from a pinned commit and cannot know what it ships
  // as, so a wrong number here means the handoff is broken.
  const badge = page.getByTestId('engine-badge')
  await expect(badge).toHaveText(`engine ${RELEASE_VERSION}`)
  await expect(badge).toHaveAttribute(
    'title',
    `Firenook ${RELEASE_VERSION}, engine source ${ENGINE_REVISION.slice(0, 12)}`,
  )
  await expect(page.getByTestId('overview-engine')).toHaveText(
    `Firenook ${RELEASE_VERSION} (engine ${ENGINE_REVISION.slice(0, 12)})`,
  )
})

test('the theme is light, dark or the system\u2019s, and it is remembered', async ({ browser }) => {
  // A browser whose OS says dark, so "match the system" has something to
  // follow and an explicit choice has something to override.
  const context = await browser.newContext({ colorScheme: 'dark' })
  const page = await context.newPage()
  const mode = () => page.locator('html').getAttribute('data-mode')

  await page.goto(`${origin()}/console`)
  await expect(page.getByTestId('theme-picker')).toHaveAttribute('data-choice', 'system')
  expect(await mode()).toBe('dark')

  // An explicit light choice beats the dark OS.
  await page.getByTestId('theme-light').click()
  await expect(page.locator('html')).toHaveAttribute('data-mode', 'light')
  await expect(page.getByTestId('theme-picker')).toHaveAttribute('data-choice', 'light')

  // And survives a reload rather than snapping back to the OS.
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-mode', 'light')
  await expect(page.getByTestId('theme-picker')).toHaveAttribute('data-choice', 'light')

  // Back to the system, and the dark OS takes over again.
  await page.getByTestId('theme-system').click()
  await expect(page.locator('html')).toHaveAttribute('data-mode', 'dark')

  // The system changing is followed live, with no reload.
  await page.emulateMedia({ colorScheme: 'light' })
  await expect(page.locator('html')).toHaveAttribute('data-mode', 'light')
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(page.locator('html')).toHaveAttribute('data-mode', 'dark')

  // The palette offers the same three and says which is in force.
  await page.keyboard.press('ControlOrMeta+k')
  // The palette's own field: the Overview has a combobox of its own (the host picker).
  await page.getByTestId('palette-input').fill('theme')
  await expect(page.getByRole('option', { name: /Dark theme/ })).toBeVisible()
  await page.getByRole('option', { name: /Light theme/ }).click()
  await expect(page.locator('html')).toHaveAttribute('data-mode', 'light')
  await context.close()
})

test('client routes deep-link through the engine and navigate in place', async ({ page }) => {
  await page.goto(`${origin()}/console/firestore/rules`)
  await expect(page.getByTestId('rules-source')).toBeVisible()
  // Firestore is a heading over its two pages; Data is where its grid is.
  await page.getByTestId('nav-page-data').click()
  await expect(page).toHaveURL(/\/console\/firestore$/)
  // The workbench fills the content column; its heading is for readers.
  await expect(page.getByRole('heading', { name: 'Firestore', level: 1 })).toBeAttached()
  await expect(page.getByTestId('path-bar')).toBeVisible()
  await page.goto(`${origin()}/console/tasks`)
  await expect(page.getByText('not running', { exact: true })).toBeVisible()
})

test('the navigation collapses to icons that peek on hover, and remembers it', async ({ page }) => {
  await page.goto(`${origin()}/console/tasks`)
  const nav = page.locator('aside[data-sidebar="sidebar"]')
  await expect(nav).toHaveAttribute('data-state', 'expanded')
  await expect(page.getByTestId('nav-toggle')).toHaveAttribute('aria-expanded', 'true')

  // Collapsed: icons only, and the choice survives a reload.
  await page.getByTestId('nav-toggle').click()
  await expect(nav).toHaveAttribute('data-state', 'collapsed')
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Cloud Tasks', level: 1 })).toBeVisible()
  await expect(nav).toHaveAttribute('data-state', 'collapsed')

  // Collapsed, the labels slide out over the page while the pointer is on
  // the rail, and go back when it leaves.
  await nav.locator('[data-sidebar="peek-zone"]').hover()
  await expect(nav).toHaveAttribute('data-state', 'peeking')
  await expect(nav.getByRole('link', { name: 'Functions' })).toBeVisible()
  await page.getByRole('heading', { name: 'Cloud Tasks', level: 1 }).hover()
  await expect(nav).toHaveAttribute('data-state', 'collapsed')

  // `[` flips it; ⌘K offers the same.
  await page.keyboard.press('[')
  await expect(nav).toHaveAttribute('data-state', 'expanded')
  await page.keyboard.press('[')
  await expect(nav).toHaveAttribute('data-state', 'collapsed')
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByTestId('palette-input').fill('expand sidebar')
  await page.keyboard.press('Enter')
  await expect(nav).toHaveAttribute('data-state', 'expanded')
})

test('the command palette opens from the keyboard and jumps to a section', async ({ page }) => {
  await page.goto(`${origin()}/console`)
  // The shortcut is a window listener the shell installs after mount.
  await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible()
  await page.keyboard.press('ControlOrMeta+k')
  const input = page.getByTestId('palette-input')
  await expect(input).toBeVisible()
  await input.fill('tasks')
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/console\/tasks$/)
  await expect(page.getByRole('heading', { name: 'Cloud Tasks', level: 1 })).toBeVisible()
})

test('? lists every key the page answers to, from the same registry the keys run through', async ({
  page,
}) => {
  const mod = process.platform === 'darwin' ? '⌘' : 'Ctrl+'
  await page.goto(`${origin()}/console/firestore?path=users`)
  await expect(page.getByTestId('grid-row').first()).toBeVisible()
  // A cell under the cursor, so the keys that act on one are live.
  await page.getByTestId('grid-row').first().locator('td[data-field]').first().click()

  await page.keyboard.press('?')
  const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' })
  await expect(dialog).toBeVisible()
  const everywhere = dialog.getByRole('region', { name: 'Everywhere' })
  await expect(everywhere).toContainText('Search the console')
  await expect(everywhere).toContainText(`${mod}K`)
  await expect(everywhere).toContainText('Hide or show the schema panel')
  await expect(everywhere).toContainText('Keyboard shortcuts')
  const firestore = dialog.getByRole('region', { name: 'This page · Firestore' })
  await expect(firestore).toContainText('Edit the path')
  await expect(firestore).toContainText('Filter the documents')
  await expect(firestore).toContainText('New document')
  // Only what can be pressed now: nothing is ticked, so there is nothing to delete.
  await expect(firestore).not.toContainText('Delete the ticked documents')
  const grid = dialog.getByRole('region', { name: 'Grid' })
  await expect(grid).toContainText('Move between rows')
  await expect(grid.getByRole('listitem').filter({ hasText: 'Move between rows' })).toContainText(
    '↑↓',
  )
  await expect(grid).toContainText('Copy the value')

  // The dialog owns its single keys: `f` behind it does not open the filter.
  await page.keyboard.press('f')
  await expect(page.getByTestId('query-input')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)

  // In a field, `?` is a character.
  await page.keyboard.press('f')
  const input = page.getByTestId('query-input')
  await expect(input).toBeFocused()
  await page.keyboard.press('?')
  await expect(input).toHaveValue('?')
  await expect(dialog).toHaveCount(0)
  await input.fill('')
  await page.keyboard.press('Escape')

  // Ticked rows add the delete keys to the list.
  await page.getByTestId('grid-row').first().getByRole('checkbox').click()
  await page.keyboard.press('?')
  await expect(dialog.getByRole('region', { name: 'This page · Firestore' })).toContainText(
    'Delete the ticked documents',
  )
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)

  // The palette offers it, and the rules page lists its own keys.
  await page.goto(`${origin()}/console/firestore/rules`)
  await expect(page.getByTestId('rules-source')).toBeVisible()
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByTestId('palette-input').fill('keyboard')
  await page.keyboard.press('Enter')
  const rules = dialog.getByRole('region', { name: 'This page · Security rules' })
  await expect(rules).toContainText('Apply the draft')
  await expect(rules).toContainText(`${mod}↵`)
  await expect(rules).toContainText('Save to the rules file')
  await expect(dialog.getByRole('region', { name: 'This page · Firestore' })).toHaveCount(0)
})

test('the shell never caches and hashed assets are immutable', async ({ request }) => {
  const shell = await request.get(`${origin()}/console/firestore`)
  expect(shell.status()).toBe(200)
  expect(shell.headers()['cache-control']).toBe('no-cache')
  const html = await shell.text()
  const script = /src="(\/console\/assets\/[^"]+\.js)"/.exec(html)?.[1]
  expect(script, 'the shell references a hashed script').toBeTruthy()
  const asset = await request.get(`${origin()}${script}`)
  expect(asset.status()).toBe(200)
  expect(asset.headers()['cache-control']).toBe('public, max-age=31536000, immutable')
  const status = await request.get(`${origin()}/console/api/v1/status`)
  expect(status.status()).toBe(200)
  expect((await status.json()).projectId).toBe(project())
})

test('the Google Emulator UI still answers at the root of the same port', async ({ request }) => {
  const legacy = await request.get(`${origin()}/`)
  expect(legacy.status()).toBe(200)
  expect(legacy.headers()['content-type']).toContain('text/html')
})
