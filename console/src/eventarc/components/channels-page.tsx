// Eventarc's channels page: for every channel in use, who publishes what to
// whom, with what does not line up said under each. Publishers and
// subscribers are configured in different places (an extension's
// parameter file, a function's code), and this is the one view that puts
// them side by side. Kept current by Functions reloads and the events that
// arrive.

import { useQuery } from '@tanstack/react-query'
import { ShareNetworkIcon } from '@phosphor-icons/react'
import { useEffect } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { statusQuery } from '@/api/queries'
import { CodeBlock } from '@/components/console/code-block'
import { EmptyState, QueryError, useDelayedFlag } from '@/components/console/empty-state'
import { SectionPage } from '@/components/console/section-page'
import { ToolbarDivider, ToolbarRow } from '@/components/console/toolbar'
import { LiveNotice } from '@/components/console/live-notice'
import { PanelToggle } from '@/components/shell/section-panel'
import { StatusDot } from '@/components/kit'
import { useFunctionsEvents } from '@/functions/live'
import { liveChannel } from '@/lib/live/channel'
import { useRouteSearch } from '@/lib/search-params'
import { channelsQuery } from '../api'
import { useEventarcEvents } from '../live'
import { useEventarcPalette } from '../palette'
import type { ChannelsSearch } from '../search'
import { channelWarnings } from '../topology'
import { ChannelFlow } from './channel-flow'
import { ChannelsPanel } from './channels-panel'

/** A handler that makes a channel, for the empty page. */
const HANDLER_SNIPPET = `import { onCustomEventPublished } from 'firebase-functions/v2/eventarc'

export const onOrderPaid = onCustomEventPublished(
  'com.example.order.v1.paid',
  (event) => {
    console.log(event.subject, event.data)
  },
)`

/** `functions.events` for inventory changes only: no rows, no figures. */
const INVENTORY = { changesOnly: true } as const

export function ChannelsPage() {
  const { search, update } = useRouteSearch<ChannelsSearch>(
    '/eventarc_/channels',
    '/eventarc/channels',
  )
  const project = useQuery(statusQuery).data?.projectId ?? ''
  const navigate = useNavigate()
  const snapshot = useQuery(channelsQuery(project))
  // Events arriving move the counts; the topic invalidates the snapshot (no rows kept here).
  const live = useEventarcEvents(snapshot.data ? {} : null, { after: snapshot.data?.liveCursor })
  // A reload in Functions can change who listens: its inventory changes refresh the channels.
  useFunctionsEvents(INVENTORY, { toasts: false })
  const waiting = useDelayedFlag(snapshot.isPending)
  const channels = snapshot.data
    ? [
        ...snapshot.data.channels,
        ...(snapshot.data.native.subscriptions.length > 0 || snapshot.data.native.events > 0
          ? [snapshot.data.native]
          : []),
      ]
    : []
  const all = snapshot.data ? [...snapshot.data.channels, snapshot.data.native] : []
  const warnings = channels.map((channel) => channelWarnings(channel, all))
  const warningCount = warnings.reduce((sum, list) => sum + list.length, 0)

  // A picked channel is scrolled to (and lit).
  useEffect(() => {
    if (!search.channel || !snapshot.data) return
    document
      .getElementById(`channel-${search.channel}`)
      ?.scrollIntoView({ block: 'start', behavior: 'auto' })
  }, [search.channel, snapshot.data])

  useEventarcPalette(snapshot.data, {
    publish: () => void navigate({ to: '/eventarc', search: { new: 'event' } as never }),
    scope: (channel) => void navigate({ to: '/eventarc', search: { channel } as never }),
    channelsPage: () => update({ channel: undefined }),
  })

  return (
    <SectionPage
      section="eventarc"
      page="channels"
      title="Eventarc channels"
      testId="eventarc-channels"
    >
      <ChannelsPanel
        snapshot={snapshot.data}
        current={search.channel}
        onOpen={(channel) => update({ channel }, { replace: true })}
      />
      <ToolbarRow testId="channels-toolbar">
        <PanelToggle where="toolbar" />
        <span className="shrink-0 px-1 text-[12px] font-medium text-kumo-default">Channels</span>
        {warningCount > 0 && (
          <span className="flex shrink-0 items-center px-1" data-testid="channels-warning-count">
            <StatusDot
              tone="warning"
              label={`${warningCount} ${warningCount === 1 ? 'warning' : 'warnings'}`}
            />
          </span>
        )}
        {(live === 'ended' || live === 'refused') && (
          <>
            <ToolbarDivider />
            <LiveNotice status={live} what="the channels" onRetry={() => liveChannel.retry()} />
          </>
        )}
      </ToolbarRow>
      <div className="min-h-0 flex-1 overflow-y-auto bg-kumo-base" data-testid="channels-body">
        {snapshot.isError && !snapshot.data ? (
          <QueryError
            error={snapshot.error}
            onRetry={() => void snapshot.refetch()}
            section="eventarc"
          />
        ) : snapshot.data && channels.length === 0 ? (
          <EmptyState
            icon={ShareNetworkIcon}
            title="No channel is in use"
            description="No function listens on one and no extension publishes to one. A function listens with onCustomEventPublished; an extension publishes when its EVENTARC_CHANNEL is set."
            actions={
              <div className="w-[min(560px,100%)] text-left">
                <CodeBlock
                  label="Listen on the default channel"
                  code={HANDLER_SNIPPET}
                  language="js"
                  testId="channels-snippet"
                />
              </div>
            }
            testId="channels-empty"
          />
        ) : snapshot.data ? (
          <div className="grid max-w-6xl gap-2 px-3 py-3">
            {channels.map((channel, index) => (
              <ChannelFlow
                key={channel.name}
                channel={channel}
                warnings={warnings[index] ?? []}
                current={channel.name === search.channel}
              />
            ))}
          </div>
        ) : waiting ? (
          <p className="px-6 py-5 text-[13px] text-kumo-subtle" aria-busy>
            Reading the channels…
          </p>
        ) : null}
      </div>
    </SectionPage>
  )
}
