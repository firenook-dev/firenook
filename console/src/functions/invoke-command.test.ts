import { describe, expect, it } from 'vitest'
import { callableInvokeCommand, eventInvokeCommand, httpInvokeCommand } from './invoke-command'

describe('Copy as firenook functions:invoke', () => {
  it('says an HTTP call only when the CLI can make it', () => {
    expect(
      httpInvokeCommand({
        name: 'api',
        region: 'us-central1',
        method: 'GET',
        path: '/',
        hasBody: false,
      }),
    ).toEqual({
      command: 'firenook functions:invoke api --method GET',
    })
    expect(
      httpInvokeCommand({
        name: 'api',
        region: 'europe-west1',
        method: 'post',
        path: '',
        hasBody: false,
      }),
    ).toEqual({
      command: 'firenook functions:invoke api --region europe-west1',
    })
    expect(
      httpInvokeCommand({
        name: 'api',
        region: 'us-central1',
        method: 'GET',
        path: '/hello',
        hasBody: false,
      }),
    ).toHaveProperty('refused')
    expect(
      httpInvokeCommand({
        name: 'api',
        region: 'us-central1',
        method: 'POST',
        path: '/',
        hasBody: true,
      }),
    ).toHaveProperty('refused')
  })

  it("writes a callable's data and an event's data, quoted for a shell", () => {
    expect(
      callableInvokeCommand({
        name: 'addMessage',
        region: 'us-central1',
        dataText: '{\n  "text": "it\'s"\n}',
      }),
    ).toBe(`firenook functions:invoke addMessage --data '{"text":"it'\\''s"}'`)
    expect(
      eventInvokeCommand({
        name: 'onOrder',
        region: 'us-central1',
        eventData: { total: 1 },
        resource: 'orders/o1',
      }),
    ).toBe(`firenook functions:invoke onOrder --event-data '{"total":1}' --resource 'orders/o1'`)
    expect(
      eventInvokeCommand({ name: 'f', region: 'r', params: { id: 'x' }, eventType: 't' }),
    ).toBe(
      `firenook functions:invoke f --region r --event-data '{}' --params '{"id":"x"}' --event-type 't'`,
    )
  })
})
