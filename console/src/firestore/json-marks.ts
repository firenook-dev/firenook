// What the JSON does not say about itself.
//
// Six of Firestore's eleven types have no way of being written plainly in
// JSON: a timestamp and a reference are strings, bytes are a string, a
// geopoint is a two-key map, a vector is a marked one, and a double that
// reads whole — 269.0 — is written `269`, which is also how an integer is
// written.
//
// Most of them need no help, because the editor reads them back out of
// the text. Measured, by editing each one in this tab and saving: a
// timestamp written as an ISO date, a geopoint written as a
// `{latitude, longitude}` pair, a vector written with its marker and a
// double written `3.0` all come back as themselves, and so does the
// whole document if you edit some other field or press Format.
//
// Three do not. Nothing in the text says that one base64 string is
// bytes rather than a string, that one path is a reference, or that
// `269` is a double. Edit one of those values here and it saves as what
// it looks like — `d29ybGQ=` is perfectly good base64 and still comes
// back a string.
//
// So a mark means exactly one thing: **edit this value here and it will
// not be this type any more.** Nothing else is marked, because nothing
// else has anything to tell. An earlier version marked all six and
// explained the mechanism behind each, which on a document of
// timestamps put a box and three lines of prose beside four values that
// were in no danger at all — and taught a reader to ignore the mark
// before meeting the one case that mattered.

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
 * For each kind: what to call it, why the text cannot say so — the
 * concrete reason, which is the half that makes it land — and what the
 * value comes back as once nothing is holding the type.
 *
 * Only bytes, a reference and a whole double reach a reader in the
 * ordinary way. The other three are here for the one case that can
 * still raise them: a value hand-edited until the editor no longer
 * reads it back, a `{latitude, longitude}` pair given a third key.
 */
const SAYS: Record<Kind, { is: string; because: (literal: string) => string; plain: string }> = {
  bytes: {
    is: 'Bytes',
    because: () => 'one base64 string looks like any other',
    plain: 'a string',
  },
  reference: {
    is: 'A reference',
    because: () => 'one document path looks like any other',
    plain: 'a string',
  },
  double: {
    is: 'A double',
    because: (literal) => `${literal} is also how an integer is written`,
    plain: 'an integer',
  },
  timestamp: {
    is: 'A timestamp',
    because: () => 'this no longer reads as a date',
    plain: 'a string',
  },
  geopoint: {
    is: 'A geopoint',
    because: () => 'this is no longer a plain latitude and longitude',
    plain: 'a map',
  },
  vector: {
    is: 'A vector',
    because: () => 'this no longer carries the marker that says so',
    plain: 'a map',
  },
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
 * The marks for one document: one on each value whose stored type the
 * text cannot hold on its own, which is the only case where editing the
 * line costs something.
 *
 * Worked out by subtraction rather than from a list of three, so that
 * teaching the editor to read one of these back out of the text also
 * stops it being marked, with nothing here to keep in step.
 */
export function typeMarks(text: string, nodes: readonly DraftNode[]): CodeMark[] {
  const carried = carriedTypes(nodes)
  if (carried.size === 0) return []
  const inferred = inferredTypes(text)
  const marks: CodeMark[] = []
  for (const [path, span] of valueSpans(text)) {
    const kind = carried.get(path)
    // Held by the text, so editing it keeps it. Nothing to say.
    if (kind === undefined || inferred.has(path)) continue
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
      message:
        `${says.is} — ${says.because(text.slice(span.from, to))}, ` +
        `so editing this value here saves it as ${says.plain}. ` +
        'The Fields tab keeps the type.',
    })
  }
  return marks
}
