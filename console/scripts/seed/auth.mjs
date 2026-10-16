// The Authentication seeder: the seed people (`SEED_USERS`) as Auth users,
// so every profile that runs Auth has the same three to sign in as and
// view data as, plus — for the Authentication journeys and for console
// development — a project of users of every kind, a tenant, and a few
// codes and failed calls so the Inbox and Activity are not empty.
//
// Deterministic (a fixed xorshift seed) and idempotent: users are written
// with `accounts:batchCreate` and `allowOverwrite`, the tenant's 409 is
// fine. Everything goes through the console's Auth mount as the owner, as
// the console itself does. The auth stream owns this file.
//
// Domains: seed users `example.test`, sample users `sample.test`, journey
// users `journey.test`, the blocking fixtures `blocked.test` and
// `claims.test`. The three `SEED_USERS` people are never created under
// other uids, and the `admin: true` claim goes to a user of this seeder's
// own, never to one of them.

import { fileURLToPath } from 'node:url'
import { SEED_USERS, ensureSeedUsers } from './identities.mjs'

/** The tenant the seed creates, with what its journeys read. */
export const SEED_TENANT = Object.freeze({
  tenantId: 'acme',
  displayName: 'Acme Corp',
  mfaState: 'ENABLED',
  mfaProviders: ['PHONE_SMS'],
  allowPasswordSignup: true,
  enableEmailLinkSignin: true,
  enableAnonymousUser: true,
  disableAuth: false,
})

/** The seeded MFA user (verified email, one SMS factor). */
export const SEED_MFA_USER = Object.freeze({
  uid: 'mfa-ada',
  email: 'mfa-ada@example.test',
  password: 'password-1',
  phone: '+15550199',
})

/** The user holding `{"admin": true}`. */
export const SEED_ADMIN = Object.freeze({
  uid: 'admin-1',
  email: 'admin@example.test',
  password: 'password-1',
})

/** The fixed time the seed's dates count back from (the Firestore seed's day). */
const NOW = Date.UTC(2026, 8, 20, 9)
const DAY = 86_400_000

const ADMIN = { authorization: 'Bearer owner', 'content-type': 'application/json' }
const CLIENT = { 'content-type': 'application/json' }

let state = 0x5eed_a17
function random() {
  state ^= state << 13
  state ^= state >>> 17
  state ^= state << 5
  return ((state >>> 0) % 1_000_000) / 1_000_000
}
const pick = (items) => items[Math.floor(random() * items.length)]

const FIRST = ['Margaret', 'Dennis', 'Barbara', 'Ken', 'Radia', 'Tim', 'Frances', 'Edsger']
const LAST = ['Hamilton', 'Ritchie', 'Liskov', 'Thompson', 'Perlman', 'Berners-Lee', 'Allen']
const PLANS = ['free', 'pro', 'team']
const ROLES = ['editor', 'viewer', 'owner']

/** A long but valid claims object, about 900 characters as compact JSON. */
function longClaims() {
  const claims = { role: 'auditor', regions: [] }
  let index = 0
  while (JSON.stringify(claims).length < 880) {
    claims.regions.push(`region-${String(index).padStart(3, '0')}`)
    index += 1
  }
  return claims
}

/** Created and last signed in within the 60 days before NOW; or never signed in. */
function times(signedInEver = true) {
  const created = NOW - Math.floor(random() * 60 * DAY)
  const signedIn = created + Math.floor(random() * (NOW - created))
  return signedInEver
    ? { createdAt: String(created), lastLoginAt: String(signedIn) }
    : { createdAt: String(created) }
}

/** The project's own users, as `batchCreate` takes them. */
export function projectUsers() {
  state = 0x5eed_a17
  const users = []
  // 25 password users: the first five unverified, two of the rest disabled,
  // two made by an admin and never signed in.
  for (let index = 0; index < 25; index += 1) {
    const first = pick(FIRST)
    const last = pick(LAST)
    const admin = index === 5
    users.push({
      localId: admin ? SEED_ADMIN.uid : `seed-${String(index + 1).padStart(2, '0')}`,
      email: admin
        ? SEED_ADMIN.email
        : `${first.toLowerCase()}.${last.toLowerCase().replace(/[^a-z]/g, '')}${index + 1}@example.test`,
      rawPassword: 'password-1',
      displayName: admin ? 'Seed Admin' : `${first} ${last}`,
      emailVerified: index >= 5,
      disabled: index === 10 || index === 17,
      ...times(index !== 13 && index !== 14),
    })
  }
  // Claims on seven: the admin, roles and plans, and one near the limit.
  const claimed = [
    [5, { admin: true }],
    [6, { role: 'editor', plan: 'pro' }],
    [7, { role: 'viewer' }],
    [8, { plan: 'team' }],
    [9, { role: pick(ROLES), plan: pick(PLANS) }],
    [11, { plan: 'free' }],
    [12, longClaims()],
  ]
  for (const [index, claims] of claimed)
    users[index] = { ...users[index], customAttributes: JSON.stringify(claims) }
  // Phone-only.
  for (let index = 0; index < 5; index += 1)
    users.push({
      localId: `phone-${index + 1}`,
      phoneNumber: `+1555010${index + 1}`,
      ...times(),
    })
  // Federated.
  const federated = [
    ['google.com', 4],
    ['github.com', 2],
    ['apple.com', 1],
  ]
  for (const [provider, count] of federated)
    for (let index = 0; index < count; index += 1) {
      const name = provider.split('.')[0]
      const email = `${name}${index + 1}@example.test`
      users.push({
        localId: `${name}-${index + 1}`,
        email,
        emailVerified: true,
        displayName: `${pick(FIRST)} ${pick(LAST)}`,
        providerUserInfo: [
          { providerId: provider, rawId: `${name}-raw-${index + 1}`, email, federatedId: email },
        ],
        ...times(),
      })
    }
  // Anonymous: the record a client `signUp {}` makes, with a stable uid.
  for (let index = 0; index < 3; index += 1)
    users.push({ localId: `anon-${index + 1}`, ...times() })
  // The MFA user.
  users.push({
    localId: SEED_MFA_USER.uid,
    email: SEED_MFA_USER.email,
    rawPassword: SEED_MFA_USER.password,
    displayName: 'Ada (two factors)',
    emailVerified: true,
    mfaInfo: [{ phoneInfo: SEED_MFA_USER.phone, displayName: 'Work phone' }],
    ...times(),
  })
  return users
}

