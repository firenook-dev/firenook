// A message's data, both ways: what a list cell shows of what the engine
// sent (`PubsubPayloadPreview`), and what the console sends for what was
// typed (`PubsubData`). Sizes are counted the way Pub/Sub counts them —
// UTF-8 bytes of the data, every attribute key and value, and the ordering
// key — so the production limits are checked against the same figure
// production would read. The emulator itself accepts what production
// refuses (10 MB+ messages, 101 attributes, 257-byte keys, `goog` keys), so
// these are warnings, never refusals; the one hard limit is the console's
// own request size, the Pub/Sub port's 64 MiB.

import type { PubsubData } from '@/api/generated/messaging/PubsubData'
import type { PubsubPayloadPreview } from '@/api/generated/messaging/PubsubPayloadPreview'
import { decodeBase64 } from '@/components/console/payload-view'
import { formatBytes, formatNumber } from '@/lib/format'

/** How typed data is written: JSON, text, base64 bytes, or JSON sent as a BINARY topic's Avro. */
export type DataKind = 'json' | 'text' | 'base64' | 'avro-json'

/** Production's limits (the emulator applies none of them). */
export const LIMITS = {
  /** A message's data, attributes and ordering key together. */
  messageBytes: 10_000_000,
  attributes: 100,
  attributeKeyBytes: 256,
  attributeValueBytes: 1024,
  orderingKeyBytes: 1024,
} as const

/** The console's own limit on one request: the Pub/Sub port's gRPC limit. */
export const REQUEST_BYTES = 64 * 1024 * 1024

const encoder = new TextEncoder()

/** UTF-8 bytes of a string. */
export function utf8Bytes(text: string): number {
  // ASCII is the common case and needs no encoder.
  let ascii = true
  for (let index = 0; index < text.length; index += 1)
    if (text.charCodeAt(index) > 0x7f) {
      ascii = false
      break
    }
  return ascii ? text.length : encoder.encode(text).length
}

/** The bytes base64 text decodes to (without decoding it), or undefined when it is not base64. */
export function base64Bytes(text: string): number | undefined {
  const clean = text.replace(/\s+/g, '')
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(clean)) return undefined
  const body = clean.replace(/=+$/, '')
  if (body.length % 4 === 1) return undefined
  return Math.floor((body.length * 3) / 4)
}

/** The bytes typed data becomes on the wire (Avro JSON: an estimate, its JSON's size). */
export function dataBytes(kind: DataKind, text: string): number {
  if (kind === 'base64') return base64Bytes(text) ?? 0
  return utf8Bytes(text)
}

/** Typed data as the console sends it. */
export function toWireData(kind: DataKind, text: string): PubsubData {
  if (kind === 'json') return { json: text }
  if (kind === 'base64') return { base64: text.replace(/\s+/g, '') }
  if (kind === 'avro-json') return { avroJson: text }
  return { text }
}

/** What a draft message holds, as the composer and the checks read it. */
export interface DraftMessage {
  kind: DataKind
  data: string
  attributes: readonly { key: string; value: string }[]
  orderingKey: string
}

/** A message's size as Pub/Sub counts it: data, every attribute key and value, the ordering key. */
export function messageBytes(message: DraftMessage): number {
  let bytes = dataBytes(message.kind, message.data)
  for (const attribute of message.attributes)
    bytes += utf8Bytes(attribute.key) + utf8Bytes(attribute.value)
  return bytes + utf8Bytes(message.orderingKey)
}

/** A limit production would apply, said where it bites. */
export interface LimitNote {
  /** What it is about: the whole message, the attributes, one attribute's key or value, the ordering key. */
  on: 'message' | 'attributes' | 'key' | 'value' | 'orderingKey'
  /** The attribute's place in the list, for `key` and `value`. */
  index?: number
  text: string
}

