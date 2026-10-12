// Firestore and Auth: the console, firestore and rules journeys (project `data`).

/** @type {import('../synthetic-engine.mjs').Profile} */
export default {
  name: 'data',
  only: 'firestore,auth',
  fixtures: ['firestore'],
  seeds: ['firestore'],
}
