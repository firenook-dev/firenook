import { describe, expect, it } from 'vitest'
import { type GoldenFile, runGoldenCases } from '@/lib/filter-golden.test-support'
import cases from './event-filter-cases.json'
import { eventFields, toggleFailed } from './filters'

describe('the event filter’s fields', () => {
  it('are the ones the cases file (and so the engine) declares', () => {
    const declared = (cases as GoldenFile).fields
    expect(eventFields().map(({ suggest: _suggest, ...field }) => field)).toEqual(declared)
  })

  it('complete a type from what the channels publish and listen for', async () => {
    const type = eventFields(() => ['test.greeter.v1.greeted', 'app.order.v1.paid']).find(
      (field) => field.key === 'type',
    )
    expect(await type?.suggest?.('TEST.')).toEqual(['test.greeter.v1.greeted'])
  })
})

describe('the event filter’s golden cases', () => {
  runGoldenCases(cases as GoldenFile)
})

describe('errors only', () => {
  it('`e` adds delivery:failed and takes exactly that term away again', () => {
    expect(toggleFailed('')).toBe('delivery:failed')
    expect(toggleFailed('type:a.b')).toBe('type:a.b delivery:failed')
    expect(toggleFailed('type:a.b delivery:failed vip')).toBe('type:a.b vip')
  })
})
