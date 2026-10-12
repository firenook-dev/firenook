import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { type Engine, expect, test } from './fixtures'
import { readClipboard } from './support/clipboard'
import {
  ENGINE_SENTINEL,
  callFunction,
  codebaseOf,
  consoleJson,
  finishedInvocation,
  functionId,
  functionsSnapshot,
  invocationOf,
  invocations,
  loadsOf,
  nextLoad,
  projectFile,
  reload,
  setBackground,
} from './support/compute'
import { fieldLook, paintOf } from './support/look'
import { commit, statusOf } from './support/shell'

// The Functions journeys (compute spec §9.3, 1–18) against the `compute`
// profile's engine: the shared codebase with `compute.js` and `auth.js`
// (the real SDK, offline), the `jobs` and `broken` codebases and the
// greeter extension (`scripts/fixtures/compute.mjs`, `extensions.mjs`).
// Every journey makes its own documents and calls, named so no other
// journey's match, and puts back every file it changes. Waits are on what
// the page or the engine ends up saying, never on time. No mocked API.

/** A name no other journey's documents or calls carry. */
const unique = (stem: string) => `${stem}-${Date.now().toString(36)}`

/** The Functions page, on one function or none. */
async function openFunctions(page: Page, engine: Engine, search = '') {
  await page.goto(`${engine.origin}/console/functions${search}`)
  await expect(page.getByTestId('functions-panel')).toBeVisible()
}

/** One function's page, with its Run tab open when asked. */
async function openFunction(page: Page, engine: Engine, name: string, tab?: string) {
  await openFunctions(
    page,
    engine,
    `?function=${functionId(name)}${tab ? `&tab=${encodeURIComponent(tab)}` : ''}`,
  )
  await expect(page.getByTestId('function-name')).toHaveText(name)
}

/** The panel's row for a node: `codebase:<id>`, `function:<id>`, `all`. */
const node = (page: Page, id: string) =>
  page.locator(`[data-testid="panel-tree-node"][data-node-id="${id}"]`)

/** The overview's row of a function. */
const overviewRow = (page: Page, name: string) =>
  page.getByTestId('functions-overview').locator(`tr[data-key="${functionId(name)}"]`)

/** The function page's list rows, newest first. */
const listRows = (page: Page) =>
  page.getByTestId('function-invocations').getByTestId('invocation-row')

/** A row of the function's list whose summary reads `summary`. */
const rowWith = (page: Page, summary: string | RegExp) =>
  listRows(page).filter({
    has: page.getByTestId('invocation-summary').filter({ hasText: summary }),
  })

/** The page's document, as a function run in the page sees it (this file is typed for Node). */
interface BrowserDocument {
  document: {
    querySelector(selector: string): {
      getAttribute(name: string): string | null
      textContent: string | null
    } | null
  }
}

/** Counts the page's full loads, so a journey can say nothing reloaded. */
function countLoads(page: Page): () => number {
  let loads = 0
  page.on('load', () => {
    loads += 1
  })
  return () => loads
}

/** Clicks the overflow menu item of a dropdown by its text. */
async function menuItem(page: Page, name: string | RegExp): Promise<Locator> {
  const item = page.getByRole('menuitem', { name })
  await expect(item).toBeVisible()
  return item
}

test('functions load and say what they listen to', async ({ page, engine }) => {
  const snapshot = await functionsSnapshot(engine)
  await openFunctions(page, engine)

  // Every codebase in the panel with its count; the extension instance last.
  for (const id of ['default', 'jobs', 'greeter']) {
    const count = snapshot.codebases.find((entry) => entry.codebase.id === id)?.codebase
    expect(count?.state, `${id} loaded`).toBe('ready')
    await expect(node(page, `codebase:${id}`)).toContainText(String(count?.functionCount))
  }
  await expect(node(page, 'codebase:broken')).toContainText('Failed')
  const order = await page
    .getByTestId('panel-tree-node')
    .evaluateAll((nodes) =>
      nodes
        .map((element) => element.getAttribute('data-node-id') ?? '')
        .filter((id) => id.startsWith('codebase:')),
    )
  expect(order).toEqual([
    'codebase:default',
    'codebase:jobs',
    'codebase:broken',
    'codebase:greeter',
  ])
  await expect(overviewRow(page, 'ext-greeter-greet')).toContainText('ext')
  await expect(overviewRow(page, 'ext-greeter-greet')).toContainText('greeter')

  // What each listens to, in words.
  await expect(overviewRow(page, 'onOrderCreated').getByTestId('overview-trigger')).toHaveText(
    'orders/{orderId} created · (default)',
  )
  await expect(overviewRow(page, 'nightly').getByTestId('overview-trigger')).toHaveText(
    'every 5 minutes',
  )

  // A function that receives nothing says why, with the engine's reason on hover.
  const legacy = overviewRow(page, 'legacyDb').getByTestId('overview-trigger')
  await expect(legacy).toContainText('Ignored')
  const reason = snapshot.functions.find((summary) => summary.name === 'legacyDb')?.statusReason
  expect(reason).toContain('database emulator')
  await legacy.hover()
  await expect(page.locator('.kumo-tooltip-popup')).toContainText(
    'database emulator does not exist',
  )
  await expect(overviewRow(page, 'onCrash').getByTestId('overview-trigger')).toContainText(
    'Firebase Alerts are not delivered by this engine yet.',
  )
  // Dropped at load: listed last, with its event type.
  await expect(
    page
      .getByTestId('functions-overview')
      .locator('tr[data-key^="not-loaded:default:"]')
      .filter({ hasText: 'onConfig' })
      .getByTestId('overview-trigger'),
  ).toContainText('Not loaded: google.firebase.remoteconfig.remoteConfig.v1.updated')
  await expect(node(page, `not-loaded:default:${functionId('onConfig')}`)).toContainText(
    'not loaded',
  )

  // Kind chips share one ground, whatever the kind.
  const grounds = await page
    .getByTestId('functions-overview')
    .getByTestId('kind-badge')
    .evaluateAll((badges) =>
      badges.map((badge) => {
        const style = badge.ownerDocument.defaultView!.getComputedStyle(badge)
        return `${style.backgroundColor} ${style.color}`
      }),
    )
  expect(grounds.length).toBeGreaterThan(10)
  expect(new Set(grounds).size).toBe(1)

  // A declared secret nothing provides is said on the function's page.
  await node(page, `function:${functionId('usesSecret')}`).click()
  await expect(page.getByTestId('function-name')).toHaveText('usesSecret')
  await expect(page.getByTestId('problem-secrets')).toContainText('1 secret missing')
  await expect(page.getByTestId('function-missing-secrets')).toContainText('MISSING_KEY')
})

