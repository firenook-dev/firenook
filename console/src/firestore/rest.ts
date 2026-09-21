// The Firestore REST protocol over the console's same-origin mount. The
// engine evaluates rules on every call exactly as it does for an app, so the
// authorization the workbench sends decides what it sees: the owner token
// bypasses rules, an unsigned user token views as that user, nothing views
// as an anonymous client.

import { API_BASE, ApiError } from '@/api/client'
import type { StructuredQuery } from './query'
import { type FsDocument, type RestDocument, type RestValue, decodeDocument } from './value'

export interface FirestoreScope {
  project: string
  database: string
  /** The `Authorization` header value, or none for an anonymous client. */
  authorization?: string | undefined
}

export interface QueryPage {
  documents: FsDocument[]
  readTime: string
  /** Query wall time as measured from the browser, ms. */
  elapsedMs: number
}

export interface RulesDenied {
  kind: 'denied'
  message: string
}

export class FirestoreError extends ApiError {
  readonly denied: boolean
  constructor(status: number, message: string) {
    super(status, message)
    this.name = 'FirestoreError'
    this.denied = status === 403
  }
}

export function documentRoot(scope: FirestoreScope): string {
  return `projects/${scope.project}/databases/${scope.database}/documents`
}

export function firestoreBase(scope: FirestoreScope): string {
  return `${API_BASE}/firestore/v1/${documentRoot(scope)}`
}

