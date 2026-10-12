// Where an invocation's time went, as one bar: starting the worker (only
// for a call that had to), waiting for the first byte of the answer, and
// the body after it — the network panel's waterfall for one call. The
// engine measures every point from the moment the invocation began, so
// the segments add up to the whole.
//
// No hue: the bar says where the time went, not whether it went well
// (that is the outcome's colour). The worker's start is hatched, the
// waiting solid, the body a lighter step of the same ink, each segment a
// separate box on the track so even a fraction of a millisecond is seen.

import { cn } from '@cloudflare/kumo'
import type { InvocationTimings } from '@/api/generated/compute/InvocationTimings'
import { formatDuration } from '@/lib/format'

export type TimingSegmentId = 'worker' | 'wait' | 'body' | 'unanswered' | 'running'

export interface TimingSegment {
  id: TimingSegmentId
  label: string
  ms: number
}

const LABEL: Record<TimingSegmentId, string> = {
  worker: 'Worker start',
  wait: 'To first byte',
  body: 'Body',
  unanswered: 'No answer',
  running: 'Running',
}

// Steps of the contrast ink over the track, the same steps in both themes
// (the surface greys collapse into each other in dark mode).
const FILL: Record<TimingSegmentId, string> = {
  // Hatched: overhead, not the function's own time.
  worker:
    'bg-[repeating-linear-gradient(135deg,color-mix(in_oklab,var(--color-kumo-contrast)_32%,transparent)_0_2px,transparent_2px_4px)]',
  wait: 'bg-kumo-contrast/35',
  body: 'bg-kumo-contrast/15',
  unanswered: 'bg-kumo-contrast/35',
  running: 'bg-kumo-contrast/15',
}

/**
 * The segments of an invocation's time and the whole of it. A call that
 * never answered (a timeout, a crash) has a "No answer" segment for the
 * time after the worker started; a running one ends with what is known so
 * far. A segment of no length is left out.
 */
export function timingSegments(
  timings: InvocationTimings,
  running = false,
): { segments: TimingSegment[]; totalMs: number | null } {
  const segments: TimingSegment[] = []
  const add = (id: TimingSegmentId, ms: number) => {
    if (ms > 0) segments.push({ id, label: LABEL[id], ms })
  }
  const worker = timings.workerStartMs ?? 0
  add('worker', worker)
  if (timings.firstByteMs !== null) {
    add('wait', Math.max(0, timings.firstByteMs - worker))
    if (timings.totalMs !== null) add('body', Math.max(0, timings.totalMs - timings.firstByteMs))
  } else if (timings.totalMs !== null) {
    add(running ? 'running' : 'unanswered', Math.max(0, timings.totalMs - worker))
  }
  return { segments, totalMs: timings.totalMs }
}

/** The bar's sentence for assistive technology: every segment, then the whole. */
export function timingSentence(segments: readonly TimingSegment[], totalMs: number | null): string {
  const parts = segments.map(
    (segment, index) =>
      `${index === 0 ? segment.label : segment.label.toLowerCase()} ${formatDuration(segment.ms)}`,
  )
  const whole = totalMs === null ? 'still running' : `${formatDuration(totalMs)} in all`
  return parts.length === 0 ? `Timing: ${whole}` : `${parts.join(', ')}; ${whole}`
}

export function TimingBar({
  timings,
  running = false,
  className,
  testId = 'timing-bar',
}: {
  timings: InvocationTimings
  /** Still running: the whole is not known yet. */
  running?: boolean | undefined
  className?: string | undefined
  testId?: string | undefined
}) {
  const { segments, totalMs } = timingSegments(timings, running)
  return (
    <div className={cn('grid min-w-0 gap-1.5', className)} data-testid={testId}>
      <div
        className="flex h-1.5 w-full gap-0.5 overflow-hidden rounded-full bg-kumo-tint"
        role="img"
        aria-label={timingSentence(segments, totalMs)}
      >
        {segments.map((segment) => (
          <span
            key={segment.id}
            className={cn(
              'h-full min-w-0.5 first:rounded-l-full last:rounded-r-full',
              FILL[segment.id],
            )}
            // A share of the bar is a run-time figure; Tailwind cannot write it.
            style={{ flexGrow: segment.ms, flexBasis: 0 }}
            data-segment={segment.id}
          />
        ))}
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-kumo-subtle">
        {segments.map((segment) => (
          <span key={segment.id} className="inline-flex items-center gap-1.5 whitespace-nowrap">
            <span className={cn('size-2 shrink-0 rounded-sm', FILL[segment.id])} aria-hidden />
            {segment.label}
            <span className="font-mono text-kumo-default tabular-nums">
              {formatDuration(segment.ms)}
            </span>
          </span>
        ))}
        <span className="ml-auto font-mono text-kumo-default tabular-nums" data-part="total">
          {totalMs === null ? (running ? 'Running' : '–') : formatDuration(totalMs)}
        </span>
      </div>
    </div>
  )
}
