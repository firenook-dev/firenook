// The Eventarc panel: every channel in use — the ones functions listen on,
// extensions publish to, or events arrived on — and the native channel,
// each with how many events the engine keeps from it (amber where
// something on it does not line up), under a row for all of them. Picking
// one scopes the page to it.

import { BroadcastIcon, SquaresFourIcon, StarIcon } from '@phosphor-icons/react'
import { useState } from 'react'
import type { EventarcSnapshot } from '@/api/generated/compute/EventarcSnapshot'
import { PanelFilter, PanelHeader } from '@/components/console/panel'
import { PanelTree, type PanelTreeNode } from '@/components/console/panel-tree'
import { SectionPanel } from '@/components/shell/section-panel'
import { channelLabel, channelWarnings } from '../topology'

/** The panel's node for every channel at once. */
export const ALL_CHANNELS = '\u0000all'

/** The snapshot as the panel's nodes: all channels, each channel, the native one last. */
export function channelNodes(snapshot: EventarcSnapshot | undefined): PanelTreeNode[] {
  const channels = snapshot ? [...snapshot.channels, snapshot.native] : []
  const total = channels.reduce((sum, channel) => sum + channel.events, 0)
  return [
    {
      id: ALL_CHANNELS,
      label: 'All channels',
      icon: SquaresFourIcon,
      count: snapshot ? total : undefined,
      title: 'Every event the engine keeps, on every channel',
    },
    ...channels.map((channel): PanelTreeNode => {
      const label = channelLabel(channel)
      const warnings = channelWarnings(channel, channels).length
      const title =
        channel.name === 'google'
          ? "The native channel, where Firebase's own events arrive"
          : channel.name
      // A channel where something does not line up says so on its count;
      // opening it shows what, over its events.
      return {
        id: channel.name,
        label: label.where ? `${label.id} · ${label.where}` : label.id,
        icon: channel.name === 'google' ? StarIcon : BroadcastIcon,
        count: channel.events,
        tone: warnings > 0 ? 'warning' : undefined,
        title:
          warnings > 0
            ? `${title} · ${warnings} ${warnings === 1 ? 'warning' : 'warnings'}`
            : title,
      }
    }),
  ]
}

export function ChannelsPanel({
  snapshot,
  current,
  onOpen,
}: {
  snapshot: EventarcSnapshot | undefined
  /** The channel in scope, or undefined for every channel. */
  current: string | undefined
  onOpen: (channel: string | undefined) => void
}) {
  const [filter, setFilter] = useState('')
  return (
    <SectionPanel label="Channels">
      <div className="flex h-full min-h-0 flex-col" data-testid="channels-panel">
        <PanelHeader
          filter={
            <PanelFilter
              value={filter}
              onChange={setFilter}
              placeholder="Filter channels"
              testId="channels-filter"
            />
          }
        >
          <span className="truncate text-[12px] text-kumo-subtle">Channels</span>
        </PanelHeader>
        <PanelTree
          nodes={channelNodes(snapshot)}
          current={current ?? ALL_CHANNELS}
          expanded={new Set()}
          onToggle={() => undefined}
          onOpen={(node) => onOpen(node.id === ALL_CHANNELS ? undefined : node.id)}
          filter={filter}
          ariaLabel="Channels"
          empty="No channel is named like that."
          testId="channels-tree"
        />
      </div>
    </SectionPanel>
  )
}
