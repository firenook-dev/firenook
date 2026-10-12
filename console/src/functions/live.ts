// The Functions section kept current by the console's one live channel
// (compute spec §6): three topics, declared here, and what each event does
// to the cached data.
//
// - `functions.events` — one 100 ms window per event (`batch`): invocation
//   rows (a start and its finish in one window arrive as one row), codebase
//   and inventory changes, the absolute stats of every function an
//   invocation in the window touched, and how many rows a burst left out.
//   Stats replace (applying a batch twice changes nothing), a codebase
//   replaces its entry, a completed load invalidates what it can change and
//   raises the reload toast, and the rows go to the page's feed.
// - `functions.invocation` — one running invocation: a `snapshot` on every
//   open, then its log lines and response chunks as they come, then
//   `finished`, after which the topic ends.
// - `functions.codebase-log` — the lines a codebase's worker printed outside
//   any invocation, after the cursor its `GET …/log` returned.
//
// Nothing polls. A page subscribes `after` the cursor its snapshot carries
// (`useLiveTopic`'s `after`), so the topic picks up exactly where the
// snapshot ends.

import { type QueryClient, type QueryKey, useQuery, useQueryClient } from '@tanstack/react-query'
import type { FunctionLogLine } from '@/api/generated/compute/FunctionLogLine'
import type { FunctionResponseChunk } from '@/api/generated/compute/FunctionResponseChunk'
import type { FunctionsLiveBatch } from '@/api/generated/compute/FunctionsLiveBatch'
import type { FunctionsLiveChange } from '@/api/generated/compute/FunctionsLiveChange'
import type { FunctionsSnapshot } from '@/api/generated/compute/FunctionsSnapshot'
import type { InvocationSummary } from '@/api/generated/compute/InvocationSummary'
import type { InvocationView } from '@/api/generated/compute/InvocationView'
import type { ResetReason } from '@/api/generated/live/ResetReason'
import { statusQuery } from '@/api/queries'
import { formatNumber } from '@/lib/format'
import { type LiveStatusState, type SubscriptionStatus, useLiveStatus } from '@/lib/live/channel'
import { declareTopic } from '@/lib/live/topics'
import { useLiveTopic } from '@/lib/live/use-live-topic'
import { toast } from '@/lib/toasts'
import { functionKeys } from './api'

/** `functions.events`' parameters: one function's, one codebase's, or every invocation, filtered by `q`. */
export interface FunctionsEventsParams {
  /** A function id: its invocations and stats, and its codebase's changes. */
  function?: string
  /** A codebase or extension instance id. */
  codebase?: string
  /** The invocation filter, in the shared grammar; invocation rows only. */
  q?: string
  /** Inventory and codebase changes only: no rows, no stats. */
  changesOnly?: boolean
}

/** `functions.codebase-log`'s window of lines. */
export interface FunctionLogLines {
  items: FunctionLogLine[]
}

declare module '@/lib/live/topics' {
  interface TopicMap {
    'functions.events': { params: FunctionsEventsParams; events: { batch: FunctionsLiveBatch } }
    'functions.invocation': {
      params: { id: string }
      events: {
        snapshot: InvocationView
        log: FunctionLogLine[]
        chunk: FunctionResponseChunk[]
        finished: InvocationSummary
      }
    }
    'functions.codebase-log': { params: { codebase: string }; events: { lines: FunctionLogLines } }
  }
}

// Feeds, each subscriber at its own place: never shared between tabs. The
// invocation topic is not a feed but sends its snapshot to each subscriber
// on open, which a shared subscription would not give a second one.
declareTopic('functions.events', 'replay')
declareTopic('functions.invocation', 'replay')
declareTopic('functions.codebase-log', 'replay')

type InventoryChange = Extract<FunctionsLiveChange, { kind: 'inventory' }>

// ── What a batch does to the snapshot ─────────────────────────────────────

/**
 * The snapshot after a window: each changed codebase replaced whole (a new
 * one appended), each touched function's stats replaced by the absolute
 * figures the engine sent. The same object when nothing in it changed, so
 * a window of other functions' rows re-renders nothing.
 */
export function applyBatch(
  snapshot: FunctionsSnapshot,
  batch: Pick<FunctionsLiveBatch, 'changes' | 'stats'>,
): FunctionsSnapshot {
  let codebases = snapshot.codebases
  for (const change of batch.changes) {
    if (change.kind !== 'codebase') continue
    const entry = change.codebase
    const at = codebases.findIndex((known) => known.codebase.id === entry.codebase.id)
    codebases = at === -1 ? [...codebases, entry] : codebases.with(at, entry)
  }
  let functions = snapshot.functions
  if (batch.stats.length > 0) {
    const stats = new Map(batch.stats.map((entry) => [entry.functionId, entry.stats]))
    let changed = false
    const next = functions.map((summary) => {
      const figures = stats.get(summary.id)
      if (!figures) return summary
      changed = true
      return { ...summary, stats: figures }
    })
    if (changed) functions = next
  }
  if (codebases === snapshot.codebases && functions === snapshot.functions) return snapshot
  return { ...snapshot, codebases, functions }
}

