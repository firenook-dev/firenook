// Local extensions for the synthetic project: every directory under
// `scripts/fixtures/extensions/` (an `extension.yaml` and its functions) is
// copied to `<project>/extensions/<id>` and installed as an instance of the
// same id, its parameters from `<id>.env` and its secrets from
// `<id>.secret.local` beside it when there are such files. An extension
// whose functions have a `package.json` gets the pinned SDK linked in from
// the offline install, as the shared codebase does, so nothing is fetched at
// test time. The compute stream owns the extensions themselves.

import { cpSync, existsSync, mkdirSync, readdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveFunctionsSdk } from '../functions-sdk.mjs'

const SOURCE = fileURLToPath(new URL('./extensions/', import.meta.url))

/** @type {import('../synthetic-engine.mjs').Fixture} */
export default {
  name: 'extensions',
  prepare(directory, firebaseJson) {
    if (!existsSync(SOURCE)) return
    const instances = {}
    for (const entry of readdirSync(SOURCE, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const target = join(directory, 'extensions', entry.name)
      cpSync(join(SOURCE, entry.name), target, { recursive: true })
      for (const suffix of ['.env', '.secret.local']) {
        const file = join(SOURCE, `${entry.name}${suffix}`)
        if (!existsSync(file)) continue
        mkdirSync(join(directory, 'extensions'), { recursive: true })
        cpSync(file, join(directory, 'extensions', `${entry.name}${suffix}`))
      }
      const functions = join(target, 'functions')
      if (existsSync(join(functions, 'package.json'))) {
        const sdk = resolveFunctionsSdk()
        mkdirSync(join(functions, 'node_modules'), { recursive: true })
        for (const name of ['firebase-functions', 'firebase-admin'])
          symlinkSync(join(sdk, name), join(functions, 'node_modules', name), 'dir')
      }
      instances[entry.name] = `./extensions/${entry.name}`
    }
    if (Object.keys(instances).length > 0) firebaseJson.extensions = instances
  },
}
