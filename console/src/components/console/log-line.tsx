// One line of a log, drawn the same way wherever lines are shown: the Logs
// page (observe's design), a function's invocation and codebase logs. A log
// is read line by line, so a row is dense and steady: the time, the level,
// where it came from, the message, and a trail of what more there is.
//
// - Time: 11 px in the data face, in the console-wide clock format
//   (`lib/format.ts`), or an offset ("+12 ms") the caller writes.
// - Level: nothing for info, the most common; `debug` faded, `warn` amber,
//   `error` red, with a 2 px rail of the same colour down the start of the
//   level column. The row's own left edge is kept for the cursor mark.
// - Source: the quiet chip recipe (`TypeBadge`'s), the function's short
//   name or the service; a caller passes its own interactive chip.
// - Message: 12 px in the data face, one line and cut at rest; expanded
//   (→) or in wrap mode it wraps whole, never cut, and the lines after the
//   first are fainter, the way a stack trace reads.
// - Trail: `+14 lines` for a message with more lines than the one shown,
//   `×12` for a repeated group, then whatever the caller adds (a payload
//   caret, the primary link).
//
// No zebra: stripes fight the level rails. Hover is `hover:ink`; the cursor
// row and the row in the inspector take the grid's focused-row treatment.

import { cn } from '@cloudflare/kumo'
import type { ComponentPropsWithRef, ReactNode } from 'react'
import { useNow } from '@/lib/clock'
import { formatClock, formatNumber, useClockFormat } from '@/lib/format'

/** The engine's log levels (observe's `LogLevel`, lowercase on the wire). */
export type LogLineLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_WORD: Record<LogLineLevel, string> = {
  debug: 'text-kumo-inactive',
  info: '',
  warn: 'text-kumo-warning',
  error: 'text-kumo-danger',
}

const LEVEL_RAIL: Partial<Record<LogLineLevel, string>> = {
  warn: 'before:bg-kumo-warning',
  error: 'before:bg-kumo-danger',
}

/**
 * The quiet chip a source is drawn in when the caller passes text. On a lit
 * row — under the pointer, or the cursor row on its tint — it goes a step
 * darker with the row, or the row's ground would swallow it.
 */
export const SOURCE_CHIP =
  'flex h-4.5 max-w-full min-w-0 items-center rounded bg-kumo-tint px-1 font-mono text-[11px] text-kumo-subtle group-hover:ink group-data-[selected]:ink'

/** Lines in a message after its first. */
export function extraLines(message: string): number {
  let count = 0
  for (let at = message.indexOf('\n'); at !== -1; at = message.indexOf('\n', at + 1)) count += 1
  return count
}

export interface LogLineProps extends Omit<ComponentPropsWithRef<'div'>, 'children'> {
  /** When the line was recorded, RFC 3339. */
  time: string
  /** Written instead of the clock: an offset into an invocation ("+12 ms"). */
  timeText?: string | undefined
  level: LogLineLevel
  /** Where it came from: text is drawn as the quiet chip; a node as given. */
  source?: ReactNode
  message: string
  /** Lines after the first, when the engine counted them; read from the message otherwise. */
  lines?: number | undefined
  /** A group of the same line: `×N`. */
  repeat?: number | undefined
  /** What else the row offers, at its end: a payload caret, the primary link. */
  trail?: ReactNode
  /** Quieter than the rest (a line printed after the invocation returned, hidden-by-filter context). */
  dim?: boolean | undefined
  /** The cursor row, or the row in the inspector. */
  selected?: boolean | undefined
  /** At rest: 24 px (the Logs page) or 28 px (a roomier list). */
  height?: 24 | 28 | undefined
  /** Open (→): the whole message, wrapped, and `detail` under it. */
  expanded?: boolean | undefined
  /** Wrap mode: every message whole, wrapped, without opening the row. */
  wrap?: boolean | undefined
  /** Shown under the message while expanded (a payload tree). */
  detail?: ReactNode
}

export function LogLine({
  time,
  timeText,
  level,
  source,
  message,
  lines,
  repeat,
  trail,
  dim = false,
  selected = false,
  height = 24,
  expanded = false,
  wrap = false,
  detail,
  className,
  ...rest
}: LogLineProps) {
  const { format } = useClockFormat()
  // "3 s ago" turns over every second; the clock and UTC forms never change.
  const now = useNow(format === 'relative' ? 'second' : 'minute')
  const more = lines ?? extraLines(message)
  const open = expanded || wrap
  const newline = message.indexOf('\n')
  // At rest a row is one line: the message's first, with the rest counted in the trail.
  const first = newline === -1 ? message : message.slice(0, newline)
  const after = open && newline !== -1 ? message.slice(newline) : ''
  const quiet = dim || level === 'debug'
  return (
    <div
      {...rest}
      className={cn(
        'group relative grid gap-x-2 pr-3 pl-3 hover:ink',
        source === undefined
          ? 'grid-cols-[104px_44px_minmax(0,1fr)_auto]'
          : 'grid-cols-[104px_44px_var(--log-source-width,120px)_minmax(0,1fr)_auto]',
        open
          ? cn('items-start py-[4px]', height === 28 ? 'min-h-[28px] py-[6px]' : 'min-h-[24px]')
          : cn('items-center', height === 28 ? 'h-[28px]' : 'h-[24px]'),
        selected && 'bg-kumo-tint shadow-[inset_2px_0_0_var(--color-kumo-brand)]',
        className,
      )}
      data-level={level}
      data-selected={selected || undefined}
      data-expanded={expanded || undefined}
    >
      <span
        className={cn(
          'truncate font-mono text-[11px] leading-4 text-kumo-subtle tabular-nums',
          open && 'pt-px',
        )}
        data-part="time"
      >
        {timeText ?? formatClock(time, format, now)}
      </span>
      <span
        className={cn(
          'relative flex h-full min-w-0 items-center self-stretch pl-2 font-mono text-[11px]',
          open && 'items-start pt-px',
          LEVEL_WORD[level],
          LEVEL_RAIL[level] &&
            cn('before:absolute before:inset-y-0 before:left-0 before:w-0.5', LEVEL_RAIL[level]),
        )}
        data-part="level"
      >
        {level === 'info' ? '' : level}
      </span>
      {source !== undefined && (
        <span className="flex min-w-0 items-center" data-part="source">
          {typeof source === 'string' ? (
            <span className={cn(SOURCE_CHIP, 'truncate')}>{source}</span>
          ) : (
            source
          )}
        </span>
      )}
      <span className="flex min-w-0 flex-col gap-1">
        <span
          className={cn(
            'min-w-0 font-mono text-[12px] leading-4',
            open ? 'whitespace-pre-wrap break-words' : 'truncate',
            quiet ? 'text-kumo-subtle' : 'text-kumo-default',
          )}
          data-part="message"
        >
          {first}
          {after && <span className="text-kumo-subtle">{after}</span>}
        </span>
        {expanded && detail}
      </span>
      <span className="flex shrink-0 items-center gap-1.5" data-part="trail">
        {more > 0 && !open && (
          <span className={SOURCE_CHIP} data-part="more">
            +{formatNumber(more)} {more === 1 ? 'line' : 'lines'}
          </span>
        )}
        {repeat !== undefined && repeat > 1 && (
          <span className={SOURCE_CHIP} data-part="repeat">
            ×{formatNumber(repeat)}
          </span>
        )}
        {trail}
      </span>
    </div>
  )
}
