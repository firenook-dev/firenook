import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EventarcEventSummary } from '@/api/generated/compute/EventarcEventSummary'
import {
  clearEvents,
  eventarcKeys,
  getChannels,
  getEvent,
  getEvents,
  publishEvent,
  replayEvent,
} from './api'
import { batchKeys } from './live'

let sent: Array<{ url: string; method: string; body: unknown }>
let status: number

beforeEach(() => {
  sent = []
  status = 200
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push({
        url: String(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      })
      return status === 204 ? new Response(null, { status }) : new Response('{}', { status })
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const last = () => sent.at(-1)

describe('the Eventarc routes', () => {
  it('read channels, a page of events by channel and filter, and one event', async () => {
    await getChannels()
    expect(last()?.url).toBe('/console/api/v1/eventarc/channels')
    await getEvents({ channel: '', q: '' })
    expect(last()?.url).toBe('/console/api/v1/eventarc/events')
    await getEvents({
      channel: 'projects/demo/locations/us-central1/channels/firebase',
      q: 'delivery:unheard',
      limit: 200,
    })
    expect(last()?.url).toBe(
      '/console/api/v1/eventarc/events?channel=projects%2Fdemo%2Flocations%2Fus-central1%2Fchannels%2Ffirebase&q=delivery%3Aunheard&limit=200',
    )
    await getEvent('a3f9c1-212')
    expect(last()?.url).toBe('/console/api/v1/eventarc/events/a3f9c1-212')
  })

  it('publish names the channel in the body, never in the path', async () => {
    await publishEvent({
      channel: 'projects/demo/locations/us-central1/channels/firebase',
      type: 'test.greeter.v1.greeted',
      source: 'console',
      subject: 'greetings/vip-1',
      id: null,
      time: null,
      encoding: 'json',
      data: '{"name":"Ada"}',
      attributes: {},
    })
    expect(last()).toMatchObject({
      url: '/console/api/v1/eventarc/channel/publish',
      method: 'POST',
      body: { type: 'test.greeter.v1.greeted', subject: 'greetings/vip-1' },
    })
  })

  it('replay keeps or renews the id, and clearing empties the record', async () => {
    await replayEvent('a3f9c1-212', { keepId: true })
    expect(last()).toMatchObject({
      url: '/console/api/v1/eventarc/events/a3f9c1-212/replay',
      body: { keepId: true },
    })
    status = 204
    await clearEvents()
    expect(last()).toMatchObject({ url: '/console/api/v1/eventarc/events', method: 'DELETE' })
  })
})

describe('eventarc.events', () => {
  it('reads the channels and each named event again, and nothing for an empty window', () => {
    const event = { id: 'a3f9c1-212' } as EventarcEventSummary
    expect(batchKeys('demo', { items: [event] })).toEqual([
      eventarcKeys.channels('demo'),
      ['eventarc', 'demo', 'event', 'a3f9c1-212'],
    ])
    expect(batchKeys('demo', { items: [] })).toEqual([])
    expect(eventarcKeys.eventPage('demo', '', 'type:x').slice(0, 3)).toEqual(
      eventarcKeys.events('demo'),
    )
  })
})
