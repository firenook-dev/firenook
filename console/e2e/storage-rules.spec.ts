import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { commit, documentsOf, text } from './support/shell'
import {
  bucketsOf,
  getMetadata,
  listFolder,
  pasteRules,
  person,
  putFile,
  removeFile,
  restoreRules,
  rulesNow,
  tokenFor,
  upload,
} from './support/storage'
import { type Engine, expect, test } from './fixtures'
import { ownerFetch } from './support/api'

// The Storage rules page against the real engine and the storage profile's
// per-bucket rules (scripts/fixtures/storage.mjs): `storage.rules` governs
// the default bucket — each user reads and writes their own folder (images
// under 5 MB, the write allow on line 6), anyone reads `public/`,
// `reports/` asks Firestore for the reader's plan — and
// `storage.media.rules` the media bucket. Requests "from the app" go
// straight to the Storage emulator's port with a token the Auth emulator
// minted. Every journey that changes the rules puts them back, file and all.

const SEVEN_MB = 7 * 1024 * 1024

const ada = person('ada')
const grace = person('grace')

/** The files the journeys read; every name is one the storage seed holds too. */
const FILES = [
  { name: `users/${ada.uid}/avatar.png`, size: 2048, contentType: 'image/png' },
  { name: `users/${grace.uid}/avatar.png`, size: 2048, contentType: 'image/png' },
  // More than twenty folders under users/, so the folders map groups them.
  ...Array.from({ length: 21 }, (_, index) => ({
    name: `users/u_${String(index).padStart(3, '0')}/avatar.png`,
    size: 1024,
    contentType: 'image/png',
  })),
  { name: 'public/logo.png', size: 4096, contentType: 'image/png' },
  { name: 'misc/blob.bin', size: 4096, contentType: 'application/octet-stream' },
  { name: 'reports/q3.pdf', size: 3000, contentType: 'application/pdf' },
]

test.beforeAll(async ({ engine }) => {
  const { default: bucket } = bucketsOf(engine)
  for (const file of FILES) await putFile(engine, { bucket, ...file })
})

/** A rules text with one line changed, for drafts that differ by a clause. */
function edited(source: string, from: string, to: string): string {
  if (!source.includes(from)) throw new Error(`no ${from} in the rules`)
  return source.replace(from, to)
}

async function openRules(page: Page, engine: Engine, query = '') {
  await page.goto(`${engine.origin}/console/storage/rules${query}`)
  await expect(page.getByTestId('rules-source')).toContainText('service firebase.storage')
}

const lines = (page: Page) => page.getByTestId('rules-source').locator('.cm-line')
const activeLine = (page: Page) => page.locator('.cm-lineNumbers .cm-activeLineGutter')

/** What the load watch needs of the page; this file is typed for Node, not the DOM. */
interface ProblemWatch {
  rulesSeen?: { errors: boolean }
  document: { querySelector(selector: string): unknown }
  MutationObserver: new (callback: () => void) => {
    observe(target: unknown, options: { childList: boolean; subtree: boolean }): void
  }
}

test('a bucket’s rules load as they are on disk, and the picker opens another bucket’s', async ({
  page,
  engine,
}) => {
  // Watch the whole load: no error may ever flash in the Problems strip.
  await page.addInitScript(() => {
    const browser = globalThis as unknown as ProblemWatch
    const seen = { errors: false }
    browser.rulesSeen = seen
    new browser.MutationObserver(() => {
      if (
        browser.document.querySelector('[data-testid="rules-diagnostics"] [data-severity="error"]')
      )
        seen.errors = true
    }).observe(browser.document, { childList: true, subtree: true })
  })
  const onDisk = readFileSync(join(engine.directory, 'storage.rules'), 'utf8')
  expect((await rulesNow(page, engine)).source).toBe(onDisk)
  await openRules(page, engine)
  await expect(page.getByTestId('rules-file')).toHaveText('storage.rules')
  await expect(page.getByTestId('rules-bucket').getByRole('combobox')).toContainText(
    bucketsOf(engine).default,
  )
  await expect(page.getByTestId('rules-source')).toContainText(
    'request.resource.contentType.matches',
  )
  await expect(lines(page)).toHaveCount(onDisk.split('\n').length)
  await expect(page.getByTestId('rules-draft-state')).toHaveCount(0)
  await page.waitForTimeout(1_000)
  expect(await page.evaluate(() => (globalThis as unknown as ProblemWatch).rulesSeen?.errors)).toBe(
    false,
  )

  // The media bucket has rules of its own: the picker goes there.
  await page.getByTestId('rules-bucket').getByRole('combobox').click()
  await page.getByRole('option', { name: new RegExp(bucketsOf(engine).media) }).click()
  await expect(page).toHaveURL(new RegExp(`bucket=${bucketsOf(engine).media}`))
  await expect(page.getByTestId('rules-file')).toHaveText('storage.media.rules')
  await expect(page.getByTestId('rules-source')).toContainText(
    'allow write: if request.auth != null;',
  )
})

