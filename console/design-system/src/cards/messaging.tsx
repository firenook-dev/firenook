// Pub/Sub and Cloud Tasks (the messaging sections). Pub/Sub: the Topics
// page's panel tree (a stalled subscription in the warning tone, a
// function's row), the filter line with a `q` token, an attributes
// expression and the count, message rows with their delivery marks, the
// composer, and every mark a row can carry. Cloud Tasks: a queue's row two
// with its state counts and token bucket, task rows in each state, the
// re-registration banner, one task's attempts with its retry plan and the
// emulator's off-by-one said where the figure is, and the Attempts feed
// held still. Every piece is the console's own component over answers
// shaped as the engine sends them.

import { Tabs, Text, TooltipProvider } from '@cloudflare/kumo'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from '@tanstack/react-router'
import { type ReactNode, createContext, use, useState } from 'react'
import type { ConsoleStatus } from '@/api/generated/ConsoleStatus'
import type { PubsubDeliverySummary } from '@/api/generated/messaging/PubsubDeliverySummary'
import type { PubsubFilterCheck } from '@/api/generated/messaging/PubsubFilterCheck'
import type { PubsubFunctionMark } from '@/api/generated/messaging/PubsubFunctionMark'
import type { PubsubMessageRow } from '@/api/generated/messaging/PubsubMessageRow'
import type { PubsubMessageState } from '@/api/generated/messaging/PubsubMessageState'
import type { TasksAttempt } from '@/api/generated/messaging/TasksAttempt'
import type { TasksAttemptEvent } from '@/api/generated/messaging/TasksAttemptEvent'
import type { TasksLadderStep } from '@/api/generated/messaging/TasksLadderStep'
import type { TasksQueue } from '@/api/generated/messaging/TasksQueue'
import type { TasksTaskRow } from '@/api/generated/messaging/TasksTaskRow'
import { statusQuery } from '@/api/queries'
import { useColumnWidths } from '@/components/console/column-widths'
import { DataTable } from '@/components/console/data-table'
import { useFeedPending } from '@/components/console/feed-list'
import { FilterField } from '@/components/console/filter-field'
import { storageKeyFor } from '@/components/console/inspector-width'
import { rowId } from '@/components/console/key-value-editor'
import { MatchCount } from '@/components/console/match-count'
import { PanelFilter, PanelHeader } from '@/components/console/panel'
import { PanelTree } from '@/components/console/panel-tree'
import { PauseButton } from '@/components/console/pause-button'
import { ScopeSelect } from '@/components/console/scope-select'
import { SectionBody } from '@/components/console/section-page'
import { TableFooter } from '@/components/console/table-footer'
import { SectionToolbar, ToolbarRow } from '@/components/console/toolbar'
import { AttributesFilterField } from '@/pubsub/components/attributes-filter-field'
import { Composer } from '@/pubsub/components/composer'
import { DeliveryMarks, MESSAGE_COLUMNS } from '@/pubsub/components/message-table'
import { type ComposerDraft, draftKey, useComposer } from '@/pubsub/composer-store'
import { MESSAGE_FILTER_PLACEHOLDER, messageFields } from '@/pubsub/filters'
import { filterCheckQuery } from '@/pubsub/queries'
import { functionMark, subscriptionMark } from '@/pubsub/states'
import {
  PROJECT as PUBSUB_PROJECT,
  subscriptionSummary,
  topicIndex,
  topicSummary,
} from '@/pubsub/test/index-fixture'
import { topicTree } from '@/pubsub/tree'
import { AttemptsView } from '@/tasks/components/attempts-feed'
import { SlotsAndTokens, SwitchLabel, TabLabel } from '@/tasks/components/queue-view'
import { ReplacedBanner } from '@/tasks/components/replaced-banner'
import { TaskInspector } from '@/tasks/components/task-inspector'
import type { TaskActions } from '@/tasks/components/task-actions'
import { taskColumns } from '@/tasks/components/task-table'
import { attemptKey } from '@/tasks/live'
import { taskQuery } from '@/tasks/queries'
import {
  PROJECT as TASKS_PROJECT,
  testAttempt,
  testCounters,
  testDetail,
  testQueue,
  testRow,
} from '@/tasks/test-data'
import { sectionEntry, testStatus } from '@/test/status'
import { useNow } from '@/lib/clock'
import { createFeedStore } from '@/lib/live/feed-store'
import { defineCards } from '../registry'
import { Section, Stack } from './shared'

