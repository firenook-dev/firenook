// The Functions pages' search params: every view is a link (compute spec
// §4.3). The route files validate with these schemas; the components read
// and write them through `useRouteSearch`, whose updates drop empty values,
// so a default (`tab=run`, `sort=name:asc`) never appears in the address.
//
// This module sits in the first route with the route tree, so it imports
// zod and the shared search-param helpers only.

import { z } from 'zod'
import { zFlag, zSort } from '@/lib/search-params'

/** The function page's inspector tabs; `run` is the kind's action and the default. */
export const FUNCTION_TABS = ['run', 'trigger', 'environment'] as const
export type FunctionTab = (typeof FUNCTION_TABS)[number]

export const functionsSearch = z.object({
  /** The function open in the workbench, by id (`us-central1-api`). */
  function: z.string().optional(),
  /** The codebase view when no `function`: a codebase id or an extension instance id. */
  codebase: z.string().optional(),
  /** The inspector's tab. `run` is the kind's action: Invoke, Test event, Run, Enqueue or Test. */
  tab: z.enum(FUNCTION_TABS).optional(),
  /** An invocation open in the inspector (replaces the tabs, with Back). */
  invocation: z.string().optional(),
  /** Edit and replay: fills the Run tab's draft from this invocation, then is removed. */
  prefill: z.string().optional(),
  /** The function page's invocation list is paused; written with `replace`. */
  paused: zFlag,
  /**
   * No `function`: the overview filter (`kind:firestore status:ignored`).
   * With `function`: its invocation list's filter, sent as the topic's `q`.
   */
  q: z.string().optional(),
  /** Overview order, `<column>:asc|desc` (client-side: the snapshot holds every function). */
  sort: zSort,
  /** The Run tab's source for a test event: a document path, a uid. */
  source: z.string().optional(),
})

export type FunctionsSearch = z.infer<typeof functionsSearch>

export const invocationsSearch = z.object({
  /** `function:us-central1-api outcome:failed origin:client took:>200ms is:cold words`. */
  q: z.string().optional(),
  /** Open in the inspector. */
  invocation: z.string().optional(),
  paused: zFlag,
})

export type InvocationsSearch = z.infer<typeof invocationsSearch>
