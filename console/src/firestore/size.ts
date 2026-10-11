// How much of its 1 MiB a document is using.
//
// Firestore caps one document at 1 MiB — 1,048,576 bytes — and sizes it
// by a rule of its own that has little to do with how the JSON on screen
// is spelled. A number is eight bytes whether it reads `1` or
// `1000000000`; a timestamp is eight however many decimals it carries;
// every string and every field name pays one byte over its UTF-8 length;
// and a document is its name, its fields, and 32 bytes.
//
// **The engine does not enforce this.** No crate holds a document-size
// check, so the emulator accepts a four-megabyte document that
// production refuses, and nothing between here and a deploy would say
// so. That is why the number is on screen and why it is live: it is a
// limit this console can warn about that the engine behind it will not.
//
// Every rule below is Google's, and the worked example from their page
// is a unit test, so a misreading of it fails rather than ships.

import { type FsValue, isPartial } from './value'

/** Firestore's cap on a single document. */
export const DOCUMENT_LIMIT = 1_048_576

/** Where the number stops being a fact and starts being a warning. */
const CROWDED = 0.9

const utf8 = new TextEncoder()

/** "String sizes are calculated as the number of UTF-8 encoded bytes + 1." */
function stringBytes(text: string): number {
  return utf8.encode(text).length + 1
}

/**
 * A document's name: every collection id and document id along its path,
 * each priced as a string, and 16 bytes.
 *
 * The path as this console holds it — `users/u_1/orders/o_2` — which is
 * exactly the four ids Google's worked example counts. The
 * `projects/…/databases/…/documents` prefix the REST API wants is not
 * part of the name and is not counted.
 */
export function nameBytes(path: string): number {
  let total = 16
  for (const id of path.split('/')) if (id !== '') total += stringBytes(id)
  return total
}

/** What base64 weighs once it is the bytes it stands for. */
function base64Bytes(base64: string): number {
  let characters = 0
  for (const character of base64) if (character !== '=' && character.trim() !== '') characters += 1
  return Math.floor((characters * 3) / 4)
}

function valueBytes(value: FsValue): number {
  switch (value.type) {
    case 'string':
      return stringBytes(value.value)
    // Integer and floating-point alike: eight bytes, however it reads.
    case 'number':
      return 8
    case 'boolean':
      return 1
    case 'null':
      return 1
    case 'timestamp':
      return 8
    case 'geopoint':
      return 16
    // Priced as the document it points at is named.
    case 'reference':
      return nameBytes(value.path)
    case 'bytes':
      return base64Bytes(value.base64)
    // Eight bytes a dimension, and nothing for the map it is written
    // as in JSON — Firestore stores the embedding, not its spelling.
    case 'vector':
      return value.values.length * 8
    case 'array':
      return value.items.reduce((total, item) => total + valueBytes(item), 0)
    case 'map':
      return fieldsBytes(value.fields)
  }
}

/**
 * The fields of a map or of a document: each name as a string, each
 * value by its own rule.
 *
 * Google writes a map's size as "calculated the same way as document
 * size" without saying whether a document's 32 bytes come with it. They
 * do not: the 32 is written as part of the document total, and the
 * worked example adds it exactly once.
 */
function fieldsBytes(fields: Record<string, FsValue>): number {
  let total = 0
  for (const [name, value] of Object.entries(fields)) total += stringBytes(name) + valueBytes(value)
  return total
}

/** What Firestore would charge this document against its 1 MiB. */
export function documentBytes(path: string, fields: Record<string, FsValue>): number {
  return nameBytes(path) + fieldsBytes(fields) + 32
}

/**
 * Whether any value here arrived cut short, in which case the size is a
 * floor rather than the size. Nothing elides today — the engine sends
 * whole documents — but the decoder carries the field, so the number
 * would quietly under-report on the day it does.
 */
export function anyElided(fields: Record<string, FsValue>): boolean {
  return Object.values(fields).some(function deep(value): boolean {
    if (isPartial(value)) return true
    if (value.type === 'map') return Object.values(value.fields).some(deep)
    if (value.type === 'array') return value.items.some(deep)
    return false
  })
}

/**
 * Short enough for a footer, and precise where precision starts to
 * matter: tenths while the document is small enough that they are the
 * difference, hundredths of a megabyte near the limit, where the
 * difference between 1.0 and 1.04 is the difference between a write and
 * a rejection.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kilobytes = bytes / 1024
  if (kilobytes < 1024)
    return `${kilobytes < 100 ? kilobytes.toFixed(1) : Math.round(kilobytes)} KB`
  return `${(kilobytes / 1024).toFixed(2)} MB`
}

export interface SizeReading {
  text: string
  /** `over` is a document Firestore would refuse to store. */
  tone: 'quiet' | 'crowded' | 'over'
  title: string
}

/**
 * The number as the footer says it, with the sentence behind it.
 *
 * The share of the limit is said only once it is news. A real document
 * measured for this — a grant record of eleven fields — is 472 bytes,
 * 0.045% of the limit: as a percentage that is "0%", and as a 16 px ring
 * it is two hundredths of a pixel of arc. Proportion is the reading that
 * matters near the ceiling and noise everywhere else, so below 90% the
 * footer says only how big the document is, and from there it says how
 * full as well. Over the line the share rounds up, so a document one
 * byte past the limit never reads as 100%.
 */
export function sizeReading(bytes: number, elided = false): SizeReading {
  const share = bytes / DOCUMENT_LIMIT
  const tone = share > 1 ? 'over' : share >= CROWDED ? 'crowded' : 'quiet'
  const percent = tone === 'over' ? Math.ceil(share * 100) : Math.floor(share * 100)
  const amount = tone === 'quiet' ? formatBytes(bytes) : `${formatBytes(bytes)} · ${percent}%`
  const counted = `${bytes.toLocaleString('en-US')} of ${DOCUMENT_LIMIT.toLocaleString('en-US')} bytes a document may hold`
  return {
    text: elided ? `≥ ${amount}` : amount,
    tone,
    title: elided
      ? `At least ${counted}. Part of this document was not loaded, so the real size is larger.`
      : tone === 'over'
        ? `${counted}. This engine will store it; Firestore will reject it.`
        : counted,
  }
}
