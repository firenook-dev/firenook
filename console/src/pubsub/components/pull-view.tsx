// Pulling as a subscriber does (S9): the messages are leased to this tab
// until it acks or nacks them, or the lease runs out. A pull here competes
// with whatever app is connected, and the page says so before the button.
// Received rows keep their ack ids in the tab's pull store, never in the
// URL; a lease that ran out is said, and its row loses its own buttons —
// ticked, it can still be acked from the selection bar, so what the engine
// answers to a stale ack id (nothing, or INVALID_ARGUMENT when the
// subscription delivers exactly once) is there to see.

import { Button, Checkbox, Input, Select, Tooltip } from '@cloudflare/kumo'
import {
  ArrowCounterClockwiseIcon,
  CheckIcon,
  ClockCounterClockwiseIcon,
  DownloadSimpleIcon,
  TrayArrowDownIcon,
} from '@phosphor-icons/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { errorText } from '@/lib/error-text'
import type { PubsubSubscription } from '@/api/generated/messaging/PubsubSubscription'
import type { PubsubSubscriptionCounters } from '@/api/generated/messaging/PubsubSubscriptionCounters'
import { DataTable, type DataTableColumn } from '@/components/console/data-table'
import { EmptyState } from '@/components/console/empty-state'
import type { RowMenuItem } from '@/components/console/row-menu'
import { SectionBanner } from '@/components/console/section-banner'
import { SelectionBar } from '@/components/console/selection-bar'
import { ToolbarRow } from '@/components/console/toolbar'
import { StatusDot } from '@/components/kit'
import { useNow } from '@/lib/clock'
import { formatNumber } from '@/lib/format'
import { useShortcuts } from '@/lib/shortcuts'
import { acknowledge, getBacklog, modifyDeadline, pull, setPushConfig } from '../api'
import { useTopicLive } from '../live'
import { shortName } from '../names'
import { previewText } from '../payload'
import { pubsubKeys } from '../queries'
import {
  type Outstanding,
  type PulledRow,
  attemptsToNote,
  leaseExpired,
  lostLeases,
  pulledSummary,
  usePulled,
} from '../pull-store'
import { countdownText } from '../states'
import { AttributeChips } from './message-table'

/** The ack deadlines a pull can ask for, seconds. */
export const PULL_DEADLINES = [10, 30, 60, 300, 600] as const

/** What +60 s adds to a lease. */
const EXTEND_SECONDS = 60

const NOUN = { one: 'message', other: 'messages' }

function deadlineLabel(seconds: number): string {
  return seconds < 60 ? `${seconds} s` : `${seconds / 60} min`
}

/** The sentence a push subscription shows in place of the pull form. */
export const PUSH_PULL_SENTENCE =
  'A push subscription delivers to its endpoint, so a pull here would get nothing. Switch it to pull to pull here.'

/** "1 subscriber is connected to orders-worker. Pulling here takes messages away from it." */
export function consumersWarning(connected: number, subscriptionId: string): string {
  return `${connected === 1 ? '1 subscriber is' : `${formatNumber(connected)} subscribers are`} connected to ${subscriptionId}. Pulling here takes messages away from ${connected === 1 ? 'it' : 'them'}.`
}

/** JSON written compactly, as the lists show it; any other text as it is. */
function compactText(text: string | null, json: boolean): string {
  if (text === null) return ''
  if (!json) return text
  try {
    return JSON.stringify(JSON.parse(text))
  } catch {
    return text
  }
}

/** The row as drawn: marked when the engine ended its lease early. */
function withLost(row: PulledRow, lost: ReadonlySet<string>): PulledRow {
  return lost.has(row.ackId) ? Object.assign({}, row, { lost: true }) : row
}

/** A received row's lease as words: counting down while this tab holds it. */
function LeaseCell({ row }: { row: PulledRow }) {
  const now = useNow('second')
  if (row.outcome === 'acked') return <StatusDot tone="success" label="acked" />
  if (row.outcome === 'nacked') return <StatusDot tone="neutral" label="nacked" />
  if (leaseExpired(row, now))
    return (
      <Tooltip
        content="The lease ran out: another consumer may have it now."
        render={
          <span>
            <StatusDot tone="warning" label="expired" />
          </span>
        }
      />
    )
  return <StatusDot tone="brand" label={countdownText(row.leaseExpiresAt, now)} />
}

