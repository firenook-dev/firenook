// The listing as a grid of tiles, for image-heavy folders: as many columns
// of at least 176 px as the width allows, virtualized by rows of tiles, the
// same sliding window of pages as the list (the next page while the last
// rows are still ahead, the one above once the window has let it go, the
// tile under the reader kept where it is when rows come or go above it).
// The keyboard is the list's in two dimensions: arrows, Home, End, PgUp,
// PgDn, Enter opens, Space ticks, ⌘A ticks what is loaded, Shift+F10 opens
// the cursor tile's menu.

import { useVirtualizer } from '@tanstack/react-virtual'
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { StorageEntry } from '@/api/generated/storage/StorageEntry'
import { rangeKeys } from '@/components/console/data-table'
import { useDelayedFlag } from '@/components/console/empty-state'
import {
  type RowMenuAnchor,
  type RowMenuItem,
  RowMenuPopup,
  useRowMenuPalette,
} from '@/components/console/row-menu'
import { TableFooter } from '@/components/console/table-footer'
import { useNow } from '@/lib/clock'
import { useShortcuts } from '@/lib/shortcuts'
import { useFiles } from '../files-state'
import type { Listing } from '../listing'
import { usePictureDemand } from '../net'
import { useFileSelection } from '../selection'
import { FILE_NOUN, type FileRow } from './file-list'
import { FileTile, type TileActions } from './file-tile'

/** The smallest a tile is; columns are as many as fit. */
const TILE_MIN = 176
/** The gap between tiles and the inset around them (`gap-2`, `p-3`). */
const GAP = 8
const INSET = 12
/** The name and figures under a tile's picture. */
const CAPTION = 46
/** Rows of tiles from either end of the window at which the next page is asked for. */
const LOAD_AHEAD = 3

/** Columns and tile size for a width. */
export function gridGeometry(width: number): { columns: number; tile: number; row: number } {
  const room = Math.max(TILE_MIN, width - INSET * 2)
  const columns = Math.max(1, Math.floor((room + GAP) / (TILE_MIN + GAP)))
  const tile = (room - GAP * (columns - 1)) / columns
  // A 4:3 picture, its border and the caption.
  const row = Math.round((tile * 3) / 4) + 1 + CAPTION + GAP
  return { columns, tile, row }
}

