// What Storage contributes to ⌘K while the Files page is on screen: any
// typed or pasted Storage location ("Open gs://b/p"), the folders and files
// opened lately in this bucket, the other buckets, the folders the tree
// has read and those in view, and the page's own actions. The cursor row's
// menu arrives through the table's `useRowMenuPalette`; objects and folders
// anywhere come from the engine's search, and a row here names the same
// thing by its `ref`, so ⌘K shows it once.

import {
  ArrowRightIcon,
  ClockCounterClockwiseIcon,
  CopySimpleIcon,
  DownloadSimpleIcon,
  FileIcon,
  FilePlusIcon,
  FolderIcon,
  FolderPlusIcon,
  FolderSimplePlusIcon,
  HardDrivesIcon,
  ListIcon,
  SlidersHorizontalIcon,
  SquaresFourIcon,
  TrashIcon,
  TreeStructureIcon,
} from '@phosphor-icons/react'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useLayoutEffect, useRef } from 'react'
import type { StorageListPage } from '@/api/generated/storage/StorageListPage'
import { download } from '@/lib/download'
import { formatBytes, formatNumber } from '@/lib/format'
import {
  type PaletteGroup,
  type PaletteItem,
  matchesQuery,
  usePaletteProviders,
} from '@/lib/palette'
import { exportUrl } from './api'
import { copyToClipboard } from '@/lib/copy'
import type { FilesState } from './files-state'
import { baseName, gsUrl, parentOf, parseLocation } from './paths'
import { storageKeys } from './queries'
import type { StorageRecent } from './recents'
import { bucketPatch } from './search'

/** What the page can do that ⌘K offers. */
export interface PaletteActions {
  uploadFiles: () => void
  uploadFolder: () => void
  /** Present while rows are ticked. */
  editSelection?: (() => void) | undefined
  emptyBucket: () => void
}

/** The entity a palette row stands for, as the engine's search names it. */
function ref(bucket: string, path: string) {
  return path.endsWith('/') || path === ''
    ? { kind: 'storage.folder', key: `${bucket}|${path}` }
    : { kind: 'storage.object', key: `${bucket}|${path}` }
}

