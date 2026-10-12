// The listing as a table: the foundation's `DataTable`, 32 px rows, folders
// first, the check and name pinned. A file opens in the inspector on a
// click; a folder takes the cursor on a click and opens on Enter or a
// double click, and its name is a real link, so ⌘-click opens it in a new
// tab. Every figure is the engine's: a folder's size and last change are
// everything under it, from the folder index. The list draws type icons
// and never asks for a thumbnail.

import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import type { StorageAccessVerdict } from '@/api/generated/storage/StorageAccessVerdict'
import type { StorageEntry } from '@/api/generated/storage/StorageEntry'
import {
  type DataTableColumn,
  DataTable,
  useHiddenColumnCount,
} from '@/components/console/data-table'
import type { RowMenuItem } from '@/components/console/row-menu'
import { RelativeTime } from '@/components/console/relative-time'
import { TableFooter } from '@/components/console/table-footer'
import { formatBytes, formatNumber } from '@/lib/format'
import type { AccessMap } from '../access'
import { useFiles } from '../files-state'
import type { Listing } from '../listing'
import { gsUrl, relativeName, truncationParts } from '../paths'
import { entryKey } from '../queries'
import { sortOf } from '../search'
import { useFileSelection } from '../selection'
import { AccessCell } from './access-cell'
import { FileIcon, FolderGlyph } from './file-icon'

/** What a row of the table draws: the entry and what the page knows beside it. */
export interface FileRow {
  key: string
  entry: StorageEntry
  /** The name as this listing shows it: relative to the folder in a flat listing. */
  label: string
  /** The page acts as a client, so the rules apply to everything it shows. */
  client: boolean
  /** The identity's verdicts, while the page acts as a client; `undefined` until they arrive. */
  access: readonly StorageAccessVerdict[] | undefined
  /** The rules' text of a line, for the Access column's tooltip. */
  lineText: (line: number) => string | undefined
  /** Bytes sent so far, while this tab uploads the file (0–1). */
  progress?: number | undefined
}

/** Where dragged widths and hidden columns are remembered. */
export const FILES_MEMORY_KEY = 'storage.files'

export const FILE_NOUN = { one: 'entry', other: 'entries' } as const

/** The rows of a listing, with what the page knows beside each entry. */
export function fileRows(
  entries: readonly StorageEntry[],
  options: {
    prefix: string
    flat: boolean
    access: AccessMap | undefined
    lineText: (line: number) => string | undefined
    progress?: ReadonlyMap<string, number> | undefined
  },
): FileRow[] {
  return entries.map((entry) => {
    const key = entryKey(entry)
    const name = entry.type === 'folder' ? entry.prefix : entry.name
    return {
      key,
      entry,
      label: relativeName(name, options.prefix),
      client: options.access !== undefined,
      access: options.access?.get(key),
      lineText: options.lineText,
      progress: options.progress?.get(key),
    }
  })
}

/** A folder whose own name is empty (`a//`): its label is the slash alone. */
export function emptySegment(label: string): boolean {
  return label === '/' || label.endsWith('//')
}

/** May the identity read a row's bytes: always as Admin; once the check answers as a client. */
export function rowRead(row: FileRow): boolean | undefined {
  if (!row.client) return true
  const verdict = row.access?.find((candidate) => candidate.method === 'get')
  return verdict === undefined ? undefined : verdict.outcome === 'allow'
}

/** A name cut in the middle, keeping its end: the part that tells two files apart. */
export function MiddleName({ name, className }: { name: string; className?: string }) {
  const [head, tail] = truncationParts(name)
  return (
    <span className={`flex min-w-0 ${className ?? ''}`}>
      <span className="truncate">{head}</span>
      {tail && <span className="shrink-0">{tail}</span>}
    </span>
  )
}

function NameCell({ row }: { row: FileRow }) {
  const { entry } = row
  if (entry.type === 'folder')
    return (
      <span className="flex min-w-0 items-center gap-2">
        <FolderGlyph empty={entry.empty} />
        <Link
          from="/storage"
          to="/storage"
          search={(previous) => ({
            ...previous,
            path: entry.prefix,
            object: undefined,
            q: undefined,
            dialog: undefined,
          })}
          // A plain click moves the cursor (the row's job); a modified or
          // middle click is the browser's: a new tab at that folder.
          onClick={(event) => {
            if (!event.metaKey && !event.ctrlKey && !event.shiftKey && event.button === 0)
              event.preventDefault()
          }}
          className={`min-w-0 text-kumo-default ${entry.empty ? 'italic' : ''}`}
          draggable={false}
          tabIndex={-1}
          data-testid="folder-link"
        >
          {emptySegment(row.label) ? (
            <span className="font-sans italic">(empty)/</span>
          ) : (
            <MiddleName name={row.label} />
          )}
        </Link>
        {entry.empty && (
          <span className="shrink-0 font-sans text-[11px] text-kumo-subtle">empty</span>
        )}
      </span>
    )
  return (
    <span className="flex min-w-0 items-center gap-2">
      <FileIcon contentType={entry.contentType} name={entry.name} />
      <MiddleName name={row.label} />
    </span>
  )
}

function quiet(text: ReactNode) {
  return <span className="text-[11px] text-kumo-subtle">{text}</span>
}

/** The custom keys a file carries, as a container's preview: `{ ownerUid, +2 }`. */
export function metadataPreview(keys: readonly string[], count: number): string {
  if (count === 0) return ''
  const shown = keys.slice(0, 1)
  const rest = count - shown.length
  return `{ ${shown.join(', ')}${rest > 0 ? `${shown.length > 0 ? ', ' : ''}+${formatNumber(rest)}` : ''} }`
}

