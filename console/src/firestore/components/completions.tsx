// A completion list that cannot be clipped.
//
// Both lists in this panel hang off an input that lives inside a scrolling
// column, and an `absolute` popup inside `overflow: auto` is an invisible
// popup the moment its row nears an edge — the same trap that hid the path
// bar's completions, which two passing assertions walked straight through.
// So it is drawn in a portal, placed from the input's own rectangle, and it
// follows that rectangle for as long as anything is scrolling.

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

/** Room a list wants below the field before it gives up and opens upward, px. */
const ROOM = 180

export function Completions({
  anchor,
  testId,
  children,
}: {
  anchor: React.RefObject<HTMLElement | null>
  testId: string
  children: React.ReactNode
}) {
  // Measured where it is mounted — the caller renders this only while the
  // list is open — and re-measured from the events that can move it.
  const [box, setBox] = useState<DOMRect | null>(
    () => anchor.current?.getBoundingClientRect() ?? null,
  )

  useEffect(() => {
    const measure = () => setBox(anchor.current?.getBoundingClientRect() ?? null)
    // Capture, because the scroller that moves it is not the window.
    window.addEventListener('scroll', measure, true)
    window.addEventListener('resize', measure)
    return () => {
      window.removeEventListener('scroll', measure, true)
      window.removeEventListener('resize', measure)
    }
  }, [anchor])

  if (!box) return null
  // The field itself has scrolled away; so has its list.
  if (box.bottom < 0 || box.top > window.innerHeight) return null
  const below = window.innerHeight - box.bottom > ROOM
  const placement = below ? { top: box.bottom + 4 } : { bottom: window.innerHeight - box.top + 4 }
  return createPortal(
    <ul
      // Measured coordinates: the one thing a class cannot carry.
      style={{ left: box.left, width: box.width, ...placement }}
      className="fixed z-50 max-h-56 overflow-auto rounded-lg bg-kumo-elevated p-1 shadow-md ring ring-kumo-line"
      data-testid={testId}
    >
      {children}
    </ul>,
    document.body,
  )
}

/** One row of a completion list: what it is on the left, what it is on the right. */
export function Completion({
  label,
  detail,
  onPick,
}: {
  label: string
  detail: string
  onPick: () => void
}) {
  return (
    <li>
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-kumo-tint"
        onMouseDown={(event) => event.preventDefault()}
        onClick={onPick}
      >
        <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{label}</span>
        <span className="shrink-0 font-mono text-[11px] text-kumo-subtle">{detail}</span>
      </button>
    </li>
  )
}
