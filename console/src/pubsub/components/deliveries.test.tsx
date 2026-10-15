// A message's deliveries to functions, in its inspector's Deliveries tab:
// the words of the request a delivery received, and the question before a
// run again.

import { describe, expect, it } from 'vitest'
import { dispatchJson, dispatchLabel } from './dispatch-view'
import { runAgainText } from './run-again'

describe('a message’s deliveries to functions', () => {
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
