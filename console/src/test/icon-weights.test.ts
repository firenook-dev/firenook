// The build keeps only `ICON_WEIGHTS` of every Phosphor icon
// (`scripts/icon-weights.mjs`); an icon drawn in any other weight would
// render empty in the shipped console while it looks right in development.
// This reads every weight the console, the design system, the kit harness
// and Kumo (where it draws the console's own Phosphor) ask for, and fails
// on one outside the list, or on one it cannot read.

import { describe, expect, it } from 'vitest'
import { ICON_WEIGHTS, stripIconWeights } from '../../scripts/icon-weights.mjs'

const OURS = import.meta.glob<string>(
  [
    '/src/**/*.{ts,tsx}',
    '/design-system/**/*.{ts,tsx}',
    '/e2e/kit-harness/**/*.{ts,tsx}',
    '!/src/test/icon-weights.test.ts',
  ],
  { query: '?raw', import: 'default', eager: true },
)

// Kumo's own toast inlines a private copy of Phosphor, which the strip never
// touches; only the files that import the console's copy count.
const KUMO = import.meta.glob<string>('/node_modules/@cloudflare/kumo/dist/**/*.js', {
  query: '?raw',
  import: 'default',
  eager: true,
  exhaustive: true,
})

/** A weight prop or property: `weight="bold"`, `weight={…}`, `weight: 'fill'`, never `font-weight:`. */
const WEIGHT =
  /(?<![\w-])weight\s*(?:=\s*(?:"(\w+)"|'(\w+)'|\{([^}]*)\})|:\s*(?:"(\w+)"|'(\w+)'|([^\s,}]+)))/g

interface Use {
  file: string
  weight: string
}

/** Every weight a file asks for; an expression the guard cannot read is reported as itself. */
function weightsIn(file: string, code: string): Use[] {
  const uses: Use[] = []
  for (const match of code.matchAll(WEIGHT)) {
    const [, jsxDouble, jsxSingle, jsxExpression, double, single, other] = match
    const literal = jsxDouble ?? jsxSingle ?? double ?? single
    if (literal !== undefined) uses.push({ file, weight: literal })
    else {
      // `weight={open ? 'fill' : 'regular'}`: every string it can be.
      const expression = jsxExpression ?? other ?? ''
      const strings = [...expression.matchAll(/["'](\w+)["']/g)].map((found) => found[1] ?? '')
      if (strings.length === 0) uses.push({ file, weight: `unreadable: ${match[0]}` })
      for (const weight of strings) uses.push({ file, weight })
    }
  }
  return uses
}

const kept = new Set<string>(ICON_WEIGHTS)

describe('icon weights', () => {
  it('the console, the design system and the kit harness use only the weights the build keeps', () => {
    const files = Object.entries(OURS)
    expect(files.length).toBeGreaterThan(500)
    const uses = files.flatMap(([file, code]) => weightsIn(file, code))
    expect(uses.length).toBeGreaterThan(0)
    expect(uses.filter((use) => !kept.has(use.weight))).toEqual([])
  })

  it('Kumo, where it draws the console’s Phosphor, uses only the kept weights', () => {
    const importers = Object.entries(KUMO).filter(([, code]) =>
      code.includes('from "@phosphor-icons/react"'),
    )
    expect(importers.length).toBeGreaterThan(10)
    const uses = importers.flatMap(([file, code]) => weightsIn(file, code))
    expect(uses.filter((use) => !kept.has(use.weight))).toEqual([])
  })

  it('include regular, the weight an icon draws when none is asked for', () => {
    expect(ICON_WEIGHTS).toContain('regular')
  })
})

describe('the strip', () => {
  const defs = [
    'import * as a from "react";',
    'const e = /* @__PURE__ */ new Map([',
    ...['bold', 'duotone', 'fill', 'light', 'regular', 'thin'].map(
      (weight) =>
        `  [\n    "${weight}",\n    /* @__PURE__ */ a.createElement("path", { d: "M1,2[${weight}]" })\n  ],`,
    ),
    ']);',
    'export { e as default };',
  ].join('\n')

  it('keeps the kept weights’ paths and nothing of the others', () => {
    const out = stripIconWeights(defs)
    for (const weight of ICON_WEIGHTS) expect(out).toContain(`[${weight}]`)
    for (const weight of ['duotone', 'light', 'thin']) expect(out).not.toContain(weight)
    // Still one well-formed list: entries, then the closing bracket.
    expect(out).toMatch(/\],\n\]\);/)
  })

  it('fails on a module of another shape, rather than shipping it half stripped', () => {
    expect(() => stripIconWeights('export default new Map()', 'X.es.js')).toThrow(/X\.es\.js/)
    expect(() => stripIconWeights(defs.replace('"fill"', '"heavy"'), 'Y.es.js')).toThrow(
      /unknown weight/,
    )
    expect(() => stripIconWeights(defs.replace('"bold"', '"thin"'), 'Z.es.js')).toThrow(
      /has no bold weight/,
    )
  })
})
