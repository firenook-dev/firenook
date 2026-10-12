// The Users page's address: every view of it is a link. The route declares
// this schema and strips the defaults, so a link carries only what makes
// the view different; the page's components read and write it through
// `useUsersSearch`.

import { z } from 'zod'
import { useRouteSearch, zSort } from '@/lib/search-params'

export const usersSearchSchema = z.object({
  /** The shell's project scope; absent: the configured project. */
  project: z.string().optional(),
  /** Absent: the project's own users. Otherwise a tenant id. */
  tenant: z.string().optional(),
  /** The filter, in the shared grammar. */
  q: z.string().optional(),
  /** `<column>:asc|desc`; the columns `GET /auth/users/meta` lists as sortable. */
  sort: zSort,
  /** The uid open in the inspector. */
  user: z.string().optional(),
  /** The inspector's tab. */
  tab: z.enum(['details', 'claims', 'activity', 'raw']).optional(),
  /** Opens a create dialog: New user, Import, Sample users, New tenant. */
  new: z.enum(['user', 'import', 'sample', 'tenant']).optional(),
  /** Opens another link-openable dialog: Export. */
  dialog: z.enum(['export']).optional(),
})

export type UsersSearch = z.infer<typeof usersSearchSchema>

/** What the address leaves out: the engine's own order and the first tab. */
export const USERS_DEFAULTS = {
  sort: 'created:desc',
  tab: 'details',
} as const satisfies Partial<UsersSearch>

/** The Users page's search params, with an updater that drops what is empty. */
export function useUsersSearch() {
  return useRouteSearch<UsersSearch>('/auth', '/auth')
}
