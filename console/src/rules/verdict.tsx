// A rules verdict as every list on a rules page writes it: the kit's dot and
// a word — allowed, denied, error — with the outcome on the element, so a
// journey can read it whatever the word.

import type { ReactNode } from 'react'
import type { RulesOutcome } from '@/api/generated/RulesOutcome'
import { StatusDot, type StatusTone } from '@/components/kit/status-dot'

const WORD: Record<RulesOutcome, string> = { allow: 'allowed', deny: 'denied', error: 'error' }
const TONE: Record<RulesOutcome, StatusTone> = {
  allow: 'success',
  deny: 'danger',
  error: 'warning',
}

export function Verdict({ outcome }: { outcome: RulesOutcome }) {
  return (
    <span className="contents" data-outcome={outcome}>
      <StatusDot tone={TONE[outcome]} label={WORD[outcome]} />
    </span>
  )
}

/**
 * A playground's answer: the verdict, then the request it judged, whole. A
 * result is read rather than scanned, so a long path or identity wraps
 * (between words first) instead of running past the panel or hiding behind
 * an ellipsis; `action` sits at the end of the first line.
 */
export function VerdictLine({
  outcome,
  request,
  action,
}: {
  outcome: RulesOutcome
  request: string
  action?: ReactNode
}) {
  return (
    <div className="flex min-w-0 items-start gap-2" data-testid="playground-verdict">
      <span className="flex h-5 shrink-0 items-center">
        <Verdict outcome={outcome} />
      </span>
      <span className="min-w-0 flex-1 font-mono text-[12px] leading-5 wrap-anywhere text-kumo-subtle">
        {request}
      </span>
      {action}
    </div>
  )
}
