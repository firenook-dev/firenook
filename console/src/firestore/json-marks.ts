// What the JSON does not say about itself.
//
// Six of Firestore's eleven types have no way of being written plainly in
// JSON: a timestamp and a reference are strings, bytes are a string, a
// geopoint is a two-key map, a vector is a marked one, and a double that
// reads whole — 269.0 — is written `269`, which is also how an integer is
// written.
//
// Two different things rescue those types, and a reader needs to tell
// them apart, because only one is undone by editing the line.
//
//   Carried — the row behind the line already has the type and the text
//   still agrees with it, so the row is kept whole. Change the text and
//   the type is gone.
//
//   Read — nothing behind the line had a type, and the text itself says
//   enough: `3.0` was written with a point, `{latitude, longitude}` is
//   the shape this console writes a geopoint in. The row is being given
//   a type the plain reading of JSON would not have produced.
//
// Both are marked, in different words, on the value they are true of.

import type { CodeMark } from '@/components/code-editor/props'
import { type DraftNode, parseNode } from './draft'
import { SEP, valueSpans, writtenAsDouble } from './json-text'
import { type FirestoreValueType, type FsValue, INFER, fromJson } from './value'

const NAMES: Partial<Record<FirestoreValueType, string>> = {
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
    const carried = NAMES[node.type]
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
 * Every value the text alone is read as something richer than plain
 * JSON, by path.
 *
 * Worked out by parsing twice — once reading everything it can, once
 * reading nothing — and reporting where the two disagree. There is no
 * second copy of the rules here, only a comparison of the one copy's
 * output, so this cannot drift from what the editor actually does.
 */
export function inferredTypes(text: string): Map<string, string> {
  const found = new Map<string, string>()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return found
  }
  compare(fromJson(parsed, INFER), fromJson(parsed, {}), [], found)

  // And the one no parser can see, because `JSON.parse` has already
  // thrown the characters away: a whole number written with a point is
  // a double, which is not inference but literacy.
  //
  // Only the spans that hold numbers. Testing every span for a `.` or
  // an `e` reads the `e` in "latitude" and calls the map a double.
  const spans = valueSpans(text)
  for (const path of numberPaths(fromJson(parsed, INFER), [])) {
    const span = spans.get(path)
    if (span && writtenAsDouble(text.slice(span.from, span.to)) && !found.has(path))
      found.set(path, 'a double')
  }
  return found
}

/** Where the numbers are, so only their literals are read. */
function numberPaths(value: FsValue, path: readonly string[]): string[] {
  if (value.type === 'number') return path.length > 0 ? [path.join(SEP)] : []
  if (value.type === 'map')
    return Object.entries(value.fields).flatMap(([key, item]) => numberPaths(item, [...path, key]))
  if (value.type === 'array')
    return value.items.flatMap((item, index) => numberPaths(item, [...path, String(index)]))
  return []
}

function compare(
  rich: FsValue,
  plain: FsValue,
  path: readonly string[],
  found: Map<string, string>,
): void {
  if (rich.type !== plain.type) {
    const name = NAMES[rich.type]
    if (name && path.length > 0) found.set(path.join(SEP), name)
    return
  }
  if (rich.type === 'map' && plain.type === 'map')
    for (const [key, value] of Object.entries(rich.fields)) {
      const other = plain.fields[key]
      if (other) compare(value, other, [...path, key], found)
    }
  if (rich.type === 'array' && plain.type === 'array')
    rich.items.forEach((item, index) => {
      const other = plain.items[index]
      if (other) compare(item, other, [...path, String(index)], found)
    })
}

/**
 * The marks for one document: one on each value whose type the plain
 * reading of the text would not give it, saying which of the two things
 * is holding it — because only one of them survives being edited.
 */
export function typeMarks(text: string, nodes: readonly DraftNode[]): CodeMark[] {
  const carried = carriedTypes(nodes)
  const inferred = inferredTypes(text)
  if (carried.size === 0 && inferred.size === 0) return []
  const marks: CodeMark[] = []
  for (const [path, span] of valueSpans(text)) {
    // The row wins where there is one. A value the text could be read
    // as a timestamp and that already is one is simply one, and the
    // thing worth saying is that editing it would end that.
    const holding = carried.get(path)
    const reading = inferred.get(path)
    if (holding === undefined && reading === undefined) continue
    // A geopoint and a vector are written over several lines, so their
    // span covers every line of them; underlining four lines to say one
    // thing about the value they make up reads as damage. The mark stops
    // at the end of its first line, which is also the line the gutter
    // marker lands on.
    const wraps = text.indexOf('\n', span.from)
    const to = wraps === -1 ? span.to : Math.min(span.to, wraps)
    marks.push({
      from: span.from,
      to,
      severity: 'info',
      message:
        holding === undefined
          ? `Read as ${reading}. Plain JSON has no way of saying so, but this text does, so the row will hold ${reading} rather than what JSON alone would make of it.`
          : `Stays ${holding}. JSON has no way of writing one down, so the row behind this line is what carries the type — change this value and it becomes what it looks like.`,
    })
  }
  return marks
}
