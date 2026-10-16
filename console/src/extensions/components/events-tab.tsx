// What an instance publishes on Eventarc: its channel, the event types it
// declares and which of them it is allowed to publish, a handler to paste
// for the first one, and how many events it published, opened in Eventarc
// (filtered to it), where each one's delivery trace is. What does not line
// up on the channel is said once, in Eventarc.

import { Tooltip } from '@cloudflare/kumo'
import { ArrowRightIcon } from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { EntityRef } from '@/api/generated/EntityRef'
import type { Total } from '@/api/generated/Total'
import type { ExtensionEvents } from '@/api/generated/compute/ExtensionEvents'
import { CodeBlock } from '@/components/console/code-block'
import { CopyButton } from '@/components/console/copy-button'
import { StatusDot } from '@/components/kit'
import { eventarcKeys, getEvents } from '@/eventarc/api'
import { formatCount } from '@/lib/format'
import { useLinkTo } from '@/lib/links'

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
  const undeclared = events.allowed.filter(
    (type) => !events.declared.some((declared) => declared.type === type),
  )
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
          {undeclared.length > 0 && (
            <ul className="m-0 grid list-none gap-2 p-0">
              {undeclared.map((type) => (
                <li
                  key={type}
                  className="flex min-w-0 items-center gap-2"
                  data-testid="declared-event"
                  data-type={type}
                  data-allowed=""
                >
                  <span className="truncate font-mono text-[12px] text-kumo-default">{type}</span>
                  <span className="text-[12px] text-kumo-subtle">Allowed, not declared</span>
                </li>
              ))}
            </ul>
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
        <PublishedEvents project={project} instance={instance} channel={events.channelRef} />
      </div>
    </div>
  )
}

/** How many events an instance published, as the tab says it. */
export function publishedText(
  instance: string,
  count: { isPending: boolean; isError: boolean; data?: Total | null | undefined },
): string {
  if (count.isPending) return 'Counting…'
  if (count.isError) return 'Eventarc could not be read.'
  const total = count.data
  if (!total) return 'Its events are in Eventarc.'
  if (total.count === 0) return `${instance} has published no events since the engine started.`
  const counted = formatCount(total.count, { one: 'event', other: 'events' })
  return `${counted}${total.exact ? '' : ' or more'} since the engine started.`
}

/**
 * How many events the instance published, and a link to them in Eventarc,
 * filtered to it (`publisher:<id>`), where each has its delivery trace.
 * Read when the tab opens; Eventarc follows them live.
 */
function PublishedEvents({
  project,
  instance,
  channel,
}: {
  project: string
  instance: string
  channel: EntityRef | null
}) {
  const q = `publisher:${instance}`
  const count = useQuery({
    queryKey: [...eventarcKeys.events(project), 'count', q],
    queryFn: ({ signal }) => getEvents({ q, limit: 1 }, signal),
    enabled: project !== '',
    select: (result) => result.page.total,
  })
  const channelLink = useLinkTo(channel ?? undefined)
  return (
    <section className="grid gap-2.5" aria-label="Published events" data-testid="events-published">
      <h2 className="m-0 text-[16px] leading-6 font-semibold text-kumo-default">
        Published events
      </h2>
      <p className="m-0 flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 text-[13px] text-kumo-subtle">
        <span data-testid="events-published-count">{publishedText(instance, count)}</span>
        {channelLink && (
          <Link
            to={channelLink.to as never}
            search={{ ...channelLink.search, q } as never}
            className="flex shrink-0 items-center gap-1 text-kumo-link underline-offset-2 hover:underline"
            data-testid="events-open-published"
          >
            Open them in Eventarc
            <ArrowRightIcon size={12} />
          </Link>
        )}
      </p>
    </section>
  )
}
