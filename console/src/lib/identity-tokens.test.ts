import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/client'
import { sectionEntry, testStatus } from '@/test/status'

// The engine's two routes are stood in for, so the token path's own
// bookkeeping is what is tested: once per account for concurrent callers,
// again before expiry, the synthetic fallback. The journeys run the real
// routes (`firestore.spec.ts` views as a seeded Auth user).
const calls = vi.hoisted(() => ({ send: vi.fn(), get: vi.fn() }))

vi.mock('@/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/client')>()),
  apiSend: calls.send,
  apiGet: calls.get,
}))

const {
  SYNTHETIC_NOTE,
  fetchAs,
  forgetToken,
  identityKey,
  identityOfKey,
  resolveAuthorization,
  searchIdentityUsers,
  tokenKey,
  userTokenQuery,
} = await import('./identity')
const { queryClient } = await import('./query')

const PROJECT = 'demo-console'
const NOW = Date.parse('2026-10-12T06:00:00Z')

/** An ID token the engine would answer, expiring in `minutes`. */
function engineToken(uid: string, minutes = 60) {
  return {
    idToken: `engine.${uid}.${minutes}`,
    expiresAt: new Date(Date.now() + minutes * 60_000).toISOString(),
  }
}

function claimsOf(authorization: string | undefined): Record<string, unknown> {
  const payload = (authorization ?? '').replace('Bearer ', '').split('.')[1] ?? ''
  const base64 = payload.replace(/-/g, '+').replace(/_/g, '/')
  return JSON.parse(atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4))) as Record<
    string,
    unknown
  >
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  queryClient.clear()
  queryClient.setQueryData(
    ['status'],
    testStatus({ projectId: PROJECT, sections: [sectionEntry('auth')] }),
  )
  calls.send.mockReset()
  calls.get.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the one token path per kind', () => {
  it('answers the owner, an anonymous client and a custom identity without a request', async () => {
    expect(await resolveAuthorization({ kind: 'owner' }, PROJECT)).toBe('Bearer owner')
    expect(await resolveAuthorization({ kind: 'anonymous' }, PROJECT)).toBeUndefined()
    const custom = await resolveAuthorization(
      { kind: 'custom', uid: 'tester', claims: { admin: true } },
      PROJECT,
    )
    expect(claimsOf(custom)).toMatchObject({ sub: 'tester', admin: true, aud: PROJECT })
    expect(calls.send).not.toHaveBeenCalled()
  })

  it("mints an Auth user's token on the engine once for concurrent callers", async () => {
    let answer: ((value: unknown) => void) | undefined
    calls.send.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    const user = { kind: 'user', uid: 'u_k65eq', email: 'ada@example.test' } as const
    const first = resolveAuthorization(user, PROJECT)
    const second = resolveAuthorization(user, PROJECT)
    answer?.(engineToken('u_k65eq'))
    expect(await first).toBe('Bearer engine.u_k65eq.60')
    expect(await second).toBe('Bearer engine.u_k65eq.60')
    expect(calls.send).toHaveBeenCalledTimes(1)
    expect(calls.send).toHaveBeenCalledWith('POST', '/auth/tokens', { uid: 'u_k65eq' })
    // Cached where the auth section's topics can reach it.
    expect(queryClient.getQueryData(tokenKey(PROJECT, undefined, 'u_k65eq'))).toMatchObject({
      synthetic: false,
    })
  })

  it('names the tenant of a tenant user', async () => {
    calls.send.mockResolvedValue(engineToken('u1'))
    await resolveAuthorization({ kind: 'user', uid: 'u1', tenant: 'acme' }, PROJECT)
    expect(calls.send).toHaveBeenCalledWith('POST', '/auth/tokens', { uid: 'u1', tenant: 'acme' })
  })

  it('mints again five minutes before the token expires', async () => {
    calls.send
      .mockResolvedValueOnce(engineToken('u1', 60))
      .mockResolvedValueOnce(engineToken('u1', 61))
    const user = { kind: 'user', uid: 'u1' } as const
    expect(await resolveAuthorization(user, PROJECT)).toBe('Bearer engine.u1.60')
    vi.setSystemTime(NOW + 54 * 60_000)
    expect(await resolveAuthorization(user, PROJECT)).toBe('Bearer engine.u1.60')
    expect(calls.send).toHaveBeenCalledTimes(1)
    vi.setSystemTime(NOW + 56 * 60_000)
    expect(await resolveAuthorization(user, PROJECT)).toBe('Bearer engine.u1.61')
    expect(calls.send).toHaveBeenCalledTimes(2)
  })

  it('falls back to a synthetic token for an account the engine does not hold', async () => {
    calls.send.mockRejectedValue(
      new ApiError(404, 'The Auth emulator has no user ghost in this project.', 'not-found'),
    )
    const ghost = { kind: 'user', uid: 'ghost', claims: { plan: 'pro' } } as const
    const authorization = await resolveAuthorization(ghost, PROJECT)
    expect(claimsOf(authorization)).toMatchObject({ sub: 'ghost', plan: 'pro' })
    expect(queryClient.getQueryData(userTokenQuery(ghost, PROJECT).queryKey)).toMatchObject({
      synthetic: true,
    })
    expect(SYNTHETIC_NOTE).toBe('Not an Auth user: synthetic token')
  })

  it('makes the token here without asking when Authentication is not running, or for another project', async () => {
    queryClient.setQueryData(
      ['status'],
      testStatus({
        projectId: PROJECT,
        sections: [sectionEntry('auth', { state: 'absent', reason: 'not-configured' })],
      }),
    )
    expect(claimsOf(await resolveAuthorization({ kind: 'user', uid: 'u1' }, PROJECT)).sub).toBe(
      'u1',
    )
    queryClient.setQueryData(
      ['status'],
      testStatus({ projectId: PROJECT, sections: [sectionEntry('auth')] }),
    )
    expect(claimsOf(await resolveAuthorization({ kind: 'user', uid: 'u2' }, 'my-prod')).aud).toBe(
      'my-prod',
    )
    expect(calls.send).not.toHaveBeenCalled()
  })

  it('surfaces any other failure instead of pretending', async () => {
    calls.send.mockRejectedValue(new ApiError(0, 'The engine did not answer: offline', 'network'))
    await expect(resolveAuthorization({ kind: 'user', uid: 'u1' }, PROJECT)).rejects.toThrow(
      'offline',
    )
  })

  it('stops waiting when the caller aborts, without cancelling the shared mint', async () => {
    let answer: ((value: unknown) => void) | undefined
    calls.send.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    const controller = new AbortController()
    const user = { kind: 'user', uid: 'u1' } as const
    const waiting = resolveAuthorization(user, PROJECT, controller.signal)
    const other = resolveAuthorization(user, PROJECT)
    controller.abort()
    await expect(waiting).rejects.toThrow()
    answer?.(engineToken('u1'))
    expect(await other).toBe('Bearer engine.u1.60')
  })

  it('retries once with a new token when the engine refuses the cached one', async () => {
    calls.send
      .mockResolvedValueOnce(engineToken('u1', 60))
      .mockResolvedValueOnce(engineToken('u1', 120))
    const user = { kind: 'user', uid: 'u1' } as const
    const sent: Array<string | undefined> = []
    const send = vi.fn(async (authorization: string | undefined) => {
      sent.push(authorization)
      return new Response('{}', { status: sent.length === 1 ? 401 : 200 })
    })
    const response = await fetchAs(user, PROJECT, send)
    expect(response.status).toBe(200)
    expect(sent).toEqual(['Bearer engine.u1.60', 'Bearer engine.u1.120'])
    // Not for the kinds without an engine token, and not twice.
    const refused = vi.fn(async () => new Response('{}', { status: 401 }))
    expect((await fetchAs({ kind: 'anonymous' }, PROJECT, refused)).status).toBe(401)
    expect(refused).toHaveBeenCalledTimes(1)
    expect(forgetToken({ kind: 'owner' }, PROJECT)).toBe(false)
  })
})

