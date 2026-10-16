// The theme's colours as a reader meets them (`src/theme.css`): every Kumo
// button variant, the text and the marks a page draws, a placeholder and
// the active tab, measured on the kit harness as the browser paints them,
// in light and dark mode. Contrast is WCAG 2's ratio: 4.5:1 for text, 3:1
// for a mark. A filled button is measured where its label sits, halfway
// down its gradient, at rest and hovered.
//
// It also holds the choices the theme makes: a primary button and a link
// are blue, so neither is mistaken for a red Delete, an error or a warning;
// and the active tab is underlined in the logo's flame.

import { buildKitHarness, type KitBuild, type KitHarness, openKitHarness } from './support/kit'
import { expect, test } from './fixtures'

test.describe('theme', () => {
  let kit: KitBuild | undefined
  test.beforeAll(async () => {
    test.setTimeout(180_000)
    kit = await buildKitHarness()
  })
  test.afterAll(() => kit?.remove())

  for (const mode of ['light', 'dark'] as const) {
    test(`every button, text, mark and placeholder reads in ${mode} mode, and only the flame marks where you are`, async ({
      page,
      engine,
    }) => {
      if (!kit) throw new Error('the kit harness did not build')
      await page.setViewportSize({ width: 1280, height: 600 })
      await openKitHarness(page, engine.origin, kit, 'theme', mode)
      const run = await page.evaluate(() =>
        (globalThis as unknown as { __kit: KitHarness }).__kit.theme(),
      )

      // Every variant was found, and both halves of a filled one measured.
      const buttons = run.checks.filter((check) => check.what.includes('button'))
      expect(buttons.map((check) => check.what)).toEqual(
        expect.arrayContaining([
          'primary button',
          'primary button, hovered',
          'secondary button',
          'outline button',
          'ghost button',
          'destructive button',
          'destructive button, hovered',
          'secondary-destructive button',
        ]),
      )
      const short = run.checks.filter((check) => check.ratio < check.need)
      expect(short, `below their minimum in ${mode} mode`).toEqual([])

      expect(run.primary.chroma, 'the primary is a colour').toBeGreaterThan(0.1)
      expect(run.primary.hue, 'the primary is blue').toBeGreaterThan(240)
      expect(run.primary.hue, 'the primary is blue').toBeLessThan(280)
      expect(run.link.hue, 'a link is blue').toBeGreaterThan(240)
      expect(run.link.hue, 'a link is blue').toBeLessThan(280)
      expect(run.underlineIsFlame, 'the active tab is underlined in the flame').toBe(true)
    })
  }
})
