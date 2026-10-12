export type EngineProfile =
  | 'data'
  | 'auth'
  | 'storage'
  | 'compute'
  | 'messaging'
  | 'observe'
  | 'all'

export interface Profile {
  name: string
  only: string
  offline?: boolean
  fixtures: string[]
  fixtureEnv?: Record<string, string>
  seeds: string[]
}

export interface Fixture {
  name: string
  prepare(
    directory: string,
    firebaseJson: Record<string, unknown>,
    options: { fixtureEnv: Record<string, string> },
  ): void | Promise<void>
}

export interface StartOptions {
  profile?: EngineProfile
  /** Default `demo-console-<profile>`; `data` keeps `demo-console-e2e`. */
  project?: string
  /** Overrides the profile's `--only`. */
  only?: string
  /** `ready` (default) waits for "All emulators ready"; `ui` for the console's status. */
  wait?: 'ready' | 'ui'
  /** Run the profile's seeders once ready (default true). */
  seed?: boolean
  /** Written to the Functions codebase's `.env`, over the profile's. */
  fixtureEnv?: Record<string, string>
  /** The engine process's extra environment. */
  env?: Record<string, string>
  /** Passed as `--launch-context`; default: built from the profile as the npm CLI would; `false`: none. */
  launchContext?: object | false
  /** Extra engine command-line arguments. */
  args?: string[]
  inherit?: boolean
  uiPort?: number
}

export interface StartedEngine {
  origin: string
  project: string
  ports: Record<string, number>
  directory: string
  profile: EngineProfile
  stop: () => Promise<void>
  child: import('node:child_process').ChildProcess
}

export const PROFILES: readonly EngineProfile[]
export function loadProfile(name: string): Promise<Profile>
export function configures(firebaseJson: Record<string, unknown>, name: string): boolean
export function launchContextFor(
  firebaseJson: Record<string, unknown>,
  only: string,
  args: string[],
): { services: Record<string, string>; skipped: string[]; command: string; args: string[] }
export function startEngine(options?: StartOptions): Promise<StartedEngine>