const noop = () => {}

/** An instant `seconds` before (or, negative, after) the card loads. */
const AGO = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString()

// The inspectors as a person who dragged them would have left them.
for (const key of ['pubsub.message', 'tasks.task']) {
  try {
    localStorage.setItem(storageKeyFor(key), '440')
  } catch {
    // A preview without storage shows the default width.
  }
}
// The message table beside the panel, narrowed the same way, so every
// column through Delivered shows in the card's width.
useColumnWidths.getState().set('ds.pubsub.messages', 'data', 240)
useColumnWidths.getState().set('ds.pubsub.messages', 'attributes', 180)

// ── Providers ─────────────────────────────────────────────────────────────

const CardContent = createContext<ReactNode>(null)

function CardRoot() {
  return <>{use(CardContent)}</>
}

/** The console's providers around a card, with the cache filled as given: nothing is fetched. */
function Kit({
  status,
  fill,
  children,
}: {
  status: ConsoleStatus
  fill?: (client: QueryClient) => void
  children: ReactNode
}) {
  const [client] = useState(() => {
    const created = new QueryClient({
      defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY, retry: false } },
    })
    created.setQueryData(statusQuery.queryKey, status)
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

/** A piece of a page at its real size: a bordered box, of a fixed height when given. */
function Frame({
  height,
  width,
  children,
}: {
  height?: number
  width?: number
  children: ReactNode
}) {
  return (
    <div
      className="relative flex min-w-0 flex-col overflow-hidden rounded-lg bg-kumo-base ring ring-kumo-line"
      style={{ height, width }}
    >
      {children}
    </div>
  )
}

/** A sample with what it shows named above it. */
function Sample({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 content-start gap-2">
      <Text variant="secondary" size="sm">
        {label}
      </Text>
      {children}
    </div>
  )
}

// ── Pub/Sub ───────────────────────────────────────────────────────────────

const PUBSUB_STATUS = testStatus({
  projectId: PUBSUB_PROJECT,
  services: [
    { name: 'pubsub', host: '127.0.0.1', port: 8085, listening: true, pid: null },
    { name: 'functions', host: '127.0.0.1', port: 5001, listening: true, pid: null },
  ],
  sections: ['pubsub', 'functions'].map((id) => sectionEntry(id)),
})

const topicName = (id: string) => `projects/${PUBSUB_PROJECT}/topics/${id}`
const subscriptionName = (id: string) => `projects/${PUBSUB_PROJECT}/subscriptions/${id}`
const ON_ORDER_PLACED = 'us-central1-onOrderPlaced'

const ORDERS = topicSummary('orders', {
  counters: { published: 40, lastPublishedAt: AGO(8), latestMessageId: '40' },
  subscriptions: [
    // Nobody connected, and the oldest message has waited six minutes: stalled.
    subscriptionSummary('orders-worker', 'orders', {
      ordering: true,
      deadLetterTopic: topicName('orders-dead'),
      counters: { backlog: 12, available: 12, oldestUnackedAt: AGO(360) },
    }),
    subscriptionSummary('orders-audit', 'orders', {
      counters: {
        backlog: 1,
        available: 1,
        oldestUnackedAt: AGO(2),
        consumers: { streaming: 1, waitingPulls: 0, lastPullAt: AGO(2) },
      },
    }),
    subscriptionSummary('emulator-sub-orders', 'orders', { managed: 'functions' }),
  ],
  functions: [
    {
      functionId: ON_ORDER_PLACED,
      name: 'onOrderPlaced',
      region: 'us-central1',
      kind: 'cloudevent',
      entity: { kind: 'functions.function', key: ON_ORDER_PLACED, label: 'onOrderPlaced' },
    },
  ],
})

const INDEX = topicIndex(
  [
    topicSummary('audit-log', { counters: { published: 112 } }),
    ORDERS,
    topicSummary('orders-dead', { counters: { published: 2 } }),
    topicSummary('payments', {
      counters: { published: 5 },
      subscriptions: [
        subscriptionSummary('payments-worker', 'payments', {
          exactlyOnce: true,
          counters: {
            backlog: 3,
            available: 3,
            oldestUnackedAt: AGO(4),
            consumers: { streaming: 0, waitingPulls: 1, lastPullAt: AGO(1) },
          },
        }),
      ],
    }),
  ],
  { otherProjects: [{ project: 'demo-elsewhere', topics: 1, subscriptions: 0 }] },
)

const ORDERS_NAME = topicName('orders')
const Q = 'key:cust-1'
const EXPR = 'attributes.region = "eu"'

const FILTER_CHECK: PubsubFilterCheck = {
  ok: true,
  message: null,
  position: null,
  engineMessage: null,
  checked: 40,
  matched: 21,
  sampleIds: ['40', '37', '31'],
}

function delivered(
  worker: PubsubMessageState,
  audit: PubsubMessageState,
  fn: PubsubFunctionMark,
): PubsubDeliverySummary {
  return {
    subscriptions: [
      { subscription: subscriptionName('orders-worker'), state: worker },
      { subscription: subscriptionName('orders-audit'), state: audit },
    ],
    more: 0,
    functions: [{ functionId: ON_ORDER_PLACED, mark: fn }],
  }
}

function message(
  id: string,
  seconds: number,
  data: string,
  deliveries: PubsubDeliverySummary,
): PubsubMessageRow {
  return {
    id,
    publishTime: AGO(seconds),
    size: data.length + 26,
    data: { encoding: 'json', text: data, truncated: false },
    attributes: { region: 'eu', channel: id === '37' ? 'app' : 'web' },
    orderingKey: 'cust-1',
    deliveries,
  }
}

const MESSAGES: PubsubMessageRow[] = [
  message(
    '40',
    8,
    '{"orderId":"o_1040","total":42.5,"items":2}',
    delivered('available', 'outstanding', 'running'),
  ),
  message(
    '37',
    95,
    '{"orderId":"o_1037","total":18,"items":1}',
    delivered('available', 'acked', 'delivered'),
  ),
  message(
    '31',
    260,
    '{"orderId":"o_1031","total":-5,"items":0}',
    delivered('dead-lettered', 'acked', 'failed'),
  ),
]

const MESSAGE_NOUN = { one: 'message', other: 'messages' }

function TopicsSample() {
  const [filter, setFilter] = useState('')
  const [q, setQ] = useState(Q)
  const [expr, setExpr] = useState(EXPR)
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set([ORDERS_NAME]))
  // Figures turn amber as a backlog ages, so the tree reads the minute clock, as the panel does.
  const now = useNow('minute')
  const tree = topicTree(INDEX, { current: ORDERS_NAME, configured: PUBSUB_PROJECT, now })
  const fields = messageFields({
    attributeKeys: ['region', 'channel'],
    orderingKeys: ['cust-1', 'cust-2', 'cust-3'],
  })
  return (
    <Frame height={330}>
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-[248px] shrink-0 flex-col border-r border-kumo-line">
          <PanelHeader
            filter={
              <PanelFilter
                value={filter}
                onChange={setFilter}
                placeholder="Filter topics and subscriptions"
              />
            }
          >
            <ScopeSelect
              label="Project"
              value={PUBSUB_PROJECT}
              items={[
                { value: PUBSUB_PROJECT, label: PUBSUB_PROJECT, detail: '4 topics' },
                { value: 'demo-elsewhere', label: 'demo-elsewhere', detail: '1 topic' },
              ]}
              onChange={noop}
              ariaLabel="Project"
              className="flex-1"
            />
          </PanelHeader>
          <PanelTree
            nodes={tree.nodes}
            current={ORDERS_NAME}
            expanded={open}
            onToggle={(id, next) =>
              setOpen((shown) => {
                const changed = new Set(shown)
                if (next) changed.add(id)
                else changed.delete(id)
                return changed
              })
            }
            onOpen={noop}
            filter={filter}
            ariaLabel="Topics"
          />
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <SectionToolbar>
            <ToolbarRow variant="line">
              <FilterField
                value={q}
                onChange={setQ}
                fields={fields}
                placeholder={MESSAGE_FILTER_PLACEHOLDER}
                ariaLabel="Filter messages"
              />
              <AttributesFilterField
                value={expr}
                onChange={setExpr}
                project={PUBSUB_PROJECT}
                topic={ORDERS_NAME}
                collapsible
              />
              <MatchCount
                total={{ count: 21, exact: true }}
                noun={MESSAGE_NOUN}
                widest="0,000,000"
                detail="of 40 kept"
              />
            </ToolbarRow>
          </SectionToolbar>
          <SectionBody>
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              <DataTable<PubsubMessageRow>
                ariaLabel="Messages of orders"
                rows={MESSAGES}
                rowKey={(row) => row.id}
                columns={MESSAGE_COLUMNS}
                memoryKey="ds.pubsub.messages"
                onOpen={noop}
                selection={{ checked: new Set(), everything: false, onChange: noop }}
                rowClick="open"
                hasMore={false}
                total={{ count: 21, exact: true }}
                anchor="key"
                empty={<p />}
                footer={
                  <TableFooter
                    loaded={3}
                    total={{ count: 3, exact: true }}
                    hasMore={false}
                    noun={MESSAGE_NOUN}
                  />
                }
              />
            </div>
          </SectionBody>
        </div>
      </div>
    </Frame>
  )
}

