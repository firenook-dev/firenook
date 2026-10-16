// Where you were: the last collections and documents opened in this
// database, kept in this browser (`lib/recents.ts`) so the root landing and
// the ⌘K palette can offer them. Never authoritative; a missing entry
// simply is not shown.

import { type RecentEntry, createRecents } from '@/lib/recents'

export interface Recent extends RecentEntry {
  path: string
  kind: 'collection' | 'document'
}

export function recentsKey(project: string, database: string): string {
  return `firenook.console.recents.${project}.${database}`
}

function isRecent(item: unknown): item is Recent {
  if (typeof item !== 'object' || item === null) return false
  const candidate = item as Record<string, unknown>
  return (
    typeof candidate.path === 'string' &&
    (candidate.kind === 'collection' || candidate.kind === 'document') &&
    typeof candidate.at === 'number'
  )
}

/** Twelve per database, newest first; a path once, as what it last was opened as. */
export const useRecents = createRecents<Recent>({
  limit: 12,
  isEntry: isRecent,
  same: (a, b) => a.path === b.path,
})
