// Where you were: the last collections and documents opened in this
// database, kept in this browser so the root landing and the ⌘K palette
// can offer them. Never authoritative; a missing entry simply is not shown.

import { create } from 'zustand'

export interface Recent {
  path: string
  kind: 'collection' | 'document'
  at: number
}

const LIMIT = 12

interface RecentsState {
  key: string
  items: Recent[]
  load: (key: string) => void
  record: (path: string, kind: Recent['kind']) => void
}

function read(key: string): Recent[] {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (item): item is Recent =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as Recent).path === 'string' &&
        ((item as Recent).kind === 'collection' || (item as Recent).kind === 'document') &&
        typeof (item as Recent).at === 'number',
    )
  } catch {
    return []
  }
}

function write(key: string, items: Recent[]) {
  try {
    localStorage.setItem(key, JSON.stringify(items))
  } catch {
    // Storage may be unavailable; recents are a convenience.
  }
}

export function recentsKey(project: string, database: string): string {
  return `firenook.console.recents.${project}.${database}`
}

export const useRecents = create<RecentsState>((set, get) => ({
  key: '',
  items: [],
  load: (key) => {
    if (get().key === key) return
    set({ key, items: read(key) })
  },
  record: (path, kind) => {
    const { key, items } = get()
    if (!key || !path) return
    const next = [
      { path, kind, at: Date.now() },
      ...items.filter((item) => item.path !== path),
    ].slice(0, LIMIT)
    set({ items: next })
    write(key, next)
  },
}))
