// A topic's deliveries to functions (S5, PS-60): every time a function was
// handed one of the topic's messages — the publish's own deliveries and the
// ones run again — newest first, each with how it went in the Functions
// emulator's own record of invocations (joined by event id, never a second
// journal): queued behind other deliveries, running, delivered, failed with
// the handler's error, skipped while background triggers were paused, or no
// longer kept once that record let it go.
//
// Live. New deliveries arrive at the head: at the top the head is read
// again, scrolled away they are counted in the table's pill. A delivery
// whose outcome moves (queued → running → delivered) is patched in place
// through `POST /pubsub/deliveries:batchGet`, wherever the reader is; the
// outcome switch's counts are read again on their own, so they stay true
// while the reader is far down the list.

import { Button, DropdownMenu, Tabs, Tooltip } from '@cloudflare/kumo'
import {
  ArrowClockwiseIcon,
  CaretDownIcon,
  CheckIcon,
  CopyIcon,
  LightningIcon,
  ListMagnifyingGlassIcon,
  PencilSimpleIcon,
  SidebarSimpleIcon,
} from '@phosphor-icons/react'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import type { PubsubDeliveryCounts } from '@/api/generated/messaging/PubsubDeliveryCounts'
import type { PubsubDeliveryRow } from '@/api/generated/messaging/PubsubDeliveryRow'
import type { PubsubFunctionMark } from '@/api/generated/messaging/PubsubFunctionMark'
import type { PubsubFunctionTarget } from '@/api/generated/messaging/PubsubFunctionTarget'
import { statusQuery } from '@/api/queries'
import {
  DataTable,
  type DataTableColumn,
  useHiddenColumnCount,
} from '@/components/console/data-table'
import { EmptyState, NoMatch, QueryError } from '@/components/console/empty-state'
import { MatchCount } from '@/components/console/match-count'
import { OutcomeChip } from '@/components/console/outcome-chip'
import { RelativeTime } from '@/components/console/relative-time'
import { RequiresNotice } from '@/components/console/requires-notice'
import type { RowMenuItem } from '@/components/console/row-menu'
import { sectionStatus } from '@/components/console/section-gate'
import { TableFooter } from '@/components/console/table-footer'
import { ToolbarRow } from '@/components/console/toolbar'
import type { CursorPages } from '@/components/console/use-cursor-rows'
import { useCursorRows } from '@/components/console/use-cursor-rows'
import { formatDuration, formatNumber } from '@/lib/format'
import { linkTo } from '@/lib/links'
import type { SubscriptionStatus } from '@/lib/live/channel'
import { createInvalidator } from '@/lib/live/use-live-topic'
import { linkToLogs } from '@/lib/sections/logs'
import { type SectionLink, sectionById } from '@/lib/services'
import { useShortcuts } from '@/lib/shortcuts'
import { toast } from '@/lib/toasts'
import { rowElement } from '@/messaging/confirm-popover'
import { useDeliveriesLive } from '../live'
import { shortName } from '../names'
import { deliveryCountsQuery, deliveryList, pubsubKeys } from '../queries'
import { deliveryDetail, functionMark } from '../states'
import { type MessageTab, MessageInspector } from './message-inspector'
import { useRunAgain } from './run-again'

const NOUN = { one: 'delivery', other: 'deliveries' }
const TABLE = 'pubsub-delivery-table'

/** What the page's Deliveries tab reads from its search parameters, and writes. */
export interface DeliveriesSearch {
  function?: string | undefined
  outcome?: PubsubFunctionMark | undefined
  message?: string | undefined
  tab?: MessageTab | undefined
}

/** The outcome switch's choices, in order: what a reader looks for first leads. */
const OUTCOMES: readonly ('all' | PubsubFunctionMark)[] = [
  'all',
  'delivered',
  'failed',
  'running',
  'queued',
  'skipped',
  'not-kept',
]

const OUTCOME_NAMES: Record<'all' | PubsubFunctionMark, string> = {
  all: 'All',
  delivered: 'Delivered',
  failed: 'Failed',
  running: 'Running',
  queued: 'Queued',
  skipped: 'Skipped',
  'not-kept': 'Not kept',
}

