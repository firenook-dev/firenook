// Logs and the Overview (observe's cards): the Logs page as a workbench
// (facets, the two toolbar rows, rows by level, markers, a gap, a group, an
// expanded payload, the paused pill and the volume strip), the Overview
// from its suite banners down to the engine's buffers, and the data jobs
// (a reset followed to its end, a snapshot ready, the save dialog refusing
// a folder). Each piece is the page's own component under the console's
// providers, fed what the engine would answer; nothing here fetches, so the
// live parts (the feed, the jobs) are given their state rather than
// subscribed. A modal cannot sit inside a card: the reset confirmation is
// the real DangerConfirmBody at rest, handed each state of its job, and the
// save dialog is drawn from the parts it is made of.

import { Button, Radio, TooltipProvider } from '@cloudflare/kumo'
import { FloppyDiskIcon, XIcon } from '@phosphor-icons/react'
import { QueryClient, QueryClientProvider, type UseQueryResult } from '@tanstack/react-query'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from '@tanstack/react-router'
import { type ReactNode, createContext, use, useState } from 'react'
import type { ConsoleStatus } from '@/api/generated/ConsoleStatus'
import type { ExportDestination } from '@/api/generated/ExportDestination'
import type { Job } from '@/api/generated/Job'
import type { Badge } from '@/api/generated/live/Badge'
import type { LogEntry } from '@/api/generated/observe/LogEntry'
import type { LogFacets } from '@/api/generated/observe/LogFacets'
import type { LogHistogram } from '@/api/generated/observe/LogHistogram'
import type { OverviewEngineDetails } from '@/api/generated/observe/OverviewEngineDetails'
import type { OverviewState } from '@/api/generated/observe/OverviewState'
import { statusQuery } from '@/api/queries'
import { CopyField } from '@/components/console/copy-button'
import { DangerConfirmBody } from '@/components/console/danger-confirm'
import { FeedList, useFeedPending } from '@/components/console/feed-list'
import { FilterField } from '@/components/console/filter-field'
import { MatchCount } from '@/components/console/match-count'
import { PauseButton } from '@/components/console/pause-button'
import { SectionBody } from '@/components/console/section-page'
import { ShellBanners } from '@/components/console/shell-banners'
import { SectionToolbar, ToolbarDivider, ToolbarRow } from '@/components/console/toolbar'
import { formatCount } from '@/lib/format'
import { useLayout } from '@/lib/layout'
import { createFeedStore } from '@/lib/live/feed-store'
import { FacetsPanel } from '@/logs/components/facets-panel'
import { LogDetail } from '@/logs/components/log-detail'
import { LogMenu, type LogMenuActions } from '@/logs/components/log-menu'
import { type EdgeFacts, FeedMarker, LogRow, type RowActions } from '@/logs/components/log-row'
import { RangePicker } from '@/logs/components/range-picker'
import { gapWords } from '@/logs/feed'
import { LOGS_PLACEHOLDER, logFields } from '@/logs/fields'
import { type LogItem, edgeItem, groupLines, itemKey } from '@/logs/rows'
import { bucketSentence, bucketSpan, levelBuckets } from '@/observe/level-bars'
import { LevelStrip } from '@/observe/level-strip'
import { ConnectSection } from '@/overview/components/connect'
import { DataCards } from '@/overview/components/data-section'
import { EngineDetails } from '@/overview/components/engine-details'
import { Infrastructure } from '@/overview/components/infrastructure'
import { NotRunning } from '@/overview/components/not-running'
import { Notices } from '@/overview/components/notices'
import { OverviewHeader } from '@/overview/components/overview-header'
import { RecentProblems } from '@/overview/components/problems'
import { SectionCard } from '@/overview/components/section-card'
import { SnapshotTargets, snapshotServices } from '@/overview/components/snapshot-targets'
import { LINK_CLASS } from '@/overview/components/text-link'
import { absentGroups, absentSections, infrastructure, sectionCards } from '@/overview/model'
import type { SnapshotView } from '@/overview/snapshot'
import { sectionEntry, testStatus } from '@/test/status'
import { defineCards } from '../registry'
import { Section, Stack } from './shared'

// ---- the engine the cards stand in front of -----------------------------

const PROJECT = 'demo-shop'
const DAY = '2026-10-12T'
const at = (time: string) => `${DAY}${time}Z`
/**
 * A moment `ms` before the card is drawn: the Overview says "up 4 min" and
 * "just now", as a page open on a running engine does, on any day the card
 * is captured. The Logs page shows clock times, so its lines keep theirs.
 */
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
const MINUTE = 60_000
/** A cursor as the engine writes it: this run's epoch, then the line's place. */
const cursor = (seq: number) => `7f3a9c21.${seq}`
const noop = () => {}
/** The shell's section panel width (`PANEL_WIDTH`), where the facets sit. */
const PANEL = 264

