// Every live feed pauses the same way, in the same place: row two's right
// end, in a slot sized for its longest label so nothing beside it moves when
// it changes, with `p` to flip it. "Pause" while the feed follows the engine;
// "Paused · 12 new" while it holds still. The word "Live" is never printed:
// following is the normal case, and the engine badge already says the
// connection is up.

import { Button, Tooltip } from '@cloudflare/kumo'
import { PauseIcon, PlayIcon } from '@phosphor-icons/react'
import { Kbd } from '@/components/kit'
import { formatNumber } from '@/lib/format'
import { useShortcuts } from '@/lib/shortcuts'

export function pauseLabel(paused: boolean, pending: number): string {
  if (!paused) return 'Pause'
  return pending > 0 ? `Paused · ${formatNumber(pending)} new` : 'Paused'
}

export function PauseButton({
  paused,
  pending,
  onChange,
  testId = 'pause-button',
}: {
  paused: boolean
  /** What arrived while paused: the store's pending count, or the rows past the reader. */
  pending: number
  onChange: (paused: boolean) => void
  testId?: string
}) {
  useShortcuts({ id: 'feed.pause', label: 'Feed' }, [
    { key: 'p', label: 'Pause or resume the feed', group: 'Feed', run: () => onChange(!paused) },
  ])
  return (
    <span className="ml-auto grid shrink-0 justify-items-end">
      {/* The slot is as wide as its widest label, so the filter beside it
          never moves when the feed pauses or the count grows. */}
      <span aria-hidden className="invisible col-start-1 row-start-1 h-0 overflow-hidden">
        <Button variant="secondary" size="sm" icon={<PlayIcon />} tabIndex={-1}>
          Paused · 00,000 new
        </Button>
      </span>
      <Tooltip
        content={
          <span className="flex items-center gap-1.5">
            {paused ? 'Follow the engine again' : 'Hold the rows still'}
            <Kbd>p</Kbd>
          </span>
        }
        render={
          <Button
            variant={paused ? 'secondary' : 'ghost'}
            size="sm"
            icon={paused ? <PlayIcon weight="fill" /> : <PauseIcon weight="fill" />}
            aria-pressed={paused}
            onClick={() => onChange(!paused)}
            className="col-start-1 row-start-1 tabular-nums"
            data-testid={testId}
            data-paused={paused ? '' : undefined}
          >
            {pauseLabel(paused, pending)}
          </Button>
        }
      />
    </span>
  )
}
