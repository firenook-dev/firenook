// The grid: documents are rows, fields are columns inferred from what is
// loaded, every header carries its type, every cell is exact. Rows and
// columns are both virtualized; changed rows flash; a cell cursor moves
// through them and any value edits where it stands.
//
// Columns are virtualized as well as rows because a schemaless collection
// sets no bound on them. Measured on one keyed by user id — 1,501 fields
// over 100 documents — rendering every column cost 143,667 DOM nodes and
// frames of 250 to 950 ms; the same grid over thirteen columns scrolled at
// a flat 16.7. Most such fields fold into one column now (`foldRare`), but
// the way back to having all of them as columns has to stay fast too.

import { Button, Empty, Table, Text, Tooltip, useKumoToastManager } from '@cloudflare/kumo'
import {
  ClockCounterClockwiseIcon,
  DatabaseIcon,
  DownloadSimpleIcon,
  FileIcon,
  FolderIcon,
  FolderPlusIcon,
  FunnelIcon,
  LockKeyIcon,
  PlusIcon,
  WarningIcon,
  ShieldCheckIcon,
} from '@phosphor-icons/react'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Kbd } from '@/components/kit'
import { describeKey, useShortcuts } from '@/lib/shortcuts'
import { shapeKey, useColumnWidths, useIdFreeze } from '../column-widths'
import { arrangeColumns, foldRare, inferColumns } from '../columns'
import { useCreateDialog } from '../create'
import { copyText } from '../draft'
import { useExportDialog } from '../export'
import { useLive } from '../live'
import { EMPTY_QUERY } from '../query'
import { useColumns } from '../query-line-store'
import {
  collectionsQuery,
  countQueryOptions,
  documentQuery,
  missingDocumentsQuery,
  pageQueryOptions,
} from '../queries'
import { useRecents } from '../recents'
import { FirestoreError } from '../rest'
import { childrenOf, describeChildren, workbenchSchemaQuery } from '../schema'
import { useSelection } from '../selection'
import { type FsDocument, formatNumber, isPartial } from '../value'
import { CellEditor } from './cell-editor'
import { ColumnResizer } from './column-resizer'
import {
  CHECK_WIDTH,
  FOLDED_COLUMN,
  type GridColumn,
  GridRow,
  ID_COLUMN,
  PIN_EDGE,
  PIN_HEAD,
  type RowActions,
} from './grid-row'
import { FoldedHeader, HeaderMenu, IdHeaderMenu } from './header-menu'
import { subcollectionsWidth } from './subcollections-cell'
import { DEFAULT_DATABASE, useWorkbench } from './workbench-context'

/**
 * A row's height, px, and the virtualizer's estimate of it — which have to
 * be the same number. They were not: rows were `h-9`, which is 2.25 rem
 * and so 31.5 px on this console's 14 px root, while the virtualizer
 * placed them at 36, and every spacer and every scroll-to-row was worked
 * out on a height no row had.
 */
const ROW_HEIGHT = 32
const ID_WIDTH = 220
/** A group shows whole paths in the first column, so it gets more room. */
const PATH_WIDTH = 340
/** Room for `+600` and a line of the field names it stands for. */
const FOLDED_WIDTH = 260
/** Collections up to this size are walked for missing ancestor documents. */
const MISSING_SCAN_LIMIT = 5_000
const NO_ORDER: readonly string[] = []

