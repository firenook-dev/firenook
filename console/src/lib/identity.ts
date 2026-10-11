// Who a request runs as. The engine evaluates rules for every call, so
// reading as a user shows exactly what that user's app would get, including
// the denial and the rule line that decided it. Firestore's "view as" was
// the first to need it; Storage's "As" and compute's "Call as" read the same
// identities, so it lives here and `firestore/view-as.ts` re-exports it.

export type ViewAs =
  | { kind: 'owner' }
  | { kind: 'anonymous' }
  /** An existing Auth record; `tenant` absent for the project's own users. */
  | {
      kind: 'user'
      uid: string
      tenant?: string | undefined
      email?: string | undefined
      claims?: Record<string, unknown> | undefined
    }
  /**
   * Any identity, no Auth record needed: "a user with admin: true" for a
   * claims rule or a callable. Minted here, so it works without Auth running.
   */
  | {
      kind: 'custom'
      uid: string
      claims: Record<string, unknown>
      signInProvider?: string | undefined
      emailVerified?: boolean | undefined
      email?: string | undefined
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
  identity: Extract<ViewAs, { kind: 'user' | 'custom' }>,
  project: string,
): string {
  const now = Math.floor(Date.now() / 1000)
  const email = identity.email
  const provider =
    identity.kind === 'custom'
      ? (identity.signInProvider ?? (email ? 'password' : 'custom'))
      : email
        ? 'password'
        : 'custom'
  // An Auth user's email is verified as far as rules can tell, as before; a
  // custom identity says so itself, and is unverified unless it does.
  const verified =
    identity.kind === 'custom'
      ? (identity.emailVerified ?? (email ? false : undefined))
      : email
        ? true
        : undefined
  const firebase: Record<string, unknown> = {
    identities: email ? { email: [email] } : {},
    sign_in_provider: provider,
  }
  if (identity.kind === 'user' && identity.tenant) firebase.tenant = identity.tenant
  const payload: Record<string, unknown> = {
    iss: `https://securetoken.google.com/${project}`,
    aud: project,
    auth_time: now,
    sub: identity.uid,
    user_id: identity.uid,
    iat: now,
    exp: now + 3600,
    firebase,
    ...(email ? { email } : {}),
    ...(email || verified !== undefined ? { email_verified: verified ?? false } : {}),
    ...identity.claims,
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

function fromBase64url(text: string): string {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

const CUSTOM_PREFIX = 'custom.'

/**
 * A uid as it sits in `?as=`: `%`, `:` and `|` percent-escaped, and a uid
 * that would read as one of the other forms — `owner`, `anonymous`, or one
 * starting `custom.` — with its first letter escaped, so every uid there is
 * survives the round trip.
 */
function escapeUid(uid: string): string {
  const escaped = uid.replace(/%/g, '%25').replace(/:/g, '%3A').replace(/\|/g, '%7C')
  if (escaped === 'owner' || escaped === 'anonymous' || escaped.startsWith(CUSTOM_PREFIX))
    return `%${escaped.charCodeAt(0).toString(16).toUpperCase()}${escaped.slice(1)}`
  return escaped
}

/**
 * Only the escapes `escapeUid` writes are undone, so an older link whose
 * uid happened to hold some other `%` sequence reads exactly as it did.
 */
function unescapeUid(text: string): string {
  const first = /^%(6F|61|63)/i.test(text)
    ? String.fromCharCode(Number.parseInt(text.slice(1, 3), 16)) + text.slice(3)
    : text
  return first.replace(/%(25|3A|7C)/gi, (escape) =>
    String.fromCharCode(Number.parseInt(escape.slice(1), 16)),
  )
}

function escapeTenant(tenant: string): string {
  return tenant.replace(/%/g, '%25').replace(/\|/g, '%7C')
}

function unescapeTenant(text: string): string {
  return text.replace(/%(25|7C)/gi, (escape) =>
    String.fromCharCode(Number.parseInt(escape.slice(1), 16)),
  )
}

/**
 * The URL-safe form kept in the `as` search param: absent for the owner,
 * `anonymous`, `[<tenant>|]<uid>[:<email>]` for an Auth user and
 * `custom.<base64url JSON>` for a custom identity.
 */
export function serializeViewAs(viewAs: ViewAs): string | undefined {
  if (viewAs.kind === 'owner') return undefined
  if (viewAs.kind === 'anonymous') return 'anonymous'
  if (viewAs.kind === 'custom') {
    const body: Record<string, unknown> = { uid: viewAs.uid, claims: viewAs.claims }
    if (viewAs.signInProvider !== undefined) body.signInProvider = viewAs.signInProvider
    if (viewAs.emailVerified !== undefined) body.emailVerified = viewAs.emailVerified
    if (viewAs.email !== undefined) body.email = viewAs.email
    return `${CUSTOM_PREFIX}${base64url(JSON.stringify(body))}`
  }
  const tenant = viewAs.tenant ? `${escapeTenant(viewAs.tenant)}|` : ''
  const uid = escapeUid(viewAs.uid)
  return viewAs.email ? `${tenant}${uid}:${viewAs.email}` : `${tenant}${uid}`
}

/** Reads `?as=`; anything it cannot read is the owner, which is what an absent param means. */
export function parseViewAs(raw: string | undefined): ViewAs {
  if (!raw || raw === 'owner') return { kind: 'owner' }
  if (raw === 'anonymous') return { kind: 'anonymous' }
  if (raw.startsWith(CUSTOM_PREFIX)) {
    const custom = parseCustom(raw.slice(CUSTOM_PREFIX.length))
    // An older link to a user whose uid starts `custom.` still opens that user.
    if (custom) return custom
  }
  const bar = raw.indexOf('|')
  const tenant = bar === -1 ? undefined : unescapeTenant(raw.slice(0, bar))
  const rest = bar === -1 ? raw : raw.slice(bar + 1)
  const colon = rest.indexOf(':')
  const uid = unescapeUid(colon === -1 ? rest : rest.slice(0, colon))
  const email = colon === -1 ? undefined : rest.slice(colon + 1)
  const user: Extract<ViewAs, { kind: 'user' }> = { kind: 'user', uid }
  if (tenant) user.tenant = tenant
  if (email) user.email = email
  return user
}

function parseCustom(encoded: string): Extract<ViewAs, { kind: 'custom' }> | undefined {
  let body: unknown
  try {
    body = JSON.parse(fromBase64url(encoded))
  } catch {
    return undefined
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined
  const { uid, claims, signInProvider, emailVerified, email } = body as Record<string, unknown>
  if (typeof uid !== 'string' || uid === '') return undefined
  const custom: Extract<ViewAs, { kind: 'custom' }> = {
    kind: 'custom',
    uid,
    claims:
      claims && typeof claims === 'object' && !Array.isArray(claims)
        ? (claims as Record<string, unknown>)
        : {},
  }
  if (typeof signInProvider === 'string') custom.signInProvider = signInProvider
  if (typeof emailVerified === 'boolean') custom.emailVerified = emailVerified
  if (typeof email === 'string') custom.email = email
  return custom
}

export function describeViewAs(viewAs: ViewAs): string {
  if (viewAs.kind === 'owner') return 'Admin (bypasses rules)'
  if (viewAs.kind === 'anonymous') return 'Anonymous'
  if (viewAs.kind === 'custom') return `${viewAs.email ?? viewAs.uid} (custom)`
  const name = viewAs.email ?? viewAs.uid
  return viewAs.tenant ? `${name} · ${viewAs.tenant}` : name
}

/** The same, without the qualifier a narrow toolbar has no room for. */
export function describeViewAsShort(viewAs: ViewAs): string {
  if (viewAs.kind === 'owner') return 'Admin'
  if (viewAs.kind === 'custom') return viewAs.email ?? viewAs.uid
  if (viewAs.kind === 'user') return viewAs.email ?? viewAs.uid
  return describeViewAs(viewAs)
}
