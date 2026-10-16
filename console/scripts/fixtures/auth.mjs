// The auth fixture: what the auth stream writes into the synthetic project
// for its journeys. Its emulators entry is written by the engine starter
// from the profile. One thing more: an engine started again on the Auth
// state another one saved. Each engine has a directory of its own, so a
// journey that restarts Auth "on the same state" names the state file the
// first engine wrote (`fixtureEnv.AUTH_SAVED_STATE`), and it is put where
// this engine reads its Auth state at start. The auth stream owns this file.

import { copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/** Where an engine keeps its Auth state, inside its project directory. */
export const AUTH_STATE_FILE = join('state', 'auth-state.json')

/** @type {import('../synthetic-engine.mjs').Fixture} */
export default {
  name: 'auth',
  prepare(directory, _firebaseJson, { fixtureEnv }) {
    const saved = fixtureEnv.AUTH_SAVED_STATE
    if (!saved) return
    mkdirSync(join(directory, 'state'), { recursive: true })
    copyFileSync(saved, join(directory, AUTH_STATE_FILE))
  },
}