export function Grid() {
  'use no memo' // the virtualizers hand out functions the compiler cannot memoize safely
  const workbench = useWorkbench()
  const queryClient = useQueryClient()
  const toasts = useKumoToastManager()
  const openCreate = useCreateDialog((state) => state.open)
  const hidden = useColumns((state) => state.hidden)
  const showAll = useColumns((state) => state.showAll)
  const unfolded = useColumns((state) => state.unfolded)
  const page = useInfiniteQuery({
    ...pageQueryOptions(
      workbench.scope,
      workbench.collectionPath,
      workbench.group,
      workbench.query,
    ),
    enabled: Boolean(workbench.collectionPath) && !workbench.queryError,
  })
  // Missing ancestors need a key-order walk, so only small collections get it.
  const total = useQuery({
    ...countQueryOptions(workbench.ownerScope, workbench.collectionPath, false, EMPTY_QUERY),
    enabled: Boolean(workbench.collectionPath) && !workbench.group,
  })
  const missing = useQuery({
    ...missingDocumentsQuery(workbench.ownerScope, workbench.collectionPath),
    enabled:
      Boolean(workbench.collectionPath) &&
      !workbench.group &&
      total.data !== undefined &&
      total.data.count <= MISSING_SCAN_LIMIT,
  })

  // The schema says which subcollections these documents can have; that
  // decides whether the grid has a subcollections column and how wide.
  const schema = useQuery(workbenchSchemaQuery(workbench))
  const known = useMemo(
    () => childrenOf(schema.data, workbench.collectionPath),
    [schema.data, workbench.collectionPath],
  )

  const documents = useMemo(() => {
    const loaded = page.data?.pages.flatMap((item) => item.documents) ?? []
    // Missing ancestors only exist to hold subcollections; they belong in
    // the plain listing, never inside a filtered or ordered result.
    if (workbench.queryText || workbench.group || !missing.data?.length) return loaded
    return [...loaded, ...missing.data]
  }, [page.data, missing.data, workbench.queryText, workbench.group])

  // The columns, in the order this collection has been showing them. The
  // order is held per collection, not per query, so sorting by a column —
  // which loads a different first page — leaves every column where it was.
  const inferred = useMemo(() => inferColumns(documents), [documents])
  const scope = `${workbench.slot}|${workbench.collectionPath}|${workbench.group}`
  const [remembered, setRemembered] = useState({ scope: '', order: NO_ORDER })
  const previous = remembered.scope === scope ? remembered.order : NO_ORDER
  const arranged = useMemo(() => arrangeColumns(inferred, previous), [inferred, previous])
  if (arranged.order !== previous) setRemembered({ scope, order: arranged.order })
  const visible = useMemo(
    () => arranged.columns.filter((column) => !hidden.has(column.field)),
    [arranged.columns, hidden],
  )
  const { shown, folded } = useMemo(
    () => (unfolded ? { shown: visible, folded: [] } : foldRare(visible)),
    [visible, unfolded],
  )
  const hiddenCount = arranged.columns.length - visible.length
  // A missing ancestor exists only because of its subcollections, so it
  // always earns the column, even before the schema answers.
  const subcolumn = known.length > 0 || documents.some((document) => document.missing)
  const subWidth = subcollectionsWidth(known)

  // Widths: the column's own, unless somebody dragged it, and the drag in
  // progress over both.
  const shape = shapeKey(
    workbench.project,
    workbench.database,
    workbench.collectionPath,
    workbench.group,
  )
  const dragged = useColumnWidths((state) => state.widths[shape])
  const keepWidth = useColumnWidths((state) => state.set)
  const forgetWidth = useColumnWidths((state) => state.reset)
  const [resizing, setResizing] = useState<{ key: string; width: number } | null>(null)
  const frozen = useIdFreeze((state) => !state.unfrozen.has(shape))
  const setFrozen = useIdFreeze((state) => state.setFrozen)
  const idWidth =
    resizing?.key === ID_COLUMN
      ? resizing.width
      : (dragged?.[ID_COLUMN] ?? (workbench.group ? PATH_WIDTH : ID_WIDTH))
  const gridColumns = useMemo(() => {
    const width = (key: string, own: number) =>
      resizing?.key === key ? resizing.width : (dragged?.[key] ?? own)
    const list: GridColumn[] = shown.map((column) => ({
      key: column.field,
      kind: 'field',
      column,
      width: width(column.field, column.width),
    }))
    if (folded.length > 0)
      list.push({
        key: FOLDED_COLUMN,
        kind: 'folded',
        folded,
        fields: new Set(folded.map((column) => column.field)),
        width: width(FOLDED_COLUMN, FOLDED_WIDTH),
      })
    return list
  }, [shown, folded, dragged, resizing])
  // Where each column starts, from the first field; the last entry is the total.
  const offsets = useMemo(() => {
    const starts = [0]
    for (const column of gridColumns) starts.push((starts.at(-1) ?? 0) + column.width)
    return starts
  }, [gridColumns])
  const dataWidth = offsets.at(-1) ?? 0
  /** What stays put on the left while the fields scroll: the box, and the id unless unfrozen. */
  const pinned = CHECK_WIDTH + (frozen ? idWidth : 0)
  const leading = pinned + (subcolumn ? subWidth : 0)

  const scrollRef = useRef<HTMLDivElement>(null)
  const [scrolledX, setScrolledX] = useState(false)
  // oxlint-disable-next-line react/incompatible-library -- the directive above opts this component out of the compiler
  const virtualizer = useVirtualizer({
    count: documents.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  })
  const columnVirtualizer = useVirtualizer({
    horizontal: true,
    count: gridColumns.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => gridColumns[index]?.width ?? 120,
    getItemKey: (index) => gridColumns[index]?.key ?? index,
    // The fields start after the pinned columns and the subcollections.
    scrollMargin: leading,
    overscan: 3,
  })
  // A width changed: the virtualizer keeps sizes it has read, so it is told.
  useLayoutEffect(() => {
    columnVirtualizer.measure()
  }, [columnVirtualizer, gridColumns, leading])

  const checked = useSelection((state) => state.checked)
  const everything = useSelection((state) => state.everything)
  const focused = useSelection((state) => state.focused)
  const cursorField = useSelection((state) => state.field)
  const editing = useSelection((state) => state.editing)
  const toggle = useSelection((state) => state.toggle)
  const setChecked = useSelection((state) => state.setChecked)
  const setRange = useSelection((state) => state.setRange)
  const focus = useSelection((state) => state.focus)
  const edit = useSelection((state) => state.edit)
  const flashes = useLive((state) => state.flashes)

  /** Scrolls a column fully into view beside the pinned ones. */
  const reveal = (key: string) => {
    const element = scrollRef.current
    const index = gridColumns.findIndex((column) => column.key === key)
    if (!element || index === -1) return
    const start = leading + (offsets[index] ?? 0)
    const end = leading + (offsets[index + 1] ?? 0)
    if (start < element.scrollLeft + pinned) element.scrollLeft = start - pinned
    else if (end > element.scrollLeft + element.clientWidth)
      element.scrollLeft = Math.min(start - pinned, end - element.clientWidth)
  }

  /** A cell's value to the clipboard — the whole value, fetched if the page has only part of it. */
  const copy = async (document: FsDocument, field: string | undefined) => {
    let text: string
    if (field === undefined) text = workbench.group ? document.path : document.id
    else {
      let value = document.fields[field]
      if (value && isPartial(value))
        value = (await queryClient.fetchQuery(documentQuery(workbench.scope, document.path)))
          ?.fields[field]
      if (!value) return
      text = copyText(value)
    }
    try {
      await navigator.clipboard.writeText(text)
      toasts.add({ title: `Copied ${field ?? (workbench.group ? 'path' : 'id')}` })
    } catch {
      toasts.add({ title: 'Could not copy', variant: 'error' })
    }
  }

  // What a row asks of the grid, through a ref so that no row re-renders
  // because a closure was re-created.
  const actions = useRef<RowActions | null>(null)
  useLayoutEffect(() => {
    actions.current = {
      click: (document, cell) => {
        // Ticking a row selects it; it does not also put the cursor there.
        if (cell?.dataset.check !== undefined) return
        // A click is the cell's: the cursor lands on it, ready to copy or
        // to edit. It used to open the panel as well — a quarter of the
        // window, every click — and to wait 260 ms first wherever the panel
        // would have covered the cell, so a double-click could still land.
        const field = cell?.dataset.field
        focus(document.path, field === ID_COLUMN ? undefined : field)
        // An open panel follows the row being worked on, as the arrows
        // already had it do; a closed one stays closed.
        if (workbench.selectedDocument && workbench.selectedDocument !== document.path)
          workbench.selectDocument(document.path)
      },
      open: (document) => {
        if (workbench.selectedDocument === document.path) {
          workbench.selectDocument(undefined)
          return
        }
        if (useSelection.getState().focused !== document.path) focus(document.path, undefined)
        workbench.selectDocument(document.path)
      },
      check: (document, index, next, shift) => {
        // Shift ticks every row between this one and the last one ticked.
        const anchor = useSelection.getState().anchor
        const from = anchor === undefined ? -1 : documents.findIndex((item) => item.path === anchor)
        if (shift && from !== -1) {
          const [low, high] = from < index ? [from, index] : [index, from]
          setRange(
            documents.slice(low, high + 1).map((item) => item.path),
            next,
          )
          return
        }
        toggle(document.path)
      },
      edit: (document, field) => {
        if (document.missing) return
        focus(document.path, field)
        reveal(field)
        edit({ path: document.path, field })
      },
      openReference: (path) => workbench.selectDocument(path),
    }
  })

  // Keyboard: arrows move the cell cursor, Enter edits the cell it is on —
  // or opens the document from its id — and Escape closes. The keys go
  // through the console's registry, which keeps them from a field that has
  // the keys and from an edit in progress, and reads the newest of these
  // handlers on each press, so a scroll frame registers nothing.
  const current = () => documents.find((document) => document.path === focused)
  const moveRow = (step: 1 | -1) => {
    const index = documents.findIndex((document) => document.path === focused)
    const next = Math.min(documents.length - 1, Math.max(0, index === -1 ? 0 : index + step))
    const document = documents[next]
    if (!document) return
    focus(document.path, cursorField)
    virtualizer.scrollToIndex(next, { align: 'auto' })
    if (workbench.selectedDocument) workbench.selectDocument(document.path)
  }
  const moveField = (step: 1 | -1) => {
    const row = current()
    if (!row) return
    // The id is the row's own cell, left of the first field.
    const keys = gridColumns.map((column) => column.key)
    const at = cursorField === undefined ? -1 : keys.indexOf(cursorField)
    const next = step === 1 ? Math.min(keys.length - 1, at + 1) : at - 1
    const field = next < 0 ? undefined : keys[next]
    focus(row.path, field)
    if (field !== undefined) reveal(field)
  }
  const open = (row: FsDocument | undefined, key: 'Enter' | 'F2') => {
    if (!row) return
    if (cursorField !== undefined && cursorField !== FOLDED_COLUMN)
      actions.current?.edit(row, cursorField)
    else if (key === 'Enter') workbench.selectDocument(row.path)
  }
  const loaded = () => documents.length > 0
  const onRow = () => loaded() && current() !== undefined
  useShortcuts({ id: 'firestore', label: 'Firestore' }, [
    {
      key: 'ArrowUp',
      label: 'Move between rows',
      group: 'Grid',
      when: loaded,
      run: () => moveRow(-1),
    },
    {
      key: 'ArrowDown',
      label: 'Move between rows',
      group: 'Grid',
      when: loaded,
      run: () => moveRow(1),
    },
    {
      key: 'ArrowLeft',
      label: 'Move between fields',
      group: 'Grid',
      when: onRow,
      run: () => moveField(-1),
    },
    {
      key: 'ArrowRight',
      label: 'Move between fields',
      group: 'Grid',
      when: onRow,
      run: () => moveField(1),
    },
    {
      key: 'Enter',
      label: 'Edit the value, or open the document from its id',
      group: 'Grid',
      when: onRow,
      run: () => open(current(), 'Enter'),
    },
    {
      key: 'F2',
      label: 'Edit the value',
      group: 'Grid',
      when: onRow,
      run: () => open(current(), 'F2'),
    },
    {
      key: 'Space',
      label: 'Tick the row',
      group: 'Grid',
      when: () => loaded() && focused !== undefined,
      run: () => {
        if (focused) toggle(focused)
      },
    },
    {
      key: 'Mod+a',
      label: 'Tick every loaded row',
      group: 'Grid',
      when: loaded,
      run: () => setChecked(documents.map((document) => document.path)),
    },
    {
      key: 'Mod+c',
      label: 'Copy the value',
      group: 'Grid',
      // Text somebody selected on purpose is what they meant to copy.
      when: () => onRow() && cursorField !== FOLDED_COLUMN && !window.getSelection()?.toString(),
      run: () => {
        const row = current()
        if (row) void copy(row, cursorField)
      },
    },
  ])

  // Fetch the next page as the last rows come into view, and — once the
  // window has let its oldest pages go (it holds at most 20) — the page
  // before as the first rows do.
  const items = virtualizer.getVirtualItems()
  const firstVisible = items[0]?.index ?? 0
  const lastVisible = items.at(-1)?.index ?? -1
  useEffect(() => {
    if (
      lastVisible >= documents.length - 20 &&
      page.hasNextPage &&
      !page.isFetchingNextPage &&
      documents.length > 0
    )
      void page.fetchNextPage()
  }, [lastVisible, documents.length, page])
  useEffect(() => {
    if (
      firstVisible <= 20 &&
      page.hasPreviousPage &&
      !page.isFetchingPreviousPage &&
      documents.length > 0
    )
      void page.fetchPreviousPage()
  }, [firstVisible, documents.length, page])

  // Rows that came or went above the ones on screen leave those rows where
  // they are: a page dropped from the front of the window, a page read back
  // in, a document created or deleted above. At the very top nothing is
  // held, so what arrives there is seen.
  const anchor = useRef<readonly FsDocument[]>(documents)
  useLayoutEffect(() => {
    const before = anchor.current
    anchor.current = documents
    const element = scrollRef.current
    const previousFirst = before[0]?.path
    const first = documents[0]?.path
    if (!element || element.scrollTop === 0 || !previousFirst || !first || previousFirst === first)
      return
    const added = documents.findIndex((document) => document.path === previousFirst)
    if (added > 0) {
      element.scrollTop += added * ROW_HEIGHT
      return
    }
    const removed = before.findIndex((document) => document.path === first)
    if (removed > 0) element.scrollTop = Math.max(0, element.scrollTop - removed * ROW_HEIGHT)
  }, [documents])

  // The cell being edited, found in the page each render: a live change can
  // replace the document under it, and a delete can take it away.
  const editingDocument = editing
    ? documents.find((document) => document.path === editing.path)
    : undefined
  useEffect(() => {
    if (editing && !editingDocument && !page.isFetching) edit(null)
  }, [editing, editingDocument, page.isFetching, edit])
  const editingAnchor = useCallback(() => {
    if (!editing) return null
    return (
      scrollRef.current?.querySelector<HTMLElement>(
        `tr[data-path="${CSS.escape(editing.path)}"] td[data-field="${CSS.escape(editing.field)}"]`,
      ) ?? null
    )
  }, [editing])
  const gridBounds = useCallback(() => {
    const element = scrollRef.current
    if (!element) return null
    const box = element.getBoundingClientRect()
    const head = element.querySelector('thead')?.getBoundingClientRect().height ?? 0
    return new DOMRect(box.left + pinned, box.top + head, box.width - pinned, box.height - head)
  }, [pinned])
  const closeEditor = useCallback(() => edit(null), [edit])
  // Leaving the grid mid-edit — the browser's back button, another section
  // of the console — drops the edit. Left set, it would hold the
  // workbench's shortcuts aside for an editor that is no longer there.
  useEffect(() => () => edit(null), [edit])

  const virtualColumns = columnVirtualizer.getVirtualItems()
  const first = virtualColumns[0]?.index ?? 0
  const last = virtualColumns.at(-1)?.index ?? -1
  const cells = useMemo(() => gridColumns.slice(first, last + 1), [gridColumns, first, last])

  if (!workbench.collectionPath) return <RootLanding />
  // The page query is switched off while the query text does not parse, and a
  // disabled query reads as pending forever; say what is actually wrong.
  if (workbench.queryError) return <QueryUnparsed />
  if (page.isError) return <QueryFailure error={page.error} />
  if (page.isPending)
    return (
      <div className="flex h-40 items-center justify-center">
        <Text variant="secondary">Loading {workbench.collectionPath}…</Text>
      </div>
    )
  if (documents.length === 0)
    return (
      <div className="min-h-0 flex-1 overflow-auto">
        <Empty
          icon={<DatabaseIcon size={48} className="text-kumo-inactive" />}
          title={
            workbench.queryText
              ? 'No documents match this query'
              : workbench.isPattern
                ? `No documents at ${workbench.collectionPath}`
                : `No documents in ${workbench.collectionPath}`
          }
          description={
            workbench.queryText
              ? 'Loosen a clause, or check the field names and types against the collection.'
              : workbench.isPattern
                ? 'The collections matching this pattern hold only subcollections; the schema tree shows what is below.'
                : 'A collection exists once it has a document. Write one from your app, add one here, or import JSON.'
          }
          contents={
            workbench.queryText || workbench.isPattern ? undefined : (
              <div className="flex gap-2">
                <Button
                  variant="primary"
                  icon={<PlusIcon />}
                  onClick={() =>
                    openCreate({ kind: 'document', collection: workbench.collectionPath })
                  }
                  data-testid="empty-add-document"
                >
                  Add document
                </Button>
                <Button
                  variant="secondary"
                  onClick={() =>
                    openCreate({ kind: 'import', collection: workbench.collectionPath })
                  }
                >
                  Import JSON
                </Button>
              </div>
            )
          }
        />
      </div>
    )

  const allChecked =
    everything ||
    (documents.length > 0 && documents.every((document) => checked.has(document.path)))
  const someChecked = everything || documents.some((document) => checked.has(document.path))
  const top = items[0]?.start ?? 0
  const bottom = virtualizer.getTotalSize() - (items.at(-1)?.end ?? 0)
  const before = offsets[first] ?? 0
  const after = dataWidth - (offsets[last + 1] ?? dataWidth)
  const span = 3 + (subcolumn ? 1 : 0) + (before > 0 ? 1 : 0) + cells.length + (after > 0 ? 1 : 0)
  const sortOf = (field: string) =>
    workbench.query.orderBy.find((order) => order.field === field)?.direction

  const resizer = (key: string, label: string, width: number, testId?: string) => (
    <ColumnResizer
      label={label}
      width={width}
      onResize={(px) => setResizing(px === null ? null : { key, width: px })}
      onCommit={(px) => {
        keepWidth(shape, key, px)
        setResizing(null)
      }}
      onReset={() => {
        forgetWidth(shape, key)
        setResizing(null)
      }}
      testId={testId}
    />
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-kumo-base">
      {/* The grid selects rows and cells, not text: a drag across it
          painted every id and value it crossed in the browser's selection
          blue. A value is copied with ⌘C on the cell the cursor is on, an
          id with its own copy button, and text is chosen inside the
          editor a double-click opens, which is portalled out of here. */}
      <div
        ref={scrollRef}
        className="group/grid min-h-0 flex-1 overflow-auto select-none"
        data-testid="grid-scroll"
        data-scrolled={scrolledX ? '' : undefined}
        onScroll={(event) => {
          const moved = event.currentTarget.scrollLeft > 0
          if (moved !== scrolledX) setScrolledX(moved)
        }}
      >
        <Table
          layout="fixed"
          className="border-separate border-spacing-0"
          style={{ width: leading + dataWidth, minWidth: '100%' }}
        >
          <colgroup>
            <col style={{ width: CHECK_WIDTH }} />
            <col style={{ width: idWidth }} />
            {subcolumn && <col style={{ width: subWidth }} />}
            {before > 0 && <col style={{ width: before }} />}
            {cells.map((column) => (
              <col key={column.key} style={{ width: column.width }} />
            ))}
            {after > 0 && <col style={{ width: after }} />}
            {/* Slack goes here, so columns keep their width when the inspector opens. */}
            <col />
          </colgroup>
          <Table.Header variant="compact" className="sticky top-0 z-10 bg-kumo-elevated">
            <Table.Row>
              <Table.CheckHead
                checked={allChecked}
                indeterminate={someChecked && !allChecked}
                onCheckedChange={(next) =>
                  setChecked(next ? documents.map((document) => document.path) : [])
                }
                aria-label="Select every loaded document"
                className={`border-b border-kumo-line ${PIN_HEAD} ${frozen ? '' : PIN_EDGE}`}
                style={{ left: 0 }}
              />
              <Table.Head
                className={`border-b border-kumo-line !px-1 ${frozen ? `${PIN_HEAD} ${PIN_EDGE}` : ''}`}
                style={frozen ? { left: CHECK_WIDTH } : undefined}
              >
                <IdHeaderMenu
                  label={workbench.group ? 'path' : 'id'}
                  frozen={frozen}
                  onFreeze={(next) => setFrozen(shape, next)}
                />
                {resizer(ID_COLUMN, workbench.group ? 'path' : 'id', idWidth, 'resize-id')}
              </Table.Head>
              {subcolumn && (
                <Table.Head className="border-b border-kumo-line" data-testid="subcollections-head">
                  <span
                    className="flex items-center gap-1.5 text-kumo-subtle"
                    title={
                      known.length > 0
                        ? `Documents here can hold ${known.map((node) => node.id).join(', ')}`
                        : 'Subcollections'
                    }
                  >
                    <FolderIcon size={13} />
                    <span className="font-mono text-[12px] font-medium">subcollections</span>
                  </span>
                </Table.Head>
              )}
              {before > 0 && <Table.Head className="border-b border-kumo-line" aria-hidden />}
              {cells.map((column) => {
                const sorted = column.kind === 'field' ? sortOf(column.key) : undefined
                return (
                  <Table.Head
                    key={column.key}
                    className="border-b border-kumo-line !px-1"
                    aria-sort={
                      sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : undefined
                    }
                  >
                    {column.kind === 'field' ? (
                      <HeaderMenu column={column.column} />
                    ) : (
                      <FoldedHeader folded={column.folded} />
                    )}
                    {resizer(
                      column.key,
                      column.kind === 'field' ? column.key : 'rare fields',
                      column.width,
                      `resize-${column.kind === 'field' ? column.key : 'folded'}`,
                    )}
                  </Table.Head>
                )
              })}
              {after > 0 && <Table.Head className="border-b border-kumo-line" aria-hidden />}
              <Table.Head className="border-b border-kumo-line" aria-hidden />
            </Table.Row>
          </Table.Header>
          <Table.Body className="[&_td]:h-[32px] [&_td]:py-0">
            {top > 0 && (
              <tr aria-hidden>
                <td colSpan={span} style={{ height: top, padding: 0, border: 0 }} />
              </tr>
            )}
            {items.map((item) => {
              const document = documents[item.index]
              if (!document) return null
              return (
                <GridRow
                  key={document.path}
                  document={document}
                  index={item.index}
                  cells={cells}
                  before={before > 0}
                  after={after > 0}
                  subcolumn={subcolumn}
                  known={known}
                  group={workbench.group}
                  checked={everything || checked.has(document.path)}
                  focused={focused === document.path}
                  open={workbench.selectedDocument === document.path}
                  frozen={frozen}
                  cursor={focused === document.path ? cursorField : undefined}
                  flash={flashes.get(document.path)?.kind}
                  actions={actions}
                />
              )
            })}
            {bottom > 0 && (
              <tr aria-hidden>
                <td colSpan={span} style={{ height: bottom, padding: 0, border: 0 }} />
              </tr>
            )}
          </Table.Body>
        </Table>
      </div>
      {editing && editingDocument && (
        <CellEditor
          key={`${editing.path}\u0000${editing.field}`}
          document={editingDocument}
          field={editing.field}
          column={arranged.columns.find((column) => column.field === editing.field)}
          anchor={editingAnchor}
          bounds={gridBounds}
          onDone={closeEditor}
        />
      )}
      <GridFooter
        loaded={documents.length}
        hasMore={Boolean(page.hasNextPage)}
        hiddenCount={hiddenCount}
        onShowAll={showAll}
      />
    </div>
  )
}

