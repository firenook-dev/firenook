// Parts of the Overview other pages lead to, by the hash the Overview
// brings into view (`overview/reveal.ts`): its engine section (the top
// bar's engine badge, ⌘K's "Engine details") and its data cards (⌘K's
// "Download a snapshot", which starts the snapshot and follows it there).
// The router's own hash scrolling stays off, because the Overview scrolls
// inside its column. Each ask is counted too, once the navigation has
// settled: a link to the address already shown changes nothing the router
// sees (and its scroll restoration puts the column back where it was), yet
// the part must still come back into view.

import type { useNavigate } from '@tanstack/react-router'
import { create } from 'zustand'

/** A part of the Overview, by the hash that names it. */
export type OverviewPart = 'engine' | 'data'

/** The engine section as an address, for the badge's real `href`. */
export const ENGINE_DETAILS_HREF = '/console/#engine'

/** The part asked for last in this tab, and how many times one was. */
export const useOverviewAsks = create<{ part: OverviewPart | undefined; asks: number }>(() => ({
  part: undefined,
  asks: 0,
}))

/** Opens a part of the Overview, from any page, the Overview included. */
export function openOverviewPart(
  navigate: ReturnType<typeof useNavigate>,
  part: OverviewPart,
): void {
  void navigate({ to: '/', hash: part, hashScrollIntoView: false }).then(() =>
    useOverviewAsks.setState((state) => ({ part, asks: state.asks + 1 })),
  )
}
