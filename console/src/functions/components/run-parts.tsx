// The pieces every Run form shares: its footer (tools left, the one primary
// right), Copy as (curl, fetch, the CLI), the paused warning a test event
// shows before it is sent, a labelled row, and the answer — the invocation
// it made, how it ended, and its own log lines, live while it runs.

import { Button, DropdownMenu, Text, Tooltip } from '@cloudflare/kumo'
import { CaretDownIcon, CopyIcon } from '@phosphor-icons/react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { apiSend } from '@/api/client'
import type { FunctionLogLine } from '@/api/generated/compute/FunctionLogLine'
import type { InvocationSummary } from '@/api/generated/compute/InvocationSummary'
import { statusQuery } from '@/api/queries'
import { OutcomeChip } from '@/components/console/outcome-chip'
import { DurationText } from '@/compute/duration-text'
import { formatNumber } from '@/lib/format'
import { createFeedStore } from '@/lib/live/feed-store'
import { useLiveTopic } from '@/lib/live/use-live-topic'
import { invocationQuery } from '../api'
import { chipStatus } from '../kinds'
import { useInvocationLive } from '../live'
import { copyToClipboard } from '@/lib/copy'
import { LogLines, lineKey } from './log-lines'

/** A labelled row of a Run form: the label 12 px quiet, the control beside it. */
export function FormRow({
  label,
  children,
  hint,
}: {
  label: string
  children: ReactNode
  hint?: ReactNode
}) {
  return (
    <div className="grid gap-1">
      <div className="flex min-w-0 items-center gap-2">
        <span className="w-[76px] shrink-0 text-[12px] text-kumo-subtle">{label}</span>
        <div className="flex min-w-0 flex-1 items-center gap-1.5">{children}</div>
      </div>
      {hint && <div className="pl-[84px] text-[11px] text-kumo-subtle">{hint}</div>}
    </div>
  )
}

/** The form's foot: tools on the left, the one primary action on the right. */
export function RunFooter({ tools, primary }: { tools?: ReactNode; primary: ReactNode }) {
  return (
    <footer
      className="flex min-h-12 shrink-0 flex-wrap items-center gap-x-1 gap-y-1.5 border-t border-kumo-line px-5 py-2"
      data-testid="run-footer"
    >
      <div className="flex min-w-0 items-center gap-1">{tools}</div>
      <div className="ml-auto flex shrink-0 items-center gap-2">{primary}</div>
    </footer>
  )
}

/** One dialect of Copy as: its text, or why this request cannot be said that way. */
export interface CopyDialect {
  id: string
  label: string
  text?: string | undefined
  refused?: string | undefined
}

/** "Copy as ▾": curl, fetch and the CLI command carrying this request's own data. */
export function CopyAsMenu({
  dialects,
  testId = 'run-copy-as',
}: {
  dialects: readonly CopyDialect[]
  testId?: string
}) {
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        render={
          <Button variant="ghost" size="sm" icon={<CopyIcon />} data-testid={testId}>
            <span className="flex items-center gap-1">
              Copy as
              <CaretDownIcon size={12} className="text-kumo-subtle" />
            </span>
          </Button>
        }
      />
      <DropdownMenu.Content align="start">
        {dialects.map((dialect) => {
          const item = (
            <DropdownMenu.Item
              key={dialect.id}
              disabled={dialect.text === undefined}
              onClick={() => {
                if (dialect.text !== undefined)
                  void copyToClipboard(dialect.text, { what: `the ${dialect.label} command` })
              }}
              data-testid={`${testId}-${dialect.id}`}
            >
              <span className="font-mono text-[12px]">{dialect.label}</span>
            </DropdownMenu.Item>
          )
          return dialect.refused ? (
            <Tooltip
              key={dialect.id}
              content={dialect.refused}
              side="right"
              render={<span className="block">{item}</span>}
            />
          ) : (
            item
          )
        })}
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}

/** The paused warning a test event shows before it is sent (the only paused-state copy compute draws). */
export function PausedWarning() {
  const status = useQuery(statusQuery)
  const resume = useMutation({
    mutationFn: () => apiSend<unknown>('POST', '/suite/background', { enabled: true }),
  })
  if (status.data?.backgroundTriggers.enabled !== false) return null
  return (
    <div
      className="flex items-start gap-2 rounded-lg bg-kumo-warning-tint px-3 py-2 text-[13px]"
      data-testid="run-paused"
    >
      <span className="min-w-0 flex-1 text-kumo-default">
        Background triggers are paused, so this event is recorded as Paused and your handler does
        not run.
      </span>
      <Button
        variant="secondary"
        size="xs"
        loading={resume.isPending}
        onClick={() => resume.mutate()}
        data-testid="run-resume"
      >
        Resume
      </Button>
    </div>
  )
}