function GridFooter({
  loaded,
  hasMore,
  hiddenCount,
  onShowAll,
}: {
  loaded: number
  hasMore: boolean
  hiddenCount: number
  onShowAll: () => void
}) {
  // While rows are ticked, everything about them is in the selection bar
  // over the query line — the count, Export, Delete — rather than spread
  // between this footer and the toolbar.
  const selecting = useSelection((state) => state.checked.size > 0 || state.everything)
  const openExport = useExportDialog((state) => state.setOpen)
  return (
    // Nothing here wraps: the bar is one row high, so a narrow grid scrolls
    // its footer sideways instead of stacking the words on top of each other.
    <div className="flex h-9 shrink-0 items-center gap-3 overflow-x-auto border-t border-kumo-line px-3 whitespace-nowrap">
      <span className="shrink-0">
        <Text variant="secondary" size="sm" as="span">
          <span className="tabular-nums">{loaded.toLocaleString('en-US')}</span> loaded
          {/* Said, not offered: the next page is fetched while the last
              twenty rows are still ahead, so a Load more button only
              ever arrived after the rows it would have loaded. */}
          {hasMore ? ' · more on scroll' : ''}
          {/* No "first page N ms". It timed one request and went on
              standing beside "300 loaded" as if it described them, and it
              was the browser's wall time — transfer and decoding — read
              as the engine's speed. The count's tooltip says how long
              counting took, where somebody asking looks. */}
        </Text>
      </span>
      {hiddenCount > 0 && (
        <span className="shrink-0">
          <Button variant="ghost" size="xs" onClick={onShowAll} data-testid="show-all-columns">
            {hiddenCount} hidden column{hiddenCount === 1 ? '' : 's'} · show all
          </Button>
        </span>
      )}
      {/* What is shown on the left, with its one remedy beside it; the
          thing to do with it at the right end, under the count on the
          filter line. Everything here sat on the left and the bar's right
          half was always empty. */}
      {!selecting && (
        <span className="ml-auto shrink-0">
          <Button
            variant="ghost"
            size="xs"
            icon={<DownloadSimpleIcon />}
            onClick={() => openExport(true)}
            data-testid="export-open"
          >
            Export
          </Button>
        </span>
      )}
    </div>
  )
}

