// The Firestore workbench fills the content column edge to edge: the
// schema panel in the shell's panel slot, a toolbar with the path and the
// actions, the query line when summoned, then the grid with the inspector
// beside it when a document is open. Everything on screen is live from the
// engine's change feed.

import { Button, Text } from '@cloudflare/kumo'
import { TrashIcon } from '@phosphor-icons/react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { statusQuery } from '@/api/queries'
import { LiveDot } from '@/components/kit'
import { Page } from '@/components/shell/page'
import { useCreateDialog } from '../create'
import { useLive, useLiveChanges } from '../live'
import { useFirestorePalette } from '../palette'
import { resetColumns, useQueryLine } from '../query-line-store'
import { recentsKey, useRecents } from '../recents'
import { resetSelection, useSelection } from '../selection'
import { CreateDialog } from './create-dialog'
import { DeleteDialog } from './delete-dialog'
import { Grid } from './grid'
import { Inspector } from './inspector'
import { NewMenu } from './new-menu'
import { PathBar } from './path-bar'
import { QueryLine } from './query-line'
import { RequestsDrawer } from './requests-drawer'
import { SchemaPanel } from './schema-panel'
import { WorkbenchProvider, useWorkbench, useWorkbenchState } from './workbench-context'

export function FirestoreWorkbench() {
  const workbench = useWorkbenchState()
  const status = useQuery(statusQuery)
  if (!workbench) {
    return (
      <Page className="grid gap-1.5">
        <Text variant="heading" size="lg" as="h1">
          Firestore
        </Text>
        <Text variant="secondary">
          {status.isError ? 'The engine is unreachable.' : 'Connecting to the engine…'}
        </Text>
      </Page>
    )
  }
  return (
    <WorkbenchProvider value={workbench}>
      <WorkbenchBody />
    </WorkbenchProvider>
  )
}

function WorkbenchBody() {
  const workbench = useWorkbench()
  const queryClient = useQueryClient()
  useLiveChanges(queryClient, workbench.database)
  useFirestorePalette()
  const live = useLive((state) => state.status)
  const commits = useLive((state) => state.commits)
  const checked = useSelection((state) => state.checked)
  const clearSelection = useSelection((state) => state.clear)
  const openQuery = useQueryLine((state) => state.setOpen)
  const openCreate = useCreateDialog((state) => state.open)
  const [requestsOpen, setRequestsOpen] = useState(false)
  const [deleting, setDeleting] = useState<string[]>([])

  // The selection and hidden columns belong to one collection.
  const selectionScope = `${workbench.database}|${workbench.collectionPath}|${workbench.group}`
  useEffect(() => {
    resetSelection(selectionScope)
    resetColumns(selectionScope)
  }, [selectionScope])

  // Where you have been, for the root landing and ⌘K.
  const loadRecents = useRecents((state) => state.load)
  const recordRecent = useRecents((state) => state.record)
  useEffect(
    () => loadRecents(recentsKey(workbench.project, workbench.database)),
    [loadRecents, workbench.project, workbench.database],
  )
  useEffect(() => {
    if (workbench.collectionPath) recordRecent(workbench.collectionPath, 'collection')
  }, [recordRecent, workbench.collectionPath])
  useEffect(() => {
    if (workbench.selectedDocument) recordRecent(workbench.selectedDocument, 'document')
  }, [recordRecent, workbench.selectedDocument])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null
      const typing =
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      if (typing) {
        if (event.key === 'Escape') (target as HTMLElement).blur()
        return
      }
      if (event.metaKey || event.ctrlKey) return
      if (event.key === 'f' && workbench.collectionPath) {
        event.preventDefault()
        openQuery(true)
      } else if (event.key === 'Escape') {
        if (workbench.selectedDocument) workbench.selectDocument(undefined)
        else if (checked.size > 0) clearSelection()
      } else if ((event.key === 'Delete' || event.key === 'Backspace') && checked.size > 0) {
        event.preventDefault()
        setDeleting([...checked])
      } else if (event.key === 'n' && workbench.collectionPath && !workbench.isPattern) {
        event.preventDefault()
        openCreate({ kind: 'document', collection: workbench.collectionPath })
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [workbench, checked, clearSelection, openQuery, openCreate])

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden" data-testid="firestore-workbench">
      <h1 className="sr-only">Firestore</h1>
      <SchemaPanel />
      <div
        className="flex h-11 shrink-0 items-center gap-1 border-b border-kumo-line bg-kumo-base pr-2 pl-3"
        data-testid="toolbar"
      >
        <PathBar />
        <span className="mx-1.5 h-5 w-px shrink-0 bg-kumo-line" aria-hidden />
        <LiveDot
          state={live === 'live' ? 'live' : live === 'offline' ? 'offline' : 'reconnecting'}
          changes={commits}
        />
        {checked.size > 0 && (
          <Button
            variant="secondary-destructive"
            size="sm"
            icon={<TrashIcon />}
            onClick={() => setDeleting([...checked])}
            data-testid="delete-selected"
            className="ml-1"
          >
            Delete {checked.size}
          </Button>
        )}
        <span className="ml-1">
          <NewMenu />
        </span>
      </div>
      {workbench.collectionPath && <QueryLine />}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <Grid />
        </div>
        {workbench.selectedDocument && (
          <Inspector path={workbench.selectedDocument} onDelete={(path) => setDeleting([path])} />
        )}
      </div>
      <RequestsDrawer open={requestsOpen} setOpen={setRequestsOpen} />
      <CreateDialog />
      <DeleteDialog paths={deleting} onOpenChange={(open) => !open && setDeleting([])} />
    </div>
  )
}
