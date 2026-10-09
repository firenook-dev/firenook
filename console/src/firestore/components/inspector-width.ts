// How wide the document inspector is, remembered per browser.
//
// The panel's width is the real constraint on the field editor, not the
// arrangement inside it: a name column and a value column have to share
// 420 px, which leaves a value thirty-nine characters before it wraps, and
// a document of URLs and hashes has none that short. Dragging it wider is
// worth more than any rearrangement of the two.

import { create } from 'zustand'

const KEY = 'firenook.console.inspector-width'

export const INSPECTOR_DEFAULT = 420
export const INSPECTOR_MIN = 320
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
    return Number.isFinite(stored) && stored >= INSPECTOR_MIN ? stored : INSPECTOR_DEFAULT
  } catch {
    return INSPECTOR_DEFAULT
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
    write(INSPECTOR_DEFAULT)
    set({ width: INSPECTOR_DEFAULT })
  },
}))
