// A subscription in view: its tabs, each with its body and row two's end —
// Backlog (read without leasing, with the state switch), Push (the
// attempts, live) for a push subscription, Dead letters with a policy. The Push feed's
// store lives here, so the pause button at row two's end and the feed below
// read the same rows.

import { useQuery } from '@tanstack/react-query'
import { type ReactNode, useEffect } from 'react'
import type { PubsubPushStreak } from '@/api/generated/messaging/PubsubPushStreak'
import type { PubsubSubscription } from '@/api/generated/messaging/PubsubSubscription'
import type { PubsubSubscriptionSummary } from '@/api/generated/messaging/PubsubSubscriptionSummary'
import type { PubsubTopicSummary } from '@/api/generated/messaging/PubsubTopicSummary'
import type { SubscriptionStatus } from '@/lib/live/channel'
import type { FeedStore } from '@/lib/live/feed-store'
import type { PubsubSearch } from '@/routes/pubsub'
import { usePushFeed } from '../live'
import { shortName } from '../names'
import { subscriptionQuery } from '../queries'
import { BacklogSwitch, BacklogView } from './backlog-table'
import { DeadLetters } from './dead-letters'
import { MessageInspector } from './message-inspector'
import { PushEnd, PushFeed } from './push-feed'
import { SubscriptionState } from './subscription-state'
import {
  type SubscriptionViewName,
  SubscriptionView,
  resolveSubscriptionView,
} from './subscription-view'

/** The tabs this page offers besides Settings (Push and Dead letters only where they apply). */
const TABS: readonly SubscriptionViewName[] = ['backlog', 'push', 'dead-letters']

interface TabContext {
  project: string
  subscription: string
  config: PubsubSubscription
  summary: PubsubSubscriptionSummary | undefined
  search: PubsubSearch
  update: (patch: Partial<PubsubSearch>, options?: { replace?: boolean }) => void
  pushStore: FeedStore<PubsubPushStreak>
  onOpenTopic: (topic: string) => void
  onOpenSubscription: (name: string) => void
  onPublishTo: (topic: string, prefill: string) => void
  onLiveStatus: (status: SubscriptionStatus) => void
}

/** One tab's body and row two's end. */
function tabContent(
  view: SubscriptionViewName,
  context: TabContext,
): { body?: ReactNode; end?: ReactNode } {
  const { project, subscription, config, search, update } = context
  const counters = context.summary?.counters ?? config.summary.counters
  const source = config.summary.topic
  const openMessage = (id: string | undefined, options?: { replace?: boolean }) =>
    update({ message: id, tab: undefined }, options)
  const onTab = (tab: PubsubSearch['tab']) =>
    update({ tab: tab === 'data' ? undefined : tab }, { replace: true })
  switch (view) {
    case 'backlog':
      return {
        body: (
          <BacklogView
            key={`${subscription}|${search.state ?? ''}`}
            project={project}
            subscription={subscription}
            topic={source}
            config={config}
            counters={counters}
            state={search.state}
            message={search.message}
            tab={search.tab}
            onMessage={openMessage}
            onTab={onTab}
            onLiveStatus={context.onLiveStatus}
            onOpenSubscription={context.onOpenSubscription}
          />
        ),
        end: (
          <BacklogSwitch
            config={config}
            counters={counters}
            state={search.state}
            onState={(state) =>
              update({ state, message: undefined, tab: undefined }, { replace: true })
            }
          />
        ),
      }
    case 'push':
      return {
        body: (
          <div className="relative flex min-h-0 flex-1">
            <PushFeed
              store={context.pushStore}
              subscriptionId={shortName(subscription)}
              follow={!search.paused}
              onFollowChange={(follow) =>
                update({ paused: !follow || undefined }, { replace: true })
              }
              selected={search.message}
              onOpenMessage={(id) => openMessage(id, { replace: search.message !== undefined })}
            />
            {source !== null && search.message !== undefined && (
              <MessageInspector
                project={project}
                topic={source}
                id={search.message}
                tab={search.tab}
                onTab={onTab}
                onClose={() => openMessage(undefined)}
                onOpenSubscription={context.onOpenSubscription}
                top={
                  <SubscriptionState
                    project={project}
                    topic={source}
                    subscription={subscription}
                    id={search.message}
                    row={undefined}
                    maxDeliveries={config.deadLetter?.maxDeliveryAttempts}
                  />
                }
              />
            )}
          </div>
        ),
        end: config.pushEndpoint ? (
          <PushEnd
            project={project}
            subscription={subscription}
            endpoint={config.pushEndpoint}
            store={context.pushStore}
            paused={search.paused === true}
            onPausedChange={(paused) => update({ paused: paused || undefined }, { replace: true })}
          />
        ) : undefined,
      }
    case 'dead-letters':
      return {
        body: (
          <DeadLetters
            project={project}
            subscription={subscription}
            config={config}
            search={search}
            update={update}
            onLiveStatus={context.onLiveStatus}
            onOpenSubscription={context.onOpenSubscription}
            onOpenTopic={context.onOpenTopic}
            onPublishToSource={(deadTopic, id) => {
              if (source) context.onPublishTo(source, `${deadTopic}|${id}`)
            }}
          />
        ),
      }
    case 'settings':
      return {}
  }
}

export function SubscriptionPage({
  project,
  subscription,
  summary,
  topic,
  topics,
  search,
  update,
  onOpenTopic,
  onOpenSubscription,
  onPublishTo,
  onLiveStatus,
  onDeleted,
}: {
  project: string
  /** The subscription's full name. */
  subscription: string
  /** Its live figures from the topics index, when the index has it. */
  summary: PubsubSubscriptionSummary | undefined
  topic: PubsubTopicSummary | undefined
  topics: readonly string[]
  search: PubsubSearch
  update: (patch: Partial<PubsubSearch>, options?: { replace?: boolean }) => void
  onOpenTopic: (topic: string) => void
  onOpenSubscription: (name: string) => void
  /** Opens the composer on `topic`, filled with a message (`<topic>|<id>`). */
  onPublishTo: (topic: string, prefill: string) => void
  onLiveStatus: (status: SubscriptionStatus) => void
  onDeleted: () => void
}) {
  // The same query the view reads: answered from the cache.
  const detail = useQuery(subscriptionQuery(project, subscription))
  const { view } = resolveSubscriptionView(detail.data, search.view, TABS)
  const pushing = view === 'push'
  const push = usePushFeed(project || undefined, pushing ? subscription : undefined)
  useEffect(() => {
    if (pushing) onLiveStatus(push.status)
  }, [pushing, push.status, onLiveStatus])

  const content = detail.data
    ? tabContent(view, {
        project,
        subscription,
        config: detail.data.subscription,
        summary,
        search,
        update,
        pushStore: push.store,
        onOpenTopic,
        onOpenSubscription,
        onPublishTo,
        onLiveStatus,
      })
    : {}

  return (
    <SubscriptionView
      key={subscription}
      project={project}
      subscription={subscription}
      topic={topic}
      topics={topics}
      view={search.view}
      onView={(next) =>
        update({
          view: next === 'backlog' ? undefined : next,
          message: undefined,
          tab: undefined,
          state: undefined,
          paused: undefined,
          q: undefined,
        })
      }
      onOpenTopic={onOpenTopic}
      onDeleted={onDeleted}
      tabs={TABS}
      body={content.body}
      end={content.end}
    />
  )
}
