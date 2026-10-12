import { describe, expect, it } from 'vitest'
import { type GoldenFile, runGoldenCases } from '@/lib/filter-golden'
import { MESSAGE_FIELDS, deadLetterExpression, messageFields } from './filters'
import cases from './message-filter-cases.json'

// The message filter's cases, which the engine runs through the same
// harness (`filter::golden::run`): both sides parse and validate each text
// to exactly the same result or error, message and UTF-16 span included.
describe('the message filter (U-03)', () => {
  const count = runGoldenCases(cases as GoldenFile)
  it('covers every field of the page', () => {
    expect(count).toBeGreaterThan(0)
    expect((cases as GoldenFile).fields.map((field) => field.key)).toEqual([
      'id',
      'key',
      'attributes',
      'has',
      'is',
    ])
  })

  it('is the page’s own field list: the filter field validates what the engine validates', () => {
    const declared = MESSAGE_FIELDS.map(({ suggest: _suggest, ...field }) => field)
    expect(declared).toEqual((cases as GoldenFile).fields)
  })

  it('completes attribute keys and ordering keys from what the topic has seen', async () => {
    const fields = messageFields({
      attributeKeys: ['region', 'channel', 'Region2'],
      orderingKeys: ['cust-1', 'cust-2', 'other'],
    })
    const byKey = new Map(fields.map((field) => [field.key, field]))
    expect(await byKey.get('attributes')?.suggest?.('re')).toEqual(['region', 'Region2'])
    expect(await byKey.get('key')?.suggest?.('cust')).toEqual(['cust-1', 'cust-2'])
    expect(byKey.get('id')?.suggest).toBeUndefined()
    // Everything else about a field is the engine's.
    expect(fields.map(({ suggest: _suggest, ...field }) => field)).toEqual(
      MESSAGE_FIELDS.map(({ suggest: _suggest, ...field }) => field),
    )
  })

  it('reads a subscription’s dead letters by its id and project', () => {
    expect(deadLetterExpression('orders-worker', 'demo')).toBe(
      'attributes.CloudPubSubDeadLetterSourceSubscription = "orders-worker" AND attributes.CloudPubSubDeadLetterSourceSubscriptionProject = "demo"',
    )
  })
})
