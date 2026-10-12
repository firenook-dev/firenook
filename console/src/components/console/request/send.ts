// Sending a composed request from the console, same-origin, and reading
// the answer as it arrives: a function that streams (a callable's
// sendChunk, server-sent events, chunked HTTP) shows its output while it
// runs instead of only when it ends. The request runs as the composer's
// identity through `fetchAs`, so a user's token is the one the engine
// minted, and it holds one of the tab's long-request slots while it is
// open (§6.6).

import { fetchAs } from '@/lib/identity'
import { longRequests } from '@/lib/long-requests'
import {
  type ComposedRequest,
  type ResponseRecord,
  activePairs,
  bodyContentType,
  withQuery,
} from './types'

/** The most of a body kept for display; the size still counts all of it. */
export const MAX_KEPT_BODY = 5 * 1024 * 1024
/** Chunks kept one by one; later ones are folded into the last. */
const MAX_CHUNKS = 2_000

const TEXTUAL =
  /^(text\/|application\/(json|[\w.+-]*\+json|x-ndjson|ndjson|javascript|ecmascript|xml|[\w.+-]*\+xml|x-www-form-urlencoded|graphql|yaml|x-yaml)\b)/i

/** Whether a content type is text the console can show as it is. */
export function isTextual(contentType: string | undefined): boolean {
  return contentType !== undefined && TEXTUAL.test(contentType.trim())
}

/** The bytes a body kind sends, or why it cannot be sent. */
export function encodeBody(
  request: Pick<ComposedRequest, 'method' | 'body'>,
): { body?: BodyInit } | { error: string } {
  if (request.body.kind === 'none' || request.method === 'GET' || request.method === 'HEAD')
    return {}
  if (request.body.kind !== 'base64') return { body: request.body.text }
  const compact = request.body.text.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/')
  try {
    const binary = atob(compact)
    return { body: Uint8Array.from(binary, (char) => char.charCodeAt(0)) }
  } catch {
    return {
      error: 'The body is not base64. Paste the bytes as base64, or pick another body type.',
    }
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  const step = 0x8000
  for (let at = 0; at < bytes.length; at += step)
    binary += String.fromCharCode(...bytes.subarray(at, at + step))
  return btoa(binary)
}

function joined(parts: readonly Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

function failure(error: unknown, signal: AbortSignal | undefined): string {
  if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError'))
    return 'Stopped before the answer finished.'
  const reason = error instanceof Error ? error.message : String(error)
  return `The request did not reach the engine: ${reason}`
}

/**
 * Sends `request` and reads its answer chunk by chunk. `onUpdate` is called
 * with the record so far after each chunk (`receiving: true`), and the
 * promise resolves with the finished record — also for a failure, which is
 * said in `error`, never thrown.
 */
export async function sendComposed(
  request: ComposedRequest,
  project: string,
  options: { signal?: AbortSignal; onUpdate?: (partial: ResponseRecord) => void } = {},
): Promise<ResponseRecord> {
  const { signal, onUpdate } = options
  const at = new Date().toISOString()
  const started = performance.now()
  const since = () => performance.now() - started
  const failed = (error: string): ResponseRecord => ({
    status: 0,
    statusText: '',
    headers: [],
    durationMs: since(),
    sizeBytes: 0,
    at,
    error,
  })

  const encoded = encodeBody(request)
  if ('error' in encoded) return failed(encoded.error)
  const headers = new Headers()
  for (const pair of activePairs(request.headers)) {
    try {
      headers.append(pair.key.trim(), pair.value)
    } catch {
      return failed(`${pair.key.trim()} cannot be sent as a header name or value.`)
    }
  }
  const type = encoded.body === undefined ? undefined : bodyContentType(request.body.kind)
  if (type && !headers.has('content-type')) headers.set('content-type', type)
  // Services read this to mark the request as the console's own (and, for
  // Functions, to answer with the invocation id); code to copy leaves it out.
  if (!headers.has('x-firenook-console')) headers.set('x-firenook-console', '1')
  const explicit = headers.has('authorization')

  let release: (() => void) | undefined
  try {
    release = await longRequests.acquire(signal)
  } catch (error) {
    return failed(failure(error, signal))
  }
  try {
    const url = withQuery(request.url, request.query)
    const send = (authorization: string | undefined) => {
      const sent = new Headers(headers)
      if (!explicit && authorization) sent.set('authorization', authorization)
      return fetch(url, {
        method: request.method,
        headers: sent,
        signal: signal ?? null,
        ...(encoded.body === undefined ? {} : { body: encoded.body }),
      })
    }
    let response: Response
    try {
      response = explicit
        ? await send(undefined)
        : await fetchAs(request.identity, project, send, signal)
    } catch (error) {
      return failed(failure(error, signal))
    }

    const contentType = response.headers.get('content-type') ?? undefined
    const record: ResponseRecord = {
      status: response.status,
      statusText: response.statusText,
      headers: [...response.headers.entries()],
      ...(contentType === undefined ? {} : { contentType }),
      durationMs: since(),
      sizeBytes: 0,
      at,
    }
    if (!response.body) return { ...record, firstByteMs: record.durationMs }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    const kept: Uint8Array[] = []
    let keptBytes = 0
    const chunks: { atMs: number; text: string }[] = []
    let firstByteMs: number | undefined
    try {
      for (;;) {
        // Chunks arrive one after another; there is nothing to run in parallel.
        // oxlint-disable-next-line no-await-in-loop
        const { done, value } = await reader.read()
        if (done) break
        const now = since()
        firstByteMs ??= now
        record.sizeBytes += value.length
        if (keptBytes < MAX_KEPT_BODY) {
          const room = MAX_KEPT_BODY - keptBytes
          const part = value.length > room ? value.subarray(0, room) : value
          kept.push(part)
          keptBytes += part.length
        }
        const text = decoder.decode(value, { stream: true })
        if (chunks.length < MAX_CHUNKS) chunks.push({ atMs: now, text })
        else {
          const last = chunks[chunks.length - 1]
          if (last) last.text += text
        }
        onUpdate?.({
          ...record,
          firstByteMs,
          durationMs: now,
          chunks: [...chunks],
          receiving: true,
        })
      }
    } catch (error) {
      return {
        ...record,
        ...(firstByteMs === undefined ? {} : { firstByteMs }),
        durationMs: since(),
        chunks,
        error: failure(error, signal),
      }
    }

    const bytes = joined(kept, keptBytes)
    const finished: ResponseRecord = {
      ...record,
      firstByteMs: firstByteMs ?? record.durationMs,
      durationMs: since(),
      ...(chunks.length > 1 ? { chunks } : {}),
      ...(record.sizeBytes > keptBytes ? { truncated: true } : {}),
    }
    if (isTextual(contentType)) return { ...finished, bodyText: new TextDecoder().decode(bytes) }
    if (contentType === undefined) {
      try {
        return { ...finished, bodyText: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
      } catch {
        // Not text after all: shown as bytes.
      }
    }
    return { ...finished, bodyBase64: toBase64(bytes) }
  } finally {
    release()
  }
}
