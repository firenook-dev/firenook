// One clock for every relative time on screen. A panel that wrote "3 min
// ago" used to keep its own interval (the decisions panel ran one every
// 30 s); a page with five such panels ran five, each re-rendering on its
// own beat. Here there is one timer per granularity, shared by every
// reader, started by the first and stopped by the last, and a reader
// re-renders only when the value it reads changes.
//
// The `second` clock is for feeds ("3 s ago"); it stops while the tab is
// hidden, where nobody can read it, and catches up once when the tab is
// shown again. The `minute` clock keeps going: once a minute costs nothing.

import { useSyncExternalStore } from 'react'

export type Granularity = 'second' | 'minute'

const STEP: Record<Granularity, number> = { second: 1000, minute: 60_000 }

interface Clock {
  readonly granularity: Granularity
  subscribe(listener: () => void): () => void
  snapshot(): number
}

/** Exported for tests: a clock with no readers holds no timer. */
export function createClock(granularity: Granularity): Clock {
  const step = STEP[granularity]
  const listeners = new Set<() => void>()
  let current = floor(Date.now(), step)
  let timer: ReturnType<typeof setTimeout> | undefined
  const pausesWhenHidden = granularity === 'second'

  const tick = () => {
    const next = floor(Date.now(), step)
    if (next === current) return
    current = next
    for (const listener of listeners) listener()
  }
  const schedule = () => {
    clearTimeout(timer)
    // To the next boundary, so every reader turns over on the same beat.
    const wait = step - (Date.now() % step) + 1
    timer = setTimeout(() => {
      tick()
      schedule()
    }, wait)
  }
  const onVisibility = () => {
    if (hidden()) {
      clearTimeout(timer)
      timer = undefined
    } else {
      tick()
      schedule()
    }
  }

  return {
    granularity,
    subscribe(listener) {
      listeners.add(listener)
      if (listeners.size === 1) {
        current = floor(Date.now(), step)
        if (pausesWhenHidden) document.addEventListener('visibilitychange', onVisibility)
        if (!pausesWhenHidden || !hidden()) schedule()
      }
      return () => {
        listeners.delete(listener)
        if (listeners.size > 0) return
        clearTimeout(timer)
        timer = undefined
        if (pausesWhenHidden) document.removeEventListener('visibilitychange', onVisibility)
      }
    },
    snapshot() {
      // With no reader the clock is not ticking, so read the time fresh.
      if (listeners.size === 0) current = floor(Date.now(), step)
      return current
    },
  }
}

function hidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden'
}

function floor(time: number, step: number): number {
  return time - (time % step)
}

const clocks: Record<Granularity, Clock> = {
  second: createClock('second'),
  minute: createClock('minute'),
}

/**
 * Now, re-rendering at most once per `granularity` (one shared timer). The
 * `second` timer stops while the tab is hidden and fires once when it is
 * shown again.
 */
export function useNow(granularity: Granularity): number {
  const clock = clocks[granularity]
  return useSyncExternalStore(clock.subscribe, clock.snapshot, clock.snapshot)
}
