import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clockOrDate,
  clockTime,
  compactIso,
  formatBytes,
  formatClock,
  formatCount,
  formatDuration,
  formatNumber,
  pad,
  relativeTime,
  utcStamp,
  whenParts,
  whenText,
} from './format'

describe('numbers and counts', () => {
  it('groups integers and leaves fractions as typed', () => {
    expect(formatNumber(2340)).toBe('2,340')
    expect(formatNumber(1_000_000)).toBe('1,000,000')
    expect(formatNumber(1.5)).toBe('1.5')
    expect(formatNumber(0)).toBe('0')
  })

  it('names the thing counted, singular only for one', () => {
    const users = { one: 'user', other: 'users' }
    expect(formatCount(1, users)).toBe('1 user')
    expect(formatCount(0, users)).toBe('0 users')
    expect(formatCount(2340, users)).toBe('2,340 users')
  })
})

describe('sizes', () => {
  it('writes small documents in bytes and bigger ones in kilobytes', () => {
    expect(formatBytes(147)).toBe('147 B')
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(12_700)).toBe('12.4 KB')
    expect(formatBytes(900_000)).toBe('879 KB')
  })

  it('keeps hundredths of a megabyte, where the document limit is', () => {
    expect(formatBytes(1_048_576)).toBe('1.00 MB')
    expect(formatBytes(1_048_576 + 40_000)).toBe('1.04 MB')
  })

  it('reads large figures for their size, up to terabytes', () => {
    expect(formatBytes(38 * 1024 * 1024)).toBe('38.0 MB')
    expect(formatBytes(380 * 1024 * 1024)).toBe('380 MB')
    expect(formatBytes(1.2 * 1024 ** 3)).toBe('1.2 GB')
    expect(formatBytes(3 * 1024 ** 4)).toBe('3.0 TB')
  })
})

describe('durations', () => {
  it('uses the unit a reader thinks in', () => {
    expect(formatDuration(850)).toBe('850 ms')
    expect(formatDuration(1200)).toBe('1.2 s')
    expect(formatDuration(42_000)).toBe('42 s')
    expect(formatDuration(184_000)).toBe('3 min 4 s')
    expect(formatDuration(7_500_000)).toBe('2 h 5 min')
    expect(formatDuration(3 * 86_400_000 + 4 * 3_600_000)).toBe('3 d 4 h')
  })

  it('never writes a figure that belongs in the next unit', () => {
    expect(formatDuration(999.6)).toBe('1.0 s')
    expect(formatDuration(9_960)).toBe('10 s')
    expect(formatDuration(59_600)).toBe('1 min')
    expect(formatDuration(3_600_000)).toBe('1 h')
  })

  it('keeps a tenth for sub-10 ms work and never goes negative', () => {
    expect(formatDuration(0.42)).toBe('0.4 ms')
    expect(formatDuration(0)).toBe('0 ms')
    expect(formatDuration(-5)).toBe('0 ms')
  })
})

