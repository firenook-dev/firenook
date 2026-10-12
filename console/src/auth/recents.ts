// The users last opened, per project, kept in this browser so the Users
// panel and ⌘K can offer them again. A convenience only: storage that is
// unavailable or holds something unexpected simply offers nothing, and a
// user who has since been deleted is a link that opens "This user was
// deleted.".

import { create } from 'zustand'

export interface RecentUser {
  /** The tenant id, or `''` for the project's own users. */
  tenant: string
  uid: string
  /** What the row showed: the email, phone, name, or the uid. */
  label: string
  at: number
}

/** How many the store keeps across every tenant of a project. */
export const RECENT_LIMIT = 24
/** How many one tenant's panel shows. */
export const RECENT_SHOWN = 12

export function recentsKey(project: string): string {
  return `firenook.console.auth.recents.${project}`
}

function isRecent(item: unknown): item is RecentUser {
  if (typeof item !== 'object' || item === null) return false
  const candidate = item as Record<string, unknown>
  return (
    typeof candidate.tenant === 'string' &&
    typeof candidate.uid === 'string' &&
    typeof candidate.label === 'string' &&
    typeof candidate.at === 'number'
  )
}

function read(key: string): RecentUser[] {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter(isRecent).slice(0, RECENT_LIMIT) : []
  } catch {
    return []
  }
}

function write(key: string, items: readonly RecentUser[]) {
  try {
    localStorage.setItem(key, JSON.stringify(items))
  } catch {
    // Storage may be unavailable or full; recents are a convenience.
  }
}

interface RecentsState {
  key: string
  items: RecentUser[]
  load: (key: string) => void
  record: (recent: Omit<RecentUser, 'at'>) => void
  forget: (tenant: string, uid: string) => void
}

export const useRecentUsers = create<RecentsState>((set, get) => ({
  key: '',
  items: [],
  load: (key) => {
    if (get().key === key) return
    set({ key, items: read(key) })
  },
  record: (recent) => {
    const { key, items } = get()
    if (!key || !recent.uid) return
    // Already the newest, as it is: nothing to write (opening the same user twice).
    const first = items[0]
    if (
      first &&
      first.tenant === recent.tenant &&
      first.uid === recent.uid &&
      first.label === recent.label
    )
      return
    const next = [
      { ...recent, at: Date.now() },
      ...items.filter((item) => item.tenant !== recent.tenant || item.uid !== recent.uid),
    ].slice(0, RECENT_LIMIT)
    set({ items: next })
    write(key, next)
  },
  forget: (tenant, uid) => {
    const { key, items } = get()
    const next = items.filter((item) => item.tenant !== tenant || item.uid !== uid)
    if (next.length === items.length) return
    set({ items: next })
    write(key, next)
  },
}))

/** One tenant's recents (or the project users'), newest first. */
export function recentsOf(items: readonly RecentUser[], tenant: string): RecentUser[] {
  return items.filter((item) => item.tenant === tenant).slice(0, RECENT_SHOWN)
}
