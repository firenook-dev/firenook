// The pubsub fixture: what the messaging stream writes into the synthetic
// project for its journeys. Its emulators entry is written by the engine
// starter from the profile, so there is nothing more to add until the
// stream needs project files of its own; the stream owns this file.

/** @type {import('../synthetic-engine.mjs').Fixture} */
export default {
  name: 'pubsub',
  prepare() {},
}
