// The custom claim keys Auth users carry, for every editor that completes
// them: a rules editor after `request.auth.token.` (Firestore's and
// Storage's), the rules playground's claims and a custom identity's. They
// come from the engine's claim index (`GET /auth/claims`, Auth's own
// `claimKeysQuery`, so the Users page's live invalidation refreshes the same
// entry), never from reading users.
//
// Completion asks when it opens: an answer younger than a few seconds is
// used as it is, an older one is asked again, so a key set a moment ago in
// another tab is offered the next time without anything polling. Nothing is
// asked while Authentication is absent or starting; completion then offers
// the standard claims only.

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo } from 'react'
import { statusQuery } from '@/api/queries'
import { claimKeysQuery } from '@/auth/queries'

/** How long an answer is used before completion asks again, ms. */
export const CLAIM_KEYS_FRESH_MS = 5_000

export interface ClaimKeys {
  /** The keys as last answered (most users first); asks again in the background when stale. */
  now: () => readonly string[]
  /** The keys, asked again first when the last answer is stale. */
  fresh: () => Promise<readonly string[]>
}

const NONE: readonly string[] = []

/** The project's claim keys (the project's own users; `tenant` for one tenant's). */
export function useClaimKeys(project: string | undefined, tenant?: string): ClaimKeys {
  const client = useQueryClient()
  const status = useQuery(statusQuery)
  const entry = status.data?.sections.find((section) => section.id === 'auth')
  const ready = entry?.state === 'ready' && project !== undefined && project !== ''
  return useMemo(() => {
    if (!ready) return { now: () => NONE, fresh: () => Promise.resolve(NONE) }
    const options = { ...claimKeysQuery(project, tenant), staleTime: CLAIM_KEYS_FRESH_MS }
    const fresh = async (): Promise<readonly string[]> => {
      try {
        const answer = await client.fetchQuery(options)
        return answer.keys.map((key) => key.key)
      } catch {
        return NONE
      }
    }
    const now = (): readonly string[] => {
      void fresh()
      return client.getQueryData(options.queryKey)?.keys.map((key) => key.key) ?? NONE
    }
    return { now, fresh }
  }, [client, ready, project, tenant])
}
