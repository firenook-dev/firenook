import { readFileSync, writeFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'
import {
  brokenTextSaysWhere,
  coverageOnlyWhenAsked,
  coverageReads,
  historyPutsAVersionBack,
  paletteReachesEveryPart,
  pasteRules,
} from './support/rules'
import { documentsOf } from './support/shell'

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
    await brokenTextSaysWhere(page, 'service cloud.firestore { match')
    const problems = page.getByTestId('rules-diagnostics')

    // Open to everyone: it compiles, and the engine says what that means.
    await pasteRules(page, OPEN)
    await expect(problems.locator('[data-severity="error"]')).toHaveCount(0)
    await expect(problems.locator('[data-severity="warning"]')).toContainText(
      'Anyone, signed in or not',
    )
    await expect(problems.locator('[data-severity="warning"]').first()).toHaveAttribute(
      'data-code',
      'open-access',
    )
    // The strip is the one place warnings are listed: the map panel lists the data.
    await page.getByRole('tab', { name: /Collections/ }).click()
    await expect(page.getByTestId('rules-map')).toBeVisible()
    await expect(page.getByRole('tab', { name: 'Collections' })).toHaveText('Collections')

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

test('a denied read says why where it happened, and opens the decision in Rules', async ({
  page,
}) => {
  // Coverage is off until asked for, and nothing reads the report meanwhile.
  const reads = coverageReads(page, /:ruleCoverage/)
  await page.goto(`${origin()}/console/firestore?path=users&as=anonymous`)
  await expect(page.getByText('Denied by security rules')).toBeVisible()
  // "See why" explains it on the data page: the lines that refused it and
  // the values they saw, as the Files page does.
  await page.getByTestId('see-why').click()
  const why = page.getByTestId('refusal-detail')
  await expect(why.getByTestId('explained-allow').first()).toContainText('line 5')
  await why.getByTestId('refusal-open-rules').click()
  await expect(page).toHaveURL(/\/console\/firestore\/rules\?.*decision=/)
  const detail = page.getByTestId('decision-detail')
  await expect(detail).toBeVisible()
  await expect(page.getByTestId('decision-path')).toHaveText('users')
  await expect(detail).toContainText('Not signed in')
  await expect(detail).toContainText('from the console')
  await expect(page.getByTestId('decision-lines')).toContainText('line 5')
  // The lines that refused it are lit in the editor.
  const lines = page.getByTestId('rules-source').locator('.cm-line')
  await expect(lines.nth(4)).toHaveClass(/cm-line-deny/)
  // And the collection it was about is one click away in Data.
  await expect(detail.getByTestId('decision-open-data')).toBeVisible()

  // A link narrowed to the path and to denials picks the newest once, and
  // going back is the list — it stays the list, narrowed as the link asked.
  await page.goto(`${origin()}/console/firestore/rules?path=users&denied=true&pick=true`)
  await expect(page.getByTestId('decision-detail')).toBeVisible()
  await page.getByTestId('decision-back').click()
  await page.waitForTimeout(500)
  await expect(page).not.toHaveURL(/decision=/)
  await expect(page.getByTestId('decision-detail')).toHaveCount(0)
  await expect(page.getByTestId('decisions-filter')).toHaveValue('users')
  const rows = page.getByTestId('decision-row')
  await expect(rows.first()).toBeVisible()
  for (const outcome of await rows
    .locator('[data-outcome]')
    .evaluateAll((items) => items.map((item) => item.getAttribute('data-outcome'))))
    expect(outcome).not.toBe('allow')

  // How often each rule has run, in the gutter once asked for, and gone again.
  await coverageOnlyWhenAsked(page, reads)

  // An empty list says what appears here, and what never does.
  await page.goto(`${origin()}/console/firestore/rules`)
  await expect(page.getByTestId('decision-row').first()).toBeVisible()
  await page.getByRole('button', { name: 'Clear the list' }).click()
  await expect(page.getByTestId('decisions-empty')).toContainText('The Admin SDK')
  // And a database with no rules file says nothing is checked at all.
  await page.goto(`${origin()}/console/firestore/rules?db=nobody-here`)
  await expect(page.getByTestId('rules-not-enforced')).toBeVisible()
  await expect(page.getByTestId('decisions-empty')).toContainText('no rules loaded')
})

test('every tab reads the decisions, and a denial hundreds of decisions old still says why', async ({
  page,
  context,
  engine,
}) => {
  // One denial, then more decisions than the Requests feed ever held (256
  // for ten minutes, four clients): anonymous reads of users the rules
  // refuse, as an app's client makes them.
  const read = (id: string) =>
    fetch(`${engine.origin}/console/api/v1${documentsOf(engine)}/users/${id}`)
  const stamp = Date.now()
  const old = `u_old_${stamp}`
  expect((await read(old)).status).toBe(403)
  for (let index = 0; index < 300; index += 30)
    await Promise.all(
      Array.from({ length: 30 }, (_, offset) => read(`u_fill_${stamp}_${index + offset}`)),
    )

  // Five tabs at once — the Requests socket refused the fifth — each finds
  // the old denial and the engine runs it again for why.
  const tabs = [page, ...(await Promise.all(Array.from({ length: 4 }, () => context.newPage())))]
  const link = `${origin()}/console/firestore/rules?${new URLSearchParams({ path: `users/${old}`, denied: 'true', pick: 'true' })}`
  await Promise.all(tabs.map((tab) => tab.goto(link)))
  for (const tab of tabs) {
    const detail = tab.getByTestId('decision-detail')
    await expect(tab.getByTestId('decision-path')).toHaveText(`users/${old}`)
    await expect(detail.getByTestId('explained-allow').first()).toContainText('line 5')
    await expect(detail.getByTestId('decision-not-retained')).toHaveCount(0)
  }
  await Promise.all(tabs.slice(1).map((tab) => tab.close()))
  // The window says what the engine holds.
  await page.getByTestId('decision-back').click()
  await expect(page.getByTestId('decisions-window')).toContainText(
    /Holding the last [\d,]+ decisions/,
  )
})

test('history keeps every version, and the file on disk is watched', async ({ page }) => {
  const original = await rulesNow(page)
  expect(original.path).toBeTruthy()
  const file = original.path as string
  try {
    await page.goto(`${origin()}/console/firestore/rules`)
    await expect(page.getByTestId('rules-source')).toContainText('allow read')
    await historyPutsAVersionBack(page, `${original.source}// applied here\n`, '// applied here')
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

test('⌘K reaches every part of the rules page', async ({ page }) => {
  await page.goto(`${origin()}/console/firestore/rules`)
  await expect(page.getByTestId('rules-source')).toContainText('allow read')
  await paletteReachesEveryPart(page, 'collections')
  await expect(page.getByTestId('rules-map')).toBeVisible()
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

  // A long path: the request wraps and the explanation keeps to the panel,
  // so nothing (the save button least of all) runs past its right edge.
  const long = `users/${'u'.repeat(90)}`
  await page.getByTestId('playground-path').fill(long)
  await page.getByTestId('playground-run').click()
  await expect(page.getByTestId('playground-verdict')).toContainText(long)
  await expect
    .poll(() => page.getByTestId('playground').evaluate((el) => el.scrollWidth - el.clientWidth))
    .toBe(0)
  await page.getByTestId('playground-path').fill('users/u_k65eq')

  // The owner herself, a custom identity with her uid: allowed, and saved
  // as a test that should allow.
  await page.getByTestId('playground-who').click()
  await page.getByTestId('playground-who-custom').click()
  await page.getByTestId('playground-who-custom-dialog-uid').fill('u_k65eq')
  await page.getByTestId('playground-who-custom-dialog-use').click()
  await expect(page.getByTestId('playground-who')).toContainText('u_k65eq')
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
  const why = page.getByTestId('refusal-detail')
  await expect(why.getByTestId('explanation')).toBeVisible()
  await expect(why.getByTestId('explained-allow').first()).toContainText('line 5')

  // Tried again in the playground, as it was recorded: it runs on arrival.
  await why.getByTestId('refusal-try').click()
  await expect(page).toHaveURL(/\/firestore\/rules\?.*panel=playground/)
  await expect(page.getByTestId('playground-path')).toHaveValue('users')
  await expect(page.getByTestId('playground-recorded')).toContainText('not signed in')
  await expect(
    page.getByTestId('playground-result').locator('[data-outcome]').first(),
  ).toHaveAttribute('data-outcome', /deny|error/)
  await expect(
    page.getByTestId('rules-source').locator('[data-inline-value]').first(),
  ).toBeVisible()

  // The decision opens onto why on the Rules page too.
  await page.getByRole('tab', { name: 'Decisions' }).click()
  await page.getByTestId('decision-row').first().click()
  const detail = page.getByTestId('decision-detail')
  await expect(detail.getByTestId('explanation')).toBeVisible()
  await page.getByTestId('decision-back').click()

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

/** What the load watch needs of the page; this file is typed for Node, not the DOM. */
interface ProblemWatch {
  rulesSeen?: { problems: boolean }
  document: { querySelector(selector: string): unknown }
  MutationObserver: new (callback: () => void) => {
    observe(target: unknown, options: { childList: boolean; subtree: boolean }): void
  }
}

test('a clean load shows no problems, and a link to a line reveals and marks it', async ({
  page,
}) => {
  // Watch the whole load: the Problems strip once flashed `1:1 expected
  // "service"` for a second, the check of the empty text the editor held
  // before the rules arrived.
  await page.addInitScript(() => {
    const browser = globalThis as unknown as ProblemWatch
    const seen = { problems: false }
    browser.rulesSeen = seen
    new browser.MutationObserver(() => {
      if (browser.document.querySelector('[data-testid="rules-diagnostics"]')) seen.problems = true
    }).observe(browser.document, { childList: true, subtree: true })
  })
  await page.goto(`${origin()}/console/firestore/rules?line=5`)
  await expect(page.getByTestId('rules-source')).toContainText('allow read')

  // The line a link names is brought into view and marked once, and the
  // address forgets it, so a reload does not jump back to it.
  const lines = page.getByTestId('rules-source').locator('.cm-line')
  await expect(lines.nth(4)).toHaveClass(/cm-line-focus/)
  await expect(page.locator('.cm-lineNumbers .cm-activeLineGutter')).toHaveText('5')
  await expect(page).not.toHaveURL(/line=/)

  // Long past the first check and its settling, nothing was ever wrong.
  await page.waitForTimeout(1_500)
  expect(
    await page.evaluate(() => (globalThis as unknown as ProblemWatch).rulesSeen?.problems),
  ).toBe(false)
  await expect(page.getByTestId('rules-diagnostics')).toHaveCount(0)

  // F8 walks to the next problem from where the caret is.
  await pasteRules(page, OPEN)
  const warning = page.getByTestId('rules-diagnostics').locator('[data-severity="warning"]')
  await expect(warning.first()).toBeVisible()
  const line = /^(\d+):/.exec((await warning.first().textContent()) ?? '')?.[1]
  expect(line).toBeTruthy()
  await page.keyboard.press('F8')
  await expect(page.locator('.cm-lineNumbers .cm-activeLineGutter')).toHaveText(line as string)
  // The text was never applied.
  await page.getByTestId('rules-revert').click()
  await expect(page.getByTestId('rules-draft-state')).toHaveCount(0)
})

/** Sets (or, with `{}`, clears) a seed user's custom claims through the Auth emulator's own API. */
async function setClaims(page: Page, uid: string, claims: Record<string, unknown>) {
  const response = await page.request.post(
    `${origin()}/console/api/v1/auth/identitytoolkit.googleapis.com/v1/accounts:update?key=fake-api-key`,
    {
      headers: { authorization: 'Bearer owner' },
      data: { localId: uid, customAttributes: JSON.stringify(claims) },
    },
  )
  expect(response.ok(), await response.text()).toBeTruthy()
}

test('completion offers the claim keys users carry, in the editor and the playground', async ({
  page,
}) => {
  // A key only this journey uses, set on a seed person: the engine's claim
  // index answers it; no list of users is read.
  const ada = 'u_k65eq'
  await setClaims(page, ada, { console_tier: 'gold' })
  try {
    const claimReads: string[] = []
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname
      if (path.endsWith('/auth/claims') || path.endsWith('/auth/identities')) claimReads.push(path)
    })
    await page.goto(`${origin()}/console/firestore/rules`)
    await expect(page.getByTestId('rules-source')).toContainText('allow read')

    // After `request.auth.token.`, the key is offered as a custom claim.
    await pasteRules(
      page,
      `${OPEN.split('\n').slice(0, 4).join('\n')}\n      allow read: if request.auth.token.`,
    )
    await page.keyboard.type('console_t')
    const options = page.locator('.cm-tooltip-autocomplete [role="option"]')
    await expect(options.filter({ hasText: 'console_tier' })).toHaveCount(1)
    await expect(options.filter({ hasText: 'console_tier' })).toContainText('custom claim')
    await page.keyboard.press('Escape')
    expect(claimReads.some((path) => path.endsWith('/auth/claims'))).toBe(true)
    await page.getByTestId('rules-revert').click()
    await expect(page.getByTestId('rules-draft-state')).toHaveCount(0)

    // The playground's custom identity offers it too, as a key is typed.
    await page.getByRole('tab', { name: /Playground/ }).click()
    await page.getByTestId('playground-who').click()
    await page.getByTestId('playground-who-custom').click()
    const claims = page.getByTestId('playground-who-custom-dialog-claims')
    await claims.click()
    await page.keyboard.type('{"cons')
    await expect(options.filter({ hasText: 'console_tier' })).toHaveCount(1)
    await page.keyboard.press('Enter')
    await expect(claims).toContainText('"console_tier":')
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
  } finally {
    await setClaims(page, ada, {})
  }
})
