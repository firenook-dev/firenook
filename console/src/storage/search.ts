// Every view of the Files page is a link: it keeps the bucket, the folder,
// the open object and its tab, the layout, the order, the filter, the scope
// and the identity in its search params. (The Rules page reads the rules
// kit's one schema with `bucket` as its scope: `rules-page/rules-search.ts`.)
//
// Defaults never reach the address (`stripSearchParams(FILES_DEFAULTS)` on
// the route, and the default bucket is dropped by the route's own
// middleware, since only the bucket list knows which it is), so a link
// carries only what makes the view different.

import { z } from 'zod'
import { useRouteSearch, zFlag } from '@/lib/search-params'
import { normalizeFolder } from './paths'

/** The columns a listing sorts by (`GET /storage/objects/meta` `sortable`). */
export const SORT_COLUMNS = ['name', 'size', 'updated', 'type'] as const

export type SortColumn = (typeof SORT_COLUMNS)[number]

const SORT = /^(name|size|updated|type):(asc|desc)$/

/**
 * `users/u_9f3k2/` — no leading slash added, one trailing; `''` is the
 * bucket root. Empty segments are kept: `a//` and `/` are folders GCS allows.
 */
const folder = z.string().transform(normalizeFolder)

export const filesSearch = z.object({
  // The scope; dropped for the default bucket.
  bucket: z.string().optional(),
  // The folder in view; dropped for the root.
  path: folder.optional(),
  // The entity: the full name of the object open in the inspector.
  object: z.string().optional(),
  // The inspector's tab.
  tab: z.enum(['details', 'metadata', 'activity']).optional(),
  // The display mode.
  layout: z.enum(['list', 'grid']).optional(),
  // The engine's order, `<column>:<asc|desc>`; another column is dropped.
  sort: z
    .string()
    .optional()
    .transform((raw) => (raw !== undefined && SORT.test(raw) ? raw : undefined)),
  // The filter, in the foundation's grammar over Storage's fields.
  q: z.string().optional(),
  // Everything under the folder, not only what is directly in it.
  flat: zFlag,
  // Who the page acts as (`serializeViewAs`).
  as: z.string().optional(),
  // A create dialog: New folder, Upload with options.
  new: z.enum(['folder', 'upload']).optional(),
  // Another dialog a link can open: Quick Look on `object`.
  dialog: z.enum(['quick-look']).optional(),
})

export type FilesSearch = z.infer<typeof filesSearch>

/** What the address leaves out. */
export const FILES_DEFAULTS = { tab: 'details', layout: 'list', sort: 'name:asc' } as const

/** The Files page's search params and their patch-style updater. */
export function useFilesSearch() {
  return useRouteSearch<FilesSearch>('/storage', '/storage')
}

/**
 * Another bucket: what belonged to the old one goes with it — the folder,
 * the open object, the filter, the scope and an open dialog. The order, the
 * layout and the identity stay.
 */
export function bucketPatch(bucket: string | undefined): Partial<FilesSearch> {
  return {
    bucket,
    path: undefined,
    object: undefined,
    q: undefined,
    flat: undefined,
    dialog: undefined,
  }
}

/**
 * Another folder: the open object, the filter and an open dialog go; the
 * scope, the order, the layout and the identity stay.
 */
export function pathPatch(path: string): Partial<FilesSearch> {
  return { path: path || undefined, object: undefined, q: undefined, dialog: undefined }
}

/** The order a `sort` param names, `name:asc` when none. */
export function sortOf(raw: string | undefined): { column: SortColumn; direction: 'asc' | 'desc' } {
  const match = raw === undefined ? null : SORT.exec(raw)
  if (!match) return { column: 'name', direction: 'asc' }
  return { column: match[1] as SortColumn, direction: match[2] as 'asc' | 'desc' }
}
