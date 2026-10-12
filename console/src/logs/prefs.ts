// What a developer sets once on the Logs page and expects to find again:
// wrapped lines, lines kept across engine restarts, and saved filters (up
// to twelve per project). Per browser, in localStorage, followed across
// tabs; a browser that refuses storage keeps them for the tab. The clock
// format is the console-wide one in `lib/format.ts`, not this file's.

import { create } from 'zustand'

/** One saved filter: a name and the view it opens. */
export interface SavedFilter {
  name: string
  q: string
  from?: string | undefined
  to?: string | undefined
}

/** Saved filters a project keeps at most; the oldest goes first. */
export const SAVED_FILTERS = 12

const WRAP_KEY = 'firenook.console.logs.wrap'
const KEEP_KEY = 'firenook.console.logs.keep-across-restarts'
const SAVED_PREFIX = 'firenook.console.logs.saved.'

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    // Storage refused: the choice holds for this tab.
  }
}

/** The saved filters stored under `text`, or none when it is not what this file writes. */
export function parseSaved(text: string | null): SavedFilter[] {
  if (!text) return []
  try {
    const value: unknown = JSON.parse(text)
    if (!Array.isArray(value)) return []
    return value
      .filter(
        (item): item is SavedFilter =>
          typeof item === 'object' &&
          item !== null &&
          typeof (item as SavedFilter).name === 'string' &&
          typeof (item as SavedFilter).q === 'string',
      )
      .map((item) => {
        const filter: SavedFilter = { name: item.name, q: item.q }
        if (typeof item.from === 'string') filter.from = item.from
        if (typeof item.to === 'string') filter.to = item.to
        return filter
      })
      .slice(0, SAVED_FILTERS)
  } catch {
    return []
  }
}

/**
 * `list` with `filter` saved: a filter of the same name is replaced in
 * place, a new one goes first, and the list keeps the newest twelve.
 */
export function withSaved(list: readonly SavedFilter[], filter: SavedFilter): SavedFilter[] {
  const at = list.findIndex((item) => item.name === filter.name)
  if (at !== -1) return list.map((item, index) => (index === at ? filter : item))
  return [filter, ...list].slice(0, SAVED_FILTERS)
}

interface LogsPrefs {
  wrap: boolean
  keepAcrossRestarts: boolean
  /** Saved filters by project. */
  saved: Readonly<Record<string, readonly SavedFilter[]>>
  setWrap: (wrap: boolean) => void
  setKeepAcrossRestarts: (keep: boolean) => void
  savedFor: (project: string) => readonly SavedFilter[]
  save: (project: string, filter: SavedFilter) => void
  forget: (project: string, name: string) => void
}

export const useLogsPrefs = create<LogsPrefs>((set, get) => ({
  wrap: read(WRAP_KEY) === 'true',
  keepAcrossRestarts: read(KEEP_KEY) === 'true',
  saved: {},
  setWrap: (wrap) => {
    write(WRAP_KEY, wrap ? 'true' : null)
    set({ wrap })
  },
  setKeepAcrossRestarts: (keep) => {
    write(KEEP_KEY, keep ? 'true' : null)
    set({ keepAcrossRestarts: keep })
  },
  savedFor: (project) => get().saved[project] ?? parseSaved(read(SAVED_PREFIX + project)),
  save: (project, filter) => {
    const next = withSaved(get().savedFor(project), filter)
    write(SAVED_PREFIX + project, JSON.stringify(next))
    set((state) => ({ saved: { ...state.saved, [project]: next } }))
  },
  forget: (project, name) => {
    const next = get()
      .savedFor(project)
      .filter((item) => item.name !== name)
    write(SAVED_PREFIX + project, next.length > 0 ? JSON.stringify(next) : null)
    set((state) => ({ saved: { ...state.saved, [project]: next } }))
  },
}))

/** A project's saved filters, kept current as they change here or in another tab. */
export function useSavedFilters(project: string): readonly SavedFilter[] {
  const saved = useLogsPrefs((state) => state.saved[project])
  return saved ?? parseSaved(read(SAVED_PREFIX + project))
}

// Another tab changing a preference changes it here too.
if (typeof window !== 'undefined')
  window.addEventListener('storage', (event) => {
    if (event.key === WRAP_KEY) useLogsPrefs.setState({ wrap: event.newValue === 'true' })
    else if (event.key === KEEP_KEY)
      useLogsPrefs.setState({ keepAcrossRestarts: event.newValue === 'true' })
    else if (event.key?.startsWith(SAVED_PREFIX)) {
      const project = event.key.slice(SAVED_PREFIX.length)
      useLogsPrefs.setState((state) => ({
        saved: { ...state.saved, [project]: parseSaved(event.newValue) },
      }))
    }
  })
