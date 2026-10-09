// The document being edited, as a tree.
//
// A field, a map entry and an array element are the same thing — a name, a
// type, a value — so they are one node and the editor is one component that
// recurses. That is the whole point of the model: the case a form beats raw
// JSON at is nested structure, and a panel that drops to a JSON textarea the
// moment a value stops being flat has given up exactly where it was needed.
//
// Everything here is pure: building the tree from a document, parsing it
// back, saying what is wrong with it, and working out the single write that
// saves it. The components hold a `DraftNode[]` and nothing else.

import {
  type FirestoreValueType,
  type FsValue,
  editorText,
  emptyValue,
  fieldsToJson,
  fromJson,
  parseEditorText,
} from './value'

export interface DraftNode {
  /** Identity for React and for focus. Never the name, which is editable. */
  id: string
  /** The key this node is stored under; an array item carries '' and is numbered. */
  name: string
  type: FirestoreValueType
  /** The scalar as typed. A container leaves it empty unless `raw` is set. */
  text: string
  /** A map's entries or an array's items, in order. */
  children: DraftNode[]
  /**
   * Write the number as an integer. Firestore's `integer` and `double` are
   * different types and `3` is how both of them are written, so the text
   * cannot say which this is and the node has to carry it.
   */
  integer?: boolean | undefined
  /** The subtree is being hand-edited as JSON, which `text` holds. */
  raw?: boolean | undefined
  /** A string edited in a box rather than on a line. */
  wide?: boolean | undefined
  /** Text this node held under another type, so changing back costs nothing. */
  memory?: Partial<Record<FirestoreValueType, string>> | undefined
  /** Marked for deletion: still on screen, with its undo, until save. */
  removed?: boolean | undefined
  /** The name the document holds this field under; absent on a new field. */
  was?: string | undefined
}

let counter = 0

/** A fresh node identity. Stable across edits, unlike the name. */
export function nodeId(): string {
  counter += 1
  return `f${counter}`
}

export function nodeFrom(name: string, value: FsValue): DraftNode {
  const container = value.type === 'map' || value.type === 'array'
  const node: DraftNode = {
    id: nodeId(),
    name,
    type: value.type,
    text: container ? '' : editorText(value),
    children: [],
  }
  if (value.type === 'map')
    node.children = Object.entries(value.fields).map(([key, item]) => nodeFrom(key, item))
  if (value.type === 'array') node.children = value.items.map((item) => nodeFrom('', item))
  if (value.type === 'number') node.integer = value.integer
  return node
}

/**
 * The fields of a document as rows. `stored` records the name each field
 * arrived under, which is what makes a rename tellable from a new field.
 */
export function nodesFrom(fields: Record<string, FsValue>, stored = false): DraftNode[] {
  const nodes: DraftNode[] = []
  for (const [name, value] of Object.entries(fields)) {
    const node = nodeFrom(name, value)
    if (stored) node.was = name
    nodes.push(node)
  }
  return nodes
}

export function emptyNode(name: string, type: FirestoreValueType): DraftNode {
  return nodeFrom(name, emptyValue(type))
}

/**
 * The same node under another type. What was typed is kept when the new type
 * can read it and remembered either way, so looking at a value as a number
 * and changing your mind costs nothing. Children survive untouched: a map
 * glanced at as a string is still that map on the way back.
 */
export function retype(node: DraftNode, type: FirestoreValueType): DraftNode {
  if (type === node.type) return node
  const remembered = node.memory?.[type]
  // A null has no text of its own: the word is how the type is drawn, not
  // a value anyone typed. Carrying it over makes the string `"null"`,
  // which is never what was meant and is indistinguishable afterwards
  // from a field that genuinely holds that word.
  const carried = node.type === 'null' ? '' : node.text
  const text =
    remembered ?? (parseEditorText(type, carried).ok ? carried : editorText(emptyValue(type)))
  const next: DraftNode = {
    ...node,
    type,
    text,
    memory: node.type === 'null' ? node.memory : { ...node.memory, [node.type]: node.text },
  }
  if (type === 'number') next.integer = isIntegral(text)
  return next
}

function isIntegral(text: string): boolean {
  return /^-?\d+$/.test(text.trim())
}

/** How a number node is written, and whether that is still the node's to choose. */
export function numberForm(node: DraftNode): { integer: boolean; forced: boolean } {
  if (!isIntegral(node.text)) return { integer: false, forced: true }
  return { integer: node.integer !== false, forced: false }
}

export type Parsed = { ok: true; value: FsValue } | { ok: false; error: string }

