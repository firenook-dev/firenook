import { describe, expect, it } from 'vitest'
import { codebase, snapshot, summary, trigger } from './fixtures.test-support'
import {
  exactMatches,
  filterOverview,
  hasFailedOnly,
  overviewRows,
  scopeOf,
  toggleFailedOnly,
  withScopeTerm,
} from './filters'

const data = snapshot(
  [
    summary('api'),
    summary('onOrder', 'firestore', { trigger: trigger({ document: 'orders/{orderId}' }) }),
    summary('legacyDb', 'database', {
      status: 'ignored',
      region: 'europe-west1',
      id: 'europe-west1-legacyDb',
    }),
    summary('ping', 'http', { codebase: 'jobs' }),
  ],
  [
    codebase('default', {
      notLoaded: [{ id: 'us-central1-onConfig', eventType: 'x.y', reason: 'x.y is not emulated' }],
    }),
    codebase('jobs'),
  ],
)
const rows = overviewRows(data)
const names = (q: string) =>
  filterOverview(rows, q).map((row) =>
    row.kind === 'function' ? row.summary.name : `!${row.name}`,
  )

describe('the overview filter', () => {
  it('holds every function and every one dropped at load', () => {
    expect(names('')).toEqual(['api', 'onOrder', 'legacyDb', 'ping', '!onConfig'])
  })

  it('filters by kind, status, codebase and region, and words over name and trigger', () => {
    expect(names('kind:firestore')).toEqual(['onOrder'])
    expect(names('status:ignored')).toEqual(['legacyDb'])
    expect(names('status:not-loaded')).toEqual(['!onConfig'])
    expect(names('status:notLoaded')).toEqual(['!onConfig'])
    expect(names('codebase:jobs')).toEqual(['ping'])
    expect(names('codebase:jo*')).toEqual(['ping'])
    expect(names('region:europe-west1')).toEqual(['legacyDb'])
    expect(names('orders')).toEqual(['onOrder'])
    expect(names('-kind:http')).toEqual(['onOrder', 'legacyDb', '!onConfig'])
    expect(names('kind:http kind:database')).toEqual(['api', 'legacyDb', 'ping'])
  })

  it('keeps every row while the filter does not parse (the field says why)', () => {
    expect(names('nope:1')).toHaveLength(5)
  })

  it('matches exact values whole or by a starred prefix', () => {
    expect(exactMatches('us-central1', 'us-central1')).toBe(true)
    expect(exactMatches('us-central1', 'us-*')).toBe(true)
    expect(exactMatches('us-central1', 'us-')).toBe(false)
  })
})

describe('the invocation filter text', () => {
  it('turns failed-only on and off without touching the rest', () => {
    expect(toggleFailedOnly('')).toBe('outcome:failed')
    expect(toggleFailedOnly('took:>200ms')).toBe('took:>200ms outcome:failed')
    expect(toggleFailedOnly('took:>200ms outcome:failed boom')).toBe('took:>200ms boom')
    expect(hasFailedOnly('outcome:FAILED')).toBe(true)
    expect(hasFailedOnly('-outcome:failed')).toBe(false)
  })

  it('writes and reads the panel scope term', () => {
    expect(withScopeTerm('outcome:failed', { function: 'us-central1-api' })).toBe(
      'function:us-central1-api outcome:failed',
    )
    expect(withScopeTerm('fn:us-central1-x boom', { codebase: 'jobs' })).toBe('codebase:jobs boom')
    expect(withScopeTerm('function:us-central1-x', undefined)).toBe('')
    expect(scopeOf('function:us-central1-api is:cold')).toEqual({ function: 'us-central1-api' })
    expect(scopeOf('fn:us-central1-api')).toEqual({ function: 'us-central1-api' })
    expect(scopeOf('codebase:jobs')).toEqual({ codebase: 'jobs' })
    expect(scopeOf('function:a function:b')).toBeUndefined()
    expect(scopeOf('function:us-*')).toBeUndefined()
  })
})
