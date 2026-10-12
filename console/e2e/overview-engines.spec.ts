import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page, Request } from '@playwright/test'
import { seedBulk, seedCarts } from '../scripts/seed/observe.mjs'
import { dedicated, expect } from './fixtures'
import { ownerFetch } from './support/api'
import { freePort } from './support/shell'
import {
  type ObservedEngine,
  facetsOf,
  logRows,
  openLogs,
  runWithAdminSdk,
  writeOnPort,
} from './support/observe'

// The Overview's journeys that need an engine of their own (observe §9.3,
// 6–13): one started without Functions, one each for a snapshot downloaded
// and one saved, resets that delete what they are given, a project that is
// not a demo, an app writing to another project, background triggers
// paused, and the suite busy with a job. The worker holds no engine beside
// them (`workerEngine: false`), so the host runs one engine at a time.

dedicated.use({ workerEngine: false })

/** The trigger line of each document `onCartDeleted` runs for. */
const CART_TRIGGER = '"Beginning execution" onCartDeleted'

/** The suite's jobs, as the engine lists them. */
async function suiteJobs(engine: ObservedEngine) {
  const response = await fetch(`${engine.origin}/console/api/v1/jobs?section=suite`)
  return ((await response.json()) as { jobs: { id: string; kind: string; state: string }[] }).jobs
}

/** How many documents Firestore's card counts, read from the engine's status. */
async function documentsOf(engine: ObservedEngine): Promise<number | null | undefined> {
  const response = await fetch(`${engine.origin}/console/api/v1/status`)
  const status = (await response.json()) as {
    sections: {
      id: string
      summary: { figures: { label: string; value: number | null }[] } | null
    }[]
  }
  return status.sections
    .find((section) => section.id === 'firestore')
    ?.summary?.figures.find((figure) => figure.label === 'Documents')?.value
}