/** The value a node stands for, children and all. */
export function parseNode(node: DraftNode): Parsed {
  switch (node.type) {
    case 'map': {
      if (node.raw) return parseRaw(node)
      const fields: Record<string, FsValue> = {}
      for (const child of node.children) {
        if (child.removed) continue
        const name = child.name.trim()
        if (!name) return { ok: false, error: 'An entry needs a name' }
        const parsed = parseNode(child)
        if (!parsed.ok) return parsed
        fields[name] = parsed.value
      }
      return { ok: true, value: { type: 'map', fields } }
    }
    case 'array': {
      if (node.raw) return parseRaw(node)
      const items: FsValue[] = []
      for (const child of node.children) {
        if (child.removed) continue
        const parsed = parseNode(child)
        if (!parsed.ok) return parsed
        items.push(parsed.value)
      }
      return { ok: true, value: { type: 'array', items } }
    }
    case 'number': {
      const parsed = parseEditorText('number', node.text)
      if (!parsed.ok || parsed.value.type !== 'number') return parsed
      return { ok: true, value: { ...parsed.value, integer: numberForm(node).integer } }
    }
    default:
      return parseEditorText(node.type, node.text)
  }
}

/**
 * A container being hand-edited as JSON, read back through its own rows.
 *
 * Parsing the text straight to a value loses every type JSON cannot write
 * down — a timestamp and a reference both come back strings — so a map
 * merely *looked* at as JSON would save as a different map. Going through
 * the rows instead lets `agrees` keep the node that was already there
 * wherever the JSON still describes it, which is the same round trip the
 * document's own JSON tab makes.
 */
function parseRaw(node: DraftNode): Parsed {
  const rebuilt = rawChildren(node)
  if (!rebuilt.ok) return rebuilt
  return parseNode({ ...node, raw: false, text: '', children: rebuilt.children })
}

type Rebuilt = { ok: true; children: DraftNode[] } | { ok: false; error: string }

/** The rows a container's raw JSON stands for, or why it stands for none. */
function rawChildren(node: DraftNode): Rebuilt {
  const parsed = parseEditorText(node.type, node.text)
  if (!parsed.ok) return parsed
  if (parsed.value.type === 'map')
    return { ok: true, children: mapEntries(parsed.value.fields, node.children) }
  if (parsed.value.type === 'array')
    return { ok: true, children: itemNodes(parsed.value.items, node.children) }
  return { ok: false, error: `A ${node.type} needs JSON of the same shape` }
}

/**
 * Rows and JSON, the one swapped for the other.
 *
 * It used to flip the flag and nothing else. A container's `text` is empty
 * — the children are the value — so opening the JSON view showed `{}` for
 * a map with fields in it, marked the field changed, and would have
 * written that empty map on the next Save. Going back discarded whatever
 * had been typed, for the same reason in reverse.
 */
export function toggleRaw(node: DraftNode): DraftNode {
  if (node.raw !== true) return { ...node, raw: true, text: containerJson(node) }
  const rebuilt = rawChildren(node)
  // Rows cannot be built from JSON that does not parse. The row already
  // says so underneath it, and the text is worth more than the view.
  if (!rebuilt.ok) return node
  return { ...node, raw: false, text: '', children: rebuilt.children }
}

/** What a container's rows look like written out, for its JSON view. */
export function containerJson(node: DraftNode): string {
  const parsed = parseNode({ ...node, raw: false })
  if (parsed.ok) return JSON.stringify(toJsonValue(parsed.value), null, 2)
  // A subtree half-written is exactly when the escape hatch is wanted, so
  // a node that does not parse contributes its text rather than nothing.
  const live = node.children.filter((child) => child.removed !== true)
  if (node.type === 'array') return JSON.stringify(live.map(looseJson), null, 2)
  return JSON.stringify(nodesToJson(live), null, 2)
}

function looseJson(node: DraftNode): unknown {
  const parsed = parseNode(node)
  return parsed.ok ? toJsonValue(parsed.value) : node.text
}

export interface NodeProblem {
  /** Wrong with the name: it is missing, or the one beside it has it. */
  name?: string
  /** Wrong with the value as typed. */
  value?: string
}

/**
 * What is wrong, by node, as you type. Each problem lands on the row that
 * owns it rather than on the field at the top of the tree, so a broken
 * number three levels down is marked three levels down.
 */
export function problemsOf(nodes: readonly DraftNode[]): Map<string, NodeProblem> {
  const found = new Map<string, NodeProblem>()
  collect(nodes, true, found)
  return found
}

function collect(
  nodes: readonly DraftNode[],
  named: boolean,
  found: Map<string, NodeProblem>,
): void {
  const seen = new Set<string>()
  for (const node of nodes) {
    if (node.removed) continue
    const problem: NodeProblem = {}
    if (named) {
      const name = node.name.trim()
      if (!name) problem.name = 'A field needs a name'
      else if (seen.has(name)) problem.name = `${name} is already here`
      else seen.add(name)
    }
    const container = node.type === 'map' || node.type === 'array'
    if (container && !node.raw) collect(node.children, node.type === 'map', found)
    else {
      const parsed = parseEditorText(node.type, node.text)
      if (!parsed.ok) problem.value = parsed.error
    }
    if (problem.name !== undefined || problem.value !== undefined) found.set(node.id, problem)
  }
}

export interface DocumentDiff {
  /** Fields to write, by the name they are to be written under. */
  write: Record<string, FsValue>
  /** Field names to clear: fields removed, and the old names of renames. */
  clear: string[]
}

