import { describe, expect, it } from 'vitest'
import { hangingStyle, leadingColumns } from './hanging-indent'

describe('a wrapped line hangs under its own text', () => {
  it('counts a line’s indent in columns, a tab to the next stop', () => {
    expect(leadingColumns('match /x {', 4)).toBe(0)
    expect(leadingColumns('    allow read: if', 4)).toBe(4)
    expect(leadingColumns('\tallow', 4)).toBe(4)
    expect(leadingColumns('  \tallow', 4)).toBe(4)
    expect(leadingColumns('      ', 4)).toBe(6)
  })

  it('pads the continuations one step past the indent and keeps the first row in place', () => {
    expect(hangingStyle(4, 2)).toBe('padding-left: calc(8px + 6ch); text-indent: -6ch')
    expect(hangingStyle(0, 2)).toBe('padding-left: calc(8px + 2ch); text-indent: -2ch')
  })
})
