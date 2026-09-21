// The grid: documents are rows, fields are columns inferred from what is
// loaded, every header carries its type, every cell is exact. Rows are
// virtualized; changed rows flash; the keyboard moves through them.

import { Button, Empty, Table, Text } from '@cloudflare/kumo'
import {
  ClockCounterClockwiseIcon,
  DatabaseIcon,
  FileIcon,
  FolderIcon,
  FolderPlusIcon,
  LockKeyIcon,
  PlusIcon,
  WarningIcon,
} from '@phosphor-icons/react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useEffect, useMemo, useRef, useState } from 'react'
import { TypeBadge } from '@/components/kit'
import { inferColumns } from '../columns'
import { useCreateDialog } from '../create'
import { useLive } from '../live'
import { EMPTY_QUERY } from '../query'
import { useColumns } from '../query-line-store'
import {
  collectionsQuery,
  countQueryOptions,
  missingDocumentsQuery,
  pageQueryOptions,
} from '../queries'
import { useRecents } from '../recents'
import { FirestoreError } from '../rest'
import { childrenOf, describeChildren, schemaQuery } from '../schema'
import { useSelection } from '../selection'
import { type FsDocument, formatNumber } from '../value'
import { IdCell, ValueCell } from './cells'
import { HeaderMenu } from './header-menu'
import { InlineCellEditor, inlineEditable } from './inline-cell-editor'
import { INSPECTOR_WIDTH } from './inspector'
import { SubcollectionsCell, subcollectionsWidth } from './subcollections-cell'
import { useWorkbench } from './workbench-context'

const ROW_HEIGHT = 36
const ID_WIDTH = 220
/** A group shows whole paths in the first column, so it gets more room. */
const PATH_WIDTH = 340
/** How long a click waits for its double, when opening at once would hide the cell. */
const DOUBLE_CLICK_MS = 260
/** Collections up to this size are walked for missing ancestor documents. */
const MISSING_SCAN_LIMIT = 5_000

