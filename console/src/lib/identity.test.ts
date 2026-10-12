import { describe, expect, it } from 'vitest'
import {
  OWNER_AUTHORIZATION,
  type ViewAs,
  authorizationFor,
  describeViewAs,
  describeViewAsShort,
  mintUnsignedToken,
  parseViewAs,
  serializeViewAs,
} from './identity'

/** The claims inside an unsigned token. */
function claims(token: string): Record<string, unknown> {
  const [header, payload, signature] = token.split('.')
  expect(JSON.parse(atob((header ?? '').replace(/-/g, '+').replace(/_/g, '/')))).toEqual({
    alg: 'none',
    typ: 'JWT',
  })
  expect(signature).toBe('')
  const base64 = (payload ?? '').replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4))
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0))))
}

const roundTrip = (viewAs: ViewAs) => parseViewAs(serializeViewAs(viewAs))

describe('?as= in the address', () => {
  it('leaves the owner out and names the anonymous client', () => {
    expect(serializeViewAs({ kind: 'owner' })).toBeUndefined()
    expect(parseViewAs(undefined)).toEqual({ kind: 'owner' })
    expect(parseViewAs('')).toEqual({ kind: 'owner' })
    expect(parseViewAs('owner')).toEqual({ kind: 'owner' })
    expect(serializeViewAs({ kind: 'anonymous' })).toBe('anonymous')
    expect(parseViewAs('anonymous')).toEqual({ kind: 'anonymous' })
  })

  it('reads the older uid and uid:email values unchanged', () => {
    expect(parseViewAs('u_9f3k2')).toEqual({ kind: 'user', uid: 'u_9f3k2' })
    expect(parseViewAs('u_9f3k2:ada@example.test')).toEqual({
      kind: 'user',
      uid: 'u_9f3k2',
      email: 'ada@example.test',
    })
    expect(serializeViewAs({ kind: 'user', uid: 'u_9f3k2', email: 'ada@example.test' })).toBe(
      'u_9f3k2:ada@example.test',
    )
  })

  it('carries a tenant before the uid', () => {
    const user: ViewAs = { kind: 'user', uid: 'u1', tenant: 'acme', email: 'ada@example.test' }
    expect(serializeViewAs(user)).toBe('acme|u1:ada@example.test')
    expect(parseViewAs('acme|u1:ada@example.test')).toEqual(user)
    expect(roundTrip({ kind: 'user', uid: 'u1', tenant: 'a|b%c' })).toEqual({
      kind: 'user',
      uid: 'u1',
      tenant: 'a|b%c',
    })
  })

  it('escapes every uid that would read as something else', () => {
    for (const uid of [
      'a:b',
      'a|b',
      '100%',
      '%3A',
      'owner',
      'anonymous',
      'custom.x',
      'custom.',
      'o',
      'ünï',
    ]) {
      expect(roundTrip({ kind: 'user', uid })).toEqual({ kind: 'user', uid })
      expect(roundTrip({ kind: 'user', uid, email: 'e@example.test' })).toEqual({
        kind: 'user',
        uid,
        email: 'e@example.test',
      })
    }
    expect(serializeViewAs({ kind: 'user', uid: 'owner' })).toBe('%6Fwner')
    expect(serializeViewAs({ kind: 'user', uid: 'a:b|c' })).toBe('a%3Ab%7Cc')
  })

  it('round-trips a custom identity as base64url JSON', () => {
    const custom: ViewAs = {
      kind: 'custom',
      uid: 'tester',
      claims: { admin: true, roles: ['editor'], note: 'ünïcode / + =' },
      signInProvider: 'google.com',
      emailVerified: true,
      email: 'tester@example.test',
    }
    const raw = serializeViewAs(custom) ?? ''
    expect(raw.startsWith('custom.')).toBe(true)
    expect(raw).toMatch(/^custom\.[A-Za-z0-9_-]+$/)
    expect(parseViewAs(raw)).toEqual(custom)
    expect(roundTrip({ kind: 'custom', uid: 'x', claims: {} })).toEqual({
      kind: 'custom',
      uid: 'x',
      claims: {},
    })
  })

  it('reads an older link to a user whose uid starts custom. as that user', () => {
    expect(parseViewAs('custom.not-json')).toEqual({ kind: 'user', uid: 'custom.not-json' })
  })
})