/**
 * The one write that turns the stored document into this tree. A field the
 * tree no longer names is cleared, which covers a removal and the far side
 * of a rename in the same rule, and an untouched field is not written at
 * all — so Save has something to do only when something really changed.
 */
export function diffDocument(
  original: Record<string, FsValue>,
  nodes: readonly DraftNode[],
): DocumentDiff {
  const write: Record<string, FsValue> = {}
  const live = new Set<string>()
  for (const node of nodes) {
    if (node.removed) continue
    const name = node.name.trim()
    const parsed = parseNode(node)
    if (!parsed.ok) continue
    live.add(name)
    // By the name it is *going* to have. That one lookup is the whole of
    // renaming: a field under a name the document does not hold yet has
    // nothing to be equal to, so it is written, and its old name falls out
    // of `live` and is cleared below.
    const before = original[name]
    if (!before || !sameValue(before, parsed.value)) write[name] = parsed.value
  }
  return { write, clear: Object.keys(original).filter((name) => !live.has(name)) }
}

/** Whether two values are the same value, map key order aside. */
export function sameValue(a: FsValue, b: FsValue): boolean {
  return canonical(a) === canonical(b)
}

function canonical(value: FsValue): string {
  switch (value.type) {
    case 'string':
      return `s${JSON.stringify(value.value)}`
    case 'number':
      return `${value.integer ? 'i' : 'd'}${value.value}`
    case 'boolean':
      return value.value ? 'true' : 'false'
    case 'timestamp':
      // By the instant, not by the text. The engine returns
      // `2026-11-01T00:00:00Z` and the editor writes
      // `2026-11-01T00:00:00.000Z`; comparing the strings made every
      // document with a whole-second timestamp in it look edited the
      // moment it was opened.
      return `t${instant(value.value)}`
    case 'reference':
      return `r${value.path}`
    case 'geopoint':
      return `g${value.latitude},${value.longitude}`
    case 'bytes':
      return `b${value.base64}`
    case 'vector':
      return `v${value.values.join(',')}`
    case 'null':
      return 'null'
    case 'map':
      return `{${sorted(Object.entries(value.fields))
        .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
        .join(',')}}`
    case 'array':
      return `[${value.items.map(canonical).join(',')}]`
  }
}

function instant(iso: string): string {
  const when = new Date(iso)
  return Number.isNaN(when.getTime()) ? iso : when.toISOString()
}

function sorted<T>(entries: [string, T][]): [string, T][] {
  return entries.toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
}

/** The JSON a value stands for: timestamps as ISO strings, references as paths. */
export function toJsonValue(value: FsValue): unknown {
  switch (value.type) {
    case 'timestamp':
      return value.value
    case 'reference':
      return value.path
    default:
      return fieldsToJson({ v: value }).v
  }
}

/** The tree as one JSON object; a node that does not parse contributes its text. */
export function nodesToJson(nodes: readonly DraftNode[]): Record<string, unknown> {
  const plain: Record<string, unknown> = {}
  for (const node of nodes) {
    if (node.removed) continue
    const parsed = parseNode(node)
    plain[node.name] = parsed.ok ? toJsonValue(parsed.value) : node.text
  }
  return plain
}

/**
 * JSON text → rows. A node whose value the JSON still agrees with is kept
 * whole, which is what carries the types JSON cannot write down — a
 * timestamp, a reference, a double that reads like an integer — through a
 * round trip. Fields the JSON does not mention are simply gone; the diff
 * clears them.
 */
export function nodesFromJson(text: string, current: readonly DraftNode[]): DraftNode[] {
  const parsed: unknown = JSON.parse(text)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('The document must be a JSON object')
  const value = fromJson(parsed)
  if (value.type !== 'map') throw new Error('The document must be a JSON object')
  return mapEntries(value.fields, current)
}

/** Named entries, keeping whichever rows the JSON still describes. */
function mapEntries(fields: Record<string, FsValue>, current: readonly DraftNode[]): DraftNode[] {
  const before = new Map(current.map((node) => [node.name, node]))
  const nodes: DraftNode[] = []
  for (const [name, item] of Object.entries(fields)) {
    const previous = before.get(name)
    if (previous && agrees(previous, item)) {
      nodes.push(previous.removed === true ? { ...previous, removed: false } : previous)
      continue
    }
    const node = nodeFrom(name, item)
    if (previous?.was !== undefined) node.was = previous.was
    nodes.push(node)
  }
  return nodes
}

/** The same, by position, for an array's items. */
function itemNodes(items: readonly FsValue[], current: readonly DraftNode[]): DraftNode[] {
  return items.map((item, index) => {
    const previous = current[index]
    return previous && agrees(previous, item) ? previous : nodeFrom('', item)
  })
}

function agrees(node: DraftNode, incoming: FsValue): boolean {
  const parsed = parseNode(node)
  return parsed.ok && stableJson(toJsonValue(parsed.value)) === stableJson(toJsonValue(incoming))
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value !== null && typeof value === 'object')
    return `{${sorted(Object.entries(value))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`
  return JSON.stringify(value) ?? 'null'
}
