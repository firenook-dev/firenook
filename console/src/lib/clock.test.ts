import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClock, useNow } from './clock'

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
  document.dispatchEvent(new Event('visibilitychange'))
}

/** Every subscription a test makes, stopped after it so no clock outlives its test. */
const subscriptions: Array<() => void> = []
function listen(clock: ReturnType<typeof createClock>, listener: () => void) {
  const stop = clock.subscribe(listener)
  subscriptions.push(stop)
  return stop
}

describe('the shared clock', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-20T09:00:00.250Z'))
    setVisibility('visible')
  })
  afterEach(() => {
    for (const stop of subscriptions.splice(0)) stop()
    vi.useRealTimers()
    setVisibility('visible')
  })

  it('runs one timer for any number of readers, and none without them', () => {
    const clock = createClock('second')
    expect(vi.getTimerCount()).toBe(0)
    const stops = Array.from({ length: 5 }, () => listen(clock, () => {}))
    expect(vi.getTimerCount()).toBe(1)
    for (const stop of stops.slice(0, 4)) stop()
    expect(vi.getTimerCount()).toBe(1)
    stops[4]?.()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('turns over on the boundary, every reader on the same beat', () => {
    const clock = createClock('second')
    const heard: number[] = []
    listen(clock, () => heard.push(clock.snapshot()))
    listen(clock, () => heard.push(clock.snapshot()))
    expect(clock.snapshot()).toBe(Date.parse('2026-09-20T09:00:00Z'))
    vi.advanceTimersByTime(760)
    expect(heard).toEqual([Date.parse('2026-09-20T09:00:01Z'), Date.parse('2026-09-20T09:00:01Z')])
  })

  it('tells minute readers only when the minute changes', () => {
    const clock = createClock('minute')
    let calls = 0
    listen(clock, () => {
      calls += 1
    })
    vi.advanceTimersByTime(30_000)
    expect(calls).toBe(0)
    vi.advanceTimersByTime(30_000)
    expect(calls).toBe(1)
    vi.advanceTimersByTime(60_000)
    expect(calls).toBe(2)
  })

  it('stops the second clock while the tab is hidden and catches up once when shown', () => {
    const clock = createClock('second')
    let calls = 0
    listen(clock, () => {
      calls += 1
    })
    vi.advanceTimersByTime(1000)
    expect(calls).toBe(1)
    setVisibility('hidden')
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(10_000)
    expect(calls).toBe(1)
    setVisibility('visible')
    expect(calls).toBe(2)
    expect(clock.snapshot()).toBe(Date.parse('2026-09-20T09:00:11Z'))
    expect(vi.getTimerCount()).toBe(1)
  })

  it('keeps the minute clock going while hidden', () => {
    const clock = createClock('minute')
    let calls = 0
    listen(clock, () => {
      calls += 1
    })
    setVisibility('hidden')
    vi.advanceTimersByTime(60_000)
    expect(calls).toBe(1)
  })

  it('re-renders a hook reader only when its granularity turns over', () => {
    let renders = 0
    const { result } = renderHook(() => {
      renders += 1
      return useNow('minute')
    })
    const first = result.current
    const before = renders
    act(() => {
      vi.advanceTimersByTime(20_000)
    })
    expect(renders).toBe(before)
    act(() => {
      vi.advanceTimersByTime(40_000)
    })
    expect(result.current).toBe(first + 60_000)
    expect(renders).toBe(before + 1)
  })

  it('re-renders a reader that selects only when its selection changes', () => {
    let renders = 0
    const { result } = renderHook(() => {
      renders += 1
      // Whole minutes since 09:00, read on the second clock.
      return useNow('second', (now) =>
        Math.floor((now - Date.parse('2026-09-20T09:00:00Z')) / 60_000),
      )
    })
    expect(result.current).toBe(0)
    const before = renders
    for (let second = 0; second < 59; second += 1)
      act(() => {
        vi.advanceTimersByTime(1000)
      })
    expect(renders).toBe(before)
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(result.current).toBe(1)
    expect(renders).toBe(before + 1)
  })
})
