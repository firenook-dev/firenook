// What the database's index file declares, in two tables as Firebase's
// console lists them: composite indexes, and single-field overrides. A row
// is the entry as the file writes it; its menu copies it or takes it out of
// the file. Rows the file gains while the page watches — an Add here, or a
// save in an editor — flash as they arrive.

import { CopySimpleIcon, TrashIcon } from '@phosphor-icons/react'
import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { DangerConfirm } from '@/components/console/danger-confirm'
import { DataTable, type DataTableColumn } from '@/components/console/data-table'
import type { RowMenuItem } from '@/components/console/row-menu'
import { FLASH_MS } from '@/components/kit/flash'
import { copyToClipboard } from '@/lib/copy'
import {
  type DatabaseIndexes,
  type DeclaredFieldOverride,
  type DeclaredIndex,
  type IndexFileEntry,
  describeFields,
  describeOverride,
  entryKey,
  modeWord,
} from '../indexes'
import { FieldChips } from './field-chips'
import { fileName } from './file-name'
import type { IndexEditing } from './indexes-page'

/** Rows a table shows before it scrolls: a document page, not a workbench. */
const VISIBLE_ROWS = 12
const ROW = 32
const HEAD = 33

interface Keyed<T> {
  key: string
  row: T
}

/** What the confirm asks about. */
interface Removal {
  key: string
  entry: IndexFileEntry
  title: string
  description: string
}

export function DeclaredIndexes({
  file,
  loading,
  editing,
}: {
  file: DatabaseIndexes | undefined
  loading: boolean
  editing: IndexEditing
}) {
  const rows = keyed(file?.indexes ?? [])
  const flashes = useArrivals(file?.database, rows, !loading)
  const [removing, setRemoving] = useState<Removal | null>(null)
  const name = file ? fileName(file.path) : 'the index file'
  const menu = ({ key, row }: Keyed<DeclaredIndex>): RowMenuItem[] => [
    copyItem(row.entry, `the index on ${row.collectionGroup}`),
    {
      id: 'remove',
      label: `Remove from ${name}…`,
      icon: TrashIcon,
      danger: true,
      disabled: editing.blocked,
      run: () =>
        setRemoving({
          key: `remove|${key}`,
          entry: { section: 'indexes', entry: row.entry },
          title: `Remove the index on ${row.collectionGroup}`,
          description: `${describeFields(row.fields)} comes out of ${name} and stops applying right away. A query that needs it shows up under Missing indexes again${
            editing.strict ? ' and fails here' : ''
          }.`,
        }),
    },
  ]
  return (
    <>
      <Table
        ariaLabel="Composite indexes"
        rows={rows}
        columns={COMPOSITE_COLUMNS}
        memoryKey="firestore.indexes.composite"
        menu={menu}
        flashes={flashes}
        loading={loading}
        label={(row) => `the index on ${row.collectionGroup} (${describeFields(row.fields)})`}
        empty="No composite indexes yet. When your app runs a query that needs one, it shows up under Missing indexes, ready to add."
        testId="composite-indexes"
      />
      <RemoveConfirm removing={removing} onClose={() => setRemoving(null)} editing={editing} />
    </>
  )
}

export function DeclaredFieldOverrides({
  file,
  loading,
  editing,
}: {
  file: DatabaseIndexes | undefined
  loading: boolean
  editing: IndexEditing
}) {
  const rows = keyed(file?.fieldOverrides ?? [])
  const flashes = useArrivals(file?.database, rows, !loading)
  const [removing, setRemoving] = useState<Removal | null>(null)
  const name = file ? fileName(file.path) : 'the index file'
  const menu = ({ key, row }: Keyed<DeclaredFieldOverride>): RowMenuItem[] => [
    copyItem(row.entry, `the override of ${row.fieldPath}`),
    {
      id: 'remove',
      label: `Remove from ${name}…`,
      icon: TrashIcon,
      danger: true,
      disabled: editing.blocked,
      run: () =>
        setRemoving({
          key: `remove|${key}`,
          entry: { section: 'fieldOverrides', entry: row.entry },
          title: `Remove the override of ${row.fieldPath}`,
          description: `${row.fieldPath} in ${row.collectionGroup} goes back to Firestore's automatic indexes, which do not cover collection group queries. ${name} is saved and the change applies right away.`,
        }),
    },
  ]
  return (
    <>
      <Table
        ariaLabel="Single-field overrides"
        rows={rows}
        columns={OVERRIDE_COLUMNS}
        memoryKey="firestore.indexes.overrides"
        menu={menu}
        flashes={flashes}
        loading={loading}
        label={(row) => `the override of ${row.fieldPath} in ${row.collectionGroup}`}
        empty="No overrides. Every field uses Firestore's automatic indexes."
        testId="field-overrides"
      />
      <RemoveConfirm removing={removing} onClose={() => setRemoving(null)} editing={editing} />
    </>
  )
}

