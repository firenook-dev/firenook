import type { Locator } from '@playwright/test'
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
  // The project is the top bar's, on every page; the header says the suite in one line.
  await expect(page.getByTestId('top-bar-project')).toHaveText(project())
  await expect(page.getByTestId('overview-health')).toContainText('running')
  // A tile per section, each with the port an app connects to on the shared host.
  const firestore = page.getByTestId('overview-card-firestore')
  await expect(firestore.getByTestId('overview-card-firestore-address')).toHaveText(/^:\d+$/)
  await expect(page.getByTestId('overview-host-shared')).toContainText('127.0.0.1')
  await expect(firestore.getByTestId('overview-card-firestore-health')).toHaveText('Running')
  await expect(page.getByTestId('overview-card-auth')).toBeVisible()
  // This profile starts Firestore and Authentication only: Storage keeps its place and says why.
  const storage = page.getByTestId('overview-card-storage')
  await expect(storage).toHaveAttribute('data-state', 'absent')
  await expect(page.getByTestId('overview-card-storage-health')).toHaveText('Not running')
  // The release the launcher declared, not the placeholder crate version:
  // the engine is built from a pinned commit and cannot know what it ships
  // as, so a wrong number here means the handoff is broken.
  // It is written small at the navigation's foot, in full in its tooltip.
  const build = `Firenook ${RELEASE_VERSION}, engine source ${ENGINE_REVISION.slice(0, 12)}`
  await expect(page.getByTestId('top-bar')).toHaveAttribute('data-live', 'live')
  const version = page.getByTestId('nav-version')
  await expect(version).toHaveText(`v${RELEASE_VERSION}`)
  await version.hover()
  await expect(page.getByTestId('nav-version-build')).toHaveText(build)
  await expect(page.getByTestId('engine-version')).toHaveText(
    `${RELEASE_VERSION}·${ENGINE_REVISION.slice(0, 12)}`,
  )
  // The hub and the other ports no section owns are on the engine card, under "Show all".
  await page.getByTestId('overview-engine-all').click()
  await expect(page.getByTestId('overview-infrastructure')).toContainText('Hub')
})

test('the top bar: Connect over the page on screen, and help', async ({ page }) => {
  await page.goto(`${origin()}/console/firestore`)
  await page.getByTestId('top-bar-connect').click()
  const connect = page.getByRole('dialog', { name: 'Connect your app' })
  await expect(connect).toBeVisible()
  await expect(page).toHaveURL(/\/console\/firestore\?connect=web$/)
  await page.keyboard.press('Escape')
  await expect(connect).toHaveCount(0)
  await expect(page).toHaveURL(/\/console\/firestore$/)

  // Help: the shortcuts, and the ways out, an issue already naming this engine.
  await page.getByTestId('top-bar-help').click()
  const repository = 'https://github.com/firenook-dev/firenook'
  await expect(page.getByTestId('help-docs')).toHaveAttribute('href', `${repository}#readme`)
  await expect(page.getByTestId('help-docs')).toHaveAttribute('target', '_blank')
  // An unpublished build has no release page of its own: the list.
  await expect(page.getByTestId('help-releases')).toHaveAttribute('href', `${repository}/releases`)
  const issue = new URL((await page.getByTestId('help-issue').getAttribute('href')) ?? '')
  expect(`${issue.origin}${issue.pathname}`).toBe(`${repository}/issues/new`)
  expect(issue.searchParams.get('body')).toContain(
    `Firenook ${RELEASE_VERSION}, engine source ${ENGINE_REVISION.slice(0, 12)}`,
  )
  await page.getByTestId('help-shortcuts').click()
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible()
})

test('a press on Help while its menu is still loading opens the menu when it arrives', async ({ page }) => {
  // The menu's code is held back, as on a slow first load.
  await page.route(/help-menu-[^/]+\.js$/, async (route) => {
    await new Promise((done) => setTimeout(done, 1500))
    await route.continue()
  })
  await page.goto(`${origin()}/console/firestore`)
  await page.getByTestId('top-bar-help').click()
  await expect(page.getByTestId('help-docs')).toBeVisible({ timeout: 8000 })
})

