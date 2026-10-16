// Reading the start of an object for a preview, never the whole of it unless
// asked: a byte range from the console's media route (256 KB of text, 64 KB
// of hex), or — for a gzip-encoded object, which the route always serves
// decoded and never by range — the decoded stream read up to the cap and
// then let go.

import { mediaUrl } from './api'

/** What a text preview reads first. */
export const TEXT_HEAD = 256 * 1024
/** What "Load all" reads at most. */
export const TEXT_ALL = 16 * 1024 * 1024
/** What the hex view reads. */
export const HEX_HEAD = 64 * 1024
/** Text up to this size may be edited in place. */
export const EDIT_LIMIT = 1024 * 1024

export interface Head {
  bytes: Uint8Array
  /** Every byte of the object was read. */
  complete: boolean
}

/** The first `limit` bytes of an object (decoded when it is gzip-encoded). */
export async function readHead(
  object: { bucket: string; name: string; generation: string; size: number; gzip: boolean },
  limit: number,
  signal?: AbortSignal,
): Promise<Head> {
  const url = mediaUrl({ bucket: object.bucket, name: object.name, generation: object.generation })
  if (!object.gzip) {
    if (object.size === 0) return { bytes: new Uint8Array(0), complete: true }
    const response = await fetch(url, {
      headers: { range: `bytes=0-${Math.min(limit, object.size) - 1}` },
      signal: signal ?? null,
    })
    if (!response.ok)
      throw new Error(`The file could not be read: ${response.status} ${response.statusText}`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    return { bytes: bytes.subarray(0, limit), complete: object.size <= limit }
  }
  const response = await fetch(url, { signal: signal ?? null })
  if (!response.ok || !response.body)
    throw new Error(`The file could not be read: ${response.status} ${response.statusText}`)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  let complete = false
  for (;;) {
    // The decoded stream is read piece by piece until the cap.
    // oxlint-disable-next-line no-await-in-loop -- a stream is read in order
    const { done, value } = await reader.read()
    if (done) {
      complete = true
      break
    }
    chunks.push(value)
    length += value.length
    if (length >= limit) break
  }
  if (!complete) await reader.cancel()
  const bytes = new Uint8Array(Math.min(length, limit))
  let at = 0
  for (const chunk of chunks) {
    const take = Math.min(chunk.length, bytes.length - at)
    bytes.set(chunk.subarray(0, take), at)
    at += take
    if (at >= bytes.length) break
  }
  return { bytes, complete: complete && length <= limit }
}
