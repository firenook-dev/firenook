import { QueryClient } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthUserFacets } from '@/api/generated/auth/AuthUserFacets'
import type { AuthUsersBatchGet } from '@/api/generated/auth/AuthUsersBatchGet'
import type { AuthUsersPage } from '@/api/generated/auth/AuthUsersPage'
import { type UsersFigures, authKeys, usersList } from './queries'

const FACETS: AuthUserFacets = {
  disabled: 1,
  unverified: 2,
  anonymous: 0,
  customToken: 0,
  sample: 0,
  mfa: 0,
  claims: 3,
  neverSignedIn: 4,
  providers: [{ provider: 'password', users: 9 }],
}

function page(extra: Partial<AuthUsersPage>): AuthUsersPage {
  return {
    items: [],
    nextCursor: null,
    prevCursor: null,
    total: null,
    scanned: null,
    facets: null,
    scopeTotal: null,
    tookMicros: 180,
    ...extra,
  }
}

let replies: unknown[]
let client: QueryClient

beforeEach(() => {
  replies = []
  client = new QueryClient()
  vi.stubGlobal('fetch', () =>
    Promise.resolve(
      new Response(JSON.stringify(replies.shift()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  )
})

afterEach(() => vi.unstubAllGlobals())

describe('the users list', () => {
  it('keys its pages by project, tenant, filter and order', () => {
    const list = usersList(
      'demo-auth',
      { kind: 'tenant', tenant: 'acme' },
      'ada',
      'email:asc',
      client,
    )
    expect(list.queryKey).toEqual(['auth', 'demo-auth', 'users', 'acme', 'ada', 'email:asc'])
    expect(list.figuresKey).toEqual(authKeys.usersFigures('demo-auth', 'acme', 'ada'))
    expect(list.rowKey({ uid: 'u_1' } as never)).toBe('u_1')
  })

  it('keeps the first page’s count and facets beside the rows, not a later page’s', async () => {
    const list = usersList('demo-auth', { kind: 'project' }, '', 'created:desc', client)
    replies.push(
      page({ total: { count: 9, exact: true }, facets: FACETS, scopeTotal: 9, nextCursor: 'n1' }),
    )
    await list.fetchPage({}, new AbortController().signal)
    expect(client.getQueryData<UsersFigures>(list.figuresKey)).toEqual({
      total: { count: 9, exact: true },
      facets: FACETS,
      scopeTotal: 9,
      tookMicros: 180,
    })
    replies.push(page({ tookMicros: 90 }))
    await list.fetchPage({ cursor: 'n1' }, new AbortController().signal)
    expect(client.getQueryData<UsersFigures>(list.figuresKey)?.tookMicros).toBe(180)
  })

  it('writes the recounted figures from a live batch read and hands the answer on unchanged', async () => {
    const list = usersList('demo-auth', { kind: 'project' }, 'is:disabled', 'created:desc', client)
    client.setQueryData<UsersFigures>(list.figuresKey, {
      total: { count: 1, exact: true },
      facets: FACETS,
      scopeTotal: 9,
      tookMicros: 180,
    })
    const answer: AuthUsersBatchGet = {
      items: [{ key: 'u_2', row: null, page: null }],
      total: { count: 2, exact: true },
      facets: { ...FACETS, disabled: 2 },
      scopeTotal: 10,
    }
    replies.push(answer)
    const got = await list.batchGet(
      { keys: ['u_2'], q: 'is:disabled', pageStarts: [null] },
      new AbortController().signal,
    )
    expect(got).toEqual(answer)
    expect(client.getQueryData<UsersFigures>(list.figuresKey)).toEqual({
      total: { count: 2, exact: true },
      facets: { ...FACETS, disabled: 2 },
      scopeTotal: 10,
      tookMicros: 180,
    })
  })
})
