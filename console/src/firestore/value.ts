// The Firestore value model as the console holds it: the REST wire shape
// decoded once into typed values, with everything the grid, the inspector
// and the editors need (type names, display text, parsing) in one place.

export type FirestoreValueType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'timestamp'
  | 'reference'
  | 'geopoint'
  | 'map'
  | 'array'
  | 'bytes'
  | 'null'
  | 'vector'

// A previewed read (see `preview` in rest.ts) returns values cut down to
// what a grid cell can draw. `elided` counts the bytes left behind and
// `count` is the container's real size, so nothing has to be inferred from a
// truncated value: a cell shows the true number of entries and an editor
// refuses to write back half a string.
export type FsValue =
  | { type: 'string'; value: string; elided?: number }
  | { type: 'number'; value: number; integer: boolean }
  | { type: 'boolean'; value: boolean }
  | { type: 'timestamp'; value: string }
  | { type: 'reference'; value: string; path: string }
  | { type: 'geopoint'; latitude: number; longitude: number }
  | { type: 'map'; fields: Record<string, FsValue>; count?: number }
  | { type: 'array'; items: FsValue[]; count?: number }
  | { type: 'bytes'; base64: string; elided?: number }
  | { type: 'null' }
  | { type: 'vector'; values: number[] }

/** Whether only part of this value was loaded. */
export function isPartial(value: FsValue): boolean {
  switch (value.type) {
    case 'string':
    case 'bytes':
      return value.elided !== undefined
    case 'map':
    case 'array':
      return value.count !== undefined
    default:
      return false
  }
}

/** How many entries a container holds, whether or not all of them arrived. */
export function entryCount(value: { type: 'map' | 'array' } & FsValue): number {
  if (value.type === 'map') return value.count ?? Object.keys(value.fields).length
  return value.count ?? value.items.length
}

/** A Firestore REST `Value`. */
export interface RestValue {
  nullValue?: null
  booleanValue?: boolean
  integerValue?: string | number
  doubleValue?: number
  timestampValue?: string
  stringValue?: string
  bytesValue?: string
  referenceValue?: string
  geoPointValue?: { latitude?: number; longitude?: number }
  arrayValue?: { values?: RestValue[]; firenookCount?: number }
  mapValue?: { fields?: Record<string, RestValue>; firenookCount?: number }
  /** Bytes the engine left behind on a previewed string or byte string. */
  firenookElided?: number
}

export interface RestDocument {
  name: string
  fields?: Record<string, RestValue>
  createTime?: string
  updateTime?: string
}

/** A document as the console works with it. */
export interface FsDocument {
  /** Relative path, `users/u_9f3k2`. */
  path: string
  id: string
  /** Parent collection path, `users`. */
  collection: string
  fields: Record<string, FsValue>
  createTime?: string
  updateTime?: string
  /** Named in a listing but never written: only subcollections exist. */
  missing?: boolean
}

const DOCUMENTS_MARKER = '/documents/'

/** `projects/p/databases/d/documents/users/u1` → `users/u1`. */
export function relativePath(name: string): string {
  const index = name.indexOf(DOCUMENTS_MARKER)
  return index === -1 ? name : name.slice(index + DOCUMENTS_MARKER.length)
}

