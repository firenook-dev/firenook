import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Page } from '@playwright/test'
import { type Engine, expect, test } from './fixtures'
import {
  app,
  computed,
  deleteAccounts,
  messages,
  signIn,
  signUp,
  toolkit,
  userDetail,
} from './support/auth'
import { readClipboard } from './support/clipboard'
import { dropLive, restoreLive } from './support/live'

// Authentication › Inbox against the real engine (auth spec §9.3, I1–I5,
// I7; I6 restarts an engine, so it is in `auth-engines.spec.ts`): every
// code and link the emulator sends, live, toasted elsewhere in the console
// (never the console's own sends, never a replay), applied from the
// reader. Users made here are on `journey.test` and deleted at the end.

const stamp = () => Date.now().toString(36)
const phoneOf = () => `+1555${String(Date.now()).slice(-7)}`

const inbox = (engine: Engine, search: Record<string, string> = {}) => {
  const query = new URLSearchParams(search).toString()
  return `${engine.origin}/console/auth/inbox${query ? `?${query}` : ''}`
}
const toasts = (page: Page) => page.getByRole('region', { name: 'Notifications' })
const rowOf = (page: Page, id: number) =>
  page.getByTestId('inbox-feed').locator(`[data-testid="feed-row"][data-key="${id}"]`)
const navInbox = (page: Page) => page.getByTestId('nav-page-inbox')

/**
 * Resolves once the beacon of the page at `path` follows the Inbox feed:
 * what is sent after it is news; what came before is what the page read at
 * load. Only that page's subscription counts: the page before it (the
 * Inbox, whose beacon subscribes too) may still be answered after this
 * starts waiting, and a message sent then would be read by the next page
 * at load, as it should, and never toasted.
 */
function beaconFollowing(page: Page, path: string) {
  return page.waitForResponse(async (response) => {
    const request = response.request()
    if (
      request.method() !== 'POST' ||
      !/\/console\/api\/v1\/live\/[^/]+\/subscriptions$/.test(new URL(response.url()).pathname) ||
      !(request.postData() ?? '').includes('"auth.inbox"')
    )
      return false
    const from = await request.headerValue('referer')
    return from !== null && new URL(from).pathname === path
  })
}

/** The badge count this browser last saw on the Inbox (`lib/badges.ts` SEEN_KEY). */
const seenCount = (page: Page, project: string) =>
  page.evaluate((id) => {
    try {
      const seen = JSON.parse(
        localStorage.getItem('firenook.console.badges-seen') ?? '{}',
      ) as Record<string, Record<string, { count: number }>>
      return seen[id]?.['auth.inbox']?.count ?? null
    } catch {
      return null
    }
  }, project)

/** Opens the Inbox and waits until it has marked its badge seen. */
async function seeInbox(page: Page, engine: Engine) {
  await page.goto(inbox(engine))
  await expect(page.getByTestId('auth-inbox')).toBeVisible()
  await expect.poll(() => seenCount(page, engine.project)).not.toBeNull()
}

/** A client `accounts:sendOobCode`, as the app's SDK sends one. */
async function sendOob(engine: Engine, body: Record<string, unknown>) {
  const answer = await app(engine, 'POST', toolkit('accounts:sendOobCode'), { body })
  expect(answer.status, JSON.stringify(answer.body)).toBe(200)
}

/** A client `accounts:sendVerificationCode` (an SMS sign-in code). */
async function sendSms(engine: Engine, phoneNumber: string) {
  const answer = await app(engine, 'POST', toolkit('accounts:sendVerificationCode'), {
    body: { phoneNumber },
  })
  expect(answer.status, JSON.stringify(answer.body)).toBe(200)
}

/** The newest message the engine holds for `to`. */
async function newestFor(engine: Engine, to: string) {
  await expect.poll(async () => (await messages(engine, `to:${to}`, 1)).length).toBe(1)
  const [message] = await messages(engine, `to:${to}`, 1)
  return message!
}

