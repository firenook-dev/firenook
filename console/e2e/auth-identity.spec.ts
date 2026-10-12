import type { Page, Request } from '@playwright/test'
import { expect, test } from './fixtures'
import { applyAdminsOnly, deleteAccounts, payloadOf, signUp } from './support/auth'
import { liveRequests } from './support/live'

// Reading as someone (auth spec §9.3, X1 and X4–X6; R1): the console's one
// identity path (`lib/identity.ts`, the IdentityPicker) against Auth's
// engine — real tokens minted for real accounts, with their claims and
// tenant, a synthetic one for an id Auth does not know, re-minted before
// they expire; and every tab of a browser on one live connection. X2 and X3
// stop or narrow an engine, so they are in `auth-engines.spec.ts`.

const stamp = () => Date.now().toString(36)

/** The distinct entries of a list, in order. */
const distinct = (reads: string[]) => [...new Set(reads)].toSorted()

/** Whether a request is a Firestore read through the console's mount, as the app makes it. */
const isFirestoreRead = (request: Request) =>
  request.url().includes('/console/api/v1/firestore/v1/projects/') &&
  !request.url().endsWith(':commit')

/** The bearer token the next Firestore read that runs as someone carries. */
async function nextReadToken(page: Page, read: () => Promise<unknown>) {
  const [asked] = await Promise.all([
    page.waitForRequest(
      async (request) =>
        isFirestoreRead(request) &&
        ((await request.headerValue('authorization')) ?? '').startsWith('Bearer ey'),
    ),
    read(),
  ])
  return ((await asked.headerValue('authorization')) ?? '').replace(/^Bearer /, '')
}

test('X1 viewing as the admin reads what the admin rule allows, found by the engine', async ({
  page,
  engine,
}) => {
  const rule = await applyAdminsOnly(engine)
  try {
    const searches: URL[] = []
    const queried: string[] = []
    page.on('request', (request) => {
      const url = new URL(request.url())
      if (url.pathname === '/console/api/v1/auth/identities') searches.push(url)
      if (url.pathname.endsWith('accounts:query')) queried.push(url.pathname)
    })
    // As the owner, nothing; the rule denies everyone else but an admin.
    await page.goto(`${engine.origin}/console/firestore?path=admins-only`)
    await expect(page.getByTestId('grid-row').first()).toBeVisible()
    await page.goto(
      `${engine.origin}/console/firestore?path=admins-only&doc=admins-only%2Fa1&as=u_k65eq%3Aada%40example.test`,
    )
    await expect(page.getByTestId('inspector')).toContainText(/denied|permission|insufficient/i)

    // The picker asks the engine, once per settled search, across tenants.
    await page.getByTestId('view-as').click()
    const search = page.getByTestId('view-as-search')
    const settled = page.waitForRequest(
      (request) =>
        new URL(request.url()).pathname === '/console/api/v1/auth/identities' &&
        new URL(request.url()).searchParams.get('q') === 'admin@',
    )
    await search.pressSequentially('admin@', { delay: 30 })
    await settled
    const admin = page.getByTestId('view-as-user').filter({ hasText: 'admin@example.test' })
    await expect(admin).toBeVisible()
    await expect(page.getByTestId('view-as-user')).toHaveCount(1)
    const asked = searches.map((url) => url.searchParams.get('q') ?? '')
    expect(asked.filter((q) => q !== '')).toEqual(['admin@'])
    for (const url of searches) expect(url.searchParams.has('tenant')).toBe(false)
    await admin.click()
    await expect(page).toHaveURL(/as=admin-1/)
    await expect(page.getByTestId('inspector').getByLabel('secret value')).toHaveValue(
      'only admins read this',
    )
    expect(queried).toEqual([])
  } finally {
    await rule.restore()
  }
})

test('X4 an id Auth does not know reads with a synthetic token, and says so', async ({
  page,
  engine,
}) => {
  const minted = page.waitForResponse((response) =>
    response.url().endsWith('/console/api/v1/auth/tokens'),
  )
  await page.goto(`${engine.origin}/console/firestore?path=products&as=nobody-123`)
  const answer = await minted
  expect(answer.status()).toBe(404)
  expect(((await answer.json()) as { error: { code: string } }).error.code).toBe('not-found')
  const picker = page.getByTestId('view-as')
  await expect(picker).toContainText('nobody-123')
  await expect(picker.getByLabel('Not an Auth user: synthetic token')).toBeVisible()
  // Public data loads as that uid.
  await expect(page.getByTestId('grid-row').first()).toBeVisible()
  await picker.click()
  await expect(page.getByTestId('view-as-synthetic')).toContainText(
    'Not an Auth user: synthetic token',
  )
})