const DRAFT: ComposerDraft = {
  kind: 'json',
  data: '{\n  "orderId": "o_1041",\n  "total": 42.5,\n  "items": 2\n}',
  attributes: [
    { id: rowId(), key: 'region', value: 'eu', enabled: true },
    { id: rowId(), key: 'channel', value: 'web', enabled: true },
    { id: rowId(), key: 'googTrace', value: 'a3f9c1', enabled: true },
  ],
  orderingKey: 'cust-1',
  repeat: '1',
  intervalMs: 0,
}

function ComposerSample() {
  // The draft is the composer's own state: put it where the composer keeps it.
  useState(() => useComposer.getState().set(draftKey(PUBSUB_PROJECT, ORDERS_NAME), DRAFT))
  return (
    <Frame height={600} width={440}>
      <Composer
        project={PUBSUB_PROJECT}
        topic={ORDERS_NAME}
        detail={undefined}
        summary={ORDERS}
        prefill={undefined}
        onClose={noop}
        onOpenMessage={noop}
      />
    </Frame>
  )
}

const SUBSCRIPTION_STATES: Array<{ state: PubsubMessageState; note: string }> = [
  { state: 'available', note: 'waiting for the next pull or push' },
  { state: 'outstanding', note: 'leased; its deadline is running' },
  { state: 'acked', note: 'done' },
  { state: 'dead-lettered', note: 'forwarded to the dead-letter topic' },
  { state: 'filtered', note: "the subscription's filter left it out" },
  { state: 'not-tracked', note: 'an empty place: the subscription came later' },
]

