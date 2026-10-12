// The Storage rules page's state that belongs in its address, in the rules
// kit's one schema: the bucket (per-bucket rules only), the panel beside the
// editor, the decision open in it, how the decisions are narrowed (a folder
// or a file, a uid, denials, a method — the `storage.decisions` topic's own
// parameters), `flips`, `pick` and `line`. So "See why" on the Files page,
// a log line's decision and Auth's "Read by your rules · line 12" are links.

import type { z } from 'zod'
import { useRouteSearch } from '@/lib/search-params'
import { rulesPageSearch } from '@/rules/search'

export const storageRulesSearch = rulesPageSearch('bucket', {
  panel: ['decisions', 'playground', 'tests', 'folders'],
})

export type StorageRulesSearch = z.infer<typeof storageRulesSearch>

export type StorageRulesPanel = NonNullable<StorageRulesSearch['panel']>

export function useStorageRulesSearch() {
  return useRouteSearch<StorageRulesSearch>('/storage_/rules', '/storage/rules')
}
