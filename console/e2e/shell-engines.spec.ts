import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { seed as seedFirestore } from '../scripts/seed/firestore.mjs'
import { ENGINE_REVISION } from './engine'
import { dedicated, expect } from './fixtures'
import { ownerFetch } from './support/api'
import { badgeOf, commit, documentsOf, firestoreReads, freePort, text } from './support/shell'

// The shell's journeys that start engines of their own (foundation §9.3:
// 3, 5, 7, 11, 15, 17 and 18): an engine stopped and restarted on the same
// address, one slowed while it starts, one nobody has opened, one stopped
// with a channel open, one resuming its state, one with a job to run and
// one updated under the page. The worker holds no engine of its own beside
// them (`workerEngine: false`), so the host runs one engine at a time; a
// worker-scoped option is set for a whole file, which is why these are
// not in `shell.spec.ts`.

dedicated.use({ workerEngine: false })

/** `POST /suite/clear` for Firestore, sent from a tab as the console sends it. */
const clearFirestore = (page: Page) =>
  page.evaluate(async () => {
    const response = await fetch('/console/api/v1/suite/clear', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-firenook-console': '1' },
      body: JSON.stringify({ sections: ['firestore'] }),
    })
    return { status: response.status, body: (await response.json()) as unknown }
  })

dedicated.describe('with engines of their own', () => {
  dedicated(
    'an engine that stops says so at once, and one that restarts reloads what is on screen',
    async ({ page, dedicatedEngine }) => {
      const uiPort = await freePort()
      const first = await dedicatedEngine('data', { uiPort })
      let loads = 0
      page.on('load', () => {
        loads += 1
      })
      await page.goto(`${first.origin}/console/firestore?path=teams`)
      const rows = page.getByTestId('grid-row')
      await expect(rows.first()).toBeVisible()
      const badge = badgeOf(page)
      await expect(badge).toHaveText(/^engine /)
      await rows.nth(0).getByRole('checkbox').click()
      await commit(first, [{ path: 'teams/t_second', fields: { name: text('Second') } }])
      await expect(rows).toHaveCount(2)
      await rows.nth(1).getByRole('checkbox').click()
      await expect(page.getByRole('checkbox', { checked: true })).toHaveCount(2 + 1)

      const stopping = first.stop()
      await expect(badge).toHaveText('engine stopped', { timeout: 1_000 })
      // Said in the top bar, never a modal over the page.
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await expect(page.getByRole('alertdialog')).toHaveCount(0)
      await stopping

      const second = await dedicatedEngine('data', { uiPort, seed: false })
      await commit(second, [{ path: 'teams/t_restarted', fields: { name: text('Restarted') } }])
      await expect(page.getByText('The engine restarted')).toBeVisible({ timeout: 10_000 })
      await expect(page.locator('tr[data-path="teams/t_restarted"]')).toBeVisible()
      await expect(rows).toHaveCount(1)
      await expect(page.getByRole('checkbox', { checked: true })).toHaveCount(0)
      expect(loads).toBe(1)
    },
  )

  dedicated(
    'a section that is starting says what it waits for, then fills in by itself',
    async ({ page, dedicatedEngine }) => {
      const engine = await dedicatedEngine('compute', {
        fixtureEnv: { SLOW_LOAD_MS: '4000' },
        wait: 'ui',
        seed: false,
      })
      let loads = 0
      page.on('load', () => {
        loads += 1
      })
      await page.goto(`${engine.origin}/console/functions`)
      const starting = page.getByTestId('service-starting')
      await expect(starting).toBeVisible()
      await expect(starting).toContainText(/\S/)
      const dot = page.getByTestId('nav-dot-functions')
      await expect(dot).toHaveAttribute('data-tone', 'starting')
      await expect(page.getByTestId('nav-functions')).toHaveAttribute('data-state', 'starting')

      // Functions is built: once its codebases load, the page itself fills in.
      await expect(page.getByTestId('functions-overview')).toBeVisible({ timeout: 30_000 })
      await expect(starting).toHaveCount(0)
      // The starting dot goes (the compute project's `broken` codebase still
      // badges the section, which the collapsed nav shows as a dot of its own).
      await expect(dot).not.toHaveAttribute('data-tone', 'starting')
      await expect(page.getByTestId('nav-functions')).toHaveAttribute('data-state', 'ready')
      expect(loads).toBe(1)
    },
  )

  dedicated(
    '⌘K finds collections and documents from the engine, from anywhere',
    async ({ page, dedicatedEngine }) => {
      const engine = await dedicatedEngine('data')
      const palette = page.getByTestId('palette-input')
      const open = async () => {
        await page.keyboard.press('ControlOrMeta+k')
        await expect(palette).toBeVisible()
      }

      // Nobody has opened Firestore on this engine: its index is not built,
      // so a root collection is found without its count.
      await page.goto(`${engine.origin}/console/auth`)
      await expect(badgeOf(page)).toHaveText(/^engine /)
      await open()
      await palette.fill('prod')
      const collections = page.getByRole('group', { name: 'Collections' })
      const products = page.getByRole('option', { name: /products/ }).first()
      await expect(products).toBeVisible()
      await expect(products).not.toContainText('documents')
      await page.keyboard.press('Escape')

      // Firestore opened once: the count comes with it, and Enter opens the grid.
      await page.goto(`${engine.origin}/console/firestore`)
      await expect(page.getByTestId('firestore-workbench')).toBeVisible()
      await expect(page.getByText('products').first()).toBeVisible()
      await open()
      await palette.fill('prod')
      await expect(products).toContainText(/\d+ documents/)
      await products.focus()
      await palette.focus()
      await page.keyboard.press('Enter')
      await expect(page).toHaveURL(/path=products/)
      await expect(page.getByTestId('grid-row').first()).toBeVisible()
      void collections

      // A document's path finds the document, and opens it in the inspector.
      const listed = (await (
        await ownerFetch(engine, `${documentsOf(engine)}/products?pageSize=1`)
      ).json()) as { documents: { name: string }[] }
      const path = listed.documents[0]!.name.split('/documents/')[1]!
      await page.goto(`${engine.origin}/console/auth`)
      await expect(badgeOf(page)).toHaveText(/^engine /)
      await open()
      await palette.fill(path)
      const document = page.getByRole('option', { name: new RegExp(path) }).first()
      await expect(document).toBeVisible()
      await document.click()
      await expect(page).toHaveURL(/doc=/)
      await expect(page.getByTestId('inspector')).toBeVisible()

      // Firestore's own `?q=` is an SDK query chain, not a text search, so
      // the palette offers no "Search Firestore for" row for a word.
      await open()
      await palette.fill('prod')
      await expect(products).toBeVisible()
      await expect(page.getByRole('option', { name: /Search Firestore for/ })).toHaveCount(0)
    },
  )

  dedicated(
    'an engine stopped with a channel open tells it, and exits within its drain grace',
    async ({ page, dedicatedEngine }) => {
      const engine = await dedicatedEngine('data', { seed: false })
      await page.goto(`${engine.origin}/console/firestore`)
      const badge = badgeOf(page)
      await expect(badge).toHaveText(/^engine /)
      const started = Date.now()
      const exited = engine.stop()
      await expect(badge).toHaveText('engine stopped', { timeout: 1_000 })
      // The engine's own grace is 3 s; a SIGKILL would only come at 20 s.
      await Promise.race([
        exited,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('the engine did not exit within 6 s')), 6_000),
        ),
      ])
      expect(Date.now() - started).toBeLessThan(6_000)
    },
  )

  dedicated(
    'the engine popover says where the data lives, and exports where it is allowed to',
    async ({ page, dedicatedEngine }) => {
      const engine = await dedicatedEngine('data')
      await page.goto(`${engine.origin}/console/firestore`)
      await page.getByTestId('engine-badge-button').click()
      await expect(page.getByTestId('engine-popover')).toBeVisible()
      await expect(page.getByTestId('engine-data-mode')).toHaveText('on disk')
      await expect(page.getByTestId('engine-state-dir')).toHaveAttribute(
        'title',
        join(engine.directory, 'state'),
      )
      await page.getByTestId('export-now').click()
      await page.getByTestId('export-to-project').click()
      await expect(page.getByText('Exported to')).toBeVisible({ timeout: 30_000 })
      const exported = join(engine.directory, 'firenook-export')
      expect(existsSync(join(exported, 'firebase-export-metadata.json'))).toBe(true)
      await engine.stop()

      // An engine that resumes its state from a seed never writes over the
      // seed. Resuming needs Firestore, Auth and Storage (the state receipt
      // covers all three), so this one runs Storage too.
      const resumed = await dedicatedEngine('storage', {
        only: 'firestore,auth,storage',
        seed: false,
        args: ['--import', exported, '--resume-state'],
      })
      await page.goto(`${resumed.origin}/console/firestore`)
      await page.getByTestId('engine-badge-button').click()
      await page.getByTestId('export-now').click()
      const seed = page.getByTestId('export-to-seed')
      await expect(seed).toHaveAttribute('aria-disabled', 'true')
      await expect(seed).toContainText('The engine resumed its state, so the seed must not change.')
      await expect(page.getByTestId('export-to-project')).not.toHaveAttribute(
        'aria-disabled',
        'true',
      )
    },
  )

  dedicated(
    'a suite job reaches every tab, survives a reload, and runs alone',
    async ({ browser, dedicatedEngine }) => {
      const engine = await dedicatedEngine('data', { seed: false })
      const context = await browser.newContext()
      const first = await context.newPage()
      await first.goto(`${engine.origin}/console/firestore`)
      await expect(badgeOf(first)).toHaveText(/^engine /)
      // A clear of the empty database: the job is over at once.
      const probe = await clearFirestore(first)
      expect(probe.status).toBe(202)
      await expect
        .poll(async () => {
          const jobs = (await (
            await fetch(`${engine.origin}/console/api/v1/jobs?section=suite`)
          ).json()) as { jobs: { state: string }[] }
          return jobs.jobs.every((job) => job.state !== 'running')
        })
        .toBe(true)

      // A job with something to do: twenty thousand documents.
      const scale = process.env.FIRENOOK_SEED_SCALE
      process.env.FIRENOOK_SEED_SCALE = 'large'
      try {
        await seedFirestore(engine)
      } finally {
        if (scale === undefined) delete process.env.FIRENOOK_SEED_SCALE
        else process.env.FIRENOOK_SEED_SCALE = scale
      }

      const second = await context.newPage()
      await second.goto(`${engine.origin}/console/firestore/rules`)
      await expect(badgeOf(second)).toHaveText(/^engine /)
      const started = await clearFirestore(first)
      expect(started.status).toBe(202)
      const id = (started.body as { id: string }).id
      // The other tab hears of it through the jobs topic.
      const toast = second.getByText('Clear Firestore', { exact: false }).first()
      await expect(toast).toBeVisible({ timeout: 5_000 })
      // A second suite job meanwhile is refused: one at a time.
      const again = await clearFirestore(second)
      expect(again.status).toBe(409)
      expect((again.body as { error: { code: string } }).error.code).toBe('conflict')
      // The first tab, reloaded, re-attaches to the same job and follows it.
      const listed: string[] = []
      first.on('request', (request) => {
        if (request.url().includes('/console/api/v1/jobs?section=suite')) listed.push(request.url())
      })
      await first.reload()
      await expect(first.getByText(/Clear Firestore/).first()).toBeVisible({ timeout: 5_000 })
      expect(listed.length).toBeGreaterThan(0)
      const jobs = (await (
        await fetch(`${engine.origin}/console/api/v1/jobs?section=suite`)
      ).json()) as { jobs: { id: string }[] }
      expect(
        jobs.jobs.filter((job) => job.id !== id && job.id !== (probe.body as { id: string }).id),
      ).toEqual([])
      await context.close()
    },
  )

  dedicated(
    'an engine updated under the page asks for a reload, and nothing else',
    async ({ page, dedicatedEngine }) => {
      const uiPort = await freePort()
      const before = await dedicatedEngine('data', { uiPort })
      await page.goto(`${before.origin}/console/firestore?path=products`)
      await expect(page.getByTestId('grid-row').first()).toBeVisible()
      const badge = badgeOf(page)
      await expect(badge).toHaveText(/^engine /)
      await before.stop()
      await expect(badge).toHaveText('engine stopped')

      const revision = `${ENGINE_REVISION.slice(0, 32)}00000000`
      const watch = firestoreReads(page)
      // Unseeded: a seeder's writes would be live changes the page rightly
      // reads, and this journey is about the update alone.
      await dedicatedEngine('data', {
        uiPort,
        seed: false,
        env: { FIRENOOK_ENGINE_REVISION: revision },
      })
      const banner = page.getByTestId('banner-engine-updated')
      await expect(banner).toBeVisible({ timeout: 10_000 })
      await expect(banner).toContainText('The engine was updated. Reload to get its console.')
      await expect(badge).toHaveText('engine updated')
      await page.waitForTimeout(1_000)
      // Not a restart: no toast, and nothing on screen is read again.
      await expect(page.getByText('The engine restarted')).toHaveCount(0)
      watch.stop()
      expect(watch.reads).toEqual([])

      await banner.getByRole('button', { name: 'Reload' }).click()
      await expect(page.getByTestId('banner-engine-updated')).toHaveCount(0)
      await expect(badge).toHaveText(/^engine /)
      await expect(badge).toHaveAttribute('title', new RegExp(revision.slice(0, 12)))
      // The new console reads the new engine, which holds no products.
      await expect(page.getByTestId('empty-collection')).toBeVisible()
    },
  )
})