/** Each choice's count; "not kept" is what `all` holds beyond the outcomes the engine counts. */
export function outcomeCounts(
  counts: PubsubDeliveryCounts,
): Record<'all' | PubsubFunctionMark, number> {
  const known = counts.queued + counts.running + counts.delivered + counts.failed + counts.skipped
  return {
    all: counts.all,
    delivered: counts.delivered,
    failed: counts.failed,
    running: counts.running,
    queued: counts.queued,
    skipped: counts.skipped,
    'not-kept': Math.max(0, counts.all - known),
  }
}

/**
 * The choices the switch shows: All, Delivered and Failed always (a reader
 * looks for those, and the control should not change shape under them),
 * the rest while they count something or are chosen.
 */
export function shownOutcomes(
  counts: Record<'all' | PubsubFunctionMark, number>,
  chosen: PubsubFunctionMark | undefined,
): ('all' | PubsubFunctionMark)[] {
  return OUTCOMES.filter(
    (value) =>
      value === 'all' ||
      value === 'delivered' ||
      value === 'failed' ||
      value === chosen ||
      counts[value] > 0,
  )
}

/**
 * The Deliveries tab's own line: which function (when the topic has more
 * than one), then the outcome switch with its counts (labels only below
 * `xl`, the counts in their tooltips). On a line of its own, under the
 * tabs, as the Messages tab's filters are: beside five tabs at 1024 px
 * there is no room for it.
 */
