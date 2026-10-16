// Storage kept current by the console's one live channel: the three
// `storage.*` topics, declared here (`TopicMap`), and what each event
// refreshes. Nothing polls and nothing opens a stream of its own.
//
// `storage.objects` names the objects a window of writes touched — names,
// kinds, folders, never metadata — and resumes by replay (the storage
// revision is global across buckets, so a resumed tab gets exactly what it
// missed). What it refreshes:
//
// - the lists on screen, which the page owns: a listing by name patches the
//   touched rows through `:batchGet` (`touchedRows` → `useCursorRows`'
//   `applyKeys`); a sorted or filtered view is never refetched under the
//   app's writes, it counts them (`touchedCount`) and offers Refresh; a
//   `truncated` window resets the lists under the folders it names
//   (`resetsList`);
// - everything else, through a keyed throttle with a leading and a trailing
//   edge (250 ms per key): the buckets' figures, the folders a name sits in,
//   the object itself, its activity and its event payloads, the profiles, the
//   access checks (`invalidationKeys`);
// - a `reset` (the cursor left the ring, or another engine run) starts every
//   query of the bucket again.
//
// `storage.rules` says when what governs a bucket changed and how its file
// fares (compare: the hash in force; `file` on every open). `storage.decisions`
// is the rules decisions feed, every parameter evaluated by the engine.

import { type QueryKey, useQueryClient } from '@tanstack/react-query'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ResetReason } from '@/api/generated/live/ResetReason'
import type { StorageBuckets } from '@/api/generated/storage/StorageBuckets'
import type { StorageDecisionBatch } from '@/api/generated/storage/StorageDecisionBatch'
import type { StorageDecisionsParams } from '@/api/generated/storage/StorageDecisionsParams'
import type { StorageListKind } from '@/api/generated/storage/StorageListKind'
import type { StorageObjectsChanged } from '@/api/generated/storage/StorageObjectsChanged'
import type { StorageObjectsParams } from '@/api/generated/storage/StorageObjectsParams'
import type { StorageRulesChanged } from '@/api/generated/storage/StorageRulesChanged'
import type { StorageRulesDocument } from '@/api/generated/storage/StorageRulesDocument'
import type { StorageRulesFileStatus } from '@/api/generated/storage/StorageRulesFileStatus'
import type { StorageRulesParams } from '@/api/generated/storage/StorageRulesParams'
import type { SubscriptionStatus } from '@/lib/live/channel'
import { declareTopic } from '@/lib/live/topics'
import { createInvalidator, useLiveTopic } from '@/lib/live/use-live-topic'
import { foldersOf, rowKeyIn } from './paths'
import { scopeBucket, storageKeys } from './queries'

declare module '@/lib/live/topics' {
  interface TopicMap {
    'storage.objects': {
      params: StorageObjectsParams
      events: { changed: StorageObjectsChanged }
    }
    'storage.rules': {
      params: StorageRulesParams
      events: { rules: StorageRulesChanged; file: StorageRulesFileStatus }
    }
    'storage.decisions': {
      params: StorageDecisionsParams
      events: { decisions: StorageDecisionBatch }
    }
  }
}

declareTopic('storage.objects', 'replay')
declareTopic('storage.rules', 'compare')
declareTopic('storage.decisions', 'replay')

/** At most one refresh per key per this many ms, and always one after the last touch. */
export const THROTTLE_MS = 250
/** Coverage moves with every decision; it is read again at most once a second. */
export const COVERAGE_THROTTLE_MS = 1_000

/** A list on screen: a folder's level, or everything under it (`flat`). */
export interface ListScope {
  prefix: string
  flat: boolean
  kind?: StorageListKind | undefined
}

/**
 * The rows of `list` a window touched: in a level, the object itself or the
 * subfolder holding it (only the kind the list shows); in a flat list, the
 * object. Each once, in the order they were named.
 */
