import { type Engine, expect, test } from './fixtures'
import {
  app,
  blockingFunctionsReady,
  consoleJson,
  deleteAccounts,
  deleteTenant,
  emulatorConfig,
  latestCall,
  setEmulatorConfig,
  signIn,
  toolkit,
  unsignedJwt,
  usersCount,
} from './support/auth'

// Authentication › Settings against the real engine (auth spec §9.3, S1–S4;
// S5 and S6 need engines of their own, in `auth-engines.spec.ts`): tenants
// with chosen ids and their sign-in switches, the blocking functions and
// triggers, one account per email, and the way to the Overview's snippets
// that connect an app.
// Every switch and tenant is put back at the end.

const stamp = () => Date.now().toString(36)

const settings = (engine: Engine, search: Record<string, string> = {}) => {
  const query = new URLSearchParams(search).toString()
  return `${engine.origin}/console/auth/settings${query ? `?${query}` : ''}`
}

test('S1 a tenant made with its own id holds its users, its switches and its delete', async ({
  page,
  context,
  engine,
}) => {
  test.setTimeout(60_000)
  const tenant = `acme-t${stamp().slice(-6)}`
  const email = `tenant-${stamp()}@journey.test`
  try {
    // Made in the dialog, with the id chosen here.
    await page.goto(settings(engine))
    await page.getByTestId('settings-new-tenant').click()
    const dialog = page.getByTestId('tenant-dialog')
    await dialog.getByTestId('tenant-id').fill(tenant)
    await dialog.getByTestId('tenant-display-name').fill('Journey tenant')
    await dialog.getByTestId('tenant-save').click()
    await expect(dialog).toBeHidden()
    await expect(page.getByTestId('tenants-grid').locator(`tr[data-key="${tenant}"]`)).toBeVisible()
    // The page now shows the new tenant's sign-in switches.
    await expect(page.getByTestId('settings-tenant')).toContainText(tenant)
    await expect(page.getByTestId('settings-tenant-sign-in')).toBeVisible()

    // The same id again is refused, in words.
    await page.getByTestId('settings-new-tenant').click()
    await dialog.getByTestId('tenant-id').fill(tenant)
    await dialog.getByTestId('tenant-save').click()
    await expect(dialog.getByTestId('tenant-error')).toHaveText(
      `A tenant \`${tenant}\` already exists.`,
    )
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()

    // Empty, its Users page says so, names the scopes that do hold users,
    // and offers the ways to add some.
    await page.goto(`${engine.origin}/console/auth?tenant=${tenant}`)
    const empty = page.getByTestId('users-empty')
    await expect(empty).toContainText(`No users in tenant ${tenant} yet`)
    await expect(empty).toContainText('Project users has')
    await expect(empty.getByRole('button', { name: 'New user' })).toBeVisible()

    // A user made there is that tenant's alone.
    await page.goto(`${engine.origin}/console/auth?tenant=${tenant}&new=user`)
    const create = page.getByTestId('create-user-dialog')
    await expect(create).toContainText(`tenant ${tenant}`)
    await create.getByTestId('new-email').fill(email)
    await create.getByTestId('new-password').fill('password-1')
    await create.getByTestId('create-user').click()
    await expect(create).toBeHidden()
    await expect(page.getByTestId('users-count')).toHaveText('1 user')
    expect(await usersCount(engine, { tenant, q: email })).toBe(1)
    expect(await usersCount(engine, { q: email })).toBe(0)

    // Password sign-up off: a password sign-in there is refused, explained.
    await page.goto(settings(engine, { tenant }))
    const password = page.getByTestId('settings-tenant-password').getByRole('switch')
    await expect(password).toBeChecked()
    await password.click()
    await expect(password).not.toBeChecked()
    await expect
      .poll(async () => {
        const listed = await consoleJson<{
          items: { tenantId: string; allowPasswordSignup: boolean }[]
        }>(engine, `/auth/tenants?q=${tenant}`)
        return listed.items.find((item) => item.tenantId === tenant)?.allowPasswordSignup
      })
      .toBe(false)
    const refused = await signIn(engine, { email, password: 'password-1', tenant })
    expect(refused.status).toBe(400)
    expect(refused.body.error?.message).toMatch(/^PASSWORD_LOGIN_DISABLED/)
    const call = await latestCall(engine)
    await page.goto(
      `${engine.origin}/console/auth/activity?tenant=${tenant}&entry=${String(call.id)}`,
    )
    await expect(page.getByTestId('call-detail').getByTestId('call-title')).toContainText(
      'PASSWORD_LOGIN_DISABLED',
    )
    await expect(page.getByTestId('call-detail').getByTestId('call-explanation')).not.toBeEmpty()

    // Deleted from Settings while another tab shows its users.
    const usersTab = await context.newPage()
    await usersTab.goto(`${engine.origin}/console/auth?tenant=${tenant}`)
    await expect(usersTab.getByTestId('users-grid').getByTestId('data-row')).toHaveCount(1)
    await page.goto(settings(engine))
    const row = page.getByTestId('tenants-grid').locator(`tr[data-key="${tenant}"]`)
    await row.click({ button: 'right' })
    await page.getByTestId('row-menu-delete').click()
    const confirm = page.getByTestId('tenant-delete-confirm')
    await expect(confirm).toContainText('Its 1 user is removed with it.')
    await expect(confirm).toContainText('No user.delete events fire')
    await confirm.getByRole('button', { name: /^Delete/ }).click()
    await expect(row).toHaveCount(0)
    await expect(usersTab.getByTestId('tenant-deleted')).toBeVisible()
    await expect(usersTab.getByTestId('tenant-deleted')).toContainText(
      `Tenant ${tenant} was deleted.`,
    )
    await expect(usersTab.getByTestId('new-users-menu')).toBeDisabled()
  } finally {
    await deleteTenant(engine, tenant)
  }
})

