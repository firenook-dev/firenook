// The copy mark that says it copied. Kumo's own motion, from its
// `ClipboardText`: the copy mark rises out of its box as a tick rises in
// behind it, and a moment later the copy mark comes back. The console's
// copy buttons had three answers between them — a tick swapped in, a
// ticked circle swapped in, and nothing at all on the path's copy, which
// left a click on it looking like a click that missed.

import { CheckIcon, CopyIcon } from '@phosphor-icons/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { copyToClipboard } from '@/lib/copy'

/** How long the tick stays, ms: Kumo's own. */
const COPIED_MS = 1500

export function CopyGlyph({ copied }: { copied: boolean }) {
  return (
    <span
      className="grid overflow-hidden *:col-start-1 *:row-start-1"
      data-copied={copied || undefined}
      aria-hidden
    >
      <span
        className={`flex transition duration-200 motion-reduce:transition-none ${copied ? '-translate-y-full opacity-0' : ''}`}
      >
        <CopyIcon />
      </span>
      <span
        className={`flex transition duration-200 motion-reduce:transition-none ${copied ? '' : 'translate-y-full opacity-0'}`}
        data-part="tick"
      >
        <CheckIcon />
      </span>
    </span>
  )
}

/**
 * `copied` for a moment after `flash`. `copy` writes the text through
 * `copyToClipboard` and flashes only once the clipboard has it, so a
 * refused write shows no tick and says why in a toast.
 */
export function useCopied() {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const flash = useCallback(() => {
    window.clearTimeout(timer.current)
    setCopied(true)
    timer.current = window.setTimeout(() => setCopied(false), COPIED_MS)
  }, [])
  const copy = useCallback(
    async (text: string) => {
      const written = await copyToClipboard(text)
      if (written) flash()
      return written
    },
    [flash],
  )
  return { copied, flash, copy }
}
