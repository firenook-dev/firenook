// Which rows of the topics tree are open. Ephemeral, per tab, except one
// choice that is remembered per browser: whether the "Other projects"
// group is shut, because a developer who works with several projects on
// purpose shuts it once and should not have to again (localStorage, read
// and written in try/catch like `lib/layout.ts`).

import { create } from 'zustand'

/** Group rows' ids: never a resource name, which always starts with `projects/`. */
export const GROUP = {
  schedules: 'group:schedules',
  other: 'group:other',
  detached: 'group:detached',
} as const

const OTHER_SHUT_KEY = 'firenook.console.pubsub.other-projects'

function readShut(): boolean {
  try {
    return localStorage.getItem(OTHER_SHUT_KEY) === 'shut'
  } catch {
    return false
  }
}

function writeShut(shut: boolean) {
  try {
    if (shut) localStorage.setItem(OTHER_SHUT_KEY, 'shut')
    else localStorage.removeItem(OTHER_SHUT_KEY)
  } catch {
    // A browser that refuses storage opens the group again next time.
  }
}

interface TreeState {
  open: ReadonlySet<string>
  setOpen: (id: string, open: boolean) => void
  /** Opens every id given (the path to the topic in view), leaving the rest. */
  reveal: (ids: readonly string[]) => void
}

function initialOpen(): Set<string> {
  // Schedules start shut: a group of synthetic topics is reference, not work.
  const open = new Set<string>([GROUP.detached])
  if (!readShut()) open.add(GROUP.other)
  return open
}

export const useTopicTree = create<TreeState>((set) => ({
  open: initialOpen(),
  setOpen: (id, open) =>
    set((state) => {
      if (state.open.has(id) === open) return state
      const next = new Set(state.open)
      if (open) next.add(id)
      else next.delete(id)
      if (id === GROUP.other) writeShut(!open)
      return { open: next }
    }),
  reveal: (ids) =>
    set((state) => {
      if (ids.every((id) => state.open.has(id))) return state
      const next = new Set(state.open)
      for (const id of ids) next.add(id)
      return { open: next }
    }),
}))
