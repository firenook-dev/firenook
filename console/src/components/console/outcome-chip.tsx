// How something ended, the same way in every section: a dot in the tone
// and a word. Functions draw an invocation's outcome with it; Cloud Tasks
// its attempts and history, Pub/Sub its deliveries and schedule runs, and
// Authentication its activity, each in its own words and tones.
//
// Colour is spent only where it means something: success is a green dot
// beside a quiet word, so a list of successes reads calm and the eye goes
// to the amber and red ones. A word that is data — an HTTP status, a
// callable's status code, an SDK error code — is set in the data face.
//
// For an invocation the engine computes the outcome and its class; the
// chip never derives one from the other (compute spec §5.0).

import { Tooltip } from '@cloudflare/kumo'
import type { ReactNode } from 'react'
import { StatusDot, type StatusTone } from '@/components/kit'
import { useNow } from '@/lib/clock'
import { formatDuration } from '@/lib/format'

/** How an invocation ended, as the engine's Monitor records it. */
export type InvocationOutcome =
  | 'succeeded'
  | 'allowed'
  | 'blocked'
  | 'clientError'
  | 'callableError'
  | 'failed'
  | 'timedOut'
  | 'crashed'
  | 'notStarted'
  | 'paused'
  | 'removed'

/** What an outcome counts as: the `outcome:` filter's words, and what the failure figures count. */
export type OutcomeClass = 'succeeded' | 'failed' | 'skipped' | 'running'

/** The status a callable answers with, and the HTTP status the SDKs map it to. */
const CALLABLE_HTTP: Record<string, number> = {
  OK: 200,
  CANCELLED: 499,
  UNKNOWN: 500,
  INVALID_ARGUMENT: 400,
  DEADLINE_EXCEEDED: 504,
  NOT_FOUND: 404,
  ALREADY_EXISTS: 409,
  PERMISSION_DENIED: 403,
  RESOURCE_EXHAUSTED: 429,
  FAILED_PRECONDITION: 400,
  ABORTED: 409,
  OUT_OF_RANGE: 400,
  UNIMPLEMENTED: 501,
  INTERNAL: 500,
  UNAVAILABLE: 503,
  DATA_LOSS: 500,
  UNAUTHENTICATED: 401,
}

/** An invocation outcome as a word and a tone (§5.0's table). */
export function invocationChip(input: {
  outcome: InvocationOutcome | null
  status?: number | undefined
  callableStatus?: string | undefined
}): { word: string; tone: StatusTone; mono: boolean } {
  const figure = input.status === undefined ? undefined : String(input.status)
  switch (input.outcome) {
    case null:
      return { word: 'Running', tone: 'neutral', mono: false }
    case 'succeeded':
      return figure
        ? { word: figure, tone: 'success', mono: true }
        : { word: 'Succeeded', tone: 'success', mono: false }
    case 'allowed':
      return { word: 'Allowed', tone: 'success', mono: false }
    case 'blocked':
      return { word: 'Blocked', tone: 'warning', mono: false }
    case 'clientError':
      return figure
        ? { word: figure, tone: 'warning', mono: true }
        : { word: 'Client error', tone: 'warning', mono: false }
    case 'callableError': {
      const code = (input.callableStatus ?? 'UNKNOWN').toUpperCase()
      const http = CALLABLE_HTTP[code] ?? 500
      return { word: code, tone: http >= 500 ? 'danger' : 'warning', mono: true }
    }
    case 'failed':
      return figure
        ? { word: figure, tone: 'danger', mono: true }
        : { word: 'Failed', tone: 'danger', mono: false }
    case 'timedOut':
      return { word: 'Timed out', tone: 'danger', mono: false }
    case 'crashed':
      return { word: 'Crashed', tone: 'danger', mono: false }
    case 'notStarted':
      return { word: 'Not started', tone: 'danger', mono: false }
    case 'paused':
      return { word: 'Paused', tone: 'neutral', mono: false }
    case 'removed':
      return { word: 'Removed', tone: 'neutral', mono: false }
  }
}

