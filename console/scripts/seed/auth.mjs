// The Authentication seeder: the seed people (`SEED_USERS`) as Auth users,
// so every profile that runs Auth has the same three to sign in as and
// view data as. The auth stream owns this file and adds its own data here.

import { ensureSeedUsers } from './identities.mjs'

/** @param {{ origin: string, project: string }} engine */
export async function seed(engine) {
  await ensureSeedUsers(engine)
}
