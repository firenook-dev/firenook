// How long something took, the way every compute list writes it: the
// console's durations (`2.6 ms`, `840 ms`, `1.2 s`, `1 min 2 s`) in the
// data face at 11 px, and the word `cold` after it when the call had to
// start its worker, with the worker's own start time in the tooltip.
// Functions' invocation rows and Eventarc's delivery rows draw it.

import { Tooltip, cn } from '@cloudflare/kumo'
import { formatDuration } from '@/lib/format'

/** The figure, or undefined while there is none (still running). */
export function durationText(ms: number | null | undefined): string | undefined {
  return ms === null || ms === undefined || !Number.isFinite(ms) ? undefined : formatDuration(ms)
}

/** The cold mark's sentence, with the worker's start time when the engine measured it. */
export function coldText(workerStartMs?: number | null): string {
  const took = durationText(workerStartMs)
  return took ? `This call started the worker (${took}).` : 'This call started the worker.'
}

export function DurationText({
  ms,
  cold = false,
  workerStartMs,
  placeholder = '–',
  className,
  testId,
}: {
  /** Milliseconds; null while it runs. */
  ms: number | null | undefined
  /** The call started its codebase's worker. */
  cold?: boolean | undefined
  /** How long starting the worker took, for the cold mark's tooltip. */
  workerStartMs?: number | null | undefined
  /** Shown while there is no figure. */
  placeholder?: string | undefined
  className?: string | undefined
  testId?: string | undefined
}) {
  const text = durationText(ms)
  return (
    <span
      className={cn('inline-flex shrink-0 items-baseline gap-1 whitespace-nowrap', className)}
      data-testid={testId}
    >
      {text === undefined ? (
        <span className="font-mono text-[11px] text-kumo-subtle" aria-label="No duration yet">
          {placeholder}
        </span>
      ) : (
        <span className="font-mono text-[11px] text-kumo-default tabular-nums">{text}</span>
      )}
      {cold && (
        <Tooltip
          content={coldText(workerStartMs)}
          render={
            <span className="text-[11px] text-kumo-subtle" data-part="cold">
              cold
            </span>
          }
        />
      )}
    </span>
  )
}
