// A subscription's backlog, read without leasing anything (S8, PS-30): the
// messages it has not acknowledged, in the order the next pull takes them —
// outstanding and pushing ones first by lease, then the available ones
// numbered from #1, a nacked or expired message behind the later ones as
// the next pull will find it, a message waiting on its ordering key saying
// which one it waits for. Nothing here takes a message from a subscriber;
// Pull is a tab of its own.
//
// The rows are positions, so a message that moves (a nack, an extended
// lease) is one gone key and one new key: `pubsub.topic` names them, and
// they are patched through `POST /pubsub/backlog:batchGet` — an acked row
// leaves, a moved row reappears at its place — and the places renumber in
// the browser.

import { Button, Tabs, Tooltip } from '@cloudflare/kumo'
import {
  ArrowCounterClockwiseIcon,
  CheckIcon,
  CopyIcon,
  SidebarSimpleIcon,
  TrayIcon,
} from '@phosphor-icons/react'
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { ApiError } from '@/api/client'
import type { BulkTarget } from '@/api/generated/BulkTarget'
import type { PubsubBacklogRow } from '@/api/generated/messaging/PubsubBacklogRow'
import type { PubsubBacklogState } from '@/api/generated/messaging/PubsubBacklogState'
import type { PubsubSubscription } from '@/api/generated/messaging/PubsubSubscription'
import type { PubsubSubscriptionCounters } from '@/api/generated/messaging/PubsubSubscriptionCounters'
import { DangerConfirm } from '@/components/console/danger-confirm'
import { DataTable, type DataTableColumn } from '@/components/console/data-table'
import { EmptyState, QueryError } from '@/components/console/empty-state'
import { MatchCount } from '@/components/console/match-count'
import { RelativeTime } from '@/components/console/relative-time'
import type { RowMenuItem } from '@/components/console/row-menu'
import { SelectionBar } from '@/components/console/selection-bar'
import { TableFooter } from '@/components/console/table-footer'
import { ToolbarRow } from '@/components/console/toolbar'
import { useCursorRows } from '@/components/console/use-cursor-rows'
import { StatusDot } from '@/components/kit'
import { useNow } from '@/lib/clock'
import { formatBytes, formatNumber } from '@/lib/format'
import type { SubscriptionStatus } from '@/lib/live/channel'
import { readStarted } from '@/lib/live/use-live-topic'
import { useShortcuts } from '@/lib/shortcuts'
import { toast } from '@/lib/toasts'
import { dedupeRows, renumberPlaces } from '@/messaging/rows'
import { ackMessage, releaseMessage, startBacklogAck, startBacklogRelease } from '../api'
import { useTopicLive } from '../live'
import { shortName } from '../names'
import { previewText } from '../payload'
import { backlogList, pubsubKeys } from '../queries'
import { backlogState, consumersText, waitedShort } from '../states'
import { ConfirmDialog } from './confirm-dialog'
import { type MessageTab, MessageInspector } from './message-inspector'
import { SubscriptionState } from './subscription-state'

const NOUN = { one: 'message', other: 'messages' }

function errorText(error: unknown): string {
  if (error instanceof ApiError) return error.fix ? `${error.message} ${error.fix}` : error.message
  return error instanceof Error ? error.message : String(error)
}

/** A row's state as a dot and words, counting its lease down while it is on screen. */
function BacklogStateCell({ row }: { row: PubsubBacklogRow }) {
  const live = row.state === 'outstanding' || row.state === 'pushing'
  const now = useNow(live ? 'second' : 'minute')
  const look = backlogState(row, now)
  return (
    <span className="inline-flex items-center gap-1.5 align-middle font-sans">
      <StatusDot tone={look.tone} label={look.word} />
      {look.redelivered && (
        <span className="font-sans text-[11px] text-kumo-subtle">redelivered</span>
      )}
    </span>
  )
}