/** The query text does not parse, so nothing ran; the line above says why. */
function QueryUnparsed() {
  const workbench = useWorkbench()
  return (
    <div className="min-h-0 flex-1 overflow-auto" data-testid="query-unparsed">
      <Empty
        icon={<FunnelIcon size={48} className="text-kumo-inactive" />}
        title="This query did not parse"
        description="The filter line above says what went wrong. Nothing ran, so this is empty rather than showing rows from the last query that worked."
        contents={
          <Button variant="secondary" onClick={() => workbench.setQueryText('')}>
            Clear the query
          </Button>
        }
      />
    </div>
  )
}

function QueryFailure({ error }: { error: Error }) {
  const workbench = useWorkbench()
  const navigate = useNavigate()
  const denied = error instanceof FirestoreError && error.denied
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <Empty
        icon={
          denied ? (
            <LockKeyIcon size={48} className="text-kumo-inactive" />
          ) : (
            <WarningIcon size={48} className="text-kumo-inactive" />
          )
        }
        title={denied ? 'Denied by security rules' : 'The query failed'}
        description={denied ? `${error.message} Viewing as ${describe(workbench)}.` : error.message}
        contents={
          denied ? (
            <span className="flex flex-wrap justify-center gap-2">
              {/* The decision behind the denial, on the rules page: the
                  lines that refused it and the values they saw. It used to
                  say "open the Requests drawer", a list to search by hand. */}
              <Button
                variant="primary"
                icon={<ShieldCheckIcon />}
                onClick={() =>
                  void navigate({
                    to: '/firestore/rules',
                    search: {
                      db: workbench.database === DEFAULT_DATABASE ? undefined : workbench.database,
                      path: workbench.collectionPath || undefined,
                      uid:
                        workbench.viewAs.kind === 'user' || workbench.viewAs.kind === 'custom'
                          ? workbench.viewAs.uid
                          : undefined,
                      denied: true,
                      pick: true,
                    },
                  })
                }
                data-testid="see-why"
              >
                See why
              </Button>
              <Button variant="secondary" onClick={() => workbench.setViewAs({ kind: 'owner' })}>
                View as admin
              </Button>
            </span>
          ) : undefined
        }
      />
    </div>
  )
}