const SERVICES = [
  ['firestore', 8080],
  ['auth', 9099],
  ['functions', 5001],
  ['hub', 4400],
  ['ui', 4000],
  ['logging', 4500],
  ['firestore.websocket', 9150],
] as const

/**
 * An engine mid-session: Firestore holds data and one rules file stopped
 * compiling; Authentication counts nothing yet; Functions and Extensions
 * are still starting; Storage was left out with `--only`, Pub/Sub is not
 * configured. A test harness paused background triggers, and an app wrote
 * to another project id.
 */
const STATUS: ConsoleStatus = testStatus({
  projectId: PROJECT,
  engine: {
    name: 'Firenook',
    version: '0.2.0',
    revision: '3f9c2a17b4e1d0c85a6e',
    consoleBuild: 'design-system',
  },
  instance: 'engine-run-1',
  startedAt: ago(4 * MINUTE + 12_000),
  services: SERVICES.map(([name, port]) => ({
    name,
    host: '127.0.0.1',
    port,
    listening: true,
    pid: null,
  })),
  sections: [
    sectionEntry('firestore', {
      summary: {
        headline: '1,616 documents · 2 databases',
        figures: [
          { label: 'Documents', value: 1_616, unit: 'count' },
          { label: 'Databases', value: 2, unit: 'count' },
        ],
      },
    }),
    sectionEntry('auth'),
    sectionEntry('storage', {
      state: 'absent',
      reason: 'excluded-by-only',
      detail: 'This engine was started with --only firestore,auth,functions.',
      fixes: [
        {
          label: 'Start with Storage',
          kind: 'command',
          text: `firenook emulators:start --only firestore,auth,functions,storage --project ${PROJECT}`,
        },
      ],
    }),
    sectionEntry('functions', { state: 'starting', detail: 'Discovering functions.' }),
    sectionEntry('extensions', { state: 'starting', detail: 'Discovering functions.' }),
    sectionEntry('pubsub', {
      state: 'absent',
      reason: 'not-configured',
      detail: 'firebase.json does not configure the Pub/Sub emulator.',
      fixes: [
        {
          label: 'Add it to firebase.json',
          kind: 'firebase-json',
          text: '"emulators": { "pubsub": {} }',
        },
      ],
    }),
    sectionEntry('logs', {
      summary: {
        headline: '4,282 lines · 2 errors',
        figures: [
          { label: 'Lines kept', value: 4_282, unit: 'count' },
          { label: 'Errors since start', value: 2, unit: 'count' },
        ],
      },
    }),
  ],
  backgroundTriggers: {
    enabled: false,
    since: ago(2 * MINUTE),
    dropped: [{ service: 'firestore', count: 312 }],
  },
  foreignProjects: [
    { projectId: 'my-prod', services: ['firestore'], firstSeen: ago(3 * MINUTE), requests: 18 },
  ],
  data: {
    mode: 'disk',
    stateDir: '/work/demo-shop/.firenook/state',
    resumed: true,
    importedFrom: '/work/demo-shop/seed',
    exportOnExit: '/work/demo-shop/exports/latest',
    durability: 'write-behind',
  },
})

/** The same engine at rest: nothing paused, nobody using another project. */
const CALM: ConsoleStatus = {
  ...STATUS,
  backgroundTriggers: { enabled: true, since: null, dropped: [] },
  foreignProjects: [],
}

/** The badges the shell holds: one rules file does not compile, two errors are new. */
const BADGES: ReadonlyMap<string, Badge> = new Map([
  [
    'firestore.rules',
    {
      id: 'firestore.rules',
      count: 1,
      kind: 'gauge',
      tone: 'danger',
      noun: { one: 'rules file does not compile', other: 'rules files do not compile' },
    },
  ],
  [
    'logs.errors',
    {
      id: 'logs.errors',
      count: 2,
      kind: 'counter',
      tone: 'attention',
      noun: { one: 'new error', other: 'new errors' },
      cursor: cursor(4_270),
    },
  ],
])

const ENGINE: OverviewEngineDetails = {
  config: {
    host: '127.0.0.1',
    connectHost: '127.0.0.1',
    projectDir: '/work/demo-shop',
    firebaseJson: '/work/demo-shop/firebase.json',
    diagnostics: false,
    debugLog: '/work/demo-shop/firebase-debug.log',
    singleProjectMode: true,
    offline: false,
    demoProject: true,
    node: '/usr/local/bin/node',
    defaultBucket: `${PROJECT}.appspot.com`,
    selected: ['firestore', 'auth', 'functions'],
  },
  connection: {
    env: [
      {
        name: 'FIRESTORE_EMULATOR_HOST',
        value: '127.0.0.1:8080',
        service: 'firestore',
        setBy: 'exec',
        note: null,
      },
      {
        name: 'FIREBASE_AUTH_EMULATOR_HOST',
        value: '127.0.0.1:9099',
        service: 'auth',
        setBy: 'exec',
        note: null,
      },
      {
        name: 'FIREBASE_EMULATOR_HUB',
        value: '127.0.0.1:4400',
        service: 'hub',
        setBy: 'exec',
        note: null,
      },
    ],
  },
}

