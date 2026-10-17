// Start a real engine on free ports with a synthetic project: the Playwright
// suite starts one per worker through `e2e/fixtures.ts`, and
// `npm run engine -- --profile <name>` runs one for console development
// (`FIRENOOK_UI_ORIGIN` is printed for `npm run dev`). Nothing here touches
// a real project or a consumer's data.
//
// A profile (`scripts/profiles/<name>.mjs`) says which services run, which
// fixtures write the project (`scripts/fixtures/<name>.mjs`) and which
// seeders fill it once it is ready (`scripts/seed/<name>.mjs`). Each stream
// owns its own profile, fixture and seeder files; this file is the
// foundation's.

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HOST = '127.0.0.1'
const HERE = fileURLToPath(new URL('.', import.meta.url))
const PORT_NAMES = [
  'firestore',
  'auth',
  'storage',
  'functions',
  'pubsub',
  'hub',
  'ui',
  'logging',
  'eventarc',
  'tasks',
  'firestore-websocket',
]

/** The five data services the npm CLI decides from firebase.json and names in a launch context. */
const DATA_SERVICES = ['firestore', 'auth', 'storage', 'functions', 'pubsub']

/** Every profile; `scripts/profiles/<name>.mjs` holds each. */
export const PROFILES = ['data', 'auth', 'storage', 'compute', 'messaging', 'observe', 'all']

/** How many times a start that lost a port to another process is tried again. */
const PORT_ATTEMPTS = 3

/**
 * Set to keep every engine's project directory after it stops, to look at
 * what an engine wrote (its state, its debug log) after a journey.
 */
const KEEP_DIRECTORIES = Boolean(process.env.FIRENOOK_KEEP_ENGINE_DIR)

/**
 * Removes an engine's project directory, unless FIRENOOK_KEEP_ENGINE_DIR is
 * set. Each one is 15 to 75 MB (a Functions codebase, its SDK link, the
 * state), and a suite run starts hundreds.
 */
export function removeDirectory(directory) {
  if (KEEP_DIRECTORIES) return
  rmSync(directory, { recursive: true, force: true, maxRetries: 3 })
}

/**
 * @typedef {{
 *   name: string,
 *   only: string,
 *   offline?: boolean,
 *   fixtures: string[],
 *   fixtureEnv?: Record<string, string>,
 *   seeds: string[],
 * }} Profile
 */

/**
 * @typedef {{
 *   name: string,
 *   prepare(directory: string, firebaseJson: Record<string, unknown>, options: { fixtureEnv: Record<string, string>, project: string, firebaseRc: FirebaseRc }): void | Promise<void>,
 * }} Fixture
 */

/**
 * The project's `.firebaserc`, which a fixture may add to before it is
 * written: Storage's per-bucket rules name their buckets through `targets`,
 * as a real project's do (the CLI resolves a target to its bucket there).
 * @typedef {{
 *   projects: { default: string },
 *   targets?: Record<string, Record<string, Record<string, string[]>>>,
 * }} FirebaseRc
 */

/** @param {string} name @returns {Promise<Profile>} */
export async function loadProfile(name) {
  if (!PROFILES.includes(name))
    throw new Error(`No engine profile is called ${name}; the profiles are ${PROFILES.join(', ')}.`)
  return (await import(pathToFileURL(join(HERE, 'profiles', `${name}.mjs`)).href)).default
}

/**
 * Whether firebase.json configures a service, by the npm CLI's rule
 * (`packages/cli/src/options.mjs`): a top-level section or an emulators
 * entry, extensions counting as functions.
 * @param {Record<string, any>} firebaseJson
 * @param {string} name
 */
export function configures(firebaseJson, name) {
  const emulators = firebaseJson.emulators ?? {}
  const has = (key) => Object.hasOwn(firebaseJson, key)
  const hasEmulator = (key) => Object.hasOwn(emulators, key)
  if (name === 'functions')
    return (
      has('functions') || has('extensions') || hasEmulator('functions') || hasEmulator('extensions')
    )
  if (name === 'firestore' || name === 'storage') return has(name) || hasEmulator(name)
  return hasEmulator(name)
}

/**
 * The launch context the npm CLI would pass for this project and command
 * line: why each data service that does not run is absent, and the command
 * as typed, which a fix reprints with one name added.
 * @param {Record<string, any>} firebaseJson
 * @param {string} only
 * @param {string[]} args
 */
export function launchContextFor(firebaseJson, only, args) {
  const running = new Set(only.split(',').map((name) => name.trim().split(':')[0]))
  const services = {}
  for (const name of DATA_SERVICES) {
    if (running.has(name)) continue
    services[name] = configures(firebaseJson, name) ? 'excluded-by-only' : 'not-configured'
  }
  return { services, skipped: [], command: 'firenook emulators:start', args }
}

