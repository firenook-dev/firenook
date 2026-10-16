import { describe, expect, it } from 'vitest'
import { mergeSearch } from '@/lib/search-params'
import { functionsSearch, invocationsSearch } from './search'

describe('the Functions pages search params', () => {
  it('read every view the pages write', () => {
    expect(
      functionsSearch.parse({
        function: 'us-central1-api',
        tab: 'environment',
        invocation: 'a3f9c1-12',
        prefill: 'a3f9c1-11',
        paused: true,
        q: 'outcome:failed',
        source: 'orders/o1',
      }),
    ).toMatchObject({ function: 'us-central1-api', tab: 'environment', paused: true })
    expect(functionsSearch.parse({ codebase: 'jobs', sort: 'runs:desc' })).toEqual({
      codebase: 'jobs',
      sort: 'runs:desc',
    })
    expect(invocationsSearch.parse({ q: 'fn:x', invocation: 'a3f9c1-1', paused: true })).toEqual({
      q: 'fn:x',
      invocation: 'a3f9c1-1',
      paused: true,
    })
  })

  it('refuse a tab or an order that is not theirs', () => {
    expect(functionsSearch.safeParse({ tab: 'logs' }).success).toBe(false)
    expect(functionsSearch.safeParse({ sort: 'runs' }).success).toBe(false)
  })

  it('never write an empty value', () => {
    expect(
      mergeSearch({ function: 'us-central1-api', paused: true }, { paused: false, q: '' }),
    ).toEqual({
      function: 'us-central1-api',
    })
  })
})
