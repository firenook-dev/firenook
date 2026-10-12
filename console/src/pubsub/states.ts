// What became of a message, in words and tones, one vocabulary for every
// place that says it: the row's marks, the inspector's deliveries, the
// backlog's state column. Colour only where it means something, in the
// StatusDot vocabulary: success delivered, danger failed or dead-lettered,
// warning a retry in the way, brand in flight, neutral everything else.

import type { PubsubBacklogRow } from '@/api/generated/messaging/PubsubBacklogRow'
import type { PubsubDeliveryRow } from '@/api/generated/messaging/PubsubDeliveryRow'
import type { PubsubFunctionMark } from '@/api/generated/messaging/PubsubFunctionMark'
import type { PubsubHistoryWindow } from '@/api/generated/messaging/PubsubHistoryWindow'
import type { PubsubMessageAtSubscription } from '@/api/generated/messaging/PubsubMessageAtSubscription'
import type { PubsubMessageState } from '@/api/generated/messaging/PubsubMessageState'
import type { StatusTone } from '@/components/kit'
import { formatBytes, formatNumber } from '@/lib/format'

/** How a subscription mark is drawn: a 7 px circle in one of five shapes, or nothing. */
export type MarkShape = 'hollow' | 'half' | 'filled' | 'danger' | 'dashed' | 'none'

export interface SubscriptionMark {
  shape: MarkShape
  /** The state in words, for the mark's tooltip and the inspector. */
  word: string
}

/** A message's mark at one subscription. */
export function subscriptionMark(state: PubsubMessageState): SubscriptionMark {
  switch (state) {
    case 'available':
      return { shape: 'hollow', word: 'available' }
    case 'outstanding':
      return { shape: 'half', word: 'outstanding (leased to a subscriber)' }
    case 'pushing':
      return { shape: 'half', word: 'pushing to its endpoint' }
    case 'acked':
      return { shape: 'filled', word: 'acknowledged' }
    case 'drained':
      return { shape: 'filled', word: 'drained by the functions consumer' }
    case 'dead-lettered':
      return { shape: 'danger', word: 'dead-lettered' }
    case 'filtered':
      return { shape: 'dashed', word: 'filtered out' }
    case 'not-tracked':
      return { shape: 'none', word: 'not tracked (created after this message)' }
  }
}

/** The tone a subscription state takes as a dot and a word. */
export function subscriptionTone(state: PubsubMessageState): StatusTone {
  if (state === 'outstanding') return 'brand'
  if (state === 'pushing') return 'warning'
  if (state === 'dead-lettered') return 'danger'
  return 'neutral'
}

/** How a function mark is drawn: the glyph beside the lightning, and its tone. */
export type FunctionGlyph = 'check' | 'x' | 'dots' | 'minus' | 'question'

export interface FunctionMarkLook {
  glyph: FunctionGlyph
  tone: StatusTone
  /** One word or two, for the chip and the tooltip. */
  word: string
}

export function functionMark(mark: PubsubFunctionMark): FunctionMarkLook {
  switch (mark) {
    case 'queued':
      return { glyph: 'dots', tone: 'neutral', word: 'queued' }
    case 'running':
      return { glyph: 'dots', tone: 'brand', word: 'running' }
    case 'delivered':
      return { glyph: 'check', tone: 'success', word: 'delivered' }
    case 'failed':
      return { glyph: 'x', tone: 'danger', word: 'failed' }
    case 'skipped':
      return { glyph: 'minus', tone: 'neutral', word: 'skipped' }
    case 'not-kept':
      return { glyph: 'question', tone: 'neutral', word: 'no longer kept' }
  }
}

/** How many invocations compute's record keeps, as its sentence names it. */
export const INVOCATIONS_KEPT = 2_000

/** The sentence beside a delivery: why it is where it is, or what the handler said. */
export function deliveryDetail(
  row: Pick<PubsubDeliveryRow, 'mark' | 'error' | 'skippedReason' | 'queueDepth' | 'status'>,
): string | undefined {
  switch (row.mark) {
    case 'queued':
      return row.queueDepth !== null && row.queueDepth > 0
        ? `${formatNumber(row.queueDepth)} ${row.queueDepth === 1 ? 'delivery' : 'deliveries'} waiting for a free slot`
        : 'Waiting for a free slot'
    case 'skipped':
      return (
        row.skippedReason ??
        'Background triggers were paused, so the event was dropped, not queued.'
      )
    case 'not-kept':
      return `The engine no longer keeps this invocation; it keeps the newest ${formatNumber(INVOCATIONS_KEPT)}.`
    case 'failed':
      return row.error ?? (row.status !== null ? `The handler answered ${row.status}.` : undefined)
    default:
      return undefined
  }
}

/** "6 s left", "1 m 4 s left", "expired" — a lease or a deadline against `now`. */
export function countdownText(iso: string | null, now: number, ended = 'expired'): string {
  if (!iso) return ''
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return ''
  const seconds = Math.ceil((at - now) / 1000)
  if (seconds <= 0) return ended
  if (seconds < 60) return `${seconds} s left`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest === 0 ? `${minutes} m left` : `${minutes} m ${rest} s left`
}

