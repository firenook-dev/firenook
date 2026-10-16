import { cleanup, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PubsubRejectedList } from '@/api/generated/messaging/PubsubRejectedList'
import { renderInConsole } from '@/test/render'
import { testStatus } from '@/test/status'
import { pubsubKeys } from '../queries'
import { PROJECT, topicIndex, topicSummary } from '../index-fixture.test-support'
import { refusedSentence } from './refused-banner'
import { LANDING_CARDS, TopicsLanding } from './topics-landing'

// The page's own lists are put in the cache by each test; nothing goes to a network.
beforeEach(() => vi.stubGlobal('fetch', () => new Promise<Response>(() => {})))
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const rejected = (items: PubsubRejectedList['items']): PubsubRejectedList => ({
  dropped: 0,
  revision: 1,
  items,
  nextCursor: null,
  prevCursor: null,
  total: { count: items.length, exact: true },
  scanned: null,
})

const refusal = (overrides: Partial<PubsubRejectedList['items'][number]> = {}) => ({
  firstAt: '2026-10-12T10:00:00Z',
  lastAt: '2026-10-12T10:00:00Z',
  count: 12,
  operation: 'publish',
  resource: `projects/${PROJECT}/topics/order`,
  error: 'Topic not found',
  code: 'NOT_FOUND',
  suggestion: 'orders',
  elsewhere: null,
  ...overrides,
})

async function renderLanding(
  index: ReturnType<typeof topicIndex>,
  refused: PubsubRejectedList = rejected([]),
  handlers: Partial<Parameters<typeof TopicsLanding>[0]> = {},
) {
  const view = await renderInConsole(
    () => (
      <TopicsLanding
        index={index}
        project={PROJECT}
        foreign={false}
        onOpen={handlers.onOpen ?? (() => {})}
        onCreateTopic={handlers.onCreateTopic ?? (() => {})}
        onImportSetup={handlers.onImportSetup ?? (() => {})}
        onProject={handlers.onProject ?? (() => {})}
      />
    ),
    {
      status: testStatus({
        projectId: PROJECT,
        foreignProjects: [
          {
            projectId: 'demo-other',
            services: ['pubsub'],
            firstSeen: '2026-10-12T10:00:00Z',
            requests: 3,
          },
        ],
      }),
    },
  )
  view.client.setQueryData(pubsubKeys.rejected(PROJECT), refused)
  return view
}

describe('the Topics landing (U-18)', () => {
  it('shows the 24 most recently active topics as cards, then says how many more', async () => {
    const topics = Array.from({ length: 30 }, (_, index) =>
      topicSummary(`load-${String(index).padStart(2, '0')}`, {
        counters: { lastPublishedAt: new Date(Date.UTC(2026, 9, 12, 10, index)).toISOString() },
      }),
    )
    await renderLanding(topicIndex(topics))
    const cards = await screen.findAllByTestId('pubsub-topic-card')
    expect(cards).toHaveLength(LANDING_CARDS)
    // The most recently published first.
    expect(cards[0]).toHaveTextContent('load-29')
    expect(screen.getByTestId('pubsub-landing-more')).toHaveTextContent(
      '6 more topics — filter them in the panel',
    )
  })

  it('leaves the schedules’ topics to the panel', async () => {
    await renderLanding(
      topicIndex([
        topicSummary('orders'),
        topicSummary('firebase-schedule-nightly', { kind: 'schedule' }),
      ]),
    )
    expect(await screen.findAllByTestId('pubsub-topic-card')).toHaveLength(1)
  })

  it('names what the app tried that the emulator refused, with the topic it probably meant', async () => {
    const onCreateTopic = vi.fn()
    const onOpen = vi.fn()
    await renderLanding(topicIndex([topicSummary('orders')]), rejected([refusal()]), {
      onCreateTopic,
      onOpen,
    })
    expect(await screen.findByTestId('pubsub-refused-banner')).toHaveTextContent(
      `Your app tried to publish to projects/${PROJECT}/topics/order 12 times; it does not exist. Did you mean orders?`,
    )
    await userEvent.click(screen.getByTestId('pubsub-refused-create'))
    expect(onCreateTopic).toHaveBeenCalledWith('order')
    await userEvent.click(screen.getByTestId('pubsub-refused-open'))
    expect(onOpen).toHaveBeenCalledWith(`projects/${PROJECT}/topics/orders`)
  })

  it('shows three refusals, then gathers the rest', async () => {
    const items = Array.from({ length: 5 }, (_, index) =>
      refusal({ resource: `projects/${PROJECT}/topics/missing-${index}`, suggestion: null }),
    )
    await renderLanding(topicIndex([topicSummary('orders')]), rejected(items))
    expect(await screen.findAllByTestId('pubsub-refused-banner')).toHaveLength(3)
    expect(screen.getByTestId('pubsub-refused-more')).toHaveTextContent(
      'and 2 more refused requests',
    )
  })

  it('draws no banner of its own about other projects or background triggers', async () => {
    await renderLanding(topicIndex([topicSummary('orders')]))
    await screen.findAllByTestId('pubsub-topic-card')
    expect(screen.queryByText(/demo-other/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Background triggers/)).not.toBeInTheDocument()
  })

  it('teaches how topics get here when there are none, and offers the setup back', async () => {
    const onImportSetup = vi.fn()
    await renderLanding(topicIndex([]), rejected([]), { onImportSetup })
    expect(await screen.findByTestId('pubsub-empty')).toHaveTextContent('No topics yet')
    expect(screen.getByTestId('pubsub-empty-new-topic')).toBeInTheDocument()
    screen.getByTestId('pubsub-empty-import-setup').click()
    expect(onImportSetup).toHaveBeenCalledOnce()
  })
})

describe('refusal sentences', () => {
  it('say what the app did, for each kind of request', () => {
    expect(refusedSentence(refusal({ count: 1, suggestion: null }))).toBe(
      `Your app tried to publish to projects/${PROJECT}/topics/order once; it does not exist.`,
    )
    expect(refusedSentence(refusal({ suggestion: null, elsewhere: 'demo-other' }))).toBe(
      `Your app tried to publish to projects/${PROJECT}/topics/order 12 times; it does not exist. It exists in project demo-other.`,
    )
    expect(
      refusedSentence(
        refusal({ code: 'INVALID_ARGUMENT', error: 'Could not parse message', suggestion: null }),
      ),
    ).toBe(
      `Your app's publish to projects/${PROJECT}/topics/order was refused 12 times: Could not parse message.`,
    )
    expect(
      refusedSentence(
        refusal({
          operation: 'pull',
          resource: `projects/${PROJECT}/subscriptions/w`,
          suggestion: null,
        }),
      ),
    ).toBe(
      `Your app tried to pull from projects/${PROJECT}/subscriptions/w 12 times; it does not exist.`,
    )
  })
})