/** What the card's router draws: the card, handed down through context. */
const CardContent = createContext<ReactNode>(null)

function CardRoot() {
  return <>{use(CardContent)}</>
}

/**
 * The console's providers around a card: the engine's status already in
 * the query client, a router for links and search params, and tooltips.
 */
function Kit({ status = STATUS, children }: { status?: ConsoleStatus; children: ReactNode }) {
  const [client] = useState(() => {
    const created = new QueryClient({
      defaultOptions: {
        queries: { staleTime: Number.POSITIVE_INFINITY, retry: false, refetchOnMount: false },
      },
    })
    created.setQueryData(statusQuery.queryKey, status)
    return created
  })
  const [router] = useState(() =>
    createRouter({
      routeTree: createRootRoute({ component: CardRoot }),
      history: createMemoryHistory({ initialEntries: ['/'] }),
    }),
  )
  return (
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <CardContent value={children}>
          <RouterProvider router={router} />
        </CardContent>
      </TooltipProvider>
    </QueryClientProvider>
  )
}

/** A query the page would hold, answered: what a component takes as `UseQueryResult`. */
function answered<T>(data: T): UseQueryResult<T> {
  return {
    data,
    isPending: false,
    isError: false,
    isFetching: false,
    error: null,
    refetch: () => Promise.resolve(),
  } as unknown as UseQueryResult<T>
}

// ---- logs ------------------------------------------------------------------

const hello = {
  service: 'functions',
  source: 'functions[us-central1-hello]',
  function: 'us-central1-hello',
  codebase: 'default',
  execution: 'a3f9c1-1284',
}

/** The lines on screen, oldest first, as the engine pages them. */
const LINES: LogEntry[] = [
  {
    cursor: cursor(1),
    time: at('06:04:31.204'),
    level: 'info',
    service: 'hub',
    message: 'All emulators ready! It is now safe to connect your app.',
  },
  {
    cursor: cursor(2),
    time: at('06:04:33.880'),
    level: 'info',
    service: 'firestore',
    kind: 'rules.applied',
    message: 'Firestore rules applied from the console',
    payload: { origin: 'console' },
  },
  {
    ...hello,
    cursor: cursor(3),
    time: at('06:06:09.117'),
    level: 'info',
    kind: 'function.start',
    message: 'Beginning execution of "us-central1-hello"',
    payload: { method: 'GET', path: '/?cart=c_19' },
  },
  {
    ...hello,
    cursor: cursor(4),
    time: at('06:06:09.120'),
    level: 'debug',
    message: 'cache miss for cart c_19',
  },
  {
    ...hello,
    cursor: cursor(5),
    time: at('06:06:09.126'),
    level: 'warn',
    message: 'Cart is empty',
    payload: { cartId: 'c_19', items: 0, user: { uid: 'u_9f3k2', plan: 'free' } },
  },
  {
    ...hello,
    cursor: cursor(6),
    time: at('06:06:09.311'),
    level: 'info',
    kind: 'function.finish',
    message: 'Finished "us-central1-hello" in 194ms',
    payload: { durationMs: 194, status: 200, outcome: 'ok' },
  },
  ...Array.from({ length: 12 }, (_, index): LogEntry => ({
    cursor: cursor(7 + index),
    time: at(`06:06:${String(10 + index * 5).padStart(2, '0')}.002`),
    level: 'info',
    service: 'functions',
    source: 'functions[us-central1-heartbeat]',
    function: 'us-central1-heartbeat',
    message: 'heartbeat ok',
  })),
]

