// The one Functions codebase every profile shares: `scripts/fixtures/functions/`
// copied to `<project>/functions`, its `.env` written from the profile's
// `fixtureEnv` (which streams' files it loads, `FIXTURE_STREAMS`; a slow
// load for the starting journey, `SLOW_LOAD_MS`), and the pinned SDK linked
// in from the offline install, so nothing is fetched at test time.

import { cpSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveFunctionsSdk } from '../functions-sdk.mjs'

const SOURCE = fileURLToPath(new URL('./functions/', import.meta.url))

/** A value as a `.env` line holds it: quoted when it has to be. */
function envValue(value) {
  return /^[\w.,:/@-]*$/.test(value) ? value : JSON.stringify(value)
}

/** @type {import('../synthetic-engine.mjs').Fixture} */
export default {
  name: 'functions',
  prepare(directory, firebaseJson, { fixtureEnv }) {
    const sdk = resolveFunctionsSdk()
    const codebase = join(directory, 'functions')
    cpSync(SOURCE, codebase, { recursive: true })
    const lines = Object.entries(fixtureEnv).map(([name, value]) => `${name}=${envValue(value)}`)
    writeFileSync(join(codebase, '.env'), lines.length > 0 ? `${lines.join('\n')}\n` : '')
    mkdirSync(join(codebase, 'node_modules'), { recursive: true })
    for (const name of ['firebase-functions', 'firebase-admin'])
      symlinkSync(join(sdk, name), join(codebase, 'node_modules', name), 'dir')
    firebaseJson.functions = [{ source: 'functions', codebase: 'default' }]
  },
}
