// Storage's conversation with the engine: every Console API route under
// `/console/api/v1/storage/`, typed from the generated contract.
//
// Three things set it apart from the foundation's `apiGet`/`apiSend`:
//
// - a request the rules judge carries the `Authorization` of the identity
//   the page acts as (the caller resolves it with `resolveAuthorization`;
//   none means Admin is not assumed — the console always sends one), and
//   every request carries `x-firenook-console`, so the engine records it as
//   the console's;
// - a refusal is more than a message: the error keeps the decision, the
//   deciding line and the explained re-run the engine sends beside it
//   (`StorageApiError.extras`), so "See why" works after the decision left
//   the engine's window; a stale metageneration keeps the one in force; a
//   draft that does not compile is the rules kit's `RulesCompileError`;
// - an upload streams its bytes with progress (`uploadObject`, an XHR, as
//   `fetch` cannot report upload progress), with the metadata in a
//   `b64.` header.
//
// Media, thumbnails and exports are plain URLs on the console's own origin
// (an `<img>`, a `<video>`, a download link cannot send a header): operator
// reads, which the page draws only where the identity's access check allows.

import { API_BASE, ApiError, type ApiErrorCode, parseErrorBody } from '@/api/client'
import type { BatchGetResponse } from '@/api/generated/BatchGetResponse'
import type { Job } from '@/api/generated/Job'
import type { ListMeta } from '@/api/generated/ListMeta'
import type { Page } from '@/api/generated/Page'
import type { RulesDiagnostic } from '@/api/generated/RulesDiagnostic'
import type { RulesMethod } from '@/api/generated/RulesMethod'
import type { RulesVersion } from '@/api/generated/RulesVersion'
import type { StorageAccess } from '@/api/generated/storage/StorageAccess'
import type { StorageAccessBody } from '@/api/generated/storage/StorageAccessBody'
import type { StorageActivity } from '@/api/generated/storage/StorageActivity'
import type { StorageArchive } from '@/api/generated/storage/StorageArchive'
import type { StorageBatchGetRequest } from '@/api/generated/storage/StorageBatchGetRequest'
import type { StorageBuckets } from '@/api/generated/storage/StorageBuckets'
import type { StorageBulkBody } from '@/api/generated/storage/StorageBulkBody'
import type { StorageBulkPreview } from '@/api/generated/storage/StorageBulkPreview'
import type { StorageCreateFolderBody } from '@/api/generated/storage/StorageCreateFolderBody'
import type { StorageDecisionBatch } from '@/api/generated/storage/StorageDecisionBatch'
import type { StorageDecisionDetail } from '@/api/generated/storage/StorageDecisionDetail'
import type { StorageDecisionsParams } from '@/api/generated/storage/StorageDecisionsParams'
import type { StorageDeleteObjectBody } from '@/api/generated/storage/StorageDeleteObjectBody'
import type { StorageDiscardSessionBody } from '@/api/generated/storage/StorageDiscardSessionBody'
import type { StorageEntry } from '@/api/generated/storage/StorageEntry'
import type { StorageEvaluateBody } from '@/api/generated/storage/StorageEvaluateBody'
import type { StorageEvaluateRequest } from '@/api/generated/storage/StorageEvaluateRequest'
import type { StorageEvaluateResult } from '@/api/generated/storage/StorageEvaluateResult'
import type { StorageEventPayloads } from '@/api/generated/storage/StorageEventPayloads'
import type { StorageExistsBody } from '@/api/generated/storage/StorageExistsBody'
import type { StorageExistsResult } from '@/api/generated/storage/StorageExistsResult'
import type { StorageExportBody } from '@/api/generated/storage/StorageExportBody'
import type { StorageExportTicket } from '@/api/generated/storage/StorageExportTicket'
import type { StorageFolder } from '@/api/generated/storage/StorageFolder'
import type { StorageFolderEntry } from '@/api/generated/storage/StorageFolderEntry'
import type { StorageImpactBody } from '@/api/generated/storage/StorageImpactBody'
import type { StorageListKind } from '@/api/generated/storage/StorageListKind'
import type { StorageListPage } from '@/api/generated/storage/StorageListPage'
import type { StorageObjectDetail } from '@/api/generated/storage/StorageObjectDetail'
import type { StorageProfile } from '@/api/generated/storage/StorageProfile'
import type { StorageResendEventBody } from '@/api/generated/storage/StorageResendEventBody'
import type { StorageResendResult } from '@/api/generated/storage/StorageResendResult'
import type { StorageRulesCheck } from '@/api/generated/storage/StorageRulesCheck'
import type { StorageRulesCheckBody } from '@/api/generated/storage/StorageRulesCheckBody'
import type { StorageRulesDocument } from '@/api/generated/storage/StorageRulesDocument'
import type { StorageRulesEvaluation } from '@/api/generated/storage/StorageRulesEvaluation'
import type { StorageRulesImpact } from '@/api/generated/storage/StorageRulesImpact'
import type { StorageRulesInstalled } from '@/api/generated/storage/StorageRulesInstalled'
import type { StorageRulesWrite } from '@/api/generated/storage/StorageRulesWrite'
import type { StorageTokenBody } from '@/api/generated/storage/StorageTokenBody'
import type { StorageUpdateObjectBody } from '@/api/generated/storage/StorageUpdateObjectBody'
import type { StorageUploadSession } from '@/api/generated/storage/StorageUploadSession'
import { RulesCompileError } from '@/rules/text'