/** After the gap: an error with its stack, two denials told apart, a reset. */
const LATER: LogEntry[] = [
  {
    cursor: cursor(3_140),
    time: at('06:07:44.502'),
    level: 'error',
    service: 'functions',
    source: 'functions[us-central1-checkout]',
    function: 'us-central1-checkout',
    execution: 'c71e04-1290',
    message:
      "TypeError: Cannot read properties of undefined (reading 'total')\n    at checkout (functions/index.js:41:22)\n    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)",
  },
  {
    cursor: cursor(3_141),
    time: at('06:07:52.031'),
    level: 'warn',
    service: 'firestore',
    kind: 'rules.denied',
    message: 'Rules denied get on users/u_2fc4c for u_9f3k2',
    payload: {
      method: 'get',
      path: 'users/u_2fc4c',
      database: '(default)',
      uid: 'u_9f3k2',
      requestId: 'r_81',
      origin: 'app',
    },
    refs: [
      { kind: 'firestore.document', key: '(default)|users/u_2fc4c' },
      { kind: 'firestore.decision', key: '(default)|r_81' },
    ],
  },
  {
    cursor: cursor(3_142),
    time: at('06:07:58.090'),
    level: 'info',
    service: 'firestore',
    kind: 'rules.denied.console',
    message: 'Rules denied list on users/u_2fc4c/orders from the console (viewing as u_9f3k2)',
    refs: [
      { kind: 'firestore.collection', key: '(default)|users/u_2fc4c/orders' },
      { kind: 'firestore.decision', key: '(default)|r_82' },
    ],
  },
  {
    cursor: cursor(3_143),
    time: at('06:08:02.400'),
    level: 'info',
    service: 'firestore',
    kind: 'data.reset',
    message: 'Firestore reset from the console: 1,616 documents deleted',
    payload: { section: 'firestore', removed: 1_616, durationMs: 840, cancelled: false },
  },
  {
    ...hello,
    execution: 'b81d22-1301',
    cursor: cursor(3_144),
    time: at('06:08:04.010'),
    level: 'info',
    kind: 'function.start',
    message: 'Beginning execution of "us-central1-hello"',
    payload: { method: 'GET', path: '/?cart=c_20' },
  },
  {
    ...hello,
    execution: 'b81d22-1301',
    cursor: cursor(3_145),
    time: at('06:08:04.022'),
    level: 'info',
    message: 'cart c_20 has 3 items',
  },
  {
    ...hello,
    execution: 'b81d22-1301',
    cursor: cursor(3_146),
    time: at('06:08:04.140'),
    level: 'info',
    kind: 'function.finish',
    message: 'Finished "us-central1-hello" in 130ms',
    payload: { durationMs: 130, status: 200, outcome: 'ok' },
  },
  {
    cursor: cursor(3_147),
    time: at('06:08:05.500'),
    level: 'info',
    service: 'functions',
    source: 'functions[us-central1-onCartDeleted]',
    function: 'us-central1-onCartDeleted',
    execution: 'e02b9f-1302',
    message: 'cart c_7 deleted; releasing its 2 reserved items',
  },
]

/** Lines that arrive while the reader is paused: counted, not drawn. */
const ARRIVING: LogEntry[] = Array.from({ length: 37 }, (_, index) => ({
  cursor: cursor(3_148 + index),
  time: at('06:08:10.000'),
  level: 'info',
  service: 'auth',
  message: `Sign-in link sent to user${index}@example.test`,
}))

const FACETS: LogFacets = {
  kept: 4_282,
  matched: 4_275,
  logged: 4_282,
  lastReload: at('06:05:58.000'),
  internalHidden: 7,
  levels: [
    { value: 'debug', count: 18 },
    { value: 'info', count: 4_220 },
    { value: 'warn', count: 35 },
    { value: 'error', count: 2 },
  ],
  services: [
    { value: 'functions', count: 4_190 },
    { value: 'auth', count: 61 },
    { value: 'firestore', count: 21 },
    { value: 'hub', count: 3 },
    { value: 'pubsub', count: 7 },
  ],
  functions: [
    { value: 'us-central1-heartbeat', count: 3_610 },
    { value: 'us-central1-hello', count: 480 },
    { value: 'us-central1-checkout', count: 96 },
    { value: 'us-central1-onCartDeleted', count: 4 },
  ],
  instances: [],
  codebases: [{ value: 'default', count: 4_190 }],
  kinds: [
    { value: 'rules.denied', count: 8 },
    { value: 'function.start', count: 520 },
    { value: 'function.finish', count: 518 },
    { value: 'rules.denied.console', count: 3 },
    { value: 'data.reset', count: 1 },
  ],
}

/** The last hour a minute at a time: a burst at 41 with the errors it set off. */
const HISTOGRAM: LogHistogram = {
  from: at('05:08:00.000'),
  to: at('06:08:00.000'),
  bucketMs: 60_000,
  buckets: Array.from({ length: 60 }, (_, minute) => ({
    debug: minute % 7 === 0 ? 2 : 0,
    info: minute === 41 ? 180 : Math.round(40 + 28 * Math.sin(minute / 6) + ((minute * 37) % 19)),
    warn: minute % 9 === 0 ? 4 : minute === 41 ? 12 : 0,
    error: minute === 41 ? 2 : 0,
  })),
}

const Q = '-service:pubsub'

