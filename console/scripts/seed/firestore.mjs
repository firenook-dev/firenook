// Seeds a synthetic project with data that exercises every Firestore value
// type, sparse fields, subcollections and a missing ancestor document, plus
// the seed people (`SEED_USERS`) as Auth users to view the data as. Console
// development and the browser journeys use it; nothing here is real.
//
//   npm run seed -- http://127.0.0.1:34000 demo-console-synthetic
//
// The origin is the console's UI origin: writes go through the console's
// same-origin Firestore and Auth mounts, exactly as the workbench does.
// FIRENOOK_SEED_SCALE=large adds 20,000 documents under `bulk` for the
// perf journeys.

import { fileURLToPath } from 'node:url'
import { SEED_USERS, ensureSeedUsers, largeScale } from './identities.mjs'

const headers = { authorization: 'Bearer owner', 'content-type': 'application/json' }

// A tiny deterministic generator so every run seeds the same project.
let state = 0x2f6b7d
function random() {
  state ^= state << 13
  state ^= state >>> 17
  state ^= state << 5
  return ((state >>> 0) % 1_000_000) / 1_000_000
}
const pick = (items) => items[Math.floor(random() * items.length)]
const int = (min, max) => min + Math.floor(random() * (max - min + 1))
const id = (prefix) =>
  `${prefix}_${Array.from({ length: 5 }, () => pick('abcdefghijkmnpqrstuvwxyz23456789'.split(''))).join('')}`
const iso = (daysAgo, jitterHours = 12) =>
  new Date(
    Date.UTC(2026, 8, 20, 9) - daysAgo * 86_400_000 - random() * jitterHours * 3_600_000,
  ).toISOString()

const FIRST = [
  'Ada',
  'Grace',
  'Linus',
  'Margaret',
  'Dennis',
  'Barbara',
  'Ken',
  'Radia',
  'Tim',
  'Frances',
]
const LAST = [
  'Lovelace',
  'Hopper',
  'Torvalds',
  'Hamilton',
  'Ritchie',
  'Liskov',
  'Thompson',
  'Perlman',
]
const CITIES = [
  ['Kuala Lumpur', 'MY', 3.139, 101.6869],
  ['Lisbon', 'PT', 38.7223, -9.1393],
  ['Toronto', 'CA', 43.6532, -79.3832],
  ['Nairobi', 'KE', -1.2921, 36.8219],
  ['Osaka', 'JP', 34.6937, 135.5023],
]
const TAGS = ['beta', 'newsletter', 'vip', 'churn-risk', 'mobile', 'web', 'trial']
const STATUSES = ['paid', 'paid', 'paid', 'pending', 'refunded', 'failed']
const PRODUCTS = [
  'Kettle',
  'Notebook',
  'Desk lamp',
  'Headphones',
  'Plant pot',
  'Mug',
  'Backpack',
  'Pen set',
]

/**
 * Seeds `project` through the console mount at `origin`.
 * @param {string} origin
 * @param {string} project
 * @param {string} [database]
 * @returns {Promise<{ documents: number, users: Array<{ uid: string, email: string }> }>}
 */
