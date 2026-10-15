// One queue (S20…S22): row one is the queue — its id, location and the
// function it dispatches to, with Pause or Resume, Purge and Enqueue; row
// two is its tabs (Tasks, History, Configuration), then where its attempts
// are — every attempt is an invocation of the queue's function, so they
// are Functions › Invocations filtered to it — with the open tab's switch
// at the right end: the state counts and the slots, or the outcome counts.
// The tab draws the rest. The view holds the queue's one `tasks.queue`
// subscription, which the lists listen to.

import { Button, Tabs, Tooltip } from '@cloudflare/kumo'
import {
  ArrowRightIcon,
  LightningIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  QueueIcon,
  TrashIcon,
} from '@phosphor-icons/react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { type ReactNode, useState } from 'react'
import type { TasksOutcome } from '@/api/generated/messaging/TasksOutcome'
import type { TasksQueue } from '@/api/generated/messaging/TasksQueue'
import type { TasksQueueList } from '@/api/generated/messaging/TasksQueueList'
import { CopyButton } from '@/components/console/copy-button'
import { DangerConfirm } from '@/components/console/danger-confirm'
import { EntityLink } from '@/components/console/entity-link'
import { LiveNotice } from '@/components/console/live-notice'
import { SectionBody } from '@/components/console/section-page'
import { SectionToolbar, ToolbarDivider, ToolbarRow } from '@/components/console/toolbar'
import { PanelToggle } from '@/components/shell/section-panel'
import { Kbd } from '@/components/kit'
import { liveChannel } from '@/lib/live/channel'
import { formatNumber } from '@/lib/format'
import { useLinkTo } from '@/lib/links'
import { toast } from '@/lib/toasts'
import { useShortcuts } from '@/lib/shortcuts'
import { useTokens } from '@/messaging/windows'
import { holdQueue, pauseQueue, purgeQueue, resumeQueue } from '../api'
import { errorText } from '@/lib/error-text'
import { useTasksPalette } from '../palette'
import { tasksKeys } from '../queries'
import { QueueLiveContext, useQueueHub } from '../queue-live'
import { queueResourceName } from '../queue-address'
import { type TasksView, useTasksSearch } from '../search'
import { OUTCOMES, type StateFilter } from '../states'
import { HistoryView } from './history-table'
import { QueueConfig } from './queue-config'
import { RefusedBanners } from './refused-banner'
import { ReplacedBanner } from './replaced-banner'
import { useWide } from '../wide'
import { useTaskActions } from './task-actions'
import { type InspectorTab, TaskInspector } from './task-inspector'
import { TasksView as TasksTab } from './task-table'

/** A quiet chip in the queue's field: a state the queue is in that is not an alarm. */
function Chip({
  children,
  tooltip,
  testId,
}: {
  children: ReactNode
  tooltip: string
  testId: string
}) {
  return (
    <Tooltip
      content={tooltip}
      render={
        <span
          className="shrink-0 cursor-default rounded bg-kumo-tint px-1.5 text-[11px] leading-4 text-kumo-subtle"
          data-testid={testId}
        >
          {children}
        </span>
      }
    />
  )
}

/** Row one's queue: the path a developer reads, flat, with copy against its end. */
function QueueField({ queue }: { queue: TasksQueue }) {
  const name = queueResourceName(queue)
  return (
    <div
      className="flex h-8 min-w-0 flex-1 items-center rounded-lg pr-0.5 pl-2"
      data-testid="queue-field"
    >
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden text-[12px]">
        <QueueIcon size={14} className="shrink-0 text-kumo-subtle" />
        <span className="truncate font-mono text-kumo-default" data-testid="queue-field-id">
          {queue.id}
        </span>
        <span className="shrink-0 font-mono text-kumo-subtle">{queue.location}</span>
        {queue.function ? (
          <span
            className="flex min-w-0 shrink items-center gap-1"
            data-testid="queue-field-function"
          >
            <LightningIcon size={12} className="shrink-0 text-kumo-subtle" />
            <EntityLink entity={{ ...queue.function.functionRef, label: queue.function.name }} />
          </span>
        ) : (
          <span className="hidden truncate text-kumo-subtle xl:inline">registered by a client</span>
        )}
        {queue.paused && (
          <Chip
            tooltip="Nothing leaves the pending queue and no token is taken; running tasks finish. Console only."
            testId="queue-paused"
          >
            Paused
          </Chip>
        )}
        {queue.holdScheduled && (
          <Chip
            tooltip="Tasks scheduled for later wait as held until their time. Console only."
            testId="queue-holding"
          >
            Holding
          </Chip>
        )}
      </div>
      <CopyButton value={name} label="Copy the queue's name" testId="queue-copy" />
    </div>
  )
}