test('I1 a reset link toasts elsewhere, lands in the Inbox live and sets a password', async ({
  page,
  engine,
}) => {
  const email = `reset-${stamp()}@journey.test`
  const user = await signUp(engine, { email })
  try {
    // Seen the Inbox, so its badge counts from here.
    await seeInbox(page, engine)
    const following = beaconFollowing(page, '/console/auth')
    await page.goto(`${engine.origin}/console/auth?user=${user.localId}`)
    await expect(page.getByTestId('user-inspector')).toContainText(user.localId)
    await following

    // The app asks for a reset: a toast with the link's actions.
    await sendOob(engine, { requestType: 'PASSWORD_RESET', email })
    const fromApp = toasts(page).getByText(`Password reset link for ${email}`)
    await expect(fromApp).toBeVisible()
    await expect(toasts(page).getByRole('button', { name: 'Copy link' }).first()).toBeVisible()
    const sent = await newestFor(engine, email)
    await expect(navInbox(page)).toHaveAccessibleName(/1 new code or link since you last opened/)

    // The console sends one too: its own toast says so, the beacon says nothing more.
    await page.getByTestId('send-reset').click()
    await expect(toasts(page).getByText(`Password reset sent to ${email}`)).toBeVisible()
    await expect.poll(async () => (await messages(engine, `to:${email}`)).length).toBe(2)
    // A message from elsewhere after it is the barrier: once its toast is
    // up, the console's send has been through the beacon too.
    const phone = phoneOf()
    await sendSms(engine, phone)
    await expect(toasts(page).getByText(new RegExp(`SMS code for \\${phone}`))).toBeVisible()
    await expect(toasts(page).getByText(`Password reset link for ${email}`)).toHaveCount(1)

    // In the Inbox: the row is new, and its reader sets a new password.
    await page.goto(inbox(engine, { q: `to:${email}` }))
    const row = rowOf(page, sent.id)
    await expect(row).toBeVisible()
    await expect(row.getByTestId('unread-dot')).toBeVisible()
    await row.click()
    await expect(page).toHaveURL(new RegExp(`message=${sent.id}`))
    const reader = page.getByTestId('message-reader')
    await reader.getByTestId('reader-new-password').fill('password-2')
    await reader.getByTestId('reader-set-password').click()
    await expect(reader.getByTestId('reader-done')).toBeVisible()
    expect((await signIn(engine, { email, password: 'password-2' })).status).toBe(200)

    // Used, live, and the call that used it is a link away.
    await expect(row.getByTestId('message-status')).toHaveText('used')
    const usedBy = reader.getByTestId('reader-used-by')
    await expect(usedBy).toBeVisible()
    await usedBy.click()
    await expect(page).toHaveURL(/\/console\/auth\/activity\?.*entry=\d+/)
    await expect(page.getByTestId('call-detail')).toContainText('resetPassword')
  } finally {
    await deleteAccounts(engine, [user.localId])
  }
})

test('I2 an SMS code reads at a glance and copies with c', async ({ page, engine }) => {
  await page.goto(inbox(engine))
  await expect(page.getByTestId('auth-inbox')).toBeVisible()
  const phone = phoneOf()
  await sendSms(engine, phone)
  const message = await newestFor(engine, phone)
  const row = rowOf(page, message.id)
  await expect(row).toBeVisible()
  const code = row.getByTestId('message-code')
  await expect(code).toHaveText(/^\d{6}$/)
  expect(await computed(code, 'font-size')).toBe('14px')
  expect((await row.boundingBox())?.height).toBe(32)

  // The engine's own record of the code is what is copied.
  const codes = await app<{ verificationCodes: { phoneNumber: string; code: string }[] }>(
    engine,
    'GET',
    `/emulator/v1/projects/${engine.project}/verificationCodes`,
    { as: 'admin' },
  )
  const recorded = codes.body.verificationCodes.filter((entry) => entry.phoneNumber === phone)
  expect(recorded.at(-1)?.code).toBe(await code.textContent())
  await row.click()
  await page.keyboard.press('c')
  await expect.poll(() => readClipboard(page)).toBe(recorded.at(-1)?.code)
})

test('I3 Verify now verifies the account, and the user row says so live', async ({
  context,
  engine,
}) => {
  const email = `verify-${stamp()}@journey.test`
  const user = await signUp(engine, { email })
  try {
    // The Users page in one tab, the Inbox in another.
    const usersTab = await context.newPage()
    await usersTab.goto(`${engine.origin}/console/auth?user=${user.localId}`)
    const userRow = usersTab.getByTestId('users-grid').locator(`tr[data-key="${user.localId}"]`)
    await expect(userRow.getByTestId('status-chip')).toHaveText('unverified')
    await usersTab.getByTestId('send-verify').click()
    await expect(toasts(usersTab).getByText(`Verification email sent to ${email}`)).toBeVisible()
    const sent = await newestFor(engine, email)
    expect(sent.kind).toBe('verifyEmail')

    const inboxTab = await context.newPage()
    await inboxTab.goto(inbox(engine, { message: String(sent.id) }))
    const reader = inboxTab.getByTestId('message-reader')
    await expect(reader.getByTestId('reader-apply')).toHaveText('Verify now')
    await reader.getByTestId('reader-apply').click()
    await expect(reader.getByTestId('reader-done')).toContainText('The email is verified.')
    expect((await userDetail(engine, user.localId))?.row.emailVerified).toBe(true)
    await expect(userRow.getByTestId('status-chip')).toHaveCount(0)
  } finally {
    await deleteAccounts(engine, [user.localId])
  }
})