test('invoke an HTTP function and read the response, its own logs and its curl', async ({
  page,
  engine,
}) => {
  const loads = countLoads(page)
  // Another call first, so the list holds an invocation that is not the form's.
  await callFunction(engine, 'api', '/before')
  await openFunction(page, engine, 'api')
  await expect(rowWith(page, '/before')).toBeVisible()
  await page.getByTestId('function-primary').click()
  await expect(page).toHaveURL(/tab=run/)
  await expect(
    page.getByTestId('function-inspector').getByRole('tab', { name: 'Invoke' }),
  ).toHaveAttribute('aria-selected', 'true')

  const path = page.getByTestId('invoke-path')
  await path.fill('/hello?x=1')
  await path.blur()
  // The query moved into its rows.
  const query = page.getByTestId('invoke-query-row')
  await expect(query).toHaveCount(1)
  await expect(query.getByTestId('invoke-query-key')).toHaveValue('x')
  await expect(query.getByTestId('invoke-query-value')).toHaveValue('1')
  await expect(path).toHaveValue('/hello')
  // Typing a name on the add line makes the row; its value is the row's own field.
  await page.getByTestId('invoke-headers-add-key').fill('x-demo')
  const header = page.getByTestId('invoke-headers-row')
  await expect(header).toHaveCount(1)
  await expect(header.getByTestId('invoke-headers-key')).toHaveValue('x-demo')
  await header.getByTestId('invoke-headers-value').fill('1')
  await page.keyboard.press('ControlOrMeta+Enter')

  const response = page.getByTestId('invoke-response')
  await expect(response).toHaveAttribute('data-state', 'done')
  await expect(response).toHaveAttribute('data-status', '200')
  await expect(page.getByTestId('invoke-response-json')).toContainText('query: { x }')
  // The answer as it came: the query and the header the function was given.
  await response.getByRole('tab', { name: 'Raw' }).click()
  await expect(response).toContainText('"query":{"x":"1"}')
  await expect(response).toContainText('"x-demo":"1"')

  // The new row is at the top of the list, without a reload.
  await expect(listRows(page).first().getByTestId('invocation-summary')).toHaveText(
    'GET /hello?x=1',
  )
  expect(loads()).toBe(1)

  // Its own log lines, and no other invocation's.
  await listRows(page).first().click()
  const detail = page.getByTestId('invocation-detail')
  await expect(detail.getByTestId('invocation-detail-summary')).toHaveText('GET /hello?x=1')
  const lines = detail.getByTestId('invocation-logs').getByTestId('log-line')
  await expect(lines).toHaveCount(1)
  await expect(lines.first()).toContainText('hello from api')

  // Copy as curl: the function as apps reach it, not the console's origin.
  const functions = (await statusOf(engine)).services.find(
    (service) => service.name === 'functions',
  )
  expect(functions).toBeDefined()
  await detail.getByTestId('invocation-copy-as').click()
  await (await menuItem(page, 'curl')).click()
  await expect
    .poll(() => readClipboard(page))
    .toContain(
      `'http://${functions!.host}:${functions!.port}/${engine.project}/us-central1/api/hello?x=1'`,
    )
  const curl = await readClipboard(page)
  expect(curl).toMatch(/^curl -X GET /)
  expect(curl).toContain(`-H 'x-demo: 1'`)
  expect(curl).not.toContain(engine.origin)
})

test('a streaming response arrives as it is produced', async ({ page, engine }) => {
  await openFunction(page, engine, 'api', 'run')
  await page.getByTestId('invoke-path').fill('/stream')
  await page.getByTestId('invoke-send').click()
  // The first chunk is on screen while the answer is still being received.
  await page.waitForFunction(() => {
    const response = (globalThis as unknown as BrowserDocument).document.querySelector(
      '[data-testid="invoke-response"]',
    )
    return (
      response?.getAttribute('data-state') === 'receiving' &&
      (response.textContent ?? '').includes('one') &&
      !(response.textContent ?? '').includes('three')
    )
  })
  await expect(page.getByTestId('invoke-response-figures')).toContainText('receiving…')
  const response = page.getByTestId('invoke-response')
  await expect(response).toHaveAttribute('data-state', 'done')
  await expect(response).toContainText('three')
  await page.getByRole('tab', { name: /^Chunks/ }).click()
  await expect(page.getByRole('tab', { name: 'Chunks · 3' })).toBeVisible()
})

