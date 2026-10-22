import type { Page } from '@playwright/test'
import { type Engine, expect, test } from './fixtures'
import {
  adminUpdate,
  app,
  blockingFunctionsReady,
  consoleJson,
  deleteAccounts,
  emulatorConfig,
  latestCall,
  payloadOf,
  scrollSettled,
  setEmulatorConfig,
  signIn,
  signUp,
  toolkit,
  unsignedJwt,
  userDetail,
} from './support/auth'
import { readClipboard } from './support/clipboard'
import { dropLive, restoreLive } from './support/live'
import { subscriptionLog } from './support/shell'

// Authentication › Activity against the real engine (auth spec §9.3,
// A1–A10): every call with its exact error explained, the console's own
// edits hidden until asked for, Replay and curl, the live tail and its
// pause, blocking functions, Inspect a token, a dropped channel and the
// topic only this page takes. Users made here are on
// `journey.test` (or the blocking fixtures' domains) and deleted at the end.

const stamp = () => Date.now().toString(36)
const activity = (engine: Engine, search: Record<string, string> = {}) => {
  const query = new URLSearchParams(search).toString()
  return `${engine.origin}/console/auth/activity${query ? `?${query}` : ''}`
}
const feedRows = (page: Page) => page.getByTestId('activity-feed').getByTestId('feed-row')
const rowOf = (page: Page, id: number) =>
  page.getByTestId('activity-feed').locator(`[data-testid="feed-row"][data-key="${id}"]`)
const detail = (page: Page) => page.getByTestId('call-detail')

/**
 * What in a row is cut off with nothing to say so: an outcome whose text
 * runs past its box without an ellipsis, or a step chip on the visible
 * line that its strip clips. A chip that wrapped out of sight is whole.
 */
const silentlyCut = (row: ReturnType<typeof rowOf>) =>
  row.evaluate((element) => {
    // This file is typed for Node: the page's elements as far as they are used.
    type Box = { top: number; bottom: number; right: number }
    type Node = {
      scrollWidth: number
      clientWidth: number
      textContent: string | null
      parentElement: Node | null
      getBoundingClientRect(): Box
      querySelectorAll(selector: string): Iterable<Node>
    }
    const root = element as unknown as Node
    const view = (element as unknown as { ownerDocument: { defaultView: unknown } }).ownerDocument
      .defaultView as { getComputedStyle(node: Node): { textOverflow: string; overflow: string } }
    const cut: string[] = []
    for (const node of root.querySelectorAll('[data-testid="activity-outcome"] *')) {
      const style = view.getComputedStyle(node)
      if (
        node.scrollWidth > node.clientWidth + 1 &&
        style.overflow !== 'visible' &&
        style.textOverflow !== 'ellipsis'
      )
        cut.push(`outcome: ${node.textContent ?? ''}`)
    }
    for (const chip of root.querySelectorAll('[data-testid="activity-step"]')) {
      const strip = chip.parentElement?.getBoundingClientRect()
      const box = chip.getBoundingClientRect()
      if (strip && box.top < strip.bottom && box.right > strip.right + 0.5)
        cut.push(`step: ${chip.textContent ?? ''}`)
    }
    return cut
  })

test('A1 a failed sign-in is explained in the SDK’s words, its password masked', async ({
  page,
  engine,
}) => {
  const email = `wrong-${stamp()}@journey.test`
  const user = await signUp(engine, { email })
  try {
    await page.goto(activity(engine))
    await expect(page.getByTestId('auth-activity')).toBeVisible()
    const failed = await signIn(engine, { email, password: 'not-the-password' })
    expect(failed.body.error?.message).toBe('INVALID_PASSWORD')
    const call = await latestCall(engine)
    const row = rowOf(page, call.id)
    await expect(row).toBeVisible()
    await expect(row.getByTestId('activity-outcome')).toHaveText('INVALID_PASSWORD')
    await expect(row.getByTestId('activity-sdk')).toHaveText('auth/wrong-password')
    await row.click()
    await expect(page).toHaveURL(new RegExp(`entry=${call.id}`))
    await expect(detail(page).getByTestId('call-sdk-code')).toHaveText('auth/wrong-password')
    await expect(detail(page).getByTestId('call-explanation')).toContainText(/password/i)
    await expect(detail(page).getByTestId('call-fix')).not.toBeEmpty()

    // The password the app sent is masked until asked for.
    const body = detail(page).getByTestId('call-request-body')
    await expect(body.getByTestId('call-request-body-masked-masked')).toBeVisible()
    await expect(body).not.toContainText('not-the-password')
    await body.getByTestId('call-request-body-masked-reveal').click()
    await expect(body.getByTestId('call-request-body-masked-value')).toHaveText('not-the-password')
  } finally {
    await deleteAccounts(engine, [user.localId])
  }
})

