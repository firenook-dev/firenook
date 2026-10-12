// What the JSON tree draws, worked out without a DOM: the rows a value
// flattens to under the open containers, the path of each in the form a
// developer types it (`data.items[0]["a-b"]`), what a search finds and which
// containers it has to open to show it. Pure, so the component is a
// virtualized list over this and the rules are unit-tested here.

/** A value's place in the tree: keys and indices from the root. */
export type JsonPath = readonly (string | number)[]

/** Children a container shows before "Show more": a 10,000-item array is not 10,000 rows at once. */
export const PAGE = 100
/** A string longer than this is cut, with how much more there is and "Show all". */
export const CUT_AT = 200
/** How far a search walks before it stops counting: a large payload must not freeze a keystroke. */
export const SEARCH_LIMIT = 200_000

/** A key for a path: segments tagged by kind, so the key `"0"` and the index 0 never meet. */
export function pathKey(path: JsonPath): string {
  let key = ''
  for (const segment of path)
    key += typeof segment === 'number' ? `\u0001#${segment}` : `\u0001.${segment}`
  return key
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/

/**
 * The path as JavaScript reads it: `data.items[0]["a-b"]`. `root` names the
 * value itself (a tree's `rootLabel`) and leads the path when it is one.
 */
export function formatPath(path: JsonPath, root?: string): string {
  let text = root !== undefined && IDENTIFIER.test(root) ? root : ''
  for (const segment of path) {
    if (typeof segment === 'number') text += `[${segment}]`
    else if (IDENTIFIER.test(segment)) text += text === '' ? segment : `.${segment}`
    else text += `[${JSON.stringify(segment)}]`
  }
  return text
}

export type ContainerKind = 'object' | 'array'

export function containerKind(value: unknown): ContainerKind | null {
  if (Array.isArray(value)) return 'array'
  if (value !== null && typeof value === 'object') return 'object'
  return null
}

/** How many children a container holds. */
export function sizeOf(value: unknown): number {
  if (Array.isArray(value)) return value.length
  if (value !== null && typeof value === 'object') return Object.keys(value).length
  return 0
}

function child(value: unknown, segment: string | number): unknown {
  if (Array.isArray(value)) return typeof segment === 'number' ? value[segment] : undefined
  if (value !== null && typeof value === 'object')
    return (value as Record<string, unknown>)[String(segment)]
  return undefined
}

/** The value at `path`, or `undefined` when there is none. */
export function valueAt(value: unknown, path: JsonPath): unknown {
  let at = value
  for (const segment of path) at = child(at, segment)
  return at
}

/** The child keys of a container, in order: indices for an array, keys for an object. */
export function childSegments(value: unknown): (string | number)[] {
  if (Array.isArray(value)) return value.map((_, index) => index)
  if (value !== null && typeof value === 'object') return Object.keys(value)
  return []
}

/**
 * A container's contents in a few characters, for a shut row: an object
 * names its first keys (`{ admin, plan, +3 }`), an array counts itself.
 */
export function preview(value: unknown): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    return `[${value.length.toLocaleString('en-US')} ${value.length === 1 ? 'item' : 'items'}]`
  }
  if (value === null || typeof value !== 'object') return ''
  const keys = Object.keys(value)
  if (keys.length === 0) return '{}'
  const shown: string[] = []
  let used = 0
  for (const key of keys) {
    if (shown.length > 0 && used + key.length > 32) break
    shown.push(key)
    used += key.length + 2
  }
  const rest = keys.length - shown.length
  return `{ ${shown.join(', ')}${rest > 0 ? `, +${rest.toLocaleString('en-US')}` : ''} }`
}

/** A leaf as JSON writes it, which is also what search and copy read. */
export function leafText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined) return 'undefined'
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value)
  return JSON.stringify(value) ?? String(value)
}

/** What "Copy value" puts on the clipboard: a string as itself, anything else as JSON. */
export function copyText(value: unknown): string {
  if (typeof value === 'string') return value
  if (containerKind(value) !== null) return JSON.stringify(value, null, 2)
  return leafText(value)
}

export type JsonRow =
  | {
      kind: 'node'
      id: string
      path: JsonPath
      depth: number
      /** The key or index it sits under; `undefined` for a root without a label. */
      label: string | number | undefined
      value: unknown
      container: ContainerKind | null
      open: boolean
      size: number
    }
  | { kind: 'close'; id: string; path: JsonPath; depth: number; bracket: '}' | ']' }
  | { kind: 'more'; id: string; path: JsonPath; depth: number; shown: number; total: number }

export interface FlattenOptions {
  /** A row for the value itself, labelled so (`data`); without it the top level is the first rows. */
  rootLabel?: string | undefined
  /** Containers open by default down to this level (the value itself is level 0). */
  defaultDepth: number
  /** Opens and closes the person made, by path key; they beat the default. */
  toggled: ReadonlyMap<string, boolean>
  /** Containers a search has to open to show what it found. */
  searchOpen?: ReadonlySet<string> | undefined
  /** Children shown per container beyond the first page, by path key. */
  shown?: ReadonlyMap<string, number> | undefined
}

