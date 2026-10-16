// A feed row's time, in the console-wide clock format (`lib/format.ts`:
// `14:02:11.348`, `3 s ago` or the UTC instant), with the other forms a hover
// away: the one time cell of every feed that follows the clock setting
// (Auth's Inbox and Activity draw it). One shared clock turns "3 s ago"
// over every second; the other two forms never change, so they ask for the
// minute clock only. `RelativeTime` is the other kind: always "3 min ago",
// for a time that is a fact about a thing rather than a row of a feed.

import { Tooltip, cn } from '@cloudflare/kumo'
import { useNow } from '@/lib/clock'
import { formatClock, relativeTime, useClockFormat, utcStamp } from '@/lib/format'

/** The forms a row's time is not shown in, for its tooltip. */
export function otherForms(iso: string, now: number): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return `${formatClock(iso, 'time', now)} local · ${utcStamp(iso)} · ${relativeTime(iso, now)}`
}

export function FeedTime({
  iso,
  className,
  testId,
}: {
  /** RFC 3339; absent for a code found in saved state, which has no time. */
  iso: string | null
  className?: string
  testId?: string
}) {
  const { format } = useClockFormat()
  const now = useNow(format === 'relative' ? 'second' : 'minute')
  // A code found in saved state has no time; the row's status chip already
  // says where it came from, so the column only says there is none.
  if (iso === null)
    return (
      <Tooltip
        content="No time: this was found in saved state"
        render={
          <span
            className={cn('cursor-default text-[12px] text-kumo-subtle', className)}
            aria-label="No time"
            data-testid={testId}
          >
            —
          </span>
        }
      />
    )
  return (
    <Tooltip
      content={otherForms(iso, now)}
      render={
        <time
          dateTime={iso}
          className={cn(
            'cursor-default font-mono text-[12px] whitespace-nowrap text-kumo-subtle tabular-nums',
            className,
          )}
          data-testid={testId}
        >
          {formatClock(iso, format, now)}
        </time>
      }
    />
  )
}