test('A2 with enumeration protection on, a wrong password is explained with the switch', async ({
  page,
  engine,
}) => {
  const email = `privacy-${stamp()}@journey.test`
  const user = await signUp(engine, { email })
  const before = await emulatorConfig(engine)
  try {
    await page.goto(`${engine.origin}/console/auth/settings`)
    const toggle = page.getByTestId('settings-enumeration')
    await expect(toggle).not.toBeChecked()
    await toggle.click()
    await expect(toggle).toBeChecked()
    await expect
      .poll(
        async () => (await emulatorConfig(engine)).emailPrivacyConfig.enableImprovedEmailPrivacy,
      )
      .toBe(true)

    const failed = await signIn(engine, { email, password: 'not-the-password' })
    expect(failed.body.error?.message).toBe('INVALID_LOGIN_CREDENTIALS')
    const call = await latestCall(engine)
    await page.goto(activity(engine, { entry: String(call.id) }))
    await expect(detail(page).getByTestId('call-sdk-code')).toHaveText('auth/invalid-credential')
    await expect(detail(page).getByTestId('call-explanation')).toContainText(
      'enumeration protection is on',
    )
    await detail(page).getByTestId('call-settings').click()
    await expect(page).toHaveURL(/\/console\/auth\/settings/)
    await expect(page.getByTestId('settings-enumeration')).toBeVisible()
  } finally {
    await setEmulatorConfig(engine, {
      enableImprovedEmailPrivacy: before.emailPrivacyConfig.enableImprovedEmailPrivacy,
    })
    await deleteAccounts(engine, [user.localId])
  }
})

test('A3 the console’s own edits wait behind a tick', async ({ page, engine }) => {
  const email = `edits-${stamp()}@journey.test`
  const user = await signUp(engine, { email })
  try {
    // An edit made in the inspector.
    await page.goto(`${engine.origin}/console/auth?user=${user.localId}`)
    const name = page.getByTestId('user-inspector').getByTestId('field-display-name')
    await name.fill('Edited here')
    const saved = page.waitForResponse(
      (response) =>
        response.url().includes('/accounts:update') && response.request().method() === 'POST',
    )
    await page.getByTestId('save-user').click()
    const answer = await saved
    expect(answer.status()).toBe(200)
    const edit = Number(answer.headers()['x-firenook-activity'])
    expect(edit).toBeGreaterThan(0)

    await page.goto(activity(engine))
    await expect(feedRows(page).first()).toBeVisible()
    await expect(rowOf(page, edit)).toHaveCount(0)
    await page.getByTestId('activity-console-toggle').getByRole('checkbox').click()
    await expect(page).toHaveURL(/console=true/)
    await expect(rowOf(page, edit)).toBeVisible()
    await page.getByTestId('activity-console-toggle').getByRole('checkbox').click()
    await expect(rowOf(page, edit)).toHaveCount(0)
  } finally {
    await deleteAccounts(engine, [user.localId])
  }
})

