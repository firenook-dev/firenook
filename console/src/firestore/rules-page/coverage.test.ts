import { describe, expect, it } from 'vitest'
import { coverageView, scalarToUtf16 } from './coverage'

const source = '// é🔥\nallow read: if a == b;'

describe('coverage in the editor', () => {
  it('maps scalar offsets to UTF-16', () => {
    const toUnit = scalarToUtf16(source)
    // "// é🔥\n" is 6 scalars and 7 code units.
    expect(toUnit(6)).toBe(7)
  })

  it('counts each condition, marks the ones never reached, and tallies values', () => {
    // In scalars, as the report counts: the `a` of the condition.
    const at = Array.from(source.slice(0, source.indexOf('a =='))).length
    const view = coverageView(
      {
        rules: { files: [{ name: 'firestore.rules', content: source }] },
        report: [
          {
            sourcePosition: { line: 2, column: 16, currentOffset: at, endOffset: at + 5 },
            values: [
              { value: { boolValue: false }, count: 2 },
              { value: { boolValue: true }, count: 1 },
            ],
            children: [
              { sourcePosition: { line: 2, column: 21, currentOffset: at + 5, endOffset: at + 5 } },
            ],
          },
        ],
      },
      source,
    )
    expect(view?.notes).toEqual([expect.objectContaining({ line: 2, text: '3×', tone: 'hit' })])
    expect(view?.notes[0]?.title).toMatch(/never reached: b/)
    expect(view?.tallies[0]?.value).toBe('false ×2 · true ×1')
    expect(view?.ran).toBe(1)
  })

  it('draws nothing for other rules, and takes a report with nothing to count', () => {
    const empty = { rules: { files: [{ name: 'firestore.rules', content: source }] } }
    expect(coverageView(empty, source)).toEqual({ notes: [], tallies: [], ran: 0, of: 0 })
    expect(coverageView(empty, 'other')).toBeUndefined()
  })
})
