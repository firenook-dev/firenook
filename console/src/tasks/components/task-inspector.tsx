// One task, beside the Tasks, Attempts or History list (TK-20…TK-24): where
// it is and what happens next — the attempt it is on, the countdown to the
// next, the retry plan with the emulator's stop rule said honestly — then
// its payload (the `data` member the handler reads, or the raw body), the
// request every attempt sends (caller headers and the `X-CloudTasks-*` ones
// for the next attempt), and its attempts. The footer runs, stops, deletes
// or enqueues again; Code prints the task for a script.

import { Button, SkeletonLine } from '@cloudflare/kumo'
import { PlayIcon, StopIcon, TrashIcon } from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { ApiError } from '@/api/client'
import type { TasksQueue } from '@/api/generated/messaging/TasksQueue'
import type { TasksTaskDetail } from '@/api/generated/messaging/TasksTaskDetail'
import { useDelayedFlag } from '@/components/console/empty-state'
import {
  Inspector,
  InspectorFooter,
  InspectorSection,
  InspectorTitle,
  useInspectorRoom,
} from '@/components/console/inspector'
import { JsonView } from '@/components/console/json-view'
import { KeyValueList } from '@/components/console/key-value-list'
import { OutcomeChip } from '@/components/console/outcome-chip'
import { PayloadView } from '@/components/console/payload-view'
import { RelativeTime, exactTime } from '@/components/console/relative-time'
import { StatusDot } from '@/components/kit'
import { useNow } from '@/lib/clock'
import { formatBytes, formatDuration, formatNumber } from '@/lib/format'
import { parseJson } from '../payload'
import { taskQuery } from '../queries'
import { planIsCut, planRows } from '../retry-plan'
import {
  STATE_DETAIL,
  attemptText,
  backoffSeconds,
  countdownText,
  displayName,
  lastResult,
  outcomeChip,
  secondsText,
  stateTone,
  stateWord,
} from '../states'
import { AttemptsTimeline } from './attempts-timeline'
import type { TaskActions, TaskSubject } from './task-actions'
import { TaskCode } from './task-code'

export type InspectorTab = 'payload' | 'request' | 'attempts'

/** A task as the actions name it. */
export function subjectOf(task: TasksTaskDetail['task']): TaskSubject {
  return { id: task.id, label: displayName(task), generated: task.generated }
}

/** Where the task is, what happens next, and when the emulator gives up. */
function StateSummary({ detail }: { detail: TasksTaskDetail }) {
  const now = useNow('second')
  const { task, finished } = detail
  if (finished) {
    const chip = outcomeChip(finished.outcome)
    const result = lastResult(task.previousResponse, task.lastError)
    return (
      <section
        className="grid shrink-0 gap-2 border-b border-kumo-line px-5 py-3"
        data-testid="task-state"
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <OutcomeChip
            word={chip.word}
            tone={chip.tone}
            detail={chip.detail}
            testId="task-outcome"
          />
          <span className="text-[12px] text-kumo-subtle">
            <RelativeTime iso={finished.at} prefix="finished" /> · took{' '}
            <span className="font-mono">{formatDuration(finished.tookMs)}</span>
          </span>
          {result && (
            <span className="text-[12px] text-kumo-subtle">
              last answer{' '}
              <span className={result.mono ? 'font-mono' : undefined}>{result.word}</span>
            </span>
          )}
        </div>
        {chip.detail && <p className="m-0 text-[13px] text-kumo-subtle">{chip.detail}</p>}
      </section>
    )
  }
  const inSlot =
    task.state === 'backoff' || task.state === 'running' || task.state === 'dispatching'
  // The engine plans from the next attempt; the backoff before it is the one being waited out.
  const waiting = backoffSeconds(task)
  const plan = planRows(detail.retryPlan)
  const next = plan[0]
  if (next && next.backoff === '' && waiting !== undefined)
    next.backoff = `+${secondsText(waiting)}`
  return (
    <section
      className="grid shrink-0 gap-2 border-b border-kumo-line px-5 py-3"
      data-testid="task-state"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <StatusDot
          tone={stateTone(task.state)}
          label={stateWord(task, now)}
          pulse={task.state === 'running'}
          testId="task-state-word"
        />
        {task.attempt > 0 && (
          <span className="text-[12px] text-kumo-subtle">
            attempt <span className="font-mono">{attemptText(task)}</span>
          </span>
        )}
        {task.state === 'backoff' && task.nextAttemptAt && (
          <span className="text-[12px] text-kumo-warning" data-testid="task-next">
            next attempt {countdownText(task.nextAttemptAt, now)}
          </span>
        )}
        {task.state === 'running' && task.lastAttemptAt && (
          <span className="text-[12px] text-kumo-subtle">
            in flight for{' '}
            {secondsText(Math.max(0, Math.floor((now - Date.parse(task.lastAttemptAt)) / 1000)))}
          </span>
        )}
        {task.stopRequested && (
          <span className="text-[12px] text-kumo-subtle">stops after this attempt</span>
        )}
      </div>
      <p className="m-0 text-[13px] text-kumo-subtle">{STATE_DETAIL[task.state]}</p>
      {inSlot && plan.length > 0 && (
        <div className="grid gap-1" data-testid="task-retry-plan">
          <h3 className="m-0 text-[12px] font-normal text-kumo-subtle">
            Retry plan, if each attempt fails
          </h3>
          <ol className="m-0 grid list-none gap-0.5 p-0">
            {plan.map((row) => (
              <li
                key={row.attempt}
                className="flex items-center gap-3 font-mono text-[12px] tabular-nums"
              >
                <span className="w-6 text-right text-kumo-default">
                  {formatNumber(row.attempt)}
                </span>
                <span className="text-kumo-default">at {row.at}</span>
                <span className="text-kumo-subtle">{row.backoff}</span>
                {row.last && <span className="font-sans text-kumo-subtle">last</span>}
              </li>
            ))}
            {planIsCut(detail.retryPlan) && (
              <li className="pl-9 text-[12px] text-kumo-subtle">
                and on, until maxRetrySeconds passes
              </li>
            )}
          </ol>
        </div>
      )}
      <p className="m-0 text-[12px] text-kumo-subtle" data-testid="task-stops">
        {detail.stops}
      </p>
    </section>
  )
}