export function decodeValue(value: RestValue): FsValue {
  if ('stringValue' in value)
    return value.firenookElided === undefined
      ? { type: 'string', value: value.stringValue ?? '' }
      : { type: 'string', value: value.stringValue ?? '', elided: value.firenookElided }
  if ('integerValue' in value)
    return { type: 'number', value: Number(value.integerValue), integer: true }
  if ('doubleValue' in value)
    return { type: 'number', value: Number(value.doubleValue), integer: false }
  if ('booleanValue' in value) return { type: 'boolean', value: Boolean(value.booleanValue) }
  if ('timestampValue' in value) return { type: 'timestamp', value: value.timestampValue ?? '' }
  if ('referenceValue' in value) {
    const full = value.referenceValue ?? ''
    return { type: 'reference', value: full, path: relativePath(full) }
  }
  if ('geoPointValue' in value)
    return {
      type: 'geopoint',
      latitude: value.geoPointValue?.latitude ?? 0,
      longitude: value.geoPointValue?.longitude ?? 0,
    }
  if ('mapValue' in value) {
    const fields = value.mapValue?.fields ?? {}
    // Vectors travel as maps with a reserved type marker.
    if (fields.__type__?.stringValue === '__vector__' && fields.value?.arrayValue) {
      return {
        type: 'vector',
        values: (fields.value.arrayValue.values ?? []).map((item) => Number(item.doubleValue ?? 0)),
      }
    }
    const count = value.mapValue?.firenookCount
    return count === undefined
      ? { type: 'map', fields: decodeFields(fields) }
      : { type: 'map', fields: decodeFields(fields), count }
  }
  if ('arrayValue' in value) {
    const items = (value.arrayValue?.values ?? []).map(decodeValue)
    const count = value.arrayValue?.firenookCount
    return count === undefined ? { type: 'array', items } : { type: 'array', items, count }
  }
  if ('bytesValue' in value)
    return value.firenookElided === undefined
      ? { type: 'bytes', base64: value.bytesValue ?? '' }
      : { type: 'bytes', base64: value.bytesValue ?? '', elided: value.firenookElided }
  return { type: 'null' }
}

export function decodeFields(
  fields: Record<string, RestValue> | undefined,
): Record<string, FsValue> {
  const out: Record<string, FsValue> = {}
  for (const [key, value] of Object.entries(fields ?? {})) out[key] = decodeValue(value)
  return out
}

export function decodeDocument(document: RestDocument): FsDocument {
  const path = relativePath(document.name)
  const slash = path.lastIndexOf('/')
  const result: FsDocument = {
    path,
    id: path.slice(slash + 1),
    collection: path.slice(0, slash),
    fields: decodeFields(document.fields),
  }
  if (document.createTime) result.createTime = document.createTime
  if (document.updateTime) result.updateTime = document.updateTime
  // A masked listing returns no fields for real documents either; only a
  // document without a create time was never written.
  if (!document.createTime) result.missing = true
  return result
}

export function encodeValue(value: FsValue, documentRoot: string): RestValue {
  switch (value.type) {
    case 'string':
      return { stringValue: value.value }
    case 'number':
      return value.integer && Number.isSafeInteger(value.value)
        ? { integerValue: String(value.value) }
        : { doubleValue: value.value }
    case 'boolean':
      return { booleanValue: value.value }
    case 'timestamp':
      return { timestampValue: value.value }
    case 'reference':
      return {
        referenceValue: value.value.includes(DOCUMENTS_MARKER)
          ? value.value
          : `${documentRoot}/${value.path}`,
      }
    case 'geopoint':
      return { geoPointValue: { latitude: value.latitude, longitude: value.longitude } }
    case 'map':
      return { mapValue: { fields: encodeFields(value.fields, documentRoot) } }
    case 'array':
      return { arrayValue: { values: value.items.map((item) => encodeValue(item, documentRoot)) } }
    case 'bytes':
      return { bytesValue: value.base64 }
    case 'vector':
      return {
        mapValue: {
          fields: {
            __type__: { stringValue: '__vector__' },
            value: { arrayValue: { values: value.values.map((item) => ({ doubleValue: item })) } },
          },
        },
      }
    case 'null':
      return { nullValue: null }
  }
}

export function encodeFields(
  fields: Record<string, FsValue>,
  documentRoot: string,
): Record<string, RestValue> {
  const out: Record<string, RestValue> = {}
  for (const [key, value] of Object.entries(fields)) out[key] = encodeValue(value, documentRoot)
  return out
}

