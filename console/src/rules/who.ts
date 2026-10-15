// Who a playground request is from, on either rules page: an identity from
// the console's picker (an anonymous client, an Auth user, a custom
// identity), or, for a request handed over from a recorded decision or a
// refusal, exactly what that request carried.
//
// A user or a custom identity runs as a token minted the way the SDK's
// emulator tokens are (`authorizationFor` on a custom identity with the
// user's uid, email and claims), so a run here, a saved test and the
// exported `@firebase/rules-unit-testing` file all decide alike, Auth record
// or not.

import type { EvaluateAuth } from '@/api/generated/EvaluateAuth'
import { type ViewAs, authorizationFor, describeViewAsShort } from '@/lib/identity'

export type Who =
  /** Picked in the console: an anonymous client, an Auth user or a custom identity. */
  | { kind: 'as'; viewAs: ViewAs }
  /** As a recorded request carried it: `request.auth` exactly, or the header it was sent with. */
  | { kind: 'recorded'; auth: EvaluateAuth | null; authorization?: string | null | undefined }

/** Nobody signed in: where a playground starts. */
export const ANONYMOUS: Who = { kind: 'as', viewAs: { kind: 'anonymous' } }

/**
 * A user or a custom identity as the custom identity whose token is minted
 * here: the uid, the email (a password account, verified, as the Auth
 * emulator's accounts are), the claims, and a tenant user's tenant.
 */
export function customOf(
  viewAs: Extract<ViewAs, { kind: 'user' | 'custom' }>,
): Extract<ViewAs, { kind: 'custom' }> {
  if (viewAs.kind === 'custom') return viewAs
  const email = viewAs.email
  const claims: Record<string, unknown> = { ...viewAs.claims }
  if (viewAs.tenant)
    claims.firebase = {
      identities: email ? { email: [email] } : {},
      sign_in_provider: email ? 'password' : 'custom',
      tenant: viewAs.tenant,
    }
  return {
    kind: 'custom',
    uid: viewAs.uid,
    claims,
    signInProvider: email ? 'password' : 'custom',
    ...(email ? { email, emailVerified: true } : {}),
  }
}

/** What a request carries for `who`: a header, `request.auth` itself, or nothing (not signed in). */
export function credentialsOf(
  who: Who,
  project: string,
):
  | { authorization?: string | undefined; auth?: EvaluateAuth | null | undefined }
  | { error: string } {
  if (who.kind === 'recorded')
    return who.authorization ? { authorization: who.authorization } : { auth: who.auth }
  if (who.viewAs.kind === 'owner')
    return {
      error: 'Admin skips the rules. Ask as a user, an anonymous client or a custom identity.',
    }
  if (who.viewAs.kind === 'anonymous') return { auth: null }
  if (!who.viewAs.uid.trim()) return { error: 'Give the identity a uid.' }
  return { authorization: authorizationFor(customOf(who.viewAs), project) }
}

/**
 * Who an `Authorization` header says is asking: the email or the uid of its
 * ID token (the console's own and the Auth emulator's are both readable
 * JWTs); undefined when it is not one.
 */
export function tokenWho(authorization: string): string | undefined {
  const token = /^(?:Bearer|Firebase)\s+(\S+)$/i.exec(authorization.trim())?.[1]
  const payload = token?.split('.')[1]
  if (!payload) return undefined
  try {
    const padded = payload.replace(/-/g, '+').replace(/_/g, '/')
    const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
    const text = new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)))
    const claims = JSON.parse(text) as Record<string, unknown>
    for (const key of ['email', 'user_id', 'sub'])
      if (typeof claims[key] === 'string' && claims[key] !== '') return claims[key]
  } catch {
    return undefined
  }
  return undefined
}

/** Who a request is from, in a few words. */
export function describeWho(who: Who): string {
  if (who.kind === 'recorded') {
    if (!who.auth)
      return who.authorization
        ? (tokenWho(who.authorization) ?? 'the token it carried')
        : 'not signed in'
    const email = who.auth.token.email
    return typeof email === 'string' ? email : who.auth.uid
  }
  if (who.viewAs.kind === 'anonymous') return 'not signed in'
  return describeViewAsShort(who.viewAs)
}

/** Claims every ID token carries; the rest are what a test passes as token options. */
const TOKEN_CLAIMS = new Set([
  'iss',
  'aud',
  'auth_time',
  'user_id',
  'sub',
  'iat',
  'exp',
  'firebase',
])

/**
 * The `@firebase/rules-unit-testing` context a saved case asks as:
 * unauthenticated, or a uid with its token options (the email, verified,
 * and the claims), so the exported test decides as the playground did.
 */
export function contextCode(who: Who): string {
  if (who.kind === 'recorded') {
    if (!who.auth) return 'env.unauthenticatedContext()'
    const options = Object.fromEntries(
      Object.entries(who.auth.token).filter(([key]) => !TOKEN_CLAIMS.has(key)),
    )
    return `env.authenticatedContext(${JSON.stringify(who.auth.uid)}, ${JSON.stringify(options)})`
  }
  const viewAs = who.viewAs
  if (viewAs.kind === 'anonymous' || viewAs.kind === 'owner') return 'env.unauthenticatedContext()'
  const email = viewAs.email
  const options: Record<string, unknown> = {
    ...(email
      ? {
          email,
          email_verified: viewAs.kind === 'custom' ? (viewAs.emailVerified ?? false) : true,
        }
      : {}),
    ...viewAs.claims,
  }
  return `env.authenticatedContext(${JSON.stringify(viewAs.uid)}, ${JSON.stringify(options)})`
}
