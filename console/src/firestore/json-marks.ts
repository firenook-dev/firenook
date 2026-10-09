// What the JSON does not say about itself.
//
// Six of Firestore's eleven types have no way of being written in JSON: a
// timestamp and a reference are strings, bytes are a string, a geopoint is
// a two-key map, a vector is an array of numbers, and a double that reads
// whole — 269.0 — is written `269`, which is also how an integer is
// written. The rows behind the text carry those types through a round
// trip, as long as the JSON still agrees with them.
//
// That used to be a sentence of grey prose under the box, which is the
// right fact in the wrong place: it is true of three lines out of thirty
// and the reader has to work out which three. Here it is a mark on each
// of those three.

import type { CodeMark } from '@/components/code-editor/props'
import { type DraftNode, parseNode } from './draft'
import type { FirestoreValueType } from './value'

/**
 * Paths are joined on a character no key can contain, so a field
 * literally called `a.b` can never be mistaken for `b` inside `a`.
 */
const SEP = '\u0000'

const CARRIED: Partial<Record<FirestoreValueType, string>> = {
  timestamp: 'a timestamp',
  reference: 'a reference',
  bytes: 'bytes',
  geopoint: 'a geopoint',
  vector: 'a vector',
}

/**
 * Every value the rows type more precisely than the text can, by path.
 * A double is in here only when it reads like an integer: `1.5` is a
 * double to JSON as well, and needs no help.
 */
export function carriedTypes(nodes: readonly DraftNode[]): Map<string, string> {
  const found = new Map<string, string>()
  walk(nodes, true, [], found)
  return found
}

function walk(
  nodes: readonly DraftNode[],
  named: boolean,
  path: readonly string[],
  found: Map<string, string>,
): void {
  nodes.forEach((node, index) => {
    if (node.removed === true) return
    const here = [...path, named ? node.name : String(index)]
    const key = here.join(SEP)
    const carried = CARRIED[node.type]
    if (carried) {
      found.set(key, carried)
      return
    }
    if (node.type === 'number') {
      const parsed = parseNode(node)
      if (parsed.ok && parsed.value.type === 'number') {
        const { value, integer } = parsed.value
        if (!integer && Number.isInteger(value)) found.set(key, 'a double')
      }
      return
    }
    // A subtree being hand-edited as JSON holds its value in its text,
    // not in children that may no longer describe it.
    if ((node.type === 'map' || node.type === 'array') && node.raw !== true)
      walk(node.children, node.type === 'map', here, found)
  })
}

/**
 * Where every value of a JSON document starts and ends, by the same path.
 *
 * A scanner rather than `JSON.parse`, because the positions are the whole
 * point and `JSON.parse` throws them away. It is deliberately forgiving:
 * the text is being typed, so it stops at the first thing it cannot read
 * and returns what it found up to there, and the marks for the rest of
 * the document simply do not appear until it parses again.
 */
export function valueSpans(text: string): Map<string, { from: number; to: number }> {
  const spans = new Map<string, { from: number; to: number }>()
  let at = 0

  const space = () => {
    while (
      at < text.length &&
      (text[at] === ' ' || text[at] === '\n' || text[at] === '\r' || text[at] === '\t')
    )
      at += 1
  }

  /** Past the closing quote of the string starting at `at`. */
  const quoted = (): string | undefined => {
    const from = at
    at += 1
    while (at < text.length) {
      const char = text[at]
      at += 1
      if (char === '\\') at += 1
      else if (char === '"') {
        try {
          return JSON.parse(text.slice(from, at)) as string
        } catch {
          return undefined
        }
      }
    }
    return undefined
  }

  /** True while the scan is still making sense. */
  const value = (path: readonly string[]): boolean => {
    space()
    const from = at
    const char = text[at]
    let ok = true
    if (char === '{') {
      at += 1
      ok = object(path)
    } else if (char === '[') {
      at += 1
      ok = array(path)
    } else if (char === '"') {
      ok = quoted() !== undefined
    } else {
      const start = at
      while (at < text.length && !',]} \n\r\t'.includes(text[at] as string)) at += 1
      ok = at > start
    }
    // Only what was actually read. A value the scan ran out of text in
    // the middle of — `{"a": 1, "b": `, a document halfway through being
    // typed — would otherwise record an empty span at the end of the
    // text, and a mark on it would be a marker on nothing.
    if (ok && path.length > 0) spans.set(path.join(SEP), { from, to: at })
    return ok
  }

  const object = (path: readonly string[]): boolean => {
    space()
    if (text[at] === '}') {
      at += 1
      return true
    }
    for (;;) {
      space()
      if (text[at] !== '"') return false
      const key = quoted()
      if (key === undefined) return false
      space()
      if (text[at] !== ':') return false
      at += 1
      if (!value([...path, key])) return false
      space()
      if (text[at] === ',') {
        at += 1
        continue
      }
      if (text[at] === '}') {
        at += 1
        return true
      }
      return false
    }
  }

  const array = (path: readonly string[]): boolean => {
    space()
    if (text[at] === ']') {
      at += 1
      return true
    }
    for (let index = 0; ; index += 1) {
      if (!value([...path, String(index)])) return false
      space()
      if (text[at] === ',') {
        at += 1
        continue
      }
      if (text[at] === ']') {
        at += 1
        return true
      }
      return false
    }
  }

  value([])
  return spans
}

/**
 * The marks for one document: one on each value whose type the text
 * alone would lose, saying what is holding it and what would drop it.
 */
export function typeMarks(text: string, nodes: readonly DraftNode[]): CodeMark[] {
  const carried = carriedTypes(nodes)
  if (carried.size === 0) return []
  const spans = valueSpans(text)
  const marks: CodeMark[] = []
  for (const [path, what] of carried) {
    const span = spans.get(path)
    if (!span) continue
    // A geopoint and a vector are written as a map and an array, so
    // their span covers every line of them; underlining four lines to
    // say one thing about the value they make up reads as damage. The
    // mark stops at the end of its first line, which is also the line
    // the gutter marker lands on.
    const wraps = text.indexOf('\n', span.from)
    const to = wraps === -1 ? span.to : Math.min(span.to, wraps)
    marks.push({
      from: span.from,
      to,
      severity: 'info',
      message: `Stays ${what}. JSON has no way of writing one down, so the row behind this line is what carries the type — change this value and it becomes what it looks like.`,
    })
  }
  return marks
}
