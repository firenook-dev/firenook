// A live list of invocations: one function's on its page, every function's
// on Invocations. Seeded from the engine's newest page for the filter, then
// kept current by `functions.events` subscribed `after` the cursor that
// page carried, so nothing between the two is missed or shown twice. Rows
// upsert by id (a running row becomes its finished self in place); a burst
// of more than fifty rows in a window becomes one marker row — "1,840 more
// · Show" — and Show reads the newest page again. Older rows page in as
// the list nears its end.
//
// The page owns the store (its PauseButton counts what arrived while
// paused); this file gives it the hook that fills it and the list that
// draws it.

import { useQuery } from '@tanstack/react-query'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import type { InvocationSummary } from '@/api/generated/compute/InvocationSummary'
import { QueryError, TableSkeleton } from '@/components/console/empty-state'
import { FeedFooter, useItemCount } from '@/components/console/feed-footer'
import { FeedHeader, FeedList } from '@/components/console/feed-list'
import type { RowMenuItem } from '@/components/console/row-menu'
import { formatNumber, useClockFormat } from '@/lib/format'
import { type FeedStore, createFeedStore } from '@/lib/live/feed-store'
import type { SubscriptionStatus } from '@/lib/live/channel'
import { INVOCATIONS_KEPT, getInvocations, invocationPageQuery } from '../api'
import { type FunctionsEventsParams, useFunctionsEvents } from '../live'
import { InvocationRow } from './invocation-row'

/** A row's key in the feed: the invocation id. */
export const invocationKey = (invocation: InvocationSummary) => invocation.id

export interface InvocationFeed {
  store: FeedStore<InvocationSummary>
  /** The newest page's state: loading, failed, or its total. */
  loading: boolean
  error: unknown
  retry: () => void
  total: number | undefined
  hasMore: boolean
  loadMore: () => void
  live: SubscriptionStatus
}

/**
 * Fills a feed for `q` (the invocation grammar, scope term included) and
 * follows it on `functions.events` with `params` (the same filter as the
 * topic's parameters: a function, or `q` alone).
 */
export function useInvocationFeed({
  project,
  q,
  params,
  toasts = false,
}: {
  project: string
  q: string
  params: FunctionsEventsParams
  /** Raise the reload toasts from this subscription (the page has no other). */
  toasts?: boolean
}): InvocationFeed {
  // One store for the list's life: a new filter reseeds it from its own first page.
  const [store] = useState(() =>
    createFeedStore<InvocationSummary>({ max: INVOCATIONS_KEPT, key: invocationKey }),
  )
  const page = useQuery({ ...invocationPageQuery(project, q), enabled: project !== '' })
  const [older, setOlder] = useState<{ for: unknown; cursor: string | null } | null>(null)
  const loadingOlder = useRef(false)

  // Each answer of the newest page reseeds the list: the first, a reset's,
  // a burst's Show. Live rows that arrive later upsert onto it.
  const seeded = page.data
  useEffect(() => {
    if (!seeded) return
    store.clear()
    store.push(seeded.page.items.toReversed())
  }, [seeded, store])

  const cursor =
    older !== null && older.for === seeded ? older.cursor : (seeded?.page.nextCursor ?? null)
  const live = useFunctionsEvents(seeded ? params : null, {
    after: seeded?.liveCursor ?? undefined,
    toasts,
    onItems: (items) => store.upsert(items),
    onBurst: (count) =>
      store.marker({
        kind: 'marker',
        key: `burst-${Date.now()}`,
        text: `${formatNumber(count)} more`,
        action: { label: 'Show', run: () => void page.refetch() },
      }),
    onReset: (_reason, missed) => {
      if (missed !== null && missed > 0) store.gap(missed, INVOCATIONS_KEPT)
    },
  })

  const loadMore = () => {
    if (!seeded || cursor === null || loadingOlder.current) return
    loadingOlder.current = true
    void getInvocations({ q, cursor })
      .then((result) => {
        store.prepend(result.page.items.toReversed())
        setOlder({ for: seeded, cursor: result.page.nextCursor })
      })
      .catch(() => {
        // The next approach to the end asks again.
      })
      .finally(() => {
        loadingOlder.current = false
      })
  }

  return {
    store,
    loading: page.isPending,
    error: page.error,
    retry: () => void page.refetch(),
    total: seeded?.page.total?.count,
    hasMore: cursor !== null,
    loadMore,
    live,
  }
}

