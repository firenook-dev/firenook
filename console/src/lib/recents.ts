// Where you were: the things last opened in a section (Firestore's
// collections and documents, Storage's folders and files, Authentication's
// users), kept in this browser under a key per project and scope so a
// landing, a panel and ⌘K can offer them again. A convenience, never
// authoritative: storage that is unavailable, full or holding something
// unexpected leaves the list empty or keeps it for this page only, and a
// recent that no longer exists opens on its own empty state.
//
// One store per section (`createRecents`), each keeping its own entry shape
// and storage key; `load` switches it to a key (a project's database, a
// bucket), `record` puts an entry first.

import { type StoreApi, type UseBoundStore, create } from 'zustand'

/** An entry: what it is, and when it was last opened (epoch ms). */
export interface RecentEntry {
  at: number
}

export interface RecentsOptions<T extends RecentEntry> {
  /** How many the store keeps, newest first. */
  limit: number
  /** Whether a stored value is an entry; storage may hold anything. */
  isEntry: (value: unknown) => value is T
  /** Whether two entries are the same thing (a path, a tenant and uid). */
  same: (a: Omit<T, 'at'>, b: Omit<T, 'at'>) => boolean
}

export interface RecentsState<T extends RecentEntry> {
  /** The storage key the list belongs to; `''` before `load`. */
  key: string
  items: readonly T[]
  /** Switches to `key`'s list (a no-op for the current key). */
  load: (key: string) => void
  /** Puts `entry` first, now, dropping its older copy; nothing is written when it already leads unchanged. */
  record: (entry: Omit<T, 'at'>) => void
  /** Drops every entry `match` accepts (a user since deleted). */
  forget: (match: (item: T) => boolean) => void
}

/** `entry` first at `at`, any older copy of it dropped, at most `limit`. */
export function withRecent<T extends RecentEntry>(
  items: readonly T[],
  entry: Omit<T, 'at'>,
  at: number,
  options: Pick<RecentsOptions<T>, 'limit' | 'same'>,
): T[] {
  const first = { ...entry, at } as T
  return [first, ...items.filter((item) => !options.same(item, entry))].slice(0, options.limit)
}

/** Whether a stored entry holds `entry`'s values exactly, `at` aside. */
function unchanged(item: RecentEntry, entry: object): boolean {
  const stored = item as unknown as Record<string, unknown>
  const fields = Object.entries(entry)
  return (
    Object.keys(stored).length === fields.length + 1 &&
    fields.every(([field, value]) => stored[field] === value)
  )
}

function read<T extends RecentEntry>(key: string, options: RecentsOptions<T>): T[] {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter(options.isEntry).slice(0, options.limit) : []
  } catch {
    return []
  }
}

function write(key: string, items: readonly RecentEntry[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(items))
  } catch {
    // Full or refused storage: the list lives for this page only.
  }
}

/** A section's recents store (a Zustand hook): one list at a time, under the key `load` names. */
export function createRecents<T extends RecentEntry>(
  options: RecentsOptions<T>,
): UseBoundStore<StoreApi<RecentsState<T>>> {
  return create<RecentsState<T>>((set, get) => ({
    key: '',
    items: [],
    load: (key) => {
      if (get().key === key) return
      set({ key, items: read(key, options) })
    },
    record: (entry) => {
      const { key, items } = get()
      if (key === '') return
      const first = items[0]
      if (first && unchanged(first, entry)) return
      const next = withRecent(items, entry, Date.now(), options)
      set({ items: next })
      write(key, next)
    },
    forget: (match) => {
      const { key, items } = get()
      const next = items.filter((item) => !match(item))
      if (next.length === items.length) return
      set({ items: next })
      if (key !== '') write(key, next)
    },
  }))
}
