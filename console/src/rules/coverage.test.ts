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

describe('Storage’s coverage report', () => {
  // The same official shape, read from `/storage/rules/coverage`.
  const storage = [
    "rules_version = '2';",
    'service firebase.storage {',
    '  match /b/{bucket}/o {',
    '    match /users/{uid}/{allPaths=**} {',
    '      allow write: if request.resource.size < 5 * 1024 * 1024;',
    '    }',
    '  }',
    '}',
  ].join('\n')
  const start = Array.from(storage.slice(0, storage.indexOf('request.resource.size'))).length
  const end = start + 'request.resource.size < 5 * 1024 * 1024'.length - 1

  it('is drawn by the same code: a count in the gutter, the values after the condition', () => {
    const view = coverageView(
      {
        rules: { files: [{ name: 'storage.rules', content: storage }] },
        report: [
          {
            sourcePosition: { line: 5, column: 23, currentOffset: start, endOffset: end },
            values: [
              { value: { boolValue: false }, count: 1 },
              { value: { boolValue: true }, count: 4 },
            ],
          },
        ],
        firenookCoverage: { truncated: false },
      },
      storage,
    )
    expect(view?.notes).toEqual([expect.objectContaining({ line: 5, text: '5×', tone: 'hit' })])
    expect(view?.tallies).toEqual([
      {
        from: storage.indexOf('request.resource.size'),
        to: storage.indexOf(';', storage.indexOf('request.resource.size')),
        value: 'false ×1 · true ×4',
      },
    ])
    expect(view).toMatchObject({ ran: 1, of: 1 })
  })

  it('says "never" for a condition no upload reached', () => {
    const view = coverageView(
      {
        rules: { files: [{ name: 'storage.rules', content: storage }] },
        report: [{ sourcePosition: { line: 5, column: 23, currentOffset: start, endOffset: end } }],
      },
      storage,
    )
    expect(view?.notes).toEqual([expect.objectContaining({ line: 5, text: 'never', tone: 'miss' })])
    expect(view?.ran).toBe(0)
  })
})
