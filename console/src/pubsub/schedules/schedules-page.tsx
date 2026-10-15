// Pub/Sub's Schedules page (S19, SC-01…SC-06): every function exported with
// `onSchedule`, in one table — its schedule in words, the zone it runs in,
// when it runs next, how its last run went, how many times it has run, and
// whether its clock runs it — and the one open in the inspector. Schedules
// live under Pub/Sub because a tick is a publish to the function's schedule
// topic: a run, its message and its delivery are one story. Live through
// `pubsub.schedules`: a run, a pause or a reload shows as it happens.

import { Tooltip } from '@cloudflare/kumo'
import {
  ArrowSquareOutIcon,
  CalendarBlankIcon,
  ClockIcon,
  LightningIcon,
  PauseIcon,
  PlayIcon,
  SidebarSimpleIcon,
} from '@phosphor-icons/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Page } from '@/api/generated/Page'
import type { PubsubSchedule } from '@/api/generated/messaging/PubsubSchedule'
import { statusQuery } from '@/api/queries'
import {
  DataTable,
  type DataTableColumn,
  useHiddenColumnCount,
} from '@/components/console/data-table'
import { EmptyState, QueryError } from '@/components/console/empty-state'
import { LiveNotice } from '@/components/console/live-notice'
import { RelativeTime } from '@/components/console/relative-time'
import { RequiresNotice } from '@/components/console/requires-notice'
import type { RowMenuItem } from '@/components/console/row-menu'
import { sectionStatus } from '@/components/console/section-gate'
import { SectionBody, SectionPage } from '@/components/console/section-page'
import { TableFooter } from '@/components/console/table-footer'
import { SectionToolbar, ToolbarRow, ToolbarScope } from '@/components/console/toolbar'
import { StatusDot } from '@/components/kit'
import { useNow } from '@/lib/clock'
import { formatNumber } from '@/lib/format'
import { linkTo } from '@/lib/links'
import { linkToLogs } from '@/lib/sections/logs'
import { liveChannel } from '@/lib/live/channel'
import { type PaletteItem, matchesQuery, usePaletteProviders } from '@/lib/palette'
import { useConsoleProject } from '@/lib/project'
import { useRouteSearch } from '@/lib/search-params'
import { useShortcuts } from '@/lib/shortcuts'
import { toast } from '@/lib/toasts'
import { errorText } from '@/lib/error-text'
import { rowElement } from '@/messaging/confirm-popover'
import type { SchedulesSearch } from '@/routes/pubsub_.schedules'
import { pauseSchedule, resumeSchedule } from '../api'
import { useSchedulesLive } from '../live'
import { shortName } from '../names'
import { pubsubKeys, schedulesQuery } from '../queries'
import {
  describeSchedule,
  nextRunExact,
  nextRunText,
  notAutomaticText,
  scheduleState,
  stateLook,
} from '../schedule-text'
import { functionMark } from '../states'
import { useRunNow } from './run-now-popover'
import { ScheduleInspector, runLogs } from './schedule-inspector'

const TABLE = 'pubsub-schedules-table'

/** A schedule's newest run: the latest kept, else the first. */
export function lastRun(schedule: PubsubSchedule) {
  return schedule.lastRuns[0] ?? schedule.firstRun ?? undefined
}

function NextCell({ schedule }: { schedule: PubsubSchedule }) {
  const now = useNow('second')
  if (!schedule.automatic) return <span className="text-kumo-inactive">—</span>
  if (!schedule.nextRunAt) return <span className="text-kumo-inactive">—</span>
  return (
    <Tooltip
      content={nextRunExact(schedule.nextRunAt, schedule.evaluatedIn)}
      render={
        <span
          className={`font-sans ${schedule.paused ? 'text-kumo-subtle line-through' : ''}`}
          data-testid="schedule-next"
        >
          {nextRunText(schedule.nextRunAt, now)}
        </span>
      }
    />
  )
}

