// The table every entity list uses — users, objects, tasks, messages,
// subscriptions, instances — built on the Firestore grid's measured anatomy:
// 32 px rows, a sticky compact header, the 64 px check cell with the open
// button, pinned columns with their edge, the cursor row's accent bar and
// cursor cell, dragged widths remembered per list, live rows flashing.
//
// Virtualized: only the rows on screen are in the DOM, with a spacer above
// and below. The engine sorts and pages; the table asks for the next page
// while the last twenty rows are still ahead and for the previous one when
// the window has let its first pages go, and keeps the row the reader is
// looking at where it is when rows come or go above it.
//
// Accessible as a grid: `aria-rowcount` is the whole list when known,
// `aria-rowindex` is each row's place in it (header = 1), so a virtualized
// row is announced where it is, not where it sits in the DOM; the cursor
// cell is the grid's `aria-activedescendant`. The keys are the console's
// table keys (foundation §4.10), registered with the page's other keys so
// the shortcuts dialog lists them.

import { Button, DropdownMenu, Table, cn } from '@cloudflare/kumo'
import {
  ArrowUpIcon,
  CaretDownIcon,
  CaretUpDownIcon,
  CaretUpIcon,
  SlidersHorizontalIcon,
} from '@phosphor-icons/react'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import type { Total } from '@/api/generated/Total'
import { MenuCheck } from '@/components/kit'
import { formatNumber } from '@/lib/format'
import { type Shortcut, isTyping, matchesKey, useShortcuts } from '@/lib/shortcuts'
import { toast } from '@/lib/toasts'
import { ColumnResizer } from './column-resizer'
import { COLUMN_MIN, isColumnHidden, useColumnWidths, useHiddenColumns } from './column-widths'
import { DataTableRow, type PlacedColumn, type RowActions, cellId } from './data-table-row'
import { TableSkeleton } from './empty-state'
import { type RowMenuAnchor, type RowMenuItem, RowMenuPopup, useRowMenuPalette } from './row-menu'
import { CHECK_WIDTH, PIN_EDGE, PIN_HEAD, ROW_HEIGHT } from './table-pins'

export interface DataTableColumn<Row> {
  /** Sort key sent to the engine; width memory key. */
  id: string
  /** Data names lowercase (`uid`, set in the data face), English in sentence case (`Last sign-in`). */
  header: string
  width: number
  /** Default 64. */
  minWidth?: number | undefined
  /** Numbers end, in tabular figures. */
  align?: 'start' | 'end' | undefined
  /** Only for a column in the list's `ListMeta.sortable` (an index backs it); the arrow is hidden otherwise. */
  sortable?: boolean | undefined
  /** Sticky after the check column. */
  pinned?: boolean | undefined
  /** Values in the data face, 12 px. */
  cell: (row: Row) => ReactNode
  /** What ⌘C copies from this cell; absent = the row's key. */
  copy?: ((row: Row) => string) | undefined
  hiddenByDefault?: boolean | undefined
}

export interface DataTableSort {
  column: string
  direction: 'asc' | 'desc'
}

