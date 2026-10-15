// What the Users page adds to ⌘K while it is on screen: a switch to every
// tenant and the page's own actions. Users themselves come from the
// engine's search, the section's actions (Create a user, Import users…)
// from the registry, and the cursor row's menu from the table.

import { ArrowsLeftRightIcon, PushPinIcon, PushPinSlashIcon } from '@phosphor-icons/react'
import { useEffect, useLayoutEffect, useRef } from 'react'
import type { AuthTenantList } from '@/api/generated/auth/AuthTenantList'
import {
  type PaletteGroup,
  type PaletteItem,
  matchesQuery,
  usePaletteProviders,
} from '@/lib/palette'
import type { TenantScope } from './tenant-scope'

export interface UsersPaletteOptions {
  scope: TenantScope
  /** The picker's first page of tenants (with the project users' count). */
  tenants: AuthTenantList | undefined
  onScope: (scope: TenantScope) => void
  /** The User column scrolls with the others (it is pinned by default). */
  unfrozen: boolean
  onFreeze: (frozen: boolean) => void
  /** The page's actions that act on the whole tenant (export, deletes). */
  actions?: readonly PaletteItem[] | undefined
}

/** The palette's groups for one search, from what the page holds. */
export function usersPaletteGroups(options: UsersPaletteOptions, query: string): PaletteGroup[] {
  const groups: PaletteGroup[] = []
  const scopes: { scope: TenantScope; title: string; detail?: string | undefined }[] = [
    { scope: { kind: 'project' }, title: 'Project users (no tenant)' },
    ...(options.tenants?.items ?? []).map((tenant) => ({
      scope: { kind: 'tenant', tenant: tenant.tenantId } as TenantScope,
      title: tenant.tenantId,
      detail: tenant.displayName ?? undefined,
    })),
  ]
  const current = options.scope.kind === 'tenant' ? options.scope.tenant : options.scope.kind
  const switches: PaletteItem[] = scopes
    .filter((entry) =>
      entry.scope.kind === 'tenant' ? entry.scope.tenant !== current : current !== 'project',
    )
    .map((entry) => ({
      id: `auth.scope:${entry.scope.kind === 'tenant' ? entry.scope.tenant : '(none)'}`,
      title: entry.title,
      breadcrumbs: ['Switch tenant'],
      description: entry.detail,
      keywords: 'tenant scope switch show',
      icon: <ArrowsLeftRightIcon size={16} />,
      run: () => options.onScope(entry.scope),
    }))

  const own: PaletteItem[] = [
    ...(options.actions ?? []),
    ...switches,
    options.unfrozen
      ? {
          id: 'auth.freeze',
          title: 'Freeze the User column',
          keywords: 'pin column layout',
          icon: <PushPinIcon size={16} />,
          run: () => options.onFreeze(true),
        }
      : {
          id: 'auth.unfreeze',
          title: 'Unfreeze the User column',
          keywords: 'pin column layout scroll',
          icon: <PushPinSlashIcon size={16} />,
          run: () => options.onFreeze(false),
        },
  ]
  const shown = own.filter((item) => matchesQuery(item, query))
  if (shown.length > 0) groups.push({ label: 'Users', items: shown })
  return groups
}

/** Registers the Users page's ⌘K groups while the page is mounted. */
export function useUsersPalette(options: UsersPaletteOptions): void {
  const register = usePaletteProviders((state) => state.register)
  const unregister = usePaletteProviders((state) => state.unregister)
  // The palette asks when it opens and as it is typed into, so the provider
  // reads the page as it is then; registering once keeps every render of
  // the page from telling the palette again.
  const latest = useRef(options)
  useLayoutEffect(() => {
    latest.current = options
  })
  useEffect(() => {
    register('auth.users', (query) => usersPaletteGroups(latest.current, query))
    return () => unregister('auth.users')
  }, [register, unregister])
}
