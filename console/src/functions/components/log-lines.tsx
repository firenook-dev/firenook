// The lines a function printed: one invocation's own (offsets from its
// start, every message whole), or a codebase's load log (the console's
// clock, one line each until opened). Each row is the shared `LogLine`,
// observe's row, so a line reads the same here as in Logs.
//
// What compute adds is the list. Rows have variable height — a wrapped
// message, a structured entry's fields opened under it — which the
// fixed-height `FeedList` cannot host; so this list measures its rows, and
// draws only what is on screen once it holds more than 200. It reads a
// `FeedStore` (a bounded ring outside React, told at most once a frame),
// follows the newest line while the reader is at the bottom, and holds
// still once they scroll up — the codebase view's `PauseButton` writes the
// same state. Lines printed after the invocation returned sit under a
// quiet "After it returned" divider.

import { Button, cn } from '@cloudflare/kumo'
import { ArrowDownIcon, CaretDownIcon, CaretRightIcon } from '@phosphor-icons/react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { FunctionLogLine } from '@/api/generated/compute/FunctionLogLine'
import { useFeedPending } from '@/components/console/feed-list'
import { JsonTree } from '@/components/console/json-tree'
import { LogLine, SOURCE_CHIP, extraLines } from '@/components/console/log-line'
import { formatDuration, formatNumber } from '@/lib/format'
import { type FeedRow, type FeedStore, useFeed } from '@/lib/live/feed-store'

/** Above this many rows the list draws only what is on screen. */
export const VIRTUAL_FROM = 200
/** How close to the bottom still counts as at it, px. */
const EDGE_SLACK = 4
/** How long after a wheel, a touch, a key or a press a scroll is the reader's, ms. */
const INTENT_MS = 600

/** A line's key in its store: the engine's index, unique per invocation and per codebase log. */
export function lineKey(line: FunctionLogLine): string {
  return String(line.index)
}

/** The offset a line was printed at, from the invocation's start: `+0 ms`, `+12 ms`, `+1.2 s`. */
export function offsetText(ms: number): string {
  return `+${formatDuration(ms)}`
}

/**
 * An invocation's row template. It is `LogLine`'s own (time, level 44 px,
 * message, trail) with two changes that give the message the rest of an
 * inspector's width: the time column is as wide as an offset, not the
 * clock's 104 px, and while every line is info (whose level word is blank)
 * there is no level column at all. It comes, for every row at once, with
 * the first debug, warn or error line. Under a minute the widest offset is
 * `+999 ms`, 7 characters of the data face at 11 px (6.6 px each); past it
 * `+59 min 59 s`, 12.
 */
const OFFSET_COLUMNS = {
  levels: 'grid-cols-[52px_44px_minmax(0,1fr)_auto]',
  plain: 'grid-cols-[52px_minmax(0,1fr)_auto] [&>[data-part=level]]:hidden',
}
const MINUTE_OFFSET_COLUMNS = {
  levels: 'grid-cols-[84px_44px_minmax(0,1fr)_auto]',
  plain: 'grid-cols-[84px_minmax(0,1fr)_auto] [&>[data-part=level]]:hidden',
}
/** From here on an offset reads in minutes (`+1 min`), ms. */
export const MINUTE_OFFSET_MS = 59_500

/** The row template for an invocation whose newest line is `newestMs` in. */
export function offsetColumns(newestMs: number, levels: boolean): string {
  const columns = newestMs >= MINUTE_OFFSET_MS ? MINUTE_OFFSET_COLUMNS : OFFSET_COLUMNS
  return levels ? columns.levels : columns.plain
}

/** The newest line's offset, and whether any line has a level word to show. */
function offsetShape(
  store: FeedStore<FunctionLogLine>,
  size: number,
): { newestMs: number; levels: boolean } {
  let newestMs: number | undefined
  let levels = false
  // Lines arrive in order, so the newest is also the furthest in.
  for (let at = size - 1; at >= 0 && (newestMs === undefined || !levels); at -= 1) {
    const row = store.at(at)
    if (row?.kind !== 'item') continue
    newestMs ??= row.item.offsetMs
    if (row.item.level !== 'info') levels = true
  }
  return { newestMs: newestMs ?? 0, levels }
}

/** A structured entry's own fields, when it has any worth opening. */
export function fieldsOf(line: FunctionLogLine): Record<string, unknown> | undefined {
  const { fields } = line
  if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) return undefined
  return Object.keys(fields).length > 0 ? (fields as Record<string, unknown>) : undefined
}

/** Whether a row has more to show when opened: fields, or lines a one-line row cuts. */
export function canOpen(line: FunctionLogLine, wrap: boolean): boolean {
  return fieldsOf(line) !== undefined || (!wrap && extraLines(line.message) > 0)
}

