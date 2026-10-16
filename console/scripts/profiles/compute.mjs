// The Functions, Extensions and Eventarc journeys (project `compute`):
// offline, so Extensions never reach the registry. The compute stream owns
// this file; its functions live in `scripts/fixtures/functions/compute.js`,
// the blocking ones it needs come from `auth.js`, and `fixtures/compute.mjs`
// adds the `jobs` and `broken` codebases and the shared codebase's secret.

/** @type {import('../synthetic-engine.mjs').Profile} */
export default {
  name: 'compute',
  only: 'functions,firestore,auth,storage,pubsub',
  offline: true,
  fixtures: ['firestore', 'storage', 'functions', 'extensions', 'compute'],
  fixtureEnv: { FIXTURE_STREAMS: 'compute,auth', GREETING: 'hello' },
  seeds: ['functions', 'firestore'],
}
