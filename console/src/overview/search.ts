// The Overview's address: which link-openable dialog is open (`dialog`),
// and the section a reset link names (`section`). ⌘K actions and other
// sections' links land here, so they are search params; nothing runs from
// a link alone — every destructive or long action still needs its own
// button pressed. ("Connect your app" is the top bar's, and its `?connect=`
// every page's: `connect/search.ts`.) Links other sections use:
//
// - `/?dialog=reset&section=<id>` opens the reset confirmation for that
//   section (nothing opens while it cannot be reset);
// - `/?dialog=save` opens "Save a snapshot on the engine's machine".
//
// The route file imports this (its schema is in the first route's bundle),
// so it holds zod and plain data only (the section ids come from the one
// sidebar order).

import { z } from 'zod'
import order from '@/lib/section-order.json'
import type { SectionId } from '@/lib/services'

const SECTION_IDS = order as [SectionId, ...SectionId[]]

/** The dialogs a link opens: save a snapshot on the engine's machine, reset data. */
export const OVERVIEW_DIALOGS = ['save', 'reset'] as const

export type OverviewDialog = (typeof OVERVIEW_DIALOGS)[number]

// A link with a value the page does not know (an older bookmark, a typo)
// opens the page without it rather than failing the route.
export const overviewSearchSchema = z.object({
  dialog: z.enum(OVERVIEW_DIALOGS).optional().catch(undefined),
  section: z.enum(SECTION_IDS).optional().catch(undefined),
})

export type OverviewSearch = z.infer<typeof overviewSearchSchema>
