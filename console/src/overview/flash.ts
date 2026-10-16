// When a card's figure flashes. A figure that changes is worth a moment of
// colour, so a write from the app is seen on the landing page; a figure in
// a write loop is not, or the card strobes and the colour stops meaning
// anything. So a figure flashes when it changes, at most once every 5 s,
// and a figure that changed in each of the last three statuses has stopped
// meaning "something just happened": it stays still until it has rested
// for 5 s.

import { useEffect, useRef, useState } from 'react'

/** The least time between two flashes of one figure, and the rest that ends a streak. */
export const FLASH_GAP_MS = 5000
/** Changes in this many consecutive statuses make a streak. */
export const STREAK = 3

export interface FlashGate {
  /** One status's value of the figure, at `now`; true when this change should flash. */
  observe(value: number | null, now: number): boolean
}

export function createFlashGate(): FlashGate {
  let known = false
  let previous: number | null = null
  // Whether the figure changed, for the last STREAK statuses, newest last.
  const recent: boolean[] = []
  let lastChange = Number.NEGATIVE_INFINITY
  let lastFlash = Number.NEGATIVE_INFINITY
  let streaking = false
  return {
    observe(value, now) {
      // The first value is what the page opened on, not a change.
      if (!known) {
        known = true
        previous = value
        return false
      }
      const changed = value !== previous
      previous = value
      recent.push(changed)
      if (recent.length > STREAK) recent.shift()
      if (!changed) return false
      const rested = now - lastChange >= FLASH_GAP_MS
      lastChange = now
      if (recent.length === STREAK && recent.every(Boolean)) {
        streaking = true
        return false
      }
      if (streaking) {
        if (!rested) return false
        streaking = false
      }
      if (now - lastFlash < FLASH_GAP_MS) return false
      lastFlash = now
      return true
    },
  }
}

/**
 * How many times this figure has flashed, for the element's `key`: a new key
 * starts the animation again. `tick` is the status the value came from, so a
 * status in which the value did not change still counts towards a streak.
 */
export function useFlash(value: number | null, tick: unknown): number {
  const gate = useRef<FlashGate | null>(null)
  const seen = useRef<unknown>(undefined)
  const [flashes, setFlashes] = useState(0)
  useEffect(() => {
    // Each status is observed once, however often the effect runs for it.
    if (seen.current === tick) return
    seen.current = tick
    gate.current ??= createFlashGate()
    if (gate.current.observe(value, Date.now())) setFlashes((count) => count + 1)
  }, [value, tick])
  return flashes
}
