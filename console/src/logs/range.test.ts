import { describe, expect, it } from 'vitest'
import {
  aroundWindow,
  bucketWindow,
  clockText,
  fromLocalInput,
  presetOf,
  rangeLabel,
  toLocalInput,
} from './range'

const at = (h: number, m: number, s = 0) => new Date(2026, 9, 12, h, m, s).getTime()

describe('the time window', () => {
  it('names the presets and reads the URL back into them', () => {
    expect(rangeLabel(undefined, undefined)).toBe('All lines')
    expect(rangeLabel('-1m', undefined)).toBe('Last minute')
    expect(rangeLabel('-5m', undefined)).toBe('Last 5 min')
    expect(rangeLabel('-60m', undefined)).toBe('Last hour')
    expect(rangeLabel('reload', undefined)).toBe('Since reload')
    expect(rangeLabel('-30m', undefined)).toBe('Last 30m')
    expect(presetOf('-5m', '2026-10-12T04:00:00Z')).toBeUndefined()
  })

  it('writes a window of instants as clock times, the day in front when not today', () => {
    const now = at(15, 0)
    const from = new Date(at(12, 3)).toISOString()
    const to = new Date(at(12, 5, 10)).toISOString()
    expect(rangeLabel(from, to, now)).toBe('12:03–12:05:10')
    expect(rangeLabel(from, undefined, now)).toBe('From 12:03')
    expect(rangeLabel(undefined, to, now)).toBe('Until 12:05:10')
    expect(clockText(new Date(2026, 9, 11, 9, 30).getTime(), now)).toBe('Oct 11 09:30')
  })

  it('reads a histogram bucket range and thirty seconds around a line', () => {
    expect(bucketWindow({ from: '2026-10-12T04:00:00.000Z', bucketMs: 60_000 }, 2, 3)).toEqual({
      from: '2026-10-12T04:02:00.000Z',
      to: '2026-10-12T04:04:00.000Z',
    })
    expect(aroundWindow('2026-10-12T04:06:09.126Z')).toEqual({
      from: '2026-10-12T04:05:39.126Z',
      to: '2026-10-12T04:06:39.126Z',
    })
  })

  it('round-trips a datetime-local value in local time, to the second', () => {
    const iso = new Date(at(12, 3, 7)).toISOString()
    expect(toLocalInput(iso)).toBe('2026-10-12T12:03:07')
    expect(fromLocalInput('2026-10-12T12:03:07')).toBe(iso)
    expect(fromLocalInput('')).toBeUndefined()
    expect(toLocalInput('-5m')).toBe('')
  })
})
