// The log's volume as `MiniBars` draws it, for both strips observe shows:
// the Logs page's histogram (`GET /logs/histogram`) and the Overview's last
// hour (`OverviewState.hour`). Three stacked series as the design system
// draws them: every other line at the base, warnings, then errors on top.
// The counts come from the engine and are drawn as they are: never
// shifted, patched or summed in the browser.

import type { LogLevelCounts } from '@/api/generated/observe/LogLevelCounts'
import type { MiniBarTone } from '@/components/console/mini-bars'
import { formatCount } from '@/lib/format'

/** The three series, bottom first (`MiniBars`' order). */
export const LEVEL_SERIES: readonly { label: string; tone: MiniBarTone }[] = [
  { label: 'Info and debug', tone: 'neutral' },
  { label: 'Warnings', tone: 'warning' },
  { label: 'Errors', tone: 'danger' },
]

/** Each bucket as `MiniBars` takes it: the rest, warnings, errors. */
export function levelBuckets(buckets: readonly LogLevelCounts[]): number[][] {
  return buckets.map((bucket) => [bucket.info + bucket.debug, bucket.warn, bucket.error])
}

/**
 * Warnings and errors alone, in the same three series (the rest empty): the
 * Overview's recent problems, where a busy minute of plain output would
 * flatten the one error it is about.
 */
export function problemBuckets(buckets: readonly LogLevelCounts[]): number[][] {
  return buckets.map((bucket) => [0, bucket.warn, bucket.error])
}

/** Every line of a bucket, whatever its level. */
export function bucketTotal(bucket: LogLevelCounts): number {
  return bucket.debug + bucket.info + bucket.warn + bucket.error
}

const pad = (value: number) => String(value).padStart(2, '0')

/** `12:05`, or `12:05:10` when a bucket is shorter than a minute; local time. */
function clockAt(ms: number, seconds: boolean): string {
  const date = new Date(ms)
  const minutes = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  return seconds ? `${minutes}:${pad(date.getSeconds())}` : minutes
}

/** `12:05–12:06`: the span a bucket covers, in local time. */
export function bucketSpan(startMs: number, bucketMs: number): string {
  const seconds = bucketMs < 60_000 || startMs % 60_000 !== 0
  return `${clockAt(startMs, seconds)}–${clockAt(startMs + bucketMs, seconds)}`
}

/** "12:05–12:06 · 412 lines · 3 errors · 18 warnings": one bucket's tooltip. */
export function bucketSentence(bucket: LogLevelCounts, span: string): string {
  const total = bucketTotal(bucket)
  const parts = [span, total === 0 ? 'No lines' : formatCount(total, LINE)]
  if (bucket.error > 0) parts.push(formatCount(bucket.error, ERROR))
  if (bucket.warn > 0) parts.push(formatCount(bucket.warn, WARNING))
  return parts.join(' · ')
}

const LINE = { one: 'line', other: 'lines' }
const ERROR = { one: 'error', other: 'errors' }
const WARNING = { one: 'warning', other: 'warnings' }

/**
 * Where bucket `index` of the Overview's hour starts: the hour ends with the
 * minute `generatedAt` falls in, one bucket a minute, oldest first.
 */
export function hourBucketStart(generatedAt: string, index: number, buckets = 60): number {
  const now = Date.parse(generatedAt)
  const current = now - (now % 60_000)
  return current - (buckets - 1 - index) * 60_000
}