test('a callable called as a user, with custom claims, with App Check, and failing', async ({
  page,
  engine,
}) => {
  await openFunction(page, engine, 'addMessage', 'run')
  const form = page.getByTestId('callable-form')
  const data = page.getByTestId('callable-data')
  const call = async () => {
    await page.getByTestId('callable-send').click()
    await expect(page.getByTestId('run-outcome')).not.toHaveAttribute('data-outcome', 'running')
  }
  const result = form.getByTestId('callable-result')

  // As ada, with the token the engine minted for her.
  await page.getByTestId('callable-call-as').click()
  await page.getByTestId('callable-call-as-user').filter({ hasText: 'ada@example.test' }).click()
  await expect(page.getByTestId('callable-call-as')).toHaveAttribute('data-kind', 'user')
  await data.fill('{"text": "hi"}')
  await call()
  await expect(result).toContainText('uid: "u_k65eq"')
  await expect(result).toContainText('admin: null')
  await expect(result).toContainText('appCheck: false')

  // A custom identity's claims reach auth.token.
  await page.getByTestId('callable-call-as').click()
  await page.getByTestId('callable-call-as-custom').click()
  const custom = page.getByTestId('callable-call-as-custom-dialog')
  await custom.getByTestId('callable-call-as-custom-dialog-uid').fill('u_admin')
  await custom.getByTestId('callable-call-as-custom-dialog-claims').fill('{"admin": true}')
  await custom.getByTestId('callable-call-as-custom-dialog-use').click()
  await expect(page.getByTestId('callable-call-as')).toHaveAttribute('data-kind', 'custom')
  await call()
  await expect(result).toContainText('uid: "u_admin"')
  await expect(result).toContainText('admin: true')

  // App Check: a token for an app id.
  await form.getByRole('combobox', { name: 'App Check' }).click()
  await page.getByRole('option', { name: 'Token for app id' }).click()
  await page.getByTestId('callable-app-id').fill('1:123:web:abc')
  await call()
  await expect(result).toContainText('appCheck: true')
  const appCheck = await invocations(engine, `function:${functionId('addMessage')}`)
  const answered = await invocationOf(engine, appCheck[0]!.id)
  expect(
    answered.detail.request.headers.some((header) => header.name === 'x-firebase-appcheck'),
  ).toBe(true)

  // The SDK's own error mapping.
  await data.fill('{"fail": true}')
  await call()
  await expect(form.getByTestId('callable-error-status')).toHaveText('INVALID_ARGUMENT')
  await expect(form.getByTestId('callable-error')).toContainText('text is required')
})

test('a real Firestore write fires the trigger and links back to the document', async ({
  page,
  engine,
}) => {
  const id = unique('o1')
  await openFunction(page, engine, 'onOrderCreated')
  await expect(page.getByTestId('function-invocations')).toBeVisible()
  await commit(engine, [{ path: `orders/${id}`, fields: { total: { integerValue: '12' } } }])
  const row = rowWith(page, `orders/${id} created`)
  await expect(row).toBeVisible()
  await expect(row.getByTestId('invocation-origin')).toHaveText('emulator')
  await expect(row).toHaveAttribute('data-outcome', 'succeeded')

  // The detail's cause opens the document in Firestore.
  await row.click()
  const cause = page.getByTestId('cause-firestore.document-link')
  await expect(cause).toContainText(`orders/${id}`)
  await cause.click()
  await expect(page).toHaveURL(/\/console\/firestore\?/)
  await expect(page.getByTestId('inspector')).toContainText(`orders/${id}`)

  // `o` on the row does the same.
  await page.goBack()
  await expect(rowWith(page, `orders/${id} created`)).toBeVisible()
  await page.getByTestId('invocation-detail').getByTestId('invocation-detail-summary').click()
  await rowWith(page, `orders/${id} created`).click()
  await page.keyboard.press('o')
  await expect(page).toHaveURL(/\/console\/firestore\?/)
  await expect(page.getByTestId('inspector')).toContainText(`orders/${id}`)
})

test('a test event runs the trigger and writes nothing', async ({ page, engine }) => {
  const id = unique('o2')
  await openFunction(page, engine, 'onOrderCreated', 'run')
  await page.getByTestId('event-path').fill(`orders/${id}`)
  await page.getByTestId('event-data').fill('{"total": 99}')
  await expect(page.getByTestId('event-envelope')).toContainText(`orders/${id}`)
  await page.getByTestId('event-edit-envelope').click()
  const envelope = page.getByTestId('event-envelope-json')
  await expect(envelope).toContainText('"integerValue": 99')
  // Edit the total in the envelope itself: its text, copied, changed and put back.
  await page.getByTestId('run-copy-as').click()
  await (await menuItem(page, 'the envelope as JSON')).click()
  await expect.poll(() => readClipboard(page)).toContain('"integerValue": 99')
  const edited = (await readClipboard(page)).replace('"integerValue": 99', '"integerValue": 120')
  await envelope.fill(edited)
  await page.getByTestId('event-send').click()
  const outcome = page.getByTestId('run-outcome')
  await expect(outcome).toContainText('Succeeded')
  const invocation = await finishedInvocation(
    engine,
    'onOrderCreated',
    (candidate) => candidate.origin === 'console',
  )
  expect(invocation.outcome).toBe('succeeded')
  const view = await invocationOf(engine, invocation.id)
  expect(JSON.stringify(view.detail.event)).toContain('120')
  expect(view.detail.logs.some((line) => line.message.includes(`order created ${id}`))).toBe(true)
  // Nothing was written.
  const read = await fetch(
    `${engine.origin}/console/api/v1/firestore/v1/projects/${engine.project}/databases/(default)/documents/orders/${id}`,
    { headers: { authorization: 'Bearer owner' } },
  )
  expect(read.status).toBe(404)
  await read.text()
})

/** The toasts on screen. */
const toasts = (page: Page) => page.getByRole('region', { name: 'Notifications' })

/** Sends a test event to onOrderCreated from its Run tab and waits for its row. */
async function sendOrderEvent(page: Page, id: string) {
  await page.getByTestId('event-path').fill(`orders/${id}`)
  await page.getByTestId('event-data').fill('{"total": 7}')
  await page.getByTestId('event-send').click()
  await expect(page.getByTestId('run-outcome')).toContainText('Succeeded')
}

