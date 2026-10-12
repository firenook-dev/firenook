// The Topics page with no topic open: what the app did that the emulator
// refused, then the most recently active topics as cards — how far behind
// their slowest subscription is, when they last saw a message, the last
// minute's publishes as bars, the functions they trigger. At most 24 cards,
// whatever the project holds: the panel's filter reaches the rest, and
// only the cards on screen have their throughput sent (§6.2).

import { Button } from '@cloudflare/kumo'
import { BroadcastIcon, LightningIcon, PlusIcon } from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import type { PubsubTopicIndex } from '@/api/generated/messaging/PubsubTopicIndex'
import type { PubsubTopicSummary } from '@/api/generated/messaging/PubsubTopicSummary'
import { EmptyState } from '@/components/console/empty-state'
import { EntityLink } from '@/components/console/entity-link'
import { RelativeTime } from '@/components/console/relative-time'
import { Kbd } from '@/components/kit'
import { formatNumber } from '@/lib/format'
import { describeKey } from '@/lib/shortcuts'
import { useThroughput } from '../live'
import { rejectedQuery } from '../queries'
import { mostBehind } from '../tree'
import { PANEL_FILTER_ID } from './topics-panel'
import { RefusedBanners } from './refused-banner'
import { ThroughputBars, useLastMinute } from './throughput-bars'

/** Cards the landing shows at most. */
export const LANDING_CARDS = 24

/** The topics the landing shows as cards: an app's (never a schedule's), most recently published first. */
export function landingTopics(index: PubsubTopicIndex | undefined): PubsubTopicSummary[] {
  if (!index) return []
  return index.items
    .filter((topic) => topic.kind === 'user')
    .toSorted((a, b) => {
      const at = a.counters.lastPublishedAt ?? ''
      const bt = b.counters.lastPublishedAt ?? ''
      if (at !== bt) return at < bt ? 1 : -1
      return a.id.localeCompare(b.id)
    })
}

export function TopicsLanding({
  index,
  project,
  foreign,
  onOpen,
  onCreateTopic,
  onProject,
}: {
  index: PubsubTopicIndex | undefined
  project: string
  /** The page shows another project than the emulator's (`?project=`). */
  foreign: boolean
  onOpen: (topic: string) => void
  onCreateTopic: (id?: string) => void
  onProject: (project: string) => void
}) {
  const rejected = useQuery(rejectedQuery(project))
  const topics = landingTopics(index)
  const cards = topics.slice(0, LANDING_CARDS)
  const more = topics.length - cards.length
  // A refusal for something that exists by now is history, not a problem.
  const existing = new Set<string>()
  for (const item of index?.items ?? []) {
    existing.add(item.name)
    for (const subscription of item.subscriptions) existing.add(subscription.name)
  }
  const refusals = (rejected.data?.items ?? []).filter(
    (refused) => refused.code !== 'NOT_FOUND' || !existing.has(refused.resource),
  )
  const refused = (
    <RefusedBanners
      items={refusals}
      onCreateTopic={(id) => onCreateTopic(id)}
      onOpenTopic={(id) => onOpen(`projects/${project}/topics/${id}`)}
      onProject={onProject}
    />
  )
  if (index && index.items.length === 0)
    return (
      <div className="flex min-h-0 flex-1 flex-col" data-testid="pubsub-landing">
        {refused}
        <EmptyState
          icon={BroadcastIcon}
          title="No topics yet"
          description="Your app creates them with createTopic, a function that listens on a topic creates it at startup, or create one here."
          connect={{ service: 'pubsub', ...(foreign ? { project } : {}) }}
          actions={
            <Button
              variant="primary"
              icon={<PlusIcon />}
              onClick={() => onCreateTopic()}
              data-testid="pubsub-empty-new-topic"
            >
              New topic
            </Button>
          }
          testId="pubsub-empty"
        />
      </div>
    )
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="pubsub-landing">
      {refused}
      <div className="grid min-h-0 flex-1 content-start gap-4 overflow-auto px-5 py-4">
        <p className="m-0 text-[13px] text-kumo-subtle">
          Topics in <span className="font-mono text-[0.9em] text-kumo-default">{project}</span>, the
          most recently active first. Pick one, or press{' '}
          <Kbd className="text-inherit">{describeKey('Mod+k')}</Kbd> to search.
        </p>
        <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-2 p-0">
          {cards.map((topic) => (
            <TopicCard key={topic.name} topic={topic} project={project} onOpen={onOpen} />
          ))}
          {index && (
            <li>
              <button
                type="button"
                onClick={() => onCreateTopic()}
                className="flex h-full min-h-[104px] w-full items-center justify-center gap-2 rounded-lg border border-dashed border-kumo-line px-4 text-kumo-subtle hover:ink hover:text-kumo-default"
                data-testid="pubsub-landing-new-topic"
              >
                <PlusIcon size={16} />
                <span className="text-[14px]">New topic</span>
              </button>
            </li>
          )}
        </ul>
        {more > 0 && (
          <button
            type="button"
            className="justify-self-start rounded-md px-1 text-[12px] text-kumo-subtle hover:ink hover:text-kumo-default"
            onClick={() =>
              document
                .querySelector<HTMLInputElement>(`[data-testid="${PANEL_FILTER_ID}"]`)
                ?.focus()
            }
            data-testid="pubsub-landing-more"
          >
            {formatNumber(more)} more {more === 1 ? 'topic' : 'topics'} — filter them in the panel
          </button>
        )}
      </div>
    </div>
  )
}

