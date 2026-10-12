// A topic's last minute of publishes as bars (the shared `MiniBars`, one
// series), aged on the shared one-second clock while on screen, so a topic
// that went quiet decays to nothing by itself. Sixty one-second bars do not
// fit the 64 px a toolbar or a card gives them with a pixel between each, so
// they are drawn as thirty two-second bars.

import type { MessagingSecondWindow } from '@/api/generated/messaging/MessagingSecondWindow'
import { MiniBars } from '@/components/console/mini-bars'
import { formatNumber } from '@/lib/format'
import { useAgedBuckets } from '@/messaging/windows'

/** Seconds each bar covers. */
const SECONDS_PER_BAR = 2

/** Per-second counts (oldest first) folded into bars of `per` seconds. */
export function foldBuckets(buckets: readonly number[], per: number): number[] {
  const bars: number[] = []
  for (let start = 0; start < buckets.length; start += per) {
    let sum = 0
    for (let at = start; at < start + per && at < buckets.length; at += 1) sum += buckets[at] ?? 0
    bars.push(sum)
  }
  return bars
}

/** The last minute's count and the bars, from one aged window. */
export function useLastMinute(window: MessagingSecondWindow | undefined): {
  count: number
  bars: number[]
} {
  const buckets = useAgedBuckets(window, 60)
  return {
    count: buckets.reduce((sum, value) => sum + value, 0),
    bars: foldBuckets(buckets, SECONDS_PER_BAR),
  }
}

export function ThroughputBars({
  bars,
  topicId,
  testId,
}: {
  bars: readonly number[]
  topicId: string
  testId?: string
}) {
  return (
    <span className="block h-4 w-16 shrink-0" data-testid={testId}>
      <MiniBars
        buckets={bars.map((count) => [count])}
        series={[{ label: 'Published', tone: 'neutral' }]}
        height={16}
        label={`Messages published to ${topicId}, last minute`}
        tooltip={(index) => {
          const newest = (bars.length - index - 1) * SECONDS_PER_BAR
          return `${newest + SECONDS_PER_BAR}–${newest} s ago · ${formatNumber(bars[index] ?? 0)} published`
        }}
      />
    </span>
  )
}
