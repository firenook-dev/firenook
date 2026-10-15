// What an instance publishes on Eventarc: its channel, the event types it
// declares and which of them it is allowed to publish, a handler to paste
// for the first one, and the events it actually published, live, each with
// what became of it — opened in Eventarc for the delivery trace.

import { Tooltip, cn } from '@cloudflare/kumo'
import { ArrowRightIcon, BroadcastIcon } from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import type { EventarcEventSummary } from '@/api/generated/compute/EventarcEventSummary'
import type { ExtensionEvents } from '@/api/generated/compute/ExtensionEvents'
import { CodeBlock } from '@/components/console/code-block'
import { CopyButton } from '@/components/console/copy-button'
import { FeedList } from '@/components/console/feed-list'
import { StatusDot } from '@/components/kit'
import { EVENT_LIST, EventCells, EventHeader } from '@/compute/event-row'
import { eventPageQuery } from '@/eventarc/api'
import { useEventarcEvents } from '@/eventarc/live'
import { useNow } from '@/lib/clock'
import { useClockFormat } from '@/lib/format'
import { linkTo, useLinkTo } from '@/lib/links'
import { createFeedStore } from '@/lib/live/feed-store'

/** How many of the instance's events the tab keeps: its own newest page. */
const KEPT = 200

/** `test.greeter.v1.greeted` → `onGreeted`: a handler name a person would write. */
export function handlerName(eventType: string): string {
  const last = eventType.split('.').findLast((part) => /^[a-z]/i.test(part) && !/^v\d+$/.test(part))
  const word = (last ?? 'event').replace(/[^a-z0-9]+(.)?/gi, (_, next: string | undefined) =>
    next ? next.toUpperCase() : '',
  )
  return `on${word.charAt(0).toUpperCase()}${word.slice(1)}`
}

/** The channel as a handler names it: the part after the project. */
export function handlerChannel(channel: string): string {
  const match = /^projects\/[^/]+\/(locations\/[^/]+\/channels\/[^/]+)$/.exec(channel)
  return match?.[1] ?? channel
}

/** A handler for the instance's first allowed event type, on its channel. */
export function handlerSnippet(events: ExtensionEvents): string | undefined {
  const type = events.allowed[0] ?? events.declared[0]?.type
  if (!type) return undefined
  const channel = events.channel ? handlerChannel(events.channel) : undefined
  const options = channel
    ? `{\n    eventType: '${type}',\n    channel: '${channel}',\n  }`
    : `'${type}'`
  return `import { onCustomEventPublished } from 'firebase-functions/v2/eventarc'

export const ${handlerName(type)} = onCustomEventPublished(
  ${options},
  (event) => {
    console.log(event.subject, event.data)
  },
)`
}