export async function seedFirestore(origin, project, database = '(default)') {
  state = 0x2f6b7d
  const root = `projects/${project}/databases/${database}/documents`
  const documents = `${origin}/console/api/v1/firestore/v1/${root}`

  const v = {
    s: (stringValue) => ({ stringValue }),
    i: (n) => ({ integerValue: String(n) }),
    d: (doubleValue) => ({ doubleValue }),
    b: (booleanValue) => ({ booleanValue }),
    t: (timestampValue) => ({ timestampValue }),
    n: () => ({ nullValue: null }),
    ref: (path) => ({
      referenceValue: `projects/${project}/databases/${database}/documents/${path}`,
    }),
    geo: (latitude, longitude) => ({ geoPointValue: { latitude, longitude } }),
    bytes: (text) => ({ bytesValue: Buffer.from(text).toString('base64') }),
    arr: (values) => ({ arrayValue: { values } }),
    map: (fields) => ({ mapValue: { fields } }),
  }

  const writes = []
  const set = (path, fields) => writes.push({ update: { name: `${root}/${path}`, fields } })

  const userIds = []
  for (let index = 0; index < 240; index += 1) {
    const uid = id('u')
    userIds.push(uid)
    const [city, country, lat, lng] = pick(CITIES)
    const first = pick(FIRST)
    const last = pick(LAST)
    const fields = {
      displayName: v.s(`${first} ${last}`),
      email: v.s(`${first.toLowerCase()}.${last.toLowerCase()}${index}@example.test`),
      plan: v.s(pick(['free', 'free', 'pro', 'team'])),
      signUpAt: v.t(iso(int(1, 400))),
      lastSeen: v.t(iso(int(0, 30), 24)),
      loginCount: v.i(int(0, 900)),
      balance: v.d(Number((random() * 500).toFixed(2))),
      verified: v.b(random() > 0.3),
      tags: v.arr(Array.from({ length: int(0, 3) }, () => v.s(pick(TAGS)))),
      address: v.map({ city: v.s(city), country: v.s(country), geo: v.geo(lat, lng) }),
      settings: v.map({
        theme: v.s(pick(['light', 'dark', 'system'])),
        digest: v.b(random() > 0.5),
        limits: v.map({ projects: v.i(int(3, 50)) }),
      }),
    }
    if (index > 0 && random() > 0.6) fields.referrer = v.ref(`users/${pick(userIds)}`)
    if (random() > 0.7)
      fields.bio = random() > 0.5 ? v.s('Builds things. Breaks things. Fixes things.') : v.n()
    if (index % 40 === 0) fields.avatar = v.bytes(`png:${uid}`)
    set(`users/${uid}`, fields)
  }

  // The seed people are the generator's first three users; a change to
  // the generator that moved them would split every profile's people.
  for (const [index, user] of SEED_USERS.entries())
    if (userIds[index] !== user.uid)
      throw new Error(
        `The Firestore seeder's user ${index} is ${userIds[index]}, but SEED_USERS says ${user.uid}; keep scripts/seed/identities.mjs and the generator in step.`,
      )
  const ada = userIds[0]
  set(`users/${ada}`, {
    displayName: v.s('Ada Lovelace'),
    email: v.s('ada@example.test'),
    plan: v.s('pro'),
    signUpAt: v.t('2026-01-12T08:15:00Z'),
    lastSeen: v.t(iso(0, 2)),
    loginCount: v.i(412),
    balance: v.d(128.5),
    verified: v.b(true),
    tags: v.arr([v.s('vip'), v.s('beta')]),
    address: v.map({ city: v.s('London'), country: v.s('GB'), geo: v.geo(51.5074, -0.1278) }),
    settings: v.map({
      theme: v.s('dark'),
      digest: v.b(true),
      limits: v.map({ projects: v.i(50) }),
    }),
    bio: v.s('The first programmer.'),
  })

  // Every third user has orders, and every order has its items as a
  // subcollection of its own: three levels, users/{u}/orders/{o}/items/{i},
  // so the tree is worth walking. The first user always has a session too.
  for (const [position, uid] of userIds.entries()) {
    if (position % 3 !== 0) continue
    for (let index = 0; index < int(2, 8); index += 1) {
      const oid = id('o')
      let total = 0
      const itemCount = int(1, 4)
      for (let item = 0; item < itemCount; item += 1) {
        const qty = int(1, 3)
        const price = Number((random() * 80 + 4).toFixed(2))
        total += qty * price
        set(`users/${uid}/orders/${oid}/items/${id('it')}`, {
          sku: v.s(id('sku')),
          name: v.s(pick(PRODUCTS)),
          qty: v.i(qty),
          price: v.d(price),
        })
      }
      const fields = {
        status: v.s(pick(STATUSES)),
        total: v.d(Number(total.toFixed(2))),
        currency: v.s(pick(['USD', 'EUR', 'MYR'])),
        itemCount: v.i(itemCount),
        createdAt: v.t(iso(int(0, 120))),
        customer: v.ref(`users/${uid}`),
        shipping: v.map({
          method: v.s(pick(['standard', 'express'])),
          tracked: v.b(random() > 0.4),
        }),
      }
      if (random() > 0.75)
        fields.note = v.s(pick(['Gift wrap please', 'Leave at door', 'Call on arrival']))
      set(`users/${uid}/orders/${oid}`, fields)
    }
    for (let index = 0; index < (position === 0 ? 2 : int(0, 3)); index += 1) {
      set(`users/${uid}/sessions/${id('s')}`, {
        startedAt: v.t(iso(int(0, 10), 24)),
        device: v.s(pick(['ios', 'android', 'web'])),
        pages: v.i(int(1, 40)),
      })
    }
  }

  for (let index = 0; index < 60; index += 1) {
    const pid = id('p')
    set(`products/${pid}`, {
      name: v.s(`${pick(PRODUCTS)} ${pick(['Classic', 'Mini', 'Pro', 'XL'])}`),
      price: v.d(Number((random() * 120 + 3).toFixed(2))),
      stock: v.i(int(0, 500)),
      categories: v.arr(
        Array.from({ length: int(1, 3) }, () =>
          v.s(pick(['home', 'office', 'audio', 'garden', 'travel'])),
        ),
      ),
      dimensions: v.map({
        w: v.d(Number((random() * 40).toFixed(1))),
        h: v.d(Number((random() * 40).toFixed(1))),
        unit: v.s('cm'),
      }),
      published: v.b(random() > 0.2),
      createdAt: v.t(iso(int(1, 300))),
    })
    // Every fourth product carries reviews.
    if (index % 4 === 0)
      for (let review = 0; review < int(1, 5); review += 1)
        set(`products/${pid}/reviews/${id('r')}`, {
          rating: v.i(int(1, 5)),
          author: v.ref(`users/${pick(userIds)}`),
          body: v.s(
            pick(['Solid.', 'Broke in a week.', 'Exactly as pictured.', 'Would buy again.']),
          ),
          postedAt: v.t(iso(int(0, 200))),
        })
  }

  // The classic bug: the same field as a timestamp in some documents and a
  // string in others. The grid's type badges are meant to make it obvious.
  for (let index = 0; index < 40; index += 1) {
    const timestamp = iso(int(0, 5), 24)
    set(`events/${id('ev')}`, {
      type: v.s(pick(['project.created', 'export.finished', 'user.signed_in', 'payment.failed'])),
      createdAt: index % 5 === 0 ? v.s(timestamp) : v.t(timestamp),
      actor: v.ref(`users/${pick(userIds)}`),
      payload: v.map({ size: v.i(int(1, 9000)), ok: v.b(random() > 0.1) }),
    })
  }

  // A subcollection under a document that does not exist.
  set('teams/t_ghost/members/m_1', { role: v.s('owner'), user: v.ref(`users/${ada}`) })
  set('teams/t_ghost/members/m_2', { role: v.s('editor'), user: v.ref(`users/${userIds[1]}`) })
  set('teams/t_real', { name: v.s('Design'), seats: v.i(5) })
  set('teams/t_real/members/m_1', { role: v.s('owner'), user: v.ref(`users/${userIds[2]}`) })
  // Channels with messages: three levels under a real root document.
  for (const channel of ['general', 'design']) {
    set(`teams/t_real/channels/${channel}`, { topic: v.s(`#${channel}`), archived: v.b(false) })
    for (let index = 0; index < int(3, 8); index += 1)
      set(`teams/t_real/channels/${channel}/messages/${id('m')}`, {
        from: v.ref(`users/${pick(userIds.slice(0, 6))}`),
        text: v.s(pick(['Shipping Friday.', 'Can someone review #42?', 'Lunch?', 'Done.'])),
        sentAt: v.t(iso(int(0, 3), 24)),
        reactions: v.map({ '👍': v.i(int(0, 3)) }),
      })
  }

  // The perf journeys' long list: one collection deep enough to scroll
  // through fifty pages and more.
  if (largeScale())
    for (let index = 0; index < LARGE_DOCUMENTS; index += 1)
      set(`bulk/b${String(index).padStart(6, '0')}`, {
        index: v.i(index),
        label: v.s(`${pick(PRODUCTS)} ${index}`),
        createdAt: v.t(iso(index % 365)),
      })

  async function post(url, body) {
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
    if (!response.ok) throw new Error(`${url} → ${response.status} ${await response.text()}`)
    return response.json()
  }

  for (let index = 0; index < writes.length; index += 200) {
    await post(`${documents}:commit`, { writes: writes.slice(index, index + 200) })
  }

  await ensureSeedUsers({ origin })
  return {
    documents: writes.length,
    users: SEED_USERS.map(({ uid, email }) => ({ uid, email })),
  }
}

/** The documents `bulk` holds at the large scale. */
const LARGE_DOCUMENTS = 20_000

/**
 * The profile seeder's entry: the engine's project, through its console.
 * @param {{ origin: string, project: string }} engine
 */
export async function seed(engine) {
  await seedFirestore(engine.origin, engine.project)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [origin = 'http://127.0.0.1:34000', project = 'demo-console-synthetic', database] =
    process.argv.slice(2)
  const result = await seedFirestore(origin, project, database)
  console.log(
    `wrote ${result.documents} documents to ${project}; ensured ${result.users.length} Auth users`,
  )
}
