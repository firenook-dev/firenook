// Which subcollections a document has, and how many documents each holds.
//
// The grid asks this per rendered row and the inspector asks it for the open
// document. Asked one path at a time it is `listCollectionIds` plus a count
// per chip, so a screen of rows costs dozens of requests and scrolling a
// large collection costs thousands. The engine answers a whole batch of
// parents from its schema index instead, and the loader here collects every
// path asked for in the same tick into one of those requests.
//
// Queries stay keyed by path, so the cache and the live channel still
// invalidate per document; only the traffic is shared. The engine reads its
// own index and evaluates no rules, exactly as `/schema` does, so the answer
// does not depend on who the workbench is viewing as and the key leaves the
// authorization out.

import { queryOptions } from '@tanstack/react-query'
import { API_BASE, ApiError } from '@/api/client'
import type { Subcollection } from '@/api/generated/Subcollection'
import type { SubcollectionsSnapshot } from '@/api/generated/SubcollectionsSnapshot'
import { FS } from './queries'

export type { Subcollection }

/**
 * Paths per request. The engine refuses more than 500, and a batch that
 * reaches this goes early rather than waiting for a tick that may never
 * come — the grid never renders this many rows at once.
 */
const BATCH_LIMIT = 200

interface Waiter {
  path: string
  resolve: (collections: Subcollection[]) => void
  reject: (error: unknown) => void
}

interface Batch {
  waiters: Waiter[]
  timer: ReturnType<typeof setTimeout>
}

/** The batch forming for each database, at most one at a time. */
const forming = new Map<string, Batch>()

/**
 * The subcollections of one parent: a document path, or the empty string for
 * the database root. Every call in the same tick travels in one request.
 */
export function loadSubcollections(database: string, path: string): Promise<Subcollection[]> {
  return new Promise((resolve, reject) => {
    let batch = forming.get(database)
    if (!batch) {
      // A macrotask, not a microtask: one React commit mounts every row's
      // query, and the virtualizer may render twice before the browser
      // yields. Both land in the same batch.
      batch = { waiters: [], timer: setTimeout(() => void flush(database), 0) }
      forming.set(database, batch)
    }
    batch.waiters.push({ path, resolve, reject })
    if (batch.waiters.length >= BATCH_LIMIT) void flush(database)
  })
}

async function flush(database: string): Promise<void> {
  const batch = forming.get(database)
  if (!batch) return
  forming.delete(database)
  clearTimeout(batch.timer)
  // Several rows can wait on one path; the engine is asked once.
  const paths = [...new Set(batch.waiters.map((waiter) => waiter.path))]
  try {
    const answers = await fetchSubcollections(database, paths)
    for (const waiter of batch.waiters) {
      const collections = answers.get(waiter.path)
      if (collections) waiter.resolve(collections)
      // Every requested path is echoed, so a gap is a protocol mismatch,
      // not an empty document: saying so beats showing no subcollections.
      else waiter.reject(new ApiError(502, `the engine did not answer for ${waiter.path}`))
    }
  } catch (error) {
    for (const waiter of batch.waiters) waiter.reject(error)
  }
}

async function fetchSubcollections(
  database: string,
  paths: string[],
): Promise<Map<string, Subcollection[]>> {
  const response = await fetch(`${API_BASE}/firestore/subcollections`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ database, paths }),
  })
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`
    try {
      const body = (await response.json()) as { error?: { message?: string } }
      if (body.error?.message) message = body.error.message
    } catch {
      // A non-JSON error body keeps the status line as the message.
    }
    throw new ApiError(response.status, message)
  }
  const snapshot = (await response.json()) as SubcollectionsSnapshot
  return new Map(snapshot.parents.map((parent) => [parent.path, parent.collections]))
}

/**
 * The subcollections of one document, batched with every other path the
 * same tick asks for. `path` is a document path, or the empty string for
 * the database's root collections.
 */
export const subcollectionsQuery = (database: string, path: string) =>
  queryOptions({
    queryKey: [FS, database, 'subcollections', path],
    queryFn: () => loadSubcollections(database, path),
    staleTime: 60_000,
    retry: false,
  })
