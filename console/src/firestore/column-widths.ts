// How wide a column has been dragged, remembered per browser.
//
// Per *shape* of collection rather than per collection: `users/u1/orders`
// and `users/u2/orders` are the same columns under different parents, and
// a width set on one is the width wanted on the next. A collection group
// is its own shape, because its first column is a whole path.
//
// Widths set nowhere fall back to the column's own — the type's width or
// the header's needs — so this holds only what a person changed.

import { create } from 'zustand'
import { patternOf } from './schema'

const KEY = 'firenook.console.column-widths'

export const COLUMN_MIN = 64
export const COLUMN_MAX = 960
/** Enough for anyone's collections; the oldest shapes go first beyond it. */
const SHAPES = 200

type Widths = Record<string, Record<string, number>>

/** Which collections share a set of widths. */
export function shapeKey(
  project: string,
  database: string,
  collectionPath: string,
  group: boolean,
): string {
  return `${project}|${database}|${group ? `group:${collectionPath}` : patternOf(collectionPath)}`
}

export function clampColumn(px: number): number {
  return Math.round(Math.min(COLUMN_MAX, Math.max(COLUMN_MIN, px)))
}

interface ColumnWidthsState {
  widths: Widths
  set: (shape: string, column: string, px: number) => void
  /** Back to the column's own width. */
  reset: (shape: string, column: string) => void
}

function read(): Widths {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Widths) : {}
  } catch {
    return {}
  }
}

function write(widths: Widths) {
  try {
    localStorage.setItem(KEY, JSON.stringify(widths))
  } catch {
    // Private windows and full storage keep the width for this visit only.
  }
}

export const useColumnWidths = create<ColumnWidthsState>((set) => ({
  widths: read(),
  set: (shape, column, px) =>
    set((state) => {
      // Re-inserted, so the order of keys is the order of use.
      const { [shape]: current, ...rest } = state.widths
      const widths: Widths = { ...rest, [shape]: { ...current, [column]: clampColumn(px) } }
      const shapes = Object.keys(widths)
      for (const old of shapes.slice(0, Math.max(0, shapes.length - SHAPES))) delete widths[old]
      write(widths)
      return { widths }
    }),
  reset: (shape, column) =>
    set((state) => {
      const current = state.widths[shape]
      if (!current || !(column in current)) return state
      const { [column]: _dropped, ...kept } = current
      const widths = { ...state.widths, [shape]: kept }
      write(widths)
      return { widths }
    }),
}))
