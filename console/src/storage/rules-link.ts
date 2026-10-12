// Links from the Files page to Storage's Rules page: a decision with its
// line ("Open on the Rules page"), a bucket's rules, and a refusal's request
// handed to the playground ("Try in the playground"). The Rules page is its
// own route (`/storage/rules`, `src/routes/storage_.rules.tsx`); a link is
// offered only while the router knows that route, so nothing is shown as
// available before it works.

import { useNavigate, useRouter } from '@tanstack/react-router'
import type { StorageEvaluateRequest } from '@/api/generated/storage/StorageEvaluateRequest'
import { usePlayground } from './rules-page/playground-store'
import { formFromRequest } from './rules-page/requests'
import type { StorageRulesSearch } from './rules-page/rules-search'

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

/**
 * Where a request is tried: the playground, on the page of the request's
 * bucket (its rules in per-bucket mode; the bucket the playground names in
 * single-file mode). The default bucket is the page's own and is not written.
 */
export function playgroundSearch(
  request: Pick<StorageEvaluateRequest, 'bucket'>,
  defaultBucket: string,
): StorageRulesSearch {
  return {
    ...(request.bucket === defaultBucket ? {} : { bucket: request.bucket }),
    panel: 'playground',
  }
}

/**
 * Hands a refused request to the Rules page's playground and opens it there,
 * where it runs at once against the rules in the editor; `undefined` while
 * the console has no Rules page.
 */
export function useTryInPlayground():
  | ((
      request: StorageEvaluateRequest,
      options: { decision?: string | null | undefined; defaultBucket: string },
    ) => void)
  | undefined {
  const open = useRulesPageLink()
  const load = usePlayground((state) => state.load)
  if (!open) return undefined
  return (request, { decision, defaultBucket }) => {
    load(formFromRequest(request, decision), { run: true })
    open(playgroundSearch(request, defaultBucket))
  }
}