/** An invocation, as compute's lists draw it. */
interface InvocationProps {
  /** `null` while it runs. */
  outcome: InvocationOutcome | null
  outcomeClass: OutcomeClass
  /** The HTTP status of a URL invocation: the chip shows the figure. */
  status?: number | undefined
  /** A callable's status code (`INVALID_ARGUMENT`), shown as data. */
  callableStatus?: string | undefined
  /** When a running invocation started (RFC 3339): the chip counts up from it. */
  startedAt?: string | undefined
  /** One sentence for the tooltip: the reason behind the word. */
  detail?: string | undefined
  /** May give way in a tight row: the word ends in an ellipsis (put the whole of it in `detail`). */
  shrink?: boolean | undefined
  testId?: string | undefined
}

/** Any other section's outcome: its own word in one of the shared tones. */
interface PlainProps {
  word: string
  tone: StatusTone
  /** The word is data (an error code, a status figure): the data face. */
  mono?: boolean | undefined
  /** It is still on its way (running, delivering): the dot breathes. */
  pulse?: boolean | undefined
  detail?: string | undefined
  /** May give way in a tight row: the word ends in an ellipsis (put the whole of it in `detail`). */
  shrink?: boolean | undefined
  testId?: string | undefined
}

export type OutcomeChipProps = InvocationProps | PlainProps

function isInvocation(props: OutcomeChipProps): props is InvocationProps {
  return 'outcomeClass' in props
}

export function OutcomeChip(props: OutcomeChipProps) {
  if (isInvocation(props) && props.outcome === null)
    return <RunningChip startedAt={props.startedAt} detail={props.detail} testId={props.testId} />
  const chip = isInvocation(props)
    ? invocationChip(props)
    : { word: props.word, tone: props.tone, mono: props.mono ?? false }
  const pulse = !isInvocation(props) && props.pulse === true
  const shrink = props.shrink === true
  const className = [chip.mono ? 'font-mono' : '', shrink ? 'min-w-0 shrink' : '']
    .filter(Boolean)
    .join(' ')
  const dot = (
    <StatusDot
      tone={chip.tone}
      label={chip.word}
      pulse={pulse}
      {...(className ? { className } : {})}
      {...(props.testId === undefined ? {} : { testId: props.testId })}
    />
  )
  return (
    <WithDetail
      detail={props.detail}
      outcome={isInvocation(props) ? props.outcomeClass : undefined}
      shrink={shrink}
    >
      {dot}
    </WithDetail>
  )
}

/**
 * How long it has been running, by the shared one-second clock: whole
 * seconds while they count (a tenth that only ever reads .0 says nothing),
 * the console's durations after a minute.
 */
export function elapsedText(ms: number): string {
  const value = Math.max(0, ms)
  return value < 60_000 ? `${Math.floor(value / 1000)} s` : formatDuration(value)
}

/** `Running 3 s`: the elapsed time beside a breathing neutral dot. */
function RunningChip({
  startedAt,
  detail,
  testId,
}: {
  startedAt: string | undefined
  detail: string | undefined
  testId: string | undefined
}) {
  const now = useNow('second')
  const started = startedAt === undefined ? Number.NaN : Date.parse(startedAt)
  const elapsed = Number.isNaN(started) ? undefined : elapsedText(now - started)
  return (
    <WithDetail detail={detail} outcome="running">
      <span className="flex shrink-0 items-center gap-1.5">
        <StatusDot
          tone="neutral"
          label="Running"
          pulse
          {...(testId === undefined ? {} : { testId })}
        />
        {elapsed && (
          <span className="font-mono text-[11px] text-kumo-subtle tabular-nums">{elapsed}</span>
        )}
      </span>
    </WithDetail>
  )
}

function WithDetail({
  detail,
  outcome,
  shrink = false,
  children,
}: {
  detail: string | undefined
  outcome: OutcomeClass | undefined
  /** Whether the chip may give way to its row; otherwise it keeps its width beside a truncating sibling. */
  shrink?: boolean
  children: ReactNode
}) {
  const marked = (
    <span
      className={`inline-flex items-center ${shrink ? 'min-w-0 shrink' : 'shrink-0'}`}
      data-outcome={outcome}
    >
      {children}
    </span>
  )
  if (!detail) return marked
  return <Tooltip content={detail} render={marked} />
}
