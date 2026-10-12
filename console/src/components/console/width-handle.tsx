// A panel's left edge, which is also the grip for its width. A hairline at
// rest that lights under the pointer: the edge is already there, so the
// control is a place rather than a thing added to the panel.
//
// It measures itself against the panel it sits on (its parent) and the
// room that panel's parent offers, so it needs no id to find either — and
// the panel must be positioned (`relative` in the flow, never `static`), or
// the grip escapes to an ancestor and draws itself down the side of the
// list instead.

import { Tooltip } from '@cloudflare/kumo'
import { INSPECTOR_MIN, clampWidth, useInspectorWidth } from './inspector-width'

/** How far an arrow moves the edge, px; Shift moves it four times as far. */
const STEP = 16

/** The room the panel's parent gives it: the most the panel can take. */
function room(grip: HTMLElement): number | undefined {
  return grip.parentElement?.parentElement?.getBoundingClientRect().width
}

export function WidthHandle({
  widthKey,
  label = 'Inspector width',
  testId = 'inspector-resize',
}: {
  /** The width it drags: the inspector's own (`useInspectorWidth`). */
  widthKey: string
  /** What a screen reader calls the separator. */
  label?: string
  testId?: string
}) {
  const { width, setWidth, remember, reset } = useInspectorWidth(widthKey)
  return (
    <Tooltip
      content="Drag to resize · double-click to reset"
      side="left"
      render={
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={label}
          aria-valuenow={Math.round(width)}
          aria-valuemin={INSPECTOR_MIN}
          tabIndex={0}
          data-testid={testId}
          className="group/grip absolute inset-y-0 -left-1 z-30 w-2 cursor-col-resize outline-none"
          onPointerDown={(event) => {
            event.preventDefault()
            event.currentTarget.setPointerCapture(event.pointerId)
          }}
          onPointerMove={(event) => {
            if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
            const panel = event.currentTarget.parentElement
            const available = room(event.currentTarget)
            if (!panel || available === undefined) return
            setWidth(clampWidth(panel.getBoundingClientRect().right - event.clientX, available))
          }}
          onPointerUp={(event) => {
            event.currentTarget.releasePointerCapture(event.pointerId)
            remember()
          }}
          onKeyDown={(event) => {
            const step = event.shiftKey ? STEP * 4 : STEP
            const by = event.key === 'ArrowLeft' ? step : event.key === 'ArrowRight' ? -step : 0
            if (by === 0) return
            event.preventDefault()
            setWidth(clampWidth(width + by, room(event.currentTarget) ?? width))
            remember()
          }}
          onDoubleClick={reset}
        >
          <span className="pointer-events-none absolute inset-y-0 left-1 w-px group-hover/grip:bg-kumo-brand group-focus-visible/grip:bg-kumo-brand" />
        </div>
      }
    />
  )
}
