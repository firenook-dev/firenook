// A subscription's dead letters (S11): the dead-letter topic's messages
// that came from this subscription — the topic's message table, narrowed by
// the attributes the engine writes on each forwarded message and held to
// them — with how many deliveries each had, and the way back: publish it
// again to the source topic, from the composer, without the dead-letter
// attributes.

import { Button } from '@cloudflare/kumo'
import { ArrowSquareOutIcon, SkullIcon } from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import { ApiError } from '@/api/client'
import type { PubsubMessageRow } from '@/api/generated/messaging/PubsubMessageRow'
import type { PubsubSubscription } from '@/api/generated/messaging/PubsubSubscription'
import type { DataTableColumn } from '@/components/console/data-table'
import { EmptyState, QueryError } from '@/components/console/empty-state'
import type { SubscriptionStatus } from '@/lib/live/channel'
import { formatNumber } from '@/lib/format'
import { deadLetterExpression } from '../filters'
import { projectOf, shortName } from '../names'
import { topicQuery } from '../queries'
import { AttributeChips, type MessagesSearch, MESSAGE_COLUMNS, MessagesView } from './message-table'

/** The attribute the engine writes with how many deliveries the source made. */
const DELIVERY_COUNT = 'CloudPubSubDeadLetterSourceDeliveryCount'

/** The message's own attributes: the dead-letter ones have their column and the chip. */
function ownAttributes(attributes: { [key in string]: string }): { [key in string]: string } {
  return Object.fromEntries(
    Object.entries(attributes).filter(([key]) => !key.startsWith('CloudPubSubDeadLetter')),
  )
}

/** The topic's columns, with the source's delivery count after the id. */
export const DEAD_LETTER_COLUMNS: readonly DataTableColumn<PubsubMessageRow>[] = [
  ...MESSAGE_COLUMNS.slice(0, 2),
  {
    id: 'deliveries',
    header: 'Deliveries',
    width: 80,
    align: 'end',
    cell: (row) => {
      const count = row.attributes[DELIVERY_COUNT]
      return count === undefined ? <span className="text-kumo-inactive">—</span> : count
    },
    copy: (row) => row.attributes[DELIVERY_COUNT] ?? '',
  },
  ...MESSAGE_COLUMNS.slice(2).map((column) =>
    column.id === 'attributes'
      ? Object.assign({}, column, {
          cell: (row: PubsubMessageRow) => (
            <AttributeChips attributes={ownAttributes(row.attributes)} />
          ),
        })
      : column,
  ),
]

export function DeadLetters({
  project,
  subscription,
  config,
  search,
  update,
  onLiveStatus,
  onOpenSubscription,
  onOpenTopic,
  onPublishToSource,
}: {
  project: string
  /** The subscription's full name. */
  subscription: string
  config: PubsubSubscription
  search: MessagesSearch
  update: (patch: Partial<MessagesSearch>, options?: { replace?: boolean }) => void
  onLiveStatus: (status: SubscriptionStatus) => void
  onOpenSubscription: (name: string) => void
  onOpenTopic: (topic: string) => void
  /** Opens the composer on the source topic, filled with the dead letter. */
  onPublishToSource: (deadLetterTopic: string, id: string) => void
}) {
  const policy = config.deadLetter
  const deadTopic = policy?.topic ?? ''
  const detail = useQuery({ ...topicQuery(project, deadTopic), enabled: deadTopic !== '' })
  const id = shortName(subscription)
  const source = config.summary.topic
  if (!policy) return null
  const deadId = shortName(policy.topic)
  const missing = detail.error instanceof ApiError && detail.error.code === 'not-found'

  return (
    <>
      <p
        className="m-0 flex shrink-0 items-center gap-2 border-b border-kumo-hairline px-3 py-1.5 text-[12px] text-kumo-subtle"
        data-testid="pubsub-dead-letter-note"
      >
        <span>
          After {formatNumber(policy.maxDeliveryAttempts)} deliveries a message moves to{' '}
          <span className="font-mono text-kumo-default">{deadId}</span>.
        </span>
        <Button
          variant="ghost"
          size="xs"
          icon={<ArrowSquareOutIcon />}
          onClick={() => onOpenTopic(policy.topic)}
          className="ml-auto"
          data-testid="pubsub-open-dead-topic"
        >
          Open {deadId}
        </Button>
      </p>
      {missing ? (
        <EmptyState
          icon={SkullIcon}
          title={`${deadId} does not exist`}
          description={`Messages ${id} gives up on have nowhere to go, so the emulator keeps redelivering them. Create the topic, or change the dead-letter topic in Settings.`}
          testId="pubsub-dead-topic-missing"
        />
      ) : detail.isError ? (
        <QueryError error={detail.error} onRetry={() => void detail.refetch()} section="pubsub" />
      ) : (
        <MessagesView
          key={policy.topic}
          project={project}
          topic={policy.topic}
          detail={detail.data}
          search={search}
          update={update}
          onLiveStatus={onLiveStatus}
          onOpenSubscription={onOpenSubscription}
          fixedExpr={{
            expr: deadLetterExpression(id, projectOf(subscription, 'subscriptions') ?? project),
            chip: `from ${id}`,
          }}
          columns={DEAD_LETTER_COLUMNS}
          memoryKey="pubsub.dead-letters"
          {...(source
            ? {
                onEditAgain: (message: string) => onPublishToSource(policy.topic, message),
                againLabel: `Publish again to ${shortName(source)}`,
              }
            : {})}
          emptyState={
            <EmptyState
              icon={SkullIcon}
              title={`No dead letters from ${id}`}
              description={`A message ${id} delivers ${formatNumber(policy.maxDeliveryAttempts)} times without an ack moves to ${deadId}, and shows here.`}
              testId="pubsub-dead-letters-empty"
            />
          }
        />
      )}
    </>
  )
}