/** Opens Firestore's reset from the Overview's Reset card and presses Reset. */
async function resetFirestore(page: Page, options: { runTriggers?: boolean } = {}) {
  await page.getByTestId('overview-reset-firestore-open').click()
  const dialog = page.getByTestId('reset-dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('Every document in every database is deleted')
  if (options.runTriggers)
    await dialog
      .getByRole('checkbox', { name: 'Run Functions triggers for deleted documents' })
      .check()
  await page.getByTestId('reset-dialog-confirm').click()
  return dialog
}

/** Firestore reads a page makes: queries and collection listings. */
function queriesOf(page: Page) {
  const reads: string[] = []
  const onRequest = (request: Request) => {
    const url = decodeURIComponent(request.url())
    if (!/\/console\/api\/v1\/firestore\//.test(url)) return
    if (
      url.includes(':runQuery') ||
      (request.method() === 'GET' && /\/documents\/[^/:?]+\?/.test(url))
    )
      reads.push(`${request.method()} ${url}`)
  }
  page.on('request', onRequest)
  return { reads, stop: () => page.off('request', onRequest) }
}

dedicated.describe('the Overview with engines of their own', () => {
  // Each journey starts and seeds an engine of its own first.
  dedicated.describe.configure({ timeout: 90_000 })

  dedicated('what does not run says why, and the exact fix', async ({ page, dedicatedEngine }) => {
    // The data profile ships no Functions codebase, yet Functions is asked for.
    const engine = await dedicatedEngine('data', { only: 'firestore,auth,functions', seed: false })
    await page.goto(`${engine.origin}/console`)
    const absent = page.getByTestId('overview-not-running')
    await expect(absent).toBeVisible()
    const functions = page.getByTestId('overview-absent-functions')
    await expect(functions).toContainText(
      'firebase.json configures no Functions codebase and no Extensions.',
    )
    const storage = page.getByTestId('overview-absent-storage')
    await expect(storage).toBeVisible()
    // Every fix is a block that copies as typed.
    const fixes = absent.locator('[data-testid^="overview-absent-"][data-kind]')
    await expect(fixes.first()).toBeVisible()
    const functionsFix = absent.locator('[data-testid^="overview-absent-functions-fix-"]').first()
    await expect(functionsFix).toContainText('"functions"')
    await functionsFix.getByTestId(/-copy$/).click()
    const copied = await page.evaluate(() =>
      (
        globalThis as unknown as { navigator: { clipboard: { readText(): Promise<string> } } }
      ).navigator.clipboard.readText(),
    )
    expect(copied).toContain('"functions"')
    const storageFix = absent.locator('[data-testid^="overview-absent-storage-fix-"]').first()
    await expect(storageFix).toBeVisible()
    await expect(storageFix).toContainText(/storage/)
  })

  dedicated('a snapshot downloads as a standard export', async ({ page, dedicatedEngine }) => {
    const engine = await dedicatedEngine('observe')
    await page.goto(`${engine.origin}/console`)
    const downloaded = page.waitForEvent('download')
    await page.getByTestId('overview-snapshot-download').click()
    const file = await downloaded
    expect(file.suggestedFilename()).toMatch(new RegExp(`^firenook-${engine.project}-.+\\.zip$`))
    const bytes = readFileSync(await file.path())
    expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK')
    // The central directory names the export's metadata file.
    expect(bytes.includes(Buffer.from('firebase-export-metadata.json'))).toBe(true)
    await expect(page.getByTestId('overview-snapshot-taken')).toContainText('Snapshot downloaded')
    const jobs = await suiteJobs(engine)
    expect(jobs.filter((job) => job.kind === 'suite.snapshot').map((job) => job.state)).toEqual([
      'done',
    ])
  })

  dedicated(
    'a snapshot saves on the engine’s machine, never over the seed it resumed from',
    async ({ page, dedicatedEngine }) => {
      // Two engines, one after the other.
      dedicated.setTimeout(120_000)
      const engine = await dedicatedEngine('observe')
      await page.goto(`${engine.origin}/console?dialog=save`)
      const dialog = page.getByTestId('save-snapshot-dialog')
      await expect(dialog).toBeVisible()
      const project = page.getByTestId('save-destination-project')
      await expect(project).toContainText(join(engine.directory, 'firenook-export'))
      await project.click()
      await page.getByTestId('save-snapshot-confirm').click()
      await expect(page.getByText('Snapshot saved')).toBeVisible({ timeout: 30_000 })
      await expect(page.getByText(join(engine.directory, 'firenook-export')).first()).toBeVisible()
      const exported = join(engine.directory, 'firenook-export')
      expect(existsSync(join(exported, 'firebase-export-metadata.json'))).toBe(true)
      await engine.stop()

      // An engine that resumes its state from that export offers no seed to overwrite.
      const resumed = await dedicatedEngine('storage', {
        only: 'firestore,auth,storage',
        seed: false,
        args: ['--import', exported, '--resume-state'],
      })
      await page.goto(`${resumed.origin}/console?dialog=save`)
      await expect(page.getByTestId('save-snapshot-dialog')).toBeVisible()
      await expect(page.getByTestId('save-destination-seed-refused')).toContainText(
        'The engine resumed its state, so the seed must not change.',
      )
      await expect(page.getByRole('radio', { name: /seed/i })).toBeDisabled()
    },
  )

  dedicated(
    'a reset deletes without triggers, and an open Firestore page follows it',
    async ({ browser, dedicatedEngine }) => {
      // Two rounds of 50,000 documents written and deleted.
      dedicated.setTimeout(300_000)
      const engine = await dedicatedEngine('observe')
      const context = await browser.newContext()
      for (const round of ['watched', 'its tab closed'] as const) {
        await seedBulk(engine, 50_000)
        await seedCarts(engine)
        await expect.poll(() => documentsOf(engine)).toBeGreaterThan(50_000)
        const triggersBefore = (await facetsOf(engine, { q: CART_TRIGGER })).matched

        const watcher = await context.newPage()
        await watcher.goto(`${engine.origin}/console/firestore?path=bulk`)
        await expect(watcher.getByTestId('grid-row').first()).toBeVisible()
        const reads = queriesOf(watcher)

        const resetter = await context.newPage()
        await resetter.goto(`${engine.origin}/console`)
        const dialog = await resetFirestore(resetter)
        if (round === 'watched') {
          // The tab that pressed Reset shows how far it got.
          await expect(dialog.getByTestId('reset-dialog-progress')).toBeVisible()
        } else {
          await resetter.close()
        }
        // The other tab hears of the job and of its end.
        await expect(watcher.getByText('Clear Firestore').first()).toBeVisible({ timeout: 10_000 })
        await expect(watcher.getByText('Clear Firestore: done')).toBeVisible({ timeout: 60_000 })
        await expect.poll(() => documentsOf(engine), { timeout: 10_000 }).toBe(0)
        await expect(watcher.getByTestId('grid-row')).toHaveCount(0)
        reads.stop()
        expect(reads.reads.length, reads.reads.join('\n')).toBeLessThanOrEqual(5)
        // A reset is maintenance: no trigger ran for the carts it deleted.
        expect((await facetsOf(engine, { q: CART_TRIGGER })).matched).toBe(triggersBefore)
        if (round === 'watched') {
          await expect(resetter.getByTestId(`overview-figure-firestore-documents`)).toHaveText('0')
          await resetter.close()
        }
        await watcher.close()
      }
      await context.close()
    },
  )

  dedicated(
    'a reset can run the triggers of what it deletes, when asked',
    async ({ page, dedicatedEngine }) => {
      const engine = await dedicatedEngine('observe')
      const before = (await facetsOf(engine, { q: CART_TRIGGER })).matched
      await page.goto(`${engine.origin}/console`)
      await resetFirestore(page, { runTriggers: true })
      await expect(page.getByTestId('reset-dialog')).toContainText(
        'Functions triggers run for each deleted document.',
      )
      // One delete trigger per seeded cart, logged as each runs.
      await expect
        .poll(async () => (await facetsOf(engine, { q: CART_TRIGGER })).matched - before, {
          timeout: 60_000,
        })
        .toBe(20)
    },
  )

  dedicated(
    'resetting everything asks for the project id, and leaves every section empty',
    async ({ page, dedicatedEngine }) => {
      const engine = await dedicatedEngine('observe')
      await page.goto(`${engine.origin}/console`)
      await expect(page.getByTestId('overview-reset')).toBeVisible()
      const rows = page.getByTestId('overview-reset-rows').locator('[data-testid$="-open"]')
      await expect(rows.first()).toBeVisible()
      dedicated.skip(
        (await rows.count()) < 2,
        'only one section of this engine can be reset from the console so far (each stream lands its clear with its pages)',
      )
      await page.getByTestId('overview-reset-everything').click()
      const confirm = page.getByTestId('reset-dialog-confirm')
      await expect(confirm).toBeDisabled()
      await page.getByTestId('reset-dialog-type').fill(engine.project.slice(0, -1))
      await expect(confirm).toBeDisabled()
      await page.getByTestId('reset-dialog-type').fill(engine.project)
      await expect(confirm).toBeEnabled()
      await confirm.click()
      await expect(page.getByText(/^Clear .+: done$/)).toBeVisible({ timeout: 60_000 })
      for (const figure of await page.locator('[data-testid^="overview-figure-"]').all()) {
        const id = (await figure.getAttribute('data-testid')) ?? ''
        if (id.startsWith('overview-figure-logs-')) continue
        await expect(figure).toHaveText('0')
      }
      const markers = await facetsOf(engine, { q: 'kind:data.reset' })
      expect(markers.matched).toBe(await rows.count())
    },
  )

  dedicated(
    'a project that is not a demo is said until dismissed, again after a restart',
    async ({ browser, dedicatedEngine }) => {
      // Two engines, one after the other.
      dedicated.setTimeout(120_000)
      const uiPort = await freePort()
      const first = await dedicatedEngine('data', {
        project: 'console-e2e-real',
        uiPort,
        seed: false,
      })
      const context = await browser.newContext()
      const one = await context.newPage()
      await one.goto(`${first.origin}/console`)
      const notice = one.getByTestId('overview-notice-nonDemoProject')
      await expect(notice).toContainText('Project ID "console-e2e-real" is not a demo project.')
      const two = await context.newPage()
      await two.goto(`${first.origin}/console`)
      await expect(two.getByTestId('overview-notice-nonDemoProject')).toBeVisible()
      await one.getByTestId('overview-notice-nonDemoProject-dismiss').click()
      await expect(notice).toHaveCount(0)
      // Dismissed for this engine run, in every tab.
      await expect(two.getByTestId('overview-notice-nonDemoProject')).toHaveCount(0)
      await two.reload()
      await expect(two.getByTestId('overview')).toBeVisible()
      await expect(two.getByTestId('overview-notice-nonDemoProject')).toHaveCount(0)

      // A new run of the engine says it again.
      await first.stop()
      const second = await dedicatedEngine('data', {
        project: 'console-e2e-real',
        uiPort,
        seed: false,
      })
      await one.goto(`${second.origin}/console`)
      await expect(one.getByTestId('overview-notice-nonDemoProject')).toBeVisible()
      await context.close()
    },
  )

  dedicated(
    'the suite’s warnings lead the Overview in the shell’s words, and Logs marks them',
    async ({ page, dedicatedEngine }) => {
      const engine = await dedicatedEngine('observe', { seed: false })
      await page.goto(`${engine.origin}/console`)
      await expect(page.getByTestId('overview')).toBeVisible()

      // An app writing to another project, over REST and over gRPC.
      await writeOnPort(engine, 'orders/o_rest', { total: { integerValue: '1' } }, 'demo-other')
      await runWithAdminSdk(
        [
          "import { initializeApp } from 'firebase-admin/app'",
          "import { getFirestore } from 'firebase-admin/firestore'",
          "initializeApp({ projectId: 'demo-other' })",
          "await getFirestore().doc('orders/o_grpc').set({ total: 2 })",
          'process.exit(0)',
        ].join('\n'),
        { FIRESTORE_EMULATOR_HOST: `127.0.0.1:${engine.ports.firestore}` },
      )
      const foreign = page.getByTestId('banner-foreign-project')
      await expect(foreign).toBeVisible({ timeout: 3_000 })
      await expect(foreign).toContainText('demo-other')
      // The same words as on the Firestore page (which also offers to show that project).
      const said = `Your app is using project demo-other; this emulator is ${engine.project}, so its data is not shown here.`
      await expect(foreign).toContainText(said)
      await page.goto(`${engine.origin}/console/firestore`)
      await expect(page.getByTestId('banner-foreign-project')).toContainText(said)
      await page.goto(`${engine.origin}/console`)

      // Background triggers paused by a harness, and resumed.
      const hub = `http://127.0.0.1:${engine.ports.hub}`
      const paused = page.getByTestId('banner-triggers-paused')
      try {
        expect(
          (await fetch(`${hub}/functions/disableBackgroundTriggers`, { method: 'PUT' })).ok,
        ).toBe(true)
        await expect(paused).toBeVisible({ timeout: 5_000 })
        await expect(paused).toContainText(
          'Background triggers are paused, so events are dropped, not queued — ',
        )
      } finally {
        await fetch(`${hub}/functions/enableBackgroundTriggers`, { method: 'PUT' })
      }
      await expect(paused).toHaveCount(0, { timeout: 5_000 })
      // Observe draws no notice of its own for either.
      const notices = page.getByTestId('overview-notices')
      if ((await notices.count()) > 0) {
        await expect(notices).not.toContainText('demo-other')
        await expect(notices).not.toContainText('Background triggers')
      }
      // Each switch is a marker in the log.
      await openLogs(page, engine)
      const markers = page.locator(
        '[data-testid="log-marker-line"][data-kind="hub.backgroundTriggers"]',
      )
      await expect(markers).toHaveCount(2)
      expect((await facetsOf(engine, { q: 'kind:hub.backgroundTriggers' })).matched).toBe(2)
      await expect(logRows(page).first()).toBeVisible()
    },
  )

  dedicated('the suite runs one data job at a time', async ({ page, dedicatedEngine }) => {
    dedicated.setTimeout(180_000)
    const engine = await dedicatedEngine('observe')
    await seedBulk(engine, 50_000)
    await page.goto(`${engine.origin}/console`)
    await resetFirestore(page)
    await expect(page.getByTestId('reset-dialog-progress')).toBeVisible()
    // A snapshot asked for meanwhile is refused, and says by what.
    const response = await ownerFetch(engine, '/overview/snapshots', {
      method: 'POST',
      body: JSON.stringify({}),
    })
    expect(response.status).toBe(409)
    const body = (await response.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('conflict')
    expect(body.error.message).toBe('Another suite action is still running.')
    await expect(page.getByTestId('overview-snapshot-download')).toBeDisabled()
  })

  dedicated(
    'a job is seen from a tab opened after it started, and only its own tab downloads',
    async ({ browser, dedicatedEngine }) => {
      dedicated.setTimeout(240_000)
      const engine = await dedicatedEngine('observe')
      // Enough data that the snapshot takes a moment to prepare.
      await seedBulk(engine, 50_000)
      const context = await browser.newContext({ acceptDownloads: true })
      const starter = await context.newPage()
      await starter.goto(`${engine.origin}/console`)
      const late = await context.newPage()
      const lateDownloads: string[] = []
      late.on('download', (download) => lateDownloads.push(download.suggestedFilename()))
      const downloaded = starter.waitForEvent('download', { timeout: 120_000 })
      await starter.getByTestId('overview-snapshot-download').click()
      await expect(starter.getByTestId('overview-job')).toContainText('Preparing a snapshot…')
      await late.goto(`${engine.origin}/console`)
      // The late tab re-attaches: the job's progress, then its result.
      await expect(late.getByText('Prepare a snapshot').first()).toBeVisible({ timeout: 10_000 })
      await expect(late.getByText('Prepare a snapshot: done')).toBeVisible({ timeout: 120_000 })
      await expect(late.getByTestId('overview-snapshot-ready')).toContainText('Snapshot ready')
      await expect(late.getByTestId('overview-snapshot-ready-download')).toBeVisible()
      // Only the tab that asked downloaded it.
      const file = await downloaded
      expect(file.suggestedFilename()).toMatch(/\.zip$/)
      expect(lateDownloads).toEqual([])
      await context.close()
    },
  )
})
