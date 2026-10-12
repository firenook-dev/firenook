import { describe, expect, it, vi } from 'vitest'
import type { AuthTenantPage } from '@/api/generated/auth/AuthTenantPage'
import { usersPaletteGroups } from './palette'

const tenants: AuthTenantPage = {
  projectUsers: 3,
  items: [
    {
      tenantId: 'acme',
      displayName: 'Acme Corp',
      users: 5,
      allowPasswordSignup: true,
      enableEmailLinkSignin: false,
      enableAnonymousUser: false,
      disableAuth: false,
      mfaState: 'DISABLED',
      mfaProviders: [],
    },
  ],
  nextCursor: null,
  prevCursor: null,
  total: { count: 1, exact: true },
  scanned: null,
}

describe('the Users page in ⌘K', () => {
  it('offers recent users once each, by the ref the engine’s search uses', () => {
    const onOpenRecent = vi.fn()
    const groups = usersPaletteGroups(
      {
        scope: { kind: 'tenant', tenant: 'acme' },
        tenants,
        recents: [{ tenant: 'acme', uid: 'u|1', label: 'ada@example.test', at: 1 }],
        onScope: () => {},
        onOpenRecent,
        unfrozen: false,
        onFreeze: () => {},
      },
      '',
    )
    const recent = groups.find((group) => group.label === 'Recent users')?.items[0]
    expect(recent?.ref).toEqual({ kind: 'auth.user', key: 'acme|u|1' })
    recent?.run()
    expect(onOpenRecent).toHaveBeenCalledTimes(1)
  })

  it('switches to every other scope, and finds them by word', () => {
    const onScope = vi.fn()
    const options = {
      scope: { kind: 'tenant', tenant: 'acme' } as const,
      tenants,
      recents: [],
      onScope,
      onOpenRecent: () => {},
      unfrozen: true,
      onFreeze: () => {},
    }
    const users = usersPaletteGroups(options, '').find((group) => group.label === 'Users')
    const titles = users?.items.map((item) => item.title)
    expect(titles).toContain('Project users (no tenant)')
    expect(titles).not.toContain('acme')
    expect(titles).toContain('Freeze the User column')
    const found = usersPaletteGroups(options, 'switch project')[0]?.items ?? []
    expect(found.map((item) => item.title)).toEqual(['Project users (no tenant)'])
    found[0]?.run()
    expect(onScope).toHaveBeenCalledWith({ kind: 'project' })
  })
})