const ACTIONS: { current: RowActions } = {
  current: { pickToken: noop, toggleExpanded: noop, filterPayload: noop },
}
const MENU: LogMenuActions = {
  downloadNdjson: noop,
  downloadText: noop,
  copyVisible: noop,
  clearView: noop,
  showCleared: noop,
  setWrap: noop,
  setKeep: noop,
  applySaved: noop,
  save: noop,
  forget: noop,
}
const EDGES: EdgeFacts = {
  evicted: false,
  debugLog: ENGINE.config?.debugLog,
  narrowed: false,
  clearedAt: undefined,
  startedAt: at('06:04:28.000'),
  showCleared: noop,
}

/** The feed as the page holds it: grouped rows, a gap marker, then paused with lines counted. */
function useLogStore() {
  const [store] = useState(() => {
    const created = createFeedStore<LogItem>({ max: 20_000, key: itemKey, pausedMode: 'freeze' })
    created.push([edgeItem('start'), ...groupLines(LINES).rows])
    created.marker({ kind: 'marker', key: 'gap:1', text: gapWords('gap', 3_120) })
    created.push(groupLines(LATER).rows)
    created.pause()
    created.push(groupLines(ARRIVING).rows)
    return created
  })
  return store
}

/** The section panel's slot, where the facets portal as they do in the shell. */
function PanelSlot() {
  const setSlot = useLayout((state) => state.setSlot)
  return (
    <aside
      ref={setSlot}
      aria-label="Filters"
      className="flex min-h-0 shrink-0 flex-col border-r border-kumo-line bg-kumo-base"
      style={{ width: PANEL }}
    />
  )
}

function LogsPageSample() {
  const store = useLogStore()
  const pending = useFeedPending(store, true, itemKey, 'freeze')
  const [q, setQ] = useState(Q)
  const expanded = new Set([cursor(5)])
  const buckets = levelBuckets(HISTOGRAM.buckets)
  return (
    <div className="flex h-[620px] min-w-0 overflow-hidden rounded-lg bg-kumo-base ring ring-kumo-line">
      <PanelSlot />
      <FacetsPanel q={q} onChange={setQ} facets={FACETS} />
      <div className="flex min-w-0 flex-1 flex-col">
        <SectionToolbar>
          <ToolbarRow>
            <RangePicker
              from={undefined}
              to={undefined}
              lastReload={FACETS.lastReload}
              kept={FACETS.kept}
              onChange={noop}
            />
            <div className="mx-2 flex min-w-0 flex-1 items-center">
              <LevelStrip
                buckets={buckets}
                height={24}
                label="Lines over the window, by level: click a bar or drag across bars to read that time"
                tooltip={(index) => {
                  const bucket = HISTOGRAM.buckets[index]
                  if (!bucket) return ''
                  const start = Date.parse(HISTOGRAM.from) + index * HISTOGRAM.bucketMs
                  return bucketSentence(bucket, bucketSpan(start, HISTOGRAM.bucketMs))
                }}
                onPick={noop}
                className="w-full"
              />
            </div>
            <ToolbarDivider />
            <LogMenu
              wrap={false}
              keep={false}
              cleared={false}
              canClear={undefined}
              hasFilter
              saved={[
                {
                  name: 'Checkout, warn and up',
                  q: 'function:us-central1-checkout -level:info -level:debug',
                },
              ]}
              actions={MENU}
            />
          </ToolbarRow>
          <ToolbarRow variant="line">
            <div className="flex min-w-0 flex-1">
              <FilterField
                value={q}
                onChange={setQ}
                fields={logFields(FACETS)}
                placeholder={LOGS_PLACEHOLDER}
                ariaLabel="Filter the log"
                regex
              />
            </div>
            <MatchCount
              total={{ count: FACETS.matched, exact: true }}
              noun={{ one: 'line', other: 'lines' }}
              widest="00,000 lines"
            />
            <PauseButton paused pending={pending} onChange={noop} />
          </ToolbarRow>
        </SectionToolbar>
        <SectionBody>
          <div className="relative flex min-w-0 flex-1 flex-col bg-kumo-base">
            <FeedList<LogItem>
              ariaLabel="Log lines"
              store={store}
              order="newest-last"
              rowHeight={24}
              rowKey={itemKey}
              renderRow={(item) => (
                <LogRow
                  item={item}
                  wrap={false}
                  expanded={expanded.has(item.key)}
                  highlight={undefined}
                  actions={ACTIONS}
                  edges={EDGES}
                />
              )}
              expanded={expanded}
              renderExpanded={(item) =>
                item.kind === 'line' ? (
                  <LogDetail
                    entry={item.entry}
                    wrap={false}
                    highlight={undefined}
                    onFilter={noop}
                  />
                ) : null
              }
              onToggleExpanded={noop}
              renderMarker={(row) => <FeedMarker text={row.text} action={row.action} />}
              selectedKey={cursor(5)}
              onSelect={noop}
              pausedMode="freeze"
              follow={false}
              onFollowChange={noop}
              empty={<p />}
            />
          </div>
        </SectionBody>
      </div>
    </div>
  )
}