/** Plain JSON the way the JavaScript SDK would surface the value. */
export function toJson(value: FsValue): unknown {
  switch (value.type) {
    case 'string':
    case 'boolean':
    case 'timestamp':
      return value.value
    case 'number':
      return value.value
    case 'reference':
      return value.path
    case 'geopoint':
      return { latitude: value.latitude, longitude: value.longitude }
    case 'map':
      return fieldsToJson(value.fields)
    case 'array':
      return value.items.map(toJson)
    case 'bytes':
      return value.base64
    case 'vector':
      // Firestore's own marker, not a bare array of numbers. A bare
      // array is unreadable on the way back — every array of numbers
      // would qualify — so this is the one shape here that had no
      // inverse at all.
      return { __type__: VECTOR_MARKER, value: value.values }
    case 'null':
      return null
  }
}

export function fieldsToJson(fields: Record<string, FsValue>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(fields)) out[key] = toJson(value)
  return out
}

/** The one-line text a grid cell shows. */
export function displayValue(value: FsValue): string {
  switch (value.type) {
    case 'string':
      return value.value
    case 'number':
      return formatNumber(value.value)
    case 'boolean':
      return value.value ? 'true' : 'false'
    case 'timestamp':
      return value.value
    case 'reference':
      return value.path
    case 'geopoint':
      return `${value.latitude}, ${value.longitude}`
    case 'map': {
      const fields = entryCount(value)
      return fields === 0 ? '{}' : `{ ${fields} field${fields === 1 ? '' : 's'} }`
    }
    case 'array': {
      const items = entryCount(value)
      return items === 0 ? '[]' : `[ ${items} item${items === 1 ? '' : 's'} ]`
    }
    case 'bytes':
      return `${Math.ceil((value.base64.length * 3) / 4)} bytes`
    case 'vector':
      return `vector(${value.values.length})`
    case 'null':
      return 'null'
  }
}

export function formatNumber(value: number): string {
  if (Number.isInteger(value)) return value.toLocaleString('en-US')
  return String(value)
}

/** How a value is written in the editor: what you type to get it back. */
export function editorText(value: FsValue): string {
  switch (value.type) {
    case 'string':
      return value.value
    case 'number':
      return String(value.value)
    case 'boolean':
      return value.value ? 'true' : 'false'
    case 'timestamp':
      return value.value
    case 'reference':
      return value.path
    case 'geopoint':
      return `${value.latitude}, ${value.longitude}`
    case 'bytes':
      return value.base64
    case 'vector':
      return JSON.stringify(value.values)
    case 'map':
      return JSON.stringify(fieldsToJson(value.fields), null, 2)
    case 'array':
      return JSON.stringify(value.items.map(toJson), null, 2)
    case 'null':
      return 'null'
  }
}

