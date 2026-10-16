// Sample users: realistic synthetic accounts to fill a project in seconds
// and to leave it as cleanly. Every one is marked as a sample: it lives on
// `sample.test` with a uid that starts `sample-`, so `is:sample` finds
// exactly them and Delete sample users never reaches a real fixture (the
// seed people are on `example.test`). One mix, so a list has something to
// filter: email and password, phone and Google accounts in equal shares,
// some disabled, unverified, with a second factor or with claims, every
// password user signing in with SAMPLE_PASSWORD. Generated here from a
// seed as the emulator's own export (`accounts.json`), and imported through
// the engine's import: no `user.create` trigger fires, as the emulator's
// own import fires none. At most 1,000 at a time.

/** The sign-in providers of the mix, in equal shares. */
const SAMPLE_PROVIDERS = ['password', 'phone', 'google.com'] as const

type SampleProvider = (typeof SAMPLE_PROVIDERS)[number]

export const SAMPLE_COUNTS = [10, 100, 1_000] as const

/** The password every sample password user shares. */
export const SAMPLE_PASSWORD = 'password-1'

export interface SampleOptions {
  count: number
  /** Lower-case letters and digits; the same seed makes the same users. */
  seed: string
  /** When the users are made, epoch ms (their creation times spread over the 90 days before). */
  now?: number | undefined
}

/** A short random seed: each batch's uids differ from the last one's. */
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
  const users: SampleRecord[] = []
  const pick = <T>(list: readonly T[]) => list[Math.floor(random() * list.length)] as T
  for (let n = 1; n <= options.count; n += 1) {
    const provider: SampleProvider =
      SAMPLE_PROVIDERS[(n - 1) % SAMPLE_PROVIDERS.length] ?? 'password'
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
    const unverified = n % 4 === 0
    if (provider === 'password') {
      const salt = `fakeSalt${options.seed}${n}`
      Object.assign(user, {
        email,
        emailVerified: !unverified,
        displayName: name,
        passwordHash: `fakeHash:salt=${salt}:password=${SAMPLE_PASSWORD}`,
        salt,
        providerUserInfo: [{ providerId: 'password', rawId: email, email, displayName: name }],
      })
    } else if (provider === 'phone') {
      Object.assign(user, {
        phoneNumber: phone,
        providerUserInfo: [{ providerId: 'phone', rawId: phone, phoneNumber: phone }],
      })
    } else {
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
