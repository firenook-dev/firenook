// Small volume bars, the same everywhere a count over time is drawn: the
// Logs volume strip (errors, warnings and the rest stacked), the
// Overview's last hour of problems, a Pub/Sub topic's last minute of
// publishes (one series). No chart library: a row of flex columns, each a
// stack of plain boxes, so it is a few hundred bytes and paints in a frame.
//
// Bars scale to the largest bucket, and a bucket that holds anything is at
// least one pixel tall, so a single error in an hour of quiet is still
// there to see. With `floor`, every series a bucket holds is at least that
// many pixels: one error beside a minute of 400 lines reads as a bar, not a
// hairline under its neighbours. With `onPick` the strip picks a range: click a bucket, or
// drag across several (a tinted brush follows), or from the keyboard move
// with ← →, widen with Shift, and press Enter.

import { Tooltip, cn } from '@cloudflare/kumo'
import { type KeyboardEvent, useRef, useState } from 'react'

export type MiniBarTone = 'danger' | 'warning' | 'neutral' | 'brand'

const FILL: Record<MiniBarTone, string> = {
  danger: 'bg-kumo-danger',
  warning: 'bg-kumo-warning',
  neutral: 'bg-kumo-interact',
  brand: 'bg-kumo-brand',
}

/**
 * Each series' height in whole pixels, stacked to the bucket's total: the
 * bucket is scaled to the largest one, a non-empty bucket is never below
 * one pixel, and rounding is done on the running sum so the segments add
 * up to the bucket exactly. With a `floor`, each series that holds anything
 * is at least that tall; the bucket grows to fit, and what would pass the
 * strip's height comes off its tallest series.
 */
export function stackHeights(
  bucket: readonly number[],
  max: number,
  height: number,
  floor = 0,
): number[] {
  const total = bucket.reduce((sum, value) => sum + Math.max(0, value), 0)
  if (total <= 0 || max <= 0) return bucket.map(() => 0)
  const pixels = Math.max(1, Math.round((total / max) * height))
  const heights: number[] = []
  let running = 0
  let drawn = 0
  for (const value of bucket) {
    running += Math.max(0, value)
    const upTo = Math.round((running / total) * pixels)
    heights.push(upTo - drawn)
    drawn = upTo
  }
  return floor > 0 ? raiseToFloor(bucket, heights, Math.min(floor, height), height) : heights
}

function raiseToFloor(
  bucket: readonly number[],
  heights: number[],
  floor: number,
  height: number,
): number[] {
  const raised = heights.map((pixels, at) => ((bucket[at] ?? 0) > 0 ? Math.max(pixels, floor) : 0))
  let over = raised.reduce((sum, pixels) => sum + pixels, 0) - height
  while (over > 0) {
    let tallest = -1
    for (let at = 0; at < raised.length; at += 1)
      if ((raised[at] ?? 0) > floor && (tallest < 0 || (raised[at] ?? 0) > (raised[tallest] ?? 0)))
        tallest = at
    if (tallest < 0) break
    const take = Math.min(over, (raised[tallest] ?? 0) - floor)
    raised[tallest] = (raised[tallest] ?? 0) - take
    over -= take
  }
  return raised
}

/** The largest bucket total; 0 when every bucket is empty. */
export function maxTotal(buckets: readonly (readonly number[])[]): number {
  let max = 0
  for (const bucket of buckets) {
    const total = bucket.reduce((sum, value) => sum + Math.max(0, value), 0)
    if (total > max) max = total
  }
  return max
}

