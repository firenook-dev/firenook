// The tasks fixture writes nothing into the synthetic project: Cloud Tasks
// runs with Functions, and its queues register from the fixture codebase's
// `onTaskDispatched` functions (`functions/messaging.js`) as the engine
// discovers them; journeys register their own client queues over the Tasks
// port. The messaging stream owns this file.

/** @type {import('../synthetic-engine.mjs').Fixture} */
export default {
  name: 'tasks',
  prepare() {},
}
