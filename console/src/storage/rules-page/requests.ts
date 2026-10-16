// A request to try against Storage's rules, as the playground writes it and
// as the engine evaluates it. The form is what a person can type — an
// operation, a bucket, an object name or a folder, who is asking, and for an
// upload or a metadata change the file it proposes (a size with its unit, a
// content type, custom metadata) — and here it becomes the request a real
// client would send, through the engine's own request builder.
//
// Who is asking is the rules kit's `Who` (`src/rules/who.ts`), the same as
// Firestore's: an identity from the console's picker, run as a token minted
// for it, or a recorded request's own credentials. A replayed decision keeps
// the identity, the file and the time it was recorded with until the
// request is changed.

import type { EvaluateAuth } from '@/api/generated/EvaluateAuth'
import type { RulesMethod } from '@/api/generated/RulesMethod'
import type { StorageDecision } from '@/api/generated/storage/StorageDecision'
import type { StorageEvaluateRequest } from '@/api/generated/storage/StorageEvaluateRequest'
import type { StorageProposedObject } from '@/api/generated/storage/StorageProposedObject'
import type { StorageRulesObjectView } from '@/api/generated/storage/StorageRulesObjectView'
import { type KeyValueRow, rowId } from '@/components/console/key-value-editor'
import { formatBytes } from '@/lib/format'
import { ANONYMOUS, type Who, credentialsOf, describeWho } from '@/rules/who'

export type { Who }

export const SIZE_UNITS = ['B', 'KB', 'MB', 'GB'] as const
export type SizeUnit = (typeof SIZE_UNITS)[number]

const UNIT_BYTES: Record<SizeUnit, number> = {
  B: 1,
  KB: 1024,
  MB: 1024 * 1024,
  GB: 1024 * 1024 * 1024,
}

/** What the playground's form holds. */
export interface PlaygroundForm {
  method: RulesMethod
  /** The bucket; empty is the page's. */
  bucket: string
  /** The object's name; for a list, the folder (empty is the bucket's root). */
  path: string
  who: Who
  /** Create: the upload's size as typed, in `unit`. */
  size: string
  unit: SizeUnit
  /** Create: the upload's type (empty: none). Update: the type it sets (empty: unchanged). */
  contentType: string
  /** Custom metadata the upload carries, or the keys an update sets (an empty value removes one). */
  metadata: KeyValueRow[]
  /** The file before the request: read from the bucket now, or taken as not there. */
  existing: 'store' | 'missing'
  /** `request.time` as a local `datetime-local` value; empty is now. */
  time: string
  /** From a recorded request: the files and the time it was decided with. */
  replay?:
    | {
        /** The decision it was, when the engine recorded one. */
        decisionId?: string | undefined
        /** The file as it was then; null: it did not exist. Absent: read the bucket now. */
        resource?: StorageRulesObjectView | null | undefined
        /** The proposed file exactly as recorded (its hashes and generation too). */
        requestResource?: StorageRulesObjectView | null | undefined
        time?: string | undefined
      }
    | undefined
}

export const EMPTY_FORM: PlaygroundForm = {
  method: 'get',
  bucket: '',
  path: '',
  who: ANONYMOUS,
  size: '1',
  unit: 'MB',
  contentType: 'image/png',
  metadata: [],
  existing: 'store',
  time: '',
}

/** Whether a method writes a file, and so proposes one. */
export function proposes(method: RulesMethod): boolean {
  return method === 'create' || method === 'update'
}

/** A size as typed, in bytes; undefined when it is not a size. */
export function toBytes(size: string, unit: SizeUnit): number | undefined {
  const text = size.trim()
  if (!/^\d+(\.\d+)?$/.test(text)) return undefined
  return Math.round(Number(text) * UNIT_BYTES[unit])
}

/** A byte count as the form writes it: the largest unit it is a whole number of. */
export function sizeFields(bytes: number): { size: string; unit: SizeUnit } {
  for (const unit of ['GB', 'MB', 'KB'] as const)
    if (bytes >= UNIT_BYTES[unit] && bytes % UNIT_BYTES[unit] === 0)
      return { size: String(bytes / UNIT_BYTES[unit]), unit }
  return { size: String(bytes), unit: 'B' }
}

/** A folder as a list names it: empty for the root, else ending in `/`. */
export function folderOf(path: string): string {
  return path === '' || path.endsWith('/') ? path : `${path}/`
}

/** What is wrong with the form's path for its method, in a sentence; undefined when it is fine. */
export function pathProblem(method: RulesMethod, path: string): string | undefined {
  if (method === 'list') return undefined
  if (path === '') return 'Name the file, such as users/u1/avatar.png.'
  if (path.endsWith('/')) return 'A file’s name does not end with /. To try a folder, choose list.'
  return undefined
}

/** The custom metadata a form proposes: values to set, and for an update `null` to remove. */
export function metadataOf(
  rows: readonly KeyValueRow[],
  method: RulesMethod,
): Record<string, string | null> {
  const out: Record<string, string | null> = {}
  for (const row of rows) {
    if (!row.enabled || row.key === '') continue
    out[row.key] = method === 'update' && row.value === '' ? null : row.value
  }
  return out
}

/** A `datetime-local` value as RFC 3339, or undefined when it is not a time. */
export function timeOf(local: string): string | undefined {
  if (local.trim() === '') return undefined
  const at = new Date(local)
  return Number.isNaN(at.getTime()) ? undefined : at.toISOString()
}

