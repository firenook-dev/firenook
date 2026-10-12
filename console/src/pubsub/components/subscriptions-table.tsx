// A topic's subscriptions as a table (S4): how each delivers, how far
// behind it is, who is consuming it, and the options that change what it
// receives. The configuration comes with the topic's detail; the figures
// are the topics index's, which the counters topic keeps current, so the
// table moves while a consumer drains a backlog without reading the topic
// again.

import { Button, Tooltip } from '@cloudflare/kumo'
import {
  CopyIcon,
  LightningIcon,
  PlusIcon,
  SidebarSimpleIcon,
  TrayArrowDownIcon,
} from '@phosphor-icons/react'
import type { PubsubSubscription } from '@/api/generated/messaging/PubsubSubscription'
import type { PubsubSubscriptionCounters } from '@/api/generated/messaging/PubsubSubscriptionCounters'
import type { PubsubTopicSummary } from '@/api/generated/messaging/PubsubTopicSummary'
import { DataTable, type DataTableColumn } from '@/components/console/data-table'
import { EmptyState } from '@/components/console/empty-state'
import { RelativeTime } from '@/components/console/relative-time'
import type { RowMenuItem } from '@/components/console/row-menu'
import { TableFooter } from '@/components/console/table-footer'
import { formatNumber } from '@/lib/format'
import { toast } from '@/lib/toasts'
import { shortName } from '../names'
import { consumersText } from '../states'
import { orphanedNote } from '../tree'

/** A subscription's configuration with its live figures. */
export interface SubscriptionRow {
  subscription: PubsubSubscription
  counters: PubsubSubscriptionCounters
  /** The functions the emulator drains it for, when it is theirs. */
  functions: readonly string[]
}

const NOUN = { one: 'subscription', other: 'subscriptions' }

function Chip({ children, tone, title }: { children: string; tone?: 'warning'; title?: string }) {
  const chip = (
    <span
      className={`max-w-60 truncate rounded px-1 text-[11px] ${tone === 'warning' ? 'bg-kumo-warning-tint text-kumo-warning' : 'bg-kumo-tint text-kumo-default'}`}
    >
      {children}
    </span>
  )
  return title ? <Tooltip content={title} render={chip} /> : chip
}

function optionChips(row: SubscriptionRow) {
  const { subscription } = row
  const { summary } = subscription
  const chips: { text: string; tone?: 'warning'; title?: string }[] = []
  if (summary.managed === 'orphaned')
    chips.push({
      text: 'orphaned',
      tone: 'warning',
      title: orphanedNote(shortName(summary.topic)),
    })
  if (summary.ordering) chips.push({ text: 'ordering' })
  if (summary.exactlyOnce) chips.push({ text: 'exactly-once' })
  if (subscription.deadLetter)
    chips.push({
      text: `DLQ→${shortName(subscription.deadLetter.topic)}`,
      title: `Dead-letters to ${subscription.deadLetter.topic} after ${subscription.deadLetter.maxDeliveryAttempts} deliveries`,
    })
  if (subscription.retainAcked) chips.push({ text: 'keeps acked' })
  if (subscription.retry)
    chips.push({
      text: `retry ${subscription.retry.minimumBackoffSeconds}–${subscription.retry.maximumBackoffSeconds} s`,
      title: 'Stored. A nacked message is redelivered at once, as the official emulator does.',
    })
  if (summary.filter) chips.push({ text: summary.filter, title: summary.filter })
  return chips
}