/** The tenant's users. */
export function tenantUsers() {
  return Array.from({ length: 5 }, (_, index) => ({
    localId: `acme-${index + 1}`,
    email: `staff${index + 1}@acme.example.test`,
    rawPassword: 'password-1',
    displayName: `Acme staff ${index + 1}`,
    emailVerified: index !== 0,
    ...times(),
  }))
}

/** A refusal the seed asks for on purpose. */
const failed = (status) => status === 400

async function send(url, body, headers, allowed = () => false) {
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
  const text = await response.text()
  if (!response.ok && !allowed(response.status, text))
    throw new Error(`seeding Auth: ${new URL(url).pathname} → ${response.status} ${text}`)
  return text ? JSON.parse(text) : {}
}

/** Whether every seed person is already an Auth user (another seeder made them). */
async function seedUsersExist(engine) {
  for (const user of SEED_USERS) {
    const response = await fetch(
      `${engine.origin}/console/api/v1/auth/user?project=${engine.project}&uid=${user.uid}`,
      { headers: { authorization: 'Bearer owner' } },
    )
    if (!response.ok) return false
  }
  return true
}

/** @param {{ origin: string, project: string }} engine */
export async function seed(engine) {
  // Asked only when missing, so Activity holds no refused sign-ups of the seed's own.
  if (!(await seedUsersExist(engine))) await ensureSeedUsers(engine)
  const mount = `${engine.origin}/console/api/v1/auth`
  const toolkit = `${mount}/identitytoolkit.googleapis.com/v1`
  const client = (op) => `${toolkit}/${op}?key=fake-api-key`

  const batch = async (path, users) => {
    const answer = await send(
      `${toolkit}/${path}:batchCreate`,
      { users, allowOverwrite: true },
      ADMIN,
    )
    if (answer.error?.length > 0)
      throw new Error(`seeding Auth: ${path} refused ${JSON.stringify(answer.error)}`)
  }
  const users = projectUsers()
  await batch(`projects/${engine.project}/accounts`, users)

  // The custom-token user: signed in once, as an app's server would.
  await send(
    client('accounts:signInWithCustomToken'),
    { token: JSON.stringify({ uid: 'custom-1' }), returnSecureToken: true },
    CLIENT,
  )

  await send(
    `${engine.origin}/console/api/v1/auth/tenants?project=${engine.project}`,
    SEED_TENANT,
    { ...ADMIN, 'x-firenook-console': '1' },
    (status) => status === 409,
  )
  await batch(`projects/${engine.project}/tenants/${SEED_TENANT.tenantId}/accounts`, tenantUsers())

  // The Inbox: a reset, a verification email, an SMS code (as an app sends
  // them), for the first password user, whose email is not verified.
  const [unverified] = users
  const signedIn = await send(
    client('accounts:signInWithPassword'),
    { email: unverified.email, password: 'password-1', returnSecureToken: true },
    CLIENT,
  )
  await send(
    client('accounts:sendOobCode'),
    { requestType: 'VERIFY_EMAIL', idToken: signedIn.idToken },
    CLIENT,
  )
  await send(
    client('accounts:sendOobCode'),
    { requestType: 'PASSWORD_RESET', email: unverified.email },
    CLIENT,
  )
  await send(client('accounts:sendVerificationCode'), { phoneNumber: '+15550101' }, CLIENT)

  // Activity: two failed sign-ins, so the Errors facet has something.
  await send(
    client('accounts:signInWithPassword'),
    { email: unverified.email, password: 'not-the-password', returnSecureToken: true },
    CLIENT,
    failed,
  )
  await send(
    client('accounts:signInWithPassword'),
    { email: 'nobody@example.test', password: 'password-1', returnSecureToken: true },
    CLIENT,
    failed,
  )
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [origin = 'http://127.0.0.1:34000', project = 'demo-console-auth'] = process.argv.slice(2)
  await seed({ origin, project })
  console.log(`seeded Auth users, tenant ${SEED_TENANT.tenantId}, messages and calls in ${project}`)
}
