import { describe, expect, it } from 'vitest'
import type { AuthTokenInspection } from '@/api/generated/auth/AuthTokenInspection'
import { inspectThisToken, takeInspectDraft } from '../inspect-draft'
import { consumerLabel, kindLine } from './inspect-token'

function inspection(extra: Partial<AuthTokenInspection> = {}): AuthTokenInspection {
  return {
    kind: 'idToken',
    signed: false,
    header: { alg: 'none', typ: 'JWT' },
    payload: {},
    project: 'demo-auth',
    tenant: 'acme',
    uid: 'u_ada',
    userExists: true,
    checks: [],
    ...extra,
  }
}

describe('Inspect a token', () => {
  it('says what the token is', () => {
    expect(kindLine(inspection())).toBe(
      'ID token · unsigned (alg none) · project demo-auth · tenant acme',
    )
    expect(kindLine(inspection({ signed: true, header: { alg: 'RS256' }, tenant: null }))).toBe(
      'ID token · signed (RS256) · project demo-auth · no tenant',
    )
    expect(kindLine(inspection({ kind: 'refreshToken', header: null, project: null }))).toBe(
      'Refresh token · tenant acme',
    )
  })

  it('names each consumer the way the developer calls it', () => {
    expect(consumerLabel('rules', 'idToken')).toBe('Firestore and Storage rules')
    expect(consumerLabel('verifyRevoked', 'idToken')).toBe('verifyIdToken(token, true)')
    expect(consumerLabel('verify', 'sessionCookie')).toBe('verifySessionCookie(cookie)')
    expect(consumerLabel('signIn', 'refreshToken')).toBe('The refresh grant (securetoken)')
    expect(consumerLabel('signIn', 'customToken')).toBe('signInWithCustomToken')
  })

  it('takes a token handed to it once', () => {
    inspectThisToken('eyJ.a.b')
    expect(takeInspectDraft()).toBe('eyJ.a.b')
    expect(takeInspectDraft()).toBe('')
  })
})
