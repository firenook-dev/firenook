// The Functions pages' patterns: invocation rows as the function page and
// Invocations draw them (every outcome, the cold mark, a replay, the burst
// marker), and one failed invocation in the inspector (its error with
// linked frames, the cause links, timing, the request with a masked header).

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
import type { InvocationSummary } from '@/api/generated/compute/InvocationSummary'
import type { InvocationView } from '@/api/generated/compute/InvocationView'
import { statusQuery } from '@/api/queries'
import { useInvocationActions } from '@/functions/components/invocation-actions'
import { InvocationDetail } from '@/functions/components/invocation-detail'
import { InvocationRow, InvocationsHeader } from '@/functions/components/invocation-row'
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

/** The console's providers around a card, with the cache filled as given. */
function Kit({ fill, children }: { fill?: (client: QueryClient) => void; children: ReactNode }) {
  const [client] = useState(() => {
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
])
