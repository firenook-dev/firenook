import { describe, expect, it } from 'vitest'
import { agedBuckets, agedSum, tokensAt } from './windows'

const at = (iso: string) => Date.parse(iso)
// Ends at 10:00:00; 5 in its last second, 3 ten seconds before, 2 at 59 s.
const window = {
  endsAt: '2026-10-12T10:00:00.000Z',
  buckets: [
    [0, 5],
    [10, 3],
    [59, 2],
  ] as Array<[number, number]>,
}

describe('aged windows (U-07)', () => {
  it('sum to the last minute as sent', () => {
    expect(agedSum(window, 60, at('2026-10-12T10:00:00.400Z'))).toBe(10)
  })

  it('shift by whole seconds and drop what left the span', () => {
    // One second later the 59 s bucket is 60 s old.
    expect(agedSum(window, 60, at('2026-10-12T10:00:01.000Z'))).toBe(8)
    // Fifty seconds later only the newest is left.
    expect(agedSum(window, 60, at('2026-10-12T10:00:50.000Z'))).toBe(5)
    // A part of a second is not a second.
    expect(agedSum(window, 60, at('2026-10-12T10:00:00.999Z'))).toBe(10)
  })

  it('decay to nothing when no frame comes', () => {
    expect(agedSum(window, 60, at('2026-10-12T10:01:00.000Z'))).toBe(0)
    expect(agedSum(undefined, 60, at('2026-10-12T10:00:00.000Z'))).toBe(0)
  })

  it('age ten-second buckets by whole buckets', () => {
    const failed = {
      endsAt: '2026-10-12T10:00:00.000Z',
      buckets: [
        [0, 4],
        [29, 1],
      ] as Array<[number, number]>,
    }
    expect(agedSum(failed, 300, at('2026-10-12T10:00:09.000Z'), 10)).toBe(5)
    expect(agedSum(failed, 300, at('2026-10-12T10:00:10.000Z'), 10)).toBe(4)
    expect(agedSum(failed, 300, at('2026-10-12T10:05:00.000Z'), 10)).toBe(0)
  })

  it('lay the buckets out oldest first for the bars', () => {
    const bars = agedBuckets(window, 60, at('2026-10-12T10:00:00.000Z'))
    expect(bars).toHaveLength(60)
    expect(bars[59]).toBe(5)
    expect(bars[49]).toBe(3)
    expect(bars[0]).toBe(2)
    expect(bars.reduce((sum, value) => sum + value, 0)).toBe(10)
    const later = agedBuckets(window, 60, at('2026-10-12T10:00:02.000Z'))
    expect(later[57]).toBe(5)
    expect(later.reduce((sum, value) => sum + value, 0)).toBe(8)
  })
})

describe('the token bucket (U-07)', () => {
  const bucket = {
    tokens: 2,
    maxTokens: 10,
    refilledAt: '2026-10-12T10:00:00.000Z',
    maxDispatchesPerSecond: 3,
  }

  it('does not refill under a second', () => {
    expect(tokensAt(bucket, at('2026-10-12T10:00:00.900Z'))).toBe(2)
  })

  it('refills the rate for each whole second since', () => {
    expect(tokensAt(bucket, at('2026-10-12T10:00:01.000Z'))).toBe(5)
    expect(tokensAt(bucket, at('2026-10-12T10:00:02.500Z'))).toBe(8)
  })

  it('never past the bucket', () => {
    expect(tokensAt(bucket, at('2026-10-12T10:01:00.000Z'))).toBe(10)
  })

  it('keeps fractions of a slow rate', () => {
    const slow = { ...bucket, tokens: 0, maxTokens: 1, maxDispatchesPerSecond: 0.1 }
    expect(tokensAt(slow, at('2026-10-12T10:00:03.000Z'))).toBeCloseTo(0.3)
  })
})
