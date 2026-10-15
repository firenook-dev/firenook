// Where the engine's facts are: the Overview's engine section, by the hash
// the Overview brings into view (`overview/reveal.ts`). The top bar's
// engine badge and ⌘K's "Engine details" lead there; the router's own hash
// scrolling stays off, because the Overview scrolls inside its column.
// Each ask is counted too, once the navigation has settled: a link to the
// address already shown changes nothing the router sees (and its scroll
// restoration puts the column back where it was), yet the section must
// still come back into view.

import type { useNavigate } from '@tanstack/react-router'
import { create } from 'zustand'

/** The hash that names the Overview's engine section. */
export const ENGINE_HASH = 'engine'

/** The navigation to the Overview's engine section. */
export const ENGINE_DETAILS = {
  to: '/',
  hash: ENGINE_HASH,
  hashScrollIntoView: false,
} as const

/** The same place as an address, for a link's real `href`. */
export const ENGINE_DETAILS_HREF = `/console/#${ENGINE_HASH}`

/** How many times the engine's details were asked for in this tab. */
export const useEngineDetailsAsks = create<{ asks: number }>(() => ({ asks: 0 }))

/** Opens the Overview's engine section, from any page, the Overview included. */
export function openEngineDetails(navigate: ReturnType<typeof useNavigate>): void {
  void navigate(ENGINE_DETAILS).then(() =>
    useEngineDetailsAsks.setState((state) => ({ asks: state.asks + 1 })),
  )
}
