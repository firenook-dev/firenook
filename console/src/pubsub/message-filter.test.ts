import { afterEach, describe, expect, it, vi } from 'vitest'
import { type GoldenFile, runGoldenCases } from '@/lib/filter-golden.test-support'
import { batchGetMessages, getMessages, messagesExportUrl } from './api'
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

describe('the expression field (U-03)', () => {
  afterEach(() => vi.unstubAllGlobals())
  const topic = 'projects/demo/topics/orders'
  // The subscription filter language, which the console never reads through
  // its own grammar: whatever is typed reaches the engine as it is.
  const expr = 'attributes.Region = "eu" AND NOT hasPrefix(attributes.k, "a b") -key:x'

  it('reaches the engine untouched, beside the filter text', async () => {
    const fetchMock = vi.fn(
      async (_url: string) =>
        new Response(
          JSON.stringify({ items: [], nextCursor: null, prevCursor: null, total: null }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    )
    vi.stubGlobal('fetch', fetchMock)
    const sent = (call: number) =>
      new URL(fetchMock.mock.calls[call]?.[0] ?? '', 'http://console.test').searchParams

    await getMessages({ topic, q: 'key:cust-*', expr })
    expect(sent(0).get('expr')).toBe(expr)
    expect(sent(0).get('q')).toBe('key:cust-*')
    expect(sent(0).get('topic')).toBe(topic)

    await batchGetMessages({ topic, expr }, { keys: ['12'], pageStarts: [] })
    expect(sent(1).get('expr')).toBe(expr)

    const exported = new URL(
      messagesExportUrl({ topic, expr, format: 'ndjson' }),
      'http://console.test',
    ).searchParams
    expect(exported.get('expr')).toBe(expr)
    expect(exported.get('format')).toBe('ndjson')
  })
})
