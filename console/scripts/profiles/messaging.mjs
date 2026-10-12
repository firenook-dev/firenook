// The Pub/Sub and Cloud Tasks journeys (project `messaging`). The messaging
// stream owns this file.

/** @type {import('../synthetic-engine.mjs').Profile} */
export default {
  name: 'messaging',
  only: 'pubsub,functions,firestore',
  fixtures: ['firestore', 'functions', 'pubsub', 'tasks'],
  fixtureEnv: { FIXTURE_STREAMS: 'messaging' },
  seeds: ['pubsub', 'tasks'],
}
