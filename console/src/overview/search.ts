// The Overview's address: which connection snippet is open (`connect`) and
// which link-openable dialog is (`dialog`). ⌘K actions and other sections'
// "Connect" links land here, so both are search params; nothing runs from
// a link alone — every destructive or long action still needs its own
// button pressed.
//
// The route file imports this (its schema is in the first route's bundle),
// so it holds zod and plain data only (the connect values come from
// `lib/connect-tabs.ts`, the one tab list).

import { z } from 'zod'
import { CONNECT_PARAMS } from '@/lib/connect-tabs'

/** The dialogs a link opens: save a snapshot on the engine's machine, reset data. */
export const OVERVIEW_DIALOGS = ['save', 'reset'] as const

export type OverviewDialog = (typeof OVERVIEW_DIALOGS)[number]

// A link with a value the page does not know (an older bookmark, a typo)
// opens the page without it rather than failing the route.
export const overviewSearchSchema = z.object({
  connect: z.enum(CONNECT_PARAMS).optional().catch(undefined),
  dialog: z.enum(OVERVIEW_DIALOGS).optional().catch(undefined),
})

export type OverviewSearch = z.infer<typeof overviewSearchSchema>
