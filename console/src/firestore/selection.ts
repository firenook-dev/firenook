// Ephemeral grid state: which rows are checked for a bulk action, and which
// cell the keyboard is on. Neither belongs in the URL.

import { create } from 'zustand'

interface SelectionState {
  /** The collection the selection belongs to. */
  scope: string
  checked: Set<string>
  /**
   * Every document the query matches is selected, loaded or not — the
   * selection bar's "Select all". `checked` holds the loaded ones so the
   * rows on screen show ticked; an action reads this flag for the rest.
   * Unticking any row drops back to the rows ticked by hand.
   */
  everything: boolean
  /** The row the keyboard is on. */
  focused: string | undefined
  /**
   * The column the keyboard is on within that row, or `undefined` for the
   * row itself — its id — where Enter opens the document rather than
   * editing a value.
   */
  field: string | undefined
  /** The row a shift-click selects a range from: the last one toggled. */
  anchor: string | undefined
  /**
   * The cell being edited. Held here rather than in the grid so that the
   * workbench's own shortcuts — `f`, `e`, Escape closing the inspector —
   * can stand aside while a value is being typed, wherever focus is.
   */
  editing: { path: string; field: string } | null
  toggle: (path: string) => void
  setChecked: (paths: Iterable<string>) => void
  /** Checks or clears every path given, leaving the rest as they are. */
  setRange: (paths: readonly string[], checked: boolean) => void
  /** Everything the query matches; `loaded` are the rows to show ticked. */
  selectEverything: (loaded: Iterable<string>) => void
  clear: () => void
  focus: (path: string | undefined, field?: string | undefined) => void
  edit: (cell: { path: string; field: string } | null) => void
}

/** Clears the selection when the grid moves to another collection. */
export function resetSelection(scope: string) {
  if (useSelection.getState().scope === scope) return
  useSelection.setState({
    scope,
    checked: new Set(),
    everything: false,
    focused: undefined,
    field: undefined,
    anchor: undefined,
    editing: null,
  })
}

export const useSelection = create<SelectionState>((set) => ({
  scope: '',
  checked: new Set(),
  everything: false,
  focused: undefined,
  field: undefined,
  anchor: undefined,
  editing: null,
  toggle: (path) =>
    set((state) => {
      const checked = new Set(state.checked)
      if (checked.has(path)) checked.delete(path)
      else checked.add(path)
      return { checked, anchor: path, everything: false }
    }),
  setChecked: (paths) => set({ checked: new Set(paths), everything: false }),
  setRange: (paths, on) =>
    set((state) => {
      const checked = new Set(state.checked)
      for (const path of paths) {
        if (on) checked.add(path)
        else checked.delete(path)
      }
      return { checked, anchor: paths.at(-1) ?? state.anchor, everything: false }
    }),
  selectEverything: (loaded) => set({ checked: new Set(loaded), everything: true }),
  clear: () => set({ checked: new Set(), everything: false, focused: undefined, field: undefined }),
  focus: (focused, field) => set({ focused, field }),
  edit: (editing) => set({ editing }),
}))
