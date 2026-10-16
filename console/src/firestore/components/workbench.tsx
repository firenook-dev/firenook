// The Firestore workbench fills the content column edge to edge: the
// schema panel in the shell's panel slot, a toolbar with the path and the
// actions, the query line when summoned, then the grid with the inspector
// beside it when a document is open. Everything on screen is live from the
// engine's change feed, a topic on the console's one live channel.

import { Checkbox, Text } from '@cloudflare/kumo'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { statusQuery } from '@/api/queries'
import { EXPORT_FORMAT_INFO, ExportDialog } from '@/components/console/export-dialog'
import { LiveNotice } from '@/components/console/live-notice'
import { ToolbarDivider } from '@/components/console/toolbar'
import { Page } from '@/components/shell/page'
import { PanelToggle } from '@/components/shell/section-panel'
import { type SubscriptionStatus, liveChannel } from '@/lib/live/channel'
import { isTyping, useShortcuts } from '@/lib/shortcuts'
import { useCreateDialog } from '../create'
import { EXPORT_NOTES, exportFilename, renderExport, useExportDialog } from '../export'
import { printQuery } from '../query'
import { useLiveChanges } from '../live'
import { useFirestorePalette } from '../palette'
import { documentQuery } from '../queries'
import { resetColumns, useQueryLine } from '../query-line-store'
import { recentsKey, useRecents } from '../recents'
import { resetSelection, useSelection } from '../selection'
import { formatNumber } from '../value'
import { CreateDialog } from './create-dialog'
import { DeleteDialog, type DeleteTarget } from './delete-dialog'
import { ExplainPanel } from './explain-panel'
import { Grid } from './grid'
import { Inspector } from './inspector'
import { NewMenu } from './new-menu'
import { PathBar } from './path-bar'
import { QueryLine, useMatchCount } from './query-line'
import { SchemaPanel } from './schema-panel'
import { SelectionBar } from './selection-bar'
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
  const live = useLiveChanges(queryClient, workbench.scope)
  useFirestorePalette()
  useRestartRecovery()
  const checked = useSelection((state) => state.checked)
  const everything = useSelection((state) => state.everything)
  const { total } = useMatchCount()
  const clearSelection = useSelection((state) => state.clear)
  const openQuery = useQueryLine((state) => state.setOpen)
  const explain = useQueryLine((state) => state.explain)
  const setExplain = useQueryLine((state) => state.setExplain)
  const openCreate = useCreateDialog((state) => state.open)
  const exportOpen = useExportDialog((state) => state.open)
  const setExportOpen = useExportDialog((state) => state.setOpen)
  const [deleting, setDeleting] = useState<DeleteTarget | null>(null)

  // The selection and hidden columns belong to one collection.
  const selectionScope = `${workbench.slot}|${workbench.collectionPath}|${workbench.group}`
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
    if (workbench.collectionPath)
      recordRecent({ path: workbench.collectionPath, kind: 'collection' })
  }, [recordRecent, workbench.collectionPath])
  useEffect(() => {
    if (workbench.selectedDocument)
      recordRecent({ path: workbench.selectedDocument, kind: 'document' })
  }, [recordRecent, workbench.selectedDocument])

  // The page's keys, through the console's one registry: they stand aside
  // while a field has the keys or a value is being edited in the grid
  // (`useEditing`), so `f` is a letter there and Escape gives up the edit
  // rather than closing the inspector beside it.
  const inCollection = () => Boolean(workbench.collectionPath)
  const canCreate = () => Boolean(workbench.collectionPath) && !workbench.isPattern
  const deleteTicked = () =>
    setDeleting(
      everything
        ? { kind: 'everything', count: total?.count ?? checked.size }
        : { kind: 'paths', paths: [...checked] },
    )
  useShortcuts({ id: 'firestore', label: 'Firestore' }, [
    { key: 'f', label: 'Filter the documents', when: inCollection, run: () => openQuery(true) },
    {
      key: 'e',
      label: 'Explain the query',
      when: inCollection,
      run: () => setExplain(!useQueryLine.getState().explain),
    },
    {
      // The scope is a menu so both scopes are named, but flipping it stays
      // one keystroke. A pattern is already the group, with nowhere to go.
      key: 'g',
      label: 'Switch between this collection and its group',
      when: canCreate,
      run: () => workbench.setGroup(!workbench.group),
    },
    {
      key: 'n',
      label: 'New document',
      when: canCreate,
      run: () => openCreate({ kind: 'document', collection: workbench.collectionPath }),
    },
    {
      key: 'Escape',
      label: 'Close the document, then clear the selection',
      // Escape in a field leaves the field, so the next key is a shortcut.
      allowInInputs: true,
      run: (event) => {
        if (isTyping(event.target)) (event.target as HTMLElement).blur()
        else if (workbench.selectedDocument) workbench.selectDocument(undefined)
        else if (checked.size > 0) clearSelection()
      },
    },
    {
      key: 'Delete',
      label: 'Delete the ticked documents',
      when: () => checked.size > 0,
      run: deleteTicked,
    },
    {
      key: 'Backspace',
      label: 'Delete the ticked documents',
      when: () => checked.size > 0,
      run: deleteTicked,
    },
  ])

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden" data-testid="firestore-workbench">
      <h1 className="sr-only">Firestore</h1>
      <SchemaPanel />
      <WorkbenchData live={live} onDelete={setDeleting} explain={explain} setExplain={setExplain} />
      <ExportDocuments open={exportOpen} onOpenChange={setExportOpen} />
      <CreateDialog />
      <DeleteDialog target={deleting} onOpenChange={(open) => !open && setDeleting(null)} />
    </div>
  )
}