test('S2 the blocking functions and triggers are named, with their recent calls', async ({
  page,
  engine,
}) => {
  await blockingFunctionsReady(engine)
  await page.goto(settings(engine))
  const before = page.getByTestId('hook-beforeCreate')
  await expect(before).toContainText('beforeCreate')
  await expect(before).toContainText('from Functions')
  await expect(page.getByTestId('hook-beforeSignIn')).toContainText('beforeSignIn')
  // A link to the function, once Functions has pages to link to.
  for (const hook of [before, page.getByTestId('hook-beforeSignIn')]) {
    const link = hook.getByRole('link')
    if ((await link.count()) > 0)
      await expect(link.first()).toHaveAttribute('href', /\/console\/functions/)
  }
  // The account triggers come from the Functions runtime's own matcher.
  const triggers = await fetch(`${engine.origin}/console/api/v1/functions/triggers?service=auth`)
  if (triggers.ok)
    await expect(page.getByTestId('trigger-user.create')).toContainText('onUserCreated')
  else await expect(page.getByTestId('trigger-user.create')).toBeEmpty()
  // Whether background delivery is paused is the shell's to say, not this card's.
  await expect(page.getByTestId('hooks-card')).not.toContainText(/paused|background/i)

  await page
    .getByTestId('settings-hooks')
    .getByRole('link', { name: 'Recent calls ↗' })
    .first()
    .click()
  await expect(page).toHaveURL(/\/console\/auth\/activity\?.*q=has%3Ablocking/)
})

test('S3 one account per email decides whether a provider sign-in makes a second account', async ({
  page,
  engine,
}) => {
  const email = `shared-${stamp()}@journey.test`
  const before = await emulatorConfig(engine)
  const made: string[] = []
  /** A Google sign-in for that email, as the app's SDK sends it. */
  const google = (sub: string) =>
    app<{ localId: string; isNewUser?: boolean }>(
      engine,
      'POST',
      toolkit('accounts:signInWithIdp'),
      {
        body: {
          postBody: `id_token=${unsignedJwt({ sub, email, email_verified: true })}&providerId=google.com`,
          requestUri: 'http://localhost',
          returnIdpCredential: true,
          returnSecureToken: true,
        },
      },
    )
  try {
    // An email-and-password account holds the email.
    const owner = await app<{ localId: string }>(
      engine,
      'POST',
      toolkit('accounts', { project: engine.project }),
      { as: 'admin', body: { email, password: 'password-1', emailVerified: true } },
    )
    expect(owner.status).toBe(200)
    made.push(owner.body.localId)

    // On (the default): the Google sign-in lands in that account.
    await page.goto(settings(engine))
    const one = page.getByTestId('settings-one-account')
    await expect(one).toBeChecked()
    const total = await usersCount(engine)
    const same = await google(`g-one-${stamp()}`)
    expect(same.status).toBe(200)
    expect(same.body.localId).toBe(owner.body.localId)
    expect(await usersCount(engine)).toBe(total)

    // Off: it makes a second account for the same email.
    await one.click()
    await expect(one).not.toBeChecked()
    await expect
      .poll(async () => (await emulatorConfig(engine)).signIn.allowDuplicateEmails)
      .toBe(true)
    const second = await google(`g-two-${stamp()}`)
    expect(second.status).toBe(200)
    made.push(second.body.localId)
    expect(second.body.localId).not.toBe(owner.body.localId)
    expect(second.body.isNewUser).toBe(true)
    expect(await usersCount(engine)).toBe(total + 1)

    // And back on, from the switch.
    await one.click()
    await expect(one).toBeChecked()
    await expect
      .poll(async () => (await emulatorConfig(engine)).signIn.allowDuplicateEmails)
      .toBe(false)
  } finally {
    await setEmulatorConfig(engine, { allowDuplicateEmails: before.signIn.allowDuplicateEmails })
    await deleteAccounts(engine, made.filter(Boolean))
  }
})

test('S4 Settings leads to the Overview’s snippets, which point an app at this Auth emulator', async ({
  page,
  engine,
}) => {
  const status = await consoleJson<{ services: { name: string; host: string; port: number }[] }>(
    engine,
    '/status',
  )
  const auth = status.services.find((service) => service.name === 'auth')!
  await page.goto(settings(engine, { section: 'connect' }))
  await page.getByTestId('settings-connect-overview').click()
  await expect(page).toHaveURL(/\/console\/?\?connect=web/)
  const snippet = page.getByTestId('overview-connect-snippet')
  await expect(snippet).toBeInViewport()
  await expect(snippet).toContainText(`connectAuthEmulator(`)
  await expect(snippet).toContainText(`http://${auth.host}:${auth.port}`)
  // An Android emulator reaches this machine at 10.0.2.2.
  await page.getByTestId('overview-host').getByRole('combobox').click()
  await page.getByRole('option', { name: /10\.0\.2\.2/ }).click()
  await page.getByTestId('overview-connect-tabs').getByRole('tab', { name: 'Android' }).click()
  await expect(snippet).toContainText(`Firebase.auth.useEmulator("10.0.2.2", ${auth.port})`)
  await page
    .getByTestId('overview-connect-tabs')
    .getByRole('tab', { name: 'Environment variables' })
    .click()
  await expect(snippet).toContainText('FIREBASE_AUTH_EMULATOR_HOST=')
  await expect(snippet).toContainText(`:${auth.port}`)
})
