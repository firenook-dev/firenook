// Parts of the Overview other pages lead to, by the hash the Overview
// brings into view (`overview/reveal.ts`): its engine section (the top
// navigation's version, the bar's live badge, ⌘K's "Engine details") and its data cards (⌘K's
// "Download a snapshot", which starts the snapshot and follows it there).
// The router's own hash scrolling stays off, because the Overview scrolls
// inside its column. An ask made while the Overview is on screen is
// counted too, once the navigation has settled: a link to the address
// already shown changes nothing the router sees (and its scroll
// restoration puts the column back where it was), yet the part must still
// come back into view. From another page the Overview opens on the hash
// and reveals it itself; counting that ask as well revealed the part a
// second time, a moment later, wherever the reader had scrolled since.

import type { useNavigate } from '@tanstack/react-router'
import { create } from 'zustand'

/** A part of the Overview, by the hash that names it. */
export type OverviewPart = 'engine' | 'data'

/** The engine section as an address, for the badge's real `href`. */
export const ENGINE_DETAILS_HREF = '/console/#engine'

/**
 * The part asked for last in this tab while the Overview was on screen, how
 * many times one was, and whether the Overview is on screen now (its
 * `useRevealHash` says so).
 */
export const useOverviewAsks = create<{
  part: OverviewPart | undefined
  asks: number
  shown: boolean
}>(() => ({ part: undefined, asks: 0, shown: false }))

/** Opens a part of the Overview, from any page, the Overview included. */
export function openOverviewPart(
  navigate: ReturnType<typeof useNavigate>,
  part: OverviewPart,
): void {
  const shown = useOverviewAsks.getState().shown
  void navigate({ to: '/', hash: part, hashScrollIntoView: false }).then(() => {
    if (shown) useOverviewAsks.setState((state) => ({ part, asks: state.asks + 1 }))
  })
}