test('the rules are checked as they are typed, with Storage’s own warnings', async ({
  page,
  engine,
}) => {
  await openRules(page, engine)
  const original = (await rulesNow(page, engine)).source
  const problems = page.getByTestId('rules-diagnostics')

  // Broken text says where, before anything is applied.
  await pasteRules(page, "rules_version = '2';\nservice firebase.storage { match")
  await expect(problems.locator('[data-severity="error"]').first()).toBeVisible()
  await expect(problems.locator('[data-severity="error"]').first()).toHaveText(/^\d+:\d+ /)
  await expect(page.getByTestId('rules-draft-state')).toHaveText('Draft · not applied')

  // An upload with no size check: the engine says so, on the write allow.
  await pasteRules(
    page,
    edited(original, '\n        && request.resource.size < 5 * 1024 * 1024', ''),
  )
  await expect(problems.locator('[data-severity="error"]')).toHaveCount(0)
  await page.getByRole('tab', { name: /Folders/ }).click()
  const unbounded = page.locator('[data-testid="rules-warning"][data-code="unbounded-upload"]')
  await expect(unbounded).toHaveCount(1)
  await expect(unbounded).toContainText('no size limit')
  await expect(page.getByTestId('tab-folders')).toContainText('2')
  // A warning is a way to its line.
  await unbounded.click()
  await expect(activeLine(page)).toHaveText(/^(6|7)$/)

  // A metadata change cannot change a file's size: no such warning for it.
  await pasteRules(
    page,
    edited(
      original,
      `      allow write: if request.auth != null && request.auth.uid == uid
        && request.resource.size < 5 * 1024 * 1024
        && request.resource.contentType.matches('image/.*');`,
      "      allow update: if request.auth != null && request.auth.uid == uid\n        && request.resource.contentType.matches('image/.*');",
    ),
  )
  await expect(page.locator('[data-testid="rules-warning"][data-code="open-access"]')).toHaveCount(
    1,
  )
  await expect(unbounded).toHaveCount(0)

  await page.getByTestId('rules-revert').click()
  await expect(page.getByTestId('rules-draft-state')).toHaveCount(0)
})

test('Apply puts a draft in force from the next request, Save writes the file once', async ({
  page,
  engine,
}) => {
  const { default: bucket } = bucketsOf(engine)
  const original = await rulesNow(page, engine)
  const token = await tokenFor(engine, ada.uid)
  const video = {
    bucket,
    name: `users/${ada.uid}/clip.mov`,
    size: 1024,
    contentType: 'video/quicktime',
    token,
  }
  try {
    await openRules(page, engine)
    expect((await upload(engine, video)).status).toBe(403)

    // Videos too: applied with ⌘↵, decided by it from the next request.
    const draft = edited(original.source, "matches('image/.*')", "matches('(image|video)/.*')")
    await pasteRules(page, draft)
    await page.keyboard.press('ControlOrMeta+Enter')
    await expect(page.getByText('Rules applied', { exact: true })).toBeVisible()
    await expect(page.getByTestId('rules-draft-state')).toHaveCount(0)
    await expect.poll(async () => (await upload(engine, video)).status).toBe(200)
    // Not on disk: applied, not saved.
    expect(readFileSync(original.path ?? '', 'utf8')).toBe(original.source)
    await expect(page.getByTestId('rules-unsaved')).toBeVisible()

    // ⌘S writes the file; History has one console version, no disk echo.
    await page.getByTestId('rules-source').click()
    await page.keyboard.press('ControlOrMeta+s')
    await expect(page.getByText('Rules applied and saved', { exact: true })).toBeVisible()
    await expect.poll(() => readFileSync(original.path ?? '', 'utf8')).toBe(draft)
    await expect(page.getByTestId('rules-unsaved')).toHaveCount(0)
    await page.waitForTimeout(1_500)
    await page.getByTestId('rules-history').click()
    const versions = page.getByTestId('history-version')
    await expect(versions.first()).toContainText('Applied in the console')
    await expect(versions.first()).toContainText('In force')
    await expect(versions.filter({ hasText: 'Changed on disk' })).toHaveCount(0)
    await expect(versions.filter({ hasText: 'Loaded at startup' })).toHaveCount(1)
    await page.keyboard.press('Escape')
  } finally {
    await removeFile(engine, video)
    await restoreRules(engine, original)
  }
})