/**
 * Takes a free port for every name and holds each socket open, so no other
 * process (another worker's engine) can take one before the spawn; `release`
 * closes them all at once, just before the engine binds.
 * @param {string[]} names
 */
async function reservePorts(names) {
  const servers = []
  const ports = {}
  try {
    for (const name of names) {
      const server = createServer()
      await new Promise((done, fail) => {
        server.once('error', fail)
        server.listen(0, HOST, done)
      })
      servers.push(server)
      ports[name] = server.address().port
    }
  } catch (error) {
    await Promise.all(servers.map((server) => new Promise((done) => server.close(done))))
    throw error
  }
  const release = () =>
    Promise.all(servers.map((server) => new Promise((done) => server.close(() => done()))))
  return { ports, release }
}

/** The start failed because a port was taken between release and bind. */
class PortTaken extends Error {}

/**
 * Resolves once the engine is ready: its "All emulators ready" line, or for
 * `wait: 'ui'` the console's status answering (the services may still be
 * starting behind it).
 */
function waitForEngine(child, wait, origin) {
  return new Promise((resolveReady, reject) => {
    let output = ''
    let settled = false
    const settle = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn(value)
    }
    const onData = (chunk) => {
      output += chunk.toString()
      const taken = /cannot bind (\S+) at (\S+): [^\n]*(?:in use|AddrInUse)/i.exec(output)
      if (taken) settle(reject, new PortTaken(`port for ${taken[1]} (${taken[2]}) was taken`))
      else if (wait === 'ready' && /(?:^|\n)All emulators ready\r?\n/.test(output))
        settle(resolveReady)
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.once('exit', (code) =>
      settle(reject, new Error(`engine exited early (${code}):\n${output}`)),
    )
    const timer = setTimeout(
      () => settle(reject, new Error(`engine not ready after 90 s:\n${output}`)),
      90_000,
    )
    timer.unref()
    if (wait === 'ui') {
      // The test harness, not the console, asks again until it answers.
      const probe = async () => {
        if (settled) return
        try {
          const response = await fetch(`${origin}/console/api/v1/status`)
          if (response.ok) return settle(resolveReady)
        } catch {
          // Not listening yet.
        }
        setTimeout(() => void probe(), 100)
      }
      void probe()
    }
  })
}

/**
 * @param {{
 *   profile?: 'data' | 'auth' | 'storage' | 'compute' | 'messaging' | 'observe' | 'all',
 *   project?: string,
 *   only?: string,
 *   wait?: 'ready' | 'ui',
 *   seed?: boolean,
 *   fixtureEnv?: Record<string, string>,
 *   env?: Record<string, string>,
 *   launchContext?: object | false,
 *   args?: string[],
 *   inherit?: boolean,
 *   uiPort?: number,
 *   keepDirectory?: boolean,
 * }} [options]
 */
export async function startEngine(options = {}) {
  const binary = process.env.FIRENOOK_BINARY ?? resolve(HERE, '../../target/debug/firenook')
  if (!existsSync(binary))
    throw new Error(`engine binary missing: ${binary} (cargo build --bin firenook)`)

  const profileName = options.profile ?? 'data'
  const profile = await loadProfile(profileName)
  const project =
    options.project ?? (profileName === 'data' ? 'demo-console-e2e' : `demo-console-${profileName}`)
  const only = options.only ?? profile.only
  const fixtureEnv = { ...profile.fixtureEnv, ...options.fixtureEnv }

  const directory = mkdtempSync(join(tmpdir(), `firenook-console-${profileName}-`))
  try {
    return await launch(options, {
      binary,
      profile,
      profileName,
      project,
      only,
      fixtureEnv,
      directory,
    })
  } catch (error) {
    // A start that failed leaves nothing behind.
    removeDirectory(directory)
    throw error
  }
}

