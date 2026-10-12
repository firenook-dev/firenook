// The one set of people every seeder uses, so no profile holds
// ada@example.test under two uids: the uids are the first three the
// Firestore seeder's deterministic generator writes (its users/<uid>
// documents are theirs), and every other seeder that needs a person takes
// one from here.

/** @typedef {{ uid: string, email: string, displayName: string, password: string }} SeedUser */

/** @type {readonly SeedUser[]} */
export const SEED_USERS = Object.freeze([
  {
    uid: 'u_k65eq',
    email: 'ada@example.test',
    displayName: 'Ada Lovelace',
    password: 'password-1',
  },
  {
    uid: 'u_3wc4h',
    email: 'grace@example.test',
    displayName: 'Grace Hopper',
    password: 'password-1',
  },
  {
    uid: 'u_pyudw',
    email: 'linus@example.test',
    displayName: 'Linus Torvalds',
    password: 'password-1',
  },
])

/** Whether the seeders were asked for their large datasets (perf journeys). */
export function largeScale() {
  return process.env.FIRENOOK_SEED_SCALE === 'large'
}

/**
 * Creates the seed people in the Auth emulator through the console's Auth
 * mount; a person who is already there is left as they are.
 * @param {{ origin: string }} engine
 */
export async function ensureSeedUsers(engine) {
  const url = `${engine.origin}/console/api/v1/auth/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key`
  for (const user of SEED_USERS) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { authorization: 'Bearer owner', 'content-type': 'application/json' },
      body: JSON.stringify({
        email: user.email,
        password: user.password,
        displayName: user.displayName,
        localId: user.uid,
        returnSecureToken: true,
      }),
    })
    if (!response.ok) {
      const body = await response.text()
      if (!/EMAIL_EXISTS|DUPLICATE_LOCAL_ID/.test(body))
        throw new Error(`creating ${user.email} → ${response.status} ${body}`)
    }
  }
}
