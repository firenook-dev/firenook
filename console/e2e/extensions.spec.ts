import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { type Engine, expect, test } from './fixtures'
import { ownerFetch } from './support/api'
import { callFunction, loadsOf as codebaseLoads } from './support/compute'

// The Extensions section's journeys (compute spec §9.3, 28–33) against the
// `compute` profile's engine: the local `greeter` extension the fixture
// installs (`scripts/fixtures/extensions/greeter/`), its parameter file
// `extensions/greeter.env` and its secret in `extensions/greeter.secret.local`.
// Every journey that changes a file puts it back in `finally`. Never a
// mocked API.

const ENV_FILE = 'extensions/greeter.env'

/** The greeter's parameter file in the engine's project. */
const envPath = (engine: Engine) => join(engine.directory, ENV_FILE)

/** How many completed loads the runtime counts for the greeter instance. */
const loadsOf = (engine: Engine) => codebaseLoads(engine, 'greeter')

/** Calls the greeter's HTTP function as an app would, and reads its greeting. */
async function greet(engine: Engine, name: string): Promise<string> {
  const answer = await callFunction(
    engine,
    'ext-greeter-greet',
    `?name=${encodeURIComponent(name)}`,
  )
  expect(answer.status).toBe(200)
  return answer.json<{ greeting: string }>().greeting
}

/** Writes the parameter file back as it was, and waits for the instance to read it again. */
async function restore(engine: Engine, original: string) {
  if (readFileSync(envPath(engine), 'utf8') === original) return
  writeFileSync(envPath(engine), original)
  await expect.poll(() => greet(engine, 'Ada'), { timeout: 15_000 }).toBe('Hello, Ada!')
}

const openInstance = (page: Page, engine: Engine, view = '') =>
  page.goto(`${engine.origin}/console/extensions?instance=greeter${view ? `&view=${view}` : ''}`)

test('the overview lists each instance with its source, readiness, APIs, roles and hooks', async ({
  page,
  engine,
}) => {
  await page.goto(`${engine.origin}/console/extensions`)
  const row = page.getByTestId('instances-table').locator('tbody tr').filter({ hasText: 'greeter' })
  await expect(row).toBeVisible()
  await expect(row).toContainText('local')
  await expect(row).toContainText('Offline-ready')
  await expect(row).toContainText('3 · 1 not emulated')
  await expect(row).toContainText('translate.googleapis.com')

  // The panel's row opens it; the toolbar says what it is and where it lives.
  await page.getByTestId('instance-row').filter({ hasText: 'greeter' }).click()
  await expect(page).toHaveURL(/instance=greeter/)
  await expect(page.getByTestId('instance-id')).toHaveText('greeter')
  await expect(page.getByTestId('instance-identity')).toContainText('extensions/greeter')
  await expect(page.getByTestId('instance-readiness')).toContainText('Offline-ready')

  const overview = page.getByTestId('instance-overview')
  const translate = overview.locator('[data-api="translate.googleapis.com"]')
  await expect(translate).toContainText('Not emulated')
  await expect(translate).toContainText('Calls go to the production API')
  await expect(overview.locator('[data-api="firestore.googleapis.com"]')).toContainText('Emulated')
  await expect(page.getByTestId('overview-role')).toContainText('datastore.user')
  await expect(page.getByTestId('lifecycle-hook')).toContainText('onInstall')
  await expect(page.getByTestId('lifecycle-hook')).toContainText('backfill')
  await expect(page.getByTestId('lifecycle-hook')).toContainText('Not run by the emulator')
  await expect(page.getByTestId('source-files')).toContainText(ENV_FILE)
  await expect(page.getByTestId('source-files')).toContainText('extensions/greeter.secret.local')

  // Functions: the task-queue resource says why it receives nothing, and the
  // HTTP one links to its function.
  await page.getByTestId('instance-tab-functions').click()
  await expect(page).toHaveURL(/view=functions/)
  const backfill = page.locator('[data-testid="extension-function"][data-resource="backfill"]')
  await expect(backfill).toHaveAttribute('data-status', 'ignored')
  await expect(backfill.getByTestId('kind-badge')).toHaveText('tasks')
  await expect(backfill.getByTestId('extension-function-reason')).toContainText(
    'Task queue functions of an extension are not delivered by the emulator',
  )
  const greetRow = page.locator('[data-testid="extension-function"][data-resource="greet"]')
  await expect(greetRow).toHaveAttribute('data-status', 'receiving')
  const link = greetRow.getByTestId('extension-function-link')
  await expect(link).toContainText('us-central1-ext-greeter-greet')
  await link.getByTestId('extension-function-link-link').click()
  await expect(page).toHaveURL(/\/functions\?function=us-central1-ext-greeter-greet/)
})

