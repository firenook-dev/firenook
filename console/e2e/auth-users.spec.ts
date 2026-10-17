import type { Locator, Page } from '@playwright/test'
import { type Engine, expect, test } from './fixtures'
import {
  adminUpdate,
  app,
  applyAdminsOnly,
  batchCreate,
  batchKeys,
  computed,
  consoleJson,
  deleteAccounts,
  framesDuring,
  nextFrame,
  p95,
  payloadOf,
  settled,
  inScratchTenant,
  sampleShaped,
  signIn,
  signUp,
  toolkit,
  userDetail,
  usersCount,
  watchRoutes,
} from './support/auth'
import { readClipboard } from './support/clipboard'
import { readDownload } from './support/downloads'
import { cutRings, paintOf, paintedAtItsOwnCentre } from './support/look'

// Authentication › Users against the real engine (auth spec §9.3, U1–U16):
// the table, its filter and facets, live rows, the inspector and its
// claims, creating users, bulk jobs, import and export, sample users and
// ten thousand rows, sign in as, another project, the keyboard and the look. Journeys
// that make many users, delete in bulk, import or count work in a scratch
// tenant they delete at the end; users made in the project scope are on
// `journey.test` and deleted at the end; the seeded people are only read.

const stamp = () => Date.now().toString(36)

const users = (engine: Engine, search: Record<string, string> = {}) => {
  const query = new URLSearchParams(search).toString()
  return `${engine.origin}/console/auth${query ? `?${query}` : ''}`
}
const rows = (page: Page) => page.getByTestId('users-grid').getByTestId('data-row')
const rowOf = (page: Page, uid: string) =>
  page.getByTestId('users-grid').locator(`tr[data-key="${uid}"]`)
const countText = (page: Page) => page.getByTestId('users-count')
const scroller = (page: Page) => page.getByTestId('users-grid-scroll')
const filterInput = (page: Page) => page.getByTestId('users-filter-input')
const inspector = (page: Page) => page.getByTestId('user-inspector')

/** Replaces a CodeMirror document (its `.cm-content`) the way a person pastes: typing meets auto-closing. */
async function pasteInto(page: Page, editor: Locator, text: string) {
  await editor.click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.evaluate(
    (value) =>
      (
        navigator as Navigator & { clipboard: { writeText(text: string): Promise<void> } }
      ).clipboard.writeText(value),
    text,
  )
  await page.keyboard.press('ControlOrMeta+v')
}

/** The first line of a menu item's text (its shortcut hint is the second). */
const firstLine = (text: string) => text.split('\n')[0]?.trim() ?? ''

/** Every uid of the first `limit` rows the engine lists for a scope, filter and order. */
async function engineOrder(
  engine: Engine,
  search: { sort?: string; q?: string; tenant?: string; limit?: number },
): Promise<string[]> {
  const params = new URLSearchParams({ limit: String(search.limit ?? 20) })
  if (search.sort) params.set('sort', search.sort)
  if (search.q) params.set('q', search.q)
  if (search.tenant) params.set('tenant', search.tenant)
  const page = await consoleJson<{ items: { uid: string }[] }>(engine, `/auth/users?${params}`)
  return page.items.map((item) => item.uid)
}

test('U1 the table lists the engine’s users with its count, sort and type', async ({
  page,
  engine,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(users(engine))
  await expect(rows(page).first()).toBeVisible()
  const total = await usersCount(engine)
  await expect(countText(page)).toHaveText(new RegExp(`^${total.toLocaleString('en-US')} users$`))

  // The engine's default order, and only the columns it sorts by sort.
  const meta = await consoleJson<{ sortable: string[]; defaultSort: string }>(
    engine,
    '/auth/users/meta',
  )
  expect(meta.defaultSort).toBe('created:desc')
  await expect(page.locator('th[data-column="created"]')).toHaveAttribute('aria-sort', 'descending')
  const headers = await page
    .locator('th[data-column]')
    .evaluateAll((cells) =>
      cells.map((cell) => [
        cell.getAttribute('data-column') ?? '',
        cell.querySelector('[data-testid="sort-header"]') !== null,
      ]),
    )
  for (const [column, sortable] of headers)
    expect(sortable, `${String(column)} sorts`).toBe(meta.sortable.includes(String(column)))
  expect(headers.map(([column]) => column)).toEqual(
    expect.arrayContaining(['providers', 'status', ...meta.sortable]),
  )

  // 32 px rows, values in the data face at 12 px, figures at 11 px.
  const first = rows(page).first()
  expect((await first.boundingBox())?.height).toBe(32)
  const cell = first.locator('td[data-column="uid"]')
  const cellFont = await computed(cell, 'font-family')
  expect(cellFont).toMatch(/IBM Plex Mono/)
  expect(await computed(cell, 'font-size')).toBe('12px')
  const facetFigure = page
    .getByTestId('user-facets')
    .getByTestId('facet')
    .first()
    .locator('span.font-mono')
  expect(await computed(facetFigure, 'font-size')).toBe('11px')
  const chip = page.getByTestId('status-chip').first()
  await expect(chip).toBeVisible()
  expect(await computed(chip, 'font-size')).toBe('11px')

  // Facets filter; there is no "All users" facet (the empty filter is that).
  await expect(page.getByTestId('user-facets')).toBeVisible()
  await expect(page.getByTestId('user-facets').getByText('All users')).toHaveCount(0)

  // The tenant picker is the panel's; with the panel closed it moves to row one.
  await expect(page.getByTestId('toolbar-tenant')).toHaveCount(0)
  await page.getByTestId('users-grid-scroll').click({ position: { x: 400, y: 120 } })
  await page.keyboard.press('Escape')
  await page.keyboard.press('t')
  await expect(page.getByTestId('toolbar-tenant')).toBeVisible()
  await page.keyboard.press('t')
  await expect(page.getByTestId('toolbar-tenant')).toHaveCount(0)

  // The shell reads the same figure from the section's summary.
  const status = await consoleJson<{
    sections: { id: string; summary: { figures: { label: string; value: number }[] } | null }[]
  }>(engine, '/status')
  const summary = status.sections.find((section) => section.id === 'auth')?.summary
  expect(summary?.figures.find((entry) => entry.label === 'Users')?.value).toBe(total)
})

test('U2 typing and facets write the filter, and one request goes per settled filter', async ({
  page,
  engine,
}) => {
  await page.goto(users(engine))
  await expect(rows(page).first()).toBeVisible()
  const watch = watchRoutes(page, [{ method: 'GET', path: '/auth/users' }])
  const asked = (q: string) =>
    watch
      .of('GET', '/auth/users')
      .filter((request) => new URL(request.url()).searchParams.get('q') === q)

  await filterInput(page).click()
  await filterInput(page).pressSequentially('ada', { delay: 40 })
  await expect(page).toHaveURL(/[?&]q=ada(&|$)/)
  await expect.poll(() => asked('ada').length).toBe(1)
  expect(asked('a')).toEqual([])
  expect(asked('ad')).toEqual([])
  await expect(countText(page)).toHaveText(
    new RegExp(`^${await usersCount(engine, { q: 'ada' })} users?$`),
  )

  // The facets write their terms, and are pressed by what the filter says.
  const facet = (term: string) =>
    page.getByTestId('user-facets').locator(`button[data-term="${term}"]`)
  await facet('is:disabled').click()
  await expect(page).toHaveURL(/q=ada\+is%3Adisabled|q=ada%20is%3Adisabled/)
  await expect(facet('is:disabled')).toHaveAttribute('aria-pressed', 'true')
  await facet('-has:sign-in').click()
  await expect(filterInput(page)).toHaveValue('ada is:disabled -has:sign-in')
  await expect(facet('-has:sign-in')).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => asked('ada is:disabled -has:sign-in').length).toBe(1)

  // A term the grammar does not know: the ring, the message, its span; the
  // engine refuses the request and the table says so in its words.
  const newButton = page.getByTestId('new-users-menu')
  const before = (await newButton.boundingBox())?.x
  await filterInput(page).fill('foo:bar')
  // The field holds its complaint while the caret is in the bad term.
  await expect(page.getByTestId('users-filter-box')).not.toHaveAttribute('data-invalid', 'true')
  await page.keyboard.press('Escape')
  await expect(filterInput(page)).not.toBeFocused()
  await expect(page.getByTestId('users-filter-box')).toHaveAttribute('data-invalid', 'true')
  await expect(page.getByTestId('users-filter-error')).toContainText('foo')
  await expect(page.getByTestId('users-filter-box').locator('.decoration-wavy')).toHaveText(
    'foo:bar',
  )
  await expect(page).toHaveURL(/q=foo%3Abar/)
  await expect(
    page.getByTestId('users-body').getByRole('heading', { name: /Unknown filter "foo:"/ }),
  ).toBeVisible()

  // A negated term: fewer users than the scope holds, the count's slot
  // unmoved. (Anonymous accounts have no linked provider, so `is:` is the
  // state to negate; `provider:` takes the ids the Providers facets list.)
  await filterInput(page).fill('-is:anonymous')
  await expect(page).toHaveURL(/q=-is%3Aanonymous/)
  const expected = await usersCount(engine, { q: '-is:anonymous' })
  await expect(countText(page)).toHaveText(`${expected.toLocaleString('en-US')} users`)
  expect(expected).toBeLessThan(await usersCount(engine))
  expect((await newButton.boundingBox())?.x).toBe(before)
  watch.stop()
})

