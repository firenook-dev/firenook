// U-18 for a subscription's tabs: a push subscription's Pull tab says why a
// pull gets nothing and offers the switch; a connected subscriber is warned
// about before a pull; `p` pauses and resumes the Push feed.

import { act, cleanup, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PubsubSubscription } from '@/api/generated/messaging/PubsubSubscription'
import { dispatchShortcut } from '@/lib/shortcuts'
import { renderInConsole } from '@/test/render'
import { testStatus } from '@/test/status'
import { createPushStore } from '../live'
import { subscriptionSummary } from '../index-fixture.test-support'
import { PULLED_KEPT, leaseExpired, lostLeases, usePulled } from '../pull-store'
import { PUSH_PULL_SENTENCE, PullView, consumersWarning } from './pull-view'
import { PushEnd } from './push-feed'

const SUBSCRIPTION = 'projects/demo/subscriptions/orders-worker'

function config(overrides: Partial<PubsubSubscription> = {}): PubsubSubscription {
  return {
    summary: subscriptionSummary('orders-worker', 'orders'),
    pushEndpoint: null,
    pushAttributes: {},
    ackDeadlineSeconds: 10,
    retainAcked: false,
    retentionSeconds: 604_800,
    expirationTtlSeconds: null,
    deadLetter: null,
    retry: null,
    labels: {},
    detached: false,
    createdAt: '2026-10-12T10:00:00Z',
    ...overrides,
  }
}

// The live channel's leader opens the console's one stream a tick after a
// page subscribes, which may be after the test has finished; jsdom has no
// EventSource, so a quiet one stands in for the whole file (nothing here
// asserts a live event).
class QuietEventSource {
  readyState = 0
  addEventListener() {}
  removeEventListener() {}
  close() {}
}
const live = globalThis as { EventSource?: unknown }
live.EventSource ??= QuietEventSource

beforeEach(() => vi.stubGlobal('fetch', () => new Promise<Response>(() => {})))
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  usePulled.setState({ subscription: undefined, rows: [] })
})

describe('a subscription’s Pull tab (U-18)', () => {
  it('on a push subscription says a pull gets nothing, and offers the switch', async () => {
    const push = config({ pushEndpoint: 'http://localhost:9000/hook' })
    await renderInConsole(
      () => (
        <PullView project="demo" subscription={SUBSCRIPTION} config={push} counters={undefined} />
      ),
      { status: testStatus({ projectId: 'demo' }) },
    )
    expect(screen.getByTestId('pubsub-pull-push-note')).toHaveTextContent(PUSH_PULL_SENTENCE)
    expect(screen.getByTestId('pubsub-switch-to-pull')).toHaveTextContent('Switch to pull')
    expect(screen.queryByTestId('pull-submit')).toBeNull()
  })

  it('warns before a pull when a subscriber is connected', async () => {
    const counters = {
      ...subscriptionSummary('orders-worker', 'orders').counters,
      consumers: { streaming: 1, waitingPulls: 0, lastPullAt: null },
    }
    await renderInConsole(
      () => (
        <PullView
          project="demo"
          subscription={SUBSCRIPTION}
          config={config()}
          counters={counters}
        />
      ),
      { status: testStatus({ projectId: 'demo' }) },
    )
    expect(screen.getByTestId('pubsub-pull-consumers')).toHaveTextContent(
      '1 subscriber is connected to orders-worker. Pulling here takes messages away from it.',
    )
    expect(screen.getByTestId('pull-submit')).toBeEnabled()
    expect(consumersWarning(3, 'orders-worker')).toBe(
      '3 subscribers are connected to orders-worker. Pulling here takes messages away from them.',
    )
  })
})

function received(ackId: string, id: string) {
  return {
    ackId,
    deliveryAttempt: 1,
    leaseExpiresAt: '2026-10-12T10:01:00Z',
    message: { id } as never,
  }
}

/** The shell's one listener hands each key to the registry. */
function press(key: string) {
  act(() => {
    dispatchShortcut(new KeyboardEvent('keydown', { key }))
  })
}

describe('the pull store', () => {
  it('keeps a delivery once, the newest first, and forgets another subscription’s', () => {
    const store = usePulled.getState()
    store.receive(SUBSCRIPTION, [received('a1', '1'), received('a2', '2')])
    // Delivered again: a new ack id, and the old row goes.
    usePulled.getState().receive(SUBSCRIPTION, [received('a3', '1')])
    expect(usePulled.getState().rows.map((row) => row.ackId)).toEqual(['a3', 'a2'])
    usePulled.getState().mark(['a3'], 'acked')
    expect(usePulled.getState().rows[0]?.outcome).toBe('acked')
    usePulled.getState().keepOnly('projects/demo/subscriptions/other')
    expect(usePulled.getState().rows).toEqual([])
    expect(PULLED_KEPT).toBe(1000)
  })

  it('says a lease ended early only from a list read after the row arrived', () => {
    const at = '2026-10-12T10:00:00.000Z'
    const row = (ackId: string, id: string) => ({
      ...received(ackId, id),
      receivedAt: at,
    })
    const rows = [row('a1', '1'), row('a2', '2'), { ...row('a3', '3'), outcome: 'acked' as const }]
    const later = Date.parse(at) + 1000
    // 1 is still leased to this delivery; 2 was returned; 3 was acked here.
    expect(
      lostLeases(rows, { complete: true, readAt: later, rows: [{ id: '1', attempts: 1 }] }),
    ).toEqual(new Set(['a2']))
    // Delivered again to someone else.
    expect(
      lostLeases(rows, {
        complete: true,
        readAt: later,
        rows: [
          { id: '1', attempts: 2 },
          { id: '2', attempts: 1 },
        ],
      }),
    ).toEqual(new Set(['a1']))
    // Read before the pull, or only part of the list: nothing is said.
    expect(lostLeases(rows, { complete: true, readAt: later - 5000, rows: [] }).size).toBe(0)
    expect(lostLeases(rows, { complete: false, readAt: later, rows: [] }).size).toBe(0)
    expect(leaseExpired({ ...rows[1]!, lost: true }, Date.parse(at))).toBe(true)
  })
})

function PushEndHarness({ store }: { store: ReturnType<typeof createPushStore> }) {
  const [paused, setPaused] = useState(false)
  return (
    <PushEnd
      project="demo"
      subscription={SUBSCRIPTION}
      endpoint="http://localhost:9000/hook"
      store={store}
      paused={paused}
      onPausedChange={setPaused}
    />
  )
}

describe('the Push feed’s pause (U-18)', () => {
  it('p pauses the feed and p resumes it', async () => {
    const store = createPushStore()
    await renderInConsole(() => <PushEndHarness store={store} />, {
      status: testStatus({ projectId: 'demo' }),
    })
    const button = screen.getByTestId('pubsub-push-pause')
    expect(button).toHaveTextContent('Pause')
    press('p')
    expect(button).toHaveTextContent('Paused')
    expect(button).toHaveAttribute('aria-pressed', 'true')
    press('p')
    expect(button).toHaveTextContent(/^Pause$/)
    expect(screen.getByTestId('push-endpoint')).toHaveTextContent('http://localhost:9000/hook')
  })
})
