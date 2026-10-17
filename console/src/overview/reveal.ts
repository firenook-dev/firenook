// Bringing a part of the Overview into view. The page scrolls inside its
// own column, under the shell's top bar; `scrollIntoView` would go on to
// scroll every scrollable ancestor once the column ran out of room (the
// last part of the page), lifting the whole shell — top bar included — off
// the top of the window. So only the column is scrolled.
//
// A link names a part by its hash (`/#engine`, the navigation's version;
// `/#data`, where ⌘K's snapshot download is followed): the page brings it
// into view when it opens on it, and again each time the part is asked for
// while it is open (`components/shell/overview-parts.ts`).

import { useRouter } from '@tanstack/react-router'
import { useEffect } from 'react'
import { type OverviewPart, useOverviewAsks } from '@/components/shell/overview-parts'

/** The Overview's scrolling column. */
export const OVERVIEW_SCROLL = 'overview-scroll'

/** How far below the column's top a revealed part starts, in pixels. */
const GAP = 20

/** The parts a hash names, by the element id each part carries. */
const HASH_PARTS: Readonly<Record<OverviewPart, string>> = {
  engine: 'overview-engine',
  data: 'overview-data',
}

export function reveal(element: HTMLElement | null): void {
  if (!element) return
  const column = element.closest<HTMLElement>(`[data-testid="${OVERVIEW_SCROLL}"]`)
  if (!column) return
  const top =
    element.getBoundingClientRect().top -
    column.getBoundingClientRect().top +
    column.scrollTop -
    GAP
  // Smooth, unless the reader asked the system for less motion.
  const reduced = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  column.scrollTo({ top: Math.max(0, top), behavior: reduced ? 'auto' : 'smooth' })
}

/** `reveal` by the part's id. */
export function revealById(id: string): void {
  reveal(document.getElementById(id))
}

/** The part `hash` names, revealed; any other hash is left alone. */
export function revealHash(hash: string): void {
  if (Object.hasOwn(HASH_PARTS, hash)) revealById(HASH_PARTS[hash as OverviewPart])
}

/**
 * Reveals the part the address's hash names when the page opens, and each
 * part asked for while the page is open (a link to the address already
 * shown changes nothing the router sees).
 */
export function useRevealHash(): void {
  const router = useRouter()
  useEffect(() => {
    revealHash(router.state.location.hash)
    useOverviewAsks.setState({ shown: true })
    const unsubscribe = useOverviewAsks.subscribe((state, previous) => {
      if (state.part && state.asks !== previous.asks) revealHash(state.part)
    })
    return () => {
      unsubscribe()
      useOverviewAsks.setState({ shown: false })
    }
  }, [router])
}