test('U3 a header sorts as the engine sorts, and the order is in the address', async ({
  page,
  engine,
}) => {
  await page.goto(users(engine))
  await expect(rows(page).first()).toBeVisible()
  const column = page.locator('th[data-column="signedIn"]')
  const header = column.getByTestId('sort-header')
  const shown = () => rows(page).evaluateAll((trs) => trs.slice(0, 15).map((tr) => tr.dataset.key))
  // A column's first click sorts it ascending, the second descending.
  await header.click()
  await expect(page).toHaveURL(/sort=signedIn%3Aasc/)
  await expect(column).toHaveAttribute('aria-sort', 'ascending')
  await expect(page.locator('th[data-column="created"]')).toHaveAttribute('aria-sort', 'none')
  await expect.poll(shown).toEqual(await engineOrder(engine, { sort: 'signedIn:asc', limit: 15 }))
  await header.click()
  await expect(page).toHaveURL(/sort=signedIn%3Adesc/)
  await expect(column).toHaveAttribute('aria-sort', 'descending')
  await expect.poll(shown).toEqual(await engineOrder(engine, { sort: 'signedIn:desc', limit: 15 }))
  // A reload keeps it: the order is the address's.
  await page.reload()
  await expect(column).toHaveAttribute('aria-sort', 'descending')
  await expect.poll(shown).toEqual(await engineOrder(engine, { sort: 'signedIn:desc', limit: 15 }))
})

test('U4 live rows arrive, flash and patch in place without moving the reader', async ({
  page,
  engine,
}) => {
  await inScratchTenant(engine, async ({ id: tenant }) => {
    await batchCreate(engine, sampleShaped(300, 4), tenant)
    await page.goto(users(engine, { tenant }))
    await expect(rows(page).first()).toBeVisible()
    await expect(countText(page)).toHaveText('300 users')
    const watch = watchRoutes(page, [
      { method: 'GET', path: '/auth/users' },
      { method: 'POST', path: '/auth/users:batchGet' },
    ])
    const pages = () =>
      watch.of('GET', '/auth/users').filter((request) => /[?&](cursor|before)=/.test(request.url()))

    // A sign-up in the tenant: on top, flashing, counted.
    const first = await signUp(engine, { email: `live-${stamp()}@journey.test`, tenant })
    await expect(rows(page).first()).toHaveAttribute('data-key', first.localId)
    await expect(rowOf(page, first.localId)).toHaveClass(/row-flash/)
    await expect(countText(page)).toHaveText('301 users')
    expect(pages()).toEqual([])

    // Scrolled down, a new row does not move what the reader looks at.
    // Row 150 is on the second page: scrolling there loads it.
    const anchor = page.getByTestId('users-grid').locator('tr[aria-rowindex="152"]')
    await expect
      .poll(async () => {
        await scroller(page).evaluate((element) => {
          element.scrollTop = 150 * 32
        })
        return anchor.isVisible()
      })
      .toBe(true)
    const anchorKey = await anchor.getAttribute('data-key')
    const anchored = rowOf(page, anchorKey ?? '')
    const y = (await anchored.boundingBox())?.y ?? 0
    await signUp(engine, { email: `live-2-${stamp()}@journey.test`, tenant })
    await expect(countText(page)).toHaveText('302 users')
    await expect(page.getByTestId('new-above')).toBeVisible()
    await expect(page.getByTestId('new-above')).toHaveText('1 new · Show')
    expect(Math.abs(((await anchored.boundingBox())?.y ?? 0) - y)).toBeLessThanOrEqual(1)

    // A disable is one batch read, and the row changes where it stands.
    watch.clear()
    const target = anchorKey ?? ''
    await adminUpdate(engine, target, { disableUser: true }, tenant)
    await expect(rowOf(page, target).getByTestId('status-chip')).toHaveText('disabled')
    expect(watch.of('POST', '/auth/users:batchGet').map(batchKeys)).toEqual([[target]])
    expect(pages()).toEqual([])
    expect(Math.abs(((await anchored.boundingBox())?.y ?? 0) - y)).toBeLessThanOrEqual(1)

    // A token refresh changes nothing the table shows: no request at all.
    // The disable after it is the barrier: its window comes after the
    // refresh's would have, so once its row is patched the page has seen
    // everything the refresh caused.
    watch.clear()
    const refreshed = await app(engine, 'POST', '/securetoken.googleapis.com/v1/token', {
      body: { grant_type: 'refresh_token', refresh_token: first.refreshToken },
    })
    expect(refreshed.status).toBe(200)
    const barrier = await anchored
      .locator('xpath=following-sibling::tr[1]')
      .getAttribute('data-key')
    await adminUpdate(engine, barrier ?? '', { disableUser: true }, tenant)
    await expect(rowOf(page, barrier ?? '').getByTestId('status-chip')).toHaveText('disabled')
    expect(watch.of('POST', '/auth/users:batchGet').map(batchKeys)).toEqual([[barrier]])
    expect(watch.of('GET', '/auth/users')).toEqual([])
    watch.stop()
  })
})

