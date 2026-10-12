// A time as people read it in a list — "3 min ago" — with the exact
// instant a hover away, in local time and in UTC. One shared clock keeps
// every relative time on screen current (`useNow`): to the second while a
// time is under an hour old, to the minute after that.

import { Tooltip, cn } from '@cloudflare/kumo'
import { useNow } from '@/lib/clock'
import { compactIso, relativeTime } from '@/lib/format'

/** "Monday 12 October 2026, 14:02:11 local · 2026-10-12 06:02:11 UTC". */
export function exactTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const local = date.toLocaleString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  return `${local} local · ${compactIso(date.toISOString())} UTC`
}

export function RelativeTime({
  iso,
  prefix,
  className,
  testId,
}: {
  /** RFC 3339. */
  iso: string
  /** Leads the words: "Created" reads "Created 3 min ago". */
  prefix?: string
  className?: string
  testId?: string
}) {
  const then = new Date(iso).getTime()
  // To the second while the words change every few seconds, to the minute after.
  const minute = useNow('minute')
  const recent = Number.isFinite(then) && Math.abs(minute - then) < 3_600_000
  const now = useNow(recent ? 'second' : 'minute')
  const text = relativeTime(iso, now)
  return (
    <Tooltip
      content={exactTime(iso)}
      render={
        <time
          dateTime={iso}
          className={cn('text-[12px] whitespace-nowrap', className)}
          data-testid={testId}
        >
          {prefix ? `${prefix} ${text}` : text}
        </time>
      }
    />
  )
}