/** The rows ⌘K shows for `query`, from what the page knows now. */
export function storagePaletteGroups(
  query: string,
  context: {
    files: FilesState
    recents: readonly StorageRecent[]
    folders: readonly string[]
    actions: PaletteActions
  },
): PaletteGroup[] {
  const { files, recents, folders, actions } = context
  const open = (bucket: string, path: string) => () => {
    const other =
      bucket === files.bucket
        ? {}
        : bucketPatch(bucket === files.buckets.defaultBucket ? undefined : bucket)
    if (path === '' || path.endsWith('/'))
      files.update({ ...other, path: path || undefined, object: undefined, q: undefined })
    else files.update({ ...other, path: parentOf(path) || undefined, object: path, q: undefined })
  }
  const filter = (items: PaletteItem[]) => items.filter((item) => matchesQuery(item, query))
  const where = files.prefix === '' ? `gs://${files.bucket}` : files.prefix

  const recentItems = recents.map<PaletteItem>((recent) => ({
    id: `storage-recent:${recent.path}`,
    title: recent.path === '' ? `gs://${files.bucket}` : recent.path,
    icon: recent.kind === 'file' ? <FileIcon size={16} /> : <ClockCounterClockwiseIcon size={16} />,
    run: open(files.bucket, recent.path),
    ref: ref(files.bucket, recent.path),
  }))
  const bucketItems = files.buckets.buckets
    .filter((bucket) => bucket.name !== files.bucket)
    .map<PaletteItem>((bucket) => ({
      id: `storage-bucket:${bucket.name}`,
      title: `Switch to bucket ${bucket.name}`,
      description:
        bucket.objects === null
          ? undefined
          : `${formatNumber(bucket.objects)} · ${formatBytes(bucket.bytes ?? 0)}`,
      keywords: 'bucket storage',
      icon: <HardDrivesIcon size={16} />,
      run: () => files.setBucket(bucket.name),
    }))
  const folderItems = folders.map<PaletteItem>((prefix) => ({
    id: `storage-folder:${prefix}`,
    title: baseName(prefix) || '(empty)',
    breadcrumbs: parentOf(prefix.slice(0, -1)) ? [parentOf(prefix.slice(0, -1))] : [],
    keywords: prefix,
    icon: <FolderIcon size={16} />,
    run: open(files.bucket, prefix),
    ref: ref(files.bucket, prefix),
  }))
  const actionItems: PaletteItem[] = [
    {
      id: 'storage:upload',
      title: 'Upload files',
      description: `Into ${where}`,
      keywords: 'add',
      icon: <FilePlusIcon size={16} />,
      run: actions.uploadFiles,
    },
    {
      id: 'storage:upload-folder',
      title: 'Upload a folder',
      description: `Into ${where}`,
      keywords: 'add directory',
      icon: <FolderSimplePlusIcon size={16} />,
      run: actions.uploadFolder,
    },
    {
      id: 'storage:upload-options',
      title: 'Upload with options',
      description: 'contentType, cacheControl and custom metadata for every file',
      keywords: 'metadata',
      icon: <SlidersHorizontalIcon size={16} />,
      run: () => files.update({ new: 'upload' }),
    },
    {
      id: 'storage:new-folder',
      title: 'New folder',
      description: `In ${where}`,
      keywords: 'create directory',
      icon: <FolderPlusIcon size={16} />,
      run: () => files.update({ new: 'folder' }),
    },
    files.layout === 'list'
      ? {
          id: 'storage:grid',
          title: 'Show the grid',
          keywords: 'thumbnails layout tiles',
          icon: <SquaresFourIcon size={16} />,
          run: () => files.update({ layout: 'grid' }, { replace: true }),
        }
      : {
          id: 'storage:list',
          title: 'Show the list',
          keywords: 'layout table',
          icon: <ListIcon size={16} />,
          run: () => files.update({ layout: undefined }, { replace: true }),
        },
    files.flat
      ? {
          id: 'storage:level',
          title: 'This folder only',
          keywords: 'scope',
          icon: <FolderIcon size={16} />,
          run: () => files.update({ flat: undefined }),
        }
      : {
          id: 'storage:flat',
          title: 'Everything under this folder',
          keywords: 'scope flat recursive',
          icon: <TreeStructureIcon size={16} />,
          run: () => files.update({ flat: true }),
        },
    {
      id: 'storage:zip',
      title: files.prefix === '' ? 'Download the bucket as .zip' : 'Download this folder as .zip',
      description: where,
      keywords: 'export archive',
      icon: <DownloadSimpleIcon size={16} />,
      run: () => void download(exportUrl(files.bucket, files.prefix)),
    },
    {
      id: 'storage:copy-url',
      title: `Copy the gs:// URL of ${files.prefix === '' ? 'the bucket' : 'this folder'}`,
      description: gsUrl(files.bucket, files.prefix),
      keywords: 'clipboard link',
      icon: <CopySimpleIcon size={16} />,
      run: () => void copyToClipboard(gsUrl(files.bucket, files.prefix), { what: 'the gs:// URL' }),
    },
    ...(actions.editSelection
      ? [
          {
            id: 'storage:edit-selection',
            title: 'Edit metadata of the selection',
            keywords: 'bulk',
            icon: <SlidersHorizontalIcon size={16} />,
            run: actions.editSelection,
          },
        ]
      : []),
    {
      id: 'storage:empty',
      title: 'Empty the bucket…',
      description: `Delete every object in ${files.bucket}`,
      keywords: 'delete clear wipe',
      icon: <TrashIcon size={16} />,
      run: actions.emptyBucket,
    },
  ]

  const groups: PaletteGroup[] = [
    { label: 'Recent', items: filter(recentItems) },
    { label: 'Folders', items: filter(folderItems).slice(0, 20) },
    { label: 'Buckets', items: filter(bucketItems) },
    { label: 'Storage', items: filter(actionItems) },
  ].filter((group) => group.items.length > 0)

  // Text that names a Storage location opens it, whatever else matched.
  const text = query.trim()
  if (text.includes('/') || text.startsWith('gs:')) {
    const location = parseLocation(text, {
      buckets: files.buckets.buckets.map((bucket) => bucket.name),
      bucket: files.bucket,
    })
    if (location)
      groups.unshift({
        label: 'Go to',
        items: [
          {
            id: `storage-go:${location.bucket}|${location.path}`,
            title: `Open ${gsUrl(location.bucket, location.path)}`,
            icon: <ArrowRightIcon size={16} />,
            run: open(location.bucket, location.path),
            ref: ref(location.bucket, location.path),
          },
        ],
      })
  }
  return groups
}

/** Registers Storage's ⌘K rows while the Files page is mounted. */
export function useStoragePalette(context: {
  files: FilesState
  recents: readonly StorageRecent[]
  actions: PaletteActions
}): void {
  const queryClient = useQueryClient()
  const register = usePaletteProviders((state) => state.register)
  const unregister = usePaletteProviders((state) => state.unregister)
  // Registered once; each search reads what the page knows then.
  const latest = useRef(context)
  useLayoutEffect(() => {
    latest.current = context
  })
  useEffect(() => {
    register('storage', (query) => {
      const { files, recents, actions } = latest.current
      // The folders the tree has read, and the ones in the listing on screen.
      const folders = new Set<string>()
      for (const [, page] of queryClient.getQueriesData<StorageListPage>({
        queryKey: storageKeys.treeOf(files.project, files.bucket),
      }))
        for (const entry of page?.items ?? [])
          if (entry.type === 'folder') folders.add(entry.prefix)
      return storagePaletteGroups(query, { files, recents, folders: [...folders], actions })
    })
    return () => unregister('storage')
  }, [register, unregister, queryClient])
}