const FUNCTION_MARKS: Array<{ mark: PubsubFunctionMark; note: string }> = [
  { mark: 'queued', note: 'waiting for a free slot' },
  { mark: 'running', note: 'the handler has it' },
  { mark: 'delivered', note: 'the handler returned' },
  { mark: 'failed', note: 'the handler threw; the row says what it logged' },
  { mark: 'skipped', note: 'background triggers were paused' },
  { mark: 'not-kept', note: 'older than the invocations compute keeps' },
]

function MarkRow({ marks, word, note }: { marks: ReactNode; word: string; note: string }) {
  return (
    <div className="grid grid-cols-[48px_280px_minmax(0,1fr)] items-center gap-3 border-b border-kumo-hairline py-1.5 last:border-b-0">
      <span className="flex items-center">{marks}</span>
      <span className="truncate text-[13px] text-kumo-default">{word}</span>
      <Text variant="secondary" size="sm">
        {note}
      </Text>
    </div>
  )
}

function MarksLegend() {
  return (
    <div className="grid rounded-lg bg-kumo-base px-4 py-1 ring ring-kumo-line">
      {SUBSCRIPTION_STATES.map(({ state, note }) => (
        <MarkRow
          key={state}
          marks={
            <DeliveryMarks
              deliveries={{
                subscriptions: [{ subscription: subscriptionName('orders-worker'), state }],
                more: 0,
                functions: [],
              }}
            />
          }
          word={subscriptionMark(state).word}
          note={note}
        />
      ))}
      {FUNCTION_MARKS.map(({ mark, note }) => (
        <MarkRow
          key={mark}
          marks={
            <DeliveryMarks
              deliveries={{
                subscriptions: [],
                more: 0,
                functions: [{ functionId: ON_ORDER_PLACED, mark }],
              }}
            />
          }
          word={`function ${functionMark(mark).word}`}
          note={note}
        />
      ))}
    </div>
  )
}

