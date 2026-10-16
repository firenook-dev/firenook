// The message inspector's foot: Code on the left — this published message
// as the call that would publish it again, in Node, curl and gcloud, with
// its real bytes and attributes and the engine's own address — and Publish
// again on the right, which opens the composer filled with it.

import { Button, Tooltip } from '@cloudflare/kumo'
import { PaperPlaneTiltIcon } from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import type { PubsubMessageDetail } from '@/api/generated/messaging/PubsubMessageDetail'
import { statusQuery } from '@/api/queries'
import { CodePopover } from '@/components/console/code-popover'
import { InspectorFooter, useInspectorRoom } from '@/components/console/inspector'
import { describeAddress, serviceAddress } from '@/components/console/request/address'
import { codeTab } from '@/components/console/request/as-code'
import { MESSAGE_DIALECTS, messageAsCode } from '../code'

export function MessageCode({ message }: { message: PubsubMessageDetail }) {
  const status = useQuery(statusQuery)
  const address = serviceAddress('pubsub', status.data)
  const { labels } = useInspectorRoom()
  return (
    <CodePopover
      title="This message as code"
      tabs={
        address
          ? MESSAGE_DIALECTS.map((id) => codeTab(id, messageAsCode(message, id, address.origin)))
          : []
      }
      kind="pubsub.message"
      note={
        address
          ? `Sent to the Pub/Sub port at ${describeAddress(address)}, not the console.`
          : undefined
      }
      label={labels}
      disabled={!address}
      testId="message-code"
    />
  )
}

export function MessageFooter({
  message,
  onEditAgain,
  againLabel = 'Publish again',
}: {
  message: PubsubMessageDetail
  /** Opens the composer filled with this message. */
  onEditAgain: () => void
  /** The button's words: "Publish again to orders" when the composer opens on another topic. */
  againLabel?: string
}) {
  return (
    <InspectorFooter
      tools={<MessageCode message={message} />}
      primary={
        <Tooltip
          content="Fill the composer with this message, to publish it again or edit it first (Shift+R)"
          render={
            <Button
              variant="secondary"
              size="sm"
              icon={<PaperPlaneTiltIcon />}
              onClick={onEditAgain}
              data-testid="message-publish-again"
            >
              {againLabel}
            </Button>
          }
        />
      }
      testId="pubsub-message-footer"
    />
  )
}
