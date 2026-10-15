// The queue's Configuration tab (TK-50, TK-51, TK-36, TK-02, TK-03, S22):
// what the queue is doing now — slots against maxConcurrentDispatches, the
// token bucket refilling on screen against maxDispatchesPerSecond, what it
// dispatched, finished and took in lately — then every configuration value
// in force with where it came from (the function's `taskQueueTrigger`, the
// client's registration, or the emulator's default), the retry ladder a
// failing task climbs with the off-by-one said plainly, the console's hold
// switch, the registration, and what `/queueStats` answers an SDK.

import { Button, Switch, Tooltip, cn } from '@cloudflare/kumo'
import { InfoIcon } from '@phosphor-icons/react'
import { useMutation, useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { TasksConfigValue } from '@/api/generated/messaging/TasksConfigValue'
import type { TasksQueue } from '@/api/generated/messaging/TasksQueue'
import { CodeBlock } from '@/components/console/code-block'
import { CopyButton } from '@/components/console/copy-button'
import { EntityLink } from '@/components/console/entity-link'
import { MiniBars } from '@/components/console/mini-bars'
import { RelativeTime } from '@/components/console/relative-time'
import { clockTime, formatNumber } from '@/lib/format'
import { useAgedBuckets, useAgedCount, useTokens } from '@/messaging/windows'
import { holdQueue } from '../api'
import { errorText } from '@/lib/error-text'
import { queueQuery } from '../queries'
import { queueResourceName } from '../queue-address'
import { ladderTotal, maxAttemptsNote } from '../retry-plan'
import { secondsText } from '../states'

/** Where a value came from, in words. */
function sourceOf(queue: TasksQueue, value: TasksConfigValue): string {
  if (!value.provided) return 'emulator default'
  return queue.function ? `${queue.function.name}'s taskQueueTrigger` : "the client's registration"
}

/** A value as stored, readable: `null` reads `none`. */
function valueText(value: string): string {
  return value === 'null' ? 'none' : value
}

const GROUPS: readonly { title: string; test: (value: TasksConfigValue) => boolean }[] = [
  { title: 'Retry', test: (value) => value.key.startsWith('retryConfig.') },
  { title: 'Rate limits', test: (value) => value.key.startsWith('rateLimits.') },
  { title: 'Stored, not used by the emulator', test: (value) => value.unused },
]

function Section({
  title,
  aside,
  children,
  testId,
}: {
  title: string
  aside?: ReactNode
  children: ReactNode
  testId?: string
}) {
  return (
    <section
      className="grid gap-2 border-t border-kumo-line py-4 first:border-t-0 first:pt-0"
      data-testid={testId}
    >
      <div className="flex min-h-6 items-center gap-2">
        <h2 className="m-0 text-[13px] font-semibold text-kumo-default">{title}</h2>
        {aside && <span className="ml-auto flex items-center gap-2">{aside}</span>}
      </div>
      {children}
    </section>
  )
}

/** A bar against its capacity, amber when it is what holds the queue back. */
function Gauge({
  label,
  value,
  max,
  text,
  tooltip,
  alarm,
}: {
  label: string
  value: number
  max: number
  text: string
  tooltip: string
  /** The figure is what holds the queue back now: every slot busy, or no token left. */
  alarm: boolean
}) {
  const share = max <= 0 ? 0 : Math.min(1, value / max)
  const full = alarm
  return (
    <Tooltip
      content={tooltip}
      render={
        <div className="grid cursor-default gap-1" data-testid={`gauge-${label.toLowerCase()}`}>
          <div className="flex items-baseline justify-between gap-2 text-[12px]">
            <span className="text-kumo-subtle">{label}</span>
            <span
              className={cn(
                'font-mono tabular-nums',
                full ? 'text-kumo-warning' : 'text-kumo-default',
              )}
            >
              {text}
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-kumo-tint">
            <div
              className={cn('h-full rounded-full', full ? 'bg-kumo-warning' : 'bg-kumo-interact')}
              // A share of the track: the one thing a class cannot carry.
              style={{ width: `${share * 100}%` }}
            />
          </div>
        </div>
      }
    />
  )
}

function Figure({ label, value, tooltip }: { label: string; value: ReactNode; tooltip: string }) {
  return (
    <Tooltip
      content={tooltip}
      render={
        <div className="grid cursor-default gap-0.5">
          <span className="text-[12px] text-kumo-subtle">{label}</span>
          <span className="font-mono text-[13px] text-kumo-default tabular-nums">{value}</span>
        </div>
      }
    />
  )
}

/** What the queue is doing now: slots, the bucket, and the last minutes' traffic. */
function Now({ queue }: { queue: TasksQueue }) {
  const { counters } = queue
  const tokens = useTokens(counters) ?? counters.tokens
  const dispatched = useAgedCount(counters.dispatched, 60)
  const succeeded = useAgedCount(counters.succeeded, 60)
  const failed = useAgedCount(counters.failed, 300, 10)
  const added = useAgedCount(counters.added, 300, 10)
  const bars = useAgedBuckets(counters.dispatched, 60)
  return (
    <Section title="Now" testId="config-now">
      <div className="grid grid-cols-2 gap-x-8 gap-y-3">
        <Gauge
          label="Slots"
          value={counters.slotsInUse}
          max={counters.slots}
          text={`${formatNumber(counters.slotsInUse)} of ${formatNumber(counters.slots)}`}
          alarm={counters.slots > 0 && counters.slotsInUse >= counters.slots}
          tooltip={`${formatNumber(counters.slotsInUse)} of ${formatNumber(counters.slots)} dispatch slots busy (maxConcurrentDispatches): ${formatNumber(counters.running)} running, ${formatNumber(counters.backoff)} in backoff, ${formatNumber(counters.dispatching)} about to be sent.`}
        />
        <Gauge
          label="Tokens"
          value={tokens}
          max={counters.maxTokens}
          text={`${tokens.toFixed(1)} of ${formatNumber(counters.maxTokens)}`}
          alarm={tokens < 1 && counters.pending > 0}
          tooltip={`The token bucket refills ${formatNumber(counters.maxDispatchesPerSecond)} a second (maxDispatchesPerSecond), once a second, up to ${formatNumber(counters.maxTokens)}; each dispatch takes one.`}
        />
      </div>
      <div className="grid grid-cols-[repeat(5,minmax(0,1fr))] gap-4">
        <Figure
          label="Dispatched / min"
          value={formatNumber(dispatched)}
          tooltip="Attempts sent in the last 60 seconds."
        />
        <Figure
          label="Succeeded / min"
          value={formatNumber(succeeded)}
          tooltip="Tasks that finished with a 2xx in the last 60 seconds."
        />
        <Figure
          label="Failed / 5 min"
          value={formatNumber(failed)}
          tooltip="Tasks that ran out of retries in the last five minutes."
        />
        <Figure
          label="Added / 5 min"
          value={formatNumber(added)}
          tooltip="Tasks enqueued in the last five minutes, over the Tasks port or from the console."
        />
        <Figure
          label="Oldest waiting"
          value={
            counters.oldestPendingAt ? (
              <RelativeTime iso={counters.oldestPendingAt} className="font-mono text-[13px]" />
            ) : (
              '—'
            )
          }
          tooltip="How long the oldest pending or held task has waited."
        />
      </div>
      <div className="grid gap-1">
        <span className="text-[11px] text-kumo-subtle">Sent per second, the last minute</span>
        <div className="border-b border-kumo-hairline">
          <MiniBars
            buckets={bars.map((count) => [count])}
            series={[{ label: 'dispatched', tone: 'neutral' }]}
            height={20}
            label="Attempts sent per second, last minute"
            tooltip={(index) => `${60 - index} s ago · ${formatNumber(bars[index] ?? 0)} sent`}
            testId="config-bars"
          />
        </div>
      </div>
    </Section>
  )
}

function Values({ queue }: { queue: TasksQueue }) {
  const { values } = queue.config
  return (
    <>
      {GROUPS.map((group) => {
        const rows = values.filter((value) => group.test(value))
        if (rows.length === 0) return null
        return (
          <Section
            key={group.title}
            title={group.title}
            testId={`config-${group.title.split(/[ ,]/)[0]?.toLowerCase()}`}
          >
            <dl className="m-0 grid grid-cols-[max-content_minmax(0,max-content)_minmax(0,1fr)] gap-x-6 gap-y-1">
              {rows.map((value) => (
                <div
                  key={value.key}
                  className="col-span-3 grid grid-cols-subgrid items-baseline"
                  data-testid="config-value"
                  data-key={value.key}
                >
                  <dt className="font-mono text-[12px] text-kumo-default">
                    {value.key.slice(value.key.indexOf('.') + 1)}
                  </dt>
                  <dd
                    className="m-0 font-mono text-[12px] text-kumo-default"
                    data-testid="config-value-value"
                  >
                    {valueText(value.value)}
                  </dd>
                  <dd
                    className={cn(
                      'm-0 text-[12px]',
                      value.provided ? 'text-kumo-default' : 'text-kumo-subtle',
                    )}
                    data-testid="config-value-source"
                  >
                    {sourceOf(queue, value)}
                  </dd>
                </div>
              ))}
            </dl>
          </Section>
        )
      })}
    </>
  )
}

function Ladder({ queue }: { queue: TasksQueue }) {
  const { ladder } = queue.config
  return (
    <Section
      title="Retry ladder"
      aside={<span className="text-[12px] text-kumo-subtle">a task that fails every attempt</span>}
      testId="config-ladder"
    >
      <div className="grid grid-cols-[max-content_max-content_max-content] gap-x-10 gap-y-0.5 font-mono text-[12px] tabular-nums">
        <span className="text-[11px] text-kumo-subtle">attempt</span>
        <span className="text-[11px] text-kumo-subtle">backoff before it</span>
        <span className="text-[11px] text-kumo-subtle">at the earliest</span>
        {ladder.map((step) => (
          <div
            key={step.attempt}
            className="col-span-3 grid grid-cols-subgrid text-kumo-default"
            data-testid="ladder-step"
          >
            <span>{formatNumber(step.attempt)}</span>
            <span>{step.attempt === 1 ? '—' : secondsText(step.backoffSeconds)}</span>
            <span>
              {step.afterSeconds === 0 ? 'at once' : `+${secondsText(step.afterSeconds)}`}
              {step.last && <span className="ml-2 font-sans text-kumo-subtle">last</span>}
            </span>
          </div>
        ))}
      </div>
      <p
        className="m-0 flex items-start gap-1.5 text-[13px] text-kumo-subtle"
        data-testid="config-off-by-one"
      >
        <InfoIcon size={14} className="mt-0.5 shrink-0" />
        <span>
          {maxAttemptsNote(queue.config)} In the queue at least {ladderTotal(ladder)}, if each
          request takes no time.
        </span>
      </p>
    </Section>
  )
}

function Hold({ queue }: { queue: TasksQueue }) {
  const hold = useMutation({
    mutationFn: (enabled: boolean) => holdQueue({ queue: queue.key, enabled }),
  })
  const checked = hold.isPending ? (hold.variables ?? queue.holdScheduled) : queue.holdScheduled
  return (
    <Section title="Scheduled tasks" testId="config-hold">
      <Switch
        variant="neutral"
        checked={checked}
        disabled={hold.isPending}
        onCheckedChange={(next) => hold.mutate(Boolean(next))}
        label="Hold scheduled tasks until their time"
        data-testid="config-hold-switch"
      />
      <p className="m-0 text-[13px] text-kumo-subtle">
        Off: a task runs as soon as a slot is free, whatever its scheduleTime — the emulator’s own
        behaviour. On: a task scheduled for later waits as held until then (console only; the Tasks
        port is unchanged).
      </p>
      {hold.error && (
        <p className="m-0 text-[13px] text-kumo-danger" role="alert">
          {errorText(hold.error)}
        </p>
      )}
    </Section>
  )
}

function Registration({ queue }: { queue: TasksQueue }) {
  const name = queueResourceName(queue)
  return (
    <Section title="Registration" testId="config-registration">
      <dl className="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-6 gap-y-1.5 text-[12px]">
        <dt className="text-kumo-subtle">defaultUri</dt>
        <dd className="m-0 flex min-w-0 items-center gap-1 font-mono text-kumo-default">
          <span className="min-w-0 [overflow-wrap:anywhere]">{queue.defaultUri ?? 'none'}</span>
          {queue.defaultUri && (
            <CopyButton value={queue.defaultUri} label="Copy the default URI" size="xs" />
          )}
        </dd>
        <dt className="text-kumo-subtle">Queue</dt>
        <dd className="m-0 flex min-w-0 items-center gap-1 font-mono text-kumo-default">
          <span className="min-w-0 [overflow-wrap:anywhere]" data-testid="config-queue-name">
            {name}
          </span>
          <CopyButton value={name} label="Copy the queue's name" size="xs" />
        </dd>
        <dt className="text-kumo-subtle">Parts</dt>
        <dd className="m-0 font-mono text-kumo-default" data-testid="config-parts">
          project {queue.project} · location {queue.location} · queue {queue.id}
        </dd>
        <dt className="text-kumo-subtle">Key</dt>
        <dd className="m-0 flex min-w-0 items-center gap-1 font-mono text-kumo-subtle">
          <span className="min-w-0 [overflow-wrap:anywhere]">{queue.key}</span>
          <CopyButton value={queue.key} label="Copy the emulator's key" size="xs" />
        </dd>
        <dt className="text-kumo-subtle">Registered</dt>
        <dd
          className="m-0 flex flex-wrap items-center gap-x-1.5 text-kumo-default"
          data-testid="config-registered"
        >
          <span className="font-mono">{clockTime(queue.registeredAt, 'second')}</span>
          {queue.function ? (
            <>
              from the function{' '}
              <EntityLink entity={{ ...queue.function.functionRef, label: queue.function.name }} />
            </>
          ) : (
            <span>by a client’s POST …/queues/{queue.id}</span>
          )}
          <span className="text-kumo-subtle" data-testid="config-registrations">
            · {formatNumber(queue.registrations)}{' '}
            {queue.registrations === 1 ? 'registration' : 'registrations'} since start
          </span>
        </dd>
      </dl>
    </Section>
  )
}

function Official({ queue }: { queue: TasksQueue }) {
  const query = useQuery(queueQuery(queue.project, queue.key))
  const official = query.data?.counters.official
  return (
    <Section
      title="What /queueStats answers"
      aside={
        <Button
          variant="ghost"
          size="xs"
          loading={query.isFetching}
          onClick={() => void query.refetch()}
          data-testid="config-official-refresh"
        >
          Read again
        </Button>
      }
      testId="config-official"
    >
      {official ? (
        <dl className="m-0 grid grid-cols-[repeat(5,minmax(0,1fr))] gap-4">
          {(
            [
              [
                'numberOfTasks',
                official.numberOfTasks,
                'Pending tasks as the emulator counts them; a delete of a dispatched task takes it below zero.',
              ],
              [
                'tasksAdded',
                official.tasksAdded,
                'Enqueued in the last minute, as the official emulator counts it.',
              ],
              ['completedLastMin', official.completedLastMin, 'Finished in the last minute.'],
              ['failedTasks', official.failedTasks, 'Failed attempts in the last minute.'],
              [
                'runningTasks',
                official.runningTasks,
                'The dispatch slots, not running requests, as the official emulator reports it.',
              ],
            ] as const
          ).map(([key, value, tooltip]) => (
            <Figure key={key} label={key} value={formatNumber(value)} tooltip={tooltip} />
          ))}
        </dl>
      ) : (
        <p className="m-0 text-[13px] text-kumo-subtle">
          {query.isError ? errorText(query.error) : 'Reading…'}
        </p>
      )}
      <p className="m-0 text-[12px] text-kumo-subtle">
        Read when you open this tab or press Read again; the figures above it are live.
      </p>
    </Section>
  )
}

export function QueueConfig({ queue }: { queue: TasksQueue }) {
  let document = queue.config.document
  try {
    document = JSON.stringify(JSON.parse(queue.config.document), null, 2)
  } catch {
    // Shown as stored.
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-testid="queue-config">
      <div className="grid max-w-[880px] px-5 py-4">
        <Now queue={queue} />
        <Values queue={queue} />
        <Ladder queue={queue} />
        <Hold queue={queue} />
        <Registration queue={queue} />
        <Official queue={queue} />
        <Section title="The stored taskQueueConfig" testId="config-document">
          <CodeBlock code={document} language="json" testId="config-document-code" />
        </Section>
      </div>
    </div>
  )
}
