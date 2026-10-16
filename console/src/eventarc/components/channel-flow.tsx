// One channel as who publishes to whom: the extension instances that
// publish on it, with the types each is allowed to publish and the ones it
// declares without being allowed, beside the triggers that listen on it,
// with the type each listens for and its filters. What does not line up —
// a type nobody hears, a listener nobody publishes for, a filter on an
// attribute publishers may not set — is said underneath, one line each, a
// publisher's with a link to its instance's Events tab, where its types
// are set. The events page draws it over the events of the channel in
// scope.

import { Tooltip, cn } from '@cloudflare/kumo'
import { ArrowRightIcon } from '@phosphor-icons/react'
import { Link } from '@tanstack/react-router'
import type { EntityRef } from '@/api/generated/EntityRef'
import type { EventarcChannel } from '@/api/generated/compute/EventarcChannel'
import type { EventarcSubscription } from '@/api/generated/compute/EventarcSubscription'
import { CopyButton } from '@/components/console/copy-button'
import { EntityLink } from '@/components/console/entity-link'
import { StatusDot } from '@/components/kit'
import { formatNumber } from '@/lib/format'
import { useLinkTo } from '@/lib/links'
import { type ChannelWarning, channelLabel, subscriberName } from '../topology'
import { STATUS_WORDS } from '@/compute/function-status'

/** A column's frame: one ring, no stacked cards. */
const COLUMN = 'grid min-w-0 content-start overflow-hidden rounded-lg ring ring-kumo-line'

function filtersText(subscription: EventarcSubscription): string {
  const entries = Object.entries(subscription.filters)
  return entries.length === 0 ? '—' : entries.map(([name, value]) => `${name}=${value}`).join(' ')
}

/** "greeter's events ›": a publisher warning's instance, on its Events tab in Extensions. */
function PublisherEvents({ publisher }: { publisher: EntityRef }) {
  const link = useLinkTo(publisher)
  if (!link) return null
  return (
    <Link
      to={link.to as never}
      search={{ ...link.search, view: 'events' } as never}
      className="flex shrink-0 items-center gap-1 text-kumo-link underline-offset-2 hover:underline"
      data-testid="channel-warning-publisher"
    >
      {publisher.label ?? publisher.key}'s events
      <ArrowRightIcon size={11} />
    </Link>
  )
}

