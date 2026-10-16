// One tile of the grid, its own memoized component: the grid re-renders on
// every frame of a scroll, and a tile that has not changed has no business
// re-rendering with it. Everything it is given is a value it shows or a ref
// it calls through (the `GridRow` rule).

import { Checkbox, cn } from '@cloudflare/kumo'
import { DotsThreeIcon } from '@phosphor-icons/react'
import { Link } from '@tanstack/react-router'
import { type RefObject, memo } from 'react'
import { formatBytes, formatNumber, relativeTime } from '@/lib/format'
import { FolderGlyph } from './file-icon'
import { type FileRow, MiddleName, rowRead } from './file-list'
import { Thumbnail } from './thumbnail'

/** What a tile asks of its grid, through a ref. */
export interface TileActions {
  click: (row: FileRow, index: number) => void
  doubleClick: (row: FileRow) => void
  check: (key: string, checked: boolean, shift: boolean) => void
  menu: (key: string, anchor: Element | { x: number; y: number }) => void
}

function FileTileView({
  row,
  index,
  bucket,
  checked,
  cursor,
  open,
  flash,
  now,
  actions,
}: {
  row: FileRow
  index: number
  bucket: string
  checked: boolean
  cursor: boolean
  open: boolean
  flash: 'created' | 'updated' | 'deleted' | undefined
  /** The clock for the tile's age, to the minute. */
  now: number
  actions: RefObject<TileActions | null>
}) {
  const { entry } = row
  const read = rowRead(row)
  const refusing = row.access?.find((verdict) => verdict.method === 'get')
  return (
    <div
      role="gridcell"
      aria-selected={checked}
      aria-label={row.label}
      data-key={row.key}
      data-testid="file-tile"
      data-cursor={cursor ? '' : undefined}
      className={cn(
        'group/tile relative flex h-full cursor-default flex-col overflow-hidden rounded-lg bg-kumo-base ring hover:ink',
        checked ? 'ring-kumo-brand' : 'ring-kumo-line',
        (cursor || open) && 'shadow-[inset_0_0_0_1.5px_var(--color-kumo-brand)]',
        flash &&
          '[background-image:linear-gradient(var(--row-flash),var(--row-flash))] animate-[row-flash_1.6s_ease-out]',
      )}
      onClick={() => actions.current?.click(row, index)}
      onDoubleClick={() => actions.current?.doubleClick(row)}
      onContextMenu={(event) => {
        event.preventDefault()
        actions.current?.menu(row.key, { x: event.clientX, y: event.clientY })
      }}
    >
      <div className="relative aspect-[4/3] w-full shrink-0 overflow-hidden border-b border-kumo-line">
        {entry.type === 'folder' ? (
          <span className="flex h-full w-full items-center justify-center bg-kumo-tint">
            <FolderGlyph empty={entry.empty} size={40} />
          </span>
        ) : (
          <Thumbnail
            bucket={bucket}
            file={entry}
            order={index}
            read={read}
            refusingLine={refusing?.line}
          />
        )}
        <span
          className={cn(
            'absolute top-1.5 left-1.5 rounded-md bg-kumo-base/85 p-1',
            checked
              ? 'opacity-100'
              : 'opacity-0 group-hover/tile:opacity-100 focus-within:opacity-100',
          )}
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          <Checkbox
            checked={checked}
            onCheckedChange={(next, details) =>
              actions.current?.check(
                row.key,
                next,
                (details?.event as MouseEvent | undefined)?.shiftKey === true,
              )
            }
            aria-label={`Select ${row.label}`}
          />
        </span>
        <button
          type="button"
          className={cn(
            'absolute top-1.5 right-1.5 flex size-6 items-center justify-center rounded-md bg-kumo-base/85 text-kumo-subtle hover:ink hover:text-kumo-default focus-visible:opacity-100',
            cursor ? 'opacity-100' : 'opacity-0 group-hover/tile:opacity-100',
          )}
          aria-label={`Actions for ${row.label}`}
          aria-haspopup="menu"
          tabIndex={-1}
          onClick={(event) => {
            event.stopPropagation()
            actions.current?.menu(row.key, event.currentTarget)
          }}
          data-row-menu=""
          data-testid="tile-menu-button"
        >
          <DotsThreeIcon weight="bold" size={14} />
        </button>
      </div>
      <div className="grid min-w-0 gap-0.5 px-2 py-1.5">
        {entry.type === 'folder' ? (
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
            onClick={(event) => {
              if (!event.metaKey && !event.ctrlKey && !event.shiftKey && event.button === 0)
                event.preventDefault()
            }}
            draggable={false}
            tabIndex={-1}
            className={cn(
              'min-w-0 font-mono text-[12px] text-kumo-default',
              entry.empty && 'italic',
            )}
          >
            <MiddleName name={row.label || '(empty)'} />
          </Link>
        ) : (
          <MiddleName name={row.label} className="font-mono text-[12px] text-kumo-default" />
        )}
        <span className="truncate text-[11px] text-kumo-subtle">
          {entry.type === 'folder'
            ? entry.empty
              ? 'empty'
              : entry.objects === null
                ? 'counting…'
                : `${formatNumber(entry.objects)} ${entry.objects === 1 ? 'file' : 'files'}`
            : `${formatBytes(entry.size)} · ${relativeTime(entry.updated, now)}`}
        </span>
      </div>
    </div>
  )
}

export const FileTile = memo(FileTileView)
