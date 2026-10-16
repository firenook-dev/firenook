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

/** What a spec file may change about its worker's engine (a new worker starts for it). */
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

/**
 * What a worker without an engine of its own hands its tests: every use is
 * a mistake the message names, never a request to a port nothing holds.
 */
const NO_ENGINE = new Proxy({} as Engine, {
  get(_target, key) {
    // Asked of every value by whatever checks for a promise or prints one.
    if (key === 'then' || typeof key === 'symbol') return undefined
    throw new Error(
      `This spec file runs without a worker engine (workerEngine: false), so engine.${String(key)} does not exist; use dedicatedEngine().`,
    )
  },
})

// oxlint-disable-next-line typescript/no-empty-object-type -- no test-scoped fixtures here
export const test = base.extend<
  {},
  { profile: EngineProfile; engineOptions: EngineOptions; workerEngine: boolean; engine: Engine }
>({
  profile: ['data', { option: true, scope: 'worker' }],
  // A spec file that needs another suite says so at its top level (a
  // worker-scoped option cannot change inside a describe block):
  // test.use({ engineOptions: { only: 'functions,firestore' } })
  engineOptions: [{}, { option: true, scope: 'worker' }],
  // A spec file whose journeys each start, stop and restart engines of
  // their own (`dedicatedEngine`) says `workerEngine: false` at its top
  // level, so the worker holds no engine beside them: one engine at a
  // time on the host.
  workerEngine: [true, { option: true, scope: 'worker' }],
  engine: [
    async ({ profile, engineOptions, workerEngine }, use) => {
      if (!workerEngine) {
        await use(NO_ENGINE)
        return
      }
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
    const directories: Array<() => Promise<void>> = []
    await use(async (profile, options) => {
      // A journey may start an engine on what an earlier one saved, so the
      // directories outlive each stop and go once the journey is over.
      const launched = await startEngine({
        profile,
        ...options,
        keepDirectory: true,
        env: { ...RELEASE_ENV, ...options?.env },
      })
      directories.push(launched.remove)
      const engine = engineOf(launched)
      started.push(engine)
      return engine
    })
    await Promise.allSettled(started.map((engine) => engine.stop()))
    await Promise.allSettled(directories.map((remove) => remove()))
  },
})

export { expect } from '@playwright/test'
