// What every part of the Files page reads about where it is: the project,
// the buckets and the one in view, the folder, the open object, how the
// listing is narrowed and ordered, the layout, and who the page acts as —
// all of it from the URL (`search.ts`), with the moves that change it.
// Built once by the page and handed down through a context, so the panel,
// both toolbar rows, the list or grid and the inspector agree on one view.

import { useQuery } from '@tanstack/react-query'
import { createContext, useContext } from 'react'
import type { StorageBuckets } from '@/api/generated/storage/StorageBuckets'
import { type ViewAs, parseViewAs, serializeViewAs } from '@/lib/identity'
import { useConsoleProject } from '@/lib/project'
import { DEFAULT_SORT } from './api'
import { bucketsQuery } from './queries'
import { type FilesSearch, bucketPatch, pathPatch, useFilesSearch } from './search'

export interface FilesState {
  project: string
  buckets: StorageBuckets
  /** The bucket in view: the URL's, else the default one. */
  bucket: string
  /** `''` for the bucket root, else ending in `/`. */
  prefix: string
  /** The object open in the inspector. */
  object: string | undefined
  tab: 'details' | 'metadata' | 'activity'
  layout: 'list' | 'grid'
  /** `<column>:<dir>`, `name:asc` when the URL says nothing. */
  sort: string
  q: string
  flat: boolean
  viewAs: ViewAs
  /** The page acts as the owner: rules do not apply and tokens are visible. */
  admin: boolean
  search: FilesSearch
  update: (patch: Partial<FilesSearch>, options?: { replace?: boolean }) => void
  /** Another folder of this bucket. */
  goTo: (prefix: string) => void
  setBucket: (bucket: string) => void
  /** The inspector on an object, or shut (`undefined`). */
  openObject: (name: string | undefined, options?: { replace?: boolean }) => void
  setViewAs: (viewAs: ViewAs) => void
}

/** The page's state, or `undefined` until the buckets have been read. */
export function useFilesStateValue(): FilesState | undefined {
  const { project } = useConsoleProject()
  const { search, update } = useFilesSearch()
  const buckets = useQuery({ ...bucketsQuery(project), enabled: project !== '' })
  if (!buckets.data) return undefined
  const bucket = search.bucket ?? buckets.data.defaultBucket
  const viewAs = parseViewAs(search.as)
  return {
    project,
    buckets: buckets.data,
    bucket,
    prefix: search.path ?? '',
    object: search.object,
    tab: search.tab ?? 'details',
    layout: search.layout ?? 'list',
    sort: search.sort ?? DEFAULT_SORT,
    q: search.q ?? '',
    flat: search.flat ?? false,
    viewAs,
    admin: viewAs.kind === 'owner',
    search,
    update,
    goTo: (prefix) => update(pathPatch(prefix)),
    setBucket: (next) =>
      update(bucketPatch(next === buckets.data.defaultBucket ? undefined : next)),
    openObject: (name, options) =>
      update({ object: name, ...(name === undefined ? { dialog: undefined } : {}) }, options),
    setViewAs: (next) => update({ as: serializeViewAs(next) }),
  }
}

const FilesContext = createContext<FilesState | null>(null)

export const FilesProvider = FilesContext.Provider

/** The Files page's state; only inside the page. */
export function useFiles(): FilesState {
  const state = useContext(FilesContext)
  if (!state) throw new Error('useFiles is used outside the Files page')
  return state
}