/** Every Storage route is under this. */
export const STORAGE_API = `${API_BASE}/storage`
/** The Storage emulator's own API, on the console's origin (the protocol an app speaks). */
export const STORAGE_NATIVE = `${STORAGE_API}/native`

/** The header every console request carries; the engine records the request as the console's. */
const CONSOLE_HEADER = 'x-firenook-console'
/** An upload's metadata beyond its type: `b64.` and the base64url of the JSON. */
export const METADATA_HEADER = 'x-firenook-metadata'
/** Admin only: a replacement keeps the previous object's download tokens (edit in place). */
export const KEEP_TOKENS_HEADER = 'x-firenook-keep-tokens'

/** What a Storage error carries beside its message (`ApiError::with_extra`). */
export interface StorageErrorExtras {
  /** A refusal: the decision's id, when the engine kept it (`null` when it did not record one). */
  decision?: string | null
  /** A refusal: the line of the rules that decided it. */
  line?: number | null
  /** A refusal because no ruleset governs the bucket at all. */
  noRuleset?: boolean
  /** A console request's refusal: the decision run again, with every expression's value. */
  evaluation?: StorageEvaluateResult | null
  /** A console request's refusal: the request, replayable in the playground. */
  request?: StorageEvaluateRequest | null
  /** A stale `ifMetagenerationMatch`: the metageneration the object has now. */
  current?: string
  /** A filter that does not parse: where, in UTF-16 offsets. */
  span?: { from: number; to: number }
}

/** A failed Storage call, with what the engine sent beside the message. */
export class StorageApiError extends ApiError {
  readonly extras: StorageErrorExtras
  constructor(
    status: number,
    message: string,
    code: ApiErrorCode,
    fix: string | undefined,
    extras: StorageErrorExtras,
  ) {
    super(status, message, code, fix)
    this.name = 'StorageApiError'
    this.extras = extras
  }

  /** The rules refused the request. */
  get refused(): boolean {
    return this.code === 'permission-denied'
  }
}

const EXTRAS = [
  'decision',
  'line',
  'noRuleset',
  'evaluation',
  'request',
  'current',
  'span',
] as const

/** The error a failed response answers with, whatever its body holds. */
export function storageError(status: number, statusText: string, body: unknown): ApiError {
  const fallback = `${status} ${statusText}`.trim()
  const parsed = parseErrorBody(status, body, fallback)
  const record =
    typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : undefined
  const diagnostics = record?.diagnostics
  if (Array.isArray(diagnostics) && diagnostics.length > 0)
    return new RulesCompileError(parsed.message, diagnostics as RulesDiagnostic[])
  const extras: Record<string, unknown> = {}
  for (const key of EXTRAS) if (record && key in record) extras[key] = record[key]
  return new StorageApiError(status, parsed.message, parsed.code, parsed.fix, extras)
}

type Params = Record<string, string | number | boolean | null | undefined>

/** `?a=1&b=x`, `undefined` and `null` left out; `''` when nothing is left. */
export function queryString(params: Params): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params))
    if (value !== undefined && value !== null) search.set(key, String(value))
  return search.size > 0 ? `?${search}` : ''
}

/** How a call is made: as whom (the rules routes), and until when. */
export interface CallOptions {
  /** The `Authorization` the identity the page acts as sends; absent for an operator read. */
  authorization?: string | undefined
  signal?: AbortSignal | undefined
}

