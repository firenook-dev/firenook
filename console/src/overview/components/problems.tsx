// The newest errors, failures and denials, live: triage from the landing
// page. They come from the engine's problem ring, which keeps them apart
// from the rest of the log, so a flood of ordinary output never empties
// this list. Above it, the last hour of warnings and errors a minute at a
// time; while the engine runs Logs, a row opens its line there (centred,
// in the inspector), a bar opens that minute's problems, and "Open logs"
// all of them. Without Logs the list is the engine's own and nothing
// pretends to open.

import { SkeletonLine, Tooltip } from '@cloudflare/kumo'
import type { UseQueryResult } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import type { ConsoleStatus } from '@/api/generated/ConsoleStatus'
import type { OverviewProblem } from '@/api/generated/observe/OverviewProblem'
import type { OverviewState } from '@/api/generated/observe/OverviewState'
import { useDelayedFlag } from '@/components/console/empty-state'
import { EntityLink } from '@/components/console/entity-link'
import { LiveNotice } from '@/components/console/live-notice'
import { RelativeTime } from '@/components/console/relative-time'
import { type SubscriptionStatus, liveChannel } from '@/lib/live/channel'
import { formatCount } from '@/lib/format'
import { bucketSpan, hourBucketStart, problemBuckets, problemSentence } from '@/observe/level-bars'
import { LevelStrip } from '@/observe/level-strip'
import { LevelWord } from '@/observe/level-word'
import { SourceChip, labelSource } from '@/observe/source-chip'
import { logsEntryLink, logsProblemsLink, problemLink } from '../model'
import { SectionError } from './section-error'
import { TextLink } from './text-link'

const PROBLEM = { one: 'problem', other: 'problems' }
const MINUTE = 60_000

export function RecentProblems({
  status,
  state,
  live,
}: {
  status: ConsoleStatus
  state: UseQueryResult<OverviewState>
  /** The `overview` subscription: said only when the engine ended or refused it. */
  live: SubscriptionStatus
}) {
  const navigate = useNavigate()
  const logs = logsProblemsLink(status)
  const data = state.data
  const pending = useDelayedFlag(state.isPending)
  const hour = data?.hour ?? []
  const pick =
    logs && data
      ? (from: number, to: number) => {
          const start = hourBucketStart(data.generatedAt, from, hour.length)
          const end = hourBucketStart(data.generatedAt, to, hour.length) + MINUTE
          void navigate({
            to: '/logs' as never,
            search: {
              q: 'is:problem',
              from: new Date(start).toISOString(),
              to: new Date(end).toISOString(),
            } as never,
          })
        }
      : undefined
  return (
    <section
      className="grid gap-3"
      aria-labelledby="overview-problems-title"
      data-testid="overview-problems"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
        <h2 id="overview-problems-title" className="text-[16px] leading-6 font-semibold">
          Recent problems
        </h2>
        {data && hour.length > 0 && (
          <div className="flex items-center gap-2">
            {/* A slot per minute: an hour with no problem still reads as an hour. */}
            <LevelStrip
              buckets={problemBuckets(hour)}
              height={20}
              ground="slots"
              label="Warnings and errors per minute, last hour"
              tooltip={(index) => {
                const bucket = hour[index]
                const span = bucketSpan(
                  hourBucketStart(data.generatedAt, index, hour.length),
                  MINUTE,
                )
                return bucket ? problemSentence(bucket, span) : span
              }}
              {...(pick ? { onPick: pick } : {})}
              className="w-60"
              testId="overview-problems-bars"
            />
            <span className="text-[12px] text-kumo-subtle">last hour</span>
          </div>
        )}
        {data && data.problemsLogged > 0 && (
          <span className="text-[12px] text-kumo-subtle" data-testid="overview-problems-total">
            {formatCount(data.problemsLogged, PROBLEM)} since the engine started
          </span>
        )}
        <span className="ml-auto flex items-center gap-3">
          <LiveNotice
            status={live}
            what="the recent problems"
            onRetry={() => liveChannel.retry()}
            testId="overview-live-notice"
          />
          {logs && (
            <TextLink link={logs} className="text-[13px]" testId="overview-open-logs">
              Open logs
            </TextLink>
          )}
        </span>
      </div>
      <div className="overflow-hidden rounded-lg bg-kumo-base shadow-xs ring ring-kumo-line">
        {state.isError ? (
          <SectionError
            error={state.error}
            onRetry={() => void state.refetch()}
            testId="overview-problems-error"
          />
        ) : data ? (
          data.problems.length === 0 ? (
            <p
              className="px-4 py-3 text-[13px] text-kumo-subtle"
              data-testid="overview-problems-empty"
            >
              No errors, failures or denials since the engine started.
            </p>
          ) : (
            <ul data-testid="overview-problems-list">
              {data.problems.map((problem) => (
                <ProblemRow key={problem.cursor} problem={problem} status={status} />
              ))}
            </ul>
          )
        ) : pending ? (
          <div className="grid gap-3 px-4 py-3" aria-busy>
            <SkeletonLine minWidth={60} maxWidth={90} />
            <SkeletonLine minWidth={40} maxWidth={80} />
          </div>
        ) : (
          <div className="h-11" />
        )}
      </div>
    </section>
  )
}

function ProblemRow({ problem, status }: { problem: OverviewProblem; status: ConsoleStatus }) {
  const entry = logsEntryLink(problem.cursor, status)
  const primary = problemLink(problem, status)
  const source = labelSource(problem.source)
  return (
    <li
      className="relative grid h-8 grid-cols-[5.5rem_2.5rem_minmax(0,6.5rem)_minmax(0,1fr)_auto] items-center gap-x-3 border-b border-kumo-hairline px-4 last:border-b-0 hover:ink"
      data-testid="overview-problem"
      data-level={problem.level}
      data-kind={problem.kind ?? undefined}
    >
      {/* The console's relative time: to the second while it is recent, so a line logged
          late in a minute never reads "in 1 min" against a clock that turns once a minute. */}
      <RelativeTime
        iso={problem.time}
        className="relative z-10 w-fit truncate text-kumo-subtle"
        testId="overview-problem-time"
      />
      <LevelWord level={problem.level} />
      <span className="relative z-10 flex min-w-0">
        <SourceChip source={source} />
      </span>
      {entry ? (
        <TextLink
          link={entry}
          // The whole row opens the line; the links after it sit above.
          className="min-w-0 truncate font-mono text-[12px] leading-4 text-kumo-default no-underline after:absolute after:inset-0 hover:no-underline focus-visible:no-underline focus-visible:after:rounded-sm focus-visible:after:ring-2 focus-visible:after:ring-kumo-focus focus-visible:after:ring-inset"
          testId="overview-problem-open"
        >
          {problem.firstLine}
        </TextLink>
      ) : (
        <Tooltip
          content={<span className="font-mono text-[12px] break-words">{problem.firstLine}</span>}
          render={
            <span className="min-w-0 truncate font-mono text-[12px] leading-4 text-kumo-default">
              {problem.firstLine}
            </span>
          }
        />
      )}
      <span className="relative z-10 flex min-w-0 max-w-64 justify-end text-[12px]">
        {primary ? (
          primary.label === 'See why' ? (
            <TextLink link={primary.link} testId="overview-problem-why">
              See why
            </TextLink>
          ) : (
            <EntityLink
              entity={{ kind: primary.kind, key: primary.key, label: primary.label }}
              testId="overview-problem-ref"
            />
          )
        ) : null}
      </span>
    </li>
  )
}
