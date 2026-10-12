// This page's own subscription, said only when the engine ended or refused
// it. A dropped channel is the whole console's, so the engine badge in the
// top bar says that, once, for every page; a green "Live" in every toolbar
// would only announce the normal case. What is left to say here is the one
// thing a page that looks fresh must not hide: these rows have stopped
// following the engine.

import { Button, Tooltip } from '@cloudflare/kumo'
import type { SubscriptionStatus } from '@/lib/live/channel'

/** What the tooltip says about a stopped or refused subscription. */
export function liveNoticeText(
  status: 'ended' | 'refused',
  what: string,
  message: string | undefined,
): string {
  const said = message?.trim() ?? ''
  const reason = said ? ` ${said}${/[.!?]$/.test(said) ? '' : '.'}` : ''
  return status === 'ended'
    ? `Live updates for ${what} stopped, so what is on screen may be out of date.${reason} The console retries by itself; Retry asks now.`
    : `The engine refused live updates for ${what}, so what is on screen may be out of date.${reason}`
}

export function LiveNotice({
  status,
  what,
  message,
  onRetry,
  testId = 'live-notice',
}: {
  status: SubscriptionStatus
  /** What the subscription keeps current, for the tooltip: "the users". */
  what: string
  /** The engine's own words, when the page has them (`onEnd` / `onRefused`). */
  message?: string | undefined
  /** Usually `liveChannel.retry`. */
  onRetry: () => void
  testId?: string
}) {
  if (status !== 'ended' && status !== 'refused') return null
  return (
    <span className="flex shrink-0 items-center gap-0.5" data-testid={testId} data-state={status}>
      <Tooltip
        content={liveNoticeText(status, what, message)}
        render={
          <span className="flex h-7 cursor-default items-center gap-1.5 px-1.5 text-[12px] text-kumo-warning">
            <span className="relative flex size-2" aria-hidden>
              <span className="relative inline-flex size-2 rounded-full bg-kumo-warning" />
            </span>
            {/* The words give way first on a narrow window; the dot and Retry stay. */}
            <span className="hidden xl:inline">
              {status === 'ended' ? 'Live updates stopped' : 'Live updates refused'}
            </span>
            <span className="sr-only xl:hidden">
              {status === 'ended' ? 'Live updates stopped' : 'Live updates refused'}
            </span>
          </span>
        }
      />
      <Button variant="ghost" size="xs" onClick={onRetry} data-testid={`${testId}-retry`}>
        Retry
      </Button>
    </span>
  )
}
