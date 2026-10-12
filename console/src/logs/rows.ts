// What the Logs feed holds, row by row: a line (alone, or a run of the same
// line printed again and again, drawn once with ×N), or one of the edges
// the reader reaches at the top — where the engine's log begins, where the
// page stopped loading older lines, where the view was cleared. Markers
// ("Engine restarted", a gap) are the feed store's own rows.
//
// Grouping is Chrome DevTools' "group similar", made safe for a log of
// many callers: two lines group only when everything that tells them apart
// is the same — service, level, function, invocation, message and payload —
// so two invocations printing the same line stay two rows. A group keeps
// the first line's cursor as its key, so it never moves or changes key as
// it grows.

import type { LogEntry } from '@/api/generated/observe/LogEntry'
import { isMarkerKind } from '@/observe/kinds'

/** The edges a reader can reach at the top of the feed. */
export type LogEdge = 'start' | 'cap' | 'cleared'

export type LogItem =
  | {
      kind: 'line'
      /** The first line's cursor. */
      key: string
      /** The first line of the run: what the row shows and the inspector opens. */
      entry: LogEntry
      /** How many times it was printed in a row; 1 for a line alone. */
      repeat: number
      /** The newest line of the run. */
      last: LogEntry
    }
  | { kind: 'edge'; key: string; edge: LogEdge }

/** A row for one line. */
export function lineItem(entry: LogEntry): LogItem {
  return { kind: 'line', key: entry.cursor, entry, repeat: 1, last: entry }
}

/** A row for an edge; one of each at most, so its key is its name. */
export function edgeItem(edge: LogEdge): LogItem {
  return { kind: 'edge', key: `edge:${edge}`, edge }
}

/** A row's key in the feed store. */
export const itemKey = (item: LogItem) => item.key

function samePayload(a: LogEntry['payload'], b: LogEntry['payload']): boolean {
  if (a === undefined || b === undefined) return a === b
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Whether `next` is the same line as `previous` printed again: the same
 * service, level, function, invocation, source, message and payload. A
 * marker line (a reload, a reset) never groups: each is a moment.
 */
export function sameLine(previous: LogEntry, next: LogEntry): boolean {
  return (
    previous.message === next.message &&
    previous.level === next.level &&
    previous.service === next.service &&
    previous.function === next.function &&
    previous.execution === next.execution &&
    previous.source === next.source &&
    previous.kind === next.kind &&
    !isMarkerKind(next.kind) &&
    samePayload(previous.payload, next.payload)
  )
}

/** `run` with `entry` added to it. */
function grown(run: Extract<LogItem, { kind: 'line' }>, entry: LogEntry): LogItem {
  return { ...run, repeat: run.repeat + 1, last: entry }
}

/**
 * Lines as rows, oldest first, consecutive repeats grouped. `previous` is
 * the row the lines follow (the feed's newest): when the first lines repeat
 * it, `replaced` is that row grown, to put in its place.
 */
export function groupLines(
  entries: readonly LogEntry[],
  previous?: LogItem,
): { replaced: LogItem | undefined; rows: LogItem[] } {
  let replaced: LogItem | undefined
  const rows: LogItem[] = []
  for (const entry of entries) {
    const last = rows.at(-1) ?? replaced ?? previous
    if (last?.kind === 'line' && sameLine(last.last, entry)) {
      const next = grown(last, entry)
      if (rows.length > 0) rows[rows.length - 1] = next
      else replaced = next
      continue
    }
    rows.push(lineItem(entry))
  }
  return { replaced, rows }
}

/** Every line a row stands for, oldest first: the run's first and newest. */
export function rowEntries(item: LogItem): LogEntry[] {
  if (item.kind !== 'line') return []
  return item.repeat > 1 ? [item.entry, item.last] : [item.entry]
}

/** The sequence number of a cursor (`<epoch>.<seq>`), and its epoch; undefined when it is not one. */
export function cursorParts(cursor: string): { epoch: string; seq: number } | undefined {
  const dot = cursor.lastIndexOf('.')
  if (dot <= 0) return undefined
  const seq = Number(cursor.slice(dot + 1))
  return Number.isSafeInteger(seq) ? { epoch: cursor.slice(0, dot), seq } : undefined
}

/**
 * Whether the line at `cursor` was logged after `mark` by this engine run:
 * a mark from another run is before every line of this one.
 */
export function isAfter(cursor: string, mark: string): boolean {
  const line = cursorParts(cursor)
  const seen = cursorParts(mark)
  if (!line || !seen) return false
  return line.epoch !== seen.epoch || line.seq > seen.seq
}