function LogsCard() {
  return (
    <Kit status={CALM}>
      <Stack>
        <Section
          title="Logs"
          note="Every service in one stream. Facets count what the engine keeps (Only and Hide on each row; Hide strikes a value through); row one is the window (range, volume strip, the view's menu), row two the query with its count and the pause; markers are moments, a gap says how many lines left the engine, repeats fold into ×N, a payload opens in place, and a paused feed counts what arrives."
        >
          <LogsPageSample />
        </Section>
      </Stack>
    </Kit>
  )
}

// ---- overview --------------------------------------------------------------

const OVERVIEW: OverviewState = {
  generatedAt: ago(0),
  notices: [
    {
      level: 'info',
      code: 'diagnosticsOff',
      message:
        'Diagnostics are off (--no-diagnostics), so the rules pages show no requests and no coverage.',
    },
  ],
  problems: [
    {
      cursor: cursor(3_141),
      time: ago(20_000),
      level: 'warn',
      kind: 'rules.denied',
      source: 'firestore',
      firstLine: 'Rules denied get on users/u_2fc4c for u_9f3k2',
      refs: [
        { kind: 'firestore.document', key: '(default)|users/u_2fc4c' },
        { kind: 'firestore.decision', key: '(default)|r_81' },
      ],
    },
    {
      cursor: cursor(3_140),
      time: ago(28_000),
      level: 'error',
      kind: null,
      source: 'functions[us-central1-checkout]',
      firstLine: "TypeError: Cannot read properties of undefined (reading 'total')",
      refs: [],
    },
    {
      cursor: cursor(1_802),
      time: ago(3 * MINUTE),
      level: 'warn',
      kind: 'rules.fileError',
      source: 'firestore',
      firstLine:
        'database "(default)" rules in firestore.rules did not compile; the rules in force are unchanged: 14:5 unexpected token',
      refs: [],
    },
  ],
  hour: HISTOGRAM.buckets,
  logs: { entries: 4_282, errors: 2, warnings: 35, problems: 10 },
}

const RESET_JOB: Job = {
  id: 'job-reset',
  kind: 'suite.clear',
  section: 'suite',
  title: 'Clear Firestore',
  total: 1_616,
  done: 412,
  skipped: 0,
  errors: [],
  errorCount: 0,
  state: 'running',
  startedAt: new Date(Date.now() - 4_000).toISOString(),
  finishedAt: null,
}

const SNAPSHOT_JOB: Job = {
  id: 'job-snapshot',
  kind: 'suite.snapshot',
  section: 'suite',
  title: 'Prepare a snapshot',
  total: 1,
  done: 1,
  skipped: 0,
  errors: [],
  errorCount: 0,
  state: 'done',
  startedAt: ago(MINUTE),
  finishedAt: ago(MINUTE - 2_000),
  result: { snapshot: '0f3a9c217be4d05a6e1c8b2d94f7a360', files: 3, bytes: 2_412_544 },
}

/** The page's snapshot flow, fixed: nothing prepared unless a sample says so. */
function snapshotView(overrides: Partial<SnapshotView>): SnapshotView {
  return {
    running: undefined,
    job: undefined,
    ready: undefined,
    taken: undefined,
    refusal: undefined,
    starting: false,
    start: () => Promise.resolve(false),
    download: noop,
    file: { data: undefined },
    ...overrides,
  }
}

const RESETTING = snapshotView({ running: RESET_JOB, job: SNAPSHOT_JOB })

const READY = snapshotView({
  job: SNAPSHOT_JOB,
  ready: { snapshot: '0f3a9c217be4d05a6e1c8b2d94f7a360', files: 3, bytes: 2_412_544 },
  file: {
    data: {
      id: '0f3a9c217be4d05a6e1c8b2d94f7a360',
      files: 3,
      bytes: 2_412_544,
      expiresAt: new Date(Date.now() + 9 * MINUTE).toISOString(),
    },
  },
})

const PREPARING = snapshotView({
  running: {
    ...SNAPSHOT_JOB,
    id: 'job-snapshot-2',
    done: 0,
    state: 'running',
    finishedAt: null,
    startedAt: new Date(Date.now() - 2_000).toISOString(),
  },
})

const RUNNING = { one: 'running', other: 'running' }

/** An overview part's heading, as the page writes it. */
function PartTitle({ children }: { children: ReactNode }) {
  return <h2 className="text-lg font-semibold">{children}</h2>
}

