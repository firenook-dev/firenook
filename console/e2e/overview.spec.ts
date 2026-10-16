import { join } from 'node:path'
import { expect, test } from './fixtures'
import { readClipboard } from './support/clipboard'
import { statusOf } from './support/shell'
import {
  ADA,
  callFunction,
  cursorOf,
  lineOf,
  logRow,
  runWithAdminSdk,
  writeOnPort,
} from './support/observe'

// The Overview against the worker's engine (project `observe`: every
// service, seeded by every stream's seeder): what runs and where, the
// figures each section keeps current, the recent problems, the code to
// connect an app and the engine's own configuration. The journeys that
// snapshot, reset, restart or start engines of other shapes are in
// `overview-engines.spec.ts`, each with an engine of its own.

interface StatusSection {
  id: string
  state: string
  summary: { headline: string; figures: { label: string; value: number | null }[] } | null
}

async function sections(origin: string): Promise<StatusSection[]> {
  const status = (await (await fetch(`${origin}/console/api/v1/status`)).json()) as {
    sections: StatusSection[]
  }
  return status.sections
}

const figureId = (section: string, label: string) =>
  `overview-figure-${section}-${label.toLowerCase().replaceAll(' ', '-')}`

test('a card per running section: its address, its figures, its health', async ({
  page,
  engine,
}) => {
  await page.goto(`${engine.origin}/console`)
  const status = await statusOf(engine)
  const port = (name: string) => status.services.find((service) => service.name === name)?.port
  for (const section of await sections(engine.origin)) {
    if (section.state !== 'ready') continue
    const card = page.getByTestId(`overview-card-${section.id}`)
    await expect(card).toBeVisible()
    await expect(page.getByTestId(`overview-card-${section.id}-health`)).toHaveText('Running')
    await expect(page.getByTestId(`overview-card-${section.id}-address`)).toHaveText(
      /^127\.0\.0\.1:\d+$/,
    )
  }

  // An address copies as an app writes it.
  const address = page.getByTestId('overview-card-firestore-address')
  await expect(address).toHaveText(`127.0.0.1:${port('firestore')}`)
  await address.click()
  await expect.poll(() => readClipboard(page)).toBe(`127.0.0.1:${port('firestore')}`)

  // Firestore's figures are its summary: the seeded documents and databases.
  const all = await sections(engine.origin)
  const firestore = all.find((section) => section.id === 'firestore')
  const documents = firestore?.summary?.figures.find((figure) => figure.label === 'Documents')
  expect(documents?.value).toBeGreaterThan(1_000)
  await expect(page.getByTestId(figureId('firestore', 'Documents'))).toHaveText(
    new Intl.NumberFormat('en-US').format(documents?.value ?? 0),
  )
  await expect(page.getByTestId(figureId('firestore', 'Databases'))).toHaveText('1')

  // Logs counts its lines and its errors.
  const logs = page.getByTestId('overview-card-logs-figures')
  await expect(logs).toContainText('Lines kept')
  await expect(logs).toContainText('Errors since start')

  // Every running section counts what it holds: its card has figures, and no
  // "holds" line stands in for them (a section without a summary still
  // draws that line; the Overview's unit tests cover it).
  for (const section of all.filter((entry) => entry.state === 'ready')) {
    expect(section.summary, `${section.id} gives a summary`).not.toBeNull()
    await expect(page.getByTestId(`overview-card-${section.id}-figures`)).toBeVisible()
    await expect(page.getByTestId(`overview-card-${section.id}-holds`)).toHaveCount(0)
  }
})

