import { describe, expect, it } from 'vitest'
import type { EventarcEventView } from '@/api/generated/compute/EventarcEventView'
import {
  type PublishDraft,
  adminSdkCode,
  attributeProblem,
  curlCode,
  draftFromEvent,
  emptyDraft,
  matchRequest,
  publishProblems,
  publishRequest,
  wireEvent,
} from './publish'

const CHANNEL = 'projects/demo-x/locations/us-central1/channels/firebase'

const row = (key: string, value: string, enabled = true) => ({ id: key, key, value, enabled })

function draft(overrides: Partial<PublishDraft> = {}): PublishDraft {
  return {
    ...emptyDraft(CHANNEL, 'test.greeter.v1.greeted'),
    subject: 'greetings/ada',
    data: '{"name": "Ada"}',
    attributes: [row('tier', 'gold'), row('off', 'x', false)],
    ...overrides,
  }
}

describe('what is wrong with a draft, in the engine’s words', () => {
  it('a channel, a type and a source are needed', () => {
    expect(publishProblems(emptyDraft()).map((problem) => problem.message)).toEqual([
      'Name the channel to publish on.',
      'The event needs a type.',
    ])
    expect(publishProblems(draft({ source: ' ' }))).toEqual([
      { field: 'source', message: 'The event needs a source.' },
    ])
  })

  it('a channel is a full resource name or google', () => {
    expect(publishProblems(draft({ channel: 'firebase' }))[0]?.message).toBe(
      'The channel is projects/<project>/locations/<location>/channels/<id>, or google for the native channel.',
    )
    expect(publishProblems(draft({ channel: 'google' }))).toEqual([])
  })

  it('JSON data must parse; text need not', () => {
    expect(publishProblems(draft({ data: '{nope' }))[0]?.field).toBe('data')
    expect(publishProblems(draft({ encoding: 'text', data: '{nope' }))).toEqual([])
    expect(publishProblems(draft({ data: '' }))).toEqual([])
  })

  it('an attribute is 1 to 20 lowercase letters or digits, and not a CloudEvent field', () => {
    expect(attributeProblem('tier2')).toBeUndefined()
    expect(attributeProblem('Tier')).toBe('Use 1 to 20 lowercase letters or digits.')
    expect(attributeProblem('a'.repeat(21))).toBe('Use 1 to 20 lowercase letters or digits.')
    expect(attributeProblem('subject')).toBe(
      'A CloudEvent attribute of its own: set it with its field.',
    )
    expect(publishProblems(draft({ attributes: [row('bad-name', 'x')] }))[0]?.field).toBe(
      'attributes',
    )
  })
})

describe('the request and the matcher’s question', () => {
  it('sends what is set, leaves the rest to the engine, and drops switched-off attributes', () => {
    expect(publishRequest(draft())).toEqual({
      channel: CHANNEL,
      type: 'test.greeter.v1.greeted',
      source: 'console',
      subject: 'greetings/ada',
      id: null,
      time: null,
      encoding: 'json',
      data: '{"name": "Ada"}',
      attributes: { tier: 'gold' },
    })
  })

  it('asks who listens for this type here, with the attributes filters read', () => {
    expect(matchRequest(draft())).toEqual({
      service: 'eventarc',
      channel: CHANNEL,
      eventType: 'test.greeter.v1.greeted',
      attributes: { tier: 'gold', source: 'console', subject: 'greetings/ada' },
    })
    expect(matchRequest(draft({ type: '' }))).toBeUndefined()
    expect(matchRequest(draft({ channel: 'not a channel' }))).toBeUndefined()
  })
})

describe('edit and publish', () => {
  it('fills the drawer from a kept event: its type, subject, data and own attributes', () => {
    const view = {
      detail: {
        summary: {
          id: 'a3f9c1-7',
          seq: 7,
          eventId: 'e-7',
          receivedAt: '2026-10-12T00:00:00.000Z',
          channel: CHANNEL,
          eventType: 'test.greeter.v1.greetd',
          source: 'projects/demo-x/instances/greeter',
          subject: 'greetings/ada',
          publisher: 'greeter',
          origin: 'app',
          matched: 0,
          delivered: 0,
          failed: 0,
          pending: 0,
          filtered: 0,
          unheard: true,
          error: null,
        },
        attributes: {
          id: 'e-7',
          source: 'projects/demo-x/instances/greeter',
          type: 'test.greeter.v1.greetd',
          specversion: '1.0',
          subject: 'greetings/ada',
          time: '2026-10-12T00:00:00.000Z',
          datacontenttype: 'application/json',
          tier: 'gold',
        },
        datacontenttype: 'application/json',
        time: '2026-10-12T00:00:00.000Z',
        data: { name: 'Ada' },
        dataSize: 14,
        dataTruncated: false,
        raw: {},
        deliveries: [],
        replayOf: null,
      },
      deliveries: [],
    } satisfies EventarcEventView
    const filled = draftFromEvent(view)
    expect(filled).toMatchObject({
      channel: CHANNEL,
      type: 'test.greeter.v1.greetd',
      source: 'projects/demo-x/instances/greeter',
      subject: 'greetings/ada',
      encoding: 'json',
      data: '{\n  "name": "Ada"\n}',
      id: '',
      time: '',
    })
    expect(filled.attributes.map((entry) => [entry.key, entry.value])).toEqual([['tier', 'gold']])
  })
})

describe('copy as', () => {
  it('the Admin SDK call carries this event', () => {
    expect(adminSdkCode(draft())).toBe(`import { getEventarc } from 'firebase-admin/eventarc'

await getEventarc()
  .channel("${CHANNEL}")
  .publish({
    type: "test.greeter.v1.greeted",
    source: "console",
    subject: "greetings/ada",
    data: {
      "name": "Ada"
    },
    tier: "gold",
  })`)
  })

  it('the wire event is the Admin SDK’s proto JSON on a channel, a structured CloudEvent natively', () => {
    expect(wireEvent(draft(), 'id-1', '2026-10-12T00:00:00Z')).toEqual({
      id: 'id-1',
      source: 'console',
      specVersion: '1.0',
      type: 'test.greeter.v1.greeted',
      attributes: {
        datacontenttype: { ceString: 'application/json' },
        time: { ceTimestamp: '2026-10-12T00:00:00Z' },
        subject: { ceString: 'greetings/ada' },
        tier: { ceString: 'gold' },
      },
      textData: '{"name":"Ada"}',
    })
    expect(wireEvent(draft({ channel: 'google' }), 'id-1', '2026-10-12T00:00:00Z')).toEqual({
      specversion: '1.0',
      id: 'id-1',
      source: 'console',
      type: 'test.greeter.v1.greeted',
      time: '2026-10-12T00:00:00Z',
      datacontenttype: 'application/json',
      data: { name: 'Ada' },
      subject: 'greetings/ada',
      tier: 'gold',
    })
  })

  it('curl posts to the Eventarc emulator’s own address, quoted for a shell', () => {
    const code = curlCode(draft({ subject: "it's" }), 'http://127.0.0.1:9299', 'id-1', 'now')
    expect(code.split('\n')[0]).toBe(
      `curl -X POST 'http://127.0.0.1:9299/${CHANNEL}:publishEvents' \\`,
    )
    expect(code).toContain(`it'\\''s`)
    expect(curlCode(draft({ channel: 'google' }), 'http://h:1', 'i', 'n')).toContain(
      "'http://h:1/google/publishEvents'",
    )
  })
})