/** Parses editor text as a given type; returns an error message when it is not that type. */
export function parseEditorText(
  type: FirestoreValueType,
  text: string,
): { ok: true; value: FsValue } | { ok: false; error: string } {
  const trimmed = text.trim()
  switch (type) {
    case 'string':
      return { ok: true, value: { type: 'string', value: text } }
    case 'number': {
      if (trimmed === '' || Number.isNaN(Number(trimmed)))
        return { ok: false, error: 'Not a number' }
      const value = Number(trimmed)
      return {
        ok: true,
        value: { type: 'number', value, integer: /^-?\d+$/.test(trimmed) },
      }
    }
    case 'boolean':
      if (trimmed === 'true') return { ok: true, value: { type: 'boolean', value: true } }
      if (trimmed === 'false') return { ok: true, value: { type: 'boolean', value: false } }
      return { ok: false, error: 'true or false' }
    case 'timestamp': {
      const date = new Date(trimmed)
      if (trimmed === '' || Number.isNaN(date.getTime()))
        return { ok: false, error: 'Not a date; use ISO 8601, e.g. 2026-09-20T09:00:00Z' }
      return { ok: true, value: { type: 'timestamp', value: date.toISOString() } }
    }
    case 'reference': {
      const path = relativePath(trimmed).replace(/^\/+|\/+$/g, '')
      const segments = path.split('/')
      if (path === '' || segments.length % 2 !== 0 || segments.some((segment) => segment === ''))
        return { ok: false, error: 'A document path has an even number of segments' }
      return { ok: true, value: { type: 'reference', value: path, path } }
    }
    case 'geopoint': {
      const parts = trimmed.split(',').map((part) => Number(part.trim()))
      if (parts.length !== 2 || parts.some(Number.isNaN))
        return { ok: false, error: 'latitude, longitude' }
      const [latitude = 0, longitude = 0] = parts
      if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180)
        return { ok: false, error: 'Latitude within ±90, longitude within ±180' }
      return { ok: true, value: { type: 'geopoint', latitude, longitude } }
    }
    case 'bytes':
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(trimmed)) return { ok: false, error: 'Base64 only' }
      return { ok: true, value: { type: 'bytes', base64: trimmed } }
    case 'null':
      return { ok: true, value: { type: 'null' } }
    case 'vector': {
      try {
        const parsed: unknown = JSON.parse(trimmed)
        if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'number'))
          return { ok: false, error: 'A JSON array of numbers' }
        return { ok: true, value: { type: 'vector', values: parsed as number[] } }
      } catch {
        return { ok: false, error: 'A JSON array of numbers' }
      }
    }
    case 'map':
    case 'array': {
      try {
        const parsed: unknown = JSON.parse(trimmed)
        const value = fromJson(parsed)
        if (value.type !== type)
          return { ok: false, error: `JSON ${type === 'map' ? 'object' : 'array'}` }
        return { ok: true, value }
      } catch {
        return { ok: false, error: 'Not valid JSON' }
      }
    }
  }
}

export interface FromJsonOptions {
  /**
   * Promote ISO 8601 strings to timestamps. The one genuine guess in
   * here: a string that looks like an instant usually is one, but
   * somebody storing a date *as text* means the text.
   */
  timestamps?: boolean | undefined
  /**
   * Read back the shapes `toJson` writes — `{latitude, longitude}` as a
   * geopoint, `{__type__: "__vector__", value: [...]}` as a vector.
   *
   * Not a guess in the same sense: these are this module's own output,
   * and without this the round trip is lossy in one direction only.
   * The geopoint shape is required to be exactly those two keys, both
   * finite and in range, so a map that merely carries a latitude among
   * other fields stays a map.
   */
  shapes?: boolean | undefined
}

/** Everything the text can be read as. What the JSON view parses with. */
export const INFER: FromJsonOptions = { timestamps: true, shapes: true }

const VECTOR_MARKER = '__vector__'

function asGeopoint(input: Record<string, unknown>): FsValue | undefined {
  const keys = Object.keys(input)
  if (keys.length !== 2 || !keys.includes('latitude') || !keys.includes('longitude'))
    return undefined
  const { latitude, longitude } = input as { latitude: unknown; longitude: unknown }
  if (typeof latitude !== 'number' || typeof longitude !== 'number') return undefined
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return undefined
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return undefined
  return { type: 'geopoint', latitude, longitude }
}

function asVector(input: Record<string, unknown>): FsValue | undefined {
  if (input.__type__ !== VECTOR_MARKER) return undefined
  const values = input.value
  if (!Array.isArray(values) || !values.every((item) => typeof item === 'number')) return undefined
  return { type: 'vector', values: values as number[] }
}

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/

/** Every key the REST wire shape uses for a value. */
const REST_VALUE_KEYS = new Set([
  'nullValue',
  'booleanValue',
  'integerValue',
  'doubleValue',
  'timestampValue',
  'stringValue',
  'bytesValue',
  'referenceValue',
  'geoPointValue',
  'arrayValue',
  'mapValue',
])