function LastRunCell({ schedule }: { schedule: PubsubSchedule }) {
  const run = lastRun(schedule)
  if (!run) return <span className="text-kumo-inactive">—</span>
  const look = run.skipped
    ? { tone: 'neutral' as const, word: 'skipped' }
    : run.delivery
      ? functionMark(run.delivery.mark)
      : { tone: 'neutral' as const, word: 'published' }
  return (
    <Tooltip
      content={`${run.trigger === 'console' ? 'Run from the console' : 'Run by the clock'}: ${look.word}${run.skipped ? ` — ${run.skipped}` : ''}`}
      render={
        <span
          className="inline-flex items-center gap-1.5 align-middle font-sans"
          data-testid="schedule-last"
        >
          <StatusDot tone={look.tone} label="" />
          <RelativeTime iso={run.at} />
        </span>
      }
    />
  )
}

/** The state as Cloud Tasks' queues draw theirs: the kit's dot and a capitalised word. */
function StateCell({ schedule }: { schedule: PubsubSchedule }) {
  const state = scheduleState(schedule)
  const look = stateLook(state)
  const cell = (
    <span className="inline-flex font-sans" data-testid="schedule-state" data-state={state}>
      <StatusDot tone={look.tone} label={look.word} />
    </span>
  )
  return state === 'not-automatic' ? (
    <Tooltip content={notAutomaticText(schedule.problem)} render={cell} />
  ) : (
    cell
  )
}

export const SCHEDULE_COLUMNS: readonly DataTableColumn<PubsubSchedule>[] = [
  {
    id: 'function',
    header: 'Function',
    width: 180,
    cell: (row) => row.functionName,
    copy: (row) => row.functionId,
  },
  {
    id: 'region',
    header: 'Region',
    width: 150,
    cell: (row) => (
      <span className="inline-flex items-center gap-1.5 align-middle font-sans">
        {row.region}
        {row.sharesTopicWith.length > 0 && (
          <Tooltip
            content={`Shares ${shortName(row.topic)} with ${row.sharesTopicWith.map((id) => shortName(id)).join(', ')}: each tick runs both in this engine.`}
            render={
              <span className="rounded bg-kumo-warning-tint px-1 text-[11px] text-kumo-default ring ring-kumo-warning">
                shared topic
              </span>
            }
          />
        )}
      </span>
    ),
    copy: (row) => row.region,
  },
  {
    id: 'schedule',
    header: 'Schedule',
    width: 260,
    cell: (row) => {
      const words = describeSchedule(row.expression)
      return (
        <span className="inline-flex min-w-0 items-baseline gap-2 align-middle">
          <span className="truncate">{row.expression}</span>
          {words && words !== row.expression && (
            <span className="truncate font-sans text-[11px] text-kumo-subtle">{words}</span>
          )}
        </span>
      )
    },
    copy: (row) => row.expression,
  },
  {
    id: 'zone',
    header: 'Zone',
    width: 130,
    cell: (row) => (
      <span className={`font-sans ${row.timeZone ? '' : 'text-kumo-subtle'}`}>
        {row.evaluatedIn}
      </span>
    ),
    copy: (row) => row.evaluatedIn,
  },
  { id: 'next', header: 'Next', width: 100, cell: (row) => <NextCell schedule={row} /> },
  { id: 'last', header: 'Last run', width: 120, cell: (row) => <LastRunCell schedule={row} /> },
  { id: 'runs', header: 'Runs', width: 64, align: 'end', cell: (row) => formatNumber(row.runs) },
  { id: 'state', header: 'State', width: 120, cell: (row) => <StateCell schedule={row} /> },
]

export function SchedulesPage() {
  const { project } = useConsoleProject()
  const { search, update } = useRouteSearch<SchedulesSearch>(
    '/pubsub_/schedules',
    '/pubsub/schedules',
  )
  const status = useQuery(statusQuery)
  const functions = sectionStatus(status.data?.sections, 'functions').state
  const live = useSchedulesLive(project || undefined)
  return (
    <SectionPage
      section="pubsub"
      page="schedules"
      title="Scheduled functions"
      testId="pubsub-schedules-page"
    >
      <SectionToolbar testId="pubsub-schedules-toolbar">
        <ToolbarRow testId="pubsub-schedules-row-one">
          <ToolbarScope
            icon={<ClockIcon size={14} />}
            detail="functions exported with onSchedule, each tick a publish to its topic"
            testId="pubsub-schedules-field"
          >
            Schedules
          </ToolbarScope>
          <span className="min-w-0 flex-1" />
          <LiveNotice
            status={live}
            what="the schedules"
            onRetry={() => liveChannel.retry()}
            testId="pubsub-schedules-live"
          />
        </ToolbarRow>
      </SectionToolbar>
      {status.data && functions !== 'ready' ? (
        <div className="flex min-h-0 flex-1 flex-col" data-testid="pubsub-schedules-body">
          <RequiresNotice section="functions" for="Running scheduled functions" />
        </div>
      ) : (
        <SchedulesTable project={project} search={search} update={update} />
      )}
    </SectionPage>
  )
}

