// A live feed: log lines, invocations, deliveries, attempts, the Auth inbox.
// Append-only, up to ten thousand rows a second, so the rows live in a feed
// store outside React (`lib/live/feed-store.ts`) that tells the list at most
// once a frame, and the list draws only what is on screen.
//
// Following and paused. At the live edge the list follows: each frame it
// stays on the newest row. Scrolling away pauses it — the store stops
// evicting (`buffer`) or stops appending (`freeze`), the rows under the
// reader hold still, and a pill at the edge says how many arrived ("214 new
// · Jump to latest"). The URL's `paused` is the negation of `follow`, so a
// paused feed is a link. Rows that come or go above the reader — older
// history paged in at the top, the oldest rows evicted past the pause cap —
// leave the row the reader is on where it is: the view is anchored to that
// row by key, measured rows included.
//
// Rows are fixed height while collapsed (24, 28 or 32 px) and measured only
// when expanded, so a stack trace costs nothing until it is opened; in wrap
// mode (`wrap`) every row is measured at its natural height instead, and a
// following list stays on its newest row as the measurements arrive. The
// list is `role="log"` with `aria-live="off"`: ten thousand lines a second
// must not be read aloud.

import { Button, cn } from '@cloudflare/kumo'
import { ArrowDownIcon, ArrowUpIcon } from '@phosphor-icons/react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { type ReactNode, memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { formatNumber } from '@/lib/format'
import { type FeedRow, type FeedStore, useFeed } from '@/lib/live/feed-store'
import { useShortcuts } from '@/lib/shortcuts'

/** Rows from the older edge at which the next page of history is asked for. */
const LOAD_AHEAD = 20
/** How close to the edge still counts as at it, px. */
const EDGE_SLACK = 4
/** How long after a wheel, a touch, a key or a press a scroll is the reader's, ms. */
const INTENT_MS = 600

/** The newest item's key in a store, or undefined when it holds none. */
function newestItemKey<T>(store: FeedStore<T>, rowKey: (item: T) => string): string | undefined {
  for (let index = store.size() - 1; index >= 0; index -= 1) {
    const row = store.at(index)
    if (row?.kind === 'item') return rowKey(row.item)
  }
  return undefined
}

/** Items in the store after the one keyed `mark` (all of them when it is gone or undefined). */
export function itemsAfter<T>(store: FeedStore<T>, mark: string | undefined): number {
  const from = mark === undefined ? -1 : store.indexOf(mark)
  let count = 0
  for (let index = from + 1; index < store.size(); index += 1)
    if (store.at(index)?.kind === 'item') count += 1
  return count
}

/**
 * How many items arrived since the feed paused: the store's own count in
 * `freeze` mode, the rows past the newest one at the moment of pausing in
 * `buffer` mode. The list's pill and the page's `PauseButton` both read it.
 * A frozen store appends nothing that arrives, so rows that appear while it
 * is paused are the page's own (a fresh page for a new filter, the lines
 * around one opened by a link) and never count as new: pass `mode` the
 * store's `pausedMode`.
 */
export function useFeedPending<T>(
  store: FeedStore<T>,
  paused: boolean,
  rowKey: (item: T) => string,
  mode: 'freeze' | 'buffer' = 'buffer',
): number {
  // It reads the store's rows while rendering (the newest key when the feed
  // pauses, the rows after it since), and the store is mutable: the compiler
  // may keep such a read for as long as the store is the same object.
  'use no memo'
  useFeed(store)
  const [mark, setMark] = useState<{ paused: boolean; key: string | undefined }>(() => ({
    paused,
    key: paused ? newestItemKey(store, rowKey) : undefined,
  }))
  let current = mark
  if (mark.paused !== paused) {
    current = { paused, key: paused ? newestItemKey(store, rowKey) : undefined }
    setMark(current)
  }
  if (!paused) return 0
  if (mode === 'freeze') return store.pending()
  return store.pending() + itemsAfter(store, current.key)
}

/** The words of a gap row. */
export function gapText(missed: number | null, kept: number): string {
  if (missed === null) return 'Entries from an earlier run were missed here.'
  return `${formatNumber(missed)} ${missed === 1 ? 'entry was' : 'entries were'} missed here; the engine keeps the last ${formatNumber(kept)}.`
}

