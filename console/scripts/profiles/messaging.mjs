// The Pub/Sub and Cloud Tasks journeys (project `messaging`): Pub/Sub,
// Functions and Firestore, with Cloud Tasks following Functions. Its
// functions are `scripts/fixtures/functions/messaging.js` alone
// (FIXTURE_STREAMS), written with the real SDK; its data comes from the
// pubsub and tasks seeders. The messaging stream owns this file.

/** @type {import('../synthetic-engine.mjs').Profile} */
export default {
  name: 'messaging',
  only: 'pubsub,functions,firestore',
  fixtures: ['firestore', 'functions', 'pubsub', 'tasks'],
  fixtureEnv: { FIXTURE_STREAMS: 'messaging' },
  seeds: ['pubsub', 'tasks'],
}