export const BACKLOG_COLUMNS: readonly DataTableColumn<PubsubBacklogRow>[] = [
  {
    id: 'state',
    header: 'State',
    width: 200,
    cell: (row) => <BacklogStateCell row={row} />,
    copy: (row) => row.state,
  },
  {
    id: 'place',
    header: '#',
    width: 56,
    align: 'end',
    cell: (row) =>
      row.place === null ? (
        <span className="text-kumo-inactive">—</span>
      ) : (
        `#${formatNumber(row.place)}`
      ),
  },
  { id: 'id', header: 'id', width: 72, align: 'end', cell: (row) => row.id },
  {
    id: 'attempts',
    header: 'Att.',
    width: 52,
    align: 'end',
    cell: (row) => formatNumber(row.attempts),
  },
  {
    id: 'published',
    header: 'Published',
    width: 96,
    cell: (row) => <RelativeTime iso={row.publishTime} />,
    copy: (row) => row.publishTime,
  },
  {
    id: 'data',
    header: 'Data',
    width: 280,
    cell: (row) => (
      <span className={row.data.encoding === 'binary' ? 'text-kumo-subtle' : undefined}>
        {previewText(row.data, row.size)}
      </span>
    ),
    copy: (row) => row.data.text,
  },
  {
    id: 'key',
    header: 'Key',
    width: 150,
    cell: (row) =>
      row.blockedBy ? (
        <Tooltip
          content={`Its ordering key waits for ${row.blockedBy}: the next pull skips it until ${row.blockedBy} is acknowledged.`}
          render={<span className="text-kumo-warning">waits for {row.blockedBy}</span>}
        />
      ) : (
        (row.orderingKey ?? <span className="text-kumo-inactive">—</span>)
      ),
    copy: (row) => row.orderingKey ?? '',
  },
]

/** The state switch's counts, from the live figures. */
export function backlogCounts(
  counters: PubsubSubscriptionCounters,
): Record<'all' | PubsubBacklogState, number> {
  return {
    all: counters.backlog + counters.retainedAcked,
    available: counters.available,
    outstanding: counters.outstanding,
    pushing: counters.pushing,
    acked: counters.retainedAcked,
  }
}

/**
 * Row two's end on Backlog: the state switch with its counts (labels only
 * below `xl`, the counts in their tooltips), then how long the oldest
 * message has waited and who is connected.
 */
export function BacklogSwitch({
  config,
  counters,
  state,
  onState,
}: {
  config: PubsubSubscription
  counters: PubsubSubscriptionCounters
  state: PubsubBacklogState | undefined
  onState: (state: PubsubBacklogState | undefined) => void
}) {
  const counts = backlogCounts(counters)
  const now = useNow('second')
  const shown: ('all' | PubsubBacklogState)[] = ['all', 'available', 'outstanding']
  if (config.pushEndpoint !== null || counts.pushing > 0) shown.push('pushing')
  if (config.retainAcked || counts.acked > 0) shown.push('acked')
  const names: Record<'all' | PubsubBacklogState, string> = {
    all: 'All',
    available: 'Available',
    outstanding: 'Outstanding',
    pushing: 'Pushing',
    acked: 'Acked',
  }
  const connected = counters.consumers.streaming + counters.consumers.waitingPulls
  return (
    <span className="ml-auto flex shrink-0 items-center gap-3" data-testid="pubsub-backlog-switch">
      <Tabs
        variant="segmented"
        size="sm"
        value={state ?? 'all'}
        onValueChange={(next) => onState(next === 'all' ? undefined : (next as PubsubBacklogState))}
        tabs={shown.map((value) => ({
          value,
          label: (
            <Tooltip
              content={`${formatNumber(counts[value])} ${value === 'all' ? 'in the backlog' : value}`}
              render={
                <span data-testid={`backlog-state-${value}`}>
                  {names[value]}
                  <span className="hidden font-mono text-[11px] tabular-nums xl:inline">
                    {' '}
                    {formatNumber(counts[value])}
                  </span>
                </span>
              }
            />
          ),
        }))}
      />
      {/* Below xl the row has room for the tabs and the switch only; the tree's tooltip says the same. */}
      <span
        className="hidden text-[12px] whitespace-nowrap text-kumo-subtle xl:inline"
        data-testid="pubsub-backlog-facts"
      >
        {counters.oldestUnackedAt && counters.backlog > 0
          ? `oldest ${waitedShort(counters.oldestUnackedAt, now)} · `
          : ''}
        {connected === 0 ? 'no subscriber' : consumersText(counters.consumers)}
      </span>
    </span>
  )
}