export interface FeedListProps<T> {
  ariaLabel: string
  store: FeedStore<T>
  order: 'newest-first' | 'newest-last'
  /** Collapsed rows are exactly this tall. */
  rowHeight: 24 | 28 | 32
  rowKey: (item: T) => string
  /** Cheap; rows are memoized by key. */
  renderRow: (item: T) => ReactNode
  /** Rows shown expanded (a stack trace, a payload): measured; the rest stay fixed. */
  expanded?: ReadonlySet<string> | undefined
  /**
   * Wrap mode: every row is measured at its natural height, at least
   * `rowHeight` (Logs' "Wrap lines": a long message wraps whole instead of
   * being cut). Off, rows go back to their fixed height.
   */
  wrap?: boolean | undefined
  renderExpanded?: ((item: T) => ReactNode) | undefined
  /** → / ← on the selected row, or the row's caret (never `o`). */
  onToggleExpanded?: ((key: string, open: boolean) => void) | undefined
  /** Marker rows ("Engine restarted", "50 more starts in this burst"); default: one 11 px line. */
  renderMarker?: ((row: Extract<FeedRow<T>, { kind: 'marker' }>) => ReactNode) | undefined
  selectedKey?: string | undefined
  onSelect?: ((item: T) => void) | undefined
  /** `o` on the selected row: open its target (the Auth Inbox link). */
  onOpenTarget?: ((item: T) => void) | undefined
  /** The store's `pausedMode` (default `buffer`): in `freeze` the pill counts only what the store held back. */
  pausedMode?: 'freeze' | 'buffer' | undefined
  /** At the live edge; the URL's `paused` is its negation. */
  follow: boolean
  onFollowChange: (follow: boolean) => void
  /** Older history the engine pages: asked for 20 rows from the older edge. */
  hasMore?: boolean | undefined
  loadMore?: (() => void) | undefined
  /** Puts a row in view (Logs' `entry=`); the list keeps it there while rows arrive. */
  scrollToKey?: { key: string; align?: 'center' | 'start' | undefined } | undefined
  /** The column header, above the rows. */
  header?: ReactNode
  empty: ReactNode
  testId?: string | undefined
}

/** A row's key as the virtualizer and the anchor know it. */
function keyOf<T>(row: FeedRow<T> | undefined, rowKey: (item: T) => string, at: number): string {
  if (!row) return `\u0000missing:${at}`
  if (row.kind === 'item') return rowKey(row.item)
  if (row.kind === 'marker') return `\u0000marker:${row.key}`
  return `\u0000gap@${at}`
}

