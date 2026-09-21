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

export type FsValue =
  | { type: 'string'; value: string }
  | { type: 'number'; value: number; integer: boolean }
  | { type: 'boolean'; value: boolean }
  | { type: 'timestamp'; value: string }
  | { type: 'reference'; value: string; path: string }
  | { type: 'geopoint'; latitude: number; longitude: number }
  | { type: 'map'; fields: Record<string, FsValue> }
  | { type: 'array'; items: FsValue[] }
  | { type: 'bytes'; base64: string }
  | { type: 'null' }
  | { type: 'vector'; values: number[] }

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
  arrayValue?: { values?: RestValue[] }
  mapValue?: { fields?: Record<string, RestValue> }
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
  if ('stringValue' in value) return { type: 'string', value: value.stringValue ?? '' }
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
    return { type: 'map', fields: decodeFields(fields) }
  }
  if ('arrayValue' in value)
    return { type: 'array', items: (value.arrayValue?.values ?? []).map(decodeValue) }
  if ('bytesValue' in value) return { type: 'bytes', base64: value.bytesValue ?? '' }
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
      return value.values
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
      const keys = Object.keys(value.fields)
      return keys.length === 0 ? '{}' : `{ ${keys.length} field${keys.length === 1 ? '' : 's'} }`
    }
    case 'array':
      return value.items.length === 0
        ? '[]'
        : `[ ${value.items.length} item${value.items.length === 1 ? '' : 's'} ]`
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
  /** Promote ISO 8601 strings to timestamps, the way an import usually wants. */
  timestamps?: boolean | undefined
}

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/

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
    const fields: Record<string, FsValue> = {}
    for (const [key, value] of Object.entries(input as Record<string, unknown>))
      fields[key] = fromJson(value, options)
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
