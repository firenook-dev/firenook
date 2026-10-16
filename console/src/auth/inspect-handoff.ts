// A token handed to Inspect a token (Activity's side panel) from elsewhere:
// a call's "Inspect this token", or Sign in as's "View the token…" with
// what the engine said as it minted it. A token is a credential, so it
// never rides in the address: it is handed over in memory, and the panel
// takes it once — at once when it is already open.

import { create } from 'zustand'
import type { AuthMintedToken } from '@/api/generated/auth/AuthMintedToken'

/** What Sign in as minted, said above the verdicts: for whom, and how it differs from a real sign-in. */
export interface MintedNote {
  /** Whom it was minted for: the identifier. */
  who: string
  minted: Pick<
    AuthMintedToken,
    'idToken' | 'provider' | 'secondFactor' | 'expiresAt' | 'beforeSignIn' | 'differences'
  >
}

export interface InspectHandoff {
  token: string
  /** Present when Sign in as minted the token. */
  minted?: MintedNote | undefined
}

export const useInspectHandoff = create<{ handed: InspectHandoff | undefined }>(() => ({
  handed: undefined,
}))

/** Hands a token to the panel; the caller then opens `/auth/activity?panel=inspect`. */
export function handOffToken(token: string, minted?: MintedNote): void {
  useInspectHandoff.setState({ handed: { token, minted } })
}

/** What was handed over since the last take, once. */
export function takeHandedOffToken(): InspectHandoff | undefined {
  const { handed } = useInspectHandoff.getState()
  if (handed) useInspectHandoff.setState({ handed: undefined })
  return handed
}
