// The clipboard, as a journey checks a copy: the button's tick, and what the
// page put there.

import { type Locator, type Page, expect } from '@playwright/test'

/**
 * A copy button that has copied: the copy mark gone up out of its box and
 * the tick risen into it, as Kumo's ClipboardText moves them.
 */
export const ticked = async (button: Locator) => {
  const glyph = button.locator('[data-copied]')
  await expect(glyph).toHaveCount(1)
  await expect
    .poll(() =>
      glyph
        .locator('[data-part="tick"]')
        .evaluate((tick) => tick.ownerDocument.defaultView!.getComputedStyle(tick).opacity),
    )
    .toBe('1')
}

/** What the page last copied (the project grants clipboard-read). */
export function readClipboard(page: Page): Promise<string> {
  return page.evaluate(() =>
    (navigator as Navigator & { clipboard: { readText(): Promise<string> } }).clipboard.readText(),
  )
}
