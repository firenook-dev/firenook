import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => [] as unknown[])

vi.mock('@/lib/identity', async (original) => ({
  ...(await original<typeof import('@/lib/identity')>()),
  resolveAuthorization: (viewAs: { kind: string; uid?: string }) => {
    calls.push(viewAs)
    return Promise.resolve(
      viewAs.kind === 'user' ? `Bearer engine-token-for-${viewAs.uid}` : 'Bearer unsigned',
    )
  },
}))

const { callingIdentity, identityHeaders, maskToken } = await import('./identity-headers')

describe('Call as and App Check as headers', () => {
  beforeEach(() => {
    calls.length = 0
  })

  it('adds nothing for No auth and asks for no token', async () => {
    expect(await identityHeaders({ kind: 'owner' }, { kind: 'none' }, 'demo-x')).toEqual([])
    expect(calls).toEqual([])
  })

  it("sends an Auth user's engine token, set by Call as", async () => {
    expect(await identityHeaders({ kind: 'user', uid: 'ada' }, { kind: 'none' }, 'demo-x')).toEqual(
      [{ name: 'authorization', value: 'Bearer engine-token-for-ada', setBy: 'Call as' }],
    )
  })

  it('makes an anonymous caller a signed-in anonymous user', async () => {
    expect(callingIdentity({ kind: 'anonymous' })).toMatchObject({
      kind: 'custom',
      signInProvider: 'anonymous',
    })
    await identityHeaders({ kind: 'anonymous' }, { kind: 'none' }, 'demo-x')
    expect(calls).toEqual([
      expect.objectContaining({ kind: 'custom', signInProvider: 'anonymous' }),
    ])
  })

  it('adds the App Check token for an app id, and none for an empty one', async () => {
    const headers = await identityHeaders(
      { kind: 'owner' },
      { kind: 'app', appId: '1:123:web:abc' },
      'demo-x',
    )
    expect(headers).toHaveLength(1)
    expect(headers[0]).toMatchObject({ name: 'x-firebase-appcheck', setBy: 'App Check' })
    expect(
      await identityHeaders({ kind: 'owner' }, { kind: 'app', appId: '  ' }, 'demo-x'),
    ).toEqual([])
  })

  it("shows a token's ends only", () => {
    expect(maskToken('Bearer abcdefghijklmnopqrstuvwxyz0123456789')).toBe(
      'Bearer abcdefghijkl…456789',
    )
    expect(maskToken('Bearer short')).toBe('Bearer short')
  })
})
