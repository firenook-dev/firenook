// Ephemeral grid state: which rows are checked for a bulk action, and which
// row the keyboard is on. Neither belongs in the URL.

import { create } from 'zustand'

interface SelectionState {
  /** The collection the selection belongs to. */
  scope: string
  checked: Set<string>
  focused: string | undefined
  toggle: (path: string) => void
  setChecked: (paths: Iterable<string>) => void
  clear: () => void
  focus: (path: string | undefined) => void
}

/** Clears the selection when the grid moves to another collection. */
export function resetSelection(scope: string) {
  if (useSelection.getState().scope === scope) return
  useSelection.setState({ scope, checked: new Set(), focused: undefined })
}

export const useSelection = create<SelectionState>((set) => ({
  scope: '',
  checked: new Set(),
  focused: undefined,
  toggle: (path) =>
    set((state) => {
      const checked = new Set(state.checked)
      if (checked.has(path)) checked.delete(path)
      else checked.add(path)
      return { checked }
    }),
  setChecked: (paths) => set({ checked: new Set(paths) }),
  clear: () => set({ checked: new Set(), focused: undefined }),
  focus: (focused) => set({ focused }),
}))