/** Every production limit the draft passes, in the composer's words (amber, never blocking). */
export function limitNotes(message: DraftMessage): LimitNote[] {
  const notes: LimitNote[] = []
  const total = messageBytes(message)
  if (total > LIMITS.messageBytes)
    notes.push({
      on: 'message',
      text: `This message is ${formatNumber(total)} bytes; production refuses one over 10,000,000.`,
    })
  if (message.attributes.length > LIMITS.attributes)
    notes.push({
      on: 'attributes',
      text: `${formatNumber(message.attributes.length)} attributes; production refuses more than 100.`,
    })
  message.attributes.forEach((attribute, index) => {
    const keyBytes = utf8Bytes(attribute.key)
    if (keyBytes > LIMITS.attributeKeyBytes)
      notes.push({
        on: 'key',
        index,
        text: `The key is ${formatNumber(keyBytes)} bytes; production refuses one over 256.`,
      })
    else if (attribute.key.startsWith('goog'))
      notes.push({ on: 'key', index, text: 'Production refuses a key that starts with goog.' })
    const valueBytes = utf8Bytes(attribute.value)
    if (valueBytes > LIMITS.attributeValueBytes)
      notes.push({
        on: 'value',
        index,
        text: `The value is ${formatNumber(valueBytes)} bytes; production refuses one over 1,024.`,
      })
  })
  const keyBytes = utf8Bytes(message.orderingKey)
  if (keyBytes > LIMITS.orderingKeyBytes)
    notes.push({
      on: 'orderingKey',
      text: `The ordering key is ${formatNumber(keyBytes)} bytes; production refuses one over 1,024.`,
    })
  return notes
}

/**
 * Why one request of `messageBytes` repeated `repeat` times cannot be sent,
 * or undefined: the console takes at most 64 MiB in one request.
 */
export function requestProblem(bytes: number, repeat = 1): string | undefined {
  const total = bytes * Math.max(1, repeat)
  if (total <= REQUEST_BYTES) return undefined
  return repeat > 1
    ? `${formatNumber(repeat)} copies are ${formatBytes(total)}; the console sends at most 64 MiB at once. Publish fewer copies, or publish the data from a file.`
    : `This message is ${formatBytes(total)}; the console sends at most 64 MiB at once, as the Pub/Sub port does.`
}

/** Whether typed data can be sent as `kind`: undefined when it can, else why not. */
export function dataProblem(kind: DataKind, text: string): string | undefined {
  if (kind === 'base64') return base64Bytes(text) === undefined ? 'This is not base64.' : undefined
  if (kind === 'json' || kind === 'avro-json') {
    if (text.trim() === '') return 'Write the JSON to send.'
    try {
      JSON.parse(text)
      return undefined
    } catch (error) {
      return error instanceof Error ? `Not valid JSON: ${error.message}` : 'Not valid JSON.'
    }
  }
  return undefined
}

/**
 * A list cell's text for a message's data: compact JSON or text as the
 * engine cut it, an ellipsis when it was cut; binary is its size alone,
 * since its base64 says nothing to anyone reading a list.
 */
export function previewText(preview: PubsubPayloadPreview, size: number): string {
  if (preview.encoding === 'binary') return `⟨${formatBytes(size)} binary⟩`
  if (preview.text === '') return '⟨empty⟩'
  return preview.truncated ? `${preview.text}…` : preview.text
}

/** A message's data as the text an editor shows: its UTF-8 text, or its base64 when it is bytes. */
export function editableData(
  dataText: string | null,
  dataBase64: string,
  dataJson: boolean,
): { kind: DataKind; data: string } {
  if (dataText === null) return { kind: 'base64', data: dataBase64 }
  if (!dataJson) return { kind: 'text', data: dataText }
  try {
    return { kind: 'json', data: JSON.stringify(JSON.parse(dataText), null, 2) }
  } catch {
    return { kind: 'text', data: dataText }
  }
}

/** The bytes of base64 data, decoded; undefined when it is not base64. */
export function decodeData(base64: string): Uint8Array | undefined {
  return decodeBase64(base64)
}
