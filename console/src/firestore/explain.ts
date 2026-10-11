// Why this query is slow, and what production would ask of it.
//
// Two answers in one: how the engine will run the query — taken from the
// same code that runs it, so a plan can never describe a different query —
// and the index a real project would have to declare. The local engine
// answers everything, so a query that works here can still fail in
// production for want of a composite index; this is where that shows up
// before a deploy rather than after one.
//
// The endpoint evaluates no rules, so the key carries no authorization and
// the panel says the count is the engine's own.

import { queryOptions } from '@tanstack/react-query'
import { API_BASE, ApiError } from '@/api/client'
import type { ExplainCandidates } from '@/api/generated/ExplainCandidates'
import type { ExplainIndex } from '@/api/generated/ExplainIndex'
import type { Explanation } from '@/api/generated/Explanation'
import { FS } from './queries'
import {
  DEFAULT_LIMIT,
  type StructuredQuery,
  type WorkbenchQuery,
  toStructuredQuery,
} from './query'

export type { ExplainCandidates, ExplainIndex, Explanation }

export async function explainQuery(
  database: string,
  parent: string,
  structuredQuery: StructuredQuery,
): Promise<Explanation> {
  const response = await fetch(`${API_BASE}/firestore/explain`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ database, parent: parent || undefined, structuredQuery }),
  })
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`
    try {
      const body = (await response.json()) as { error?: { message?: string } }
      if (body.error?.message) message = body.error.message
    } catch {
      // Keep the status line.
    }
    throw new ApiError(response.status, message)
  }
  return (await response.json()) as Explanation
}

/**
 * The query to explain: the one the person wrote, not the one the grid pages
 * with.
 *
 * The grid asks for `DEFAULT_LIMIT` documents at a time because that is its
 * page size; `printQuery` leaves that number out of the query text for the
 * same reason, and the toolbar's count drops it too. Explaining with it would
 * report a floor of one page instead of how many documents match, and would
 * name a strategy our paging chose rather than one their query implies. A
 * limit they wrote themselves is part of the query and stays.
 */
export function queryToExplain(
  collectionId: string,
  group: boolean,
  query: WorkbenchQuery,
  documentRoot: string,
): StructuredQuery {
  const structured = toStructuredQuery(collectionId, group, query, documentRoot)
  if (query.limit !== DEFAULT_LIMIT) return structured
  const { limit: _limit, ...withoutPageSize } = structured
  return withoutPageSize
}

export const explainQueryOptions = (
  database: string,
  parent: string,
  collectionPath: string,
  printed: string,
  structuredQuery: StructuredQuery,
) =>
  queryOptions({
    queryKey: [FS, database, 'explain', collectionPath, printed],
    queryFn: () => explainQuery(database, parent, structuredQuery),
    // Explaining runs the query, so it is never background-refetched; the
    // panel asks again when the query text changes or the person re-runs it.
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  })

/** One line a person can act on, rather than four numbers to interpret. */
export function describeCandidates(candidates: ExplainCandidates, target: string): string {
  switch (candidates.kind) {
    case 'documentNames':
      return candidates.names === 1
        ? 'Reads one document by name'
        : `Reads ${candidates.names} documents by name`
    case 'equalityIndex':
      return `Narrows ${target} by the ${candidates.fields.join(' and ')} index`
    case 'collectionScan':
      return `Reads every document in ${target}`
    case 'collectionGroupScan':
      return candidates.ancestor
        ? `Reads every ${target} document under ${candidates.ancestor}`
        : `Reads every ${target} document in the database`
  }
}

export const STRATEGY_LABELS: Record<Explanation['strategy'], string> = {
  streaming: 'streamed',
  orderedDisk: 'sorted on disk keys',
  buffered: 'sorted in memory',
}

export const STRATEGY_DETAIL: Record<Explanation['strategy'], string> = {
  streaming:
    'Filtered and limited while reading, decoding only the fields a filter or an order looks at.',
  orderedDisk: 'Disk keys are sorted on their order values before any document payload is decoded.',
  buffered: 'The whole result set is materialized and sorted in memory.',
}

/** How the order a query returns in reads as an SDK chain. */
export function describeOrders(orders: Explanation['orders']): string {
  return orders.map((order) => `${order.field} ${order.descending ? 'desc' : 'asc'}`).join(', ')
}

/** Microseconds as a figure a person can compare at a glance. */
export function formatElapsed(micros: number): string {
  if (micros < 1000) return `${micros} µs`
  if (micros < 100_000) return `${(micros / 1000).toFixed(1)} ms`
  return `${Math.round(micros / 1000)} ms`
}

/**
 * Whether the index requirement is something to act on. A declared index is
 * worth confirming quietly; an undeclared one is a deploy away from failing.
 */
export function indexIsMissing(explanation: Explanation): boolean {
  return explanation.index !== null && !explanation.index.declared
}
