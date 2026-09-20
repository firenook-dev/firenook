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
  await expect(page.getByRole('heading', { name: 'Firestore', level: 1 })).toBeVisible()
  await page.goto(`${origin()}/console/tasks`)
  await expect(page.getByText('not running', { exact: true })).toBeVisible()
})

test('the command palette opens from the keyboard and jumps to a section', async ({ page }) => {
  await page.goto(`${origin()}/console`)
  await page.keyboard.press('ControlOrMeta+k')
  const input = page.getByPlaceholder('Jump to a section…')
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
