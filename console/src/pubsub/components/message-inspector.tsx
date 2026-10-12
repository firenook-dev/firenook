// One message, whole: its data as what it is (a JSON tree, text, or the hex
// of bytes), its attributes with the ones the engine wrote explained (the
// schema it was checked against, the subscription it was dead-lettered
// from), and what became of it at every subscription and function — the
// state, the attempts, the lease, the filter that kept it out, the
// function's outcome with the handler's own error, and the way to the
// invocation and its logs.

import { Text } from '@cloudflare/kumo'
import { TrayIcon } from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { ApiError } from '@/api/client'
import type { PubsubDeliveryRow } from '@/api/generated/messaging/PubsubDeliveryRow'
import type { PubsubMessageAtSubscription } from '@/api/generated/messaging/PubsubMessageAtSubscription'
import type { PubsubPushStreak } from '@/api/generated/messaging/PubsubPushStreak'
import { EmptyState } from '@/components/console/empty-state'
import { EntityLink } from '@/components/console/entity-link'
import { Inspector, InspectorSection, InspectorTitle } from '@/components/console/inspector'
import { KeyValueList, type KeyValueItem } from '@/components/console/key-value-list'
import { OutcomeChip } from '@/components/console/outcome-chip'
import { PayloadView } from '@/components/console/payload-view'
import { RelativeTime, exactTime } from '@/components/console/relative-time'
import { StatusDot } from '@/components/kit'
import { useNow } from '@/lib/clock'
import { formatBytes, formatDuration, formatNumber } from '@/lib/format'
import { linkToLogs } from '@/lib/sections/logs'
import { sectionById } from '@/lib/services'
import { shortName } from '../names'
import { messageQuery } from '../queries'
import { MessageFooter } from './message-footer'
import { atSubscriptionText, deliveryDetail, functionMark, subscriptionTone } from '../states'

export type MessageTab = 'data' | 'attributes' | 'deliveries'

/** Attributes the engine wrote, explained in their own sections rather than listed raw. */
function engineAttribute(key: string): boolean {
  return key.startsWith('googclient_') || key.startsWith('CloudPubSubDeadLetter')
}

/** A link to the Logs page, filtered, once Logs is built; nothing before. */
export function LogsLink({
  filter,
  children,
  testId,
}: {
  filter: Parameters<typeof linkToLogs>[0]
  children: ReactNode
  testId?: string | undefined
}) {
  if (!sectionById('logs')?.built) return null
  const link = linkToLogs(filter)
  return (
    <Link
      to={link.to as never}
      search={link.search as never}
      className="text-[12px] text-kumo-link underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none"
      data-testid={testId}
    >
      {children}
    </Link>
  )
}

