// Who publishes what to whom, and what is wrong with it: the warnings the
// channels page draws under each channel, and the near misses an unheard
// event suggests ("Did you mean test.greeter.v1.greeted?"). Pure, from the
// engine's channel snapshot, so a test can hold every case.

import type { EventarcChannel } from '@/api/generated/compute/EventarcChannel'

/** Attributes every CloudEvent carries; a filter on anything else needs the publisher to set it. */
export const CORE_ATTRIBUTES: ReadonlySet<string> = new Set([
  'id',
  'source',
  'specversion',
  'type',
  'subject',
  'time',
  'datacontenttype',
  'dataschema',
])

export type ChannelWarningKind =
  | 'not-allowed'
  | 'unheard-type'
  | 'unpublished-type'
  | 'other-location'
  | 'custom-attribute'

export interface ChannelWarning {
  kind: ChannelWarningKind
  /** The sentence, with the data it names; the page sets those in the data face. */
  text: string
  /** What the sentence is about (an event type, a channel id, an attribute), for keys and tests. */
  subject: string
}

/** The function a subscription belongs to, by its short name, or the trigger key when it has none. */
export function subscriberName(subscription: EventarcChannel['subscriptions'][number]): string {
  const id = subscription.functionId
  if (!id) return subscription.triggerKey
  const dash = id.indexOf('-')
  // `us-central1-onGreeted`: the region holds one dash itself.
  const region = /^[a-z]+-[a-z]+\d+-/.exec(id)
  return region ? id.slice(region[0].length) : dash === -1 ? id : id.slice(dash + 1)
}

/** Everything worth saying about one channel, in the order the page lists it. */
export function channelWarnings(
  channel: EventarcChannel,
  all: readonly EventarcChannel[],
): ChannelWarning[] {
  const warnings: ChannelWarning[] = []
  const listened = new Set(channel.subscriptions.map((subscription) => subscription.eventType))
  const published = new Set(channel.publishers.flatMap((publisher) => publisher.allowed))
  for (const publisher of channel.publishers) {
    for (const declared of publisher.declared) {
      if (declared.allowed) continue
      warnings.push({
        kind: 'not-allowed',
        subject: declared.type,
        text: `${declared.type} is declared by ${publisher.instanceId} but not allowed, so it is never published.`,
      })
    }
    for (const type of publisher.allowed) {
      if (listened.has(type)) continue
      warnings.push({
        kind: 'unheard-type',
        subject: type,
        text: `${publisher.instanceId} publishes ${type} here, but no function listens for it.`,
      })
    }
  }
  for (const type of listened) {
    if (published.has(type)) continue
    warnings.push({
      kind: 'unpublished-type',
      subject: type,
      text: `${type} is listened for here, but no extension on this channel publishes it; only your own code or the console can.`,
    })
  }
  if (channel.location !== null) {
    const elsewhere = all.filter(
      (other) => other.name !== channel.name && other.id === channel.id && other.location !== null,
    )
    for (const other of elsewhere)
      warnings.push({
        kind: 'other-location',
        subject: other.name,
        text: `A channel named ${channel.id} is also in ${other.location}; publishers and handlers meet only in the same location.`,
      })
  }
  for (const subscription of channel.subscriptions) {
    for (const attribute of Object.keys(subscription.filters)) {
      if (CORE_ATTRIBUTES.has(attribute)) continue
      warnings.push({
        kind: 'custom-attribute',
        subject: `${subscription.triggerKey}:${attribute}`,
        text: `${subscriberName(subscription)} filters on ${attribute}, an attribute only some publishers set; events without it never reach it.`,
      })
    }
  }
  return warnings
}

/** Edit distance between two strings (insert, delete, substitute), stopping once past `limit`. */
export function editDistance(a: string, b: string, limit = Number.POSITIVE_INFINITY): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i]
    let smallest = i
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      const value = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      )
      current.push(value)
      if (value < smallest) smallest = value
    }
    if (smallest > limit) return limit + 1
    previous = current
  }
  return previous[b.length] ?? limit + 1
}

/** The types heard on a channel closest to an unheard one, within three edits, nearest first. */
export function nearMisses(type: string, heard: Iterable<string>, limit = 3): string[] {
  const found: Array<{ type: string; distance: number }> = []
  for (const candidate of new Set(heard)) {
    if (candidate === type) continue
    const distance = editDistance(type, candidate, limit)
    if (distance <= limit) found.push({ type: candidate, distance })
  }
  return found
    .toSorted((a, b) => a.distance - b.distance || (a.type < b.type ? -1 : 1))
    .map((entry) => entry.type)
}

/** The channel an event arrived on, from the snapshot (the native one included). */
export function channelNamed(
  channels: readonly EventarcChannel[],
  native: EventarcChannel | undefined,
  name: string,
): EventarcChannel | undefined {
  if (native && native.name === name) return native
  return channels.find((channel) => channel.name === name)
}

/** How a channel is named in a list: `firebase · us-central1`, or `google · native`. */
export function channelLabel(channel: Pick<EventarcChannel, 'id' | 'location' | 'name'>): {
  id: string
  where: string
} {
  if (channel.name === 'google') return { id: 'google', where: 'native' }
  return { id: channel.id, where: channel.location ?? '' }
}

/** Every event type a channel snapshot knows: allowed, declared and listened for. */
export function knownTypes(channels: readonly EventarcChannel[]): string[] {
  const types = new Set<string>()
  for (const channel of channels) {
    for (const subscription of channel.subscriptions) types.add(subscription.eventType)
    for (const publisher of channel.publishers) {
      for (const type of publisher.allowed) types.add(type)
      for (const declared of publisher.declared) types.add(declared.type)
    }
  }
  return [...types].toSorted()
}
