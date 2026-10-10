// What the JSON does not say about itself.
//
// Six of Firestore's eleven types have no way of being written plainly in
// JSON: a timestamp and a reference are strings, bytes are a string, a
// geopoint is a two-key map, a vector is a marked one, and a double that
// reads whole — 269.0 — is written `269`, which is also how an integer is
// written.
//
// Two different things rescue those types, and the difference is the only
// thing a reader of the JSON actually needs, because it decides what
// happens when they edit the line. Measured, by editing each one and
// saving:
//
//   The text holds it. The value is written in a way the editor reads
//   back — an ISO date, a `{latitude, longitude}` pair, a `.0` on the
//   end. Edit it to another date and it is still a timestamp; rename the
//   key and it is still a timestamp. Nothing to warn about.
//
//   Only the saved field holds it. Nothing in the text says so — one
//   base64 string looks like any other, one document path like any
//   other, `269` like an integer. The stored field is the last thing
//   that knows, and *any* change to the value loses it, including
//   replacing it with an equally valid base64 string.
//
// Both are marked, and the second one is the only one that carries a
// warning. An earlier version gave every mark the warning, which told a
// reader that editing a timestamp would cost them the type when it would
// not, and said it in terms of "the row behind this line" — a thing the
// JSON tab does not show.

import type { CodeMark } from '@/components/code-editor/props'
import { type DraftNode, parseNode } from './draft'
import { SEP, valueSpans, writtenAsDouble } from './json-text'
import { type FirestoreValueType, type FsValue, INFER, fromJson } from './value'

type Kind = 'timestamp' | 'reference' | 'bytes' | 'geopoint' | 'vector' | 'double'

const KINDS: Partial<Record<FirestoreValueType, Kind>> = {
  timestamp: 'timestamp',
  reference: 'reference',
  bytes: 'bytes',
  geopoint: 'geopoint',
  vector: 'vector',
}

/**
 * For each kind: what to call it, what a reader would otherwise take it
 * for, and what it comes back as once nothing is holding it.
 */
const SAYS: Record<Kind, { is: string; looks: string; plain: string }> = {
  timestamp: { is: 'A timestamp', looks: 'the string it looks like', plain: 'a string' },
  reference: { is: 'A reference', looks: 'the string it looks like', plain: 'a string' },
  bytes: { is: 'Bytes', looks: 'the string they look like', plain: 'a string' },
  geopoint: { is: 'A geopoint', looks: 'the map it looks like', plain: 'a map' },
  vector: { is: 'A vector', looks: 'the map it looks like', plain: 'a map' },
  double: { is: 'A double', looks: 'the integer it looks like', plain: 'an integer' },
}

/**
 * Every value the rows type more precisely than the text can, by path.
 * A double is in here only when it reads like an integer: `1.5` is a
 * double to JSON as well, and needs no help.
 */
export function carriedTypes(nodes: readonly DraftNode[]): Map<string, Kind> {
  const found = new Map<string, Kind>()
  walk(nodes, true, [], found)
  return found
}

function walk(
  nodes: readonly DraftNode[],
  named: boolean,
  path: readonly string[],
  found: Map<string, Kind>,
): void {
  nodes.forEach((node, index) => {
    if (node.removed === true) return
    const here = [...path, named ? node.name : String(index)]
    const key = here.join(SEP)
    const carried = KINDS[node.type]
    if (carried) {
      found.set(key, carried)
      return
    }
    if (node.type === 'number') {
      const parsed = parseNode(node)
      if (parsed.ok && parsed.value.type === 'number') {
        const { value, integer } = parsed.value
        if (!integer && Number.isInteger(value)) found.set(key, 'double')
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
export function inferredTypes(text: string): Map<string, Kind> {
  const found = new Map<string, Kind>()
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
      found.set(path, 'double')
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
  found: Map<string, Kind>,
): void {
  if (rich.type !== plain.type) {
    const kind = KINDS[rich.type]
    if (kind && path.length > 0) found.set(path.join(SEP), kind)
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
    // The text wins where it has something to say, because the text is
    // what will be read back on Save: a timestamp whose value has been
    // replaced with a `{latitude, longitude}` pair saves as a geopoint,
    // whatever the stored field still says.
    const kind = inferred.get(path) ?? carried.get(path)
    if (kind === undefined) continue
    const says = SAYS[kind]
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
      message: inferred.has(path)
        ? `${says.is}, not ${says.looks}. The value is written so that it reads as one, so that is what it saves as.`
        : `${says.is}, not ${says.looks}. JSON has no way of writing that down, so only the saved field still knows — change this value and it saves as ${says.plain}.`,
    })
  }
  return marks
}