function SchedulesTable({
  project,
  search,
  update,
}: {
  project: string
  search: SchedulesSearch
  update: (patch: Partial<SchedulesSearch>, options?: { replace?: boolean }) => void
}) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const query = useQuery(schedulesQuery(project))
  const rows = query.data?.items ?? []
  const hidden = useHiddenColumnCount('pubsub.schedules', SCHEDULE_COLUMNS)
  const open = rows.find((row) => row.functionId === search.schedule)
  const runNow = useRunNow(project)
  const [cursorKey, setCursorKey] = useState<string | undefined>(undefined)
  const cursorRow = rows.find((row) => row.functionId === cursorKey)

  const pause = useMutation({
    mutationFn: ({ functionId, paused }: { functionId: string; paused: boolean }) =>
      paused ? pauseSchedule({ functionId }) : resumeSchedule({ functionId }),
    onSuccess: (answer) => {
      queryClient.setQueryData<Page<PubsubSchedule>>(pubsubKeys.schedules(project), (page) =>
        page
          ? {
              ...page,
              items: page.items.map((item) =>
                item.functionId === answer.functionId ? answer : item,
              ),
            }
          : page,
      )
      toast({
        key: `pubsub-schedule-${answer.functionId}`,
        title: answer.paused ? `Paused ${answer.functionName}` : `Resumed ${answer.functionName}`,
        description: answer.paused
          ? 'Its clock skips every tick until you resume it; Run now still works.'
          : answer.nextRunAt
            ? `It runs next ${nextRunText(answer.nextRunAt, Date.now())}.`
            : undefined,
      })
    },
    onError: (error, { functionId }) =>
      toast({
        key: `pubsub-schedule-${functionId}`,
        title: 'Could not change the schedule',
        description: errorText(error),
        tone: 'danger',
      }),
  })

  const askRunNow = (row: PubsubSchedule, anchor?: Element | null) =>
    runNow.ask(row, anchor ?? rowElement(TABLE, row.functionId))

  useShortcuts({ id: 'pubsub-schedules', label: 'Schedules' }, [
    {
      key: 'r',
      label: 'Run the schedule now',
      when: () => cursorRow !== undefined || open !== undefined,
      run: () => {
        const row = cursorRow ?? open
        if (row) askRunNow(row)
      },
    },
    {
      key: 'l',
      label: 'Open the latest run’s logs',
      when: () => open !== undefined && lastRun(open) !== undefined,
      run: () => {
        const run = open ? lastRun(open) : undefined
        if (!open || !run) return
        const link = linkToLogs(runLogs(open, run))
        void navigate({ to: link.to as never, search: link.search as never })
      },
    },
    {
      key: 'Escape',
      label: 'Close the schedule',
      when: () => open !== undefined,
      run: () => update({ schedule: undefined }),
    },
  ])
  useSchedulesPalette({
    schedule: open,
    onRunNow: () => open && askRunNow(open),
    onPause: () => open && pause.mutate({ functionId: open.functionId, paused: !open.paused }),
  })

  const rowMenu = (row: PubsubSchedule): RowMenuItem[] => {
    const fn = linkTo(row.functionRef)
    return [
      {
        id: 'open',
        label: 'Open',
        icon: SidebarSimpleIcon,
        shortcut: 'Enter',
        run: () => update({ schedule: row.functionId }),
      },
      {
        id: 'run-now',
        label: 'Run now…',
        icon: PlayIcon,
        shortcut: 'r',
        run: () => askRunNow(row),
      },
      {
        id: 'pause',
        label: row.paused ? 'Resume' : 'Pause',
        icon: row.paused ? PlayIcon : PauseIcon,
        disabled: !row.automatic
          ? 'The clock does not run it; there is nothing to pause.'
          : undefined,
        run: () => pause.mutate({ functionId: row.functionId, paused: !row.paused }),
      },
      {
        id: 'function',
        label: 'Open in Functions',
        icon: LightningIcon,
        disabled: fn ? undefined : 'Functions is not shown in this console yet.',
        run: () => {
          if (fn) void navigate({ to: fn.to as never, search: fn.search as never })
        },
      },
      {
        id: 'topic',
        label: `Open ${shortName(row.topic)}`,
        icon: ArrowSquareOutIcon,
        run: () => {
          const topic = linkTo({ kind: 'pubsub.topic', key: row.topic })
          if (topic) void navigate({ to: topic.to as never, search: topic.search as never })
        },
      },
    ]
  }

  const stepTo = (step: -1 | 1) => {
    const at = open ? rows.indexOf(open) : -1
    const row = at === -1 ? undefined : rows[at + step]
    return row ? () => update({ schedule: row.functionId }, { replace: true }) : undefined
  }

  return (
    <SectionBody testId="pubsub-schedules-body">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {query.isError ? (
          <QueryError error={query.error} onRetry={() => void query.refetch()} section="pubsub" />
        ) : (
          <DataTable
            ariaLabel="Scheduled functions"
            rows={rows}
            rowKey={(row) => row.functionId}
            columns={SCHEDULE_COLUMNS}
            memoryKey="pubsub.schedules"
            openKey={open?.functionId}
            onOpen={(row) => update({ schedule: row.functionId })}
            onCursorChange={(row) => {
              setCursorKey(row.functionId)
              if (open && open.functionId !== row.functionId)
                update({ schedule: row.functionId }, { replace: true })
            }}
            rowClick="open"
            rowMenu={rowMenu}
            loading={query.isPending}
            footer={
              rows.length > 0 && (
                <TableFooter
                  loaded={rows.length}
                  hasMore={false}
                  hiddenColumns={hidden.hidden}
                  onShowAll={hidden.showAll}
                  noun={{ one: 'schedule', other: 'schedules' }}
                  testId="pubsub-schedules-footer"
                />
              )
            }
            empty={
              <EmptyState
                icon={CalendarBlankIcon}
                title="No scheduled functions"
                description="A function exported with onSchedule appears here, with when it runs next. Run it now, or pause its clock while you work on something else."
                commandLine={"exports.nightly = onSchedule('every day 03:00', async () => { … })"}
                testId="pubsub-schedules-empty"
              />
            }
            testId={TABLE}
          />
        )}
      </div>
      {open && (
        <ScheduleInspector
          schedule={open}
          onClose={() => update({ schedule: undefined })}
          onPrev={stepTo(-1)}
          onNext={stepTo(1)}
          onRunNow={(anchor) => askRunNow(open, anchor)}
          onPause={(paused) => pause.mutate({ functionId: open.functionId, paused })}
          pausing={pause.isPending}
        />
      )}
      {runNow.element}
    </SectionBody>
  )
}