async function call<T>(scope: FirestoreScope, path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    ...(init.headers as Record<string, string> | undefined),
  }
  if (scope.authorization) headers.authorization = scope.authorization
  if (init.body) headers['content-type'] = 'application/json'
  const response = await fetch(`${firestoreBase(scope)}${path}`, { ...init, headers })
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`
    try {
      const body = (await response.json()) as { error?: { message?: string; status?: string } }
      if (body.error?.message) message = body.error.message
    } catch {
      // Keep the status line.
    }
    throw new FirestoreError(response.status, message)
  }
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

/** Documents matching a query under `parent` (a document path, or empty for the root). */
export async function runQuery(
  scope: FirestoreScope,
  parent: string,
  structuredQuery: StructuredQuery,
): Promise<QueryPage> {
  const started = performance.now()
  const suffix = parent ? `/${parent}` : ''
  const rows = await call<Array<{ document?: RestDocument; readTime?: string }>>(
    scope,
    `${suffix}:runQuery`,
    { method: 'POST', body: JSON.stringify({ structuredQuery }) },
  )
  const documents: FsDocument[] = []
  let readTime = ''
  for (const row of rows) {
    if (row.readTime) readTime = row.readTime
    if (row.document) documents.push(decodeDocument(row.document))
  }
  return { documents, readTime, elapsedMs: performance.now() - started }
}

/** The index-backed count of a query. */
export async function countQuery(
  scope: FirestoreScope,
  parent: string,
  structuredQuery: StructuredQuery,
): Promise<{ count: number; elapsedMs: number }> {
  const started = performance.now()
  const suffix = parent ? `/${parent}` : ''
  const rows = await call<Array<{ result?: { aggregateFields?: Record<string, RestValue> } }>>(
    scope,
    `${suffix}:runAggregationQuery`,
    {
      method: 'POST',
      body: JSON.stringify({
        structuredAggregationQuery: {
          structuredQuery,
          aggregations: [{ alias: 'count', count: {} }],
        },
      }),
    },
  )
  const raw = rows[0]?.result?.aggregateFields?.count?.integerValue
  return { count: Number(raw ?? 0), elapsedMs: performance.now() - started }
}

/** Collection ids directly under a document, or the root collections. */
export async function listCollectionIds(scope: FirestoreScope, parent: string): Promise<string[]> {
  const suffix = parent ? `/${parent}` : ''
  const ids: string[] = []
  let pageToken: string | undefined
  do {
    // Pages chain through the token, so they are sequential by nature.
    // oxlint-disable-next-line no-await-in-loop
    const page = await call<{ collectionIds?: string[]; nextPageToken?: string }>(
      scope,
      `${suffix}:listCollectionIds`,
      { method: 'POST', body: JSON.stringify({ pageSize: 300, pageToken }) },
    )
    ids.push(...(page.collectionIds ?? []))
    pageToken = page.nextPageToken
  } while (pageToken)
  return ids
}

/** One document; `null` when it does not exist. */
export async function getDocument(scope: FirestoreScope, path: string): Promise<FsDocument | null> {
  try {
    return decodeDocument(await call<RestDocument>(scope, `/${path}`))
  } catch (error) {
    if (error instanceof FirestoreError && error.status === 404) return null
    throw error
  }
}

/**
 * Documents in a collection that exist only as ancestors of subcollections.
 * The listing walks the collection in key order, so it is only asked for
 * small collections; a field mask naming no real field keeps the payload to
 * names and times.
 */
export async function listMissingDocuments(
  scope: FirestoreScope,
  collection: string,
  limit: number,
): Promise<FsDocument[]> {
  const missing: FsDocument[] = []
  let pageToken: string | undefined
  do {
    const token = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''
    // oxlint-disable-next-line no-await-in-loop -- pages chain through the token
    const page = await call<{ documents?: RestDocument[]; nextPageToken?: string }>(
      scope,
      `/${collection}?showMissing=true&pageSize=300&mask.fieldPaths=firenookNoSuchField${token}`,
    )
    for (const document of page.documents ?? []) {
      const decoded = decodeDocument(document)
      if (decoded.missing) missing.push(decoded)
    }
    pageToken = page.nextPageToken
  } while (pageToken && missing.length < limit)
  return missing
}

export interface WriteOperation {
  /** Create or replace the document with exactly these fields. */
  set?: { path: string; fields: Record<string, RestValue> }
  /** Create the document; the commit fails when one is already there. */
  create?: { path: string; fields: Record<string, RestValue> }
  /** Update these fields (dotted paths in `mask`), leaving the rest. */
  update?: { path: string; fields: Record<string, RestValue>; mask: string[]; exists?: boolean }
  delete?: string
}

/** One atomic commit; the engine runs triggers and listeners for it. */
export async function commit(
  scope: FirestoreScope,
  operations: WriteOperation[],
): Promise<{ commitTime: string }> {
  const root = documentRoot(scope)
  const writes = operations.map((operation) => {
    if (operation.set)
      return { update: { name: `${root}/${operation.set.path}`, fields: operation.set.fields } }
    if (operation.create)
      return {
        update: { name: `${root}/${operation.create.path}`, fields: operation.create.fields },
        currentDocument: { exists: false },
      }
    if (operation.update)
      return {
        update: { name: `${root}/${operation.update.path}`, fields: operation.update.fields },
        updateMask: { fieldPaths: operation.update.mask },
        ...(operation.update.exists === undefined
          ? {}
          : { currentDocument: { exists: operation.update.exists } }),
      }
    return { delete: `${root}/${operation.delete ?? ''}` }
  })
  const result = await call<{ commitTime?: string }>(scope, ':commit', {
    method: 'POST',
    body: JSON.stringify({ writes }),
  })
  return { commitTime: result.commitTime ?? '' }
}

/** Deletes a document or collection with everything under it, like the CLI's `firestore:delete -r`. */
export async function deleteRecursively(scope: FirestoreScope, path: string): Promise<void> {
  const headers: Record<string, string> = {}
  if (scope.authorization) headers.authorization = scope.authorization
  const response = await fetch(`${API_BASE}/firestore/emulator/v1/${documentRoot(scope)}/${path}`, {
    method: 'DELETE',
    headers,
  })
  if (!response.ok)
    throw new FirestoreError(response.status, `${response.status} ${response.statusText}`)
}

/** Quotes a field path segment for the REST/SDK dotted syntax when needed. */
export function quoteFieldSegment(segment: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(segment) ? segment : `\`${segment.replace(/`/g, '\\`')}\``
}
