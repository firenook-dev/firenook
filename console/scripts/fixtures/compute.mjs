// The compute journeys' project beyond the shared codebase: the shared
// codebase's secret, and two more codebases beside it, each linked to the
// pinned SDK from the offline install so nothing is fetched at test time.
//
// - `jobs` — a TypeScript codebase as `firebase init` writes one: `src/`
//   compiled to `lib/`, which `main` names and the emulator loads. Its one
//   function is `heartbeat`. A journey touches `src/index.ts` to see the
//   console say the build is older than its source.
// - `broken` — a codebase whose `index.js` does not parse, so discovery
//   fails with Node's own error output, from the first load on.
//
// The two codebases are written here rather than copied from files of the
// repository: the console's own checks read every TypeScript and
// JavaScript file under `scripts/`, and these two are, on purpose, a
// TypeScript file for another project and a file that does not parse.
// The greeter extension's parameter files come with the extension
// (`extensions.mjs` copies `extensions/greeter.env` and
// `greeter.secret.local`). The compute stream owns this file.

import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ADMIN_VERSION, FUNCTIONS_VERSION, resolveFunctionsSdk } from '../functions-sdk.mjs'

/** The pinned SDK as a codebase's package.json names it. */
const DEPENDENCIES = { 'firebase-admin': ADMIN_VERSION, 'firebase-functions': FUNCTIONS_VERSION }

const json = (value) => `${JSON.stringify(value, null, 2)}\n`

/** What `jobs` holds: a TypeScript source and the build of it the emulator runs. */
const JOBS = {
  'package.json': json({
    name: 'firenook-console-fixture-jobs',
    private: true,
    main: 'lib/index.js',
    scripts: { build: 'tsc' },
    dependencies: DEPENDENCIES,
    engines: { node: '24' },
  }),
  'tsconfig.json': json({
    compilerOptions: {
      module: 'commonjs',
      target: 'es2022',
      outDir: 'lib',
      rootDir: 'src',
      strict: true,
    },
    include: ['src'],
  }),
  'src/index.ts': [
    "import { onRequest } from 'firebase-functions/v2/https'",
    '',
    'export const heartbeat = onRequest((_request, response) => {',
    "  response.json({ ok: true, codebase: 'jobs' })",
    '})',
    '',
  ].join('\n'),
  'lib/index.js': [
    "'use strict'",
    "Object.defineProperty(exports, '__esModule', { value: true })",
    'exports.heartbeat = void 0',
    "const https_1 = require('firebase-functions/v2/https')",
    'exports.heartbeat = (0, https_1.onRequest)((_request, response) => {',
    "  response.json({ ok: true, codebase: 'jobs' })",
    '})',
    '',
  ].join('\n'),
}

/** What `broken` holds: a handler whose closing brace is missing. */
const BROKEN = {
  'package.json': json({
    name: 'firenook-console-fixture-broken',
    private: true,
    main: 'index.js',
    dependencies: DEPENDENCIES,
    engines: { node: '24' },
  }),
  'index.js': [
    "const { onRequest } = require('firebase-functions/v2/https')",
    '',
    'exports.unreachable = onRequest((_request, response) => {',
    '  response.json({ ok: true })',
    '',
  ].join('\n'),
}

/** Writes a codebase's files under the project and links the SDK into it. */
function writeCodebase(directory, name, files, sdk) {
  const root = join(directory, name)
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), text)
  }
  mkdirSync(join(root, 'node_modules'), { recursive: true })
  for (const dependency of Object.keys(DEPENDENCIES))
    symlinkSync(join(sdk, dependency), join(root, 'node_modules', dependency), 'dir')
}

/** @type {import('../synthetic-engine.mjs').Fixture} */
export default {
  name: 'compute',
  prepare(directory, firebaseJson) {
    const sdk = resolveFunctionsSdk()
    // The shared codebase's secret (`usesSecret` declares API_KEY and
    // MISSING_KEY; only the first is provided).
    writeFileSync(join(directory, 'functions', '.secret.local'), 'API_KEY=s3cret\n')
    writeCodebase(directory, 'jobs', JOBS, sdk)
    writeCodebase(directory, 'broken', BROKEN, sdk)
    const codebases = Array.isArray(firebaseJson.functions) ? firebaseJson.functions : []
    firebaseJson.functions = [
      ...codebases,
      { source: 'jobs', codebase: 'jobs' },
      { source: 'broken', codebase: 'broken' },
    ]
  },
}