/** Whether the "After it returned" divider sits above the row at `index`. */
export function returnsBefore(store: FeedStore<FunctionLogLine>, index: number): boolean {
  const row = store.at(index)
  if (row?.kind !== 'item' || !row.item.afterFinish) return false
  for (let at = index - 1; at >= 0; at -= 1) {
    const before = store.at(at)
    if (before?.kind === 'item') return !before.item.afterFinish
  }
  return true
}

/** A gap row's words, in lines. */
export function lineGapText(missed: number | null, kept: number): string {
  if (missed === null) return 'Lines from an earlier run were missed here.'
  return `${formatNumber(missed)} ${missed === 1 ? 'line was' : 'lines were'} missed here; the engine keeps the last ${formatNumber(kept)}.`
}

export interface LogLinesProps {
  ariaLabel: string
  store: FeedStore<FunctionLogLine>
  /** `invocation`: offsets from its start; `codebase`: the console's clock. */
  mode: 'invocation' | 'codebase'
  /** Every message whole and wrapped (default for an invocation); otherwise one line each until opened. */
  wrap?: boolean | undefined
  /** The invocation is still running: a breathing dot at the end of the list. */
  running?: boolean | undefined
  /** At the newest line and following it; scrolling up turns it off. Default: always. */
  follow?: boolean | undefined
  onFollowChange?: ((follow: boolean) => void) | undefined
  /** What an empty list says. */
  empty?: ReactNode
  /** Rows open at first (by `lineKey`): a design card, a line a link points at. */
  defaultOpen?: readonly string[] | undefined
  className?: string | undefined
  testId?: string | undefined
}