function PubsubCard() {
  return (
    <Kit
      status={PUBSUB_STATUS}
      fill={(client) => {
        client.setQueryData(
          filterCheckQuery(PUBSUB_PROJECT, EXPR, ORDERS_NAME).queryKey,
          FILTER_CHECK,
        )
      }}
    >
      <Stack>
        <Section
          title="A topic and its messages"
          note="The tree counts each backlog once and turns amber on a subscription nobody reads; the filter line takes the shared grammar and a subscription's own filter expression, checked by the engine as it is typed; each row marks what became of the message at every subscription, then at every function."
        >
          <TopicsSample />
        </Section>
        <div className="grid grid-cols-[440px_minmax(0,1fr)] items-start gap-8">
          <Section
            title="The composer"
            note="Data checked as it is typed, attributes, an ordering key, copies; what production would refuse is said in amber."
          >
            <ComposerSample />
          </Section>
          <Section
            title="Delivery marks"
            note="A 7 px circle per subscription, a lightning and a glyph per function; the tooltip says them in words."
          >
            <MarksLegend />
          </Section>
        </div>
      </Stack>
    </Kit>
  )
}

// ── Cloud Tasks ───────────────────────────────────────────────────────────

const TASKS_STATUS = testStatus({
  projectId: TASKS_PROJECT,
  services: [
    { name: 'tasks', host: '127.0.0.1', port: 9499, listening: true, pid: null },
    { name: 'functions', host: '127.0.0.1', port: 5001, listening: true, pid: null },
  ],
  sections: ['tasks', 'functions'].map((id) => sectionEntry(id)),
})

/** maxAttempts 12 with 1 to 4 s of backoff: 13 runs, the last 43 s after the first. */
const MAX_ATTEMPTS = 12
const LADDER: TasksLadderStep[] = Array.from({ length: MAX_ATTEMPTS + 1 }, (_, index) => {
  const attempt = index + 1
  const backoffSeconds = attempt === 1 ? 0 : Math.min(4, 2 ** (attempt - 2))
  return { attempt, backoffSeconds, afterSeconds: 0, last: attempt === MAX_ATTEMPTS + 1 }
})
for (let index = 1; index < LADDER.length; index += 1) {
  const step = LADDER[index]
  const before = LADDER[index - 1]
  if (step && before) step.afterSeconds = before.afterSeconds + step.backoffSeconds
}

const BASE = testQueue('sendEmail')
const QUEUE: TasksQueue = testQueue('sendEmail', {
  registrations: 2,
  lastReplaced: { at: AGO(40), dropped: 3 },
  config: {
    ...BASE.config,
    maxAttempts: MAX_ATTEMPTS,
    values: BASE.config.values.map((value) =>
      value.key === 'retryConfig.maxAttempts' ? { ...value, value: String(MAX_ATTEMPTS) } : value,
    ),
    document: `{"retryConfig":{"maxAttempts":${MAX_ATTEMPTS},"minBackoffSeconds":1,"maxBackoffSeconds":4}}`,
    ladder: LADDER,
  },
  counters: testCounters({
    key: BASE.key,
    pending: 9,
    held: 1,
    running: 1,
    backoff: 1,
    slotsInUse: 2,
    tokens: 3.2,
    refilledAt: AGO(0),
    oldestPendingAt: AGO(30),
    history: 46,
    outcomes: { succeeded: 41, failed: 2, cancelled: 0, deleted: 0, purged: 0, replaced: 3 },
  }),
})