test('U5 the inspector opens from a row and follows the keyboard', async ({ page, engine }) => {
  await page.goto(users(engine))
  await expect(rows(page).first()).toBeVisible()
  const [firstUid, secondUid] = await rows(page).evaluateAll((trs) =>
    trs.slice(0, 2).map((tr) => tr.dataset.key ?? ''),
  )
  await rows(page).first().locator('td[data-column="providers"]').click()
  await expect(page).toHaveURL(new RegExp(`user=${encodeURIComponent(firstUid ?? '')}`))
  await expect(inspector(page)).toBeVisible()

  // The uid in the header copies itself, and the button says it did.
  const title = inspector(page).locator('button[data-kumo-component="InlineCopyText"]').first()
  await expect(title).toHaveText(firstUid ?? '')
  await title.click()
  await expect(title).toHaveAttribute('aria-label', 'Copied')
  expect(await readClipboard(page)).toBe(firstUid)

  // Its tabs, each in the address.
  for (const tab of ['Claims', 'Raw'] as const) {
    await inspector(page)
      .getByRole('tab', { name: new RegExp(`^${tab}`) })
      .click()
    await expect(page).toHaveURL(new RegExp(`tab=${tab.toLowerCase()}`))
  }
  await inspector(page).getByRole('tab', { name: 'Details' }).click()
  await expect(page).not.toHaveURL(/tab=/)

  // The user as code, in the console's dialects and an accounts.json entry.
  await inspector(page).getByTestId('user-code').click()
  const code = page.getByTestId('user-code-popover')
  await expect(code.getByRole('tab')).toHaveText([
    'Admin (Node.js)',
    'Python',
    'REST (curl)',
    'accounts.json entry',
  ])
  await expect(code).toContainText(firstUid ?? '')
  await page.keyboard.press('Escape')
  await expect(code).toBeHidden()

  // Ages say the instant in a tooltip.
  await inspector(page).getByTestId('user-created').hover()
  await expect(page.locator('.kumo-tooltip-popup')).toContainText(/^Created .+ UTC$/)

  // Escape closes it, Enter opens the row again, ↓ moves it to the next.
  await page.keyboard.press('Escape')
  await expect(page).not.toHaveURL(/user=/)
  await rows(page).first().locator('td[data-column="providers"]').click()
  await expect(page).toHaveURL(/user=/)
  await page.keyboard.press('Escape')
  await expect(page).not.toHaveURL(/user=/)
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(new RegExp(`user=${encodeURIComponent(firstUid ?? '')}`))
  await page.keyboard.press('ArrowDown')
  await expect(page).toHaveURL(new RegExp(`user=${encodeURIComponent(secondUid ?? '')}`))
  await expect(inspector(page)).toContainText(secondUid ?? '')

  // Its calls and its messages are a link away, filtered to it.
  await expect(inspector(page).getByTestId('user-messages')).toHaveAttribute(
    'href',
    /\/console\/auth\/inbox\?.*q=uid%3A/,
  )
  await inspector(page).getByTestId('user-calls').click()
  await expect(page).toHaveURL(/\/console\/auth\/activity\?.*q=uid%3A/)
  await expect(page.getByTestId('auth-activity')).toBeVisible()
  expect(new URL(page.url()).searchParams.get('q')).toBe(`uid:${secondUid ?? ''}`)
})

test('U6 an edit keeps its draft through a sign-in, and a real change raises a banner', async ({
  page,
  engine,
}) => {
  const email = `edit-${stamp()}@journey.test`
  const user = await signUp(engine, { email })
  try {
    await page.goto(users(engine, { user: user.localId }))
    const name = inspector(page).getByTestId('field-display-name')
    await expect(name).toBeVisible()
    await name.fill('Draft name')
    await expect(inspector(page).getByTestId('unsaved-mark')).toBeVisible()

    // A sign-in changes when they last signed in: never a conflict.
    const reread = page.waitForResponse(
      (response) =>
        response.url().includes('/console/api/v1/auth/user?') &&
        response.url().includes(encodeURIComponent(user.localId)),
    )
    expect((await signIn(engine, { email, password: 'password-1' })).status).toBe(200)
    await reread
    await expect(inspector(page).getByTestId('user-conflict')).toHaveCount(0)
    await expect(name).toHaveValue('Draft name')

    // Someone renames them: that field's banner, and Use theirs takes it.
    await adminUpdate(engine, user.localId, { displayName: 'Their name' })
    const conflict = inspector(page).getByTestId('user-conflict')
    await expect(conflict).toBeVisible()
    await expect(conflict).toContainText('Their name')
    await conflict.getByTestId('use-theirs').click()
    await expect(conflict).toHaveCount(0)
    await expect(name).toHaveValue('Their name')
    await expect(inspector(page).getByTestId('unsaved-mark')).toHaveCount(0)
  } finally {
    await deleteAccounts(engine, [user.localId])
  }
})