export function fileColumns(options: {
  bucket: string
  client: boolean
  sortable: readonly string[] | undefined
}): DataTableColumn<FileRow>[] {
  const sorts = (column: string) => options.sortable?.includes(column) ?? true
  const columns: DataTableColumn<FileRow>[] = [
    {
      id: 'name',
      header: 'Name',
      width: 300,
      minWidth: 160,
      pinned: true,
      sortable: sorts('name'),
      cell: (row) => <NameCell row={row} />,
      copy: (row) => gsUrl(options.bucket, row.key),
    },
    {
      id: 'size',
      header: 'Size',
      width: 96,
      align: 'end',
      sortable: sorts('size'),
      cell: (row) =>
        row.entry.type === 'folder'
          ? row.entry.bytes === null
            ? quiet('—')
            : quiet(formatBytes(row.entry.bytes))
          : quiet(formatBytes(row.entry.size)),
      copy: (row) => String(row.entry.type === 'folder' ? (row.entry.bytes ?? '') : row.entry.size),
    },
    {
      id: 'type',
      header: 'Type',
      width: 152,
      sortable: sorts('type'),
      cell: (row) =>
        row.entry.type === 'folder' ? quiet('folder') : quiet(row.entry.contentType ?? '—'),
      copy: (row) => (row.entry.type === 'folder' ? 'folder' : (row.entry.contentType ?? '')),
    },
    {
      id: 'updated',
      header: 'Last changed',
      width: 120,
      sortable: sorts('updated'),
      cell: (row) => {
        if (row.progress !== undefined)
          return (
            <span className="flex items-center gap-2" data-testid="row-uploading">
              <span className="h-1 w-16 overflow-hidden rounded-full bg-kumo-tint">
                <span
                  className="block h-full bg-kumo-brand"
                  style={{ width: `${Math.round(row.progress * 100)}%` }}
                />
              </span>
              <span className="font-sans text-[11px] text-kumo-subtle">Uploading…</span>
            </span>
          )
        const at = row.entry.type === 'folder' ? row.entry.changedAt : row.entry.updated
        return at ? <RelativeTime iso={at} className="text-kumo-default" /> : quiet('—')
      },
      copy: (row) => (row.entry.type === 'folder' ? row.entry.changedAt : row.entry.updated) ?? '',
    },
    {
      id: 'metadata',
      header: 'Metadata',
      width: 152,
      cell: (row) =>
        row.entry.type === 'file'
          ? quiet(metadataPreview(row.entry.metadataKeys, row.entry.metadataCount))
          : null,
      copy: (row) => (row.entry.type === 'file' ? row.entry.metadataKeys.join(', ') : ''),
    },
    {
      id: 'tokens',
      header: 'Tokens',
      width: 64,
      align: 'end',
      cell: (row) =>
        row.entry.type === 'file' ? quiet(formatNumber(row.entry.tokens)) : quiet('—'),
      copy: (row) => (row.entry.type === 'file' ? String(row.entry.tokens) : ''),
    },
  ]
  if (options.client)
    columns.push({
      id: 'access',
      header: 'Access',
      width: 168,
      cell: (row) =>
        row.entry.type === 'file' ? (
          <AccessCell verdicts={row.access} lineText={row.lineText} />
        ) : null,
    })
  return columns
}

export function FileList({
  listing,
  rows,
  sortable,
  menu,
  onOpen,
  onCursor,
  empty,
}: {
  listing: Listing
  rows: readonly FileRow[]
  sortable: readonly string[] | undefined
  menu: (row: FileRow) => readonly RowMenuItem[]
  onOpen: (entry: StorageEntry) => void
  onCursor: (entry: StorageEntry) => void
  empty: ReactNode
}) {
  const files = useFiles()
  const checked = useFileSelection((state) => state.checked)
  const everything = useFileSelection((state) => state.everything)
  const setSelection = useFileSelection((state) => state.set)
  const columns = fileColumns({ bucket: files.bucket, client: !files.admin, sortable })
  const hidden = useHiddenColumnCount(FILES_MEMORY_KEY, columns)
  const sort = sortOf(files.sort)
  const { rows: window } = listing
  return (
    <DataTable<FileRow>
      ariaLabel={
        files.flat ? `Every file under ${files.prefix || files.bucket}` : 'Files and folders'
      }
      rows={rows}
      rowKey={(row) => row.key}
      columns={columns}
      memoryKey={FILES_MEMORY_KEY}
      sort={sort}
      onSortChange={(next) =>
        files.update(
          { sort: next ? `${next.column}:${next.direction}` : undefined },
          { replace: true },
        )
      }
      selection={{
        checked,
        everything,
        onChange: (next, all) => setSelection(next, all),
      }}
      openKey={files.object}
      onOpen={(row) => onOpen(row.entry)}
      rowClick={(row) => (row.entry.type === 'folder' ? 'cursor' : 'open')}
      onRowDoubleClick={(row) => {
        if (row.entry.type === 'folder') onOpen(row.entry)
      }}
      onCursorChange={(row) => onCursor(row.entry)}
      flashes={window.flashes}
      hasMore={window.hasMore}
      loadMore={window.loadMore}
      hasPrevious={window.hasPrevious}
      loadPrevious={window.loadPrevious}
      rowMenu={menu}
      rowOffset={window.rowOffset}
      total={window.total}
      loading={listing.pending}
      empty={empty}
      footer={
        <TableFooter
          loaded={rows.length}
          rowOffset={window.rowOffset}
          total={window.total}
          hasMore={window.hasMore}
          hiddenColumns={hidden.hidden}
          onShowAll={hidden.showAll}
          noun={FILE_NOUN}
        />
      }
      testId="file-list"
    />
  )
}
