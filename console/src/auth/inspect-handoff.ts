// A token handed to Inspect a token (Activity's side tool) from elsewhere:
// the token dialog's Inspect, an Activity row's "Inspect this token". A
// token does not belong in an address — it is long, and it is a credential
// a shared link would carry — so it is handed over in memory, once.

let pending: string | undefined

/** Hands a token over; the next `takeHandedOffToken` receives it. */
export function handOffToken(token: string): void {
  pending = token
}

/** The token handed over since the last call, once. */
export function takeHandedOffToken(): string | undefined {
  const token = pending
  pending = undefined
  return token
}
