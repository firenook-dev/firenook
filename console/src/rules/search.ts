// The one search schema of a rules page, shared by Firestore's (`db`) and
// Storage's (`bucket`), so a link into either reads the same and another
// section can build one ("Read by your rules · line 12") without knowing
// which page it lands on:
//
// - the scope (`db` or `bucket`) and the side `panel`;
// - `decision`, the decision open in the panel;
// - how the decisions are narrowed: `path` (a prefix, or for Storage a
//   folder ending in `/` or one exact name), `uid`, `denied`, `method`;
// - `flips`, only what the draft in the editor would turn around;
// - `pick`, open the newest matching denial once, then forget it;
// - `line`, a line to reveal and mark once.

import { z } from 'zod'
import { zFlag } from '@/lib/search-params'

/** Every operation a rules decision can be about. */
export const RULES_METHODS = ['get', 'list', 'create', 'update', 'delete'] as const

export type RulesPageMethod = (typeof RULES_METHODS)[number]

/** The rules page's schema: its scope param, its panels, and everything the two pages share. */
export function rulesPageSearch<
  const K extends 'db' | 'bucket',
  const P extends readonly [string, ...string[]],
>(scope: K, options: { panel: P }) {
  const scoped = { [scope]: z.string().optional() } as Record<K, z.ZodOptional<z.ZodString>>
  return z.object({
    ...scoped,
    // The panel beside the editor; the first is the default and never written.
    panel: z.enum(options.panel).optional(),
    // A decision opened from the list, from a denied read ("See why") or from a link.
    decision: z.string().optional(),
    // Narrowing the decisions.
    path: z.string().optional(),
    uid: z.string().optional(),
    denied: zFlag,
    method: z.enum(RULES_METHODS).optional(),
    // Only the decisions the draft in the editor would turn around.
    flips: zFlag,
    // Open the newest denial the narrowing matches, once, then forget it.
    pick: zFlag,
    // A line of the rules to bring into view and mark, once (the address
    // carries it as text; a link may pass the number).
    line: z.coerce.number().int().min(1).optional(),
  })
}