function describe(workbench: ReturnType<typeof useWorkbench>): string {
  const viewAs = workbench.viewAs
  return viewAs.kind === 'anonymous'
    ? 'an anonymous client'
    : viewAs.kind === 'user'
      ? (viewAs.email ?? viewAs.uid)
      : viewAs.kind === 'custom'
        ? `${viewAs.email ?? viewAs.uid}, a custom identity`
        : 'admin'
}

/**
 * The recents shown on the root landing, one class per place: one row, as
 * many as the collection cards below have columns, and in their columns.
 * Twelve wrapped, at their full lengths, were seven rows above the
 * collections they were meant to be a shortcut past. The breakpoints are
 * where the cards' `repeat(auto-fill, minmax(240px, 1fr))` gains a column
 * with `gap-2` (7 px at the 14 px root): n × 240 + (n − 1) × 7. ⌘K still
 * offers all twelve.
 */
const RECENT_SHOWN = [
  '',
  'hidden @min-[487px]:block',
  'hidden @min-[734px]:block',
  'hidden @min-[981px]:block',
  'hidden @min-[1228px]:block',
  'hidden @min-[1475px]:block',
]

function RootLanding() {
  const workbench = useWorkbench()
  const openCreate = useCreateDialog((state) => state.open)
  const recents = useRecents((state) => state.items)
  const collections = useQuery(collectionsQuery(workbench.ownerScope, ''))
  const schema = useQuery(workbenchSchemaQuery(workbench))
  const shapes = new Map((schema.data?.collections ?? []).map((node) => [node.id, node]))
  const anyNested = [...shapes.values()].some((node) => node.children.length > 0)
  return (
    <div className="grid content-start gap-4 overflow-auto px-5 py-4">
      <Text variant="secondary">
        Root collections in <span className="font-mono text-[0.9em]">{workbench.database}</span>.
        Pick one, press <Kbd className="text-inherit">/</Kbd> and type a path, or{' '}
        <Kbd className="text-inherit">{describeKey('Mod+k')}</Kbd> to search.
      </Text>
      {recents.length > 0 && (
        <div className="@container grid gap-1.5" data-testid="recents">
          <span className="flex items-center gap-1.5 text-[12px] text-kumo-subtle">
            <ClockCounterClockwiseIcon size={14} /> Recent
          </span>
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-2">
            {recents.slice(0, RECENT_SHOWN.length).map((recent, index) => {
              const cut = recent.path.lastIndexOf('/') + 1
              const parent = recent.path.slice(0, cut)
              return (
                <li key={recent.path} className={RECENT_SHOWN[index]}>
                  <Tooltip
                    content={recent.path}
                    disabled={!parent}
                    render={
                      <button
                        type="button"
                        onClick={() => workbench.setPath(recent.path)}
                        className="flex h-7 w-full items-center gap-1.5 rounded-md bg-kumo-base px-2 font-mono text-[12px] ring ring-kumo-hairline hover:ink"
                        data-testid="recent"
                      >
                        {recent.kind === 'document' ? (
                          <FileIcon size={12} className="shrink-0 text-kumo-subtle" />
                        ) : (
                          <DatabaseIcon size={12} className="shrink-0 text-kumo-subtle" />
                        )}
                        {/* Cut from the front, so the end shows: the id is
                            what tells two documents of one collection
                            apart, and every path here starts the same
                            way. Right to left for the cut alone; the
                            isolate keeps the path itself reading left to
                            right, slashes where they belong. */}
                        <span dir="rtl" className="min-w-0 truncate text-left">
                          <bdi>
                            <span className="text-kumo-subtle">{parent}</span>
                            <span data-part="leaf">{recent.path.slice(cut)}</span>
                          </bdi>
                        </span>
                      </button>
                    }
                  />
                </li>
              )
            })}
          </ul>
        </div>
      )}
      {collections.data?.length === 0 && (
        <Empty
          icon={<DatabaseIcon size={48} className="text-kumo-inactive" />}
          title="This database is empty"
          description="Write a document from your app, import a dataset, or create the first collection here."
          contents={
            <Button
              variant="primary"
              icon={<FolderPlusIcon />}
              onClick={() => openCreate({ kind: 'collection', parent: '' })}
            >
              New collection
            </Button>
          }
        />
      )}
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-2">
        {(collections.data ?? []).map((id) => {
          const shape = shapes.get(id)
          return (
            <li key={id}>
              <button
                type="button"
                onClick={() => workbench.setPath(id)}
                className={`flex w-full items-center gap-2 rounded-lg bg-kumo-base px-3 text-left ring ring-kumo-hairline hover:ink ${
                  anyNested ? 'h-14' : 'h-11'
                }`}
                data-testid="root-collection"
              >
                <DatabaseIcon size={16} className="shrink-0 text-kumo-subtle" />
                <span className="grid min-w-0 flex-1 gap-0.5">
                  <span className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate font-mono text-[14px]">{id}</span>
                    {shape ? (
                      <span className="shrink-0 font-mono text-[11px] text-kumo-subtle tabular-nums">
                        {formatNumber(shape.documents)}
                      </span>
                    ) : (
                      <RootCount path={id} />
                    )}
                  </span>
                  {anyNested && (
                    <Tooltip
                      content={shape ? describeChildren(shape, 20) : ''}
                      disabled={!shape}
                      render={
                        <span className="truncate font-mono text-[11px] text-kumo-subtle">
                          {/* The line keeps every card the same height; only the
                          ones that actually nest say anything, so the eye
                          catches those instead of the word "no" 17 times. */}
                          {shape && shape.children.length > 0 && (
                            <span className="flex items-center gap-1">
                              <FolderIcon size={11} className="shrink-0" />
                              <span className="truncate">{describeChildren(shape)}</span>
                            </span>
                          )}
                        </span>
                      }
                    />
                  )}
                </span>
              </button>
            </li>
          )
        })}
        {collections.data && collections.data.length > 0 && (
          <li>
            <button
              type="button"
              onClick={() => openCreate({ kind: 'collection', parent: '' })}
              className={`flex w-full items-center gap-2 rounded-lg border border-dashed border-kumo-line px-3 text-left text-kumo-subtle hover:ink hover:text-kumo-default ${
                anyNested ? 'h-14' : 'h-11'
              }`}
              data-testid="root-new-collection"
            >
              <FolderPlusIcon size={16} />
              <span className="text-[14px]">New collection</span>
            </button>
          </li>
        )}
      </ul>
    </div>
  )
}

function RootCount({ path }: { path: string }) {
  const workbench = useWorkbench()
  const count = useQuery(countQueryOptions(workbench.ownerScope, path, false, EMPTY_QUERY))
  return (
    <span className="shrink-0 font-mono text-[11px] text-kumo-subtle tabular-nums">
      {count.data ? count.data.count.toLocaleString('en-US') : ''}
    </span>
  )
}

export type { FsDocument }