test('replay after a code change runs the new code, and edit and replay fills the form', async ({
  page,
  engine,
}) => {
  const id = unique('o7')
  const source = projectFile(engine, 'functions/compute.js')
  try {
    await openFunction(page, engine, 'onOrderCreated', 'run')
    await sendOrderEvent(page, id)
    const first = await finishedInvocation(engine, 'onOrderCreated', (invocation) =>
      invocation.summary.includes(id),
    )

    // A change on disk reloads the codebase, and the page says so.
    const before = await loadsOf(engine, 'default')
    source.write(source.original.replace('`order created ${', '`order created v2 ${'))
    await nextLoad(engine, 'default', before)
    await expect(toasts(page)).toContainText('default reloaded')

    // `r` asks, Replay runs it again against the new code.
    await page.getByTestId('function-inspector-close').click()
    const original = page.locator(`[data-testid="invocation-row"][data-id="${first.id}"]`)
    await original.click()
    await expect(page.getByTestId('invocation-detail')).toBeVisible()
    await page.keyboard.press('r')
    const confirm = page.getByTestId('replay-confirm')
    await expect(confirm).toContainText(`Replay #${first.seq.toLocaleString('en-US')}?`)
    await page.getByTestId('replay-confirm-confirm').click()
    await expect(confirm).toBeHidden()
    const detail = page.getByTestId('invocation-detail')
    await expect(detail.getByTestId('invocation-replay-of')).toContainText(
      `Replay of #${first.seq.toLocaleString('en-US')}`,
    )
    await expect(detail.getByTestId('invocation-logs')).toContainText(`order created v2 ${id}`)
    await expect(original).toHaveCount(1)
    const replayed = await finishedInvocation(
      engine,
      'onOrderCreated',
      (invocation) => invocation.replayOf === first.id,
    )
    expect(replayed.origin).toBe('replay')

    // Shift+R: the Run tab, filled from the invocation, and the param gone once it is.
    await page.keyboard.press('Shift+R')
    await expect(page).toHaveURL(/tab=run/)
    await expect(page).not.toHaveURL(/prefill=/)
    await expect(page.getByTestId('event-envelope-json')).toContainText(`orders/${id}`)
  } finally {
    const before = await loadsOf(engine, 'default')
    if (source.restore()) await nextLoad(engine, 'default', before)
  }
})

test('a broken reload says what broke and keeps serving the last good load', async ({
  page,
  engine,
}) => {
  const lib = projectFile(engine, 'jobs/lib/index.js')
  const badge = page.getByTestId('nav-badge-functions-functions')
  // `broken` never loaded: said from the start, and counted in the nav.
  await openFunctions(page, engine, '?codebase=broken')
  await expect(page.getByTestId('codebase-failed')).toContainText(
    'broken did not load. None of its functions are running.',
  )
  await expect(badge).toHaveText('1')
  await expect(badge).toHaveAccessibleName('1 codebase failed to load')
  try {
    await openFunction(page, engine, 'heartbeat')
    // A worker running the good code, as there is once the function is called.
    expect((await callFunction(engine, 'heartbeat')).status).toBe(200)
    const serving = (await codebaseOf(engine, 'jobs')).worker.pid
    const before = await loadsOf(engine, 'jobs')
    lib.write(`${lib.original}\nexports.oops = (\n`)
    await nextLoad(engine, 'jobs', before, 'failed')
    const banner = page.getByTestId('codebase-failed')
    await expect(banner).toContainText('jobs failed to reload')
    await expect(banner).toContainText('The functions below are from the previous load.')
    await expect(node(page, 'codebase:jobs')).toContainText('Failed · previous load')
    await page.getByTestId('codebase-failed-toggle').click()
    await expect(page.getByTestId('codebase-failed-detail')).toContainText('SyntaxError')
    await expect(badge).toHaveText('2')
    await expect(badge).toHaveAccessibleName('2 codebases failed to load')
    // The previous load still serves: its worker keeps the code it loaded.
    expect((await callFunction(engine, 'heartbeat')).status).toBe(200)
    expect((await codebaseOf(engine, 'jobs')).worker.pid).toBe(serving)

    const broken = await loadsOf(engine, 'jobs')
    lib.restore()
    await nextLoad(engine, 'jobs', broken)
    await expect(banner).toBeHidden()
    await expect(toasts(page)).toContainText('jobs reloaded')
    await expect(toasts(page)).toContainText('No function changes.')
    await expect(badge).toHaveText('1')
  } finally {
    const before = await loadsOf(engine, 'jobs')
    if (lib.restore()) await nextLoad(engine, 'jobs', before)
  }
})