async function call<T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body: unknown,
  options: CallOptions = {},
): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json', [CONSOLE_HEADER]: '1' }
  if (options.authorization) headers.authorization = options.authorization
  if (body !== undefined) headers['content-type'] = 'application/json'
  let response: Response
  try {
    response = await fetch(`${STORAGE_API}${path}`, {
      method,
      headers,
      signal: options.signal ?? null,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  } catch (error) {
    // An abort is the caller's own decision, not a failure to report.
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    const reason = error instanceof Error ? error.message : String(error)
    throw new ApiError(0, `The engine did not answer: ${reason}`, 'network')
  }
  if (!response.ok) {
    let parsed: unknown
    try {
      parsed = await response.json()
    } catch {
      parsed = undefined
    }
    throw storageError(response.status, response.statusText, parsed)
  }
  if (response.status === 204 || response.status === 202) {
    // 202 answers a started job with its `Job`; 204 has no body.
    const text = await response.text()
    return (text ? JSON.parse(text) : undefined) as T
  }
  return (await response.json()) as T
}

const get = <T>(path: string, params: Params = {}, options?: CallOptions) =>
  call<T>('GET', `${path}${queryString(params)}`, undefined, options)

// ---------------------------------------------------------------------------
// Buckets, listings, folders.

/** Every bucket, never waiting for the folder index (`objects`/`bytes` are null until it is built). */
export function getBuckets(signal?: AbortSignal): Promise<StorageBuckets> {
  return get('/buckets', {}, { signal })
}

/** What a listing is of: a folder (or everything under it) and how it is narrowed and ordered. */
export interface StorageListScope {
  bucket: string
  /** `''` for the bucket root, else ending in `/`. */
  prefix: string
  /** Every file under `prefix`, without folders. */
  flat?: boolean | undefined
  kind?: StorageListKind | undefined
  /** `<column>:<asc|desc>`; `name:asc` when absent. */
  sort?: string | undefined
  /** A filter in the foundation grammar over Storage's fields. */
  q?: string | undefined
}

/** The default order: the listing's fast path (live rows patched in place) when there is no filter. */
export const DEFAULT_SORT = 'name:asc'

/** Whether a listing patches its rows live (by name, unfiltered) or counts changes and offers Refresh. */
export function isFastPath(scope: Pick<StorageListScope, 'sort' | 'q'>): boolean {
  return (scope.sort ?? DEFAULT_SORT) === DEFAULT_SORT && !scope.q?.trim()
}

/** One page of a listing: `cursor` for the page after, `before` for the page above. */
export function listObjects(
  scope: StorageListScope,
  page: { cursor?: string | undefined; before?: string | undefined; limit?: number | undefined },
  options?: CallOptions,
): Promise<StorageListPage> {
  return get(
    '/objects',
    {
      bucket: scope.bucket,
      prefix: scope.prefix,
      flat: scope.flat ? true : undefined,
      kind: scope.kind && scope.kind !== 'all' ? scope.kind : undefined,
      sort: scope.sort && scope.sort !== DEFAULT_SORT ? scope.sort : undefined,
      q: scope.q?.trim() ? scope.q : undefined,
      cursor: page.cursor,
      before: page.before,
      limit: page.limit,
    },
    options,
  )
}

/** Which columns sort and the filter's fields. */
export function getObjectsMeta(signal?: AbortSignal): Promise<ListMeta> {
  return get('/objects/meta', {}, { signal })
}

/** The rows a live event named, read again for a listing by name (≤ 500 keys). */
export function batchGetObjects(
  body: StorageBatchGetRequest,
  options?: CallOptions,
): Promise<BatchGetResponse<StorageEntry>> {
  return call('POST', '/objects:batchGet', body, options)
}

/** Which of the names are taken (≤ 1,000): an upload's conflict check. */
export function objectsExist(
  body: StorageExistsBody,
  signal?: AbortSignal,
): Promise<StorageExistsResult> {
  return call('POST', '/objects:exists', body, { signal })
}

/** One folder's counts; waits up to 30 s for the folder index. */
export function getFolder(
  bucket: string,
  prefix: string,
  signal?: AbortSignal,
): Promise<StorageFolder> {
  return get('/folder', { bucket, prefix }, { signal })
}

/** What a folder holds: content types, metadata keys, child folders, sizes. */
export function getProfile(
  bucket: string,
  prefix: string,
  signal?: AbortSignal,
): Promise<StorageProfile> {
  return get('/folder/profile', { bucket, prefix }, { signal })
}

/** Creates a folder's zero-byte marker (`prefix/`), judged as a `create`. */
export function createFolder(
  body: StorageCreateFolderBody,
  options?: CallOptions,
): Promise<StorageFolderEntry> {
  return call('POST', '/folders', body, options)
}

// ---------------------------------------------------------------------------
// Bulk work: foundation Jobs.

/** The verbs that run as one foundation Job. */
export type StorageBulkVerb = 'delete' | 'move' | 'copy' | 'metadata'

/** What the verb would touch, changing nothing: the counts a dialog shows. */
export function previewBulk(
  verb: StorageBulkVerb,
  body: Omit<StorageBulkBody, 'dryRun'>,
  options?: CallOptions,
): Promise<StorageBulkPreview> {
  return call('POST', `/objects:${verb}`, { ...body, dryRun: true }, options)
}

/** Starts the verb as a foundation Job (`useJob(job.id)` follows it); a fifth running Storage job is 409. */
export function startBulk(
  verb: StorageBulkVerb,
  body: Omit<StorageBulkBody, 'dryRun'>,
  options?: CallOptions,
): Promise<Job> {
  return call('POST', `/objects:${verb}`, { ...body, dryRun: false }, options)
}

/** A selection too long for a URL, as a download ticket. */
export function exportTicket(body: StorageExportBody): Promise<StorageExportTicket> {
  return call('POST', '/objects:export', body)
}

/** A folder or a whole bucket as one streamed `.zip` (a plain download link). */
export function exportUrl(bucket: string, prefix = ''): string {
  return `${STORAGE_API}/objects:export${queryString({ bucket, prefix: prefix || undefined })}`
}

// ---------------------------------------------------------------------------
// One object.

/** Everything the engine knows about an object, judged as a `get`; tokens only for Admin. */
export function getObject(
  bucket: string,
  name: string,
  options?: CallOptions,
): Promise<StorageObjectDetail> {
  return get('/object', { bucket, name }, options)
}

/** Deletes one object, judged as a `delete`. */
export function deleteObject(body: StorageDeleteObjectBody, options?: CallOptions): Promise<void> {
  return call('DELETE', '/object', body, options)
}

/** A metadata patch, judged as an `update`; a stale `ifMetagenerationMatch` is 412 with `current`. */
export function updateMetadata(
  body: StorageUpdateObjectBody,
  options?: CallOptions,
): Promise<StorageObjectDetail> {
  return call('POST', '/object/metadata', body, options)
}

/** Creates or revokes a download token: Admin only, as the official API. */
export function changeToken(
  body: StorageTokenBody,
  options?: CallOptions,
): Promise<StorageObjectDetail> {
  return call('POST', '/object/token', body, options)
}

/** Sends the finalize or metadataUpdate event again, without rewriting the object (Admin only). */
export function resendEvent(
  body: StorageResendEventBody,
  options?: CallOptions,
): Promise<StorageResendResult> {
  return call('POST', '/object/resend', body, options)
}

/** A zip's entries from its central directory (≤ 2,000). */
export function getArchive(
  bucket: string,
  name: string,
  generation: string,
  limit?: number,
  signal?: AbortSignal,
): Promise<StorageArchive> {
  return get('/object/archive', { bucket, name, g: generation, limit }, { signal })
}

/** The object's changes and the rules decisions on its name, newest first. */
export function getActivity(
  bucket: string,
  name: string,
  signal?: AbortSignal,
): Promise<StorageActivity> {
  return get('/object/activity', { bucket, name }, { signal })
}

/** The v1 and v2 bodies the object's Storage events carry now. */
export function getEventPayloads(
  bucket: string,
  name: string,
  signal?: AbortSignal,
): Promise<StorageEventPayloads> {
  return get('/object/events', { bucket, name }, { signal })
}

/**
 * The bytes, on the console's origin: inline (sandboxed, `nosniff`) or as a
 * download. With the generation the response is cached for ever.
 */
export function mediaUrl(object: {
  bucket: string
  name: string
  generation?: string | undefined
  download?: boolean | undefined
}): string {
  return `${STORAGE_API}/object/media${queryString({
    bucket: object.bucket,
    name: object.name,
    g: object.generation,
    download: object.download ? 1 : undefined,
  })}`
}

/** A picture of an image, 160, 320 or 640 px wide, cached for ever by generation. */
export function thumbnailUrl(object: {
  bucket: string
  name: string
  generation: string
  width?: 160 | 320 | 640 | undefined
}): string {
  return `${STORAGE_API}/object/thumbnail${queryString({
    bucket: object.bucket,
    name: object.name,
    g: object.generation,
    w: object.width ?? 320,
  })}`
}

// ---------------------------------------------------------------------------
// Uploads.

/** What an upload carries besides its bytes and type. */
export interface StorageUploadMetadata {
  cacheControl?: string | undefined
  contentDisposition?: string | undefined
  contentEncoding?: string | undefined
  contentLanguage?: string | undefined
  customMetadata?: Record<string, string> | undefined
}

/**
 * The metadata as the `x-firenook-metadata` header: `b64.` and the base64url
 * (no padding) of the JSON. A header value must be bytes the browser
 * accepts, and a raw `été` would make it throw before sending.
 */
export function encodeMetadataHeader(metadata: StorageUploadMetadata): string {
  const fields: Record<string, unknown> = {}
  for (const key of [
    'cacheControl',
    'contentDisposition',
    'contentEncoding',
    'contentLanguage',
  ] as const)
    if (metadata[key] !== undefined) fields[key] = metadata[key]
  if (metadata.customMetadata && Object.keys(metadata.customMetadata).length > 0)
    fields.customMetadata = metadata.customMetadata
  const bytes = new TextEncoder().encode(JSON.stringify(fields))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return `b64.${btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')}`
}

/** One file to upload, through the commit path an SDK upload takes. */
export interface StorageUploadSpec {
  bucket: string
  name: string
  /** The object's type; `application/octet-stream` when absent. */
  contentType?: string | undefined
  metadata?: StorageUploadMetadata | undefined
  /** Refuse to replace an object that exists (409 `already-exists`). */
  ifNoneMatch?: boolean | undefined
  /** Admin only: keep the previous object's download tokens (an edit in place). */
  keepTokens?: boolean | undefined
  authorization?: string | undefined
}

/** Where an upload goes. */
export function uploadUrl(bucket: string, name: string): string {
  return `${STORAGE_API}/object${queryString({ bucket, name })}`
}

/** The headers an upload sends. */
export function uploadHeaders(spec: StorageUploadSpec): Record<string, string> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    'content-type': spec.contentType || 'application/octet-stream',
    [CONSOLE_HEADER]: '1',
  }
  if (spec.authorization) headers.authorization = spec.authorization
  if (spec.metadata) {
    const encoded = encodeMetadataHeader(spec.metadata)
    if (encoded !== encodeMetadataHeader({})) headers[METADATA_HEADER] = encoded
  }
  if (spec.ifNoneMatch) headers['if-none-match'] = '*'
  if (spec.keepTokens) headers[KEEP_TOKENS_HEADER] = 'true'
  return headers
}

