// The live list of events for the page's scope and filter: seeded from the
// engine's newest page, then fed by `eventarc.events` from that page's own
// cursor, so nothing is missed or shown twice. A delivery that finishes
// later replaces its event's row in place. Older events page in at the far
// end; a burst becomes one "N more · Show" row; a reconnect that missed
// events leaves a gap row saying how many.

import { useQuery } from '@tanstack/react-query'
import { PaperPlaneTiltIcon } from '@phosphor-icons/react'
import { Button } from '@cloudflare/kumo'
import { useEffect, useRef, useState } from 'react'
import type { EventarcEventSummary } from '@/api/generated/compute/EventarcEventSummary'
import { CodeBlock } from '@/components/console/code-block'
import { EmptyState, NoMatch, TableSkeleton } from '@/components/console/empty-state'
import { FeedFooter, useItemCount } from '@/components/console/feed-footer'
import { FeedList } from '@/components/console/feed-list'
import { EventCells, EventHeader } from '@/compute/event-row'
import { useNow } from '@/lib/clock'
import { formatNumber, useClockFormat } from '@/lib/format'
import { type FeedStore, createFeedStore, useFeed } from '@/lib/live/feed-store'
import { EVENTS_KEPT, eventPageQuery, getEvents } from '../api'
import { useEventarcEvents } from '../live'

function newStore() {
  return createFeedStore<EventarcEventSummary>({ max: EVENTS_KEPT, key: (event) => event.id })
}

/** The feed for one scope and filter: its store, what the engine counted, how to page older events. */
export function useEventFeed(project: string, channel: string, q: string) {
  const page = useQuery(eventPageQuery(project, channel, q))
  // One store per scope and filter: another channel or filter starts afresh.
  const scope = `${channel}\u0000${q}`
  const [held, setHeld] = useState(() => ({ scope, store: newStore() }))
  let store = held.store
  if (held.scope !== scope) {
    store = newStore()
    setHeld({ scope, store })
  }
  // How far older pages have been read, for the page answer they continue.
  const [older, setOlder] = useState<{ from: unknown; cursor: string | null; loading: boolean }>({
    from: undefined,
    cursor: null,
    loading: false,
  })
  const paging =
    older.from === page.data
      ? older
      : { from: page.data, cursor: page.data?.page.nextCursor ?? null, loading: false }
  // Events the live tail added since that answer, for the count.
  const [added, setAdded] = useState<{ from: unknown; count: number }>({
    from: undefined,
    count: 0,
  })
  const addedNow = added.from === page.data ? added.count : 0
  // What a reset said was missed, until the page it refetched arrives.
  const gap = useRef<{ missed: number | null } | undefined>(undefined)

  // Each answer of the first page goes in: replacing the rows it holds,
  // adding the ones it brings — after a gap row when a reconnect missed some.
  useEffect(() => {
    if (!page.data) return
    if (gap.current) store.gap(gap.current.missed, EVENTS_KEPT)
    gap.current = undefined
    store.upsert(page.data.page.items.toReversed())
  }, [page.data, store])

  const params = {
    ...(channel === '' ? {} : { channel }),
    ...(q === '' ? {} : { q }),
  }
  const live = useEventarcEvents(page.data?.liveCursor ? params : null, {
    after: page.data?.liveCursor ?? undefined,
    onItems: (items) => {
      const fresh = items.filter((item) => store.indexOf(item.id) === -1).length
      store.upsert(items)
      const from = page.data
      if (fresh > 0)
        setAdded((count) => ({ from, count: (count.from === from ? count.count : 0) + fresh }))
    },
    onBurst: (count) => {
      store.marker({
        kind: 'marker',
        key: `burst-${Date.now()}`,
        text: `${formatNumber(count)} more`,
        action: { label: 'Show', run: () => void page.refetch() },
      })
    },
    onReset: (_reason, missed) => {
      gap.current = { missed }
    },
  })

  const loadOlder = () => {
    if (!paging.cursor || paging.loading) return
    const { from, cursor } = paging
    setOlder({ from, cursor, loading: true })
    void getEvents({ channel, q, cursor }).then(
      (result) => {
        store.prepend(result.page.items.toReversed())
        setOlder({ from, cursor: result.page.nextCursor, loading: false })
      },
      () => setOlder({ from, cursor, loading: false }),
    )
  }

  const total = page.data?.page.total
  const counted =
    total === undefined || total === null
      ? undefined
      : {
          count: Math.min(total.count + addedNow, EVENTS_KEPT),
          exact: total.exact && total.count + addedNow <= EVENTS_KEPT,
        }
  return {
    page,
    store,
    live,
    total: counted,
    hasMore: paging.cursor !== null,
    loadOlder,
  }
}

