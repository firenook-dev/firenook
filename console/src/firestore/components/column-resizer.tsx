// The edge of a column header, which drags.
//
// Columns are sized from what they hold — a timestamp's width, a header's
// own needs — and that is a guess about values the grid has only seen a
// page of. A UUID id is thirty-six characters against a 220 px column, and
// a URL is as long as it likes. Dragging is the answer to every case the
// guess gets wrong; a double-click puts the guess back.
//
// Its own button rather than Kumo's `Table.ResizeHandle`, which fixes its
// accessible name to "Resize column" on every column alike and paints the
// page's white behind itself, a stripe across a header that is not white.

import { useRef } from 'react'
import { clampColumn } from '../column-widths'

/** How far an arrow key moves the edge, px. */
const STEP = 16

export function ColumnResizer({
  label,
  width,
  onResize,
  onCommit,
  onReset,
  testId,
}: {
  /** The column's name, for the handle's own. */
  label: string
  width: number
  /** While dragging: the width to draw, or `null` once there is nothing to preview. */
  onResize: (px: number | null) => void
  /** Dragging finished, or an arrow key pressed: the width to keep. */
  onCommit: (px: number) => void
  onReset: () => void
  testId?: string | undefined
}) {
  const drag = useRef<{ x: number; width: number; last: number } | null>(null)
  return (
    <button
      type="button"
      aria-label={`Resize ${label}`}
      title="Drag to resize · double-click to fit"
      data-testid={testId}
      className="group/edge absolute top-0 right-0 z-[3] flex h-full w-2.5 cursor-col-resize touch-none items-center justify-center outline-none select-none focus-visible:ring-2 focus-visible:ring-kumo-focus"
      // Not the header's menu: the press is the drag's.
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => {
        event.preventDefault()
        event.stopPropagation()
        event.currentTarget.setPointerCapture(event.pointerId)
        drag.current = { x: event.clientX, width, last: width }
      }}
      onPointerMove={(event) => {
        const start = drag.current
        if (!start) return
        const next = clampColumn(start.width + event.clientX - start.x)
        start.last = next
        onResize(next)
      }}
      onPointerUp={() => {
        const start = drag.current
        drag.current = null
        if (start && start.last !== start.width) onCommit(start.last)
        else onResize(null)
      }}
      onPointerCancel={() => {
        drag.current = null
        onResize(null)
      }}
      onDoubleClick={(event) => {
        event.stopPropagation()
        onReset()
      }}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
        event.preventDefault()
        event.stopPropagation()
        onCommit(clampColumn(width + (event.key === 'ArrowRight' ? STEP : -STEP)))
      }}
    >
      {/* The line itself, drawn on hover or while it has the keyboard. */}
      <span className="h-4 w-0.5 rounded-full bg-kumo-line opacity-0 group-hover:opacity-100 group-hover/edge:bg-kumo-subtle group-focus-visible/edge:opacity-100" />
    </button>
  )
}