test('the configuration says where each value comes from, and reveals a secret on request', async ({
  page,
  engine,
}) => {
  const detail = ownerFetch(engine, '/extensions/instances/greeter').then((response) =>
    response.text(),
  )
  // The detail never carries a secret's value.
  expect(await detail).not.toContain('tok-123')
  await openInstance(page, engine, 'configuration')
  const template = page.locator('[data-testid="param-row"][data-param="GREETING_TEMPLATE"]')
  await expect(template.getByTestId('param-value')).toHaveText('Hello, {name}!')
  await expect(template.getByTestId('param-source')).toHaveText('greeter.env')
  const mode = page.locator('[data-testid="param-row"][data-param="MODE"]')
  await expect(mode.getByTestId('param-source')).toHaveText('default')
  await expect(mode.getByTestId('param-value')).toContainText('fast')
  const location = page.locator('[data-testid="param-row"][data-param="LOCATION"]')
  await expect(location.getByTestId('param-immutable')).toBeVisible()
  await expect(location.getByTestId('param-value')).toContainText('Iowa (us-central1)')

  const token = page.locator('[data-testid="param-row"][data-param="API_TOKEN"]')
  await expect(token.getByTestId('param-source')).toHaveText('greeter.secret.local')
  await expect(token.getByTestId('param-secret-masked')).toBeVisible()
  await expect(page.getByText('tok-123')).toHaveCount(0)
  await token.getByTestId('param-secret-reveal').click()
  await expect(token.getByTestId('param-secret-value')).toHaveText('tok-123')

  // The description is the author's markdown, folded until asked for.
  await template.getByTestId('param-about').click()
  await expect(template.getByTestId('param-description').locator('strong')).toHaveText('{name}')

  // A value the pattern refuses is said as it is typed, and Save waits.
  await page.getByTestId('configuration-edit').click()
  await expect(page).toHaveURL(/edit=true/)
  await template.getByTestId('param-input').fill('Hello there')
  await expect(template.getByTestId('param-problem')).toHaveText(
    'The template must contain {name}.',
  )
  await expect(page.getByTestId('configuration-save')).toBeDisabled()
  await page.getByTestId('configuration-cancel').click()
  await expect(page).not.toHaveURL(/edit=true/)
  await expect(template.getByTestId('param-value')).toHaveText('Hello, {name}!')
})

test('reconfigure writes the file that set the value, keeps its comment and reloads once', async ({
  page,
  engine,
}) => {
  const original = readFileSync(envPath(engine), 'utf8')
  try {
    await openInstance(page, engine, 'configuration')
    const before = await loadsOf(engine)
    await page.getByTestId('configuration-edit').click()
    const template = page.locator('[data-testid="param-row"][data-param="GREETING_TEMPLATE"]')
    await template.getByTestId('param-input').fill('Hi, {name}')
    await expect(template.getByTestId('param-changed')).toBeVisible()
    await expect(page.getByTestId('configuration-footer')).toContainText('written to greeter.env')
    await page.keyboard.press('ControlOrMeta+s')
    const dialog = page.getByTestId('env-change-dialog')
    await expect(dialog).toBeVisible()
    const file = dialog.locator(`[data-testid="env-change-dialog-file"][data-file="${ENV_FILE}"]`)
    await expect(file).toBeVisible()
    await expect(file.locator('[data-key="GREETING_TEMPLATE"]')).toContainText('Hello, {name}!')
    await expect(file.locator('[data-key="GREETING_TEMPLATE"] [data-part="after"]')).toHaveText(
      'Hi, {name}',
    )
    await expect(dialog).toContainText('The instance reloads')
    await page.getByTestId('env-change-dialog-confirm').click()
    await expect(dialog).toBeHidden()
    await expect(page.getByText(`Wrote ${ENV_FILE}.`)).toBeVisible()
    await expect(template.getByTestId('param-value')).toHaveText('Hi, {name}')
    await expect(page).not.toHaveURL(/edit=true/)

    // One reload for the save: the watcher sees the console's own write and lets it be.
    await expect.poll(() => loadsOf(engine)).toBe(before + 1)
    const written = readFileSync(envPath(engine), 'utf8')
    expect(written).toContain(
      '# Parameters of the greeter instance. A comment kept by reconfigure.',
    )
    expect(written).toMatch(/^GREETING_TEMPLATE=.*Hi, \{name\}.*$/m)
    expect(await greet(engine, 'Ada')).toBe('Hi, Ada')
    // An edit made after it reaches the watcher behind the console's write,
    // in order: once it has loaded, the count says the save cost one load.
    writeFileSync(envPath(engine), written.replace('Hi, {name}', 'Hey, {name}'))
    await expect.poll(() => greet(engine, 'Ada'), { timeout: 15_000 }).toBe('Hey, Ada')
    expect(await loadsOf(engine)).toBe(before + 2)
  } finally {
    await restore(engine, original)
  }
})

