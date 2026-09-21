// Whether the query line is open, and text another part of the workbench
// wants typed into it (a column header's "filter by this field"). The URL
// holds the query that runs; this holds only what is being composed.

import { create } from 'zustand'

interface QueryLineState {
  open: boolean
  /** Text to put in the line with the caret at `caret`; `session` makes each request distinct. */
  prefill: { text: string; caret: number; session: number } | null
  setOpen: (open: boolean) => void
  compose: (text: string, caret: number) => void
}

export const useQueryLine = create<QueryLineState>((set) => ({
  open: false,
  prefill: null,
  setOpen: (open) => set({ open }),
  compose: (text, caret) =>
    set((state) => ({
      open: true,
      prefill: { text, caret, session: (state.prefill?.session ?? 0) + 1 },
    })),
}))

/** Hidden grid columns, per collection; a collection change starts clean. */
interface ColumnsState {
  scope: string
  hidden: Set<string>
  hide: (field: string) => void
  showAll: () => void
}

export function resetColumns(scope: string) {
  if (useColumns.getState().scope === scope) return
  useColumns.setState({ scope, hidden: new Set() })
}

export const useColumns = create<ColumnsState>((set) => ({
  scope: '',
  hidden: new Set(),
  hide: (field) => set((state) => ({ hidden: new Set([...state.hidden, field]) })),
  showAll: () => set({ hidden: new Set() }),
}))
