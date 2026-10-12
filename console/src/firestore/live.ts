// The workbench kept current by the live channel's `firestore.changes`
// topic. Every commit's document paths arrive (never the documents), and the
// console refreshes exactly what they touched:
//
// - an updated document on a loaded page is patched where it is, through
//   Firestore's own `documents:batchGet` read as the page's identity — one
//   request for every touched row, not a refetch of every page; a document
//   the identity may no longer read, or one whose filtered or ordered fields
//   moved, refetches its window instead;
// - a created or deleted document refetches the bounded window (at most 20
//   pages, `pageQueryOptions`), the counts, and the trees that list
//   collections;
// - a commit too large to list (`truncated`) refetches every page of the
//   collections it names;
// - `reset` (the subscriber missed changes) reloads the database's queries.
//
// Rows that changed flash. No polling anywhere: across a dropped connection
// or a hidden tab the topic replays the commits that were missed, so only
// the queries they touch refetch.

import type { InfiniteData, QueryClient, QueryKey } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { create } from 'zustand'
import type { ChangeBatch } from '@/api/generated/ChangeBatch'
import type { ChangeKind } from '@/api/generated/ChangeKind'
import type { SubscriptionStatus } from '@/lib/live/channel'
import { useLiveTopic } from '@/lib/live/use-live-topic'
import { EMPTY_QUERY, type WorkbenchQuery, parseQuery } from './query'
import { FS } from './queries'
import { identityOfKey } from '@/lib/identity'
import {
  type FirestoreScope,
  type QueryPage,
  batchGetDocuments,
  keySlot,
  withIdentity,
} from './rest'
import type { FsDocument, FsValue } from './value'

interface LiveState {
  /** Rows to flash: path → what happened, with when it was seen. */
  flashes: Map<string, { kind: ChangeKind; at: number }>
  recordBatch: (batch: ChangeBatch) => void
  expireFlashes: (before: number) => void
}

export const FLASH_MS = 1600

let expiry: ReturnType<typeof setTimeout> | undefined

/** One timer while anything flashes, none otherwise. */
function scheduleExpiry() {
  if (expiry !== undefined) return
  expiry = setTimeout(() => {
    expiry = undefined
    useLive.getState().expireFlashes(Date.now() - FLASH_MS)
    if (useLive.getState().flashes.size > 0) scheduleExpiry()
  }, FLASH_MS / 4)
}

export const useLive = create<LiveState>((set) => ({
  flashes: new Map(),
  recordBatch: (batch) => {
    if (batch.changes.length === 0) return
    set((state) => {
      const flashes = new Map(state.flashes)
      const at = Date.now()
      for (const change of batch.changes) flashes.set(change.path, { kind: change.kind, at })
      return { flashes }
    })
    scheduleExpiry()
  },
  expireFlashes: (before) =>
    set((state) => {
      let changed = false
      const flashes = new Map(state.flashes)
      for (const [path, flash] of flashes) {
        if (flash.at <= before) {
          flashes.delete(path)
          changed = true
        }
      }
      return changed ? { flashes } : {}
    }),
}))

function parentCollection(path: string): string {
  return path.slice(0, path.lastIndexOf('/'))
}

/** What a window of change batches touched, by how it must be refreshed. */
export interface Touched {
  /** Collections a document was created in, deleted from, or a truncated commit named: their windows refetch. */
  collections: Set<string>
  /** Documents that were updated, and nothing else in this window: patched in place. */
  updated: Set<string>
  /** Collections of the updated documents. */
  updatedCollections: Set<string>
  /** Every document named, whatever happened to it. */
  documents: Set<string>
  /** Documents under which a collection appeared or emptied. */
  parents: Set<string>
  structural: boolean
}

/** Every query scope a window of change batches makes stale. */
export function scopesTouched(batches: readonly ChangeBatch[]): Touched {
  const touched: Touched = {
    collections: new Set(),
    updated: new Set(),
    updatedCollections: new Set(),
    documents: new Set(),
    parents: new Set(),
    structural: false,
  }
  const structuralIn = (collection: string) => {
    touched.collections.add(collection)
    touched.structural = true
    const parentDocument = parentCollection(collection)
    if (parentDocument) touched.parents.add(parentDocument)
  }
  for (const batch of batches) {
    for (const collection of batch.collections ?? []) structuralIn(collection.path)
    for (const change of batch.changes) {
      touched.documents.add(change.path)
      const collection = parentCollection(change.path)
      if (change.kind === 'updated') {
        touched.updated.add(change.path)
        touched.updatedCollections.add(collection)
      } else structuralIn(collection)
    }
  }
  // A document created or deleted in the window is not patched: its window
  // refetches anyway.
  for (const path of touched.updated) {
    if (touched.collections.has(parentCollection(path))) touched.updated.delete(path)
  }
  return touched
}

