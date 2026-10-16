import { describe, expect, it } from 'vitest'
import type { Explanation } from '@/api/generated/Explanation'
import {
  describeCandidates,
  describeOrders,
  formatElapsed,
  indexIsMissing,
  queryToExplain,
} from './explain'
import { DEFAULT_LIMIT, EMPTY_QUERY } from './query'

const ROOT = 'projects/demo/databases/(default)/documents'

describe('the query explained', () => {
  it('leaves out the page size the grid adds, because it is not part of the query', () => {
    const structured = queryToExplain('orders', false, EMPTY_QUERY, ROOT)
    expect(structured.limit).toBeUndefined()
  })

  it('keeps a limit the person wrote', () => {
    const structured = queryToExplain('orders', false, { ...EMPTY_QUERY, limit: 20 }, ROOT)
    expect(structured.limit).toBe(20)
  })

  it('treats the default as the page size even when it is written out', () => {
    // The console cannot tell `limit(100)` from its own paging, and says so
    // the same way `printQuery` does: by leaving the number out.
    const structured = queryToExplain(
      'orders',
      false,
      { ...EMPTY_QUERY, limit: DEFAULT_LIMIT },
      ROOT,
    )
    expect(structured.limit).toBeUndefined()
  })
})

describe('the sentence a person reads first', () => {
  it('names a scan by its collection', () => {
    expect(describeCandidates({ kind: 'collectionScan' }, 'users')).toBe(
      'Reads every document in users',
    )
  })

  it('names the fields an index narrows by', () => {
    expect(describeCandidates({ kind: 'equalityIndex', fields: ['plan', 'region'] }, 'users')).toBe(
      'Narrows users by the plan and region index',
    )
  })

  it('counts documents read by name, in the singular when there is one', () => {
    expect(describeCandidates({ kind: 'documentNames', names: 1 }, 'users')).toBe(
      'Reads one document by name',
    )
    expect(describeCandidates({ kind: 'documentNames', names: 3 }, 'users')).toBe(
      'Reads 3 documents by name',
    )
  })

  it('says where a collection group is rooted', () => {
    expect(describeCandidates({ kind: 'collectionGroupScan', ancestor: null }, 'orders')).toBe(
      'Reads every orders document in the database',
    )
    expect(
      describeCandidates({ kind: 'collectionGroupScan', ancestor: 'users/u1' }, 'orders'),
    ).toBe('Reads every orders document under users/u1')
  })
})

describe('the figures', () => {
  it('keeps microseconds readable at every scale', () => {
    expect(formatElapsed(412)).toBe('412 µs')
    expect(formatElapsed(2_900)).toBe('2.9 ms')
    expect(formatElapsed(1_332_000)).toBe('1332 ms')
  })

  it('prints the order as the chain that produced it', () => {
    expect(
      describeOrders([
        { field: 'total', descending: true },
        { field: '__name__', descending: true },
      ]),
    ).toBe('total desc, __name__ desc')
  })
})

const explanation = (index: Explanation['index']): Explanation => ({
  database: '(default)',
  target: 'users',
  scope: 'collection',
  candidates: { kind: 'collectionScan' },
  strategy: 'streaming',
  orders: [],
  documentsMatched: 0,
  limited: false,
  elapsedMicros: 0,
  index,
})

describe('whether the index needs acting on', () => {
  const requirement: NonNullable<Explanation['index']> = {
    declared: false,
    composite: true,
    collectionGroup: 'users',
    scope: 'collection',
    fields: [{ fieldPath: 'plan', mode: 'ascending', dimension: null }],
    configEntry: '{}',
  }

  it('is quiet when the query needs none', () => {
    expect(indexIsMissing(explanation(null))).toBe(false)
  })

  it('is quiet when the project already declares it', () => {
    expect(indexIsMissing(explanation({ ...requirement, declared: true }))).toBe(false)
  })

  it('speaks up only for one that would fail after a deploy', () => {
    expect(indexIsMissing(explanation(requirement))).toBe(true)
  })
})
