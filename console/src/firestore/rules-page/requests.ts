// A request to try against the rules, as the playground writes it and as
// the engine evaluates it. The playground's form is plain text — a path, a
// little JSON, a query in the SDK chain the data page's query line uses —
// and here it becomes the request a real client would send: a token minted
// the way the SDK mints one against the emulator, data typed the way the
// grid types it, a query structured the way the grid structures it.
//
// Who is asking is the rules kit's `Who` (`src/rules/who.ts`), the same as
// Storage's: an identity from the console's picker, run as a token minted
// for it, or a recorded request's own credentials.

import { type WorkbenchQuery, parseQuery, toStructuredQuery } from '../query'
import { INFER, encodeFields, fromJson } from '../value'
import type { EvaluateRequest } from '@/api/generated/EvaluateRequest'
import type { FirestoreDecision } from '@/api/generated/FirestoreDecision'
import type { FirestoreRestValue } from '@/api/generated/FirestoreRestValue'
import type { RulesMethod } from '@/api/generated/RulesMethod'
import { ANONYMOUS, type Who, credentialsOf, describeWho } from '@/rules/who'
import { recordedAuth } from './decisions'

export type { Who }

export interface PlaygroundForm {
  method: RulesMethod
  path: string
  group: boolean
  who: Who
  /** JSON text: the new document for create, the fields to merge for update. */
  data: string
  /** A query in the SDK chain, `where("owner", "==", "u1").limit(10)`, for list. */
  query: string
  /** From a recorded decision: the document as it was then, and when. */
  replay?: {
    requestId: string
    resource?: Record<string, FirestoreRestValue> | null
    time?: string
  }
}

export const EMPTY_FORM: PlaygroundForm = {
  method: 'get',
  path: '',
  group: false,
  who: ANONYMOUS,
  data: '{}',
  query: '',
}

/**
 * The form after `patch`: a change to what the request is about leaves a
 * replayed decision's recorded context behind, since it described that
 * request, not this one.
 */
export function patchForm(form: PlaygroundForm, patch: Partial<PlaygroundForm>): PlaygroundForm {
  const next = { ...form, ...patch }
  if (form.replay && ('path' in patch || 'method' in patch || 'group' in patch)) delete next.replay
  return next
}

export function normalize(path: string): string {
  return path
    .trim()
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .filter(Boolean)
    .join('/')
}

/** What is wrong with a path for an operation, in a sentence; undefined when it is fine. */
export function pathProblem(method: RulesMethod, path: string, group: boolean): string | undefined {
  const segments = normalize(path).split('/').filter(Boolean)
  if (segments.length === 0)
    return method === 'list' ? 'Name the collection to list.' : 'Name the document.'
  if (method === 'list') {
    if (group)
      return segments.length === 1
        ? undefined
        : 'A collection group is one collection id, such as orders.'
    return segments.length % 2 === 1
      ? undefined
      : 'A list reads a collection: users or users/u1/orders.'
  }
  return segments.length % 2 === 0
    ? undefined
    : 'A document path has an even number of segments: users/u1.'
}

/** The playground's form as the request the engine evaluates. */
export function toEvaluateRequest(
  form: PlaygroundForm,
  project: string,
  database: string,
): { request: EvaluateRequest } | { error: string } {
  const problem = pathProblem(form.method, form.path, form.group)
  if (problem) return { error: problem }
  const path = normalize(form.path)
  const request: EvaluateRequest = { method: form.method, path }
  if (form.method === 'list' && form.group) request.group = true

  const credentials = credentialsOf(form.who, project)
  if ('error' in credentials) return credentials
  if (credentials.authorization) request.authorization = credentials.authorization
  else request.auth = credentials.auth ?? null

  if (form.method === 'create' || form.method === 'update') {
    let parsed: unknown
    try {
      parsed = form.data.trim() ? JSON.parse(form.data) : {}
    } catch (error) {
      return { error: `The data is not JSON: ${(error as Error).message}` }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return { error: 'The data is a JSON object of fields, such as {"name": "Ada"}.' }
    const value = fromJson(parsed, INFER)
    if (value.type !== 'map') return { error: 'The data is a JSON object of fields.' }
    request.data = encodeFields(value.fields, documentRoot(project, database)) as Record<
      string,
      FirestoreRestValue
    >
  }

  if (form.method === 'list' && form.query.trim()) {
    let parsed: WorkbenchQuery
    try {
      parsed = parseQuery(form.query)
    } catch (error) {
      return { error: (error as Error).message }
    }
    const collectionId = path.slice(path.lastIndexOf('/') + 1)
    const structured = toStructuredQuery(
      collectionId,
      form.group,
      parsed,
      documentRoot(project, database),
    )
    request.query = {
      ...(structured.where === undefined ? {} : { where: structured.where }),
      ...(parsed.orderBy.length > 0 ? { orderBy: structured.orderBy } : {}),
      ...(form.query.includes('limit(') ? { limit: parsed.limit } : {}),
    }
  }

  if (form.replay) {
    if (form.replay.resource !== undefined) request.resource = form.replay.resource
    if (form.replay.time) request.time = form.replay.time
  }
  return { request }
}

export function documentRoot(project: string, database: string): string {
  return `projects/${project}/databases/${database}/documents`
}

/** A recorded request as the playground's form, so it can be tried again and changed. */
export function formFromRequest(request: EvaluateRequest, requestId: string): PlaygroundForm {
  return {
    method: request.method,
    path: request.path,
    group: request.group ?? false,
    who: {
      kind: 'recorded',
      auth: request.auth ?? null,
      ...(request.authorization ? { authorization: request.authorization } : {}),
    },
    data: request.data ? JSON.stringify(plainFields(request.data), null, 2) : '{}',
    query: '',
    replay: {
      requestId,
      ...(request.resource === undefined ? {} : { resource: request.resource }),
      ...(request.time ? { time: request.time } : {}),
    },
  }
}

/** REST typed fields as the plain JSON a person writes. */
function plainFields(fields: Record<string, FirestoreRestValue>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(fields)) out[key] = plain(value)
  return out
}

function plain(value: FirestoreRestValue): unknown {
  if ('nullValue' in value) return null
  if ('booleanValue' in value) return value.booleanValue
  if ('integerValue' in value) return Number(value.integerValue)
  if ('doubleValue' in value) return value.doubleValue
  if ('stringValue' in value) return value.stringValue
  if ('timestampValue' in value) return value.timestampValue
  if ('referenceValue' in value) return value.referenceValue
  if ('mapValue' in value)
    return plainFields(
      (value.mapValue as { fields?: Record<string, FirestoreRestValue> }).fields ?? {},
    )
  if ('arrayValue' in value)
    return ((value.arrayValue as { values?: FirestoreRestValue[] }).values ?? []).map(plain)
  return value
}

/** A request in a line: `get users/u1 as ada@example.test`. */
export function describeForm(form: PlaygroundForm): string {
  return `${form.method} ${normalize(form.path) || '…'}${form.group ? ' (group)' : ''} as ${describeWho(form.who)}`
}

/**
 * A decision the engine no longer keeps the request of, as a form from its
 * summary: the operation, the path (a collection group's id), and who asked.
 * The document is read from the store as it is now.
 */
export function formFromDecision(decision: FirestoreDecision): PlaygroundForm {
  const groupAt = decision.path.lastIndexOf('**/')
  const group = decision.method === 'list' && groupAt >= 0
  return {
    ...EMPTY_FORM,
    method: decision.method,
    path: group ? decision.path.slice(groupAt + 3) : decision.path,
    group,
    who: { kind: 'recorded', auth: recordedAuth(decision) },
  }
}
