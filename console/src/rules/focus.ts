// Where a rules editor looks, and what it lights. Three things ask: a click
// on a problem, a line or a decision row (`reveal`); a panel's overlay
// arriving (the lines a decision or a playground run went through); and a
// link's `line` param ("Read by your rules · line 12", a decision opened
// with its line), which reveals that line once the rules have loaded,
// marks it, and leaves the address — so a reload or a shared link does not
// keep jumping back to it. Each carries when it was asked, and the latest
// wins: no reveal is ever replayed by a later render.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CodeLineMark } from '@/components/code-editor'
import { type EditorOverlay, useOverlay } from './overlay'

export interface EditorFocus {
  /** What the editor's `reveal` takes: a new object only when something new asks. */
  reveal: { line: number; at: number } | undefined
  /** Bring a line into view (a click). */
  setReveal: (line: number) => void
  /** The panel overlay that describes the text in the editor, if any. */
  shown: EditorOverlay | undefined
  /** The overlay's lit lines, or the line a link asked for while nothing newer has spoken. */
  lineMarks: readonly CodeLineMark[] | undefined
  /** The line last brought into view, for F8 to go on from. */
  at: number | undefined
}

export function useEditorFocus({
  source,
  loaded,
  line,
  onLineShown,
}: {
  /** The text in the editor; an overlay is shown only over the text it is about. */
  source: string
  /** The rules have arrived, so a line means the line it names. */
  loaded: boolean
  /** The page's `line` search param. */
  line: number | undefined
  /** Called once the line has been revealed and marked: take `line` out of the address. */
  onLineShown: () => void
}): EditorFocus {
  const [clicked, setClicked] = useState<{ line: number; at: number } | undefined>()
  const [marked, setMarked] = useState<{ line: number; at: number } | undefined>()
  // The param as last seen, so the same line asked again after it left the
  // address is revealed again.
  const [seen, setSeen] = useState<number | undefined>()
  const overlay = useOverlay((state) => state.overlay)
  const shown = overlay && overlay.source === source ? overlay : undefined
  const overlayReveal = useMemo(
    () => (shown?.reveal ? { line: shown.reveal, at: shown.at ?? 0 } : undefined),
    [shown],
  )

  // A link's line, adopted once the rules are there to hold it: revealed
  // and marked as the newest thing asked (later than any click or overlay
  // so far, without reading the clock while rendering).
  if (loaded && line !== seen) {
    setSeen(line)
    if (line !== undefined) {
      const next = { line, at: Math.max(clicked?.at ?? 0, overlay?.at ?? 0) + 1 }
      setClicked(next)
      setMarked(next)
    }
  }
  const latest = useRef(onLineShown)
  useLayoutEffect(() => {
    latest.current = onLineShown
  })
  useEffect(() => {
    if (marked !== undefined && line === marked.line) latest.current()
  }, [marked, line])

  const reveal =
    overlayReveal && (!clicked || overlayReveal.at > clicked.at) ? overlayReveal : clicked

  // The mark stands until something newer is revealed or drawn.
  const markStands =
    marked !== undefined &&
    (reveal === undefined || reveal.at <= marked.at) &&
    (shown === undefined || (shown.at ?? 0) <= marked.at)
  const lineMarks = useMemo<readonly CodeLineMark[] | undefined>(
    () =>
      shown?.lineMarks ??
      (markStands && marked ? [{ line: marked.line, tone: 'focus' }] : undefined),
    [shown, markStands, marked],
  )

  return {
    reveal,
    setReveal: (next) => setClicked({ line: next, at: Date.now() }),
    shown,
    lineMarks,
    at: reveal?.line,
  }
}