test('a schedule says when it runs next, runs now, and keeps its phase across a reload', async ({
  page,
  engine,
}) => {
  type Detail = { schedule: { evaluatedIn: string | null; nextRun: string | null } | null }
  const nightly = await consoleJson<Detail>(engine, `/functions/${functionId('nightly')}`)
  expect(nightly.schedule?.evaluatedIn).toBeTruthy()
  expect(nightly.schedule?.nextRun).toBeTruthy()
  const next = Date.parse(nightly.schedule!.nextRun!)
  expect(next - Date.now()).toBeLessThanOrEqual(5 * 60_000)

  await openFunction(page, engine, 'nightly', 'run')
  await expect(page.getByTestId('schedule-expression')).toHaveText('every 5 minutes')
  await expect(page.getByTestId('schedule-zone')).toHaveText(
    `Evaluated in ${nightly.schedule!.evaluatedIn}`,
  )
  await expect(page.getByTestId('schedule-form')).toContainText(/\(in \d+ (min|s)/)

  // Run now: the scheduler's own tick, followed to its invocation.
  await page.getByTestId('schedule-run').click()
  await expect(page.getByTestId('run-outcome')).toContainText('Succeeded')
  await expect(rowWith(page, 'scheduled tick').first()).toBeVisible()

  // A declared zone is the one it is evaluated in.
  await openFunction(page, engine, 'cleanup', 'run')
  await expect(page.getByTestId('schedule-zone')).toContainText('America/New_York')

  // A reload keeps the phase: the next run does not move.
  const source = projectFile(engine, 'functions/compute.js')
  try {
    const before = await loadsOf(engine, 'default')
    source.write(`${source.original}\n// touched by the schedule journey\n`)
    await nextLoad(engine, 'default', before)
    const after = await consoleJson<Detail>(engine, `/functions/${functionId('nightly')}`)
    expect(after.schedule?.nextRun).toBe(nightly.schedule?.nextRun)
  } finally {
    const before = await loadsOf(engine, 'default')
    if (source.restore()) await nextLoad(engine, 'default', before)
  }

  // Its schedule in Pub/Sub: a link once that page is built, words until then.
  await openFunction(page, engine, 'nightly', 'run')
  const link = page.getByTestId('schedule-link')
  if ((await link.count()) > 0) {
    await link.click()
    await expect(page).toHaveURL(/\/console\/pubsub/)
  } else {
    await expect(page.getByTestId('schedule-form')).toContainText(
      'Runs through Pub/Sub topic firebase-schedule-nightly.',
    )
  }
})

test('enqueue a task through Cloud Tasks and follow its attempt', async ({ page, engine }) => {
  await openFunction(page, engine, 'resize', 'run')
  const form = page.getByTestId('task-form')
  await expect(form.getByLabel('Run after, in seconds')).toHaveCount(0)
  await expect(form).toContainText(
    'Cloud Tasks here runs a task at once whatever its schedule time',
  )
  await expect(page.getByTestId('task-payload')).toContainText('"url": "a.png"')
  await page.getByTestId('task-enqueue').click()
  const result = page.getByTestId('task-result')
  await expect(result).toContainText('Enqueued task')
  await expect(page.getByTestId('run-outcome')).toContainText('Succeeded')
  const attempt = await finishedInvocation(engine, 'resize', (invocation) =>
    /^task \S+ · attempt 1$/.test(invocation.summary),
  )
  await expect(rowWith(page, attempt.summary)).toBeVisible()
  const view = await invocationOf(engine, attempt.id)
  expect(
    view.detail.request.headers.some((header) => header.name === 'x-cloudtasks-queuename'),
  ).toBe(true)
  expect(view.detail.logs.some((line) => line.message.includes('a.png'))).toBe(true)
  // The task, in Cloud Tasks: a link once that section is built, its name until then.
  expect(view.refs.some((ref) => ref.kind === 'tasks.task' || ref.kind === 'tasks.queue')).toBe(
    true,
  )
})

test('a blocking function decides a sign-up, tested and for real', async ({ page, engine }) => {
  const snapshot = await functionsSnapshot(engine)
  test.skip(
    !snapshot.functions.some((summary) => summary.name === 'beforeCreate'),
    'The auth stream’s fixture (auth.js) does not export beforeCreate on this branch yet.',
  )
  await openFunction(page, engine, 'beforeCreate', 'run')
  await page.getByTestId('blocking-email').fill('ada@blocked.test')
  await page.getByTestId('blocking-test').click()
  const decision = page.getByTestId('blocking-decision')
  await expect(decision).toHaveAttribute('data-kind', 'blocked')
  await expect(decision).toContainText('PERMISSION_DENIED')
  await expect(decision).toContainText('Sign-ups from blocked.test are not allowed')

  const email = `${unique('bob')}@example.com`
  await page.getByTestId('blocking-email').fill(email)
  await page.getByTestId('blocking-sign-up').click()
  const allowed = await finishedInvocation(
    engine,
    'beforeCreate',
    (invocation) => invocation.outcome === 'allowed' && invocation.origin === 'emulator',
  )
  await expect(page.getByTestId('run-outcome')).toContainText('Allowed')
  const view = await invocationOf(engine, allowed.id)
  expect(view.refs.some((ref) => ref.kind === 'auth.call')).toBe(true)
  await page.locator(`[data-testid="invocation-row"][data-id="${allowed.id}"]`).click()
  await expect(page.getByTestId('cause-auth.call')).toBeVisible()
})

test('paused background triggers drop real writes, record a test event as Paused, and resume', async ({
  page,
  engine,
}) => {
  const dropped = unique('o3')
  const delivered = unique('o4')
  await openFunction(page, engine, 'onOrderCreated')
  const banner = page.getByTestId('banner-triggers-paused')
  try {
    await setBackground(engine, false)
    await expect(banner).toBeVisible()
    // The shell's banner is the only one: compute draws no strip of its own.
    await expect(page.getByTestId('function-body').getByText(/paused/i)).toHaveCount(0)
    await expect(node(page, `function:${functionId('onOrderCreated')}`)).not.toContainText('paused')

    await commit(engine, [{ path: `orders/${dropped}`, fields: { total: { integerValue: '1' } } }])
    await expect(banner).toContainText(/since \d\d:\d\d:\d\d/)
    await expect(banner).toContainText('1 Firestore change reached no function.')
    expect(
      (await invocations(engine, `function:${functionId('onOrderCreated')}`)).some((invocation) =>
        invocation.summary.includes(dropped),
      ),
    ).toBe(false)

    // A test event sent anyway is recorded, and the handler does not run.
    await page.getByTestId('function-primary').click()
    await expect(page.getByTestId('run-paused')).toContainText('Background triggers are paused')
    await page.getByTestId('event-path').fill(`orders/${unique('paused')}`)
    await page.getByTestId('event-data').fill('{}')
    await page.getByTestId('event-send').click()
    await expect(page.getByTestId('run-outcome')).toContainText('Paused')
    const paused = await finishedInvocation(
      engine,
      'onOrderCreated',
      (invocation) => invocation.outcome === 'paused',
    )
    expect(paused.logCount).toBe(0)

    await page.getByTestId('run-resume').click()
    await expect(banner).toBeHidden()
    await commit(engine, [
      { path: `orders/${delivered}`, fields: { total: { integerValue: '2' } } },
    ])
    await expect(rowWith(page, `orders/${delivered} created`)).toHaveAttribute(
      'data-outcome',
      'succeeded',
    )
  } finally {
    await setBackground(engine, true)
  }
})

test('the environment says where each value comes from, and saves secrets and params', async ({
  page,
  engine,
}) => {
  const secrets = projectFile(engine, 'functions/.secret.local')
  const local = join(engine.directory, 'functions/.env.local')
  try {
    const detail = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
        `/console/api/v1/functions/${functionId('usesSecret')}`,
    )
    await openFunction(page, engine, 'usesSecret', 'environment')
    const body = await (await detail).text()
    expect(body).not.toContain('s3cret')
    expect(body).not.toContain(ENGINE_SENTINEL)

    const tab = page.getByTestId('environment-tab')
    const greeting = tab.locator('[data-testid="env-variable"][data-key="GREETING"]')
    await expect(greeting).toContainText('hello')
    await expect(greeting).toContainText('.env')
    // A secret is masked until asked for, and read from the file then.
    await expect(page.getByTestId('env-secret-API_KEY-masked')).toBeVisible()
    await expect(tab).not.toContainText('s3cret')
    await page.getByTestId('env-secret-API_KEY-reveal').click()
    await expect(page.getByTestId('env-secret-API_KEY-value')).toHaveText('s3cret')

    // A missing secret, added through the dialog that shows the diff.
    const missing = tab.locator('[data-testid="env-secret"][data-key="MISSING_KEY"]')
    await expect(missing).toContainText('missing from .secret.local')
    await page.getByTestId('env-add-secret-MISSING_KEY').click()
    await page.getByTestId('env-edit-value').fill('m1')
    await page.getByTestId('env-edit-review').click()
    const dialog = page.getByTestId('env-change-dialog')
    const file = dialog.locator(
      '[data-testid="env-change-dialog-file"][data-file="functions/.secret.local"]',
    )
    await expect(file.locator('[data-key="MISSING_KEY"]')).toBeVisible()
    await expect(dialog).not.toContainText('m1')
    const before = await loadsOf(engine, 'default')
    await page.getByTestId('env-change-dialog-confirm').click()
    // Saved once the codebase has loaded with it.
    await expect(dialog).toBeHidden({ timeout: 20_000 })
    await expect(missing).toContainText('provided')
    expect(await loadsOf(engine, 'default')).toBeGreaterThan(before)
    expect(secrets.read()).toContain('MISSING_KEY=m1')

    // An unresolved param, set as the official CLI's prompt does: in .env.local.
    const batch = tab.locator('[data-testid="env-param"][data-key="BATCH"]')
    await expect(batch).toContainText('unresolved')
    await page.getByTestId('env-set-param-BATCH').click()
    await page.getByTestId('env-edit-value').fill('25')
    await page.getByTestId('env-edit-review').click()
    await expect(
      dialog.locator('[data-testid="env-change-dialog-file"][data-file="functions/.env.local"]'),
    ).toContainText('BATCH')
    await page.getByTestId('env-change-dialog-confirm').click()
    await expect(dialog).toBeHidden({ timeout: 20_000 })
    await expect(batch).toContainText('25 · .env.local')
    expect(readFileSync(local, 'utf8')).toMatch(/^BATCH=25$/m)

    // What the worker inherits from the host is counted, never shown.
    await expect(page.getByTestId('env-inherited')).toContainText(
      /\+ \d+ variables from the engine's own environment/,
    )
    await page.getByTestId('env-emulator-toggle').click()
    await expect(page.locator('body')).not.toContainText(ENGINE_SENTINEL)
  } finally {
    // Env files are read at load (a change on disk only flags the codebase),
    // so the files go back and the codebase loads them again.
    const restored = secrets.restore()
    const removed = existsSync(local)
    if (removed) rmSync(local)
    if (restored || removed) await reload(engine, 'default')
  }
})

