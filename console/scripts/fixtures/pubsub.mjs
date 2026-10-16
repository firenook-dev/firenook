// The pubsub fixture writes nothing into the synthetic project: the engine
// starter adds Pub/Sub's emulators entry from the profile, the topics that
// functions listen on come from the fixture codebase (`functions/messaging.js`),
// and everything else from the seeder (`seed/pubsub.mjs`), through the
// Pub/Sub port, as an app would make them. The messaging stream owns this file.

/** @type {import('../synthetic-engine.mjs').Fixture} */
export default {
  name: 'pubsub',
  prepare() {},
}
