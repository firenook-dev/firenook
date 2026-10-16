// Counts that change with the clock alone — published in the last minute, a
// topic's throughput bars, dispatched and failed in the last minutes, the
// tokens in a queue's bucket — arrive as stamps, never as finished numbers:
// a number sent when traffic stops would freeze on screen, since nothing
// changes to send another (messaging spec §6.4). The engine sends a window
// that ends at a whole second (`endsAt`) with its non-zero buckets, and the
// console ages it on the shared one-second clock while it is on screen, so
// "12/min" decays to "0/min" by itself. Tokens are sent as the bucket at
// `refilledAt` and the rate, and refilled here by the engine's own rule.

import type { MessagingSecondWindow } from '@/api/generated/messaging/MessagingSecondWindow'
import type { MessagingTenSecondWindow } from '@/api/generated/messaging/MessagingTenSecondWindow'
import { useNow } from '@/lib/clock'

/** A stamped window: buckets `[buckets before endsAt, count]`, newest first. */
export type StampedWindow = MessagingSecondWindow | MessagingTenSecondWindow

/** How many whole buckets have passed since the window ended, at `now`. */
function shift(window: StampedWindow, now: number, bucketSeconds: number): number {
  const ended = Date.parse(window.endsAt)
  if (Number.isNaN(ended)) return 0
  return Math.max(0, Math.floor((now - ended) / (bucketSeconds * 1000)))
}

/**
 * The window's count over the last `spanSeconds` at `now`: each bucket aged
 * by the whole buckets since `endsAt`, those that left the span dropped.
 * `bucketSeconds` is 1 for a second window, 10 for a ten-second one.
 */
export function agedSum(
  window: StampedWindow | null | undefined,
  spanSeconds: number,
  now: number,
  bucketSeconds = 1,
): number {
  if (!window) return 0
  const span = Math.floor(spanSeconds / bucketSeconds)
  const moved = shift(window, now, bucketSeconds)
  let sum = 0
  for (const [before, count] of window.buckets) if (before + moved < span) sum += count
  return sum
}

/**
 * The last `span` buckets at `now`, oldest first, for `MiniBars` (one
 * series: `agedBuckets(w, 60, now).map((n) => [n])`).
 */
export function agedBuckets(
  window: StampedWindow | null | undefined,
  span: number,
  now: number,
  bucketSeconds = 1,
): number[] {
  const buckets: number[] = Array.from({ length: span }, () => 0)
  if (!window) return buckets
  const moved = shift(window, now, bucketSeconds)
  for (const [before, count] of window.buckets) {
    const age = before + moved
    if (age < span) buckets[span - 1 - age] = (buckets[span - 1 - age] ?? 0) + count
  }
  return buckets
}

/** `agedSum` on the shared one-second clock (it pauses while the page is hidden). */
export function useAgedCount(
  window: StampedWindow | null | undefined,
  spanSeconds: number,
  bucketSeconds = 1,
): number {
  const now = useNow('second')
  return agedSum(window, spanSeconds, now, bucketSeconds)
}

/** `agedBuckets` on the shared one-second clock. */
export function useAgedBuckets(
  window: StampedWindow | null | undefined,
  span: number,
  bucketSeconds = 1,
): number[] {
  const now = useNow('second')
  return agedBuckets(window, span, now, bucketSeconds)
}

/** What a queue's counters say about its token bucket. */
export interface TokenBucket {
  tokens: number
  maxTokens: number
  refilledAt: string
  maxDispatchesPerSecond: number
}

/**
 * The tokens in a queue's bucket at `now`, by the emulator's refill rule
 * (`refillTokens`, run once a second): nothing under a second after the
 * last refill, then the rate for each whole second since, never past the
 * bucket's size. A dispatch takes a token and sends new counters, so the
 * bucket only ever refills between frames.
 */
export function tokensAt(bucket: TokenBucket, now: number): number {
  const refilled = Date.parse(bucket.refilledAt)
  if (Number.isNaN(refilled)) return bucket.tokens
  const seconds = Math.floor((now - refilled) / 1000)
  if (seconds < 1) return bucket.tokens
  return Math.min(bucket.tokens + seconds * bucket.maxDispatchesPerSecond, bucket.maxTokens)
}

/** `tokensAt` on the shared one-second clock. */
export function useTokens(bucket: TokenBucket | null | undefined): number | undefined {
  const now = useNow('second')
  return bucket ? tokensAt(bucket, now) : undefined
}
