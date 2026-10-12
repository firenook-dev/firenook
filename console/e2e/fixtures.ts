// The engines journeys run against: one real engine per Playwright worker,
// started with the project's profile (`playwright.config.ts`) and seeded,
// and test-scoped engines for journeys that stop, restart or slow one, so
// the worker's engine is never the one a journey kills. No mocked API.

import { test as base } from '@playwright/test'
import {
  type EngineProfile,
  type StartOptions,
  type StartedEngine,
  startEngine,
} from '../scripts/synthetic-engine.mjs'
import { RELEASE_ENV } from './engine'

export type { EngineProfile, StartOptions }

export interface Engine {
  origin: string
  project: string
  ports: Record<string, number>
  directory: string
  stop(): Promise<void>
}

/** What a describe block may change about its worker's engine (a new worker starts for it). */
export interface EngineOptions {
  only?: string
  args?: string[]
  fixtureEnv?: Record<string, string>
}

function engineOf(started: StartedEngine): Engine {
  return {
    origin: started.origin,
    project: started.project,
    ports: started.ports,
    directory: started.directory,
    stop: started.stop,
  }
}

// oxlint-disable-next-line typescript/no-empty-object-type -- no test-scoped fixtures here
export const test = base.extend<
  {},
  { profile: EngineProfile; engineOptions: EngineOptions; engine: Engine }
>({
  profile: ['data', { option: true, scope: 'worker' }],
  // A describe block that needs another suite:
  // test.use({ engineOptions: { only: 'functions,firestore' } })
  engineOptions: [{}, { option: true, scope: 'worker' }],
  engine: [
    async ({ profile, engineOptions }, use) => {
      const started = await startEngine({ profile, ...engineOptions, env: RELEASE_ENV })
      // The specs read these through their `origin()` and `project()` helpers.
      process.env.FIRENOOK_CONSOLE_ORIGIN = started.origin
      process.env.FIRENOOK_CONSOLE_PROJECT = started.project
      process.env.FIRENOOK_CONSOLE_DIRECTORY = started.directory
      await use(engineOf(started))
      await started.stop()
    },
    { scope: 'worker', auto: true, timeout: 180_000 },
  ],
})

/**
 * Test-scoped engines for journeys that stop, restart or slow one. Every
 * engine it started is stopped in teardown, whatever the test did (a
 * stopped engine's stop() does nothing).
 */
export const dedicated = test.extend<{
  dedicatedEngine: (profile: EngineProfile, options?: StartOptions) => Promise<Engine>
}>({
  // Playwright reads a fixture's dependencies from its first parameter's
  // pattern, so an empty one is how a fixture says it needs none.
  // oxlint-disable-next-line no-empty-pattern
  dedicatedEngine: async ({}, use) => {
    const started: Engine[] = []
    await use(async (profile, options) => {
      const engine = engineOf(
        await startEngine({ profile, ...options, env: { ...RELEASE_ENV, ...options?.env } }),
      )
      started.push(engine)
      return engine
    })
    await Promise.allSettled(started.map((engine) => engine.stop()))
  },
})

export { expect } from '@playwright/test'
