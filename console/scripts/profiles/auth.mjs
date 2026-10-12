// The Authentication section's journeys (project `auth`): Auth with Firestore
// and the blocking functions in `scripts/fixtures/functions/auth.js`. The
// auth stream owns this file.

/** @type {import('../synthetic-engine.mjs').Profile} */
export default {
  name: 'auth',
  only: 'auth,firestore,functions',
  fixtures: ['firestore', 'auth', 'functions'],
  fixtureEnv: { FIXTURE_STREAMS: 'auth' },
  seeds: ['auth', 'firestore'],
}
