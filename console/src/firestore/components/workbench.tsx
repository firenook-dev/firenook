// The Firestore workbench fills the content column edge to edge: the
// schema panel in the shell's panel slot, a toolbar with the path and the
// actions, the query line when summoned, then the grid with the inspector
// beside it when a document is open. Everything on screen is live from the
// engine's change feed.

import { Button, Text } from '@cloudflare/kumo'
import { ShieldCheckIcon, TrashIcon } from '@phosphor-icons/react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { statusQuery } from '@/api/queries'
import { Page } from '@/components/shell/page'
import { useCreateDialog } from '../create'
import { useExportDialog } from '../export'
import { useLive, useLiveChanges } from '../live'
import { useFirestorePalette } from '../palette'
import { resetColumns, useQueryLine } from '../query-line-store'
import { recentsKey, useRecents } from '../recents'
import { resetSelection, useSelection } from '../selection'
import { ChangesPopover } from './changes-popover'
import { CreateDialog } from './create-dialog'
import { DeleteDialog } from './delete-dialog'
import { ExplainPanel } from './explain-panel'
import { ExportDialog } from './export-dialog'
import { Grid } from './grid'
import { Inspector } from './inspector'
import { NewMenu } from './new-menu'
import { PathBar } from './path-bar'
import { QueryLine } from './query-line'
import { RequestsDrawer } from './requests-drawer'
import { RulesEditorPanel } from './rules-editor'
import { SchemaPanel } from './schema-panel'
import { ViewAsPicker } from './view-as-picker'
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
  const explain = useQueryLine((state) => state.explain)
  const setExplain = useQueryLine((state) => state.setExplain)
  const openCreate = useCreateDialog((state) => state.open)
  const [requestsOpen, setRequestsOpen] = useState(false)
  const exportOpen = useExportDialog((state) => state.open)
  const setExportOpen = useExportDialog((state) => state.setOpen)
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
      } else if (event.key === 'e' && workbench.collectionPath) {
        event.preventDefault()
        setExplain(!useQueryLine.getState().explain)
      } else if (event.key === 'g' && workbench.collectionPath && !workbench.isPattern) {
        // The scope is a menu so both scopes are named, but flipping it stays
        // one keystroke. A pattern is already the group, with nowhere to go.
        event.preventDefault()
        workbench.setGroup(!workbench.group)
      } else if (event.key === 'n' && workbench.collectionPath && !workbench.isPattern) {
        event.preventDefault()
        openCreate({ kind: 'document', collection: workbench.collectionPath })
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [workbench, checked, clearSelection, openQuery, openCreate, setExplain])

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden" data-testid="firestore-workbench">
      <h1 className="sr-only">Firestore</h1>
      <SchemaPanel />
      {workbench.view === 'rules' ? (
        <RulesEditorPanel />
      ) : (
        <WorkbenchData
          checked={checked}
          live={live}
          commits={commits}
          onDelete={setDeleting}
          explain={explain}
          setExplain={setExplain}
        />
      )}
      <ExportDialog open={exportOpen} onOpenChange={setExportOpen} />
      <RequestsDrawer open={requestsOpen} setOpen={setRequestsOpen} />
      <CreateDialog />
      <DeleteDialog paths={deleting} onOpenChange={(open) => !open && setDeleting([])} />
    </div>
  )
}

/** The rule that separates one group of toolbar controls from the next. */
function Divider() {
  return <span className="mx-1.5 h-5 w-px shrink-0 bg-kumo-line" aria-hidden />
}

/** The data view: the toolbar, the query line and the grid. */
function WorkbenchData({
  checked,
  live,
  commits,
  onDelete,
  explain,
  setExplain,
}: {
  checked: ReadonlySet<string>
  live: string
  commits: number
  onDelete: (paths: string[]) => void
  explain: boolean
  setExplain: (explain: boolean) => void
}) {
  const workbench = useWorkbench()
  return (
    <>
      <div
        className="flex h-11 shrink-0 items-center gap-1 border-b border-kumo-line bg-kumo-base pr-2 pl-3"
        data-testid="toolbar"
      >
        <PathBar />
        <Divider />
        <ChangesPopover
          state={live === 'live' ? 'live' : live === 'offline' ? 'offline' : 'reconnecting'}
          changes={commits}
        />
        {/* Not a property of the query below: the identity applies to every
            read the workbench makes, the schema tree and inspector included. */}
        <ViewAsPicker />
        {checked.size > 0 && (
          <Button
            variant="secondary-destructive"
            size="sm"
            icon={<TrashIcon />}
            onClick={() => onDelete([...checked])}
            data-testid="delete-selected"
            className="ml-1"
          >
            Delete {checked.size}
          </Button>
        )}
        {/* A view, not an action on the grid: it belongs with what you are
            reading as, and the rule is the divider — only the control that
            writes stands on the other side of it. */}
        <Button
          variant="ghost"
          size="sm"
          icon={<ShieldCheckIcon />}
          onClick={() => workbench.navigate({ view: 'rules' })}
          aria-label="Security rules"
          data-testid="open-rules"
        >
          <span className="hidden xl:inline">Rules</span>
        </Button>
        <Divider />
        <NewMenu />
      </div>
      {workbench.collectionPath && <QueryLine />}
      {explain && workbench.collectionPath && !workbench.queryError && (
        <ExplainPanel onClose={() => setExplain(false)} />
      )}
      {/* Relative so a narrow inspector can float over the grid's right edge. */}
      <div className="relative flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <Grid />
        </div>
        {workbench.selectedDocument && (
          <Inspector path={workbench.selectedDocument} onDelete={(path) => onDelete([path])} />
        )}
      </div>
    </>
  )
}
