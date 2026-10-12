// The message inspector's foot: Code on the left — this published message
// as the call that would publish it again, in Node, curl and gcloud, with
// its real bytes and attributes and the engine's own address — and Publish
// again on the right, which opens the composer filled with it.

import { Button, Popover, Text, Tooltip } from '@cloudflare/kumo'
import { CodeIcon, PaperPlaneTiltIcon } from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import type { PubsubMessageDetail } from '@/api/generated/messaging/PubsubMessageDetail'
import { statusQuery } from '@/api/queries'
import { CodeBlock } from '@/components/console/code-block'
import { InspectorFooter, useInspectorRoom } from '@/components/console/inspector'
import { describeAddress, serviceAddress } from '@/components/console/request/address'
import { CODE_DIALECTS, type CodeDialect, messageAsCode } from '../code'

export function MessageCode({ message }: { message: PubsubMessageDetail }) {
  const status = useQuery(statusQuery)
  const address = serviceAddress('pubsub', status.data)
  const [dialect, setDialect] = useState<CodeDialect>('node')
  const { labels } = useInspectorRoom()
  const trigger = labels ? (
    <Button
      variant="ghost"
      size="sm"
      icon={<CodeIcon />}
      disabled={!address}
      data-testid="message-code"
    >
      Code
    </Button>
  ) : (
    <Button
      variant="ghost"
      size="sm"
      shape="square"
      icon={<CodeIcon />}
      aria-label="Code"
      disabled={!address}
      data-testid="message-code"
    />
  )
  return (
    <Popover>
      <Tooltip
        content="This message as the call that publishes it"
        render={<Popover.Trigger render={trigger} />}
      />
      <Popover.Content className="w-[560px] max-w-[calc(100vw-2rem)]">
        {address && (
          <div className="grid gap-2" data-testid="message-code-popover">
            <CodeBlock
              label="This message as code"
              value={dialect}
              onValueChange={(id) => setDialect(id as CodeDialect)}
              dialects={CODE_DIALECTS.map((item) => ({
                id: item.id,
                label: item.label,
                code: messageAsCode(message, item.id, address.origin),
              }))}
              testId="message-code-block"
            />
            <Text size="xs" variant="secondary">
              Sent to the Pub/Sub port at {describeAddress(address)}, not the console.
            </Text>
          </div>
        )}
      </Popover.Content>
    </Popover>
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
