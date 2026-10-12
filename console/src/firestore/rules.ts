// The security rules, as text you can change.
//
// The emulator exists so rules can be got right before they reach
// production, and the loop that takes — edit the file, restart, try again —
// is the slowest part of writing them. Here a change compiles and takes
// effect on the next request, and the Requests feed then shows the line
// that decided it.
//
// Applying and saving are separate on purpose: a change is in force the
// moment it compiles, and reaches the repository only when asked, so trying
// something out never rewrites the file behind you. What every rules page
// shares (the compile error, a diagnostic's place) is the rules kit's
// (`src/rules/text.ts`); this file is Firestore's endpoints.

import { queryOptions } from '@tanstack/react-query'
import { API_BASE } from '@/api/client'
import type { RulesDocument } from '@/api/generated/RulesDocument'
import type { RulesInstalled } from '@/api/generated/RulesInstalled'
import { type RulesDiagnostic, rulesFailure } from '@/rules/text'
import { FS } from './queries'

export type { RulesDiagnostic, RulesDocument, RulesInstalled }

export async function fetchRules(database: string): Promise<RulesDocument> {
  const response = await fetch(
    `${API_BASE}/firestore/rules?database=${encodeURIComponent(database)}`,
    { headers: { accept: 'application/json' } },
  )
  if (!response.ok) throw await rulesFailure(response)
  return (await response.json()) as RulesDocument
}

export async function putRules(
  database: string,
  source: string,
  save: boolean,
): Promise<RulesInstalled> {
  const response = await fetch(`${API_BASE}/firestore/rules`, {
    method: 'PUT',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ database, source, save }),
  })
  if (!response.ok) throw await rulesFailure(response)
  return (await response.json()) as RulesInstalled
}

export const rulesQuery = (database: string) =>
  queryOptions({
    queryKey: [FS, database, 'rules'],
    queryFn: () => fetchRules(database),
    // The rules only change when something changes them, and this console
    // is one of the things that does; it invalidates on its own write.
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  })