/** A page query's collection matches a touched one: by path, or by id for a group. */
function matchesCollection(scope: string, group: boolean, collections: Set<string>): boolean {
  if (!group) return collections.has(scope)
  const id = scope.split('/').at(-1)
  for (const collection of collections) if (collection.split('/').at(-1) === id) return true
  return false
}

function isUnder(path: string, collections: Set<string>): boolean {
  return collections.has(parentCollection(path))
}

/**
 * Which queries of the key slot `slot` (a database id, or
 * `<project>|<database>` for another project's view) a window makes stale,
 * other than the pages it can patch: the predicate `invalidateQueries` runs.
 */
export function staleQuery(slot: string, touched: Touched) {
  return (key: QueryKey): boolean => {
    if (key[0] !== FS || key[1] !== slot) return false
    const kind = key[2]
    const scope = key[3] as string
    const group = key[4] === true
    switch (kind) {
      case 'page':
      case 'missing':
        return matchesCollection(scope, group, touched.collections)
      case 'count':
        // An update can move a document in or out of a filtered count;
        // only a create or delete changes an unfiltered one.
        return (
          matchesCollection(scope, group, touched.collections) ||
          (String(key[5]).includes('where(') &&
            matchesCollection(scope, group, touched.updatedCollections))
        )
      case 'doc':
        return touched.documents.has(scope) || isUnder(scope, touched.collections)
      case 'ids':
        return touched.collections.has(scope)
      // A subcollections answer carries counts, so a write inside one of
      // them makes it stale as surely as a new collection does.
      case 'collections':
      case 'subcollections':
        return touched.structural && (scope === '' || touched.parents.has(scope))
      case 'schema':
        return touched.structural
      default:
        return false
    }
  }
}

/** The value at a dotted field path, or undefined. */
function fieldValue(document: FsDocument, path: string): FsValue | undefined {
  let current: FsValue | undefined
  let fields: Record<string, FsValue> | undefined = document.fields
  for (const segment of path.split('.')) {
    current = fields?.[segment]
    fields = current?.type === 'map' ? current.fields : undefined
  }
  return current
}

/** The fields a query filters or orders by: a change to one can move a row out of place. */
export function queryFields(queryText: string): string[] | undefined {
  let query: WorkbenchQuery = EMPTY_QUERY
  if (queryText) {
    try {
      query = parseQuery(queryText)
    } catch {
      return undefined
    }
  }
  const fields = new Set<string>()
  for (const clause of query.where) fields.add(clause.field)
  for (const order of query.orderBy) if (order.field !== '__name__') fields.add(order.field)
  return [...fields]
}

/**
 * The pages with each fetched document in its place and each missing one
 * removed; `undefined` when a document moved on a field the query filters or
 * orders by, so its place is no longer known and the window must refetch.
 * Pages without a touched row keep their identity.
 */
export function patchPages(
  data: InfiniteData<QueryPage, unknown>,
  touched: ReadonlySet<string>,
  fetched: ReadonlyMap<string, FsDocument>,
  fields: readonly string[],
): InfiniteData<QueryPage, unknown> | undefined {
  let moved = false
  const pages = data.pages.map((page) => {
    if (!page.documents.some((document) => touched.has(document.path))) return page
    return {
      ...page,
      documents: page.documents.flatMap((document) => {
        if (!touched.has(document.path)) return [document]
        const next = fetched.get(document.path)
        if (!next) return []
        for (const field of fields) {
          if (
            JSON.stringify(fieldValue(document, field)) !== JSON.stringify(fieldValue(next, field))
          )
            moved = true
        }
        return [next]
      }),
    }
  })
  return moved ? undefined : { ...data, pages }
}

/** The updated documents a page query of `scope` (a collection, or a group's pattern) can hold. */
function updatedIn(scope: string, group: boolean, updated: ReadonlySet<string>): Set<string> {
  const id = scope.split('/').at(-1)
  const found = new Set<string>()
  for (const path of updated) {
    const collection = parentCollection(path)
    if (group ? collection.split('/').at(-1) === id : collection === scope) found.add(path)
  }
  return found
}