test('X5 a token near its end is minted again once, and nothing is read again for it', async ({
  browser,
  engine,
}) => {
  /**
   * Opens Ada's document as `as` (the owner when absent), lets 56 minutes
   * pass on the page's clock, then opens her orders: the Firestore reads and
   * token mints that navigation makes.
   */
  const run = async (as?: string) => {
    const context = await browser.newContext()
    const page = await context.newPage()
    await page.clock.install()
    const mints: string[] = []
    const reads: string[] = []
    const tokens: string[] = []
    let counting = false
    page.on('request', (request) => {
      if (request.url().endsWith('/console/api/v1/auth/tokens') && request.method() === 'POST')
        mints.push(request.postData() ?? '')
      else if (counting && isFirestoreRead(request)) {
        const url = new URL(request.url())
        reads.push(`${request.method()} ${url.pathname}${url.search} ${request.postData() ?? ''}`)
        const header = request.headers().authorization
        if (header?.startsWith('Bearer ey')) tokens.push(header.slice('Bearer '.length))
      }
    })
    const identity = as ? `&as=${encodeURIComponent(as)}` : ''
    await page.goto(`${engine.origin}/console/firestore?path=users&doc=users%2Fu_k65eq${identity}`)
    const inspector = page.getByTestId('inspector')
    await expect(inspector.getByLabel('displayName value')).toHaveValue('Ada Lovelace')
    const before = mints.length
    await page.clock.fastForward('56:00')
    counting = true
    await inspector.getByText('orders').click()
    await expect(page).toHaveURL(/path=users%2Fu_k65eq%2Forders/)
    await expect(page.getByTestId('grid-row').first()).toBeVisible()
    return { page, context, reads, before, mints, tokens }
  }
  // The owner holds no token: what that navigation reads after 56 minutes.
  const owner = await run()
  await expect.poll(() => distinct(owner.reads).length).toBeGreaterThanOrEqual(4)
  const expected = distinct(owner.reads)
  await owner.context.close()

  // Ada's token is within its last five minutes: minted again once, and
  // what is read is what the owner's navigation reads, nothing besides.
  const ada = await run('u_k65eq:ada@example.test')
  expect(ada.before).toBe(1)
  await expect.poll(() => distinct(ada.reads).length).toBeGreaterThanOrEqual(expected.length)
  expect(distinct(ada.reads)).toEqual(expected)
  expect(ada.mints).toEqual(['{"uid":"u_k65eq"}', '{"uid":"u_k65eq"}'])
  // Every read after it carried her token.
  expect(ada.tokens.length).toBeGreaterThan(0)
  for (const token of ada.tokens) expect(payloadOf(token).sub).toBe('u_k65eq')
  await ada.context.close()
})

test('X6 viewing as a tenant user reads with that tenant’s token', async ({ page, engine }) => {
  await page.goto(`${engine.origin}/console/firestore?path=products`)
  await expect(page.getByTestId('grid-row').first()).toBeVisible()
  await page.getByTestId('view-as').click()
  await page.getByTestId('view-as-search').fill('staff1@acme')
  const staff = page.getByTestId('view-as-user').filter({ hasText: 'staff1@acme.example.test' })
  await expect(staff).toBeVisible()
  await expect(staff).toContainText('acme')
  const token = await nextReadToken(page, () => staff.click())
  await expect(page).toHaveURL(/as=acme(%7C|\|)acme-1/)
  const payload = payloadOf(token)
  expect(payload.sub).toBe('acme-1')
  expect((payload.firebase as { tenant: string }).tenant).toBe('acme')
})

test('R1 three tabs share one live connection, and each still hears Auth', async ({
  context,
  engine,
}) => {
  const live = liveRequests(context)
  const users = await context.newPage()
  await users.goto(`${engine.origin}/console/auth`)
  await expect(users.getByTestId('users-grid').getByTestId('data-row').first()).toBeVisible()
  const activity = await context.newPage()
  await activity.goto(`${engine.origin}/console/auth/activity`)
  await expect(activity.getByTestId('activity-feed').getByTestId('feed-row').first()).toBeVisible()
  const firestore = await context.newPage()
  await firestore.goto(`${engine.origin}/console/firestore?path=products`)
  await expect(firestore.getByTestId('grid-row').first()).toBeVisible()

  const email = `tabs-${stamp()}@journey.test`
  const user = await signUp(engine, { email })
  try {
    await expect(
      users.getByTestId('users-grid').locator(`tr[data-key="${user.localId}"]`),
    ).toBeVisible()
    await expect(
      activity.getByTestId('activity-feed').getByTestId('feed-row').filter({ hasText: email }),
    ).toBeVisible()
    expect(live.open()).toBeLessThanOrEqual(1)
    expect(live.most()).toBeLessThanOrEqual(1)
  } finally {
    live.dispose()
    await deleteAccounts(engine, [user.localId])
  }
})