/**
 * What a completed load of `change.codebase` makes stale: the snapshot (its
 * definitions), the detail of every function of that codebase — a reload
 * that changed only `.env` or `.secret.local` changes their environment
 * with identical definitions — and the ones it added or removed, every
 * match explanation and trigger answer, Eventarc's channels, and for an
 * extension codebase its instance in Extensions.
 */
export function inventoryKeys(
  project: string,
  snapshot: FunctionsSnapshot | undefined,
  change: InventoryChange,
): QueryKey[] {
  const keys: QueryKey[] = [
    functionKeys.snapshot(project),
    functionKeys.match(project),
    functionKeys.triggers(project),
    ['eventarc', project, 'channels'],
  ]
  const ids = new Set<string>([
    ...change.diff.added,
    ...change.diff.removed,
    ...change.diff.changed,
  ])
  for (const summary of snapshot?.functions ?? [])
    if (summary.codebase === change.codebase) ids.add(summary.id)
  for (const id of ids) keys.push(functionKeys.detail(project, id))
  const entry = snapshot?.codebases.find((known) => known.codebase.id === change.codebase)
  if (entry?.codebase.kind === 'extension') {
    keys.push(['extensions', project, 'instances'])
    keys.push(['extensions', project, 'instance', change.codebase])
  }
  return keys
}

/** `onOrder`, `us-central1-onOrder` → the name the developer exported. */
export function functionName(id: string): string {
  return id.replace(/^[a-z]+-[a-z]+\d+-/, '')
}

function named(ids: readonly string[]): string {
  const names = ids.map(functionName)
  if (names.length <= 3) return names.join(', ')
  return `${names.slice(0, 3).join(', ')} and ${formatNumber(names.length - 3)} more`
}

/**
 * The toast a completed load raises, every time, so a save is seen to take
 * effect: "app reloaded" and what changed by name, or that nothing did.
 */
export function reloadToast(change: InventoryChange): {
  key: string
  title: string
  description: string
} {
  const parts: string[] = []
  const { added, removed, changed } = change.diff
  if (added.length > 0) parts.push(`${formatNumber(added.length)} added (${named(added)})`)
  if (changed.length > 0) parts.push(`${formatNumber(changed.length)} changed (${named(changed)})`)
  if (removed.length > 0) parts.push(`${formatNumber(removed.length)} removed (${named(removed)})`)
  return {
    key: `functions.reload.${change.codebase}`,
    title: `${change.codebase} reloaded`,
    description: parts.length === 0 ? 'No function changes.' : `${parts.join(', ')}.`,
  }
}

/**
 * How long after the channel comes back an inventory change still counts
 * as news it missed rather than news: a reconnect replays what happened
 * while it was away, and a toast for a save made minutes ago says nothing.
 */
export const REPLAY_WINDOW_MS = 1_500

/** Whether a change arriving now is the channel catching up rather than happening. */
export function isCatchingUp(
  live: Pick<LiveStatusState, 'status' | 'since'>,
  now: number = Date.now(),
): boolean {
  return live.status !== 'live' || now - live.since < REPLAY_WINDOW_MS
}

/** Applies one batch's cache effects; answers the inventory changes it carried. */
export function applyBatchEffects(
  client: QueryClient,
  project: string,
  batch: FunctionsLiveBatch,
  options: { toasts: boolean; live: Pick<LiveStatusState, 'status' | 'since'> },
): InventoryChange[] {
  const key = functionKeys.snapshot(project)
  const before = client.getQueryData<FunctionsSnapshot>(key)
  if (before && (batch.changes.length > 0 || batch.stats.length > 0)) {
    const after = applyBatch(before, batch)
    if (after !== before) client.setQueryData(key, after)
  }
  const inventory = batch.changes.filter(
    (change): change is InventoryChange => change.kind === 'inventory',
  )
  if (inventory.length === 0) return inventory
  const stale = new Map<string, QueryKey>()
  for (const change of inventory)
    for (const query of inventoryKeys(project, before, change))
      stale.set(JSON.stringify(query), query)
  for (const query of stale.values()) void client.invalidateQueries({ queryKey: query })
  if (options.toasts) {
    const replayed = isCatchingUp(options.live)
    for (const change of inventory) toast({ ...reloadToast(change), tone: 'info', replayed })
  }
  return inventory
}

// ── Hooks ─────────────────────────────────────────────────────────────────

