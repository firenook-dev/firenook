// One subscription: row two is its tabs, and the one sentence a subscription
// sometimes needs comes before them — the functions' own `emulator-sub-*`
// is drained at every publish, so it is explained instead of shown; one
// whose topic lost its functions is orphaned and keeps every later message.

import { Button, Tabs } from '@cloudflare/kumo'
import { LightningIcon, TrashIcon, TrayArrowDownIcon } from '@phosphor-icons/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useState } from 'react'
import { ApiError } from '@/api/client'
import type { PubsubSubscriptionDetail } from '@/api/generated/messaging/PubsubSubscriptionDetail'
import type { PubsubTopicSummary } from '@/api/generated/messaging/PubsubTopicSummary'
import { DangerConfirm } from '@/components/console/danger-confirm'
import { EmptyState, QueryError } from '@/components/console/empty-state'
import { SectionBanner } from '@/components/console/section-banner'
import { ToolbarRow } from '@/components/console/toolbar'
import { toast } from '@/lib/toasts'
import { deleteSubscription } from '../api'
import { shortName } from '../names'
import { pubsubKeys, subscriptionQuery } from '../queries'
import { orphanedNote } from '../tree'
import { SubscriptionSettings } from './subscription-settings'

export type SubscriptionViewName = 'backlog' | 'push' | 'dead-letters' | 'settings'

/** The tabs a subscription has: Push only when it pushes, Dead letters only with a policy. */
export function subscriptionViews(
  detail: PubsubSubscriptionDetail | undefined,
  available: readonly SubscriptionViewName[],
): SubscriptionViewName[] {
  return available.filter((view) => {
    if (view === 'push') return detail?.subscription.pushEndpoint !== null && detail !== undefined
    if (view === 'dead-letters') return detail?.subscription.deadLetter != null
    return true
  })
}

const LABELS: Record<SubscriptionViewName, string> = {
  backlog: 'Backlog',
  push: 'Push',
  'dead-letters': 'Dead letters',
  settings: 'Settings',
}

const ORDER: readonly SubscriptionViewName[] = ['backlog', 'push', 'dead-letters', 'settings']

/** The tab a `view` parameter names, among those the subscription has, or its first. */
export function resolveSubscriptionView(
  detail: PubsubSubscriptionDetail | undefined,
  requested: string | undefined,
  available: readonly SubscriptionViewName[],
): { view: SubscriptionViewName; ordered: SubscriptionViewName[] } {
  const views = subscriptionViews(detail, [
    ...available.filter((name) => name !== 'settings'),
    'settings',
  ])
  const ordered = ORDER.filter((name) => views.includes(name))
  const view = ordered.includes(requested as SubscriptionViewName)
    ? (requested as SubscriptionViewName)
    : (ordered[0] ?? 'settings')
  return { view, ordered }
}

/** No tabs beyond Settings. */
const NO_TABS: readonly SubscriptionViewName[] = []

export function SubscriptionView({
  project,
  subscription,
  topic,
  topics,
  view: requested,
  onView,
  onOpenTopic,
  onDeleted,
  tabs = NO_TABS,
  body,
  end,
}: {
  project: string
  /** The subscription's full name. */
  subscription: string
  /** Its topic in the index (with the functions it feeds), unless the topic was deleted. */
  topic: PubsubTopicSummary | undefined
  /** The project's topics (full names), for the dead-letter topic. */
  topics: readonly string[]
  view: string | undefined
  onView: (view: SubscriptionViewName) => void
  onOpenTopic: (topic: string) => void
  onDeleted: () => void
  /** The tabs other than Settings the page offers. */
  tabs?: readonly SubscriptionViewName[]
  /** The resolved tab's body (any but Settings), and row two's end beside the tabs. */
  body?: ReactNode
  end?: ReactNode
}) {
  const queryClient = useQueryClient()
  const detail = useQuery(subscriptionQuery(project, subscription))
  const id = shortName(subscription)
  const missing = detail.error instanceof ApiError && detail.error.code === 'not-found'
  const [deleting, setDeleting] = useState(false)
  const remove = useMutation({
    mutationFn: () => deleteSubscription({ name: subscription }),
    onSuccess: () => {
      setDeleting(false)
      toast({ key: `pubsub-subscription-${subscription}`, title: `Deleted ${id}`, tone: 'success' })
      void queryClient.invalidateQueries({ queryKey: pubsubKeys.topics(project) })
      onDeleted()
    },
  })

  if (missing)
    return (
      <EmptyState
        icon={TrayArrowDownIcon}
        title={`${id} does not exist`}
        description="It was deleted, or the link names a subscription this run of the emulator never had."
        testId="pubsub-subscription-missing"
      />
    )
  if (detail.isError)
    return (
      <QueryError error={detail.error} onRetry={() => void detail.refetch()} section="pubsub" />
    )
  if (!detail.data) return null

  const config = detail.data.subscription
  const managed = config.summary.managed
  if (managed === 'functions') {
    const names = topic?.functions.map((target) => target.name) ?? []
    return (
      <EmptyState
        icon={LightningIcon}
        title={`The emulator's own subscription for ${names.join(', ') || 'a function'}`}
        description={`Each publish to ${shortName(config.summary.topic)} is handed to the function and drained here, so it is always empty. Each message shows its delivery on the topic.`}
        actions={
          config.summary.topic ? (
            <Button
              variant="secondary"
              onClick={() => onOpenTopic(config.summary.topic ?? '')}
              data-testid="pubsub-managed-open-topic"
            >
              Open {shortName(config.summary.topic)}
            </Button>
          ) : undefined
        }
        testId="pubsub-managed-subscription"
      />
    )
  }

  const { view, ordered } = resolveSubscriptionView(detail.data, requested, tabs)

  return (
    <>
      <ToolbarRow variant="line" testId="pubsub-subscription-tabs">
        <Tabs
          variant="underline"
          size="sm"
          value={view}
          onValueChange={(next) => onView(next as SubscriptionViewName)}
          tabs={ordered.map((name) => ({ value: name, label: LABELS[name] }))}
          className="shrink-0"
        />
        {view === 'settings' ? undefined : end}
      </ToolbarRow>
      {managed === 'orphaned' && (
        <SectionBanner
          tone="warning"
          testId="pubsub-orphaned"
          action={
            <Button
              variant="secondary"
              size="xs"
              icon={<TrashIcon />}
              onClick={() => {
                remove.reset()
                setDeleting(true)
              }}
            >
              Delete subscription…
            </Button>
          }
        >
          {orphanedNote(shortName(config.summary.topic))}
        </SectionBanner>
      )}
      {view === 'settings' ? (
        <SubscriptionSettings
          key={subscription}
          project={project}
          subscription={config}
          topics={topics}
          onDeleted={onDeleted}
        />
      ) : (
        body
      )}
      <DangerConfirm
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${id}`}
        description="Nothing drains it any more, so it only grows. A function listening on this topic again gets a new one."
        {...(remove.isError ? { error: remove.error.message } : {})}
        pending={remove.isPending}
        onConfirm={() => remove.mutate()}
        testId="pubsub-orphaned-delete-confirm"
      />
    </>
  )
}