/** The playground's form as the request the engine evaluates. */
export function toEvaluateRequest(
  form: PlaygroundForm,
  project: string,
  fallbackBucket: string,
): { request: StorageEvaluateRequest } | { error: string } {
  const problem = pathProblem(form.method, form.path)
  if (problem) return { error: problem }
  const bucket = form.bucket || fallbackBucket
  const request: StorageEvaluateRequest = {
    method: form.method,
    bucket,
    path: form.method === 'list' ? folderOf(form.path) : form.path,
  }

  const credentials = credentialsOf(form.who, project)
  if ('error' in credentials) return credentials
  if (credentials.authorization) request.authorization = credentials.authorization
  else if (credentials.auth) request.auth = credentials.auth

  if (proposes(form.method)) {
    const proposed: StorageProposedObject = {}
    if (form.method === 'create') {
      const bytes = toBytes(form.size, form.unit)
      if (bytes === undefined) return { error: 'Give the upload a size, such as 2 MB.' }
      proposed.size = bytes
      proposed.contentType = form.contentType.trim() || null
    } else if (form.contentType.trim()) {
      proposed.contentType = form.contentType.trim()
    }
    const metadata = metadataOf(form.metadata, form.method)
    if (Object.keys(metadata).length > 0) proposed.customMetadata = metadata
    request.proposed = proposed
    if (form.replay?.requestResource) request.requestResource = form.replay.requestResource
  }

  if (form.replay && form.replay.resource !== undefined) request.resource = form.replay.resource
  else if (form.existing === 'missing' && form.method !== 'list') request.resource = null

  const typed = timeOf(form.time)
  if (form.time.trim() !== '' && typed === undefined)
    return { error: 'The time is not a date and time.' }
  const time = typed ?? form.replay?.time
  if (time) request.time = time
  return { request }
}

/** Custom metadata as the key/value editor's rows. */
function rowsOf(metadata: Record<string, string | null> | undefined): KeyValueRow[] {
  return Object.entries(metadata ?? {}).map(([key, value]) => ({
    id: rowId(),
    key,
    value: value ?? '',
    enabled: true,
  }))
}

/**
 * A recorded request as the playground's form, so it can be tried again and
 * changed: a decision's, or a refusal the Files page met (`decisionId` when
 * the engine recorded one). What it recorded of the files and the time is
 * replayed as it was; a request that recorded none of them (an upload
 * judged before any byte went) reads the bucket now, as it did itself.
 */
export function formFromRequest(
  request: StorageEvaluateRequest,
  decisionId?: string | null,
): PlaygroundForm {
  const proposed = request.proposed ?? undefined
  const recordedSize = proposed?.size ?? request.requestResource?.size
  const { size, unit } =
    recordedSize === undefined
      ? { size: EMPTY_FORM.size, unit: EMPTY_FORM.unit }
      : sizeFields(recordedSize)
  const contentType =
    proposed?.contentType !== undefined
      ? (proposed.contentType ?? '')
      : request.method === 'create'
        ? (request.requestResource?.contentType ?? '')
        : ''
  const recorded =
    request.resource !== undefined || request.requestResource !== undefined || Boolean(request.time)
  return {
    method: request.method,
    bucket: request.bucket,
    path: request.path,
    who: {
      kind: 'recorded',
      auth: request.auth ?? null,
      ...(request.authorization ? { authorization: request.authorization } : {}),
    },
    size,
    unit,
    contentType,
    metadata: rowsOf(proposed?.customMetadata),
    existing: request.resource === null ? 'missing' : 'store',
    time: '',
    ...(recorded
      ? {
          replay: {
            ...(decisionId ? { decisionId } : {}),
            ...(request.resource === undefined ? {} : { resource: request.resource }),
            ...(request.requestResource === undefined
              ? {}
              : { requestResource: request.requestResource }),
            ...(request.time ? { time: request.time } : {}),
          },
        }
      : {}),
  }
}

/**
 * A decision the engine no longer keeps the request of, as a form from its
 * summary: the operation, the file, who asked (their uid and sign-in
 * provider) and what an upload proposed. The file is read from the bucket
 * as it is now.
 */
export function formFromDecision(decision: StorageDecision): PlaygroundForm {
  const firebase: Record<string, unknown> = {}
  if (decision.provider) firebase.sign_in_provider = decision.provider
  if (decision.tenant) firebase.tenant = decision.tenant
  const auth: EvaluateAuth | null =
    decision.anonymous || decision.uid === null
      ? null
      : {
          uid: decision.uid,
          token: { sub: decision.uid, user_id: decision.uid, firebase },
        }
  const { size, unit } =
    decision.size === null
      ? { size: EMPTY_FORM.size, unit: EMPTY_FORM.unit }
      : sizeFields(decision.size)
  return {
    method: decision.method,
    bucket: decision.bucket,
    path: decision.path,
    who: { kind: 'recorded', auth },
    size,
    unit,
    contentType: decision.contentType ?? '',
    metadata: [],
    existing: 'store',
    time: '',
  }
}

/**
 * A request in a line: `create users/u1/big.mov as ada@example.test · 7 MB
 * video/quicktime`; the bucket only when it is not the page's.
 */
export function describeForm(form: PlaygroundForm, pageBucket?: string): string {
  const path = form.method === 'list' ? folderOf(form.path) || '/' : form.path || '…'
  const bucket = form.bucket && form.bucket !== pageBucket ? `gs://${form.bucket}/` : ''
  let line = `${form.method} ${bucket}${path} as ${describeWho(form.who)}`
  if (form.method === 'create') {
    const bytes = toBytes(form.size, form.unit)
    const parts = [bytes === undefined ? undefined : formatBytes(bytes), form.contentType.trim()]
    const shown = parts.filter(Boolean).join(' ')
    if (shown) line += ` · ${shown}`
  }
  return line
}
