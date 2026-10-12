// The rules page's state that belongs in its address: the database, the
// panel beside the editor, the decision open in it, and how the decisions
// are narrowed — so "See why" on the data page is a link, and a decision
// you are looking at can be sent to someone.

import { useRouteSearch } from '@/lib/search-params'
import type { RulesSearch } from '@/routes/firestore_.rules'

export type RulesPanel = NonNullable<RulesSearch['panel']>

export function useRulesSearch() {
  return useRouteSearch<RulesSearch>('/firestore_/rules', '/firestore/rules')
}
