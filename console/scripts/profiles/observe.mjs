// The Logs and Overview journeys (project `observe`): every service, every
// stream's functions, every seeder. The observe stream owns this file.

/** @type {import('../synthetic-engine.mjs').Profile} */
export default {
  name: 'observe',
  only: 'firestore,auth,storage,functions,pubsub',
  offline: true,
  fixtures: ['firestore', 'auth', 'storage', 'functions', 'extensions', 'pubsub', 'tasks'],
  seeds: ['firestore', 'auth', 'storage', 'functions', 'pubsub', 'tasks', 'observe'],
}
