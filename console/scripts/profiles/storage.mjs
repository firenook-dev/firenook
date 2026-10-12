// The Storage section's journeys (project `storage`). The storage stream
// owns this file.

/** @type {import('../synthetic-engine.mjs').Profile} */
export default {
  name: 'storage',
  only: 'storage,firestore,auth,functions',
  fixtures: ['firestore', 'storage', 'functions'],
  fixtureEnv: { FIXTURE_STREAMS: 'storage' },
  seeds: ['storage', 'auth'],
}
