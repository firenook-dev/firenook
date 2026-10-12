// Sample users: realistic synthetic accounts to fill a project in seconds
// and to leave it as cleanly. Every one lives on `sample.test` with a uid
// that starts `sample-`, so `is:sample` finds exactly them and Delete sample
// users never reaches a real fixture (the seed people are on
// `example.test`). Generated here, deterministically from a seed, as the
// emulator's own export (`accounts.json`), and imported through the
// engine's import: no `user.create` trigger fires, as the emulator's own
// import fires none.

/** The providers a developer can mix in. */
export const SAMPLE_PROVIDERS = [
  'password',
  'phone',
  'google.com',
  'github.com',
  'apple.com',
  'anonymous',
] as const

export type SampleProvider = (typeof SAMPLE_PROVIDERS)[number]

export const SAMPLE_COUNTS = [10, 100, 1_000, 10_000] as const

export interface SampleOptions {
  count: number
  providers: readonly SampleProvider[]
  /** Some disabled, unverified, with MFA and with claims. */
  variety: boolean
  /** One password every password user shares. */
  password: string
  /** Lower-case letters and digits; the same seed makes the same users. */
  seed: string
  /** When the users are made, epoch ms (their creation times spread over the 90 days before). */
  now?: number | undefined
}

/** A seed for a uid: lower-case letters and digits, at most 12. */
export function cleanSeed(seed: string): string {
  return seed
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 12)
}

/** A short random seed, when the developer leaves it empty. */
export function randomSeed(): string {
  return Math.random().toString(36).slice(2, 7)
}

/** xorshift32 over a string's FNV-1a hash: the same seed, the same users. */
function generator(seed: string): () => number {
  let state = 2_166_136_261
  for (const char of seed) {
    state ^= char.charCodeAt(0)
    state = Math.imul(state, 16_777_619) >>> 0
  }
  if (state === 0) state = 0x9e3779b9
  return () => {
    state ^= state << 13
    state >>>= 0
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    return state / 4_294_967_296
  }
}

const FIRST = [
  'Ada',
  'Grace',
  'Alan',
  'Katherine',
  'Edsger',
  'Barbara',
  'Donald',
  'Frances',
  'Hedy',
  'John',
  'Margaret',
  'Radia',
  'Annie',
  'Ken',
  'Dennis',
  'Mary',
  'Claude',
  'Evelyn',
  'Tim',
  'Lynn',
]
const LAST = [
  'Lovelace',
  'Hopper',
  'Turing',
  'Johnson',
  'Dijkstra',
  'Liskov',
  'Knuth',
  'Allen',
  'Lamarr',
  'McCarthy',
  'Hamilton',
  'Perlman',
  'Easley',
  'Thompson',
  'Ritchie',
  'Keller',
  'Shannon',
  'Boyd',
  'Berners',
  'Conway',
]
const ROLES = ['admin', 'editor', 'viewer', 'billing']
const PLANS = ['free', 'pro', 'team']

/** One user in the emulator's export format. */
export type SampleRecord = Record<string, unknown>

const DAY = 86_400_000

/** The users, in the emulator's export format. */
export function sampleUsers(options: SampleOptions): SampleRecord[] {
  const random = generator(options.seed)
  const now = options.now ?? Date.now()
  const providers = options.providers.length > 0 ? options.providers : (['password'] as const)
  const users: SampleRecord[] = []
  const pick = <T>(list: readonly T[]) => list[Math.floor(random() * list.length)] as T
  for (let n = 1; n <= options.count; n += 1) {
    const provider = providers[(n - 1) % providers.length] ?? 'password'
    const first = pick(FIRST)
    const last = pick(LAST)
    const name = `${first} ${last}`
    const email = `${first}.${last}.${n}`.toLowerCase() + '@sample.test'
    const phone = `+1555${String(n).padStart(7, '0')}`
    const created = now - Math.floor(random() * 90 * DAY)
    const signedIn = random() < 0.8 ? created + Math.floor(random() * (now - created)) : undefined
    const uid = `sample-${options.seed}-${n}`
    const user: SampleRecord = {
      localId: uid,
      createdAt: String(created),
      ...(signedIn === undefined ? {} : { lastLoginAt: String(signedIn) }),
    }
    const unverified = options.variety && n % 4 === 0
    if (provider === 'password') {
      const salt = `fakeSalt${options.seed}${n}`
      Object.assign(user, {
        email,
        emailVerified: !unverified,
        displayName: name,
        passwordHash: `fakeHash:salt=${salt}:password=${options.password}`,
        salt,
        providerUserInfo: [{ providerId: 'password', rawId: email, email, displayName: name }],
      })
    } else if (provider === 'phone') {
      Object.assign(user, {
        phoneNumber: phone,
        providerUserInfo: [{ providerId: 'phone', rawId: phone, phoneNumber: phone }],
      })
    } else if (provider !== 'anonymous') {
      const rawId = String(100_000_000_000 + Math.floor(random() * 899_999_999_999))
      Object.assign(user, {
        email,
        emailVerified: !unverified,
        displayName: name,
        providerUserInfo: [
          { providerId: provider, rawId, federatedId: rawId, email, displayName: name },
        ],
      })
    }
    if (options.variety && provider !== 'anonymous') {
      if (n % 10 === 0) user.disabled = true
      if (n % 7 === 0)
        user.customAttributes = JSON.stringify({ role: pick(ROLES), plan: pick(PLANS) })
      // Firebase enrols a second factor only on a verified email.
      if (n % 15 === 0 && provider !== 'phone' && !unverified)
        user.mfaInfo = [
          {
            mfaEnrollmentId: `sample-mfa-${options.seed}-${n}`,
            phoneInfo: `+1556${String(n).padStart(7, '0')}`,
            displayName: 'Phone',
            enrolledAt: new Date(created).toISOString(),
          },
        ]
    }
    users.push(user)
  }
  return users
}

/** The users as the file the engine imports (`accounts.json`). */
export function sampleFile(users: readonly SampleRecord[]): Blob {
  return new Blob([JSON.stringify({ kind: 'identitytoolkit#DownloadAccountResponse', users })], {
    type: 'application/json',
  })
}
