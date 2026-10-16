// Which rows are ticked for a bulk action: ephemeral, never in the URL, and
// gone when the list's scope changes (another bucket, folder, filter, order
// or identity). The table owns the gestures (Space ticks the cursor row,
// shift-click ranges, ⌘-click on a check box toggles one); this keeps what
// they produced, and says what a bulk action reaches — the ticked names, or
// with "Select all" every object the listing matches, loaded or not.

import { create } from 'zustand'
import type { BulkTarget } from '@/api/generated/BulkTarget'
import type { StorageEntry } from '@/api/generated/storage/StorageEntry'

interface SelectionState {
  /** The listing the ticks belong to. */
  scope: string
  checked: ReadonlySet<string>
  /** Every object the listing matches, not only the rows ticked by hand. */
  everything: boolean
  set: (checked: ReadonlySet<string>, everything: boolean) => void
  clear: () => void
}

export const useFileSelection = create<SelectionState>((set) => ({
  scope: '',
  checked: new Set(),
  everything: false,
  set: (checked, everything) => set({ checked, everything }),
  clear: () => set({ checked: new Set(), everything: false }),
}))

/** The ticks go when the list they were made in is no longer the one on screen. */
export function resetFileSelection(scope: string): void {
  if (useFileSelection.getState().scope === scope) return
  useFileSelection.setState({ scope, checked: new Set(), everything: false })
}

/** A listing's scope as a selection names it. */
export interface SelectionScope {
  bucket: string
  prefix: string
  flat: boolean
  q: string | undefined
}

/**
 * What a bulk action applies to: the ticked keys (a folder's key ends in
 * `/` and means everything under it), or with "Select all" the listing's
 * own query, so 48,213 matches never travel as 48,213 names.
 */
export function selectionTarget(
  checked: ReadonlySet<string>,
  everything: boolean,
  scope: SelectionScope,
): BulkTarget {
  if (everything)
    return {
      by: 'query',
      q: scope.q?.trim() ?? '',
      scope: { bucket: scope.bucket, prefix: scope.prefix, flat: scope.flat },
    }
  return { by: 'keys', keys: [...checked] }
}

/** What the ticked rows on screen hold: files, folders, and the bytes of both. */
export function selectionFigures(
  rows: readonly StorageEntry[],
  checked: ReadonlySet<string>,
): { files: number; folders: number; bytes: number; bytesKnown: boolean } {
  let files = 0
  let folders = 0
  let bytes = 0
  let bytesKnown = true
  for (const row of rows) {
    const key = row.type === 'folder' ? row.prefix : row.name
    if (!checked.has(key)) continue
    if (row.type === 'folder') {
      folders += 1
      if (row.bytes === null) bytesKnown = false
      else bytes += row.bytes
    } else {
      files += 1
      bytes += row.size
    }
  }
  return { files, folders, bytes, bytesKnown }
}
