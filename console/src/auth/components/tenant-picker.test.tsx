import { describe, expect, it } from 'vitest'
import type { AuthTenant } from '@/api/generated/auth/AuthTenant'
import type { AuthTenantPage } from '@/api/generated/auth/AuthTenantPage'
import { moreText, scopeLabel, tenantItems } from './tenant-picker'

function tenant(tenantId: string, extra: Partial<AuthTenant> = {}): AuthTenant {
  return {
    tenantId,
    displayName: null,
    users: 0,
    allowPasswordSignup: true,
    enableEmailLinkSignin: false,
    enableAnonymousUser: false,
    disableAuth: false,
    mfaState: 'DISABLED',
    mfaProviders: [],
    ...extra,
  }
}

function page(items: AuthTenant[], total = items.length, projectUsers = 40): AuthTenantPage {
  return {
    items,
    nextCursor: null,
    prevCursor: null,
    total: { count: total, exact: true },
    scanned: null,
    projectUsers,
  }
}

describe('the tenant picker', () => {
  it('names a tenant by its id, and the two scopes in words', () => {
    expect(scopeLabel({ kind: 'tenant', tenant: 'acme' })).toEqual({ text: 'acme', data: true })
    expect(scopeLabel({ kind: 'project' })).toEqual({ text: 'No tenant', data: false })
    expect(scopeLabel({ kind: 'all' })).toEqual({ text: 'All tenants', data: false })
  })

  it('lists every tenant first on the feeds only, then the project users, then the tenants with their counts', () => {
    const answer = page([
      tenant('acme', { displayName: 'Acme Corp', users: 5 }),
      tenant('globex', { users: 1 }),
    ])
    const feed = tenantItems('inbox', answer, { kind: 'all' })
    expect(feed.map((item) => item.value)).toEqual(['*', '', 'acme', 'globex'])
    expect(feed[1]).toMatchObject({ title: 'No tenant — project users', detail: '40 users' })
    expect(feed[2]).toMatchObject({ title: 'Acme Corp', id: 'acme', detail: '5 users' })
    expect(feed[3]).toMatchObject({ title: 'globex', id: undefined, detail: '1 user' })
    expect(tenantItems('users', answer, { kind: 'project' }).map((item) => item.value)).toEqual([
      '',
      'acme',
      'globex',
    ])
  })

  it('keeps the tenant in scope in the list even when the engine no longer lists it', () => {
    const items = tenantItems('settings', page([]), { kind: 'tenant', tenant: 'gone' })
    expect(items.map((item) => item.value)).toEqual(['', 'gone'])
  })

  it('says how many more tenants there are to narrow to', () => {
    const items = Array.from({ length: 50 }, (_, index) => tenant(`t${index + 1000}`))
    expect(moreText(page(items, 62))).toBe('12 more — type to narrow')
    expect(moreText(page(items, 50))).toBeUndefined()
    expect(moreText(undefined)).toBeUndefined()
  })
})
