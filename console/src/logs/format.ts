// Log lines as text for the clipboard, in the engine's export format (the
// text download, `observe/logs.rs`): the time, the level in capitals padded
// to five, where it came from, the message with its later lines indented,
// and the payload's JSON on the next line. A pasted line reads the same as
// a downloaded one.
//
// The time follows the console-wide clock format (`lib/format.ts`) where a
// copy can carry it: the local clock or the UTC instant. "3 s ago" is
// stale the moment it is pasted, so the relative format copies the instant.

import type { LogEntry } from '@/api/generated/observe/LogEntry'
import { type ClockFormat, formatClock } from '@/lib/format'

const INDENT = '    '

/** The time a copied line carries: the clock, or the UTC instant. */
export function copiedTime(time: string, format: ClockFormat): string {
  if (format === 'time') return formatClock(time, 'time')
  return formatClock(time, 'utc')
}

/** One line as text, as the engine's text download writes it (with the chosen clock). */
export function entryAsText(entry: LogEntry, format: ClockFormat = 'utc'): string {
  const level = entry.level.toUpperCase().padEnd(5)
  const source = entry.source ?? entry.service
  const message = entry.message.split(/\r?\n/).join(`\n${INDENT}`)
  const head = `${copiedTime(entry.time, format)} ${level} ${source} ${message}`
  return entry.payload === undefined ? head : `${head}\n${INDENT}${JSON.stringify(entry.payload)}`
}

/** Lines as text, one after another. */
export function entriesAsText(entries: readonly LogEntry[], format: ClockFormat = 'utc'): string {
  return entries.map((entry) => entryAsText(entry, format)).join('\n')
}

/** One line as JSON, as the engine sent it: what "Copy JSON" puts on the clipboard. */
export function entryAsJson(entry: LogEntry): string {
  return JSON.stringify(entry, null, 2)
}

/** Lines as NDJSON, one `LogEntry` per line: the NDJSON download's shape. */
export function entriesAsNdjson(entries: readonly LogEntry[]): string {
  return entries.map((entry) => JSON.stringify(entry)).join('\n')
}
