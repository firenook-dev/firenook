// Start a real engine on free ports with a synthetic project: the Playwright
// suite uses it, and `node scripts/synthetic-engine.mjs` runs one for console
// development (`FIRENOOK_UI_ORIGIN` is printed for `npm run dev`). Nothing here
// touches a real project or a consumer's data.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HOST = '127.0.0.1'
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

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, HOST, () => {
      const { port } = server.address()
      server.close(() => resolvePort(port))
    })
  })
}

function waitForReady(child) {
  return new Promise((resolveReady, reject) => {
    let output = ''
    const onData = (chunk) => {
      output += chunk.toString()
      if (/(?:^|\n)All emulators ready\r?\n/.test(output)) resolveReady()
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.once('exit', (code) => reject(new Error(`engine exited early (${code}):\n${output}`)))
    setTimeout(() => reject(new Error(`engine not ready after 60 s:\n${output}`)), 60_000).unref()
  })
}

/**
 * @param {{ project?: string, only?: string, inherit?: boolean, uiPort?: number }} [options]
 * @returns {Promise<{ origin: string, project: string, ports: Record<string, number>, stop: () => Promise<void> }>}
 */
export async function startEngine(options = {}) {
  const here = fileURLToPath(new URL('.', import.meta.url))
  const binary = process.env.FIRENOOK_BINARY ?? resolve(here, '../../target/debug/firenook')
  const archive =
    process.env.FIRENOOK_UI_ARCHIVE ?? join(homedir(), '.cache/firebase/emulators/ui-v1.15.0.zip')
  if (!existsSync(binary))
    throw new Error(`engine binary missing: ${binary} (cargo build --bin firenook)`)
  if (!existsSync(archive))
    throw new Error(`Emulator UI archive missing: ${archive} (firenook setup)`)

  const project = options.project ?? 'demo-console-synthetic'
  const directory = mkdtempSync(join(tmpdir(), 'firenook-console-'))
  writeFileSync(
    join(directory, 'firebase.json'),
    JSON.stringify({
      firestore: { rules: 'firestore.rules' },
      emulators: { ui: { enabled: true } },
    }),
  )
  writeFileSync(join(directory, '.firebaserc'), JSON.stringify({ projects: { default: project } }))
  writeFileSync(
    join(directory, 'firestore.rules'),
    "rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /{document=**} { allow read, write: if true; } } }",
  )
  mkdirSync(join(directory, 'state'))

  const ports = {}
  await Promise.all(PORT_NAMES.map(async (name) => (ports[name] = await freePort())))
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
    '--ui-archive',
    archive,
    '--state-dir',
    join(directory, 'state'),
    '--minimum-functions',
    '0',
    '--only',
    options.only ?? 'firestore,auth',
  ]
  for (const [name, port] of Object.entries(ports)) args.push(`--${name}-port`, String(port))

  const child = spawn(binary, args, {
    cwd: directory,
    stdio: ['ignore', options.inherit ? 'inherit' : 'pipe', options.inherit ? 'inherit' : 'pipe'],
  })
  if (!options.inherit) await waitForReady(child)
  const stop = () =>
    new Promise((done) => {
      if (child.exitCode !== null) return done()
      child.once('exit', () => done())
      child.kill('SIGINT')
      setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL')
      }, 20_000).unref()
    })
  return { origin: `http://${HOST}:${ports.ui}`, project, ports, stop, child }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const engine = await startEngine({
    inherit: true,
    only: process.env.FIRENOOK_ONLY,
    uiPort: process.env.FIRENOOK_UI_PORT ? Number(process.env.FIRENOOK_UI_PORT) : undefined,
  })
  console.log(`\nConsole: ${engine.origin}/console`)
  console.log(`Google UI: ${engine.origin}/`)
  console.log(`For the Vite dev server: FIRENOOK_UI_ORIGIN=${engine.origin} npm run dev\n`)
  const shutdown = () => engine.stop().then(() => process.exit(0))
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}
