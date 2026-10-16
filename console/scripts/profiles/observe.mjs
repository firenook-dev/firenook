// The Logs and Overview journeys (project `observe`): every service, every
// seeder, and observe's own functions. The observe stream owns this file.

/** @type {import('../synthetic-engine.mjs').Profile} */
export default {
  name: 'observe',
  only: 'firestore,auth,storage,functions,pubsub',
  offline: true,
  fixtures: ['firestore', 'auth', 'storage', 'functions', 'extensions', 'pubsub', 'tasks'],
  // Observe's own functions only: every stream's would answer the seeders'
  // writes (an upload trigger per seeded object), and their thousands of
  // lines would bury the engine's own history the Logs journeys read.
  fixtureEnv: { FIXTURE_STREAMS: 'observe' },
  seeds: ['firestore', 'auth', 'storage', 'functions', 'pubsub', 'tasks', 'observe'],
}
