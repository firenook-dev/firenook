// The Functions pages' patterns: invocation rows as the function page and
// Invocations draw them (every outcome, the cold mark, a replay, the burst
// marker), one failed invocation in the inspector (its error with linked
// frames, the cause links, timing, the request with a masked header), the
// Run tab of an HTTP function with its answers, and a codebase (its worker,
// its last load, its env files, its load log and the strips it can carry).

import { TooltipProvider } from '@cloudflare/kumo'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from '@tanstack/react-router'
import { type ReactNode, createContext, use, useState } from 'react'
import type { ConsoleStatus } from '@/api/generated/ConsoleStatus'
import type { FunctionCodebase } from '@/api/generated/compute/FunctionCodebase'
import type { FunctionCodebaseEntry } from '@/api/generated/compute/FunctionCodebaseEntry'
import type { FunctionDetail } from '@/api/generated/compute/FunctionDetail'
import type { FunctionLoadLog } from '@/api/generated/compute/FunctionLoadLog'
import type { FunctionLogLine } from '@/api/generated/compute/FunctionLogLine'
import type { FunctionsSnapshot } from '@/api/generated/compute/FunctionsSnapshot'
import type { FunctionSummary } from '@/api/generated/compute/FunctionSummary'
import type { InvocationSummary } from '@/api/generated/compute/InvocationSummary'
import type { InvocationView } from '@/api/generated/compute/InvocationView'
import { statusQuery } from '@/api/queries'
import { ResponseView } from '@/components/console/request/response-view'
import type { ResponseRecord } from '@/components/console/request/types'
import { StatusDot } from '@/components/kit'
import { CodebaseBanners } from '@/functions/components/codebase-banners'
import { CodebaseView, workerWord } from '@/functions/components/codebase-view'
import { useInvocationActions } from '@/functions/components/invocation-actions'
import { InvocationDetail } from '@/functions/components/invocation-detail'
import { InvocationRow, InvocationsHeader } from '@/functions/components/invocation-row'
import { InvokeForm } from '@/functions/components/invoke-form'
import { RunAnswer } from '@/functions/components/run-parts'
import { type InvokeDraft, draftKey, useRunDrafts } from '@/functions/run-drafts'
import { LEADER_LOCK } from '@/lib/live/leader'
import { functionKeys } from '@/functions/api'
import { sectionEntry, testStatus } from '@/test/status'
import { defineCards } from '../registry'
import { Section, Stack } from './shared'

const PROJECT = 'demo-shop'

const STATUS: ConsoleStatus = testStatus({
  projectId: PROJECT,
  services: [
    { name: 'functions', host: '127.0.0.1', port: 5001, listening: true, pid: null },
    { name: 'firestore', host: '127.0.0.1', port: 8080, listening: true, pid: null },
  ],
  sections: ['firestore', 'functions'].map((id) => sectionEntry(id)),
})

const CardContent = createContext<ReactNode>(null)

function CardRoot() {
  return <>{use(CardContent)}</>
}

/**
 * A card has no engine behind it. Holding the live channel's leader lock
 * makes the page a follower waiting for a tab that holds the connection, so
 * a view that follows a topic (a running answer, a load log) draws what the
 * cache was seeded with and opens no connection that could only fail.
 */
function holdLiveConnection() {
  void navigator.locks?.request(LEADER_LOCK, () => new Promise<void>(() => undefined))
}

