import { dedicated, expect, test } from './fixtures'
import { readClipboard, ticked } from './support/clipboard'

// A section the engine does not run says why and how to turn it on, from
// the engine's own status: the `data` profile runs Firestore and Auth only,
// and its engine was started with the launch context the npm CLI passes, so
// Storage is "not configured" and Eventarc "follows Functions".

const origin = () => {
  const value = process.env.FIRENOOK_CONSOLE_ORIGIN
  if (!value) throw new Error('the worker engine did not start')
  return value
}

const STORAGE_SNIPPET = '"emulators": { "storage": {} },\n"storage": { "rules": "storage.rules" }'

test('an absent section says why and hands over the firebase.json lines to add', async ({
  page,
}) => {
  await page.goto(`${origin()}/console/storage`)
  const gate = page.getByTestId('service-not-running')
  await expect(gate).toBeVisible()
  await expect(gate).toHaveAttribute('data-reason', 'not-configured')
  await expect(page.getByRole('heading', { name: 'Storage is not running' })).toBeVisible()
  await expect(gate).toContainText('firebase.json does not configure Storage.')
  await expect(page.getByText('not running', { exact: true })).toBeVisible()

  const fix = page.getByTestId('fix-firebase-json')
  await expect(fix).toContainText('Add it to firebase.json')
  await expect(fix.locator('pre')).toHaveText(STORAGE_SNIPPET)
  const copy = page.getByTestId('fix-firebase-json-copy')
  await copy.click()
  await ticked(copy)
  await expect.poll(() => readClipboard(page)).toBe(STORAGE_SNIPPET)
})

test('the nav dims an absent section and says why on hover', async ({ page }) => {
  await page.goto(`${origin()}/console/firestore`)
  const storage = page.getByTestId('nav-storage')
  await expect(storage).toHaveAttribute('data-state', 'absent')
  await expect(storage).toHaveClass(/text-kumo-inactive/)
  await storage.hover()
  await expect(page.locator('.kumo-tooltip-popup')).toHaveText(
    'Storage is not running — open it to see how to start it',
  )
  // Still a place to go: the gate explains.
  await storage.click()
  await expect(page).toHaveURL(/\/console\/storage$/)
  await expect(page.getByTestId('service-not-running')).toBeVisible()
  // A section that runs is not dimmed.
  await expect(page.getByTestId('nav-auth')).toHaveAttribute('data-state', 'ready')
})

test('a section that follows Functions says so, with Functions’ fix', async ({ page }) => {
  await page.goto(`${origin()}/console/eventarc`)
  const gate = page.getByTestId('service-not-running')
  await expect(gate).toHaveAttribute('data-reason', 'requires')
  await expect(gate).toContainText('Eventarc runs with Functions, which this engine does not run.')
  await expect(page.getByTestId('fix-firebase-json').locator('pre')).toHaveText(
    '"functions": [{ "source": "functions" }]',
  )
})

dedicated(
  'a running section that is not built yet keeps its honest placeholder',
  async ({ page, dedicatedEngine }) => {
    // Firestore and Auth, all the data profile runs, are built: the auth
    // profile also runs Functions, which is not.
    const engine = await dedicatedEngine('auth', { seed: false })
    await page.goto(`${engine.origin}/console/functions`)
    await expect(page.getByRole('heading', { name: 'Functions' })).toBeVisible()
    await expect(page.getByText('This section is not built yet')).toBeVisible()
    await expect(page.getByText('running', { exact: true })).toBeVisible()
    await expect(page.getByTestId('service-not-running')).toHaveCount(0)
  },
)

dedicated(
  'an engine started without a launch context says only what it knows',
  async ({ page, dedicatedEngine }) => {
    const engine = await dedicatedEngine('data', { launchContext: false, seed: false })
    await page.goto(`${engine.origin}/console/storage`)
    const gate = page.getByTestId('service-not-running')
    await expect(gate).toHaveAttribute('data-reason', 'unknown')
    await expect(gate).toContainText('This engine was started without Storage.')
    await expect(page.getByTestId('section-fixes')).toHaveCount(0)
  },
)
