// The live channel: one server-sent event stream per open workbench carries
// every commit's document paths; the console invalidates exactly the scopes
// they touch and flashes the rows it is showing. No polling anywhere.

import type { QueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { create } from 'zustand'
import { API_BASE } from '@/api/client'
import type { ChangeBatch } from '@/api/generated/ChangeBatch'
import type { ChangeKind } from '@/api/generated/ChangeKind'
import { FS } from './queries'

export type LiveStatus = 'connecting' | 'live' | 'reconnecting' | 'offline'

interface LiveState {
  status: LiveStatus
  /** Commits seen since the stream opened. */
  commits: number
  /** Rows to flash: path → what happened, with when it was seen. */
  flashes: Map<string, { kind: ChangeKind; at: number }>
  setStatus: (status: LiveStatus) => void
  recordBatch: (batch: ChangeBatch) => void
  expireFlashes: (before: number) => void
}

export const useLive = create<LiveState>((set) => ({
  status: 'connecting',
  commits: 0,
  flashes: new Map(),
  setStatus: (status) => set({ status }),
  recordBatch: (batch) =>
    set((state) => {
      const flashes = new Map(state.flashes)
      const at = Date.now()
      for (const change of batch.changes) flashes.set(change.path, { kind: change.kind, at })
      return { commits: state.commits + 1, flashes }
    }),
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

export const FLASH_MS = 1600

function parentCollection(path: string): string {
  return path.slice(0, path.lastIndexOf('/'))
}

/** Every query scope a batch of changes makes stale. */
export function scopesTouched(batch: ChangeBatch): {
  collections: Set<string>
  documents: Set<string>
  parents: Set<string>
  structural: boolean
} {
  const collections = new Set<string>()
  const documents = new Set<string>()
  const parents = new Set<string>()
  let structural = false
  for (const change of batch.changes) {
    const collection = parentCollection(change.path)
    collections.add(collection)
    documents.add(change.path)
    if (change.kind !== 'updated') {
      structural = true
      const parentDocument = parentCollection(collection)
      if (parentDocument) parents.add(parentDocument)
    }
  }
  return { collections, documents, parents, structural }
}

/**
 * Opens the change stream for `database` while the workbench is mounted and
 * invalidates by scope. Page queries for a touched collection refetch; the
 * document query for a touched document refetches; a create or delete also
 * refreshes counts and collection lists.
 */
export function useLiveChanges(queryClient: QueryClient, database: string) {
  useEffect(() => {
    const store = useLive.getState()
    store.setStatus('connecting')
    let pending: ChangeBatch[] = []
    let timer: number | undefined
    const flush = () => {
      timer = undefined
      const batches = pending
      pending = []
      const collections = new Set<string>()
      const documents = new Set<string>()
      const parents = new Set<string>()
      let structural = false
      for (const batch of batches) {
        const touched = scopesTouched(batch)
        for (const item of touched.collections) collections.add(item)
        for (const item of touched.documents) documents.add(item)
        for (const item of touched.parents) parents.add(item)
        structural ||= touched.structural
      }
      const invalidate = (predicate: (key: readonly unknown[]) => boolean) =>
        void queryClient.invalidateQueries({
          predicate: (query) =>
            query.queryKey[0] === FS && query.queryKey[1] === database && predicate(query.queryKey),
        })
      invalidate((key) => {
        const kind = key[2]
        const scope = key[3] as string
        if (kind === 'page' || kind === 'count' || kind === 'missing') {
          const group = key[4] === true
          if (group) {
            const id = scope.split('/').at(-1)
            return [...collections].some((collection) => collection.split('/').at(-1) === id)
          }
          return collections.has(scope)
        }
        if (kind === 'doc') return documents.has(scope)
        if (kind === 'collections') return structural && (scope === '' || parents.has(scope))
        return false
      })
    }
    const source = new EventSource(
      `${API_BASE}/firestore/changes?database=${encodeURIComponent(database)}`,
    )
    source.addEventListener('hello', () => useLive.getState().setStatus('live'))
    source.addEventListener('change', (event) => {
      const batch = JSON.parse((event as MessageEvent<string>).data) as ChangeBatch
      useLive.getState().recordBatch(batch)
      pending.push(batch)
      timer ??= window.setTimeout(flush, 120)
    })
    source.addEventListener('reset', () => {
      void queryClient.invalidateQueries({ queryKey: [FS, database] })
    })
    source.addEventListener('error', () => {
      useLive
        .getState()
        .setStatus(source.readyState === EventSource.CLOSED ? 'offline' : 'reconnecting')
    })
    source.addEventListener('open', () => useLive.getState().setStatus('live'))
    const expiry = window.setInterval(
      () => useLive.getState().expireFlashes(Date.now() - FLASH_MS),
      400,
    )
    return () => {
      source.close()
      window.clearInterval(expiry)
      if (timer) window.clearTimeout(timer)
      useLive.getState().setStatus('offline')
    }
  }, [queryClient, database])
}
