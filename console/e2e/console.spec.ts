import { expect, test } from '@playwright/test'

const origin = () => {
  const value = process.env.FIRENOOK_CONSOLE_ORIGIN
  if (!value) throw new Error('the engine global setup did not run')
  return value
}
const project = () => process.env.FIRENOOK_CONSOLE_PROJECT ?? 'demo-console-e2e'

test('the overview lists the running services from the engine', async ({ page }) => {
  await page.goto(`${origin()}/console`)
  await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible()
  await expect(page.getByText(project()).first()).toBeVisible()
  const table = page.getByRole('table')
  await expect(table.getByText('Firestore', { exact: true })).toBeVisible()
  await expect(table.getByText('Authentication', { exact: true })).toBeVisible()
  await expect(table.getByText('Emulator hub', { exact: true })).toBeVisible()
  await expect(page.getByText(/engine \d+\.\d+\.\d+/)).toBeVisible()
})

test('client routes deep-link through the engine and navigate in place', async ({ page }) => {
  await page.goto(`${origin()}/console/auth`)
  await expect(page.getByRole('heading', { name: 'Authentication', level: 1 })).toBeVisible()
  await expect(page.getByText('running', { exact: true })).toBeVisible()
  await page.getByRole('link', { name: 'Firestore' }).click()
  await expect(page).toHaveURL(/\/console\/firestore$/)
  // The workbench fills the content column; its heading is for readers.
  await expect(page.getByRole('heading', { name: 'Firestore', level: 1 })).toBeAttached()
  await expect(page.getByTestId('path-bar')).toBeVisible()
  await page.goto(`${origin()}/console/tasks`)
  await expect(page.getByText('not running', { exact: true })).toBeVisible()
})

test('the navigation collapses to icons that peek on hover, and remembers it', async ({ page }) => {
  await page.goto(`${origin()}/console/auth`)
  const nav = page.locator('aside[data-sidebar="sidebar"]')
  await expect(nav).toHaveAttribute('data-state', 'expanded')
  await expect(page.getByTestId('nav-toggle')).toHaveAttribute('aria-expanded', 'true')

  // Collapsed: icons only, and the choice survives a reload.
  await page.getByTestId('nav-toggle').click()
  await expect(nav).toHaveAttribute('data-state', 'collapsed')
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Authentication', level: 1 })).toBeVisible()
  await expect(nav).toHaveAttribute('data-state', 'collapsed')

  // Collapsed, the labels slide out over the page while the pointer is on
  // the rail, and go back when it leaves.
  await nav.locator('[data-sidebar="peek-zone"]').hover()
  await expect(nav).toHaveAttribute('data-state', 'peeking')
  await expect(nav.getByRole('link', { name: 'Functions' })).toBeVisible()
  await page.getByRole('heading', { name: 'Authentication', level: 1 }).hover()
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