/** The events above and below `key` in a newest-first list, for the inspector's ↑ ↓. */
export function useNeighbours(
  store: FeedStore<EventarcEventSummary>,
  key: string | undefined,
): { newer: string | undefined; older: string | undefined } {
  // It reads the store's rows while rendering, and the store is mutable:
  // the compiler would keep the first answer for as long as it is the same store.
  'use no memo'
  useFeed(store)
  const step = (by: 1 | -1) => {
    if (key === undefined) return undefined
    const at = store.indexOf(key)
    if (at === -1) return undefined
    for (let index = at + by; index >= 0 && index < store.size(); index += by) {
      const row = store.at(index)
      if (row?.kind === 'item') return row.item.id
    }
    return undefined
  }
  return { newer: step(1), older: step(-1) }
}

/** The skeleton's cells: the list's own columns (time, type, published by, subject, deliveries). */
const EVENT_SKELETON = [
  { width: 108 },
  { width: 220 },
  { width: 170 },
  { width: 170 },
  { width: 196 },
]

const EVENTS = { one: 'event', other: 'events' }

/** How an app publishes to a channel (the default one when none is named), for the empty state. */
export function publishSnippet(channel: string | undefined): string {
  const target = channel ? `channel(${JSON.stringify(channel)})` : 'channel()'
  return `import { getEventarc } from 'firebase-admin/eventarc'

await getEventarc().${target}.publish({
  type: 'achieved-leaderboard',
  subject: 'Welcome to the leaderboard',
  data: { message: 'You reached the top ten.' },
})`
}

export function EventList({
  store,
  loading,
  failed,
  q,
  onClearFilter,
  channelName,
  selected,
  onSelect,
  onOpenTarget,
  follow,
  onFollowChange,
  hasMore,
  loadMore,
  onPublish,
}: {
  store: FeedStore<EventarcEventSummary>
  loading: boolean
  /** A failed first page: the page's `QueryError`. */
  failed: React.ReactNode
  q: string
  onClearFilter: () => void
  /** The scope, for the empty state's words. */
  channelName: string | undefined
  selected: string | undefined
  onSelect: (event: EventarcEventSummary) => void
  onOpenTarget: (event: EventarcEventSummary) => void
  follow: boolean
  onFollowChange: (follow: boolean) => void
  hasMore: boolean
  loadMore: () => void
  onPublish: () => void
}) {
  const { format } = useClockFormat()
  const now = useNow(format === 'relative' ? 'second' : 'minute')
  const loaded = useItemCount(store)
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <FeedList
        ariaLabel="Eventarc events"
        store={store}
        order="newest-first"
        rowHeight={32}
        rowKey={(event) => event.id}
        renderRow={(event) => <EventCells event={event} clock={format} now={now} />}
        selectedKey={selected}
        onSelect={onSelect}
        onOpenTarget={onOpenTarget}
        follow={follow}
        onFollowChange={onFollowChange}
        hasMore={hasMore}
        loadMore={loadMore}
        header={<EventHeader />}
        testId="event-list"
        empty={
          failed ??
          (loading ? (
            <TableSkeleton columns={EVENT_SKELETON} />
          ) : q !== '' ? (
            <NoMatch filter={q} onClear={onClearFilter} noun="events" />
          ) : (
            <EmptyState
              icon={PaperPlaneTiltIcon}
              title="No events yet"
              description={
                channelName
                  ? 'Nothing has been published on this channel since the engine started. Publish one from your app or an extension, or here.'
                  : 'Publish one from your app or an extension, or here.'
              }
              actions={
                <div className="grid w-[min(560px,100%)] justify-items-center gap-4">
                  <div className="w-full text-left">
                    <CodeBlock
                      label="From your app"
                      code={publishSnippet(channelName)}
                      language="js"
                      testId="events-snippet"
                    />
                  </div>
                  <Button
                    variant="primary"
                    icon={<PaperPlaneTiltIcon />}
                    onClick={onPublish}
                    data-testid="events-empty-publish"
                  >
                    Publish event
                  </Button>
                </div>
              }
              testId="events-empty"
            />
          ))
        }
      />
      {loaded > 0 && (
        <FeedFooter loaded={loaded} capacity={EVENTS_KEPT} noun={EVENTS} testId="events-footer" />
      )}
    </div>
  )
}