test('U7 the claims editor checks as Firebase does, and the saved claims reach the rules', async ({
  page,
  engine,
}) => {
  const rule = await applyAdminsOnly(engine)
  const user = await signUp(engine, { email: `claims-${stamp()}@journey.test` })
  try {
    await page.goto(users(engine, { user: user.localId, tab: 'claims' }))
    const editor = inspector(page).getByTestId('claims-text')
    await expect(editor).toBeVisible()
    const save = inspector(page).getByTestId('save-user')

    const meter = inspector(page).getByTestId('claims-meter')
    // The meter's filled bar, which Kumo paints as a brand gradient.
    const bar = meter.locator('[role="meter"] [class*="transition-[width]"]')

    // Not JSON: Save is blocked with the parser's message.
    await pasteInto(page, editor, '{"admin": tru')
    await expect(inspector(page).getByTestId('claims-problem')).toContainText(/JSON/)
    await expect(save).toBeDisabled()
    await expect(inspector(page).getByTestId('save-blocked')).toBeVisible()
    await expect(meter).toContainText('not JSON yet')
    const quietPaint = await computed(bar, 'background-image')

    // A reserved key is marked where it is; the meter still measures the JSON.
    await pasteInto(page, editor, '{"iss": "me"}')
    await expect(editor.locator('.cm-lintRange-error')).toHaveText('"iss"')
    await expect(save).toBeDisabled()
    await expect(meter).toContainText('12 / 1,000 characters')

    // 950 characters with an é: amber, counted as Firebase counts.
    const note = `${'é'}${'x'.repeat(938)}`
    const text = JSON.stringify({ note })
    expect(text.length).toBe(950)
    await pasteInto(page, editor, text)
    await expect(meter).toHaveAttribute('data-tone', 'crowded')
    await expect(meter).toContainText('950 / 1,000 characters')
    // The bar itself changes colour, not only the attribute.
    expect(await computed(bar, 'background-image')).not.toBe(quietPaint)

    // A claim the token replaces is marked as shadowed.
    await pasteInto(page, editor, '{"email": "x", "admin": true}')
    await expect(editor.locator('.cm-lintRange-warning')).toHaveText('"email"')

    // Saved, with the token they produce on screen first.
    await pasteInto(page, editor, '{"admin": true}')
    await expect(inspector(page).getByTestId('token-preview-tree')).toContainText('admin')
    await expect(save).toBeEnabled()
    await save.click()
    await expect
      .poll(async () => (await userDetail(engine, user.localId))?.claims)
      .toEqual({
        admin: true,
      })

    // As them, Firestore reads what only an admin may read.
    await page.goto(
      `${engine.origin}/console/firestore?path=admins-only&doc=admins-only%2Fa1&as=${encodeURIComponent(user.localId)}`,
    )
    await expect(page.getByTestId('inspector').getByLabel('secret value')).toHaveValue(
      'only admins read this',
    )
  } finally {
    await deleteAccounts(engine, [user.localId])
    await rule.restore()
  }
})

test('U8 the password reveals, changes, and the old one stops working', async ({
  page,
  engine,
}) => {
  const email = `password-${stamp()}@journey.test`
  const user = await signUp(engine, { email, password: 'password-1' })
  try {
    await page.goto(users(engine, { user: user.localId }))
    const field = inspector(page).getByTestId('field-password')
    await field.getByTestId('password-masked-reveal').click()
    await expect(field.getByTestId('password-masked-value')).toHaveText('password-1')
    await field.getByTestId('change-password').click()
    await expect(field).toContainText('A new password revokes this user’s ID tokens')
    await field.getByTestId('new-password').fill('password-2')
    await field.getByTestId('set-password').click()
    await expect(field.getByTestId('new-password')).toHaveCount(0)
    const old = await signIn(engine, { email, password: 'password-1' })
    expect(old.status).toBe(400)
    expect(old.body.error?.message).toBe('INVALID_PASSWORD')
    expect((await signIn(engine, { email, password: 'password-2' })).status).toBe(200)
  } finally {
    await deleteAccounts(engine, [user.localId])
  }
})

test('U9 New user makes every kind of account, and explains a taken email', async ({
  page,
  engine,
}) => {
  const tag = stamp()
  const made: string[] = []
  const lookup = async (q: string) => engineOrder(engine, { q, limit: 5 })
  try {
    await page.goto(users(engine, { new: 'user' }))
    const dialog = page.getByTestId('create-user-dialog')
    await expect(dialog).toBeVisible()
    const kind = (label: string) => dialog.getByRole('tab', { name: label })

    // Email & password, then another with the dialog kept.
    await dialog.getByTestId('new-email').fill(`made-${tag}@journey.test`)
    await dialog.getByTestId('new-password').fill('password-1')
    await dialog.getByTestId('create-another').click()
    await expect.poll(() => lookup(`made-${tag}@journey.test`)).toHaveLength(1)
    made.push(...(await lookup(`made-${tag}@journey.test`)))
    await expect(dialog.getByTestId('new-email')).toHaveValue('')
    await expect(kind('Email & password')).toHaveAttribute('aria-selected', 'true')

    // The same email again is explained: no switch makes an email-and-password
    // account share it (One account per email is about other providers, S3).
    await dialog.getByTestId('new-email').fill(`made-${tag}@journey.test`)
    await dialog.getByTestId('new-password').fill('password-1')
    await dialog.getByTestId('create-user').click()
    await expect(dialog.getByTestId('create-user-error')).toContainText(
      'Another user already has this email',
    )
    await expect(dialog.getByTestId('create-user-error')).toContainText('whatever the settings')

    // Phone.
    await kind('Phone').click()
    const phone = `+1555${String(Date.now()).slice(-7)}`
    await dialog.getByTestId('new-phone').fill(phone)
    await dialog.getByTestId('create-another').click()
    await expect.poll(() => lookup(`phone:${phone}`)).toHaveLength(1)
    made.push(...(await lookup(`phone:${phone}`)))
    // The engine has the user before the page has its answer, and the form
    // empties itself on the answer: wait for that before typing the next.
    await expect(dialog.getByTestId('new-phone')).toHaveValue('')

    // Federated.
    await kind('Federated').click()
    await dialog.getByTestId('new-provider-id').fill('github.com')
    await dialog.getByTestId('new-email').fill(`fed-${tag}@journey.test`)
    await dialog.getByTestId('create-another').click()
    await expect.poll(() => lookup(`fed-${tag}@journey.test`)).toHaveLength(1)
    made.push(...(await lookup(`fed-${tag}@journey.test`)))
    await expect(dialog.getByTestId('new-email')).toHaveValue('')

    // A custom uid.
    await kind('Custom uid').click()
    await dialog.getByTestId('new-uid').fill(`custom-${tag}`)
    await dialog.getByTestId('new-email').fill(`custom-${tag}@journey.test`)
    await dialog.getByTestId('create-another').click()
    await expect.poll(async () => (await userDetail(engine, `custom-${tag}`)) !== null).toBe(true)
    made.push(`custom-${tag}`)
    await expect(dialog.getByTestId('new-uid')).toHaveValue('')

    // Anonymous, the way an app makes one: a client sign-up. Create closes
    // the dialog and opens the new user.
    await kind('Anonymous').click()
    const signups = page.waitForRequest(
      (request) =>
        request.method() === 'POST' &&
        request.url().includes('/accounts:signUp') &&
        request.url().includes('key='),
    )
    await dialog.getByTestId('create-user').click()
    await signups
    await expect(dialog).toBeHidden()
    await expect(page).not.toHaveURL(/new=user/)
    await expect(page).toHaveURL(/user=/)
    const anonymous = new URL(page.url()).searchParams.get('user') ?? ''
    made.push(anonymous)

    const providers = async (uid: string) => (await userDetail(engine, uid))?.row.providers
    expect(await providers(made[0] ?? '')).toEqual(['password'])
    expect(await providers(made[1] ?? '')).toEqual(['phone'])
    expect(await providers(made[2] ?? '')).toEqual(['github.com'])
    expect((await userDetail(engine, anonymous))?.row.anonymous).toBe(true)
  } finally {
    await deleteAccounts(engine, made.filter(Boolean))
  }
})

