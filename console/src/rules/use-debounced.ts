// A value that settles: what a rules page checks as it is typed, and
// anything else that should follow typing without chasing every key.

import { useEffect, useState } from 'react'

/** The latest `value` once it has stopped changing for `ms`. */
export function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), ms)
    return () => window.clearTimeout(timer)
  }, [value, ms])
  return settled
}