test('the file on disk is followed: a change lands in the editor, a broken one keeps the rules', async ({
  page,
  engine,
}) => {
  const { default: bucket } = bucketsOf(engine)
  const original = await rulesNow(page, engine)
  const path = original.path ?? ''
  try {
    await openRules(page, engine)
    const changed = `${original.source}// changed in an editor\n`
    writeFileSync(path, changed)
    await expect(page.getByTestId('rules-source')).toContainText('// changed in an editor', {
      timeout: 5_000,
    })
    await page.getByTestId('rules-history').click()
    await expect(page.getByTestId('history-version').first()).toContainText('Changed on disk')
    await page.keyboard.press('Escape')

    // Saved broken: the rules in force stay, and the page says why.
    writeFileSync(path, `${original.source}\nmatch {`)
    const banner = page.getByTestId('rules-file-problems')
    await expect(banner).toBeVisible({ timeout: 5_000 })
    await expect(banner).toContainText('does not compile')
    await expect(page.getByTestId('rules-source')).not.toContainText('match {\n')
    // Still the previous rules: Grace may not read Ada's avatar.
    const token = await tokenFor(engine, grace.uid)
    expect(
      (await getMetadata(engine, { bucket, name: `users/${ada.uid}/avatar.png`, token })).status,
    ).toBe(403)
  } finally {
    await restoreRules(engine, original)
    await expect(page.getByTestId('rules-file-problems')).toHaveCount(0, { timeout: 5_000 })
  }
})

test('every decision is listed live, narrowed by the engine, and opens onto why', async ({
  page,
  engine,
  context,
}) => {
  const { default: bucket } = bucketsOf(engine)
  const token = await tokenFor(engine, ada.uid)
  const subscriptions: Array<{ topic: string; params: Record<string, unknown> }> = []
  context.on('request', (request) => {
    if (request.method() !== 'POST' || !/\/live\/[^/]+\/subscriptions$/.test(request.url())) return
    const body = request.postDataJSON() as {
      add: Array<{ topic: string; params: Record<string, unknown> }>
    }
    subscriptions.push(...body.add)
  })
  await openRules(page, engine)

  // The app: a read it may make, an upload too large, a folder it may not list.
  expect(
    (await getMetadata(engine, { bucket, name: `users/${ada.uid}/avatar.png`, token })).status,
  ).toBe(200)
  expect(
    (
      await upload(engine, {
        bucket,
        name: `users/${ada.uid}/big.mov`,
        size: SEVEN_MB,
        contentType: 'video/quicktime',
        token,
      })
    ).status,
  ).toBe(403)
  expect((await listFolder(engine, { bucket, prefix: `users/${grace.uid}/`, token })).status).toBe(
    403,
  )
  const rows = page.getByTestId('decision-row')
  await expect(rows.filter({ hasText: 'big.mov' })).toHaveCount(1)
  await expect(rows.filter({ hasText: 'avatar.png' }).first()).toBeVisible()
  await expect(rows.filter({ hasText: `users/${grace.uid}/` }).first()).toBeVisible()
  await expect(page.getByTestId('decisions-window')).toContainText(
    /Holding the last [\d,]+ decision/,
  )

  // Denied only: the engine is asked, and the address says so.
  await page.getByRole('tab', { name: 'Denied' }).click()
  await expect(page).toHaveURL(/denied=true/)
  await expect
    .poll(() =>
      subscriptions.some((sub) => sub.topic === 'storage.decisions' && sub.params.denied === true),
    )
    .toBe(true)
  for (const outcome of await rows
    .locator('[data-outcome]')
    .evaluateAll((items) => items.map((item) => item.getAttribute('data-outcome'))))
    expect(outcome).not.toBe('allow')

  // The upload that was too large, opened: who, the lines, and why with values.
  await rows.filter({ hasText: 'big.mov' }).first().click()
  const detail = page.getByTestId('decision-detail')
  await expect(detail.getByTestId('decision-path')).toHaveText(`users/${ada.uid}/big.mov`)
  await expect(detail.getByTestId('decision-who')).toContainText(ada.uid)
  await expect(detail.getByTestId('decision-who')).toContainText(ada.email)
  await expect(page.getByTestId('decision-lines')).toContainText('line 6')
  await expect(lines(page).nth(5)).toHaveClass(/cm-line-deny/)
  const why = detail.getByTestId('decision-why')
  await expect(why.getByTestId('explained-allow').first()).toContainText('line 6')
  await expect(why).toContainText('request.resource.size')
  await expect(why).toContainText('7340032')
  await expect(
    page.getByTestId('rules-source').locator('[data-inline-value]').first(),
  ).toBeVisible()
  await expect(detail.getByTestId('decision-proposed')).toContainText('video/quicktime')
  const id = new URL(page.url()).searchParams.get('decision')
  expect(id).toMatch(/^s\d+$/)

  // A link to the decision and its line, in a new page.
  const other = await context.newPage()
  await other.goto(`${engine.origin}/console/storage/rules?decision=${id}&line=6`)
  await expect(other.getByTestId('decision-detail')).toBeVisible()
  await expect(other.locator('.cm-lineNumbers .cm-activeLineGutter')).toHaveText('6')
  await expect(other).not.toHaveURL(/line=/)
  await other.close()

  // Narrowed to one folder, through the engine again.
  await page.getByTestId('decision-back').click()
  await page.getByRole('tab', { name: 'All' }).click()
  await page.getByTestId('decisions-path').fill(`users/${grace.uid}/`)
  await page.getByTestId('decisions-path').press('Enter')
  await expect(page).toHaveURL(/path=users%2F/)
  await expect(rows.first()).toBeVisible()
  for (const path of await rows.locator('bdi').allTextContents())
    expect(path.startsWith(`users/${grace.uid}/`)).toBe(true)
  await page.getByTestId('decisions-clear').click()
  await expect(page).not.toHaveURL(/path=/)
})

