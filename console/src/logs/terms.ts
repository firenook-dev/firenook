// The filter items the page writes for the developer: a payload value
// ("filter" on a tree's leaf), "Hide lines like this", "Show this
// invocation", a source chip's token. Each is written so it parses back to
// itself, and added to what is typed without touching the rest of it.

import { filterValueText, parseFilter, quoteFilterText } from '@/lib/filter'
import type { JsonPath } from '@/components/console/json-tree-model'

/** How much of a message "Hide lines like this" excludes. */
export const HIDE_PREFIX = 60

/** A path segment the filter's `payload.` key can write: letters, digits, `_` and `-`. */
const SEGMENT = /^[\w-]+$/

/**
 * `payload.cartId:"c_19"` for a value at `path`: a string quoted (the
 * engine compares it as the string), anything else as its JSON. Undefined
 * when a segment cannot be written in a key (a dot or a space in it).
 */
export function payloadTerm(path: JsonPath, value: unknown): string | undefined {
  if (path.length === 0) return undefined
  const segments = path.map(String)
  if (!segments.every((segment) => SEGMENT.test(segment))) return undefined
  const key = `payload.${segments.join('.')}`
  if (typeof value === 'string') return `${key}:${quoteFilterText(value)}`
  if (value === null || typeof value === 'number' || typeof value === 'boolean')
    return `${key}:${JSON.stringify(value)}`
  return undefined
}

/** A value searched as text, for one a payload key cannot reach. */
export function phraseTerm(value: unknown): string {
  return quoteFilterText(typeof value === 'string' ? value : JSON.stringify(value))
}

/** `-"<the message's first 60 characters>"`: the lines that start alike leave the view. */
export function hideLikeTerm(message: string): string {
  const first = message.split(/\r?\n/, 1)[0] ?? ''
  const prefix = Array.from(first.trim()).slice(0, HIDE_PREFIX).join('')
  return `-${quoteFilterText(prefix)}`
}

/** `execution:<id>`: one invocation's lines. */
export function executionTerm(execution: string): string {
  return `execution:${filterValueText(execution)}`
}

/** The items of a filter as they are written, for telling whether one is there already. */
function items(q: string): string[] {
  const parsed = parseFilter(q, true)
  if (!parsed.ok) return []
  const { terms, words, regexes } = parsed.query
  return [...terms, ...words, ...regexes].map((item) => q.slice(item.from, item.to))
}

/** `q` with `term` added at its end, unless it holds that item already. */
export function addTerm(q: string, term: string): string {
  if (items(q).includes(term)) return q
  const base = q.trimEnd()
  return base === '' ? term : `${base} ${term}`
}

/** The two level views a key flips to: errors only (`e`), warnings and errors (`w`). */
export const LEVEL_VIEWS = {
  errors: 'level:error',
  problems: 'level:warn level:error',
} as const

/**
 * `e` and `w`: the level view, or back to the filter it replaced when it
 * is already the view. `previous` is what the page held before.
 */
export function flipLevelView(
  q: string,
  view: string,
  previous: string | undefined,
): { q: string; previous: string | undefined } {
  if (q.trim() === view) return { q: previous ?? '', previous: undefined }
  return { q: view, previous: q }
}
