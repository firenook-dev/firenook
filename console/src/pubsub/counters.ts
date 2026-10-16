// The topics index kept current by `pubsub.counters` frames: each frame
// carries the topics and subscriptions whose counters changed after the
// subscriber's revision (all of the project's when it opens), and replaces
// their counters in the cached index where it names them. Counters are
// state, so a frame is applied whole or not at all: only when it is newer
// than the index, and the index takes the frame's revision. A frame naming
// a topic or subscription the index does not hold says the index's
// structure moved under it; the caller reads it again.

import type { PubsubCountersFrame } from '@/api/generated/messaging/PubsubCountersFrame'
import type { PubsubSubscriptionCounters } from '@/api/generated/messaging/PubsubSubscriptionCounters'
import type { PubsubSubscriptionSummary } from '@/api/generated/messaging/PubsubSubscriptionSummary'
import type { PubsubTopicCounters } from '@/api/generated/messaging/PubsubTopicCounters'
import type { PubsubTopicIndex } from '@/api/generated/messaging/PubsubTopicIndex'
import { createLiveFrameLog } from '@/messaging/frames'

/** The frames of the last ten seconds, by project, for a re-read index to catch up with. */
export const countersLog = createLiveFrameLog<PubsubCountersFrame>()

export interface AppliedCounters {
  /** The index with the frame's counters in place; the same object when nothing changed. */
  index: PubsubTopicIndex
  /** The frame named a topic or subscription the index does not hold. */
  unknown: boolean
}

function patchSubscriptions(
  subscriptions: readonly PubsubSubscriptionSummary[],
  changed: ReadonlyMap<string, PubsubSubscriptionCounters>,
  seen: Set<string>,
): PubsubSubscriptionSummary[] | undefined {
  let patched: PubsubSubscriptionSummary[] | undefined
  subscriptions.forEach((subscription, index) => {
    const counters = changed.get(subscription.name)
    if (!counters) return
    seen.add(subscription.name)
    patched ??= [...subscriptions]
    patched[index] = { ...subscription, counters }
  })
  return patched
}

/** Applies one frame to the index (see the file's note). */
export function applyCountersFrame(
  index: PubsubTopicIndex,
  frame: PubsubCountersFrame,
): AppliedCounters {
  if (frame.revision <= index.revision) return { index, unknown: false }
  const topics = new Map<string, PubsubTopicCounters>(frame.topics.map((t) => [t.name, t]))
  const subscriptions = new Map<string, PubsubSubscriptionCounters>(
    frame.subscriptions.map((s) => [s.name, s]),
  )
  const seenTopics = new Set<string>()
  const seenSubscriptions = new Set<string>()
  const items = index.items.map((topic) => {
    const counters = topics.get(topic.name)
    if (counters) seenTopics.add(topic.name)
    const patched = patchSubscriptions(topic.subscriptions, subscriptions, seenSubscriptions)
    if (!counters && !patched) return topic
    return {
      ...topic,
      ...(counters ? { counters } : {}),
      ...(patched ? { subscriptions: patched } : {}),
    }
  })
  const detached =
    patchSubscriptions(index.detached, subscriptions, seenSubscriptions) ?? index.detached
  const unknown =
    frame.topics.some((topic) => !seenTopics.has(topic.name)) ||
    frame.subscriptions.some((subscription) => !seenSubscriptions.has(subscription.name))
  return { index: { ...index, items, detached, revision: frame.revision }, unknown }
}

/** The index caught up with the frames that arrived while it was being read. */
export function catchUpIndex(
  index: PubsubTopicIndex,
  frames: readonly PubsubCountersFrame[],
): PubsubTopicIndex {
  let caught = index
  for (const frame of frames) caught = applyCountersFrame(caught, frame).index
  return caught
}
