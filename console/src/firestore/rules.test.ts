import { describe, expect, it } from 'vitest'
import { describeDiagnostic, lineCount, offsetOf } from './rules'

const at = (line: number, column: number) => ({
  severity: 'error',
  message: "expected '{'",
  line,
  column,
})

describe('the gutter', () => {
  it('numbers one line for empty text, not none', () => {
    expect(lineCount('')).toBe(1)
  })

  it('counts the lines a ruleset has', () => {
    expect(lineCount('a\nb\nc')).toBe(3)
  })

  it('counts a trailing newline as the line it opens', () => {
    expect(lineCount('a\n')).toBe(2)
  })
})

describe('placing a diagnostic in the text', () => {
  const source = 'rules_version = ;\nservice cloud.firestore {\n  match /x {\n'

  it('finds the first line from its column alone', () => {
    expect(offsetOf(source, at(1, 17))).toBe(16)
  })

  it('counts the newlines before a later line', () => {
    // Line 1 is 17 characters, so line 2 starts at 18; line 2 is 25, so
    // line 3 starts at 44, and column 3 is two further in.
    expect(offsetOf(source, at(2, 1))).toBe(18)
    expect(offsetOf(source, at(3, 3))).toBe(46)
  })

  it('clamps past the end rather than throwing, because a hint can be stale', () => {
    expect(offsetOf(source, at(99, 99))).toBe(source.length)
    expect(offsetOf('short', at(1, 500))).toBe('short'.length)
  })

  it('treats a column of zero as the start of the line', () => {
    expect(offsetOf(source, at(2, 0))).toBe(18)
  })
})

describe('the line a diagnostic reads as', () => {
  it('leads with where, then what', () => {
    expect(describeDiagnostic(at(3, 17))).toBe("3:17 expected '{'")
  })
})