/** The payload: the `data` member the handler reads, or the body as it is. */
function Payload({ detail }: { detail: TasksTaskDetail }) {
  const [whole, setWhole] = useState(false)
  const showData = detail.data !== null && !whole
  const text = showData ? (detail.data ?? '') : detail.body
  const parsed = parseJson(text)
  return (
    <div className="flex min-h-[320px] flex-1 flex-col" data-testid="task-payload">
      <div className="flex shrink-0 items-center gap-2 px-5 pt-2 pb-1">
        <h3 className="m-0 text-[12px] font-normal text-kumo-subtle">
          {showData ? (
            <>
              <span className="font-mono">data</span>, as the handler reads it
            </>
          ) : (
            'The body, as sent'
          )}{' '}
          · <span className="font-mono">{formatBytes(detail.task.body.size)}</span>
        </h3>
        {detail.data !== null && (
          <span className="ml-auto">
            <Button
              variant="ghost"
              size="xs"
              aria-pressed={whole}
              onClick={() => setWhole((now) => !now)}
              data-testid="task-payload-whole"
            >
              {whole ? 'Show data' : 'Raw body'}
            </Button>
          </span>
        )}
      </div>
      <div className="flex min-h-0 flex-1 flex-col px-2 pb-2">
        {parsed.ok ? (
          <JsonView value={parsed.value} text={text} testId="task-payload-json" />
        ) : (
          <PayloadView text={detail.body} testId="task-payload-view" />
        )}
      </div>
    </div>
  )
}

function Request({ detail, queue }: { detail: TasksTaskDetail; queue: TasksQueue }) {
  const { task } = detail
  const url = task.url ?? queue.defaultUri
  const sent = detail.dispatchHeaders
  return (
    <>
      <div className="px-5 py-3" data-testid="task-request">
        <KeyValueList
          items={[
            { label: 'Method', value: 'POST' },
            {
              label: 'URL',
              value: (
                <>
                  {url ?? '(none)'}
                  {task.url === null && url && (
                    <span className="font-sans text-[12px] text-kumo-subtle">
                      {' '}
                      · the queue’s default
                    </span>
                  )}
                </>
              ),
              ...(url ? { copy: url } : {}),
              testId: 'task-url',
            },
            { label: 'Dispatch deadline', value: secondsText(task.deadlineSeconds) },
            ...(task.scheduleTime
              ? [
                  {
                    label: 'Schedule time',
                    value: task.scheduleTime,
                    ...(task.dueAt ? { hint: exactTime(task.dueAt) } : {}),
                  },
                ]
              : []),
            { label: 'Name', value: task.name, copy: task.name, testId: 'task-name' },
            {
              label: 'Enqueued',
              value: <RelativeTime iso={task.enqueuedAt} />,
              mono: false,
            },
            {
              label: 'From',
              value: task.origin === 'console' ? 'the console' : 'a client, over the Tasks port',
              mono: false,
            },
            {
              label: 'Executions',
              value: `${formatNumber(task.executionCount)} (X-CloudTasks-TaskExecutionCount)`,
            },
          ]}
        />
      </div>
      <InspectorSection title="Caller headers" count={detail.headers.length} testId="task-headers">
        <KeyValueList
          items={detail.headers.map((header, index) => ({
            label: header.name,
            value: header.value,
            copy: header.value,
            testId: `task-header-${index}`,
          }))}
        />
      </InspectorSection>
      <InspectorSection
        title={detail.finished ? 'Sent with its last attempt' : 'Sent with the next attempt'}
        count={sent.length}
        testId="task-dispatch-headers"
      >
        <KeyValueList
          items={sent.map((header, index) => ({
            label: header.name,
            value: header.value,
            copy: header.value,
            testId: `task-dispatch-header-${index}`,
          }))}
        />
      </InspectorSection>
    </>
  )
}