export function touchedRows(batch: StorageObjectsChanged, list: ListScope): string[] {
  const kind = list.kind ?? 'all'
  const rows = new Set<string>()
  for (const touch of batch.changes) {
    if (list.flat) {
      // A marker is never a row of a flat list.
      if (touch.name.startsWith(list.prefix) && !touch.name.endsWith('/') && kind !== 'folders')
        rows.add(touch.name)
      continue
    }
    const row = rowKeyIn(list.prefix, touch.name)
    if (row === undefined) continue
    const folder = row.endsWith('/')
    if ((folder && kind === 'files') || (!folder && kind === 'folders')) continue
    rows.add(row)
  }
  return [...rows]
}

/** How many of a window's touched names are inside the list's scope: a view's stale count grows by this. */
export function touchedCount(batch: StorageObjectsChanged, list: ListScope): number {
  return batch.changes.filter(
    (touch) => touch.name.startsWith(list.prefix) && touch.name !== list.prefix,
  ).length
}

/**
 * Whether a window too big to list (`truncated`) starts `list` again: when
 * one of the folders it names is the list's folder, above it or below it
 * (`''` is the whole bucket).
 */
export function resetsList(batch: StorageObjectsChanged, list: ListScope): boolean {
  if (!batch.truncated) return false
  return batch.folders.some(
    (folder) => list.prefix.startsWith(folder) || folder.startsWith(list.prefix),
  )
}

/** The query keys a window refreshes besides the lists (through the keyed throttle). */
export function invalidationKeys(
  project: string,
  bucket: string,
  batch: StorageObjectsChanged,
): QueryKey[] {
  const keys: QueryKey[] = []
  const touched = batch.truncated || batch.changes.length > 0
  if (touched || batch.indexReady) keys.push(storageKeys.buckets(project))
  if (batch.truncated) {
    keys.push(
      storageKeys.foldersOf(project, bucket),
      storageKeys.treeOf(project, bucket),
      storageKeys.profilesOf(project, bucket),
      storageKeys.accessOf(project, bucket),
      [...storageKeys.bucket(project, bucket), 'object'],
      [...storageKeys.bucket(project, bucket), 'activity'],
      [...storageKeys.bucket(project, bucket), 'events'],
    )
  } else if (batch.changes.length > 0) {
    const folders = new Set<string>()
    for (const touch of batch.changes) {
      for (const folder of foldersOf(touch.name)) folders.add(folder)
      keys.push(
        storageKeys.objectAnyone(project, bucket, touch.name),
        storageKeys.activity(project, bucket, touch.name),
        storageKeys.eventsOf(project, bucket, touch.name),
      )
    }
    for (const folder of folders)
      keys.push(
        storageKeys.folder(project, bucket, folder),
        storageKeys.tree(project, bucket, folder),
        storageKeys.profile(project, bucket, folder),
      )
    keys.push(storageKeys.accessOf(project, bucket))
  }
  if (batch.indexReady)
    keys.push(
      storageKeys.foldersOf(project, bucket),
      storageKeys.treeOf(project, bucket),
      storageKeys.objectsOf(project, bucket),
    )
  return keys
}

/** Handlers read through a ref, so a page's latest closures are the ones called. */
function useLatest<T>(value: T): { readonly current: T } {
  const latest = useRef(value)
  useLayoutEffect(() => {
    latest.current = value
  })
  return latest
}

/** A keyed throttle over the query client, disposed with the component. */
function useThrottle(ms: number) {
  const queryClient = useQueryClient()
  const [throttle] = useState(() =>
    createInvalidator((key) => void queryClient.invalidateQueries({ queryKey: key }), ms),
  )
  useEffect(() => () => throttle.dispose(), [throttle])
  return throttle
}

/**
 * Holds `storage.objects` for one bucket while mounted (`bucket` undefined:
 * not now) and refreshes everything but the lists itself. The page gives each
 * window to its lists (`onChanged`) and starts them again on `onReset`.
 */
