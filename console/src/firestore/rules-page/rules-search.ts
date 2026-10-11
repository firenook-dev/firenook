// The rules page's state that belongs in its address: the database, the
// panel beside the editor, the decision open in it, and how the decisions
// are narrowed — so "See why" on the data page is a link, and a decision
// you are looking at can be sent to someone.

import { useNavigate, useSearch } from '@tanstack/react-router'
import type { RulesSearch } from '@/routes/firestore_.rules'

export type RulesPanel = NonNullable<RulesSearch['panel']>

export function useRulesSearch() {
  const search = useSearch({ from: '/firestore_/rules' })
  const navigate = useNavigate({ from: '/firestore/rules' })
  const update = (patch: Partial<RulesSearch>, options?: { replace?: boolean }) =>
    void navigate({
      search: (previous) => {
        const next: Record<string, unknown> = { ...previous, ...patch }
        for (const [key, value] of Object.entries(next))
          if (value === undefined || value === '' || value === false) delete next[key]
        return next as RulesSearch
      },
      replace: options?.replace ?? false,
    })
  return { search, update }
}