export function FeedList<T>({
  ariaLabel,
  store,
  order,
  rowHeight,
  rowKey,
  renderRow,
  expanded,
  wrap = false,
  renderExpanded,
  onToggleExpanded,
  renderMarker,
  selectedKey,
  onSelect,
  onOpenTarget,
  pausedMode = 'buffer',
  follow,
  onFollowChange,
  hasMore = false,
  loadMore,
  scrollToKey,
  header,
  empty,
  testId,
}: FeedListProps<T>) {
  'use no memo' // the virtualizer hands out functions the compiler cannot memoize safely
  const { size, version } = useFeed(store)
  const pending = useFeedPending(store, !follow, rowKey, pausedMode)
  const scrollRef = useRef<HTMLDivElement>(null)
  const newestLast = order === 'newest-last'
  /** Store position (0 = oldest kept) of the row drawn at `display`. */
  const storeIndex = (display: number) => (newestLast ? display : size - 1 - display)
  const rowAt = (display: number) => store.at(storeIndex(display))
  const displayOf = (index: number) => (index === -1 ? -1 : newestLast ? index : size - 1 - index)

  // oxlint-disable-next-line react/incompatible-library -- the directive above opts this component out of the compiler
  const virtualizer = useVirtualizer({
    count: size,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    getItemKey: (display) => keyOf(rowAt(display), rowKey, storeIndex(display)),
    overscan: 16,
  })

  // The store holds its rows while the reader is away from the edge.
  useEffect(() => {
    if (follow) store.resume()
    else store.pause()
  }, [follow, store])

  const atEdge = (element: HTMLElement) =>
    newestLast
      ? element.scrollHeight - element.clientHeight - element.scrollTop <= EDGE_SLACK
      : element.scrollTop <= EDGE_SLACK
  const toEdge = (element: HTMLElement) => {
    element.scrollTop = newestLast ? element.scrollHeight : 0
  }

  // The row the reader is on, by key, and how far into it the view starts.
  const anchor = useRef<{ key: string; delta: number } | null>(null)
  const recordAnchor = () => {
    const element = scrollRef.current
    if (!element) return
    const first = virtualizer.getVirtualItemForOffset(element.scrollTop)
    if (!first) {
      anchor.current = null
      return
    }
    // Anchor to an item: a gap or marker row has no lasting key.
    for (let display = first.index; display < size; display += 1) {
      const row = rowAt(display)
      if (row?.kind !== 'item') continue
      const start = virtualizer.measurementsCache[display]?.start ?? display * rowHeight
      anchor.current = { key: rowKey(row.item), delta: element.scrollTop - start }
      return
    }
    anchor.current = null
  }

  // After a frame of new rows (or a change of mode): follow the edge, or
  // keep the reader's row in place. Only then: a render the scroll itself
  // caused must not pull the view back to where the reader just left. A
  // following list also goes back to the edge when measured rows (wrapped,
  // expanded) change its height, which happens a frame after they render.
  const seen = useRef<{ version: number; follow: boolean; total: number } | null>(null)
  const total = virtualizer.getTotalSize()
  useLayoutEffect(() => {
    const element = scrollRef.current
    const before = seen.current
    const moved =
      before?.version !== version || before.follow !== follow || (follow && before.total !== total)
    seen.current = { version, follow, total }
    if (!element || !moved) return
    if (follow) {
      toEdge(element)
      return
    }
    // Paused just now (the button, `p`), nothing new drawn yet: the row the
    // reader is on is held from here. A view that never scrolled — a
    // newest-first list read at its top — has recorded no row of its own.
    if (before?.follow === true && before.version === version) recordAnchor()
    const held = anchor.current
    if (!held) {
      // Paused without a scroll (the Pause button, `p`, a link that says
      // paused): the row on screen now is the one to hold.
      recordAnchor()
      return
    }
    const display = displayOf(store.indexOf(held.key))
    if (display === -1) return
    const start = virtualizer.measurementsCache[display]?.start ?? display * rowHeight
    const target = Math.max(0, start + held.delta)
    if (Math.abs(element.scrollTop - target) >= 1) element.scrollTop = target
  })

  // Out of wrap mode, every row goes back to its fixed height: the measured
  // sizes are forgotten at once.
  const wrapped = useRef(wrap)
  useLayoutEffect(() => {
    if (wrapped.current === wrap) return
    wrapped.current = wrap
    if (!wrap) virtualizer.measure()
  })

  // A collapsed row goes back to its fixed height: its measured size is
  // forgotten, or it would keep the room its stack trace took.
  const previousExpanded = useRef<ReadonlySet<string>>(expanded ?? new Set())
  useLayoutEffect(() => {
    const before = previousExpanded.current
    const now = expanded ?? new Set<string>()
    previousExpanded.current = now
    for (const key of before) {
      if (now.has(key) || wrap) continue
      const display = displayOf(store.indexOf(key))
      if (display !== -1) virtualizer.resizeItem(display, rowHeight)
    }
  })

  // Older history as the older edge comes into view.
  const items = virtualizer.getVirtualItems()
  const firstVisible = items[0]?.index ?? 0
  const lastVisible = items.at(-1)?.index ?? -1
  const nearOlderEdge = newestLast ? firstVisible <= LOAD_AHEAD : lastVisible >= size - LOAD_AHEAD
  useEffect(() => {
    if (size > 0 && hasMore && nearOlderEdge) loadMore?.()
  }, [size, hasMore, nearOlderEdge, loadMore])

  // A scroll is the reader's when it follows their own wheel, touch, key or
  // press; the list's own moves (following, anchoring, placing a row the
  // URL names) never pause it or follow again.
  const intent = useRef(0)
  const noteIntent = () => {
    intent.current = Date.now()
  }

  // A row asked for by the URL: put in view once it is in the store, once.
  const placed = useRef<string | undefined>(undefined)
  useLayoutEffect(() => {
    if (!scrollToKey || placed.current === scrollToKey.key) return
    const display = displayOf(store.indexOf(scrollToKey.key))
    if (display === -1) return
    const element = scrollRef.current
    if (!element) return
    placed.current = scrollToKey.key
    // Placed by hand from the row's own measurement rather than through the
    // virtualizer's scroll, which a remount (or a list still settling) can
    // cancel before it lands.
    const start = virtualizer.measurementsCache[display]?.start ?? display * rowHeight
    const tall = virtualizer.measurementsCache[display]?.size ?? rowHeight
    // The press that opened the row is not a scroll: a row placed at the
    // live edge must not resume a paused feed.
    intent.current = 0
    element.scrollTop = Math.max(
      0,
      scrollToKey.align === 'start' ? start : start - (element.clientHeight - tall) / 2,
    )
    // Where it landed is where the reader is: the anchor follows it.
    recordAnchor()
  })

  const onScroll = () => {
    const element = scrollRef.current
    if (!element) return
    recordAnchor()
    if (Date.now() - intent.current > INTENT_MS) return
    const edge = atEdge(element)
    if (follow && !edge) onFollowChange(false)
    else if (!follow && edge) onFollowChange(true)
  }

  // Keys: the selection moves through the items; the edges and expansion.
  const selectedDisplay = selectedKey === undefined ? -1 : displayOf(store.indexOf(selectedKey))
  const selectAt = (display: number, step: 1 | -1) => {
    for (let at = display; at >= 0 && at < size; at += step) {
      const row = rowAt(at)
      if (row?.kind !== 'item') continue
      onSelect?.(row.item)
      noteIntent()
      virtualizer.scrollToIndex(at, { align: 'auto' })
      return
    }
  }
  const selectedItem = () => {
    const row = selectedDisplay === -1 ? undefined : rowAt(selectedDisplay)
    return row?.kind === 'item' ? row.item : undefined
  }
  const jumpToEdge = () => {
    const element = scrollRef.current
    if (element) toEdge(element)
    onFollowChange(true)
  }
  const jumpToOldest = () => {
    noteIntent()
    virtualizer.scrollToIndex(newestLast ? 0 : size - 1, { align: newestLast ? 'start' : 'end' })
  }
  const has = () => size > 0
  const up = () =>
    selectAt(selectedDisplay === -1 ? (items[0]?.index ?? 0) : selectedDisplay - 1, -1)
  const down = () =>
    selectAt(selectedDisplay === -1 ? (items[0]?.index ?? 0) : selectedDisplay + 1, 1)
  useShortcuts({ id: `feed:${ariaLabel}`, label: ariaLabel }, [
    { key: 'ArrowUp', label: 'Move between rows', group: 'Feed', when: has, run: up },
    { key: 'ArrowDown', label: 'Move between rows', group: 'Feed', when: has, run: down },
    { key: 'k', label: 'Move between rows', group: 'Feed', when: has, run: up },
    { key: 'j', label: 'Move between rows', group: 'Feed', when: has, run: down },
    {
      key: 'Enter',
      label: 'Open the row',
      group: 'Feed',
      when: () => has() && onSelect !== undefined,
      run: () => {
        const item = selectedItem()
        if (item !== undefined) onSelect?.(item)
        else down()
      },
    },
    {
      key: 'End',
      label: 'Jump to the latest and follow',
      group: 'Feed',
      when: has,
      run: jumpToEdge,
    },
    {
      key: 'Home',
      label: 'Jump to the oldest kept row',
      group: 'Feed',
      when: has,
      run: jumpToOldest,
    },
    ...(onToggleExpanded && renderExpanded
      ? [
          {
            key: 'ArrowRight',
            label: 'Expand the row',
            group: 'Feed',
            when: () => selectedKey !== undefined && !(expanded?.has(selectedKey) ?? false),
            run: () => {
              if (selectedKey !== undefined) onToggleExpanded(selectedKey, true)
            },
          },
          {
            key: 'ArrowLeft',
            label: 'Collapse the row',
            group: 'Feed',
            when: () => selectedKey !== undefined && (expanded?.has(selectedKey) ?? false),
            run: () => {
              if (selectedKey !== undefined) onToggleExpanded(selectedKey, false)
            },
          },
        ]
      : []),
    ...(onOpenTarget
      ? [
          {
            key: 'o',
            label: 'Open its target',
            group: 'Feed',
            when: () => selectedItem() !== undefined,
            run: () => {
              const item = selectedItem()
              if (item !== undefined) onOpenTarget(item)
            },
          },
        ]
      : []),
  ])

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-kumo-base" data-testid={testId}>
      {header && (
        <div className="shrink-0 border-b border-kumo-line bg-kumo-elevated text-[12px] text-kumo-strong">
          {header}
        </div>
      )}
      {size === 0 ? (
        empty
      ) : (
        <div className="relative flex min-h-0 flex-1 flex-col">
          <div
            ref={scrollRef}
            className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto"
            onScroll={onScroll}
            onWheel={noteIntent}
            onTouchMove={noteIntent}
            onPointerDown={noteIntent}
            onKeyDown={noteIntent}
            data-testid={testId ? `${testId}-scroll` : 'feed-scroll'}
            data-follow={follow ? '' : undefined}
          >
            <div
              role="log"
              aria-live="off"
              aria-label={ariaLabel}
              className="relative w-full"
              style={{ height: total }}
            >
              {items.map((virtual) => {
                const row = rowAt(virtual.index)
                if (!row) return null
                const key = String(virtual.key)
                if (row.kind !== 'item')
                  return (
                    <div
                      key={key}
                      className="absolute inset-x-0 flex items-center px-3"
                      style={{ height: rowHeight, transform: `translateY(${virtual.start}px)` }}
                      data-testid={row.kind === 'gap' ? 'feed-gap' : 'feed-marker'}
                    >
                      {row.kind === 'gap' ? (
                        <span className="truncate text-[11px] text-kumo-subtle">
                          ⋯ {gapText(row.missed, row.kept)}
                        </span>
                      ) : renderMarker ? (
                        renderMarker(row)
                      ) : (
                        <span className="flex min-w-0 items-center gap-2 text-[11px] text-kumo-subtle">
                          <span className="truncate">{row.text}</span>
                          {row.action && (
                            <Button variant="ghost" size="xs" onClick={row.action.run}>
                              {row.action.label}
                            </Button>
                          )}
                        </span>
                      )}
                    </div>
                  )
                const open = (expanded?.has(key) ?? false) && renderExpanded !== undefined
                return (
                  <FeedRowView
                    key={key}
                    item={row.item}
                    itemKey={key}
                    index={virtual.index}
                    top={virtual.start}
                    height={rowHeight}
                    selected={selectedKey === key}
                    open={open}
                    wrap={wrap}
                    measure={open || wrap ? virtualizer.measureElement : undefined}
                    renderRow={renderRow}
                    renderExpanded={renderExpanded}
                    onSelect={onSelect}
                  />
                )
              })}
            </div>
          </div>
          {!follow && pending > 0 && (
            <div
              className={cn(
                'pointer-events-none absolute inset-x-0 z-10 flex justify-center',
                newestLast ? 'bottom-3' : 'top-3',
              )}
            >
              <Button
                variant="secondary"
                size="sm"
                icon={newestLast ? <ArrowDownIcon /> : <ArrowUpIcon />}
                className="pointer-events-auto shadow-md"
                onClick={jumpToEdge}
                data-testid="jump-to-latest"
              >
                {formatNumber(pending)} new · Jump to latest
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function FeedRowViewInner<T>({
  item,
  itemKey,
  index,
  top,
  height,
  selected,
  open,
  wrap,
  measure,
  renderRow,
  renderExpanded,
  onSelect,
}: {
  item: T
  itemKey: string
  index: number
  top: number
  height: number
  selected: boolean
  open: boolean
  wrap: boolean
  measure: ((element: HTMLDivElement | null) => void) | undefined
  renderRow: (item: T) => ReactNode
  renderExpanded: ((item: T) => ReactNode) | undefined
  onSelect: ((item: T) => void) | undefined
}) {
  return (
    <div
      ref={measure}
      data-index={index}
      data-key={itemKey}
      data-testid="feed-row"
      aria-selected={selected}
      className={cn(
        'absolute inset-x-0 cursor-default select-none',
        selected ? 'bg-kumo-tint shadow-[inset_2px_0_0_var(--color-kumo-brand)]' : 'hover:ink',
      )}
      style={{ transform: `translateY(${top}px)`, ...(open || wrap ? {} : { height }) }}
      onClick={() => onSelect?.(item)}
    >
      {/* Wrapped, the line grows with its text, never below a row. */}
      <div
        className="flex items-center overflow-hidden"
        style={wrap ? { minHeight: height } : { height }}
      >
        {renderRow(item)}
      </div>
      {open && renderExpanded?.(item)}
    </div>
  )
}

const FeedRowView = memo(FeedRowViewInner) as typeof FeedRowViewInner
