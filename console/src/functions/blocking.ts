// A blocking function's call as the Auth emulator makes it: the unsigned
// JWT it posts as `{"data": {"jwt": …}}` (the shape of the official
// emulator's generateBlockingFunctionJwt, which Firenook's Auth emulator
// writes too), and its answer read the way the Auth emulator reads it — an
// error blocks the sign-up, a `userRecord` with an `updateMask` changes the
// account. The JSON fixture beside this file pins the payload; the Auth
// stream's Rust test reads the same file, so the two cannot drift apart.

/** An account as the Auth REST API holds it (the fields the JWT reads). */
export interface BlockingUser {
  localId: string
  email?: string | undefined
  emailVerified?: boolean | undefined
  displayName?: string | undefined
  photoUrl?: string | undefined
  disabled?: boolean | undefined
  phoneNumber?: string | undefined
  /** Custom claims as their JSON text. */
  customAttributes?: string | undefined
  providerUserInfo?:
    | {
        providerId: string
        displayName?: string | undefined
        photoUrl?: string | undefined
        email?: string | undefined
        rawId?: string | undefined
        phoneNumber?: string | undefined
      }[]
    | undefined
  createdAt?: string | undefined
  lastLoginAt?: string | undefined
}

/** Who the Auth emulator would call, and how. */
export interface BlockingTarget {
  /** The function's URL. */
  uri: string
  projectId: string
  tenantId?: string | undefined
}

export interface BlockingInput {
  target: BlockingTarget
  event: 'beforeCreate' | 'beforeSignIn'
  user: BlockingUser
  signInMethod?: string | undefined
  /** Seconds since the epoch; the call's time. */
  iat: number
  /** The call's random id. */
  eventId: string
}

/** The official emulator divides its 60 s millisecond timeout by 100. */
const EXPIRES_IN = 600

/** The JWT's payload, field for field as the Auth emulator writes it. */
export function blockingPayload(input: BlockingInput): Record<string, unknown> {
  const { user, target } = input
  const record: Record<string, unknown> = {}
  const set = (key: string, value: unknown) => {
    if (value !== undefined && value !== null) record[key] = value
  }
  set('uid', user.localId)
  set('email', user.email)
  set('email_verified', user.emailVerified)
  set('display_name', user.displayName)
  set('photo_url', user.photoUrl)
  set('disabled', user.disabled)
  set('phone_number', user.phoneNumber)
  let claims: unknown = {}
  if (user.customAttributes) {
    try {
      claims = JSON.parse(user.customAttributes) as unknown
    } catch {
      claims = {}
    }
  }
  set('custom_claims', claims)
  if (target.tenantId) record.tenant_id = target.tenantId
  record.provider_data = (user.providerUserInfo ?? []).map((info) => {
    const provider: Record<string, unknown> = {}
    const pairs: [keyof typeof info, string][] = [
      ['providerId', 'provider_id'],
      ['displayName', 'display_name'],
      ['photoUrl', 'photo_url'],
      ['email', 'email'],
      ['rawId', 'uid'],
      ['phoneNumber', 'phone_number'],
    ]
    for (const [source, name] of pairs)
      if (info[source] !== undefined) provider[name] = info[source]
    return provider
  })
  if (user.lastLoginAt || user.createdAt) {
    const metadata: Record<string, unknown> = {}
    const last = Number(user.lastLoginAt)
    const created = Number(user.createdAt)
    if (user.lastLoginAt && Number.isSafeInteger(last)) metadata.last_sign_in_time = last
    if (user.createdAt && Number.isSafeInteger(created)) metadata.creation_time = created
    record.metadata = metadata
  }
  const payload: Record<string, unknown> = {
    iss: `https://securetoken.google.com/${target.projectId}`,
    aud: target.uri,
    iat: input.iat,
    exp: input.iat + EXPIRES_IN,
    event_id: input.eventId,
    event_type: input.event,
    user_agent: 'NotYetSupportedInFirebaseAuthEmulator',
    ip_address: '127.0.0.1',
    locale: 'en',
    user_record: record,
    sub: user.localId,
  }
  if (input.signInMethod) payload.sign_in_method = input.signInMethod
  if (target.tenantId) payload.tenant_id = target.tenantId
  return payload
}

function base64url(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** The payload as the unsigned JWT the Auth emulator sends (`alg: none`). */
export function unsignedJwt(payload: unknown): string {
  return `${base64url('{"alg":"none","typ":"JWT"}')}.${base64url(JSON.stringify(payload))}.`
}

/** The request body the function receives. */
export function blockingBody(input: BlockingInput): string {
  return JSON.stringify({ data: { jwt: unsignedJwt(blockingPayload(input)) } })
}

/** A random id like the Auth emulator's (16 bytes, base64url). */
export function randomEventId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** How the Auth emulator would take the function's answer. */
export type BlockingDecision =
  | { kind: 'allowed'; changes: Record<string, unknown> }
  | { kind: 'blocked'; status: string; message: string }
  | { kind: 'invalid'; message: string }

/** The function's answer read as the Auth emulator reads it (`processBlockingFunctionResponse`). */
export function readBlockingResponse(status: number, text: string): BlockingDecision {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return {
      kind: 'invalid',
      message: `The function answered ${status} with a body that is not JSON.`,
    }
  }
  const fields =
    value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  if (fields.error !== null && typeof fields.error === 'object') {
    const error = fields.error as Record<string, unknown>
    return {
      kind: 'blocked',
      status: typeof error.status === 'string' ? error.status : 'UNKNOWN',
      message: typeof error.message === 'string' ? error.message : '',
    }
  }
  if (status >= 400) return { kind: 'invalid', message: `The function answered ${status}.` }
  const record = fields.userRecord
  if (record === undefined || record === null || record === false)
    return { kind: 'allowed', changes: {} }
  if (typeof record !== 'object')
    return { kind: 'invalid', message: 'The function answered a userRecord that is not an object.' }
  const user = record as Record<string, unknown>
  const mask = typeof user.updateMask === 'string' ? user.updateMask : ''
  if (mask === '') return { kind: 'invalid', message: 'Response UserRecord is missing updateMask.' }
  const changes: Record<string, unknown> = {}
  for (const field of mask.split(','))
    if (field !== '' && field in user) changes[field] = user[field]
  return { kind: 'allowed', changes }
}