describe('times', () => {
  const now = Date.parse('2026-09-20T09:00:00Z')

  it('describes relative time in the shortest honest form', () => {
    expect(relativeTime('2026-09-20T08:59:50Z', now)).toBe('just now')
    expect(relativeTime('2026-09-20T08:57:00Z', now)).toBe('3 min ago')
    expect(relativeTime('2026-09-20T06:00:00Z', now)).toBe('3 h ago')
    expect(relativeTime('2026-09-15T09:00:00Z', now)).toBe('5 d ago')
    expect(relativeTime('2026-09-20T10:00:00Z', now)).toBe('in 1 h')
    expect(relativeTime('not a date', now)).toBe('not a date')
  })

  it('switches units at their edges', () => {
    expect(relativeTime('2026-09-20T08:59:16Z', now)).toBe('just now')
    expect(relativeTime('2026-09-20T08:59:15Z', now)).toBe('1 min ago')
    expect(relativeTime('2026-08-01T09:00:00Z', now)).toBe('2 mo ago')
    expect(relativeTime('2024-09-20T09:00:00Z', now)).toBe('2 y ago')
  })

  it('never says "in 1 min" of a time in the current minute, behind a minute clock', () => {
    // The minute clock floors to the minute: a line logged at :59 is 59 s ahead of it.
    expect(relativeTime('2026-09-20T09:00:59Z', now)).toBe('just now')
    expect(relativeTime('2026-09-20T09:00:46Z', now)).toBe('just now')
    expect(relativeTime('2026-09-20T09:01:30Z', now)).toBe('in 2 min')
  })

  it('takes the machinery out of a timestamp', () => {
    expect(compactIso('2026-09-20T09:00:00.123456Z')).toBe('2026-09-20 09:00:00')
    expect(compactIso('2026-09-20T09:00:00Z')).toBe('2026-09-20 09:00:00')
  })

  it('keeps the zone on a UTC stamp shown without a local clock beside it', () => {
    expect(utcStamp('2026-10-12T20:10:20.123Z')).toBe('2026-10-12 20:10:20 UTC')
    // An offset instant is written in UTC, never as the wall time it was given in.
    expect(utcStamp('2026-10-13T04:10:20+08:00')).toBe('2026-10-12 20:10:20 UTC')
    expect(utcStamp('not a time')).toBe('not a time')
  })

  it('says when in one way for every inspector: local clock, the instant, how long ago', () => {
    const at = new Date(2026, 9, 13, 4, 10, 27, 670)
    const later = at.getTime() + 13 * 60_000
    const parts = whenParts(at.toISOString(), later)
    expect(parts).toEqual({
      local: 'Today 04:10:27.670',
      instant: at.toISOString(),
      ago: '13 min ago',
    })
    expect(whenText(at.toISOString(), later)).toBe(
      `Today 04:10:27.670 local · ${at.toISOString()} · 13 min ago`,
    )
    const nextDay = at.getTime() + 26 * 3_600_000
    expect(whenParts(at.toISOString(), nextDay)?.local).toBe('Oct 13 04:10:27.670')
    expect(whenText('nope')).toBe('nope')
  })
})

describe('the clock format', () => {
  afterEach(() => {
    localStorage.clear()
    vi.resetModules()
  })

  it('writes a feed time three ways', () => {
    const at = new Date(2026, 8, 20, 14, 2, 11, 348)
    const iso = at.toISOString()
    expect(formatClock(iso, 'time')).toBe('14:02:11.348')
    expect(formatClock(iso, 'utc')).toBe(iso)
    expect(formatClock(iso, 'relative', at.getTime() + 3_400)).toBe('3 s ago')
    expect(formatClock(iso, 'relative', at.getTime() + 125_000)).toBe('2 min ago')
    expect(formatClock(iso, 'relative', at.getTime() - 2_000)).toBe('in 2 s')
    expect(formatClock('soon', 'time')).toBe('soon')
  })

  it('is one wall clock at three precisions, from a string, a number or a date', () => {
    const at = new Date(2026, 8, 20, 9, 2, 1, 48)
    expect(clockTime(at)).toBe('09:02:01.048')
    expect(clockTime(at.toISOString(), 'second')).toBe('09:02:01')
    expect(clockTime(at.getTime(), 'minute')).toBe('09:02')
    expect(clockTime('soon', 'minute')).toBe('soon')
  })

  it('writes the day before a time that is not today', () => {
    const at = new Date(2026, 8, 20, 14, 2, 11)
    expect(clockOrDate(at.toISOString(), at.getTime() + 60_000)).toBe('14:02:11')
    expect(clockOrDate(at.toISOString(), at.getTime() + 86_400_000)).toBe('2026-09-20 14:02:11')
    expect(clockOrDate('never')).toBe('never')
  })

  it('pads to a width', () => {
    expect([pad(7), pad(12), pad(5, 3)]).toEqual(['07', '12', '005'])
  })

  it('is remembered per browser and follows other tabs', async () => {
    localStorage.setItem('firenook.console.clock-format', 'utc')
    const { useClockFormat } = await import('./format')
    const { result } = renderHook(() => useClockFormat())
    expect(result.current.format).toBe('utc')
    act(() => result.current.setFormat('relative'))
    expect(result.current.format).toBe('relative')
    expect(localStorage.getItem('firenook.console.clock-format')).toBe('relative')

    localStorage.setItem('firenook.console.clock-format', 'time')
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'firenook.console.clock-format' }))
    })
    expect(result.current.format).toBe('time')
  })

  it('reads an unknown stored value as the default', async () => {
    localStorage.setItem('firenook.console.clock-format', 'sundial')
    const { useClockFormat } = await import('./format')
    const { result } = renderHook(() => useClockFormat())
    expect(result.current.format).toBe('time')
  })
})