export function FileGrid({
  listing,
  rows,
  menu,
  onOpen,
  onCursor,
  empty,
}: {
  listing: Listing
  rows: readonly FileRow[]
  menu: (row: FileRow) => readonly RowMenuItem[]
  onOpen: (entry: StorageEntry) => void
  onCursor: (entry: StorageEntry) => void
  empty: ReactNode
}) {
  'use no memo' // the virtualizer hands out functions the compiler cannot memoize safely
  const files = useFiles()
  usePictureDemand(true)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const element = scrollRef.current
    if (!element) return undefined
    setWidth(element.clientWidth)
    const observer = new ResizeObserver(() => setWidth(element.clientWidth))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const geometry = gridGeometry(width)
  const { columns } = geometry
  const lines = Math.ceil(rows.length / columns)

  const checked = useFileSelection((state) => state.checked)
  const everything = useFileSelection((state) => state.everything)
  const setSelection = useFileSelection((state) => state.set)
  const [cursor, setCursor] = useState<string | undefined>(files.object)
  const [menuAt, setMenuAt] = useState<{ key: string; anchor: RowMenuAnchor } | null>(null)
  const shiftAnchor = useRef<string | undefined>(undefined)
  const now = useNow('minute')
  const window_ = listing.rows

  // The open object is the cursor tile: the inspector's own steps move it.
  const [seenOpen, setSeenOpen] = useState(files.object)
  if (files.object !== seenOpen) {
    setSeenOpen(files.object)
    if (files.object !== undefined) setCursor(files.object)
  }

  const keys = rows.map((row) => row.key)
  const cursorIndex = cursor === undefined ? -1 : keys.indexOf(cursor)

  // oxlint-disable-next-line react/incompatible-library -- the directive above opts this component out of the compiler
  const virtualizer = useVirtualizer({
    count: lines,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => geometry.row,
    overscan: 2,
    paddingStart: INSET,
    paddingEnd: INSET,
  })
  useLayoutEffect(() => {
    virtualizer.measure()
  }, [geometry.row, virtualizer])
  const items = virtualizer.getVirtualItems()
  const firstLine = items[0]?.index ?? 0
  const lastLine = items.at(-1)?.index ?? -1

  useEffect(() => {
    if (rows.length > 0 && window_.hasMore && lastLine >= lines - LOAD_AHEAD) window_.loadMore()
  }, [lastLine, lines, rows.length, window_])
  useEffect(() => {
    if (rows.length > 0 && window_.hasPrevious && firstLine <= LOAD_AHEAD) window_.loadPrevious()
  }, [firstLine, rows.length, window_])

  // The tile at the top of the view, by key, stays where it is when the
  // window slides or rows come and go above it.
  const anchor = useRef<{ key: string; delta: number } | null>(null)
  const previousRows = useRef(rows)
  const recordAnchor = () => {
    const element = scrollRef.current
    if (!element) return
    const top = Math.max(0, element.scrollTop - INSET)
    const line = Math.floor(top / geometry.row)
    const key = keys[line * columns]
    anchor.current =
      element.scrollTop > 0 && key !== undefined ? { key, delta: top - line * geometry.row } : null
  }
  useLayoutEffect(() => {
    if (previousRows.current === rows) return
    previousRows.current = rows
    const element = scrollRef.current
    const held = anchor.current
    if (!element || !held) return
    const index = keys.indexOf(held.key)
    if (index === -1) return
    const target = INSET + Math.floor(index / columns) * geometry.row + held.delta
    if (Math.abs(element.scrollTop - target) >= 1) element.scrollTop = target
  })

  const reveal = (index: number) => {
    const element = scrollRef.current
    if (!element) return
    const top = INSET + Math.floor(index / columns) * geometry.row
    const bottom = top + geometry.row
    if (top < element.scrollTop) element.scrollTop = top - INSET
    else if (bottom > element.scrollTop + element.clientHeight)
      element.scrollTop = bottom - element.clientHeight
  }
  const moveTo = (index: number) => {
    const row = rows[Math.max(0, Math.min(rows.length - 1, index))]
    if (!row) return
    setCursor(row.key)
    reveal(rows.indexOf(row))
    onCursor(row.entry)
  }
  const toggle = (key: string, next: boolean, shift: boolean) => {
    const set = new Set(everything ? keys : checked)
    const range = shift ? rangeKeys(keys, shiftAnchor.current, key) : [key]
    for (const one of range) {
      if (next) set.add(one)
      else set.delete(one)
    }
    shiftAnchor.current = key
    setSelection(set, everything && next)
  }
  const openMenu = (key: string, at?: RowMenuAnchor) => {
    if (at) {
      setMenuAt({ key, anchor: at })
      return
    }
    reveal(keys.indexOf(key))
    requestAnimationFrame(() => {
      const tile = scrollRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)
      const button = tile?.querySelector<HTMLElement>('[data-row-menu]')
      if (button ?? tile) setMenuAt({ key, anchor: (button ?? tile) as Element })
    })
  }

  const actions = useRef<TileActions | null>(null)
  useLayoutEffect(() => {
    actions.current = {
      click: (row) => {
        setCursor(row.key)
        onCursor(row.entry)
        if (row.entry.type === 'file') onOpen(row.entry)
      },
      doubleClick: (row) => {
        if (row.entry.type === 'folder') onOpen(row.entry)
      },
      check: toggle,
      menu: (key, at) => {
        setCursor(key)
        openMenu(key, at)
      },
    }
  })

  const cursorRow = cursorIndex === -1 ? undefined : rows[cursorIndex]
  const cursorItems = cursorRow ? menu(cursorRow) : undefined
  useRowMenuPalette(cursorItems, cursorRow?.label)
  const page = () => {
    const height = scrollRef.current?.clientHeight ?? geometry.row
    return Math.max(1, Math.floor(height / geometry.row)) * columns
  }
  const loaded = () => rows.length > 0
  const onTile = () => cursorRow !== undefined
  const step = (by: number) => moveTo(cursorIndex === -1 ? 0 : cursorIndex + by)
  useShortcuts({ id: 'storage-grid', label: 'Grid' }, [
    {
      key: 'ArrowLeft',
      label: 'Move between tiles',
      group: 'Grid',
      when: loaded,
      run: () => step(-1),
    },
    {
      key: 'ArrowRight',
      label: 'Move between tiles',
      group: 'Grid',
      when: loaded,
      run: () => step(1),
    },
    {
      key: 'ArrowUp',
      label: 'Move between tiles',
      group: 'Grid',
      when: loaded,
      run: () => step(-columns),
    },
    {
      key: 'ArrowDown',
      label: 'Move between tiles',
      group: 'Grid',
      when: loaded,
      run: () => step(columns),
    },
    { key: 'Home', label: 'First loaded tile', group: 'Grid', when: loaded, run: () => moveTo(0) },
    {
      key: 'End',
      label: 'Last loaded tile',
      group: 'Grid',
      when: loaded,
      run: () => {
        moveTo(rows.length - 1)
        window_.loadMore()
      },
    },
    {
      key: 'PageUp',
      label: 'One screen up',
      group: 'Grid',
      when: loaded,
      run: () => step(-page()),
    },
    {
      key: 'PageDown',
      label: 'One screen down',
      group: 'Grid',
      when: loaded,
      run: () => step(page()),
    },
    {
      key: 'Enter',
      label: 'Open the tile',
      group: 'Grid',
      when: onTile,
      run: () => {
        if (cursorRow) onOpen(cursorRow.entry)
      },
    },
    {
      key: 'Space',
      label: 'Tick the tile',
      group: 'Grid',
      when: onTile,
      run: () => {
        if (cursorRow) toggle(cursorRow.key, !(everything || checked.has(cursorRow.key)), false)
      },
    },
    {
      key: 'Mod+a',
      label: 'Tick every loaded tile',
      group: 'Grid',
      when: loaded,
      run: () => setSelection(new Set(keys), false),
    },
    {
      key: 'Shift+F10',
      label: 'The tile’s menu',
      group: 'Grid',
      when: onTile,
      run: () => {
        if (cursorRow) openMenu(cursorRow.key)
      },
    },
    {
      key: 'ContextMenu',
      label: 'The tile’s menu',
      group: 'Grid',
      when: onTile,
      run: () => {
        if (cursorRow) openMenu(cursorRow.key)
      },
    },
  ])

  const skeleton = useDelayedFlag(listing.pending)
  if (rows.length === 0 && !listing.pending) return <>{empty}</>
  const menuRow = menuAt ? rows[keys.indexOf(menuAt.key)] : undefined
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-kumo-base" data-testid="file-grid">
      <div
        ref={scrollRef}
        role="grid"
        aria-label={
          files.flat ? `Every file under ${files.prefix || files.bucket}` : 'Files and folders'
        }
        aria-multiselectable
        aria-busy={listing.pending || undefined}
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden select-none"
        onScroll={recordAnchor}
        data-testid="file-grid-scroll"
      >
        {rows.length === 0 && skeleton ? (
          <div
            className="grid gap-2 p-3"
            style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
            aria-hidden
          >
            {Array.from({ length: columns * 2 }, (_, place) => (
              <div
                // Placeholders have no identity of their own: their place is their name.
                // oxlint-disable-next-line react/no-array-index-key
                key={place}
                className="aspect-[4/3] animate-pulse rounded-lg bg-kumo-tint"
              />
            ))}
          </div>
        ) : (
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {items.map((item) => {
              const start = item.index * columns
              const line = rows.slice(start, start + columns)
              return (
                <div
                  key={item.key}
                  role="row"
                  className="absolute inset-x-0 grid gap-2 px-3"
                  style={{
                    transform: `translateY(${item.start}px)`,
                    height: geometry.row - GAP,
                    gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                  }}
                >
                  {line.map((row, offset) => (
                    <FileTile
                      key={row.key}
                      row={row}
                      index={start + offset}
                      bucket={files.bucket}
                      checked={everything || checked.has(row.key)}
                      cursor={cursor === row.key}
                      open={files.object === row.key}
                      flash={window_.flashes.get(row.key)}
                      now={now}
                      actions={actions}
                    />
                  ))}
                </div>
              )
            })}
          </div>
        )}
      </div>
      <TableFooter
        loaded={rows.length}
        rowOffset={window_.rowOffset}
        total={window_.total}
        hasMore={window_.hasMore}
        noun={FILE_NOUN}
      />
      <RowMenuPopup
        items={menuRow ? menu(menuRow) : []}
        open={menuAt !== null}
        onOpenChange={(open) => {
          if (!open) setMenuAt(null)
        }}
        anchor={menuAt?.anchor ?? null}
      />
    </div>
  )
}