/** A backlog row's state as a dot and words, at `now`. */
export function backlogState(
  row: Pick<PubsubBacklogRow, 'state' | 'leaseExpiresAt' | 'nextPushAt' | 'attempts'>,
  now: number,
): { tone: StatusTone; word: string; redelivered: boolean } {
  const redelivered = row.attempts > 1
  switch (row.state) {
    case 'available':
      return { tone: 'neutral', word: 'available', redelivered }
    case 'outstanding': {
      const left = countdownText(row.leaseExpiresAt, now)
      return { tone: 'brand', word: left ? `outstanding · ${left}` : 'outstanding', redelivered }
    }
    case 'pushing': {
      const at = row.nextPushAt ? Date.parse(row.nextPushAt) : Number.NaN
      const seconds = Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - now) / 1000))
      return {
        tone: 'warning',
        word:
          seconds === undefined
            ? 'pushing'
            : seconds === 0
              ? 'pushing · now'
              : `pushing · retry in ${seconds} s`,
        redelivered,
      }
    }
    case 'acked':
      return { tone: 'neutral', word: 'acked (retained)', redelivered: false }
  }
}

/** One line about a message at one subscription, for the inspector. */
export function atSubscriptionText(
  at: PubsubMessageAtSubscription,
  now: number,
  maxDeliveries?: number,
): string {
  switch (at.state) {
    case 'available':
      return at.attempts > 0
        ? `available again after ${at.attempts} ${at.attempts === 1 ? 'delivery' : 'deliveries'}`
        : 'available, not yet delivered'
    case 'outstanding': {
      const left = countdownText(at.leaseExpiresAt, now)
      const attempt =
        maxDeliveries !== undefined
          ? `delivery ${at.attempts} of ${maxDeliveries}`
          : `delivery ${at.attempts}`
      return left && left !== 'expired'
        ? `outstanding, ${attempt}, lease ends in ${left.replace(' left', '')}`
        : `outstanding, ${attempt}`
    }
    case 'pushing':
      return `pushing to its endpoint (${at.attempts} ${at.attempts === 1 ? 'attempt' : 'attempts'})`
    case 'acked':
      return 'acknowledged'
    case 'dead-lettered':
      return maxDeliveries !== undefined
        ? `dead-lettered after ${maxDeliveries} deliveries`
        : 'dead-lettered'
    case 'drained':
      return 'drained by the functions consumer'
    case 'filtered':
      return at.filteredBy ? `filtered out by ${at.filteredBy}` : 'filtered out by its filter'
    case 'not-tracked':
      return 'not tracked: the subscription was created after this message'
  }
}

/** What the history window says once older messages have gone, or undefined while nothing has. */
export function evictedText(window: PubsubHistoryWindow, topicId: string): string | undefined {
  if (window.dropped === 0) return undefined
  return `The engine no longer keeps older messages of ${topicId}; it keeps the newest ${formatNumber(window.capacityMessages)} (${formatBytes(window.capacityBytes)}).`
}

/**
 * Whether a subscription looks stalled: messages waiting longer than three
 * ack deadlines (the default ten seconds when the deadline is not known)
 * and nobody connected to take them.
 */
export function isStalled(
  counters: {
    backlog: number
    oldestUnackedAt: string | null
    consumers: { streaming: number; waitingPulls: number }
  },
  now: number,
  ackDeadlineSeconds = 10,
): boolean {
  if (counters.backlog === 0 || !counters.oldestUnackedAt) return false
  if (counters.consumers.streaming + counters.consumers.waitingPulls > 0) return false
  const waited = now - Date.parse(counters.oldestUnackedAt)
  return waited > ackDeadlineSeconds * 3 * 1000
}

/** "4 minutes", "1 hour" — how long the oldest message has waited, in a sentence. */
export function waitedText(oldest: string | null, now: number): string {
  if (!oldest) return ''
  const seconds = Math.max(0, Math.round((now - Date.parse(oldest)) / 1000))
  if (seconds < 60) return seconds === 1 ? '1 second' : `${seconds} seconds`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return minutes === 1 ? '1 minute' : `${minutes} minutes`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return hours === 1 ? '1 hour' : `${hours} hours`
  const days = Math.round(hours / 24)
  return `${days} days`
}

/** "12 s", "4 m", "3 h", "2 d" — how long the oldest message has waited, in a figure. */
export function waitedShort(oldest: string | null, now: number): string {
  if (!oldest) return ''
  const seconds = Math.max(0, Math.round((now - Date.parse(oldest)) / 1000))
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} m`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours} h`
  return `${Math.floor(hours / 24)} d`
}

/** Who is consuming a subscription, in the table's words: `1 stream`, `2 waiting pulls`, `—`. */
export function consumersText(consumers: { streaming: number; waitingPulls: number }): string {
  const parts: string[] = []
  if (consumers.streaming > 0)
    parts.push(`${consumers.streaming} ${consumers.streaming === 1 ? 'stream' : 'streams'}`)
  if (consumers.waitingPulls > 0)
    parts.push(
      `${consumers.waitingPulls} waiting ${consumers.waitingPulls === 1 ? 'pull' : 'pulls'}`,
    )
  return parts.length > 0 ? parts.join(' · ') : '—'
}