const PULLED_COLUMNS: readonly DataTableColumn<PulledRow>[] = [
  { id: 'id', header: 'id', width: 72, align: 'end', cell: (row) => row.message.id },
  {
    id: 'lease',
    header: 'Lease',
    width: 120,
    cell: (row) => (
      <span className="inline-flex font-sans align-middle">
        <LeaseCell row={row} />
      </span>
    ),
  },
  {
    id: 'attempt',
    header: 'Attempt',
    width: 84,
    align: 'end',
    cell: (row) => formatNumber(row.deliveryAttempt),
  },
  {
    id: 'data',
    header: 'Data',
    width: 360,
    cell: (row) => {
      // As the engine previews a list row: compact JSON, the first 256 characters.
      const text = compactText(row.message.dataText, row.message.dataJson)
      const preview = {
        encoding: row.message.dataText === null ? 'binary' : row.message.dataJson ? 'json' : 'text',
        text: text.slice(0, 256),
        truncated: text.length > 256,
      } as const
      return (
        <span className={row.message.dataText === null ? 'text-kumo-subtle' : undefined}>
          {previewText(preview, row.message.size)}
        </span>
      )
    },
    copy: (row) => row.message.dataText ?? row.message.dataBase64,
  },
  {
    id: 'attributes',
    header: 'Attributes',
    width: 200,
    cell: (row) => <AttributeChips attributes={row.message.attributes} />,
  },
]

