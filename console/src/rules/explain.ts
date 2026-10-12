// Which of the values an evaluation saw to write into the editor.
//
// The engine reports a value for every expression it evaluated, and a
// rules condition nests deeply: `request.auth.uid == uid` is `request`,
// `request.auth`, `request.auth.uid`, `uid` and the comparison. Written
// after every one of them the line becomes unreadable. A debugger's rule
// fits: show the value of each whole operand — the longest member chain,
// not its prefixes — and of each comparison and connective, so the line
// reads `request.auth.uid ⟨null⟩ == uid ⟨"u_k65eq"⟩ ⟨false⟩`.

import type { CodeInlineValue } from '@/components/code-editor'

export interface Step {
  from: number
  to: number
  value: string
  error: boolean
}

/** Whether the text after a span continues it as a member access, an index or a call. */
function continues(source: string, at: number): boolean {
  const next = source.slice(at).trimStart()[0]
  return next === '.' || next === '[' || next === '('
}

/**
 * The steps worth writing inline: for each span the last value it had
 * (a function called twice shows its latest), without the prefixes of a
 * member chain whose longer form was also evaluated.
 */
export function inlineSteps(steps: readonly Step[], source: string): CodeInlineValue[] {
  const last = new Map<string, Step>()
  for (const step of steps) last.set(`${step.from}:${step.to}`, step)
  const spans = [...last.values()]
  return spans
    .filter(
      (step) =>
        // A prefix of a longer evaluated chain from the same start says
        // less than the chain does.
        !(
          continues(source, step.to) &&
          spans.some((other) => other.from === step.from && other.to > step.to)
        ),
    )
    .map((step) => ({ from: step.from, to: step.to, value: step.value, error: step.error }))
}
