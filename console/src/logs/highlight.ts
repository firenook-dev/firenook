// Where the filter's words, phrases and regular expressions occur in a
// line, so the row and the inspector can mark them. Only what the filter
// asks to find is marked: excluded items (`-"heartbeat ok"`) match nothing
// on screen by definition, and a key's value (`function:hello`) is matched
// by its field, not by the text.
//
// Words and phrases match as the engine matches them, case-insensitively;
// a regular expression is the engine's (Rust's syntax), and is marked only
// when it means the same thing in JavaScript — a construct only Rust reads
// (inline flags, POSIX classes, `\A` and `\z`, named groups written
// `(?P<…>)`) marks nothing rather than something wrong.

import { parseFilter } from '@/lib/filter'

/** Offsets into a string, UTF-16, end exclusive. */
export type Range = readonly [from: number, to: number]

/** What finds the filter's text in a line; `undefined` when the filter finds no text. */
export interface Highlighter {
  ranges(text: string): Range[]
}

function escape(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
}

/** Constructs Rust's regex syntax reads and JavaScript reads differently or not at all. */
const RUST_ONLY = /\(\?[a-zA-Z-]+[:)]|\(\?P<|\[\[:|\\[AzZ]|&&|~~/

/** A JavaScript regex that finds what the engine's would, or undefined when there is none. */
export function portableRegex(pattern: string, caseInsensitive: boolean): RegExp | undefined {
  if (RUST_ONLY.test(pattern)) return undefined
  try {
    const regex = new RegExp(pattern, `gu${caseInsensitive ? 'i' : ''}`)
    // A pattern that matches the empty string would mark nothing useful.
    return regex.test('') ? undefined : regex
  } catch {
    return undefined
  }
}

/** Every range `regex` matches in `text`. */
function matches(regex: RegExp, text: string): Range[] {
  const found: Range[] = []
  regex.lastIndex = 0
  for (const match of text.matchAll(regex)) {
    if (match[0] === '') continue
    found.push([match.index, match.index + match[0].length])
  }
  return found
}

/** Ranges sorted and merged where they overlap or touch. */
export function mergeRanges(ranges: readonly Range[]): Range[] {
  const sorted = [...ranges].toSorted((a, b) => a[0] - b[0] || a[1] - b[1])
  const merged: [number, number][] = []
  for (const [from, to] of sorted) {
    const last = merged.at(-1)
    if (last && from <= last[1]) last[1] = Math.max(last[1], to)
    else merged.push([from, to])
  }
  return merged
}

/** What finds the text a filter searches for, or undefined when it searches for none. */
export function highlighter(q: string): Highlighter | undefined {
  const parsed = parseFilter(q, true)
  if (!parsed.ok) return undefined
  const finders: RegExp[] = []
  for (const word of parsed.query.words)
    if (!word.negated && word.text !== '') finders.push(new RegExp(escape(word.text), 'giu'))
  for (const item of parsed.query.regexes) {
    if (item.negated) continue
    const regex = portableRegex(item.pattern, item.caseInsensitive)
    if (regex) finders.push(regex)
  }
  if (finders.length === 0) return undefined
  return {
    ranges: (text) => mergeRanges(finders.flatMap((finder) => matches(finder, text))),
  }
}