/**
 * Whether these fields are already typed, in the REST wire shape, rather
 * than the plain JSON a person writes.
 *
 * An export that keeps Firestore types exactly writes `{"stringValue":"Ada"}`
 * where a plain one writes `"Ada"`, so importing it as plain JSON would
 * store the wrapper as a map and lose every type it was written to keep.
 * Each field has to be an object with exactly one key, and that key has to
 * be one of the wire's own — a document whose fields happen to be maps with
 * one key of their own is not mistaken for this, because `stringValue` and
 * the rest are the only names that count.
 */
export function isRestShape(fields: Record<string, unknown>): boolean {
  const values = Object.values(fields)
  if (values.length === 0) return false
  return values.every((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const keys = Object.keys(value as Record<string, unknown>)
    return keys.length === 1 && REST_VALUE_KEYS.has(keys[0] ?? '')
  })
}

/** Plain JSON → typed values, inferring the Firestore type the way the SDK would. */
export function fromJson(input: unknown, options: FromJsonOptions = {}): FsValue {
  if (input === null || input === undefined) return { type: 'null' }
  if (typeof input === 'string') {
    if (options.timestamps && ISO_TIMESTAMP.test(input) && !Number.isNaN(Date.parse(input)))
      return { type: 'timestamp', value: new Date(input).toISOString() }
    return { type: 'string', value: input }
  }
  if (typeof input === 'number')
    return { type: 'number', value: input, integer: Number.isInteger(input) }
  if (typeof input === 'boolean') return { type: 'boolean', value: input }
  if (Array.isArray(input))
    return { type: 'array', items: input.map((item) => fromJson(item, options)) }
  if (typeof input === 'object') {
    const record = input as Record<string, unknown>
    if (options.shapes) {
      const shaped = asVector(record) ?? asGeopoint(record)
      if (shaped) return shaped
    }
    const fields: Record<string, FsValue> = {}
    for (const [key, value] of Object.entries(record)) fields[key] = fromJson(value, options)
    return { type: 'map', fields }
  }
  return { type: 'string', value: String(input) }
}

export const VALUE_TYPES: readonly FirestoreValueType[] = [
  'string',
  'number',
  'boolean',
  'map',
  'array',
  'null',
  'timestamp',
  'geopoint',
  'reference',
  'bytes',
  'vector',
]

/** A sensible empty value for a newly chosen type. */
export function emptyValue(type: FirestoreValueType): FsValue {
  switch (type) {
    case 'string':
      return { type, value: '' }
    case 'number':
      return { type, value: 0, integer: true }
    case 'boolean':
      return { type, value: false }
    case 'timestamp':
      return { type, value: new Date().toISOString() }
    case 'reference':
      return { type, value: '', path: '' }
    case 'geopoint':
      return { type, latitude: 0, longitude: 0 }
    case 'map':
      return { type, fields: {} }
    case 'array':
      return { type, items: [] }
    case 'bytes':
      return { type, base64: '' }
    case 'vector':
      return { type, values: [] }
    case 'null':
      return { type }
  }
}

/** Relative time in the shortest honest form; exact time stays a hover away. */
export function relativeTime(iso: string, now = Date.now()): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return iso
  const seconds = Math.round((now - then) / 1000)
  const future = seconds < 0
  const abs = Math.abs(seconds)
  const text =
    abs < 45
      ? 'just now'
      : abs < 90
        ? '1 min'
        : abs < 3600
          ? `${Math.round(abs / 60)} min`
          : abs < 86_400
            ? `${Math.round(abs / 3600)} h`
            : abs < 86_400 * 30
              ? `${Math.round(abs / 86_400)} d`
              : abs < 86_400 * 365
                ? `${Math.round(abs / (86_400 * 30))} mo`
                : `${Math.round(abs / (86_400 * 365))} y`
  if (text === 'just now') return text
  return future ? `in ${text}` : `${text} ago`
}
