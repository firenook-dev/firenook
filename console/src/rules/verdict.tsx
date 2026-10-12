// A rules verdict as every list on a rules page writes it: the kit's dot and
// a word — allowed, denied, error — with the outcome on the element, so a
// journey can read it whatever the word.

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