test('A4 a call copies as curl and replays, asking first when it would make a user', async ({
  page,
  engine,
}) => {
  const email = `replay-${stamp()}@journey.test`
  await page.goto(activity(engine))
  await expect(page.getByTestId('auth-activity')).toBeVisible()
  const user = await signUp(engine, { email })
  const signedUp = await latestCall(engine)
  try {
    expect((await signIn(engine, { email, password: 'password-2' })).status).toBe(400)
    const wrong = await latestCall(engine)

    // curl: the Auth emulator's own address, the call's body.
    await page.goto(activity(engine, { entry: String(wrong.id) }))
    await expect(detail(page).getByTestId('call-sdk-code')).toBeVisible()
    await detail(page).getByTestId('call-curl').click()
    const auth = (
      await consoleJson<{ services: { name: string; host: string; port: number }[] }>(
        engine,
        '/status',
      )
    ).services.find((service) => service.name === 'auth')!
    await expect
      .poll(() => readClipboard(page))
      .toContain(
        `http://${auth.host}:${auth.port}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword`,
      )
    const curl = await readClipboard(page)
    expect(curl).toMatch(/^curl /)
    expect(curl).toContain(email)

    // Fixed, then replayed: a new entry of its own, shown and opened.
    await adminUpdate(engine, user.localId, { password: 'password-2' })
    await detail(page).getByTestId('call-replay').click()
    await expect(page).not.toHaveURL(new RegExp(`entry=${wrong.id}(&|$)`))
    await expect(detail(page).getByTestId('call-title')).toContainText('200')
    const replayed = Number(new URL(page.url()).searchParams.get('entry'))
    expect(replayed).toBeGreaterThan(wrong.id)
    await expect(rowOf(page, replayed).getByTestId('activity-caller')).toHaveText('Replay')

    // A sign-up's replay would make another user: it asks, and Cancel sends nothing.
    await page.goto(activity(engine, { entry: String(signedUp.id) }))
    await detail(page).getByTestId('call-replay').click()
    const ask = page.getByTestId('call-replay-ask-description')
    await expect(ask).toHaveText('Replay creates another user.')
    const newest = await latestCall(engine)
    await page.getByTestId('call-replay-ask-cancel').click()
    await expect(ask).toHaveCount(0)
    expect((await latestCall(engine)).id).toBe(newest.id)
  } finally {
    await deleteAccounts(engine, [user.localId])
  }
})

test('A5 a paused tail holds still, counts what came, and resumes with it', async ({
  page,
  engine,
}) => {
  const email = `tail-${stamp()}@journey.test`
  // More calls than the view holds, so there is a view to hold still.
  for (let call = 0; call < 40; call += 1)
    await signIn(engine, { email: `fill-${stamp()}@journey.test`, password: `password-${call}` })
  await page.goto(activity(engine))
  await expect(feedRows(page).first()).toBeVisible()
  const pause = page.getByTestId('pause-button')
  // The pause sits in a slot as wide as its widest words: the filter beside
  // it never moves.
  const filter = page.getByTestId('activity-filter')
  const width = (await filter.boundingBox())?.width
  /** The row at the top of the view, and where it is drawn. */
  const topRow = () =>
    page.getByTestId('activity-feed-scroll').evaluate((scroll) => {
      const edge = scroll.getBoundingClientRect().top
      const rows = [...scroll.querySelectorAll('[data-testid="feed-row"]')]
        .map((row) => ({
          key: row.getAttribute('data-key') ?? '',
          top: row.getBoundingClientRect().top,
        }))
        .filter((row) => row.top >= edge - 0.5)
        .toSorted((a, b) => a.top - b.top)
      return rows[0]
    })

  await page.keyboard.press('p')
  await expect(page).toHaveURL(/paused=true/)
  await expect(pause).toHaveText('Paused')
  const before = await topRow()
  for (let call = 0; call < 5; call += 1)
    await signIn(engine, { email, password: `password-${call}` })
  await expect(pause).toHaveText('Paused · 5 new')
  expect((await filter.boundingBox())?.width).toBe(width)
  await expect(page.getByTestId('jump-to-latest')).toHaveText('5 new · Jump to latest')
  // Nothing moved under the reader: the same row, where it was.
  const after = await topRow()
  expect(after?.key).toBe(before?.key)
  expect(Math.abs((after?.top ?? 0) - (before?.top ?? 0))).toBeLessThanOrEqual(1)
  for (const row of await feedRows(page).filter({ hasText: email }).all())
    await expect(row).not.toBeInViewport()

  // Space on a row is the row's (the list's page down), not the pause's.
  await page.locator(`[data-testid="feed-row"][data-key="${before?.key}"]`).click()
  await page.keyboard.press('Escape')
  await page.keyboard.press('Space')
  await scrollSettled(page.getByTestId('activity-feed-scroll'))
  await expect(page).toHaveURL(/paused=true/)

  await page.keyboard.press('p')
  await expect(page).not.toHaveURL(/paused=true/)
  await expect(pause).not.toHaveText(/Paused/)
  await expect(feedRows(page).filter({ hasText: email })).toHaveCount(5)
  await expect(feedRows(page).filter({ hasText: email }).first()).toBeInViewport()
})

