import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthClaimKeys } from '@/api/generated/auth/AuthClaimKeys'
import { sectionEntry, testStatus } from '@/test/status'
import { CLAIM_KEYS_FRESH_MS, useClaimKeys } from './claim-keys'

const ANSWER: AuthClaimKeys = {
  keys: [
    { key: 'role', users: 3, kinds: ['string'], samples: ['admin'] },
    { key: 'tier', users: 1, kinds: ['string'], samples: ['gold'] },
  ],
  usersWithClaims: 3,
}

let client: QueryClient
let asked: string[]

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

function withAuth(state: 'ready' | 'starting' | 'absent') {
  client.setQueryData(['status'], testStatus({ sections: [sectionEntry('auth', { state })] }))
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  client = new QueryClient({
    defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY, retry: false } },
  })
  asked = []
  vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
    asked.push(String(input))
    return Promise.resolve(
      new Response(JSON.stringify(ANSWER), { headers: { 'content-type': 'application/json' } }),
    )
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('claim keys for completion', () => {
  it('come from the engine’s claim index, asked again only once the answer is stale', async () => {
    withAuth('ready')
    const { result } = renderHook(() => useClaimKeys('demo-console'), { wrapper })
    expect(await result.current.fresh()).toEqual(['role', 'tier'])
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatch(/\/console\/api\/v1\/auth\/claims\?project=demo-console$/)

    // Typing on: the answer is fresh, nothing is asked.
    expect(await result.current.fresh()).toEqual(['role', 'tier'])
    expect(result.current.now()).toEqual(['role', 'tier'])
    expect(asked).toHaveLength(1)

    // A completion opened later asks again, so a key set since is offered.
    vi.setSystemTime(Date.now() + CLAIM_KEYS_FRESH_MS + 1)
    await result.current.fresh()
    expect(asked).toHaveLength(2)
  })

  it('ask nothing while Authentication is absent or starting', async () => {
    withAuth('absent')
    const absent = renderHook(() => useClaimKeys('demo-console'), { wrapper })
    expect(await absent.result.current.fresh()).toEqual([])
    expect(absent.result.current.now()).toEqual([])
    withAuth('starting')
    const starting = renderHook(() => useClaimKeys('demo-console'), { wrapper })
    expect(await starting.result.current.fresh()).toEqual([])
    expect(starting.result.current.now()).toEqual([])
    expect(asked).toEqual([])
  })

  it('offer nothing when the engine refuses, rather than failing the completion', async () => {
    withAuth('ready')
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { code: 'unavailable', message: 'Auth stopped.' } }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    )
    const { result } = renderHook(() => useClaimKeys('demo-console'), { wrapper })
    expect(await result.current.fresh()).toEqual([])
  })
})
