// How wide an inspector is, remembered per browser and per inspector.
//
// The panel's width is the real constraint on what it shows, not the
// arrangement inside it: a name column and a value column have to share
// 420 px, which leaves a value thirty-nine characters before it wraps, and
// a document of URLs and hashes has none that short. Dragging it wider is
// worth more than any rearrangement of the two.
//
// Each inspector has its own width (`widthKey`): a user record and a log
// entry want different room, and a drag on one should not move the other.
// Firestore's keeps the storage key it always had, so nobody's width is
// lost to the move.

import { useCallback } from 'react'
import { create } from 'zustand'

const LEGACY_KEY = 'firenook.console.inspector-width'

/** Where an inspector's width is remembered: Firestore's legacy key, else one per `widthKey`. */
export function storageKeyFor(widthKey: string): string {
  return widthKey === 'firestore' ? LEGACY_KEY : `${LEGACY_KEY}.${widthKey}`
}

export const INSPECTOR_MIN = 320
/** Narrow enough to leave a list worth reading on a laptop. */
const INSPECTOR_FLOOR = 420
/** Wide enough that a document of URLs and hashes stops wrapping at all. */
const INSPECTOR_CEILING = 760
/** The share of the window a panel opened for the first time asks for. */
const SHARE = 0.28

/**
 * What the panel opens at before anyone has dragged it.
 *
 * A flat 420 was picked on a 1440 px laptop and then shipped to a 2557 px
 * display, where it is sixteen per cent of the window — against the twenty-
 * six per cent Supabase gives the same job — and the panel that had been
 * merely snug was stingy. A share of the window, floored at the laptop
 * number so nothing changes there and capped before it eats the list,
 * gives 420 up to about 1500 px and 716 on the display this was measured on.
 *
 * The window, not the space beside the list: the first panel opens before
 * there is a layout to measure, and a share of nothing is nothing.
 */
export function defaultWidth(): number {
  const window = globalThis.window as { innerWidth?: number } | undefined
  const wide = window?.innerWidth
  if (wide === undefined) return INSPECTOR_FLOOR
  return Math.min(INSPECTOR_CEILING, Math.max(INSPECTOR_FLOOR, Math.round(wide * SHARE)))
}

/**
 * Below this, a footer's least important control drops its word and keeps
 * its glyph (Firestore's Code).
 *
 * Measured on the row it is in, with the word shown: Save sits 13 px
 * from Delete at the 320 px floor, 33 at 340, 53 at 360 and 409 at the
 * 716 the panel opens to on a wide display. Adjacency between the
 * confirming control and the destroying one is the thing a footer's
 * layout exists to prevent, and a Save's own width of clear space — 42
 * px — is the least that reads as "the other end of the row". The word
 * crosses that at about 349.
 *
 * So the glyph alone is the fallback, not the normal state: every width
 * the panel opens at carries the word, and only a deliberate drag to the
 * last thirty pixels takes it away.
 */
export const CODE_LABEL_AT = 350

/** The list is the other half of the screen and has to stay worth having. */
export const GRID_MIN = 360

/** Within reach, and never so wide that the list beside it is a sliver. */
export function clampWidth(px: number, available: number): number {
  const ceiling = Math.max(INSPECTOR_MIN, available - GRID_MIN)
  return Math.round(Math.min(Math.max(px, INSPECTOR_MIN), ceiling))
}

/** What each inspector first read from storage this page load, so it is read once. */
const firstRead = new Map<string, number>()

function read(widthKey: string): number {
  const known = firstRead.get(widthKey)
  if (known !== undefined) return known
  let width = defaultWidth()
  try {
    const stored = Number(localStorage.getItem(storageKeyFor(widthKey)))
    if (Number.isFinite(stored) && stored >= INSPECTOR_MIN) width = stored
  } catch {
    // A browser that refuses storage starts from the default.
  }
  firstRead.set(widthKey, width)
  return width
}

function write(widthKey: string, width: number) {
  try {
    localStorage.setItem(storageKeyFor(widthKey), String(width))
  } catch {
    // A browser that refuses storage starts from the default next time.
  }
}

/** The widths set this page load, by `widthKey`; the rest come from storage. */
const useWidths = create<{ widths: Readonly<Record<string, number>> }>(() => ({ widths: {} }))

/** An inspector's width now, without subscribing: for code outside React. */
export function inspectorWidth(widthKey: string): number {
  return useWidths.getState().widths[widthKey] ?? read(widthKey)
}

function setWidthOf(widthKey: string, width: number) {
  useWidths.setState((state) => ({ widths: { ...state.widths, [widthKey]: width } }))
}

export interface InspectorWidth {
  width: number
  /** During a drag: the state moves, storage does not. */
  setWidth: (px: number) => void
  /** At the end of one: what it settled on is what is remembered. */
  remember: () => void
  /** Back to a share of the window, and remembered so. */
  reset: () => void
}

/**
 * One inspector's width: `setWidth` during a drag, `remember` at the end
 * (so a drag is not sixty storage writes), `reset` on a double-click.
 */
export function useInspectorWidth(widthKey: string): InspectorWidth {
  const width = useWidths((state) => state.widths[widthKey]) ?? read(widthKey)
  const setWidth = useCallback((px: number) => setWidthOf(widthKey, px), [widthKey])
  const remember = useCallback(() => write(widthKey, inspectorWidth(widthKey)), [widthKey])
  const reset = useCallback(() => {
    const home = defaultWidth()
    write(widthKey, home)
    setWidthOf(widthKey, home)
  }, [widthKey])
  return { width, setWidth, remember, reset }
}

/** For tests: forget what this page load has read and set. */
export function resetInspectorWidths(): void {
  firstRead.clear()
  useWidths.setState({ widths: {} })
}
