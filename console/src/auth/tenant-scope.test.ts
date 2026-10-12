import { describe, expect, it } from 'vitest'
import {
  activityTopicParams,
  configTopicParams,
  feedTenant,
  inboxTopicParams,
  keysTarget,
  parseUserKey,
  queryTarget,
  tenantKey,
  tenantParam,
  tenantScope,
  userKey,
  usersTenant,
  usersTopicParams,
} from './tenant-scope'

describe('a page’s tenant param', () => {
  it('on Users and Settings: project users by default, a tenant by id, the others dropped', () => {
    for (const page of ['users', 'settings'] as const) {
      expect(tenantScope(page, undefined)).toEqual({ kind: 'project' })
      expect(tenantScope(page, '')).toEqual({ kind: 'project' })
      expect(tenantScope(page, '(none)')).toEqual({ kind: 'project' })
      expect(tenantScope(page, '(all)')).toEqual({ kind: 'project' })
      expect(tenantScope(page, 'acme')).toEqual({ kind: 'tenant', tenant: 'acme' })
    }
  })

  it('on the feeds: every tenant by default, (none) for project calls, a tenant by id', () => {
    for (const page of ['inbox', 'activity'] as const) {
      expect(tenantScope(page, undefined)).toEqual({ kind: 'all' })
      expect(tenantScope(page, '(all)')).toEqual({ kind: 'all' })
      expect(tenantScope(page, '(none)')).toEqual({ kind: 'project' })
      expect(tenantScope(page, 'acme')).toEqual({ kind: 'tenant', tenant: 'acme' })
    }
  })

  it('is written back without the page’s default, so a link carries only what differs', () => {
    expect(tenantParam('users', { kind: 'project' })).toBeUndefined()
    expect(tenantParam('users', { kind: 'tenant', tenant: 'acme' })).toBe('acme')
    expect(tenantParam('activity', { kind: 'all' })).toBeUndefined()
    expect(tenantParam('activity', { kind: 'project' })).toBe('(none)')
    expect(tenantParam('inbox', { kind: 'tenant', tenant: 'acme' })).toBe('acme')
    for (const page of ['users', 'inbox', 'activity', 'settings'] as const)
      for (const raw of [undefined, '(none)', 'acme'])
        expect(tenantScope(page, tenantParam(page, tenantScope(page, raw)))).toEqual(
          tenantScope(page, raw),
        )
  })
})

describe('what a scope sends', () => {
  it('to the users routes and the query keys', () => {
    expect(usersTenant({ kind: 'project' })).toBeUndefined()
    expect(usersTenant({ kind: 'tenant', tenant: 'acme' })).toBe('acme')
    expect(tenantKey({ kind: 'project' })).toBe('')
    expect(tenantKey({ kind: 'tenant', tenant: 'acme' })).toBe('acme')
    expect(tenantKey({ kind: 'all' })).toBe('*')
  })

  it('to the feeds, never naming every tenant as a tenant', () => {
    expect(feedTenant({ kind: 'all' })).toBeUndefined()
    expect(feedTenant({ kind: 'project' })).toBe('(none)')
    expect(feedTenant({ kind: 'tenant', tenant: 'acme' })).toBe('acme')
  })

  it('to the users topic: the configured project left out, all tenants not a topic', () => {
    expect(usersTopicParams('', { kind: 'project' })).toEqual({})
    expect(usersTopicParams('demo-x', { kind: 'project' })).toEqual({ project: 'demo-x' })
    expect(usersTopicParams('demo-x', { kind: 'tenant', tenant: 'acme' })).toEqual({
      project: 'demo-x',
      tenant: 'acme',
    })
    expect(usersTopicParams('demo-x', { kind: 'all' })).toBeNull()
  })

  it('to the feed topics: the filter and the console flag as the page has them', () => {
    expect(activityTopicParams('demo-x', { kind: 'all' }, '', false)).toEqual({
      project: 'demo-x',
      console: false,
    })
    expect(activityTopicParams('demo-x', { kind: 'project' }, 'is:error', true)).toEqual({
      project: 'demo-x',
      tenant: '(none)',
      q: 'is:error',
      console: true,
    })
    expect(inboxTopicParams('', { kind: 'tenant', tenant: 'acme' }, '-is:used')).toEqual({
      tenant: 'acme',
      q: '-is:used',
    })
    expect(inboxTopicParams('demo-x', { kind: 'all' }, undefined)).toEqual({ project: 'demo-x' })
  })

  it('to the config and hooks topics', () => {
    expect(configTopicParams('')).toEqual({})
    expect(configTopicParams('demo-other')).toEqual({ project: 'demo-other' })
  })
})

describe('user keys and bulk targets', () => {
  it('build `<tenant>|<uid>`, the tenant empty for project users, and read it back', () => {
    expect(userKey(null, 'u_1')).toBe('|u_1')
    expect(userKey(undefined, 'u_1')).toBe('|u_1')
    expect(userKey('acme', 'a|b')).toBe('acme|a|b')
    expect(parseUserKey('acme|a|b')).toEqual({ tenant: 'acme', uid: 'a|b' })
    expect(parseUserKey('|u_1')).toEqual({ tenant: undefined, uid: 'u_1' })
    expect(parseUserKey('u_1')).toEqual({ tenant: undefined, uid: 'u_1' })
  })

  it('name ticked users by key in their scope', () => {
    expect(keysTarget({ kind: 'project' }, ['u_1', 'u/2'])).toEqual({
      by: 'keys',
      keys: ['|u_1', '|u/2'],
    })
    expect(keysTarget({ kind: 'tenant', tenant: 'acme' }, ['u_1'])).toEqual({
      by: 'keys',
      keys: ['acme|u_1'],
    })
  })

  it('name everything a filter matches with the users list’s own scope as JSON', () => {
    expect(queryTarget({ kind: 'project' }, 'is:disabled')).toEqual({
      by: 'query',
      q: 'is:disabled',
      scope: {},
    })
    expect(queryTarget({ kind: 'tenant', tenant: 'acme' }, undefined)).toEqual({
      by: 'query',
      q: '',
      scope: { tenant: 'acme' },
    })
  })
})