function copyItem(entry: Record<string, unknown>, what: string): RowMenuItem {
  return {
    id: 'copy',
    label: 'Copy as JSON',
    icon: CopySimpleIcon,
    run: () => void copyToClipboard(JSON.stringify(entry, null, 2), { what }),
  }
}

/** A table that is as tall as its rows, up to a dozen. */
function Table<T>({
  ariaLabel,
  rows,
  columns,
  memoryKey,
  menu,
  label,
  flashes,
  loading,
  empty,
  testId,
}: {
  ariaLabel: string
  rows: readonly Keyed<T>[]
  columns: readonly DataTableColumn<Keyed<T>>[]
  memoryKey: string
  menu: (row: Keyed<T>) => RowMenuItem[]
  /** What a row is called, after "Actions for". */
  label: (row: T) => string
  flashes: ReadonlyMap<string, 'created'>
  loading: boolean
  /** The sentence an empty table is, in one line: a document page has no room for a card. */
  empty: string
  testId: string
}) {
  const shown = Math.max(1, Math.min(rows.length, VISIBLE_ROWS))
  const frame = useRef<HTMLDivElement>(null)
  const bar = useScrollbarRoom(frame)
  if (rows.length === 0 && !loading)
    return (
      <p
        className="m-0 rounded-lg px-4 py-3 text-[13px] text-kumo-subtle ring ring-kumo-line"
        data-testid={testId}
        data-rows={0}
      >
        {empty}
      </p>
    )
  return (
    <div
      ref={frame}
      className="flex min-h-0 flex-col overflow-hidden rounded-lg ring ring-kumo-line"
      style={{ height: rows.length === 0 ? undefined : HEAD + shown * ROW + 2 + bar }}
      data-testid={testId}
      data-rows={rows.length}
    >
      <DataTable
        ariaLabel={ariaLabel}
        rows={rows}
        rowKey={(row) => row.key}
        rowLabel={(row) => label(row.row)}
        columns={columns}
        memoryKey={memoryKey}
        rowMenu={menu}
        flashes={flashes}
        loading={loading}
        keyboard="focus"
        empty={null}
        testId={`${testId}-grid`}
      />
    </div>
  )
}