/** What the page offers ⌘K while a schedule is open. */
function useSchedulesPalette({
  schedule,
  onRunNow,
  onPause,
}: {
  schedule: PubsubSchedule | undefined
  onRunNow: () => void
  onPause: () => void
}) {
  const register = usePaletteProviders((state) => state.register)
  const unregister = usePaletteProviders((state) => state.unregister)
  const actions = useRef({ schedule, onRunNow, onPause })
  useLayoutEffect(() => {
    actions.current = { schedule, onRunNow, onPause }
  })
  useEffect(() => {
    register('pubsub-schedules', (query) => {
      const { schedule: current, onRunNow: run, onPause: pauseIt } = actions.current
      if (!current) return []
      const items: PaletteItem[] = [
        {
          id: 'pubsub.schedules.run',
          title: `Run ${current.functionName} now…`,
          keywords: 'schedule cron trigger',
          icon: <PlayIcon size={16} />,
          run,
        },
        ...(current.automatic
          ? [
              {
                id: 'pubsub.schedules.pause',
                title: `${current.paused ? 'Resume' : 'Pause'} ${current.functionName}`,
                keywords: 'schedule cron clock',
                icon: current.paused ? <PlayIcon size={16} /> : <PauseIcon size={16} />,
                run: pauseIt,
              },
            ]
          : []),
      ].filter((item) => matchesQuery(item, query))
      return items.length > 0 ? [{ label: 'Schedules', items }] : []
    })
    return () => unregister('pubsub-schedules')
  }, [register, unregister, actions])
}