test('a figure follows the writes, and flashes once however many there are', async ({
  page,
  engine,
}) => {
  await page.goto(`${engine.origin}/console`)
  const figure = page.getByTestId(figureId('firestore', 'Documents'))
  await expect(figure).toHaveText(/^[\d,]+$/)
  const count = async () => Number((await figure.innerText()).replaceAll(',', ''))
  const before = await count()
  await expect(figure).toHaveAttribute('data-flashes', '0')

  await writeOnPort(engine, `carts/overview_${Date.now()}`, { total: { integerValue: '1' } })
  await expect.poll(count, { timeout: 2_000 }).toBe(before + 1)
  await expect(figure).toHaveAttribute('data-flashes', '1')

  // Twenty writes over two seconds: the figure keeps up, the flash does not repeat.
  for (let index = 0; index < 20; index += 1) {
    await writeOnPort(engine, `carts/overview_${Date.now()}_${index}`, {
      total: { integerValue: String(index) },
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  await expect.poll(count, { timeout: 2_000 }).toBe(before + 21)
  expect(Number(await figure.getAttribute('data-flashes'))).toBeLessThanOrEqual(2)
})

test('recent problems: a failure lands on the page, and opens in Logs', async ({
  page,
  engine,
}) => {
  await page.goto(`${engine.origin}/console`)
  const problems = page.getByTestId('overview-problems')
  await expect(problems).toBeVisible()
  // A call that times out: the engine's own error line about it, found by
  // the line it opens (the worker's engine holds earlier ones like it).
  const timedOut = '"Your function timed out after ~1s."'
  const earlier = await cursorOf(engine, timedOut)
  const call = await callFunction(engine, 'stalls')
  expect(call.status).toBe(500)
  const line = await lineOf(engine, timedOut, earlier ? { after: earlier } : {})
  const row = page
    .getByTestId('overview-problem')
    .filter({ has: page.locator(`a[href$="entry=${line.cursor}"]`) })
  await expect(row).toBeVisible()
  await expect(row).toContainText('Your function timed out after ~1s.')
  await expect(row).toHaveAttribute('data-level', 'error')
  // Its source is the function, by its short name.
  await expect(row).toContainText('stalls')

  // It opens in Logs: that line, centred, in the inspector, the feed paused around it.
  await row.getByTestId('overview-problem-open').click()
  await expect(page).toHaveURL(
    new RegExp(`/console/logs\\?.*entry=${line.cursor.replace('.', '\\.')}`),
  )
  await expect(page.getByTestId('log-inspector-title')).toContainText(
    'Your function timed out after ~1s.',
  )
  const opened = page.locator(`[data-testid="feed-row"]:has([data-cursor="${line.cursor}"])`)
  await expect(opened).toBeInViewport()
  await expect(opened).toHaveAttribute('aria-selected', 'true')

  // A handler's own error, by its message.
  await page.goto(`${engine.origin}/console`)
  const failing = 'level:error "cannot read"'
  const before = await cursorOf(engine, failing)
  await callFunction(engine, 'fails')
  const failure = await lineOf(engine, failing, before ? { after: before } : {})
  const thrown = page
    .getByTestId('overview-problem')
    .filter({ has: page.locator(`a[href$="entry=${failure.cursor}"]`) })
  await expect(thrown).toBeVisible()
  await expect(thrown).toContainText("TypeError: cannot read 'id' of undefined")
  await expect(thrown).toContainText('fails')
  // "Open logs" is every problem.
  await page.goto(`${engine.origin}/console`)
  await page.getByTestId('overview-open-logs').click()
  await expect(page).toHaveURL(/\/console\/logs\?q=is%3Aproblem/)
  await expect(logRow(page, 'Your function timed out after ~1s.').first()).toBeVisible()
})

test('connect: a snippet per platform, with the host the app sees', async ({ page, engine }) => {
  const status = await statusOf(engine)
  const port = (name: string) => status.services.find((service) => service.name === name)?.port
  await page.goto(`${engine.origin}/console`)
  const snippet = page.getByTestId('overview-connect-snippet')

  await page.getByTestId('overview-connect-tabs').getByRole('tab', { name: 'Flutter' }).click()
  await expect.poll(() => new URL(page.url()).searchParams.get('connect')).toBe('flutter')
  await expect(snippet).toContainText(
    `FirebaseFirestore.instance.useFirestoreEmulator('127.0.0.1', ${port('firestore')})`,
  )
  // A demo project needs no registered app: the options are in the snippet.
  await expect(snippet).toContainText(
    'await Firebase.initializeApp(options: const FirebaseOptions(',
  )
  await expect(snippet).toContainText(`projectId: '${engine.project}'`)

  // The Android emulator reaches this machine at 10.0.2.2.
  await page.getByTestId('overview-host').getByRole('combobox').click()
  await page.getByRole('option', { name: /10\.0\.2\.2/ }).click()
  await expect(snippet).toContainText(`useFirestoreEmulator('10.0.2.2', ${port('firestore')})`)
  // An Android app says what the emulator's network needs.
  await page.getByTestId('overview-connect-tabs').getByRole('tab', { name: 'Android' }).click()
  await expect(snippet).toContainText(
    `Firebase.firestore.useEmulator("10.0.2.2", ${port('firestore')})`,
  )
  await expect(snippet).toContainText(
    '// The Android emulator reaches this machine at 10.0.2.2; allow cleartext traffic',
  )
  await page.getByTestId('overview-host').getByRole('combobox').click()
  await page.getByRole('option', { name: /This machine/ }).click()

  // The environment block copies as lines a shell or a .env reads.
  await page
    .getByTestId('overview-connect-tabs')
    .getByRole('tab', { name: 'Environment variables' })
    .click()
  await expect.poll(() => new URL(page.url()).searchParams.get('connect')).toBe('env')
  await page.getByTestId('overview-connect-snippet-copy').click()
  const copied = await readClipboard(page)
  expect(copied).toBe((await snippet.locator('pre, code').first().innerText()).trimEnd())
  const lines = copied.split('\n')
  expect(lines).toContainEqual(
    expect.stringMatching(
      new RegExp(`^FIRESTORE_EMULATOR_HOST=127\\.0\\.0\\.1:${port('firestore')}\\s+# `),
    ),
  )
  expect(lines).toContainEqual(
    expect.stringMatching(
      new RegExp(`^FIREBASE_AUTH_EMULATOR_HOST=127\\.0\\.0\\.1:${port('auth')}\\s+# `),
    ),
  )
  for (const line of lines) expect(line).toMatch(/^[A-Z_]+=\S+\s+# \S/)

  // The address is the view: a reload keeps the tab.
  await page.reload()
  await expect(snippet).toContainText('FIRESTORE_EMULATOR_HOST=')
})

test('links from other pages: a reset for one section, and a connect tab', async ({
  page,
  engine,
}) => {
  // A section's page links to its reset: that section's confirmation,
  // nothing deleted until its own button is pressed.
  await page.goto(`${engine.origin}/console?dialog=reset&section=auth`)
  const dialog = page.getByTestId('reset-dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('Reset Authentication')
  await expect(dialog).toContainText('Everything Authentication holds is deleted')
  await page.getByTestId('reset-dialog-cancel').click()
  await expect(dialog).toHaveCount(0)
  await expect(page).toHaveURL(/\/console\/?$/)
  // A section the engine cannot reset opens nothing: a link never resets another.
  await page.goto(`${engine.origin}/console?dialog=reset&section=logs`)
  await expect(page.getByTestId('overview')).toBeVisible()
  await expect(dialog).toHaveCount(0)

  // An empty state's "Connect" lands on its tab, in view.
  await page.goto(`${engine.origin}/console?connect=python`)
  const connect = page.getByTestId('overview-connect')
  await expect(connect).toBeInViewport()
  await expect(connect.getByRole('tab', { name: 'Python', selected: true })).toBeVisible()
  await expect(page.getByTestId('overview-connect-snippet')).toContainText('firebase_admin')
})

test('the Admin snippet runs as printed', async ({ page, engine }) => {
  await page.goto(`${engine.origin}/console?connect=node`)
  const snippet = page.getByTestId('overview-connect-snippet')
  await expect(snippet).toContainText("import { initializeApp } from 'firebase-admin/app'")
  const code = await snippet.locator('pre, code').first().innerText()

  // Run as printed, with the reads a script would go on to make.
  const stdout = await runWithAdminSdk(
    [
      code,
      '',
      "import { getFirestore } from 'firebase-admin/firestore'",
      "import { getAuth } from 'firebase-admin/auth'",
      `const ada = await getFirestore().doc('users/${ADA.uid}').get()`,
      'const listed = await getAuth().listUsers()',
      'console.log(JSON.stringify({ exists: ada.exists, users: listed.users.map((user) => user.email) }))',
      'process.exit(0)',
    ].join('\n'),
  )
  const result = JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}') as {
    exists: boolean
    users: string[]
  }
  expect(result.exists).toBe(true)
  expect(result.users).toContain(ADA.email)
})

test('engine details: the configuration, and where the data lives', async ({ page, engine }) => {
  await page.goto(`${engine.origin}/console`)
  const details = page.getByTestId('overview-engine-details')
  await details.scrollIntoViewIfNeeded()
  await expect(details).toBeVisible()
  await expect(page.getByTestId('engine-project-dir')).toContainText(engine.directory)
  await expect(page.getByTestId('engine-offline')).toBeVisible()
  await expect(page.getByTestId('engine-data')).toContainText(join(engine.directory, 'state'))
  await expect(page.getByTestId('engine-writes')).toBeVisible()

  // The engine details carry the configuration, and nothing of the data facts.
  const response = (await (
    await fetch(`${engine.origin}/console/api/v1/overview/engine`)
  ).json()) as Record<string, Record<string, unknown>>
  expect(Object.keys(response).toSorted()).toEqual(['config', 'connection'])
  for (const key of ['mode', 'stateDir', 'resumed', 'importedFrom', 'exportOnExit', 'durability'])
    expect(response.config).not.toHaveProperty(key)
})