test('I4 Open in app follows a sign-in link to the app with its code', async ({
  page,
  context,
  engine,
}) => {
  const email = `link-${stamp()}@journey.test`
  // The app the link continues to: a page this journey serves.
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end(`<title>The app</title><p>${request.url ?? ''}</p>`)
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const port = (server.address() as AddressInfo).port
  try {
    const continueUrl = `http://127.0.0.1:${port}/finish`
    await sendOob(engine, {
      requestType: 'EMAIL_SIGNIN',
      email,
      continueUrl,
      canHandleCodeInApp: true,
    })
    const sent = await newestFor(engine, email)
    await page.goto(inbox(engine, { message: String(sent.id) }))
    const reader = page.getByTestId('message-reader')
    await expect(reader).toContainText(continueUrl)
    const opened = context.waitForEvent('page')
    await reader.getByTestId('reader-open').click()
    const tab = await opened
    await tab.waitForURL(new RegExp(`^http://127\\.0\\.0\\.1:${port}/finish\\?`))
    const landed = new URL(tab.url())
    expect(landed.searchParams.get('mode')).toBe('signIn')
    expect(landed.searchParams.get('oobCode')).toBe(sent.code)
    await expect(tab).toHaveTitle('The app')
    await tab.close()
  } finally {
    await new Promise((done) => server.close(done))
  }
})

test('I5 a link handed back to the Admin SDK is marked returned and never toasted', async ({
  page,
  engine,
}) => {
  const email = `admin-${stamp()}@journey.test`
  const user = await signUp(engine, { email })
  try {
    const following = beaconFollowing(page, '/console/auth')
    await page.goto(`${engine.origin}/console/auth`)
    await expect(page.getByTestId('users-grid')).toBeVisible()
    await following
    // generatePasswordResetLink(): the link comes back in the answer.
    const answer = await app<{ oobLink: string }>(
      engine,
      'POST',
      toolkit('accounts:sendOobCode', { project: engine.project }),
      { as: 'admin', body: { requestType: 'PASSWORD_RESET', email, returnOobLink: true } },
    )
    expect(answer.status).toBe(200)
    expect(answer.body.oobLink).toContain('oobCode=')
    const returned = await newestFor(engine, email)
    // A message sent after it: once its toast is up, the returned one has
    // been through the beacon and said nothing.
    const phone = phoneOf()
    await sendSms(engine, phone)
    await expect(toasts(page).getByText(new RegExp(`SMS code for \\${phone}`))).toBeVisible()
    await expect(toasts(page).getByText(email)).toHaveCount(0)

    await page.goto(inbox(engine, { q: `to:${email}` }))
    await expect(rowOf(page, returned.id).getByTestId('message-status')).toHaveText('returned')
  } finally {
    await deleteAccounts(engine, [user.localId])
  }
})

test('I7 what arrives while the channel is down comes back quietly', async ({ page, engine }) => {
  // Seen the Inbox: the badge counts from here.
  await seeInbox(page, engine)
  const following = beaconFollowing(page, '/console/auth')
  await page.goto(`${engine.origin}/console/auth`)
  await expect(page.getByTestId('users-grid')).toBeVisible()
  await following
  await expect(navInbox(page).getByRole('img')).toHaveCount(0)

  await dropLive(page)
  await expect(page.getByTestId('engine-badge')).toHaveText('reconnecting', { timeout: 5_000 })
  const base = String(Date.now()).slice(-6)
  const phones = Array.from({ length: 5 }, (_, index) => `+1555${index}${base}`)
  for (const phone of phones) await sendSms(engine, phone)
  const last = await newestFor(engine, phones.at(-1)!)
  await restoreLive(page)
  await expect(page.getByTestId('engine-badge')).toHaveText(/^engine /, { timeout: 15_000 })

  // The badge counts all five.
  await expect(navInbox(page)).toHaveAccessibleName(/5 new codes and links since you last opened/)
  // ⌘K's latest code is the last of them: the beacon has had the replay.
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByTestId('palette-input').fill('latest SMS')
  await expect(page.getByRole('option', { name: /Copy the latest SMS code/ })).toContainText(
    `${last.code} for ${phones.at(-1)}`,
  )
  await page.keyboard.press('Escape')
  // …and toasted none of it.
  for (const phone of phones)
    await expect(toasts(page).getByText(new RegExp(`\\${phone}`))).toHaveCount(0)

  // The rows are all there.
  await page.goto(inbox(engine))
  for (const phone of phones)
    await expect(
      page.getByTestId('inbox-feed').getByTestId('feed-row').filter({ hasText: phone }),
    ).toBeVisible()
})
