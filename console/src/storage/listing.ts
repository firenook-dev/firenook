// The listing on screen — a folder's level, or everything under it — as the
// list and the grid both draw it: the engine's pages through the
// foundation's sliding window (`useCursorRows`), and what a live window of
// writes does to it.
//
// A listing by name with no filter is the fast path: the rows a window
// touched are read again through `:batchGet` and patched where they are,
// and a new name refetches only the page it falls in. Any other order, or a
// filter, is a view the engine built: it is never rebuilt under the app's
// writes; it counts the names they touched inside its scope and offers
// Refresh (`MatchCount`'s `stale`), which asks the engine for the view as
// the folder is now. A window too big to name (`truncated`)
// covering the listing starts it again from page one.

import { useInfiniteQuery } from '@tanstack/react-query'
import { useState } from 'react'
import type { StorageEntry } from '@/api/generated/storage/StorageEntry'
import type { StorageListPage } from '@/api/generated/storage/StorageListPage'
import type { StorageObjectsChanged } from '@/api/generated/storage/StorageObjectsChanged'
import { type CursorRows, useCursorRows } from '@/components/console/use-cursor-rows'
import { type StorageListScope, isFastPath } from './api'
import type { FilesState } from './files-state'
import { type ListScope, resetsList, touchedCount, touchedRows } from './live'
import { objectsList, readFreshNext } from './queries'

export interface Listing {
  scope: StorageListScope
  rows: CursorRows<StorageEntry>
  /** The first page's facts: the totals, whether a marker names the folder, the deciding decision. */
  page: StorageListPage | undefined
  /** Every loaded page (the access check asks once per page). */
  pages: readonly StorageListPage[]
  pending: boolean
  error: unknown
  /** Patched in place by live windows (by name, unfiltered). */
  fast: boolean
  /** Names touched in this view's scope since it was read (view path only). */
  stale: number
  /** Reads the view again from page one. */
  refresh: () => void
  /** A live window, for this listing. */
  apply: (batch: StorageObjectsChanged) => void
  retry: () => void
}

const NO_PAGES: readonly StorageListPage[] = []

export function useListing(files: FilesState): Listing {
  const scope: StorageListScope = {
    bucket: files.bucket,
    prefix: files.prefix,
    flat: files.flat,
    sort: files.sort,
    q: files.q.trim() ? files.q : undefined,
  }
  const list = objectsList(files.project, scope, files.viewAs)
  const query = useInfiniteQuery(list.options)
  const rows = useCursorRows<StorageEntry>(query, {
    queryKey: list.queryKey,
    fetchPage: list.fetchPage,
    rowKey: list.rowKey,
    batchGet: list.batchGet,
    q: scope.q,
    sort: scope.sort,
  })
  const fast = isFastPath(scope)

  // The stale count belongs to one view: another folder, filter or order
  // starts it again at zero.
  const viewKey = JSON.stringify(list.queryKey)
  const [stale, setStale] = useState<{ key: string; count: number }>({ key: viewKey, count: 0 })
  const staleCount = stale.key === viewKey ? stale.count : 0

  const listScope: ListScope = { prefix: scope.prefix, flat: scope.flat ?? false }
  const refresh = () => {
    setStale({ key: viewKey, count: 0 })
    // The engine rebuilds the view now rather than serve the one it has,
    // stale, for up to 2 s after a write.
    readFreshNext(list.queryKey)
    rows.reset()
  }
  // A first page the engine served from a view writes have moved since
  // (within its 2 s window) says so: its changes count as this view's.
  const first = query.data?.pages[0] as StorageListPage | undefined
  const served = !fast && first?.stale ? first.changesSince : 0
  const apply = (batch: StorageObjectsChanged) => {
    if (resetsList(batch, listScope)) {
      refresh()
      return
    }
    if (fast) {
      const keys = touchedRows(batch, listScope)
      if (keys.length > 0) rows.applyKeys(keys)
      return
    }
    const touched = touchedCount(batch, listScope)
    if (touched > 0)
      setStale((current) => ({
        key: viewKey,
        count: (current.key === viewKey ? current.count : 0) + touched,
      }))
  }

  return {
    scope,
    rows,
    page: first,
    pages: (query.data?.pages ?? NO_PAGES) as readonly StorageListPage[],
    pending: query.isPending,
    error: query.error,
    fast,
    stale: Math.max(staleCount, served),
    refresh,
    apply,
    retry: () => void query.refetch(),
  }
}
