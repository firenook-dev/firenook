// Authentication's registry entry: its four pages, what ⌘K offers from
// anywhere, and where a user, a call or a message opens when ⌘K finds one or
// another section's payload points at one. It loads with the first route,
// so it holds icons and pure string helpers only; the beacon is a lazy
// chunk the shell mounts.

import {
  BuildingsIcon,
  MagnifyingGlassIcon,
  SignInIcon,
  UploadSimpleIcon,
  UserPlusIcon,
  UsersIcon,
  UsersThreeIcon,
} from '@phosphor-icons/react'
import type { ConsoleSection, SectionLink } from '../services'
import { splitKey } from './keys'

/**
 * Where a user opens: the Users page with the inspector on them. The key
 * is `<tenant>|<uid>`, the tenant empty for the project's users (built in
 * the engine only by `EntityRef::auth_user`); tenant ids never hold `|`, so
 * the uid after the first bar may.
 */
function userLink(key: string): SectionLink {
  const [first = '', uid] = splitKey(key)
  if (uid === undefined) return { to: '/auth', search: { tenant: undefined, user: first } }
  return { to: '/auth', search: { tenant: first || undefined, user: uid } }
}

export const auth: ConsoleSection = {
  id: 'auth',
  to: '/auth',
  label: 'Authentication',
  services: ['auth'],
  area: 'data',
  icon: UsersIcon,
  // False keeps the placeholder until the Authentication journeys pass.
  built: false,
  summary:
    'Users with search and live rows, a claims editor that shows the token it produces, an inbox for every link and code the emulator sends, every call with its exact error, tenants and blocking functions.',
  pages: [
    { to: '/auth', label: 'Users', exact: true, keywords: 'accounts claims tenants' },
    {
      to: '/auth/inbox',
      label: 'Inbox',
      badges: ['auth.inbox'],
      keywords: 'email link sms code otp verification reset',
    },
    {
      to: '/auth/activity',
      label: 'Activity',
      keywords: 'requests calls errors sign-in log token',
    },
    {
      to: '/auth/settings',
      label: 'Settings',
      keywords: 'tenants blocking functions triggers one account per email enumeration connect',
    },
  ],
  actions: [
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
  ],
  // Every route and topic takes `project`, so "Show demo-other" opens
  // Users, Inbox, Activity and Settings for the project the app used.
  projectScope: true,
  // The newest code and link in ⌘K, and fresh engine tokens for whoever a
  // page reads as; mounted while the section is ready and built.
  shellMount: () => import('@/auth/beacon'),
  searchLabels: { 'auth.user': 'Users' },
  // One field routes every Auth entity: ⌘K hits and every EntityRef
  // another section carries.
  routes: {
    'auth.user': userLink,
    // `<call id>` (`EntityRef::auth_call`): the Activity detail.
    'auth.call': (key): SectionLink => ({ to: '/auth/activity', search: { entry: key } }),
    // `<message id>` (`EntityRef::auth_message`): the Inbox reader.
    'auth.message': (key): SectionLink => ({ to: '/auth/inbox', search: { message: key } }),
  },
}