export function DeliveriesSwitch({
  project,
  topic,
  functions,
  functionId,
  outcome,
  onFunction,
  onOutcome,
}: {
  project: string
  topic: string
  functions: readonly PubsubFunctionTarget[]
  functionId: string | undefined
  outcome: PubsubFunctionMark | undefined
  onFunction: (functionId: string | undefined) => void
  onOutcome: (outcome: PubsubFunctionMark | undefined) => void
}) {
  const counts = useQuery(deliveryCountsQuery(project, topic, functionId))
  const figures = outcomeCounts(
    counts.data ?? { all: 0, queued: 0, running: 0, delivered: 0, failed: 0, skipped: 0 },
  )
  const chosen = functions.find((target) => target.functionId === functionId)
  const topicId = shortName(topic)
  return (
    <span className="flex shrink-0 items-center gap-2" data-testid="pubsub-deliveries-switch">
      {functions.length > 1 && (
        <DropdownMenu>
          <DropdownMenu.Trigger
            render={
              <Button
                variant="ghost"
                size="sm"
                icon={<LightningIcon />}
                data-testid="pubsub-deliveries-function"
              >
                <span className="flex items-center gap-1">
                  {chosen ? (
                    <span className="font-mono text-[12px]">{chosen.name}</span>
                  ) : (
                    'All functions'
                  )}
                  <CaretDownIcon size={12} />
                </span>
              </Button>
            }
          />
          <DropdownMenu.Content align="end">
            <DropdownMenu.Item onClick={() => onFunction(undefined)}>
              <span className="flex flex-1 items-center justify-between gap-3">
                All functions
                {functionId === undefined && <CheckIcon size={12} />}
              </span>
            </DropdownMenu.Item>
            {functions.map((target) => (
              <DropdownMenu.Item
                key={target.functionId}
                icon={LightningIcon}
                onClick={() => onFunction(target.functionId)}
                data-testid={`pubsub-deliveries-function-${target.name}`}
              >
                <span className="flex flex-1 items-center justify-between gap-3">
                  <span className="font-mono text-[12px]">{target.name}</span>
                  <span className="text-[11px] text-kumo-subtle">{target.region}</span>
                  {functionId === target.functionId && <CheckIcon size={12} />}
                </span>
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Content>
        </DropdownMenu>
      )}
      <Tabs
        variant="segmented"
        size="sm"
        value={outcome ?? 'all'}
        onValueChange={(next) =>
          onOutcome(next === 'all' ? undefined : (next as PubsubFunctionMark))
        }
        tabs={shownOutcomes(figures, outcome).map((value) => ({
          value,
          label: (
            <Tooltip
              content={`${formatNumber(figures[value])} ${value === 'all' ? 'deliveries' : OUTCOME_NAMES[value].toLowerCase()} among those the engine keeps for ${topicId}`}
              render={
                <span data-testid={`deliveries-outcome-${value}`}>
                  {OUTCOME_NAMES[value]}
                  <span className="hidden font-mono text-[11px] tabular-nums xl:inline">
                    {' '}
                    {formatNumber(figures[value])}
                  </span>
                </span>
              }
            />
          ),
        }))}
      />
    </span>
  )
}

/** A delivery's outcome as a chip: the dot breathes while it runs. */
export function DeliveryOutcome({ row }: { row: PubsubDeliveryRow }) {
  const look = functionMark(row.mark)
  const detail = deliveryDetail(row)
  // A word, not data: the sans face, as the backlog's states are.
  return (
    <span className="inline-flex align-middle font-sans">
      <OutcomeChip
        word={look.word}
        tone={look.tone}
        pulse={row.mark === 'running'}
        {...(detail && row.mark !== 'failed' ? { detail } : {})}
      />
    </span>
  )
}

export const DELIVERY_COLUMNS: readonly DataTableColumn<PubsubDeliveryRow>[] = [
  {
    id: 'when',
    header: 'When',
    width: 96,
    cell: (row) => <RelativeTime iso={row.startedAt ?? row.publishedAt} />,
    copy: (row) => row.startedAt ?? row.publishedAt,
  },
  {
    id: 'message',
    header: 'Message',
    width: 80,
    align: 'end',
    cell: (row) => row.messageId,
    copy: (row) => row.messageId,
  },
  {
    id: 'function',
    header: 'Function',
    width: 200,
    cell: (row) => (
      <span className="inline-flex min-w-0 items-center gap-1.5 align-middle">
        <span className="truncate">{row.functionName}</span>
        {row.redelivery && (
          <Tooltip
            content="Run again from the console: this function alone, with a new event id"
            render={
              <span
                className="shrink-0 rounded bg-kumo-tint px-1 font-sans text-[11px] text-kumo-subtle"
                data-testid="delivery-again"
              >
                run again
              </span>
            }
          />
        )}
      </span>
    ),
    copy: (row) => row.functionId,
  },
  {
    id: 'outcome',
    header: 'Outcome',
    width: 136,
    cell: (row) => <DeliveryOutcome row={row} />,
    copy: (row) => row.mark,
  },
  {
    id: 'took',
    header: 'Took',
    width: 72,
    align: 'end',
    cell: (row) =>
      row.durationMs === null ? (
        <span className="text-kumo-inactive">—</span>
      ) : (
        formatDuration(row.durationMs)
      ),
    copy: (row) => (row.durationMs === null ? '' : String(row.durationMs)),
  },
  {
    id: 'detail',
    header: 'Detail',
    width: 360,
    cell: (row) => {
      const detail = deliveryDetail(row)
      if (!detail) return <span className="text-kumo-inactive">—</span>
      return (
        <span className={row.mark === 'failed' ? 'text-kumo-default' : 'text-kumo-subtle'}>
          {row.mark === 'failed' ? detail : <span className="font-sans">{detail}</span>}
        </span>
      )
    },
    copy: (row) => deliveryDetail(row) ?? '',
  },
]

export function DeliveriesView({
  project,
  topic,
  functions,
  search,
  update,
  onLiveStatus,
  onOpenSubscription,
  onEditAgain,
}: {
  project: string
  topic: string
  /** The functions listening on the topic now. */
  functions: readonly PubsubFunctionTarget[]
  search: DeliveriesSearch
  update: (patch: Partial<DeliveriesSearch>, options?: { replace?: boolean }) => void
  onLiveStatus: (status: SubscriptionStatus) => void
  onOpenSubscription: (name: string) => void
  /** Opens the composer filled with a message (Shift+R). */
  onEditAgain: (messageId: string) => void
}) {
  const status = useQuery(statusQuery)
  const functionsState = sectionStatus(status.data?.sections, 'functions').state
  if (status.data && functionsState !== 'ready')
    return (
      <div className="flex min-h-0 flex-1 flex-col" data-testid="pubsub-deliveries">
        <RequiresNotice section="functions" for="Delivering messages to functions" />
      </div>
    )
  return (
    <DeliveriesTable
      key={`${search.function ?? ''}\u0000${search.outcome ?? ''}`}
      project={project}
      topic={topic}
      functions={functions}
      search={search}
      update={update}
      onLiveStatus={onLiveStatus}
      onOpenSubscription={onOpenSubscription}
      onEditAgain={onEditAgain}
    />
  )
}

function DeliveriesTable({
  project,
  topic,
  functions,
  search,
  update,
  onLiveStatus,
  onOpenSubscription,
  onEditAgain,
}: {
  project: string
  topic: string
  functions: readonly PubsubFunctionTarget[]
  search: DeliveriesSearch
  update: (patch: Partial<DeliveriesSearch>, options?: { replace?: boolean }) => void
  onLiveStatus: (status: SubscriptionStatus) => void
  onOpenSubscription: (name: string) => void
  onEditAgain: (messageId: string) => void
}) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const topicId = shortName(topic)
  const functionId = search.function
  const outcome = search.outcome
  const list = deliveryList(project, topic, functionId, outcome)
  const query = useInfiniteQuery(list.options)
  const cursor = useCursorRows(query, list)
  const rows = cursor.rows
  const runAgain = useRunAgain(project, topic)

  // The counts are read again on their own, at most four times a second.
  const [invalidator] = useState(() =>
    createInvalidator((key) => void queryClient.invalidateQueries({ queryKey: key }), 250),
  )
  useEffect(() => () => invalidator.dispose(), [invalidator])
  const countsKey = pubsubKeys.deliveryCounts(project, topic, functionId)

  // Following the head.
  const [newAbove, setNewAbove] = useState(0)
  const refetching = useRef<{ running: boolean; again: boolean }>({ running: false, again: false })
  const readHead = async () => {
    const state = refetching.current
    if (state.running) {
      state.again = true
      return
    }
    state.running = true
    try {
      await queryClient.refetchQueries({ queryKey: list.queryKey, exact: true })
    } finally {
      state.running = false
      if (state.again) {
        state.again = false
        void readHead()
      }
    }
  }
  const live = useDeliveriesLive(project, topic, {
    onKeys: (keys) => {
      cursor.applyKeys(keys)
      invalidator.push([countsKey])
    },
    onAdded: (added) => {
      invalidator.push([countsKey])
      const data = queryClient.getQueryData<CursorPages<PubsubDeliveryRow>>(list.queryKey)
      // A first page still on its way may have been read before these: read it again.
      if (!data || (!cursor.hasPrevious && data.pages.length <= 2)) void readHead()
      else setNewAbove((count) => count + added)
    },
    onReset: () => {
      setNewAbove(0)
      cursor.reset()
      invalidator.push([countsKey])
    },
  })
  useEffect(() => onLiveStatus(live), [live, onLiveStatus])

  // The row in the inspector: the one clicked, else the newest of its message.
  const [openEvent, setOpenEvent] = useState<string | undefined>(undefined)
  const openRow =
    search.message === undefined
      ? undefined
      : (rows.find((row) => row.eventId === openEvent && row.messageId === search.message) ??
        rows.find((row) => row.messageId === search.message))
  const open = (row: PubsubDeliveryRow, options?: { replace?: boolean }) => {
    setOpenEvent(row.eventId)
    update({ message: row.messageId, tab: 'deliveries' }, options)
  }

  const [cursorKey, setCursorKey] = useState<string | undefined>(undefined)
  const cursorRow = rows.find((row) => row.eventId === cursorKey)
  const logsOf = deliveryLogs
  const openLogs = (row: PubsubDeliveryRow) => {
    const link = logsOf(row)
    if (link) void navigate({ to: link.to as never, search: link.search as never })
  }
  const askAgain = (row: PubsubDeliveryRow) => runAgain.ask(row, rowElement(TABLE, row.eventId))

  useShortcuts({ id: 'pubsub-deliveries', label: 'Deliveries' }, [
    {
      key: 'Escape',
      label: 'Close the message',
      when: () => search.message !== undefined,
      run: () => update({ message: undefined, tab: undefined }),
    },
    {
      key: 'r',
      label: 'Run the function again with the message',
      when: () => cursorRow !== undefined,
      run: () => {
        if (cursorRow) askAgain(cursorRow)
      },
    },
    {
      key: 'Shift+R',
      label: 'Edit the message, then publish it',
      when: () => cursorRow !== undefined,
      run: () => {
        if (cursorRow) onEditAgain(cursorRow.messageId)
      },
    },
    {
      key: 'l',
      label: 'Open the delivery’s logs',
      when: () => cursorRow !== undefined && logsOf(cursorRow) !== null,
      run: () => {
        if (cursorRow) openLogs(cursorRow)
      },
    },
  ])

  const rowMenu = (row: PubsubDeliveryRow): RowMenuItem[] => {
    const invocation = row.invocation ? linkTo(row.invocation) : null
    return [
      {
        id: 'open',
        label: 'Open the message',
        icon: SidebarSimpleIcon,
        shortcut: 'Enter',
        run: () => open(row),
      },
      {
        id: 'again',
        label: `Run ${row.functionName} again…`,
        icon: ArrowClockwiseIcon,
        shortcut: 'r',
        run: () => askAgain(row),
      },
      {
        id: 'edit-again',
        label: 'Edit and publish…',
        icon: PencilSimpleIcon,
        shortcut: 'Shift+R',
        run: () => onEditAgain(row.messageId),
      },
      {
        id: 'invocation',
        label: 'Open the invocation',
        icon: LightningIcon,
        disabled: !row.invocation
          ? row.mark === 'not-kept'
            ? 'The engine no longer keeps this invocation.'
            : 'It has not run yet.'
          : invocation === null
            ? 'Functions is not shown in this console yet.'
            : undefined,
        run: () => {
          if (invocation)
            void navigate({ to: invocation.to as never, search: invocation.search as never })
        },
      },
      {
        id: 'logs',
        label: 'Logs',
        icon: ListMagnifyingGlassIcon,
        shortcut: 'l',
        disabled: logsOf(row) === null ? 'Logs is not shown in this console yet.' : undefined,
        run: () => openLogs(row),
      },
      {
        id: 'copy-event',
        label: 'Copy event id',
        icon: CopyIcon,
        run: () => {
          void navigator.clipboard
            .writeText(row.eventId)
            .then(() => toast({ key: 'pubsub-copy', title: `Copied ${row.eventId}` }))
            .catch(() => toast({ key: 'pubsub-copy', title: 'Could not copy', tone: 'danger' }))
        },
      },
    ]
  }

  const stepTo = (step: -1 | 1) => {
    const at = openRow ? rows.indexOf(openRow) : -1
    const row = at === -1 ? undefined : rows[at + step]
    return row ? () => open(row, { replace: true }) : undefined
  }
  const hidden = useHiddenColumnCount('pubsub.deliveries', DELIVERY_COLUMNS)
  const narrowed = functionId !== undefined || outcome !== undefined
  const chosen = functions.find((target) => target.functionId === functionId)

  const empty = narrowed ? (
    <NoMatch
      filter={[
        chosen?.name ?? (functionId ? shortName(functionId) : undefined),
        outcome && OUTCOME_NAMES[outcome].toLowerCase(),
      ]
        .filter(Boolean)
        .join(' · ')}
      onClear={() => update({ function: undefined, outcome: undefined }, { replace: true })}
      noun="deliveries"
    />
  ) : functions.length === 0 ? (
    <EmptyState
      icon={LightningIcon}
      title={`No function listens on ${topicId}`}
      description={`A function exported with onMessagePublished('${topicId}', …) runs for every message published here, and each run is listed here with how it went.`}
      testId="pubsub-deliveries-empty"
    />
  ) : (
    <EmptyState
      icon={LightningIcon}
      title="No deliveries yet"
      description={`${functions.map((target) => target.name).join(', ')} ${functions.length === 1 ? 'runs' : 'run'} for every message published to ${topicId}; each run is listed here with how it went.`}
      testId="pubsub-deliveries-empty"
    />
  )

  return (
    <>
      <ToolbarRow variant="line" testId="pubsub-deliveries-line">
        <DeliveriesSwitch
          project={project}
          topic={topic}
          functions={functions}
          functionId={functionId}
          outcome={outcome}
          onFunction={(next) =>
            update({ function: next, message: undefined, tab: undefined }, { replace: true })
          }
          onOutcome={(next) =>
            update({ outcome: next, message: undefined, tab: undefined }, { replace: true })
          }
        />
        <span className="min-w-0 flex-1" />
        <MatchCount
          total={cursor.total}
          noun={NOUN}
          loading={query.isPending}
          widest="000,000"
          tooltip={`Deliveries of ${topicId}'s messages to functions${narrowed ? ' that match' : ''}, among the messages the engine keeps; each run again is one more.`}
          testId="pubsub-deliveries-count"
        />
      </ToolbarRow>
      <div className="relative flex min-h-0 flex-1" data-testid="pubsub-deliveries">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {query.isError && rows.length === 0 ? (
            <QueryError error={query.error} onRetry={() => void query.refetch()} section="pubsub" />
          ) : (
            <DataTable
              ariaLabel={`Deliveries of ${topicId} to functions`}
              rows={rows}
              rowKey={(row) => row.eventId}
              columns={DELIVERY_COLUMNS}
              memoryKey="pubsub.deliveries"
              openKey={openRow?.eventId}
              onOpen={(row) => open(row)}
              onCursorChange={(row) => {
                setCursorKey(row.eventId)
                if (search.message !== undefined && openRow?.eventId !== row.eventId)
                  open(row, { replace: true })
              }}
              rowClick="open"
              flashes={cursor.flashes}
              hasMore={cursor.hasMore}
              loadMore={cursor.loadMore}
              hasPrevious={cursor.hasPrevious}
              loadPrevious={cursor.loadPrevious}
              rowOffset={cursor.rowOffset}
              total={cursor.total}
              anchor="key"
              {...(newAbove > 0 ? { newAbove } : {})}
              onShowNew={() => {
                setNewAbove(0)
                cursor.reset()
              }}
              rowMenu={rowMenu}
              loading={query.isPending}
              empty={empty}
              footer={
                rows.length > 0 ? (
                  <TableFooter
                    loaded={rows.length}
                    rowOffset={cursor.rowOffset}
                    total={cursor.total}
                    hasMore={cursor.hasMore}
                    hiddenColumns={hidden.hidden}
                    onShowAll={hidden.showAll}
                    noun={NOUN}
                    testId="pubsub-deliveries-footer"
                  />
                ) : undefined
              }
              testId={TABLE}
            />
          )}
        </div>
        {search.message !== undefined && (
          <MessageInspector
            project={project}
            topic={topic}
            id={search.message}
            tab={search.tab ?? 'deliveries'}
            onTab={(tab) => update({ tab }, { replace: true })}
            onClose={() => update({ message: undefined, tab: undefined })}
            onPrev={stepTo(-1)}
            onNext={stepTo(1)}
            onOpenSubscription={onOpenSubscription}
            onEditAgain={onEditAgain}
          />
        )}
        {runAgain.element}
      </div>
    </>
  )
}

/**
 * Where a delivery's logs open: Logs filtered by the function and, once it
 * ran, its invocation; null while the Logs section is not shown here.
 */
export function deliveryLogs(
  row: Pick<PubsubDeliveryRow, 'functionId' | 'invocation'>,
): SectionLink | null {
  if (!sectionById('logs')?.built) return null
  return linkToLogs({
    function: row.functionId,
    ...(row.invocation ? { execution: row.invocation.key } : {}),
  })
}