export function useStorageObjectsLive(
  project: string,
  bucket: string | undefined,
  handlers: {
    /** A window of touched names, for the lists on screen. */
    onChanged?: (batch: StorageObjectsChanged) => void
    /** Every query of the bucket was started again; so were the lists. */
    onReset?: (reason: ResetReason, missed: number | null) => void
  } = {},
): SubscriptionStatus {
  const queryClient = useQueryClient()
  const latest = useLatest(handlers)
  const throttle = useThrottle(THROTTLE_MS)
  const status = useLiveTopic('storage.objects', bucket === undefined ? null : { bucket }, {
    onChanged: (batch) => {
      if (bucket === undefined) return
      throttle.push(invalidationKeys(project, bucket, batch))
      latest.current.onChanged?.(batch)
    },
    onReset: (reason, missed) => {
      if (bucket === undefined) return
      throttle.flush([storageKeys.buckets(project)])
      void queryClient.resetQueries({ queryKey: storageKeys.bucket(project, bucket) })
      latest.current.onReset?.(reason, missed)
    },
  })
  // Counts read as "still counting" before the subscription was live may
  // have been filled in since; read the buckets again once, when it is.
  useEffect(() => {
    if (status !== 'live' || bucket === undefined) return
    const buckets = queryClient.getQueryData<StorageBuckets>(storageKeys.buckets(project))
    if (buckets && !buckets.indexReady)
      void queryClient.invalidateQueries({ queryKey: storageKeys.buckets(project) })
  }, [status, project, bucket, queryClient])
  return status
}

/**
 * Holds `storage.rules` for a rules scope while mounted: when what governs
 * it changes — applied elsewhere, the file edited in an editor, a test
 * suite's reload, a reload that dropped every rule — the rules, their
 * history and coverage are read again, and the buckets (a bucket nobody's
 * rules serve says so). The file's status arrives on every subscription and
 * refreshes only when it differs from what the page holds.
 */
export function useStorageRulesLive(
  project: string,
  scope: string | undefined,
): SubscriptionStatus {
  const queryClient = useQueryClient()
  const shown = () =>
    scope === undefined
      ? undefined
      : queryClient.getQueryData<StorageRulesDocument>(storageKeys.rules(project, scope))
  const refresh = (rules: boolean) => {
    if (scope === undefined) return
    if (rules) void queryClient.invalidateQueries({ queryKey: storageKeys.rules(project, scope) })
    void queryClient.invalidateQueries({ queryKey: storageKeys.rulesHistory(project, scope) })
    void queryClient.invalidateQueries({ queryKey: storageKeys.rulesCoverage(project, scope) })
    void queryClient.invalidateQueries({ queryKey: storageKeys.buckets(project) })
  }
  const bucket = scope === undefined ? undefined : scopeBucket(scope)
  return useLiveTopic(
    'storage.rules',
    scope === undefined ? null : bucket === undefined ? {} : { bucket },
    {
      // After the page's own apply, its refetch may already hold this hash.
      onRules: (changed) => refresh(shown()?.hash !== changed.hash),
      onFile: (status) => {
        if (scope === undefined) return
        if (JSON.stringify(shown()?.fileProblems ?? null) !== JSON.stringify(status.problems))
          void queryClient.invalidateQueries({ queryKey: storageKeys.rules(project, scope) })
      },
      onReset: () => refresh(true),
    },
  )
}

/**
 * Holds `storage.decisions` with `params` while mounted (`null`: not now —
 * diagnostics are off, or the panel is not shown). Each batch goes to the
 * caller's feed; coverage is read again at most once a second, and the
 * draft's impact (which re-runs these decisions) is marked stale.
 */
export function useStorageDecisionsLive(
  project: string,
  scope: string | undefined,
  params: StorageDecisionsParams | null,
  handlers: {
    onDecisions: (batch: StorageDecisionBatch) => void
    onReset?: (reason: ResetReason, missed: number | null) => void
  },
): SubscriptionStatus {
  const queryClient = useQueryClient()
  const latest = useLatest(handlers)
  const coverage = useThrottle(COVERAGE_THROTTLE_MS)
  return useLiveTopic('storage.decisions', params, {
    onDecisions: (batch) => {
      latest.current.onDecisions(batch)
      if (scope === undefined || batch.items.length === 0) return
      coverage.push([storageKeys.rulesCoverage(project, scope)])
      void queryClient.invalidateQueries({
        queryKey: storageKeys.rulesImpactOf(project, scope),
        refetchType: 'none',
      })
    },
    onReset: (reason, missed) => latest.current.onReset?.(reason, missed),
  })
}
