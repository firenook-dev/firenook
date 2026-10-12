// What this tab pulled (S9): each received message with its ack id, which
// never goes in a URL, kept until the tab moves to another subscription, at
// most a thousand. A lease ends at its expiry whether or not anyone looks;
// the store records what this tab did with each message (acked, nacked,
// extended) so the row says it, and an expired lease is read from the clock
// — or from the engine, when the lease ended early (returned from the
// backlog, purged, delivered to someone else): `lostLeases` compares the
// rows with the subscription's outstanding messages.

import { create } from 'zustand'
import type { PubsubReceived } from '@/api/generated/messaging/PubsubReceived'

/** Received messages kept per tab. */
export const PULLED_KEPT = 1000

export interface PulledRow {
  /** The row's key: an ack id is unique per delivery. */
  ackId: string
  deliveryAttempt: number
  leaseExpiresAt: string
  message: PubsubReceived['message']
  receivedAt: string
  /** What this tab did with it; undefined while it holds the lease. */
  outcome?: 'acked' | 'nacked' | undefined
  /**
   * The subscription's delivery count for this delivery, when the message
   * says none itself (`deliveryAttempt` is 0 without a dead-letter policy):
   * read from the engine's first list after it arrived.
   */
  heldAttempts?: number | undefined
  /** The engine no longer leases it to this delivery (drawn, never stored). */
  lost?: boolean | undefined
}

interface PullState {
  /** The subscription the rows came from. */
  subscription: string | undefined
  rows: PulledRow[]
  /** The newest first; a pull from another subscription starts again. */
  receive: (subscription: string, received: readonly PubsubReceived[], at?: Date) => void
  mark: (ackIds: readonly string[], outcome: 'acked' | 'nacked') => void
  extend: (ackIds: readonly string[], seconds: number, at?: Date) => void
  /** Forgets everything unless it is `subscription`'s. */
  keepOnly: (subscription: string) => void
  /** Records each delivery's count as the engine first reported it. */
  noteAttempts: (attempts: ReadonlyMap<string, number>) => void
}

export const usePulled = create<PullState>((set) => ({
  subscription: undefined,
  rows: [],
  receive: (subscription, received, at = new Date()) =>
    set((state) => {
      const fresh = received.map((item) => ({
        ackId: item.ackId,
        deliveryAttempt: item.deliveryAttempt,
        leaseExpiresAt: item.leaseExpiresAt,
        message: item.message,
        receivedAt: at.toISOString(),
      }))
      const earlier = state.subscription === subscription ? state.rows : []
      // A message delivered again comes with a new ack id: its old row goes.
      const ids = new Set(fresh.map((row) => row.message.id))
      return {
        subscription,
        rows: [...fresh, ...earlier.filter((row) => !ids.has(row.message.id))].slice(
          0,
          PULLED_KEPT,
        ),
      }
    }),
  mark: (ackIds, outcome) =>
    set((state) => {
      const marked = new Set(ackIds)
      return {
        rows: state.rows.map((row) => (marked.has(row.ackId) ? { ...row, outcome } : row)),
      }
    }),
  extend: (ackIds, seconds, at = new Date()) =>
    set((state) => {
      const extended = new Set(ackIds)
      const until = new Date(at.getTime() + seconds * 1000).toISOString()
      return {
        rows: state.rows.map((row) =>
          extended.has(row.ackId) && row.outcome === undefined
            ? { ...row, leaseExpiresAt: until }
            : row,
        ),
      }
    }),
  keepOnly: (subscription) =>
    set((state) => (state.subscription === subscription ? state : { subscription, rows: [] })),
  noteAttempts: (attempts) =>
    set((state) => ({
      rows: state.rows.map((row) => {
        const seen = attempts.get(row.ackId)
        return seen === undefined || row.heldAttempts !== undefined
          ? row
          : Object.assign({}, row, { heldAttempts: seen })
      }),
    })),
}))

/** Whether a received row's lease has run out at `now` (and this tab did nothing with it). */
export function leaseExpired(
  row: Pick<PulledRow, 'leaseExpiresAt' | 'outcome' | 'lost'>,
  now: number,
): boolean {
  return row.outcome === undefined && (row.lost === true || Date.parse(row.leaseExpiresAt) <= now)
}

/** What the engine leases now: the subscription's outstanding messages, read at `readAt`. */
export interface Outstanding {
  /** Every outstanding message is in `rows` (the engine's list had no next page). */
  complete: boolean
  readAt: number
  rows: readonly { id: string; attempts: number }[]
}

/**
 * The ack ids whose lease ended early: rows this tab still holds whose
 * message the engine no longer leases, or leases again to a later delivery.
 * Only a list read after a row arrived can say so.
 */
export function lostLeases(
  rows: readonly PulledRow[],
  outstanding: Outstanding | undefined,
): Set<string> {
  const lost = new Set<string>()
  if (!outstanding?.complete) return lost
  const leased = new Map(outstanding.rows.map((row) => [row.id, row.attempts]))
  for (const row of rows) {
    if (row.outcome !== undefined) continue
    if (outstanding.readAt < Date.parse(row.receivedAt)) continue
    const attempts = leased.get(row.message.id)
    const expected = row.deliveryAttempt > 0 ? row.deliveryAttempt : row.heldAttempts
    if (attempts === undefined || (expected !== undefined && attempts > expected))
      lost.add(row.ackId)
  }
  return lost
}

/**
 * The delivery counts to note for rows whose message gave none: the
 * engine's count for each, from a list read after the row arrived.
 */
export function attemptsToNote(
  rows: readonly PulledRow[],
  outstanding: Outstanding | undefined,
): Map<string, number> {
  const notes = new Map<string, number>()
  if (!outstanding) return notes
  const leased = new Map(outstanding.rows.map((row) => [row.id, row.attempts]))
  for (const row of rows) {
    if (row.deliveryAttempt > 0 || row.heldAttempts !== undefined || row.outcome !== undefined)
      continue
    if (outstanding.readAt < Date.parse(row.receivedAt)) continue
    const attempts = leased.get(row.message.id)
    if (attempts !== undefined) notes.set(row.ackId, attempts)
  }
  return notes
}

/** "3 received · 2 leased · 1 acked". */
export function pulledSummary(rows: readonly PulledRow[], now: number): string {
  const leased = rows.filter((row) => row.outcome === undefined && !leaseExpired(row, now)).length
  const acked = rows.filter((row) => row.outcome === 'acked').length
  return `${rows.length} received · ${leased} leased · ${acked} acked`
}
