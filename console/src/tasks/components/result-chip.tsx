// What a task's last attempt answered, in a list cell: the status as data
// (2xx success, anything else danger), or the word for a request that got
// no answer (`refused`, `timed out`, `invalid URL`) with the error behind it.

import { OutcomeChip } from '@/components/console/outcome-chip'
import { lastResult } from '../states'

export function ResultChip({ status, error }: { status: number | null; error: string | null }) {
  const result = lastResult(status, error)
  if (!result) return <span className="text-kumo-inactive">—</span>
  return (
    <span className="font-sans">
      <OutcomeChip
        word={result.word}
        tone={result.tone}
        mono={result.mono}
        detail={result.detail}
        testId="task-result"
      />
    </span>
  )
}
