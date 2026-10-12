// What a panel beside the editor draws into it: the lines a decision or a
// playground run went through, and the values its expressions had. One at
// a time — the latest panel to speak — and only over the text it is
// about: line numbers and offsets mean nothing against another one.

import { create } from 'zustand'
import type { CodeInlineValue, CodeLineMark } from '@/components/code-editor'

export interface EditorOverlay {
  owner: 'decision' | 'playground' | 'test'
  /** The rules text the marks refer to. */
  source: string
  lineMarks: CodeLineMark[]
  values: CodeInlineValue[]
  /** The line to bring into view when the overlay appears. */
  reveal?: number | undefined
  /** When it was shown, so the page knows whether it or a click came last. */
  at?: number | undefined
}

interface OverlayState {
  overlay: EditorOverlay | undefined
  show: (overlay: EditorOverlay) => void
  /** Withdraw an owner's overlay; another owner's stays. */
  clear: (owner: EditorOverlay['owner']) => void
}

export const useOverlay = create<OverlayState>((set) => ({
  overlay: undefined,
  show: (overlay) => set({ overlay: { ...overlay, at: Date.now() } }),
  clear: (owner) =>
    set((state) => (state.overlay?.owner === owner ? { overlay: undefined } : state)),
}))

/** The lines an evaluation ran, toned by whether each decided it. */
export function linesFromAllows(
  allows: ReadonlyArray<{ line: number; outcome: 'allow' | 'deny' | 'error' }>,
  verdict: 'allow' | 'deny' | 'error',
): CodeLineMark[] {
  const out = new Map<number, CodeLineMark>()
  for (const allow of allows) {
    const deciding = verdict === 'allow' ? allow.outcome === 'allow' : allow.outcome !== 'allow'
    const tone: CodeLineMark['tone'] = !deciding
      ? 'focus'
      : allow.outcome === 'allow'
        ? 'allow'
        : allow.outcome === 'error'
          ? 'error'
          : 'deny'
    const known = out.get(allow.line)
    // A line that decided it wins over the same line merely running.
    if (!known || known.tone === 'focus') out.set(allow.line, { line: allow.line, tone })
  }
  return [...out.values()]
}