/**
 * Patches the loaded pages that hold an updated document, one `batchGet` per
 * identity. A filtered or ordered query refetches its window instead when an
 * updated document is not on it, since the change may have brought it in.
 */
async function patchUpdated(
  queryClient: QueryClient,
  scope: FirestoreScope,
  touched: Touched,
): Promise<void> {
  if (touched.updated.size === 0) return
  const refetch = (key: QueryKey) =>
    void queryClient.invalidateQueries({ queryKey: key, exact: true })
  const byIdentity = new Map<
    string,
    Array<{ key: QueryKey; paths: Set<string>; fields: readonly string[] }>
  >()
  const queries = queryClient.getQueryCache().findAll({ queryKey: [FS, keySlot(scope), 'page'] })
  for (const query of queries) {
    const data = query.state.data as InfiniteData<QueryPage, unknown> | undefined
    const key = query.queryKey
    const candidates = updatedIn(String(key[3]), key[4] === true, touched.updated)
    if (!data || candidates.size === 0) continue
    const fields = queryFields(String(key[5]))
    const paths = new Set<string>()
    for (const page of data.pages)
      for (const document of page.documents)
        if (candidates.has(document.path)) paths.add(document.path)
    if (fields === undefined || (fields.length > 0 && paths.size < candidates.size)) {
      refetch(key)
      continue
    }
    if (paths.size === 0) continue
    // A page being fetched may land with what it read before this change:
    // refetching it after is the only way to be sure.
    if (query.state.fetchStatus === 'fetching') {
      refetch(key)
      continue
    }
    const identity = String(key[6] ?? '')
    const list = byIdentity.get(identity) ?? []
    list.push({ key, paths, fields })
    byIdentity.set(identity, list)
  }
  await Promise.all(
    [...byIdentity].map(async ([identity, entries]) => {
      const wanted = new Set<string>()
      for (const entry of entries) for (const path of entry.paths) wanted.add(path)
      let fetched: Map<string, FsDocument>
      try {
        // The pages were read as `identity`; so are their patches, or a
        // document the rules hide from it would appear in its grid.
        const documents = await batchGetDocuments(withIdentity(scope, identityOfKey(identity)), [
          ...wanted,
        ])
        fetched = new Map(documents.map((document) => [document.path, document]))
      } catch {
        // Refused as this identity (the rules changed under it) or not
        // answered: what these pages hold can no longer be trusted.
        for (const entry of entries) refetch(entry.key)
        return
      }
      for (const entry of entries) {
        const data = queryClient.getQueryData<InfiniteData<QueryPage, unknown>>(entry.key)
        if (!data) continue
        const patched = patchPages(data, entry.paths, fetched, entry.fields)
        if (patched) queryClient.setQueryData(entry.key, patched)
        else refetch(entry.key)
      }
    }),
  )
}

/** Refreshes what a window of change batches touched. */
export function applyChanges(
  queryClient: QueryClient,
  scope: FirestoreScope,
  batches: readonly ChangeBatch[],
): Promise<void> {
  const touched = scopesTouched(batches)
  void queryClient.invalidateQueries({
    predicate: (query) => staleQuery(keySlot(scope), touched)(query.queryKey),
  })
  return patchUpdated(queryClient, scope, touched)
}

/**
 * Subscribes to `scope.database`'s changes while the workbench is mounted
 * and refreshes by scope, batched per 120 ms. Answers the subscription's
 * status: the channel's, or `ended` / `refused` for this one.
 */
export function useLiveChanges(
  queryClient: QueryClient,
  scope: FirestoreScope,
): SubscriptionStatus {
  const pending = useRef<ChangeBatch[]>([])
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const latest = useRef(scope)
  useEffect(() => {
    latest.current = scope
  })
  useEffect(
    () => () => {
      clearTimeout(timer.current)
      timer.current = undefined
      pending.current = []
    },
    [],
  )
  return useLiveTopic(
    'firestore.changes',
    { database: scope.database },
    {
      onChange: (batch) => {
        useLive.getState().recordBatch(batch)
        pending.current.push(batch)
        timer.current ??= setTimeout(() => {
          timer.current = undefined
          const batches = pending.current
          pending.current = []
          void applyChanges(queryClient, latest.current, batches)
        }, 120)
      },
      onReset: () => {
        void queryClient.invalidateQueries({ queryKey: [FS, keySlot(latest.current)] })
      },
    },
  )
}
