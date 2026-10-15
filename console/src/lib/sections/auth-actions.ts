// What ⌘K offers from anywhere for Authentication. Only the palette reads
// it (`lib/palette-actions.ts`, in the palette's own lazy chunk), so these
// icons stay off the first route, where the registry (`./auth.ts`) loads.

import {
  BuildingsIcon,
  MagnifyingGlassIcon,
  SignInIcon,
  UploadSimpleIcon,
  UserPlusIcon,
  UsersThreeIcon,
} from '@phosphor-icons/react'
import type { SectionAction } from '../services'

export const authActions: readonly SectionAction[] = [
  {
    id: 'auth.new-user',
    title: 'Create a user',
    icon: UserPlusIcon,
    link: { to: '/auth', search: { new: 'user' } },
  },
  {
    id: 'auth.import',
    title: 'Import users',
    icon: UploadSimpleIcon,
    link: { to: '/auth', search: { new: 'import' } },
  },
  {
    id: 'auth.sample',
    title: 'Add sample users',
    icon: UsersThreeIcon,
    link: { to: '/auth', search: { new: 'sample' } },
  },
  {
    id: 'auth.try',
    title: 'Try a sign-in',
    icon: SignInIcon,
    link: { to: '/auth/activity', search: { panel: 'try' } },
  },
  {
    id: 'auth.inspect',
    title: 'Inspect a token',
    keywords: 'jwt decode verify id token session cookie',
    icon: MagnifyingGlassIcon,
    link: { to: '/auth/activity', search: { panel: 'inspect' } },
  },
  {
    id: 'auth.new-tenant',
    title: 'Create a tenant',
    icon: BuildingsIcon,
    link: { to: '/auth/settings', search: { new: 'tenant' } },
  },
]