test('the tab carries Firenook’s icon, and the console installs as an app', async ({ page }) => {
  await page.goto(`${origin()}/console/firestore`)
  // Links under the console's base path, from any page however deep.
  const icons = await page
    .locator('link[rel="icon"], link[rel="apple-touch-icon"], link[rel="manifest"]')
    .evaluateAll((links) => links.map((link) => (link as unknown as { href: string }).href))
  expect(icons.length).toBe(4)
  for (const href of icons) {
    const response = await page.request.get(href)
    expect(response.status(), href).toBe(200)
    expect(response.headers()['content-type'], href).not.toContain('text/html')
  }
  const manifest = (await (
    await page.request.get(`${origin()}/console/site.webmanifest`)
  ).json()) as { start_url: string; icons: { src: string }[] }
  for (const icon of manifest.icons)
    expect((await page.request.get(new URL(icon.src, `${origin()}/console/`).href)).status()).toBe(
      200,
    )
  await expect(page.getByTestId('firenook-logo')).toBeVisible()
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

/** Where an element is drawn, and its middle across. */
async function box(locator: Locator) {
  const rect = await locator.boundingBox()
  if (!rect) throw new Error('not on the page')
  return { ...rect, centre: rect.x + rect.width / 2 }
}

test('the navigation collapses to icons that peek on hover, and remembers it', async ({ page }) => {
  await page.goto(`${origin()}/console/tasks`)
  const nav = page.locator('aside[data-sidebar="sidebar"]')
  await expect(nav).toHaveAttribute('data-state', 'expanded')
  await expect(page.getByTestId('nav-toggle')).toHaveAttribute('aria-expanded', 'true')

  // Collapsed: icons only, and the choice survives a reload.
  await page.getByTestId('nav-toggle').click()
  await expect(nav).toHaveAttribute('data-state', 'collapsed')

  // The rail is one square button wide, each icon in the middle of its
  // button, and the brand's mark over that column. Kumo draws the rail for
  // a 16 px root; at the console's 14 px its buttons were 34 by 30 with the
  // icon 2.5 px left of centre (`NAV_WIDTH`).
  await page.mouse.move(900, 400)
  await expect
    .poll(() => nav.evaluate((element) => element.getBoundingClientRect().width))
    .toBeLessThan(56)
  const functions = page.getByTestId('nav-functions')
  const geometry = {
    button: await box(functions),
    icon: await box(functions.locator('svg').first()),
    toggle: await box(page.getByTestId('nav-toggle')),
    mark: await box(page.getByTestId('top-bar-home').locator('svg > g').first()),
  }
  expect(Math.abs(geometry.button.width - geometry.button.height)).toBeLessThan(1)
  expect(Math.abs(geometry.icon.centre - geometry.button.centre)).toBeLessThan(1)
  expect(Math.abs(geometry.toggle.centre - geometry.button.centre)).toBeLessThan(1)
  expect(Math.abs(geometry.mark.centre - geometry.button.centre)).toBeLessThan(1)
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

test('the root of the port, and the Google Emulator UI’s old addresses, lead to the console', async ({
  request,
}) => {
  // The Google UI was served at the root until 0.2.0-next.3: its links and
  // bookmarks land on the console's page for the same thing.
  const query = `q=${encodeURIComponent('metadata.function.name="us-central1-hello"')}`
  for (const [from, to] of [
    ['/', '/console'],
    ['/firestore/default/data/users/u_k65eq', '/console/firestore'],
    ['/firestore/default/requests', '/console/firestore/rules'],
    ['/auth', '/console/auth'],
    ['/storage/demo-console-e2e.appspot.com', '/console/storage'],
    [`/logs?${query}`, `/console/logs?${query}`],
    ['/database/demo-console-e2e/data', '/console'],
  ]) {
    const response = await request.get(`${origin()}${from}`, { maxRedirects: 0 })
    expect(response.status(), from).toBe(307)
    expect(response.headers().location, from).toBe(to)
  }
  const page = await request.get(`${origin()}/`)
  expect(page.status()).toBe(200)
  expect(await page.text()).toContain('<title>Firenook console</title>')
  // What tools read about the suite stays where they read it.
  const config = await request.get(`${origin()}/api/config`)
  expect(config.status()).toBe(200)
  expect((await config.json()).projectId).toBe(project())
  // Nothing is written at an old address.
  expect((await request.post(`${origin()}/auth`)).status()).toBe(404)
})
