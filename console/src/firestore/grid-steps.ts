// The grid's ↑ ↓ for the inspector's previous and next. The inspector is a
// sibling of the grid, not inside it, so the grid says here how to step
// from the open document — or that there is no row that way — and the
// inspector draws the kit's chevrons from it, as every section's does.
// Each step is a new function only when the open row's place changes, so
// the inspector re-renders on a move, not on every frame of the grid.

import { create } from 'zustand'

export interface GridSteps {
  /** To the row above the open one; undefined at the top of what is loaded. */
  previous: (() => void) | undefined
  /** To the row below; undefined at the bottom of what is loaded. */
  next: (() => void) | undefined
}

export const useGridSteps = create<GridSteps>(() => ({ previous: undefined, next: undefined }))
