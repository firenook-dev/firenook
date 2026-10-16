// "Call as" and App Check, as the headers they become: `authorization:
// Bearer <token>` and `x-firebase-appcheck: <token>`, shown in the Headers
// list as rows "set by Call as", visible and removable, and carried by Copy
// as. Tokens come from the console's one token path (`resolveAuthorization`):
// an Auth user's is the token the engine mints for that account, a custom
// identity's an unsigned token minted here. "No auth" adds no header and
// asks for nothing, so a handler sees exactly what an app without a session
// sends. A saved draft keeps the identity, never a token.

import { useQuery } from '@tanstack/react-query'
import type { ViewAs } from '@/lib/identity'
import { identityKey, resolveAuthorization, userTokenQuery } from '@/lib/identity'
import { queryClient } from '@/lib/query'
import { appCheckToken } from './callable'

/** The App Check choice: none, or a token for an app id. */
export type AppCheckChoice = { kind: 'none' } | { kind: 'app'; appId: string }

/** A header the console adds for "Call as" or App Check. */
export interface IdentityHeader {
  name: 'authorization' | 'x-firebase-appcheck'
  value: string
  /** What set it, for the row's label. */
  setBy: 'Call as' | 'App Check'
}

/**
 * The identity "Call as" means: the owner is "No auth", and an anonymous
 * caller is a signed-in anonymous user (an unsigned token whose provider is
 * `anonymous`), which is what a callable's `auth` holds for one.
 */
export function callingIdentity(viewAs: ViewAs): ViewAs | undefined {
  if (viewAs.kind === 'owner') return undefined
  if (viewAs.kind === 'anonymous')
    return { kind: 'custom', uid: 'anonymous-caller', claims: {}, signInProvider: 'anonymous' }
  return viewAs
}

/** The headers "Call as" and App Check add, resolved now (an Auth user's token from the engine). */
export async function identityHeaders(
  viewAs: ViewAs,
  appCheck: AppCheckChoice,
  project: string,
  signal?: AbortSignal,
): Promise<IdentityHeader[]> {
  const headers: IdentityHeader[] = []
  const identity = callingIdentity(viewAs)
  if (identity) {
    const authorization = await resolveAuthorization(identity, project, signal)
    if (authorization)
      headers.push({ name: 'authorization', value: authorization, setBy: 'Call as' })
  }
  if (appCheck.kind === 'app' && appCheck.appId.trim() !== '')
    headers.push({
      name: 'x-firebase-appcheck',
      value: appCheckToken(appCheck.appId, project),
      setBy: 'App Check',
    })
  return headers
}

/** Whether the engine could not mint a token for this user (the picker says "Not an Auth user"). */
export function isSynthetic(viewAs: ViewAs, project: string): boolean {
  if (viewAs.kind !== 'user') return false
  return queryClient.getQueryData(userTokenQuery(viewAs, project).queryKey)?.synthetic === true
}

/** A token shown in a header row: its ends, the middle left out. */
export function maskToken(value: string): string {
  const token = value.replace(/^Bearer\s+/i, '')
  const prefix = value.length - token.length > 0 ? value.slice(0, value.length - token.length) : ''
  if (token.length <= 24) return value
  return `${prefix}${token.slice(0, 12)}…${token.slice(-6)}`
}

/** Call as's and App Check's headers, resolved for display and Copy as (an Auth user's token from the engine). */
export function useIdentityHeaders(viewAs: ViewAs, appCheck: AppCheckChoice, project: string) {
  return useQuery({
    queryKey: ['functions', project, 'identity-headers', identityKey(viewAs), appCheck],
    queryFn: ({ signal }) => identityHeaders(viewAs, appCheck, project, signal),
    enabled: project !== '',
    staleTime: 60_000,
    retry: false,
  })
}
