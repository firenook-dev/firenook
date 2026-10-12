// "Run onOrderPlaced again with message 1187" (PS-63): the message goes to
// that one function again under a fresh event id — the emulator drops a
// repeated id — and to nothing else: no subscription and no other function
// receives it twice, and the topic's message count stays as it was. It
// runs the function's code, so it asks first, beside the row or the button
// that asked.

import { useQueryClient } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { PubsubDeliveryRow } from '@/api/generated/messaging/PubsubDeliveryRow'
import { toast } from '@/lib/toasts'
import { useConfirmPopover } from '@/messaging/confirm-popover'
import { redeliver } from '../api'
import { pubsubKeys } from '../queries'

export type RunAgainSubject = Pick<PubsubDeliveryRow, 'messageId' | 'functionId' | 'functionName'>

/** The confirmation's words, from the delivery it runs again. */
export function runAgainText(row: RunAgainSubject): { title: string; description: string } {
  return {
    title: `Run ${row.functionName} again with message ${row.messageId}?`,
    description: `It runs your function’s code with a new event id. No subscription and no other function receives the message again.`,
  }
}

/**
 * The run-again confirmation for one topic's deliveries: `ask(row, anchor)`
 * opens it beside `anchor`; `element` is mounted once by the page.
 */
export function useRunAgain(
  project: string,
  topic: string,
): { ask: (row: RunAgainSubject, anchor: Element | null) => void; element: ReactNode } {
  const queryClient = useQueryClient()
  const confirm = useConfirmPopover()
  return {
    ask: (row, anchor) => {
      const text = runAgainText(row)
      confirm.ask({
        ...text,
        confirm: 'Run again',
        anchor,
        testId: 'pubsub-run-again',
        run: async () => {
          const answer = await redeliver({
            topic,
            messageId: row.messageId,
            functionId: row.functionId,
          })
          // The message's deliveries gain a row; the live topic names it too,
          // but the inspector open on it should not wait for the event.
          void queryClient.invalidateQueries({
            queryKey: pubsubKeys.message(project, topic, row.messageId),
          })
          toast({
            key: `pubsub-run-again-${row.messageId}-${row.functionId}`,
            title: `Running ${row.functionName} again with message ${row.messageId}`,
            description: `Event ${answer.eventId}`,
            tone: 'success',
          })
        },
      })
    },
    element: confirm.element,
  }
}