export function EventsTab({
  project,
  instance,
  events,
}: {
  project: string
  instance: string
  events: ExtensionEvents
}) {
  const snippet = handlerSnippet(events)
  const channelLink = useLinkTo(events.channelRef ?? undefined)
  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-kumo-base"
      data-testid="instance-events"
    >
      <div className="grid max-w-5xl gap-7 px-6 py-5">
        <section className="grid gap-2.5" aria-label="Channel">
          <h2 className="m-0 text-[16px] leading-6 font-semibold text-kumo-default">Channel</h2>
          {events.channel ? (
            <div className="flex min-w-0 items-center gap-2">
              <span
                className="min-w-0 truncate font-mono text-[12px] text-kumo-default"
                data-testid="events-channel"
              >
                {events.channel}
              </span>
              <CopyButton value={events.channel} label="Copy the channel" />
              {channelLink && (
                <Link
                  to={channelLink.to as never}
                  search={channelLink.search as never}
                  className="ml-auto flex shrink-0 items-center gap-1 text-[13px] text-kumo-link underline-offset-2 hover:underline"
                  data-testid="events-open-channel"
                >
                  Open the channel in Eventarc
                  <ArrowRightIcon size={12} />
                </Link>
              )}
            </div>
          ) : (
            <p className="m-0 text-[13px] text-kumo-subtle">
              No channel: set <span className="font-mono text-[0.9em]">EVENTARC_CHANNEL</span> in
              the instance's parameter file to publish its events.
            </p>
          )}
          {events.source && (
            <span className="text-[12px] text-kumo-subtle">
              Published with the source <span className="font-mono">{events.source}</span>.
            </span>
          )}
        </section>
        <section className="grid gap-2.5" aria-label="Event types">
          <h2 className="m-0 text-[16px] leading-6 font-semibold text-kumo-default">Event types</h2>
          {events.declared.length === 0 ? (
            <p className="m-0 text-[13px] text-kumo-subtle">The extension declares no events.</p>
          ) : (
            <ul className="m-0 grid list-none gap-2 p-0">
              {events.declared.map((declared) => (
                <li
                  key={declared.type}
                  className="grid gap-0.5"
                  data-testid="declared-event"
                  data-type={declared.type}
                  data-allowed={declared.allowed ? '' : undefined}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-mono text-[12px] text-kumo-default">
                      {declared.type}
                    </span>
                    {declared.allowed ? (
                      <StatusDot tone="success" label="Allowed" />
                    ) : (
                      <Tooltip
                        content={`Add it to ALLOWED_EVENT_TYPES in the instance's parameter file to publish it.`}
                        render={
                          <span className="text-[12px] text-kumo-subtle">
                            Declared, not allowed
                          </span>
                        }
                      />
                    )}
                  </span>
                  {declared.description && (
                    <span className="text-[13px] text-kumo-subtle">{declared.description}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {events.allowed.some((type) => !events.declared.some((d) => d.type === type)) && (
            <p className="m-0 text-[12px] text-kumo-warning">
              Allowed but not declared:{' '}
              <span className="font-mono">
                {events.allowed
                  .filter((type) => !events.declared.some((d) => d.type === type))
                  .join(', ')}
              </span>
            </p>
          )}
        </section>
        {snippet && (
          <CodeBlock
            label="Listen for it in your functions"
            code={snippet}
            language="js"
            testId="events-snippet"
          />
        )}
        <RecentEvents project={project} instance={instance} />
      </div>
    </div>
  )
}

/** The instance's own events, newest first, live: the engine filters them by publisher. */
function RecentEvents({ project, instance }: { project: string; instance: string }) {
  const q = `publisher:${instance}`
  const page = useQuery(eventPageQuery(project, '', q))
  const [store] = useState(() =>
    createFeedStore<EventarcEventSummary>({ max: KEPT, key: (event) => event.id }),
  )
  // Seeded once per page answer (newest first, so pushed reversed); the
  // topic then upserts from the page's cursor on.
  useEffect(() => {
    if (!page.data) return
    store.clear()
    store.push(page.data.page.items.toReversed())
  }, [page.data, store])
  useEventarcEvents(page.data?.liveCursor ? { q } : null, {
    after: page.data?.liveCursor ?? undefined,
    onItems: (items) => store.upsert(items),
    onReset: () => void page.refetch(),
  })
  const [follow, setFollow] = useState(true)
  const { format } = useClockFormat()
  const now = useNow(format === 'relative' ? 'second' : 'minute')
  const navigate = useNavigate()
  // Opened in Eventarc, where its delivery trace is.
  const open = (event: EventarcEventSummary) => {
    const link = linkTo({ kind: 'eventarc.event', key: event.id })
    if (link) void navigate({ to: link.to as never, search: link.search as never })
  }
  return (
    <section className="grid gap-2.5" aria-label="Published events" data-testid="events-recent">
      <h2 className="m-0 flex items-baseline gap-3 text-[16px] leading-6 font-semibold text-kumo-default">
        Published events
        <span className="text-[13px] font-normal text-kumo-subtle">
          The newest {KEPT} this instance published, as they arrive.
        </span>
      </h2>
      <div
        className={cn(
          EVENT_LIST,
          'h-[320px] flex-none overflow-hidden rounded-lg ring ring-kumo-line',
        )}
      >
        <FeedList
          ariaLabel={`Events published by ${instance}`}
          store={store}
          order="newest-first"
          rowHeight={32}
          rowKey={(event) => event.id}
          renderRow={(event) => <EventCells event={event} clock={format} now={now} />}
          onSelect={open}
          follow={follow}
          onFollowChange={setFollow}
          header={<EventHeader />}
          empty={
            <div
              className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center"
              data-testid="events-recent-empty"
            >
              <BroadcastIcon size={28} className="text-kumo-inactive" />
              <span className="text-[13px] text-kumo-subtle">
                {page.isPending
                  ? 'Reading the events…'
                  : `${instance} has published no events since the engine started.`}
              </span>
            </div>
          }
          testId="events-recent-list"
        />
      </div>
    </section>
  )
}
