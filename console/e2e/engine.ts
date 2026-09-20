// Playwright global setup: one real engine for the whole suite, started by
// the same launcher developers use for the console.
import { startEngine } from '../scripts/synthetic-engine.mjs'

export default async function globalSetup() {
  const engine = await startEngine({ project: 'demo-console-e2e' })
  process.env.FIRENOOK_CONSOLE_ORIGIN = engine.origin
  process.env.FIRENOOK_CONSOLE_PROJECT = engine.project
  return () => engine.stop()
}