test('the playground tries an upload against the draft, and a saved test guards it', async ({
  page,
  engine,
}) => {
  await openRules(page, engine, '?panel=playground')
  const original = (await rulesNow(page, engine)).source

  // 7 MB of video as Ada: denied, by the write allow on line 6.
  await page.getByRole('tab', { name: 'create' }).click()
  await page.getByTestId('playground-path').fill(`users/${ada.uid}/big.mov`)
  await page.getByTestId('playground-who').click()
  await page.getByTestId('playground-who-user').filter({ hasText: ada.email }).click()
  await page.getByTestId('playground-size').fill('7')
  await page.getByTestId('playground-type').getByRole('combobox').fill('video/quicktime')
  await page.getByTestId('playground-run').click()
  const result = page.getByTestId('playground-result')
  await expect(result.locator('[data-outcome]').first()).toHaveAttribute(
    'data-outcome',
    /deny|error/,
  )
  await expect(result.getByTestId('explained-allow').first()).toContainText('line 6')
  await expect(result).toContainText('7340032')
  await expect(lines(page).nth(5)).toHaveClass(/cm-line-(deny|error)/)

  // Saved as a test that should deny: it passes against the rules in force.
  await page.getByTestId('playground-save-test').click()
  await page.getByRole('tab', { name: /Tests/ }).click()
  await expect(page.getByTestId('test-case')).toHaveCount(1)
  await expect(page.getByTestId('test-case')).toHaveAttribute('data-pass', 'true')

  // A draft that lets video and larger files through: allowed before Apply,
  // and the saved test goes red against it.
  const draft = edited(
    edited(original, "matches('image/.*')", "matches('(image|video)/.*')"),
    '5 * 1024 * 1024',
    '50 * 1024 * 1024',
  )
  await pasteRules(page, draft)
  await expect(page.getByTestId('test-case')).toHaveAttribute('data-pass', 'false')
  await expect(page.getByTestId('tab-tests')).toContainText('1')
  await expect(page.getByTestId('rules-tests-failing')).toContainText('1 of 1 saved test')
  await page.getByRole('tab', { name: 'Playground' }).click()
  await expect(result.locator('[data-outcome]').first()).toHaveAttribute('data-outcome', 'allow')

  // And it leaves as a rules-unit-testing file for CI.
  await page.getByRole('tab', { name: /Tests/ }).click()
  await page.getByTestId('tests-share').click()
  const downloading = page.waitForEvent('download')
  await page.getByTestId('tests-download').click()
  const download = await downloading
  expect(download.suggestedFilename()).toBe('storage.rules.test.ts')
  const file = readFileSync(await download.path(), 'utf8')
  expect(file).toContain("from '@firebase/rules-unit-testing'")
  expect(file).toContain('assertFails(uploadBytes(')
  expect(file).toContain(`new Uint8Array(${SEVEN_MB})`)
  expect(file).toContain(`env.authenticatedContext("${ada.uid}"`)

  // Leave nothing behind.
  await page.getByRole('button', { name: /^Delete / }).click({ force: true })
  await expect(page.getByTestId('test-case')).toHaveCount(0)
  await page.getByTestId('rules-revert').click()
})

