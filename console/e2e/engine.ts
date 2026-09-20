// Playwright global setup: one real engine for the whole suite, started by
// the same launcher developers use for the console.
import { seedFirestore } from '../scripts/seed-firestore.mjs'
import { startEngine } from '../scripts/synthetic-engine.mjs'

export default async function globalSetup() {
  const engine = await startEngine({ project: 'demo-console-e2e' })
  // The Firestore journey reads the same synthetic data developers seed.
  await seedFirestore(engine.origin, engine.project)
  process.env.FIRENOOK_CONSOLE_ORIGIN = engine.origin
  process.env.FIRENOOK_CONSOLE_PROJECT = engine.project
  return () => engine.stop()
}