test('a configuration that does not load never stays on disk', async ({ page, engine }) => {
  const original = readFileSync(envPath(engine), 'utf8')
  try {
    // The engine checks what the console checks: values outside a select's
    // options or a pattern are refused with every problem at once.
    const refused = await ownerFetch(engine, '/extensions/instances/greeter/reconfigure', {
      method: 'POST',
      body: JSON.stringify({ values: { LOCATION: 'mars-central1' }, secrets: {} }),
    })
    expect(refused.status).toBe(400)
    const body = (await refused.json()) as { problems: { param: string; message: string }[] }
    expect(body.problems).toEqual([
      { param: 'LOCATION', message: 'Choose one of: us-central1, europe-west1.' },
    ])

    // A value the pattern accepts but the spec cannot take (a quote, which the
    // POSTINSTALL notes put into the spec) fails the load: the files go back.
    await openInstance(page, engine, 'configuration')
    const before = await loadsOf(engine)
    await page.getByTestId('configuration-edit').click()
    const template = page.locator('[data-testid="param-row"][data-param="GREETING_TEMPLATE"]')
    await template.getByTestId('param-input').fill('Hi "{name}"')
    await page.getByTestId('configuration-save').click()
    await page.getByTestId('env-change-dialog-confirm').click()
    const error = page.getByTestId('env-change-dialog-error')
    await expect(error).toContainText(
      'greeter did not load with these values, so your files were put back.',
    )
    await expect(error).toContainText('parameter substitution produced invalid JSON')
    expect(readFileSync(envPath(engine), 'utf8')).toBe(original)
    expect(await loadsOf(engine)).toBe(before)
    expect(await greet(engine, 'Ada')).toBe('Hello, Ada!')
    await page.getByTestId('env-change-dialog-cancel').click()
    // Still editing, with the value that did not load, so it can be fixed.
    await expect(template.getByTestId('param-input')).toHaveValue('Hi "{name}"')
  } finally {
    await restore(engine, original)
  }
})

test('editing the parameter file on disk reloads the instance and the page follows', async ({
  page,
  engine,
}) => {
  const original = readFileSync(envPath(engine), 'utf8')
  try {
    await openInstance(page, engine, 'configuration')
    const template = page.locator('[data-testid="param-row"][data-param="GREETING_TEMPLATE"]')
    await expect(template.getByTestId('param-value')).toHaveText('Hello, {name}!')
    const before = await loadsOf(engine)
    writeFileSync(envPath(engine), original.replace('Hello, {name}!', 'Howdy, {name}'))
    await expect.poll(() => loadsOf(engine), { timeout: 15_000 }).toBeGreaterThan(before)
    expect(await greet(engine, 'Ada')).toBe('Howdy, Ada')
    // The page heard it on `extensions.changes`: no reload of the page.
    await expect(template.getByTestId('param-value')).toHaveText('Howdy, {name}')
  } finally {
    await restore(engine, original)
  }
})

test('how it works renders the notes safely and keeps console links in the app', async ({
  page,
  engine,
}) => {
  let loads = 0
  page.on('load', () => {
    loads += 1
  })
  await openInstance(page, engine, 'readme')
  const notes = page.getByTestId('readme-postinstall')
  await expect(notes).toHaveAttribute('data-rendered', '')
  await expect(notes.locator('h1')).toHaveText('Using the greeter')
  await expect(notes.locator('pre code')).toContainText('ext-greeter-greet?name=Ada')
  // This instance's values are filled in, as after an install.
  await expect(notes).toContainText('Every visitor now reads: Hello, {name}!')
  // Nothing an author writes runs: no scripts, no handlers, no styles. (The
  // fixture's notes hold a script and an onclick to be sure of it.)
  await expect(notes.getByText('Thanks for installing the greeter.')).toBeVisible()
  await notes.getByText('Thanks for installing the greeter.').click()
  expect(
    await page.evaluate(() => (globalThis as { greeterNotes?: string }).greeterNotes),
  ).toBeUndefined()
  expect(await notes.locator('script, style, iframe, form').count()).toBe(0)
  expect(
    await notes.evaluate((root) =>
      [...root.querySelectorAll('*')].some((element) =>
        [...element.attributes].some((attribute) => attribute.name.startsWith('on')),
      ),
    ),
  ).toBe(false)
  // Another site opens in its own tab; the Firebase console's link is the console's own page.
  const external = notes.getByRole('link', { name: "the greeter's page" })
  await expect(external).toHaveAttribute('target', '_blank')
  await expect(external).toHaveAttribute('rel', 'noopener noreferrer')
  const firestore = notes.getByRole('link', { name: 'Firestore' })
  await expect(firestore).toHaveAttribute('href', '/console/firestore')
  await firestore.click()
  await expect(page).toHaveURL(/\/console\/firestore/)
  expect(loads).toBe(1)
})
