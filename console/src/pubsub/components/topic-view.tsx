// One topic: row two is its tabs — Messages, Subscriptions, Deliveries,
// Settings — with how much it publishes at the right end (since
// start, the last minute's rate, and the bars, aged on the shared
// one-second clock so a topic that went quiet decays to zero by itself);
// below, the tab.

import { Button, Tabs } from '@cloudflare/kumo'
import { BroadcastIcon, PaperPlaneTiltIcon, PlusIcon } from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import { ApiError } from '@/api/client'
import type { PubsubFunctionMark } from '@/api/generated/messaging/PubsubFunctionMark'
import type { PubsubTopicDetail } from '@/api/generated/messaging/PubsubTopicDetail'
import type { PubsubTopicSummary } from '@/api/generated/messaging/PubsubTopicSummary'
import { EmptyState, QueryError } from '@/components/console/empty-state'
import { ToolbarRow } from '@/components/console/toolbar'
import { formatNumber } from '@/lib/format'
import type { SubscriptionStatus } from '@/lib/live/channel'
import { useThroughput } from '../live'
import { shortName } from '../names'
import { topicQuery } from '../queries'
import { Composer } from './composer'
import { DeliveriesView } from './deliveries-table'
import { JobStrip } from './job-strip'
import type { MessageTab } from './message-inspector'
import { type MessagesSearch, MessagesView } from './message-table'
import { SubscriptionsTable, subscriptionRows } from './subscriptions-table'
import type { SubscriptionViewName } from './subscription-view'
import { ThroughputBars, useLastMinute } from './throughput-bars'
import { TopicSettings } from './topic-settings'

export type TopicViewName = 'messages' | 'subscriptions' | 'deliveries' | 'settings'

export interface TopicSearch extends MessagesSearch {
  /** A topic's view, or a subscription's (the page's one parameter for both). */
  view?: TopicViewName | SubscriptionViewName | undefined
  tab?: MessageTab | undefined
  /** `message` opens the composer in the inspector's place. */
  new?: 'topic' | 'subscription' | 'message' | undefined
  /** With new=message: the message that fills the composer. */
  prefill?: string | undefined
  dialog?: 'setup' | 'export' | undefined
  /** Deliveries: one function's, by its id. */
  function?: string | undefined
  /** Deliveries: one outcome's. */
  outcome?: PubsubFunctionMark | undefined
}

/** The topic's tabs, in order; later commits add theirs here. */
export const TOPIC_VIEWS: readonly TopicViewName[] = [
  'messages',
  'subscriptions',
  'deliveries',
  'settings',
]

/** The view a `view` parameter names for a topic, or the first. */
export function topicView(view: string | undefined): TopicViewName {
  return (TOPIC_VIEWS as readonly string[]).includes(view ?? '')
    ? (view as TopicViewName)
    : 'messages'
}

/** Published since start, the last minute's rate, and the bars, aged while on screen. */
function Throughput({
  project,
  topic,
  detail,
  summary,
}: {
  project: string
  topic: string
  detail: PubsubTopicDetail | undefined
  summary: PubsubTopicSummary | undefined
}) {
  const window = useThroughput(project, topic) ?? detail?.throughput
  const minute = useLastMinute(window)
  const published = summary?.counters.published ?? detail?.summary.counters.published
  // Below xl the five tabs need the row: the landing's cards and the tree say the same.
  return (
    <span
      className="ml-auto hidden shrink-0 items-center gap-2 text-[12px] text-kumo-subtle xl:flex"
      data-testid="pubsub-topic-throughput"
    >
      {published !== undefined && (
        <span>
          <span
            className="font-mono text-[11px] text-kumo-default tabular-nums"
            data-testid="pubsub-topic-published"
          >
            {formatNumber(published)}
          </span>{' '}
          published ·{' '}
          <span className="font-mono text-[11px] tabular-nums">{formatNumber(minute.count)}</span>
          /min
        </span>
      )}
      <ThroughputBars bars={minute.bars} topicId={shortName(topic)} />
    </span>
  )
}

