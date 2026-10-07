// Playwright global setup: one real engine for the whole suite, started by
// the same launcher developers use for the console.
import { seedFirestore } from '../scripts/seed-firestore.mjs'
import { startEngine } from '../scripts/synthetic-engine.mjs'

/** The release the suite tells the engine it ships as. */
export const RELEASE_VERSION = '0.2.0-e2e.1'
/** The engine source commit the suite declares, shortened in the console. */
export const ENGINE_REVISION = '63d554c15f2699cf623c7fac19a4d1393c77f322'

export default async function globalSetup() {
  // The engine learns its release from the distribution that launches it, so
  // the suite declares one: that is the only way the console's engine badge
  // has a version to show, and the only honest way to test the handoff.
  process.env.FIRENOOK_RELEASE_VERSION = RELEASE_VERSION
  process.env.FIRENOOK_ENGINE_REVISION = ENGINE_REVISION
  const engine = await startEngine({ project: 'demo-console-e2e' })
  // The Firestore journey reads the same synthetic data developers seed.
  await seedFirestore(engine.origin, engine.project)
  process.env.FIRENOOK_CONSOLE_ORIGIN = engine.origin
  process.env.FIRENOOK_CONSOLE_PROJECT = engine.project
  return () => engine.stop()
}
