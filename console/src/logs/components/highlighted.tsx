// Text with the filter's matches marked, on a neutral ground: amber means
// "warn" in this list, so a match is the fill a step above the row, in the
// row's own ink, made heavier.

import type { Highlighter } from '../highlight'

export function Highlighted({ text, highlight }: { text: string; highlight: Highlighter }) {
  const ranges = highlight.ranges(text)
  if (ranges.length === 0) return text
  const parts = []
  let at = 0
  for (const [from, to] of ranges) {
    if (from > at) parts.push(text.slice(at, from))
    parts.push(
      <mark key={from} className="rounded-sm bg-kumo-fill font-semibold text-inherit">
        {text.slice(from, to)}
      </mark>,
    )
    at = to
  }
  if (at < text.length) parts.push(text.slice(at))
  return parts
}
