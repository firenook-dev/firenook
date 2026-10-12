// A token handed to Inspect a token from elsewhere — the token dialog's
// Inspect, a call's "Inspect this token" — before the panel opens
// (`/auth/activity?panel=inspect`). The panel takes it once. A token is a
// credential, so it never rides in the address.

import { create } from 'zustand'

export const useInspectDraft = create<{ token: string }>(() => ({ token: '' }))

/** Hands `token` to the panel; the caller then opens `/auth/activity?panel=inspect`. */
export function inspectThisToken(token: string): void {
  useInspectDraft.setState({ token })
}

/** The token handed over, once: the panel clears it as it takes it. */
export function takeInspectDraft(): string {
  const handed = useInspectDraft.getState().token
  if (handed) useInspectDraft.setState({ token: '' })
  return handed
}
