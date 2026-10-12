// The Functions, Extensions and Eventarc journeys (project `compute`):
// offline, so Extensions never reach the registry. The compute stream owns
// this file; its functions live in `scripts/fixtures/functions/compute.js`,
// and the blocking ones it needs come from `auth.js`.

/** @type {import('../synthetic-engine.mjs').Profile} */
export default {
  name: 'compute',
  only: 'functions,firestore,auth,storage,pubsub',
  offline: true,
  fixtures: ['firestore', 'storage', 'functions', 'extensions'],
  fixtureEnv: { FIXTURE_STREAMS: 'compute,auth' },
  seeds: ['functions', 'firestore'],
}
