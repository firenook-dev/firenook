// Eventarc's own pieces: an event's delivery trace (one handler ran it,
// one filtered it out; an unheard type with the type it meant), the event
// rows a list draws, and a channel as who publishes what to whom with what
// does not line up — on the console's providers, so the real components
// draw them.

import { TooltipProvider } from '@cloudflare/kumo'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from '@tanstack/react-router'
import { type ReactNode, createContext, use, useState } from 'react'
import type { EventarcChannel } from '@/api/generated/compute/EventarcChannel'
import type { EventarcEventSummary } from '@/api/generated/compute/EventarcEventSummary'
import { statusQuery } from '@/api/queries'
import { EventCells, EventHeader } from '@/compute/event-row'
import { ChannelFlow } from '@/eventarc/components/channel-flow'
import { DeliveryList } from '@/eventarc/components/delivery-list'
import { channelWarnings } from '@/eventarc/topology'
import { sectionEntry, testStatus } from '@/test/status'
import { defineCards } from '../registry'
import { Section, Stack } from './shared'

const CardContent = createContext<ReactNode>(null)

function CardRoot() {
  return <>{use(CardContent)}</>
}

/** The console's providers around a card: a status in the query client, a router, tooltips. */
function Kit({ children }: { children: ReactNode }) {
  const [client] = useState(() => {
    const created = new QueryClient({
      defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY, retry: false } },
    })
    created.setQueryData(
      statusQuery.queryKey,
      testStatus({
        projectId: 'demo-shop',
        sections: ['functions', 'extensions', 'eventarc'].map((id) => sectionEntry(id)),
      }),
    )
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

const NAME = 'projects/demo-shop/locations/us-central1/channels/firebase'

function Box({ children }: { children: ReactNode }) {
  return <div className="rounded-lg bg-kumo-base px-5 py-3 ring ring-kumo-line">{children}</div>
}

function DeliveryTraceCard() {
  return (
    <Kit>
      <Stack>
        <Section
          title="Delivered and filtered out"
          note="Each trigger listening for the type on the channel: the one that ran it with how it ended, how long it took and its invocation; the one whose filter kept it out, attribute by attribute."
        >
          <Box>
            <DeliveryList
              deliveries={[
                {
                  triggerKey: `us-central1-onGreeted-0-${NAME}`,
                  functionId: 'us-central1-onGreeted',
                  matched: true,
                  mismatches: [],
                  invocationId: 'a3f9c1-1330',
                  outcome: 'succeeded',
                  durationMs: 4.2,
                },
                {
                  triggerKey: `us-central1-onGreetedVip-0-${NAME}`,
                  functionId: 'us-central1-onGreetedVip',
                  matched: false,
                  mismatches: [
                    { attribute: 'subject', expected: 'greetings/vip-1', actual: 'greetings/ada' },
                  ],
                  invocationId: null,
                  outcome: null,
                  durationMs: null,
                },
                {
                  triggerKey: `us-central1-onAudit-0-${NAME}`,
                  functionId: 'us-central1-onAudit',
                  matched: true,
                  mismatches: [],
                  invocationId: 'a3f9c1-1331',
                  outcome: 'failed',
                  durationMs: 12.6,
                },
              ]}
              refs={[
                {
                  function: { kind: 'functions.function', key: 'us-central1-onGreeted' },
                  invocation: { kind: 'functions.invocation', key: 'a3f9c1-1330' },
                },
                {
                  function: { kind: 'functions.function', key: 'us-central1-onGreetedVip' },
                  invocation: null,
                },
                {
                  function: { kind: 'functions.function', key: 'us-central1-onAudit' },
                  invocation: { kind: 'functions.invocation', key: 'a3f9c1-1331' },
                },
              ]}
              unheard={false}
              eventType="test.greeter.v1.greeted"
              suggestions={[]}
              onUseType={() => undefined}
            />
          </Box>
        </Section>
        <Section
          title="Nobody listens"
          note="An unheard type names the types heard on the channel within three edits, and offers to publish it again as that."
        >
          <Box>
            <DeliveryList
              deliveries={[]}
              refs={[]}
              unheard
              eventType="test.greeter.v1.greetd"
              suggestions={['test.greeter.v1.greeted']}
              onUseType={() => undefined}
            />
          </Box>
        </Section>
      </Stack>
    </Kit>
  )
}

function event(overrides: Partial<EventarcEventSummary>): EventarcEventSummary {
  return {
    id: 'a3f9c1-1',
    seq: 1,
    eventId: 'e-1',
    receivedAt: '2026-10-12T14:03:01.412Z',
    channel: NAME,
    eventType: 'test.greeter.v1.greeted',
    source: 'projects/demo-shop/instances/greeter',
    subject: 'greetings/ada',
    publisher: 'greeter',
    origin: 'app',
    matched: 1,
    delivered: 1,
    failed: 0,
    pending: 0,
    filtered: 1,
    unheard: false,
    error: null,
    ...overrides,
  }
}

const EVENTS: EventarcEventSummary[] = [
  event({}),
  event({ id: 'a3f9c1-2', subject: 'greetings/vip-1', matched: 2, delivered: 2, filtered: 0 }),
  event({
    id: 'a3f9c1-3',
    eventType: 'test.greeter.v1.greetd',
    publisher: null,
    origin: 'console',
    source: 'console',
    subject: null,
    matched: 0,
    delivered: 0,
    filtered: 0,
    unheard: true,
  }),
  event({ id: 'a3f9c1-4', subject: 'greetings/bob', delivered: 0, failed: 1, filtered: 1 }),
  event({ id: 'a3f9c1-5', subject: 'greetings/eve', delivered: 0, pending: 1, filtered: 1 }),
]

function EventRowsCard() {
  return (
    <Kit>
      <Section
        title="Event rows"
        note="The console's clock, the type and subject in the data face, who published it, and what became of it — the only colour in the row."
      >
        <div className="overflow-hidden rounded-lg bg-kumo-base ring ring-kumo-line">
          <div className="border-b border-kumo-line bg-kumo-elevated text-[12px] text-kumo-strong">
            <EventHeader />
          </div>
          {EVENTS.map((entry) => (
            <div
              key={entry.id}
              className="flex h-8 items-center border-b border-kumo-hairline last:border-b-0"
            >
              <EventCells event={entry} clock="time" now={Date.parse('2026-10-12T14:03:09Z')} />
            </div>
          ))}
        </div>
      </Section>
    </Kit>
  )
}

const CHANNEL: EventarcChannel = {
  name: NAME,
  location: 'us-central1',
  id: 'firebase',
  publishers: [
    {
      instanceId: 'greeter',
      instance: { kind: 'extensions.instance', key: 'greeter' },
      source: 'projects/demo-shop/instances/greeter',
      allowed: ['test.greeter.v1.greeted'],
      declared: [
        { type: 'test.greeter.v1.greeted', description: null, allowed: true },
        { type: 'test.greeter.v1.failed', description: null, allowed: false },
      ],
    },
  ],
  subscriptions: [
    {
      triggerKey: `us-central1-onGreeted-0-${NAME}`,
      functionId: 'us-central1-onGreeted',
      function: { kind: 'functions.function', key: 'us-central1-onGreeted' },
      eventType: 'test.greeter.v1.greeted',
      filters: {},
      origin: 'definition',
      status: 'receiving',
    },
    {
      triggerKey: `us-central1-onGreetedVip-0-${NAME}`,
      functionId: 'us-central1-onGreetedVip',
      function: { kind: 'functions.function', key: 'us-central1-onGreetedVip' },
      eventType: 'test.greeter.v1.greeted',
      filters: { subject: 'greetings/vip-1' },
      origin: 'definition',
      status: 'receiving',
    },
    {
      triggerKey: 'x.y.z-registered',
      functionId: null,
      function: null,
      eventType: 'x.y.z',
      filters: {},
      origin: 'registered',
      status: 'receiving',
    },
  ],
  events: 40,
  lastEventAt: '2026-10-12T14:03:01.412Z',
}

function ChannelFlowCard() {
  return (
    <Kit>
      <Section
        title="Who publishes what to whom"
        note="Publishers with the types they may publish and the ones they only declare; subscribers with the type and filters; what does not line up, one line each underneath."
      >
        <div className="rounded-lg bg-kumo-base ring ring-kumo-line">
          <ChannelFlow channel={CHANNEL} warnings={channelWarnings(CHANNEL, [CHANNEL])} />
        </div>
      </Section>
    </Kit>
  )
}

defineCards([
  {
    id: 'delivery-trace',
    group: 'Patterns',
    name: 'Delivery trace',
    subtitle:
      'An event delivered to one handler and filtered out by another; an unheard type with its near miss',
    width: 560,
    surface: 'canvas',
    render: () => <DeliveryTraceCard />,
  },
  {
    id: 'delivery-trace-dark',
    group: 'Patterns',
    name: 'Delivery trace, dark',
    subtitle: 'The same, in dark mode',
    width: 560,
    dark: true,
    surface: 'canvas',
    render: () => <DeliveryTraceCard />,
  },
  {
    id: 'event-rows',
    group: 'Patterns',
    name: 'Event rows',
    subtitle: 'Delivered, filtered, unheard, failed and running events in a list',
    width: 880,
    surface: 'canvas',
    render: () => <EventRowsCard />,
  },
  {
    id: 'event-rows-dark',
    group: 'Patterns',
    name: 'Event rows, dark',
    subtitle: 'The same, in dark mode',
    width: 880,
    dark: true,
    surface: 'canvas',
    render: () => <EventRowsCard />,
  },
  {
    id: 'channel-flow',
    group: 'Patterns',
    name: 'Channel flow',
    subtitle: 'Publishers to subscribers on one channel, with its warnings',
    width: 960,
    surface: 'canvas',
    render: () => <ChannelFlowCard />,
  },
  {
    id: 'channel-flow-dark',
    group: 'Patterns',
    name: 'Channel flow, dark',
    subtitle: 'The same, in dark mode',
    width: 960,
    dark: true,
    surface: 'canvas',
    render: () => <ChannelFlowCard />,
  },
])