function TopicCard({
  topic,
  project,
  onOpen,
}: {
  topic: PubsubTopicSummary
  project: string
  onOpen: (topic: string) => void
}) {
  const minute = useLastMinute(useThroughput(project, topic.name))
  const worst = mostBehind(topic)
  const behind = !worst
    ? topic.subscriptions.length === 0
      ? 'no subscriptions'
      : 'functions only'
    : worst.counters.backlog === 0
      ? 'up to date'
      : `${formatNumber(worst.counters.backlog)} behind`
  return (
    // The card is one target, but it holds links of its own (the functions
    // it triggers), and a link inside a button is not allowed: the button
    // covers the card and the chips sit above it.
    <li
      className="relative rounded-lg bg-kumo-base ring ring-kumo-hairline hover:ink"
      data-testid="pubsub-topic-card"
    >
      <button
        type="button"
        onClick={() => onOpen(topic.name)}
        className="absolute inset-0 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-kumo-focus"
        aria-label={`Open ${topic.id}`}
      />
      <div className="pointer-events-none grid gap-1.5 px-4 py-3">
        <span className="flex min-w-0 items-center gap-2">
          <BroadcastIcon size={14} className="shrink-0 text-kumo-subtle" />
          <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-kumo-default">
            {topic.id}
          </span>
        </span>
        <span className="text-[12px] text-kumo-subtle">
          {topic.subscriptions.filter((s) => s.managed !== 'functions').length === 1
            ? '1 subscription'
            : `${formatNumber(topic.subscriptions.filter((s) => s.managed !== 'functions').length)} subscriptions`}{' '}
          ·{' '}
          <span
            className={
              worst && worst.counters.backlog > 0 ? 'text-kumo-default' : 'text-kumo-subtle'
            }
          >
            {behind}
          </span>
        </span>
        <span className="flex min-w-0 items-center gap-2 text-[12px] text-kumo-subtle">
          <span className="min-w-0 flex-1 truncate">
            {topic.counters.lastPublishedAt ? (
              <RelativeTime iso={topic.counters.lastPublishedAt} prefix="last" />
            ) : (
              'never published'
            )}
          </span>
          <span className="pointer-events-auto">
            <ThroughputBars bars={minute.bars} topicId={topic.id} />
          </span>
          <span className="shrink-0 font-mono text-[11px] tabular-nums">
            {formatNumber(minute.count)}/min
          </span>
        </span>
        {topic.functions.length > 0 && (
          <span className="pointer-events-auto relative flex min-w-0 flex-wrap items-center gap-1.5">
            {topic.functions.map((target) => (
              <span
                key={target.functionId}
                className="inline-flex max-w-full min-w-0 items-center gap-1 rounded-md bg-kumo-tint px-1.5"
              >
                <LightningIcon size={11} className="shrink-0 text-kumo-subtle" />
                <EntityLink entity={{ ...target.entity, label: target.name }} />
              </span>
            ))}
          </span>
        )}
      </div>
    </li>
  )
}