export function Grid() {
  'use no memo' // the virtualizer hands out functions the compiler cannot memoize safely
  const workbench = useWorkbench()
  const openCreate = useCreateDialog((state) => state.open)
  const hidden = useColumns((state) => state.hidden)
  const showAll = useColumns((state) => state.showAll)
  // The cell being edited in place, if any.
  const [editing, setEditing] = useState<{ path: string; field: string } | null>(null)
  // A click that would open the inspector over the clicked cell waits for a
  // possible second click, so a double-click can edit the cell instead.
  const pendingOpen = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(pendingOpen.current), [])
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
  const schema = useQuery(schemaQuery(workbench.database))
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

  const allColumns = useMemo(() => inferColumns(documents), [documents])
  // A missing ancestor exists only because of its subcollections, so it
  // always earns the column, even before the schema answers.
  const subcolumn = known.length > 0 || documents.some((document) => document.missing)
  const subWidth = subcollectionsWidth(known)
  const columns = useMemo(
    () => allColumns.filter((column) => !hidden.has(column.field)),
    [allColumns, hidden],
  )
  const hiddenCount = allColumns.length - columns.length
  const scrollRef = useRef<HTMLDivElement>(null)
  // oxlint-disable-next-line react/incompatible-library -- the directive above opts this component out of the compiler
  const virtualizer = useVirtualizer({
    count: documents.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  })

  const checked = useSelection((state) => state.checked)
  const focused = useSelection((state) => state.focused)
  const toggle = useSelection((state) => state.toggle)
  const setChecked = useSelection((state) => state.setChecked)
  const focus = useSelection((state) => state.focus)
  const flashes = useLive((state) => state.flashes)

  // Keyboard: arrows move the focused row, Enter opens it, Escape closes.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null
      if (
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      )
        return
      if (documents.length === 0) return
      const index = documents.findIndex((document) => document.path === focused)
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const next = Math.min(
          documents.length - 1,
          Math.max(0, index === -1 ? 0 : index + (event.key === 'ArrowDown' ? 1 : -1)),
        )
        const document = documents[next]
        if (!document) return
        focus(document.path)
        virtualizer.scrollToIndex(next, { align: 'auto' })
        if (workbench.selectedDocument) workbench.selectDocument(document.path)
      } else if (event.key === 'Enter' && focused) {
        event.preventDefault()
        workbench.selectDocument(focused)
      } else if (event.key === ' ' && focused) {
        event.preventDefault()
        toggle(focused)
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
        event.preventDefault()
        setChecked(documents.map((document) => document.path))
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [documents, focused, focus, toggle, setChecked, virtualizer, workbench])

  // Fetch the next page as the last rows come into view.
  const items = virtualizer.getVirtualItems()
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

  if (!workbench.collectionPath) return <RootLanding />
  if (page.isError) return <QueryFailure error={page.error} />
  if (page.isPending)
    return (
      <div className="flex h-40 items-center justify-center rounded-lg bg-kumo-base ring ring-kumo-line">
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
    documents.length > 0 && documents.every((document) => checked.has(document.path))
  const someChecked = documents.some((document) => checked.has(document.path))
  const top = items[0]?.start ?? 0
  const bottom = virtualizer.getTotalSize() - (items.at(-1)?.end ?? 0)
  const idWidth = workbench.group ? PATH_WIDTH : ID_WIDTH
  const width =
    44 +
    idWidth +
    (subcolumn ? subWidth : 0) +
    columns.reduce((sum, column) => sum + column.width, 0)
  const span = columns.length + 3 + (subcolumn ? 1 : 0)

  return (
    <div className="flex min-h-0 flex-1 flex-col rounded-lg bg-kumo-base ring ring-kumo-line">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto" data-testid="grid-scroll">
        <Table
          layout="fixed"
          className="border-separate border-spacing-0"
          style={{ width, minWidth: '100%' }}
        >
          <colgroup>
            <col style={{ width: 44 }} />
            <col style={{ width: idWidth }} />
            {subcolumn && <col style={{ width: subWidth }} />}
            {columns.map((column) => (
              <col key={column.field} style={{ width: column.width }} />
            ))}
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
                className="border-b border-kumo-line"
              />
              <Table.Head className="border-b border-kumo-line">
                <span className="flex items-center gap-1.5">
                  <span className="font-mono text-[12px] font-medium text-kumo-default">
                    {workbench.group ? 'path' : 'id'}
                  </span>
                  <TypeBadge type="doc" />
                </span>
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
              {columns.map((column) => (
                <Table.Head key={column.field} className="border-b border-kumo-line !px-1">
                  <HeaderMenu column={column} />
                </Table.Head>
              ))}
              <Table.Head className="border-b border-kumo-line" aria-hidden />
            </Table.Row>
          </Table.Header>
          <Table.Body className="[&_td]:h-9 [&_td]:py-0">
            {top > 0 && (
              <tr aria-hidden>
                <td colSpan={span} style={{ height: top, padding: 0, border: 0 }} />
              </tr>
            )}
            {items.map((item) => {
              const document = documents[item.index]
              if (!document) return null
              const flash = flashes.get(document.path)
              const isFocused =
                focused === document.path || workbench.selectedDocument === document.path
              const isChecked = checked.has(document.path)
              return (
                <Table.Row
                  key={document.path}
                  data-index={item.index}
                  variant={isChecked ? 'selected' : 'default'}
                  className={`cursor-default ${
                    isFocused
                      ? 'bg-kumo-tint [&>td:first-child]:shadow-[inset_2px_0_0_var(--color-kumo-brand)]'
                      : ''
                  } ${flash ? (flash.kind === 'deleted' ? 'row-flash-deleted' : 'row-flash') : ''}`}
                  onClick={(event) => {
                    focus(document.path)
                    const cell = (event.target as HTMLElement).closest('td')
                    const grid = scrollRef.current
                    const covered =
                      !workbench.selectedDocument &&
                      cell !== null &&
                      grid !== null &&
                      cell.getBoundingClientRect().right >
                        grid.getBoundingClientRect().right - INSPECTOR_WIDTH
                    if (!covered) {
                      workbench.selectDocument(document.path)
                      return
                    }
                    window.clearTimeout(pendingOpen.current)
                    pendingOpen.current = window.setTimeout(
                      () => workbench.selectDocument(document.path),
                      DOUBLE_CLICK_MS,
                    )
                  }}
                  data-testid="grid-row"
                >
                  <Table.CheckCell
                    checked={isChecked}
                    onCheckedChange={() => toggle(document.path)}
                    aria-label={`Select ${document.id}`}
                  />
                  <Table.Cell>
                    <span className="flex items-center gap-1.5">
                      {document.missing && (
                        <span
                          className="flex h-lh items-center text-kumo-subtle"
                          title="No document here, only subcollections"
                        >
                          <WarningIcon size={14} />
                        </span>
                      )}
                      <IdCell
                        id={workbench.group ? document.path : document.id}
                        missing={document.missing}
                      />
                    </span>
                  </Table.Cell>
                  {subcolumn && (
                    <Table.Cell className="!px-2">
                      <SubcollectionsCell path={document.path} known={known} />
                    </Table.Cell>
                  )}
                  {columns.map((column) => {
                    const value = document.fields[column.field]
                    // A value whose type differs from the column's is the odd one out.
                    const odd =
                      column.mixed !== undefined &&
                      value !== undefined &&
                      value.type !== column.type
                    const isEditing =
                      editing?.path === document.path && editing.field === column.field
                    return (
                      <Table.Cell
                        key={column.field}
                        className={`${odd ? 'bg-kumo-warning-tint' : ''} ${isEditing ? '!px-1' : ''}`}
                        title={
                          odd
                            ? `${value.type}, where most documents have ${column.type}`
                            : undefined
                        }
                        onDoubleClick={(event) => {
                          if (document.missing || !inlineEditable(value)) return
                          event.preventDefault()
                          event.stopPropagation()
                          window.clearTimeout(pendingOpen.current)
                          setEditing({ path: document.path, field: column.field })
                        }}
                      >
                        {isEditing ? (
                          <InlineCellEditor
                            document={document}
                            field={column.field}
                            value={value}
                            onDone={() => setEditing(null)}
                          />
                        ) : (
                          <ValueCell
                            value={value}
                            onOpenReference={(path) => workbench.selectDocument(path)}
                          />
                        )}
                      </Table.Cell>
                    )
                  })}
                  <Table.Cell aria-hidden />
                </Table.Row>
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
      <GridFooter
        loaded={documents.length}
        hasMore={Boolean(page.hasNextPage)}
        fetching={page.isFetchingNextPage}
        elapsedMs={page.data?.pages[0]?.elapsedMs ?? 0}
        onLoadMore={() => void page.fetchNextPage()}
        hiddenCount={hiddenCount}
        onShowAll={showAll}
      />
    </div>
  )
}

function GridFooter({
  loaded,
  hasMore,
  fetching,
  elapsedMs,
  onLoadMore,
  hiddenCount,
  onShowAll,
}: {
  loaded: number
  hasMore: boolean
  fetching: boolean
  elapsedMs: number
  onLoadMore: () => void
  hiddenCount: number
  onShowAll: () => void
}) {
  const checked = useSelection((state) => state.checked)
  return (
    <div className="flex h-9 shrink-0 items-center gap-3 border-t border-kumo-line px-3">
      <Text variant="secondary" size="sm" as="span">
        <span className="tabular-nums">{loaded.toLocaleString('en-US')}</span> loaded
        {hasMore ? ' · more on scroll' : ''}
        <span className="text-kumo-inactive">
          {' '}
          · first page {Math.max(1, Math.round(elapsedMs))} ms
        </span>
      </Text>
      {hasMore && (
        <Button variant="ghost" size="xs" onClick={onLoadMore} loading={fetching}>
          Load more
        </Button>
      )}
      {hiddenCount > 0 && (
        <Button variant="ghost" size="xs" onClick={onShowAll} data-testid="show-all-columns">
          {hiddenCount} hidden column{hiddenCount === 1 ? '' : 's'} · show all
        </Button>
      )}
      {checked.size > 0 && (
        <span className="ml-auto">
          <Text variant="secondary" size="sm" as="span">
            <span className="tabular-nums">{checked.size}</span> selected
          </Text>
        </span>
      )}
    </div>
  )
}

function QueryFailure({ error }: { error: Error }) {
  const workbench = useWorkbench()
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
        description={
          denied
            ? `${error.message} Viewing as ${describe(workbench)}; open the Requests drawer for the rule that decided it.`
            : error.message
        }
        contents={
          denied ? (
            <Button variant="secondary" onClick={() => workbench.setViewAs({ kind: 'owner' })}>
              View as admin
            </Button>
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
      : 'admin'
}

function RootLanding() {
  const workbench = useWorkbench()
  const openCreate = useCreateDialog((state) => state.open)
  const recents = useRecents((state) => state.items)
  const collections = useQuery(collectionsQuery(workbench.ownerScope, ''))
  const schema = useQuery(schemaQuery(workbench.database))
  const shapes = new Map((schema.data?.collections ?? []).map((node) => [node.id, node]))
  const anyNested = [...shapes.values()].some((node) => node.children.length > 0)
  return (
    <div className="grid gap-4 overflow-auto py-2">
      <Text variant="secondary">
        Root collections in <span className="font-mono text-[0.9em]">{workbench.database}</span>.
        Pick one, press{' '}
        <kbd className="rounded border border-kumo-hairline bg-kumo-base px-1 text-[10px]">/</kbd>{' '}
        and type a path, or{' '}
        <kbd className="rounded border border-kumo-hairline bg-kumo-base px-1 text-[10px]">⌘K</kbd>{' '}
        to search.
      </Text>
      {recents.length > 0 && (
        <div className="grid gap-1.5" data-testid="recents">
          <span className="flex items-center gap-1.5 text-[12px] text-kumo-subtle">
            <ClockCounterClockwiseIcon size={14} /> Recent
          </span>
          <ul className="flex flex-wrap gap-1.5">
            {recents.map((recent) => (
              <li key={recent.path}>
                <button
                  type="button"
                  onClick={() => workbench.setPath(recent.path)}
                  className="flex h-7 items-center gap-1.5 rounded-md bg-kumo-base px-2 font-mono text-[12px] ring ring-kumo-hairline hover:bg-kumo-tint"
                >
                  {recent.kind === 'document' ? (
                    <FileIcon size={12} className="text-kumo-subtle" />
                  ) : (
                    <DatabaseIcon size={12} className="text-kumo-subtle" />
                  )}
                  {recent.path}
                </button>
              </li>
            ))}
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
                className={`flex w-full items-center gap-2 rounded-lg bg-kumo-base px-3 text-left ring ring-kumo-hairline hover:bg-kumo-tint ${
                  anyNested ? 'h-14' : 'h-11'
                }`}
                data-testid="root-collection"
              >
                <DatabaseIcon size={16} className="shrink-0 text-kumo-subtle" />
                <span className="grid min-w-0 flex-1 gap-0.5">
                  <span className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate font-mono text-[0.9em]">{id}</span>
                    {shape ? (
                      <span className="font-mono text-[11px] text-kumo-subtle tabular-nums">
                        {formatNumber(shape.documents)}
                      </span>
                    ) : (
                      <RootCount path={id} />
                    )}
                  </span>
                  {anyNested && (
                    <span
                      className="truncate font-mono text-[11px] text-kumo-subtle"
                      title={shape ? describeChildren(shape, 20) : undefined}
                    >
                      {shape && shape.children.length > 0 ? (
                        <span className="flex items-center gap-1">
                          <FolderIcon size={11} className="shrink-0" />
                          <span className="truncate">{describeChildren(shape)}</span>
                        </span>
                      ) : (
                        <span className="text-kumo-inactive">no subcollections</span>
                      )}
                    </span>
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
              className={`flex w-full items-center gap-2 rounded-lg border border-dashed border-kumo-line px-3 text-left text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default ${
                anyNested ? 'h-14' : 'h-11'
              }`}
              data-testid="root-new-collection"
            >
              <FolderPlusIcon size={16} />
              <span className="text-[0.9em]">New collection</span>
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
    <span className="font-mono text-[11px] text-kumo-subtle tabular-nums">
      {count.data ? count.data.count.toLocaleString('en-US') : ''}
    </span>
  )
}

export type { FsDocument }
