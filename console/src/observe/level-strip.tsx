// Both observe strips — the Logs page's volume and the Overview's last hour
// of problems — as one chart: `MiniBars` with the level series over a
// ground of one faint mark per bucket. The ground is the time axis: a quiet
// stretch still reads as time with nothing in it, and a lone bar as a bar
// in a chart rather than a caret in an empty box. The volume strip's ground
// is a tick under each bucket (its grey bars are lines); the problem strip's
// is a whole slot per minute, as a status page draws an hour, because it
// holds only warnings and errors and is mostly empty. Every series a bucket
// holds is at least `LEVEL_FLOOR` pixels, so one error beside a busy minute
// is a bar, never a hairline under its neighbours. Heights above the floor
// stay to scale; the counts are the engine's, drawn as they are.

import { cn } from '@cloudflare/kumo'
import type { ComponentProps } from 'react'
import { MiniBars } from '@/components/console/mini-bars'
import { LEVEL_SERIES } from './level-bars'

/** The least height, in pixels, of a series a bucket holds. */
export const LEVEL_FLOOR = 3

export function LevelStrip({
  buckets,
  height = 24,
  ground = 'ticks',
  className,
  ...bars
}: Omit<ComponentProps<typeof MiniBars>, 'series' | 'floor'> & {
  /** A tick under each bucket, or each bucket's whole slot. */
  ground?: 'ticks' | 'slots'
}) {
  const mark = cn(
    'min-w-px flex-1 rounded-[1px] bg-kumo-fill',
    ground === 'slots' ? 'h-full' : 'h-0.5',
  )
  return (
    <div className={cn('relative min-w-0', className)} style={{ height }}>
      {/* The ground lies under the bars, column for column (MiniBars' own flex and gap). */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 flex h-full items-end gap-px"
        data-ground={ground}
        data-testid="level-strip-ground"
      >
        {buckets.map((_, index) => (
          // Buckets are positions in time: the index is the bucket.
          // oxlint-disable-next-line react/no-array-index-key
          <span key={index} className={mark} />
        ))}
      </div>
      <MiniBars
        {...bars}
        buckets={buckets}
        series={LEVEL_SERIES}
        height={height}
        floor={LEVEL_FLOOR}
        className="w-full"
      />
    </div>
  )
}