/** Writes the project into `directory` and starts the engine on it; `startEngine` owns the directory. */
async function launch(
  options,
  { binary, profile, profileName, project, only, fixtureEnv, directory },
) {
  // What a real project's firebase.json holds: an emulators entry for each
  // service the profile runs, then whatever each fixture adds.
  const firebaseJson = { emulators: { ui: { enabled: true } } }
  /** @type {FirebaseRc} */
  const firebaseRc = { projects: { default: project } }
  for (const name of profile.only.split(','))
    if (name !== 'functions' && name !== 'firestore' && name !== 'storage')
      firebaseJson.emulators[name] = {}
  for (const name of profile.fixtures) {
    /** @type {Fixture} */
    const fixture = (await import(pathToFileURL(join(HERE, 'fixtures', `${name}.mjs`)).href))
      .default
    await fixture.prepare(directory, firebaseJson, { fixtureEnv, project, firebaseRc })
  }
  writeFileSync(join(directory, 'firebase.json'), JSON.stringify(firebaseJson, null, 2))
  writeFileSync(join(directory, '.firebaserc'), JSON.stringify(firebaseRc))
  mkdirSync(join(directory, 'state'), { recursive: true })

  const typed = ['--project', project, '--only', only]
  const launchContext =
    options.launchContext === false
      ? undefined
      : (options.launchContext ?? launchContextFor(firebaseJson, only, typed))

  let lastError
  for (let attempt = 1; attempt <= PORT_ATTEMPTS; attempt += 1) {
    const names = options.uiPort ? PORT_NAMES.filter((name) => name !== 'ui') : PORT_NAMES
    const { ports, release } = await reservePorts(names)
    // A fixed UI port keeps the console address stable across restarts.
    if (options.uiPort) ports.ui = options.uiPort
    const args = [
      'suite',
      '--project-dir',
      directory,
      '--config',
      join(directory, 'firebase.json'),
      '--firebase-rc',
      join(directory, '.firebaserc'),
      '--project-id',
      project,
      '--host',
      HOST,
      '--node',
      process.execPath,
      '--state-dir',
      join(directory, 'state'),
      '--minimum-functions',
      '0',
      '--only',
      only,
    ]
    if (profile.offline) args.push('--offline')
    if (launchContext) args.push('--launch-context', JSON.stringify(launchContext))
    for (const [name, port] of Object.entries(ports)) args.push(`--${name}-port`, String(port))
    args.push(...(options.args ?? []))

    await release()
    const child = spawn(binary, args, {
      cwd: directory,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', options.inherit ? 'inherit' : 'pipe', options.inherit ? 'inherit' : 'pipe'],
    })
    // An engine never outlives the process that started it, even one that
    // exits without stopping it (an uncaught error, a worker shut down
    // early): what is still running when this process exits is killed.
    const orphaned = () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
    process.once('exit', orphaned)
    child.once('exit', () => process.off('exit', orphaned))
    const origin = `http://${HOST}:${ports.ui}`
    let exited
    const halt = () =>
      (exited ??= new Promise((done) => {
        if (child.exitCode !== null || child.signalCode !== null) return done()
        child.once('exit', () => done())
        child.kill('SIGINT')
        setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        }, 20_000).unref()
      }))
    // Stopped, the engine's project directory goes too, unless the caller
    // keeps it to start another engine on what this one saved
    // (`keepDirectory`, then `remove()` once done with it).
    let stopped
    const stop = () =>
      (stopped ??= halt().then(() => {
        if (!options.keepDirectory) removeDirectory(directory)
      }))
    const remove = () => halt().then(() => removeDirectory(directory))
    try {
      if (!options.inherit) await waitForEngine(child, options.wait ?? 'ready', origin)
    } catch (error) {
      // The next attempt starts on the same directory; a final failure
      // removes it in `startEngine`.
      await halt()
      lastError = error
      if (error instanceof PortTaken && attempt < PORT_ATTEMPTS) continue
      throw error instanceof PortTaken
        ? new Error(
            `The engine could not bind its ports after ${PORT_ATTEMPTS} tries: ${error.message}`,
          )
        : error
    }
    const engine = { origin, project, ports, directory, profile: profileName, stop, remove, child }
    if (options.seed !== false && !options.inherit) {
      try {
        for (const name of profile.seeds) {
          const seeder = await import(pathToFileURL(join(HERE, 'seed', `${name}.mjs`)).href)
          await seeder.seed(engine)
        }
      } catch (error) {
        // The engine stops before its directory goes (in `startEngine`).
        await halt()
        throw error
      }
    }
    return engine
  }
  throw lastError
}

/** A `--name value` argument of the command line. */
function flag(name) {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? undefined : process.argv[at + 1]
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const engine = await startEngine({
    profile: flag('profile') ?? process.env.FIRENOOK_PROFILE ?? 'data',
    only: flag('only') ?? process.env.FIRENOOK_ONLY,
    project: flag('project'),
    uiPort: process.env.FIRENOOK_UI_PORT ? Number(process.env.FIRENOOK_UI_PORT) : undefined,
  })
  console.log(`\nProfile: ${engine.profile} (${engine.directory})`)
  console.log(`Console: ${engine.origin}/console`)
  console.log(`Google UI: ${engine.origin}/`)
  console.log(`For the Vite dev server: FIRENOOK_UI_ORIGIN=${engine.origin} npm run dev\n`)
  engine.child.stdout?.pipe(process.stdout)
  engine.child.stderr?.pipe(process.stderr)
  const shutdown = () => engine.stop().then(() => process.exit(0))
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}
