import { describe, expect, it } from 'vitest'
import type { BackendDefinition } from '../envelopes'
import { composedUser } from './blocking-form'
import { callableHeaders, recordedData } from './callable-form'
import { documentPattern, eventInput, fixedChange, restFields, startingData } from './event-form'
import { optionsText } from './task-form'

const v1Write: BackendDefinition = {
  name: 'onOrderWritten',
  platform: 'gcfv1',
  eventTrigger: {
    eventType: 'providers/cloud.firestore/eventTypes/document.write',
    resource: 'projects/p/databases/(default)/documents/orders/{orderId}',
  },
}

describe('the Run forms', () => {
  it('know the change a Firestore trigger listens for', () => {
    expect(fixedChange('providers/cloud.firestore/eventTypes/document.create')).toBe('created')
    expect(fixedChange('google.cloud.firestore.document.v1.deleted.withAuthContext')).toBe(
      'deleted',
    )
    expect(fixedChange('google.cloud.firestore.document.v1.written')).toBeUndefined()
    expect(documentPattern(v1Write)).toBe('orders/{orderId}')
    expect(startingData('pubsub', v1Write)).toContain('"data"')
  })

  it("shape a write trigger's event data by the change chosen", () => {
    const fields = { data: '{"total":1}', path: '/orders/o1' }
    expect(eventInput('firestore', v1Write, { ...fields, change: 'created' })).toEqual({
      eventData: { before: null, after: { total: 1 } },
      opts: { resource: 'orders/o1' },
    })
    expect(eventInput('firestore', v1Write, { ...fields, change: 'updated' })).toMatchObject({
      eventData: { before: { total: 1 }, after: { total: 1 } },
    })
    expect(eventInput('firestore', v1Write, { ...fields, change: 'deleted' })).toMatchObject({
      eventData: { before: { total: 1 }, after: null },
    })
    expect(eventInput('firestore', v1Write, { data: '{', path: 'orders/o1' })).toEqual({
      problem: 'The event data does not parse as JSON.',
    })
    expect(eventInput('firestore', v1Write, { data: '{}', path: ' ' })).toEqual({
      problem: 'Name the document.',
    })
    expect(eventInput('pubsub', v1Write, { data: '{"data":"x"}' })).toEqual({
      eventData: { data: 'x' },
      opts: {},
    })
  })

  it('write integers as the REST API takes them for a real write', () => {
    expect(restFields({ n: 2, list: [3], map: { m: 1.5 } })).toEqual({
      n: { integerValue: '2' },
      list: { arrayValue: { values: [{ integerValue: '3' }] } },
      map: { mapValue: { fields: { m: { doubleValue: 1.5 } } } },
    })
  })

  it("send a callable's headers and read a recorded call's data back", () => {
    const draft = {
      kind: 'callable' as const,
      data: '{}',
      identity: { kind: 'owner' as const },
      appCheck: { kind: 'none' as const },
      stream: true,
    }
    expect(
      callableHeaders(draft, [{ name: 'authorization', value: 'Bearer t', setBy: 'Call as' }]),
    ).toEqual([
      { name: 'content-type', value: 'application/json' },
      { name: 'accept', value: 'text/event-stream' },
      { name: 'authorization', value: 'Bearer t' },
    ])
    expect(recordedData('{"data":{"text":"hi"}}')).toBe('{\n  "text": "hi"\n}')
    expect(recordedData('plain')).toBe('plain')
  })

  it('name what a queue sets', () => {
    expect(optionsText({ maxAttempts: 3, maxBackoffSeconds: null })).toBe('maxAttempts 3')
    expect(optionsText(null)).toBe('')
  })

  it('compose a sign-up as the Auth emulator holds the account', () => {
    const user = composedUser({
      kind: 'blocking',
      uid: '',
      email: 'a@x.test',
      displayName: 'A',
      provider: 'password',
      claims: '{"tier":1}',
    })
    expect(user).toMatchObject({
      localId: 'u_new',
      email: 'a@x.test',
      displayName: 'A',
      customAttributes: '{"tier":1}',
      providerUserInfo: [{ providerId: 'password', email: 'a@x.test', rawId: 'a@x.test' }],
    })
    expect(
      composedUser({
        kind: 'blocking',
        uid: 'u',
        email: '',
        displayName: '',
        provider: 'anonymous',
        claims: '[1]',
      }),
    ).toEqual({
      problem: 'The claims are a JSON object.',
    })
  })
})
