// Whether the window is at least Tailwind's `xl` (80rem at the console's
// 14 px root): where a toolbar's switch has room for its counts. Below it
// the counts move into the items' tooltips, so a figure is shown once,
// in one place or the other, never both.

import { useSyncExternalStore } from 'react'

const QUERY = '(min-width: 80rem)'

function media(): MediaQueryList | undefined {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(QUERY)
    : undefined
}

function subscribe(onChange: () => void): () => void {
  const list = media()
  list?.addEventListener('change', onChange)
  return () => list?.removeEventListener('change', onChange)
}

export function useWide(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => media()?.matches ?? true,
    () => true,
  )
}
