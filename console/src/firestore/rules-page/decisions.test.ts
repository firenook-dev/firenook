import { describe, expect, it } from 'vitest'
import type { FirestoreDecision } from '@/api/generated/FirestoreDecision'
import { decisionParams, emptyText, recordedAuth } from './decisions'
import { describeForm, formFromDecision } from './requests'

function decision(patch: Partial<FirestoreDecision> = {}): FirestoreDecision {
  return {
    id: 'firenook-1-1',
    at: '2026-10-12T09:12:04Z',
    database: '(default)',
    method: 'get',
    path: 'users/u1',
    outcome: 'deny',
    error: null,
    uid: 'u2',
    tenant: null,
    provider: 'password',
    anonymous: false,
    allows: [{ line: 5, outcome: 'deny' }],
    rulesHash: 'h',
    viaConsole: false,
    ...patch,
  }
}

describe('narrowing the decisions', () => {
  it('becomes the topic’s parameters, which the engine evaluates; absent filters are left out', () => {
    expect(decisionParams('(default)', {})).toEqual({ database: '(default)' })
    expect(
      decisionParams('other', { path: 'users', uid: 'u1', denied: true, method: 'list' }),
    ).toEqual({ database: 'other', path: 'users', uid: 'u1', denied: true, method: 'list' })
    expect(decisionParams('(default)', { path: '', uid: '', denied: false })).toEqual({
      database: '(default)',
    })
  })

  it('says why a list is empty: nothing judged yet, or no rules at all', () => {
    expect(emptyText(true)).toContain('The Admin SDK')
    expect(emptyText(false)).toContain('no rules loaded')
  })
})

describe('a decision the engine no longer keeps', () => {
  it('is tried as who asked, with the uid, tenant and provider the feed recorded', () => {
    expect(recordedAuth(decision({ tenant: 'team-a' }))).toEqual({
      uid: 'u2',
      token: {
        sub: 'u2',
        user_id: 'u2',
        firebase: { sign_in_provider: 'password', tenant: 'team-a' },
      },
    })
    expect(recordedAuth(decision({ uid: null, anonymous: true }))).toBeNull()
    const form = formFromDecision(decision())
    expect(form).toMatchObject({ method: 'get', path: 'users/u1', group: false })
    expect(describeForm(form)).toBe('get users/u1 as u2')
  })

  it('reads a collection group back as the group of its id', () => {
    const form = formFromDecision(decision({ method: 'list', path: '**/orders' }))
    expect(form).toMatchObject({ method: 'list', path: 'orders', group: true })
    const below = formFromDecision(decision({ method: 'list', path: 'users/u1/**/orders' }))
    expect(below).toMatchObject({ path: 'orders', group: true })
    expect(formFromDecision(decision({ method: 'list', path: 'users' }))).toMatchObject({
      path: 'users',
      group: false,
    })
  })
})