function Footer({
  detail,
  queue,
  actions,
}: {
  detail: TasksTaskDetail
  queue: TasksQueue
  actions: TaskActions
}) {
  const { labels } = useInspectorRoom()
  const runRef = useRef<HTMLButtonElement>(null)
  const { task, finished } = detail
  const subject = subjectOf(task)
  const runnable = task.state === 'pending' || task.state === 'held' || task.state === 'backoff'
  const stoppable = (task.state === 'backoff' || task.state === 'running') && !task.stopRequested
  return (
    <InspectorFooter
      testId="task-inspector-footer"
      tools={<TaskCode queue={queue} detail={detail} />}
      danger={
        finished ? undefined : labels ? (
          <Button
            variant="ghost"
            size="sm"
            icon={<TrashIcon className="text-kumo-danger" />}
            onClick={() => actions.remove(subject)}
            data-testid="task-delete-button"
          >
            <span className="text-kumo-danger">Delete</span>
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            shape="square"
            icon={<TrashIcon className="text-kumo-danger" />}
            aria-label="Delete"
            onClick={() => actions.remove(subject)}
            data-testid="task-delete-button"
          />
        )
      }
      primary={
        finished ? (
          <Button
            variant="primary"
            size="sm"
            onClick={() => actions.edit(task.id)}
            data-testid="task-enqueue-again"
          >
            Enqueue again…
          </Button>
        ) : (
          <>
            {stoppable && (
              <Button
                variant="ghost"
                size="sm"
                icon={<StopIcon />}
                onClick={() => actions.stop(subject)}
                data-testid="task-stop"
              >
                Stop retrying
              </Button>
            )}
            {runnable && (
              <Button
                ref={runRef}
                variant="primary"
                size="sm"
                icon={<PlayIcon />}
                onClick={() => actions.run(subject, runRef.current)}
                data-testid="task-run"
              >
                Run now…
              </Button>
            )}
          </>
        )
      }
    />
  )
}

function Missing({ error }: { error: unknown }) {
  const api = error instanceof ApiError ? error : undefined
  return (
    <div className="grid gap-1 px-5 py-4" data-testid="task-missing">
      <p className="m-0 text-[13px] text-kumo-default">
        {api?.message ?? 'This task could not be read.'}
      </p>
      <p className="m-0 text-[13px] text-kumo-subtle">
        {api?.fix ??
          'It may have finished and left the history, or the queue was cleared. Check History.'}
      </p>
    </div>
  )
}

function Loading() {
  const shown = useDelayedFlag(true)
  if (!shown) return null
  return (
    <div className="grid gap-3 px-5 py-4" aria-busy data-testid="task-loading">
      <SkeletonLine className="h-3 w-1/2" />
      <SkeletonLine className="h-3 w-3/4" />
      <SkeletonLine className="h-3 w-2/3" />
    </div>
  )
}

export function TaskInspector({
  queue,
  project,
  taskId,
  tab,
  onTab,
  onClose,
  onPrev,
  onNext,
  actions,
}: {
  queue: TasksQueue
  project: string
  taskId: string
  tab: InspectorTab
  onTab: (tab: InspectorTab) => void
  onClose: () => void
  onPrev?: (() => void) | undefined
  onNext?: (() => void) | undefined
  actions: TaskActions
}) {
  const query = useQuery(taskQuery(project, queue.key, taskId))
  const detail = query.data
  const attempts = detail ? detail.attempts.length + detail.omittedAttempts : undefined
  return (
    <Inspector
      widthKey="tasks.task"
      title={
        detail ? (
          <InspectorTitle value={detail.task.name}>{displayName(detail.task)}</InspectorTitle>
        ) : (
          <InspectorTitle value={taskId}>{`task ${taskId}`}</InspectorTitle>
        )
      }
      meta={detail ? <RelativeTime iso={detail.task.enqueuedAt} prefix="enqueued" /> : undefined}
      onClose={onClose}
      closeLabel="Close the task"
      noun="task"
      onPrev={onPrev}
      onNext={onNext}
      tabs={{
        items: [
          { value: 'payload', label: 'Payload' },
          { value: 'request', label: 'Request' },
          { value: 'attempts', label: 'Attempts', count: attempts },
        ],
        value: tab,
        onChange: (value) => onTab(value as InspectorTab),
      }}
      footer={detail ? <Footer detail={detail} queue={queue} actions={actions} /> : undefined}
      testId="task-inspector"
    >
      {query.isError ? (
        <Missing error={query.error} />
      ) : !detail ? (
        <Loading />
      ) : (
        <>
          <StateSummary detail={detail} />
          {tab === 'payload' && <Payload detail={detail} />}
          {tab === 'request' && <Request detail={detail} queue={queue} />}
          {tab === 'attempts' && <AttemptsTimeline detail={detail} queue={queue} />}
        </>
      )}
    </Inspector>
  )
}