test('A7 a dropped channel is the engine badge’s to say, and the calls catch up', async ({
  page,
  engine,
}) => {
  const email = `dropped-${stamp()}@journey.test`
  await page.goto(activity(engine))
  await expect(feedRows(page).first()).toBeVisible()
  const badge = page.getByTestId('engine-badge')
  await dropLive(page)
  await expect(badge).toHaveText('Reconnecting', { timeout: 5_000 })
  // This page says nothing of its own about it.
  await expect(page.getByTestId('activity-row-one')).not.toContainText(/live|reconnect/i)
  for (let call = 0; call < 3; call += 1)
    await signIn(engine, { email, password: `password-${call}` })
  await restoreLive(page)
  await expect(page.getByTestId('top-bar')).toHaveAttribute('data-live', 'live', {
    timeout: 15_000,
  })
  await expect(feedRows(page).filter({ hasText: email })).toHaveCount(3)
})

test('A8 blocking functions refuse and add claims, step by step, with their own words', async ({
  page,
  engine,
}) => {
  await blockingFunctionsReady(engine)
  const blocked = `x-${stamp()}@blocked.test`
  const claimed = `y-${stamp()}@claims.test`
  let claimedUid: string | undefined
  try {
    // beforeCreate refuses the blocked domain, with its own message.
    const refused = await app<{ error: { message: string } }>(
      engine,
      'POST',
      toolkit('accounts:signUp'),
      { body: { email: blocked, password: 'password-1', returnSecureToken: true } },
    )
    expect(refused.status).toBe(400)
    expect(refused.body.error.message).toMatch(/^BLOCKING_FUNCTION_ERROR_RESPONSE/)
    const refusedCall = await latestCall(engine)
    await page.goto(activity(engine, { entry: String(refusedCall.id) }))
    const step = detail(page).getByTestId('call-blocking')
    await expect(step).toContainText('beforeCreate')
    await expect(step).toContainText(/\d+(\.\d+)? (µs|ms|s)/)
    await expect(detail(page).getByTestId('call-blocking-failure')).toContainText(
      'Sign-ups from blocked.test are not allowed',
    )
    await detail(page).getByTestId('call-raw-toggle').click()
    await expect(detail(page).getByTestId('call-raw-toggle')).toHaveText('Hide the raw error')
    await expect(step.locator('code')).toContainText('blocked.test')

    // In the list beside the open detail, at 1440 px, the long code ends in
    // an ellipsis rather than being cut mid-word, the whole of it and the
    // SDK's name a hover away, and every step chip is whole or out of sight.
    await page.setViewportSize({ width: 1440, height: 900 })
    const listed = rowOf(page, refusedCall.id)
    await expect(listed).toBeVisible()
    expect(await silentlyCut(listed)).toEqual([])
    await listed.getByTestId('activity-outcome').hover()
    await expect(page.locator('.kumo-tooltip-popup')).toContainText(
      'BLOCKING_FUNCTION_ERROR_RESPONSE · auth/internal-error',
    )

    // beforeSignIn adds claims and session claims to the token.
    const created = await app<{ localId: string; idToken: string }>(
      engine,
      'POST',
      toolkit('accounts:signUp'),
      { body: { email: claimed, password: 'password-1', returnSecureToken: true } },
    )
    expect(created.status).toBe(200)
    claimedUid = created.body.localId
    const token = payloadOf(created.body.idToken)
    expect(token.tester).toBe(true)
    expect(token.session).toBe('journey')
    const signUpCall = await latestCall(engine)
    await page.goto(activity(engine, { entry: String(signUpCall.id) }))
    const steps = detail(page).getByTestId('call-steps')
    const signInStep = detail(page).getByTestId('call-blocking').filter({ hasText: 'beforeSignIn' })
    await expect(signInStep).toContainText('custom claims tester')
    await expect(signInStep).toContainText('session claims session')
    await expect(steps).toContainText('user.create')

    // The account trigger ran: its document is there.
    const document = `/firestore/v1/projects/${engine.project}/databases/(default)/documents/auth-triggers/${claimedUid}`
    await expect
      .poll(
        async () => {
          const response = await fetch(`${engine.origin}/console/api/v1${document}`, {
            headers: { authorization: 'Bearer owner' },
          })
          return response.status
        },
        { timeout: 30_000 },
      )
      .toBe(200)
  } finally {
    if (claimedUid) await deleteAccounts(engine, [claimedUid])
  }
})

