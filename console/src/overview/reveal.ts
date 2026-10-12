// Bringing a part of the Overview into view. The page scrolls inside its
// own column, under the shell's top bar; `scrollIntoView` would go on to
// scroll every scrollable ancestor once the column ran out of room (the
// last part of the page), lifting the whole shell — top bar included — off
// the top of the window. So only the column is scrolled.

/** The Overview's scrolling column. */
export const OVERVIEW_SCROLL = 'overview-scroll'

/** How far below the column's top a revealed part starts, in pixels. */
const GAP = 20

export function reveal(element: HTMLElement | null): void {
  if (!element) return
  const column = element.closest<HTMLElement>(`[data-testid="${OVERVIEW_SCROLL}"]`)
  if (!column) return
  const top =
    element.getBoundingClientRect().top -
    column.getBoundingClientRect().top +
    column.scrollTop -
    GAP
  column.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
}

/** `reveal` by the part's id. */
export function revealById(id: string): void {
  reveal(document.getElementById(id))
}
