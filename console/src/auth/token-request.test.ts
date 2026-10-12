import { describe, expect, it } from 'vitest'
import { authorizationHeader, customTokenSnippet, mintedToken, tokenRequest } from './token-request'

describe('what Auth asks POST /auth/tokens for', () => {
  it('sends the foundation’s { uid, tenant? } and nothing it did not choose', () => {
    expect(tokenRequest({ uid: 'u1' })).toEqual({ uid: 'u1' })
    expect(tokenRequest({ uid: 'u1', tenant: 'acme', secondFactor: 'default' })).toEqual({
      uid: 'u1',
      tenant: 'acme',
    })
    expect(tokenRequest({ uid: 'u1', tenant: '' })).toEqual({ uid: 'u1' })
  })

  it('adds only the optional fields 7.4.2 defines, when chosen', () => {
    expect(
      tokenRequest({
        uid: 'u1',
        provider: 'google.com',
        claims: {},
        secondFactor: { enrollment: 'e1' },
        runBeforeSignIn: true,
      }),
    ).toEqual({
      uid: 'u1',
      provider: 'google.com',
      claims: {},
      secondFactor: { kind: 'enrollment', id: 'e1' },
      runBeforeSignIn: true,
    })
    expect(tokenRequest({ uid: 'u1', secondFactor: 'none', runBeforeSignIn: false })).toEqual({
      uid: 'u1',
      secondFactor: { kind: 'none' },
    })
  })

  it('reads idToken and expiresAt as the foundation’s client does', () => {
    expect(mintedToken({ idToken: 'a.b.', expiresAt: '2026-10-12T10:00:00Z' })).toEqual({
      idToken: 'a.b.',
      expiresAt: Date.parse('2026-10-12T10:00:00Z'),
    })
  })

  it('writes the header and the custom token line as an app would paste them', () => {
    expect(authorizationHeader('t')).toBe('Authorization: Bearer t')
    expect(customTokenSnippet('{"uid":"u_ada"}')).toBe(
      `signInWithCustomToken(getAuth(), '{"uid":"u_ada"}')`,
    )
    expect(customTokenSnippet(`{"uid":"o'brien"}`)).toBe(
      `signInWithCustomToken(getAuth(), '{"uid":"o\\'brien"}')`,
    )
  })
})