export interface DataTableProps<Row> {
  ariaLabel: string
  rows: readonly Row[]
  rowKey: (row: Row) => string
  columns: readonly DataTableColumn<Row>[]
  /** Where dragged widths and hidden columns are remembered (localStorage), e.g. 'auth.users'. */
  memoryKey: string
  sort?: DataTableSort | undefined
  onSortChange?: ((sort: DataTableSort | undefined) => void) | undefined
  /** The check column; omit for a table without selection. */
  selection?:
    | {
        checked: ReadonlySet<string>
        everything: boolean
        onChange: (checked: Set<string>, everything: boolean) => void
      }
    | undefined
  /** The row in the inspector: its open button is pressed and it carries the accent bar. */
  openKey?: string | undefined
  onOpen?: ((row: Row) => void) | undefined
  /**
   * 'open' (entity lists): a row click opens it. 'cursor' (editable grids): a
   * click only moves the cell cursor. Per row when a function (Storage: files
   * open, folders move the cursor). Default 'open' when `onOpen` is given.
   */
  rowClick?: 'open' | 'cursor' | ((row: Row) => 'open' | 'cursor') | undefined
  /** A double click (Storage folders open on it, as on Enter). */
  onRowDoubleClick?: ((row: Row) => void) | undefined
  /** Rows the live channel just touched. */
  flashes?: ReadonlyMap<string, 'created' | 'updated' | 'deleted'> | undefined
  hasMore?: boolean | undefined
  loadMore?: (() => void) | undefined
  /** The window has let its first pages go: the page above, read when the first rows come into view. */
  hasPrevious?: boolean | undefined
  loadPrevious?: (() => void) | undefined
  /** 'page' (default): the arrows work whenever focus is not in a field. 'focus': only inside the table. */
  keyboard?: 'page' | 'focus' | undefined
  /** The cursor row moved (keys, click): an open inspector follows it. */
  onCursorChange?: ((row: Row) => void) | undefined
  /** 'key' (entity lists, default): rows inserted above the viewport do not move what is on screen. */
  anchor?: 'key' | 'none' | undefined
  /**
   * Rows created above the viewport since the reader scrolled away from the
   * top, when the page counts them itself (an append-only list refetching
   * its head). Without it the table counts the rows it anchored past.
   */
  newAbove?: number | undefined
  onShowNew?: (() => void) | undefined
  /** One item list for the right-click menu, Shift+F10 and the row's ⋯ button. */
  rowMenu?: ((row: Row) => readonly RowMenuItem[]) | undefined
  /** Rows before the first loaded one (the window's offset), for `aria-rowindex`. */
  rowOffset?: number | undefined
  total?: Total | undefined
  /** The first page is on its way: the header over skeleton rows (after 150 ms). */
  loading?: boolean | undefined
  /** EmptyState / NoMatch, shown when there are no rows and nothing is loading. */
  empty: ReactNode
  /** TableFooter. */
  footer?: ReactNode
  testId?: string | undefined
}

/** The width of the trailing column: the columns menu in the header, the row's ⋯ below it. */
const TOOLS_WIDTH = 40
/** The lead cell when a table opens rows but has no check column: just the open button. */
const OPEN_ONLY_WIDTH = 44
/** Rows from either end of the window at which the next page is asked for. */
const LOAD_AHEAD = 20

/**
 * How many of a table's columns are hidden, and the way to show them all:
 * what its `TableFooter` says ("2 hidden columns · show all").
 */
export function useHiddenColumnCount<Row>(
  memoryKey: string,
  columns: readonly DataTableColumn<Row>[],
): { hidden: number; showAll: () => void } {
  const choices = useHiddenColumns((state) => state.choices[memoryKey])
  const showAll = useHiddenColumns((state) => state.showAll)
  return {
    hidden: columns.filter((column) => isColumnHidden(choices, column)).length,
    showAll: () =>
      showAll(
        memoryKey,
        columns.map((column) => column.id),
      ),
  }
}

/** A header that is a data name (`uid`, `__name__`) is data, set in the data face. */
export function isDataName(header: string): boolean {
  return /^[a-z_][a-z0-9_.]*$/.test(header)
}

/** The next sort a header click asks for: ascending, then descending, then the list's own order. */
export function nextSort(
  current: DataTableSort | undefined,
  column: string,
): DataTableSort | undefined {
  if (current?.column !== column) return { column, direction: 'asc' }
  if (current.direction === 'asc') return { column, direction: 'desc' }
  return undefined
}

/** `aria-rowcount`: the whole list plus the header when known, else -1. */
export function ariaRowCount(options: {
  total: Total | undefined
  loaded: number
  rowOffset: number
  hasMore: boolean
  hasPrevious: boolean
}): number {
  if (options.total?.exact) return options.total.count + 1
  if (!options.hasMore && !options.hasPrevious) return options.rowOffset + options.loaded + 1
  return -1
}

/** The keys between the last ticked row and this one, inclusive: a shift-click's range. */
export function rangeKeys(keys: readonly string[], from: string | undefined, to: string): string[] {
  const end = keys.indexOf(to)
  const start = from === undefined ? -1 : keys.indexOf(from)
  if (start === -1 || end === -1) return [to]
  const [low, high] = start < end ? [start, end] : [end, start]
  return keys.slice(low, high + 1)
}

