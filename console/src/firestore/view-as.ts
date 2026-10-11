// "View as": the identity the workbench reads Firestore with. The identity
// itself moved to `lib/identity.ts`, where Storage and Functions read it too;
// what is left here is Firestore's list of Auth users for the picker.

import { API_BASE } from '@/api/client'
import { OWNER_AUTHORIZATION } from '@/lib/identity'

export {
  type ViewAs,
  OWNER_AUTHORIZATION,
  authorizationFor,
  describeViewAs,
  describeViewAsShort,
  mintUnsignedToken,
  parseViewAs,
  serializeViewAs,
} from '@/lib/identity'

export interface AuthUser {
  uid: string
  email?: string | undefined
  displayName?: string | undefined
  disabled: boolean
  /** Custom claims set with the Admin SDK, as they arrive in the user's ID token. */
  claims?: Record<string, unknown> | undefined
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
    userInfo?: Array<{
      localId: string
      email?: string
      displayName?: string
      disabled?: boolean
      customAttributes?: string
    }>
  }
  return (body.userInfo ?? []).map((info) => ({
    uid: info.localId,
    email: info.email,
    displayName: info.displayName,
    disabled: Boolean(info.disabled),
    claims: parseClaims(info.customAttributes),
  }))
}

/** The custom claims the Admin SDK set on a user, which the Auth emulator stores as a JSON string. */
function parseClaims(text: string | undefined): Record<string, unknown> | undefined {
  if (!text) return undefined
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}