export function TopicView({
  project,
  topic,
  summary,
  search,
  update,
  onOpenSubscription,
  onCreateSubscription,
  onCreateTopic,
  onLiveStatus,
  onDeleted,
}: {
  project: string
  /** The topic's full name. */
  topic: string
  summary: PubsubTopicSummary | undefined
  search: TopicSearch
  update: (patch: Partial<TopicSearch>, options?: { replace?: boolean }) => void
  onOpenSubscription: (name: string) => void
  onCreateSubscription: () => void
  onCreateTopic: (id: string) => void
  onLiveStatus: (status: SubscriptionStatus) => void
  onDeleted: () => void
}) {
  const detail = useQuery(topicQuery(project, topic))
  const topicId = shortName(topic)
  const view = topicView(search.view)
  const missing = detail.error instanceof ApiError && detail.error.code === 'not-found'

  if (missing)
    return (
      <EmptyState
        icon={BroadcastIcon}
        title={`${topicId} does not exist`}
        description="It was deleted, or the link names a topic this run of the emulator never had."
        actions={
          <Button variant="primary" icon={<PlusIcon />} onClick={() => onCreateTopic(topicId)}>
            Create {topicId}
          </Button>
        }
        testId="pubsub-topic-missing"
      />
    )

  const rows = subscriptionRows(detail.data?.subscriptions ?? [], summary)
  const functions = summary?.functions ?? detail.data?.summary.functions ?? []
  // Publishing again, edited first: the composer filled with the message.
  const editAgain = (id: string) =>
    update({ new: 'message', prefill: id, message: undefined, tab: undefined })
  const openComposer = () =>
    update({ new: 'message', prefill: undefined, message: undefined, tab: undefined })
  return (
    <>
      <ToolbarRow variant="line" testId="pubsub-topic-tabs">
        <Tabs
          variant="underline"
          size="sm"
          value={view}
          onValueChange={(next) =>
            update({
              view: next === 'messages' ? undefined : (next as TopicViewName),
              message: undefined,
              tab: undefined,
              function: undefined,
              outcome: undefined,
            })
          }
          tabs={[
            { value: 'messages', label: 'Messages' },
            {
              value: 'subscriptions',
              label: (
                <span>
                  Subscriptions{' '}
                  <span className="font-mono text-[11px] text-kumo-subtle">
                    {formatNumber(rows.length)}
                  </span>
                </span>
              ),
            },
            { value: 'deliveries', label: 'Deliveries' },
            { value: 'settings', label: 'Settings' },
          ]}
        />
        {view === 'subscriptions' ? (
          <span className="ml-auto flex shrink-0 items-center">
            <Button
              variant="secondary"
              size="sm"
              icon={<PlusIcon />}
              onClick={onCreateSubscription}
              data-testid="pubsub-new-subscription"
            >
              New subscription
            </Button>
          </span>
        ) : (
          <Throughput project={project} topic={topic} detail={detail.data} summary={summary} />
        )}
      </ToolbarRow>
      {detail.isError && !missing ? (
        <QueryError error={detail.error} onRetry={() => void detail.refetch()} section="pubsub" />
      ) : view === 'messages' ? (
        <MessagesView
          key={topic}
          project={project}
          topic={topic}
          detail={detail.data}
          search={search}
          update={update}
          onLiveStatus={onLiveStatus}
          empty={
            <Button
              variant="primary"
              icon={<PaperPlaneTiltIcon />}
              onClick={openComposer}
              data-testid="pubsub-empty-publish"
            >
              Publish a message
            </Button>
          }
          onOpenSubscription={onOpenSubscription}
          composer={
            search.new === 'message' ? (
              <Composer
                project={project}
                topic={topic}
                detail={detail.data}
                summary={summary}
                prefill={search.prefill}
                onClose={() => update({ new: undefined, prefill: undefined })}
                onOpenMessage={(id) => update({ new: undefined, prefill: undefined, message: id })}
              />
            ) : undefined
          }
          onEditAgain={editAgain}
          above={<JobStrip />}
          exportOpen={search.dialog === 'export'}
          onExportOpenChange={(open) =>
            update({ dialog: open ? 'export' : undefined }, { replace: !open })
          }
        />
      ) : view === 'deliveries' ? (
        <DeliveriesView
          project={project}
          topic={topic}
          functions={functions}
          search={search}
          update={update}
          onLiveStatus={onLiveStatus}
          onOpenSubscription={onOpenSubscription}
          onEditAgain={(id) =>
            update({
              view: undefined,
              new: 'message',
              prefill: id,
              message: undefined,
              tab: undefined,
              function: undefined,
              outcome: undefined,
            })
          }
        />
      ) : view === 'subscriptions' ? (
        <SubscriptionsTable
          topicId={topicId}
          rows={rows}
          loading={detail.isPending}
          onOpen={onOpenSubscription}
          onCreate={onCreateSubscription}
        />
      ) : detail.data ? (
        <TopicSettings key={topic} project={project} detail={detail.data} onDeleted={onDeleted} />
      ) : null}
    </>
  )
}