test('U10 bulk changes are engine jobs that re-attach after a reload and stop on Cancel', async ({
  page,
  engine,
}) => {
  test.setTimeout(240_000)
  await inScratchTenant(engine, async ({ id: tenant }) => {
    await batchCreate(engine, sampleShaped(2_000, 10), tenant)
    await page.goto(users(engine, { tenant }))
    await expect(countText(page)).toHaveText('2,000 users')
    const watch = watchRoutes(page, [
      { method: 'POST', path: '/auth/users:disable' },
      { method: 'POST', path: '/auth/users:setClaims' },
      { method: 'GET', path: '/jobs' },
    ])

    // Tick three, Disable: one job, started at once; the chips come live.
    const ticked = await rows(page).evaluateAll((trs) =>
      trs.slice(0, 3).map((tr) => tr.dataset.key ?? ''),
    )
    for (const uid of ticked) await rowOf(page, uid).getByRole('checkbox').click()
    await expect(page.getByTestId('users-selection')).toContainText('3')
    const disabled = page.waitForResponse((response) => response.url().includes('/users:disable'))
    await page.getByTestId('bulk-disable').click()
    expect((await disabled).status()).toBe(202)
    for (const uid of ticked)
      await expect(rowOf(page, uid).getByTestId('status-chip')).toHaveText('disabled')
    expect(watch.of('POST', '/auth/users:disable')).toHaveLength(1)
    await page.keyboard.press('Escape')

    // Enough users that the next jobs run long enough to be watched.
    await batchCreate(engine, sampleShaped(18_000, 11), tenant)
    await expect(countText(page)).toHaveText('20,000 users')

    // Every match of a filter, Claims (merge): a dry run, then the job.
    await filterInput(page).fill('is:sample')
    await expect(page).toHaveURL(/q=is%3Asample/)
    await expect(countText(page)).toHaveText('20,000 users')
    await rows(page).first().getByRole('checkbox').click()
    await page.getByTestId('select-everything').click()
    await page.getByTestId('bulk-claims').click()
    const claims = page.getByTestId('bulk-claims-dialog')
    await expect(claims).toBeVisible()
    // The engine's own count comes first, as the claims are typed (a dry run).
    const dryRun = page.waitForResponse(
      (response) =>
        response.url().includes('/users:setClaims') &&
        response.request().postDataJSON()?.dryRun === true &&
        JSON.stringify(response.request().postDataJSON()?.claims) === '{"cohort":"journey"}',
    )
    await pasteInto(page, claims.getByTestId('bulk-claims-text'), '{"cohort": "journey"}')
    expect((await dryRun).status()).toBe(200)
    await expect(claims).toContainText('20,000')
    const started = page.waitForResponse(
      (response) =>
        response.url().includes('/users:setClaims') &&
        response.request().postDataJSON()?.dryRun === false,
    )
    await claims.getByTestId('bulk-claims-go').click()
    const job = (await (await started).json()) as { id: string }
    expect((await started).status()).toBe(202)
    // One dry run per settled claims text, then the job.
    expect(watch.of('POST', '/auth/users:setClaims').at(-1)?.postDataJSON()?.dryRun).toBe(false)

    // A reload while it runs finds it again through the section's jobs.
    const listed = page.waitForResponse(
      (response) =>
        response.url().includes('/console/api/v1/jobs?') && response.url().includes('section=auth'),
    )
    await page.reload()
    await listed
    await expect(page.getByTestId('auth-job').first()).toBeVisible()
    await expect(page.getByTestId('auth-job').first()).toContainText(/of 20,000/)
    await expect(page.getByTestId('auth-job')).toHaveCount(0, { timeout: 60_000 })
    const finished = await consoleJson<{ state: string; done: number }>(engine, `/jobs/${job.id}`)
    expect(finished.state).toBe('done')
    expect(await usersCount(engine, { tenant, q: 'claim:cohort' })).toBe(20_000)

    // A change that destroys nothing asks with the engine's numbers, and its
    // button is the primary one, without the bin; Cancel sends nothing.
    await rows(page).first().getByRole('checkbox').click()
    await page.getByTestId('select-everything').click()
    await page.getByTestId('bulk-verify').click()
    const verify = page.getByTestId('bulk-confirm')
    await expect(verify).toContainText('Mark 20,000 users as verified')
    await expect(page.getByTestId('bulk-confirm-confirm')).toHaveText(
      'Mark 20,000 users as verified',
    )
    await expect(page.getByTestId('bulk-confirm-confirm').locator('svg')).toHaveCount(0)
    await page.getByTestId('bulk-confirm-cancel').click()
    await expect(verify).toBeHidden()

    // Delete every match: the functions it runs, the number typed, then
    // Cancel while it runs: the chunks done stay deleted.
    await page.goto(users(engine, { tenant }))
    await expect(countText(page)).toHaveText('20,000 users')
    await rows(page).first().getByRole('checkbox').click()
    await page.getByTestId('select-everything').click()
    await page.getByTestId('bulk-delete-button').click()
    const confirm = page.getByTestId('bulk-delete')
    await expect(confirm).toContainText('Deletes 20,000 users')
    const triggers = await fetch(`${engine.origin}/console/api/v1/functions/triggers?service=auth`)
    if (triggers.ok) await expect(confirm).toContainText('onUserDeleted')
    else await expect(confirm).not.toContainText('onUserDeleted')
    await confirm.getByRole('checkbox', { name: 'Delete without triggers' }).click()
    await confirm.getByRole('textbox').fill('20,000')
    const deleting = page.waitForResponse(
      (response) =>
        response.url().includes('/users:delete') &&
        response.request().postDataJSON()?.dryRun === false,
    )
    await confirm.getByRole('button', { name: /^Delete/ }).click()
    const deleteJob = (await (await deleting).json()) as { id: string }
    await confirm.getByRole('button', { name: 'Cancel' }).click()
    await expect
      .poll(
        async () => (await consoleJson<{ state: string }>(engine, `/jobs/${deleteJob.id}`)).state,
      )
      .toBe('cancelled')
    const ended = await consoleJson<{ done: number; total: number }>(
      engine,
      `/jobs/${deleteJob.id}`,
    )
    expect(ended.done).toBeGreaterThan(0)
    expect(ended.done).toBeLessThan(ended.total)
    const left = await usersCount(engine, { tenant })
    expect(left).toBe(20_000 - ended.done)
    await page.keyboard.press('Escape')
    await expect(countText(page)).toHaveText(`${left.toLocaleString('en-US')} users`)
    watch.stop()
  })
})

