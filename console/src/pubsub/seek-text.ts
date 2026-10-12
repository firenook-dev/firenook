// What a replay will do, said before it is done (S15). Seeking is the
// emulator's own semantics, recorded from the official one: to a time, the
// messages published from then on become deliverable again — those already
// acknowledged only when the subscription keeps acknowledged messages — and
// everything older is acknowledged; to a snapshot, the subscription goes back
// to what the snapshot recorded; a purge is a seek to now. The emulator
// replays from what the subscription tracked: a topic's own retention fills
// a subscription when it is created, and brings nothing back on a seek.

import { formatNumber } from '@/lib/format'

export type SeekMode = 'time' | 'snapshot' | 'purge'

export interface SeekContext {
  /** The subscription keeps acknowledged messages (`retainAckedMessages`). */
  retainAcked: boolean
  /** Messages waiting in the subscription now. */
  waiting: number
  /** The topic's own message retention, seconds, when it has one. */
  topicRetentionSeconds?: number | null | undefined
  /** The chosen snapshot, for a snapshot seek. */
  snapshot?: { id: string; unacked: number; createdAt: string } | undefined
}

/** The sentence under the choice: what comes back, what is acknowledged, and why. */
export function seekSentence(mode: SeekMode, context: SeekContext): string {
  if (mode === 'purge') {
    const waiting =
      context.waiting === 0
        ? 'Nothing is waiting now'
        : `The ${formatNumber(context.waiting)} ${context.waiting === 1 ? 'message' : 'messages'} waiting now ${context.waiting === 1 ? 'is' : 'are'} acknowledged`
    return `${waiting}; messages published from now on arrive as usual.`
  }
  if (mode === 'snapshot') {
    if (!context.snapshot) return 'Choose a snapshot of this subscription’s topic.'
    const { unacked } = context.snapshot
    const recorded =
      unacked === 0
        ? 'nothing it recorded as waiting'
        : `the ${formatNumber(unacked)} ${unacked === 1 ? 'message' : 'messages'} it recorded as waiting`
    return `The subscription goes back to the snapshot: ${recorded} and every message published after it become deliverable again; the rest is acknowledged.`
  }
  if (context.retainAcked)
    return 'Messages published after this become deliverable again, acknowledged ones too, because this subscription keeps acknowledged messages. Older ones are acknowledged.'
  const why =
    context.topicRetentionSeconds != null
      ? 'because this subscription does not keep them; the topic’s retention fills new subscriptions, and the emulator does not replay from it (Keep acknowledged messages, in Settings)'
      : 'because this subscription does not keep them (Keep acknowledged messages, in Settings)'
  return `Messages published after this that are not yet acknowledged become deliverable again; acknowledged ones do not come back, ${why}. Older ones are acknowledged.`
}

/** The result, said once the seek is done: what is deliverable and what is acknowledged now. */
export function seekResultText(available: number, acked: number): string {
  return `${formatNumber(available)} ${available === 1 ? 'message' : 'messages'} available, ${formatNumber(acked)} acknowledged`
}

/** A local date at a time of day (`10:02:13`): the instant a replay goes back to. */
export function seekTime(date: Date, time: string): Date {
  const [hours = 0, minutes = 0, seconds = 0] = time.split(':').map(Number)
  const at = new Date(date)
  at.setHours(hours, minutes, seconds, 0)
  return at
}
