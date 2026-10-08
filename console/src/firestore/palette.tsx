// What Firestore contributes to ⌘K while the workbench is on screen: any
// typed path, recent paths, every collection in the schema tree (a nested
// one opens as its group), the subcollections of the open document, and
// the workbench's own actions. The panel's toggle is the shell's.

import { useKumoToastManager } from '@cloudflare/kumo'
import {
  ArrowCounterClockwiseIcon,
  ArrowRightIcon,
  ClockCounterClockwiseIcon,
  DatabaseIcon,
  DownloadSimpleIcon,
  FileIcon,
  FolderIcon,
  FolderPlusIcon,
  FolderSimplePlusIcon,
  FunnelIcon,
  HouseIcon,
  LightningIcon,
  ShieldCheckIcon,
  UploadSimpleIcon,
} from '@phosphor-icons/react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo } from 'react'
import {
  type PaletteGroup,
  type PaletteItem,
  matchesQuery,
  usePaletteProviders,
} from '@/lib/palette'
import { useConsoleUi } from '@/lib/store'
import { normalizePath, useWorkbench } from './components/workbench-context'
import { useCreateDialog } from './create'
import { undoLatest } from './changelog'
import { useExportDialog } from './export'
import { useQueryLine } from './query-line-store'
import { FS, collectionsQuery } from './queries'
import { useRecents } from './recents'
import { flattenSchema, schemaQuery } from './schema'