/** One function's delivery of the message: the outcome, how long, the handler's error, the links. */
export function FunctionDelivery({ row, testId }: { row: PubsubDeliveryRow; testId?: string }) {
  const look = functionMark(row.mark)
  const detail = deliveryDetail(row)
  return (
    <div className="grid gap-1 py-1.5" data-testid={testId} data-mark={row.mark}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <EntityLink entity={{ ...row.functionRef, label: row.functionName }} />
        <OutcomeChip
          word={look.word}
          tone={look.tone}
          pulse={row.mark === 'running'}
          {...(detail ? { detail } : {})}
        />
        {row.durationMs !== null && (
          <span className="font-mono text-[12px] text-kumo-subtle tabular-nums">
            {formatDuration(row.durationMs)}
          </span>
        )}
        {row.status !== null && (
          <span className="font-mono text-[12px] text-kumo-subtle tabular-nums">{row.status}</span>
        )}
        {row.redelivery && (
          <span className="rounded bg-kumo-tint px-1 text-[11px] text-kumo-subtle">run again</span>
        )}
      </div>
      {detail && row.mark !== 'delivered' && (
        <p
          className={`m-0 font-mono text-[12px] [overflow-wrap:anywhere] ${row.mark === 'failed' ? 'text-kumo-danger' : 'text-kumo-subtle'}`}
          data-testid={testId && `${testId}-detail`}
        >
          {detail}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        {row.invocation && (
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="text-[12px] text-kumo-subtle">Invocation</span>
            <EntityLink entity={row.invocation} testId={testId && `${testId}-invocation`} />
          </span>
        )}
        <LogsLink
          filter={{
            function: row.functionId,
            ...(row.invocation ? { execution: row.invocation.key } : {}),
          }}
          testId={testId && `${testId}-logs`}
        >
          Logs
        </LogsLink>
      </div>
    </div>
  )
}

function PushStreakLine({ streak }: { streak: PubsubPushStreak }) {
  const ok = streak.status !== null && streak.status >= 200 && streak.status < 300
  const word = streak.status !== null ? String(streak.status) : (streak.error ?? 'error')
  return (
    <div className="flex min-w-0 items-center gap-2 text-[12px]" data-testid="message-push-streak">
      <StatusDot tone={ok ? 'success' : 'danger'} label={word} className="font-mono" />
      {streak.count > 1 && (
        <span className="font-mono text-kumo-subtle tabular-nums">
          ×{formatNumber(streak.count)}
        </span>
      )}
      <span className="font-mono text-kumo-subtle tabular-nums">
        {formatDuration(streak.latencyMs)}
      </span>
      <RelativeTime iso={streak.lastAt} className="text-kumo-subtle" />
    </div>
  )
}

function SubscriptionDelivery({
  at,
  push,
  onOpenSubscription,
}: {
  at: PubsubMessageAtSubscription
  push: readonly PubsubPushStreak[]
  onOpenSubscription: (name: string) => void
}) {
  // A lease counts down to the second, here only: the payload beside it does not re-render.
  const now = useNow('second')
  return (
    <div className="grid gap-1 py-1.5" data-testid="message-at-subscription" data-state={at.state}>
      <div className="flex min-w-0 items-center gap-3">
        <button
          type="button"
          onClick={() => onOpenSubscription(at.subscription)}
          className="min-w-0 truncate rounded-sm font-mono text-[12px] text-kumo-link underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none"
          title={at.subscription}
        >
          {shortName(at.subscription)}
        </button>
        <StatusDot tone={subscriptionTone(at.state)} label={at.state} />
      </div>
      <p className="m-0 text-[13px] text-kumo-subtle">{atSubscriptionText(at, now)}</p>
      {push.map((streak) => (
        <PushStreakLine key={streak.streak} streak={streak} />
      ))}
    </div>
  )
}

export function MessageInspector({
  project,
  topic,
  id,
  tab,
  onTab,
  onClose,
  onPrev,
  onNext,
  onOpenSubscription,
  top,
  onEditAgain,
}: {
  project: string
  topic: string
  id: string
  tab: MessageTab | undefined
  onTab: (tab: MessageTab) => void
  onClose: () => void
  onPrev?: (() => void) | undefined
  onNext?: (() => void) | undefined
  onOpenSubscription: (name: string) => void
  /** What the message is at the subscription in view (backlog, pull), above the tabs' content. */
  top?: ReactNode
  /** Opens the composer filled with this message; with it, the footer offers Code and Publish again. */
  onEditAgain?: ((id: string) => void) | undefined
}) {
  const query = useQuery(messageQuery(project, topic, id))
  const message = query.data
  const gone = query.error instanceof ApiError && query.error.code === 'not-found'
  const shown = tab ?? 'data'

  const plain = message
    ? Object.entries(message.attributes).filter(([key]) => !engineAttribute(key))
    : []
  const deliveries = message ? message.subscriptions.length + message.functions.length : undefined

  return (
    <Inspector
      widthKey="pubsub.message"
      title={<InspectorTitle value={id} />}
      meta={
        message ? (
          <>
            <span className="font-mono">{formatBytes(message.size)}</span>
            <span aria-hidden>·</span>
            <RelativeTime iso={message.publishTime} />
          </>
        ) : undefined
      }
      onClose={onClose}
      closeLabel="Close the message"
      noun="message"
      onPrev={onPrev}
      onNext={onNext}
      tabs={
        message
          ? {
              items: [
                { value: 'data', label: 'Data' },
                {
                  value: 'attributes',
                  label: 'Attributes',
                  count: Object.keys(message.attributes).length,
                },
                { value: 'deliveries', label: 'Deliveries', count: deliveries },
              ],
              value: shown,
              onChange: (value) => onTab(value as MessageTab),
            }
          : undefined
      }
      footer={
        message && onEditAgain ? (
          <MessageFooter message={message} onEditAgain={() => onEditAgain(message.id)} />
        ) : undefined
      }
      testId="pubsub-message-inspector"
    >
      {gone ? (
        <EmptyState
          icon={TrayIcon}
          title="This message is no longer kept"
          description="The engine keeps the newest messages of each topic; this one has gone from the console's history. It may still wait in a subscription's backlog."
          testId="pubsub-message-gone"
        />
      ) : !message ? (
        query.isError ? (
          <div className="px-5 py-3">
            <Text variant="error" size="sm">
              {query.error instanceof Error
                ? query.error.message
                : 'The message could not be read.'}
            </Text>
          </div>
        ) : null
      ) : (
        <>
          {top}
          {shown === 'data' && (
            <PayloadView
              base64={message.dataBase64}
              filename={`message-${message.id}.bin`}
              testId="pubsub-message-data"
            />
          )}
          {shown === 'attributes' && (
            <>
              <InspectorSection
                title="Attributes"
                count={plain.length + (message.orderingKey ? 1 : 0)}
              >
                <KeyValueList
                  items={[
                    ...(message.orderingKey
                      ? [
                          {
                            label: 'Ordering key',
                            value: message.orderingKey,
                            copy: message.orderingKey,
                            testId: 'message-ordering-key',
                          } satisfies KeyValueItem,
                        ]
                      : []),
                    ...plain.map(([key, value]): KeyValueItem => ({
                      label: key,
                      value,
                      copy: value,
                      testId: `message-attribute-${key}`,
                    })),
                  ]}
                  testId="pubsub-message-attributes"
                />
              </InspectorSection>
              {message.schema && (
                <InspectorSection title="Schema" testId="message-schema">
                  <p className="m-0 mb-1 text-[13px] text-kumo-subtle">
                    The topic checked this message against its schema when it was published.
                  </p>
                  <KeyValueList
                    items={[
                      {
                        label: 'Schema',
                        value: (
                          <EntityLink
                            entity={{
                              kind: 'pubsub.schema',
                              key: message.schema.schema,
                              label: shortName(message.schema.schema),
                            }}
                          />
                        ),
                        copy: message.schema.schema,
                      },
                      {
                        label: 'Revision',
                        value: message.schema.revisionId,
                        copy: message.schema.revisionId,
                      },
                      { label: 'Encoding', value: message.schema.encoding },
                    ]}
                  />
                </InspectorSection>
              )}
              {message.deadLetterSource && (
                <InspectorSection title="Dead-lettered from" testId="message-dead-letter">
                  <KeyValueList
                    items={[
                      {
                        label: 'Subscription',
                        value: (
                          <button
                            type="button"
                            onClick={() =>
                              onOpenSubscription(
                                `projects/${message.deadLetterSource?.project ?? ''}/subscriptions/${message.deadLetterSource?.subscription ?? ''}`,
                              )
                            }
                            className="rounded-sm text-left font-mono text-[12px] text-kumo-link underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none"
                            data-testid="message-dead-letter-source"
                          >
                            {message.deadLetterSource.subscription}
                          </button>
                        ),
                        copy: message.deadLetterSource.subscription,
                      },
                      { label: 'Project', value: message.deadLetterSource.project },
                      {
                        label: 'Deliveries before',
                        value: formatNumber(message.deadLetterSource.deliveryCount),
                      },
                      {
                        label: 'First published',
                        value: <RelativeTime iso={message.deadLetterSource.originalPublishTime} />,
                        mono: false,
                        hint: exactTime(message.deadLetterSource.originalPublishTime),
                      },
                    ]}
                  />
                </InspectorSection>
              )}
            </>
          )}
          {shown === 'deliveries' && (
            <>
              <InspectorSection
                title="Subscriptions"
                count={message.subscriptions.length}
                testId="message-subscriptions"
              >
                <div className="grid divide-y divide-kumo-hairline">
                  {message.subscriptions.map((at) => (
                    <SubscriptionDelivery
                      key={at.subscription}
                      at={at}
                      push={message.push.filter(
                        (streak) => streak.subscription === at.subscription,
                      )}
                      onOpenSubscription={onOpenSubscription}
                    />
                  ))}
                </div>
              </InspectorSection>
              <InspectorSection
                title="Functions"
                count={message.functions.length}
                testId="message-functions"
              >
                <div className="grid divide-y divide-kumo-hairline">
                  {message.functions.map((row) => (
                    <FunctionDelivery key={row.eventId} row={row} testId="message-function" />
                  ))}
                </div>
              </InspectorSection>
            </>
          )}
        </>
      )}
    </Inspector>
  )
}