/** The skeleton's cells: the list's own columns (time, function, kind, summary, outcome, duration). */
const INVOCATION_SKELETON = [
  { width: 104 },
  { width: 124 },
  { width: 90 },
  { width: 320 },
  { width: 136 },
  { width: 96 },
]

const INVOCATIONS = { one: 'invocation', other: 'invocations' }

export function InvocationList({
  feed,
  variant,
  follow,
  onFollowChange,
  selected,
  onSelect,
  onOpenTarget,
  menu,
  header,
  empty,
  testId,
}: {
  feed: InvocationFeed
  variant: 'function' | 'all'
  follow: boolean
  onFollowChange: (follow: boolean) => void
  selected?: string | undefined
  onSelect?: ((invocation: InvocationSummary) => void) | undefined
  onOpenTarget?: ((invocation: InvocationSummary) => void) | undefined
  menu: (invocation: InvocationSummary) => readonly RowMenuItem[]
  header?: ReactNode
  /** Shown when the engine has none for this filter. */
  empty: ReactNode
  testId: string
}) {
  const { format } = useClockFormat()
  const loaded = useItemCount(feed.store)
  if (feed.error)
    return (
      <div className="min-h-0 flex-1 overflow-auto">
        <QueryError error={feed.error} onRetry={feed.retry} section="functions" />
      </div>
    )
  if (feed.loading)
    // A feed waits the way a table does: its header, then rows of lines
    // once the wait passes 150 ms.
    return (
      <div className="flex min-h-0 flex-1 flex-col" aria-busy data-testid={`${testId}-loading`}>
        {header && <FeedHeader>{header}</FeedHeader>}
        <TableSkeleton columns={INVOCATION_SKELETON} />
      </div>
    )
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <FeedList
        ariaLabel="Invocations"
        store={feed.store}
        order="newest-first"
        rowHeight={32}
        rowKey={invocationKey}
        renderRow={(invocation) => (
          <InvocationRow
            invocation={invocation}
            variant={variant}
            clock={format}
            menu={menu(invocation)}
          />
        )}
        selectedKey={selected}
        onSelect={onSelect}
        onOpenTarget={onOpenTarget}
        follow={follow}
        onFollowChange={onFollowChange}
        hasMore={feed.hasMore}
        loadMore={feed.loadMore}
        header={header}
        empty={empty}
        testId={testId}
      />
      {loaded > 0 && (
        <FeedFooter
          loaded={loaded}
          capacity={INVOCATIONS_KEPT}
          noun={INVOCATIONS}
          testId="invocations-kept"
        />
      )}
    </div>
  )
}

/** The invocation `step` rows from `key` in the store (+1 newer, -1 older), skipping marker and gap rows. */
export function neighbour(
  store: FeedStore<InvocationSummary>,
  key: string,
  step: 1 | -1,
): InvocationSummary | undefined {
  const from = store.indexOf(key)
  if (from === -1) return undefined
  for (let at = from + step; at >= 0 && at < store.size(); at += step) {
    const row = store.at(at)
    if (row?.kind === 'item') return row.item
  }
  return undefined
}

/** The kept invocation with this id, if the store holds it. */
export function kept(
  store: FeedStore<InvocationSummary>,
  key: string | undefined,
): InvocationSummary | undefined {
  if (key === undefined) return undefined
  const row = store.at(store.indexOf(key))
  return row?.kind === 'item' ? row.item : undefined
}
