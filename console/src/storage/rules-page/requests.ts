// A request to try against Storage's rules, as the playground writes it and
// as the engine evaluates it. The form is what a person can type — an
// operation, a bucket, an object name or a folder, who is asking, and for an
// upload or a metadata change the file it proposes (a size with its unit, a
// content type, custom metadata) — and here it becomes the request a real
// client would send, through the engine's own request builder.
//
// Who is asking is an identity from the console's picker: an anonymous
// client, an Auth user or a custom identity. Either of the last two runs as
// a token minted the way the SDK's emulator tokens are (`authorizationFor`
// on a custom identity with the user's uid, email and claims), so a run here,
// a saved test and the exported `@firebase/rules-unit-testing` file all
// decide alike, Auth record or not. A replayed decision keeps the identity,
// the file and the time it was recorded with until the request is changed.

import type { EvaluateAuth } from '@/api/generated/EvaluateAuth'
import type { RulesMethod } from '@/api/generated/RulesMethod'
import type { StorageDecision } from '@/api/generated/storage/StorageDecision'
import type { StorageEvaluateRequest } from '@/api/generated/storage/StorageEvaluateRequest'
import type { StorageProposedObject } from '@/api/generated/storage/StorageProposedObject'
import type { StorageRulesObjectView } from '@/api/generated/storage/StorageRulesObjectView'
import { type KeyValueRow, rowId } from '@/components/console/key-value-editor'
import { formatBytes } from '@/lib/format'
import { type ViewAs, authorizationFor, describeViewAsShort } from '@/lib/identity'

/** The identity a request carries. */
export type Who =
  /** Picked in the console: an anonymous client, an Auth user or a custom identity. */
  | { kind: 'as'; viewAs: ViewAs }
  /** As a recorded request carried it: `request.auth` exactly, or the header it was sent with. */
  | { kind: 'recorded'; auth: EvaluateAuth | null; authorization?: string | null | undefined }

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
  /** From a recorded decision: the files and the time it was decided with. */
  replay?:
    | {
        decisionId: string
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
  who: { kind: 'as', viewAs: { kind: 'anonymous' } },
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

/**
 * A user or a custom identity as the custom identity whose token is minted
 * here: the uid, the email (a password account, verified, as the Auth
 * emulator's accounts are), the claims, and a tenant user's tenant.
 */
function customOf(
  viewAs: Extract<ViewAs, { kind: 'user' | 'custom' }>,
): Extract<ViewAs, { kind: 'custom' }> {
  if (viewAs.kind === 'custom') return viewAs
  const email = viewAs.email
  const claims: Record<string, unknown> = { ...viewAs.claims }
  if (viewAs.tenant)
    claims.firebase = {
      identities: email ? { email: [email] } : {},
      sign_in_provider: email ? 'password' : 'custom',
      tenant: viewAs.tenant,
    }
  return {
    kind: 'custom',
    uid: viewAs.uid,
    claims,
    signInProvider: email ? 'password' : 'custom',
    ...(email ? { email, emailVerified: true } : {}),
  }
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

  const who = form.who
  if (who.kind === 'recorded') {
    if (who.authorization) request.authorization = who.authorization
    else if (who.auth) request.auth = who.auth
  } else if (who.viewAs.kind === 'owner') {
    return {
      error: 'Admin skips the rules. Ask as a user, an anonymous client or a custom identity.',
    }
  } else if (who.viewAs.kind !== 'anonymous') {
    if (!who.viewAs.uid.trim()) return { error: 'Give the identity a uid.' }
    const authorization = authorizationFor(customOf(who.viewAs), project)
    if (authorization) request.authorization = authorization
  }

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

/** A recorded request as the playground's form, so it can be tried again and changed. */
export function formFromRequest(
  request: StorageEvaluateRequest,
  decisionId: string,
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
    replay: {
      decisionId,
      ...(request.resource === undefined ? {} : { resource: request.resource }),
      ...(request.requestResource === undefined
        ? {}
        : { requestResource: request.requestResource }),
      ...(request.time ? { time: request.time } : {}),
    },
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

/** Who a request is from, in a few words. */
export function describeWho(who: Who): string {
  if (who.kind === 'recorded') {
    if (!who.auth) return who.authorization ? 'as recorded' : 'not signed in'
    const email = who.auth.token.email
    return typeof email === 'string' ? email : who.auth.uid
  }
  if (who.viewAs.kind === 'anonymous') return 'not signed in'
  return describeViewAsShort(who.viewAs)
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