/** What `uploadObject` needs of a request: the browser's XHR, which a test can stand in for. */
export interface UploadTransport {
  open(method: string, url: string): void
  setRequestHeader(name: string, value: string): void
  send(body: Blob | ArrayBuffer | string): void
  abort(): void
  readonly status: number
  readonly statusText: string
  readonly responseText: string
  upload: {
    addEventListener(
      type: 'progress',
      listener: (event: { loaded: number; total: number; lengthComputable: boolean }) => void,
    ): void
  }
  addEventListener(type: 'load' | 'error' | 'abort', listener: () => void): void
}

/**
 * Streams one file to `PUT /storage/object`, reporting progress, and answers
 * the stored object. An abort through `signal` stops the request (the engine
 * removes the staged bytes) and rejects with an `AbortError`.
 */
export function uploadObject(
  body: Blob | ArrayBuffer | string,
  spec: StorageUploadSpec,
  options: {
    onProgress?: ((loaded: number, total: number) => void) | undefined
    signal?: AbortSignal | undefined
    transport?: () => UploadTransport
  } = {},
): Promise<StorageObjectDetail> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new DOMException('The upload was cancelled.', 'AbortError'))
      return
    }
    const request = options.transport?.() ?? (new XMLHttpRequest() as unknown as UploadTransport)
    const stop = () => request.abort()
    options.signal?.addEventListener('abort', stop, { once: true })
    const done = () => options.signal?.removeEventListener('abort', stop)
    request.open('PUT', uploadUrl(spec.bucket, spec.name))
    for (const [name, value] of Object.entries(uploadHeaders(spec)))
      request.setRequestHeader(name, value)
    request.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) options.onProgress?.(event.loaded, event.total)
    })
    request.addEventListener('load', () => {
      done()
      let parsed: unknown
      try {
        parsed = request.responseText ? JSON.parse(request.responseText) : undefined
      } catch {
        parsed = undefined
      }
      if (request.status >= 200 && request.status < 300) resolve(parsed as StorageObjectDetail)
      else reject(storageError(request.status, request.statusText, parsed))
    })
    request.addEventListener('error', () => {
      done()
      reject(new ApiError(0, 'The engine did not answer the upload.', 'network'))
    })
    request.addEventListener('abort', () => {
      done()
      reject(new DOMException('The upload was cancelled.', 'AbortError'))
    })
    request.send(body)
  })
}