export function DataTable<Row>({
  ariaLabel,
  rows,
  rowKey,
  columns,
  memoryKey,
  sort,
  onSortChange,
  selection,
  openKey,
  onOpen,
  rowClick,
  onRowDoubleClick,
  flashes,
  hasMore = false,
  loadMore,
  hasPrevious = false,
  loadPrevious,
  keyboard = 'page',
  onCursorChange,
  anchor = 'key',
  newAbove,
  onShowNew,
  rowMenu,
  rowOffset = 0,
  total,
  loading = false,
  empty,
  footer,
  testId,
}: DataTableProps<Row>) {
  'use no memo' // the virtualizer hands out functions the compiler cannot memoize safely
  const idBase = useId().replaceAll(':', '')
  const scrollRef = useRef<HTMLDivElement>(null)
  const headRef = useRef<HTMLTableSectionElement>(null)
  const [scrolledX, setScrolledX] = useState(false)
  const [cursor, setCursor] = useState<{ key: string; column: string | undefined } | undefined>()
  const [menu, setMenu] = useState<{ key: string; anchor: RowMenuAnchor } | null>(null)
  const [resizing, setResizing] = useState<{ column: string; width: number } | null>(null)
  const [counted, setCounted] = useState(0)
  const [atTop, setAtTop] = useState(true)
  const shiftAnchor = useRef<string | undefined>(undefined)

  // The open row is the cursor row: the inspector's own previous / next
  // move it, and the table follows (derived during render, no effect).
  const [seenOpen, setSeenOpen] = useState(openKey)
  if (openKey !== seenOpen) {
    setSeenOpen(openKey)
    if (openKey !== undefined && openKey !== cursor?.key)
      setCursor({ key: openKey, column: cursor?.column })
  }

  // Columns: hidden ones out, pinned ones first, widths settled.
  const choices = useHiddenColumns((state) => state.choices[memoryKey])
  const setHidden = useHiddenColumns((state) => state.setHidden)
  const showAll = useHiddenColumns((state) => state.showAll)
  const dragged = useColumnWidths((state) => state.widths[memoryKey])
  const keepWidth = useColumnWidths((state) => state.set)
  const forgetWidth = useColumnWidths((state) => state.reset)
  const forgetWidths = useColumnWidths((state) => state.resetAll)
  const check = selection !== undefined
  const openable = onOpen !== undefined
  const lead = check ? CHECK_WIDTH : openable ? OPEN_ONLY_WIDTH : 0
  const shown = columns.filter((column) => !isColumnHidden(choices, column))
  const ordered = [...shown.filter((column) => column.pinned), ...shown.filter((c) => !c.pinned)]
  const lastPinned = ordered.findLastIndex((column) => column.pinned)
  const widthOf = (column: DataTableColumn<Row>) =>
    resizing?.column === column.id ? resizing.width : (dragged?.[column.id] ?? column.width)
  let left = lead
  const placed: PlacedColumn<Row>[] = ordered.map((column, index) => {
    const width = widthOf(column)
    const at = column.pinned ? left : undefined
    if (column.pinned) left += width
    return {
      id: column.id,
      header: column.header,
      width,
      align: column.align ?? 'start',
      cell: column.cell,
      left: at,
      edge: index === lastPinned,
    }
  })
  // One array for every row while nothing about the columns changed, so the
  // memoized rows skip a scroll frame.
  const placedKey = placed.map((column) => `${column.id}:${column.width}:${column.left}`).join('|')
  const placedRef = useRef<{ key: string; columns: PlacedColumn<Row>[] }>({ key: '', columns: [] })
  if (placedRef.current.key !== placedKey || placedRef.current.columns.length !== placed.length)
    placedRef.current = { key: placedKey, columns: placed }
  const rowColumns = placedRef.current.columns
  const dataWidth = placed.reduce((sum, column) => sum + column.width, 0)

  // The rows' keys, worked out once per set of rows rather than per scroll frame.
  const keyCache = useRef<{ rows: readonly Row[]; keys: string[] } | null>(null)
  if (keyCache.current?.rows !== rows) keyCache.current = { rows, keys: rows.map(rowKey) }
  const keys = keyCache.current.keys
  const cursorIndex = cursor === undefined ? -1 : keys.indexOf(cursor.key)

  // oxlint-disable-next-line react/incompatible-library -- the directive above opts this component out of the compiler
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    getItemKey: (index) => keys[index] ?? index,
    overscan: 12,
  })
  const items = virtualizer.getVirtualItems()
  const firstVisible = items[0]?.index ?? 0
  const lastVisible = items.at(-1)?.index ?? -1

  // The next page while the last rows are still ahead; the page above once
  // the window has let its first pages go and the first rows come into view.
  useEffect(() => {
    if (rows.length > 0 && hasMore && lastVisible >= rows.length - LOAD_AHEAD) loadMore?.()
  }, [lastVisible, rows.length, hasMore, loadMore])
  useEffect(() => {
    if (rows.length > 0 && hasPrevious && firstVisible <= LOAD_AHEAD) loadPrevious?.()
  }, [firstVisible, rows.length, hasPrevious, loadPrevious])

  // The row at the top of the view, by key, and how far into it the view
  // starts: rows that come or go above it leave it where it is.
  const anchorRow = useRef<{ key: string; delta: number } | null>(null)
  const previous = useRef<{ rows: readonly Row[]; keys: readonly string[]; offset: number }>({
    rows,
    keys,
    offset: rowOffset,
  })
  const recordAnchor = () => {
    const element = scrollRef.current
    if (!element) return
    const top = element.scrollTop
    const index = Math.floor(top / ROW_HEIGHT)
    const key = keys[index]
    anchorRow.current =
      top > 0 && key !== undefined ? { key, delta: top - index * ROW_HEIGHT } : null
  }
  useLayoutEffect(() => {
    const before = previous.current
    if (before.rows === rows) return
    previous.current = { rows, keys, offset: rowOffset }
    const element = scrollRef.current
    const held = anchorRow.current
    if (!element || !held) return
    const slid = before.offset !== rowOffset
    // Without key anchoring only a sliding window is corrected: a dropped
    // page must not throw the reader two thousand rows away.
    if (anchor === 'none' && !slid) return
    const index = keys.indexOf(held.key)
    if (index === -1) return
    const target = index * ROW_HEIGHT + held.delta
    if (Math.abs(element.scrollTop - target) < 1) return
    if (anchor === 'key' && !slid) {
      const was = before.keys.indexOf(held.key)
      if (was !== -1 && index > was) setCounted((count) => count + index - was)
    }
    element.scrollTop = target
  }, [rows, keys, rowOffset, anchor])

  const headHeight = () => headRef.current?.offsetHeight ?? 33
  /** Scrolls a row fully into view below the sticky header. */
  const revealRow = (index: number) => {
    const element = scrollRef.current
    if (!element) return
    const head = headHeight()
    const top = head + index * ROW_HEIGHT
    const bottom = top + ROW_HEIGHT
    if (top < element.scrollTop + head) element.scrollTop = Math.max(0, top - head)
    else if (bottom > element.scrollTop + element.clientHeight)
      element.scrollTop = bottom - element.clientHeight
  }
  /** Scrolls a column fully into view beside the pinned ones. */
  const revealColumn = (id: string | undefined) => {
    const element = scrollRef.current
    if (!element || id === undefined) return
    let start = lead
    for (const column of placed) {
      if (column.id === id) {
        if (column.left !== undefined) return
        const pinnedWidth = left
        const end = start + column.width
        if (start < element.scrollLeft + pinnedWidth) element.scrollLeft = start - pinnedWidth
        else if (end > element.scrollLeft + element.clientWidth - TOOLS_WIDTH)
          element.scrollLeft = end - element.clientWidth + TOOLS_WIDTH
        return
      }
      start += column.width
    }
  }

  /** The cursor to row `index`; `cell` moves it along the row too (`{ column: undefined }` is the row itself). */
  const moveTo = (index: number, cell?: { column: string | undefined }) => {
    const row = rows[index]
    if (!row) return
    const key = rowKey(row)
    const column = cell ? cell.column : cursor?.column
    setCursor({ key, column })
    revealRow(index)
    revealColumn(column)
    onCursorChange?.(row)
  }

  const modeOf = (row: Row): 'open' | 'cursor' => {
    if (typeof rowClick === 'function') return rowClick(row)
    return rowClick ?? (openable ? 'open' : 'cursor')
  }

  const toggleChecked = (key: string, next: boolean, shift: boolean) => {
    if (!selection) return
    const set = new Set(selection.everything ? keys : selection.checked)
    const range = shift ? rangeKeys(keys, shiftAnchor.current, key) : [key]
    for (const one of range) {
      if (next) set.add(one)
      else set.delete(one)
    }
    shiftAnchor.current = key
    // Unticking any row drops "every match".
    selection.onChange(set, selection.everything && next)
  }

  const copyCell = async (row: Row, columnId: string | undefined) => {
    const column = columns.find((candidate) => candidate.id === columnId)
    const text = column?.copy ? column.copy(row) : rowKey(row)
    const what = column?.copy ? column.header : text
    try {
      await navigator.clipboard.writeText(text)
      toast({ key: 'data-table-copy', title: `Copied ${what}` })
    } catch {
      toast({ key: 'data-table-copy', title: 'Could not copy', tone: 'danger' })
    }
  }

  const openMenuFor = (key: string, at?: RowMenuAnchor) => {
    if (!rowMenu) return
    if (at) {
      setMenu({ key, anchor: at })
      return
    }
    // From the keyboard: beside the row's ⋯, once the row is on screen.
    const index = keys.indexOf(key)
    revealRow(index)
    requestAnimationFrame(() => {
      const element = scrollRef.current?.querySelector<HTMLElement>(
        `tr[data-key="${CSS.escape(key)}"]`,
      )
      const button = element?.querySelector<HTMLElement>('[data-row-menu]')
      if (button ?? element) setMenu({ key, anchor: (button ?? element) as Element })
    })
  }

  // What a row asks of the table, through a ref, so no row re-renders
  // because a closure was re-created.
  const actions = useRef<RowActions<Row> | null>(null)
  useLayoutEffect(() => {
    actions.current = {
      click: (row, key, column) => {
        const index = keys.indexOf(key)
        if (index === -1) return
        setCursor({ key, column })
        onCursorChange?.(row)
        if (modeOf(row) === 'open') onOpen?.(row)
      },
      focus: (row, key, column) => {
        setCursor({ key, column })
        onCursorChange?.(row)
      },
      doubleClick: (row) => onRowDoubleClick?.(row),
      check: toggleChecked,
      open: (row) => {
        setCursor({ key: rowKey(row), column: cursor?.column })
        onOpen?.(row)
      },
      menu: (key, at) => openMenuFor(key, at),
    }
  })

  const cursorRow = cursorIndex === -1 ? undefined : rows[cursorIndex]
  // The cursor row's menu in ⌘K too ("u_9f3k2 › Disable…"), built once per
  // row rather than per scroll frame, so the palette is not told again on
  // every frame.
  const menuCache = useRef<{ row: Row | undefined; items: readonly RowMenuItem[] | undefined }>({
    row: undefined,
    items: undefined,
  })
  if (menuCache.current.row !== cursorRow)
    menuCache.current = {
      row: cursorRow,
      items: cursorRow !== undefined && rowMenu ? rowMenu(cursorRow) : undefined,
    }
  useRowMenuPalette(menuCache.current.items, cursor?.key)
  const loaded = () => rows.length > 0
  const onRow = () => cursorRow !== undefined
  const pageRows = () =>
    Math.max(1, Math.floor(((scrollRef.current?.clientHeight ?? 320) - headHeight()) / ROW_HEIGHT))
  const shortcuts: Shortcut[] = [
    {
      key: 'ArrowUp',
      label: 'Move between rows',
      group: 'Table',
      when: loaded,
      run: () => moveTo(Math.max(0, cursorIndex === -1 ? 0 : cursorIndex - 1)),
    },
    {
      key: 'ArrowDown',
      label: 'Move between rows',
      group: 'Table',
      when: loaded,
      run: () => moveTo(Math.min(rows.length - 1, cursorIndex + 1)),
    },
    {
      key: 'ArrowLeft',
      label: 'Move between cells',
      group: 'Table',
      when: onRow,
      run: () => {
        const at =
          cursor?.column === undefined ? -1 : placed.findIndex((c) => c.id === cursor.column)
        moveTo(cursorIndex, { column: at <= 0 ? undefined : placed[at - 1]?.id })
      },
    },
    {
      key: 'ArrowRight',
      label: 'Move between cells',
      group: 'Table',
      when: onRow,
      run: () => {
        const at =
          cursor?.column === undefined ? -1 : placed.findIndex((c) => c.id === cursor.column)
        moveTo(cursorIndex, { column: placed[Math.min(placed.length - 1, at + 1)]?.id })
      },
    },
    {
      key: 'Home',
      label: 'First loaded row',
      group: 'Table',
      when: loaded,
      run: () => moveTo(0),
    },
    {
      key: 'End',
      label: 'Last loaded row',
      group: 'Table',
      when: loaded,
      run: () => {
        moveTo(rows.length - 1)
        if (hasMore) loadMore?.()
      },
    },
    {
      key: 'PageUp',
      label: 'One screen up',
      group: 'Table',
      when: loaded,
      run: () => moveTo(Math.max(0, (cursorIndex === -1 ? 0 : cursorIndex) - pageRows())),
    },
    {
      key: 'PageDown',
      label: 'One screen down',
      group: 'Table',
      when: loaded,
      run: () => moveTo(Math.min(rows.length - 1, Math.max(0, cursorIndex) + pageRows())),
    },
    ...(openable
      ? [
          {
            key: 'Enter',
            label: 'Open the row',
            group: 'Table',
            when: loaded,
            // A table just focused has no row under the cursor yet: Enter
            // opens the first, as ↓ would put the cursor there.
            run: () => {
              if (cursorRow) onOpen?.(cursorRow)
              else {
                const first = rows[0]
                if (first === undefined) return
                moveTo(0)
                onOpen?.(first)
              }
            },
          },
        ]
      : []),
    ...(check
      ? [
          {
            key: 'Space',
            label: 'Tick the row',
            group: 'Table',
            when: onRow,
            run: () => {
              if (cursor && selection)
                toggleChecked(
                  cursor.key,
                  !(selection.everything || selection.checked.has(cursor.key)),
                  false,
                )
            },
          },
          {
            key: 'Mod+a',
            label: 'Tick every loaded row',
            group: 'Table',
            when: loaded,
            run: () => selection?.onChange(new Set(keys), false),
          },
        ]
      : []),
    {
      key: 'Mod+c',
      label: 'Copy the cell',
      group: 'Table',
      // Text somebody selected on purpose is what they meant to copy.
      when: () => onRow() && !window.getSelection()?.toString(),
      run: () => {
        if (cursorRow) void copyCell(cursorRow, cursor?.column)
      },
    },
    ...(rowMenu
      ? [
          {
            key: 'Shift+F10',
            label: 'The row’s menu',
            group: 'Table',
            when: onRow,
            run: () => {
              if (cursor) openMenuFor(cursor.key)
            },
          },
          {
            key: 'ContextMenu',
            label: 'The row’s menu',
            group: 'Table',
            when: onRow,
            run: () => {
              if (cursor) openMenuFor(cursor.key)
            },
          },
        ]
      : []),
  ]
  useShortcuts({ id: `table:${memoryKey}`, label: ariaLabel }, keyboard === 'page' ? shortcuts : [])
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (keyboard !== 'focus' || isTyping(event.target)) return
    for (const shortcut of shortcuts) {
      if (!matchesKey(event.nativeEvent, shortcut.key)) continue
      if (shortcut.when && !shortcut.when()) continue
      event.preventDefault()
      shortcut.run(event.nativeEvent)
      return
    }
  }

  if (rows.length === 0 && !loading) return <>{empty}</>

  const allChecked =
    selection !== undefined &&
    (selection.everything || (rows.length > 0 && keys.every((key) => selection.checked.has(key))))
  const someChecked =
    selection !== undefined &&
    (selection.everything || keys.some((key) => selection.checked.has(key)))
  const top = items[0]?.start ?? 0
  const bottom = virtualizer.getTotalSize() - (items.at(-1)?.end ?? 0)
  const span = (lead > 0 ? 1 : 0) + placed.length + 2
  const pill = newAbove ?? counted
  const menuRow = menu ? rows[keys.indexOf(menu.key)] : undefined
  const menuItems = menuRow && rowMenu ? rowMenu(menuRow) : []
  const activeDescendant =
    cursorIndex === -1 ? undefined : cellId(idBase, rowOffset + cursorIndex + 2, cursor?.column)

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-kumo-base" data-testid={testId}>
      <div className="relative flex min-h-0 flex-1 flex-col">
        {/* The table picks rows and cells, not text: a drag across it would
            paint every value it crossed. ⌘C copies the cursor cell. */}
        <div
          ref={scrollRef}
          className="group/grid min-h-0 flex-1 overflow-auto select-none"
          data-testid={testId ? `${testId}-scroll` : 'data-table-scroll'}
          data-scrolled={scrolledX ? '' : undefined}
          onScroll={(event) => {
            const element = event.currentTarget
            const moved = element.scrollLeft > 0
            if (moved !== scrolledX) setScrolledX(moved)
            const nowAtTop = element.scrollTop <= 0
            if (nowAtTop !== atTop) setAtTop(nowAtTop)
            if (nowAtTop && counted > 0) setCounted(0)
            recordAnchor()
          }}
          onKeyDown={onKeyDown}
        >
          <Table
            layout="fixed"
            role="grid"
            aria-label={ariaLabel}
            aria-rowcount={ariaRowCount({
              total,
              loaded: rows.length,
              rowOffset,
              hasMore,
              hasPrevious,
            })}
            aria-colcount={placed.length}
            aria-multiselectable={check || undefined}
            aria-activedescendant={activeDescendant}
            aria-busy={loading || undefined}
            tabIndex={0}
            className="border-separate border-spacing-0 outline-none"
            style={{ width: lead + dataWidth + TOOLS_WIDTH, minWidth: '100%' }}
          >
            <colgroup>
              {lead > 0 && <col style={{ width: lead }} />}
              {placed.map((column) => (
                <col key={column.id} style={{ width: column.width }} />
              ))}
              <col />
              <col style={{ width: TOOLS_WIDTH }} />
            </colgroup>
            <Table.Header
              ref={headRef}
              variant="compact"
              className="sticky top-0 z-10 bg-kumo-elevated"
            >
              <tr aria-rowindex={1}>
                {lead > 0 &&
                  (check ? (
                    <Table.CheckHead
                      checked={allChecked}
                      indeterminate={someChecked && !allChecked}
                      onCheckedChange={(next) =>
                        selection?.onChange(next ? new Set(keys) : new Set(), false)
                      }
                      label="Select every loaded row"
                      className={cn(
                        'border-b border-kumo-line',
                        PIN_HEAD,
                        lastPinned === -1 && PIN_EDGE,
                      )}
                      style={{ left: 0 }}
                    />
                  ) : (
                    <Table.Head
                      className={cn(
                        'border-b border-kumo-line',
                        PIN_HEAD,
                        lastPinned === -1 && PIN_EDGE,
                      )}
                      style={{ left: 0 }}
                      aria-hidden
                    />
                  ))}
                {placed.map((column, index) => {
                  const source = ordered[index]
                  const sorted = sort?.column === column.id ? sort.direction : undefined
                  const sortable = source?.sortable === true && onSortChange !== undefined
                  return (
                    <Table.Head
                      key={column.id}
                      className={cn(
                        'group/head border-b border-kumo-line !px-1',
                        column.left !== undefined && PIN_HEAD,
                        column.edge && PIN_EDGE,
                      )}
                      style={column.left !== undefined ? { left: column.left } : undefined}
                      aria-sort={
                        sorted === 'asc'
                          ? 'ascending'
                          : sorted === 'desc'
                            ? 'descending'
                            : sortable
                              ? 'none'
                              : undefined
                      }
                      data-column={column.id}
                    >
                      <HeaderLabel
                        header={column.header}
                        align={column.align}
                        sortable={sortable}
                        sorted={sorted}
                        onSort={() => onSortChange?.(nextSort(sort, column.id))}
                      />
                      <ColumnResizer
                        label={column.header}
                        width={column.width}
                        min={source?.minWidth ?? COLUMN_MIN}
                        onResize={(px) =>
                          setResizing(px === null ? null : { column: column.id, width: px })
                        }
                        onCommit={(px) => {
                          keepWidth(memoryKey, column.id, px)
                          setResizing(null)
                        }}
                        onReset={() => {
                          forgetWidth(memoryKey, column.id)
                          setResizing(null)
                        }}
                        testId={`resize-${column.id}`}
                      />
                    </Table.Head>
                  )
                })}
                <Table.Head className="border-b border-kumo-line" aria-hidden />
                <Table.Head className={cn('right-0 border-b border-kumo-line !px-1', PIN_HEAD)}>
                  <ColumnsMenu
                    columns={columns}
                    choices={choices}
                    onToggle={(id, hidden) => setHidden(memoryKey, id, hidden)}
                    onShowAll={() =>
                      showAll(
                        memoryKey,
                        columns.map((column) => column.id),
                      )
                    }
                    onResetWidths={() => forgetWidths(memoryKey)}
                  />
                </Table.Head>
              </tr>
            </Table.Header>
            <Table.Body className="[&_td]:h-[32px] [&_td]:py-0">
              {top > 0 && (
                <tr aria-hidden>
                  <td colSpan={span} style={{ height: top, padding: 0, border: 0 }} />
                </tr>
              )}
              {items.map((item) => {
                const row = rows[item.index]
                if (row === undefined) return null
                const key = keys[item.index] ?? ''
                const position = rowOffset + item.index
                return (
                  <DataTableRow
                    key={key}
                    row={row}
                    rowKey={key}
                    rowIndex={position + 2}
                    zebra={position % 2 === 1}
                    idBase={idBase}
                    columns={rowColumns}
                    label={key}
                    check={check}
                    openable={openable}
                    menu={rowMenu !== undefined}
                    checked={selection ? selection.everything || selection.checked.has(key) : false}
                    cursor={cursor?.key === key}
                    cursorColumn={cursor?.key === key ? cursor.column : undefined}
                    open={openKey === key}
                    flash={flashes?.get(key)}
                    multiselect={check}
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
          {rows.length === 0 && loading && <TableSkeleton columns={placed} check={lead > 0} />}
        </div>
        {/* Rows created above the view since the reader scrolled away: they
            did not push the rows under the reader, and here is the way up. */}
        {pill > 0 && !atTop && (
          <div className="pointer-events-none absolute inset-x-0 top-10 z-20 flex justify-center">
            <Button
              variant="secondary"
              size="sm"
              icon={<ArrowUpIcon />}
              className="pointer-events-auto shadow-md"
              onClick={() => {
                const element = scrollRef.current
                if (element) element.scrollTop = 0
                setCounted(0)
                onShowNew?.()
              }}
              data-testid="new-above"
            >
              {formatNumber(pill)} new · Show
            </Button>
          </div>
        )}
      </div>
      {footer}
      <RowMenuPopup
        items={menuItems}
        open={menu !== null}
        onOpenChange={(open) => {
          if (!open) setMenu(null)
        }}
        anchor={menu?.anchor ?? null}
      />
    </div>
  )
}

function HeaderLabel({
  header,
  align,
  sortable,
  sorted,
  onSort,
}: {
  header: string
  align: 'start' | 'end'
  sortable: boolean
  sorted: 'asc' | 'desc' | undefined
  onSort: () => void
}) {
  const text = (
    <span
      className={cn(
        'min-w-0 truncate text-[12px] font-medium',
        isDataName(header) ? 'font-mono' : 'font-sans',
      )}
    >
      {header}
    </span>
  )
  const arrow =
    sorted === 'asc' ? (
      <CaretUpIcon size={11} weight="bold" className="shrink-0 text-kumo-default" />
    ) : sorted === 'desc' ? (
      <CaretDownIcon size={11} weight="bold" className="shrink-0 text-kumo-default" />
    ) : (
      <CaretUpDownIcon
        size={11}
        className="shrink-0 text-kumo-inactive opacity-0 group-hover/head:opacity-100"
      />
    )
  if (!sortable)
    return (
      <span
        className={cn(
          'flex h-6 min-w-0 items-center gap-1 px-2 text-kumo-strong',
          align === 'end' && 'justify-end',
        )}
      >
        {text}
      </span>
    )
  return (
    <button
      type="button"
      onClick={onSort}
      className={cn(
        'flex h-6 w-full min-w-0 items-center gap-1 rounded-md px-2 text-kumo-strong hover:ink',
        align === 'end' && 'flex-row-reverse',
      )}
      data-testid="sort-header"
    >
      {text}
      {arrow}
    </button>
  )
}

function ColumnsMenu<Row>({
  columns,
  choices,
  onToggle,
  onShowAll,
  onResetWidths,
}: {
  columns: readonly DataTableColumn<Row>[]
  choices: Readonly<Record<string, boolean>> | undefined
  onToggle: (id: string, hidden: boolean) => void
  onShowAll: () => void
  onResetWidths: () => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        render={
          <Button
            variant="ghost"
            size="sm"
            shape="square"
            icon={<SlidersHorizontalIcon />}
            aria-label="Columns"
            title="Columns"
            className="!text-kumo-subtle hover:!text-kumo-default"
            data-testid="columns-menu"
          />
        }
      />
      <DropdownMenu.Content align="end">
        <DropdownMenu.Group>
          <DropdownMenu.Label>Columns</DropdownMenu.Label>
          {columns.map((column) => {
            const hidden = isColumnHidden(choices, column)
            return (
              <DropdownMenu.Item
                key={column.id}
                closeOnClick={false}
                onClick={() => onToggle(column.id, !hidden)}
                data-testid={`column-toggle-${column.id}`}
              >
                <span className={isDataName(column.header) ? 'font-mono text-[12px]' : undefined}>
                  {column.header}
                </span>
                <MenuCheck on={!hidden} />
              </DropdownMenu.Item>
            )
          })}
        </DropdownMenu.Group>
        <DropdownMenu.Separator />
        <DropdownMenu.Item onClick={onShowAll}>Show every column</DropdownMenu.Item>
        <DropdownMenu.Item onClick={onResetWidths}>Reset column widths</DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}