export function BacklogView({
  project,
  subscription,
  topic,
  config,
  counters,
  state,
  message,
  tab,
  onMessage,
  onTab,
  onLiveStatus,
  onOpenSubscription,
}: {
  project: string
  /** The subscription's full name. */
  subscription: string
  /** Its topic's full name, unless the topic was deleted. */
  topic: string | null
  config: PubsubSubscription
  counters: PubsubSubscriptionCounters
  state: PubsubBacklogState | undefined
  message: string | undefined
  tab: MessageTab | undefined
  onMessage: (id: string | undefined, options?: { replace?: boolean }) => void
  onTab: (tab: MessageTab | undefined) => void
  onLiveStatus: (status: SubscriptionStatus) => void
  onOpenSubscription: (name: string) => void
}) {
  const queryClient = useQueryClient()
  const subscriptionId = shortName(subscription)
  const list = backlogList(project, subscription, state)
  const query = useInfiniteQuery(list.options)
  const cursor = useCursorRows(query, list)
  const rows = renumberPlaces(
    dedupeRows(cursor.rows, (row) => row.id),
    !cursor.hasPrevious,
  )

  const live = useTopicLive(project, topic ?? undefined, subscription, {
    onBacklogKeys: (keys) => cursor.applyKeys(keys),
    onReset: () => cursor.reset(),
    // Rows read before the engine took the subscription are read again, from now.
    onTaken: () => {
      if (readStarted(queryClient.getQueryState(list.queryKey)))
        void queryClient.refetchQueries({ queryKey: list.queryKey, exact: true })
    },
  })
  useEffect(() => onLiveStatus(live), [live, onLiveStatus])
  // A subscription whose topic was deleted has no topic to follow: its
  // figures still move, and the first page is read again when they do.
  const figure = `${counters.backlog}|${counters.outstanding}|${counters.retainedAcked}`
  useEffect(() => {
    if (topic !== null || figure === '') return
    void queryClient.invalidateQueries({
      queryKey: pubsubKeys.backlog(project, subscription, state),
      exact: true,
    })
  }, [figure, topic, queryClient, project, subscription, state])
  const listKey = list.queryKey.join('\u0000')

  // Ticked rows.
  const [selection, setSelection] = useState<{
    key: string
    checked: ReadonlySet<string>
    everything: boolean
  }>({
    key: listKey,
    checked: new Set(),
    everything: false,
  })
  const ticked =
    selection.key === listKey
      ? selection
      : { key: listKey, checked: new Set<string>(), everything: false }
  const clearSelection = () => setSelection({ key: listKey, checked: new Set(), everything: false })
  const selecting = ticked.checked.size > 0 || ticked.everything
  const total = cursor.total
  const tickedCount = ticked.everything
    ? (total?.count ?? ticked.checked.size)
    : ticked.checked.size
  const tickedBytes = rows
    .filter((row) => ticked.checked.has(row.key))
    .reduce((sum, row) => sum + row.size, 0)
  const target: BulkTarget = ticked.everything
    ? { by: 'query', q: '', scope: { subscription, ...(state ? { state } : {}) } }
    : { by: 'keys', keys: [...ticked.checked] }

  // Bulk work: acknowledging (gone for good) and returning (leases end now).
  const [bulk, setBulk] = useState<'ack' | 'release' | null>(null)
  const [jobId, setJobId] = useState<string | undefined>()
  const startBulk = useMutation({
    mutationFn: (verb: 'ack' | 'release') =>
      verb === 'ack'
        ? startBacklogAck({ subscription, target })
        : startBacklogRelease({ subscription, target }),
    onSuccess: (job) => {
      queryClient.setQueryData(['jobs', job.id], job)
      setJobId(job.id)
      clearSelection()
    },
  })
  const closeBulk = () => {
    setBulk(null)
    setJobId(undefined)
    startBulk.reset()
  }

  // One row: an outstanding one is someone else's lease, so it asks first.
  const [single, setSingle] = useState<{ verb: 'ack' | 'release'; row: PubsubBacklogRow } | null>(
    null,
  )
  const act = useMutation({
    mutationFn: ({ verb, row }: { verb: 'ack' | 'release'; row: PubsubBacklogRow }) =>
      verb === 'ack'
        ? ackMessage({ subscription, messageId: row.id })
        : releaseMessage({ subscription, messageId: row.id }),
    onSuccess: (_answer, { verb, row }) => {
      setSingle(null)
      toast({
        key: `pubsub-backlog-${row.id}`,
        title: verb === 'ack' ? `Acknowledged ${row.id}` : `Returned ${row.id} to the backlog`,
      })
      cursor.applyKeys([row.key])
    },
  })
  const request = (verb: 'ack' | 'release', row: PubsubBacklogRow) => {
    act.reset()
    if (row.state === 'outstanding') setSingle({ verb, row })
    else act.mutate({ verb, row })
  }

  const bulkAck = () => {
    if (!selecting) return
    startBulk.reset()
    setBulk('ack')
  }
  useShortcuts({ id: 'pubsub-backlog', label: 'Backlog' }, [
    { key: 'Delete', label: 'Acknowledge the ticked rows', when: () => selecting, run: bulkAck },
    { key: 'Backspace', label: 'Acknowledge the ticked rows', when: () => selecting, run: bulkAck },
  ])

  const rowMenu = (row: PubsubBacklogRow): RowMenuItem[] => [
    ...(topic !== null
      ? [
          {
            id: 'open',
            label: 'Open',
            icon: SidebarSimpleIcon,
            shortcut: 'Enter',
            run: () => onMessage(row.id),
          },
        ]
      : []),
    {
      id: 'ack',
      label: row.state === 'outstanding' ? 'Acknowledge…' : 'Acknowledge',
      icon: CheckIcon,
      disabled: row.state === 'acked' ? 'It is acknowledged already, kept for replay.' : undefined,
      run: () => request('ack', row),
    },
    {
      id: 'release',
      label: 'Return to backlog…',
      icon: ArrowCounterClockwiseIcon,
      disabled:
        row.state === 'outstanding'
          ? undefined
          : 'Not leased: only a leased message can be returned.',
      run: () => request('release', row),
    },
    {
      id: 'copy-id',
      label: 'Copy id',
      icon: CopyIcon,
      run: () => {
        void navigator.clipboard
          .writeText(row.id)
          .then(() => toast({ key: 'pubsub-copy', title: `Copied ${row.id}` }))
          .catch(() => toast({ key: 'pubsub-copy', title: 'Could not copy', tone: 'danger' }))
      },
    },
  ]

  const stepTo = (step: -1 | 1) => {
    const at = rows.findIndex((row) => row.id === message)
    const row = at === -1 ? undefined : rows[at + step]
    return row ? () => onMessage(row.id, { replace: true }) : undefined
  }
  const openRow = rows.find((row) => row.id === message)

  return (
    <>
      <ToolbarRow
        variant="line"
        testId="pubsub-backlog-line"
        overlay={
          selecting ? (
            <SelectionBar
              count={tickedCount}
              total={total}
              everything={ticked.everything}
              filtered={state !== undefined}
              noun={NOUN}
              {...(tickedBytes > 0 && !ticked.everything
                ? { detail: formatBytes(tickedBytes) }
                : {})}
              onSelectEverything={() =>
                setSelection({ key: listKey, checked: ticked.checked, everything: true })
              }
              onClear={clearSelection}
              testId="pubsub-backlog-selection"
              actions={
                <>
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<ArrowCounterClockwiseIcon />}
                    onClick={() => {
                      startBulk.reset()
                      setBulk('release')
                    }}
                    data-testid="pubsub-backlog-release"
                  >
                    Return {formatNumber(tickedCount)}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<CheckIcon className="text-kumo-danger" />}
                    onClick={bulkAck}
                    className="ml-auto"
                    data-testid="pubsub-backlog-ack"
                  >
                    <span className="text-kumo-danger">
                      Acknowledge {formatNumber(tickedCount)}
                    </span>
                  </Button>
                </>
              }
            />
          ) : undefined
        }
      >
        <span className="min-w-0 flex-1 truncate text-[12px] text-kumo-subtle">
          Read without leasing: nothing here takes a message from a subscriber.
        </span>
        <MatchCount
          total={total}
          noun={NOUN}
          loading={query.isPending}
          widest="0,000,000"
          {...(counters.backlogBytes > 0 && state === undefined
            ? { detail: formatBytes(counters.backlogBytes) }
            : {})}
          tooltip={`Messages ${subscriptionId} has not acknowledged${config.retainAcked || counters.retainedAcked > 0 ? ', and the acknowledged ones it keeps' : ''}${state ? `, ${state} now` : ''}, in the order the next pull takes them.`}
          testId="pubsub-backlog-count"
        />
      </ToolbarRow>
      <div className="relative flex min-h-0 flex-1" data-testid="pubsub-backlog">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {query.isError && rows.length === 0 ? (
            <QueryError error={query.error} onRetry={() => void query.refetch()} section="pubsub" />
          ) : (
            <DataTable
              ariaLabel={`Backlog of ${subscriptionId}`}
              rows={rows}
              rowKey={(row) => row.key}
              columns={BACKLOG_COLUMNS}
              memoryKey="pubsub.backlog"
              openKey={openRow?.key}
              {...(topic !== null ? { onOpen: (row: PubsubBacklogRow) => onMessage(row.id) } : {})}
              rowClick={topic !== null ? 'open' : 'cursor'}
              onCursorChange={(row) => {
                if (message !== undefined && message !== row.id)
                  onMessage(row.id, { replace: true })
              }}
              selection={{
                checked: ticked.checked,
                everything: ticked.everything,
                onChange: (checked, everything) =>
                  setSelection({ key: listKey, checked, everything }),
              }}
              flashes={cursor.flashes}
              hasMore={cursor.hasMore}
              loadMore={cursor.loadMore}
              hasPrevious={cursor.hasPrevious}
              loadPrevious={cursor.loadPrevious}
              rowOffset={cursor.rowOffset}
              total={total}
              anchor="key"
              rowMenu={rowMenu}
              loading={query.isPending}
              empty={
                <EmptyState
                  icon={TrayIcon}
                  title={state ? `Nothing ${state}` : 'Nothing waiting'}
                  description={`${formatNumber(counters.ackedTotal)} acknowledged at ${subscriptionId} since the emulator started.`}
                  testId="pubsub-backlog-empty"
                />
              }
              footer={
                rows.length > 0 ? (
                  <TableFooter
                    loaded={rows.length}
                    rowOffset={cursor.rowOffset}
                    total={total}
                    hasMore={cursor.hasMore}
                    noun={NOUN}
                    testId="pubsub-backlog-footer"
                  />
                ) : undefined
              }
              testId="pubsub-backlog-table"
            />
          )}
        </div>
        {topic !== null && message !== undefined && (
          <MessageInspector
            project={project}
            topic={topic}
            id={message}
            tab={tab}
            onTab={(next) => onTab(next === 'data' ? undefined : next)}
            onClose={() => onMessage(undefined)}
            onPrev={stepTo(-1)}
            onNext={stepTo(1)}
            onOpenSubscription={onOpenSubscription}
            top={
              <SubscriptionState
                project={project}
                topic={topic}
                subscription={subscription}
                id={message}
                row={openRow}
                maxDeliveries={config.deadLetter?.maxDeliveryAttempts}
                onAck={() => openRow && request('ack', openRow)}
                onRelease={() => openRow && request('release', openRow)}
              />
            }
          />
        )}
      </div>
      <DangerConfirm
        open={bulk === 'ack'}
        onOpenChange={(open) => !open && closeBulk()}
        title={`Acknowledge ${formatNumber(tickedCount || 0)} at ${subscriptionId}`}
        description={
          <>
            They leave <span className="font-mono text-[0.9em]">{subscriptionId}</span>’s backlog as
            if a subscriber had acknowledged them.
          </>
        }
        consequences={[
          config.retainAcked
            ? 'The subscription keeps acknowledged messages, so a replay brings them back.'
            : 'The subscription does not keep acknowledged messages: only a snapshot taken before brings them back.',
          'A subscriber holding one of their leases gets an error or a duplicate when it acks.',
        ]}
        {...(jobId ? { jobId } : {})}
        progressVerb="acknowledged"
        {...(startBulk.isError ? { error: errorText(startBulk.error) } : {})}
        pending={startBulk.isPending}
        onConfirm={() => startBulk.mutate('ack')}
        testId="pubsub-backlog-ack-confirm"
      />
      <ConfirmDialog
        open={bulk === 'release'}
        onOpenChange={(open) => !open && closeBulk()}
        title={`Return ${formatNumber(tickedCount)} to the backlog`}
        description="Their leases end now, as their expiry would: each counts as a delivery attempt and goes to the next pull, and a subscriber that still holds one may process it twice."
        confirmLabel={`Return ${formatNumber(tickedCount)}`}
        jobId={jobId}
        progressVerb="returned"
        error={startBulk.isError ? errorText(startBulk.error) : undefined}
        pending={startBulk.isPending}
        onConfirm={() => startBulk.mutate('release')}
        testId="pubsub-backlog-release-confirm"
      />
      <ConfirmDialog
        open={single !== null}
        onOpenChange={(open) => !open && setSingle(null)}
        title={
          single?.verb === 'ack'
            ? `Acknowledge ${single.row.id} at ${subscriptionId}`
            : `Return ${single?.row.id ?? ''} to the backlog`
        }
        description={
          single?.verb === 'ack'
            ? `A subscriber holds its lease. When it acks, ${config.summary.exactlyOnce ? 'it gets INVALID_ARGUMENT, since the subscription delivers exactly once' : 'its ack is ignored'}; the message leaves the backlog now.`
            : `A subscriber holds its lease. It ends now, as its expiry would: the message counts as a delivery attempt and goes to the next pull${config.deadLetter ? `, or to ${shortName(config.deadLetter.topic)} after ${config.deadLetter.maxDeliveryAttempts} deliveries` : ''}, and the subscriber may process it twice.`
        }
        confirmLabel={single?.verb === 'ack' ? 'Acknowledge' : 'Return'}
        danger={single?.verb === 'ack'}
        error={act.isError ? errorText(act.error) : undefined}
        pending={act.isPending}
        onConfirm={() => single && act.mutate(single)}
        testId="pubsub-backlog-confirm"
      />
    </>
  )
}