// ---------------------------------------------------------------------------
// Resumable sessions an app started.

/** Resumable uploads not finished, newest activity first. */
export function listSessions(
  bucket: string,
  page: { cursor?: string | undefined; before?: string | undefined; limit?: number | undefined },
  signal?: AbortSignal,
): Promise<Page<StorageUploadSession>> {
  return get('/sessions', { bucket, ...page }, { signal })
}

/** Removes a session and its staged bytes (Admin only). */
export function discardSession(
  body: StorageDiscardSessionBody,
  options?: CallOptions,
): Promise<void> {
  return call('POST', '/session/discard', body, options)
}

// ---------------------------------------------------------------------------
// Rules.

/** The rules governing a bucket (its scope's, in single-file mode every bucket's). */
export function getRules(
  bucket: string | undefined,
  signal?: AbortSignal,
): Promise<StorageRulesDocument> {
  return get('/rules', { bucket }, { signal })
}

/** Installs a draft (and writes the scope's file with `save`); a draft that does not compile is a `RulesCompileError`. */
export function putRules(body: StorageRulesWrite): Promise<StorageRulesInstalled> {
  return call('PUT', '/rules', body)
}

/** Compiles and reads a draft, installing nothing; compile errors are an answer. */
export function checkRules(
  body: StorageRulesCheckBody,
  signal?: AbortSignal,
): Promise<StorageRulesCheck> {
  return call('POST', '/rules/check', body, { signal })
}