const taskName = (short: string) =>
  `projects/${TASKS_PROJECT}/locations/us-central1/queues/sendEmail/tasks/${short}`

const body = (text: string) => ({
  json: true,
  text,
  truncated: false,
  dataMember: true,
  size: text.length + 10,
})

const BACKOFF_ROW: TasksTaskRow = testRow({
  key: '0.51',
  id: '51',
  name: taskName('welcome-ada'),
  shortName: 'welcome-ada',
  state: 'backoff',
  position: null,
  enqueuedAt: AGO(37),
  attempt: 11,
  maxRuns: MAX_ATTEMPTS + 1,
  executionCount: 0,
  previousResponse: 503,
  lastAttemptAt: AGO(1),
  nextAttemptAt: AGO(-3),
  body: body('{"to":"ada@example.com","template":"welcome"}'),
})

const TASK_ROWS: TasksTaskRow[] = [
  testRow({
    key: '0.58',
    id: '58',
    name: taskName('receipt-o_1040'),
    shortName: 'receipt-o_1040',
    state: 'running',
    position: null,
    enqueuedAt: AGO(3),
    attempt: 1,
    maxRuns: MAX_ATTEMPTS + 1,
    lastAttemptAt: AGO(1),
    body: body('{"to":"cust-1@example.com","template":"receipt","orderId":"o_1040"}'),
  }),
  BACKOFF_ROW,
  testRow({
    key: '1.61',
    id: '61',
    name: `/${taskName('4471209836551288812')}`,
    shortName: '4471209836551288812',
    generated: true,
    state: 'pending',
    position: 1,
    enqueuedAt: AGO(150),
    maxRuns: MAX_ATTEMPTS + 1,
    body: body('{"to":"cust-3@example.com","template":"shipped"}'),
  }),
  testRow({
    key: '1.64',
    id: '64',
    name: taskName('digest-weekly'),
    shortName: 'digest-weekly',
    state: 'held',
    position: null,
    enqueuedAt: AGO(420),
    origin: 'wire',
    scheduleTime: AGO(-3540),
    dueAt: AGO(-3540),
    maxRuns: MAX_ATTEMPTS + 1,
    body: body('{"to":"team@example.com","template":"digest"}'),
  }),
]

const TASK_NOUN = { one: 'task', other: 'tasks' }

/** One attempt the engine kept: `seconds` before the card, answering `status`. */
function keptAttempt(number: number, seconds: number, fields: Partial<TasksAttempt> = {}) {
  return testAttempt({
    attempt: number,
    retryCount: number - 1,
    startedAt: AGO(seconds),
    durationMs: 40 + number,
    status: 503,
    response: null,
    ...fields,
  })
}

// Eleven attempts made, a second, two, then four apart (the queue's backoff):
// the first and the nine latest are kept, the second is not.
const ATTEMPTS: TasksAttempt[] = [
  keptAttempt(1, 36, {
    status: 500,
    response: '{"error":{"message":"mail relay refused the sender","status":"INTERNAL"}}',
  }),
  ...[3, 4, 5, 6, 7, 8, 9, 10].map((number) => keptAttempt(number, 1 + (11 - number) * 4)),
  keptAttempt(11, 1, { response: 'Service Unavailable' }),
]

const DETAIL = testDetail({
  task: BACKOFF_ROW,
  headers: [{ name: 'Content-Type', value: 'application/json' }],
  body: '{"data":{"to":"ada@example.com","template":"welcome"}}',
  data: '{"to":"ada@example.com","template":"welcome"}',
  attempts: ATTEMPTS,
  omittedAttempts: 1,
  retryPlan: [
    { attempt: 12, earliestAt: AGO(-3), backoffSeconds: 0, last: false },
    { attempt: 13, earliestAt: AGO(-7), backoffSeconds: 4, last: true },
  ],
  stops: `Gives up after attempt ${MAX_ATTEMPTS + 1} (maxAttempts ${MAX_ATTEMPTS} + 1, as the official emulator runs it).`,
})