export const SUBSCRIPTION_COLUMNS: readonly DataTableColumn<SubscriptionRow>[] = [
  {
    id: 'subscription',
    header: 'Subscription',
    width: 180,
    cell: (row) => (
      <span className="inline-flex items-center gap-1.5">
        {row.subscription.summary.managed === 'functions' && (
          <LightningIcon size={12} className="shrink-0 text-kumo-subtle" />
        )}
        {row.subscription.summary.id}
      </span>
    ),
    copy: (row) => row.subscription.summary.name,
  },
  {
    id: 'delivery',
    header: 'Delivery',
    width: 140,
    cell: (row) => {
      const { subscription } = row
      if (subscription.summary.managed === 'functions')
        return <span className="text-kumo-subtle">functions (drained)</span>
      if (subscription.pushEndpoint)
        return (
          <Tooltip
            content={subscription.pushEndpoint}
            render={
              <span>
                push <span className="text-kumo-subtle">{subscription.pushEndpoint}</span>
              </span>
            }
          />
        )
      return 'pull'
    },
    copy: (row) => row.subscription.pushEndpoint ?? row.subscription.summary.delivery,
  },
  {
    id: 'backlog',
    header: 'Backlog',
    width: 76,
    align: 'end',
    cell: (row) =>
      row.subscription.summary.managed === 'functions' ? '—' : formatNumber(row.counters.backlog),
  },
  {
    id: 'outstanding',
    header: 'Outstanding',
    width: 92,
    align: 'end',
    cell: (row) =>
      row.subscription.summary.managed === 'functions'
        ? '—'
        : formatNumber(row.counters.outstanding),
  },
  {
    id: 'oldest',
    header: 'Oldest',
    width: 88,
    cell: (row) =>
      row.counters.oldestUnackedAt ? (
        <RelativeTime iso={row.counters.oldestUnackedAt} />
      ) : (
        <span className="text-kumo-inactive">—</span>
      ),
  },
  {
    id: 'consumers',
    header: 'Consumers',
    width: 112,
    cell: (row) =>
      row.subscription.summary.managed === 'functions'
        ? `→ ${row.functions.join(', ')}`
        : consumersText(row.counters.consumers),
  },
  {
    id: 'options',
    header: 'Options',
    width: 260,
    cell: (row) => (
      <span className="inline-flex items-center gap-1 align-middle">
        {optionChips(row).map((chip) => (
          <Chip
            key={chip.text}
            {...(chip.tone ? { tone: chip.tone } : {})}
            {...(chip.title ? { title: chip.title } : {})}
          >
            {chip.text}
          </Chip>
        ))}
      </span>
    ),
  },
]

/** The topic detail's subscriptions with the index's live figures in place. */
export function subscriptionRows(
  subscriptions: readonly PubsubSubscription[],
  live: PubsubTopicSummary | undefined,
): SubscriptionRow[] {
  const counters = new Map(live?.subscriptions.map((summary) => [summary.name, summary.counters]))
  const functions = live?.functions.map((target) => target.name) ?? []
  return subscriptions.map((subscription) => ({
    subscription,
    counters: counters.get(subscription.summary.name) ?? subscription.summary.counters,
    functions: subscription.summary.managed === 'functions' ? functions : [],
  }))
}

export function SubscriptionsTable({
  topicId,
  rows,
  loading,
  onOpen,
  onCreate,
}: {
  topicId: string
  rows: readonly SubscriptionRow[]
  loading: boolean
  onOpen: (name: string) => void
  onCreate: () => void
}) {
  const rowMenu = (row: SubscriptionRow): RowMenuItem[] => [
    {
      id: 'open',
      label: 'Open',
      icon: SidebarSimpleIcon,
      shortcut: 'Enter',
      run: () => onOpen(row.subscription.summary.name),
    },
    {
      id: 'copy',
      label: 'Copy the full name',
      icon: CopyIcon,
      run: () => {
        void navigator.clipboard
          .writeText(row.subscription.summary.name)
          .then(() =>
            toast({ key: 'pubsub-copy', title: `Copied ${row.subscription.summary.name}` }),
          )
          .catch(() => toast({ key: 'pubsub-copy', title: 'Could not copy', tone: 'danger' }))
      },
    },
  ]
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="pubsub-subscriptions">
      <DataTable
        ariaLabel={`Subscriptions of ${topicId}`}
        rows={rows}
        rowKey={(row) => row.subscription.summary.name}
        columns={SUBSCRIPTION_COLUMNS}
        memoryKey="pubsub.subscriptions"
        onOpen={(row) => onOpen(row.subscription.summary.name)}
        rowClick="open"
        rowMenu={rowMenu}
        loading={loading}
        total={{ count: rows.length, exact: true }}
        empty={
          <EmptyState
            icon={TrayArrowDownIcon}
            title={`No subscriptions on ${topicId}`}
            description="A subscription keeps every message published after it was created until a subscriber acknowledges it."
            actions={
              <Button
                variant="primary"
                icon={<PlusIcon />}
                onClick={onCreate}
                data-testid="pubsub-subscriptions-empty-new"
              >
                New subscription
              </Button>
            }
            testId="pubsub-subscriptions-empty"
          />
        }
        footer={
          rows.length > 0 ? (
            <TableFooter
              loaded={rows.length}
              total={{ count: rows.length, exact: true }}
              hasMore={false}
              noun={NOUN}
            />
          ) : undefined
        }
        testId="pubsub-subscription-table"
      />
    </div>
  )
}