/**
 * Holds the page's `functions.events` subscription (`params: null` = not
 * now; pass the snapshot's or first page's `liveCursor` as `after`). The
 * cache effects happen here; the page gets the rows for its feed, the
 * burst count for its marker row, and every inventory change.
 */
export function useFunctionsEvents(
  params: FunctionsEventsParams | null,
  options: {
    after?: string | undefined
    /** Invocation rows, newest last: `upsert` into the page's `FeedStore`. */
    onItems?: (items: readonly InvocationSummary[]) => void
    /** How many more rows matched the window than were sent: the "N more · Show" marker. */
    onBurst?: (count: number) => void
    onInventory?: (change: InventoryChange) => void
    /** After the section's queries were invalidated: reload what the page shows (its first page). */
    onReset?: (reason: ResetReason, missed: number | null) => void
    /** Raise the reload toast for each completed load (default true). */
    toasts?: boolean
  } = {},
): SubscriptionStatus {
  const client = useQueryClient()
  const project = useQuery(statusQuery).data?.projectId ?? ''
  return useLiveTopic(
    'functions.events',
    params,
    {
      onBatch: (batch) => {
        const inventory = applyBatchEffects(client, project, batch, {
          toasts: options.toasts ?? true,
          live: useLiveStatus.getState(),
        })
        for (const change of inventory) options.onInventory?.(change)
        if (batch.items.length > 0) options.onItems?.(batch.items)
        if (batch.burst !== null && batch.burst > 0) options.onBurst?.(batch.burst)
      },
      onReset: (reason, missed) => {
        void client.invalidateQueries({ queryKey: functionKeys.all(project) })
        options.onReset?.(reason, missed)
      },
    },
    undefined,
    { after: options.after },
  )
}

/** The invocation view after more of its lines arrived: appended in order, each line once. */
export function withLines(view: InvocationView, lines: readonly FunctionLogLine[]): InvocationView {
  const known = new Set(view.detail.logs.map((line) => line.index))
  const fresh = lines.filter((line) => !known.has(line.index))
  if (fresh.length === 0) return view
  return { ...view, detail: { ...view.detail, logs: [...view.detail.logs, ...fresh] } }
}

/**
 * Follows one running invocation (`id: null` = not now). Its cached view
 * takes the `snapshot` and every new line as they come; `finished` puts the
 * final summary in and reads the whole record once more (the response and
 * the timings as they ended). The page gets every event too, chunks
 * included, for a body it shows while it streams.
 */
export function useInvocationLive(
  id: string | null,
  handlers: {
    onSnapshot?: (view: InvocationView) => void
    onLog?: (lines: readonly FunctionLogLine[]) => void
    onChunk?: (chunks: readonly FunctionResponseChunk[]) => void
    onFinished?: (summary: InvocationSummary) => void
  } = {},
): SubscriptionStatus {
  const client = useQueryClient()
  const project = useQuery(statusQuery).data?.projectId ?? ''
  return useLiveTopic('functions.invocation', id === null ? null : { id }, {
    onSnapshot: (view) => {
      if (id !== null) client.setQueryData(functionKeys.invocation(project, id), view)
      handlers.onSnapshot?.(view)
    },
    onLog: (lines) => {
      if (id !== null)
        client.setQueryData<InvocationView>(functionKeys.invocation(project, id), (view) =>
          view ? withLines(view, lines) : view,
        )
      handlers.onLog?.(lines)
    },
    onChunk: (chunks) => handlers.onChunk?.(chunks),
    onFinished: (summary) => {
      if (id !== null) {
        const key = functionKeys.invocation(project, id)
        client.setQueryData<InvocationView>(key, (view) =>
          view ? { ...view, detail: { ...view.detail, summary } } : view,
        )
        void client.invalidateQueries({ queryKey: key })
      }
      handlers.onFinished?.(summary)
    },
  })
}

/**
 * Follows a codebase's load log after the cursor its `GET` returned
 * (`codebase: null` = not now). On a reset the log is read again.
 */
export function useCodebaseLog(
  codebase: string | null,
  options: {
    after?: string | undefined
    onLines?: (lines: readonly FunctionLogLine[]) => void
    onReset?: (reason: ResetReason, missed: number | null) => void
  } = {},
): SubscriptionStatus {
  const client = useQueryClient()
  const project = useQuery(statusQuery).data?.projectId ?? ''
  return useLiveTopic(
    'functions.codebase-log',
    codebase === null ? null : { codebase },
    {
      onLines: (window) => {
        if (window.items.length > 0) options.onLines?.(window.items)
      },
      onReset: (reason, missed) => {
        if (codebase !== null)
          void client.invalidateQueries({ queryKey: functionKeys.codebaseLog(project, codebase) })
        options.onReset?.(reason, missed)
      },
    },
    undefined,
    { after: options.after },
  )
}
