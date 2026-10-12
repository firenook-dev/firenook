import { readFileSync, writeFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

// The security rules page, against the real engine and the synthetic
// project's rules file (scripts/synthetic-engine.mjs). Every journey that
// changes the rules puts them back, file and all, before it ends: the data
// journeys read through these rules.

const origin = () => {
  const value = process.env.FIRENOOK_CONSOLE_ORIGIN
  if (!value) throw new Error('the worker engine did not start')
  return value
}
const api = (path: string) => `${origin()}/console/api/v1/firestore/${path}`

interface RulesNow {
  source: string
  path: string | null
  hash: string
  fileSource: string | null
}

async function rulesNow(page: Page): Promise<RulesNow> {
  const response = await page.request.get(api('rules?database=(default)'))
  expect(response.ok()).toBeTruthy()
  return (await response.json()) as RulesNow
}

/** Put the rules in force back, and the file on disk with them. */
async function restore(page: Page, original: RulesNow) {
  if (original.path) writeFileSync(original.path, original.source)
  await page.request.put(api('rules'), {
    data: { database: '(default)', source: original.source, save: false },
  })
}

/**
 * Replace the editor's text the way a person pastes it: typing would meet
 * the editor's own bracket closing and indenting.
 */
async function pasteRules(page: Page, text: string) {
  const editor = page.getByTestId('rules-source')
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

const OPEN = [
  "rules_version = '2';",
  'service cloud.firestore {',
  '  match /databases/{database}/documents {',
  '    match /{document=**} {',
  '      allow read, write: if true;',
  '    }',
  '  }',
  '}',
].join('\n')

test('rules are a page of their own under Firestore, beside Data', async ({ page }) => {
  await page.goto(`${origin()}/console/firestore?path=users`)
  const nav = page.getByTestId('primary-nav')
  await expect(nav.getByTestId('nav-page-data')).toHaveAttribute('data-active', 'true')
  // The data toolbar no longer carries a Rules button among View as and New.
  await expect(page.getByTestId('toolbar')).toBeVisible()
  await expect(page.getByTestId('open-rules')).toHaveCount(0)
  // Nor a Requests drawer at the foot of the page.
  await expect(page.getByTestId('requests-drawer')).toHaveCount(0)

  await nav.getByTestId('nav-page-rules').click()
  await expect(page).toHaveURL(/\/console\/firestore\/rules$/)
  await expect(nav.getByTestId('nav-page-rules')).toHaveAttribute('data-active', 'true')
  await expect(nav.getByTestId('nav-page-data')).not.toHaveAttribute('data-active', 'true')
  await expect(page.getByTestId('rules-source')).toContainText('allow read: if request.auth')
  // The database the rules belong to, and the file they are saved to.
  await expect(
    page.getByTestId('rules-toolbar').getByRole('combobox', { name: 'Database' }),
  ).toContainText('(default)')
  await expect(page.getByTestId('rules-file')).toHaveText('firestore.rules')
  // Highlighted as the rules language, not as plain text.
  await expect(page.getByTestId('rules-source').locator('span').first()).toBeVisible()

  // The old addresses still lead here.
  await page.goto(`${origin()}/console/firestore?view=rules`)
  await expect(page).toHaveURL(/\/console\/firestore\/rules/)
  await page.goto(`${origin()}/console/requests`)
  await expect(page).toHaveURL(/\/console\/firestore\/rules/)

  // And ⌘K knows it.
  await page.goto(`${origin()}/console/firestore`)
  await expect(page.getByTestId('toolbar')).toBeVisible()
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByTestId('palette-input').fill('security rules')
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/console\/firestore\/rules/)
})

test('the rules are checked as they are typed, and a draft is not in force until applied', async ({
  page,
}) => {
  const original = await rulesNow(page)
  try {
    await page.goto(`${origin()}/console/firestore/rules`)
    await expect(page.getByTestId('rules-source')).toContainText('allow read')

    // Broken text says where, before anything is applied.
    await pasteRules(page, 'service cloud.firestore { match')
    const problems = page.getByTestId('rules-diagnostics')
    await expect(problems.locator('[data-severity="error"]').first()).toBeVisible()
    await expect(problems).toContainText(/^\d+:\d+ /)
    await expect(page.getByTestId('rules-draft-state')).toHaveText('Draft · not applied')

    // Open to everyone: it compiles, and the engine says what that means.
    await pasteRules(page, OPEN)
    await expect(problems.locator('[data-severity="error"]')).toHaveCount(0)
    await expect(problems.locator('[data-severity="warning"]')).toContainText(
      'Anyone, signed in or not',
    )
    await page.getByRole('tab', { name: /Collections/ }).click()
    await expect(page.getByTestId('rules-warning').first()).toHaveAttribute(
      'data-code',
      'open-access',
    )

    // A draft outlives a trip to the data page and back.
    await page.getByTestId('primary-nav').getByTestId('nav-page-data').click()
    await expect(page.getByTestId('toolbar')).toBeVisible()
    await page.getByTestId('primary-nav').getByTestId('nav-page-rules').click()
    await expect(page.getByTestId('rules-source')).toContainText('allow read, write: if true')
    expect((await rulesNow(page)).source).toBe(original.source)

    // ⌘↵ applies it: in force from the next request.
    await page.getByTestId('rules-source').click()
    await page.keyboard.press('ControlOrMeta+Enter')
    await expect(page.getByRole('heading', { name: 'Rules applied' })).toBeVisible()
    await expect(page.getByTestId('rules-draft-state')).toHaveCount(0)
    expect((await rulesNow(page)).source).toBe(OPEN)
    await page.goto(`${origin()}/console/firestore?path=users&as=anonymous`)
    await expect(page.getByTestId('grid-row').first()).toBeVisible()

    // Applied, not saved: the file on disk is still the old text.
    await page.goto(`${origin()}/console/firestore/rules`)
    await expect(page.getByTestId('rules-unsaved')).toBeVisible()

    // Revert throws a draft away.
    await pasteRules(page, `${OPEN}\n// a thought`)
    await expect(page.getByTestId('rules-draft-state')).toBeVisible()
    await page.getByTestId('rules-revert').click()
    await expect(page.getByTestId('rules-draft-state')).toHaveCount(0)
    await expect(page.getByTestId('rules-source')).not.toContainText('a thought')
  } finally {
    await restore(page, original)
  }
})

test('a denied read links to the decision behind it, drawn into the rules', async ({ page }) => {
  await page.goto(`${origin()}/console/firestore?path=users&as=anonymous`)
  await expect(page.getByText('Denied by security rules')).toBeVisible()
  await page.getByTestId('see-why').click()
  await expect(page).toHaveURL(/\/console\/firestore\/rules\?.*denied=true/)
  const detail = page.getByTestId('decision-detail')
  await expect(detail).toBeVisible()
  await expect(page.getByTestId('decision-path')).toHaveText('users')
  await expect(detail).toContainText('Not signed in')
  await expect(page.getByTestId('decision-lines')).toContainText('line 5')
  // The lines that refused it are lit in the editor.
  const lines = page.getByTestId('rules-source').locator('.cm-line')
  await expect(lines.nth(4)).toHaveClass(/cm-line-deny/)

  // Back to the list: narrowed to the path and to denials, as the link asked
  // — and it stays the list. The link picks a decision once; it used to pick
  // again the moment the list came back, so "All decisions" bounced.
  await page.getByTestId('decision-back').click()
  await page.waitForTimeout(500)
  await expect(page).not.toHaveURL(/decision=/)
  await expect(page.getByTestId('decision-detail')).toHaveCount(0)
  await expect(page.getByTestId('decisions-narrowed')).toContainText('users')
  const rows = page.getByTestId('decision-row')
  await expect(rows.first()).toBeVisible()
  for (const outcome of await rows
    .locator('[data-outcome]')
    .evaluateAll((items) => items.map((item) => item.getAttribute('data-outcome'))))
    expect(outcome).not.toBe('allow')

  // How often each rule has run, in the gutter, and gone when asked.
  await expect(page.locator('.cm-note-hit').first()).toHaveText(/^\d+×$/)
  await page.getByTestId('rules-coverage').click()
  await expect(page.locator('.cm-note-hit')).toHaveCount(0)
  await page.getByTestId('rules-coverage').click()
  await expect(page.locator('.cm-note-hit').first()).toBeVisible()

  // An empty list says what appears here, and what never does.
  await page.getByRole('button', { name: 'Clear the list' }).click()
  await expect(page.getByTestId('decisions-empty')).toContainText('The Admin SDK')
  // And a database with no rules file says nothing is checked at all.
  await page.goto(`${origin()}/console/firestore/rules?db=nobody-here`)
  await expect(page.getByTestId('rules-not-enforced')).toBeVisible()
  await expect(page.getByTestId('decisions-empty')).toContainText('no rules loaded')
})

test('history keeps every version, and the file on disk is watched', async ({ page }) => {
  const original = await rulesNow(page)
  expect(original.path).toBeTruthy()
  const file = original.path as string
  try {
    await page.goto(`${origin()}/console/firestore/rules`)
    await expect(page.getByTestId('rules-source')).toContainText('allow read')
    await pasteRules(page, `${original.source}// applied here\n`)
    await page.getByTestId('rules-apply').click()
    await expect(page.getByRole('heading', { name: 'Rules applied' })).toBeVisible()

    await page.getByTestId('rules-history').click()
    const versions = page.getByTestId('history-version')
    await expect(versions.first()).toContainText('The file on disk')
    await expect(page.getByTestId('history-versions')).toContainText('Applied in the console')
    await expect(page.getByTestId('history-versions')).toContainText('Loaded at startup')
    // The file still has the startup text, so against the editor the
    // applied line is the difference.
    await expect(page.getByTestId('history-diff').locator('[data-kind="added"]')).toContainText(
      'applied here',
    )
    await page.getByTestId('history-restore').click()
    await expect(page.getByTestId('rules-source')).not.toContainText('applied here')
    await page.getByTestId('rules-apply').click()
    await expect(page.getByRole('heading', { name: 'Rules applied' }).first()).toBeVisible()
    await expect(page.getByTestId('rules-unsaved')).toHaveCount(0)

    // Edited on disk, as an editor would: in force, and on screen, without a reload.
    writeFileSync(file, `${original.source}// changed on disk\n`)
    await expect(page.getByTestId('rules-source')).toContainText('changed on disk', {
      timeout: 15_000,
    })
    await expect.poll(async () => (await rulesNow(page)).source).toContain('changed on disk')
    await page.getByTestId('rules-history').click()
    await expect(page.getByTestId('history-versions')).toContainText('Changed on disk')
    await page.keyboard.press('Escape')

    // A file that does not compile leaves the rules in force alone, and says so.
    writeFileSync(file, 'service cloud.firestore {')
    await expect(page.getByTestId('rules-file-problems')).toBeVisible({ timeout: 15_000 })
    expect((await rulesNow(page)).source).toContain('changed on disk')
    await page.getByTestId('rules-file-problems').getByRole('button').click()
    await expect(
      page.getByTestId('rules-diagnostics').locator('[data-severity="error"]').first(),
    ).toBeVisible()
  } finally {
    await restore(page, original)
    expect(readFileSync(file, 'utf8')).toBe(original.source)
  }
})

test('a collection no rule covers gets starter rules drawn from its documents', async ({
  page,
}) => {
  await page.goto(`${origin()}/console/firestore/rules`)
  await expect(page.getByTestId('rules-source')).toContainText('allow read')
  // Rules for users alone: everything else in the data is uncovered.
  await pasteRules(
    page,
    [
      "rules_version = '2';",
      'service cloud.firestore {',
      '  match /databases/{database}/documents {',
      '    match /users/{uid} {',
      '      allow read: if request.auth != null && request.auth.uid == uid;',
      '    }',
      '  }',
      '}',
    ].join('\n'),
  )
  await page.getByRole('tab', { name: /Collections/ }).click()
  const products = page.locator('[data-testid="rules-collection"][data-pattern="products"]')
  await expect(products).toHaveAttribute('data-uncovered', 'true')
  await products.getByTestId('rules-starter').click()
  await expect(page.getByTestId('rules-source')).toContainText('match /products/{productId}')
  // What it wrote compiles, and the collection is covered by it.
  await expect(products).not.toHaveAttribute('data-uncovered', 'true')
  await expect(
    page.getByTestId('rules-diagnostics').locator('[data-severity="error"]'),
  ).toHaveCount(0)
  // Nothing was applied.
  await expect(page.getByTestId('rules-draft-state')).toBeVisible()
  await page.getByTestId('rules-revert').click()
})

test('the playground tries a request against the draft, and a saved test guards it', async ({
  page,
}) => {
  await page.goto(`${origin()}/console/firestore/rules?panel=playground`)
  await expect(page.getByTestId('rules-source')).toContainText('allow read')
  await page.getByTestId('playground-path').fill('users/u_k65eq')
  await page.getByTestId('playground-run').click()
  const result = page.getByTestId('playground-result')
  await expect(result.locator('[data-outcome]').first()).toHaveAttribute(
    'data-outcome',
    /deny|error/,
  )
  // Why, line by line, and the values written into the editor.
  await expect(page.getByTestId('explained-allow').first()).toContainText('line 5')
  await expect(
    page.getByTestId('rules-source').locator('[data-inline-value]').first(),
  ).toBeVisible()
  await expect(page.getByTestId('rules-source').locator('.cm-line').nth(4)).toHaveClass(
    /cm-line-(deny|error)/,
  )

  // The owner herself: allowed, and saved as a test that should allow.
  await page.getByRole('combobox', { name: 'Who is asking' }).click()
  await page.getByRole('option', { name: 'Someone else…' }).click()
  await page.getByTestId('playground-uid').fill('u_k65eq')
  await page.getByTestId('playground-run').click()
  await expect(result.locator('[data-outcome]').first()).toHaveAttribute('data-outcome', 'allow')
  await page.getByTestId('playground-save-test').click()
  await page.getByRole('tab', { name: /Tests/ }).click()
  await expect(page.getByTestId('test-case')).toHaveCount(1)
  await expect(page.getByTestId('test-case')).toHaveAttribute('data-pass', 'true')

  // A draft that breaks it: red before anything is applied.
  const original = (await rulesNow(page)).source
  await pasteRules(page, original.replaceAll('request.auth.uid == uid', 'false'))
  await expect(page.getByTestId('test-case')).toHaveAttribute('data-pass', 'false')
  await expect(page.getByTestId('tab-tests')).toContainText('1')
  await expect(page.getByTestId('rules-tests-failing')).toContainText('1 of 1 saved test')
  await page.getByTestId('rules-revert').click()
  await expect(page.getByTestId('test-case')).toHaveAttribute('data-pass', 'true')

  // And it leaves as a rules-unit-testing file for CI.
  await page.getByTestId('tests-share').click()
  const downloading = page.waitForEvent('download')
  await page.getByTestId('tests-download').click()
  const download = await downloading
  expect(download.suggestedFilename()).toBe('firestore.rules.test.ts')
  const text = readFileSync(await download.path(), 'utf8')
  expect(text).toContain("from '@firebase/rules-unit-testing'")
  expect(text).toContain('env.authenticatedContext("u_k65eq"')
  expect(text).toContain('await assertSucceeds(getDoc(doc(db, "users/u_k65eq")))')
  expect(text).toContain('await setDoc(doc(db, "users/u_k65eq"), {')

  // Leave no tests behind for the next journey.
  await page.getByRole('button', { name: /^Delete / }).click({ force: true })
  await expect(page.getByTestId('test-case')).toHaveCount(0)
})

test('a list the rules cannot prove from its filters says which filter it needs', async ({
  page,
}) => {
  await page.goto(`${origin()}/console/firestore/rules?panel=playground`)
  await expect(page.getByTestId('rules-source')).toContainText('allow read')
  await pasteRules(
    page,
    [
      "rules_version = '2';",
      'service cloud.firestore {',
      '  match /databases/{database}/documents {',
      '    match /users/{uid} {',
      "      allow list: if resource.data.plan == 'pro';",
      '    }',
      '  }',
      '}',
    ].join('\n'),
  )
  await page.getByRole('tab', { name: 'list' }).click()
  await page.getByTestId('playground-path').fill('users')
  await page.getByTestId('playground-run').click()
  await expect(page.getByTestId('query-reason')).toContainText('plan')
  await page.getByTestId('playground-query').fill('where("plan", "==", "pro")')
  await page.getByTestId('playground-run').click()
  await expect(
    page.getByTestId('playground-result').locator('[data-outcome]').first(),
  ).toHaveAttribute('data-outcome', 'allow')
  await expect(page.getByTestId('query-reason')).toHaveCount(0)
  await page.getByTestId('rules-revert').click()
})

test('a decision opens onto why, and a draft says which decisions it would turn around', async ({
  page,
}) => {
  await page.goto(`${origin()}/console/firestore?path=users&as=anonymous`)
  await page.getByTestId('see-why').click()
  const detail = page.getByTestId('decision-detail')
  await expect(detail.getByTestId('explanation')).toBeVisible()
  await expect(detail.getByTestId('explained-allow').first()).toContainText('line 5')
  await expect(
    page.getByTestId('rules-source').locator('[data-inline-value]').first(),
  ).toBeVisible()

  // Tried again in the playground, as it was recorded.
  await detail.getByTestId('decision-try').click()
  await expect(page).toHaveURL(/panel=playground/)
  await expect(page.getByTestId('playground-path')).toHaveValue('users')
  await page.getByTestId('playground-run').click()
  await expect(
    page.getByTestId('playground-result').locator('[data-outcome]').first(),
  ).toHaveAttribute('data-outcome', /deny|error/)

  // A draft that opens everything would allow what was denied.
  await page.getByRole('tab', { name: 'Decisions' }).click()
  await pasteRules(page, OPEN)
  const impact = page.getByTestId('rules-impact')
  await expect(impact).toContainText('allow')
  await impact.getByRole('button', { name: 'Show them' }).click()
  await expect(page.getByTestId('decisions-narrowed')).toContainText('Would change')
  await expect(page.getByTestId('decision-flip').first()).toContainText('allowed by the draft')
  await page.getByTestId('rules-revert').click()
  await expect(impact).toHaveCount(0)
})