/** A tab's label with its figure: `Tasks 15`. */
export function TabLabel({ label, count }: { label: string; count?: number | undefined }) {
  return (
    <span className="flex items-center gap-1.5">
      {label}
      {count !== undefined && (
        <span className="font-mono text-[11px] text-kumo-subtle tabular-nums">
          {formatNumber(count)}
        </span>
      )}
    </span>
  )
}

/**
 * A switch item's label: its count beside it where there is room, else in
 * its tooltip (`useWide`), so the figure is on screen once either way.
 */
export function SwitchLabel({
  label,
  count,
  wide,
}: {
  label: string
  count: number
  wide: boolean
}) {
  if (wide) return <TabLabel label={label} count={count} />
  return (
    <Tooltip
      content={`${formatNumber(count)} ${label.toLowerCase()}`}
      render={<span className="cursor-default">{label}</span>}
    />
  )
}

/** `slots 2/2 · 4.1 tokens`, the bucket refilling on the shared clock. */
export function SlotsAndTokens({ queue }: { queue: TasksQueue }) {
  const { counters } = queue
  const tokens = useTokens(counters) ?? counters.tokens
  return (
    <Tooltip
      content={`${formatNumber(counters.slotsInUse)} of ${formatNumber(counters.slots)} dispatch slots busy (maxConcurrentDispatches). The token bucket refills ${formatNumber(counters.maxDispatchesPerSecond)} a second (maxDispatchesPerSecond), up to ${formatNumber(counters.maxTokens)}.`}
      render={
        <span
          className="shrink-0 cursor-default text-[12px] whitespace-nowrap text-kumo-subtle"
          data-testid="slots-tokens"
        >
          slots{' '}
          <span
            className={`font-mono tabular-nums ${counters.slotsInUse >= counters.slots && counters.slots > 0 ? 'text-kumo-warning' : 'text-kumo-default'}`}
          >
            {formatNumber(counters.slotsInUse)}/{formatNumber(counters.slots)}
          </span>{' '}
          · <span className="font-mono text-kumo-default tabular-nums">{tokens.toFixed(1)}</span>{' '}
          tokens
        </span>
      }
    />
  )
}

/**
 * Where the queue's attempts are: each is an invocation of the function the
 * queue dispatches to, listed live in Functions › Invocations with its
 * request, response, timing and logs. Absent for a queue a client
 * registered (its tasks go to a URL) and while Functions is not running.
 */
export function AttemptsLink({ queue }: { queue: TasksQueue }) {
  const link = useLinkTo(queue.function?.invocationsRef)
  if (!queue.function || !link) return null
  return (
    <Tooltip
      content={`Every attempt of a task in ${queue.id} is an invocation of ${queue.function.name}: open them in Functions › Invocations.`}
      render={
        <Link
          to={link.to as never}
          search={link.search as never}
          className="flex shrink-0 items-center gap-1 text-[13px] whitespace-nowrap text-kumo-link underline-offset-2 hover:underline"
          data-testid="queue-attempts-link"
        >
          Attempts in Invocations
          <ArrowRightIcon size={12} />
        </Link>
      }
    />
  )
}

