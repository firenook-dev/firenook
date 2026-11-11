// The indexes production would refuse the app's queries for.
//
// The emulator answers a query whose composite index the project has not
// declared, as the official emulator does, so a query that works here can
// fail after a deploy. The engine keeps every such index with the first query
// that needed it (its fields and operators, never its values), how many
// queries needed it, and whether the index file in force declares it now;
// saving the file puts it in force at once. This module reads that list,
// keeps it current on the `firestore.indexes` topic (invalidation only: the
// engine says the list moved, at once for a new or fixed index and at most
// every two seconds for counts alone), and builds what the page copies.

import { queryOptions, useQuery } from '@tanstack/react-query'
import { apiGet } from '@/api/client'
import type { IndexesChanged } from '@/api/generated/firestore/IndexesChanged'
import type { MissingIndexItem } from '@/api/generated/firestore/MissingIndexItem'
import type { MissingIndexList } from '@/api/generated/firestore/MissingIndexList'
import type { MissingIndexQuery } from '@/api/generated/firestore/MissingIndexQuery'
import type { SubscriptionStatus } from '@/lib/live/channel'
import { declareTopic } from '@/lib/live/topics'
import { useInvalidateOn } from '@/lib/live/use-live-topic'
import { FS } from './queries'

export type { MissingIndexItem, MissingIndexList }

declare module '@/lib/live/topics' {
  interface TopicMap {
    'firestore.indexes': {
      params: Record<string, never>
      events: { changed: IndexesChanged }
    }
  }
}

// Invalidation only: every tab of the browser can share one subscription.
declareTopic('firestore.indexes', 'none')

/** The list's key: one per engine, whatever database the page shows. */
export const missingIndexesKey = [FS, 'indexes', 'missing'] as const

export const missingIndexesQuery = queryOptions({
  queryKey: missingIndexesKey,
  queryFn: ({ signal }) =>
    apiGet<MissingIndexList>('/firestore/indexes/missing', undefined, signal),
  // Kept current by the topic; nothing to refetch on focus.
  staleTime: Number.POSITIVE_INFINITY,
})

const NO_PARAMS: Record<string, never> = {}

/** The list, kept current while mounted. */
export function useMissingIndexes(): {
  list: MissingIndexList | undefined
  error: Error | null
  live: SubscriptionStatus
} {
  const query = useQuery(missingIndexesQuery)
  const live = useInvalidateOn('firestore.indexes', NO_PARAMS, {
    keys: () => [missingIndexesKey],
    resetKeys: [missingIndexesKey],
  })
  return { list: query.data, error: query.error, live }
}

/** The indexes still missing: those no file in force declares. */
export function stillMissing(list: MissingIndexList | undefined): MissingIndexItem[] {
  return list?.indexes.filter((item) => !item.declared) ?? []
}

/**
 * The query that needed an index, in the console's own query syntax with its
 * values left out, which the engine never keeps: `where("status", "==", …)
 * .orderBy("total", "desc")`. A query with `or` anywhere names its fields in
 * one `or(…)`, since which of them were joined how is not kept either.
 */
export function describeQuery(query: MissingIndexQuery): string {
  const filters = query.filters.map((filter) => `where("${filter.field}", "${filter.op}", …)`)
  const where = query.disjunction ? [`or(${filters.join(', ')})`] : filters
  const orders = query.orders.map((order) =>
    order.descending ? `orderBy("${order.field}", "desc")` : `orderBy("${order.field}")`,
  )
  return [...where, ...orders].join('.')
}

/** Where the query ran: its collection path, or every collection with that id. */
export function describeTarget(query: MissingIndexQuery): string {
  if (!query.collectionGroup) return query.target
  return query.target === '' ? 'every collection' : `every "${query.target}" collection`
}

/** The entry to paste, as `firestore.indexes.json` writes it. */
export function formatEntry(item: MissingIndexItem): string {
  return JSON.stringify(item.entry, null, 2)
}

/**
 * Every index still missing in `database`, as an index file: the entries
 * under `indexes` and `fieldOverrides`, to merge into the file the database
 * reads.
 */
export function missingFile(items: readonly MissingIndexItem[], database: string): string {
  const missing = items.filter((item) => item.database === database && !item.declared)
  const file = {
    indexes: missing.filter((item) => item.section === 'indexes').map((item) => item.entry),
    fieldOverrides: missing
      .filter((item) => item.section === 'fieldOverrides')
      .map((item) => item.entry),
  }
  return JSON.stringify(file, null, 2)
}
