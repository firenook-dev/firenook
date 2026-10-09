// How wide the document inspector is, remembered per browser.
//
// The panel's width is the real constraint on the field editor, not the
// arrangement inside it: a name column and a value column have to share
// 420 px, which leaves a value thirty-nine characters before it wraps, and
// a document of URLs and hashes has none that short. Dragging it wider is
// worth more than any rearrangement of the two.

import { create } from 'zustand'

const KEY = 'firenook.console.inspector-width'

export const INSPECTOR_MIN = 320
/** Narrow enough to leave a grid worth reading on a laptop. */
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
 * number so nothing changes there and capped before it eats the grid,
 * gives 420 up to about 1500 px and 716 on the display this was measured on.
 *
 * The window, not the space beside the grid: the first panel opens before
 * there is a layout to measure, and a share of nothing is nothing.
 */
export function defaultWidth(): number {
  const window = globalThis.window as { innerWidth?: number } | undefined
  const wide = window?.innerWidth
  if (wide === undefined) return INSPECTOR_FLOOR
  return Math.min(INSPECTOR_CEILING, Math.max(INSPECTOR_FLOOR, Math.round(wide * SHARE)))
}
/** The gap the grid leaves beside the panel when both are in the flow. */
export const INSPECTOR_GAP = 12
/** The grid is the other half of the screen and has to stay worth having. */
export const GRID_MIN = 360

/** Within reach, and never so wide that the grid beside it is a sliver. */
export function clampWidth(px: number, available: number): number {
  const ceiling = Math.max(INSPECTOR_MIN, available - GRID_MIN)
  return Math.round(Math.min(Math.max(px, INSPECTOR_MIN), ceiling))
}

function read(): number {
  try {
    const stored = Number(localStorage.getItem(KEY))
    return Number.isFinite(stored) && stored >= INSPECTOR_MIN ? stored : defaultWidth()
  } catch {
    return defaultWidth()
  }
}

function write(width: number) {
  try {
    localStorage.setItem(KEY, String(width))
  } catch {
    // A browser that refuses storage starts from the default next time.
  }
}

interface InspectorWidth {
  width: number
  /** During a drag: the state moves, storage does not. */
  setWidth: (width: number) => void
  /** At the end of one: what it settled on is what is remembered. */
  remember: () => void
  reset: () => void
}

export const useInspectorWidth = create<InspectorWidth>((set, get) => ({
  width: read(),
  setWidth: (width) => set({ width }),
  remember: () => write(get().width),
  reset: () => {
    const width = defaultWidth()
    write(width)
    set({ width })
  },
}))
