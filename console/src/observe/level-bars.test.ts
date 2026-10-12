import { describe, expect, it } from 'vitest'
import {
  LEVEL_SERIES,
  bucketSentence,
  bucketSpan,
  bucketTotal,
  hourBucketStart,
  levelBuckets,
  problemBuckets,
} from './level-bars'

const counts = (debug: number, info: number, warn: number, error: number) => ({
  debug,
  info,
  warn,
  error,
})

const pad = (value: number) => String(value).padStart(2, '0')
const local = (ms: number) => {
  const date = new Date(ms)
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

describe('the volume bars', () => {
  it('stack every other line at the base, then warnings, then errors', () => {
    expect(LEVEL_SERIES.map((series) => series.tone)).toEqual(['neutral', 'warning', 'danger'])
    expect(levelBuckets([counts(2, 10, 3, 1), counts(0, 0, 0, 0)])).toEqual([
      [12, 3, 1],
      [0, 0, 0],
    ])
    expect(bucketTotal(counts(2, 10, 3, 1))).toBe(16)
  })

  it('draw the problems alone for the Overview', () => {
    expect(problemBuckets([counts(2, 400, 3, 1)])).toEqual([[0, 3, 1]])
  })

  it('say what a bucket holds, leaving out levels it has none of', () => {
    expect(bucketSentence(counts(0, 391, 18, 3), '12:05–12:06')).toBe(
      '12:05–12:06 · 412 lines · 3 errors · 18 warnings',
    )
    expect(bucketSentence(counts(0, 1, 0, 0), '12:05–12:06')).toBe('12:05–12:06 · 1 line')
    expect(bucketSentence(counts(0, 0, 1, 0), '12:05–12:06')).toBe(
      '12:05–12:06 · 1 line · 1 warning',
    )
    expect(bucketSentence(counts(0, 0, 0, 0), '12:05–12:06')).toBe('12:05–12:06 · No lines')
  })

  it('write a minute bucket in minutes and a shorter one in seconds', () => {
    const minute = Date.UTC(2026, 9, 12, 4, 5)
    expect(bucketSpan(minute, 60_000)).toBe(`${local(minute)}–${local(minute + 60_000)}`)
    expect(bucketSpan(minute + 10_000, 10_000)).toMatch(/^\d\d:\d\d:10–\d\d:\d\d:20$/)
  })

  it('end the hour with the minute the state was made in', () => {
    const at = '2026-10-12T04:06:09.117Z'
    expect(hourBucketStart(at, 59)).toBe(Date.UTC(2026, 9, 12, 4, 6))
    expect(hourBucketStart(at, 0)).toBe(Date.UTC(2026, 9, 12, 3, 7))
  })
})
