// What ⌘K offers while the Eventarc page is open: publish an event, and
// each channel (its events, publishers and subscribers).

import { BroadcastIcon, PaperPlaneTiltIcon } from '@phosphor-icons/react'
import { useEffect } from 'react'
import type { EventarcSnapshot } from '@/api/generated/compute/EventarcSnapshot'
import { type PaletteGroup, matchesQuery, usePaletteProviders } from '@/lib/palette'
import { channelLabel } from './topology'

export interface EventarcPaletteActions {
  publish: () => void
  /** Show one channel (`undefined`: every channel's events). */
  scope: (channel: string | undefined) => void
}

export function eventarcPaletteGroups(
  snapshot: EventarcSnapshot | undefined,
  actions: EventarcPaletteActions,
  query: string,
): PaletteGroup[] {
  const channels = snapshot ? [...snapshot.channels, snapshot.native] : []
  const items = [
    {
      id: 'eventarc.publish-here',
      title: 'Publish an event',
      keywords: 'cloudevent custom send new',
      icon: <PaperPlaneTiltIcon size={16} />,
      run: actions.publish,
    },
    ...channels.map((channel) => {
      const label = channelLabel(channel)
      return {
        id: `eventarc.channel:${channel.name}`,
        title: `Events on ${label.id}`,
        description: label.where || undefined,
        keywords: `${channel.name} publishers subscribers who listens`,
        icon: <BroadcastIcon size={16} />,
        ref: { kind: 'eventarc.channel', key: channel.name },
        run: () => actions.scope(channel.name),
      }
    }),
  ].filter((item) => matchesQuery(item, query))
  return items.length > 0 ? [{ label: 'Eventarc', items }] : []
}

/** Offers the Eventarc actions in ⌘K while a page of the section is mounted. */
export function useEventarcPalette(
  snapshot: EventarcSnapshot | undefined,
  actions: EventarcPaletteActions,
): void {
  const register = usePaletteProviders((state) => state.register)
  const unregister = usePaletteProviders((state) => state.unregister)
  useEffect(() => {
    register('eventarc', (query) => eventarcPaletteGroups(snapshot, actions, query))
    return () => unregister('eventarc')
  }, [snapshot, actions, register, unregister])
}