test('U11 an export loads back with one upload and a small import request', async ({
  page,
  engine,
}) => {
  test.setTimeout(180_000)
  await inScratchTenant(engine, async ({ id: tenant }) => {
    await page.goto(users(engine, { tenant, new: 'sample' }))
    const sample = page.getByTestId('sample-users-dialog')
    await sample.getByRole('combobox', { name: 'How many sample users' }).click()
    await page.getByRole('option', { name: '1,000' }).click()
    await sample.getByTestId('sample-go').click()
    await expect(sample.getByTestId('sample-show')).toBeVisible({ timeout: 60_000 })
    await sample.getByTestId('sample-show').click()
    const before = await usersCount(engine, { tenant })
    expect(before).toBe(1_000)
    await page.goto(users(engine, { tenant }))
    await expect(countText(page)).toHaveText('1,000 users')

    // Every user, as the emulator's accounts.json.
    await page.getByTestId('users-export').click()
    const exportAll = page.getByTestId('export-users')
    await expect(exportAll).toBeVisible()
    const all = page.waitForEvent('download')
    await exportAll.getByTestId('export-users-confirm').click()
    const whole = await all
    expect(new URL(whole.url()).searchParams.getAll('uid')).toEqual([])
    const file = await readDownload(whole)
    const exported = JSON.parse(file) as { users: { localId: string }[] }
    expect(exported.users).toHaveLength(1_000)

    // Three ticked: one request naming the three.
    const three = await rows(page).evaluateAll((trs) =>
      trs.slice(0, 3).map((tr) => tr.dataset.key ?? ''),
    )
    for (const uid of three) await rowOf(page, uid).getByRole('checkbox').click()
    await page.getByTestId('bulk-export').click()
    await expect(page.getByTestId('export-users-target')).toContainText('The 3 ticked users')
    const selected = page.waitForEvent('download')
    await page.getByTestId('export-users-confirm').click()
    const download = await selected
    // One read, naming the three: the browser saves straight from the engine.
    const asked = new URL(download.url())
    expect(asked.pathname).toBe('/console/api/v1/auth/users:export')
    expect(asked.searchParams.getAll('uid').toSorted()).toEqual(three.toSorted())
    const picked = JSON.parse(await readDownload(download)) as { users: { localId: string }[] }
    expect(picked.users.map((user) => user.localId).toSorted()).toEqual(three.toSorted())
    await page.keyboard.press('Escape')

    // Everyone goes, without triggers; the file brings them back.
    await page.keyboard.press('ControlOrMeta+k')
    await page.getByTestId('palette-input').fill(`Delete all users in tenant ${tenant}`)
    await page
      .getByRole('option', { name: new RegExp(`Delete all users in tenant ${tenant}`) })
      .click()
    const named = page.getByTestId('named-delete')
    await expect(named).toBeVisible()
    await expect(named.getByRole('checkbox', { name: 'Delete without triggers' })).toBeChecked({
      checked: false,
    })
    await named.getByRole('checkbox', { name: 'Delete without triggers' }).click()
    await named.getByRole('textbox').fill('1,000')
    await named.getByRole('button', { name: /^Delete/ }).click()
    await expect.poll(() => usersCount(engine, { tenant })).toBe(0)
    await page.keyboard.press('Escape')

    const uploads: string[] = []
    const imports: number[] = []
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname
      if (request.method() === 'POST' && path === '/console/api/v1/auth/imports') uploads.push(path)
      if (request.method() === 'POST' && path === '/console/api/v1/auth/users:import')
        imports.push((request.postData() ?? '').length)
    })
    await page.goto(users(engine, { tenant, new: 'import' }))
    const dialog = page.getByTestId('import-users-dialog')
    await dialog.getByTestId('import-file').setInputFiles({
      name: 'accounts.json',
      mimeType: 'application/json',
      buffer: Buffer.from(file),
    })
    await expect(dialog.getByTestId('import-recognised')).toBeVisible()
    await dialog.getByTestId('import-check').click()
    await expect(dialog.getByTestId('import-preview')).toContainText('1,000')
    await dialog.getByTestId('import-go').click()
    await expect.poll(() => usersCount(engine, { tenant }), { timeout: 60_000 }).toBe(before)
    expect(uploads).toHaveLength(1)
    expect(imports.length).toBeGreaterThan(0)
    for (const bytes of imports) expect(bytes).toBeLessThan(1_024)
  })
})

test('U12 sample users come a thousand at most, ten thousand scroll smoothly, and Delete sample users takes them', async ({
  page,
  engine,
}) => {
  test.setTimeout(300_000)
  const seeded = await usersCount(engine)
  await inScratchTenant(engine, async ({ id: tenant }) => {
    await page.goto(users(engine, { tenant, new: 'sample' }))
    const sample = page.getByTestId('sample-users-dialog')
    await sample.getByRole('combobox', { name: 'How many sample users' }).click()
    await expect(page.getByRole('option')).toHaveText(['10', '100', '1,000'])
    await page.getByRole('option', { name: '1,000' }).click()
    await sample.getByTestId('sample-go').click()
    await expect(sample.getByTestId('sample-show')).toBeVisible({ timeout: 120_000 })
    await sample.getByTestId('sample-show').click()
    await expect(page).toHaveURL(/q=is%3Asample/)
    expect(await usersCount(engine, { tenant, q: 'is:sample' })).toBe(1_000)
    // Nine thousand more of the same shape, as the Admin SDK would make them.
    await batchCreate(engine, sampleShaped(9_000, 12), tenant)
    expect(await usersCount(engine, { tenant })).toBe(10_000)
    await expect(countText(page)).toHaveText('10,000 users')

    // A reader's scroll through the first pages, a frame sampler running:
    // a wheel step each frame, the next pages read as they come into view.
    const grid = scroller(page)
    const pages = watchRoutes(page, [{ method: 'GET', path: '/auth/users' }])
    await grid.hover()
    const frames = await framesDuring(page, async () => {
      for (let step = 0; step < 120; step += 1) {
        await page.mouse.wheel(0, 120)
        await nextFrame(page)
      }
    })
    pages.stop()
    expect(pages.seen.length, 'pages read while scrolling').toBeGreaterThan(0)
    // A frame budget measures the machine as much as the page (a CI runner
    // paints in software): held on an opted-in perf run, as the @perf
    // journeys are, and recorded on every run.
    const frame = p95(frames)
    test.info().annotations.push({
      type: 'frame p95',
      description: `${frame.toFixed(1)} ms over ${frames.length} frames`,
    })
    if (process.env.FIRENOOK_PERF === '1')
      expect(frame, `p95 frame over ${frames.length} frames`).toBeLessThanOrEqual(25)
    expect(await rows(page).count()).toBeLessThanOrEqual(80)

    // Then to the end, a page of rows at a time: never more than the view's
    // rows in the DOM, whichever page the window holds.
    const lastRow = () =>
      rows(page).evaluateAll((trs) => Number(trs.at(-1)?.getAttribute('aria-rowindex') ?? 0))
    let reached = await lastRow()
    while (reached < 10_001) {
      const before = reached
      // Wheel again until the rows move on: a wheel that lands while a page
      // is on its way only reaches the end of what is loaded.
      await expect
        .poll(
          async () => {
            await page.mouse.wheel(0, 50_000)
            return lastRow()
          },
          { timeout: 30_000 },
        )
        .toBeGreaterThan(before)
      reached = await lastRow()
      expect(await rows(page).count()).toBeLessThanOrEqual(80)
    }
    await expect(page.getByTestId('users-grid').locator('tr[aria-rowindex="10001"]')).toBeVisible()

    // Delete sample users removes exactly them.
    await page.keyboard.press('ControlOrMeta+k')
    await page.getByTestId('palette-input').fill('Delete sample users')
    await page.getByRole('option', { name: /Delete sample users/ }).click()
    const named = page.getByTestId('named-delete')
    await expect(named).toContainText('10,000')
    await expect(named.getByRole('checkbox', { name: 'Delete without triggers' })).toBeChecked()
    await named.getByRole('textbox').fill('10,000')
    await named.getByRole('button', { name: /^Delete/ }).click()
    await expect.poll(() => usersCount(engine, { tenant }), { timeout: 60_000 }).toBe(0)
  })
  expect(await usersCount(engine)).toBe(seeded)
})

