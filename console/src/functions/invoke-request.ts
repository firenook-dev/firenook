// The Invoke form's draft as what goes on the wire: the engine's
// `FunctionInvokeRequest` (method, the path after the function's address
// with its query, every enabled header plus the ones Call as and the body
// add, the body and how it is written), the kit's `ComposedRequest` for
// history and Copy as, and a draft read back from a recorded invocation
// (Edit and replay).

import type { FunctionInvokeRequest } from '@/api/generated/compute/FunctionInvokeRequest'
import type { InvocationDetail } from '@/api/generated/compute/InvocationDetail'
import { type KeyValueRow, rowId } from '@/components/console/key-value-editor'
import {
  type ComposedRequest,
  HTTP_METHODS,
  type HttpMethod,
  type RequestBody,
  activePairs,
  bodyContentType,
  withQuery,
} from '@/components/console/request/types'
import type { IdentityHeader } from './identity-headers'
import type { InvokeDraft } from './run-drafts'

/** A fresh Invoke draft: GET at the function's root, no auth. */
export function emptyInvokeDraft(): InvokeDraft {
  return {
    kind: 'request',
    method: 'GET',
    path: '/',
    query: [],
    headers: [],
    body: { kind: 'none', text: '' },
    identity: { kind: 'owner' },
    appCheck: { kind: 'none' },
  }
}

/** `/users?active=true&x=1` → the path and the query as rows (`?` pairs move to the Query editor). */
export function splitPath(text: string): { path: string; query: KeyValueRow[] } {
  const at = text.indexOf('?')
  const raw = at === -1 ? text : text.slice(0, at)
  const path = raw === '' ? '/' : raw.startsWith('/') ? raw : `/${raw}`
  if (at === -1) return { path, query: [] }
  const query: KeyValueRow[] = []
  for (const [key, value] of new URLSearchParams(text.slice(at + 1)))
    query.push({ id: rowId(), key, value, enabled: true })
  return { path, query }
}

/** The path the engine is sent: the draft's path with its enabled query rows. */
export function pathWithQuery(draft: Pick<InvokeDraft, 'path' | 'query'>): string {
  return withQuery(draft.path === '' ? '/' : draft.path, draft.query)
}

/** Whether a method carries a body here. */
export function sendsBody(method: string, body: RequestBody): boolean {
  return body.kind !== 'none' && method !== 'GET' && method !== 'HEAD'
}

/** The content type the body sets, unless a header of the draft names one. */
export function bodyHeader(
  draft: Pick<InvokeDraft, 'method' | 'body' | 'headers'>,
): string | undefined {
  if (!sendsBody(draft.method, draft.body)) return undefined
  if (activePairs(draft.headers).some((pair) => pair.key.trim().toLowerCase() === 'content-type'))
    return undefined
  return bodyContentType(draft.body.kind)
}

/** What is wrong with the draft before it can be sent, or undefined. */
export function invokeProblem(draft: InvokeDraft): string | undefined {
  if (!draft.path.startsWith('/')) return 'The path starts with /.'
  if (draft.body.kind === 'json' && sendsBody(draft.method, draft.body)) {
    try {
      JSON.parse(draft.body.text)
    } catch {
      return 'The JSON body does not parse.'
    }
  }
  if (
    draft.body.kind === 'base64' &&
    sendsBody(draft.method, draft.body) &&
    !/^[A-Za-z0-9+/=\s]*$/.test(draft.body.text)
  )
    return 'The body is not base64.'
  return undefined
}

/** The request the engine is asked to make: headers in order (the draft's, then Call as, then the body's). */
export function invokeRequest(
  draft: InvokeDraft,
  identity: readonly IdentityHeader[],
): FunctionInvokeRequest {
  const headers = activePairs(draft.headers).map((pair) => ({
    name: pair.key.trim(),
    value: pair.value,
  }))
  const named = new Set(headers.map((header) => header.name.toLowerCase()))
  for (const header of identity)
    if (!named.has(header.name)) headers.push({ name: header.name, value: header.value })
  const type = bodyHeader(draft)
  if (type) headers.push({ name: 'content-type', value: type })
  const body = sendsBody(draft.method, draft.body)
    ? draft.body
    : { kind: 'none' as const, text: '' }
  return {
    target: 'url',
    method: draft.method,
    path: pathWithQuery(draft),
    headers,
    body:
      body.kind === 'none'
        ? ''
        : body.kind === 'base64'
          ? body.text.replace(/\s+/g, '')
          : body.text,
    encoding: body.kind === 'none' ? 'empty' : body.kind === 'base64' ? 'base64' : 'text',
  }
}

/**
 * The kit's request for history and Copy as: addressed to the function as
 * apps reach it, with Call as's headers written out (so "No auth" sends no
 * Authorization, and an Auth user's is the engine's token).
 */
export function composedRequest(
  draft: InvokeDraft,
  functionUrl: string,
  identity: readonly IdentityHeader[],
): ComposedRequest {
  const rows = [
    ...draft.headers,
    ...identity
      .filter(
        (header) =>
          !activePairs(draft.headers).some((pair) => pair.key.trim().toLowerCase() === header.name),
      )
      .map((header) => ({ key: header.name, value: header.value, enabled: true })),
  ]
  return {
    method: draft.method,
    url: functionUrl + (draft.path === '/' ? '' : draft.path),
    codeUrl: functionUrl + (draft.path === '/' ? '' : draft.path),
    query: draft.query,
    headers: rows,
    body: sendsBody(draft.method, draft.body) ? draft.body : { kind: 'none', text: '' },
    // The headers above carry the identity; code adds no other.
    identity: { kind: 'anonymous' },
  }
}

/** Headers a recorded request carried that a draft never copies: the engine's own and the hop's. */
const NOT_COPIED =
  /^(x-firenook-|host$|content-length$|connection$|transfer-encoding$|accept-encoding$|traceparent$)/i

/**
 * A draft filled from a recorded invocation (Edit and replay): method,
 * path and query, headers (a sensitive one is left out — Call as mints
 * it again), and the body as it was written.
 */
export function draftFromInvocation(detail: InvocationDetail, base: InvokeDraft): InvokeDraft {
  const request = detail.request
  const method = (HTTP_METHODS as readonly string[]).includes(request.method.toUpperCase())
    ? (request.method.toUpperCase() as HttpMethod)
    : 'POST'
  const { path, query } = splitPath(request.path)
  const headers: KeyValueRow[] = request.headers
    .filter((header) => header.value !== null && !header.sensitive && !NOT_COPIED.test(header.name))
    .map((header) => ({ id: rowId(), key: header.name, value: header.value ?? '', enabled: true }))
  const type = (request.contentType ?? '').toLowerCase()
  const bodyKind: RequestBody['kind'] =
    request.body.encoding === 'empty' || request.body.size === 0
      ? 'none'
      : request.body.encoding === 'base64'
        ? 'base64'
        : type.includes('json')
          ? 'json'
          : 'text'
  return {
    ...base,
    method,
    path,
    query,
    headers: headers.filter(
      (header) => header.key.toLowerCase() !== 'content-type' || bodyKind === 'text',
    ),
    body: { kind: bodyKind, text: bodyKind === 'none' ? '' : request.body.text },
  }
}