function OverviewSample() {
  const cards = sectionCards(STATUS, BADGES)
  const absent = absentGroups(STATUS)
  const listeners = infrastructure(STATUS)
  return (
    <div className="flex min-w-0 flex-col overflow-hidden rounded-lg bg-kumo-canvas ring ring-kumo-line">
      <ShellBanners />
      <div className="mx-auto grid w-full max-w-[1320px] gap-9 p-6 pb-10">
        <div className="grid gap-4">
          <OverviewHeader status={STATUS} />
          <Notices notices={OVERVIEW.notices} instance={STATUS.instance} />
        </div>
        <section className="grid gap-4">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-3">
            <PartTitle>Sections</PartTitle>
            <span className="text-[12px] text-kumo-subtle">
              {formatCount(cards.length, RUNNING)} · {absentSections(STATUS).length} not running
            </span>
          </div>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(272px,1fr))] gap-3">
            {cards.map((card) => (
              <SectionCard key={card.section.id} card={card} tick={STATUS} onConnect={noop} />
            ))}
          </div>
          <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-6 gap-y-4 pt-1">
            <Infrastructure entries={listeners} />
            <NotRunning groups={absent} />
          </dl>
        </section>
        <RecentProblems status={STATUS} state={answered(OVERVIEW)} live="live" />
        <ConnectSection status={STATUS} engine={ENGINE} param="flutter" onParam={noop} />
        <section className="grid gap-3">
          <PartTitle>Data</PartTitle>
          <DataCards status={STATUS} snapshot={RESETTING} onDialog={noop} onReset={noop} />
        </section>
        <EngineDetails status={STATUS} details={answered(ENGINE)} />
      </div>
    </div>
  )
}

function OverviewCard() {
  return (
    <Kit>
      <Stack>
        <Section
          title="Overview"
          note="The suite's own warnings first, in the shell's words, then this engine's configuration notices. A card per running section — figures, a gauge problem with its page, starting, or what it holds while it counts nothing — and what does not run with the exact fix. Recent problems over the last hour, the code to connect an app, the data jobs (a reset running holds back every other), and the engine with its buffers."
        >
          <OverviewSample />
        </Section>
      </Stack>
    </Kit>
  )
}

// ---- data jobs -------------------------------------------------------------

/** A confirmation as `DangerConfirm` draws it, at rest in the card instead of over the page. */
function DialogFrame({
  title,
  testId,
  children,
}: {
  title: string
  testId?: string
  children: ReactNode
}) {
  return (
    <div
      className="w-[512px] rounded-xl bg-kumo-base p-6 shadow-lg ring ring-kumo-line"
      data-testid={testId}
    >
      <div className="mb-3 flex items-start justify-between gap-4">
        <h3 className="text-lg font-semibold text-kumo-default">{title}</h3>
        <Button variant="ghost" shape="square" icon={<XIcon />} aria-label="Close" />
      </div>
      {children}
    </div>
  )
}

/** Firestore's reset confirmation (`ResetDialog`'s words) in the real DangerConfirmBody, at one point of its job. */
function ResetFrame({ job }: { job: Job | undefined }) {
  return (
    <DangerConfirmBody
      title="Reset Firestore"
      description="Every document in every database is deleted: 1,616 documents · 2 databases."
      consequences={[
        'Functions triggers do not run for these deletions.',
        'Listeners and open pages see the documents go.',
        <>
          Download a snapshot first to get them back.{' '}
          <button type="button" className={LINK_CLASS} disabled={job !== undefined}>
            Download a snapshot
          </button>
        </>,
      ]}
      option={{
        label: 'Run Functions triggers for deleted documents',
        checked: false,
        onChange: noop,
      }}
      job={job}
    />
  )
}

const DESTINATIONS: ExportDestination[] = [
  {
    id: 'export-on-exit',
    label: 'The export-on-exit folder',
    path: '/work/demo-shop/exports/latest',
  },
  {
    id: 'seed',
    label: 'The import seed',
    path: '/work/demo-shop/seed',
    refused: 'The engine resumed its state, so the seed must not change.',
  },
  { id: 'project', label: "The project's export folder", path: '/work/demo-shop/firenook-export' },
]