const OUTCOME_LABEL: Record<TasksOutcome, string> = {
  succeeded: 'Succeeded',
  failed: 'Failed',
  cancelled: 'Cancelled',
  deleted: 'Deleted',
  purged: 'Purged',
  replaced: 'Replaced',
}

export function QueueView({
  queue,
  list,
  project,
  onOpenQueue,
}: {
  queue: TasksQueue
  list: TasksQueueList
  project: string
  onOpenQueue: (queue: TasksQueue) => void
}) {
  const client = useQueryClient()
  const { search, update } = useTasksSearch()
  const view: TasksView = search.view ?? 'tasks'
  const { status, hub } = useQueueHub(project, queue.key)
  const actions = useTaskActions(queue)
  const navigate = useNavigate()
  const attempts = useLinkTo(queue.function?.invocationsRef)
  const { counters } = queue

  // A control's answer is the queue as it is now: put it in the list at once.
  const putQueue = (next: TasksQueue) =>
    client.setQueryData<TasksQueueList>(tasksKeys.queues(project), (now) =>
      now ? { ...now, items: now.items.map((item) => (item.key === next.key ? next : item)) } : now,
    )
  const pause = useMutation({
    mutationFn: (on: boolean) =>
      on ? pauseQueue({ queue: queue.key }) : resumeQueue({ queue: queue.key }),
    onSuccess: putQueue,
    onError: (error) =>
      toast({
        key: 'tasks-pause',
        title: `Could not change ${queue.id}`,
        description: errorText(error),
        tone: 'danger',
      }),
  })
  const [purging, setPurging] = useState(false)
  const [stopRetrying, setStopRetrying] = useState(false)
  const purge = useMutation({
    mutationFn: () => purgeQueue({ queue: queue.key, stopRetrying }),
    onSuccess: (result) => {
      setPurging(false)
      toast({
        key: 'tasks-purge',
        title: `Purged ${formatNumber(result.removed)} ${result.removed === 1 ? 'task' : 'tasks'} from ${queue.id}`,
        ...(result.stopped > 0
          ? { description: `${formatNumber(result.stopped)} in a slot will not be retried.` }
          : {}),
        tone: 'success',
      })
    },
  })

  // Opening a task adds a step to the history; moving an open inspector to
  // another task (a click, the arrows, the cursor) replaces it.
  const openTask = (id: string | undefined, options?: { replace?: boolean }) =>
    update(id === undefined ? { task: undefined, tab: undefined } : { task: id }, {
      replace: options?.replace ?? (id !== undefined && search.task !== undefined),
    })
  const tab: InspectorTab = search.tab ?? 'payload'
  const inspector = (navigation: { onPrev?: () => void; onNext?: () => void }) =>
    search.task === undefined ? null : (
      <TaskInspector
        queue={queue}
        project={project}
        taskId={search.task}
        tab={tab}
        onTab={(next) => update({ tab: next === 'payload' ? undefined : next }, { replace: true })}
        onClose={() => openTask(undefined)}
        onPrev={navigation.onPrev}
        onNext={navigation.onNext}
        actions={actions}
      />
    )

  const refused = list.refused.filter((entry) => entry.queue === queue.id)
  const banners = (
    <>
      <ReplacedBanner
        queue={queue}
        onShowHistory={() => update({ view: 'history', outcome: 'replaced', task: undefined })}
      />
      <RefusedBanners
        refused={refused}
        queues={list.items}
        current={queue.key}
        onOpen={onOpenQueue}
      />
    </>
  )

  const hold = useMutation({
    mutationFn: (enabled: boolean) => holdQueue({ queue: queue.key, enabled }),
    onSuccess: putQueue,
    onError: (error) =>
      toast({
        key: 'tasks-hold',
        title: `Could not change ${queue.id}`,
        description: errorText(error),
        tone: 'danger',
      }),
  })
  const openPurge = () => {
    purge.reset()
    setStopRetrying(false)
    setPurging(true)
  }
  useTasksPalette({
    queues: [],
    queue,
    commands: {
      enqueue: () => update({ new: 'task' }),
      pause: (on) => pause.mutate(on),
      purge: openPurge,
      hold: (on) => hold.mutate(on),
      view: (next) =>
        update({
          view: next === 'tasks' ? undefined : next,
          task: undefined,
          tab: undefined,
          state: undefined,
          outcome: undefined,
          q: undefined,
        }),
      attempts: attempts
        ? () => void navigate({ to: attempts.to as never, search: attempts.search as never })
        : undefined,
    },
    open: onOpenQueue,
    key: 'tasks.queue',
  })

  useShortcuts({ id: 'tasks.queue', label: queue.id }, [
    { key: 'n', label: 'Enqueue a task', run: () => update({ new: 'task' }) },
  ])

  const waiting = counters.pending + counters.held
  const inSlots = counters.dispatching + counters.running + counters.backoff
  const tasksCount = waiting + inSlots
  const outcomes = counters.outcomes
  const shownOutcomes = OUTCOMES.filter(
    (outcome) =>
      outcome === 'succeeded' ||
      outcome === 'failed' ||
      outcomes[outcome] > 0 ||
      search.outcome === outcome,
  )
  const live = status === 'ended' || status === 'refused'
  const wide = useWide()

  // The open tab's switch: at row two's right end where there is room, on
  // the filter line beside the count where there is not (the tabs keep
  // their place either way).
  const stateSwitch = (
    <Tabs
      variant="segmented"
      size="sm"
      value={search.state ?? 'all'}
      onValueChange={(next) =>
        update({ state: next === 'all' ? undefined : (next as StateFilter) }, { replace: true })
      }
      tabs={[
        { value: 'all', label: <SwitchLabel label="All" count={tasksCount} wide={wide} /> },
        {
          value: 'pending',
          label: <SwitchLabel label="Pending" count={counters.pending} wide={wide} />,
        },
        { value: 'held', label: <SwitchLabel label="Held" count={counters.held} wide={wide} /> },
        {
          value: 'running',
          label: (
            <SwitchLabel
              label="Running"
              count={counters.running + counters.dispatching}
              wide={wide}
            />
          ),
        },
        {
          value: 'backoff',
          label: <SwitchLabel label="Backoff" count={counters.backoff} wide={wide} />,
        },
      ]}
    />
  )
  const outcomeSwitch = (
    <Tabs
      variant="segmented"
      size="sm"
      value={search.outcome ?? 'all'}
      onValueChange={(next) =>
        update({ outcome: next === 'all' ? undefined : (next as TasksOutcome) }, { replace: true })
      }
      tabs={[
        { value: 'all', label: <SwitchLabel label="All" count={counters.history} wide={wide} /> },
        ...shownOutcomes.map((outcome) => ({
          value: outcome,
          label: (
            <SwitchLabel label={OUTCOME_LABEL[outcome]} count={outcomes[outcome]} wide={wide} />
          ),
        })),
      ]}
    />
  )

  return (
    <QueueLiveContext value={hub}>
      <SectionToolbar>
        <ToolbarRow testId="tasks-toolbar">
          <PanelToggle where="toolbar" />
          <QueueField queue={queue} />
          {live && (
            <>
              <ToolbarDivider />
              <LiveNotice status={status} what="the tasks" onRetry={() => liveChannel.retry()} />
            </>
          )}
          <ToolbarDivider />
          <Tooltip
            content={
              queue.paused
                ? 'Let pending tasks go again.'
                : 'Hold every pending task where it is; running ones finish. Console only.'
            }
            render={
              <Button
                variant="secondary"
                size="sm"
                icon={queue.paused ? <PlayIcon /> : <PauseIcon />}
                loading={pause.isPending}
                onClick={() => pause.mutate(!queue.paused)}
                data-testid={queue.paused ? 'queue-resume' : 'queue-pause'}
              >
                {queue.paused ? 'Resume' : 'Pause'}
              </Button>
            }
          />
          <Tooltip
            content="Remove every waiting task, into History as purged"
            render={
              <Button
                variant="ghost"
                size="sm"
                icon={<TrashIcon className="text-kumo-danger" />}
                onClick={openPurge}
                aria-label="Purge…"
                data-testid="queue-purge"
              >
                {/* The word gives way first on a narrow window; the glyph stays. */}
                <span className="hidden text-kumo-danger xl:inline">Purge…</span>
              </Button>
            }
          />
          <ToolbarDivider />
          <Tooltip
            content={
              <span className="flex items-center gap-1.5">
                Enqueue a task in {queue.id} <Kbd>n</Kbd>
              </span>
            }
            render={
              <Button
                variant="primary"
                size="sm"
                icon={<PlusIcon />}
                onClick={() => update({ new: 'task' })}
                data-testid="tasks-enqueue"
              >
                Enqueue
              </Button>
            }
          />
        </ToolbarRow>
        <ToolbarRow variant="line" testId="tasks-tabs">
          <Tabs
            variant="underline"
            size="sm"
            value={view}
            onValueChange={(next) =>
              update({
                view: next === 'tasks' ? undefined : (next as TasksView),
                state: undefined,
                outcome: undefined,
                q: undefined,
                task: undefined,
                tab: undefined,
              })
            }
            tabs={[
              { value: 'tasks', label: <TabLabel label="Tasks" count={tasksCount} /> },
              { value: 'history', label: <TabLabel label="History" count={counters.history} /> },
              { value: 'config', label: <TabLabel label="Configuration" /> },
            ]}
          />
          <AttemptsLink queue={queue} />
          <span className="ml-auto flex shrink-0 items-center gap-3">
            {view === 'tasks' && wide && (
              <>
                {stateSwitch}
                <SlotsAndTokens queue={queue} />
              </>
            )}
            {view === 'history' && wide && outcomeSwitch}
          </span>
        </ToolbarRow>
      </SectionToolbar>
      {view === 'tasks' && (
        <TasksTab
          queue={queue}
          project={project}
          state={search.state}
          q={search.q}
          taskId={search.task}
          onQuery={(q) => update({ q }, { replace: true })}
          onState={(state) => update({ state }, { replace: true })}
          onOpen={(id) => openTask(id)}
          actions={actions}
          banners={banners}
          inspector={inspector}
          aside={wide ? undefined : stateSwitch}
        />
      )}
      {view === 'history' && (
        <HistoryView
          queue={queue}
          project={project}
          outcome={search.outcome}
          q={search.q}
          taskId={search.task}
          onQuery={(q) => update({ q }, { replace: true })}
          onOutcome={(outcome) => update({ outcome }, { replace: true })}
          onOpen={(id) => openTask(id)}
          actions={actions}
          banners={banners}
          inspector={inspector}
          aside={wide ? undefined : outcomeSwitch}
        />
      )}
      {view === 'config' && (
        <>
          {banners}
          <SectionBody>
            <QueueConfig queue={queue} />
          </SectionBody>
        </>
      )}
      {actions.element}
      <DangerConfirm
        open={purging}
        onOpenChange={(open) => {
          if (!open) setPurging(false)
        }}
        title={`Purge ${queue.id}`}
        description={`Every waiting task — ${formatNumber(counters.pending)} pending and ${formatNumber(counters.held)} held — leaves for History, as purged.`}
        consequences={[
          'Running tasks finish; their answers are recorded.',
          'Purged names stay reserved until the emulator stops, as deleted ones do.',
        ]}
        {...(counters.backoff > 0
          ? {
              option: {
                label: `Also stop retrying the ${formatNumber(counters.backoff)} ${counters.backoff === 1 ? 'task' : 'tasks'} in backoff`,
                checked: stopRetrying,
                onChange: setStopRetrying,
              },
            }
          : {})}
        {...(purge.error ? { error: errorText(purge.error) } : {})}
        pending={purge.isPending}
        onConfirm={() => purge.mutate()}
        testId="queue-purge-confirm"
      />
    </QueueLiveContext>
  )
}
