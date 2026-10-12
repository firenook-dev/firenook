// The Overview's address: which connection snippet is open (`connect`) and
// which link-openable dialog is (`dialog`). ⌘K actions and other sections'
// "Connect" links land here, so both are search params; nothing runs from
// a link alone — every destructive or long action still needs its own
// button pressed.
//
// The route file imports this (its schema is in the first route's bundle),
// so it holds zod and plain data only.

import { z } from 'zod'

/** The `connect` values, in the order the tabs show them. */
export const CONNECT_PARAMS = [
  'web',
  'flutter',
  'apple',
  'android',
  'node',
  'python',
  'go',
  'java',
  'env',
  'firebase-json',
] as const

export type ConnectParam = (typeof CONNECT_PARAMS)[number]

/** The dialogs a link opens: download a snapshot, save one on the engine's machine, reset data. */
export const OVERVIEW_DIALOGS = ['snapshot', 'save', 'reset'] as const

export type OverviewDialog = (typeof OVERVIEW_DIALOGS)[number]

// A link with a value the page does not know (an older bookmark, a typo)
// opens the page without it rather than failing the route.
export const overviewSearchSchema = z.object({
  connect: z.enum(CONNECT_PARAMS).optional().catch(undefined),
  dialog: z.enum(OVERVIEW_DIALOGS).optional().catch(undefined),
})

export type OverviewSearch = z.infer<typeof overviewSearchSchema>
