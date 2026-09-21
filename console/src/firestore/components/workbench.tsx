// The Firestore workbench: path line, grid, and the inspector when a
// document is open. Query line and Requests drawer appear when summoned.
// Everything on screen is live from the engine's change feed.

import { Badge, Button, Select, Text } from '@cloudflare/kumo'
import { TrashIcon } from '@phosphor-icons/react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { statusQuery } from '@/api/queries'
import { LiveDot } from '@/components/kit'
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
import {
  DEFAULT_DATABASE,
  WorkbenchProvider,
  useWorkbench,
  useWorkbenchState,
} from './workbench-context'

export function FirestoreWorkbench() {
  const workbench = useWorkbenchState()
  const status = useQuery(statusQuery)
  if (!workbench) {
    return (
      <div className="grid gap-1.5">
        <Text variant="heading" size="lg" as="h1">
          Firestore
        </Text>
        <Text variant="secondary">
          {status.isError ? 'The engine is unreachable.' : 'Connecting to the engine…'}
        </Text>
      </div>
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
  const status = useQuery(statusQuery)
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
      } else if (event.key === 'n' && workbench.collectionPath) {
        event.preventDefault()
        openCreate({ kind: 'document', collection: workbench.collectionPath })
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [workbench, checked, clearSelection, openQuery, openCreate])

  const firestoreRunning = status.data?.services.some((service) => service.name === 'firestore')
  const databases = {
    [DEFAULT_DATABASE]: DEFAULT_DATABASE,
    ...(workbench.database !== DEFAULT_DATABASE
      ? { [workbench.database]: workbench.database }
      : {}),
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3" data-testid="firestore-workbench">
      <div className="flex shrink-0 items-center gap-3">
        <div className="flex items-center gap-2">
          <Text variant="heading" size="lg" as="h1">
            Firestore
          </Text>
          {status.data &&
            (firestoreRunning ? (
              <Badge variant="success" appearance="dot">
                running
              </Badge>
            ) : (
              <Badge variant="neutral" appearance="dot">
                not running
              </Badge>
            ))}
        </div>
        <Select
          size="sm"
          value={workbench.database}
          onValueChange={(value) => workbench.setDatabase(String(value))}
          items={databases}
          aria-label="Database"
          className="w-40"
        />
        <div className="ml-auto flex items-center gap-2">
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
            >
              Delete {checked.size}
            </Button>
          )}
          <NewMenu />
        </div>
      </div>
      <PathBar />
      {workbench.collectionPath && <QueryLine />}
      <div className="flex min-h-0 flex-1 gap-3">
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
