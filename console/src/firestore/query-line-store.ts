// Whether the query line is open, and text another part of the workbench
// wants typed into it (a column header's "filter by this field"). The URL
// holds the query that runs; this holds only what is being composed.

import { create } from 'zustand'

interface QueryLineState {
  open: boolean
  /** Whether the query plan is showing below the line. */
  explain: boolean
  /** Text to put in the line with the caret at `caret`; `session` makes each request distinct. */
  prefill: { text: string; caret: number; session: number } | null
  setOpen: (open: boolean) => void
  setExplain: (explain: boolean) => void
  compose: (text: string, caret: number) => void
}

export const useQueryLine = create<QueryLineState>((set) => ({
  open: false,
  explain: false,
  prefill: null,
  setOpen: (open) => set({ open }),
  // Explaining runs the query, so the panel opens the line with it: the
  // plan is about the query you can see and edit, not a hidden one.
  setExplain: (explain) => set(explain ? { explain: true, open: true } : { explain: false }),
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
  /** The rare fields asked for as columns rather than folded into one. */
  unfolded: boolean
  hide: (field: string) => void
  showAll: () => void
  unfold: () => void
}

export function resetColumns(scope: string) {
  if (useColumns.getState().scope === scope) return
  useColumns.setState({ scope, hidden: new Set(), unfolded: false })
}

export const useColumns = create<ColumnsState>((set) => ({
  scope: '',
  hidden: new Set(),
  unfolded: false,
  hide: (field) => set((state) => ({ hidden: new Set([...state.hidden, field]) })),
  showAll: () => set({ hidden: new Set() }),
  unfold: () => set({ unfolded: true }),
}))