test('A9 Inspect a token says how each consumer judges it, and how to fix it', async ({
  page,
  engine,
}) => {
  const email = `inspect-${stamp()}@journey.test`
  const user = await signUp(engine, { email })
  try {
    const real = payloadOf(user.idToken)
    const now = Math.floor(Date.now() / 1_000)
    await page.goto(activity(engine, { panel: 'inspect' }))
    const input = page.getByTestId('inspect-token-input')
    const verdict = (consumer: string) =>
      page.locator(`[data-testid="inspect-token-verdict"][data-consumer="${consumer}"]`)

    // Expired twenty minutes ago.
    await input.fill(unsignedJwt({ ...real, iat: now - 4_800, exp: now - 1_200 }))
    await expect(verdict('verify')).toHaveAttribute('data-ok', 'false')
    await expect(verdict('verify')).toContainText(/Expired 2\d min ago/)
    await expect(verdict('verify')).toContainText('Get a fresh token')
    // The rules read it, as the official emulator's do, and say production
    // would not, and how to get one it would.
    await expect(verdict('rules')).toHaveAttribute('data-ok', 'true')
    await expect(verdict('rules')).toContainText(
      /Accepted, but production refuses it: it expired 2\d min ago/,
    )
    await expect(verdict('rules')).toContainText('Get a fresh token')

    // Issued before the user's tokens were revoked.
    const early = unsignedJwt({ ...real, iat: now - 600, auth_time: now - 600, exp: now + 3_000 })
    await adminUpdate(engine, user.localId, { validSince: String(now - 60) })
    await input.fill(early)
    await expect(verdict('verifyRevoked')).toHaveAttribute('data-ok', 'false')
    await expect(verdict('verifyRevoked')).toContainText(
      /Revoked: the user signed in at .+, before the tokens were revoked at/,
    )
    await expect(verdict('verify')).toHaveAttribute('data-ok', 'true')

    // Another project's token names both, and the fix.
    await input.fill(
      unsignedJwt({
        ...real,
        aud: 'demo-other',
        iss: 'https://securetoken.google.com/demo-other',
        exp: now + 3_000,
      }),
    )
    await expect(verdict('verify')).toContainText(
      `This ID token is for project \`demo-other\`; the emulator runs \`${engine.project}\`.`,
    )
    await expect(verdict('verify')).toContainText(
      `initializeApp({ projectId: '${engine.project}' })`,
    )
    await expect(verdict('rules')).toHaveAttribute('data-ok', 'true')
    await expect(verdict('rules')).toContainText(
      `Accepted, but production refuses it: it is for project \`demo-other\`; the emulator runs \`${engine.project}\`.`,
    )
    await expect(verdict('rules')).toContainText(
      `initializeApp({ projectId: '${engine.project}' })`,
    )
    expect((await userDetail(engine, user.localId))?.row.disabled).toBe(false)

    // Sign in as › View the token… opens the minted token here, with what
    // the engine said as it minted it, for as long as it is in the box.
    await page.goto(`${engine.origin}/console/auth?user=${user.localId}`)
    await page.getByTestId('user-inspector').getByTestId('sign-in-as').click()
    await page.getByTestId('view-token').click()
    await expect(page).toHaveURL(/\/console\/auth\/activity\?.*panel=inspect/)
    const minted = page.getByTestId('inspect-token-minted')
    await expect(minted).toContainText(`For ${email}, as a password sign-in`)
    await expect(minted).toContainText('Nothing was stored.')
    await expect(input).toHaveValue(/^ey/)
    expect(payloadOf(await input.inputValue()).sub).toBe(user.localId)
    await expect(verdict('verify')).toHaveAttribute('data-ok', 'true')
    await expect(verdict('rules')).toHaveAttribute('data-ok', 'true')
    await input.fill(early)
    await expect(minted).toHaveCount(0)
  } finally {
    await deleteAccounts(engine, [user.localId])
  }
})

test('A10 the activity feed is followed only while Activity is on screen', async ({
  page,
  context,
  engine,
}) => {
  const log = subscriptionLog(context)
  await page.goto(`${engine.origin}/console/auth`)
  await expect(page.getByTestId('users-grid')).toBeVisible()
  await expect.poll(() => log.added.includes('auth.users')).toBe(true)
  expect(log.added).not.toContain('auth.activity')

  await page.getByTestId('nav-page-activity').click()
  await expect(page.getByTestId('auth-activity')).toBeVisible()
  await expect.poll(() => log.added.filter((topic) => topic === 'auth.activity').length).toBe(1)

  await page.getByTestId('nav-page-users').click()
  await expect(page.getByTestId('users-grid')).toBeVisible()
  await expect.poll(() => log.removed.includes('auth.activity')).toBe(true)
  expect(log.added.filter((topic) => topic === 'auth.activity')).toHaveLength(1)
})
