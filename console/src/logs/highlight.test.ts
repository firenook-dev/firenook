import { describe, expect, it } from 'vitest'
import { highlighter, mergeRanges, portableRegex } from './highlight'

const marks = (q: string, text: string) =>
  highlighter(q)
    ?.ranges(text)
    .map(([from, to]) => text.slice(from, to)) ?? []

describe('search highlight', () => {
  it('marks words and phrases case-insensitively, merging overlaps', () => {
    expect(marks('burst', 'Burst line 1 of BURST')).toEqual(['Burst', 'BURST'])
    expect(marks('"line 1"', 'burst line 1 of 5')).toEqual(['line 1'])
    expect(marks('bur urst', 'burst')).toEqual(['burst'])
    expect(
      mergeRanges([
        [4, 8],
        [0, 2],
        [1, 3],
      ]),
    ).toEqual([
      [0, 3],
      [4, 8],
    ])
  })

  it('marks nothing for excluded items or for terms, which match their fields', () => {
    expect(highlighter('-"heartbeat ok" level:error function:hello')).toBeUndefined()
    expect(highlighter('')).toBeUndefined()
  })

  it('marks regexes that mean the same in JavaScript, and nothing for Rust-only ones', () => {
    expect(marks('/burst line 1\\d{3}/', 'burst line 1234 of 5000')).toEqual(['burst line 1234'])
    expect(marks('/timed? out/i', 'Function TIMED OUT after 60s')).toEqual(['TIMED OUT'])
    expect(marks('/(?:a|b)c/', 'xbcx')).toEqual(['bc'])
    expect(portableRegex('(?i)cart', false)).toBeUndefined()
    expect(portableRegex('[[:alpha:]]+', false)).toBeUndefined()
    expect(portableRegex('\\Acart\\z', false)).toBeUndefined()
    expect(portableRegex('(?P<name>x)', false)).toBeUndefined()
    expect(portableRegex('a*', false)).toBeUndefined()
    expect(portableRegex('(', false)).toBeUndefined()
  })

  it('counts in UTF-16, astral characters included', () => {
    const text = '🔥 cart 🔥 Cart'
    const ranges = highlighter('cart')?.ranges(text) ?? []
    expect(ranges.map(([from, to]) => text.slice(from, to))).toEqual(['cart', 'Cart'])
    expect(ranges[0]).toEqual([3, 7])
    expect(marks('🔥', text)).toEqual(['🔥', '🔥'])
  })
})
