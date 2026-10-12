// The Deliveries tab's pieces: the outcome switch's counts and choices, the
// words of the request a delivery received, where its logs open, and the
// tab when Functions does not run (U-10, U-18).

import { cleanup, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { logs } from '@/lib/sections/logs'
import { renderInConsole } from '@/test/render'
import { sectionEntry, testStatus } from '@/test/status'
import { whileUnbuilt } from '@/test/unbuilt'
import { dispatchJson, dispatchLabel } from './dispatch-view'
import { DeliveriesView, deliveryLogs, outcomeCounts, shownOutcomes } from './deliveries-table'
import { runAgainText } from './run-again'

beforeEach(() => vi.stubGlobal('fetch', () => new Promise<Response>(() => {})))
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('the outcome switch', () => {
  it('counts what is no longer kept as what `all` holds beyond the known outcomes', () => {
    const counts = outcomeCounts({
      all: 12,
      queued: 1,
      running: 1,
      delivered: 6,
      failed: 2,
      skipped: 0,
    })
    expect(counts['not-kept']).toBe(2)
    expect(counts.all).toBe(12)
  })

  it('always offers All, Delivered and Failed, and the rest while they count or are chosen', () => {
    const quiet = outcomeCounts({
      all: 3,
      queued: 0,
      running: 0,
      delivered: 3,
      failed: 0,
      skipped: 0,
    })
    expect(shownOutcomes(quiet, undefined)).toEqual(['all', 'delivered', 'failed'])
    expect(shownOutcomes(quiet, 'queued')).toEqual(['all', 'delivered', 'failed', 'queued'])
    const busy = outcomeCounts({
      all: 9,
      queued: 2,
      running: 1,
      delivered: 3,
      failed: 0,
      skipped: 1,
    })
    expect(shownOutcomes(busy, undefined)).toEqual([
      'all',
      'delivered',
      'failed',
      'running',
      'queued',
      'skipped',
      'not-kept',
    ])
  })
})

describe('a delivery’s request and links', () => {
  it('names the request by how far the delivery got', () => {
    expect(dispatchLabel('delivered')).toBe('Request received')
    expect(dispatchLabel('failed')).toBe('Request received')
    expect(dispatchLabel('queued')).toBe('Request it will receive')
    expect(dispatchLabel('skipped')).toBe('Request it would have received')
  })

  it('reads a CloudEvent as JSON and anything else as text', () => {
    expect(dispatchJson('{"id":"e-1","data":{}}')).toEqual({ id: 'e-1', data: {} })
    expect(dispatchJson('not json')).toBeUndefined()
  })

  it('opens the function’s lines in Logs, and no logs while the Logs section is not built', async () => {
    const row = { functionId: 'us-central1-onOrderPlaced', invocation: null }
    expect(deliveryLogs(row)).toEqual({
      to: '/logs',
      search: { q: 'function:us-central1-onOrderPlaced' },
    })
    expect(await whileUnbuilt(logs, () => deliveryLogs(row))).toBeNull()
  })

  it('asks before a run again, naming the function and the message', () => {
    const text = runAgainText({
      messageId: '1187',
      functionId: 'us-central1-onOrderPlaced',
      functionName: 'onOrderPlaced',
    })
    expect(text.title).toBe('Run onOrderPlaced again with message 1187?')
    expect(text.description).toMatch(/new event id/)
    expect(text.description).toMatch(/No subscription and no other function/)
  })
})

describe('the Deliveries tab without Functions (U-18)', () => {
  it('says deliveries need Functions instead of a table', async () => {
    await renderInConsole(
      () => (
        <DeliveriesView
          project="demo"
          topic="projects/demo/topics/orders"
          functions={[]}
          search={{}}
          update={() => {}}
          onLiveStatus={() => {}}
          onOpenSubscription={() => {}}
          onEditAgain={() => {}}
        />
      ),
      {
        status: testStatus({
          projectId: 'demo',
          sections: [
            sectionEntry('functions', {
              state: 'absent',
              detail: 'This engine was started with --only pubsub.',
            }),
          ],
        }),
      },
    )
    expect(await screen.findByTestId('requires-functions')).toHaveTextContent(
      'Delivering messages to functions needs Functions, which this engine does not run.',
    )
    expect(screen.queryByTestId('pubsub-delivery-table')).toBeNull()
  })
})