/**
 * What an engine restart does to the workbench beyond reloading its queries
 * (the channel does that): the ticked rows go, since the documents they
 * named may not exist in the new run, and the inspector closes when its
 * document no longer does. An edit in progress is kept.
 */
function useRestartRecovery() {
  const workbench = useWorkbench()
  const queryClient = useQueryClient()
  const latest = useRef(workbench)
  useEffect(() => {
    latest.current = workbench
  })
  useEffect(
    () =>
      liveChannel.onEngineRestart(() => {
        useSelection.getState().clear()
        const { scope, selectedDocument, selectDocument } = latest.current
        if (!selectedDocument) return
        void queryClient
          .fetchQuery(documentQuery(scope, selectedDocument))
          .then((document) => {
            if (!document && latest.current.selectedDocument === selectedDocument)
              selectDocument(undefined)
          })
          .catch(() => {
            // Unreadable now is still a document: the inspector says why.
          })
      }),
    [queryClient],
  )
}

/** The data view: the toolbar, the query line and the grid. */
function WorkbenchData({
  live,
  onDelete,
  explain,
  setExplain,
}: {
  live: SubscriptionStatus
  onDelete: (target: DeleteTarget) => void
  explain: boolean
  setExplain: (explain: boolean) => void
}) {
  const workbench = useWorkbench()
  const selecting = useSelection((state) => state.checked.size > 0 || state.everything)
  return (
    <>
      <div
        className="flex h-11 shrink-0 items-center gap-1 border-b border-kumo-line bg-kumo-base pr-2 pl-3"
        data-testid="toolbar"
      >
        <PanelToggle where="toolbar" />
        <PathBar />
        <ToolbarDivider />
        {/* This page's own subscription, said only when the engine ended
            or refused it. A dropped channel is the whole console's, so the
            engine badge in the bar above says it, once, for every page; a
            green "Live" here would only announce the normal case. */}
        <LiveNotice
          status={live}
          what="this database"
          onRetry={() => liveChannel.retry()}
          testId="live-state"
        />
        {/* Not a property of the query below: the identity applies to every
            read the workbench makes, the schema tree and inspector included.
            The security rules it reads through have a page of their own in
            the sidebar; the Rules button that stood here swapped the grid
            for an editor, a mode of this page for what is a different job. */}
        <ViewAsPicker />
        <ToolbarDivider />
        <NewMenu />
      </div>
      {workbench.collectionPath && (
        // The selection bar lies over the query line rather than swapping
        // places with it, so it is exactly as tall and nothing below moves.
        <div className="relative shrink-0">
          <div inert={selecting || undefined}>
            <QueryLine />
          </div>
          {selecting && <SelectionBar onDelete={onDelete} />}
        </div>
      )}
      {explain && workbench.collectionPath && !workbench.queryError && (
        <ExplainPanel onClose={() => setExplain(false)} />
      )}
      {/* Relative so a narrow inspector can float over the grid's right edge. */}
      <div className="relative flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <Grid />
        </div>
        {workbench.selectedDocument && (
          <Inspector
            path={workbench.selectedDocument}
            onDelete={(path) => onDelete({ kind: 'paths', paths: [path] })}
          />
        )}
      </div>
    </>
  )
}

/**
 * Taking the page you are looking at out of the emulator, in the kit's
 * export dialog: it says exactly what will be written before it writes
 * anything — which documents, and under whose identity, since an export
 * made while viewing as a user holds what that user can read — and builds
 * the file in this tab (its `run` mode), paging the whole result with the
 * grid's own cursors and reading whole documents, never a cell's preview.
 */
function ExportDocuments({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const workbench = useWorkbench()
  const checked = useSelection((state) => state.checked)
  const everything = useSelection((state) => state.everything)
  const [typed, setTyped] = useState(false)
  // Everything matching is the whole result, which is what an export with
  // no selection reads anyway.
  const selected = everything ? [] : [...checked]
  const only = selected.length > 0 ? selected : undefined
  const what = only
    ? `${formatNumber(only.length)} selected ${only.length === 1 ? 'document' : 'documents'}`
    : workbench.query.where.length > 0 || workbench.query.orderBy.length > 0
      ? `Every document matching ${printQuery(workbench.query)}`
      : `Every document in ${workbench.collectionPath}`
  return (
    <ExportDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Export"
      scope={
        <>
          <span data-testid="export-what">{what}</span>, read whole — not the shortened values the
          grid draws.{' '}
          {workbench.scope.identity.kind === 'owner'
            ? 'Rules are bypassed, so this is everything the engine holds.'
            : 'Security rules apply, so this is what the identity you are viewing as can read.'}
        </>
      }
      formats={['json', 'ndjson', 'csv']}
      notes={EXPORT_NOTES}
      renderOptions={(format) =>
        format === 'csv' ? null : (
          <div className="grid gap-1">
            <Checkbox
              checked={typed}
              onCheckedChange={(value) => setTyped(Boolean(value))}
              label="Keep Firestore types exactly"
            />
            <span className="pl-6">
              <Text variant="secondary" size="sm">
                The REST wire shape. References, bytes, geopoints and vectors have no plain-JSON
                form that survives a round trip.
              </Text>
            </span>
          </div>
        )
      }
      filename={(format) => exportFilename(workbench.collectionPath, format)}
      run={async (format, signal, progress) => {
        const { parts } = await renderExport(
          {
            scope: workbench.scope,
            collectionPath: workbench.collectionPath,
            group: workbench.group,
            query: workbench.query,
            only,
          },
          { format, typed },
          progress,
          signal,
        )
        return new Blob(parts, { type: EXPORT_FORMAT_INFO[format].mediaType })
      }}
      testId="export"
    />
  )
}
