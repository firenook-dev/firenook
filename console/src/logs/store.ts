// The Logs page's state that is neither the URL's nor the engine's: which
// rows are open (→), the invocation under the pointer (its other lines are
// lit), and where the view was cleared. The line in the inspector is the
// URL's `entry`; the filter and the window are the URL's too.
//
// A cleared view is remembered for the tab, per project and engine run, in
// sessionStorage: a reload keeps reading from where the developer cleared,
// another tab is not affected, and an engine restart starts afresh (its
// cursors begin again).

import { create } from 'zustand'

/** Where the view was cleared: the newest line then, and when. */
export interface ClearedAt {
  cursor: string
  /** RFC 3339: when it was cleared. */
  at: string
}

const CLEARED_PREFIX = 'firenook.console.logs.cleared.'

/** Where a tab keeps a cleared view for one project and engine run. */
export const clearedKey = (project: string, instance: string) =>
  `${CLEARED_PREFIX}${project}.${instance}`

export function readCleared(key: string): ClearedAt | undefined {
  try {
    const text = sessionStorage.getItem(key)
    if (!text) return undefined
    const value = JSON.parse(text) as Partial<ClearedAt>
    return typeof value.cursor === 'string' && typeof value.at === 'string'
      ? { cursor: value.cursor, at: value.at }
      : undefined
  } catch {
    return undefined
  }
}

export function writeCleared(key: string, cleared: ClearedAt | undefined) {
  try {
    if (cleared) sessionStorage.setItem(key, JSON.stringify(cleared))
    else sessionStorage.removeItem(key)
  } catch {
    // Storage refused: the view stays cleared until the tab reloads.
  }
}

interface LogsUi {
  /** Rows shown open (→): a stack trace in full, a payload's tree. */
  expanded: ReadonlySet<string>
  /** The invocation of the row under the pointer: its other lines are lit. */
  hoveredExecution: string | undefined
  toggleExpanded: (key: string, open?: boolean) => void
  collapseAll: () => void
  hover: (execution: string | undefined) => void
}

export const useLogsUi = create<LogsUi>((set) => ({
  expanded: new Set(),
  hoveredExecution: undefined,
  toggleExpanded: (key, open) =>
    set((state) => {
      const shown = open ?? !state.expanded.has(key)
      if (shown === state.expanded.has(key)) return state
      const next = new Set(state.expanded)
      if (shown) next.add(key)
      else next.delete(key)
      return { expanded: next }
    }),
  collapseAll: () => set({ expanded: new Set() }),
  hover: (execution) =>
    set((state) =>
      state.hoveredExecution === execution ? state : { hoveredExecution: execution },
    ),
}))