test('a draft that would deny what was allowed says so, and shows those decisions', async ({
  page,
  engine,
}) => {
  const { default: bucket } = bucketsOf(engine)
  await openRules(page, engine)
  const original = (await rulesNow(page, engine)).source
  expect((await getMetadata(engine, { bucket, name: 'public/logo.png' })).status).toBe(200)
  await expect(
    page.getByTestId('decision-row').filter({ hasText: 'public/logo.png' }).first(),
  ).toBeVisible()

  await pasteRules(page, edited(original, '      allow read;\n', '      allow read: if false;\n'))
  const impact = page.getByTestId('rules-impact')
  await expect(impact).toContainText(/deny \d+ requests? that w(as|ere) allowed/)
  await impact.getByRole('button', { name: 'Show them' }).click()
  await expect(page).toHaveURL(/flips=true/)
  await expect(page.getByTestId('decisions-narrowed')).toContainText('Would change')
  const flips = page.getByTestId('decision-flip')
  await expect(flips.first()).toContainText('denied by the draft')
  await expect(
    page.getByTestId('decision-row').filter({ hasText: 'public/logo.png' }).first(),
  ).toBeVisible()
  await page.getByTestId('rules-revert').click()
  await expect(impact).toHaveCount(0)
})

test('coverage draws how often each condition ran, from the engine’s report', async ({
  page,
  engine,
}) => {
  const { default: bucket } = bucketsOf(engine)
  const token = await tokenFor(engine, ada.uid)
  expect(
    (await getMetadata(engine, { bucket, name: `users/${ada.uid}/avatar.png`, token })).status,
  ).toBe(200)
  await openRules(page, engine)
  const coverage = await page.request.get(`${engine.origin}/console/api/v1/storage/rules/coverage`)
  expect(coverage.ok()).toBeTruthy()
  const report = (await coverage.json()) as { report?: unknown[] }
  expect(report.report?.length ?? 0).toBeGreaterThan(0)

  const toggle = page.getByTestId('rules-coverage')
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click()
  await expect(toggle).toHaveText(/\d+\/\d+ ran/)
  const hit = page.locator('.cm-note-hit').first()
  await expect(hit).toHaveText(/^\d+×$/)
  await expect(hit).toHaveAttribute('title', /Ran \d+ times?/)
  await expect(page.locator('.cm-note-miss').first()).toHaveText('never')
  await toggle.click()
  await expect(page.locator('.cm-note-hit')).toHaveCount(0)
  await toggle.click()
  await expect(page.locator('.cm-note-hit').first()).toBeVisible()
})

test('the folders map says which rules govern which files, and writes starter rules', async ({
  page,
  engine,
}) => {
  const { default: bucket } = bucketsOf(engine)
  const deep = {
    bucket,
    name: `users/${ada.uid}/uploads/2026/x.png`,
    size: 512,
    contentType: 'image/png',
  }
  await openRules(page, engine, '?panel=folders')
  const original = (await rulesNow(page, engine)).source
  try {
    const map = page.getByTestId('rules-map')
    await expect(map).toBeVisible({ timeout: 10_000 })
    await expect(map).toContainText('Levels with more than 20 folders are grouped')
    const users = page.locator('[data-testid="rules-folder"][data-pattern="users/*/"]')
    await expect(users).toBeVisible()
    await expect(users.getByTestId('rules-folder-block')).toContainText('line 4: read, write')
    const misc = page.locator('[data-testid="rules-folder"][data-pattern="misc/"]')
    await expect(misc).toHaveAttribute('data-uncovered', 'true')
    await expect(misc).toContainText('every client request is denied')

    // A file four levels down, under a match of one segment: not governed.
    await putFile(engine, deep)
    await pasteRules(page, edited(original, '{uid}/{allPaths=**}', '{uid}/{file}'))
    const uploads = page.locator(
      '[data-testid="rules-folder"][data-pattern="users/*/uploads/2026/"]',
    )
    await expect(uploads).toHaveAttribute('data-uncovered', 'true', { timeout: 10_000 })
    await page.getByTestId('rules-revert').click()

    // Starter rules from the bucket's own files, for the folder no rule covers.
    await page.getByTestId('rules-starter-menu').click()
    await page.getByTestId('rules-starter-data').click()
    await expect(page.getByTestId('rules-source')).toContainText('match /misc/')
    await expect(page.getByTestId('rules-draft-state')).toBeVisible()
    await expect(misc).not.toHaveAttribute('data-uncovered', 'true', { timeout: 10_000 })
  } finally {
    await removeFile(engine, deep)
    await page.getByTestId('rules-revert').click()
  }
})

