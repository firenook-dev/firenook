// Where you were in a bucket: the last twelve folders and files opened,
// kept in this browser per project and bucket, for ⌘K. Never authoritative:
// a recent that no longer exists opens on its own empty state, and storage
// that refuses or is cleared simply leaves the list empty.

import { create } from 'zustand'

export interface StorageRecent {
  /** A folder (ending in `/`, `''` for the root) or an object name. */
  path: string
  kind: 'folder' | 'file'
  at: number
}

/** How many a bucket keeps. */
export const RECENTS_LIMIT = 12

export function recentsKey(project: string, bucket: string): string {
  return `firenook.console.storage-recents.${project}.${bucket}`
}

function read(key: string): StorageRecent[] {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(
        (item): item is StorageRecent =>
          typeof item === 'object' &&
          item !== null &&
          typeof (item as StorageRecent).path === 'string' &&
          ((item as StorageRecent).kind === 'folder' || (item as StorageRecent).kind === 'file') &&
          typeof (item as StorageRecent).at === 'number',
      )
      .slice(0, RECENTS_LIMIT)
  } catch {
    return []
  }
}

function write(key: string, items: readonly StorageRecent[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(items))
  } catch {
    // Full or refused storage: the list lives for this page only.
  }
}

/** `path` first, any older entry for it dropped, at most twelve. */
export function withRecent(
  items: readonly StorageRecent[],
  path: string,
  kind: StorageRecent['kind'],
  at: number,
): StorageRecent[] {
  return [{ path, kind, at }, ...items.filter((item) => item.path !== path)].slice(0, RECENTS_LIMIT)
}

interface RecentsState {
  key: string
  items: readonly StorageRecent[]
  load: (key: string) => void
  record: (path: string, kind: StorageRecent['kind']) => void
}

export const useStorageRecents = create<RecentsState>((set, get) => ({
  key: '',
  items: [],
  load: (key) => {
    if (get().key === key) return
    set({ key, items: read(key) })
  },
  record: (path, kind) => {
    const { key, items } = get()
    if (key === '' || items[0]?.path === path) return
    const next = withRecent(items, path, kind, Date.now())
    write(key, next)
    set({ items: next })
  },
}))