export function LogLines({
  ariaLabel,
  store,
  mode,
  wrap = mode === 'invocation',
  running = false,
  follow = true,
  onFollowChange,
  empty,
  defaultOpen,
  className,
  testId = 'log-lines',
}: LogLinesProps) {
  'use no memo' // it reads the mutable store while rendering, and holds a virtualizer
  const { size, version } = useFeed(store)
  const pending = useFeedPending(store, !follow, lineKey)
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(defaultOpen))
  const scrollRef = useRef<HTMLDivElement>(null)
  const virtual = size > VIRTUAL_FROM

  // oxlint-disable-next-line react/incompatible-library -- the directive above opts this component out of the compiler
  const virtualizer = useVirtualizer({
    count: virtual ? size : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 24,
    getItemKey: (index) => keyAt(store.at(index), index),
    overscan: 12,
  })

  // The store holds its rows while the reader is away from the bottom.
  useEffect(() => {
    if (follow) store.resume()
    else store.pause()
  }, [follow, store])

  // Following: every change lands on the newest line.
  useLayoutEffect(() => {
    if (!follow) return
    const element = scrollRef.current
    if (!element) return
    if (virtual) virtualizer.scrollToIndex(size - 1, { align: 'end' })
    element.scrollTop = element.scrollHeight
  }, [follow, version, size, virtual, virtualizer])

  const intent = useRef(0)
  const noteIntent = () => {
    intent.current = Date.now()
  }
  const onScroll = () => {
    const element = scrollRef.current
    if (!element || !onFollowChange) return
    if (Date.now() - intent.current > INTENT_MS) return
    const edge = element.scrollHeight - element.clientHeight - element.scrollTop <= EDGE_SLACK
    if (follow && !edge) onFollowChange(false)
    else if (!follow && edge) onFollowChange(true)
  }
  const jumpToLatest = () => {
    onFollowChange?.(true)
    const element = scrollRef.current
    if (element) element.scrollTop = element.scrollHeight
  }

  const toggle = (key: string) =>
    setOpen((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  // One template for every row, so the messages line up.
  const shape = mode === 'invocation' ? offsetShape(store, size) : undefined
  const columns = shape && offsetColumns(shape.newestMs, shape.levels)

  const renderRow = (index: number) => {
    const row = store.at(index)
    if (!row) return null
    if (row.kind === 'gap')
      return (
        <div
          className="flex h-6 items-center px-3 text-[11px] text-kumo-subtle"
          data-testid="log-gap"
        >
          <span className="truncate">⋯ {lineGapText(row.missed, row.kept)}</span>
        </div>
      )
    if (row.kind === 'marker')
      return (
        <div
          className="flex h-6 items-center gap-2 px-3 text-[11px] text-kumo-subtle"
          data-testid="log-marker"
        >
          <span className="truncate">{row.text}</span>
          {row.action && (
            <Button variant="ghost" size="xs" onClick={row.action.run}>
              {row.action.label}
            </Button>
          )}
        </div>
      )
    const line = row.item
    const key = lineKey(line)
    const opens = canOpen(line, wrap)
    const expanded = opens && open.has(key)
    const fields = fieldsOf(line)
    const more = extraLines(line.message)
    return (
      <>
        {mode === 'invocation' && returnsBefore(store, index) && <ReturnedDivider />}
        <LogLine
          time={line.at}
          {...(mode === 'invocation' ? { timeText: offsetText(line.offsetMs) } : {})}
          level={line.level}
          message={line.message}
          // The open button counts the cut lines itself when it is what opens them.
          {...(opens && !fields ? { lines: 0 } : {})}
          dim={line.afterFinish}
          wrap={wrap}
          expanded={expanded}
          className={columns}
          trail={
            opens ? (
              <OpenButton
                open={expanded}
                what={fields ? 'fields' : 'message'}
                more={more}
                onToggle={() => toggle(key)}
              />
            ) : undefined
          }
          detail={
            fields ? (
              <JsonTree
                value={fields}
                ariaLabel="The line's fields"
                defaultDepth={2}
                height={240}
                testId="log-fields"
              />
            ) : undefined
          }
          data-testid="log-line"
          data-index={line.index}
        />
      </>
    )
  }

  if (size === 0)
    return (
      <div className={cn('flex min-h-0 flex-col', className)} data-testid={testId}>
        {empty ?? (
          <div className="px-3 py-2 text-[12px] text-kumo-subtle" data-testid={`${testId}-empty`}>
            {running ? 'Nothing printed yet.' : 'Nothing was printed.'}
          </div>
        )}
        {running && <RunningDot />}
      </div>
    )

  return (
    <div className={cn('relative flex min-h-0 flex-col', className)} data-testid={testId}>
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto"
        onScroll={onScroll}
        onWheel={noteIntent}
        onTouchMove={noteIntent}
        onPointerDown={noteIntent}
        onKeyDown={noteIntent}
        data-follow={follow ? '' : undefined}
        data-virtual={virtual ? '' : undefined}
      >
        <div
          role="log"
          aria-live="off"
          aria-label={ariaLabel}
          className="relative w-full py-1"
          style={virtual ? { height: virtualizer.getTotalSize() } : undefined}
        >
          {virtual
            ? virtualizer.getVirtualItems().map((item) => (
                <div
                  key={item.key}
                  ref={virtualizer.measureElement}
                  data-index={item.index}
                  className="absolute inset-x-0 top-0"
                  style={{ transform: `translateY(${item.start}px)` }}
                >
                  {renderRow(item.index)}
                </div>
              ))
            : Array.from({ length: size }, (_, index) => (
                <div key={keyAt(store.at(index), index)}>{renderRow(index)}</div>
              ))}
        </div>
        {running && <RunningDot />}
      </div>
      {!follow && pending > 0 && (
        <div className="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center">
          <Button
            variant="secondary"
            size="xs"
            icon={<ArrowDownIcon />}
            className="pointer-events-auto shadow-sm"
            onClick={jumpToLatest}
            data-testid={`${testId}-latest`}
          >
            {formatNumber(pending)} new · Jump to latest
          </Button>
        </div>
      )}
    </div>
  )
}

/** A row's key in the list: an item by its index, other rows by position. */
function keyAt(row: FeedRow<FunctionLogLine> | undefined, index: number): string {
  if (row?.kind === 'item') return lineKey(row.item)
  if (row?.kind === 'marker') return `\u0000marker:${row.key}`
  return `\u0000row:${index}`
}

/** The quiet line between what the invocation printed while it ran and after it answered. */
function ReturnedDivider() {
  return (
    <div
      className="flex items-center gap-2 px-3 pt-1.5 pb-1 text-[11px] text-kumo-subtle"
      role="separator"
      data-testid="log-returned"
    >
      <span>After it returned</span>
      <span className="h-px flex-1 bg-kumo-hairline" aria-hidden />
    </div>
  )
}

/** A running invocation's list ends in a breathing dot, no word. */
function RunningDot() {
  return (
    <div className="flex h-6 items-center px-3" data-testid="log-running">
      <span className="relative flex size-1.5" aria-hidden>
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-kumo-interact motion-reduce:hidden" />
        <span className="relative inline-flex size-1.5 rounded-full bg-kumo-interact" />
      </span>
      <span className="sr-only">Still running</span>
    </div>
  )
}

/** Opens a row: a structured entry's fields, or the lines a one-line row cuts. */
function OpenButton({
  open,
  what,
  more,
  onToggle,
}: {
  open: boolean
  what: 'fields' | 'message'
  /** Lines after the first, for a message the row cuts. */
  more: number
  onToggle: () => void
}) {
  const Caret = open ? CaretDownIcon : CaretRightIcon
  return (
    <button
      type="button"
      className={cn(
        SOURCE_CHIP,
        'gap-0.5 hover:ink focus-visible:ring focus-visible:ring-kumo-focus focus-visible:outline-none',
      )}
      aria-expanded={open}
      aria-label={
        what === 'fields'
          ? open
            ? 'Hide the fields'
            : 'Show the fields'
          : open
            ? 'Show one line'
            : 'Show the whole message'
      }
      onClick={onToggle}
      data-testid="log-open"
    >
      <Caret size={9} />
      {what === 'fields'
        ? '{}'
        : open
          ? 'one line'
          : `+${formatNumber(more)} ${more === 1 ? 'line' : 'lines'}`}
    </button>
  )
}