function RemoveConfirm({
  removing,
  onClose,
  editing,
}: {
  removing: Removal | null
  onClose: () => void
  editing: IndexEditing
}) {
  const failed = removing && editing.errorKey === removing.key ? editing.error : null
  return (
    <DangerConfirm
      open={removing !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      title={removing?.title ?? 'Remove'}
      description={removing?.description ?? ''}
      pending={removing !== null && editing.pending === removing.key}
      {...(failed ? { error: failed.message } : {})}
      onConfirm={() => {
        if (removing) editing.run({ key: removing.key, add: [], remove: [removing.entry] }, onClose)
      }}
      testId="index-remove-confirm"
    />
  )
}

/**
 * Each entry with a key that stays the same while it is in the file: the
 * entry itself, and which time it appears, for a file that writes one twice.
 */
function keyed<T extends { entry: Record<string, unknown> }>(rows: readonly T[]): Keyed<T>[] {
  const seen = new Map<string, number>()
  return rows.map((row) => {
    const entry = entryKey(row.entry)
    const time = (seen.get(entry) ?? 0) + 1
    seen.set(entry, time)
    return { key: time === 1 ? entry : `${entry}#${time}`, row }
  })
}

/**
 * The rows that arrived since the page last looked, flashing for as long
 * as a row flashes. Nothing flashes as the list first loads or when the
 * page turns to another database.
 */
function useArrivals<T>(
  database: string | undefined,
  rows: readonly Keyed<T>[],
  ready: boolean,
): ReadonlyMap<string, 'created'> {
  const seen = useRef<{ database: string | undefined; keys: Set<string> } | null>(null)
  const [flashes, setFlashes] = useState<ReadonlyMap<string, 'created'>>(NO_FLASHES)
  const joined = rows.map((row) => row.key).join('\n')
  useEffect(() => {
    if (!ready) return
    const keys = new Set(joined === '' ? [] : joined.split('\n'))
    const before = seen.current
    seen.current = { database, keys }
    if (!before || before.database !== database) return
    const arrived = [...keys].filter((key) => !before.keys.has(key))
    if (arrived.length === 0) return
    setFlashes(new Map(arrived.map((key) => [key, 'created' as const])))
    const timer = window.setTimeout(() => setFlashes(NO_FLASHES), FLASH_MS)
    return () => window.clearTimeout(timer)
  }, [database, joined, ready])
  return flashes
}

const NO_FLASHES: ReadonlyMap<string, 'created'> = new Map()

/**
 * The height of the grid's horizontal scrollbar, when a narrow window gives
 * it one: the frame is as tall as its rows, so without this the bar would
 * cover the last row. 0 where scrollbars overlay the content.
 */
function useScrollbarRoom(frame: RefObject<HTMLDivElement | null>): number {
  const [bar, setBar] = useState(0)
  useLayoutEffect(() => {
    const element = frame.current
    if (!element) return
    const measure = () => {
      const scroller = element.querySelector<HTMLElement>('.overflow-auto')
      setBar(scroller ? Math.max(0, scroller.offsetHeight - scroller.clientHeight) : 0)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [frame])
  return bar
}

const scopeWord = (scope: string) =>
  scope === 'collectionGroup' ? 'Collection group' : 'Collection'

const COMPOSITE_COLUMNS: DataTableColumn<Keyed<DeclaredIndex>>[] = [
  {
    id: 'collectionGroup',
    header: 'Collection',
    width: 180,
    pinned: true,
    cell: ({ row }) => <span className="font-mono">{row.collectionGroup}</span>,
    copy: ({ row }) => row.collectionGroup,
  },
  {
    id: 'fields',
    header: 'Fields',
    width: 340,
    cell: ({ row }) => (
      <span className="flex items-center gap-1.5 overflow-hidden" data-testid="composite-fields">
        <FieldChips fields={row.fields} />
      </span>
    ),
    copy: ({ row }) => describeFields(row.fields),
  },
  {
    id: 'scope',
    header: 'Query scope',
    width: 140,
    cell: ({ row }) => <span className="font-sans">{scopeWord(row.scope)}</span>,
    copy: ({ row }) => scopeWord(row.scope),
  },
]

const OVERRIDE_COLUMNS: DataTableColumn<Keyed<DeclaredFieldOverride>>[] = [
  {
    id: 'collectionGroup',
    header: 'Collection',
    width: 180,
    pinned: true,
    cell: ({ row }) => <span className="font-mono">{row.collectionGroup}</span>,
    copy: ({ row }) => row.collectionGroup,
  },
  {
    id: 'fieldPath',
    header: 'Field',
    width: 160,
    cell: ({ row }) => <span className="font-mono">{row.fieldPath}</span>,
    copy: ({ row }) => row.fieldPath,
  },
  {
    id: 'indexes',
    header: 'Indexes',
    width: 280,
    cell: ({ row }) =>
      row.indexes.length === 0 ? (
        <span className="font-sans text-kumo-subtle">Not indexed</span>
      ) : (
        <span className="flex items-center gap-1.5 overflow-hidden" data-testid="override-indexes">
          {row.indexes.map((index) => (
            <span
              key={`${index.scope}|${index.mode}|${index.dimension ?? ''}`}
              className="flex h-5 shrink-0 items-center rounded bg-kumo-tint px-1.5 font-mono text-[11px] text-kumo-default"
            >
              {modeWord(index)}
              {index.scope === 'collectionGroup' ? (
                <span className="pl-1 font-sans text-kumo-subtle">group</span>
              ) : null}
            </span>
          ))}
        </span>
      ),
    copy: ({ row }) => describeOverride(row),
  },
  {
    id: 'ttl',
    header: 'TTL',
    width: 64,
    cell: ({ row }) =>
      row.ttl ? <span className="font-sans">On</span> : <span className="text-kumo-subtle">—</span>,
    copy: ({ row }) => (row.ttl ? 'On' : ''),
  },
]
