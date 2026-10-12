// Every view of the Extensions page is a link: the instance open, its tab,
// whether its configuration is being edited, and the overview's filter. The
// defaults never appear in the address (no instance is the overview, the
// overview tab is `view` absent), so a link carries only what differs.

import { z } from 'zod'
import { zFlag } from '@/lib/search-params'

/** The instance's tabs, in the order the page shows them. */
export const INSTANCE_VIEWS = [
  'overview',
  'configuration',
  'functions',
  'events',
  'readme',
] as const

export type InstanceView = (typeof INSTANCE_VIEWS)[number]

export const extensionsSearch = z.object({
  /** The instance open, by id (`greeter`). */
  instance: z.string().optional(),
  /** The instance's main-area tab; absent is `overview`. */
  view: z.enum(INSTANCE_VIEWS).optional(),
  /** Configuration in edit mode. */
  edit: zFlag,
  /** The overview's filter: words matched against every instance's names, source and version. */
  q: z.string().optional(),
})

export type ExtensionsSearch = z.infer<typeof extensionsSearch>

/** The tab a search names: `overview` when it names none. */
export function viewOf(search: ExtensionsSearch): InstanceView {
  return search.view ?? 'overview'
}

/**
 * What to write for a tab: nothing for the default, and leaving the
 * Configuration tab ends its edit mode, so a link never opens an editor on
 * a tab that cannot show it.
 */
export function viewPatch(view: InstanceView): Partial<ExtensionsSearch> {
  return {
    view: view === 'overview' ? undefined : view,
    ...(view === 'configuration' ? {} : { edit: undefined }),
  }
}
