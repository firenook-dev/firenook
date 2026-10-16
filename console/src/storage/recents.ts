// Where you were in a bucket: the last twelve folders and files opened,
// kept in this browser per project and bucket (`lib/recents.ts`), for ⌘K.
// Never authoritative: a recent that no longer exists opens on its own
// empty state, and storage that refuses or is cleared simply leaves the
// list empty.

import { type RecentEntry, createRecents } from '@/lib/recents'

export interface StorageRecent extends RecentEntry {
  /** A folder (ending in `/`, `''` for the root) or an object name. */
  path: string
  kind: 'folder' | 'file'
}

/** How many a bucket keeps. */
export const RECENTS_LIMIT = 12

export function recentsKey(project: string, bucket: string): string {
  return `firenook.console.storage-recents.${project}.${bucket}`
}

function isRecent(item: unknown): item is StorageRecent {
  if (typeof item !== 'object' || item === null) return false
  const candidate = item as Record<string, unknown>
  return (
    typeof candidate.path === 'string' &&
    (candidate.kind === 'folder' || candidate.kind === 'file') &&
    typeof candidate.at === 'number'
  )
}

export const useStorageRecents = createRecents<StorageRecent>({
  limit: RECENTS_LIMIT,
  isEntry: isRecent,
  same: (a, b) => a.path === b.path,
})
