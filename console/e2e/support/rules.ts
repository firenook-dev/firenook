// What both rules pages do the same way, as one journey body each: the
// rules kit's workbench (`src/rules/workbench.tsx`) is one frame for
// Firestore's page and Storage's, so a behaviour of the frame is asserted
// by one body that each page's spec runs against its own engine
// (`rules.spec.ts` on the data profile, `storage-rules.spec.ts` on the
// storage profile). What only one page has stays in its own spec.

import type { Page } from '@playwright/test'
import { expect } from '../fixtures'

/**
 * Replace the editor's text the way a person pastes it: typing would meet
 * the editor's own bracket closing and indenting.
 */
export async function pasteRules(page: Page, text: string): Promise<void> {
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

/** Broken text says where it is broken, in the Problems strip, before anything is applied. */
export async function brokenTextSaysWhere(page: Page, broken: string): Promise<void> {
  await pasteRules(page, broken)
  const problems = page.getByTestId('rules-diagnostics')
  await expect(problems.locator('[data-severity="error"]').first()).toBeVisible()
  await expect(problems.locator('[data-severity="error"]').first()).toHaveText(/^\d+:\d+ /)
  await expect(page.getByTestId('rules-draft-state')).toHaveText('Draft · not applied')
}

/**
 * The URLs of the coverage reports the page reads from now on (`report`
 * matches the page's report route), to show none is read while coverage is
 * off. Call before the page loads.
 */
export function coverageReads(page: Page, report: RegExp): string[] {
  const reads: string[] = []
  page.on('request', (request) => {
    if (report.test(request.url())) reads.push(request.url())
  })
  return reads
}

/**
 * Coverage is off until asked for and reads nothing meanwhile; on, the
 * gutter counts each rule's runs and the toggle says how many ran; off
 * again, the counts go.
 */
export async function coverageOnlyWhenAsked(page: Page, reads: readonly string[]): Promise<void> {
  const toggle = page.getByTestId('rules-coverage')
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await expect(page.locator('.cm-note-hit')).toHaveCount(0)
  expect(reads).toHaveLength(0)
  await toggle.click()
  await expect(toggle).toHaveText(/\d+\/\d+ ran/)
  await expect(page.locator('.cm-note-hit').first()).toHaveText(/^\d+×$/)
  expect(reads.length).toBeGreaterThan(0)
  await toggle.click()
  await expect(page.locator('.cm-note-hit')).toHaveCount(0)
}

/**
 * History lists every version — the file on disk first while what is in
 * force was applied here and not saved — diffs one against the editor,
 * and puts it back as a draft. `applied` is the rules in force with a
 * marker line added, applied here.
 */
export async function historyPutsAVersionBack(
  page: Page,
  applied: string,
  marker: string,
): Promise<void> {
  await pasteRules(page, applied)
  await page.getByTestId('rules-apply').click()
  await expect(page.getByTestId('rules-draft-state')).toHaveCount(0)
  await page.getByTestId('rules-history').click()
  const versions = page.getByTestId('history-version')
  await expect(versions.first()).toContainText('The file on disk')
  await expect(versions.filter({ hasText: 'Applied in the console' }).first()).toContainText(
    'In force',
  )
  await versions.filter({ hasText: 'Loaded at startup' }).click()
  await expect(page.getByTestId('history-diff').locator('[data-kind="added"]')).toContainText(
    marker,
  )
  await page.getByTestId('history-restore').click()
  await expect(page.getByTestId('rules-draft-state')).toHaveText('Draft · not applied')
  await expect(page.getByTestId('rules-source')).not.toContainText(marker)
}

/** ⌘K reaches every part of a rules page: a panel, the history, the page's map. */
export async function paletteReachesEveryPart(page: Page, map: string): Promise<void> {
  const palette = page.getByTestId('palette-input')
  await page.keyboard.press('ControlOrMeta+k')
  await palette.fill('playground')
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/panel=playground/)
  await expect(page.getByTestId('playground')).toBeVisible()
  await page.keyboard.press('ControlOrMeta+k')
  await palette.fill('rules history')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('history-versions')).toBeVisible()
  await page.keyboard.press('Escape')
  await page.keyboard.press('ControlOrMeta+k')
  await palette.fill(map)
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(new RegExp(`panel=${map}`))
  await page.keyboard.press('ControlOrMeta+k')
  await palette.fill('show coverage')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('rules-coverage')).toHaveAttribute('aria-pressed', 'true')
  await page.getByTestId('rules-coverage').click()
}
