// A delivery's outcome to a function as a chip: how it went in the
// Functions emulator's own record of invocations, the dot breathing while
// it runs. A schedule's run says how its tick's delivery went with it.

import type { PubsubDeliveryRow } from '@/api/generated/messaging/PubsubDeliveryRow'
import { OutcomeChip } from '@/components/console/outcome-chip'
import { deliveryDetail, functionMark } from '../states'

export function DeliveryOutcome({ row }: { row: PubsubDeliveryRow }) {
  const look = functionMark(row.mark)
  const detail = deliveryDetail(row)
  // A word, not data: the sans face, as the backlog's states are.
  return (
    <span className="inline-flex align-middle font-sans">
      <OutcomeChip
        word={look.word}
        tone={look.tone}
        pulse={row.mark === 'running'}
        {...(detail && row.mark !== 'failed' ? { detail } : {})}
      />
    </span>
  )
}
