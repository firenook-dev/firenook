// The grid: documents are rows, fields are columns inferred from what is
// loaded, every header carries its type, every cell is exact. Rows are
// virtualized; changed rows flash; the keyboard moves through them.

import { Badge, Button, Empty, Table, Text, Tooltip } from '@cloudflare/kumo'
import { DatabaseIcon, LockKeyIcon, PlusIcon, WarningIcon } from '@phosphor-icons/react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useEffect, useMemo, useRef } from 'react'
import { TypeBadge } from '@/components/kit'
import { type InferredColumn, inferColumns } from '../columns'
import { useLive } from '../live'
import { EMPTY_QUERY } from '../query'
import {
  collectionsQuery,
  countQueryOptions,
  missingDocumentsQuery,
  pageQueryOptions,
} from '../queries'
import { FirestoreError } from '../rest'
import { useSelection } from '../selection'
import type { FsDocument } from '../value'
import { IdCell, ValueCell } from './cells'
import { useWorkbench } from './workbench-context'

const ROW_HEIGHT = 36
const ID_WIDTH = 220
/** Collections up to this size are walked for missing ancestor documents. */
const MISSING_SCAN_LIMIT = 5_000

export function Grid({ onAddDocument }: { onAddDocument: () => void }) {
  'use no memo' // the virtualizer hands out functions the compiler cannot memoize safely
  const workbench = useWorkbench()
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

  const documents = useMemo(() => {
    const loaded = page.data?.pages.flatMap((item) => item.documents) ?? []
    // Missing ancestors only exist to hold subcollections; they belong in
    // the plain listing, never inside a filtered or ordered result.
    if (workbench.queryText || workbench.group || !missing.data?.length) return loaded
    return [...loaded, ...missing.data]
  }, [page.data, missing.data, workbench.queryText, workbench.group])

  const columns = useMemo(() => inferColumns(documents), [documents])
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
              : `No documents in ${workbench.collectionPath}`
          }
          description={
            workbench.queryText
              ? 'Loosen a clause, or check the field names and types against the collection.'
              : 'Write one from your app, or add a document here.'
          }
          contents={
            workbench.queryText ? undefined : (
              <Button variant="primary" icon={<PlusIcon />} onClick={onAddDocument}>
                Add document
              </Button>
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
  const width = 44 + ID_WIDTH + columns.reduce((sum, column) => sum + column.width, 0)

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
            <col style={{ width: ID_WIDTH }} />
            {columns.map((column) => (
              <col key={column.field} style={{ width: column.width }} />
            ))}
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
                <HeaderLabel field={workbench.group ? 'path' : 'id'} type="doc" />
              </Table.Head>
              {columns.map((column) => (
                <Table.Head key={column.field} className="border-b border-kumo-line">
                  <HeaderLabel field={column.field} type={column.type} column={column} />
                </Table.Head>
              ))}
            </Table.Row>
          </Table.Header>
          <Table.Body className="[&_td]:h-9 [&_td]:py-0">
            {top > 0 && (
              <tr aria-hidden>
                <td colSpan={columns.length + 2} style={{ height: top, padding: 0, border: 0 }} />
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
                  onClick={() => {
                    focus(document.path)
                    workbench.selectDocument(document.path)
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
                  {columns.map((column) => {
                    const value = document.fields[column.field]
                    // A value whose type differs from the column's is the odd one out.
                    const odd =
                      column.mixed !== undefined &&
                      value !== undefined &&
                      value.type !== column.type
                    return (
                      <Table.Cell
                        key={column.field}
                        className={odd ? 'bg-kumo-warning-tint' : undefined}
                        title={
                          odd
                            ? `${value.type}, where most documents have ${column.type}`
                            : undefined
                        }
                      >
                        <ValueCell
                          value={value}
                          onOpenReference={(path) => workbench.setPath(path)}
                        />
                      </Table.Cell>
                    )
                  })}
                </Table.Row>
              )
            })}
            {bottom > 0 && (
              <tr aria-hidden>
                <td
                  colSpan={columns.length + 2}
                  style={{ height: bottom, padding: 0, border: 0 }}
                />
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
      />
    </div>
  )
}

function HeaderLabel({
  field,
  type,
  column,
}: {
  field: string
  type: Parameters<typeof TypeBadge>[0]['type']
  column?: InferredColumn
}) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="truncate font-mono text-[12px] font-medium text-kumo-default" title={field}>
        {field}
      </span>
      {column?.mixed ? (
        <Tooltip
          content={`Mixed types: ${Object.entries(column.mixed)
            .map(([name, count]) => `${name} ×${count}`)
            .join(', ')}`}
          render={
            <span className="flex items-center">
              <Badge variant="warning" appearance="dot" className="text-[10px]">
                {type}
              </Badge>
            </span>
          }
        />
      ) : (
        <TypeBadge type={type} />
      )}
    </span>
  )
}

function GridFooter({
  loaded,
  hasMore,
  fetching,
  elapsedMs,
  onLoadMore,
}: {
  loaded: number
  hasMore: boolean
  fetching: boolean
  elapsedMs: number
  onLoadMore: () => void
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
  const collections = useQuery(collectionsQuery(workbench.ownerScope, ''))
  return (
    <div className="grid gap-4 overflow-auto py-2">
      <Text variant="secondary">
        Root collections in <span className="font-mono text-[0.9em]">{workbench.database}</span>.
        Pick one, or press{' '}
        <kbd className="rounded border border-kumo-hairline bg-kumo-base px-1 text-[10px]">/</kbd>{' '}
        and type a path.
      </Text>
      {collections.data?.length === 0 && (
        <Empty
          icon={<DatabaseIcon size={48} className="text-kumo-inactive" />}
          title="This database is empty"
          description="Write a document from your app, import a dataset, or add one here."
        />
      )}
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-2">
        {(collections.data ?? []).map((id) => (
          <li key={id}>
            <button
              type="button"
              onClick={() => workbench.setPath(id)}
              className="flex h-11 w-full items-center gap-2 rounded-lg bg-kumo-base px-3 text-left ring ring-kumo-hairline hover:bg-kumo-tint"
            >
              <DatabaseIcon size={16} className="text-kumo-subtle" />
              <span className="min-w-0 flex-1 truncate font-mono text-[0.9em]">{id}</span>
              <RootCount path={id} />
            </button>
          </li>
        ))}
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
