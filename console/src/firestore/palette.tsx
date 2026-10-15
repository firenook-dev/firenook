// What Firestore contributes to ⌘K while the workbench is on screen: the
// recent paths and the workbench's own actions. Collections and documents
// are the engine's search hits (every section's palette shows them, with
// their counts, from any page), and a path the data does not hold yet is
// typed into the path bar, which offers to create it; the panel's toggle
// is the shell's.

import {
  ClockCounterClockwiseIcon,
  DownloadSimpleIcon,
  FileIcon,
  FolderPlusIcon,
  FolderSimplePlusIcon,
  FunnelIcon,
  HouseIcon,
  LightningIcon,
  ShieldCheckIcon,
  UploadSimpleIcon,
} from '@phosphor-icons/react'
import { useNavigate } from '@tanstack/react-router'
import { useEffect, useMemo } from 'react'
import {
  type PaletteGroup,
  type PaletteItem,
  matchesQuery,
  usePaletteProviders,
} from '@/lib/palette'
import { useWorkbench } from './components/workbench-context'
import { useCreateDialog } from './create'
import { useExportDialog } from './export'
import { useQueryLine } from './query-line-store'
import { useRecents } from './recents'
import { patternOf } from './schema'

export function useFirestorePalette() {
  const workbench = useWorkbench()
  const navigate = useNavigate()
  const register = usePaletteProviders((state) => state.register)
  const unregister = usePaletteProviders((state) => state.unregister)
  const openCreate = useCreateDialog((state) => state.open)
  const openQuery = useQueryLine((state) => state.setOpen)
  const setExplain = useQueryLine((state) => state.setExplain)
  const openExport = useExportDialog((state) => state.setOpen)
  const recents = useRecents((state) => state.items)
  const selected = workbench.selectedDocument

  const provider = useMemo(() => {
    const go = (path: string) => () => workbench.setPath(path)
    // What ⌘K's engine search would also find (it searches the emulator's
    // own project), so it shows each once: a collection by its pattern, a
    // document by its path. Another project's rows name other things.
    const ref = (kind: 'collection' | 'document', path: string) =>
      workbench.foreign
        ? undefined
        : { kind: `firestore.${kind}`, key: `${workbench.database}|${path}` }
    const collectionRef = (path: string) =>
      patternOf(path) === path ? ref('collection', path) : undefined
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
      ref: recent.kind === 'document' ? ref('document', recent.path) : collectionRef(recent.path),
    }))
    const actions: PaletteItem[] = []
    actions.push({
      id: 'fs:rules',
      title: 'Security rules',
      description: `Edit the rules this database is served with, and see what they decided`,
      keywords: 'permissions allow deny security firestore.rules decisions requests playground',
      icon: <ShieldCheckIcon size={16} />,
      run: () =>
        void navigate({
          to: '/firestore/rules',
          search: { db: workbench.database === '(default)' ? undefined : workbench.database },
        }),
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
      return [
        { label: 'Recent', items: filter(recentItems) },
        { label: 'Firestore', items: filter(actions) },
      ].filter((group) => group.items.length > 0)
    }
  }, [workbench, recents, selected, openCreate, openQuery, setExplain, openExport, navigate])

  useEffect(() => {
    register('firestore', provider)
    return () => unregister('firestore')
  }, [register, unregister, provider])
}