test('which writes fire this, before writing anything', async ({ page, engine }) => {
  await openFunction(page, engine, 'onOrderCreated', 'trigger')
  const matcher = page.getByTestId('trigger-matcher')
  await page.getByTestId('match-path').fill('orders/x')
  const fires = matcher.locator('[data-testid="match-row"][data-fires]')
  await expect(fires).toHaveCount(2)
  await expect(fires.filter({ hasText: 'onOrderCreated' })).toHaveCount(1)
  await expect(fires.filter({ hasText: 'onOrderWritten' })).toHaveCount(1)

  await page.getByTestId('match-path').fill('users/x')
  await expect(fires).toHaveCount(0)
  const row = matcher.getByTestId('match-row').filter({ hasText: 'onOrderCreated' })
  await expect(row).toContainText('Does not fire')
  await expect(row).toContainText('orders/{orderId}')
})

test('restart a worker: the dialog says what is in flight, and a new worker answers', async ({
  page,
  engine,
}) => {
  expect((await callFunction(engine, 'api', '/warm')).status).toBe(200)
  const before = await codebaseOf(engine, 'default')
  expect(before.worker.pid).not.toBeNull()
  await openFunction(page, engine, 'api')
  await page.getByTestId('function-menu').click()
  await (await menuItem(page, /Restart worker/)).click()
  const dialog = page.getByTestId('restart-worker-dialog')
  await expect(dialog).toContainText('Restart the worker for default?')
  await expect(page.getByTestId('restart-in-flight')).toHaveText('No calls are in flight.')
  await page.getByTestId('restart-worker-confirm').click()
  await expect(dialog).toBeHidden()
  await expect(toasts(page)).toContainText('Restarted the default worker')
  expect((await callFunction(engine, 'api', '/after-restart')).status).toBe(200)
  const after = await codebaseOf(engine, 'default')
  expect(after.worker.pid).not.toBeNull()
  expect(after.worker.pid).not.toBe(before.worker.pid)
})