export function useFirestorePalette() {
  const workbench = useWorkbench()
  const paletteOpen = useConsoleUi((state) => state.paletteOpen)
  const register = usePaletteProviders((state) => state.register)
  const unregister = usePaletteProviders((state) => state.unregister)
  const openCreate = useCreateDialog((state) => state.open)
  const openQuery = useQueryLine((state) => state.setOpen)
  const setExplain = useQueryLine((state) => state.setExplain)
  const openExport = useExportDialog((state) => state.setOpen)
  const toasts = useKumoToastManager()
  const queryClient = useQueryClient()
  const recents = useRecents((state) => state.items)
  const selected = workbench.selectedDocument
  const roots = useQuery({ ...collectionsQuery(workbench.ownerScope, ''), enabled: paletteOpen })
  const schema = useQuery({ ...schemaQuery(workbench.database), enabled: paletteOpen })
  const under = useQuery({
    ...collectionsQuery(workbench.ownerScope, selected ?? ''),
    enabled: paletteOpen && Boolean(selected),
  })

  const provider = useMemo(() => {
    const go = (path: string) => () => workbench.setPath(path)
    // The schema tree lists every shape; the plain root list stands in
    // until it has answered.
    const shapes = flattenSchema(schema.data)
    const known = new Set([
      ...(roots.data ?? []),
      ...shapes.map((entry) => entry.node.pattern),
      ...recents.map((recent) => recent.path),
    ])
    const plural = (count: number, word: string) =>
      `${count.toLocaleString('en-US')} ${word}${count === 1 ? '' : 's'}`
    const collections: PaletteItem[] = [
      ...(selected
        ? (under.data ?? []).map<PaletteItem>((id) => ({
            id: `sub:${selected}/${id}`,
            title: id,
            breadcrumbs: [selected],
            keywords: `${selected}/${id}`,
            icon: <DatabaseIcon size={16} />,
            run: go(`${selected}/${id}`),
          }))
        : []),
      ...(schema.data
        ? shapes.map<PaletteItem>(({ node, depth, parent }) => {
            const item: PaletteItem = {
              id: `shape:${node.pattern}`,
              title: node.id,
              description:
                depth === 0
                  ? plural(node.documents, 'document')
                  : `${plural(node.documents, 'document')} across every ${parent?.id ?? 'parent'}`,
              keywords: node.pattern,
              icon: depth === 0 ? <DatabaseIcon size={16} /> : <FolderIcon size={16} />,
              run: go(node.pattern),
            }
            if (parent) item.breadcrumbs = [parent.pattern]
            return item
          })
        : (roots.data ?? []).map<PaletteItem>((id) => ({
            id: `root:${id}`,
            title: id,
            icon: <DatabaseIcon size={16} />,
            run: go(id),
          }))),
    ]
    const recentItems = recents.map<PaletteItem>((recent) => ({
      id: `recent:${recent.path}`,
      title: recent.path,
      icon:
        recent.kind === 'document' ? (
          <FileIcon size={16} />
        ) : (
          <ClockCounterClockwiseIcon size={16} />
        ),
      run: go(recent.path),
    }))
    const actions: PaletteItem[] = []
    actions.push({
      id: 'fs:rules',
      title: 'Security rules',
      description: `Edit the rules this database is served with`,
      keywords: 'permissions allow deny security firestore.rules',
      icon: <ShieldCheckIcon size={16} />,
      run: () => workbench.navigate({ view: 'rules' }),
    })
    actions.push({
      id: 'fs:undo',
      title: 'Undo the last change',
      description: 'Whoever made it, if nothing has moved on since',
      keywords: 'revert back restore mistake',
      icon: <ArrowCounterClockwiseIcon size={16} />,
      run: () => {
        void undoLatest(workbench.database)
          .then((result) => {
            toasts.add({
              title:
                result.documents === 1
                  ? 'Change undone'
                  : `Change undone · ${result.documents} documents`,
              description: 'The documents are back as they were before that write.',
              variant: 'success',
            })
            void queryClient.invalidateQueries({ queryKey: [FS, workbench.database] })
          })
          .catch((error: unknown) => {
            toasts.add({
              title: 'Nothing was undone',
              description: error instanceof Error ? error.message : String(error),
              variant: 'error',
            })
          })
      },
    })
    if (workbench.collectionPath)
      actions.push(
        {
          id: 'fs:new-document',
          title: 'New document',
          description: `In ${workbench.collectionPath}`,
          keywords: 'add create',
          icon: <FileIcon size={16} />,
          run: () => openCreate({ kind: 'document', collection: workbench.collectionPath }),
        },
        {
          id: 'fs:filter',
          title: 'Filter this collection',
          description: 'where(…).orderBy(…).limit(n)',
          keywords: 'query where order',
          icon: <FunnelIcon size={16} />,
          run: () => openQuery(true),
        },
        {
          id: 'fs:explain',
          title: 'Explain this query',
          description: 'What it reads, and the index production needs',
          keywords: 'plan index slow performance composite',
          icon: <LightningIcon size={16} />,
          run: () => setExplain(true),
        },
        {
          id: 'fs:export',
          title: 'Export',
          description: 'This query as JSON, NDJSON or CSV',
          keywords: 'download csv ndjson json save',
          icon: <DownloadSimpleIcon size={16} />,
          run: () => openExport(true),
        },
        {
          id: 'fs:import',
          title: 'Import JSON',
          description: `Into ${workbench.collectionPath}`,
          keywords: 'upload ndjson',
          icon: <UploadSimpleIcon size={16} />,
          run: () => openCreate({ kind: 'import', collection: workbench.collectionPath }),
        },
      )
    if (selected)
      actions.push({
        id: 'fs:new-subcollection',
        title: 'New subcollection',
        description: `Under ${selected}`,
        keywords: 'add create',
        icon: <FolderSimplePlusIcon size={16} />,
        run: () => openCreate({ kind: 'collection', parent: selected }),
      })
    actions.push({
      id: 'fs:new-collection',
      title: 'New root collection',
      keywords: 'add create',
      icon: <FolderPlusIcon size={16} />,
      run: () => openCreate({ kind: 'collection', parent: '' }),
    })
    if (workbench.path)
      actions.push({
        id: 'fs:root',
        title: 'Go to the Firestore root',
        description: workbench.database,
        keywords: 'home database',
        icon: <HouseIcon size={16} />,
        run: go(''),
      })

    return (query: string): PaletteGroup[] => {
      const filter = (items: PaletteItem[]) => items.filter((item) => matchesQuery(item, query))
      const groups: PaletteGroup[] = [
        { label: 'Recent', items: filter(recentItems) },
        { label: 'Collections', items: filter(collections) },
        { label: 'Firestore', items: filter(actions) },
      ].filter((group) => group.items.length > 0)
      // Text shaped like a path, or matching nothing, can be opened as one.
      const path = normalizePath(query)
      const pathLike = query.includes('/') || groups.length === 0
      if (path && pathLike && !known.has(path))
        groups.unshift({
          label: 'Go to',
          items: [
            {
              id: `fs:go:${path}`,
              title: path,
              description:
                path.split('/').length % 2 === 0 ? 'Open this document' : 'Open this collection',
              icon: <ArrowRightIcon size={16} />,
              run: go(path),
            },
          ],
        })
      return groups
    }
  }, [
    workbench,
    roots.data,
    schema.data,
    under.data,
    recents,
    selected,
    openCreate,
    openQuery,
    setExplain,
    openExport,
    toasts,
    queryClient,
  ])

  useEffect(() => {
    register('firestore', provider)
    return () => unregister('firestore')
  }, [register, unregister, provider])
}
