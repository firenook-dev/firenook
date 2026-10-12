// How wide a column has been dragged, and which columns are hidden,
// remembered per browser.
//
// Per *memory key*: a table says where its choices live (`auth.users`,
// `storage.objects`), and the Firestore grid keys by the shape of a
// collection, so `users/u1/orders` and `users/u2/orders` share their widths
// — the same columns under different parents. Widths set nowhere fall back
// to the column's own, so this holds only what a person changed.

import { create } from 'zustand'

const KEY = 'firenook.console.column-widths'
const HIDDEN_KEY = 'firenook.console.hidden-columns'

export const COLUMN_MIN = 64
export const COLUMN_MAX = 960
/** Enough for anyone's tables; the oldest keys go first beyond it. */
const SHAPES = 200

type Widths = Record<string, Record<string, number>>

/** A dragged width kept inside what any column may be; `min` raises the floor for one column. */
export function clampColumn(px: number, min: number = COLUMN_MIN): number {
  return Math.round(Math.min(COLUMN_MAX, Math.max(min, px)))
}

function readRecord<T>(key: string): Record<string, T> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, T>)
      : {}
  } catch {
    return {}
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Private windows and full storage keep the choice for this visit only.
  }
}

/** `record` with `shape` moved to the end (the order of keys is the order of use), trimmed to `SHAPES`. */
function touched<T>(record: Record<string, T>, shape: string, value: T): Record<string, T> {
  const { [shape]: _old, ...rest } = record
  const next: Record<string, T> = { ...rest, [shape]: value }
  const keys = Object.keys(next)
  for (const old of keys.slice(0, Math.max(0, keys.length - SHAPES))) delete next[old]
  return next
}

interface ColumnWidthsState {
  widths: Widths
  set: (shape: string, column: string, px: number) => void
  /** Back to the column's own width. */
  reset: (shape: string, column: string) => void
  /** Every column of `shape` back to its own width. */
  resetAll: (shape: string) => void
}

export const useColumnWidths = create<ColumnWidthsState>((set) => ({
  widths: readRecord<Record<string, number>>(KEY),
  set: (shape, column, px) =>
    set((state) => {
      const widths = touched(state.widths, shape, {
        ...state.widths[shape],
        [column]: clampColumn(px),
      })
      write(KEY, widths)
      return { widths }
    }),
  reset: (shape, column) =>
    set((state) => {
      const current = state.widths[shape]
      if (!current || !(column in current)) return state
      const { [column]: _dropped, ...kept } = current
      const widths = { ...state.widths, [shape]: kept }
      write(KEY, widths)
      return { widths }
    }),
  resetAll: (shape) =>
    set((state) => {
      if (!(shape in state.widths)) return state
      const { [shape]: _dropped, ...widths } = state.widths
      write(KEY, widths)
      return { widths }
    }),
}))

interface HiddenColumnsState {
  /** Per memory key, per column: `true` hidden, `false` shown although hidden by default. */
  choices: Record<string, Record<string, boolean>>
  setHidden: (shape: string, column: string, hidden: boolean) => void
  /** Every column of `shape` shown, the ones hidden by default included. */
  showAll: (shape: string, columns: readonly string[]) => void
}

/**
 * Which columns a table hides. A column `hiddenByDefault` stays hidden until
 * someone shows it, and a choice is kept against the default, so a table
 * that later hides a column by default does not override a person who chose
 * to see it.
 */
export const useHiddenColumns = create<HiddenColumnsState>((set) => ({
  choices: readRecord<Record<string, boolean>>(HIDDEN_KEY),
  setHidden: (shape, column, hidden) =>
    set((state) => {
      const choices = touched(state.choices, shape, { ...state.choices[shape], [column]: hidden })
      write(HIDDEN_KEY, choices)
      return { choices }
    }),
  showAll: (shape, columns) =>
    set((state) => {
      const choices = touched(
        state.choices,
        shape,
        Object.fromEntries(columns.map((column) => [column, false])),
      )
      write(HIDDEN_KEY, choices)
      return { choices }
    }),
}))

/** Whether a column is hidden, given a table's remembered choices and the column's default. */
export function isColumnHidden(
  choices: Readonly<Record<string, boolean>> | undefined,
  column: { id: string; hiddenByDefault?: boolean | undefined },
): boolean {
  return choices?.[column.id] ?? column.hiddenByDefault ?? false
}

const UNFROZEN_KEY = 'firenook.console.unfrozen-ids'

interface IdFreezeState {
  /** Shapes whose id column scrolls with the fields. Frozen is the default. */
  unfrozen: ReadonlySet<string>
  setFrozen: (shape: string, frozen: boolean) => void
}

function readUnfrozen(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(UNFROZEN_KEY) ?? '[]')
    return new Set(Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [])
  } catch {
    return new Set()
  }
}

/**
 * Whether the id column stays put while the fields scroll, per shape of
 * collection like the widths. Frozen by default, because a row of values
 * nobody can name is the worse failure; unfrozen for a collection whose
 * ids are long and say nothing, where the room is worth more than the name.
 */
export const useIdFreeze = create<IdFreezeState>((set) => ({
  unfrozen: readUnfrozen(),
  setFrozen: (shape, frozen) =>
    set((state) => {
      const unfrozen = new Set(state.unfrozen)
      if (frozen) unfrozen.delete(shape)
      else unfrozen.add(shape)
      write(UNFROZEN_KEY, [...unfrozen].slice(-SHAPES))
      return { unfrozen }
    }),
}))