const ACTIONS: TaskActions = {
  run: noop,
  stop: noop,
  remove: noop,
  again: noop,
  edit: noop,
  open: noop,
  confirm: noop,
  element: null,
}

function QueueRowTwo({ view, end }: { view: string; end: ReactNode }) {
  const { counters } = QUEUE
  return (
    <SectionToolbar>
      <ToolbarRow variant="line">
        <Tabs
          variant="underline"
          size="sm"
          value={view}
          tabs={[
            { value: 'tasks', label: <TabLabel label="Tasks" count={12} /> },
            { value: 'attempts', label: <TabLabel label="Attempts" /> },
            { value: 'history', label: <TabLabel label="History" count={counters.history} /> },
            { value: 'config', label: <TabLabel label="Configuration" /> },
          ]}
        />
        <span className="ml-auto flex shrink-0 items-center gap-3">{end}</span>
      </ToolbarRow>
    </SectionToolbar>
  )
}

function TasksSample() {
  const { counters } = QUEUE
  return (
    <Frame height={290}>
      <QueueRowTwo
        view="tasks"
        end={
          <>
            <Tabs
              variant="segmented"
              size="sm"
              value="all"
              tabs={[
                { value: 'all', label: <SwitchLabel label="All" count={12} wide /> },
                {
                  value: 'pending',
                  label: <SwitchLabel label="Pending" count={counters.pending} wide />,
                },
                { value: 'held', label: <SwitchLabel label="Held" count={counters.held} wide /> },
                {
                  value: 'running',
                  label: <SwitchLabel label="Running" count={counters.running} wide />,
                },
                {
                  value: 'backoff',
                  label: <SwitchLabel label="Backoff" count={counters.backoff} wide />,
                },
              ]}
            />
            <SlotsAndTokens queue={QUEUE} />
          </>
        }
      />
      <ReplacedBanner queue={QUEUE} onShowHistory={noop} />
      <SectionBody>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <DataTable<TasksTaskRow>
            ariaLabel="Tasks of sendEmail"
            rows={TASK_ROWS}
            rowKey={(row) => row.key}
            columns={taskColumns(TASK_ROWS)}
            memoryKey="ds.tasks.tasks"
            onOpen={noop}
            selection={{ checked: new Set(), everything: false, onChange: noop }}
            rowClick="open"
            hasMore={false}
            total={{ count: 12, exact: true }}
            empty={<p />}
            footer={
              <TableFooter loaded={4} total={{ count: 12, exact: true }} hasMore noun={TASK_NOUN} />
            }
          />
        </div>
      </SectionBody>
    </Frame>
  )
}

function InspectorSample() {
  return (
    <Frame height={1084} width={440}>
      <TaskInspector
        queue={QUEUE}
        project={TASKS_PROJECT}
        taskId={BACKOFF_ROW.id}
        tab="attempts"
        onTab={noop}
        onClose={noop}
        actions={ACTIONS}
      />
    </Frame>
  )
}

/** One attempt as the feed carries it: welcome-ada's 503s, other tasks' 204s. */
function feedEvent(
  task: { id: string; name: string },
  number: number,
  seconds: number,
): TasksAttemptEvent {
  const failing = task.id === BACKOFF_ROW.id
  return {
    queue: QUEUE.key,
    taskId: task.id,
    taskName: taskName(task.name),
    attempt: testAttempt({
      attempt: number,
      retryCount: number - 1,
      startedAt: AGO(seconds),
      durationMs: failing ? 40 + number : 118,
      status: failing ? 503 : 204,
      response: failing ? 'Service Unavailable' : null,
      countedExecution: !failing,
    }),
  }
}

const ADA = { id: BACKOFF_ROW.id, name: 'welcome-ada' }
const receipt = (id: number) => ({ id: String(id), name: `receipt-o_${1000 + id}` })