/** Every ruleset that governed the scope, newest first. */
export function getRulesHistory(
  bucket: string | undefined,
  signal?: AbortSignal,
): Promise<RulesVersion[]> {
  return get('/rules/history', { bucket }, { signal })
}

/** A dry run of up to 200 requests, against a draft or the rules in force; nothing is recorded. */
export function evaluateRules(
  body: StorageEvaluateBody,
  signal?: AbortSignal,
): Promise<StorageRulesEvaluation> {
  return call('POST', '/rules/evaluate', body, { signal })
}

/** The retained decisions the topic's parameters match: the first paint before the topic replays. */
export function getDecisions(
  params: StorageDecisionsParams,
  signal?: AbortSignal,
): Promise<StorageDecisionBatch> {
  return get(
    '/rules/decisions',
    { ...params, denied: params.denied ? true : undefined },
    { signal },
  )
}

/** A decision, run again with every expression's value; `null` once it left the re-runnable window. */
export async function getDecision(
  id: string,
  signal?: AbortSignal,
): Promise<StorageDecisionDetail | null> {
  try {
    return await get<StorageDecisionDetail>(
      `/rules/decisions/${encodeURIComponent(id)}`,
      {},
      { signal },
    )
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null
    throw error
  }
}

/** What applying a draft would turn around among the decisions the engine can re-run. */
export function getImpact(
  body: StorageImpactBody,
  signal?: AbortSignal,
): Promise<StorageRulesImpact> {
  return call('POST', '/rules/impact', body, { signal })
}

/** The official per-expression coverage report of the rules in force (the rules kit reads it). */
export function coverageUrl(bucket: string | undefined): string {
  return `${STORAGE_API}/rules/coverage${queryString({ bucket })}`
}

/** What an identity may do with each object (≤ 200 names, ≤ 3 methods), unrecorded. */
export function getAccess(body: StorageAccessBody, signal?: AbortSignal): Promise<StorageAccess> {
  return call('POST', '/rules/access', body, { signal })
}

/** The methods a Files page asks the access check about. */
export const ACCESS_METHODS: readonly RulesMethod[] = ['get', 'delete']