export function MiniBars({
  buckets,
  series,
  height = 24,
  floor,
  label,
  tooltip,
  onPick,
  className,
  testId,
}: {
  /** Per bucket, oldest first, a value per series (in `series` order, bottom first). */
  buckets: readonly (readonly number[])[]
  series: readonly { label: string; tone: MiniBarTone }[]
  /** Pixels; the strip's width is its container's. */
  height?: number
  /**
   * Pixels every series a bucket holds is at least, so a lone error stays a
   * bar beside busy buckets. Without it heights are to scale (a non-empty
   * bucket is still at least one pixel).
   */
  floor?: number
  /** What the bars show, for assistive technology: "Log lines per minute, last hour". */
  label: string
  /** The bucket's own sentence: "12:05–12:06 · 412 lines · 3 errors". */
  tooltip?: (index: number) => string
  /** A bucket clicked, or a range dragged or chosen from the keyboard, as bucket indexes. */
  onPick?: (from: number, to: number) => void
  className?: string
  testId?: string
}) {
  const max = maxTotal(buckets)
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null)
  const [keys, setKeys] = useState<{ anchor: number; active: number } | null>(null)
  // The drag as the pointer handlers see it, between renders.
  const dragging = useRef<{ from: number; to: number } | null>(null)

  const startDrag = (index: number, pick: (from: number, to: number) => void) => {
    dragging.current = { from: index, to: index }
    setKeys(null)
    setDrag({ from: index, to: index })
    // A drag ends wherever the pointer is let go, on the strip or not.
    window.addEventListener(
      'pointerup',
      () => {
        const ended = dragging.current
        dragging.current = null
        setDrag(null)
        if (ended) pick(Math.min(ended.from, ended.to), Math.max(ended.from, ended.to))
      },
      { once: true },
    )
  }
  const extendDrag = (index: number) => {
    if (!dragging.current) return
    dragging.current = { ...dragging.current, to: index }
    setDrag(dragging.current)
  }

  const span = drag
    ? { from: drag.from, to: drag.to }
    : keys
      ? { from: keys.anchor, to: keys.active }
      : undefined
  const range = span && { low: Math.min(span.from, span.to), high: Math.max(span.from, span.to) }
  const last = buckets.length - 1

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!onPick || buckets.length === 0) return
    const move = (to: number) => {
      const active = Math.min(last, Math.max(0, to))
      setKeys((current) =>
        event.shiftKey && current ? { anchor: current.anchor, active } : { anchor: active, active },
      )
    }
    const at = keys?.active ?? last
    if (event.key === 'ArrowLeft') move(at - 1)
    else if (event.key === 'ArrowRight') move(keys ? at + 1 : last)
    else if (event.key === 'Home') move(0)
    else if (event.key === 'End') move(last)
    else if ((event.key === 'Enter' || event.key === ' ') && keys) {
      onPick(Math.min(keys.anchor, keys.active), Math.max(keys.anchor, keys.active))
    } else if (event.key === 'Escape' && keys) setKeys(null)
    else return
    event.preventDefault()
  }

  const interactive = onPick !== undefined
  return (
    <div
      className={cn('relative flex min-w-0 items-end gap-px select-none', className)}
      style={{ height }}
      role={interactive ? 'group' : 'img'}
      aria-label={label}
      tabIndex={interactive ? 0 : undefined}
      onKeyDown={interactive ? onKeyDown : undefined}
      onBlur={() => setKeys(null)}
      data-testid={testId}
    >
      {buckets.map((bucket, index) => {
        const heights = stackHeights(bucket, max, height, floor)
        const brushed = range !== undefined && index >= range.low && index <= range.high
        const column = (
          <div
            className={cn(
              'flex h-full min-w-px flex-1 flex-col-reverse rounded-[1px]',
              interactive && 'cursor-pointer hover:ink',
              brushed && 'bg-kumo-tint',
            )}
            data-index={index}
            data-brushed={brushed || undefined}
            onPointerDown={
              onPick
                ? (event) => {
                    event.preventDefault()
                    startDrag(index, onPick)
                  }
                : undefined
            }
            onPointerEnter={onPick ? () => extendDrag(index) : undefined}
          >
            {heights.map((pixels, at) =>
              pixels > 0 ? (
                <div
                  // Series are fixed for the strip's life: their order is their identity.
                  // oxlint-disable-next-line react/no-array-index-key
                  key={at}
                  className={cn(
                    'w-full shrink-0 first:rounded-b-[1px] last:rounded-t-[1px]',
                    FILL[series[at]?.tone ?? 'neutral'],
                  )}
                  style={{ height: pixels }}
                  data-series={series[at]?.label}
                />
              ) : null,
            )}
          </div>
        )
        return tooltip ? (
          // Buckets are positions in time: the index is the bucket.
          // oxlint-disable-next-line react/no-array-index-key
          <Tooltip key={index} content={tooltip(index)} render={column} />
        ) : (
          // oxlint-disable-next-line react/no-array-index-key
          <span key={index} className="contents">
            {column}
          </span>
        )
      })}
      {interactive && keys && tooltip && (
        <span className="sr-only" aria-live="polite">
          {range && range.low !== range.high
            ? `${tooltip(range.low)} to ${tooltip(range.high)}`
            : tooltip(keys.active)}
        </span>
      )}
    </div>
  )
}