/** The console's providers around a card, with the cache filled as given. */
function Kit({ fill, children }: { fill?: (client: QueryClient) => void; children: ReactNode }) {
  const [client] = useState(() => {
    // Before any view subscribes: lock requests are granted in order.
    holdLiveConnection()
    const created = new QueryClient({
      defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY, retry: false } },
    })
    created.setQueryData(statusQuery.queryKey, STATUS)
    fill?.(created)
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

const AGO = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString()

function invocation(seq: number, fields: Partial<InvocationSummary>): InvocationSummary {
  return {
    id: `a3f9c1-${seq}`,
    seq,
    functionId: 'us-central1-api',
    codebase: 'app',
    kind: 'http',
    origin: 'client',
    cause: { type: 'http', method: 'GET', path: '/hello' },
    summary: 'GET /hello?x=1',
    startedAt: AGO(12),
    durationMs: 2.6,
    outcome: 'succeeded',
    outcomeClass: 'succeeded',
    status: 200,
    callableStatus: null,
    cold: false,
    attempt: 1,
    eventId: null,
    replayOf: null,
    logCount: 1,
    error: null,
    ...fields,
  }
}

const ROWS: InvocationSummary[] = [
  invocation(1290, {
    summary: 'GET /stream',
    outcome: null,
    outcomeClass: 'running',
    status: null,
    durationMs: null,
    startedAt: AGO(1),
  }),
  invocation(1289, { summary: 'POST /orders', cold: true, durationMs: 820, origin: 'console' }),
  invocation(1288, {
    summary: 'POST /fail',
    outcome: 'failed',
    outcomeClass: 'failed',
    status: 500,
    durationMs: 8.1,
    error: 'Error: boom',
  }),
  invocation(1287, {
    functionId: 'us-central1-addMessage',
    kind: 'callable',
    cause: { type: 'callable', uid: 'u_ada', tenant: null, appCheck: true, streaming: false },
    summary: 'call as u_ada',
    outcome: 'callableError',
    outcomeClass: 'failed',
    status: 400,
    callableStatus: 'INVALID_ARGUMENT',
  }),
  invocation(1286, {
    functionId: 'us-central1-beforeCreate',
    kind: 'blocking',
    cause: {
      type: 'blocking',
      eventType: 'beforeCreate',
      uid: 'u_new',
      email: 'ada@blocked.test',
      tenant: null,
      authCall: null,
    },
    summary: 'beforeCreate for ada@blocked.test',
    outcome: 'blocked',
    outcomeClass: 'succeeded',
    status: 403,
    origin: 'emulator',
  }),
  invocation(1285, {
    functionId: 'us-central1-onOrderCreated',
    kind: 'firestore',
    cause: {
      type: 'firestore',
      eventType: 'document.create',
      database: '(default)',
      document: 'orders/o_123',
      eventId: 'e1',
    },
    summary: 'orders/o_123 created',
    outcome: 'paused',
    outcomeClass: 'skipped',
    status: null,
    origin: 'emulator',
    durationMs: 0.1,
  }),
  invocation(1284, {
    functionId: 'us-central1-onOrderCreated',
    kind: 'firestore',
    cause: {
      type: 'firestore',
      eventType: 'document.create',
      database: '(default)',
      document: 'orders/o_2',
      eventId: 'e2',
    },
    summary: 'orders/o_2 created',
    origin: 'replay',
    replayOf: 'a3f9c1-1280',
    status: 200,
    durationMs: 6.0,
  }),
]

function Rows({ variant }: { variant: 'function' | 'all' }) {
  return (
    <div className="overflow-hidden rounded-lg bg-kumo-base ring ring-kumo-line">
      {variant === 'all' && (
        <div className="border-b border-kumo-line bg-kumo-elevated">
          <InvocationsHeader />
        </div>
      )}
      {ROWS.map((row, index) => (
        <div
          key={row.id}
          className={`flex border-b border-kumo-hairline last:border-b-0 ${index === 2 ? 'bg-kumo-tint shadow-[inset_2px_0_0_var(--color-kumo-brand)]' : ''}`}
        >
          <InvocationRow invocation={row} variant={variant} clock="time" menu={[]} />
        </div>
      ))}
      <div className="flex h-8 items-center gap-2 px-3 text-[11px] text-kumo-subtle">
        1,840 more · Show
      </div>
    </div>
  )
}

function InvocationRowsCard() {
  return (
    <Kit>
      <Stack>
        <Section
          title="One function's invocations"
          note="Outcome (the engine's word and tone), what it was in words, how long with the cold mark, who caused it, when. A burst becomes one marker row."
        >
          <Rows variant="function" />
        </Section>
        <Section
          title="Every function's, on Invocations"
          note="The time leads; the function and its kind come before the summary; narrow lists give up the kind and origin columns first."
        >
          <Rows variant="all" />
        </Section>
      </Stack>
    </Kit>
  )
}

const FAILED: InvocationView = {
  detail: {
    summary: invocation(1288, {
      summary: 'POST /fail',
      outcome: 'failed',
      outcomeClass: 'failed',
      status: 500,
      durationMs: 8.1,
      cold: true,
      error: 'Error: boom',
    }),
    request: {
      target: 'url',
      method: 'POST',
      path: '/fail',
      headers: [
        { name: 'authorization', value: null, sensitive: true },
        { name: 'content-type', value: 'application/json', sensitive: false },
        { name: 'x-demo', value: '1', sensitive: false },
      ],
      contentType: 'application/json',
      body: { size: 18, truncated: false, encoding: 'text', text: '{"name":"Ada"}' },
    },
    response: {
      status: 500,
      headers: [{ name: 'content-type', value: 'text/plain', sensitive: false }],
      contentType: 'text/plain',
      body: { size: 4, truncated: false, encoding: 'text', text: 'boom' },
      chunks: 1,
      streaming: false,
      clientGone: false,
    },
    event: null,
    logs: [
      {
        index: 0,
        at: AGO(60),
        offsetMs: 0.4,
        level: 'info',
        message: 'hello from api',
        kind: null,
        fields: null,
        afterFinish: false,
      },
      {
        index: 1,
        at: AGO(60),
        offsetMs: 7.8,
        level: 'error',
        message:
          'Error: boom\n    at handler (/work/shop/functions/index.js:42:11)\n    at /work/shop/functions/node_modules/firebase-functions/lib/v2/providers/https.js:65:41',
        kind: 'function.error',
        fields: null,
        afterFinish: false,
      },
    ],
    logsDropped: 0,
    timings: { workerStartMs: 812, firstByteMs: 819.9, totalMs: 820.1 },
    replayable: true,
    notReplayable: null,
    liveCursor: '2.4',
  },
  refs: [
    { kind: 'functions.function', key: 'us-central1-api' },
    { kind: 'auth.user', key: '|u_ada', label: 'ada@example.test' },
  ],
}

function Detail() {
  const actions = useInvocationActions({ onOpen: () => undefined })
  return (
    <div className="relative flex h-[720px] justify-end overflow-hidden rounded-lg bg-kumo-base ring ring-kumo-line">
      <InvocationDetail
        project={PROJECT}
        id="a3f9c1-1288"
        widthKey="functions.invocation"
        actions={actions}
        onClose={() => undefined}
      />
    </div>
  )
}

function InvocationDetailCard() {
  return (
    <Kit
      fill={(client) =>
        client.setQueryData(functionKeys.invocation(PROJECT, 'a3f9c1-1288'), FAILED)
      }
    >
      <Stack>
        <Section
          title="A failed invocation"
          note="How it ended and the summary, the function, origin and time, the timing bar with the cold start, the handler's own error with its project frame linked to the editor, what caused it (a link once its section is built), then the request, response and its own logs."
        >
          <Detail />
        </Section>
      </Stack>
    </Kit>
  )
}

// ── The Run tab of an HTTP function ──────────────────────────────────────

const API: FunctionSummary = {
  id: 'us-central1-api',
  name: 'api',
  entryPoint: 'api',
  region: 'us-central1',
  platform: 'gcfv2',
  codebase: 'app',
  extensionInstance: null,
  extension: null,
  kind: 'http',
  trigger: {
    eventType: null,
    resource: null,
    database: null,
    document: null,
    matchType: null,
    bucket: null,
    topic: null,
    channel: null,
    filters: {},
    pathPatterns: {},
    schedule: null,
    timeZone: null,
    blockingEvent: null,
    invoker: [],
    retry: null,
  },
  status: 'receiving',
  statusReason: null,
  service: null,
  url: `http://127.0.0.1:5001/${PROJECT}/us-central1/api`,
  timeoutSeconds: 60,
  secrets: [],
  stats: { runs: 12, failures: 1, inFlight: 0, last: null, p50Ms: 3.1, p95Ms: 18 },
}

const API_DETAIL: FunctionDetail = {
  summary: API,
  keys: [{ key: API.id, generation: null, enabled: true, stale: false }],
  environment: { files: ['.env'], variables: [], inherited: 12, editable: true },
  params: [],
  declared: [],
  schedule: null,
  taskQueue: null,
  blocking: null,
  definition: { name: API.name },
}

const DRAFT: InvokeDraft = {
  kind: 'request',
  method: 'POST',
  path: '/orders',
  query: [{ id: 'q-1', key: 'dryRun', value: 'true', enabled: true }],
  headers: [{ id: 'h-1', key: 'x-request-id', value: 'r_19', enabled: true }],
  body: { kind: 'json', text: '{\n  "cart": "c_19",\n  "items": 2\n}' },
  identity: { kind: 'custom', uid: 'tester', claims: { admin: true } },
  appCheck: { kind: 'app', appId: '1:123:web:abc' },
}

const ANSWERED: ResponseRecord = {
  status: 200,
  statusText: 'OK',
  headers: [
    ['content-type', 'application/json; charset=utf-8'],
    ['x-firenook-execution', 'a3f9c1-1291'],
    ['content-length', '52'],
  ],
  bodyText: '{"order":"o_123","total":42.5,"servedBy":"us-central1-api"}',
  contentType: 'application/json; charset=utf-8',
  firstByteMs: 7.9,
  durationMs: 8.1,
  sizeBytes: 52,
  at: AGO(20),
}

const STREAMING: ResponseRecord = {
  status: 200,
  statusText: 'OK',
  headers: [['content-type', 'text/plain; charset=utf-8']],
  contentType: 'text/plain; charset=utf-8',
  firstByteMs: 12,
  durationMs: 820,
  sizeBytes: 24,
  at: AGO(2),
  receiving: true,
  chunks: [
    { atMs: 12, text: 'chunk 1\n' },
    { atMs: 412, text: 'chunk 2\n' },
    { atMs: 820, text: 'chunk 3\n' },
  ],
}

const answerLine = (index: number, offsetMs: number, message: string): FunctionLogLine => ({
  index,
  at: AGO(20),
  offsetMs,
  level: 'info',
  message,
  kind: null,
  fields: null,
  afterFinish: false,
})

function answerView(
  summary: InvocationSummary,
  response: ResponseRecord,
  logs: FunctionLogLine[],
): InvocationView {
  return {
    detail: {
      summary,
      request: {
        target: 'url',
        method: 'POST',
        path: '/orders',
        headers: [],
        contentType: 'application/json',
        body: { size: 32, truncated: false, encoding: 'text', text: '{"cart":"c_19","items":2}' },
      },
      response: {
        status: response.status,
        headers: [],
        contentType: response.contentType ?? null,
        body: {
          size: response.sizeBytes,
          truncated: false,
          encoding: 'text',
          text: response.bodyText ?? '',
        },
        chunks: response.chunks?.length ?? 1,
        streaming: response.chunks !== undefined,
        clientGone: false,
      },
      event: null,
      logs,
      logsDropped: 0,
      timings: { workerStartMs: null, firstByteMs: response.firstByteMs ?? null, totalMs: null },
      replayable: true,
      notReplayable: null,
      liveCursor: '2.9',
    },
    refs: [{ kind: 'functions.function', key: API.id }],
  }
}

const ANSWERED_RUN = invocation(1291, {
  summary: 'POST /orders?dryRun=true',
  origin: 'console',
  durationMs: 8.1,
})

const STREAMING_RUN = invocation(1292, {
  summary: 'GET /stream',
  origin: 'console',
  outcome: null,
  outcomeClass: 'running',
  status: null,
  durationMs: null,
  startedAt: AGO(2),
})

function fillInvoke(client: QueryClient) {
  useRunDrafts.getState().set(draftKey(PROJECT, API.id, 'request'), DRAFT)
  client.setQueryData(
    functionKeys.invocation(PROJECT, ANSWERED_RUN.id),
    answerView(ANSWERED_RUN, ANSWERED, [answerLine(0, 0.4, 'order o_123 for cart c_19 (dry run)')]),
  )
  client.setQueryData(
    functionKeys.invocation(PROJECT, STREAMING_RUN.id),
    answerView(STREAMING_RUN, STREAMING, [
      answerLine(0, 12, 'stream started'),
      answerLine(1, 412, 'sent chunk 2'),
    ]),
  )
}

function Answer({
  run,
  response,
  pending,
}: {
  run: InvocationSummary
  response: ResponseRecord
  pending: boolean
}) {
  return (
    <div className="overflow-hidden rounded-lg bg-kumo-base ring ring-kumo-line">
      <RunAnswer
        project={PROJECT}
        invocation={run}
        finished={pending ? undefined : run}
        onOpen={() => undefined}
        outcome={false}
      >
        <ResponseView response={response} pending={pending} />
      </RunAnswer>
    </div>
  )
}

function InvokePanelCard() {
  return (
    <Kit fill={fillInvoke}>
      <Stack>
        <Section
          title="Invoke"
          note="The method and the path after the function's address (a pasted curl command fills it all), Call as and App Check, whose headers the list shows as set by them, the query, the headers, the body, then Send (⌘↵)."
        >
          <div className="flex h-[612px] flex-col overflow-hidden rounded-lg bg-kumo-base ring ring-kumo-line">
            <InvokeForm
              project={PROJECT}
              detail={API_DETAIL}
              url={API.url ?? ''}
              onPrefilled={() => undefined}
              onOpenInvocation={() => undefined}
            />
          </div>
        </Section>
        <Section
          title="The answer"
          note="The response as the function wrote it, the invocation it made (opens it) and only that invocation's own log lines; a streaming answer shows its chunks as they arrive."
        >
          <div className="grid gap-4">
            <Answer run={ANSWERED_RUN} response={ANSWERED} pending={false} />
            <Answer run={STREAMING_RUN} response={STREAMING} pending />
          </div>
        </Section>
      </Stack>
    </Kit>
  )
}

// ── A codebase ───────────────────────────────────────────────────────────

const WORKER: FunctionCodebase['worker'] = {
  state: 'running',
  pid: 48211,
  node: '24.20.0',
  startedAt: AGO(240),
  startMs: 640,
  restarts: 1,
  lastExit: 'exited with code 1',
  exitedAt: AGO(360),
  inspectPort: 9229,
  inFlight: 0,
}

function codebaseEntry(fields: Partial<FunctionCodebase>): FunctionCodebaseEntry {
  return {
    instance: null,
    codebase: {
      id: 'app',
      kind: 'user',
      directory: 'functions',
      runtime: 'nodejs22',
      state: 'ready',
      servingPrevious: false,
      error: null,
      loads: 3,
      loadedAt: AGO(120),
      loadMs: 412,
      loadingSince: null,
      functionCount: 12,
      notLoaded: [],
      envFiles: ['.env', '.env.demo-shop', '.secret.local'],
      lastChange: { added: ['us-central1-heartbeat'], removed: [], changed: ['us-central1-api'] },
      stale: null,
      worker: WORKER,
      ...fields,
    },
  }
}

const APP = codebaseEntry({
  notLoaded: [
    {
      id: 'us-central1-legacyDb',
      eventType: 'providers/google.firebase.database/eventTypes/ref.write',
      reason: 'Realtime Database triggers are not emulated.',
    },
  ],
  stale: { reason: 'envChanged', file: '.env.demo-shop', changedAt: AGO(30) },
})

const CODEBASE_SNAPSHOT: FunctionsSnapshot = {
  phase: 'running',
  projectId: PROJECT,
  address: 'http://127.0.0.1:5001',
  debugging: true,
  codebases: [APP],
  functions: [API],
  liveCursor: '2.9',
}

const loadLine = (
  index: number,
  message: string,
  level: FunctionLogLine['level'] = 'info',
): FunctionLogLine => ({
  index,
  at: AGO(130 - index),
  offsetMs: 0,
  level,
  message,
  kind: null,
  fields: null,
  afterFinish: false,
})

const LOAD_LINES: FunctionLogLine[] = [
  loadLine(0, 'Loaded environment variables from .env, .env.demo-shop, .secret.local.'),
  loadLine(1, 'compute fixture loaded'),
  loadLine(2, 'Using the deprecated functions.config() API; move to params.', 'warn'),
  loadLine(3, 'Loaded functions definitions from source: api, addMessage, heartbeat.'),
]

const TROUBLED = codebaseEntry({
  id: 'jobs',
  directory: 'jobs',
  state: 'failed',
  servingPrevious: true,
  error: {
    message: 'SyntaxError: Unexpected token (3:12) in ./jobs/lib/index.js',
    detail:
      './jobs/lib/index.js:3\n  exports.heartbeat = onSchedule(\n             ^\nSyntaxError: Unexpected token',
    at: AGO(45),
  },
  stale: { reason: 'sourcesNewer', changedAt: AGO(50) },
  worker: {
    ...WORKER,
    state: 'exited',
    pid: null,
    lastExit: 'exited with code 1',
    exitedAt: AGO(40),
  },
})

const WORKER_STATES: Array<FunctionCodebase['worker']['state']> = [
  'running',
  'starting',
  'stopped',
  'exited',
  'failed',
]

function fillCodebase(client: QueryClient) {
  client.setQueryData(functionKeys.codebaseLog(PROJECT, 'app'), {
    lines: LOAD_LINES,
    liveCursor: '2.9',
  } satisfies FunctionLoadLog)
}

function CodebaseViewCard() {
  return (
    <Kit fill={fillCodebase}>
      <Stack>
        <Section
          title="A codebase"
          note="The worker behind it, what the last load did and what it left out, the env files in precedence order (one changed since the load, so a strip says the old values still run), then everything printed outside an invocation, live."
        >
          <div className="flex h-[440px] flex-col overflow-hidden rounded-lg bg-kumo-base ring ring-kumo-line">
            <CodebaseView project={PROJECT} snapshot={CODEBASE_SNAPSHOT} entry={APP} />
          </div>
        </Section>
        <Section
          title="When something is wrong"
          note="One strip each, in this order, wherever the codebase is shown: a reload that failed while the previous load serves, a worker that exited on its own, TypeScript sources newer than their build."
        >
          <div className="overflow-hidden rounded-lg bg-kumo-base ring ring-kumo-line">
            <CodebaseBanners entry={TROUBLED} />
          </div>
        </Section>
        <Section
          title="The worker's states"
          note="A worker a reload stopped is the normal state between calls: no strip, and the next call starts it."
        >
          <div className="flex flex-wrap gap-x-6 gap-y-2 rounded-lg bg-kumo-base px-4 py-3 ring ring-kumo-line">
            {WORKER_STATES.map((state) => {
              const word = workerWord(
                codebaseEntry({ worker: { ...WORKER, state, lastExit: 'exited with code 1' } }),
              )
              return <StatusDot key={state} tone={word.tone} label={word.word} pulse={word.pulse} />
            })}
          </div>
        </Section>
      </Stack>
    </Kit>
  )
}

defineCards([
  {
    id: 'invocation-rows',
    group: 'Patterns',
    name: 'Invocation rows',
    subtitle:
      'Running, succeeded, cold, 500, a callable error, blocked, paused and a replay; the burst marker',
    width: 960,
    surface: 'canvas',
    render: () => <InvocationRowsCard />,
  },
  {
    id: 'invocation-rows-dark',
    group: 'Patterns',
    name: 'Invocation rows, dark',
    subtitle: 'The same, in dark mode',
    width: 960,
    dark: true,
    surface: 'canvas',
    render: () => <InvocationRowsCard />,
  },
  {
    id: 'invocation-detail',
    group: 'Patterns',
    name: 'Invocation detail',
    subtitle:
      'A failed invocation in the inspector: error with a linked frame, cause, timing, logs',
    width: 640,
    surface: 'canvas',
    render: () => <InvocationDetailCard />,
  },
  {
    id: 'invocation-detail-dark',
    group: 'Patterns',
    name: 'Invocation detail, dark',
    subtitle: 'The same, in dark mode',
    width: 640,
    dark: true,
    surface: 'canvas',
    render: () => <InvocationDetailCard />,
  },
  {
    id: 'invoke-panel',
    group: 'Patterns',
    name: 'Invoke panel',
    subtitle:
      'An HTTP function called as a custom identity with App Check, a 200 JSON answer and a streaming one',
    width: 640,
    surface: 'canvas',
    render: () => <InvokePanelCard />,
  },
  {
    id: 'invoke-panel-dark',
    group: 'Patterns',
    name: 'Invoke panel, dark',
    subtitle: 'The same, in dark mode',
    width: 640,
    dark: true,
    surface: 'canvas',
    render: () => <InvokePanelCard />,
  },
  {
    id: 'codebase-view',
    group: 'Patterns',
    name: 'Codebase view',
    subtitle:
      'The worker, the last load, the env files and the load log; the strips and the worker states',
    width: 1040,
    surface: 'canvas',
    render: () => <CodebaseViewCard />,
  },
  {
    id: 'codebase-view-dark',
    group: 'Patterns',
    name: 'Codebase view, dark',
    subtitle: 'The same, in dark mode',
    width: 1040,
    dark: true,
    surface: 'canvas',
    render: () => <CodebaseViewCard />,
  },
])