/** Whether the container at `key`, `level` deep, is open. */
export function isOpen(key: string, level: number, options: FlattenOptions): boolean {
  const toggled = options.toggled.get(key)
  if (toggled !== undefined) return toggled
  return options.searchOpen?.has(key) === true || level < options.defaultDepth
}

/** How many children of the container at `key` are shown. */
export function shownCount(key: string, total: number, options: FlattenOptions): number {
  return Math.min(total, Math.max(PAGE, options.shown?.get(key) ?? 0))
}

/** The rows a value draws as, top to bottom, under the open containers. */
export function flatten(value: unknown, options: FlattenOptions): JsonRow[] {
  const rows: JsonRow[] = []
  const labelled = options.rootLabel !== undefined
  const visit = (
    node: unknown,
    path: JsonPath,
    level: number,
    label: string | number | undefined,
  ) => {
    const depth = labelled ? level : level - 1
    const key = pathKey(path)
    const container = containerKind(node)
    const size = sizeOf(node)
    const implicitRoot = level === 0 && !labelled
    const open =
      container !== null && size > 0 && (implicitRoot ? true : isOpen(key, level, options))
    // A root with no label is drawn by its children — unless it has none to
    // draw it: a string, a number, an empty object is its own one row.
    if (!implicitRoot || !open)
      rows.push({
        kind: 'node',
        id: key,
        path,
        depth: Math.max(0, depth),
        label,
        value: node,
        container,
        open,
        size,
      })
    if (!open || container === null) return
    const segments = childSegments(node)
    const shown = shownCount(key, segments.length, options)
    for (let index = 0; index < shown; index += 1) {
      const segment = segments[index] as string | number
      visit(child(node, segment), [...path, segment], level + 1, segment)
    }
    if (shown < segments.length)
      rows.push({
        kind: 'more',
        id: `${key}\u0002more`,
        path,
        depth: depth + 1,
        shown,
        total: segments.length,
      })
    if (level > 0 || labelled)
      rows.push({
        kind: 'close',
        id: `${key}\u0002close`,
        path,
        depth,
        bracket: container === 'array' ? ']' : '}',
      })
  }
  visit(value, [], 0, options.rootLabel)
  return rows
}

export interface SearchHit {
  path: JsonPath
  key: string
  /** Where the text was found: the key it sits under, or its value. */
  in: 'key' | 'value'
}

export interface SearchResult {
  hits: SearchHit[]
  /** Every container between the root and a hit. */
  open: Set<string>
  /** Children a container must show for a hit past its first page. */
  shown: Map<string, number>
  /** The walk stopped at `SEARCH_LIMIT` values; there may be more. */
  stopped: boolean
}

/**
 * Every place `text` appears, case-insensitively, in a key or a leaf value,
 * in the order the tree draws them. Masked values are never searched — a
 * search that lit up a hidden hash would say what is in it.
 */
export function search(
  value: unknown,
  text: string,
  mask?: ((path: JsonPath) => boolean) | undefined,
): SearchResult {
  const result: SearchResult = { hits: [], open: new Set(), shown: new Map(), stopped: false }
  const needle = text.trim().toLowerCase()
  if (needle === '') return result
  let visited = 0
  const visit = (node: unknown, path: JsonPath): boolean => {
    visited += 1
    if (visited > SEARCH_LIMIT) {
      result.stopped = true
      return false
    }
    const last = path.at(-1)
    const key = pathKey(path)
    let found = false
    if (typeof last === 'string' && last.toLowerCase().includes(needle)) {
      result.hits.push({ path, key, in: 'key' })
      found = true
    }
    const container = containerKind(node)
    if (container === null) {
      if (!mask?.(path) && leafText(node).toLowerCase().includes(needle)) {
        if (!found) result.hits.push({ path, key, in: 'value' })
        found = true
      }
      return found
    }
    const segments = childSegments(node)
    let below = false
    for (const [index, segment] of segments.entries()) {
      if (visit(child(node, segment), [...path, segment])) {
        below = true
        const need = index + 1
        if (need > PAGE) result.shown.set(key, Math.max(result.shown.get(key) ?? 0, need))
      }
      if (result.stopped) break
    }
    if (below) result.open.add(key)
    return found || below
  }
  visit(value, [])
  return result
}

/** Where `needle` occurs in `text`, case-insensitively, as [from, to) ranges. */
export function matchRanges(text: string, needle: string): [number, number][] {
  const want = needle.trim().toLowerCase()
  if (want === '') return []
  const haystack = text.toLowerCase()
  // A few characters change length when lowercased (İ); offsets would drift.
  if (haystack.length !== text.length) return []
  const ranges: [number, number][] = []
  let at = haystack.indexOf(want)
  while (at !== -1) {
    ranges.push([at, at + want.length])
    at = haystack.indexOf(want, at + want.length)
  }
  return ranges
}