export function PullView({
  project,
  subscription,
  config,
  counters,
}: {
  project: string
  /** The subscription's full name. */
  subscription: string
  config: PubsubSubscription
  counters: PubsubSubscriptionCounters | undefined
}) {
  const queryClient = useQueryClient()
  const subscriptionId = shortName(subscription)
  const stored = usePulled((state) => (state.subscription === subscription ? state.rows : NO_ROWS))
  const receive = usePulled((state) => state.receive)
  const mark = usePulled((state) => state.mark)
  const extend = usePulled((state) => state.extend)
  const keepOnly = usePulled((state) => state.keepOnly)
  useEffect(() => keepOnly(subscription), [keepOnly, subscription])

  const [max, setMax] = useState('10')
  const [deadline, setDeadline] = useState<number>(
    (PULL_DEADLINES as readonly number[]).includes(config.ackDeadlineSeconds)
      ? config.ackDeadlineSeconds
      : 60,
  )
  const [autoAck, setAutoAck] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const count = Number(max)
  const maxValid = Number.isInteger(count) && count >= 1 && count <= 1000

  // Which leases the engine still holds for this tab: its outstanding
  // messages, read again whenever the backlog moves (a lease returned from
  // the Backlog tab, a purge, a redelivery to someone else).
  const heldKey = [...pubsubKeys.subscriptionBacklog(project, subscription), 'held'] as const
  const holding = stored.some((row) => row.outcome === undefined)
  const outstanding = useQuery({
    queryKey: heldKey,
    queryFn: async ({ signal }): Promise<Outstanding> => {
      const readAt = Date.now()
      const page = await getBacklog({ subscription, state: 'outstanding' }, { limit: 500 }, signal)
      return {
        complete: page.nextCursor === null,
        readAt,
        rows: page.items.map((row) => ({ id: row.id, attempts: row.attempts })),
      }
    },
    enabled: holding && config.pushEndpoint === null,
    // What happened while this tab was not on screen is read on the way back.
    staleTime: 0,
    refetchOnMount: 'always',
  })
  useTopicLive(project, config.summary.topic ?? undefined, subscription, {
    onBacklogKeys: () => void queryClient.invalidateQueries({ queryKey: heldKey, exact: true }),
    onReset: () => void queryClient.invalidateQueries({ queryKey: heldKey, exact: true }),
    // Leases read before the engine took the subscription are read again, from now.
    onTaken: () => void queryClient.invalidateQueries({ queryKey: heldKey, exact: true }),
  })
  const noteAttempts = usePulled((state) => state.noteAttempts)
  useEffect(() => {
    const notes = attemptsToNote(usePulled.getState().rows, outstanding.data)
    if (notes.size > 0) noteAttempts(notes)
  }, [outstanding.data, noteAttempts])
  const lost = lostLeases(stored, outstanding.data)
  const rows = lost.size === 0 ? stored : stored.map((row) => withLost(row, lost))

  const refreshCounts = () => {
    void queryClient.invalidateQueries({ queryKey: pubsubKeys.subscription(project, subscription) })
    void queryClient.invalidateQueries({ queryKey: heldKey, exact: true })
  }
  const pulling = useMutation({
    mutationFn: async () => {
      const answer = await pull({ subscription, max: count, ackDeadlineSeconds: deadline })
      const at = new Date()
      receive(subscription, answer.received, at)
      if (autoAck && answer.received.length > 0) {
        const ackIds = answer.received.map((item) => item.ackId)
        await acknowledge({ subscription, ackIds })
        mark(ackIds, 'acked')
      }
      return answer.received.length
    },
    onMutate: () => setError(undefined),
    onSuccess: (received) => {
      if (received === 0) setError(`Nothing was waiting at ${subscriptionId}.`)
      refreshCounts()
    },
    onError: (failure) => setError(errorText(failure)),
  })
  const act = useMutation({
    mutationFn: async ({ verb, ackIds }: { verb: 'ack' | 'nack' | 'extend'; ackIds: string[] }) => {
      if (verb === 'ack') await acknowledge({ subscription, ackIds })
      else
        await modifyDeadline({
          subscription,
          ackIds,
          seconds: verb === 'nack' ? 0 : EXTEND_SECONDS,
        })
      return { verb, ackIds }
    },
    onMutate: () => setError(undefined),
    onSuccess: ({ verb, ackIds }) => {
      if (verb === 'extend') extend(ackIds, EXTEND_SECONDS)
      else mark(ackIds, verb === 'ack' ? 'acked' : 'nacked')
      clearSelection()
      refreshCounts()
    },
    onError: (failure) => setError(errorText(failure)),
  })
  const run = (verb: 'ack' | 'nack' | 'extend', ackIds: string[]) => {
    if (ackIds.length > 0) act.mutate({ verb, ackIds })
  }

  const switchToPull = useMutation({
    mutationFn: () => setPushConfig({ subscription, endpoint: null }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: pubsubKeys.subscription(project, subscription),
      })
      void queryClient.invalidateQueries({ queryKey: pubsubKeys.topics(project) })
    },
  })

  // Ticked rows.
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set())
  const clearSelection = () => setChecked(new Set())
  const ticked = rows.filter((row) => checked.has(row.ackId))

  // The focused row's keys.
  const now = useNow('second')
  const [cursorKey, setCursorKey] = useState<string | undefined>()
  const cursorRow = rows.find((row) => row.ackId === cursorKey)
  const holds = (row: PulledRow | undefined): row is PulledRow =>
    row !== undefined && row.outcome === undefined && !leaseExpired(row, now)
  useShortcuts({ id: 'pubsub-pull', label: 'Pull' }, [
    {
      key: 'a',
      label: 'Acknowledge the message',
      when: () => holds(cursorRow),
      run: () => cursorRow && run('ack', [cursorRow.ackId]),
    },
    {
      key: 'x',
      label: 'Nack the message: it goes back at once',
      when: () => holds(cursorRow),
      run: () => cursorRow && run('nack', [cursorRow.ackId]),
    },
    {
      key: 'e',
      label: 'Extend the lease by 60 seconds',
      when: () => holds(cursorRow),
      run: () => cursorRow && run('extend', [cursorRow.ackId]),
    },
  ])

  if (config.pushEndpoint !== null)
    return (
      <EmptyState
        icon={TrayArrowDownIcon}
        title="This subscription pushes"
        description={PUSH_PULL_SENTENCE}
        actions={
          <Button
            variant="secondary"
            icon={<DownloadSimpleIcon />}
            loading={switchToPull.isPending}
            onClick={() => switchToPull.mutate()}
            data-testid="pubsub-switch-to-pull"
          >
            Switch to pull
          </Button>
        }
        testId="pubsub-pull-push-note"
      />
    )

  const connected = counters ? counters.consumers.streaming + counters.consumers.waitingPulls : 0
  const leased = rows.filter(holds)

  const rowMenu = (row: PulledRow): RowMenuItem[] => {
    const stale = !holds(row)
    const reason = row.outcome
      ? `It was ${row.outcome} already.`
      : 'The lease ran out: tick the row to ack it anyway and see what the engine answers.'
    return [
      {
        id: 'ack',
        label: 'Ack',
        icon: CheckIcon,
        shortcut: 'a',
        disabled: stale ? reason : undefined,
        run: () => run('ack', [row.ackId]),
      },
      {
        id: 'nack',
        label: 'Nack',
        icon: ArrowCounterClockwiseIcon,
        shortcut: 'x',
        disabled: stale ? reason : undefined,
        run: () => run('nack', [row.ackId]),
      },
      {
        id: 'extend',
        label: `+${EXTEND_SECONDS} s`,
        icon: ClockCounterClockwiseIcon,
        shortcut: 'e',
        disabled: stale ? reason : undefined,
        run: () => run('extend', [row.ackId]),
      },
    ]
  }

  return (
    <>
      {connected > 0 && (
        <SectionBanner tone="warning" testId="pubsub-pull-consumers">
          {consumersWarning(connected, subscriptionId)}
        </SectionBanner>
      )}
      <ToolbarRow
        variant="line"
        testId="pubsub-pull-form"
        overlay={
          ticked.length > 0 ? (
            <SelectionBar
              count={ticked.length}
              everything={false}
              filtered={false}
              noun={NOUN}
              onClear={clearSelection}
              testId="pubsub-pull-selection"
              actions={
                <>
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<CheckIcon />}
                    loading={act.isPending}
                    onClick={() =>
                      run(
                        'ack',
                        ticked.map((row) => row.ackId),
                      )
                    }
                    data-testid="pubsub-pull-selection-ack"
                  >
                    Ack {formatNumber(ticked.length)}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<ArrowCounterClockwiseIcon />}
                    onClick={() =>
                      run(
                        'nack',
                        ticked.map((row) => row.ackId),
                      )
                    }
                    data-testid="pubsub-pull-selection-nack"
                  >
                    Nack {formatNumber(ticked.length)}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<ClockCounterClockwiseIcon />}
                    onClick={() =>
                      run(
                        'extend',
                        ticked.map((row) => row.ackId),
                      )
                    }
                    data-testid="pubsub-pull-selection-extend"
                  >
                    +{EXTEND_SECONDS} s
                  </Button>
                </>
              }
            />
          ) : undefined
        }
      >
        <form
          className="flex min-w-0 flex-1 items-center gap-2 text-[12px] text-kumo-subtle"
          onSubmit={(event) => {
            event.preventDefault()
            if (maxValid && !pulling.isPending) pulling.mutate()
          }}
        >
          Pull
          <Input
            size="sm"
            type="number"
            min={1}
            max={1000}
            value={max}
            onChange={(event) => setMax(event.target.value)}
            aria-label="How many messages to pull"
            aria-invalid={!maxValid}
            className="w-18 font-mono"
            data-testid="pull-max"
          />
          messages · ack deadline
          <Select
            size="xs"
            value={deadline}
            onValueChange={(next) => setDeadline(Number(next))}
            aria-label="Ack deadline"
            renderValue={() => deadlineLabel(deadline)}
            className="h-6.5 w-24"
            data-testid="pull-deadline"
          >
            {PULL_DEADLINES.map((seconds) => (
              <Select.Option key={seconds} value={seconds}>
                {deadlineLabel(seconds)}
              </Select.Option>
            ))}
          </Select>
          <span className="ml-2">
            <Checkbox
              checked={autoAck}
              onCheckedChange={(next) => setAutoAck(Boolean(next))}
              label={<span className="text-[12px]">Ack as they arrive</span>}
              data-testid="pull-auto-ack"
            />
          </span>
          <Button
            variant="primary"
            size="sm"
            type="submit"
            icon={<TrayArrowDownIcon />}
            disabled={!maxValid}
            loading={pulling.isPending}
            className="ml-auto"
            data-testid="pull-submit"
          >
            Pull
          </Button>
        </form>
      </ToolbarRow>
      {error && (
        <p
          className="m-0 border-b border-kumo-hairline px-3 py-1.5 text-[12px] text-kumo-danger"
          role="alert"
          data-testid="pull-error"
        >
          {error}
        </p>
      )}
      <div className="flex min-h-0 flex-1 flex-col" data-testid="pubsub-pull">
        <DataTable
          ariaLabel={`Messages pulled from ${subscriptionId}`}
          rows={rows}
          rowKey={(row) => row.ackId}
          columns={PULLED_COLUMNS}
          memoryKey="pubsub.pull"
          rowClick="cursor"
          onCursorChange={(row) => setCursorKey(row.ackId)}
          selection={{
            checked,
            everything: false,
            onChange: (next) => setChecked(next),
          }}
          rowMenu={rowMenu}
          empty={
            <EmptyState
              icon={TrayArrowDownIcon}
              title="Nothing pulled in this tab yet"
              description={`A pull leases messages of ${subscriptionId} to this tab until you ack or nack them, or the lease runs out.`}
              testId="pubsub-pull-empty"
            />
          }
          footer={
            rows.length > 0 ? (
              <div className="flex h-8 items-center gap-2 border-t border-kumo-hairline px-3 text-[12px] text-kumo-subtle">
                <span className="tabular-nums" data-testid="pull-summary">
                  {pulledSummary(rows, now)}
                </span>
                <span className="ml-auto flex gap-1">
                  <Button
                    variant="ghost"
                    size="xs"
                    icon={<CheckIcon />}
                    disabled={leased.length === 0}
                    onClick={() =>
                      run(
                        'ack',
                        leased.map((row) => row.ackId),
                      )
                    }
                    data-testid="pull-ack-all"
                  >
                    Ack all
                  </Button>
                  <Button
                    variant="ghost"
                    size="xs"
                    icon={<ArrowCounterClockwiseIcon />}
                    disabled={leased.length === 0}
                    onClick={() =>
                      run(
                        'nack',
                        leased.map((row) => row.ackId),
                      )
                    }
                    data-testid="pull-nack-all"
                  >
                    Nack all
                  </Button>
                </span>
              </div>
            ) : undefined
          }
          testId="pubsub-pull-table"
        />
      </div>
    </>
  )
}

const NO_ROWS: PulledRow[] = []