describe('identity keys', () => {
  it('differ per identity, never hold a token, and read back as the identity', async () => {
    calls.send.mockResolvedValue(engineToken('u1'))
    const identities = [
      { kind: 'owner' },
      { kind: 'anonymous' },
      { kind: 'user', uid: 'u1' },
      { kind: 'user', uid: 'u1', tenant: 'acme' },
      { kind: 'user', uid: 'owner' },
      { kind: 'custom', uid: 'u1', claims: { admin: true } },
      { kind: 'custom', uid: 'u1', claims: {} },
    ] as const
    const keys = identities.map((identity) => identityKey(identity))
    expect(new Set(keys).size).toBe(identities.length)
    for (const key of keys) expect(key).not.toMatch(/Bearer|engine\./)
    // The email is how a person knows a user, not who the engine reads as.
    expect(identityKey({ kind: 'user', uid: 'u1', email: 'ada@example.test' })).toBe(keys[2])
    for (const identity of identities) {
      const back = identityOfKey(identityKey(identity))
      expect(back.kind).toBe(identity.kind)
      if ('uid' in identity && 'uid' in back) expect(back.uid).toBe(identity.uid)
    }
  })
})

describe('searching Auth users', () => {
  it('asks the bounded identity route, every tenant unless one is named', async () => {
    calls.get.mockResolvedValue({
      items: [{ uid: 'u1' }],
      nextCursor: null,
      prevCursor: null,
      total: null,
      scanned: null,
    })
    expect(await searchIdentityUsers(PROJECT, 'ada')).toEqual([{ uid: 'u1' }])
    expect(calls.get).toHaveBeenLastCalledWith(
      '/auth/identities',
      { q: 'ada', limit: 20, tenant: undefined, project: PROJECT },
      undefined,
    )
    await searchIdentityUsers(PROJECT, '', { tenant: '', limit: 50 })
    expect(calls.get).toHaveBeenLastCalledWith(
      '/auth/identities',
      { q: '', limit: 50, tenant: '', project: PROJECT },
      undefined,
    )
  })

  it("throws the engine's error rather than answering an empty list", async () => {
    calls.get.mockRejectedValue(new ApiError(503, 'Authentication is starting.', 'starting'))
    await expect(searchIdentityUsers(PROJECT, '')).rejects.toBeInstanceOf(ApiError)
  })
})
