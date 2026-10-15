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
  it('switches to every other scope, and finds them by word', () => {
    const onScope = vi.fn()
    const options = {
      scope: { kind: 'tenant', tenant: 'acme' } as const,
      tenants,
      onScope,
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
