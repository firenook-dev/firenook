// The lines a function printed: one invocation's own (offsets from its
// start, every message whole), or a codebase's load log (the console's
// clock, one line each until opened). Each row is the shared `LogLine`,
// observe's row, so a line reads the same here as in Logs, and the list is
// the kit's `FeedList`, read in place (`inline`: its text selectable, no
// keys of its own): a bounded `FeedStore` drawn virtually, every row
// measured while messages wrap, following the newest line while the reader
// is at the bottom and holding still once they scroll up ("N new · Jump to
// latest"). A page can own that state (the codebase view's
// `PauseButton`). A structured entry's fields, and the lines a one-line row
// cuts, open under the row; lines printed after the invocation returned
// sit under a quiet "After it returned" divider.

import { cn } from '@cloudflare/kumo'
import { CaretDownIcon, CaretRightIcon } from '@phosphor-icons/react'
import { type ReactNode, useState } from 'react'
import type { FunctionLogLine } from '@/api/generated/compute/FunctionLogLine'
import { FeedList } from '@/components/console/feed-list'
import { JsonTree } from '@/components/console/json-tree'
import { LogLine, SOURCE_CHIP, extraLines } from '@/components/console/log-line'
import { formatDuration, formatNumber } from '@/lib/format'
import { type FeedStore, useFeed } from '@/lib/live/feed-store'

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
/** A codebase's load log: `LogLine`'s own template, the clock's 104 px. */
const CLOCK_COLUMNS = 'grid-cols-[104px_44px_minmax(0,1fr)_auto]'
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

export interface LogLinesProps {
  ariaLabel: string
  store: FeedStore<FunctionLogLine>
  /** `invocation`: offsets from its start; `codebase`: the console's clock. */
  mode: 'invocation' | 'codebase'
  /** Every message whole and wrapped (default for an invocation); otherwise one line each until opened. */
  wrap?: boolean | undefined
  /** The invocation is still running: a breathing dot under the list. */
  running?: boolean | undefined
  /** At the newest line and following it; scrolling up turns it off. Held here when not given. */
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
  follow,
  onFollowChange,
  empty,
  defaultOpen,
  className,
  testId = 'log-lines',
}: LogLinesProps) {
  'use no memo' // it reads the mutable store while rendering
  const { size } = useFeed(store)
  const [held, setHeld] = useState(true)
  const following = follow ?? held
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(defaultOpen))
  const toggle = (key: string) =>
    setOpen((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  // One template for every row and its opened part, so the messages line up.
  const shape = mode === 'invocation' ? offsetShape(store, size) : undefined
  const columns = shape ? offsetColumns(shape.newestMs, shape.levels) : CLOCK_COLUMNS

  const renderRow = (line: FunctionLogLine) => {
    const key = lineKey(line)
    const opens = canOpen(line, wrap)
    const fields = fieldsOf(line)
    return (
      <div className="w-full min-w-0">
        {mode === 'invocation' && returnsBefore(store, store.indexOf(key)) && <ReturnedDivider />}
        <LogLine
          time={line.at}
          {...(mode === 'invocation' ? { timeText: offsetText(line.offsetMs) } : {})}
          level={line.level}
          message={line.message}
          // The open button counts the cut lines itself when it is what opens them.
          {...(opens && !fields ? { lines: 0 } : {})}
          dim={line.afterFinish}
          wrap={wrap}
          className={columns}
          trail={
            opens ? (
              <OpenButton
                open={open.has(key)}
                what={fields ? 'fields' : 'message'}
                more={extraLines(line.message)}
                onToggle={() => toggle(key)}
              />
            ) : undefined
          }
          data-testid="log-line"
          data-index={line.index}
        />
      </div>
    )
  }

  // Opened: the lines a one-line row cut, and a structured entry's fields,
  // under the message's own column.
  const renderOpened = (line: FunctionLogLine) => {
    const fields = fieldsOf(line)
    const newline = line.message.indexOf('\n')
    const rest = !wrap && newline !== -1 ? line.message.slice(newline + 1) : ''
    return (
      <div
        className={cn('grid gap-x-2 pr-3 pb-1.5 pl-3', columns)}
        onClick={(event) => event.stopPropagation()}
        data-testid="log-opened"
      >
        <span data-part="time" aria-hidden />
        <span data-part="level" aria-hidden />
        <div className="grid min-w-0 gap-1.5">
          {rest && (
            <span
              className="min-w-0 font-mono text-[12px] leading-4 whitespace-pre-wrap break-words text-kumo-subtle"
              data-part="rest"
            >
              {rest}
            </span>
          )}
          {fields && (
            <JsonTree
              value={fields}
              ariaLabel="The line's fields"
              defaultDepth={2}
              height={240}
              testId="log-fields"
            />
          )}
        </div>
      </div>
    )
  }

  return (
    <div className={cn('flex min-h-0 flex-col', className)} data-testid={testId}>
      <FeedList<FunctionLogLine>
        ariaLabel={ariaLabel}
        store={store}
        order="newest-last"
        rowHeight={24}
        rowKey={lineKey}
        renderRow={renderRow}
        wrap={wrap}
        expanded={open}
        renderExpanded={renderOpened}
        follow={following}
        onFollowChange={onFollowChange ?? setHeld}
        inline
        empty={
          empty ?? (
            <div className="px-3 py-2 text-[12px] text-kumo-subtle" data-testid={`${testId}-empty`}>
              {running ? 'Nothing printed yet.' : 'Nothing was printed.'}
            </div>
          )
        }
        testId={`${testId}-list`}
      />
      {running && <RunningDot />}
    </div>
  )
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
