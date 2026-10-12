// What an Auth page offers in ⌘K while it is on screen: its own commands
// ("Clear the inbox history…", "Pause", "Errors only"), under the page's
// name. The provider is registered once per mount and reads the page's
// current state through a ref, so typing in the palette never sees a stale
// "Pause" after the feed was paused.

import { useEffect, useLayoutEffect, useRef } from 'react'
import { type PaletteItem, matchesQuery, usePaletteProviders } from '@/lib/palette'

export function usePagePalette(key: string, label: string, items: () => PaletteItem[]): void {
  const latest = useRef(items)
  useLayoutEffect(() => {
    latest.current = items
  })
  const register = usePaletteProviders((state) => state.register)
  const unregister = usePaletteProviders((state) => state.unregister)
  useEffect(() => {
    register(key, (query) => {
      const shown = latest.current().filter((item) => matchesQuery(item, query))
      return shown.length > 0 ? [{ label, items: shown }] : []
    })
    return () => unregister(key)
  }, [key, label, register, unregister])
}