/** An invocation's own log lines, from its record and then live while it runs. */
function InvocationLogs({
  project,
  id,
  running,
}: {
  project: string
  id: string
  running: boolean
}) {
  const [store] = useState(() => createFeedStore<FunctionLogLine>({ max: 2_000, key: lineKey }))
  const view = useQuery({ ...invocationQuery(project, id), enabled: project !== '' })
  useInvocationLive(running ? id : null)
  const lines = view.data?.detail.logs
  useEffect(() => {
    if (lines) store.upsert(lines)
  }, [lines, store])
  const count = lines?.length ?? 0
  return (
    <section className="grid gap-1" aria-label="Logs" data-testid="run-logs">
      <h4 className="m-0 text-[12px] font-normal text-kumo-subtle">
        Logs · {count === 0 ? (running ? 'none yet' : 'none') : formatNumber(count)}
      </h4>
      {count > 0 && (
        <div className="max-h-72 overflow-hidden rounded-md ring ring-kumo-line">
          <LogLines
            ariaLabel="This invocation's log lines"
            store={store}
            mode="invocation"
            running={running}
            className="max-h-72"
          />
        </div>
      )}
    </section>
  )
}

/** The answer's head: the invocation it made (opens it), how it ended, how long it took. */
export function RunAnswer({
  project,
  invocation,
  finished,
  onOpen,
  outcome = true,
  children,
}: {
  project: string
  /** Draw how it ended in the head (an HTTP answer's own status line says it already). */
  outcome?: boolean | undefined
  /** The invocation as it started (`started`). */
  invocation: InvocationSummary | undefined
  /** As it finished. */
  finished?: InvocationSummary | undefined
  onOpen: (id: string) => void
  /** The answer itself: a response, a callable's result, an event's outcome. */
  children?: ReactNode
}) {
  // The record as the engine keeps it (its live topic patches it until the
  // call ends), so a head shown as it started still says how it ended when
  // the form had only the start to show (a schedule run directly).
  const recorded = useQuery({
    ...invocationQuery(project, invocation?.id ?? finished?.id ?? ''),
    enabled: project !== '' && (invocation ?? finished) !== undefined,
  })
  const kept = recorded.data?.detail.summary
  const shown = finished ?? (kept && kept.outcome !== null ? kept : undefined) ?? invocation
  return (
    <section
      className="grid gap-2 border-t border-kumo-line px-5 py-3"
      aria-label="The answer"
      data-testid="run-answer"
    >
      {shown && (
        <div className="flex min-w-0 items-center gap-2">
          {outcome ? (
            <>
              <OutcomeChip
                outcome={shown.outcome}
                outcomeClass={shown.outcomeClass}
                status={chipStatus(shown)}
                callableStatus={shown.callableStatus ?? undefined}
                startedAt={shown.startedAt}
                detail={shown.error ?? undefined}
                testId="run-outcome"
              />
              <DurationText ms={shown.durationMs} cold={shown.cold} />
            </>
          ) : (
            <span className="text-[12px] text-kumo-subtle">
              Invocation{shown.cold ? ' · started the worker' : ''}
            </span>
          )}
          <Button
            variant="ghost"
            size="xs"
            className="ml-auto font-mono"
            onClick={() => onOpen(shown.id)}
            data-testid="run-invocation"
          >
            #{formatNumber(shown.seq)} ›
          </Button>
        </div>
      )}
      {children}
      {shown && (
        <InvocationLogs
          project={project}
          id={shown.id}
          running={finished === undefined && shown.outcome === null}
        />
      )}
    </section>
  )
}

/** A failure before any invocation: the engine's sentence and its fix. */
export function RunError({ message, fix }: { message: string; fix?: string | undefined }) {
  return (
    <div className="grid gap-1 rounded-lg bg-kumo-danger-tint px-3 py-2" data-testid="run-error">
      <Text variant="error" size="sm">
        {message}
      </Text>
      {fix && <span className="text-[12px] text-kumo-default">{fix}</span>}
    </div>
  )
}

/** How many of a function's latest finished invocations a Run form remembers. */
const RECENT = 50

/**
 * The next finished invocation of `functionId` that `matches` (a write's
 * trigger, a publish's delivery, a task's dispatch), followed on the live
 * tail of `functions.events` (`matches: null` = not now). The form follows
 * the function from the moment it opens, and keeps its latest finished
 * invocations, so one that finishes before the action has said what it
 * waits for (a sign-up answered by the time its request returns) is found
 * all the same.
 */
export function useNextInvocation(
  functionId: string,
  matches: ((invocation: InvocationSummary) => boolean) | null,
): InvocationSummary | undefined {
  const [found, setFound] = useState<{ for: unknown; invocation: InvocationSummary } | undefined>()
  const latest = useRef(matches)
  const recent = useRef<InvocationSummary[]>([])
  useEffect(() => {
    latest.current = matches
    if (!matches) return
    for (let at = recent.current.length - 1; at >= 0; at -= 1) {
      const invocation = recent.current[at]
      if (invocation && matches(invocation)) {
        setFound({ for: matches, invocation })
        return
      }
    }
  }, [matches])
  useLiveTopic('functions.events', functionId ? { function: functionId } : null, {
    onBatch: (batch) => {
      const finished = batch.items.filter((item) => item.outcome !== null)
      if (finished.length === 0) return
      recent.current = [...recent.current, ...finished].slice(-RECENT)
      const test = latest.current
      if (!test) return
      for (const item of finished)
        if (test(item)) {
          setFound({ for: test, invocation: item })
          return
        }
    },
  })
  return found && found.for === matches ? found.invocation : undefined
}
