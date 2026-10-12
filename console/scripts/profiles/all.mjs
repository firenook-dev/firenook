// Every service, every fixture and every seeder: the shell journeys
// (project `shell`) and `npm run engine -- --profile all`.

/** @type {import('../synthetic-engine.mjs').Profile} */
export default {
  name: 'all',
  only: 'firestore,auth,storage,functions,pubsub',
  offline: true,
  fixtures: ['firestore', 'auth', 'storage', 'functions', 'extensions', 'pubsub', 'tasks'],
  seeds: ['firestore', 'auth', 'storage', 'functions', 'pubsub', 'tasks', 'observe'],
}
