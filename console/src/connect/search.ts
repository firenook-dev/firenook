// "Connect your app" is the top bar's, so its address is every page's: the
// root route takes `?connect=<tab>` (`web`, `node`, `env`, … the values of
// `lib/connect-tabs.ts`), which opens the dialog on that tab over whatever
// page is on screen, and closing it drops the parameter. A value the
// console does not know (an older bookmark, a typo) opens nothing rather
// than failing the route.
//
// The root route imports this, so it holds zod and plain data only.

import { z } from 'zod'
import { CONNECT_PARAMS } from '@/lib/connect-tabs'

export const rootSearchSchema = z.object({
  connect: z.enum(CONNECT_PARAMS).optional().catch(undefined),
})

export type RootSearch = z.infer<typeof rootSearchSchema>
