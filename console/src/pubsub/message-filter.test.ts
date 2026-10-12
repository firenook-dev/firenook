import { describe, expect, it } from 'vitest'
import { type GoldenFile, runGoldenCases } from '@/lib/filter-golden'
import cases from './message-filter-cases.json'

// The message filter's cases, which the engine runs through the same
// harness (`filter::golden::run`): both sides parse and validate each text
// to exactly the same result or error, message and UTF-16 span included.
describe('the message filter', () => {
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
})