/** "Save on the engine's machine…" (`SaveSnapshotDialog`'s words), the seed refused. */
function SaveFrame() {
  const services = snapshotServices(STATUS)
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set(services))
  const [picked, setPicked] = useState('export-on-exit')
  return (
    <DialogFrame title="Save a snapshot on the engine's machine">
      <p className="text-[14px] text-kumo-subtle">
        Writes a standard export (
        <span className="font-mono text-[0.9em] text-kumo-default">
          firebase-export-metadata.json
        </span>{' '}
        and its data) that the engine imports with{' '}
        <span className="font-mono text-[0.9em] text-kumo-default">--import</span>.
      </p>
      <div className="mt-5 grid gap-5">
        <div className="grid gap-2">
          <Radio.Group
            legend="Where"
            value={picked}
            onValueChange={(value) => setPicked(String(value))}
            className="[&_legend]:text-[13px] [&_legend]:font-medium"
          >
            {DESTINATIONS.map((entry) => (
              <Radio.Item
                key={entry.id}
                value={entry.id}
                disabled={entry.refused !== undefined}
                label={
                  <span className="grid min-w-0 gap-0.5">
                    <span className="text-[14px]">{entry.label}</span>
                    <span className="truncate font-mono text-[12px] text-kumo-subtle">
                      {entry.path}
                    </span>
                    {entry.refused && (
                      <span className="text-[12px] text-kumo-subtle">{entry.refused}</span>
                    )}
                  </span>
                }
              />
            ))}
          </Radio.Group>
          <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-[13px] text-kumo-subtle">
            Another folder: run
            <CopyField value="firenook emulators:export <dir>" className="text-kumo-default" />
          </p>
        </div>
        <SnapshotTargets
          status={STATUS}
          services={services}
          checked={checked}
          onChange={setChecked}
          testId="ds-save-targets"
        />
        <p className="text-[13px] text-kumo-subtle">
          The folder is replaced as a whole once the new export is complete.
        </p>
      </div>
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="secondary">Close</Button>
        <Button variant="primary" icon={<FloppyDiskIcon />}>
          Save snapshot
        </Button>
      </div>
    </DialogFrame>
  )
}

function DataJobsCard() {
  const stopped: Job = { ...RESET_JOB, state: 'cancelled', finishedAt: ago(1_000) }
  const done: Job = {
    ...RESET_JOB,
    done: 1_616,
    state: 'done',
    finishedAt: ago(500),
  }
  return (
    <Kit status={CALM}>
      <Stack>
        <Section
          title="The data cards"
          note="A snapshot ready to download (the engine keeps it ten minutes, or until it is downloaded); one being prepared, which holds back every other data job and says why."
        >
          <div className="grid gap-4">
            <DataCards status={CALM} snapshot={READY} onDialog={noop} onReset={noop} />
            <DataCards status={CALM} snapshot={PREPARING} onDialog={noop} onReset={noop} />
          </div>
        </Section>
        <Section
          title="A reset, followed by its job"
          note="What goes, what it sets off and the way back; then the job's own progress and Cancel, how far a cancelled one got, and Close once it is done. Every tab hears the end."
        >
          <div className="grid justify-items-start gap-4">
            <ResetFrame job={undefined} />
            <ResetFrame job={RESET_JOB} />
            <ResetFrame job={stopped} />
            <ResetFrame job={done} />
          </div>
        </Section>
        <Section
          title="Saved on the engine's machine"
          note="The browser names a destination, never a path; a folder the engine refuses says why, and any other folder is the command to run."
        >
          <SaveFrame />
        </Section>
      </Stack>
    </Kit>
  )
}

// ---- registration ------------------------------------------------------------

defineCards([
  {
    id: 'logs-stream',
    group: 'Patterns',
    name: 'Logs',
    subtitle:
      'FacetList with Only and Hide, the two toolbar rows with the PauseButton, LogLine rows by level, markers, a gap row, a group, an expanded payload, the paused pill and the MiniBars strip',
    width: 1200,
    surface: 'canvas',
    render: () => <LogsCard />,
  },
  {
    id: 'logs-stream-dark',
    group: 'Patterns',
    name: 'Logs, dark',
    subtitle: 'The same in dark mode',
    width: 1200,
    dark: true,
    surface: 'canvas',
    render: () => <LogsCard />,
  },
  {
    id: 'overview',
    group: 'Patterns',
    name: 'Overview',
    subtitle:
      'ShellBanners above a configuration notice, section cards (figures, a gauge problem, starting, no summary yet), not running with its fixes, recent problems, connect tabs, data cards with a running job, engine details',
    width: 1200,
    surface: 'canvas',
    render: () => <OverviewCard />,
  },
  {
    id: 'overview-dark',
    group: 'Patterns',
    name: 'Overview, dark',
    subtitle: 'The same in dark mode',
    width: 1200,
    dark: true,
    surface: 'canvas',
    render: () => <OverviewCard />,
  },
  {
    id: 'data-jobs',
    group: 'Patterns',
    name: 'Resets and snapshots',
    subtitle:
      'The reset confirmation with job progress, cancelled and done; the snapshot card ready to download; the save dialog with a refused destination (job toasts are the JobsWatch card)',
    width: 880,
    surface: 'canvas',
    render: () => <DataJobsCard />,
  },
])
