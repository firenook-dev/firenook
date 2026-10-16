// What the Authentication pages ask `POST /auth/tokens` for: the
// foundation's `{ uid, tenant? }` (what `resolveAuthorization` sends for
// view as) plus only the optional fields Auth adds — the provider the
// token names, draft claims, the second factor, beforeSignIn — each sent
// only when it is chosen, so the engine's defaults (the account's own
// provider, its first enrolled factor, the stored claims) stand otherwise.
// The answer is read as the foundation's client reads it: `idToken` and
// `expiresAt`, plus what Auth's own surfaces show.

import type { AuthTokenRequest } from '@/api/generated/auth/AuthTokenRequest'

/** The second factor a token carries: the account's default, none, or one enrolled factor. */
export type FactorChoice = 'default' | 'none' | { enrollment: string }

export interface TokenChoice {
  uid: string
  /** The account's tenant; absent for the project's users. */
  tenant?: string | undefined
  /** The provider the token names; the account's own when absent. */
  provider?: string | undefined
  /** Draft claims, in this token only (the claims preview). */
  claims?: Record<string, unknown> | undefined
  secondFactor?: FactorChoice | undefined
  /** Call beforeSignIn as a sign-in would (its side effects happen; the account is not changed). */
  runBeforeSignIn?: boolean | undefined
}

/** The request body: `{ uid, tenant? }` and only the fields chosen. */
export function tokenRequest(choice: TokenChoice): AuthTokenRequest {
  const request: AuthTokenRequest = { uid: choice.uid }
  if (choice.tenant) request.tenant = choice.tenant
  if (choice.provider) request.provider = choice.provider
  if (choice.claims !== undefined) request.claims = choice.claims
  if (choice.secondFactor === 'none') request.secondFactor = { kind: 'none' }
  else if (choice.secondFactor !== undefined && choice.secondFactor !== 'default')
    request.secondFactor = { kind: 'enrollment', id: choice.secondFactor.enrollment }
  if (choice.runBeforeSignIn) request.runBeforeSignIn = true
  return request
}

/** `Authorization: Bearer <token>` as an app sends it. */
export function authorizationHeader(idToken: string): string {
  return `Authorization: Bearer ${idToken}`
}

/** A Firestore REST read as this user, against the emulator's Firestore port. */
export function firestoreCurl(options: {
  idToken: string
  project: string
  firestoreAddress: string
  database?: string | undefined
}): string {
  const database = options.database ?? '(default)'
  const url = `http://${options.firestoreAddress}/v1/projects/${encodeURIComponent(options.project)}/databases/${encodeURIComponent(database)}/documents`
  return [`curl '${url}' \\`, `  -H 'Authorization: Bearer ${options.idToken}'`].join('\n')
}

/** `signInWithCustomToken(getAuth(), '<token>')`, the line to paste into the app's devtools. */
export function customTokenSnippet(customToken: string): string {
  const literal = customToken.replaceAll('\\', '\\\\').replaceAll("'", "\\'")
  return `signInWithCustomToken(getAuth(), '${literal}')`
}
