import type { Page } from '@playwright/test'
import { type Engine, expect, test } from './fixtures'
import { callFunction, codebaseOf, loadsOf, nextLoad, projectFile, reload } from './support/compute'

// The codebase view's journeys (compute spec §9.3, 22–25) against the
// `compute` profile's engine: the worker and its load log, a worker that
// exits on its own, TypeScript sources newer than their build, and an env
// file changed on disk. Every file a journey changes is put back. No mocked
// API.

async function openCodebase(page: Page, engine: Engine, codebase: string) {
  await page.goto(`${engine.origin}/console/functions?codebase=${codebase}`)
  await expect(page.getByTestId('codebase-view')).toBeVisible()
}

test('the codebase view: its worker, its load log, and Reload', async ({ page, engine }) => {
  expect((await callFunction(engine, 'api', '/warm')).status).toBe(200)
  await page.goto(`${engine.origin}/console/functions`)
  await page.locator('[data-testid="panel-tree-node"][data-node-id="codebase:default"]').click()
  await expect(page).toHaveURL(/codebase=default/)
  const worker = page.getByTestId('codebase-worker')
  const state = await codebaseOf(engine, 'default')
  await expect(page.getByTestId('codebase-worker-state')).toContainText('Running')
  await expect(worker).toContainText(new RegExp(`pid\\s*${state.worker.pid}`))
  await expect(worker).toContainText(
    new RegExp(`Node\\s*${state.worker.node?.replaceAll('.', '\\.')}`),
  )
  // What the code printed at module scope, outside any invocation.
  await expect(page.getByTestId('codebase-log-lines')).toContainText('compute fixture loaded')

  const before = await loadsOf(engine, 'default')
  await page.getByTestId('codebase-reload-primary').click()
  await nextLoad(engine, 'default', before)
  await expect(page.getByTestId('codebase-loads')).toContainText(`${before + 1} loads`)
  await expect(page.getByTestId('codebase-worker-state')).toContainText('Starts on the next call')
  // A worker a reload stopped is the normal state between calls: no strip.
  await expect(page.getByTestId('codebase-worker-exited')).toHaveCount(0)
})

test('a worker that exits is said at once, without another call', async ({ page, engine }) => {
  await openCodebase(page, engine, 'default')
  expect((await callFunction(engine, 'api', '/exit')).status).toBe(200)
  const banner = page.getByTestId('codebase-worker-exited')
  await expect(banner).toBeVisible({ timeout: 2_000 })
  await expect(banner).toContainText('The worker for default exited (code 1)')
  await expect(banner).toContainText('The next call starts a new one.')
  await expect(page.getByTestId('codebase-worker-state')).toContainText('Exited (code 1)')
  // The next call starts a new one, and the strip goes.
  expect((await callFunction(engine, 'api', '/after-exit')).status).toBe(200)
  await expect(banner).toBeHidden()
})

test('TypeScript sources newer than their build are said, until the build catches up', async ({
  page,
  engine,
}) => {
  const source = projectFile(engine, 'jobs/src/index.ts')
  const build = projectFile(engine, 'jobs/lib/index.js')
  await openCodebase(page, engine, 'jobs')
  const banner = page.getByTestId('codebase-sources-newer')
  await expect(banner).toHaveCount(0)
  try {
    const before = await loadsOf(engine, 'jobs')
    // An edit of the source alone, as an editor saves it with no build running.
    source.write(`${source.original}// edited\n`)
    await nextLoad(engine, 'jobs', before)
    await expect(banner).toBeVisible({ timeout: 15_000 })
    await expect(banner).toContainText('src/ changed')
    await expect(banner).toContainText("but lib/ didn't — is npm run build:watch running?")
    await expect(page.getByTestId('function-problems')).toHaveCount(0)

    // The build writes lib/: the strip goes.
    const built = await loadsOf(engine, 'jobs')
    build.write(`${build.original}// built\n`)
    await nextLoad(engine, 'jobs', built)
    await expect(banner).toBeHidden({ timeout: 15_000 })
  } finally {
    const before = await loadsOf(engine, 'jobs')
    const restored = [source.restore(), build.restore()].some(Boolean)
    if (restored) await nextLoad(engine, 'jobs', before)
  }
})

test('an env file changed on disk is said, and nothing reloads until asked', async ({
  page,
  engine,
}) => {
  const env = projectFile(engine, 'functions/.env')
  await openCodebase(page, engine, 'default')
  const banner = page.getByTestId('codebase-env-changed')
  try {
    const before = await loadsOf(engine, 'default')
    env.write(env.original.replace(/^GREETING=.*$/m, 'GREETING=hi'))
    await expect(banner).toBeVisible({ timeout: 15_000 })
    await expect(banner).toContainText('.env changed after the last load')
    await expect(banner).toContainText('so default still runs with the old values')
    expect(await loadsOf(engine, 'default')).toBe(before)

    await banner.getByTestId('codebase-reload').click()
    await nextLoad(engine, 'default', before)
    await expect(banner).toBeHidden()
    await page.goto(
      `${engine.origin}/console/functions?function=us-central1-usesSecret&tab=environment`,
    )
    await expect(page.locator('[data-testid="env-variable"][data-key="GREETING"]')).toContainText(
      'hi',
    )
  } finally {
    if (env.restore()) await reload(engine, 'default')
  }
})