test('history diffs any version against the editor and puts one back as the draft', async ({
  page,
  engine,
}) => {
  const original = await rulesNow(page, engine)
  try {
    await openRules(page, engine)
    const applied = `${original.source}// a version to go back from\n`
    await pasteRules(page, applied)
    await page.getByTestId('rules-apply').click()
    await expect(page.getByTestId('rules-draft-state')).toHaveCount(0)
    await page.getByTestId('rules-history').click()
    const versions = page.getByTestId('history-version')
    // Applied, not saved: the file on disk is listed first, as what differs.
    await expect(versions.first()).toContainText('The file on disk')
    await expect(versions.filter({ hasText: 'Applied in the console' }).first()).toContainText(
      'In force',
    )
    await versions.filter({ hasText: 'Loaded at startup' }).click()
    const diff = page.getByTestId('history-diff')
    await expect(diff.locator('[data-kind="added"]')).toContainText('// a version to go back from')
    await page.getByTestId('history-restore').click()
    await expect(page.getByTestId('rules-draft-state')).toHaveText('Draft · not applied')
    await expect(page.getByTestId('rules-source')).not.toContainText('a version to go back from')
  } finally {
    await restoreRules(engine, original)
  }
})

test('rules that read Firestore are judged with the document, and say what it held', async ({
  page,
  engine,
}) => {
  const { default: bucket } = bucketsOf(engine)
  await commit(engine, [{ path: `users/${ada.uid}`, fields: { plan: text('pro') } }])
  try {
    const token = await tokenFor(engine, ada.uid)
    expect((await getMetadata(engine, { bucket, name: 'reports/q3.pdf', token })).status).toBe(200)
    expect((await getMetadata(engine, { bucket, name: 'reports/q3.pdf' })).status).toBe(403)

    await openRules(page, engine, '?path=reports%2Fq3.pdf&denied=true&pick=true')
    const detail = page.getByTestId('decision-detail')
    await expect(detail).toBeVisible()
    await expect(detail.getByTestId('decision-who')).toContainText('Not signed in')
    await expect(page.getByTestId('decision-lines')).toContainText('line 14')
    await expect(detail.getByTestId('decision-why')).toContainText(/firestore\.get|null/)
    await expect(detail.getByTestId('decision-why')).toContainText('firestore.get()')
  } finally {
    const response = await ownerFetch(engine, `${documentsOf(engine)}/users/${ada.uid}`, {
      method: 'DELETE',
    })
    expect(response.ok).toBe(true)
  }
})

test('a bucket no rules serve says so, and ⌘K reaches every part of the page', async ({
  page,
  engine,
}) => {
  const unlisted = `${engine.project}-unlisted`
  await page.goto(`${engine.origin}/console/storage/rules?bucket=${unlisted}`)
  const banner = page.getByTestId('rules-not-served')
  await expect(banner).toContainText(`No rules govern gs://${unlisted}`)
  await expect(banner).toContainText('the Admin SDK included')
  await expect(page.getByTestId('rules-save')).toBeDisabled()

  await openRules(page, engine)
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByTestId('palette-input').fill('playground')
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/panel=playground/)
  await expect(page.getByTestId('playground')).toBeVisible()
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByTestId('palette-input').fill('rules history')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('history-versions')).toBeVisible()
  await page.keyboard.press('Escape')
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByTestId('palette-input').fill('folders')
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/panel=folders/)
})
