// The observe seeder: what the Logs and Overview journeys need beside the
// other streams' data. Twenty carts, whose deletion runs the observe
// fixture's `onCartDeleted` trigger, and, only when a dedicated engine asks
// for it (`seedBulk`), a large `bulk` collection for the reset journeys.
// It creates no user: anyone a journey needs comes from `SEED_USERS`
// (`./identities.mjs`). Writes go through the console's Firestore mount as
// the owner, exactly as the workbench writes. The stream owns this file.

const OWNER = { authorization: 'Bearer owner', 'content-type': 'application/json' }

/** How many writes one commit carries (Firestore's own limit). */
const BATCH = 500

/**
 * One commit of `documents` (`[path, fields]`) through the console mount.
 * @param {{ origin: string, project: string }} engine
 * @param {Array<[string, Record<string, unknown>]>} documents
 */
async function commit(engine, documents) {
  const root = `projects/${engine.project}/databases/(default)/documents`
  const response = await fetch(`${engine.origin}/console/api/v1/firestore/v1/${root}:commit`, {
    method: 'POST',
    headers: OWNER,
    body: JSON.stringify({
      writes: documents.map(([path, fields]) => ({
        update: { name: `${root}/${path}`, fields },
      })),
    }),
  })
  if (!response.ok)
    throw new Error(`seeding ${documents[0]?.[0]} … → ${response.status} ${await response.text()}`)
}

/**
 * `carts/c_1` … `carts/c_<count>`, each with a few items and a total.
 * @param {{ origin: string, project: string }} engine
 */
export async function seedCarts(engine, count = 20) {
  const carts = Array.from({ length: count }, (_, index) => {
    const number = index + 1
    return /** @type {[string, Record<string, unknown>]} */ ([
      `carts/c_${number}`,
      {
        items: { integerValue: String((number % 4) + 1) },
        total: { doubleValue: number * 12.5 },
        status: { stringValue: number % 3 === 0 ? 'abandoned' : 'open' },
      },
    ])
  })
  await commit(engine, carts)
}

/**
 * `bulk/b_00000` … : `count` small documents, written `BATCH` at a time.
 * @param {{ origin: string, project: string }} engine
 */
export async function seedBulk(engine, count = 50_000) {
  for (let start = 0; start < count; start += BATCH) {
    const batch = []
    for (let index = start; index < Math.min(count, start + BATCH); index += 1)
      batch.push(
        /** @type {[string, Record<string, unknown>]} */ ([
          `bulk/b_${String(index).padStart(5, '0')}`,
          { n: { integerValue: String(index) }, even: { booleanValue: index % 2 === 0 } },
        ]),
      )
    await commit(engine, batch)
  }
}

/** @param {{ origin: string, project: string, ports: Record<string, number> }} engine */
export async function seed(engine) {
  await seedCarts(engine)
}