test('U13 sign in as copies tokens with the account’s claims, factor and tenant', async ({
  page,
  engine,
}) => {
  const rule = await applyAdminsOnly(engine)
  const claimed = await signUp(engine, { email: `y-${stamp()}@claims.test` })
  try {
    const copyHeader = async () => {
      await inspector(page).getByTestId('sign-in-as').click()
      await page.getByTestId('copy-authorization').click()
      await expect.poll(() => readClipboard(page)).toMatch(/^Authorization: Bearer ey/)
      return payloadOf((await readClipboard(page)).replace(/^Authorization: Bearer /, ''))
    }
    // A tenant user's token names the tenant.
    await page.goto(users(engine, { tenant: 'acme', user: 'acme-2' }))
    await expect(inspector(page)).toContainText('acme-2')
    const tenantToken = await copyHeader()
    expect(tenantToken.sub).toBe('acme-2')
    expect((tenantToken.firebase as { tenant: string }).tenant).toBe('acme')

    // The MFA user's carries its second factor.
    await page.evaluate(() =>
      (
        globalThis as unknown as {
          navigator: { clipboard: { writeText(text: string): Promise<void> } }
        }
      ).navigator.clipboard.writeText(''),
    )
    await page.goto(users(engine, { user: 'mfa-ada' }))
    const mfaToken = await copyHeader()
    expect((mfaToken.firebase as { sign_in_second_factor: string }).sign_in_second_factor).toBe(
      'phone',
    )

    // The admin opens Firestore as themself: the rule that reads the claim allows.
    await page.goto(users(engine, { user: 'admin-1' }))
    await inspector(page).getByTestId('sign-in-as').click()
    await page.getByTestId('open-firestore-as').click()
    await expect(page).toHaveURL(/\/console\/firestore\?.*as=admin-1/)
    await expect(page.getByTestId('view-as')).toContainText('admin@example.test')
    await page.goto(
      `${engine.origin}/console/firestore?path=admins-only&doc=admins-only%2Fa1&as=admin-1`,
    )
    await expect(page.getByTestId('inspector').getByLabel('secret value')).toHaveValue(
      'only admins read this',
    )
    await page.goto(
      `${engine.origin}/console/firestore?path=admins-only&doc=admins-only%2Fa1&as=mfa-ada`,
    )
    await expect(page.getByTestId('inspector')).toContainText(/denied|permission|insufficient/i)

    // beforeSignIn's claims in the token; the account itself unchanged. (Its
    // sign-up already ran beforeSignIn, which stored `tester`; claims of its
    // own make the mint's leaving them alone visible.)
    await adminUpdate(engine, claimed.localId, { customAttributes: '{"plan":"pro"}' })
    await page.goto(users(engine, { user: claimed.localId }))
    await expect(inspector(page)).toContainText(claimed.localId)
    await inspector(page).getByTestId('sign-in-as').click()
    await page.getByTestId('run-before-sign-in').click()
    await page.getByTestId('copy-id-token').click()
    await expect.poll(() => readClipboard(page)).toMatch(/^ey/)
    const hooked = payloadOf(await readClipboard(page))
    expect(hooked.tester).toBe(true)
    expect(hooked.session).toBe('journey')
    // The function's claims replace the stored ones in that token, as a real
    // sign-in's would; the account keeps its own.
    expect(hooked.plan).toBeUndefined()
    expect((await userDetail(engine, claimed.localId))?.claims).toEqual({ plan: 'pro' })
  } finally {
    await deleteAccounts(engine, [claimed.localId])
    await rule.restore()
  }
})

test('U15 the keyboard, the row menu and ⌘K reach the same actions', async ({ page, engine }) => {
  await page.goto(users(engine))
  await expect(rows(page).first()).toBeVisible()

  // `/` is the filter (its completions open); Escape closes them, then
  // leaves the field; `n` is New user.
  await page.keyboard.press('/')
  await expect(filterInput(page)).toBeFocused()
  await expect(page.getByTestId('users-filter-completions')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('users-filter-completions')).toBeHidden()
  await expect(filterInput(page)).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(filterInput(page)).not.toBeFocused()
  await page.keyboard.press('n')
  await expect(page).toHaveURL(/new=user/)
  await expect(page.getByTestId('create-user-dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page).not.toHaveURL(/new=user/)

  // ↓ to a row, Space ticks it, Delete asks to delete it.
  await scroller(page).focus()
  await page.keyboard.press('ArrowDown')
  const cursor = page.getByTestId('users-grid').locator('tr[data-cursor]')
  await expect(cursor).toHaveCount(1)
  const uid = (await cursor.getAttribute('data-key')) ?? ''
  await page.keyboard.press('Space')
  await expect(page.getByTestId('users-selection')).toContainText('1')
  await page.keyboard.press('Delete')
  await expect(page.getByTestId('bulk-delete')).toBeVisible()
  await page.getByTestId('bulk-delete').getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByTestId('bulk-delete')).toBeHidden()
  // Escape clears the ticks once nothing above the page has the key.
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('users-selection')).toHaveCount(0)

  // Shift+F10, a right-click and ⌘K list the same menu, in one order.
  const menuItems = async () => {
    const items = page.getByTestId('row-menu').getByRole('menuitem')
    await expect(items.first()).toBeVisible()
    return (await items.allInnerTexts()).map(firstLine)
  }
  await scroller(page).focus()
  await page.keyboard.press('Shift+F10')
  const fromKeys = await menuItems()
  expect(fromKeys).toContain('Delete…')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('row-menu')).toBeHidden()
  await rowOf(page, uid).locator('td[data-column="providers"]').click({ button: 'right' })
  expect(await menuItems()).toEqual(fromKeys)
  // ⌘K offers what can run: the menu's items less those it shows disabled.
  const runnable = (
    await page
      .getByTestId('row-menu')
      .getByRole('menuitem')
      .evaluateAll((items) =>
        items
          .filter((item) => item.getAttribute('aria-disabled') !== 'true')
          .map((item) => item.textContent ?? ''),
      )
  ).map((text) => fromKeys.find((label) => text.startsWith(label)) ?? text)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('row-menu')).toBeHidden()
  await page.keyboard.press('ControlOrMeta+k')
  const group = page.getByRole('group', { name: uid })
  await expect(group.getByRole('option').first()).toBeVisible()
  expect((await group.getByRole('option').allInnerTexts()).map(firstLine)).toEqual(runnable)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('palette-input')).toBeHidden()

  // ⌘K finds users by what the engine indexes, tenants included.
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByTestId('palette-input').fill('ada@example')
  await expect(page.getByRole('option', { name: /ada@example\.test/ }).first()).toBeVisible()
  await page.getByTestId('palette-input').fill('staff3@acme')
  const tenantUser = page.getByRole('option', { name: /staff3@acme\.example\.test/ })
  await expect(tenantUser).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/tenant=acme/)
  await expect(page).toHaveURL(/user=acme-3/)
  await expect(inspector(page)).toContainText('acme-3')
})

