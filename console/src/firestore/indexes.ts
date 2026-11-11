// The Firestore indexes: what each database's index file declares, and the
// indexes production would refuse the app's queries for.
//
// The emulator answers a query whose composite index the project has not
// declared, as the official emulator does, so a query that works here can
// fail after a deploy. The engine keeps every such index with the first query
// that needed it (its fields and operators, never its values), how many
// queries needed it, and whether the index file in force declares it now.
// The Indexes page adds an entry to `firestore.indexes.json` or takes one out
// (`POST /firestore/indexes/edit`), and a file saved in an editor is in force
// at once too. This module reads both lists, keeps them current on the
// `firestore.indexes` topic (invalidation only: the engine says a list moved,
// at once for a new or fixed index or a saved file and at most every two
// seconds for counts alone), and builds what the page copies.

import { queryOptions, useQuery } from '@tanstack/react-query'
import { apiGet, apiSend } from '@/api/client'
import type { DatabaseIndexes } from '@/api/generated/firestore/DatabaseIndexes'
import type { DeclaredFieldOverride } from '@/api/generated/firestore/DeclaredFieldOverride'
import type { DeclaredIndex } from '@/api/generated/firestore/DeclaredIndex'
import type { DeclaredIndexList } from '@/api/generated/firestore/DeclaredIndexList'
import type { IndexFileEntry } from '@/api/generated/firestore/IndexFileEntry'
import type { IndexesChanged } from '@/api/generated/firestore/IndexesChanged'
import type { IndexesEditBody } from '@/api/generated/firestore/IndexesEditBody'
import type { IndexesEdited } from '@/api/generated/firestore/IndexesEdited'
import type { MissingIndexItem } from '@/api/generated/firestore/MissingIndexItem'
import type { MissingIndexList } from '@/api/generated/firestore/MissingIndexList'
import type { MissingIndexQuery } from '@/api/generated/firestore/MissingIndexQuery'
import type { OverrideIndex } from '@/api/generated/firestore/OverrideIndex'
import type { SubscriptionStatus } from '@/lib/live/channel'
import { declareTopic } from '@/lib/live/topics'
import { useInvalidateOn } from '@/lib/live/use-live-topic'
import { FS } from './queries'

export type {
  DatabaseIndexes,
  DeclaredFieldOverride,
  DeclaredIndex,
  DeclaredIndexList,
  IndexFileEntry,
  IndexesEdited,
  MissingIndexItem,
  MissingIndexList,
  OverrideIndex,
}

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

/** What each database's file in force declares: one key per engine. */
export const declaredIndexesKey = [FS, 'indexes', 'declared'] as const

export const declaredIndexesQuery = queryOptions({
  queryKey: declaredIndexesKey,
  queryFn: ({ signal }) => apiGet<DeclaredIndexList>('/firestore/indexes', undefined, signal),
  staleTime: Number.POSITIVE_INFINITY,
})

/** Both lists, kept current while mounted, on one subscription. */
export function useIndexes(): {
  declared: DeclaredIndexList | undefined
  missing: MissingIndexList | undefined
  error: Error | null
  live: SubscriptionStatus
} {
  const declared = useQuery(declaredIndexesQuery)
  const missing = useQuery(missingIndexesQuery)
  const live = useInvalidateOn('firestore.indexes', NO_PARAMS, {
    keys: () => [declaredIndexesKey, missingIndexesKey],
    resetKeys: [declaredIndexesKey, missingIndexesKey],
  })
  return {
    declared: declared.data,
    missing: missing.data,
    error: declared.error ?? missing.error,
    live,
  }
}

/**
 * Adds entries to a database's index file and takes entries out of it; the
 * engine writes the file and puts it in force. Refused when the file changed
 * since `revision` was read, so it never overwrites an edit made in an editor.
 */
export function editIndexes(body: IndexesEditBody): Promise<IndexesEdited> {
  return apiSend<IndexesEdited>('POST', '/firestore/indexes/edit', body)
}

/** `database`'s file, when `firebase.json` names one. */
export function databaseFile(
  list: DeclaredIndexList | undefined,
  database: string,
): DatabaseIndexes | undefined {
  return list?.databases.find((file) => file.database === database)
}

/** The indexes still missing: those no file in force declares. */
export function stillMissing(list: MissingIndexList | undefined): MissingIndexItem[] {
  return list?.indexes.filter((item) => !item.declared) ?? []
}

/** What the app's queries needed in `database`, the ones still missing first. */
export function neededIn(list: MissingIndexList | undefined, database: string): MissingIndexItem[] {
  return list?.indexes.filter((item) => item.database === database) ?? []
}

/** A missing index's entry, as the edit names it. */
export function entryOf(item: Pick<MissingIndexItem, 'section' | 'entry'>): IndexFileEntry {
  return { section: item.section, entry: item.entry }
}

/** A row's key: the entry, which the engine writes with its keys in one order. */
export function entryKey(entry: Record<string, unknown>): string {
  return JSON.stringify(entry)
}

/** An index's fields as one line: `status ↑, total ↓`. */
export function describeFields(
  fields: readonly { fieldPath: string; mode: string; dimension: number | null }[],
): string {
  return fields.map((field) => `${field.fieldPath} ${modeWord(field)}`).join(', ')
}

/** A field's mode in a word or an arrow, as the query plan marks it. */
export function modeWord(field: { mode: string; dimension: number | null }): string {
  switch (field.mode) {
    case 'ascending':
      return '↑'
    case 'descending':
      return '↓'
    case 'arrayContains':
      return 'array-contains'
    default:
      return `vector ${field.dimension ?? ''}`.trim()
  }
}

/**
 * A field override's indexes as one line: `↑ ↓ array-contains` in a
 * collection, then `collection group ↑` for those of collection group
 * queries; none at all is a field left out of every index.
 */
export function describeOverride(override: Pick<DeclaredFieldOverride, 'indexes'>): string {
  if (override.indexes.length === 0) return 'Not indexed'
  const words = (scope: string) =>
    override.indexes
      .filter((index) => index.scope === scope)
      .map(modeWord)
      .join(' ')
  const collection = words('collection')
  const group = words('collectionGroup')
  return [collection, group ? `collection group ${group}` : ''].filter(Boolean).join(', ')
}

/**
 * The query that needed an index, in the console's own query syntax with its
 * values left out, which the engine never keeps: `where("status", "==", …)
 * .orderBy("total", "desc")`. A query with `or` anywhere names its fields in
 * one `or(…)`, since which of them were joined how is not kept either.
 */
export function describeQuery(query: MissingIndexQuery): string {
  return queryClauses(query).join('.')
}

/** The query's clauses in order, `where(…)` then `orderBy(…)`: a line breaks between them, never inside one. */
export function queryClauses(query: MissingIndexQuery): string[] {
  const filters = query.filters.map((filter) => `where("${filter.field}", "${filter.op}", …)`)
  const where = query.disjunction ? [`or(${filters.join(', ')})`] : filters
  const orders = query.orders.map((order) =>
    order.descending ? `orderBy("${order.field}", "desc")` : `orderBy("${order.field}")`,
  )
  return [...where, ...orders]
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
