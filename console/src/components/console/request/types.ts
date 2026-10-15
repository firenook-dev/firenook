// A request as a composer holds it, and the answer as the console shows it
// (foundation spec §10.8). Functions' Invoke, Cloud Tasks' Enqueue,
// Pub/Sub's Publish and Eventarc's events build one of these; the same
// shape is sent, turned into code, kept in history and shown back.

import type { ViewAs } from '@/lib/identity'

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS'

export const HTTP_METHODS: readonly HttpMethod[] = [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
]

/** One query parameter or header: a `KeyValueEditor` row (its `id` is the editor's own). */
export interface RequestPair {
  key: string
  value: string
  enabled: boolean
}

export type BodyKind = 'none' | 'json' | 'text' | 'form' | 'base64'

export interface RequestBody {
  kind: BodyKind
  /**
   * The body as typed: JSON or text as written, `a=1&b=2` for a form, and
   * base64 for bytes (sent decoded).
   */
  text: string
}

export interface ComposedRequest {
  method: HttpMethod
  /** Same-origin URL the console sends to (a native mount under /console/api/v1). */
  url: string
  /**
   * The address an app or a terminal uses (the service's own port), for
   * code and "Open in a new tab"; built from `serviceAddress(service)`.
   */
  codeUrl: string
  query: readonly RequestPair[]
  headers: readonly RequestPair[]
  body: RequestBody
  identity: ViewAs
}

export interface ResponseRecord {
  status: number
  statusText: string
  headers: [string, string][]
  bodyText?: string
  bodyBase64?: string
  contentType?: string
  /** Time to the first body byte, and to the end, ms. */
  firstByteMs?: number
  durationMs: number
  sizeBytes: number
  /** When it was sent, RFC 3339. */
  at: string
  /** A streamed answer (a callable's sendChunk, SSE, chunked HTTP): the chunks as they came. */
  chunks?: readonly { atMs: number; text: string }[]
  /** Still arriving: a partial record handed to `onUpdate`. */
  receiving?: boolean
  /** The body was longer than the console keeps; `sizeBytes` is all of it. */
  truncated?: boolean
  /** A network failure, a refusal to send, or an abort, in a sentence. */
  error?: string
}

/** The pairs that are switched on and named, in order. */
export function activePairs(pairs: readonly RequestPair[]): RequestPair[] {
  return pairs.filter((pair) => pair.enabled && pair.key.trim() !== '')
}

/** `url` with the enabled query pairs appended (after any query it already has). */
export function withQuery(url: string, query: readonly RequestPair[]): string {
  const pairs = activePairs(query)
  if (pairs.length === 0) return url
  const search = new URLSearchParams()
  for (const pair of pairs) search.append(pair.key.trim(), pair.value)
  return `${url}${url.includes('?') ? '&' : '?'}${search.toString()}`
}

/** The content type a body kind is sent with, unless the headers name one. */
export function bodyContentType(kind: BodyKind): string | undefined {
  switch (kind) {
    case 'json':
      return 'application/json'
    case 'text':
      return 'text/plain; charset=utf-8'
    case 'form':
      return 'application/x-www-form-urlencoded'
    case 'base64':
      return 'application/octet-stream'
    default:
      return undefined
  }
}