for (const scheme of ['light', 'dark'] as const)
  test(`U16 the Users page holds the console’s look (${scheme})`, async ({ page, engine }) => {
    await page.emulateMedia({ colorScheme: scheme })
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(users(engine))
    await expect(rows(page).nth(2)).toBeVisible()
    const toward = scheme === 'light' ? -1 : 1
    const steps: Record<string, number> = {}
    const measure = async (name: string, control: Locator) => {
      await page.mouse.move(720, 890)
      await settled(control)
      const rest = await paintOf(control)
      await control.hover()
      await settled(control)
      steps[name] = toward * ((await paintOf(control)) - rest)
    }
    const facet = page.getByTestId('user-facets').getByTestId('facet').first()
    await measure('facet', facet.locator('button').first())
    await measure(
      'sort header',
      page.locator('th[data-column="created"]').getByTestId('sort-header'),
    )
    await measure('columns menu', page.getByTestId('columns-menu'))
    await measure('open, white row', rows(page).nth(0).getByTestId('open-row'))
    await measure('open, zebra row', rows(page).nth(1).getByTestId('open-row'))
    await measure('row menu', rows(page).nth(2).getByTestId('row-menu-button'))
    const chipped = rows(page).filter({
      has: page.getByTestId('status-chip').filter({ hasText: /^claims/ }),
    })
    await measure(
      'status chip',
      chipped
        .first()
        .getByTestId('status-chip')
        .filter({ hasText: /^claims/ }),
    )
    for (const [name, step] of Object.entries(steps))
      expect
        .soft(step, `${name}: ${scheme === 'light' ? 'darker' : 'lighter'} on hover`)
        .toBeGreaterThanOrEqual(6)

    // No ring is cut by what clips it, at rest or along a Tab walk.
    expect(await cutRings(page)).toEqual([])
    await page.getByTestId('new-users-menu').focus()
    for (let step = 0; step < 6; step += 1) {
      await page.keyboard.press('Tab')
      expect(await cutRings(page, true), `Tab ${step + 1}`).toEqual([])
    }
    // The walk passed through the filter without filling it.
    await expect(page.getByTestId('users-filter-input')).toHaveValue('')

    // Row one and row two keep their controls apart at every width. The
    // walk may have left focus in the filter, whose completions open over
    // the page: nothing is focused or open while they are measured.
    await page.locator('body').evaluate((body) => {
      const focused = body.ownerDocument.activeElement as { blur?: () => void } | null
      focused?.blur?.()
    })
    await page.mouse.move(720, 890)
    await expect(page.getByTestId('users-filter-completions')).toHaveCount(0)
    await expect(page.locator('.kumo-tooltip-popup')).toHaveCount(0)
    for (const width of [1440, 1280, 1152, 1024]) {
      await page.setViewportSize({ width, height: 900 })
      for (const id of ['new-users-menu', 'users-filter-input', 'users-count']) {
        const control = page.getByTestId(id)
        await settled(control)
        expect(await paintedAtItsOwnCentre(control), `${id} at ${width}px`).toBe(true)
      }
    }

    // Panel labels are sentence case, never capitals.
    const capitals = await page
      .getByTestId('users-panel')
      .locator('span')
      .evaluateAll((spans) =>
        spans
          .filter(
            (span) =>
              span.ownerDocument.defaultView!.getComputedStyle(span).textTransform === 'uppercase',
          )
          .map((span) => span.textContent),
      )
    expect(capitals).toEqual([])
  })

// Last in the file: once an app has used demo-other, the shell says so on
// every page of this engine.
test('U14 another project’s users are a click away, and back', async ({ page, engine }) => {
  const other = 'demo-other'
  const email = `other-${stamp()}@journey.test`
  await page.goto(users(engine))
  await expect(rows(page).first()).toBeVisible()
  // Straight to the Auth emulator's own port, as an app configured with
  // another project id calls it.
  const response = await fetch(
    `http://127.0.0.1:${engine.ports.auth}${toolkit('accounts', { project: other })}`,
    {
      method: 'POST',
      headers: { authorization: 'Bearer owner', 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'password-1' }),
    },
  )
  expect(response.status).toBe(200)
  const created = { body: (await response.json()) as { localId: string } }
  const banner = page.getByTestId('banner-foreign-project')
  await expect(banner).toBeVisible()
  await expect(banner).toContainText(other)
  await expect(page.getByTestId('auth-users').getByTestId('banner-foreign-project')).toHaveCount(0)
  await page.getByTestId('foreign-show').click()
  await expect(page).toHaveURL(new RegExp(`project=${other}`))
  await expect(rowOf(page, created.body.localId)).toBeVisible()
  await expect(countText(page)).toHaveText(
    `${await usersCount(engine, { project: other })} user${(await usersCount(engine, { project: other })) === 1 ? '' : 's'}`,
  )
  await page.goto(`${engine.origin}/console/auth/activity?project=${other}`)
  await expect(
    page.getByTestId('activity-feed').getByTestId('feed-row').filter({ hasText: email }),
  ).toBeVisible()
  await page.goto(users(engine))
  await expect(page).not.toHaveURL(/project=/)
  await expect(rowOf(page, created.body.localId)).toHaveCount(0)
})