describe('tokens', () => {
  it('sends the owner as the owner and the anonymous client with nothing', () => {
    expect(authorizationFor({ kind: 'owner' }, 'demo-p')).toBe(OWNER_AUTHORIZATION)
    expect(authorizationFor({ kind: 'anonymous' }, 'demo-p')).toBeUndefined()
  })

  it('mints what the Auth emulator would put in a user token', () => {
    const token = claims(
      mintUnsignedToken(
        { kind: 'user', uid: 'u1', email: 'ada@example.test', claims: { admin: true } },
        'demo-p',
      ),
    )
    expect(token).toMatchObject({
      iss: 'https://securetoken.google.com/demo-p',
      aud: 'demo-p',
      sub: 'u1',
      user_id: 'u1',
      email: 'ada@example.test',
      email_verified: true,
      admin: true,
      firebase: { sign_in_provider: 'password', identities: { email: ['ada@example.test'] } },
    })
    expect(Number(token.exp) - Number(token.iat)).toBe(3600)
  })

  it('names the tenant of a tenant user, and leaves email claims off without an email', () => {
    const token = claims(mintUnsignedToken({ kind: 'user', uid: 'u2', tenant: 'acme' }, 'demo-p'))
    expect(token.firebase).toEqual({ identities: {}, sign_in_provider: 'custom', tenant: 'acme' })
    expect(token).not.toHaveProperty('email')
    expect(token).not.toHaveProperty('email_verified')
  })

  it('mints a custom identity with its uid, claims, provider and email_verified', () => {
    const authorization = authorizationFor(
      {
        kind: 'custom',
        uid: 'tester',
        claims: { admin: true },
        signInProvider: 'google.com',
        emailVerified: false,
        email: 'tester@example.test',
      },
      'demo-p',
    )
    expect(authorization?.startsWith('Bearer ')).toBe(true)
    const token = claims(authorization?.slice('Bearer '.length) ?? '')
    expect(token).toMatchObject({
      sub: 'tester',
      user_id: 'tester',
      admin: true,
      email: 'tester@example.test',
      email_verified: false,
      firebase: { sign_in_provider: 'google.com' },
    })
  })

  it('says email_verified for a custom identity that sets it without an email', () => {
    const token = claims(
      mintUnsignedToken({ kind: 'custom', uid: 'x', claims: {}, emailVerified: true }, 'demo-p'),
    )
    expect(token.email_verified).toBe(true)
    expect(token).not.toHaveProperty('email')
    expect((token.firebase as Record<string, unknown>).sign_in_provider).toBe('custom')
  })
})

describe('describing an identity', () => {
  it('reads as the toolbar writes it, with a shorter form for narrow ones', () => {
    expect(describeViewAs({ kind: 'owner' })).toBe('Admin (bypasses rules)')
    expect(describeViewAsShort({ kind: 'owner' })).toBe('Admin')
    expect(describeViewAs({ kind: 'anonymous' })).toBe('Anonymous')
    expect(describeViewAsShort({ kind: 'anonymous' })).toBe('Anonymous')
    expect(describeViewAs({ kind: 'user', uid: 'u1' })).toBe('u1')
    expect(describeViewAs({ kind: 'user', uid: 'u1', email: 'ada@example.test' })).toBe(
      'ada@example.test',
    )
    expect(describeViewAs({ kind: 'user', uid: 'u1', tenant: 'acme' })).toBe('u1 · acme')
    expect(describeViewAsShort({ kind: 'user', uid: 'u1', tenant: 'acme' })).toBe('u1')
    expect(describeViewAs({ kind: 'custom', uid: 'tester', claims: {} })).toBe('tester (custom)')
    expect(describeViewAsShort({ kind: 'custom', uid: 'tester', claims: {} })).toBe('tester')
  })
})