function FeedSample() {
  // A frozen store, so the card draws what the reader holds and counts the
  // rest; the page's store buffers above the reader's place instead, and
  // its button counts the same.
  const [store] = useState(() => {
    const created = createFeedStore<TasksAttemptEvent>({
      max: 2_000,
      key: attemptKey,
      pausedMode: 'freeze',
    })
    created.push([
      feedEvent(receipt(37), 1, 30),
      feedEvent(ADA, 5, 25),
      feedEvent(ADA, 6, 21),
      feedEvent(receipt(38), 1, 19),
      feedEvent(ADA, 7, 17),
      feedEvent(ADA, 8, 13),
    ])
    created.pause()
    created.push([
      feedEvent(ADA, 9, 9),
      ...[39, 40, 41, 42, 43, 44, 45, 46, 47].map((id, index) =>
        feedEvent(receipt(id), 1, 8 - index * 0.7),
      ),
      feedEvent(ADA, 10, 5),
      feedEvent(ADA, 11, 1),
    ])
    return created
  })
  const pending = useFeedPending(store, true, attemptKey)
  return (
    <Frame height={300}>
      <QueueRowTwo view="attempts" end={<PauseButton paused pending={pending} onChange={noop} />} />
      <AttemptsView
        queue={QUEUE}
        store={store}
        paused
        onPaused={noop}
        onOpen={noop}
        banners={null}
        inspector={() => null}
        taskId={undefined}
      />
    </Frame>
  )
}

function HistorySample() {
  const { counters } = QUEUE
  const outcomes = counters.outcomes
  return (
    <Frame>
      <QueueRowTwo
        view="history"
        end={
          <Tabs
            variant="segmented"
            size="sm"
            value="all"
            tabs={[
              { value: 'all', label: <SwitchLabel label="All" count={counters.history} wide /> },
              {
                value: 'succeeded',
                label: <SwitchLabel label="Succeeded" count={outcomes.succeeded} wide />,
              },
              {
                value: 'failed',
                label: <SwitchLabel label="Failed" count={outcomes.failed} wide />,
              },
              {
                value: 'replaced',
                label: <SwitchLabel label="Replaced" count={outcomes.replaced} wide />,
              },
            ]}
          />
        }
      />
    </Frame>
  )
}

function TasksCard() {
  return (
    <Kit
      status={TASKS_STATUS}
      fill={(client) => {
        client.setQueryData(taskQuery(TASKS_PROJECT, QUEUE.key, BACKOFF_ROW.id).queryKey, DETAIL)
      }}
    >
      <Stack>
        <Section
          title="A queue's tasks"
          note="Row two counts by state and shows the slots and the token bucket refilling; a re-registration says what it dropped; each row says where its task is, the attempt it is on out of the runs the emulator allows, and what the handler last answered."
        >
          <TasksSample />
        </Section>
        <div className="grid grid-cols-[440px_minmax(0,1fr)] items-start gap-8">
          <Section
            title="One task's attempts"
            note="Where it is and the retry plan, with the off-by-one said in a sentence; the first attempt and the nine latest, the ones between counted."
          >
            <InspectorSample />
          </Section>
          <div className="grid gap-8">
            <Sample label="The Attempts feed, held still: what arrives is counted on the button">
              <FeedSample />
            </Sample>
            <Sample label="History's row two: counts by outcome, the engine's own">
              <HistorySample />
            </Sample>
          </div>
        </div>
      </Stack>
    </Kit>
  )
}

defineCards([
  {
    id: 'messaging-pubsub',
    group: 'Patterns',
    name: 'Pub/Sub',
    subtitle: 'Topic tree, message rows with delivery marks, composer',
    width: 1200,
    surface: 'canvas',
    render: () => <PubsubCard />,
  },
  {
    id: 'messaging-pubsub-dark',
    group: 'Patterns',
    name: 'Pub/Sub, dark',
    subtitle: 'The same, in dark mode',
    width: 1200,
    dark: true,
    surface: 'canvas',
    render: () => <PubsubCard />,
  },
  {
    id: 'messaging-tasks',
    group: 'Patterns',
    name: 'Cloud Tasks',
    subtitle: 'Queue counters, task states, attempts timeline',
    width: 1200,
    surface: 'canvas',
    render: () => <TasksCard />,
  },
  {
    id: 'messaging-tasks-dark',
    group: 'Patterns',
    name: 'Cloud Tasks, dark',
    subtitle: 'The same, in dark mode',
    width: 1200,
    dark: true,
    surface: 'canvas',
    render: () => <TasksCard />,
  },
])