export function ChannelFlow({
  channel,
  warnings,
  heading = true,
}: {
  channel: EventarcChannel
  warnings: readonly ChannelWarning[]
  /** Its own name and count on top; off where the page's toolbar already names it. */
  heading?: boolean
}) {
  const label = channelLabel(channel)
  const native = channel.name === 'google'
  return (
    <section
      className="@container grid gap-3 px-4 py-3.5"
      aria-label={`Channel ${label.id}`}
      data-testid="channel-flow"
      data-channel={channel.name}
    >
      {heading && (
        <header className="flex min-w-0 items-center gap-2 text-[13px]">
          <span className="shrink-0 font-mono font-medium text-kumo-default">{label.id}</span>
          {label.where && <span className="shrink-0 text-kumo-subtle">{label.where}</span>}
          {!native && (
            <>
              <Tooltip
                content={channel.name}
                render={
                  <span className="min-w-0 truncate font-mono text-[12px] text-kumo-subtle">
                    {channel.name}
                  </span>
                }
              />
              <CopyButton value={channel.name} label="Copy the channel" />
            </>
          )}
          <span
            className="ml-auto shrink-0 text-[12px] text-kumo-subtle tabular-nums"
            data-testid="channel-events"
          >
            <span className="font-mono text-kumo-default">{formatNumber(channel.events)}</span>{' '}
            {channel.events === 1 ? 'event' : 'events'}
          </span>
        </header>
      )}
      {/* Side by side with the arrow between them; one above the other in a narrow column. */}
      <div className="grid grid-cols-1 items-start gap-2 @[760px]:grid-cols-[minmax(0,1fr)_20px_minmax(0,1.4fr)]">
        <div className={COLUMN} data-testid="channel-publishers">
          <h3 className="m-0 border-b border-kumo-line bg-kumo-elevated px-3 py-1.5 text-[12px] font-normal text-kumo-subtle">
            Publishers
          </h3>
          {channel.publishers.length === 0 ? (
            <p className="m-0 px-3 py-2 text-[12px] text-kumo-subtle">
              {native
                ? "Firebase's own events arrive here."
                : 'No extension publishes here; your own code or the console can.'}
            </p>
          ) : (
            channel.publishers.map((publisher) => (
              <div
                key={publisher.instanceId}
                className="grid border-b border-kumo-hairline px-3 py-1.5 last:border-b-0"
                data-testid="channel-publisher"
                data-instance={publisher.instanceId}
              >
                <span className="flex h-7 min-w-0 items-center gap-2">
                  <EntityLink
                    entity={{ ...publisher.instance, label: publisher.instanceId }}
                    testId="channel-publisher-link"
                  />
                  <span className="text-[11px] text-kumo-subtle">extension</span>
                </span>
                {publisher.declared.map((declared) => (
                  <span
                    key={declared.type}
                    className="flex min-h-7 min-w-0 flex-wrap items-center gap-x-2 pl-3"
                    data-testid="channel-type"
                    data-type={declared.type}
                    data-allowed={declared.allowed ? '' : undefined}
                  >
                    <span
                      className={cn(
                        'min-w-0 truncate font-mono text-[12px]',
                        declared.allowed ? 'text-kumo-default' : 'text-kumo-subtle',
                      )}
                    >
                      {declared.type}
                    </span>
                    {declared.allowed ? (
                      <StatusDot tone="success" label="allowed" className="text-[11px]" />
                    ) : (
                      <span className="text-[11px] text-kumo-subtle">declared, not allowed</span>
                    )}
                  </span>
                ))}
                {publisher.allowed
                  .filter((type) => !publisher.declared.some((declared) => declared.type === type))
                  .map((type) => (
                    <span
                      key={type}
                      className="flex min-h-7 min-w-0 items-center gap-2 pl-3"
                      data-testid="channel-type"
                      data-type={type}
                      data-allowed=""
                    >
                      <span className="min-w-0 truncate font-mono text-[12px] text-kumo-default">
                        {type}
                      </span>
                      <span className="text-[11px] text-kumo-subtle">allowed, not declared</span>
                    </span>
                  ))}
              </div>
            ))
          )}
        </div>
        <span
          className="hidden h-9 items-center justify-center text-kumo-subtle @[760px]:flex"
          aria-hidden
        >
          <ArrowRightIcon size={14} />
        </span>
        <div className={COLUMN} data-testid="channel-subscribers">
          <h3 className="m-0 border-b border-kumo-line bg-kumo-elevated px-3 py-1.5 text-[12px] font-normal text-kumo-subtle">
            Subscribers
          </h3>
          {channel.subscriptions.length === 0 ? (
            <p className="m-0 px-3 py-2 text-[12px] text-kumo-subtle">
              No function listens on this channel.
            </p>
          ) : (
            channel.subscriptions.map((subscription) => {
              const status = STATUS_WORDS[subscription.status]
              return (
                <div
                  key={subscription.triggerKey}
                  className="grid min-h-7 grid-cols-[minmax(0,0.8fr)_minmax(0,1.1fr)_minmax(0,1.1fr)] items-center gap-x-3 border-b border-kumo-hairline px-3 py-1 last:border-b-0"
                  data-testid="channel-subscriber"
                  data-function={subscription.functionId ?? undefined}
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    {subscription.function ? (
                      <EntityLink
                        entity={{ ...subscription.function, label: subscriberName(subscription) }}
                        testId="channel-subscriber-link"
                      />
                    ) : (
                      <Tooltip
                        content={`Registered through the Eventarc emulator's own route: ${subscription.triggerKey}`}
                        render={
                          <span className="truncate text-[12px] text-kumo-subtle">
                            (registered)
                          </span>
                        }
                      />
                    )}
                    {subscription.status !== 'receiving' && (
                      <StatusDot tone={status.tone} label={status.word} className="text-[11px]" />
                    )}
                  </span>
                  <span className="min-w-0 truncate font-mono text-[12px] text-kumo-default">
                    {subscription.eventType}
                  </span>
                  <span
                    className="min-w-0 font-mono text-[12px] break-all text-kumo-subtle"
                    data-testid="channel-subscriber-filters"
                  >
                    {filtersText(subscription)}
                  </span>
                </div>
              )
            })
          )}
        </div>
      </div>
      {warnings.length > 0 && (
        <ul className="m-0 grid list-none gap-1 p-0" data-testid="channel-warnings">
          {warnings.map((warning) => (
            <li
              key={`${warning.kind}:${warning.subject}`}
              className="flex items-start gap-2 text-[12px] text-kumo-default"
              data-testid="channel-warning"
              data-kind={warning.kind}
            >
              <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-kumo-warning" aria-hidden />
              <span className="min-w-0">{warning.text}</span>
              {warning.publisher && <PublisherEvents publisher={warning.publisher} />}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
