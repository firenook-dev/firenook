// The Firestore workbench: path line, grid, and the inspector when a
// document is open. Query line and Requests drawer appear when summoned.
// Everything on screen is live from the engine's change feed.

import { Badge, Button, Select, Text, Tooltip } from '@cloudflare/kumo'
import { PlusIcon, TrashIcon } from '@phosphor-icons/react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { statusQuery } from '@/api/queries'
import { LiveDot } from '@/components/kit'
import { useLive, useLiveChanges } from '../live'
import { isEmptyQuery } from '../query'
import { resetSelection, useSelection } from '../selection'
import { AddDocumentDialog, DeleteDialog } from './dialogs'
import { Grid } from './grid'
import { Inspector } from './inspector'
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
  const live = useLive((state) => state.status)
  const commits = useLive((state) => state.commits)
  const checked = useSelection((state) => state.checked)
  const clearSelection = useSelection((state) => state.clear)
  const [queryOpenState, setQueryOpen] = useState(false)
  // An active query always shows its line.
  const queryOpen = queryOpenState || !isEmptyQuery(workbench.query)
  const [requestsOpen, setRequestsOpen] = useState(false)
  // Each opening of the add dialog is a fresh form; 0 is closed.
  const [addSession, setAddSession] = useState(0)
  const [deleting, setDeleting] = useState<string[]>([])

  // The selection belongs to one collection.
  const selectionScope = `${workbench.database}|${workbench.collectionPath}|${workbench.group}`
  useEffect(() => resetSelection(selectionScope), [selectionScope])

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
      if (event.key === 'f' && !event.metaKey && !event.ctrlKey && workbench.collectionPath) {
        event.preventDefault()
        setQueryOpen(true)
      } else if (event.key === 'Escape') {
        if (workbench.selectedDocument) workbench.selectDocument(undefined)
        else if (checked.size > 0) clearSelection()
      } else if ((event.key === 'Delete' || event.key === 'Backspace') && checked.size > 0) {
        event.preventDefault()
        setDeleting([...checked])
      } else if (
        event.key === 'n' &&
        !event.metaKey &&
        !event.ctrlKey &&
        workbench.collectionPath
      ) {
        event.preventDefault()
        setAddSession((session) => session + 1)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [workbench, checked, clearSelection])

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
          {workbench.collectionPath && (
            <Tooltip
              content="Add a document (n)"
              render={
                <Button
                  variant="primary"
                  size="sm"
                  icon={<PlusIcon />}
                  onClick={() => setAddSession((session) => session + 1)}
                >
                  Add document
                </Button>
              }
            />
          )}
        </div>
      </div>
      <PathBar />
      {workbench.collectionPath && <QueryLine open={queryOpen} setOpen={setQueryOpen} />}
      <div className="flex min-h-0 flex-1 gap-3">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <Grid onAddDocument={() => setAddSession((session) => session + 1)} />
        </div>
        {workbench.selectedDocument && (
          <Inspector path={workbench.selectedDocument} onDelete={(path) => setDeleting([path])} />
        )}
      </div>
      <RequestsDrawer open={requestsOpen} setOpen={setRequestsOpen} />
      <AddDocumentDialog session={addSession} onClose={() => setAddSession(0)} />
      <DeleteDialog paths={deleting} onOpenChange={(open) => !open && setDeleting([])} />
    </div>
  )
}