test('call an HTTP function as a user: the header is set by Call as, and masked in the record', async ({
  page,
  engine,
}) => {
  await openFunction(page, engine, 'api', 'run')
  await page.getByTestId('invoke-path').fill('/whoami')
  await page.getByTestId('invoke-call-as').click()
  await page.getByTestId('invoke-call-as-user').filter({ hasText: 'ada@example.test' }).click()
  const authorization = page.locator('[data-testid="identity-header"][data-name="authorization"]')
  await expect(authorization).toContainText('set by Call as')
  await page.getByTestId('invoke-send').click()
  const response = page.getByTestId('invoke-response')
  await expect(response).toHaveAttribute('data-state', 'done')
  await expect(page.getByTestId('invoke-response-json')).toContainText('uid: "u_k65eq"')

  // The record keeps the header masked: its value never reaches the page.
  const invocation = await finishedInvocation(engine, 'api', (candidate) =>
    candidate.summary.endsWith('/whoami'),
  )
  const view = await invocationOf(engine, invocation.id)
  const recorded = view.detail.request.headers.find((header) => header.name === 'authorization')
  expect(recorded?.sensitive).toBe(true)
  expect(recorded?.value).toBeNull()
  await page.getByTestId('run-invocation').click()
  const detail = page.getByTestId('invocation-detail')
  await detail.getByRole('tab', { name: 'Request' }).click()
  await expect(detail.getByTestId('request-headers')).toContainText('authorization')
  await expect(detail.getByTestId('request-headers')).toContainText('••••')

  // Removing the row is calling with no auth.
  await page.getByTestId('invocation-back').click()
  await page.getByRole('button', { name: 'Remove authorization' }).click()
  await expect(page.getByTestId('invoke-call-as')).toHaveAttribute('data-kind', 'owner')
  await expect(page.getByTestId('invoke-call-as')).toContainText('No auth')
})

test('a pasted curl command fills the whole form', async ({ page, engine }) => {
  const functions = (await statusOf(engine)).services.find(
    (service) => service.name === 'functions',
  )
  const address = `http://${functions!.host}:${functions!.port}/${engine.project}/us-central1/api`
  await openFunction(page, engine, 'api', 'run')
  const curl = `curl -X POST '${address}/orders' -H 'x-demo: 2' -d '{"n":1}'`
  await page.evaluate(
    (text) =>
      (
        globalThis as unknown as {
          navigator: { clipboard: { writeText(text: string): Promise<void> } }
        }
      ).navigator.clipboard.writeText(text),
    curl,
  )
  await page.getByTestId('invoke-path').click()
  await page.keyboard.press('ControlOrMeta+V')
  await expect(page.getByTestId('invoke-form')).toContainText('Filled from curl')
  await expect(page.getByTestId('invoke-path')).toHaveValue('/orders')
  await expect(page.getByTestId('request-method')).toContainText('POST')
  const header = page.getByTestId('invoke-headers-row')
  await expect(header.getByTestId('invoke-headers-key')).toHaveValue('x-demo')
  await expect(header.getByTestId('invoke-headers-value')).toHaveValue('2')
  await expect(page.getByTestId('invoke-body')).toHaveAttribute('data-kind', 'json')
  await expect(page.getByTestId('invoke-body-json')).toContainText('"n":1')
})

/** A computed style of an element, as the browser applies it. */
const styleOf = (locator: Locator, property: string) =>
  locator.evaluate(
    (element, name) =>
      element.ownerDocument.defaultView!.getComputedStyle(element).getPropertyValue(name),
    property,
  )

/** The brand-filled buttons a person can see on the page. */
const visiblePrimaries = (page: Page) =>
  page.locator('button').evaluateAll(
    (buttons) =>
      buttons.filter((button) => {
        const element = button as unknown as {
          style: { getPropertyValue(name: string): string }
          getBoundingClientRect(): { width: number; height: number }
          ownerDocument: {
            defaultView: { getComputedStyle(element: unknown): { visibility: string } }
          }
        }
        const box = element.getBoundingClientRect()
        return (
          element.style.getPropertyValue('--kumo-button-emphasis-bg').includes('brand') &&
          box.width > 0 &&
          element.ownerDocument.defaultView.getComputedStyle(element).visibility === 'visible'
        )
      }).length,
  )

