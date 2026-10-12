import { describe, expect, it } from 'vitest'
import { MAX_PAGES, type PageParam, pageQueryOptions, reversedQuery } from './queries'
import { EMPTY_QUERY, type WorkbenchQuery } from './query'
import { type QueryPage, firestoreScope } from './rest'
import type { FsDocument } from './value'

const scope = firestoreScope({
  project: 'demo-p',
  database: '(default)',
  identity: { kind: 'owner' },
})
const root = 'projects/demo-p/databases/(default)/documents'
const query: WorkbenchQuery = { ...EMPTY_QUERY, limit: 2 }
const options = pageQueryOptions(scope, 'users', false, query)

const doc = (id: string): FsDocument => ({
  path: `users/${id}`,
  id,
  collection: 'users',
  fields: {},
})
const page = (...ids: string[]): QueryPage => ({ documents: ids.map(doc), readTime: 't' })
const next = (last: QueryPage, param: PageParam) =>
  options.getNextPageParam(last, [last], param, [param])
const previous = (first: QueryPage, param: PageParam) =>
  options.getPreviousPageParam?.(first, [first], param, [param])
const name = (id: string) => [{ referenceValue: `${root}/users/${id}` }]

describe('a grid window of pages', () => {
  it('holds at most 20 pages', () => {
    expect(options.maxPages).toBe(MAX_PAGES)
    expect(MAX_PAGES).toBe(20)
  })

  it('reads on after the last document until a short page', () => {
    expect(next(page('a', 'b'), undefined)).toEqual({ after: name('b') })
    expect(next(page('c'), { after: name('b') })).toBeUndefined()
  })

  it('has nothing before the query’s start', () => {
    expect(previous(page('a', 'b'), undefined)).toBeUndefined()
    expect(previous(page('a', 'b'), { from: 'start' })).toBeUndefined()
  })

  it('reads the page before the window’s first document once the start was let go', () => {
    expect(previous(page('e', 'f'), { after: name('d') })).toEqual({ before: name('e') })
    // A full page read backwards may have more before it; a short one is the start.
    expect(previous(page('c', 'd'), { before: name('e') })).toEqual({ before: name('c') })
    expect(previous(page('a'), { before: name('b') })).toBeUndefined()
  })

  it('goes on after a page read backwards, even a short one, so a refetch keeps the window', () => {
    expect(next(page('a'), { before: name('b') })).toEqual({ after: name('a') })
    expect(next(page(), { before: name('a') })).toEqual({ from: 'start' })
  })

  it('reads backwards with every direction flipped, the name included', () => {
    expect(
      reversedQuery({ ...EMPTY_QUERY, orderBy: [{ field: 'age', direction: 'desc' }] }).orderBy,
    ).toEqual([
      { field: 'age', direction: 'asc' },
      { field: '__name__', direction: 'asc' },
    ])
    expect(reversedQuery(EMPTY_QUERY).orderBy).toEqual([{ field: '__name__', direction: 'desc' }])
  })
})
