import { describe, expect, it } from 'vitest'
import { diffLines, diffSize } from './diff'

describe('a line diff', () => {
  it('keeps the common lines and marks the rest', () => {
    const lines = diffLines('a\nb\nc\nd', 'a\nc\nx\nd')
    expect(lines.map((line) => `${line.kind[0]}${line.text}`)).toEqual([
      'sa',
      'rb',
      'sc',
      'ax',
      'sd',
    ])
    expect(lines.find((line) => line.text === 'x')).toMatchObject({ after: 3 })
    expect(lines.find((line) => line.text === 'b')).toMatchObject({ before: 2 })
    expect(diffSize(lines)).toEqual({ removed: 1, added: 1 })
  })

  it('says nothing changed for the same text', () => {
    expect(diffSize(diffLines('x\ny', 'x\ny'))).toEqual({ removed: 0, added: 0 })
  })

  it('handles an empty side', () => {
    expect(diffLines('', 'a').map((line) => line.kind)).toEqual(['removed', 'added'])
    expect(diffSize(diffLines('a\nb', ''))).toEqual({ removed: 2, added: 1 })
  })
})
