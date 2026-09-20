// "View as": the identity the workbench reads Firestore with. The engine
// evaluates rules for every call, so viewing as a user shows exactly what
// that user's app would get, including the denial and its rule line.

import { API_BASE } from '@/api/client'

export type ViewAs =
  | { kind: 'owner' }
  | { kind: 'anonymous' }
  | {
      kind: 'user'
      uid: string
      email?: string | undefined
      claims?: Record<string, unknown> | undefined
    }

export const OWNER_AUTHORIZATION = 'Bearer owner'

/** The `Authorization` header for `viewAs`; none for an anonymous client. */
export function authorizationFor(viewAs: ViewAs, project: string): string | undefined {
  if (viewAs.kind === 'owner') return OWNER_AUTHORIZATION
  if (viewAs.kind === 'anonymous') return undefined
  return `Bearer ${mintUnsignedToken(viewAs, project)}`
}

/**
 * The emulator accepts unsigned `alg: none` ID tokens with the claims the
 * Auth emulator would have put in a real one. This is how the Firebase SDKs
 * talk to it too; nothing here works against production.
 */
export function mintUnsignedToken(
  user: Extract<ViewAs, { kind: 'user' }>,
  project: string,
): string {
  const now = Math.floor(Date.now() / 1000)
  const payload: Record<string, unknown> = {
    iss: `https://securetoken.google.com/${project}`,
    aud: project,
    auth_time: now,
    sub: user.uid,
    user_id: user.uid,
    iat: now,
    exp: now + 3600,
    firebase: {
      identities: user.email ? { email: [user.email] } : {},
      sign_in_provider: user.email ? 'password' : 'custom',
    },
    ...(user.email ? { email: user.email, email_verified: true } : {}),
    ...user.claims,
  }
  const header = { alg: 'none', typ: 'JWT' }
  return `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}.`
}

function base64url(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** The URL-safe form kept in the `as` search param. */
export function serializeViewAs(viewAs: ViewAs): string | undefined {
  if (viewAs.kind === 'owner') return undefined
  if (viewAs.kind === 'anonymous') return 'anonymous'
  return viewAs.email ? `${viewAs.uid}:${viewAs.email}` : viewAs.uid
}

export function parseViewAs(raw: string | undefined): ViewAs {
  if (!raw) return { kind: 'owner' }
  if (raw === 'anonymous') return { kind: 'anonymous' }
  const colon = raw.indexOf(':')
  return colon === -1
    ? { kind: 'user', uid: raw }
    : { kind: 'user', uid: raw.slice(0, colon), email: raw.slice(colon + 1) }
}

export function describeViewAs(viewAs: ViewAs): string {
  if (viewAs.kind === 'owner') return 'Admin (bypasses rules)'
  if (viewAs.kind === 'anonymous') return 'Anonymous'
  return viewAs.email ?? viewAs.uid
}

export interface AuthUser {
  uid: string
  email?: string | undefined
  displayName?: string | undefined
  disabled: boolean
}

/** The Auth emulator's users through the console's same-origin mount. */
export async function listAuthUsers(project: string): Promise<AuthUser[]> {
  const response = await fetch(
    `${API_BASE}/auth/identitytoolkit.googleapis.com/v1/projects/${project}/accounts:query`,
    {
      method: 'POST',
      headers: { authorization: OWNER_AUTHORIZATION, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    },
  )
  if (!response.ok) return []
  const body = (await response.json()) as {
    userInfo?: Array<{ localId: string; email?: string; displayName?: string; disabled?: boolean }>
  }
  return (body.userInfo ?? []).map((info) => ({
    uid: info.localId,
    email: info.email,
    displayName: info.displayName,
    disabled: Boolean(info.disabled),
  }))
}
