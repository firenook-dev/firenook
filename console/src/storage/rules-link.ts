// Links from the Files page to Storage's Rules page: a decision with its
// line ("Open on the Rules page"), a bucket's rules. The Rules page is its
// own route (`/storage/rules`, `src/routes/storage_.rules.tsx`); until that
// route is part of the console a link to it would lead nowhere, so each
// link is offered only once the router knows the route — nothing is shown
// as available before it works.

import { useNavigate, useRouter } from '@tanstack/react-router'
import type { StorageRulesSearch } from './search'

/** The Rules page's route id. */
const RULES_ROUTE = '/storage_/rules'

/** Opens the Rules page with `search`, or `undefined` while the console has no such page. */
export function useRulesPageLink(): ((search: StorageRulesSearch) => void) | undefined {
  const router = useRouter()
  const navigate = useNavigate()
  const routes = router.routesById as unknown as Record<string, unknown>
  if (routes[RULES_ROUTE] === undefined) return undefined
  return (search) => void navigate({ to: '/storage/rules' as never, search: search as never })
}