test('the design holds: type, hovers, one primary, steady toolbar, remembered widths', async ({
  page,
  engine,
}) => {
  for (const path of ['/a', '/b', '/c']) await callFunction(engine, 'api', path)
  await page.setViewportSize({ width: 1440, height: 900 })
  await openFunction(page, engine, 'api')
  const row = listRows(page).first()
  await expect(row).toBeVisible()

  // Rows: values 12 px mono, figures 11 px, the relative time sans.
  const summary = row.getByTestId('invocation-summary')
  expect(await styleOf(summary, 'font-size')).toBe('12px')
  expect(await styleOf(summary, 'font-family')).toMatch(/mono/i)
  expect(
    await styleOf(row.getByTestId('invocation-duration').locator('span').first(), 'font-size'),
  ).toBe('11px')
  const time = row.locator('time').first()
  expect(await styleOf(time, 'font-family')).not.toMatch(/mono/i)

  // The identity field is flat at rest, with no ring.
  expect((await fieldLook(page.getByTestId('function-identity'))).ring).toBe(false)

  // One hover step of ink on a row, in both themes.
  for (const mode of ['light', 'dark'] as const) {
    await page
      .locator('html')
      .evaluate((root, theme) => root.setAttribute('data-mode', theme), mode)
    await page.mouse.move(5, 5)
    const rest = await paintOf(row)
    await row.hover()
    await expect.poll(() => paintOf(row)).not.toBe(rest)
    const hovered = await paintOf(row)
    expect(Math.abs(hovered - rest), `${mode} hover step`).toBeLessThanOrEqual(24)
  }
  await page.locator('html').evaluate((root) => root.setAttribute('data-mode', 'light'))

  // The toolbar's ⋯ keeps its place as the Run tab opens and closes, at every width.
  for (const width of [1440, 1280, 1024]) {
    await page.setViewportSize({ width, height: 900 })
    const menu = page.getByTestId('function-menu')
    const closed = (await menu.boundingBox())!.x
    await page.getByTestId('function-primary').click()
    await expect(page.getByTestId('function-inspector')).toBeVisible()
    expect(Math.round((await menu.boundingBox())!.x), `⋯ at ${width} with Run open`).toBe(
      Math.round(closed),
    )
    // With the Run tab open, its Send is the one primary on screen.
    expect(await visiblePrimaries(page)).toBe(1)
    await page.getByTestId('function-inspector-close').click()
    await expect(page.getByTestId('function-inspector')).toBeHidden()
    expect(Math.round((await menu.boundingBox())!.x)).toBe(Math.round(closed))
  }
  // …and as the function's name changes length.
  await page.setViewportSize({ width: 1440, height: 900 })
  const menuX = (await page.getByTestId('function-menu').boundingBox())!.x
  await node(page, `function:${functionId('ping')}`).click()
  await expect(page.getByTestId('function-name')).toHaveText('ping')
  expect(Math.round((await page.getByTestId('function-menu').boundingBox())!.x)).toBe(
    Math.round(menuX),
  )
  await node(page, `function:${functionId('api')}`).click()
  await expect(page.getByTestId('function-name')).toHaveText('api')

  // "Pause" and "Paused · 2 new" sit in one slot: the slot and the button's
  // right edge stay where they are, so nothing beside them moves.
  const pause = page.getByTestId('pause-button')
  const slot = pause.locator('..')
  const failedOnly = page.getByTestId('failed-only')
  const following = {
    slot: (await slot.boundingBox())!,
    pause: (await pause.boundingBox())!,
    failed: (await failedOnly.boundingBox())!,
  }
  await pause.click()
  await expect(page).toHaveURL(/paused=true/)
  for (const path of ['/d', '/e']) await callFunction(engine, 'api', path)
  await expect(pause).toContainText('Paused · 2 new')
  const held = {
    slot: (await slot.boundingBox())!,
    pause: (await pause.boundingBox())!,
    failed: (await failedOnly.boundingBox())!,
  }
  expect(Math.round(held.slot.width)).toBe(Math.round(following.slot.width))
  expect(Math.round(held.pause.x + held.pause.width)).toBe(
    Math.round(following.pause.x + following.pause.width),
  )
  expect(held.failed.x).toBe(following.failed.x)
  await pause.click()

  // The inspector opened from a row: title 14 px, prose 13 px; its width is
  // this page's own, and the Invocations page keeps another.
  await row.click()
  const detail = page.getByTestId('invocation-detail')
  await expect(detail).toBeVisible()
  // The title is the invocation's number in the data face (the kit's
  // InspectorTitle), the summary 13 px.
  const title = detail.getByText(/^#[\d,]+$/).first()
  expect(await styleOf(title, 'font-family')).toMatch(/mono/i)
  expect(await styleOf(detail.getByTestId('invocation-detail-summary'), 'font-size')).toBe('13px')
  const grip = page.getByTestId('invocation-detail-resize')
  const box = (await grip.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + 200)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 - 100, box.y + 200, { steps: 6 })
  await page.mouse.up()
  const widened = Math.round((await detail.boundingBox())!.width)
  const stored = await page.evaluate(() => {
    const storage = (
      globalThis as unknown as { localStorage: { getItem(key: string): string | null } }
    ).localStorage
    return {
      function: storage.getItem('firenook.console.inspector-width.functions.function'),
      invocation: storage.getItem('firenook.console.inspector-width.functions.invocation'),
    }
  })
  expect(Number(stored.function)).toBe(widened)
  expect(stored.invocation).toBeNull()
  await page.reload()
  await expect(page.getByTestId('invocation-detail')).toBeVisible()
  expect(Math.round((await page.getByTestId('invocation-detail').boundingBox())!.width)).toBe(
    widened,
  )
  // The id as the console writes it in an address (a JSON string, so an id
  // such as 40406e-694 is never read back as a number).
  const opened = JSON.stringify(await row.getAttribute('data-id'))
  await page.goto(
    `${engine.origin}/console/functions/invocations?invocation=${encodeURIComponent(opened)}`,
  )
  await expect(page.getByTestId('invocation-detail')).toBeVisible()
  expect(Math.round((await page.getByTestId('invocation-detail').boundingBox())!.width)).not.toBe(
    widened,
  )

  // Nothing says "Live": a list that follows says nothing until it stops.
  for (const path of [
    '/functions',
    `/functions?function=${functionId('api')}`,
    '/functions/invocations',
  ]) {
    await page.goto(`${engine.origin}/console${path}`)
    await expect(page.getByTestId('functions-panel')).toBeVisible()
    await expect(page.locator('body')).not.toContainText(/\bLive\b/)
  }
})
