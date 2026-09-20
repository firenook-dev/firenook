// Server state for the workbench, keyed by scope so the live channel can
// invalidate exactly what a commit touched. Nothing here polls.

import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query'
import { type WorkbenchQuery, effectiveOrder, printQuery, toStructuredQuery } from './query'
import {
  type FirestoreScope,
  countQuery,
  documentRoot,
  getDocument,
  listCollectionIds,
  listMissingDocuments,
  runQuery,
} from './rest'
import { type FsDocument, type RestValue, encodeValue } from './value'
import { listAuthUsers } from './view-as'

export const FS = 'fs' as const

export function scopeKey(scope: FirestoreScope): string {
  return `${scope.project}/${scope.database}/${scope.authorization ?? 'anonymous'}`
}

export const collectionsQuery = (scope: FirestoreScope, parent: string) =>
  queryOptions({
    queryKey: [FS, scope.database, 'collections', parent, scope.authorization ?? ''],
    queryFn: () => listCollectionIds(scope, parent),
    staleTime: 30_000,
    retry: false,
  })

export const countQueryOptions = (
  scope: FirestoreScope,
  collectionPath: string,
  group: boolean,
  query: WorkbenchQuery,
) => {
  const { parent, collectionId } = splitCollection(collectionPath, group)
  return queryOptions({
    queryKey: [
      FS,
      scope.database,
      'count',
      collectionPath,
      group,
      printQuery({ ...query, limit: 1 }),
      scope.authorization ?? '',
    ],
    queryFn: () => {
      // A count has no limit; the structured query drops it.
      const { limit: _limit, ...structured } = toStructuredQuery(
        collectionId,
        group,
        { ...query, limit: 1 },
        documentRoot(scope),
      )
      return countQuery(scope, parent, structured)
    },
    staleTime: 30_000,
    retry: false,
  })
}

export const documentQuery = (scope: FirestoreScope, path: string) =>
  queryOptions({
    queryKey: [FS, scope.database, 'doc', path, scope.authorization ?? ''],
    queryFn: () => getDocument(scope, path),
    staleTime: 30_000,
    retry: false,
  })

export const missingDocumentsQuery = (scope: FirestoreScope, collectionPath: string) =>
  queryOptions({
    queryKey: [FS, scope.database, 'missing', collectionPath, scope.authorization ?? ''],
    queryFn: () => listMissingDocuments(scope, collectionPath, 300),
    staleTime: 30_000,
    retry: false,
  })

export const authUsersQuery = (project: string) =>
  queryOptions({
    queryKey: ['auth', project, 'users'],
    queryFn: () => listAuthUsers(project),
    staleTime: 60_000,
  })

/** `users/u1/orders` → parent `users/u1`, collection `orders`; group queries run from the root. */
export function splitCollection(collectionPath: string, group: boolean) {
  const slash = collectionPath.lastIndexOf('/')
  const collectionId = slash === -1 ? collectionPath : collectionPath.slice(slash + 1)
  const parent = group || slash === -1 ? '' : collectionPath.slice(0, slash)
  return { parent, collectionId }
}

/** The cursor after `document` for the query's effective order. */
function cursorAfter(document: FsDocument, query: WorkbenchQuery, root: string): RestValue[] {
  return effectiveOrder(query).map((order) => {
    if (order.field === '__name__') return { referenceValue: `${root}/${document.path}` }
    const value = order.field.split('.').reduce<unknown>((current, segment) => {
      if (current && typeof current === 'object' && 'type' in current) {
        const typed = current as { type: string; fields?: Record<string, unknown> }
        return typed.type === 'map' ? typed.fields?.[segment] : undefined
      }
      if (current && typeof current === 'object')
        return (current as Record<string, unknown>)[segment]
      return undefined
    }, document.fields)
    return value ? encodeValue(value as FsDocument['fields'][string], root) : { nullValue: null }
  })
}

export const pageQueryOptions = (
  scope: FirestoreScope,
  collectionPath: string,
  group: boolean,
  query: WorkbenchQuery,
) => {
  const { parent, collectionId } = splitCollection(collectionPath, group)
  const root = documentRoot(scope)
  return infiniteQueryOptions({
    queryKey: [
      FS,
      scope.database,
      'page',
      collectionPath,
      group,
      printQuery(query),
      scope.authorization ?? '',
    ],
    queryFn: ({ pageParam }) =>
      runQuery(scope, parent, toStructuredQuery(collectionId, group, query, root, pageParam)),
    initialPageParam: undefined as RestValue[] | undefined,
    getNextPageParam: (last) => {
      if (last.documents.length < query.limit) return undefined
      const tail = last.documents.at(-1)
      return tail ? cursorAfter(tail, query, root) : undefined
    },
    staleTime: 30_000,
    // Rules decide deterministically; a retry only repeats the denial.
    retry: false,
  })
}
