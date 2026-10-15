import { join } from 'node:path'
import { type Engine, dedicated, expect } from './fixtures'
import { ownerFetch } from './support/api'
import { app, blockingFunctionsReady, consoleJson, toolkit, usersCount } from './support/auth'
import { liveRequests } from './support/live'
import { commit, text } from './support/shell'

// The Authentication journeys that need an engine of their own (auth spec
// §9.3: I6, X2, X3, S5, S6): one restarted on the state another saved, one
// stopped with the console's channel open, one without Auth, one without
// Functions, and one whose every user is deleted. The worker holds no
// engine beside them (`workerEngine: false`), so the host runs one engine at
// a time, as the shell's own engine journeys do.

dedicated.use({ workerEngine: false })

/** The documents of a collection, as the owner reads them. */
async function documentIds(engine: Engine, collection: string): Promise<string[]> {
  const response = await ownerFetch(
    engine,
    `/firestore/v1/projects/${engine.project}/databases/(default)/documents/${collection}?pageSize=300`,
  )
  expect(response.ok).toBe(true)
  const body = (await response.json()) as { documents?: { name: string }[] }
  return (body.documents ?? []).map((document) => document.name.split('/').at(-1) ?? '')
}

dedicated.describe('with engines of their own', () => {
  dedicated(
    'I6 a code from saved state is marked so after a restart, and is not new',
    async ({ page, dedicatedEngine }) => {
      const phone = `+1555${String(Date.now()).slice(-7)}`
      const first = await dedicatedEngine('auth', { only: 'auth,firestore', seed: false })
      const sent = await app(first, 'POST', toolkit('accounts:sendVerificationCode'), {
        body: { phoneNumber: phone },
      })
      expect(sent.status).toBe(200)
      // Stopping writes the Auth state (as a Ctrl-C does).
      await first.stop()

      const second = await dedicatedEngine('auth', {
        only: 'auth,firestore',
        seed: false,
        // The auth fixture puts the first engine's saved Auth state where
        // this one reads it at start.
        fixtureEnv: { AUTH_SAVED_STATE: join(first.directory, 'state', 'auth-state.json') },
      })
      await page.goto(`${second.origin}/console/auth/inbox`)
      const row = page.getByTestId('inbox-feed').getByTestId('feed-row').filter({ hasText: phone })
      await expect(row).toBeVisible()
      await expect(row.getByTestId('message-status')).toHaveText('saved state')
      // Said once: the time column has no time to show, and says only that.
      await expect(row).not.toContainText(/saved state.*saved state/)
      await expect(row.getByLabel('No time')).toHaveText('—')
      await expect(row.getByTestId('unread-dot')).toHaveCount(0)
      await page.getByTestId('inbox-facets').locator('button[data-term="is:restored"]').click()
      await expect(page).toHaveURL(/q=is%3Arestored/)
      await expect(row).toBeVisible()
    },
  )

  dedicated(
    'X2 an engine stops within five seconds with Auth’s live topics open',
    async ({ page, context, dedicatedEngine }) => {
      const engine = await dedicatedEngine('auth')
      const live = liveRequests(context)
      await page.goto(`${engine.origin}/console/auth`)
      await expect(page.getByTestId('users-grid').getByTestId('data-row').first()).toBeVisible()
      const inbox = await context.newPage()
      await inbox.goto(`${engine.origin}/console/auth/activity`)
      await expect(inbox.getByTestId('activity-feed').getByTestId('feed-row').first()).toBeVisible()
      await expect.poll(() => live.open()).toBe(1)
      const started = Date.now()
      await engine.stop()
      expect(Date.now() - started).toBeLessThan(5_000)
      await expect(page.getByTestId('engine-badge')).toHaveText('engine stopped', {
        timeout: 10_000,
      })
      live.dispose()
    },
  )

  dedicated(
    'X3 without Auth the workbench reads as any uid with a synthetic token',
    async ({ page, dedicatedEngine }) => {
      const engine = await dedicatedEngine('auth', { only: 'firestore', seed: false })
      await commit(engine, [
        { path: 'users/u_ghost', fields: { displayName: text('Ghost') } },
        { path: 'users/u_other', fields: { displayName: text('Other') } },
      ])
      await page.goto(
        `${engine.origin}/console/firestore?path=users&doc=users%2Fu_ghost&as=u_ghost`,
      )
      // Never stuck waiting on an engine that has no Auth to mint with.
      await expect(page.getByTestId('inspector').getByLabel('displayName value')).toHaveValue(
        'Ghost',
      )
      const picker = page.getByTestId('view-as')
      await expect(picker.getByLabel('Not an Auth user: synthetic token')).toBeVisible()
      // The rules decide for u_ghost: its own document, not another's.
      await page.goto(
        `${engine.origin}/console/firestore?path=users&doc=users%2Fu_other&as=u_ghost`,
      )
      await expect(page.getByTestId('inspector')).toContainText(/denied|permission|insufficient/i)
      await expect(page.getByTestId('inspector').getByLabel('displayName value')).toHaveCount(0)
    },
  )

  dedicated(
    'S5 without Functions, Settings says what blocking functions need and New user names none',
    async ({ page, dedicatedEngine }) => {
      const engine = await dedicatedEngine('auth', { only: 'auth,firestore' })
      await page.goto(`${engine.origin}/console/auth/settings`)
      const card = page.getByTestId('hooks-card')
      const notice = card.getByTestId('requires-functions')
      await expect(notice).toBeVisible()
      await expect(notice).toContainText(
        'Blocking functions and triggers needs Functions, which this engine does not run.',
      )
      await notice.getByTestId('requires-functions-how').click()
      // The engine's own fix: the command line it was started with, Functions added.
      const fix = page.locator('[data-testid^="requires-functions-fix-"]').first()
      await expect(fix).toBeVisible()
      await expect(fix).toContainText('functions')
      await page.keyboard.press('Escape')
      await expect(card.getByTestId('hook-beforeCreate')).toHaveText('none')
      // "Functions" leads to the Functions page, which is its gate here.
      await notice.getByTestId('requires-functions-section').click()
      await expect(page).toHaveURL(/\/console\/functions$/)
      await expect(page.getByTestId('service-not-running')).toBeVisible()

      await page.goto(`${engine.origin}/console/auth?new=user`)
      const note = page.getByTestId('create-user-dialog').getByTestId('new-user-note')
      await expect(note).toHaveText(
        'Created as createUser() does; blocking functions do not run — they run for sign-ups from a client.',
      )
    },
  )

  dedicated(
    'S6 deleting every tenant’s users is one suite job that runs no trigger',
    async ({ page, dedicatedEngine }) => {
      const engine = await dedicatedEngine('auth')
      await blockingFunctionsReady(engine)
      // The trigger runs for a delete that asks for it: the control.
      const control = await app<{ localId: string }>(
        engine,
        'POST',
        toolkit('accounts', { project: engine.project }),
        { as: 'admin', body: { email: 'control@journey.test', password: 'password-1' } },
      )
      expect(control.status).toBe(200)
      const deleted = await app(
        engine,
        'POST',
        toolkit('accounts:delete', { project: engine.project }),
        {
          as: 'admin',
          body: { localId: control.body.localId },
        },
      )
      expect(deleted.status).toBe(200)
      await expect
        .poll(() => documentIds(engine, 'auth-deletes'), { timeout: 30_000 })
        .toEqual([control.body.localId])
      expect(await usersCount(engine)).toBeGreaterThan(0)
      expect(await usersCount(engine, { tenant: 'acme' })).toBeGreaterThan(0)

      const clears: unknown[] = []
      page.on('request', (request) => {
        if (new URL(request.url()).pathname === '/console/api/v1/suite/clear')
          clears.push(request.postDataJSON())
      })
      // Settings leads to the Overview's reset, which clears the section.
      await page.goto(`${engine.origin}/console/auth/settings`)
      await page.getByTestId('settings-reset').click()
      await expect(page).toHaveURL(/\/console\/?#overview-data-title$/)
      await page.getByTestId('overview-reset-auth-open').click()
      const confirm = page.getByTestId('reset-dialog')
      await expect(confirm).toContainText('Reset Authentication')
      await expect(confirm).toContainText('Codes and links already issued stay in the inbox.')
      await confirm.getByRole('button', { name: /^Reset/ }).click()
      // The dialog says how it ended. (Whether the shell toasts it as well
      // is the Overview's choice of where a reset's progress is said.)
      await expect(confirm).toContainText('Done:')
      expect(clears).toEqual([{ sections: ['auth'] }])
      expect(await usersCount(engine)).toBe(0)
      expect(await usersCount(engine, { tenant: 'acme' })).toBe(0)
      const tenants = await consoleJson<{ items: { tenantId: string; users: number }[] }>(
        engine,
        '/auth/tenants',
      )
      for (const tenant of tenants.items) expect(tenant.users).toBe(0)

      // A second triggered delete after it is the barrier: once its run is
      // recorded, the clear's would have been too, and there are none.
      const after = await app<{ localId: string }>(
        engine,
        'POST',
        toolkit('accounts', { project: engine.project }),
        { as: 'admin', body: { email: 'after@journey.test', password: 'password-1' } },
      )
      await app(engine, 'POST', toolkit('accounts:delete', { project: engine.project }), {
        as: 'admin',
        body: { localId: after.body.localId },
      })
      await expect
        .poll(async () => (await documentIds(engine, 'auth-deletes')).toSorted(), {
          timeout: 30_000,
        })
        .toEqual([control.body.localId, after.body.localId].toSorted())
    },
  )
})
